//! Omaha: exactly two hole cards and exactly three board cards
//! (`frontend/src/lib/equity/omaha.ts`). The best hand is the maximum over
//! every 2-of-hole × 3-of-board combination, each a plain five-card
//! [`evaluate_masks`]; both halves are prepared as suit masks once.
//!
//! [`evaluate_omaha_low`] is the eight-or-better low that
//! [`crate::phf::hilo`] reads the halves of a split pot with.

use super::{RankingTable, card_index, evaluate_masks, index_or_throw};
use crate::js::JsError;

/// `subsetMasks(cards, k)`: the suit masks of every `k`-card subset, in the
/// TypeScript's order (lexicographic by position).
fn subset_masks(cards: &[u8], k: usize) -> Vec<[u32; 4]> {
    let mut out = Vec::new();
    let push = |picked: &[u8], out: &mut Vec<[u32; 4]>| {
        let mut masks = [0_u32; 4];
        for card in picked {
            masks[usize::from(card & 3)] |= 1 << (card >> 2);
        }
        out.push(masks);
    };
    let n = cards.len();
    for a in 0..n {
        for b in a + 1..n {
            if k == 2 {
                push(&[cards[a], cards[b]], &mut out);
                continue;
            }
            for c in b + 1..n {
                push(&[cards[a], cards[b], cards[c]], &mut out);
            }
        }
    }
    out
}

/// `holePairMasks`: every two-card subset of the hole cards, as suit masks.
pub fn hole_pair_masks(hole: &[u8]) -> Vec<[u32; 4]> {
    subset_masks(hole, 2)
}

/// `boardTripleMasks`: every three-card subset of the board, as suit masks.
pub fn board_triple_masks(board: &[u8]) -> Vec<[u32; 4]> {
    subset_masks(board, 3)
}

/// `evaluateOmahaMasks`: the best value over every hole pair × board triple;
/// `None` (TypeScript: `-1`) when either list is empty.
#[inline]
pub fn evaluate_omaha_masks(
    table: &RankingTable,
    pairs: &[[u32; 4]],
    triples: &[[u32; 4]],
) -> Option<u32> {
    let mut best: Option<u32> = None;
    for [s, h, d, c] in pairs {
        for [ts, th, td, tc] in triples {
            let value = evaluate_masks(table, s | ts, h | th, d | td, c | tc);
            if best.is_none_or(|best| value > best) {
                best = Some(value);
            }
        }
    }
    best
}

/// `evaluateOmaha(hole, board, table)`: the value of the best Omaha hand,
/// `hole` 4-6 cards, `board` 3-5. Errors - with the TypeScript's messages,
/// in its order - on fewer than two hole or three board cards, then on the
/// first invalid hole card, then on the first invalid board card.
pub fn evaluate_omaha<S: AsRef<str>, B: AsRef<str>>(
    hole: &[S],
    board: &[B],
    table: &RankingTable,
) -> Result<u32, JsError> {
    if hole.len() < 2 || board.len() < 3 {
        return Err(JsError::new(
            "Omaha needs at least two hole cards and three board cards",
        ));
    }
    let hole = indices(hole)?;
    let board = indices(board)?;
    // Both lists are non-empty here, so there is a best value.
    Ok(
        evaluate_omaha_masks(table, &hole_pair_masks(&hole), &board_triple_masks(&board))
            .unwrap_or(0),
    )
}

fn indices<S: AsRef<str>>(cards: &[S]) -> Result<Vec<u8>, JsError> {
    cards
        .iter()
        .map(|card| index_or_throw(card.as_ref()))
        .collect()
}

/// `evaluateOmahaLow(hole, board)`: the best eight-or-better low, or `None`
/// when the hand has none. Two from the hand, three from the board,
/// ace-to-five: aces low, straights and flushes do not count, five distinct
/// ranks all eight or under. **Lower is better**: the value is the five ranks,
/// highest first, as base-9 digits. Errors on the first invalid hole card,
/// then the first invalid board card.
pub fn evaluate_omaha_low<S: AsRef<str>, B: AsRef<str>>(
    hole: &[S],
    board: &[B],
) -> Result<Option<u32>, JsError> {
    // Ace 1, deuce 2 ... eight 8; anything higher cannot play in the low.
    let low_rank = |card: &str| -> Result<Option<u32>, JsError> {
        let index = card_index(card).ok_or_else(|| JsError::new(format!("not a card: {card}")))?;
        let rank = u32::from(index >> 2); // 0 = deuce ... 12 = ace
        Ok(match rank {
            12 => Some(1),
            0..=6 => Some(rank + 2),
            _ => None,
        })
    };
    let hole_low = hole
        .iter()
        .map(|card| low_rank(card.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    let board_low = board
        .iter()
        .map(|card| low_rank(card.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut best: Option<u32> = None;
    for a in 0..hole_low.len() {
        for b in a + 1..hole_low.len() {
            for c in 0..board_low.len() {
                for d in c + 1..board_low.len() {
                    for e in d + 1..board_low.len() {
                        let picked = [
                            hole_low[a],
                            hole_low[b],
                            board_low[c],
                            board_low[d],
                            board_low[e],
                        ];
                        let Some(mut ranks) = picked.into_iter().collect::<Option<Vec<u32>>>()
                        else {
                            continue;
                        };
                        ranks.sort_unstable_by(|x, y| y.cmp(x));
                        if ranks.windows(2).any(|pair| pair[0] == pair[1]) {
                            continue;
                        }
                        let value = ranks.iter().fold(0, |sum, rank| sum * 9 + rank);
                        if best.is_none_or(|best| value < best) {
                            best = Some(value);
                        }
                    }
                }
            }
        }
    }
    Ok(best)
}

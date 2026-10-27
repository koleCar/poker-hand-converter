//! One exact hand against two or more weighted ranges at once:
//! `web/src/lib/equity/multiway.ts`.
//!
//! The hero's share is what a showdown against the whole field pays: all of
//! the pot when strictly best, `1 / (1 + k)` of it when tied with `k`
//! opponents, nothing when beaten. A deal is one combo per range plus the
//! rest of the board with no card twice; a tuple is weighted by the product
//! of its weights. Doubles replayed in [`JsNumber`] as in [`crate::range`].

use std::collections::BTreeSet;

use rail_core::eval::{STANDARD, evaluate_masks};
use rail_core::js::JsNumber;

use crate::enumerate::{
    Computation, DEFAULT_SEED, EquityInputError, EquityMethod, EquityOptions, Mulberry32,
};
use crate::range::{
    Range, WeightedCombo, choose_any, js_int, js_usize, live_combos, masks_of, pick_weighted,
    take_card, walk_runouts,
};

/// `MultiwayEquityRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultiwayEquityRequest {
    /// The hero's two hole cards.
    pub hero: Vec<String>,
    /// One range per opponent; at least one.
    pub ranges: Vec<Range>,
    pub board: Vec<String>,
    pub dead: Vec<String>,
    /// `None` fields take this module's defaults
    /// ([`DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT`], [`DEFAULT_MULTIWAY_TRIALS`],
    /// `DEFAULT_SEED`).
    pub options: EquityOptions,
}

/// `MultiwayEquityResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultiwayEquityResult {
    pub equity: JsNumber,
    pub win: JsNumber,
    pub tie: JsNumber,
    /// Combos left in each range after the hero's cards, the board and the
    /// dead cards are removed.
    pub combos: Vec<usize>,
    pub method: Computation,
    /// Deals enumerated or sampled.
    pub samples: u64,
}

pub const DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT: u64 = 500_000;
pub const DEFAULT_MULTIWAY_TRIALS: u64 = 8_000;
/// A sampler gives up on a deal after this many collisions in a row.
const MAX_REJECTIONS: u32 = 2_000;

/// `equityVsRanges(request)`: the hero's equity against every range at
/// once, over every runout.
///
/// An impossible request (no range, a duplicated card, a board of two) is an
/// error. A range card removal empties is left out of the showdown (an empty
/// field is an equity of 1), its `combos` entry 0.
pub fn equity_vs_ranges(
    request: &MultiwayEquityRequest,
) -> Result<MultiwayEquityResult, EquityInputError> {
    if request.hero.len() != 2 {
        return Err(EquityInputError(format!(
            "the hero needs two hole cards, got {}",
            request.hero.len()
        )));
    }
    if request.ranges.is_empty() {
        return Err(EquityInputError(
            "a multiway equity needs at least one range".to_owned(),
        ));
    }
    let mut seen = BTreeSet::new();
    let mut hero = Vec::with_capacity(2);
    for code in &request.hero {
        hero.push(take_card(code, &mut seen)?);
    }
    let mut board = Vec::with_capacity(request.board.len());
    for code in &request.board {
        board.push(take_card(code, &mut seen)?);
    }
    if board.len() > 5 || board.len() == 1 || board.len() == 2 {
        return Err(EquityInputError(format!(
            "a board of {} cards is not a street",
            board.len()
        )));
    }
    for code in &request.dead {
        take_card(code, &mut seen)?;
    }

    let mut all: Vec<Vec<WeightedCombo>> = Vec::with_capacity(request.ranges.len());
    for range in &request.ranges {
        all.push(live_combos(range, &seen)?);
    }
    let counts: Vec<usize> = all.iter().map(Vec::len).collect();
    let ranges: Vec<Vec<WeightedCombo>> = all.into_iter().filter(|c| !c.is_empty()).collect();
    let one = JsNumber::from_i64(1);
    let options = &request.options;
    if ranges.is_empty() {
        return Ok(MultiwayEquityResult {
            equity: one,
            win: one,
            tie: JsNumber::ZERO,
            combos: counts,
            method: Computation::Exhaustive,
            samples: 0,
        });
    }

    let missing = 5 - board.len();
    let missing_i = i64::try_from(missing).unwrap_or(0);
    let k = ranges.len();
    let deck_left = 52 - i64::try_from(seen.len()).unwrap_or(0) - 2 * i64::try_from(k).unwrap_or(0);
    let runouts = choose_any(deck_left.max(0), missing_i);
    let exhaustive = match options.method {
        EquityMethod::Exhaustive => true,
        EquityMethod::MonteCarlo => false,
        EquityMethod::Auto => {
            // `tuples *= combos.length` in doubles, then `tuples * runouts`.
            let tuples = ranges
                .iter()
                .fold(one, |tuples, combos| tuples * js_usize(combos.len()));
            let work = tuples * js_int(runouts);
            let limit = JsNumber::from_u64(
                options
                    .exhaustive_limit
                    .unwrap_or(DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT),
            );
            !work.greater_than(limit) && !work.is_nan()
        }
    };

    let hero_masks = masks_of(&hero);
    let board_masks = masks_of(&board);
    let mut picked: Vec<WeightedCombo> = vec![
        WeightedCombo {
            cards: [0, 0],
            weight: JsNumber::ZERO,
        };
        k
    ];

    let mut win = JsNumber::ZERO;
    let mut tie = JsNumber::ZERO;
    let mut share = JsNumber::ZERO;
    let mut total = JsNumber::ZERO;
    let mut samples = 0_u64;

    let mut score = |m: [u32; 4], picked: &[WeightedCombo], w: JsNumber| {
        let ours = evaluate_masks(
            &STANDARD,
            m[0] | hero_masks[0],
            m[1] | hero_masks[1],
            m[2] | hero_masks[2],
            m[3] | hero_masks[3],
        );
        let mut tied = 0_u64;
        let mut beaten = false;
        for combo in picked {
            let mut scratch = m;
            for card in combo.cards {
                scratch[usize::from(card & 3)] |= 1 << (card >> 2);
            }
            let theirs = evaluate_masks(&STANDARD, scratch[0], scratch[1], scratch[2], scratch[3]);
            if theirs > ours {
                beaten = true;
                break;
            }
            if theirs == ours {
                tied += 1;
            }
        }
        if !beaten {
            if tied == 0 {
                win = win + w;
            } else {
                tie = tie + w;
            }
            share = share + w / JsNumber::from_u64(1 + tied);
        }
        total = total + w;
        samples += 1;
    };

    let mut used = [false; 52];
    for &index in &seen {
        used[usize::from(index)] = true;
    }

    if exhaustive {
        #[allow(clippy::too_many_arguments)]
        fn recurse(
            depth: usize,
            weight: JsNumber,
            ranges: &[Vec<WeightedCombo>],
            used: &mut [bool; 52],
            picked: &mut [WeightedCombo],
            missing: usize,
            board_masks: [u32; 4],
            score: &mut impl FnMut([u32; 4], &[WeightedCombo], JsNumber),
        ) {
            if depth == ranges.len() {
                let stub: Vec<u8> = (0..52_u8).filter(|&i| !used[usize::from(i)]).collect();
                let runouts = choose_any(
                    i64::try_from(stub.len()).unwrap_or(0),
                    i64::try_from(missing).unwrap_or(0),
                );
                let per = weight / JsNumber::from_i64(1).max_of(js_int(runouts));
                let picked: &[WeightedCombo] = picked;
                walk_runouts(&stub, missing, board_masks, &mut |m| score(m, picked, per));
                return;
            }
            for combo in &ranges[depth] {
                let [a, b] = combo.cards;
                if used[usize::from(a)] || used[usize::from(b)] {
                    continue;
                }
                used[usize::from(a)] = true;
                used[usize::from(b)] = true;
                picked[depth] = *combo;
                recurse(
                    depth + 1,
                    weight * combo.weight,
                    ranges,
                    used,
                    picked,
                    missing,
                    board_masks,
                    score,
                );
                used[usize::from(a)] = false;
                used[usize::from(b)] = false;
            }
        }
        recurse(
            0,
            one,
            &ranges,
            &mut used,
            &mut picked,
            missing,
            board_masks,
            &mut score,
        );
    } else {
        let mut random = Mulberry32::new(options.seed.unwrap_or(DEFAULT_SEED));
        let cumulative: Vec<Vec<JsNumber>> = ranges
            .iter()
            .map(|combos| {
                let mut sum = JsNumber::ZERO;
                combos
                    .iter()
                    .map(|combo| {
                        sum = sum + combo.weight;
                        sum
                    })
                    .collect()
            })
            .collect();
        let trials = options.trials.unwrap_or(DEFAULT_MULTIWAY_TRIALS).max(1);
        let mut drawn: Vec<usize> = Vec::with_capacity(5);
        for _ in 0..trials {
            // Draw a whole compatible tuple, rejecting it whole on a
            // collision.
            let mut ok = false;
            let mut attempt = 0;
            while attempt < MAX_REJECTIONS && !ok {
                ok = true;
                let mut i = 0;
                while i < k {
                    let sums = &cumulative[i];
                    let last = sums[sums.len() - 1];
                    let combo = ranges[i][pick_weighted(sums, random.random() * last)];
                    let [a, b] = combo.cards;
                    if used[usize::from(a)] || used[usize::from(b)] {
                        ok = false;
                        break;
                    }
                    used[usize::from(a)] = true;
                    used[usize::from(b)] = true;
                    picked[i] = combo;
                    i += 1;
                }
                if !ok {
                    for combo in &picked[..i] {
                        used[usize::from(combo.cards[0])] = false;
                        used[usize::from(combo.cards[1])] = false;
                    }
                }
                attempt += 1;
            }
            if !ok {
                continue;
            }
            let mut masks = board_masks;
            drawn.clear();
            while drawn.len() < missing {
                let index = random.below(52);
                if used[index] {
                    continue;
                }
                used[index] = true;
                drawn.push(index);
                masks[index & 3] |= 1 << (index >> 2);
            }
            score(masks, &picked, one);
            for &index in &drawn {
                used[index] = false;
            }
            for combo in &picked {
                used[usize::from(combo.cards[0])] = false;
                used[usize::from(combo.cards[1])] = false;
            }
        }
    }

    let method = if exhaustive {
        Computation::Exhaustive
    } else {
        Computation::MonteCarlo
    };
    if !total.greater_than(JsNumber::ZERO) {
        // No compatible deal at all.
        return Ok(MultiwayEquityResult {
            equity: one,
            win: one,
            tie: JsNumber::ZERO,
            combos: counts,
            method,
            samples,
        });
    }
    Ok(MultiwayEquityResult {
        equity: share / total,
        win: win / total,
        tie: tie / total,
        combos: counts,
        method,
        samples,
    })
}

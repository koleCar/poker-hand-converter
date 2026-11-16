//! Suit isomorphism (`isomorphism.ts`): the suit permutations a spot is
//! symmetric under, ranges made exactly symmetric, card orbits.

use crate::cards::{NUM_COMBOS, combo_cards, combo_index};

pub type Perm = [u8; 4];

/// All 24 permutations of the suits, in the TypeScript's (lexicographic) order.
#[must_use]
pub fn suit_permutations() -> Vec<Perm> {
    let mut out = Vec::with_capacity(24);
    for a in 0..4_u8 {
        for b in 0..4_u8 {
            for c in 0..4_u8 {
                for d in 0..4_u8 {
                    if a != b && a != c && a != d && b != c && b != d && c != d {
                        out.push([a, b, c, d]);
                    }
                }
            }
        }
    }
    out
}

#[must_use]
pub fn permute_card(card: u8, perm: &Perm) -> u8 {
    (card & !3) | perm[usize::from(card & 3)]
}

#[must_use]
pub fn permute_combo(combo: usize, perm: &Perm) -> usize {
    let (hi, lo) = combo_cards(combo);
    combo_index(permute_card(hi, perm), permute_card(lo, perm))
}

/// `boardSymmetries`: permutations that leave the board unchanged as a set.
#[must_use]
pub fn board_symmetries(board: &[u8]) -> Vec<Perm> {
    suit_permutations()
        .into_iter()
        .filter(|perm| {
            board
                .iter()
                .all(|&card| board.contains(&permute_card(card, perm)))
        })
        .collect()
}

pub const SYMMETRY_TOLERANCE: f64 = 1e-9;

fn compose(a: &Perm, b: &Perm) -> Perm {
    [
        a[usize::from(b[0])],
        a[usize::from(b[1])],
        a[usize::from(b[2])],
        a[usize::from(b[3])],
    ]
}

/// `spotSymmetries`: the board's symmetries every range is invariant under.
#[must_use]
pub fn spot_symmetries(board: &[u8], ranges: &[&[f64]]) -> Vec<Perm> {
    let identity: Perm = [0, 1, 2, 3];
    let kept: Vec<Perm> = board_symmetries(board)
        .into_iter()
        .filter(|perm| {
            ranges.iter().all(|range| {
                (0..NUM_COMBOS).all(|c| {
                    let a = range[c];
                    let b = range[permute_combo(c, perm)];
                    !((a - b).abs() > SYMMETRY_TOLERANCE * 1f64.max(a.abs()).max(b.abs()))
                })
            })
        })
        .collect();
    for a in &kept {
        for b in &kept {
            if !kept.contains(&compose(a, b)) {
                return vec![identity];
            }
        }
    }
    if kept.is_empty() {
        vec![identity]
    } else {
        kept
    }
}

/// `symmetrize`: each combo's weight becomes the mean over its orbit.
#[must_use]
pub fn symmetrize(range: &[f64], group: &[Perm]) -> Vec<f64> {
    let mut out = range.to_vec();
    if group.len() <= 1 {
        return out;
    }
    let mut done = vec![false; NUM_COMBOS];
    for c in 0..NUM_COMBOS {
        if done[c] {
            continue;
        }
        let mut orbit: Vec<usize> = Vec::with_capacity(group.len());
        for perm in group {
            let m = permute_combo(c, perm);
            if !orbit.contains(&m) {
                orbit.push(m);
            }
        }
        let mut sum = 0.0;
        for &member in &orbit {
            sum += range[member];
        }
        let mean = sum / orbit.len() as f64;
        for &member in &orbit {
            out[member] = mean;
            done[member] = true;
        }
    }
    out
}

/// `cardOrbit`: every card some permutation takes `card` to, ascending.
#[must_use]
pub fn card_orbit(card: u8, group: &[Perm]) -> Vec<u8> {
    let mut out: Vec<u8> = group.iter().map(|perm| permute_card(card, perm)).collect();
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permutations_are_lexicographic() {
        let perms = suit_permutations();
        assert_eq!(perms.len(), 24);
        assert_eq!(perms[0], [0, 1, 2, 3]);
        assert_eq!(perms[1], [0, 1, 3, 2]);
        assert_eq!(perms[23], [3, 2, 1, 0]);
    }
}

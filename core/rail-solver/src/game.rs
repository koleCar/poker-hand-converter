//! A game for the engine (`game.ts`): the public tree plus each player's
//! private hands as card pairs, showdowns as a strength ordering per board,
//! and the suit-isomorphism mirrors of dealt cards.

use crate::tree::FlatTree;

#[derive(Debug, Clone, Default)]
pub struct HandSet {
    pub size: usize,
    pub c1: Vec<u8>,
    /// Second card, or the player's phantom card (`num_cards + player`) in a one-card game.
    pub c2: Vec<u8>,
    pub weight: Vec<f64>,
}

impl HandSet {
    /// `handSet`: `[card1, card2]` pairs, `card2 < 0` for a one-card game.
    ///
    /// # Panics
    /// On a pair that is not two distinct cards of the game.
    #[must_use]
    pub fn new(player: u8, num_cards: usize, cards: &[(i32, i32)], weights: &[f64]) -> Self {
        let size = cards.len();
        let mut c1 = Vec::with_capacity(size);
        let mut c2 = Vec::with_capacity(size);
        for &(a, b) in cards {
            assert!(
                a >= 0 && (a as usize) < num_cards && (b as i64) < num_cards as i64 && a != b,
                "bad hand {a},{b} for a {num_cards}-card game"
            );
            c1.push(a as u8);
            c2.push(if b < 0 {
                (num_cards + usize::from(player)) as u8
            } else {
                b as u8
            });
        }
        Self {
            size,
            c1,
            c2,
            weight: weights[..size].to_vec(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ShowdownBoard {
    /// Per player: indices of the hands possible on this board, weakest first.
    pub order: [Vec<u32>; 2],
    /// Per player: strength of `order[k]`, non-decreasing.
    pub strength: [Vec<f64>; 2],
}

impl ShowdownBoard {
    /// `showdownBoard`: NaN marks a hand impossible on the board.
    #[must_use]
    pub fn new(strength0: &[f64], strength1: &[f64]) -> Self {
        let side = |strength: &[f64]| {
            let mut ids: Vec<u32> = (0..strength.len() as u32)
                .filter(|&i| !strength[i as usize].is_nan())
                .collect();
            // Stable on equal strength: by index.
            ids.sort_by(|&a, &b| {
                strength[a as usize]
                    .partial_cmp(&strength[b as usize])
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.cmp(&b))
            });
            let sorted: Vec<f64> = ids.iter().map(|&i| strength[i as usize]).collect();
            (ids, sorted)
        };
        let (o0, s0) = side(strength0);
        let (o1, s1) = side(strength1);
        Self {
            order: [o0, o1],
            strength: [s0, s1],
        }
    }
}

/// A dealt card that stands for another (`Mirror`): `card` is the card left
/// out, `map` indexes `Game::maps`, whose `[p][i]` is the index of hand `i`
/// relabelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mirror {
    pub card: u8,
    pub map: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Game {
    pub tree: FlatTree,
    /// Per chance edge: index into `mirror_lists`, or `u32::MAX`. (The
    /// TypeScript's per-card `mirrors` are turned into per-edge ones.)
    pub edge_mirrors: Vec<u32>,
    pub mirror_lists: Vec<Vec<Mirror>>,
    /// Hand relabellings: `maps[k][p][i]`.
    pub maps: Vec<[Vec<u32>; 2]>,
    pub num_cards: usize,
    pub hands: [HandSet; 2],
    pub boards: Vec<ShowdownBoard>,
    pub pot: f64,
    pub big_blind: Option<f64>,
}

impl Game {
    /// The mirrors of a chance edge, if any.
    #[must_use]
    pub fn mirrors_of(&self, edge: usize) -> Option<&[Mirror]> {
        match self.edge_mirrors.get(edge) {
            Some(&k) if k != u32::MAX => Some(&self.mirror_lists[k as usize]),
            _ => None,
        }
    }

    /// Turns per-card mirrors (`Game.mirrors`) into per-edge ones.
    pub fn set_card_mirrors(&mut self, per_card: &[Option<Vec<Mirror>>]) {
        let tree = &self.tree;
        let mut edge_mirrors = vec![u32::MAX; tree.children.len()];
        let mut list_of = vec![u32::MAX; per_card.len()];
        for (card, mirrors) in per_card.iter().enumerate() {
            if let Some(m) = mirrors {
                list_of[card] = self.mirror_lists.len() as u32;
                self.mirror_lists.push(m.clone());
            }
        }
        for (e, &card) in tree.edge_card.iter().enumerate() {
            if card >= 0 && (card as usize) < list_of.len() {
                edge_mirrors[e] = list_of[card as usize];
            }
        }
        self.edge_mirrors = edge_mirrors;
    }
}

//! Equity by runout: `frontend/src/lib/equity/enumerate.ts`.
//!
//! Every possible board (exhaustive) or a fixed-seed sample of them (Monte
//! Carlo), for any number of players and any number of pots; see the
//! TypeScript for the design (pots first-class, one evaluation per player per
//! board shared by every pot).
//!
//! **Exact representation.** A board's pot is split between its tied winners,
//! each getting `UNIT / k` with `UNIT = 27720` (the least common multiple of
//! 1..=12, which every `k` divides). The TypeScript accumulates those integer
//! multiples in doubles, where they are exact (the largest sum, 1.7M boards x
//! 27720, is far inside 2^53); here they are `u64`. So a player's share of a
//! pot is the exact rational `units / (boards * UNIT)`
//! ([`EquityResult::units`], [`EquityResult::denominator`]), the same on every
//! machine. The one place the TypeScript leaves the integers is the final
//! `acc / (boards * UNIT)`, a correctly rounded double division; that is
//! [`JsNumber`] division here, so [`EquityResult::pots`] holds the very
//! doubles the TypeScript returns, bit for bit.
//!
//! **Seeded sampling.** [`Mulberry32`] is the TypeScript's PRNG in 32-bit
//! integer arithmetic. `Math.floor(random() * n)` is `(u * n) >> 32` exactly
//! (`u / 2^32` is exact and `u * n < 2^53`), so the Fisher-Yates draws, and
//! with them every sampled board, are the TypeScript's.

use std::collections::BTreeSet;

use rail_core::eval::omaha::{evaluate_omaha_masks, hole_pair_masks};
use rail_core::eval::{RankingTable, STANDARD, ShortDeckRule, card_index, short_deck_table};
use rail_core::js::JsNumber;
use rail_core::js::sort::sort_by;

/// The games this module can evaluate (`EquityGame`). Hi/lo, stud and draw
/// are not among them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EquityGame {
    Holdem,
    Shortdeck,
    Omaha,
    Omaha5,
    Omaha6,
}

impl EquityGame {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Holdem => "holdem",
            Self::Shortdeck => "shortdeck",
            Self::Omaha => "omaha",
            Self::Omaha5 => "omaha5",
            Self::Omaha6 => "omaha6",
        }
    }
}

/// `request.method`: how to compute (`"auto"` by default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum EquityMethod {
    /// Exhaustive when boards x evaluations per board fit the limit.
    #[default]
    Auto,
    Exhaustive,
    MonteCarlo,
}

/// `result.method`: how a result was computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Computation {
    Exhaustive,
    MonteCarlo,
}

impl Computation {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exhaustive => "exhaustive",
            Self::MonteCarlo => "monte-carlo",
        }
    }
}

/// The tuning half of `EquityRequest` (`AllInEvOptions` in `allInEv.ts`):
/// `None` is the TypeScript's `undefined`, i.e. the default. The defaults are
/// what stored EV rows use.
///
/// The TypeScript takes any `number` here; the port takes the integers a
/// caller can meaningfully pass. `trials` is `Math.max(1,
/// Math.floor(trials))` there, so a positive integer here; `seed` is read as
/// `seed >>> 0` there, so a `u32` here; an `exhaustive_limit` is compared
/// with an integer count, so a fraction or a negative number decides nothing
/// a `u64` cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct EquityOptions {
    pub method: EquityMethod,
    /// Boards x evaluations per board that [`EquityMethod::Auto`] still
    /// enumerates ([`DEFAULT_EXHAUSTIVE_LIMIT`]).
    pub exhaustive_limit: Option<u64>,
    /// Monte Carlo boards ([`DEFAULT_TRIALS`]).
    pub trials: Option<u64>,
    /// Monte Carlo seed ([`DEFAULT_SEED`]).
    pub seed: Option<u32>,
}

/// `EquityRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquityRequest {
    pub game: EquityGame,
    /// Short deck only (`trips-over-straight` when `None`).
    pub short_deck_rule: Option<ShortDeckRule>,
    /// Hole cards per player, as codes like `"Ah"`.
    pub hands: Vec<Vec<String>>,
    /// Board cards already dealt: 0, 3, 4 or 5 of them.
    pub board: Vec<String>,
    /// Cards known to be out of the deck that no player holds.
    pub dead: Vec<String>,
    /// The pots, each as indices into `hands` of the players eligible for it;
    /// `None` is one pot everybody is in.
    pub pots: Option<Vec<Vec<i64>>>,
    pub options: EquityOptions,
}

impl EquityRequest {
    /// A request with one pot, no board, no dead cards and default options.
    pub fn new(game: EquityGame, hands: Vec<Vec<String>>) -> Self {
        Self {
            game,
            short_deck_rule: None,
            hands,
            board: Vec::new(),
            dead: Vec::new(),
            pots: None,
            options: EquityOptions::default(),
        }
    }
}

/// `EquityResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquityResult {
    /// `pots[p][i]`: player `i`'s share of pot `p`, the double the TypeScript
    /// returns (`units[p][i] / denominator()`, correctly rounded).
    pub pots: Vec<Vec<JsNumber>>,
    /// `units[p][i]`: player `i`'s share of pot `p`, exactly, in units of
    /// `1 / UNIT` of one board's pot.
    pub units: Vec<Vec<u64>>,
    pub method: Computation,
    /// Boards enumerated or sampled.
    pub boards: u64,
}

impl EquityResult {
    /// `result.equity`: `pots[0]`.
    pub fn equity(&self) -> &[JsNumber] {
        &self.pots[0]
    }

    /// The common denominator of [`units`](Self::units): `boards * UNIT`.
    pub fn denominator(&self) -> u128 {
        u128::from(self.boards) * u128::from(UNIT)
    }
}

/// `plan(request)`: how a request would be computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub method: Computation,
    pub boards: u64,
    pub evaluations: u64,
}

/// `EquityInputError`: a request that is not a dealable situation, with the
/// TypeScript's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquityInputError(pub String);

impl EquityInputError {
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for EquityInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EquityInputError {}

fn input_error(message: String) -> EquityInputError {
    EquityInputError(message)
}

pub const DEFAULT_EXHAUSTIVE_LIMIT: u64 = 5_000_000;
pub const DEFAULT_TRIALS: u64 = 20_000;
pub const DEFAULT_SEED: u32 = 0x5eed;

/// The least common multiple of 1..=12: one board's pot, so that a split
/// between any number of tied players is an integer share.
pub const UNIT: u64 = 27_720;
const MAX_PLAYERS: usize = 12;

/// `SHARE[k] = UNIT / k`, exact for every `k` in 1..=12.
const fn share(winners: usize) -> u64 {
    match winners {
        1 => UNIT,
        2 => UNIT / 2,
        3 => UNIT / 3,
        4 => UNIT / 4,
        5 => UNIT / 5,
        6 => UNIT / 6,
        7 => UNIT / 7,
        8 => UNIT / 8,
        9 => UNIT / 9,
        10 => UNIT / 10,
        11 => UNIT / 11,
        12 => UNIT / 12,
        // `SHARE[0]` / `SHARE[13]`: never read, a pot always has a winner
        // and at most twelve players.
        _ => 0,
    }
}

/// `holeCardsFor(game)`.
pub const fn hole_cards_for(game: EquityGame) -> usize {
    match game {
        EquityGame::Holdem | EquityGame::Shortdeck => 2,
        EquityGame::Omaha => 4,
        EquityGame::Omaha5 => 5,
        EquityGame::Omaha6 => 6,
    }
}

/// `tableFor(game, shortDeckRule)`.
pub fn table_for(game: EquityGame, rule: Option<ShortDeckRule>) -> &'static RankingTable {
    if game == EquityGame::Shortdeck {
        short_deck_table(rule.unwrap_or(ShortDeckRule::TripsOverStraight))
    } else {
        &STANDARD
    }
}

/// `choose(n, k)` of `enumerate.ts` (0 outside `0 <= k <= n`). Every
/// intermediate of the TypeScript's `out * (n - i) / (i + 1)` is the integer
/// `C(n, i + 1)`, so integer arithmetic gives its exact result.
pub(crate) fn choose(n: u64, k: u64) -> u64 {
    if k > n {
        return 0;
    }
    let mut out: u128 = 1;
    for i in 0..k {
        out = out * u128::from(n - i) / u128::from(i + 1);
    }
    u64::try_from(out).unwrap_or(u64::MAX)
}

/// `mulberry32(seed)`: a deterministic 32-bit PRNG, the TypeScript's
/// step for step. `random()` there is [`next_u32`](Self::next_u32) divided
/// by 2^32.
#[derive(Debug, Clone)]
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    /// `mulberry32(seed)` for `seed >>> 0`.
    pub const fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// The next output as the 32-bit integer the TypeScript divides by 2^32.
    pub fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// `random()`: the next output as the double in [0, 1) (exact).
    pub fn random(&mut self) -> JsNumber {
        JsNumber::from_u64(u64::from(self.next_u32())) / JsNumber::from_u64(1 << 32)
    }

    /// `Math.floor(random() * n)`, exactly, for `n < 2^21` (where `u * n`
    /// is below 2^53 and the double product is exact).
    pub fn below(&mut self, n: usize) -> usize {
        let n = u64::try_from(n).unwrap_or(u64::MAX);
        let product = u128::from(self.next_u32()) * u128::from(n);
        usize::try_from(product >> 32).unwrap_or(usize::MAX)
    }
}

/// The suit masks of one card, `[s, h, d, c]`.
fn card_masks(card: u8) -> [u32; 4] {
    let mut masks = [0_u32; 4];
    masks[usize::from(card & 3)] = 1 << (card >> 2);
    masks
}

struct Prepared {
    table: &'static RankingTable,
    omaha: bool,
    /// Hold'em: four suit masks per player.
    hole_masks: Vec<[u32; 4]>,
    /// Omaha: the hole-pair masks per player.
    pair_masks: Vec<Vec<[u32; 4]>>,
    board_cards: Vec<u8>,
    board_masks: [u32; 4],
    /// Undealt cards that can still come.
    stub: Vec<u8>,
    pots: Vec<Vec<usize>>,
    players: usize,
}

/// `prepare(request)`: validates the request, in the TypeScript's order and
/// with its messages.
fn prepare(request: &EquityRequest) -> Result<Prepared, EquityInputError> {
    let table = table_for(request.game, request.short_deck_rule);
    let hole_count = hole_cards_for(request.game);
    let players = request.hands.len();
    if !(1..=MAX_PLAYERS).contains(&players) {
        return Err(input_error(format!(
            "need 1-{MAX_PLAYERS} players, got {players}"
        )));
    }

    let mut seen: BTreeSet<u8> = BTreeSet::new();
    let deck_size = table.deck_ranks.len() * 4;
    let mut take = |code: &str| -> Result<u8, EquityInputError> {
        let Some(index) = card_index(code) else {
            return Err(input_error(format!("not a card: {code}")));
        };
        if !table.deck_ranks.contains(&(index >> 2)) {
            return Err(input_error(format!(
                "{code} is not in the {deck_size}-card deck"
            )));
        }
        if !seen.insert(index) {
            return Err(input_error(format!("{code} appears twice")));
        }
        Ok(index)
    };

    let mut hands: Vec<Vec<u8>> = Vec::with_capacity(players);
    for (i, hand) in request.hands.iter().enumerate() {
        if hand.len() != hole_count {
            return Err(input_error(format!(
                "player {i} has {} hole cards, {} deals {hole_count}",
                hand.len(),
                request.game.as_str()
            )));
        }
        let mut cards = Vec::with_capacity(hole_count);
        for code in hand {
            cards.push(take(code)?);
        }
        hands.push(cards);
    }
    let mut board_cards = Vec::with_capacity(request.board.len());
    for code in &request.board {
        board_cards.push(take(code)?);
    }
    if board_cards.len() > 5 || board_cards.len() == 1 || board_cards.len() == 2 {
        return Err(input_error(format!(
            "a board of {} cards is not a street",
            board_cards.len()
        )));
    }
    for code in &request.dead {
        take(code)?;
    }

    let all: Vec<Vec<i64>> = vec![
        (0..players)
            .map(|i| i64::try_from(i).unwrap_or(0))
            .collect(),
    ];
    let requested = request.pots.as_ref().unwrap_or(&all);
    let mut pots: Vec<Vec<usize>> = Vec::with_capacity(requested.len());
    for pot in requested {
        // `[...new Set(pot)].sort((a, b) => a - b)`
        let mut eligible: Vec<i64> = Vec::with_capacity(pot.len());
        for &index in pot {
            if !eligible.contains(&index) {
                eligible.push(index);
            }
        }
        sort_by(&mut eligible, |a, b| {
            JsNumber::from_i64(*a) - JsNumber::from_i64(*b)
        });
        let indices: Option<Vec<usize>> = eligible
            .iter()
            .map(|&i| usize::try_from(i).ok().filter(|&i| i < players))
            .collect();
        match indices {
            Some(indices) if !indices.is_empty() => pots.push(indices),
            _ => {
                return Err(input_error(
                    "every pot needs at least one eligible player, by index".to_owned(),
                ));
            }
        }
    }

    let mut stub: Vec<u8> = Vec::new();
    for &rank in table.deck_ranks {
        for suit in 0..4 {
            let card = rank * 4 + suit;
            if !seen.contains(&card) {
                stub.push(card);
            }
        }
    }
    if stub.len() < 5 - board_cards.len() {
        return Err(input_error(
            "not enough cards left to complete the board".to_owned(),
        ));
    }

    let omaha = hole_count > 2;
    let hole_masks: Vec<[u32; 4]> = hands
        .iter()
        .map(|hand| {
            let mut masks = [0_u32; 4];
            for &card in hand {
                masks[usize::from(card & 3)] |= 1 << (card >> 2);
            }
            masks
        })
        .collect();
    let mut board_masks = [0_u32; 4];
    for &card in &board_cards {
        board_masks[usize::from(card & 3)] |= 1 << (card >> 2);
    }

    Ok(Prepared {
        table,
        omaha,
        hole_masks,
        pair_masks: if omaha {
            hands.iter().map(|hand| hole_pair_masks(hand)).collect()
        } else {
            Vec::new()
        },
        board_cards,
        board_masks,
        stub,
        pots,
        players,
    })
}

/// `evaluationsPerBoard(prep)`.
fn evaluations_per_board(prep: &Prepared) -> u64 {
    if !prep.omaha {
        return u64::try_from(prep.players).unwrap_or(u64::MAX);
    }
    prep.pair_masks
        .iter()
        .map(|pairs| u64::try_from(pairs.len()).unwrap_or(u64::MAX) * 10)
        .sum()
}

fn plan_prepared(prep: &Prepared, options: &EquityOptions) -> Plan {
    let boards = choose(
        u64::try_from(prep.stub.len()).unwrap_or(u64::MAX),
        u64::try_from(5 - prep.board_cards.len()).unwrap_or(0),
    );
    let per_board = evaluations_per_board(prep);
    let work = u128::from(boards) * u128::from(per_board);
    let limit = u128::from(options.exhaustive_limit.unwrap_or(DEFAULT_EXHAUSTIVE_LIMIT));
    let exhaustive = match options.method {
        EquityMethod::Exhaustive => true,
        EquityMethod::Auto => work <= limit,
        EquityMethod::MonteCarlo => false,
    };
    if exhaustive {
        return Plan {
            method: Computation::Exhaustive,
            boards,
            evaluations: boards.saturating_mul(per_board),
        };
    }
    let trials = options.trials.unwrap_or(DEFAULT_TRIALS).max(1);
    Plan {
        method: Computation::MonteCarlo,
        boards: trials,
        evaluations: trials.saturating_mul(per_board),
    }
}

/// `plan(request)`: how a request would be computed, without computing it.
pub fn plan(request: &EquityRequest) -> Result<Plan, EquityInputError> {
    let prep = prepare(request)?;
    Ok(plan_prepared(&prep, &request.options))
}

/* ------------------------------------------------------------- scoring - */

/// The per-board scorer (`boardScorer`): the board's suit masks and, for
/// Omaha, the runout cards; accumulates into `acc`, `pots x players`.
struct Scorer<'p> {
    prep: &'p Prepared,
    values: Vec<i64>,
    acc: Vec<u64>,
    /// The five board cards (Omaha), the known ones filled in once.
    cards: [u8; 5],
    triples: [[u32; 4]; 10],
    heads_up: bool,
}

impl<'p> Scorer<'p> {
    fn new(prep: &'p Prepared) -> Self {
        let mut cards = [0_u8; 5];
        for (slot, &card) in cards.iter_mut().zip(&prep.board_cards) {
            *slot = card;
        }
        Self {
            prep,
            values: vec![0; prep.players],
            acc: vec![0; prep.pots.len() * prep.players],
            cards,
            triples: [[0; 4]; 10],
            heads_up: !prep.omaha
                && prep.players == 2
                && prep.pots.len() == 1
                && prep.pots[0].len() == 2,
        }
    }

    /// Splits each pot between its best eligible hands (`award`).
    fn award(&mut self) {
        let players = self.prep.players;
        for (p, eligible) in self.prep.pots.iter().enumerate() {
            let mut best = -1_i64;
            let mut winners = 0_usize;
            for &e in eligible {
                let value = self.values[e];
                if value > best {
                    best = value;
                    winners = 1;
                } else if value == best {
                    winners += 1;
                }
            }
            let amount = share(winners);
            let row = p * players;
            for &e in eligible {
                if self.values[e] == best {
                    self.acc[row + e] += amount;
                }
            }
        }
    }

    /// One complete board: `[s, h, d, c]` of all five cards, and the cards
    /// dealt to complete it (`runout`).
    #[inline]
    fn score(&mut self, masks: [u32; 4], runout: &[u8]) {
        let prep = self.prep;
        let table = prep.table;
        let [s, h, d, c] = masks;
        if self.heads_up {
            // The shape of most all-ins: two values compared directly.
            let [a0, a1, a2, a3] = prep.hole_masks[0];
            let [b0, b1, b2, b3] = prep.hole_masks[1];
            let a = rail_core::eval::evaluate_masks(table, s | a0, h | a1, d | a2, c | a3);
            let b = rail_core::eval::evaluate_masks(table, s | b0, h | b1, d | b2, c | b3);
            if a > b {
                self.acc[0] += UNIT;
            } else if b > a {
                self.acc[1] += UNIT;
            } else {
                self.acc[0] += UNIT / 2;
                self.acc[1] += UNIT / 2;
            }
            return;
        }
        if !prep.omaha {
            for (value, hole) in self.values.iter_mut().zip(&prep.hole_masks) {
                *value = i64::from(rail_core::eval::evaluate_masks(
                    table,
                    s | hole[0],
                    h | hole[1],
                    d | hole[2],
                    c | hole[3],
                ));
            }
            self.award();
            return;
        }
        let known = prep.board_cards.len();
        for (slot, &card) in self.cards[known..].iter_mut().zip(runout) {
            *slot = card;
        }
        let cards = self.cards;
        let mut t = 0;
        for a in 0..5 {
            for b in a + 1..5 {
                for e in b + 1..5 {
                    let mut triple = [0_u32; 4];
                    triple[usize::from(cards[a] & 3)] |= 1 << (cards[a] >> 2);
                    triple[usize::from(cards[b] & 3)] |= 1 << (cards[b] >> 2);
                    triple[usize::from(cards[e] & 3)] |= 1 << (cards[e] >> 2);
                    self.triples[t] = triple;
                    t += 1;
                }
            }
        }
        for (value, pairs) in self.values.iter_mut().zip(&prep.pair_masks) {
            *value = evaluate_omaha_masks(table, pairs, &self.triples).map_or(-1, i64::from);
        }
        self.award();
    }
}

/// `exhaustive(prep, runout, score)`: every completion of the board; returns
/// the count.
fn exhaustive(prep: &Prepared, scorer: &mut Scorer<'_>) -> u64 {
    let stub = &prep.stub;
    let masks: Vec<[u32; 4]> = stub.iter().map(|&card| card_masks(card)).collect();
    let k = 5 - prep.board_cards.len();
    if k == 0 {
        scorer.score(prep.board_masks, &[]);
        return 1;
    }
    let mut runout = [0_u8; 5];
    let mut boards = 0_u64;
    walk(
        stub,
        &masks,
        k,
        0,
        0,
        prep.board_masks,
        &mut runout,
        &mut boards,
        scorer,
    );
    boards
}

/// One level of the nested loops: deal the card at `depth` from `from` on.
#[allow(clippy::too_many_arguments)]
fn walk(
    stub: &[u8],
    masks: &[[u32; 4]],
    k: usize,
    depth: usize,
    from: usize,
    held: [u32; 4],
    runout: &mut [u8; 5],
    boards: &mut u64,
    scorer: &mut Scorer<'_>,
) {
    let n = stub.len();
    if depth == k - 1 {
        for i in from..n {
            runout[depth] = stub[i];
            let m = masks[i];
            scorer.score(
                [
                    held[0] | m[0],
                    held[1] | m[1],
                    held[2] | m[2],
                    held[3] | m[3],
                ],
                &runout[..k],
            );
        }
        *boards += u64::try_from(n - from).unwrap_or(0);
        return;
    }
    for i in from..=(n - (k - depth)) {
        runout[depth] = stub[i];
        let m = masks[i];
        walk(
            stub,
            masks,
            k,
            depth + 1,
            i + 1,
            [
                held[0] | m[0],
                held[1] | m[1],
                held[2] | m[2],
                held[3] | m[3],
            ],
            runout,
            boards,
            scorer,
        );
    }
}

/// `monteCarlo(...)`: `trials` uniformly random completions of the board, a
/// partial Fisher-Yates over a working copy of the stub that is never reset.
fn monte_carlo(prep: &Prepared, scorer: &mut Scorer<'_>, trials: u64, seed: u32) -> u64 {
    let mut deck = prep.stub.clone();
    let n = deck.len();
    let k = 5 - prep.board_cards.len();
    let mut random = Mulberry32::new(seed);
    let mut runout = [0_u8; 5];
    for _ in 0..trials {
        let mut masks = prep.board_masks;
        for i in 0..k {
            let j = i + random.below(n - i);
            deck.swap(i, j);
            let card = deck[i];
            runout[i] = card;
            masks[usize::from(card & 3)] |= 1 << (card >> 2);
        }
        scorer.score(masks, &runout[..k]);
    }
    trials
}

/// `equity(request)`: each player's share of each pot over every runout of
/// the board (or a seeded sample of them).
///
/// An impossible request (a duplicated card, the wrong number of hole cards,
/// a deuce in a short-deck hand) is an [`EquityInputError`] with the
/// TypeScript's message.
pub fn equity(request: &EquityRequest) -> Result<EquityResult, EquityInputError> {
    let prep = prepare(request)?;
    let planned = plan_prepared(&prep, &request.options);
    let mut scorer = Scorer::new(&prep);
    let boards = match planned.method {
        Computation::Exhaustive => exhaustive(&prep, &mut scorer),
        Computation::MonteCarlo => monte_carlo(
            &prep,
            &mut scorer,
            planned.boards,
            request.options.seed.unwrap_or(DEFAULT_SEED),
        ),
    };

    // `acc[p * players + i] / (boards * UNIT)`: both factors of the
    // denominator are exact doubles, their product is rounded once (exact for
    // fewer than 2^53 / UNIT boards), and so is the quotient.
    let denominator = JsNumber::from_u64(boards) * JsNumber::from_u64(UNIT);
    let players = prep.players;
    let units: Vec<Vec<u64>> = (0..prep.pots.len())
        .map(|p| scorer.acc[p * players..(p + 1) * players].to_vec())
        .collect();
    let pots = units
        .iter()
        .map(|row| {
            row.iter()
                .map(|&units| JsNumber::from_u64(units) / denominator)
                .collect()
        })
        .collect();
    Ok(EquityResult {
        pots,
        units,
        method: planned.method,
        boards,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choose_is_the_binomial() {
        assert_eq!(choose(48, 5), 1_712_304);
        assert_eq!(choose(44, 5), 1_086_008);
        assert_eq!(choose(41, 2), 820);
        assert_eq!(choose(3, 5), 0);
        assert_eq!(choose(5, 0), 1);
    }

    #[test]
    fn mulberry32_is_the_typescripts() {
        // `mulberry32(7)` in Node: the first output times 2^32.
        let mut random = Mulberry32::new(7);
        assert_eq!(random.next_u32(), 50_271_532);
    }

    #[test]
    fn every_share_divides_the_unit() {
        for k in 1..=MAX_PLAYERS {
            assert_eq!(share(k) * u64::try_from(k).unwrap_or(0), UNIT);
        }
    }
}

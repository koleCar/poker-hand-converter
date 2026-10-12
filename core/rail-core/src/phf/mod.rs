//! PHF - Poker Hand Format, version `phf/1`, as Rust types.
//!
//! A field-for-field mirror of `frontend/src/lib/phf/types.ts`, which stays the
//! reference until the web app reads the generated declarations instead
//! (docs/RAIL-PLAN.md R0.4, R4.1). Every JSON name, every string tag and every
//! "absent versus `null`" distinction is the same as there; the golden
//! round-trip test (`tests/golden_roundtrip.rs`) holds all 8 422 corpus hands
//! to it byte for byte, and the declarations generated from these types
//! (`core/rail-core-wasm/types/phf.d.ts`) are compared with `types.ts` by
//! `npm run phf:dts-check` in `tests/`.
//!
//! The types are data and (de)serialization. The functions and constants of
//! `types.ts` (R0.5) live in submodules and are re-exported here:
//! [`money`] (currency units, `parseAmount`, `parseAmountStrict`,
//! `formatAmount`, buy-ins), [`game`] (variant and hi/lo labels, deck and deal
//! size, position geometry) and [`hand`] (action, board, chip-movement and
//! lookup helpers). `assignPositions` is [`crate::positions`] and `hilo.ts` is
//! [`hilo`] (R0.5b).
//!
//! Design rules that the rest of the model assumes (from `types.ts`):
//!
//! 1. **No floats.** Every monetary value is an integer in minor units (cents
//!    for cash, whole chips for tournaments) paired with a [`CurrencyUnit`]
//!    that says how many minor units make one display unit. Hand histories are
//!    full of values like `$0.05` and summing them as floats drifts; drift
//!    shows up as "pot does not add up" bugs that are very hard to trace back.
//!    In Rust this is [`Amount`] (`i64`); the workspace lints deny float
//!    arithmetic and lossy casts.
//! 2. **Ordered action stream.** [`PhfHand::actions`] is the authoritative
//!    timeline. Board cards, pots and stacks are all derivable from it; the
//!    denormalized copies exist because the source text states them and we
//!    want to cross-check.
//! 3. **Run-it-twice is not a special case.** [`PhfBoard::runouts`] is a list.
//!    A normal hand has one entry. Nothing downstream needs an `if run_twice`.
//! 4. **Provenance is mandatory.** A hand we cannot trust is worse than no
//!    hand, so every hand carries the raw text it came from, which parser
//!    produced it and what that parser was unsure about.
//!
//! **Integers.** `Amount` is the only `i64` in the model, and it is the only
//! signed integer: an amount can be negative (an uncalled return, a loser's
//! `net`). Seats, indices, line numbers and counts are `u32`. The TypeScript
//! generator relies on this - it renders every `i64` as `Amount` - so a
//! non-money integer must never be declared `i64`.
//!
//! **Field shapes.** `x: T | null` is `Option<T>` that is always written
//! (`null` when `None`) and must be present when read; `x?: T` is `Option<T>`
//! that is omitted when `None` and may not be `null`; `x?: T | null` is
//! `Option<Option<T>>`. See [`serde_util`](self::serde_util) for why each needs
//! its own attribute. Every struct denies unknown fields, so a field `types.ts`
//! gains without this model following fails loudly instead of being dropped.

pub mod game;
pub mod hand;
pub mod hilo;
pub mod money;
mod serde_util;
mod tags;

#[cfg(test)]
mod dts;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

pub use self::game::{
    button_blind_ring, card_in_deck, dealt_in_seats, has_dead_button, hole_card_count,
    is_hi_lo_label, position_ring, resolve_positions, variant_from_label,
};
pub use self::hand::{
    all_cards, contributions_from_actions, hero_of, house_into_pot, is_button_blind,
    is_posting_action, player_by_name, player_by_seat, primary_board, resolve_runout,
    runout_through_street, seat_out_of_pot, second_board, total_fees,
};
pub use self::money::{
    AmountError, AmountProblem, BuyIn, KnownUnit, cash_unit, cash_unit_with_minor_units,
    chips_unit_for, format_amount, format_amount_digits, parse_amount, parse_amount_strict,
    parse_buy_in_token, total_buy_in, unit_for_code, unit_for_symbol,
};

use serde::{Deserialize, Serialize};

use self::serde_util::{double_option, nullable, present};

/// Schema tag stamped on every hand. See `docs/PHF-SPEC.md` for the
/// versioning policy. Rail Hand Format is PHF; the identifier stays `phf/1`
/// because every stored `hands` row carries it (docs/RAIL_GUIDELINE.md §2,
/// amendment A1).
pub const PHF_SCHEMA: &str = "phf/1";

/// The schema tag as a type: the only value `PhfHand.schema` can hold, so a
/// document of any other version fails to deserialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PhfSchema {
    /// `"phf/1"`, i.e. [`PHF_SCHEMA`].
    #[default]
    #[serde(rename = "phf/1")]
    V1,
}

/* ------------------------------------------------------------------ money - */

/// An amount of money or chips, expressed in **integer minor units**.
///
/// The unit is not carried on the value itself (that would bloat every
/// action); it lives once on `PhfHand.game.unit` and, for buy-ins, on
/// `PhfTournament.buyInUnit`.
///
/// TypeScript's `Amount` is a `number`; every value in PHF is a safe integer
/// (|x| <= 2^53 - 1), which `i64` holds exactly.
pub type Amount = i64;

/// Whether the integers of a unit are money or chips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum CurrencyKind {
    Cash,
    Chips,
}

/// Describes what the integers in a hand mean.
///
/// `minorUnits` is the divisor used to go from the stored integer to the number
/// a human reads: cash tables use 100 (cents), tournament chips use 1 because a
/// chip is already indivisible.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CurrencyUnit {
    /// ISO-ish code. "USD" / "EUR" / "GBP" / "CHIPS" / "TCHIP" for play money.
    pub code: String,
    /// What gets printed in front of the number; empty string for chips.
    pub symbol: String,
    /// Minor units per display unit: 100 for cash, 1 for chips.
    pub minor_units: u32,
    /// Chips never convert to real money inside the hand; cash does.
    pub kind: CurrencyKind,
}

/// How a site prints fractional amounts.
///
/// GG writes `$0.5`, WePlay writes `$0.50`. Both are "the same" number, but
/// Holdem Manager import is byte sensitive and our own round-trip tests compare
/// text, so the choice has to survive the trip through PHF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum DecimalStyle {
    #[default]
    Minimal,
    Fixed2,
}

/* ------------------------------------------------------------- descriptors - */

/// A betting street. Declared in play order, so `Ord` is [`STREET_ORDER`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Street {
    Preflop,
    Flop,
    Turn,
    River,
    Showdown,
}

/// Every street in play order (`STREET_ORDER` in `types.ts`).
pub const STREET_ORDER: [Street; 5] = [
    Street::Preflop,
    Street::Flop,
    Street::Turn,
    Street::River,
    Street::Showdown,
];

/// Game variants.
///
/// **`Variant` describes the deal, not the pot-award rule.** There is
/// deliberately no `omaha-hilo` member here; see [`PhfGame::hi_lo`] for why the
/// split-pot rule is a flag instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Variant {
    Holdem,
    Omaha,
    Omaha5,
    Omaha6,
    Shortdeck,
    Stud,
    Razz,
    Draw,
    Other,
}

/// Betting structure: no limit, pot limit, fixed limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum LimitType {
    Nl,
    Pl,
    Fl,
}

/// Cash game or one of the tournament formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum GameFormat {
    Cash,
    Tournament,
    Sng,
    Spin,
}

/// Who pays the ante and how.
///
/// This is not cosmetic: `big-blind-ante` means one player posts for the table,
/// which changes both the chip-conservation check and how the replayer animates
/// the posting round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum AnteModel {
    None,
    PostedPerPlayer,
    BigBlindAnte,
    ButtonAnte,
}

/// Resolved table position. `MP` is the catch-all for the middle seats of a
/// full ring table; everything else is the seat name players and trackers
/// actually use, so filters like "3-bet from the CO" become a plain equality
/// test.
///
/// Heads-up the button *is* the small blind, so **no seat is labelled `BTN`**;
/// code that needs the button must read `PhfTable.buttonSeat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Position {
    #[serde(rename = "BTN")]
    Btn,
    #[serde(rename = "SB")]
    Sb,
    #[serde(rename = "BB")]
    Bb,
    #[serde(rename = "UTG")]
    Utg,
    #[serde(rename = "UTG+1")]
    Utg1,
    #[serde(rename = "UTG+2")]
    Utg2,
    #[serde(rename = "MP")]
    Mp,
    #[serde(rename = "LJ")]
    Lj,
    #[serde(rename = "HJ")]
    Hj,
    #[serde(rename = "CO")]
    Co,
}

/* -------------------------------------------------------------------- game - */

/// A straddle, i.e. a voluntary blind posted out of position before the deal.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfStraddle {
    pub seat: u32,
    pub player: String,
    /// The straddle's size: the straddler's street total once it is posted. The
    /// same as the chips added for an ordinary straddle; for a re-straddle by a
    /// seat that already had money in - GG's short deck has the button blind
    /// straddle its own blind - the chips added are on the action instead.
    pub amount: Amount,
    /// 1 = first straddle (usually UTG), 2 = re-straddle, and so on.
    pub order: u32,
}

/// Bomb pot descriptor. In a bomb pot everybody antes a fixed amount, no blinds
/// are posted and the flop is dealt immediately, so the normal "preflop betting
/// round" invariants do not apply and the validator has to know.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfBombPot {
    /// Ante each player put in.
    pub ante: Amount,
    /// Bomb pots usually skip straight to the flop.
    pub dealt_to_street: Street,
    /// Some rooms run double-board bomb pots.
    pub double_board: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfGame {
    pub variant: Variant,
    pub limit: LimitType,
    /// High-low split: half the pot goes to the lowest qualifying hand.
    ///
    /// A flag and not an `omaha-hilo` variant because hi/lo changes who is
    /// paid, not what is dealt; `holeCardCount` and the `variant` filter
    /// dispatch on the deal (`types.ts` has the full argument).
    ///
    /// **What the flag does not carry is who won which half.** That lives on
    /// the awards - `PhfAction.half` on each collect and
    /// `results.winners[].half`.
    pub hi_lo: bool,
    pub format: GameFormat,
    /// Unit for every `Amount` in this hand outside the tournament buy-in.
    pub unit: CurrencyUnit,
    pub small_blind: Amount,
    pub big_blind: Amount,
    pub ante_model: AnteModel,
    /// Ante per player under `posted-per-player`, or the single posted ante otherwise.
    pub ante: Amount,
    pub straddles: Vec<PhfStraddle>,
    #[serde(deserialize_with = "nullable")]
    pub bomb_pot: Option<PhfBombPot>,
    /// Verbatim game label from the source, e.g. "Hold'em No Limit".
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfTable {
    #[serde(deserialize_with = "nullable")]
    pub name: Option<String>,
    pub max_seats: u32,
    #[serde(deserialize_with = "nullable")]
    pub button_seat: Option<u32>,
    /// Fast-fold pool brand, or null/absent for an ordinary table.
    ///
    /// PokerStars calls it `Zoom`, GG `Rush & Cash`, Unibet `Banzai`, party
    /// `FastForward`. The brand is kept rather than a boolean because the
    /// presence answers "is this fast fold?" and the value answers "which
    /// one?".
    ///
    /// `fastFold?: string | null` in TypeScript: `None` is absent,
    /// `Some(None)` is `null`, and both are written back as they came.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    #[cfg_attr(test, ts(optional))]
    pub fast_fold: Option<Option<String>>,
}

/// A progressive-knockout bounty on one player (`PhfTournament.bounties`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfBounty {
    pub player: String,
    pub amount: Amount,
}

/// Tournament-only metadata. `null` on cash hands.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfTournament {
    pub id: String,
    #[serde(deserialize_with = "nullable")]
    pub name: Option<String>,
    /// Buy-in and fee are *real money* even when the stacks are chips, in
    /// `buyInUnit`.
    ///
    /// `buyIn` is the prize-pool contribution only. A knockout tournament
    /// writes its buy-in as three components - `$4.50+$4.50+$1` is prize pool,
    /// bounty, fee - and collapsing the bounty into the buy-in would overstate
    /// what the player paid for equity in the prize pool, which is the number
    /// ROI is computed against. What left the account is buy-in + bounty + fee.
    pub buy_in: Amount,
    /// The knockout portion of the buy-in, i.e. what goes on the player's own
    /// head. Zero (or absent) for a non-knockout tournament; read it as `?? 0`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub bounty: Option<Amount>,
    pub fee: Amount,
    pub buy_in_unit: CurrencyUnit,
    /// Level as printed ("XI", "12"), plus the parsed number when we can get one.
    #[serde(deserialize_with = "nullable")]
    pub level_label: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub level_number: Option<u32>,
    /// Blinds the level header advertises; may differ from what was posted.
    pub level_small_blind: Amount,
    pub level_big_blind: Amount,
    pub level_ante: Amount,
    /// Progressive-knockout bounties, by player.
    pub bounties: Vec<PhfBounty>,
    /// Total prize pool, when the room states it (Unibet prints `Total prize €4`).
    ///
    /// In `buyInUnit`, not chips. Absent when the room does not say; never
    /// derived, because a guess here would look identical to a stated figure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub prize_pool: Option<Amount>,
}

/* ----------------------------------------------------------------- players - */

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfPlayer {
    pub seat: u32,
    pub name: String,
    pub starting_stack: Amount,
    pub is_hero: bool,
    /// Hole cards when known. Empty means unknown, which is the normal case for
    /// villains who never showed. Length is variant dependent (2 for Hold'em,
    /// 4-6 for Omaha), so never index blindly.
    pub hole_cards: Vec<String>,
    /// PKO bounty carried by this player, when the site reports it.
    #[serde(deserialize_with = "nullable")]
    pub bounty: Option<Amount>,
    pub sitting_out: bool,
    /// Resolved from the blinds and the seats dealt in; null when it cannot be.
    #[serde(deserialize_with = "nullable")]
    pub position: Option<Position>,
    /// The source printed a "Dealt to <player>" line for this seat. GG prints
    /// one per seated player, WePlay only for the hero; the serializer needs to
    /// know which shape to emit.
    pub dealt_announced: bool,
    /// Cards the *deal block* showed, which is not the same thing as
    /// `holeCards`.
    ///
    /// GG writes `Dealt to villain ` with no cards and only reveals them in the
    /// summary; `holeCards` therefore ends up populated while the deal line
    /// must still be re-emitted empty. Keeping the two apart is what makes the
    /// text round trip exact.
    pub dealt_cards: Vec<String>,
}

/* ----------------------------------------------------------------- actions - */

/// Action vocabulary.
///
/// A closed set that consumers switch on: adding a member is a `phf/2` change
/// (`docs/PHF-SPEC.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum ActionType {
    Ante,
    SmallBlind,
    BigBlind,
    Straddle,
    Post,
    MissedBlind,
    BombAnte,
    Fold,
    Check,
    Call,
    Bet,
    Raise,
    Uncalled,
    Show,
    Muck,
    Collect,
    CashoutChoose,
    CashoutPay,
}

/// Which half of a high-low split pot an award came from.
///
/// - `hi` - the high half, or the **whole pot** when no low qualified.
/// - `lo` - the low half.
/// - absent - the pot was not split: a hand that is not hi/lo, a pot nobody
///   contested, or one player taking both halves on a single line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PotHalf {
    Hi,
    Lo,
}

/// The verb GG prints for the one blind of an ante-only short-deck table:
/// `Hero: posts button blind $0.02`. A button blind is a `big-blind` action
/// with this verb, not an action type of its own (see `isButtonBlind` in
/// `types.ts`).
pub const BUTTON_BLIND_VERB: &str = "posts button blind";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfAction {
    /// Position in the stream; stable across serialization.
    pub index: u32,
    pub street: Street,
    /// Which runout this action belongs to. Only collects and shows after a
    /// run-it-twice ever use a value > 0; everything else is 0.
    pub runout_index: u32,
    /// Seat of the actor, or `null` for dealer-side events.
    #[serde(deserialize_with = "nullable")]
    pub seat: Option<u32>,
    pub player: String,
    /// `type` in JSON.
    #[serde(rename = "type")]
    pub kind: ActionType,
    /// Chips this action moves into the pot. Negative for an uncalled return,
    /// which is what keeps the chip-conservation sum honest.
    pub amount: Amount,
    /// Total the actor has committed on this street after the action.
    pub street_total: Amount,
    pub all_in: bool,
    /// Cards revealed by this action (shows).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub cards: Option<Vec<String>>,
    /// Showdown hand description, e.g. "a pair of Aces".
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    /// The literal verb the source used, when it differs from the canonical
    /// one.
    ///
    /// WePlay writes `Kadiddy: posts straddle $4` where the standard text says
    /// `posts $4`. The action type is what code should branch on; this keeps
    /// the wording so the text round-trips. The one exception is GG's button
    /// blind, a `big-blind` whose verb is [`BUTTON_BLIND_VERB`].
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub verb: Option<String>,
    /// Which pot a collect came from: "pot", "main pot", "side pot", ...
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub pot_name: Option<String>,
    /// Which half of a high-low split pot a `collect` paid. Only ever set on a
    /// collect in a `game.hiLo` hand; see [`PotHalf`] for what absence means.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub half: Option<PotHalf>,
    /// Human readable label; the replayer log renders this verbatim.
    pub label: String,
    /// 1-based line number inside the raw hand text, for debugging.
    #[serde(deserialize_with = "nullable")]
    pub source_line: Option<u32>,
    /// The source line this action came from.
    pub raw_line: String,
}

/* ------------------------------------------------------------------- board - */

/// Literal prefixes the source printed on each street marker of a runout
/// (`PhfRunout.markerLabels`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfMarkerLabels {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub flop: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub turn: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub river: Option<String>,
}

/// One runout of the community cards.
///
/// A `null` street means "identical to runout 0". That is exactly how sites
/// print it (`SECOND TURN` appears but `SECOND FLOP` does not when the flop is
/// shared), and it lets the serializer reproduce the source without guessing.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfRunout {
    pub index: u32,
    #[serde(deserialize_with = "nullable")]
    pub flop: Option<Vec<String>>,
    #[serde(deserialize_with = "nullable")]
    pub turn: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub river: Option<String>,
    /// Literal prefix the source printed on each street marker for this runout
    /// ("", "FIRST", "SECOND").
    ///
    /// Carries no information the index does not, but reproducing it is what
    /// keeps imported text byte-identical on the way back out. Empty for
    /// parsers that build a hand from scratch; the serializer then derives a
    /// label.
    pub marker_labels: PhfMarkerLabels,
    /// Cards the SUMMARY `Board` line listed for this runout, verbatim.
    ///
    /// GG lists only the cards that differ from runout 0, WePlay repeats the
    /// whole board. Kept for faithful output, never read as data.
    #[serde(deserialize_with = "nullable")]
    pub summary_cards: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfBoard {
    /// Always at least one entry. Two entries means the hand was run twice.
    pub runouts: Vec<PhfRunout>,
}

/* ---------------------------------------------------------- chip movements - */

/// Where the room printed a chip movement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum ChipMovementAnchor {
    BeforePostings,
    AfterHoleCards,
}

/// Chips that move outside the ordinary bet path.
///
/// PHF's chip model has exactly two flows: a seat puts chips into the pot, and
/// the pot pays chips back out to seats less fees. Promotions fit neither:
/// the house putting chips into the pot (GG's `Cash Drop to Pot`, Run It
/// Once's `STP added`) and a seat paying the house past the pot
/// (MicroGaming's `BadBeatContribution`). Both are real money and are
/// accounted for here rather than forced into an action or a fee.
///
/// Deliberately *not* a `PhfAction`: `ActionType` is a closed union, so
/// extending it is a `phf/2` change, whereas an optional field here is
/// additive. See `docs/PHF-SPEC.md` §5.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfChipMovement {
    /// What the room called it, as a machine code: `splash-the-pot`,
    /// `cash-drop`, `bad-beat-drop`, `jackpot-drop`.
    pub kind: String,
    /// Seat the chips left, or null when the house supplied them.
    #[serde(deserialize_with = "nullable")]
    pub from_seat: Option<u32>,
    /// Player name for `fromSeat`, or null.
    #[serde(deserialize_with = "nullable")]
    pub from_player: Option<String>,
    /// Whether the chips land in the pot.
    ///
    /// `true` means they count toward chip conservation and the pot the
    /// winners split; `false` means they leave the table entirely and only
    /// reduce a stack.
    pub to_pot: bool,
    pub amount: Amount,
    /// Verbatim source line, so the text round-trips.
    #[serde(deserialize_with = "nullable")]
    pub raw: Option<String>,
    /// Where the room printed it, which differs: GG puts the drop after the
    /// seat block and before the blinds, Run It Once after `*** HOLE CARDS ***`.
    pub anchor: ChipMovementAnchor,
}

/* ----------------------------------------------------------------- results - */

/// Fees taken out of the pot, broken out rather than lumped into one `rake`
/// number, because the GG summary line reports them separately and win-rate
/// math needs to be able to add back the ones that are promotional.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfFees {
    pub rake: Amount,
    pub jackpot: Amount,
    pub bingo: Amount,
    pub fortune: Amount,
    pub tax: Amount,
    /// Anything a site reports that does not map to the above.
    pub other: Amount,
}

impl PhfFees {
    /// No fees at all (`ZERO_FEES` in `types.ts`).
    pub const ZERO: Self = Self {
        rake: 0,
        jackpot: 0,
        bingo: 0,
        fortune: 0,
        tax: 0,
        other: 0,
    };
}

/// How a player's hand ended, as reported by the summary block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum SeatOutcome {
    Folded,
    Collected,
    Won,
    Lost,
    Mucked,
    Showed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfPlayerResult {
    pub seat: u32,
    pub player: String,
    /// Total chips collected from all pots.
    pub won: Amount,
    /// Total chips put in, net of uncalled returns.
    pub contributed: Amount,
    /// `won - contributed`. Negative for a loser.
    pub net: Amount,
    pub went_to_showdown: bool,
    /// Cards this player revealed (showdown or summary).
    pub shown_cards: Vec<String>,
    pub mucked: bool,
    #[serde(deserialize_with = "nullable")]
    pub hand_description: Option<String>,
    /// Position words exactly as the summary prints them, e.g. `["(button)"]`
    /// or `["(button)", "(small blind)"]` heads-up. The machine-readable
    /// position lives on `PhfPlayer.position`; this is here for byte-faithful
    /// output.
    pub position_labels: Vec<String>,
    pub outcome: SeatOutcome,
    #[serde(deserialize_with = "nullable")]
    pub folded_street: Option<Street>,
    /// Summary said "(didn't bet)": folded without putting a chip in
    /// voluntarily.
    pub didnt_bet: bool,
    /// GG EV-cashout risk paid by this player, settled outside the pot.
    #[serde(deserialize_with = "nullable")]
    pub cashout_risk: Option<Amount>,
    /// The summary line verbatim, so `toStandardText` can reproduce imported
    /// text byte for byte. Parsers that build a hand from scratch leave this
    /// `null` and the serializer generates a canonical line.
    #[serde(deserialize_with = "nullable")]
    pub raw: Option<String>,
}

/// One pot of a side-pot breakdown (`PhfResults.pots`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfPot {
    pub name: String,
    pub amount: Amount,
}

/// One award: one entry per collect, per runout (`PhfResults.winners`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfWinner {
    pub player: String,
    #[serde(deserialize_with = "nullable")]
    pub seat: Option<u32>,
    pub amount: Amount,
    pub runout_index: u32,
    /// Mirrors the collect it came from (`PhfAction.half`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub half: Option<PotHalf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfResults {
    /// Pot before fees, as the source reports it.
    pub total_pot: Amount,
    /// Side-pot breakdown when the source reports one, e.g.
    /// `[{ name: "Main", amount: 3715 }, { name: "Side", amount: 6596 }]`.
    /// Empty when everything went into a single pot.
    pub pots: Vec<PhfPot>,
    pub fees: PhfFees,
    pub players: Vec<PhfPlayerResult>,
    /// Flattened winner list; one entry per collect, per runout.
    pub winners: Vec<PhfWinner>,
    /// Hero's `net`, or null when there is no hero.
    #[serde(deserialize_with = "nullable")]
    pub hero_net: Option<Amount>,
    pub went_to_showdown: bool,
    /// Furthest street the hand actually reached.
    pub street_reached: Street,
}

/* -------------------------------------------------------------------- meta - */

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfWarning {
    /// Short machine code, e.g. "unknown-line".
    pub code: String,
    pub message: String,
    /// 1-based line number in the raw text when the warning is line-scoped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub line: Option<u32>,
}

/// Purely presentational choices that a site makes and that therefore have to
/// survive a round trip through PHF. None of these affect the meaning of a
/// hand.
///
/// The last four fields are *optional and tri-state*: `true`/`false` (or a
/// value) pins the choice, absent means "work it out from `meta.rawText`"
/// (`resolveTextStyle`). Parsers that spread `DEFAULT_TEXT_STYLE` therefore do
/// not silently pin a default that is wrong for their room.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfTextStyle {
    /// `$0.5` (GG) versus `$0.50` (WePlay and most others).
    pub decimals: DecimalStyle,
    /// The source prints a `Dealt to` line for every seated player, not just
    /// the hero.
    pub dealt_lines_for_all_players: bool,
    /// The source printed an explicit `*** SHOWDOWN ***` section.
    pub showdown_section: bool,
    /// The source printed `*** HOLE CARDS ***`.
    pub hole_cards_section: bool,
    /// Prefixes of the showdown markers the source printed, in order. `[""]`
    /// is a single `*** SHOWDOWN ***`; `["FIRST", "SECOND"]` is a run-it-twice
    /// that settled each runout separately.
    pub showdown_labels: Vec<String>,
    /// The SUMMARY block carried a "Hand was run two times" note.
    pub run_it_twice_note: bool,
    /// The source zero-pads the hour in the header timestamp (GG `05:56:01`,
    /// WePlay `8:34:11`).
    pub pad_hour: bool,
    /// Digit grouping in amounts: `21,929` (GG tournaments) versus `21929`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub group_thousands: Option<bool>,
    /// A `Dealt to <player>` line with no cards ends with a trailing space
    /// (GG cash) or not (GG tournaments). Trackers match on the line.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub dealt_line_trailing_space: Option<bool>,
    /// Fee columns on the `Total pot` line, in order, excluding the pot itself:
    /// `["Rake"]`, `["Rake", "Jackpot", "Bingo"]`, or the full GG cash set
    /// `["Rake", "Jackpot", "Bingo", "Fortune", "Tax"]`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub summary_fee_columns: Option<Vec<String>>,
    /// The header text after `Poker Hand #<id>: `, verbatim, replayed only
    /// when it demonstrably belongs to the same hand. Authoritative data still
    /// lives in `PhfHand.tournament` and `PhfHand.game`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub header_payload: Option<String>,
}

/// `DEFAULT_TEXT_STYLE` in `types.ts`.
impl Default for PhfTextStyle {
    fn default() -> Self {
        Self {
            decimals: DecimalStyle::Minimal,
            dealt_lines_for_all_players: false,
            showdown_section: true,
            hole_cards_section: true,
            showdown_labels: vec![String::new()],
            run_it_twice_note: false,
            pad_hour: true,
            group_thousands: None,
            dealt_line_trailing_space: None,
            summary_fee_columns: None,
            header_payload: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfMeta {
    /// Registry id of the site the hand came from, e.g. "weplay".
    pub site_id: String,
    /// Display name for the UI.
    pub site_name: String,
    /// Hand id exactly as the site wrote it.
    pub hand_id: String,
    /// Stable dedupe key. Kept equal to `handId` for the sites already stored,
    /// so re-uploading a file still dedupes against existing rows.
    pub hand_key: String,
    #[serde(deserialize_with = "nullable")]
    pub original_filename: Option<String>,
    pub parser_id: String,
    pub parser_version: String,
    pub warnings: Vec<PhfWarning>,
    /// The hand's own slice of the uploaded file. Never lose the source.
    pub raw_text: String,
    /// ISO timestamp of when we parsed it (not when it was played). The only
    /// field that does not follow from the input; the goldens pin it to
    /// `1970-01-01T00:00:00.000Z`.
    pub parsed_at: String,
    pub text_style: PhfTextStyle,
}

/* -------------------------------------------------------------------- hand - */

/// One poker hand: what every parser produces and every consumer reads.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PhfHand {
    pub schema: PhfSchema,
    pub meta: PhfMeta,
    pub game: PhfGame,
    pub table: PhfTable,
    #[serde(deserialize_with = "nullable")]
    pub tournament: Option<PhfTournament>,
    pub players: Vec<PhfPlayer>,
    pub actions: Vec<PhfAction>,
    /// Promotional and jackpot chip movements that are not bets. Absent on the
    /// overwhelming majority of hands; see [`PhfChipMovement`].
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(optional))]
    pub chip_movements: Option<Vec<PhfChipMovement>>,
    pub board: PhfBoard,
    pub results: PhfResults,
    /// ISO timestamp the hand was dealt, or null when the source omits it.
    #[serde(deserialize_with = "nullable")]
    pub played_at: Option<String>,
}

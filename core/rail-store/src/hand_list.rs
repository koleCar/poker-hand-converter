//! The Hands screen (docs/RAIL-PLAN.md R2.7a): the list of hands with its
//! filters, the counts beside the filter chips, "go to hand", and the
//! user's notes, tags and saved filters.
//!
//! - **The list** ([`Reader::hand_page`]) reads `hand_list`, one narrow row
//!   per hand clustered by (`played_at`, `hand_key`): newest first, a page
//!   is one range of the table and the next page starts after the last
//!   row's key (a keyset cursor, [`HandCursor`]), so a page costs the same
//!   at the millionth hand as at the first and stays stable while hands
//!   arrive. `hands`, `hand_stats` and the EV and note tables are read only
//!   for the rows of the page.
//! - **Filters** ([`HandFilter`]): the segment's dimensions (site, format,
//!   variant, limit, table size, stake) become a set of `segments.id`s
//!   (that table is small); the hero's position, result and stack, the pot
//!   type and the all-in flag are columns of the row; the date range is a
//!   range of the key; notes and tags are the user's tables; a player
//!   (R2.7c, "hands with this player") is their entries in `player_hands`.
//! - **The counts** ([`Reader::hand_facets`]) for each chip: the hands that
//!   would match if that chip's own group were left out of the filter (how
//!   many hands a click adds), all groups from one pass over the rows.
//! - **Writes** ([`set_note`], [`add_tag`], [`remove_tag`], [`save_filter`],
//!   [`delete_saved_filter`]) run on the writer (`WriterHandle::write`).
//!   Notes and tags stay on this computer for now (syncing them to the web
//!   is a later step).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rail_stats::Counter;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use crate::error::{Error, Result};
use crate::read::Reader;
pub use crate::stats::Acts;

/// The most rows one page returns.
pub const PAGE_MAX: u32 = 500;

/// The longest tag, in characters.
pub const TAG_MAX_CHARS: usize = 40;

/// The longest note, in characters.
pub const NOTE_MAX_CHARS: usize = 10_000;

/// The hero's stack depth groups of the stack filter: id, lowest stack in
/// tenths of a big blind (inclusive), highest (exclusive; `None`: no limit).
pub const STACK_DEPTHS: [(&str, i64, Option<i64>); 4] = [
    ("0-40", 0, Some(400)),
    ("40-80", 400, Some(800)),
    ("80-120", 800, Some(1200)),
    ("120+", 1200, None),
];

/// The hero's result in a hand, for the result filter.
pub const RESULTS: [&str; 3] = ["won", "lost", "even"];

/// An opponent of a room with real screen names (R2.7c): the site key
/// (`segments.site`) and the name as the room printed it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerRef {
    pub site: String,
    pub player: String,
}

/// What the list shows: every group is "any" when empty, and a hand must
/// match every group that is not.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HandFilter {
    /// Site ids (`segments.site`: `hand_key`'s prefix, `pokerstars`).
    pub sites: Vec<String>,
    /// `cash`, `tournament`, `sng`, `spin`.
    pub formats: Vec<String>,
    /// `holdem`, `omaha`, ...
    pub variants: Vec<String>,
    /// `nl`, `pl`, `fl`.
    pub limits: Vec<String>,
    /// Table sizes: `hu`, `6max`, `full`.
    pub sizes: Vec<String>,
    /// Stakes as `segments.stake` writes them (`USD:200`, `chips`).
    pub stakes: Vec<String>,
    /// The hero's positions (`BTN`, ...). A hand without a hero matches none.
    pub positions: Vec<String>,
    /// `walk`, `bomb`, `limped`, `single-raised`, `3bet`, `4bet+`.
    pub pot_types: Vec<String>,
    /// The hero's result: [`RESULTS`].
    pub results: Vec<String>,
    /// The hero's starting stack: ids of [`STACK_DEPTHS`].
    pub stacks: Vec<String>,
    /// Only hands where the hero was all in with cards to come (`true`), or
    /// only the others (`false`).
    pub all_in: Option<bool>,
    /// Only hands with a note (`true`), or only those without (`false`).
    pub has_note: Option<bool>,
    /// Hands with any of these tags.
    pub tags: Vec<String>,
    /// From this instant on, ISO UTC as PHF writes it, inclusive. A bound
    /// leaves out hands without a `played_at`.
    pub from: Option<String>,
    /// Before this instant, exclusive.
    pub to: Option<String>,
    /// Only hands this opponent was dealt into (R2.7c).
    pub player: Option<PlayerRef>,
    /// The hero's starting-hand classes (`AA`, `AKs`, `AKo`): any of them.
    pub hero_classes: Vec<String>,
    /// Cards the hero held (`Ah`, `Kd`): all of them.
    pub hero_cards: Vec<String>,
    /// Cards on the board, any street (`Kd`, `7c`): all of them.
    pub board: Vec<String>,
    /// Ranks on the board whatever their suits (`K`, `7`, `5`; a rank twice
    /// for a pair): all of them (2026-11-05, the owner's "K75").
    pub board_ranks: Vec<String>,
    /// A player dealt into the hand, by exact screen name, in any room.
    pub player_name: Option<String>,
    /// Only hands that went to showdown (`true`), or only the others.
    pub showdown: Option<bool>,
    /// The order: [`SORTS`]; `None` (or an unknown one) is the newest first.
    pub sort: Option<String>,
    /// The builder's groups of the hero's actions ([`ACTS`] names): a hand
    /// matches a group with any of its actions, and every group.
    pub acts: Vec<Vec<String>>,
    /// The flop's suits: `rainbow`, `twoTone`, `monotone` (any of them).
    pub flop_suits: Vec<String>,
    /// The flop's pairing: `unpaired`, `paired`, `trips`.
    pub flop_pairing: Vec<String>,
    /// The flop's highest rank: `A`, `K`, `Q`, `J`, `T`, or `low` (9 or lower).
    pub flop_high: Vec<String>,
    /// Whether three cards to a straight are on the flop: `straight`, `noStraight`.
    pub flop_connect: Vec<String>,
    /// Players dealt in: `2` ... `6`, `7plus`.
    pub players: Vec<String>,
    /// Game conditions, all of them: `straddle`, `ante`, `runItTwice`.
    pub conditions: Vec<String>,
    /// Days of the week, 1 Monday ... 7 Sunday, in the reader's time.
    pub weekdays: Vec<u8>,
    /// Parts of the day in the reader's time: `night` 0-6, `morning` 6-12,
    /// `afternoon` 12-18, `evening` 18-24.
    pub day_parts: Vec<String>,
    /// The reader's offset from UTC, minutes (for the days and the hours).
    pub utc_offset_minutes: i32,
    /// Only the latest this many hands (of every hand in the store).
    pub last_hands: Option<u32>,
    /// The hero's starting stack, big blinds: from, to (inclusive).
    pub hero_stack_min: Option<f64>,
    pub hero_stack_max: Option<f64>,
    /// The hero's result, big blinds: from, to (inclusive).
    pub net_min: Option<f64>,
    pub net_max: Option<f64>,
    /// The hand's total pot: from, to (inclusive). In big blinds, or with
    /// `pot_in_money` in the table's currency (`$25`), which leaves out the
    /// tournaments' chips (2026-11-08, the owner's ask).
    pub pot_min: Option<f64>,
    pub pot_max: Option<f64>,
    pub pot_in_money: bool,
    /// The analysis: `blunder`, `mistake`, `inaccurate` (a decision so
    /// graded), `clean` (analysed, nothing worse than good), `notAnalysed`.
    pub grades: Vec<String>,
    /// EV the analysis says was lost, at least, big blinds.
    pub ev_loss_min: Option<f64>,
    /// A villain's cards were seen (`true`), or none were.
    pub known_cards: Option<bool>,
    /// The open's size raised to, big blinds: from, to.
    pub open_min: Option<f64>,
    pub open_max: Option<f64>,
    /// The hero's first bet or raise on the flop, turn, river as a share of
    /// the pot: `small` (up to 33 %), `medium` (34-75), `large` (76-125),
    /// `overbet` (more).
    pub bet_sizes: [Vec<String>; 3],
    /// What the hero made on the flop, turn, river ([`crate::facts::MADE`]).
    pub made: [Vec<String>; 3],
    /// A top pair's kicker on any street: `top`, `good`, `weak`.
    pub kickers: Vec<String>,
    /// What the hero drew to on the flop, turn ([`crate::facts::DRAWS`]).
    pub draws: [Vec<String>; 2],
    /// Opponents in the pot at these positions (any of them).
    pub vs_positions: Vec<String>,
    /// The hero in position on the flop (`ip`), or out of it (`oop`).
    pub position_flop: Vec<String>,
    /// Players who saw the flop: `2`, `3`, `4plus`.
    pub players_flop: Vec<String>,
    /// An opponent in the pot of this type (`fish`, `reg`, `unknown`) by
    /// their numbers over every hand (`player_rollups`).
    pub vs_types: Vec<String>,
    /// An opponent in the pot whose VPIP is within, percent.
    pub vs_vpip_min: Option<f64>,
    pub vs_vpip_max: Option<f64>,
    /// A tournament's buy-in, in its currency: from, to.
    pub buy_in_min: Option<f64>,
    pub buy_in_max: Option<f64>,
    /// A bounty tournament (`true`), or not.
    pub bounty: Option<bool>,
    /// Blind levels: `1-5`, `6-10`, `11-15`, `16plus`.
    pub levels: Vec<String>,
}

/// The hero's actions on the list row (`hand_list.hero_acts`, version 18),
/// bit `i` for the `i`-th, by the counters that set it.
pub const ACTS: &[(&str, Acts)] = &[
    ("open", Acts::Any(&[Counter::rfi])),
    ("limp", Acts::Any(&[Counter::limp])),
    ("iso", Acts::Any(&[Counter::iso])),
    ("callOpen", Acts::Any(&[Counter::cold_call])),
    ("threeBet", Acts::Any(&[Counter::three_bet])),
    ("callThreeBet", Acts::Any(&[Counter::call_three_bet])),
    (
        "fourBet",
        Acts::Any(&[Counter::four_bet, Counter::five_bet]),
    ),
    ("squeeze", Acts::Any(&[Counter::squeeze])),
    ("steal", Acts::Any(&[Counter::steal])),
    ("foldToThreeBet", Acts::Any(&[Counter::fold_to_three_bet])),
    ("facedUnopened", Acts::Any(&[Counter::rfi_opp])),
    ("facedLimp", Acts::Any(&[Counter::iso_opp])),
    (
        "facedOpen",
        Acts::Any(&[Counter::three_bet_opp, Counter::cold_call_opp]),
    ),
    (
        "facedThreeBet",
        Acts::Any(&[Counter::fold_to_three_bet_opp]),
    ),
    ("facedFourBet", Acts::Any(&[Counter::fold_to_four_bet_opp])),
    ("aggressor", Acts::Any(&[Counter::pfr])),
    ("caller", Acts::Caller),
    ("sawFlop", Acts::Any(&[Counter::flop_seen])),
    ("sawTurn", Acts::Any(&[Counter::turn_seen])),
    ("sawRiver", Acts::Any(&[Counter::river_seen])),
    ("cbetFlop", Acts::Any(&[Counter::cbet_flop])),
    ("checkRaiseFlop", Acts::Any(&[Counter::check_raise_flop])),
    ("donkFlop", Acts::Any(&[Counter::donk_flop])),
    (
        "facingCbetFlop",
        Acts::Any(&[Counter::fold_to_cbet_flop_opp]),
    ),
    ("raiseCbetFlop", Acts::Any(&[Counter::raise_cbet_flop])),
    ("cbetTurn", Acts::Any(&[Counter::cbet_turn])),
    (
        "facingCbetTurn",
        Acts::Any(&[Counter::fold_to_cbet_turn_opp]),
    ),
    ("checkRaiseTurn", Acts::Any(&[Counter::check_raise_turn])),
    ("donkTurn", Acts::Any(&[Counter::donk_turn])),
    ("cbetRiver", Acts::Any(&[Counter::cbet_river])),
    (
        "facingCbetRiver",
        Acts::Any(&[Counter::fold_to_cbet_river_opp]),
    ),
    ("checkRaiseRiver", Acts::Any(&[Counter::check_raise_river])),
    ("donkRiver", Acts::Any(&[Counter::donk_river])),
];

/// The bit of an action's name in `hero_acts`, if it is one.
pub fn act_bit(name: &str) -> Option<i64> {
    ACTS.iter()
        .position(|(id, _)| *id == name)
        .map(|i| 1i64 << i)
}

/// The pot's size (2026-11-08): `hand_stats.total_pot` (minor units, as the
/// big blind) over the big blind, or over the currency's minor units for an
/// amount of money. A hand with no big blind, or chips when money is asked
/// for, does not match. Read for the rows `hand_list` has already narrowed.
fn pot_clauses(filter: &HandFilter, w: &mut Where) {
    let min = filter.pot_min.filter(|v| v.is_finite());
    let max = filter.pot_max.filter(|v| v.is_finite());
    if min.is_none() && max.is_none() {
        return;
    }
    let (unit, known) = if filter.pot_in_money {
        ("pd.currency_minor_units", "pd.currency_minor_units > 1")
    } else {
        ("ph.big_blind", "ph.big_blind > 0")
    };
    let mut parts = vec![known.to_owned()];
    if let Some(min) = min {
        parts.push(format!("pd.total_pot >= {min} * {unit}"));
    }
    if let Some(max) = max {
        parts.push(format!("pd.total_pot <= {max} * {unit}"));
    }
    w.push(format!(
        "EXISTS (SELECT 1 FROM hand_stats pd JOIN hands ph ON ph.hand_key = pd.hand_key
                 WHERE pd.hand_key = l.hand_key AND {})",
        parts.join(" AND ")
    ));
}

/// The builder's clauses over the PHF facts (schema 19, [`crate::facts`]).
fn facts_clauses(filter: &HandFilter, w: &mut Where) {
    let ranged = |w: &mut Where, column: &str, min: Option<f64>, max: Option<f64>, scale: i64| {
        if let Some(min) = min.filter(|v| v.is_finite()) {
            w.push(format!("{column} >= {min} * {scale}"));
        }
        if let Some(max) = max.filter(|v| v.is_finite()) {
            w.push(format!("{column} <= {max} * {scale}"));
        }
    };
    ranged(w, "l.open_tenths", filter.open_min, filter.open_max, 10);
    for (column, buckets) in ["l.flop_bet_pct", "l.turn_bet_pct", "l.river_bet_pct"]
        .iter()
        .zip(&filter.bet_sizes)
    {
        let parts: Vec<String> = buckets
            .iter()
            .filter_map(|bucket| match bucket.as_str() {
                "small" => Some(format!("{column} <= 33")),
                "medium" => Some(format!("{column} BETWEEN 34 AND 75")),
                "large" => Some(format!("{column} BETWEEN 76 AND 125")),
                "overbet" => Some(format!("{column} > 125")),
                _ => None,
            })
            .collect();
        if !parts.is_empty() {
            w.push(format!(
                "({column} IS NOT NULL AND ({}))",
                parts.join(" OR ")
            ));
        }
    }
    let code = |name: &str| crate::facts::MADE.iter().position(|m| *m == name);
    for (column, made) in ["l.flop_made", "l.turn_made", "l.river_made"]
        .iter()
        .zip(&filter.made)
    {
        let codes: Vec<String> = made
            .iter()
            .filter_map(|name| code(name))
            .map(|i| i.to_string())
            .collect();
        if !codes.is_empty() {
            w.push(format!("{column} IN ({})", codes.join(", ")));
        }
    }
    let kickers: Vec<&str> = filter
        .kickers
        .iter()
        .filter_map(|k| match k.as_str() {
            "top" => Some("1"),
            "good" => Some("2"),
            "weak" => Some("3"),
            _ => None,
        })
        .collect();
    if !kickers.is_empty() {
        let list = kickers.join(", ");
        w.push(format!(
            "(l.flop_kicker IN ({list}) OR l.turn_kicker IN ({list}) OR l.river_kicker IN ({list}))"
        ));
    }
    let bit = |name: &str| {
        crate::facts::DRAWS
            .iter()
            .position(|d| *d == name)
            .map(|i| 1i64 << i)
    };
    for (column, draws) in ["l.flop_draws", "l.turn_draws"].iter().zip(&filter.draws) {
        let mask = draws
            .iter()
            .filter_map(|name| bit(name))
            .fold(0i64, |mask, b| mask | b);
        if mask != 0 {
            w.push(format!("({column} & {mask}) <> 0"));
        }
    }
    if !filter.vs_positions.is_empty() {
        let parts: Vec<String> = filter
            .vs_positions
            .iter()
            .map(|position| {
                let p = w.text(&format!(" {} ", position.trim()));
                format!("instr(l.vs_positions, {p}) > 0")
            })
            .collect();
        w.push(format!("({})", parts.join(" OR ")));
    }
    let sides: Vec<&str> = filter
        .position_flop
        .iter()
        .filter_map(|side| match side.as_str() {
            "ip" => Some("l.hero_ip = 1"),
            "oop" => Some("l.hero_ip = 0"),
            _ => None,
        })
        .collect();
    if !sides.is_empty() {
        w.push(format!("({})", sides.join(" OR ")));
    }
    let flop: Vec<&str> = filter
        .players_flop
        .iter()
        .filter_map(|n| match n.as_str() {
            "2" => Some("l.players_flop = 2"),
            "3" => Some("l.players_flop = 3"),
            "4plus" => Some("l.players_flop >= 4"),
            _ => None,
        })
        .collect();
    if !flop.is_empty() {
        w.push(format!("({})", flop.join(" OR ")));
    }
    // An opponent in the pot (a named one: `player_hands`) by their numbers.
    let vpip = "(SELECT sum(r.vpip) * 100.0 / max(sum(r.vpip_opp), 1) FROM player_rollups r
                 WHERE r.site = g.site AND r.player = ph.player AND r.scope = '')";
    let pfr = "(SELECT sum(r.pfr) * 100.0 / max(sum(r.pfr_opp), 1) FROM player_rollups r
                WHERE r.site = g.site AND r.player = ph.player AND r.scope = '')";
    let hands = "(SELECT coalesce(sum(r.hands), 0) FROM player_rollups r
                  WHERE r.site = g.site AND r.player = ph.player AND r.scope = '')";
    let mut conditions: Vec<String> = Vec::new();
    let types: Vec<String> = filter
        .vs_types
        .iter()
        .filter_map(|kind| match kind.as_str() {
            "fish" => Some(format!("({hands} >= 30 AND {vpip} >= 40)")),
            "reg" => Some(format!(
                "({hands} >= 30 AND {vpip} BETWEEN 15 AND 30 AND {pfr} >= {vpip} * 0.6)"
            )),
            "unknown" => Some(format!("{hands} < 30")),
            _ => None,
        })
        .collect();
    if !types.is_empty() {
        conditions.push(format!("({})", types.join(" OR ")));
    }
    if let Some(min) = filter.vs_vpip_min.filter(|v| v.is_finite()) {
        conditions.push(format!("{vpip} >= {min}"));
    }
    if let Some(max) = filter.vs_vpip_max.filter(|v| v.is_finite()) {
        conditions.push(format!("{vpip} <= {max}"));
    }
    if !conditions.is_empty() {
        w.push(format!(
            "EXISTS (SELECT 1 FROM hand_stats hs
               JOIN player_hands ph ON ph.hand_id = hs.id
               JOIN segments g ON g.id = hs.segment_id
             WHERE hs.hand_key = l.hand_key AND instr(l.vs_seats, ' ' || ph.seat || ' ') > 0
               AND {})",
            conditions.join(" AND ")
        ));
    }
    ranged(
        w,
        "l.buy_in_cents",
        filter.buy_in_min,
        filter.buy_in_max,
        100,
    );
    if let Some(bounty) = filter.bounty {
        w.push(format!("l.bounty = {}", i64::from(bounty)));
    }
    let levels: Vec<&str> = filter
        .levels
        .iter()
        .filter_map(|level| match level.as_str() {
            "1-5" => Some("l.tour_level BETWEEN 1 AND 5"),
            "6-10" => Some("l.tour_level BETWEEN 6 AND 10"),
            "11-15" => Some("l.tour_level BETWEEN 11 AND 15"),
            "16plus" => Some("l.tour_level >= 16"),
            _ => None,
        })
        .collect();
    if !levels.is_empty() {
        w.push(format!("({})", levels.join(" OR ")));
    }
}

/// The flop's three cards (`l.board`'s first 8 characters: `Kd 7c 5h`).
const FLOP_R: [&str; 3] = [
    "substr(l.board, 1, 1)",
    "substr(l.board, 4, 1)",
    "substr(l.board, 7, 1)",
];
const FLOP_S: [&str; 3] = [
    "substr(l.board, 2, 1)",
    "substr(l.board, 5, 1)",
    "substr(l.board, 8, 1)",
];
/// A rank's index, 1 for an ace ... 13 for a deuce.
fn rank_index(rank: &str) -> String {
    format!("instr('AKQJT98765432', {rank})")
}

/// The list's orders besides the newest first, each as its `ORDER BY`
/// (ties by time, newest first). The column headers of the list sort.
pub const SORTS: &[(&str, &str)] = &[
    ("oldest", "l.played_at ASC, l.hand_key ASC"),
    (
        "pot",
        "(h.big_blind IS NULL OR h.big_blind = 0), CAST(d.total_pot AS REAL) / h.big_blind DESC",
    ),
    (
        "potAsc",
        "(h.big_blind IS NULL OR h.big_blind = 0), CAST(d.total_pot AS REAL) / h.big_blind ASC",
    ),
    (
        "won",
        "(l.hero_net_bb_milli IS NULL), l.hero_net_bb_milli DESC",
    ),
    (
        "lost",
        "(l.hero_net_bb_milli IS NULL), l.hero_net_bb_milli ASC",
    ),
    ("stakes", "h.big_blind DESC"),
    ("stakesAsc", "h.big_blind ASC"),
    ("position", POSITION_ORDER),
    ("positionDesc", POSITION_ORDER_DESC),
];

/// Seats in the order the action goes preflop, early first; no hero last.
const POSITION_ORDER: &str = "(l.hero_position IS NULL), CASE l.hero_position \
     WHEN 'UTG' THEN 1 WHEN 'UTG+1' THEN 2 WHEN 'UTG+2' THEN 3 WHEN 'EP' THEN 3 WHEN 'MP' THEN 4 \
     WHEN 'MP+1' THEN 5 WHEN 'LJ' THEN 6 WHEN 'HJ' THEN 7 WHEN 'CO' THEN 8 WHEN 'BTN' THEN 9 \
     WHEN 'SB' THEN 10 WHEN 'BB' THEN 11 ELSE 12 END ASC";
const POSITION_ORDER_DESC: &str = "(l.hero_position IS NULL), CASE l.hero_position \
     WHEN 'UTG' THEN 1 WHEN 'UTG+1' THEN 2 WHEN 'UTG+2' THEN 3 WHEN 'EP' THEN 3 WHEN 'MP' THEN 4 \
     WHEN 'MP+1' THEN 5 WHEN 'LJ' THEN 6 WHEN 'HJ' THEN 7 WHEN 'CO' THEN 8 WHEN 'BTN' THEN 9 \
     WHEN 'SB' THEN 10 WHEN 'BB' THEN 11 ELSE 0 END DESC";

/// The order's `ORDER BY`, `None` for the newest first.
fn order_of(sort: Option<&str>) -> Option<&'static str> {
    let sort = sort?;
    SORTS
        .iter()
        .find(|(id, _)| *id == sort)
        .map(|(_, sql)| *sql)
}

/// The hero's two cards (`Ah Kd`) as their class (`AKo`), in SQL; `NULL`
/// for any other number of cards (Omaha) or no cards.
const HERO_CLASS_SQL: &str = "CASE WHEN length(l.hero_cards) <> 5 THEN NULL \
     WHEN substr(l.hero_cards, 1, 1) = substr(l.hero_cards, 4, 1) \
       THEN substr(l.hero_cards, 1, 1) || substr(l.hero_cards, 4, 1) \
     WHEN instr('AKQJT98765432', substr(l.hero_cards, 1, 1)) < instr('AKQJT98765432', substr(l.hero_cards, 4, 1)) \
       THEN substr(l.hero_cards, 1, 1) || substr(l.hero_cards, 4, 1) \
            || CASE WHEN substr(l.hero_cards, 2, 1) = substr(l.hero_cards, 5, 1) THEN 's' ELSE 'o' END \
     ELSE substr(l.hero_cards, 4, 1) || substr(l.hero_cards, 1, 1) \
            || CASE WHEN substr(l.hero_cards, 2, 1) = substr(l.hero_cards, 5, 1) THEN 's' ELSE 'o' END END";

/// The board's ranks without suits or spaces (`Kd 7c 5h` as `K75`).
const BOARD_RANKS_SQL: &str = "replace(replace(replace(replace(replace(l.board, ' ', ''), 's', ''), 'h', ''), 'd', ''), 'c', '')";

/// Where the next page starts: the last row of the page before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandCursor {
    /// `''` for a hand without a `played_at`.
    pub played_at: String,
    pub hand_key: String,
    /// For an order other than the newest first: the rows read so far (the
    /// next page is an offset into that order).
    pub offset: Option<u32>,
}

/// One row of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandRow {
    pub hand_key: String,
    pub site: String,
    pub site_hand_id: String,
    pub played_at: Option<String>,
    pub game_format: String,
    pub variant: String,
    pub limit_type: String,
    pub currency: String,
    /// `game.unit.symbol`: `$`, `''` for chips.
    pub currency_symbol: String,
    /// Minor units per display unit: 100 for cash, 1 for chips.
    pub minor_units: i64,
    pub small_blind: i64,
    pub big_blind: i64,
    pub ante: i64,
    pub max_seats: i64,
    pub table_name: Option<String>,
    /// The hero's position and cards (empty when not seen), when there is
    /// a hero.
    pub hero_position: Option<String>,
    pub hero_cards: Vec<String>,
    /// The primary runout.
    pub board: Vec<String>,
    /// The hero's net, minor units, and in thousandths of a big blind.
    pub hero_net: Option<i64>,
    pub hero_net_bb_milli: Option<i64>,
    /// All in with cards to come.
    pub all_in: bool,
    /// The all-in EV result, where it differs from the result.
    pub ev_net: Option<i64>,
    pub ev_net_bb_milli: Option<i64>,
    /// Queued for the background EV pass.
    pub ev_pending: bool,
    pub pot_type: String,
    pub total_pot: i64,
    /// The hand reached showdown.
    pub showdown: bool,
    pub has_note: bool,
    pub tags: Vec<String>,
}

impl HandRow {
    /// The cursor of the page after this row.
    pub fn cursor(&self) -> HandCursor {
        HandCursor {
            played_at: self.played_at.clone().unwrap_or_default(),
            hand_key: self.hand_key.clone(),
            offset: None,
        }
    }
}

/// A page of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandPage {
    pub rows: Vec<HandRow>,
    /// Where the next page starts; `None` at the end.
    pub next: Option<HandCursor>,
}

/// A chip's value and its count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetCount {
    pub value: String,
    pub count: u64,
}

/// A stake's chip: its key, count, and what its label is made of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StakeFacet {
    /// `segments.stake`: `USD:200`, `chips`.
    pub value: String,
    pub count: u64,
    /// A hand of the stake's blinds and unit (`None` for `chips`, whose
    /// blinds rise).
    pub currency: Option<String>,
    pub currency_symbol: Option<String>,
    pub minor_units: Option<i64>,
    pub small_blind: Option<i64>,
    pub big_blind: Option<i64>,
}

/// The counts beside the filter chips. Each group lists every value the
/// hands in the date range have (with the notes and tags filter applied),
/// counted as if the group's own selection were left out of the filter.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandFacets {
    /// The hands the whole filter matches.
    pub total: u64,
    pub sites: Vec<FacetCount>,
    pub formats: Vec<FacetCount>,
    pub variants: Vec<FacetCount>,
    pub limits: Vec<FacetCount>,
    pub sizes: Vec<FacetCount>,
    pub stakes: Vec<StakeFacet>,
    /// `''` is a hero without a position, or no hero.
    pub positions: Vec<FacetCount>,
    pub pot_types: Vec<FacetCount>,
    /// [`RESULTS`]; hands without a hero are not counted.
    pub results: Vec<FacetCount>,
    /// [`STACK_DEPTHS`]; hands without a hero are not counted.
    pub stacks: Vec<FacetCount>,
    /// `1` all in, `0` not.
    pub all_in: Vec<FacetCount>,
}

/// A hand's note and tags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Annotations {
    pub note: Option<String>,
    pub tags: Vec<String>,
}

/// A saved filter: its name and the filter as the screen wrote it (JSON).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedFilter {
    pub id: i64,
    pub name: String,
    pub filter: String,
    pub created_at: i64,
}

/* ------------------------------------------------------------ the query - */

/// A segment's dimensions, as `segments` stores them.
#[derive(Debug, Clone)]
pub(crate) struct SegmentDims {
    pub(crate) site: String,
    pub(crate) format: String,
    pub(crate) variant: String,
    pub(crate) limit: String,
    pub(crate) size: String,
    pub(crate) stake: String,
}

pub(crate) fn segments(conn: &Connection) -> Result<HashMap<i64, SegmentDims>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, site, game_format, variant, limit_type, size_class, stake FROM segments",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            SegmentDims {
                site: row.get(1)?,
                format: row.get(2)?,
                variant: row.get(3)?,
                limit: row.get(4)?,
                size: row.get(5)?,
                stake: row.get(6)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// `values` is empty ("any") or holds `value`.
pub(crate) fn allows(values: &[String], value: &str) -> bool {
    values.is_empty() || values.iter().any(|v| v == value)
}

impl HandFilter {
    fn segment_filtered(&self) -> bool {
        !(self.sites.is_empty()
            && self.formats.is_empty()
            && self.variants.is_empty()
            && self.limits.is_empty()
            && self.sizes.is_empty()
            && self.stakes.is_empty())
    }

    fn segment_allows(&self, dims: &SegmentDims) -> bool {
        allows(&self.sites, &dims.site)
            && allows(&self.formats, &dims.format)
            && allows(&self.variants, &dims.variant)
            && allows(&self.limits, &dims.limit)
            && allows(&self.sizes, &dims.size)
            && allows(&self.stakes, &dims.stake)
    }
}

/// `SQL` and its parameters, built clause by clause.
#[derive(Debug, Default)]
struct Where {
    clauses: Vec<String>,
    params: Vec<Value>,
}

impl Where {
    fn param(&mut self, value: Value) -> String {
        self.params.push(value);
        format!("?{}", self.params.len())
    }

    fn text(&mut self, value: &str) -> String {
        self.param(Value::Text(value.to_owned()))
    }

    fn push(&mut self, clause: String) {
        self.clauses.push(clause);
    }

    /// `column IN (...)` over text values.
    fn in_text(&mut self, column: &str, values: &[String]) {
        let list: Vec<String> = values.iter().map(|value| self.text(value)).collect();
        self.push(format!("{column} IN ({})", list.join(", ")));
    }

    fn sql(&self) -> String {
        if self.clauses.is_empty() {
            "1".to_owned()
        } else {
            self.clauses.join(" AND ")
        }
    }
}

/// The SQL of the hero's result (`''`: no hero).
const RESULT_SQL: &str = "CASE WHEN l.hero_net IS NULL THEN '' WHEN l.hero_net > 0 THEN 'won' \
                          WHEN l.hero_net < 0 THEN 'lost' ELSE 'even' END";

/// The rows a query goes through, `l` being `hand_list`. With a player,
/// from their entries in `player_hands` (villains of rooms with real
/// names) in the player's room to the list rows of those hands; with
/// a note or tag filter, from the user's (small) table to the list rows of
/// its hands; both sorted afterwards. Otherwise the list in its order.
/// Measured at 500k hands, probing the notes for every row took 180 ms,
/// the tags 350 ms. The note and tag clauses stay in [`base_clauses`], so
/// a player and a tag filter together are both applied.
fn source(filter: &HandFilter, w: &mut Where) -> String {
    if let Some(player) = &filter.player {
        let name = w.text(&player.player);
        let site = w.text(&player.site);
        return format!(
            "FROM player_hands ps
             CROSS JOIN hand_stats ks ON ks.id = ps.hand_id AND ps.player = {name}
             CROSS JOIN segments pg ON pg.id = ks.segment_id AND pg.site = {site}
             CROSS JOIN hand_list l
               ON l.played_at = coalesce(ks.played_at, '') AND l.hand_key = ks.hand_key"
        );
    }
    let driver = if filter.has_note == Some(true) {
        Some("SELECT hand_key FROM hand_notes".to_owned())
    } else if filter.tags.is_empty() {
        None
    } else {
        let list: Vec<String> = filter.tags.iter().map(|tag| w.text(tag)).collect();
        Some(format!(
            "SELECT DISTINCT hand_key FROM hand_tags WHERE tag IN ({})",
            list.join(", ")
        ))
    };
    match driver {
        None => "FROM hand_list l".to_owned(),
        Some(keys) => format!(
            "FROM ({keys}) k
             CROSS JOIN hand_stats ks ON ks.hand_key = k.hand_key
             CROSS JOIN hand_list l
               ON l.played_at = coalesce(ks.played_at, '') AND l.hand_key = k.hand_key"
        ),
    }
}

/// The date range, notes and tags: what the counts are taken under.
fn base_clauses(filter: &HandFilter, w: &mut Where) {
    if let Some(from) = &filter.from {
        let p = w.text(from);
        // '' (no `played_at`) sorts first: any bound leaves it out.
        w.push(format!("l.played_at >= {p} AND l.played_at <> ''"));
    }
    if let Some(to) = &filter.to {
        let p = w.text(to);
        w.push(format!("l.played_at < {p} AND l.played_at <> ''"));
    }
    match filter.has_note {
        Some(true) => {
            w.push("EXISTS (SELECT 1 FROM hand_notes n WHERE n.hand_key = l.hand_key)".to_owned());
        }
        Some(false) => w.push(
            "NOT EXISTS (SELECT 1 FROM hand_notes n WHERE n.hand_key = l.hand_key)".to_owned(),
        ),
        None => {}
    }
    if !filter.tags.is_empty() {
        let list: Vec<String> = filter.tags.iter().map(|tag| w.text(tag)).collect();
        w.push(format!(
            "EXISTS (SELECT 1 FROM hand_tags t WHERE t.hand_key = l.hand_key AND t.tag IN ({}))",
            list.join(", ")
        ));
    }
}

/// Every clause of `filter`. `None`: nothing can match (no segment does).
fn clauses(filter: &HandFilter, segments: &HashMap<i64, SegmentDims>, w: &mut Where) -> Option<()> {
    base_clauses(filter, w);
    if filter.segment_filtered() {
        let mut ids: Vec<i64> = segments
            .iter()
            .filter(|(_, dims)| filter.segment_allows(dims))
            .map(|(id, _)| *id)
            .collect();
        if ids.is_empty() {
            return None;
        }
        ids.sort_unstable();
        let list: Vec<String> = ids.iter().map(ToString::to_string).collect();
        w.push(format!("l.segment_id IN ({})", list.join(", ")));
    }
    if !filter.positions.is_empty() {
        w.in_text("l.hero_position", &filter.positions);
    }
    if !filter.pot_types.is_empty() {
        w.in_text("l.pot_type", &filter.pot_types);
    }
    if !filter.results.is_empty() {
        w.in_text(RESULT_SQL, &filter.results);
    }
    if !filter.stacks.is_empty() {
        let ranges: Vec<String> = STACK_DEPTHS
            .iter()
            .filter(|(id, _, _)| filter.stacks.iter().any(|s| s == id))
            .map(|(_, from, below)| match below {
                Some(below) => format!(
                    "(l.hero_stack_bb_tenths >= {from} AND l.hero_stack_bb_tenths < {below})"
                ),
                None => format!("l.hero_stack_bb_tenths >= {from}"),
            })
            .collect();
        if ranges.is_empty() {
            return None;
        }
        w.push(format!("({})", ranges.join(" OR ")));
    }
    if let Some(all_in) = filter.all_in {
        w.push(format!("l.all_in = {}", i64::from(all_in)));
    }
    search_clauses(filter, w);
    Some(())
}

/// The searches: the hero's hand (classes or cards), the board (cards or
/// ranks), a player by name, the showdown.
fn search_clauses(filter: &HandFilter, w: &mut Where) {
    if !filter.hero_classes.is_empty() {
        w.in_text(HERO_CLASS_SQL, &filter.hero_classes);
    }
    for card in &filter.hero_cards {
        let p = w.text(&format!(" {} ", card.trim()));
        w.push(format!(
            "instr(' ' || coalesce(l.hero_cards, '') || ' ', {p}) > 0"
        ));
    }
    for card in &filter.board {
        let p = w.text(&format!(" {} ", card.trim()));
        w.push(format!("instr(' ' || l.board || ' ', {p}) > 0"));
    }
    if !filter.board_ranks.is_empty() {
        // A rank asked for twice (a paired board) must be there twice.
        let mut wanted: Vec<(String, usize)> = Vec::new();
        for rank in &filter.board_ranks {
            let rank = rank.trim().to_uppercase();
            if rank.len() != 1 {
                continue;
            }
            match wanted.iter_mut().find(|(r, _)| *r == rank) {
                Some((_, n)) => *n += 1,
                None => wanted.push((rank, 1)),
            }
        }
        for (rank, n) in wanted {
            let p = w.text(&rank);
            w.push(format!(
                "length({BOARD_RANKS_SQL}) - length(replace({BOARD_RANKS_SQL}, {p}, '')) >= {n}"
            ));
        }
    }
    if let Some(name) = filter
        .player_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        let p = w.text(name);
        w.push(format!(
            "EXISTS (SELECT 1 FROM player_hands ph CROSS JOIN hand_stats hs ON hs.id = ph.hand_id \
             WHERE hs.hand_key = l.hand_key AND ph.player = {p})"
        ));
    }
    if let Some(showdown) = filter.showdown {
        w.push(format!("l.showdown = {}", i64::from(showdown)));
    }
    builder_clauses(filter, w);
}

/// The filter builder's groups (V1, 2026-11-05): the hero's actions, the
/// flop's texture, the players and conditions, the time, the stacks and
/// results as ranges, the analysis, the cards seen.
fn builder_clauses(filter: &HandFilter, w: &mut Where) {
    for group in &filter.acts {
        let mask = group
            .iter()
            .filter_map(|name| act_bit(name))
            .fold(0i64, |mask, bit| mask | bit);
        if mask != 0 {
            w.push(format!("(l.hero_acts & {mask}) <> 0"));
        }
    }
    let flop = "length(l.board) >= 8";
    let [r1, r2, r3] = FLOP_R;
    let [s1, s2, s3] = FLOP_S;
    let any_of = |w: &mut Where, values: &[String], case: &dyn Fn(&str) -> Option<String>| {
        let parts: Vec<String> = values.iter().filter_map(|value| case(value)).collect();
        if !parts.is_empty() {
            w.push(format!("({flop} AND ({}))", parts.join(" OR ")));
        }
    };
    any_of(w, &filter.flop_suits, &|value| match value {
        "monotone" => Some(format!("{s1} = {s2} AND {s2} = {s3}")),
        "twoTone" => Some(format!(
            "NOT ({s1} = {s2} AND {s2} = {s3}) AND ({s1} = {s2} OR {s2} = {s3} OR {s1} = {s3})"
        )),
        "rainbow" => Some(format!("{s1} <> {s2} AND {s2} <> {s3} AND {s1} <> {s3}")),
        _ => None,
    });
    any_of(w, &filter.flop_pairing, &|value| match value {
        "trips" => Some(format!("{r1} = {r2} AND {r2} = {r3}")),
        "paired" => Some(format!(
            "NOT ({r1} = {r2} AND {r2} = {r3}) AND ({r1} = {r2} OR {r2} = {r3} OR {r1} = {r3})"
        )),
        "unpaired" => Some(format!("{r1} <> {r2} AND {r2} <> {r3} AND {r1} <> {r3}")),
        _ => None,
    });
    let (i1, i2, i3) = (rank_index(r1), rank_index(r2), rank_index(r3));
    let high = format!("min({i1}, {i2}, {i3})");
    any_of(w, &filter.flop_high, &|value| match value {
        "A" | "K" | "Q" | "J" | "T" => {
            Some(format!("{high} = {}", rank_index(&format!("'{value}'"))))
        }
        "low" => Some(format!("{high} >= 6")),
        _ => None,
    });
    // Three different ranks within five (A also low with 2-5): a straight
    // is possible with two more cards.
    let low = |i: &str| format!("(CASE WHEN {i} = 1 THEN 14 ELSE {i} END)");
    let span = format!("max({i1}, {i2}, {i3}) - min({i1}, {i2}, {i3})");
    let wheel = format!(
        "max({}, {}, {}) - min({}, {}, {})",
        low(&i1),
        low(&i2),
        low(&i3),
        low(&i1),
        low(&i2),
        low(&i3)
    );
    let distinct = format!("{r1} <> {r2} AND {r2} <> {r3} AND {r1} <> {r3}");
    let straight = format!("({distinct} AND ({span} <= 4 OR {wheel} <= 4))");
    any_of(w, &filter.flop_connect, &|value| match value {
        "straight" => Some(straight.clone()),
        "noStraight" => Some(format!("NOT {straight}")),
        _ => None,
    });
    let hand =
        |column: &str| format!("(SELECT {column} FROM hand_stats WHERE hand_key = l.hand_key)");
    let players: Vec<String> = filter
        .players
        .iter()
        .filter_map(|value| match value.as_str() {
            "7plus" => Some(format!("{} >= 7", hand("player_count"))),
            n => n
                .parse::<u8>()
                .ok()
                .map(|n| format!("{} = {n}", hand("player_count"))),
        })
        .collect();
    if !players.is_empty() {
        w.push(format!("({})", players.join(" OR ")));
    }
    for condition in &filter.conditions {
        match condition.as_str() {
            "straddle" => w.push(format!("{} = 1", hand("has_straddle"))),
            "runItTwice" => w.push(format!("{} = 1", hand("is_run_it_twice"))),
            "ante" => w.push(format!(
                "({} = 1 OR EXISTS (SELECT 1 FROM hands a WHERE a.hand_key = l.hand_key AND a.ante > 0))",
                hand("is_big_blind_ante")
            )),
            _ => {}
        }
    }
    // The reader's local time of a UTC `played_at`.
    let local = format!(
        "datetime(l.played_at, '{:+} minutes')",
        filter.utc_offset_minutes
    );
    let days: Vec<String> = filter
        .weekdays
        .iter()
        .filter(|day| (1..=7).contains(*day))
        .map(|day| format!("'{}'", day % 7))
        .collect();
    if !days.is_empty() {
        w.push(format!(
            "(l.played_at <> '' AND strftime('%w', {local}) IN ({}))",
            days.join(", ")
        ));
    }
    let parts: Vec<String> = filter
        .day_parts
        .iter()
        .filter_map(|part| {
            let (from, to) = match part.as_str() {
                "night" => (0, 6),
                "morning" => (6, 12),
                "afternoon" => (12, 18),
                "evening" => (18, 24),
                _ => return None,
            };
            Some(format!(
                "CAST(strftime('%H', {local}) AS INTEGER) BETWEEN {from} AND {}",
                to - 1
            ))
        })
        .collect();
    if !parts.is_empty() {
        w.push(format!("(l.played_at <> '' AND ({}))", parts.join(" OR ")));
    }
    if let Some(n) = filter.last_hands.filter(|n| *n > 0) {
        w.push(format!(
            "l.played_at >= coalesce((SELECT played_at FROM hand_list ORDER BY played_at DESC, hand_key DESC LIMIT 1 OFFSET {}), '')",
            n - 1
        ));
    }
    // Big blinds as typed, scaled in SQL (tenths, thousandths of a big blind).
    if let Some(min) = filter.hero_stack_min.filter(|v| v.is_finite()) {
        w.push(format!("l.hero_stack_bb_tenths >= {min} * 10"));
    }
    if let Some(max) = filter.hero_stack_max.filter(|v| v.is_finite()) {
        w.push(format!("l.hero_stack_bb_tenths <= {max} * 10"));
    }
    if let Some(min) = filter.net_min.filter(|v| v.is_finite()) {
        w.push(format!("l.hero_net_bb_milli >= {min} * 1000"));
    }
    if let Some(max) = filter.net_max.filter(|v| v.is_finite()) {
        w.push(format!("l.hero_net_bb_milli <= {max} * 1000"));
    }
    pot_clauses(filter, w);

    let graded = |rank: i64| {
        format!(
            "EXISTS (SELECT 1 FROM decision_analysis g WHERE g.hand_key = l.hand_key AND g.grade_rank = {rank})"
        )
    };
    let analysed = "EXISTS (SELECT 1 FROM hand_analysis a WHERE a.hand_key = l.hand_key AND a.status <> 'not-analysed')";
    let grades: Vec<String> = filter
        .grades
        .iter()
        .filter_map(|grade| match grade.as_str() {
            "blunder" => Some(graded(5)),
            "mistake" => Some(graded(4)),
            "inaccurate" => Some(graded(3)),
            "clean" => Some(format!(
                "({analysed} AND NOT EXISTS (SELECT 1 FROM decision_analysis g WHERE g.hand_key = l.hand_key AND g.grade_rank >= 3))"
            )),
            "notAnalysed" => Some(format!("NOT {analysed}")),
            _ => None,
        })
        .collect();
    if !grades.is_empty() {
        w.push(format!("({})", grades.join(" OR ")));
    }
    if let Some(min) = filter.ev_loss_min.filter(|v| v.is_finite()) {
        w.push(format!(
            "EXISTS (SELECT 1 FROM hand_analysis a WHERE a.hand_key = l.hand_key AND a.ev_loss_bb >= {min})"
        ));
    }
    facts_clauses(filter, w);
    if let Some(known) = filter.known_cards {
        let seen = "EXISTS (SELECT 1 FROM hand_stats d JOIN seat_stats s ON s.hand_id = d.id
                     WHERE d.hand_key = l.hand_key AND s.is_hero = 0 AND s.hole_cards <> '')";
        w.push(if known {
            seen.to_owned()
        } else {
            format!("NOT {seen}")
        });
    }
}

/// The columns of a [`HandRow`], `l` being `hand_list`.
const ROW_COLUMNS: &str = "l.hand_key, h.site, h.site_hand_id, h.played_at, h.game_format,
       h.variant, h.limit_type, h.currency, l.currency_symbol, d.currency_minor_units,
       h.small_blind, h.big_blind, h.ante, h.max_seats, h.table_name, l.hero_position,
       l.hero_cards, l.board, l.hero_net, l.hero_net_bb_milli, l.all_in, e.ev_net,
       e.ev_net_bb_milli, p.hand_key IS NOT NULL, l.pot_type, d.total_pot,
       l.showdown, n.hand_key IS NOT NULL,
       (SELECT group_concat(tag, char(31) ORDER BY tag) FROM hand_tags
         WHERE hand_key = l.hand_key)";

/// The tables a row's columns come from, read per row of the page only
/// (left joins: `hand_list` stays the outer loop).
const ROW_JOINS: &str = "LEFT JOIN hands h ON h.hand_key = l.hand_key
     LEFT JOIN hand_stats d ON d.hand_key = l.hand_key
     LEFT JOIN ev_rows e ON e.hand_key = l.hand_key
     LEFT JOIN ev_pending p ON p.hand_key = l.hand_key
     LEFT JOIN hand_notes n ON n.hand_key = l.hand_key";

fn cards(text: Option<String>) -> Vec<String> {
    text.map(|text| text.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

fn row_from(row: &Row<'_>) -> rusqlite::Result<HandRow> {
    let hero_cards: Option<String> = row.get(16)?;
    let board: String = row.get(17)?;
    let tags: Option<String> = row.get(28)?;
    Ok(HandRow {
        hand_key: row.get(0)?,
        site: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        site_hand_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        played_at: row.get(3)?,
        game_format: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        variant: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        limit_type: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        currency: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        currency_symbol: row.get(8)?,
        minor_units: row.get::<_, Option<i64>>(9)?.unwrap_or(1),
        small_blind: row.get::<_, Option<i64>>(10)?.unwrap_or(0),
        big_blind: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
        ante: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
        max_seats: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
        table_name: row.get(14)?,
        hero_position: row.get(15)?,
        hero_cards: cards(hero_cards),
        board: cards(Some(board)),
        hero_net: row.get(18)?,
        hero_net_bb_milli: row.get(19)?,
        all_in: row.get(20)?,
        ev_net: row.get(21)?,
        ev_net_bb_milli: row.get(22)?,
        ev_pending: row.get(23)?,
        pot_type: row.get(24)?,
        total_pot: row.get::<_, Option<i64>>(25)?.unwrap_or(0),
        showdown: row.get(26)?,
        has_note: row.get(27)?,
        tags: tags
            .map(|tags| tags.split('\u{1f}').map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

/// The list rows of `keys`, in the list's order (newest first). Unknown
/// keys, and hands without statistics rows, are left out.
fn rows_of(conn: &Connection, keys: &[String]) -> Result<Vec<HandRow>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut w = Where::default();
    let list: Vec<String> = keys.iter().map(|key| w.text(key)).collect();
    let sql = format!(
        "SELECT {ROW_COLUMNS}
         FROM hand_stats k
         CROSS JOIN hand_list l ON l.played_at = coalesce(k.played_at, '') AND l.hand_key = k.hand_key
         {ROW_JOINS}
         WHERE k.hand_key IN ({})
         ORDER BY l.played_at DESC, l.hand_key DESC",
        list.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(w.params.iter()), row_from)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The few distinct texts of a column (positions, pot types), numbered as
/// they are first seen, so the facets' pass allocates per value, not per row.
#[derive(Default)]
struct Names {
    list: Vec<String>,
}

impl Names {
    fn of(&mut self, text: &str) -> usize {
        match self.list.iter().position(|name| name == text) {
            Some(i) => i,
            None => {
                self.list.push(text.to_owned());
                self.list.len() - 1
            }
        }
    }
}

/// What the facets' pass counts by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct GroupKey {
    segment_id: i64,
    position: usize,
    pot_type: usize,
    all_in: bool,
    result: &'static str,
    stack: &'static str,
}

/// The stack depth group of a stack in tenths of a big blind.
fn stack_depth(stack: i64) -> &'static str {
    STACK_DEPTHS
        .iter()
        .find(|(_, from, below)| stack >= *from && below.is_none_or(|below| stack < below))
        .map_or("", |(id, _, _)| id)
}

/// One counted group of the facets' pass.
struct Group {
    segment_id: i64,
    position: String,
    pot_type: String,
    all_in: String,
    result: String,
    stack: String,
    count: u64,
    sample: String,
    symbol: String,
}

/// Count `value` into `counts` (and list it with 0 when `counted` is false).
fn tally(counts: &mut BTreeMap<String, u64>, value: &str, count: u64, counted: bool) {
    let entry = counts.entry(value.to_owned()).or_insert(0);
    if counted {
        *entry += count;
    }
}

fn facet_list(counts: BTreeMap<String, u64>) -> Vec<FacetCount> {
    counts
        .into_iter()
        .map(|(value, count)| FacetCount { value, count })
        .collect()
}

impl Reader {
    /// A page of the list: the hands `filter` matches, newest first, after
    /// `after` (the first page: `None`), at most `limit` (capped at
    /// [`PAGE_MAX`]).
    pub fn hand_page(
        &self,
        filter: &HandFilter,
        after: Option<&HandCursor>,
        limit: u32,
    ) -> Result<HandPage> {
        let limit = limit.clamp(1, PAGE_MAX);
        self.with(|conn| {
            let segments = segments(conn)?;
            let mut w = Where::default();
            let from = source(filter, &mut w);
            if clauses(filter, &segments, &mut w).is_none() {
                return Ok(HandPage {
                    rows: Vec::new(),
                    next: None,
                });
            }
            // The newest first pages by the last row (a hand that arrives
            // does not move the pages after it); another order by an offset.
            let order = order_of(filter.sort.as_deref());
            let skip = if order.is_some() {
                after.and_then(|after| after.offset).unwrap_or(0)
            } else {
                0
            };
            if let (None, Some(after)) = (order, after) {
                let played_at = w.text(&after.played_at);
                let hand_key = w.text(&after.hand_key);
                w.push(format!(
                    "(l.played_at, l.hand_key) < ({played_at}, {hand_key})"
                ));
            }
            // One more than the page: whether there is a next page.
            let n = w.param(Value::Integer(i64::from(limit) + 1));
            let by = order.map_or_else(
                || "l.played_at DESC, l.hand_key DESC".to_owned(),
                |sql| format!("{sql}, l.played_at DESC, l.hand_key DESC"),
            );
            let sql = format!(
                "SELECT {ROW_COLUMNS}
                 {from}
                 {ROW_JOINS}
                 WHERE {}
                 ORDER BY {by}
                 LIMIT {n} OFFSET {skip}",
                w.sql()
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt
                .query_map(params_from_iter(w.params.iter()), row_from)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
            rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            let next = if more {
                rows.last().map(|row| HandCursor {
                    offset: order.map(|_| skip + limit),
                    ..row.cursor()
                })
            } else {
                None
            };
            Ok(HandPage { rows, next })
        })
    }

    /// The counts beside the filter chips (see [`HandFacets`]): one pass
    /// over the rows of the date range.
    pub fn hand_facets(&self, filter: &HandFilter) -> Result<HandFacets> {
        self.with(|conn| {
            let segments = segments(conn)?;
            let mut w = Where::default();
            let from = source(filter, &mut w);
            base_clauses(filter, &mut w);
            // The searches narrow every count (they have none of their own).
            search_clauses(filter, &mut w);
            // Summed here rather than by a `GROUP BY` over expressions:
            // measured at 500k hands, SQLite's grouping (a sort) took four
            // times the scan.
            let sql = format!(
                "SELECT l.segment_id, l.hero_position, l.pot_type, l.all_in, l.hero_net,
                        l.hero_stack_bb_tenths, l.hand_key, l.currency_symbol
                 {from}
                 WHERE {}",
                w.sql()
            );
            // The pass depends on the date range, notes and tags only; the
            // chips are counted from its groups. A chip clicked with the
            // same range and nothing committed since reuses them.
            let version: i64 = conn.query_row("PRAGMA data_version", [], |row| row.get(0))?;
            let key = FacetKey {
                connection: std::ptr::from_ref(conn) as usize,
                version,
                query: format!("{sql} {:?}", w.params),
            };
            let cached = self.facet_cache().get(&key);
            let groups = match cached {
                Some(groups) => groups,
                None => {
                    let groups = std::sync::Arc::new(group_pass(conn, &sql, &w.params)?);
                    self.facet_cache().put(key, std::sync::Arc::clone(&groups));
                    groups
                }
            };
            facets(conn, filter, &segments, &groups)
        })
    }

    /// The list rows of these hands (the palette's results, a hand opened
    /// by its key), newest first.
    pub fn hand_rows(&self, keys: &[String]) -> Result<Vec<HandRow>> {
        self.with(|conn| rows_of(conn, keys))
    }

    /// "Go to hand": the hands whose room id (`site_hand_id`) starts with
    /// `query`, or whose `hand_key` is `query`; at most `limit`.
    pub fn find_hands(&self, query: &str, limit: u32) -> Result<Vec<HandRow>> {
        let query = query.trim().trim_start_matches('#');
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = i64::from(limit.clamp(1, PAGE_MAX));
        self.with(|conn| {
            let mut keys: Vec<String> = Vec::new();
            if query.contains(':')
                && conn
                    .prepare_cached("SELECT 1 FROM hands WHERE hand_key = ?1")?
                    .exists([query])?
            {
                keys.push(query.to_owned());
            }
            // A prefix as a range of the index: every id that starts with
            // `query` sorts from `query` to `query` + the last character.
            let below = format!("{query}\u{10ffff}");
            let mut stmt = conn.prepare_cached(
                "SELECT hand_key FROM hand_list
                 WHERE site_hand_id >= ?1 AND site_hand_id < ?2
                 ORDER BY site_hand_id = ?1 DESC, site_hand_id
                 LIMIT ?3",
            )?;
            for key in stmt.query_map(params![query, below, limit], |row| row.get(0))? {
                keys.push(key?);
            }
            keys.dedup();
            let rows = rows_of(conn, &keys)?;
            // Exact ids first, then as found.
            let mut by_key: HashMap<String, HandRow> = rows
                .into_iter()
                .map(|row| (row.hand_key.clone(), row))
                .collect();
            Ok(keys.iter().filter_map(|key| by_key.remove(key)).collect())
        })
    }

    /// A hand's note and tags.
    pub fn hand_annotations(&self, hand_key: &str) -> Result<Annotations> {
        self.with(|conn| {
            let note = conn
                .prepare_cached("SELECT note FROM hand_notes WHERE hand_key = ?1")?
                .query_row([hand_key], |row| row.get(0))
                .optional()?;
            let tags = conn
                .prepare_cached("SELECT tag FROM hand_tags WHERE hand_key = ?1 ORDER BY tag")?
                .query_map([hand_key], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Annotations { note, tags })
        })
    }

    /// Every tag in use, with how many hands have it, by name.
    pub fn hand_tags(&self) -> Result<Vec<FacetCount>> {
        self.with(|conn| {
            let mut stmt = conn
                .prepare_cached("SELECT tag, count(*) FROM hand_tags GROUP BY tag ORDER BY tag")?;
            let rows = stmt.query_map([], |row| {
                Ok(FacetCount {
                    value: row.get(0)?,
                    count: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// Hands with a note.
    pub fn noted_hands(&self) -> Result<u64> {
        self.with(|conn| {
            let n: i64 = conn.query_row("SELECT count(*) FROM hand_notes", [], |row| row.get(0))?;
            u64::try_from(n).map_err(|_| Error::OutOfRange("count"))
        })
    }

    /// A screen's saved filters, by name.
    pub fn saved_filters(&self, screen: &str) -> Result<Vec<SavedFilter>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, name, filter, created_at FROM saved_filters
                 WHERE screen = ?1 ORDER BY name COLLATE NOCASE, id",
            )?;
            let rows = stmt.query_map([screen], |row| {
                Ok(SavedFilter {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    filter: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

/// The facets' pass: the rows of `sql` counted by group.
fn group_pass(conn: &Connection, sql: &str, params: &[Value]) -> Result<Vec<Group>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    let mut names = Names::default();
    let mut counts: HashMap<GroupKey, u64> = HashMap::new();
    let mut samples: HashMap<i64, (String, String)> = HashMap::new();
    while let Some(row) = rows.next()? {
        let segment_id: i64 = row.get(0)?;
        let net: Option<i64> = row.get(4)?;
        let stack: Option<i64> = row.get(5)?;
        let key = GroupKey {
            segment_id,
            position: names.of(row
                .get_ref(1)?
                .as_str_or_null()
                .map_err(rusqlite::Error::from)?
                .unwrap_or("")),
            pot_type: names.of(row.get_ref(2)?.as_str().map_err(rusqlite::Error::from)?),
            all_in: row.get(3)?,
            result: match net {
                None => "",
                Some(net) if net > 0 => RESULTS[0],
                Some(net) if net < 0 => RESULTS[1],
                Some(_) => RESULTS[2],
            },
            stack: stack.map_or("", stack_depth),
        };
        *counts.entry(key).or_insert(0) += 1;
        if let std::collections::hash_map::Entry::Vacant(entry) = samples.entry(segment_id) {
            entry.insert((row.get(6)?, row.get(7)?));
        }
    }
    let groups = counts
        .into_iter()
        .map(|(key, count)| {
            let (sample, symbol) = samples.get(&key.segment_id).cloned().unwrap_or_default();
            Group {
                segment_id: key.segment_id,
                position: names.list[key.position].clone(),
                pot_type: names.list[key.pot_type].clone(),
                all_in: if key.all_in { "1" } else { "0" }.to_owned(),
                result: key.result.to_owned(),
                stack: key.stack.to_owned(),
                count,
                sample,
                symbol,
            }
        })
        .collect();
    Ok(groups)
}

/// What a facets' pass is cached under: the read connection, its
/// `data_version` (it changes when another connection commits) and the
/// query with its parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FacetKey {
    connection: usize,
    version: i64,
    query: String,
}

/// The last few facets' passes (`Reader::hand_facets`).
#[derive(Default)]
pub(crate) struct FacetCache {
    entries: Vec<(FacetKey, std::sync::Arc<Vec<Group>>)>,
}

impl std::fmt::Debug for FacetCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FacetCache")
            .field("entries", &self.entries.len())
            .finish()
    }
}

impl FacetCache {
    /// Passes kept: one per read connection and a couple of date ranges.
    const SIZE: usize = 8;

    fn get(&mut self, key: &FacetKey) -> Option<std::sync::Arc<Vec<Group>>> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        let entry = self.entries.remove(at);
        let groups = std::sync::Arc::clone(&entry.1);
        self.entries.push(entry);
        Some(groups)
    }

    fn put(&mut self, key: FacetKey, groups: std::sync::Arc<Vec<Group>>) {
        // Entries of the same connection at an older version are stale.
        self.entries
            .retain(|(k, _)| k.connection != key.connection || k.version == key.version);
        if self.entries.len() >= Self::SIZE {
            self.entries.remove(0);
        }
        self.entries.push((key, groups));
    }
}

/// The counts of every group from the facets' pass.
fn facets(
    conn: &Connection,
    filter: &HandFilter,
    segments: &HashMap<i64, SegmentDims>,
    groups: &[Group],
) -> Result<HandFacets> {
    const DIMS: usize = 11;
    let mut counts: [BTreeMap<String, u64>; DIMS] = Default::default();
    // A sample hand and the unit's symbol per stake, for its label.
    let mut stake_samples: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut total = 0;
    for group in groups {
        let Some(dims) = segments.get(&group.segment_id) else {
            continue;
        };
        let values: [&str; DIMS] = [
            &dims.site,
            &dims.format,
            &dims.variant,
            &dims.limit,
            &dims.size,
            &dims.stake,
            &group.position,
            &group.pot_type,
            &group.result,
            &group.stack,
            &group.all_in,
        ];
        let all_in = filter.all_in.map(|all_in| i64::from(all_in).to_string());
        let matches: [bool; DIMS] = [
            allows(&filter.sites, values[0]),
            allows(&filter.formats, values[1]),
            allows(&filter.variants, values[2]),
            allows(&filter.limits, values[3]),
            allows(&filter.sizes, values[4]),
            allows(&filter.stakes, values[5]),
            allows(&filter.positions, values[6]),
            allows(&filter.pot_types, values[7]),
            allows(&filter.results, values[8]),
            allows(&filter.stacks, values[9]),
            all_in.as_deref().is_none_or(|all_in| all_in == values[10]),
        ];
        let misses = matches.iter().filter(|m| !**m).count();
        if misses == 0 {
            total += group.count;
        }
        for (dim, value) in values.iter().enumerate() {
            // Counted when every other group matches.
            let counted = misses == 0 || (misses == 1 && !matches[dim]);
            // No hero: no result or stack to show.
            if (dim == 8 || dim == 9) && value.is_empty() {
                continue;
            }
            tally(&mut counts[dim], value, group.count, counted);
        }
        stake_samples
            .entry(dims.stake.clone())
            .or_insert_with(|| (group.sample.clone(), group.symbol.clone()));
    }
    let [
        sites,
        formats,
        variants,
        limits,
        sizes,
        stakes,
        positions,
        pot_types,
        results,
        stacks,
        all_in,
    ] = counts;
    let mut stake_facets = Vec::new();
    for (value, count) in stakes {
        let mut facet = StakeFacet {
            value: value.clone(),
            count,
            currency: None,
            currency_symbol: None,
            minor_units: None,
            small_blind: None,
            big_blind: None,
        };
        if value != "chips"
            && let Some((sample, symbol)) = stake_samples.get(&value)
        {
            let unit: Option<(String, i64, i64, Option<i64>)> = conn
                .prepare_cached(
                    "SELECT h.currency, h.small_blind, h.big_blind, d.currency_minor_units
                     FROM hands h LEFT JOIN hand_stats d ON d.hand_key = h.hand_key
                     WHERE h.hand_key = ?1",
                )?
                .query_row([sample], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?;
            if let Some((currency, small_blind, big_blind, minor_units)) = unit {
                facet.currency = Some(currency);
                facet.currency_symbol = Some(symbol.clone());
                facet.minor_units = minor_units;
                facet.small_blind = Some(small_blind);
                facet.big_blind = Some(big_blind);
            }
        }
        stake_facets.push(facet);
    }
    // Stakes by size: the unit, then the big blind.
    stake_facets.sort_by(|a, b| {
        (a.value == "chips", &a.currency, a.big_blind).cmp(&(
            b.value == "chips",
            &b.currency,
            b.big_blind,
        ))
    });
    Ok(HandFacets {
        total,
        sites: facet_list(sites),
        formats: facet_list(formats),
        variants: facet_list(variants),
        limits: facet_list(limits),
        sizes: facet_list(sizes),
        stakes: stake_facets,
        positions: facet_list(positions),
        pot_types: facet_list(pot_types),
        results: facet_list(results),
        stacks: facet_list(stacks),
        all_in: facet_list(all_in),
    })
}

/* --------------------------------------------------------------- writes - */

/// A tag as stored: trimmed, inner whitespace one space. `None` when empty
/// or longer than [`TAG_MAX_CHARS`].
pub fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag.split_whitespace().collect::<Vec<_>>().join(" ");
    (!tag.is_empty() && tag.chars().count() <= TAG_MAX_CHARS).then_some(tag)
}

/// Set a hand's note; an empty (or blank) note removes it. Refused when
/// longer than [`NOTE_MAX_CHARS`].
pub fn set_note(conn: &Connection, hand_key: &str, note: &str, now_ms: i64) -> Result<()> {
    let note = note.trim_end();
    if note.chars().count() > NOTE_MAX_CHARS {
        return Err(Error::OutOfRange("note length"));
    }
    if note.trim().is_empty() {
        conn.prepare_cached("DELETE FROM hand_notes WHERE hand_key = ?1")?
            .execute([hand_key])?;
    } else {
        conn.prepare_cached(
            "INSERT INTO hand_notes (hand_key, note, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (hand_key) DO UPDATE SET note = excluded.note,
               updated_at = excluded.updated_at",
        )?
        .execute(params![hand_key, note, now_ms])?;
    }
    Ok(())
}

/// Tag a hand. Returns whether the tag is new on it; refused for an empty
/// or too long tag.
pub fn add_tag(conn: &Connection, hand_key: &str, tag: &str, now_ms: i64) -> Result<bool> {
    let tag = normalize_tag(tag).ok_or(Error::OutOfRange("tag"))?;
    Ok(conn
        .prepare_cached(
            "INSERT OR IGNORE INTO hand_tags (hand_key, tag, added_at) VALUES (?1, ?2, ?3)",
        )?
        .execute(params![hand_key, tag, now_ms])?
        == 1)
}

/// Take a tag off a hand. Returns whether it had it.
pub fn remove_tag(conn: &Connection, hand_key: &str, tag: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached("DELETE FROM hand_tags WHERE hand_key = ?1 AND tag = ?2")?
        .execute(params![hand_key, tag])?
        == 1)
}

/// Save a filter under `name` (trimmed) for `screen`, replacing one of the
/// same name. Returns its id.
pub fn save_filter(
    conn: &Connection,
    screen: &str,
    name: &str,
    filter: &str,
    now_ms: i64,
) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(Error::OutOfRange("filter name"));
    }
    Ok(conn
        .prepare_cached(
            "INSERT INTO saved_filters (screen, name, filter, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (screen, name) DO UPDATE SET filter = excluded.filter
             RETURNING id",
        )?
        .query_row(params![screen, name, filter, now_ms], |row| row.get(0))?)
}

/// Delete a saved filter. Returns whether it existed.
pub fn delete_saved_filter(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn
        .prepare_cached("DELETE FROM saved_filters WHERE id = ?1")?
        .execute([id])?
        == 1)
}

/// The tags `tags` normalised, unique, sorted (for a filter built from
/// user input).
pub fn tag_set(tags: &[String]) -> Vec<String> {
    tags.iter()
        .filter_map(|tag| normalize_tag(tag))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

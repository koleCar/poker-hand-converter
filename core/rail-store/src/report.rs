//! The Today and Reports screens (docs/RAIL-PLAN.md R2.7b): the hero's
//! results over time, the current session and the reports' breakdowns by
//! situation. The statistics themselves are [`Reader::hero_totals`]
//! (`stats_read`); this module adds what needs the hands one by one, in
//! time order or by a column the rollups do not keep.
//!
//! - **The win-rate graph** ([`Reader::report_graph`]): the hero's hands of
//!   a [`ReportFilter`] in time order, from `hand_list` (one narrow range
//!   scan; version 8 added the columns it needs), cut into at most `points`
//!   buckets the way the web's `stats_graph` cuts them (`ntile` over
//!   `played_at`, then `hand_key`; hands without a date last), with the
//!   cumulative result in big blinds and in money, split into showdown and
//!   non-showdown by the hero's `wtsd`, and the all-in EV line (`ev_rows`;
//!   hands still queued for the background pass count at their result and
//!   are counted). `aggregate`'s defaults: bomb pots out, an EV cashout's
//!   money out.
//! - **Units** ([`Units`]): the web's money refusals - a sample that mixes
//!   chips with cash has no money and no big blinds; one in two currencies
//!   has big blinds only.
//! - **Sessions** ([`Reader::sessions`], [`Reader::latest_session`]): the
//!   web's `stats_sessions` rule - a run of the hero's hands with no gap
//!   longer than 30 minutes between consecutive ones, across every table;
//!   bomb pots and straddles in (what happened to the money), an EV
//!   cashout's money out - read backwards from the newest hand, so the
//!   latest session costs its own hands only.
//! - **Breakdowns by situation** ([`Reader::report_breakdowns`]): the
//!   hero's totals by pot type, stack depth, starting hand, players dealt
//!   in and the street the hand reached, from one pass over `hand_stats`
//!   and the hero's `seat_stats` row (table order: measured at 500k hands,
//!   0.3 s, against 3-7 s through `hand_stats_played_idx`), split into
//!   [`PASS_THREADS`] `id` ranges on as many read connections (R2.9). By
//!   position, stake, room and format they are [`Reader::hero_totals`]' own
//!   rows.
//! - **The warm-up** ([`Reader::warm_up`], R2.9): what the screens read
//!   first, read once when the app starts so it is in the OS cache.
//!
//! The graph and the breakdowns are cached per read connection until the
//! next commit (`PRAGMA data_version`), as the Hands screen's counts are.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::error::{Error, Result};
use crate::hand_list::{SegmentDims, allows, segments};
use crate::read::Reader;
use crate::stats::{
    Exclusions, KIND_BOMB_POT, KIND_CASHOUT, KIND_STRADDLED, Totals, current_gen,
    decode_seat_sparse,
};
use crate::stats_read::HeroFilter;
use crate::time::ms_from_iso;

/// The web's session gap (`stats_sessions`' default): a break longer than
/// this ends a session.
pub const SESSION_GAP_MINUTES: i64 = 30;

/// The most graph points one call returns.
pub const GRAPH_POINTS_MAX: u32 = 4000;

/// The stack depth bands of the breakdown (the web's `stats_breakdown`
/// `stack_bb`): id, lowest stack in tenths of a big blind (inclusive),
/// highest (exclusive; `None`: no limit).
pub const STACK_BANDS: [(&str, i64, Option<i64>); 7] = [
    ("0-20", 0, Some(200)),
    ("20-40", 200, Some(400)),
    ("40-70", 400, Some(700)),
    ("70-100", 700, Some(1000)),
    ("100-150", 1000, Some(1500)),
    ("150-250", 1500, Some(2500)),
    ("250+", 2500, None),
];

/// Which of the hero's hands a report covers: every group is "any" when
/// empty. The segment's dimensions, the hero's position and a date range -
/// what [`Reader::hero_totals`] can sum (the Hands screen's other filters
/// are columns of single hands).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReportFilter {
    pub sites: Vec<String>,
    pub formats: Vec<String>,
    pub variants: Vec<String>,
    pub limits: Vec<String>,
    pub sizes: Vec<String>,
    pub stakes: Vec<String>,
    /// The hero's positions; `""` is a hero the engine gave none.
    pub positions: Vec<String>,
    /// From this instant on, ISO UTC, inclusive (leaves out undated hands).
    pub from: Option<String>,
    /// Before this instant, exclusive.
    pub to: Option<String>,
}

impl ReportFilter {
    fn segment_allows(&self, dims: &SegmentDims) -> bool {
        allows(&self.sites, &dims.site)
            && allows(&self.formats, &dims.format)
            && allows(&self.variants, &dims.variant)
            && allows(&self.limits, &dims.limit)
            && allows(&self.sizes, &dims.size)
            && allows(&self.stakes, &dims.stake)
    }

    /// The segments the filter allows (`None`: every one), sorted.
    fn segment_ids(&self, all: &HashMap<i64, SegmentDims>) -> Option<Vec<i64>> {
        let filtered = !(self.sites.is_empty()
            && self.formats.is_empty()
            && self.variants.is_empty()
            && self.limits.is_empty()
            && self.sizes.is_empty()
            && self.stakes.is_empty());
        filtered.then(|| {
            let mut ids: Vec<i64> = all
                .iter()
                .filter(|(_, dims)| self.segment_allows(dims))
                .map(|(id, _)| *id)
                .collect();
            ids.sort_unstable();
            ids
        })
    }
}

/// What a sample's money can be summed in (the web's `MoneyUnitState`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Units {
    /// Tournament chips with cash: no money and no big blinds.
    pub mixed_kind: bool,
    /// More than one currency: big blinds only.
    pub mixed_currency: bool,
    /// The one currency (`game.unit.code`), unless mixed or empty.
    pub currency: Option<String>,
    pub symbol: Option<String>,
    /// Minor units per unit of the currency (100 for cents, 1 for chips).
    pub minor_units: Option<i64>,
}

impl Units {
    /// Big-blind figures have a meaning.
    pub fn big_blinds(&self) -> bool {
        !self.mixed_kind
    }

    /// Money figures have a meaning (and a unit).
    pub fn money(&self) -> bool {
        !self.mixed_kind && !self.mixed_currency && self.currency.is_some()
    }

    /// The decimals a money text needs (100 minor units per unit: 2), for
    /// `DisplayStat::show`; `None` without money or when the minor units
    /// are not a power of ten.
    pub fn money_decimals(&self) -> Option<u32> {
        if !self.money() {
            return None;
        }
        let mut value = self.minor_units?;
        let mut exponent = 0;
        while value > 1 {
            if value % 10 != 0 {
                return None;
            }
            value /= 10;
            exponent += 1;
        }
        (value == 1).then_some(exponent)
    }
}

/// Counts the kinds and currencies of a sample, for [`Units`].
#[derive(Debug, Default)]
struct UnitTally {
    cash: bool,
    chips: bool,
    /// Code, symbol, minor units; the first of each code.
    currencies: Vec<(String, String, i64)>,
}

impl UnitTally {
    fn add(&mut self, cash: bool, code: &str, symbol: &str, minor_units: i64) {
        if cash {
            self.cash = true;
        } else {
            self.chips = true;
        }
        if !self.currencies.iter().any(|(seen, _, _)| seen == code) {
            self.currencies
                .push((code.to_owned(), symbol.to_owned(), minor_units));
        }
    }

    fn units(self) -> Units {
        let mixed_kind = self.cash && self.chips;
        let mixed_currency = self.currencies.len() > 1;
        let one = if mixed_kind || mixed_currency {
            None
        } else {
            self.currencies.into_iter().next()
        };
        Units {
            mixed_kind,
            mixed_currency,
            currency: one.as_ref().map(|(code, _, _)| code.clone()),
            symbol: one.as_ref().map(|(_, symbol, _)| symbol.clone()),
            minor_units: one.map(|(_, _, minor)| minor),
        }
    }
}

/// One point of the win-rate graph: a bucket of consecutive hands and the
/// sums up to its end. Money in minor units, big blinds in thousandths.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphPoint {
    pub hands: u64,
    pub money_hands: u64,
    pub first_played_at: Option<String>,
    pub last_played_at: Option<String>,
    pub cum_hands: u64,
    pub cum_money_hands: u64,
    pub cum_net_bb_milli: i64,
    /// Of it, won in hands where the hero went to showdown (`wtsd`)...
    pub cum_sd_bb_milli: i64,
    /// ...and in the others.
    pub cum_nsd_bb_milli: i64,
    /// The all-in EV line: the result with each evaluated all-in paid at
    /// its equity.
    pub cum_ev_bb_milli: i64,
    pub cum_net: i64,
    pub cum_sd_net: i64,
    pub cum_nsd_net: i64,
    pub cum_ev_net: i64,
}

/// The win-rate graph of a [`ReportFilter`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Graph {
    /// The hero's hands counted (bomb pots out).
    pub hands: u64,
    /// ...whose money counts (EV cashouts out).
    pub money_hands: u64,
    pub units: Units,
    /// Empty when the sample mixes chips with cash (the web refuses the
    /// graph).
    pub points: Vec<GraphPoint>,
    /// Hands with an evaluated all-in (an `ev_rows` row).
    pub all_in_hands: u64,
    /// Money hands still queued for the background EV pass (their EV is
    /// their result until it gets to them).
    pub ev_pending: u64,
}

/// One hand of the graph.
#[derive(Debug, Clone, Copy)]
struct GraphHand {
    /// Where its `played_at` starts in the pass's text buffer, and its
    /// length (0: no date).
    at: (usize, usize),
    money: bool,
    wtsd: bool,
    net: i64,
    bb: i64,
    ev_net: i64,
    ev_bb: i64,
}

/// A session: a run of the hero's hands with no gap longer than
/// [`SESSION_GAP_MINUTES`] between consecutive ones, across every table.
/// Its money is refused by its own hands (the web decides one unit for the
/// whole list of its scope): a cash session keeps its result whatever else
/// the store holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub started_at: String,
    pub ended_at: String,
    pub hands: u64,
    /// Distinct table names (the web's `count(distinct table_name)`);
    /// `None` when not asked for (see [`Reader::sessions`]).
    pub tables: Option<u64>,
    /// In minor units; `None` when the session mixes chips with cash or two
    /// currencies.
    pub net: Option<i64>,
    /// Thousandths of a big blind; `None` when it mixes chips with cash.
    pub net_bb_milli: Option<i64>,
    pub units: Units,
    /// The session's biggest pots (in big blinds), biggest first: hand keys.
    pub biggest_pots: Vec<String>,
}

/// One row of a breakdown: a value of the dimension and the hero's sums.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakdownRow {
    /// `''` for a hand the dimension has no value for (a starting hand not
    /// seen).
    pub key: String,
    pub totals: Totals,
}

/// The hero's totals by situation (`aggregate`'s defaults), each list
/// sorted by key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Breakdowns {
    /// `walk`, `limped`, `single-raised`, `3bet`, `4bet+` (bomb pots are
    /// out of the statistics).
    pub pot_type: Vec<BreakdownRow>,
    /// [`STACK_BANDS`]: the hero's starting stack.
    pub stack: Vec<BreakdownRow>,
    /// `AKs`, `QQ`, `T9o`; Omaha classes as the engine writes them.
    pub hand_class: Vec<BreakdownRow>,
    /// Players dealt in (`player_count`), as text.
    pub players: Vec<BreakdownRow>,
    /// The street the hand reached: `preflop` ... `showdown`.
    pub street: Vec<BreakdownRow>,
}

/// The stack band of a stack in tenths of a big blind.
pub fn stack_band(tenths: i64) -> &'static str {
    STACK_BANDS
        .iter()
        .find(|(_, from, below)| tenths >= *from && below.is_none_or(|below| tenths < below))
        .map_or(STACK_BANDS[0].0, |(id, _, _)| id)
}

/* -------------------------------------------------------------- caching - */

/// What a cached result was computed for: the read connection, its
/// `data_version` (it changes when another connection commits) and the
/// query.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CacheKey {
    connection: usize,
    version: i64,
    query: String,
}

/// The last few graphs and breakdowns (per read connection, until the next
/// commit).
#[derive(Debug, Default)]
pub(crate) struct ReportCache {
    graphs: Vec<(CacheKey, Arc<Graph>)>,
    breakdowns: Vec<(CacheKey, Arc<Breakdowns>)>,
}

/// Entries kept per kind.
const CACHE_SIZE: usize = 6;

fn cache_get<T>(entries: &mut Vec<(CacheKey, Arc<T>)>, key: &CacheKey) -> Option<Arc<T>> {
    let at = entries.iter().position(|(k, _)| k == key)?;
    let entry = entries.remove(at);
    let value = Arc::clone(&entry.1);
    entries.push(entry);
    Some(value)
}

fn cache_put<T>(entries: &mut Vec<(CacheKey, Arc<T>)>, key: CacheKey, value: Arc<T>) {
    entries.retain(|(k, _)| k.connection != key.connection || k.version == key.version);
    if entries.len() >= CACHE_SIZE {
        entries.remove(0);
    }
    entries.push((key, value));
}

fn cache_key(conn: &Connection, query: String) -> Result<CacheKey> {
    let version: i64 = conn.query_row("PRAGMA data_version", [], |row| row.get(0))?;
    Ok(CacheKey {
        connection: std::ptr::from_ref(conn) as usize,
        version,
        query,
    })
}

/* ------------------------------------------------------------ the SQL - */

/// ` AND column IN (?n, ...)` over `values`, appended to `params`.
fn in_list(column: &str, values: Vec<Value>, params: &mut Vec<Value>) -> String {
    let marks: Vec<String> = values
        .into_iter()
        .map(|value| {
            params.push(value);
            format!("?{}", params.len())
        })
        .collect();
    format!(" AND {column} IN ({})", marks.join(", "))
}

/// The date, segment and position clauses of `filter` over `played_at`,
/// `segment_id` and `position` (column expressions), appended to `params`.
fn clauses(
    filter: &ReportFilter,
    ids: Option<&[i64]>,
    columns: (&str, &str, &str),
    params: &mut Vec<Value>,
) -> String {
    let (played_at, segment_id, position) = columns;
    let mut sql = String::new();
    if let Some(from) = &filter.from {
        params.push(Value::Text(from.clone()));
        sql += &format!(
            " AND {played_at} >= ?{} AND {played_at} <> ''",
            params.len()
        );
    }
    if let Some(to) = &filter.to {
        params.push(Value::Text(to.clone()));
        sql += &format!(" AND {played_at} < ?{} AND {played_at} <> ''", params.len());
    }
    if let Some(ids) = ids {
        sql += &in_list(
            segment_id,
            ids.iter().map(|&id| Value::Integer(id)).collect(),
            params,
        );
    }
    if !filter.positions.is_empty() {
        sql += &in_list(
            position,
            filter.positions.iter().cloned().map(Value::Text).collect(),
            params,
        );
    }
    sql
}

/// The EV row of an all-in hand (whatever its `ev_version`: an
/// `EV_VERSION` bump's recompute swaps the new rows in when done, R2.11).
fn ev_row(conn: &Connection, hand_key: &str) -> Result<Option<(i64, i64)>> {
    Ok(conn
        .prepare_cached("SELECT ev_net, ev_net_bb_milli FROM ev_rows WHERE hand_key = ?1")?
        .query_row(params![hand_key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?)
}

fn queued(conn: &Connection, hand_key: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM ev_pending WHERE hand_key = ?1")?
        .exists([hand_key])?)
}

fn count(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

/// The graph's pass (see the module header).
fn graph_pass(conn: &Connection, filter: &ReportFilter, points: u32) -> Result<Graph> {
    let all = segments(conn)?;
    let ids = filter.segment_ids(&all);
    let mut params = Vec::new();
    let sql = format!(
        "SELECT l.played_at, l.hand_key, l.segment_id, l.hero_net, l.hero_net_bb_milli, l.kind,
                l.hero_wtsd, l.all_in, l.currency, l.currency_symbol, l.minor_units
         FROM hand_list l
         WHERE l.hero_net IS NOT NULL{}
         ORDER BY l.played_at, l.hand_key",
        clauses(
            filter,
            ids.as_deref(),
            (
                "l.played_at",
                "l.segment_id",
                "coalesce(l.hero_position, '')"
            ),
            &mut params,
        )
    );
    let mut text = String::new();
    let mut dated: Vec<GraphHand> = Vec::new();
    let mut undated: Vec<GraphHand> = Vec::new();
    let mut tally = UnitTally::default();
    let mut cash_segments: HashMap<i64, bool> = HashMap::new();
    let (mut all_in_hands, mut ev_pending) = (0_u64, 0_u64);
    {
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut rows = stmt.query(params_from_iter(params))?;
        let mut last_currency: Option<(String, i64)> = None;
        while let Some(row) = rows.next()? {
            let kind: i64 = row.get(5)?;
            let (counted, money) = Exclusions::default().admits(kind);
            if !counted {
                continue;
            }
            let segment_id: i64 = row.get(2)?;
            let cash = *cash_segments
                .entry(segment_id)
                .or_insert_with(|| all.get(&segment_id).is_some_and(|d| d.format == "cash"));
            let code = row.get_ref(8)?.as_str().map_err(rusqlite::Error::from)?;
            if last_currency
                .as_ref()
                .is_none_or(|(seen, was)| seen != code || i64::from(cash) != *was)
            {
                tally.add(cash, code, &row.get::<_, String>(9)?, row.get(10)?);
                last_currency = Some((code.to_owned(), i64::from(cash)));
            }
            let played_at = row.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
            let at = (text.len(), played_at.len());
            text.push_str(played_at);
            let (net, bb): (i64, i64) = (row.get(3)?, row.get(4)?);
            let mut hand = GraphHand {
                at,
                money,
                wtsd: row.get(6)?,
                net,
                bb,
                ev_net: net,
                ev_bb: bb,
            };
            if row.get::<_, bool>(7)? {
                let hand_key = row.get_ref(1)?.as_str().map_err(rusqlite::Error::from)?;
                match ev_row(conn, hand_key)? {
                    Some((ev_net, ev_bb)) => {
                        all_in_hands += 1;
                        hand.ev_net = ev_net;
                        hand.ev_bb = ev_bb;
                    }
                    None => {
                        if money && queued(conn, hand_key)? {
                            ev_pending += 1;
                        }
                    }
                }
            }
            if played_at.is_empty() {
                undated.push(hand);
            } else {
                dated.push(hand);
            }
        }
    }
    // `nulls last`, as the web orders them.
    dated.append(&mut undated);
    let hands = dated;
    let units = tally.units();
    let money_hands = count(hands.iter().filter(|hand| hand.money).count());
    let mut graph = Graph {
        hands: count(hands.len()),
        money_hands,
        units,
        points: Vec::new(),
        all_in_hands,
        ev_pending,
    };
    if graph.units.mixed_kind || hands.is_empty() {
        return Ok(graph);
    }
    let buckets = usize::try_from(points.clamp(1, GRAPH_POINTS_MAX))
        .unwrap_or(1)
        .min(hands.len());
    let (base, extra) = (hands.len() / buckets, hands.len() % buckets);
    let date =
        |(start, len): (usize, usize)| (len > 0).then(|| text[start..start + len].to_owned());
    let mut start = 0;
    let mut cum = GraphPoint::default();
    for bucket in 0..buckets {
        let size = base + usize::from(bucket < extra);
        let slice = &hands[start..start + size];
        start += size;
        let mut point = GraphPoint {
            hands: count(slice.len()),
            first_played_at: slice.first().and_then(|hand| date(hand.at)),
            last_played_at: slice.iter().rev().find_map(|hand| date(hand.at)),
            ..GraphPoint::default()
        };
        for hand in slice.iter().filter(|hand| hand.money) {
            point.money_hands += 1;
            cum.cum_net_bb_milli += hand.bb;
            cum.cum_net += hand.net;
            if hand.wtsd {
                cum.cum_sd_bb_milli += hand.bb;
                cum.cum_sd_net += hand.net;
            } else {
                cum.cum_nsd_bb_milli += hand.bb;
                cum.cum_nsd_net += hand.net;
            }
            cum.cum_ev_bb_milli += hand.ev_bb;
            cum.cum_ev_net += hand.ev_net;
        }
        cum.cum_hands += point.hands;
        cum.cum_money_hands += point.money_hands;
        // A bucket of undated hands has no dates; the first undated one
        // after dated ones keeps the dated hands' first date.
        graph.points.push(GraphPoint {
            hands: point.hands,
            money_hands: point.money_hands,
            first_played_at: point.first_played_at,
            last_played_at: point.last_played_at,
            ..cum.clone()
        });
    }
    Ok(graph)
}

/// A session being read: its range and sums.
#[derive(Debug, Default)]
struct OpenSession {
    newest: String,
    oldest: String,
    oldest_ms: i64,
    hands: u64,
    net: i64,
    bb: i64,
    tally: UnitTally,
}

/// The sessions' pass (see the module header): the newest `limit`
/// sessions, newest first.
fn session_pass(
    conn: &Connection,
    gap_minutes: i64,
    limit: usize,
    pots: Option<usize>,
) -> Result<Vec<Session>> {
    let all = segments(conn)?;
    let gap_ms = gap_minutes.saturating_mul(60_000);
    let mut found: Vec<OpenSession> = Vec::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT played_at, segment_id, hero_net, hero_net_bb_milli, kind, currency,
                    currency_symbol, minor_units
             FROM hand_list
             WHERE hero_net IS NOT NULL AND played_at > ''
             ORDER BY played_at DESC, hand_key DESC",
        )?;
        let mut rows = stmt.query([])?;
        let mut open: Option<OpenSession> = None;
        while let Some(row) = rows.next()? {
            let played_at = row.get_ref(0)?.as_str().map_err(rusqlite::Error::from)?;
            let Some(ms) = ms_from_iso(played_at) else {
                continue;
            };
            // Walking backwards: a gap longer than the limit between this
            // hand and the next one closes the session after it.
            if open.as_ref().is_some_and(|s| s.oldest_ms - ms > gap_ms) {
                found.extend(open.take());
                if found.len() >= limit {
                    break;
                }
            }
            let session = open.get_or_insert_with(|| OpenSession {
                newest: played_at.to_owned(),
                ..OpenSession::default()
            });
            played_at.clone_into(&mut session.oldest);
            session.oldest_ms = ms;
            let segment_id: i64 = row.get(1)?;
            let cash = all.get(&segment_id).is_some_and(|d| d.format == "cash");
            session.tally.add(
                cash,
                row.get_ref(5)?.as_str().map_err(rusqlite::Error::from)?,
                &row.get::<_, String>(6)?,
                row.get(7)?,
            );
            session.hands += 1;
            // Bomb pots and straddles are in (`stats_sessions`); an EV
            // cashout's pot is not its result.
            if row.get::<_, i64>(4)? & KIND_CASHOUT == 0 {
                session.net += row.get::<_, i64>(2)?;
                session.bb += row.get::<_, i64>(3)?;
            }
        }
        if found.len() < limit {
            found.extend(open);
        }
    }
    found
        .into_iter()
        .map(|session| close_session(conn, session, pots))
        .collect()
}

/// A session's money under the refusals and, when `pots` is asked for, its
/// tables and biggest pots (the same rows, by date range, with `hands` and
/// `hand_stats`: a few milliseconds per hundred hands).
fn close_session(conn: &Connection, session: OpenSession, pots: Option<usize>) -> Result<Session> {
    let units = session.tally.units();
    let mut closed = Session {
        started_at: session.oldest,
        ended_at: session.newest,
        hands: session.hands,
        tables: None,
        net: units.money().then_some(session.net),
        net_bb_milli: units.big_blinds().then_some(session.bb),
        units,
        biggest_pots: Vec::new(),
    };
    let Some(pots) = pots else {
        return Ok(closed);
    };
    let mut stmt = conn.prepare_cached(
        "SELECT l.hand_key, l.played_at, d.total_pot, h.big_blind, h.table_name
         FROM hand_list l
         JOIN hand_stats d ON d.hand_key = l.hand_key
         JOIN hands h ON h.hand_key = l.hand_key
         WHERE l.played_at >= ?1 AND l.played_at <= ?2 AND l.hero_net IS NOT NULL",
    )?;
    let mut tables: Vec<String> = Vec::new();
    let mut ranked: Vec<(i64, i64, String, String)> = Vec::new();
    let mut rows = stmt.query(params![closed.started_at, closed.ended_at])?;
    while let Some(row) = rows.next()? {
        let played_at: String = row.get(1)?;
        if ms_from_iso(&played_at).is_none() {
            continue;
        }
        if let Some(table) = row.get::<_, Option<String>>(4)?
            && !tables.contains(&table)
        {
            tables.push(table);
        }
        ranked.push((row.get(2)?, row.get(3)?, played_at, row.get(0)?));
    }
    // Biggest in big blinds: pot_a / bb_a against pot_b / bb_b, crosswise
    // in integers; a hand without a big blind last; then newest first.
    ranked.sort_by(|a, b| {
        let (a_pot, a_bb) = (i128::from(a.0), i128::from(a.1));
        let (b_pot, b_bb) = (i128::from(b.0), i128::from(b.1));
        (b_bb > 0)
            .cmp(&(a_bb > 0))
            .then_with(|| (b_pot * a_bb).cmp(&(a_pot * b_bb)))
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| b.3.cmp(&a.3))
    });
    closed.tables = Some(count(tables.len()));
    closed.biggest_pots = ranked
        .into_iter()
        .take(pots)
        .map(|(_, _, _, key)| key)
        .collect();
    Ok(closed)
}

/// The threads a breakdown pass is split over (R2.9), each on a read
/// connection of the pool: at a million hands one thread took 1.25-1.29 s,
/// four 0.49-0.54 s (with the bundled SQLite's global page-cache mutex off,
/// `.cargo/config.toml`), and a cold store's pass 0.9 s instead of 1.8-2.6.
pub const PASS_THREADS: usize = 4;

/// The connections [`Reader::warm_up`] runs on: three parts and the
/// breakdowns' [`PASS_THREADS`].
pub const WARM_UP_CONNECTIONS: usize = PASS_THREADS + 3;

/// A breakdown pass's sums: pot type, stack band, starting hand, players,
/// street.
type SituationSums = [BTreeMap<String, Totals>; 5];

/// The breakdowns' pass (see the module header): the hero's seat rows of
/// `hand_stats` in table order, split into consecutive `id` ranges, one per
/// connection, each on its own thread, the sums added at the end. The
/// ranges are read once, so hands imported during the pass (higher ids) are
/// in no chunk; the result is cached under the data version read before
/// it, so the next call after any commit computes it again.
fn breakdown_pass(conns: &mut [&mut Connection], filter: &ReportFilter) -> Result<Breakdowns> {
    let (sql, params, ranges) = {
        let conn: &Connection = &*conns[0];
        let all = segments(conn)?;
        let ids = filter.segment_ids(&all);
        // The generation, then the chunk's id bounds (?2, ?3, set per
        // chunk); the filter's clauses number on from there.
        let mut params = vec![
            Value::Integer(current_gen(conn)?),
            Value::Integer(0),
            Value::Integer(0),
        ];
        let sql = format!(
            "SELECT d.is_bomb_pot, d.has_straddle, d.has_cashout, d.pot_type, d.player_count,
                    d.street_reached, s.hand_class, s.starting_stack_bb_tenths, s.totals
             FROM hand_stats d NOT INDEXED
             CROSS JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
             WHERE d.gen = ?1 AND d.id >= ?2 AND d.id <= ?3{}",
            clauses(
                filter,
                ids.as_deref(),
                ("d.played_at", "d.segment_id", "coalesce(s.position, '')"),
                &mut params,
            )
        );
        let bounds: (Option<i64>, Option<i64>) =
            conn.query_row("SELECT min(id), max(id) FROM hand_stats", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        let (Some(lo), Some(hi)) = bounds else {
            return Ok(Breakdowns::default());
        };
        let parts = i64::try_from(conns.len()).unwrap_or(1).max(1);
        let span = (hi - lo) / parts + 1;
        let ranges: Vec<(i64, i64)> = (0..parts)
            .map(|i| (lo + i * span, (lo + (i + 1) * span - 1).min(hi)))
            .filter(|(from, to)| from <= to)
            .collect();
        (sql, params, ranges)
    };
    let chunk = |conn: &Connection, (from, to): (i64, i64)| {
        let mut params = params.clone();
        params[1] = Value::Integer(from);
        params[2] = Value::Integer(to);
        breakdown_chunk(conn, &sql, params)
    };
    let mut parts: Vec<SituationSums> = if ranges.len() <= 1 {
        ranges
            .iter()
            .map(|&range| chunk(&*conns[0], range))
            .collect::<Result<_>>()?
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = conns
                .iter_mut()
                .zip(&ranges)
                .map(|(conn, &range)| {
                    let conn: &mut Connection = conn;
                    let chunk = &chunk;
                    scope.spawn(move || chunk(&*conn, range))
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect::<Result<Vec<_>>>()
        })?
    };
    let mut sums = parts.pop().unwrap_or_default();
    for part in parts {
        for (into, from) in sums.iter_mut().zip(part) {
            for (key, totals) in from {
                into.entry(key).or_default().add(&totals, true);
            }
        }
    }
    let [pot_type, stack, hand_class, players, street] = sums.map(|map| {
        map.into_iter()
            .map(|(key, totals)| BreakdownRow { key, totals })
            .collect()
    });
    Ok(Breakdowns {
        pot_type,
        stack,
        hand_class,
        players,
        street,
    })
}

/// One `id` range of the breakdowns' pass.
fn breakdown_chunk(conn: &Connection, sql: &str, params: Vec<Value>) -> Result<SituationSums> {
    let mut sums: SituationSums = Default::default();
    let mut stmt = conn.prepare_cached(sql)?;
    let mut rows = stmt.query(params_from_iter(params))?;
    let mut players = String::new();
    let mut values: Vec<(usize, i64)> = Vec::with_capacity(32);
    while let Some(row) = rows.next()? {
        let kind = (if row.get::<_, bool>(0)? {
            KIND_BOMB_POT
        } else {
            0
        }) | (if row.get::<_, bool>(1)? {
            KIND_STRADDLED
        } else {
            0
        }) | (if row.get::<_, bool>(2)? {
            KIND_CASHOUT
        } else {
            0
        });
        let (counted, money) = Exclusions::default().admits(kind);
        if !counted {
            continue;
        }
        decode_seat_sparse(
            row.get_ref(8)?.as_blob().map_err(rusqlite::Error::from)?,
            &mut values,
        )?;
        players.clear();
        let _ = write!(players, "{}", row.get::<_, i64>(4)?);
        let keys: [&str; 5] = [
            row.get_ref(3)?.as_str().map_err(rusqlite::Error::from)?,
            stack_band(row.get(7)?),
            row.get_ref(6)?
                .as_str_or_null()
                .map_err(rusqlite::Error::from)?
                .unwrap_or_default(),
            &players,
            row.get_ref(5)?.as_str().map_err(rusqlite::Error::from)?,
        ];
        // The keys are a handful each: look up before allocating one.
        for (map, key) in sums.iter_mut().zip(keys) {
            if let Some(totals) = map.get_mut(key) {
                totals.add_sparse(&values, money);
            } else {
                map.entry(key.to_owned())
                    .or_default()
                    .add_sparse(&values, money);
            }
        }
    }
    Ok(sums)
}

impl Reader {
    /// The [`HeroFilter`] of the hands `filter` covers, for
    /// [`Reader::hero_totals`] (`aggregate`'s default options).
    pub fn report_hero_filter(&self, filter: &ReportFilter) -> Result<HeroFilter> {
        self.with(|conn| {
            let all = segments(conn)?;
            Ok(HeroFilter {
                segments: filter.segment_ids(&all),
                positions: (!filter.positions.is_empty()).then(|| filter.positions.clone()),
                from: filter.from.clone(),
                to: filter.to.clone(),
                exclusions: Exclusions::default(),
            })
        })
    }

    /// The win-rate graph of `filter` in at most `points` points (capped at
    /// [`GRAPH_POINTS_MAX`]); see the module header.
    pub fn report_graph(&self, filter: &ReportFilter, points: u32) -> Result<Arc<Graph>> {
        self.with(|conn| {
            let key = cache_key(conn, format!("{filter:?} {points}"))?;
            if let Some(graph) = cache_get(&mut self.report_cache().graphs, &key) {
                return Ok(graph);
            }
            let graph = Arc::new(graph_pass(conn, filter, points)?);
            cache_put(&mut self.report_cache().graphs, key, Arc::clone(&graph));
            Ok(graph)
        })
    }

    /// The hero's sessions, newest first, at most `limit` of them;
    /// [`SESSION_GAP_MINUTES`] is the web's rule. With `pots`, each with
    /// its tables and that many biggest pots (which read `hands` for every
    /// hand of the session). Empty without a dated hero hand.
    pub fn sessions(
        &self,
        gap_minutes: i64,
        limit: usize,
        pots: Option<usize>,
    ) -> Result<Vec<Session>> {
        if gap_minutes < 0 {
            return Err(Error::OutOfRange("session gap"));
        }
        self.with(|conn| session_pass(conn, gap_minutes, limit, pots))
    }

    /// The latest session ([`Reader::sessions`]' first), with its tables
    /// and `pots` biggest pots.
    pub fn latest_session(&self, gap_minutes: i64, pots: usize) -> Result<Option<Session>> {
        Ok(self
            .sessions(gap_minutes, 1, Some(pots))?
            .into_iter()
            .next())
    }

    /// What opening Reports reads: the hero's totals of `filter`
    /// ([`Reader::hero_totals`]) and its graph ([`Reader::report_graph`]),
    /// the two at once on two connections (R2.9: at a million hands each
    /// is ~0.25-0.3 s, one after the other ~0.55 s).
    pub fn report_open(
        &self,
        filter: &ReportFilter,
        points: u32,
    ) -> Result<(Vec<crate::stats_read::HeroTotal>, Arc<Graph>)> {
        // Two connections, two snapshots: run again if a recompute swapped
        // its statistics in between (R2.11).
        self.same_epoch(|| {
            std::thread::scope(|scope| {
                let graph = scope.spawn(|| self.report_graph(filter, points));
                let totals = self
                    .report_hero_filter(filter)
                    .and_then(|hero| self.hero_totals(&hero));
                let graph = graph
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
                Ok((totals?, graph?))
            })
        })
    }

    /// Read what the screens read first, so that the OS has it cached
    /// before the user opens them (R2.9): the store's counts (Today's
    /// tiles), the latest session, the hero's totals with their EV
    /// adjustment, the list in time order (the graph), the seat rows of the
    /// breakdowns and the opponents' summary - every report's filter reads
    /// the same tables. At a million hands a cold store's first Reports took
    /// ~4 s, and these tables are ~0.6 GB of its ~4 GB (the PHF is the
    /// rest, read a hand at a time). The parts run at once, each on a
    /// connection of its own (the disk serves several reads at a time):
    /// open the reader with [`WARM_UP_CONNECTIONS`]. The background pass
    /// runs it once when it starts ([`crate::StatsWorker`]).
    pub fn warm_up(&self) -> Result<()> {
        let all = ReportFilter::default();
        std::thread::scope(|scope| {
            // The hero's totals: their EV adjustment reads the seat rows of
            // every all-in hand, at random (~2.4 s of a cold 1M store).
            let totals = scope.spawn(|| -> Result<()> {
                self.hero_totals(&self.report_hero_filter(&all)?)?;
                Ok(())
            });
            let graph = scope.spawn(|| -> Result<()> {
                self.report_graph(&all, 1)?;
                Ok(())
            });
            let today = scope.spawn(|| -> Result<()> {
                self.status()?;
                // With its pots: they read the session's `hands` rows.
                self.latest_session(SESSION_GAP_MINUTES, 5)?;
                self.player_list(&crate::players::PlayerQuery {
                    limit: 1,
                    ..crate::players::PlayerQuery::default()
                })?;
                Ok(())
            });
            // The breakdowns on the connections left ([`PASS_THREADS`]).
            let breakdowns = self.report_breakdowns(&all).map(drop);
            for part in [totals, graph, today] {
                part.join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))?;
            }
            breakdowns
        })
    }

    /// The hero's totals of `filter` by situation; see the module header.
    pub fn report_breakdowns(&self, filter: &ReportFilter) -> Result<Arc<Breakdowns>> {
        // Its chunks read on several connections: run again if a recompute
        // swapped its statistics in meanwhile (R2.11).
        self.same_epoch(|| {
            self.with_many(PASS_THREADS, |conns| {
                let key = cache_key(&*conns[0], format!("{filter:?}"))?;
                if let Some(found) = cache_get(&mut self.report_cache().breakdowns, &key) {
                    return Ok(found);
                }
                let found = Arc::new(breakdown_pass(conns, filter)?);
                cache_put(&mut self.report_cache().breakdowns, key, Arc::clone(&found));
                Ok(found)
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{STACK_BANDS, UnitTally, stack_band};

    #[test]
    fn stack_bands_are_the_webs() {
        assert_eq!(stack_band(0), "0-20");
        assert_eq!(stack_band(199), "0-20");
        assert_eq!(stack_band(200), "20-40");
        assert_eq!(stack_band(999), "70-100");
        assert_eq!(stack_band(1000), "100-150");
        assert_eq!(stack_band(2499), "150-250");
        assert_eq!(stack_band(2500), "250+");
        assert_eq!(stack_band(-5), "0-20");
        assert_eq!(STACK_BANDS.len(), 7);
    }

    #[test]
    fn units_refuse_as_the_web_does() {
        let mut one = UnitTally::default();
        one.add(true, "USD", "$", 100);
        one.add(true, "USD", "$", 100);
        let units = one.units();
        assert!(units.money() && units.big_blinds());
        assert_eq!(units.currency.as_deref(), Some("USD"));
        assert_eq!(units.minor_units, Some(100));

        let mut two = UnitTally::default();
        two.add(true, "USD", "$", 100);
        two.add(true, "EUR", "E", 100);
        let units = two.units();
        assert!(units.mixed_currency && !units.money() && units.big_blinds());
        assert_eq!(units.currency, None);

        let mut kinds = UnitTally::default();
        kinds.add(true, "USD", "$", 100);
        kinds.add(false, "CHIPS", "", 1);
        let units = kinds.units();
        assert!(units.mixed_kind && !units.money() && !units.big_blinds());

        let units = UnitTally::default().units();
        assert!(!units.money() && units.big_blinds());
    }

    #[test]
    fn money_decimals() {
        let with = |minor: i64| {
            let mut tally = UnitTally::default();
            tally.add(true, "USD", "$", minor);
            tally.units().money_decimals()
        };
        assert_eq!(with(100), Some(2));
        assert_eq!(with(1), Some(0));
        assert_eq!(with(1000), Some(3));
        assert_eq!(with(250), None);
        assert_eq!(with(0), None);
        let mut two = UnitTally::default();
        two.add(true, "USD", "$", 100);
        two.add(true, "EUR", "E", 100);
        assert_eq!(two.units().money_decimals(), None);
    }
}

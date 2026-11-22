//! The Analytics checker rows in the store (docs/ANALYTICS.md Step 2,
//! migration 27): the twin of the web's `analysis_checker_rows`
//! (`supabase/migrations/20271122090000_analytics_checker_rows.sql`).
//!
//! - **What**: one row per (analysed hero decision, catalogue rate it
//!   belongs to), derived by [`rail_stats::analytics_rows`] from the hand's
//!   PHF and its stored decisions - the rate and whether the decision took
//!   its class, the reference's share of the class, whether its best option
//!   is in it, the EV loss, the size bucket, the hand class, the spot - with
//!   the hand's time, format, seat and pot type for the filters.
//! - **Written with the analysis**: [`write_hand`] runs in the save's
//!   transaction ([`crate::analysis`]), from the decisions just saved and
//!   the hand's stored PHF, and marks the hand
//!   (`hand_analysis.checker_version` = [`MEMBERSHIP_VERSION`]).
//! - **Backfill** ([`backfill_step`], a step of the background pass): the
//!   hands analysed whose mark is not the current version (analysed before
//!   migration 27, or under another membership version), [`BACKFILL_PAGE`]
//!   at a time, derived from the stored PHF and decisions - no
//!   re-analysis. A hand re-analysed meanwhile (its `analysed_at` moved) is
//!   left to its own save. Idempotent: a hand's rows are replaced.
//! - **Reads** ([`Reader::checker_sums`], [`Reader::checker_examples`]):
//!   the web's `analytics_checker` and `analytics_checker_examples`, the
//!   same sums in the same order over the same decisions
//!   (`tests/checker.rs`, the fixture `core/rail-stats/tests/data/analytics/rows/`).

use rail_stats::analytics::{MEMBERSHIP_VERSION, catalogue};
use rail_stats::analytics_rows::{AnalyticsRow, RowsDecision, analytics_rows, position_name};
use rail_stats::events::hand_events;
use rusqlite::{Connection, Transaction, params};
use serde_json::Value;

use crate::background::hand_from;
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::writer::WriterHandle;

/// Hands per backfill transaction (derivation is ~0.1 ms a hand).
pub const BACKFILL_PAGE: u32 = 500;

/// The most example rows one read returns.
pub const EXAMPLES_MAX: usize = 100;

/// A hand's rows, ready to write.
struct HandRows {
    hero_position: String,
    rows: Vec<AnalyticsRow>,
}

/// One stored decision, owned.
struct StoredDecision {
    ord: i64,
    action_index: i64,
    status: String,
    options: Value,
    ev_loss_bb: Option<f64>,
    facts: Value,
}

fn derive(blob: &[u8], size: i64, decisions: &[StoredDecision]) -> Result<HandRows> {
    let hand = hand_from(blob, size)?;
    let events = hand_events(&hand);
    let hero_position = events
        .seats
        .iter()
        .find(|seat| seat.hero)
        .and_then(|seat| seat.position)
        .map_or("", position_name)
        .to_owned();
    let borrowed: Vec<RowsDecision<'_>> = decisions
        .iter()
        .map(|d| RowsDecision {
            ord: d.ord,
            action_index: d.action_index,
            status: &d.status,
            options: &d.options,
            ev_loss_bb: d.ev_loss_bb,
            facts: &d.facts,
        })
        .collect();
    Ok(HandRows {
        hero_position,
        rows: analytics_rows(catalogue(), &events, &borrowed),
    })
}

fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// Replace a hand's rows and mark it at the current version. The hand's
/// analysis row must exist (the caller checks `analysed_at` when it read
/// the decisions outside the transaction).
fn write_rows(tx: &Transaction<'_>, hand_key: &str, rows: &HandRows) -> Result<()> {
    tx.prepare_cached("DELETE FROM analysis_checker_rows WHERE hand_key = ?1")?
        .execute([hand_key])?;
    let (analysis_version, pot_type, played_at, game_format): (String, String, String, String) = tx
        .prepare_cached(
            "SELECT a.analysis_version, a.pot_type, coalesce(h.played_at, ''), h.game_format
             FROM hand_analysis a JOIN hands h ON h.hand_key = a.hand_key
             WHERE a.hand_key = ?1",
        )?
        .query_row([hand_key], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
    let mut insert = tx.prepare_cached(
        "INSERT OR REPLACE INTO analysis_checker_rows (
           hand_key, ord, stat, analysis_version, membership_version, action_index, played_at,
           game_format, hero_position, pot_type, taken, ref_share, best_in, ev_loss_bb, size,
           hand_class, spot, multiway)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
    )?;
    for row in &rows.rows {
        insert.execute(params![
            hand_key,
            row.ord,
            row.stat,
            analysis_version,
            MEMBERSHIP_VERSION,
            row.action_index,
            played_at,
            game_format,
            rows.hero_position,
            pot_type,
            row.taken,
            row.ref_share,
            row.best_in,
            row.ev_loss_bb,
            row.size,
            row.hand_class,
            row.spot,
            row.multiway,
        ])?;
    }
    tx.prepare_cached(
        "UPDATE hand_analysis SET checker_version = ?2, checker_position = ?3 WHERE hand_key = ?1",
    )?
    .execute(params![hand_key, MEMBERSHIP_VERSION, rows.hero_position])?;
    Ok(())
}

/// The stored decisions of a hand, in order.
fn stored_decisions(conn: &Connection, hand_key: &str) -> Result<Vec<StoredDecision>> {
    let mut stmt = conn.prepare_cached(
        "SELECT ord, action_index, status, options, ev_loss_bb, facts
         FROM decision_analysis WHERE hand_key = ?1 ORDER BY ord",
    )?;
    let rows = stmt
        .query_map([hand_key], |r| {
            Ok(StoredDecision {
                ord: r.get(0)?,
                action_index: r.get(1)?,
                status: r.get(2)?,
                options: parse_json(&r.get::<_, String>(3)?),
                ev_loss_bb: r.get(4)?,
                facts: parse_json(&r.get::<_, String>(5)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The rows of a hand whose analysis was just written in `tx`: derived from
/// the decisions stored there and the hand's PHF. A PHF that cannot be read
/// marks the hand with no rows (logged), so the backfill does not come back
/// to it.
pub(crate) fn write_hand(tx: &Transaction<'_>, hand_key: &str) -> Result<()> {
    let (blob, size): (Vec<u8>, i64) = tx
        .prepare_cached("SELECT phf, phf_size FROM hands WHERE hand_key = ?1")?
        .query_row([hand_key], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let decisions = stored_decisions(tx, hand_key)?;
    let rows = derive(&blob, size, &decisions).unwrap_or_else(|error| {
        log::warn!("analytics rows: {hand_key}: {error}");
        HandRows {
            hero_position: String::new(),
            rows: Vec::new(),
        }
    });
    write_rows(tx, hand_key, &rows)
}

/// One page of the backfill: the hands whose mark is not
/// [`MEMBERSHIP_VERSION`], derived and written. How many hands it went
/// through (`None`: nothing left).
pub fn backfill_step(reader: &Reader, writer: &WriterHandle) -> Result<Option<usize>> {
    type Page = Vec<(String, i64, Vec<u8>, i64)>;
    let page: Page = reader.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT a.hand_key, a.analysed_at, h.phf, h.phf_size
             FROM hand_analysis a JOIN hands h ON h.hand_key = a.hand_key
             WHERE a.checker_version < ?1 OR a.checker_version > ?1
             ORDER BY a.hand_key LIMIT ?2",
        )?;
        Ok(stmt
            .query_map(params![MEMBERSHIP_VERSION, BACKFILL_PAGE], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Page>>()?)
    })?;
    if page.is_empty() {
        return Ok(None);
    }
    let mut derived: Vec<(String, i64, HandRows)> = Vec::with_capacity(page.len());
    for (hand_key, analysed_at, blob, size) in page {
        let decisions = reader.with(|conn| stored_decisions(conn, &hand_key))?;
        let rows = derive(&blob, size, &decisions).unwrap_or_else(|error| {
            log::warn!("analytics rows: {hand_key}: {error}");
            HandRows {
                hero_position: String::new(),
                rows: Vec::new(),
            }
        });
        derived.push((hand_key, analysed_at, rows));
    }
    let n = derived.len();
    writer.write(move |tx| {
        for (hand_key, analysed_at, rows) in &derived {
            // Analysed again since the read: its own save wrote its rows.
            let same = tx
                .prepare_cached(
                    "SELECT 1 FROM hand_analysis WHERE hand_key = ?1 AND analysed_at = ?2
                       AND checker_version <> ?3",
                )?
                .exists(params![hand_key, analysed_at, MEMBERSHIP_VERSION])?;
            if same {
                write_rows(tx, hand_key, rows)?;
            }
        }
        Ok(())
    })?;
    Ok(Some(n))
}

/* ---------------------------------------------------------------- reads - */

/// The checker's filters (`None`: every value): the web's
/// `analysis_filter_of` keys the desktop has, and the pot kind.
#[derive(Debug, Clone, Default)]
pub struct CheckerFilters {
    /// ISO time, inclusive (`played_at >= from`).
    pub from: Option<String>,
    /// ISO time, exclusive (`played_at < to`).
    pub to: Option<String>,
    pub game_format: Option<String>,
    /// `cash` or `tournament`.
    pub game_kind: Option<String>,
    pub position: Option<String>,
    pub pot_type: Option<String>,
    /// `hu`, `mw` or `bomb`.
    pub pot_kind: Option<String>,
    /// Default [`MEMBERSHIP_VERSION`].
    pub membership_version: Option<String>,
}

impl CheckerFilters {
    fn membership(&self) -> String {
        self.membership_version
            .clone()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| MEMBERSHIP_VERSION.to_owned())
    }

    /// A fixed clause per pot kind (nothing from the caller is spliced in).
    fn kind_sql(&self) -> Result<&'static str> {
        Ok(match self.pot_kind.as_deref() {
            None => "",
            Some("hu") => " AND r.pot_type <> 'bomb' AND r.multiway = 0",
            Some("mw") => " AND r.pot_type <> 'bomb' AND r.multiway = 1",
            Some("bomb") => " AND r.pot_type = 'bomb'",
            Some(_) => return Err(Error::OutOfRange("pot kind")),
        })
    }
}

/// `?1` version, `?2` membership, `?3` formats JSON, `?4` seat, `?5` pot
/// type, `?6` from, `?7` to.
const SCOPE: &str = "
    WHERE r.analysis_version = ?1 AND r.membership_version = ?2
      AND (?3 IS NULL OR r.game_format IN (SELECT value FROM json_each(?3)))
      AND (?4 IS NULL OR r.hero_position = ?4)
      AND (?5 IS NULL OR r.pot_type = ?5)
      AND (?6 IS NULL OR (r.played_at > '' AND r.played_at >= ?6))
      AND (?7 IS NULL OR (r.played_at > '' AND r.played_at < ?7))";

/// One group's sums (the web's `analytics_checker` group).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckerGroup {
    pub stat: String,
    pub spot: String,
    pub size: String,
    pub hand_class: String,
    pub opps: i64,
    pub opps_taken: i64,
    pub n: i64,
    pub taken: i64,
    pub ref_share: f64,
    pub ev_high: f64,
    pub ev_low: f64,
    pub hands: i64,
}

/// The checker's answer (the web's `analytics_checker`).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckerSums {
    pub analysis_version: String,
    pub membership_version: String,
    /// Hands in scope with rows at the membership version.
    pub hands: i64,
    /// Hands analysed at the version still without them.
    pub pending: i64,
    /// By (stat, spot, size, hand class), byte order.
    pub groups: Vec<CheckerGroup>,
}

/// Which decisions an example list shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckerSide {
    /// Took the class ("too much").
    High,
    /// Did not, the best option in the class ("too little").
    Low,
    Any,
}

/// The decisions of one stat an example list narrows to.
#[derive(Debug, Clone)]
pub struct ExampleQuery {
    pub stat: String,
    pub spot: Option<String>,
    pub size: Option<String>,
    pub hand_class: Option<String>,
    pub side: CheckerSide,
    pub limit: usize,
}

/// One decision behind a group (the web's `analytics_checker_examples` row).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckerExample {
    pub hand_key: String,
    pub ord: i64,
    pub action_index: i64,
    /// '' without a date.
    pub played_at: String,
    /// The hand's room (`hands.site`).
    pub site: String,
    pub stat: String,
    pub spot: String,
    pub size: String,
    pub hand_class: String,
    pub taken: bool,
    pub best_in: bool,
    pub ref_share: f64,
    pub ev_loss_bb: f64,
    pub facing_pot: Option<f64>,
    pub cards: Vec<String>,
    pub board: Vec<String>,
}

fn round(x: f64, places: i32) -> f64 {
    rail_stats::analytics_rows::round_half_away(x, places)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

impl Reader {
    /// The checker's sums per (stat, spot, size, hand class) at `version`.
    pub fn checker_sums(&self, version: &str, filters: &CheckerFilters) -> Result<CheckerSums> {
        let formats = crate::game_kind::formats_json(
            filters.game_format.as_deref(),
            filters.game_kind.as_deref(),
        )?;
        let membership = filters.membership();
        let kind = filters.kind_sql()?;
        let position = filters.position.as_ref().map(|p| p.trim().to_uppercase());
        self.with(|conn| {
            let args = params![
                version,
                membership,
                formats,
                position,
                filters.pot_type,
                filters.from,
                filters.to,
            ];
            let sql = format!(
                "SELECT r.stat, r.spot, r.size, r.hand_class,
                        count(*),
                        sum(r.taken),
                        sum(r.ref_share IS NOT NULL),
                        sum(r.ref_share IS NOT NULL AND r.taken = 1),
                        total(r.ref_share),
                        total(CASE WHEN r.ref_share IS NOT NULL AND r.taken = 1 THEN r.ev_loss_bb END),
                        total(CASE WHEN r.ref_share IS NOT NULL AND r.taken = 0 AND r.best_in = 1
                                   THEN r.ev_loss_bb END),
                        count(DISTINCT r.hand_key)
                 FROM analysis_checker_rows r {SCOPE}{kind}
                 GROUP BY r.stat, r.spot, r.size, r.hand_class
                 ORDER BY r.stat, r.spot, r.size, r.hand_class"
            );
            let groups = conn
                .prepare(&sql)?
                .query_map(args, |r| {
                    Ok(CheckerGroup {
                        stat: r.get(0)?,
                        spot: r.get(1)?,
                        size: r.get(2)?,
                        hand_class: r.get(3)?,
                        opps: r.get(4)?,
                        opps_taken: r.get(5)?,
                        n: r.get(6)?,
                        taken: r.get(7)?,
                        ref_share: round(r.get(8)?, 6),
                        ev_high: round(r.get(9)?, 3),
                        ev_low: round(r.get(10)?, 3),
                        hands: r.get(11)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            // The hands in scope: the marked hands with the hand-level filters.
            let hands_kind = match filters.pot_kind.as_deref() {
                Some("bomb") => " AND a.pot_type = 'bomb'",
                Some(_) => " AND a.pot_type <> 'bomb'",
                None => "",
            };
            let hands_sql = format!(
                "SELECT count(*) FROM hand_analysis a JOIN hands h ON h.hand_key = a.hand_key
                 WHERE a.analysis_version = ?1 AND a.checker_version = ?2
                   AND (?3 IS NULL OR h.game_format IN (SELECT value FROM json_each(?3)))
                   AND (?4 IS NULL OR a.checker_position = ?4)
                   AND (?5 IS NULL OR a.pot_type = ?5)
                   AND (?6 IS NULL OR (h.played_at > '' AND h.played_at >= ?6))
                   AND (?7 IS NULL OR (h.played_at > '' AND h.played_at < ?7)){hands_kind}"
            );
            let hands: i64 = conn.query_row(
                &hands_sql,
                params![
                    version,
                    membership,
                    formats,
                    position,
                    filters.pot_type,
                    filters.from,
                    filters.to,
                ],
                |r| r.get(0),
            )?;
            let (analysed, marked): (i64, i64) = conn.query_row(
                "SELECT count(*), coalesce(sum(checker_version = ?2), 0) FROM hand_analysis
                 WHERE analysis_version = ?1",
                params![version, membership],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            Ok(CheckerSums {
                analysis_version: version.to_owned(),
                membership_version: membership.clone(),
                hands,
                pending: (analysed - marked).max(0),
                groups,
            })
        })
    }

    /// The costliest analysed decisions of one stat at `version`.
    pub fn checker_examples(
        &self,
        version: &str,
        filters: &CheckerFilters,
        query: &ExampleQuery,
    ) -> Result<Vec<CheckerExample>> {
        let formats = crate::game_kind::formats_json(
            filters.game_format.as_deref(),
            filters.game_kind.as_deref(),
        )?;
        let membership = filters.membership();
        let kind = filters.kind_sql()?;
        let position = filters.position.as_ref().map(|p| p.trim().to_uppercase());
        let side = match query.side {
            CheckerSide::High => " AND r.taken = 1",
            CheckerSide::Low => " AND r.taken = 0 AND r.best_in = 1",
            CheckerSide::Any => "",
        };
        let limit = i64::try_from(query.limit.clamp(1, EXAMPLES_MAX)).unwrap_or(20);
        self.with(|conn| {
            let sql = format!(
                "SELECT r.hand_key, r.ord, r.action_index, r.played_at, r.stat, r.spot, r.size,
                        r.hand_class, r.taken, r.best_in, r.ref_share, r.ev_loss_bb, d.facts, h.site
                 FROM analysis_checker_rows r
                 JOIN hands h ON h.hand_key = r.hand_key
                 LEFT JOIN decision_analysis d ON d.hand_key = r.hand_key AND d.ord = r.ord
                 {SCOPE}{kind}{side}
                   AND r.stat = ?8 AND r.ref_share IS NOT NULL
                   AND (?9 IS NULL OR r.spot = ?9)
                   AND (?10 IS NULL OR r.size = ?10)
                   AND (?11 IS NULL OR r.hand_class = ?11)
                 ORDER BY r.ev_loss_bb DESC, r.played_at = '', r.played_at DESC, r.hand_key, r.ord
                 LIMIT ?12"
            );
            let rows = conn
                .prepare(&sql)?
                .query_map(
                    params![
                        version,
                        membership,
                        formats,
                        position,
                        filters.pot_type,
                        filters.from,
                        filters.to,
                        query.stat,
                        query.spot,
                        query.size,
                        query.hand_class,
                        limit,
                    ],
                    |r| {
                        let facts = r
                            .get::<_, Option<String>>(12)?
                            .map_or(Value::Null, |text| parse_json(&text));
                        Ok(CheckerExample {
                            hand_key: r.get(0)?,
                            ord: r.get(1)?,
                            action_index: r.get(2)?,
                            played_at: r.get(3)?,
                            site: r.get(13)?,
                            stat: r.get(4)?,
                            spot: r.get(5)?,
                            size: r.get(6)?,
                            hand_class: r.get(7)?,
                            taken: r.get(8)?,
                            best_in: r.get::<_, Option<bool>>(9)?.unwrap_or(false),
                            ref_share: r.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
                            ev_loss_bb: r.get(11)?,
                            facing_pot: facts.get("facingPot").and_then(Value::as_f64),
                            cards: strings(facts.get("holeCards")),
                            board: strings(facts.get("board")),
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }
}

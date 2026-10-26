//! The leak finder's top three in the app (docs/RAIL-PLAN.md R5.4; the web's
//! R5.2 `analysis_top_leaks` and `analysis_leak_examples` over this store).
//!
//! Sums in, nothing decided: per finest spot (`analysis_leak_rows.spot_key`
//! with its chart set) the graded decisions, those worse than Perfect, the
//! mistakes (Inaccurate or worse), the EV lost and the score's sum and sum of
//! squares - the rows of the web's `analysis_leaks` - for three samples: the
//! period (all time, or the last 30 days of play), the last 30 days of play
//! and the 30 before, counted back from the last UTC day with a graded hand.
//! The web's own pure modules group and rank them (`groupLeaks`,
//! `rankTopLeaks`, in the window). Filters: the hand's format, the hero's
//! seat and the pot type. Sums are returned as summed; the window rounds
//! them as the web's `numeric` sums are rounded.

use rusqlite::{Connection, params};

use crate::error::{Error, Result};
use crate::read::Reader;
use crate::time::{iso_from_ms, ms_from_iso};

/// The top three's filters (`None`: every value).
#[derive(Debug, Clone, Default)]
pub struct LeakFilters {
    pub game_format: Option<String>,
    pub position: Option<String>,
    pub pot_type: Option<String>,
}

/// One finest spot's sums.
#[derive(Debug, Clone, PartialEq)]
pub struct SpotSums {
    pub key: String,
    /// The chart set a chart grade came from; `None` off the charts.
    pub set: Option<String>,
    pub decisions: i64,
    pub non_perfect: i64,
    pub mistakes: i64,
    pub ev_loss_bb: f64,
    pub ev_loss_pot: f64,
    pub score_sum: f64,
    pub score_sq: f64,
}

/// One sample: graded hands and decisions, and the spots.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LeakSample {
    pub hands: i64,
    pub graded: i64,
    pub rows: Vec<SpotSums>,
}

/// What [`Reader::top_leaks`] answers.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TopLeaks {
    /// The UTC day of the last graded hand in scope.
    pub last: Option<String>,
    /// The last 30 days of play, and the 30 before (UTC days, inclusive).
    pub current: Option<(String, String)>,
    pub prior: Option<(String, String)>,
    pub sample: LeakSample,
    pub now: LeakSample,
    pub was: LeakSample,
}

/// One decision behind a leak.
#[derive(Debug, Clone, PartialEq)]
pub struct LeakExample {
    pub hand_key: String,
    pub ord: i64,
    pub action_index: i64,
    /// `''` without a time.
    pub played_at: String,
    pub site: String,
    pub currency: String,
    pub currency_symbol: String,
    pub minor_units: i64,
    pub small_blind: i64,
    pub big_blind: i64,
    pub hero_cards: Vec<String>,
    pub hand_class: Option<String>,
    pub spot_key: String,
    pub grade: String,
    pub ev_loss_bb: f64,
    pub ev_loss_pot: f64,
}

/// The leak rows (`r`) in scope: `?1` version, `?2` format, `?3` seat, `?4`
/// pot type, `?5` / `?6` the first and last UTC day (inclusive; a hand
/// without a time is in all time only).
const SCOPE: &str = "
    WHERE r.analysis_version = ?1
      AND (?2 IS NULL OR r.game_format = ?2)
      AND (?3 IS NULL OR r.hero_position = ?3)
      AND (?4 IS NULL OR r.pot_type = ?4)
      AND (?5 IS NULL OR r.played_at >= ?5)
      AND (?6 IS NULL OR (r.played_at > '' AND substr(r.played_at, 1, 10) <= ?6))";

fn sample(
    conn: &Connection,
    version: &str,
    filters: &LeakFilters,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<LeakSample> {
    let args = params![
        version,
        filters.game_format,
        filters.position,
        filters.pot_type,
        from,
        to
    ];
    let hands: i64 = conn
        .prepare_cached(&format!(
            "SELECT count(DISTINCT r.hand_key) FROM analysis_leak_rows r {SCOPE}"
        ))?
        .query_row(args, |row| row.get(0))?;
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT r.spot_key, r.chart_set, count(*),
                sum(r.grade <> 'perfect'),
                sum(r.grade IN ('inaccurate', 'mistake', 'blunder')),
                total(r.ev_loss_bb), total(r.ev_loss_pot),
                total(r.score), total(r.score * r.score)
         FROM analysis_leak_rows r {SCOPE}
         GROUP BY r.spot_key, r.chart_set
         ORDER BY r.spot_key, r.chart_set"
    ))?;
    let rows = stmt
        .query_map(args, |row| {
            let set: String = row.get(1)?;
            Ok(SpotSums {
                key: row.get(0)?,
                set: (!set.is_empty()).then_some(set),
                decisions: row.get(2)?,
                non_perfect: row.get(3)?,
                mistakes: row.get(4)?,
                ev_loss_bb: row.get(5)?,
                ev_loss_pot: row.get(6)?,
                score_sum: row.get(7)?,
                score_sq: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let graded = rows.iter().map(|r| r.decisions).sum();
    Ok(LeakSample {
        hands,
        graded,
        rows,
    })
}

/// The UTC day `days` before `day`.
fn day_minus(day: &str, days: i64) -> Option<String> {
    let ms = ms_from_iso(&format!("{day}T00:00:00.000Z"))?;
    Some(iso_from_ms(ms - days * 86_400_000).get(..10)?.to_owned())
}

fn day_ok(day: &str) -> bool {
    day.len() == 10 && ms_from_iso(&format!("{day}T00:00:00.000Z")).is_some()
}

impl Reader {
    /// The top three's samples (`analysis_top_leaks`): `period` is `30d`
    /// or `all`.
    pub fn top_leaks(
        &self,
        version: &str,
        filters: &LeakFilters,
        period: &str,
    ) -> Result<TopLeaks> {
        if period != "30d" && period != "all" {
            return Err(Error::OutOfRange("period"));
        }
        self.with(|conn| {
            let none: Option<&str> = None;
            let last: Option<String> = conn
                .prepare_cached(&format!(
                    "SELECT max(substr(r.played_at, 1, 10)) FROM analysis_leak_rows r
                     {SCOPE} AND r.played_at > ''"
                ))?
                .query_row(
                    params![
                        version,
                        filters.game_format,
                        filters.position,
                        filters.pot_type,
                        none,
                        none
                    ],
                    |row| row.get(0),
                )?;
            let windows = last.as_deref().and_then(|last| {
                Some((
                    (day_minus(last, 29)?, last.to_owned()),
                    (day_minus(last, 59)?, day_minus(last, 30)?),
                ))
            });
            let (now, was) = match &windows {
                Some((current, prior)) => (
                    sample(conn, version, filters, Some(&current.0), Some(&current.1))?,
                    sample(conn, version, filters, Some(&prior.0), Some(&prior.1))?,
                ),
                None => (LeakSample::default(), LeakSample::default()),
            };
            let sample_of = if period == "all" {
                sample(conn, version, filters, None, None)?
            } else {
                now.clone()
            };
            Ok(TopLeaks {
                last,
                current: windows.as_ref().map(|w| w.0.clone()),
                prior: windows.map(|w| w.1),
                sample: sample_of,
                now,
                was,
            })
        })
    }

    /// The decisions behind one leak (`analysis_leak_examples`): worse than
    /// Perfect at any of its spot keys (at most 200), costliest first, in
    /// the UTC days and filters given, at most `limit` (30).
    pub fn leak_examples(
        &self,
        version: &str,
        filters: &LeakFilters,
        days: Option<(&str, &str)>,
        keys: &[String],
        limit: usize,
    ) -> Result<Vec<LeakExample>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        if keys.len() > 200 || keys.iter().any(|k| k.split('|').count() != 6) {
            return Err(Error::OutOfRange("leak keys"));
        }
        if days.is_some_and(|(from, to)| !day_ok(from) || !day_ok(to)) {
            return Err(Error::OutOfRange("days"));
        }
        let limit = i64::try_from(limit.clamp(1, 30)).unwrap_or(30);
        let keys_json =
            serde_json::to_string(keys).map_err(|error| Error::Corrupt(error.to_string()))?;
        let (from, to) = (days.map(|d| d.0), days.map(|d| d.1));
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT r.hand_key, r.ord, r.action_index, r.played_at, h.site, h.currency,
                        l.currency_symbol, l.minor_units, h.small_blind, h.big_blind,
                        l.hero_cards, json_extract(d.facts, '$.handClass'), r.spot_key, r.grade,
                        r.ev_loss_bb, r.ev_loss_pot
                 FROM analysis_leak_rows r
                 JOIN hands h ON h.hand_key = r.hand_key
                 JOIN decision_analysis d ON d.hand_key = r.hand_key AND d.ord = r.ord
                 LEFT JOIN hand_list l ON l.played_at = r.played_at AND l.hand_key = r.hand_key
                 {SCOPE}
                   AND r.grade <> 'perfect'
                   AND r.spot_key IN (SELECT value FROM json_each(?7))
                 ORDER BY r.ev_loss_bb DESC, r.played_at DESC, r.hand_key, r.ord
                 LIMIT ?8"
            ))?;
            let rows = stmt.query_map(
                params![
                    version,
                    filters.game_format,
                    filters.position,
                    filters.pot_type,
                    from,
                    to,
                    keys_json,
                    limit
                ],
                |row| {
                    Ok(LeakExample {
                        hand_key: row.get(0)?,
                        ord: row.get(1)?,
                        action_index: row.get(2)?,
                        played_at: row.get(3)?,
                        site: row.get(4)?,
                        currency: row.get(5)?,
                        currency_symbol: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        minor_units: row.get::<_, Option<i64>>(7)?.unwrap_or(1),
                        small_blind: row.get(8)?,
                        big_blind: row.get(9)?,
                        hero_cards: row
                            .get::<_, Option<String>>(10)?
                            .unwrap_or_default()
                            .split_whitespace()
                            .map(str::to_owned)
                            .collect(),
                        hand_class: row.get(11)?,
                        spot_key: row.get(12)?,
                        grade: row.get(13)?,
                        ev_loss_bb: row.get(14)?,
                        ev_loss_pot: row.get(15)?,
                    })
                },
            )?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{day_minus, day_ok};

    #[test]
    fn days_count_back() {
        assert_eq!(day_minus("2026-03-01", 1).as_deref(), Some("2026-02-28"));
        assert_eq!(day_minus("2026-10-23", 29).as_deref(), Some("2026-09-24"));
        assert_eq!(day_minus("2026-10-23", 59).as_deref(), Some("2026-08-25"));
        assert!(day_ok("2026-10-23") && !day_ok("2026-13-01") && !day_ok("23.10.2026"));
    }
}

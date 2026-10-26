//! The hand analysis in the app (docs/RAIL-PLAN.md R5.4, migration 16):
//! what the web keeps in `hand_analysis` / `decision_analysis`, kept here
//! for the hands of this store.
//!
//! The analysis itself is the web's library (`frontend/src/lib/analysis`),
//! run by the app's window in a worker: it asks for hands
//! ([`Reader::analysis_pending`]), analyses them and sends the rows back
//! ([`WriterHandle::save_analysis`]). This crate stores and reads; it grades
//! nothing.
//!
//! - **Which hands**: every hand without a row at the asked version - never
//!   analysed, or analysed at an older one - newest first (the web's
//!   "recent first" read, `hands_needing_analysis_recent`), a keyset page
//!   at a time; and, when the flop library can be reached again
//!   (`retry_offline`), hands analysed without it that have a flop
//!   decision.
//! - **Writing**: a hand's row and its decisions replace whatever the hand
//!   had, in one transaction; the aggregates (`decisions`, `analysed`,
//!   `flag_count`, `worst_flag`) are computed here from the decisions, as
//!   `save_hand_analysis` computes them, never taken from the caller. A
//!   hand that is gone meanwhile is skipped.
//! - **Reading a hand**: [`Reader::hand_analysis`] answers in the shape of
//!   the web's `analysis_hand` (camelCase), which the library's
//!   `handAnalysisFromStored` reads.
//! - **Opponents' statistics** ([`Reader::villain_counters`]): the web's
//!   `villain_counters` over this store - an opponent's own seat rows
//!   (`player_hands`: rooms with real names, never the hero's rows), cash
//!   games, bomb pots out, summed when at least `min_hands`.
//! - **Chart sets** (R5.3, `chart_sets`): the user's own preflop charts,
//!   stored as the editor hands them over.

use std::collections::BTreeMap;

use rail_stats::counters::Counter;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::batch::decompress_phf;
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::stats::decode_seat;
use crate::writer::WriterHandle;

/// The most hands one page of [`Reader::analysis_pending`] returns.
pub const PENDING_MAX: u32 = 200;

/// The most rows one [`WriterHandle::save_analysis`] takes.
pub const SAVE_MAX: usize = 200;

/// The most decisions a hand's row may carry (the web's check).
pub const DECISIONS_MAX: usize = 200;

/// The most players one [`Reader::villain_counters`] call takes (the web's).
pub const VILLAIN_MAX: usize = 500;

/// The most chart sets the store keeps (the web's per account).
pub const CHART_SETS_MAX: i64 = 50;

/// The grades, best first: perfect is rank 1, blunder 5.
pub const GRADES: [&str; 5] = ["perfect", "good", "inaccurate", "mistake", "blunder"];

/// How bad a grade is: perfect 1 ... blunder 5, 0 for none (`analysis_grade_rank`).
pub fn grade_rank(grade: Option<&str>) -> i64 {
    grade
        .and_then(|grade| GRADES.iter().position(|g| *g == grade))
        .and_then(|index| i64::try_from(index + 1).ok())
        .unwrap_or(0)
}

/// One decision as the runner sends it: the web's `DecisionAnalysisInsert`
/// and the leak finder's three columns.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DecisionRowIn {
    pub ord: i64,
    pub action_index: i64,
    pub street: String,
    pub action: String,
    pub status: String,
    pub reason: Option<String>,
    pub node: String,
    pub scenario: String,
    pub source: String,
    pub grade: Option<String>,
    pub score: Option<f64>,
    pub ev_loss_bb: Option<f64>,
    pub ev_loss_pot: Option<f64>,
    pub freq_diff: Option<f64>,
    pub options: Value,
    pub chosen: Option<i64>,
    pub flags: Value,
    pub approximations: Vec<String>,
    pub facing_bet: bool,
    pub pot_bb: Option<f64>,
    pub pot_odds: Option<f64>,
    pub mdf: Option<f64>,
    pub facts: Value,
    pub spot_key: String,
    pub chart_set: String,
    pub best: String,
    /// The own charts' fields (R5.3b), for a preflop decision graded on the
    /// shipped tree; `None` for any other.
    #[serde(default)]
    pub preflop: Option<PreflopFields>,
}

/// A preflop decision as the own charts compare it (`preflop_decision_fields`).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PreflopFields {
    /// The situation key; `''` when the vocabulary does not name the line.
    pub chart_key: String,
    /// The shipped set's table: 2, 6 or 9.
    pub chart_table: i64,
    /// 0-168.
    pub hand_class: i64,
    /// `fold`, `check`, `call`, `raise`, `allin`.
    pub chart_action: String,
    /// Effective stack in 10 bb steps, the lower end; -1 unknown.
    pub depth_band: i64,
}

/// One hand as the runner sends it: the web's `HandAnalysisInsert` keyed by
/// the store's hand key, and whether the flop library was at hand.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct HandAnalysisIn {
    pub hand_key: String,
    pub analysis_version: String,
    pub status: String,
    pub reason: Option<String>,
    pub hero_seat: Option<i64>,
    pub grade: Option<String>,
    pub score: Option<f64>,
    pub ev_loss_bb: Option<f64>,
    pub ev_loss_pot: Option<f64>,
    pub approximations: Vec<String>,
    pub pot_type: String,
    /// The hero's seat (the web's `hands.hero_position`): the top three's
    /// seat filter.
    #[serde(default)]
    pub hero_position: Option<String>,
    pub flop_library: bool,
    pub decisions: Vec<DecisionRowIn>,
}

/// What a save did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SaveOutcome {
    /// Hands written.
    pub saved: u64,
    /// Hands no longer in the store (deleted meanwhile): skipped.
    pub missing: u64,
}

/// A hand to analyse: its key, when it was played, its PHF as JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingHand {
    pub hand_key: String,
    /// `''` for a hand without a date (they come last).
    pub played_at: String,
    pub phf: String,
}

/// Where a page of [`Reader::analysis_pending`] continues: after this
/// (`played_at`, `hand_key`), newest first. A hand's `played_at` is `''`
/// without a date; [`REST`] marks the walk's last part (see
/// [`Reader::analysis_pending`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCursor {
    pub played_at: String,
    pub hand_key: String,
}

/// The `played_at` of a pending hand found in the walk's last part: hands
/// without a `hand_list` row (none, unless a statistics rebuild is filling
/// the list), by key.
pub const REST: &str = "rest";

/// How far the analysis is, at one version.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AnalysisCounts {
    /// Hands in the store.
    pub hands: u64,
    /// Hands with a row at the version.
    pub current: u64,
    /// Hands with a row of another (older) version.
    pub stale: u64,
    /// Of `current`, those analysed without the flop library that have a
    /// flop decision (analysed again once it can be reached).
    pub offline: u64,
    /// Of `current`, those the analysis could not read (`not-analysed`).
    pub not_analysable: u64,
}

impl AnalysisCounts {
    /// Hands without a row at the version.
    pub fn missing(&self) -> u64 {
        self.hands.saturating_sub(self.current)
    }
}

/// An opponent's counters, as the web's `villain_counters` returns them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VillainCounters {
    pub site: String,
    pub player: String,
    pub hands: i64,
    pub vpip_opp: i64,
    pub vpip: i64,
    pub pfr: i64,
}

/// A chart set's row (R5.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartSetRow {
    pub id: String,
    pub name: String,
    pub game_format: String,
    pub table_size: i64,
    pub stack_min_bb: i64,
    pub stack_max_bb: i64,
    pub format_version: i64,
    /// JSON object (situation key -> stored node); empty in a listing.
    pub nodes: String,
    /// Situations filled in.
    pub node_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The most tournaments with settings (R5.5), as the web's guard.
pub const TOURNAMENT_SETTINGS_MAX: i64 = 2_000;

/// The largest settings JSON (R5.5), as the web's column check.
pub const TOURNAMENT_SETTINGS_BYTES: usize = 65_536;

/// One tournament's settings (R5.5, migration 17): the JSON object the
/// library reads (`TournamentSettings`), as the screen hands it over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TournamentSettingsRow {
    /// Lower-cased, as `hands.site` on the web.
    pub site: String,
    pub tournament_id: String,
    /// JSON object.
    pub settings: String,
    pub updated_at: i64,
}

/* ----------------------------------------------------------- validation - */

fn check(ok: bool, what: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::OutOfRange(what))
    }
}

fn word_ok(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 40
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn validate(row: &HandAnalysisIn) -> Result<()> {
    check(!row.hand_key.is_empty(), "hand key")?;
    check(
        row.analysis_version
            .strip_prefix("analysis/")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        "analysis version",
    )?;
    check(
        matches!(row.status.as_str(), "full" | "partial" | "not-analysed"),
        "hand status",
    )?;
    check(
        row.grade.as_deref().is_none_or(|g| GRADES.contains(&g)),
        "hand grade",
    )?;
    check(row.decisions.len() <= DECISIONS_MAX, "decisions")?;
    check(
        row.approximations.iter().all(|a| word_ok(a)),
        "approximation",
    )?;
    for d in &row.decisions {
        check(
            matches!(d.status.as_str(), "analysed" | "not-analysed"),
            "decision status",
        )?;
        check(
            d.grade.as_deref().is_none_or(|g| GRADES.contains(&g)),
            "decision grade",
        )?;
        check(d.options.is_array(), "options")?;
        check(d.flags.is_array(), "flags")?;
        check(d.facts.is_object(), "facts")?;
        check(d.spot_key.split('|').count() == 6, "spot key")?;
        check(d.approximations.iter().all(|a| word_ok(a)), "approximation")?;
        if let Some(p) = &d.preflop {
            check(matches!(p.chart_table, 2 | 6 | 9), "chart table")?;
            check((0..169).contains(&p.hand_class), "hand class")?;
            check(
                matches!(
                    p.chart_action.as_str(),
                    "fold" | "check" | "call" | "raise" | "allin"
                ),
                "chart action",
            )?;
            check((-1..=990).contains(&p.depth_band), "depth band")?;
        }
    }
    Ok(())
}

/// A decision's worst flag, as `save_hand_analysis` derives it.
fn worst_flag(flags: &Value) -> Option<&'static str> {
    let flags = flags.as_array()?;
    if flags
        .iter()
        .any(|f| f.get("severity").and_then(Value::as_str) == Some("inaccurate"))
    {
        Some("inaccurate")
    } else if flags.is_empty() {
        None
    } else {
        Some("note")
    }
}

fn json_text(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::Corrupt(error.to_string()))
}

fn write_rows(tx: &Transaction<'_>, rows: &[HandAnalysisIn], now_ms: i64) -> Result<SaveOutcome> {
    let mut outcome = SaveOutcome::default();
    for row in rows {
        let exists = tx
            .prepare_cached("SELECT 1 FROM hands WHERE hand_key = ?1")?
            .exists([&row.hand_key])?;
        if !exists {
            outcome.missing += 1;
            continue;
        }
        tx.prepare_cached("DELETE FROM hand_analysis WHERE hand_key = ?1")?
            .execute([&row.hand_key])?;
        let decisions =
            i64::try_from(row.decisions.len()).map_err(|_| Error::OutOfRange("decisions"))?;
        let mut analysed = 0_i64;
        let mut graded = 0_i64;
        let mut flag_count = 0_i64;
        let mut hand_worst: Option<&'static str> = None;
        for d in &row.decisions {
            analysed += i64::from(d.status == "analysed");
            graded += i64::from(d.grade.is_some());
            flag_count += d
                .flags
                .as_array()
                .map_or(0, |f| i64::try_from(f.len()).unwrap_or(i64::MAX));
            match worst_flag(&d.flags) {
                Some("inaccurate") => hand_worst = Some("inaccurate"),
                Some(note) if hand_worst.is_none() => hand_worst = Some(note),
                _ => {}
            }
        }
        tx.prepare_cached(
            "INSERT INTO hand_analysis (
               hand_key, analysis_version, status, reason, hero_seat, grade, grade_rank, score,
               ev_loss_bb, ev_loss_pot, decisions, analysed, graded, flag_count, worst_flag,
               approximations, pot_type, flop_library, analysed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        )?
        .execute(params![
            row.hand_key,
            row.analysis_version,
            row.status,
            row.reason,
            row.hero_seat,
            row.grade,
            grade_rank(row.grade.as_deref()),
            row.score,
            row.ev_loss_bb,
            row.ev_loss_pot,
            decisions,
            analysed,
            graded,
            flag_count,
            hand_worst,
            json_text(&row.approximations)?,
            row.pot_type,
            row.flop_library,
            now_ms,
        ])?;
        // The hand's time ('' without one) and format, for the narrow rows.
        let (played_at, game_format): (String, String) = tx
            .prepare_cached(
                "SELECT coalesce(played_at, ''), game_format FROM hands WHERE hand_key = ?1",
            )?
            .query_row([&row.hand_key], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let hero_position = row.hero_position.as_deref().unwrap_or("");
        let mut insert = tx.prepare_cached(
            "INSERT INTO decision_analysis (
               hand_key, ord, action_index, street, action, status, reason, node, scenario, source,
               grade, grade_rank, score, ev_loss_bb, ev_loss_pot, freq_diff, options, chosen, flags,
               worst_flag, approximations, facing_bet, pot_bb, pot_odds, mdf, facts, best)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
        )?;
        let mut leak = tx.prepare_cached(
            "INSERT INTO analysis_leak_rows (
               hand_key, ord, analysis_version, played_at, game_format, hero_position, pot_type,
               spot_key, chart_set, grade, score, ev_loss_bb, ev_loss_pot, action_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        let mut chart = tx.prepare_cached(
            "INSERT INTO chart_decisions (
               hand_key, ord, analysis_version, played_at, game_format, table_size, depth_band,
               chart_key, hand_class, action, scenario, position, ev_loss_bb, action_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        for d in &row.decisions {
            // The decision's seat as the leak key files it (`facts.position`, else the hero's).
            let seat = d.spot_key.split('|').nth(3).unwrap_or("");
            if let Some(grade) = &d.grade {
                leak.execute(params![
                    row.hand_key,
                    d.ord,
                    row.analysis_version,
                    played_at,
                    game_format,
                    hero_position,
                    row.pot_type,
                    d.spot_key,
                    d.chart_set,
                    grade,
                    d.score,
                    d.ev_loss_bb.unwrap_or(0.0),
                    d.ev_loss_pot.unwrap_or(0.0),
                    d.action_index,
                ])?;
            }
            if let Some(p) = &d.preflop {
                chart.execute(params![
                    row.hand_key,
                    d.ord,
                    row.analysis_version,
                    played_at,
                    game_format,
                    p.chart_table,
                    p.depth_band,
                    p.chart_key,
                    p.hand_class,
                    p.chart_action,
                    d.scenario,
                    seat,
                    d.ev_loss_bb,
                    d.action_index,
                ])?;
            }
            insert.execute(params![
                row.hand_key,
                d.ord,
                d.action_index,
                d.street,
                d.action,
                d.status,
                d.reason,
                d.node,
                d.scenario,
                d.source,
                d.grade,
                grade_rank(d.grade.as_deref()),
                d.score,
                d.ev_loss_bb,
                d.ev_loss_pot,
                d.freq_diff,
                json_text(&d.options)?,
                d.chosen,
                json_text(&d.flags)?,
                worst_flag(&d.flags),
                json_text(&d.approximations)?,
                d.facing_bet,
                d.pot_bb,
                d.pot_odds,
                d.mdf,
                json_text(&d.facts)?,
                d.best,
            ])?;
        }
        outcome.saved += 1;
    }
    Ok(outcome)
}

impl WriterHandle {
    /// Store analysed hands (at most [`SAVE_MAX`]): each replaces the hand's
    /// row and decisions, in one transaction. Refuses the whole call when a
    /// row is malformed.
    pub fn save_analysis(&self, rows: Vec<HandAnalysisIn>, now_ms: i64) -> Result<SaveOutcome> {
        if rows.len() > SAVE_MAX {
            return Err(Error::OutOfRange("analysis rows"));
        }
        for row in &rows {
            validate(row)?;
        }
        self.write(move |tx| write_rows(tx, &rows, now_ms))
    }

    /// Forget every hand's analysis (analysed again from the start).
    pub fn clear_analysis(&self) -> Result<u64> {
        self.write(
            |tx| Ok(u64::try_from(tx.execute("DELETE FROM hand_analysis", [])?).unwrap_or(0)),
        )
    }

    /// Insert or replace a chart set (R5.3). `nodes` is the stored JSON
    /// object. Refused past [`CHART_SETS_MAX`] sets. Returns the time it
    /// was saved at.
    pub fn save_chart_set(&self, row: ChartSetRow, now_ms: i64) -> Result<i64> {
        let parsed: Value =
            serde_json::from_str(&row.nodes).map_err(|_| Error::OutOfRange("chart nodes"))?;
        check(parsed.is_object(), "chart nodes")?;
        check(
            parsed.as_object().is_some_and(|nodes| nodes.len() <= 300),
            "chart situations",
        )?;
        self.write(move |tx| {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT created_at FROM chart_sets WHERE id = ?1",
                    [&row.id],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_none() {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM chart_sets", [], |r| r.get(0))?;
                check(count < CHART_SETS_MAX, "chart sets")?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO chart_sets (
                   id, name, game_format, table_size, stack_min_bb, stack_max_bb, format_version,
                   nodes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    row.id,
                    row.name,
                    row.game_format,
                    row.table_size,
                    row.stack_min_bb,
                    row.stack_max_bb,
                    row.format_version,
                    row.nodes,
                    existing.unwrap_or(now_ms),
                    now_ms,
                ],
            )?;
            Ok(now_ms)
        })
    }

    /// Delete a chart set; whether it was there.
    pub fn delete_chart_set(&self, id: &str) -> Result<bool> {
        let id = id.to_owned();
        self.write(move |tx| Ok(tx.execute("DELETE FROM chart_sets WHERE id = ?1", [&id])? == 1))
    }

    /// Insert or replace one tournament's settings (R5.5) and send its
    /// hands back to the analysis: their stored rows go, so the next page
    /// grades them with these settings. `settings` is a JSON object the
    /// library checked (`settingsProblem`); the store holds the size and
    /// count limits. Returns how many hands' analysis went.
    pub fn save_tournament_settings(&self, row: TournamentSettingsRow, now_ms: i64) -> Result<u64> {
        let parsed: Value = serde_json::from_str(&row.settings)
            .map_err(|_| Error::OutOfRange("tournament settings"))?;
        check(parsed.is_object(), "tournament settings")?;
        check(
            row.settings.len() <= TOURNAMENT_SETTINGS_BYTES,
            "tournament settings size",
        )?;
        check(
            tournament_key_ok(&row.site, &row.tournament_id),
            "tournament",
        )?;
        self.write(move |tx| {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT created_at FROM tournament_settings WHERE site = ?1 AND tournament_id = ?2",
                    params![row.site, row.tournament_id],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_none() {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM tournament_settings", [], |r| r.get(0))?;
                check(count < TOURNAMENT_SETTINGS_MAX, "tournament settings")?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO tournament_settings (site, tournament_id, settings, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    row.site,
                    row.tournament_id,
                    row.settings,
                    existing.unwrap_or(now_ms),
                    now_ms
                ],
            )?;
            requeue_tournament(tx, &row.site, &row.tournament_id)
        })
    }

    /// Forget one tournament's settings; its hands are analysed again on
    /// the standard assumptions. Whether there were any.
    pub fn delete_tournament_settings(&self, site: &str, tournament_id: &str) -> Result<bool> {
        let (site, tournament_id) = (site.to_owned(), tournament_id.to_owned());
        self.write(move |tx| {
            let gone = tx.execute(
                "DELETE FROM tournament_settings WHERE site = ?1 AND tournament_id = ?2",
                params![site, tournament_id],
            )? == 1;
            requeue_tournament(tx, &site, &tournament_id)?;
            Ok(gone)
        })
    }
}

/// A tournament key's parts as the web's columns hold them: the site
/// lower-cased, the id trimmed, each 1-64 characters.
fn tournament_key_ok(site: &str, tournament_id: &str) -> bool {
    (1..=64).contains(&site.chars().count())
        && site == site.to_lowercase()
        && (1..=64).contains(&tournament_id.chars().count())
        && tournament_id == tournament_id.trim()
}

/// Deletes the stored analysis of a tournament's hands (every version): the
/// rows cascade to the decisions and the narrow rows. How many hands.
fn requeue_tournament(tx: &Transaction<'_>, site: &str, tournament_id: &str) -> Result<u64> {
    let gone = tx.execute(
        "DELETE FROM hand_analysis WHERE hand_key IN (
           SELECT hand_key FROM hand_stats WHERE tournament_id = ?2 AND lower(site_id) = ?1)",
        params![site, tournament_id],
    )?;
    Ok(u64::try_from(gone).unwrap_or(0))
}

/* -------------------------------------------------------------- reading - */

/// Rows of (`hand_key`, `played_at`, `phf`, `phf_size`) as pending hands.
fn push_pending(mut rows: rusqlite::Rows<'_>, out: &mut Vec<PendingHand>) -> Result<()> {
    while let Some(row) = rows.next()? {
        let size =
            u64::try_from(row.get::<_, i64>(3)?).map_err(|_| Error::OutOfRange("PHF size"))?;
        let blob = row.get_ref(2)?.as_blob().map_err(rusqlite::Error::from)?;
        out.push(PendingHand {
            hand_key: row.get(0)?,
            played_at: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            phf: decompress_phf(blob, size)?,
        });
    }
    Ok(())
}

fn pending_rows(
    conn: &Connection,
    version: &str,
    after: Option<&PendingCursor>,
    limit: u32,
) -> Result<Vec<PendingHand>> {
    // The walk is `hand_list`'s order: one narrow row per hand, clustered by
    // (`played_at` - '' without a date, so those come last -, `hand_key`),
    // read backwards from the cursor; `hands` (whose rows hold the PHF) is
    // looked up by key for the hands taken. (`hands` has no index on
    // `played_at` since migration 10.)
    let mut out = Vec::new();
    let limit_i = i64::from(limit);
    let in_rest = after.is_some_and(|c| c.played_at == REST);
    if !in_rest {
        let sql_after = "SELECT l.hand_key, l.played_at FROM hand_list l
             WHERE (l.played_at, l.hand_key) < (?2, ?3)
               AND NOT EXISTS (SELECT 1 FROM hand_analysis a
                               WHERE a.hand_key = l.hand_key AND a.analysis_version = ?1)
             ORDER BY l.played_at DESC, l.hand_key DESC
             LIMIT ?4";
        let sql_first = "SELECT l.hand_key, l.played_at FROM hand_list l
             WHERE NOT EXISTS (SELECT 1 FROM hand_analysis a
                               WHERE a.hand_key = l.hand_key AND a.analysis_version = ?1)
             ORDER BY l.played_at DESC, l.hand_key DESC
             LIMIT ?2";
        let keys: Vec<(String, String)> = match after {
            Some(cursor) => conn
                .prepare_cached(sql_after)?
                .query_map(
                    params![version, cursor.played_at, cursor.hand_key, limit_i],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
                .collect::<rusqlite::Result<_>>()?,
            None => conn
                .prepare_cached(sql_first)?
                .query_map(params![version, limit_i], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?,
        };
        let mut phf = conn
            .prepare_cached("SELECT hand_key, ?2, phf, phf_size FROM hands WHERE hand_key = ?1")?;
        for (key, played_at) in keys {
            push_pending(phf.query(params![key, played_at])?, &mut out)?;
        }
    }
    // The rest: hands without statistics, so without a list row (none,
    // unless a statistics rebuild is filling them), by key - read only once
    // the walk is through, and only when the counts say there are such
    // hands (both counts read an index).
    let left = limit_i - i64::try_from(out.len()).unwrap_or(limit_i);
    if left > 0 {
        let hands: i64 = conn
            .prepare_cached("SELECT count(*) FROM hands")?
            .query_row([], |row| row.get(0))?;
        let listed: i64 = conn
            .prepare_cached("SELECT count(*) FROM hand_list")?
            .query_row([], |row| row.get(0))?;
        if listed < hands {
            let key = after.filter(|_| in_rest).map(|c| c.hand_key.as_str());
            let mut stmt = conn.prepare_cached(
                "SELECT h.hand_key, ?4, h.phf, h.phf_size FROM hands h
                 WHERE (?2 IS NULL OR h.hand_key < ?2)
                   AND NOT EXISTS (SELECT 1 FROM hand_stats s WHERE s.hand_key = h.hand_key)
                   AND NOT EXISTS (SELECT 1 FROM hand_analysis a
                                   WHERE a.hand_key = h.hand_key AND a.analysis_version = ?1)
                 ORDER BY h.hand_key DESC
                 LIMIT ?3",
            )?;
            push_pending(stmt.query(params![version, key, left, REST])?, &mut out)?;
        }
    }
    Ok(out)
}

/// A stored decision row in `analysis_hand`'s shape.
fn decision_json(row: &rusqlite::Row<'_>) -> Result<Value> {
    let parse = |index: usize| -> Result<Value> {
        let text: String = row.get(index)?;
        serde_json::from_str(&text).map_err(|error| Error::Corrupt(error.to_string()))
    };
    Ok(json!({
        "ord": row.get::<_, i64>(0)?,
        "actionIndex": row.get::<_, i64>(1)?,
        "street": row.get::<_, String>(2)?,
        "action": row.get::<_, String>(3)?,
        "status": row.get::<_, String>(4)?,
        "reason": row.get::<_, Option<String>>(5)?,
        "node": row.get::<_, String>(6)?,
        "scenario": row.get::<_, String>(7)?,
        "source": row.get::<_, String>(8)?,
        "grade": row.get::<_, Option<String>>(9)?,
        "score": row.get::<_, Option<f64>>(10)?,
        "evLossBb": row.get::<_, Option<f64>>(11)?,
        "evLossPot": row.get::<_, Option<f64>>(12)?,
        "freqDiff": row.get::<_, Option<f64>>(13)?,
        "options": parse(14)?,
        "chosen": row.get::<_, Option<i64>>(15)?,
        "flags": parse(16)?,
        "worstFlag": row.get::<_, Option<String>>(17)?,
        "approximations": parse(18)?,
        "facts": parse(19)?,
    }))
}

fn hand_json(conn: &Connection, hand_key: &str) -> Result<Option<Value>> {
    let head = conn
        .prepare_cached(
            "SELECT analysis_version, status, reason, hero_seat, grade, score, ev_loss_bb,
                    ev_loss_pot, flag_count, worst_flag, approximations, pot_type, flop_library,
                    analysed_at
             FROM hand_analysis WHERE hand_key = ?1",
        )?
        .query_row([hand_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
                row.get::<_, Option<f64>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, bool>(12)?,
                row.get::<_, i64>(13)?,
            ))
        })
        .optional()?;
    let Some(head) = head else {
        return Ok(None);
    };
    let mut stmt = conn.prepare_cached(
        "SELECT ord, action_index, street, action, status, reason, node, scenario, source, grade,
                score, ev_loss_bb, ev_loss_pot, freq_diff, options, chosen, flags, worst_flag,
                approximations, facts
         FROM decision_analysis WHERE hand_key = ?1 ORDER BY ord",
    )?;
    let mut rows = stmt.query([hand_key])?;
    let mut decisions = Vec::new();
    while let Some(row) = rows.next()? {
        decisions.push(decision_json(row)?);
    }
    let approximations: Value =
        serde_json::from_str(&head.10).map_err(|error| Error::Corrupt(error.to_string()))?;
    let mut out = Map::new();
    out.insert("handId".into(), json!(hand_key));
    out.insert("analysisVersion".into(), json!(head.0));
    out.insert("status".into(), json!(head.1));
    out.insert("reason".into(), json!(head.2));
    out.insert("heroSeat".into(), json!(head.3));
    out.insert("grade".into(), json!(head.4));
    out.insert("score".into(), json!(head.5));
    out.insert("evLossBb".into(), json!(head.6));
    out.insert("evLossPot".into(), json!(head.7));
    out.insert("flagCount".into(), json!(head.8));
    out.insert("worstFlag".into(), json!(head.9));
    out.insert("approximations".into(), approximations);
    out.insert("potType".into(), json!(head.11));
    out.insert("flopLibrary".into(), json!(head.12));
    out.insert("analysedAt".into(), json!(head.13));
    out.insert("decisions".into(), Value::Array(decisions));
    Ok(Some(Value::Object(out)))
}

impl Reader {
    /// Hands without a row at `version`, newest first, at most `limit`
    /// ([`PENDING_MAX`]), after `after`.
    pub fn analysis_pending(
        &self,
        version: &str,
        after: Option<&PendingCursor>,
        limit: u32,
    ) -> Result<Vec<PendingHand>> {
        let limit = limit.clamp(1, PENDING_MAX);
        self.with(|conn| pending_rows(conn, version, after, limit))
    }

    /// Hands analysed at `version` without the flop library that have a
    /// flop decision, newest first, at most `limit`: to analyse again now
    /// that it can be reached.
    pub fn analysis_offline(&self, version: &str, limit: u32) -> Result<Vec<PendingHand>> {
        let limit = i64::from(limit.clamp(1, PENDING_MAX));
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT h.hand_key, h.played_at, h.phf, h.phf_size
                 FROM hand_analysis a
                 CROSS JOIN hands h ON h.hand_key = a.hand_key
                 WHERE a.analysis_version = ?1 AND a.flop_library = 0
                   AND EXISTS (SELECT 1 FROM decision_analysis d
                               WHERE d.hand_key = a.hand_key AND d.street = 'flop')
                 ORDER BY coalesce(h.played_at, '') DESC, h.hand_key DESC
                 LIMIT ?2",
            )?;
            let mut out = Vec::new();
            push_pending(stmt.query(params![version, limit])?, &mut out)?;
            Ok(out)
        })
    }

    /// How far the analysis is at `version`.
    pub fn analysis_counts(&self, version: &str) -> Result<AnalysisCounts> {
        self.with(|conn| {
            let count = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<u64> {
                let n: i64 = conn
                    .prepare_cached(sql)?
                    .query_row(args, |row| row.get(0))?;
                u64::try_from(n).map_err(|_| Error::OutOfRange("count"))
            };
            let hands = count("SELECT count(*) FROM hands", &[])?;
            let all = count("SELECT count(*) FROM hand_analysis", &[])?;
            let current = count(
                "SELECT count(*) FROM hand_analysis WHERE analysis_version = ?1",
                &[&version],
            )?;
            let offline = count(
                "SELECT count(*) FROM hand_analysis a
                 WHERE a.analysis_version = ?1 AND a.flop_library = 0
                   AND EXISTS (SELECT 1 FROM decision_analysis d
                               WHERE d.hand_key = a.hand_key AND d.street = 'flop')",
                &[&version],
            )?;
            let not_analysable = count(
                "SELECT count(*) FROM hand_analysis
                 WHERE analysis_version = ?1 AND status = 'not-analysed'",
                &[&version],
            )?;
            Ok(AnalysisCounts {
                hands,
                current,
                stale: all.saturating_sub(current),
                offline,
                not_analysable,
            })
        })
    }

    /// A hand's stored analysis in the shape of the web's `analysis_hand`
    /// (with `flopLibrary` and `analysedAt`); `None` when it has none. The
    /// caller checks `analysisVersion`.
    pub fn hand_analysis(&self, hand_key: &str) -> Result<Option<Value>> {
        self.with(|conn| hand_json(conn, hand_key))
    }

    /// The web's `villain_counters` over this store: per named opponent of
    /// a room with real names, their own seat rows (never the hero's) in
    /// games of `game_format` (`None`: every format), bomb pots out, summed;
    /// only those with at least `min_hands`. In (site, player) order.
    pub fn villain_counters(
        &self,
        players: &[(String, String)],
        game_format: Option<&str>,
        min_hands: i64,
    ) -> Result<Vec<VillainCounters>> {
        if players.len() > VILLAIN_MAX {
            return Err(Error::OutOfRange("villain players"));
        }
        let wanted: std::collections::BTreeSet<(&str, &str)> = players
            .iter()
            .filter(|(site, player)| !site.trim().is_empty() && !player.is_empty())
            .map(|(site, player)| (site.as_str(), player.as_str()))
            .collect();
        let hands_at = Counter::hands.index();
        let vpip_opp_at = Counter::vpip_opp.index();
        let vpip_at = Counter::vpip.index();
        let pfr_at = Counter::pfr.index();
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT d.site_id, g.game_format, d.is_bomb_pot, d.site_anonymization, s.totals
                 FROM player_hands p
                 CROSS JOIN seat_stats s ON s.hand_id = p.hand_id AND s.seat = p.seat
                 CROSS JOIN hand_stats d ON d.id = p.hand_id
                 CROSS JOIN segments g ON g.id = d.segment_id
                 WHERE p.player = ?1 AND s.is_hero = 0",
            )?;
            let mut sums: BTreeMap<(String, String), [i64; 4]> = BTreeMap::new();
            let players_named: std::collections::BTreeSet<&str> =
                wanted.iter().map(|(_, p)| *p).collect();
            for player in players_named {
                let mut rows = stmt.query([player])?;
                while let Some(row) = rows.next()? {
                    let site: String = row.get(0)?;
                    if !wanted.contains(&(site.as_str(), player)) {
                        continue;
                    }
                    let format: String = row.get(1)?;
                    let bomb: bool = row.get(2)?;
                    let anonymization: String = row.get(3)?;
                    if bomb || anonymization != "none" || game_format.is_some_and(|f| f != format) {
                        continue;
                    }
                    let values =
                        decode_seat(row.get_ref(4)?.as_blob().map_err(rusqlite::Error::from)?)?;
                    let sum = sums.entry((site, player.to_owned())).or_insert([0; 4]);
                    sum[0] += i64::from(values.counters[hands_at]);
                    sum[1] += i64::from(values.counters[vpip_opp_at]);
                    sum[2] += i64::from(values.counters[vpip_at]);
                    sum[3] += i64::from(values.counters[pfr_at]);
                }
            }
            Ok(sums
                .into_iter()
                .filter(|(_, sum)| sum[0] >= min_hands.max(1))
                .map(|((site, player), sum)| VillainCounters {
                    site,
                    player,
                    hands: sum[0],
                    vpip_opp: sum[1],
                    vpip: sum[2],
                    pfr: sum[3],
                })
                .collect())
        })
    }

    /// The chart sets (R5.3), newest change first, without their nodes.
    pub fn chart_sets(&self) -> Result<Vec<ChartSetRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, name, game_format, table_size, stack_min_bb, stack_max_bb,
                        format_version, nodes, created_at, updated_at
                 FROM chart_sets ORDER BY updated_at DESC, id",
            )?;
            let mut rows = stmt.query([])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let mut set = chart_row(row)?;
                set.nodes = String::new();
                out.push(set);
            }
            Ok(out)
        })
    }

    /// One chart set with its nodes.
    pub fn chart_set(&self, id: &str) -> Result<Option<ChartSetRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, name, game_format, table_size, stack_min_bb, stack_max_bb,
                        format_version, nodes, created_at, updated_at
                 FROM chart_sets WHERE id = ?1",
            )?;
            let mut rows = stmt.query([id])?;
            match rows.next()? {
                Some(row) => Ok(Some(chart_row(row)?)),
                None => Ok(None),
            }
        })
    }

    /// Every tournament's settings (R5.5), newest change first.
    pub fn tournament_settings(&self) -> Result<Vec<TournamentSettingsRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT site, tournament_id, settings, updated_at FROM tournament_settings
                 ORDER BY updated_at DESC, site, tournament_id",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(TournamentSettingsRow {
                    site: r.get(0)?,
                    tournament_id: r.get(1)?,
                    settings: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
}

fn chart_row(row: &rusqlite::Row<'_>) -> Result<ChartSetRow> {
    let nodes: String = row.get(7)?;
    let node_count = serde_json::from_str::<Value>(&nodes)
        .ok()
        .and_then(|v| v.as_object().map(|o| i64::try_from(o.len()).unwrap_or(0)))
        .unwrap_or(0);
    Ok(ChartSetRow {
        id: row.get(0)?,
        name: row.get(1)?,
        game_format: row.get(2)?,
        table_size: row.get(3)?,
        stack_min_bb: row.get(4)?,
        stack_max_bb: row.get(5)?,
        format_version: row.get(6)?,
        nodes,
        node_count,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grade_ranks() {
        assert_eq!(grade_rank(None), 0);
        assert_eq!(grade_rank(Some("perfect")), 1);
        assert_eq!(grade_rank(Some("blunder")), 5);
        assert_eq!(grade_rank(Some("nonsense")), 0);
    }

    #[test]
    fn worst_flags() {
        assert_eq!(worst_flag(&json!([])), None);
        assert_eq!(
            worst_flag(&json!([{"code": "a", "severity": "note"}])),
            Some("note")
        );
        assert_eq!(
            worst_flag(
                &json!([{"code": "a", "severity": "note"}, {"code": "b", "severity": "inaccurate"}])
            ),
            Some("inaccurate")
        );
    }
}

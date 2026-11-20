//! Multiway pots and bomb pots on their own (analysis/45): the Analysis
//! screen's Multiway and Bomb pots tabs. The other tabs read heads-up pots
//! only (`leaks::LeakFilters::pot_kind`, the session review), because Rail's
//! references are solved heads-up; these two read the rest.
//!
//! - **Multiway**: cash hands with no bomb pot in which at least one of the
//!   hero's decisions had three or more players in it (a `-mw-` scenario).
//!   Summed here from the stored analyses and `hand_list`.
//! - **Bomb pots**: the hands themselves (their PHF), summed by the window
//!   (`lib/potKinds`), since what matters there - the ante, the first move
//!   on the flop, how often a first bet takes the pot - is read from the
//!   actions, not from a grade.

use rusqlite::params;
use serde::Serialize;

use crate::batch::decompress_phf;
use crate::error::{Error, Result};
use crate::read::Reader;

/// Hands a multiway or bomb pot list reads at most.
const MAX_BOMB_HANDS: i64 = 20_000;

/// The multiway hands' sums.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiwaySummary {
    pub hands: i64,
    /// The hero's result over those hands, in thousandths of a big blind
    /// (`hand_list.hero_net_bb_milli`; the window divides).
    pub net_bb_milli: i64,
    pub showdown_bb_milli: i64,
    pub non_showdown_bb_milli: i64,
    /// The hero's decisions with three or more players in.
    pub decisions: i64,
    /// Of those, the ones graded (calls and folds facing a bet, A9).
    pub graded: i64,
    /// Graded decisions by grade: perfect, good, inaccurate, mistake, blunder.
    pub grades: [i64; 5],
    /// By the players in at the decision (3, 4, 5 meaning 5 or more).
    pub by_players: Vec<PlayersRow>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayersRow {
    pub players: i64,
    pub decisions: i64,
    pub graded: i64,
    pub off: i64,
    pub ev_loss_bb: f64,
}

/// A decision worth a second look: graded Inaccurate or worse.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PotKindDecision {
    pub hand_key: String,
    pub ord: i64,
    pub action_index: i64,
    pub played_at: Option<String>,
    pub street: String,
    pub action: String,
    pub scenario: String,
    pub grade: String,
    pub ev_loss_bb: f64,
    pub hero_cards: Option<String>,
    pub position: Option<String>,
    pub players: Option<i64>,
}

/// The decisions of one pot kind (`d`, joined to `a` hand_analysis and `h` hands).
fn kind_clause(kind: &str) -> Result<&'static str> {
    match kind {
        "mw" => Ok("a.pot_type <> 'bomb' AND instr(d.scenario, '-mw-') > 0"),
        "bomb" => Ok("a.pot_type = 'bomb'"),
        _ => Err(Error::OutOfRange("pot kind")),
    }
}

impl Reader {
    /// The multiway hands' sums at `version` (cash only).
    pub fn multiway_summary(&self, version: &str) -> Result<MultiwaySummary> {
        self.with(|conn| {
            let mut out = MultiwaySummary::default();
            // The hands: at least one multiway decision of the hero's.
            let (hands, net, sd, nsd): (i64, i64, i64, i64) = conn
                .prepare_cached(
                    "WITH mw AS (
                       SELECT DISTINCT a.hand_key
                       FROM hand_analysis a
                       JOIN decision_analysis d ON d.hand_key = a.hand_key
                       JOIN hands h ON h.hand_key = a.hand_key
                       WHERE a.analysis_version = ?1 AND h.game_format = 'cash'
                         AND a.pot_type <> 'bomb' AND instr(d.scenario, '-mw-') > 0
                     )
                     SELECT count(*), coalesce(sum(l.hero_net_bb_milli), 0),
                            coalesce(sum(CASE WHEN l.hero_wtsd = 1 THEN l.hero_net_bb_milli END), 0),
                            coalesce(sum(CASE WHEN l.hero_wtsd = 0 THEN l.hero_net_bb_milli END), 0)
                     FROM mw JOIN hand_list l ON l.hand_key = mw.hand_key
                     WHERE l.hero_net_bb_milli IS NOT NULL",
                )?
                .query_row([version], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
            out.hands = hands;
            out.net_bb_milli = net;
            out.showdown_bb_milli = sd;
            out.non_showdown_bb_milli = nsd;

            let mut stmt = conn.prepare_cached(
                "SELECT min(coalesce(json_extract(d.facts, '$.players'), 3), 5) AS p,
                        count(*), sum(d.grade IS NOT NULL),
                        sum(d.grade_rank >= 3), total(CASE WHEN d.grade IS NOT NULL THEN d.ev_loss_bb END),
                        sum(d.grade = 'perfect'), sum(d.grade = 'good'), sum(d.grade = 'inaccurate'),
                        sum(d.grade = 'mistake'), sum(d.grade = 'blunder')
                 FROM hand_analysis a
                 JOIN decision_analysis d ON d.hand_key = a.hand_key
                 JOIN hands h ON h.hand_key = a.hand_key
                 WHERE a.analysis_version = ?1 AND h.game_format = 'cash'
                   AND a.pot_type <> 'bomb' AND instr(d.scenario, '-mw-') > 0
                 GROUP BY p ORDER BY p",
            )?;
            let mut rows = stmt.query([version])?;
            while let Some(row) = rows.next()? {
                let row_out = PlayersRow {
                    players: row.get(0)?,
                    decisions: row.get(1)?,
                    graded: row.get(2)?,
                    off: row.get(3)?,
                    ev_loss_bb: row.get(4)?,
                };
                out.decisions += row_out.decisions;
                out.graded += row_out.graded;
                for (i, slot) in out.grades.iter_mut().enumerate() {
                    *slot += row.get::<_, i64>(5 + i)?;
                }
                out.by_players.push(row_out);
            }
            Ok(out)
        })
    }

    /// The costliest decisions of one pot kind (`mw` or `bomb`) graded
    /// Inaccurate or worse at `version`, most EV lost first (cash only).
    pub fn pot_kind_decisions(
        &self,
        version: &str,
        kind: &str,
        limit: usize,
    ) -> Result<Vec<PotKindDecision>> {
        let clause = kind_clause(kind)?;
        let limit = i64::try_from(limit.clamp(1, 50)).unwrap_or(50);
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT a.hand_key, d.ord, d.action_index, h.played_at, d.street, d.action,
                        d.scenario, d.grade, d.ev_loss_bb, l.hero_cards,
                        json_extract(d.facts, '$.position'), json_extract(d.facts, '$.players')
                 FROM hand_analysis a
                 JOIN decision_analysis d ON d.hand_key = a.hand_key
                 JOIN hands h ON h.hand_key = a.hand_key
                 LEFT JOIN hand_list l ON l.hand_key = a.hand_key
                 WHERE a.analysis_version = ?1 AND h.game_format = 'cash' AND {clause}
                   AND d.grade_rank >= 3
                 ORDER BY d.ev_loss_bb DESC, h.played_at DESC, a.hand_key, d.ord
                 LIMIT ?2"
            ))?;
            let rows = stmt.query_map(params![version, limit], |row| {
                Ok(PotKindDecision {
                    hand_key: row.get(0)?,
                    ord: row.get(1)?,
                    action_index: row.get(2)?,
                    played_at: row.get(3)?,
                    street: row.get(4)?,
                    action: row.get(5)?,
                    scenario: row.get(6)?,
                    grade: row.get(7)?,
                    ev_loss_bb: row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
                    hero_cards: row.get(9)?,
                    position: row.get(10)?,
                    players: row.get(11)?,
                })
            })?;
            Ok(rows.collect::<std::result::Result<_, _>>()?)
        })
    }

    /// Every stored bomb pot's PHF JSON (cash, newest first), for the window
    /// to sum (`lib/potKinds`).
    pub fn bomb_pot_phfs(&self) -> Result<Vec<String>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT h.phf, h.phf_size
                 FROM hand_stats s
                 JOIN hands h ON h.hand_key = s.hand_key
                 WHERE s.is_bomb_pot = 1 AND h.game_format = 'cash'
                 ORDER BY h.played_at DESC
                 LIMIT ?1",
            )?;
            let mut rows = stmt.query([MAX_BOMB_HANDS])?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let blob: Vec<u8> = row.get(0)?;
                let size = u64::try_from(row.get::<_, i64>(1)?)
                    .map_err(|_| Error::OutOfRange("PHF size"))?;
                out.push(decompress_phf(&blob, size)?);
            }
            Ok(out)
        })
    }
}

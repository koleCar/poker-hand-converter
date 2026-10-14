//! Local statistics, the read side (R2.3): what the HUD (R3.7), the
//! display definitions (R2.4) and the desktop's reports (R2.7) ask.
//!
//! - **A player's rollup** for one segment ([`Reader::player_rollup`]) or
//!   for every segment of a site ([`Reader::player_rollups`]): a range of
//!   `player_rollups`' primary key, `(site, player, scope, segment)`. The
//!   sums are `aggregate`'s with its defaults (bomb pots out, EV-cashout
//!   money out).
//! - **The HUD's lookup** ([`Reader::hud_totals`]): one sum per player of a
//!   table, over the segments the HUD counts (the table's own, a set of
//!   them, or all of the site's): one key range per player.
//! - **The hero's totals** ([`Reader::hero_totals`]) by segment and
//!   position over a date range, with any of `aggregate`'s options: whole
//!   UTC days from `hero_rollups`, the partial days at the two ends from the
//!   hero's seat rows (exact for any range: a report's local-time range is
//!   passed as UTC instants), and the all-in EV adjustment from the few
//!   stored `ev_rows`.
//!
//! Every sum is of the current generation (see `stats`): during a rebuild
//! the numbers grow as the background pass gets through the hands.

use std::collections::BTreeMap;

use rail_core::phf::{GameFormat, LimitType, Variant};
use rail_equity::EV_VERSION;
use rail_stats::{Segment, SizeClass, Stake};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, params, params_from_iter};

use crate::error::{Error, Result};
use crate::read::Reader;
use crate::stats::{
    Exclusions, KIND_BOMB_POT, KIND_CASHOUT, KIND_STRADDLED, RebuildState, Totals, current_gen,
    decode_seat, kv_get, rebuild_state, total_columns,
};

/// A segment and its id in this store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentRow {
    pub id: i64,
    pub segment: Segment,
}

/// One row of `player_rollups`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rollup {
    pub segment_id: i64,
    /// The newest `played_at` counted.
    pub last_played_at: Option<String>,
    pub totals: Totals,
}

/// Which hero rows [`Reader::hero_totals`] sums. `None` is "all".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeroFilter {
    /// `segments.id`s.
    pub segments: Option<Vec<i64>>,
    /// Positions (`BTN`, `UTG+1`, ...; `""` for a seat the engine gave
    /// none).
    pub positions: Option<Vec<String>>,
    /// From this instant on, ISO UTC as PHF writes it
    /// (`2026-02-17T00:00:00.000Z`), inclusive. A bound leaves out hands
    /// without a `played_at`.
    pub from: Option<String>,
    /// Before this instant, exclusive.
    pub to: Option<String>,
    /// `aggregate`'s options; the default is its default.
    pub exclusions: Exclusions,
}

/// The all-in EV adjustment of a set of hero hands: EV net = net + `net`,
/// EV bb = net_bb_milli + `bb_milli` (`money` hands only, as the money).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvAdjust {
    /// Hands with an all-in evaluated (`applicable` rows).
    pub applicable: i64,
    /// Sum of `ev_net - net` over them, minor units.
    pub net: i64,
    /// Sum of `ev_net_bb_milli - net_bb_milli` over them.
    pub bb_milli: i64,
    /// Hands the background pass has not evaluated yet (their adjustment is
    /// missing from the sums).
    pub pending: i64,
}

impl EvAdjust {
    fn add(&mut self, other: &Self) {
        self.applicable += other.applicable;
        self.net += other.net;
        self.bb_milli += other.bb_milli;
        self.pending += other.pending;
    }
}

/// The hero's sums for one (segment, position).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeroTotal {
    pub segment_id: i64,
    pub position: String,
    pub totals: Totals,
    pub ev: EvAdjust,
}

impl HeroTotal {
    /// The inputs of a display definition (`rail_stats::display`, R2.4),
    /// with the all-in EV result: `net_bb_milli` plus the adjustment of the
    /// evaluated all-ins (hands still queued count at their result).
    pub fn sums(&self) -> rail_stats::display::Sums {
        let mut sums = self.totals.sums();
        sums.ev_net_bb_milli = self
            .totals
            .money("net_bb_milli")
            .map(|net| net + self.ev.bb_milli);
        sums
    }
}

/// Several of [`Reader::hero_totals`]' rows summed: a report's group (all
/// of a filter, a position, a stake...), with its all-in EV adjustment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeroSum {
    pub totals: Totals,
    pub ev: EvAdjust,
}

impl HeroSum {
    /// The sum of `totals`.
    pub fn of<'a>(totals: impl IntoIterator<Item = &'a HeroTotal>) -> Self {
        let mut sum = Self::default();
        for total in totals {
            sum.add(total);
        }
        sum
    }

    /// Add one row (its money is already what the filter's exclusions
    /// admit).
    pub fn add(&mut self, total: &HeroTotal) {
        self.totals.add(&total.totals, true);
        self.ev.add(&total.ev);
    }

    /// The inputs of a display definition, as [`HeroTotal::sums`].
    pub fn sums(&self) -> rail_stats::display::Sums {
        let mut sums = self.totals.sums();
        sums.ev_net_bb_milli = self
            .totals
            .money("net_bb_milli")
            .map(|net| net + self.ev.bb_milli);
        sums
    }
}

/// Where the statistics stand, for the status line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatsStatus {
    /// The `STATS_VERSION` the rollups are built under.
    pub stats_version: Option<String>,
    /// The `EV_VERSION` the hero hands are evaluated at or queued for.
    pub ev_version: Option<String>,
    pub generation: i64,
    /// A rebuild in progress.
    pub rebuild: Option<RebuildState>,
    /// Hands waiting for the background EV pass.
    pub ev_pending: u64,
}

fn segment_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<SegmentRow> {
    let text = |i: usize| row.get::<_, String>(i);
    let wrong = |i: usize, what: &str| {
        rusqlite::Error::FromSqlConversionFailure(
            i,
            rusqlite::types::Type::Text,
            format!("not a {what}").into(),
        )
    };
    let format = match text(2)?.as_str() {
        "cash" => GameFormat::Cash,
        "tournament" => GameFormat::Tournament,
        "sng" => GameFormat::Sng,
        "spin" => GameFormat::Spin,
        _ => return Err(wrong(2, "game format")),
    };
    let variant = serde_json::from_value::<Variant>(serde_json::Value::String(text(3)?))
        .map_err(|_| wrong(3, "variant"))?;
    let limit = match text(4)?.as_str() {
        "nl" => LimitType::Nl,
        "pl" => LimitType::Pl,
        "fl" => LimitType::Fl,
        _ => return Err(wrong(4, "limit")),
    };
    let size = SizeClass::from_name(&text(5)?).ok_or_else(|| wrong(5, "size class"))?;
    let stake = Stake::from_key(&text(6)?).ok_or_else(|| wrong(6, "stake"))?;
    Ok(SegmentRow {
        id: row.get(0)?,
        segment: Segment {
            site: text(1)?,
            format,
            variant,
            limit,
            size,
            stake,
        },
    })
}

fn rollup_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Rollup> {
    Ok(Rollup {
        segment_id: row.get(0)?,
        last_played_at: row.get(1)?,
        totals: Totals::from_row(row, 2)?,
    })
}

/// ` AND column IN (?n, ...)` over `values`, appended to `params`; `""` for
/// no filter.
fn in_list(column: &str, values: Option<Vec<Value>>, params: &mut Vec<Value>) -> String {
    match values {
        None => String::new(),
        Some(values) => {
            let marks: Vec<String> = values
                .into_iter()
                .map(|value| {
                    params.push(value);
                    format!("?{}", params.len())
                })
                .collect();
            format!(" AND {column} IN ({})", marks.join(", "))
        }
    }
}

/// ` AND column >= ?n` / `< ?n`, appended to `params`.
fn bound(column: &str, op: &str, value: &str, params: &mut Vec<Value>) -> String {
    params.push(Value::Text(value.to_owned()));
    format!(" AND {column} {op} ?{}", params.len())
}

/// A date range split for the two sources: whole UTC days for
/// `hero_rollups` (`day` strictly between `lo` and `hi`) and the partial
/// days at the ends as `played_at` ranges for the seat rows.
#[derive(Debug, Default)]
struct DayRanges {
    /// `None` for both: every day, undated hands included. `Some("")` as
    /// `lo` leaves out the undated ones.
    lo: Option<String>,
    hi: Option<String>,
    /// No whole day inside the range.
    no_days: bool,
    edges: Vec<(String, String)>,
}

/// The day of an ISO instant (its first ten characters).
fn day(instant: &str) -> Result<&str> {
    instant.get(..10).ok_or(Error::OutOfRange("date bound"))
}

/// The end of a day as a `played_at` bound: every `YYYY-MM-DDT...` of the
/// day sorts before `YYYY-MM-DDU`.
fn end_of(day: &str) -> String {
    format!("{day}U")
}

fn day_ranges(from: Option<&str>, to: Option<&str>) -> Result<DayRanges> {
    Ok(match (from, to) {
        (None, None) => DayRanges::default(),
        (Some(from), None) => DayRanges {
            lo: Some(day(from)?.to_owned()),
            edges: vec![(from.to_owned(), end_of(day(from)?))],
            ..DayRanges::default()
        },
        (None, Some(to)) => DayRanges {
            lo: Some(String::new()),
            hi: Some(day(to)?.to_owned()),
            edges: vec![(day(to)?.to_owned(), to.to_owned())],
            ..DayRanges::default()
        },
        (Some(from), Some(to)) if from >= to => DayRanges {
            no_days: true,
            ..DayRanges::default()
        },
        (Some(from), Some(to)) if day(from)? == day(to)? => DayRanges {
            no_days: true,
            edges: vec![(from.to_owned(), to.to_owned())],
            ..DayRanges::default()
        },
        (Some(from), Some(to)) => DayRanges {
            lo: Some(day(from)?.to_owned()),
            hi: Some(day(to)?.to_owned()),
            no_days: false,
            edges: vec![
                (from.to_owned(), end_of(day(from)?)),
                (day(to)?.to_owned(), to.to_owned()),
            ],
        },
    })
}

/// The kind of a hand from its `hand_stats` flags (columns `first..+3`:
/// bomb pot, straddle, cashout).
fn kind_from(row: &rusqlite::Row<'_>, first: usize) -> rusqlite::Result<i64> {
    Ok((if row.get::<_, bool>(first)? {
        KIND_BOMB_POT
    } else {
        0
    }) | (if row.get::<_, bool>(first + 1)? {
        KIND_STRADDLED
    } else {
        0
    }) | (if row.get::<_, bool>(first + 2)? {
        KIND_CASHOUT
    } else {
        0
    }))
}

/// The (segment, position) entry of `out`, made empty when new.
fn slot(
    out: &mut BTreeMap<(i64, String), HeroTotal>,
    segment_id: i64,
    position: String,
) -> &mut HeroTotal {
    out.entry((segment_id, position.clone()))
        .or_insert_with(|| HeroTotal {
            segment_id,
            position,
            totals: Totals::default(),
            ev: EvAdjust::default(),
        })
}

fn decode_error(error: Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Blob,
        error.to_string().into(),
    )
}

impl Reader {
    /// Every segment this store has seen.
    pub fn segments(&self) -> Result<Vec<SegmentRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, site, game_format, variant, limit_type, size_class, stake
                 FROM segments ORDER BY id",
            )?;
            let rows = stmt.query_map([], segment_from)?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// The id of `segment`, when this store has seen it.
    pub fn segment_id(&self, segment: &Segment) -> Result<Option<i64>> {
        self.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT id FROM segments
                     WHERE site = ?1 AND game_format = ?2 AND variant = ?3 AND limit_type = ?4
                       AND size_class = ?5 AND stake = ?6",
                )?
                .query_row(
                    params![
                        segment.site,
                        segment.format.as_str(),
                        segment.variant.as_str(),
                        segment.limit.as_str(),
                        segment.size.as_str(),
                        segment.stake.key()
                    ],
                    |row| row.get(0),
                )
                .optional()?)
        })
    }

    /// A player's rollup in one segment. `site` is the site key
    /// ([`rail_stats::site_key`]); `scope` is `""` for a screen name (see
    /// [`rail_stats::rollup_scope`]).
    pub fn player_rollup(
        &self,
        site: &str,
        player: &str,
        scope: &str,
        segment_id: i64,
    ) -> Result<Option<Rollup>> {
        self.with(|conn| {
            let sql = format!(
                "SELECT segment_id, last_played_at, {} FROM player_rollups
                 WHERE site = ?1 AND player = ?2 AND scope = ?3 AND segment_id = ?4",
                total_columns(str::to_owned)
            );
            Ok(conn
                .prepare_cached(&sql)?
                .query_row(params![site, player, scope, segment_id], rollup_from)
                .optional()?)
        })
    }

    /// A player's rollups in every segment of a site.
    pub fn player_rollups(&self, site: &str, player: &str, scope: &str) -> Result<Vec<Rollup>> {
        self.with(|conn| {
            let sql = format!(
                "SELECT segment_id, last_played_at, {} FROM player_rollups
                 WHERE site = ?1 AND player = ?2 AND scope = ?3 ORDER BY segment_id",
                total_columns(str::to_owned)
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map(params![site, player, scope], rollup_from)?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// The HUD's lookup: for each `(player, scope)` of a table on `site`,
    /// its totals summed over `segments` (`None`: every segment of the
    /// site). One connection, one prepared statement, one key range per
    /// player.
    pub fn hud_totals(
        &self,
        site: &str,
        players: &[(&str, &str)],
        segments: Option<&[i64]>,
    ) -> Result<Vec<Totals>> {
        self.with(|conn| {
            let sql = format!(
                "SELECT segment_id, last_played_at, {} FROM player_rollups
                 WHERE site = ?1 AND player = ?2 AND scope = ?3",
                total_columns(str::to_owned)
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut out = Vec::with_capacity(players.len());
            for (player, scope) in players {
                let mut sum = Totals::default();
                let mut rows = stmt.query(params![site, player, scope])?;
                while let Some(row) = rows.next()? {
                    let rollup = rollup_from(row)?;
                    if segments.is_none_or(|wanted| wanted.contains(&rollup.segment_id)) {
                        sum.add(&rollup.totals, true);
                    }
                }
                out.push(sum);
            }
            Ok(out)
        })
    }

    /// The hero's totals per (segment, position) over `filter`, with the
    /// all-in EV adjustment. Sorted by segment, then position.
    pub fn hero_totals(&self, filter: &HeroFilter) -> Result<Vec<HeroTotal>> {
        let ranges = day_ranges(filter.from.as_deref(), filter.to.as_deref())?;
        let exclusions = filter.exclusions;
        let segments = || {
            filter
                .segments
                .as_ref()
                .map(|ids| ids.iter().map(|&id| Value::Integer(id)).collect())
        };
        let positions = || {
            filter
                .positions
                .as_ref()
                .map(|list| list.iter().map(|p| Value::Text(p.clone())).collect())
        };
        self.with(|conn| {
            let generation = current_gen(conn)?;
            let mut out: BTreeMap<(i64, String), HeroTotal> = BTreeMap::new();

            // Whole days, from the rollups.
            if !ranges.no_days {
                let mut params: Vec<Value> = Vec::new();
                let mut sql = format!(
                    "SELECT segment_id, position, kind, {} FROM hero_rollups WHERE 1",
                    total_columns(|c| format!("sum({c})"))
                );
                sql += &in_list("segment_id", segments(), &mut params);
                sql += &in_list("position", positions(), &mut params);
                if let Some(lo) = &ranges.lo {
                    sql += &bound("day", ">", lo, &mut params);
                }
                if let Some(hi) = &ranges.hi {
                    sql += &bound("day", "<", hi, &mut params);
                }
                sql += " GROUP BY segment_id, position, kind";
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows = stmt.query(params_from_iter(params))?;
                while let Some(row) = rows.next()? {
                    let (counted, money) = exclusions.admits(row.get(2)?);
                    if counted {
                        let totals = Totals::from_row(row, 3)?;
                        slot(&mut out, row.get(0)?, row.get(1)?)
                            .totals
                            .add(&totals, money);
                    }
                }
            }

            // The hero's seat rows of a `played_at` range, and their kind.
            // `from` names `hand_stats` as `d`, first or after the table the
            // rows start from; `CROSS JOIN` keeps SQLite to that order (left
            // alone it may start from all of `hand_stats`, for `d.gen`).
            let hero_rows = |from: &str, lo: Option<&str>, hi: Option<&str>, head: &str| {
                let mut params: Vec<Value> = vec![Value::Integer(generation)];
                let mut sql = format!(
                    "SELECT d.segment_id, coalesce(s.position, ''), d.is_bomb_pot,
                            d.has_straddle, d.has_cashout, s.totals{head}
                     FROM {from}
                     CROSS JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
                     WHERE d.gen = ?1"
                );
                if let Some(lo) = lo {
                    sql += &bound("d.played_at", ">=", lo, &mut params);
                }
                if let Some(hi) = hi {
                    sql += &bound("d.played_at", "<", hi, &mut params);
                }
                sql += &in_list("d.segment_id", segments(), &mut params);
                sql += &in_list("coalesce(s.position, '')", positions(), &mut params);
                (sql, params)
            };

            // The partial days at the ends, from the rows.
            for (lo, hi) in &ranges.edges {
                let (sql, params) = hero_rows(
                    "hand_stats d INDEXED BY hand_stats_played_idx",
                    Some(lo),
                    Some(hi),
                    "",
                );
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows = stmt.query(params_from_iter(params))?;
                while let Some(row) = rows.next()? {
                    let (counted, money) = exclusions.admits(kind_from(row, 2)?);
                    if counted {
                        let values =
                            decode_seat(&row.get::<_, Vec<u8>>(5)?).map_err(decode_error)?;
                        slot(&mut out, row.get(0)?, row.get(1)?)
                            .totals
                            .add_seat(&values, money);
                    }
                }
            }

            // The EV adjustment over the whole range: the stored rows (all-ins
            // with cards to come) and the hands still queued.
            let (from, to) = (filter.from.as_deref(), filter.to.as_deref());
            let (sql, mut params) = hero_rows(
                "ev_rows e CROSS JOIN hand_stats d ON d.hand_key = e.hand_key",
                from,
                to,
                ", e.seat, s.seat, e.ev_net, e.ev_net_bb_milli",
            );
            params.push(Value::Text(EV_VERSION.to_owned()));
            let sql = format!("{sql} AND e.ev_version = ?{}", params.len());
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt.query(params_from_iter(params))?;
            while let Some(row) = rows.next()? {
                let (_, money) = exclusions.admits(kind_from(row, 2)?);
                if !money || row.get::<_, i64>(6)? != row.get::<_, i64>(7)? {
                    continue;
                }
                let values = decode_seat(&row.get::<_, Vec<u8>>(5)?).map_err(decode_error)?;
                let ev = EvAdjust {
                    applicable: 1,
                    net: row.get::<_, i64>(8)? - values.net(),
                    bb_milli: row.get::<_, i64>(9)? - values.net_bb_milli(),
                    pending: 0,
                };
                slot(&mut out, row.get(0)?, row.get(1)?).ev.add(&ev);
            }
            let (sql, params) = hero_rows(
                "ev_pending p CROSS JOIN hand_stats d ON d.hand_key = p.hand_key",
                from,
                to,
                "",
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt.query(params_from_iter(params))?;
            while let Some(row) = rows.next()? {
                let (_, money) = exclusions.admits(kind_from(row, 2)?);
                if money {
                    slot(&mut out, row.get(0)?, row.get(1)?).ev.pending += 1;
                }
            }
            Ok(out.into_values().collect())
        })
    }

    /// The statistics' state: versions, generation, a rebuild's progress,
    /// the EV queue.
    pub fn stats_status(&self) -> Result<StatsStatus> {
        self.with(|conn| {
            let pending: i64 =
                conn.query_row("SELECT count(*) FROM ev_pending", [], |row| row.get(0))?;
            Ok(StatsStatus {
                stats_version: kv_get(conn, crate::stats::KV_VERSION)?,
                ev_version: kv_get(conn, crate::stats::KV_EV_VERSION)?,
                generation: current_gen(conn)?,
                rebuild: rebuild_state(conn)?,
                ev_pending: u64::try_from(pending).unwrap_or(0),
            })
        })
    }
}

//! The Today and Reports screens (docs/RAIL-PLAN.md R2.7b): thin commands
//! over `rail_store` (`hero_totals`, `report`) and the displayed statistics
//! (`rail_stats::display`, R2.4 / R2.5).
//!
//! - `stat_definitions()`: every shipped definition (`config/stats/`), in
//!   file order - the order of every `stats` list below;
//! - `report(filter, points)`: what opening Reports shows - the hero's
//!   statistics over the filter, the win-rate graph (`points` buckets, the
//!   EV line, hands still waiting for it), the money refusals, and the
//!   breakdowns the rollups give (position, stake, room, table size,
//!   format);
//! - `report_breakdowns(filter)`: the breakdowns by situation (pot type,
//!   stack depth, starting hand, players dealt in, street reached) - one
//!   pass over the hero's seat rows, cached until the next commit;
//! - `today()`: the latest session - result, hands, its statistics, its
//!   biggest pots as list rows, whether it is still going.
//!
//! The numbers are computed here, never in the window (guideline §14): a
//! statistic arrives as the R2.4 `Shown` the web's `showStat` returns, with
//! its R2.5 reliability. Money is refused as the web refuses it: a sample
//! that mixes tournament chips with cash has neither money nor big blinds;
//! one in two currencies has big blinds only.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use rail_config::stats::{StatDef, Unit};
use rail_core::js::JsNumber;
use rail_stats::display::{Display, Shown, Sums};
use rail_store::report::{BreakdownRow, Graph, ReportFilter, SESSION_GAP_MINUTES, Units};
use rail_store::{HeroSum, HeroTotal};
use serde::Serialize;
use tauri::State;

use crate::commands::StoreState;
use crate::hands::{FilterDto, HandRowDto, site_name};

/// The statistics a breakdown row carries (definition ids).
pub const BREAKDOWN_COLUMNS: [&str; 11] = [
    "hands",
    "bb_per_100",
    "vpip",
    "pfr",
    "rfi",
    "three_bet",
    "fold_to_three_bet",
    "steal",
    "cbet_flop",
    "wtsd",
    "wsd",
];

/// The biggest pots Today lists.
const TODAY_POTS: usize = 5;

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

/// The shipped definitions, compiled once.
pub(crate) fn display() -> Result<&'static Display, String> {
    static DISPLAY: OnceLock<Result<Display, String>> = OnceLock::new();
    DISPLAY
        .get_or_init(|| Display::shipped().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(Clone::clone)
}

/* ------------------------------------------------------------- the DTOs - */

/// `RateInterval` / `intervalText`'s bounds.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoundsDto<T> {
    low: T,
    high: T,
}

/// `StatReliability` (`frontend/src/lib/stats/display.ts`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReliabilityDto {
    level: &'static str,
    opacity: f64,
    interval: Option<BoundsDto<f64>>,
    interval_text: Option<BoundsDto<String>>,
}

/// `Shown`: a statistic as shown, the web's `showStat` (doubles as the
/// web's numbers, bit for bit).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShownDto {
    value: Option<f64>,
    text: Option<String>,
    tone: Option<&'static str>,
    sample: Option<f64>,
    full: bool,
    reliability: ReliabilityDto,
}

impl ShownDto {
    fn of(shown: Shown) -> Self {
        let reliability = shown.reliability;
        Self {
            value: shown.value.map(JsNumber::to_f64),
            text: shown.text,
            tone: shown.tone.map(|tone| tone.as_str()),
            sample: shown.sample.map(JsNumber::to_f64),
            full: shown.full,
            reliability: ReliabilityDto {
                level: reliability.level.as_str(),
                opacity: reliability.opacity.to_f64(),
                interval: reliability.interval.map(|i| BoundsDto {
                    low: i.low.to_f64(),
                    high: i.high.to_f64(),
                }),
                interval_text: reliability
                    .interval_text
                    .map(|(low, high)| BoundsDto { low, high }),
            },
        }
    }

    /// The value withheld (a refused unit): no value, text or tone; the
    /// sample stays.
    /// No value, text or tone (a test's view of [`Self::withheld`]).
    #[cfg(test)]
    pub(crate) fn value_is_withheld(&self) -> bool {
        self.value.is_none() && self.text.is_none() && self.tone.is_none()
    }

    pub(crate) fn withheld(mut self) -> Self {
        self.value = None;
        self.text = None;
        self.tone = None;
        self
    }
}

/// `rail_store::report::Units`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnitsDto {
    mixed_kind: bool,
    mixed_currency: bool,
    currency: Option<String>,
    symbol: Option<String>,
    /// Minor units per unit (100 for cents).
    minor_units: Option<i64>,
}

impl From<&Units> for UnitsDto {
    fn from(units: &Units) -> Self {
        Self {
            mixed_kind: units.mixed_kind,
            mixed_currency: units.mixed_currency,
            currency: units.currency.clone(),
            symbol: units.symbol.clone(),
            minor_units: units.minor_units,
        }
    }
}

/// Every definition shown over `sums`, with the units' refusals: no big
/// blinds across chips and cash, no money across currencies.
pub(crate) fn show_all(
    display: &Display,
    sums: &Sums,
    units: &Units,
    ids: Option<&[&str]>,
) -> Vec<ShownDto> {
    let minor = units.money_decimals();
    let stats: Vec<_> = match ids {
        None => display.stats.iter().collect(),
        Some(ids) => ids.iter().filter_map(|id| display.get(id)).collect(),
    };
    stats
        .into_iter()
        .map(|stat| {
            let shown = ShownDto::of(stat.show(sums, minor));
            let refused = match stat.def.format.unit {
                Unit::BbPer100 | Unit::Bb => !units.big_blinds(),
                Unit::Money => !units.money(),
                _ => false,
            };
            if refused { shown.withheld() } else { shown }
        })
        .collect()
}

/// A group of the hero's hands: its key, sums and statistics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDto {
    key: String,
    /// A room's name, for the rows by room.
    label: Option<String>,
    hands: i64,
    money_hands: i64,
    /// Minor units / thousandths of a big blind, `None` when refused.
    net: Option<i64>,
    net_bb_milli: Option<i64>,
    /// [`BREAKDOWN_COLUMNS`], in that order.
    stats: Vec<ShownDto>,
}

#[cfg(test)]
impl GroupDto {
    /// The group's hands.
    pub(crate) fn hands(&self) -> i64 {
        self.hands
    }
}

/// A group row of plain totals (no all-in EV): the breakdowns by
/// situation, and an opponent's rows on the Players screen (R2.7c), whose
/// [`BREAKDOWN_COLUMNS`] are all `players: any` statistics.
pub(crate) fn totals_row(
    key: String,
    label: Option<String>,
    totals: &rail_store::Totals,
    display: &Display,
    units: &Units,
) -> GroupDto {
    Group {
        sum: HeroSum {
            totals: totals.clone(),
            ..HeroSum::default()
        },
        ev: false,
    }
    .dto(key, label, display, units)
}

/// One group's sums: `hero_totals`' rows with their all-in EV adjustment,
/// or (the breakdowns by situation) totals without one.
#[derive(Debug, Clone, Default)]
struct Group {
    sum: HeroSum,
    ev: bool,
}

impl Group {
    fn add(&mut self, total: &HeroTotal) {
        self.sum.add(total);
        self.ev = true;
    }

    fn sums(&self) -> Sums {
        if self.ev {
            self.sum.sums()
        } else {
            self.sum.totals.sums()
        }
    }

    fn dto(
        &self,
        key: String,
        label: Option<String>,
        display: &Display,
        units: &Units,
    ) -> GroupDto {
        GroupDto {
            key,
            label,
            hands: self.sum.totals.hands(),
            money_hands: self.sum.totals.money_hands,
            net: units
                .money()
                .then(|| self.sum.totals.money("net"))
                .flatten(),
            net_bb_milli: units
                .big_blinds()
                .then(|| self.sum.totals.money("net_bb_milli"))
                .flatten(),
            stats: show_all(display, &self.sums(), units, Some(&BREAKDOWN_COLUMNS)),
        }
    }
}

/// `rail_store::report::GraphPoint`, in the web's `StatsGraphBucket` shape
/// (the shared `WinrateGraph` draws both); money `None` when refused.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketDto {
    bucket: usize,
    hands: u64,
    money_hands: u64,
    first_played_at: Option<String>,
    last_played_at: Option<String>,
    cum_hands: u64,
    cum_money_hands: u64,
    cum_net_bb_milli: i64,
    cum_sd_bb_milli: i64,
    cum_nsd_bb_milli: i64,
    cum_ev_bb_milli: i64,
    cum_net: Option<i64>,
    cum_sd_net: Option<i64>,
    cum_nsd_net: Option<i64>,
    cum_ev_net: Option<i64>,
}

/// The EV line's coverage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllInEvDto {
    /// Hands with an evaluated all-in.
    all_in_hands: u64,
    /// Hands still waiting for the background pass.
    pending: u64,
}

/// The graph, in the web's `StatsGraph` shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDto {
    hands: u64,
    money_hands: u64,
    buckets: Vec<BucketDto>,
    all_in_ev: AllInEvDto,
    mixed_unit_kind: bool,
    mixed_currency: bool,
}

impl From<&Graph> for GraphDto {
    fn from(graph: &Graph) -> Self {
        let money = graph.units.money();
        let cash = |value: i64| money.then_some(value);
        Self {
            hands: graph.hands,
            money_hands: graph.money_hands,
            buckets: graph
                .points
                .iter()
                .enumerate()
                .map(|(index, point)| BucketDto {
                    bucket: index + 1,
                    hands: point.hands,
                    money_hands: point.money_hands,
                    first_played_at: point.first_played_at.clone(),
                    last_played_at: point.last_played_at.clone(),
                    cum_hands: point.cum_hands,
                    cum_money_hands: point.cum_money_hands,
                    cum_net_bb_milli: point.cum_net_bb_milli,
                    cum_sd_bb_milli: point.cum_sd_bb_milli,
                    cum_nsd_bb_milli: point.cum_nsd_bb_milli,
                    cum_ev_bb_milli: point.cum_ev_bb_milli,
                    cum_net: cash(point.cum_net),
                    cum_sd_net: cash(point.cum_sd_net),
                    cum_nsd_net: cash(point.cum_nsd_net),
                    cum_ev_net: cash(point.cum_ev_net),
                })
                .collect(),
            all_in_ev: AllInEvDto {
                all_in_hands: graph.all_in_hands,
                pending: graph.ev_pending,
            },
            mixed_unit_kind: graph.units.mixed_kind,
            mixed_currency: graph.units.mixed_currency,
        }
    }
}

/// The hero's sums over the whole filter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryDto {
    hands: i64,
    money_hands: i64,
    net: Option<i64>,
    net_bb_milli: Option<i64>,
    /// The all-in EV result, thousandths of a big blind.
    ev_net_bb_milli: Option<i64>,
    /// Every definition, in [`stat_definitions`]' order.
    stats: Vec<ShownDto>,
}

/// What opening Reports shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDto {
    units: UnitsDto,
    summary: SummaryDto,
    graph: GraphDto,
    /// [`BREAKDOWN_COLUMNS`]: the statistics of every group row.
    columns: Vec<&'static str>,
    by_position: Vec<GroupDto>,
    by_stake: Vec<GroupDto>,
    by_site: Vec<GroupDto>,
    by_size: Vec<GroupDto>,
    by_format: Vec<GroupDto>,
}

/// The breakdowns by situation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownsDto {
    columns: Vec<&'static str>,
    pot_type: Vec<GroupDto>,
    stack: Vec<GroupDto>,
    hand_class: Vec<GroupDto>,
    players: Vec<GroupDto>,
    street: Vec<GroupDto>,
}

/// Today's session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    started_at: String,
    ended_at: String,
    /// The newest hand is within the session gap of now: still going.
    current: bool,
    gap_minutes: i64,
    hands: u64,
    tables: Option<u64>,
    net: Option<i64>,
    net_bb_milli: Option<i64>,
    units: UnitsDto,
    /// Every definition over the session (bomb pots out, as the statistics
    /// count them), in [`stat_definitions`]' order.
    stats: Vec<ShownDto>,
    /// The biggest pots in big blinds, as Hands rows.
    biggest_pots: Vec<HandRowDto>,
}

/// What Today shows beyond the import status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayDto {
    session: Option<SessionDto>,
}

/* ------------------------------------------------------------ the work - */

/// `hero_totals`' rows summed by a key of each row.
fn grouped(
    totals: &[HeroTotal],
    mut key: impl FnMut(&HeroTotal) -> Option<String>,
) -> BTreeMap<String, Group> {
    let mut out: BTreeMap<String, Group> = BTreeMap::new();
    for total in totals {
        if let Some(key) = key(total) {
            out.entry(key).or_default().add(total);
        }
    }
    out
}

fn rows(
    groups: BTreeMap<String, Group>,
    display: &Display,
    units: &Units,
    label: impl Fn(&str) -> Option<String>,
) -> Vec<GroupDto> {
    groups
        .into_iter()
        .map(|(key, group)| {
            let label = label(&key);
            group.dto(key, label, display, units)
        })
        .collect()
}

fn situation(list: &[BreakdownRow], display: &Display, units: &Units) -> Vec<GroupDto> {
    list.iter()
        .map(|row| totals_row(row.key.clone(), None, &row.totals, display, units))
        .collect()
}

/// The report over `filter`: the statistics, the graph and the rollups'
/// breakdowns (also the core of the parity test, `reports::tests`).
pub fn build_report(
    reader: &rail_store::Reader,
    filter: &ReportFilter,
    points: u32,
) -> Result<ReportDto, String> {
    let display = display()?;
    // The totals and the graph at once (R2.9).
    let (totals, graph) = reader.report_open(filter, points).map_err(text)?;
    let units = &graph.units;
    let segments: BTreeMap<i64, rail_stats::Segment> = reader
        .segments()
        .map_err(text)?
        .into_iter()
        .map(|row| (row.id, row.segment))
        .collect();
    let segment = |total: &HeroTotal| segments.get(&total.segment_id);

    let mut all = Group::default();
    for total in &totals {
        all.add(total);
    }
    let sums = all.sums();
    let summary = SummaryDto {
        hands: all.sum.totals.hands(),
        money_hands: all.sum.totals.money_hands,
        net: units.money().then(|| all.sum.totals.money("net")).flatten(),
        net_bb_milli: units
            .big_blinds()
            .then(|| all.sum.totals.money("net_bb_milli"))
            .flatten(),
        ev_net_bb_milli: units.big_blinds().then_some(sums.ev_net_bb_milli).flatten(),
        stats: show_all(display, &sums, units, None),
    };
    let none = |_: &str| None;
    Ok(ReportDto {
        units: units.into(),
        summary,
        graph: graph.as_ref().into(),
        columns: BREAKDOWN_COLUMNS.to_vec(),
        by_position: rows(
            grouped(&totals, |t| Some(t.position.clone())),
            display,
            units,
            none,
        ),
        by_stake: rows(
            grouped(&totals, |t| segment(t).map(|s| s.stake.key())),
            display,
            units,
            none,
        ),
        by_site: rows(
            grouped(&totals, |t| segment(t).map(|s| s.site.clone())),
            display,
            units,
            |site| Some(site_name(site)),
        ),
        by_size: rows(
            grouped(&totals, |t| segment(t).map(|s| s.size.as_str().to_owned())),
            display,
            units,
            none,
        ),
        by_format: rows(
            grouped(&totals, |t| {
                segment(t).map(|s| s.format.as_str().to_owned())
            }),
            display,
            units,
            none,
        ),
    })
}

/// The breakdowns by situation over `filter`.
pub fn build_breakdowns(
    reader: &rail_store::Reader,
    filter: &ReportFilter,
) -> Result<BreakdownsDto, String> {
    let display = display()?;
    // The refusals of the whole sample, as the web's breakdown applies them
    // (the graph's pass is cached, or a fraction of this one).
    let graph = reader.report_graph(filter, 1).map_err(text)?;
    let units = &graph.units;
    let found = reader.report_breakdowns(filter).map_err(text)?;
    Ok(BreakdownsDto {
        columns: BREAKDOWN_COLUMNS.to_vec(),
        pot_type: situation(&found.pot_type, display, units),
        stack: situation(&found.stack, display, units),
        hand_class: situation(&found.hand_class, display, units),
        players: situation(&found.players, display, units),
        street: situation(&found.street, display, units),
    })
}

/// Today's latest session at `now_ms`.
pub fn build_today(reader: &rail_store::Reader, now_ms: i64) -> Result<TodayDto, String> {
    let display = display()?;
    let Some(session) = reader
        .latest_session(SESSION_GAP_MINUTES, TODAY_POTS)
        .map_err(text)?
    else {
        return Ok(TodayDto { session: None });
    };
    // The session's statistics: its date range, which holds exactly its
    // hands (a session has no gap inside it). `~` sorts after every
    // character a `played_at` holds, so the last hand is inside the bound.
    let hero = rail_store::HeroFilter {
        from: Some(session.started_at.clone()),
        to: Some(format!("{}~", session.ended_at)),
        ..rail_store::HeroFilter::default()
    };
    let mut all = Group::default();
    for total in reader.hero_totals(&hero).map_err(text)? {
        all.add(&total);
    }
    let pots = reader.hand_rows(&session.biggest_pots).map_err(text)?;
    let mut biggest: Vec<HandRowDto> = Vec::new();
    for key in &session.biggest_pots {
        if let Some(row) = pots.iter().find(|row| &row.hand_key == key) {
            biggest.push(row.clone().into());
        }
    }
    let current = rail_store::time::ms_from_iso(&session.ended_at)
        .is_some_and(|ended| now_ms - ended <= SESSION_GAP_MINUTES * 60_000);
    Ok(TodayDto {
        session: Some(SessionDto {
            current,
            gap_minutes: SESSION_GAP_MINUTES,
            hands: session.hands,
            tables: session.tables,
            net: session.net,
            net_bb_milli: session.net_bb_milli,
            stats: show_all(display, &all.sums(), &session.units, None),
            units: (&session.units).into(),
            biggest_pots: biggest,
            started_at: session.started_at,
            ended_at: session.ended_at,
        }),
    })
}

/* --------------------------------------------------------- the commands - */

/// Every shipped definition, in file order (the order of every `stats`
/// list the other commands return).
#[tauri::command]
pub async fn stat_definitions() -> Result<Vec<StatDef>, String> {
    Ok(display()?
        .stats
        .iter()
        .map(|stat| stat.def.clone())
        .collect())
}

/// What opening Reports shows (see the module header).
#[tauri::command]
pub async fn report(
    store: State<'_, StoreState>,
    filter: FilterDto,
    points: u32,
) -> Result<ReportDto, String> {
    build_report(open(&store)?.reader(), &filter.into(), points)
}

#[tauri::command]
pub async fn report_breakdowns(
    store: State<'_, StoreState>,
    filter: FilterDto,
) -> Result<BreakdownsDto, String> {
    build_breakdowns(open(&store)?.reader(), &filter.into())
}

#[tauri::command]
pub async fn today(store: State<'_, StoreState>) -> Result<TodayDto, String> {
    build_today(open(&store)?.reader(), rail_store::time::now_ms())
}

#[cfg(test)]
mod tests {
    use super::{BREAKDOWN_COLUMNS, display};

    #[test]
    fn breakdown_columns_are_definitions() {
        let display = display().expect("shipped");
        for id in BREAKDOWN_COLUMNS {
            assert!(display.get(id).is_some(), "{id}");
        }
    }
}

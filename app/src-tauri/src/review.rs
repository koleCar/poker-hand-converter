//! The analysis screens' readers (docs/RAIL-PLAN.md R5.4): the session
//! review (R5.1), the own charts' comparison (R5.3b) and the top three leaks
//! (R5.2) over the local store (`rail_store::review`, `rail_store::leaks`).
//! Thin: the queries are the store's, the screens are the shared package's
//! (`packages/ui/review`, `packages/ui/charts`) and the app's own top leaks
//! card, with the app's sources (`src/lib/reviewSource.ts`,
//! `src/lib/chartsSource.ts`, `src/lib/leaksSource.ts`).

use rail_store::review::{CompareQuery, ReviewQuery};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::StoreState;

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

/// One session's review (`SessionReview`'s shape, the hands' stakes label
/// left to the window).
#[tauri::command]
pub async fn session_review(
    store: State<'_, StoreState>,
    version: String,
    at: Option<String>,
    gap_minutes: i64,
    limit: usize,
) -> Result<Value, String> {
    open(&store)?
        .reader()
        .session_review(&ReviewQuery {
            at,
            gap_minutes,
            limit,
            version,
            now_ms: rail_store::time::now_ms(),
        })
        .map_err(text)
}

/// A session of the picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionItemDto {
    started_at: String,
    ended_at: String,
    hands: i64,
    tables: i64,
    net_bb_milli: Option<i64>,
}

/// The sessions whose last hand is at or after `since` (ISO; null: all),
/// newest first.
#[tauri::command]
pub async fn review_sessions(
    store: State<'_, StoreState>,
    gap_minutes: i64,
    since: Option<String>,
    limit: usize,
) -> Result<Vec<SessionItemDto>, String> {
    Ok(open(&store)?
        .reader()
        .review_sessions(gap_minutes, since.as_deref(), limit.clamp(1, 500))
        .map_err(text)?
        .into_iter()
        .map(|s| SessionItemDto {
            started_at: s.started_at,
            ended_at: s.ended_at,
            hands: s.hands,
            tables: s.tables,
            net_bb_milli: s.net_bb_milli,
        })
        .collect())
}

/// A session's preflop decision on the shipped tree.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflopDto {
    hand_id: String,
    ord: i64,
    action_index: i64,
    played_at: String,
    key: String,
    cls: i64,
    action: String,
    scenario: String,
    position: Option<String>,
    game_format: String,
    table_size: i64,
    depth_band_bb: Option<i64>,
    ev_loss_bb: Option<f64>,
}

#[tauri::command]
pub async fn session_preflop(
    store: State<'_, StoreState>,
    version: String,
    started_at: String,
    ended_at: String,
) -> Result<Vec<PreflopDto>, String> {
    Ok(open(&store)?
        .reader()
        .session_preflop(&version, &started_at, &ended_at)
        .map_err(text)?
        .into_iter()
        .map(|d| PreflopDto {
            hand_id: d.hand_key,
            ord: d.ord,
            action_index: d.action_index,
            played_at: d.played_at,
            key: d.key,
            cls: d.cls,
            action: d.action,
            scenario: d.scenario,
            position: d.position,
            game_format: d.game_format,
            table_size: d.table_size,
            depth_band_bb: (d.depth_band >= 0).then_some(d.depth_band),
            ev_loss_bb: d.ev_loss_bb,
        })
        .collect())
}

/// The review's rows of these hands.
#[tauri::command]
pub async fn review_hands(
    store: State<'_, StoreState>,
    version: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    open(&store)?
        .reader()
        .review_hands(&keys, &version)
        .map_err(text)
}

/// What the window asks the comparison.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareDto {
    period: String,
    game_format: String,
    table_size: i64,
    stack_min_bb: i64,
    stack_max_bb: i64,
}

fn compare(version: String, query: CompareDto) -> Result<CompareQuery, String> {
    if !matches!(query.period.as_str(), "30d" | "90d" | "365d" | "all")
        || !matches!(query.game_format.as_str(), "cash" | "tournament")
        || !matches!(query.table_size, 2 | 6 | 9)
        || query.stack_min_bb < 0
        || query.stack_max_bb > 1000
        || query.stack_min_bb > query.stack_max_bb
    {
        return Err("bad comparison".to_owned());
    }
    Ok(CompareQuery {
        version,
        period: query.period,
        game_format: query.game_format,
        table_size: query.table_size,
        min_bb: query.stack_min_bb,
        max_bb: query.stack_max_bb,
    })
}

/// `PlayedData` (cells as objects).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayedDto {
    from: Option<String>,
    to: Option<String>,
    cells: Vec<CellDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDto {
    key: String,
    cls: i64,
    action: String,
    decisions: i64,
    ev_loss_bb: f64,
}

#[tauri::command]
pub async fn chart_played(
    store: State<'_, StoreState>,
    version: String,
    query: CompareDto,
) -> Result<PlayedDto, String> {
    let played = open(&store)?
        .reader()
        .chart_played(&compare(version, query)?)
        .map_err(text)?;
    Ok(PlayedDto {
        from: played.from,
        to: played.to,
        cells: played
            .cells
            .into_iter()
            .map(|c| CellDto {
                key: c.key,
                cls: c.cls,
                action: c.action,
                decisions: c.decisions,
                ev_loss_bb: c.ev_loss_bb,
            })
            .collect(),
    })
}

/// A hand behind a compared cell (the stakes label left to the window).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleDto {
    hand_id: String,
    action_index: i64,
    played_at: String,
    hero_cards: Vec<String>,
    site: String,
    currency: String,
    currency_symbol: String,
    minor_units: i64,
    small_blind: i64,
    big_blind: i64,
    ev_loss_bb: Option<f64>,
}

#[tauri::command]
pub async fn chart_examples(
    store: State<'_, StoreState>,
    version: String,
    query: CompareDto,
    key: String,
    cls: i64,
    action: String,
    limit: usize,
) -> Result<Vec<ExampleDto>, String> {
    Ok(open(&store)?
        .reader()
        .chart_examples(&compare(version, query)?, &key, cls, &action, limit)
        .map_err(text)?
        .into_iter()
        .map(|e| ExampleDto {
            hand_id: e.hand_key,
            action_index: e.action_index,
            played_at: e.played_at,
            hero_cards: e.hero_cards,
            site: e.site,
            currency: e.currency,
            currency_symbol: e.currency_symbol,
            minor_units: e.minor_units,
            small_blind: e.small_blind,
            big_blind: e.big_blind,
            ev_loss_bb: e.ev_loss_bb,
        })
        .collect())
}

/* ------------------------------------------------------ the top leaks - */

/// The top three's filters as the window sends them.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LeakFiltersDto {
    game_format: Option<String>,
    position: Option<String>,
    pot_type: Option<String>,
}

impl From<LeakFiltersDto> for rail_store::leaks::LeakFilters {
    fn from(dto: LeakFiltersDto) -> Self {
        let keep = |v: Option<String>| v.filter(|v| !v.trim().is_empty());
        Self {
            game_format: keep(dto.game_format),
            position: keep(dto.position).map(|p| p.trim().to_uppercase()),
            pot_type: keep(dto.pot_type),
        }
    }
}

/// One spot's sums (`analysis_leaks`' row, sums as summed).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotSumsDto {
    key: String,
    set: Option<String>,
    decisions: i64,
    non_perfect: i64,
    mistakes: i64,
    ev_loss_bb: f64,
    ev_loss_pot: f64,
    score_sum: f64,
    score_sq: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeakSampleDto {
    hands: i64,
    graded: i64,
    rows: Vec<SpotSumsDto>,
}

impl From<rail_store::leaks::LeakSample> for LeakSampleDto {
    fn from(sample: rail_store::leaks::LeakSample) -> Self {
        Self {
            hands: sample.hands,
            graded: sample.graded,
            rows: sample
                .rows
                .into_iter()
                .map(|r| SpotSumsDto {
                    key: r.key,
                    set: r.set,
                    decisions: r.decisions,
                    non_perfect: r.non_perfect,
                    mistakes: r.mistakes,
                    ev_loss_bb: r.ev_loss_bb,
                    ev_loss_pot: r.ev_loss_pot,
                    score_sum: r.score_sum,
                    score_sq: r.score_sq,
                })
                .collect(),
        }
    }
}

/// UTC days, inclusive.
#[derive(Debug, Serialize, Deserialize)]
pub struct DaysDto {
    from: String,
    to: String,
}

/// `analysis_top_leaks`' answer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopLeaksDto {
    last: Option<String>,
    current: Option<DaysDto>,
    prior: Option<DaysDto>,
    sample: LeakSampleDto,
    now: LeakSampleDto,
    was: LeakSampleDto,
}

/// The top three's samples: the period (`30d`, `all`), the last 30 days of
/// play and the 30 before.
#[tauri::command]
pub async fn top_leaks(
    store: State<'_, StoreState>,
    version: String,
    filters: LeakFiltersDto,
    period: String,
) -> Result<TopLeaksDto, String> {
    let top = open(&store)?
        .reader()
        .top_leaks(&version, &filters.into(), &period)
        .map_err(text)?;
    let days = |w: Option<(String, String)>| w.map(|(from, to)| DaysDto { from, to });
    Ok(TopLeaksDto {
        last: top.last,
        current: days(top.current),
        prior: days(top.prior),
        sample: top.sample.into(),
        now: top.now.into(),
        was: top.was.into(),
    })
}

/// A decision behind a leak (the stakes label left to the window).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeakExampleDto {
    hand_id: String,
    ord: i64,
    action_index: i64,
    played_at: Option<String>,
    site: String,
    currency: String,
    currency_symbol: String,
    minor_units: i64,
    small_blind: i64,
    big_blind: i64,
    hero_cards: Vec<String>,
    hand_class: Option<String>,
    spot_key: String,
    grade: String,
    ev_loss_bb: f64,
    ev_loss_pot: f64,
}

/// The costliest decisions behind one leak (its finest spot keys).
#[tauri::command]
pub async fn leak_examples(
    store: State<'_, StoreState>,
    version: String,
    filters: LeakFiltersDto,
    days: Option<DaysDto>,
    keys: Vec<String>,
    limit: usize,
) -> Result<Vec<LeakExampleDto>, String> {
    Ok(open(&store)?
        .reader()
        .leak_examples(
            &version,
            &filters.into(),
            days.as_ref().map(|d| (d.from.as_str(), d.to.as_str())),
            &keys,
            limit,
        )
        .map_err(text)?
        .into_iter()
        .map(|e| LeakExampleDto {
            hand_id: e.hand_key,
            ord: e.ord,
            action_index: e.action_index,
            played_at: (!e.played_at.is_empty()).then_some(e.played_at),
            site: e.site,
            currency: e.currency,
            currency_symbol: e.currency_symbol,
            minor_units: e.minor_units,
            small_blind: e.small_blind,
            big_blind: e.big_blind,
            hero_cards: e.hero_cards,
            hand_class: e.hand_class,
            spot_key: e.spot_key,
            grade: e.grade,
            ev_loss_bb: e.ev_loss_bb,
            ev_loss_pot: e.ev_loss_pot,
        })
        .collect())
}

//! The analysis screens' readers (docs/RAIL-PLAN.md R5.4): the session
//! review (R5.1) and the own charts' comparison (R5.3b) over the local
//! store (`rail_store::review`). Thin: the queries are the store's, the
//! screens are the shared package's (`packages/ui/review`,
//! `packages/ui/charts`) with the app's sources (`src/lib/reviewSource.ts`,
//! `src/lib/chartsSource.ts`).

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

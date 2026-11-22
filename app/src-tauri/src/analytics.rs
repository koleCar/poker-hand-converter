//! The Analytics stat checker's reads (docs/ANALYTICS.md Step 2): the web's
//! `analytics_checker` and `analytics_checker_examples` over the store's
//! checker rows (`rail_store::checker`), in the same shapes
//! (`packages/ui/analytics/model.ts`: `CheckerSums`, `CheckerExample`); and
//! the Pool tab's (Step 10) `analytics_pool` over `rail_store::pool`
//! (`PoolSums`).
//!
//! The rows are written by the store itself - with each hand's analysis
//! (`analysis_save`) and by the background pass's backfill - so there is no
//! write command. Both reads are async (a sync command that builds a window
//! deadlocks on Windows; these build none, but every read here is async)
//! and Pro, like the analysis: refused with `plan` when the plan has no
//! analysis (`crate::entitlements`; open while enforcement is off).

use rail_store::checker::{CheckerFilters, CheckerSide, ExampleQuery};
use rail_store::{PoolFilters, PoolSums};
use serde::{Deserialize, Serialize};
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

/// Pro: the analysis' plan line.
fn allowed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let allows = tauri::Manager::try_state::<crate::entitlements::EntitlementsState>(app)
        .is_none_or(|plan| plan.allows_analysis());
    if allows {
        Ok(())
    } else {
        Err("plan".to_owned())
    }
}

/// The filters (`CheckerFilters` of `@rail/ui/analytics/model`, camelCase).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerFiltersDto {
    from: Option<String>,
    to: Option<String>,
    game_format: Option<String>,
    game_kind: Option<String>,
    position: Option<String>,
    pot_type: Option<String>,
    pot_kind: Option<String>,
    membership_version: Option<String>,
}

impl From<CheckerFiltersDto> for CheckerFilters {
    fn from(dto: CheckerFiltersDto) -> Self {
        let keep = |v: Option<String>| v.filter(|v| !v.trim().is_empty());
        Self {
            from: keep(dto.from),
            to: keep(dto.to),
            game_format: keep(dto.game_format),
            game_kind: keep(dto.game_kind),
            position: keep(dto.position).map(|p| p.trim().to_uppercase()),
            pot_type: keep(dto.pot_type),
            pot_kind: keep(dto.pot_kind),
            membership_version: keep(dto.membership_version),
        }
    }
}

/// One group's sums (`CheckerGroup`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerGroupDto {
    stat: String,
    spot: String,
    size: String,
    hand_class: String,
    opps: i64,
    opps_taken: i64,
    n: i64,
    taken: i64,
    ref_share: f64,
    ev_high: f64,
    ev_low: f64,
    hands: i64,
}

/// The checker's answer (`CheckerSums`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerSumsDto {
    analysis_version: String,
    membership_version: String,
    hands: i64,
    pending: i64,
    groups: Vec<CheckerGroupDto>,
}

/// The checker's sums per (stat, spot, size, hand class) at `version`.
#[tauri::command]
pub async fn analytics_checker<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, StoreState>,
    version: String,
    filters: Option<CheckerFiltersDto>,
) -> Result<CheckerSumsDto, String> {
    allowed(&app)?;
    let sums = open(&store)?
        .reader()
        .checker_sums(&version, &filters.unwrap_or_default().into())
        .map_err(text)?;
    Ok(CheckerSumsDto {
        analysis_version: sums.analysis_version,
        membership_version: sums.membership_version,
        hands: sums.hands,
        pending: sums.pending,
        groups: sums
            .groups
            .into_iter()
            .map(|g| CheckerGroupDto {
                stat: g.stat,
                spot: g.spot,
                size: g.size,
                hand_class: g.hand_class,
                opps: g.opps,
                opps_taken: g.opps_taken,
                n: g.n,
                taken: g.taken,
                ref_share: g.ref_share,
                ev_high: g.ev_high,
                ev_low: g.ev_low,
                hands: g.hands,
            })
            .collect(),
    })
}

/// Which decisions of one stat (`CheckerExampleQuery`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleQueryDto {
    stat: String,
    spot: Option<String>,
    size: Option<String>,
    hand_class: Option<String>,
    /// `high` (default), `low` or `any`.
    side: Option<String>,
    limit: Option<usize>,
}

/// One decision (`CheckerExample`; `handId` is the store's hand key).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerExampleDto {
    hand_id: String,
    ord: i64,
    action_index: i64,
    played_at: Option<String>,
    site: String,
    stat: String,
    spot: String,
    size: String,
    hand_class: String,
    taken: bool,
    best_in: bool,
    ref_share: f64,
    ev_loss_bb: f64,
    facing_pot: Option<f64>,
    cards: Vec<String>,
    board: Vec<String>,
}

/// The costliest analysed decisions of one stat at `version`.
#[tauri::command]
pub async fn analytics_checker_examples<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, StoreState>,
    version: String,
    filters: Option<CheckerFiltersDto>,
    query: ExampleQueryDto,
) -> Result<Vec<CheckerExampleDto>, String> {
    allowed(&app)?;
    let side = match query.side.as_deref() {
        None | Some("high") => CheckerSide::High,
        Some("low") => CheckerSide::Low,
        Some("any") => CheckerSide::Any,
        Some(other) => return Err(format!("unknown side: {other}")),
    };
    let query = ExampleQuery {
        stat: query.stat,
        spot: query.spot,
        size: query.size,
        hand_class: query.hand_class,
        side,
        limit: query.limit.unwrap_or(20),
    };
    Ok(open(&store)?
        .reader()
        .checker_examples(&version, &filters.unwrap_or_default().into(), &query)
        .map_err(text)?
        .into_iter()
        .map(|e| CheckerExampleDto {
            hand_id: e.hand_key,
            site: e.site,
            ord: e.ord,
            action_index: e.action_index,
            played_at: (!e.played_at.is_empty()).then_some(e.played_at),
            stat: e.stat,
            spot: e.spot,
            size: e.size,
            hand_class: e.hand_class,
            taken: e.taken,
            best_in: e.best_in,
            ref_share: e.ref_share,
            ev_loss_bb: e.ev_loss_bb,
            facing_pot: e.facing_pot,
            cards: e.cards,
            board: e.board,
        })
        .collect())
}

/// The Pool tab's filters (`PoolFilters` of `@rail/ui/analytics/model`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolFiltersDto {
    game_format: Option<String>,
    game_kind: Option<String>,
    sites: Option<Vec<String>>,
}

impl From<PoolFiltersDto> for PoolFilters {
    fn from(dto: PoolFiltersDto) -> Self {
        let keep = |v: Option<String>| v.filter(|v| !v.trim().is_empty());
        Self {
            game_format: keep(dto.game_format),
            game_kind: keep(dto.game_kind),
            sites: dto
                .sites
                .map(|sites| {
                    sites
                        .into_iter()
                        .map(|site| site.trim().to_lowercase())
                        .filter(|site| !site.is_empty())
                        .collect::<Vec<_>>()
                })
                .filter(|sites| !sites.is_empty()),
        }
    }
}

/// The Pool tab's sums (`PoolSums`): the opponents by type, their results
/// and their catalogue rates over the hands they played with the hero.
#[tauri::command]
pub async fn analytics_pool<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, StoreState>,
    filters: Option<PoolFiltersDto>,
) -> Result<PoolSums, String> {
    allowed(&app)?;
    open(&store)?
        .reader()
        .pool_sums(&filters.unwrap_or_default().into())
        .map_err(text)
}

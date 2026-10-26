//! The hand analysis in the app (docs/RAIL-PLAN.md R5.4): thin commands over
//! `rail_store::analysis` for the window's analysis runner, the gate it
//! asks before every page, and the flop library's files.
//!
//! The analysis is the web's library, run by the window in a worker
//! (`src/analysis/`): offline, with no account. This side never grades
//! anything; it hands out hands, stores rows, answers the gate and fetches
//! the flop library.
//!
//! - **The gate** ([`analysis_gate`]): the runner analyses only when it
//!   says so - never while the HUD has a poker table open (A10), never
//!   while a folder's backfill runs or the statistics pass is working
//!   (R2.3's rule for the pass itself: the import and the statistics come
//!   first; the analysis also reads the opponents' statistics), and not
//!   while the user has paused it (Settings; kept in the store's `kv`
//!   as `analysis.paused`).
//! - **Hands and rows**: `analysis_pending` (newest first, a keyset page),
//!   `analysis_offline` (hands analysed without the flop library, to do
//!   again once it can be reached), `analysis_save`, `analysis_counts`,
//!   `hand_analysis` (one hand's row, `analysis_hand`'s shape),
//!   `analysis_villains` (the web's `villain_counters` over the store),
//!   `analysis_clear`.
//! - **The flop library** (`rail_sync::floplib`): `flop_library_file`
//!   answers a file from the disk or the web's public bucket (raw bytes; an
//!   error `absent`, `transient:<status>` or `offline`),
//!   `flop_library_reachable` probes the bucket, `flop_library_usage` says
//!   what is kept on disk.
//! - **Chart sets** (R5.3): the user's own preflop charts, stored here
//!   only.

use std::sync::atomic::{AtomicBool, Ordering};

use rail_store::analysis::TournamentSettingsRow;
use rail_store::{ChartSetRow, HandAnalysisIn, PendingCursor, PendingHand};
use rail_sync::floplib::{FileOutcome, FlopLibraryCache};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::StoreState;
use crate::hud::HudState;
use crate::stats::StatsState;

/// The store's `kv` key for the user's pause.
const PAUSED_KEY: &str = "analysis.paused";

/// The set whose manifest the reachability probe fetches.
const PROBE_MANIFEST: &str = "nlhe-cash-6max-100bb/flop-m1/manifest.json";

/// The analysis' state: the user's pause and the flop library on disk.
#[derive(Debug)]
pub struct AnalysisState {
    paused: AtomicBool,
    flop: Option<FlopLibraryCache>,
}

impl AnalysisState {
    /// The pause as the store kept it; the flop library under `dir`, read
    /// from `supabase_url`'s public bucket.
    pub fn new(store: &StoreState, dir: std::path::PathBuf, supabase_url: &str) -> Self {
        let paused = store
            .store
            .as_ref()
            .and_then(|store| store.reader().kv(PAUSED_KEY).ok().flatten())
            .is_some_and(|value| value == "1");
        let base = match rail_sync::floplib::bucket_url(supabase_url) {
            Ok(base) => Some(base),
            Err(error) => {
                log::warn!("analysis: no flop library bucket ({error}); only what is on disk");
                None
            }
        };
        let flop = match FlopLibraryCache::new(dir, base) {
            Ok(cache) => Some(cache),
            Err(error) => {
                log::error!("analysis: the flop library is off: {error}");
                None
            }
        };
        Self {
            paused: AtomicBool::new(paused),
            flop,
        }
    }

    fn flop(&self) -> Result<&FlopLibraryCache, String> {
        self.flop
            .as_ref()
            .ok_or_else(|| "the flop library is off".to_owned())
    }
}

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

/// Why the analysis may not run now, or `None` when it may. In order: the
/// user's pause, a table open (A10), a backfill, the statistics pass at
/// work.
pub fn gate(
    paused: bool,
    tables_open: u32,
    activity: Option<&str>,
    backfilling: bool,
) -> Option<&'static str> {
    if paused {
        Some("paused")
    } else if tables_open > 0 {
        Some("tables")
    } else if backfilling || activity == Some("paused-backfill") {
        Some("backfill")
    } else if activity.is_some_and(|a| a != "idle" && a != "paused-tables") {
        Some("statistics")
    } else {
        None
    }
}

/// What [`analysis_gate`] answers.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GateDto {
    run: bool,
    /// `paused`, `tables`, `backfill`, `statistics`, `store`, (R6.4)
    /// `plan` (enforcement on and the plan without the analysis); `null`
    /// when it may run.
    reason: Option<&'static str>,
    paused: bool,
}

/// May the analysis run now?
#[tauri::command]
pub fn analysis_gate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, StoreState>,
    state: State<'_, AnalysisState>,
    stats: State<'_, StatsState>,
    hud: State<'_, HudState>,
) -> GateDto {
    let paused = state.paused.load(Ordering::SeqCst);
    // (R6.4) The plan, as `crate::entitlements` last worked it out: open
    // while enforcement is off.
    let plan_allows = tauri::Manager::try_state::<crate::entitlements::EntitlementsState>(&app)
        .is_none_or(|plan| plan.allows_analysis());
    let reason = if store.store.is_none() {
        Some("store")
    } else if !plan_allows {
        Some("plan")
    } else {
        let (activity, backfilling) = stats.activity();
        gate(paused, hud.tables_open(), activity, backfilling)
    };
    GateDto {
        run: reason.is_none(),
        reason,
        paused,
    }
}

/// Pause or resume the analysis (kept across restarts).
#[tauri::command]
pub async fn analysis_set_paused(
    store: State<'_, StoreState>,
    state: State<'_, AnalysisState>,
    paused: bool,
) -> Result<bool, String> {
    open(&store)?
        .set_kv(PAUSED_KEY, if paused { "1" } else { "0" })
        .map_err(text)?;
    state.paused.store(paused, Ordering::SeqCst);
    Ok(paused)
}

/// A hand for the runner.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDto {
    hand_key: String,
    played_at: String,
    /// The PHF as JSON text.
    phf: String,
}

impl From<PendingHand> for PendingDto {
    fn from(hand: PendingHand) -> Self {
        Self {
            hand_key: hand.hand_key,
            played_at: hand.played_at,
            phf: hand.phf,
        }
    }
}

/// The cursor the window sends back.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorDto {
    played_at: String,
    hand_key: String,
}

/// Hands without a row at `version`, newest first, after `after`.
#[tauri::command]
pub async fn analysis_pending(
    store: State<'_, StoreState>,
    version: String,
    after: Option<CursorDto>,
    limit: u32,
) -> Result<Vec<PendingDto>, String> {
    let cursor = after.map(|c| PendingCursor {
        played_at: c.played_at,
        hand_key: c.hand_key,
    });
    Ok(open(&store)?
        .reader()
        .analysis_pending(&version, cursor.as_ref(), limit)
        .map_err(text)?
        .into_iter()
        .map(PendingDto::from)
        .collect())
}

/// Hands analysed at `version` without the flop library, to do again.
#[tauri::command]
pub async fn analysis_offline(
    store: State<'_, StoreState>,
    version: String,
    limit: u32,
) -> Result<Vec<PendingDto>, String> {
    Ok(open(&store)?
        .reader()
        .analysis_offline(&version, limit)
        .map_err(text)?
        .into_iter()
        .map(PendingDto::from)
        .collect())
}

/// What a save did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDto {
    saved: u64,
    missing: u64,
}

/// Store analysed hands (at most 200 a call).
#[tauri::command]
pub async fn analysis_save(
    store: State<'_, StoreState>,
    rows: Vec<HandAnalysisIn>,
) -> Result<SavedDto, String> {
    let outcome = open(&store)?
        .writer()
        .map_err(text)?
        .save_analysis(rows, rail_store::time::now_ms())
        .map_err(text)?;
    Ok(SavedDto {
        saved: outcome.saved,
        missing: outcome.missing,
    })
}

/// How far the analysis is at `version`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountsDto {
    hands: u64,
    current: u64,
    stale: u64,
    missing: u64,
    offline: u64,
    not_analysable: u64,
}

#[tauri::command]
pub async fn analysis_counts(
    store: State<'_, StoreState>,
    version: String,
) -> Result<CountsDto, String> {
    let counts = open(&store)?
        .reader()
        .analysis_counts(&version)
        .map_err(text)?;
    Ok(CountsDto {
        hands: counts.hands,
        current: counts.current,
        stale: counts.stale,
        missing: counts.missing(),
        offline: counts.offline,
        not_analysable: counts.not_analysable,
    })
}

/// One hand's stored analysis (`analysis_hand`'s shape), `null` when none.
#[tauri::command]
pub async fn hand_analysis(
    store: State<'_, StoreState>,
    hand_key: String,
) -> Result<Option<Value>, String> {
    open(&store)?
        .reader()
        .hand_analysis(&hand_key)
        .map_err(text)
}

/// An opponent as the window names one.
#[derive(Debug, Deserialize, Serialize)]
pub struct VillainDto {
    site: String,
    player: String,
}

/// One opponent's counters (`villain_counters`' row).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VillainRowDto {
    site: String,
    player: String,
    hands: i64,
    vpip_opp: i64,
    vpip: i64,
    pfr: i64,
}

/// The web's `villain_counters` over the store: cash games, at least
/// `min_hands` (the analysis' `VILLAIN_MIN_HANDS`).
#[tauri::command]
pub async fn analysis_villains(
    store: State<'_, StoreState>,
    players: Vec<VillainDto>,
    min_hands: i64,
) -> Result<Vec<VillainRowDto>, String> {
    let players: Vec<(String, String)> = players.into_iter().map(|p| (p.site, p.player)).collect();
    Ok(open(&store)?
        .reader()
        .villain_counters(&players, Some("cash"), min_hands)
        .map_err(text)?
        .into_iter()
        .map(|v| VillainRowDto {
            site: v.site,
            player: v.player,
            hands: v.hands,
            vpip_opp: v.vpip_opp,
            vpip: v.vpip,
            pfr: v.pfr,
        })
        .collect())
}

/// Forget every hand's analysis: everything is analysed again.
#[tauri::command]
pub async fn analysis_clear(store: State<'_, StoreState>) -> Result<u64, String> {
    open(&store)?
        .writer()
        .map_err(text)?
        .clear_analysis()
        .map_err(text)
}

/// One file of the flop library: its bytes, or an error `absent`,
/// `transient:<status>` or `offline`.
#[tauri::command]
pub async fn flop_library_file(
    state: State<'_, AnalysisState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    match state.flop()?.file(&path).await? {
        FileOutcome::Bytes { bytes, .. } => Ok(tauri::ipc::Response::new(bytes)),
        FileOutcome::Absent => Err("absent".to_owned()),
        FileOutcome::Transient(status) => Err(format!("transient:{status}")),
        FileOutcome::Offline => Err("offline".to_owned()),
    }
}

/// Whether the flop library's bucket answers now.
#[tauri::command]
pub async fn flop_library_reachable(state: State<'_, AnalysisState>) -> Result<bool, String> {
    Ok(state.flop()?.reachable(PROBE_MANIFEST).await)
}

/// What the flop library keeps on disk.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDto {
    bytes: u64,
    files: u64,
}

#[tauri::command]
pub async fn flop_library_usage(state: State<'_, AnalysisState>) -> Result<UsageDto, String> {
    let (bytes, files) = state.flop()?.disk_usage();
    Ok(UsageDto { bytes, files })
}

/* ----------------------------------------------------------- chart sets - */

/// A chart set as the window has it (the web's `preflop_chart_sets` row:
/// snake_case, `nodes` an object).
#[derive(Debug, Deserialize, Serialize)]
pub struct ChartSetDto {
    id: Option<String>,
    name: String,
    game_format: String,
    table_size: i64,
    stack_min_bb: i64,
    stack_max_bb: i64,
    format_version: i64,
    nodes: Value,
    updated_at: Option<String>,
}

/// A listed chart set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSummaryDto {
    id: String,
    name: String,
    game_format: String,
    table_size: i64,
    stack_min_bb: i64,
    stack_max_bb: i64,
    nodes: i64,
    /// ms since the epoch.
    updated_at: i64,
}

#[tauri::command]
pub async fn chart_sets_list(store: State<'_, StoreState>) -> Result<Vec<ChartSummaryDto>, String> {
    Ok(open(&store)?
        .reader()
        .chart_sets()
        .map_err(text)?
        .into_iter()
        .map(|row| ChartSummaryDto {
            id: row.id,
            name: row.name,
            game_format: row.game_format,
            table_size: row.table_size,
            stack_min_bb: row.stack_min_bb,
            stack_max_bb: row.stack_max_bb,
            nodes: row.node_count,
            updated_at: row.updated_at,
        })
        .collect())
}

/// ms since the epoch as the web's timestamps print (UTC, ISO 8601).
fn iso(ms: i64) -> String {
    rail_store::time::iso_from_ms(ms)
}

#[tauri::command]
pub async fn chart_set_load(
    store: State<'_, StoreState>,
    id: String,
) -> Result<Option<ChartSetDto>, String> {
    let Some(row) = open(&store)?.reader().chart_set(&id).map_err(text)? else {
        return Ok(None);
    };
    let nodes = serde_json::from_str(&row.nodes).map_err(|error| error.to_string())?;
    Ok(Some(ChartSetDto {
        id: Some(row.id),
        name: row.name,
        game_format: row.game_format,
        table_size: row.table_size,
        stack_min_bb: row.stack_min_bb,
        stack_max_bb: row.stack_max_bb,
        format_version: row.format_version,
        nodes,
        updated_at: Some(iso(row.updated_at)),
    }))
}

/// The saved set's id and time.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSavedDto {
    id: String,
    updated_at: String,
}

/// A new id for a chart set: `c-` and 32 hex digits.
fn new_chart_id() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "no random id".to_owned())?;
    Ok(format!(
        "c-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

#[tauri::command]
pub async fn chart_set_save(
    store: State<'_, StoreState>,
    set: ChartSetDto,
) -> Result<ChartSavedDto, String> {
    let id = match set.id {
        Some(id) if !id.is_empty() => id,
        _ => new_chart_id()?,
    };
    let nodes = serde_json::to_string(&set.nodes).map_err(|error| error.to_string())?;
    let at = open(&store)?
        .writer()
        .map_err(text)?
        .save_chart_set(
            ChartSetRow {
                id: id.clone(),
                name: set.name.trim().to_owned(),
                game_format: set.game_format,
                table_size: set.table_size,
                stack_min_bb: set.stack_min_bb,
                stack_max_bb: set.stack_max_bb,
                format_version: set.format_version,
                nodes,
                node_count: 0,
                created_at: 0,
                updated_at: 0,
            },
            rail_store::time::now_ms(),
        )
        .map_err(text)?;
    Ok(ChartSavedDto {
        id,
        updated_at: iso(at),
    })
}

#[tauri::command]
pub async fn chart_set_delete(store: State<'_, StoreState>, id: String) -> Result<bool, String> {
    open(&store)?
        .writer()
        .map_err(text)?
        .delete_chart_set(&id)
        .map_err(text)
}

/// One tournament's settings (R5.5), keyed as `tournamentKey` keys them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentSettingsDto {
    /// `site:tournament id`.
    key: String,
    settings: serde_json::Value,
    updated_at: String,
}

/// `site:tournament id` as its two parts: the site lower-cased, the id trimmed.
fn tournament_key(key: &str) -> Result<(String, String), String> {
    match key.split_once(':') {
        Some((site, id)) if !site.is_empty() && !id.trim().is_empty() => {
            Ok((site.to_lowercase(), id.trim().to_owned()))
        }
        _ => Err("not a tournament key".to_owned()),
    }
}

#[tauri::command]
pub async fn tournament_settings_list(
    store: State<'_, StoreState>,
) -> Result<Vec<TournamentSettingsDto>, String> {
    open(&store)?
        .reader()
        .tournament_settings()
        .map_err(text)?
        .into_iter()
        .map(|row| {
            Ok(TournamentSettingsDto {
                key: format!("{}:{}", row.site, row.tournament_id),
                settings: serde_json::from_str(&row.settings).map_err(|error| error.to_string())?,
                updated_at: iso(row.updated_at),
            })
        })
        .collect()
}

/// Saves one tournament's settings (the library checked them) and sends its
/// hands back to the analysis; how many hands went back.
#[tauri::command]
pub async fn tournament_settings_save(
    store: State<'_, StoreState>,
    key: String,
    settings: serde_json::Value,
) -> Result<u64, String> {
    let (site, tournament_id) = tournament_key(&key)?;
    let settings = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    open(&store)?
        .writer()
        .map_err(text)?
        .save_tournament_settings(
            TournamentSettingsRow {
                site,
                tournament_id,
                settings,
                updated_at: 0,
            },
            rail_store::time::now_ms(),
        )
        .map_err(text)
}

#[tauri::command]
pub async fn tournament_settings_delete(
    store: State<'_, StoreState>,
    key: String,
) -> Result<bool, String> {
    let (site, tournament_id) = tournament_key(&key)?;
    open(&store)?
        .writer()
        .map_err(text)?
        .delete_tournament_settings(&site, &tournament_id)
        .map_err(text)
}

#[cfg(test)]
mod tests {
    use super::gate;

    /// The gate's order: the user's pause, a table (A10), a backfill, the
    /// statistics pass; idle (or the pass paused only for the tables, once
    /// they are closed) lets the analysis run.
    #[test]
    fn the_gate() {
        assert_eq!(gate(false, 0, Some("idle"), false), None);
        assert_eq!(gate(false, 0, None, false), None);
        assert_eq!(gate(true, 0, Some("idle"), false), Some("paused"));
        assert_eq!(gate(true, 3, Some("rebuilding"), true), Some("paused"));
        assert_eq!(gate(false, 1, Some("idle"), false), Some("tables"));
        assert_eq!(gate(false, 1, Some("paused-tables"), false), Some("tables"));
        assert_eq!(gate(false, 0, Some("idle"), true), Some("backfill"));
        assert_eq!(
            gate(false, 0, Some("paused-backfill"), false),
            Some("backfill")
        );
        for busy in [
            "rebuilding",
            "indexing",
            "counting",
            "computing",
            "recomputing-ev",
        ] {
            assert_eq!(
                gate(false, 0, Some(busy), false),
                Some("statistics"),
                "{busy}"
            );
        }
        assert_eq!(gate(false, 0, Some("paused-tables"), false), None);
    }
}

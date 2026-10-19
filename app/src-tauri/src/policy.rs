//! Compliance mode in the app (docs/RAIL-PLAN.md R3.10; guideline §7): the
//! one place the app's HUD policy comes from, and what the window is told
//! about it.
//!
//! - **One source**: [`config`] is the shipped `sites.json` with the remote
//!   copy merged over it (`rail_sync::policy::PolicyKeeper`: fetched from
//!   `<web origin>/sites.json`, checked whole, stricter only, cached in
//!   `<local data>/policy/`). The HUD process reads the same cache at start
//!   (`--policy`) and hears every change (`policy {remote}`, and again on
//!   each connection); the popup (`popup::PopupRules::for_site`) and the
//!   editor (`hud_editor`) ask [`config`] / [`compliance`]. A room the remote
//!   copy switches off is off everywhere at once: the HUD detaches its
//!   tables, an open popup of it closes, the editor no longer offers it.
//! - **No override**: nothing here (or anywhere) lets the user attach the
//!   HUD where the merged policy says no; unknown is no.
//! - **Commands**: [`hud_policy`] (every entry's policy, its source and the
//!   date it was checked, where the copy in force came from and how the last
//!   look went), [`hud_policy_check`] ("Check now"), and
//!   [`hud_open_policy_source`] (a room's policy page in the browser - only
//!   a URL from the merged `sites.json`, only `https`).

use std::path::Path;
use std::sync::{Arc, OnceLock};

use rail_config::model::{HudRestrictions, SiteKind};
use rail_config::{Config, MergeNote};
use rail_hud::compliance::Compliance;
use rail_sync::policy::{Check, Policy, PolicyCache, PolicyFetcher, PolicyKeeper};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The window event when the policy in force changed (no payload: the HUD
/// screen and the editor ask again).
pub const POLICY_EVENT: &str = "hud-policy-changed";

static KEEPER: OnceLock<Arc<PolicyKeeper>> = OnceLock::new();

/// Open the keeper over the cache in `dir` (the shipped copy, or the cached
/// remote one when it passes) and fetch from the web origin. Called once in
/// `setup`, before the HUD starts (it is handed the cache's file).
pub fn init(dir: &Path) -> Option<Arc<PolicyKeeper>> {
    let parsers = rail_core::parsers::REGISTRATION_ORDER;
    let shipped = match crate::folders::sites() {
        Ok(config) => config.clone(),
        Err(error) => {
            log::error!("policy: no shipped sites.json ({error}); the HUD attaches nowhere");
            return None;
        }
    };
    let fetcher = url::Url::parse(&crate::account::web_url())
        .map_err(|error| error.to_string())
        .and_then(|web| rail_sync::policy::remote_url(&web))
        .and_then(PolicyFetcher::new);
    let fetcher = match fetcher {
        Ok(fetcher) => Some(fetcher),
        Err(error) => {
            log::warn!("policy: no remote sites.json ({error}); the shipped copy stays");
            None
        }
    };
    let keeper = Arc::new(PolicyKeeper::open(
        shipped,
        &parsers,
        PolicyCache::new(dir),
        fetcher,
    ));
    let current = keeper.current();
    log::info!(
        "policy: {}",
        if current.remote.is_some() {
            "shipped sites.json + the cached remote copy"
        } else {
            "shipped sites.json"
        }
    );
    Some(Arc::clone(KEEPER.get_or_init(|| keeper)))
}

/// The keeper's loop: a look shortly after start, then every few hours;
/// every change is applied ([`apply`]).
pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let Some(keeper) = KEEPER.get().cloned() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        keeper.run(|policy| apply(&app, policy)).await;
    });
}

/// The merged configuration in force (the shipped one before [`init`], and
/// in tests).
pub fn config() -> Arc<Config> {
    match KEEPER.get() {
        Some(keeper) => keeper.current().config,
        None => Arc::new(crate::folders::sites().cloned().unwrap_or_else(|_| Config {
            schema: None,
            version: rail_config::VERSION,
            sites: Vec::new(),
        })),
    }
}

/// The remote text in force (for the HUD's `policy` message).
pub fn remote() -> Option<String> {
    KEEPER
        .get()
        .and_then(|keeper| keeper.current().remote)
        .map(|text| text.to_string())
}

/// The cached remote file the HUD reads at start (`--policy`).
pub fn cache_file() -> Option<std::path::PathBuf> {
    KEEPER.get().map(|keeper| keeper.cache_file())
}

/// The HUD's own decision, over the same merged policy (the editor's
/// preview).
pub fn compliance() -> Result<Compliance, String> {
    let mut compliance = Compliance::shipped()?;
    if let Some(text) = remote() {
        compliance.apply_remote(Some(&text))?;
    }
    Ok(compliance)
}

/// A new policy is in force: the HUD hears it (and detaches what it no
/// longer allows), an open popup of a room no longer allowed closes, the
/// window asks again.
pub fn apply<R: Runtime>(app: &AppHandle<R>, policy: &Policy) {
    if let Some(hud) = app.try_state::<crate::hud::HudState>() {
        hud.policy_changed(policy.remote.as_deref().map(str::to_owned));
    }
    let config = Arc::clone(&policy.config);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(state) = handle.try_state::<crate::popup::PopupState>()
            && let Some(target) = state.target()
            && !config
                .site(&target.site)
                .is_some_and(rail_config::Site::hud_permitted)
        {
            crate::popup::close(&handle, &state);
        }
    });
    if let Err(error) = app.emit(POLICY_EVENT, ()) {
        log::debug!("{POLICY_EVENT}: {error}");
    }
}

/// One entry's HUD policy, as the HUD screen shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomPolicyDto {
    pub id: String,
    pub name: String,
    pub kind: SiteKind,
    /// `true` allowed, `false` prohibited, `null` unknown (= no).
    pub allowed: Option<bool>,
    /// What compliance mode decides: a room, allowed.
    pub permitted: bool,
    /// The room's own page the policy was read from.
    pub source: Option<String>,
    /// When it was read (`YYYY-MM-DD`).
    pub checked_at: Option<String>,
    pub notes: String,
    pub restrictions: Option<HudRestrictions>,
    /// The remote copy made this entry stricter than this build's own copy
    /// (switched off, or more restricted, after a re-check).
    pub stricter_than_shipped: bool,
}

/// The policy in force, for the HUD screen.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDto {
    pub rooms: Vec<RoomPolicyDto>,
    /// A remote copy is merged in (else: this build's own copy alone).
    pub remote: bool,
    /// Where the remote copy comes from.
    pub url: Option<String>,
    /// When the copy in force was downloaded, Unix seconds.
    pub fetched_at: Option<u64>,
    /// The last look at the web origin since start.
    pub last_check: Option<Check>,
    /// What the merge did not take from the remote copy (it would have
    /// loosened something), one line each.
    pub notes: Vec<String>,
}

fn rooms(config: &Config, shipped: Option<&Config>) -> Vec<RoomPolicyDto> {
    config
        .sites
        .iter()
        .map(|site| {
            let ours = shipped.and_then(|s| s.site(&site.id));
            RoomPolicyDto {
                id: site.id.clone(),
                name: site.name.clone(),
                kind: site.kind,
                allowed: site.hud.allowed,
                permitted: site.hud_permitted(),
                source: site.hud.source.clone(),
                checked_at: site.hud.checked_at.clone(),
                notes: site.hud.notes.clone(),
                restrictions: site.hud.restrictions,
                stricter_than_shipped: ours.is_some_and(|ours| {
                    ours.hud.allowed != site.hud.allowed
                        || ours.hud.restrictions != site.hud.restrictions
                }),
            }
        })
        .collect()
}

/// The DTO for `policy` (the keeper's, or the shipped copy alone).
pub fn dto(keeper: Option<&PolicyKeeper>) -> PolicyDto {
    let shipped = crate::folders::sites().ok();
    let Some(keeper) = keeper else {
        return PolicyDto {
            rooms: shipped.map(|c| rooms(c, None)).unwrap_or_default(),
            remote: false,
            url: None,
            fetched_at: None,
            last_check: None,
            notes: Vec::new(),
        };
    };
    let current = keeper.current();
    PolicyDto {
        rooms: rooms(&current.config, shipped),
        remote: current.remote.is_some(),
        url: keeper.url().map(ToString::to_string),
        fetched_at: current.fetched_at,
        last_check: keeper.last_check(),
        notes: current
            .notes
            .iter()
            .filter(|note| !matches!(note, MergeNote::MissingFromRemote { .. }))
            .map(ToString::to_string)
            .collect(),
    }
}

/// Every entry's HUD policy and where the policy in force came from.
#[tauri::command]
pub fn hud_policy() -> PolicyDto {
    dto(KEEPER.get().map(Arc::as_ref))
}

/// "Check now": one look at the web origin; a new copy is applied at once.
#[tauri::command]
pub async fn hud_policy_check<R: Runtime>(app: AppHandle<R>) -> Result<PolicyDto, String> {
    let keeper = KEEPER
        .get()
        .cloned()
        .ok_or("the HUD policy is not loaded")?;
    if let Some(policy) = keeper.check().await {
        apply(&app, &policy);
    }
    Ok(dto(Some(&keeper)))
}

/// Open a room's policy page in the default browser: the `hud.source` of
/// the merged `sites.json`, never a URL from the window.
#[tauri::command]
pub fn hud_open_policy_source(site: String) -> Result<(), String> {
    let config = config();
    let source = config
        .site(&site)
        .and_then(|entry| entry.hud.source.clone())
        .ok_or_else(|| format!("{site}: no policy page"))?;
    let url = url::Url::parse(&source).map_err(|error| format!("{source}: {error}"))?;
    if url.scheme() != "https" {
        return Err(format!("{source}: not https"));
    }
    open::that_detached(url.as_str()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_with(edit: impl Fn(&mut serde_json::Value)) -> String {
        let mut value: serde_json::Value =
            serde_json::from_str(rail_config::SHIPPED).expect("shipped json");
        edit(&mut value);
        value.to_string()
    }

    /// The screen's rows: every entry with its policy, source and date; an
    /// entry the remote copy switched off says so; the merge's notes are
    /// the loosenings it refused.
    #[test]
    fn the_screen_sees_the_merged_policy() {
        let dir = std::env::temp_dir().join(format!("rail-app-policy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let cache = PolicyCache::new(&dir);
        std::fs::write(
            cache.file(),
            remote_with(|v| {
                for site in v["sites"].as_array_mut().expect("sites") {
                    if site["id"] == "winamax" {
                        site["hud"]["allowed"] = false.into();
                    }
                    if site["id"] == "888poker" {
                        site["hud"]["allowed"] = false.into();
                    }
                    if site["id"] == "ggpoker" {
                        site["hud"]["allowed"] = serde_json::Value::Null;
                    }
                }
            }),
        )
        .expect("cache");
        let shipped = crate::folders::sites().expect("shipped").clone();
        let keeper = PolicyKeeper::open(
            shipped,
            &rail_core::parsers::REGISTRATION_ORDER,
            cache,
            None,
        );
        let dto = dto(Some(&keeper));
        assert!(dto.remote);
        let room = |id: &str| {
            dto.rooms
                .iter()
                .find(|r| r.id == id)
                .cloned()
                .expect("a row")
        };
        let winamax = room("winamax");
        assert_eq!(
            (
                winamax.allowed,
                winamax.permitted,
                winamax.stricter_than_shipped
            ),
            (Some(false), false, true)
        );
        let stars = room("pokerstars");
        assert!(stars.permitted && !stars.stricter_than_shipped);
        assert!(
            stars
                .source
                .as_deref()
                .is_some_and(|s| s.starts_with("https://"))
        );
        assert!(stars.checked_at.is_some());
        assert_eq!(room("888poker").allowed, Some(false));
        // GGPoker stays prohibited: "unknown" is looser than "prohibited".
        let gg = room("ggpoker");
        assert_eq!((gg.allowed, gg.stricter_than_shipped), (Some(false), false));
        assert!(
            dto.notes.iter().any(|n| n.starts_with("ggpoker:")),
            "{:?}",
            dto.notes
        );
        assert_eq!(room("ipoker").kind, SiteKind::Network);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without a keeper (tests, a build whose shipped copy failed): the
    /// shipped policy, no remote copy.
    #[test]
    fn without_a_keeper_the_shipped_policy() {
        let dto = dto(None);
        assert!(!dto.remote && dto.last_check.is_none());
        let permitted: Vec<&str> = dto
            .rooms
            .iter()
            .filter(|r| r.permitted)
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(permitted, ["pokerstars", "winamax", "acr"]);
        assert!(
            config()
                .site("pokerstars")
                .is_some_and(rail_config::Site::hud_permitted)
        );
    }

    /// Only a policy page from `sites.json`, and only over https.
    #[test]
    fn only_a_listed_policy_page_opens() {
        assert!(hud_open_policy_source("nowhere".into()).is_err());
        assert!(
            hud_open_policy_source("standard".into()).is_err(),
            "no page"
        );
        assert!(
            hud_open_policy_source("pokerbros".into()).is_err(),
            "a repository note"
        );
    }
}

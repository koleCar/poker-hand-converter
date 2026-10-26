//! (R6.4) What the app may use: the account's plan, read from the server,
//! kept for offline use, and applied to the HUD, the analysis, the full
//! reports and sync.
//!
//! The rules are `rail_sync::entitlements` (tested there in every state);
//! this module keeps their inputs and acts on their answer:
//!
//! - **Checks.** Signed in: `my_entitlements()` with the account's token.
//!   Signed out: `billing_enforced()` with the anon key - the one public
//!   fact an app that has never signed in needs (paid plans on or off; no
//!   account, no user data). At start, on every account change (sign-in,
//!   sign-out, another account), every [`CHECK_EVERY`], on "Sync now", when
//!   sync is held by the plan, and on the window's "Check again"; a failed
//!   check is retried after [`RETRY_AFTER`] and changes nothing.
//! - **Kept** in the local store's `kv` (`entitlements.account`,
//!   `entitlements.public`): the SQLite database, not a settings file. Not
//!   signed: it is the user's own machine, and nothing that reaches the
//!   account trusts it - the server refuses every cloud feature on its own
//!   (R6.2, `PT402`). The local features (HUD, analysis, full reports) are
//!   the app's to hold back.
//! - **Applied** on every change of the effective answer: the HUD starts
//!   when allowed and is never stopped while running (the plan applies at
//!   the next start), sync is held with `PlanRequired`
//!   (`SyncWorker::set_plan_allows`), the analysis' gate answers `plan`
//!   (`crate::analysis`), and the window hears [`CHANGED_EVENT`] (its locks:
//!   Analysis, Players, the situation tabs of Reports, the HUD screen).
//!   Re-evaluated every minute too, so the grace period ends on time
//!   offline.
//!
//! **Enforcement is off today**: the server says `enforced: false` (or the
//! app was never told), every feature is open, signed in or not.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use rail_sync::entitlements::{
    ACCOUNT_KEY, AccountCheck, Effective, EnforcementCheck, Inputs, PUBLIC_KEY, effective,
};
use rail_sync::ingest::{IngestClient, IngestError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::Notify;

use crate::account::AccountState;
use crate::commands::StoreState;

/// The window event when [`entitlements_status`] would answer differently.
pub const CHANGED_EVENT: &str = "entitlements-changed";

/// A successful check holds this long before the next.
pub const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// After a failed check (offline, the server down).
pub const RETRY_AFTER: Duration = Duration::from_secs(15 * 60);
/// The answer is worked out again this often (the grace period ends on
/// time with no check).
const TICK: Duration = Duration::from_secs(60);
/// Checks asked for in a burst (sign-in, sync, the button) are at least
/// this far apart.
const MIN_GAP: Duration = Duration::from_secs(10);

fn now_ms() -> i64 {
    rail_store::time::now_ms()
}

/// The kept answers.
#[derive(Debug, Default, Clone)]
struct Kept {
    account: Option<AccountCheck>,
    public: Option<EnforcementCheck>,
}

/// The last check, for the window.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo {
    /// Unix ms of the last attempt, and of the last success.
    pub attempted_at_ms: Option<i64>,
    pub succeeded_at_ms: Option<i64>,
    /// The last attempt failed (offline, the server down).
    pub failing: bool,
}

/// The app's state.
#[derive(Debug)]
pub struct EntitlementsState {
    kept: Mutex<Kept>,
    effective: Mutex<Option<Effective>>,
    check: Mutex<CheckInfo>,
    wake: Notify,
}

impl EntitlementsState {
    /// Read the kept answers from the store.
    pub fn new(store: &StoreState) -> Self {
        let read = |key: &str| {
            store
                .store
                .as_ref()
                .and_then(|store| store.reader().kv(key).ok().flatten())
        };
        let kept = Kept {
            account: read(ACCOUNT_KEY).and_then(|text| serde_json::from_str(&text).ok()),
            public: read(PUBLIC_KEY).and_then(|text| serde_json::from_str(&text).ok()),
        };
        Self {
            kept: Mutex::new(kept),
            effective: Mutex::new(None),
            check: Mutex::new(CheckInfo::default()),
            wake: Notify::new(),
        }
    }

    /// The answer now for the account signed in now (`None`: nobody).
    pub fn evaluate(&self, user_id: Option<&str>, now_ms: i64) -> Effective {
        let kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        effective(Inputs {
            now_ms,
            user_id,
            account: kept.account.as_ref(),
            public: kept.public.as_ref(),
        })
    }

    /// The last answer applied (worked out now when none was yet).
    pub fn current(&self) -> Effective {
        self.effective
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .unwrap_or_else(|| self.evaluate(None, now_ms()))
    }

    /// May the analysis run (`crate::analysis`'s gate)?
    pub fn allows_analysis(&self) -> bool {
        self.current().features.analysis
    }

    /// Look again soon (rate-limited by [`MIN_GAP`]).
    pub fn check_soon(&self) {
        self.wake.notify_one();
    }

    fn kept_account(&self) -> Option<AccountCheck> {
        self.kept
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .account
            .clone()
    }
}

/// Look at the plan again soon (the account changed, sync was refused,
/// "Sync now").
pub fn check_soon<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<EntitlementsState>() {
        state.check_soon();
    }
}

fn user_of<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.try_state::<AccountState>()
        .and_then(|state| state.0.as_ref().and_then(|account| account.user()))
        .map(|(id, _)| id)
}

/// Work the answer out again; apply and announce it when it changed (or
/// always with `force`, after a check: a server refusal of sync is
/// forgotten when the plan allows it).
fn refresh<R: Runtime>(app: &AppHandle<R>, state: &EntitlementsState, force: bool) -> Effective {
    let user = user_of(app);
    let now = state.evaluate(user.as_deref(), now_ms());
    let changed = {
        let mut last = state
            .effective
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let changed = last.as_ref() != Some(&now);
        *last = Some(now.clone());
        changed
    };
    if changed || force {
        if changed {
            log::info!(
                "entitlements: {:?} ({:?}; enforcement {:?})",
                now.plan,
                now.reason,
                now.enforcement
            );
        }
        apply(app, &now);
        if let Err(error) = app.emit(CHANGED_EVENT, ()) {
            log::debug!("{CHANGED_EVENT}: {error}");
        }
    }
    now
}

/// Act on an answer: the HUD, sync. (The analysis' gate and the window
/// read it when they ask.)
fn apply<R: Runtime>(app: &AppHandle<R>, effective: &Effective) {
    if let Some(hud) = app.try_state::<crate::hud::HudState>() {
        hud.apply_plan(effective.features.hud);
    }
    if let Some(sync) = app.try_state::<crate::sync::SyncState>() {
        sync.set_plan_allows(effective.features.desktop_sync);
    }
}

/// Keep an answer in the store.
fn keep<R: Runtime>(app: &AppHandle<R>, key: &str, value: &impl Serialize) {
    let Some(store) = app.try_state::<StoreState>() else {
        return;
    };
    let Some(store) = store.store.as_ref() else {
        return;
    };
    let Ok(text) = serde_json::to_string(value) else {
        return;
    };
    if let Err(error) = store.set_kv(key, &text) {
        log::warn!("entitlements: the answer was not kept: {error}");
    }
}

/// One check: the account's entitlements when signed in, else the public
/// flag. `Ok(())` when an answer came back and was kept.
async fn check<R: Runtime>(
    app: &AppHandle<R>,
    state: &EntitlementsState,
    client: &IngestClient,
) -> Result<(), IngestError> {
    let account = app
        .try_state::<AccountState>()
        .and_then(|state| state.0.clone());
    let at = now_ms();
    match account.as_ref().and_then(|account| account.user()) {
        Some((user_id, _)) => {
            let Some(account) = account else {
                return Err(IngestError::SignedOut);
            };
            let entitlements = client.my_entitlements_as(account.as_ref()).await?;
            // Signed out or switched while the call ran: not this account's.
            if account.user().map(|(id, _)| id).as_deref() != Some(user_id.as_str()) {
                return Err(IngestError::SignedOut);
            }
            let check = AccountCheck {
                user_id,
                fetched_at_ms: at,
                entitlements,
            };
            keep(app, ACCOUNT_KEY, &check);
            state
                .kept
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .account = Some(check);
        }
        None => {
            let enforced = client.billing_enforced().await?;
            let check = EnforcementCheck {
                enforced,
                fetched_at_ms: at,
            };
            keep(app, PUBLIC_KEY, &check);
            state
                .kept
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .public = Some(check);
        }
    }
    Ok(())
}

/// Manage the state and start the loop. Called once from `setup`, after
/// the account and sync (it applies the first answer to both, and starts
/// the HUD when it may).
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let Some(store) = app.try_state::<StoreState>() else {
        return;
    };
    app.manage(EntitlementsState::new(&store));
    let Some(state) = app.try_state::<EntitlementsState>() else {
        return;
    };
    // The first answer from what was kept: no network, so a HUD the plan
    // allows starts at once, offline too.
    refresh(app, &state, true);

    let client = app
        .try_state::<AccountState>()
        .and_then(|state| state.0.clone())
        .and_then(|account| match IngestClient::new(account.config()) {
            Ok(client) => Some(client),
            Err(error) => {
                log::warn!("entitlements: no HTTP client ({error}); only what was kept");
                None
            }
        });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { run(handle, client).await });
}

/// The loop: work the answer out every [`TICK`], check when due or asked.
async fn run<R: Runtime>(app: AppHandle<R>, client: Option<IngestClient>) {
    let mut next_check = tokio::time::Instant::now();
    let mut last_check: Option<tokio::time::Instant> = None;
    let mut last_user = user_of(&app);
    loop {
        let Some(state) = app.try_state::<EntitlementsState>() else {
            return;
        };
        let user = user_of(&app);
        if user != last_user {
            // Signed in, out, or as someone else: check at once.
            next_check = tokio::time::Instant::now();
            last_user.clone_from(&user);
        }
        let mut force = false;
        if let Some(client) = &client
            && next_check <= tokio::time::Instant::now()
        {
            last_check = Some(tokio::time::Instant::now());
            let result = check(&app, &state, client).await;
            let at = now_ms();
            let mut info = state.check.lock().unwrap_or_else(PoisonError::into_inner);
            info.attempted_at_ms = Some(at);
            next_check = tokio::time::Instant::now()
                + match &result {
                    Ok(()) => {
                        info.succeeded_at_ms = Some(at);
                        info.failing = false;
                        force = true;
                        CHECK_EVERY
                    }
                    // A server without the function (before R6.4's
                    // migration): no answer, not worth asking often.
                    Err(IngestError::Refused { .. }) => {
                        info.failing = false;
                        CHECK_EVERY
                    }
                    Err(error) => {
                        log::info!("entitlements: no answer ({error}); keeping what was kept");
                        info.failing = true;
                        RETRY_AFTER
                    }
                };
            drop(info);
        }
        refresh(&app, &state, force);
        let wait_until = next_check.min(tokio::time::Instant::now() + TICK);
        tokio::select! {
            () = tokio::time::sleep_until(wait_until) => {}
            () = state.wake.notified() => {
                // Asked to look again: soon, not in a tight loop.
                let earliest = last_check.map_or_else(tokio::time::Instant::now, |at| at + MIN_GAP);
                next_check = earliest.max(tokio::time::Instant::now());
                if next_check > tokio::time::Instant::now() {
                    tokio::time::sleep_until(next_check).await;
                }
            }
        }
    }
}

/// What [`entitlements_status`] answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementsDto {
    pub effective: Effective,
    pub check: CheckInfo,
    /// The signed-in account's last answer, when it is this account's.
    pub hands_stored: Option<u64>,
    pub hand_cap: Option<u64>,
    /// The server's reason (`subscription`, `grace`, `granted`, ...).
    pub server_reason: Option<String>,
    pub offline_grace_days: Option<u32>,
    /// Where "Upgrade" leads (the web's Plan panel).
    pub upgrade_url: String,
}

fn status<R: Runtime>(app: &AppHandle<R>, state: &EntitlementsState) -> EntitlementsDto {
    let user = user_of(app);
    let account = state
        .kept_account()
        .filter(|check| Some(&check.user_id) == user.as_ref());
    EntitlementsDto {
        effective: state.evaluate(user.as_deref(), now_ms()),
        check: *state.check.lock().unwrap_or_else(PoisonError::into_inner),
        hands_stored: account.as_ref().map(|a| a.entitlements.hands_stored),
        hand_cap: account.as_ref().and_then(|a| a.entitlements.hand_cap),
        server_reason: account.as_ref().map(|a| a.entitlements.reason.clone()),
        offline_grace_days: account.as_ref().map(|a| a.entitlements.offline_grace_days),
        upgrade_url: upgrade_url(),
    }
}

/// The web's Plan panel (`paths.upgrade()`), where Pro is bought (R6.3).
pub fn upgrade_url() -> String {
    format!(
        "{}/settings#plan",
        crate::account::web_url().trim_end_matches('/')
    )
}

/// The plan, for the window.
#[tauri::command]
pub fn entitlements_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, EntitlementsState>,
) -> EntitlementsDto {
    status(&app, &state)
}

/// "Check again".
#[tauri::command]
pub fn entitlements_check_now(state: State<'_, EntitlementsState>) {
    state.check_soon();
}

/// "Upgrade": the web's Plan panel in the default browser.
#[tauri::command]
pub fn entitlements_open_upgrade() -> Result<(), String> {
    // Ours: the configured https origin and a fixed path.
    open::that_detached(upgrade_url()).map_err(|error| error.to_string())
}

/// For tests: an answer kept as if checked.
#[cfg(test)]
impl EntitlementsState {
    fn with(account: Option<AccountCheck>, public: Option<EnforcementCheck>) -> Self {
        Self {
            kept: Mutex::new(Kept { account, public }),
            effective: Mutex::new(None),
            check: Mutex::new(CheckInfo::default()),
            wake: Notify::new(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use rail_sync::entitlements::{EffectivePlan, Features, Reason, ServerEntitlements};

    use super::*;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn answer(plan: &str) -> ServerEntitlements {
        let pro = plan == "pro";
        ServerEntitlements::parse(
            serde_json::json!({
                "plan": plan, "reason": "x", "enforced": true, "offlineGraceDays": 14,
                "features": { "desktop_sync": pro, "hud": pro, "reports_full": pro, "analysis": pro, "learn": pro },
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap()
    }

    /// The store keeps the answers (so an offline start reads them), and a
    /// new state reads them back: the HUD a Pro account may run starts with
    /// no network.
    #[test]
    fn the_answers_are_kept_in_the_store_and_read_back() {
        let dir = std::env::temp_dir().join(format!("rail-app-ent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let opened = store.store.as_ref().unwrap();
        let fetched = now_ms() - DAY;
        let check = AccountCheck {
            user_id: "u1".into(),
            fetched_at_ms: fetched,
            entitlements: answer("pro"),
        };
        opened
            .set_kv(ACCOUNT_KEY, &serde_json::to_string(&check).unwrap())
            .unwrap();
        opened
            .set_kv(
                PUBLIC_KEY,
                &serde_json::to_string(&EnforcementCheck {
                    enforced: true,
                    fetched_at_ms: fetched - DAY,
                })
                .unwrap(),
            )
            .unwrap();
        let state = EntitlementsState::new(&store);
        let pro = state.evaluate(Some("u1"), now_ms());
        assert_eq!((pro.plan, pro.reason), (EffectivePlan::Pro, Reason::Pro));
        let signed_out = state.evaluate(None, now_ms());
        assert_eq!(signed_out.reason, Reason::SignedOut);
        // 14 days on, with no check in between: Free until the next one.
        let later = state.evaluate(Some("u1"), fetched + 14 * DAY + 1);
        assert_eq!(later.reason, Reason::GraceExpired);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No store, nothing kept, enforcement off: today's behaviour, every
    /// feature open.
    #[test]
    fn nothing_kept_is_everything_open() {
        let state = EntitlementsState::with(None, None);
        for user in [None, Some("u1")] {
            let e = state.evaluate(user, now_ms());
            assert_eq!(e.plan, EffectivePlan::Open);
            assert_eq!(e.features, Features::ALL);
        }
        assert!(state.allows_analysis());
        let off = EntitlementsState::with(
            None,
            Some(EnforcementCheck {
                enforced: false,
                fetched_at_ms: now_ms(),
            }),
        );
        assert_eq!(off.evaluate(None, now_ms()).features, Features::ALL);
    }

    #[test]
    fn the_upgrade_page_is_the_webs_plan_panel() {
        assert!(upgrade_url().ends_with("/settings#plan"));
        assert!(upgrade_url().starts_with("http"));
    }
}

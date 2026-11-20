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
//! **The free tier** (2026-11-19): sync is free (Free's features include
//! `desktop_sync`, its fallbacks too), its caps are the server's - the room
//! the last check saw goes to the sync worker (`SyncWorker::set_plan_room`)
//! to size its batches. The solver's flops a day: [`solver_open_flop`] asks
//! the server before a flop's strategy shows (preflop never); offline,
//! today's flops the last answer listed stay open and a new one waits for a
//! connection. "See Pro" opens the web's pricing page.
//!
//! **Enforcement is off today**: the server says `enforced: false` (or the
//! app was never told), every feature is open, signed in or not.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use rail_sync::entitlements::{
    ACCOUNT_KEY, AccountCheck, Effective, EffectivePlan, EnforcementCheck, Inputs, PUBLIC_KEY,
    effective, flop_key,
};
use rail_sync::ingest::{IngestClient, IngestError};
use rail_sync::worker::PlanRoom;
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
    /// The server's client, for [`solver_open_flop`] (set by [`setup`]).
    client: std::sync::OnceLock<IngestClient>,
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
            client: std::sync::OnceLock::new(),
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

    /// `user_id`'s own check, taken while enforcement was on.
    fn enforced_check_of(&self, user_id: Option<&str>) -> Option<AccountCheck> {
        self.kept_account()
            .filter(|check| Some(check.user_id.as_str()) == user_id && check.entitlements.enforced)
    }

    /// (Free tier) What the sync worker may send for `user_id`: the room the
    /// last check saw. `None` while everything is open or with no check.
    fn plan_room(&self, user_id: Option<&str>, effective: &Effective) -> Option<PlanRoom> {
        if effective.plan == EffectivePlan::Open {
            return None;
        }
        let check = self.enforced_check_of(user_id)?;
        let e = check.entitlements;
        Some(PlanRoom {
            user_id: check.user_id,
            checked_at_ms: check.fetched_at_ms,
            daily_cap: e.daily_hand_cap,
            saved_today: e.hands_today,
            resets_at_ms: e.day_resets_at_ms,
            library_cap: e.hand_cap,
            stored: e.hands_stored,
        })
    }

    /// (Free tier) Today's solver flops as `user_id`'s last answer listed
    /// them, while that day lasts.
    fn flops_today(&self, user_id: Option<&str>, now_ms: i64) -> Vec<String> {
        self.kept_account()
            .filter(|check| Some(check.user_id.as_str()) == user_id)
            .filter(|check| {
                check
                    .entitlements
                    .day_resets_at_ms
                    .is_some_and(|at| at > now_ms)
            })
            .map(|check| check.entitlements.flops_today)
            .unwrap_or_default()
    }

    /// (Free tier) The server's answer about the day's flops, into the
    /// kept check (so it holds offline). `false`: not this account's check.
    fn note_flops(&self, user_id: &str, answer: &FlopAnswer) -> Option<AccountCheck> {
        let mut kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        let check = kept.account.as_mut().filter(|c| c.user_id == user_id)?;
        check.entitlements.flops_today.clone_from(&answer.flops);
        check.entitlements.daily_flop_cap = answer.cap;
        if answer.resets_at_ms.is_some() {
            check.entitlements.day_resets_at_ms = answer.resets_at_ms;
        }
        Some(check.clone())
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
        apply(app, &now, state.plan_room(user.as_deref(), &now));
        if let Err(error) = app.emit(CHANGED_EVENT, ()) {
            log::debug!("{CHANGED_EVENT}: {error}");
        }
    }
    now
}

/// Act on an answer: the HUD, sync and its room. (The analysis' gate and
/// the window read it when they ask.)
fn apply<R: Runtime>(app: &AppHandle<R>, effective: &Effective, room: Option<PlanRoom>) {
    if let Some(hud) = app.try_state::<crate::hud::HudState>() {
        hud.apply_plan(effective.features.hud);
    }
    if let Some(sync) = app.try_state::<crate::sync::SyncState>() {
        sync.set_plan_allows(effective.features.desktop_sync);
        sync.set_plan_room(room);
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
    if let Some(client) = &client {
        let _ = state.client.set(client.clone());
    }
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
    /// (Free tier) The day's caps (`None`: unlimited, or not known) and
    /// usage, from this account's last answer; the counts are of the day
    /// that ends at `day_resets_at_ms` (empty once it has).
    pub daily_hand_cap: Option<u64>,
    pub hands_today: Option<u64>,
    pub daily_flop_cap: Option<u32>,
    pub flops_today: Vec<String>,
    pub day_resets_at_ms: Option<i64>,
    /// Where "See Pro" leads (the web's pricing page).
    pub upgrade_url: String,
}

fn status<R: Runtime>(app: &AppHandle<R>, state: &EntitlementsState) -> EntitlementsDto {
    let user = user_of(app);
    let account = state
        .kept_account()
        .filter(|check| Some(&check.user_id) == user.as_ref());
    let now = now_ms();
    let today = account
        .as_ref()
        .is_some_and(|a| a.entitlements.day_resets_at_ms.is_some_and(|at| at > now));
    EntitlementsDto {
        effective: state.evaluate(user.as_deref(), now),
        check: *state.check.lock().unwrap_or_else(PoisonError::into_inner),
        hands_stored: account.as_ref().map(|a| a.entitlements.hands_stored),
        hand_cap: account.as_ref().and_then(|a| a.entitlements.hand_cap),
        server_reason: account.as_ref().map(|a| a.entitlements.reason.clone()),
        offline_grace_days: account.as_ref().map(|a| a.entitlements.offline_grace_days),
        daily_hand_cap: account.as_ref().and_then(|a| a.entitlements.daily_hand_cap),
        hands_today: account
            .as_ref()
            .map(|a| if today { a.entitlements.hands_today } else { 0 }),
        daily_flop_cap: account.as_ref().and_then(|a| a.entitlements.daily_flop_cap),
        flops_today: state.flops_today(user.as_deref(), now),
        day_resets_at_ms: account
            .as_ref()
            .and_then(|a| a.entitlements.day_resets_at_ms),
        upgrade_url: upgrade_url(),
    }
}

/// The web's pricing page, told the visitor came from the app.
pub fn upgrade_url() -> String {
    format!(
        "{}/pricing?from=app",
        crate::account::web_url().trim_end_matches('/')
    )
}

/// The web's Plan panel (`paths.upgrade()`): the subscription, invoices,
/// cancelling (R6.3).
pub fn manage_url() -> String {
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

/// "See Pro": the web's pricing page in the default browser.
#[tauri::command]
pub fn entitlements_open_upgrade() -> Result<(), String> {
    // Ours: the configured https origin and a fixed path.
    open::that_detached(upgrade_url()).map_err(|error| error.to_string())
}

/// "Manage plan": the web's Plan panel in the default browser.
#[tauri::command]
pub fn entitlements_open_manage() -> Result<(), String> {
    open::that_detached(manage_url()).map_err(|error| error.to_string())
}

/// (Free tier) May a flop's strategy show?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FlopVerdict {
    /// Shown: Pro, enforcement off, one of today's flops, or a new one the
    /// server just counted.
    Open,
    /// Today's flops are used.
    Refused,
    /// Enforced and signed out: flops need a (free) account.
    SignIn,
    /// A new flop, and the server cannot be reached to count it.
    Offline,
}

/// The server's `solver_open_flop()` answer, as kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlopAnswer {
    pub allowed: bool,
    pub flops: Vec<String>,
    pub cap: Option<u32>,
    pub resets_at_ms: Option<i64>,
}

/// [`solver_open_flop`]'s answer, for the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlopGate {
    pub verdict: FlopVerdict,
    /// The flop's canonical key.
    pub flop: String,
    /// Today's flops (canonical keys), the cap (`None`: unlimited), and
    /// when the day ends.
    pub flops: Vec<String>,
    pub cap: Option<u32>,
    pub resets_at_ms: Option<i64>,
}

/// (Free tier) Before a flop's strategy shows or a flop is solved: may it?
/// Preflop never asks. Everything open (enforcement off, Pro): yes, no
/// call. Free: the server counts it (`solver_open_flop`); offline, today's
/// flops the last answer listed stay open and a new one waits.
#[tauri::command]
pub async fn solver_open_flop<R: Runtime>(
    app: AppHandle<R>,
    flop: String,
) -> Result<FlopGate, String> {
    let key = flop_key(&flop).ok_or_else(|| "not a flop".to_owned())?;
    let Some(state) = app.try_state::<EntitlementsState>() else {
        return Ok(open_gate(key, Vec::new(), None, None));
    };
    let user = user_of(&app);
    let now = now_ms();
    let effective = state.evaluate(user.as_deref(), now);
    let gate = |verdict, flops: Vec<String>, cap, resets_at_ms| FlopGate {
        verdict,
        flop: key.clone(),
        flops,
        cap,
        resets_at_ms,
    };
    if effective.features.solver_unlimited {
        return Ok(gate(FlopVerdict::Open, Vec::new(), None, None));
    }
    let Some(user_id) = user else {
        return Ok(gate(FlopVerdict::SignIn, Vec::new(), None, None));
    };
    let kept = state.enforced_check_of(Some(&user_id));
    let kept_cap = kept.as_ref().and_then(|c| c.entitlements.daily_flop_cap);
    let kept_resets = kept.as_ref().and_then(|c| c.entitlements.day_resets_at_ms);
    let account = app
        .try_state::<AccountState>()
        .and_then(|state| state.0.clone());
    let answer = match (state.client.get(), account) {
        (Some(client), Some(account)) => client
            .solver_open_flop_as(account.as_ref(), &key)
            .await
            .map(|a| FlopAnswer {
                allowed: a.allowed,
                flops: a.flops,
                cap: a.cap,
                resets_at_ms: a.resets_at_ms,
            }),
        _ => Err(IngestError::Transient("no client".into())),
    };
    match answer {
        Ok(answer) => {
            if let Some(check) = state.note_flops(&user_id, &answer) {
                keep(&app, ACCOUNT_KEY, &check);
                if let Err(error) = app.emit(CHANGED_EVENT, ()) {
                    log::debug!("{CHANGED_EVENT}: {error}");
                }
            }
            let verdict = if answer.allowed {
                FlopVerdict::Open
            } else {
                FlopVerdict::Refused
            };
            Ok(gate(verdict, answer.flops, answer.cap, answer.resets_at_ms))
        }
        // A server that does not count flops (no such function): it is the
        // gate, and it lets every flop through.
        Err(IngestError::Refused { status, code }) => {
            log::info!("solver: the flop was not counted ({status} {code}); open");
            Ok(gate(FlopVerdict::Open, Vec::new(), None, None))
        }
        Err(error) => {
            log::info!("solver: today's flops not reachable ({error})");
            let flops = state.flops_today(Some(&user_id), now);
            let verdict = if flops.contains(&key) {
                FlopVerdict::Open
            } else {
                FlopVerdict::Offline
            };
            Ok(gate(verdict, flops, kept_cap, kept_resets))
        }
    }
}

fn open_gate(
    flop: String,
    flops: Vec<String>,
    cap: Option<u32>,
    resets_at_ms: Option<i64>,
) -> FlopGate {
    FlopGate {
        verdict: FlopVerdict::Open,
        flop,
        flops,
        cap,
        resets_at_ms,
    }
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
            client: std::sync::OnceLock::new(),
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
                "features": { "desktop_sync": true, "hud": pro, "reports_full": pro, "analysis": pro, "learn": pro,
                              "solver_unlimited": pro, "nodelock": pro },
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
    fn see_pro_is_the_pricing_page_and_manage_the_plan_panel() {
        assert!(upgrade_url().ends_with("/pricing?from=app"));
        assert!(upgrade_url().starts_with("http"));
        assert!(manage_url().ends_with("/settings#plan"));
    }

    fn free_check(fetched_at_ms: i64, resets_at_ms: i64) -> AccountCheck {
        let mut entitlements = answer("free");
        entitlements.daily_hand_cap = Some(500);
        entitlements.hands_today = 120;
        entitlements.hand_cap = Some(10_000);
        entitlements.hands_stored = 4_000;
        entitlements.daily_flop_cap = Some(3);
        entitlements.flops_today = vec!["Ks7d2c".into()];
        entitlements.day_resets_at_ms = Some(resets_at_ms);
        AccountCheck {
            user_id: "u1".into(),
            fetched_at_ms,
            entitlements,
        }
    }

    /// (Free tier) The sync worker gets the room the account's own check
    /// saw; nothing while everything is open or for another account.
    #[test]
    fn the_room_for_sync_is_the_accounts_own_check() {
        let now = now_ms();
        let state = EntitlementsState::with(Some(free_check(now - DAY / 2, now + DAY / 2)), None);
        let e = state.evaluate(Some("u1"), now);
        assert_eq!(e.plan, EffectivePlan::Free);
        assert!(e.features.desktop_sync, "sync is free");
        let room = state.plan_room(Some("u1"), &e).unwrap();
        assert_eq!(
            (
                room.daily_cap,
                room.saved_today,
                room.library_cap,
                room.stored
            ),
            (Some(500), 120, Some(10_000), 4_000)
        );
        assert_eq!(room.checked_at_ms, now - DAY / 2);
        assert_eq!(
            state.plan_room(Some("u2"), &state.evaluate(Some("u2"), now)),
            None
        );
        let open = state.evaluate(None, now);
        let mut open_too = open.clone();
        open_too.plan = EffectivePlan::Open;
        assert_eq!(state.plan_room(Some("u1"), &open_too), None);
        // Today's flops hold while the day lasts.
        assert_eq!(state.flops_today(Some("u1"), now), ["Ks7d2c"]);
        assert!(state.flops_today(Some("u1"), now + DAY).is_empty());
        assert!(state.flops_today(Some("u2"), now).is_empty());
        // The server's answer about a new flop is kept in the check.
        let kept = state
            .note_flops(
                "u1",
                &FlopAnswer {
                    allowed: true,
                    flops: vec!["Ks7d2c".into(), "QhJh4s".into()],
                    cap: Some(3),
                    resets_at_ms: Some(now + DAY),
                },
            )
            .unwrap();
        assert_eq!(kept.entitlements.flops_today.len(), 2);
        assert_eq!(
            state.flops_today(Some("u1"), now + DAY / 2 + 1),
            ["Ks7d2c", "QhJh4s"]
        );
        assert!(state.note_flops("u2", &FlopAnswer::default()).is_none());
    }
}

//! The desktop account (docs/RAIL-PLAN.md R1.7): sign-in through the system
//! browser, the `rail://` callback, the session in the OS keychain, and the
//! commands Settings → Account, the first-run screen and Today call.
//!
//! The protocol and the session itself are `rail_sync::auth` (tested there
//! against a fake and, end to end, against a local Supabase stack); this
//! module wires it to the OS:
//!
//! - **Where Supabase is**: compiled in from `RAIL_SUPABASE_URL`,
//!   `RAIL_SUPABASE_ANON_KEY` and `RAIL_WEB_URL` at build time (the URLs
//!   default to production; the anon key, public but not in the repository,
//!   has no default - without it the build is "not configured" and Rail
//!   works offline). A debug build also reads the same variables at run time,
//!   to point a `tauri dev` window at a local stack.
//! - **Deep links**: `tauri-plugin-deep-link` registers `rail` (the macOS
//!   bundle's Info.plist, the Windows installer; at run time too on Windows
//!   and Linux). A link that starts a second process is forwarded to this one
//!   by `tauri-plugin-single-instance` (feature `deep-link`). Only
//!   `rail://auth/...` is acted on; nothing else is logged in full.
//! - **The keychain**: one generic-password entry, service = the app's
//!   identifier, account = `session@<project host>`, holding the refresh
//!   token, the user id and the email (`keyring`). The access token stays in
//!   memory.
//! - **All Supabase calls are made from Rust**, never from the window: no
//!   token ever enters the webview, the refresh runs while the window is
//!   hidden in the tray, and the sync worker (R1.9, `sync.rs`) lives on
//!   this side; every account change wakes it.

use std::sync::Arc;

use rail_sync::auth::{Account, AccountStatus, AuthConfig, GoTrue, Notice, SecretStore};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::{strings, tray};

/// Emitted to the window whenever [`account_status`] would answer
/// differently.
pub const CHANGED_EVENT: &str = "account-changed";

const DEFAULT_SUPABASE_URL: &str = "https://riybwcfnclphacnfawiq.supabase.co";
const DEFAULT_WEB_URL: &str = "https://poker-hand-converter.vercel.app";

/// The account, as app state. `None`: this build has no Supabase
/// configuration (or a broken one, logged).
#[derive(Debug)]
pub struct AccountState(pub Option<Arc<Account<GoTrue>>>);

impl AccountState {
    pub fn status(&self) -> AccountStatus {
        match &self.0 {
            Some(account) => account.status(),
            None => AccountStatus::NotConfigured,
        }
    }
}

/// A build-time value, overridable at run time in a debug build.
fn setting(name: &str, built: Option<&'static str>) -> Option<String> {
    if cfg!(debug_assertions)
        && let Ok(value) = std::env::var(name)
        && !value.trim().is_empty()
    {
        return Some(value);
    }
    built
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn config() -> Option<AuthConfig> {
    let supabase_url = setting("RAIL_SUPABASE_URL", option_env!("RAIL_SUPABASE_URL"))
        .unwrap_or_else(|| DEFAULT_SUPABASE_URL.to_owned());
    let web_url = setting("RAIL_WEB_URL", option_env!("RAIL_WEB_URL"))
        .unwrap_or_else(|| DEFAULT_WEB_URL.to_owned());
    let Some(anon_key) = setting(
        "RAIL_SUPABASE_ANON_KEY",
        option_env!("RAIL_SUPABASE_ANON_KEY"),
    ) else {
        log::info!("account: no Supabase anon key in this build; sign-in is off");
        return None;
    };
    match AuthConfig::new(&supabase_url, &anon_key, &web_url) {
        Ok(config) => Some(config),
        Err(error) => {
            log::error!(
                "account: the Supabase configuration is not usable ({error}); sign-in is off"
            );
            None
        }
    }
}

/// The OS keychain entry that holds the session.
struct Keychain {
    entry: keyring::Entry,
}

impl SecretStore for Keychain {
    fn load(&self) -> Result<Option<String>, String> {
        match self.entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, value: &str) -> Result<(), String> {
        self.entry
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn keychain_store(service: &str, config: &AuthConfig) -> Box<dyn SecretStore> {
    let user = format!("session@{}", config.project_host());
    match keyring::Entry::new(service, &user) {
        Ok(entry) => Box::new(Keychain { entry }),
        Err(error) => {
            // The account manager reports the failure (KeychainUnavailable)
            // when it cannot load or save; an in-memory store keeps the
            // session for this run.
            log::warn!("account: no keychain entry ({error}); the session lasts this run only");
            Box::new(rail_sync::auth::MemoryStore::default())
        }
    }
}

/// Create the account, start its refresh loop, and listen for `rail://`
/// links. Called once from `setup`, after the tray exists.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let account = config().and_then(|config| {
        let api = match GoTrue::new(&config) {
            Ok(api) => api,
            Err(error) => {
                log::error!("account: HTTP client: {error}");
                return None;
            }
        };
        let store = keychain_store(&app.config().identifier, &config);
        let handle = app.clone();
        let account = Arc::new(Account::new(
            config,
            api,
            store,
            Box::new(move || changed(&handle)),
        ));
        let looping = Arc::clone(&account);
        tauri::async_runtime::spawn(async move { looping.run().await });
        Some(account)
    });
    app.manage(AccountState(account));
    refresh_tray(app);

    // Windows and Linux register the scheme at run time as well (the
    // installer does it on Windows; this repairs a moved or portable exe).
    // macOS registers through the bundle's Info.plist only.
    #[cfg(any(windows, target_os = "linux"))]
    {
        if let Err(error) = app.deep_link().register_all() {
            log::warn!("account: could not register rail:// links: {error}");
        }
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_link(&handle, url.as_str());
        }
    });
    // Started by a link (Windows passes it on the command line).
    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                handle_link(app, url.as_str());
            }
        }
        Ok(None) => {}
        Err(error) => log::debug!("account: no start-up link: {error}"),
    }
}

/// A `rail://` link arrived. Only the sign-in callback is acted on.
fn handle_link<R: Runtime>(app: &AppHandle<R>, link: &str) {
    if !link.starts_with("rail://auth/") {
        // Not ours to act on; its text is not logged (it may be anything).
        log::info!("account: ignored a rail:// link that is not a sign-in");
        return;
    }
    log::info!("account: sign-in link received");
    let Some(account) = app
        .try_state::<AccountState>()
        .and_then(|state| state.0.clone())
    else {
        log::warn!("account: a sign-in link arrived but sign-in is off in this build");
        return;
    };
    let handle = app.clone();
    let link = link.to_owned();
    tauri::async_runtime::spawn(async move {
        match account.complete_sign_in(&link).await {
            Ok(()) => log::info!("account: signed in from the browser"),
            Err(notice) => log::info!("account: the sign-in link did not sign in ({notice:?})"),
        }
        // Either way the window shows the outcome.
        crate::show_main_window(&handle);
    });
}

fn changed<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.emit(CHANGED_EVENT, ()) {
        log::debug!("{CHANGED_EVENT}: {error}");
    }
    refresh_tray(app);
    // Signed in, out, or as someone else: the sync worker looks now (R1.9).
    if let Some(sync) = app.try_state::<crate::sync::SyncState>() {
        sync.account_changed();
    }
}

/// The tray's account line.
pub fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    let text = strings::tray();
    let line = match app.try_state::<AccountState>().map(|state| state.status()) {
        Some(AccountStatus::SignedIn { email, online, .. }) => {
            if online {
                (text.account_signed_in)(&email)
            } else {
                (text.account_offline)(&email)
            }
        }
        Some(AccountStatus::SigningIn { .. }) => text.account_signing_in.to_owned(),
        Some(AccountStatus::SignedOut { .. }) => text.account_signed_out.to_owned(),
        Some(AccountStatus::NotConfigured) | None => text.account_offline_only.to_owned(),
    };
    if let Err(error) = tray::set_account(app, &line) {
        log::debug!("tray account line: {error}");
    }
}

fn account_of(state: &AccountState) -> Result<Arc<Account<GoTrue>>, String> {
    state
        .0
        .clone()
        .ok_or_else(|| "Sign-in is not available in this build.".to_owned())
}

#[tauri::command]
pub fn account_status(state: State<'_, AccountState>) -> AccountStatus {
    state.status()
}

/// Start signing in: opens the web's sign-in page in the default browser.
#[tauri::command]
pub fn account_sign_in(state: State<'_, AccountState>) -> Result<AccountStatus, String> {
    let account = account_of(&state)?;
    let url = account
        .begin_sign_in()
        .map_err(|error| format!("Could not start signing in: {error}"))?;
    open_in_browser(&account, url.as_str());
    Ok(account.status())
}

/// Open the page of the sign-in in progress again (the tab was closed).
#[tauri::command]
pub fn account_open_sign_in_page(state: State<'_, AccountState>) -> Result<AccountStatus, String> {
    let account = account_of(&state)?;
    if let Some(url) = account.pending_url() {
        open_in_browser(&account, url.as_str());
    }
    Ok(account.status())
}

#[tauri::command]
pub fn account_cancel_sign_in(state: State<'_, AccountState>) -> Result<AccountStatus, String> {
    let account = account_of(&state)?;
    account.cancel_sign_in();
    Ok(account.status())
}

/// Sign out: forget the session here, end it on the server.
#[tauri::command]
pub async fn account_sign_out(state: State<'_, AccountState>) -> Result<AccountStatus, String> {
    let account = account_of(&state)?;
    account.sign_out().await;
    Ok(account.status())
}

fn open_in_browser(account: &Account<GoTrue>, url: &str) {
    // `url` is ours (`PendingSignIn::authorize_url` over the configured
    // https origin), never text from outside.
    if let Err(error) = open::that_detached(url) {
        log::warn!("account: the browser did not open: {error}");
        account.set_notice(Notice::BrowserFailed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_defaults_are_valid() {
        let config = AuthConfig::new(DEFAULT_SUPABASE_URL, "public-anon-key", DEFAULT_WEB_URL)
            .expect("defaults");
        assert_eq!(config.project_host(), "riybwcfnclphacnfawiq.supabase.co");
        assert_eq!(
            config.web_url.as_str(),
            "https://poker-hand-converter.vercel.app/"
        );
    }

    #[test]
    fn a_missing_build_value_falls_back() {
        assert_eq!(setting("RAIL_TEST_UNSET_VARIABLE", None), None);
        assert_eq!(
            setting("RAIL_TEST_UNSET_VARIABLE", Some("x")),
            Some("x".to_owned())
        );
        assert_eq!(setting("RAIL_TEST_UNSET_VARIABLE", Some("  ")), None);
    }
}

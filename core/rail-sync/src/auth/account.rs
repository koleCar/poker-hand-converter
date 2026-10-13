//! The desktop account: one sign-in in progress at most, one session, a
//! refresh loop, sign-out, and the status the window and the tray show.
//!
//! What is kept where:
//!
//! - the **refresh token**, the account's id and email: in a [`SecretStore`]
//!   (the OS keychain in the app), as one small JSON entry - never in
//!   `settings.json`, never in a log;
//! - the **access token**: in memory only. After a restart the app refreshes
//!   first, so a Windows credential's 2.5 KB limit is never near and a
//!   leaked keychain entry holds no bearer token;
//! - a **sign-in in progress** ([`PendingSignIn`]): in memory only, for ten
//!   minutes. Rail restarted meanwhile means the callback finds nothing to
//!   finish, which is the point.
//!
//! The refresh loop ([`Account::run`]) refreshes five minutes before the
//! access token expires (on the monotonic clock), backs off on network
//! errors (30 s doubling to 10 min; the app keeps working offline), and
//! signs out when GoTrue refuses the refresh token (revoked, reused, user
//! gone). Refreshes, sign-in completion and sign-out are serialised, so a
//! refresh token is never sent twice.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use url::Url;
use zeroize::Zeroize;

use super::AuthConfig;
use super::gotrue::{ApiError, AuthApi, Session};
use super::handoff::{self, Callback, FLOW_TTL, PendingSignIn};
use super::secret::Secret;

/// Where the session is kept between runs.
pub trait SecretStore: Send + Sync + 'static {
    /// The stored value, if any.
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, value: &str) -> Result<(), String>;
    /// Removing what is not there is not an error.
    fn delete(&self) -> Result<(), String>;
}

/// A store in memory: tests, and the last resort when the keychain refuses.
#[derive(Debug, Default)]
pub struct MemoryStore {
    value: Mutex<Option<String>>,
    /// Make every call fail (tests).
    pub broken: std::sync::atomic::AtomicBool,
}

impl MemoryStore {
    pub fn peek(&self) -> Option<String> {
        self.value
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn check(&self) -> Result<(), String> {
        if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
            Err("store unavailable".into())
        } else {
            Ok(())
        }
    }
}

impl SecretStore for MemoryStore {
    fn load(&self) -> Result<Option<String>, String> {
        self.check()?;
        Ok(self.peek())
    }

    fn save(&self, value: &str) -> Result<(), String> {
        self.check()?;
        *self.value.lock().unwrap_or_else(PoisonError::into_inner) = Some(value.to_owned());
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        self.check()?;
        *self.value.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }
}

impl<T: SecretStore> SecretStore for std::sync::Arc<T> {
    fn load(&self) -> Result<Option<String>, String> {
        (**self).load()
    }
    fn save(&self, value: &str) -> Result<(), String> {
        (**self).save(value)
    }
    fn delete(&self) -> Result<(), String> {
        (**self).delete()
    }
}

/// Something the user should be told once; cleared by the next sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Notice {
    /// Cancelled in the browser.
    Cancelled,
    /// No answer from the browser within ten minutes.
    TimedOut,
    /// A sign-in link arrived, but no sign-in is in progress (an older
    /// attempt, or Rail was restarted since).
    NotInProgress,
    /// The link was malformed or did not decrypt.
    InvalidLink,
    /// The server refused the one-time sign-in (expired or already used).
    LinkRejected,
    /// The server could not be reached to finish signing in.
    Offline,
    /// The session ended elsewhere (signed out everywhere, password
    /// changed, account removed): sign in again.
    SessionEnded,
    /// The keychain refused: signed in for this run only.
    KeychainUnavailable,
    /// Signed out here, but the server could not be told.
    SignedOutLocally,
    /// The browser could not be opened (set by the app).
    BrowserFailed,
}

/// What the window and the tray show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AccountStatus {
    /// This build has no Supabase configuration: Rail works offline only.
    NotConfigured,
    SignedOut {
        notice: Option<Notice>,
    },
    /// Waiting for the browser. `url` is the page, to open again.
    SigningIn {
        url: String,
        seconds_left: u64,
        notice: Option<Notice>,
    },
    SignedIn {
        email: String,
        user_id: String,
        /// The last refresh reached the server.
        online: bool,
        notice: Option<Notice>,
    },
}

/// The keychain entry.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    v: u8,
    /// The project it belongs to (`AuthConfig::supabase_url`).
    supabase_url: String,
    user_id: String,
    email: String,
    refresh_token: String,
}

impl Drop for Stored {
    fn drop(&mut self) {
        self.refresh_token.zeroize();
    }
}

struct Pending {
    sign_in: PendingSignIn,
    url: Url,
    deadline: Instant,
}

struct Live {
    access_token: Secret,
    /// When to refresh: five minutes before expiry.
    refresh_at: Instant,
    /// When it stops working.
    expires_at: Instant,
}

#[derive(Default)]
struct Inner {
    pending: Option<Pending>,
    /// The signed-in account, with its refresh token.
    stored: Option<Stored>,
    live: Option<Live>,
    online: bool,
    notice: Option<Notice>,
    /// Bumped by every sign-in and sign-out: a refresh that started before
    /// one must not write its result after it.
    generation: u64,
    failures: u32,
    retry_at: Option<Instant>,
}

/// Refresh this long before the access token expires.
const REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
const BACKOFF_FIRST: Duration = Duration::from_secs(30);
const BACKOFF_MAX: Duration = Duration::from_secs(10 * 60);

/// The account manager.
pub struct Account<A: AuthApi> {
    config: AuthConfig,
    api: A,
    store: Box<dyn SecretStore>,
    inner: Mutex<Inner>,
    /// Serialises everything that spends or replaces a refresh token.
    token_lock: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
    on_change: Box<dyn Fn() + Send + Sync>,
}

impl<A: AuthApi> std::fmt::Debug for Account<A> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Account")
            .field("project", &self.config.project_host())
            .finish_non_exhaustive()
    }
}

impl<A: AuthApi> Account<A> {
    /// Read the stored session (no network). `on_change` is called after
    /// every change of [`Account::status`], from whichever thread made it.
    pub fn new(
        config: AuthConfig,
        api: A,
        store: Box<dyn SecretStore>,
        on_change: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        let mut inner = Inner::default();
        match store.load() {
            Ok(Some(text)) => match serde_json::from_str::<Stored>(&text) {
                Ok(stored)
                    if stored.v == 1 && stored.supabase_url == config.supabase_url.as_str() =>
                {
                    inner.stored = Some(stored);
                }
                Ok(_) => log::info!("account: the stored session is for another project; ignored"),
                Err(_) => log::warn!("account: the stored session is unreadable; ignored"),
            },
            Ok(None) => {}
            Err(error) => {
                log::warn!("account: the keychain could not be read: {error}");
                inner.notice = Some(Notice::KeychainUnavailable);
            }
        }
        Self {
            config,
            api,
            store,
            inner: Mutex::new(inner),
            token_lock: tokio::sync::Mutex::new(()),
            wake: tokio::sync::Notify::new(),
            on_change,
        }
    }

    pub fn config(&self) -> &AuthConfig {
        &self.config
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn changed(&self) {
        (self.on_change)();
        self.wake.notify_one();
    }

    /// What to show. A sign-in past its ten minutes ends here too.
    pub fn status(&self) -> AccountStatus {
        let (status, expired) = {
            let mut inner = self.lock();
            let expired = expire_pending(&mut inner, Instant::now());
            (status_of(&inner), expired)
        };
        if expired {
            self.changed();
        }
        status
    }

    pub fn is_signed_in(&self) -> bool {
        self.lock().stored.is_some()
    }

    /// Start signing in: a new key pair and state (any earlier attempt is
    /// dropped). Returns the page to open in the browser.
    pub fn begin_sign_in(&self) -> Result<Url, handoff::HandoffError> {
        let sign_in = PendingSignIn::new()?;
        Ok(self.begin_with(sign_in))
    }

    /// [`Account::begin_sign_in`] with a given key pair (tests).
    #[doc(hidden)]
    pub fn begin_with(&self, sign_in: PendingSignIn) -> Url {
        let url = sign_in.authorize_url(&self.config.web_url);
        {
            let mut inner = self.lock();
            inner.pending = Some(Pending {
                sign_in,
                url: url.clone(),
                deadline: Instant::now() + FLOW_TTL,
            });
            inner.notice = None;
        }
        log::info!("account: sign-in started in the browser");
        self.changed();
        url
    }

    /// The page of the sign-in in progress, to open again.
    pub fn pending_url(&self) -> Option<Url> {
        self.lock().pending.as_ref().map(|p| p.url.clone())
    }

    pub fn cancel_sign_in(&self) {
        let had = self.lock().pending.take().is_some();
        if had {
            log::info!("account: sign-in cancelled in the app");
            self.changed();
        }
    }

    /// Show a notice the app decided on (the browser did not open).
    pub fn set_notice(&self, notice: Notice) {
        self.lock().notice = Some(notice);
        self.changed();
    }

    /// Finish a sign-in with the deep link that came back. One callback per
    /// sign-in: a link with the right `state` ends the attempt whatever its
    /// outcome. A link for anything else changes nothing but the notice.
    pub async fn complete_sign_in(&self, link: &str) -> Result<(), Notice> {
        let callback = match handoff::parse_callback(link) {
            Ok(callback) => callback,
            Err(error) => {
                log::warn!("account: deep link refused: {error}");
                return Err(self.fail(Notice::InvalidLink));
            }
        };
        let taken = {
            let mut inner = self.lock();
            let now = Instant::now();
            if expire_pending(&mut inner, now) {
                drop(inner);
                self.changed();
                return Err(Notice::TimedOut);
            }
            match inner.pending.as_ref() {
                Some(p) if p.sign_in.state() == callback.state() => inner.pending.take(),
                Some(_) => None,
                None => None,
            }
        };
        let Some(pending) = taken else {
            log::warn!("account: a sign-in link arrived for no sign-in in progress");
            return Err(self.fail(Notice::NotInProgress));
        };
        self.changed();

        let payload = match callback {
            Callback::Refused { reason, .. } => {
                log::info!("account: sign-in refused in the browser ({reason})");
                let notice = if reason == "cancelled" {
                    Notice::Cancelled
                } else {
                    Notice::InvalidLink
                };
                return Err(self.fail(notice));
            }
            Callback::Payload { payload, .. } => payload,
        };
        let handoff = match pending.sign_in.open(&payload) {
            Ok(handoff) => handoff,
            Err(error) => {
                log::warn!("account: sign-in payload refused: {error}");
                return Err(self.fail(Notice::InvalidLink));
            }
        };
        drop(pending);

        let _guard = self.token_lock.lock().await;
        let session = match self.api.verify(&handoff.token_hash).await {
            Ok(session) => session,
            Err(error) => {
                log::warn!("account: the one-time sign-in was not accepted: {error}");
                let notice = match error {
                    ApiError::Rejected { .. } => Notice::LinkRejected,
                    ApiError::Transient(_) => Notice::Offline,
                };
                return Err(self.fail(notice));
            }
        };
        if session.user.id != handoff.user_id {
            log::error!("account: the session is for another user than the handoff named");
            let _ = self.api.logout(&session.access_token).await;
            return Err(self.fail(Notice::InvalidLink));
        }

        // Signing in as someone else replaces the old session; end it.
        let previous = {
            let mut inner = self.lock();
            inner.stored.take();
            inner.live.take()
        };
        if let Some(previous) = previous
            && previous.expires_at > Instant::now()
        {
            let _ = self.api.logout(&previous.access_token).await;
        }

        let email = if session.user.email.is_empty() {
            handoff.email.clone()
        } else {
            session.user.email.clone()
        };
        self.adopt(session, email);
        log::info!("account: signed in");
        Ok(())
    }

    /// Record a failed attempt's notice and tell the window. Returns it.
    fn fail(&self, notice: Notice) -> Notice {
        self.lock().notice = Some(notice);
        self.changed();
        notice
    }

    /// Take a fresh session: memory, then the keychain.
    fn adopt(&self, session: Session, email: String) {
        let now = Instant::now();
        let Session {
            access_token,
            refresh_token,
            expires_in,
            user,
        } = session;
        let stored = Stored {
            v: 1,
            supabase_url: self.config.supabase_url.as_str().to_owned(),
            user_id: user.id,
            email,
            refresh_token: refresh_token.expose().to_owned(),
        };
        let saved = serde_json::to_string(&stored)
            .map_err(|error| error.to_string())
            .and_then(|mut text| {
                let result = self.store.save(&text);
                text.zeroize();
                result
            });
        {
            let mut inner = self.lock();
            inner.generation += 1;
            inner.live = Some(live(access_token, expires_in, now));
            inner.stored = Some(stored);
            inner.online = true;
            inner.failures = 0;
            inner.retry_at = None;
            inner.notice = match saved {
                Ok(()) => None,
                Err(ref error) => {
                    log::warn!("account: the keychain refused the session: {error}");
                    Some(Notice::KeychainUnavailable)
                }
            };
        }
        self.changed();
    }

    /// Refresh now (the loop calls this; R1.9's sync calls
    /// [`Account::access_token`]). Signs out when the server refuses.
    pub async fn refresh(&self) -> Result<(), ApiError> {
        let _guard = self.token_lock.lock().await;
        self.refresh_locked().await
    }

    async fn refresh_locked(&self) -> Result<(), ApiError> {
        let (token, generation, user_id) = {
            let inner = self.lock();
            let Some(stored) = inner.stored.as_ref() else {
                return Ok(());
            };
            (
                Secret::new(stored.refresh_token.clone()),
                inner.generation,
                stored.user_id.clone(),
            )
        };
        let result = self.api.refresh(&token).await;
        let now = Instant::now();
        match result {
            Ok(session) if session.user.id == user_id => {
                let save = {
                    let mut inner = self.lock();
                    if inner.generation != generation {
                        return Ok(());
                    }
                    let Session {
                        access_token,
                        refresh_token,
                        expires_in,
                        ..
                    } = session;
                    inner.live = Some(live(access_token, expires_in, now));
                    inner.online = true;
                    inner.failures = 0;
                    inner.retry_at = None;
                    inner.stored.as_mut().map(|stored| {
                        stored.refresh_token.zeroize();
                        stored.refresh_token = refresh_token.expose().to_owned();
                        serde_json::to_string(&*stored)
                    })
                };
                // Written straight away: the old token is spent now, and a
                // crash before this write signs the user out at the next
                // start (GoTrue would refuse the old token).
                if let Some(Ok(mut text)) = save {
                    if let Err(error) = self.store.save(&text) {
                        log::warn!("account: the keychain refused the refreshed session: {error}");
                        self.lock().notice = Some(Notice::KeychainUnavailable);
                    }
                    text.zeroize();
                }
                log::debug!("account: session refreshed");
                self.changed();
                Ok(())
            }
            Ok(_) => {
                log::error!("account: a refresh returned another user's session");
                self.end_session(generation, Notice::SessionEnded);
                Err(ApiError::Rejected {
                    status: 200,
                    code: "user_mismatch".into(),
                })
            }
            Err(ApiError::Rejected { status, code }) => {
                log::warn!("account: the session was refused ({status} {code}); signed out");
                self.end_session(generation, Notice::SessionEnded);
                Err(ApiError::Rejected { status, code })
            }
            Err(ApiError::Transient(why)) => {
                log::info!("account: refresh failed, will retry: {why}");
                {
                    let mut inner = self.lock();
                    if inner.generation == generation {
                        inner.online = false;
                        inner.failures = inner.failures.saturating_add(1);
                        inner.retry_at = Some(now + backoff(inner.failures));
                    }
                }
                self.changed();
                Err(ApiError::Transient(why))
            }
        }
    }

    fn end_session(&self, generation: u64, notice: Notice) {
        {
            let mut inner = self.lock();
            if inner.generation != generation {
                return;
            }
            inner.generation += 1;
            inner.stored = None;
            inner.live = None;
            inner.online = false;
            inner.notice = Some(notice);
        }
        if let Err(error) = self.store.delete() {
            log::warn!("account: the keychain entry could not be removed: {error}");
        }
        self.changed();
    }

    /// A valid access token for a call to Supabase (R1.8 / R1.9), refreshed
    /// first when it is close to expiring. `None` when signed out or offline.
    pub async fn access_token(&self) -> Option<Secret> {
        let fresh = |inner: &Inner| {
            inner
                .live
                .as_ref()
                .filter(|live| live.expires_at > Instant::now() + Duration::from_secs(30))
                .map(|live| live.access_token.clone())
        };
        if let Some(token) = fresh(&self.lock()) {
            return Some(token);
        }
        let _ = self.refresh().await;
        fresh(&self.lock())
    }

    /// [`Account::access_token`], but only for `user_id`'s session: `None`
    /// when another account, or none, is signed in. The sync worker (R1.9)
    /// sends a store's hands with this, so a token for an account the hands
    /// do not belong to is never used for them - not even when the account
    /// changes between two calls.
    pub async fn access_token_for(&self, user_id: &str) -> Option<Secret> {
        let fresh = |inner: &Inner| {
            if inner.stored.as_ref()?.user_id != user_id {
                return None;
            }
            inner
                .live
                .as_ref()
                .filter(|live| live.expires_at > Instant::now() + Duration::from_secs(30))
                .map(|live| live.access_token.clone())
        };
        if let Some(token) = fresh(&self.lock()) {
            return Some(token);
        }
        let ours = self
            .lock()
            .stored
            .as_ref()
            .is_some_and(|stored| stored.user_id == user_id);
        if !ours {
            return None;
        }
        let _ = self.refresh().await;
        fresh(&self.lock())
    }

    /// The signed-in account: its id and email.
    pub fn user(&self) -> Option<(String, String)> {
        self.lock()
            .stored
            .as_ref()
            .map(|stored| (stored.user_id.clone(), stored.email.clone()))
    }

    /// Sign out: forget the session here at once, then end it on the server
    /// (this session only; the browser's is not touched).
    pub async fn sign_out(&self) {
        let _guard = self.token_lock.lock().await;
        let (stored, live) = {
            let mut inner = self.lock();
            inner.generation += 1;
            inner.pending = None;
            inner.online = false;
            inner.failures = 0;
            inner.retry_at = None;
            inner.notice = None;
            (inner.stored.take(), inner.live.take())
        };
        if let Err(error) = self.store.delete() {
            log::warn!("account: the keychain entry could not be removed: {error}");
        }
        self.changed();
        let Some(stored) = stored else {
            return;
        };
        log::info!("account: signed out");
        // Ending the session needs an access token; after a restart there
        // is none yet, so spend the refresh token for one.
        let access = match live {
            Some(live) if live.expires_at > Instant::now() + Duration::from_secs(10) => {
                Some(live.access_token)
            }
            _ => self
                .api
                .refresh(&Secret::new(stored.refresh_token.clone()))
                .await
                .ok()
                .map(|session| session.access_token),
        };
        let ended = match access {
            Some(token) => self.api.logout(&token).await,
            None => Err(ApiError::Transient("no access token".into())),
        };
        if let Err(error) = ended {
            log::warn!("account: the server could not be told about the sign-out: {error}");
            self.set_notice(Notice::SignedOutLocally);
        }
    }

    /// The background loop: refreshes on time, retries after a network
    /// error, ends a sign-in that waited too long. Never returns.
    pub async fn run(&self) {
        loop {
            let next = self.tick().await;
            match next {
                Some(at) => {
                    tokio::select! {
                        () = tokio::time::sleep_until(at) => {}
                        () = self.wake.notified() => {}
                    }
                }
                None => self.wake.notified().await,
            }
        }
    }

    /// One pass of the loop: do what is due, say when to look again.
    async fn tick(&self) -> Option<Instant> {
        let now = Instant::now();
        let (due, expired) = {
            let mut inner = self.lock();
            let expired = expire_pending(&mut inner, now);
            let due = inner.stored.is_some()
                && inner.retry_at.is_none_or(|at| at <= now)
                && inner
                    .live
                    .as_ref()
                    .is_none_or(|live| live.refresh_at <= now);
            (due, expired)
        };
        if expired {
            self.changed();
        }
        if due {
            let _ = self.refresh().await;
        }
        let inner = self.lock();
        let mut next: Option<Instant> = inner.pending.as_ref().map(|p| p.deadline);
        if inner.stored.is_some() {
            let at = match (&inner.live, inner.retry_at) {
                (_, Some(retry)) => retry,
                (Some(live), None) => live.refresh_at,
                (None, None) => now + BACKOFF_FIRST,
            };
            next = Some(next.map_or(at, |n| n.min(at)));
        }
        next
    }
}

fn live(access_token: Secret, expires_in: Duration, now: Instant) -> Live {
    let margin = REFRESH_MARGIN.min(expires_in / 2);
    Live {
        access_token,
        refresh_at: now + (expires_in - margin),
        expires_at: now + expires_in,
    }
}

fn backoff(failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(5);
    (BACKOFF_FIRST * (1u32 << shift)).min(BACKOFF_MAX)
}

/// Drop a sign-in past its deadline; true when one was dropped.
fn expire_pending(inner: &mut Inner, now: Instant) -> bool {
    if inner.pending.as_ref().is_some_and(|p| now >= p.deadline) {
        inner.pending = None;
        inner.notice = Some(Notice::TimedOut);
        log::info!("account: sign-in timed out");
        true
    } else {
        false
    }
}

fn status_of(inner: &Inner) -> AccountStatus {
    if let Some(pending) = &inner.pending {
        return AccountStatus::SigningIn {
            url: pending.url.to_string(),
            seconds_left: pending
                .deadline
                .saturating_duration_since(Instant::now())
                .as_secs(),
            notice: inner.notice,
        };
    }
    match &inner.stored {
        Some(stored) => AccountStatus::SignedIn {
            email: stored.email.clone(),
            user_id: stored.user_id.clone(),
            online: inner.online,
            notice: inner.notice,
        },
        None => AccountStatus::SignedOut {
            notice: inner.notice,
        },
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

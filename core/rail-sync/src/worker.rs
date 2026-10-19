//! The sync worker (docs/RAIL-PLAN.md R1.9; guideline §4, local-first): a
//! background task that sends the local store's outbox to Supabase with
//! [`IngestClient`] and pulls the account's other hands into the store.
//!
//! **Push.** Each round takes up to 500 hands from the outbox in send order
//! ([`rail_store::Reader::outbox_next`]: hands queued in the last
//! [`SyncConfig::live_window`] first, newest played first - a hand just
//! played is never stuck behind a backfill - then the backlog oldest due
//! first), keeps those of the first hand's folder (one `hand_sources` row per
//! watched folder, registered once and remembered in `kv`), and sends them
//! with `ingest_hands`. Then, per hand:
//!
//! - `inserted` / `duplicate`: the server has it; out of the outbox, marked
//!   synced. A replay is all duplicates, so a crash between the server's
//!   commit and ours costs one resend, never a second row;
//! - `rejected`: out of the outbox into `sync_rejected` with the reason
//!   (resending cannot help); counted per reason in the UI, queued again only
//!   when the user asks (after an update);
//! - a transient failure (no network, a timeout, a 5xx): the batch's hands
//!   count an attempt and wait (`outbox.next_attempt_at`), and the worker
//!   waits too - exponential backoff with jitter, 5 s doubling to 10 min.
//!   Offline is a normal state, not an error;
//! - the account's budget spent (`RateLimited`): no attempt counted (a
//!   refused call costs nothing); wait 1 min doubling to the 10-minute window
//!   (an hour for the daily one), then send a single hand as a probe before
//!   full batches again;
//! - a `401` after one refresh, or a refused call (a bug): logged, backed off,
//!   never a tight loop.
//!
//! Everything that must survive a restart is in the store (outbox, attempts,
//! retry times, rejected hands, source ids, the pull cursor, pause): the
//! worker can be killed at any point and resumes where it was.
//!
//! **Bandwidth.** While the outbox holds more than
//! [`SyncConfig::backlog_threshold`] hands (a backfill), uploads are paced to
//! the cap the user chose (`kv` `sync.cap`, default [`DEFAULT_CAP`]); with
//! tables open (the Phase 3 hook, [`SyncWorker::set_tables_open`]) to at most
//! [`SyncConfig::play_cap`]. A hand on the wire is ~7.5 KB of JSON (gzip is
//! refused by PostgREST, R1.8), so 1 MiB/s is ~140 hands a second.
//!
//! **Accounts.** The store's hands belong to one account (`kv`
//! [`rail_store::sync::OWNER_KEY`]): the first one that signs in. Every call
//! takes its token through [`SyncAccount::access_token_for`] that owner, so
//! the outbox can only ever reach it. Signed out: nothing is sent. Signed in
//! as another account: nothing is sent or pulled until the user answers
//! ([`SyncWorker::answer_account`]) - upload this computer's hands to the
//! new account (every local hand queued again), or keep them apart.
//!
//! **Pull.** Every [`SyncConfig::pull_every`] (and on "Sync now"), the
//! account's hands the store lacks - uploaded on the web, or synced from the
//! account's other computers - are fetched by keyset cursor (`hands_since`,
//! keys first, then the missing PHF) and stored as pulled hands: never
//! queued for upload, the cursor written in the same transaction.
//!
//! **The HUD's layouts** (R3.9): every pass sends the HUD rows written here
//! since the last sync (`rail_store::Reader::hud_sync_dirty`: designs,
//! assignments, dragged panels, per-room settings, tombstones included) with
//! `put_hud_layouts`, and every [`SyncConfig::hud_pull_every`] (and with
//! each hands pull) takes the account's rows back (`GET hud_layouts`) - **last writer wins by `updated_at`**
//! (`rail_store::WriterHandle::hud_sync_apply`). When a pull changed
//! something here, [`SyncWorker::on_hud_layouts`]' hook runs (the app tells
//! the HUD `layout_changed`). A failure there backs the HUD part off on its
//! own and never holds up the hands.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rail_store::sync::OWNER_KEY;
use rail_store::{OutboxEntry, PreparedHand, Reader, Rejection, WriterHandle};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::auth::{Account, ApiError, AuthApi, Secret};
use crate::ingest::{
    Batch, IngestClient, IngestError, IngestReport, IngestRow, RateWindow, RejectReason, RowError,
    RowStatus, SourceId, SourceRegistration, TokenSource,
};

/// The default upload cap while a backfill is large: 1 MiB/s.
pub const DEFAULT_CAP: u64 = 1024 * 1024;

const CAP_KEY: &str = "sync.cap";
const PAUSED_KEY: &str = "sync.paused";
const DEVICE_KEY: &str = "sync.device";
const DECLINED_KEY: &str = "sync.declined";

/// How the worker behaves; [`SyncConfig::default`] is the app's.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    /// Hands queued this recently go first (newest played first).
    pub live_window: Duration,
    /// Hands per call (the server takes 500).
    pub batch_hands: u32,
    /// Look at the outbox at least this often, even without a wake.
    pub idle_poll: Duration,
    /// Pull this often.
    pub pull_every: Duration,
    /// (R3.9) Take the account's HUD layouts back this often (and with every
    /// hands pull): another computer's edit arrives within this, with no
    /// other event here. One small read of a few hundred rows at most.
    pub hud_pull_every: Duration,
    /// Keys per `hands_since` page.
    pub pull_page: u32,
    /// The first wait after a transient failure; doubles to `backoff_max`.
    pub backoff_first: Duration,
    pub backoff_max: Duration,
    /// The first wait after `RateLimited` (10-minute window).
    pub rate_limit_first: Duration,
    /// The bandwidth cap applies above this many queued hands.
    pub backlog_threshold: u64,
    /// The cap with tables open (Phase 3), bytes a second.
    pub play_cap: u64,
    /// The computer's name for `hand_sources`.
    pub device_name: Option<String>,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            live_window: Duration::from_secs(15 * 60),
            batch_hands: 500,
            idle_poll: Duration::from_secs(60),
            pull_every: Duration::from_secs(5 * 60),
            hud_pull_every: Duration::from_secs(60),
            pull_page: 1000,
            backoff_first: Duration::from_secs(5),
            backoff_max: Duration::from_secs(10 * 60),
            rate_limit_first: Duration::from_secs(60),
            backlog_threshold: 2_000,
            play_cap: 256 * 1024,
            device_name: None,
        }
    }
}

/// The signed-in account, as the worker needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncUser {
    pub user_id: String,
    pub email: String,
}

/// The account the worker syncs with: [`Account`], or a fake in tests.
pub trait SyncAccount: Send + Sync + 'static {
    /// Who is signed in, if anyone.
    fn user(&self) -> Option<SyncUser>;
    /// A token for exactly `user_id`'s session, or `None`.
    fn access_token_for(&self, user_id: &str) -> impl Future<Output = Option<Secret>> + Send;
    /// After a `401`: refresh now (a refused refresh signs out).
    fn refresh(&self) -> impl Future<Output = Result<(), ApiError>> + Send;
}

impl<A: AuthApi + 'static> SyncAccount for Account<A> {
    fn user(&self) -> Option<SyncUser> {
        Account::user(self).map(|(user_id, email)| SyncUser { user_id, email })
    }

    fn access_token_for(&self, user_id: &str) -> impl Future<Output = Option<Secret>> + Send {
        Account::access_token_for(self, user_id)
    }

    fn refresh(&self) -> impl Future<Output = Result<(), ApiError>> + Send {
        Account::refresh(self)
    }
}

impl<T: SyncAccount> SyncAccount for Arc<T> {
    fn user(&self) -> Option<SyncUser> {
        T::user(self)
    }

    fn access_token_for(&self, user_id: &str) -> impl Future<Output = Option<Secret>> + Send {
        T::access_token_for(self, user_id)
    }

    fn refresh(&self) -> impl Future<Output = Result<(), ApiError>> + Send {
        T::refresh(self)
    }
}

/// Tokens for one account only: what every call of the worker uses.
struct AsUser<'a, A> {
    account: &'a A,
    user_id: &'a str,
}

impl<A: SyncAccount> TokenSource for AsUser<'_, A> {
    fn access_token(&self) -> impl Future<Output = Option<Secret>> + Send {
        self.account.access_token_for(self.user_id)
    }

    fn refresh(&self) -> impl Future<Output = Result<(), ApiError>> + Send {
        self.account.refresh()
    }
}

/// What the worker is doing, for the window and the tray.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SyncPhase {
    /// Not looked yet.
    Starting,
    /// No account signed in: hands stay on this computer.
    SignedOut,
    /// Paused by the user.
    Paused,
    /// Signed in as another account than the one this computer's hands
    /// belong to: the user must choose.
    AccountMismatch {
        owner_email: Option<String>,
        email: String,
        /// Hands from this computer's files: what uploading would send.
        local_hands: u64,
    },
    /// The user chose to keep this computer's hands apart from the signed-in
    /// account: nothing syncs while it is signed in.
    Declined {
        owner_email: Option<String>,
        email: String,
        local_hands: u64,
    },
    /// Sending (or pulling).
    Syncing,
    /// Nothing waiting.
    UpToDate,
    /// The server cannot be reached; retrying by itself.
    Offline { retry_at_ms: i64 },
    /// The account's sync budget is spent for now.
    RateLimited { retry_at_ms: i64 },
    /// Something that needs a look (a session the server refuses, a store
    /// error); retried later.
    Failed { message: String, retry_at_ms: i64 },
}

/// Refused hands of one reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedCount {
    pub reason: String,
    pub count: u64,
}

/// The worker's status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: SyncPhase,
    pub paused: bool,
    /// Hands waiting to be sent.
    pub outbox: u64,
    /// Of them, queued in the last minutes.
    pub live: u64,
    /// Of them, waiting for a retry.
    pub retrying: u64,
    /// "Syncing `sent` of `total`": since the outbox was last empty.
    pub sent: u64,
    pub total: u64,
    pub rejected: Vec<RejectedCount>,
    /// Hands pulled from the server since the app started.
    pub pulled: u64,
    /// Pulled hands that could not be read (newer PHF than this build).
    pub pull_skipped: u64,
    /// ms of the last successful exchange with the server.
    pub last_sync_at: Option<i64>,
    /// Over the last 30 s of sending.
    pub hands_per_second: Option<u64>,
    pub bytes_per_second: Option<u64>,
    /// The cap the user chose for a large backfill (`None`: none).
    pub cap: Option<u64>,
    /// The cap in force now.
    pub cap_now: Option<u64>,
    pub tables_open: bool,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            phase: SyncPhase::Starting,
            paused: false,
            outbox: 0,
            live: 0,
            retrying: 0,
            sent: 0,
            total: 0,
            rejected: Vec::new(),
            pulled: 0,
            pull_skipped: 0,
            last_sync_at: None,
            hands_per_second: None,
            bytes_per_second: None,
            cap: Some(DEFAULT_CAP),
            cap_now: None,
            tables_open: false,
        }
    }
}

/// The store, as the worker reaches it: its own read connections, and the
/// writer, which [`SyncWorker::stop`] lets go of at once (the store waits for
/// every writer handle when it closes).
#[derive(Debug)]
pub struct StoreAccess {
    reader: Reader,
    writer: Mutex<Option<WriterHandle>>,
}

impl StoreAccess {
    pub fn new(reader: Reader, writer: WriterHandle) -> Self {
        Self {
            reader,
            writer: Mutex::new(Some(writer)),
        }
    }

    /// Open read connections on the store at `path` beside its writer.
    pub fn open(path: &std::path::Path, writer: WriterHandle) -> rail_store::Result<Self> {
        Ok(Self::new(Reader::open(path, 2)?, writer))
    }

    fn writer(&self) -> rail_store::Result<WriterHandle> {
        self.writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(rail_store::Error::WriterGone)
    }

    fn release(&self) {
        self.writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

/// The user's answer to [`SyncPhase::AccountMismatch`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct Answer {
    user_id: String,
    upload: bool,
}

struct Shared {
    status: Mutex<SyncStatus>,
    /// Imports and anything else that may have queued hands.
    wake: Notify,
    /// The user's controls and the account: ends a pacing wait as well.
    interrupt: Notify,
    stop: AtomicBool,
    paused: AtomicBool,
    tables_open: AtomicBool,
    cap: Mutex<Option<u64>>,
    /// "Sync now": pull and retry at once.
    now: AtomicBool,
    answer: Mutex<Option<Answer>>,
    retry_rejected: AtomicBool,
    on_change: Box<dyn Fn() + Send + Sync>,
    /// (R3.9) Called when a pull changed the HUD's layouts here.
    on_hud: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Shared {
    fn update(&self, f: impl FnOnce(&mut SyncStatus)) {
        let changed = {
            let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
            let before = status.clone();
            f(&mut status);
            *status != before
        };
        if changed {
            (self.on_change)();
        }
    }

    fn poke(&self) {
        self.wake.notify_one();
        self.interrupt.notify_one();
    }
}

/// The handle the app keeps: status and controls. Cheap to clone.
#[derive(Clone)]
pub struct SyncWorker {
    shared: Arc<Shared>,
    store: Arc<StoreAccess>,
}

impl std::fmt::Debug for SyncWorker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncWorker").finish_non_exhaustive()
    }
}

impl SyncWorker {
    /// The worker and its task; run the task on the async runtime
    /// (`SyncTask::run`). `on_change` is called when the status changed.
    pub fn new<A: SyncAccount>(
        config: SyncConfig,
        account: A,
        client: IngestClient,
        store: StoreAccess,
        on_change: Box<dyn Fn() + Send + Sync>,
    ) -> (Self, SyncTask<A>) {
        let paused = store.reader.kv(PAUSED_KEY).ok().flatten().as_deref() == Some("1");
        let cap = match store.reader.kv(CAP_KEY).ok().flatten() {
            Some(text) if text == "none" => None,
            Some(text) => text
                .parse()
                .ok()
                .filter(|cap| *cap > 0)
                .or(Some(DEFAULT_CAP)),
            None => Some(DEFAULT_CAP),
        };
        let shared = Arc::new(Shared {
            status: Mutex::new(SyncStatus {
                paused,
                cap,
                ..SyncStatus::default()
            }),
            wake: Notify::new(),
            interrupt: Notify::new(),
            stop: AtomicBool::new(false),
            paused: AtomicBool::new(paused),
            tables_open: AtomicBool::new(false),
            cap: Mutex::new(cap),
            now: AtomicBool::new(true),
            answer: Mutex::new(None),
            retry_rejected: AtomicBool::new(false),
            on_change,
            on_hud: Mutex::new(None),
        });
        let store = Arc::new(store);
        let task = SyncTask {
            shared: Arc::clone(&shared),
            store: Arc::clone(&store),
            account,
            client,
            config,
            retry_at: None,
            failures: 0,
            rate_failures: 0,
            probe: false,
            unknown_sources: 0,
            pull_at: None,
            pull_failures: 0,
            hud_at: None,
            hud_failures: 0,
            hud_pull_at: None,
            pacer: Pacer::default(),
            meter: Meter::default(),
        };
        (Self { shared, store }, task)
    }

    pub fn status(&self) -> SyncStatus {
        self.shared
            .status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Something may have been queued (an import), or the account changed:
    /// look again soon.
    pub fn wake(&self) {
        self.shared.wake.notify_one();
    }

    /// The account changed: look now, ending any wait.
    pub fn account_changed(&self) {
        self.shared.poke();
    }

    /// (R3.9) Run `hook` whenever a pull changed the HUD's layouts here
    /// (another computer's designs, assignments, panel positions).
    pub fn on_hud_layouts(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .shared
            .on_hud
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(hook));
    }

    /// "Sync now": retry what waits, pull, at once.
    pub fn sync_now(&self) {
        self.shared.now.store(true, Ordering::SeqCst);
        self.shared.poke();
    }

    /// Pause or resume (remembered across restarts).
    pub fn set_paused(&self, paused: bool) -> rail_store::Result<()> {
        self.store
            .writer()?
            .set_kv(PAUSED_KEY, if paused { "1" } else { "0" })?;
        self.shared.paused.store(paused, Ordering::SeqCst);
        self.shared.update(|status| status.paused = paused);
        self.shared.poke();
        Ok(())
    }

    /// The upload cap for a large backfill, bytes a second (`None`: no cap).
    pub fn set_cap(&self, cap: Option<u64>) -> rail_store::Result<()> {
        let cap = cap.filter(|cap| *cap > 0);
        let text = cap.map_or_else(|| "none".to_owned(), |cap| cap.to_string());
        self.store.writer()?.set_kv(CAP_KEY, &text)?;
        *self
            .shared
            .cap
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = cap;
        self.shared.update(|status| status.cap = cap);
        self.shared.poke();
        Ok(())
    }

    /// The Phase 3 hook: poker tables are open, so keep the upload small.
    pub fn set_tables_open(&self, open: bool) {
        self.shared.tables_open.store(open, Ordering::SeqCst);
        self.shared.update(|status| status.tables_open = open);
        self.shared.poke();
    }

    /// The answer to [`SyncPhase::AccountMismatch`] (or a change of mind
    /// after [`SyncPhase::Declined`]) for the account signed in as
    /// `user_id`: upload this computer's hands to it, or keep them apart.
    pub fn answer_account(&self, user_id: &str, upload: bool) {
        *self
            .shared
            .answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Answer {
            user_id: user_id.to_owned(),
            upload,
        });
        self.shared.poke();
    }

    /// Queue the refused hands again (after an update).
    pub fn retry_rejected(&self) {
        self.shared.retry_rejected.store(true, Ordering::SeqCst);
        self.shared.poke();
    }

    /// End the task (it stops at its next step) and let go of the store's
    /// writer now.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.store.release();
        self.shared.poke();
    }
}

/// Why a step stopped.
enum Halt {
    /// Look again at this time.
    Until(Instant),
    /// Re-evaluate now (the account or the controls changed).
    Again,
}

/// The background task; see the module documentation.
pub struct SyncTask<A> {
    shared: Arc<Shared>,
    store: Arc<StoreAccess>,
    account: A,
    client: IngestClient,
    config: SyncConfig,
    /// The worker waits until then (backoff, rate limit).
    retry_at: Option<Instant>,
    failures: u32,
    rate_failures: u32,
    /// After a rate limit: send one hand first.
    probe: bool,
    unknown_sources: u32,
    pull_at: Option<Instant>,
    pull_failures: u32,
    /// (R3.9) The HUD part waits until then after a failure.
    hud_at: Option<Instant>,
    hud_failures: u32,
    /// (R3.9) The next pull of the HUD's layouts (`None`: at the next pass).
    hud_pull_at: Option<Instant>,
    pacer: Pacer,
    meter: Meter,
}

impl<A> std::fmt::Debug for SyncTask<A> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncTask").finish_non_exhaustive()
    }
}

/// Run a store call off the async threads.
async fn blocking<T: Send + 'static>(
    store: &Arc<StoreAccess>,
    f: impl FnOnce(&StoreAccess) -> rail_store::Result<T> + Send + 'static,
) -> rail_store::Result<T> {
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || f(&store))
        .await
        .unwrap_or(Err(rail_store::Error::WriterGone))
}

fn now_ms() -> i64 {
    rail_store::time::now_ms()
}

/// `instant` as wall-clock ms, for the window.
fn wall_ms(instant: Instant) -> i64 {
    let ahead = instant.saturating_duration_since(Instant::now());
    now_ms().saturating_add(i64::try_from(ahead.as_millis()).unwrap_or(i64::MAX))
}

fn ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// `first` doubled `failures - 1` times, at most `max`, with "equal jitter"
/// (between half and all of it), so many clients do not retry in step.
pub fn backoff(first: Duration, max: Duration, failures: u32) -> Duration {
    let shift = failures.saturating_sub(1).min(20);
    let full = first.saturating_mul(1u32 << shift).min(max);
    let half = full / 2;
    let mut bytes = [0u8; 4];
    let random = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_or(u32::MAX, |()| u32::from_le_bytes(bytes));
    let extra_ms =
        u64::try_from(half.as_millis() * u128::from(random) / u128::from(u32::MAX)).unwrap_or(0);
    half + Duration::from_millis(extra_ms)
}

/// A random version-4 UUID: this installation's device id.
fn new_device_id() -> String {
    let mut bytes = [0u8; 16];
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).is_err() {
        // No randomness at all: the time still makes it unique enough per
        // machine (it only keys this device's folders on the server).
        bytes[..16].copy_from_slice(&u128::from(now_ms().unsigned_abs()).to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The label a folder gets on the server: the room and the folder's last
/// component, never a path.
fn source_label(site: Option<&str>, path: &str) -> String {
    let last = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    let last = if last.is_empty() { "folder" } else { last };
    let label = match site {
        Some(site) if !site.is_empty() => format!("{site} - {last}"),
        _ => last.to_owned(),
    };
    label.replace(['/', '\\'], " ").chars().take(120).collect()
}

impl<A: SyncAccount> SyncTask<A> {
    /// Run until [`SyncWorker::stop`].
    pub async fn run(mut self) {
        while !self.shared.stop.load(Ordering::SeqCst) {
            let next = match self.pass().await {
                Halt::Again => continue,
                Halt::Until(at) => at,
            };
            if self.shared.stop.load(Ordering::SeqCst) {
                break;
            }
            let at = next.min(Instant::now() + self.config.idle_poll);
            tokio::select! {
                () = tokio::time::sleep_until(at) => {}
                () = self.shared.wake.notified() => {}
                () = self.shared.interrupt.notified() => {}
            }
        }
        self.store.release();
        log::info!("sync: stopped");
    }

    fn halted(&self) -> bool {
        self.shared.stop.load(Ordering::SeqCst) || self.shared.paused.load(Ordering::SeqCst)
    }

    fn idle(&self) -> Instant {
        Instant::now() + self.config.idle_poll
    }

    fn live_since(&self) -> i64 {
        now_ms() - ms(self.config.live_window)
    }

    /// Read the counts into the status. Returns the outbox size.
    async fn refresh_counts(&self) -> Option<u64> {
        let (now, since) = (now_ms(), self.live_since());
        let counts = blocking(&self.store, move |s| s.reader.sync_counts(now, since)).await;
        match counts {
            Ok(counts) => {
                let outbox = counts.outbox;
                self.shared.update(|status| {
                    if outbox == 0 {
                        status.sent = 0;
                    }
                    status.outbox = counts.outbox;
                    status.live = counts.live;
                    status.retrying = counts.retrying;
                    status.total = status.sent + counts.outbox;
                    status.rejected = counts
                        .rejected
                        .into_iter()
                        .map(|(reason, count)| RejectedCount { reason, count })
                        .collect();
                });
                Some(outbox)
            }
            Err(error) => {
                log::warn!("sync: the store's counts: {error}");
                None
            }
        }
    }

    fn set_phase(&self, phase: SyncPhase) {
        self.shared.update(|status| status.phase = phase);
    }

    fn fail(&mut self, message: String) -> Halt {
        self.failures = self.failures.saturating_add(1);
        let wait = backoff(
            self.config.backoff_first,
            self.config.backoff_max,
            self.failures,
        );
        let at = Instant::now() + wait;
        self.retry_at = Some(at);
        self.set_phase(SyncPhase::Failed {
            message,
            retry_at_ms: wall_ms(at),
        });
        Halt::Until(at)
    }

    /// One look: account, owner, push, pull.
    async fn pass(&mut self) -> Halt {
        if self.shared.retry_rejected.swap(false, Ordering::SeqCst) {
            let at = now_ms();
            match blocking(&self.store, move |s| s.writer()?.rejected_requeue(at)).await {
                Ok(n) => log::info!("sync: {n} refused hands queued again"),
                Err(error) => log::warn!("sync: queueing refused hands again: {error}"),
            }
        }
        if self.shared.now.swap(false, Ordering::SeqCst) {
            self.retry_at = None;
            self.pull_at = None;
            self.probe = false;
            let at = now_ms();
            if let Err(error) =
                blocking(&self.store, move |s| s.writer()?.outbox_retry_now(at)).await
            {
                log::warn!("sync: retry now: {error}");
            }
        }
        let outbox = self.refresh_counts().await;
        if self.shared.stop.load(Ordering::SeqCst) {
            return Halt::Until(self.idle());
        }
        if self.shared.paused.load(Ordering::SeqCst) {
            self.set_phase(SyncPhase::Paused);
            return Halt::Until(self.idle());
        }
        let Some(user) = self.account.user() else {
            self.set_phase(SyncPhase::SignedOut);
            return Halt::Until(self.idle());
        };
        match self.check_owner(&user).await {
            Ok(true) => {}
            Ok(false) => return Halt::Until(self.idle()),
            Err(error) => return self.fail(format!("the local store: {error}")),
        }
        if let Some(at) = self.retry_at
            && at > Instant::now()
        {
            return Halt::Until(at);
        }
        if outbox.is_some_and(|n| n > 0) {
            self.set_phase(SyncPhase::Syncing);
        }
        if let Some(halt) = self.push(&user).await {
            return halt;
        }
        let pull_due = self.pull_at.is_none_or(|at| at <= Instant::now());
        if pull_due {
            self.pull(&user).await;
        }
        let hud_pull_due = pull_due || self.hud_pull_at.is_none_or(|at| at <= Instant::now());
        self.sync_hud(&user, hud_pull_due).await;
        let outbox = self.refresh_counts().await.unwrap_or(0);
        if matches!(
            self.status().phase,
            SyncPhase::Failed { .. } | SyncPhase::Offline { .. } | SyncPhase::RateLimited { .. }
        ) && self.retry_at.is_some_and(|at| at > Instant::now())
        {
            return Halt::Until(self.retry_at.unwrap_or_else(|| self.idle()));
        }
        self.set_phase(if outbox == 0 {
            SyncPhase::UpToDate
        } else {
            SyncPhase::Syncing
        });
        let mut next = self.idle();
        if let Some(pull_at) = self.pull_at {
            next = next.min(pull_at);
        }
        if let Some(hud_pull_at) = self.hud_pull_at {
            next = next.min(hud_pull_at.max(self.hud_at.unwrap_or(hud_pull_at)));
        }
        Halt::Until(next)
    }

    fn status(&self) -> SyncStatus {
        self.shared
            .status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The store's owner is `user` (made so if it has none yet). `Ok(false)`:
    /// another account's hands; the phase says what the user must choose.
    async fn check_owner(&mut self, user: &SyncUser) -> rail_store::Result<bool> {
        let owner = blocking(&self.store, |s| s.reader.kv(OWNER_KEY)).await?;
        let owner: Option<SyncUser> = owner.and_then(|text| serde_json::from_str(&text).ok());
        let answer = {
            let mut answer = self
                .shared
                .answer
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match answer.as_ref() {
                Some(a) if a.user_id == user.user_id => answer.take(),
                _ => None,
            }
        };
        let text = serde_json::to_string(user).unwrap_or_default();
        match owner {
            Some(owner) if owner.user_id == user.user_id => Ok(true),
            None => {
                let at = now_ms();
                blocking(&self.store, move |s| {
                    s.writer()?.sync_set_owner(text, false, at)
                })
                .await?;
                log::info!("sync: this computer's hands now sync to the signed-in account");
                Ok(true)
            }
            Some(owner) => {
                if let Some(answer) = answer {
                    if answer.upload {
                        let at = now_ms();
                        let queued = blocking(&self.store, move |s| {
                            let writer = s.writer()?;
                            writer.delete_kv(DECLINED_KEY)?;
                            writer.sync_set_owner(text, true, at)
                        })
                        .await?;
                        log::info!(
                            "sync: uploading this computer's hands to another account ({queued} queued)"
                        );
                        self.pull_at = None;
                        self.shared.update(|status| status.sent = 0);
                        return Ok(true);
                    }
                    let id = user.user_id.clone();
                    blocking(&self.store, move |s| s.writer()?.set_kv(DECLINED_KEY, &id)).await?;
                    log::info!(
                        "sync: keeping this computer's hands apart from the signed-in account"
                    );
                }
                let declined = blocking(&self.store, |s| s.reader.kv(DECLINED_KEY)).await?;
                let local_hands = blocking(&self.store, |s| s.reader.local_hands()).await?;
                let owner_email = Some(owner.email);
                let email = user.email.clone();
                self.set_phase(if declined.as_deref() == Some(user.user_id.as_str()) {
                    SyncPhase::Declined {
                        owner_email,
                        email,
                        local_hands,
                    }
                } else {
                    SyncPhase::AccountMismatch {
                        owner_email,
                        email,
                        local_hands,
                    }
                });
                Ok(false)
            }
        }
    }

    /// The cap in force for a backlog of `outbox` hands.
    fn cap_now(&self, outbox: u64) -> Option<u64> {
        if outbox <= self.config.backlog_threshold {
            return None;
        }
        let cap = *self
            .shared
            .cap
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if self.shared.tables_open.load(Ordering::SeqCst) {
            Some(cap.map_or(self.config.play_cap, |cap| cap.min(self.config.play_cap)))
        } else {
            cap
        }
    }

    /// Send until the outbox has nothing due. `Some`: stop the pass.
    async fn push(&mut self, user: &SyncUser) -> Option<Halt> {
        loop {
            if self.halted() {
                return Some(Halt::Again);
            }
            if self.account.user().as_ref() != Some(user) {
                return Some(Halt::Again);
            }
            let outbox = self.status().outbox;
            let cap = self.cap_now(outbox);
            self.shared.update(|status| status.cap_now = cap);
            if cap.is_some()
                && let Some(wait) = self.pacer.wait(Instant::now())
            {
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    () = self.shared.interrupt.notified() => return Some(Halt::Again),
                }
            }
            let limit = if self.probe {
                1
            } else {
                self.config.batch_hands
            };
            let (now, since) = (now_ms(), self.live_since());
            let rows = match blocking(&self.store, move |s| {
                s.reader.outbox_next(now, since, limit)
            })
            .await
            {
                Ok(rows) => rows,
                Err(error) => return Some(self.fail(format!("the local store: {error}"))),
            };
            // Nothing due: the outbox is drained.
            let first = rows.first()?;
            let folder = first.source_id;
            let group: Vec<OutboxEntry> = rows
                .into_iter()
                .filter(|row| row.source_id == folder)
                .collect();
            let source = match self.source_for(user, folder).await {
                Ok(source) => source,
                Err(error) => {
                    let keys = group.iter().map(|row| row.hand_key.clone()).collect();
                    return Some(self.on_error(error, keys).await);
                }
            };
            if let Some(halt) = self.send_group(user, &source, folder, group, cap).await {
                return Some(halt);
            }
            self.refresh_counts().await;
        }
    }

    /// Send one folder's hands (usually one batch).
    async fn send_group(
        &mut self,
        user: &SyncUser,
        source: &SourceId,
        folder: Option<i64>,
        group: Vec<OutboxEntry>,
        cap: Option<u64>,
    ) -> Option<Halt> {
        let mut rows = Vec::with_capacity(group.len());
        let mut unsendable = Vec::new();
        for entry in &group {
            match IngestRow::new(&entry.hand_key, &entry.phf) {
                Ok(row) => rows.push(row),
                Err(error) => {
                    log::warn!("sync: a stored hand cannot be sent: {error}");
                    unsendable.push(Rejection {
                        hand_key: entry.hand_key.clone(),
                        reason: match error {
                            RowError::Unreadable => "unreadable".to_owned(),
                            RowError::TooLarge(_) => "too-large".to_owned(),
                        },
                        field: None,
                    });
                }
            }
        }
        if !unsendable.is_empty() {
            let at = now_ms();
            if let Err(error) = blocking(&self.store, move |s| {
                s.writer()?.outbox_reject(unsendable, at)
            })
            .await
            {
                return Some(self.fail(format!("the local store: {error}")));
            }
        }
        for batch in Batch::split(rows) {
            let started = Instant::now();
            let bytes = batch.bytes();
            let result = self
                .client
                .ingest_as(
                    &AsUser {
                        account: &self.account,
                        user_id: &user.user_id,
                    },
                    source,
                    &batch,
                )
                .await;
            match result {
                Ok(report) => {
                    if let Err(error) = self.record(report).await {
                        return Some(self.fail(format!("the local store: {error}")));
                    }
                    self.pacer.sent(bytes, cap, started);
                    self.meter.add(bytes, batch.len());
                    self.failures = 0;
                    self.rate_failures = 0;
                    self.unknown_sources = 0;
                    self.probe = false;
                    self.retry_at = None;
                    let (hands, bytes) = self.meter.rates();
                    self.shared.update(|status| {
                        status.last_sync_at = Some(now_ms());
                        status.hands_per_second = hands;
                        status.bytes_per_second = bytes;
                    });
                }
                Err(IngestError::UnknownSource) => {
                    self.unknown_sources = self.unknown_sources.saturating_add(1);
                    let key = source_key(&user.user_id, folder);
                    if let Err(error) =
                        blocking(&self.store, move |s| s.writer()?.delete_kv(&key)).await
                    {
                        return Some(self.fail(format!("the local store: {error}")));
                    }
                    if self.unknown_sources > 2 {
                        let keys = batch.hand_keys().map(str::to_owned).collect();
                        return Some(
                            self.on_error(IngestError::Transient("unknown source".into()), keys)
                                .await,
                        );
                    }
                    log::info!("sync: the server does not know a folder; registering it again");
                    return None;
                }
                Err(error) => {
                    let keys = batch.hand_keys().map(str::to_owned).collect();
                    return Some(self.on_error(error, keys).await);
                }
            }
        }
        None
    }

    /// The server's answer for a batch, into the store.
    async fn record(&mut self, report: IngestReport) -> rail_store::Result<()> {
        let stored: Vec<String> = report.stored_keys().map(str::to_owned).collect();
        let refused: Vec<Rejection> = report
            .rejections()
            .map(|row| {
                let (reason, field) = match &row.status {
                    RowStatus::Rejected { reason, field } => (reason.clone(), field.clone()),
                    _ => (RejectReason::Other("unknown".into()), None),
                };
                Rejection {
                    hand_key: row.hand_key.clone(),
                    reason: reason.code().to_owned(),
                    field,
                }
            })
            .collect();
        if !refused.is_empty() {
            log::warn!("sync: the server refused {} hands", refused.len());
        }
        let done = u64::try_from(report.rows.len()).unwrap_or(0);
        let at = now_ms();
        blocking(&self.store, move |s| {
            let writer = s.writer()?;
            writer.outbox_mark_sent(stored, at)?;
            if !refused.is_empty() {
                writer.outbox_reject(refused, at)?;
            }
            Ok(())
        })
        .await?;
        self.shared.update(|status| status.sent += done);
        Ok(())
    }

    /// The server cannot be reached: back off, say so calmly.
    fn offline(&mut self, why: String) -> Halt {
        log::info!("sync: the server is not reachable ({why}); retrying later");
        self.failures = self.failures.saturating_add(1);
        let wait = backoff(
            self.config.backoff_first,
            self.config.backoff_max,
            self.failures,
        );
        let at = Instant::now() + wait;
        self.retry_at = Some(at);
        self.set_phase(SyncPhase::Offline {
            retry_at_ms: wall_ms(at),
        });
        Halt::Until(at)
    }

    /// A call failed: what to do with its hands and the worker.
    async fn on_error(&mut self, error: IngestError, keys: Vec<String>) -> Halt {
        match error {
            IngestError::SignedOut if self.account.user().is_some() => {
                // Still signed in, but no token: the session could not be
                // refreshed (offline). Not the hands' fault.
                self.offline("no session token".into())
            }
            IngestError::SignedOut => {
                log::info!("sync: signed out; stopping until the next sign-in");
                Halt::Again
            }
            IngestError::RateLimited { window } => {
                self.rate_failures = self.rate_failures.saturating_add(1);
                let wait = match window {
                    RateWindow::Minutes => backoff(
                        self.config.rate_limit_first,
                        self.config.backoff_max.max(self.config.rate_limit_first),
                        self.rate_failures,
                    ),
                    RateWindow::Day => Duration::from_secs(60 * 60),
                    RateWindow::Unknown => self.config.backoff_max,
                };
                log::info!("sync: the account's sync budget is spent; waiting {wait:?}");
                let at = Instant::now() + wait;
                self.retry_at = Some(at);
                self.probe = true;
                self.set_phase(SyncPhase::RateLimited {
                    retry_at_ms: wall_ms(at),
                });
                Halt::Until(at)
            }
            IngestError::Transient(why) => {
                let halt = self.offline(why.clone());
                let next = self.retry_at.map_or_else(now_ms, wall_ms);
                if let Err(error) = blocking(&self.store, move |s| {
                    s.writer()?
                        .outbox_mark_failed(keys, &format!("offline: {why}"), next)
                })
                .await
                {
                    log::warn!("sync: recording a failed send: {error}");
                }
                halt
            }
            IngestError::Unauthorized => {
                log::warn!("sync: the server refuses this session even after a refresh");
                self.fail("the server does not accept this session".into())
            }
            IngestError::Refused { status, code } => {
                // A bug (a batch over the limits, a malformed body): never
                // resend the same thing in a loop. The hands wait an hour,
                // doubling to a day; the rest of the outbox goes on.
                log::error!("sync: the server refused a call ({status} {code})");
                let next = now_ms() + 60 * 60 * 1000;
                let reason = format!("refused: {status} {code}");
                match blocking(&self.store, move |s| {
                    s.writer()?.outbox_mark_failed(keys, &reason, next)
                })
                .await
                {
                    Ok(()) => Halt::Again,
                    Err(error) => self.fail(format!("the local store: {error}")),
                }
            }
            IngestError::UnknownSource => self.fail("the server does not know a folder".into()),
        }
    }

    /// The `hand_sources` id of a folder (`None`: files in no folder) for
    /// `user`, registered on first use and remembered in `kv`.
    async fn source_for(
        &mut self,
        user: &SyncUser,
        folder: Option<i64>,
    ) -> Result<SourceId, IngestError> {
        let key = source_key(&user.user_id, folder);
        let lookup = key.clone();
        let known = blocking(&self.store, move |s| s.reader.kv(&lookup))
            .await
            .map_err(|error| IngestError::Transient(format!("the local store: {error}")))?;
        if let Some(id) = known.as_deref().and_then(SourceId::parse) {
            return Ok(id);
        }
        let device_id = self
            .device_id()
            .await
            .map_err(|error| IngestError::Transient(format!("the local store: {error}")))?;
        let (label, site) = match folder {
            Some(id) => {
                let sources = blocking(&self.store, |s| s.reader.sources())
                    .await
                    .map_err(|error| IngestError::Transient(format!("the local store: {error}")))?;
                match sources.into_iter().find(|source| source.id == id) {
                    Some(source) => {
                        let site = source.site.or(source.site_override);
                        (source_label(site.as_deref(), &source.path), site)
                    }
                    None => ("folder".to_owned(), None),
                }
            }
            None => ("Other files".to_owned(), None),
        };
        let registration = SourceRegistration {
            device_id,
            local_id: folder.map_or_else(|| "unfiled".to_owned(), |id| id.to_string()),
            device_name: self
                .config
                .device_name
                .as_ref()
                .map(|name| name.chars().take(64).collect()),
            label: Some(label),
            site,
        };
        let id = self
            .client
            .register_source_as(
                &AsUser {
                    account: &self.account,
                    user_id: &user.user_id,
                },
                &registration,
            )
            .await?;
        let value = id.as_str().to_owned();
        blocking(&self.store, move |s| s.writer()?.set_kv(&key, &value))
            .await
            .map_err(|error| IngestError::Transient(format!("the local store: {error}")))?;
        log::info!("sync: a folder was registered with the server");
        Ok(id)
    }

    /// This installation's random device id, made on first use.
    async fn device_id(&self) -> rail_store::Result<String> {
        if let Some(id) = blocking(&self.store, |s| s.reader.kv(DEVICE_KEY)).await? {
            return Ok(id);
        }
        let id = new_device_id();
        let value = id.clone();
        blocking(&self.store, move |s| s.writer()?.set_kv(DEVICE_KEY, &value)).await?;
        Ok(id)
    }

    /// (R3.9) The HUD's layouts: send what changed here; with a pull, take
    /// the account's rows back. A failure backs this part off on its own.
    async fn sync_hud(&mut self, user: &SyncUser, pull: bool) {
        if self.halted() || self.hud_at.is_some_and(|at| at > Instant::now()) {
            return;
        }
        match self.hud_rounds(user, pull).await {
            Ok(changed) => {
                self.hud_failures = 0;
                self.hud_at = None;
                if pull {
                    self.hud_pull_at = Some(Instant::now() + self.config.hud_pull_every);
                }
                if changed {
                    let hook = self
                        .shared
                        .on_hud
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone();
                    if let Some(hook) = hook {
                        hook();
                    }
                }
            }
            Err(error) => {
                log::info!("sync: HUD layouts: {error}");
                self.hud_failures = self.hud_failures.saturating_add(1);
                let wait = backoff(
                    self.config.backoff_first,
                    self.config.backoff_max,
                    self.hud_failures,
                );
                self.hud_at = Some(Instant::now() + wait);
            }
        }
    }

    /// One send (and pull); whether a pulled row changed something here.
    async fn hud_rounds(&mut self, user: &SyncUser, pull: bool) -> Result<bool, IngestError> {
        let store_error =
            |error: rail_store::Error| IngestError::Transient(format!("the local store: {error}"));
        let as_user = AsUser {
            account: &self.account,
            user_id: &user.user_id,
        };
        let dirty = blocking(&self.store, |s| s.reader.hud_sync_dirty())
            .await
            .map_err(store_error)?;
        for chunk in dirty.chunks(crate::ingest::HUD_ROWS_PER_PUT) {
            let outcome = self.client.put_hud_layouts_as(&as_user, chunk).await?;
            let refused = outcome.iter().filter(|o| !o.applied).count();
            log::info!(
                "sync: {} HUD layout rows sent ({refused} older than the server's)",
                chunk.len()
            );
            // Sent: clean here, unless the row changed meanwhile. A row the
            // server kept its newer copy of comes back with the pull.
            let sent: Vec<_> = chunk
                .iter()
                .map(|row| (row.kind, row.key.clone(), row.updated_at))
                .collect();
            blocking(&self.store, move |s| s.writer()?.hud_sync_pushed(sent))
                .await
                .map_err(store_error)?;
        }
        if !pull {
            return Ok(false);
        }
        let remote = self.client.hud_layouts_as(&as_user).await?;
        if remote.is_empty() {
            return Ok(false);
        }
        let applied = blocking(&self.store, move |s| s.writer()?.hud_sync_apply(remote))
            .await
            .map_err(store_error)?;
        if applied.applied > 0 || applied.refused > 0 {
            log::info!(
                "sync: HUD layouts pulled: {} taken, {} kept, {} unreadable",
                applied.applied,
                applied.kept,
                applied.refused
            );
        }
        Ok(applied.applied > 0)
    }

    /// Fetch the account's hands this store lacks, page by page.
    async fn pull(&mut self, user: &SyncUser) {
        match self.pull_pages(user).await {
            Ok(()) => {
                self.pull_failures = 0;
                self.pull_at = Some(Instant::now() + self.config.pull_every);
            }
            Err(error) => {
                log::info!("sync: pull: {error}");
                self.pull_failures = self.pull_failures.saturating_add(1);
                let wait = backoff(
                    self.config.backoff_first,
                    self.config.backoff_max,
                    self.pull_failures,
                )
                .max(self.config.backoff_first);
                self.pull_at = Some(Instant::now() + wait);
            }
        }
    }

    async fn pull_pages(&mut self, user: &SyncUser) -> Result<(), IngestError> {
        let cursor_key = format!("sync.pull.{}", user.user_id);
        let store_error =
            |error: rail_store::Error| IngestError::Transient(format!("the local store: {error}"));
        let lookup = cursor_key.clone();
        let mut cursor: Option<PullCursor> = blocking(&self.store, move |s| s.reader.kv(&lookup))
            .await
            .map_err(store_error)?
            .and_then(|text| serde_json::from_str(&text).ok());
        loop {
            if self.halted() || self.account.user().as_ref() != Some(user) {
                return Ok(());
            }
            let as_user = AsUser {
                account: &self.account,
                user_id: &user.user_id,
            };
            let after = cursor
                .as_ref()
                .map(|c| (c.created_at.as_str(), c.id.as_str()));
            let page = self
                .client
                .hands_since_as(&as_user, after, self.config.pull_page)
                .await?;
            let Some(last) = page.last() else {
                return Ok(());
            };
            let next = PullCursor {
                created_at: last.created_at.clone(),
                id: last.id.clone(),
            };
            let keys: Vec<String> = page.iter().map(|row| row.hand_key.clone()).collect();
            let present = blocking(&self.store, move |s| s.reader.hands_present(&keys))
                .await
                .map_err(store_error)?;
            let missing: Vec<&str> = page
                .iter()
                .filter(|row| !present.contains(&row.hand_key))
                .map(|row| row.id.as_str())
                .collect();
            let mut prepared = Vec::with_capacity(missing.len());
            let mut skipped = 0u64;
            for ids in missing.chunks(crate::ingest::PHF_IDS_PER_CALL) {
                for remote in self.client.hands_phf_as(&as_user, ids).await? {
                    match serde_json::from_value::<rail_core::phf::PhfHand>(remote.phf)
                        .ok()
                        .and_then(|hand| PreparedHand::from_phf(&hand).ok())
                    {
                        Some(hand) => {
                            if hand.hand_key != remote.hand_key {
                                log::warn!("sync: a pulled hand's key differs from the server's");
                            }
                            prepared.push(hand);
                        }
                        None => skipped += 1,
                    }
                }
            }
            if skipped > 0 {
                log::warn!("sync: {skipped} pulled hands could not be read by this build");
            }
            let full = page.len() >= usize::try_from(self.config.pull_page).unwrap_or(usize::MAX);
            let value = serde_json::to_string(&next).unwrap_or_default();
            let key = cursor_key.clone();
            let at = now_ms();
            let outcome = blocking(&self.store, move |s| {
                s.writer()?.import_pulled(prepared, Some((key, value)), at)
            })
            .await
            .map_err(store_error)?;
            if outcome.inserted > 0 {
                log::info!("sync: pulled {} hands", outcome.inserted);
            }
            self.shared.update(|status| {
                status.pulled += outcome.inserted;
                status.pull_skipped += skipped;
                status.last_sync_at = Some(now_ms());
            });
            cursor = Some(next);
            if !full {
                return Ok(());
            }
        }
    }
}

fn source_key(user_id: &str, folder: Option<i64>) -> String {
    match folder {
        Some(id) => format!("sync.source.{user_id}.{id}"),
        None => format!("sync.source.{user_id}.unfiled"),
    }
}

/// Where the pull stopped: the last row's `(created_at, id)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullCursor {
    created_at: String,
    id: String,
}

/// Paces uploads to a cap: after `b` bytes the next send may start `b / cap`
/// seconds after the previous one could.
#[derive(Debug, Default)]
pub struct Pacer {
    next_free: Option<Instant>,
}

impl Pacer {
    /// How long to wait before the next send, if at all.
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        self.next_free
            .filter(|at| *at > now)
            .map(|at| at.duration_since(now))
    }

    /// `bytes` were sent, starting at `started`, under `cap`.
    pub fn sent(&mut self, bytes: usize, cap: Option<u64>, started: Instant) {
        let Some(cap) = cap.filter(|cap| *cap > 0) else {
            self.next_free = None;
            return;
        };
        let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
        let base = self.next_free.map_or(started, |at| at.max(started));
        self.next_free = Some(base + Duration::from_millis(bytes.saturating_mul(1000) / cap));
    }
}

/// Hands and bytes sent over the last 30 s.
#[derive(Debug, Default)]
struct Meter {
    sends: VecDeque<(Instant, usize, usize)>,
}

const METER_WINDOW: Duration = Duration::from_secs(30);

impl Meter {
    fn add(&mut self, bytes: usize, hands: usize) {
        let now = Instant::now();
        self.sends.push_back((now, bytes, hands));
        while self
            .sends
            .front()
            .is_some_and(|(at, _, _)| now.duration_since(*at) > METER_WINDOW)
        {
            self.sends.pop_front();
        }
    }

    /// (hands, bytes) a second, from the first send in the window to now.
    fn rates(&self) -> (Option<u64>, Option<u64>) {
        let Some((first, _, _)) = self.sends.front() else {
            return (None, None);
        };
        let elapsed = u64::try_from(first.elapsed().as_millis())
            .unwrap_or(u64::MAX)
            .max(1_000);
        let (bytes, hands) = self
            .sends
            .iter()
            .fold((0u64, 0u64), |(b, h), (_, bytes, hands)| {
                (
                    b + u64::try_from(*bytes).unwrap_or(0),
                    h + u64::try_from(*hands).unwrap_or(0),
                )
            });
        (Some(hands * 1000 / elapsed), Some(bytes * 1000 / elapsed))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

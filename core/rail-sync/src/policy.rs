//! The remote `sites.json` (docs/RAIL-PLAN.md §3.6, R3.10; guideline §7,
//! "compliance mode"): the app ships a copy of `config/sites.json` and keeps
//! it current from the web origin, so a room that withdraws its permission is
//! switched off without waiting for a release.
//!
//! - **Where**: `<web origin>/sites.json` - a static file the web build copies
//!   from `config/sites.json` (`web/scripts/sites-json.mjs`), so the
//!   repository's file is the only source; the owner updates it with a normal
//!   pull request, and it is live once the web deploys (no app release).
//! - **Fetch** ([`PolicyFetcher`]): HTTPS only (plain HTTP only to a loopback
//!   address, for tests and a local web), the operating system's certificate
//!   verifier (rustls-platform-verifier, as for sign-in), no redirects,
//!   `If-None-Match` / `If-Modified-Since` from the last good copy, 10 s to
//!   connect, 20 s in all, at most [`MAX_BYTES`].
//! - **Checked whole** ([`rail_config::load_remote`]): the strict schema
//!   (`deny_unknown_fields`, this build's `version`) and every validator rule,
//!   or the file is refused and nothing of it is used. **No signature**: a
//!   downloaded file can only make the policy *stricter* than the shipped one
//!   (R0.12's merge: a room's HUD only switched off, restrictions only added,
//!   table graphics only grown, process names only narrowed; unknown ids
//!   ignored). The worst a forged file could do through a broken TLS chain is
//!   switch the HUD off - never on - which TLS plus the merge rule already
//!   bound; a signing key would add a secret to keep for no gain in safety.
//! - **Cached on disk** ([`PolicyCache`]): the last copy that passed, with its
//!   validators, written atomically (a temporary file renamed over it). The
//!   HUD process reads the same file at start (`rail-hud --policy`), so a
//!   room the remote copy switched off is never attached for a moment. The
//!   cache is merged by the same rule, so a hand-edited cache can only make
//!   things stricter too.
//! - **Failure** keeps what is in force: offline, a timeout, a 5xx, a refused
//!   file - the last good merged copy stays (or the shipped one, before any).
//!   The cache never expires: a stricter copy stays until a newer one
//!   replaces it.
//!
//! [`PolicyKeeper`] is the app's single source: the merged configuration the
//! HUD, the popup and the editor all read, the remote text for the HUD's
//! `policy` message, and what the HUD screen says about the last check.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rail_config::{Config, MergeNote};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use url::Url;

/// A remote file larger than this is refused unread (the real one is ~40 KB).
pub const MAX_BYTES: usize = 1 << 20;

const TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the app looks for a new copy.
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// After a failed look, the next one comes sooner.
pub const RETRY: Duration = Duration::from_secs(30 * 60);
/// The first look waits this long after start (the app has other work then).
pub const FIRST: Duration = Duration::from_secs(5);

/// The path of the file on the web origin.
pub const REMOTE_PATH: &str = "sites.json";

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// SHA-256 of `text`, hex: ties the cache's validators to its text.
fn digest(text: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The HTTP validators of a copy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// What a look at the web origin brought.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    /// `304`: the copy we have is current.
    NotModified,
    /// A new body (not checked yet).
    Body {
        text: String,
        validators: Validators,
    },
}

/// Why a look failed. Never fatal: what is in force stays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// No network, DNS, TLS, a timeout.
    Network(String),
    /// An HTTP status other than 200 or 304.
    Status(u16),
    /// The body is larger than [`MAX_BYTES`].
    TooLarge,
    /// The body is not UTF-8 text.
    NotText,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(error) => write!(f, "not reached: {error}"),
            Self::Status(status) => write!(f, "the web answered {status}"),
            Self::TooLarge => write!(f, "larger than {MAX_BYTES} bytes"),
            Self::NotText => f.write_str("not text"),
        }
    }
}

/// Plain HTTP is only for a loopback address (a test server, `next dev`).
fn acceptable(url: &Url) -> bool {
    match url.scheme() {
        "https" => url.host().is_some(),
        "http" => match url.host() {
            Some(url::Host::Domain(host)) => host == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

/// `<web origin>/sites.json`.
pub fn remote_url(web: &Url) -> Result<Url, String> {
    let url = web
        .join(&format!("/{REMOTE_PATH}"))
        .map_err(|error| format!("{web}: {error}"))?;
    if acceptable(&url) {
        Ok(url)
    } else {
        Err(format!("{url}: only HTTPS (or HTTP to this computer)"))
    }
}

/// The HTTP side.
#[derive(Debug, Clone)]
pub struct PolicyFetcher {
    http: reqwest::Client,
    url: Url,
}

impl PolicyFetcher {
    /// A fetcher for `url` ([`remote_url`]); refuses anything but HTTPS, or
    /// HTTP to a loopback address.
    pub fn new(url: Url) -> Result<Self, String> {
        if !acceptable(&url) {
            return Err(format!("{url}: only HTTPS (or HTTP to this computer)"));
        }
        // As in `auth::gotrue`: reqwest without a default crypto provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("Rail/", env!("CARGO_PKG_VERSION")))
            // The file is at one address; a redirect is a misconfiguration
            // (or worse), not something to follow.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("http client: {error}"))?;
        Ok(Self { http, url })
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    /// One look, conditional on `validators` when given.
    pub async fn fetch(&self, validators: Option<&Validators>) -> Result<Fetched, FetchError> {
        let mut request = self
            .http
            .get(self.url.clone())
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(validators) = validators {
            if let Some(etag) = &validators.etag {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            if let Some(date) = &validators.last_modified {
                request = request.header(reqwest::header::IF_MODIFIED_SINCE, date);
            }
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| FetchError::Network(error.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(Fetched::NotModified);
        }
        if status != reqwest::StatusCode::OK {
            return Err(FetchError::Status(status.as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > u64::try_from(MAX_BYTES).unwrap_or(u64::MAX))
        {
            return Err(FetchError::TooLarge);
        }
        let header = |name: reqwest::header::HeaderName| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let validators = Validators {
            etag: header(reqwest::header::ETAG),
            last_modified: header(reqwest::header::LAST_MODIFIED),
        };
        // Read in chunks, so a server that lies about its length (or sends
        // none) cannot make the app hold more than the limit.
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| FetchError::Network(error.to_string()))?
        {
            if body.len() + chunk.len() > MAX_BYTES {
                return Err(FetchError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(body).map_err(|_| FetchError::NotText)?;
        Ok(Fetched::Body { text, validators })
    }
}

/// The cache's record of its copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    pub url: String,
    #[serde(flatten)]
    pub validators: Validators,
    /// When this copy was downloaded, Unix seconds.
    pub fetched_at: u64,
    /// SHA-256 of the cached text: validators that do not belong to the text
    /// (a crash between the two writes) are not sent.
    pub sha256: String,
}

/// The last good copy on disk: `sites.json` (what the HUD reads too) and
/// `sites.meta.json`.
#[derive(Debug, Clone)]
pub struct PolicyCache {
    dir: PathBuf,
}

impl PolicyCache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The cached remote file (`rail-hud --policy`).
    pub fn file(&self) -> PathBuf {
        self.dir.join("sites.json")
    }

    fn meta_file(&self) -> PathBuf {
        self.dir.join("sites.meta.json")
    }

    /// The cached text and, when they belong to it, its validators.
    pub fn load(&self) -> Option<(String, Option<CacheMeta>)> {
        let text = std::fs::read_to_string(self.file()).ok()?;
        let meta = std::fs::read_to_string(self.meta_file())
            .ok()
            .and_then(|meta| serde_json::from_str::<CacheMeta>(&meta).ok())
            .filter(|meta| meta.sha256 == digest(&text));
        Some((text, meta))
    }

    /// Keep `text` (already checked) as the last good copy: the text first,
    /// then its record, each through a temporary file renamed over the old.
    pub fn store(&self, text: &str, meta: &CacheMeta) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        write_atomic(&self.file(), text.as_bytes())?;
        let meta = serde_json::to_vec_pretty(meta).map_err(std::io::Error::other)?;
        write_atomic(&self.meta_file(), &meta)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)
}

/// The policy in force.
#[derive(Debug, Clone)]
pub struct Policy {
    /// The shipped copy merged with the remote one (or the shipped copy).
    pub config: Arc<Config>,
    /// The remote text in force, for the HUD's `policy` message; `None`:
    /// the shipped copy alone.
    pub remote: Option<Arc<str>>,
    /// What the merge did not take from the remote copy.
    pub notes: Vec<MergeNote>,
    /// When the remote copy in force was downloaded, Unix seconds.
    pub fetched_at: Option<u64>,
}

/// How the last look went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// A new copy, checked and in force.
    Updated,
    /// The copy in force is current (`304`, or the same text).
    Current,
    /// A copy came but was refused whole (schema, version, validator); the
    /// copy in force stays.
    Refused { error: String },
    /// Not reached (or an unusable answer); the copy in force stays.
    Failed { error: String },
}

/// A look and when it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Unix seconds.
    pub at: u64,
    pub outcome: Outcome,
}

#[derive(Debug)]
struct Inner {
    policy: Policy,
    validators: Option<Validators>,
    last_check: Option<Check>,
}

/// The app's single source of HUD policy (see the module's header).
#[derive(Debug)]
pub struct PolicyKeeper {
    shipped: Arc<Config>,
    parsers: Vec<&'static str>,
    cache: PolicyCache,
    fetcher: Option<PolicyFetcher>,
    inner: Mutex<Inner>,
    wake: Notify,
}

impl PolicyKeeper {
    /// The shipped copy, and over it the cached remote copy when one passes
    /// (a cached copy that is refused - a newer build's format, a damaged
    /// file - is left alone and not used). `fetcher: None`: no remote copy
    /// is ever fetched (the cache is still read).
    pub fn open(
        shipped: Config,
        parsers: &[&'static str],
        cache: PolicyCache,
        fetcher: Option<PolicyFetcher>,
    ) -> Self {
        let shipped = Arc::new(shipped);
        let mut policy = Policy {
            config: Arc::clone(&shipped),
            remote: None,
            notes: Vec::new(),
            fetched_at: None,
        };
        let mut validators = None;
        if let Some((text, meta)) = cache.load() {
            match rail_config::load_remote(&shipped, &text, parsers) {
                Ok(merged) => {
                    policy = Policy {
                        config: Arc::new(merged.config),
                        remote: Some(Arc::from(text)),
                        notes: merged.notes,
                        fetched_at: meta.as_ref().map(|m| m.fetched_at),
                    };
                    validators = meta.map(|m| m.validators);
                }
                Err(error) => log::warn!("policy: the cached remote copy is not used: {error}"),
            }
        }
        Self {
            shipped,
            parsers: parsers.to_vec(),
            cache,
            fetcher,
            inner: Mutex::new(Inner {
                policy,
                validators,
                last_check: None,
            }),
            wake: Notify::new(),
        }
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The policy in force.
    pub fn current(&self) -> Policy {
        self.inner().policy.clone()
    }

    /// The last look, if any since start.
    pub fn last_check(&self) -> Option<Check> {
        self.inner().last_check.clone()
    }

    /// The cached remote file (the HUD's `--policy`).
    pub fn cache_file(&self) -> PathBuf {
        self.cache.file()
    }

    /// Where the remote copy comes from, if anywhere.
    pub fn url(&self) -> Option<&Url> {
        self.fetcher.as_ref().map(PolicyFetcher::url)
    }

    /// One look at the web origin. Returns the new policy when it changed.
    pub async fn check(&self) -> Option<Policy> {
        let fetcher = self.fetcher.as_ref()?;
        let validators = self.inner().validators.clone();
        let (outcome, changed) = match fetcher.fetch(validators.as_ref()).await {
            Ok(Fetched::NotModified) => (Outcome::Current, None),
            Ok(Fetched::Body { text, validators }) => self.take(fetcher, text, validators),
            Err(error) => (
                Outcome::Failed {
                    error: error.to_string(),
                },
                None,
            ),
        };
        match &outcome {
            Outcome::Updated => log::info!("policy: a new remote sites.json is in force"),
            Outcome::Current => log::debug!("policy: the remote sites.json is current"),
            Outcome::Refused { error } => {
                log::warn!("policy: the remote sites.json was refused: {error}");
            }
            Outcome::Failed { error } => log::info!("policy: no remote sites.json: {error}"),
        }
        self.inner().last_check = Some(Check {
            at: unix_now(),
            outcome,
        });
        changed
    }

    fn take(
        &self,
        fetcher: &PolicyFetcher,
        text: String,
        validators: Validators,
    ) -> (Outcome, Option<Policy>) {
        let merged = match rail_config::load_remote(&self.shipped, &text, &self.parsers) {
            Ok(merged) => merged,
            Err(error) => {
                return (
                    Outcome::Refused {
                        error: error.to_string(),
                    },
                    None,
                );
            }
        };
        for note in &merged.notes {
            // Every loosening the merge refused is worth a line.
            if !matches!(note, MergeNote::MissingFromRemote { .. }) {
                log::info!("policy: {note}");
            }
        }
        let fetched_at = unix_now();
        let meta = CacheMeta {
            url: fetcher.url().to_string(),
            validators: validators.clone(),
            fetched_at,
            sha256: digest(&text),
        };
        if let Err(error) = self.cache.store(&text, &meta) {
            // Still in force for this run; the next start uses the old copy
            // (or the shipped one) until a look succeeds again.
            log::warn!("policy: the remote copy was not cached: {error}");
        }
        let mut inner = self.inner();
        inner.validators = Some(validators);
        let same = inner.policy.remote.as_deref() == Some(text.as_str());
        if same {
            inner.policy.fetched_at = Some(fetched_at);
            return (Outcome::Current, None);
        }
        inner.policy = Policy {
            config: Arc::new(merged.config),
            remote: Some(Arc::from(text)),
            notes: merged.notes,
            fetched_at: Some(fetched_at),
        };
        (Outcome::Updated, Some(inner.policy.clone()))
    }

    /// Look now ("Check now" in the app): wakes [`Self::run`].
    pub fn check_soon(&self) {
        self.wake.notify_one();
    }

    /// The loop: a first look shortly after start, then every [`EVERY`]
    /// ([`RETRY`] after a failure), or when [`Self::check_soon`] asks;
    /// `changed` hears every new policy. Never returns.
    pub async fn run(&self, changed: impl Fn(&Policy)) {
        if self.fetcher.is_none() {
            return;
        }
        let mut wait = FIRST;
        loop {
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = self.wake.notified() => {}
            }
            if let Some(policy) = self.check().await {
                changed(&policy);
            }
            let failed = matches!(
                self.last_check().map(|c| c.outcome),
                Some(Outcome::Failed { .. } | Outcome::Refused { .. })
            );
            wait = if failed { RETRY } else { EVERY };
        }
    }
}

#[cfg(test)]
mod tests;

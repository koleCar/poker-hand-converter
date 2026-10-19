//! The desktop's side of `ingest_hands` (docs/RAIL-PLAN.md R1.8): rows,
//! batches and the two calls - `register_hand_source` and `ingest_hands` -
//! with the account's token. The sync worker that drains the outbox with
//! them is R1.9.
//!
//! **What is sent (Q4, 2026-10-13).** A hand is `{hand_key, phf}` and
//! nothing else: the PHF with `meta.rawText` emptied (the original files stay
//! on the user's disk), no standard text (the web derives it), no search
//! columns (the server derives every one from the PHF; migration
//! `20270428090000_desktop_ingest.sql`). The server refuses a row that still
//! carries its raw text, so [`IngestRow::from_outbox`] empties it.
//!
//! **Batches.** At most [`MAX_BATCH_HANDS`] hands and [`MAX_BATCH_BYTES`] of
//! JSON per call (the server's limits are 500 and 8 MiB). Request bodies go
//! uncompressed: PostgREST refuses a gzip body (`PGRST102`), checked against
//! a local stack; a hand is ~2-3 KB of compact JSON, so a full batch is
//! ~1.5 MB.
//!
//! **Tokens.** [`IngestClient::ingest_as`] takes a fresh bearer token from
//! the account for every call, and on a `401` asks the account to refresh
//! once and tries again; a refused refresh signs the account out (R1.7) and
//! the call ends [`IngestError::SignedOut`].

use std::fmt::Write as _;
use std::future::Future;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::auth::{Account, ApiError, AuthApi, AuthConfig, Secret};

/// Hands per call (the server takes at most 500).
pub const MAX_BATCH_HANDS: usize = 500;
/// JSON bytes per call, rows and envelope (the server takes at most 8 MiB).
pub const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
/// One hand's PHF as sent (the server's `too-large` limit, 256 KiB).
pub const MAX_PHF_BYTES: usize = 256 * 1024;

const TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One hand, ready to send: its key and its PHF as compact JSON with
/// `meta.rawText` empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestRow {
    hand_key: String,
    /// `{"hand_key":..,"phf":..}`, serialized once.
    json: String,
}

/// Why a stored hand cannot be sent. Permanent: the hand will not become
/// sendable by retrying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowError {
    /// The stored PHF is not a JSON object with a `meta` object.
    Unreadable,
    /// Over [`MAX_PHF_BYTES`] even without its raw text.
    TooLarge(usize),
}

impl std::fmt::Display for RowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => f.write_str("the stored PHF is unreadable"),
            Self::TooLarge(bytes) => write!(f, "the PHF is too large to sync ({bytes} bytes)"),
        }
    }
}

impl std::error::Error for RowError {}

impl IngestRow {
    /// From the local store's canonical PHF JSON (`OutboxItem::phf`).
    pub fn new(hand_key: &str, phf_json: &str) -> Result<Self, RowError> {
        let mut phf: Value = serde_json::from_str(phf_json).map_err(|_| RowError::Unreadable)?;
        let meta = phf
            .get_mut("meta")
            .and_then(Value::as_object_mut)
            .ok_or(RowError::Unreadable)?;
        // Q4: the original text stays on this machine.
        meta.insert("rawText".to_owned(), Value::String(String::new()));
        let phf = serde_json::to_string(&phf).map_err(|_| RowError::Unreadable)?;
        if phf.len() > MAX_PHF_BYTES {
            return Err(RowError::TooLarge(phf.len()));
        }
        let key = serde_json::to_string(hand_key).map_err(|_| RowError::Unreadable)?;
        Ok(Self {
            hand_key: hand_key.to_owned(),
            json: format!(r#"{{"hand_key":{key},"phf":{phf}}}"#),
        })
    }

    /// From an outbox entry.
    pub fn from_outbox(item: &rail_store::read::OutboxItem) -> Result<Self, RowError> {
        Self::new(&item.hand_key, &item.phf)
    }

    pub fn hand_key(&self) -> &str {
        &self.hand_key
    }

    /// Bytes this row adds to a request body.
    pub fn len(&self) -> usize {
        self.json.len()
    }

    pub fn is_empty(&self) -> bool {
        self.json.is_empty()
    }
}

/// Up to [`MAX_BATCH_HANDS`] rows and [`MAX_BATCH_BYTES`] of JSON: one call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Batch {
    rows: Vec<IngestRow>,
    bytes: usize,
}

/// `{"p_source":"<36>","p_rows":[` + `]}`.
const ENVELOPE_BYTES: usize = 64;

impl Batch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a row; hands it back when the batch is full (by count or size).
    /// A batch always takes its first row ([`IngestRow`] caps a PHF far
    /// below the byte limit).
    pub fn push(&mut self, row: IngestRow) -> Result<(), IngestRow> {
        let added = row.len() + usize::from(!self.rows.is_empty());
        let full = self.rows.len() >= MAX_BATCH_HANDS
            || (!self.rows.is_empty() && ENVELOPE_BYTES + self.bytes + added > MAX_BATCH_BYTES);
        if full {
            return Err(row);
        }
        self.bytes += added;
        self.rows.push(row);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// The JSON bytes of the rows.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn rows(&self) -> &[IngestRow] {
        &self.rows
    }

    pub fn hand_keys(&self) -> impl Iterator<Item = &str> {
        self.rows.iter().map(IngestRow::hand_key)
    }

    /// Split rows into batches, in order.
    pub fn split(rows: impl IntoIterator<Item = IngestRow>) -> Vec<Batch> {
        let mut out = Vec::new();
        let mut current = Batch::new();
        for row in rows {
            if let Err(row) = current.push(row) {
                out.push(std::mem::take(&mut current));
                // An empty batch takes any row.
                let _ = current.push(row);
            }
        }
        if !current.is_empty() {
            out.push(current);
        }
        out
    }

    fn body(&self, source: &SourceId) -> String {
        let mut body = String::with_capacity(ENVELOPE_BYTES + self.bytes);
        let _ = write!(body, r#"{{"p_source":"{}","p_rows":["#, source.0);
        for (i, row) in self.rows.iter().enumerate() {
            if i > 0 {
                body.push(',');
            }
            body.push_str(&row.json);
        }
        body.push_str("]}");
        body
    }
}

/// A `hand_sources` id, from [`IngestClient::register_source`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceId(String);

impl SourceId {
    /// A stored id (R1.9 keeps it per folder); `None` unless it is a UUID.
    pub fn parse(text: &str) -> Option<Self> {
        is_uuid(text).then(|| Self(text.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A watched folder, as the server is told about it. **No path**: the
/// server refuses a label with a path separator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRegistration {
    /// A random UUID per installation.
    pub device_id: String,
    /// The local store's id for the folder (`sources.id`).
    pub local_id: String,
    /// The computer's name, as the user would recognise it.
    pub device_name: Option<String>,
    /// The room and the folder's last component, e.g. `WePlay - hands`.
    pub label: Option<String>,
    pub site: Option<String>,
}

/// What the server said about one row, in the batch's order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowStatus {
    Inserted,
    /// Already in the library (sent before, or uploaded on the web): the
    /// server has it.
    Duplicate,
    /// Refused; sending it again will not help.
    Rejected {
        reason: RejectReason,
        /// For `Invalid`: the column whose rule the derived row broke.
        field: Option<String>,
    },
}

impl RowStatus {
    /// Inserted or duplicate: the hand can leave the outbox.
    pub fn is_stored(&self) -> bool {
        matches!(self, Self::Inserted | Self::Duplicate)
    }
}

/// `ingest_hands`'s reason codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectReason {
    /// Not an object, or the PHF lacks what the mapping reads.
    Shape,
    /// Not `phf/1`.
    Schema,
    /// The key is not `site:id`, or not the PHF's own.
    HandKey,
    /// `meta.rawText` was not empty (Q4).
    RawText,
    /// Over 256 KiB.
    TooLarge,
    /// The derived row breaks a `hands` rule (see `field`).
    Invalid,
    /// A code this build does not know.
    Other(String),
}

impl RejectReason {
    fn parse(code: &str) -> Self {
        match code {
            "shape" => Self::Shape,
            "schema" => Self::Schema,
            "hand-key" => Self::HandKey,
            "raw-text" => Self::RawText,
            "too-large" => Self::TooLarge,
            "invalid" => Self::Invalid,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn code(&self) -> &str {
        match self {
            Self::Shape => "shape",
            Self::Schema => "schema",
            Self::HandKey => "hand-key",
            Self::RawText => "raw-text",
            Self::TooLarge => "too-large",
            Self::Invalid => "invalid",
            Self::Other(code) => code,
        }
    }
}

/// One row's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowOutcome {
    pub hand_key: String,
    pub status: RowStatus,
}

/// The answer to one batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestReport {
    pub received: usize,
    pub inserted: usize,
    pub duplicates: usize,
    pub rejected: usize,
    /// One per row sent, in the same order.
    pub rows: Vec<RowOutcome>,
}

impl IngestReport {
    /// Keys the server has now (inserted or duplicate).
    pub fn stored_keys(&self) -> impl Iterator<Item = &str> {
        self.rows
            .iter()
            .filter(|row| row.status.is_stored())
            .map(|row| row.hand_key.as_str())
    }

    /// Rows the server refused.
    pub fn rejections(&self) -> impl Iterator<Item = &RowOutcome> {
        self.rows.iter().filter(|row| !row.status.is_stored())
    }
}

/// Why a call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestError {
    /// No session, or the server ended it: keep the outbox, sync after the
    /// next sign-in.
    SignedOut,
    /// Still `401` after a refresh: the token is not accepted here.
    Unauthorized,
    /// The account's budget is spent (`53400`): wait for the window (10
    /// minutes or a day, from the server's message) and send again. A
    /// refused call costs no budget (it rolls back).
    RateLimited { window: RateWindow },
    /// The source id is unknown or not this account's (`23503`): register
    /// the folder again.
    UnknownSource,
    /// The server refused the call itself (`4xx`: a batch over the limits,
    /// a malformed body). A bug: do not resend the same batch.
    Refused { status: u16, code: String },
    /// No answer, a timeout, a `5xx`, an answer we could not read: retry
    /// later with backoff. Never carries a body.
    Transient(String),
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => f.write_str("not signed in"),
            Self::Unauthorized => f.write_str("the server does not accept this session"),
            Self::RateLimited { .. } => f.write_str("the account's sync budget is spent for now"),
            Self::UnknownSource => f.write_str("the server does not know this folder"),
            Self::Refused { status, code } => write!(f, "refused ({status} {code})"),
            Self::Transient(why) => write!(f, "not reachable: {why}"),
        }
    }
}

impl std::error::Error for IngestError {}

/// Which budget a `53400` spent: what to wait for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateWindow {
    /// `desktop_ingest:<uid>` (150 000 rows), `hand_source:<uid>` or
    /// (R3.9) `hud_layouts:<uid>`: a window of 10 minutes.
    Minutes,
    /// `desktop_ingest_day:<uid>` (2 000 000 rows a day).
    Day,
    /// Another refusal with the same code (200 sources per account).
    Unknown,
}

impl RateWindow {
    fn of(message: &str) -> Self {
        if message.contains("desktop_ingest_day:") {
            Self::Day
        } else if message.contains("desktop_ingest:")
            || message.contains("hand_source:")
            || message.contains("hud_layouts:")
        {
            Self::Minutes
        } else {
            Self::Unknown
        }
    }
}

/// Where [`IngestClient::ingest_as`] gets its bearer token: the account
/// (a fake in tests).
pub trait TokenSource: Send + Sync {
    /// A token valid for at least 30 s, or `None` when signed out or offline.
    fn access_token(&self) -> impl Future<Output = Option<Secret>> + Send;
    /// After a `401`: get a new token now. `Err(Rejected)` signs out.
    fn refresh(&self) -> impl Future<Output = Result<(), ApiError>> + Send;
}

impl<A: AuthApi> TokenSource for Account<A> {
    fn access_token(&self) -> impl Future<Output = Option<Secret>> + Send {
        Account::access_token(self)
    }

    fn refresh(&self) -> impl Future<Output = Result<(), ApiError>> + Send {
        Account::refresh(self)
    }
}

/// PostgREST's RPC endpoints for the two calls.
#[derive(Debug, Clone)]
pub struct IngestClient {
    http: reqwest::Client,
    rpc_base: Url,
    /// `rest/v1/`, for the pull's table reads.
    rest_base: Url,
    anon_key: Secret,
}

impl IngestClient {
    pub fn new(config: &AuthConfig) -> Result<Self, IngestError> {
        // As in `auth::gotrue`: reqwest without a default crypto provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("Rail/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| IngestError::Transient(format!("http client: {error}")))?;
        let rpc_base = config
            .supabase_url
            .join("rest/v1/rpc/")
            .map_err(|_| IngestError::Transient("bad Supabase URL".into()))?;
        let rest_base = config
            .supabase_url
            .join("rest/v1/")
            .map_err(|_| IngestError::Transient("bad Supabase URL".into()))?;
        Ok(Self {
            http,
            rpc_base,
            rest_base,
            anon_key: config.anon_key.clone(),
        })
    }

    fn endpoint(&self, function: &str) -> Url {
        // `function` is one of our literals, so this cannot fail.
        self.rpc_base
            .join(function)
            .unwrap_or_else(|_| self.rpc_base.clone())
    }

    async fn call(
        &self,
        token: &Secret,
        function: &str,
        body: String,
    ) -> Result<Vec<u8>, IngestError> {
        let request = self.http.post(self.endpoint(function)).body(body);
        self.send(token, request).await
    }

    async fn send(
        &self,
        token: &Secret,
        request: reqwest::RequestBuilder,
    ) -> Result<Vec<u8>, IngestError> {
        let response = request
            .header("apikey", self.anon_key.expose())
            .bearer_auth(token.expose())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| IngestError::Transient(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| IngestError::Transient(error.without_url().to_string()))?;
        if (200..300).contains(&status) {
            return Ok(bytes.to_vec());
        }
        Err(error_of(status, &bytes))
    }

    /// Register (or rename) a watched folder; the id to send hands under.
    /// Idempotent per (account, device, local id).
    pub async fn register_source(
        &self,
        token: &Secret,
        source: &SourceRegistration,
    ) -> Result<SourceId, IngestError> {
        let body = serde_json::json!({
            "p_device_id": source.device_id,
            "p_local_id": source.local_id,
            "p_device_name": source.device_name,
            "p_label": source.label,
            "p_site": source.site,
        })
        .to_string();
        let bytes = self.call(token, "register_hand_source", body).await?;
        let id: String = serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable source id".into()))?;
        SourceId::parse(&id).ok_or_else(|| IngestError::Transient("unreadable source id".into()))
    }

    /// Send one batch.
    pub async fn ingest(
        &self,
        token: &Secret,
        source: &SourceId,
        batch: &Batch,
    ) -> Result<IngestReport, IngestError> {
        let bytes = self.call(token, "ingest_hands", batch.body(source)).await?;
        report_of(&bytes, batch)
    }

    /// [`IngestClient::register_source`] with the account's token.
    pub async fn register_source_as(
        &self,
        account: &impl TokenSource,
        source: &SourceRegistration,
    ) -> Result<SourceId, IngestError> {
        with_token(account, |token| async move {
            self.register_source(&token, source).await
        })
        .await
    }

    /// [`IngestClient::ingest`] with the account's token: a fresh one per
    /// call, one refresh and retry after a `401`.
    pub async fn ingest_as(
        &self,
        account: &impl TokenSource,
        source: &SourceId,
        batch: &Batch,
    ) -> Result<IngestReport, IngestError> {
        with_token(account, |token| async move {
            self.ingest(&token, source, batch).await
        })
        .await
    }
}

async fn with_token<T, F, Fut>(account: &impl TokenSource, call: F) -> Result<T, IngestError>
where
    F: Fn(Secret) -> Fut,
    Fut: Future<Output = Result<T, IngestError>>,
{
    let token = account.access_token().await.ok_or(IngestError::SignedOut)?;
    match call(token).await {
        Err(IngestError::Unauthorized) => {}
        other => return other,
    }
    // The session may have been revoked or rotated elsewhere: refresh once.
    match account.refresh().await {
        Ok(()) => {}
        Err(ApiError::Rejected { .. }) => return Err(IngestError::SignedOut),
        Err(ApiError::Transient(why)) => return Err(IngestError::Transient(why)),
    }
    let token = account.access_token().await.ok_or(IngestError::SignedOut)?;
    call(token).await
}

#[derive(Deserialize)]
struct PostgrestError {
    code: Option<String>,
    message: Option<String>,
}

fn error_of(status: u16, body: &[u8]) -> IngestError {
    let error = serde_json::from_slice::<PostgrestError>(body).ok();
    let message = error
        .as_ref()
        .and_then(|error| error.message.clone())
        .unwrap_or_default();
    let code = error
        .and_then(|error| error.code)
        .filter(|code| code.len() <= 16 && code.bytes().all(|b| b.is_ascii_alphanumeric()))
        .unwrap_or_default();
    match (status, code.as_str()) {
        (401, _) => IngestError::Unauthorized,
        (_, "53400") => IngestError::RateLimited {
            window: RateWindow::of(&message),
        },
        (_, "23503") => IngestError::UnknownSource,
        (408 | 429, _) => IngestError::Transient(format!("HTTP {status}")),
        (400..=499, _) => IngestError::Refused {
            status,
            code: if code.is_empty() {
                "unknown".into()
            } else {
                code
            },
        },
        _ => IngestError::Transient(format!("HTTP {status}")),
    }
}

#[derive(Deserialize)]
struct ReportBody {
    received: usize,
    inserted: usize,
    duplicates: usize,
    rejected: usize,
    rows: Vec<RowBody>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowBody {
    hand_key: Option<String>,
    status: String,
    reason: Option<String>,
    field: Option<String>,
}

fn report_of(bytes: &[u8], batch: &Batch) -> Result<IngestReport, IngestError> {
    let unreadable = || IngestError::Transient("unreadable ingest report".into());
    let body: ReportBody = serde_json::from_slice(bytes).map_err(|_| unreadable())?;
    if body.received != batch.len() || body.rows.len() != batch.len() {
        return Err(unreadable());
    }
    let rows = body
        .rows
        .into_iter()
        .zip(batch.rows())
        .map(|(row, sent)| {
            // The server echoes the key it was sent; a row it could not read
            // has none. Either way the outcome is for the row at this index.
            if row
                .hand_key
                .as_deref()
                .is_some_and(|key| key != sent.hand_key())
            {
                return Err(unreadable());
            }
            let status = match row.status.as_str() {
                "inserted" => RowStatus::Inserted,
                "duplicate" => RowStatus::Duplicate,
                "rejected" => RowStatus::Rejected {
                    reason: RejectReason::parse(row.reason.as_deref().unwrap_or("")),
                    field: row.field,
                },
                _ => return Err(unreadable()),
            };
            Ok(RowOutcome {
                hand_key: sent.hand_key().to_owned(),
                status,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(IngestReport {
        received: body.received,
        inserted: body.inserted,
        duplicates: body.duplicates,
        rejected: body.rejected,
        rows,
    })
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

mod hud;
mod pull;

pub use hud::{HUD_ROWS_PER_PAGE, HUD_ROWS_PER_PUT, PutOutcome};
pub use pull::{PHF_IDS_PER_CALL, RemoteHand, RemoteKey};

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

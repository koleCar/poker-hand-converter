//! The flop library for the app's analysis (docs/RAIL-PLAN.md R5.4;
//! `docs/ANALYSIS-PLAN.md` §10 A5b): its files fetched from the web's public,
//! read-only Storage bucket `flop-library` - the address the web's worker
//! reads, `<supabase>/storage/v1/object/public/flop-library` - and kept on
//! disk, so a chunk is downloaded once and a hand graded offline reads what
//! was fetched before.
//!
//! Nothing is bundled with the app: the library is hundreds of megabytes and
//! a user reads only the chunks of the lines and flops they played. The
//! analysis asks for files one at a time (the window's worker, through the
//! `flop_library_file` command); this module answers from the disk or the
//! bucket:
//!
//! - a **chunk** (`<set>/<tree>/<line>/<flop>.bin`) never changes once
//!   uploaded (a new solve is a new tree name): kept for good;
//! - a set's **manifest** (`<set>/<tree>/manifest.json`) grows when a set
//!   goes live: kept, and fetched again when older than
//!   [`MANIFEST_MAX_AGE`]; while the bucket cannot be reached, the copy on
//!   disk (of any age) answers;
//! - a file the bucket does not have (404) is [`FileOutcome::Absent`] - not
//!   remembered on disk: a set uploaded later is read then;
//! - a failure (no network, a timeout, a 429 or a 5xx) is
//!   [`FileOutcome::Offline`] or [`FileOutcome::Transient`]: the analysis
//!   then grades that hand without the library, exactly as the web does when
//!   a chunk cannot be fetched, and marks it to be analysed again.
//!
//! Paths are checked part by part (`chunkPath`'s rule in
//! `frontend/src/lib/solver/flopLibrary.ts`), so nothing outside the
//! library's folder can be read or written.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use url::Url;

/// A manifest on disk older than this is fetched again (when the bucket
/// can be reached).
pub const MANIFEST_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The largest file accepted (a 9-max chunk is ~0.6 MB gzip, ~2 MB raw).
pub const MAX_BYTES: usize = 32 << 20;

const TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The bucket's path under a Supabase project's URL.
pub const BUCKET_PATH: &str = "storage/v1/object/public/flop-library";

/// What a file request came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileOutcome {
    /// The file's bytes, and whether they came from the disk.
    Bytes { bytes: Vec<u8>, cached: bool },
    /// The library has no such file.
    Absent,
    /// The bucket answered 429 or a 5xx (the status).
    Transient(u16),
    /// The bucket could not be reached (no network, a timeout).
    Offline,
}

/// A library path's kind, once checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Manifest,
    Chunk,
}

/// `<set>/<tree>/manifest.json` or `<set>/<tree>/<line>/<flop>.bin`, every
/// part `[A-Za-z0-9._+-]+` and not `.` or `..`; anything else is refused.
pub fn check_path(path: &str) -> Result<FileKind, String> {
    let parts: Vec<&str> = path.split('/').collect();
    let part_ok = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    };
    if !parts.iter().all(|part| part_ok(part)) {
        return Err(format!("not a flop library path: {path:?}"));
    }
    match parts.as_slice() {
        [_, _, "manifest.json"] => Ok(FileKind::Manifest),
        [_, _, _, flop] if flop.ends_with(".bin") && flop.len() > 4 => Ok(FileKind::Chunk),
        _ => Err(format!("not a flop library path: {path:?}")),
    }
}

/// The bucket's base URL for a Supabase project (HTTPS, or HTTP to this
/// computer for a local stack).
pub fn bucket_url(supabase_url: &str) -> Result<Url, String> {
    let base = Url::parse(&format!("{}/", supabase_url.trim_end_matches('/')))
        .map_err(|error| format!("{supabase_url}: {error}"))?;
    let local = match base.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if base.scheme() != "https" && !(base.scheme() == "http" && local) {
        return Err(format!(
            "{supabase_url}: only HTTPS (or HTTP to this computer)"
        ));
    }
    base.join(&format!("{BUCKET_PATH}/"))
        .map_err(|error| error.to_string())
}

/// The library's files on disk and the bucket behind them.
#[derive(Debug, Clone)]
pub struct FlopLibraryCache {
    dir: PathBuf,
    base: Option<Url>,
    http: reqwest::Client,
}

impl FlopLibraryCache {
    /// Files under `dir`; fetched from `base` ([`bucket_url`]) when given -
    /// without it, only what is on disk answers.
    pub fn new(dir: impl Into<PathBuf>, base: Option<Url>) -> Result<Self, String> {
        // As in `auth::gotrue`: reqwest without a default crypto provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("Rail/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("http client: {error}"))?;
        Ok(Self {
            dir: dir.into(),
            base,
            http,
        })
    }

    /// The folder the files are kept in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn local(&self, path: &str) -> PathBuf {
        path.split('/')
            .fold(self.dir.clone(), |dir, part| dir.join(part))
    }

    /// One file of the library (see the module's notes).
    pub async fn file(&self, path: &str) -> Result<FileOutcome, String> {
        let kind = check_path(path)?;
        let local = self.local(path);
        let on_disk = std::fs::read(&local).ok();
        let fresh = match kind {
            FileKind::Chunk => true,
            FileKind::Manifest => std::fs::metadata(&local)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| SystemTime::now().duration_since(at).ok())
                .is_some_and(|age| age < MANIFEST_MAX_AGE),
        };
        if let Some(bytes) = &on_disk
            && fresh
        {
            return Ok(FileOutcome::Bytes {
                bytes: bytes.clone(),
                cached: true,
            });
        }
        let fetched = self.fetch(path).await;
        match fetched {
            FileOutcome::Bytes { ref bytes, .. } => {
                if let Err(error) = write_atomically(&local, bytes) {
                    log::warn!("flop library: could not keep {path}: {error}");
                }
                Ok(fetched)
            }
            // An old manifest is better than none while the bucket is away.
            FileOutcome::Offline | FileOutcome::Transient(_) => Ok(match on_disk {
                Some(bytes) => FileOutcome::Bytes {
                    bytes,
                    cached: true,
                },
                None => fetched,
            }),
            FileOutcome::Absent => Ok(FileOutcome::Absent),
        }
    }

    async fn fetch(&self, path: &str) -> FileOutcome {
        let Some(base) = &self.base else {
            return FileOutcome::Offline;
        };
        let Ok(url) = base.join(path) else {
            return FileOutcome::Absent;
        };
        let mut response = match self.http.get(url).send().await {
            Ok(response) => response,
            Err(error) => {
                log::debug!("flop library: {path}: {error}");
                return FileOutcome::Offline;
            }
        };
        let status = response.status().as_u16();
        if status == 429 || status >= 500 {
            return FileOutcome::Transient(status);
        }
        if status != 200 {
            // 400 / 404: the bucket answers 400 for an object it does not hold.
            return FileOutcome::Absent;
        }
        if response
            .content_length()
            .is_some_and(|length| length > u64::try_from(MAX_BYTES).unwrap_or(u64::MAX))
        {
            return FileOutcome::Absent;
        }
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > MAX_BYTES {
                        return FileOutcome::Absent;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) => {
                    log::debug!("flop library: {path}: {error}");
                    return FileOutcome::Offline;
                }
            }
        }
        FileOutcome::Bytes {
            bytes: body,
            cached: false,
        }
    }

    /// Whether the bucket answers now: one set's manifest fetched (and
    /// kept).
    pub async fn reachable(&self, manifest: &str) -> bool {
        if check_path(manifest) != Ok(FileKind::Manifest) {
            return false;
        }
        match self.fetch(manifest).await {
            FileOutcome::Bytes { bytes, .. } => {
                let _ = write_atomically(&self.local(manifest), &bytes);
                true
            }
            FileOutcome::Absent => true,
            FileOutcome::Offline | FileOutcome::Transient(_) => false,
        }
    }

    /// The bytes on disk, and the files.
    pub fn disk_usage(&self) -> (u64, u64) {
        fn walk(dir: &Path, sum: &mut (u64, u64)) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, sum);
                } else if let Ok(meta) = entry.metadata() {
                    sum.0 += meta.len();
                    sum.1 += 1;
                }
            }
        }
        let mut sum = (0, 0);
        walk(&self.dir, &mut sum);
        sum
    }
}

/// Write through a temporary file and a rename: a crash leaves the old file
/// or the new one, never half of one.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests;

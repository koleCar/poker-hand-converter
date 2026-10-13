//! The store's error type.

use std::fmt;
use std::path::PathBuf;

/// Everything that can go wrong in the store.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// SQLite said no.
    Sqlite(rusqlite::Error),
    /// Reading a file (or creating the store's directory) failed.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The database was written by a newer Rail: its schema version is above
    /// every migration this build knows. Nothing is changed.
    NewerSchema { found: u32, known: u32 },
    /// A batch was read from an offset that is not where the store says the
    /// file stands (`stored`): a stale or out-of-order batch. Nothing of it
    /// is written; the reader re-reads from `stored`.
    OffsetMismatch {
        path: String,
        stored: u64,
        batch_from: u64,
    },
    /// A number did not fit the column (a size beyond `i64`, say).
    OutOfRange(&'static str),
    /// zstd failed to compress or decompress a PHF.
    Compression(std::io::Error),
    /// A stored PHF is not UTF-8 once decompressed.
    Corrupt(String),
    /// The canonical JSON writer refused a hand.
    Canonical(String),
    /// The writer thread is gone (it panicked, or the store was closed).
    WriterGone,
    /// Another watched folder has this path already (`sources.path` is
    /// unique): a folder's path cannot be changed to it.
    PathTaken { path: String, id: i64 },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "SQLite: {error}"),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::NewerSchema { found, known } => write!(
                f,
                "the database has schema version {found}, this build knows up to {known}: it was written by a newer Rail"
            ),
            Self::OffsetMismatch {
                path,
                stored,
                batch_from,
            } => write!(
                f,
                "{path}: batch read from offset {batch_from}, the store has the file at {stored}"
            ),
            Self::OutOfRange(what) => write!(f, "{what} is out of range"),
            Self::Compression(error) => write!(f, "zstd: {error}"),
            Self::Corrupt(what) => write!(f, "corrupt stored data: {what}"),
            Self::Canonical(error) => write!(f, "canonical JSON: {error}"),
            Self::WriterGone => f.write_str("the store's writer thread has stopped"),
            Self::PathTaken { path, id } => {
                write!(f, "{path} is watched already (folder {id})")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            Self::Compression(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// The store's result type.
pub type Result<T, E = Error> = std::result::Result<T, E>;

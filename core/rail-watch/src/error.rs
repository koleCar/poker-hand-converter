//! The watcher's error type.

use std::fmt;
use std::path::PathBuf;

/// What can go wrong while watching and reading.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// A file or folder could not be read (permissions, a vanished volume).
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The store refused or failed.
    Store(rail_store::Error),
    /// The OS notification service failed.
    Notify(notify::Error),
    /// The watcher's threads are gone.
    Stopped,
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Store(error) => write!(f, "store: {error}"),
            Self::Notify(error) => write!(f, "file notifications: {error}"),
            Self::Stopped => f.write_str("the watcher has stopped"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Store(error) => Some(error),
            Self::Notify(error) => Some(error),
            Self::Stopped => None,
        }
    }
}

impl From<rail_store::Error> for Error {
    fn from(error: rail_store::Error) -> Self {
        Self::Store(error)
    }
}

impl From<notify::Error> for Error {
    fn from(error: notify::Error) -> Self {
        Self::Notify(error)
    }
}

/// The watcher's result type.
pub type Result<T, E = Error> = std::result::Result<T, E>;

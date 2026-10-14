#![forbid(unsafe_code)]
//! Watching hand-history folders and reading the files the rooms write,
//! incrementally, into the local store (docs/RAIL-PLAN.md R1.3; guideline
//! §3, "File watcher", "Pouzdanost"), and finding the rooms' default folders
//! on first run (R1.4, "Prvo pokretanje").
//!
//! - [`codec`]: the core's decoding, one piece of a file at a time, with
//!   the way back from text positions to byte offsets.
//! - [`reader`]: one file from its stored offset to the last complete hand,
//!   committed as one `rail_store::ImportBatch` (the completeness rule is in
//!   its docs); [`FileReader::mark_read`] for "only new hands".
//! - [`scan`]: which files of a folder are read (a room's `files.glob`, or
//!   the hand-history extensions), and network volumes.
//! - [`watcher`]: the service the app runs - OS notifications (`notify`)
//!   plus a periodic rescan, polling only for network folders, a pool of
//!   import threads (rayon, R1.6) with live files first, pause / resume,
//!   folders in the store's `sources`, backfill progress, status events.
//! - [`discover`]: the rooms' default folders from `config/sites.json` that
//!   exist here, with file counts and the newest file's date.
//!
//! Native only: never part of a wasm32 build.

pub mod codec;
pub mod discover;
pub mod error;
pub mod reader;
pub mod scan;
pub mod watcher;

pub use error::{Error, Result};
pub use reader::{
    Attempt, Committing, FileReader, FileRef, FileTrack, Finished, ImportLimits, Polled,
    ReadConfig, Started,
};
pub use watcher::{
    AddedSource, Backfill, NewSource, SourceMoved, SourceState, SourceStatus, WatchConfig,
    WatchEvent, Watcher, WatcherStatus, default_workers,
};

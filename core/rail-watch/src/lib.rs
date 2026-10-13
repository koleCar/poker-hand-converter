#![forbid(unsafe_code)]
//! Watching hand-history folders and reading the files the rooms write,
//! incrementally, into the local store (docs/RAIL-PLAN.md R1.3; guideline
//! §3, "File watcher", "Pouzdanost").
//!
//! - [`codec`]: the core's decoding, one piece of a file at a time, with
//!   the way back from text positions to byte offsets.
//! - [`reader`]: one file from its stored offset to the last complete hand,
//!   committed as one `rail_store::ImportBatch` (the completeness rule is in
//!   its docs).
//! - [`scan`]: which files of a folder are read, and network volumes.
//! - [`watcher`]: the service the app runs - OS notifications (`notify`)
//!   plus a periodic rescan, polling only for network folders, a small
//!   worker pool, pause / resume, folders in the store's `sources`, status
//!   events.
//!
//! Native only: never part of a wasm32 build.

pub mod codec;
pub mod error;
pub mod reader;
pub mod scan;
pub mod watcher;

pub use error::{Error, Result};
pub use reader::{FileReader, FileRef, FileTrack, Polled, ReadConfig};
pub use watcher::{SourceState, SourceStatus, WatchConfig, WatchEvent, Watcher, WatcherStatus};

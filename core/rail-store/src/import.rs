//! Whole-file import: read a file, run the core on it, commit one batch.
//!
//! This is R1.2's helper, not the incremental reader: it always reads the
//! whole file and sends a batch "from 0 to the end". R1.3's tail reader
//! replaces the read with "from the stored offset to the last complete
//! hand" and sends the same [`ImportBatch`] through the same writer - the
//! seam is [`ImportBatch::from_conversion`] with a [`FileState`] carrying
//! `(path, from_offset, to_offset, size, mtime)`.

use std::path::Path;

use rail_core::detect::ConvertOptions;

use crate::batch::{FileState, ImportBatch, ImportOutcome};
use crate::error::{Error, Result};
use crate::{Store, time};

/// How to import.
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// The `meta.parsedAt` stamped on every hand. `None`: now. Tests pin it,
    /// so two imports of one corpus store identical PHF.
    pub parsed_at: Option<String>,
    /// The watched folder the file belongs to.
    pub source_id: Option<i64>,
}

/// What [`import_file`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileImport {
    /// The store already has the file to its end, and the file's size and
    /// mtime have not changed: nothing read.
    Unchanged,
    /// Read and committed.
    Imported(ImportOutcome),
}

/// Import one file whole, unless the store already has all of it.
///
/// "Has all of it" means the stored offset equals the file's size and the
/// stored mtime equals the file's: a file the room appends to (bigger) or
/// rewrote (other mtime, or smaller - truncation) is read again from the
/// start, and dedupe by `hand_key` keeps the hands once.
pub fn import_file(store: &Store, path: &Path, options: &ImportOptions) -> Result<FileImport> {
    if is_unchanged(store, path)? {
        return Ok(FileImport::Unchanged);
    }
    let batch = whole_file_batch(path, options)?;
    store.import(batch).map(FileImport::Imported)
}

/// Read `path` whole and make its batch: from offset 0 to the bytes read.
pub fn whole_file_batch(path: &Path, options: &ImportOptions) -> Result<ImportBatch> {
    let io_error = |source| Error::Io {
        path: path.to_path_buf(),
        source,
    };
    // The mtime before the read: a write between the two leaves a newer
    // mtime on disk than stored, so the file is read again next time.
    let mtime_ms = std::fs::metadata(path)
        .map_err(io_error)?
        .modified()
        .ok()
        .and_then(time::system_time_ms);
    let bytes = std::fs::read(path).map_err(io_error)?;
    let size = u64::try_from(bytes.len()).map_err(|_| Error::OutOfRange("file size"))?;
    convert_bytes(
        FileState {
            path: path_key(path),
            source_id: options.source_id,
            from_offset: 0,
            to_offset: size,
            size,
            mtime_ms,
            encoding: None,
            site: None,
            last_error: None,
        },
        path,
        &bytes,
        options,
    )
}

/// Whether the store already has all of `path` (its stored offset is the
/// file's size and its stored mtime the file's): [`import_file`]'s skip
/// rule.
pub fn is_unchanged(store: &Store, path: &Path) -> Result<bool> {
    let metadata = std::fs::metadata(path).map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mtime_ms = metadata.modified().ok().and_then(time::system_time_ms);
    Ok(store
        .reader()
        .file_state(&path_key(path))?
        .is_some_and(|stored| {
            u64::try_from(stored.read_offset).ok() == Some(metadata.len())
                && stored.mtime_ms == mtime_ms
        }))
}

/// Run the core on `bytes` (the file's content from `file.from_offset` to
/// `file.to_offset`) and make the batch. `path` gives the file name the
/// core records as `sourceFilename`.
pub fn convert_bytes(
    file: FileState,
    path: &Path,
    bytes: &[u8],
    options: &ImportOptions,
) -> Result<ImportBatch> {
    let convert_options = ConvertOptions {
        source_filename: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        validate: true,
        parsed_at: options.parsed_at.clone().unwrap_or_else(time::iso_now),
        ..ConvertOptions::default()
    };
    let conversion = rail_core::convert::convert_file(bytes, &convert_options);
    ImportBatch::from_conversion(file, &conversion)
}

/// The text a path is stored under (`files.path`). Lossy only for a path
/// that is not valid Unicode, which no room writes.
pub fn path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

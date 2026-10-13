//! Debug builds only (`cfg(debug_assertions)`): run the core on a file the
//! developer picks and report counts. Proves the shell reaches `rail-core`
//! end to end; not shipped - a release build has neither these commands nor
//! the panel that calls them (`import.meta.env.DEV` on the web side). The real
//! import path is the watcher and the pipeline (R1.3, R1.6).

use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

/// What one file came to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertSummary {
    file_name: String,
    bytes: usize,
    encoding: &'static str,
    /// `empty` / `no-text` / `binary`: nothing else ran.
    problem: Option<&'static str>,
    /// The best detection, `parser` and per-mille score.
    detected: Option<(String, u32)>,
    hands: usize,
    refused: usize,
    /// Accepted hands per parser.
    by_parser: Vec<(String, u32)>,
    /// Reason codes of the first refusals.
    first_refusals: Vec<String>,
    /// No parser claimed the file (the R0.11 registry record exists).
    unrecognized: bool,
    /// `convert_any` threw (a JavaScript exception in the reference).
    error: Option<String>,
    millis: u64,
}

/// A native file picker. `None` when cancelled.
#[tauri::command]
pub async fn dev_pick_file<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    // Not on the main thread: async commands run on the async runtime.
    app.dialog()
        .file()
        .blocking_pick_file()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.display().to_string())
}

/// `rail_core::convert` on the file at `path`.
#[tauri::command]
pub async fn convert_file(path: String) -> Result<ConvertSummary, String> {
    let path = Path::new(&path);
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let started = Instant::now();
    let conversion = rail_core::convert(&bytes, &file_name);
    let millis = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let mut summary = ConvertSummary {
        file_name,
        bytes: bytes.len(),
        encoding: conversion.encoding.label(),
        problem: conversion.problem.map(|problem| problem.as_str()),
        detected: conversion
            .detected
            .first()
            .map(|top| (top.parser.clone(), top.permille)),
        hands: 0,
        refused: 0,
        by_parser: Vec::new(),
        first_refusals: Vec::new(),
        unrecognized: conversion.unrecognized.is_some(),
        error: None,
        millis,
    };
    match conversion.result {
        Some(Ok(result)) => {
            summary.hands = result.hands.len();
            summary.refused = result.failures.len();
            summary.by_parser = result.stats.by_site;
            summary.first_refusals = result
                .failures
                .iter()
                .take(5)
                .map(|failure| failure.reason.as_str().to_owned())
                .collect();
        }
        Some(Err(error)) => summary.error = Some(error.to_string()),
        None => {}
    }
    log::debug!(
        "dev convert {}: {} hands, {} refused, {} ms",
        summary.file_name,
        summary.hands,
        summary.refused,
        summary.millis
    );
    Ok(summary)
}

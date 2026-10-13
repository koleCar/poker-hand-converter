//! Refused hands (R1.6; guideline §3 "ruke u karanteni"): what the core
//! could not read, kept in the store's `quarantine` with the reason and the
//! raw text.
//!
//! - `quarantine_summary(sourceId?)`: counts per reason code, app-wide or
//!   for one folder, and how many refused hands an older parser version
//!   refused ("Try again after an update" would read them again);
//! - `quarantine_entries(sourceId?, reason?)`: the most recent refused
//!   hands, filtered by folder and / or reason (no raw text);
//! - `quarantine_raw_text(id)`: one refused hand's text, for the dialog;
//! - `retry_refused(sourceId?)`: reset and read again the files holding
//!   refusals by an older parser version (`Watcher::retry_refused`).
//!
//! The per-folder list of R1.5 is `folder_settings::folder_quarantine`.

use serde::Serialize;
use tauri::State;

use crate::commands::StoreState;
use crate::folder_settings::{QUARANTINE_LIMIT, ReasonCount, RefusedHand};
use crate::watch::WatcherState;

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

/// Refused hands an older parser version refused, and their files.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retryable {
    hands: i64,
    files: i64,
}

impl From<rail_store::StaleRefusals> for Retryable {
    fn from(stale: rail_store::StaleRefusals) -> Self {
        Self {
            hands: stale.hands,
            files: stale.files,
        }
    }
}

/// How many refused hands there are, by reason.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineSummary {
    reasons: Vec<ReasonCount>,
    total: i64,
    retryable: Retryable,
}

/// Refused hands per reason, app-wide (`source_id: None`) or of one folder.
pub fn summary(
    store: &rail_store::Store,
    source_id: Option<i64>,
) -> rail_store::Result<QuarantineSummary> {
    let reader = store.reader();
    let reasons: Vec<ReasonCount> = match source_id {
        Some(id) => reader.source_quarantine_reasons(id)?,
        None => reader.quarantine_reasons()?,
    }
    .into_iter()
    .map(|(reason, count)| ReasonCount::new(reason, count))
    .collect();
    let total = reasons.iter().map(ReasonCount::count).sum();
    let retryable = reader
        .stale_refusals(&rail_watch::Watcher::parser_versions(), source_id)?
        .into();
    Ok(QuarantineSummary {
        reasons,
        total,
        retryable,
    })
}

#[tauri::command]
pub async fn quarantine_summary(
    store: State<'_, StoreState>,
    source_id: Option<i64>,
) -> Result<QuarantineSummary, String> {
    summary(open(&store)?, source_id).map_err(|error| error.to_string())
}

/// A page of refused hands.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineList {
    entries: Vec<RefusedHand>,
    /// More match than are listed.
    truncated: bool,
}

#[tauri::command]
pub async fn quarantine_entries(
    store: State<'_, StoreState>,
    source_id: Option<i64>,
    reason: Option<String>,
) -> Result<QuarantineList, String> {
    let store = open(&store)?;
    let entries: Vec<RefusedHand> = store
        .reader()
        .quarantine_filtered(source_id, reason.as_deref(), QUARANTINE_LIMIT + 1)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(RefusedHand::from)
        .collect();
    let truncated = entries.len() > usize::try_from(QUARANTINE_LIMIT).unwrap_or(usize::MAX);
    Ok(QuarantineList {
        entries: entries
            .into_iter()
            .take(usize::try_from(QUARANTINE_LIMIT).unwrap_or(usize::MAX))
            .collect(),
        truncated,
    })
}

/// One refused hand's raw text (the chunk the core could not read), or
/// `None` when it is gone (read again meanwhile).
#[tauri::command]
pub async fn quarantine_raw_text(
    store: State<'_, StoreState>,
    id: i64,
) -> Result<Option<String>, String> {
    open(&store)?
        .reader()
        .quarantine_raw_text(id)
        .map_err(|error| error.to_string())
}

/// "Try again after an update": read again the files (of one folder, or of
/// all) whose refused hands an older parser version refused. Returns how
/// many files are read again.
#[tauri::command]
pub async fn retry_refused(
    watcher: State<'_, WatcherState>,
    source_id: Option<i64>,
) -> Result<u32, String> {
    let files = watcher
        .with(|w| w.retry_refused(source_id))?
        .map_err(|error| error.to_string())?;
    watcher.mark_dirty();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The summary of an empty store, and of one refused hand.
    #[test]
    fn summary_counts_reasons_and_what_can_be_retried() {
        let dir = std::env::temp_dir().join(format!("rail-app-quarantine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = StoreState::open(dir.join(rail_store::FILE_NAME));
        let store = state.store.as_ref().expect("open");
        let empty = summary(store, None).expect("summary");
        assert_eq!((empty.total, empty.retryable.hands), (0, 0));

        let refused = dir.join("refused.txt");
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/samples/888poker/13-invalid-hand-truncated-flop.txt"),
            &refused,
        )
        .expect("copy");
        let id = store
            .add_source(&dir.display().to_string(), true, None)
            .expect("folder");
        rail_store::import_file(
            store,
            &refused,
            &rail_store::ImportOptions {
                parsed_at: None,
                source_id: Some(id),
            },
        )
        .expect("import");
        let one = summary(store, Some(id)).expect("summary");
        assert_eq!(one.total, 1);
        assert_eq!(one.reasons.len(), 1);
        assert_eq!(one.retryable.hands, 0, "refused by today's parser");
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

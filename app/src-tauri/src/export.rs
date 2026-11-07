//! "Export to .txt" from a hand list's right-click menu: the chosen hands as
//! one hand-history file, the converter's own per-file download
//! (`to_standard_text_file`: standard text, a blank line between hands) -
//! the same text Rail reads back on import or the web takes as an upload.
//!
//! The system's save dialog picks the file (the name the window suggests);
//! the hands are read from the store in the order given, and a hand no
//! longer in the store is left out and counted.

use rail_core::phf::PhfHand;
use rail_core::phf::serialize::to_standard_text_file;
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::StoreState;

/// Never more hands in one file than this (a selection is what is loaded in
/// a list, so this is a guard, not a limit a reader meets).
const MAX_HANDS: usize = 100_000;

/// What was written.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDto {
    /// The file, as the system names it.
    pub path: String,
    /// Hands in it.
    pub hands: usize,
    /// Asked for but not in the store (or unreadable): left out.
    pub missing: usize,
}

/// The suggested name, made safe: a plain file name ending in `.txt`.
fn file_name(suggested: &str) -> String {
    // The last path part, by either separator: the same on every system
    // (`Path` would read "a:b" as a drive on Windows).
    let name: String = suggested
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':'))
        .take(120)
        .collect();
    let name = name.trim();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        "Rail hands.txt".to_owned()
    } else if name.to_ascii_lowercase().ends_with(".txt") {
        name.to_owned()
    } else {
        format!("{name}.txt")
    }
}

/// The hands' PHF (as the store keeps it; `None`: not there) as one file's
/// text, and how many were left out.
fn export_text(phf: impl IntoIterator<Item = Option<String>>) -> (String, usize, usize) {
    let mut hands: Vec<PhfHand> = Vec::new();
    let mut missing = 0;
    for json in phf {
        match json.and_then(|json| serde_json::from_str::<PhfHand>(&json).ok()) {
            Some(hand) => hands.push(hand),
            None => missing += 1,
        }
    }
    let mut text = to_standard_text_file(&hands);
    if !text.is_empty() {
        text.push('\n');
    }
    (text, hands.len(), missing)
}

/// Save the hands to a file the reader picks. `None`: the dialog was
/// cancelled.
#[tauri::command]
pub async fn hands_export<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StoreState>,
    hand_keys: Vec<String>,
    file_name: String,
) -> Result<Option<ExportDto>, String> {
    if hand_keys.is_empty() {
        return Err("no hands to export".to_owned());
    }
    if hand_keys.len() > MAX_HANDS {
        return Err(format!("at most {MAX_HANDS} hands at a time"));
    }
    let reader = store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())?
        .reader();
    // Not on the main thread: async commands run on the async runtime.
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Hand history", &["txt"])
        .set_file_name(self::file_name(&file_name))
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    let (text, hands, missing) = export_text(
        hand_keys
            .iter()
            .map(|key| reader.hand_phf(key).ok().flatten()),
    );
    if hands == 0 {
        return Err("none of these hands is in the store any more".to_owned());
    }
    std::fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(Some(ExportDto {
        path: path.display().to_string(),
        hands,
        missing,
    }))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rail_core::convert::convert;

    use super::{export_text, file_name};

    #[test]
    fn the_suggested_name_is_a_plain_txt_file() {
        assert_eq!(
            file_name("Rail hands 2026-11-07.txt"),
            "Rail hands 2026-11-07.txt"
        );
        assert_eq!(file_name("hands"), "hands.txt");
        assert_eq!(file_name("../../etc/passwd"), "passwd.txt");
        assert_eq!(file_name("  "), "Rail hands.txt");
        assert_eq!(file_name("a:b"), "ab.txt");
        assert_eq!(file_name("C:\\Users\\x\\hands.txt"), "hands.txt");
        assert_eq!(file_name(".."), "Rail hands.txt");
    }

    /// A room's file through the converter, out as one exported file, and
    /// read again: the same hands, in the same order; a missing one is
    /// counted and left out.
    #[test]
    fn exported_hands_read_back_as_the_same_hands() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../fixtures/samples/pokerstars/27-cash-multi-hand-file-blank-line-separator.txt",
        );
        let bytes = std::fs::read(&file).expect("fixture");
        let first = convert(&bytes, "in.txt")
            .result
            .expect("read")
            .expect("converted");
        assert!(first.hands.len() > 1, "a file of several hands");
        let json: Vec<Option<String>> = first
            .hands
            .iter()
            .map(|converted| Some(serde_json::to_string(&converted.hand).expect("json")))
            .chain(std::iter::once(None))
            .collect();

        let (text, hands, missing) = export_text(json);
        assert_eq!(hands, first.hands.len());
        assert_eq!(missing, 1);
        assert!(text.ends_with('\n'));

        let again = convert(text.as_bytes(), "out.txt")
            .result
            .expect("read")
            .expect("converted");
        assert!(again.failures.is_empty(), "{:?}", again.failures);
        let ids = |result: &rail_core::convert::ConversionResult| -> Vec<String> {
            result
                .hands
                .iter()
                .map(|converted| converted.hand.meta.hand_id.clone())
                .collect()
        };
        assert_eq!(ids(&again), ids(&first));
    }
}

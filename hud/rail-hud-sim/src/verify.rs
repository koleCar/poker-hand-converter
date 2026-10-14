//! Read back what a run wrote, file by file, with `rail_core::convert` -
//! the converter's own path, detection included - and check it.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use rail_core::phf::GameFormat;

use crate::room::Room;

/// What a folder holds.
#[derive(Debug, Default)]
pub struct Report {
    pub files: usize,
    pub hands: usize,
    /// Table name -> hands.
    pub tables: BTreeMap<String, usize>,
}

/// Every `.txt` file in `dir`: detected as `room`'s parser (first in the
/// ranking), every hand converts (no refusal), hand ids unique, and in a
/// cash table's file every hand carries the same table name.
pub fn verify(dir: &Path, room: &Room) -> Result<Report, String> {
    let mut report = Report::default();
    let mut ids = HashSet::new();
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "txt"))
        .collect();
    paths.sort();
    for path in paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = std::fs::read(&path).map_err(|e| format!("{name}: {e}"))?;
        let conversion = rail_core::convert(&bytes, &name);
        let detected = conversion.detected.first().map(|c| c.parser.as_str());
        if detected != Some(room.parser.as_str()) {
            return Err(format!(
                "{name}: detected as {detected:?}, expected {}",
                room.parser
            ));
        }
        let result = conversion
            .result
            .ok_or_else(|| format!("{name}: not converted ({:?})", conversion.problem))?
            .map_err(|e| format!("{name}: {e:?}"))?;
        if let Some(failure) = result.failures.first() {
            return Err(format!(
                "{name}: {} refused hand(s), first: {}",
                result.failures.len(),
                failure.message
            ));
        }
        if result.hands.is_empty() {
            return Err(format!("{name}: no hands"));
        }
        let mut file_tables = HashSet::new();
        for converted in &result.hands {
            let hand = &converted.hand;
            if !ids.insert(hand.meta.hand_id.clone()) {
                return Err(format!("{name}: hand id {} twice", hand.meta.hand_id));
            }
            let table = hand.table.name.clone().unwrap_or_default();
            if hand.game.format == GameFormat::Cash {
                file_tables.insert(table.clone());
            }
            *report.tables.entry(table).or_default() += 1;
        }
        if file_tables.len() > 1 {
            return Err(format!(
                "{name}: hands of {} tables in one cash file",
                file_tables.len()
            ));
        }
        report.files += 1;
        report.hands += result.hands.len();
    }
    Ok(report)
}

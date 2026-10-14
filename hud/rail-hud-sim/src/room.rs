//! The rooms the simulator imitates: `rooms.json`, beside this crate's
//! `Cargo.toml`, compiled in. Each room says how its tables are titled, how
//! its files are named and encoded, and which of that is sourced and which
//! invented (`sources`).

use std::collections::BTreeMap;
use std::fmt::Write as _;

use regex::Regex;
use serde::Deserialize;

/// `rooms.json`, as compiled in.
pub const ROOMS_JSON: &str = include_str!("../rooms.json");

#[derive(Debug, Deserialize)]
struct RoomsFile {
    rooms: Vec<Room>,
}

/// One room.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Room {
    /// The simulator's name for it (`--room`).
    pub id: String,
    pub name: String,
    /// The `rail_core` parser that must read what the simulator writes.
    pub parser: String,
    /// Folder under `fixtures/samples/`.
    pub corpus: String,
    /// A hand is a template only if its first line matches this.
    pub header: String,
    /// Table sizes, most common first.
    pub sizes: Vec<u32>,
    pub cash: Naming,
    pub tournament: Option<Naming>,
    /// `variant-limit` -> the room's name of the game.
    pub games: BTreeMap<String, String>,
    /// `variant-limit` -> the game as the file name spells it.
    pub game_files: BTreeMap<String, String>,
    /// Where the hero's `Dealt to` line goes (for corpus hands without a
    /// hero).
    pub dealt: crate::rewrite::DealtRule,
    pub encoding: FileEncoding,
    pub line_end: LineEnd,
    /// Line ends after a hand's last line (3 = the line's own and two blank
    /// lines).
    pub separator: u32,
    /// Default client size of a table window (logical pixels).
    pub window: [u32; 2],
    /// Where each choice comes from.
    pub sources: BTreeMap<String, String>,
}

/// How a table of one kind is titled and filed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Naming {
    pub title: String,
    pub file: String,
    /// Tournaments: how the table name in the hands is made from the
    /// title's parts (`{tid} {tno}`); cash titles carry `{table}` itself.
    #[serde(default)]
    pub table_from_title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum FileEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "utf-16le")]
    Utf16Le,
}

impl FileEncoding {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "utf-8" | "utf8" => Some(Self::Utf8),
            "utf-8-bom" | "utf8bom" => Some(Self::Utf8Bom),
            "utf-16le" | "utf16le" => Some(Self::Utf16Le),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnd {
    Lf,
    Crlf,
}

/// Every room in `rooms.json`.
pub fn rooms() -> Vec<Room> {
    serde_json::from_str::<RoomsFile>(ROOMS_JSON)
        .map(|file| file.rooms)
        .unwrap_or_default()
}

/// One room by id.
pub fn room(id: &str) -> Option<Room> {
    rooms().into_iter().find(|room| room.id == id)
}

/// Values for a title or file-name template.
#[derive(Debug, Clone, Default)]
pub struct Fields {
    pub values: BTreeMap<&'static str, String>,
}

impl Fields {
    pub fn set(&mut self, key: &'static str, value: impl Into<String>) -> &mut Self {
        self.values.insert(key, value.into());
        self
    }
}

/// `{name}` placeholders filled from `fields`; an unknown one stays as it
/// is.
pub fn fill(template: &str, fields: &Fields) -> String {
    let mut out = String::with_capacity(template.len() + 32);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let key = &after[..close];
                match fields.values.get(key) {
                    Some(value) => out.push_str(value),
                    None => {
                        let _ = write!(out, "{{{key}}}");
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The test-only title regex of a naming (docs/RAIL-PLAN.md R3.1): the
/// title template with its literal text escaped, `{table}`, `{tid}`, `{tno}`
/// as named groups and every other field as a lazy wildcard; anchored. It
/// matches the simulator's titles and nothing claims it matches a real
/// client's - `sites.json` `tables.title` is the room's own (R3.3).
pub fn title_regex(naming: &Naming) -> String {
    let mut out = String::from("^");
    let mut rest = naming.title.as_str();
    while let Some(open) = rest.find('{') {
        out.push_str(&regex::escape(&rest[..open]));
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            break;
        };
        out.push_str(match &after[..close] {
            "table" => "(?P<table>.+)",
            "tid" => "(?P<tid>\\d+)",
            "tno" => "(?P<tno>\\d+)",
            _ => ".+?",
        });
        rest = &after[close + 1..];
    }
    out.push_str(&regex::escape(rest));
    out.push('$');
    out
}

/// The table name the hands carry, read back from a window title with
/// [`title_regex`]; `None` when the title does not match.
pub fn table_from_title(naming: &Naming, title: &str) -> Option<String> {
    let re = Regex::new(&title_regex(naming)).ok()?;
    let caps = re.captures(title)?;
    if let Some(table) = caps.name("table") {
        return Some(table.as_str().to_owned());
    }
    let template = naming.table_from_title.as_deref()?;
    let mut fields = Fields::default();
    if let Some(tid) = caps.name("tid") {
        fields.set("tid", tid.as_str());
    }
    if let Some(tno) = caps.name("tno") {
        fields.set("tno", tno.as_str());
    }
    Some(fill(template, &fields))
}

/// A table name made safe for a file name on Windows and macOS.
pub fn file_safe(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_json_reads_and_says_where_each_choice_comes_from() {
        let rooms = rooms();
        let ids: Vec<&str> = rooms.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["pokerstars", "winamax", "acr"]);
        for room in &rooms {
            for key in [
                "header",
                "sizes",
                "tableNames",
                "dealt",
                "title",
                "file",
                "encoding",
                "separator",
                "window",
            ] {
                let source = room.sources.get(key).map(String::as_str).unwrap_or("");
                assert!(
                    ["SOURCED", "PARTLY SOURCED", "INVENTED"]
                        .iter()
                        .any(|tag| source.starts_with(tag)),
                    "{}: sources.{key} must start with SOURCED, PARTLY SOURCED or INVENTED",
                    room.id
                );
            }
            assert!(Regex::new(&room.header).is_ok());
            assert!(!room.sizes.is_empty());
            for naming in std::iter::once(&room.cash).chain(room.tournament.as_ref()) {
                assert!(Regex::new(&title_regex(naming)).is_ok());
            }
        }
    }

    #[test]
    fn fill_and_read_back() {
        let naming = Naming {
            title: "{table} - {stakes} {currency} - {game}".into(),
            file: String::new(),
            table_from_title: None,
        };
        let mut fields = Fields::default();
        fields
            .set("table", "(PRR) Cyclops - 6")
            .set("stakes", "$0.05/$0.10")
            .set("currency", "USD")
            .set("game", "No Limit Hold'em");
        let title = fill(&naming.title, &fields);
        assert_eq!(
            title,
            "(PRR) Cyclops - 6 - $0.05/$0.10 USD - No Limit Hold'em"
        );
        assert_eq!(
            table_from_title(&naming, &title).as_deref(),
            Some("(PRR) Cyclops - 6")
        );
        assert_eq!(fill("{missing} x", &fields), "{missing} x");

        let tour = Naming {
            title: "Tournament {tid} Table {tno} - {game}".into(),
            file: String::new(),
            table_from_title: Some("{tid} {tno}".into()),
        };
        assert_eq!(
            table_from_title(&tour, "Tournament 123 Table 7 - X").as_deref(),
            Some("123 7")
        );
        assert_eq!(table_from_title(&tour, "Some other window"), None);
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_safe("a/b: c?."), "a_b_ c_");
        assert_eq!(file_safe("Isildur's PLO 50"), "Isildur's PLO 50");
    }
}

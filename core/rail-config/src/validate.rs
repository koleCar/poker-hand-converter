//! The checks a JSON Schema cannot express, or that the app must make on a
//! downloaded file without a schema engine: unique ids, parsers that exist in
//! this build, regular expressions that compile, dated and sourced claims.

use std::collections::HashSet;
use std::fmt;

use crate::VERSION;
use crate::model::{Config, PathEntry, Site, SiteKind};

/// One thing wrong with a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// The entry's id, when the problem is in one.
    pub site: Option<String>,
    pub message: String,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.site {
            Some(site) => write!(f, "{site}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

/// Every problem in `config`, given the parser ids this build has (pass
/// `rail_core::parsers::REGISTRATION_ORDER`). Empty when valid. Does not
/// require every parser to have an entry - see [`check_coverage`].
pub fn validate(config: &Config, parsers: &[&str]) -> Vec<Problem> {
    let mut problems = Vec::new();
    if config.version != VERSION {
        problems.push(Problem {
            site: None,
            message: format!("version {} is not {VERSION}", config.version),
        });
    }
    if config.sites.is_empty() {
        problems.push(Problem {
            site: None,
            message: "no sites".to_owned(),
        });
    }
    let mut seen = HashSet::new();
    for site in &config.sites {
        if !seen.insert(site.id.as_str()) {
            problems.push(Problem {
                site: Some(site.id.clone()),
                message: "duplicate id".to_owned(),
            });
        }
        let mut report = |message: String| {
            problems.push(Problem {
                site: Some(site.id.clone()),
                message,
            });
        };
        check_site(site, parsers, &mut report);
    }
    problems
}

/// The CI rule of R0.12, one direction: every parser this build has is named
/// by at least one entry. (The other direction - an entry naming a parser
/// that does not exist - is in [`validate`].)
pub fn check_coverage(config: &Config, parsers: &[&str]) -> Vec<Problem> {
    parsers
        .iter()
        .filter(|parser| config.sites_for_parser(parser).next().is_none())
        .map(|parser| Problem {
            site: None,
            message: format!("parser {parser:?} has no entry in sites.json"),
        })
        .collect()
}

fn check_site(site: &Site, parsers: &[&str], report: &mut impl FnMut(String)) {
    if !is_id(&site.id) {
        report(format!("id {:?} is not [a-z0-9][a-z0-9-]*", site.id));
    }
    if site.name.trim().is_empty() {
        report("empty name".to_owned());
    }
    if let Some(parser) = &site.parser {
        if !parsers.contains(&parser.as_str()) {
            report(format!("parser {parser:?} does not exist"));
        }
        if site.anonymisation.is_none() {
            report("a parsed site needs an anonymisation".to_owned());
        }
    }
    if site.kind != SiteKind::Room {
        if site.hud.allowed == Some(true) {
            report("only a room can allow a HUD; split the network first".to_owned());
        }
        if !site.tables.is_unknown() {
            report("only a room has table windows".to_owned());
        }
    }
    check_hud(site, report);
    for (os, entries) in [
        ("windows", &site.paths.windows),
        ("macos", &site.paths.macos),
    ] {
        for entry in entries {
            check_path(os, entry, report);
        }
    }
    if let Some(glob) = &site.files.glob
        && (glob.is_empty() || glob.contains(['/', '\\']))
    {
        report(format!("files.glob {glob:?} must be a file-name pattern"));
    }
    if site.files.source.trim().is_empty() {
        report("files.source is empty".to_owned());
    }
    check_tables(site, report);
}

fn check_hud(site: &Site, report: &mut impl FnMut(String)) {
    let hud = &site.hud;
    if let Some(date) = &hud.checked_at
        && !is_date(date)
    {
        report(format!("hud.checkedAt {date:?} is not YYYY-MM-DD"));
    }
    if hud.allowed == Some(true) {
        if !hud
            .source
            .as_deref()
            .is_some_and(|source| source.starts_with("https://") && source.len() > 8)
        {
            report("hud.allowed is true without an https source".to_owned());
        }
        if hud.checked_at.is_none() {
            report("hud.allowed is true without checkedAt".to_owned());
        }
    }
}

fn check_path(os: &str, entry: &PathEntry, report: &mut impl FnMut(String)) {
    let path = entry.path.as_str();
    let rooted = match os {
        "windows" => is_windows_root(path),
        _ => path.starts_with("~/") || path.starts_with('/'),
    };
    if !rooted {
        report(format!("{os} path {path:?} does not start at a known root"));
    }
    if path.contains("**") {
        report(format!("{os} path {path:?}: `**` is not supported"));
    }
    if entry.source.trim().is_empty() {
        report(format!("{os} path {path:?} has no source"));
    }
    match &entry.checked_at {
        Some(date) if !is_date(date) => {
            report(format!(
                "{os} path {path:?}: checkedAt {date:?} is not YYYY-MM-DD"
            ));
        }
        None if entry.verified => {
            report(format!("{os} path {path:?} is verified without checkedAt"));
        }
        _ => {}
    }
}

fn check_tables(site: &Site, report: &mut impl FnMut(String)) {
    let tables = &site.tables;
    for (os, names) in [
        ("windows", &tables.process.windows),
        ("macos", &tables.process.macos),
    ] {
        if let Some(names) = names
            && (names.is_empty() || names.iter().any(|name| name.trim().is_empty()))
        {
            report(format!("tables.process.{os} has an empty name or none"));
        }
    }
    if let Some(title) = &tables.title {
        match regex::Regex::new(title) {
            Ok(re) => {
                if !re.capture_names().any(|name| name == Some("table")) {
                    report("tables.title has no named group `table`".to_owned());
                }
            }
            Err(error) => report(format!("tables.title does not compile: {error}")),
        }
    }
    if let Some(layouts) = &tables.seat_layouts {
        for (size, layout) in layouts {
            if !size
                .parse::<u8>()
                .is_ok_and(|n| (2..=10).contains(&n) && n.to_string() == *size)
            {
                report(format!(
                    "tables.seatLayouts: {size:?} is not a table size 2-10"
                ));
            }
            if layout.trim().is_empty() {
                report(format!("tables.seatLayouts.{size} is empty"));
            }
        }
    }
}

fn is_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `%NAME%\...` or `X:\...`.
fn is_windows_root(path: &str) -> bool {
    if let Some(rest) = path.strip_prefix('%') {
        return rest.split_once('%').is_some_and(|(name, tail)| {
            !name.is_empty()
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !name.as_bytes()[0].is_ascii_digit()
                && tail.starts_with('\\')
        });
    }
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

/// A real calendar date written `YYYY-MM-DD`.
pub(crate) fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = text.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (number(0..4), number(5..7), number(8..10)) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        for good in ["2026-10-13", "2024-02-29", "2000-02-29", "1999-12-31"] {
            assert!(is_date(good), "{good}");
        }
        for bad in [
            "2026-13-01",
            "2026-00-10",
            "2026-02-29",
            "1900-02-29",
            "2026-04-31",
            "2026-1-01",
            "2026/10/13",
            "2026-10-13T00:00:00Z",
            "+026-10-13",
            "",
        ] {
            assert!(!is_date(bad), "{bad}");
        }
    }

    #[test]
    fn windows_roots() {
        for good in [
            r"%LOCALAPPDATA%\PokerStars",
            r"%APP_DATA2%\x",
            r"C:\Poker",
            r"d:\x",
        ] {
            assert!(is_windows_root(good), "{good}");
        }
        for bad in [
            r"%%\x",
            r"%1A%\x",
            r"%LOCALAPPDATA%/x",
            r"%LOCALAPPDATA",
            r"PokerStars\x",
            "C:/x",
            r"\\server\share",
            "~/x",
        ] {
            assert!(!is_windows_root(bad), "{bad}");
        }
    }

    #[test]
    fn ids() {
        assert!(is_id("wpt-global"));
        assert!(is_id("888poker"));
        for bad in ["", "-x", "PokerStars", "a_b", "a b"] {
            assert!(!is_id(bad), "{bad:?}");
        }
    }
}

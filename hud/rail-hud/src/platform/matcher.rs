//! Which windows are tables, and of which table (docs/RAIL-PLAN.md R3.3):
//! a room's processes and title pattern, the table name read from the
//! title, and the privacy redaction of the `--list-windows` diagnostic.
//! Plain Rust, the same on every system; the backends feed it what the
//! window system says.
//!
//! **Table identity.** A window is (room, table name, seats). The room is
//! the matcher's; the table name is the title's `table` group, normalised
//! by [`table_key`] - and it must be exactly the name the room's hands
//! carry (`Table 'Hygiea IV 40-100 bb'`): the hand-to-window match is
//! equality of the two keys, never a prefix or a substring, so `Table 1`
//! is not `Table 11` and `Hygiea IV` is not `Hygiea IV 40-100 bb`. The
//! seats come from an optional `seats` group (`6-max`) or, failing that,
//! from the table's last hand (the engine asks the store).

#![forbid(unsafe_code)]

use regex::Regex;

/// The table simulator's process (R3.1): `rail-hud-sim`, `rail-hud-sim.exe`
/// on Windows (process names are compared without `.exe`).
pub const SIM_PROCESS: &str = "rail-hud-sim";

/// What a matching title says.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TitleMatch {
    /// The `table` group, through [`table_key`]; `None` when the pattern
    /// has no such group or it took no part in the match.
    pub table: Option<String>,
    /// The `seats` group when it is a table size (2 - 10).
    pub seats: Option<u32>,
}

/// How a room's tables are recognised: its processes and a title pattern
/// with a `table` group (`sites.json` `tables`, R3.3 / R3.11), or a
/// test-only entry for the simulator ([`TableMatcher::simulator`]).
#[derive(Debug, Clone)]
pub struct TableMatcher {
    pub site: String,
    /// Executable names, compared without case and without `.exe`.
    pub processes: Vec<String>,
    pub title: Regex,
}

impl TableMatcher {
    /// A test-only room entry (R3.1 / R3.2 notes): the simulator's windows,
    /// recognised by its own title regex (`rail-hud-sim --title-regex`),
    /// posing as `site`. Its process is the simulator's and nothing else,
    /// so it can never take a real client's window; compliance mode decides
    /// on `site` as for a real one. Never in `sites.json`.
    pub fn simulator(site: impl Into<String>, title: Regex) -> Self {
        Self {
            site: site.into(),
            processes: vec![SIM_PROCESS.to_owned()],
            title,
        }
    }

    /// Whether `process` (an executable's file name) is one of this room's.
    pub fn takes_process(&self, process: &str) -> bool {
        self.processes.iter().any(|p| same_process(p, process))
    }

    /// `Some` when a window of `process` titled `title` is one of this
    /// room's tables.
    pub fn matches(&self, process: &str, title: &str) -> Option<TitleMatch> {
        if !self.takes_process(process) {
            return None;
        }
        read_title(&self.title, title)
    }
}

/// What `pattern` reads from `title` (`None`: it does not match).
pub fn read_title(pattern: &Regex, title: &str) -> Option<TitleMatch> {
    let caps = pattern.captures(title)?;
    Some(TitleMatch {
        table: caps
            .name("table")
            .map(|m| table_key(m.as_str()))
            .filter(|t| !t.is_empty()),
        seats: caps
            .name("seats")
            .and_then(|m| m.as_str().trim().parse::<u32>().ok())
            .filter(|n| (2..=10).contains(n)),
    })
}

/// Two executable names are the same program: equal without case and
/// without a trailing `.exe`.
pub fn same_process(a: &str, b: &str) -> bool {
    fn stem(name: &str) -> &str {
        let n = name.len();
        if n > 4 && name.is_char_boundary(n - 4) && name[n - 4..].eq_ignore_ascii_case(".exe") {
            &name[..n - 4]
        } else {
            name
        }
    }
    stem(a.trim()).eq_ignore_ascii_case(stem(b.trim()))
}

/// A table name as the HUD compares it: trimmed, every run of white space
/// one space. Case and everything else are kept: two tables whose names
/// differ only there are two tables.
pub fn table_key(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What replaces the user's own names in a redacted title.
pub const YOU: &str = "<you>";

/// The `--list-windows` redaction (R3.3): window titles can name the
/// player - PokerStars-style "Logged in as <name>", the player's own name
/// at a seat or in a tab. Before a title is printed, everything after
/// "logged in as" (any case, any spacing) and every one of the user's
/// screen names (any case, anywhere in the title) become [`YOU`]. Names
/// shorter than two characters are not used (they would eat the title).
/// The owner still reads the output before sharing it.
#[derive(Debug, Clone)]
pub struct Redactor {
    logged_in: Regex,
    names: Option<Regex>,
    count: usize,
}

impl Redactor {
    pub fn new(names: &[String]) -> Self {
        let mut names: Vec<&str> = names
            .iter()
            .map(|n| n.trim())
            .filter(|n| n.chars().count() >= 2)
            .collect();
        // Longest first, so a name that contains another goes whole.
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));
        names.dedup();
        let count = names.len();
        let names = (!names.is_empty())
            .then(|| {
                let alternatives: Vec<String> = names.iter().map(|n| regex::escape(n)).collect();
                Regex::new(&format!("(?i)(?:{})", alternatives.join("|"))).ok()
            })
            .flatten();
        Self {
            logged_in: Regex::new(r"(?i)(logged\s+in\s+as)\b.*$").expect("a valid pattern"),
            names,
            count,
        }
    }

    /// How many names it replaces.
    pub fn names(&self) -> usize {
        self.count
    }

    pub fn redact(&self, title: &str) -> String {
        let title = self.logged_in.replace(title, |caps: &regex::Captures<'_>| {
            format!("{} {YOU}", &caps[1])
        });
        match &self.names {
            Some(names) => names.replace_all(&title, YOU).into_owned(),
            None => title.into_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regex(pattern: &str) -> Regex {
        Regex::new(pattern).expect("regex")
    }

    #[test]
    fn a_matcher_needs_the_process_and_the_title() {
        let matcher = TableMatcher {
            site: "pokerstars".into(),
            processes: vec!["PokerStars.exe".into()],
            title: regex(r"^(?P<table>.+?) - \$.* (?P<seats>\d+)-max"),
        };
        assert_eq!(
            matcher.matches("pokerstars.EXE", "Hygiea IV - $0.05/$0.10 - 6-max"),
            Some(TitleMatch {
                table: Some("Hygiea IV".into()),
                seats: Some(6)
            })
        );
        // The macOS executable has no `.exe`; the same program.
        assert!(
            matcher
                .matches("PokerStars", "Hygiea IV - $0.05 9-max")
                .is_some()
        );
        assert_eq!(
            matcher.matches("other.exe", "Hygiea IV - $0.05 6-max"),
            None
        );
        assert_eq!(matcher.matches("PokerStars.exe", "Lobby"), None);
        assert_eq!(
            matcher.matches("PokerStarsUpdate.exe", "Hygiea IV - $1 6-max"),
            None
        );
        // 12 seats is no table size: the seats stay unknown.
        assert_eq!(
            matcher
                .matches("PokerStars.exe", "X - $1 12-max")
                .and_then(|m| m.seats),
            None
        );
    }

    #[test]
    fn processes_compare_without_case_and_exe() {
        assert!(same_process("rail-hud-sim", "rail-hud-sim.exe"));
        assert!(same_process("RAIL-HUD-SIM.EXE", "rail-hud-sim"));
        assert!(same_process("Winamax.exe", "winamax.exe"));
        assert!(!same_process("rail-hud-sim", "rail-hud-sim2.exe"));
        assert!(!same_process("rail-hud-sim", "rail-hud.exe"));
        assert!(!same_process(".exe", "x"));
    }

    /// The simulator's entry takes its windows only, never a client's.
    #[test]
    fn the_simulator_entry_takes_only_the_simulator() {
        let matcher = TableMatcher::simulator("pokerstars", regex("^(?P<table>.+?) - .*$"));
        assert!(
            matcher
                .matches("rail-hud-sim.exe", "Hygiea IV - x")
                .is_some()
        );
        assert!(matcher.matches("rail-hud-sim", "Hygiea IV - x").is_some());
        assert!(matcher.matches("PokerStars.exe", "Hygiea IV - x").is_none());
        assert_eq!(matcher.site, "pokerstars");
    }

    /// Identity is the exact name, white space aside: similar names are
    /// different tables.
    #[test]
    fn table_names_are_compared_whole() {
        assert_eq!(
            table_key("  Hygiea   IV\t40-100 bb "),
            "Hygiea IV 40-100 bb"
        );
        assert_ne!(table_key("Table 1"), table_key("Table 11"));
        assert_ne!(table_key("Hygiea IV"), table_key("Hygiea IV 40-100 bb"));
        assert_ne!(table_key("Miramar"), table_key("miramar"));
        let pattern = regex(r"^(?P<table>.*?) - ");
        assert_eq!(read_title(&pattern, " - x").map(|m| m.table), Some(None));
        assert_eq!(
            read_title(&pattern, "Florence  03 - x").and_then(|m| m.table),
            Some("Florence 03".into())
        );
        // A tournament title without the name: matched, no table.
        let tournament = regex(r"^Tournament (?P<tid>\d+) Table (?P<tno>\d+) - ");
        assert_eq!(
            read_title(&tournament, "Tournament 12 Table 3 - x"),
            Some(TitleMatch::default())
        );
    }

    #[test]
    fn redaction() {
        let none = Redactor::new(&[]);
        assert_eq!(
            none.redact("Hygiea IV - $0.05/$0.10 USD - Hold'em No Limit - Logged In as SimHero"),
            "Hygiea IV - $0.05/$0.10 USD - Hold'em No Limit - Logged In as <you>"
        );
        assert_eq!(
            none.redact("x - logged  in AS  a b c"),
            "x - logged  in AS <you>"
        );
        assert_eq!(none.redact("Lobby"), "Lobby");
        let mine = Redactor::new(&["SimHero".into(), "Sim".into(), " ".into(), "x".into()]);
        assert_eq!(mine.names(), 2);
        assert_eq!(
            mine.redact("Table simhero (SIMHERO) - Sim's seat"),
            "Table <you> (<you>) - <you>'s seat"
        );
        // Names with regex characters are literal.
        let odd = Redactor::new(&["a.b+(c)".into()]);
        assert_eq!(odd.redact("axb a.b+(c)"), "axb <you>");
        // Logged in, then names.
        assert_eq!(
            mine.redact("SimHero at T - Logged in as SimHero"),
            "<you> at T - Logged in as <you>"
        );
    }
}

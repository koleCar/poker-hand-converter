//! `rail-hud --list-windows` (R3.3): the diagnostic that captures what real
//! poker clients' table windows look like, so that a room's `sites.json`
//! `tables` block (processes, title regex) can be written from what was
//! seen. The owner runs it on a Windows PC with the clients open
//! (`docs/research/CAPTURING-TABLES.md`) and pastes the result back.
//!
//! For every visible top-level window with a title (optionally only some
//! processes'): process, class, title **redacted** ([`Redactor`]: anything
//! after "Logged in as" and the user's own screen names - `--you`, and the
//! hero names of the app's store when it is found - become `<you>`), the
//! client area in physical pixels, the monitor's and the window's dpi and
//! DPI awareness, minimised / cloaked, the non-ASCII characters of the
//! title (an en dash and a hyphen look alike), which shipped room's
//! matcher takes it (none yet), and what a candidate regex (`--try-title`)
//! reads from it. Read-only: it attaches to nothing and draws nothing.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::PathBuf;

use regex::Regex;

use crate::compliance::Compliance;
use crate::exit_code;
use crate::platform::matcher::{read_title, same_process};
use crate::platform::{RawWindow, Redactor, TableMatcher, dpi_permille, table_of, windows};

pub const USAGE: &str = "\
rail-hud --list-windows: the visible top-level windows, for capturing the
table titles of real poker clients (docs/research/CAPTURING-TABLES.md).

  rail-hud --list-windows [--process <exe>]... [--you <name>]...
                          [--store <rail.db>] [--try-title <regex>]

  --process <exe>     only this program's windows (PokerStars.exe; repeat)
  --you <name>        one of your screen names, redacted to <you> (repeat)
  --store <rail.db>   redact the hero names of this store too (default: the
                      app's store, when there is one)
  --no-store          do not read the app's store
  --try-title <regex> a candidate title regex: what its `table` and `seats`
                      groups read from each title

Titles are redacted: anything after \"Logged in as\" and your screen names
become <you>. Read the output before you share it. Windows only for now.
";

/// The diagnostic's command line.
#[derive(Debug, Default)]
pub struct ListArgs {
    pub processes: Vec<String>,
    pub you: Vec<String>,
    pub store: Option<PathBuf>,
    pub no_store: bool,
    pub try_title: Option<Regex>,
}

impl ListArgs {
    /// The arguments after `--list-windows`.
    pub fn parse(args: Vec<OsString>) -> Result<Self, String> {
        let mut parsed = Self::default();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            let arg = arg.to_string_lossy().into_owned();
            let mut value = |name: &str| {
                iter.next()
                    .ok_or_else(|| format!("{name} needs a value"))
                    .map(|v| v.to_string_lossy().into_owned())
            };
            match arg.as_str() {
                "--list-windows" => {}
                "--process" => parsed.processes.push(value("--process")?),
                "--you" => parsed.you.push(value("--you")?),
                "--store" => parsed.store = Some(PathBuf::from(value("--store")?)),
                "--no-store" => parsed.no_store = true,
                "--try-title" => {
                    let pattern = value("--try-title")?;
                    parsed.try_title = Some(
                        Regex::new(&pattern)
                            .map_err(|e| format!("--try-title does not compile: {e}"))?,
                    );
                }
                "--help" | "-h" => return Err(String::new()),
                other => return Err(format!("unknown argument {other} for --list-windows")),
            }
        }
        if parsed.no_store && parsed.store.is_some() {
            return Err("--store and --no-store".to_owned());
        }
        Ok(parsed)
    }
}

/// The app's store where the app keeps it (`app_local_data_dir`), if it is
/// there.
fn default_store() -> Option<PathBuf> {
    let dir = if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
    } else if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support")
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".local/share")
    };
    let path = dir.join("app.rail.desktop").join(rail_store::FILE_NAME);
    path.is_file().then_some(path)
}

/// The hero names of a store, read-only.
fn store_names(path: &std::path::Path) -> Result<Vec<String>, String> {
    let reader = rail_store::Reader::open(path, 1).map_err(|e| e.to_string())?;
    reader.hero_names().map_err(|e| e.to_string())
}

/// The process: prints the list, returns the exit code.
pub fn run(args: Vec<OsString>) -> i32 {
    let args = match ListArgs::parse(args) {
        Ok(args) => args,
        Err(error) => {
            if !error.is_empty() {
                eprintln!("rail-hud: {error}");
            }
            eprint!("{USAGE}");
            return if error.is_empty() {
                exit_code::OK
            } else {
                exit_code::USAGE
            };
        }
    };
    let mut names = args.you.clone();
    let mut notes = Vec::new();
    let store = if args.no_store {
        None
    } else {
        args.store.clone().or_else(default_store)
    };
    if let Some(path) = &store {
        match store_names(path) {
            Ok(found) => {
                notes.push(format!(
                    "{} hero name(s) from the store {}",
                    found.len(),
                    path.display()
                ));
                names.extend(found);
            }
            Err(error) => notes.push(format!(
                "the store {} did not open ({error}); only --you names are redacted",
                path.display()
            )),
        }
    }
    if let Err(error) = windows::init_process_dpi_awareness() {
        notes.push(format!("DPI awareness: {error}"));
    }
    let windows = match windows::enumerate() {
        Ok(windows) => windows,
        Err(error) => {
            eprintln!("rail-hud --list-windows: {error}");
            return exit_code::USAGE;
        }
    };
    let compliance = Compliance::shipped().ok();
    let matchers = compliance
        .as_ref()
        .map(Compliance::matchers)
        .unwrap_or_default();
    let redactor = Redactor::new(&names);
    print!(
        "{}",
        render(
            &windows,
            &args,
            &redactor,
            &matchers,
            compliance.as_ref(),
            &notes
        )
    );
    exit_code::OK
}

/// The listing (no I/O: the tests feed it windows).
pub fn render(
    windows: &[RawWindow],
    args: &ListArgs,
    redactor: &Redactor,
    matchers: &[TableMatcher],
    compliance: Option<&Compliance>,
    notes: &[String],
) -> String {
    let wanted = |w: &&RawWindow| {
        args.processes.is_empty() || args.processes.iter().any(|p| same_process(p, &w.process))
    };
    let shown: Vec<&RawWindow> = windows
        .iter()
        .filter(wanted)
        .filter(|w| !w.title.trim().is_empty())
        .collect();
    let untitled = windows
        .iter()
        .filter(wanted)
        .filter(|w| w.title.trim().is_empty())
        .count();
    let mut out = String::new();
    let _ = write!(
        out,
        "rail-hud --list-windows: {} window(s) with a title",
        shown.len()
    );
    if untitled > 0 {
        let _ = write!(out, " ({untitled} without one not shown)");
    }
    if !args.processes.is_empty() {
        let _ = write!(out, "; processes: {}", args.processes.join(", "));
    }
    out.push('\n');
    let _ = writeln!(
        out,
        "Titles are redacted: anything after \"Logged in as\" and {} screen name(s) -> {}.",
        redactor.names(),
        crate::platform::matcher::YOU
    );
    for note in notes {
        let _ = writeln!(out, "Note: {note}.");
    }
    out.push_str("Read every line before you share it.\n");
    for window in shown {
        out.push('\n');
        let title = redactor.redact(&window.title);
        let process = if window.process.is_empty() {
            "? (could not be asked)"
        } else {
            window.process.as_str()
        };
        let _ = writeln!(out, "process: {process}");
        let _ = writeln!(out, "class:   {:?}", window.class);
        let _ = writeln!(out, "title:   {title:?}");
        let odd: Vec<String> = title
            .char_indices()
            .filter(|(_, c)| !c.is_ascii() || c.is_ascii_control())
            .map(|(at, c)| format!("U+{:04X} at byte {at}", u32::from(c)))
            .collect();
        if !odd.is_empty() {
            let _ = writeln!(out, "         non-ASCII or control: {}", odd.join(", "));
        }
        let state = match (window.minimized, window.cloaked) {
            (true, true) => "minimised, cloaked",
            (true, false) => "minimised",
            (false, true) => "cloaked (another virtual desktop?)",
            (false, false) => "shown",
        };
        let c = window.client;
        let _ = writeln!(
            out,
            "client:  {}x{} physical px at ({}, {}); {state}",
            c.width, c.height, c.x, c.y
        );
        let _ = writeln!(
            out,
            "dpi:     monitor {} ({}%), window {} ({}), DPI awareness {}",
            window.monitor_dpi,
            dpi_permille(window.monitor_dpi) / 10,
            window.window_dpi,
            if window.window_dpi == window.monitor_dpi {
                "same"
            } else {
                "stretched by Windows"
            },
            window.awareness.as_str()
        );
        if let Some(table) = table_of(window, matchers) {
            let decision = match compliance.map(|c| c.decide(&table.site)) {
                Some(Ok(())) => "HUD allowed".to_owned(),
                Some(Err(reason)) => format!("HUD refused: {reason:?}"),
                None => "policy not read".to_owned(),
            };
            let _ = writeln!(
                out,
                "room:    {} ({decision}), table {:?}, seats {}",
                table.site,
                table.table.as_deref().map(|t| redactor.redact(t)),
                seats(table.size)
            );
        }
        if let Some(pattern) = &args.try_title {
            match read_title(pattern, &window.title) {
                Some(found) => {
                    let _ = writeln!(
                        out,
                        "try:     table {:?}, seats {}",
                        found.table.as_deref().map(|t| redactor.redact(t)),
                        seats(found.seats)
                    );
                }
                None => {
                    let _ = writeln!(out, "try:     no match");
                }
            }
        }
    }
    out
}

fn seats(seats: Option<u32>) -> String {
    seats.map_or_else(|| "-".to_owned(), |n| n.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{DpiAwareness, Rect, WindowId};

    fn window(process: &str, title: &str) -> RawWindow {
        RawWindow {
            id: WindowId(7),
            pid: 1,
            process: process.into(),
            class: "Frame".into(),
            title: title.into(),
            client: Rect {
                x: 8,
                y: 31,
                width: 1200,
                height: 830,
            },
            monitor_dpi: 144,
            window_dpi: 96,
            awareness: DpiAwareness::Unaware,
            minimized: false,
            cloaked: false,
        }
    }

    fn args(list: &[&str]) -> ListArgs {
        ListArgs::parse(list.iter().map(OsString::from).collect()).expect("args")
    }

    #[test]
    fn arguments() {
        let parsed = args(&[
            "--list-windows",
            "--process",
            "PokerStars.exe",
            "--you",
            "Me",
            "--you",
            "Me2",
            "--try-title",
            "^(?P<table>.+?) - ",
        ]);
        assert_eq!(parsed.processes, ["PokerStars.exe"]);
        assert_eq!(parsed.you, ["Me", "Me2"]);
        assert!(parsed.try_title.is_some());
        let parse = |list: &[&str]| ListArgs::parse(list.iter().map(OsString::from).collect());
        assert!(parse(&["--try-title", "(unclosed"]).is_err());
        assert!(parse(&["--you"]).is_err());
        assert!(parse(&["--standalone"]).is_err());
        assert!(parse(&["--no-store", "--store", "x"]).is_err());
        assert_eq!(parse(&["--help"]).err(), Some(String::new()));
    }

    /// The user's names never reach the output; the rest of the title,
    /// the process, size and dpi do; a candidate regex is tried.
    #[test]
    fn the_listing_is_redacted() {
        let windows = [
            window(
                "PokerStars.exe",
                "Hygiea IV - $0.05/$0.10 USD - Hold\u{2019}em - Logged In as SecretMe",
            ),
            window("PokerStars.exe", "SecretMe - Notes"),
            window("Other.exe", "Spreadsheet - SecretMe.xlsx"),
            window("PokerStars.exe", ""),
        ];
        let redactor = Redactor::new(&["secretme".into()]);
        let listing = render(
            &windows,
            &args(&[
                "--process",
                "pokerstars.exe",
                "--try-title",
                r"^(?P<table>.+?) - \$",
            ]),
            &redactor,
            &[],
            None,
            &["a note".to_owned()],
        );
        assert!(!listing.to_lowercase().contains("secretme"), "{listing}");
        assert!(listing.contains("2 window(s) with a title (1 without one not shown)"));
        assert!(listing.contains("Logged In as <you>"), "{listing}");
        assert!(listing.contains("\"<you> - Notes\""), "{listing}");
        assert!(!listing.contains("Spreadsheet"), "the process filter");
        assert!(listing.contains("U+2019"), "{listing}");
        assert!(listing.contains("1200x830 physical px at (8, 31); shown"));
        assert!(listing.contains("monitor 144 (150%), window 96 (stretched by Windows)"));
        assert!(listing.contains("DPI awareness unaware"));
        assert!(listing.contains("try:     table Some(\"Hygiea IV\"), seats -"));
        assert!(listing.contains("try:     no match"));
        assert!(listing.contains("Note: a note."));
        assert!(!listing.contains("room:"), "no room's matcher yet");
    }

    /// A window a room's matcher takes says so, with the policy's answer.
    #[test]
    fn a_matched_window_names_its_room() {
        let compliance = Compliance::shipped().expect("shipped");
        let matchers = [TableMatcher::simulator(
            "ggpoker",
            Regex::new(r"^(?P<table>.+?) - (?P<seats>\d+)-max").expect("regex"),
        )];
        let listing = render(
            &[window("rail-hud-sim.exe", "Miramar - 6-max")],
            &ListArgs::default(),
            &Redactor::new(&[]),
            &matchers,
            Some(&compliance),
            &[],
        );
        assert!(
            listing.contains(
                "room:    ggpoker (HUD refused: Prohibited), table Some(\"Miramar\"), seats 6"
            ),
            "{listing}"
        );
    }
}

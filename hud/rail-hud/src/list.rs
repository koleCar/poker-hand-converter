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
//!
//! **macOS** (R3.11): the ordinary windows of the window server's list
//! (`platform::macos::enumerate`), with the titles the Accessibility API
//! gives - which needs the Accessibility permission of the program it is
//! run from (the terminal); without it the listing says so and shows no
//! title (it never prompts and never asks for Screen Recording). The
//! "class" is the accessibility subrole, the scale the screen's backing
//! scale, "off screen" a window on another Space or of a hidden app.
//!
//! **Table tiling** (T6, docs/research/TABLE-TILING.md §5): each window's
//! outer frame and the insets around its client area - what tiling lays
//! edge to edge ([`crate::platform::Platform::frame_insets`]) -, whether it
//! can be resized, its minimum and maximum size where the system says so
//! without asking the client ([`crate::platform::WindowDetails`]), and for
//! a window a room takes (its `tables` block, or `--try-title` with
//! `--room`) whether that room permits the HUD, tiling and the RNG. Still
//! read-only.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::PathBuf;

use regex::Regex;

use crate::compliance::Compliance;
use crate::exit_code;
use std::collections::BTreeMap;

use rail_hud_ipc::protocol::RefusalReason;

use crate::platform::matcher::{read_title, same_process};
use crate::platform::{
    PlatformError, RawWindow, Redactor, TableMatcher, WindowDetails, WindowId, dpi_permille, macos,
    table_of, window_details, windows,
};

pub const USAGE: &str = "\
rail-hud --list-windows: the visible top-level windows, for capturing the
table titles of real poker clients (docs/research/CAPTURING-TABLES.md).

  rail-hud --list-windows [--process <exe>]... [--you <name>]...
                          [--store <rail.db>] [--try-title <regex>]
                          [--room <sites.json id>]

  --process <exe>     only this program's windows (PokerStars.exe on Windows,
                      the executable's name on macOS; repeat)
  --you <name>        one of your screen names, redacted to <you> (repeat)
  --store <rail.db>   redact the hero names of this store too (default: the
                      app's store, when there is one)
  --no-store          do not read the app's store
  --try-title <regex> a candidate title regex: what its `table` and `seats`
                      groups read from each title
  --room <id>         the room --try-title is for (pokerstars, acr, ...):
                      its HUD, tiling and RNG policy is shown with each
                      window the regex takes

Each window also shows its outer frame and the insets around the client
area (what table tiling lays edge to edge), whether it can be resized, and
for a room's window whether its policy permits the HUD, tiling and the RNG.

Titles are redacted: anything after \"Logged in as\" and your screen names
become <you>. Read the output before you share it.

Windows and macOS. On macOS the titles come from the Accessibility API: the
app you run this from (Terminal) needs the Accessibility permission (System
Settings, Privacy & Security, Accessibility). Nothing else - no Screen
Recording.
";

/// The diagnostic's command line.
#[derive(Debug, Default)]
pub struct ListArgs {
    pub processes: Vec<String>,
    pub you: Vec<String>,
    pub store: Option<PathBuf>,
    pub no_store: bool,
    pub try_title: Option<Regex>,
    /// (T6) The room `--try-title` is for: its policy is shown.
    pub room: Option<String>,
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
                "--room" => parsed.room = Some(value("--room")?),
                "--help" | "-h" => return Err(String::new()),
                other => return Err(format!("unknown argument {other} for --list-windows")),
            }
        }
        if parsed.no_store && parsed.store.is_some() {
            return Err("--store and --no-store".to_owned());
        }
        if parsed.room.is_some() && parsed.try_title.is_none() {
            return Err("--room goes with --try-title".to_owned());
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

/// The names to redact: `you`, and the hero names of `store` (the app's
/// store when `None`, none with `no_store`); what was read goes in `notes`.
/// Shared with `--tile-check` and `--watch-signals`.
pub fn redaction_names(
    you: &[String],
    store: Option<&std::path::Path>,
    no_store: bool,
    notes: &mut Vec<String>,
) -> Vec<String> {
    let mut names = you.to_vec();
    let store = if no_store {
        None
    } else {
        store
            .map(std::path::Path::to_path_buf)
            .or_else(default_store)
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
    names
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
    let mut notes = Vec::new();
    let names = redaction_names(&args.you, args.store.as_deref(), args.no_store, &mut notes);
    let macos = cfg!(target_os = "macos");
    let windows = match system_windows(&args, &mut notes) {
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
    let wanted: Vec<RawWindow> = windows
        .iter()
        .filter(|w| shown(w, &args.processes))
        .cloned()
        .collect();
    let details = window_details(&wanted);
    print!(
        "{}",
        render(&Listing {
            windows: &windows,
            args: &args,
            redactor: &redactor,
            matchers: &matchers,
            compliance: compliance.as_ref(),
            notes: &notes,
            macos,
            details: &details,
        })
    );
    exit_code::OK
}

/// A window `--list-windows` prints: titled, of one of `processes` (any
/// when empty).
fn shown(window: &RawWindow, processes: &[String]) -> bool {
    !window.title.trim().is_empty()
        && (processes.is_empty() || processes.iter().any(|p| same_process(p, &window.process)))
}

/// What one listing is made of.
#[derive(Debug)]
pub struct Listing<'a> {
    pub windows: &'a [RawWindow],
    pub args: &'a ListArgs,
    pub redactor: &'a Redactor,
    pub matchers: &'a [TableMatcher],
    pub compliance: Option<&'a Compliance>,
    pub notes: &'a [String],
    /// The windows are macOS's (subroles, backing scale, Spaces) rather
    /// than Windows'.
    pub macos: bool,
    /// (T6) The windows' frames and sizes ([`window_details`]).
    pub details: &'a BTreeMap<WindowId, WindowDetails>,
}

/// (T6) A policy answer as a listing says it.
pub fn verdict(answer: Result<(), RefusalReason>) -> &'static str {
    match answer {
        Ok(()) => "permitted",
        Err(RefusalReason::Prohibited) => "refused (the room prohibits it)",
        Err(RefusalReason::Unknown) => "refused (policy unknown, counted as no)",
        Err(RefusalReason::NotARoom) => "refused (not a room)",
        Err(RefusalReason::UnknownSite) => "refused (not in sites.json)",
    }
}

/// (T6) Room `site`'s three answers: the HUD, tiling ([`TilingPermit`]) and
/// the RNG ([`RngPermit`]).
///
/// [`TilingPermit`]: crate::compliance::TilingPermit
/// [`RngPermit`]: crate::compliance::RngPermit
pub fn permits(compliance: &Compliance, site: &str) -> String {
    format!(
        "HUD {}; tiling {}; RNG {}",
        verdict(compliance.decide(site)),
        verdict(compliance.tiling_permit(site).map(|_| ())),
        verdict(compliance.rng_permit(site).map(|_| ())),
    )
}

/// (T6) A size as `WxH`, or `-`.
fn size_text(size: Option<(u32, u32)>) -> String {
    size.map_or_else(|| "-".to_owned(), |(w, h)| format!("{w}x{h}"))
}

/// (T6) `yes`, `no`, or `?` (the system did not say).
fn yes_no(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "yes",
        Some(false) => "no",
        None => "?",
    }
}

/// (T6) The `frame:` and `size:` lines of one window.
fn frame_lines(out: &mut String, details: Option<&WindowDetails>, macos: bool) {
    let Some(d) = details else {
        let _ = writeln!(out, "frame:   not read");
        return;
    };
    if let (Some(o), Some(i)) = (d.outer, d.insets) {
        let _ = writeln!(
            out,
            "frame:   outer {}x{} at ({}, {}); insets left {}, top {}, right {}, bottom {} ({})",
            o.width,
            o.height,
            o.x,
            o.y,
            i.left,
            i.top,
            i.right,
            i.bottom,
            if macos {
                "px; the title bar"
            } else {
                "physical px; the visible frame"
            }
        );
    } else {
        let _ = writeln!(out, "frame:   not on screen (minimised or hidden)");
    }
    let limits = if d.min_size.is_none() && d.max_size.is_none() {
        if macos {
            "min/max: not given by the Accessibility API".to_owned()
        } else {
            "min/max: not readable without a message to the client".to_owned()
        }
    } else {
        format!(
            "min {}, max {}",
            size_text(d.min_size),
            size_text(d.max_size)
        )
    };
    let _ = writeln!(
        out,
        "size:    resizable {}, movable {}; {limits}",
        yes_no(d.resizable),
        yes_no(d.movable)
    );
}

/// This system's windows: Windows' top-level windows (R3.3), or macOS's
/// ordinary windows with their accessibility titles (R3.11; the
/// permission's state in `notes` - read, never asked for).
fn system_windows(
    args: &ListArgs,
    notes: &mut Vec<String>,
) -> Result<Vec<RawWindow>, PlatformError> {
    if cfg!(target_os = "macos") {
        if macos::accessibility_granted() {
            notes.push("Accessibility: granted; titles read through the Accessibility API".into());
        } else {
            notes.push(
                "Accessibility: NOT granted to the program this runs from, so no title can be \
                 read and no window is shown. Switch it on for your terminal in System Settings, \
                 Privacy & Security, Accessibility, then run this again"
                    .into(),
            );
        }
        notes.push(format!(
            "Screen Recording: not used ({} here)",
            if macos::screen_recording_granted() {
                "granted"
            } else {
                "not granted"
            }
        ));
        let wanted = |process: &str| {
            args.processes.is_empty() || args.processes.iter().any(|p| same_process(p, process))
        };
        macos::enumerate(&wanted)
    } else {
        if let Err(error) = windows::init_process_dpi_awareness() {
            notes.push(format!("DPI awareness: {error}"));
        }
        windows::enumerate()
    }
}

/// The listing (no I/O: the tests feed it windows).
pub fn render(listing: &Listing<'_>) -> String {
    let Listing {
        windows,
        args,
        redactor,
        matchers,
        compliance,
        notes,
        macos,
        details,
    } = *listing;
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
        if macos {
            let _ = writeln!(out, "subrole: {:?}", window.class);
        } else {
            let _ = writeln!(out, "class:   {:?}", window.class);
        }
        let _ = writeln!(out, "title:   {title:?}");
        let odd: Vec<String> = title
            .char_indices()
            .filter(|(_, c)| !c.is_ascii() || c.is_ascii_control())
            .map(|(at, c)| format!("U+{:04X} at byte {at}", u32::from(c)))
            .collect();
        if !odd.is_empty() {
            let _ = writeln!(out, "         non-ASCII or control: {}", odd.join(", "));
        }
        let state = match (window.minimized, window.cloaked, macos) {
            (true, true, _) => "minimised, cloaked",
            (true, false, _) => "minimised",
            (false, true, false) => "cloaked (another virtual desktop?)",
            (false, true, true) => "off screen (another Space, or the app hidden)",
            (false, false, _) => "shown",
        };
        let c = window.client;
        if macos {
            // Pixels are points times the screen's backing scale (R3.11).
            let scale = dpi_permille(window.monitor_dpi).max(1);
            let pt = |px: i64| px * 1000 / i64::from(scale);
            let _ = writeln!(
                out,
                "client:  {}x{} px at ({}, {}) = {}x{} pt at ({}, {}); {state}",
                c.width,
                c.height,
                c.x,
                c.y,
                pt(i64::from(c.width)),
                pt(i64::from(c.height)),
                pt(i64::from(c.x)),
                pt(i64::from(c.y))
            );
            let _ = writeln!(out, "scale:   {}% (the screen's backing scale)", scale / 10);
        } else {
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
        }
        frame_lines(&mut out, details.get(&window.id), macos);
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
            if let Some(compliance) = compliance {
                let _ = writeln!(out, "permits: {}", permits(compliance, &table.site));
            }
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
                    if let (Some(room), Some(compliance)) = (&args.room, compliance) {
                        let _ = writeln!(out, "         as {room}: {}", permits(compliance, room));
                    }
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
    use crate::platform::{DpiAwareness, Insets, Rect};

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

    /// A listing of `windows` with no matcher, policy or details.
    fn plain<'a>(
        windows: &'a [RawWindow],
        args: &'a ListArgs,
        redactor: &'a Redactor,
        notes: &'a [String],
        details: &'a BTreeMap<WindowId, WindowDetails>,
    ) -> Listing<'a> {
        Listing {
            windows,
            args,
            redactor,
            matchers: &[],
            compliance: None,
            notes,
            macos: false,
            details,
        }
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
        // (T6) A room for the candidate regex, only with one.
        assert!(parse(&["--room", "pokerstars"]).is_err());
        let parsed = args(&["--try-title", "^x", "--room", "acr"]);
        assert_eq!(parsed.room.as_deref(), Some("acr"));
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
        let list_args = args(&[
            "--process",
            "pokerstars.exe",
            "--try-title",
            r"^(?P<table>.+?) - \$",
        ]);
        let notes = ["a note".to_owned()];
        let none = BTreeMap::new();
        let listing = render(&plain(&windows, &list_args, &redactor, &notes, &none));
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
        let none = BTreeMap::new();
        let listing = render(&Listing {
            matchers: &matchers,
            compliance: Some(&compliance),
            ..plain(
                &[window("rail-hud-sim.exe", "Miramar - 6-max")],
                &ListArgs::default(),
                &Redactor::new(&[]),
                &[],
                &none,
            )
        });
        assert!(
            listing.contains(
                "room:    ggpoker (HUD refused: Prohibited), table Some(\"Miramar\"), seats 6"
            ),
            "{listing}"
        );
        // (T6) Tiling and the RNG: GGPoker's own `false`s.
        assert!(
            listing.contains(
                "permits: HUD refused (the room prohibits it); tiling refused (the room \
                 prohibits it); RNG refused (the room prohibits it)"
            ),
            "{listing}"
        );
        assert!(listing.contains("frame:   not read"), "{listing}");
    }

    /// (T6) The frame, the insets, resizable; a candidate regex with its
    /// room's policy: WPT Global refuses a HUD and permits tiling.
    #[test]
    fn tiling_details_and_permits() {
        let compliance = Compliance::shipped().expect("shipped");
        let table = window("WPTGlobal.exe", "NL 0.05/0.10 - Table 12");
        let mut minimised = window("WPTGlobal.exe", "Lobby");
        minimised.id = WindowId(8);
        minimised.minimized = true;
        let details = BTreeMap::from([
            (
                WindowId(7),
                WindowDetails {
                    outer: Some(Rect {
                        x: 0,
                        y: 0,
                        width: 1216,
                        height: 869,
                    }),
                    insets: Some(Insets {
                        left: 8,
                        top: 31,
                        right: 8,
                        bottom: 8,
                    }),
                    resizable: Some(true),
                    movable: Some(true),
                    min_size: None,
                    max_size: None,
                },
            ),
            (
                WindowId(8),
                WindowDetails {
                    resizable: Some(false),
                    movable: Some(true),
                    ..WindowDetails::default()
                },
            ),
        ]);
        let list_args = args(&[
            "--try-title",
            r"^NL .+ - (?P<table>Table \d+)$",
            "--room",
            "wpt-global",
        ]);
        let listing = render(&Listing {
            compliance: Some(&compliance),
            ..plain(
                &[table, minimised],
                &list_args,
                &Redactor::new(&[]),
                &[],
                &details,
            )
        });
        assert!(
            listing.contains(
                "frame:   outer 1216x869 at (0, 0); insets left 8, top 31, right 8, bottom 8 \
                 (physical px; the visible frame)"
            ),
            "{listing}"
        );
        assert!(
            listing.contains(
                "size:    resizable yes, movable yes; min/max: not readable without a message \
                 to the client"
            ),
            "{listing}"
        );
        assert!(listing.contains("frame:   not on screen (minimised or hidden)"));
        assert!(listing.contains("size:    resizable no, movable yes"));
        assert!(
            listing.contains(
                "         as wpt-global: HUD refused (the room prohibits it); tiling permitted; \
                 RNG refused (the room prohibits it)"
            ),
            "{listing}"
        );
        assert_eq!(
            listing.matches("as wpt-global").count(),
            1,
            "the lobby: no match"
        );
    }

    /// (T6) macOS: the whole window from the window server, the title bar
    /// as the inset, at the screen's scale.
    #[test]
    fn macos_details() {
        let client = Rect {
            x: 20,
            y: 116,
            width: 1280,
            height: 960,
        };
        let bounds = macos::Frame {
            x: 10_000,
            y: 30_000,
            width: 640_000,
            height: 508_000,
        };
        let d = macos::details_of(&client, &bounds, 2000, false, Some(true), Some(true));
        assert_eq!(
            d.outer,
            Some(Rect {
                x: 20,
                y: 60,
                width: 1280,
                height: 1016
            })
        );
        assert_eq!(
            d.insets,
            Some(Insets {
                top: 56,
                ..Insets::default()
            })
        );
        let gone = macos::details_of(&client, &bounds, 2000, true, None, None);
        assert_eq!(
            (gone.outer, gone.insets, gone.resizable),
            (None, None, None)
        );
        let mut out = String::new();
        frame_lines(&mut out, Some(&d), true);
        assert!(out.contains("insets left 0, top 56, right 0, bottom 0 (px; the title bar)"));
        assert!(out.contains("min/max: not given by the Accessibility API"));
    }

    /// (R3.11) macOS's windows: the subrole, pixels and points at the
    /// screen's backing scale, a window on another Space; still redacted.
    #[test]
    fn a_macos_listing() {
        let mut retina = window("rail-hud-sim", "Hygiea IV - Logged In as SecretMe");
        retina.class = "AXStandardWindow".into();
        retina.client = Rect {
            x: 20,
            y: 116,
            width: 1280,
            height: 960,
        };
        retina.monitor_dpi = 192;
        retina.window_dpi = 192;
        let mut away = retina.clone();
        away.cloaked = true;
        away.title = "Florence 03".into();
        let notes = ["Accessibility: granted".to_owned()];
        let none = BTreeMap::new();
        let listing = render(&Listing {
            macos: true,
            ..plain(
                &[retina, away],
                &ListArgs::default(),
                &Redactor::new(&["SecretMe".into()]),
                &notes,
                &none,
            )
        });
        assert!(!listing.contains("SecretMe"), "{listing}");
        assert!(
            listing.contains("subrole: \"AXStandardWindow\""),
            "{listing}"
        );
        assert!(
            listing.contains("client:  1280x960 px at (20, 116) = 640x480 pt at (10, 58); shown"),
            "{listing}"
        );
        assert!(listing.contains("scale:   200% (the screen's backing scale)"));
        assert!(listing.contains("off screen (another Space, or the app hidden)"));
        assert!(!listing.contains("dpi:") && !listing.contains("class:"));
        assert!(listing.contains("Note: Accessibility: granted."));
    }
}

//! (T6 for T7, docs/research/TABLE-TILING.md §4.6) `rail-hud
//! --watch-signals --process <exe>`: an opt-in, read-only log of the
//! window signals a poker client gives on its own - so the owner can
//! record, room by room, whether a usable "it is your turn" signal exists
//! for T7's dynamic slots (Action Required, In-Hand) **without** reading
//! anything inside a table.
//!
//! What it logs, with a timestamp each, for that program's top-level
//! windows only:
//!
//! - **Windows**: the shell hook (`RegisterShellHookWindow`) - a window
//!   flashing its taskbar button (`HSHELL_FLASH`), activated by the shell
//!   (`HSHELL_WINDOWACTIVATED`, `HSHELL_RUDEAPPACTIVATED`), its taskbar
//!   button redrawn (`HSHELL_REDRAW`: a title or icon change); WinEvent
//!   hooks, out of context (nothing is loaded into the client) - the
//!   foreground window (`EVENT_SYSTEM_FOREGROUND`), minimise start and end,
//!   a title change (`EVENT_OBJECT_NAMECHANGE`, the title redacted); and
//!   the window order, looked at every 100 ms ([`OrderWatch`]): which of
//!   the program's windows is in front of the others, and when one comes
//!   to the top of the desktop (a client raising its table).
//! - **macOS**: the window order alone, from the window server's list (no
//!   permission; titles for the legend need Accessibility, as for
//!   `--list-windows`): front of the client, top of the desktop, windows
//!   appearing, closing and going off screen. A Dock icon bouncing
//!   (`requestUserAttention`) is not visible to another program and is not
//!   logged: note it by eye.
//!
//! The platform-free half - the events, the order diff and the log's
//! lines - is here and unit-tested; the Windows hooks are
//! `platform::windows::signals`.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::exit_code;
use crate::list::redaction_names;
use crate::platform::{Redactor, WindowId};

pub const USAGE: &str = "\
rail-hud --watch-signals: log the window signals a poker client gives by
itself (taskbar flash, foreground, window order), with timestamps, so you
can tell whether it signals \"your turn\" (docs/research/REAL-CLIENT-CHECK.md).
Read-only: it moves nothing and reads nothing inside a table.

  rail-hud --watch-signals --process <exe> [--seconds <n>]
                           [--you <name>]... [--store <rail.db> | --no-store]

  --process <exe>   the client's program (repeat for more)
  --seconds <n>     how long to watch (default 300; Ctrl+C stops earlier)

Windows: the shell hook (HSHELL_FLASH and friends), the foreground window,
minimise and title changes, and the window order. macOS: the window order
only (front of the client, top of the desktop); a Dock bounce cannot be
seen by another program. Titles are redacted as in --list-windows.
";

/// How long the watch runs by default.
pub const DEFAULT_SECONDS: u64 = 300;

/// How often the window order is looked at.
pub const ORDER_EVERY: Duration = Duration::from_millis(100);

/// The shell hook's codes (`HSHELL_*`, the `wParam` of the `SHELLHOOK`
/// message); a test checks them against the `windows` crate's on Windows.
pub mod hshell {
    pub const WINDOWCREATED: u32 = 1;
    pub const WINDOWDESTROYED: u32 = 2;
    pub const WINDOWACTIVATED: u32 = 4;
    pub const REDRAW: u32 = 6;
    pub const HIGHBIT: u32 = 0x8000;
    /// `HSHELL_REDRAW | HSHELL_HIGHBIT`: the taskbar button flashes.
    pub const FLASH: u32 = REDRAW | HIGHBIT;
    /// `HSHELL_WINDOWACTIVATED | HSHELL_HIGHBIT`: activated over a
    /// full-screen app.
    pub const RUDEAPPACTIVATED: u32 = WINDOWACTIVATED | HIGHBIT;
}

/// One signal a window gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// `HSHELL_FLASH`: the taskbar button flashes (`FlashWindowEx`).
    Flash,
    /// `HSHELL_WINDOWACTIVATED` (`rude`: `HSHELL_RUDEAPPACTIVATED`).
    ShellActivated {
        rude: bool,
    },
    /// `HSHELL_REDRAW`: the taskbar button was redrawn.
    Redraw,
    /// `EVENT_SYSTEM_FOREGROUND`: it became the foreground window.
    Foreground,
    /// The foreground went to another program's window.
    ForegroundElsewhere,
    MinimizeStart,
    MinimizeEnd,
    /// `EVENT_OBJECT_NAMECHANGE`: a new title (raw; redacted when printed).
    Retitled {
        title: String,
    },
    /// Window order: it is now in front of the program's other windows.
    FrontOfClient,
    /// Window order: it is now the front-most ordinary window of the
    /// desktop (raised above every other program's).
    TopOfDesktop,
    /// Window order: it was the desktop's top window and is not any more.
    LeftTop,
    /// A window of the program there when the watch started (title raw):
    /// the log's legend, not a signal.
    Present {
        title: String,
    },
    /// A window of the program appeared (title raw).
    Appeared {
        title: String,
    },
    /// One closed.
    Closed,
    /// (macOS) It went off screen (minimised, another Space, app hidden).
    OffScreen,
    /// (macOS) It is on screen again.
    OnScreen,
}

impl Signal {
    /// The event's name in the log and the tally.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Flash => "FLASH",
            Self::ShellActivated { rude: false } => "shell-activated",
            Self::ShellActivated { rude: true } => "shell-activated (rude)",
            Self::Redraw => "taskbar-redraw",
            Self::Foreground => "FOREGROUND",
            Self::ForegroundElsewhere => "foreground-elsewhere",
            Self::MinimizeStart => "minimised",
            Self::MinimizeEnd => "restored",
            Self::Retitled { .. } => "retitled",
            Self::FrontOfClient => "front-of-client",
            Self::TopOfDesktop => "TOP-OF-DESKTOP",
            Self::LeftTop => "left-top",
            Self::Present { .. } => "present",
            Self::Appeared { .. } => "appeared",
            Self::Closed => "closed",
            Self::OffScreen => "off-screen",
            Self::OnScreen => "on-screen",
        }
    }

    /// What the system call behind it is, for the log.
    fn source(&self) -> &'static str {
        match self {
            Self::Flash => "HSHELL_FLASH: the taskbar button flashes",
            Self::ShellActivated { .. } => "HSHELL_WINDOWACTIVATED",
            Self::Redraw => "HSHELL_REDRAW: title or icon",
            Self::Foreground => "EVENT_SYSTEM_FOREGROUND",
            Self::ForegroundElsewhere => "another program's window",
            Self::MinimizeStart => "EVENT_SYSTEM_MINIMIZESTART",
            Self::MinimizeEnd => "EVENT_SYSTEM_MINIMIZEEND",
            Self::Retitled { .. } => "EVENT_OBJECT_NAMECHANGE",
            Self::FrontOfClient => "window order",
            Self::TopOfDesktop => "window order: raised above other programs",
            Self::LeftTop => "window order",
            Self::Present { .. } => "there at the start",
            Self::Appeared { .. } | Self::Closed => "window list",
            Self::OffScreen | Self::OnScreen => "window server",
        }
    }
}

/// A signal with when it came: since the watch started, and the wall
/// clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalEvent {
    pub since_start: Duration,
    pub wall: SystemTime,
    pub window: Option<WindowId>,
    pub signal: Signal,
}

/// The wall clock's time of day, UTC, `HH:MM:SS.mmm`.
pub fn utc_time(wall: SystemTime) -> String {
    let since = wall.duration_since(UNIX_EPOCH).unwrap_or_default();
    let day = since.as_secs() % 86_400;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        day / 3600,
        day / 60 % 60,
        day % 60,
        since.subsec_millis()
    )
}

/// One line of the log; titles through `redactor`.
pub fn line(event: &SignalEvent, redactor: &Redactor) -> String {
    let mut out = format!(
        "+{:>4}.{:03} s  {} UTC  ",
        event.since_start.as_secs(),
        event.since_start.subsec_millis(),
        utc_time(event.wall)
    );
    match event.window {
        Some(id) => {
            let _ = write!(out, "window {:#x}  ", id.0);
        }
        None => out.push_str("-  "),
    }
    let _ = write!(out, "{} ({})", event.signal.name(), event.signal.source());
    match &event.signal {
        Signal::Retitled { title } | Signal::Appeared { title } | Signal::Present { title } => {
            let _ = write!(out, " {:?}", redactor.redact(title));
        }
        _ => {}
    }
    out
}

/// The tally at the end: how often each signal came, and on how many
/// windows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tally {
    counts: BTreeMap<&'static str, (u64, BTreeSet<WindowId>)>,
}

impl Tally {
    pub fn add(&mut self, event: &SignalEvent) {
        if matches!(event.signal, Signal::Present { .. }) {
            return; // the legend, not a signal
        }
        let entry = self.counts.entry(event.signal.name()).or_default();
        entry.0 += 1;
        if let Some(id) = event.window {
            entry.1.insert(id);
        }
    }

    /// How many of signal `name` came.
    pub fn count(&self, name: &str) -> u64 {
        self.counts.get(name).map_or(0, |(n, _)| *n)
    }

    pub fn render(&self, seconds: u64) -> String {
        let mut out = format!("\nSignals in {seconds} s:\n");
        if self.counts.is_empty() {
            out.push_str("  none\n");
        }
        for (name, (n, windows)) in &self.counts {
            let _ = writeln!(out, "  {name}: {n} (on {} window(s))", windows.len());
        }
        out.push_str(
            "A usable \"your turn\" signal: one that comes every time it is your turn at a \
             table, on that table's window, and not otherwise (FLASH, FOREGROUND or \
             TOP-OF-DESKTOP are the candidates). Note what you did when each came.\n",
        );
        out
    }
}

/// One window in an order look, front to back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ordered {
    pub id: WindowId,
    /// It is one of the watched program's windows.
    pub client: bool,
    /// It is shown (not minimised, not off screen): it can be in front.
    pub shown: bool,
}

/// The window order as last seen, to tell what changed ([`OrderWatch::look`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrderWatch {
    started: bool,
    /// The program's windows, and whether each was shown.
    known: BTreeMap<WindowId, bool>,
    client_front: Option<WindowId>,
    /// The desktop's top ordinary window, when it is the program's.
    desktop_top: Option<WindowId>,
}

impl OrderWatch {
    /// A new look at the order: every ordinary top-level window, front to
    /// back. The first look only records; later ones say what changed:
    /// windows of the program appearing and closing, shown or not
    /// (`report_shown`: macOS, whose minimise has no event here), the one
    /// in front of the program's others, and the program's window at the
    /// top of the desktop or leaving it.
    pub fn look(&mut self, order: &[Ordered], report_shown: bool) -> Vec<(WindowId, Signal)> {
        let mut out = Vec::new();
        let now: BTreeMap<WindowId, bool> = order
            .iter()
            .filter(|w| w.client)
            .map(|w| (w.id, w.shown))
            .collect();
        let front = order.iter().find(|w| w.client && w.shown).map(|w| w.id);
        let top = order
            .iter()
            .find(|w| w.shown)
            .filter(|w| w.client)
            .map(|w| w.id);
        if self.started {
            for (id, shown) in &now {
                match self.known.get(id) {
                    None => out.push((
                        *id,
                        Signal::Appeared {
                            title: String::new(),
                        },
                    )),
                    Some(was) if report_shown && was != shown => out.push((
                        *id,
                        if *shown {
                            Signal::OnScreen
                        } else {
                            Signal::OffScreen
                        },
                    )),
                    Some(_) => {}
                }
            }
            for id in self.known.keys().filter(|id| !now.contains_key(id)) {
                out.push((*id, Signal::Closed));
            }
            if let Some(front) = front
                && self.client_front != Some(front)
            {
                out.push((front, Signal::FrontOfClient));
            }
            if top != self.desktop_top {
                if let Some(left) = self.desktop_top
                    && now.contains_key(&left)
                {
                    out.push((left, Signal::LeftTop));
                }
                if let Some(top) = top {
                    out.push((top, Signal::TopOfDesktop));
                }
            }
        }
        self.started = true;
        self.known = now;
        self.client_front = front;
        self.desktop_top = top;
        out
    }
}

/// The command line after `--watch-signals`.
#[derive(Debug, Default)]
pub struct WatchArgs {
    pub processes: Vec<String>,
    pub seconds: u64,
    pub you: Vec<String>,
    pub store: Option<PathBuf>,
    pub no_store: bool,
}

impl WatchArgs {
    pub fn parse(args: Vec<OsString>) -> Result<Self, String> {
        let mut parsed = Self {
            seconds: DEFAULT_SECONDS,
            ..Self::default()
        };
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            let arg = arg.to_string_lossy().into_owned();
            let mut value = |name: &str| {
                iter.next()
                    .ok_or_else(|| format!("{name} needs a value"))
                    .map(|v| v.to_string_lossy().into_owned())
            };
            match arg.as_str() {
                "--watch-signals" => {}
                "--process" => parsed.processes.push(value("--process")?),
                "--seconds" => {
                    parsed.seconds = value("--seconds")?
                        .parse()
                        .ok()
                        .filter(|n| (1..=86_400).contains(n))
                        .ok_or("--seconds takes 1 - 86400")?;
                }
                "--you" => parsed.you.push(value("--you")?),
                "--store" => parsed.store = Some(PathBuf::from(value("--store")?)),
                "--no-store" => parsed.no_store = true,
                "--help" | "-h" => return Err(String::new()),
                other => return Err(format!("unknown argument {other} for --watch-signals")),
            }
        }
        if parsed.processes.is_empty() {
            return Err("--watch-signals needs --process <exe>".to_owned());
        }
        if parsed.no_store && parsed.store.is_some() {
            return Err("--store and --no-store".to_owned());
        }
        Ok(parsed)
    }
}

/// The process: watches, prints each signal as it comes and the tally at
/// the end; the exit code.
pub fn run(args: Vec<OsString>) -> i32 {
    let args = match WatchArgs::parse(args) {
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
    let redactor = Redactor::new(&names);
    println!(
        "rail-hud --watch-signals: {} for {} s (Ctrl+C stops). Titles are redacted ({} name(s) \
         -> {}); read every line before you share it.",
        args.processes.join(", "),
        args.seconds,
        redactor.names(),
        crate::platform::matcher::YOU
    );
    for note in &notes {
        println!("Note: {note}.");
    }
    let mut tally = Tally::default();
    let mut sink = |event: SignalEvent| {
        println!("{}", line(&event, &redactor));
        tally.add(&event);
    };
    let watched = watch(
        &args.processes,
        Duration::from_secs(args.seconds),
        &mut sink,
    );
    if let Err(error) = watched {
        eprintln!("rail-hud --watch-signals: {error}");
        return exit_code::USAGE;
    }
    print!("{}", tally.render(args.seconds));
    exit_code::OK
}

/// This system's watcher.
fn watch(
    processes: &[String],
    duration: Duration,
    sink: &mut dyn FnMut(SignalEvent),
) -> Result<(), String> {
    if cfg!(windows) {
        crate::platform::windows::watch_signals(processes, duration, sink)
            .map_err(|e| e.to_string())
    } else if cfg!(target_os = "macos") {
        macos::watch(processes, duration, sink)
    } else {
        Err("watching window signals needs Windows or macOS".to_owned())
    }
}

/// macOS: the window order from the window server, every [`ORDER_EVERY`];
/// the program's windows (and their titles, with the Accessibility
/// permission) looked up every second.
mod macos {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant, SystemTime};

    use super::{ORDER_EVERY, OrderWatch, Ordered, Signal, SignalEvent};
    use crate::platform::matcher::same_process;
    use crate::platform::{WindowId, macos};

    pub(super) fn watch(
        processes: &[String],
        duration: Duration,
        sink: &mut dyn FnMut(SignalEvent),
    ) -> Result<(), String> {
        let started = Instant::now();
        let wanted = |p: &str| processes.iter().any(|w| same_process(w, p));
        let mut order = OrderWatch::default();
        let mut pids = Vec::new();
        let mut titles: BTreeMap<WindowId, String> = BTreeMap::new();
        let mut memory = BTreeMap::new();
        let mut refreshed: Option<Instant> = None;
        let mut legend = true;
        if !macos::accessibility_granted() {
            eprintln!(
                "Note: Accessibility is not granted to this terminal: the window order is still \
                 logged, without titles."
            );
        }
        while started.elapsed() < duration {
            if refreshed.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                // The processes from the window server (no permission);
                // the titles through the Accessibility API, when granted.
                let snapshot = macos::snapshot(&wanted).map_err(|e| e.to_string())?;
                pids = snapshot
                    .names
                    .iter()
                    .filter(|(_, name)| wanted(name))
                    .map(|(pid, _)| *pid)
                    .collect();
                for w in macos::assemble(&snapshot, &mut memory) {
                    titles.insert(w.id, w.title);
                }
                refreshed = Some(Instant::now());
            }
            let cg = macos::cg_windows().map_err(|e| e.to_string())?;
            let front_to_back = macos::onscreen_order().unwrap_or_default();
            let ordinary: BTreeMap<u32, (bool, bool)> = cg
                .iter()
                .filter(|w| w.layer == 0)
                .map(|w| (w.id, (pids.binary_search(&w.pid).is_ok(), w.onscreen)))
                .collect();
            let mut looked: Vec<Ordered> = front_to_back
                .iter()
                .filter_map(|id| {
                    let (client, shown) = ordinary.get(id)?;
                    Some(Ordered {
                        id: WindowId(u64::from(*id)),
                        client: *client,
                        shown: *shown,
                    })
                })
                .collect();
            // The program's windows off screen are in no front-to-back list.
            looked.extend(
                ordinary
                    .iter()
                    .filter(|(id, (client, shown))| {
                        *client && !*shown && !front_to_back.contains(id)
                    })
                    .map(|(id, _)| Ordered {
                        id: WindowId(u64::from(*id)),
                        client: true,
                        shown: false,
                    }),
            );
            if std::mem::take(&mut legend) {
                // The program's windows at the start.
                for w in looked.iter().filter(|w| w.client) {
                    sink(SignalEvent {
                        since_start: started.elapsed(),
                        wall: SystemTime::now(),
                        window: Some(w.id),
                        signal: Signal::Present {
                            title: titles.get(&w.id).cloned().unwrap_or_default(),
                        },
                    });
                }
            }
            for (id, signal) in order.look(&looked, true) {
                let signal = match signal {
                    Signal::Appeared { .. } => Signal::Appeared {
                        title: titles.get(&id).cloned().unwrap_or_default(),
                    },
                    other => other,
                };
                sink(SignalEvent {
                    since_start: started.elapsed(),
                    wall: SystemTime::now(),
                    window: Some(id),
                    signal,
                });
            }
            std::thread::sleep(ORDER_EVERY);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(id: u64, client: bool, shown: bool) -> Ordered {
        Ordered {
            id: WindowId(id),
            client,
            shown,
        }
    }

    #[test]
    fn arguments() {
        let parse = |list: &[&str]| WatchArgs::parse(list.iter().map(OsString::from).collect());
        let args = parse(&[
            "--watch-signals",
            "--process",
            "PokerStars.exe",
            "--seconds",
            "60",
        ])
        .expect("args");
        assert_eq!((args.processes.len(), args.seconds), (1, 60));
        assert_eq!(
            parse(&["--process", "x"]).expect("default").seconds,
            DEFAULT_SECONDS
        );
        assert!(parse(&["--watch-signals"]).is_err(), "no process");
        assert!(parse(&["--process", "x", "--seconds", "0"]).is_err());
        assert!(parse(&["--process", "x", "--seconds", "soon"]).is_err());
        assert!(parse(&["--process", "x", "--frob"]).is_err());
        assert_eq!(parse(&["--help"]).err(), Some(String::new()));
    }

    /// The order diff: nothing on the first look; then a raise to the top
    /// of the desktop, the program's front window, appearing, closing and
    /// (macOS) going off screen.
    #[test]
    fn the_order_says_what_changed() {
        let mut watch = OrderWatch::default();
        // Another program's window on top; table 1 in front of table 2.
        assert!(
            watch
                .look(
                    &[w(9, false, true), w(1, true, true), w(2, true, true)],
                    true
                )
                .is_empty()
        );
        // Table 2 raised over everything.
        assert_eq!(
            watch.look(
                &[w(2, true, true), w(9, false, true), w(1, true, true)],
                true
            ),
            [
                (WindowId(2), Signal::FrontOfClient),
                (WindowId(2), Signal::TopOfDesktop)
            ]
        );
        // Table 1 to the top: table 2 leaves it.
        assert_eq!(
            watch.look(
                &[w(1, true, true), w(2, true, true), w(9, false, true)],
                true
            ),
            [
                (WindowId(1), Signal::FrontOfClient),
                (WindowId(2), Signal::LeftTop),
                (WindowId(1), Signal::TopOfDesktop)
            ]
        );
        // Another program on top again; a third table appears behind.
        assert_eq!(
            watch.look(
                &[
                    w(9, false, true),
                    w(1, true, true),
                    w(2, true, true),
                    w(3, true, true)
                ],
                true
            ),
            [
                (
                    WindowId(3),
                    Signal::Appeared {
                        title: String::new()
                    }
                ),
                (WindowId(1), Signal::LeftTop)
            ]
        );
        // Table 1 minimised (off screen), table 3 closed.
        assert_eq!(
            watch.look(
                &[w(9, false, true), w(2, true, true), w(1, true, false)],
                true
            ),
            [
                (WindowId(1), Signal::OffScreen),
                (WindowId(3), Signal::Closed),
                (WindowId(2), Signal::FrontOfClient)
            ]
        );
        // Windows reports minimise by its hook, not the order: only that
        // the window left the top.
        let mut quiet = OrderWatch::default();
        quiet.look(&[w(1, true, true)], false);
        assert_eq!(
            quiet.look(&[w(1, true, false)], false),
            [(WindowId(1), Signal::LeftTop)]
        );
    }

    #[test]
    fn lines_and_tally() {
        let event = SignalEvent {
            since_start: Duration::from_millis(12_345),
            wall: UNIX_EPOCH + Duration::from_millis(86_400_000 * 3 + 50_587_123),
            window: Some(WindowId(0x1a2b)),
            signal: Signal::Flash,
        };
        let redactor = Redactor::new(&["SecretMe".to_owned()]);
        assert_eq!(
            line(&event, &redactor),
            "+  12.345 s  14:03:07.123 UTC  window 0x1a2b  FLASH (HSHELL_FLASH: the taskbar \
             button flashes)"
        );
        let retitled = SignalEvent {
            signal: Signal::Retitled {
                title: "Hygiea - Logged In as SecretMe".to_owned(),
            },
            ..event.clone()
        };
        let text = line(&retitled, &redactor);
        assert!(text.ends_with("\"Hygiea - Logged In as <you>\""), "{text}");
        assert!(!text.contains("SecretMe"));
        let mut tally = Tally::default();
        tally.add(&event);
        tally.add(&event);
        tally.add(&retitled);
        assert_eq!(tally.count("FLASH"), 2);
        let summary = tally.render(60);
        assert!(summary.contains("FLASH: 2 (on 1 window(s))"), "{summary}");
        assert!(summary.contains("retitled: 1"), "{summary}");
        assert!(Tally::default().render(5).contains("none"));
        // The legend is printed, not counted.
        let present = SignalEvent {
            signal: Signal::Present {
                title: "Lobby".to_owned(),
            },
            ..event
        };
        assert!(line(&present, &redactor).ends_with("present (there at the start) \"Lobby\""));
        let mut legend = Tally::default();
        legend.add(&present);
        assert_eq!(legend, Tally::default());
    }

    #[test]
    fn shell_codes() {
        assert_eq!(hshell::FLASH, 0x8006);
        assert_eq!(hshell::RUDEAPPACTIVATED, 0x8004);
    }
}

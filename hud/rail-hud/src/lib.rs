// `deny`, not `forbid`: `platform::windows` lifts it for its Win32
// wrappers, one function at a time, each with a `// SAFETY:` comment.
// Every other module `forbid`s `unsafe` for itself.
#![deny(unsafe_code)]
//! The HUD overlay process (docs/RAIL-PLAN.md §3.2, Phase 3; guideline §7:
//! the HUD runs as a process of its own, so a stalled app never freezes the
//! overlays on live tables).
//!
//! The app starts it as a Tauri sidecar and supervises it
//! (`rail_hud_ipc::supervisor`): the token on standard input, the endpoint
//! in `--ipc`, the store in `--store`. Then:
//!
//! - [`engine`]: the loop - find tables, attach or refuse them, re-read and
//!   redraw on the app's messages, report;
//! - [`compliance`]: compliance mode, in this process;
//! - [`data`]: the store, read-only;
//! - [`platform`]: the windowing trait and its backends (Windows finds
//!   tables since R3.3, overlays and hooks are R3.4 / R3.5; macOS a stub
//!   until R3.11; [`platform::sim`] the fake driven by the table
//!   simulator);
//! - [`latency`]: `hand_imported` -> rollups re-read (R3.7: the whole
//!   chain, from the watcher to the frame, is the engine's: `table_updated`,
//!   `--latency-report`, a debug build's line on the table);
//! - [`list`]: `--list-windows`, the diagnostic that captures real table
//!   titles (redacted) for `sites.json`.
//!
//! No real-time assistance of any kind (guideline §7): the HUD shows the
//! players' own statistics from the store, nothing about the hand in play.

#![forbid(clippy::undocumented_unsafe_blocks)]

pub mod compliance;
pub mod data;
pub mod design;
pub mod engine;
pub mod latency;
pub mod layout;
pub mod list;
pub mod panel;
pub mod platform;
pub mod scene;
pub mod seats;

use std::ffi::OsString;
use std::io::BufRead as _;
use std::path::PathBuf;
use std::sync::mpsc;

use rail_hud_ipc::client::{connect_authenticated, read_token};
use rail_hud_ipc::link::{Incoming, Link};
use rail_hud_ipc::protocol::{AppMessage, HudMessage};

use crate::compliance::Compliance;
use crate::data::StoreView;
use crate::engine::{Exit, Hud, Input, Settings};
use crate::platform::Platform;

/// Exit codes the supervisor's log shows.
pub mod exit_code {
    /// Shut down by the app, or the app is gone.
    pub const OK: i32 = 0;
    /// Bad arguments.
    pub const USAGE: i32 = 2;
    /// Could not join the app (no token, no endpoint, the handshake).
    pub const NO_APP: i32 = 3;
    /// The connection to the app broke.
    pub const LINK_LOST: i32 = 4;
    /// The shipped configuration did not load (a broken build).
    pub const CONFIG: i32 = 5;
}

const USAGE: &str = "\
rail-hud: Rail's HUD process. Started by the app, which writes a token on
standard input:

  rail-hud --store <rail.db> --ipc <endpoint>

For development, without the app:

  rail-hud --standalone [--store <rail.db>] ...

Measuring (R3.7): --latency-report <file> writes every hand's latency chain
(the watcher noticing the file -> the frame), one JSON object a line.

Windows:
  --platform native     this system's backend (default)
    the table simulator's real windows as a room's (tests only):
    --sim-site <id>       the sites.json room they pose as
    --sim-title <regex>   their titles (rail-hud-sim --title-regex)
  --platform sim        the table simulator's windows, from its events:
    --sim-events <file>   the simulator's standard output, as it is written
    --sim-site <id>       the sites.json room its tables pose as

Capturing real table titles (redacted; see --list-windows --help):

  rail-hud --list-windows [--process <exe>] [--you <name>] ...
";

/// The command line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Args {
    pub store: Option<PathBuf>,
    pub ipc: Option<String>,
    pub standalone: bool,
    pub sim_events: Option<PathBuf>,
    pub sim_site: Option<String>,
    /// The simulator's title regex for the native backend (a test-only
    /// room entry, [`Hud::add_simulator_room`]); checked to compile.
    pub sim_title: Option<String>,
    /// (R3.7) `--latency-report <file>`: every hand's latency chain.
    pub latency_report: Option<PathBuf>,
}

impl Args {
    pub fn parse(args: Vec<OsString>) -> Result<Self, String> {
        let mut parsed = Self::default();
        let mut platform = "native".to_owned();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            let arg = arg.to_string_lossy().into_owned();
            let mut value = |name: &str| {
                iter.next()
                    .ok_or_else(|| format!("{name} needs a value"))
                    .map(|v| v.to_string_lossy().into_owned())
            };
            match arg.as_str() {
                "--store" => parsed.store = Some(PathBuf::from(value("--store")?)),
                rail_hud_ipc::ENDPOINT_ARG => {
                    parsed.ipc = Some(value(rail_hud_ipc::ENDPOINT_ARG)?);
                }
                "--standalone" => parsed.standalone = true,
                "--platform" => platform = value("--platform")?,
                "--sim-events" => parsed.sim_events = Some(PathBuf::from(value("--sim-events")?)),
                "--sim-site" => parsed.sim_site = Some(value("--sim-site")?),
                "--latency-report" => {
                    parsed.latency_report = Some(PathBuf::from(value("--latency-report")?));
                }
                "--sim-title" => {
                    let title = value("--sim-title")?;
                    regex::Regex::new(&title)
                        .map_err(|e| format!("--sim-title does not compile: {e}"))?;
                    parsed.sim_title = Some(title);
                }
                "--help" | "-h" => return Err(String::new()),
                other => return Err(format!("unknown argument {other}")),
            }
        }
        match platform.as_str() {
            "native" => {
                if parsed.sim_events.is_some() {
                    return Err("--sim-events goes with --platform sim".to_owned());
                }
                // The test-only room entry: the app never passes it; the
                // tests that play the app do (R3.6: a drag reaches the
                // store through the IPC). It takes the simulator's process
                // only, so it cannot help a real client past compliance.
                if parsed.sim_site.is_some() != parsed.sim_title.is_some() {
                    return Err(
                        "the simulator's windows need --sim-site and --sim-title".to_owned()
                    );
                }
            }
            "sim" => {
                if parsed.sim_events.is_none() || parsed.sim_site.is_none() {
                    return Err("--platform sim needs --sim-events and --sim-site".to_owned());
                }
                if parsed.sim_title.is_some() {
                    return Err("--sim-title goes with --platform native".to_owned());
                }
            }
            other => return Err(format!("no platform {other}")),
        }
        if parsed.standalone == parsed.ipc.is_some() {
            return Err(format!(
                "either {} (started by the app) or --standalone",
                rail_hud_ipc::ENDPOINT_ARG
            ));
        }
        Ok(parsed)
    }

    fn platform(&self) -> std::io::Result<Box<dyn Platform>> {
        Ok(match (&self.sim_events, &self.sim_site) {
            (Some(events), Some(site)) => Box::new(platform::sim::SimBackend::tail(
                events.clone(),
                site.clone(),
            )?),
            _ => {
                // Physical pixels from every window API, before any window
                // exists (R3.3); a no-op off Windows.
                if let Err(error) = platform::windows::init_process_dpi_awareness() {
                    eprintln!("rail-hud: DPI awareness: {error}");
                }
                platform::native()
            }
        })
    }
}

/// The process: returns its exit code.
pub fn main_with(args: Vec<OsString>) -> i32 {
    if args.iter().any(|a| a == "--list-windows") {
        return list::run(args);
    }
    let args = match Args::parse(args) {
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
    let compliance = match Compliance::shipped() {
        Ok(compliance) => compliance,
        Err(error) => {
            eprintln!("rail-hud: {error}");
            return exit_code::CONFIG;
        }
    };
    let platform = match args.platform() {
        Ok(platform) => platform,
        Err(error) => {
            eprintln!("rail-hud: {error}");
            return exit_code::USAGE;
        }
    };
    let (tx, rx) = mpsc::channel::<Input>();

    // Joined to the app: the token from standard input, then the rest of
    // standard input watched for its end (the app is gone, crashed or not).
    let link = match &args.ipc {
        None => None,
        Some(endpoint) => {
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            let token = match read_token(&mut input) {
                Ok(token) => token,
                Err(error) => {
                    eprintln!("rail-hud: {error}");
                    return exit_code::NO_APP;
                }
            };
            drop(input);
            let gone = tx.clone();
            let watcher = std::thread::Builder::new()
                .name("rail-hud-stdin".to_owned())
                .spawn(move || {
                    let mut sink = String::new();
                    let mut stdin = std::io::stdin().lock();
                    while matches!(stdin.read_line(&mut sink), Ok(n) if n > 0) {
                        sink.clear();
                    }
                    let _ = gone.send(Input::AppGone);
                });
            if let Err(error) = watcher {
                eprintln!("rail-hud: {error}");
                return exit_code::NO_APP;
            }
            let conn = match connect_authenticated(endpoint, &token) {
                Ok(conn) => conn,
                Err(error) => {
                    eprintln!("rail-hud: could not join the app: {error}");
                    return exit_code::NO_APP;
                }
            };
            let incoming = tx.clone();
            let link = Link::<HudMessage>::start(
                conn,
                "rail-hud-app",
                1024,
                None,
                move |message: Incoming<AppMessage>| {
                    let _ = incoming.send(match message {
                        Incoming::Message(message, at) => Input::App(message, at),
                        Incoming::Closed(reason) => Input::AppClosed(reason),
                    });
                },
            );
            match link {
                Ok(link) => Some(link),
                Err(error) => {
                    eprintln!("rail-hud: {error}");
                    return exit_code::NO_APP;
                }
            }
        }
    };

    let mut hud = Hud::new(
        platform,
        compliance,
        StoreView::new(args.store.clone()),
        Settings::default(),
    );
    if let Some(path) = &args.latency_report {
        match std::fs::File::create(path) {
            Ok(file) => hud.set_latency_report(Box::new(std::io::BufWriter::new(file))),
            Err(error) => {
                eprintln!("rail-hud: --latency-report {}: {error}", path.display());
                return exit_code::USAGE;
            }
        }
    }
    if let (None, Some(site), Some(title)) = (&args.sim_events, &args.sim_site, &args.sim_title) {
        match regex::Regex::new(title) {
            Ok(title) => {
                eprintln!("rail-hud: the simulator's windows pose as {site} (test-only room)");
                hud.add_simulator_room(site, title);
            }
            Err(error) => {
                eprintln!("rail-hud: --sim-title: {error}");
                return exit_code::USAGE;
            }
        }
    }
    eprintln!(
        "rail-hud: running (pid {}, {}, store {})",
        std::process::id(),
        hud.health().platform,
        args.store
            .as_ref()
            .map_or_else(|| "none".to_owned(), |p| p.display().to_string())
    );
    let mut out = |message: HudMessage| match &link {
        Some(link) => {
            link.send(message);
        }
        None => eprintln!(
            "rail-hud: -> {}",
            serde_json::to_string(&message).unwrap_or_default()
        ),
    };
    // Keeps the loop's channel open in standalone mode (nothing else
    // sends then).
    let _keep = tx;
    let exit = hud.run(&rx, &mut out);
    eprintln!("rail-hud: exiting ({exit:?})");
    match exit {
        Exit::Shutdown | Exit::AppGone => exit_code::OK,
        Exit::AppClosed(_) => exit_code::LINK_LOST,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, String> {
        Args::parse(args.iter().map(OsString::from).collect())
    }

    #[test]
    fn arguments() {
        let args = parse(&["--store", "/x/rail.db", "--ipc", "/t/hud.sock"]).expect("app");
        assert_eq!(args.store, Some(PathBuf::from("/x/rail.db")));
        assert_eq!(args.ipc.as_deref(), Some("/t/hud.sock"));
        let args = parse(&[
            "--standalone",
            "--platform",
            "sim",
            "--sim-events",
            "e.jsonl",
            "--sim-site",
            "pokerstars",
        ])
        .expect("sim");
        assert_eq!(args.sim_site.as_deref(), Some("pokerstars"));
        assert!(parse(&[]).is_err(), "neither --ipc nor --standalone");
        assert!(parse(&["--standalone", "--ipc", "x"]).is_err());
        assert!(parse(&["--standalone", "--platform", "sim"]).is_err());
        assert!(parse(&["--standalone", "--sim-site", "x"]).is_err());
        assert!(parse(&["--standalone", "--platform", "x11"]).is_err());
        assert!(parse(&["--standalone", "--store"]).is_err());
        assert!(parse(&["--frobnicate"]).is_err());
        let args = parse(&["--standalone", "--latency-report", "/t/chain.jsonl"]).expect("report");
        assert_eq!(args.latency_report, Some(PathBuf::from("/t/chain.jsonl")));
        assert!(parse(&["--standalone", "--latency-report"]).is_err());
        assert_eq!(parse(&["--help"]), Err(String::new()));

        // The simulator's real windows (native backend, test-only room):
        // both flags, a regex that compiles; with the app's channel too
        // (R3.6's tests play the app).
        let args = parse(&[
            "--standalone",
            "--sim-site",
            "pokerstars",
            "--sim-title",
            "^(?P<table>.+?) - ",
        ])
        .expect("native sim");
        assert_eq!(args.sim_title.as_deref(), Some("^(?P<table>.+?) - "));
        assert!(parse(&["--standalone", "--sim-title", "^x"]).is_err());
        assert!(parse(&["--standalone", "--sim-site", "a", "--sim-title", "(x"]).is_err());
        let args = parse(&["--ipc", "p", "--sim-site", "a", "--sim-title", "^x"]).expect("ipc");
        assert_eq!(args.sim_site.as_deref(), Some("a"));
        assert!(parse(&["--ipc", "p", "--sim-title", "^x"]).is_err());
        assert!(
            parse(&[
                "--standalone",
                "--platform",
                "sim",
                "--sim-events",
                "e",
                "--sim-site",
                "a",
                "--sim-title",
                "^x"
            ])
            .is_err()
        );
    }
}

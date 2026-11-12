//! (T6, docs/research/TABLE-TILING.md §5) `rail-hud --tile-check`: the
//! one-shot placement check the owner runs on a real client before its
//! `sites.json` entry is written. It finds one program's table windows,
//! tiles them **once** with the real tiling engine ([`crate::tiling`]) and
//! the backend's own `place` - the code the HUD tiles with -, reads the
//! rects back and prints, per window, what was asked and what the client
//! accepted: the aspect ratio kept or not, how long each move took, a
//! size the client refused. Then it exits. `--restore` puts the windows
//! back where they were (the first run saves them to a small file).
//!
//! **Compliance first.** Nothing here can move a window that the HUD's
//! tiling could not:
//!
//! - every window found is admitted only with its room's
//!   [`TilingPermit`] - the room of its `tables` block, or, for a room with
//!   no block yet, the one named with `--room` (its windows taken by a
//!   candidate `--try-title` regex). A room whose `tiling.allowed` is
//!   `false` (GGPoker, partypoker, Unibet, Winamax, ...) or `null` gives
//!   no permit, so its windows are listed and **never moved**;
//! - `--room` itself must have the permit, or the check refuses to start;
//! - a window whose program's name looks like a room whose tiling is not
//!   permitted ([`lookalike`]: `GGnet.exe`, `Winamax.exe`, ...) is never
//!   moved, whatever `--room` says, so a regex tried under the wrong room
//!   cannot move it either;
//! - the mouse safety rule holds: no window moves while a button is down
//!   or within [`crate::placer::QUIET_AFTER_CLICK`] of a click.
//!
//! It reads nothing inside a window (no pixels, no capture): titles, rects
//! and the monitors, as the HUD does. The report is platform-free
//! ([`Report`]) and unit-tested; the sim backend runs the whole check in
//! the tests.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::compliance::{Compliance, TilingPermit};
use crate::exit_code;
use crate::list::{redaction_names, verdict};
use crate::placer::{QuietGuard, SAMPLE_EVERY};
use crate::platform::matcher::same_process;
use crate::platform::{
    Insets, Monitor, Placer, Platform, PlatformError, Rect, Redactor, TableMatcher, TableWindow,
    WindowId,
};
use crate::tiling::{AUTO_LAYOUT, Aspect, Layout, Mouse, Observed, Options, Tiler};

pub const USAGE: &str = "\
rail-hud --tile-check: tile one program's table windows ONCE with Rail's
tiling engine, read them back, print what each client accepted, and exit
(docs/research/REAL-CLIENT-CHECK.md, tiling).

  rail-hud --tile-check --process <exe> [--room <id> --try-title <regex>]
                        [--layout auto|<layout.json>] [--state <file>]
                        [--you <name>]... [--store <rail.db> | --no-store]
  rail-hud --tile-check --restore [--state <file>]

  --process <exe>      the program whose tables are tiled (repeat for more)
  --room <id>          the sites.json room the program is, for a room that
                       has no `tables` block yet (pokerstars, acr,
                       wpt-global, coinpoker); its tiling policy must be
                       true
  --try-title <regex>  a candidate title regex with a `table` group: the
                       windows it takes are the room's tables
  --layout <file>      a layout (the app's JSON: id, name, slots) instead
                       of the auto grid
  --state <file>       where the windows' places before the check are kept
                       for --restore (default: the system's temp folder)
  --restore            put the windows of the last check back

Never moves a window of a room whose tiling policy is false or unknown
(GGPoker, partypoker, Unibet, Winamax, ...): those are listed, untouched.
Nothing moves while a mouse button is down. Titles are redacted as in
--list-windows; read the output before you share it.
";

/// How long the check waits for the mouse to be quiet before a placement.
pub const MOUSE_WAIT: Duration = Duration::from_secs(15);

/// Placement rounds: the tiler's moves, then its one retry of a refused
/// size, then nothing (a third round is a safety margin, never a loop).
const ROUNDS: usize = 3;

/// The state file's name in the temp folder.
pub const STATE_FILE: &str = "rail-hud-tile-check.json";

/// The layout the check tiles with.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum LayoutChoice {
    #[default]
    Auto,
    File(PathBuf),
}

/// The command line after `--tile-check`.
#[derive(Debug, Default)]
pub struct CheckArgs {
    pub processes: Vec<String>,
    pub room: Option<String>,
    /// The candidate regex and its source (kept for `--restore`).
    pub try_title: Option<(Regex, String)>,
    pub layout: LayoutChoice,
    pub state: Option<PathBuf>,
    pub restore: bool,
    pub you: Vec<String>,
    pub store: Option<PathBuf>,
    pub no_store: bool,
}

impl CheckArgs {
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
                "--tile-check" => {}
                "--process" => parsed.processes.push(value("--process")?),
                "--room" => parsed.room = Some(value("--room")?),
                "--try-title" => {
                    let source = value("--try-title")?;
                    let regex = Regex::new(&source)
                        .map_err(|e| format!("--try-title does not compile: {e}"))?;
                    parsed.try_title = Some((regex, source));
                }
                "--layout" => {
                    parsed.layout = match value("--layout")?.as_str() {
                        "auto" => LayoutChoice::Auto,
                        path => LayoutChoice::File(PathBuf::from(path)),
                    };
                }
                "--state" => parsed.state = Some(PathBuf::from(value("--state")?)),
                "--restore" => parsed.restore = true,
                "--you" => parsed.you.push(value("--you")?),
                "--store" => parsed.store = Some(PathBuf::from(value("--store")?)),
                "--no-store" => parsed.no_store = true,
                "--help" | "-h" => return Err(String::new()),
                other => return Err(format!("unknown argument {other} for --tile-check")),
            }
        }
        if parsed.restore {
            if !parsed.processes.is_empty() || parsed.try_title.is_some() || parsed.room.is_some() {
                return Err("--restore takes the windows from the state file only".to_owned());
            }
            return Ok(parsed);
        }
        if parsed.processes.is_empty() {
            return Err("--tile-check needs --process <exe>".to_owned());
        }
        if parsed.try_title.is_some() != parsed.room.is_some() {
            return Err(
                "--try-title and --room go together: the room whose policy decides".to_owned(),
            );
        }
        if parsed.no_store && parsed.store.is_some() {
            return Err("--store and --no-store".to_owned());
        }
        Ok(parsed)
    }

    /// The state file.
    pub fn state_path(&self) -> PathBuf {
        self.state
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join(STATE_FILE))
    }
}

// ---------------------------------------------------------------------
// Compliance: which windows may move.

/// Other names a refused room's programs are known or likely to carry
/// (skins, networks): [`lookalike`] refuses them too. Only ever refuses.
const ALIASES: &[(&str, &[&str])] = &[
    ("ggpoker", &["ggnet", "natural8"]),
    ("ignition", &["bodog", "bovada"]),
    ("partypoker", &["partygaming"]),
];

/// A name as [`lookalike`] compares it: lower case, letters and digits.
fn squash(name: &str) -> String {
    let name = name.trim();
    let name = name
        .len()
        .checked_sub(4)
        .filter(|&n| name.is_char_boundary(n) && name[n..].eq_ignore_ascii_case(".exe"))
        .map_or(name, |n| &name[..n]);
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The room whose tiling is **not** permitted that the program `process`
/// looks like - its `sites.json` id (or a known alias) in the program's
/// name, without case or punctuation: `GGnet.exe` is GGPoker's,
/// `Winamax.exe` Winamax's. `None`: it looks like no such room. A belt
/// and braces next to the policy, for a regex tried under the wrong
/// `--room`: it can only refuse.
pub fn lookalike(compliance: &Compliance, process: &str) -> Option<String> {
    let name = squash(process);
    compliance
        .config()
        .sites
        .iter()
        .filter(|site| compliance.tiling_permit(&site.id).is_err())
        .find(|site| {
            let aliases = ALIASES
                .iter()
                .find(|(id, _)| *id == site.id)
                .map_or(&[][..], |(_, names)| names);
            std::iter::once(squash(&site.id))
                .chain(aliases.iter().map(|a| squash(a)))
                .any(|token| token.len() >= 4 && name.contains(&token))
        })
        .map(|site| site.id.clone())
}

/// Whether window `window` may be moved: its room's [`TilingPermit`], and a
/// program that looks like no refused room; else why not.
pub fn admit(compliance: &Compliance, window: &TableWindow) -> Result<TilingPermit, String> {
    if let Some(room) = lookalike(compliance, &window.process.name)
        && room != window.site
    {
        return Err(format!(
            "its program {} looks like {room}'s, whose tiling is {}",
            window.process.name,
            verdict(compliance.tiling_permit(&room).map(|_| ()))
        ));
    }
    compliance
        .tiling_permit(&window.site)
        .map_err(|reason| format!("{}: tiling {}", window.site, verdict(Err(reason))))
}

/// The room named with `--room` must permit tiling, or nothing starts.
pub fn admit_room(compliance: &Compliance, room: &str) -> Result<(), String> {
    compliance
        .tiling_permit(room)
        .map(|_| ())
        .map_err(|reason| {
            format!(
                "{room}: tiling {} - the check moves nothing for it",
                verdict(Err(reason))
            )
        })
}

/// The matchers the check finds windows with: the rooms' `tables` blocks,
/// then the candidate regex as `room`'s for `processes` (a block wins).
pub fn matchers(
    compliance: &Compliance,
    processes: &[String],
    candidate: Option<(&str, &Regex)>,
) -> Vec<TableMatcher> {
    let mut out = compliance.matchers();
    if let Some((room, title)) = candidate {
        out.push(TableMatcher {
            site: room.to_owned(),
            processes: processes.to_vec(),
            title: title.clone(),
        });
    }
    out
}

// ---------------------------------------------------------------------
// The check.

/// What the check is asked to do.
#[derive(Debug, Clone)]
pub struct Request {
    pub processes: Vec<String>,
    /// `--room`, with the candidate regex.
    pub candidate: Option<(String, Regex)>,
    /// The tiler's options: the auto grid, or one layout in force.
    pub options: Options,
    /// How long to wait for a quiet mouse before giving up on a placement.
    pub mouse_wait: Duration,
}

/// One placement carried out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attempt {
    /// The client area asked for, and the outer rect around it.
    pub want: Rect,
    pub outer: Rect,
    /// The client area the system read back, or why it was not moved.
    pub result: Result<Rect, PlatformError>,
    pub took: Duration,
}

impl Attempt {
    /// The client kept another size than asked (more than a pixel off).
    pub fn refused_size(&self) -> bool {
        self.result.as_ref().is_ok_and(|got| {
            got.width.abs_diff(self.want.width) > 1 || got.height.abs_diff(self.want.height) > 1
        })
    }
}

/// One window the check tiled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub id: WindowId,
    pub site: String,
    pub process: String,
    pub title: String,
    pub before: Rect,
    pub minimized: bool,
    pub insets: Option<Insets>,
    /// The slot it was given: its index, the monitor's, its cell.
    pub slot: Option<(usize, usize, Rect)>,
    pub attempts: Vec<Attempt>,
    /// The client area read back after every placement.
    pub after: Option<Rect>,
    /// Why it was not placed, when it was not.
    pub skipped: Option<String>,
}

impl Checked {
    /// The last client area the client accepted.
    pub fn accepted(&self) -> Option<Rect> {
        self.attempts
            .iter()
            .rev()
            .find_map(|a| a.result.as_ref().ok().copied())
    }

    /// The aspect ratio it had before, and whether its final size keeps it.
    pub fn aspect(&self) -> Option<(Aspect, bool)> {
        let before = Aspect::of(self.before.width, self.before.height)?;
        let now = self.after.or_else(|| self.accepted())?;
        Some((before, before.holds(now.width, now.height)))
    }
}

/// A window found and left alone: its room's policy, or its program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub id: WindowId,
    pub site: String,
    pub process: String,
    pub title: String,
    pub reason: String,
}

/// What the check did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub processes: Vec<String>,
    pub layout: String,
    pub monitors: Vec<Monitor>,
    pub checked: Vec<Checked>,
    pub refused: Vec<Refused>,
    pub notes: Vec<String>,
}

/// The tally at the end.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Summary {
    pub placed: usize,
    pub as_requested: usize,
    pub refused_size: usize,
    pub failed: usize,
    pub skipped: usize,
    pub aspect_kept: usize,
    pub aspect_known: usize,
    pub slowest: Duration,
    pub never_moved: usize,
}

/// A rect as `WxH at (x, y)`.
pub fn rect_text(r: &Rect) -> String {
    format!("{}x{} at ({}, {})", r.width, r.height, r.x, r.y)
}

/// A duration in whole milliseconds.
fn ms(d: Duration) -> u128 {
    d.as_millis()
}

impl Report {
    pub fn summary(&self) -> Summary {
        let mut s = Summary {
            never_moved: self.refused.len(),
            ..Summary::default()
        };
        for c in &self.checked {
            if c.skipped.is_some() {
                s.skipped += 1;
            }
            let Some(first) = c.attempts.first() else {
                continue;
            };
            match &first.result {
                Ok(_) => s.placed += 1,
                Err(_) => s.failed += 1,
            }
            if first.result.is_ok() && !first.refused_size() {
                s.as_requested += 1;
            }
            if first.refused_size() {
                s.refused_size += 1;
            }
            for a in &c.attempts {
                s.slowest = s.slowest.max(a.took);
            }
            if let Some((_, kept)) = c.aspect() {
                s.aspect_known += 1;
                s.aspect_kept += usize::from(kept);
            }
        }
        s
    }

    /// The report as printed; titles through `redactor`.
    pub fn render(&self, redactor: &Redactor) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "rail-hud --tile-check: {} window(s) to tile of {}; layout {}; {} monitor(s)",
            self.checked.len(),
            self.processes.join(", "),
            self.layout,
            self.monitors.len()
        );
        let _ = writeln!(
            out,
            "Titles are redacted ({} name(s) -> {}). Read every line before you share it.",
            redactor.names(),
            crate::platform::matcher::YOU
        );
        for note in &self.notes {
            let _ = writeln!(out, "Note: {note}.");
        }
        for (i, m) in self.monitors.iter().enumerate() {
            let _ = writeln!(
                out,
                "monitor {i}: {}, work area {}, {}%{}",
                rect_text(&m.bounds),
                rect_text(&m.work_area),
                m.scale_permille / 10,
                if m.primary { " (primary)" } else { "" }
            );
        }
        if !self.refused.is_empty() {
            out.push_str("\nNever moved:\n");
            for r in &self.refused {
                let _ = writeln!(
                    out,
                    "  window {:#x} of {} {:?}: {}",
                    r.id.0,
                    r.process,
                    redactor.redact(&r.title),
                    r.reason
                );
            }
        }
        for c in &self.checked {
            out.push('\n');
            let _ = writeln!(
                out,
                "window {:#x} ({}, {}) {:?}",
                c.id.0,
                c.site,
                c.process,
                redactor.redact(&c.title)
            );
            let insets = c.insets.map_or_else(
                || "frame not measured".to_owned(),
                |i| {
                    format!(
                        "frame left {}, top {}, right {}, bottom {}",
                        i.left, i.top, i.right, i.bottom
                    )
                },
            );
            if c.minimized {
                let _ = writeln!(out, "  before:    minimised; {insets}");
            } else {
                let _ = writeln!(
                    out,
                    "  before:    client {}; {insets}",
                    rect_text(&c.before)
                );
            }
            if let Some((slot, monitor, cell)) = c.slot {
                let _ = writeln!(
                    out,
                    "  slot:      {slot} on monitor {monitor}, cell {}",
                    rect_text(&cell)
                );
            }
            for (n, a) in c.attempts.iter().enumerate() {
                let label = if n == 0 { "requested" } else { "retry" };
                let _ = writeln!(
                    out,
                    "  {label}:{} client {} (outer {})",
                    if n == 0 { "" } else { "    " },
                    rect_text(&a.want),
                    rect_text(&a.outer)
                );
                let answer = match &a.result {
                    Ok(got) if a.refused_size() => format!(
                        "client {} - SIZE REFUSED: wanted {}x{}, kept {}x{}",
                        rect_text(got),
                        a.want.width,
                        a.want.height,
                        got.width,
                        got.height
                    ),
                    Ok(got) if got.x != a.want.x || got.y != a.want.y => format!(
                        "client {} - size as asked, placed {} px right, {} px down of it",
                        rect_text(got),
                        i64::from(got.x) - i64::from(a.want.x),
                        i64::from(got.y) - i64::from(a.want.y)
                    ),
                    Ok(got) => format!("client {} - as requested", rect_text(got)),
                    Err(error) => format!("FAILED: {error}"),
                };
                let _ = writeln!(out, "  accepted:  {answer}; {} ms", ms(a.took));
            }
            if let Some(after) = c.after {
                let _ = writeln!(out, "  read back: client {}", rect_text(&after));
            }
            if let Some((aspect, kept)) = c.aspect() {
                let now = c.after.or_else(|| c.accepted()).unwrap_or_default();
                let _ = writeln!(
                    out,
                    "  aspect:    {}:{} before ({} per mille), {} per mille now - {}",
                    aspect.width,
                    aspect.height,
                    per_mille(c.before.width, c.before.height),
                    per_mille(now.width, now.height),
                    if kept { "kept" } else { "CHANGED" }
                );
            }
            if let Some(why) = &c.skipped {
                let _ = writeln!(out, "  skipped:   {why}");
            }
        }
        let s = self.summary();
        let _ = writeln!(
            out,
            "\nSummary: {} placed ({} as requested, {} refused a size), {} failed, {} skipped, \
             {} never moved; aspect kept on {} of {}; slowest move {} ms.",
            s.placed,
            s.as_requested,
            s.refused_size,
            s.failed,
            s.skipped,
            s.never_moved,
            s.aspect_kept,
            s.aspect_known,
            ms(s.slowest)
        );
        out
    }
}

/// Width over height in thousandths (no floating point).
fn per_mille(width: u32, height: u32) -> u64 {
    if height == 0 {
        0
    } else {
        u64::from(width) * 1000 / u64::from(height)
    }
}

/// Wait until the mouse is quiet (no button down, no click in the last
/// [`crate::placer::QUIET_AFTER_CLICK`]), at most `limit`; whether it is.
/// Without a placer (no way to read the mouse) it never is: nothing moves.
fn wait_quiet(
    placer: Option<&mut Box<dyn Placer>>,
    guard: &mut QuietGuard,
    limit: Duration,
) -> bool {
    let Some(placer) = placer else {
        return false;
    };
    let deadline = Instant::now() + limit;
    loop {
        let now = Instant::now();
        guard.note(now, placer.mouse());
        if guard.quiet(now) {
            return true;
        }
        if now >= deadline {
            return false;
        }
        std::thread::sleep(SAMPLE_EVERY);
    }
}

/// The table windows of `processes` the matchers find now.
fn found(
    platform: &mut dyn Platform,
    matchers: &[TableMatcher],
    processes: &[String],
) -> Result<Vec<TableWindow>, String> {
    let all = platform
        .find_tables(matchers)
        .map_err(|e| format!("finding the windows: {e}"))?;
    Ok(all
        .into_iter()
        .filter(|t| processes.iter().any(|p| same_process(p, &t.process.name)))
        .collect())
}

/// The windows' places before the check, for `--restore`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedState {
    /// The backend that moved them (`windows`, `macos`, `sim`).
    pub platform: String,
    pub processes: Vec<String>,
    pub room: Option<String>,
    pub try_title: Option<String>,
    pub windows: Vec<SavedWindow>,
}

/// One window's place before the check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWindow {
    pub id: u64,
    pub site: String,
    pub process: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub minimized: bool,
}

impl SavedWindow {
    fn client(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

/// Tile the windows of `request.processes` once on `platform`: the
/// report, and the windows' places before it (only those that were
/// moved). An `Err`: nothing was moved (a refused room, no window, no
/// monitor).
pub fn check(
    platform: &mut dyn Platform,
    compliance: &Compliance,
    request: &Request,
) -> Result<(Report, SavedState), String> {
    if let Some((room, _)) = &request.candidate {
        admit_room(compliance, room)?;
    }
    let matchers = matchers(
        compliance,
        &request.processes,
        request
            .candidate
            .as_ref()
            .map(|(room, title)| (room.as_str(), title)),
    );
    let windows = found(platform, &matchers, &request.processes)?;
    if windows.is_empty() {
        return Err(format!(
            "no table window of {} was found: {}",
            request.processes.join(", "),
            if request.candidate.is_some() {
                "does --try-title match the tables' titles (--list-windows --try-title)?"
            } else {
                "the room has no `tables` block yet - give --room and --try-title"
            }
        ));
    }
    let mut report = Report {
        processes: request.processes.clone(),
        layout: request.options.active.clone(),
        ..Report::default()
    };
    let mut admitted = Vec::new();
    for window in windows {
        match admit(compliance, &window) {
            Ok(_permit) => admitted.push(window),
            Err(reason) => report.refused.push(Refused {
                id: window.id,
                site: window.site.clone(),
                process: window.process.name.clone(),
                title: window.title.clone(),
                reason,
            }),
        }
    }
    report.monitors = platform.monitors();
    if report.monitors.is_empty() {
        return Err("the system reported no monitor: nothing was moved".to_owned());
    }
    if admitted.is_empty() {
        return Ok((
            report,
            saved(
                platform.name(),
                request,
                &[],
                &std::collections::BTreeSet::new(),
            ),
        ));
    }

    let mut tiler = Tiler::new(request.options.clone());
    tiler.set_monitors(report.monitors.clone());
    let observed: Vec<Observed> = admitted
        .iter()
        .map(|t| Observed {
            id: t.id,
            site: t.site.clone(),
            client: t.client,
            scale_permille: t.scale_permille,
            minimized: t.minimized,
            insets: platform.frame_insets(t),
        })
        .collect();
    tiler.sync(&observed, Instant::now(), Mouse::Idle);
    report.checked = admitted
        .iter()
        .zip(&observed)
        .map(|(t, o)| Checked {
            id: t.id,
            site: t.site.clone(),
            process: t.process.name.clone(),
            title: t.title.clone(),
            before: t.client,
            minimized: t.minimized,
            insets: o.insets,
            slot: tiler.slot_of(t.id).and_then(|s| {
                tiler
                    .slots()
                    .get(s)
                    .map(|slot| (s, slot.monitor, slot.cell))
            }),
            attempts: Vec::new(),
            after: None,
            skipped: None,
        })
        .collect();

    let mut placer = platform.placer();
    let mut guard = QuietGuard::default();
    let mut moved = std::collections::BTreeSet::new();
    'rounds: for _ in 0..ROUNDS {
        let moves = tiler.plan();
        if moves.is_empty() {
            break;
        }
        for m in moves {
            if !wait_quiet(placer.as_mut(), &mut guard, request.mouse_wait) {
                let why = if placer.is_none() {
                    "the mouse cannot be read here, so nothing moves".to_owned()
                } else {
                    format!(
                        "a mouse button was down or just clicked for {} s: stopped",
                        request.mouse_wait.as_secs()
                    )
                };
                for c in report.checked.iter_mut().filter(|c| c.attempts.is_empty()) {
                    c.skipped = Some(why.clone());
                }
                report.notes.push(why);
                break 'rounds;
            }
            let started = Instant::now();
            let result = platform.place(m.id, m.want);
            let took = started.elapsed();
            tiler.placed(m.id, m.seq, &result, Instant::now());
            if result.is_ok() {
                moved.insert(m.id);
            }
            if let Some(c) = report.checked.iter_mut().find(|c| c.id == m.id) {
                c.attempts.push(Attempt {
                    want: m.want,
                    outer: m.outer,
                    result,
                    took,
                });
            }
        }
    }
    // Read back after every placement: where the clients are now.
    if let Ok(now) = found(platform, &matchers, &request.processes) {
        for c in &mut report.checked {
            c.after = now.iter().find(|t| t.id == c.id).map(|t| t.client);
        }
    }
    for c in report
        .checked
        .iter_mut()
        .filter(|c| c.attempts.is_empty() && c.skipped.is_none())
    {
        c.skipped = Some(if c.minimized {
            "minimised: the tiler places a table once it is restored".to_owned()
        } else {
            "the tiler gave it no placement (stacked, or already in place)".to_owned()
        });
    }
    let before: Vec<&TableWindow> = admitted.iter().collect();
    let state = saved(platform.name(), request, &before, &moved);
    Ok((report, state))
}

/// The state to save: the windows that moved, as they were.
fn saved(
    platform: &str,
    request: &Request,
    windows: &[&TableWindow],
    moved: &std::collections::BTreeSet<WindowId>,
) -> SavedState {
    SavedState {
        platform: platform.to_owned(),
        processes: request.processes.clone(),
        room: request.candidate.as_ref().map(|(room, _)| room.clone()),
        try_title: request
            .candidate
            .as_ref()
            .map(|(_, title)| title.as_str().to_owned()),
        windows: windows
            .iter()
            .filter(|t| moved.contains(&t.id))
            .map(|t| SavedWindow {
                id: t.id.0,
                site: t.site.clone(),
                process: t.process.name.clone(),
                x: t.client.x,
                y: t.client.y,
                width: t.client.width,
                height: t.client.height,
                minimized: t.minimized,
            })
            .collect(),
    }
}

/// What `--restore` did, one line per saved window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreReport {
    pub lines: Vec<String>,
    pub restored: usize,
}

/// Put the windows of `state` back where they were: each one still there
/// (the same id and program, its room still permitted) is placed at its
/// old client area. A window that was minimised is left restored (there is
/// no minimise call; minimise it by hand).
pub fn restore(
    platform: &mut dyn Platform,
    compliance: &Compliance,
    state: &SavedState,
) -> RestoreReport {
    let mut report = RestoreReport::default();
    if state.platform != platform.name() {
        report.lines.push(format!(
            "the state is the {} backend's, not {}'s: nothing restored",
            state.platform,
            platform.name()
        ));
        return report;
    }
    let candidate = match (&state.room, &state.try_title) {
        (Some(room), Some(title)) => Regex::new(title).ok().map(|t| (room.clone(), t)),
        _ => None,
    };
    let matchers = matchers(
        compliance,
        &state.processes,
        candidate
            .as_ref()
            .map(|(room, title)| (room.as_str(), title)),
    );
    let now = match found(platform, &matchers, &state.processes) {
        Ok(now) => now,
        Err(error) => {
            report.lines.push(error);
            return report;
        }
    };
    let mut placer = platform.placer();
    let mut guard = QuietGuard::default();
    for saved in &state.windows {
        let id = WindowId(saved.id);
        let Some(window) = now
            .iter()
            .find(|t| t.id == id && same_process(&t.process.name, &saved.process))
        else {
            report
                .lines
                .push(format!("window {:#x}: gone, nothing to do", saved.id));
            continue;
        };
        if let Err(reason) = admit(compliance, window) {
            report
                .lines
                .push(format!("window {:#x}: not moved - {reason}", saved.id));
            continue;
        }
        if saved.width == 0 || saved.height == 0 {
            report.lines.push(format!(
                "window {:#x}: was minimised; left where it is (minimise it by hand)",
                saved.id
            ));
            continue;
        }
        if !wait_quiet(placer.as_mut(), &mut guard, MOUSE_WAIT) {
            report
                .lines
                .push("the mouse was not quiet: restore stopped".to_owned());
            break;
        }
        let want = saved.client();
        match platform.place(id, want) {
            Ok(got) => {
                report.restored += 1;
                report.lines.push(format!(
                    "window {:#x}: back to client {}{}",
                    saved.id,
                    rect_text(&got),
                    if got == want { "" } else { " (not exactly)" }
                ));
            }
            Err(error) => report
                .lines
                .push(format!("window {:#x}: FAILED - {error}", saved.id)),
        }
    }
    report
}

// ---------------------------------------------------------------------
// The command line.

/// The layout to tile with: the auto grid, or one read from a file.
pub fn options_for(layout: &LayoutChoice) -> Result<Options, String> {
    match layout {
        LayoutChoice::Auto => Ok(Options::default()),
        LayoutChoice::File(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("--layout {}: {e}", path.display()))?;
            let layout: Layout = serde_json::from_str(&text)
                .map_err(|e| format!("--layout {}: not a layout: {e}", path.display()))?;
            if layout.id == AUTO_LAYOUT || layout.slots.is_empty() {
                return Err(format!(
                    "--layout {}: a layout needs its own id and at least one slot",
                    path.display()
                ));
            }
            Ok(Options {
                active: layout.id.clone(),
                layouts: vec![layout],
                ..Options::default()
            })
        }
    }
}

fn save_state(path: &Path, state: &SavedState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn load_state(path: &Path) -> Result<SavedState, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("no saved check at {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// This system's backend for the check (finding and placing only).
fn native() -> Box<dyn Platform> {
    if let Err(error) = crate::platform::windows::init_process_dpi_awareness() {
        eprintln!("rail-hud --tile-check: DPI awareness: {error}");
    }
    crate::platform::native()
}

/// The process: runs the check (or the restore), prints, returns the exit
/// code.
pub fn run(args: Vec<OsString>) -> i32 {
    let args = match CheckArgs::parse(args) {
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
    // A refused room is refused before anything is looked at.
    if let Some(room) = &args.room
        && let Err(error) = admit_room(&compliance, room)
    {
        eprintln!("rail-hud --tile-check: {error}");
        return exit_code::REFUSED;
    }
    if cfg!(target_os = "macos") && !crate::platform::macos::accessibility_granted() {
        eprintln!(
            "rail-hud --tile-check: the Accessibility permission is not granted to the program \
             this runs from (System Settings, Privacy & Security, Accessibility: your terminal)"
        );
        return exit_code::USAGE;
    }
    let path = args.state_path();
    let mut platform = native();
    if args.restore {
        let state = match load_state(&path) {
            Ok(state) => state,
            Err(error) => {
                eprintln!("rail-hud --tile-check --restore: {error}");
                return exit_code::USAGE;
            }
        };
        let report = restore(platform.as_mut(), &compliance, &state);
        for line in &report.lines {
            println!("{line}");
        }
        println!(
            "Restored {} of {} window(s).",
            report.restored,
            state.windows.len()
        );
        let _ = std::fs::remove_file(&path);
        return exit_code::OK;
    }
    let options = match options_for(&args.layout) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("rail-hud: {error}");
            return exit_code::USAGE;
        }
    };
    let request = Request {
        processes: args.processes.clone(),
        candidate: args
            .room
            .clone()
            .zip(args.try_title.as_ref().map(|(regex, _)| regex.clone())),
        options,
        mouse_wait: MOUSE_WAIT,
    };
    let mut notes = Vec::new();
    let names = redaction_names(&args.you, args.store.as_deref(), args.no_store, &mut notes);
    let redactor = Redactor::new(&names);
    let (mut report, state) = match check(platform.as_mut(), &compliance, &request) {
        Ok(done) => done,
        Err(error) => {
            eprintln!("rail-hud --tile-check: {error}");
            return exit_code::REFUSED;
        }
    };
    report.notes.splice(0..0, notes);
    if !state.windows.is_empty() {
        match save_state(&path, &state) {
            Ok(()) => report.notes.push(format!(
                "the windows' places before the check are in {}: rail-hud --tile-check \
                 --restore{} puts them back",
                path.display(),
                args.state
                    .as_ref()
                    .map(|p| format!(" --state {}", p.display()))
                    .unwrap_or_default()
            )),
            Err(error) => report
                .notes
                .push(format!("the places before could not be saved ({error})")),
        }
    }
    print!("{}", report.render(&redactor));
    if report.checked.is_empty() {
        // Every window found was refused: nothing was moved.
        exit_code::REFUSED
    } else {
        exit_code::OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{ProcessInfo, sim::SimBackend};

    fn parse(list: &[&str]) -> Result<CheckArgs, String> {
        CheckArgs::parse(list.iter().map(OsString::from).collect())
    }

    #[test]
    fn arguments() {
        let args = parse(&[
            "--tile-check",
            "--process",
            "PokerStars.exe",
            "--room",
            "pokerstars",
            "--try-title",
            "^(?P<table>.+?) - ",
            "--layout",
            "mine.json",
        ])
        .expect("args");
        assert_eq!(args.processes, ["PokerStars.exe"]);
        assert_eq!(args.room.as_deref(), Some("pokerstars"));
        assert_eq!(args.layout, LayoutChoice::File(PathBuf::from("mine.json")));
        assert!(parse(&["--tile-check"]).is_err(), "no process");
        assert!(
            parse(&["--process", "a", "--try-title", "^x"]).is_err(),
            "a regex needs its room"
        );
        assert!(parse(&["--process", "a", "--room", "acr"]).is_err());
        assert!(parse(&["--process", "a", "--try-title", "(x", "--room", "acr"]).is_err());
        assert!(parse(&["--restore", "--process", "a"]).is_err());
        assert!(parse(&["--restore"]).expect("restore").restore);
        assert_eq!(parse(&["--help"]).err(), Some(String::new()));
        assert_eq!(
            parse(&["--process", "a", "--layout", "auto"])
                .expect("auto")
                .layout,
            LayoutChoice::Auto
        );
        let state = parse(&["--restore", "--state", "/t/s.json"]).expect("state");
        assert_eq!(state.state_path(), PathBuf::from("/t/s.json"));
    }

    /// The four rooms whose tiling is `true` admit; every `false` and
    /// `null` room refuses; a program that looks like a refused room is
    /// refused whatever room its windows were taken as.
    #[test]
    fn permits_decide() {
        let compliance = Compliance::shipped().expect("shipped");
        for room in ["pokerstars", "acr", "wpt-global", "coinpoker"] {
            assert_eq!(admit_room(&compliance, room), Ok(()), "{room}");
        }
        for room in [
            "ggpoker",
            "partypoker",
            "unibet",
            "winamax",
            "888poker",
            "ipoker",
            "chico",
            "nowhere",
        ] {
            assert!(admit_room(&compliance, room).is_err(), "{room}");
        }
        let window = |process: &str, site: &str| TableWindow {
            id: WindowId(1),
            site: site.to_owned(),
            process: ProcessInfo {
                pid: Some(1),
                name: process.to_owned(),
            },
            title: "t".to_owned(),
            table: None,
            size: None,
            client: Rect::default(),
            scale_permille: 1000,
            minimized: false,
        };
        assert!(admit(&compliance, &window("PokerStars.exe", "pokerstars")).is_ok());
        assert!(admit(&compliance, &window("rail-hud-sim", "acr")).is_ok());
        let refused = admit(&compliance, &window("GGnet.exe", "pokerstars")).expect_err("gg");
        assert!(refused.contains("ggpoker"), "{refused}");
        assert!(admit(&compliance, &window("Winamax.exe", "acr")).is_err());
        assert!(admit(&compliance, &window("partypoker.exe", "coinpoker")).is_err());
        assert!(admit(&compliance, &window("Unibet Poker.exe", "pokerstars")).is_err());
        assert!(admit(&compliance, &window("PokerStars.exe", "winamax")).is_err());
        assert!(admit(&compliance, &window("PokerStars.exe", "888poker")).is_err());
        assert_eq!(lookalike(&compliance, "PokerStars.exe"), None);
        assert_eq!(lookalike(&compliance, "CoinPoker.exe"), None);
        assert_eq!(lookalike(&compliance, "WPTGlobal.exe"), None);
        assert_eq!(lookalike(&compliance, "rail-hud-sim"), None);
        assert_eq!(
            lookalike(&compliance, "Natural8.exe").as_deref(),
            Some("ggpoker")
        );
    }

    const REGEX: &str = r"^(?P<table>.+?) - .*$";

    /// A sim backend posing as `site`, with `n` tables of 800 x 600.
    fn sim(site: &str, n: u32) -> SimBackend {
        let (backend, feed) = SimBackend::new(site);
        feed.push_line(
            &serde_json::json!({"event": "started", "room": "x", "titleRegex": REGEX}).to_string(),
        );
        for i in 1..=n {
            feed.push_line(
                &serde_json::json!({"event": "table", "table": i, "title": format!("T{i} - Logged In as SecretMe"),
                    "tableName": "x", "size": 6, "game": "g", "heroSeat": 1, "moved": false})
                .to_string(),
            );
            feed.push_line(
                &serde_json::json!({"event": "window", "table": i, "title": format!("T{i} - Logged In as SecretMe"),
                    "x": 20 * i, "y": 10 * i, "width": 800, "height": 600, "minimized": false})
                .to_string(),
            );
        }
        backend
    }

    fn request() -> Request {
        Request {
            processes: vec![crate::platform::SIM_PROCESS.to_owned()],
            candidate: None,
            options: Options::default(),
            mouse_wait: Duration::from_millis(100),
        }
    }

    /// Four tables of a room that permits tiling: tiled once in the auto
    /// grid, read back, aspect kept; restored afterwards.
    #[test]
    fn a_permitted_room_is_tiled_once_and_restored() {
        let compliance = Compliance::shipped().expect("shipped");
        let mut backend = sim("pokerstars", 4);
        backend.control().set_insets(Insets {
            left: 8,
            top: 31,
            right: 8,
            bottom: 8,
        });
        let control = backend.control();
        let (report, state) = check(&mut backend, &compliance, &request()).expect("check");
        assert_eq!(report.checked.len(), 4);
        assert!(report.refused.is_empty());
        let s = report.summary();
        assert_eq!(
            (s.placed, s.as_requested, s.refused_size, s.failed),
            (4, 4, 0, 0)
        );
        assert_eq!((s.aspect_kept, s.aspect_known), (4, 4));
        assert_eq!(control.placements().len(), 4, "once each, no retry");
        for c in &report.checked {
            assert_eq!(c.after, c.accepted(), "read back where accepted");
            let (_, monitor, cell) = c.slot.expect("a slot");
            assert_eq!(monitor, 0);
            let outer = c.insets.expect("insets").outer(&c.after.expect("after"));
            assert!(cell.contains(&outer), "{cell:?} {outer:?}");
        }
        let text = report.render(&Redactor::new(&[]));
        assert!(!text.contains("SecretMe"), "{text}");
        assert!(text.contains("Logged In as <you>"), "{text}");
        assert!(text.contains("- as requested;"), "{text}");
        assert!(text.contains(
            "monitor 0: 1920x1080 at (0, 0), work area 1920x1040 at (0, 0), 100% (primary)"
        ));
        assert!(
            text.contains("aspect:    4:3 before (1333 per mille)"),
            "{text}"
        );
        assert!(text.contains("Summary: 4 placed (4 as requested, 0 refused a size), 0 failed"));

        assert_eq!(state.platform, "sim");
        assert_eq!(state.windows.len(), 4);
        let json = serde_json::to_string(&state).expect("json");
        assert!(!json.contains("SecretMe"), "no title in the state");
        let back: SavedState = serde_json::from_str(&json).expect("parse");
        let restored = restore(&mut backend, &compliance, &back);
        assert_eq!(restored.restored, 4, "{:?}", restored.lines);
        for i in 1..=4u32 {
            let client = control.client_of(i).expect("table");
            assert_eq!(
                client,
                Rect {
                    x: i32::try_from(20 * i).expect("x"),
                    y: i32::try_from(10 * i).expect("y"),
                    width: 800,
                    height: 600
                }
            );
        }
    }

    /// A room whose tiling is `false` or `null`: its windows are listed and
    /// never moved; one posed table of a refused room among permitted
    /// ones stays where it is.
    #[test]
    fn refused_rooms_are_never_moved() {
        let compliance = Compliance::shipped().expect("shipped");
        for site in ["ggpoker", "winamax", "partypoker", "unibet", "888poker"] {
            let mut backend = sim(site, 3);
            let control = backend.control();
            let (report, state) = check(&mut backend, &compliance, &request()).expect(site);
            assert!(report.checked.is_empty(), "{site}");
            assert_eq!(report.refused.len(), 3, "{site}");
            assert!(control.placements().is_empty(), "{site}: nothing moved");
            assert!(state.windows.is_empty());
            let text = report.render(&Redactor::new(&[]));
            assert!(text.contains("Never moved:"), "{text}");
            assert!(text.contains("3 never moved"), "{text}");
        }
        let mut backend = sim("acr", 3);
        let control = backend.control();
        control.pose(2, "winamax");
        let (report, _) = check(&mut backend, &compliance, &request()).expect("mixed");
        assert_eq!(report.checked.len(), 2);
        assert_eq!(report.refused.len(), 1);
        assert!(
            report.refused[0]
                .reason
                .contains("winamax: tiling refused (the room prohibits it)")
        );
        assert!(control.placements().iter().all(|p| p.id != WindowId(2)));
        assert_eq!(
            control.client_of(2),
            Some(Rect {
                x: 40,
                y: 20,
                width: 800,
                height: 600
            })
        );
        // A refused room named with --room: nothing starts.
        let mut backend = sim("ggpoker", 1);
        let control = backend.control();
        let mut refused = request();
        refused.candidate = Some(("ggpoker".to_owned(), Regex::new(REGEX).expect("re")));
        let error = check(&mut backend, &compliance, &refused).expect_err("refused room");
        assert!(error.contains("ggpoker: tiling refused"), "{error}");
        assert!(control.placements().is_empty());
    }

    /// A client that keeps its own size: the refused size is reported,
    /// the one retry centres it, and the aspect ratio says what happened.
    #[test]
    fn a_refused_size_is_reported() {
        let compliance = Compliance::shipped().expect("shipped");
        let mut backend = sim("wpt-global", 2);
        let control = backend.control();
        control.set_accept_for(1, |want| Rect {
            width: 700,
            height: 500,
            ..want
        });
        let (report, _) = check(&mut backend, &compliance, &request()).expect("check");
        let c = report
            .checked
            .iter()
            .find(|c| c.id == WindowId(1))
            .expect("table 1");
        assert!(c.attempts[0].refused_size());
        assert_eq!(c.attempts.len(), 2, "one retry, centred");
        assert_eq!(c.aspect().map(|(_, kept)| kept), Some(false));
        let s = report.summary();
        assert_eq!((s.placed, s.refused_size, s.as_requested), (2, 1, 1));
        let text = report.render(&Redactor::new(&[]));
        assert!(text.contains("SIZE REFUSED: wanted"), "{text}");
        assert!(text.contains("kept 700x500"), "{text}");
        assert!(text.contains("  retry:"), "{text}");
        assert!(text.contains("CHANGED"), "{text}");
    }

    /// The mouse held down: nothing moves, and the check says why.
    #[test]
    fn nothing_moves_while_the_mouse_is_down() {
        let compliance = Compliance::shipped().expect("shipped");
        let mut backend = sim("coinpoker", 2);
        let control = backend.control();
        control.press();
        let (report, state) = check(&mut backend, &compliance, &request()).expect("check");
        assert!(control.placements().is_empty());
        assert!(state.windows.is_empty());
        assert!(report.checked.iter().all(|c| c.skipped.is_some()));
        assert_eq!(report.summary().skipped, 2);
        assert!(
            report
                .render(&Redactor::new(&[]))
                .contains("a mouse button was down"),
        );
    }

    /// A layout file: its slots, not the auto grid; a broken one refused.
    #[test]
    fn a_layout_from_a_file() {
        let dir = std::env::temp_dir().join(format!("rail-tile-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("two.json");
        std::fs::write(
            &path,
            r#"{"id":"two","name":"Two","slots":[
                {"id":"a","rect":{"x":0,"y":0,"width":500,"height":1000}},
                {"id":"b","rect":{"x":500,"y":0,"width":500,"height":1000}}]}"#,
        )
        .expect("write");
        let options = options_for(&LayoutChoice::File(path.clone())).expect("layout");
        assert_eq!(options.active, "two");
        let compliance = Compliance::shipped().expect("shipped");
        let mut backend = sim("pokerstars", 2);
        let mut req = request();
        req.options = options;
        let (report, _) = check(&mut backend, &compliance, &req).expect("check");
        assert_eq!(report.layout, "two");
        let cells: Vec<Rect> = report
            .checked
            .iter()
            .filter_map(|c| c.slot.map(|(_, _, cell)| cell))
            .collect();
        assert_eq!(
            cells,
            [
                Rect {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 1040
                },
                Rect {
                    x: 960,
                    y: 0,
                    width: 960,
                    height: 1040
                }
            ]
        );
        std::fs::write(&path, r#"{"id":"auto","name":"x","slots":[]}"#).expect("write");
        assert!(options_for(&LayoutChoice::File(path.clone())).is_err());
        assert!(options_for(&LayoutChoice::File(dir.join("missing.json"))).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No window: an error, and nothing saved.
    #[test]
    fn no_window_is_an_error() {
        let compliance = Compliance::shipped().expect("shipped");
        let mut backend = sim("pokerstars", 0);
        let error = check(&mut backend, &compliance, &request()).expect_err("none");
        assert!(error.contains("no table window"), "{error}");
        let mut other = request();
        other.processes = vec!["PokerStars.exe".to_owned()];
        let mut backend = sim("pokerstars", 2);
        assert!(
            check(&mut backend, &compliance, &other).is_err(),
            "another program's"
        );
    }

    /// A restore refuses another backend's state and skips windows gone.
    #[test]
    fn a_restore_checks_what_it_moves() {
        let compliance = Compliance::shipped().expect("shipped");
        let mut backend = sim("pokerstars", 1);
        let state = SavedState {
            platform: "windows".to_owned(),
            processes: vec![crate::platform::SIM_PROCESS.to_owned()],
            room: None,
            try_title: None,
            windows: vec![],
        };
        assert_eq!(restore(&mut backend, &compliance, &state).restored, 0);
        let state = SavedState {
            platform: "sim".to_owned(),
            windows: vec![
                SavedWindow {
                    id: 9,
                    site: "pokerstars".to_owned(),
                    process: crate::platform::SIM_PROCESS.to_owned(),
                    x: 0,
                    y: 0,
                    width: 640,
                    height: 480,
                    minimized: false,
                },
                SavedWindow {
                    id: 1,
                    site: "pokerstars".to_owned(),
                    process: crate::platform::SIM_PROCESS.to_owned(),
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                    minimized: true,
                },
            ],
            ..state
        };
        let report = restore(&mut backend, &compliance, &state);
        assert_eq!(report.restored, 0);
        assert!(report.lines[0].contains("gone"), "{:?}", report.lines);
        assert!(
            report.lines[1].contains("was minimised"),
            "{:?}",
            report.lines
        );
        assert!(backend.control().placements().is_empty());
    }
}

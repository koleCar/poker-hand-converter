//! macOS (R3.11 - R3.13).
//!
//! - **R3.11 `find_tables`** (done): two sources, joined.
//!   1. **The window server's list**, `CGWindowListCopyWindowInfo`
//!      (`OptionAll | ExcludeDesktopElements`: windows on screen *and* off
//!      it - minimised, on another Space, of a hidden app; **not** in
//!      z-order, which R3.12 found and R3.13 fixed: the order is
//!      [`onscreen_order`]'s, [`z_ordered`]): the window number (`CGWindowID`, the [`WindowId`]), the owner's pid,
//!      the bounds in points, the layer (0 = ordinary windows; menus,
//!      panels and the menu bar are not) and whether it is on screen. Its
//!      window *names* need Screen Recording since macOS 10.15 and are
//!      never read: the HUD asks for no Screen Recording, ever.
//!   2. **The Accessibility API** per process whose executable one of the
//!      rooms' matchers takes (`proc_pidpath`'s file name, compared like
//!      Windows' `.exe` names): `AXUIElementCreateApplication(pid)` ->
//!      `AXWindows` -> each window's `AXTitle`, `AXPosition` / `AXSize`,
//!      `AXMinimized`, `AXFullScreen`, `AXSubrole` and its `AXCloseButton`'s
//!      frame. This needs the **Accessibility** permission (System
//!      Settings, Privacy & Security, Accessibility) for the HUD's
//!      *responsible* process: the app bundle that started it (Rail.app
//!      for the sidecar), a terminal for a command run from one. Without
//!      it `find_tables` fails with [`PlatformError::PermissionNeeded`] and
//!      the HUD reports `permission_needed` (the app explains and links to
//!      the pane); it never prompts by itself - the system prompt comes
//!      only from [`Platform::request_permission`], the user's click.
//!      Each process gets 0.25 s per request (`AXUIElementSetMessagingTimeout`):
//!      a busy client cannot stall the loop for the system's default 6 s.
//!
//!   **Pairing** ([`pair`]): an accessibility window is the window
//!   server's window whose number `_AXUIElementGetWindow` gives (a private
//!   function, looked up at run time and never linked against: the window
//!   managers and switchers of macOS use it for exactly this); without it,
//!   the first window of the same process whose bounds equal the
//!   accessibility frame within a point, in front-to-back order on both
//!   sides (the window server's side by the on-screen z-order, R3.13) -
//!   so two tables stacked at one place pair in z-order.
//!
//!   **Client area**: the window's bounds less its title bar. A standard
//!   window's buttons sit in the middle of its title bar, so the bar's
//!   height is twice the close button's centre below the window's top
//!   ([`title_bar`]: 28 pt for an ordinary titled window up to macOS 15,
//!   32 pt on macOS 26 - measured on the simulator's winit windows -, more
//!   with a toolbar); none for a window without a close button
//!   (borderless) or in full screen.
//!
//!   **Points and pixels**: macOS window APIs speak points in one global
//!   space (the main display's top-left the origin, y down). The trait's
//!   rect is "physical pixels": here the points times the backing scale of
//!   the window's screen - the display its bounds overlap most
//!   (`CGGetActiveDisplayList`, `CGDisplayBounds`, the display mode's
//!   pixel width over its width: 2000 on Retina) - rounded. That is
//!   exactly winit's "physical position" (the simulator's `window` events)
//!   and, scales on macOS being whole (1x, 2x, 3x), the overlay of R3.12
//!   gets its points back exactly as rect / scale. A window straddling two
//!   displays of different scale is reported at the scale of the one it
//!   overlaps most, as AppKit does (its `screen`).
//!
//!   **States**: minimised (`AXMinimized`) -> `minimized`, the client rect
//!   empty; off screen and not minimised (another Space - full-screen
//!   tables included when their Space is not shown - or the app hidden)
//!   -> `cloaked`, as Windows marks a window on another virtual desktop:
//!   still a table, hidden. The Accessibility API lists only the current
//!   Space's windows (and minimised ones), so a window on another Space
//!   keeps the title the backend last read for it; one never seen on this
//!   Space is not found until it is.
//!
//!   Every match is returned, allowed or not (compliance decides in the
//!   engine). `track` records the window; the engine's periodic re-find
//!   follows it (R3.13 adds observers); `overlay` is R3.12's.
//! - **R3.12 `overlay`** (done; `appkit.rs`): a borderless, transparent,
//!   non-activating `NSPanel` per table, exactly over its client area
//!   ([`appkit_frame`]: the rect back in points, flipped against the main
//!   display), ordered directly above the table and kept there by looking
//!   ([`stacking`]); a click window over each panel takes the mouse, the
//!   overlay lets everything else through (no permission); the shared
//!   scene painted by Core Graphics and Core Text into a bitmap at the
//!   table's pixels, a layer's contents. AppKit has the main thread
//!   ([`with_appkit`]); the engine runs beside it and hands it frames over
//!   a [`Link`]. `appkit.rs` has the design.
//! - **R3.13 `track` / `poll_events`** (done; `observe.rs`): an
//!   `AXObserver` per poker process on a thread of its own with its own
//!   `CFRunLoop` - moved, resized, miniaturised, deminiaturised, destroyed
//!   and title changed per window; window created, focus and main window
//!   changed, activated, hidden and shown per application ([`AxNote`]).
//!   Each notification reads the table from the window server
//!   ([`tracked_geometry`]) and moves its overlay at once, before the
//!   engine hears of it (coalesced, `tracking::events`); activation and
//!   focus restack the overlays now; the active Space's change
//!   (`NSWorkspace`, on the AppKit thread) makes every table be read
//!   again; a client's exit (`kqueue`) removes its overlays. The engine's
//!   re-find (`CGWindowList` and the Accessibility API every 500 ms) stays
//!   as the fallback for a client with poor accessibility and never fights
//!   the observers: what it reports otherwise makes them read the table
//!   again rather than placing an overlay from a description.
//!
//! **`unsafe`** lives in `ffi`, `appkit` and `drive` only (compiled on
//! macOS), one small function per call with its own `#[allow(unsafe_code)]`
//! and a `// SAFETY:` comment per block, as in `windows.rs`. Everything here is plain Rust, compiled
//! and unit-tested on every system; off macOS the backend finds nothing.

use std::collections::BTreeMap;

use super::tracking::Geometry;
use super::{
    DpiAwareness, OverlayFrame, Permission, Platform, PlatformError, RawWindow, Rect, TableEvent,
    TableMatcher, TableWindow, WindowId, table_of,
};

#[cfg(target_os = "macos")]
mod appkit;
#[cfg(target_os = "macos")]
pub mod drive;
#[cfg(target_os = "macos")]
mod ffi;
#[cfg(target_os = "macos")]
mod observe;

/// Thousandths of a point per point: the unit of [`Frame`].
pub const MILLI: i64 = 1000;

/// A float from the system (points, `CGFloat`) as thousandths of a point.
/// The one place floats become integers: everything after is integer
/// arithmetic (the workspace's lints). Not finite: 0.
#[allow(clippy::float_arithmetic, clippy::cast_possible_truncation)]
pub fn milli(points: f64) -> i64 {
    if points.is_finite() {
        // `as` saturates; a window is nowhere near 9e15 points.
        (points * 1000.0).round() as i64
    } else {
        0
    }
}

/// A rectangle in thousandths of a point, global coordinates (the main
/// display's top-left the origin, y down) - how both the window server and
/// the Accessibility API describe windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Frame {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl Frame {
    /// A frame in whole points.
    pub const fn points(x: i64, y: i64, width: i64, height: i64) -> Self {
        Self {
            x: x * MILLI,
            y: y * MILLI,
            width: width * MILLI,
            height: height * MILLI,
        }
    }

    /// The same window: every edge within one point (the two sources round
    /// differently).
    pub fn close_to(&self, other: &Self) -> bool {
        (self.x - other.x).abs() <= MILLI
            && (self.y - other.y).abs() <= MILLI
            && (self.width - other.width).abs() <= MILLI
            && (self.height - other.height).abs() <= MILLI
    }

    /// The area two frames share, square thousandths of a point.
    fn overlap(&self, other: &Self) -> i128 {
        let w = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let h = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        if w <= 0 || h <= 0 {
            0
        } else {
            i128::from(w) * i128::from(h)
        }
    }
}

/// A window as the window server lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CgWindow {
    /// `kCGWindowNumber`.
    pub id: u32,
    pub pid: u32,
    /// `kCGWindowOwnerName`: the app's name as the Dock shows it (not
    /// matched on; `--list-windows` shows it).
    pub owner: String,
    /// The whole window, title bar included.
    pub bounds: Frame,
    /// 0 for ordinary windows.
    pub layer: i64,
    pub onscreen: bool,
}

/// A window as the Accessibility API describes it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AxWindow {
    pub title: String,
    /// `AXPosition` + `AXSize`: the whole window.
    pub frame: Option<Frame>,
    pub minimized: bool,
    pub fullscreen: bool,
    /// `AXStandardWindow`, `AXDialog`, `AXFloatingWindow`, ... (shown as
    /// the window's "class").
    pub subrole: String,
    /// The close button's frame: where the title bar is.
    pub close_button: Option<Frame>,
    /// The window server's number, when the system says
    /// (`_AXUIElementGetWindow`).
    pub window_id: Option<u32>,
}

/// A display: where it is (points) and its backing scale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub bounds: Frame,
    pub scale_permille: u32,
}

/// What one look at the system saw: the window server's windows and their
/// z-order, the executables of their processes, the accessibility windows
/// of the processes looked at, the displays (the main one first).
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// Every window, on screen or not: **not in z-order** (`OptionAll`
    /// interleaves; R3.12 found it) - `order` is.
    pub cg: Vec<CgWindow>,
    /// (R3.13) The on-screen windows' numbers front to back
    /// ([`onscreen_order`]): what "front to back" means here. Empty: the
    /// list's own order.
    pub order: Vec<u32>,
    pub names: BTreeMap<u32, String>,
    /// Per pid whose windows were asked for: the accessibility windows, or
    /// why there are none.
    pub ax: BTreeMap<u32, Result<Vec<AxWindow>, String>>,
    pub displays: Vec<Display>,
}

/// What the backend remembers of a window whose title it read: a window on
/// another Space is in the window server's list but not the Accessibility
/// API's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remembered {
    pub title: String,
    pub subrole: String,
    /// The title bar's height, thousandths of a point.
    pub title_bar: i64,
}

/// A display mode's pixels per point, thousandths (1000 when unknown).
pub fn scale_permille(pixel_width: usize, width: usize) -> u32 {
    if width == 0 || pixel_width == 0 {
        return 1000;
    }
    let scale = (pixel_width * 1000 + width / 2) / width;
    u32::try_from(scale).unwrap_or(1000).max(1)
}

/// The scale of the display `bounds` overlaps most; the main display's
/// for a window on none; 1000 without displays.
pub fn display_scale(bounds: &Frame, displays: &[Display]) -> u32 {
    let best = displays
        .iter()
        .map(|d| (d.bounds.overlap(bounds), d.scale_permille))
        .filter(|(area, _)| *area > 0)
        .fold(
            None,
            |best: Option<(i128, u32)>, (area, scale)| match best {
                Some((top, _)) if top >= area => best,
                _ => Some((area, scale)),
            },
        );
    best.map(|(_, scale)| scale)
        .or_else(|| displays.first().map(|d| d.scale_permille))
        .unwrap_or(1000)
}

/// The title bar's height in thousandths of a point (whole points): twice
/// the close button's centre below the window's top, within the window;
/// 0 for a window in full screen or without a close button.
pub fn title_bar(ax: &AxWindow, bounds: &Frame) -> i64 {
    if ax.fullscreen {
        return 0;
    }
    let Some(button) = ax.close_button else {
        return 0;
    };
    let top = ax.frame.map_or(bounds.y, |f| f.y);
    let bar = 2 * (button.y - top) + button.height;
    let whole = (bar + MILLI / 2).div_euclid(MILLI) * MILLI;
    whole.clamp(0, bounds.height.max(0))
}

/// The client area: `bounds` less the title bar.
pub fn client_frame(bounds: &Frame, title_bar: i64) -> Frame {
    Frame {
        x: bounds.x,
        y: bounds.y + title_bar,
        width: bounds.width.max(0),
        height: (bounds.height - title_bar).max(0),
    }
}

/// `value` thousandths of a point at `scale_permille`, in pixels, rounded
/// half away from zero (as winit rounds a physical position).
fn pixels(value: i64, scale_permille: u32) -> i128 {
    let n = i128::from(value) * i128::from(scale_permille);
    let d: i128 = 1_000_000;
    if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    }
}

/// A frame in physical pixels: points times the backing scale.
pub fn to_pixels(frame: &Frame, scale_permille: u32) -> Rect {
    let int = |v: i128| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
    let uint = |v: i128| u32::try_from(v.max(0)).unwrap_or(u32::MAX);
    Rect {
        x: int(pixels(frame.x, scale_permille)),
        y: int(pixels(frame.y, scale_permille)),
        width: uint(pixels(frame.width, scale_permille)),
        height: uint(pixels(frame.height, scale_permille)),
    }
}

/// The scale as the dpi `RawWindow` carries (96 = 1x), so that
/// [`super::dpi_permille`] gives the scale back exactly.
fn dpi_of(scale_permille: u32) -> u32 {
    scale_permille.saturating_mul(96) / 1000
}

/// (R3.13) `windows` in z-order: those on screen as `order` lists them
/// (front to back, [`onscreen_order`]), then the rest - off screen:
/// minimised, on another Space, of a hidden app - in their own order.
/// `cg_windows`' `OptionAll` list is **not** in z-order (R3.12), so it is
/// never read as such. An empty `order` keeps the list's order.
pub fn z_ordered<'a>(windows: &[&'a CgWindow], order: &[u32]) -> Vec<&'a CgWindow> {
    let rank: BTreeMap<u32, usize> = order.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut out = windows.to_vec();
    // Stable: off-screen windows keep their relative order.
    out.sort_by_key(|w| rank.get(&w.id).copied().unwrap_or(usize::MAX));
    out
}

/// Which accessibility window each of one process's window-server windows
/// is (`cg` in z-order - [`z_ordered`] - and `ax` front to back, as the
/// Accessibility API lists an application's windows): by the window number the system
/// gave, else the first unpaired window whose bounds equal the frame
/// within a point. An accessibility window with a number that names none
/// of `cg` is not paired by frame (the number is the truth).
pub fn pair(cg: &[&CgWindow], ax: &[AxWindow]) -> Vec<Option<usize>> {
    let mut by_cg: Vec<Option<usize>> = vec![None; cg.len()];
    for (a, window) in ax.iter().enumerate() {
        let Some(id) = window.window_id else {
            continue;
        };
        if let Some(c) = cg.iter().position(|w| w.id == id)
            && by_cg[c].is_none()
        {
            by_cg[c] = Some(a);
        }
    }
    for (a, window) in ax.iter().enumerate() {
        if window.window_id.is_some() {
            continue;
        }
        let Some(frame) = window.frame else {
            continue;
        };
        if let Some(c) =
            (0..cg.len()).find(|&c| by_cg[c].is_none() && cg[c].bounds.close_to(&frame))
        {
            by_cg[c] = Some(a);
        }
    }
    by_cg
}

/// The windows of the processes whose accessibility windows `snapshot` has,
/// front to back, as [`RawWindow`]s: ordinary windows (layer 0) only; a
/// window without an accessibility partner has the title remembered for it
/// (another Space), else none - and is left out when it is off screen too.
/// `memory` keeps each title read, for windows that still exist.
pub fn assemble(snapshot: &Snapshot, memory: &mut BTreeMap<u32, Remembered>) -> Vec<RawWindow> {
    memory.retain(|id, _| snapshot.cg.iter().any(|w| w.id == *id));
    let mut out = Vec::new();
    for (pid, ax) in &snapshot.ax {
        let ax: &[AxWindow] = ax.as_deref().unwrap_or(&[]);
        let windows: Vec<&CgWindow> = snapshot
            .cg
            .iter()
            .filter(|w| w.pid == *pid && w.layer == 0)
            .collect();
        // (R3.13) Front to back by the on-screen order, never by the
        // `OptionAll` list's: the frame fallback pairs stacked tables in
        // z-order.
        let windows = z_ordered(&windows, &snapshot.order);
        let pairs = pair(&windows, ax);
        for (cg, paired) in windows.iter().zip(pairs) {
            let (title, subrole, bar, minimized) = match paired.map(|a| &ax[a]) {
                Some(window) => {
                    let bar = title_bar(window, &cg.bounds);
                    if !window.title.trim().is_empty() {
                        memory.insert(
                            cg.id,
                            Remembered {
                                title: window.title.clone(),
                                subrole: window.subrole.clone(),
                                title_bar: bar,
                            },
                        );
                    }
                    (
                        window.title.clone(),
                        window.subrole.clone(),
                        bar,
                        window.minimized,
                    )
                }
                None => match memory.get(&cg.id).filter(|_| !cg.onscreen) {
                    Some(known) => (
                        known.title.clone(),
                        known.subrole.clone(),
                        known.title_bar,
                        false,
                    ),
                    // Off screen, unknown to the Accessibility API and
                    // never seen: nothing to show or match (AppKit keeps
                    // such helper windows for every app).
                    None if !cg.onscreen => continue,
                    None => (String::new(), String::new(), 0, false),
                },
            };
            let scale = display_scale(&cg.bounds, &snapshot.displays);
            let dpi = dpi_of(scale);
            out.push((
                cg.id,
                RawWindow {
                    id: WindowId(u64::from(cg.id)),
                    pid: cg.pid,
                    process: snapshot
                        .names
                        .get(&cg.pid)
                        .cloned()
                        .unwrap_or_else(|| cg.owner.clone()),
                    class: subrole,
                    title,
                    client: if minimized {
                        Rect::default()
                    } else {
                        to_pixels(&client_frame(&cg.bounds, bar), scale)
                    },
                    monitor_dpi: dpi,
                    window_dpi: dpi,
                    // AppKit draws every window at its screen's backing
                    // scale.
                    awareness: DpiAwareness::PerMonitor,
                    minimized,
                    cloaked: !cg.onscreen && !minimized,
                },
            ));
        }
    }
    // Front to back across processes (R3.13): the on-screen order, then
    // the off-screen windows in the list's order.
    let rank: BTreeMap<u32, usize> = snapshot
        .order
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let listed: BTreeMap<u32, usize> = snapshot
        .cg
        .iter()
        .enumerate()
        .map(|(i, w)| (w.id, i))
        .collect();
    out.sort_by_key(|(id, _)| {
        (
            rank.get(id).copied().unwrap_or(usize::MAX),
            listed.get(id).copied().unwrap_or(usize::MAX),
        )
    });
    out.into_iter().map(|(_, window)| window).collect()
}

/// Whether the HUD may read window titles: the Accessibility permission of
/// its responsible process. Reading it prompts nobody. `false` off macOS.
pub fn accessibility_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        ffi::trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Whether Screen Recording is granted - never needed by the HUD; the
/// diagnostic says so. `false` off macOS.
pub fn screen_recording_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        ffi::screen_recording_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// (R3.13) One window as the window server has it now (bounds, layer, on
/// screen), `None` once it is gone: what the observers read. Needs no
/// permission. macOS only.
pub fn window_now(id: u32) -> Option<CgWindow> {
    #[cfg(target_os = "macos")]
    {
        ffi::cg_window(id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        None
    }
}

/// The window server's windows alone - bounds, pid, layer, on screen; no
/// title (that is the Accessibility API's). **Not in z-order** (R3.12):
/// [`onscreen_order`] is. Needs no permission. macOS only.
pub fn cg_windows() -> Result<Vec<CgWindow>, PlatformError> {
    #[cfg(target_os = "macos")]
    {
        ffi::cg_windows()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(PlatformError::Unsupported("listing windows (macOS only)"))
    }
}

/// (R3.12) The window numbers on screen, front to back - the order
/// [`stacking`] reads (the active Space's windows, as AppKit's
/// `NSWindow.windowNumbers` lists them). [`cg_windows`]' `OptionAll` list is
/// *not* in z-order. Needs no permission. macOS only.
pub fn onscreen_order() -> Result<Vec<u32>, PlatformError> {
    #[cfg(target_os = "macos")]
    {
        ffi::onscreen_order()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(PlatformError::Unsupported("listing windows (macOS only)"))
    }
}

/// The displays, the main one first. Empty off macOS.
pub fn displays() -> Vec<Display> {
    #[cfg(target_os = "macos")]
    {
        ffi::displays()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// One look: every window the window server lists, and the accessibility
/// windows of each process whose executable `wanted` takes (only when the
/// permission is granted: without it nothing is asked). macOS only.
pub fn snapshot(wanted: &dyn Fn(&str) -> bool) -> Result<Snapshot, PlatformError> {
    #[cfg(target_os = "macos")]
    {
        let cg = ffi::cg_windows()?;
        // (R3.13) The z-order, which the `OptionAll` list is not in.
        let order = ffi::onscreen_order().unwrap_or_default();
        let mut names = BTreeMap::new();
        for window in cg.iter().filter(|w| w.layer == 0) {
            names
                .entry(window.pid)
                .or_insert_with(|| ffi::process_name(window.pid).unwrap_or_default());
        }
        let trusted = ffi::trusted();
        let mut ax = BTreeMap::new();
        for (pid, name) in &names {
            let name = if name.is_empty() {
                cg.iter()
                    .find(|w| w.pid == *pid)
                    .map_or("", |w| w.owner.as_str())
            } else {
                name.as_str()
            };
            if !wanted(name) {
                continue;
            }
            ax.insert(
                *pid,
                if trusted {
                    ffi::ax_windows(*pid)
                } else {
                    Err("the Accessibility permission is not granted".to_owned())
                },
            );
        }
        names.retain(|_, name| !name.is_empty());
        Ok(Snapshot {
            cg,
            order,
            names,
            ax,
            displays: ffi::displays(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = wanted;
        Err(PlatformError::Unsupported("listing windows (macOS only)"))
    }
}

/// Every ordinary window of the processes `wanted` takes, front to back
/// (the on-screen z-order, then the off-screen windows),
/// titles through the Accessibility API (empty without the permission):
/// what `--list-windows` prints. One look, nothing remembered. macOS only.
pub fn enumerate(wanted: &dyn Fn(&str) -> bool) -> Result<Vec<RawWindow>, PlatformError> {
    let snapshot = snapshot(wanted)?;
    Ok(assemble(&snapshot, &mut BTreeMap::new()))
}

// ---------------------------------------------------------------------
// R3.12: where an overlay goes and whether it is stacked right - plain
// Rust, unit-tested on every system; `appkit` (macOS) does what it says.

/// `value` physical pixels at `scale_permille` in thousandths of a point,
/// rounded half away from zero: the inverse of [`to_pixels`] (exact for
/// the whole scales macOS has: 1x, 2x, 3x).
fn points_of(value: i64, scale_permille: u32) -> i64 {
    let n = i128::from(value) * 1_000_000;
    let d = i128::from(scale_permille.max(1));
    let q = if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    };
    i64::try_from(q).unwrap_or(if q < 0 { i64::MIN } else { i64::MAX })
}

/// (R3.12) A rect in the trait's physical pixels (points times the backing
/// scale of the window's screen, R3.11) back in thousandths of a point, in
/// the global top-left space: `client / scale_permille x 1000`.
pub fn rect_points(rect: &Rect, scale_permille: u32) -> Frame {
    Frame {
        x: points_of(i64::from(rect.x), scale_permille),
        y: points_of(i64::from(rect.y), scale_permille),
        width: points_of(i64::from(rect.width), scale_permille),
        height: points_of(i64::from(rect.height), scale_permille),
    }
}

/// (R3.12) A frame of the global top-left space (the window server's and
/// the Accessibility API's: the main display's top-left the origin, y
/// down) in AppKit's screen space (the main display's bottom-left the
/// origin, y up): flipped against the **main** display's height - the
/// display whose top-left is the first space's origin and whose
/// bottom-left is the second's, whichever display the frame is on.
pub fn to_appkit(frame: &Frame, main_height: i64) -> Frame {
    Frame {
        x: frame.x,
        y: main_height - frame.y - frame.height,
        width: frame.width,
        height: frame.height,
    }
}

/// (R3.12) The AppKit frame of a window over `client` (physical pixels at
/// `scale_permille`, the global top-left space), thousandths of a point.
pub fn appkit_frame(client: &Rect, scale_permille: u32, main_height: i64) -> Frame {
    to_appkit(&rect_points(client, scale_permille), main_height)
}

/// (R3.12) A point of AppKit's screen space (thousandths of a point, y up)
/// as a pixel of the client area `client` (physical pixels at
/// `scale_permille`): where a mouse event on an overlay is, in the scene's
/// units.
pub fn client_pixel(
    point: (i64, i64),
    client: &Rect,
    scale_permille: u32,
    main_height: i64,
) -> (i32, i32) {
    let clamp = |v: i128| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
    (
        clamp(pixels(point.0, scale_permille) - i128::from(client.x)),
        clamp(pixels(main_height - point.1, scale_permille) - i128::from(client.y)),
    )
}

/// (R3.12) How a table's overlay stands in the window server's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stacking {
    /// Directly above its table, its click windows directly above it.
    Fine,
    /// Anywhere else (the table was raised over it, a window got between,
    /// it is on another Space than its table): order it above the table
    /// again.
    Restack,
    /// The table is not on the screen's active Space (minimised, hidden,
    /// another Space): nothing to stack against; the engine hides the
    /// overlay when it sees that.
    Away,
}

/// (R3.12) Whether an overlay is stacked right: `order` is the window
/// numbers of the active Space, front to back (`NSWindow.windowNumbers`
/// of every application); the overlay must come directly before its
/// `table`, and its click windows (`hits`, those shown) directly before
/// the overlay, in any order among themselves - nothing of anyone else's
/// between.
pub fn stacking(order: &[i64], table: i64, overlay: i64, hits: &[i64]) -> Stacking {
    let Some(t) = order.iter().position(|&w| w == table) else {
        return Stacking::Away;
    };
    let Some(o) = order.iter().position(|&w| w == overlay) else {
        return Stacking::Restack;
    };
    if o + 1 != t || hits.len() > o {
        return Stacking::Restack;
    }
    let above = &order[o - hits.len()..o];
    if hits.iter().all(|h| above.contains(h)) {
        Stacking::Fine
    } else {
        Stacking::Restack
    }
}

/// (R3.12) What the AppKit thread knows of a table's overlay: for tests and
/// diagnostics (`MacosBackend::overlay_info`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverlayInfo {
    /// The overlay window's number (`NSWindow.windowNumber`, which is the
    /// window server's `CGWindowID`).
    pub window: Option<u32>,
    /// Whether it is ordered in (visible).
    pub shown: bool,
    /// Its frame as last set, AppKit's screen space, thousandths of a point.
    pub frame: Frame,
    /// Whether it lets every mouse event through (it should: the click
    /// windows take the panels' clicks).
    pub ignores_mouse: bool,
    /// The click windows over the panels (those in use): number, the panel
    /// client-relative (physical pixels), AppKit frame, takes the mouse.
    pub hits: Vec<HitInfo>,
    /// The layer's contents scale, thousandths (the table's screen's).
    pub contents_scale: u32,
    pub renders: u64,
    /// The last paint's time (scene, Core Graphics, the layer), µs.
    pub last_render_us: u64,
    /// The size it was last painted at, physical pixels.
    pub painted: (u32, u32),
    pub panels: Vec<Rect>,
    pub seat_panels: Vec<(u32, Rect)>,
    pub placed_by_user: Vec<u32>,
    pub size: u32,
    pub drags: u64,
    pub clicks: u64,
    pub tags: Vec<(u32, Rect)>,
    pub legend: Option<Rect>,
    pub seat_cells: Vec<(u32, Vec<String>)>,
    pub dropped: Vec<String>,
    /// Moved without a repaint.
    pub moves: u64,
    /// Put back directly above its table (it had been raised over it).
    pub restacked: u64,
    pub error: Option<String>,
}

/// (R3.12) One click window of an overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HitInfo {
    pub window: u32,
    /// The panel it covers, client-relative physical pixels.
    pub rect: Rect,
    /// AppKit's screen space, thousandths of a point.
    pub frame: Frame,
    pub takes_mouse: bool,
    pub shown: bool,
}

/// (R3.12) A synthetic mouse event for the overlay tests: put on this
/// process's own event queue (`NSApplication.postEvent`), never the
/// system's, so it reaches only the HUD's own windows and needs no
/// permission. Client-relative physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mouse {
    Press(i32, i32),
    Move(i32, i32),
    Release(i32, i32),
}

// ---------------------------------------------------------------------
// R3.13: following a table - what the accessibility observers' notes
// mean and where a table is, read from the window server; plain Rust,
// unit-tested on every system. `observe` (macOS) runs the observers.

/// (R3.13) An accessibility notification the observers take: the first six
/// on each tracked window's element, the rest on its application's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AxNote {
    /// `kAXWindowMovedNotification`: what AppKit posts for a window that
    /// moved (CI's first run: `AXMoved` alone never came for the
    /// simulator's windows).
    WindowMoved,
    /// `kAXWindowResizedNotification` (also full screen in and out).
    WindowResized,
    /// `kAXMovedNotification`: the generic element's move, registered too
    /// for a client that posts it for its windows.
    Moved,
    /// `kAXResizedNotification`, likewise.
    Resized,
    /// `kAXWindowMiniaturizedNotification`.
    Miniaturized,
    /// `kAXWindowDeminiaturizedNotification`.
    Deminiaturized,
    /// `kAXUIElementDestroyedNotification`: the window closed.
    Destroyed,
    /// `kAXTitleChangedNotification`: a tournament table move.
    TitleChanged,
    /// `kAXWindowCreatedNotification` (the application): a table perhaps.
    WindowCreated,
    /// `kAXFocusedWindowChangedNotification` (the application).
    FocusedWindowChanged,
    /// `kAXMainWindowChangedNotification` (the application).
    MainWindowChanged,
    /// `kAXApplicationActivatedNotification`: its windows come forward.
    Activated,
    /// `kAXApplicationHiddenNotification` (Cmd-H).
    Hidden,
    /// `kAXApplicationShownNotification`.
    Shown,
}

impl AxNote {
    /// Registered on each tracked window's element.
    pub const WINDOW: [Self; 8] = [
        Self::WindowMoved,
        Self::WindowResized,
        Self::Moved,
        Self::Resized,
        Self::Miniaturized,
        Self::Deminiaturized,
        Self::Destroyed,
        Self::TitleChanged,
    ];

    /// Registered on the application's element, once per process.
    pub const APP: [Self; 6] = [
        Self::WindowCreated,
        Self::FocusedWindowChanged,
        Self::MainWindowChanged,
        Self::Activated,
        Self::Hidden,
        Self::Shown,
    ];

    /// The notification's name (`kAX...Notification`'s value).
    pub fn name(self) -> &'static str {
        match self {
            Self::WindowMoved => "AXWindowMoved",
            Self::WindowResized => "AXWindowResized",
            Self::Moved => "AXMoved",
            Self::Resized => "AXResized",
            Self::Miniaturized => "AXWindowMiniaturized",
            Self::Deminiaturized => "AXWindowDeminiaturized",
            Self::Destroyed => "AXUIElementDestroyed",
            Self::TitleChanged => "AXTitleChanged",
            Self::WindowCreated => "AXWindowCreated",
            Self::FocusedWindowChanged => "AXFocusedWindowChanged",
            Self::MainWindowChanged => "AXMainWindowChanged",
            Self::Activated => "AXApplicationActivated",
            Self::Hidden => "AXApplicationHidden",
            Self::Shown => "AXApplicationShown",
        }
    }

    /// A notification's name back; `None` for anything not observed.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::WINDOW
            .into_iter()
            .chain(Self::APP)
            .find(|n| n.name() == name)
    }

    /// Whether it is about one window (else about the application).
    pub fn about_window(self) -> bool {
        Self::WINDOW.contains(&self)
    }

    /// What the observers do on it ([`Effect`]).
    pub fn effect(self) -> Effect {
        let none = Effect::default();
        match self {
            Self::WindowMoved | Self::Moved => Effect {
                read: Read::Window,
                settle: true,
                ..none
            },
            Self::WindowResized | Self::Resized => Effect {
                read: Read::Window,
                title_bar: true,
                settle: true,
                ..none
            },
            Self::Miniaturized => Effect {
                read: Read::Window,
                minimized: Some(true),
                ..none
            },
            Self::Deminiaturized => Effect {
                read: Read::Window,
                minimized: Some(false),
                recheck: true,
                ..none
            },
            Self::Destroyed => Effect { gone: true, ..none },
            Self::TitleChanged => Effect {
                title: true,
                ..none
            },
            Self::WindowCreated => Effect {
                appeared: true,
                resolve: true,
                ..none
            },
            Self::FocusedWindowChanged | Self::MainWindowChanged => Effect {
                restack: true,
                resolve: true,
                ..none
            },
            Self::Activated => Effect {
                read: Read::App,
                restack: true,
                resolve: true,
                app_hidden: Some(false),
                recheck: true,
                ..none
            },
            Self::Hidden => Effect {
                read: Read::App,
                app_hidden: Some(true),
                ..none
            },
            Self::Shown => Effect {
                read: Read::App,
                app_hidden: Some(false),
                restack: true,
                recheck: true,
                ..none
            },
        }
    }
}

/// (R3.13) Which tables a notification makes the observers read again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Read {
    #[default]
    None,
    /// The window it is about.
    Window,
    /// Every tracked window of its application.
    App,
}

/// (R3.13) What the observers do on a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Effect {
    /// Read the table (the window server's bounds and on-screen flag) and
    /// move its overlay at once.
    pub read: Read,
    /// Read the title bar again (the Accessibility API's close button and
    /// full screen): the client area's top may have moved.
    pub title_bar: bool,
    /// Read the title (the room's matcher decides, `tracking::events`).
    pub title: bool,
    /// The window is minimised (`true`) or restored.
    pub minimized: Option<bool>,
    /// The application is hidden (`true`) or shown.
    pub app_hidden: Option<bool>,
    /// The window closed (when the window server agrees).
    pub gone: bool,
    /// A window appeared: the engine looks for tables now.
    pub appeared: bool,
    /// The application's windows may have come forward: put the overlays
    /// back directly above their tables now.
    pub restack: bool,
    /// Look for tracked windows whose element was not found yet (a window
    /// on another Space is not in `AXWindows` until it is on this one).
    pub resolve: bool,
    /// Read again a little later too: the window server may not show the
    /// window yet when the notification comes (an animation).
    pub recheck: bool,
    /// A move or a resize: read again within the next frames until the
    /// window server shows it ([`SETTLE`]).
    pub settle: bool,
}

/// (R3.13) When the observers read a table again after a move or a resize:
/// the client posts the notification before the window server's list shows
/// the new place (CI: every move of the simulator's window read unchanged
/// at the notification). Read from the window server only - never the
/// client's own frame, which would mean asking a client busy with the drag
/// (CI: 0.5 s timeouts) and could put an overlay ahead of a later, older
/// window-server reading; the window server's list only moves forward.
pub const SETTLE: [std::time::Duration; 6] = [
    std::time::Duration::from_millis(2),
    std::time::Duration::from_millis(5),
    std::time::Duration::from_millis(10),
    std::time::Duration::from_millis(20),
    std::time::Duration::from_millis(40),
    std::time::Duration::from_millis(100),
];

/// (R3.13) When the observers read a table again after a notification that
/// may come before the window server shows the change (an animation).
pub const RECHECKS: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(150),
    std::time::Duration::from_millis(500),
];

/// (R3.13) How long a window counts as minimised after its
/// `AXWindowMiniaturized` although the window server still shows it (the
/// animation), as Windows' `MINIMIZESTART` hides the overlay early.
pub const MINIMIZING: std::time::Duration = std::time::Duration::from_secs(2);

/// (R3.13) Where a tracked table is, from the window server: its `bounds`
/// (points) less `title_bar`, in pixels at the scale of the display it
/// overlaps most - exactly what the find ([`assemble`]) makes of it, so the
/// observers and the periodic re-find agree to the pixel. Minimised: the
/// empty rect (as the find reports it); off screen (another Space, the app
/// hidden) or `app_hidden`: hidden, the rect kept.
pub fn tracked_geometry(
    bounds: &Frame,
    onscreen: bool,
    title_bar: i64,
    minimized: bool,
    app_hidden: bool,
    displays: &[Display],
) -> Geometry {
    let scale = display_scale(bounds, displays);
    Geometry {
        client: if minimized {
            Rect::default()
        } else {
            to_pixels(&client_frame(bounds, title_bar), scale)
        },
        scale_permille: scale,
        hidden: minimized || app_hidden || !onscreen,
    }
}

/// (R3.13) The title bar of a window at `bounds` (points) whose client
/// area the engine has as `client` (pixels at `scale_permille`): the
/// distance between the two tops, whole points, within the window. What a
/// table tracked without the find's memory (or before it) is read with.
pub fn title_bar_between(bounds: &Frame, client: &Rect, scale_permille: u32) -> i64 {
    let top = rect_points(client, scale_permille).y - bounds.y;
    let whole = (top + MILLI / 2).div_euclid(MILLI) * MILLI;
    whole.clamp(0, bounds.height.max(0))
}

/// (R3.13) How often the AppKit thread checks the overlays' stacking: with
/// the observers putting overlays back on every activation and focus change
/// of their tables' clients (`watched`) the check is only the safety net -
/// a click on a table that raises it over its overlay without changing
/// focus - and runs four times a second; an overlay whose client is not
/// observed (no accessibility, or it refused the observer) keeps R3.12's
/// ten times.
pub fn restack_every(all_watched: bool) -> std::time::Duration {
    std::time::Duration::from_millis(if all_watched { 250 } else { 100 })
}

/// (R3.14) Whether a tracked table is followed by notifications alone, so
/// the engine's periodic look for tables (its Accessibility calls are most
/// of the HUD's idle cost on macOS) may slow down
/// ([`Platform::notified`]): its window's element was found, every window
/// notification that says where it is, whether it is minimised, its title
/// and its end is registered on it, its application announces new windows,
/// and its client has **shown that it posts moves** (a move or resize
/// notification arrived for one of its tables: `posts_moves`). A client
/// with poor accessibility registers and then never posts; it keeps the
/// 500 ms look.
pub fn fully_observed(
    element_found: bool,
    window: &[AxNote],
    app: &[AxNote],
    posts_moves: bool,
) -> bool {
    let has = |notes: &[AxNote], note: AxNote| notes.contains(&note);
    element_found
        && posts_moves
        && (has(window, AxNote::WindowMoved) || has(window, AxNote::Moved))
        && (has(window, AxNote::WindowResized) || has(window, AxNote::Resized))
        && has(window, AxNote::Miniaturized)
        && has(window, AxNote::Deminiaturized)
        && has(window, AxNote::Destroyed)
        && has(window, AxNote::TitleChanged)
        && has(app, AxNote::WindowCreated)
}

/// (R3.14) Whether a notification shows that its client posts moves: a
/// window moved or resized.
pub fn shows_moves(note: AxNote) -> bool {
    matches!(
        note,
        AxNote::WindowMoved | AxNote::Moved | AxNote::WindowResized | AxNote::Resized
    )
}

/// (R3.13) What the observers' thread knows: for tests and diagnostics
/// (`MacosBackend::tracker_info`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrackerInfo {
    /// Per observed process: its pid, the application notifications
    /// registered, and why the observer could not be made (if so).
    pub processes: Vec<(u32, Vec<String>, Option<String>)>,
    /// Per tracked table: whether its window's element was found, the
    /// window notifications registered on it, the geometry last read.
    pub tables: Vec<(WindowId, bool, Vec<String>, Option<Geometry>)>,
    /// Notifications taken.
    pub notes: u64,
    /// How many of each (by name).
    pub by_note: Vec<(String, u64)>,
    /// Overlays moved, shown or hidden from a notification or a read.
    pub follows: u64,
    /// Reads asked for by the engine (its re-find saw something else).
    pub resyncs: u64,
    /// Space changes (every table read again).
    pub space_changes: u64,
    /// Processes seen exit.
    pub exited: Vec<u32>,
    /// Whether the thread may ask the Accessibility API (granted).
    pub trusted: bool,
    /// The observers' thread's CPU time so far, µs.
    pub cpu_us: u64,
    /// The longest a notification took to handle, µs.
    pub slowest_note_us: u64,
    /// The longest one reading of a table (the window server) took, µs.
    pub slowest_read_us: u64,
}

/// (R3.12) The way from the engine's thread to the AppKit thread (the
/// main thread, which owns every overlay window): `appkit::Link` on
/// macOS; never made elsewhere.
#[cfg(target_os = "macos")]
pub use appkit::Link;

/// (R3.12) Never made off macOS.
#[cfg(not(target_os = "macos"))]
#[derive(Debug, Clone)]
pub struct Link(());

/// (R3.12) Run `engine` with AppKit on this thread: the HUD process's
/// `main` on macOS. AppKit's windows and events belong to the main thread,
/// and the engine's loop must never wait on them (nor they on its store
/// reads and accessibility calls, R3.6), so the two run side by side, as
/// on Windows: this thread becomes an accessory application (no Dock icon,
/// never active, never takes the keyboard) that pumps AppKit's events and
/// does what the engine hands it over the [`Link`]; `engine` runs on a
/// thread of its own (`rail-hud-engine`) with the link, and when it
/// returns the overlays close and its exit code is returned here. Not on
/// the main thread (a unit test), or off macOS: `engine(None)` here and
/// now - the backend then draws nothing.
pub fn with_appkit<F>(engine: F) -> i32
where
    F: FnOnce(Option<Link>) -> i32 + Send + 'static,
{
    #[cfg(target_os = "macos")]
    {
        appkit::run(engine)
    }
    #[cfg(not(target_os = "macos"))]
    {
        engine(None)
    }
}

/// The macOS backend.
#[derive(Debug, Default)]
pub struct MacosBackend {
    /// Windows the engine follows, as the engine was last told about them
    /// (by `poll_events`, R3.13) or told the backend (`track`, `follow`).
    tracked: BTreeMap<WindowId, TableWindow>,
    /// Titles read, by window number: a table on another Space keeps its
    /// title.
    memory: BTreeMap<u32, Remembered>,
    /// The matchers of the last find: a new title is read with its room's
    /// (`TableMatcher::matches`, R3.13's `Retitled`).
    matchers: Vec<TableMatcher>,
    /// (R3.12) The AppKit thread, which owns the overlays; `None`: this
    /// backend draws nothing (not the HUD process's main thread, or a
    /// backend made for finding only).
    link: Option<Link>,
    /// (R3.13) The accessibility observers' thread, started with the first
    /// tracked table.
    #[cfg(target_os = "macos")]
    tracker: Option<observe::Tracker>,
    /// (R3.13) It could not be started (said once); the re-find follows.
    #[cfg(target_os = "macos")]
    tracker_failed: bool,
}

impl MacosBackend {
    /// (R3.12) A backend that draws its overlays through `link`
    /// ([`with_appkit`]).
    pub fn with_overlays(link: Option<Link>) -> Self {
        Self {
            tracked: BTreeMap::new(),
            memory: BTreeMap::new(),
            matchers: Vec::new(),
            link,
            #[cfg(target_os = "macos")]
            tracker: None,
            #[cfg(target_os = "macos")]
            tracker_failed: false,
        }
    }

    /// (R3.13) What the observers' thread knows (`None` before the first
    /// tracked table, or off macOS).
    pub fn tracker_info(&self) -> Option<TrackerInfo> {
        #[cfg(target_os = "macos")]
        {
            self.tracker.as_ref()?.info()
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    /// (R3.13) Every follow from a notification so far: µs from the
    /// accessibility notification to the overlay moved, shown or hidden on
    /// the AppKit thread (oldest first; the last 10 000).
    pub fn follow_times_us(&self) -> Vec<u64> {
        #[cfg(target_os = "macos")]
        {
            self.link
                .as_ref()
                .and_then(Link::follow_times)
                .unwrap_or_default()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    }

    /// (R3.13, tests) As if the user switched Spaces: the AppKit thread's
    /// Space notification posted in this process only. Whether it was sent.
    pub fn simulate_space_change(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.link
                .as_ref()
                .is_some_and(|l| l.simulate_space_change().is_ok())
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// (R3.13) The AppKit thread's CPU time so far, µs.
    pub fn appkit_cpu_us(&self) -> Option<u64> {
        #[cfg(target_os = "macos")]
        {
            self.link.as_ref()?.cpu_us()
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    /// (R3.13) Active Space changes the AppKit thread saw.
    pub fn space_changes(&self) -> Option<u64> {
        #[cfg(target_os = "macos")]
        {
            self.link.as_ref()?.space_changes()
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    /// (R3.13) The title bar the find measured for window `id`, thousandths
    /// of a point.
    #[cfg(target_os = "macos")]
    fn title_bar_of(&self, id: WindowId) -> Option<i64> {
        let number = u32::try_from(id.0).ok()?;
        self.memory.get(&number).map(|m| m.title_bar)
    }

    /// (R3.13) The observers' thread, started on first use; `None` when it
    /// cannot be (said once): the engine's re-find follows the tables then.
    #[cfg(target_os = "macos")]
    fn tracker(&mut self) -> Option<&observe::Tracker> {
        if self.tracker.is_none() && !self.tracker_failed {
            match observe::Tracker::start(self.link.clone()) {
                Ok(tracker) => {
                    if let Some(link) = &self.link {
                        let _ = link.on_space_change(tracker.space_changed());
                    }
                    self.tracker = Some(tracker);
                }
                Err(error) => {
                    eprintln!("rail-hud: the accessibility observers: {error}");
                    self.tracker_failed = true;
                }
            }
        }
        self.tracker.as_ref()
    }

    /// (R3.12) What the AppKit thread knows of a table's overlay, after
    /// every command sent before; `None` without one.
    pub fn overlay_info(&self, id: WindowId) -> Option<OverlayInfo> {
        #[cfg(target_os = "macos")]
        {
            self.link.as_ref()?.info(id)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = id;
            None
        }
    }

    /// (R3.12) One pixel of a table's overlay bitmap as last painted:
    /// blue, green, red, alpha, premultiplied (what the layer shows).
    /// Client-relative physical pixels.
    pub fn overlay_pixel(&self, id: WindowId, x: u32, y: u32) -> Option<[u8; 4]> {
        #[cfg(target_os = "macos")]
        {
            self.link.as_ref()?.pixel(id, x, y)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (id, x, y);
            None
        }
    }

    /// (R3.12) Every paint's time so far (µs, oldest first; the last
    /// 10 000).
    pub fn render_times_us(&self) -> Vec<u64> {
        #[cfg(target_os = "macos")]
        {
            self.link.as_ref().and_then(Link::times).unwrap_or_default()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    }

    /// (R3.12, tests) Put a synthetic mouse event on this process's own
    /// event queue, at a point of table `id`'s overlay: what a click or a
    /// drag on a panel would bring, through the same handling. Whether the
    /// AppKit thread posted it (it needs a click window there for a press).
    pub fn inject_mouse(&self, id: WindowId, mouse: Mouse) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.link
                .as_ref()
                .and_then(|l| l.inject(id, mouse))
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (id, mouse);
            false
        }
    }

    /// (R3.12, tests) The window a mouse press at `point` (thousandths of a
    /// point, the global top-left space) would go to, as the window server
    /// hit-tests it (`NSWindow.windowNumberAtPoint`: windows that ignore the
    /// mouse are passed over) - skipping `below` and everything above it
    /// when not 0. `None` without an AppKit thread.
    pub fn window_at(&self, point: (i64, i64), below: u32) -> Option<u32> {
        #[cfg(target_os = "macos")]
        {
            self.link.as_ref()?.window_at(point, below)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (point, below);
            None
        }
    }

    /// (R3.12) The engine's description of a window as an overlay's
    /// geometry (R3.13: what the overlay is made at before the observers
    /// read the table, and what a `Resync` tells them the engine knows).
    #[cfg(target_os = "macos")]
    fn geometry(window: &TableWindow) -> Geometry {
        Geometry {
            client: window.client,
            scale_permille: window.scale_permille,
            hidden: window.minimized,
        }
    }
}

impl Platform for MacosBackend {
    fn name(&self) -> &'static str {
        "macos"
    }

    /// The tables among the windows of the processes the matchers name.
    /// Without the Accessibility permission: `PermissionNeeded` (no title
    /// can be read, so no table can be told).
    fn find_tables(
        &mut self,
        matchers: &[TableMatcher],
    ) -> Result<Vec<TableWindow>, PlatformError> {
        self.matchers = matchers.to_vec();
        if !cfg!(target_os = "macos") || matchers.is_empty() {
            return Ok(Vec::new());
        }
        if !accessibility_granted() {
            return Err(PlatformError::PermissionNeeded(Permission::Accessibility));
        }
        let wanted = |process: &str| matchers.iter().any(|m| m.takes_process(process));
        let snapshot = snapshot(&wanted)?;
        let windows = assemble(&snapshot, &mut self.memory);
        Ok(windows
            .iter()
            .filter_map(|window| table_of(window, matchers))
            .collect())
    }

    /// Follow `window`: (R3.13) its process observed - one `AXObserver`
    /// per process, its window's notifications registered - and its
    /// changes from `poll_events` from now on; the re-find stays the
    /// safety net.
    fn track(&mut self, window: &TableWindow) -> Result<(), PlatformError> {
        if !cfg!(target_os = "macos") {
            return Err(PlatformError::Unsupported("tracking windows (macOS only)"));
        }
        self.tracked.insert(window.id, window.clone());
        #[cfg(target_os = "macos")]
        if let Some(pid) = window.process.pid {
            let title_bar = self.title_bar_of(window.id);
            if let Some(tracker) = self.tracker() {
                tracker.track(
                    window.id,
                    pid,
                    window.title.clone(),
                    title_bar,
                    Self::geometry(window),
                );
            }
        }
        Ok(())
    }

    fn untrack(&mut self, id: WindowId) {
        self.remove_overlay(id);
        self.tracked.remove(&id);
        #[cfg(target_os = "macos")]
        if let Some(tracker) = &self.tracker {
            tracker.untrack(id);
        }
    }

    /// The engine's view of a window. What the observers reported is on
    /// screen already (R3.13); anything else - the re-find saw a change
    /// they did not report, or the backend was never told - makes them
    /// read the table again: an overlay is never placed from a
    /// description, which can be older than what they saw. Without the
    /// observers' thread the overlay follows the description (R3.12).
    fn follow(&mut self, window: &TableWindow) {
        let Some(tracked) = self.tracked.get_mut(&window.id) else {
            return;
        };
        let known = tracked.client == window.client
            && tracked.scale_permille == window.scale_permille
            && tracked.minimized == window.minimized;
        *tracked = window.clone();
        #[cfg(target_os = "macos")]
        {
            let title_bar = self.title_bar_of(window.id);
            if let Some(tracker) = &self.tracker {
                if !known {
                    tracker.resync(window.id, title_bar, Self::geometry(window));
                }
            } else if let Some(link) = &self.link {
                let _ = link.follow(window.id, Self::geometry(window));
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = known;
    }

    /// What the observers saw (R3.13: moves, sizes, minimised and hidden
    /// tables, titles through the room's matcher, closes, a window shown)
    /// and the panels clicked and dropped on the overlays (R3.6 / R3.8)
    /// since the last poll - one event per table and kind
    /// ([`super::tracking::events`]), for tables the engine still follows.
    fn poll_events(&mut self) -> Vec<TableEvent> {
        #[cfg(target_os = "macos")]
        {
            let mut observed = self.link.as_ref().map(Link::observed).unwrap_or_default();
            if let Some(tracker) = &self.tracker {
                observed.absorb(tracker.observed());
            }
            if observed.is_empty() {
                return Vec::new();
            }
            super::tracking::events(observed, &mut self.tracked, &self.matchers)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    }

    /// Hand `frame` to the AppKit thread for the tracked window `id`.
    /// Refused for a window that is not tracked, and for a frame whose
    /// permit is another room's than the window's - the compliance check
    /// made again where the drawing starts (as on Windows).
    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError> {
        let window = self.tracked.get(&id).ok_or(PlatformError::Gone(id))?;
        if frame.permit.site() != window.site {
            return Err(PlatformError::Os(format!(
                "a frame permitted for {} is not for window {} of {}",
                frame.permit.site(),
                id.0,
                window.site
            )));
        }
        let Some(link) = &self.link else {
            return Err(PlatformError::Unsupported(
                "overlays (the HUD process's AppKit thread only)",
            ));
        };
        #[cfg(target_os = "macos")]
        {
            link.frame(id, frame.clone(), Self::geometry(window))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = link;
            Err(PlatformError::Unsupported("overlays (macOS only)"))
        }
    }

    fn remove_overlay(&mut self, id: WindowId) {
        #[cfg(target_os = "macos")]
        if let Some(link) = &self.link {
            let _ = link.remove(id);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = id;
    }

    fn permission_needed(&self) -> Option<Permission> {
        (cfg!(target_os = "macos") && !accessibility_granted()).then_some(Permission::Accessibility)
    }

    /// The system's own Accessibility prompt, which also lists the app in
    /// System Settings (switched off until the user switches it on). Only
    /// when the permission is missing, and only because the user clicked.
    fn request_permission(&mut self, permission: Permission) {
        match permission {
            Permission::Accessibility =>
            {
                #[cfg(target_os = "macos")]
                if !ffi::trusted() {
                    let granted = ffi::prompt();
                    eprintln!(
                        "rail-hud: asked for the Accessibility permission (granted: {granted})"
                    );
                }
            }
        }
    }

    /// The executables with an ordinary window, from the window server's
    /// list (no permission needed): whether a supported client runs.
    fn running_processes(&mut self) -> Option<Vec<String>> {
        running_processes().ok()
    }

    /// (R3.14) Every tracked table followed by the observers alone
    /// ([`fully_observed`]): the observers' thread says so after each of
    /// its steps (an atomic, no message).
    fn notified(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            !self.tracked.is_empty()
                && self
                    .tracker
                    .as_ref()
                    .is_some_and(observe::Tracker::all_observed)
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    fn paint_times_us(&self) -> Vec<u64> {
        self.render_times_us()
    }

    fn follow_times_us(&self) -> Vec<u64> {
        MacosBackend::follow_times_us(self)
    }
}

impl Drop for MacosBackend {
    /// The overlays go with the backend.
    fn drop(&mut self) {
        let ids: Vec<WindowId> = self.tracked.keys().copied().collect();
        for id in ids {
            self.remove_overlay(id);
        }
    }
}

/// (R3.11) The executables of the processes that have an ordinary window
/// (layer 0) now - `proc_pidpath`'s file name, else the window server's
/// owner name -, sorted, once each. Needs no permission. macOS only.
pub fn running_processes() -> Result<Vec<String>, PlatformError> {
    #[cfg(target_os = "macos")]
    {
        let windows = ffi::cg_windows()?;
        let mut pids: BTreeMap<u32, String> = BTreeMap::new();
        for window in windows.iter().filter(|w| w.layer == 0) {
            pids.entry(window.pid)
                .or_insert_with(|| window.owner.clone());
        }
        let mut names: Vec<String> = pids
            .into_iter()
            .map(|(pid, owner)| ffi::process_name(pid).unwrap_or(owner))
            .filter(|name| !name.is_empty())
            .collect();
        names.sort();
        names.dedup();
        Ok(names)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(PlatformError::Unsupported("listing processes (macOS only)"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cg(id: u32, pid: u32, bounds: Frame, onscreen: bool) -> CgWindow {
        CgWindow {
            id,
            pid,
            owner: "Sim".into(),
            bounds,
            layer: 0,
            onscreen,
        }
    }

    fn ax(title: &str, frame: Frame) -> AxWindow {
        AxWindow {
            title: title.into(),
            frame: Some(frame),
            subrole: "AXStandardWindow".into(),
            // A standard title bar: the close button 14 x 16 pt, 6 pt down.
            close_button: Some(Frame {
                x: frame.x + 7 * MILLI,
                y: frame.y + 6 * MILLI,
                width: 14 * MILLI,
                height: 16 * MILLI,
            }),
            ..AxWindow::default()
        }
    }

    const RETINA: Display = Display {
        bounds: Frame::points(0, 0, 1512, 982),
        scale_permille: 2000,
    };
    const PLAIN: Display = Display {
        bounds: Frame::points(1512, 0, 1920, 1080),
        scale_permille: 1000,
    };

    /// Points become pixels at the screen's scale, rounded as winit
    /// rounds; scales come from the display mode.
    #[test]
    fn points_and_pixels() {
        let frame = Frame::points(100, 50, 640, 480);
        assert_eq!(
            to_pixels(&frame, 2000),
            Rect {
                x: 200,
                y: 100,
                width: 1280,
                height: 960
            }
        );
        assert_eq!(
            to_pixels(&frame, 1000),
            Rect {
                x: 100,
                y: 50,
                width: 640,
                height: 480
            }
        );
        // Half a point at 1x rounds away from zero, both ways.
        let half = Frame {
            x: 10_500,
            y: -10_500,
            width: 1_499,
            height: 0,
        };
        assert_eq!(
            to_pixels(&half, 1000),
            Rect {
                x: 11,
                y: -11,
                width: 1,
                height: 0
            }
        );
        // A display left of the main one has negative coordinates.
        assert_eq!(to_pixels(&Frame::points(-1920, 0, 1, 1), 2000).x, -3840);
        assert_eq!(milli(28.0), 28_000);
        assert_eq!(milli(0.4996), 500);
        assert_eq!(milli(f64::NAN), 0);
        assert_eq!(scale_permille(3024, 1512), 2000);
        assert_eq!(scale_permille(1920, 1920), 1000);
        assert_eq!(scale_permille(0, 0), 1000);
        // The dpi `RawWindow` carries gives the scale back.
        for scale in [1000, 2000, 3000] {
            assert_eq!(super::super::dpi_permille(dpi_of(scale)), scale);
        }
    }

    /// The scale is the display a window overlaps most; the main one's when
    /// it overlaps none.
    #[test]
    fn the_screen_of_a_window() {
        let displays = [RETINA, PLAIN];
        assert_eq!(
            display_scale(&Frame::points(10, 10, 640, 480), &displays),
            2000
        );
        assert_eq!(
            display_scale(&Frame::points(1600, 10, 640, 480), &displays),
            1000
        );
        // Straddling: more on the plain display.
        assert_eq!(
            display_scale(&Frame::points(1400, 10, 640, 480), &displays),
            1000
        );
        assert_eq!(
            display_scale(&Frame::points(1100, 10, 640, 480), &displays),
            2000
        );
        assert_eq!(
            display_scale(&Frame::points(-5000, 0, 10, 10), &displays),
            2000
        );
        assert_eq!(display_scale(&Frame::points(0, 0, 10, 10), &[]), 1000);
    }

    /// The title bar from the close button; none in full screen or without
    /// one; the client area below it.
    #[test]
    fn title_bars() {
        let bounds = Frame::points(100, 50, 640, 508);
        let window = ax("T", bounds);
        assert_eq!(title_bar(&window, &bounds), 28 * MILLI);
        assert_eq!(
            client_frame(&bounds, title_bar(&window, &bounds)),
            Frame::points(100, 78, 640, 480)
        );
        // A toolbar window: the buttons sit lower, the bar is taller.
        let mut tall = window.clone();
        tall.close_button = Some(Frame::points(107, 68, 14, 16));
        assert_eq!(title_bar(&tall, &bounds), 52 * MILLI);
        // A fraction of a point rounds to whole points.
        let mut odd = window.clone();
        odd.close_button = Some(Frame {
            x: 0,
            y: 56_250,
            width: 14_000,
            height: 16_000,
        });
        assert_eq!(title_bar(&odd, &bounds), 29 * MILLI);
        let mut full = window.clone();
        full.fullscreen = true;
        assert_eq!(title_bar(&full, &bounds), 0);
        let mut borderless = window.clone();
        borderless.close_button = None;
        assert_eq!(title_bar(&borderless, &bounds), 0);
        // Never more than the window, never negative.
        let mut wild = window;
        wild.close_button = Some(Frame::points(0, 5000, 1, 1));
        assert_eq!(title_bar(&wild, &bounds), bounds.height);
        wild.close_button = Some(Frame::points(0, -100, 1, 1));
        assert_eq!(title_bar(&wild, &bounds), 0);
        assert_eq!(
            client_frame(&Frame::points(0, 0, 10, 10), 20 * MILLI).height,
            0
        );
    }

    /// Accessibility windows pair with the window server's by number, else
    /// by frame in front-to-back order: two tables stacked at one place
    /// pair in z-order, a window the system numbers is never paired by
    /// frame, a frame a point off still pairs.
    #[test]
    fn pairing() {
        let here = Frame::points(10, 10, 640, 508);
        let there = Frame::points(700, 10, 640, 508);
        let a = cg(101, 7, here, true);
        let b = cg(102, 7, here, true);
        let c = cg(103, 7, there, true);
        let windows = [&a, &b, &c];

        // Frames only: the stacked pair in order, the third by place.
        let list = [ax("front", here), ax("other", there), ax("back", here)];
        assert_eq!(pair(&windows, &list), [Some(0), Some(2), Some(1)]);

        // Numbers win over frames and order.
        let mut numbered = list.clone();
        numbered[0].window_id = Some(102);
        numbered[2].window_id = Some(101);
        assert_eq!(pair(&windows, &numbered), [Some(2), Some(0), Some(1)]);
        // A number that names none of them: not paired by frame either.
        let mut stranger = list.clone();
        stranger[0].window_id = Some(999);
        assert_eq!(pair(&windows, &stranger), [Some(2), None, Some(1)]);

        // A point off pairs; two points off do not; no frame never pairs.
        let mut near = ax("near", there);
        near.frame = Some(Frame {
            x: there.x + 1000,
            y: there.y - 800,
            ..there
        });
        assert_eq!(pair(&[&c], &[near.clone()]), [Some(0)]);
        near.frame = Some(Frame {
            x: there.x + 2000,
            ..there
        });
        assert_eq!(pair(&[&c], &[near.clone()]), [None]);
        near.frame = None;
        assert_eq!(pair(&[&c], &[near]), [None]);
        assert_eq!(pair(&[], &list), Vec::<Option<usize>>::new());
    }

    fn snapshot(cg: Vec<CgWindow>, ax: Vec<AxWindow>) -> Snapshot {
        Snapshot {
            cg,
            order: Vec::new(),
            names: BTreeMap::from([(7, "rail-hud-sim".to_owned())]),
            ax: BTreeMap::from([(7, Ok(ax))]),
            displays: vec![RETINA, PLAIN],
        }
    }

    /// The joined view: titles, client rects in pixels at the right
    /// screen's scale, minimised and off-screen windows marked, other
    /// processes and other layers left out, front-to-back order kept; a
    /// window on another Space keeps the title read before.
    #[test]
    fn raw_windows_from_both_sources() {
        let left = Frame::points(10, 30, 640, 508);
        let right = Frame::points(1600, 30, 640, 508);
        let mut menu = cg(900, 7, Frame::points(0, 0, 100, 20), true);
        menu.layer = 25;
        let stranger = cg(500, 8, left, true);
        let windows = vec![
            stranger,
            cg(201, 7, right, true),
            menu,
            cg(202, 7, left, true),
            cg(203, 7, left, false),
        ];
        let mut minimised = ax("Table C - 6-max", left);
        minimised.minimized = true;
        minimised.window_id = Some(203);
        let list = vec![
            ax("Table A - 6-max", left),
            ax("Table B - 6-max", right),
            minimised,
        ];
        let mut memory = BTreeMap::new();
        let raw = assemble(&snapshot(windows.clone(), list.clone()), &mut memory);
        let summary: Vec<(u64, &str, Rect, u32, bool, bool)> = raw
            .iter()
            .map(|w| {
                (
                    w.id.0,
                    w.title.as_str(),
                    w.client,
                    super::super::dpi_permille(w.monitor_dpi),
                    w.minimized,
                    w.cloaked,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    201,
                    "Table B - 6-max",
                    Rect {
                        x: 1600,
                        y: 58,
                        width: 640,
                        height: 480
                    },
                    1000,
                    false,
                    false
                ),
                (
                    202,
                    "Table A - 6-max",
                    Rect {
                        x: 20,
                        y: 116,
                        width: 1280,
                        height: 960
                    },
                    2000,
                    false,
                    false
                ),
                (203, "Table C - 6-max", Rect::default(), 2000, true, false),
            ]
        );
        assert!(
            raw.iter()
                .all(|w| w.process == "rail-hud-sim" && w.pid == 7)
        );
        assert_eq!(raw[0].class, "AXStandardWindow");
        assert_eq!(memory.len(), 3);

        // Table A moves to another Space: off screen, gone from the
        // accessibility list; its title is remembered and it is cloaked.
        // Table B is closed: forgotten.
        let mut away = windows.clone();
        away.retain(|w| w.id != 201);
        if let Some(w) = away.iter_mut().find(|w| w.id == 202) {
            w.onscreen = false;
        }
        let raw = assemble(&snapshot(away.clone(), vec![list[2].clone()]), &mut memory);
        let a = raw.iter().find(|w| w.id.0 == 202).expect("table A");
        assert_eq!(a.title, "Table A - 6-max");
        assert!(a.cloaked && !a.minimized);
        assert_eq!(a.client.y, 116, "its rect kept");
        assert!(!memory.contains_key(&201));

        // An on-screen window without an accessibility partner has no
        // title (a fresh window, or a client that hides its windows from
        // the API); an off-screen one never seen is left out.
        let mut fresh = away;
        fresh.push(cg(204, 7, right, true));
        let raw = assemble(
            &snapshot(fresh, vec![list[2].clone()]),
            &mut BTreeMap::new(),
        );
        let ids: Vec<(u64, &str)> = raw.iter().map(|w| (w.id.0, w.title.as_str())).collect();
        assert_eq!(ids, [(203, "Table C - 6-max"), (204, "")]);

        // A process whose windows were not asked for is not listed.
        let mut other = snapshot(windows, list);
        other.ax.clear();
        assert!(assemble(&other, &mut BTreeMap::new()).is_empty());
    }

    /// Through a room's matcher: the backend's tables are `table_of` these
    /// windows - a cloaked (other Space) table is a hidden table.
    #[test]
    fn tables_from_raw_windows() {
        let left = Frame::points(10, 30, 640, 508);
        let mut memory = BTreeMap::new();
        let matcher = TableMatcher::simulator(
            "pokerstars",
            regex::Regex::new(r"^(?P<table>.+?) - (?P<seats>\d+)-max$").expect("regex"),
        );
        let raw = assemble(
            &snapshot(
                vec![cg(202, 7, left, true)],
                vec![ax("Hygiea IV - 6-max", left)],
            ),
            &mut memory,
        );
        let table = table_of(&raw[0], std::slice::from_ref(&matcher)).expect("a table");
        assert_eq!(table.table.as_deref(), Some("Hygiea IV"));
        assert_eq!((table.size, table.scale_permille), (Some(6), 2000));
        assert_eq!(table.client.height, 960);
        let raw = assemble(
            &snapshot(vec![cg(202, 7, left, false)], vec![]),
            &mut memory,
        );
        let hidden = table_of(&raw[0], &[matcher]).expect("still a table");
        assert!(hidden.minimized);
    }

    /// (R3.12) The engine's pixels back in points, exactly, at 1x, 2x and
    /// 3x - also for odd pixel counts on Retina (half points) and negative
    /// coordinates (a display left of or above the main one).
    #[test]
    fn pixels_back_to_points() {
        let frame = Frame::points(100, 50, 640, 480);
        for scale in [1000, 2000, 3000] {
            assert_eq!(
                rect_points(&to_pixels(&frame, scale), scale),
                frame,
                "{scale}"
            );
        }
        // A window on a display left of the main one, and above it.
        let left = Frame::points(-1500, -200, 800, 600);
        for scale in [1000, 2000] {
            assert_eq!(rect_points(&to_pixels(&left, scale), scale), left);
        }
        // Half points on Retina: 201 px at 2x is 100.5 pt.
        let odd = Rect {
            x: 201,
            y: -3,
            width: 1281,
            height: 961,
        };
        assert_eq!(
            rect_points(&odd, 2000),
            Frame {
                x: 100_500,
                y: -1_500,
                width: 640_500,
                height: 480_500,
            }
        );
        // An unknown scale (0) counts as 1x rather than dividing by zero.
        assert_eq!(
            rect_points(&odd, 0).width,
            1_281_000_000,
            "0 is clamped to 1 thousandth"
        );
    }

    /// (R3.12) AppKit's frame of a client area: flipped against the **main**
    /// display's height, whichever display the table is on - the main one
    /// (Retina), one to its right (1x), one below or above it.
    #[test]
    fn appkit_frames_flip_against_the_main_display() {
        // The main display: 1512 x 982 pt at 2x (a 14" MacBook Pro).
        let main_height = 982 * MILLI;
        // A table client 640 x 480 pt at (100, 60) pt on the main display:
        // in pixels at 2x, as the engine has it.
        let client = Rect {
            x: 200,
            y: 120,
            width: 1280,
            height: 960,
        };
        assert_eq!(
            appkit_frame(&client, 2000, main_height),
            Frame::points(100, 982 - 60 - 480, 640, 480)
        );
        // On a 1x display to the right of the main one (x from 1512 pt),
        // taller than it: its lower part goes below AppKit's y = 0.
        let right = Rect {
            x: 1600,
            y: 700,
            width: 640,
            height: 480,
        };
        assert_eq!(
            appkit_frame(&right, 1000, main_height),
            Frame::points(1600, 982 - 700 - 480, 640, 480)
        );
        assert!(appkit_frame(&right, 1000, main_height).y < 0);
        // A display above the main one (negative y in the window server's
        // space): above AppKit's main display, so y > its height.
        let above = Rect {
            x: 0,
            y: -900,
            width: 640,
            height: 480,
        };
        let frame = appkit_frame(&above, 1000, main_height);
        assert_eq!(frame, Frame::points(0, 982 + 900 - 480, 640, 480));
        assert!(frame.y > main_height);
        // Flipping twice is the identity.
        let any = Frame::points(-300, 1200, 640, 480);
        assert_eq!(to_appkit(&to_appkit(&any, main_height), main_height), any);
    }

    /// (R3.12) A mouse location in AppKit's space back to the client pixel
    /// the scene laid out: the corners of a Retina table, a 1x one on
    /// another display, a point outside (a drag past the edge).
    #[test]
    fn mouse_points_become_client_pixels() {
        let main_height = 982 * MILLI;
        let client = Rect {
            x: 200,
            y: 120,
            width: 1280,
            height: 960,
        };
        let frame = appkit_frame(&client, 2000, main_height);
        // The client's top-left corner in AppKit is (x, y + height).
        let top_left = (frame.x, frame.y + frame.height);
        assert_eq!(client_pixel(top_left, &client, 2000, main_height), (0, 0));
        // Half a point in on Retina is one pixel.
        assert_eq!(
            client_pixel(
                (top_left.0 + 500, top_left.1 - 500),
                &client,
                2000,
                main_height
            ),
            (1, 1)
        );
        let bottom_right = (frame.x + frame.width, frame.y);
        assert_eq!(
            client_pixel(bottom_right, &client, 2000, main_height),
            (1280, 960)
        );
        // A 1x table right of the main display.
        let right = Rect {
            x: 1600,
            y: 700,
            width: 640,
            height: 480,
        };
        let frame = appkit_frame(&right, 1000, main_height);
        assert_eq!(
            client_pixel(
                (frame.x + 10 * MILLI, frame.y + frame.height - 20 * MILLI),
                &right,
                1000,
                main_height
            ),
            (10, 20)
        );
        // Dragged past the left edge: negative, not clamped (the scene
        // constrains the panel).
        assert_eq!(
            client_pixel((frame.x - 5 * MILLI, frame.y), &right, 1000, main_height),
            (-5, 480)
        );
    }

    /// (R3.12) Stacking: the overlay directly above its table, its click
    /// windows directly above it in any order; anything else restacks;
    /// a table not on the active Space is away.
    #[test]
    fn stacking_over_the_table() {
        let (table, overlay) = (40, 90);
        let hits = [91, 92];
        assert_eq!(
            stacking(&[7, 92, 91, 90, 40, 3], table, overlay, &hits),
            Stacking::Fine
        );
        assert_eq!(
            stacking(&[91, 92, 90, 40], table, overlay, &hits),
            Stacking::Fine
        );
        assert_eq!(stacking(&[90, 40], table, overlay, &[]), Stacking::Fine);
        // The table raised over its overlay (a click on it).
        assert_eq!(
            stacking(&[40, 92, 91, 90, 3], table, overlay, &hits),
            Stacking::Restack
        );
        // Another window got between the overlay and the table.
        assert_eq!(
            stacking(&[92, 91, 90, 55, 40], table, overlay, &hits),
            Stacking::Restack
        );
        // Between the overlay and a click window: it would take the clicks
        // meant for that window's own content.
        assert_eq!(
            stacking(&[92, 55, 91, 90, 40], table, overlay, &hits),
            Stacking::Restack
        );
        // A click window missing (ordered out by someone), the overlay on
        // another Space.
        assert_eq!(
            stacking(&[91, 90, 40], table, overlay, &hits),
            Stacking::Restack
        );
        assert_eq!(
            stacking(&[92, 91, 40], table, overlay, &hits),
            Stacking::Restack
        );
        // The table not on this Space (minimised, hidden, elsewhere).
        assert_eq!(
            stacking(&[92, 91, 90, 3], table, overlay, &hits),
            Stacking::Away
        );
        assert_eq!(stacking(&[], table, overlay, &hits), Stacking::Away);
    }

    /// (R3.13) The on-screen order, not the `OptionAll` list's, is z-order:
    /// two tables stacked at one place pair by it (the frame fallback), and
    /// the joined view lists them in it, off-screen windows last.
    #[test]
    fn z_order_is_the_onscreen_order() {
        let here = Frame::points(10, 10, 640, 508);
        // The `OptionAll` list has the back window first.
        let back = cg(301, 7, here, true);
        let front = cg(302, 7, here, true);
        let away = cg(303, 7, Frame::points(900, 10, 640, 508), false);
        let listed = [&away, &back, &front];
        let order = [302, 55, 301];
        let sorted: Vec<u32> = z_ordered(&listed, &order).iter().map(|w| w.id).collect();
        assert_eq!(
            sorted,
            [302, 301, 303],
            "on screen by z-order, then off screen"
        );
        assert_eq!(
            z_ordered(&listed, &[])
                .iter()
                .map(|w| w.id)
                .collect::<Vec<_>>(),
            [303, 301, 302],
            "no order: the list's own"
        );
        // Frames only: the accessibility list's front window pairs with
        // the window server's front one.
        let ax_list = [ax("front table", here), ax("back table", here)];
        let mut snap = snapshot(
            vec![away.clone(), back.clone(), front.clone()],
            ax_list.to_vec(),
        );
        snap.order = order.to_vec();
        let raw = assemble(&snap, &mut BTreeMap::new());
        let titles: Vec<(u64, &str)> = raw.iter().map(|w| (w.id.0, w.title.as_str())).collect();
        assert_eq!(titles, [(302, "front table"), (301, "back table")]);
        // Without the order (R3.11's assumption) the pairing is the wrong
        // way round: what this fixes.
        let snap = snapshot(vec![away, back, front], ax_list.to_vec());
        let raw = assemble(&snap, &mut BTreeMap::new());
        assert_eq!(raw[0].id.0, 301);
        assert_eq!(raw[0].title, "front table");
    }

    /// (R3.13) The notifications observed, each once, by name; what each
    /// makes the observers do.
    #[test]
    fn what_a_notification_does() {
        let all: Vec<AxNote> = AxNote::WINDOW.into_iter().chain(AxNote::APP).collect();
        for note in &all {
            assert_eq!(AxNote::from_name(note.name()), Some(*note));
            assert_eq!(note.about_window(), AxNote::WINDOW.contains(note));
        }
        let mut names: Vec<&str> = all.iter().map(|n| n.name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 14, "fourteen distinct notifications");
        assert_eq!(AxNote::from_name("AXValueChanged"), None);
        assert_eq!(AxNote::from_name("AXFocusedUIElementChanged"), None);

        // A move reads the window only; nothing else.
        assert_eq!(AxNote::WindowMoved.effect(), AxNote::Moved.effect());
        assert_eq!(AxNote::WindowResized.effect(), AxNote::Resized.effect());
        let moved = AxNote::WindowMoved.effect();
        assert_eq!(moved.read, Read::Window);
        assert!(!moved.title_bar && !moved.restack && !moved.recheck && !moved.gone);
        // ... and again over the next frames, until the window server
        // shows the move.
        assert!(moved.settle && AxNote::WindowResized.effect().settle);
        assert!(!AxNote::TitleChanged.effect().settle);
        assert!(SETTLE.windows(2).all(|w| w[0] < w[1]));
        // A resize reads the title bar again too (full screen has none).
        assert!(AxNote::Resized.effect().title_bar);
        assert_eq!(AxNote::Miniaturized.effect().minimized, Some(true));
        let restored = AxNote::Deminiaturized.effect();
        assert_eq!(restored.minimized, Some(false));
        assert!(restored.recheck, "the window server may lag the animation");
        let destroyed = AxNote::Destroyed.effect();
        assert!(destroyed.gone && destroyed.read == Read::None);
        assert!(AxNote::TitleChanged.effect().title);
        let created = AxNote::WindowCreated.effect();
        assert!(created.appeared && created.resolve);
        // Activation and focus: the overlays go back above their tables
        // now; activation also shows a hidden app's.
        for note in [
            AxNote::FocusedWindowChanged,
            AxNote::MainWindowChanged,
            AxNote::Activated,
        ] {
            assert!(note.effect().restack, "{note:?}");
        }
        assert_eq!(AxNote::Activated.effect().app_hidden, Some(false));
        assert_eq!(AxNote::Activated.effect().read, Read::App);
        let hidden = AxNote::Hidden.effect();
        assert_eq!((hidden.read, hidden.app_hidden), (Read::App, Some(true)));
        let shown = AxNote::Shown.effect();
        assert_eq!((shown.read, shown.app_hidden), (Read::App, Some(false)));
        assert!(shown.recheck && shown.restack);
        // Only the window's own notifications act on one window.
        for note in all {
            if note.effect().read == Read::Window
                || note.effect().gone
                || note.effect().title
                || note.effect().minimized.is_some()
            {
                assert!(note.about_window(), "{note:?}");
            }
        }
    }

    /// (R3.13) A table read from the window server is what the find makes
    /// of it: the same client rect at the same scale; minimised is the
    /// empty rect, off screen (another Space) and a hidden app are hidden
    /// with the rect kept - what `tracking::plan` orders out.
    #[test]
    fn a_table_read_by_the_observers() {
        let displays = [RETINA, PLAIN];
        let bounds = Frame::points(10, 30, 640, 508);
        let bar = 28 * MILLI;
        let on = tracked_geometry(&bounds, true, bar, false, false, &displays);
        // The find's view of the same window (`assemble`).
        let mut memory = BTreeMap::new();
        let raw = assemble(
            &snapshot(
                vec![cg(202, 7, bounds, true)],
                vec![ax("T - 6-max", bounds)],
            ),
            &mut memory,
        );
        assert_eq!(on.client, raw[0].client);
        assert_eq!(on.scale_permille, 2000);
        assert!(!on.hidden && on.shows());
        // Another Space: hidden, the rect kept (the overlay is ordered out
        // and comes back where it was).
        let away = tracked_geometry(&bounds, false, bar, false, false, &displays);
        assert!(away.hidden && !away.shows());
        assert_eq!(away.client, on.client);
        // Minimised: the find's empty rect.
        let min = tracked_geometry(&bounds, false, bar, true, false, &displays);
        assert!(min.hidden);
        assert_eq!(min.client, Rect::default());
        // The app hidden (Cmd-H) - even while the window server still
        // shows it.
        assert!(tracked_geometry(&bounds, true, bar, false, true, &displays).hidden);
        // On the plain display: 1x.
        let right = tracked_geometry(
            &Frame::points(1600, 30, 640, 508),
            true,
            bar,
            false,
            false,
            &displays,
        );
        assert_eq!(right.scale_permille, 1000);
        assert_eq!(right.client.x, 1600);
        // Full screen: no title bar, the whole window.
        let full = tracked_geometry(&bounds, true, 0, false, false, &displays);
        assert_eq!(full.client.height, 1016);
        // The title bar recovered from the engine's client rect.
        assert_eq!(title_bar_between(&bounds, &on.client, 2000), bar);
        assert_eq!(title_bar_between(&bounds, &full.client, 2000), 0);
        let wild = Rect {
            y: -5000,
            ..on.client
        };
        assert_eq!(title_bar_between(&bounds, &wild, 2000), 0, "never negative");
    }

    /// (R3.13) A Space change, as the observers' thread handles it: every
    /// table read again - the one now on another Space hidden, the one on
    /// this Space shown - and `tracking::plan` orders the overlays out
    /// and in; nothing is repainted.
    #[test]
    fn a_space_change_hides_and_shows() {
        use super::super::tracking::{Placed, Plan, plan};
        let displays = [PLAIN];
        let bounds = Frame::points(100, 100, 640, 512);
        let bar = 32 * MILLI;
        let here = tracked_geometry(&bounds, true, bar, false, false, &displays);
        let placed = Placed {
            shown: true,
            at: (here.client.x, here.client.y),
            painted: Some(here.size()),
        };
        // Switched away: the table is off screen now.
        let gone = tracked_geometry(&bounds, false, bar, false, false, &displays);
        assert_eq!(plan(&placed, &gone, false), Plan::Hide);
        // Switched back: shown where it was, not repainted.
        let hidden = Placed {
            shown: false,
            ..placed
        };
        assert_eq!(plan(&hidden, &here, false), Plan::Show);
        // Nothing changed for a table on neither: kept.
        assert_eq!(plan(&placed, &here, false), Plan::Keep);
    }

    /// (R3.13) The stacking look slows down only when every shown overlay's
    /// client is observed.
    /// (R3.14) The engine's look slows only for a table whose window and
    /// application notifications are all registered and whose client has
    /// shown it posts moves.
    #[test]
    fn a_table_is_fully_observed() {
        let app = [AxNote::WindowCreated, AxNote::Activated];
        let window = AxNote::WINDOW;
        assert!(fully_observed(true, &window, &app, true));
        assert!(!fully_observed(false, &window, &app, true), "no element");
        assert!(
            !fully_observed(true, &window, &app, false),
            "never seen to post a move"
        );
        assert!(
            !fully_observed(true, &window, &[AxNote::Activated], true),
            "new windows not announced"
        );
        for missing in [
            AxNote::Miniaturized,
            AxNote::Deminiaturized,
            AxNote::Destroyed,
            AxNote::TitleChanged,
        ] {
            let fewer: Vec<AxNote> = window.iter().copied().filter(|n| *n != missing).collect();
            assert!(
                !fully_observed(true, &fewer, &app, true),
                "{} not registered",
                missing.name()
            );
        }
        // Either form of a move and of a resize will do.
        let generic: Vec<AxNote> = window
            .iter()
            .copied()
            .filter(|n| !matches!(n, AxNote::WindowMoved | AxNote::WindowResized))
            .collect();
        assert!(fully_observed(true, &generic, &app, true));
        let no_moves: Vec<AxNote> = window
            .iter()
            .copied()
            .filter(|n| !matches!(n, AxNote::WindowMoved | AxNote::Moved))
            .collect();
        assert!(!fully_observed(true, &no_moves, &app, true));
        assert!(shows_moves(AxNote::WindowMoved) && shows_moves(AxNote::Resized));
        assert!(!shows_moves(AxNote::TitleChanged) && !shows_moves(AxNote::Activated));
    }

    #[test]
    fn the_stacking_look_slows_when_observed() {
        assert!(restack_every(true) > restack_every(false));
        assert_eq!(restack_every(false), std::time::Duration::from_millis(100));
        assert!(restack_every(true) <= std::time::Duration::from_millis(250));
    }

    /// Off macOS the backend finds nothing and asks for nothing.
    #[test]
    fn permission_off_macos() {
        let backend = MacosBackend::default();
        if !cfg!(target_os = "macos") {
            assert_eq!(backend.permission_needed(), None);
            assert!(cg_windows().is_err());
        }
        assert_eq!(
            Permission::from_name("accessibility"),
            Some(Permission::Accessibility)
        );
        assert_eq!(Permission::Accessibility.as_str(), "accessibility");
        assert_eq!(Permission::from_name("screen-recording"), None);
    }
}

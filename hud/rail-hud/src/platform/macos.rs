//! macOS (R3.11 - R3.13).
//!
//! - **R3.11 `find_tables`** (done): two sources, joined.
//!   1. **The window server's list**, `CGWindowListCopyWindowInfo`
//!      (`OptionAll | ExcludeDesktopElements`: windows on screen *and* off
//!      it - minimised, on another Space, of a hidden app), front to back:
//!      the window number (`CGWindowID`, the [`WindowId`]), the owner's pid,
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
//!   sides - so two tables stacked at one place pair in z-order.
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
//! - **R3.12 `overlay`**: a borderless, transparent, non-activating
//!   `NSPanel` per table ordered above it - AppKit wants the main thread,
//!   which is why [`super::Platform`] is driven from the HUD's one loop
//!   thread; that loop will run inside the AppKit run loop then. Position
//!   it in points: the client rect divided by `scale_permille`.
//! - **R3.13 `track` / `poll_events`**: an `AXObserver` per process (moved,
//!   resized, miniaturised, destroyed, title changed), `CGWindowList`
//!   polling as the fallback.
//!
//! **`unsafe`** lives in `ffi` only (compiled on macOS), one small function
//! per call with its own `#[allow(unsafe_code)]` and a `// SAFETY:` comment
//! per block, as in `windows.rs`. Everything here is plain Rust, compiled
//! and unit-tested on every system; off macOS the backend finds nothing.

use std::collections::BTreeMap;

use super::{
    DpiAwareness, OverlayFrame, Permission, Platform, PlatformError, RawWindow, Rect, TableEvent,
    TableMatcher, TableWindow, WindowId, table_of,
};

#[cfg(target_os = "macos")]
mod ffi;

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

/// What one look at the system saw: the window server's windows (front to
/// back), the executables of their processes, the accessibility windows of
/// the processes looked at, the displays (the main one first).
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub cg: Vec<CgWindow>,
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

/// Which accessibility window each of one process's window-server windows
/// is (`cg` and `ax` both front to back): by the window number the system
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
    // Front to back across processes, as the window server lists them.
    let order: BTreeMap<u32, usize> = snapshot
        .cg
        .iter()
        .enumerate()
        .map(|(i, w)| (w.id, i))
        .collect();
    out.sort_by_key(|(id, _)| order.get(id).copied().unwrap_or(usize::MAX));
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

/// The window server's windows alone, front to back - bounds, pid, layer,
/// on screen; no title (that is the Accessibility API's). Needs no
/// permission. macOS only.
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

/// Every ordinary window of the processes `wanted` takes, front to back,
/// titles through the Accessibility API (empty without the permission):
/// what `--list-windows` prints. One look, nothing remembered. macOS only.
pub fn enumerate(wanted: &dyn Fn(&str) -> bool) -> Result<Vec<RawWindow>, PlatformError> {
    let snapshot = snapshot(wanted)?;
    Ok(assemble(&snapshot, &mut BTreeMap::new()))
}

/// The macOS backend.
#[derive(Debug, Default)]
pub struct MacosBackend {
    /// Windows the engine follows (R3.13 observes them; until then the
    /// engine's re-find does).
    tracked: BTreeMap<WindowId, TableWindow>,
    /// Titles read, by window number: a table on another Space keeps its
    /// title.
    memory: BTreeMap<u32, Remembered>,
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

    /// Follow `window`: recorded (R3.13 adds the observers); its changes
    /// reach the engine through its re-find meanwhile.
    fn track(&mut self, window: &TableWindow) -> Result<(), PlatformError> {
        if !cfg!(target_os = "macos") {
            return Err(PlatformError::Unsupported("tracking windows (macOS only)"));
        }
        self.tracked.insert(window.id, window.clone());
        Ok(())
    }

    fn untrack(&mut self, id: WindowId) {
        self.tracked.remove(&id);
    }

    fn follow(&mut self, window: &TableWindow) {
        if let Some(tracked) = self.tracked.get_mut(&window.id) {
            *tracked = window.clone();
        }
    }

    fn poll_events(&mut self) -> Vec<TableEvent> {
        Vec::new()
    }

    /// Refused for a window that is not tracked or a frame permitted for
    /// another room (as on Windows); otherwise not yet (R3.12).
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
        Err(PlatformError::Unsupported("overlays (R3.12)"))
    }

    fn remove_overlay(&mut self, _: WindowId) {}

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

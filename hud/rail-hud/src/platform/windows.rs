//! Windows (R3.3 - R3.5).
//!
//! - **R3.3 `find_tables`** (done): [`enumerate`] lists every visible
//!   top-level window - `EnumWindows`; the title (`GetWindowTextW`, which
//!   reads the caption Windows keeps and never waits on the window's
//!   thread), the class, the owning process (`GetWindowThreadProcessId` ->
//!   `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` ->
//!   `QueryFullProcessImageNameW`, the file name kept); minimised
//!   (`IsIconic`) and cloaked (`DwmGetWindowAttribute(DWMWA_CLOAKED)`: on
//!   another virtual desktop) marked, not dropped; the client area with
//!   `GetClientRect` + `ClientToScreen` in **physical pixels** (the calling
//!   thread is switched to per-monitor DPI awareness v2 for the walk, and
//!   the HUD process is made so at start, [`init_process_dpi_awareness`]);
//!   the scale is the monitor's effective dpi (`MonitorFromWindow` +
//!   `GetDpiForMonitor`, 96 = 1000) - what an overlay draws at; the
//!   window's own `GetDpiForWindow` and DPI awareness are kept too (a
//!   client that is not per-monitor aware says 96 and is stretched by
//!   Windows). Then each window through the rooms' matchers
//!   ([`super::table_of`]). Every match is returned, allowed or not:
//!   compliance mode in the engine decides.
//! - **R3.4 `overlay`** (done; `overlay.rs`): one window per table,
//!   `WS_POPUP` with `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`,
//!   **owned by the table window** (its owner at creation): Windows keeps an
//!   owned window directly above its owner, hides it while the owner is
//!   minimised and destroys it with the owner; the tool style keeps it off
//!   the taskbar and Alt+Tab, no-activate (and `MA_NOACTIVATE`) keeps a
//!   click from taking focus from the table. It covers the table's client
//!   area exactly, in physical pixels, from a thread that is per-monitor
//!   DPI aware (v2). Its pixels are a premultiplied 32-bit DIB painted by
//!   **Direct2D** (a software DC render target) with **DirectWrite** text
//!   (grayscale anti-aliasing: ClearType needs an opaque background) and
//!   shown with `UpdateLayeredWindow` (`ULW_ALPHA`): everything but the
//!   panels is alpha 0, and Windows hit-tests a layered window by its
//!   alpha, so a click anywhere but on a panel reaches the table (the
//!   window procedure also answers `WM_NCHITTEST` with `HTTRANSPARENT`
//!   outside the panels). Hidden while the table is minimised or cloaked.
//!   Redrawn only when the frame or the client size or scale changes; a
//!   move only moves the window. The windows live on a thread of their own
//!   that does nothing but wait for messages and paint: a cross-process
//!   owner shares the table's input queue state with ours, so that thread
//!   must never block - the store, the matching and the engine stay on the
//!   loop thread, which hands it frames over a channel.
//! - R3.5 `track` / `poll_events`: `SetWinEventHook` (location change,
//!   minimise start/end, name change, destroy) on the room's process, its
//!   callback queueing [`super::TableEvent`]s that `poll_events` drains.
//!   Until then `track` records the window and the engine's periodic
//!   re-find (every 500 ms) picks up titles, rects and minimise and hands
//!   them to [`Platform::follow`].
//!
//! **Why Direct2D rather than a CPU rasteriser.** Correct text first:
//! DirectWrite shapes and falls back across fonts the way the rest of
//! Windows does (a name in any script, if R3.8 shows one), with the
//! system's hinting at the monitor's real pixel size, and Direct2D's
//! anti-aliasing writes correct premultiplied alpha into the layered
//! surface - GDI text would need its alpha rebuilt by hand, and a CPU
//! rasteriser (tiny-skia) needs a font file and a shaper of its own, new
//! crates for the lock file. Both run on the CPU here (a software render
//! target: no GPU read-back per frame, the same on a CI runner without a
//! GPU); a panel redraw costs one clear of the client-sized surface, a few
//! rounded rectangles and short text runs. Measured on the Windows CI
//! runner with the simulator's twelve tables: docs/RAIL-PLAN.md R3.4.
//!
//! **`unsafe`.** The crate is `deny(unsafe_code)` and every other module
//! `forbid`s it. Here, and only here (`ffi`, `overlay`, `probe`, all
//! compiled on Windows only), each Win32 call sits in a small function that
//! carries its own `#[allow(unsafe_code)]` and a `// SAFETY:` comment per
//! block. None of them keeps a pointer past the call except the overlay
//! surface's DIB bits, which live exactly as long as their bitmap; window
//! handles may go stale at any moment (a table closes mid-walk), which
//! Win32 reports as a failure, and a failure only drops that window or
//! that detail.
//!
//! On other systems this module compiles to a backend that finds nothing
//! and draws nothing.

use std::collections::BTreeMap;

use super::{
    OverlayFrame, Platform, PlatformError, RawWindow, Rect, TableEvent, TableMatcher, TableWindow,
    WindowId, table_of,
};

#[cfg(windows)]
mod overlay;
#[cfg(windows)]
pub mod probe;

/// The overlay windows' class name (R3.4): what a test or a diagnostic
/// looks for among a process's windows.
pub const OVERLAY_CLASS: &str = "RailHudOverlay";

/// Extended window styles, as `GetWindowLongPtrW(GWL_EXSTYLE)` reads them.
pub mod ex_style {
    pub const TOPMOST: u32 = 0x0000_0008;
    pub const TRANSPARENT: u32 = 0x0000_0020;
    pub const TOOLWINDOW: u32 = 0x0000_0080;
    pub const APPWINDOW: u32 = 0x0004_0000;
    pub const LAYERED: u32 = 0x0008_0000;
    pub const NOACTIVATE: u32 = 0x0800_0000;
}

/// What the overlay thread knows of one table's overlay (tests and
/// diagnostics: `WindowsBackend::overlay_info`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OverlayInfo {
    /// The overlay window (`None` until it exists, or when creating it
    /// failed: see `error`).
    pub window: Option<WindowId>,
    /// Whether it is showing.
    pub shown: bool,
    /// How many times it was painted.
    pub renders: u64,
    /// The last paint's time (scene, Direct2D, `UpdateLayeredWindow`), µs.
    pub last_render_us: u64,
    /// The size it was last painted at.
    pub painted: (u32, u32),
    /// Its panels, client-relative: where it takes clicks.
    pub panels: Vec<Rect>,
    /// Seats whose panel the layout dropped.
    pub dropped: Vec<String>,
    /// The last failure, if any.
    pub error: Option<String>,
}

/// Every visible top-level window, in z-order (topmost first). Windows
/// only; elsewhere [`PlatformError::Unsupported`].
pub fn enumerate() -> Result<Vec<RawWindow>, PlatformError> {
    #[cfg(windows)]
    {
        ffi::enumerate()
    }
    #[cfg(not(windows))]
    {
        Err(PlatformError::Unsupported(
            "listing windows (Windows only; macOS is R3.11)",
        ))
    }
}

/// Make this process per-monitor DPI aware (v2), so that every window
/// API it calls speaks physical pixels and its overlays (R3.4) are not
/// stretched. Call before any window is made; an error means the
/// awareness was set already (a manifest, an earlier call). A no-op
/// elsewhere.
pub fn init_process_dpi_awareness() -> Result<(), PlatformError> {
    #[cfg(windows)]
    {
        ffi::set_process_per_monitor_v2()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// The Windows backend.
#[derive(Debug, Default)]
pub struct WindowsBackend {
    /// Windows the engine follows, as it last described them (R3.5 hooks
    /// them).
    tracked: BTreeMap<WindowId, TableWindow>,
    /// The overlay thread, started with the first overlay.
    #[cfg(windows)]
    overlays: Option<overlay::OverlayThread>,
}

impl WindowsBackend {
    /// What the overlay thread knows of a table's overlay; `None` when it
    /// has none (or off Windows). Answered after every command sent before
    /// it, so it shows their effect.
    pub fn overlay_info(&self, id: WindowId) -> Option<OverlayInfo> {
        #[cfg(windows)]
        {
            self.overlays.as_ref()?.info(id)
        }
        #[cfg(not(windows))]
        {
            let _ = id;
            None
        }
    }

    /// One pixel of a table's overlay surface as last painted: blue,
    /// green, red, alpha, premultiplied (the DIB `UpdateLayeredWindow`
    /// shows). Client-relative physical pixels.
    pub fn overlay_pixel(&self, id: WindowId, x: u32, y: u32) -> Option<[u8; 4]> {
        #[cfg(windows)]
        {
            self.overlays.as_ref()?.pixel(id, x, y)
        }
        #[cfg(not(windows))]
        {
            let _ = (id, x, y);
            None
        }
    }

    /// Every paint's time so far (µs, oldest first; the last 10 000).
    pub fn render_times_us(&self) -> Vec<u64> {
        #[cfg(windows)]
        {
            self.overlays
                .as_ref()
                .map(overlay::OverlayThread::times)
                .unwrap_or_default()
        }
        #[cfg(not(windows))]
        {
            Vec::new()
        }
    }
}

impl Platform for WindowsBackend {
    fn name(&self) -> &'static str {
        "windows"
    }

    fn find_tables(
        &mut self,
        matchers: &[TableMatcher],
    ) -> Result<Vec<TableWindow>, PlatformError> {
        if matchers.is_empty() || !cfg!(windows) {
            return Ok(Vec::new());
        }
        Ok(enumerate()?
            .iter()
            .filter_map(|window| table_of(window, matchers))
            .collect())
    }

    fn track(&mut self, window: &TableWindow) -> Result<(), PlatformError> {
        if !cfg!(windows) {
            return Err(PlatformError::Unsupported(
                "tracking windows (Windows only)",
            ));
        }
        self.tracked.insert(window.id, window.clone());
        Ok(())
    }

    fn untrack(&mut self, id: WindowId) {
        self.remove_overlay(id);
        self.tracked.remove(&id);
    }

    fn follow(&mut self, window: &TableWindow) {
        let Some(tracked) = self.tracked.get_mut(&window.id) else {
            return;
        };
        *tracked = window.clone();
        #[cfg(windows)]
        if let Some(thread) = &self.overlays {
            thread.geometry(window);
        }
    }

    fn poll_events(&mut self) -> Vec<TableEvent> {
        // R3.5. Meanwhile the engine's re-find sees what changed.
        Vec::new()
    }

    /// Hand `frame` to the overlay thread (started on first use) for the
    /// tracked window `id`. Refused for a window that is not tracked, and
    /// for a frame whose permit is another room's than the window's - the
    /// compliance check made again where the drawing starts.
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
        #[cfg(windows)]
        {
            if self.overlays.is_none() {
                self.overlays = Some(overlay::OverlayThread::start()?);
            }
            let thread = self
                .overlays
                .as_ref()
                .ok_or(PlatformError::Unsupported("overlays"))?;
            thread.frame(window, frame.clone())
        }
        #[cfg(not(windows))]
        {
            Err(PlatformError::Unsupported("overlays (Windows only)"))
        }
    }

    fn remove_overlay(&mut self, id: WindowId) {
        #[cfg(windows)]
        if let Some(thread) = &self.overlays {
            thread.remove(id);
        }
        #[cfg(not(windows))]
        let _ = id;
    }
}

#[cfg(windows)]
mod ffi {
    //! The Win32 calls. Each function is one concern and allows `unsafe`
    //! for itself only.

    use std::collections::HashMap;

    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, MONITOR_DEFAULTTONEAREST, MonitorFromWindow,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        DPI_AWARENESS_PER_MONITOR_AWARE, DPI_AWARENESS_SYSTEM_AWARE, DPI_AWARENESS_UNAWARE,
        GetAwarenessFromDpiAwarenessContext, GetDpiForMonitor, GetDpiForWindow,
        GetWindowDpiAwarenessContext, MDT_EFFECTIVE_DPI, SetProcessDpiAwarenessContext,
        SetThreadDpiAwarenessContext,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetClientRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };
    use windows::core::{BOOL, PWSTR};

    use super::super::{DpiAwareness, PlatformError, RawWindow, Rect, WindowId};

    pub(super) fn enumerate() -> Result<Vec<RawWindow>, PlatformError> {
        let _dpi = ThreadDpi::per_monitor_v2();
        let mut names: HashMap<u32, String> = HashMap::new();
        let mut out = Vec::new();
        for hwnd in top_level_windows()? {
            if !is_visible(hwnd) {
                continue;
            }
            let pid = process_id(hwnd);
            let process = names
                .entry(pid)
                .or_insert_with(|| process_name(pid).unwrap_or_default())
                .clone();
            let minimized = is_iconic(hwnd);
            let client = if minimized {
                Rect::default()
            } else {
                client_rect(hwnd).unwrap_or_default()
            };
            let (window_dpi, monitor_dpi, awareness) = dpi_of(hwnd);
            out.push(RawWindow {
                id: id_of(hwnd),
                pid,
                process,
                class: class_name(hwnd),
                title: window_text(hwnd),
                client,
                monitor_dpi,
                window_dpi,
                awareness,
                minimized,
                cloaked: is_cloaked(hwnd),
            });
        }
        Ok(out)
    }

    /// The handle's value: stable while the window lives.
    pub(super) fn id_of(hwnd: HWND) -> WindowId {
        WindowId(u64::try_from(hwnd.0.addr()).unwrap_or(0))
    }

    /// The handle a [`WindowId`] stands for (a value, never dereferenced
    /// by us: Win32 checks it and fails on a stale one).
    pub(super) fn hwnd_of(id: WindowId) -> HWND {
        HWND(std::ptr::without_provenance_mut(
            usize::try_from(id.0).unwrap_or(0),
        ))
    }

    /// The calling thread per-monitor aware (v2) while it lives, the
    /// previous awareness back on drop. Not `Send` (it holds the context's
    /// raw pointer), so it is dropped on the thread that made it.
    pub(super) struct ThreadDpi(DPI_AWARENESS_CONTEXT);

    impl ThreadDpi {
        #[allow(unsafe_code)]
        pub(super) fn per_monitor_v2() -> Self {
            // SAFETY: changes only this thread's DPI awareness and has no
            // memory preconditions; it returns the previous context (null
            // when the request was refused), restored by `drop`.
            let previous =
                unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
            Self(previous)
        }
    }

    impl Drop for ThreadDpi {
        #[allow(unsafe_code)]
        fn drop(&mut self) {
            if !self.0.0.is_null() {
                // SAFETY: restores the context `per_monitor_v2` got back on
                // this same thread (the guard cannot leave it).
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
    }

    #[allow(unsafe_code)]
    pub(super) fn set_process_per_monitor_v2() -> Result<(), PlatformError> {
        // SAFETY: no memory preconditions; it fails (access denied) when
        // the process's awareness is already set, and then changes nothing.
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
            .map_err(|e| PlatformError::Os(format!("SetProcessDpiAwarenessContext: {e}")))
    }

    /// `EnumWindows`' callback: pushes each handle into the `Vec<HWND>`
    /// whose address is `lparam`.
    #[allow(unsafe_code)]
    extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let handles = std::ptr::with_exposed_provenance_mut::<Vec<HWND>>(lparam.0.cast_unsigned());
        // SAFETY: `top_level_windows` passes the address of a live
        // `Vec<HWND>` it owns exclusively and does not touch until
        // `EnumWindows` returns; `EnumWindows` calls this synchronously on
        // the same thread, never after it returns.
        unsafe { (*handles).push(hwnd) };
        BOOL(1)
    }

    #[allow(unsafe_code)]
    pub(super) fn top_level_windows() -> Result<Vec<HWND>, PlatformError> {
        let mut handles: Vec<HWND> = Vec::new();
        let lparam = LPARAM(
            std::ptr::from_mut(&mut handles)
                .expose_provenance()
                .cast_signed(),
        );
        // SAFETY: `collect` only pushes into `handles` (see there), which
        // outlives the call; the callback never unwinds (a `Vec` push
        // aborts on allocation failure).
        unsafe { EnumWindows(Some(collect), lparam) }
            .map_err(|e| PlatformError::Os(format!("EnumWindows: {e}")))?;
        Ok(handles)
    }

    #[allow(unsafe_code)]
    pub(super) fn is_visible(hwnd: HWND) -> bool {
        // SAFETY: reads a flag; a stale handle reads as not visible.
        unsafe { IsWindowVisible(hwnd) }.as_bool()
    }

    #[allow(unsafe_code)]
    fn is_iconic(hwnd: HWND) -> bool {
        // SAFETY: reads a flag; a stale handle reads as not minimised.
        unsafe { IsIconic(hwnd) }.as_bool()
    }

    #[allow(unsafe_code)]
    pub(super) fn process_id(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        // SAFETY: `pid` is a valid out pointer for the call; a stale
        // handle leaves it 0.
        unsafe { GetWindowThreadProcessId(hwnd, Some(std::ptr::from_mut(&mut pid))) };
        pid
    }

    /// The executable's file name, `None` when the process cannot be
    /// asked (another user's or a protected one) or is gone.
    #[allow(unsafe_code)]
    fn process_name(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        // SAFETY: no memory preconditions; failure (access denied, no such
        // process) is an `Err`.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = u32::try_from(buf.len()).unwrap_or(0);
        // SAFETY: `handle` is the live process handle opened above; `buf`
        // is writable for `len` UTF-16 units and `len` is in/out - the call
        // writes at most that many and stores how many it wrote.
        let named = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                std::ptr::from_mut(&mut len),
            )
        };
        // SAFETY: closes the handle opened above, once.
        let _ = unsafe { CloseHandle(handle) };
        named.ok()?;
        let len = usize::try_from(len).ok()?.min(buf.len());
        let path = String::from_utf16_lossy(&buf[..len]);
        let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
        Some(name.to_owned())
    }

    #[allow(unsafe_code)]
    fn window_text(hwnd: HWND) -> String {
        // SAFETY: no memory preconditions; a stale handle gives 0.
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        let Some(len) = usize::try_from(len).ok().filter(|&n| n > 0) else {
            return String::new();
        };
        // The length can grow between the two calls: the copy is cut to
        // the buffer, which is all the title anyone needs.
        let mut buf = vec![0u16; len + 1];
        // SAFETY: the wrapper passes `buf`'s length as the maximum, so the
        // call writes at most that many units (terminator included).
        let copied = unsafe { GetWindowTextW(hwnd, &mut buf) };
        let copied = usize::try_from(copied).unwrap_or(0).min(buf.len());
        String::from_utf16_lossy(&buf[..copied])
    }

    #[allow(unsafe_code)]
    pub(super) fn class_name(hwnd: HWND) -> String {
        // Class names are at most 256 characters.
        let mut buf = vec![0u16; 257];
        // SAFETY: as in `window_text`: the wrapper passes the buffer's
        // length as the maximum.
        let copied = unsafe { GetClassNameW(hwnd, &mut buf) };
        let copied = usize::try_from(copied).unwrap_or(0).min(buf.len());
        String::from_utf16_lossy(&buf[..copied])
    }

    /// The client area in screen coordinates, physical pixels (the thread
    /// is per-monitor aware while `enumerate` runs).
    #[allow(unsafe_code)]
    fn client_rect(hwnd: HWND) -> Option<Rect> {
        let mut rect = RECT::default();
        // SAFETY: `rect` is a valid out pointer for the call; a stale
        // handle is an `Err`.
        unsafe { GetClientRect(hwnd, std::ptr::from_mut(&mut rect)) }.ok()?;
        let mut origin = POINT {
            x: rect.left,
            y: rect.top,
        };
        // SAFETY: `origin` is a valid in/out pointer for the call.
        let mapped = unsafe { ClientToScreen(hwnd, std::ptr::from_mut(&mut origin)) };
        if !mapped.as_bool() {
            return None;
        }
        Some(Rect {
            x: origin.x,
            y: origin.y,
            width: u32::try_from(rect.right.saturating_sub(rect.left)).unwrap_or(0),
            height: u32::try_from(rect.bottom.saturating_sub(rect.top)).unwrap_or(0),
        })
    }

    #[allow(unsafe_code)]
    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        let size = u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4);
        // SAFETY: `DWMWA_CLOAKED` writes one `u32` (`DWM_CLOAKED_*` flags);
        // the pointer is to one, and `size` says so.
        let read = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                std::ptr::from_mut(&mut cloaked).cast(),
                size,
            )
        };
        read.is_ok() && cloaked != 0
    }

    /// (the window's dpi, its monitor's effective dpi, its awareness); 0
    /// for what could not be read.
    #[allow(unsafe_code)]
    fn dpi_of(hwnd: HWND) -> (u32, u32, DpiAwareness) {
        // SAFETY: no memory preconditions; a stale handle gives 0.
        let window = unsafe { GetDpiForWindow(hwnd) };
        // SAFETY: no memory preconditions; with DEFAULTTONEAREST it always
        // names a monitor (null only for a handle that is gone).
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut x = 0u32;
        let mut y = 0u32;
        let monitor_dpi = if monitor.is_invalid() {
            0
        } else {
            // SAFETY: `x` and `y` are valid out pointers for the call.
            let read = unsafe {
                GetDpiForMonitor(
                    monitor,
                    MDT_EFFECTIVE_DPI,
                    std::ptr::from_mut(&mut x),
                    std::ptr::from_mut(&mut y),
                )
            };
            if read.is_ok() { x } else { 0 }
        };
        // SAFETY: no memory preconditions; an invalid context (a stale
        // handle) gives DPI_AWARENESS_INVALID.
        let awareness =
            unsafe { GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd)) };
        let awareness = if awareness == DPI_AWARENESS_UNAWARE {
            DpiAwareness::Unaware
        } else if awareness == DPI_AWARENESS_SYSTEM_AWARE {
            DpiAwareness::System
        } else if awareness == DPI_AWARENESS_PER_MONITOR_AWARE {
            DpiAwareness::PerMonitor
        } else {
            DpiAwareness::Unknown
        };
        (window, monitor_dpi, awareness)
    }
}

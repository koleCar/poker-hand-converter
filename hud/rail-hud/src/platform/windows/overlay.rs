//! The overlay windows (R3.4): their thread, their window procedure, their
//! surfaces and the Direct2D painter. See the parent module's header for
//! the design; every function that calls Win32 allows `unsafe` for itself
//! and says why each block is sound.
//!
//! **The thread.** Started with the first overlay; it makes itself
//! per-monitor DPI aware (v2), creates its message queue, registers the
//! window class and the painter, then waits in `GetMessageW`. Commands
//! come over a channel; a thread message (`WAKE`) is posted when the
//! channel goes from empty to not, and the thread drains it whole. It owns
//! every overlay window (a window belongs to the thread that made it), so
//! everything that touches one happens here. Queries (`info`, `pixel`,
//! `times`) answer over a channel of their own, after every command sent
//! before them.

use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D_RECT_F, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1_DRAW_TEXT_OPTIONS_CLIP, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT,
    D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_SOFTWARE, D2D1_RENDER_TARGET_USAGE_NONE,
    D2D1_ROUNDED_RECT, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE, D2D1CreateFactory, ID2D1DCRenderTarget,
    ID2D1Factory, ID2D1SolidColorBrush,
};
use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_MEASURING_MODE_NATURAL,
    DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_WORD_WRAPPING_NO_WRAP,
    DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteTextFormat,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC,
    HBITMAP, HDC, HGDIOBJ, ReleaseDC, SelectObject,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HTTRANSPARENT,
    IsWindowVisible, MA_NOACTIVATE, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
    RegisterClassExW, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    SetWindowPos, ShowWindow, ULW_ALPHA, UpdateLayeredWindow, WM_APP, WM_DPICHANGED,
    WM_MOUSEACTIVATE, WM_NCHITTEST, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_POPUP,
};
use windows::core::{PCWSTR, w};

use super::super::{OverlayFrame, PlatformError, Rect, TableWindow, WindowId};
use super::OverlayInfo;
use super::ffi::{ThreadDpi, hwnd_of, id_of};
use crate::layout;
use crate::panel::PanelDesign;
use crate::scene::{Item, Rgba, Scene, compose};

/// The thread message that says "the channel has commands".
const WAKE: u32 = WM_APP + 0x52;

/// Paint times kept for `times` (the most recent).
const KEEP_TIMES: usize = 10_000;

/// How long a query waits for the thread.
const ASK: Duration = Duration::from_secs(10);

/// Where and how a table is: what its overlay covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Geometry {
    /// The table's client area, physical screen pixels.
    client: Rect,
    scale: u32,
    /// Minimised or cloaked: the overlay is hidden.
    hidden: bool,
}

impl Geometry {
    fn of(window: &TableWindow) -> Self {
        Self {
            client: window.client,
            scale: window.scale_permille,
            hidden: window.minimized,
        }
    }
}

enum Command {
    Frame {
        table: WindowId,
        geometry: Geometry,
        frame: Box<OverlayFrame>,
    },
    Geometry {
        table: WindowId,
        geometry: Geometry,
    },
    Remove {
        table: WindowId,
    },
    Info {
        table: WindowId,
        reply: Sender<Option<OverlayInfo>>,
    },
    Pixel {
        table: WindowId,
        x: u32,
        y: u32,
        reply: Sender<Option<[u8; 4]>>,
    },
    Times {
        reply: Sender<Vec<u64>>,
    },
    Quit,
}

/// The handle the backend holds: the thread, its channel, its id.
pub(in crate::platform) struct OverlayThread {
    thread_id: u32,
    commands: Mutex<Sender<Command>>,
    /// A `WAKE` is posted and not yet taken.
    pending: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl std::fmt::Debug for OverlayThread {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OverlayThread")
            .field("thread_id", &self.thread_id)
            .finish_non_exhaustive()
    }
}

impl OverlayThread {
    /// Start the thread; fails when it cannot make its window class or
    /// its painter (no Direct2D).
    pub(in crate::platform) fn start() -> Result<Self, PlatformError> {
        let (commands, receiver) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        let pending = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&pending);
        let join = std::thread::Builder::new()
            .name("rail-hud-overlays".to_owned())
            .spawn(move || run(&receiver, &ready, &flag))
            .map_err(|e| PlatformError::Os(format!("the overlay thread: {e}")))?;
        match started.recv_timeout(ASK) {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                commands: Mutex::new(commands),
                pending,
                join: Some(join),
            }),
            Ok(Err(error)) => {
                let _ = join.join();
                Err(PlatformError::Os(error))
            }
            Err(_) => Err(PlatformError::Os(
                "the overlay thread did not start".to_owned(),
            )),
        }
    }

    fn send(&self, command: Command) -> Result<(), PlatformError> {
        self.commands
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .send(command)
            .map_err(|_| PlatformError::Os("the overlay thread has stopped".to_owned()))?;
        if !self.pending.swap(true, Ordering::SeqCst) {
            post_wake(self.thread_id)?;
        }
        Ok(())
    }

    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Command) -> Option<T> {
        let (reply, answer) = mpsc::channel();
        self.send(make(reply)).ok()?;
        answer.recv_timeout(ASK).ok()
    }

    pub(in crate::platform) fn frame(
        &self,
        window: &TableWindow,
        frame: OverlayFrame,
    ) -> Result<(), PlatformError> {
        self.send(Command::Frame {
            table: window.id,
            geometry: Geometry::of(window),
            frame: Box::new(frame),
        })
    }

    pub(in crate::platform) fn geometry(&self, window: &TableWindow) {
        let _ = self.send(Command::Geometry {
            table: window.id,
            geometry: Geometry::of(window),
        });
    }

    pub(in crate::platform) fn remove(&self, table: WindowId) {
        let _ = self.send(Command::Remove { table });
    }

    pub(in crate::platform) fn info(&self, table: WindowId) -> Option<OverlayInfo> {
        self.ask(|reply| Command::Info { table, reply }).flatten()
    }

    pub(in crate::platform) fn pixel(&self, table: WindowId, x: u32, y: u32) -> Option<[u8; 4]> {
        self.ask(|reply| Command::Pixel { table, x, y, reply })
            .flatten()
    }

    pub(in crate::platform) fn times(&self) -> Vec<u64> {
        self.ask(|reply| Command::Times { reply })
            .unwrap_or_default()
    }
}

impl Drop for OverlayThread {
    /// Every overlay window is destroyed by its thread on the way out.
    fn drop(&mut self) {
        if self.send(Command::Quit).is_ok()
            && let Some(join) = self.join.take()
        {
            let _ = join.join();
        }
    }
}

#[allow(unsafe_code)]
fn post_wake(thread_id: u32) -> Result<(), PlatformError> {
    // SAFETY: posts a message carrying no pointers to a thread id; a
    // thread that is gone makes it fail, which is reported.
    unsafe { PostThreadMessageW(thread_id, WAKE, WPARAM(0), LPARAM(0)) }
        .map_err(|e| PlatformError::Os(format!("PostThreadMessageW: {e}")))
}

/// The thread's body.
fn run(commands: &Receiver<Command>, ready: &Sender<Result<u32, String>>, pending: &AtomicBool) {
    let _dpi = ThreadDpi::per_monitor_v2();
    let thread_id = make_queue();
    let setup = register_class().and_then(|()| Painter::new());
    let painter = match setup {
        Ok(painter) => painter,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if ready.send(Ok(thread_id)).is_err() {
        return;
    }
    let mut state = Overlays {
        painter,
        design: PanelDesign::default(),
        windows: HashMap::new(),
        times: Vec::new(),
    };
    'pump: while let Some(message) = next_message() {
        if message.hwnd.is_invalid() && message.message == WAKE {
            pending.store(false, Ordering::SeqCst);
            while let Ok(command) = commands.try_recv() {
                if !state.handle(command) {
                    break 'pump;
                }
            }
        } else {
            dispatch(&message);
        }
    }
    state.close_all();
}

/// Make this thread's message queue (a thread has none until it asks for
/// one), so `PostThreadMessageW` reaches it; its id.
#[allow(unsafe_code)]
fn make_queue() -> u32 {
    let mut message = MSG::default();
    // SAFETY: `message` is a valid out pointer; PM_NOREMOVE takes nothing
    // off the (new, empty) queue.
    let _ = unsafe { PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE) };
    // SAFETY: no preconditions.
    unsafe { GetCurrentThreadId() }
}

/// The next message, `None` on `WM_QUIT` or an error.
#[allow(unsafe_code)]
fn next_message() -> Option<MSG> {
    let mut message = MSG::default();
    // SAFETY: `message` is a valid out pointer for the call.
    let got = unsafe { GetMessageW(&mut message, None, 0, 0) };
    (got.0 > 0).then_some(message)
}

#[allow(unsafe_code)]
fn dispatch(message: &MSG) {
    // SAFETY: a message `GetMessageW` just filled in, for a window of this
    // thread (or none).
    unsafe {
        DispatchMessageW(message);
    }
}

fn class_name() -> PCWSTR {
    w!("RailHudOverlay")
}

#[allow(unsafe_code)]
fn register_class() -> Result<(), String> {
    // SAFETY: no preconditions; `None` asks for this executable's module.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {e}"))?;
    let class = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(window_proc),
        hInstance: module.into(),
        lpszClassName: class_name(),
        ..Default::default()
    };
    // SAFETY: `class` is fully initialised and its strings are static; a
    // class already registered (a second overlay thread in one process)
    // returns 0, which is fine: the procedure is the same.
    let _ = unsafe { RegisterClassExW(&class) };
    Ok(())
}

/// Per overlay window (by handle value): its screen origin and its
/// panels, for `WM_NCHITTEST`.
type HitMap = HashMap<usize, (i32, i32, Vec<Rect>)>;

thread_local! {
    static HIT: RefCell<HitMap> = RefCell::new(HashMap::new());
}

/// The overlay windows' procedure (on the overlay thread only).
#[allow(unsafe_code)]
extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        // Clicks outside the panels fall through to the window below
        // (Windows also skips the surface's alpha-0 pixels by itself).
        WM_NCHITTEST => {
            let (x, y) = point_of(lparam);
            let on_panel = HIT.with(|hit| {
                hit.borrow()
                    .get(&hwnd.0.addr())
                    .is_some_and(|(ox, oy, panels)| {
                        panels.iter().any(|r| {
                            layout::contains(r, x.saturating_sub(*ox), y.saturating_sub(*oy))
                        })
                    })
            });
            if on_panel {
                // SAFETY: the default answer for this window's own message.
                unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
            } else {
                LRESULT(isize::try_from(HTTRANSPARENT).unwrap_or(-1))
            }
        }
        // A click on a panel never activates the overlay (nor takes focus
        // from the table).
        WM_MOUSEACTIVATE => LRESULT(isize::try_from(MA_NOACTIVATE).unwrap_or(3)),
        // The overlay follows the table's client area, not the suggested
        // rectangle.
        WM_DPICHANGED => LRESULT(0),
        // SAFETY: the default handling of this window's own message.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// The screen point packed in a mouse message's `lparam` (two signed
/// 16-bit halves).
fn point_of(lparam: LPARAM) -> (i32, i32) {
    let bits = lparam.0.to_le_bytes();
    (
        i32::from(i16::from_le_bytes([bits[0], bits[1]])),
        i32::from(i16::from_le_bytes([bits[2], bits[3]])),
    )
}

/// One table's overlay.
struct Overlay {
    hwnd: HWND,
    geometry: Geometry,
    frame: Option<OverlayFrame>,
    /// Needs painting (a new frame) before it shows.
    dirty: bool,
    /// What it was last painted at: client size and scale.
    painted: Option<(u32, u32, u32)>,
    /// Where it was last put (screen).
    at: (i32, i32),
    surface: Option<Surface>,
    scene: Scene,
    renders: u64,
    last_render_us: u64,
    error: Option<String>,
}

/// Everything on the thread.
struct Overlays {
    painter: Painter,
    design: PanelDesign,
    windows: HashMap<WindowId, Overlay>,
    times: Vec<u64>,
}

impl Overlays {
    /// One command; `false` ends the thread.
    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Frame {
                table,
                geometry,
                frame,
            } => self.frame(table, geometry, *frame),
            Command::Geometry { table, geometry } => {
                if let Some(overlay) = self.windows.get_mut(&table) {
                    overlay.geometry = geometry;
                    self.sync(table);
                }
            }
            Command::Remove { table } => {
                if let Some(overlay) = self.windows.remove(&table) {
                    close(overlay);
                }
            }
            Command::Info { table, reply } => {
                let _ = reply.send(self.windows.get(&table).map(info));
            }
            Command::Pixel { table, x, y, reply } => {
                let pixel = self
                    .windows
                    .get(&table)
                    .and_then(|o| o.surface.as_ref())
                    .and_then(|s| s.pixel(x, y));
                let _ = reply.send(pixel);
            }
            Command::Times { reply } => {
                let _ = reply.send(self.times.clone());
            }
            Command::Quit => return false,
        }
        true
    }

    fn frame(&mut self, table: WindowId, geometry: Geometry, frame: OverlayFrame) {
        if let Entry::Vacant(slot) = self.windows.entry(table) {
            let overlay = match create_window(table, &geometry) {
                Ok(hwnd) => Overlay {
                    hwnd,
                    geometry,
                    frame: None,
                    dirty: true,
                    painted: None,
                    at: (geometry.client.x, geometry.client.y),
                    surface: None,
                    scene: Scene::default(),
                    renders: 0,
                    last_render_us: 0,
                    error: None,
                },
                Err(error) => {
                    eprintln!("rail-hud: overlay for window {}: {error}", table.0);
                    return;
                }
            };
            slot.insert(overlay);
        }
        if let Some(overlay) = self.windows.get_mut(&table) {
            // The same frame again (a re-read that changed nothing) is not
            // painted again.
            if overlay.frame.as_ref() != Some(&frame) {
                overlay.frame = Some(frame);
                overlay.dirty = true;
            }
            overlay.geometry = geometry;
        }
        self.sync(table);
    }

    /// Bring a table's overlay in line with its frame and geometry: paint
    /// when the frame, the size or the scale changed, move when only the
    /// position did, hide while the table is minimised or cloaked.
    fn sync(&mut self, table: WindowId) {
        let Some(overlay) = self.windows.get_mut(&table) else {
            return;
        };
        let g = overlay.geometry;
        if g.hidden || g.client.width == 0 || g.client.height == 0 {
            show(overlay.hwnd, false);
            return;
        }
        let size = (g.client.width, g.client.height, g.scale);
        if overlay.dirty || overlay.painted != Some(size) {
            match paint(&mut self.painter, &self.design, overlay) {
                Ok(us) => {
                    overlay.error = None;
                    if self.times.len() >= KEEP_TIMES {
                        self.times.remove(0);
                    }
                    self.times.push(us);
                }
                Err(error) => {
                    eprintln!(
                        "rail-hud: painting the overlay of window {}: {error}",
                        table.0
                    );
                    overlay.error = Some(error);
                    return;
                }
            }
        } else if overlay.at != (g.client.x, g.client.y) {
            if let Err(error) = move_to(overlay.hwnd, g.client.x, g.client.y) {
                overlay.error = Some(error);
            }
            overlay.at = (g.client.x, g.client.y);
            set_hit(overlay);
        }
        show(overlay.hwnd, true);
    }

    fn close_all(&mut self) {
        for (_, overlay) in self.windows.drain() {
            close(overlay);
        }
    }
}

fn info(overlay: &Overlay) -> OverlayInfo {
    OverlayInfo {
        window: Some(id_of(overlay.hwnd)),
        shown: is_visible(overlay.hwnd),
        renders: overlay.renders,
        last_render_us: overlay.last_render_us,
        painted: overlay.painted.map_or((0, 0), |(w, h, _)| (w, h)),
        panels: overlay.scene.panels.clone(),
        dropped: overlay.scene.dropped.clone(),
        error: overlay.error.clone(),
    }
}

/// Lay the frame out, paint it into the surface and show it where the
/// table is; the time it took, µs.
fn paint(
    painter: &mut Painter,
    design: &PanelDesign,
    overlay: &mut Overlay,
) -> Result<u64, String> {
    let started = Instant::now();
    let g = overlay.geometry;
    let Some(frame) = &overlay.frame else {
        return Ok(0);
    };
    let scene = compose(frame, g.client.width, g.client.height, g.scale, design);
    let fits = overlay
        .surface
        .as_ref()
        .is_some_and(|s| (s.width, s.height) == (g.client.width, g.client.height));
    if !fits {
        overlay.surface = None; // the old bitmap first
        overlay.surface = Some(Surface::new(g.client.width, g.client.height)?);
    }
    let surface = overlay
        .surface
        .as_ref()
        .ok_or_else(|| "no surface".to_owned())?;
    painter.paint(&scene, surface)?;
    show_layered(overlay.hwnd, &g.client, surface)?;
    overlay.scene = scene;
    overlay.painted = Some((g.client.width, g.client.height, g.scale));
    overlay.at = (g.client.x, g.client.y);
    overlay.dirty = false;
    overlay.renders += 1;
    let us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    overlay.last_render_us = us;
    set_hit(overlay);
    Ok(us)
}

fn set_hit(overlay: &Overlay) {
    HIT.with(|hit| {
        hit.borrow_mut().insert(
            overlay.hwnd.0.addr(),
            (overlay.at.0, overlay.at.1, overlay.scene.panels.clone()),
        );
    });
}

fn close(overlay: Overlay) {
    HIT.with(|hit| {
        hit.borrow_mut().remove(&overlay.hwnd.0.addr());
    });
    destroy_window(overlay.hwnd);
}

/// The overlay window for `table`: owned by it, layered, a tool window
/// that never activates; hidden until painted.
#[allow(unsafe_code)]
fn create_window(table: WindowId, geometry: &Geometry) -> Result<HWND, String> {
    // SAFETY: no preconditions; `None` asks for this executable's module.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {e}"))?;
    let c = geometry.client;
    // SAFETY: the class is registered by this thread (`register_class`)
    // with a static name; the owner is a window handle of another process,
    // which Windows checks (a stale one fails the call); nothing else is
    // passed by pointer.
    unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name(),
            w!("Rail HUD"),
            WS_POPUP,
            c.x,
            c.y,
            i32::try_from(c.width.max(1)).unwrap_or(1),
            i32::try_from(c.height.max(1)).unwrap_or(1),
            Some(hwnd_of(table)),
            None,
            Some(module.into()),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW: {e}"))
}

#[allow(unsafe_code)]
fn destroy_window(hwnd: HWND) {
    // SAFETY: a window this thread made; destroying one the system already
    // destroyed with its owner fails harmlessly.
    let _ = unsafe { DestroyWindow(hwnd) };
}

#[allow(unsafe_code)]
fn is_visible(hwnd: HWND) -> bool {
    // SAFETY: reads a flag; a stale handle reads as not visible.
    unsafe { IsWindowVisible(hwnd) }.as_bool()
}

/// Show (without activating) or hide.
#[allow(unsafe_code)]
fn show(hwnd: HWND, visible: bool) {
    if is_visible(hwnd) == visible {
        return;
    }
    // SAFETY: a window of this thread; no pointers.
    let _ = unsafe { ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
}

#[allow(unsafe_code)]
fn move_to(hwnd: HWND, x: i32, y: i32) -> Result<(), String> {
    // SAFETY: a window of this thread; no pointers; its z-order (above its
    // owner) is left alone.
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    }
    .map_err(|e| format!("SetWindowPos: {e}"))
}

/// Put the surface on screen at `client` (position and size) with its
/// per-pixel alpha.
#[allow(unsafe_code)]
fn show_layered(hwnd: HWND, client: &Rect, surface: &Surface) -> Result<(), String> {
    let at = POINT {
        x: client.x,
        y: client.y,
    };
    let size = SIZE {
        cx: i32::try_from(surface.width).unwrap_or(0),
        cy: i32::try_from(surface.height).unwrap_or(0),
    };
    let origin = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
        BlendOp: u8::try_from(AC_SRC_OVER).unwrap_or(0),
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: u8::try_from(AC_SRC_ALPHA).unwrap_or(1),
    };
    // SAFETY: the screen's DC, released below.
    let screen = unsafe { GetDC(None) };
    // SAFETY: every pointer is to a local that outlives the call; the
    // source DC holds the surface's bitmap; the window is this thread's.
    let shown = unsafe {
        UpdateLayeredWindow(
            hwnd,
            Some(screen),
            Some(&at),
            Some(&size),
            Some(surface.dc),
            Some(&origin),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        )
    };
    // SAFETY: the DC `GetDC(None)` returned above, released once.
    let _ = unsafe { ReleaseDC(None, screen) };
    shown.map_err(|e| format!("UpdateLayeredWindow: {e}"))
}

/// A 32-bit top-down DIB selected into a memory DC: what Direct2D paints
/// and `UpdateLayeredWindow` shows.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    /// The DIB's pixels: `width * height` BGRA, premultiplied. Valid while
    /// `bitmap` lives (it is deleted only in `drop`).
    bits: *mut u8,
    width: u32,
    height: u32,
}

impl Surface {
    #[allow(unsafe_code)]
    fn new(width: u32, height: u32) -> Result<Self, String> {
        let w = i32::try_from(width).map_err(|_| "too wide".to_owned())?;
        let h = i32::try_from(height).map_err(|_| "too tall".to_owned())?;
        // SAFETY: no preconditions; `None` makes it compatible with the
        // screen.
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.is_invalid() {
            return Err("CreateCompatibleDC failed".to_owned());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `info` describes a 32-bit DIB; `bits` is a valid out
        // pointer that receives the pixels' address.
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) if !bits.is_null() => bitmap,
            other => {
                // SAFETY: the DC made above, deleted once.
                let _ = unsafe { DeleteDC(dc) };
                return Err(format!("CreateDIBSection: {other:?}"));
            }
        };
        // SAFETY: selects the bitmap made above into the DC made above;
        // the previous object is put back in `drop`.
        let previous = unsafe { SelectObject(dc, bitmap.into()) };
        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
            width,
            height,
        })
    }

    /// One pixel: B, G, R, A (premultiplied).
    #[allow(unsafe_code)]
    fn pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let index =
            usize::try_from((u64::from(y) * u64::from(self.width) + u64::from(x)) * 4).ok()?;
        let len = usize::try_from(u64::from(self.width) * u64::from(self.height) * 4).ok()?;
        // SAFETY: GDI's batched drawing is flushed so the pixels are final.
        let _ = unsafe { GdiFlush() };
        // SAFETY: `bits` points at the DIB's `len` bytes, alive while
        // `self.bitmap` is (deleted only in `drop`); only this thread
        // touches the surface, and nothing writes while the slice lives.
        let pixels = unsafe { std::slice::from_raw_parts(self.bits, len) };
        pixels.get(index..index + 4)?.try_into().ok()
    }
}

impl Drop for Surface {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        // SAFETY: puts back the DC's original bitmap, then deletes the
        // DIB and the DC made in `new`, each once.
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// Direct2D (a software DC render target) and DirectWrite.
struct Painter {
    factory: ID2D1Factory,
    target: ID2D1DCRenderTarget,
    brush: Option<ID2D1SolidColorBrush>,
    dwrite: IDWriteFactory,
    /// Text formats by (pixel size, bold).
    formats: HashMap<(u32, bool), IDWriteTextFormat>,
}

impl Painter {
    #[allow(unsafe_code)]
    fn new() -> Result<Self, String> {
        // SAFETY: no preconditions; a single-threaded factory used on this
        // thread only.
        let factory: ID2D1Factory =
            unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None) }
                .map_err(|e| format!("D2D1CreateFactory: {e}"))?;
        let target = Self::target(&factory)?;
        // SAFETY: no preconditions.
        let dwrite: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }
            .map_err(|e| format!("DWriteCreateFactory: {e}"))?;
        Ok(Self {
            factory,
            target,
            brush: None,
            dwrite,
            formats: HashMap::new(),
        })
    }

    /// A DC render target that paints premultiplied BGRA on the CPU.
    #[allow(unsafe_code)]
    fn target(factory: &ID2D1Factory) -> Result<ID2D1DCRenderTarget, String> {
        let properties = D2D1_RENDER_TARGET_PROPERTIES {
            r#type: D2D1_RENDER_TARGET_TYPE_SOFTWARE,
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            // 96 dpi: one device-independent pixel is one physical pixel;
            // the scene is in physical pixels already.
            dpiX: 96.0,
            dpiY: 96.0,
            usage: D2D1_RENDER_TARGET_USAGE_NONE,
            minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
        };
        // SAFETY: `properties` is a valid, fully initialised struct that
        // outlives the call.
        unsafe { factory.CreateDCRenderTarget(&properties) }
            .map_err(|e| format!("CreateDCRenderTarget: {e}"))
    }

    /// A text format of `px` pixels, centred both ways, never wrapped.
    #[allow(unsafe_code)]
    fn format(&mut self, px: u32, bold: bool) -> Result<IDWriteTextFormat, String> {
        if let Some(format) = self.formats.get(&(px, bold)) {
            return Ok(format.clone());
        }
        let weight = if bold {
            DWRITE_FONT_WEIGHT_SEMI_BOLD
        } else {
            DWRITE_FONT_WEIGHT_NORMAL
        };
        // SAFETY: static strings; `None` is the system font collection.
        let format = unsafe {
            self.dwrite.CreateTextFormat(
                w!("Segoe UI"),
                None::<&IDWriteFontCollection>,
                weight,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                float(px),
                w!("en-us"),
            )
        }
        .map_err(|e| format!("CreateTextFormat: {e}"))?;
        // SAFETY: plain setters on the format made above.
        unsafe {
            format
                .SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)
                .map_err(|e| e.to_string())?;
            format
                .SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)
                .map_err(|e| e.to_string())?;
            format
                .SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)
                .map_err(|e| e.to_string())?;
        }
        self.formats.insert((px, bold), format.clone());
        Ok(format)
    }

    /// Paint `scene` into `surface`: cleared to transparent, then every
    /// item back to front. A lost render target is made again once.
    fn paint(&mut self, scene: &Scene, surface: &Surface) -> Result<(), String> {
        match self.try_paint(scene, surface) {
            Ok(()) => Ok(()),
            Err(first) => {
                self.target = Self::target(&self.factory)?;
                self.brush = None;
                self.try_paint(scene, surface)
                    .map_err(|second| format!("{first}; again: {second}"))
            }
        }
    }

    #[allow(unsafe_code)]
    fn try_paint(&mut self, scene: &Scene, surface: &Surface) -> Result<(), String> {
        let bounds = RECT {
            left: 0,
            top: 0,
            right: i32::try_from(surface.width).unwrap_or(0),
            bottom: i32::try_from(surface.height).unwrap_or(0),
        };
        // SAFETY: the surface's DC holds its DIB for as long as the
        // surface lives, which is past `EndDraw` below; `bounds` is a
        // valid rectangle inside it.
        unsafe { self.target.BindDC(surface.dc, &bounds) }.map_err(|e| format!("BindDC: {e}"))?;
        let brush = match &self.brush {
            Some(brush) => brush.clone(),
            None => {
                // SAFETY: a valid colour; no brush properties.
                let brush = unsafe {
                    self.target
                        .CreateSolidColorBrush(&color(Rgba::rgb(0, 0, 0)), None)
                }
                .map_err(|e| format!("CreateSolidColorBrush: {e}"))?;
                self.brush = Some(brush.clone());
                brush
            }
        };
        // Text formats first: making one is not allowed between Begin and
        // EndDraw failing half-way.
        let mut texts = Vec::new();
        for item in &scene.items {
            if let Item::Text { px, bold, .. } = item {
                texts.push(self.format(*px, *bold)?);
            }
        }
        let mut formats = texts.into_iter();
        // SAFETY: Begin / EndDraw pair on this thread's target; every
        // pointer below is to a local that outlives its call; the brush
        // and formats are this factory's.
        unsafe {
            self.target.BeginDraw();
            self.target
                .SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            self.target.Clear(Some(&D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.0,
            }));
            for item in &scene.items {
                match item {
                    Item::Fill {
                        rect,
                        radius,
                        color: fill,
                    } => {
                        brush.SetColor(&color(*fill));
                        let rounded = D2D1_ROUNDED_RECT {
                            rect: rect_f(rect),
                            radiusX: float(*radius),
                            radiusY: float(*radius),
                        };
                        self.target.FillRoundedRectangle(&rounded, &brush);
                    }
                    Item::Text {
                        rect,
                        text,
                        color: ink,
                        ..
                    } => {
                        let Some(format) = formats.next() else {
                            break;
                        };
                        brush.SetColor(&color(*ink));
                        let wide: Vec<u16> = text.encode_utf16().collect();
                        self.target.DrawText(
                            &wide,
                            &format,
                            &rect_f(rect),
                            &brush,
                            D2D1_DRAW_TEXT_OPTIONS_CLIP,
                            DWRITE_MEASURING_MODE_NATURAL,
                        );
                    }
                }
            }
            self.target.EndDraw(None, None)
        }
        .map_err(|e| format!("EndDraw: {e}"))
    }
}

/// A pixel count as Direct2D's float (exact: clamped to 16 bits).
fn float(v: u32) -> f32 {
    f32::from(u16::try_from(v).unwrap_or(u16::MAX))
}

fn coordinate(v: i32) -> f32 {
    f32::from(u16::try_from(v.max(0)).unwrap_or(u16::MAX))
}

fn rect_f(r: &Rect) -> D2D_RECT_F {
    let right = i64::from(r.x) + i64::from(r.width);
    let bottom = i64::from(r.y) + i64::from(r.height);
    D2D_RECT_F {
        left: coordinate(r.x),
        top: coordinate(r.y),
        right: coordinate(i32::try_from(right).unwrap_or(i32::MAX)),
        bottom: coordinate(i32::try_from(bottom).unwrap_or(i32::MAX)),
    }
}

/// A colour in Direct2D's 0 - 1 floats (straight alpha: the target
/// premultiplies).
#[allow(clippy::float_arithmetic)] // Direct2D's colours are floats.
fn color(c: Rgba) -> D2D1_COLOR_F {
    let unit = |v: u8| f32::from(v) / 255.0;
    D2D1_COLOR_F {
        r: unit(c.r),
        g: unit(c.g),
        b: unit(c.b),
        a: unit(c.a),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_points() {
        // x = -5, y = 300 packed as two signed 16-bit halves.
        let packed = (300_isize << 16) | 0xfffb;
        assert_eq!(point_of(LPARAM(packed)), (-5, 300));
        assert_eq!(point_of(LPARAM(0)), (0, 0));
    }
}

//! The overlay windows (R3.4) and the hooks that keep them on their tables
//! (R3.5): their thread, their window procedure, their surfaces and the
//! Direct2D painter. See the parent module's header for the design; every
//! function that calls Win32 allows `unsafe` for itself and says why each
//! block is sound.
//!
//! **The thread.** Started with the first tracked table; it makes itself
//! per-monitor DPI aware (v2), creates its message queue, registers the
//! window class and the painter, then waits in `GetMessageW`. Commands
//! come over a channel; a thread message (`WAKE`) is posted when the
//! channel goes from empty to not, and the thread drains it whole. It owns
//! every overlay window (a window belongs to the thread that made it), so
//! everything that touches one happens here. Queries (`info`, `pixel`,
//! `times`, `follow_times`) answer over a channel of their own, after every
//! command sent before them.
//!
//! **The hooks (R3.5).** One set of out-of-context WinEvent hooks per poker
//! process with a tracked table, set (and undone) on this thread: an
//! out-of-context hook calls back on the thread that set it, from inside
//! its message wait, so it needs a thread that pumps messages and never
//! blocks - this one - and what the callback is for, moving an overlay, is
//! done directly only by the thread that owns the overlay window: no hop
//! to another thread, no lock, no wait between the table moving and its
//! overlay moving. The callback ([`win_event`]) does almost nothing: it
//! drops every event that is not about a followed table (or a top-level
//! window a followed process shows), notes the rest in a thread-local
//! list and posts the thread `HOOKED` once. The thread then handles the
//! list: each noted table's state is read from the system once, however
//! many events it had (`ffi::state_of`), and its overlay is moved (no
//! repaint), repainted (a new client size or scale) or hidden
//! ([`tracking::plan`]); what it saw is kept for the backend's
//! `poll_events`, the latest per table ([`tracking::Observed`]). Never in
//! the callback itself: it can be called while the thread is inside a
//! Win32 call of its own (a `SetWindowPos` that waits on another thread),
//! and the overlays' state must not be touched re-entrantly. The same goes
//! for the overlay windows' own `WM_DPICHANGED` (a monitor of another dpi:
//! repaint at its scale) and `WM_DESTROY` (destroyed with its table's
//! process).
//!
//! **Dragging a panel (R3.6).** The panels take clicks (R3.4); a press on
//! one, a move with the button down and the release arrive as this
//! thread's own mouse messages, which the pump hands to
//! [`Overlays::mouse`] before dispatching anything ([`super::super::drag`]
//! says what they mean). The panel is repainted where the pointer takes it,
//! laid out by the scene: inside the client area and, on a room that
//! forbids covering its graphics (ACR), clear of them during the drag too.
//! The capture keeps the release ours wherever it happens, and the drop
//! is kept on the overlay (until the engine's next frame carries it,
//! `Seating::drags_seen`) and noted for the backend's `poll_events` as a
//! `TableEvent::PanelMoved`. Nothing else happens here: the engine tells
//! the app, which writes the store; this thread never waits on either.
//! Losing the capture (another window took the mouse) ends the drag where
//! the panel is.
//!
//! **A click on a panel (R3.8)** is a press whose pointer never left the
//! drag threshold: on the release the thread notes a
//! `TableEvent::PanelClicked` with the panel's place on the screen (the
//! client area's origin as last read here, plus the panel's rectangle in
//! the last painted scene) and does nothing else - the engine asks the app
//! for the popup. The overlay never activates (`MA_NOACTIVATE`), so the
//! click leaves the keyboard with the table.
//!
//! **The table's geometry is always read here, at the moment it is used**
//! (for a new frame, a hook event, the engine's `follow`), never taken
//! from a description handed over, which can be older than what the hooks
//! have shown: the engine's periodic re-find cannot move an overlay back.

use std::cell::{Cell, RefCell};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
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
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GW_HWNDNEXT, GW_HWNDPREV,
    GetMessageW, GetWindow, HTTRANSPARENT, HWND_TOP, IsWindowVisible, MA_NOACTIVATE, MSG,
    PM_NOREMOVE, PeekMessageW, PostThreadMessageW, RegisterClassExW, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos, ShowWindow, ULW_ALPHA,
    UpdateLayeredWindow, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP, WM_CAPTURECHANGED,
    WM_DESTROY, WM_DPICHANGED, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE,
    WM_NCHITTEST, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};
use windows::core::{PCWSTR, w};

use super::super::drag::{self, Drag};
use super::super::tracking::{self, Geometry, Hooked, Observed, Placed, Plan, win_event};
use super::super::{OverlayFrame, PlatformError, Rect, TableEvent, TableWindow, WindowId};
use super::OverlayInfo;
use super::ffi::{ThreadDpi, hwnd_of, id_of, is_top_level, is_window, state_of, window_text};
use crate::layout::{self, Positions};
use crate::panel::PanelDesign;
use crate::scene::{Item, Rgba, Scene, compose_with};

/// The thread message that says "the channel has commands".
const WAKE: u32 = WM_APP + 0x52;

/// The thread message that says "the hooks noted something" (R3.5).
const HOOKED: u32 = WM_APP + 0x53;

/// Paint and follow times kept for `times` / `follow_times` (the most
/// recent).
const KEEP_TIMES: usize = 10_000;

/// How long a query waits for the thread.
const ASK: Duration = Duration::from_secs(10);

/// `MK_LBUTTON` in a mouse message's `wparam`: the left button is down.
const LEFT_BUTTON: usize = 0x0001;

/// How long a table counts as being minimised after
/// `EVENT_SYSTEM_MINIMIZESTART` while `IsIconic` does not say so yet: a
/// missed `MINIMIZEEND` must not hide an overlay for good.
const MINIMIZING: Duration = Duration::from_secs(2);

enum Command {
    Frame {
        table: WindowId,
        frame: Box<OverlayFrame>,
    },
    /// Follow a table: hook its process (once), note its window.
    Track {
        table: WindowId,
        pid: Option<u32>,
        title: String,
        /// What the engine knows of it: a different reading is news.
        known: Geometry,
    },
    Untrack {
        table: WindowId,
    },
    /// Read the table again and put its overlay right.
    Resync {
        table: WindowId,
    },
    /// Undo a process's hooks (it has no tracked table left).
    Unhook {
        pid: u32,
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
    FollowTimes {
        reply: Sender<Vec<u64>>,
    },
    Quit,
}

/// The handle the backend holds: the thread, its channel, its id, and
/// what its hooks saw.
pub(in crate::platform) struct OverlayThread {
    thread_id: u32,
    commands: Mutex<Sender<Command>>,
    /// A `WAKE` is posted and not yet taken.
    pending: Arc<AtomicBool>,
    /// What the hooks saw since the backend last looked.
    observed: Arc<Mutex<Observed>>,
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
        let observed = Arc::new(Mutex::new(Observed::default()));
        let flag = Arc::clone(&pending);
        let seen = Arc::clone(&observed);
        let join = std::thread::Builder::new()
            .name("rail-hud-overlays".to_owned())
            .spawn(move || run(&receiver, &ready, &flag, seen))
            .map_err(|e| PlatformError::Os(format!("the overlay thread: {e}")))?;
        match started.recv_timeout(ASK) {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                commands: Mutex::new(commands),
                pending,
                observed,
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
            post(self.thread_id, WAKE)?;
        }
        Ok(())
    }

    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Command) -> Option<T> {
        let (reply, answer) = mpsc::channel();
        self.send(make(reply)).ok()?;
        answer.recv_timeout(ASK).ok()
    }

    pub(in crate::platform) fn thread_id(&self) -> u32 {
        self.thread_id
    }

    pub(in crate::platform) fn frame(
        &self,
        table: WindowId,
        frame: OverlayFrame,
    ) -> Result<(), PlatformError> {
        self.send(Command::Frame {
            table,
            frame: Box::new(frame),
        })
    }

    pub(in crate::platform) fn track(&self, window: &TableWindow) {
        let _ = self.send(Command::Track {
            table: window.id,
            pid: window.process.pid,
            title: window.title.clone(),
            known: Geometry {
                client: window.client,
                scale_permille: window.scale_permille,
                hidden: window.minimized,
            },
        });
    }

    pub(in crate::platform) fn untrack(&self, table: WindowId) {
        let _ = self.send(Command::Untrack { table });
    }

    pub(in crate::platform) fn resync(&self, table: WindowId) {
        let _ = self.send(Command::Resync { table });
    }

    pub(in crate::platform) fn unhook(&self, pid: u32) {
        let _ = self.send(Command::Unhook { pid });
    }

    pub(in crate::platform) fn remove(&self, table: WindowId) {
        let _ = self.send(Command::Remove { table });
    }

    /// What the hooks saw since the last call (taken).
    pub(in crate::platform) fn observed(&self) -> Observed {
        std::mem::take(&mut *self.observed.lock().unwrap_or_else(PoisonError::into_inner))
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

    pub(in crate::platform) fn follow_times(&self) -> Vec<u64> {
        self.ask(|reply| Command::FollowTimes { reply })
            .unwrap_or_default()
    }
}

impl Drop for OverlayThread {
    /// Every overlay window is destroyed, and every hook undone, by the
    /// thread on the way out.
    fn drop(&mut self) {
        if self.send(Command::Quit).is_ok()
            && let Some(join) = self.join.take()
        {
            let _ = join.join();
        }
    }
}

#[allow(unsafe_code)]
fn post(thread_id: u32, message: u32) -> Result<(), PlatformError> {
    // SAFETY: posts a message carrying no pointers to a thread id; a
    // thread that is gone makes it fail, which is reported.
    unsafe { PostThreadMessageW(thread_id, message, WPARAM(0), LPARAM(0)) }
        .map_err(|e| PlatformError::Os(format!("PostThreadMessageW: {e}")))
}

/// What the hook callback and the window procedure noted for the thread
/// to handle (R3.5).
#[derive(Default)]
struct Pending {
    /// A `HOOKED` is posted and not yet handled.
    posted: bool,
    /// Followed tables' events: (table, event, when the callback saw it);
    /// each (table, event) once - the thread reads the table's state when
    /// it handles them, not what it was at each event.
    tables: Vec<(WindowId, Hooked, Instant)>,
    /// A followed process showed a top-level window.
    appeared: bool,
    /// Overlay windows whose monitor's dpi changed.
    dpi: Vec<WindowId>,
    /// Overlay windows being destroyed.
    destroyed: Vec<WindowId>,
    /// Overlay windows that lost the mouse capture (R3.6: a drag ends).
    capture_lost: Vec<WindowId>,
}

thread_local! {
    static PENDING: RefCell<Pending> = RefCell::new(Pending::default());
    /// The followed tables, for the callback's first filter.
    static FOLLOWED: RefCell<HashSet<WindowId>> = RefCell::new(HashSet::new());
    /// This thread's id, for posting `HOOKED` to itself.
    static THREAD: Cell<u32> = const { Cell::new(0) };
}

/// Note something for the thread, posting `HOOKED` if none is pending.
/// The list is borrowed only here and in [`take_pending`], never across a
/// Win32 call, so the borrow cannot fail; if it ever did, the note is
/// dropped (the re-find catches up) rather than panicking in a callback.
fn note(add: impl FnOnce(&mut Pending)) {
    let post_now = PENDING.with(|pending| match pending.try_borrow_mut() {
        Ok(mut pending) => {
            add(&mut pending);
            !std::mem::replace(&mut pending.posted, true)
        }
        Err(_) => false,
    });
    if post_now {
        let _ = post(THREAD.with(Cell::get), HOOKED);
    }
}

fn take_pending() -> Pending {
    PENDING.with(|pending| {
        pending
            .try_borrow_mut()
            .map(|mut p| std::mem::take(&mut *p))
            .unwrap_or_default()
    })
}

/// The WinEvent callback (R3.5), on this thread, inside its message wait.
/// It only filters and notes; the thread does the rest on `HOOKED`.
extern "system" fn win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    let Some(kind) = tracking::classify(event, object, child) else {
        return;
    };
    if hwnd.is_invalid() {
        return;
    }
    let id = id_of(hwnd);
    let followed = FOLLOWED.with(|f| f.try_borrow().is_ok_and(|f| f.contains(&id)));
    if followed {
        let now = Instant::now();
        note(|p| {
            if !p.tables.iter().any(|(t, k, _)| *t == id && *k == kind) {
                p.tables.push((id, kind, now));
            }
        });
    } else if kind == Hooked::Shown && is_top_level(hwnd) {
        note(|p| p.appeared = true);
    }
}

/// The thread's body.
fn run(
    commands: &Receiver<Command>,
    ready: &Sender<Result<u32, String>>,
    pending: &AtomicBool,
    observed: Arc<Mutex<Observed>>,
) {
    let _dpi = ThreadDpi::per_monitor_v2();
    let thread_id = make_queue();
    THREAD.with(|t| t.set(thread_id));
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
        followed: HashMap::new(),
        hooks: HashMap::new(),
        observed,
        follow_times: Vec::new(),
        drag_seq: 0,
    };
    'pump: while let Some(message) = next_message() {
        if message.hwnd.is_invalid() && message.message == WAKE {
            pending.store(false, Ordering::SeqCst);
            while let Ok(command) = commands.try_recv() {
                if !state.handle(command) {
                    break 'pump;
                }
            }
        } else if message.hwnd.is_invalid() && message.message == HOOKED {
            state.hooked();
        } else if !state.mouse(&message) {
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

/// The next message, `None` on `WM_QUIT` or an error. The hooks' callbacks
/// run inside this wait.
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
        // rectangle; a monitor of another dpi means painting at its scale
        // (R3.5), which the thread does once this message is handled.
        WM_DPICHANGED => {
            let id = id_of(hwnd);
            note(|p| p.dpi.push(id));
            LRESULT(0)
        }
        // The mouse capture went elsewhere (R3.6): a drag ends where the
        // panel is, which the thread does once this message is handled.
        WM_CAPTURECHANGED => {
            let id = id_of(hwnd);
            note(|p| p.capture_lost.push(id));
            LRESULT(0)
        }
        // Destroyed: by us (`close`), or by Windows with its owner - the
        // table - when the table's process ends (R3.5).
        WM_DESTROY => {
            let id = id_of(hwnd);
            note(|p| p.destroyed.push(id));
            // SAFETY: the default handling of this window's own message.
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
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
    /// The table as last read: what the overlay was put over.
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
    moves: u64,
    restacked: u64,
    error: Option<String>,
    /// A press on a seat's panel being followed (R3.6).
    drag: Option<Drag>,
    /// Panels dropped and not yet in the engine's frame (R3.6): (drag
    /// number, slot, centre in thousandths), oldest first.
    kept: Vec<(u64, u32, (u32, u32))>,
    /// Drags dropped on this overlay.
    drags: u64,
    /// (R3.8) Clicks on its panels (popups asked for).
    clicks: u64,
}

impl Overlay {
    /// The positions the overlay shows over its frame's: drops the engine
    /// has not taken in yet, then the drag in progress.
    fn overrides(&self) -> Positions {
        let mut out: Positions = self.kept.iter().map(|&(_, slot, at)| (slot, at)).collect();
        if let Some(drag) = &self.drag
            && let Some(at) = drag.at
        {
            out.insert(drag.slot, at);
        }
        out
    }
}

/// A followed table (R3.5).
struct Followed {
    pid: Option<u32>,
    title: String,
    /// `EVENT_SYSTEM_MINIMIZESTART` seen, `IsIconic` not yet true.
    minimizing: Option<Instant>,
    /// The geometry last reported (or known to the engine).
    last: Option<Geometry>,
    /// Destroyed or hidden: reported once, then ignored until untracked.
    gone: bool,
}

/// Everything on the thread.
struct Overlays {
    painter: Painter,
    design: PanelDesign,
    windows: HashMap<WindowId, Overlay>,
    times: Vec<u64>,
    followed: HashMap<WindowId, Followed>,
    /// The hooks per poker process.
    hooks: HashMap<u32, Vec<HWINEVENTHOOK>>,
    observed: Arc<Mutex<Observed>>,
    /// Hook event -> overlay put right, µs.
    follow_times: Vec<u64>,
    /// Drags dropped so far, on every overlay (R3.6): each drop's number,
    /// which the engine hands back in its frames.
    drag_seq: u64,
}

fn keep(times: &mut Vec<u64>, us: u64) {
    if times.len() >= KEEP_TIMES {
        times.remove(0);
    }
    times.push(us);
}

fn micros(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_micros()).unwrap_or(u64::MAX)
}

impl Overlays {
    /// One command; `false` ends the thread.
    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Frame { table, frame } => self.frame(table, *frame),
            Command::Track {
                table,
                pid,
                title,
                known,
            } => self.track(table, pid, title, known),
            Command::Untrack { table } => {
                self.followed.remove(&table);
                FOLLOWED.with(|f| f.borrow_mut().remove(&table));
            }
            Command::Resync { table } => self.follow(table, None),
            Command::Unhook { pid } => {
                let used = self.followed.values().any(|f| f.pid == Some(pid));
                if !used && let Some(hooks) = self.hooks.remove(&pid) {
                    unhook(hooks);
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
            Command::FollowTimes { reply } => {
                let _ = reply.send(self.follow_times.clone());
            }
            Command::Quit => return false,
        }
        true
    }

    fn observe(&self, add: impl FnOnce(&mut Observed)) {
        add(&mut self.observed.lock().unwrap_or_else(PoisonError::into_inner));
    }

    /// Follow a table: hook its process if it is not yet, and read it
    /// once (what differs from what the engine knows is reported).
    fn track(&mut self, table: WindowId, pid: Option<u32>, title: String, known: Geometry) {
        self.followed.insert(
            table,
            Followed {
                pid,
                title,
                minimizing: None,
                last: Some(known),
                gone: false,
            },
        );
        FOLLOWED.with(|f| f.borrow_mut().insert(table));
        if let Some(pid) = pid.filter(|&p| p != 0)
            && let Entry::Vacant(slot) = self.hooks.entry(pid)
        {
            let hooks = hook(pid);
            eprintln!(
                "rail-hud: hooked process {pid} ({} of {} event ranges)",
                hooks.len(),
                win_event::RANGES.len()
            );
            slot.insert(hooks);
        }
        self.follow(table, None);
    }

    /// What the hooks noted since the last `HOOKED`.
    fn hooked(&mut self) {
        let pending = take_pending();
        if pending.appeared {
            self.observe(|o| o.appeared = true);
        }
        for overlay in pending.destroyed {
            self.overlay_destroyed(overlay);
        }
        for overlay in pending.capture_lost {
            if let Some(table) = self.table_of_overlay(overlay) {
                self.end_drag(table);
            }
        }
        // Per table, in order: its events, and the first one's time.
        let mut by_table: Vec<(WindowId, Vec<Hooked>, Instant)> = Vec::new();
        for (table, kind, at) in pending.tables {
            match by_table.iter_mut().find(|(t, _, _)| *t == table) {
                Some((_, kinds, _)) => kinds.push(kind),
                None => by_table.push((table, vec![kind], at)),
            }
        }
        for (table, kinds, at) in by_table {
            self.table_events(table, &kinds, at);
        }
        for overlay in pending.dpi {
            let table = self
                .windows
                .iter()
                .find(|(_, o)| id_of(o.hwnd) == overlay)
                .map(|(t, _)| *t);
            if let Some(table) = table {
                self.follow(table, None);
            }
        }
    }

    /// A followed table's events since the last `HOOKED`.
    fn table_events(&mut self, table: WindowId, kinds: &[Hooked], at: Instant) {
        let Some(followed) = self.followed.get(&table) else {
            return;
        };
        if followed.gone {
            // Hidden, reported gone, not yet untracked by the engine - and
            // shown again: a table to find anew.
            if kinds.contains(&Hooked::Shown) {
                self.observe(|o| o.appeared = true);
            }
            return;
        }
        if kinds.contains(&Hooked::Destroyed) {
            self.table_gone(table);
            return;
        }
        let mut moves = false;
        let mut foreground = false;
        let mut title = None;
        if let Some(followed) = self.followed.get_mut(&table) {
            for kind in kinds {
                match kind {
                    Hooked::MinimizeStart => followed.minimizing = Some(Instant::now()),
                    Hooked::MinimizeEnd => followed.minimizing = None,
                    Hooked::Name => {
                        let now = window_text(hwnd_of(table));
                        if now != followed.title {
                            followed.title.clone_from(&now);
                            title = Some(now);
                        }
                    }
                    Hooked::Foreground => foreground = true,
                    _ => {}
                }
                moves |= kind.moves();
            }
        }
        if let Some(title) = title {
            self.observe(|o| o.title(table, title));
        }
        if moves {
            self.follow(table, Some(at));
        }
        if foreground {
            self.restack(table);
        }
    }

    /// The table as it is now (R3.5): `None` when it is gone or hidden by
    /// its client (then its overlay is removed and the engine told). A
    /// reading the engine was not given yet is reported.
    fn read(&mut self, table: WindowId) -> Option<Geometry> {
        let Some(state) = state_of(hwnd_of(table)).filter(|s| s.visible) else {
            self.table_gone(table);
            return None;
        };
        let mut report = false;
        let mut geometry = Geometry {
            client: state.client,
            scale_permille: state.scale_permille,
            hidden: state.iconic || state.cloaked,
        };
        if let Some(followed) = self.followed.get_mut(&table) {
            if state.iconic {
                followed.minimizing = None;
            }
            geometry.hidden |= followed
                .minimizing
                .is_some_and(|since| since.elapsed() < MINIMIZING);
            report = followed.last != Some(geometry);
            followed.last = Some(geometry);
        }
        if report {
            self.observe(|o| o.geometry(table, geometry));
        }
        Some(geometry)
    }

    /// Read the table and put its overlay right; `at`: the hook event
    /// this answers, for the follow time.
    fn follow(&mut self, table: WindowId, at: Option<Instant>) {
        let Some(geometry) = self.read(table) else {
            return;
        };
        let plan = self.sync(table, geometry);
        if let Some(at) = at
            && plan != Plan::Keep
        {
            keep(&mut self.follow_times, micros(at));
        }
    }

    /// Destroyed, or hidden by its client: the overlay goes now, the
    /// engine hears it once.
    fn table_gone(&mut self, table: WindowId) {
        if let Some(followed) = self.followed.get_mut(&table) {
            if followed.gone {
                return;
            }
            followed.gone = true;
        }
        if let Some(overlay) = self.windows.remove(&table) {
            close(overlay);
        }
        self.observe(|o| o.gone(table));
    }

    /// An overlay window is being destroyed. If we did it, it is no longer
    /// in `windows`; otherwise Windows did, with its owner - the table's
    /// process ended - or something else did and the table is still there,
    /// and its overlay is made again.
    fn overlay_destroyed(&mut self, overlay: WindowId) {
        let Some(table) = self
            .windows
            .iter()
            .find(|(_, o)| id_of(o.hwnd) == overlay)
            .map(|(t, _)| *t)
        else {
            return;
        };
        let Some(lost) = self.windows.remove(&table) else {
            return;
        };
        HIT.with(|hit| {
            hit.borrow_mut().remove(&lost.hwnd.0.addr());
        });
        if is_window(hwnd_of(table)) {
            if let Some(frame) = lost.frame {
                self.frame(table, frame);
            }
        } else {
            self.table_gone(table);
        }
    }

    /// The table came to the foreground: its overlay must be directly
    /// above it. Windows keeps an owned window above its owner, so this
    /// is a check that should never have to act; when it does, it is
    /// counted (`OverlayInfo::restacked`).
    fn restack(&mut self, table: WindowId) {
        let Some(overlay) = self.windows.get_mut(&table) else {
            return;
        };
        if !is_visible(overlay.hwnd) || above(overlay.hwnd, hwnd_of(table)) {
            return;
        }
        match put_above(overlay.hwnd, hwnd_of(table)) {
            Ok(()) => overlay.restacked += 1,
            Err(error) => overlay.error = Some(error),
        }
    }

    fn frame(&mut self, table: WindowId, frame: OverlayFrame) {
        let Some(geometry) = self.read(table) else {
            return;
        };
        if let Entry::Vacant(slot) = self.windows.entry(table) {
            let overlay = match create_window(table, &geometry.client) {
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
                    moves: 0,
                    restacked: 0,
                    error: None,
                    drag: None,
                    clicks: 0,
                    kept: Vec::new(),
                    drags: 0,
                },
                Err(error) => {
                    eprintln!("rail-hud: overlay for window {}: {error}", table.0);
                    return;
                }
            };
            slot.insert(overlay);
        }
        if let Some(overlay) = self.windows.get_mut(&table) {
            // Drops the engine has taken in are in the frame now (R3.6).
            let seen = frame.seating.drags_seen;
            overlay.kept.retain(|(seq, _, _)| *seq > seen);
            // The same frame again (a re-read that changed nothing) is not
            // painted again.
            if overlay.frame.as_ref() != Some(&frame) {
                overlay.frame = Some(frame);
                overlay.dirty = true;
            }
        }
        self.sync(table, geometry);
    }

    /// Bring a table's overlay in line with its frame and the table as it
    /// is ([`tracking::plan`]): paint when the frame, the size or the scale
    /// changed, move when only the position did, hide while the table is
    /// minimised or cloaked. What it did.
    fn sync(&mut self, table: WindowId, g: Geometry) -> Plan {
        let Some(overlay) = self.windows.get_mut(&table) else {
            return Plan::Keep;
        };
        let placed = Placed {
            shown: is_visible(overlay.hwnd),
            at: overlay.at,
            painted: overlay.painted,
        };
        let plan = tracking::plan(&placed, &g, overlay.dirty);
        overlay.geometry = g;
        match plan {
            Plan::Keep => {}
            Plan::Hide => show(overlay.hwnd, false),
            Plan::Paint => match paint(&mut self.painter, &self.design, overlay) {
                Ok(us) => {
                    overlay.error = None;
                    keep(&mut self.times, us);
                    show(overlay.hwnd, true);
                }
                Err(error) => {
                    eprintln!(
                        "rail-hud: painting the overlay of window {}: {error}",
                        table.0
                    );
                    overlay.error = Some(error);
                }
            },
            Plan::Move => {
                if let Err(error) = move_to(overlay.hwnd, g.client.x, g.client.y) {
                    overlay.error = Some(error);
                }
                overlay.at = (g.client.x, g.client.y);
                overlay.moves += 1;
                set_hit(overlay);
                show(overlay.hwnd, true);
            }
            Plan::Show => show(overlay.hwnd, true),
        }
        plan
    }

    /// A mouse message of this thread (R3.6): a press, move or release on
    /// an overlay, taken here; `false` for anything else (dispatched).
    fn mouse(&mut self, message: &MSG) -> bool {
        if !matches!(
            message.message,
            WM_LBUTTONDOWN | WM_MOUSEMOVE | WM_LBUTTONUP
        ) {
            return false;
        }
        let Some(table) = self.table_of_overlay(id_of(message.hwnd)) else {
            return false;
        };
        // Client coordinates of the overlay, which covers the table's
        // client area exactly: the scene's.
        let (x, y) = point_of(message.lParam);
        let dragging = self.windows.get(&table).is_some_and(|o| o.drag.is_some());
        match message.message {
            WM_LBUTTONDOWN => {
                if dragging {
                    // A release we never saw: end that drag first.
                    self.end_drag(table);
                }
                if let Some(overlay) = self.windows.get_mut(&table)
                    && let Some(drag) = Drag::press(&overlay.scene, x, y)
                {
                    overlay.drag = Some(drag);
                    set_capture(overlay.hwnd);
                }
            }
            WM_MOUSEMOVE => {
                // A move without the button is ignored, not a release: the
                // release comes as one (the capture makes sure), or the
                // capture's loss ends the drag.
                let down = message.wParam.0 & LEFT_BUTTON != 0;
                let moved = self.windows.get_mut(&table).and_then(|overlay| {
                    let g = overlay.geometry;
                    let drag = overlay.drag.as_mut().filter(|_| down)?;
                    drag.moved(
                        x,
                        y,
                        drag::threshold(g.scale_permille),
                        g.client.width,
                        g.client.height,
                    )
                });
                if moved.is_some() {
                    self.repaint(table);
                }
            }
            _ => {
                if dragging {
                    release_capture();
                    self.end_drag(table);
                }
            }
        }
        true
    }

    /// End the drag of `table`'s overlay where the panel is: kept, and the
    /// engine told, when it moved to a place it may be; a click otherwise
    /// (R3.8's), or back where it was.
    fn end_drag(&mut self, table: WindowId) {
        let Some(overlay) = self.windows.get_mut(&table) else {
            return;
        };
        let Some(drag) = overlay.drag.take() else {
            return;
        };
        if drag.is_click() {
            // (R3.8) A click: the popup of the panel's player, beside the
            // panel on the screen.
            let Some(&(slot, rect)) = overlay
                .scene
                .seat_panels
                .iter()
                .find(|(slot, _)| *slot == drag.slot)
            else {
                return;
            };
            overlay.clicks += 1;
            let g = overlay.geometry;
            let panel = Rect {
                x: g.client.x.saturating_add(rect.x),
                y: g.client.y.saturating_add(rect.y),
                ..rect
            };
            self.observe(|o| {
                o.clicked(TableEvent::PanelClicked {
                    id: table,
                    slot,
                    panel,
                    scale_permille: g.scale_permille,
                });
            });
            return;
        }
        let Some(at) = drag.release(&overlay.scene) else {
            // Nowhere it may go: back to where it was.
            self.repaint(table);
            return;
        };
        self.drag_seq += 1;
        let seq = self.drag_seq;
        overlay.kept.push((seq, drag.slot, at));
        overlay.drags += 1;
        let size = overlay.scene.size;
        self.observe(|o| {
            o.dragged(TableEvent::PanelMoved {
                id: table,
                size,
                slot: drag.slot,
                x: at.0,
                y: at.1,
                seq,
            });
        });
        // Exactly where it is kept.
        self.repaint(table);
    }

    /// Paint `table`'s overlay again as it is (a drag moved a panel).
    fn repaint(&mut self, table: WindowId) {
        let Some(overlay) = self.windows.get_mut(&table) else {
            return;
        };
        overlay.dirty = true;
        let g = overlay.geometry;
        self.sync(table, g);
    }

    /// The table an overlay window is over.
    fn table_of_overlay(&self, overlay: WindowId) -> Option<WindowId> {
        self.windows
            .iter()
            .find(|(_, o)| id_of(o.hwnd) == overlay)
            .map(|(t, _)| *t)
    }

    fn close_all(&mut self) {
        for (_, overlay) in self.windows.drain() {
            close(overlay);
        }
        for (_, hooks) in self.hooks.drain() {
            unhook(hooks);
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
        seat_panels: overlay.scene.seat_panels.clone(),
        placed_by_user: overlay.scene.placed_by_user.clone(),
        size: overlay.scene.size,
        drags: overlay.drags,
        clicks: overlay.clicks,
        tags: overlay.scene.tags.clone(),
        legend: overlay.scene.legend.as_ref().map(|(rect, _)| *rect),
        dropped: overlay.scene.dropped.clone(),
        moves: overlay.moves,
        restacked: overlay.restacked,
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
    let scene = compose_with(
        frame,
        g.client.width,
        g.client.height,
        g.scale_permille,
        design,
        &overlay.overrides(),
    );
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
    overlay.painted = Some(g.size());
    overlay.at = (g.client.x, g.client.y);
    overlay.dirty = false;
    overlay.renders += 1;
    let us = micros(started);
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

/// Take the mouse for an overlay while a panel is dragged (R3.6): the
/// moves and the release come here wherever the pointer goes.
#[allow(unsafe_code)]
fn set_capture(hwnd: HWND) {
    // SAFETY: a window of this thread; the previous capture window it
    // returns is not used.
    let _ = unsafe { SetCapture(hwnd) };
}

/// Give the mouse back after a drag.
#[allow(unsafe_code)]
fn release_capture() {
    // SAFETY: no arguments; failing (no capture held) changes nothing.
    let _ = unsafe { ReleaseCapture() };
}

fn close(overlay: Overlay) {
    HIT.with(|hit| {
        hit.borrow_mut().remove(&overlay.hwnd.0.addr());
    });
    destroy_window(overlay.hwnd);
}

/// The hooks for one poker process (R3.5), one per event range of
/// [`win_event::RANGES`]; those that could not be set are left out (the
/// engine's re-find still sees what they would have said).
#[allow(unsafe_code)]
fn hook(pid: u32) -> Vec<HWINEVENTHOOK> {
    win_event::RANGES
        .iter()
        .filter_map(|&(min, max)| {
            // SAFETY: `win_event` is a plain function that lives as long as
            // the program, never unwinds and touches only this thread's
            // state; out of context (no module handle) nothing is loaded
            // into the other process and Windows calls it on this thread,
            // which pumps messages; the hook is undone with
            // `UnhookWinEvent` on this same thread.
            let hook = unsafe {
                SetWinEventHook(
                    min,
                    max,
                    None,
                    Some(win_event),
                    pid,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            (!hook.is_invalid()).then_some(hook)
        })
        .collect()
}

#[allow(unsafe_code)]
fn unhook(hooks: Vec<HWINEVENTHOOK>) {
    for hook in hooks {
        // SAFETY: a hook this thread set and has not undone, undone once,
        // on this thread.
        let _ = unsafe { UnhookWinEvent(hook) };
    }
}

/// Whether `upper` is above `lower` in the z-order (walking down from
/// `upper`; bounded, as the order can change during the walk).
#[allow(unsafe_code)]
fn above(upper: HWND, lower: HWND) -> bool {
    let mut next = upper;
    for _ in 0..8192 {
        // SAFETY: reads a relation; the end of the list or a stale handle
        // is an `Err`.
        match unsafe { GetWindow(next, GW_HWNDNEXT) } {
            Ok(below) if !below.is_invalid() => {
                if below == lower {
                    return true;
                }
                next = below;
            }
            _ => return false,
        }
    }
    false
}

/// Put `overlay` directly above `table`: after the window just above the
/// table, or on top when the table is.
#[allow(unsafe_code)]
fn put_above(overlay: HWND, table: HWND) -> Result<(), String> {
    // SAFETY: reads a relation; none above (or a stale handle) is an `Err`.
    let previous = unsafe { GetWindow(table, GW_HWNDPREV) }
        .ok()
        .filter(|h| !h.is_invalid() && *h != overlay);
    // SAFETY: a window of this thread; no pointers; neither moved, sized
    // nor activated.
    unsafe {
        SetWindowPos(
            overlay,
            Some(previous.unwrap_or(HWND_TOP)),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    }
    .map_err(|e| format!("SetWindowPos (z-order): {e}"))
}

/// The overlay window for `table`: owned by it, layered, a tool window
/// that never activates; hidden until painted.
#[allow(unsafe_code)]
fn create_window(table: WindowId, client: &Rect) -> Result<HWND, String> {
    // SAFETY: no preconditions; `None` asks for this executable's module.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {e}"))?;
    let c = *client;
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

//! Following the tables on macOS (R3.13): the accessibility observers, on
//! a thread of their own. macOS only; what a notification means and where
//! a table is are plain Rust in the parent module ([`AxNote::effect`],
//! [`tracked_geometry`]) and in the shared [`crate::platform::tracking`],
//! which every system's unit tests drive.
//!
//! **The thread** (`rail-hud-ax`) runs its own `CFRunLoop` - not AppKit's:
//! a callback that asks a busy client something waits up to 0.25 s
//! (R3.11's timeout), and the overlays must not wait with it; nor the
//! engine's, whose loop reads the store. One `AXObserver` per poker
//! process with a tracked table, its run-loop source on this thread's run
//! loop, made when the process's first table is tracked and let go with
//! its last. On the **application** element: `AXWindowCreated` (the engine
//! looks for tables at once), `AXFocusedWindowChanged`,
//! `AXMainWindowChanged`, `AXApplicationActivated` (its windows came
//! forward: the overlays are put back above their tables now),
//! `AXApplicationHidden` / `Shown`. On each tracked **window**'s element:
//! `AXWindowMoved`, `AXWindowResized` (and the generic `AXMoved` /
//! `AXResized`), `AXWindowMiniaturized` / `Deminiaturized`,
//! `AXUIElementDestroyed`, `AXTitleChanged`. The window's element is the
//! one of `AXWindows` whose `_AXUIElementGetWindow` is the table's number
//! (else the one at its frame); a window on another Space is not in that
//! list, so its element is looked for again on the application's focus and
//! window notifications and on a Space change.
//!
//! **A notification moves the overlay before the engine hears of it.** The
//! callback reads the table from the **window server**
//! (`CGWindowListCopyWindowInfo` for that one window: bounds and on-screen
//! flag, no message to the client) - and, after a move or a resize, again
//! over the next frames ([`SETTLE`]: the client posts the notification
//! before the window server's list shows the new place, as CI found) -
//! plus, on a resize, the title bar, and on a title change the title -
//! computes the
//! client area exactly as the find does ([`tracked_geometry`]) and hands
//! the AppKit thread the new geometry at once ([`Link::follow_at`]); the
//! engine's side is noted in a [`Observed`] (coalesced per table: a drag's
//! hundred moves are one `Moved` at its next tick, `tracking::events`).
//! The AppKit thread keeps the latest geometry the observers gave it and
//! places an overlay from that, never from an older description in a
//! frame.
//!
//! **No fight with the re-find.** The engine's periodic find (500 ms)
//! stays, the safety net for a client with poor accessibility; when it
//! describes a table otherwise than the observers reported, the backend
//! asks this thread to read the table again (`Resync`) rather than placing
//! the overlay from the description: an overlay always goes where the table
//! is at that moment.
//!
//! **Spaces**: no accessibility notification; the AppKit thread's
//! `NSWorkspace.activeSpaceDidChangeNotification` makes this thread read
//! every table again (`SpaceChanged`) - off screen hides its overlay, on
//! screen shows it - now and twice more as the switch settles
//! ([`RECHECKS`]).
//!
//! **A client's exit**: a `kqueue` (`EVFILT_PROC`, `NOTE_EXIT`) per
//! observed process, waited on by a small thread of its own
//! (`rail-hud-exits`): its tables are gone at once - the overlays removed,
//! the engine told `Closed` - rather than at the next find.
//!
//! **`unsafe`**: each function that needs it allows it for itself with a
//! `// SAFETY:` comment per block: the observer's creation, registration
//! and callback, the run loop's source and its waking from other threads,
//! `kqueue` / `kevent`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::panic::AssertUnwindSafe;
use std::ptr::NonNull;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_application_services::{AXError, AXObserver, AXUIElement};
use objc2_core_foundation::{
    CFRetained, CFRunLoop, CFRunLoopMode, CFRunLoopSource, CFRunLoopSourceContext, CFString,
    Type as _, kCFRunLoopDefaultMode,
};

use super::super::WindowId;
use super::super::tracking::{Geometry, Observed};
use super::{
    AxNote, Frame, Link, MINIMIZING, RECHECKS, Read, SETTLE, TrackerInfo, ffi, title_bar,
    title_bar_between, tracked_geometry,
};

/// How long the thread sleeps with nothing to do (a command or a
/// notification wakes it at once).
const IDLE: Duration = Duration::from_secs(60);

/// What the engine's thread (the backend) and the AppKit thread hand the
/// observers' thread.
enum Cmd {
    Track {
        table: WindowId,
        pid: u32,
        title: String,
        title_bar: Option<i64>,
        known: Geometry,
    },
    Untrack {
        table: WindowId,
    },
    Resync {
        table: WindowId,
        title_bar: Option<i64>,
        known: Geometry,
    },
    SpaceChanged,
    Exited {
        pid: u32,
    },
    Info {
        reply: Sender<TrackerInfo>,
    },
    Quit,
}

/// Wakes the observers' run loop from another thread: a version-0 source
/// signalled, then the run loop woken (`CFRunLoopRunInMode` returns once
/// the source is handled).
struct Waker {
    run_loop: CFRetained<CFRunLoop>,
    source: CFRetained<CFRunLoopSource>,
}

// SAFETY: the two calls made through a `Waker` from other threads,
// `CFRunLoopSourceSignal` and `CFRunLoopWakeUp`, are the documented way to
// wake a run loop from another thread and are thread-safe; the retained
// objects themselves are only released (thread-safe reference counting).
#[allow(unsafe_code)]
unsafe impl Send for Waker {}
// SAFETY: as above: `&Waker` only reaches those two thread-safe calls.
#[allow(unsafe_code)]
unsafe impl Sync for Waker {}

impl Waker {
    fn wake(&self) {
        self.source.signal();
        self.run_loop.wake_up();
    }
}

/// The observers' thread, as the backend holds it (on the engine's
/// thread): `Send`.
pub(super) struct Tracker {
    tx: Sender<Cmd>,
    waker: Arc<Waker>,
    observed: Arc<Mutex<Observed>>,
    thread: Option<JoinHandle<()>>,
    exits: Option<Exits>,
}

impl std::fmt::Debug for Tracker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tracker").finish_non_exhaustive()
    }
}

impl Tracker {
    /// Start the thread; `link`: the AppKit thread, whose overlays it
    /// moves (`None`: it only tells the engine).
    pub(super) fn start(link: Option<Link>) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let observed: Arc<Mutex<Observed>> = Arc::default();
        let shared = Arc::clone(&observed);
        let exits = Exits::new()?;
        let kq = exits.kq;
        let thread = std::thread::Builder::new()
            .name("rail-hud-ax".to_owned())
            .spawn(move || run(rx, &ready_tx, link, shared, kq))
            .map_err(|e| e.to_string())?;
        let waker = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|e| format!("the observers' thread did not start: {e}"))??;
        let waker = Arc::new(waker);
        let exits = exits.start(tx.clone(), Arc::clone(&waker))?;
        Ok(Self {
            tx,
            waker,
            observed,
            thread: Some(thread),
            exits: Some(exits),
        })
    }

    fn send(&self, command: Cmd) {
        if self.tx.send(command).is_ok() {
            self.waker.wake();
        }
    }

    /// Follow `table` of process `pid` (its process observed from now on).
    pub(super) fn track(
        &self,
        table: WindowId,
        pid: u32,
        title: String,
        title_bar: Option<i64>,
        known: Geometry,
    ) {
        self.send(Cmd::Track {
            table,
            pid,
            title,
            title_bar,
            known,
        });
    }

    pub(super) fn untrack(&self, table: WindowId) {
        self.send(Cmd::Untrack { table });
    }

    /// The engine sees `table` as `known` (its re-find): read it now and
    /// put the overlay where it really is.
    pub(super) fn resync(&self, table: WindowId, title_bar: Option<i64>, known: Geometry) {
        self.send(Cmd::Resync {
            table,
            title_bar,
            known,
        });
    }

    /// A function the AppKit thread calls when the active Space changed.
    pub(super) fn space_changed(&self) -> impl Fn() + Send + 'static {
        let tx = self.tx.clone();
        let waker = Arc::clone(&self.waker);
        move || {
            if tx.send(Cmd::SpaceChanged).is_ok() {
                waker.wake();
            }
        }
    }

    /// What the observers saw since the last call.
    pub(super) fn observed(&self) -> Observed {
        std::mem::take(&mut *self.observed.lock().unwrap_or_else(PoisonError::into_inner))
    }

    pub(super) fn info(&self) -> Option<TrackerInfo> {
        let (reply, answer) = mpsc::channel();
        self.send(Cmd::Info { reply });
        answer.recv_timeout(Duration::from_secs(10)).ok()
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        self.send(Cmd::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(exits) = self.exits.take() {
            exits.stop();
        }
    }
}

// -------------------------------------------------------------------------
// The thread.

thread_local! {
    /// The thread's state, reached from the observers' callback.
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    /// Notifications that arrived while the state was busy (an
    /// accessibility call that ran the run loop): handled right after.
    static PENDING: RefCell<Vec<Note>> = const { RefCell::new(Vec::new()) };
}

/// A notification as the callback took it.
struct Note {
    pid: u32,
    element: CFRetained<AXUIElement>,
    name: String,
    at: Instant,
}

#[allow(unsafe_code)]
fn default_mode() -> Option<&'static CFRunLoopMode> {
    // SAFETY: reading a constant CFString Core Foundation defines, alive
    // for the process and never written.
    unsafe { kCFRunLoopDefaultMode }
}

/// The source's `perform`: nothing - signalling it only makes the run
/// loop return, and the loop below drains the commands.
extern "C-unwind" fn woken(_info: *mut c_void) {}

#[allow(unsafe_code)]
fn wake_source() -> Option<CFRetained<CFRunLoopSource>> {
    let mut context = CFRunLoopSourceContext {
        version: 0,
        info: std::ptr::null_mut(),
        retain: None,
        release: None,
        copyDescription: None,
        equal: None,
        hash: None,
        schedule: None,
        cancel: None,
        perform: Some(woken),
    };
    // SAFETY: a version-0 context with no info and a `perform` that
    // touches nothing; Core Foundation copies the context during the call.
    unsafe { CFRunLoopSource::new(None, 0, &raw mut context) }
}

#[allow(clippy::float_arithmetic, clippy::cast_precision_loss)]
fn seconds(wait: Duration) -> f64 {
    wait.as_millis().min(3_600_000) as f64 / 1000.0
}

fn run(
    rx: Receiver<Cmd>,
    ready: &mpsc::SyncSender<Result<Waker, String>>,
    link: Option<Link>,
    observed: Arc<Mutex<Observed>>,
    kq: i32,
) {
    let (Some(run_loop), Some(source)) = (CFRunLoop::current(), wake_source()) else {
        let _ = ready.send(Err("no run loop for the observers' thread".to_owned()));
        return;
    };
    run_loop.add_source(Some(&source), default_mode());
    let waker = Waker {
        run_loop: run_loop.clone(),
        source,
    };
    if ready.send(Ok(waker)).is_err() {
        return;
    }
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            rx,
            link,
            observed,
            kq,
            run_loop,
            tables: BTreeMap::new(),
            apps: BTreeMap::new(),
            rechecks: Vec::new(),
            notes: 0,
            by_note: BTreeMap::new(),
            follows: 0,
            resyncs: 0,
            space_changes: 0,
            exited: Vec::new(),
            quit: false,
        });
    });
    loop {
        let wait = STATE.with(|s| s.borrow_mut().as_mut().and_then(State::step));
        let Some(wait) = wait else {
            break;
        };
        CFRunLoop::run_in_mode(default_mode(), seconds(wait), true);
    }
    // The observers go with the state (their sources leave the run loop).
    STATE.with(|s| s.borrow_mut().take());
}

/// The observers' callback, on this thread's run loop: handled at once
/// (the overlay moves now), or right after if the state is busy.
#[allow(unsafe_code)]
unsafe extern "C-unwind" fn noted(
    _observer: NonNull<AXObserver>,
    element: NonNull<AXUIElement>,
    notification: NonNull<CFString>,
    refcon: *mut c_void,
) {
    let at = Instant::now();
    // SAFETY: the system passes an element and a name that are alive for
    // the call; both are retained or copied before it returns.
    let (element, name) = unsafe { (element.as_ref(), notification.as_ref()) };
    let note = Note {
        // The pid was registered as the `refcon` (a number, not a pointer).
        pid: u32::try_from(refcon.addr()).unwrap_or(0),
        element: element.retain(),
        name: name.to_string(),
        at,
    };
    // Never unwind into the system's frames.
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| deliver(note)));
}

fn deliver(note: Note) {
    let left = STATE.with(|s| match s.try_borrow_mut() {
        Ok(mut state) => {
            if let Some(state) = state.as_mut() {
                state.note(note);
            }
            None
        }
        Err(_) => Some(note),
    });
    if let Some(note) = left {
        PENDING.with(|p| p.borrow_mut().push(note));
    }
}

/// A tracked table, as the observers follow it.
struct Followed {
    pid: u32,
    /// The window server's number.
    window: u32,
    title: String,
    /// Thousandths of a point.
    title_bar: i64,
    /// `AXWindowMiniaturized` seen, not `Deminiaturized` since.
    minimized: bool,
    /// When `AXWindowMiniaturized` came (the window server may still show
    /// the window for the animation).
    minimizing: Option<Instant>,
    /// What the engine was told (or told us) last.
    last: Option<Geometry>,
    /// What the AppKit thread was given last.
    sent: Option<Geometry>,
    element: Option<CFRetained<AXUIElement>>,
    /// The window notifications registered on `element`.
    registered: Vec<AxNote>,
    /// Closed: told once; untracked by the engine next.
    gone: bool,
    /// Its element was destroyed while the window server still showed the
    /// window: closed once the window leaves the screen, unless a new
    /// element is found for it first.
    orphaned: bool,
}

/// An observed process.
struct App {
    element: Option<CFRetained<AXUIElement>>,
    observer: Option<CFRetained<AXObserver>>,
    source: Option<CFRetained<CFRunLoopSource>>,
    registered: Vec<AxNote>,
    hidden: bool,
    error: Option<String>,
}

impl App {
    /// Its activations and focus changes are observed: its overlays are
    /// put back as they happen (the AppKit thread's look slows down).
    fn watched(&self) -> bool {
        self.registered.contains(&AxNote::Activated)
            || self.registered.contains(&AxNote::FocusedWindowChanged)
    }
}

struct State {
    rx: Receiver<Cmd>,
    link: Option<Link>,
    observed: Arc<Mutex<Observed>>,
    kq: i32,
    run_loop: CFRetained<CFRunLoop>,
    tables: BTreeMap<WindowId, Followed>,
    apps: BTreeMap<u32, App>,
    /// Reads due later (after a notification an animation may outrun).
    /// (due, table, the notification it answers).
    rechecks: Vec<(Instant, WindowId, Option<Instant>)>,
    notes: u64,
    by_note: BTreeMap<String, u64>,
    follows: u64,
    resyncs: u64,
    space_changes: u64,
    exited: Vec<u32>,
    quit: bool,
}

impl State {
    /// Commands, notifications kept aside, rechecks due; how long the run
    /// loop may wait now (`None`: quit).
    fn step(&mut self) -> Option<Duration> {
        loop {
            match self.rx.try_recv() {
                Ok(command) => self.handle(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => self.quit = true,
            }
            if self.quit {
                return None;
            }
        }
        let pending = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
        for note in pending {
            self.note(note);
        }
        let now = Instant::now();
        let due: Vec<(WindowId, Option<Instant>)> = self
            .rechecks
            .iter()
            .filter(|(due, _, _)| *due <= now)
            .map(|(_, t, at)| (*t, *at))
            .collect();
        self.rechecks.retain(|(due, _, _)| *due > now);
        for (table, at) in due {
            self.follow(table, at);
        }
        let next = self.rechecks.iter().map(|(due, _, _)| *due).min();
        Some(next.map_or(IDLE, |at| at.saturating_duration_since(now)))
    }

    fn handle(&mut self, command: Cmd) {
        match command {
            Cmd::Track {
                table,
                pid,
                title,
                title_bar,
                known,
            } => self.track(table, pid, title, title_bar, known),
            Cmd::Untrack { table } => self.untrack(table),
            Cmd::Resync {
                table,
                title_bar,
                known,
            } => {
                self.resyncs += 1;
                if let Some(f) = self.tables.get_mut(&table) {
                    f.last = Some(known);
                    if let Some(bar) = title_bar {
                        f.title_bar = bar;
                    }
                    // The find's minimised (an empty client area) - which
                    // only counts while the window server does not show
                    // the window (`follow`), so an older description
                    // cannot hide a table that is back.
                    f.minimized = known.hidden && known.client.width == 0;
                    // Placed again from the table as it is now, whatever
                    // the AppKit thread was given before.
                    f.sent = None;
                    if f.element.is_none() {
                        self.resolve(table);
                    }
                    self.follow(table, None);
                }
            }
            Cmd::SpaceChanged => {
                self.space_changes += 1;
                let tables: Vec<WindowId> = self.tables.keys().copied().collect();
                for table in tables {
                    self.resolve(table);
                    self.follow(table, None);
                    self.recheck(table);
                }
                if let Some(link) = &self.link {
                    let _ = link.restack();
                }
            }
            Cmd::Exited { pid } => self.exited(pid),
            Cmd::Info { reply } => {
                let _ = reply.send(self.info());
            }
            Cmd::Quit => self.quit = true,
        }
    }

    fn observe(&self, add: impl FnOnce(&mut Observed)) {
        add(&mut self.observed.lock().unwrap_or_else(PoisonError::into_inner));
    }

    fn track(
        &mut self,
        table: WindowId,
        pid: u32,
        title: String,
        title_bar: Option<i64>,
        known: Geometry,
    ) {
        let Ok(window) = u32::try_from(table.0) else {
            return;
        };
        self.observe_process(pid);
        let bar = title_bar.or_else(|| {
            let cg = ffi::cg_window(window)?;
            (known.client.width > 0)
                .then(|| title_bar_between(&cg.bounds, &known.client, known.scale_permille))
        });
        self.tables.insert(
            table,
            Followed {
                pid,
                window,
                title,
                title_bar: bar.unwrap_or(0),
                minimized: known.hidden && known.client.width == 0,
                minimizing: None,
                last: Some(known),
                sent: None,
                element: None,
                registered: Vec::new(),
                gone: false,
                orphaned: false,
            },
        );
        self.resolve(table);
        if let Some(link) = &self.link {
            let watched = self.apps.get(&pid).is_some_and(App::watched);
            let _ = link.watched(table, watched);
        }
        self.follow(table, None);
    }

    fn untrack(&mut self, table: WindowId) {
        let Some(mut followed) = self.tables.remove(&table) else {
            return;
        };
        self.unregister(&mut followed);
        self.rechecks.retain(|(_, t, _)| *t != table);
        let pid = followed.pid;
        if !self.tables.values().any(|f| f.pid == pid)
            && let Some(app) = self.apps.remove(&pid)
        {
            self.let_go(app);
        }
    }

    /// Observe process `pid` (once): its exit through the `kqueue`, its
    /// notifications through an `AXObserver` when the Accessibility
    /// permission is granted.
    fn observe_process(&mut self, pid: u32) {
        if self.apps.contains_key(&pid) {
            return;
        }
        if !watch_exit(self.kq, pid) {
            eprintln!("rail-hud: process {pid} is gone already");
        }
        let mut app = App {
            element: None,
            observer: None,
            source: None,
            registered: Vec::new(),
            hidden: false,
            error: None,
        };
        if ffi::trusted() {
            match ffi::app_element(pid).and_then(|element| {
                let (observer, source) = make_observer(pid)?;
                Ok((element, observer, source))
            }) {
                Ok((element, observer, source)) => {
                    self.run_loop.add_source(Some(&source), default_mode());
                    for note in AxNote::APP {
                        if register(&observer, &element, note, pid) {
                            app.registered.push(note);
                        }
                    }
                    eprintln!(
                        "rail-hud: observing process {pid} ({} of {} application notifications)",
                        app.registered.len(),
                        AxNote::APP.len()
                    );
                    app.element = Some(element);
                    app.observer = Some(observer);
                    app.source = Some(source);
                }
                Err(error) => {
                    eprintln!("rail-hud: no accessibility observer for process {pid}: {error}");
                    app.error = Some(error);
                }
            }
        } else {
            app.error = Some("the Accessibility permission is not granted".to_owned());
        }
        self.apps.insert(pid, app);
    }

    /// An observed process no longer needed: its observer's source leaves
    /// the run loop and the observer is released.
    fn let_go(&self, app: App) {
        if let Some(source) = &app.source {
            self.run_loop.remove_source(Some(source), default_mode());
        }
        drop(app);
    }

    /// Find `table`'s window element (by the window number, else by its
    /// frame) and register the window notifications on it.
    fn resolve(&mut self, table: WindowId) {
        let Some(followed) = self.tables.get(&table) else {
            return;
        };
        if followed.element.is_some() || followed.gone {
            return;
        }
        let pid = followed.pid;
        let window = followed.window;
        let Some(app) = self.apps.get(&pid) else {
            return;
        };
        let (Some(app_element), Some(observer)) = (&app.element, &app.observer) else {
            return;
        };
        let Ok(elements) = ffi::window_elements(app_element) else {
            return;
        };
        let taken: Vec<&AXUIElement> = self
            .tables
            .values()
            .filter_map(|f| f.element.as_deref())
            .collect();
        let numbered = elements
            .iter()
            .find(|e| ffi::window_id_of(e) == Some(window));
        let element = numbered.or_else(|| {
            let bounds = ffi::cg_window(window)?.bounds;
            elements.iter().find(|e| {
                !taken.iter().any(|t| *t == &***e)
                    && ffi::window_id_of(e).is_none()
                    && ffi::ax_window(e)
                        .frame
                        .is_some_and(|f: Frame| f.close_to(&bounds))
            })
        });
        let Some(element) = element.cloned() else {
            return;
        };
        let registered: Vec<AxNote> = AxNote::WINDOW
            .into_iter()
            .filter(|note| register(observer, &element, *note, pid))
            .collect();
        if let Some(followed) = self.tables.get_mut(&table) {
            followed.element = Some(element);
            followed.registered = registered;
            followed.orphaned = false;
        }
    }

    /// Remove `followed`'s window notifications.
    fn unregister(&self, followed: &mut Followed) {
        let Some(element) = followed.element.take() else {
            return;
        };
        let Some(observer) = self
            .apps
            .get(&followed.pid)
            .and_then(|a| a.observer.as_deref())
        else {
            return;
        };
        for note in followed.registered.drain(..) {
            unregister(observer, &element, note);
        }
    }

    /// A notification.
    fn note(&mut self, note: Note) {
        self.notes += 1;
        *self.by_note.entry(note.name.clone()).or_default() += 1;
        let Some(kind) = AxNote::from_name(&note.name) else {
            return;
        };
        let effect = kind.effect();
        let pid = note.pid;
        let table = if kind.about_window() {
            let found = self
                .tables
                .iter()
                .find(|(_, f)| f.pid == pid && f.element.as_deref() == Some(&*note.element))
                .map(|(id, _)| *id)
                .or_else(|| {
                    // Not the element registered on (an element the client
                    // made anew): its window number says which table.
                    let number = ffi::window_id_of(&note.element)?;
                    self.tables
                        .iter()
                        .find(|(_, f)| f.pid == pid && f.window == number)
                        .map(|(id, _)| *id)
                });
            let Some(found) = found else {
                return;
            };
            Some(found)
        } else {
            None
        };
        if let Some(hidden) = effect.app_hidden
            && let Some(app) = self.apps.get_mut(&pid)
        {
            app.hidden = hidden;
        }
        if effect.appeared {
            self.observe(|o| o.appeared = true);
        }
        if effect.resolve {
            let unresolved: Vec<WindowId> = self
                .tables
                .iter()
                .filter(|(_, f)| f.pid == pid && f.element.is_none())
                .map(|(id, _)| *id)
                .collect();
            for table in unresolved {
                self.resolve(table);
                self.follow(table, None);
            }
        }
        if let Some(table) = table {
            if effect.gone {
                self.destroyed(table);
                return;
            }
            if let Some(minimized) = effect.minimized
                && let Some(f) = self.tables.get_mut(&table)
            {
                f.minimized = minimized;
                f.minimizing = minimized.then_some(note.at);
            }
            if effect.title {
                self.title(table);
            }
            if effect.title_bar {
                self.title_bar(table);
            }
        }
        let targets: Vec<WindowId> = match effect.read {
            Read::None => Vec::new(),
            Read::Window => table.into_iter().collect(),
            Read::App => self
                .tables
                .iter()
                .filter(|(_, f)| f.pid == pid)
                .map(|(id, _)| *id)
                .collect(),
        };
        for table in targets {
            self.follow(table, Some(note.at));
            if effect.recheck {
                self.recheck(table);
            }
            if effect.settle {
                // The window server's list may not show the move yet: read
                // it again over the next frames (`SETTLE`).
                let now = Instant::now();
                self.rechecks
                    .retain(|(_, t, at)| *t != table || at.is_none());
                for after in SETTLE {
                    self.rechecks.push((now + after, table, Some(note.at)));
                }
            }
        }
        if effect.restack
            && let Some(link) = &self.link
        {
            let _ = link.restack();
        }
    }

    fn recheck(&mut self, table: WindowId) {
        let now = Instant::now();
        for after in RECHECKS {
            self.rechecks.push((now + after, table, None));
        }
    }

    /// Read `table` from the window server and put its overlay where it is
    /// now; tell the engine what changed. `at`: the notification this
    /// answers (the AppKit thread measures the follow from it).
    fn follow(&mut self, table: WindowId, at: Option<Instant>) {
        let Some(f) = self.tables.get(&table) else {
            return;
        };
        if f.gone {
            return;
        }
        let Some(cg) = ffi::cg_window(f.window).filter(|w| w.onscreen || !f.orphaned) else {
            self.gone(table);
            return;
        };
        let app_hidden = self.apps.get(&f.pid).is_some_and(|a| a.hidden);
        let minimizing = f
            .minimizing
            .is_some_and(|since| since.elapsed() < MINIMIZING);
        let minimized = f.minimized && (!cg.onscreen || minimizing);
        let displays = ffi::displays();
        let geometry = tracked_geometry(
            &cg.bounds,
            cg.onscreen,
            f.title_bar,
            minimized,
            app_hidden,
            &displays,
        );
        let Some(f) = self.tables.get_mut(&table) else {
            return;
        };
        let report = f.last != Some(geometry);
        f.last = Some(geometry);
        let send = f.sent != Some(geometry);
        f.sent = Some(geometry);
        if report {
            self.observe(|o| o.geometry(table, geometry));
        }
        if send && let Some(link) = &self.link {
            let _ = link.follow_at(table, geometry, at);
            self.follows += 1;
        }
    }

    /// `AXUIElementDestroyed`: closed - unless the window server still
    /// shows the window (its element was replaced, as a full-screen
    /// transition may do): then its element is looked for again. A window
    /// closing may linger off screen in the window server's list for a
    /// moment; it counts as closed.
    fn destroyed(&mut self, table: WindowId) {
        let Some(window) = self.tables.get(&table).map(|f| f.window) else {
            return;
        };
        if ffi::cg_window(window).is_some_and(|w| w.onscreen) {
            if let Some(followed) = self.tables.get_mut(&table) {
                // The element is dead: nothing to unregister (asking a
                // quitting client would wait out the timeout).
                followed.element = None;
                followed.registered.clear();
                followed.orphaned = true;
            }
            // Its element is looked for again on the client's next focus,
            // window or activation notification, or a Space change - not
            // now: a client that is quitting would hold the thread for the
            // accessibility timeout (CI: half a second for two tables).
            self.follow(table, None);
            // A window still closing leaves the screen a moment later.
            self.recheck(table);
        } else {
            self.gone(table);
        }
    }

    /// Closed: the overlay goes now (and no frame makes it again), the
    /// engine hears it once.
    fn gone(&mut self, table: WindowId) {
        let Some(mut followed) = self.tables.remove(&table) else {
            return;
        };
        if followed.gone {
            self.tables.insert(table, followed);
            return;
        }
        followed.gone = true;
        // Closed or its client gone: its element is dead, nothing to
        // unregister - asking a quitting client would wait out the
        // accessibility timeout (CI: 0.25 s a table).
        followed.element = None;
        followed.registered.clear();
        self.tables.insert(table, followed);
        if let Some(link) = &self.link {
            let _ = link.gone(table);
        }
        self.observe(|o| o.gone(table));
    }

    /// The title now: the engine reads it through the room's matcher.
    fn title(&mut self, table: WindowId) {
        let Some(title) = self
            .tables
            .get(&table)
            .and_then(|f| f.element.as_deref())
            .and_then(ffi::title_of)
        else {
            return;
        };
        if let Some(f) = self.tables.get_mut(&table)
            && f.title != title
        {
            f.title.clone_from(&title);
            self.observe(|o| o.title(table, title));
        }
    }

    /// The title bar again (a resize: full screen in or out, a toolbar).
    fn title_bar(&mut self, table: WindowId) {
        let Some(f) = self.tables.get(&table) else {
            return;
        };
        let Some(element) = f.element.as_deref() else {
            return;
        };
        // The client's own frame: the window server's may lag a resize.
        let ax = ffi::ax_window(element);
        let Some(frame) = ax.frame else {
            return;
        };
        let bar = title_bar(&ax, &frame);
        if let Some(f) = self.tables.get_mut(&table) {
            f.title_bar = bar;
        }
    }

    /// Process `pid` exited: its tables are gone.
    fn exited(&mut self, pid: u32) {
        self.exited.push(pid);
        let tables: Vec<WindowId> = self
            .tables
            .iter()
            .filter(|(_, f)| f.pid == pid)
            .map(|(id, _)| *id)
            .collect();
        for table in tables {
            self.gone(table);
        }
        if let Some(app) = self.apps.remove(&pid) {
            self.let_go(app);
        }
    }

    fn info(&self) -> TrackerInfo {
        TrackerInfo {
            processes: self
                .apps
                .iter()
                .map(|(pid, app)| {
                    (
                        *pid,
                        app.registered.iter().map(|n| n.name().to_owned()).collect(),
                        app.error.clone(),
                    )
                })
                .collect(),
            tables: self
                .tables
                .iter()
                .map(|(id, f)| {
                    (
                        *id,
                        f.element.is_some(),
                        f.registered.iter().map(|n| n.name().to_owned()).collect(),
                        f.last,
                    )
                })
                .collect(),
            notes: self.notes,
            by_note: self
                .by_note
                .iter()
                .map(|(name, n)| (name.clone(), *n))
                .collect(),
            follows: self.follows,
            resyncs: self.resyncs,
            space_changes: self.space_changes,
            exited: self.exited.clone(),
            trusted: ffi::trusted(),
            cpu_us: ffi::thread_cpu_us(),
        }
    }
}

/// An `AXObserver` for process `pid` calling [`noted`], and its run-loop
/// source.
#[allow(unsafe_code)]
fn make_observer(
    pid: u32,
) -> Result<(CFRetained<AXObserver>, CFRetained<CFRunLoopSource>), String> {
    let pid = libc::pid_t::try_from(pid).map_err(|e| e.to_string())?;
    let mut raw: *mut AXObserver = std::ptr::null_mut();
    // SAFETY: `raw` is a valid out pointer; `noted` has the callback's
    // signature and never unwinds into the caller.
    let error = unsafe { AXObserver::create(pid, Some(noted), NonNull::from(&mut raw)) };
    if error != AXError::Success {
        return Err(format!("AXObserverCreate: error {}", error.0));
    }
    let raw = NonNull::new(raw).ok_or("AXObserverCreate gave nothing")?;
    // SAFETY: a "Create" function's result: we own its one reference.
    let observer = unsafe { CFRetained::from_raw(raw) };
    // SAFETY: the observer is alive; the source it returns is retained by
    // the binding.
    let source = unsafe { observer.run_loop_source() };
    Ok((observer, source))
}

/// Register `note` on `element`, the observed process's pid as the
/// callback's `refcon` (a number, never dereferenced). Whether it took.
#[allow(unsafe_code)]
fn register(observer: &AXObserver, element: &AXUIElement, note: AxNote, pid: u32) -> bool {
    let name = CFString::from_static_str(note.name());
    let refcon = std::ptr::without_provenance_mut::<c_void>(usize::try_from(pid).unwrap_or(0));
    // SAFETY: the observer and element are alive for the call; `refcon`
    // is only handed back to `noted`, which reads it as a number.
    let error = unsafe { observer.add_notification(element, &name, refcon) };
    error == AXError::Success || error == AXError::NotificationAlreadyRegistered
}

#[allow(unsafe_code)]
fn unregister(observer: &AXObserver, element: &AXUIElement, note: AxNote) {
    let name = CFString::from_static_str(note.name());
    // SAFETY: the observer and element are alive for the call.
    let _ = unsafe { observer.remove_notification(element, &name) };
}

// -------------------------------------------------------------------------
// Process exits: a kqueue and the thread that waits on it.

/// The `kqueue` the observed processes' exits are registered with, and the
/// thread that waits on it.
struct Exits {
    kq: i32,
    thread: Option<JoinHandle<()>>,
}

/// The `EVFILT_USER` event that stops the waiting thread.
const STOP: usize = 1;

fn empty_event() -> libc::kevent {
    libc::kevent {
        ident: 0,
        filter: 0,
        flags: 0,
        fflags: 0,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

#[allow(unsafe_code)]
fn kevent_change(kq: i32, change: &libc::kevent) -> bool {
    // SAFETY: one change, read from a valid `kevent`; no event list.
    let r = unsafe {
        libc::kevent(
            kq,
            std::ptr::from_ref(change),
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    r >= 0
}

/// Ask for process `pid`'s exit on `kq`; `false` when it is gone already.
fn watch_exit(kq: i32, pid: u32) -> bool {
    let Ok(ident) = usize::try_from(pid) else {
        return false;
    };
    let change = libc::kevent {
        ident,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        ..empty_event()
    };
    kevent_change(kq, &change)
}

impl Exits {
    #[allow(unsafe_code)]
    fn new() -> Result<Self, String> {
        // SAFETY: no arguments; a new descriptor or -1.
        let kq = unsafe { libc::kqueue() };
        if kq < 0 {
            return Err("kqueue failed".to_owned());
        }
        let stop = libc::kevent {
            ident: STOP,
            filter: libc::EVFILT_USER,
            flags: libc::EV_ADD | libc::EV_CLEAR,
            ..empty_event()
        };
        if !kevent_change(kq, &stop) {
            close(kq);
            return Err("kevent (EVFILT_USER) failed".to_owned());
        }
        Ok(Self { kq, thread: None })
    }

    /// Start waiting: each exit becomes `Cmd::Exited` for the observers'
    /// thread.
    fn start(mut self, tx: Sender<Cmd>, waker: Arc<Waker>) -> Result<Self, String> {
        let kq = self.kq;
        let thread = std::thread::Builder::new()
            .name("rail-hud-exits".to_owned())
            .spawn(move || wait_exits(kq, &tx, &waker))
            .map_err(|e| e.to_string())?;
        self.thread = Some(thread);
        Ok(self)
    }

    fn stop(mut self) {
        let trigger = libc::kevent {
            ident: STOP,
            filter: libc::EVFILT_USER,
            fflags: libc::NOTE_TRIGGER,
            ..empty_event()
        };
        if kevent_change(self.kq, &trigger)
            && let Some(thread) = self.thread.take()
        {
            let _ = thread.join();
        }
        close(self.kq);
    }
}

#[allow(unsafe_code)]
fn close(fd: i32) {
    // SAFETY: closing a descriptor this module opened and owns.
    let _ = unsafe { libc::close(fd) };
}

#[allow(unsafe_code)]
fn wait_exits(kq: i32, tx: &Sender<Cmd>, waker: &Waker) {
    let mut events = [empty_event(); 8];
    let room = i32::try_from(events.len()).unwrap_or(1);
    loop {
        // SAFETY: `events` is writable for `room` events; no changes; no
        // timeout (waits until an event).
        let n = unsafe {
            libc::kevent(
                kq,
                std::ptr::null(),
                0,
                events.as_mut_ptr(),
                room,
                std::ptr::null(),
            )
        };
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        for event in &events[..usize::try_from(n).unwrap_or(0).min(events.len())] {
            if event.filter == libc::EVFILT_USER {
                return;
            }
            if event.filter == libc::EVFILT_PROC
                && let Ok(pid) = u32::try_from(event.ident)
            {
                if tx.send(Cmd::Exited { pid }).is_err() {
                    return;
                }
                waker.wake();
            }
        }
    }
}

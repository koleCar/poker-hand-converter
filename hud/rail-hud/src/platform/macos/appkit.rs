//! The overlays on macOS (R3.12): the AppKit thread, its windows, their
//! bitmaps and the panels' clicks and drags. macOS only; the decisions it
//! acts on are plain Rust in the parent module ([`super::appkit_frame`],
//! [`super::client_pixel`], [`super::stacking`]) and in the shared
//! [`crate::platform::tracking::plan`], [`crate::platform::drag`] and
//! [`crate::scene`] - every system's unit tests drive those.
//!
//! **The thread.** AppKit's windows and events belong to the main thread,
//! and the engine must never wait on them, nor they on the engine's store
//! reads and accessibility calls (up to 0.25 s per poker process, R3.11):
//! so, as on Windows, the two run side by side ([`run`]). The main thread
//! becomes an **accessory** application (`NSApplicationActivationPolicy::
//! Accessory`: no Dock icon, no menu bar, never the active app, never the
//! keyboard), finishes launching and pumps AppKit's event queue itself
//! (`nextEventMatchingMask:untilDate:inMode:dequeue:`), handing its own
//! panels' mouse events to [`Overlays::mouse`] before anything is
//! dispatched (`sendEvent:` gets the rest) - the Windows overlay thread's
//! pump, in AppKit's words. The engine runs on `rail-hud-engine` and hands
//! commands over a channel; when the channel goes from empty to not it
//! wakes the main thread by a block on the main dispatch queue (which the
//! run loop drains while it waits for events) that posts an
//! application-defined event, so a command is taken at once, never after a
//! tick. Queries (`info`, `pixel`, `times`) answer over a channel of their
//! own after every command sent before them.
//!
//! **The windows.** One `NSPanel` per table, **borderless, non-activating**
//! (`NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel`),
//! not opaque, a clear background, no shadow, not hidden on deactivation,
//! not movable, the normal window level, no animation, never key or main
//! (a borderless panel cannot become either). It covers the table's client
//! area exactly: the engine's client rect in physical pixels divided by the
//! scale back to points ([`super::rect_points`], exact for macOS's whole
//! scales), flipped into AppKit's bottom-left space against the main
//! display's height ([`super::to_appkit`]). It is **ordered directly above
//! its table** (`orderWindow:NSWindowAbove relativeTo:` the table's window
//! number - the `CGWindowID` the engine's window id is) whenever it is
//! shown. A cross-process window cannot be the owner of ours, as on
//! Windows, so the order is kept by looking, every 100 ms while overlays
//! show: per overlay one cheap question (~20 µs:
//! `NSWindow.windowNumberAtPoint:belowWindowWithWindowNumber:` at the
//! table's centre, below the overlay, must be the table - and the overlay
//! on the active Space), and only when one fails the active Space's whole
//! order (`NSWindow.windowNumbersWithOptions(AllApplications)`, front to
//! back: 2 - 6 ms with twelve tables' hundred-odd windows, measured) for
//! [`super::stacking`] to decide - restack it (its table was raised over
//! it, a window got between), or leave it (its table is not on this
//! Space; the engine hides it). **Spaces and full screen**: collection
//! behaviour `MoveToActiveSpace | Transient | IgnoresCycle |
//! FullScreenAuxiliary` - *not* `CanJoinAllSpaces` (it would show on every
//! Space): an overlay ordered in while its table is on the active Space
//! joins that Space (a full-screen table's too: auxiliary windows may share
//! a full-screen Space), stays out of Mission Control and the window
//! cycle, and is ordered out whenever the engine reports its table off
//! screen - minimised, on another Space, the app hidden
//! (`TableWindow.minimized`, R3.11) - and in again over the table when it
//! is back.
//!
//! **Clicks through, except on the panels** - with no permission at all:
//! the overlay window **ignores the mouse** (`ignoresMouseEvents = YES`),
//! so every click on it goes to whatever is below - the table. Over each
//! of the scene's panels (`Scene::panels`: the seats' panels and the
//! legend, every drawn thing that takes clicks on Windows too) sits a small
//! borderless non-activating panel of its own that **takes** the mouse
//! (`ignoresMouseEvents = NO`, and a background of alpha 1/255, so even
//! the window server's shape test sees it - invisible over the panel's
//! near-black), ordered directly above the overlay. A press there arrives
//! in this process's own event queue (the window server routes it to the
//! window under the pointer; a non-activating panel does not activate the
//! app), and the drag's moves and the release follow to the same window
//! wherever the pointer goes - the capture Windows needs `SetCapture` for.
//! No global event monitor, no event tap, no Input Monitoring, no
//! Accessibility for any of it. Not the window's own alpha, as on Windows:
//! measured, the window server hit-tests a layer-backed window that does
//! not ignore the mouse as a whole - a press on its transparent pixels
//! went to it, not to the table (`windowNumberAtPoint`) - and toggling
//! `ignoresMouseEvents` by where the pointer is would need its position
//! all the time (a poll, racing the press, or a monitor).
//!
//! **Drawing: Core Graphics into a bitmap, shown as a layer's contents.**
//! The scene ([`crate::scene::compose_with`], the frame's own design under
//! its permit's restrictions - exactly what Windows lays out) is painted on
//! the CPU into a premultiplied BGRA `CGBitmapContext` of the client area's
//! **physical pixels** (device RGB, the same bytes as Windows' DIB):
//! rounded rectangles as `CGPath`s, text as Core Text lines (`CTLine`, the
//! system UI font at the scene's pixel size, bold where the scene says;
//! font smoothing off, as on a transparent surface it must be); then
//! `CGBitmapContextCreateImage` becomes the `contents` of the root layer
//! of a layer-hosting view, with `contentsScale` = the table's backing
//! scale, inside a transaction with implicit animations off. Chosen over
//! `drawRect:` in an `NSView` subclass: no Objective-C class of our own
//! (no `define_class!`), AppKit never asks for a redraw of its own
//! (resizes and Space changes reuse the layer), the bitmap is exactly the
//! pixels the scene laid out - Retina text is rendered at the real pixel
//! size rather than scaled - and a test can read a pixel back as on
//! Windows. Core Text shapes and falls back across fonts like the rest of
//! macOS. **Redraws only on change**: an equal frame at the same client
//! size and scale is not painted again, a move only moves the windows, a
//! hidden table orders them out ([`crate::platform::tracking::plan`]).
//! Memory: one bitmap per table, 4 bytes per client pixel (a 640 x 480 pt
//! table on Retina: 4.7 MiB), and the image the layer holds shares it
//! until the next paint.
//!
//! **Panels: clicks and drags (R3.6, R3.8)** go through the shared
//! [`Drag`], fed this thread's mouse events in client pixels
//! ([`super::client_pixel`]): a press on a seat's panel starts a drag, a
//! move past the threshold repaints the panel where the pointer takes it
//! (laid out by the scene, so constrained during the drag too), the release
//! keeps it there (until the engine's frame carries it,
//! `Seating::drags_seen`) and notes `TableEvent::PanelMoved`; a press that
//! never moved is `TableEvent::PanelClicked` with the panel on the screen
//! (R3.8's popup). Both go to the engine through
//! [`crate::platform::tracking::Observed`] - no store work here, ever.
//!
//! **`unsafe`**: each function that needs it allows it for itself, with a
//! `// SAFETY:` comment per block: reading AppKit's and Core Text's
//! constant strings, Core Graphics' bitmap and path calls, a `CGImage` as a
//! layer's contents, and the windows' release-when-closed flag (we keep
//! them with `Retained` and close them ourselves). Everything else is
//! objc2's safe API with a [`MainThreadMarker`].

use std::collections::{HashMap, HashSet};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSColor, NSEvent,
    NSEventMask, NSEventModifierFlags, NSEventType, NSPanel, NSView, NSWindow,
    NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowNumberListOptions,
    NSWindowOrderingMode, NSWindowStyleMask, NSWorkspace,
    NSWorkspaceActiveSpaceDidChangeNotification,
};
use objc2_core_foundation::{
    CFAttributedString, CFBoolean, CFDictionary, CFRetained, CFString, CFType, CGAffineTransform,
    CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
    CGBitmapContextGetData, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, CGPath,
};
use objc2_core_text::{
    CTFont, CTFontUIFontType, CTLine, kCTFontAttributeName,
    kCTForegroundColorFromContextAttributeName,
};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSNotification, NSPoint, NSRect, NSSize};
use objc2_quartz_core::{CALayer, CATransaction};

use super::super::drag::{self, Drag};
use super::super::tracking::{self, Geometry, Observed, Placed, Plan};
use super::super::{OverlayFrame, PlatformError, Rect, TableEvent, WindowId};
use super::{
    Frame, HitInfo, Mouse, OverlayInfo, Stacking, appkit_frame, client_pixel, ffi, milli,
    restack_every, stacking,
};
use crate::layout::Positions;
use crate::scene::{Item, Rgba, Scene, compose_with};

/// The application-defined event's subtype that says "the channel has
/// commands".
const WAKE: i16 = 0x52;

/// How long the pump waits for an event when nothing shows (a command
/// wakes it at once anyway).
const IDLE_WAIT: Duration = Duration::from_secs(5);

/// Paint times kept for `times` (the most recent).
const KEEP_TIMES: usize = 10_000;

/// How long a query waits for the AppKit thread.
const ASK: Duration = Duration::from_secs(10);

/// What the engine's thread hands the AppKit thread.
pub(super) enum Command {
    Frame {
        table: WindowId,
        frame: Box<OverlayFrame>,
        geometry: Geometry,
    },
    /// The table as it is now (R3.13: from the observers; `at`: the
    /// notification it answers, for the follow time).
    Follow {
        table: WindowId,
        geometry: Geometry,
        at: Option<Instant>,
    },
    Remove {
        table: WindowId,
    },
    /// (R3.13) The table closed (the observers saw it): its overlay goes
    /// now and no frame makes it again until the engine untracks it.
    Gone {
        table: WindowId,
    },
    /// (R3.13) A client was activated or its focus moved: put every
    /// overlay back directly above its table now.
    Restack,
    /// (R3.13) Whether the table's client is observed (activations and
    /// focus changes restack at once): the stacking look slows down.
    Watched {
        table: WindowId,
        watched: bool,
    },
    /// (R3.13) What to call when the active Space changed.
    OnSpaceChange {
        handler: Box<dyn Fn() + Send>,
    },
    /// (R3.13, tests) Post `activeSpaceDidChangeNotification` on the
    /// workspace's notification centre, in this process only.
    SimulateSpaceChange,
    FollowTimes {
        reply: Sender<Vec<u64>>,
    },
    SpaceChanges {
        reply: Sender<u64>,
    },
    Cpu {
        reply: Sender<u64>,
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
    Inject {
        table: WindowId,
        mouse: Mouse,
        reply: Sender<bool>,
    },
    WindowAt {
        point: (i64, i64),
        below: u32,
        reply: Sender<u32>,
    },
    Quit,
}

/// The engine thread's way to the AppKit thread: `Send` and `Clone`.
#[derive(Clone)]
pub struct Link {
    tx: Sender<Command>,
    /// A wake is on its way (the channel went from empty to not).
    pending: Arc<AtomicBool>,
    /// The panels' clicks and drops, for `poll_events`.
    observed: Arc<Mutex<Observed>>,
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Link").finish_non_exhaustive()
    }
}

impl Link {
    fn send(&self, command: Command) -> Result<(), PlatformError> {
        self.tx
            .send(command)
            .map_err(|_| PlatformError::Os("the AppKit thread is gone".to_owned()))?;
        if !self.pending.swap(true, Ordering::AcqRel) {
            DispatchQueue::main().exec_async(post_wake);
        }
        Ok(())
    }

    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Command) -> Option<T> {
        let (reply, answer) = mpsc::channel();
        self.send(make(reply)).ok()?;
        answer.recv_timeout(ASK).ok()
    }

    pub(super) fn frame(
        &self,
        table: WindowId,
        frame: OverlayFrame,
        geometry: Geometry,
    ) -> Result<(), PlatformError> {
        self.send(Command::Frame {
            table,
            frame: Box::new(frame),
            geometry,
        })
    }

    pub(super) fn follow(&self, table: WindowId, geometry: Geometry) -> Result<(), PlatformError> {
        self.follow_at(table, geometry, None)
    }

    /// (R3.13) The table as it is now, read by the observers in answer to
    /// a notification that came `at`.
    pub(super) fn follow_at(
        &self,
        table: WindowId,
        geometry: Geometry,
        at: Option<Instant>,
    ) -> Result<(), PlatformError> {
        self.send(Command::Follow {
            table,
            geometry,
            at,
        })
    }

    /// (R3.13) The table closed.
    pub(super) fn gone(&self, table: WindowId) -> Result<(), PlatformError> {
        self.send(Command::Gone { table })
    }

    /// (R3.13) Put every overlay back above its table now.
    pub(super) fn restack(&self) -> Result<(), PlatformError> {
        self.send(Command::Restack)
    }

    /// (R3.13) Whether the table's client is observed.
    pub(super) fn watched(&self, table: WindowId, watched: bool) -> Result<(), PlatformError> {
        self.send(Command::Watched { table, watched })
    }

    /// (R3.13) Call `handler` (on the AppKit thread) when the active Space
    /// changes.
    pub(super) fn on_space_change(
        &self,
        handler: impl Fn() + Send + 'static,
    ) -> Result<(), PlatformError> {
        self.send(Command::OnSpaceChange {
            handler: Box::new(handler),
        })
    }

    /// (R3.13, tests) As if the user switched Spaces: the notification is
    /// posted in this process only.
    pub(super) fn simulate_space_change(&self) -> Result<(), PlatformError> {
        self.send(Command::SimulateSpaceChange)
    }

    /// (R3.13) Every follow from a notification so far: µs from the
    /// notification to the overlay moved, shown or hidden.
    pub(super) fn follow_times(&self) -> Option<Vec<u64>> {
        self.ask(|reply| Command::FollowTimes { reply })
    }

    /// (R3.13) Active Space changes seen.
    pub(super) fn space_changes(&self) -> Option<u64> {
        self.ask(|reply| Command::SpaceChanges { reply })
    }

    /// (R3.13) The AppKit thread's CPU time so far, µs.
    pub(super) fn cpu_us(&self) -> Option<u64> {
        self.ask(|reply| Command::Cpu { reply })
    }

    pub(super) fn remove(&self, table: WindowId) -> Result<(), PlatformError> {
        self.send(Command::Remove { table })
    }

    /// What was clicked and dropped since the last call.
    pub(super) fn observed(&self) -> Observed {
        std::mem::take(&mut *self.observed.lock().unwrap_or_else(PoisonError::into_inner))
    }

    pub(super) fn info(&self, table: WindowId) -> Option<OverlayInfo> {
        self.ask(|reply| Command::Info { table, reply }).flatten()
    }

    pub(super) fn pixel(&self, table: WindowId, x: u32, y: u32) -> Option<[u8; 4]> {
        self.ask(|reply| Command::Pixel { table, x, y, reply })
            .flatten()
    }

    pub(super) fn times(&self) -> Option<Vec<u64>> {
        self.ask(|reply| Command::Times { reply })
    }

    pub(super) fn inject(&self, table: WindowId, mouse: Mouse) -> Option<bool> {
        self.ask(|reply| Command::Inject {
            table,
            mouse,
            reply,
        })
    }

    pub(super) fn window_at(&self, point: (i64, i64), below: u32) -> Option<u32> {
        self.ask(|reply| Command::WindowAt {
            point,
            below,
            reply,
        })
    }
}

/// On the main thread (the main dispatch queue): an application-defined
/// event that makes the pump's wait return.
fn post_wake() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType::ApplicationDefined,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::empty(),
        0.0,
        0,
        None,
        WAKE,
        0,
        0,
    );
    if let Some(event) = event {
        NSApplication::sharedApplication(mtm).postEvent_atStart(&event, false);
    }
}

fn is_wake(event: &NSEvent) -> bool {
    // `subtype` is asked of an application-defined event only (AppKit
    // raises for some other types).
    event.r#type() == NSEventType::ApplicationDefined && event.subtype().0 == WAKE
}

/// The HUD process's `main` on macOS ([`super::with_appkit`]): AppKit here,
/// `engine` on a thread of its own; its exit code once it returns and the
/// overlays are closed.
pub(super) fn run<F>(engine: F) -> i32
where
    F: FnOnce(Option<Link>) -> i32 + Send + 'static,
{
    let Some(mtm) = MainThreadMarker::new() else {
        return engine(None);
    };
    let app = NSApplication::sharedApplication(mtm);
    // No Dock icon, no menu bar, never activated: the HUD never takes the
    // keyboard from a table.
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();

    let (tx, rx) = mpsc::channel();
    let link = Link {
        tx,
        pending: Arc::new(AtomicBool::new(false)),
        observed: Arc::default(),
    };
    let pending = Arc::clone(&link.pending);
    let observed = Arc::clone(&link.observed);
    let quit = link.clone();
    let spawned = std::thread::Builder::new()
        .name("rail-hud-engine".to_owned())
        .spawn(move || {
            /// The AppKit thread stops when the engine is done, however it
            /// ends (a panic included).
            struct Quit(Link);
            impl Drop for Quit {
                fn drop(&mut self) {
                    let _ = self.0.send(Command::Quit);
                }
            }
            let _quit = Quit(quit);
            engine(Some(link))
        });
    let handle = match spawned {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("rail-hud: the engine's thread: {error}");
            return 1;
        }
    };
    let mut overlays = Overlays::new(mtm, app.clone(), observed);
    overlays.observe_spaces();
    pump(&app, &rx, &pending, &mut overlays);
    overlays.close_all();
    handle.join().unwrap_or(101)
}

/// The main thread's loop: commands, the stacking check, AppKit's events,
/// until `Quit` (or every link is gone).
fn pump(
    app: &NSApplication,
    commands: &Receiver<Command>,
    pending: &AtomicBool,
    overlays: &mut Overlays,
) {
    loop {
        let quit = autoreleasepool(|_| {
            // Cleared before the channel is read: a command sent after this
            // wakes the wait below again.
            pending.store(false, Ordering::Release);
            loop {
                match commands.try_recv() {
                    Ok(Command::Quit) | Err(TryRecvError::Disconnected) => return true,
                    Ok(command) => overlays.handle(command),
                    Err(TryRecvError::Empty) => break,
                }
            }
            overlays.space_changed();
            let now = Instant::now();
            overlays.restack_if_due(now);
            let wait = overlays.wait(now);
            let until = NSDate::dateWithTimeIntervalSinceNow(seconds(wait));
            let event = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                NSEventMask::Any,
                Some(&until),
                default_mode(),
                true,
            );
            if let Some(event) = event
                && !is_wake(&event)
                && !overlays.mouse(&event)
            {
                app.sendEvent(&event);
            }
            false
        });
        if quit {
            return;
        }
    }
}

#[allow(unsafe_code)]
fn default_mode() -> &'static objc2_foundation::NSRunLoopMode {
    // SAFETY: reading a constant `NSString` Foundation defines, alive for
    // the process and never written.
    unsafe { NSDefaultRunLoopMode }
}

#[allow(clippy::float_arithmetic, clippy::cast_precision_loss)]
fn seconds(wait: Duration) -> f64 {
    // At most `IDLE_WAIT`: far inside an f64's exact range.
    wait.as_millis().min(3_600_000) as f64 / 1000.0
}

/// Thousandths of a point as a `CGFloat`.
#[allow(clippy::float_arithmetic)]
fn points(milli: i64) -> CGFloat {
    let clamped = i32::try_from(milli).unwrap_or(if milli < 0 { i32::MIN } else { i32::MAX });
    f64::from(clamped) / 1000.0
}

fn ns_rect(frame: &Frame) -> NSRect {
    NSRect::new(
        NSPoint::new(points(frame.x), points(frame.y)),
        NSSize::new(points(frame.width), points(frame.height)),
    )
}

fn wide(number: isize) -> i64 {
    i64::try_from(number).unwrap_or(0)
}

/// A borderless, non-activating, transparent panel at `frame` (AppKit's
/// space): the overlay (`takes_mouse` false: every click goes through) or
/// a panel's click window.
#[allow(unsafe_code)]
fn make_panel(mtm: MainThreadMarker, frame: &Frame, takes_mouse: bool) -> Retained<NSPanel> {
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        ns_rect(frame),
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    // SAFETY: the window is kept alive by our `Retained` and closed by us
    // (`close`); released on close as well, it would be released twice.
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setOpaque(false);
    panel.setHasShadow(false);
    panel.setHidesOnDeactivate(false);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setFloatingPanel(false);
    panel.setCanHide(false);
    panel.setMovable(false);
    panel.setAnimationBehavior(NSWindowAnimationBehavior::None);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::MoveToActiveSpace
            | NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    panel.setIgnoresMouseEvents(!takes_mouse);
    if takes_mouse {
        // Alpha 1/255: invisible over the panel's near-black, and not
        // "transparent" to the window server's shape test either.
        panel.setBackgroundColor(Some(&NSColor::colorWithWhite_alpha(0.0, unit(1))));
    } else {
        panel.setBackgroundColor(Some(&NSColor::clearColor()));
    }
    panel
}

/// A click window over one panel.
struct Hit {
    panel: Retained<NSPanel>,
    /// The panel, client-relative physical pixels.
    rect: Rect,
    /// Where it was put, AppKit's space.
    frame: Frame,
    shown: bool,
}

/// One table's overlay.
struct Overlay {
    /// The table's window number (`CGWindowID`).
    table: isize,
    panel: Retained<NSPanel>,
    layer: Retained<CALayer>,
    /// Click windows; the first `used` cover the scene's panels.
    hits: Vec<Hit>,
    used: usize,
    geometry: Geometry,
    frame: Option<OverlayFrame>,
    dirty: bool,
    painted: Option<(u32, u32, u32)>,
    /// Where it was put: the client origin (physical pixels) and its
    /// AppKit frame.
    at: (i32, i32),
    placed: Frame,
    shown: bool,
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
    drags: u64,
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

    fn number(&self) -> isize {
        self.panel.windowNumber()
    }

    /// The click windows in use, shown.
    fn shown_hits(&self) -> Vec<i64> {
        self.hits[..self.used]
            .iter()
            .filter(|h| h.shown)
            .map(|h| wide(h.panel.windowNumber()))
            .collect()
    }

    /// Order the overlay directly above its table, then its click windows
    /// directly above it.
    fn order_in(&mut self) {
        self.panel
            .orderWindow_relativeTo(NSWindowOrderingMode::Above, self.table);
        self.shown = true;
        let above = self.number();
        for hit in &mut self.hits[..self.used] {
            hit.panel
                .orderWindow_relativeTo(NSWindowOrderingMode::Above, above);
            hit.shown = true;
        }
    }

    /// The cheap look (one window-server question, ~20 µs): the overlay is
    /// on the active Space and the window a press at its table's centre
    /// would reach *below the overlay* is the table - nothing was raised
    /// over the overlay or got between. `false` asks for the full look
    /// ([`stacking`]).
    fn looks_stacked(&self, mtm: MainThreadMarker, main_height: i64) -> bool {
        if !self.panel.isOnActiveSpace() {
            return false;
        }
        let g = self.geometry;
        let centre = Rect {
            x: g.client
                .x
                .saturating_add(i32::try_from(g.client.width / 2).unwrap_or(0)),
            y: g.client
                .y
                .saturating_add(i32::try_from(g.client.height / 2).unwrap_or(0)),
            width: 0,
            height: 0,
        };
        let at = appkit_frame(&centre, g.scale_permille, main_height);
        NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(
            NSPoint::new(points(at.x), points(at.y)),
            self.number(),
            mtm,
        ) == self.table
    }

    fn order_out(&mut self) {
        for hit in &mut self.hits {
            if hit.shown {
                hit.panel.orderOut(None);
                hit.shown = false;
            }
        }
        self.panel.orderOut(None);
        self.shown = false;
    }

    /// The click windows over the scene's panels where the table is now:
    /// made, moved and shown or ordered out to match.
    fn place_hits(&mut self, mtm: MainThreadMarker, main_height: i64, reorder: bool) {
        let g = self.geometry;
        let rects = self.scene.panels.clone();
        for (i, rect) in rects.iter().enumerate() {
            let screen = Rect {
                x: g.client.x.saturating_add(rect.x),
                y: g.client.y.saturating_add(rect.y),
                ..*rect
            };
            let frame = appkit_frame(&screen, g.scale_permille, main_height);
            if i == self.hits.len() {
                self.hits.push(Hit {
                    panel: make_panel(mtm, &frame, true),
                    rect: *rect,
                    frame,
                    shown: false,
                });
            }
            let hit = &mut self.hits[i];
            if hit.frame != frame {
                hit.panel.setFrame_display(ns_rect(&frame), false);
                hit.frame = frame;
            }
            hit.rect = *rect;
        }
        self.used = rects.len();
        let above = self.number();
        let shown = self.shown;
        for (i, hit) in self.hits.iter_mut().enumerate() {
            if i < rects.len() && shown {
                // (R3.13) Only moved when it is already in place above the
                // overlay (a move of the table).
                if reorder || !hit.shown {
                    hit.panel
                        .orderWindow_relativeTo(NSWindowOrderingMode::Above, above);
                }
                hit.shown = true;
            } else if hit.shown {
                hit.panel.orderOut(None);
                hit.shown = false;
            }
        }
    }

    fn close(self) {
        for hit in &self.hits {
            hit.panel.orderOut(None);
            hit.panel.close();
        }
        self.panel.orderOut(None);
        self.panel.close();
    }
}

/// Everything on the AppKit thread.
struct Overlays {
    mtm: MainThreadMarker,
    app: Retained<NSApplication>,
    painter: Painter,
    windows: HashMap<WindowId, Overlay>,
    times: Vec<u64>,
    observed: Arc<Mutex<Observed>>,
    /// Drags dropped so far, on every overlay (R3.6).
    drag_seq: u64,
    next_restack: Instant,
    /// (R3.13) The tables as the observers last read them: an overlay is
    /// placed from this, not from the engine's (older) description.
    followed: HashMap<WindowId, Geometry>,
    /// (R3.13) Tables the observers saw close, until the engine untracks
    /// them: a frame for one makes no window.
    gone: HashSet<WindowId>,
    /// (R3.13) Tables whose client is observed.
    watched: HashSet<WindowId>,
    /// (R3.13) Notification -> overlay put right, µs.
    follow_times: Vec<u64>,
    /// (R3.13) Active Space changes: counted by the notification's block,
    /// acted on by the pump.
    spaces: Arc<AtomicU64>,
    spaces_seen: u64,
    on_space_change: Option<Box<dyn Fn() + Send>>,
    space_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
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
    fn new(
        mtm: MainThreadMarker,
        app: Retained<NSApplication>,
        observed: Arc<Mutex<Observed>>,
    ) -> Self {
        Self {
            mtm,
            app,
            painter: Painter::default(),
            windows: HashMap::new(),
            times: Vec::new(),
            observed,
            drag_seq: 0,
            next_restack: Instant::now(),
            followed: HashMap::new(),
            gone: HashSet::new(),
            watched: HashSet::new(),
            follow_times: Vec::new(),
            spaces: Arc::default(),
            spaces_seen: 0,
            on_space_change: None,
            space_observer: None,
        }
    }

    /// (R3.13) Count the active Space's changes
    /// (`NSWorkspace.activeSpaceDidChangeNotification`, posted on this
    /// thread) and wake the pump for each.
    #[allow(unsafe_code)]
    fn observe_spaces(&mut self) {
        let spaces = Arc::clone(&self.spaces);
        let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
            spaces.fetch_add(1, Ordering::AcqRel);
            DispatchQueue::main().exec_async(post_wake);
        });
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: reading a constant `NSString` AppKit defines, alive for
        // the process and never written.
        let name = unsafe { NSWorkspaceActiveSpaceDidChangeNotification };
        // SAFETY: no object filter; no queue (the block runs where the
        // notification is posted: AppKit posts this one on the main
        // thread); the block only counts and schedules a wake, both
        // thread-safe; the token is kept and removed on close.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        self.space_observer = Some(token);
    }

    /// (R3.13) The active Space changed since the last look: the observers
    /// read every table again (an overlay whose table is now off screen is
    /// ordered out, one whose table is back is ordered in), and the
    /// stacking is checked now.
    fn space_changed(&mut self) {
        let now = self.spaces.load(Ordering::Acquire);
        if now == self.spaces_seen {
            return;
        }
        self.spaces_seen = now;
        if let Some(handler) = &self.on_space_change {
            handler();
        }
        self.restack_now();
    }

    /// (R3.13, tests) Post the Space notification here, as AppKit would.
    #[allow(unsafe_code)]
    fn simulate_space_change(&self) {
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: as in `observe_spaces`: a constant `NSString`.
        let name = unsafe { NSWorkspaceActiveSpaceDidChangeNotification };
        // SAFETY: the notification's documented form: no object.
        unsafe { center.postNotificationName_object(name, None) };
    }

    /// (R3.13) Whether every shown overlay's client is observed.
    fn all_watched(&self) -> bool {
        self.windows
            .iter()
            .filter(|(_, o)| o.shown)
            .all(|(table, _)| self.watched.contains(table))
    }

    /// (R3.13) Check the stacking now, and once more a moment later (an
    /// activation's reordering may still be on its way).
    fn restack_now(&mut self) {
        let now = Instant::now();
        self.next_restack = now;
        self.restack_if_due(now);
        self.next_restack = now + Duration::from_millis(50);
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Frame {
                table,
                frame,
                geometry,
            } => self.frame(table, *frame, geometry),
            Command::Follow {
                table,
                geometry,
                at,
            } => {
                if self.gone.contains(&table) {
                    return;
                }
                self.followed.insert(table, geometry);
                if self.windows.contains_key(&table) {
                    let plan = self.sync(table, geometry);
                    if let Some(at) = at
                        && plan != Plan::Keep
                    {
                        keep(&mut self.follow_times, micros(at));
                    }
                }
            }
            Command::Remove { table } => {
                if let Some(overlay) = self.windows.remove(&table) {
                    overlay.close();
                }
                self.followed.remove(&table);
                self.gone.remove(&table);
                self.watched.remove(&table);
            }
            Command::Gone { table } => {
                if let Some(overlay) = self.windows.remove(&table) {
                    overlay.close();
                }
                self.followed.remove(&table);
                self.gone.insert(table);
            }
            Command::Restack => self.restack_now(),
            Command::Watched { table, watched } => {
                if watched {
                    self.watched.insert(table);
                } else {
                    self.watched.remove(&table);
                }
            }
            Command::OnSpaceChange { handler } => self.on_space_change = Some(handler),
            Command::SimulateSpaceChange => self.simulate_space_change(),
            Command::FollowTimes { reply } => {
                let _ = reply.send(self.follow_times.clone());
            }
            Command::SpaceChanges { reply } => {
                let _ = reply.send(self.spaces.load(Ordering::Acquire));
            }
            Command::Cpu { reply } => {
                let _ = reply.send(ffi::thread_cpu_us());
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
            Command::Inject {
                table,
                mouse,
                reply,
            } => {
                let _ = reply.send(self.inject(table, mouse));
            }
            Command::WindowAt {
                point,
                below,
                reply,
            } => {
                let at = NSPoint::new(points(point.0), points(ffi::main_height() - point.1));
                let below = isize::try_from(below).unwrap_or(0);
                let number =
                    NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(at, below, self.mtm);
                let _ = reply.send(u32::try_from(number).unwrap_or(0));
            }
            Command::Quit => {}
        }
    }

    fn observe(&self, add: impl FnOnce(&mut Observed)) {
        add(&mut self.observed.lock().unwrap_or_else(PoisonError::into_inner));
    }

    /// A new frame for `table`, as it is `geometry`: the overlay made on
    /// first use, painted when the frame differs from the one shown.
    fn frame(&mut self, table: WindowId, frame: OverlayFrame, geometry: Geometry) {
        if self.gone.contains(&table) {
            return;
        }
        // (R3.13) Where the observers last saw the table, when they have:
        // the engine's description can be older (a drag in progress).
        let geometry = self.followed.get(&table).copied().unwrap_or(geometry);
        if !self.windows.contains_key(&table) {
            let Ok(table_number) = isize::try_from(table.0) else {
                return;
            };
            let at = appkit_frame(
                &geometry.client,
                geometry.scale_permille,
                ffi::main_height(),
            );
            let panel = make_panel(self.mtm, &at, false);
            let view = NSView::initWithFrame(
                NSView::alloc(self.mtm),
                NSRect::new(NSPoint::new(0.0, 0.0), ns_rect(&at).size),
            );
            let layer = CALayer::layer();
            // Layer-hosting (the layer set before `wantsLayer`): AppKit
            // never draws into it; its contents are ours.
            view.setLayer(Some(&layer));
            view.setWantsLayer(true);
            panel.setContentView(Some(&view));
            self.windows.insert(
                table,
                Overlay {
                    table: table_number,
                    panel,
                    layer,
                    hits: Vec::new(),
                    used: 0,
                    geometry,
                    frame: None,
                    dirty: true,
                    painted: None,
                    at: (geometry.client.x, geometry.client.y),
                    placed: at,
                    shown: false,
                    surface: None,
                    scene: Scene::default(),
                    renders: 0,
                    last_render_us: 0,
                    moves: 0,
                    restacked: 0,
                    error: None,
                    drag: None,
                    kept: Vec::new(),
                    drags: 0,
                    clicks: 0,
                },
            );
        }
        if let Some(overlay) = self.windows.get_mut(&table) {
            // Drops the engine has taken in are in the frame now (R3.6).
            let seen = frame.seating.drags_seen;
            overlay.kept.retain(|(seq, _, _)| *seq > seen);
            if overlay.frame.as_ref() != Some(&frame) {
                overlay.frame = Some(frame);
                overlay.dirty = true;
            }
        }
        self.sync(table, geometry);
    }

    /// Bring a table's overlay in line with its frame and the table as it
    /// is ([`tracking::plan`]): paint when the frame, the size or the scale
    /// changed, move when only the position did, order out while the table
    /// is off screen.
    fn sync(&mut self, table: WindowId, g: Geometry) -> Plan {
        let mtm = self.mtm;
        let Some(overlay) = self.windows.get_mut(&table) else {
            return Plan::Keep;
        };
        let placed = Placed {
            shown: overlay.shown,
            at: overlay.at,
            painted: overlay.painted,
        };
        let plan = tracking::plan(&placed, &g, overlay.dirty);
        overlay.geometry = g;
        let main_height = ffi::main_height();
        match plan {
            Plan::Keep => {}
            Plan::Hide => overlay.order_out(),
            Plan::Paint => match paint(&mut self.painter, overlay, main_height) {
                Ok(us) => {
                    overlay.error = None;
                    keep(&mut self.times, us);
                    overlay.order_in();
                    overlay.place_hits(mtm, main_height, true);
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
                let frame = appkit_frame(&g.client, g.scale_permille, main_height);
                overlay.panel.setFrame_display(ns_rect(&frame), false);
                overlay.placed = frame;
                overlay.at = (g.client.x, g.client.y);
                overlay.moves += 1;
                // (R3.13) A move does not change the window order: an
                // overlay already shown is only moved (its click windows
                // too) - during a drag every ordering is a window-server
                // round trip; the stacking look and the observers' restack
                // keep the order.
                let reorder = !overlay.shown;
                if reorder {
                    overlay.order_in();
                }
                overlay.place_hits(mtm, main_height, reorder);
            }
            Plan::Show => {
                overlay.order_in();
                overlay.place_hits(mtm, main_height, true);
            }
        }
        plan
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

    /// How long the pump may wait for an event.
    fn wait(&self, now: Instant) -> Duration {
        if self.windows.values().any(|o| o.shown) {
            self.next_restack
                .saturating_duration_since(now)
                .min(restack_every(self.all_watched()))
        } else {
            IDLE_WAIT
        }
    }

    /// Every `RESTACK_EVERY` while overlays show: put back any overlay
    /// that is no longer directly above its table. Each shown overlay gets
    /// the cheap look ([`Overlay::looks_stacked`]); only when one fails is
    /// the active Space's whole order read (a few ms with a hundred
    /// windows) and [`stacking`] decides - restack, fine after all, or the
    /// table is not on this Space (the engine hides the overlay then).
    fn restack_if_due(&mut self, now: Instant) {
        if now < self.next_restack {
            return;
        }
        self.next_restack = now + restack_every(self.all_watched());
        let main_height = ffi::main_height();
        let mtm = self.mtm;
        let suspects: Vec<WindowId> = self
            .windows
            .iter()
            .filter(|(_, o)| o.shown && !o.looks_stacked(mtm, main_height))
            .map(|(table, _)| *table)
            .collect();
        if suspects.is_empty() {
            return;
        }
        let order: Vec<i64> =
            NSWindow::windowNumbersWithOptions(NSWindowNumberListOptions::AllApplications, mtm)
                .map(|numbers| numbers.iter().map(|n| wide(n.integerValue())).collect())
                .unwrap_or_default();
        for table in suspects {
            let Some(overlay) = self.windows.get_mut(&table) else {
                continue;
            };
            let hits = overlay.shown_hits();
            if stacking(&order, wide(overlay.table), wide(overlay.number()), &hits)
                == Stacking::Restack
            {
                overlay.order_in();
                overlay.restacked += 1;
            }
        }
    }

    /// The table whose overlay has the click window (or is the window)
    /// numbered `number`, and that window's AppKit frame.
    fn window_of(&self, number: isize) -> Option<(WindowId, Frame)> {
        self.windows.iter().find_map(|(table, overlay)| {
            if overlay.number() == number {
                return Some((*table, overlay.placed));
            }
            overlay.hits[..overlay.used]
                .iter()
                .find(|h| h.panel.windowNumber() == number)
                .map(|h| (*table, h.frame))
        })
    }

    /// A mouse event of this process (R3.6, R3.8): a press, move or
    /// release on a panel's click window, taken here; `false` for anything
    /// else (dispatched as usual).
    fn mouse(&mut self, event: &NSEvent) -> bool {
        let kind = event.r#type();
        if kind != NSEventType::LeftMouseDown
            && kind != NSEventType::LeftMouseDragged
            && kind != NSEventType::LeftMouseUp
        {
            return false;
        }
        // The window the event is for (a drag's moves and release go to
        // the window the press went to), else the overlay being dragged
        // and the pointer as it is now.
        let (table, point) = match self.window_of(event.windowNumber()) {
            Some((table, frame)) => {
                let at = event.locationInWindow();
                (table, (frame.x + milli(at.x), frame.y + milli(at.y)))
            }
            None => {
                let dragging = self
                    .windows
                    .iter()
                    .find(|(_, o)| o.drag.is_some())
                    .map(|(t, _)| *t);
                let Some(table) = dragging.filter(|_| kind != NSEventType::LeftMouseDown) else {
                    return false;
                };
                let at = NSEvent::mouseLocation();
                (table, (milli(at.x), milli(at.y)))
            }
        };
        let Some(g) = self.windows.get(&table).map(|o| o.geometry) else {
            return false;
        };
        let (x, y) = client_pixel(point, &g.client, g.scale_permille, ffi::main_height());
        self.pointer(table, kind, x, y);
        true
    }

    /// A press, a move with the button down, a release at client pixel
    /// (`x`, `y`) of `table`'s overlay: the shared drag ([`Drag`]).
    fn pointer(&mut self, table: WindowId, kind: NSEventType, x: i32, y: i32) {
        let dragging = self.windows.get(&table).is_some_and(|o| o.drag.is_some());
        if kind == NSEventType::LeftMouseDown {
            if dragging {
                // A release we never saw: end that drag first.
                self.end_drag(table, false);
            }
            if let Some(overlay) = self.windows.get_mut(&table) {
                overlay.drag = Drag::press(&overlay.scene, x, y);
            }
        } else if kind == NSEventType::LeftMouseDragged {
            let moved = self.windows.get_mut(&table).and_then(|overlay| {
                let g = overlay.geometry;
                let drag = overlay.drag.as_mut()?;
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
        } else if dragging {
            self.end_drag(table, true);
        }
    }

    /// End the drag of `table`'s overlay where the panel is (as on
    /// Windows): kept and told to the engine when it moved somewhere it
    /// may be, back where it was otherwise; a press that never moved is a
    /// click (R3.8) only when its button was `released` here.
    fn end_drag(&mut self, table: WindowId, released: bool) {
        let Some(overlay) = self.windows.get_mut(&table) else {
            return;
        };
        let Some(drag) = overlay.drag.take() else {
            return;
        };
        if drag.is_click() {
            if !released {
                return;
            }
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
        self.repaint(table);
    }

    /// (Tests) A synthetic mouse event on this process's own queue, for
    /// the click window under (`x`, `y`) of `table`'s overlay (a press) or
    /// the one the drag started on (a move, a release): handled by
    /// [`Overlays::mouse`] like a real one when the pump takes it.
    fn inject(&mut self, table: WindowId, mouse: Mouse) -> bool {
        let Some(overlay) = self.windows.get(&table) else {
            return false;
        };
        let (kind, x, y) = match mouse {
            Mouse::Press(x, y) => (NSEventType::LeftMouseDown, x, y),
            Mouse::Move(x, y) => (NSEventType::LeftMouseDragged, x, y),
            Mouse::Release(x, y) => (NSEventType::LeftMouseUp, x, y),
        };
        let hits = &overlay.hits[..overlay.used];
        let hit = match (kind == NSEventType::LeftMouseDown, &overlay.drag) {
            (true, _) => hits.iter().find(|h| crate::layout::contains(&h.rect, x, y)),
            (false, Some(drag)) => hits
                .iter()
                .find(|h| crate::layout::contains(&h.rect, drag.from.0, drag.from.1)),
            (false, None) => hits.first(),
        };
        let Some(hit) = hit.filter(|h| h.shown) else {
            return false;
        };
        let g = overlay.geometry;
        let main_height = ffi::main_height();
        let screen = Rect {
            x: g.client.x.saturating_add(x),
            y: g.client.y.saturating_add(y),
            width: 0,
            height: 0,
        };
        let point = appkit_frame(&screen, g.scale_permille, main_height);
        let location = NSPoint::new(points(point.x - hit.frame.x), points(point.y - hit.frame.y));
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            location,
            NSEventModifierFlags::empty(),
            0.0,
            hit.panel.windowNumber(),
            None,
            0,
            1,
            1.0,
        );
        match event {
            Some(event) => {
                self.app.postEvent_atStart(&event, false);
                true
            }
            None => false,
        }
    }

    #[allow(unsafe_code)]
    fn close_all(&mut self) {
        for (_, overlay) in self.windows.drain() {
            overlay.close();
        }
        if let Some(token) = self.space_observer.take() {
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            let object: &AnyObject = (*token).as_ref();
            // SAFETY: the token `addObserverForName:...` returned, removed
            // once.
            unsafe { center.removeObserver(object) };
        }
    }
}

#[allow(
    clippy::float_arithmetic,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn info(overlay: &Overlay) -> OverlayInfo {
    OverlayInfo {
        window: u32::try_from(overlay.number()).ok(),
        shown: overlay.panel.isVisible(),
        frame: overlay.placed,
        ignores_mouse: overlay.panel.ignoresMouseEvents(),
        hits: overlay.hits[..overlay.used]
            .iter()
            .map(|h| HitInfo {
                window: u32::try_from(h.panel.windowNumber()).unwrap_or(0),
                rect: h.rect,
                frame: h.frame,
                takes_mouse: !h.panel.ignoresMouseEvents(),
                shown: h.panel.isVisible(),
            })
            .collect(),
        // A small positive float (1, 2, 3): rounded to thousandths.
        contents_scale: (overlay.layer.contentsScale() * 1000.0).round() as u32,
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
        seat_cells: overlay.scene.seat_cells.clone(),
        dropped: overlay.scene.dropped.clone(),
        moves: overlay.moves,
        restacked: overlay.restacked,
        error: overlay.error.clone(),
    }
}

/// Lay the frame out, paint it and put it on the layer, the window over
/// the table's client area; the time it took, µs.
#[allow(unsafe_code, clippy::float_arithmetic)]
fn paint(painter: &mut Painter, overlay: &mut Overlay, main_height: i64) -> Result<u64, String> {
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
        // (R3.9) The table's own design travels with its frame.
        &frame.design,
        &overlay.overrides(),
    );
    let fits = overlay
        .surface
        .as_ref()
        .is_some_and(|s| (s.width, s.height) == (g.client.width, g.client.height));
    if !fits {
        overlay.surface = None;
        overlay.surface = Some(Surface::new(g.client.width, g.client.height)?);
    }
    let surface = overlay
        .surface
        .as_ref()
        .ok_or_else(|| "no surface".to_owned())?;
    let image = painter.paint(&scene, surface)?;
    let at = appkit_frame(&g.client, g.scale_permille, main_height);
    let image: &CFType = &image;
    let contents: &AnyObject = image.as_ref();
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    overlay.panel.setFrame_display(ns_rect(&at), false);
    overlay.layer.setFrame(CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(points(at.width), points(at.height)),
    ));
    overlay
        .layer
        .setContentsScale(f64::from(g.scale_permille.max(1)) / 1000.0);
    // SAFETY: a layer's `contents` may be a `CGImage` (its documented
    // type); the layer retains it.
    unsafe { overlay.layer.setContents(Some(contents)) };
    CATransaction::commit();
    overlay.scene = scene;
    overlay.painted = Some(g.size());
    overlay.at = (g.client.x, g.client.y);
    overlay.placed = at;
    overlay.dirty = false;
    overlay.renders += 1;
    let us = micros(started);
    overlay.last_render_us = us;
    Ok(us)
}

/// A table's bitmap: premultiplied BGRA (little-endian ARGB), device RGB,
/// physical pixels, drawn top-down (the context's transform is flipped
/// once, so the scene's y-down coordinates are its own).
struct Surface {
    context: CFRetained<CGContext>,
    width: u32,
    height: u32,
}

impl Surface {
    #[allow(unsafe_code)]
    fn new(width: u32, height: u32) -> Result<Self, String> {
        let (w, h) = (
            usize::try_from(width.max(1)).map_err(|e| e.to_string())?,
            usize::try_from(height.max(1)).map_err(|e| e.to_string())?,
        );
        let space = CGColorSpace::new_device_rgb().ok_or("no device RGB colour space")?;
        let info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
        // SAFETY: a null `data` lets Core Graphics allocate (and own) the
        // pixels; every other argument is a plain value describing them.
        let context =
            unsafe { CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, Some(&space), info) }
                .ok_or_else(|| format!("CGBitmapContextCreate {width} x {height}"))?;
        let ctx = Some(&*context);
        CGContext::translate_ctm(ctx, 0.0, f64::from(height.max(1)));
        CGContext::scale_ctm(ctx, 1.0, -1.0);
        // Text drawn upright in the flipped space.
        CGContext::set_text_matrix(
            ctx,
            CGAffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: -1.0,
                tx: 0.0,
                ty: 0.0,
            },
        );
        CGContext::set_should_antialias(ctx, true);
        // Font smoothing darkens glyphs for an opaque background; on a
        // transparent one it leaves fringes.
        CGContext::set_allows_font_smoothing(ctx, false);
        CGContext::set_should_smooth_fonts(ctx, false);
        Ok(Self {
            context,
            width,
            height,
        })
    }

    /// One pixel as last painted (blue, green, red, alpha, premultiplied);
    /// `(0, 0)` is the client area's top-left.
    #[allow(unsafe_code)]
    fn pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let data = CGBitmapContextGetData(Some(&self.context));
        if data.is_null() {
            return None;
        }
        let row = CGBitmapContextGetBytesPerRow(Some(&self.context));
        let at = usize::try_from(y).ok()? * row + usize::try_from(x).ok()? * 4;
        // SAFETY: the context owns `height` rows of `row` bytes at `data`
        // for as long as it lives (here, borrowed); (x, y) is inside it,
        // so the four bytes at `at` are too. Read only, between paints on
        // this thread.
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>().add(at), 4) };
        Some([bytes[0], bytes[1], bytes[2], bytes[3]])
    }
}

/// Fonts by (pixel size, bold).
#[derive(Default)]
struct Painter {
    fonts: HashMap<(u32, bool), CFRetained<CTFont>>,
}

#[allow(clippy::float_arithmetic)]
fn unit(v: u8) -> CGFloat {
    f64::from(v) / 255.0
}

fn cg_rect(r: &Rect) -> CGRect {
    CGRect::new(
        CGPoint::new(f64::from(r.x), f64::from(r.y)),
        CGSize::new(f64::from(r.width), f64::from(r.height)),
    )
}

impl Painter {
    #[allow(unsafe_code)]
    fn font(&mut self, px: u32, bold: bool) -> Result<CFRetained<CTFont>, String> {
        if let Some(font) = self.fonts.get(&(px, bold)) {
            return Ok(font.clone());
        }
        let kind = if bold {
            CTFontUIFontType::EmphasizedSystem
        } else {
            CTFontUIFontType::System
        };
        // SAFETY: a UI font type and a size; no language (the user's).
        let font = unsafe { CTFont::new_ui_font_for_language(kind, f64::from(px.max(1)), None) }
            .ok_or_else(|| format!("no system font at {px} px"))?;
        self.fonts.insert((px, bold), font.clone());
        Ok(font)
    }

    /// Paint `scene` into `surface` (cleared, then every item back to
    /// front) and take its image.
    #[allow(unsafe_code, clippy::float_arithmetic)]
    fn paint(&mut self, scene: &Scene, surface: &Surface) -> Result<CFRetained<CGImage>, String> {
        let ctx = Some(&*surface.context);
        CGContext::clear_rect(
            ctx,
            cg_rect(&Rect {
                x: 0,
                y: 0,
                width: surface.width,
                height: surface.height,
            }),
        );
        let fill = |c: Rgba| {
            CGContext::set_rgb_fill_color(ctx, unit(c.r), unit(c.g), unit(c.b), unit(c.a))
        };
        for item in &scene.items {
            match item {
                Item::Fill {
                    rect,
                    radius,
                    color,
                } => {
                    if rect.width == 0 || rect.height == 0 {
                        continue;
                    }
                    fill(*color);
                    // Core Graphics refuses a corner wider than half the
                    // rectangle.
                    let r = f64::from((*radius).min(rect.width / 2).min(rect.height / 2));
                    // SAFETY: a null transform is documented as "none".
                    let path =
                        unsafe { CGPath::with_rounded_rect(cg_rect(rect), r, r, std::ptr::null()) };
                    CGContext::add_path(ctx, Some(&path));
                    CGContext::fill_path(ctx);
                }
                Item::Text {
                    rect,
                    text,
                    px,
                    color,
                    bold,
                    ..
                } => {
                    if text.is_empty() {
                        continue;
                    }
                    let font = self.font(*px, *bold)?;
                    // SAFETY: reading Core Text's constant attribute names
                    // (CFStrings alive for the process).
                    let (font_key, colour_key) = unsafe {
                        (
                            kCTFontAttributeName,
                            kCTForegroundColorFromContextAttributeName,
                        )
                    };
                    let yes = CFBoolean::new(true);
                    let font_value: &CFType = &font;
                    let yes_value: &CFType = yes;
                    let attributes = CFDictionary::<CFString, CFType>::from_slices(
                        &[font_key, colour_key],
                        &[font_value, yes_value],
                    );
                    let attributes: &CFDictionary = attributes.as_ref();
                    let string = CFString::from_str(text);
                    // SAFETY: the attributes are the ones Core Text
                    // documents (a CTFont, a CFBoolean), alive for the call.
                    let attributed =
                        unsafe { CFAttributedString::new(None, Some(&string), Some(attributes)) }
                            .ok_or("CFAttributedStringCreate")?;
                    // SAFETY: a valid attributed string, alive for the call.
                    let line = unsafe { CTLine::with_attributed_string(&attributed) };
                    let (mut ascent, mut descent): (CGFloat, CGFloat) = (0.0, 0.0);
                    // SAFETY: two valid out pointers; null for leading
                    // (documented as allowed).
                    let width = unsafe {
                        line.typographic_bounds(
                            &raw mut ascent,
                            &raw mut descent,
                            std::ptr::null_mut(),
                        )
                    };
                    let x = f64::from(rect.x) + (f64::from(rect.width) - width) / 2.0;
                    let baseline =
                        f64::from(rect.y) + f64::from(rect.height) / 2.0 + (ascent - descent) / 2.0;
                    fill(*color);
                    CGContext::save_g_state(ctx);
                    CGContext::clip_to_rect(ctx, cg_rect(rect));
                    CGContext::set_text_position(ctx, x, baseline);
                    // SAFETY: a valid line and context, both alive.
                    unsafe { line.draw(&surface.context) };
                    CGContext::restore_g_state(ctx);
                }
            }
        }
        CGBitmapContextCreateImage(ctx).ok_or_else(|| "CGBitmapContextCreateImage".to_owned())
    }
}

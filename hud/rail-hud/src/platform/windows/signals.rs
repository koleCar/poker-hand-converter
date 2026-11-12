//! (T6 for T7) `--watch-signals` on Windows: what a poker client signals
//! by itself through its windows, read without touching it.
//!
//! - **The shell hook**: a hidden window of ours (never shown) is
//!   registered with `RegisterShellHookWindow`; the shell then sends it the
//!   `SHELLHOOK` message for every top-level window - `HSHELL_FLASH` when a
//!   window flashes its taskbar button (`FlashWindowEx`, what many clients
//!   do on your turn), `HSHELL_WINDOWACTIVATED` / `HSHELL_RUDEAPPACTIVATED`,
//!   `HSHELL_REDRAW` (its taskbar button redrawn: a title or icon change).
//!   Only the watched program's windows are logged.
//! - **WinEvent hooks**, out of context (`WINEVENT_OUTOFCONTEXT`: nothing is
//!   loaded into the client; the events come to this thread's queue): the
//!   foreground window for every process (to see the client take it and
//!   lose it), minimise start and end, and - per watched process, so the
//!   rest of the system's name changes never reach us - a title change.
//! - **The window order**, every [`ORDER_EVERY`] (`EnumWindows` lists top
//!   to bottom): which of the program's windows is in front, and when one
//!   comes to the top of the desktop ([`OrderWatch`]).
//!
//! Everything runs on the calling thread: it pumps messages until the
//! duration is over (the hooks' callbacks run inside that wait), handing
//! each signal to the sink. Callbacks only note; the loop prints. Ctrl+C
//! ends the process, and Windows removes the hooks and the window with it.
//! Each Win32 call is one small function with its own `allow(unsafe_code)`
//! and `// SAFETY:` comment, as in `windows.rs`.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant, SystemTime};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DeregisterShellHookWindow, DestroyWindow, DispatchMessageW,
    GWL_EXSTYLE, GetMessageW, GetWindowLongPtrW, KillTimer, MSG, PostQuitMessage, RegisterClassExW,
    RegisterShellHookWindow, RegisterWindowMessageW, SetTimer, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
};
use windows::core::{PCWSTR, w};

use super::ffi::{
    enumerate, hwnd_of, id_of, is_cloaked, is_iconic, is_top_level, is_topmost, is_visible,
    process_id, top_level_windows, window_text,
};
use crate::platform::matcher::same_process;
use crate::platform::tracking::win_event as e;
use crate::platform::{PlatformError, WindowId};
use crate::signals::{ORDER_EVERY, OrderWatch, Ordered, Signal, SignalEvent, hshell};

/// What the callbacks share with the loop (this thread only).
#[derive(Default)]
struct State {
    /// The watched program's processes.
    pids: BTreeSet<u32>,
    /// The `SHELLHOOK` message's number.
    shell_message: u32,
    /// The foreground window is the program's.
    foreground_ours: bool,
    /// Signals noted by the callbacks, for the loop.
    noted: Vec<(Option<WindowId>, Signal, Instant)>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Note a signal for the loop. Borrowed only here and in the loop, never
/// across a Win32 call; a failed borrow drops the note rather than panic
/// inside a callback.
fn note(window: Option<WindowId>, signal: Signal) {
    STATE.with(|state| {
        if let Ok(mut state) = state.try_borrow_mut() {
            state.noted.push((window, signal, Instant::now()));
        }
    });
}

/// Whether `hwnd` belongs to the watched program.
fn ours(hwnd: HWND) -> bool {
    let pid = process_id(hwnd);
    STATE.with(|state| state.try_borrow().is_ok_and(|s| s.pids.contains(&pid)))
}

/// The WinEvent callback, inside the loop's message wait: filters, notes.
extern "system" fn win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.is_invalid() || object != e::OBJID_WINDOW || child != e::CHILDID_SELF {
        return;
    }
    if event == e::SYSTEM_FOREGROUND {
        let mine = ours(hwnd);
        let was = STATE.with(|state| {
            state
                .try_borrow_mut()
                .map(|mut s| std::mem::replace(&mut s.foreground_ours, mine))
                .unwrap_or(false)
        });
        if mine {
            note(Some(id_of(hwnd)), Signal::Foreground);
        } else if was {
            note(None, Signal::ForegroundElsewhere);
        }
        return;
    }
    if !ours(hwnd) || !is_top_level(hwnd) {
        return;
    }
    let signal = match event {
        e::SYSTEM_MINIMIZESTART => Signal::MinimizeStart,
        e::SYSTEM_MINIMIZEEND => Signal::MinimizeEnd,
        e::OBJECT_NAMECHANGE => Signal::Retitled {
            title: window_text(hwnd),
        },
        _ => return,
    };
    note(Some(id_of(hwnd)), signal);
}

/// The hidden window's procedure: the shell hook's messages, the rest to
/// the default.
#[allow(unsafe_code)]
extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let shell = STATE.with(|state| state.try_borrow().map_or(0, |s| s.shell_message));
    if shell != 0 && message == shell {
        // `lParam` is the window the shell speaks of.
        let window = hwnd_of(WindowId(u64::try_from(lparam.0).unwrap_or(0)));
        if !window.is_invalid() && ours(window) {
            let signal = match u32::try_from(wparam.0).unwrap_or(0) {
                hshell::FLASH => Some(Signal::Flash),
                hshell::WINDOWACTIVATED => Some(Signal::ShellActivated { rude: false }),
                hshell::RUDEAPPACTIVATED => Some(Signal::ShellActivated { rude: true }),
                hshell::REDRAW => Some(Signal::Redraw),
                _ => None,
            };
            if let Some(signal) = signal {
                note(Some(id_of(window)), signal);
            }
        }
        return LRESULT(0);
    }
    // SAFETY: the default handling of this window's own message.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn class_name() -> PCWSTR {
    w!("RailHudSignals")
}

/// The hidden top-level window the shell hook speaks to (a message-only
/// window gets no shell messages). Never shown.
#[allow(unsafe_code)]
fn create_window() -> Result<HWND, PlatformError> {
    // SAFETY: no preconditions; `None` asks for this executable's module.
    let module = unsafe { GetModuleHandleW(None) }
        .map_err(|e| PlatformError::Os(format!("GetModuleHandleW: {e}")))?;
    let class = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(window_proc),
        hInstance: module.into(),
        lpszClassName: class_name(),
        ..Default::default()
    };
    // SAFETY: `class` is fully initialised and its strings are static; a
    // class registered already returns 0, which is fine.
    let _ = unsafe { RegisterClassExW(&class) };
    // SAFETY: the class is registered with a static name; no owner, no
    // menu, nothing passed by pointer.
    unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class_name(),
            w!("Rail HUD signals"),
            WS_OVERLAPPED,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(module.into()),
            None,
        )
    }
    .map_err(|e| PlatformError::Os(format!("CreateWindowExW: {e}")))
}

/// Register `hwnd` for the shell's messages; the `SHELLHOOK` message's
/// number (0: not registered).
#[allow(unsafe_code)]
fn register_shell_hook(hwnd: HWND) -> u32 {
    // SAFETY: a static, NUL-terminated name.
    let message = unsafe { RegisterWindowMessageW(w!("SHELLHOOK")) };
    // SAFETY: a window this thread made; no pointers.
    let registered = unsafe { RegisterShellHookWindow(hwnd) }.as_bool();
    if registered { message } else { 0 }
}

#[allow(unsafe_code)]
fn unregister_shell_hook(hwnd: HWND) {
    // SAFETY: a window this thread made and registered; no pointers.
    let _ = unsafe { DeregisterShellHookWindow(hwnd) };
}

#[allow(unsafe_code)]
fn destroy(hwnd: HWND) {
    // SAFETY: a window this thread made, destroyed once on this thread.
    let _ = unsafe { DestroyWindow(hwnd) };
}

/// One out-of-context hook for `min ..= max` of process `pid` (0: every
/// process); `None` if it could not be set.
#[allow(unsafe_code)]
fn hook(min: u32, max: u32, pid: u32) -> Option<HWINEVENTHOOK> {
    // SAFETY: `win_event` is a plain function that lives as long as the
    // program and touches only this thread's state; out of context nothing
    // is loaded into another process and Windows calls it on this thread,
    // which pumps messages; undone with `UnhookWinEvent` on this thread.
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
}

#[allow(unsafe_code)]
fn unhook(hook: HWINEVENTHOOK) {
    // SAFETY: a hook this thread set and has not undone, undone once.
    let _ = unsafe { UnhookWinEvent(hook) };
}

/// A window timer every [`ORDER_EVERY`] on `hwnd`.
#[allow(unsafe_code)]
fn start_timer(hwnd: HWND) -> bool {
    let ms = u32::try_from(ORDER_EVERY.as_millis()).unwrap_or(100);
    // SAFETY: a window of this thread, no callback: `WM_TIMER` is posted.
    (unsafe { SetTimer(Some(hwnd), 1, ms, None) }) != 0
}

#[allow(unsafe_code)]
fn stop_timer(hwnd: HWND) {
    // SAFETY: the timer this thread started on its own window.
    let _ = unsafe { KillTimer(Some(hwnd), 1) };
}

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

#[allow(unsafe_code)]
fn quit() {
    // SAFETY: no preconditions.
    unsafe { PostQuitMessage(0) };
}

/// A tool window (no taskbar button: a tooltip, an overlay), which is not
/// what "the top of the desktop" means.
#[allow(unsafe_code)]
fn is_tool_window(hwnd: HWND) -> bool {
    // SAFETY: reads a window long; a stale handle gives 0.
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    style & isize::try_from(WS_EX_TOOLWINDOW.0).unwrap_or(0) != 0
}

/// The watched program's processes and its windows' titles now.
fn programs(processes: &[String]) -> (BTreeSet<u32>, BTreeMap<WindowId, String>) {
    let windows = enumerate().unwrap_or_default();
    let mine: Vec<_> = windows
        .into_iter()
        .filter(|w| processes.iter().any(|p| same_process(p, &w.process)))
        .collect();
    (
        mine.iter().map(|w| w.pid).collect(),
        mine.into_iter().map(|w| (w.id, w.title)).collect(),
    )
}

/// The ordinary top-level windows, front to back: visible, on this
/// desktop, not topmost, not tool windows (the program's own always).
fn order(pids: &BTreeSet<u32>) -> Vec<Ordered> {
    top_level_windows()
        .unwrap_or_default()
        .into_iter()
        .filter(|h| is_visible(*h) && !is_cloaked(*h) && !is_topmost(*h))
        .filter_map(|h| {
            let client = pids.contains(&process_id(h));
            (client || !is_tool_window(h)).then(|| Ordered {
                id: id_of(h),
                client,
                shown: !is_iconic(h),
            })
        })
        .collect()
}

/// Watch `processes` for `duration` (the module's note).
pub(super) fn watch(
    processes: &[String],
    duration: Duration,
    sink: &mut dyn FnMut(SignalEvent),
) -> Result<(), PlatformError> {
    let started = Instant::now();
    let wall = SystemTime::now();
    let at = |instant: Instant| {
        let since = instant.saturating_duration_since(started);
        (since, wall.checked_add(since).unwrap_or(wall))
    };
    let (pids, mut titles) = programs(processes);
    for (id, title) in &titles {
        let (since_start, wall) = at(Instant::now());
        sink(SignalEvent {
            since_start,
            wall,
            window: Some(*id),
            signal: Signal::Present {
                title: title.clone(),
            },
        });
    }
    let hwnd = create_window()?;
    let shell_message = register_shell_hook(hwnd);
    STATE.with(|state| {
        if let Ok(mut state) = state.try_borrow_mut() {
            *state = State {
                pids: pids.clone(),
                shell_message,
                ..State::default()
            };
        }
    });
    if shell_message == 0 {
        eprintln!("Note: the shell hook could not be registered: no FLASH will be seen.");
    }
    let mut global: Vec<HWINEVENTHOOK> = [
        (e::SYSTEM_FOREGROUND, e::SYSTEM_FOREGROUND),
        (e::SYSTEM_MINIMIZESTART, e::SYSTEM_MINIMIZEEND),
    ]
    .into_iter()
    .filter_map(|(min, max)| hook(min, max, 0))
    .collect();
    let mut titled: BTreeMap<u32, HWINEVENTHOOK> = BTreeMap::new();
    let mut pids_now = pids;
    let mut watch = OrderWatch::default();
    let mut ticks = 0u64;
    if !start_timer(hwnd) {
        eprintln!("Note: no timer: the window order is not watched.");
    }
    while let Some(message) = next_message() {
        if message.message == WM_TIMER && message.hwnd == hwnd {
            ticks += 1;
            if ticks % 10 == 1 {
                let (pids, now) = programs(processes);
                titles.extend(now);
                let new: Vec<u32> = pids
                    .iter()
                    .filter(|p| !titled.contains_key(p))
                    .copied()
                    .collect();
                for pid in new {
                    if let Some(h) = hook(e::OBJECT_NAMECHANGE, e::OBJECT_NAMECHANGE, pid) {
                        titled.insert(pid, h);
                    }
                }
                let gone: Vec<u32> = titled
                    .keys()
                    .filter(|p| !pids.contains(p))
                    .copied()
                    .collect();
                for pid in gone {
                    if let Some(h) = titled.remove(&pid) {
                        unhook(h);
                    }
                }
                STATE.with(|state| {
                    if let Ok(mut state) = state.try_borrow_mut() {
                        state.pids = pids.clone();
                    }
                });
                pids_now = pids;
            }
            for (id, signal) in watch.look(&order(&pids_now), false) {
                let signal = match signal {
                    Signal::Appeared { .. } => Signal::Appeared {
                        title: titles.get(&id).cloned().unwrap_or_default(),
                    },
                    other => other,
                };
                note(Some(id), signal);
            }
            if started.elapsed() >= duration {
                quit();
            }
        } else {
            dispatch(&message);
        }
        let noted = STATE.with(|state| {
            state
                .try_borrow_mut()
                .map(|mut s| std::mem::take(&mut s.noted))
                .unwrap_or_default()
        });
        for (window, signal, instant) in noted {
            let (since_start, wall) = at(instant);
            sink(SignalEvent {
                since_start,
                wall,
                window,
                signal,
            });
        }
    }
    stop_timer(hwnd);
    for h in global.drain(..).chain(titled.into_values()) {
        unhook(h);
    }
    unregister_shell_hook(hwnd);
    destroy(hwnd);
    Ok(())
}

/// The shell hook's codes are the system's.
#[cfg(test)]
mod tests {
    use windows::Win32::UI::WindowsAndMessaging as w;

    use crate::signals::hshell;

    #[test]
    fn shell_hook_numbers() {
        // `HSHELL_FLASH` and `HSHELL_RUDEAPPACTIVATED` are C macros over
        // these (`winuser.h`), not in the crate.
        assert_eq!(hshell::FLASH, w::HSHELL_REDRAW | w::HSHELL_HIGHBIT);
        assert_eq!(
            hshell::RUDEAPPACTIVATED,
            w::HSHELL_WINDOWACTIVATED | w::HSHELL_HIGHBIT
        );
        assert_eq!(hshell::WINDOWACTIVATED, w::HSHELL_WINDOWACTIVATED);
        assert_eq!(hshell::WINDOWCREATED, w::HSHELL_WINDOWCREATED);
        assert_eq!(hshell::WINDOWDESTROYED, w::HSHELL_WINDOWDESTROYED);
        assert_eq!(hshell::REDRAW, w::HSHELL_REDRAW);
        assert_eq!(hshell::HIGHBIT, w::HSHELL_HIGHBIT);
    }
}

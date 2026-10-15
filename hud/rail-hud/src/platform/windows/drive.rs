//! Test drivers for the Windows tracking tests (R3.5): move, hide, show
//! and raise **another process's** window the way a poker client (or the
//! user) would, so that the hooks see it. Only the tests call these (the
//! table simulator's windows); the HUD never moves, hides or raises a
//! table. Each call switches its thread to per-monitor DPI awareness (v2),
//! so positions are physical pixels.

use windows::Win32::UI::WindowsAndMessaging::{
    HWND_TOP, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SetWindowPos, ShowWindow,
};

use super::super::WindowId;
use super::ffi::{ThreadDpi, hwnd_of};

/// Move window `id`'s frame to screen point (`x`, `y`), size and z-order
/// kept, not activated. Returns once the window's thread has handled it
/// (`SetWindowPos` waits for another thread's window).
#[allow(unsafe_code)]
pub fn move_window(id: WindowId, x: i32, y: i32) -> Result<(), String> {
    let _dpi = ThreadDpi::per_monitor_v2();
    // SAFETY: no pointers; a stale handle is an `Err`.
    unsafe {
        SetWindowPos(
            hwnd_of(id),
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

/// Hide window `id` (`SW_HIDE`) or show it again without activating it.
#[allow(unsafe_code)]
pub fn show_window(id: WindowId, visible: bool) {
    // SAFETY: no pointers; a stale handle does nothing.
    let _ = unsafe {
        ShowWindow(
            hwnd_of(id),
            if visible { SW_SHOWNOACTIVATE } else { SW_HIDE },
        )
    };
}

/// Put window `id` on top of the (non-topmost) z-order without activating
/// it.
#[allow(unsafe_code)]
pub fn raise(id: WindowId) -> Result<(), String> {
    // SAFETY: no pointers; a stale handle is an `Err`.
    unsafe {
        SetWindowPos(
            hwnd_of(id),
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    }
    .map_err(|e| format!("SetWindowPos: {e}"))
}

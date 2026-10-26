//! Test drivers for the Windows tracking tests (R3.5): move, hide, show
//! and raise **another process's** window the way a poker client (or the
//! user) would, so that the hooks see it - and (R3.6) drag a panel of an
//! overlay the way the user would, with the mouse messages the system
//! queues for it. Only the tests call these (the table simulator's windows,
//! the HUD's overlays); the HUD never moves, hides or raises a table.
//! Moving a window switches its thread to per-monitor DPI awareness (v2),
//! so positions are physical pixels.

use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    HWND_TOP, PostMessageW, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SetWindowPos, ShowWindow, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
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

/// The mouse messages of a drag (R3.6): button down at `from`, moves to
/// `to` in `steps` (button held), button up there - posted to window `id`
/// (an overlay, possibly of another process), client coordinates, as the
/// system queues a real drag's. Returns once posted (not handled).
pub fn drag(id: WindowId, from: (i32, i32), to: (i32, i32), steps: i32) -> Result<(), String> {
    const LEFT: usize = 0x0001; // MK_LBUTTON
    post_mouse(id, WM_LBUTTONDOWN, LEFT, from)?;
    let steps = steps.max(1);
    for step in 1..=steps {
        let at = (
            from.0 + (to.0 - from.0) * step / steps,
            from.1 + (to.1 - from.1) * step / steps,
        );
        post_mouse(id, WM_MOUSEMOVE, LEFT, at)?;
    }
    post_mouse(id, WM_LBUTTONUP, 0, to)
}

/// Post one mouse message with the point packed as Windows does (two
/// signed 16-bit halves).
#[allow(unsafe_code)]
fn post_mouse(id: WindowId, message: u32, keys: usize, (x, y): (i32, i32)) -> Result<(), String> {
    let low = u32::from(u16::from_ne_bytes(
        i16::try_from(x).unwrap_or(0).to_ne_bytes(),
    ));
    let high = u32::from(u16::from_ne_bytes(
        i16::try_from(y).unwrap_or(0).to_ne_bytes(),
    ));
    let packed = isize::try_from(low | (high << 16)).unwrap_or(0);
    // SAFETY: no pointers - the point is packed into `lparam`; a stale
    // handle is an `Err`.
    unsafe { PostMessageW(Some(hwnd_of(id)), message, WPARAM(keys), LPARAM(packed)) }
        .map_err(|e| format!("PostMessageW: {e}"))
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

/// Put window `id` directly below window `after` in the z-order without
/// activating it (R3.5: something slipped in between an overlay and its
/// table with no event about the table).
#[allow(unsafe_code)]
pub fn place_below(id: WindowId, after: WindowId) -> Result<(), String> {
    // SAFETY: no pointers; a stale handle is an `Err`.
    unsafe {
        SetWindowPos(
            hwnd_of(id),
            Some(hwnd_of(after)),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    }
    .map_err(|e| format!("SetWindowPos: {e}"))
}

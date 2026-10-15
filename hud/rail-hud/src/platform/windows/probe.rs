//! Read-only looks at windows and processes, for the Windows tests and
//! diagnostics (R3.4): an overlay's owner, styles, rectangle and
//! visibility; which window a screen point hits; a screen pixel as
//! composed (layered windows included); a process's top-level windows and
//! its CPU time. Each call switches its thread to per-monitor DPI
//! awareness (v2) for itself, so every coordinate is physical pixels.

use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GA_ROOT, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetWindow, GetWindowLongPtrW,
    GetWindowRect, IsWindowVisible, WindowFromPoint,
};
use windows::core::BOOL;

use super::super::{Rect, WindowId};
use super::ffi::{ThreadDpi, class_name, hwnd_of, id_of, process_id};

/// The window that owns `id` (`GetWindow(GW_OWNER)`).
#[allow(unsafe_code)]
pub fn owner(id: WindowId) -> Option<WindowId> {
    // SAFETY: reads a relation; a stale handle or no owner is an `Err`.
    let owner = unsafe { GetWindow(hwnd_of(id), GW_OWNER) }.ok()?;
    (!owner.is_invalid()).then(|| id_of(owner))
}

/// Its extended styles (`GWL_EXSTYLE`; `super::ex_style` names the bits).
#[allow(unsafe_code)]
pub fn ex_style(id: WindowId) -> u32 {
    // SAFETY: reads a window long; a stale handle gives 0.
    let style = unsafe { GetWindowLongPtrW(hwnd_of(id), GWL_EXSTYLE) };
    u32::try_from(style & 0xffff_ffff).unwrap_or(0)
}

/// Its rectangle on screen, physical pixels (for a popup without a frame,
/// its client area).
#[allow(unsafe_code)]
pub fn window_rect(id: WindowId) -> Option<Rect> {
    let _dpi = ThreadDpi::per_monitor_v2();
    let mut r = RECT::default();
    // SAFETY: `r` is a valid out pointer; a stale handle is an `Err`.
    unsafe { GetWindowRect(hwnd_of(id), &mut r) }.ok()?;
    Some(Rect {
        x: r.left,
        y: r.top,
        width: u32::try_from(r.right.saturating_sub(r.left)).unwrap_or(0),
        height: u32::try_from(r.bottom.saturating_sub(r.top)).unwrap_or(0),
    })
}

/// Whether it is showing (`IsWindowVisible`).
#[allow(unsafe_code)]
pub fn visible(id: WindowId) -> bool {
    // SAFETY: reads a flag; a stale handle reads as not visible.
    unsafe { IsWindowVisible(hwnd_of(id)) }.as_bool()
}

/// The top-level window a click at screen point (`x`, `y`) would reach
/// (`WindowFromPoint`, then its root): a layered window's transparent
/// pixels and `HTTRANSPARENT` areas are passed through as for a click.
#[allow(unsafe_code)]
pub fn window_at(x: i32, y: i32) -> Option<WindowId> {
    let _dpi = ThreadDpi::per_monitor_v2();
    // SAFETY: no pointers; returns a handle or null.
    let hit = unsafe { WindowFromPoint(POINT { x, y }) };
    if hit.is_invalid() {
        return None;
    }
    // SAFETY: no pointers; a stale handle gives null.
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    Some(id_of(if root.is_invalid() { hit } else { root }))
}

/// The screen's pixel at (`x`, `y`) as composed - layered windows included
/// (`BitBlt` with `CAPTUREBLT`): red, green, blue.
#[allow(unsafe_code)]
pub fn screen_pixel(x: i32, y: i32) -> Option<[u8; 3]> {
    let _dpi = ThreadDpi::per_monitor_v2();
    // SAFETY: the screen's DC, released below.
    let screen = unsafe { GetDC(None) };
    if screen.is_invalid() {
        return None;
    }
    // SAFETY: no preconditions.
    let dc = unsafe { CreateCompatibleDC(Some(screen)) };
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
            biWidth: 1,
            biHeight: -1,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: a 1 x 1 32-bit DIB; `bits` receives its pixel's address.
    let bitmap = unsafe { CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) };
    let mut out = None;
    if let Ok(bitmap) = bitmap
        && !bits.is_null()
    {
        // SAFETY: the bitmap made above into the DC made above, put back
        // before both are deleted.
        let previous = unsafe { SelectObject(dc, bitmap.into()) };
        // SAFETY: copies one pixel between two live DCs.
        let copied = unsafe { BitBlt(dc, 0, 0, 1, 1, Some(screen), x, y, SRCCOPY | CAPTUREBLT) };
        if copied.is_ok() {
            // SAFETY: flushes GDI's batch so the pixel is written.
            let _ = unsafe { GdiFlush() };
            // SAFETY: `bits` points at the DIB's 4 bytes, alive until the
            // bitmap is deleted below.
            let px = unsafe { std::slice::from_raw_parts(bits.cast::<u8>(), 4) };
            out = Some([px[2], px[1], px[0]]);
        }
        // SAFETY: restores and deletes what was made above, once each.
        unsafe {
            SelectObject(dc, previous);
            let _ = DeleteObject(bitmap.into());
        }
    }
    // SAFETY: the DCs made / got above, each released once.
    unsafe {
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
    }
    out
}

/// `EnumWindows`' callback for [`windows_of`]: every top-level handle.
#[allow(unsafe_code)]
extern "system" fn collect_all(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let handles = std::ptr::with_exposed_provenance_mut::<Vec<HWND>>(lparam.0.cast_unsigned());
    // SAFETY: `windows_of` passes the address of a live `Vec<HWND>` it
    // owns exclusively until `EnumWindows` returns; the callback runs
    // synchronously on the same thread.
    unsafe { (*handles).push(hwnd) };
    BOOL(1)
}

/// Every top-level window of process `pid`, shown or not, with its class.
#[allow(unsafe_code)]
pub fn windows_of(pid: u32) -> Vec<(WindowId, String)> {
    let mut handles: Vec<HWND> = Vec::new();
    let lparam = LPARAM(
        std::ptr::from_mut(&mut handles)
            .expose_provenance()
            .cast_signed(),
    );
    // SAFETY: `collect_all` only pushes into `handles`, which outlives the
    // call.
    if unsafe { EnumWindows(Some(collect_all), lparam) }.is_err() {
        return Vec::new();
    }
    handles
        .into_iter()
        .filter(|&hwnd| process_id(hwnd) == pid)
        .map(|hwnd| (id_of(hwnd), class_name(hwnd)))
        .collect()
}

/// The CPU time (kernel + user) process `pid` has used so far.
#[allow(unsafe_code)]
pub fn cpu_time(pid: u32) -> Option<Duration> {
    // SAFETY: no memory preconditions; failure is an `Err`.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: four valid out pointers and the live handle opened above.
    let read =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    // SAFETY: closes the handle opened above, once.
    let _ = unsafe { CloseHandle(handle) };
    read.ok()?;
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    // FILETIME counts 100 ns.
    Some(Duration::from_nanos(
        (ticks(kernel) + ticks(user)).saturating_mul(100),
    ))
}

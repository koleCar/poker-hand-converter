//! The macOS calls (R3.11): Core Graphics' window list and displays, the
//! Accessibility API's windows, `proc_pidpath`. Each function is one
//! concern and allows `unsafe` for itself only, with a `// SAFETY:` comment
//! per block. What they return is plain Rust ([`super::CgWindow`],
//! [`super::AxWindow`], [`super::Display`]); everything that decides is in
//! the platform-free half (`super`), which the unit tests drive on every
//! system.
//!
//! Nothing here keeps a system object past the call: Core Foundation
//! objects are `CFRetained` (released on drop), and a window or an
//! accessibility element that vanished mid-walk only makes its call fail,
//! which drops that window or that detail. Nothing here reads pixels
//! (Screen Recording) or input (Input Monitoring), and nothing changes a
//! setting: [`prompt`] asks the system to show its own prompt, and is
//! called only on the user's click in the app.

use std::ffi::{CStr, c_void};
use std::ptr::NonNull;

use objc2_application_services::{
    AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType,
    kAXTrustedCheckOptionPrompt,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGSize,
};
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGError,
    CGGetActiveDisplayList, CGMainDisplayID, CGPreflightScreenCaptureAccess,
    CGWindowListCopyWindowInfo, CGWindowListOption, kCGNullWindowID, kCGWindowBounds,
    kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
};

use super::{AxWindow, CgWindow, Display, Frame, milli};
use crate::platform::PlatformError;

/// How long one accessibility request to a poker client may take: the
/// call is answered by the client's main thread, and a busy or hung client
/// must not stall the HUD's loop (the system's default is 6 s).
const AX_TIMEOUT_S: f32 = 0.25;

/// Whether this process may use the Accessibility API: the TCC entry of
/// its *responsible* process (the app bundle that started it - Rail.app for
/// the sidecar; the terminal for a command run from one). Reading it
/// prompts nobody and changes nothing.
#[allow(unsafe_code)]
pub(super) fn trusted() -> bool {
    // SAFETY: no arguments, no memory preconditions; it asks the TCC
    // daemon and returns a flag.
    unsafe { AXIsProcessTrusted() }
}

/// The system's own Accessibility prompt ("Rail would like to control this
/// computer using accessibility features"), which also lists the app in
/// System Settings, Privacy & Security, Accessibility - switched off until
/// the user switches it on. Called only when the user clicked for it.
#[allow(unsafe_code)]
pub(super) fn prompt() -> bool {
    // SAFETY: reading an `extern static` the framework defines (a
    // constant CFString, alive for the process).
    let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
    let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
    let options: &CFDictionary = options.as_ref();
    // SAFETY: the dictionary is the one the function documents: CFString
    // keys (`kAXTrustedCheckOptionPrompt`) with a CFBoolean value; it is
    // alive for the call.
    unsafe { AXIsProcessTrustedWithOptions(Some(options)) }
}

/// Whether Screen Recording is granted (shown by `--list-windows` only,
/// to say that it is not needed). Reading it prompts nobody.
pub(super) fn screen_recording_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// The window server's keys of a window's description.
struct Keys {
    number: &'static CFString,
    pid: &'static CFString,
    owner: &'static CFString,
    bounds: &'static CFString,
    layer: &'static CFString,
    onscreen: &'static CFString,
}

#[allow(unsafe_code)]
fn keys() -> Keys {
    // SAFETY: reading `extern static`s Core Graphics defines: constant
    // CFStrings, alive for the process, never written.
    unsafe {
        Keys {
            number: kCGWindowNumber,
            pid: kCGWindowOwnerPID,
            owner: kCGWindowOwnerName,
            bounds: kCGWindowBounds,
            layer: kCGWindowLayer,
            onscreen: kCGWindowIsOnscreen,
        }
    }
}

/// Every window the window server knows, front to back: on screen or not
/// (minimised, on another Space, an app hidden). Bounds, owner and layer
/// only - the window *names* in this list need Screen Recording since
/// macOS 10.15 and are never read.
#[allow(unsafe_code)]
pub(super) fn cg_windows() -> Result<Vec<CgWindow>, PlatformError> {
    let list = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionAll | CGWindowListOption::ExcludeDesktopElements,
        kCGNullWindowID,
    )
    .ok_or_else(|| PlatformError::Os("CGWindowListCopyWindowInfo gave nothing".to_owned()))?;
    // SAFETY: `CGWindowListCopyWindowInfo` documents its result as an
    // array of dictionaries whose keys are CFStrings (the `kCGWindow*`
    // constants); the values are read as `CFType` and checked with
    // `downcast_ref` before use.
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> =
        unsafe { CFRetained::cast_unchecked(list) };
    let keys = keys();
    let mut out = Vec::with_capacity(list.len());
    for index in 0..list.len() {
        let Some(info) = list.get(index) else {
            continue;
        };
        let number = |key: &CFString| {
            info.get(key)
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_i64))
        };
        let (Some(id), Some(pid)) = (number(keys.number), number(keys.pid)) else {
            continue;
        };
        let (Ok(id), Ok(pid)) = (u32::try_from(id), u32::try_from(pid)) else {
            continue;
        };
        let owner = info
            .get(keys.owner)
            .and_then(|v| v.downcast_ref::<CFString>().map(ToString::to_string))
            .unwrap_or_default();
        let onscreen = info
            .get(keys.onscreen)
            .and_then(|v| v.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool))
            .unwrap_or(false);
        let bounds = info
            .get(keys.bounds)
            .and_then(|v| v.downcast_ref::<CFDictionary>().map(bounds_of))
            .unwrap_or_default();
        out.push(CgWindow {
            id,
            pid,
            owner,
            bounds,
            layer: number(keys.layer).unwrap_or(0),
            onscreen,
        });
    }
    Ok(out)
}

/// (R3.12) The window numbers on screen, **front to back**
/// (`OptionOnScreenOnly`: only that option orders the list by z-order -
/// `OptionAll` interleaves off-screen windows and does not keep the on-screen
/// ones in z-order, as the overlay test found). Numbers only: no name, no
/// permission.
#[allow(unsafe_code)]
pub(super) fn onscreen_order() -> Result<Vec<u32>, PlatformError> {
    let list = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        kCGNullWindowID,
    )
    .ok_or_else(|| PlatformError::Os("CGWindowListCopyWindowInfo gave nothing".to_owned()))?;
    // SAFETY: as in `cg_windows`: an array of dictionaries with CFString
    // keys; values checked with `downcast_ref`.
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> =
        unsafe { CFRetained::cast_unchecked(list) };
    let keys = keys();
    Ok((0..list.len())
        .filter_map(|index| {
            let info = list.get(index)?;
            let id = info
                .get(keys.number)
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_i64))?;
            u32::try_from(id).ok()
        })
        .collect())
}

/// A `kCGWindowBounds` dictionary (`X`, `Y`, `Width`, `Height` in points,
/// the main display's top-left the origin) as a [`Frame`].
#[allow(unsafe_code)]
fn bounds_of(dictionary: &CFDictionary) -> Frame {
    // SAFETY: the window server's bounds dictionary has CFString keys and
    // CFNumber values (`CGRectCreateDictionaryRepresentation`); the values
    // are checked with `downcast_ref` all the same.
    let dictionary: &CFDictionary<CFString, CFType> = unsafe { dictionary.cast_unchecked() };
    let value = |name: &'static str| {
        dictionary
            .get(&CFString::from_static_str(name))
            .and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_f64))
            .map_or(0, milli)
    };
    Frame {
        x: value("X"),
        y: value("Y"),
        width: value("Width"),
        height: value("Height"),
    }
}

/// The executable's file name (`PokerStars`, `rail-hud-sim`), `None` when
/// the process is gone or not ours to ask.
#[allow(unsafe_code)]
pub(super) fn process_name(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut buf = vec![0u8; usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).ok()?];
    let size = u32::try_from(buf.len()).ok()?;
    // SAFETY: `buf` is writable for `size` bytes; the call writes at most
    // that many (a NUL-terminated path) and returns how many, or <= 0.
    let written = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast::<c_void>(), size) };
    let written = usize::try_from(written).ok().filter(|&n| n > 0)?;
    let path = String::from_utf8_lossy(&buf[..written.min(buf.len())]).into_owned();
    let name = path.rsplit('/').next().unwrap_or(&path);
    (!name.is_empty()).then(|| name.to_owned())
}

/// The displays, the main one first: bounds in points (global, top-left
/// origin) and the backing scale (pixels per point of the display's mode).
#[allow(unsafe_code)]
pub(super) fn displays() -> Vec<Display> {
    let mut ids: [CGDirectDisplayID; 32] = [0; 32];
    let mut count = 0u32;
    let max = u32::try_from(ids.len()).unwrap_or(0);
    // SAFETY: `ids` is writable for `max` display ids and `count` is a
    // valid out pointer; the call writes at most `max` ids.
    let error = unsafe { CGGetActiveDisplayList(max, ids.as_mut_ptr(), &raw mut count) };
    let count = if error == CGError::Success {
        usize::try_from(count).unwrap_or(0).min(ids.len())
    } else {
        0
    };
    let main = CGMainDisplayID();
    let mut list: Vec<CGDirectDisplayID> = ids[..count].to_vec();
    list.sort_by_key(|id| *id != main);
    list.into_iter()
        .map(|id| {
            let rect = CGDisplayBounds(id);
            let mode = CGDisplayCopyDisplayMode(id);
            let mode = mode.as_deref();
            Display {
                bounds: Frame {
                    x: milli(rect.origin.x),
                    y: milli(rect.origin.y),
                    width: milli(rect.size.width),
                    height: milli(rect.size.height),
                },
                scale_permille: super::scale_permille(
                    CGDisplayMode::pixel_width(mode),
                    CGDisplayMode::width(mode),
                ),
            }
        })
        .collect()
}

/// (R3.12) The main display's height, thousandths of a point: what flips
/// the window server's top-left space into AppKit's bottom-left one (the
/// main display's top-left is the origin of the first, its bottom-left the
/// origin of the second). Read at each use: displays come and go.
pub(super) fn main_height() -> i64 {
    milli(CGDisplayBounds(CGMainDisplayID()).size.height)
}

/// `AXUIElementCopyAttributeValue`: the attribute's value, `None` when the
/// element has none, refused, or timed out.
#[allow(unsafe_code)]
fn attribute(element: &AXUIElement, name: &'static str) -> Option<CFRetained<CFType>> {
    let name = CFString::from_static_str(name);
    let mut value: *const CFType = std::ptr::null();
    // SAFETY: `value` is a valid out pointer for the call; on success it
    // holds a +1 reference (the "Copy" rule) or stays null.
    let error = unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) };
    if error != AXError::Success {
        return None;
    }
    let value = NonNull::new(value.cast_mut())?;
    // SAFETY: a non-null result of a Copy function: we own its one
    // reference, released when the `CFRetained` drops.
    Some(unsafe { CFRetained::from_raw(value) })
}

/// An `AXValue` attribute holding a `CGPoint` or a `CGSize`.
#[allow(unsafe_code)]
fn point_of(element: &AXUIElement, name: &'static str) -> Option<CGPoint> {
    let value = attribute(element, name)?;
    let value = value.downcast_ref::<AXValue>()?;
    let mut point = CGPoint::default();
    // SAFETY: `point` is a `CGPoint`, which is what `AXValueType::CGPoint`
    // writes; the call checks the value's own type and fails (false) on
    // any other.
    let read = unsafe { value.value(AXValueType::CGPoint, NonNull::from(&mut point).cast()) };
    read.then_some(point)
}

#[allow(unsafe_code)]
fn size_of(element: &AXUIElement, name: &'static str) -> Option<CGSize> {
    let value = attribute(element, name)?;
    let value = value.downcast_ref::<AXValue>()?;
    let mut size = CGSize::default();
    // SAFETY: as in `point_of`, for a `CGSize` and `AXValueType::CGSize`.
    let read = unsafe { value.value(AXValueType::CGSize, NonNull::from(&mut size).cast()) };
    read.then_some(size)
}

/// An element's frame (`AXPosition` + `AXSize`), points.
fn frame_of(element: &AXUIElement) -> Option<Frame> {
    let origin = point_of(element, "AXPosition")?;
    let size = size_of(element, "AXSize")?;
    Some(Frame {
        x: milli(origin.x),
        y: milli(origin.y),
        width: milli(size.width),
        height: milli(size.height),
    })
}

fn string_of(element: &AXUIElement, name: &'static str) -> Option<String> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFString>().map(ToString::to_string)
}

fn bool_of(element: &AXUIElement, name: &'static str) -> Option<bool> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool)
}

/// `_AXUIElementGetWindow`, looked up once at run time: the
/// `CGWindowID` of an accessibility window. Private to the
/// ApplicationServices framework (and used by the macOS window managers
/// and switchers for exactly this), so it is never linked against: when a
/// macOS release drops it, the lookup fails and the windows are paired by
/// their frames alone ([`super::pair`]).
type GetWindow = unsafe extern "C" fn(*const AXUIElement, *mut u32) -> i32;

#[allow(unsafe_code)]
fn get_window_fn() -> Option<GetWindow> {
    static FOUND: std::sync::OnceLock<Option<usize>> = std::sync::OnceLock::new();
    let found: Option<usize> = *FOUND.get_or_init(|| {
        const NAME: &CStr = c"_AXUIElementGetWindow";
        // SAFETY: `dlsym` with `RTLD_DEFAULT` and a NUL-terminated name
        // only looks a symbol up in the loaded images (ApplicationServices
        // is linked); it returns null when there is none.
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr()) };
        (!symbol.is_null()).then(|| symbol.expose_provenance())
    });
    let address = found?;
    // SAFETY: a non-null address of the function named above, whose C
    // signature is `AXError (AXUIElementRef, CGWindowID *)` on every macOS
    // release that has it; `GetWindow` is that signature.
    Some(unsafe {
        std::mem::transmute::<*const c_void, GetWindow>(std::ptr::with_exposed_provenance(address))
    })
}

#[allow(unsafe_code)]
fn window_id_of(element: &AXUIElement) -> Option<u32> {
    let get = get_window_fn()?;
    let mut id = 0u32;
    // SAFETY: `element` is a live accessibility element for the call and
    // `id` a valid out pointer for one `CGWindowID`.
    let error = unsafe { get(std::ptr::from_ref(element), &raw mut id) };
    (error == AXError::Success.0 && id != 0).then_some(id)
}

/// The windows the Accessibility API lists for process `pid`, in its order
/// (front to back): title, frame, minimised, full screen, subrole, the
/// close button's frame (the title bar), and the `CGWindowID` where the
/// system says it. Only windows of the current Space and minimised ones
/// are listed - a window on another Space is the window server's alone.
/// `Err` when the process cannot be asked (not trusted, no such app, it
/// did not answer in time).
#[allow(unsafe_code)]
pub(super) fn ax_windows(pid: u32) -> Result<Vec<AxWindow>, String> {
    let pid = libc::pid_t::try_from(pid).map_err(|e| e.to_string())?;
    // SAFETY: creating an application element has no memory preconditions;
    // a pid that is no app gives an element whose calls fail.
    let app = unsafe { AXUIElement::new_application(pid) };
    // SAFETY: sets the timeout on our own element object; no pointers.
    let _ = unsafe { app.set_messaging_timeout(AX_TIMEOUT_S) };
    let windows = attribute(&app, "AXWindows").ok_or("no AXWindows (refused or timed out)")?;
    let windows = windows
        .downcast_ref::<CFArray>()
        .ok_or("AXWindows is not an array")?;
    // SAFETY: `AXWindows` is documented as an array of `AXUIElement`s;
    // each is checked with `downcast_ref` before use all the same.
    let windows: &CFArray<CFType> = unsafe { windows.cast_unchecked() };
    let mut out = Vec::with_capacity(windows.len());
    for index in 0..windows.len() {
        let Some(window) = windows.get(index) else {
            continue;
        };
        let Some(window) = window.downcast_ref::<AXUIElement>() else {
            continue;
        };
        let close_button = attribute(window, "AXCloseButton")
            .and_then(|b| b.downcast_ref::<AXUIElement>().and_then(frame_of));
        out.push(AxWindow {
            title: string_of(window, "AXTitle").unwrap_or_default(),
            frame: frame_of(window),
            minimized: bool_of(window, "AXMinimized").unwrap_or(false),
            fullscreen: bool_of(window, "AXFullScreen").unwrap_or(false),
            subrole: string_of(window, "AXSubrole").unwrap_or_default(),
            close_button,
            window_id: window_id_of(window),
        });
    }
    Ok(out)
}

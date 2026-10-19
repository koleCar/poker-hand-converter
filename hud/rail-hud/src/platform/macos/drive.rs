//! Test drivers for the macOS overlay test (R3.12): the mouse as the user
//! moves it - a click or a drag posted to the window server
//! (`CGEventPost` at the HID level), which hit-tests the screen and sends
//! the events to whichever window is there, ours or a table's. Posting
//! events needs the test's responsible process to have the Accessibility
//! permission; [`can_post`] reads whether it does without prompting, and
//! the test skips (and says so) when it does not. And the pixels of the
//! test's own overlay windows as the window server shows them
//! ([`own_window_pixels`]). Only the tests call these: the HUD never posts
//! an event, moves the pointer, reads a pixel of the screen or asks for a
//! permission to.

use std::time::Duration;

use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGColorSpace,
    CGContext, CGEvent, CGEventTapLocation, CGEventType, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, CGMouseButton, CGPreflightPostEventAccess, CGWindowImageOption,
    CGWindowListOption,
};

use super::Frame;

/// Whether this process may post events (Accessibility); reading it
/// prompts nobody.
pub fn can_post() -> bool {
    CGPreflightPostEventAccess()
}

#[allow(clippy::float_arithmetic)]
fn point(x: i64, y: i64) -> CGPoint {
    let p = |v: i64| f64::from(i32::try_from(v).unwrap_or(0)) / 1000.0;
    CGPoint::new(p(x), p(y))
}

fn post(kind: CGEventType, at: CGPoint) -> Result<(), String> {
    let event = CGEvent::new_mouse_event(None, kind, at, CGMouseButton::Left)
        .ok_or("CGEventCreateMouseEvent")?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    // Let the window server and the receiving app take each one.
    std::thread::sleep(Duration::from_millis(30));
    Ok(())
}

/// A left click at (`x`, `y`): thousandths of a point, the global top-left
/// space (the window server's, the engine's rects divided by the scale).
pub fn click(x: i64, y: i64) -> Result<(), String> {
    let at = point(x, y);
    post(CGEventType::MouseMoved, at)?;
    post(CGEventType::LeftMouseDown, at)?;
    post(CGEventType::LeftMouseUp, at)
}

/// A left drag from `from` to `to` in `steps` moves (same space and unit
/// as [`click`]).
pub fn drag(from: (i64, i64), to: (i64, i64), steps: u32) -> Result<(), String> {
    post(CGEventType::MouseMoved, point(from.0, from.1))?;
    post(CGEventType::LeftMouseDown, point(from.0, from.1))?;
    let steps = i64::from(steps.max(1));
    for i in 1..=steps {
        let at = (
            from.0 + (to.0 - from.0) * i / steps,
            from.1 + (to.1 - from.1) * i / steps,
        );
        post(CGEventType::LeftMouseDragged, point(at.0, at.1))?;
    }
    post(CGEventType::LeftMouseUp, point(to.0, to.1))
}

/// The middle of `frame` (any space), thousandths of a point.
pub fn middle(frame: &Frame) -> (i64, i64) {
    (frame.x + frame.width / 2, frame.y + frame.height / 2)
}

/// Pixels of **this process's own** window `window` as the window server
/// composes it (blue, green, red, alpha, premultiplied; `at` in the
/// window's pixels at its backing scale): what the overlay really shows,
/// not only what was painted into its bitmap - the macOS twin of the
/// Windows test's `BitBlt`. The window server hands a process images of
/// its own windows without Screen Recording (another process's window
/// would need it: never asked for here). `CGWindowListCreateImage` is
/// deprecated in favour of ScreenCaptureKit, which needs that permission
/// for any window: `None` when a macOS release no longer answers.
#[allow(unsafe_code, deprecated)]
pub fn own_window_pixels(window: u32, at: &[(u32, u32)]) -> Option<Vec<[u8; 4]>> {
    let infinite = CGPoint::new(f64::INFINITY, f64::INFINITY);
    // `CGRectNull`: the window's own bounds.
    let null = CGRect::new(infinite, CGSize::new(0.0, 0.0));
    let image = objc2_core_graphics::CGWindowListCreateImage(
        null,
        CGWindowListOption::OptionIncludingWindow,
        window,
        CGWindowImageOption::BoundsIgnoreFraming | CGWindowImageOption::BestResolution,
    )?;
    let (w, h) = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
    if w == 0 || h == 0 {
        return None;
    }
    let space = CGColorSpace::new_device_rgb()?;
    let info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
    // SAFETY: a null `data` lets Core Graphics allocate the pixels; the
    // rest describes them.
    let context =
        unsafe { CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, Some(&space), info) }?;
    let size = CGSize::new(
        f64::from(u32::try_from(w).ok()?),
        f64::from(u32::try_from(h).ok()?),
    );
    CGContext::draw_image(
        Some(&context),
        CGRect::new(CGPoint::new(0.0, 0.0), size),
        Some(&image),
    );
    let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
    if data.is_null() {
        return None;
    }
    let row = CGBitmapContextGetBytesPerRow(Some(&context));
    at.iter()
        .map(|&(x, y)| {
            let (x, y) = (usize::try_from(x).ok()?, usize::try_from(y).ok()?);
            if x >= w || y >= h {
                return None;
            }
            // Row 0 of the bitmap's memory is the image's top row.
            let offset = y * row + x * 4;
            // SAFETY: the context owns `h` rows of `row` bytes at `data`
            // while it lives (to the end of this function); (x, y) is
            // inside the image, so the four bytes at `offset` are too.
            let bytes = unsafe { std::slice::from_raw_parts(data.add(offset), 4) };
            Some([bytes[0], bytes[1], bytes[2], bytes[3]])
        })
        .collect()
}

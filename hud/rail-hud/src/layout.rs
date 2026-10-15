//! Where the HUD's panels go on a table (R3.4's default layout; R3.6
//! replaces it with each room's seat map, the hero's rotation and panels
//! the user drags).
//!
//! Everything is integer maths over the table's **client area** in physical
//! pixels; positions on the table are in thousandths of the client width and
//! height, so a layout holds at any window size and DPI.
//!
//! - **Seats**: one slot per seat of a table size, seat 1 at the bottom and
//!   then clockwise ([`SEAT_SLOTS`]) - the table simulator's own geometry
//!   (`rail_hud_sim::draw::seat_center`, R3.1), which a test holds equal.
//!   No hero rotation yet (R3.6): seat `n` is slot `n - 1`.
//! - **Table graphics** ([`table_graphics`]): what a client draws and a panel
//!   must not cover - every seat's plate and the board. ACR forbids covering
//!   them (policy 4.2.11, `noOverlapTableGraphics`), and the default layout
//!   keeps clear of them for every room. Modelled on the simulator's plates
//!   until R3.6 measures each room's.
//! - **Panels** ([`place_panels`]): next to the seat's plate, on the first
//!   side - away from the table's centre vertically, then towards it, then
//!   outward and inward horizontally - where the panel lies inside the
//!   client area and covers no table graphic and no other panel. When no
//!   side is free the panel is dropped if the room forbids covering its
//!   graphics, else it takes the first side anyway.
//! - **Sizes** ([`Metrics`]): a row is 3.4 % of the client height, between
//!   13 and 22 logical pixels (times the monitor's scale): the HUD grows
//!   with the table, never past a size that would cover it.

#![forbid(unsafe_code)]

use crate::platform::Rect;

/// Seat slot centres per table size (2 to 10 seats), in thousandths of the
/// client width and height. Slot 0 is bottom centre, then clockwise.
pub const SEAT_SLOTS: [&[(u32, u32)]; 9] = [
    &[(500, 840), (500, 240)],
    &[(500, 840), (145, 390), (855, 390)],
    &[(500, 840), (90, 540), (500, 240), (910, 540)],
    &[(500, 840), (110, 633), (259, 297), (741, 297), (890, 633)],
    &[
        (500, 840),
        (145, 690),
        (145, 390),
        (500, 240),
        (855, 390),
        (855, 690),
    ],
    &[
        (500, 840),
        (179, 727),
        (100, 473),
        (322, 270),
        (678, 270),
        (900, 473),
        (821, 727),
    ],
    &[
        (500, 840),
        (210, 752),
        (90, 540),
        (210, 328),
        (500, 240),
        (790, 328),
        (910, 540),
        (790, 752),
    ],
    &[
        (500, 840),
        (236, 770),
        (96, 592),
        (145, 390),
        (360, 258),
        (640, 258),
        (855, 390),
        (904, 592),
        (764, 770),
    ],
    &[
        (500, 840),
        (259, 783),
        (110, 633),
        (110, 447),
        (259, 297),
        (500, 240),
        (741, 297),
        (890, 447),
        (890, 633),
        (741, 783),
    ],
];

/// The table's centre, in thousandths of the client area.
pub const TABLE_CENTER: (u32, u32) = (500, 540);

/// Table sizes the layout knows; others are clamped into this range.
pub const MIN_SEATS: u32 = 2;
pub const MAX_SEATS: u32 = 10;

/// The slots of a table size.
fn slots(size: u32) -> &'static [(u32, u32)] {
    let index = usize::try_from(size.clamp(MIN_SEATS, MAX_SEATS) - MIN_SEATS).unwrap_or(0);
    SEAT_SLOTS[index]
}

/// Where seat `seat` (1-based) of a `size`-seat table is centred, in
/// thousandths of the client area. `None` for a seat the size does not
/// have.
pub fn seat_center(size: u32, seat: u32) -> Option<(u32, u32)> {
    let slot = usize::try_from(seat.checked_sub(1)?).ok()?;
    slots(size).get(slot).copied()
}

/// The table size to lay out for: the window's, else the smallest usual
/// size that has every seat a hand named (6, 9, 10).
pub fn size_for(size: Option<u32>, seats: impl IntoIterator<Item = u32>) -> u32 {
    if let Some(size) = size {
        return size.clamp(MIN_SEATS, MAX_SEATS);
    }
    let highest = seats.into_iter().max().unwrap_or(0);
    [6, 9, 10]
        .into_iter()
        .find(|&n| n >= highest)
        .unwrap_or(MAX_SEATS)
}

fn part(total: u32, thousandths: u32) -> i64 {
    i64::from(total) * i64::from(thousandths) / 1000
}

/// A rectangle from i64 maths (clamped into what [`Rect`] holds).
fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
    Rect {
        x: i32::try_from(x).unwrap_or(if x < 0 { i32::MIN } else { i32::MAX }),
        y: i32::try_from(y).unwrap_or(if y < 0 { i32::MIN } else { i32::MAX }),
        width: u32::try_from(width.max(0)).unwrap_or(u32::MAX),
        height: u32::try_from(height.max(0)).unwrap_or(u32::MAX),
    }
}

/// Whether two rectangles share any pixel.
pub fn intersects(a: &Rect, b: &Rect) -> bool {
    let (ax1, ay1) = (
        i64::from(a.x) + i64::from(a.width),
        i64::from(a.y) + i64::from(a.height),
    );
    let (bx1, by1) = (
        i64::from(b.x) + i64::from(b.width),
        i64::from(b.y) + i64::from(b.height),
    );
    a.width > 0
        && a.height > 0
        && b.width > 0
        && b.height > 0
        && i64::from(a.x) < bx1
        && i64::from(b.x) < ax1
        && i64::from(a.y) < by1
        && i64::from(b.y) < ay1
}

/// Whether `inner` lies inside a `width` x `height` area at the origin.
pub fn inside(inner: &Rect, width: u32, height: u32) -> bool {
    inner.x >= 0
        && inner.y >= 0
        && i64::from(inner.x) + i64::from(inner.width) <= i64::from(width)
        && i64::from(inner.y) + i64::from(inner.height) <= i64::from(height)
}

/// Whether a point is in a rectangle.
pub fn contains(r: &Rect, x: i32, y: i32) -> bool {
    x >= r.x
        && y >= r.y
        && i64::from(x) < i64::from(r.x) + i64::from(r.width)
        && i64::from(y) < i64::from(r.y) + i64::from(r.height)
}

/// The plate a client draws for a seat centred at `center` (thousandths):
/// the simulator's (17 % of the width, at least 90 px; three text lines or
/// 8 % of the height). Client-relative pixels.
pub fn seat_plate(width: u32, height: u32, center: (u32, u32)) -> Rect {
    let (w, h) = (i64::from(width), i64::from(height));
    let text_scale = (h / 330).clamp(1, 3);
    let line = 10 * text_scale;
    let plate_w = (w * 170 / 1000).max(90);
    let plate_h = (line * 3 + 8).max(h * 80 / 1000);
    let (cx, cy) = (part(width, center.0), part(height, center.1));
    rect(cx - plate_w / 2, cy - plate_h / 2, plate_w, plate_h)
}

/// The board, the pot and the hand line around the table's centre.
pub fn board_area(width: u32, height: u32) -> Rect {
    let h = i64::from(height);
    let (cx, cy) = (part(width, TABLE_CENTER.0), part(height, TABLE_CENTER.1));
    let half_w = h * 215 / 1000;
    rect(cx - half_w, cy - h * 60 / 1000, 2 * half_w, h * 155 / 1000)
}

/// Everything of the table a panel must not cover: every seat's plate (taken
/// or empty) and the board.
pub fn table_graphics(width: u32, height: u32, size: u32) -> Vec<Rect> {
    let mut out: Vec<Rect> = slots(size)
        .iter()
        .map(|&center| seat_plate(width, height, center))
        .collect();
    out.push(board_area(width, height));
    out
}

/// A panel's and its text's sizes for one client area, physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Metrics {
    /// One row of figures.
    pub row: u32,
    /// The font's em size.
    pub font: u32,
    /// Inner margin.
    pub pad: u32,
    /// Space between a panel and its seat's plate.
    pub gap: u32,
    /// One statistic's cell.
    pub cell: u32,
    /// The hand count's cell (up to five characters).
    pub wide_cell: u32,
    /// Corner radius.
    pub radius: u32,
}

impl Metrics {
    /// For a client area `height` pixels high on a monitor at
    /// `scale_permille`.
    pub fn for_client(height: u32, scale_permille: u32) -> Self {
        let scale = u64::from(scale_permille.max(500));
        let low = 13 * scale / 1000;
        let high = 22 * scale / 1000;
        let row = (u64::from(height) * 34 / 1000).clamp(low, high);
        let row = u32::try_from(row).unwrap_or(u32::MAX).max(8);
        Self {
            row,
            font: (row * 72 / 100).max(7),
            pad: (row / 4).max(2),
            gap: (row / 4).max(2),
            cell: row * 17 / 10,
            wide_cell: row * 21 / 10,
            radius: (row / 4).max(2),
        }
    }

    /// A panel of `columns` statistic columns, two rows of figures (the
    /// hand count in the first row's last cell) and `extra_rows` more.
    pub fn panel_size(&self, columns: u32, extra_rows: u32) -> (u32, u32) {
        (
            2 * self.pad + columns.max(1) * self.cell + self.wide_cell,
            2 * self.pad + (2 + extra_rows) * self.row,
        )
    }

    /// A one-line pill for `chars` characters of text.
    pub fn pill_size(&self, chars: u32) -> (u32, u32) {
        (
            2 * self.pad + 2 * self.font + chars * self.font * 56 / 100,
            2 * self.pad + self.row,
        )
    }
}

/// Where each seat's panel goes: for each of `seats` (in order), its
/// rectangle (client-relative pixels), or `None` when it was dropped
/// because every side would cover table graphics and `avoid_graphics`
/// holds. Seats beyond the table size are dropped too.
pub fn place_panels(
    width: u32,
    height: u32,
    size: u32,
    seats: &[u32],
    panel: (u32, u32),
    gap: u32,
    avoid_graphics: bool,
) -> Vec<(u32, Option<Rect>)> {
    // Seat order first; if a panel finds no free side, the reverse order
    // too (a crowded 10-seat table), and whichever leaves fewer without one.
    let (forward, conflicts) = greedy(
        width,
        height,
        size,
        seats.iter(),
        panel,
        gap,
        avoid_graphics,
    );
    if conflicts == 0 {
        return forward;
    }
    let (mut backward, fewer) = greedy(
        width,
        height,
        size,
        seats.iter().rev(),
        panel,
        gap,
        avoid_graphics,
    );
    if fewer < conflicts {
        backward.reverse();
        backward
    } else {
        forward
    }
}

/// One pass in `order`: each panel on its first free side. Returns the
/// placements (in `order`) and how many found no free side.
fn greedy<'a>(
    width: u32,
    height: u32,
    size: u32,
    order: impl Iterator<Item = &'a u32>,
    panel: (u32, u32),
    gap: u32,
    avoid_graphics: bool,
) -> (Vec<(u32, Option<Rect>)>, usize) {
    let graphics = table_graphics(width, height, size);
    let mut taken: Vec<Rect> = Vec::new();
    let mut out = Vec::new();
    let mut conflicts = 0;
    for &seat in order {
        let Some(center) = seat_center(size, seat) else {
            out.push((seat, None));
            continue;
        };
        let plate = seat_plate(width, height, center);
        let candidates = sides(width, height, center, &plate, panel, gap);
        let free = candidates.iter().find(|candidate| {
            inside(candidate, width, height)
                && !graphics.iter().any(|g| intersects(candidate, g))
                && !taken.iter().any(|t| intersects(candidate, t))
        });
        if free.is_none() {
            conflicts += 1;
        }
        let chosen = match free {
            Some(rect) => Some(*rect),
            None if avoid_graphics => None,
            None => candidates.first().copied(),
        };
        if let Some(rect) = chosen {
            taken.push(rect);
        }
        out.push((seat, chosen));
    }
    (out, conflicts)
}

/// Where a panel may go around a plate, in order of preference, each
/// pushed inside the client area: above / below the plate (away from the
/// table's centre first), centred on it, then slid along that side step by
/// step (outward first) as far as it still overlaps the plate along it;
/// then beside the plate (outward first), slid the same way vertically.
fn sides(
    width: u32,
    height: u32,
    center: (u32, u32),
    plate: &Rect,
    panel: (u32, u32),
    gap: u32,
) -> Vec<Rect> {
    let (pw, ph) = (i64::from(panel.0), i64::from(panel.1));
    let gap = i64::from(gap);
    let (sx, sy) = (part(width, center.0), part(height, center.1));
    let (cx, cy) = (part(width, TABLE_CENTER.0), part(height, TABLE_CENTER.1));
    let (bx, by) = (i64::from(plate.x), i64::from(plate.y));
    let (bw, bh) = (i64::from(plate.width), i64::from(plate.height));
    let above = by - gap - ph;
    let below = by + bh + gap;
    let left = bx - gap - pw;
    let right = bx + bw + gap;
    let (out_y, in_y) = if sy > cy {
        (below, above)
    } else {
        (above, below)
    };
    let (out_x, in_x) = if sx < cx {
        (left, right)
    } else {
        (right, left)
    };
    // Which way is "outward" along each axis.
    let x_out = if sx < cx { -1 } else { 1 };
    let y_out = if sy > cy { 1 } else { -1 };
    let step = (ph / 8).max(1);
    let slides = |reach: i64, outward: i64| {
        let mut out = vec![0];
        let mut k = step;
        while k <= reach {
            out.push(k * outward);
            out.push(-k * outward);
            k += step;
        }
        out
    };
    let fit = |x: i64, y: i64| {
        let x = x.clamp(0, (i64::from(width) - pw).max(0));
        let y = y.clamp(0, (i64::from(height) - ph).max(0));
        rect(x, y, pw, ph)
    };
    let mut out = Vec::new();
    for y in [out_y, in_y] {
        for dx in slides((pw + bw) / 2 - 1, x_out) {
            out.push(fit(sx - pw / 2 + dx, y));
        }
    }
    for x in [out_x, in_x] {
        for dy in slides((ph + bh) / 2 - 1, y_out) {
            out.push(fit(x, sy - ph / 2 + dy));
        }
    }
    out
}

/// Where a status pill (`pill` pixels) goes: centred near the top, else near
/// the bottom, clear of the table graphics; `None` when neither is clear
/// and `avoid_graphics` holds.
pub fn place_status(
    width: u32,
    height: u32,
    size: u32,
    pill: (u32, u32),
    avoid_graphics: bool,
) -> Option<Rect> {
    let graphics = table_graphics(width, height, size);
    let (pw, ph) = (i64::from(pill.0), i64::from(pill.1));
    let x = (i64::from(width) - pw) / 2;
    let candidates = [
        rect(x, part(height, 140) - ph / 2, pw, ph),
        rect(x, part(height, 960) - ph, pw, ph),
    ];
    let free = candidates
        .iter()
        .find(|c| inside(c, width, height) && !graphics.iter().any(|g| intersects(c, g)));
    match free {
        Some(rect) => Some(*rect),
        None if avoid_graphics => None,
        None => Some(candidates[0]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The client sizes the default layout must fit without dropping a
    /// panel: from a small table (640 x 440 logical) up, at 100 % to 200 %.
    fn usual_clients() -> Vec<(u32, u32, u32)> {
        let mut out = Vec::new();
        for scale in [1000, 1250, 1500, 2000] {
            for (w, h) in [(640, 440), (640, 480), (800, 580), (1024, 740), (1280, 900)] {
                out.push((w * scale / 1000, h * scale / 1000, scale));
            }
        }
        out.push((1920, 1080, 1000));
        out.push((2560, 1600, 1000));
        out
    }

    /// The layout is the simulator's: the same slot per seat, the same
    /// centre (so a test can find a seat on its tables at any size).
    #[test]
    fn seats_are_the_simulators() {
        for size in MIN_SEATS..=MAX_SEATS {
            for seat in 1..=size {
                let (x, y) = rail_hud_sim::draw::seat_center(size, seat, None);
                assert_eq!(
                    seat_center(size, seat),
                    Some((x, y)),
                    "{size} seats, {seat}"
                );
            }
            assert_eq!(seat_center(size, 0), None);
            assert_eq!(seat_center(size, size + 1), None);
        }
        assert_eq!(TABLE_CENTER, rail_hud_sim::draw::TABLE_CENTER);
    }

    #[test]
    fn sizes() {
        assert_eq!(size_for(Some(6), []), 6);
        assert_eq!(size_for(Some(1), []), 2);
        assert_eq!(size_for(Some(12), []), 10);
        assert_eq!(size_for(None, [1, 4]), 6);
        assert_eq!(size_for(None, [2, 8]), 9);
        assert_eq!(size_for(None, [10]), 10);
        assert_eq!(size_for(None, [13]), 10);
        assert_eq!(size_for(None, []), 6);
    }

    #[test]
    fn rectangles() {
        let a = rect(0, 0, 10, 10);
        assert!(intersects(&a, &rect(9, 9, 5, 5)));
        assert!(
            !intersects(&a, &rect(10, 0, 5, 5)),
            "edges touch, no pixel shared"
        );
        assert!(!intersects(&a, &rect(3, 3, 0, 5)), "empty");
        assert!(inside(&a, 10, 10));
        assert!(!inside(&rect(-1, 0, 5, 5), 10, 10));
        assert!(!inside(&rect(6, 0, 5, 5), 10, 10));
        assert!(contains(&a, 0, 9));
        assert!(!contains(&a, 10, 0));
    }

    #[test]
    fn metrics_grow_with_the_table_within_bounds() {
        let small = Metrics::for_client(300, 1000);
        assert_eq!(small.row, 13);
        let usual = Metrics::for_client(480, 1000);
        assert_eq!(usual.row, 16);
        let big = Metrics::for_client(1400, 1000);
        assert_eq!(big.row, 22);
        let hidpi = Metrics::for_client(960, 2000);
        assert_eq!(hidpi.row, 32);
        assert!(hidpi.font >= 2 * usual.font - 2);
        let (w, h) = usual.panel_size(3, 0);
        assert_eq!((w, h), (8 + 3 * 27 + 33, 8 + 32));
        assert!(Metrics::for_client(0, 0).row >= 8);
    }

    /// Every seat of every size gets a panel inside the client area,
    /// covering no plate, not the board and no other panel - at every usual
    /// client size and scale.
    #[test]
    fn every_panel_fits_clear_of_the_table() {
        for (w, h, scale) in usual_clients() {
            let metrics = Metrics::for_client(h, scale);
            let panel = metrics.panel_size(3, 0);
            for size in MIN_SEATS..=MAX_SEATS {
                let seats: Vec<u32> = (1..=size).collect();
                let placed = place_panels(w, h, size, &seats, panel, metrics.gap, true);
                let graphics = table_graphics(w, h, size);
                let rects: Vec<Rect> = placed
                    .iter()
                    .map(|(seat, r)| {
                        r.unwrap_or_else(|| {
                            panic!("{w}x{h} at {scale}: {size} seats, seat {seat} dropped")
                        })
                    })
                    .collect();
                for (i, r) in rects.iter().enumerate() {
                    assert!(inside(r, w, h), "{w}x{h}: {r:?}");
                    for g in &graphics {
                        assert!(!intersects(r, g), "{w}x{h} {size}: {r:?} covers {g:?}");
                    }
                    for other in &rects[i + 1..] {
                        assert!(!intersects(r, other), "{w}x{h} {size}: {r:?} / {other:?}");
                    }
                }
                let status = place_status(w, h, size, metrics.pill_size(22), true)
                    .unwrap_or_else(|| panic!("{w}x{h} {size}: no room for the status"));
                assert!(graphics.iter().all(|g| !intersects(&status, g)));
            }
        }
    }

    /// A panel sits next to its own seat's plate: a gap away from it on one
    /// side, beside it along that side - at every usual size.
    #[test]
    fn a_panel_is_next_to_its_seat() {
        for (w, h, scale) in usual_clients() {
            let metrics = Metrics::for_client(h, scale);
            let panel = metrics.panel_size(3, 0);
            for size in MIN_SEATS..=MAX_SEATS {
                let seats: Vec<u32> = (1..=size).collect();
                for (seat, r) in place_panels(w, h, size, &seats, panel, metrics.gap, true) {
                    let r = r.expect("placed");
                    let plate = seat_plate(w, h, seat_center(size, seat).expect("seat"));
                    assert!(
                        next_to(&r, &plate, metrics.gap),
                        "{w}x{h}: {size} seats, seat {seat}: {r:?} not next to {plate:?}"
                    );
                }
            }
        }
    }

    /// `panel` is within `gap` (+1) of `plate` and does not cover it.
    fn next_to(panel: &Rect, plate: &Rect, gap: u32) -> bool {
        let reach = i64::from(gap) + 1;
        let grown = rect(
            i64::from(plate.x) - reach,
            i64::from(plate.y) - reach,
            i64::from(plate.width) + 2 * reach,
            i64::from(plate.height) + 2 * reach,
        );
        intersects(panel, &grown) && !intersects(panel, plate)
    }

    /// A table too small for the HUD: a room that forbids covering its
    /// graphics gets no panel where none fits; another room still gets one.
    #[test]
    fn a_crowded_table_drops_panels_only_where_it_must() {
        let (w, h) = (300, 200);
        let metrics = Metrics::for_client(h, 2000);
        let panel = metrics.panel_size(3, 0);
        let seats: Vec<u32> = (1..=10).collect();
        let strict = place_panels(w, h, 10, &seats, panel, metrics.gap, true);
        assert!(strict.iter().any(|(_, r)| r.is_none()));
        let graphics = table_graphics(w, h, 10);
        for r in strict.iter().filter_map(|(_, r)| r.as_ref()) {
            assert!(graphics.iter().all(|g| !intersects(r, g)));
        }
        let loose = place_panels(w, h, 10, &seats, panel, metrics.gap, false);
        assert!(loose.iter().all(|(_, r)| r.is_some()));
        // A seat the table does not have is never placed.
        let beyond = place_panels(800, 580, 6, &[7], panel, metrics.gap, false);
        assert_eq!(beyond, [(7, None)]);
    }
}

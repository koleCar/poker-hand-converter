//! Where the HUD's panels go on a table (R3.4's default layout; R3.6's
//! room layouts, rotation and the panels the user drags).
//!
//! Everything is integer maths over the table's **client area** in physical
//! pixels; positions on the table are in thousandths of the client width and
//! height, so a layout holds at any window size and DPI.
//!
//! - **A table layout** ([`TableLayout`], per room and table size): where
//!   the client draws each seat - its **slots**, clockwise, in the order of
//!   the hand history's seats 1, 2, ... when nothing is rotated -, the
//!   table's centre, where a rotating client draws the hero (`hero_slot`),
//!   and the table graphics a panel must not cover. A room's measured one
//!   comes from `sites.json` `tables.seatLayouts` (none is measured yet:
//!   R3.3's capture, R3.14); every other size and room gets
//!   [`TableLayout::simulator`], the table simulator's own geometry
//!   (`rail_hud_sim::draw::seat_center`, R3.1; a test holds it equal) with
//!   seat 1 bottom centre. Which slot a hand's seat is drawn at - the
//!   hero's rotation, a table's seat numbering - is `crate::seats`.
//! - **Table graphics** ([`TableLayout::graphics`]): what a client draws and
//!   a panel must not cover - every seat's plate and the board (measured
//!   layouts add their own zones). ACR forbids covering them (policy
//!   4.2.11, `noOverlapTableGraphics`), and the default layout keeps clear
//!   of them for every room.
//! - **Panels** ([`place_panels`]): next to the seat's plate, on the first
//!   side - away from the table's centre vertically, then towards it, then
//!   outward and inward horizontally - where the panel lies inside the
//!   client area and covers no table graphic and no other panel. When no
//!   side is free the panel is dropped if the room forbids covering its
//!   graphics, else it takes the first side anyway.
//! - **The user's positions** ([`Positions`], [`constrain`]): a panel the
//!   user dragged is centred where they left it (thousandths of the client
//!   area, per room, table size and slot), kept inside the client area,
//!   and on a room that forbids covering its graphics moved to the nearest
//!   place clear of them; the other panels avoid it.
//! - **Sizes** ([`Metrics`]): a row is 3.4 % of the client height, between
//!   13 and 22 logical pixels (times the monitor's scale): the HUD grows
//!   with the table, never past a size that would cover it.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use rail_config::model::SeatLayout;

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

/// Panels the user put somewhere, by slot: each panel's centre in
/// thousandths of the client width and height (R3.6; per room and table
/// size, `hud_seat_positions` in the store).
pub type Positions = BTreeMap<u32, (u32, u32)>;

/// What a layout's table graphics are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Graphics {
    /// The table simulator's: its seat plates (17 % of the width, at least
    /// 90 px; three text lines or 8 % of the height) and its board.
    Simulator,
    /// Measured on a room's client: a plate's size and the other zones
    /// (`[x, y, width, height]`), thousandths of the client area.
    Measured {
        plate: (u32, u32),
        zones: Vec<[u32; 4]>,
    },
}

/// Where one room's client draws one table size (R3.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableLayout {
    /// The table size, 2 - 10.
    pub size: u32,
    /// Each slot's seat plate centre, clockwise, thousandths; slot `i` is
    /// where an unrotated client draws its `i`-th seat.
    pub slots: Vec<(u32, u32)>,
    /// The table's centre, thousandths.
    pub center: (u32, u32),
    /// Where a rotating client draws the hero.
    pub hero_slot: u32,
    /// The hand history's seat number of each slot, when not `1..=size`.
    pub seat_numbers: Option<Vec<u32>>,
    pub graphics: Graphics,
}

impl TableLayout {
    /// The table simulator's geometry for `size` seats (clamped to 2 -
    /// 10): seat 1 bottom centre, clockwise, the hero at the bottom when
    /// it rotates (`--preferred-seat`). The default for every room and
    /// size without a measured layout.
    pub fn simulator(size: u32) -> Self {
        let size = size.clamp(MIN_SEATS, MAX_SEATS);
        Self {
            size,
            slots: slots(size).to_vec(),
            center: TABLE_CENTER,
            hero_slot: 0,
            seat_numbers: None,
            graphics: Graphics::Simulator,
        }
    }

    /// A room's measured layout (`sites.json` `tables.seatLayouts`) for
    /// `size` seats; `None` when it does not describe that many seats (the
    /// validator refuses such a file, so a shipped one always fits).
    pub fn measured(size: u32, layout: &SeatLayout) -> Option<Self> {
        let fits = (MIN_SEATS..=MAX_SEATS).contains(&size)
            && u32::try_from(layout.seats.len()).ok() == Some(size)
            && layout.hero_slot < size
            && layout
                .seat_numbers
                .as_ref()
                .is_none_or(|numbers| numbers.len() == layout.seats.len());
        fits.then(|| Self {
            size,
            slots: layout
                .seats
                .iter()
                .map(|&[x, y]| (x.min(1000), y.min(1000)))
                .collect(),
            center: (layout.center[0].min(1000), layout.center[1].min(1000)),
            hero_slot: layout.hero_slot,
            seat_numbers: layout.seat_numbers.clone(),
            graphics: Graphics::Measured {
                plate: (layout.plate[0], layout.plate[1]),
                zones: layout.graphics.clone(),
            },
        })
    }

    /// A slot's plate centre, thousandths.
    pub fn slot_center(&self, slot: u32) -> Option<(u32, u32)> {
        self.slots.get(usize::try_from(slot).ok()?).copied()
    }

    /// The slot an unrotated client draws a hand history's seat at.
    pub fn slot_of_seat(&self, seat: u32) -> Option<u32> {
        match &self.seat_numbers {
            Some(numbers) => numbers
                .iter()
                .position(|&n| n == seat)
                .and_then(|i| u32::try_from(i).ok()),
            None => (1..=self.size).contains(&seat).then(|| seat - 1),
        }
    }

    /// The plate drawn at `slot`, client-relative pixels.
    pub fn plate(&self, width: u32, height: u32, slot: u32) -> Option<Rect> {
        let center = self.slot_center(slot)?;
        Some(self.plate_at(width, height, center))
    }

    fn plate_at(&self, width: u32, height: u32, center: (u32, u32)) -> Rect {
        match &self.graphics {
            Graphics::Simulator => seat_plate(width, height, center),
            Graphics::Measured { plate, .. } => {
                let (w, h) = (part(width, plate.0), part(height, plate.1));
                rect(
                    part(width, center.0) - w / 2,
                    part(height, center.1) - h / 2,
                    w,
                    h,
                )
            }
        }
    }

    /// Everything of the table a panel must not cover: every slot's plate
    /// (taken or empty) and the other graphics (the simulator's board, a
    /// measured layout's zones). Client-relative pixels.
    pub fn graphics(&self, width: u32, height: u32) -> Vec<Rect> {
        let mut out: Vec<Rect> = self
            .slots
            .iter()
            .map(|&center| self.plate_at(width, height, center))
            .collect();
        match &self.graphics {
            Graphics::Simulator => out.push(board_area(width, height)),
            Graphics::Measured { zones, .. } => {
                out.extend(zones.iter().map(|&[x, y, w, h]| {
                    rect(
                        part(width, x),
                        part(height, y),
                        part(width, w),
                        part(height, h),
                    )
                }));
            }
        }
        out
    }
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

/// The plate the table simulator draws for a seat centred at `center`
/// (thousandths): 17 % of the width, at least 90 px; three text lines or
/// 8 % of the height. Client-relative pixels.
pub fn seat_plate(width: u32, height: u32, center: (u32, u32)) -> Rect {
    let (w, h) = (i64::from(width), i64::from(height));
    let text_scale = (h / 330).clamp(1, 3);
    let line = 10 * text_scale;
    let plate_w = (w * 170 / 1000).max(90);
    let plate_h = (line * 3 + 8).max(h * 80 / 1000);
    let (cx, cy) = (part(width, center.0), part(height, center.1));
    rect(cx - plate_w / 2, cy - plate_h / 2, plate_w, plate_h)
}

/// The simulator's board, pot and hand line around the table's centre.
pub fn board_area(width: u32, height: u32) -> Rect {
    let h = i64::from(height);
    let (cx, cy) = (part(width, TABLE_CENTER.0), part(height, TABLE_CENTER.1));
    let half_w = h * 215 / 1000;
    rect(cx - half_w, cy - h * 60 / 1000, 2 * half_w, h * 155 / 1000)
}

/// The simulator's table graphics for `size` seats
/// ([`TableLayout::graphics`] of [`TableLayout::simulator`]).
pub fn table_graphics(width: u32, height: u32, size: u32) -> Vec<Rect> {
    TableLayout::simulator(size).graphics(width, height)
}

/// A panel's centre in thousandths of the client area (what the store
/// keeps for a dragged panel).
pub fn center_permille(r: &Rect, width: u32, height: u32) -> (u32, u32) {
    let at = |start: i32, size: u32, total: u32| {
        let middle = i64::from(start) + i64::from(size) / 2;
        let total = i64::from(total.max(1));
        u32::try_from((middle * 1000 / total).clamp(0, 1000)).unwrap_or(0)
    };
    (at(r.x, r.width, width), at(r.y, r.height, height))
}

/// A `panel`-sized rectangle centred at `center` (thousandths).
pub fn centred_at(width: u32, height: u32, center: (u32, u32), panel: (u32, u32)) -> Rect {
    let (pw, ph) = (i64::from(panel.0), i64::from(panel.1));
    rect(
        part(width, center.0) - pw / 2,
        part(height, center.1) - ph / 2,
        pw,
        ph,
    )
}

/// Where a panel the user put at `wanted` may go: inside the client area,
/// and when `graphics` is given (the room forbids covering its table
/// graphics, ACR) clear of every one of them - the nearest such place,
/// searched in rings around `wanted`; `None` when there is none.
pub fn constrain(width: u32, height: u32, wanted: Rect, graphics: Option<&[Rect]>) -> Option<Rect> {
    let (pw, ph) = (i64::from(wanted.width), i64::from(wanted.height));
    let fit = |x: i64, y: i64| {
        let x = x.clamp(0, (i64::from(width) - pw).max(0));
        let y = y.clamp(0, (i64::from(height) - ph).max(0));
        rect(x, y, pw, ph)
    };
    let start = fit(i64::from(wanted.x), i64::from(wanted.y));
    let Some(graphics) = graphics else {
        return Some(start);
    };
    let clear = |r: &Rect| !graphics.iter().any(|g| intersects(r, g));
    if clear(&start) {
        return Some(start);
    }
    let step = i64::from((wanted.width.min(wanted.height) / 4).max(2));
    let reach = i64::from(width.max(height));
    let (sx, sy) = (i64::from(start.x), i64::from(start.y));
    let mut radius = step;
    while radius <= reach {
        let mut ring = Vec::new();
        let mut d = -radius;
        while d <= radius {
            ring.push((d, -radius));
            ring.push((d, radius));
            if d != -radius && d != radius {
                ring.push((-radius, d));
                ring.push((radius, d));
            }
            d += step;
        }
        ring.sort_by_key(|&(dx, dy)| dx * dx + dy * dy);
        if let Some(found) = ring
            .into_iter()
            .map(|(dx, dy)| fit(sx + dx, sy + dy))
            .find(|candidate| clear(candidate))
        {
            return Some(found);
        }
        radius += step;
    }
    None
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
        self.panel_rows(columns, 2 + extra_rows)
    }

    /// (R3.9) A panel of `columns` statistic columns (the hand count's
    /// cell after them) and `rows` rows in all.
    pub fn panel_rows(&self, columns: u32, rows: u32) -> (u32, u32) {
        (
            2 * self.pad + columns.max(1) * self.cell + self.wide_cell,
            2 * self.pad + rows.max(1) * self.row,
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

/// What [`place_panels`] works with: the client area, the layout, a
/// panel's size and gap, whether table graphics bind, and what is already
/// taken (panels the user placed).
#[derive(Debug, Clone, Copy)]
pub struct Placing<'a> {
    pub width: u32,
    pub height: u32,
    pub layout: &'a TableLayout,
    pub panel: (u32, u32),
    pub gap: u32,
    pub avoid_graphics: bool,
    pub taken: &'a [Rect],
}

/// Where each slot's panel goes: for each of `slots` (in order), its
/// rectangle (client-relative pixels), or `None` when it was dropped
/// because every side would cover table graphics and `avoid_graphics`
/// holds. Slots the layout does not have are dropped too.
pub fn place_panels(placing: &Placing<'_>, slots: &[u32]) -> Vec<(u32, Option<Rect>)> {
    // Slot order first; if a panel finds no free side, the reverse order
    // too (a crowded 10-seat table), and whichever leaves fewer without one.
    let (forward, conflicts) = greedy(placing, slots.iter());
    if conflicts == 0 {
        return forward;
    }
    let (mut backward, fewer) = greedy(placing, slots.iter().rev());
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
    placing: &Placing<'_>,
    order: impl Iterator<Item = &'a u32>,
) -> (Vec<(u32, Option<Rect>)>, usize) {
    let Placing {
        width,
        height,
        layout,
        panel,
        gap,
        avoid_graphics,
        taken,
    } = *placing;
    let graphics = layout.graphics(width, height);
    let mut taken: Vec<Rect> = taken.to_vec();
    let mut out = Vec::new();
    let mut conflicts = 0;
    for &slot in order {
        let (Some(center), Some(plate)) =
            (layout.slot_center(slot), layout.plate(width, height, slot))
        else {
            out.push((slot, None));
            continue;
        };
        let candidates = sides(width, height, center, layout.center, &plate, panel, gap);
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
        out.push((slot, chosen));
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
    table_center: (u32, u32),
    plate: &Rect,
    panel: (u32, u32),
    gap: u32,
) -> Vec<Rect> {
    let (pw, ph) = (i64::from(panel.0), i64::from(panel.1));
    let gap = i64::from(gap);
    let (sx, sy) = (part(width, center.0), part(height, center.1));
    let (cx, cy) = (part(width, table_center.0), part(height, table_center.1));
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
    layout: &TableLayout,
    pill: (u32, u32),
    avoid_graphics: bool,
) -> Option<Rect> {
    let graphics = layout.graphics(width, height);
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

/// (R3.8) Where the legend goes: a corner of the client area `margin` in
/// from its edges - top left, top right, bottom left, bottom right, the
/// first that is clear of the table's graphics and of everything `taken`
/// (the panels, the status pill, the debug line). `None`: no corner is free
/// (the legend is left out; the panels matter more).
pub fn place_legend(
    width: u32,
    height: u32,
    layout: &TableLayout,
    size: (u32, u32),
    margin: u32,
    taken: &[Rect],
) -> Option<Rect> {
    let graphics = layout.graphics(width, height);
    let (w, h, m) = (i64::from(size.0), i64::from(size.1), i64::from(margin));
    let (right, bottom) = (i64::from(width) - w - m, i64::from(height) - h - m);
    [(m, m), (right, m), (m, bottom), (right, bottom)]
        .into_iter()
        .map(|(x, y)| rect(x, y, w, h))
        .find(|c| {
            inside(c, width, height)
                && !graphics.iter().any(|g| intersects(c, g))
                && !taken.iter().any(|t| intersects(c, t))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (R3.8) The legend takes the first free corner: top left on an empty
    /// table, the next one when something is there, none when the client
    /// is too small for it.
    #[test]
    fn the_legend_takes_a_free_corner() {
        let layout = TableLayout::simulator(6);
        let (w, h) = (800, 580);
        let first = place_legend(w, h, &layout, (60, 20), 4, &[]).expect("a corner");
        assert_eq!((first.x, first.y), (4, 4));
        let second = place_legend(w, h, &layout, (60, 20), 4, &[first]).expect("another");
        assert_eq!((second.x, second.y), (736, 4));
        for corner in [first, second] {
            for g in layout.graphics(w, h) {
                assert!(!intersects(&corner, &g));
            }
        }
        assert_eq!(place_legend(50, 20, &layout, (60, 20), 4, &[]), None);
    }

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

    fn placing<'a>(
        w: u32,
        h: u32,
        layout: &'a TableLayout,
        metrics: &Metrics,
        avoid: bool,
    ) -> Placing<'a> {
        Placing {
            width: w,
            height: h,
            layout,
            panel: metrics.panel_size(3, 0),
            gap: metrics.gap,
            avoid_graphics: avoid,
            taken: &[],
        }
    }

    /// The default layout is the simulator's: the same slot per seat, the
    /// same centre (so a test can find a seat on its tables at any size).
    #[test]
    fn seats_are_the_simulators() {
        for size in MIN_SEATS..=MAX_SEATS {
            let layout = TableLayout::simulator(size);
            assert_eq!(layout.size, size);
            for seat in 1..=size {
                let (x, y) = rail_hud_sim::draw::seat_center(size, seat, None);
                assert_eq!(
                    seat_center(size, seat),
                    Some((x, y)),
                    "{size} seats, {seat}"
                );
                assert_eq!(layout.slot_of_seat(seat), Some(seat - 1));
                assert_eq!(layout.slot_center(seat - 1), Some((x, y)));
            }
            assert_eq!(seat_center(size, 0), None);
            assert_eq!(seat_center(size, size + 1), None);
            assert_eq!(layout.slot_of_seat(0), None);
            assert_eq!(layout.slot_of_seat(size + 1), None);
            assert_eq!(layout.slot_center(size), None);
        }
        assert_eq!(TABLE_CENTER, rail_hud_sim::draw::TABLE_CENTER);
        assert_eq!(TableLayout::simulator(1).size, 2);
        assert_eq!(TableLayout::simulator(12).size, 10);
    }

    fn measured_six() -> SeatLayout {
        SeatLayout {
            seats: vec![
                [700, 150],
                [900, 450],
                [700, 800],
                [300, 800],
                [100, 450],
                [300, 150],
            ],
            plate: [160, 90],
            center: [500, 480],
            hero_slot: 2,
            graphics: vec![[350, 380, 300, 180], [900, 0, 100, 60]],
            seat_numbers: None,
        }
    }

    /// A measured layout: its plates, its zones, its seat numbering; one
    /// that does not fit the size is not taken.
    #[test]
    fn a_measured_layout() {
        let layout = TableLayout::measured(6, &measured_six()).expect("fits");
        assert_eq!(layout.plate(1000, 1000, 0), Some(rect(620, 105, 160, 90)));
        let graphics = layout.graphics(1000, 1000);
        assert_eq!(graphics.len(), 8);
        assert_eq!(graphics[6], rect(350, 380, 300, 180));
        assert_eq!(graphics[7], rect(900, 0, 100, 60));
        assert_eq!(layout.slot_of_seat(4), Some(3));

        let mut numbered = measured_six();
        numbered.seat_numbers = Some(vec![1, 2, 4, 5, 7, 9]);
        let layout = TableLayout::measured(6, &numbered).expect("fits");
        assert_eq!(layout.slot_of_seat(7), Some(4));
        assert_eq!(layout.slot_of_seat(3), None, "no such seat at this table");

        assert!(TableLayout::measured(9, &measured_six()).is_none());
        let mut wrong = measured_six();
        wrong.hero_slot = 6;
        assert!(TableLayout::measured(6, &wrong).is_none());

        // Its panels keep clear of its own zones.
        let layout = TableLayout::measured(6, &measured_six()).expect("fits");
        let metrics = Metrics::for_client(580, 1000);
        let placed = place_panels(
            &placing(800, 580, &layout, &metrics, true),
            &[0, 1, 2, 3, 4, 5],
        );
        let graphics = layout.graphics(800, 580);
        for (slot, r) in placed {
            let r = r.unwrap_or_else(|| panic!("slot {slot} dropped"));
            assert!(graphics.iter().all(|g| !intersects(&r, g)), "{slot}: {r:?}");
        }
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
        assert_eq!(
            center_permille(&rect(300, 200, 40, 20), 800, 420),
            (400, 500)
        );
        assert_eq!(
            centred_at(800, 420, (400, 500), (40, 20)),
            rect(300, 200, 40, 20)
        );
        assert_eq!(
            center_permille(&rect(-500, 9000, 10, 10), 800, 420),
            (0, 1000)
        );
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
            for size in MIN_SEATS..=MAX_SEATS {
                let layout = TableLayout::simulator(size);
                let slots: Vec<u32> = (0..size).collect();
                let placed = place_panels(&placing(w, h, &layout, &metrics, true), &slots);
                let graphics = table_graphics(w, h, size);
                let rects: Vec<Rect> = placed
                    .iter()
                    .map(|(slot, r)| {
                        r.unwrap_or_else(|| {
                            panic!("{w}x{h} at {scale}: {size} seats, slot {slot} dropped")
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
                let status = place_status(w, h, &layout, metrics.pill_size(22), true)
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
            for size in MIN_SEATS..=MAX_SEATS {
                let layout = TableLayout::simulator(size);
                let slots: Vec<u32> = (0..size).collect();
                for (slot, r) in place_panels(&placing(w, h, &layout, &metrics, true), &slots) {
                    let r = r.expect("placed");
                    let plate = layout.plate(w, h, slot).expect("slot");
                    assert!(
                        next_to(&r, &plate, metrics.gap),
                        "{w}x{h}: {size} seats, slot {slot}: {r:?} not next to {plate:?}"
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
        let layout = TableLayout::simulator(10);
        let slots: Vec<u32> = (0..10).collect();
        let strict = place_panels(&placing(w, h, &layout, &metrics, true), &slots);
        assert!(strict.iter().any(|(_, r)| r.is_none()));
        let graphics = table_graphics(w, h, 10);
        for r in strict.iter().filter_map(|(_, r)| r.as_ref()) {
            assert!(graphics.iter().all(|g| !intersects(r, g)));
        }
        let loose = place_panels(&placing(w, h, &layout, &metrics, false), &slots);
        assert!(loose.iter().all(|(_, r)| r.is_some()));
        // A slot the table does not have is never placed.
        let six = TableLayout::simulator(6);
        let beyond = place_panels(&placing(800, 580, &six, &metrics, false), &[6]);
        assert_eq!(beyond, [(6, None)]);
    }

    /// A panel the user placed is kept clear of by the others.
    #[test]
    fn placed_panels_are_avoided() {
        let (w, h) = (800, 580);
        let metrics = Metrics::for_client(h, 1000);
        let layout = TableLayout::simulator(6);
        let free = place_panels(&placing(w, h, &layout, &metrics, true), &[1]);
        let usual = free[0].1.expect("placed");
        let taken = [usual];
        let mut with = placing(w, h, &layout, &metrics, true);
        with.taken = &taken;
        let moved = place_panels(&with, &[1])[0].1.expect("placed");
        assert_ne!(moved, usual);
        assert!(!intersects(&moved, &usual));
    }

    /// A dragged panel: inside the client area always; on a room that
    /// forbids covering its graphics, the nearest place clear of them.
    #[test]
    fn a_dragged_panel_is_constrained() {
        let (w, h) = (800, 580);
        let panel = (100, 40);
        // Past the edge: pulled in.
        let out = constrain(w, h, rect(760, -20, 100, 40), None).expect("inside");
        assert_eq!(out, rect(700, 0, 100, 40));
        // On the board, no restriction: where it was put.
        let board = board_area(w, h);
        let on_board = centred_at(w, h, (500, 540), panel);
        assert!(intersects(&on_board, &board));
        assert_eq!(constrain(w, h, on_board, None), Some(on_board));
        // ACR: the nearest place clear of every graphic.
        let graphics = table_graphics(w, h, 6);
        let moved = constrain(w, h, on_board, Some(&graphics)).expect("a clear place");
        assert!(graphics.iter().all(|g| !intersects(&moved, g)));
        assert!(inside(&moved, w, h));
        let distance = |a: &Rect, b: &Rect| {
            (i64::from(a.x) - i64::from(b.x)).abs() + (i64::from(a.y) - i64::from(b.y)).abs()
        };
        assert!(distance(&moved, &on_board) < 200, "near: {moved:?}");
        // Already clear: unchanged.
        let clear = rect(10, 60, 100, 40);
        assert!(graphics.iter().all(|g| !intersects(&clear, g)));
        assert_eq!(constrain(w, h, clear, Some(&graphics)), Some(clear));
        // Nowhere clear: none.
        let everything = [rect(0, 0, i64::from(w), i64::from(h))];
        assert_eq!(constrain(w, h, clear, Some(&everything)), None);
    }
}

//! The drawn table: felt, seats with names and stacks, the dealer button,
//! the board - something for an overlay to align to - and, always visible,
//! "RAIL TABLE SIMULATOR".
//!
//! CPU drawing into a `0x00RRGGBB` frame (what softbuffer presents), integer
//! geometry, an 8x8 bitmap font. Seat positions are fixed fractions of the
//! client area ([`seat_center`]), so an overlay test can compute where a
//! seat is drawn at any window size.

use crate::sim::Shown;

/// Seat slot centres per table size, in thousandths of the client width and
/// height. Slot 0 is bottom centre, then clockwise (left, top, right).
const LAYOUTS: [&[(u32, u32)]; 9] = [
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

/// The slot a seat is drawn in: seat 1 in slot 0 and on clockwise, or, with
/// a preferred seat (`hero_seat`), the hero's seat at the bottom.
pub fn slot_of(seat: u32, size: u32, hero_seat: Option<u32>) -> u32 {
    let size = size.max(1);
    let seat = seat.clamp(1, size);
    match hero_seat {
        Some(hero) => (seat + size - hero.clamp(1, size)) % size,
        None => seat - 1,
    }
}

/// Where a seat's box is centred, in thousandths of the client area.
pub fn seat_center(size: u32, seat: u32, hero_seat: Option<u32>) -> (u32, u32) {
    let index = usize::try_from(size.clamp(2, 10) - 2).unwrap_or(0);
    let layout = LAYOUTS[index];
    let slot = usize::try_from(slot_of(seat, size.clamp(2, 10), hero_seat)).unwrap_or(0);
    layout.get(slot).copied().unwrap_or(TABLE_CENTER)
}

/// What one window shows.
#[derive(Debug, Clone, Copy)]
pub struct View<'a> {
    pub table: u32,
    pub room: &'a str,
    pub title: &'a str,
    pub size: u32,
    pub hero_seat: u32,
    /// Draw the hero's seat at the bottom.
    pub preferred_seat: bool,
    pub shown: Option<&'a Shown>,
    pub hands: u64,
    pub paused: bool,
    pub speed: &'a str,
}

const BACKGROUND: u32 = 0x001b_1f24;
const BANNER: u32 = 0x0033_2a00;
const BANNER_TEXT: u32 = 0x00ff_d84a;
const TEXT: u32 = 0x00e8_e8e8;
const DIM: u32 = 0x0080_8890;
const RAIL: u32 = 0x005a_3a22;
const FELT: u32 = 0x001f_6b3a;
const SEAT: u32 = 0x002b_2f36;
const SEAT_EMPTY: u32 = 0x0023_272c;
const HERO: u32 = 0x00d4_a017;
const CARD: u32 = 0x00f4_f4f4;
const BUTTON: u32 = 0x00ff_ffff;
const BLACK: u32 = 0x0010_1010;

/// A frame being drawn.
#[derive(Debug)]
pub struct Canvas<'a> {
    pub pixels: &'a mut [u32],
    pub width: u32,
    pub height: u32,
}

fn to_usize(v: i64) -> usize {
    usize::try_from(v).unwrap_or(0)
}

fn thousandths(total: u32, part: u32) -> i64 {
    i64::from(total) * i64::from(part) / 1000
}

impl Canvas<'_> {
    fn w(&self) -> i64 {
        i64::from(self.width)
    }

    fn h(&self) -> i64 {
        i64::from(self.height)
    }

    pub fn clear(&mut self, color: u32) {
        self.pixels.fill(color);
    }

    pub fn rect(&mut self, x: i64, y: i64, w: i64, h: i64, color: u32) {
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = ((x + w).min(self.w()), (y + h).min(self.h()));
        if x0 >= x1 || y0 >= y1 {
            return;
        }
        for row in y0..y1 {
            let start = to_usize(row * self.w() + x0);
            let end = to_usize(row * self.w() + x1);
            if let Some(span) = self.pixels.get_mut(start..end) {
                span.fill(color);
            }
        }
    }

    pub fn frame(&mut self, x: i64, y: i64, w: i64, h: i64, t: i64, color: u32) {
        self.rect(x, y, w, t, color);
        self.rect(x, y + h - t, w, t, color);
        self.rect(x, y, t, h, color);
        self.rect(x + w - t, y, t, h, color);
    }

    pub fn ellipse(&mut self, cx: i64, cy: i64, rx: i64, ry: i64, color: u32) {
        if rx <= 0 || ry <= 0 {
            return;
        }
        for dy in -ry..=ry {
            let inside = u64::try_from(ry * ry - dy * dy).unwrap_or(0);
            let half = rx * i64::try_from(inside.isqrt()).unwrap_or(0) / ry;
            self.rect(cx - half, cy + dy, 2 * half + 1, 1, color);
        }
    }

    /// Text at (x, y), top left; characters outside Latin-1 as `?`.
    pub fn text(&mut self, x: i64, y: i64, text: &str, scale: i64, color: u32) {
        let mut pen = x;
        for c in text.chars() {
            // The euro sign is outside the font: an E stands in.
            let code = if c == '\u{20ac}' {
                u32::from('E')
            } else {
                u32::from(c)
            };
            let glyph = match code {
                0..=127 => font8x8::legacy::BASIC_LEGACY[usize::try_from(code).unwrap_or(0)],
                160..=255 => {
                    font8x8::legacy::LATIN_LEGACY[usize::try_from(code - 160).unwrap_or(0)]
                }
                _ => font8x8::legacy::BASIC_LEGACY[usize::from(b'?')],
            };
            for (row, bits) in (0_i64..).zip(glyph) {
                for col in 0..8_i64 {
                    if bits & (1 << col) != 0 {
                        self.rect(pen + col * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
            pen += 8 * scale;
            if pen > self.w() {
                break;
            }
        }
    }

    /// Text centred on `cx`, cut to `max` pixels.
    pub fn text_centered(&mut self, cx: i64, y: i64, text: &str, scale: i64, color: u32, max: i64) {
        let fit = usize::try_from((max / (8 * scale)).max(1)).unwrap_or(1);
        let shown: String = if text.chars().count() > fit {
            text.chars()
                .take(fit.saturating_sub(1))
                .chain(['~'])
                .collect()
        } else {
            text.to_owned()
        };
        let width = i64::try_from(shown.chars().count()).unwrap_or(0) * 8 * scale;
        self.text(cx - width / 2, y, &shown, scale, color);
    }
}

fn suit_color(card: &str) -> u32 {
    match card.chars().last() {
        Some('h') => 0x00c0_1a1a,
        Some('d') => 0x001a_4fc0,
        Some('c') => 0x0010_8030,
        _ => BLACK,
    }
}

/// Draw one table window's frame.
pub fn draw(canvas: &mut Canvas<'_>, view: &View<'_>) {
    let (w, h) = (canvas.w(), canvas.h());
    canvas.clear(BACKGROUND);
    let scale = (h / 330).clamp(1, 3);
    let line = 10 * scale;

    // The banner: what this window is, always.
    canvas.rect(0, 0, w, line * 2 + 6, BANNER);
    canvas.text(
        6,
        3,
        "RAIL TABLE SIMULATOR - not a poker client",
        scale,
        BANNER_TEXT,
    );
    canvas.text(6, 3 + line, view.title, scale, TEXT);
    let tag = format!("{} #{}", view.room, view.table);
    let tag_width = i64::try_from(tag.chars().count()).unwrap_or(0) * 8 * scale;
    canvas.text(w - tag_width - 6, 3, &tag, scale, DIM);

    // Felt.
    let (cx, cy) = (
        thousandths(canvas.width, TABLE_CENTER.0),
        thousandths(canvas.height, TABLE_CENTER.1),
    );
    canvas.ellipse(cx, cy, w * 370 / 1000, h * 270 / 1000, RAIL);
    canvas.ellipse(cx, cy, w * 345 / 1000, h * 240 / 1000, FELT);

    let preferred = view.preferred_seat.then_some(view.hero_seat);
    let box_w = (w * 170 / 1000).max(90);
    let box_h = (line * 3 + 8).max(h * 80 / 1000);

    // Board and hand.
    match view.shown {
        Some(shown) => {
            let card_h = (h / 9).max(24);
            let card_w = card_h * 7 / 10;
            let gap = card_w / 6;
            let count = i64::try_from(shown.board.len()).unwrap_or(0);
            let total = count * card_w + (count - 1).max(0) * gap;
            let mut x = cx - total / 2;
            for card in &shown.board {
                canvas.rect(x, cy - card_h / 2, card_w, card_h, CARD);
                canvas.text_centered(
                    x + card_w / 2,
                    cy - 4 * scale,
                    card,
                    scale,
                    suit_color(card),
                    card_w,
                );
                x += card_w + gap;
            }
            let info = format!("Hand #{}  {}", shown.hand_id, shown.stakes);
            canvas.text_centered(cx, cy + card_h / 2 + 6, &info, scale, TEXT, w * 6 / 10);
        }
        None => canvas.text_centered(
            cx,
            cy - 4 * scale,
            "waiting for first hand",
            scale,
            TEXT,
            w / 2,
        ),
    }

    // Seats.
    for seat in 1..=view.size {
        let (sx, sy) = seat_center(view.size, seat, preferred);
        let (sx, sy) = (
            thousandths(canvas.width, sx),
            thousandths(canvas.height, sy),
        );
        let (x, y) = (sx - box_w / 2, sy - box_h / 2);
        let player = view
            .shown
            .and_then(|s| s.seats.iter().find(|p| p.seat == seat));
        match player {
            Some(p) => {
                canvas.rect(x, y, box_w, box_h, SEAT);
                if p.hero {
                    canvas.frame(x, y, box_w, box_h, 2, HERO);
                }
                let color = if p.sitting_out { DIM } else { TEXT };
                canvas.text_centered(sx, y + 4, &p.name, scale, color, box_w - 6);
                canvas.text_centered(sx, y + 4 + line, &p.stack, scale, DIM, box_w - 6);
                if p.hero && !p.cards.is_empty() {
                    canvas.text_centered(
                        sx,
                        y + 4 + 2 * line,
                        &p.cards.join(" "),
                        scale,
                        HERO,
                        box_w - 6,
                    );
                } else {
                    canvas.text_centered(
                        sx,
                        y + 4 + 2 * line,
                        &format!("seat {seat}"),
                        scale,
                        DIM,
                        box_w - 6,
                    );
                }
            }
            None => {
                canvas.rect(x, y, box_w, box_h, SEAT_EMPTY);
                canvas.text_centered(
                    sx,
                    sy - 4 * scale,
                    &format!("seat {seat}"),
                    scale,
                    DIM,
                    box_w,
                );
            }
        }
        if view.shown.and_then(|s| s.button) == Some(seat) {
            let bx = cx + (sx - cx) * 62 / 100;
            let by = cy + (sy - cy) * 62 / 100;
            let r = (h / 40).max(7);
            canvas.ellipse(bx, by, r, r, BUTTON);
            canvas.text(bx - 4 * scale, by - 4 * scale, "D", scale, BLACK);
        }
    }

    // Footer: the keys and the state.
    let state = format!(
        "{} hands  {}/min{}",
        view.hands,
        view.speed,
        if view.paused { "  PAUSED" } else { "" }
    );
    canvas.text(
        6,
        h - line * 2 - 2,
        &state,
        scale,
        if view.paused { BANNER_TEXT } else { DIM },
    );
    canvas.text(
        6,
        h - line - 2,
        "space pause  +/- speed  H hand  T move  N new  W close  M min  arrows  Q quit",
        scale,
        DIM,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::SeatView;

    #[test]
    fn slots() {
        assert_eq!(slot_of(1, 6, None), 0);
        assert_eq!(slot_of(4, 6, Some(4)), 0);
        assert_eq!(slot_of(3, 6, Some(4)), 5);
        assert_eq!(seat_center(6, 4, Some(4)), (500, 840));
        for size in 2..=10 {
            let mut seen = std::collections::HashSet::new();
            for seat in 1..=size {
                assert!(seen.insert(seat_center(size, seat, Some(size))));
            }
        }
    }

    #[test]
    fn draws_every_size_at_any_size() {
        let shown = Shown {
            hand_id: "123".into(),
            stakes: "$0.05/$0.10".into(),
            seats: (1..=9)
                .map(|seat| SeatView {
                    seat,
                    name: format!("Player\u{e9}{seat}\u{4e00}"),
                    stack: "$10".into(),
                    hero: seat == 2,
                    cards: vec!["Ah".into(), "Kd".into()],
                    sitting_out: seat == 3,
                })
                .collect(),
            button: Some(5),
            board: vec![
                "Th".into(),
                "Kh".into(),
                "Ac".into(),
                "9d".into(),
                "8s".into(),
            ],
        };
        for (width, height) in [(1, 1), (40, 30), (320, 240), (800, 580), (1920, 1080)] {
            for size in [2, 5, 6, 9, 10] {
                let mut pixels = vec![0; usize::try_from(width * height).unwrap_or(0)];
                let mut canvas = Canvas {
                    pixels: &mut pixels,
                    width,
                    height,
                };
                for shown in [None, Some(&shown)] {
                    draw(
                        &mut canvas,
                        &View {
                            table: 1,
                            room: "PokerStars",
                            title: "Title",
                            size,
                            hero_seat: 2,
                            preferred_seat: size == 6,
                            shown,
                            hands: 3,
                            paused: true,
                            speed: "2",
                        },
                    );
                }
                if width >= 320 {
                    assert!(pixels.contains(&BANNER_TEXT), "the banner is drawn");
                    assert!(pixels.contains(&FELT));
                }
            }
        }
    }
}

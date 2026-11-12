//! An overlay frame turned into what to paint (R3.4): filled rounded
//! rectangles and lines of text at physical pixels of the table's client
//! area, with their colours. Platform-free, so every OS tests it; the
//! Windows backend paints a [`Scene`] with Direct2D and DirectWrite, macOS
//! (R3.12) with Core Graphics and Core Text.
//!
//! **Where** (R3.6): each player's hand-history seat becomes a slot of the
//! room's layout for the table size (`crate::seats`: the room's numbering,
//! the hero's rotation); a panel the user dragged goes where they left it
//! ([`compose_with`] adds the overlay thread's drag on top of the frame's
//! positions), the others next to their seat's plate around it.
//!
//! The renderer is where a room's restrictions bind ([`compose`]): the
//! frame carries compliance's [`crate::compliance::Permit`] - no frame of a
//! room without a HUD can exist - and the panel design is cut down to the
//! permit's restrictions ([`PanelDesign::enforce`]) before anything is laid
//! out.
//!
//! **Palette.** Panels are near-black at 88 % opacity, so their figures
//! keep their contrast on any felt (green, blue, red, black, a photo) and
//! the table shows through at the edges. Figures are light: neutral
//! off-white, a light blue for the low band and a light orange for the
//! high band (blue / orange rather than green / red, which a red-green
//! colour-blind player cannot tell apart), each above 7:1 against the
//! panel. Unrestricted designs (none ships) add a deeper blue and a red for
//! the outer bands. A figure's opacity is R2.5's reliability (0.6 - 1): a
//! small sample shows dimmer, never hidden. The hand count is grey.
//!
//! **The player's words (R3.8)**, only where the room allows labelling
//! players (the design's `player_labels` after the permit's restrictions:
//! never on PokerStars or ACR): the colour tag as a bar down the panel's left
//! edge in one of six bright colours ([`tag_color`]: they are drawn on the
//! panel's own near-black, so they keep their contrast on any felt), a small
//! mark in the top right corner when the player has a note, and their labels
//! as a third row.
//!
//! **The legend (R3.8)**: one small pill in a corner of the table, clear of
//! the table's graphics and of every panel, with one sign per colour the
//! panels can show under the room's rules, in that colour - `--`, `-`, `=`,
//! `+`, `++` for very low to very high (PokerStars: `-`, `=`, `+`). Signs,
//! not words: the HUD draws no language. The popup says in words where each
//! statistic's thresholds are. Like every drawn pixel of a layered window it
//! takes clicks (it is listed in [`Scene::panels`]), so it goes where the
//! table has nothing: R3.14 measures each client's controls into the
//! layout's graphics.
//!
//! **The RNG widget (T4, docs/research/TABLE-TILING.md §4.4)**, when the
//! frame carries a roll ([`OverlayFrame::rng`], under the room's
//! `RngPermit`): one large bold number in its band's colour on a compact
//! borderless rounded plate of the panels' near-black, the band's name
//! small under it when the user gave one. It scales with the table (the
//! panels' [`Metrics`]) and keeps its size from roll to roll (as wide as
//! the range's widest number). Its default spot is the table's top-right
//! corner, slid down the right edge past the table's graphics and the
//! panels when they are there; where the user dragged it (per room and
//! table size, [`crate::platform::RNG_SLOT`] in the positions) it goes
//! wherever inside the client area. A band colour too dark to read on the
//! plate is lifted towards white just enough ([`readable`]). An RNG-only
//! frame (no HUD permit: a room that refuses a HUD, or the panels held
//! back) draws the widget and nothing else - no panel, status line, debug
//! line or legend.

#![forbid(unsafe_code)]

use rail_config::model::HudRestrictions;
use rail_config::stats::Tone;

use crate::compliance::Permit;
use crate::layout::{self, Metrics, Placing, Positions, TableLayout};
use crate::panel::{PanelDesign, collapse_tone, hands_text, legend_tones};
use crate::platform::{OverlayFrame, RNG_SLOT, Rect, RngShown, TagColour};
use crate::seats;

/// A colour with straight (not premultiplied) alpha.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    /// (T4) `#rrggbb`, opaque; `None` for anything else.
    pub fn from_hex(text: &str) -> Option<Self> {
        let hex = text.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let part = |at: usize| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok();
        Some(Self::rgb(part(0)?, part(2)?, part(4)?))
    }

    /// (T4) Its relative luminance, roughly (sRGB's weights over squared
    /// channels - gamma 2 for 2.2, in integers): 0 (black) - 65 025 (white).
    pub fn luminance(self) -> u32 {
        let sq = |c: u8| u32::from(c) * u32::from(c);
        (2126 * sq(self.r) + 7152 * sq(self.g) + 722 * sq(self.b)) / 10_000
    }

    /// The same colour at `permille` of its opacity.
    #[must_use]
    pub fn faded(self, permille: u32) -> Self {
        let a = u32::from(self.a) * permille.min(1000) / 1000;
        Self {
            a: u8::try_from(a).unwrap_or(u8::MAX),
            ..self
        }
    }
}

/// A panel's background.
pub const PANEL: Rgba = Rgba {
    r: 16,
    g: 20,
    b: 26,
    a: 224,
};
/// The neutral figure colour.
pub const NORMAL: Rgba = Rgba::rgb(236, 239, 243);
/// The low band (and both low bands under two thresholds).
pub const LOW: Rgba = Rgba::rgb(120, 186, 255);
/// The high band (and both high bands under two thresholds).
pub const HIGH: Rgba = Rgba::rgb(255, 176, 84);
/// The very low band, unrestricted designs only.
pub const VERY_LOW: Rgba = Rgba::rgb(76, 140, 255);
/// The very high band, unrestricted designs only.
pub const VERY_HIGH: Rgba = Rgba::rgb(255, 104, 104);
/// The hand count and figures without a value.
pub const MUTED: Rgba = Rgba::rgb(160, 168, 180);

/// (T4) The least [`Rgba::luminance`] a band colour keeps on the
/// near-black plate: 0.12 of white's, about 3:1 against the plate - what
/// large bold text needs (WCAG AA). The default bands' darkest grey
/// (`#5c6370`) and a pure red are above it, a pure blue is not.
pub const MIN_RNG_LUMINANCE: u32 = 7_800;

/// (T4) `colour` as the RNG widget draws it on the plate: unchanged when
/// it is light enough ([`MIN_RNG_LUMINANCE`]), else mixed towards white
/// just enough to read (the least such mix, in thousandths).
pub fn readable(colour: Rgba) -> Rgba {
    if colour.luminance() >= MIN_RNG_LUMINANCE {
        return colour;
    }
    let mix = |t: u32| {
        let lift = |c: u8| {
            let c = u32::from(c);
            u8::try_from(c + (255 - c) * t / 1000).unwrap_or(u8::MAX)
        };
        Rgba {
            r: lift(colour.r),
            g: lift(colour.g),
            b: lift(colour.b),
            a: colour.a,
        }
    };
    // The least `t` (white is always light enough) by halving.
    let (mut low, mut high) = (0_u32, 1000_u32);
    while low < high {
        let t = (low + high) / 2;
        if mix(t).luminance() >= MIN_RNG_LUMINANCE {
            high = t;
        } else {
            low = t + 1;
        }
    }
    mix(high)
}

/// (R3.8) The note mark: a light yellow corner.
pub const NOTE: Rgba = Rgba::rgb(255, 214, 102);

/// (R3.8) A colour tag's colour on the panel: bright, each well apart from
/// the panel's near-black (at least 4.5:1), the app's six names.
pub fn tag_color(colour: TagColour) -> Rgba {
    match colour {
        TagColour::Red => Rgba::rgb(255, 92, 92),
        TagColour::Orange => Rgba::rgb(255, 150, 50),
        TagColour::Yellow => Rgba::rgb(255, 221, 64),
        TagColour::Green => Rgba::rgb(88, 214, 120),
        TagColour::Blue => Rgba::rgb(86, 170, 255),
        TagColour::Purple => Rgba::rgb(196, 140, 255),
    }
}

/// (R3.8) A tone's sign in the legend.
pub fn tone_sign(tone: Tone) -> &'static str {
    match tone {
        Tone::VeryLow => "--",
        Tone::Low => "-",
        Tone::Normal => "=",
        Tone::High => "+",
        Tone::VeryHigh => "++",
    }
}

/// A tone's colour.
pub fn tone_color(tone: Option<Tone>) -> Rgba {
    match tone {
        None => MUTED,
        Some(Tone::VeryLow) => VERY_LOW,
        Some(Tone::Low) => LOW,
        Some(Tone::Normal) => NORMAL,
        Some(Tone::High) => HIGH,
        Some(Tone::VeryHigh) => VERY_HIGH,
    }
}

/// Text alignment in its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Center,
}

/// One thing to paint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    /// A filled rounded rectangle.
    Fill {
        rect: Rect,
        radius: u32,
        color: Rgba,
    },
    /// One line of text in `rect`, vertically centred, clipped to it.
    Text {
        rect: Rect,
        text: String,
        /// The font's em size in pixels.
        px: u32,
        color: Rgba,
        bold: bool,
        align: Align,
    },
}

/// What an overlay paints.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Scene {
    /// The client area's size: the overlay's.
    pub width: u32,
    pub height: u32,
    /// Back to front.
    pub items: Vec<Item>,
    /// The panels' rectangles: where the overlay takes clicks (R3.8's
    /// popup); everywhere else is transparent and clicks reach the table.
    pub panels: Vec<Rect>,
    /// The seats' panels by slot (R3.6): what a drag picks up.
    pub seat_panels: Vec<(u32, Rect)>,
    /// The slots whose panel is where the user put it (R3.6).
    pub placed_by_user: Vec<u32>,
    /// The table size laid out (R3.6): what a dragged position is kept
    /// under.
    pub size: u32,
    /// Seats whose panel was dropped (no room clear of the table's
    /// graphics, or no seat number), for the diagnostics.
    pub dropped: Vec<String>,
    /// (R3.8) The colour tags drawn, by slot: none where the room forbids
    /// labelling players.
    pub tags: Vec<(u32, Rect)>,
    /// (R3.8) The slots whose panel has the note mark.
    pub noted: Vec<u32>,
    /// (R3.8) The legend, when drawn, and its tones.
    pub legend: Option<(Rect, Vec<Tone>)>,
    /// (R3.9) The statistics each seat's panel shows, by slot (their ids,
    /// in the design's order): what a room's rules left of the design.
    pub seat_cells: Vec<(u32, Vec<String>)>,
    /// (R3.9) Where each statistic is drawn on each seat's panel: slot,
    /// statistic id, its cell (the editor's preview opens a statistic's
    /// settings from it).
    pub cell_rects: Vec<(u32, String, Rect)>,
    /// (T4) The RNG widget, when drawn.
    pub rng: Option<RngDrawn>,
}

/// (T4) The RNG widget as drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RngDrawn {
    /// The plate (it takes clicks and drags).
    pub rect: Rect,
    pub value: u32,
    /// The number's colour (the band's, made [`readable`]).
    pub colour: Rgba,
    /// The number's font size, pixels.
    pub px: u32,
    /// The band's name, when drawn.
    pub label: Option<String>,
}

impl Scene {
    /// Whether a point (client-relative) is on a panel.
    pub fn hit(&self, x: i32, y: i32) -> bool {
        self.panels.iter().any(|r| layout::contains(r, x, y))
    }

    /// The slot of the seat panel at a point (client-relative), if any.
    pub fn seat_panel_at(&self, x: i32, y: i32) -> Option<(u32, Rect)> {
        self.seat_panels
            .iter()
            .rev()
            .find(|(_, r)| layout::contains(r, x, y))
            .copied()
    }

    /// What a press at a point (client-relative) picks up: (T4) the RNG
    /// widget ([`RNG_SLOT`], drawn above the panels), else a seat's panel.
    pub fn grab_at(&self, x: i32, y: i32) -> Option<(u32, Rect)> {
        self.rng
            .as_ref()
            .filter(|rng| layout::contains(&rng.rect, x, y))
            .map(|rng| (RNG_SLOT, rng.rect))
            .or_else(|| self.seat_panel_at(x, y))
    }

    /// Where the draggable thing at `slot` is drawn: a seat's panel, or
    /// (T4) the RNG widget at [`RNG_SLOT`].
    pub fn draggable(&self, slot: u32) -> Option<Rect> {
        if slot == RNG_SLOT {
            return self.rng.as_ref().map(|rng| rng.rect);
        }
        self.seat_panels
            .iter()
            .find(|(s, _)| *s == slot)
            .map(|(_, rect)| *rect)
    }
}

/// Lay `frame` out over a `width` x `height` client area at
/// `scale_permille`, under the frame's permit's restrictions.
pub fn compose(
    frame: &OverlayFrame,
    width: u32,
    height: u32,
    scale_permille: u32,
    design: &PanelDesign,
) -> Scene {
    compose_with(
        frame,
        width,
        height,
        scale_permille,
        design,
        &Positions::new(),
    )
}

/// [`compose`] with positions on top of the frame's own (a panel being
/// dragged, or dropped and not yet taken in by the engine: the overlay
/// thread's).
pub fn compose_with(
    frame: &OverlayFrame,
    width: u32,
    height: u32,
    scale_permille: u32,
    design: &PanelDesign,
    overrides: &Positions,
) -> Scene {
    // (T4) An RNG-only frame has no HUD permit: no panel, status line,
    // debug line or legend - only the RNG widget, under its own permit.
    let hud = frame.permit.is_some();
    let strictest = HudRestrictions::STRICTEST;
    let restrictions = frame
        .permit
        .as_ref()
        .map_or(&strictest, Permit::restrictions);
    let players: &[crate::platform::SeatPanel] = if hud { &frame.panels } else { &[] };
    let design = design.enforce(restrictions);
    let metrics = Metrics::for_client(height, scale_permille);
    let size = seats::table_size(frame.size, players.iter().filter_map(|p| p.seat));
    let table = frame
        .seating
        .layout
        .clone()
        .filter(|l| l.size == size)
        .unwrap_or_else(|| TableLayout::simulator(size));
    let mut scene = Scene {
        width,
        height,
        size,
        ..Scene::default()
    };

    if let Some(status) = frame.status.as_ref().filter(|_| hud) {
        let chars = u32::try_from(status.chars().count()).unwrap_or(u32::MAX);
        let pill = metrics.pill_size(chars);
        if let Some(rect) =
            layout::place_status(width, height, &table, pill, design.avoid_table_graphics)
        {
            scene.items.push(Item::Fill {
                rect,
                radius: metrics.radius,
                color: PANEL,
            });
            scene.items.push(Item::Text {
                rect,
                text: status.clone(),
                px: metrics.font,
                color: NORMAL,
                bold: false,
                align: Align::Center,
            });
            scene.panels.push(rect);
        } else {
            scene.dropped.push(format!("status {status:?}"));
        }
    }

    // (R3.7) A debug build's latency line: small, in a corner clear of the
    // table's graphics (bottom left, else top left), never a click target.
    let mut debug_rect = None;
    if let Some(debug) = frame.debug.as_ref().filter(|_| hud) {
        let px = (metrics.font * 3 / 4).max(9);
        let chars = u32::try_from(debug.chars().count()).unwrap_or(u32::MAX);
        let (w, h) = (
            2 * metrics.pad + chars.saturating_mul(px) * 56 / 100,
            metrics.row,
        );
        let pad = i32::try_from(metrics.pad).unwrap_or(0);
        let graphics = table.graphics(width, height);
        let spot = [
            i64::from(height) - i64::from(h) - i64::from(pad),
            i64::from(pad),
        ]
        .into_iter()
        .filter_map(|y| i32::try_from(y).ok())
        .map(|y| Rect {
            x: pad,
            y,
            width: w,
            height: h,
        })
        .find(|rect| {
            layout::inside(rect, width, height)
                && !graphics.iter().any(|g| layout::intersects(rect, g))
        });
        match spot {
            Some(rect) => {
                debug_rect = Some(rect);
                scene.items.push(Item::Fill {
                    rect,
                    radius: metrics.radius / 2,
                    color: PANEL,
                });
                scene.items.push(Item::Text {
                    rect,
                    text: debug.clone(),
                    px,
                    color: MUTED,
                    bold: false,
                    align: Align::Center,
                });
            }
            None => scene.dropped.push(format!("debug {debug:?}")),
        }
    }

    let cells = players
        .iter()
        .map(|p| p.stats.iter().filter(|c| design.shows(&c.id)).count())
        .max()
        .unwrap_or(0);
    let cells = u32::try_from(cells).unwrap_or(u32::MAX);
    // R3.4's panel: two rows of figures. (R3.9) A design's grid: exactly
    // its columns and rows, each statistic in its slot (one left out here
    // is blank, as an empty slot is); a design without rows: its columns
    // (fewer when it shows fewer cells), as many rows as the cells take.
    let (columns, rows) = match (design.columns, design.rows) {
        (None, _) => (cells.div_ceil(2), 2),
        (Some(columns), Some(rows)) => (
            columns.clamp(1, crate::design::MAX_COLUMNS),
            rows.clamp(1, crate::design::MAX_ROWS),
        ),
        (Some(columns), None) => {
            let columns = columns
                .clamp(1, crate::design::MAX_COLUMNS)
                .min(cells.max(1));
            (columns, cells.div_ceil(columns).max(1))
        }
    };
    let grid_slot = |id: &str| -> Option<u32> {
        design.rows?;
        design
            .stats
            .iter()
            .find(|slot| slot.id == id)
            .and_then(|slot| slot.at)
            .filter(|at| *at < columns.saturating_mul(rows))
    };
    let labels = design.player_labels && players.iter().any(|p| p.words.label.is_some());
    let panel = metrics.panel_rows(columns, rows + u32::from(labels));

    // Each seated player's slot: the room's layout, the hero's rotation.
    let slot_of = |seat: u32| seats::slot_of(&table, seat, frame.seating.rotate_to);
    let slots: Vec<u32> = players
        .iter()
        .filter_map(|p| p.seat.and_then(slot_of))
        .collect();

    // The user's places first (R3.6): inside the client area, and on a
    // room that forbids covering its graphics (ACR) the nearest place clear
    // of them; one with no such place falls back to the layout's.
    let mut positions = frame.seating.positions.clone();
    positions.extend(overrides.iter().map(|(k, v)| (*k, *v)));
    let graphics = table.graphics(width, height);
    let binding = restrictions
        .no_overlap_table_graphics
        .then_some(graphics.as_slice());
    let mut placed: Vec<(u32, Rect)> = Vec::new();
    for &slot in &slots {
        if let Some(&center) = positions.get(&slot)
            && let Some(rect) = layout::constrain(
                width,
                height,
                layout::centred_at(width, height, center, panel),
                binding,
            )
        {
            placed.push((slot, rect));
            scene.placed_by_user.push(slot);
        }
    }
    let taken: Vec<Rect> = placed.iter().map(|(_, r)| *r).collect();
    let auto: Vec<u32> = slots
        .iter()
        .copied()
        .filter(|s| !scene.placed_by_user.contains(s))
        .collect();
    placed.extend(
        layout::place_panels(
            &Placing {
                width,
                height,
                layout: &table,
                panel,
                gap: metrics.gap,
                avoid_graphics: design.avoid_table_graphics,
                taken: &taken,
            },
            &auto,
        )
        .into_iter()
        .filter_map(|(slot, rect)| rect.map(|r| (slot, r))),
    );

    for player in players {
        let Some(seat) = player.seat else {
            scene.dropped.push(format!("{}: no seat", player.player));
            continue;
        };
        let Some(slot) = slot_of(seat) else {
            scene
                .dropped
                .push(format!("seat {seat}: not a seat of a {size}-seat table"));
            continue;
        };
        let Some(rect) = placed.iter().find(|(s, _)| *s == slot).map(|(_, r)| *r) else {
            scene.dropped.push(format!("seat {seat}"));
            continue;
        };
        scene.items.push(Item::Fill {
            rect,
            radius: metrics.radius,
            color: PANEL,
        });
        scene.panels.push(rect);
        scene.seat_panels.push((slot, rect));
        // (R3.8) The player's colour tag and note mark, where the room
        // allows labelling players.
        if design.player_labels {
            if let Some(colour) = player.words.colour {
                let inset = metrics.radius;
                let bar = Rect {
                    x: rect.x,
                    y: rect.y + i32::try_from(inset).unwrap_or(0),
                    width: (metrics.pad * 2 / 3).max(2),
                    height: rect.height.saturating_sub(2 * inset),
                };
                scene.items.push(Item::Fill {
                    rect: bar,
                    radius: 0,
                    color: tag_color(colour),
                });
                scene.tags.push((slot, bar));
            }
            if player.words.noted {
                let side = metrics.pad.max(3);
                let inset = i32::try_from(metrics.radius / 2).unwrap_or(0);
                let right = rect.x + i32::try_from(rect.width).unwrap_or(0);
                scene.items.push(Item::Fill {
                    rect: Rect {
                        x: right - i32::try_from(side).unwrap_or(0) - inset,
                        y: rect.y + inset,
                        width: side,
                        height: side,
                    },
                    radius: 0,
                    color: NOTE,
                });
                scene.noted.push(slot);
            }
        }
        let cells: Vec<_> = player
            .stats
            .iter()
            .filter(|c| design.shows(&c.id))
            .collect();
        scene
            .seat_cells
            .push((slot, cells.iter().map(|c| c.id.clone()).collect()));
        let pad = i32::try_from(metrics.pad).unwrap_or(0);
        let row = i32::try_from(metrics.row).unwrap_or(0);
        let cell_w = i32::try_from(metrics.cell).unwrap_or(0);
        let cols = i32::try_from(columns).unwrap_or(1);
        for (flowed, cell) in (0_i32..).zip(&cells) {
            let index = grid_slot(&cell.id)
                .and_then(|at| i32::try_from(at).ok())
                .unwrap_or(flowed);
            let (r, c) = (index / cols, index % cols);
            let text_rect = Rect {
                x: rect.x + pad + c * cell_w,
                y: rect.y + pad + r * row,
                width: metrics.cell,
                height: metrics.row,
            };
            let tone = cell
                .tone
                .map(|t| collapse_tone(t, design.max_colour_thresholds));
            scene.cell_rects.push((slot, cell.id.clone(), text_rect));
            scene.items.push(Item::Text {
                rect: text_rect,
                text: cell.text.clone(),
                px: metrics.font,
                color: tone_color(tone).faded(cell.opacity_permille),
                bold: true,
                align: Align::Center,
            });
        }
        scene.items.push(Item::Text {
            rect: Rect {
                x: rect.x + pad + cols * cell_w,
                y: rect.y + pad,
                width: metrics.wide_cell,
                height: metrics.row,
            },
            text: hands_text(player.hands),
            px: metrics.font,
            color: MUTED,
            bold: false,
            align: Align::Center,
        });
        if labels && let Some(label) = &player.words.label {
            scene.items.push(Item::Text {
                rect: Rect {
                    x: rect.x + pad,
                    y: rect.y + pad + i32::try_from(rows).unwrap_or(2) * row,
                    width: rect.width.saturating_sub(2 * metrics.pad),
                    height: metrics.row,
                },
                text: label.clone(),
                px: metrics.font,
                color: MUTED,
                bold: false,
                align: Align::Center,
            });
        }
    }

    // (T4) The RNG widget, above the panels, before the legend (which
    // keeps clear of it).
    if let Some(rng) = &frame.rng {
        let mut taken = scene.panels.clone();
        taken.extend(debug_rect);
        let rect = place_rng(
            rng,
            &metrics,
            &table,
            (width, height),
            positions.get(&RNG_SLOT).copied(),
            &taken,
        );
        draw_rng(
            &mut scene,
            rng,
            &metrics,
            rect,
            positions.contains_key(&RNG_SLOT),
        );
    }

    // (R3.8) The legend: the colours the panels can show here, once there
    // are panels to read it against.
    if design.legend && !scene.seat_panels.is_empty() {
        let tones = legend_tones(&frame.legend, design.max_colour_thresholds);
        if !tones.is_empty() {
            let count = u32::try_from(tones.len()).unwrap_or(1);
            let token = metrics.row;
            let size = (2 * metrics.pad + count * token, metrics.row + metrics.pad);
            let mut taken = scene.panels.clone();
            taken.extend(debug_rect);
            match layout::place_legend(width, height, &table, size, metrics.pad, &taken) {
                Some(rect) => {
                    scene.items.push(Item::Fill {
                        rect,
                        radius: metrics.radius,
                        color: PANEL,
                    });
                    let pad = i32::try_from(metrics.pad).unwrap_or(0);
                    let step = i32::try_from(token).unwrap_or(0);
                    for (index, tone) in (0_i32..).zip(&tones) {
                        scene.items.push(Item::Text {
                            rect: Rect {
                                x: rect.x + pad + index * step,
                                y: rect.y,
                                width: token,
                                height: rect.height,
                            },
                            text: tone_sign(*tone).to_owned(),
                            px: metrics.font,
                            color: tone_color(Some(*tone)),
                            bold: true,
                            align: Align::Center,
                        });
                    }
                    scene.panels.push(rect);
                    scene.legend = Some((rect, tones));
                }
                None => scene.dropped.push("legend".to_owned()),
            }
        }
    }
    scene
}

/// (T4) The RNG widget's measures for `rng` at `metrics`, (T5 follow-up)
/// times the user's size (`scale_pct`, 50 - 200 %).
struct RngSize {
    /// The number's font size, pixels.
    big: u32,
    /// The label's font size.
    small: u32,
    /// The plate's padding, the label's row, its corner radius.
    pad: u32,
    row: u32,
    radius: u32,
    /// The plate.
    width: u32,
    height: u32,
}

fn rng_size(rng: &RngShown, metrics: &Metrics) -> RngSize {
    let pct = rng.scale_pct.clamp(
        rail_hud_ipc::settings::RNG_SCALE_MIN,
        rail_hud_ipc::settings::RNG_SCALE_MAX,
    );
    let scaled = |v: u32| (v * pct / 100).max(1);
    let big = scaled(metrics.row * 16 / 10);
    let small = scaled(metrics.font);
    let pad = scaled(metrics.pad);
    let row = scaled(metrics.row);
    let digits = rng.digits.clamp(1, 5);
    let number_w = digits * big * 62 / 100;
    let label_w = rng.label.as_ref().map_or(0, |label| {
        u32::try_from(label.chars().count()).unwrap_or(u32::MAX) * small * 56 / 100
    });
    RngSize {
        big,
        small,
        pad,
        row,
        radius: metrics.radius * 2 * pct / 100,
        width: number_w.max(label_w) + 4 * pad,
        height: big * 12 / 10 + 2 * pad + rng.label.as_ref().map_or(0, |_| row),
    }
}

/// (T4) Where the RNG widget goes: where the user put it (`wanted`, its
/// centre in thousandths; inside the client area), else the top-right
/// corner - slid down the right edge, as far as the middle of the table,
/// to the first place clear of the table's graphics and of what is
/// `taken` (the panels, the status line, the debug line); the corner
/// itself when none is.
fn place_rng(
    rng: &RngShown,
    metrics: &Metrics,
    table: &TableLayout,
    (width, height): (u32, u32),
    wanted: Option<(u32, u32)>,
    taken: &[Rect],
) -> Rect {
    let RngSize {
        width: w,
        height: h,
        ..
    } = rng_size(rng, metrics);
    if let Some(center) = wanted
        && let Some(rect) = layout::constrain(
            width,
            height,
            layout::centred_at(width, height, center, (w, h)),
            None,
        )
    {
        return rect;
    }
    let margin = i64::from(metrics.pad);
    let x = i64::from(width) - i64::from(w) - margin;
    let at = |y: i64| Rect {
        x: i32::try_from(x.max(0)).unwrap_or(0),
        y: i32::try_from(y.max(0)).unwrap_or(0),
        width: w,
        height: h,
    };
    let graphics = table.graphics(width, height);
    let step = i64::from((h / 4).max(2));
    let last = i64::from(height / 2);
    let mut y = margin;
    while y <= last {
        let candidate = at(y);
        if layout::inside(&candidate, width, height)
            && !graphics.iter().any(|g| layout::intersects(&candidate, g))
            && !taken.iter().any(|t| layout::intersects(&candidate, t))
        {
            return candidate;
        }
        y += step;
    }
    at(margin)
}

/// (T4) Paint the RNG widget at `rect`: the plate, the number, the label;
/// (T5 follow-up) all of it at the user's opacity (`opacity_pct`,
/// 30 - 100 %).
fn draw_rng(scene: &mut Scene, rng: &RngShown, metrics: &Metrics, rect: Rect, by_user: bool) {
    let RngSize {
        big,
        small,
        pad,
        row,
        radius,
        ..
    } = rng_size(rng, metrics);
    let opacity = rng.opacity_pct.clamp(
        rail_hud_ipc::settings::RNG_OPACITY_MIN,
        rail_hud_ipc::settings::RNG_OPACITY_MAX,
    ) * 10;
    let colour = readable(rng.colour).faded(opacity);
    scene.items.push(Item::Fill {
        rect,
        radius,
        color: PANEL.faded(opacity),
    });
    let label_h = rng.label.as_ref().map_or(0, |_| row);
    let number = Rect {
        x: rect.x,
        y: rect.y.saturating_add(i32::try_from(pad).unwrap_or(0)),
        width: rect.width,
        height: rect.height.saturating_sub(2 * pad + label_h),
    };
    scene.items.push(Item::Text {
        rect: number,
        text: rng.value.to_string(),
        px: big,
        color: colour,
        bold: true,
        align: Align::Center,
    });
    if let Some(label) = &rng.label {
        scene.items.push(Item::Text {
            rect: Rect {
                x: rect.x,
                y: number
                    .y
                    .saturating_add(i32::try_from(number.height).unwrap_or(0)),
                width: rect.width,
                height: label_h,
            },
            text: label.clone(),
            px: small,
            color: colour,
            bold: false,
            align: Align::Center,
        });
    }
    scene.panels.push(rect);
    if by_user {
        scene.placed_by_user.push(RNG_SLOT);
    }
    scene.rng = Some(RngDrawn {
        rect,
        value: rng.value,
        colour,
        px: big,
        label: rng.label.clone(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compliance::Compliance;
    use crate::panel::{PanelStats, StatCell};
    use crate::platform::{PanelWords, SeatPanel, Seating};

    fn cell(id: &str, text: &str, tone: Tone, opacity: u32) -> StatCell {
        StatCell {
            id: id.into(),
            text: text.into(),
            tone: Some(tone),
            opacity_permille: opacity,
        }
    }

    fn six(tone: Tone) -> Vec<StatCell> {
        PanelDesign::default()
            .stats
            .iter()
            .map(|s| cell(&s.id, "25", tone, 1000))
            .collect()
    }

    fn frame(site: &str, size: Option<u32>, seats: &[u32]) -> OverlayFrame {
        let compliance = Compliance::shipped().expect("shipped");
        OverlayFrame {
            permit: Some(compliance.permit(site).expect("permitted")),
            status: None,
            debug: None,
            size,
            seating: Seating::default(),
            panels: seats
                .iter()
                .map(|&seat| SeatPanel {
                    player: format!("P{seat}"),
                    seat: Some(seat),
                    hands: 1234,
                    stats: six(Tone::VeryHigh),
                    words: PanelWords {
                        colour: Some(TagColour::Red),
                        label: Some("fish".into()),
                        noted: true,
                    },
                })
                .collect(),
            legend: PanelStats::new(&PanelDesign::default()).legend_tones(),
            design: PanelDesign::default(),
            rng: None,
        }
    }

    fn texts(scene: &Scene) -> Vec<(&str, Rgba)> {
        scene
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Text { text, color, .. } => Some((text.as_str(), *color)),
                Item::Fill { .. } => None,
            })
            .collect()
    }

    /// (R3.9) A design's 2 x 4 grid with gaps: every panel is four slots
    /// wide and two rows tall whatever it shows, each statistic in its own
    /// slot, the empty slots blank; a statistic the stack leaves out leaves
    /// its slot blank too (nothing moves up).
    #[test]
    fn a_grid_with_gaps() {
        use crate::design::{Catalog, Cell, Presets, panel_design};
        let some = |stat: &str| {
            Some(Cell {
                stat: stat.into(),
                when: None,
            })
        };
        let mut design = Presets::shipped().get("cash").expect("cash").design.clone();
        design.columns = 4;
        design.rows = 2;
        design.cells = vec![
            some("vpip"),
            None,
            some("pfr"),
            some("three_bet"),
            None,
            some("fold_to_three_bet"),
            None,
            None,
        ];
        let panel = panel_design(&design, &Catalog::shipped());
        let mut frame = frame("acr", Some(6), &[1, 2]);
        frame.panels[1].stats.retain(|c| c.id != "pfr");
        let scene = compose(&frame, 800, 580, 1000, &panel);
        let metrics = Metrics::for_client(580, 1000);
        let (w, h) = metrics.panel_rows(4, 2);
        assert_eq!(scene.seat_panels.len(), 2, "{:?}", scene.dropped);
        for (_, rect) in &scene.seat_panels {
            assert_eq!((rect.width, rect.height), (w, h));
        }
        let pad = i32::try_from(metrics.pad).expect("pad");
        let (cell_w, row) = (
            i32::try_from(metrics.cell).expect("cell"),
            i32::try_from(metrics.row).expect("row"),
        );
        for (slot, rect) in &scene.seat_panels {
            let at = |id: &str| {
                scene
                    .cell_rects
                    .iter()
                    .find(|(s, i, _)| s == slot && i == id)
                    .map(|(_, _, r)| ((r.x - rect.x - pad) / cell_w, (r.y - rect.y - pad) / row))
            };
            assert_eq!(at("vpip"), Some((0, 0)));
            assert_eq!(at("three_bet"), Some((3, 0)));
            assert_eq!(at("fold_to_three_bet"), Some((1, 1)));
            assert_eq!(at("cbet_flop"), None, "not in the design");
            if *slot == 0 {
                assert_eq!(at("pfr"), Some((2, 0)));
            } else {
                assert_eq!(at("pfr"), None, "left out: its slot stays blank");
            }
        }
    }

    /// Six panels on a 6-max table: one per seat, each next to its seat's
    /// plate, six figures and the hand count, nothing over the table's
    /// graphics; clicks land on panels only.
    #[test]
    fn panels_at_their_seats() {
        let (w, h) = (800, 580);
        let scene = compose(
            &frame("pokerstars", Some(6), &[1, 2, 3, 4, 5, 6]),
            w,
            h,
            1000,
            &PanelDesign::default(),
        );
        assert_eq!(scene.seat_panels.len(), 6, "{:?}", scene.dropped);
        // Six panels and the legend (R3.8) take clicks.
        assert_eq!(scene.panels.len(), 7, "{:?}", scene.dropped);
        assert!(scene.dropped.is_empty());
        for (seat, rect) in (1..=6).zip(&scene.panels) {
            let plate = layout::seat_plate(w, h, layout::seat_center(6, seat).expect("seat"));
            let near = Rect {
                x: plate.x - 10,
                y: plate.y - 10,
                width: plate.width + 20,
                height: plate.height + 20,
            };
            assert!(layout::intersects(rect, &near), "seat {seat}: {rect:?}");
            for g in layout::table_graphics(w, h, 6) {
                assert!(!layout::intersects(rect, &g));
            }
        }
        let shown = texts(&scene);
        // Six figures and a hand count per panel and the legend's three
        // signs; no label, tag or note mark (PokerStars).
        assert_eq!(shown.len(), 6 * 7 + 3);
        assert_eq!(shown.iter().filter(|(t, _)| *t == "1234").count(), 6);
        assert!(!shown.iter().any(|(t, _)| *t == "fish"));
        assert!(scene.tags.is_empty() && scene.noted.is_empty());
        // The centre of the table is not the overlay's: clicks pass.
        let (cx, cy) = (
            i32::try_from(w / 2).expect("w"),
            i32::try_from(h * 540 / 1000).expect("h"),
        );
        assert!(!scene.hit(cx, cy));
        let first = scene.panels[0];
        assert!(scene.hit(
            first.x + i32::try_from(first.width / 2).expect("w"),
            first.y + 2
        ));
    }

    /// Colour by at most two thresholds whatever the band: a very high
    /// figure shows as high. Dimming follows the figure's reliability.
    #[test]
    fn colours_and_dimming() {
        let mut frame = frame("winamax", Some(2), &[1]);
        frame.panels[0].stats[0] = cell("vpip", "60", Tone::VeryHigh, 700);
        frame.panels[0].stats[1] = cell("pfr", "2", Tone::VeryLow, 1000);
        let scene = compose(&frame, 800, 580, 1000, &PanelDesign::default());
        let shown = texts(&scene);
        assert_eq!(shown[0], ("60", HIGH.faded(700)));
        assert_eq!(shown[0].1.a, 178);
        assert_eq!(shown[1], ("2", LOW));
        // Unrestricted (a design R3.9 might allow on Winamax): five tones.
        let open = PanelDesign {
            max_colour_thresholds: None,
            ..PanelDesign::default()
        };
        let scene = compose(&frame, 800, 580, 1000, &open);
        let shown = texts(&scene);
        assert_eq!(shown[0].1, VERY_HIGH.faded(700));
        assert_eq!(shown[1].1, VERY_LOW);
    }

    /// The room's restrictions bind whatever the design: labels and the
    /// third colour band are gone on PokerStars, kept on Winamax.
    #[test]
    fn the_permit_binds_the_design() {
        let loose = PanelDesign {
            max_colour_thresholds: None,
            player_labels: true,
            ..PanelDesign::default()
        };
        let stars = compose(&frame("pokerstars", Some(6), &[1]), 800, 580, 1000, &loose);
        let shown = texts(&stars);
        assert!(!shown.iter().any(|(t, _)| *t == "fish"));
        assert!(shown.iter().take(6).all(|(_, c)| *c == HIGH));
        let winamax = compose(&frame("winamax", Some(6), &[1]), 800, 580, 1000, &loose);
        let shown = texts(&winamax);
        assert!(shown.iter().any(|(t, _)| *t == "fish"));
        assert!(shown.iter().take(6).all(|(_, c)| *c == VERY_HIGH));
    }

    /// (R3.8) The player's colour tag, note mark and labels: drawn on
    /// Winamax, never on PokerStars or ACR (`noPlayerLabels`), whatever the
    /// design asks for.
    #[test]
    fn player_words_only_where_the_room_allows_labels() {
        let fills = |scene: &Scene, color: Rgba| {
            scene
                .items
                .iter()
                .filter(|item| matches!(item, Item::Fill { color: c, .. } if *c == color))
                .count()
        };
        for site in ["pokerstars", "acr"] {
            let scene = compose(
                &frame(site, Some(6), &[1, 2, 3]),
                800,
                580,
                1000,
                &PanelDesign::default(),
            );
            assert_eq!(scene.seat_panels.len(), 3, "{site}");
            assert!(scene.tags.is_empty() && scene.noted.is_empty(), "{site}");
            assert_eq!(fills(&scene, tag_color(TagColour::Red)), 0, "{site}");
            assert_eq!(fills(&scene, NOTE), 0, "{site}");
            assert!(!texts(&scene).iter().any(|(t, _)| *t == "fish"), "{site}");
        }
        let scene = compose(
            &frame("winamax", Some(6), &[1, 2, 3]),
            800,
            580,
            1000,
            &PanelDesign::default(),
        );
        let slots: Vec<u32> = scene.seat_panels.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            scene.tags.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
            slots
        );
        assert_eq!(scene.noted, slots);
        assert_eq!(fills(&scene, tag_color(TagColour::Red)), 3);
        assert_eq!(fills(&scene, NOTE), 3);
        assert_eq!(
            texts(&scene).iter().filter(|(t, _)| *t == "fish").count(),
            3
        );
        // Each tag is a bar inside its panel, left of the figures.
        for ((_, bar), (_, panel)) in scene.tags.iter().zip(&scene.seat_panels) {
            assert!(layout::intersects(bar, panel));
            assert_eq!(bar.x, panel.x);
            assert!(bar.width <= Metrics::for_client(580, 1000).pad);
        }
        // A design without words shows none on Winamax either.
        let quiet = PanelDesign {
            player_labels: false,
            ..PanelDesign::default()
        };
        let scene = compose(&frame("winamax", Some(6), &[1]), 800, 580, 1000, &quiet);
        assert!(scene.tags.is_empty() && scene.noted.is_empty());
        // Every tag colour keeps its contrast on the panel.
        for colour in [
            TagColour::Red,
            TagColour::Orange,
            TagColour::Yellow,
            TagColour::Green,
            TagColour::Blue,
            TagColour::Purple,
        ] {
            let c = tag_color(colour);
            assert!(
                u32::from(c.r) + u32::from(c.g) + u32::from(c.b) >= 3 * 120,
                "{colour:?} too dark for the panel"
            );
        }
    }

    /// (R3.8) The legend: the colours the panels can show under the room's
    /// rules - PokerStars' two thresholds: low, normal, high - in a corner
    /// clear of the table's graphics and of every panel; five with a design
    /// that has no limit where the room has none; none without panels or
    /// when the design leaves it out.
    #[test]
    fn the_legend_shows_the_thresholds_in_use() {
        let (w, h) = (800, 580);
        for site in ["pokerstars", "acr", "winamax"] {
            let scene = compose(
                &frame(site, Some(6), &[1, 2, 3, 4, 5, 6]),
                w,
                h,
                1000,
                &PanelDesign::default(),
            );
            let (rect, tones) = scene.legend.clone().expect("a legend");
            assert_eq!(tones, [Tone::Low, Tone::Normal, Tone::High], "{site}");
            let signs: Vec<(&str, Rgba)> = texts(&scene).into_iter().rev().take(3).collect();
            assert_eq!(signs, [("+", HIGH), ("=", NORMAL), ("-", LOW)], "{site}");
            for g in layout::table_graphics(w, h, 6) {
                assert!(!layout::intersects(&rect, &g), "{site}");
            }
            for (_, panel) in &scene.seat_panels {
                assert!(!layout::intersects(&rect, panel), "{site}");
            }
            assert!(layout::inside(&rect, w, h));
            assert!(scene.hit(rect.x + 1, rect.y + 1), "it takes clicks");
            assert_eq!(scene.seat_panel_at(rect.x + 1, rect.y + 1), None);
        }
        let open = PanelDesign {
            max_colour_thresholds: None,
            ..PanelDesign::default()
        };
        let stars = compose(&frame("pokerstars", Some(6), &[1]), w, h, 1000, &open);
        assert_eq!(stars.legend.expect("legend").1.len(), 3, "two thresholds");
        let winamax = compose(&frame("winamax", Some(6), &[1]), w, h, 1000, &open);
        assert_eq!(winamax.legend.expect("legend").1.len(), 5);
        let off = PanelDesign {
            legend: false,
            ..PanelDesign::default()
        };
        assert!(
            compose(&frame("winamax", Some(6), &[1]), w, h, 1000, &off)
                .legend
                .is_none()
        );
        assert!(
            compose(&frame("winamax", Some(6), &[]), w, h, 1000, &open)
                .legend
                .is_none()
        );
    }

    /// On a table too small for the panels, ACR (no covering its graphics)
    /// gets fewer panels than a room without that rule - and none of ACR's
    /// covers anything.
    #[test]
    fn acr_never_covers_the_table() {
        let seats: Vec<u32> = (1..=9).collect();
        let (w, h) = (360, 250);
        let acr = compose(
            &frame("acr", Some(9), &seats),
            w,
            h,
            2000,
            &PanelDesign::default(),
        );
        assert!(!acr.dropped.is_empty());
        for rect in &acr.panels {
            for g in layout::table_graphics(w, h, 9) {
                assert!(!layout::intersects(rect, &g), "{rect:?} covers {g:?}");
            }
        }
        let anywhere = PanelDesign {
            avoid_table_graphics: false,
            ..PanelDesign::default()
        };
        let winamax = compose(&frame("winamax", Some(9), &seats), w, h, 2000, &anywhere);
        assert!(winamax.panels.len() > acr.panels.len());
        let acr_anywhere = compose(&frame("acr", Some(9), &seats), w, h, 2000, &anywhere);
        assert_eq!(
            acr_anywhere.panels, acr.panels,
            "the rule wins over the design"
        );
    }

    /// "Waiting for first hand": one pill clear of the table, nothing else.
    #[test]
    fn waiting() {
        let mut frame = frame("pokerstars", Some(9), &[]);
        frame.status = Some(crate::engine::WAITING.to_owned());
        let scene = compose(&frame, 640, 480, 1000, &PanelDesign::default());
        assert_eq!(scene.panels.len(), 1);
        assert_eq!(texts(&scene), [(crate::engine::WAITING, NORMAL)]);
        for g in layout::table_graphics(640, 480, 9) {
            assert!(!layout::intersects(&scene.panels[0], &g));
        }
    }

    /// A player without a seat number (an app from before R3.4) has no
    /// panel; a table without a known size takes one from the seats.
    #[test]
    fn seats_and_sizes() {
        let mut frame = frame("pokerstars", None, &[8, 2]);
        frame.panels[1].seat = None;
        let scene = compose(&frame, 800, 580, 1000, &PanelDesign::default());
        assert_eq!(scene.seat_panels.len(), 1);
        assert_eq!(scene.dropped, ["P2: no seat"]);
        // Seat 8 of a 9-max layout.
        let plate = layout::seat_plate(800, 580, layout::seat_center(9, 8).expect("seat"));
        let rect = scene.panels[0];
        assert!((rect.x - plate.x).abs() < 200, "{rect:?} vs {plate:?}");
    }

    /// The hero's rotation (R3.6): with the room's client rotating, the
    /// hero's panel is at the bottom slot and every other panel by its seat
    /// around the table; without, by seat number.
    #[test]
    fn panels_follow_the_heros_rotation() {
        let (w, h) = (800, 580);
        let mut frame = frame("pokerstars", Some(6), &[1, 2, 3, 4, 5, 6]);
        let plain = compose(&frame, w, h, 1000, &PanelDesign::default());
        let slots = |scene: &Scene| {
            scene
                .seat_panels
                .iter()
                .map(|(s, _)| *s)
                .collect::<Vec<_>>()
        };
        assert_eq!(slots(&plain), [0, 1, 2, 3, 4, 5]);
        frame.seating.rotate_to = Some(4);
        let rotated = compose(&frame, w, h, 1000, &PanelDesign::default());
        assert_eq!(slots(&rotated), [3, 4, 5, 0, 1, 2]);
        let layout = TableLayout::simulator(6);
        for (seat, (slot, rect)) in (1..=6).zip(&rotated.seat_panels) {
            let drawn = rail_hud_sim::draw::seat_center(6, seat, Some(4));
            assert_eq!(layout.slot_center(*slot), Some(drawn));
            let plate = layout.plate(w, h, *slot).expect("plate");
            let near = Rect {
                x: plate.x - 10,
                y: plate.y - 10,
                width: plate.width + 20,
                height: plate.height + 20,
            };
            assert!(layout::intersects(rect, &near), "seat {seat}: {rect:?}");
        }
        // The hero's panel is the one next to the bottom plate.
        assert!(rotated.seat_panels[3].1.y > i32::try_from(h / 2).expect("h"));
    }

    /// A panel the user dragged (R3.6): centred where they left it, the
    /// others kept clear of it; inside the client area always.
    #[test]
    fn a_users_position_wins() {
        let (w, h) = (800, 580);
        let mut frame = frame("pokerstars", Some(6), &[1, 2, 3]);
        frame.seating.positions.insert(1, (500, 100));
        let scene = compose(&frame, w, h, 1000, &PanelDesign::default());
        assert_eq!(scene.placed_by_user, [1]);
        let (slot, moved) = scene.seat_panels[1];
        assert_eq!(slot, 1);
        assert_eq!(layout::center_permille(&moved, w, h).0, 500);
        assert!((i64::from(moved.y) + i64::from(moved.height) / 2 - 58).abs() <= 1);
        for (s, r) in &scene.seat_panels {
            if *s != 1 {
                assert!(!layout::intersects(r, &moved), "{s}: {r:?}");
            }
        }
        // A drag in progress overrides the stored place; past the edge it
        // is pulled in.
        let mut drag = Positions::new();
        drag.insert(1, (1000, 1000));
        let dragged = compose_with(&frame, w, h, 1000, &PanelDesign::default(), &drag);
        let r = dragged.seat_panels[1].1;
        assert!(layout::inside(&r, w, h));
        assert_eq!(
            (
                i64::from(r.x) + i64::from(r.width),
                i64::from(r.y) + i64::from(r.height)
            ),
            (i64::from(w), i64::from(h))
        );
        // A position kept for another size is not this table's.
        assert_eq!(scene.size, 6);
        let mut nine = frame.clone();
        nine.size = Some(9);
        nine.seating.positions.clear();
        assert!(
            compose(&nine, w, h, 1000, &PanelDesign::default())
                .placed_by_user
                .is_empty()
        );
    }

    /// ACR (`noOverlapTableGraphics`): a panel dragged onto the board or a
    /// seat plate goes to the nearest place clear of every graphic; on
    /// PokerStars the user may put it where they like.
    #[test]
    fn acr_keeps_a_dragged_panel_off_its_graphics() {
        let (w, h) = (800, 580);
        let graphics = layout::table_graphics(w, h, 6);
        for (site, binding) in [("acr", true), ("pokerstars", false)] {
            for target in [(500, 540), (145, 690), (500, 840)] {
                let mut frame = frame(site, Some(6), &[1, 2]);
                frame.seating.positions.insert(0, target);
                let scene = compose(&frame, w, h, 1000, &PanelDesign::default());
                assert_eq!(scene.placed_by_user, [0], "{site} {target:?}");
                let r = scene.seat_panels[0].1;
                let covers = graphics.iter().any(|g| layout::intersects(&r, g));
                assert_eq!(covers, !binding, "{site} at {target:?}: {r:?}");
                assert!(layout::inside(&r, w, h));
            }
        }
    }

    /// A hand's seat past the window's size (a table turned from 9-max to
    /// 6-max under a window that still says 6) lays out on the size that
    /// has it; a seat the room's numbering does not have is dropped.
    #[test]
    fn a_seat_past_the_size() {
        let scene = compose(
            &frame("pokerstars", Some(6), &[1, 8]),
            800,
            580,
            1000,
            &PanelDesign::default(),
        );
        assert_eq!(scene.size, 9);
        assert_eq!(scene.seat_panels.len(), 2);
        let mut numbered = frame("pokerstars", Some(6), &[1, 3]);
        let mut layout = TableLayout::simulator(6);
        layout.seat_numbers = Some(vec![1, 2, 4, 5, 7, 9]);
        numbered.seating.layout = Some(layout);
        let scene = compose(&numbered, 800, 580, 1000, &PanelDesign::default());
        assert_eq!(scene.seat_panels.len(), 1);
        assert_eq!(scene.dropped, ["seat 3: not a seat of a 6-seat table"]);
    }

    /// (T4) A roll of `value` for a pokerstars table (a test policy: no
    /// shipped room allows the RNG yet).
    fn rng(value: u32, colour: Rgba, label: Option<&str>) -> RngShown {
        RngShown {
            permit: crate::compliance::allowing_rng(&["pokerstars"])
                .rng_permit("pokerstars")
                .expect("allowed"),
            value,
            colour,
            label: label.map(str::to_owned),
            digits: 3,
            seq: 1,
            scale_pct: 100,
            opacity_pct: 100,
        }
    }

    /// (T5 follow-up) The user's size scales the whole widget - plate,
    /// number, label - around the same spot rules, and its opacity fades
    /// the plate and the number alike; 100 % of both is T4's widget.
    #[test]
    fn the_rng_widget_scales_and_fades() {
        let (w, h) = (800, 580);
        let colour = Rgba::from_hex("#c5cad3").expect("hex");
        let drawn = |scale_pct: u32, opacity_pct: u32| {
            let mut frame = frame("pokerstars", Some(6), &[1, 2, 3, 4, 5, 6]);
            frame.rng = Some(RngShown {
                scale_pct,
                opacity_pct,
                ..rng(42, colour, Some("call"))
            });
            compose(&frame, w, h, 1000, &PanelDesign::default())
        };
        let normal = drawn(100, 100);
        let base = normal.rng.as_ref().expect("drawn");
        for (pct, other) in [(200, drawn(200, 100)), (50, drawn(50, 100))] {
            let rng = other.rng.as_ref().expect("drawn");
            // Within rounding of the integer measures.
            let near = |got: u32, want: u32| got.abs_diff(want * pct / 100) <= 4;
            assert!(
                near(rng.rect.width, base.rect.width),
                "{pct} %: {:?} vs {:?}",
                rng.rect,
                base.rect
            );
            assert!(
                near(rng.rect.height, base.rect.height),
                "{pct} %: {:?} vs {:?}",
                rng.rect,
                base.rect
            );
            assert!(
                near(rng.px, base.px),
                "{pct} %: {} px vs {} px",
                rng.px,
                base.px
            );
            assert!(layout::inside(&rng.rect, w, h));
            // Still the top-right corner by default.
            let right = rng.rect.x + i32::try_from(rng.rect.width).expect("w");
            assert_eq!(
                right,
                base.rect.x + i32::try_from(base.rect.width).expect("w")
            );
        }
        // Out-of-range values (never valid settings) are held to 50 - 200 %.
        let huge = drawn(1000, 100);
        assert_eq!(
            huge.rng.as_ref().expect("drawn").rect,
            drawn(200, 100).rng.expect("drawn").rect
        );

        let plate = |scene: &Scene| {
            let rect = scene.rng.as_ref().expect("drawn").rect;
            scene
                .items
                .iter()
                .find_map(|item| match item {
                    Item::Fill { rect: r, color, .. } if *r == rect => Some(*color),
                    _ => None,
                })
                .expect("the plate")
        };
        assert_eq!(plate(&normal), PANEL);
        assert_eq!(normal.rng.as_ref().expect("drawn").colour, colour);
        let faint = drawn(100, 40);
        assert_eq!(
            plate(&faint).a,
            u8::try_from(u32::from(PANEL.a) * 40 / 100).expect("a")
        );
        let number = faint.rng.as_ref().expect("drawn");
        assert_eq!(number.colour, colour.faded(400));
        assert_eq!(number.rect, base.rect, "opacity does not move or size it");
        // Held to 30 % at least.
        assert_eq!(
            plate(&drawn(100, 0)).a,
            u8::try_from(u32::from(PANEL.a) * 30 / 100).expect("a")
        );
    }

    /// (T4) The widget's default spot: the top-right corner, inside the
    /// client area, clear of the table's graphics, the panels and the
    /// legend; one large bold number in the band's colour, the label small
    /// under it; it takes clicks.
    #[test]
    fn the_rng_widget_sits_top_right() {
        let (w, h) = (800, 580);
        let colour = Rgba::from_hex("#8b929e").expect("hex");
        let mut frame = frame("pokerstars", Some(6), &[1, 2, 3, 4, 5, 6]);
        frame.rng = Some(rng(42, colour, Some("call")));
        let scene = compose(&frame, w, h, 1000, &PanelDesign::default());
        let drawn = scene.rng.as_ref().expect("drawn");
        let metrics = Metrics::for_client(h, 1000);
        let pad = i32::try_from(metrics.pad).expect("pad");
        let right = drawn.rect.x + i32::try_from(drawn.rect.width).expect("w");
        assert_eq!(right, 800 - pad, "{:?}", drawn.rect);
        assert!(drawn.rect.y < 290, "the top half: {:?}", drawn.rect);
        assert!(layout::inside(&drawn.rect, w, h));
        for g in layout::table_graphics(w, h, 6) {
            assert!(!layout::intersects(&drawn.rect, &g), "{g:?}");
        }
        for (_, panel) in &scene.seat_panels {
            assert!(!layout::intersects(&drawn.rect, panel), "{panel:?}");
        }
        let (legend, _) = scene.legend.as_ref().expect("a legend");
        assert!(!layout::intersects(&drawn.rect, legend));
        assert_eq!(scene.seat_panels.len(), 6, "{:?}", scene.dropped);
        assert!(scene.panels.contains(&drawn.rect), "it takes clicks");
        assert!(scene.hit(drawn.rect.x + 2, drawn.rect.y + 2));
        assert_eq!(
            scene.grab_at(drawn.rect.x + 2, drawn.rect.y + 2),
            Some((RNG_SLOT, drawn.rect))
        );
        assert_eq!(scene.draggable(RNG_SLOT), Some(drawn.rect));
        assert!(!scene.placed_by_user.contains(&RNG_SLOT));
        // The number: large, bold, the band's colour; the label under it.
        let number = scene
            .items
            .iter()
            .find_map(|item| match item {
                Item::Text {
                    text,
                    px,
                    color,
                    bold,
                    rect,
                    ..
                } if text == "42" => Some((*px, *color, *bold, *rect)),
                _ => None,
            })
            .expect("the number");
        assert_eq!(number.1, colour);
        assert!(number.2);
        assert!(number.0 > metrics.font * 2, "{} px", number.0);
        assert_eq!(drawn.px, number.0);
        let label = scene
            .items
            .iter()
            .find_map(|item| match item {
                Item::Text {
                    text,
                    px,
                    rect,
                    color,
                    ..
                } if text == "call" => Some((*px, *rect, *color)),
                _ => None,
            })
            .expect("the label");
        assert!(label.0 < number.0);
        assert!(label.1.y >= number.3.y + i32::try_from(number.3.height).expect("h"));
        assert_eq!(label.2, colour);
        assert!(layout::intersects(&label.1, &drawn.rect));
        // Without a label: a shorter plate, no second line.
        frame.rng = Some(rng(42, colour, None));
        let plain = compose(&frame, w, h, 1000, &PanelDesign::default());
        let plain_rect = plain.rng.as_ref().expect("drawn").rect;
        assert!(plain_rect.height < drawn.rect.height);
        assert!(!texts(&plain).iter().any(|(t, _)| *t == "call"));
        // The plate keeps its size whatever the number.
        frame.rng = Some(rng(7, colour, None));
        let seven = compose(&frame, w, h, 1000, &PanelDesign::default());
        assert_eq!(seven.rng.as_ref().expect("drawn").rect, plain_rect);
    }

    /// (T4) The widget scales with the table (and the monitor's scale), and
    /// stays clear of the graphics and the panels on every usual client and
    /// table size.
    #[test]
    fn the_rng_widget_scales_and_stays_clear() {
        let colour = NORMAL;
        let small = {
            let mut frame = frame("pokerstars", Some(6), &[]);
            frame.rng = Some(rng(100, colour, None));
            compose(&frame, 640, 440, 1000, &PanelDesign::default())
        };
        let large = {
            let mut frame = frame("pokerstars", Some(6), &[]);
            frame.rng = Some(rng(100, colour, None));
            compose(&frame, 1600, 1160, 2000, &PanelDesign::default())
        };
        let (s, l) = (
            small.rng.as_ref().expect("small"),
            large.rng.as_ref().expect("large"),
        );
        assert!(l.px > s.px && l.rect.width > s.rect.width && l.rect.height > s.rect.height);
        for size in [2_u32, 6, 9, 10] {
            for (w, h, scale) in [(640, 440, 1000), (800, 580, 1000), (1600, 1160, 2000)] {
                let seats: Vec<u32> = (1..=size).collect();
                let mut frame = frame("pokerstars", Some(size), &seats);
                frame.rng = Some(rng(55, colour, Some("bet")));
                let scene = compose(&frame, w, h, scale, &PanelDesign::default());
                let rect = scene.rng.as_ref().expect("drawn").rect;
                assert!(layout::inside(&rect, w, h), "{size} {w}x{h}");
                for g in layout::table_graphics(w, h, size) {
                    assert!(!layout::intersects(&rect, &g), "{size} {w}x{h}: {g:?}");
                }
                for (_, panel) in &scene.seat_panels {
                    assert!(!layout::intersects(&rect, panel), "{size} {w}x{h}");
                }
            }
        }
    }

    /// (T4) Where the user dragged it (this room and size): there, inside
    /// the client area, whatever it covers.
    #[test]
    fn the_rng_widget_where_the_user_put_it() {
        let (w, h) = (800, 580);
        let mut frame = frame("pokerstars", Some(6), &[1, 2]);
        frame.rng = Some(rng(3, NORMAL, None));
        frame.seating.positions.insert(RNG_SLOT, (500, 540));
        let scene = compose(&frame, w, h, 1000, &PanelDesign::default());
        let rect = scene.rng.as_ref().expect("drawn").rect;
        let (cx, cy) = layout::center_permille(&rect, w, h);
        assert!(cx.abs_diff(500) <= 1 && cy.abs_diff(540) <= 1, "{cx} {cy}");
        assert!(scene.placed_by_user.contains(&RNG_SLOT));
        frame.seating.positions.insert(RNG_SLOT, (1000, 1000));
        let corner = compose(&frame, w, h, 1000, &PanelDesign::default());
        let rect = corner.rng.as_ref().expect("drawn").rect;
        assert!(layout::inside(&rect, w, h), "{rect:?}");
        assert_eq!(rect.x + i32::try_from(rect.width).expect("w"), 800);
    }

    /// (T4) An RNG-only frame (the room refuses a HUD, or the panels are
    /// off): the widget and nothing else - whatever else the frame says;
    /// a frame without a roll draws no widget.
    #[test]
    fn an_rng_only_frame_draws_the_rng_alone() {
        let full = frame("pokerstars", Some(6), &[1, 2, 3]);
        let mut only =
            OverlayFrame::rng_only(rng(64, NORMAL, Some("raise")), Some(6), Seating::default());
        // Whatever reaches the renderer, nothing of a HUD is drawn.
        only.panels = full.panels.clone();
        only.status = Some("waiting for first hand".into());
        only.debug = Some("latency".into());
        only.legend = full.legend.clone();
        let scene = compose(&only, 800, 580, 1000, &PanelDesign::default());
        let rect = scene.rng.as_ref().expect("drawn").rect;
        assert!(scene.seat_panels.is_empty() && scene.legend.is_none());
        assert_eq!(scene.panels, [rect]);
        assert_eq!(
            texts(&scene).iter().map(|(t, _)| *t).collect::<Vec<_>>(),
            ["64", "raise"]
        );
        assert_eq!(scene.items.len(), 3, "the plate, the number, the label");
        // A HUD frame without a roll: no widget.
        let none = compose(&full, 800, 580, 1000, &PanelDesign::default());
        assert!(none.rng.is_none());
        assert_eq!(none.draggable(RNG_SLOT), None);
        assert!(!texts(&none).iter().any(|(t, _)| *t == "64"));
    }

    /// (T4) A frame is drawn only over its room's window, and only with a
    /// permit: the HUD's, the RNG's, or both of the same room.
    #[test]
    fn a_frame_is_permitted_for_its_room() {
        let mut both = frame("pokerstars", Some(6), &[1]);
        assert_eq!(both.permitted_for("pokerstars"), Ok(()));
        assert!(both.permitted_for("winamax").is_err());
        both.rng = Some(rng(1, NORMAL, None));
        assert_eq!(both.permitted_for("pokerstars"), Ok(()));
        let mut mixed = frame("winamax", Some(6), &[1]);
        mixed.rng = both.rng.clone();
        assert!(mixed.permitted_for("winamax").is_err());
        assert!(mixed.permitted_for("pokerstars").is_err());
        let only = OverlayFrame::rng_only(rng(1, NORMAL, None), Some(6), Seating::default());
        assert_eq!(only.permitted_for("pokerstars"), Ok(()));
        assert!(only.permitted_for("ggpoker").is_err());
        let mut none = only.clone();
        none.rng = None;
        assert!(none.permitted_for("pokerstars").is_err());
    }

    /// (T4) Colours: `#rrggbb` read; a band colour too dark for the plate
    /// lifted towards white just enough, a readable one kept as it is.
    #[test]
    fn rng_colours() {
        assert_eq!(Rgba::from_hex("#5c6370"), Some(Rgba::rgb(0x5c, 0x63, 0x70)));
        for bad in ["5c6370", "#5c637", "#5c63700", "#5c637g", ""] {
            assert_eq!(Rgba::from_hex(bad), None, "{bad}");
        }
        for kept in ["#5c6370", "#8b929e", "#c5cad3", "#ff0000", "#ffffff"] {
            let colour = Rgba::from_hex(kept).expect("hex");
            assert_eq!(readable(colour), colour, "{kept}");
        }
        for dark in ["#000000", "#202020", "#0000ff", "#400000"] {
            let colour = Rgba::from_hex(dark).expect("hex");
            let lifted = readable(colour);
            assert!(
                lifted.luminance() >= MIN_RNG_LUMINANCE,
                "{dark}: {lifted:?}"
            );
            assert!(
                lifted.luminance() <= MIN_RNG_LUMINANCE + 400,
                "just enough: {dark}: {lifted:?}"
            );
            assert!(lifted.r >= colour.r && lifted.g >= colour.g && lifted.b >= colour.b);
        }
        assert_eq!(Rgba::rgb(255, 255, 255).luminance(), 65_025);
        assert_eq!(Rgba::rgb(0, 0, 0).luminance(), 0);
    }

    #[test]
    fn faded() {
        assert_eq!(NORMAL.faded(1000), NORMAL);
        assert_eq!(NORMAL.faded(600).a, 153);
        assert_eq!(PANEL.faded(500).a, 112);
        assert_eq!(NORMAL.faded(5000), NORMAL);
    }
}

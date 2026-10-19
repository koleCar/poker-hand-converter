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

#![forbid(unsafe_code)]

use rail_config::stats::Tone;

use crate::layout::{self, Metrics, Placing, Positions, TableLayout};
use crate::panel::{PanelDesign, collapse_tone, hands_text, legend_tones};
use crate::platform::{OverlayFrame, Rect, TagColour};
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
    let restrictions = frame.permit.restrictions();
    let design = design.enforce(restrictions);
    let metrics = Metrics::for_client(height, scale_permille);
    let size = seats::table_size(frame.size, frame.panels.iter().filter_map(|p| p.seat));
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

    if let Some(status) = &frame.status {
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
    if let Some(debug) = &frame.debug {
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

    let cells = frame
        .panels
        .iter()
        .map(|p| p.stats.iter().filter(|c| design.shows(&c.id)).count())
        .max()
        .unwrap_or(0);
    let cells = u32::try_from(cells).unwrap_or(u32::MAX);
    // R3.4's panel: two rows of figures. (R3.9) A design's: its columns
    // (fewer when it shows fewer cells), as many rows as the cells take.
    let (columns, rows) = match design.columns {
        None => (cells.div_ceil(2), 2),
        Some(columns) => {
            let columns = columns
                .clamp(1, crate::design::MAX_COLUMNS)
                .min(cells.max(1));
            (columns, cells.div_ceil(columns).max(1))
        }
    };
    let labels = design.player_labels && frame.panels.iter().any(|p| p.words.label.is_some());
    let panel = metrics.panel_rows(columns, rows + u32::from(labels));

    // Each seated player's slot: the room's layout, the hero's rotation.
    let slot_of = |seat: u32| seats::slot_of(&table, seat, frame.seating.rotate_to);
    let slots: Vec<u32> = frame
        .panels
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

    for player in &frame.panels {
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
        for (index, cell) in (0_i32..).zip(&cells) {
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
            permit: compliance.permit(site).expect("permitted"),
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

    #[test]
    fn faded() {
        assert_eq!(NORMAL.faded(1000), NORMAL);
        assert_eq!(NORMAL.faded(600).a, 153);
        assert_eq!(PANEL.faded(500).a, 112);
        assert_eq!(NORMAL.faded(5000), NORMAL);
    }
}

//! An overlay frame turned into what to paint (R3.4): filled rounded
//! rectangles and lines of text at physical pixels of the table's client
//! area, with their colours. Platform-free, so every OS tests it; the
//! Windows backend paints a [`Scene`] with Direct2D and DirectWrite, macOS
//! (R3.12) will with Core Graphics.
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

#![forbid(unsafe_code)]

use rail_config::stats::Tone;

use crate::layout::{self, Metrics};
use crate::panel::{PanelDesign, collapse_tone, hands_text};
use crate::platform::{OverlayFrame, Rect};

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
    /// Seats whose panel was dropped (no room clear of the table's
    /// graphics, or no seat number), for the diagnostics.
    pub dropped: Vec<String>,
}

impl Scene {
    /// Whether a point (client-relative) is on a panel.
    pub fn hit(&self, x: i32, y: i32) -> bool {
        self.panels.iter().any(|r| layout::contains(r, x, y))
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
    let design = design.enforce(frame.permit.restrictions());
    let metrics = Metrics::for_client(height, scale_permille);
    let mut scene = Scene {
        width,
        height,
        ..Scene::default()
    };
    let size = layout::size_for(frame.size, frame.panels.iter().filter_map(|p| p.seat));

    if let Some(status) = &frame.status {
        let chars = u32::try_from(status.chars().count()).unwrap_or(u32::MAX);
        let pill = metrics.pill_size(chars);
        if let Some(rect) =
            layout::place_status(width, height, size, pill, design.avoid_table_graphics)
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

    let columns = frame
        .panels
        .iter()
        .map(|p| p.stats.iter().filter(|c| design.shows(&c.id)).count())
        .max()
        .unwrap_or(0);
    let columns = u32::try_from(columns.div_ceil(2)).unwrap_or(1);
    let labels = design.player_labels && frame.panels.iter().any(|p| p.label.is_some());
    let panel = metrics.panel_size(columns, u32::from(labels));
    let seated: Vec<u32> = frame.panels.iter().filter_map(|p| p.seat).collect();
    let placed = layout::place_panels(
        width,
        height,
        size,
        &seated,
        panel,
        metrics.gap,
        design.avoid_table_graphics,
    );
    for player in &frame.panels {
        let Some(seat) = player.seat else {
            scene.dropped.push(format!("{}: no seat", player.player));
            continue;
        };
        let Some(rect) = placed
            .iter()
            .find(|(s, _)| *s == seat)
            .and_then(|(_, r)| *r)
        else {
            scene.dropped.push(format!("seat {seat}"));
            continue;
        };
        scene.items.push(Item::Fill {
            rect,
            radius: metrics.radius,
            color: PANEL,
        });
        scene.panels.push(rect);
        let cells: Vec<_> = player
            .stats
            .iter()
            .filter(|c| design.shows(&c.id))
            .collect();
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
        if labels && let Some(label) = &player.label {
            scene.items.push(Item::Text {
                rect: Rect {
                    x: rect.x + pad,
                    y: rect.y + pad + 2 * row,
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
    scene
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compliance::Compliance;
    use crate::panel::StatCell;
    use crate::platform::SeatPanel;

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
            size,
            panels: seats
                .iter()
                .map(|&seat| SeatPanel {
                    player: format!("P{seat}"),
                    seat: Some(seat),
                    hands: 1234,
                    stats: six(Tone::VeryHigh),
                    label: Some("fish".into()),
                })
                .collect(),
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
        assert_eq!(scene.panels.len(), 6, "{:?}", scene.dropped);
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
        // Six figures and a hand count per panel; no label (PokerStars).
        assert_eq!(shown.len(), 6 * 7);
        assert_eq!(shown.iter().filter(|(t, _)| *t == "1234").count(), 6);
        assert!(!shown.iter().any(|(t, _)| *t == "fish"));
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
        assert_eq!(scene.panels.len(), 1);
        assert_eq!(scene.dropped, ["P2: no seat"]);
        // Seat 8 of a 9-max layout.
        let plate = layout::seat_plate(800, 580, layout::seat_center(9, 8).expect("seat"));
        let rect = scene.panels[0];
        assert!((rect.x - plate.x).abs() < 200, "{rect:?} vs {plate:?}");
    }

    #[test]
    fn faded() {
        assert_eq!(NORMAL.faded(1000), NORMAL);
        assert_eq!(NORMAL.faded(600).a, 153);
        assert_eq!(PANEL.faded(500).a, 112);
        assert_eq!(NORMAL.faded(5000), NORMAL);
    }
}

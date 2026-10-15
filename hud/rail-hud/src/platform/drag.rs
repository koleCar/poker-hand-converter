//! Dragging a seat's panel (R3.6), the platform-free half: what a press,
//! a move and a release on an overlay mean. The Windows overlay thread
//! feeds it its mouse messages (macOS, R3.12, will feed it its events);
//! every OS tests it.
//!
//! - A **press** on a seat's panel (the scene's `seat_panels`, its last
//!   painted layout) starts a drag of that slot; anywhere else the overlay
//!   is click-through and never sees it.
//! - A **move** with the button down, once past a few pixels
//!   ([`threshold`]: a click stays a click, R3.8's popup), puts the panel's
//!   centre where the pointer took it - in thousandths of the client area,
//!   the unit the store keeps. Where it may really go (inside the client
//!   area; on a room that forbids covering its table graphics, ACR, the
//!   nearest place clear of them) is the scene's to say
//!   (`crate::scene::compose_with` constrains it), so the panel on the
//!   screen is always somewhere it may be, during the drag too.
//! - A **release** (or the overlay losing the mouse capture) ends it: the
//!   panel stays where the last painted scene shows it, and the engine is
//!   told ([`super::TableEvent::PanelMoved`]); a press that never moved is
//!   a click.
//!
//! Nothing here touches the store or blocks: the overlay thread runs the
//! hooks (R3.5) and must never wait.

#![forbid(unsafe_code)]

use super::Rect;
use crate::layout;
use crate::scene::Scene;

/// How far the pointer must move (physical pixels) before a press on a
/// panel is a drag: Windows' own `SM_CXDRAG` (4 px at 100 %) at the
/// monitor's scale.
pub fn threshold(scale_permille: u32) -> i32 {
    i32::try_from((4 * u64::from(scale_permille.max(1000))).div_ceil(1000)).unwrap_or(4)
}

/// A press on a seat's panel, followed until the release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Drag {
    /// The panel's slot (the visual seat).
    pub slot: u32,
    /// Where the button went down, client pixels.
    pub from: (i32, i32),
    /// The panel at the press, client pixels.
    pub panel: Rect,
    /// Where the pointer has taken the panel's centre (thousandths of the
    /// client area); `None` until it moved past the threshold.
    pub at: Option<(u32, u32)>,
}

impl Drag {
    /// A press at (`x`, `y`): a drag when it is on a seat's panel.
    pub fn press(scene: &Scene, x: i32, y: i32) -> Option<Self> {
        let (slot, panel) = scene.seat_panel_at(x, y)?;
        Some(Self {
            slot,
            from: (x, y),
            panel,
            at: None,
        })
    }

    /// The pointer at (`x`, `y`) with the button down over a `width` x
    /// `height` client area: the panel's wanted centre once the move is a
    /// drag (`None` while it is still within `threshold` of the press).
    pub fn moved(
        &mut self,
        x: i32,
        y: i32,
        threshold: i32,
        width: u32,
        height: u32,
    ) -> Option<(u32, u32)> {
        let (dx, dy) = (
            i64::from(x) - i64::from(self.from.0),
            i64::from(y) - i64::from(self.from.1),
        );
        let reach = i64::from(threshold);
        if self.at.is_none() && dx.abs() <= reach && dy.abs() <= reach {
            return None;
        }
        let moved = Rect {
            x: i32::try_from(i64::from(self.panel.x) + dx).unwrap_or(self.panel.x),
            y: i32::try_from(i64::from(self.panel.y) + dy).unwrap_or(self.panel.y),
            ..self.panel
        };
        let at = layout::center_permille(&moved, width, height);
        self.at = Some(at);
        Some(at)
    }

    /// The release, against the scene painted with the drag: where the
    /// panel ended up (its centre, thousandths) when it was dragged and the
    /// scene placed it where the user wanted (`None`: a click, or no place
    /// it may go - it goes back).
    pub fn release(&self, scene: &Scene) -> Option<(u32, u32)> {
        self.at?;
        if !scene.placed_by_user.contains(&self.slot) {
            return None;
        }
        let (_, rect) = scene
            .seat_panels
            .iter()
            .find(|(slot, _)| *slot == self.slot)?;
        Some(layout::center_permille(rect, scene.width, scene.height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compliance::Compliance;
    use crate::layout::{Positions, table_graphics};
    use crate::panel::{PanelDesign, StatCell};
    use crate::platform::{OverlayFrame, SeatPanel, Seating};
    use crate::scene::{compose, compose_with};

    fn frame(site: &str, seats: &[u32]) -> OverlayFrame {
        let compliance = Compliance::shipped().expect("shipped");
        OverlayFrame {
            permit: compliance.permit(site).expect("permitted"),
            status: None,
            size: Some(6),
            seating: Seating::default(),
            panels: seats
                .iter()
                .map(|&seat| SeatPanel {
                    player: format!("P{seat}"),
                    seat: Some(seat),
                    hands: 10,
                    stats: PanelDesign::default()
                        .stats
                        .iter()
                        .map(|s| StatCell {
                            id: s.id.clone(),
                            text: "20".into(),
                            tone: None,
                            opacity_permille: 1000,
                        })
                        .collect(),
                    label: None,
                })
                .collect(),
        }
    }

    fn middle(r: &Rect) -> (i32, i32) {
        (
            r.x + i32::try_from(r.width / 2).unwrap_or(0),
            r.y + i32::try_from(r.height / 2).unwrap_or(0),
        )
    }

    /// Press on a panel, move past the threshold, release: the panel is
    /// where the pointer took it, and that is what is kept.
    #[test]
    fn a_drag_moves_the_panel() {
        let (w, h) = (800, 580);
        let frame = frame("pokerstars", &[1, 2, 3]);
        let design = PanelDesign::default();
        let scene = compose(&frame, w, h, 1000, &design);
        let (slot, panel) = scene.seat_panels[1];
        let (px, py) = middle(&panel);
        assert_eq!(Drag::press(&scene, 1, 1), None, "not on a panel");
        let mut drag = Drag::press(&scene, px, py).expect("on a panel");
        assert_eq!(drag.slot, slot);
        assert_eq!(
            drag.moved(px + 3, py - 2, threshold(1000), w, h),
            None,
            "a click so far"
        );
        let at = drag
            .moved(px + 120, py + 40, threshold(1000), w, h)
            .expect("a drag");
        let mut overrides = Positions::new();
        overrides.insert(slot, at);
        let dragged = compose_with(&frame, w, h, 1000, &design, &overrides);
        let kept = drag.release(&dragged).expect("kept");
        let moved = dragged.seat_panels[1].1;
        // Thousandths of the client area: within a pixel.
        assert!((moved.x - panel.x - 120).abs() <= 1, "{moved:?}");
        assert!((moved.y - panel.y - 40).abs() <= 1, "{moved:?}");
        assert_eq!(kept, layout::center_permille(&moved, w, h));
        // Back at the threshold after moving is still a drag.
        assert!(drag.moved(px, py, threshold(1000), w, h).is_some());
    }

    /// A press that never moved is a click: nothing is kept.
    #[test]
    fn a_click_is_not_a_drag() {
        let frame = frame("pokerstars", &[1]);
        let scene = compose(&frame, 800, 580, 1000, &PanelDesign::default());
        let (x, y) = middle(&scene.seat_panels[0].1);
        let drag = Drag::press(&scene, x, y).expect("on a panel");
        assert_eq!(drag.release(&scene), None);
        assert_eq!(threshold(1000), 4);
        assert_eq!(threshold(1500), 6);
        assert_eq!(threshold(0), 4);
    }

    /// ACR: dragged onto the board, the panel shows (and is kept) at the
    /// nearest place clear of the table graphics; on PokerStars where it
    /// was dropped.
    #[test]
    fn acr_drops_clear_of_its_graphics() {
        let (w, h) = (800, 580);
        let graphics = table_graphics(w, h, 6);
        for (site, clear) in [("acr", true), ("pokerstars", false)] {
            let frame = frame(site, &[1, 2]);
            let design = PanelDesign::default();
            let scene = compose(&frame, w, h, 1000, &design);
            let (slot, panel) = scene.seat_panels[0];
            let (px, py) = middle(&panel);
            let mut drag = Drag::press(&scene, px, py).expect("on a panel");
            // To the table's centre: the board.
            let (cx, cy) = (400, i32::try_from(h * 540 / 1000).unwrap_or(0));
            let at = drag.moved(cx, cy, threshold(1000), w, h).expect("a drag");
            let mut overrides = Positions::new();
            overrides.insert(slot, at);
            let dragged = compose_with(&frame, w, h, 1000, &design, &overrides);
            let kept = drag.release(&dragged).expect("kept");
            let rect = dragged.seat_panels[0].1;
            let covers = graphics.iter().any(|g| layout::intersects(&rect, g));
            assert_eq!(covers, !clear, "{site}: {rect:?}");
            assert_eq!(kept, layout::center_permille(&rect, w, h));
        }
    }
}

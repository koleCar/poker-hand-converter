//! Following a table window (docs/RAIL-PLAN.md R3.5): the platform-free
//! half of the Windows hooks - and, since R3.13, of the macOS
//! accessibility observers (`macos::AxNote` maps their notifications onto
//! the same [`Observed`], [`events`] and [`plan`]) - so every system's
//! `cargo test` checks it.
//!
//! - [`classify`]: which WinEvents the hooks take - the window object only
//!   (`OBJID_WINDOW`, `CHILDID_SELF`), never a caret, a scroll bar or a
//!   child control's object.
//! - [`Geometry`], [`Placed`] and [`plan`]: what an overlay does when its
//!   table changes - a move is a move (no repaint), a new client size or a
//!   new scale (the table went to a monitor of another dpi, or the
//!   monitor's scale changed) is a repaint at that size and scale, a
//!   minimised or cloaked table hides it.
//! - [`Beneath`], [`stacking`] and [`Restack`]: whether an overlay is
//!   directly above its table in the z-order, and why the overlay thread
//!   looked (Windows: shown, the table's events, the table in the
//!   foreground, the 250 ms look - [`RESTACK_LOOK`]).
//! - [`Observed`] and [`events`]: what the hook thread saw, turned into the
//!   engine's [`TableEvent`]s - **coalesced per window** (a drag's hundred
//!   locations are one `Moved` with the last one: the overlay itself has
//!   followed every one of them already, on its own thread; this is the
//!   data side, which only needs the latest), a new title read through the
//!   room's own matcher ([`TableMatcher::matches`], so `Retitled.table` is
//!   the hands' [`super::table_key`]), a title that is no longer one of the
//!   room's tables and a destroyed or hidden window as `Closed` (what the
//!   re-find every 500 ms would conclude too), and a window shown by a
//!   followed process as [`TableEvent::Appeared`] (look for tables now).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use super::{Rect, TableEvent, TableMatcher, TableWindow, WindowId, dpi_permille};

/// The WinEvent numbers (`WinUser.h`) the hooks take; the Windows backend
/// checks them against the `windows` crate's in a test.
pub mod win_event {
    pub const SYSTEM_FOREGROUND: u32 = 0x0003;
    pub const SYSTEM_MOVESIZESTART: u32 = 0x000A;
    pub const SYSTEM_MOVESIZEEND: u32 = 0x000B;
    pub const SYSTEM_MINIMIZESTART: u32 = 0x0016;
    pub const SYSTEM_MINIMIZEEND: u32 = 0x0017;
    pub const OBJECT_DESTROY: u32 = 0x8001;
    pub const OBJECT_SHOW: u32 = 0x8002;
    pub const OBJECT_HIDE: u32 = 0x8003;
    pub const OBJECT_LOCATIONCHANGE: u32 = 0x800B;
    pub const OBJECT_NAMECHANGE: u32 = 0x800C;
    pub const OBJECT_CLOAKED: u32 = 0x8017;
    pub const OBJECT_UNCLOAKED: u32 = 0x8018;
    /// `idObject` of an event about the window itself.
    pub const OBJID_WINDOW: i32 = 0;
    /// `idChild` of an event about the object itself.
    pub const CHILDID_SELF: i32 = 0;

    /// The event ranges hooked per poker process, one `SetWinEventHook`
    /// each: exactly the events above and nothing between them (a range
    /// `SYSTEM_FOREGROUND ..= SYSTEM_MINIMIZEEND` would also bring every
    /// menu, capture, dialog and scroll event of the client).
    pub const RANGES: [(u32, u32); 6] = [
        (SYSTEM_FOREGROUND, SYSTEM_FOREGROUND),
        (SYSTEM_MOVESIZESTART, SYSTEM_MOVESIZEEND),
        (SYSTEM_MINIMIZESTART, SYSTEM_MINIMIZEEND),
        (OBJECT_DESTROY, OBJECT_HIDE),
        (OBJECT_LOCATIONCHANGE, OBJECT_NAMECHANGE),
        (OBJECT_CLOAKED, OBJECT_UNCLOAKED),
    ];
}

/// A hooked event about a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hooked {
    /// It became the foreground window (z-order sanity: its overlay must
    /// still be directly above it).
    Foreground,
    MoveSizeStart,
    MoveSizeEnd,
    /// About to be minimised: hidden from now on, although `IsIconic` may
    /// not say so yet.
    MinimizeStart,
    /// Restored from minimised.
    MinimizeEnd,
    Destroyed,
    Shown,
    Hidden,
    /// Moved or resized (also when it changes monitor).
    Location,
    /// Its title changed (a tournament table move).
    Name,
    Cloaked,
    Uncloaked,
}

impl Hooked {
    /// Whether the window's geometry or visibility must be read again.
    pub fn moves(self) -> bool {
        !matches!(self, Self::Name | Self::Destroyed)
    }
}

/// The event as the hooks take it, `None` for everything else - events
/// about an object other than the window itself (`idObject` not
/// `OBJID_WINDOW`: a caret, a cursor, a scroll bar; `idChild` not
/// `CHILDID_SELF`: one of its parts) or not hooked.
pub fn classify(event: u32, object: i32, child: i32) -> Option<Hooked> {
    use win_event as e;
    if object != e::OBJID_WINDOW || child != e::CHILDID_SELF {
        return None;
    }
    Some(match event {
        e::SYSTEM_FOREGROUND => Hooked::Foreground,
        e::SYSTEM_MOVESIZESTART => Hooked::MoveSizeStart,
        e::SYSTEM_MOVESIZEEND => Hooked::MoveSizeEnd,
        e::SYSTEM_MINIMIZESTART => Hooked::MinimizeStart,
        e::SYSTEM_MINIMIZEEND => Hooked::MinimizeEnd,
        e::OBJECT_DESTROY => Hooked::Destroyed,
        e::OBJECT_SHOW => Hooked::Shown,
        e::OBJECT_HIDE => Hooked::Hidden,
        e::OBJECT_LOCATIONCHANGE => Hooked::Location,
        e::OBJECT_NAMECHANGE => Hooked::Name,
        e::OBJECT_CLOAKED => Hooked::Cloaked,
        e::OBJECT_UNCLOAKED => Hooked::Uncloaked,
        _ => return None,
    })
}

/// The scale an overlay draws at, in thousandths: the monitor's effective
/// dpi, else the window's own (R3.3: a client that is not per-monitor
/// aware says 96 for itself while Windows stretches it to the monitor's).
pub fn scale_of(monitor_dpi: u32, window_dpi: u32) -> u32 {
    dpi_permille(if monitor_dpi == 0 {
        window_dpi
    } else {
        monitor_dpi
    })
}

/// Where and how a table is, read from the system: what its overlay
/// covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Geometry {
    /// The client area, physical screen pixels (empty while minimised,
    /// as the find reports it).
    pub client: Rect,
    pub scale_permille: u32,
    /// Minimised, being minimised, or cloaked.
    pub hidden: bool,
}

impl Geometry {
    /// Whether an overlay shows over it.
    pub fn shows(&self) -> bool {
        !self.hidden && self.client.width > 0 && self.client.height > 0
    }

    /// The size an overlay is painted at.
    pub fn size(&self) -> (u32, u32, u32) {
        (self.client.width, self.client.height, self.scale_permille)
    }
}

/// Where an overlay is now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Placed {
    pub shown: bool,
    /// Its screen origin.
    pub at: (i32, i32),
    /// The client size and scale it was last painted at.
    pub painted: Option<(u32, u32, u32)>,
}

/// What an overlay does to match its table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Nothing changed.
    Keep,
    /// The table is minimised, cloaked or has no client area.
    Hide,
    /// Paint again (and show) - a new frame, a new client size or a new
    /// scale: the table was resized, moved to a monitor of another dpi,
    /// or its monitor's scale changed.
    Paint,
    /// Only the position changed: move (and show), no repaint.
    Move,
    /// Shown again where it was, as it was.
    Show,
}

/// What an overlay `placed` so does when its table is `now`; `dirty`: it
/// has a new frame.
pub fn plan(placed: &Placed, now: &Geometry, dirty: bool) -> Plan {
    if !now.shows() {
        return if placed.shown { Plan::Hide } else { Plan::Keep };
    }
    if dirty || placed.painted != Some(now.size()) {
        Plan::Paint
    } else if placed.at != (now.client.x, now.client.y) {
        Plan::Move
    } else if placed.shown {
        Plan::Keep
    } else {
        Plan::Show
    }
}

/// How often the overlay thread checks every shown overlay's place in the
/// z-order (Windows): the safety net for a change no event told it about.
pub const RESTACK_LOOK: std::time::Duration = std::time::Duration::from_millis(250);

/// How many z-order walk steps are taken before giving up (the order can
/// change during the walk).
pub const STACKING_WALK: usize = 8192;

/// A window met walking down the z-order from an overlay (Windows,
/// `GW_HWNDNEXT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Beneath {
    /// The overlay's table.
    Table,
    /// Nothing that shows between them: hidden, cloaked or empty, or owned
    /// by the table itself (the client's own dialogs, another program's
    /// overlay). Windows keeps every window the table owns above it, in
    /// any order among themselves, so an overlay never fights them.
    Passable,
    /// Something else that shows: the overlay would draw over it.
    Other,
}

/// Where an overlay is in the z-order against its table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stacking {
    /// Directly above it: nothing but passable windows between.
    Directly,
    /// Above it, but over this many other windows that are above the
    /// table: it draws over them.
    Covering(usize),
    /// Not above it (the walk down from the overlay never met the table):
    /// the table hides it.
    Below,
}

impl Stacking {
    /// Whether the overlay must be put back directly above its table.
    pub fn needs_restack(self) -> bool {
        self != Self::Directly
    }
}

impl std::fmt::Display for Stacking {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Directly => f.write_str("directly above its table"),
            Self::Covering(n) => write!(f, "above its table over {n} other window(s)"),
            Self::Below => f.write_str("below its table"),
        }
    }
}

/// Where an overlay is, from the windows below it in z-order (nearest
/// first, as [`Beneath`]): the first non-passable window decides whether
/// it is directly above; other windows met before the table are counted.
/// The walk stops at the table, so an overlay in place costs one step.
pub fn stacking(beneath: impl IntoIterator<Item = Beneath>) -> Stacking {
    let mut others = 0;
    for window in beneath {
        match window {
            Beneath::Table if others == 0 => return Stacking::Directly,
            Beneath::Table => return Stacking::Covering(others),
            Beneath::Passable => {}
            Beneath::Other => others += 1,
        }
    }
    Stacking::Below
}

/// Why the overlay thread looked at an overlay's place in the z-order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restack {
    /// The overlay was just shown (first paint, or after a hide): Windows
    /// puts a window shown without activation where its own rules say -
    /// behind the foreground window when another process has the
    /// foreground - not above its owner.
    Shown,
    /// The table came to the foreground.
    Foreground,
    /// The table moved, was shown, restored or uncloaked.
    Event,
    /// The periodic look ([`RESTACK_LOOK`]).
    Look,
}

impl std::fmt::Display for Restack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Shown => "shown",
            Self::Foreground => "foreground",
            Self::Event => "table event",
            Self::Look => "look",
        })
    }
}

/// Whether the `n`th restack of one overlay (1-based) is written to
/// stderr: the first twenty, then every hundredth - a window that keeps
/// pushing in between must not flood the log.
pub fn logs_restack(n: u64) -> bool {
    n <= 20 || n.is_multiple_of(100)
}

/// What the hooks saw of one window since the last poll: only the latest
/// of each kind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    pub geometry: Option<Geometry>,
    pub title: Option<String>,
    /// Destroyed, or hidden (`SW_HIDE`): no longer a visible top-level
    /// window, which the find does not list either.
    pub gone: bool,
}

/// What the hook thread saw since the last poll, coalesced per window, so
/// it stays small however many events arrive between two polls.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observed {
    pub tables: BTreeMap<WindowId, Seen>,
    /// A top-level window of a followed process was shown.
    pub appeared: bool,
    /// Panels the user dropped somewhere (R3.6) or clicked (R3.8), in
    /// order: every one is the user's decision, none is coalesced away.
    pub dragged: Vec<TableEvent>,
}

impl Observed {
    /// The user dropped a panel (a [`TableEvent::PanelMoved`]).
    pub fn dragged(&mut self, event: TableEvent) {
        self.dragged.push(event);
    }

    /// (R3.8) The user clicked a panel (a [`TableEvent::PanelClicked`]).
    pub fn clicked(&mut self, event: TableEvent) {
        self.dragged.push(event);
    }

    pub fn geometry(&mut self, id: WindowId, geometry: Geometry) {
        self.tables.entry(id).or_default().geometry = Some(geometry);
    }

    pub fn title(&mut self, id: WindowId, title: String) {
        self.tables.entry(id).or_default().title = Some(title);
    }

    pub fn gone(&mut self, id: WindowId) {
        self.tables.entry(id).or_default().gone = true;
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty() && !self.appeared && self.dragged.is_empty()
    }

    /// (R3.13) Take in what another observer saw meanwhile (macOS: the
    /// accessibility observers' thread beside the AppKit thread's clicks):
    /// `later`'s geometry and title replace this one's (it is the newer
    /// look), a window gone in either is gone, `appeared` in either
    /// counts, drags and clicks are kept in order after this one's.
    pub fn absorb(&mut self, later: Observed) {
        for (id, seen) in later.tables {
            let mine = self.tables.entry(id).or_default();
            if seen.geometry.is_some() {
                mine.geometry = seen.geometry;
            }
            if seen.title.is_some() {
                mine.title = seen.title;
            }
            mine.gone |= seen.gone;
        }
        self.appeared |= later.appeared;
        self.dragged.extend(later.dragged);
    }
}

/// The engine's events from what the hooks saw: at most one `Moved`,
/// `Minimized` and `Retitled` per window (its latest state against what
/// the engine was last told, `tracked`, which is brought up to date), or
/// one `Closed`. A new title goes through the matchers of the window's
/// room; when none takes it any more the window is no longer a table and
/// is closed (the find would not offer it either). Windows not tracked
/// are skipped; a closed one leaves `tracked`.
pub fn events(
    observed: Observed,
    tracked: &mut BTreeMap<WindowId, TableWindow>,
    matchers: &[TableMatcher],
) -> Vec<TableEvent> {
    let mut out = Vec::new();
    for (id, seen) in observed.tables {
        let Some(window) = tracked.get_mut(&id) else {
            continue;
        };
        if seen.gone {
            out.push(TableEvent::Closed { id });
            tracked.remove(&id);
            continue;
        }
        if let Some(title) = seen.title.filter(|t| *t != window.title) {
            let found = matchers
                .iter()
                .filter(|m| m.site == window.site)
                .find_map(|m| m.matches(&window.process.name, &title));
            let Some(found) = found else {
                out.push(TableEvent::Closed { id });
                tracked.remove(&id);
                continue;
            };
            window.title.clone_from(&title);
            window.table.clone_from(&found.table);
            if found.seats.is_some() {
                window.size = found.seats;
            }
            out.push(TableEvent::Retitled {
                id,
                title,
                table: found.table,
            });
        }
        if let Some(g) = seen.geometry {
            if window.client != g.client || window.scale_permille != g.scale_permille {
                window.client = g.client;
                window.scale_permille = g.scale_permille;
                out.push(TableEvent::Moved {
                    id,
                    client: g.client,
                    scale_permille: g.scale_permille,
                });
            }
            if window.minimized != g.hidden {
                window.minimized = g.hidden;
                out.push(TableEvent::Minimized {
                    id,
                    minimized: g.hidden,
                });
            }
        }
    }
    if observed.appeared {
        out.push(TableEvent::Appeared);
    }
    // Drags and clicks of tables the engine still follows, after their
    // table's own events (a table closed meanwhile takes them with it).
    out.extend(observed.dragged.into_iter().filter(|event| {
        matches!(
            event,
            TableEvent::PanelMoved { id, .. } | TableEvent::PanelClicked { id, .. }
                if tracked.contains_key(id)
        )
    }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::ProcessInfo;
    use regex::Regex;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn at(client: Rect, scale: u32) -> Geometry {
        Geometry {
            client,
            scale_permille: scale,
            hidden: false,
        }
    }

    fn window(id: u64, title: &str, table: &str) -> TableWindow {
        TableWindow {
            id: WindowId(id),
            site: "pokerstars".into(),
            process: ProcessInfo {
                pid: Some(40),
                name: "rail-hud-sim.exe".into(),
            },
            title: title.into(),
            table: Some(table.into()),
            size: Some(6),
            client: rect(100, 100, 640, 480),
            scale_permille: 1000,
            minimized: false,
        }
    }

    fn matchers() -> Vec<TableMatcher> {
        vec![
            TableMatcher::simulator(
                "winamax",
                Regex::new(r"^(?P<table>.+?) / (?P<seats>\d+)$").expect("regex"),
            ),
            TableMatcher::simulator(
                "pokerstars",
                Regex::new(r"^(?P<table>.+?) - .*?(?:(?P<seats>\d+)-max)?$").expect("regex"),
            ),
        ]
    }

    /// The window object's events only, each hooked one, nothing between.
    #[test]
    fn only_the_window_objects_events() {
        use win_event as e;
        assert_eq!(
            classify(e::OBJECT_LOCATIONCHANGE, 0, 0),
            Some(Hooked::Location)
        );
        // A caret (OBJID_CARET = -8), the cursor (-9), a child element.
        assert_eq!(classify(e::OBJECT_LOCATIONCHANGE, -8, 0), None);
        assert_eq!(classify(e::OBJECT_LOCATIONCHANGE, -9, 0), None);
        assert_eq!(classify(e::OBJECT_NAMECHANGE, 0, 3), None);
        assert_eq!(classify(e::OBJECT_NAMECHANGE, 0, 0), Some(Hooked::Name));
        // EVENT_OBJECT_CREATE, EVENT_OBJECT_REORDER, EVENT_SYSTEM_MENUSTART.
        for other in [0x8000, 0x8004, 0x0004] {
            assert_eq!(classify(other, 0, 0), None, "{other:#x}");
        }
        // Every hooked range is exactly hooked events.
        let mut hooked = 0;
        for (min, max) in e::RANGES {
            assert!(min <= max);
            for event in min..=max {
                assert!(classify(event, 0, 0).is_some(), "{event:#x}");
                hooked += 1;
            }
        }
        assert_eq!(hooked, 12, "the twelve events of R3.5");
        assert!(!Hooked::Name.moves() && !Hooked::Destroyed.moves());
        assert!(Hooked::Location.moves() && Hooked::Foreground.moves());
    }

    /// An overlay is in place only directly above its table: hidden, empty
    /// or cloaked windows and the table's own owned windows between them
    /// do not count, anything else that shows does; never meeting the
    /// table is below it. The walk stops at the table or the end.
    #[test]
    fn where_an_overlay_stacks() {
        use Beneath::{Other, Passable, Table};
        assert_eq!(stacking([Table]), Stacking::Directly);
        assert_eq!(stacking([Passable, Passable, Table]), Stacking::Directly);
        assert_eq!(stacking([Other, Table]), Stacking::Covering(1));
        assert_eq!(
            stacking([Passable, Other, Passable, Other, Table]),
            Stacking::Covering(2)
        );
        // The CI failure (#255): the overlay at the bottom of the z-order,
        // under the runner's terminal, its table far above it.
        assert_eq!(stacking([Other, Passable, Passable]), Stacking::Below);
        assert_eq!(stacking([]), Stacking::Below);
        // What comes after the table is never read.
        let mut read = 0;
        let walk = [Table, Other, Other].into_iter().inspect(|_| read += 1);
        assert_eq!(stacking(walk), Stacking::Directly);
        assert_eq!(read, 1);
        assert!(!Stacking::Directly.needs_restack());
        assert!(Stacking::Covering(1).needs_restack());
        assert!(Stacking::Below.needs_restack());
        assert_eq!(Stacking::Below.to_string(), "below its table");
        assert_eq!(
            Stacking::Covering(3).to_string(),
            "above its table over 3 other window(s)"
        );
        assert_eq!(Restack::Shown.to_string(), "shown");
        assert_eq!(Restack::Look.to_string(), "look");
        assert!(RESTACK_LOOK <= std::time::Duration::from_millis(500));
    }

    /// A restack is logged the first twenty times, then every hundredth.
    #[test]
    fn restacks_logged_sparingly() {
        let logged: Vec<u64> = (1..=1000).filter(|&n| logs_restack(n)).collect();
        assert_eq!(logged.len(), 20 + 10);
        assert_eq!(logged[19], 20);
        assert_eq!(logged[20], 100);
        assert!(!logs_restack(21) && !logs_restack(150));
    }

    /// The scale is the monitor's; a client that is not per-monitor aware
    /// (96 for itself) is stretched to it; nothing known is 100 %.
    #[test]
    fn scale_from_the_monitor() {
        assert_eq!(scale_of(144, 96), 1500);
        assert_eq!(scale_of(192, 192), 2000);
        assert_eq!(scale_of(120, 96), 1250);
        assert_eq!(scale_of(0, 144), 1500);
        assert_eq!(scale_of(0, 0), 1000);
    }

    /// A move is a move; a resize, or a monitor of another dpi at the same
    /// size, is a repaint; hidden hides once; shown again shows.
    #[test]
    fn what_an_overlay_does() {
        let table = rect(100, 100, 640, 480);
        let painted = Placed {
            shown: true,
            at: (100, 100),
            painted: Some((640, 480, 1000)),
        };
        assert_eq!(plan(&painted, &at(table, 1000), false), Plan::Keep);
        assert_eq!(plan(&painted, &at(table, 1000), true), Plan::Paint);
        // Dragged: moved, not painted.
        assert_eq!(
            plan(&painted, &at(rect(400, 160, 640, 480), 1000), false),
            Plan::Move
        );
        // Resized.
        assert_eq!(
            plan(&painted, &at(rect(100, 100, 1000, 730), 1000), false),
            Plan::Paint
        );
        // Dragged onto a 150 % monitor: a per-monitor-aware client keeps
        // its logical size (1.5 times the pixels); a DPI-unaware one is
        // stretched by Windows (the same: its physical size changes). Both
        // repaint at the new scale.
        assert_eq!(
            plan(&painted, &at(rect(2000, 100, 960, 720), 1500), false),
            Plan::Paint
        );
        // A monitor of another dpi, same pixels (or the monitor's scale
        // setting changed under the table): still a repaint - the panels'
        // logical size is the scale's.
        assert_eq!(plan(&painted, &at(table, 1250), false), Plan::Paint);
        // Minimised or cloaked: hidden, once.
        let mut hidden = at(table, 1000);
        hidden.hidden = true;
        assert_eq!(plan(&painted, &hidden, false), Plan::Hide);
        let gone = Placed {
            shown: false,
            ..painted
        };
        assert_eq!(plan(&gone, &hidden, false), Plan::Keep);
        assert_eq!(plan(&gone, &hidden, true), Plan::Keep, "painted when back");
        // An empty client area hides too.
        assert_eq!(
            plan(&painted, &at(Rect::default(), 1000), false),
            Plan::Hide
        );
        // Back: shown where it was, or moved, or painted.
        assert_eq!(plan(&gone, &at(table, 1000), false), Plan::Show);
        assert_eq!(
            plan(&gone, &at(rect(5, 5, 640, 480), 1000), false),
            Plan::Move
        );
        assert_eq!(plan(&gone, &at(table, 1000), true), Plan::Paint);
        // Never painted.
        assert_eq!(
            plan(&Placed::default(), &at(table, 1000), false),
            Plan::Paint
        );
    }

    /// A storm of locations is one `Moved` with the last; a minimise is one
    /// `Minimized`; nothing changed is nothing.
    /// Drags (R3.6) reach the engine in order, none coalesced away; a
    /// drag on a table no longer followed is dropped.
    #[test]
    fn drags_are_kept_in_order() {
        let mut tracked = BTreeMap::from([(WindowId(1), window(1, "A - x", "A"))]);
        let mut observed = Observed::default();
        let drag = |id, slot, seq| TableEvent::PanelMoved {
            id: WindowId(id),
            size: 6,
            slot,
            x: 100,
            y: 200,
            seq,
        };
        // (R3.8) Clicks go the same way, in order with the drags.
        let click = |id, slot| TableEvent::PanelClicked {
            id: WindowId(id),
            slot,
            panel: rect(10, 20, 90, 40),
            scale_permille: 1000,
        };
        observed.dragged(drag(1, 2, 1));
        observed.clicked(click(1, 4));
        observed.dragged(drag(1, 2, 2));
        observed.dragged(drag(7, 0, 3));
        observed.clicked(click(7, 1));
        assert!(!observed.is_empty());
        assert_eq!(
            events(observed, &mut tracked, &matchers()),
            [drag(1, 2, 1), click(1, 4), drag(1, 2, 2)]
        );
        let mut clicked = Observed::default();
        clicked.clicked(click(1, 0));
        assert!(!clicked.is_empty());
    }

    #[test]
    fn locations_coalesce() {
        let mut tracked = BTreeMap::from([(WindowId(1), window(1, "A - x", "A"))]);
        let mut observed = Observed::default();
        for i in 0..100 {
            observed.geometry(WindowId(1), at(rect(100 + i, 100, 640, 480), 1000));
        }
        assert_eq!(
            events(observed, &mut tracked, &matchers()),
            [TableEvent::Moved {
                id: WindowId(1),
                client: rect(199, 100, 640, 480),
                scale_permille: 1000
            }]
        );
        assert_eq!(tracked[&WindowId(1)].client.x, 199);

        let mut observed = Observed::default();
        observed.geometry(WindowId(1), at(rect(199, 100, 640, 480), 1000));
        assert!(events(observed, &mut tracked, &matchers()).is_empty());

        // Minimised: the find's empty rect, hidden.
        let mut observed = Observed::default();
        observed.geometry(
            WindowId(1),
            Geometry {
                client: Rect::default(),
                scale_permille: 1000,
                hidden: true,
            },
        );
        assert_eq!(
            events(observed, &mut tracked, &matchers()),
            [
                TableEvent::Moved {
                    id: WindowId(1),
                    client: Rect::default(),
                    scale_permille: 1000
                },
                TableEvent::Minimized {
                    id: WindowId(1),
                    minimized: true
                }
            ]
        );
        // Onto a 150 % monitor: the scale is news.
        let mut observed = Observed::default();
        observed.geometry(WindowId(1), at(rect(2000, 0, 960, 720), 1500));
        assert_eq!(
            events(observed, &mut tracked, &matchers()),
            [
                TableEvent::Moved {
                    id: WindowId(1),
                    client: rect(2000, 0, 960, 720),
                    scale_permille: 1500
                },
                TableEvent::Minimized {
                    id: WindowId(1),
                    minimized: false
                }
            ]
        );
        // A window nobody tracks is skipped.
        let mut observed = Observed::default();
        observed.geometry(WindowId(77), at(table_rect(), 1000));
        assert!(events(observed, &mut tracked, &matchers()).is_empty());
    }

    fn table_rect() -> Rect {
        rect(0, 0, 10, 10)
    }

    /// (R3.13) Two observers' notes as one: the later look wins per kind,
    /// gone and appeared stick, drags and clicks stay in order.
    #[test]
    fn two_observers_merge() {
        let click = |id, slot| TableEvent::PanelClicked {
            id: WindowId(id),
            slot,
            panel: rect(1, 2, 3, 4),
            scale_permille: 1000,
        };
        let mut appkit = Observed::default();
        appkit.clicked(click(1, 0));
        appkit.geometry(WindowId(1), at(rect(1, 1, 640, 480), 1000));
        appkit.title(WindowId(2), "B - x".into());
        let mut observers = Observed::default();
        observers.geometry(WindowId(1), at(rect(9, 9, 640, 480), 2000));
        observers.gone(WindowId(3));
        observers.appeared = true;
        observers.clicked(click(1, 1));
        appkit.absorb(observers);
        assert_eq!(
            appkit.tables[&WindowId(1)].geometry,
            Some(at(rect(9, 9, 640, 480), 2000))
        );
        assert_eq!(appkit.tables[&WindowId(2)].title.as_deref(), Some("B - x"));
        assert!(appkit.tables[&WindowId(3)].gone);
        assert!(appkit.appeared);
        assert_eq!(appkit.dragged, [click(1, 0), click(1, 1)]);
        // Nothing absorbed changes nothing.
        let before = appkit.clone();
        appkit.absorb(Observed::default());
        assert_eq!(appkit, before);
    }

    /// A tournament table move: the new title through the room's own
    /// matcher, the new table's name as the hands carry it; the same table
    /// with another title is a retitle without a move; a title the room no
    /// longer takes, a destroyed or a hidden window is closed.
    #[test]
    fn titles_and_closes() {
        let mut tracked = BTreeMap::from([
            (WindowId(1), window(1, "Old  Table - x", "Old Table")),
            (WindowId(2), window(2, "B - x", "B")),
            (WindowId(3), window(3, "C - x", "C")),
        ]);
        let mut observed = Observed::default();
        observed.title(WindowId(1), "Mercury  II - 9-max".into());
        observed.title(WindowId(2), "B - y".into());
        observed.title(WindowId(3), "Lobby".into());
        let got = events(observed, &mut tracked, &matchers());
        assert_eq!(
            got,
            [
                TableEvent::Retitled {
                    id: WindowId(1),
                    title: "Mercury  II - 9-max".into(),
                    table: Some("Mercury II".into())
                },
                TableEvent::Retitled {
                    id: WindowId(2),
                    title: "B - y".into(),
                    table: Some("B".into())
                },
                TableEvent::Closed { id: WindowId(3) },
            ]
        );
        assert_eq!(tracked[&WindowId(1)].size, Some(9), "seats from the title");
        assert_eq!(tracked[&WindowId(1)].table.as_deref(), Some("Mercury II"));
        assert!(!tracked.contains_key(&WindowId(3)));
        // The winamax pattern would take "B / 6", but B is PokerStars': the
        // window's own room decides.
        let mut observed = Observed::default();
        observed.title(WindowId(2), "B / 6".into());
        assert_eq!(
            events(observed, &mut tracked, &matchers()),
            [TableEvent::Closed { id: WindowId(2) }]
        );
        // Destroyed (or hidden) wins over anything else seen of it.
        let mut observed = Observed::default();
        observed.geometry(WindowId(1), at(table_rect(), 1000));
        observed.title(WindowId(1), "X - y".into());
        observed.gone(WindowId(1));
        observed.appeared = true;
        assert_eq!(
            events(observed, &mut tracked, &matchers()),
            [TableEvent::Closed { id: WindowId(1) }, TableEvent::Appeared]
        );
        assert!(tracked.is_empty());
        assert!(Observed::default().is_empty());
    }
}

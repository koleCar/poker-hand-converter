//! (T2, docs/research/TABLE-TILING.md §4.3) Table tiling end to end on the
//! sim backend, headless on every system: the HUD's engine with tiling on,
//! the placement worker on its own thread, twelve simulator tables of two
//! rooms over two monitors of different sizes and scales.
//!
//! - All twelve placed: inside the work areas, none overlapping, **edge to
//!   edge within a pixel on their outer rects** (the frame differs from the
//!   client area, and with the monitor's scale), each room's aspect ratio
//!   kept; the room the policy refuses is never moved.
//! - A thirteenth stacks, and nothing else moves; one closing hands its
//!   place to the stacked table, and nothing else moves.
//! - A client that refuses the size: kept, centred in its slot (one retry).
//! - A table the user drags (the mouse down) is pinned: never moved again.
//! - Nothing moves while the mouse is down, nor in the 600 ms after it is
//!   released.

use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Settings, TilingConfig};
use rail_hud::placer::QUIET_AFTER_CLICK;
use rail_hud::platform::sim::{Placement, SimBackend, SimControl, SimFeed};
use rail_hud::platform::{Insets, Monitor, MonitorId, Rect, WindowId};
use rail_hud::tiling::{Aspect, Options, RoomGeometry, centred};

const FOUR_THREE: Aspect = Aspect {
    width: 4,
    height: 3,
};

/// A Windows 11 table's visible frame at 100 %: a 31 px caption, 1 px
/// borders.
const FRAME: Insets = Insets {
    left: 1,
    top: 31,
    right: 1,
    bottom: 1,
};

/// The refused room: never handed to the tiler.
const REFUSED: u32 = 20;

fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// A 1920 x 1080 primary (40 px taskbar) at 100 %, and a 2560 x 1440 one at
/// 125 % to its right.
fn monitors() -> Vec<Monitor> {
    vec![
        Monitor {
            id: MonitorId(11),
            primary: true,
            bounds: rect(0, 0, 1920, 1080),
            work_area: rect(0, 0, 1920, 1040),
            scale_permille: 1000,
        },
        Monitor {
            id: MonitorId(12),
            primary: false,
            bounds: rect(1920, 0, 2560, 1440),
            work_area: rect(1920, 0, 2560, 1400),
            scale_permille: 1250,
        },
    ]
}

/// Table `n` opens (titled for the simulator's regex) at a place of its
/// own on the primary monitor, posing as `site`.
fn open(feed: &SimFeed, control: &SimControl, n: u32, site: &str) {
    control.pose(n, site);
    let title = format!("T{n} - $0.05/$0.10");
    feed.push_line(&format!(
        r#"{{"event":"table","table":{n},"title":"{title}","size":6}}"#
    ));
    feed.push_line(&format!(
        r#"{{"event":"window","table":{n},"title":"{title}","x":{x},"y":{y},"width":640,"height":480,"minimized":false}}"#,
        x = 20 * n,
        y = 10 * n
    ));
}

fn close(feed: &SimFeed, n: u32) {
    feed.push_line(&format!(r#"{{"event":"closed","table":{n}}}"#));
}

/// The loop's ticks for `d` (the worker places meanwhile).
fn run_for(hud: &mut Hud, d: Duration) {
    let end = Instant::now() + d;
    while Instant::now() < end {
        hud.tick(Instant::now(), &mut |_| {});
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Tick until the tiler has nothing due and no placement came for 300 ms;
/// the placements made meanwhile.
fn settle(hud: &mut Hud, control: &SimControl) -> Vec<Placement> {
    let before = control.placements().len();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut count = before;
    let mut quiet_since = Instant::now();
    loop {
        run_for(hud, Duration::from_millis(20));
        let now = control.placements().len();
        if now != count {
            count = now;
            quiet_since = Instant::now();
        }
        let settled = hud.tiler().is_some_and(rail_hud::tiling::Tiler::settled);
        if settled && quiet_since.elapsed() >= Duration::from_millis(300) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "tiling did not settle: {:?}",
            hud.tiler()
        );
    }
    control.placements()[before..].to_vec()
}

fn ids(placements: &[Placement]) -> Vec<u64> {
    let mut ids: Vec<u64> = placements.iter().map(|p| p.id.0).collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// The monitor whose work area holds `outer`.
fn monitor_of(outer: &Rect) -> usize {
    monitors()
        .iter()
        .position(|m| m.work_area.contains(outer))
        .unwrap_or_else(|| panic!("{outer:?} is in no work area"))
}

/// Per monitor, rows of outer rects that touch: each next to the one
/// before within a pixel, each row under the one before.
fn edge_to_edge(outers: &[Rect]) {
    for m in 0..monitors().len() {
        let mut on: Vec<Rect> = outers
            .iter()
            .copied()
            .filter(|r| monitor_of(r) == m)
            .collect();
        on.sort_by_key(|r| (r.y, r.x));
        let mut rows: Vec<Vec<Rect>> = Vec::new();
        for r in on {
            match rows.last_mut() {
                Some(row) if (row[0].y - r.y).abs() <= 1 => row.push(r),
                _ => rows.push(vec![r]),
            }
        }
        for row in &rows {
            for pair in row.windows(2) {
                let gap = i64::from(pair[1].x) - pair[0].right();
                assert!(gap.abs() <= 1, "a gap of {gap} px in a row: {pair:?}");
            }
        }
        for pair in rows.windows(2) {
            let gap = i64::from(pair[1][0].y) - pair[0][0].bottom();
            assert!(gap.abs() <= 1, "a gap of {gap} px between rows");
            assert!(
                (pair[1][0].x - pair[0][0].x).abs() <= 1,
                "rows start in one column"
            );
        }
    }
}

#[test]
fn twelve_tables_over_two_monitors() {
    let (mut backend, feed) = SimBackend::new("pokerstars");
    backend.set_monitors(monitors());
    let control = backend.control();
    control.set_insets(FRAME);
    feed.push_line(r#"{"event":"started","titleRegex":"^(?P<table>.+?) - .*$"}"#);
    for n in 1..=6 {
        open(&feed, &control, n, "pokerstars");
    }
    for n in 7..=12 {
        open(&feed, &control, n, "winamax");
    }
    open(&feed, &control, REFUSED, "ggpoker");

    let settings = Settings {
        tick: Duration::from_millis(5),
        find_every: Duration::from_millis(30),
        find_every_notified: Duration::from_millis(30),
        ..Settings::default()
    };
    let mut hud = Hud::new(
        Box::new(backend),
        Compliance::shipped().expect("shipped"),
        StoreView::new(None),
        settings,
    );
    let room = RoomGeometry {
        aspect: Some(FOUR_THREE),
        min_client: Some((600, 450)),
    };
    hud.enable_tiling(TilingConfig {
        options: Options {
            rooms: [
                ("pokerstars".to_owned(), room),
                ("winamax".to_owned(), room),
            ]
            .into_iter()
            .collect(),
            ..Options::default()
        },
        allowed: Box::new(|site| site != "ggpoker"),
        simulator_only: false,
    })
    .expect("tiling on");

    // Twelve placed, edge to edge, the aspect kept.
    let placed = settle(&mut hud, &control);
    assert_eq!(ids(&placed), (1..=12).collect::<Vec<_>>());
    let outers: Vec<Rect> = (1..=12)
        .map(|n| control.outer_of(n).expect("open"))
        .collect();
    for (i, a) in outers.iter().enumerate() {
        for b in &outers[i + 1..] {
            assert_eq!(a.overlap(b), 0, "{a:?} overlaps {b:?}");
        }
    }
    edge_to_edge(&outers);
    assert_eq!(
        (0..2)
            .map(|m| outers.iter().filter(|r| monitor_of(r) == m).count())
            .collect::<Vec<_>>(),
        [6, 6],
        "spread over both monitors"
    );
    for n in 1..=12 {
        let client = control.client_of(n).expect("open");
        assert!(
            FOUR_THREE.holds(client.width, client.height),
            "{n}: {client:?}"
        );
        let scale = control.scale_of(n).expect("open");
        assert!(client.width * 1000 / scale >= 600, "{n}: the minimum");
    }
    let tiler = hud.tiler().expect("on");
    assert_eq!(tiler.grid().expect("auto").capacity(), 12);

    // A thirteenth stacks; nobody else moves.
    open(&feed, &control, 13, "pokerstars");
    let placed = settle(&mut hud, &control);
    assert_eq!(ids(&placed), [13]);
    let stacked = hud.tiler().and_then(|t| t.slot_of(WindowId(13)));
    assert_eq!(stacked, hud.tiler().and_then(|t| t.slot_of(WindowId(1))));

    // One closes: the stacked table takes its place; nobody else moves.
    let freed = hud.tiler().and_then(|t| t.slot_of(WindowId(3)));
    close(&feed, 3);
    let placed = settle(&mut hud, &control);
    assert_eq!(ids(&placed), [13]);
    assert_eq!(hud.tiler().and_then(|t| t.slot_of(WindowId(13))), freed);
    assert_eq!(control.outer_of(13), Some(outers[2]), "table 3's place");

    // A client that only takes widths in steps of 100: its size kept,
    // centred in its slot - one retry, nothing else moves.
    control.set_accept_for(14, |want| {
        let width = want.width / 100 * 100;
        Rect {
            width,
            height: width * 3 / 4,
            ..want
        }
    });
    open(&feed, &control, 14, "winamax");
    let placed = settle(&mut hud, &control);
    assert_eq!(ids(&placed), [14]);
    assert_eq!(placed.len(), 2, "a placement and one retry: {placed:?}");
    let tiler = hud.tiler().expect("on");
    let slot = tiler.slot_of(WindowId(14)).expect("a slot");
    let cell = tiler.slots()[slot].cell;
    let outer = control.outer_of(14).expect("open");
    assert_eq!(control.client_of(14).map(|c| c.width % 100), Some(0));
    assert_eq!(outer, centred(&cell, outer.width, outer.height), "centred");

    // The user drags table 5 (the mouse down): pinned, never moved again.
    control.press();
    // The worker samples the mouse every 25 ms: let it see the press.
    run_for(&mut hud, Duration::from_millis(250));
    let dragged = rect(300, 200, 640, 480);
    feed.push_line(
        r#"{"event":"window","table":5,"title":"T5 - $0.05/$0.10","x":300,"y":200,"width":640,"height":480,"minimized":false}"#,
    );
    run_for(&mut hud, Duration::from_millis(150));
    control.release();
    assert!(hud.tiler().is_some_and(|t| t.pinned(WindowId(5))));
    open(&feed, &control, 15, "pokerstars");
    let placed = settle(&mut hud, &control);
    assert!(!ids(&placed).contains(&5), "{placed:?}");
    assert!(ids(&placed).contains(&15));
    assert_eq!(control.client_of(5), Some(dragged));

    // The mouse held: a new table waits; released, it is placed 600 ms on.
    control.press();
    open(&feed, &control, 16, "winamax");
    let before = control.placements().len();
    run_for(&mut hud, Duration::from_millis(900));
    assert_eq!(control.placements().len(), before, "nothing while held");
    control.release();
    let released = Instant::now();
    while control.placements().len() == before {
        run_for(&mut hud, Duration::from_millis(5));
        assert!(released.elapsed() < Duration::from_secs(10));
    }
    assert!(
        released.elapsed() >= QUIET_AFTER_CLICK,
        "placed {} ms after the release",
        released.elapsed().as_millis()
    );
    let placed = settle(&mut hud, &control);
    let all: Vec<Placement> = control.placements()[before..].to_vec();
    assert_eq!(ids(&all), [16], "{placed:?}");

    // The refused room was never touched.
    assert!(
        control
            .placements()
            .iter()
            .all(|p| p.id != WindowId(u64::from(REFUSED)))
    );
    assert_eq!(
        control.client_of(REFUSED),
        Some(rect(400, 200, 640, 480)),
        "where it opened"
    );

    // Off: nothing moves any more.
    hud.disable_tiling();
    open(&feed, &control, 17, "pokerstars");
    let before = control.placements().len();
    run_for(&mut hud, Duration::from_millis(300));
    assert_eq!(control.placements().len(), before);
}

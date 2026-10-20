//! Nothing from the hand in play (docs/RAIL-PLAN.md R3.7; ACR's rule, and
//! every room's by design): the HUD reads only the store; the rooms write a
//! hand's history once the hand has ended; and the watcher imports a hand
//! only once its file has been quiet for 500 ms with a hand that validates,
//! or the next hand has begun (R1.3's completeness rule) - a hand the room
//! is still writing is not stored. So while a hand is played, and while
//! its history is being written, no number the HUD shows counts it,
//! however often the HUD reads; once it is written and imported it does.
//!
//! R1.3's assumption stands under this (measured here while building it): a
//! room that stopped writing **mid-hand** for longer than the quiet period,
//! at a line end, would get the prefix stored - a PokerStars hand cut at
//! the flop validates. No room seen writes that way; R3.14 checks it on the
//! real clients.
//!
//! The app's half is played here as the app plays it: the real watcher
//! into a store, `newest_hands_of_file` to `hand_imported`. The HUD is the
//! engine with a backend that keeps every frame.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Input, Settings};
use rail_hud::platform::{
    OverlayFrame, Platform, PlatformError, ProcessInfo, Rect, TableEvent, TableMatcher,
    TableWindow, WindowId,
};
use rail_hud_ipc::protocol::{AppMessage, HudMessage, PlayerRef};
use rail_store::Store;
use rail_watch::{WatchConfig, WatchEvent, Watcher};

const HAND: &str = "fixtures/samples/pokerstars/01-cash-nlhe-6max-ante.txt";
const TABLE: &str = "Skat III 100-250 bb, Ante";

#[derive(Default, Clone)]
struct Kept {
    windows: Rc<RefCell<Vec<TableWindow>>>,
    frames: Rc<RefCell<BTreeMap<WindowId, OverlayFrame>>>,
}

impl Platform for Kept {
    fn name(&self) -> &'static str {
        "kept"
    }
    fn find_tables(&mut self, _: &[TableMatcher]) -> Result<Vec<TableWindow>, PlatformError> {
        Ok(self.windows.borrow().clone())
    }
    fn track(&mut self, _: &TableWindow) -> Result<(), PlatformError> {
        Ok(())
    }
    fn untrack(&mut self, _: WindowId) {}
    fn poll_events(&mut self) -> Vec<TableEvent> {
        Vec::new()
    }
    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError> {
        self.frames.borrow_mut().insert(id, frame.clone());
        Ok(())
    }
    fn remove_overlay(&mut self, id: WindowId) {
        self.frames.borrow_mut().remove(&id);
    }
}

/// Hand `number` of the table, the user dealt in (the corpus hand with a
/// hero line and its own number).
fn hand(number: u64) -> String {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(HAND),
    )
    .expect("the corpus hand");
    text.trim_start_matches('\u{feff}')
        .replace("Game #109681344065", &format!("Game #{number}"))
        .replace(
            "*** HOLE CARDS ***\n",
            "*** HOLE CARDS ***\nDealt to Nightfox82 [Ad 7d]\n",
        )
}

fn append(path: &Path, text: &str) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("the hand history");
    file.write_all(text.as_bytes()).expect("write");
    file.sync_all().expect("sync");
}

/// The players' hand counts the HUD shows now.
fn shown(kept: &Kept) -> Vec<i64> {
    kept.frames
        .borrow()
        .get(&WindowId(1))
        .map(|frame| frame.panels.iter().map(|p| p.hands).collect())
        .unwrap_or_default()
}

/// Wait for the watcher to import `n` hands from `file`; then tell the HUD
/// of them as the app does.
fn imported(
    rx: &mpsc::Receiver<(PathBuf, u32)>,
    store: &Store,
    hud: &mut Hud,
    sent: &mut Vec<HudMessage>,
) {
    let (path, inserted) = rx
        .recv_timeout(Duration::from_secs(20))
        .expect("the watcher imports the hand");
    for hand in store
        .reader()
        .newest_hands_of_file(&path, inserted)
        .expect("newest")
        .into_iter()
        .rev()
    {
        hud.handle(
            Input::App(
                AppMessage::HandImported {
                    site: hand.site,
                    table: hand.table,
                    hand_key: hand.hand_key,
                    players: hand
                        .players
                        .into_iter()
                        .map(|p| PlayerRef {
                            name: p.player,
                            scope: p.scope,
                            seat: Some(p.seat),
                            hero: p.hero,
                            stack_bb_tenths: p.stack_bb_tenths,
                        })
                        .collect(),
                    timing: None,
                },
                Instant::now(),
            ),
            &mut |m| sent.push(m),
        );
    }
}

#[test]
fn the_hand_in_play_is_never_counted() {
    let base = std::env::temp_dir().join(format!("rail-hud-in-play-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("hand-history");
    std::fs::create_dir_all(&folder).expect("folder");
    let db = base.join(rail_store::FILE_NAME);
    let store = Store::open(&db).expect("store");
    let (tx, rx) = mpsc::channel::<(PathBuf, u32)>();
    let watcher = Watcher::start(
        &db,
        store.writer().expect("writer"),
        WatchConfig::default(),
        move |event| {
            if let WatchEvent::Imported { path, inserted, .. } = event
                && inserted > 0
            {
                let _ = tx.send((path, inserted));
            }
        },
    )
    .expect("watcher");
    watcher
        .add_source(&folder, true, Some(false))
        .expect("source");
    // The OS watch is set before the first walk; give it a moment.
    std::thread::sleep(Duration::from_millis(1500));

    let kept = Kept::default();
    kept.windows.borrow_mut().push(TableWindow {
        id: WindowId(1),
        site: "pokerstars".into(),
        process: ProcessInfo {
            pid: Some(1),
            name: "PokerStars.exe".into(),
        },
        title: format!("{TABLE} - $0.05/$0.10"),
        table: Some(TABLE.into()),
        size: Some(6),
        client: Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 550,
        },
        scale_permille: 1000,
        minimized: false,
    });
    let mut hud = Hud::new(
        Box::new(kept.clone()),
        Compliance::shipped().expect("shipped"),
        StoreView::new(Some(db.clone())),
        Settings::default(),
    );
    let mut sent = Vec::new();
    let mut clock = Instant::now();
    let mut tick = |hud: &mut Hud, sent: &mut Vec<HudMessage>| {
        // Every look the HUD makes on its own: windows and the store.
        clock += Duration::from_secs(3);
        hud.tick(clock, &mut |m| sent.push(m));
    };
    tick(&mut hud, &mut sent);

    // The first hand, complete.
    let file = folder.join("HH20260115 Skat III.txt");
    append(&file, &hand(109_681_344_101));
    imported(&rx, &store, &mut hud, &mut sent);
    assert_eq!(shown(&kept), [1; 6], "the first hand counted");

    // The HUD reads as much as it likes - the store's own check, the app's
    // `resync` - and shows one hand while the next is in play.
    let mut reread = |hud: &mut Hud, sent: &mut Vec<HudMessage>, what: &str| {
        tick(hud, sent);
        hud.handle(Input::App(AppMessage::Resync, Instant::now()), &mut |m| {
            sent.push(m)
        });
        assert_eq!(
            shown(&kept),
            [1; 6],
            "{what}: the hand in play is not counted"
        );
    };

    // The next hand is being played: the rooms write a hand's history when
    // the hand has ended, so nothing of it is in the file yet.
    let until = Instant::now() + Duration::from_millis(1_500);
    while Instant::now() < until {
        reread(&mut hud, &mut sent, "not written");
        std::thread::sleep(Duration::from_millis(250));
    }
    // It ends and the room writes it - here in four pieces, each at a line
    // end, closer together than the watcher's quiet period (500 ms): a hand
    // the room is still writing is not imported.
    let second = format!(
        "

{}",
        hand(109_681_344_102)
    );
    let cuts: Vec<usize> = ["*** HOLE CARDS ***", "*** FLOP ***", "*** SUMMARY ***"]
        .iter()
        .map(|mark| second.find(mark).expect("a street"))
        .chain([second.len()])
        .collect();
    // The pieces go 150 ms apart whatever a reread costs (a Windows CI
    // runner once spent over 400 ms on two, and the watcher rightly stored
    // the prefix: R1.3's case above, not this test's).
    let mut from = 0;
    let mut written: Option<Instant> = None;
    let mut longest = Duration::ZERO;
    for (index, &to) in cuts.iter().enumerate() {
        if let Some(at) = written {
            longest = longest.max(at.elapsed());
        }
        append(&file, &second[from..to]);
        let at = Instant::now();
        written = Some(at);
        from = to;
        if index + 1 < cuts.len() {
            reread(&mut hud, &mut sent, "being written");
            std::thread::sleep(Duration::from_millis(150).saturating_sub(at.elapsed()));
        }
    }
    let quiet = Duration::from_millis(
        u64::try_from(WatchConfig::default().read.quiet_ms).expect("a quiet period"),
    );
    if longest >= quiet {
        eprintln!(
            "the runner stalled: {} ms between two pieces, longer than the quiet period; \
             the hand being written was not tested this run",
            longest.as_millis()
        );
        hud.shutdown();
        watcher.stop();
        store.close();
        let _ = std::fs::remove_dir_all(&base);
        return;
    }
    let stored: Vec<_> = store
        .reader()
        .newest_hands_of_file(&file, 10)
        .expect("newest")
        .into_iter()
        .map(|h| h.hand_key)
        .collect();
    assert_eq!(
        stored,
        ["pokerstars:PS109681344101"],
        "the store has one hand while the second is written"
    );
    assert!(rx.try_recv().is_err(), "nothing imported yet");

    // Written and quiet: the watcher imports it, and now it counts.
    imported(&rx, &store, &mut hud, &mut sent);
    assert_eq!(shown(&kept), [2; 6], "counted once complete and imported");
    assert!(
        sent.iter().any(|m| matches!(
            m,
            HudMessage::TableUpdated { hand_key: Some(key), .. } if key == "pokerstars:PS109681344102"
        )),
        "re-read on its hand_imported"
    );

    hud.shutdown();
    watcher.stop();
    store.close();
    let _ = std::fs::remove_dir_all(&base);
}

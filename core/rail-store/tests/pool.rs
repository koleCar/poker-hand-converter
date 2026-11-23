//! The Pool tab in the store (docs/ANALYTICS.md Step 10): the catalogue's
//! rates installed as hidden custom statistics and counted on every kept
//! seat; each opponent's results summed by the pool pass; `pool_sums` types
//! the opponents by Rail's rule and sums their results and rates over the
//! hands they played with the hero - checked against a recount from the
//! stored PHF and seat rows; deletes, resets and re-installs keep it right.

// The recount: floating sums of results, the rule's 0.6·VPIP.
#![allow(clippy::float_arithmetic, clippy::type_complexity)]

mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_core::phf::PhfHand;
use rail_stats::analytics::catalogue;
use rail_stats::events::hand_events;
use rail_store::import::ImportOptions;
use rail_store::pool::{KV_POOL_COUNTED, PoolFilters, install_analytics_stats};
use rail_store::stats::decode_seat;
use rail_store::{PoolSums, Store, background, import_file};
use rusqlite::{Connection, params};

use common::{PARSED_AT, corpus_files, scratch_dir};

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// The corpus imported and drained once per test binary. Tests copy it.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("pool-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        for file in corpus_files() {
            import_file(&store, &file, &options()).expect("import");
        }
        drain(&store);
        store.close();
        path
    })
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

fn drain(store: &Store) -> background::Drained {
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain")
}

fn rates() -> Vec<String> {
    catalogue()
        .stats
        .iter()
        .filter(|stat| stat.counter().is_some())
        .map(|stat| stat.id.clone())
        .collect()
}

/// Two busy named opponents typed by hand: one a fish, one a reg (their
/// rollups' VPIP / PFR rewritten), so the pool has both.
fn type_two(conn: &Connection) -> (String, String) {
    let busiest: Vec<(String, String)> = conn
        .prepare(
            "SELECT site, player FROM pool_player_results
             WHERE scope = '' AND player <> '' AND hero_hands = 0
             GROUP BY site, player ORDER BY sum(hands) DESC, player LIMIT 2",
        )
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(busiest.len(), 2, "the corpus has two named opponents");
    let set = |(site, player): &(String, String), vpip: i64, pfr: i64| {
        conn.execute(
            "UPDATE player_rollups SET hands = 100, vpip_opp = 100, vpip = ?3, pfr_opp = 100, pfr = ?4
             WHERE site = ?1 AND player = ?2 AND scope = ''",
            params![site, player, vpip, pfr],
        )
        .expect("type");
    };
    set(&busiest[0], 50, 10);
    set(&busiest[1], 22, 18);
    (busiest[0].1.clone(), busiest[1].1.clone())
}

/// What `pool_sums` should return, recounted from the stored PHF and seat
/// rows with the rule written out again here.
fn expected(
    store: &Store,
    conn: &Connection,
) -> (
    BTreeMap<&'static str, (i64, i64, f64, f64)>,
    BTreeMap<(String, &'static str), (i64, i64)>,
) {
    // Types: Rail's rule over player_rollups (scope '', every segment).
    let mut types: HashMap<(String, String), &'static str> = HashMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT site, player, sum(hands), sum(vpip) * 100.0 / max(sum(vpip_opp), 1),
                    sum(pfr) * 100.0 / max(sum(pfr_opp), 1)
             FROM player_rollups WHERE scope = '' AND player <> '' GROUP BY site, player",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        let (hands, vpip, pfr): (i64, f64, f64) = (
            row.get(2).expect("column"),
            row.get(3).expect("column"),
            row.get(4).expect("column"),
        );
        let kind = if hands >= 30 && vpip >= 40.0 {
            "fish"
        } else if hands >= 30 && (15.0..=30.0).contains(&vpip) && pfr >= vpip * 0.6 {
            "reg"
        } else {
            continue;
        };
        types.insert(
            (row.get(0).expect("column"), row.get(1).expect("column")),
            kind,
        );
    }
    // Every hand with a hero seat: its kept seats.
    struct Seat {
        seat: u32,
        player: String,
        scope: String,
        hero: bool,
        net: i64,
    }
    let mut hands: Vec<(i64, String, String, i64, i64, Vec<Seat>)> = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.hand_key, s.site, d.is_bomb_pot, d.has_cashout
             FROM hand_stats d JOIN segments s ON s.id = d.segment_id ORDER BY d.id",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        hands.push((
            row.get(0).expect("column"),
            row.get(1).expect("column"),
            row.get(2).expect("column"),
            row.get(3).expect("column"),
            row.get(4).expect("column"),
            Vec::new(),
        ));
    }
    let mut seat_stmt = conn
        .prepare("SELECT seat, player, scope, is_hero, totals FROM seat_stats WHERE hand_id = ?1")
        .expect("prepare");
    for hand in &mut hands {
        let seats = seat_stmt
            .query_map([hand.0], |row| {
                Ok(Seat {
                    seat: row.get(0)?,
                    player: row.get(1)?,
                    scope: row.get(2)?,
                    hero: row.get(3)?,
                    net: decode_seat(&row.get::<_, Vec<u8>>(4)?)
                        .expect("decode")
                        .net_bb_milli(),
                })
            })
            .expect("seats")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        hand.5 = seats;
    }
    // A member: typed, with results, never the hero.
    let hero_names: std::collections::HashSet<(String, String)> = hands
        .iter()
        .flat_map(|h| {
            h.5.iter()
                .filter(|s| s.hero)
                .map(|s| (h.2.clone(), s.player.clone()))
        })
        .collect();
    let mut results: BTreeMap<&'static str, (i64, i64, f64, f64)> = BTreeMap::new();
    let mut with_results: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for (_, _, site, bomb, cashout, seats) in &hands {
        if *bomb != 0 || *cashout != 0 || !seats.iter().any(|s| s.hero) {
            continue;
        }
        for seat in seats
            .iter()
            .filter(|s| !s.hero && s.scope.is_empty() && !s.player.is_empty())
        {
            with_results.insert((site.clone(), seat.player.clone()));
        }
    }
    let member = |site: &str, player: &str| -> Option<&'static str> {
        let key = (site.to_owned(), player.to_owned());
        if hero_names.contains(&key) || !with_results.contains(&key) {
            return None;
        }
        types.get(&key).copied()
    };
    let mut players: BTreeMap<&'static str, std::collections::BTreeSet<String>> = BTreeMap::new();
    for (_, _, site, bomb, cashout, seats) in &hands {
        if *bomb != 0 || *cashout != 0 || !seats.iter().any(|s| s.hero) {
            continue;
        }
        for seat in seats.iter().filter(|s| !s.hero && s.scope.is_empty()) {
            if let Some(kind) = member(site, &seat.player) {
                players.entry(kind).or_default().insert(seat.player.clone());
                let entry = results.entry(kind).or_default();
                entry.1 += 1;
                #[allow(clippy::cast_precision_loss)]
                let bb = seat.net as f64 / 1000.0;
                entry.2 += bb;
                entry.3 += bb * bb;
            }
        }
    }
    for (kind, names) in &players {
        results.entry(kind).or_default().0 = i64::try_from(names.len()).expect("players");
    }
    // Rates: the catalogue's counts on each member's seat, own hands only, bomb pots out.
    let ids = rates();
    let mut counts: BTreeMap<(String, &'static str), (i64, i64)> = BTreeMap::new();
    for (_, key, site, bomb, _, seats) in &hands {
        if *bomb != 0 || !seats.iter().any(|s| s.hero) {
            continue;
        }
        if !seats
            .iter()
            .any(|s| !s.hero && s.scope.is_empty() && member(site, &s.player).is_some())
        {
            continue;
        }
        let text = store.reader().hand_phf(key).expect("phf").expect("stored");
        let phf: PhfHand = serde_json::from_str(&text).expect("phf");
        let events = hand_events(&phf);
        for seat in seats.iter().filter(|s| !s.hero && s.scope.is_empty()) {
            let Some(kind) = member(site, &seat.player) else {
                continue;
            };
            let Some(seat_events) = events.seats.iter().find(|e| e.seat == seat.seat) else {
                continue;
            };
            for (stat, c) in catalogue()
                .stats
                .iter()
                .zip(catalogue().counts(&events, seat_events))
            {
                if !ids.contains(&stat.id) || c.opp == 0 {
                    continue;
                }
                let entry = counts.entry((stat.id.clone(), kind)).or_default();
                entry.0 += i64::from(c.made);
                entry.1 += i64::from(c.opp);
            }
        }
    }
    (results, counts)
}

fn assert_pool(sums: &PoolSums, store: &Store, conn: &Connection) {
    let (results, counts) = expected(store, conn);
    for (kind, got) in [("reg", sums.reg), ("fish", sums.fish)] {
        let want = results.get(kind).copied().unwrap_or_default();
        assert_eq!(
            (got.players, got.hands),
            (want.0, want.1),
            "{kind}: players, hands"
        );
        assert!(
            (got.net_bb - want.2).abs() < 1e-6,
            "{kind}: net {} vs {}",
            got.net_bb,
            want.2
        );
        assert!(
            (got.net_bb_sq - want.3).abs() < 1e-3 * want.3.max(1.0),
            "{kind}: net² {} vs {}",
            got.net_bb_sq,
            want.3
        );
    }
    let got: BTreeMap<(String, &str), (i64, i64)> = sums
        .stats
        .iter()
        .map(|row| {
            (
                (
                    row.stat.clone(),
                    if row.kind == "reg" { "reg" } else { "fish" },
                ),
                (row.made, row.opp),
            )
        })
        .collect();
    assert_eq!(got, counts, "the rates by type");
}

#[test]
fn the_catalogue_is_installed_hidden_and_counted_for_the_pool() {
    let path = copy_of_corpus("pool-install");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let installed: i64 = conn
        .query_row(
            "SELECT count(*) FROM custom_stats WHERE stat_key LIKE 'an\\_%' ESCAPE '\\'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        installed,
        i64::try_from(rates().len()).expect("rates"),
        "one hidden statistic per rate"
    );
    assert!(
        store.reader().custom_stats().expect("list").is_empty(),
        "the user's list leaves them out"
    );
    assert!(
        store
            .reader()
            .custom_progress()
            .expect("progress")
            .is_empty()
    );
    let hero_rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM custom_hero_rows r JOIN custom_stats c ON c.id = r.stat_id
             WHERE c.stat_key LIKE 'an\\_%' ESCAPE '\\'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(hero_rows, 0, "no hero rows for the catalogue's rates");
    let players: i64 = conn
        .query_row("SELECT count(*) FROM custom_player_rollups", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert!(players > 0, "the opponents are counted");
    // Installing again changes nothing; a changed predicate and a stale rate are put right.
    let again = store
        .writer()
        .expect("writer")
        .write(|tx| install_analytics_stats(tx))
        .expect("install");
    assert_eq!(again, 0);
    conn.execute(
        "UPDATE custom_stats SET predicate = 'first street = river => action = fold' WHERE stat_key = 'an_vpip'",
        [],
    )
    .expect("tamper");
    conn.execute(
        "INSERT INTO custom_stats (stat_key, rev, definition, predicate, ord, counted_to, created_at, updated_at)
         SELECT 'an_gone', 1, definition, predicate, 99, 0, 0, 0 FROM custom_stats WHERE stat_key = 'an_pfr'",
        [],
    )
    .expect("stale");
    let fixed = store
        .writer()
        .expect("writer")
        .write(|tx| install_analytics_stats(tx))
        .expect("install");
    assert_eq!(fixed, 2);
    let (vpip_to, gone): (i64, i64) = conn
        .query_row(
            "SELECT (SELECT counted_to FROM custom_stats WHERE stat_key = 'an_vpip'),
                    (SELECT count(*) FROM custom_stats WHERE stat_key = 'an_gone')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read");
    assert_eq!(
        (vpip_to, gone),
        (0, 0),
        "the changed rate is counted again, the stale one gone"
    );
    store.close();
}

#[test]
fn pool_sums_match_a_recount_and_follow_deletes_and_resets() {
    let path = copy_of_corpus("pool-sums");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let (fish, reg) = type_two(&conn);
    let sums = store
        .reader()
        .pool_sums(&PoolFilters::default())
        .expect("sums");
    assert_eq!(sums.pending, 0);
    assert!(
        sums.fish.players >= 1 && sums.reg.players >= 1,
        "{fish} is a fish, {reg} a reg"
    );
    assert!(
        sums.stats.iter().any(|row| row.kind == "fish")
            && sums.stats.iter().any(|row| row.kind == "reg")
    );
    assert_pool(&sums, &store, &conn);

    // Filters: the format's kind; a room the pool does not have.
    let cash = store
        .reader()
        .pool_sums(&PoolFilters {
            game_kind: Some("tournament".to_owned()),
            game_format: Some("cash".to_owned()),
            ..PoolFilters::default()
        })
        .expect("sums");
    assert_eq!(
        (cash.reg.hands, cash.fish.hands, cash.stats.len()),
        (0, 0, 0),
        "a format outside the kind is nothing"
    );
    let elsewhere = store
        .reader()
        .pool_sums(&PoolFilters {
            sites: Some(vec!["nowhere".to_owned()]),
            ..PoolFilters::default()
        })
        .expect("sums");
    assert_eq!((elsewhere.reg.players, elsewhere.fish.players), (0, 0));

    // A third of the hands deleted: the results lose exactly their part.
    let keys: Vec<String> = conn
        .prepare("SELECT hand_key FROM hand_stats ORDER BY id")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("keys")
        .collect::<Result<Vec<String>, _>>()
        .expect("rows")
        .into_iter()
        .step_by(3)
        .collect();
    store
        .writer()
        .expect("writer")
        .delete_hands(keys, 1_000)
        .expect("delete");
    drain(&store);
    let after = store
        .reader()
        .pool_sums(&PoolFilters::default())
        .expect("sums");
    assert_pool(&after, &store, &conn);

    // A reset (the custom counts reset) sums them again from the first hand.
    let before: Vec<(String, i64, i64)> = results(&conn);
    conn.execute("DELETE FROM pool_player_results", [])
        .expect("empty");
    conn.execute(
        "UPDATE kv SET value = '0' WHERE key = ?1",
        [KV_POOL_COUNTED],
    )
    .expect("mark");
    let drained = drain(&store);
    assert!(drained.pooled > 0, "the pass sums again");
    assert_eq!(results(&conn), before, "the same results");

    // Every hand deleted: nothing left in the pool.
    store
        .writer()
        .expect("writer")
        .delete_all_hands(2_000, false)
        .expect("delete all");
    drain(&store);
    assert!(results(&conn).is_empty());
    let none = store
        .reader()
        .pool_sums(&PoolFilters::default())
        .expect("sums");
    assert_eq!(
        (none.reg.players, none.fish.players, none.stats.len()),
        (0, 0, 0)
    );
    store.close();
}

fn results(conn: &Connection) -> Vec<(String, i64, i64)> {
    conn.prepare("SELECT player, hands, net_bb_milli FROM pool_player_results ORDER BY site, player, scope, segment_id")
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn a_user_statistic_cannot_take_the_reserved_prefix() {
    use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
    use rail_stats::custom::{CustomDef, CustomSet};
    let text = |v: &str| Text {
        en: v.to_owned(),
        hr: v.to_owned(),
    };
    let def = CustomDef {
        def: StatDef {
            id: "an_mine".to_owned(),
            group: Group::Preflop,
            players: Players::Any,
            label: text("L"),
            name: text("N"),
            description: text("D"),
            formula: "pct(an_mine, an_mine_opp)".to_owned(),
            format: Format {
                unit: Unit::Percent,
                decimals: 1,
            },
            sample: SampleDef { of: None, min: 50 },
            bands: Vec::new(),
            hud: HudPlace::None,
        },
        predicate: Some("first street = river => action = fold".to_owned()),
    };
    let problems = CustomSet::default()
        .validate(&def, None, &[])
        .expect_err("refused");
    assert!(
        problems
            .iter()
            .any(|p| p.message.contains("already the name")),
        "{problems:?}"
    );
}

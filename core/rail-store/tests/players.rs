//! The Players screen's store (docs/RAIL-PLAN.md R2.7c) on the corpus: the
//! list is the opponents of rooms with real names and never an opaque
//! token or a seat label, sorted and searched as the web's
//! `stats_opponents`, with its money refusal; a profile's positions add up
//! to its rollups; "hands with this player" is exactly their hands, with
//! any other filter; notes, colours and labels keep the web's rules and
//! limits; and a store from version 8 gets its summary.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_store::hand_list::{HandCursor, HandFilter, HandRow, PlayerRef};
use rail_store::import::ImportOptions;
use rail_store::players::{self, GameKind, LABELS_MAX, NOTE_MAX_CHARS, PlayerQuery};
use rail_store::{Error, Store, Totals, background, import_file};
use rusqlite::Connection;

use common::{
    DOWN_FROM_9, PARSED_AT, Rng, assert_integrity, corpus_files, scratch_dir, stats_snapshot,
};

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// The whole corpus, imported once per test binary.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("players-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        for file in corpus_files() {
            import_file(&store, &file, &options()).expect("import");
        }
        index(&store);
        store.close();
        path
    })
}

/// The background pass's `player_hands` steps, to the end (not the EV).
fn index(store: &Store) -> usize {
    let writer = store.writer().expect("writer");
    let mut hands = 0;
    loop {
        match background::step(store.reader(), &writer, false).expect("step") {
            background::Step::Nothing => return hands,
            background::Step::Indexed(n) => hands += n,
            _ => {}
        }
    }
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

/// An opponent's seat rows as SQL sees them: (site, player) -> hand keys,
/// for the villains of rooms with real names (scope `''`).
fn opponents(conn: &Connection) -> BTreeMap<(String, String), BTreeSet<String>> {
    let mut out: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT g.site, s.player, d.hand_key FROM seat_stats s
             JOIN hand_stats d ON d.id = s.hand_id JOIN segments g ON g.id = d.segment_id
             WHERE s.is_hero = 0 AND s.scope = '' AND s.player <> ''",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("rows");
    while let Some(row) = rows.next().expect("row") {
        out.entry((row.get(0).expect("site"), row.get(1).expect("player")))
            .or_default()
            .insert(row.get(2).expect("key"));
    }
    out
}

fn everyone(kind: GameKind) -> PlayerQuery {
    PlayerQuery {
        kind,
        limit: players::LIST_MAX,
        ..PlayerQuery::default()
    }
}

#[test]
fn the_list_is_the_opponents_of_rooms_with_names() {
    let store = Store::open(corpus_store()).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    assert_integrity(&conn);
    let reader = store.reader();
    let named = opponents(&conn);
    assert!(named.len() > 100, "the corpus has opponents");

    // Every opponent with hands together, in one long list per kind.
    let all = reader
        .player_list(&PlayerQuery {
            limit: 100_000,
            ..everyone(GameKind::All)
        })
        .expect("list");
    assert!(all.rows.len() <= usize::try_from(players::LIST_MAX).expect("max"));
    // The corpus mixes cash and tournaments: no result, as the web.
    assert!(all.mixed_kind);
    assert!(all.rows.iter().all(|row| row.net_bb_milli.is_none()));
    assert!(all.cash_hands > 0 && all.chips_hands > 0);
    for pair in all.rows.windows(2) {
        assert!(
            (pair[0].hands, &pair[1].player) >= (pair[1].hands, &pair[0].player),
            "most hands first, then by name"
        );
    }
    for row in &all.rows {
        let key = (row.site.clone(), row.player.clone());
        let hands = named
            .get(&key)
            .unwrap_or_else(|| panic!("{key:?} listed without rows at scope ''"));
        assert!(row.seen.hands <= i64::try_from(hands.len()).expect("n"));
        assert_eq!(row.hands, row.seen.cash_hands + row.seen.chips_hands);
    }

    // One kind: its hands together and its result; nobody without hands in it.
    for kind in [GameKind::Cash, GameKind::Chips] {
        let list = reader.player_list(&everyone(kind)).expect("list");
        assert!(!list.mixed_kind);
        for row in &list.rows {
            let (hands, net, money) = match kind {
                GameKind::Cash => (
                    row.seen.cash_hands,
                    row.seen.cash_net_bb_milli,
                    row.seen.cash_money_hands,
                ),
                _ => (
                    row.seen.chips_hands,
                    row.seen.chips_net_bb_milli,
                    row.seen.chips_money_hands,
                ),
            };
            assert!(hands > 0);
            assert_eq!(
                (row.hands, row.net_bb_milli, row.money_hands),
                (hands, Some(net), money)
            );
        }
        assert!(list.players > 0);
    }

    // The hero's result against an opponent: the hero's net in the hands
    // they shared, an EV cashout's out (the web's `stats_opponents` join).
    let cash = reader.player_list(&everyone(GameKind::Cash)).expect("list");
    for row in cash.rows.iter().take(25) {
        let (net, hands): (i64, i64) = conn
            .query_row(
                "SELECT coalesce(sum(l.hero_net_bb_milli), 0), count(*)
                 FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
                 JOIN segments g ON g.id = d.segment_id
                 JOIN hand_list l ON l.hand_key = d.hand_key
                 WHERE s.player = ?2 AND s.is_hero = 0 AND s.scope = '' AND g.site = ?1
                   AND g.game_format = 'cash' AND d.is_bomb_pot = 0 AND d.has_cashout = 0
                   AND l.hero_net IS NOT NULL",
                [&row.site, &row.player],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("result");
        assert_eq!(
            (row.net_bb_milli, row.money_hands),
            (Some(net), hands),
            "{}",
            row.player
        );
    }
    store.close();
}

#[test]
fn search_is_a_prefix_of_the_name_in_any_case() {
    let store = Store::open(corpus_store()).expect("open");
    let reader = store.reader();
    let all = reader.player_list(&everyone(GameKind::All)).expect("list");
    let mut rng = Rng::new(0x7C);
    for _ in 0..40 {
        let pick = &all.rows
            [usize::try_from(rng.below(u64::try_from(all.rows.len()).expect("n"))).expect("index")];
        let chars: Vec<char> = pick.player.chars().collect();
        let take =
            1 + usize::try_from(rng.below(u64::try_from(chars.len()).expect("n"))).expect("n");
        let prefix: String = chars[..take].iter().collect();
        for query in [
            prefix.to_uppercase(),
            prefix.to_lowercase(),
            format!("  {prefix} "),
        ] {
            let found = reader
                .player_list(&PlayerQuery {
                    search: query.clone(),
                    limit: players::LIST_MAX,
                    ..PlayerQuery::default()
                })
                .expect("search");
            let needle = query.trim().to_lowercase();
            assert!(
                found
                    .rows
                    .iter()
                    .all(|row| row.player.to_lowercase().starts_with(&needle)),
                "{query}"
            );
            assert!(
                found
                    .rows
                    .iter()
                    .any(|row| row.player == pick.player && row.site == pick.site),
                "{query} finds {}",
                pick.player
            );
            assert_eq!(
                found.players, all.players,
                "the scope does not move with the search"
            );
        }
    }
    // A pattern character is a character: `%` finds nobody.
    let none = reader
        .player_list(&PlayerQuery {
            search: "%".to_owned(),
            limit: 10,
            ..PlayerQuery::default()
        })
        .expect("search");
    assert!(none.rows.iter().all(|row| row.player.starts_with('%')));
    // A room: only its players, its own counts.
    let site = all.rows[0].site.clone();
    let one = reader
        .player_list(&PlayerQuery {
            site: Some(site.clone()),
            ..everyone(GameKind::All)
        })
        .expect("site");
    assert!(one.rows.iter().all(|row| row.site == site));
    assert!(one.players <= all.players);
    store.close();
}

/// Opaque tokens are counted, never listed or summed across sessions; a
/// positional room has no opponents at all.
#[test]
fn anonymised_rooms_are_counted_not_listed() {
    let store = Store::open(corpus_store()).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let reader = store.reader();
    let named = opponents(&conn);
    let mut stmt = conn
        .prepare(
            "SELECT g.site, s.player, count(*) FROM seat_stats s
             JOIN hand_stats d ON d.id = s.hand_id JOIN segments g ON g.id = d.segment_id
             WHERE s.is_hero = 0 AND s.scope <> '' AND d.is_bomb_pot = 0
             GROUP BY g.site, s.player",
        )
        .expect("prepare");
    let opaque: Vec<(String, String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("opaque")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert!(!opaque.is_empty(), "the corpus has opaque-id hands");
    let hidden: i64 = opaque.iter().map(|(_, _, n)| n).sum();
    let list = reader.player_list(&everyone(GameKind::All)).expect("list");
    assert_eq!(list.hidden_hands, hidden);
    for (site, player, _) in &opaque {
        let found = reader
            .player_list(&PlayerQuery {
                search: player.clone(),
                site: Some(site.clone()),
                ..everyone(GameKind::All)
            })
            .expect("search");
        // Listed only if the same name is also a real opponent's there.
        if !named.contains_key(&(site.clone(), player.clone())) {
            assert!(
                found.rows.iter().all(|row| &row.player != player),
                "the token {player} of {site} is listed"
            );
        }
        let profile = reader.player_profile(site, player).expect("profile");
        if !named.contains_key(&(site.clone(), player.clone())) {
            assert!(profile.seen.is_none() && profile.rollups.is_empty());
        }
    }
    // Positional rooms (Ignition): hero rows only.
    let positional: i64 = conn
        .query_row(
            "SELECT count(*) FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
             WHERE d.site_anonymization = 'positional' AND s.is_hero = 0",
            [],
            |row| row.get(0),
        )
        .expect("positional");
    assert_eq!(positional, 0);
    store.close();
}

/// The profile: its rollups and the summary agree, and the positions' pass
/// over the seat rows adds up to the rollups, every column. (A name that is
/// also the hero's somewhere - the corpus's anonymised files call several
/// heroes `Player0` - has the hero's rows in its rollups too, as the HUD
/// reads them; those are left out here.)
#[test]
fn a_profile_by_position_adds_up_to_its_rollups() {
    let store = Store::open(corpus_store()).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let heroes: BTreeSet<String> = conn
        .prepare("SELECT DISTINCT player FROM seat_stats WHERE is_hero = 1")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("heroes")
        .collect::<Result<_, _>>()
        .expect("rows");
    let reader = store.reader();
    let list = reader.player_list(&everyone(GameKind::All)).expect("list");
    let mut checked = 0;
    for row in list
        .rows
        .iter()
        .filter(|row| !heroes.contains(&row.player))
        .take(60)
    {
        checked += 1;
        let profile = reader
            .player_profile(&row.site, &row.player)
            .expect("profile");
        assert_eq!(profile.seen.as_ref(), Some(&row.seen));
        let mut rollups = Totals::default();
        for rollup in &profile.rollups {
            rollups.add(&rollup.totals, true);
        }
        assert_eq!(rollups.hands(), row.seen.hands);
        let positions = reader
            .player_positions(&row.site, &row.player, None)
            .expect("positions");
        let mut sum = Totals::default();
        for totals in positions.positions.values() {
            sum.add(totals, true);
        }
        assert_eq!(sum, rollups, "{}: positions vs rollups", row.player);
        // One segment: that segment's rollup.
        if let Some(rollup) = profile.rollups.first() {
            let one = reader
                .player_positions(&row.site, &row.player, Some(&[rollup.segment_id]))
                .expect("one segment");
            let mut sum = Totals::default();
            for totals in one.positions.values() {
                sum.add(totals, true);
            }
            assert_eq!(sum, rollup.totals);
        }
    }
    assert_eq!(checked, 60);
    store.close();
}

fn all_pages(store: &Store, filter: &HandFilter, limit: u32) -> Vec<HandRow> {
    let mut rows = Vec::new();
    let mut after: Option<HandCursor> = None;
    loop {
        let page = store
            .reader()
            .hand_page(filter, after.as_ref(), limit)
            .expect("page");
        rows.extend(page.rows);
        match page.next {
            Some(next) => after = Some(next),
            None => return rows,
        }
    }
}

/// "Hands with this player": exactly the hands of their seat rows in their
/// room, newest first, with any other filter on top; the counts agree.
#[test]
fn hands_with_a_player_are_their_hands() {
    let store = Store::open(corpus_store()).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let named = opponents(&conn);
    let everything = all_pages(&store, &HandFilter::default(), 500);
    let mut rng = Rng::new(0xC0FFEE);
    let keys: Vec<&(String, String)> = named.keys().collect();
    for round in 0..80 {
        let (site, player) =
            keys[usize::try_from(rng.below(u64::try_from(keys.len()).expect("n"))).expect("index")];
        let mut filter = HandFilter {
            player: Some(PlayerRef {
                site: site.clone(),
                player: player.clone(),
            }),
            ..HandFilter::default()
        };
        // Every few rounds, another filter on top.
        if round % 3 == 1 {
            filter.results = vec!["won".to_owned()];
        }
        if round % 5 == 2 {
            filter.positions = vec!["BTN".to_owned(), "BB".to_owned()];
        }
        let hands = &named[&(site.clone(), player.clone())];
        let expected: Vec<&HandRow> = everything
            .iter()
            .filter(|row| hands.contains(&row.hand_key))
            .filter(|row| filter.results.is_empty() || row.hero_net.is_some_and(|net| net > 0))
            .filter(|row| {
                filter.positions.is_empty()
                    || row
                        .hero_position
                        .as_ref()
                        .is_some_and(|p| filter.positions.contains(p))
            })
            .collect();
        let limit = 1 + u32::try_from(rng.below(40)).expect("limit");
        let got = all_pages(&store, &filter, limit);
        let got_keys: Vec<&String> = got.iter().map(|row| &row.hand_key).collect();
        let want_keys: Vec<&String> = expected.iter().map(|row| &row.hand_key).collect();
        assert_eq!(got_keys, want_keys, "{player} on {site}");
        let facets = store.reader().hand_facets(&filter).expect("facets");
        assert_eq!(facets.total, u64::try_from(want_keys.len()).expect("n"));
    }
    // A name on another site: nothing.
    let (site, player) = keys[0];
    let elsewhere = HandFilter {
        player: Some(PlayerRef {
            site: format!("{site}-elsewhere"),
            player: player.clone(),
        }),
        ..HandFilter::default()
    };
    assert!(all_pages(&store, &elsewhere, 50).is_empty());
    store.close();
}

/// The opponent with the most hands together.
fn listed(store: &Store) -> (String, String) {
    let list = store
        .reader()
        .player_list(&PlayerQuery {
            limit: 1,
            ..PlayerQuery::default()
        })
        .expect("list");
    let row = list.rows.first().expect("an opponent");
    (row.site.clone(), row.player.clone())
}

fn write<T: Send + 'static>(
    store: &Store,
    f: impl FnOnce(&rusqlite::Transaction<'_>) -> rail_store::Result<T> + Send + 'static,
) -> rail_store::Result<T> {
    store.writer().expect("writer").write(f)
}

/// The import leaves `player_hands` to the background pass: hands imported
/// after it ran are found once it runs again; a rebuild that reuses an id
/// the pass has gone past writes that hand's entries itself.
#[test]
fn player_hands_follow_the_background_pass() {
    let path = scratch_dir("players-pass").join("rail.db");
    let store = Store::open(&path).expect("open");
    let files = corpus_files();
    let (first, rest) = files.split_at(files.len() / 2);
    for file in first {
        import_file(&store, file, &options()).expect("import");
    }
    let conn = Connection::open(&path).expect("open");
    let entries = |conn: &Connection| -> i64 {
        conn.query_row("SELECT count(*) FROM player_hands", [], |row| row.get(0))
            .expect("count")
    };
    assert_eq!(entries(&conn), 0, "the import writes none");
    assert!(
        store
            .reader()
            .stats_status()
            .expect("status")
            .players_unindexed
            > 0
    );
    assert!(index(&store) > 0);
    let before = entries(&conn);
    assert!(before > 0);
    assert_eq!(
        store
            .reader()
            .stats_status()
            .expect("status")
            .players_unindexed,
        0
    );
    for file in rest {
        import_file(&store, file, &options()).expect("import");
    }
    assert_eq!(entries(&conn), before, "new hands wait for the pass");
    assert_integrity(&conn);
    index(&store);
    assert!(entries(&conn) > before);
    assert_integrity(&conn);
    // A rebuild replaces every hand's rows; the pass catches up after it.
    write(&store, |tx| rail_store::stats::begin_rebuild(tx)).expect("rebuild");
    let writer = store.writer().expect("writer");
    background::drain(store.reader(), &writer).expect("drain");
    drop(writer);
    assert_integrity(&conn);
    assert_eq!(
        store
            .reader()
            .stats_status()
            .expect("status")
            .players_unindexed,
        0
    );
    let complete: i64 = conn
        .query_row(
            "SELECT count(*) FROM seat_stats WHERE is_hero = 0 AND scope = '' AND player <> ''",
            [],
            |row| row.get(0),
        )
        .expect("rows");
    assert_eq!(entries(&conn), complete);
    store.close();
}

/// Notes, colours and labels: on opponents of rooms with real names only,
/// within the web's limits; clearing removes the row.
#[test]
fn notes_colours_and_labels() {
    let path = copy_of_corpus("players-notes");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let (site, player) = listed(&store);
    let (s, p) = (site.clone(), player.clone());
    write(&store, move |tx| {
        players::set_note(tx, &s, &p, "  3-bets light  ", 1)
    })
    .expect("note");
    let (s, p) = (site.clone(), player.clone());
    write(&store, move |tx| {
        players::set_colour(tx, &s, &p, Some("red"), 2)
    })
    .expect("colour");
    for label in ["Fish", " fish ", "Calls Down"] {
        let (s, p) = (site.clone(), player.clone());
        write(&store, move |tx| players::add_label(tx, &s, &p, label, 3)).expect("label");
    }
    let notes = store.reader().player_notes(&site, &player).expect("notes");
    assert_eq!(notes.note, "3-bets light");
    assert_eq!(notes.colour.as_deref(), Some("red"));
    assert_eq!(notes.labels, ["calls down", "fish"]);
    assert_eq!(
        store.reader().player_labels().expect("labels"),
        [("calls down".to_owned(), 1), ("fish".to_owned(), 1)]
    );

    // The list's filters by colour, label and note.
    let by = |query: PlayerQuery| {
        store
            .reader()
            .player_list(&PlayerQuery {
                limit: players::LIST_MAX,
                ..query
            })
            .expect("list")
    };
    for query in [
        PlayerQuery {
            colours: vec!["red".to_owned()],
            ..PlayerQuery::default()
        },
        PlayerQuery {
            labels: vec!["fish".to_owned()],
            ..PlayerQuery::default()
        },
        PlayerQuery {
            noted: Some(true),
            ..PlayerQuery::default()
        },
    ] {
        let list = by(query);
        assert_eq!(list.rows.len(), 1);
        assert_eq!(list.rows[0].player, player);
        assert!(list.rows[0].has_note);
        assert_eq!(list.rows[0].colour.as_deref(), Some("red"));
        assert_eq!(list.rows[0].labels, ["calls down", "fish"]);
    }
    let unnoted = by(PlayerQuery {
        noted: Some(false),
        ..PlayerQuery::default()
    });
    assert!(
        unnoted
            .rows
            .iter()
            .all(|row| row.player != player || row.site != site)
    );

    // Limits: a ninth label, a long label, a long note, a colour off the palette.
    for n in 2..LABELS_MAX {
        let (s, p) = (site.clone(), player.clone());
        write(&store, move |tx| {
            players::add_label(tx, &s, &p, &format!("l{n}"), 4)
        })
        .expect("label");
    }
    let (s, p) = (site.clone(), player.clone());
    assert!(matches!(
        write(&store, move |tx| players::add_label(tx, &s, &p, "ninth", 5)),
        Err(Error::OutOfRange("labels"))
    ));
    let (s, p) = (site.clone(), player.clone());
    assert!(
        write(&store, move |tx| players::add_label(
            tx,
            &s,
            &p,
            &"x".repeat(25),
            5
        ))
        .is_err()
    );
    let (s, p) = (site.clone(), player.clone());
    assert!(
        write(&store, move |tx| players::set_note(
            tx,
            &s,
            &p,
            &"n".repeat(NOTE_MAX_CHARS + 1),
            5
        ))
        .is_err()
    );
    let (s, p) = (site.clone(), player.clone());
    assert!(
        write(&store, move |tx| players::set_colour(
            tx,
            &s,
            &p,
            Some("pink"),
            5
        ))
        .is_err()
    );

    // Nobody but an opponent of a room with names: not the hero, not an
    // opaque token, not a seat label, not a stranger.
    let hero: (String, String) = conn
        .query_row(
            "SELECT g.site, s.player FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
             JOIN segments g ON g.id = d.segment_id
             WHERE s.is_hero = 1 AND s.player <> '' AND NOT EXISTS
               (SELECT 1 FROM seat_stats v WHERE v.player = s.player AND v.is_hero = 0
                  AND v.scope = '')
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("a hero");
    let token: (String, String) = conn
        .query_row(
            "SELECT g.site, s.player FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
             JOIN segments g ON g.id = d.segment_id
             WHERE s.is_hero = 0 AND s.scope <> '' AND NOT EXISTS
               (SELECT 1 FROM seat_stats v WHERE v.player = s.player AND v.is_hero = 0
                  AND v.scope = '')
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("an opaque token");
    for (s, p) in [
        hero,
        token,
        ("ignition".to_owned(), "UTG+1".to_owned()),
        (site.clone(), "nobody-at-all".to_owned()),
        (site.clone(), String::new()),
    ] {
        let (s2, p2) = (s.clone(), p.clone());
        assert!(
            matches!(
                write(&store, move |tx| players::set_note(tx, &s2, &p2, "x", 6)),
                Err(Error::NotAnOpponent)
            ),
            "{s} {p}"
        );
        let (s2, p2) = (s.clone(), p.clone());
        assert!(matches!(
            write(&store, move |tx| players::set_colour(
                tx,
                &s2,
                &p2,
                Some("blue"),
                6
            )),
            Err(Error::NotAnOpponent)
        ));
        let (s2, p2) = (s.clone(), p.clone());
        assert!(matches!(
            write(&store, move |tx| players::add_label(tx, &s2, &p2, "reg", 6)),
            Err(Error::NotAnOpponent)
        ));
    }

    // Clearing: the note and colour gone removes the row; labels go one by one.
    let (s, p) = (site.clone(), player.clone());
    write(&store, move |tx| players::set_note(tx, &s, &p, "   ", 7)).expect("clear note");
    let (s, p) = (site.clone(), player.clone());
    write(&store, move |tx| players::set_colour(tx, &s, &p, None, 7)).expect("clear colour");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM players", [], |row| row.get(0))
        .expect("count");
    assert_eq!(rows, 0);
    for label in store
        .reader()
        .player_notes(&site, &player)
        .expect("notes")
        .labels
    {
        let (s, p) = (site.clone(), player.clone());
        assert!(
            write(&store, move |tx| players::remove_label(tx, &s, &p, &label)).expect("remove")
        );
    }
    assert_eq!(
        store.reader().player_notes(&site, &player).expect("notes"),
        players::PlayerNotes::default()
    );
    store.close();
}

/// The user's words outlive a rebuild of the statistics (no foreign key to
/// the derived rows), and the list reads them after it.
#[test]
fn notes_survive_a_rebuild() {
    let path = copy_of_corpus("players-rebuild");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let (site, player) = listed(&store);
    let (s, p) = (site.clone(), player.clone());
    write(&store, move |tx| {
        players::set_colour(tx, &s, &p, Some("green"), 1)
    })
    .expect("colour");
    let before = stats_snapshot(&conn);
    write(&store, |tx| rail_store::stats::begin_rebuild(tx)).expect("rebuild");
    let writer = store.writer().expect("writer");
    background::drain(store.reader(), &writer).expect("drain");
    drop(writer);
    let after = stats_snapshot(&conn);
    assert!(after.summary == before.summary && after.hidden == before.hidden);
    let found = store
        .reader()
        .player_list(&PlayerQuery {
            colours: vec!["green".to_owned()],
            limit: 10,
            ..PlayerQuery::default()
        })
        .expect("list");
    assert_eq!(found.matching, 1);
    assert_integrity(&conn);
    store.close();
}

/// A store from version 8 (no `players` tables) gets them: the migration
/// forgets the statistics version, opening starts a rebuild, and the pass
/// writes the summary an import writes.
#[test]
fn a_version_8_store_gets_its_summary() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    assert!(!reference.summary.is_empty() && !reference.hidden.is_empty());
    let path = copy_of_corpus("players-v8");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(DOWN_FROM_9).expect("back to version 8");
        conn.execute_batch("PRAGMA user_version = 8;")
            .expect("version 8");
    }
    let store = Store::open(&path).expect("open");
    let status = store.reader().stats_status().expect("status");
    assert!(status.rebuild.is_some(), "opening starts a rebuild");
    let writer = store.writer().expect("writer");
    background::drain(store.reader(), &writer).expect("drain");
    drop(writer);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let upgraded = stats_snapshot(&conn);
    assert!(
        upgraded.summary == reference.summary,
        "the rebuilt summary differs"
    );
    assert!(upgraded.hidden == reference.hidden);
    assert!(upgraded.seats == reference.seats);
}

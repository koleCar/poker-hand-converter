//! The Hands screen's queries (docs/RAIL-PLAN.md R2.7a) on the corpus: the
//! list's rows are the hands, pages are stable while hands arrive, every
//! filter and every chip's count is what a scan of the hands says, notes,
//! tags and saved filters round-trip, "go to hand" finds ids, and a store
//! from version 6 gets its list.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_core::phf::PhfHand;
use rail_core::phf::hand::primary_board;
use rail_stats::{Segment, stored_rows};
use rail_store::batch::decompress_phf;
use rail_store::hand_list::{
    self, HandCursor, HandFacets, HandFilter, HandRow, RESULTS, STACK_DEPTHS,
};
use rail_store::import::ImportOptions;
use rail_store::{Store, background, import_file};
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

fn import_into(store: &Store, files: &[PathBuf]) {
    for file in files {
        import_file(store, file, &options()).expect("import");
    }
}

/// The whole corpus, imported once per test binary.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("list-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        import_into(&store, &corpus_files());
        store.close();
        path
    })
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

/// Every page of `filter`, `limit` rows a page.
fn all_pages(store: &Store, filter: &HandFilter, limit: u32) -> Vec<HandRow> {
    let mut rows = Vec::new();
    let mut after: Option<HandCursor> = None;
    loop {
        let page = store
            .reader()
            .hand_page(filter, after.as_ref(), limit)
            .expect("page");
        assert!(page.rows.len() <= usize::try_from(limit).expect("limit"));
        rows.extend(page.rows);
        match page.next {
            Some(next) => after = Some(next),
            None => return rows,
        }
    }
}

fn order_key(row: &HandRow) -> (String, String) {
    (
        row.played_at.clone().unwrap_or_default(),
        row.hand_key.clone(),
    )
}

/// Newest first, each hand once.
fn assert_ordered(rows: &[HandRow]) {
    for pair in rows.windows(2) {
        assert!(
            order_key(&pair[0]) > order_key(&pair[1]),
            "out of order: {} then {}",
            pair[0].hand_key,
            pair[1].hand_key
        );
    }
}

/// A list row with what a scan needs to judge it: the hand, its segment
/// and hero facts from the engine.
struct Item {
    row: HandRow,
    segment: Segment,
    stack: Option<i64>,
}

fn stored_hand(conn: &Connection, hand_key: &str) -> PhfHand {
    let (blob, size): (Vec<u8>, i64) = conn
        .query_row(
            "SELECT phf, phf_size FROM hands WHERE hand_key = ?1",
            [hand_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("hand");
    let json = decompress_phf(&blob, u64::try_from(size).expect("size")).expect("phf");
    serde_json::from_str(&json).expect("a stored PHF parses")
}

/// The universe: every row of the list with its engine facts, checked
/// against the PHF on the way.
fn items(store: &Store) -> Vec<Item> {
    let rows = all_pages(store, &HandFilter::default(), 113);
    let conn = Connection::open(store.path()).expect("open");
    rows.into_iter()
        .map(|row| {
            let hand = stored_hand(&conn, &row.hand_key);
            let stored = stored_rows(&hand, true);
            let hero = stored.rows.iter().find(|r| r.seat.is_hero);
            assert_eq!(row.board, primary_board(&hand), "{}: board", row.hand_key);
            assert_eq!(row.played_at, hand.played_at, "{}", row.hand_key);
            assert_eq!(row.site_hand_id, hand.meta.hand_id);
            assert_eq!(row.currency, hand.game.unit.code);
            assert_eq!(row.currency_symbol, hand.game.unit.symbol);
            assert_eq!(row.minor_units, i64::from(hand.game.unit.minor_units));
            assert_eq!(
                (row.small_blind, row.big_blind),
                (hand.game.small_blind, hand.game.big_blind)
            );
            assert_eq!(row.total_pot, hand.results.total_pot);
            assert_eq!(row.showdown, hand.results.went_to_showdown);
            assert_eq!(
                row.hero_position,
                hero.and_then(|h| h.seat.position.map(|p| p.as_str().to_owned()))
            );
            assert_eq!(
                row.hero_cards,
                hero.map(|h| h.seat.hole_cards.clone()).unwrap_or_default()
            );
            assert_eq!(row.hero_net, hero.map(|h| h.seat.money.net));
            assert_eq!(
                row.hero_net_bb_milli,
                hero.map(|h| h.seat.money.net_bb_milli)
            );
            assert_eq!(
                row.pot_type,
                stored.rows.first().expect("rows").hand.pot_type.as_str()
            );
            Item {
                stack: hero.map(|h| h.seat.starting_stack_bb_tenths),
                segment: stored.segment,
                row,
            }
        })
        .collect()
}

fn result_of(item: &Item) -> &'static str {
    match item.row.hero_net {
        None => "",
        Some(net) if net > 0 => "won",
        Some(net) if net < 0 => "lost",
        Some(_) => "even",
    }
}

fn stack_of(item: &Item) -> &'static str {
    let Some(stack) = item.stack else { return "" };
    STACK_DEPTHS
        .iter()
        .find(|(_, from, below)| stack >= *from && below.is_none_or(|below| stack < below))
        .map_or("", |(id, _, _)| id)
}

/// The values of an item for the eleven chip groups, in `HandFacets` order.
fn values(item: &Item) -> [String; 11] {
    let s = &item.segment;
    [
        s.site.clone(),
        s.format.as_str().to_owned(),
        s.variant.as_str().to_owned(),
        s.limit.as_str().to_owned(),
        s.size.as_str().to_owned(),
        s.stake.key(),
        item.row.hero_position.clone().unwrap_or_default(),
        item.row.pot_type.clone(),
        result_of(item).to_owned(),
        stack_of(item).to_owned(),
        if item.row.all_in { "1" } else { "0" }.to_owned(),
    ]
}

fn groups(filter: &HandFilter) -> [Option<Vec<String>>; 11] {
    let set = |values: &Vec<String>| (!values.is_empty()).then(|| values.clone());
    [
        set(&filter.sites),
        set(&filter.formats),
        set(&filter.variants),
        set(&filter.limits),
        set(&filter.sizes),
        set(&filter.stakes),
        set(&filter.positions),
        set(&filter.pot_types),
        set(&filter.results),
        set(&filter.stacks),
        filter
            .all_in
            .map(|all_in| vec![if all_in { "1" } else { "0" }.to_owned()]),
    ]
}

/// The date range, notes and tags.
fn base_matches(filter: &HandFilter, item: &Item) -> bool {
    let played = item.row.played_at.as_deref().unwrap_or("");
    if let Some(from) = &filter.from
        && (played.is_empty() || played < from.as_str())
    {
        return false;
    }
    if let Some(to) = &filter.to
        && (played.is_empty() || played >= to.as_str())
    {
        return false;
    }
    if let Some(has_note) = filter.has_note
        && item.row.has_note != has_note
    {
        return false;
    }
    filter.tags.is_empty() || item.row.tags.iter().any(|tag| filter.tags.contains(tag))
}

/// Whether `item` matches `filter`, leaving out group `skip`.
fn matches(filter: &HandFilter, item: &Item, skip: Option<usize>) -> bool {
    if !base_matches(filter, item) {
        return false;
    }
    let values = values(item);
    groups(filter)
        .iter()
        .enumerate()
        .all(|(i, group)| Some(i) == skip || group.as_ref().is_none_or(|g| g.contains(&values[i])))
}

/// A random filter over the values the corpus has.
fn random_filter(rng: &mut Rng, items: &[Item], tags: &[String]) -> HandFilter {
    let mut present: [BTreeSet<String>; 11] = Default::default();
    for item in items {
        for (i, value) in values(item).into_iter().enumerate() {
            if !value.is_empty() {
                present[i].insert(value);
            }
        }
    }
    let pick = |i: usize, rng: &mut Rng| -> Vec<String> {
        if rng.below(3) != 0 {
            return Vec::new();
        }
        let all: Vec<&String> = present[i].iter().collect();
        let n = 1 + rng.below(2);
        (0..n)
            .map(|_| all[usize::try_from(rng.below(all.len() as u64)).expect("index")].clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    let mut filter = HandFilter {
        sites: pick(0, rng),
        formats: pick(1, rng),
        variants: pick(2, rng),
        limits: pick(3, rng),
        sizes: pick(4, rng),
        stakes: pick(5, rng),
        positions: pick(6, rng),
        pot_types: pick(7, rng),
        results: pick(8, rng),
        stacks: pick(9, rng),
        ..HandFilter::default()
    };
    if rng.below(5) == 0 {
        filter.all_in = Some(rng.below(2) == 0);
    }
    if rng.below(6) == 0 {
        filter.has_note = Some(rng.below(2) == 0);
    }
    if rng.below(6) == 0 {
        filter.tags = vec![tags[usize::try_from(rng.below(tags.len() as u64)).expect("i")].clone()];
    }
    if rng.below(3) == 0 {
        let dated: Vec<&str> = items
            .iter()
            .filter_map(|item| item.row.played_at.as_deref())
            .collect();
        let a = dated[usize::try_from(rng.below(dated.len() as u64)).expect("i")];
        let b = dated[usize::try_from(rng.below(dated.len() as u64)).expect("i")];
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        match rng.below(3) {
            0 => filter.from = Some(lo.to_owned()),
            1 => filter.to = Some(hi.to_owned()),
            _ => {
                filter.from = Some(lo.to_owned());
                filter.to = Some(hi.to_owned());
            }
        }
    }
    filter
}

/// What `hand_facets` should say for `filter`, from a scan.
fn expected_facets(filter: &HandFilter, items: &[Item]) -> [BTreeMap<String, u64>; 11] {
    let mut out: [BTreeMap<String, u64>; 11] = Default::default();
    for item in items.iter().filter(|item| base_matches(filter, item)) {
        for (i, value) in values(item).into_iter().enumerate() {
            if (i == 8 || i == 9) && value.is_empty() {
                continue;
            }
            let count = out[i].entry(value).or_insert(0);
            if matches(filter, item, Some(i)) {
                *count += 1;
            }
        }
    }
    out
}

fn facet_maps(facets: &HandFacets) -> [BTreeMap<String, u64>; 11] {
    let map = |list: &Vec<hand_list::FacetCount>| -> BTreeMap<String, u64> {
        list.iter().map(|f| (f.value.clone(), f.count)).collect()
    };
    [
        map(&facets.sites),
        map(&facets.formats),
        map(&facets.variants),
        map(&facets.limits),
        map(&facets.sizes),
        facets
            .stakes
            .iter()
            .map(|f| (f.value.clone(), f.count))
            .collect(),
        map(&facets.positions),
        map(&facets.pot_types),
        map(&facets.results),
        map(&facets.stacks),
        map(&facets.all_in),
    ]
}

/// Every hand with statistics rows is in the list once, newest first, with
/// what its PHF and the engine say; after the EV pass its all-in flag is
/// whether it has an EV row.
#[test]
fn the_list_is_the_hands() {
    let path = copy_of_corpus("list-rows");
    let store = Store::open(&path).expect("open");
    let items = items(&store);
    assert_ordered(&items.iter().map(|i| i.row.clone()).collect::<Vec<_>>());
    let conn = Connection::open(&path).expect("open");
    let with_rows: i64 = conn
        .query_row("SELECT count(*) FROM hand_stats", [], |row| row.get(0))
        .expect("count");
    assert_eq!(items.len(), usize::try_from(with_rows).expect("n"));
    assert!(items.len() > 7000, "the corpus has {} hands", items.len());
    // Hands without a hero, and with one in every result, are listed.
    assert!(items.iter().any(|i| i.row.hero_net.is_none()));
    for result in RESULTS {
        assert!(items.iter().any(|i| result_of(i) == result), "{result}");
    }
    assert!(items.iter().any(|i| i.row.board.is_empty()));
    assert!(items.iter().any(|i| i.row.showdown));
    assert!(items.iter().any(|i| i.row.ev_pending && i.row.all_in));
    assert_integrity(&conn);
    drop(conn);

    // The EV pass settles every all-in flag.
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    let after = all_pages(&store, &HandFilter::default(), 500);
    assert!(after.iter().all(|row| !row.ev_pending));
    assert!(
        after
            .iter()
            .all(|row| row.all_in == row.ev_net_bb_milli.is_some()),
        "all_in is whether the hand has an EV row"
    );
    let pending_before = items.iter().filter(|i| i.row.ev_pending).count();
    let applicable = after.iter().filter(|row| row.all_in).count();
    eprintln!("{applicable} all-in hands, {pending_before} were queued for the pass");
    store.close();
    assert_integrity(&Connection::open(&path).expect("open"));
}

/// Pages read before hands arrive and the pages after them make one list:
/// nothing twice, nothing older than the cursor missed.
#[test]
fn pages_are_stable_while_hands_arrive() {
    let files = corpus_files();
    let (first, second) = files.split_at(files.len() / 2);
    let path = scratch_dir("list-arrive").join("rail.db");
    let store = Store::open(&path).expect("open");
    import_into(&store, first);
    let filter = HandFilter::default();
    let mut seen = Vec::new();
    let mut after = None;
    for _ in 0..3 {
        let page = store
            .reader()
            .hand_page(&filter, after.as_ref(), 50)
            .expect("page");
        seen.extend(page.rows);
        after = page.next;
    }
    let cursor = after.expect("more than three pages");
    import_into(&store, second);
    let mut rest = Vec::new();
    let mut next = Some(cursor.clone());
    while let Some(at) = next {
        let page = store
            .reader()
            .hand_page(&filter, Some(&at), 64)
            .expect("page");
        rest.extend(page.rows);
        next = page.next;
    }
    let everything = all_pages(&store, &filter, 500);
    let older: Vec<&HandRow> = everything
        .iter()
        .filter(|row| order_key(row) < (cursor.played_at.clone(), cursor.hand_key.clone()))
        .collect();
    assert_eq!(rest.iter().collect::<Vec<_>>(), older);
    seen.extend(rest);
    assert_ordered(&seen);
    // A first page of the full store starts with what arrived since.
    assert!(everything.len() > seen.len());
    store.close();
}

/// Random filters: every page of the list and every chip's count are what
/// a scan of the hands says.
#[test]
fn filters_and_counts_match_a_scan() {
    let path = copy_of_corpus("list-filters");
    let store = Store::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    // Notes and tags on a seeded sample of hands.
    let keys: Vec<String> = all_pages(&store, &HandFilter::default(), 500)
        .into_iter()
        .map(|row| row.hand_key)
        .collect();
    let tags: Vec<String> = ["bluff", "hero call", "review later"]
        .iter()
        .map(|t| (*t).to_owned())
        .collect();
    let mut rng = Rng::new(0x5eed_2a7a);
    for key in &keys {
        let roll = rng.below(40);
        let key = key.clone();
        let tag = tags[usize::try_from(roll % 3).expect("i")].clone();
        writer
            .write(move |tx| {
                if roll < 3 {
                    hand_list::set_note(tx, &key, "a note", 1)?;
                }
                if roll < 6 {
                    hand_list::add_tag(tx, &key, &tag, 1)?;
                }
                Ok(())
            })
            .expect("annotate");
    }
    let items = items(&store);
    let seed = 0x0007_2a7a;
    let mut rng = Rng::new(seed);
    let mut nonempty = 0;
    for round in 0..150 {
        let filter = random_filter(&mut rng, &items, &tags);
        let expected: Vec<&str> = items
            .iter()
            .filter(|item| matches(&filter, item, None))
            .map(|item| item.row.hand_key.as_str())
            .collect();
        let limit = u32::try_from(1 + rng.below(120)).expect("limit");
        let got = all_pages(&store, &filter, limit);
        let got: Vec<&str> = got.iter().map(|row| row.hand_key.as_str()).collect();
        assert_eq!(got, expected, "seed {seed:#x} round {round}: {filter:?}");
        if !expected.is_empty() {
            nonempty += 1;
        }
        let facets = store.reader().hand_facets(&filter).expect("facets");
        assert_eq!(
            facets.total,
            u64::try_from(expected.len()).expect("n"),
            "round {round}: total"
        );
        assert_eq!(
            facet_maps(&facets),
            expected_facets(&filter, &items),
            "seed {seed:#x} round {round}: counts for {filter:?}"
        );
        for stake in &facets.stakes {
            if stake.value != "chips" {
                let bb = stake.value.rsplit(':').next().expect("bb");
                assert_eq!(stake.big_blind.map(|b| b.to_string()).as_deref(), Some(bb));
                assert!(stake.small_blind.is_some() && stake.currency_symbol.is_some());
            }
        }
    }
    assert!(nonempty > 60, "only {nonempty} filters matched anything");
    // A segment group no segment has: nothing, fast.
    let none = HandFilter {
        sites: vec!["no-such-room".to_owned()],
        ..HandFilter::default()
    };
    assert!(
        store
            .reader()
            .hand_page(&none, None, 10)
            .expect("page")
            .rows
            .is_empty()
    );
    drop(writer);
    store.close();
}

/// Notes, tags and saved filters round-trip; a note or tag shows on the
/// list row.
#[test]
fn notes_tags_and_saved_filters() {
    let path = copy_of_corpus("list-notes");
    let store = Store::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    let first = store
        .reader()
        .hand_page(&HandFilter::default(), None, 2)
        .expect("page")
        .rows;
    let (a, b) = (first[0].hand_key.clone(), first[1].hand_key.clone());
    let (ka, kb) = (a.clone(), b.clone());
    writer
        .write(move |tx| {
            hand_list::set_note(tx, &ka, "  Check the river sizing.\n", 10)?;
            assert!(hand_list::add_tag(tx, &ka, "  river   spot ", 10)?);
            assert!(!hand_list::add_tag(tx, &ka, "river spot", 11)?);
            assert!(hand_list::add_tag(tx, &ka, "bluff", 12)?);
            assert!(hand_list::add_tag(tx, &kb, "bluff", 12)?);
            assert!(hand_list::add_tag(tx, &kb, "", 12).is_err());
            assert!(hand_list::add_tag(tx, &kb, &"x".repeat(41), 12).is_err());
            Ok(())
        })
        .expect("write");
    let notes = store.reader().hand_annotations(&a).expect("annotations");
    assert_eq!(notes.note.as_deref(), Some("  Check the river sizing."));
    assert_eq!(notes.tags, ["bluff", "river spot"]);
    let tags = store.reader().hand_tags().expect("tags");
    assert_eq!(
        tags.iter()
            .map(|t| (t.value.as_str(), t.count))
            .collect::<Vec<_>>(),
        [("bluff", 2), ("river spot", 1)]
    );
    let rows = store
        .reader()
        .hand_rows(&[a.clone(), b.clone()])
        .expect("rows");
    assert_eq!(rows.len(), 2);
    assert!(rows[0].has_note && rows[0].tags == ["bluff", "river spot"]);
    assert!(!rows[1].has_note && rows[1].tags == ["bluff"]);
    let tagged = HandFilter {
        tags: vec!["river spot".to_owned()],
        ..HandFilter::default()
    };
    let only = all_pages(&store, &tagged, 10);
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].hand_key, a);
    // The counts follow a write (their cache is per committed version).
    let total = |store: &Store| store.reader().hand_facets(&tagged).expect("facets").total;
    assert_eq!((total(&store), total(&store)), (1, 1));
    let kb2 = b.clone();
    writer
        .write(move |tx| hand_list::add_tag(tx, &kb2, "river spot", 13))
        .expect("tag");
    assert_eq!(total(&store), 2);
    let kb2 = b.clone();
    writer
        .write(move |tx| hand_list::remove_tag(tx, &kb2, "river spot"))
        .expect("untag");
    assert_eq!(total(&store), 1);

    let ka = a.clone();
    writer
        .write(move |tx| {
            hand_list::set_note(tx, &ka, "   ", 20)?;
            assert!(hand_list::remove_tag(tx, &ka, "bluff")?);
            assert!(!hand_list::remove_tag(tx, &ka, "bluff")?);
            Ok(())
        })
        .expect("write");
    let notes = store.reader().hand_annotations(&a).expect("annotations");
    assert_eq!(notes.note, None);
    assert_eq!(notes.tags, ["river spot"]);
    assert_eq!(store.reader().noted_hands().expect("noted"), 0);

    let id = writer
        .write(|tx| hand_list::save_filter(tx, "hands", " BTN 3bet ", "{\"a\":1}", 5))
        .expect("save");
    let again = writer
        .write(|tx| hand_list::save_filter(tx, "hands", "BTN 3bet", "{\"a\":2}", 6))
        .expect("save");
    assert_eq!(id, again, "same name: replaced");
    writer
        .write(|tx| hand_list::save_filter(tx, "hands", "all-ins", "{}", 7))
        .expect("save");
    assert!(
        writer
            .write(|tx| hand_list::save_filter(tx, "hands", "  ", "{}", 7))
            .is_err()
    );
    let saved = store.reader().saved_filters("hands").expect("saved");
    assert_eq!(
        saved
            .iter()
            .map(|s| (s.name.as_str(), s.filter.as_str()))
            .collect::<Vec<_>>(),
        [("all-ins", "{}"), ("BTN 3bet", "{\"a\":2}")]
    );
    assert!(
        store
            .reader()
            .saved_filters("reports")
            .expect("saved")
            .is_empty()
    );
    assert!(
        writer
            .write(move |tx| hand_list::delete_saved_filter(tx, id))
            .expect("delete")
    );
    assert_eq!(
        store.reader().saved_filters("hands").expect("saved").len(),
        1
    );

    // The user's tables survive a rebuild of the derived rows.
    writer
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("rebuild");
    background::drain(store.reader(), &writer).expect("drain");
    let rows = store
        .reader()
        .hand_rows(std::slice::from_ref(&a))
        .expect("rows");
    assert_eq!(rows[0].tags, ["river spot"]);
    drop(writer);
    store.close();
    assert_integrity(&Connection::open(&path).expect("open"));
}

/// "Go to hand": by the room's id, a prefix of it, or the hand key.
#[test]
fn find_hands_by_id() {
    let path = copy_of_corpus("list-find");
    let store = Store::open(&path).expect("open");
    let rows = all_pages(&store, &HandFilter::default(), 500);
    let target = rows
        .iter()
        .find(|row| row.site_hand_id.len() > 6)
        .expect("a hand with a long id");
    let found = store
        .reader()
        .find_hands(&target.site_hand_id, 10)
        .expect("find");
    assert_eq!(found.first().map(|r| &r.hand_key), Some(&target.hand_key));
    let with_hash = store
        .reader()
        .find_hands(&format!(" #{}", target.site_hand_id), 10)
        .expect("find");
    assert_eq!(
        with_hash.first().map(|r| &r.hand_key),
        Some(&target.hand_key)
    );
    let prefix = &target.site_hand_id[..target.site_hand_id.len() - 2];
    let found = store.reader().find_hands(prefix, 50).expect("find");
    assert!(found.iter().any(|r| r.hand_key == target.hand_key));
    assert!(found.iter().all(|r| r.site_hand_id.starts_with(prefix)));
    let by_key = store
        .reader()
        .find_hands(&target.hand_key, 10)
        .expect("find");
    assert_eq!(by_key.first().map(|r| &r.hand_key), Some(&target.hand_key));
    assert!(
        store
            .reader()
            .find_hands("  ", 10)
            .expect("find")
            .is_empty()
    );
    assert!(
        store
            .reader()
            .find_hands("no such hand id", 10)
            .expect("find")
            .is_empty()
    );
    store.close();
}

/// A store from version 6 (statistics, no list) gets its list: the
/// migration forgets the statistics version, opening starts a rebuild, and
/// the pass writes the same rows an import does.
#[test]
fn a_version_6_store_gets_its_list() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    assert!(!reference.list.is_empty());
    let path = copy_of_corpus("list-v6");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(DOWN_FROM_9).expect("back to version 8");
        conn.execute_batch(
            "DROP TABLE hand_list; DROP TABLE hand_notes; DROP TABLE hand_tags;
             DROP TABLE saved_filters;
             DROP TRIGGER hand_stats_list_delete;
             PRAGMA user_version = 6;",
        )
        .expect("back to version 6");
    }
    let store = Store::open(&path).expect("open");
    let status = store.reader().stats_status().expect("status");
    let hands = store.status().expect("status").hands;
    assert_eq!(status.rebuild.map(|r| (r.done, r.total)), Some((0, hands)));
    assert!(
        store
            .reader()
            .hand_page(&HandFilter::default(), None, 10)
            .expect("page")
            .rows
            .is_empty(),
        "the list fills as the pass goes"
    );
    let writer = store.writer().expect("writer");
    while background::step(store.reader(), &writer, false).expect("step")
        != background::Step::Nothing
    {}
    drop(writer);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let upgraded = stats_snapshot(&conn);
    assert!(upgraded.list == reference.list, "the rebuilt list differs");
    assert!(upgraded.seats == reference.seats);
}

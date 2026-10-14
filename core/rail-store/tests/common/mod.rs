//! Shared by the store's integration tests: the corpus, scratch
//! directories, a seeded generator, and a snapshot of a store's contents.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rail_store::batch::decompress_phf;
use rusqlite::Connection;

/// The `meta.parsedAt` every test import stamps, so two imports of the
/// same file store the same PHF.
pub const PARSED_AT: &str = "2026-10-13T00:00:00.000Z";

/// Back from the latest version to 8 (R2.7c; version 11's custom
/// statistics, R2.10, go first, version 10 only dropped an index): what the
/// older-store tests run first.
pub const DOWN_FROM_9: &str = "DROP TABLE custom_stats; DROP TABLE custom_hero_rows;
     DROP TABLE custom_hero_rollups; DROP TABLE custom_player_rollups;
     DELETE FROM kv WHERE key LIKE 'custom.%';
     DROP TABLE players; DROP TABLE player_labels;
     DROP TABLE player_summary; DROP TABLE player_hidden;
     DROP TRIGGER seat_stats_player_delete; DROP TABLE player_hands;";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// Every corpus file the goldens cover (testdata/golden/<path>.json is the
/// golden of <path>), sorted, as absolute paths. 556 files.
pub fn corpus_files() -> Vec<PathBuf> {
    let root = repo_root();
    let golden = root.join("testdata/golden");
    let mut files = Vec::new();
    let mut stack = vec![golden.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("read testdata/golden") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let relative = path
                    .strip_prefix(&golden)
                    .expect("under golden")
                    .with_extension("");
                let input = root.join(relative);
                assert!(input.is_file(), "{} has no input", path.display());
                files.push(input);
            }
        }
    }
    files.sort();
    files
}

/// A corpus file by its path from the repository root.
pub fn corpus_file(relative: &str) -> PathBuf {
    let path = repo_root().join(relative);
    assert!(path.is_file(), "{relative} is not in the corpus");
    path
}

/// A fresh, empty directory under the target directory, unique per call.
pub fn scratch_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("rail-store-{name}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// SplitMix64: a small seeded generator, so a failing run can be replayed
/// from the seed it prints.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform-ish in `0..bound` (`bound` > 0).
    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}

/// Everything a store holds that does not depend on when it was written:
/// two stores with equal snapshots hold the same data.
#[derive(Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// hand_key -> every column but `imported_at` / `file_id`, the PHF
    /// decompressed, and the delivering file's path.
    pub hands: BTreeMap<String, Vec<String>>,
    /// path -> size, offset, encoding, site, error.
    pub files: BTreeMap<String, Vec<String>>,
    /// (path, fingerprint) -> stage, reason, message, site, chunk, raw text.
    pub quarantine: BTreeMap<(String, String), Vec<String>>,
    /// fingerprint -> fields and count.
    pub unsupported: BTreeMap<String, Vec<String>>,
    pub outbox: BTreeSet<String>,
    /// The statistics (R2.3), segments by their key, generations left out.
    pub stats: StatsSnapshot,
}

/// The statistics tables of a store (R2.3).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StatsSnapshot {
    /// (hand_key, seat) -> the hand's segment key and `hand_stats` columns,
    /// the seat's columns, its decoded counters and money.
    pub seats: BTreeMap<(String, i64), Vec<String>>,
    /// (site, player, scope, segment key) -> last_played_at and the sums.
    pub players: BTreeMap<(String, String, String, String), Vec<String>>,
    /// (segment key, position, day, kind) -> the sums.
    pub heroes: BTreeMap<(String, String, String, i64), Vec<String>>,
    /// hand_key -> seat, version, ev_net, ev_net_bb_milli.
    pub ev_rows: BTreeMap<String, Vec<String>>,
    pub ev_pending: BTreeSet<String>,
    /// (R2.7a) hand_key -> the `hand_list` row, its segment by key.
    pub list: BTreeMap<String, Vec<String>>,
    /// (R2.7c) (site, player) -> the `player_summary` row.
    pub summary: BTreeMap<(String, String), Vec<String>>,
    /// (R2.7c) site -> the `player_hidden` row.
    pub hidden: BTreeMap<String, Vec<String>>,
}

/// A segment's key in SQL (`g` is `segments`).
const SEGMENT_KEY: &str = "g.site || '/' || g.game_format || '/' || g.variant || '/' || \
                           g.limit_type || '/' || g.size_class || '/' || g.stake";

/// The `hand_stats` columns a snapshot compares (not `id`, `gen`).
const HAND_COLUMNS: &str = "d.played_at, d.stats_version, d.site_anonymization, d.site_id, \
     d.currency_minor_units, d.player_count, d.tournament_id, d.fast_fold, d.has_straddle, \
     d.is_bomb_pot, d.is_big_blind_ante, d.is_run_it_twice, d.has_cashout, d.is_walk, \
     d.street_reached, d.pot_type, d.total_pot, d.house_into_pot, d.fees";

/// The rollups' sum columns.
pub fn total_columns() -> Vec<&'static str> {
    rail_store::stats::rollup_columns().collect()
}

pub fn stats_snapshot(conn: &Connection) -> StatsSnapshot {
    let mut snap = StatsSnapshot::default();
    let sql = format!(
        "SELECT d.hand_key, s.seat, {SEGMENT_KEY}, {HAND_COLUMNS}, s.player, s.scope, s.is_hero,
                s.position, s.hole_cards, s.hand_class, s.starting_stack,
                s.starting_stack_bb_tenths, s.totals
         FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
         JOIN segments g ON g.id = d.segment_id"
    );
    let mut stmt = conn.prepare(&sql).expect("prepare seats");
    let columns = stmt.column_count();
    let mut rows = stmt.query([]).expect("seats");
    while let Some(row) = rows.next().expect("row") {
        let mut fields: Vec<String> = (2..columns - 1).map(|i| text(row, i)).collect();
        let blob: Vec<u8> = row.get(columns - 1).expect("totals");
        let values = rail_store::stats::decode_seat(&blob).expect("totals decode");
        fields.push(format!("{:?} {:?}", values.counters, values.money));
        snap.seats.insert(
            (row.get(0).expect("key"), row.get(1).expect("seat")),
            fields,
        );
    }
    let totals = total_columns();
    let sql = format!(
        "SELECT r.site, r.player, r.scope, {SEGMENT_KEY}, r.last_played_at, {}
         FROM player_rollups r JOIN segments g ON g.id = r.segment_id",
        totals.join(", ")
    );
    let mut stmt = conn.prepare(&sql).expect("prepare players");
    let mut rows = stmt.query([]).expect("players");
    while let Some(row) = rows.next().expect("row") {
        snap.players.insert(
            (
                row.get(0).expect("site"),
                row.get(1).expect("player"),
                row.get(2).expect("scope"),
                row.get(3).expect("segment"),
            ),
            (4..5 + totals.len()).map(|i| text(row, i)).collect(),
        );
    }
    let sql = format!(
        "SELECT {SEGMENT_KEY}, r.position, r.day, r.kind, {}
         FROM hero_rollups r JOIN segments g ON g.id = r.segment_id",
        totals.join(", ")
    );
    let mut stmt = conn.prepare(&sql).expect("prepare heroes");
    let mut rows = stmt.query([]).expect("heroes");
    while let Some(row) = rows.next().expect("row") {
        snap.heroes.insert(
            (
                row.get(0).expect("segment"),
                row.get(1).expect("position"),
                row.get(2).expect("day"),
                row.get(3).expect("kind"),
            ),
            (4..4 + totals.len()).map(|i| text(row, i)).collect(),
        );
    }
    let mut stmt = conn
        .prepare("SELECT hand_key, seat, ev_version, ev_net, ev_net_bb_milli FROM ev_rows")
        .expect("prepare ev");
    let mut rows = stmt.query([]).expect("ev");
    while let Some(row) = rows.next().expect("row") {
        snap.ev_rows.insert(
            row.get(0).expect("key"),
            (1..5).map(|i| text(row, i)).collect(),
        );
    }
    let mut stmt = conn
        .prepare("SELECT hand_key FROM ev_pending")
        .expect("prepare pending");
    let mut rows = stmt.query([]).expect("pending");
    while let Some(row) = rows.next().expect("row") {
        snap.ev_pending.insert(row.get(0).expect("key"));
    }
    let sql = format!(
        "SELECT l.hand_key, l.played_at, l.site_hand_id, {SEGMENT_KEY}, l.hero_position,
                l.hero_cards,
                l.hero_net, l.hero_net_bb_milli, l.hero_stack_bb_tenths, l.board, l.all_in,
                l.showdown, l.pot_type, l.currency_symbol, l.kind, l.hero_wtsd, l.currency,
                l.minor_units
         FROM hand_list l JOIN segments g ON g.id = l.segment_id"
    );
    let mut stmt = conn.prepare(&sql).expect("prepare list");
    let columns = stmt.column_count();
    let mut rows = stmt.query([]).expect("list");
    while let Some(row) = rows.next().expect("row") {
        snap.list.insert(
            row.get(0).expect("key"),
            (1..columns).map(|i| text(row, i)).collect(),
        );
    }
    let mut stmt = conn
        .prepare(
            "SELECT site, player, hands, first_played_at, last_played_at, cash_hands,
                    chips_hands, cash_money_hands, cash_net_bb_milli, chips_money_hands,
                    chips_net_bb_milli
             FROM player_summary",
        )
        .expect("prepare summary");
    let mut rows = stmt.query([]).expect("summary");
    while let Some(row) = rows.next().expect("row") {
        snap.summary.insert(
            (row.get(0).expect("site"), row.get(1).expect("player")),
            (2..11).map(|i| text(row, i)).collect(),
        );
    }
    let mut stmt = conn
        .prepare("SELECT site, hands, cash_hands FROM player_hidden")
        .expect("prepare hidden");
    let mut rows = stmt.query([]).expect("hidden");
    while let Some(row) = rows.next().expect("row") {
        snap.hidden.insert(
            row.get(0).expect("site"),
            (1..3).map(|i| text(row, i)).collect(),
        );
    }
    snap
}

/// `hand_list` (R2.7a) has one row per `hand_stats` row, made of it: the
/// hand's date, segment and pot type, and its hero's seat row (position,
/// cards, net, stack); after the EV pass, `all_in` is whether the hand has
/// an `ev_rows` row (while it is queued, on); (R2.7b) the hand's kind, unit
/// and minor units, and the hero's `wtsd`.
pub fn assert_list(conn: &Connection) {
    let missing: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM hand_stats) - (SELECT count(*) FROM hand_list)
                    + (SELECT count(*) FROM hand_list l WHERE NOT EXISTS
                         (SELECT 1 FROM hand_stats d WHERE d.hand_key = l.hand_key))",
            [],
            |row| row.get(0),
        )
        .expect("list count");
    assert_eq!(missing, 0, "hand_list rows are not the hand_stats rows");
    let mut stmt = conn
        .prepare(
            "SELECT d.hand_key, l.played_at = coalesce(d.played_at, '')
                    AND l.site_hand_id = (SELECT h.site_hand_id FROM hands h
                                          WHERE h.hand_key = d.hand_key),
                    l.segment_id = d.segment_id, l.pot_type = d.pot_type,
                    l.hero_position IS s.position, l.hero_cards IS s.hole_cards,
                    l.hero_stack_bb_tenths IS s.starting_stack_bb_tenths,
                    l.hero_net, l.hero_net_bb_milli, s.totals, l.all_in,
                    EXISTS (SELECT 1 FROM ev_rows e WHERE e.hand_key = d.hand_key),
                    EXISTS (SELECT 1 FROM ev_pending p WHERE p.hand_key = d.hand_key),
                    l.kind = (d.is_bomb_pot | (d.has_straddle << 1) | (d.has_cashout << 2))
                    AND l.minor_units = d.currency_minor_units
                    AND l.currency = (SELECT h.currency FROM hands h
                                      WHERE h.hand_key = d.hand_key),
                    l.hero_wtsd
             FROM hand_stats d JOIN hand_list l ON l.hand_key = d.hand_key
             LEFT JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
               AND s.seat = (SELECT min(seat) FROM seat_stats x
                             WHERE x.hand_id = d.id AND x.is_hero = 1)",
        )
        .expect("prepare list check");
    let mut rows = stmt.query([]).expect("list check");
    while let Some(row) = rows.next().expect("row") {
        let key: String = row.get(0).expect("key");
        for (i, what) in [
            (1, "played_at and site_hand_id"),
            (2, "segment"),
            (3, "pot type"),
            (4, "hero position"),
            (5, "hero cards"),
            (6, "hero stack"),
        ] {
            assert!(
                row.get::<_, bool>(i).expect("flag"),
                "{key}: hand_list {what}"
            );
        }
        let net: Option<i64> = row.get(7).expect("net");
        let net_bb: Option<i64> = row.get(8).expect("net bb");
        let totals: Option<Vec<u8>> = row.get(9).expect("totals");
        let hero = totals.map(|blob| {
            let values = rail_store::stats::decode_seat(&blob).expect("decode");
            (values.net(), values.net_bb_milli())
        });
        assert_eq!(net.zip(net_bb), hero, "{key}: hand_list hero result");
        assert!(
            row.get::<_, bool>(13).expect("flag"),
            "{key}: hand_list kind, currency, minor units"
        );
        let wtsd = totals_wtsd(row.get(9).expect("totals"));
        assert_eq!(
            row.get::<_, bool>(14).expect("wtsd"),
            wtsd,
            "{key}: hero_wtsd"
        );
        let (all_in, ev, pending): (bool, bool, bool) = (
            row.get(10).expect("all_in"),
            row.get(11).expect("ev"),
            row.get(12).expect("pending"),
        );
        if !pending {
            assert_eq!(all_in, ev, "{key}: hand_list all_in after the EV pass");
        }
    }
}

/// The hero's `wtsd` counter from its seat blob (false without a hero).
fn totals_wtsd(totals: Option<Vec<u8>>) -> bool {
    totals.is_some_and(|blob| {
        let values = rail_store::stats::decode_seat(&blob).expect("decode");
        values.counters[rail_stats::Counter::wtsd.index()] > 0
    })
}

/// The rollups' sums, read back.
fn rollup_totals(row: &rusqlite::Row<'_>, first: usize) -> rail_store::Totals {
    let mut totals = rail_store::Totals::default();
    let count = totals.counters.len();
    for (i, value) in totals.counters.iter_mut().enumerate() {
        *value = row.get(first + i).expect("counter");
    }
    for (i, value) in totals.money.iter_mut().enumerate() {
        *value = row.get(first + count + i).expect("money");
    }
    totals.money_hands = row
        .get(first + count + totals.money.len())
        .expect("money_hands");
    totals
}

/// The rollups are the sums of the seat rows of the current generation:
/// `player_rollups` per (site, player, scope, segment) with `aggregate`'s
/// default exclusions (bomb pots out, EV-cashout money out),
/// `hero_rollups` per (segment, position, UTC day, kind) of the hero's
/// rows. Every column, `last_played_at` included. And (R2.7c)
/// `player_summary` per (site, player) of the opponents' rows at scope `''`
/// with a name (bomb pots out; the hero's hands and result in the hand,
/// cash and chips apart, an EV cashout's result out), `player_hidden` per
/// site of the opponents' rows of other scopes.
pub fn assert_rollups(conn: &Connection) {
    use rail_store::stats::{KIND_BOMB_POT, KIND_CASHOUT, KIND_STRADDLED, decode_seat};
    let generation: i64 = conn
        .query_row(
            "SELECT coalesce((SELECT CAST(value AS INTEGER) FROM kv WHERE key = 'stats.gen'), 0)",
            [],
            |row| row.get(0),
        )
        .expect("generation");
    type PlayerKey = (String, String, String, i64);
    let mut players: BTreeMap<PlayerKey, (rail_store::Totals, Option<String>)> = BTreeMap::new();
    let mut heroes: BTreeMap<(i64, String, String, i64), rail_store::Totals> = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT g.site, s.player, s.scope, d.segment_id, h.played_at, d.is_bomb_pot,
                    d.has_straddle, d.has_cashout, s.is_hero, coalesce(s.position, ''), s.totals,
                    d.id, g.game_format = 'cash'
             FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
             JOIN segments g ON g.id = d.segment_id JOIN hands h ON h.hand_key = d.hand_key
             WHERE d.gen = ?1",
        )
        .expect("prepare rows");
    // (R2.7c) The opponents' lines: every row first, the hero's result per hand.
    struct Seat {
        site: String,
        player: String,
        scope: String,
        hand: i64,
        played: Option<String>,
        bomb: bool,
        cashout: bool,
        hero: bool,
        cash: bool,
        net_bb_milli: i64,
    }
    let mut seats: Vec<Seat> = Vec::new();
    let mut rows = stmt.query([generation]).expect("rows");
    while let Some(row) = rows.next().expect("row") {
        let blob: Vec<u8> = row.get(10).expect("blob");
        seats.push(Seat {
            site: row.get(0).expect("site"),
            player: row.get(1).expect("player"),
            scope: row.get(2).expect("scope"),
            hand: row.get(11).expect("hand"),
            played: row.get(4).expect("played_at"),
            bomb: row.get(5).expect("bomb"),
            cashout: row.get(7).expect("cashout"),
            hero: row.get(8).expect("hero"),
            cash: row.get(12).expect("cash"),
            net_bb_milli: decode_seat(&blob).expect("decode").net_bb_milli(),
        });
    }
    drop(rows);
    let hero_net: BTreeMap<i64, i64> = seats
        .iter()
        .filter(|seat| seat.hero)
        .map(|seat| (seat.hand, seat.net_bb_milli))
        .collect();
    let mut summary: BTreeMap<(String, String), rail_store::PlayerSeen> = BTreeMap::new();
    let mut hidden: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    for seat in seats.iter().filter(|seat| !seat.hero && !seat.bomb) {
        if seat.scope.is_empty() {
            if !seat.player.is_empty() {
                summary
                    .entry((seat.site.clone(), seat.player.clone()))
                    .or_default()
                    .add(&rail_store::PlayerSeen::seat(
                        seat.played.as_deref(),
                        seat.cash,
                        hero_net.get(&seat.hand).copied(),
                        !seat.cashout,
                    ));
            }
        } else {
            let sum = hidden.entry(seat.site.clone()).or_default();
            sum.0 += 1;
            sum.1 += i64::from(seat.cash);
        }
    }
    let mut rows = stmt.query([generation]).expect("rows");
    while let Some(row) = rows.next().expect("row") {
        let played: Option<String> = row.get(4).expect("played_at");
        let bomb: bool = row.get(5).expect("bomb");
        let straddle: bool = row.get(6).expect("straddle");
        let cashout: bool = row.get(7).expect("cashout");
        let values = decode_seat(&row.get::<_, Vec<u8>>(10).expect("blob")).expect("decode");
        let segment: i64 = row.get(3).expect("segment");
        if !bomb {
            let (totals, last) = players
                .entry((
                    row.get(0).expect("site"),
                    row.get(1).expect("player"),
                    row.get(2).expect("scope"),
                    segment,
                ))
                .or_default();
            totals.add_seat(&values, !cashout);
            if played > *last {
                last.clone_from(&played);
            }
        }
        if row.get::<_, bool>(8).expect("hero") {
            let kind = (if bomb { KIND_BOMB_POT } else { 0 })
                | (if straddle { KIND_STRADDLED } else { 0 })
                | (if cashout { KIND_CASHOUT } else { 0 });
            let day = played.as_deref().map_or("", |at| &at[..10]).to_owned();
            heroes
                .entry((segment, row.get(9).expect("position"), day, kind))
                .or_default()
                .add_seat(&values, true);
        }
    }
    let columns = total_columns().join(", ");
    let mut stored_players = BTreeMap::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT site, player, scope, segment_id, last_played_at, {columns} FROM player_rollups"
        ))
        .expect("prepare players");
    let mut rows = stmt.query([]).expect("players");
    while let Some(row) = rows.next().expect("row") {
        stored_players.insert(
            (
                row.get(0).expect("site"),
                row.get(1).expect("player"),
                row.get(2).expect("scope"),
                row.get(3).expect("segment"),
            ),
            (rollup_totals(row, 5), row.get(4).expect("last")),
        );
    }
    assert!(
        stored_players == players,
        "player_rollups are not the sums of the seat rows ({} stored, {} expected)",
        stored_players.len(),
        players.len()
    );
    let mut stored_heroes = BTreeMap::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT segment_id, position, day, kind, {columns} FROM hero_rollups"
        ))
        .expect("prepare heroes");
    let mut rows = stmt.query([]).expect("heroes");
    while let Some(row) = rows.next().expect("row") {
        stored_heroes.insert(
            (
                row.get(0).expect("segment"),
                row.get(1).expect("position"),
                row.get(2).expect("day"),
                row.get(3).expect("kind"),
            ),
            rollup_totals(row, 4),
        );
    }
    assert!(
        stored_heroes == heroes,
        "hero_rollups are not the sums of the hero's rows ({} stored, {} expected)",
        stored_heroes.len(),
        heroes.len()
    );
    let mut stored_summary = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT site, player, hands, first_played_at, last_played_at, cash_hands,
                    chips_hands, cash_money_hands, cash_net_bb_milli, chips_money_hands,
                    chips_net_bb_milli
             FROM player_summary",
        )
        .expect("prepare summary");
    let mut rows = stmt.query([]).expect("summary");
    while let Some(row) = rows.next().expect("row") {
        stored_summary.insert(
            (row.get(0).expect("site"), row.get(1).expect("player")),
            rail_store::PlayerSeen {
                hands: row.get(2).expect("hands"),
                first_played_at: row.get(3).expect("first"),
                last_played_at: row.get(4).expect("last"),
                cash_hands: row.get(5).expect("cash"),
                chips_hands: row.get(6).expect("chips"),
                cash_money_hands: row.get(7).expect("cash money"),
                cash_net_bb_milli: row.get(8).expect("cash net"),
                chips_money_hands: row.get(9).expect("chips money"),
                chips_net_bb_milli: row.get(10).expect("chips net"),
            },
        );
    }
    assert!(
        stored_summary == summary,
        "player_summary is not the sums of the opponents' rows ({} stored, {} expected)",
        stored_summary.len(),
        summary.len()
    );
    let stored_hidden: BTreeMap<String, (i64, i64)> = conn
        .prepare("SELECT site, hands, cash_hands FROM player_hidden")
        .expect("prepare hidden")
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))
        .expect("hidden")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(stored_hidden, hidden, "player_hidden");
    // `player_hands`: exactly the named opponents' seat rows at scope '' of
    // the hands the background pass has gone through (`players.indexed`).
    let mismatched: i64 = conn
        .query_row(
            "WITH m AS (SELECT coalesce((SELECT CAST(value AS INTEGER) FROM kv
                                         WHERE key = 'players.indexed'), 0) AS upto)
             SELECT (SELECT count(*) FROM (
                       SELECT player, hand_id, seat FROM seat_stats, m
                        WHERE is_hero = 0 AND scope = '' AND player <> '' AND hand_id <= m.upto
                       EXCEPT SELECT player, hand_id, seat FROM player_hands))
                  + (SELECT count(*) FROM (
                       SELECT player, hand_id, seat FROM player_hands
                       EXCEPT SELECT player, hand_id, seat FROM seat_stats, m
                        WHERE is_hero = 0 AND scope = '' AND player <> '' AND hand_id <= m.upto))",
            [],
            |row| row.get(0),
        )
        .expect("player_hands");
    assert_eq!(
        mismatched, 0,
        "player_hands are not the opponents' seat rows"
    );
}

fn text(row: &rusqlite::Row<'_>, index: usize) -> String {
    use rusqlite::types::ValueRef;
    match row.get_ref(index).expect("column") {
        ValueRef::Null => "NULL".to_owned(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(_) => panic!("no REAL columns in the store"),
        ValueRef::Text(t) => format!("'{}'", String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => format!("blob:{}", b.len()),
    }
}

pub fn snapshot(conn: &Connection) -> Snapshot {
    let mut hands = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT h.hand_key, h.site, h.site_hand_id, h.played_at, h.game_format, h.variant,
                    h.limit_type, h.currency, h.small_blind, h.big_blind, h.ante, h.table_name,
                    h.max_seats, h.hero_seat, h.hero_name, h.schema_version, h.parser_id,
                    h.parser_version, h.phf_size, f.path, h.synced_at, h.phf
             FROM hands h LEFT JOIN files f ON f.id = h.file_id",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        let mut fields: Vec<String> = (1..21).map(|i| text(row, i)).collect();
        let blob: Vec<u8> = row.get(21).expect("phf");
        let size: i64 = row.get(18).expect("phf_size");
        fields.push(decompress_phf(&blob, u64::try_from(size).expect("size")).expect("decompress"));
        hands.insert(row.get(0).expect("key"), fields);
    }

    let mut files = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT path, size, read_offset, encoding, site, last_error, mtime, source_id
             FROM files",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        files.insert(
            row.get(0).expect("path"),
            (1..8).map(|i| text(row, i)).collect(),
        );
    }

    let mut quarantine = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT f.path, q.fingerprint, q.read_offset, q.chunk_index, q.stage, q.reason,
                    q.message, q.detected_site, q.detection_permille, q.parser_version,
                    q.raw_text
             FROM quarantine q JOIN files f ON f.id = q.file_id",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        quarantine.insert(
            (row.get(0).expect("path"), row.get(1).expect("fp")),
            (2..11).map(|i| text(row, i)).collect(),
        );
    }

    let mut unsupported = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT fingerprint, header_sample, guessed_site, confidence, guess_basis, shape,
                    file_path, encoding, count, consented_at, sent_at, anonymiser_version
             FROM unsupported",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        unsupported.insert(
            row.get(0).expect("fp"),
            (1..12).map(|i| text(row, i)).collect(),
        );
    }

    let mut outbox = BTreeSet::new();
    let mut stmt = conn
        .prepare("SELECT hand_key FROM outbox")
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        outbox.insert(row.get(0).expect("key"));
    }

    Snapshot {
        hands,
        files,
        quarantine,
        unsupported,
        outbox,
        stats: stats_snapshot(conn),
    }
}

/// `PRAGMA integrity_check` says `ok`, no foreign key is dangling, and the
/// folder rollups of schema version 4 (`files.hands`, `files.quarantined`,
/// `source_totals`) equal what the rows say, and so do the statistics rollups
/// of version 6 ([`assert_rollups`]).
pub fn assert_integrity(conn: &Connection) {
    let integrity: Vec<String> = conn
        .prepare("PRAGMA integrity_check")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(integrity, ["ok"], "integrity_check");
    let dangling: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("foreign_key_check");
    assert_eq!(dangling, 0, "foreign_key_check");
    let files_off: i64 = conn
        .query_row(
            "SELECT count(*) FROM files f
             WHERE f.hands <> (SELECT count(*) FROM hands h WHERE h.file_id = f.id)
                OR f.quarantined <> (SELECT count(*) FROM quarantine q WHERE q.file_id = f.id)",
            [],
            |row| row.get(0),
        )
        .expect("file counters");
    assert_eq!(files_off, 0, "files.hands / files.quarantined");
    let sources_off: i64 = conn
        .query_row(
            "SELECT count(*) FROM sources s LEFT JOIN source_totals t ON t.source_id = s.id
             WHERE t.source_id IS NULL
                OR t.files <> (SELECT count(*) FROM files f WHERE f.source_id = s.id)
                OR t.hands <> (SELECT coalesce(sum(f.hands), 0) FROM files f
                                WHERE f.source_id = s.id)
                OR t.quarantined <> (SELECT coalesce(sum(f.quarantined), 0) FROM files f
                                      WHERE f.source_id = s.id)",
            [],
            |row| row.get(0),
        )
        .expect("folder totals");
    assert_eq!(sources_off, 0, "source_totals");
    let orphans: i64 = conn
        .query_row(
            "SELECT count(*) FROM source_totals t
             WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = t.source_id)",
            [],
            |row| row.get(0),
        )
        .expect("orphan totals");
    assert_eq!(orphans, 0, "source_totals without a folder");
    assert_rollups(conn);
    assert_list(conn);
}

//! The Hands screen (docs/RAIL-PLAN.md R2.7a): the list of hands with its
//! filters, the counts beside the filter chips, "go to hand", and the
//! user's notes, tags and saved filters.
//!
//! - **The list** ([`Reader::hand_page`]) reads `hand_list`, one narrow row
//!   per hand clustered by (`played_at`, `hand_key`): newest first, a page
//!   is one range of the table and the next page starts after the last
//!   row's key (a keyset cursor, [`HandCursor`]), so a page costs the same
//!   at the millionth hand as at the first and stays stable while hands
//!   arrive. `hands`, `hand_stats` and the EV and note tables are read only
//!   for the rows of the page.
//! - **Filters** ([`HandFilter`]): the segment's dimensions (site, format,
//!   variant, limit, table size, stake) become a set of `segments.id`s
//!   (that table is small); the hero's position, result and stack, the pot
//!   type and the all-in flag are columns of the row; the date range is a
//!   range of the key; notes and tags are the user's tables; a player
//!   (R2.7c, "hands with this player") is their entries in `player_hands`.
//! - **The counts** ([`Reader::hand_facets`]) for each chip: the hands that
//!   would match if that chip's own group were left out of the filter (how
//!   many hands a click adds), all groups from one pass over the rows.
//! - **Writes** ([`set_note`], [`add_tag`], [`remove_tag`], [`save_filter`],
//!   [`delete_saved_filter`]) run on the writer (`WriterHandle::write`).
//!   Notes and tags stay on this computer for now (syncing them to the web
//!   is a later step).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use crate::error::{Error, Result};
use crate::read::Reader;

/// The most rows one page returns.
pub const PAGE_MAX: u32 = 500;

/// The longest tag, in characters.
pub const TAG_MAX_CHARS: usize = 40;

/// The longest note, in characters.
pub const NOTE_MAX_CHARS: usize = 10_000;

/// The hero's stack depth groups of the stack filter: id, lowest stack in
/// tenths of a big blind (inclusive), highest (exclusive; `None`: no limit).
pub const STACK_DEPTHS: [(&str, i64, Option<i64>); 4] = [
    ("0-40", 0, Some(400)),
    ("40-80", 400, Some(800)),
    ("80-120", 800, Some(1200)),
    ("120+", 1200, None),
];

/// The hero's result in a hand, for the result filter.
pub const RESULTS: [&str; 3] = ["won", "lost", "even"];

/// An opponent of a room with real screen names (R2.7c): the site key
/// (`segments.site`) and the name as the room printed it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerRef {
    pub site: String,
    pub player: String,
}

/// What the list shows: every group is "any" when empty, and a hand must
/// match every group that is not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandFilter {
    /// Site ids (`segments.site`: `hand_key`'s prefix, `pokerstars`).
    pub sites: Vec<String>,
    /// `cash`, `tournament`, `sng`, `spin`.
    pub formats: Vec<String>,
    /// `holdem`, `omaha`, ...
    pub variants: Vec<String>,
    /// `nl`, `pl`, `fl`.
    pub limits: Vec<String>,
    /// Table sizes: `hu`, `6max`, `full`.
    pub sizes: Vec<String>,
    /// Stakes as `segments.stake` writes them (`USD:200`, `chips`).
    pub stakes: Vec<String>,
    /// The hero's positions (`BTN`, ...). A hand without a hero matches none.
    pub positions: Vec<String>,
    /// `walk`, `bomb`, `limped`, `single-raised`, `3bet`, `4bet+`.
    pub pot_types: Vec<String>,
    /// The hero's result: [`RESULTS`].
    pub results: Vec<String>,
    /// The hero's starting stack: ids of [`STACK_DEPTHS`].
    pub stacks: Vec<String>,
    /// Only hands where the hero was all in with cards to come (`true`), or
    /// only the others (`false`).
    pub all_in: Option<bool>,
    /// Only hands with a note (`true`), or only those without (`false`).
    pub has_note: Option<bool>,
    /// Hands with any of these tags.
    pub tags: Vec<String>,
    /// From this instant on, ISO UTC as PHF writes it, inclusive. A bound
    /// leaves out hands without a `played_at`.
    pub from: Option<String>,
    /// Before this instant, exclusive.
    pub to: Option<String>,
    /// Only hands this opponent was dealt into (R2.7c).
    pub player: Option<PlayerRef>,
}

/// Where the next page starts: the last row of the page before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandCursor {
    /// `''` for a hand without a `played_at`.
    pub played_at: String,
    pub hand_key: String,
}

/// One row of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandRow {
    pub hand_key: String,
    pub site: String,
    pub site_hand_id: String,
    pub played_at: Option<String>,
    pub game_format: String,
    pub variant: String,
    pub limit_type: String,
    pub currency: String,
    /// `game.unit.symbol`: `$`, `''` for chips.
    pub currency_symbol: String,
    /// Minor units per display unit: 100 for cash, 1 for chips.
    pub minor_units: i64,
    pub small_blind: i64,
    pub big_blind: i64,
    pub ante: i64,
    pub max_seats: i64,
    pub table_name: Option<String>,
    /// The hero's position and cards (empty when not seen), when there is
    /// a hero.
    pub hero_position: Option<String>,
    pub hero_cards: Vec<String>,
    /// The primary runout.
    pub board: Vec<String>,
    /// The hero's net, minor units, and in thousandths of a big blind.
    pub hero_net: Option<i64>,
    pub hero_net_bb_milli: Option<i64>,
    /// All in with cards to come.
    pub all_in: bool,
    /// The all-in EV result, where it differs from the result.
    pub ev_net: Option<i64>,
    pub ev_net_bb_milli: Option<i64>,
    /// Queued for the background EV pass.
    pub ev_pending: bool,
    pub pot_type: String,
    pub total_pot: i64,
    /// The hand reached showdown.
    pub showdown: bool,
    pub has_note: bool,
    pub tags: Vec<String>,
}

impl HandRow {
    /// The cursor of the page after this row.
    pub fn cursor(&self) -> HandCursor {
        HandCursor {
            played_at: self.played_at.clone().unwrap_or_default(),
            hand_key: self.hand_key.clone(),
        }
    }
}

/// A page of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandPage {
    pub rows: Vec<HandRow>,
    /// Where the next page starts; `None` at the end.
    pub next: Option<HandCursor>,
}

/// A chip's value and its count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetCount {
    pub value: String,
    pub count: u64,
}

/// A stake's chip: its key, count, and what its label is made of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StakeFacet {
    /// `segments.stake`: `USD:200`, `chips`.
    pub value: String,
    pub count: u64,
    /// A hand of the stake's blinds and unit (`None` for `chips`, whose
    /// blinds rise).
    pub currency: Option<String>,
    pub currency_symbol: Option<String>,
    pub minor_units: Option<i64>,
    pub small_blind: Option<i64>,
    pub big_blind: Option<i64>,
}

/// The counts beside the filter chips. Each group lists every value the
/// hands in the date range have (with the notes and tags filter applied),
/// counted as if the group's own selection were left out of the filter.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandFacets {
    /// The hands the whole filter matches.
    pub total: u64,
    pub sites: Vec<FacetCount>,
    pub formats: Vec<FacetCount>,
    pub variants: Vec<FacetCount>,
    pub limits: Vec<FacetCount>,
    pub sizes: Vec<FacetCount>,
    pub stakes: Vec<StakeFacet>,
    /// `''` is a hero without a position, or no hero.
    pub positions: Vec<FacetCount>,
    pub pot_types: Vec<FacetCount>,
    /// [`RESULTS`]; hands without a hero are not counted.
    pub results: Vec<FacetCount>,
    /// [`STACK_DEPTHS`]; hands without a hero are not counted.
    pub stacks: Vec<FacetCount>,
    /// `1` all in, `0` not.
    pub all_in: Vec<FacetCount>,
}

/// A hand's note and tags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Annotations {
    pub note: Option<String>,
    pub tags: Vec<String>,
}

/// A saved filter: its name and the filter as the screen wrote it (JSON).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedFilter {
    pub id: i64,
    pub name: String,
    pub filter: String,
    pub created_at: i64,
}

/* ------------------------------------------------------------ the query - */

/// A segment's dimensions, as `segments` stores them.
#[derive(Debug, Clone)]
pub(crate) struct SegmentDims {
    pub(crate) site: String,
    pub(crate) format: String,
    pub(crate) variant: String,
    pub(crate) limit: String,
    pub(crate) size: String,
    pub(crate) stake: String,
}

pub(crate) fn segments(conn: &Connection) -> Result<HashMap<i64, SegmentDims>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, site, game_format, variant, limit_type, size_class, stake FROM segments",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            SegmentDims {
                site: row.get(1)?,
                format: row.get(2)?,
                variant: row.get(3)?,
                limit: row.get(4)?,
                size: row.get(5)?,
                stake: row.get(6)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// `values` is empty ("any") or holds `value`.
pub(crate) fn allows(values: &[String], value: &str) -> bool {
    values.is_empty() || values.iter().any(|v| v == value)
}

impl HandFilter {
    fn segment_filtered(&self) -> bool {
        !(self.sites.is_empty()
            && self.formats.is_empty()
            && self.variants.is_empty()
            && self.limits.is_empty()
            && self.sizes.is_empty()
            && self.stakes.is_empty())
    }

    fn segment_allows(&self, dims: &SegmentDims) -> bool {
        allows(&self.sites, &dims.site)
            && allows(&self.formats, &dims.format)
            && allows(&self.variants, &dims.variant)
            && allows(&self.limits, &dims.limit)
            && allows(&self.sizes, &dims.size)
            && allows(&self.stakes, &dims.stake)
    }
}

/// `SQL` and its parameters, built clause by clause.
#[derive(Debug, Default)]
struct Where {
    clauses: Vec<String>,
    params: Vec<Value>,
}

impl Where {
    fn param(&mut self, value: Value) -> String {
        self.params.push(value);
        format!("?{}", self.params.len())
    }

    fn text(&mut self, value: &str) -> String {
        self.param(Value::Text(value.to_owned()))
    }

    fn push(&mut self, clause: String) {
        self.clauses.push(clause);
    }

    /// `column IN (...)` over text values.
    fn in_text(&mut self, column: &str, values: &[String]) {
        let list: Vec<String> = values.iter().map(|value| self.text(value)).collect();
        self.push(format!("{column} IN ({})", list.join(", ")));
    }

    fn sql(&self) -> String {
        if self.clauses.is_empty() {
            "1".to_owned()
        } else {
            self.clauses.join(" AND ")
        }
    }
}

/// The SQL of the hero's result (`''`: no hero).
const RESULT_SQL: &str = "CASE WHEN l.hero_net IS NULL THEN '' WHEN l.hero_net > 0 THEN 'won' \
                          WHEN l.hero_net < 0 THEN 'lost' ELSE 'even' END";

/// The rows a query goes through, `l` being `hand_list`. With a player,
/// from their entries in `player_hands` (villains of rooms with real
/// names) in the player's room to the list rows of those hands; with
/// a note or tag filter, from the user's (small) table to the list rows of
/// its hands; both sorted afterwards. Otherwise the list in its order.
/// Measured at 500k hands, probing the notes for every row took 180 ms,
/// the tags 350 ms. The note and tag clauses stay in [`base_clauses`], so
/// a player and a tag filter together are both applied.
fn source(filter: &HandFilter, w: &mut Where) -> String {
    if let Some(player) = &filter.player {
        let name = w.text(&player.player);
        let site = w.text(&player.site);
        return format!(
            "FROM player_hands ps
             CROSS JOIN hand_stats ks ON ks.id = ps.hand_id AND ps.player = {name}
             CROSS JOIN segments pg ON pg.id = ks.segment_id AND pg.site = {site}
             CROSS JOIN hand_list l
               ON l.played_at = coalesce(ks.played_at, '') AND l.hand_key = ks.hand_key"
        );
    }
    let driver = if filter.has_note == Some(true) {
        Some("SELECT hand_key FROM hand_notes".to_owned())
    } else if filter.tags.is_empty() {
        None
    } else {
        let list: Vec<String> = filter.tags.iter().map(|tag| w.text(tag)).collect();
        Some(format!(
            "SELECT DISTINCT hand_key FROM hand_tags WHERE tag IN ({})",
            list.join(", ")
        ))
    };
    match driver {
        None => "FROM hand_list l".to_owned(),
        Some(keys) => format!(
            "FROM ({keys}) k
             CROSS JOIN hand_stats ks ON ks.hand_key = k.hand_key
             CROSS JOIN hand_list l
               ON l.played_at = coalesce(ks.played_at, '') AND l.hand_key = k.hand_key"
        ),
    }
}

/// The date range, notes and tags: what the counts are taken under.
fn base_clauses(filter: &HandFilter, w: &mut Where) {
    if let Some(from) = &filter.from {
        let p = w.text(from);
        // '' (no `played_at`) sorts first: any bound leaves it out.
        w.push(format!("l.played_at >= {p} AND l.played_at <> ''"));
    }
    if let Some(to) = &filter.to {
        let p = w.text(to);
        w.push(format!("l.played_at < {p} AND l.played_at <> ''"));
    }
    match filter.has_note {
        Some(true) => {
            w.push("EXISTS (SELECT 1 FROM hand_notes n WHERE n.hand_key = l.hand_key)".to_owned());
        }
        Some(false) => w.push(
            "NOT EXISTS (SELECT 1 FROM hand_notes n WHERE n.hand_key = l.hand_key)".to_owned(),
        ),
        None => {}
    }
    if !filter.tags.is_empty() {
        let list: Vec<String> = filter.tags.iter().map(|tag| w.text(tag)).collect();
        w.push(format!(
            "EXISTS (SELECT 1 FROM hand_tags t WHERE t.hand_key = l.hand_key AND t.tag IN ({}))",
            list.join(", ")
        ));
    }
}

/// Every clause of `filter`. `None`: nothing can match (no segment does).
fn clauses(filter: &HandFilter, segments: &HashMap<i64, SegmentDims>, w: &mut Where) -> Option<()> {
    base_clauses(filter, w);
    if filter.segment_filtered() {
        let mut ids: Vec<i64> = segments
            .iter()
            .filter(|(_, dims)| filter.segment_allows(dims))
            .map(|(id, _)| *id)
            .collect();
        if ids.is_empty() {
            return None;
        }
        ids.sort_unstable();
        let list: Vec<String> = ids.iter().map(ToString::to_string).collect();
        w.push(format!("l.segment_id IN ({})", list.join(", ")));
    }
    if !filter.positions.is_empty() {
        w.in_text("l.hero_position", &filter.positions);
    }
    if !filter.pot_types.is_empty() {
        w.in_text("l.pot_type", &filter.pot_types);
    }
    if !filter.results.is_empty() {
        w.in_text(RESULT_SQL, &filter.results);
    }
    if !filter.stacks.is_empty() {
        let ranges: Vec<String> = STACK_DEPTHS
            .iter()
            .filter(|(id, _, _)| filter.stacks.iter().any(|s| s == id))
            .map(|(_, from, below)| match below {
                Some(below) => format!(
                    "(l.hero_stack_bb_tenths >= {from} AND l.hero_stack_bb_tenths < {below})"
                ),
                None => format!("l.hero_stack_bb_tenths >= {from}"),
            })
            .collect();
        if ranges.is_empty() {
            return None;
        }
        w.push(format!("({})", ranges.join(" OR ")));
    }
    if let Some(all_in) = filter.all_in {
        w.push(format!("l.all_in = {}", i64::from(all_in)));
    }
    Some(())
}

/// The columns of a [`HandRow`], `l` being `hand_list`.
const ROW_COLUMNS: &str = "l.hand_key, h.site, h.site_hand_id, h.played_at, h.game_format,
       h.variant, h.limit_type, h.currency, l.currency_symbol, d.currency_minor_units,
       h.small_blind, h.big_blind, h.ante, h.max_seats, h.table_name, l.hero_position,
       l.hero_cards, l.board, l.hero_net, l.hero_net_bb_milli, l.all_in, e.ev_net,
       e.ev_net_bb_milli, p.hand_key IS NOT NULL, l.pot_type, d.total_pot,
       l.showdown, n.hand_key IS NOT NULL,
       (SELECT group_concat(tag, char(31) ORDER BY tag) FROM hand_tags
         WHERE hand_key = l.hand_key)";

/// The tables a row's columns come from, read per row of the page only
/// (left joins: `hand_list` stays the outer loop).
const ROW_JOINS: &str = "LEFT JOIN hands h ON h.hand_key = l.hand_key
     LEFT JOIN hand_stats d ON d.hand_key = l.hand_key
     LEFT JOIN ev_rows e ON e.hand_key = l.hand_key
     LEFT JOIN ev_pending p ON p.hand_key = l.hand_key
     LEFT JOIN hand_notes n ON n.hand_key = l.hand_key";

fn cards(text: Option<String>) -> Vec<String> {
    text.map(|text| text.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

fn row_from(row: &Row<'_>) -> rusqlite::Result<HandRow> {
    let hero_cards: Option<String> = row.get(16)?;
    let board: String = row.get(17)?;
    let tags: Option<String> = row.get(28)?;
    Ok(HandRow {
        hand_key: row.get(0)?,
        site: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        site_hand_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        played_at: row.get(3)?,
        game_format: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        variant: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        limit_type: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        currency: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        currency_symbol: row.get(8)?,
        minor_units: row.get::<_, Option<i64>>(9)?.unwrap_or(1),
        small_blind: row.get::<_, Option<i64>>(10)?.unwrap_or(0),
        big_blind: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
        ante: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
        max_seats: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
        table_name: row.get(14)?,
        hero_position: row.get(15)?,
        hero_cards: cards(hero_cards),
        board: cards(Some(board)),
        hero_net: row.get(18)?,
        hero_net_bb_milli: row.get(19)?,
        all_in: row.get(20)?,
        ev_net: row.get(21)?,
        ev_net_bb_milli: row.get(22)?,
        ev_pending: row.get(23)?,
        pot_type: row.get(24)?,
        total_pot: row.get::<_, Option<i64>>(25)?.unwrap_or(0),
        showdown: row.get(26)?,
        has_note: row.get(27)?,
        tags: tags
            .map(|tags| tags.split('\u{1f}').map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

/// The list rows of `keys`, in the list's order (newest first). Unknown
/// keys, and hands without statistics rows, are left out.
fn rows_of(conn: &Connection, keys: &[String]) -> Result<Vec<HandRow>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut w = Where::default();
    let list: Vec<String> = keys.iter().map(|key| w.text(key)).collect();
    let sql = format!(
        "SELECT {ROW_COLUMNS}
         FROM hand_stats k
         CROSS JOIN hand_list l ON l.played_at = coalesce(k.played_at, '') AND l.hand_key = k.hand_key
         {ROW_JOINS}
         WHERE k.hand_key IN ({})
         ORDER BY l.played_at DESC, l.hand_key DESC",
        list.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(w.params.iter()), row_from)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The few distinct texts of a column (positions, pot types), numbered as
/// they are first seen, so the facets' pass allocates per value, not per row.
#[derive(Default)]
struct Names {
    list: Vec<String>,
}

impl Names {
    fn of(&mut self, text: &str) -> usize {
        match self.list.iter().position(|name| name == text) {
            Some(i) => i,
            None => {
                self.list.push(text.to_owned());
                self.list.len() - 1
            }
        }
    }
}

/// What the facets' pass counts by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct GroupKey {
    segment_id: i64,
    position: usize,
    pot_type: usize,
    all_in: bool,
    result: &'static str,
    stack: &'static str,
}

/// The stack depth group of a stack in tenths of a big blind.
fn stack_depth(stack: i64) -> &'static str {
    STACK_DEPTHS
        .iter()
        .find(|(_, from, below)| stack >= *from && below.is_none_or(|below| stack < below))
        .map_or("", |(id, _, _)| id)
}

/// One counted group of the facets' pass.
struct Group {
    segment_id: i64,
    position: String,
    pot_type: String,
    all_in: String,
    result: String,
    stack: String,
    count: u64,
    sample: String,
    symbol: String,
}

/// Count `value` into `counts` (and list it with 0 when `counted` is false).
fn tally(counts: &mut BTreeMap<String, u64>, value: &str, count: u64, counted: bool) {
    let entry = counts.entry(value.to_owned()).or_insert(0);
    if counted {
        *entry += count;
    }
}

fn facet_list(counts: BTreeMap<String, u64>) -> Vec<FacetCount> {
    counts
        .into_iter()
        .map(|(value, count)| FacetCount { value, count })
        .collect()
}

impl Reader {
    /// A page of the list: the hands `filter` matches, newest first, after
    /// `after` (the first page: `None`), at most `limit` (capped at
    /// [`PAGE_MAX`]).
    pub fn hand_page(
        &self,
        filter: &HandFilter,
        after: Option<&HandCursor>,
        limit: u32,
    ) -> Result<HandPage> {
        let limit = limit.clamp(1, PAGE_MAX);
        self.with(|conn| {
            let segments = segments(conn)?;
            let mut w = Where::default();
            let from = source(filter, &mut w);
            if clauses(filter, &segments, &mut w).is_none() {
                return Ok(HandPage {
                    rows: Vec::new(),
                    next: None,
                });
            }
            if let Some(after) = after {
                let played_at = w.text(&after.played_at);
                let hand_key = w.text(&after.hand_key);
                w.push(format!(
                    "(l.played_at, l.hand_key) < ({played_at}, {hand_key})"
                ));
            }
            // One more than the page: whether there is a next page.
            let n = w.param(Value::Integer(i64::from(limit) + 1));
            let sql = format!(
                "SELECT {ROW_COLUMNS}
                 {from}
                 {ROW_JOINS}
                 WHERE {}
                 ORDER BY l.played_at DESC, l.hand_key DESC
                 LIMIT {n}",
                w.sql()
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt
                .query_map(params_from_iter(w.params.iter()), row_from)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
            rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
            let next = if more {
                rows.last().map(HandRow::cursor)
            } else {
                None
            };
            Ok(HandPage { rows, next })
        })
    }

    /// The counts beside the filter chips (see [`HandFacets`]): one pass
    /// over the rows of the date range.
    pub fn hand_facets(&self, filter: &HandFilter) -> Result<HandFacets> {
        self.with(|conn| {
            let segments = segments(conn)?;
            let mut w = Where::default();
            let from = source(filter, &mut w);
            base_clauses(filter, &mut w);
            // Summed here rather than by a `GROUP BY` over expressions:
            // measured at 500k hands, SQLite's grouping (a sort) took four
            // times the scan.
            let sql = format!(
                "SELECT l.segment_id, l.hero_position, l.pot_type, l.all_in, l.hero_net,
                        l.hero_stack_bb_tenths, l.hand_key, l.currency_symbol
                 {from}
                 WHERE {}",
                w.sql()
            );
            // The pass depends on the date range, notes and tags only; the
            // chips are counted from its groups. A chip clicked with the
            // same range and nothing committed since reuses them.
            let version: i64 = conn.query_row("PRAGMA data_version", [], |row| row.get(0))?;
            let key = FacetKey {
                connection: std::ptr::from_ref(conn) as usize,
                version,
                query: format!("{sql} {:?}", w.params),
            };
            let cached = self.facet_cache().get(&key);
            let groups = match cached {
                Some(groups) => groups,
                None => {
                    let groups = std::sync::Arc::new(group_pass(conn, &sql, &w.params)?);
                    self.facet_cache().put(key, std::sync::Arc::clone(&groups));
                    groups
                }
            };
            facets(conn, filter, &segments, &groups)
        })
    }

    /// The list rows of these hands (the palette's results, a hand opened
    /// by its key), newest first.
    pub fn hand_rows(&self, keys: &[String]) -> Result<Vec<HandRow>> {
        self.with(|conn| rows_of(conn, keys))
    }

    /// "Go to hand": the hands whose room id (`site_hand_id`) starts with
    /// `query`, or whose `hand_key` is `query`; at most `limit`.
    pub fn find_hands(&self, query: &str, limit: u32) -> Result<Vec<HandRow>> {
        let query = query.trim().trim_start_matches('#');
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = i64::from(limit.clamp(1, PAGE_MAX));
        self.with(|conn| {
            let mut keys: Vec<String> = Vec::new();
            if query.contains(':')
                && conn
                    .prepare_cached("SELECT 1 FROM hands WHERE hand_key = ?1")?
                    .exists([query])?
            {
                keys.push(query.to_owned());
            }
            // A prefix as a range of the index: every id that starts with
            // `query` sorts from `query` to `query` + the last character.
            let below = format!("{query}\u{10ffff}");
            let mut stmt = conn.prepare_cached(
                "SELECT hand_key FROM hand_list
                 WHERE site_hand_id >= ?1 AND site_hand_id < ?2
                 ORDER BY site_hand_id = ?1 DESC, site_hand_id
                 LIMIT ?3",
            )?;
            for key in stmt.query_map(params![query, below, limit], |row| row.get(0))? {
                keys.push(key?);
            }
            keys.dedup();
            let rows = rows_of(conn, &keys)?;
            // Exact ids first, then as found.
            let mut by_key: HashMap<String, HandRow> = rows
                .into_iter()
                .map(|row| (row.hand_key.clone(), row))
                .collect();
            Ok(keys.iter().filter_map(|key| by_key.remove(key)).collect())
        })
    }

    /// A hand's note and tags.
    pub fn hand_annotations(&self, hand_key: &str) -> Result<Annotations> {
        self.with(|conn| {
            let note = conn
                .prepare_cached("SELECT note FROM hand_notes WHERE hand_key = ?1")?
                .query_row([hand_key], |row| row.get(0))
                .optional()?;
            let tags = conn
                .prepare_cached("SELECT tag FROM hand_tags WHERE hand_key = ?1 ORDER BY tag")?
                .query_map([hand_key], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Annotations { note, tags })
        })
    }

    /// Every tag in use, with how many hands have it, by name.
    pub fn hand_tags(&self) -> Result<Vec<FacetCount>> {
        self.with(|conn| {
            let mut stmt = conn
                .prepare_cached("SELECT tag, count(*) FROM hand_tags GROUP BY tag ORDER BY tag")?;
            let rows = stmt.query_map([], |row| {
                Ok(FacetCount {
                    value: row.get(0)?,
                    count: u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// Hands with a note.
    pub fn noted_hands(&self) -> Result<u64> {
        self.with(|conn| {
            let n: i64 = conn.query_row("SELECT count(*) FROM hand_notes", [], |row| row.get(0))?;
            u64::try_from(n).map_err(|_| Error::OutOfRange("count"))
        })
    }

    /// A screen's saved filters, by name.
    pub fn saved_filters(&self, screen: &str) -> Result<Vec<SavedFilter>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, name, filter, created_at FROM saved_filters
                 WHERE screen = ?1 ORDER BY name COLLATE NOCASE, id",
            )?;
            let rows = stmt.query_map([screen], |row| {
                Ok(SavedFilter {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    filter: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

/// The facets' pass: the rows of `sql` counted by group.
fn group_pass(conn: &Connection, sql: &str, params: &[Value]) -> Result<Vec<Group>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    let mut names = Names::default();
    let mut counts: HashMap<GroupKey, u64> = HashMap::new();
    let mut samples: HashMap<i64, (String, String)> = HashMap::new();
    while let Some(row) = rows.next()? {
        let segment_id: i64 = row.get(0)?;
        let net: Option<i64> = row.get(4)?;
        let stack: Option<i64> = row.get(5)?;
        let key = GroupKey {
            segment_id,
            position: names.of(row
                .get_ref(1)?
                .as_str_or_null()
                .map_err(rusqlite::Error::from)?
                .unwrap_or("")),
            pot_type: names.of(row.get_ref(2)?.as_str().map_err(rusqlite::Error::from)?),
            all_in: row.get(3)?,
            result: match net {
                None => "",
                Some(net) if net > 0 => RESULTS[0],
                Some(net) if net < 0 => RESULTS[1],
                Some(_) => RESULTS[2],
            },
            stack: stack.map_or("", stack_depth),
        };
        *counts.entry(key).or_insert(0) += 1;
        if let std::collections::hash_map::Entry::Vacant(entry) = samples.entry(segment_id) {
            entry.insert((row.get(6)?, row.get(7)?));
        }
    }
    let groups = counts
        .into_iter()
        .map(|(key, count)| {
            let (sample, symbol) = samples.get(&key.segment_id).cloned().unwrap_or_default();
            Group {
                segment_id: key.segment_id,
                position: names.list[key.position].clone(),
                pot_type: names.list[key.pot_type].clone(),
                all_in: if key.all_in { "1" } else { "0" }.to_owned(),
                result: key.result.to_owned(),
                stack: key.stack.to_owned(),
                count,
                sample,
                symbol,
            }
        })
        .collect();
    Ok(groups)
}

/// What a facets' pass is cached under: the read connection, its
/// `data_version` (it changes when another connection commits) and the
/// query with its parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FacetKey {
    connection: usize,
    version: i64,
    query: String,
}

/// The last few facets' passes (`Reader::hand_facets`).
#[derive(Default)]
pub(crate) struct FacetCache {
    entries: Vec<(FacetKey, std::sync::Arc<Vec<Group>>)>,
}

impl std::fmt::Debug for FacetCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FacetCache")
            .field("entries", &self.entries.len())
            .finish()
    }
}

impl FacetCache {
    /// Passes kept: one per read connection and a couple of date ranges.
    const SIZE: usize = 8;

    fn get(&mut self, key: &FacetKey) -> Option<std::sync::Arc<Vec<Group>>> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        let entry = self.entries.remove(at);
        let groups = std::sync::Arc::clone(&entry.1);
        self.entries.push(entry);
        Some(groups)
    }

    fn put(&mut self, key: FacetKey, groups: std::sync::Arc<Vec<Group>>) {
        // Entries of the same connection at an older version are stale.
        self.entries
            .retain(|(k, _)| k.connection != key.connection || k.version == key.version);
        if self.entries.len() >= Self::SIZE {
            self.entries.remove(0);
        }
        self.entries.push((key, groups));
    }
}

/// The counts of every group from the facets' pass.
fn facets(
    conn: &Connection,
    filter: &HandFilter,
    segments: &HashMap<i64, SegmentDims>,
    groups: &[Group],
) -> Result<HandFacets> {
    const DIMS: usize = 11;
    let mut counts: [BTreeMap<String, u64>; DIMS] = Default::default();
    // A sample hand and the unit's symbol per stake, for its label.
    let mut stake_samples: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut total = 0;
    for group in groups {
        let Some(dims) = segments.get(&group.segment_id) else {
            continue;
        };
        let values: [&str; DIMS] = [
            &dims.site,
            &dims.format,
            &dims.variant,
            &dims.limit,
            &dims.size,
            &dims.stake,
            &group.position,
            &group.pot_type,
            &group.result,
            &group.stack,
            &group.all_in,
        ];
        let all_in = filter.all_in.map(|all_in| i64::from(all_in).to_string());
        let matches: [bool; DIMS] = [
            allows(&filter.sites, values[0]),
            allows(&filter.formats, values[1]),
            allows(&filter.variants, values[2]),
            allows(&filter.limits, values[3]),
            allows(&filter.sizes, values[4]),
            allows(&filter.stakes, values[5]),
            allows(&filter.positions, values[6]),
            allows(&filter.pot_types, values[7]),
            allows(&filter.results, values[8]),
            allows(&filter.stacks, values[9]),
            all_in.as_deref().is_none_or(|all_in| all_in == values[10]),
        ];
        let misses = matches.iter().filter(|m| !**m).count();
        if misses == 0 {
            total += group.count;
        }
        for (dim, value) in values.iter().enumerate() {
            // Counted when every other group matches.
            let counted = misses == 0 || (misses == 1 && !matches[dim]);
            // No hero: no result or stack to show.
            if (dim == 8 || dim == 9) && value.is_empty() {
                continue;
            }
            tally(&mut counts[dim], value, group.count, counted);
        }
        stake_samples
            .entry(dims.stake.clone())
            .or_insert_with(|| (group.sample.clone(), group.symbol.clone()));
    }
    let [
        sites,
        formats,
        variants,
        limits,
        sizes,
        stakes,
        positions,
        pot_types,
        results,
        stacks,
        all_in,
    ] = counts;
    let mut stake_facets = Vec::new();
    for (value, count) in stakes {
        let mut facet = StakeFacet {
            value: value.clone(),
            count,
            currency: None,
            currency_symbol: None,
            minor_units: None,
            small_blind: None,
            big_blind: None,
        };
        if value != "chips"
            && let Some((sample, symbol)) = stake_samples.get(&value)
        {
            let unit: Option<(String, i64, i64, Option<i64>)> = conn
                .prepare_cached(
                    "SELECT h.currency, h.small_blind, h.big_blind, d.currency_minor_units
                     FROM hands h LEFT JOIN hand_stats d ON d.hand_key = h.hand_key
                     WHERE h.hand_key = ?1",
                )?
                .query_row([sample], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?;
            if let Some((currency, small_blind, big_blind, minor_units)) = unit {
                facet.currency = Some(currency);
                facet.currency_symbol = Some(symbol.clone());
                facet.minor_units = minor_units;
                facet.small_blind = Some(small_blind);
                facet.big_blind = Some(big_blind);
            }
        }
        stake_facets.push(facet);
    }
    // Stakes by size: the unit, then the big blind.
    stake_facets.sort_by(|a, b| {
        (a.value == "chips", &a.currency, a.big_blind).cmp(&(
            b.value == "chips",
            &b.currency,
            b.big_blind,
        ))
    });
    Ok(HandFacets {
        total,
        sites: facet_list(sites),
        formats: facet_list(formats),
        variants: facet_list(variants),
        limits: facet_list(limits),
        sizes: facet_list(sizes),
        stakes: stake_facets,
        positions: facet_list(positions),
        pot_types: facet_list(pot_types),
        results: facet_list(results),
        stacks: facet_list(stacks),
        all_in: facet_list(all_in),
    })
}

/* --------------------------------------------------------------- writes - */

/// A tag as stored: trimmed, inner whitespace one space. `None` when empty
/// or longer than [`TAG_MAX_CHARS`].
pub fn normalize_tag(tag: &str) -> Option<String> {
    let tag = tag.split_whitespace().collect::<Vec<_>>().join(" ");
    (!tag.is_empty() && tag.chars().count() <= TAG_MAX_CHARS).then_some(tag)
}

/// Set a hand's note; an empty (or blank) note removes it. Refused when
/// longer than [`NOTE_MAX_CHARS`].
pub fn set_note(conn: &Connection, hand_key: &str, note: &str, now_ms: i64) -> Result<()> {
    let note = note.trim_end();
    if note.chars().count() > NOTE_MAX_CHARS {
        return Err(Error::OutOfRange("note length"));
    }
    if note.trim().is_empty() {
        conn.prepare_cached("DELETE FROM hand_notes WHERE hand_key = ?1")?
            .execute([hand_key])?;
    } else {
        conn.prepare_cached(
            "INSERT INTO hand_notes (hand_key, note, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (hand_key) DO UPDATE SET note = excluded.note,
               updated_at = excluded.updated_at",
        )?
        .execute(params![hand_key, note, now_ms])?;
    }
    Ok(())
}

/// Tag a hand. Returns whether the tag is new on it; refused for an empty
/// or too long tag.
pub fn add_tag(conn: &Connection, hand_key: &str, tag: &str, now_ms: i64) -> Result<bool> {
    let tag = normalize_tag(tag).ok_or(Error::OutOfRange("tag"))?;
    Ok(conn
        .prepare_cached(
            "INSERT OR IGNORE INTO hand_tags (hand_key, tag, added_at) VALUES (?1, ?2, ?3)",
        )?
        .execute(params![hand_key, tag, now_ms])?
        == 1)
}

/// Take a tag off a hand. Returns whether it had it.
pub fn remove_tag(conn: &Connection, hand_key: &str, tag: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached("DELETE FROM hand_tags WHERE hand_key = ?1 AND tag = ?2")?
        .execute(params![hand_key, tag])?
        == 1)
}

/// Save a filter under `name` (trimmed) for `screen`, replacing one of the
/// same name. Returns its id.
pub fn save_filter(
    conn: &Connection,
    screen: &str,
    name: &str,
    filter: &str,
    now_ms: i64,
) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(Error::OutOfRange("filter name"));
    }
    Ok(conn
        .prepare_cached(
            "INSERT INTO saved_filters (screen, name, filter, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (screen, name) DO UPDATE SET filter = excluded.filter
             RETURNING id",
        )?
        .query_row(params![screen, name, filter, now_ms], |row| row.get(0))?)
}

/// Delete a saved filter. Returns whether it existed.
pub fn delete_saved_filter(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn
        .prepare_cached("DELETE FROM saved_filters WHERE id = ?1")?
        .execute([id])?
        == 1)
}

/// The tags `tags` normalised, unique, sorted (for a filter built from
/// user input).
pub fn tag_set(tags: &[String]) -> Vec<String> {
    tags.iter()
        .filter_map(|tag| normalize_tag(tag))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

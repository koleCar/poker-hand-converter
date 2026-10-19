//! The Players screen (docs/RAIL-PLAN.md R2.7c; guideline §6 "Igrači":
//! an opponent's profile, notes and colour tags).
//!
//! - **Who is a player** (docs/DATABASE.md "Player identity and anonymized
//!   rooms"): an opponent of a room that prints real screen names. A
//!   positionally anonymised room (Ignition) has no opponents' rows at all;
//!   an opaque-id room's tokens (GGPoker's hashes, ACR/WPN's mined ids) are
//!   one person within one session only, so they are summed per session in
//!   the rollups and are **counted here but never listed** - listing them
//!   would add up whoever wore a token across sessions (the web's
//!   `stats_opponents` leaves them out the same way and says how many).
//! - **The list** ([`Reader::player_list`]): `player_summary` (written with
//!   the statistics, `crate::stats`): per opponent the hands seen, first and
//!   last seen, the hero's hands with them and the hero's result against
//!   them in big blinds, cash and tournament chips apart. Read whole into
//!   memory once per commit (`PRAGMA data_version`, as the Hands screen's
//!   counts) and searched there: a case-insensitive prefix of the name
//!   (the web's `lower(player) like 'x%'`), sorted by hands together.
//!   Money as the web's `stats_opponents`: big blinds only, and none at
//!   all when the list's scope mixes tournament chips with cash.
//! - **A profile** ([`Reader::player_profile`]): the opponent's rollups
//!   (`player_rollups` at scope `''`, every segment of the site), the
//!   summary line and the user's words; **by position**
//!   ([`Reader::player_positions`]): one pass over the opponent's seat rows
//!   (their entries in `player_hands`, which the background pass writes
//!   shortly after the import: `StatsStatus::players_unindexed`), summed in
//!   Rust with `aggregate`'s defaults, as the rollups are.
//! - **The user's words** ([`set_note`], [`set_colour`], [`add_label`],
//!   [`remove_label`]): a colour from a fixed palette ([`COLOURS`]), up to
//!   [`LABELS_MAX`] labels and a note - the web's `player_notes` limits, so
//!   a later sync carries them unchanged. Refused (as the web's
//!   `set_player_note` refuses) unless the store has the name as an
//!   opponent in a room with real names: never on a seat label, never on a
//!   session's token. Local only for now.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Error, Result};
use crate::hand_list::segments;
use crate::read::Reader;
use crate::stats::{PlayerSeen, Totals, decode_seat};
use crate::stats_read::Rollup;

/// The colour tags, in the order the screen offers them.
pub const COLOURS: [&str; 6] = ["red", "orange", "yellow", "green", "blue", "purple"];

/// The longest note, in characters (the web's `player_notes.note`).
pub const NOTE_MAX_CHARS: usize = 2_000;

/// The longest label, in characters, and the most a player has (the web's
/// `player_notes.tags`).
pub const LABEL_MAX_CHARS: usize = 24;
pub const LABELS_MAX: usize = 8;

/// The most rows one list returns.
pub const LIST_MAX: u32 = 500;

/// Which hands a list counts: all of them, cash games, or the tournament
/// formats (chips).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GameKind {
    #[default]
    All,
    Cash,
    Chips,
}

impl GameKind {
    /// `all`, `cash`, `chips`.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "all" | "" => Some(Self::All),
            "cash" => Some(Self::Cash),
            "chips" => Some(Self::Chips),
            _ => None,
        }
    }
}

/// What the list shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerQuery {
    /// A prefix of the name, any case; empty: everybody.
    pub search: String,
    /// One room (`segments.site`).
    pub site: Option<String>,
    pub kind: GameKind,
    /// Players with any of these colours.
    pub colours: Vec<String>,
    /// Players with any of these labels.
    pub labels: Vec<String>,
    /// Only players with a note (`true`), or only those without (`false`).
    pub noted: Option<bool>,
    /// At most this many rows (capped at [`LIST_MAX`]).
    pub limit: u32,
}

/// One opponent in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerRow {
    pub site: String,
    pub player: String,
    /// Hands together (the hero played them too) in the list's kind.
    pub hands: i64,
    /// The hero's result against them in the list's kind, thousandths of a
    /// big blind, over `money_hands`; `None` when the list's scope mixes
    /// tournament chips with cash.
    pub net_bb_milli: Option<i64>,
    pub money_hands: i64,
    pub seen: PlayerSeen,
    pub colour: Option<String>,
    pub labels: Vec<String>,
    pub has_note: bool,
}

/// A page of the list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerList {
    pub rows: Vec<PlayerRow>,
    /// Players the query matches (the rows are the first of them).
    pub matching: u64,
    /// Players of the scope (room and kind) before the search, colours,
    /// labels and notes.
    pub players: u64,
    /// The scope's hands together in cash games and in tournaments (the
    /// screen opens on the bigger one when both are there, as Reports do).
    pub cash_hands: i64,
    pub chips_hands: i64,
    /// The scope mixes tournament chips with cash: no result is shown.
    pub mixed_kind: bool,
    /// Opponents' hands of opaque-id rooms in the scope: counted, not
    /// listed.
    pub hidden_hands: i64,
}

/// The user's words on a player.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerNotes {
    pub colour: Option<String>,
    pub note: String,
    pub labels: Vec<String>,
    pub updated_at: Option<i64>,
}

/// One opponent's profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerProfile {
    pub site: String,
    pub player: String,
    /// `None`: no opponent of that name in a room with real names (or the
    /// statistics are still being rebuilt).
    pub seen: Option<PlayerSeen>,
    /// `player_rollups` at scope `''`, one per segment of the site.
    pub rollups: Vec<Rollup>,
    pub notes: PlayerNotes,
}

/// An opponent's seat rows summed by position, and a hand of theirs per
/// segment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlayerPositions {
    /// Position (`""`: none assigned) -> totals.
    pub positions: BTreeMap<String, Totals>,
    /// `segments.id` -> a `hand_key` of theirs in it.
    pub samples: BTreeMap<i64, String>,
}

/// One summary line, as cached.
#[derive(Debug, Clone)]
struct Line {
    site: Arc<str>,
    player: String,
    /// `player` lower-cased, for the search.
    lower: String,
    seen: PlayerSeen,
}

/// What the list is cached under: the read connection and its
/// `data_version`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CacheKey {
    connection: usize,
    version: i64,
}

/// The last summary read (one: it is the whole table).
#[derive(Debug, Default)]
pub(crate) struct PlayerCache {
    entry: Option<(CacheKey, Arc<Vec<Line>>)>,
}

/// A label as stored: trimmed, inner whitespace one space, lower case (the
/// web's `set_player_note`). `None` when empty, longer than
/// [`LABEL_MAX_CHARS`] or holding a control character.
pub fn normalize_label(label: &str) -> Option<String> {
    let label = label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    (!label.is_empty()
        && label.chars().count() <= LABEL_MAX_CHARS
        && !label.chars().any(char::is_control))
    .then_some(label)
}

fn summary(conn: &Connection) -> Result<Vec<Line>> {
    let mut stmt = conn.prepare_cached(
        "SELECT site, player, hands, first_played_at, last_played_at, cash_hands, chips_hands,
                cash_money_hands, cash_net_bb_milli, chips_money_hands, chips_net_bb_milli
         FROM player_summary",
    )?;
    let mut rows = stmt.query([])?;
    let mut sites: HashMap<String, Arc<str>> = HashMap::new();
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let site: String = row.get(0)?;
        let site = Arc::clone(
            sites
                .entry(site)
                .or_insert_with_key(|site| Arc::from(site.as_str())),
        );
        let player: String = row.get(1)?;
        out.push(Line {
            site,
            lower: player.to_lowercase(),
            player,
            seen: seen_from(row, 2)?,
        });
    }
    Ok(out)
}

fn seen_from(row: &rusqlite::Row<'_>, first: usize) -> rusqlite::Result<PlayerSeen> {
    Ok(PlayerSeen {
        hands: row.get(first)?,
        first_played_at: row.get(first + 1)?,
        last_played_at: row.get(first + 2)?,
        cash_hands: row.get(first + 3)?,
        chips_hands: row.get(first + 4)?,
        cash_money_hands: row.get(first + 5)?,
        cash_net_bb_milli: row.get(first + 6)?,
        chips_money_hands: row.get(first + 7)?,
        chips_net_bb_milli: row.get(first + 8)?,
    })
}

/// Hands together in `kind`.
fn together(seen: &PlayerSeen, kind: GameKind) -> i64 {
    match kind {
        GameKind::All => seen.cash_hands + seen.chips_hands,
        GameKind::Cash => seen.cash_hands,
        GameKind::Chips => seen.chips_hands,
    }
}

/// The hero's result in `kind` (`None` for both kinds at once) and the
/// hands it is over.
fn result(seen: &PlayerSeen, kind: GameKind, mixed: bool) -> (Option<i64>, i64) {
    match kind {
        GameKind::Cash => (Some(seen.cash_net_bb_milli), seen.cash_money_hands),
        GameKind::Chips => (Some(seen.chips_net_bb_milli), seen.chips_money_hands),
        GameKind::All if mixed => (None, seen.cash_money_hands + seen.chips_money_hands),
        GameKind::All => (
            Some(seen.cash_net_bb_milli + seen.chips_net_bb_milli),
            seen.cash_money_hands + seen.chips_money_hands,
        ),
    }
}

/// Every player's words: (site, player) -> notes.
fn all_notes(conn: &Connection) -> Result<HashMap<(String, String), PlayerNotes>> {
    let mut out: HashMap<(String, String), PlayerNotes> = HashMap::new();
    let mut stmt =
        conn.prepare_cached("SELECT site, player, colour, note, updated_at FROM players")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        out.insert(
            (row.get(0)?, row.get(1)?),
            PlayerNotes {
                colour: row.get(2)?,
                note: row.get(3)?,
                labels: Vec::new(),
                updated_at: row.get(4)?,
            },
        );
    }
    let mut stmt = conn.prepare_cached(
        "SELECT site, player, label FROM player_labels ORDER BY site, player, label",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        out.entry((row.get(0)?, row.get(1)?))
            .or_default()
            .labels
            .push(row.get(2)?);
    }
    Ok(out)
}

fn notes_of(conn: &Connection, site: &str, player: &str) -> Result<PlayerNotes> {
    let mut notes = conn
        .prepare_cached(
            "SELECT colour, note, updated_at FROM players WHERE site = ?1 AND player = ?2",
        )?
        .query_row(params![site, player], |row| {
            Ok(PlayerNotes {
                colour: row.get(0)?,
                note: row.get(1)?,
                labels: Vec::new(),
                updated_at: row.get(2)?,
            })
        })
        .optional()?
        .unwrap_or_default();
    notes.labels = conn
        .prepare_cached(
            "SELECT label FROM player_labels WHERE site = ?1 AND player = ?2 ORDER BY label",
        )?
        .query_map(params![site, player], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(notes)
}

impl Reader {
    fn player_lines(&self, conn: &Connection) -> Result<Arc<Vec<Line>>> {
        let version: i64 = conn.query_row("PRAGMA data_version", [], |row| row.get(0))?;
        let key = CacheKey {
            connection: std::ptr::from_ref(conn) as usize,
            version,
        };
        if let Some((cached, lines)) = &self.player_cache().entry
            && *cached == key
        {
            return Ok(Arc::clone(lines));
        }
        let lines = Arc::new(summary(conn)?);
        self.player_cache().entry = Some((key, Arc::clone(&lines)));
        Ok(lines)
    }

    /// The opponents `query` matches, most hands together first (then by
    /// name), with the scope's counts (see [`PlayerList`]).
    pub fn player_list(&self, query: &PlayerQuery) -> Result<PlayerList> {
        let limit = usize::try_from(query.limit.clamp(1, LIST_MAX)).unwrap_or(1);
        let needle = query.search.trim().to_lowercase();
        self.with(|conn| {
            let lines = self.player_lines(conn)?;
            let site_ok = |site: &str| query.site.as_deref().is_none_or(|wanted| wanted == site);
            let mut list = PlayerList::default();
            for line in lines.iter().filter(|line| site_ok(&line.site)) {
                list.cash_hands += line.seen.cash_hands;
                list.chips_hands += line.seen.chips_hands;
            }
            // The web's rule: a scope with chips and cash has no result.
            list.mixed_kind =
                query.kind == GameKind::All && list.cash_hands > 0 && list.chips_hands > 0;
            let filtered_by_words =
                !query.colours.is_empty() || !query.labels.is_empty() || query.noted.is_some();
            let notes = all_notes(conn)?;
            let mut matched: Vec<&Line> = Vec::new();
            for line in lines.iter() {
                if !site_ok(&line.site) || together(&line.seen, query.kind) == 0 {
                    continue;
                }
                list.players += 1;
                if !line.lower.starts_with(&needle) {
                    continue;
                }
                if filtered_by_words {
                    let words = notes.get(&(line.site.to_string(), line.player.clone()));
                    let colour = words.and_then(|w| w.colour.as_deref());
                    if !query.colours.is_empty()
                        && !colour.is_some_and(|c| query.colours.iter().any(|q| q == c))
                    {
                        continue;
                    }
                    if !query.labels.is_empty()
                        && !words.is_some_and(|w| {
                            w.labels.iter().any(|l| query.labels.iter().any(|q| q == l))
                        })
                    {
                        continue;
                    }
                    if let Some(noted) = query.noted
                        && words.is_some_and(|w| !w.note.is_empty()) != noted
                    {
                        continue;
                    }
                }
                matched.push(line);
            }
            list.matching = u64::try_from(matched.len()).unwrap_or(u64::MAX);
            let by = |line: &&Line| together(&line.seen, query.kind);
            if matched.len() > limit {
                matched.select_nth_unstable_by(limit, |a, b| {
                    by(b).cmp(&by(a)).then_with(|| a.player.cmp(&b.player))
                });
                matched.truncate(limit);
            }
            matched.sort_by(|a, b| {
                by(b)
                    .cmp(&by(a))
                    .then_with(|| a.player.cmp(&b.player))
                    .then_with(|| a.site.cmp(&b.site))
            });
            list.rows = matched
                .into_iter()
                .map(|line| {
                    let (net, money_hands) = result(&line.seen, query.kind, list.mixed_kind);
                    let words = notes
                        .get(&(line.site.to_string(), line.player.clone()))
                        .cloned()
                        .unwrap_or_default();
                    PlayerRow {
                        site: line.site.to_string(),
                        player: line.player.clone(),
                        hands: together(&line.seen, query.kind),
                        net_bb_milli: net,
                        money_hands,
                        seen: line.seen.clone(),
                        has_note: !words.note.is_empty(),
                        colour: words.colour,
                        labels: words.labels,
                    }
                })
                .collect();
            let mut stmt =
                conn.prepare_cached("SELECT site, hands, cash_hands FROM player_hidden")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let site: String = row.get(0)?;
                if !site_ok(&site) {
                    continue;
                }
                let (hands, cash): (i64, i64) = (row.get(1)?, row.get(2)?);
                list.hidden_hands += match query.kind {
                    GameKind::All => hands,
                    GameKind::Cash => cash,
                    GameKind::Chips => hands - cash,
                };
            }
            Ok(list)
        })
    }

    /// One opponent: the summary line, the rollups of every segment of the
    /// site, and the user's words.
    pub fn player_profile(&self, site: &str, player: &str) -> Result<PlayerProfile> {
        let rollups = self.player_rollups(site, player, "")?;
        self.with(|conn| {
            let seen = conn
                .prepare_cached(
                    "SELECT hands, first_played_at, last_played_at, cash_hands, chips_hands,
                            cash_money_hands, cash_net_bb_milli, chips_money_hands,
                            chips_net_bb_milli
                     FROM player_summary WHERE site = ?1 AND player = ?2",
                )?
                .query_row(params![site, player], |row| seen_from(row, 0))
                .optional()?;
            Ok(PlayerProfile {
                site: site.to_owned(),
                player: player.to_owned(),
                seen,
                rollups,
                notes: notes_of(conn, site, player)?,
            })
        })
    }

    /// An opponent's totals by position (`""`: none assigned), with
    /// `aggregate`'s defaults (bomb pots out, an EV cashout's money out),
    /// from their seat rows, and a hand of theirs per segment (a stake's
    /// label). With `segments`, only those segments.
    pub fn player_positions(
        &self,
        site: &str,
        player: &str,
        segment_ids: Option<&[i64]>,
    ) -> Result<PlayerPositions> {
        self.positions_of(site, player, segment_ids, false)
    }

    /// (R3.8) [`Reader::player_positions`] over the hands the user played
    /// only (a hand with a hero seat, R3.7's rule): the HUD popup's "by
    /// position" on a room that allows statistics from the user's own hands
    /// only (`ownHandsOnly`).
    pub fn player_own_positions(
        &self,
        site: &str,
        player: &str,
        segment_ids: Option<&[i64]>,
    ) -> Result<PlayerPositions> {
        self.positions_of(site, player, segment_ids, true)
    }

    fn positions_of(
        &self,
        site: &str,
        player: &str,
        segment_ids: Option<&[i64]>,
        own_hands_only: bool,
    ) -> Result<PlayerPositions> {
        self.with(|conn| {
            let dims = segments(conn)?;
            let mut stmt = conn.prepare_cached(if own_hands_only {
                "SELECT d.segment_id, coalesce(s.position, ''), d.is_bomb_pot, d.has_cashout,
                        s.totals, d.hand_key
                 FROM player_hands p
                 CROSS JOIN seat_stats s ON s.hand_id = p.hand_id AND s.seat = p.seat
                 CROSS JOIN hand_stats d ON d.id = p.hand_id
                 WHERE p.player = ?1
                   AND EXISTS (SELECT 1 FROM seat_stats h
                               WHERE h.hand_id = p.hand_id AND h.is_hero = 1)"
            } else {
                "SELECT d.segment_id, coalesce(s.position, ''), d.is_bomb_pot, d.has_cashout,
                        s.totals, d.hand_key
                 FROM player_hands p
                 CROSS JOIN seat_stats s ON s.hand_id = p.hand_id AND s.seat = p.seat
                 CROSS JOIN hand_stats d ON d.id = p.hand_id
                 WHERE p.player = ?1"
            })?;
            let mut rows = stmt.query([player])?;
            let mut out = PlayerPositions::default();
            while let Some(row) = rows.next()? {
                let segment: i64 = row.get(0)?;
                if dims.get(&segment).is_none_or(|dims| dims.site != site)
                    || segment_ids.is_some_and(|ids| !ids.contains(&segment))
                {
                    continue;
                }
                if let std::collections::btree_map::Entry::Vacant(entry) =
                    out.samples.entry(segment)
                {
                    entry.insert(row.get(5)?);
                }
                let (bomb, cashout): (bool, bool) = (row.get(2)?, row.get(3)?);
                if bomb {
                    continue;
                }
                let values =
                    decode_seat(row.get_ref(4)?.as_blob().map_err(rusqlite::Error::from)?)?;
                out.positions
                    .entry(row.get(1)?)
                    .or_default()
                    .add_seat(&values, !cashout);
            }
            Ok(out)
        })
    }

    /// The user's words on a player.
    pub fn player_notes(&self, site: &str, player: &str) -> Result<PlayerNotes> {
        self.with(|conn| notes_of(conn, site, player))
    }

    /// Every label in use, with how many players have it, by name.
    pub fn player_labels(&self) -> Result<Vec<(String, u64)>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT label, count(*) FROM player_labels GROUP BY label ORDER BY label",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    u64::try_from(row.get::<_, i64>(1)?).unwrap_or(0),
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

/* --------------------------------------------------------------- writes - */

/// Whether the store has `player` as an opponent on `site` in a room that
/// prints real names: an entry in `player_hands` (a seat row at scope `''`
/// that is not the hero's: the web's `set_player_note` rule, a player you
/// sat with in a room whose names are names) or a summary line (during the
/// rebuild after an upgrade, until the pass reaches their hands). A
/// positional room has no such rows; an opaque token's rows have its
/// session as their scope.
pub fn is_opponent(conn: &Connection, site: &str, player: &str) -> Result<bool> {
    let summed = conn
        .prepare_cached("SELECT 1 FROM player_summary WHERE site = ?1 AND player = ?2")?
        .exists(params![site, player])?;
    Ok(summed
        || conn
            .prepare_cached(
                "SELECT 1 FROM player_hands p
                 CROSS JOIN hand_stats d ON d.id = p.hand_id
                 CROSS JOIN segments g ON g.id = d.segment_id
                 WHERE p.player = ?2 AND g.site = ?1
                 LIMIT 1",
            )?
            .exists(params![site, player])?)
}

fn require_opponent(conn: &Connection, site: &str, player: &str) -> Result<()> {
    if player.is_empty() || !is_opponent(conn, site, player)? {
        return Err(Error::NotAnOpponent);
    }
    Ok(())
}

/// Write the `players` row (colour and note), or delete it when both are
/// empty.
fn put_row(
    conn: &Connection,
    site: &str,
    player: &str,
    colour: Option<&str>,
    note: &str,
    now_ms: i64,
) -> Result<()> {
    if colour.is_none() && note.is_empty() {
        conn.prepare_cached("DELETE FROM players WHERE site = ?1 AND player = ?2")?
            .execute(params![site, player])?;
    } else {
        conn.prepare_cached(
            "INSERT INTO players (site, player, colour, note, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (site, player) DO UPDATE SET colour = excluded.colour,
               note = excluded.note, updated_at = excluded.updated_at",
        )?
        .execute(params![site, player, colour, note, now_ms])?;
    }
    Ok(())
}

fn current(conn: &Connection, site: &str, player: &str) -> Result<(Option<String>, String)> {
    Ok(conn
        .prepare_cached("SELECT colour, note FROM players WHERE site = ?1 AND player = ?2")?
        .query_row(params![site, player], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?
        .unwrap_or_default())
}

/// Set a player's note (trimmed; empty removes it). Refused when longer
/// than [`NOTE_MAX_CHARS`], and for anyone but an opponent of a room with
/// real names (clearing is always allowed).
pub fn set_note(
    conn: &Connection,
    site: &str,
    player: &str,
    note: &str,
    now_ms: i64,
) -> Result<()> {
    let note = note.trim();
    if note.chars().count() > NOTE_MAX_CHARS {
        return Err(Error::OutOfRange("note length"));
    }
    if !note.is_empty() {
        require_opponent(conn, site, player)?;
    }
    let (colour, _) = current(conn, site, player)?;
    put_row(conn, site, player, colour.as_deref(), note, now_ms)
}

/// Set a player's colour tag (`None` takes it off). Refused for a colour
/// outside [`COLOURS`], and as [`set_note`].
pub fn set_colour(
    conn: &Connection,
    site: &str,
    player: &str,
    colour: Option<&str>,
    now_ms: i64,
) -> Result<()> {
    if let Some(colour) = colour {
        if !COLOURS.contains(&colour) {
            return Err(Error::OutOfRange("colour"));
        }
        require_opponent(conn, site, player)?;
    }
    let (_, note) = current(conn, site, player)?;
    put_row(conn, site, player, colour, &note, now_ms)
}

/// Label a player. Returns whether the label is new on them; refused for
/// an empty, too long or ninth label, and as [`set_note`].
pub fn add_label(
    conn: &Connection,
    site: &str,
    player: &str,
    label: &str,
    now_ms: i64,
) -> Result<bool> {
    let label = normalize_label(label).ok_or(Error::OutOfRange("label"))?;
    require_opponent(conn, site, player)?;
    let has: i64 = conn
        .prepare_cached("SELECT count(*) FROM player_labels WHERE site = ?1 AND player = ?2")?
        .query_row(params![site, player], |row| row.get(0))?;
    let exists = conn
        .prepare_cached(
            "SELECT 1 FROM player_labels WHERE site = ?1 AND player = ?2 AND label = ?3",
        )?
        .exists(params![site, player, label])?;
    if exists {
        return Ok(false);
    }
    if usize::try_from(has).unwrap_or(usize::MAX) >= LABELS_MAX {
        return Err(Error::OutOfRange("labels"));
    }
    conn.prepare_cached(
        "INSERT INTO player_labels (site, player, label, added_at) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![site, player, label, now_ms])?;
    Ok(true)
}

/// Take a label off a player. Returns whether they had it.
pub fn remove_label(conn: &Connection, site: &str, player: &str, label: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached("DELETE FROM player_labels WHERE site = ?1 AND player = ?2 AND label = ?3")?
        .execute(params![site, player, label])?
        == 1)
}

#[cfg(test)]
mod tests {
    use super::{GameKind, normalize_label};

    #[test]
    fn labels_are_normalised() {
        assert_eq!(
            normalize_label("  Loose   Fish "),
            Some("loose fish".to_owned())
        );
        assert_eq!(normalize_label(""), None);
        assert_eq!(normalize_label("   "), None);
        assert_eq!(normalize_label(&"x".repeat(24)), Some("x".repeat(24)));
        assert_eq!(normalize_label(&"x".repeat(25)), None);
        assert_eq!(normalize_label("a\u{7}b"), None);
    }

    #[test]
    fn game_kinds() {
        assert_eq!(GameKind::parse("cash"), Some(GameKind::Cash));
        assert_eq!(GameKind::parse("chips"), Some(GameKind::Chips));
        assert_eq!(GameKind::parse(""), Some(GameKind::All));
        assert_eq!(GameKind::parse("spin"), None);
    }
}

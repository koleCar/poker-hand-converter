//! The Players screen (docs/RAIL-PLAN.md R2.7c): thin commands over
//! `rail_store::players` (the list, its search and the rules for who is a
//! player are the store's) and the displayed statistics (R2.4 / R2.5).
//!
//! - `players_list(query)`: the opponents of rooms with real screen names,
//!   most hands together first, searched by a prefix of the name, with the
//!   hero's result against each in big blinds (none when the list mixes
//!   tournament chips with cash, as the web's `stats_opponents`) and the
//!   opaque-id opponents' hands counted, not listed;
//! - `player_profile(site, player, kind)`: one opponent - the summary, the
//!   user's words, every `players: any` statistic over their rollups (a
//!   `players: hero` one is withheld: all-in EV exists for the hero only),
//!   and their rows by position, stake, table size and game;
//! - `player_set_note`, `player_set_colour`, `player_add_label`,
//!   `player_remove_label`, `player_labels`: the user's words (local only
//!   for now; refused by the store for anyone but an opponent of a room
//!   with real names).

use std::collections::BTreeMap;

use rail_config::stats::{Players, Unit};
use rail_store::players::{self, GameKind, PlayerNotes, PlayerQuery, PlayerRow};
use rail_store::report::Units;
use rail_store::{PlayerSeen, Totals};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::StoreState;
use crate::hands::site_name;
use crate::reports::{BREAKDOWN_COLUMNS, GroupDto, ShownDto, display, show_all, totals_row};

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

fn kind(text: Option<&str>) -> Result<GameKind, String> {
    GameKind::parse(text.unwrap_or("all")).ok_or_else(|| "no such game kind".to_owned())
}

/// The list's query from the window: every field optional.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerQueryDto {
    search: String,
    site: Option<String>,
    /// `all` (default), `cash`, `chips`.
    kind: Option<String>,
    colours: Vec<String>,
    labels: Vec<String>,
    noted: Option<bool>,
    limit: Option<u32>,
}

impl PlayerQueryDto {
    fn query(self) -> Result<PlayerQuery, String> {
        Ok(PlayerQuery {
            search: self.search,
            site: self.site.filter(|site| !site.is_empty()),
            kind: kind(self.kind.as_deref())?,
            colours: self.colours,
            labels: self
                .labels
                .iter()
                .filter_map(|label| players::normalize_label(label))
                .collect(),
            noted: self.noted,
            limit: self.limit.unwrap_or(200),
        })
    }
}

/// The hero's hands with an opponent and result against them, one kind.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TogetherDto {
    hands: i64,
    money_hands: i64,
    net_bb_milli: i64,
}

/// `PlayerSeen`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeenDto {
    /// Their seat rows counted (bomb pots out): the statistics' sample.
    hands: i64,
    first_played_at: Option<String>,
    last_played_at: Option<String>,
    cash: TogetherDto,
    chips: TogetherDto,
}

impl From<&PlayerSeen> for SeenDto {
    fn from(seen: &PlayerSeen) -> Self {
        Self {
            hands: seen.hands,
            first_played_at: seen.first_played_at.clone(),
            last_played_at: seen.last_played_at.clone(),
            cash: TogetherDto {
                hands: seen.cash_hands,
                money_hands: seen.cash_money_hands,
                net_bb_milli: seen.cash_net_bb_milli,
            },
            chips: TogetherDto {
                hands: seen.chips_hands,
                money_hands: seen.chips_money_hands,
                net_bb_milli: seen.chips_net_bb_milli,
            },
        }
    }
}

/// `PlayerNotes`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotesDto {
    colour: Option<String>,
    note: String,
    labels: Vec<String>,
}

impl From<PlayerNotes> for NotesDto {
    fn from(notes: PlayerNotes) -> Self {
        Self {
            colour: notes.colour,
            note: notes.note,
            labels: notes.labels,
        }
    }
}

/// One opponent in the list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRowDto {
    site: String,
    /// The room's name (`sites.json`).
    site_name: String,
    player: String,
    /// Hands together in the list's kind.
    hands: i64,
    /// The hero's result against them, thousandths of a big blind; `None`
    /// when the list mixes chips with cash.
    net_bb_milli: Option<i64>,
    money_hands: i64,
    first_played_at: Option<String>,
    last_played_at: Option<String>,
    colour: Option<String>,
    labels: Vec<String>,
    has_note: bool,
}

impl From<PlayerRow> for PlayerRowDto {
    fn from(row: PlayerRow) -> Self {
        Self {
            site_name: site_name(&row.site),
            site: row.site,
            player: row.player,
            hands: row.hands,
            net_bb_milli: row.net_bb_milli,
            money_hands: row.money_hands,
            first_played_at: row.seen.first_played_at,
            last_played_at: row.seen.last_played_at,
            colour: row.colour,
            labels: row.labels,
            has_note: row.has_note,
        }
    }
}

/// A room with players, for the room filter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDto {
    value: String,
    name: String,
}

/// The list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerListDto {
    rows: Vec<PlayerRowDto>,
    matching: u64,
    players: u64,
    cash_hands: i64,
    chips_hands: i64,
    mixed_kind: bool,
    hidden_hands: i64,
}

/// A label in use and how many players have it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelDto {
    value: String,
    count: u64,
}

/// A stake's label parts: a hand of the opponent's at that stake.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StakeSampleDto {
    /// `segments.stake`: `USD:200`.
    key: String,
    currency: String,
    currency_symbol: String,
    minor_units: i64,
    small_blind: i64,
    big_blind: i64,
}

/// One opponent's profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDto {
    site: String,
    site_name: String,
    player: String,
    /// `None`: not an opponent of a room with real names (nothing to show,
    /// nothing to note).
    seen: Option<SeenDto>,
    notes: NotesDto,
    /// The profile's sample mixes tournament chips with cash: big-blind
    /// statistics are withheld.
    mixed_kind: bool,
    /// Every definition over their rollups, in `stat_definitions`' order;
    /// a `players: hero` statistic is withheld.
    stats: Vec<ShownDto>,
    /// [`BREAKDOWN_COLUMNS`]: the statistics of every group row.
    columns: Vec<&'static str>,
    by_position: Vec<GroupDto>,
    by_stake: Vec<GroupDto>,
    by_size: Vec<GroupDto>,
    by_format: Vec<GroupDto>,
    /// The cash stakes of `by_stake`, for their labels.
    stakes: Vec<StakeSampleDto>,
    /// Their newest hand counted in the profile's kind.
    last_played_at: Option<String>,
}

/// The profile of `player` on `site` over `kind`'s segments.
pub fn build_profile(
    reader: &rail_store::Reader,
    site: &str,
    player: &str,
    kind: GameKind,
) -> Result<ProfileDto, String> {
    let display = display()?;
    let profile = reader.player_profile(site, player).map_err(text)?;
    let segments: BTreeMap<i64, rail_stats::Segment> = reader
        .segments()
        .map_err(text)?
        .into_iter()
        .map(|row| (row.id, row.segment))
        .collect();
    let in_kind = |id: i64| {
        segments.get(&id).is_some_and(|segment| {
            let cash = segment.format == rail_core::phf::GameFormat::Cash;
            match kind {
                GameKind::All => true,
                GameKind::Cash => cash,
                GameKind::Chips => !cash,
            }
        })
    };
    let rollups: Vec<_> = profile
        .rollups
        .iter()
        .filter(|rollup| in_kind(rollup.segment_id))
        .collect();
    let (mut cash, mut chips) = (false, false);
    let mut all = Totals::default();
    for rollup in &rollups {
        all.add(&rollup.totals, true);
        let is_cash = segments
            .get(&rollup.segment_id)
            .is_some_and(|segment| segment.format == rail_core::phf::GameFormat::Cash);
        cash |= is_cash;
        chips |= !is_cash;
    }
    // An opponent's money is never shown (the web's opponents report is in
    // big blinds), and big blinds only within one kind.
    let units = Units {
        mixed_kind: cash && chips,
        ..Units::default()
    };
    let stats = show_all(display, &all.sums(), &units, None)
        .into_iter()
        .zip(&display.stats)
        .map(|(shown, stat)| {
            if stat.def.players == Players::Hero || stat.def.format.unit == Unit::Money {
                shown.withheld()
            } else {
                shown
            }
        })
        .collect();
    let by = |key: &dyn Fn(&rail_stats::Segment) -> String| {
        let mut groups: BTreeMap<String, Totals> = BTreeMap::new();
        for rollup in &rollups {
            if let Some(segment) = segments.get(&rollup.segment_id) {
                groups
                    .entry(key(segment))
                    .or_default()
                    .add(&rollup.totals, true);
            }
        }
        groups
            .into_iter()
            .map(|(key, totals)| totals_row(key, None, &totals, display, &units))
            .collect::<Vec<_>>()
    };
    let by_stake = by(&|segment| segment.stake.key());
    let by_size = by(&|segment| segment.size.as_str().to_owned());
    let by_format = by(&|segment| segment.format.as_str().to_owned());
    let ids: Vec<i64> = rollups.iter().map(|rollup| rollup.segment_id).collect();
    let pass = if profile.seen.is_some() {
        reader
            .player_positions(site, player, Some(&ids))
            .map_err(text)?
    } else {
        rail_store::players::PlayerPositions::default()
    };
    let by_position = pass
        .positions
        .iter()
        .map(|(position, totals)| totals_row(position.clone(), None, totals, display, &units))
        .collect();
    // One hand per cash stake gives its label (the blinds and the unit).
    let mut samples: BTreeMap<String, String> = BTreeMap::new();
    for (segment, hand_key) in &pass.samples {
        if let Some(segment) = segments.get(segment)
            && segment.format == rail_core::phf::GameFormat::Cash
        {
            samples
                .entry(segment.stake.key())
                .or_insert_with(|| hand_key.clone());
        }
    }
    let keys: Vec<String> = samples.values().cloned().collect();
    let rows = reader.hand_rows(&keys).map_err(text)?;
    let stakes = samples
        .iter()
        .filter_map(|(stake, hand_key)| {
            rows.iter()
                .find(|row| &row.hand_key == hand_key)
                .map(|row| StakeSampleDto {
                    key: stake.clone(),
                    currency: row.currency.clone(),
                    currency_symbol: row.currency_symbol.clone(),
                    minor_units: row.minor_units,
                    small_blind: row.small_blind,
                    big_blind: row.big_blind,
                })
        })
        .collect();
    let last_played_at = rollups
        .iter()
        .filter_map(|rollup| rollup.last_played_at.clone())
        .max();
    Ok(ProfileDto {
        site: site.to_owned(),
        site_name: site_name(site),
        player: player.to_owned(),
        seen: profile.seen.as_ref().map(SeenDto::from),
        notes: profile.notes.into(),
        mixed_kind: units.mixed_kind,
        stats,
        columns: BREAKDOWN_COLUMNS.to_vec(),
        by_position,
        by_stake,
        by_size,
        by_format,
        stakes,
        last_played_at,
    })
}

#[tauri::command]
pub async fn players_list(
    store: State<'_, StoreState>,
    query: PlayerQueryDto,
) -> Result<PlayerListDto, String> {
    let list = open(&store)?
        .reader()
        .player_list(&query.query()?)
        .map_err(text)?;
    Ok(PlayerListDto {
        rows: list.rows.into_iter().map(PlayerRowDto::from).collect(),
        matching: list.matching,
        players: list.players,
        cash_hands: list.cash_hands,
        chips_hands: list.chips_hands,
        mixed_kind: list.mixed_kind,
        hidden_hands: list.hidden_hands,
    })
}

#[tauri::command]
pub async fn player_profile(
    store: State<'_, StoreState>,
    site: String,
    player: String,
    kind: Option<String>,
) -> Result<ProfileDto, String> {
    build_profile(
        open(&store)?.reader(),
        &site,
        &player,
        self::kind(kind.as_deref())?,
    )
}

/// The rooms of the store's opponents, by name (the list's room filter).
#[tauri::command]
pub async fn player_sites(store: State<'_, StoreState>) -> Result<Vec<SiteDto>, String> {
    let mut sites: Vec<SiteDto> = open(&store)?
        .reader()
        .segments()
        .map_err(text)?
        .into_iter()
        .map(|row| row.segment.site)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|site| SiteDto {
            name: site_name(&site),
            value: site,
        })
        .collect();
    sites.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(sites)
}

#[tauri::command]
pub async fn player_labels(store: State<'_, StoreState>) -> Result<Vec<LabelDto>, String> {
    Ok(open(&store)?
        .reader()
        .player_labels()
        .map_err(text)?
        .into_iter()
        .map(|(value, count)| LabelDto { value, count })
        .collect())
}

/// The player's words after a write (or the write's error).
fn notes_after(
    store: &rail_store::Store,
    site: &str,
    player: &str,
    written: rail_store::Result<()>,
) -> Result<NotesDto, String> {
    written.map_err(text)?;
    Ok(store
        .reader()
        .player_notes(site, player)
        .map_err(text)?
        .into())
}

#[tauri::command]
pub async fn player_set_note(
    store: State<'_, StoreState>,
    site: String,
    player: String,
    note: String,
) -> Result<NotesDto, String> {
    let store = open(&store)?;
    let (s, p) = (site.clone(), player.clone());
    let written = store.writer().and_then(|writer| {
        writer.write(move |tx| players::set_note(tx, &s, &p, &note, rail_store::time::now_ms()))
    });
    notes_after(store, &site, &player, written)
}

#[tauri::command]
pub async fn player_set_colour(
    store: State<'_, StoreState>,
    site: String,
    player: String,
    colour: Option<String>,
) -> Result<NotesDto, String> {
    let store = open(&store)?;
    let (s, p) = (site.clone(), player.clone());
    let written = store.writer().and_then(|writer| {
        writer.write(move |tx| {
            players::set_colour(tx, &s, &p, colour.as_deref(), rail_store::time::now_ms())
        })
    });
    notes_after(store, &site, &player, written)
}

#[tauri::command]
pub async fn player_add_label(
    store: State<'_, StoreState>,
    site: String,
    player: String,
    label: String,
) -> Result<NotesDto, String> {
    let store = open(&store)?;
    let (s, p) = (site.clone(), player.clone());
    let written = store.writer().and_then(|writer| {
        writer.write(move |tx| {
            players::add_label(tx, &s, &p, &label, rail_store::time::now_ms()).map(|_| ())
        })
    });
    notes_after(store, &site, &player, written)
}

#[tauri::command]
pub async fn player_remove_label(
    store: State<'_, StoreState>,
    site: String,
    player: String,
    label: String,
) -> Result<NotesDto, String> {
    let store = open(&store)?;
    let (s, p) = (site.clone(), player.clone());
    let written = store.writer().and_then(|writer| {
        writer.write(move |tx| players::remove_label(tx, &s, &p, &label).map(|_| ()))
    });
    notes_after(store, &site, &player, written)
}

#[cfg(test)]
mod tests {
    use super::PlayerQueryDto;
    use rail_store::players::GameKind;

    /// The window's query JSON: camelCase, every field optional; labels
    /// normalised; an unknown kind refused.
    #[test]
    fn a_query_from_the_window() {
        let dto: PlayerQueryDto = serde_json::from_str(
            r#"{"search":"ab","kind":"cash","labels":[" Fish ",""],"site":"","limit":8}"#,
        )
        .expect("query");
        let query = dto.query().expect("valid");
        assert_eq!(query.search, "ab");
        assert_eq!(query.kind, GameKind::Cash);
        assert_eq!(query.labels, ["fish"]);
        assert_eq!(query.site, None);
        assert_eq!(query.limit, 8);
        let empty: PlayerQueryDto = serde_json::from_str("{}").expect("empty");
        assert_eq!(empty.query().expect("valid").kind, GameKind::All);
        let bad: PlayerQueryDto = serde_json::from_str(r#"{"kind":"spin"}"#).expect("parses");
        assert!(bad.query().is_err());
    }

    /// A profile over a fixture file (a cash table, the hero in every hand): every definition in order, the
    /// hero-only one withheld, the rows by position adding up to the
    /// opponent's hands; a name that is no opponent has nothing.
    #[test]
    fn a_profile_from_a_store() {
        use rail_config::stats::Players;

        let dir = std::env::temp_dir().join(format!("rail-app-players-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = crate::commands::StoreState::open(dir.join(rail_store::FILE_NAME));
        let store = state.store.as_ref().expect("open");
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/samples/weplay")
            .join("01-cash-nlhe-8max-0.25-0.50.txt");
        rail_store::import_file(store, &file, &rail_store::ImportOptions::default())
            .expect("import");
        let writer = store.writer().expect("writer");
        rail_store::background::drain(store.reader(), &writer).expect("drain");
        drop(writer);
        let list = store
            .reader()
            .player_list(&rail_store::PlayerQuery {
                limit: 5,
                ..rail_store::PlayerQuery::default()
            })
            .expect("list");
        let top = list.rows.first().expect("an opponent");
        let profile = super::build_profile(store.reader(), &top.site, &top.player, GameKind::All)
            .expect("profile");
        let display = super::display().expect("display");
        assert_eq!(profile.stats.len(), display.stats.len());
        for (shown, stat) in profile.stats.iter().zip(&display.stats) {
            if stat.def.players == Players::Hero {
                assert!(shown.value_is_withheld(), "{}", stat.def.id);
            }
        }
        let seen = profile.seen.as_ref().expect("an opponent");
        let by_position: i64 = profile.by_position.iter().map(|row| row.hands()).sum();
        assert_eq!(by_position, seen.hands);
        assert!(!profile.mixed_kind, "cash only");
        assert!(!profile.stakes.is_empty(), "a cash stake's label");
        let nobody = super::build_profile(store.reader(), &top.site, "nobody", GameKind::All)
            .expect("profile");
        assert!(nobody.seen.is_none() && nobody.by_position.is_empty());
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! The Hands screen (docs/RAIL-PLAN.md R2.7a): thin commands over
//! `rail_store::hand_list` (the queries, filters and counts are the
//! store's).
//!
//! - `hands_page(filter, after?, limit)`: a page of the list, newest first,
//!   with a keyset cursor for the next one;
//! - `hands_facets(filter)`: the counts beside the filter chips, the tags in
//!   use and how many hands have a note;
//! - `hands_by_key(keys)`, `hands_find(query)`: list rows of given hands,
//!   and "go to hand" by the room's id (the command palette);
//! - `hand_phf(handKey)`: a hand's PHF (JSON text) for the replayer;
//! - `hand_annotations`, `hand_set_note`, `hand_add_tag`,
//!   `hand_remove_tag`: a hand's note and tags (local only for now);
//! - `saved_filters`, `save_filter`, `delete_saved_filter`: the screen's
//!   saved filters (the filter as the window wrote it, JSON).
//!
//! All async: they run off the main thread, so a slow query never blocks
//! the window.

use rail_store::hand_list::{self, FacetCount, HandCursor, HandFilter, HandRow, StakeFacet};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::StoreState;

/// The screen the saved filters belong to.
const SCREEN: &str = "hands";

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

/// A room's name in `sites.json` for a site id as hands carry it (the
/// entry of that id, else the first one its parser reads), else the id.
pub fn site_name(site: &str) -> String {
    let id = site.trim().to_lowercase();
    crate::folders::sites()
        .ok()
        .and_then(|config| {
            config.site(&id).or_else(|| {
                config
                    .sites
                    .iter()
                    .find(|entry| entry.parser.as_deref() == Some(id.as_str()))
            })
        })
        .map_or_else(|| site.trim().to_owned(), |entry| entry.name.clone())
}

/// `HandFilter` from the window: every group "any" when absent.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterDto {
    sites: Vec<String>,
    formats: Vec<String>,
    variants: Vec<String>,
    limits: Vec<String>,
    sizes: Vec<String>,
    stakes: Vec<String>,
    positions: Vec<String>,
    pot_types: Vec<String>,
    results: Vec<String>,
    stacks: Vec<String>,
    all_in: Option<bool>,
    has_note: Option<bool>,
    tags: Vec<String>,
    /// ISO instants: from (inclusive), to (exclusive).
    from: Option<String>,
    to: Option<String>,
}

impl From<FilterDto> for HandFilter {
    fn from(dto: FilterDto) -> Self {
        Self {
            sites: dto.sites,
            formats: dto.formats,
            variants: dto.variants,
            limits: dto.limits,
            sizes: dto.sizes,
            stakes: dto.stakes,
            positions: dto.positions,
            pot_types: dto.pot_types,
            results: dto.results,
            stacks: dto.stacks,
            all_in: dto.all_in,
            has_note: dto.has_note,
            tags: hand_list::tag_set(&dto.tags),
            from: dto.from.filter(|from| !from.is_empty()),
            to: dto.to.filter(|to| !to.is_empty()),
        }
    }
}

/// `HandCursor`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorDto {
    played_at: String,
    hand_key: String,
}

impl From<HandCursor> for CursorDto {
    fn from(cursor: HandCursor) -> Self {
        Self {
            played_at: cursor.played_at,
            hand_key: cursor.hand_key,
        }
    }
}

/// `HandRow`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandRowDto {
    hand_key: String,
    site: String,
    /// The room's name (`sites.json`).
    site_name: String,
    site_hand_id: String,
    played_at: Option<String>,
    game_format: String,
    variant: String,
    limit_type: String,
    currency: String,
    currency_symbol: String,
    minor_units: i64,
    small_blind: i64,
    big_blind: i64,
    ante: i64,
    max_seats: i64,
    table_name: Option<String>,
    hero_position: Option<String>,
    hero_cards: Vec<String>,
    board: Vec<String>,
    hero_net: Option<i64>,
    hero_net_bb_milli: Option<i64>,
    all_in: bool,
    ev_net: Option<i64>,
    ev_net_bb_milli: Option<i64>,
    ev_pending: bool,
    pot_type: String,
    total_pot: i64,
    showdown: bool,
    has_note: bool,
    tags: Vec<String>,
}

impl From<HandRow> for HandRowDto {
    fn from(row: HandRow) -> Self {
        Self {
            hand_key: row.hand_key,
            site_name: site_name(&row.site),
            site: row.site,
            site_hand_id: row.site_hand_id,
            played_at: row.played_at,
            game_format: row.game_format,
            variant: row.variant,
            limit_type: row.limit_type,
            currency: row.currency,
            currency_symbol: row.currency_symbol,
            minor_units: row.minor_units,
            small_blind: row.small_blind,
            big_blind: row.big_blind,
            ante: row.ante,
            max_seats: row.max_seats,
            table_name: row.table_name,
            hero_position: row.hero_position,
            hero_cards: row.hero_cards,
            board: row.board,
            hero_net: row.hero_net,
            hero_net_bb_milli: row.hero_net_bb_milli,
            all_in: row.all_in,
            ev_net: row.ev_net,
            ev_net_bb_milli: row.ev_net_bb_milli,
            ev_pending: row.ev_pending,
            pot_type: row.pot_type,
            total_pot: row.total_pot,
            showdown: row.showdown,
            has_note: row.has_note,
            tags: row.tags,
        }
    }
}

/// A page of the list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandPageDto {
    rows: Vec<HandRowDto>,
    next: Option<CursorDto>,
}

/// A chip's value and count.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountDto {
    value: String,
    count: u64,
}

impl From<FacetCount> for CountDto {
    fn from(facet: FacetCount) -> Self {
        Self {
            value: facet.value,
            count: facet.count,
        }
    }
}

/// A room's chip, with its name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteCountDto {
    value: String,
    count: u64,
    name: String,
}

/// A stake's chip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StakeDto {
    value: String,
    count: u64,
    currency: Option<String>,
    currency_symbol: Option<String>,
    minor_units: Option<i64>,
    small_blind: Option<i64>,
    big_blind: Option<i64>,
}

impl From<StakeFacet> for StakeDto {
    fn from(facet: StakeFacet) -> Self {
        Self {
            value: facet.value,
            count: facet.count,
            currency: facet.currency,
            currency_symbol: facet.currency_symbol,
            minor_units: facet.minor_units,
            small_blind: facet.small_blind,
            big_blind: facet.big_blind,
        }
    }
}

/// The counts beside the chips (`HandFacets`), the tags in use and the
/// hands with a note.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetsDto {
    total: u64,
    sites: Vec<SiteCountDto>,
    formats: Vec<CountDto>,
    variants: Vec<CountDto>,
    limits: Vec<CountDto>,
    sizes: Vec<CountDto>,
    stakes: Vec<StakeDto>,
    positions: Vec<CountDto>,
    pot_types: Vec<CountDto>,
    results: Vec<CountDto>,
    stacks: Vec<CountDto>,
    all_in: Vec<CountDto>,
    tags: Vec<CountDto>,
    noted: u64,
}

fn counts(list: Vec<FacetCount>) -> Vec<CountDto> {
    list.into_iter().map(CountDto::from).collect()
}

/// A hand's note and tags.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationsDto {
    note: Option<String>,
    tags: Vec<String>,
}

/// A saved filter.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFilterDto {
    id: i64,
    name: String,
    /// The filter as the window saved it (JSON).
    filter: String,
}

#[tauri::command]
pub async fn hands_page(
    store: State<'_, StoreState>,
    filter: FilterDto,
    after: Option<CursorDto>,
    limit: u32,
) -> Result<HandPageDto, String> {
    let after = after.map(|cursor| HandCursor {
        played_at: cursor.played_at,
        hand_key: cursor.hand_key,
    });
    let page = open(&store)?
        .reader()
        .hand_page(&filter.into(), after.as_ref(), limit)
        .map_err(text)?;
    Ok(HandPageDto {
        rows: page.rows.into_iter().map(HandRowDto::from).collect(),
        next: page.next.map(CursorDto::from),
    })
}

#[tauri::command]
pub async fn hands_facets(
    store: State<'_, StoreState>,
    filter: FilterDto,
) -> Result<FacetsDto, String> {
    let reader = open(&store)?.reader();
    let facets = reader.hand_facets(&filter.into()).map_err(text)?;
    Ok(FacetsDto {
        total: facets.total,
        sites: facets
            .sites
            .into_iter()
            .map(|facet| SiteCountDto {
                name: site_name(&facet.value),
                value: facet.value,
                count: facet.count,
            })
            .collect(),
        formats: counts(facets.formats),
        variants: counts(facets.variants),
        limits: counts(facets.limits),
        sizes: counts(facets.sizes),
        stakes: facets.stakes.into_iter().map(StakeDto::from).collect(),
        positions: counts(facets.positions),
        pot_types: counts(facets.pot_types),
        results: counts(facets.results),
        stacks: counts(facets.stacks),
        all_in: counts(facets.all_in),
        tags: counts(reader.hand_tags().map_err(text)?),
        noted: reader.noted_hands().map_err(text)?,
    })
}

/// The list rows of these hands, newest first (a hand opened by its key).
#[tauri::command]
pub async fn hands_by_key(
    store: State<'_, StoreState>,
    keys: Vec<String>,
) -> Result<Vec<HandRowDto>, String> {
    Ok(open(&store)?
        .reader()
        .hand_rows(&keys)
        .map_err(text)?
        .into_iter()
        .map(HandRowDto::from)
        .collect())
}

/// "Go to hand": hands whose room id starts with `query` (or whose key it
/// is), at most `limit`.
#[tauri::command]
pub async fn hands_find(
    store: State<'_, StoreState>,
    query: String,
    limit: u32,
) -> Result<Vec<HandRowDto>, String> {
    Ok(open(&store)?
        .reader()
        .find_hands(&query, limit)
        .map_err(text)?
        .into_iter()
        .map(HandRowDto::from)
        .collect())
}

/// A hand's canonical PHF as JSON text (the window parses it); `None` when
/// the store has no such hand.
#[tauri::command]
pub async fn hand_phf(
    store: State<'_, StoreState>,
    hand_key: String,
) -> Result<Option<String>, String> {
    open(&store)?.reader().hand_phf(&hand_key).map_err(text)
}

#[tauri::command]
pub async fn hand_annotations(
    store: State<'_, StoreState>,
    hand_key: String,
) -> Result<AnnotationsDto, String> {
    let annotations = open(&store)?
        .reader()
        .hand_annotations(&hand_key)
        .map_err(text)?;
    Ok(AnnotationsDto {
        note: annotations.note,
        tags: annotations.tags,
    })
}

/// Set a hand's note (an empty note removes it).
#[tauri::command]
pub async fn hand_set_note(
    store: State<'_, StoreState>,
    hand_key: String,
    note: String,
) -> Result<AnnotationsDto, String> {
    let store = open(&store)?;
    let key = hand_key.clone();
    store
        .writer()
        .and_then(|writer| {
            writer.write(move |tx| hand_list::set_note(tx, &key, &note, rail_store::time::now_ms()))
        })
        .map_err(text)?;
    annotations(store, &hand_key)
}

#[tauri::command]
pub async fn hand_add_tag(
    store: State<'_, StoreState>,
    hand_key: String,
    tag: String,
) -> Result<AnnotationsDto, String> {
    let store = open(&store)?;
    let key = hand_key.clone();
    store
        .writer()
        .and_then(|writer| {
            writer.write(move |tx| hand_list::add_tag(tx, &key, &tag, rail_store::time::now_ms()))
        })
        .map_err(text)?;
    annotations(store, &hand_key)
}

#[tauri::command]
pub async fn hand_remove_tag(
    store: State<'_, StoreState>,
    hand_key: String,
    tag: String,
) -> Result<AnnotationsDto, String> {
    let store = open(&store)?;
    let key = hand_key.clone();
    store
        .writer()
        .and_then(|writer| writer.write(move |tx| hand_list::remove_tag(tx, &key, &tag)))
        .map_err(text)?;
    annotations(store, &hand_key)
}

fn annotations(store: &rail_store::Store, hand_key: &str) -> Result<AnnotationsDto, String> {
    let annotations = store.reader().hand_annotations(hand_key).map_err(text)?;
    Ok(AnnotationsDto {
        note: annotations.note,
        tags: annotations.tags,
    })
}

fn saved(store: &rail_store::Store) -> Result<Vec<SavedFilterDto>, String> {
    Ok(store
        .reader()
        .saved_filters(SCREEN)
        .map_err(text)?
        .into_iter()
        .map(|saved| SavedFilterDto {
            id: saved.id,
            name: saved.name,
            filter: saved.filter,
        })
        .collect())
}

#[tauri::command]
pub async fn saved_filters(store: State<'_, StoreState>) -> Result<Vec<SavedFilterDto>, String> {
    saved(open(&store)?)
}

/// Save the filter under `name` (replacing one of that name); returns the
/// saved filters.
#[tauri::command]
pub async fn save_filter(
    store: State<'_, StoreState>,
    name: String,
    filter: String,
) -> Result<Vec<SavedFilterDto>, String> {
    // The window's JSON, checked to be a filter before it is kept.
    serde_json::from_str::<FilterDto>(&filter).map_err(|error| error.to_string())?;
    let store = open(&store)?;
    store
        .writer()
        .and_then(|writer| {
            writer.write(move |tx| {
                hand_list::save_filter(tx, SCREEN, &name, &filter, rail_store::time::now_ms())
            })
        })
        .map_err(text)?;
    saved(store)
}

#[tauri::command]
pub async fn delete_saved_filter(
    store: State<'_, StoreState>,
    id: i64,
) -> Result<Vec<SavedFilterDto>, String> {
    let store = open(&store)?;
    store
        .writer()
        .and_then(|writer| writer.write(move |tx| hand_list::delete_saved_filter(tx, id)))
        .map_err(text)?;
    saved(store)
}

#[cfg(test)]
mod tests {
    use super::FilterDto;
    use rail_store::HandFilter;

    /// The window's filter JSON: camelCase, every group optional; tags
    /// normalised, empty dates dropped.
    /// Rooms by their `sites.json` name; an unknown id is shown as is.
    #[test]
    fn site_names() {
        assert_eq!(super::site_name("pokerstars"), "PokerStars");
        assert_eq!(super::site_name(" GGPoker "), "GGPoker");
        assert_eq!(super::site_name("no-such-room"), "no-such-room");
    }

    #[test]
    fn a_filter_from_the_window() {
        let dto: FilterDto = serde_json::from_str(
            r#"{"positions":["BTN"],"potTypes":["3bet"],"allIn":true,
                "tags":[" bluff ","bluff",""],"from":"","to":"2026-01-01T00:00:00.000Z"}"#,
        )
        .expect("filter");
        let filter: HandFilter = dto.into();
        assert_eq!(filter.positions, ["BTN"]);
        assert_eq!(filter.pot_types, ["3bet"]);
        assert_eq!(filter.all_in, Some(true));
        assert_eq!(filter.tags, ["bluff"]);
        assert_eq!(filter.from, None);
        assert_eq!(filter.to.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        let empty: HandFilter = serde_json::from_str::<FilterDto>("{}")
            .expect("empty")
            .into();
        assert_eq!(empty, HandFilter::default());
        assert!(serde_json::from_str::<FilterDto>(r#"{"positions":"BTN"}"#).is_err());
    }
}

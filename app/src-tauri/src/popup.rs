//! The HUD popup (docs/RAIL-PLAN.md R3.8): a click on a seat's panel
//! opens a small window of the app's beside the panel, with the player's
//! statistics from the R2.4 definitions, their rows by position where the
//! room allows it, the hands you played together and your result against
//! them, and - where the room allows labelling players - the user's colour,
//! labels and note, editable, written by the app.
//!
//! - **The path.** The HUD's overlay turns a press and release without a
//!   drag into `TableEvent::PanelClicked`; the HUD's engine finds the
//!   player at that slot and sends `open_popup` over IPC
//!   (`HudMessage::OpenPopup`: the room, the store's site, the table, the
//!   player with their scope, the table's segment, the slot and the panel
//!   on the screen). The supervisor's callback ([`request`]) only hands it
//!   to the main thread, which opens the window ([`open`]). The window
//!   asks for what it shows ([`hud_popup`]): the app reads it, never the
//!   HUD (whose connection is read-only).
//! - **One window, reused.** A popup that is open is moved beside the new
//!   panel and told to read again ([`POPUP_CHANGED_EVENT`]); the same panel
//!   clicked again closes it. Closing destroys it (the next opens fresh -
//!   see focus below); so do Esc, its close button, the pointer leaving it
//!   after it came in (the window's script), it losing the keyboard after
//!   the user gave it the keyboard (`on_window_event`), and the tables
//!   closing (no table, no popup).
//! - **Focus.** It never takes the keyboard from the table when it opens:
//!   built hidden and unfocused (`focused(false)`), then shown - on Windows
//!   a window built unfocused is shown the first time with
//!   `SW_SHOWNOACTIVATE`, which is why a popup is destroyed rather than
//!   hidden (a second `show` would activate it). It is always on top, has
//!   no frame and no taskbar entry. The user's bet keys keep reaching the
//!   table while it is open; a click into it gives it the keyboard (to type
//!   a note), and then Esc or a click elsewhere closes it. Limits: an
//!   unfocused popup cannot see a click on the table (the overlay is
//!   click-through there), so it closes when the pointer leaves it, not on
//!   that click; macOS (R3.11 - R3.13) is not wired yet - a non-activating
//!   `NSPanel` would be the equivalent there.
//! - **What a room allows** ([`PopupRules`], from the shipped `sites.json`'s
//!   `hud.restrictions` - the same the HUD's renderer enforces): a room
//!   whose HUD is not allowed opens nothing. Statistics from the user's own
//!   hands only where the room says so (`ownHandsOnly`: every allowed room
//!   today), over the table's segment, coloured as the panel (at most
//!   [`POPUP_COLOUR_THRESHOLDS`], fewer where the room says so). Rows **by
//!   position only where the display may not switch with game state is not
//!   a rule** (`noGameStateSwitching`): PokerStars forbids "a display that
//!   changes with the game state other than the game format", and whether
//!   a table of every position in a popup is that is not clear - so it is
//!   not shown on PokerStars (nor on Winamax, read as conservatively);
//!   ACR shows it. **The user's words** (colour, labels and the note) only
//!   where the room allows labelling players (`noPlayerLabels`: not
//!   PokerStars - "rating, labelling or categorising players" -, not ACR -
//!   4.2.10 "Player labeling"): a note typed at the table is a label in all
//!   but name, so on those rooms the popup shows none of them, not even
//!   read-only, and offers the Players screen instead (off the table's
//!   overlay; the words are kept there as before). Winamax shows and edits
//!   all three, and its panels carry the tag and the note mark. Nothing
//!   about the hand in play, no advice, no ranges or equities: historical
//!   statistics only (guideline §7).
//! - **The table's design** (R3.9): `open_popup` names the design the
//!   table is drawn with; the popup shows its sections (the user's titles,
//!   else the group's), the user's colour bands and decimals, colouring by
//!   no more thresholds than the design and the room allow. Without one
//!   (an older HUD): every definition the HUD shows, by group, as before.
//!   The sections list shipped definitions only (a user's own statistic is
//!   on the panel, not in the popup yet).
//! - **Who.** A named opponent has it all. The hero's own panel opens their
//!   statistics only (no notes, no "together"). An opaque-id seat (scope
//!   not empty: its name is one session's token) has its statistics over
//!   that session only - no notes, no rows by name.

use std::sync::{Mutex, PoisonError};

use rail_config::model::HudRestrictions;
use rail_config::stats::{Group, HudPlace, Players, Unit, collapse_bands};
use rail_hud_ipc::protocol::{PlayerRef, ScreenRect};
use rail_stats::display::DisplayStat;
use rail_store::report::Units;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::commands::StoreState;
use crate::hands::site_name;
use crate::hud::OPEN_PLAYER_EVENT;
use crate::players::{NotesDto, SeenDto};
use crate::reports::{BREAKDOWN_COLUMNS, GroupDto, ShownDto, display, show_one, totals_row};

/// A popup window's label: this and a number (each open is a new window).
pub const POPUP_LABEL_PREFIX: &str = "hud-popup-";

/// Told to the popup window when it should read again (another panel).
pub const POPUP_CHANGED_EVENT: &str = "hud-popup-changed";

/// The popup's page: the app's own, on the popup's route.
pub const POPUP_ROUTE: &str = "index.html#/hud-popup";

/// The popup's size, logical pixels (scaled by the table's monitor).
pub const POPUP_SIZE: (u32, u32) = (380, 560);

/// Space between the panel and the popup, logical pixels.
const GAP: u32 = 6;

/// The popup colours as the default panel does: at most this many
/// thresholds (low, normal, high), fewer where the room says so.
pub const POPUP_COLOUR_THRESHOLDS: u32 = 2;

/// The panel clicked (`open_popup`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupTarget {
    pub window: u64,
    /// The `sites.json` room.
    pub site: String,
    /// The rollups' site.
    pub store_site: String,
    pub table: Option<String>,
    pub player: PlayerRef,
    pub segment: Option<i64>,
    pub slot: u32,
    pub anchor: ScreenRect,
    pub scale_permille: u32,
    /// (R3.9) The design the table is drawn with.
    #[serde(default)]
    pub design: Option<String>,
}

impl PopupTarget {
    /// The same panel of the same table (a second click closes it).
    fn same_panel(&self, other: &Self) -> bool {
        self.window == other.window && self.slot == other.slot
    }
}

/// The popup as app state: what it shows and which window shows it.
#[derive(Debug, Default)]
pub struct PopupState {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    target: Option<PopupTarget>,
    label: Option<String>,
    opened: u64,
}

impl PopupState {
    /// What the popup shows (`None`: closed).
    pub fn target(&self) -> Option<PopupTarget> {
        self.lock().target.clone()
    }

    /// The open popup window's label.
    pub fn label(&self) -> Option<String> {
        self.lock().label.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What a room's HUD rules let the popup show (see the module's header).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupRules {
    /// Statistics from the user's own hands only.
    pub own_hands_only: bool,
    /// Colour by at most this many thresholds.
    pub colour_thresholds: Option<u32>,
    /// Rows by position.
    pub by_position: bool,
    /// The user's words: the colour tag, the labels and the note.
    pub words: bool,
}

impl PopupRules {
    pub fn of(rules: &HudRestrictions) -> Self {
        let colour_thresholds = Some(match rules.max_colour_thresholds {
            Some(max) => max.min(POPUP_COLOUR_THRESHOLDS),
            None => POPUP_COLOUR_THRESHOLDS,
        });
        Self {
            own_hands_only: rules.own_hands_only,
            colour_thresholds,
            by_position: !rules.no_game_state_switching,
            words: !rules.no_player_labels,
        }
    }

    /// A room's rules, from the shipped `sites.json`; `None` where its HUD
    /// is not allowed (no popup at all).
    pub fn for_site(site: &str) -> Option<Self> {
        let config = crate::folders::sites().ok()?;
        let entry = config.site(site)?;
        if !entry.hud_permitted() {
            return None;
        }
        entry.hud.restrictions.as_ref().map(Self::of)
    }
}

/// Where a popup of `size` goes beside `anchor` (physical pixels): right of
/// the panel, else left of it, top-aligned with it; else below, else
/// above; always inside `area` (the monitor's work area) when known.
pub fn place(
    anchor: ScreenRect,
    size: (u32, u32),
    area: Option<ScreenRect>,
    gap: u32,
) -> (i32, i32) {
    let (w, h) = (i64::from(size.0), i64::from(size.1));
    let gap = i64::from(gap);
    let (ax, ay) = (i64::from(anchor.x), i64::from(anchor.y));
    let (aw, ah) = (i64::from(anchor.width), i64::from(anchor.height));
    let Some(area) = area else {
        return (clamp_i32(ax + aw + gap), clamp_i32(ay));
    };
    let (left, top) = (i64::from(area.x), i64::from(area.y));
    let (right, bottom) = (left + i64::from(area.width), top + i64::from(area.height));
    let fit_y = |y: i64| y.min(bottom - h).max(top);
    let fit_x = |x: i64| x.min(right - w).max(left);
    let (x, y) = if ax + aw + gap + w <= right {
        (ax + aw + gap, fit_y(ay))
    } else if ax - gap - w >= left {
        (ax - gap - w, fit_y(ay))
    } else if ay + ah + gap + h <= bottom {
        (fit_x(ax), ay + ah + gap)
    } else {
        (fit_x(ax), fit_y(ay - gap - h))
    };
    (clamp_i32(x), clamp_i32(y))
}

fn clamp_i32(value: i64) -> i32 {
    i32::try_from(value.clamp(i64::from(i32::MIN), i64::from(i32::MAX))).unwrap_or(0)
}

/// `value` logical pixels at `scale_permille`.
fn scaled(value: u32, scale_permille: u32) -> u32 {
    let scaled = u64::from(value) * u64::from(scale_permille.clamp(500, 4000)) / 1000;
    u32::try_from(scaled).unwrap_or(value)
}

/// The work area of the monitor that holds `point` (asked through the main
/// window, which always exists - hidden in the tray or not).
fn work_area<R: Runtime>(app: &AppHandle<R>, point: (i32, i32)) -> Option<ScreenRect> {
    app.get_webview_window(crate::MAIN_WINDOW)?
        .available_monitors()
        .ok()?
        .into_iter()
        .find(|monitor| {
            let (p, s) = (monitor.position(), monitor.size());
            let (x, y) = (i64::from(point.0), i64::from(point.1));
            x >= i64::from(p.x)
                && y >= i64::from(p.y)
                && x < i64::from(p.x) + i64::from(s.width)
                && y < i64::from(p.y) + i64::from(s.height)
        })
        .map(|monitor| {
            let area = monitor.work_area();
            ScreenRect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
}

/// What [`open`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// A new popup window (its label).
    New(String),
    /// The open popup moved to the new panel and was told to read again.
    Moved(String),
    /// The same panel again: the popup closed.
    Closed,
    /// The room's HUD is not allowed: nothing opened.
    Refused,
}

/// The supervisor's callback (any thread, never blocking): open the popup
/// on the main thread.
pub fn request<R: Runtime>(app: &AppHandle<R>, target: PopupTarget) {
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        if let Some(state) = handle.try_state::<PopupState>() {
            match open(&handle, &state, target) {
                Ok(opened) => log::debug!("hud popup: {opened:?}"),
                Err(error) => log::warn!("hud popup: {error}"),
            }
        }
    });
    if let Err(error) = result {
        log::debug!("hud popup: {error}");
    }
}

/// Open the popup for `target` beside its panel: a new window, or the open
/// one moved; the same panel again closes it.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    state: &PopupState,
    target: PopupTarget,
) -> Result<Opened, String> {
    let centre = (
        target
            .anchor
            .x
            .saturating_add(i32::try_from(target.anchor.width / 2).unwrap_or(0)),
        target
            .anchor
            .y
            .saturating_add(i32::try_from(target.anchor.height / 2).unwrap_or(0)),
    );
    let area = work_area(app, centre);
    open_in(app, state, target, area)
}

/// [`open`] within `area` (the work area of the panel's monitor, when
/// known).
fn open_in<R: Runtime>(
    app: &AppHandle<R>,
    state: &PopupState,
    target: PopupTarget,
    area: Option<ScreenRect>,
) -> Result<Opened, String> {
    if PopupRules::for_site(&target.site).is_none() {
        return Ok(Opened::Refused);
    }
    let size = (
        scaled(POPUP_SIZE.0, target.scale_permille),
        scaled(POPUP_SIZE.1, target.scale_permille),
    );
    let (x, y) = place(
        target.anchor,
        size,
        area,
        scaled(GAP, target.scale_permille),
    );
    let mut inner = state.lock();
    let open_window = inner
        .label
        .as_deref()
        .and_then(|label| app.get_webview_window(label));
    if let Some(window) = open_window {
        let label = window.label().to_owned();
        if inner
            .target
            .as_ref()
            .is_some_and(|shown| shown.same_panel(&target))
        {
            inner.target = None;
            inner.label = None;
            drop(inner);
            let _ = window.destroy();
            return Ok(Opened::Closed);
        }
        inner.target = Some(target);
        drop(inner);
        let _ = window.set_size(PhysicalSize::new(size.0, size.1));
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = app.emit_to(label.as_str(), POPUP_CHANGED_EVENT, ());
        return Ok(Opened::Moved(label));
    }
    inner.opened += 1;
    let label = format!("{POPUP_LABEL_PREFIX}{}", inner.opened);
    inner.target = Some(target);
    inner.label = Some(label.clone());
    drop(inner);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(POPUP_ROUTE.into()))
        .title("Rail")
        .visible(false)
        .focused(false)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .build()
        .map_err(|error| {
            let mut inner = state.lock();
            inner.target = None;
            inner.label = None;
            error.to_string()
        })?;
    let _ = window.set_size(PhysicalSize::new(size.0, size.1));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.show();
    Ok(Opened::New(label))
}

/// Close the popup (whichever is open).
pub fn close<R: Runtime>(app: &AppHandle<R>, state: &PopupState) {
    let label = {
        let mut inner = state.lock();
        inner.target = None;
        inner.label.take()
    };
    if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
        let _ = window.destroy();
    }
}

/// A popup window lost the keyboard (the user had given it the keyboard
/// and clicked elsewhere): it closes, if it is still the open one.
pub fn blurred<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(state) = app.try_state::<PopupState>()
        && state.label().as_deref() == Some(label)
    {
        close(app, &state);
    }
}

/// One definition's colour bands as the popup shows them.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BandDto {
    below: Option<f64>,
    tone: &'static str,
}

/// One statistic's legend: its thresholds in use.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegendDto {
    id: &'static str,
    bands: Vec<BandDto>,
}

/// What the popup shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupDto {
    /// The `sites.json` room and its name.
    site: String,
    site_name: String,
    /// The site the player's words are kept under (the store's).
    store_site: String,
    table: Option<String>,
    player: String,
    hero: bool,
    /// An opaque-id seat: one session's token, not a name.
    opaque: bool,
    rules: PopupRules,
    /// Hands their statistics count.
    hands: i64,
    /// The statistics shown, by definition id, in the definitions' order.
    ids: Vec<&'static str>,
    stats: Vec<ShownDto>,
    /// Each shown statistic's thresholds in use.
    legend: Vec<LegendDto>,
    /// Hands together and your result against them (a named opponent).
    together: Option<SeenDto>,
    /// The user's words (a named opponent, where the room allows labelling
    /// players).
    notes: Option<NotesDto>,
    /// [`BREAKDOWN_COLUMNS`] for `by_position`.
    columns: Vec<&'static str>,
    /// Their rows by position, where the room allows it.
    by_position: Option<Vec<GroupDto>>,
    /// (R3.9) The table's design's sections, in order; `None`: by group.
    sections: Option<Vec<SectionDto>>,
}

/// (R3.9) One section of the popup, as the design says.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionDto {
    group: Option<Group>,
    title: Option<String>,
    ids: Vec<&'static str>,
}

/// What the popup shows for `target`, read from the store.
pub fn build_popup(
    reader: &rail_store::Reader,
    target: &PopupTarget,
    rules: PopupRules,
) -> Result<PopupDto, String> {
    let text = |error: rail_store::Error| error.to_string();
    let display = display()?;
    let player = &target.player;
    let segments = target.segment.map(|segment| vec![segment]);
    let keys = [(player.name.as_str(), player.scope.as_str())];
    let totals = if rules.own_hands_only {
        reader.hud_own_totals(&target.store_site, &keys, segments.as_deref())
    } else {
        reader.hud_totals(&target.store_site, &keys, segments.as_deref())
    }
    .map_err(text)?
    .pop()
    .unwrap_or_default();
    let sums = totals.sums();
    // One segment is one kind of game; every segment of the site may mix
    // tournament chips with cash: no big blinds then. An opponent's money
    // is never shown.
    let units = Units {
        mixed_kind: target.segment.is_none(),
        ..Units::default()
    };
    let design = target
        .design
        .as_deref()
        .and_then(|id| crate::hud_editor::load_design(reader, id));
    // The design colours by at most its own number of thresholds, never more
    // than the room and the default panel allow.
    let max = match (
        rules.colour_thresholds,
        design.as_ref().and_then(|d| d.max_colour_thresholds),
    ) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    let for_anyone = |stat: &DisplayStat| {
        stat.def.players == Players::Any && stat.def.format.unit != Unit::Money
    };
    let (shown, sections): (Vec<&'static DisplayStat>, Option<Vec<SectionDto>>) = match &design {
        None => (
            display
                .stats
                .iter()
                .filter(|stat| for_anyone(stat) && stat.def.hud != HudPlace::None)
                .collect(),
            None,
        ),
        Some(design) => {
            let mut shown: Vec<&'static DisplayStat> = Vec::new();
            let mut sections = Vec::new();
            for section in &design.popup {
                let mut ids = Vec::new();
                for stat in section
                    .stats
                    .iter()
                    .filter_map(|id| display.get(id))
                    .filter(|stat| for_anyone(stat))
                {
                    if !shown.iter().any(|s| s.id() == stat.id()) {
                        shown.push(stat);
                    }
                    ids.push(stat.id());
                }
                if !ids.is_empty() {
                    sections.push(SectionDto {
                        group: section.group,
                        title: section.title.clone(),
                        ids,
                    });
                }
            }
            (shown, Some(sections))
        }
    };
    // The user's overrides (bands, decimals, sample) over the definitions.
    let as_designed: Vec<DisplayStat> = shown
        .iter()
        .map(|stat| {
            match design
                .as_ref()
                .and_then(|design| design.overrides.get(stat.id()))
            {
                Some(over) => {
                    stat.with_overrides(over.bands.as_deref(), over.decimals, over.min_sample)
                }
                None => (*stat).clone(),
            }
        })
        .collect();
    let ids = shown.iter().map(|stat| stat.id()).collect();
    let stats = as_designed
        .iter()
        .map(|stat| show_one(stat, &sums, Some(&units)).collapsed(max))
        .collect();
    let legend = shown
        .iter()
        .zip(&as_designed)
        .filter(|(_, stat)| !stat.def.bands.is_empty())
        .map(|(id, stat)| LegendDto {
            id: id.id(),
            bands: collapse_bands(&stat.def.bands, max)
                .into_iter()
                .map(|band| BandDto {
                    below: band.below,
                    tone: band.tone.as_str(),
                })
                .collect(),
        })
        .collect();

    let opaque = !player.scope.is_empty();
    let opponent = !player.hero && !opaque;
    let seen = if opponent {
        reader
            .player_profile(&target.store_site, &player.name)
            .map_err(text)?
            .seen
    } else {
        None
    };
    let notes = if seen.is_some() && rules.words {
        Some(NotesDto::from(
            reader
                .player_notes(&target.store_site, &player.name)
                .map_err(text)?,
        ))
    } else {
        None
    };
    let by_position = if seen.is_some() && rules.by_position {
        let positions = if rules.own_hands_only {
            reader.player_own_positions(&target.store_site, &player.name, segments.as_deref())
        } else {
            reader.player_positions(&target.store_site, &player.name, segments.as_deref())
        }
        .map_err(text)?;
        Some(
            positions
                .positions
                .iter()
                .map(|(position, totals)| {
                    totals_row(position.clone(), None, totals, display, &units).collapsed(max)
                })
                .collect(),
        )
    } else {
        None
    };
    Ok(PopupDto {
        site: target.site.clone(),
        site_name: site_name(&target.site),
        store_site: target.store_site.clone(),
        table: target.table.clone(),
        player: player.name.clone(),
        hero: player.hero,
        opaque,
        rules,
        hands: totals.hands(),
        ids,
        stats,
        legend,
        together: seen.as_ref().map(SeenDto::from),
        notes,
        columns: BREAKDOWN_COLUMNS.to_vec(),
        by_position,
        sections,
    })
}

/// What the open popup shows (`null`: none is open).
#[tauri::command]
pub async fn hud_popup(
    popup: State<'_, PopupState>,
    store: State<'_, StoreState>,
) -> Result<Option<PopupDto>, String> {
    let Some(target) = popup.target() else {
        return Ok(None);
    };
    let Some(rules) = PopupRules::for_site(&target.site) else {
        return Ok(None);
    };
    let store = store.store.as_ref().ok_or("the store is not open")?;
    build_popup(store.reader(), &target, rules).map(Some)
}

/// Close the popup (Esc, its close button, the pointer leaving it).
#[tauri::command]
pub async fn hud_popup_close(app: AppHandle, popup: State<'_, PopupState>) -> Result<(), String> {
    close(&app, &popup);
    Ok(())
}

/// "Open in Rail": the main window on the player's profile; the popup
/// closes.
#[tauri::command]
pub async fn hud_popup_open_in_app(
    app: AppHandle,
    popup: State<'_, PopupState>,
) -> Result<(), String> {
    let Some(target) = popup.target() else {
        return Ok(());
    };
    close(&app, &popup);
    crate::show_main_window(&app);
    app.emit(
        OPEN_PLAYER_EVENT,
        crate::hud::OpenPlayer::new(target.store_site, target.player),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// Beside the panel - right, else left - top-aligned and inside the
    /// work area; below or above when neither side has room; right of it
    /// when the monitor is not known.
    #[test]
    fn the_popup_goes_beside_its_panel() {
        let area = Some(rect(0, 0, 1920, 1040));
        let panel = rect(400, 300, 90, 40);
        assert_eq!(place(panel, (380, 560), area, 6), (496, 300));
        // Near the right edge: to the left.
        assert_eq!(
            place(rect(1700, 300, 90, 40), (380, 560), area, 6),
            (1314, 300)
        );
        // Near the bottom: pulled up into the work area.
        assert_eq!(
            place(rect(400, 900, 90, 40), (380, 560), area, 6),
            (496, 480)
        );
        // A narrow area: below the panel, then above it.
        let narrow = Some(rect(0, 0, 400, 1040));
        assert_eq!(
            place(rect(10, 100, 90, 40), (380, 560), narrow, 6),
            (10, 146)
        );
        assert_eq!(
            place(rect(10, 900, 90, 40), (380, 560), narrow, 6),
            (10, 334)
        );
        // A second monitor left of the first (negative coordinates).
        let left = Some(rect(-1920, 0, 1920, 1080));
        assert_eq!(
            place(rect(-300, 50, 90, 40), (380, 560), left, 6),
            (-686, 50)
        );
        assert_eq!(place(panel, (380, 560), None, 6), (496, 300));
        assert_eq!(scaled(380, 1500), 570);
        assert_eq!(scaled(380, 0), 190);
    }

    /// The rooms' rules as the popup reads them: own hands everywhere, two
    /// thresholds; by position only on ACR (PokerStars forbids switching
    /// with game state, Winamax read as conservatively); the user's words
    /// (colour, labels, note) only on Winamax; nothing for a room whose HUD
    /// is not allowed.
    #[test]
    fn rules_per_room() {
        let stars = PopupRules::for_site("pokerstars").expect("allowed");
        let acr = PopupRules::for_site("acr").expect("allowed");
        let winamax = PopupRules::for_site("winamax").expect("allowed");
        for rules in [stars, acr, winamax] {
            assert!(rules.own_hands_only);
            assert_eq!(rules.colour_thresholds, Some(2));
        }
        assert_eq!(
            (stars.by_position, acr.by_position, winamax.by_position),
            (false, true, false)
        );
        assert_eq!(
            (stars.words, acr.words, winamax.words),
            (false, false, true)
        );
        for site in ["ggpoker", "888poker", "standard", "no-such-room"] {
            assert_eq!(PopupRules::for_site(site), None, "{site}");
        }
        let one = PopupRules::of(&HudRestrictions {
            max_colour_thresholds: Some(1),
            ..HudRestrictions::NONE
        });
        assert_eq!(one.colour_thresholds, Some(1));
        let open = PopupRules::of(&HudRestrictions::NONE);
        assert!(open.by_position && open.words && !open.own_hands_only);
    }

    fn target(site: &str, store_site: &str, player: PlayerRef, slot: u32) -> PopupTarget {
        PopupTarget {
            window: 7,
            site: site.into(),
            store_site: store_site.into(),
            table: Some("Made-up table".into()),
            player,
            segment: None,
            slot,
            anchor: rect(400, 300, 90, 40),
            scale_permille: 1000,
            design: None,
        }
    }

    /// What the popup shows over a store (a fixture cash table, the hero in
    /// every hand), by the rules of each allowed room: the statistics of
    /// the HUD's definitions for any player (not the hero's all-in EV, no
    /// money), coloured by two thresholds at most, each with its legend;
    /// rows by position only by ACR's rules; the user's words only by
    /// Winamax's (none at all, not even the note, by PokerStars' or ACR's);
    /// the hero's own popup has neither words nor "together"; a seat of an
    /// opaque-id room no words at all.
    #[test]
    fn the_popup_over_a_store() {
        let dir = std::env::temp_dir().join(format!("rail-app-popup-{}", std::process::id()));
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
        let list = store
            .reader()
            .player_list(&rail_store::PlayerQuery {
                limit: 1,
                ..rail_store::PlayerQuery::default()
            })
            .expect("list");
        let top = list.rows.first().expect("an opponent").clone();
        let (site, name) = (top.site.clone(), top.player.clone());
        let (s, n) = (site.clone(), name.clone());
        writer
            .write(move |tx| {
                rail_store::players::set_colour(tx, &s, &n, Some("blue"), 1)?;
                rail_store::players::add_label(tx, &s, &n, "made-up", 1)?;
                rail_store::players::set_note(tx, &s, &n, "a made-up note", 1)
            })
            .expect("words");
        let reader = store.reader();
        let villain = target("pokerstars", &site, PlayerRef::named(&name), 2);
        let definitions = display().expect("display");

        for room in ["pokerstars", "acr", "winamax"] {
            let rules = PopupRules::for_site(room).expect("allowed");
            let popup = build_popup(reader, &villain, rules).expect("popup");
            assert!(popup.hands > 0, "{room}");
            assert_eq!(popup.ids.len(), popup.stats.len());
            for id in &popup.ids {
                let def = &definitions.get(id).expect("a definition").def;
                assert_eq!(def.players, Players::Any, "{id}");
                assert_ne!(def.format.unit, Unit::Money, "{id}");
                assert_ne!(def.hud, HudPlace::None, "{id}");
            }
            assert!(popup.ids.contains(&"vpip") && popup.ids.contains(&"wtsd"));
            assert!(!popup.ids.contains(&"allin_ev_bb_per_100"));
            for shown in &popup.stats {
                assert!(
                    matches!(shown.tone(), None | Some("low" | "normal" | "high")),
                    "{room}: {:?}",
                    shown.tone()
                );
            }
            assert!(
                popup
                    .legend
                    .iter()
                    .all(|entry| entry.bands.len() <= 3 && !entry.bands.is_empty())
            );
            let vpip = popup
                .legend
                .iter()
                .find(|entry| entry.id == "vpip")
                .expect("vpip's legend");
            assert_eq!(
                vpip.bands,
                [
                    BandDto {
                        below: Some(22.0),
                        tone: "low"
                    },
                    BandDto {
                        below: Some(30.0),
                        tone: "normal"
                    },
                    BandDto {
                        below: None,
                        tone: "high"
                    },
                ]
            );
            assert!(popup.together.is_some(), "{room}: hands together");
            match (room, popup.notes.as_ref()) {
                ("winamax", Some(notes)) => {
                    assert_eq!(notes.note(), "a made-up note");
                    assert_eq!(notes.words(), (Some("blue"), &["made-up".to_owned()][..]));
                }
                ("winamax", None) => panic!("winamax: the user's words"),
                (_, notes) => assert!(notes.is_none(), "{room}: no words at all"),
            }
            assert_eq!(popup.by_position.is_some(), room == "acr", "{room}");
        }
        // By ACR's rules: the rows by position add up to the popup's hands
        // (own hands: the hero is in every hand of the fixture).
        let acr = build_popup(reader, &villain, PopupRules::for_site("acr").expect("acr"))
            .expect("popup");
        let rows: i64 = acr
            .by_position
            .as_ref()
            .expect("rows")
            .iter()
            .map(GroupDto::hands)
            .sum();
        assert_eq!(rows, acr.hands);

        // The hero's own panel: statistics only.
        let hero_name = store
            .reader()
            .newest_hands_of_file(&file, 1)
            .expect("newest")
            .pop()
            .and_then(|hand| hand.players.into_iter().find(|p| p.hero))
            .expect("a hero")
            .player;
        let hero = PlayerRef {
            hero: true,
            ..PlayerRef::named(hero_name)
        };
        let popup = build_popup(
            reader,
            &target("winamax", &site, hero, 0),
            PopupRules::for_site("winamax").expect("allowed"),
        )
        .expect("popup");
        assert!(popup.hero && popup.hands > 0);
        assert!(popup.notes.is_none() && popup.together.is_none() && popup.by_position.is_none());
        // An opaque-id seat: one session's statistics, no words.
        let opaque = PlayerRef {
            scope: "T@2026-10-15".into(),
            ..PlayerRef::named("a1b2c3")
        };
        let popup = build_popup(
            reader,
            &target("winamax", &site, opaque, 3),
            PopupRules::for_site("winamax").expect("allowed"),
        )
        .expect("popup");
        assert!(popup.opaque && popup.notes.is_none() && popup.by_position.is_none());
        assert_eq!(popup.hands, 0);
        assert!(popup.sections.is_none(), "no design named: by group");

        // (R3.9) The table's design: its sections in its order, the user's
        // bands and decimals; a hero-only or money statistic never; one
        // threshold where the design says one.
        let mut design = rail_hud::design::Presets::shipped()
            .get("mtt")
            .expect("mtt")
            .design
            .clone();
        design.popup = vec![
            rail_hud::design::PopupSection {
                group: None,
                title: Some("Mine".into()),
                stats: vec![
                    "wtsd".into(),
                    "vpip".into(),
                    "allin_ev_bb_per_100".into(),
                    "rake_per_100".into(),
                ],
            },
            rail_hud::design::PopupSection {
                group: Some(Group::Postflop),
                title: None,
                stats: vec!["cbet_flop".into(), "vpip".into()],
            },
        ];
        design.max_colour_thresholds = Some(1);
        design.overrides.insert(
            "vpip".into(),
            rail_hud::design::StatOverride {
                bands: Some(vec![
                    rail_config::stats::Band {
                        below: Some(50.0),
                        tone: rail_config::stats::Tone::Low,
                    },
                    rail_config::stats::Band {
                        below: None,
                        tone: rail_config::stats::Tone::High,
                    },
                ]),
                decimals: Some(2),
                min_sample: None,
            },
        );
        writer
            .save_hud_layout("d-popup", &design.to_json())
            .expect("design");
        let designed = PopupTarget {
            design: Some("d-popup".into()),
            ..villain.clone()
        };
        let popup = build_popup(reader, &designed, PopupRules::for_site("acr").expect("acr"))
            .expect("popup");
        let sections = popup.sections.as_ref().expect("the design's sections");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].title.as_deref(), Some("Mine"));
        assert_eq!(sections[0].ids, ["wtsd", "vpip"]);
        assert_eq!(sections[1].ids, ["cbet_flop", "vpip"]);
        assert_eq!(popup.ids, ["wtsd", "vpip", "cbet_flop"]);
        let vpip = popup
            .legend
            .iter()
            .find(|entry| entry.id == "vpip")
            .expect("vpip's legend");
        assert_eq!(
            vpip.bands,
            [
                BandDto {
                    below: Some(50.0),
                    tone: "low"
                },
                BandDto {
                    below: None,
                    tone: "normal"
                },
            ],
            "the user's bands, at one threshold"
        );
        drop(writer);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The window (Tauri's mock runtime): a click opens a popup window
    /// beside the panel; another panel moves it (one window); the same
    /// panel again closes it; a room whose HUD is not allowed opens none;
    /// the next open is a new window (never re-shown: see focus).
    #[test]
    fn one_popup_window_opened_moved_and_closed() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app");
        eprintln!("step ok: the mock app");
        let handle = app.handle();
        handle.manage(PopupState::default());
        let state = handle.state::<PopupState>();
        let state: &PopupState = &state;
        let first = target("pokerstars", "pokerstars", PlayerRef::named("V1").at(2), 1);
        assert_eq!(
            open_in(handle, state, first.clone(), None).expect("open"),
            Opened::New("hud-popup-1".into())
        );
        assert!(handle.get_webview_window("hud-popup-1").is_some());
        assert_eq!(state.target(), Some(first.clone()));
        eprintln!("step ok: a popup window opened");
        let second = target("pokerstars", "pokerstars", PlayerRef::named("V2").at(3), 2);
        assert_eq!(
            open_in(handle, state, second.clone(), None).expect("open"),
            Opened::Moved("hud-popup-1".into())
        );
        assert_eq!(state.target(), Some(second.clone()));
        eprintln!("step ok: moved to another panel");
        assert_eq!(
            open_in(handle, state, second, None).expect("open"),
            Opened::Closed
        );
        eprintln!("step ok: closed by the same panel");
        // (The mock runtime drops the window when its event loop runs; the
        // state forgets it at once.)
        assert_eq!((state.target(), state.label()), (None, None));
        let refused = target("ggpoker", "ggpoker", PlayerRef::named("V").at(1), 0);
        assert_eq!(
            open_in(handle, state, refused, None).expect("open"),
            Opened::Refused
        );
        assert_eq!(state.label(), None);
        assert_eq!(
            open_in(handle, state, first, None).expect("open"),
            Opened::New("hud-popup-2".into())
        );
        blurred(handle, "hud-popup-1");
        assert!(state.label().is_some(), "not the open one");
        blurred(handle, "hud-popup-2");
        assert_eq!(state.target(), None);
        eprintln!("step ok: refused, opened again, closed on blur");
    }
}

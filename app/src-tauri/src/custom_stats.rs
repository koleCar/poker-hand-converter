//! The user's own statistics (docs/RAIL-PLAN.md R2.10; guideline §5
//! "Custom statistike"): thin commands over `rail_stats::custom` (the
//! language, validation, compilation) and `rail_store::custom` (the saved
//! definitions, the background counts, their sums).
//!
//! - `custom_stats_list()`: the saved statistics, each with its value over
//!   every hand of the hero (as far as the background pass has counted) and
//!   the pass's progress; the fields of the predicate language for the
//!   editor's reference.
//! - `custom_stat_check(draft, replacing)`: what the editor calls as the
//!   user types - the problems, each with the byte span to underline, and a
//!   **preview**: a statistic with a counter is counted on the hero's last
//!   [`PREVIEW_HANDS`] hands (their decision events kept in memory for
//!   [`PREVIEW_TTL`], so a keystroke costs microseconds), one over the
//!   existing counters only is shown over every hand at once.
//! - `custom_stat_save` / `custom_stat_delete`: through the store's writer;
//!   the pass is woken and counts a new or changed counter over every stored
//!   hand in the background.
//!
//! The custom statistics also go into `stat_definitions` and the Reports
//! summary ([`shown_for_report`]), after the shipped ones.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use rail_config::stats::predicate::FieldKind;
use rail_config::stats::{StatDef, Unit};
use rail_stats::custom::{CustomDef, CustomProblem, CustomSet, CustomStat, FIELDS, custom_sums};
use rail_stats::display::Sums;
use rail_stats::events::{HandEvents, hand_events};
use rail_store::report::{ReportFilter, Units};
use rail_store::{HeroFilter, HeroSum};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::StoreState;
use crate::reports::{ShownDto, display, show_one};
use crate::stats::StatsState;

/// The hero hands a counter is previewed on while the user types.
pub const PREVIEW_HANDS: u32 = 5000;

/// How long the preview's hands are kept before they are read again (new
/// hands arrive while the user plays).
pub const PREVIEW_TTL: Duration = Duration::from_secs(60);

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

/// The shipped definitions' ids: a user's statistic may not take one.
fn shipped_ids() -> Result<Vec<&'static str>, String> {
    Ok(display()?.stats.iter().map(|stat| stat.id()).collect())
}

/// The saved statistics compiled, their rows, and those this build cannot
/// compile with why.
type Saved = (
    CustomSet,
    Vec<rail_store::CustomStatRow>,
    Vec<(String, Vec<CustomProblem>)>,
);

/// The saved statistics, compiled, and those this build cannot compile.
pub(crate) fn custom_set(reader: &rail_store::Reader) -> Result<Saved, String> {
    let rows = reader.custom_stats().map_err(text)?;
    let defs: Vec<CustomDef> = rows.iter().map(|row| row.def.clone()).collect();
    let (set, refused) = CustomSet::compile(&defs);
    Ok((set, rows, refused))
}

/// A statistic's value over `base` (the sums of the coded counters) and
/// `counts` (each custom statistic's made and opportunities).
fn show(
    stat: &CustomStat,
    base: &Sums,
    counts: impl Fn(&str) -> Option<(i64, i64)>,
    units: Option<&Units>,
) -> ShownDto {
    let sums = custom_sums(&stat.names, base, counts);
    show_one(&stat.display, &sums, units)
}

/// The custom statistics over a report's filter, in the user's order: their
/// ids and values. The hero's coded sums `base` are the report's.
pub(crate) fn shown_for_report(
    reader: &rail_store::Reader,
    filter: &HeroFilter,
    base: &Sums,
    units: &Units,
) -> Result<Vec<(String, ShownDto)>, String> {
    let (set, rows, _) = custom_set(reader)?;
    if set.stats.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = rows
        .iter()
        .filter(|row| row.def.predicate.is_some())
        .map(|row| row.id)
        .collect();
    let totals = reader.custom_hero_totals(filter, &ids).map_err(text)?;
    let counts = |key: &str| {
        let row = rows.iter().find(|row| row.def.def.id == key)?;
        row.def.predicate.as_ref()?;
        let sum = totals.get(&row.id).copied().unwrap_or_default();
        Some((sum.made, sum.opp))
    };
    Ok(set
        .stats
        .iter()
        .map(|stat| {
            (
                stat.def.def.id.clone(),
                show(stat, base, counts, Some(units)),
            )
        })
        .collect())
}

/// Every saved statistic that compiles, for `stat_definitions`.
pub(crate) fn definitions(reader: &rail_store::Reader) -> Result<Vec<StatDef>, String> {
    let (set, _, _) = custom_set(reader)?;
    Ok(set.stats.into_iter().map(|stat| stat.def.def).collect())
}

/* ------------------------------------------------------------- the DTOs - */

/// One field of the predicate language.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDto {
    name: &'static str,
    /// `bool`, `number`, `choice`.
    kind: &'static str,
    choices: Vec<&'static str>,
}

fn fields() -> Vec<FieldDto> {
    FIELDS
        .iter()
        .map(|field| {
            let (kind, choices) = match field.kind {
                FieldKind::Bool => ("bool", Vec::new()),
                FieldKind::Number => ("number", Vec::new()),
                FieldKind::Choice(words) => ("choice", words.to_vec()),
            };
            FieldDto {
                name: field.name,
                kind,
                choices,
            }
        })
        .collect()
}

/// A saved statistic.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomStatDto {
    definition: StatDef,
    predicate: Option<String>,
    /// Why this build does not show it (a field it reads no longer exists);
    /// empty when it is fine.
    problems: Vec<CustomProblem>,
    /// Hands the pass has still to count, of the hands stored (`None`: no
    /// counter).
    remaining: Option<u64>,
    total: Option<u64>,
    /// Over every hero hand counted so far.
    shown: Option<ShownDto>,
}

/// What the editor lists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomListDto {
    stats: Vec<CustomStatDto>,
    fields: Vec<FieldDto>,
    /// The shipped definitions' ids (taken).
    shipped: Vec<&'static str>,
    preview_hands: u32,
}

/// The editor's preview of a draft.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDto {
    shown: ShownDto,
    /// The draft's own counts over the hands previewed (a counter only).
    made: Option<i64>,
    opp: Option<i64>,
    /// The hero hands it is over.
    hands: u64,
    /// `true`: the last [`PREVIEW_HANDS`] hands; `false`: every hand.
    sample: bool,
}

/// `custom_stat_check`'s answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDto {
    problems: Vec<CustomProblem>,
    preview: Option<PreviewDto>,
}

/// `custom_stat_delete`'s answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDto {
    deleted: bool,
    /// The statistic whose formula reads this one's counters (nothing
    /// deleted).
    read_by: Option<String>,
    list: CustomListDto,
}

/// `custom_stat_save`'s answer: the problems (nothing saved), or the list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDto {
    problems: Vec<CustomProblem>,
    list: Option<CustomListDto>,
}

/// A draft from the editor: the definition and its predicate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDto {
    definition: StatDef,
    predicate: Option<String>,
}

impl DraftDto {
    fn into_def(self) -> CustomDef {
        CustomDef {
            def: self.definition,
            predicate: self
                .predicate
                .filter(|predicate| !predicate.trim().is_empty()),
        }
    }
}

/* ----------------------------------------------------------- the preview - */

/// The hero's most recent hands, as the preview counts them: the hero
/// seat's events, and the coded counters' sums over the same hands
/// (`aggregate`'s defaults: bomb pots out, EV-cashout money out).
#[derive(Debug)]
struct Sample {
    at: Instant,
    hands: Vec<HandEvents>,
    base: Sums,
}

/// The preview's hands, kept between keystrokes.
#[derive(Debug, Default)]
pub struct CustomState {
    sample: Mutex<Option<Sample>>,
}

fn read_sample(reader: &rail_store::Reader) -> Result<Sample, String> {
    let hands = reader.recent_hero_hands(PREVIEW_HANDS).map_err(text)?;
    let mut base = Sums::default();
    let mut kept = Vec::with_capacity(hands.len());
    for hand in &hands {
        let rows = rail_stats::rows_for(hand);
        let Some(hero) = rows.iter().find(|row| row.seat.is_hero) else {
            continue;
        };
        if hero.hand.is_bomb_pot {
            continue;
        }
        base.add_row(hero, !hero.hand.has_cashout);
        let mut events = hand_events(hand);
        let seat = hero.seat.seat;
        if let Some(index) = events.seats.iter().position(|s| s.seat == seat) {
            let mine = events.seats.swap_remove(index);
            events.seats = vec![mine];
            kept.push(events);
        }
    }
    Ok(Sample {
        at: Instant::now(),
        hands: kept,
        base,
    })
}

fn preview(
    state: &CustomState,
    reader: &rail_store::Reader,
    set: &CustomSet,
    stat: &CustomStat,
) -> Result<PreviewDto, String> {
    if !stat.reads_custom() {
        // Over the coded counters only: every hand at once.
        let totals = reader.hero_totals(&HeroFilter::default()).map_err(text)?;
        let sum = HeroSum::of(&totals);
        let units = reader
            .report_graph(&ReportFilter::default(), 1)
            .map_err(text)?
            .units
            .clone();
        return Ok(PreviewDto {
            shown: show(stat, &sum.sums(), |_| None, Some(&units)),
            made: None,
            opp: None,
            hands: u64::try_from(sum.totals.hands()).unwrap_or(0),
            sample: false,
        });
    }
    let mut cache = state.sample.lock().unwrap_or_else(PoisonError::into_inner);
    let stale = cache
        .as_ref()
        .is_none_or(|sample| sample.at.elapsed() > PREVIEW_TTL);
    if stale {
        *cache = Some(read_sample(reader)?);
    }
    let Some(sample) = cache.as_ref() else {
        return Err("no sample".to_owned());
    };
    // Every counter the draft's formulas read, counted on the sample: its
    // own and other saved statistics'.
    let count = |key: &str| -> Option<(i64, i64)> {
        let counter = if key == stat.def.def.id {
            stat.counter.as_ref()?
        } else {
            set.get(key)?.counter.as_ref()?
        };
        let (mut made, mut opp) = (0_i64, 0_i64);
        for hand in &sample.hands {
            for seat in &hand.seats {
                let counts = counter.count(hand, seat);
                made += i64::from(counts.made);
                opp += i64::from(counts.opp);
            }
        }
        Some((made, opp))
    };
    let own = stat.counter.as_ref().and_then(|_| count(&stat.def.def.id));
    let sums = custom_sums(&stat.names, &sample.base, |key| {
        if key == stat.def.def.id {
            own
        } else {
            count(key)
        }
    });
    // Money over the sample has no known currency: no text for it.
    let shown = if stat.display.def.format.unit == Unit::Money {
        show_one(&stat.display, &sums, None).withheld()
    } else {
        show_one(&stat.display, &sums, None)
    };
    Ok(PreviewDto {
        shown,
        made: own.map(|(made, _)| made),
        opp: own.map(|(_, opp)| opp),
        hands: u64::try_from(sample.hands.len()).unwrap_or(0),
        sample: true,
    })
}

/* --------------------------------------------------------------- lists - */

fn build_list(reader: &rail_store::Reader) -> Result<CustomListDto, String> {
    let (set, rows, refused) = custom_set(reader)?;
    let progress = reader.custom_progress().map_err(text)?;
    let ids: Vec<i64> = rows
        .iter()
        .filter(|row| row.def.predicate.is_some())
        .map(|row| row.id)
        .collect();
    let all = HeroFilter::default();
    let totals = reader.custom_hero_totals(&all, &ids).map_err(text)?;
    let hero = reader.hero_totals(&all).map_err(text)?;
    let base = HeroSum::of(&hero).sums();
    let units = reader
        .report_graph(&ReportFilter::default(), 1)
        .map_err(text)?
        .units
        .clone();
    let counts = |key: &str| {
        let row = rows.iter().find(|row| row.def.def.id == key)?;
        row.def.predicate.as_ref()?;
        let sum = totals.get(&row.id).copied().unwrap_or_default();
        Some((sum.made, sum.opp))
    };
    let stats = rows
        .iter()
        .map(|row| {
            let id = &row.def.def.id;
            let compiled = set.get(id);
            let progress = progress.iter().find(|p| p.id == row.id);
            CustomStatDto {
                definition: compiled.map_or_else(|| row.def.def.clone(), |s| s.def.def.clone()),
                predicate: row.def.predicate.clone(),
                problems: refused
                    .iter()
                    .find(|(key, _)| key == id)
                    .map(|(_, problems)| problems.clone())
                    .unwrap_or_default(),
                remaining: progress.map(|p| p.remaining),
                total: progress.map(|p| p.total),
                shown: compiled.map(|stat| show(stat, &base, counts, Some(&units))),
            }
        })
        .collect();
    Ok(CustomListDto {
        stats,
        fields: fields(),
        shipped: shipped_ids()?,
        preview_hands: PREVIEW_HANDS,
    })
}

/// Check a draft and preview it (see the module header).
pub fn check_draft(
    state: &CustomState,
    reader: &rail_store::Reader,
    draft: CustomDef,
    replacing: Option<&str>,
) -> Result<CheckDto, String> {
    let (set, _, _) = custom_set(reader)?;
    match set.validate(&draft, replacing, &shipped_ids()?) {
        Err(problems) => Ok(CheckDto {
            problems,
            preview: None,
        }),
        Ok(stat) => Ok(CheckDto {
            problems: Vec::new(),
            preview: Some(preview(state, reader, &set, &stat)?),
        }),
    }
}

/* --------------------------------------------------------- the commands - */

/// The saved statistics, the language's fields.
#[tauri::command]
pub async fn custom_stats_list(store: State<'_, StoreState>) -> Result<CustomListDto, String> {
    build_list(open(&store)?.reader())
}

/// Validate a draft and preview its value on the hero's hands.
#[tauri::command]
pub async fn custom_stat_check(
    store: State<'_, StoreState>,
    state: State<'_, CustomState>,
    draft: DraftDto,
    replacing: Option<String>,
) -> Result<CheckDto, String> {
    check_draft(
        &state,
        open(&store)?.reader(),
        draft.into_def(),
        replacing.as_deref(),
    )
}

/// Save a draft (new, or replacing the statistic saved as `replacing`); the
/// background pass counts a new or changed counter.
#[tauri::command]
pub async fn custom_stat_save(
    store: State<'_, StoreState>,
    stats: State<'_, StatsState>,
    draft: DraftDto,
    replacing: Option<String>,
) -> Result<SaveDto, String> {
    let store = open(&store)?;
    let reader = store.reader();
    let (set, _, _) = custom_set(reader)?;
    let draft = draft.into_def();
    let stat = match set.validate(&draft, replacing.as_deref(), &shipped_ids()?) {
        Ok(stat) => stat,
        Err(problems) => {
            return Ok(SaveDto {
                problems,
                list: None,
            });
        }
    };
    // What validation settled (the hero-only flag) is what is stored.
    let def = stat.def;
    store
        .writer()
        .and_then(|writer| {
            writer.write(move |tx| {
                rail_store::custom::save_custom_stat(
                    tx,
                    replacing.as_deref(),
                    &def,
                    rail_store::time::now_ms(),
                )
            })
        })
        .map_err(text)?;
    stats.wake();
    Ok(SaveDto {
        problems: Vec::new(),
        list: Some(build_list(reader)?),
    })
}

/// Delete a statistic and its counts, unless another one's formula reads
/// its counters.
#[tauri::command]
pub async fn custom_stat_delete(
    store: State<'_, StoreState>,
    id: String,
) -> Result<DeleteDto, String> {
    let store = open(&store)?;
    let reader = store.reader();
    let (set, _, _) = custom_set(reader)?;
    if let Some(user) = set.reader_of(&id) {
        return Ok(DeleteDto {
            deleted: false,
            read_by: Some(user),
            list: build_list(reader)?,
        });
    }
    let deleted = store
        .writer()
        .and_then(|writer| writer.write(move |tx| rail_store::custom::delete_custom_stat(tx, &id)))
        .map_err(text)?;
    Ok(DeleteDto {
        deleted,
        read_by: None,
        list: build_list(reader)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, Text};

    fn words(value: &str) -> Text {
        Text {
            en: value.to_owned(),
            hr: value.to_owned(),
        }
    }

    fn draft(id: &str, predicate: Option<&str>, formula: &str) -> CustomDef {
        CustomDef {
            def: StatDef {
                id: id.to_owned(),
                group: Group::Postflop,
                players: Players::Any,
                label: words("CB3"),
                name: words("Cbet in 3-bet pots"),
                description: words("Made up."),
                formula: formula.to_owned(),
                format: Format {
                    unit: Unit::Percent,
                    decimals: 1,
                },
                sample: SampleDef { of: None, min: 20 },
                bands: Vec::new(),
                hud: HudPlace::None,
            },
            predicate: predicate.map(str::to_owned),
        }
    }

    /// A store with the corpus' GGPoker files: a draft is checked and
    /// previewed, saved, counted by the pass, listed with its value, shown
    /// in a report, and deleted.
    #[test]
    fn check_save_count_report_delete() {
        let dir = std::env::temp_dir().join(format!("rail-app-custom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(rail_store::FILE_NAME);
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let store = rail_store::Store::open(&path).expect("open");
        let options = rail_store::ImportOptions {
            parsed_at: Some("2026-10-13T00:00:00.000Z".to_owned()),
            source_id: None,
        };
        let mut imported = 0;
        for entry in std::fs::read_dir(root.join("gg-hh")).expect("gg-hh") {
            let file = entry.expect("entry").path();
            if file.extension().is_some_and(|ext| ext == "txt") {
                rail_store::import_file(&store, &file, &options).expect("import");
                imported += 1;
            }
        }
        assert!(imported > 0);
        let reader = store.reader();
        let state = CustomState::default();
        let cbet = "first street = flop and first_on_street and preflop_aggressor \
                    and facing = none => action = bet";

        let bad = check_draft(
            &state,
            reader,
            draft(
                "my_cbet",
                Some("first street = flp"),
                "pct(my_cbet, my_cbet_opp)",
            ),
            None,
        )
        .expect("check");
        assert_eq!(bad.problems.len(), 1);
        assert_eq!(
            (bad.problems[0].offset, bad.problems[0].length),
            (Some(15), Some(3))
        );
        let taken = check_draft(&state, reader, draft("vpip", None, "pct(pfr, vpip)"), None)
            .expect("check");
        assert!(!taken.problems.is_empty());

        let good = check_draft(
            &state,
            reader,
            draft("my_cbet", Some(cbet), "pct(my_cbet, my_cbet_opp)"),
            None,
        )
        .expect("check");
        assert!(good.problems.is_empty(), "{:?}", good.problems);
        let preview = good.preview.expect("preview");
        assert!(preview.sample && preview.hands > 0);
        assert!(preview.opp.is_some_and(|opp| opp > 0));

        let writer = store.writer().expect("writer");
        let def = draft("my_cbet", Some(cbet), "pct(my_cbet, my_cbet_opp)");
        writer
            .write(move |tx| rail_store::custom::save_custom_stat(tx, None, &def, 1))
            .expect("save");
        rail_store::background::drain(reader, &writer).expect("drain");
        let list = build_list(reader).expect("list");
        assert_eq!(list.stats.len(), 1);
        assert_eq!(list.stats[0].remaining, Some(0));
        let shown = list.stats[0].shown.clone().expect("shown");
        // The coded flop cbet over the same hands (no barrel condition on
        // the flop: the same counter).
        let hero = HeroSum::of(&reader.hero_totals(&HeroFilter::default()).expect("hero"));
        let coded = crate::reports::display()
            .expect("display")
            .get("cbet_flop")
            .expect("cbet")
            .show(&hero.sums(), None);
        assert_eq!(
            serde_json::to_value(&shown).expect("json")["value"],
            serde_json::to_value(coded.value.map(rail_core::js::JsNumber::to_f64)).expect("json")
        );
        let report =
            crate::reports::build_report(reader, &ReportFilter::default(), 10).expect("report");
        let json = serde_json::to_value(&report).expect("json");
        let ids = json["summary"]["ids"].as_array().expect("ids");
        assert_eq!(ids.last().and_then(|v| v.as_str()), Some("my_cbet"));
        assert_eq!(
            json["summary"]["stats"].as_array().map(Vec::len),
            Some(ids.len())
        );

        // A formula-only statistic previews over every hand.
        let ratio = check_draft(
            &state,
            reader,
            draft("pfr_vpip", None, "pct(pfr, vpip)"),
            None,
        )
        .expect("check");
        assert!(ratio.preview.is_some_and(|p| !p.sample));

        let gone = writer
            .write(|tx| rail_store::custom::delete_custom_stat(tx, "my_cbet"))
            .expect("delete");
        assert!(gone);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

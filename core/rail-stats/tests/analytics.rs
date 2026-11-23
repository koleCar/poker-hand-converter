//! The Analytics stat catalogue (docs/ANALYTICS.md Step 1,
//! `config/stats/analytics.json`): the shipped file loads, every rate
//! compiles through the custom-stat machinery (`CustomSet`), every rate
//! counts what `tests/data/analytics/expected.json` says on pinned hands
//! (the same file `tests/test/analytics.test.ts` reads for the web), the
//! membership agrees with the counts, and the loader refuses what it
//! promises to.

mod support;

use std::collections::BTreeMap;
use std::fs;

use rail_config::stats::StatsFile;
use rail_core::phf::serialize::{StandardContext, parse_standard_hand};
use rail_core::phf::{PhfHand, Street};
use rail_stats::analytics::{
    ActionClass, Catalogue, CatalogueError, SHIPPED_ANALYTICS, StatKind, catalogue, load_catalogue,
};
use rail_stats::custom::{Counts, CustomSet, Part};
use rail_stats::events::hand_events;
use serde_json::Value;
use support::{read_json, root};

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};

fn hand(path: &str) -> PhfHand {
    let full = root().join(path);
    let text = fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display()));
    parse_standard_hand(&text, &CTX)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .unwrap_or_else(|| panic!("{path} did not parse"))
}

fn shipped_ids() -> Vec<String> {
    serde_json::from_str::<StatsFile>(rail_config::stats::SHIPPED_STATS)
        .expect("standard.json")
        .stats
        .into_iter()
        .map(|def| def.id)
        .collect()
}

#[test]
fn the_shipped_catalogue_loads() {
    let catalogue = catalogue();
    let ids: Vec<&str> = catalogue
        .stats
        .iter()
        .map(|stat| stat.id.as_str())
        .collect();
    // The coach's list (docs/ANALYTICS.md Step 1).
    assert_eq!(
        ids,
        [
            "vpip",
            "pfr",
            "rfi",
            "three_bet",
            "bb_fold_vs_steal",
            "fold_to_three_bet",
            "four_bet",
            "flop_fold_vs_bet",
            "flop_raise_vs_bet",
            "flop_raise_weak",
            "cbet_flop",
            "turn_fold_vs_bet",
            "turn_fold_vs_probe",
            "turn_barrel",
            "river_bet",
            "river_bet_weak",
            "river_fold_vs_bet",
            "river_raise_vs_bet",
            "river_raise_weak",
            "wtsd",
            "wsd",
            "wwsf",
        ]
    );
    // The streets in play order, then showdown.
    let streets: Vec<Street> = catalogue.stats.iter().map(|stat| stat.street).collect();
    assert!(streets.windows(2).all(|pair| pair[0] <= pair[1]));
    for stat in &catalogue.stats {
        match &stat.kind {
            StatKind::Rate { .. } => assert_ne!(stat.street, Street::Showdown),
            StatKind::Share { of, .. } => {
                let (_, parent) = catalogue.get(of).expect("parent");
                assert!(parent.class().is_some());
            }
            StatKind::Coded { coded } => assert!(shipped_ids().contains(coded)),
        }
    }
}

#[test]
fn every_rate_compiles_through_the_custom_set() {
    let catalogue = catalogue();
    let defs = catalogue.custom_defs();
    let rates = catalogue
        .stats
        .iter()
        .filter(|stat| stat.counter().is_some())
        .count();
    assert_eq!(defs.len(), rates);
    let (set, refused) = CustomSet::compile(&defs);
    assert!(refused.is_empty(), "refused: {refused:?}");
    assert_eq!(set.stats.len(), rates);
    // As the store installs them (docs/ANALYTICS.md Step 10): no id collides
    // with a shipped statistic or a coded counter, and each one alone
    // validates but for its id - the `an_` range is kept for them, so the
    // editor refuses it to the user's own statistics.
    let shipped = shipped_ids();
    let shipped: Vec<&str> = shipped.iter().map(String::as_str).collect();
    let empty = CustomSet::default();
    for def in &defs {
        assert!(
            !shipped.contains(&def.def.id.as_str()),
            "{} is shipped",
            def.def.id
        );
        match empty.validate(def, None, &shipped) {
            Ok(_) => panic!("{}: the editor takes a reserved id", def.def.id),
            Err(problems) => assert!(
                problems.iter().all(|problem| problem.part == Part::Id),
                "{}: {problems:?}",
                def.def.id
            ),
        }
        assert!(!set.card_split(&def.def.id), "{} reads cards", def.def.id);
    }
    // The compiled counters count what the catalogue counts.
    let expected = read_json(&root().join("core/rail-stats/tests/data/analytics/expected.json"));
    for case in expected["hands"].as_array().expect("hands") {
        let events = hand_events(&hand(case["file"].as_str().expect("file")));
        for seat in &events.seats {
            let mine = catalogue.counts(&events, seat);
            for (stat, counter, _) in set.counters() {
                let id = stat.def.def.id.strip_prefix("an_").expect("an_ prefix");
                let (index, _) = catalogue.get(id).expect("in the catalogue");
                assert_eq!(counter.count(&events, seat), mine[index], "{id}");
            }
        }
    }
}

/// Every rate on the pinned hands: the golden per stat.
#[test]
fn every_rate_counts_the_pinned_hands() {
    let catalogue = catalogue();
    let expected = read_json(&root().join("core/rail-stats/tests/data/analytics/expected.json"));
    let mut covered: BTreeMap<&str, (u32, u32)> = BTreeMap::new();
    let mut failures = Vec::new();
    for case in expected["hands"].as_array().expect("hands") {
        let file = case["file"].as_str().expect("file");
        let phf = hand(file);
        let events = hand_events(&phf);
        let seats = case["seats"].as_object().expect("seats");
        assert_eq!(seats.len(), events.seats.len(), "{file}: every seat listed");
        for seat in &events.seats {
            let name = &phf
                .players
                .iter()
                .find(|player| player.seat == seat.seat)
                .expect("player")
                .name;
            let want = &seats[name.as_str()];
            let counts = catalogue.counts(&events, seat);
            for (stat, got) in catalogue.stats.iter().zip(&counts) {
                if stat.counter().is_none() {
                    continue;
                }
                let pair = want.get(&stat.id).map_or((0, 0), |pair| {
                    let n =
                        |i: usize| u32::try_from(pair[i].as_u64().expect("count")).expect("small");
                    (n(0), n(1))
                });
                let got = (got.made, got.opp);
                if got != pair {
                    failures.push(format!(
                        "{file} {name} {}: got {got:?}, expected {pair:?}",
                        stat.id
                    ));
                }
                let entry = covered.entry(stat.id.as_str()).or_default();
                entry.0 += got.0;
                entry.1 += got.1;
            }
            for key in want.as_object().expect("counts").keys() {
                assert!(
                    catalogue
                        .get(key)
                        .is_some_and(|(_, s)| s.counter().is_some()),
                    "{file} {name}: {key} is not a rate"
                );
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    // Every rate is pinned with an opportunity, and with a made and an
    // unmade one where the hands allow.
    let thin: Vec<String> = catalogue
        .stats
        .iter()
        .filter(|stat| stat.counter().is_some())
        .filter_map(|stat| {
            let (made, opp) = covered.get(stat.id.as_str()).copied().unwrap_or_default();
            (made == 0 || made == opp).then(|| format!("{}: pinned {made}/{opp}", stat.id))
        })
        .collect();
    assert!(thin.is_empty(), "{}", thin.join("\n"));
}

#[test]
fn membership_names_the_counted_decisions() {
    let catalogue = catalogue();
    let expected = read_json(&root().join("core/rail-stats/tests/data/analytics/expected.json"));
    for case in expected["hands"].as_array().expect("hands") {
        let file = case["file"].as_str().expect("file");
        let events = hand_events(&hand(file));
        let members = catalogue.membership(&events);
        assert!(members.windows(2).all(|pair| pair[0].order < pair[1].order));
        for seat in &events.seats {
            let counts = catalogue.counts(&events, seat);
            for (index, count) in counts.iter().enumerate() {
                let mine: Vec<bool> = members
                    .iter()
                    .filter(|member| member.seat == seat.seat)
                    .flat_map(|member| &member.stats)
                    .filter(|(stat, _)| *stat == index)
                    .map(|(_, taken)| *taken)
                    .collect();
                let taken =
                    u32::try_from(mine.iter().filter(|taken| **taken).count()).expect("small");
                let opp = u32::try_from(mine.len()).expect("small");
                assert_eq!(
                    Counts { made: taken, opp },
                    *count,
                    "{file} seat {}",
                    seat.seat
                );
            }
            // Every member is one of the seat's own decisions.
            for member in members.iter().filter(|member| member.seat == seat.seat) {
                assert!(seat.events.iter().any(|event| event.order == member.order));
            }
        }
    }
    // The probe: the 03 hand's CO turn fold is in both turn folds, taken.
    let events = hand_events(&hand(
        "core/rail-stats/tests/data/analytics/03-fold-to-probe.txt",
    ));
    let (fold, _) = catalogue.get("turn_fold_vs_bet").expect("stat");
    let (probe, _) = catalogue.get("turn_fold_vs_probe").expect("stat");
    let last = events
        .seats
        .iter()
        .flat_map(|seat| &seat.events)
        .map(|event| event.order)
        .max()
        .expect("decisions");
    let member = catalogue
        .membership(&events)
        .into_iter()
        .find(|member| member.order == last)
        .expect("the turn fold is a member");
    assert_eq!(member.stats, [(fold, true), (probe, true)]);
}

#[test]
fn hand_classes_and_action_classes() {
    let catalogue = catalogue();
    let class = |made: Option<&str>, draws: &[&str]| {
        catalogue
            .hand_class(made, draws)
            .map(|class| class.id.as_str())
    };
    assert_eq!(class(None, &[]), None);
    assert_eq!(class(Some("set"), &["flush-draw"]), Some("top_pair_plus"));
    assert_eq!(class(Some("top-pair"), &[]), Some("top_pair_plus"));
    assert_eq!(class(Some("second-pair"), &["oesd"]), Some("middle_pair"));
    assert_eq!(
        class(Some("pocket-pair-below-top"), &[]),
        Some("middle_pair")
    );
    assert_eq!(class(Some("weak-pair"), &[]), Some("weak_pair"));
    assert_eq!(class(Some("underpair"), &[]), Some("underpair"));
    assert_eq!(
        class(Some("high-card"), &["nut-flush-draw"]),
        Some("strong_draw")
    );
    assert_eq!(
        class(Some("ace-high"), &["oesd", "backdoor-flush"]),
        Some("strong_draw")
    );
    assert_eq!(
        class(Some("high-card"), &["gutshot", "overcards"]),
        Some("gutshot")
    );
    assert_eq!(
        class(Some("ace-high"), &["backdoor-straight"]),
        Some("ace_high_backdoor")
    );
    assert_eq!(
        class(Some("high-card"), &["backdoor-flush"]),
        Some("nothing")
    );
    assert_eq!(class(Some("high-card"), &["overcards"]), Some("overcards"));
    assert_eq!(class(Some("ace-high"), &[]), Some("nothing"));
    assert_eq!(class(Some("board"), &[]), Some("nothing"));

    assert!(catalogue.in_class(ActionClass::Fold, "fold"));
    assert!(!catalogue.in_class(ActionClass::Fold, "check"));
    assert!(catalogue.in_class(ActionClass::Vpip, "call"));
    assert!(catalogue.in_class(ActionClass::Vpip, "raise"));
    assert!(!catalogue.in_class(ActionClass::Vpip, "check"));
    assert!(catalogue.in_class(ActionClass::Pfr, "raise"));
    assert!(!catalogue.in_class(ActionClass::Pfr, "call"));
    assert!(!catalogue.in_class(ActionClass::Bet, "allin"));
}

/* ------------------------------------------------------------ refusals - */

fn shipped_json() -> Value {
    serde_json::from_str(SHIPPED_ANALYTICS).expect("json")
}

fn stat_mut<'a>(doc: &'a mut Value, id: &str) -> &'a mut Value {
    doc["stats"]
        .as_array_mut()
        .expect("stats")
        .iter_mut()
        .find(|stat| stat["id"] == id)
        .unwrap_or_else(|| panic!("no {id}"))
}

fn problems(doc: &Value) -> Vec<String> {
    match load_catalogue(&doc.to_string()) {
        Ok(_) => Vec::new(),
        Err(CatalogueError::Invalid(problems)) => problems,
        Err(other) => vec![other.to_string()],
    }
}

fn refused(edit: impl FnOnce(&mut Value), want: &str) {
    let mut doc = shipped_json();
    edit(&mut doc);
    let got = problems(&doc);
    assert!(
        got.iter().any(|problem| problem.contains(want)),
        "expected a problem with {want:?}, got {got:?}"
    );
}

#[test]
fn the_loader_refuses_what_it_promises_to() {
    assert!(problems(&shipped_json()).is_empty());

    refused(|d| d["version"] = 2.into(), "version 2");
    refused(|d| d["extra"] = 1.into(), "unknown field");
    refused(
        |d| stat_mut(d, "flop_fold_vs_bet")["class"] = "call".into(),
        "flop_fold_vs_bet: the count's action is not class call",
    );
    refused(
        |d| {
            stat_mut(d, "flop_fold_vs_bet")["count"] =
                "first street = flop and facing = bet => action = fold and all_in".into();
        },
        "exactly a test of action",
    );
    refused(
        |d| stat_mut(d, "flop_fold_vs_bet")["count"] = "first facing = bet => action = fold".into(),
        "starts with street = flop",
    );
    refused(
        |d| stat_mut(d, "flop_fold_vs_bet")["count"] = "first stret = flop => action = fold".into(),
        "did you mean street",
    );
    refused(
        |d| {
            stat_mut(d, "flop_fold_vs_bet")["count"] =
                "first street = flop and facing = bet and pocket_pair => action = fold".into();
        },
        "no card fields",
    );
    refused(
        |d| stat_mut(d, "flop_fold_vs_bet")["group"] = "turn_facing_bet".into(),
        "is on another street",
    );
    refused(
        |d| stat_mut(d, "flop_fold_vs_bet")["group"] = "nope".into(),
        "no group nope",
    );
    refused(
        |d| stat_mut(d, "flop_fold_vs_bet")["family"] = "nope".into(),
        "no family nope",
    );
    refused(
        |d| stat_mut(d, "vpip")["coded"] = "nope".into(),
        "no shipped statistic nope",
    );
    refused(
        |d| stat_mut(d, "vpip")["coded"] = "aggression_factor".into(),
        "not pct(made, opportunities)",
    );
    refused(
        |d| stat_mut(d, "turn_fold_vs_probe")["within"] = "turn_barrel".into(),
        "within turn_barrel",
    );
    refused(
        |d| stat_mut(d, "river_bet_weak")["of"] = "wtsd".into(),
        "of wtsd",
    );
    refused(
        |d| stat_mut(d, "river_bet_weak")["weak"] = serde_json::json!(["nothing", "junk"]),
        "weak: junk",
    );
    refused(
        |d| stat_mut(d, "river_bet_weak")["class"] = "bet".into(),
        "a share has no class",
    );
    refused(
        |d| stat_mut(d, "wtsd")["count"] = "any saw_flop => showdown".into(),
        "a coded stat has no count",
    );
    refused(
        |d| stat_mut(d, "pfr")["id"] = "vpip".into(),
        "a second stat with this id",
    );
    refused(
        |d| stat_mut(d, "pfr")["id"] = "x".repeat(58).into(),
        "at most 57 bytes",
    );
    refused(
        |d| stat_mut(d, "pfr")["sample"]["min"] = 0.into(),
        "sample.min",
    );
    refused(
        |d| stat_mut(d, "pfr")["band"]["floor"] = 0.into(),
        "band.floor",
    );
    refused(
        |d| stat_mut(d, "pfr")["label"]["hr"] = " ".into(),
        "every text",
    );
    refused(
        |d| d["handClasses"][0]["made"] = serde_json::json!(["top-pair", "monster"]),
        "monster is not a made class",
    );
    refused(
        |d| {
            let last = d["handClasses"].as_array().expect("classes").len() - 1;
            d["handClasses"][last]["draws"] = serde_json::json!(["gutshot"]);
        },
        "the last hand class",
    );
    refused(
        |d| {
            d["groups"]
                .as_array_mut()
                .expect("groups")
                .push(serde_json::json!({
                    "id": "spare", "street": "flop", "label": { "en": "Spare", "hr": "Rezerva" }
                }))
        },
        "a group no stat is in",
    );
    refused(
        |d| d["actionClasses"]["vpip"] = serde_json::json!(["call", "raise"]),
        "vpip: the count's action is not class vpip",
    );
}

/// The membership a stored decision carries is computed under
/// `MEMBERSHIP_VERSION`: a change to a rate's id, class or count must bump
/// it (and the web's `ANALYTICS_MEMBERSHIP_VERSION`), then re-pin here.
#[test]
fn the_membership_version_is_pinned_to_the_rates() {
    let fingerprint = catalogue().membership_fingerprint();
    assert_eq!(
        (
            rail_stats::analytics::MEMBERSHIP_VERSION,
            support::sha256_hex(&fingerprint).as_str()
        ),
        (
            "analytics/1",
            "7028ad973dfd9427342549616e247bf45e412625d2116c49cbfbd69172dc5119"
        ),
        "a rate changed: bump MEMBERSHIP_VERSION (Rust and web) and re-pin\n{fingerprint}"
    );
}

/// The catalogue file and the web's copy are the same bytes.
#[test]
fn the_web_copy_is_the_same_file() {
    let web =
        fs::read_to_string(root().join("web/src/lib/stats/analytics.json")).expect("web copy");
    assert_eq!(
        web, SHIPPED_ANALYTICS,
        "copy config/stats/analytics.json to web/src/lib/stats/analytics.json"
    );
    let _: &Catalogue = catalogue();
}

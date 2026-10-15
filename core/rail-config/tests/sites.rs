//! `config/sites.json` against the Rust core (docs/RAIL-PLAN.md R0.12).
//!
//! The CI rule: a parser without a `sites.json` entry fails the build, and so
//! does an entry naming a parser that does not exist. With it, the guideline's
//! "a new room or format = parser + golden tests + an entry in
//! config/sites.json, in the same pull request" (§14) is enforced. The JSON
//! Schema itself is checked by the TypeScript harness
//! (`tests/test/sitesConfig.test.ts`, ajv), which has a schema engine.

use std::path::Path;

use rail_config::model::{Anonymisation, HudRestrictions, SiteKind};
use rail_config::{
    Error, MergeNote, SHIPPED, check_coverage, load, load_remote, load_shipped, validate,
};
use rail_core::detect::SiteParser;
use rail_core::parsers::{REGISTRATION_ORDER, builtin};
use rail_core::unrecognized::KNOWN_FORMATS;
use serde_json::{Value, json};

fn repo() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn shipped_value() -> Value {
    serde_json::from_str(SHIPPED).expect("sites.json is JSON")
}

fn site_mut<'a>(value: &'a mut Value, id: &str) -> &'a mut Value {
    value["sites"]
        .as_array_mut()
        .expect("sites")
        .iter_mut()
        .find(|site| site["id"] == id)
        .unwrap_or_else(|| panic!("no site {id}"))
}

fn problems(value: &Value) -> Vec<String> {
    match load(&value.to_string(), &REGISTRATION_ORDER) {
        Ok(_) => Vec::new(),
        Err(Error::Invalid(problems)) => problems.iter().map(ToString::to_string).collect(),
        Err(other) => vec![other.to_string()],
    }
}

/// The CI rule, both directions, against the registry `convert` uses.
#[test]
fn every_parser_has_an_entry_and_every_entry_a_parser() {
    let registry: Vec<&str> = builtin().parsers().map(SiteParser::id).collect();
    assert_eq!(registry, REGISTRATION_ORDER);
    let config = load_shipped(&registry).unwrap_or_else(|error| panic!("{error}"));
    for parser in &registry {
        assert!(
            config.sites_for_parser(parser).next().is_some(),
            "{parser} has no entry"
        );
    }
    for site in &config.sites {
        if let Some(parser) = &site.parser {
            assert!(registry.contains(&parser.as_str()), "{}: {parser}", site.id);
        }
    }
}

#[test]
fn a_parser_without_an_entry_fails() {
    let mut value = shipped_value();
    value["sites"]
        .as_array_mut()
        .expect("sites")
        .retain(|site| site["parser"] != "winamax");
    assert_eq!(
        problems(&value),
        ["parser \"winamax\" has no entry in sites.json"]
    );
    // And the same through the function the rule is made of.
    let config: rail_config::Config = serde_json::from_value(value).expect("shape");
    assert_eq!(check_coverage(&config, &REGISTRATION_ORDER).len(), 1);
}

#[test]
fn an_entry_naming_a_missing_parser_fails() {
    let mut value = shipped_value();
    site_mut(&mut value, "winamax")["parser"] = json!("winamax2");
    assert_eq!(
        problems(&value),
        [
            "winamax: parser \"winamax2\" does not exist",
            "parser \"winamax\" has no entry in sites.json"
        ]
    );
}

/// R3.0: the HUD policy of every entry, as proposed in
/// `docs/research/HUD-POLICIES.md` and signed off by the owner: (id,
/// allowed, source). Any change to a policy - a room switched on or off, a
/// new source - has to change this list too, so it is a reviewed diff.
/// `None` is unknown, which the HUD treats as prohibited (guideline §7).
const HUD_POLICIES: &[(&str, Option<bool>, Option<&str>)] = &[
    (
        "pokerstars",
        Some(true),
        Some("https://www.pokerstars.uk/poker/room/prohibited/"),
    ),
    (
        "ggpoker",
        Some(false),
        Some("https://ggpoker.com/network/security-ecology-policy/"),
    ),
    (
        "winamax",
        Some(true),
        Some("https://www.winamax.fr/cgu-poker"),
    ),
    (
        "888poker",
        None,
        Some("https://www.888.ca/security-and-privacy/user-agreement/"),
    ),
    (
        "partypoker",
        Some(false),
        Some("https://www.partypoker.com/en/poker/p/safer-poker"),
    ),
    ("ipoker", None, None),
    ("acr", Some(true), Some("https://www.acrpoker.eu/security/")),
    (
        "coinpoker",
        Some(false),
        Some("https://coinpoker.com/third-party-tools/"),
    ),
    (
        "unibet",
        Some(false),
        Some("https://www.unibet.co.uk/promotions/poker-promotions/why-play-at-unibet"),
    ),
    ("chico", None, None),
    (
        "ignition",
        Some(false),
        Some("https://www.ignitioncasino.eu/poker/incognito-poker"),
    ),
    ("weplay", None, None),
    (
        "pokerbros",
        Some(false),
        Some("docs/research/hh-formats/pokerbros.md"),
    ),
    (
        "microgaming",
        Some(false),
        Some("docs/research/hh-formats/legacy-networks.md"),
    ),
    (
        "fulltilt",
        Some(false),
        Some("docs/research/hh-formats/full-tilt.md"),
    ),
    (
        "ongame",
        Some(false),
        Some("docs/research/hh-formats/legacy-networks.md"),
    ),
    (
        "entraction",
        Some(false),
        Some("docs/research/hh-formats/legacy-networks.md"),
    ),
    (
        "runitonce",
        Some(false),
        Some("docs/research/hh-formats/run-it-once.md"),
    ),
    ("standard", Some(false), None),
    (
        "wpt-global",
        Some(false),
        Some("https://wptglobal.com/terms-and-conditions"),
    ),
    (
        "bossmedia",
        Some(false),
        Some("docs/research/hh-formats/legacy-networks.md"),
    ),
    (
        "merge",
        Some(false),
        Some("docs/research/hh-formats/legacy-networks.md"),
    ),
];

/// The date of the R3.0 check; a re-check (plan §12) moves it.
const HUD_CHECKED_AT: &str = "2026-10-14";

#[test]
fn hud_policies_are_the_signed_list() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let shipped: Vec<(&str, Option<bool>, Option<&str>)> = config
        .sites
        .iter()
        .map(|site| {
            (
                site.id.as_str(),
                site.hud.allowed,
                site.hud.source.as_deref(),
            )
        })
        .collect();
    assert_eq!(shipped, HUD_POLICIES);
    for site in &config.sites {
        assert_eq!(
            site.hud.checked_at.as_deref(),
            Some(HUD_CHECKED_AT),
            "{}",
            site.id
        );
        assert!(!site.hud.notes.trim().is_empty(), "{}", site.id);
        if site.hud.allowed == Some(true) {
            assert_eq!(site.kind, SiteKind::Room, "{}", site.id);
            assert!(
                site.hud
                    .source
                    .as_deref()
                    .is_some_and(|source| source.starts_with("https://")),
                "{}",
                site.id
            );
        }
        // A source that is not a web page is a repository document.
        if let Some(source) = site.hud.source.as_deref()
            && !source.starts_with("https://")
        {
            assert!(repo().join(source).is_file(), "{}: {source}", site.id);
        }
    }
    let permitted: Vec<&str> = config
        .sites
        .iter()
        .filter(|site| site.hud_permitted())
        .map(|site| site.id.as_str())
        .collect();
    assert_eq!(permitted, ["pokerstars", "winamax", "acr"]);
}

/// R3.4: each permitted room's restrictions, from its policy
/// (`docs/research/HUD-POLICIES.md`), enforced by the HUD's renderer; the
/// rooms without a HUD carry none. The TypeScript schema test pins the same.
#[test]
fn hud_restrictions_are_the_policies() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let of = |id: &str| config.site(id).expect(id).hud.restrictions;
    assert_eq!(
        of("pokerstars"),
        Some(HudRestrictions {
            own_hands_only: true,
            raw_counts_only: true,
            max_colour_thresholds: Some(2),
            no_card_split_stats: true,
            no_game_state_switching: true,
            no_tendency_switching: true,
            no_player_labels: true,
            no_hand_charts: true,
            no_graphs: true,
            no_hand_in_play: false,
            no_overlap_table_graphics: false,
        })
    );
    assert_eq!(
        of("acr"),
        Some(HudRestrictions {
            own_hands_only: true,
            no_player_labels: true,
            no_hand_in_play: true,
            no_overlap_table_graphics: true,
            ..HudRestrictions::NONE
        })
    );
    assert_eq!(
        of("winamax"),
        Some(HudRestrictions {
            own_hands_only: true,
            no_game_state_switching: true,
            no_tendency_switching: true,
            ..HudRestrictions::NONE
        })
    );
    for site in &config.sites {
        assert_eq!(
            site.hud.restrictions.is_some(),
            site.hud_permitted(),
            "{}",
            site.id
        );
    }
    // The HUD's default panel (R3.4) complies with every room at once.
    let all = [of("pokerstars"), of("acr"), of("winamax")]
        .into_iter()
        .flatten()
        .fold(HudRestrictions::NONE, |a, b| a.stricter(&b));
    assert!(HudRestrictions::STRICTEST.at_least_as_strict_as(&all));
}

/// A permitted room's restrictions block with nothing restricted.
fn no_restrictions() -> Value {
    serde_json::to_value(HudRestrictions::NONE).expect("json")
}

/// A well-formed seat layout (R3.6) with `seats` seats on a circle-ish
/// row, a plate, the centre, the hero at the first seat and a board zone.
fn seat_layout(seats: u32) -> Value {
    let points: Vec<Value> = (0..seats).map(|i| json!([100 + i * 80, 800])).collect();
    json!({
        "seats": points,
        "plate": [150, 80],
        "center": [500, 500],
        "heroSlot": 0,
        "graphics": [[300, 450, 400, 120]],
        "seatNumbers": null
    })
}

/// A shipped-shaped file accepts measured layouts: every size, a seat
/// numbering, a rotating client.
#[test]
fn seat_layouts_are_accepted() {
    let mut value = shipped_value();
    let tables = &mut site_mut(&mut value, "winamax")["tables"];
    let mut nine = seat_layout(6);
    nine["seatNumbers"] = json!([1, 2, 4, 5, 7, 8]);
    nine["heroSlot"] = json!(5);
    tables["seatLayouts"] = json!({"2": seat_layout(2), "6": nine, "10": seat_layout(10)});
    tables["preferredSeat"] = json!(true);
    assert_eq!(problems(&value), Vec::<String>::new());
    let config = load(&value.to_string(), &REGISTRATION_ORDER).expect("loads");
    let layouts = config
        .site("winamax")
        .and_then(|s| s.tables.seat_layouts.as_ref())
        .expect("layouts");
    assert_eq!(
        layouts["6"].seat_numbers.as_deref(),
        Some(&[1, 2, 4, 5, 7, 8][..])
    );
    assert_eq!(layouts["6"].hero_slot, 5);
}

/// The `files` blocks seen on a real install (R1.4, macOS, 2026-10-13):
/// WePlay writes live; GGPoker and CoinPoker write no local hand histories
/// (verified negatives, no path).
const VERIFIED_FILES: &[&str] = &["ggpoker", "coinpoker", "weplay"];

/// The folders seen on a real install: (site, OS).
const VERIFIED_PATHS: &[(&str, &str)] = &[("weplay", "macos")];

/// Unknown is null, not a guess: only what R1.4 saw on a real install is
/// verified (the lists above, each with its date and an "Observed on"
/// source); every other path and `files` block stays unverified, and no
/// table data is verified before R3.3 / R3.11 look at real windows.
#[test]
fn only_what_was_seen_is_verified() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    for site in &config.sites {
        for (os, entries) in [
            ("windows", &site.paths.windows),
            ("macos", &site.paths.macos),
        ] {
            let seen = VERIFIED_PATHS.contains(&(site.id.as_str(), os));
            for entry in entries {
                if seen {
                    assert!(entry.verified, "{} {os}", site.id);
                    assert!(entry.checked_at.is_some(), "{} {os}", site.id);
                    assert!(entry.source.starts_with("Observed on "), "{} {os}", site.id);
                } else {
                    assert!(
                        !entry.verified && entry.checked_at.is_none(),
                        "{} {os}",
                        site.id
                    );
                }
            }
            if seen {
                assert!(!entries.is_empty(), "{} {os}", site.id);
            }
        }
        let files_seen = VERIFIED_FILES.contains(&site.id.as_str());
        assert_eq!(site.files.verified, files_seen, "{}", site.id);
        if files_seen {
            assert!(site.files.source.starts_with("Observed on "), "{}", site.id);
            assert!(site.files.live.is_some(), "{}", site.id);
            // A client that writes nothing locally has no folder to find.
            if site.files.live == Some(false) {
                assert!(
                    site.paths.windows.is_empty() && site.paths.macos.is_empty(),
                    "{}",
                    site.id
                );
            }
        }
        assert!(
            !site.tables.verified && site.tables.is_unknown(),
            "{}",
            site.id
        );
    }
}

#[test]
fn ids_are_unique_and_docs_exist() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let mut ids: Vec<&str> = config.sites.iter().map(|site| site.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), config.sites.len());
    for site in &config.sites {
        assert!(!site.docs.is_empty(), "{}", site.id);
        for doc in &site.docs {
            assert!(
                repo().join(doc).is_file(),
                "{}: {doc} does not exist",
                site.id
            );
        }
    }
}

/// The formats the unsupported-format registry guesses (R0.11) are entries
/// without a parser, under the same ids.
#[test]
fn known_formats_without_a_parser_have_entries() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    for format in KNOWN_FORMATS {
        let site = config
            .site(format.id)
            .unwrap_or_else(|| panic!("no entry for {}", format.id));
        assert_eq!(site.parser, None, "{}", format.id);
    }
    let wpt = config.site("wpt-global").expect("WPT Global");
    assert_eq!((wpt.parser.as_deref(), wpt.files.live), (None, Some(false)));
}

/// `anonymisation` is the site-level default of
/// `frontend/src/lib/db/anonymization.ts` (docs/DATABASE.md): positional and
/// opaque-id for the parsers in its two sets, none for every other parser.
#[test]
fn anonymisation_matches_the_web() {
    let source = std::fs::read_to_string(repo().join("frontend/src/lib/db/anonymization.ts"))
        .expect("read anonymization.ts");
    let set = |name: &str| -> Vec<String> {
        let start = source
            .find(&format!("const {name} = new Set(["))
            .unwrap_or_else(|| panic!("{name} not found"));
        let rest = &source[start..];
        let body = &rest[rest.find('[').expect("[") + 1..rest.find(']').expect("]")];
        body.split(',')
            .map(|item| item.trim().trim_matches('"').to_owned())
            .filter(|item| !item.is_empty())
            .collect()
    };
    let positional = set("POSITIONAL_SITES");
    let opaque = set("OPAQUE_ID_SITES");
    assert_eq!((positional.len(), opaque.len()), (1, 1));
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    for site in &config.sites {
        let Some(parser) = &site.parser else {
            continue;
        };
        let expected = if positional.contains(parser) {
            Anonymisation::Positional
        } else if opaque.contains(parser) {
            Anonymisation::OpaqueId
        } else {
            Anonymisation::None
        };
        assert_eq!(site.anonymisation, Some(expected), "{}", site.id);
    }
}

#[test]
fn validator_problems() {
    type Edit = fn(&mut Value);
    let cases: [(&str, Edit, &str); 18] = [
        (
            "hud allowed without restrictions",
            |v| site_mut(v, "pokerstars")["hud"]["restrictions"] = Value::Null,
            "pokerstars: hud.allowed is true without restrictions",
        ),
        (
            "hud allowed without a date",
            |v| {
                let hud = &mut site_mut(v, "888poker")["hud"];
                hud["allowed"] = json!(true);
                hud["restrictions"] = no_restrictions();
                hud["source"] = json!("https://example.org");
                hud["checkedAt"] = Value::Null;
            },
            "888poker: hud.allowed is true without checkedAt",
        ),
        (
            "duplicate id",
            |v| {
                let copy = site_mut(v, "winamax").clone();
                v["sites"].as_array_mut().expect("sites").push(copy);
            },
            "winamax: duplicate id",
        ),
        (
            "hud allowed without a source",
            |v| {
                let hud = &mut site_mut(v, "888poker")["hud"];
                hud["allowed"] = json!(true);
                hud["restrictions"] = no_restrictions();
                hud["source"] = Value::Null;
                hud["checkedAt"] = json!("2026-10-13");
            },
            "888poker: hud.allowed is true without an https source",
        ),
        (
            "hud allowed with an http source",
            |v| {
                let hud = &mut site_mut(v, "888poker")["hud"];
                hud["allowed"] = json!(true);
                hud["restrictions"] = no_restrictions();
                hud["source"] = json!("http://example.org");
                hud["checkedAt"] = json!("2026-10-13");
            },
            "888poker: hud.allowed is true without an https source",
        ),
        (
            "a network cannot allow a HUD",
            |v| {
                let hud = &mut site_mut(v, "ipoker")["hud"];
                hud["allowed"] = json!(true);
                hud["restrictions"] = no_restrictions();
                hud["source"] = json!("https://example.org");
                hud["checkedAt"] = json!("2026-10-13");
            },
            "ipoker: only a room can allow a HUD; split the network first",
        ),
        (
            "a network has no table windows",
            |v| site_mut(v, "chico")["tables"]["title"] = json!("^(?<table>.+)$"),
            "chico: only a room has table windows",
        ),
        (
            "a title that does not compile",
            |v| site_mut(v, "winamax")["tables"]["title"] = json!("^(?<table>.+"),
            "winamax: tables.title does not compile",
        ),
        (
            "a title without the table group",
            |v| site_mut(v, "winamax")["tables"]["title"] = json!("^(.+) - "),
            "winamax: tables.title has no named group `table`",
        ),
        (
            "a seat layout for 11 seats",
            |v| {
                site_mut(v, "winamax")["tables"]["seatLayouts"] = json!({"11": seat_layout(11)});
            },
            "winamax: tables.seatLayouts: \"11\" is not a table size 2-10",
        ),
        (
            "a seat layout with a seat missing",
            |v| site_mut(v, "winamax")["tables"]["seatLayouts"] = json!({"6": seat_layout(5)}),
            "winamax: tables.seatLayouts.6: 5 seats for a 6-seat table",
        ),
        (
            "a hero slot that is no seat",
            |v| {
                let mut layout = seat_layout(6);
                layout["heroSlot"] = json!(6);
                site_mut(v, "winamax")["tables"]["seatLayouts"] = json!({"6": layout});
            },
            "winamax: tables.seatLayouts.6: heroSlot 6 is not a seat",
        ),
        (
            "table graphics off the client area",
            |v| {
                let mut layout = seat_layout(6);
                layout["graphics"] = json!([[900, 100, 200, 50]]);
                site_mut(v, "winamax")["tables"]["seatLayouts"] = json!({"6": layout});
            },
            "winamax: tables.seatLayouts.6: graphics outside the client area",
        ),
        (
            "verified table titles without a date",
            |v| {
                let tables = &mut site_mut(v, "winamax")["tables"];
                tables["verified"] = json!(true);
                tables["title"] = json!("^(?P<table>.+?) - ");
                tables["source"] = json!("Observed on a Windows install, 2026-10-20: Winamax 7");
            },
            "winamax: tables.verified without checkedAt",
        ),
        (
            "verified table titles without an observation",
            |v| {
                let tables = &mut site_mut(v, "winamax")["tables"];
                tables["verified"] = json!(true);
                tables["title"] = json!("^(?P<table>.+?) - ");
                tables["checkedAt"] = json!("2026-10-20");
                tables["source"] = json!("docs/research/hh-formats/winamax.md");
            },
            "winamax: tables.verified without an \"Observed on ...\" source",
        ),
        (
            "verified table titles without a regex",
            |v| {
                let tables = &mut site_mut(v, "winamax")["tables"];
                tables["verified"] = json!(true);
                tables["checkedAt"] = json!("2026-10-20");
                tables["source"] = json!("Observed on a Windows install, 2026-10-20: Winamax 7");
            },
            "winamax: tables.verified without a title regex",
        ),
        (
            "a verified path without a date",
            |v| site_mut(v, "pokerstars")["paths"]["windows"][0]["verified"] = json!(true),
            "pokerstars: windows path \"%LOCALAPPDATA%\\\\PokerStars\\\\HandHistory\\\\*\" is verified without checkedAt",
        ),
        (
            "a relative macOS path",
            |v| {
                site_mut(v, "pokerstars")["paths"]["macos"][0]["path"] =
                    json!("Library/PokerStars");
            },
            "pokerstars: macos path \"Library/PokerStars\" does not start at a known root",
        ),
    ];
    for (name, edit, expected) in cases {
        let mut value = shipped_value();
        edit(&mut value);
        let found = problems(&value);
        assert!(
            found.len() == 1 && found[0].starts_with(expected),
            "{name}: {found:?}"
        );
    }
}

#[test]
fn shape_errors_are_refused() {
    let mut unknown_field = shipped_value();
    site_mut(&mut unknown_field, "winamax")["hudAllowed"] = json!(true);
    let mut wrong_type = shipped_value();
    site_mut(&mut wrong_type, "winamax")["hud"]["allowed"] = json!("yes");
    let mut wrong_enum = shipped_value();
    site_mut(&mut wrong_enum, "ggpoker")["anonymisation"] = json!("hashed");
    for value in [unknown_field, wrong_type, wrong_enum] {
        assert!(matches!(
            load(&value.to_string(), &REGISTRATION_ORDER),
            Err(Error::Json(_))
        ));
    }
    let mut version = shipped_value();
    version["version"] = json!(2);
    assert!(matches!(
        load(&version.to_string(), &REGISTRATION_ORDER),
        Err(Error::Version {
            found: 2,
            expected: 1
        })
    ));
}

#[test]
fn the_shipped_file_as_its_own_remote_changes_nothing() {
    let shipped = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let merged = load_remote(&shipped, SHIPPED, &REGISTRATION_ORDER).expect("valid remote");
    assert_eq!(merged.config, shipped);
    assert_eq!(merged.notes, Vec::new());
}

#[test]
fn a_remote_file_cannot_switch_a_hud_on() {
    let shipped = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let mut remote = shipped_value();
    {
        let site = site_mut(&mut remote, "888poker");
        site["hud"] = json!({
            "allowed": true,
            "source": "https://example.org/terms",
            "checkedAt": "2026-10-13",
            "restrictions": no_restrictions(),
            "notes": ""
        });
        site["files"]["notes"] = json!("corrected");
    }
    site_mut(&mut remote, "weplay")["hud"]["allowed"] = json!(false);
    let merged =
        load_remote(&shipped, &remote.to_string(), &REGISTRATION_ORDER).expect("valid remote");
    let p888 = merged.config.site("888poker").expect("888poker");
    assert_eq!(p888.hud, shipped.site("888poker").expect("shipped").hud);
    assert_eq!(p888.files.notes, "corrected");
    assert_eq!(
        merged.config.site("weplay").expect("weplay").hud.allowed,
        Some(false)
    );
    assert_eq!(
        merged.notes,
        [MergeNote::LooserHudIgnored {
            id: "888poker".to_owned(),
            shipped: None,
            remote: Some(true)
        }]
    );
    assert_eq!(validate(&merged.config, &REGISTRATION_ORDER), Vec::new());
}

/// The other direction, on a room R3.0 allows: a room that changes its rules
/// between releases is switched off by the remote file without a new version.
#[test]
fn a_remote_file_can_switch_an_allowed_hud_off() {
    let shipped = load_shipped(&REGISTRATION_ORDER).expect("valid");
    assert!(
        shipped
            .site("pokerstars")
            .expect("pokerstars")
            .hud_permitted()
    );
    let mut remote = shipped_value();
    site_mut(&mut remote, "pokerstars")["hud"] = json!({
        "allowed": false,
        "source": "https://www.pokerstars.uk/poker/room/prohibited/",
        "checkedAt": "2026-11-01",
        "notes": "re-check: HUDs no longer permitted"
    });
    let merged =
        load_remote(&shipped, &remote.to_string(), &REGISTRATION_ORDER).expect("valid remote");
    let pokerstars = merged.config.site("pokerstars").expect("pokerstars");
    assert!(!pokerstars.hud_permitted());
    assert_eq!(pokerstars.hud.checked_at.as_deref(), Some("2026-11-01"));
    assert_eq!(merged.notes, Vec::new());
}

#[test]
fn an_invalid_remote_file_is_refused_whole() {
    let shipped = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let mut remote = shipped_value();
    site_mut(&mut remote, "winamax")["parser"] = json!("winamax2");
    assert!(matches!(
        load_remote(&shipped, &remote.to_string(), &REGISTRATION_ORDER),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        load_remote(&shipped, "{", &REGISTRATION_ORDER),
        Err(Error::Json(_))
    ));
}

#[test]
fn kinds() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    let of = |kind| {
        config
            .sites
            .iter()
            .filter(|site| site.kind == kind)
            .map(|site| site.id.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(of(SiteKind::Format), ["standard"]);
    for id in of(SiteKind::Network) {
        let site = config.site(id).expect("site");
        assert!(site.tables.is_unknown(), "{id}");
    }
}

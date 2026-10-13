//! `config/sites.json` against the Rust core (docs/RAIL-PLAN.md R0.12).
//!
//! The CI rule: a parser without a `sites.json` entry fails the build, and so
//! does an entry naming a parser that does not exist. With it, the guideline's
//! "a new room or format = parser + golden tests + an entry in
//! config/sites.json, in the same pull request" (§14) is enforced. The JSON
//! Schema itself is checked by the TypeScript harness
//! (`tests/test/sitesConfig.test.ts`, ajv), which has a schema engine.

use std::path::Path;

use rail_config::model::{Anonymisation, SiteKind};
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

/// R0.12: no HUD policy is known yet. R3.0 replaces this test with the
/// owner-signed list of rooms that allow one.
#[test]
fn every_hud_policy_is_unknown_until_r3_0() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    for site in &config.sites {
        assert_eq!(site.hud.allowed, None, "{}", site.id);
        assert_eq!(site.hud.source, None, "{}", site.id);
        assert!(!site.hud_permitted(), "{}", site.id);
    }
}

/// Unknown is null, not a guess: nothing is verified before R1.4 (paths,
/// files) and R3.3 / R3.11 (tables) look at real installs.
#[test]
fn nothing_is_verified_yet() {
    let config = load_shipped(&REGISTRATION_ORDER).expect("valid");
    for site in &config.sites {
        for entry in site.paths.windows.iter().chain(&site.paths.macos) {
            assert!(!entry.verified && entry.checked_at.is_none(), "{}", site.id);
        }
        assert!(!site.files.verified, "{}", site.id);
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
    let cases: [(&str, Edit, &str); 11] = [
        (
            "hud allowed without a date",
            |v| {
                let hud = &mut site_mut(v, "winamax")["hud"];
                hud["allowed"] = json!(true);
                hud["source"] = json!("https://example.org");
            },
            "winamax: hud.allowed is true without checkedAt",
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
                let hud = &mut site_mut(v, "winamax")["hud"];
                hud["allowed"] = json!(true);
                hud["checkedAt"] = json!("2026-10-13");
            },
            "winamax: hud.allowed is true without an https source",
        ),
        (
            "hud allowed with an http source",
            |v| {
                let hud = &mut site_mut(v, "winamax")["hud"];
                hud["allowed"] = json!(true);
                hud["source"] = json!("http://example.org");
                hud["checkedAt"] = json!("2026-10-13");
            },
            "winamax: hud.allowed is true without an https source",
        ),
        (
            "a network cannot allow a HUD",
            |v| {
                let hud = &mut site_mut(v, "ipoker")["hud"];
                hud["allowed"] = json!(true);
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
            |v| site_mut(v, "winamax")["tables"]["seatLayouts"] = json!({"11": "x"}),
            "winamax: tables.seatLayouts: \"11\" is not a table size 2-10",
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
        let site = site_mut(&mut remote, "pokerstars");
        site["hud"] = json!({
            "allowed": true,
            "source": "https://example.org/terms",
            "checkedAt": "2026-10-13",
            "notes": ""
        });
        site["files"]["notes"] = json!("corrected");
    }
    site_mut(&mut remote, "ggpoker")["hud"]["allowed"] = json!(false);
    let merged =
        load_remote(&shipped, &remote.to_string(), &REGISTRATION_ORDER).expect("valid remote");
    let pokerstars = merged.config.site("pokerstars").expect("pokerstars");
    assert_eq!(
        pokerstars.hud,
        shipped.site("pokerstars").expect("shipped").hud
    );
    assert_eq!(pokerstars.files.notes, "corrected");
    assert_eq!(
        merged.config.site("ggpoker").expect("ggpoker").hud.allowed,
        Some(false)
    );
    assert_eq!(
        merged.notes,
        [MergeNote::LooserHudIgnored {
            id: "pokerstars".to_owned(),
            shipped: None,
            remote: Some(true)
        }]
    );
    assert_eq!(validate(&merged.config, &REGISTRATION_ORDER), Vec::new());
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

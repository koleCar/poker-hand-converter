//! The Ongame, Entraction and Unibet halves of the TypeScript suite,
//! translated (docs/RAIL-PLAN.md R0.10d): the Ongame and Entraction parts of
//! `legacyNetworks.test.ts` (the MicroGaming ones are R0.9's, in
//! `xml_parsers.rs`) and its shared-namespace tests now that all three of its
//! rooms are ported, all of `unibetParser.test.ts` but the iPoker side of
//! the Unibet / iPoker boundary (R0.9), and the Entraction parts of
//! `phfHiLo.test.ts`.
//!
//! Both suites load their samples with `support/p4Corpus.ts`, which decodes
//! with `TextDecoder("utf-8")`: the UTF-8 BOM every Ongame and Entraction
//! sample opens with is dropped, and the Windows-1252 Unibet file reads with
//! U+FFFD (so this suite refuses it `lossy-encoding`, where the app - and the
//! goldens - decode it as Windows-1252); `phfHiLo`'s `sample()` decodes the
//! same way.
//!
//! Left out, and why: the replayer checks (`buildReplay`, not ported -
//! "replays without a negative stack" of all three rooms), `phfHiLo`'s
//! `analyzeAllIn` (R2.2). `p2Parsers`, `p2Xml`, `phfDetect`, `phfOmaha`,
//! `phfPositions` and `phfCoreGaps` have no Ongame, Entraction or Unibet
//! part beyond labels (`isHiLoLabel("Omaha Hi/Lo Fixed Limit")`, R0.5a) and
//! a hand-written Unibet-style tournament header read by the standard
//! reader (R0.6). One Rust test per TypeScript `it` (an `it.each` is one
//! loop), named after it.

mod psgg_support;

use std::sync::LazyLock;

use psgg_support::{STANDARD, root};
use rail_core::convert::ConversionResult;
use rail_core::detect::ConvertOptions;
use rail_core::parsers::builtin;
use rail_core::phf::serialize::{matches_at_line_start, parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, GameFormat, LimitType, PhfHand, Position, PotHalf, Street, Variant,
    contributions_from_actions, total_fees,
};
use rail_core::validate::validate_hand;
use regex::Regex;
use serde_json::{Value, json};

/* ----------------------------------------------------------------- corpus */

#[derive(Debug, Clone)]
struct SampleFile {
    name: String,
    relative_path: String,
    /// `new TextDecoder("utf-8").decode(bytes)`: a BOM dropped, invalid
    /// UTF-8 as U+FFFD.
    text: String,
    bytes: Vec<u8>,
}

fn walk(dir: &std::path::Path, prefix: &str, out: &mut Vec<SampleFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let path = dir.join(&name);
        if path.is_dir() {
            walk(&path, &format!("{prefix}/{name}"), out);
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".txt") || lower.ends_with(".xml")) {
            continue;
        }
        let bytes = std::fs::read(&path).expect("read sample");
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_owned();
        out.push(SampleFile {
            relative_path: format!("{prefix}/{name}"),
            name,
            text,
            bytes,
        });
    }
}

/// `p4Corpus`'s `sampleFiles(site)`.
fn sample_files(site: &str) -> Vec<SampleFile> {
    let mut out = Vec::new();
    walk(
        &root().join("fixtures/samples").join(site),
        &format!("fixtures/samples/{site}"),
        &mut out,
    );
    out.retain(|file| !rail_core::js::trim(&file.text).is_empty());
    out
}

/// `otherSampleSites(exclude)`.
fn other_sample_sites(exclude: &[&str]) -> Vec<String> {
    let mut dirs: Vec<String> = std::fs::read_dir(root().join("fixtures/samples"))
        .expect("samples")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !exclude.contains(&name.as_str()))
        .collect();
    dirs.sort();
    dirs
}

/// `decodeCp1252(bytes)`.
fn decode_cp1252(bytes: &[u8]) -> String {
    const HIGH: [u32; 32] = [
        0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
        0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013,
        0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
    ];
    bytes
        .iter()
        .map(|&byte| {
            let code = if (0x80..=0x9f).contains(&byte) {
                HIGH[usize::from(byte - 0x80)]
            } else {
                u32::from(byte)
            };
            char::from_u32(code).expect("a Windows-1252 code point")
        })
        .collect()
}

fn convert_with(text: &str, filename: Option<&str>, cash_only: bool) -> ConversionResult {
    rail_core::convert_any(
        text,
        &ConvertOptions {
            source_filename: filename.map(str::to_owned),
            cash_only,
            ..ConvertOptions::default()
        },
    )
    .expect("convertAny threw")
}

fn convert(text: &str, filename: Option<&str>) -> ConversionResult {
    convert_with(text, filename, false)
}

fn hands(result: &ConversionResult) -> Vec<&PhfHand> {
    result.hands.iter().map(|h| &h.hand).collect()
}

fn reasons(result: &ConversionResult) -> Vec<String> {
    result
        .failures
        .iter()
        .map(|f| f.reason.as_str().to_owned())
        .collect()
}

fn ranked(text: &str) -> Vec<(&'static str, u32)> {
    builtin()
        .detect_site(text)
        .iter()
        .map(|c| (c.parser.id(), c.permille))
        .collect()
}

fn ids(text: &str) -> Vec<&'static str> {
    ranked(text).into_iter().map(|c| c.0).collect()
}

fn error_codes(hand: &PhfHand) -> Vec<String> {
    validate_hand(hand)
        .expect("validateHand threw")
        .errors()
        .map(|p| p.code.clone())
        .collect()
}

fn halves(hand: &PhfHand) -> Vec<(String, i64, Option<PotHalf>)> {
    hand.results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount, w.half))
        .collect()
}

/// The `actions` projection of both suites' `semantics`; `legacyNetworks`
/// adds `half`.
fn action_semantics(value: &Value, with_half: bool) -> Vec<Value> {
    value["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|action| {
            let mut out = json!({
                "street": action["street"],
                "player": action["player"],
                "type": action["type"],
                "amount": action["amount"],
                "streetTotal": action["streetTotal"],
                "allIn": action["allIn"],
                "cards": action.get("cards").cloned().unwrap_or(Value::Null),
                "potName": action.get("potName").cloned().unwrap_or(Value::Null),
            });
            if with_half {
                out["half"] = action.get("half").cloned().unwrap_or(Value::Null);
            }
            out
        })
        .collect()
}

/// `legacyNetworks`' `semantics(hand)`.
fn legacy_semantics(hand: &PhfHand) -> Value {
    let value = serde_json::to_value(hand).expect("json");
    json!({
        "handId": value["meta"]["handId"],
        "playedAt": value["playedAt"],
        "game": value["game"],
        "table": value["table"],
        "players": value["players"],
        "board": value["board"],
        "results": value["results"],
        "textStyle": value["meta"]["textStyle"],
        "actions": action_semantics(&value, true),
    })
}

/// `unibetParser`'s `semantics(hand)`: `table.fastFold` nulled,
/// `tournament.prizePool` dropped (the GG-style text has no clause for
/// either).
fn unibet_semantics(hand: &PhfHand) -> Value {
    let value = serde_json::to_value(hand).expect("json");
    let mut table = value["table"].clone();
    table["fastFold"] = Value::Null;
    let tournament = match value.get("tournament") {
        Some(Value::Object(fields)) => {
            let mut fields = fields.clone();
            fields.remove("prizePool");
            Value::Object(fields)
        }
        _ => Value::Null,
    };
    json!({
        "handId": value["meta"]["handId"],
        "playedAt": value["playedAt"],
        "game": value["game"],
        "table": table,
        "tournament": tournament,
        "players": value["players"],
        "board": value["board"],
        "results": value["results"],
        "textStyle": value["meta"]["textStyle"],
        "actions": action_semantics(&value, false),
    })
}

/// "conserves chips in every hand", both suites.
fn conserves_chips(hand: &PhfHand, at: &str) {
    let contributed: i64 = contributions_from_actions(hand)
        .iter()
        .map(|(_, amount)| amount)
        .sum();
    assert_eq!(contributed, hand.results.total_pot, "{at} in");
    let paid: i64 = hand.results.winners.iter().map(|w| w.amount).sum();
    assert_eq!(
        paid + total_fees(&hand.results.fees),
        hand.results.total_pot,
        "{at} out"
    );
    assert!(hand.results.fees.rake >= 0, "{at} rake");
    let mut stacks: Vec<(String, i64)> = hand
        .players
        .iter()
        .map(|p| (p.name.clone(), p.starting_stack))
        .collect();
    for action in &hand.actions {
        if action.kind == ActionType::Collect || action.amount == 0 {
            continue;
        }
        let entry = if let Some(i) = stacks.iter().position(|(name, _)| *name == action.player) {
            &mut stacks[i]
        } else {
            stacks.push((action.player.clone(), 0));
            stacks.last_mut().expect("pushed")
        };
        entry.1 -= action.amount;
        assert!(
            entry.1 >= 0,
            "{at} {} after {:?}",
            action.player,
            action.raw_line
        );
    }
}

/// "round-trips through standard text", both suites.
fn round_trips(hand: &PhfHand, semantics: fn(&PhfHand) -> Value) {
    let text = to_standard_text(hand);
    let first = text.lines().next().unwrap_or("");
    let reparsed = parse_standard_hand(&text, &STANDARD)
        .expect("reader threw")
        .unwrap_or_else(|| panic!("{first}"));
    assert!(
        reparsed.meta.warnings.is_empty(),
        "{first}: {:?}",
        reparsed.meta.warnings
    );
    assert_eq!(to_standard_text(&reparsed), text);
    assert_eq!(
        semantics(&reparsed),
        semantics(hand),
        "{}",
        hand.meta.hand_id
    );
}

/* ============================================== legacyNetworks.test.ts */

/// A room of `SITES`.
struct Site {
    id: &'static str,
    prefix: &'static str,
    variants: &'static [Variant],
    hi_lo: &'static [Variant],
}

const ONGAME: Site = Site {
    id: "ongame",
    prefix: "OG-",
    variants: &[Variant::Holdem, Variant::Omaha],
    // The one hi/lo fixture never splits a pot; see `ONGAME_VARIANTS`.
    hi_lo: &[],
};

const ENTRACTION: Site = Site {
    id: "entraction",
    prefix: "ENT-",
    variants: &[Variant::Holdem, Variant::Omaha, Variant::Omaha5],
    hi_lo: &[Variant::Omaha],
};

/// The rooms' dialects, as signatures over the text (not the parsers'
/// `detect`).
static ONGAME_DIALECT: LazyLock<Regex> =
    rail_core::js_regex_lazy!(r"^\*{5}\s*History for hand\s", "");
static ENTRACTION_DIALECT: LazyLock<Regex> =
    rail_core::js_regex_lazy!(r#"^Game\s#\s*\d+\s+-\s.*-\s+Table\s+""#, "");
static MG_DIALECT: LazyLock<Regex> =
    rail_core::js_regex_lazy!(r#"<Game\s+hhversion="\d+"\s+id="\d+""#, "i");

const OWN_DIRS: [&str; 3] = ["ongame", "entraction", "microgaming"];

/// `dialectOf(file)`, in `SITES` order.
fn dialect_of(file: &SampleFile) -> Option<&'static str> {
    if matches_at_line_start(&ONGAME_DIALECT, &file.text) {
        Some("ongame")
    } else if matches_at_line_start(&ENTRACTION_DIALECT, &file.text) {
        Some("entraction")
    } else if MG_DIALECT.is_match(&file.text) {
        Some("microgaming")
    } else {
        None
    }
}

/// `ALL_FILES`.
fn all_files() -> Vec<SampleFile> {
    OWN_DIRS.iter().flat_map(|dir| sample_files(dir)).collect()
}

/// `siteFiles(site)`.
fn site_files(site: &Site) -> Vec<SampleFile> {
    all_files()
        .into_iter()
        .filter(|file| dialect_of(file) == Some(site.id))
        .collect()
}

/// `handsOf(dir, name)`.
fn hands_of(dir: &str, name: &str) -> Vec<PhfHand> {
    let file = sample_files(dir)
        .into_iter()
        .find(|entry| entry.name.contains(name))
        .unwrap_or_else(|| panic!("No {dir} fixture matching \"{name}\""));
    convert(&file.text, Some(&file.name))
        .hands
        .into_iter()
        .map(|converted| converted.hand)
        .collect()
}

/// `ALLOWED_REASONS` of `legacyNetworks.test.ts`.
const LEGACY_ALLOWED_REASONS: [&str; 14] = [
    "unsupported-variant",
    "unsupported-hi-lo",
    "hi-lo-payout-contradiction",
    "tournament-unsupported",
    "play-money",
    "no-winner",
    "no-header",
    "no-players",
    "inconsistent-pot",
    "unseated-actor",
    "board-size",
    "too-few-players",
    "malformed-xml",
    "lossy-encoding",
];

fn finds_the_corpus(site: &Site) {
    assert!(site_files(site).len() > 8, "{}", site.id);
}

fn is_attributed_to_its_own_parser(site: &Site) {
    for file in site_files(site) {
        let ranking = ranked(&file.text);
        assert_eq!(
            ranking.first().map(|c| c.0),
            Some(site.id),
            "{}",
            file.relative_path
        );
        assert!(ranking.first().is_some_and(|c| c.1 >= 900));
        // Detection is a shared namespace: nobody else may even be a
        // candidate.
        assert_eq!(ids(&file.text), [site.id], "{}", file.relative_path);
    }
}

fn converts_or_refuses_with_a_reason(site: &Site) {
    for file in site_files(site) {
        let result = convert(&file.text, Some(&file.name));
        assert!(result.stats.total > 0);
        assert_eq!(
            result.stats.total,
            result.stats.converted + result.stats.failed
        );
        for failure in &result.failures {
            assert!(
                LEGACY_ALLOWED_REASONS.contains(&failure.reason.as_str()),
                "{}: {}",
                failure.reason,
                failure.message
            );
            assert_eq!(failure.detected_site.as_deref(), Some(site.id));
            assert!(failure.message.chars().count() > 10);
            assert!(!failure.raw_text.is_empty());
        }
        for hand in hands(&result) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            assert!(
                hand.meta.warnings.is_empty(),
                "{at}: {:?}",
                hand.meta.warnings
            );
            assert!(error_codes(hand).is_empty(), "{at}");
            assert_eq!(hand.meta.site_id, site.id);
            assert!(site.variants.contains(&hand.game.variant), "{at}");
            if hand.game.hi_lo {
                assert!(site.hi_lo.contains(&hand.game.variant), "{at}");
            }
            assert!(!hand.meta.raw_text.contains("Poker Hand #"), "{at}");
            assert_eq!(hand.meta.hand_key, hand.meta.hand_id);
            assert!(
                hand.meta.hand_id.starts_with(site.prefix),
                "{}",
                hand.meta.hand_id
            );
        }
    }
}

fn conserves_chips_in_every_hand(site: &Site) {
    for file in site_files(site) {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            conserves_chips(hand, &format!("{} {}", file.name, hand.meta.hand_id));
        }
    }
}

fn round_trips_through_standard_text(site: &Site) {
    for file in site_files(site) {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            round_trips(hand, legacy_semantics);
        }
    }
}

#[test]
fn ongame_finds_the_corpus() {
    finds_the_corpus(&ONGAME);
}

#[test]
fn ongame_every_file_is_attributed_to_its_own_parser() {
    is_attributed_to_its_own_parser(&ONGAME);
}

#[test]
fn ongame_every_file_converts_or_refuses_with_a_reason() {
    converts_or_refuses_with_a_reason(&ONGAME);
}

#[test]
fn ongame_every_file_conserves_chips_in_every_hand() {
    conserves_chips_in_every_hand(&ONGAME);
}

#[test]
fn ongame_every_file_round_trips_through_standard_text() {
    round_trips_through_standard_text(&ONGAME);
}

#[test]
fn entraction_finds_the_corpus() {
    finds_the_corpus(&ENTRACTION);
}

#[test]
fn entraction_every_file_is_attributed_to_its_own_parser() {
    is_attributed_to_its_own_parser(&ENTRACTION);
}

#[test]
fn entraction_every_file_converts_or_refuses_with_a_reason() {
    converts_or_refuses_with_a_reason(&ENTRACTION);
}

#[test]
fn entraction_every_file_conserves_chips_in_every_hand() {
    conserves_chips_in_every_hand(&ENTRACTION);
}

#[test]
fn entraction_every_file_round_trips_through_standard_text() {
    round_trips_through_standard_text(&ENTRACTION);
}

/* ------------------------------------------------------ Ongame specifics */

#[test]
fn reads_raises_x_to_y_as_chips_pushed_then_street_total() {
    let hand = &hands_of("ongame", "06-allin-showdown")[0];
    let raise = hand
        .actions
        .iter()
        .find(|a| a.player == "kliketiklok" && a.kind == ActionType::Raise)
        .expect("the raise");
    assert_eq!(raise.street_total, 1050);
    assert_eq!(raise.amount, 1000);
}

#[test]
fn treats_main_pot_as_already_net_of_the_uncalled_bet() {
    let hand = &hands_of("ongame", "06-allin-showdown")[0];
    assert_eq!(hand.results.total_pot, 22982);
    assert_eq!(hand.results.fees.rake, 300);
    let returned = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(returned.player, "fyabcf");
    assert_eq!(returned.amount, -12324);
    assert_eq!(
        hand.results
            .players
            .iter()
            .find(|r| r.player == "fyabcf")
            .map(|r| r.net),
        Some(11391)
    );
}

#[test]
fn puts_the_hand_on_the_utc_line_from_its_stated_timezone() {
    let hand = &hands_of("ongame", "06-allin-showdown")[0];
    assert_eq!(hand.played_at.as_deref(), Some("2014-01-06T00:08:00.000Z"));
}

#[test]
fn reads_a_name_that_looks_like_a_street_separator() {
    let hand = &hands_of("ongame", "07-name-with-dashes")[0];
    assert!(hand.players.iter().any(|p| p.name == "---Cockatrice---"));
    assert!(hand.meta.warnings.is_empty());
}

#[test]
fn splits_a_concatenated_session_into_every_hand_it_holds() {
    let hands = hands_of("ongame", "12-multiple-hands-concatenated");
    assert_eq!(hands.len(), 10);
    let distinct: std::collections::HashSet<&str> =
        hands.iter().map(|h| h.meta.hand_id.as_str()).collect();
    assert_eq!(distinct.len(), 10);
}

/* -------------------------------------------------- Entraction specifics */

#[test]
fn reads_every_amount_as_an_increment() {
    let hand = &hands_of("entraction", "01-basic-hand-nlhe")[0];
    let river: Vec<_> = hand
        .actions
        .iter()
        .filter(|a| a.street == Street::River)
        .collect();
    assert_eq!(river.last().map(|a| a.street_total), Some(1300));
    assert_eq!(hand.results.total_pot, 2800);
    assert_eq!(hand.results.fees.rake, 75);
}

#[test]
fn agrees_with_the_payback_line_on_the_uncalled_bet() {
    let hand = &hands_of("entraction", "09-heads-up")[0];
    let returned = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(returned.player, "TreeTurtle");
    assert_eq!(returned.amount, -1500);
    assert!(hand.meta.warnings.is_empty());
}

#[test]
fn takes_only_the_new_cards_off_a_cumulative_board_line() {
    let hand = &hands_of("entraction", "01-basic-hand-nlhe")[0];
    let runout = &hand.board.runouts[0];
    assert_eq!(
        runout.flop.as_deref(),
        Some(&["Ah".to_owned(), "6c".to_owned(), "Jd".to_owned()][..])
    );
    assert_eq!(runout.turn.as_deref(), Some("3c"));
    assert_eq!(runout.river.as_deref(), Some("9s"));
}

#[test]
fn applies_the_stated_gmt_offset() {
    let hand = &hands_of("entraction", "01-basic-hand-nlhe")[0];
    assert_eq!(hand.played_at.as_deref(), Some("2012-05-31T07:56:27.000Z"));
}

#[test]
fn puts_the_button_on_the_small_blind_heads_up() {
    let hand = &hands_of("entraction", "09-heads-up")[0];
    assert_eq!(hand.table.button_seat, Some(2));
    let button = hand.players.iter().find(|p| p.seat == 2).expect("seat 2");
    assert_eq!(button.position, Some(Position::Sb));
}

/* ------------------------------------ detection is a shared namespace */

/// "no legacy-network parser claims a %s sample", all three rooms.
#[test]
fn no_legacy_network_parser_claims_another_rooms_sample() {
    let mut claims = Vec::new();
    for dir in other_sample_sites(&OWN_DIRS) {
        for file in sample_files(&dir) {
            for id in ids(&file.text) {
                if ["ongame", "entraction", "microgaming"].contains(&id) {
                    claims.push(format!("{id} claims {}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

/// "goes by the text when a sample is filed under the wrong room".
#[test]
fn goes_by_the_text_when_a_sample_is_filed_under_the_wrong_room() {
    for file in all_files() {
        let dialect = dialect_of(&file);
        assert!(
            dialect.is_some(),
            "{} matches no known dialect",
            file.relative_path
        );
        assert_eq!(
            ids(&file.text).first().copied(),
            dialect,
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn keeps_entraction_and_unibet_apart_though_both_open_with_game_hash() {
    let entraction =
        "Game # 2646539198 - Texas Hold'em No Limit EUR 0.25/0.50 - Table \"Burguillos\"";
    let unibet = "Game #1463192545: Table \u{20ac}1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - \
                  13:22:50 2021/04/04";
    assert_eq!(ids(entraction), ["entraction"]);
    assert_eq!(ids(unibet), ["unibet"]);
}

/* =============================================== unibetParser.test.ts */

const UNIBET_ALLOWED_REASONS: [&str; 10] = [
    "unsupported-variant",
    "lossy-encoding",
    "tournament-summary",
    "no-winner",
    "inconsistent-pot",
    "board-size",
    "too-few-players",
    "no-players",
    "no-currency",
    "cashout",
];

/// `UNIBET_DIALECT` (`m`).
static UNIBET_DIALECT: LazyLock<Regex> = rail_core::js_regex_lazy!(
    r"^(?:Unibet\s+(?:Hand|Tournament)\s+#|Game\s+#\d+:\s+Table\s+\S+\s+(?:PL|NL|FL)\s+-)",
    ""
);

fn unibet_files() -> Vec<SampleFile> {
    sample_files("unibet")
}

/// `fileNamed(part)`.
fn file_named(part: &str) -> SampleFile {
    unibet_files()
        .into_iter()
        .find(|entry| entry.name.contains(part))
        .unwrap_or_else(|| panic!("No Unibet fixture matching \"{part}\""))
}

#[test]
fn unibet_finds_the_corpus() {
    assert!(unibet_files().len() >= 5);
}

#[test]
fn unibet_every_file_is_unibet_text_by_its_text_and_not_its_folder() {
    for file in unibet_files() {
        assert!(
            matches_at_line_start(&UNIBET_DIALECT, &file.text),
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn unibet_every_file_is_attributed_to_the_unibet_parser() {
    for file in unibet_files() {
        let ranking = ranked(&file.text);
        assert_eq!(ranking.first().map(|c| c.0), Some("unibet"));
        assert!(ranking.first().is_some_and(|c| c.1 >= 900));
        assert_eq!(ids(&file.text), ["unibet"], "{}", file.relative_path);
    }
}

#[test]
fn unibet_every_file_converts_or_refuses_with_a_reason() {
    for file in unibet_files() {
        let result = convert(&file.text, Some(&file.name));
        assert!(result.stats.total > 0);
        assert_eq!(
            result.stats.total,
            result.stats.converted + result.stats.failed
        );
        for failure in &result.failures {
            assert!(
                UNIBET_ALLOWED_REASONS.contains(&failure.reason.as_str()),
                "{}: {}",
                failure.reason,
                failure.message
            );
            assert_eq!(failure.detected_site.as_deref(), Some("unibet"));
            assert!(failure.message.chars().count() > 10);
            assert!(!failure.raw_text.is_empty());
        }
        for hand in hands(&result) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            assert!(
                hand.meta.warnings.is_empty(),
                "{at}: {:?}",
                hand.meta.warnings
            );
            assert!(error_codes(hand).is_empty(), "{at}");
            assert_eq!(hand.meta.site_id, "unibet");
            assert!(!hand.meta.raw_text.is_empty());
            assert!(
                [Variant::Holdem, Variant::Omaha].contains(&hand.game.variant),
                "{at}"
            );
            assert!(!hand.meta.raw_text.contains("Poker Hand #"), "{at}");
            assert_eq!(hand.meta.hand_key, hand.meta.hand_id);
            assert!(
                hand.meta.hand_id.starts_with("UB-"),
                "{}",
                hand.meta.hand_id
            );
        }
    }
}

#[test]
fn unibet_every_file_conserves_chips_in_every_hand() {
    for file in unibet_files() {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            conserves_chips(hand, &format!("{} {}", file.name, hand.meta.hand_id));
        }
    }
}

#[test]
fn unibet_every_file_round_trips_through_standard_text() {
    for file in unibet_files() {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            round_trips(hand, unibet_semantics);
        }
    }
}

/* ----------------------------------------------- header generations */

#[test]
fn reads_the_2021_game_table_header() {
    let file = file_named("02-cash-nlhe-banzai-2021-utf8");
    let result = convert(&file.text, Some(&file.name));
    assert_eq!(result.hands.len(), 1);
    let hand = &result.hands[0].hand;

    assert_eq!(hand.meta.hand_id, "UB-1463192545");
    assert_eq!(hand.game.format, GameFormat::Cash);
    assert_eq!(hand.game.unit.code, "EUR");
    assert_eq!(hand.game.small_blind, 5);
    assert_eq!(hand.game.big_blind, 10);
    assert_eq!(hand.table.name.as_deref(), Some("\u{20ac}1 NL"));
    assert_eq!(hand.table.max_seats, 6);
    assert_eq!(hand.table.button_seat, Some(6));
    assert_eq!(hand.played_at.as_deref(), Some("2021-04-04T13:22:50.000Z"));

    let raise = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Raise)
        .expect("the raise");
    assert_eq!(raise.street_total, 95);
    assert!(raise.all_in);

    assert_eq!(hand.results.total_pot, 25);
    let returned = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(returned.player, "Hero");
    assert_eq!(returned.amount, -85);

    assert_eq!(hand.table.fast_fold, Some(Some("Banzai".to_owned())));
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.is_hero)
            .map(|p| p.name.as_str()),
        Some("Hero")
    );
    assert_eq!(
        hand.results
            .players
            .iter()
            .find(|r| r.player == "Hero")
            .map(|r| r.net),
        Some(15)
    );
}

#[test]
fn reads_the_2026_unibet_hand_header_and_its_separate_table_line() {
    let file = file_named("04-tournament-nlhe-2026");
    let result = convert(&file.text, Some(&file.name));
    assert_eq!(result.hands.len(), 1);
    let hand = &result.hands[0].hand;

    assert_eq!(hand.meta.hand_id, "UB-1558006464");
    assert_eq!(hand.table.name.as_deref(), Some("86116111"));
    assert_eq!(hand.table.max_seats, 3);
    assert_eq!(hand.played_at.as_deref(), Some("2026-06-05T21:59:56.000Z"));
    assert_eq!(hand.game.unit.code, "CHIPS");
    assert_eq!(hand.game.format, GameFormat::Tournament);

    let tournament = hand.tournament.as_ref().expect("a tournament");
    assert_eq!(tournament.id, "85614762");
    assert_eq!(tournament.buy_in, 93);
    assert_eq!(tournament.fee, 7);
    assert_eq!(tournament.buy_in_unit.code, "EUR");
    assert_eq!(tournament.level_small_blind, 25);
    assert_eq!(tournament.level_big_blind, 50);
    assert_eq!(tournament.level_label, None);
    assert_eq!(tournament.level_number, None);
    assert!(!to_standard_text(hand).contains("Level"));
    assert_eq!(tournament.prize_pool, Some(400));

    let hero = hand.players.iter().find(|p| p.is_hero).expect("the hero");
    assert_eq!(hero.name, "hero");
    assert!(hand.meta.raw_text.contains("hero[Unibet_28204e083c0fb55a]"));

    let runout = &hand.board.runouts[0];
    assert_eq!(
        runout.flop.as_deref(),
        Some(&["4s".to_owned(), "Tc".to_owned(), "8d".to_owned()][..])
    );
    assert_eq!(runout.turn.as_deref(), Some("Ac"));
    assert_eq!(runout.river.as_deref(), Some("9d"));

    assert_eq!(hand.results.total_pot, 300);
    assert!(hand.results.went_to_showdown);
}

#[test]
fn reads_its_omaha_and_still_refuses_the_tournament_summary_export_by_name() {
    let plo = file_named("03-cash-plo-2026");
    let result = convert(&plo.text, Some(&plo.name));
    assert_eq!(result.hands.len(), 1);
    let hand = &result.hands[0].hand;
    assert_eq!(hand.game.variant, Variant::Omaha);
    assert_eq!(hand.game.limit, LimitType::Pl);
    assert!(!hand.game.hi_lo);
    assert!(hand.meta.warnings.is_empty());
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.is_hero)
            .map(|p| p.hole_cards.len()),
        Some(4)
    );
    assert_eq!(reasons(&result), ["no-winner"]);

    let summary = file_named("05-tournament-summary");
    let result = convert(&summary.text, Some(&summary.name));
    assert!(result.hands.is_empty());
    assert_eq!(reasons(&result), ["tournament-summary"]);
}

#[test]
fn skips_a_tournament_hand_in_cash_only_mode() {
    let file = file_named("04-tournament-nlhe-2026");
    let result = convert_with(&file.text, Some(&file.name), true);
    assert!(result.hands.is_empty());
    assert_eq!(
        reasons(&result).first().map(String::as_str),
        Some("tournament-in-cash-mode")
    );
}

/* --------------------------------------------------------- encoding */

#[test]
fn is_the_same_hand_in_both_byte_encodings() {
    let cp1252 = file_named("01-cash-nlhe-banzai-2021-cp1252");
    let utf8 = file_named("02-cash-nlhe-banzai-2021-utf8");
    assert!(decode_cp1252(&cp1252.bytes).contains("Game #1463192545"));
    assert!(utf8.text.contains("Game #1463192545"));
    assert_ne!(cp1252.bytes, utf8.bytes);
}

#[test]
fn produces_identical_phf_from_windows_1252_and_utf8_once_decoded_correctly() {
    let cp1252 = file_named("01-cash-nlhe-banzai-2021-cp1252");
    let utf8 = file_named("02-cash-nlhe-banzai-2021-utf8");
    let from_cp = convert(&decode_cp1252(&cp1252.bytes), Some(&utf8.name));
    let from_u8 = convert(&utf8.text, Some(&utf8.name));
    assert_eq!(from_cp.hands.len(), 1);
    assert_eq!(from_u8.hands.len(), 1);
    assert_eq!(from_cp.hands[0].hand.game.unit.code, "EUR");
    assert_eq!(
        unibet_semantics(&from_cp.hands[0].hand),
        unibet_semantics(&from_u8.hands[0].hand)
    );
}

#[test]
fn refuses_a_windows_1252_export_that_was_decoded_as_utf8() {
    let cp1252 = file_named("01-cash-nlhe-banzai-2021-cp1252");
    assert!(cp1252.text.contains('\u{FFFD}'));
    let result = convert(&cp1252.text, Some(&cp1252.name));
    assert!(result.hands.is_empty());
    assert_eq!(
        reasons(&result).first().map(String::as_str),
        Some("lossy-encoding")
    );
    assert!(result.failures[0].message.contains("Windows-1252"));
}

#[test]
fn refuses_a_mojibake_player_name_for_the_same_reason() {
    let utf8 = file_named("02-cash-nlhe-banzai-2021-utf8");
    let mangled = utf8.text.replacen("Player2", "Pl\u{FFFD}yer2", 1);
    let result = convert(&mangled, Some("mangled.txt"));
    assert!(result.hands.is_empty());
    assert_eq!(
        reasons(&result).first().map(String::as_str),
        Some("lossy-encoding")
    );
}

/* ------------------------------------------ the Unibet / iPoker boundary */

/// "scores zero on every iPoker sample, branded or not". (The other two
/// boundary tests are in `xml_parsers.rs`, R0.9; with `unibet` ported, the
/// "not among the candidates" half of the first is no longer trivial.)
#[test]
fn unibet_scores_zero_on_every_ipoker_sample() {
    let files = sample_files("ipoker");
    assert!(!files.is_empty());
    for file in files {
        assert!(
            !ids(&file.text).contains(&"unibet"),
            "{}",
            file.relative_path
        );
    }
}

/* ------------------------------------ detection is a shared namespace */

#[test]
fn the_unibet_parser_does_not_claim_another_rooms_sample() {
    let mut claims = Vec::new();
    for dir in other_sample_sites(&["unibet"]) {
        for file in sample_files(&dir) {
            for (id, permille) in ranked(&file.text) {
                if id == "unibet" {
                    claims.push(format!("{} @ {permille}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn does_not_claim_entraction_which_also_opens_every_hand_with_game_hash() {
    let entraction = [
        "Game # 2646539198 - Texas Hold'em No Limit EUR 0.25/0.50 - Table \"Burguillos\"",
        "",
        "Players(max 6):",
        "Pinokio1                    (EUR 50.25 in seat 3)",
    ]
    .join("\n");
    assert!(!ids(&entraction).contains(&"unibet"));
}

#[test]
fn does_not_claim_pokerstars_ggpoker_or_standard_text() {
    let foreign = [
        [
            "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
            "Table 'Aaltje II' 6-max Seat #2 is the button",
        ]
        .join("\n"),
        [
            "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
            "Table 'NLHPurple70' 6-max Seat #1 is the button",
        ]
        .join("\n"),
    ];
    for text in foreign {
        assert!(!ids(&text).contains(&"unibet"), "{text}");
    }
}

/* ====================================================== phfHiLo.test.ts */

/// `sample(relative)` of `phfHiLo`: UTF-8 with a BOM dropped.
fn sample(relative: &str) -> String {
    let bytes = std::fs::read(root().join("fixtures/samples").join(relative)).expect("sample");
    let text = String::from_utf8_lossy(&bytes).into_owned();
    text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_owned()
}

#[test]
fn refuses_a_payout_the_shown_cards_contradict() {
    // Entraction 07 pays the whole pot to a pair of queens while the other
    // shown hand holds 8-7-4-2-A: an edited sample.
    let result = convert(&sample("entraction/07-allin-showdown.txt"), None);
    assert!(result.hands.is_empty());
    assert_eq!(reasons(&result), ["hi-lo-payout-contradiction"]);
}

/// `every converted hi/lo fixture` for the three Entraction files; the
/// `analyzeAllIn` check is R2.2.
#[test]
fn every_converted_entraction_hi_lo_fixture_validates_balances_and_round_trips() {
    for file in [
        "entraction/06-fixed-limit-omaha-hilo.txt",
        "entraction/08-euro-table.txt",
        "entraction/12-omaha-hilo-showdown-split-pot.txt",
    ] {
        let result = convert(&sample(file), Some(file));
        assert!(result.failures.is_empty(), "{file}");
        assert!(!result.hands.is_empty(), "{file}");
        for converted in &result.hands {
            let subject = &converted.hand;
            let at = format!("{file} {}", subject.meta.hand_id);
            assert!(subject.game.hi_lo, "{at}");
            assert_eq!(subject.game.variant, Variant::Omaha, "{at}");
            let notes: Vec<&str> = subject
                .meta
                .warnings
                .iter()
                .map(|w| w.code.as_str())
                .filter(|code| *code != "streets-inferred")
                .collect();
            assert!(notes.is_empty(), "{at}: {notes:?}");
            let report = validate_hand(subject).expect("validateHand threw");
            assert_eq!(report.errors().count(), 0, "{at}");
            assert_eq!(
                report
                    .warnings()
                    .filter(|w| w.code.starts_with("hi-lo"))
                    .count(),
                0,
                "{at}"
            );
            let collects: Vec<Option<PotHalf>> = subject
                .actions
                .iter()
                .filter(|a| a.kind == ActionType::Collect)
                .map(|a| a.half)
                .collect();
            let winners: Vec<Option<PotHalf>> =
                subject.results.winners.iter().map(|w| w.half).collect();
            assert_eq!(winners, collects, "{at}");

            let text = to_standard_text(subject);
            let back = parse_standard_hand(&text, &STANDARD)
                .expect("reader threw")
                .expect("hand");
            assert!(back.meta.warnings.is_empty(), "{at}");
            assert!(back.game.hi_lo, "{at}");
            assert_eq!(halves(&back), halves(subject), "{at}");
            assert_eq!(to_standard_text(&back), text, "{at}");
        }
    }
}

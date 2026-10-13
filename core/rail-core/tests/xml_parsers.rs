//! The iPoker and MicroGaming halves of the TypeScript suite, translated
//! (docs/RAIL-PLAN.md R0.9): `p2Xml.test.ts` (its reader tests are unit
//! tests of `parsers::shared::p2_xml`; the corpus one is here), the iPoker
//! parts of `p2Parsers.test.ts`, the MicroGaming parts of
//! `legacyNetworks.test.ts`, the MicroGaming parts of `phfHiLo.test.ts`, and
//! the iPoker side of `unibetParser.test.ts`'s Unibet / iPoker boundary.
//!
//! Left out, and why: the replayer checks (`buildReplay`, not ported - "replays
//! without a negative stack" of both rooms, the replayer half of the jackpot
//! drop in `phfCoreGaps`), the all-in EV check of `phfHiLo` (`analyzeAllIn`,
//! R2.2), `p2Xml`'s `DOMParser` path (the browser's; Node - the reference -
//! has none, and that test is skipped there too, so "uses the scanner when
//! the host has no DOMParser" is all the port is), and the Ongame, Entraction
//! and Unibet parts (R0.10d, `p4_parsers.rs`). `phfDetect`, `phfOmaha` and
//! `phfPositions` have no iPoker or MicroGaming part beyond
//! `isHiLoLabel("Omaha H/L")`, which is parser-free (R0.5a). One Rust test per TypeScript `it` (an `it.each` is
//! one loop), named after it.

mod psgg_support;

use std::path::Path;
use std::sync::LazyLock;

use psgg_support::{STANDARD, root};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, SiteParser};
use rail_core::parsers::builtin;
use rail_core::parsers::ipoker::IPokerParser;
use rail_core::parsers::shared::p2_xml::{children, scan_xml};
use rail_core::phf::serialize::{matches_at_line_start, parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, ChipMovementAnchor, PhfHand, PotHalf, Variant, contributions_from_actions,
    house_into_pot, seat_out_of_pot, total_fees,
};
use rail_core::validate::validate_hand;
use regex::Regex;
use serde_json::{Value, json};

/* ----------------------------------------------------------------- corpus */

#[derive(Debug, Clone)]
struct SampleFile {
    name: String,
    relative_path: String,
    text: String,
}

/// `.txt` and `.xml` files below `dir`, sorted, recursively; read as
/// `readFileSync(path, "utf8")` (`p2Corpus`: a BOM kept) or as
/// `TextDecoder("utf-8")` (`p4Corpus`: a BOM dropped).
fn walk(dir: &Path, prefix: &str, keep_bom: bool, out: &mut Vec<SampleFile>) {
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
            walk(&path, &format!("{prefix}/{name}"), keep_bom, out);
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".txt") || lower.ends_with(".xml")) {
            continue;
        }
        let bytes = std::fs::read(&path).expect("read sample");
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let text = if keep_bom {
            text
        } else {
            text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_owned()
        };
        out.push(SampleFile {
            relative_path: format!("{prefix}/{name}"),
            name,
            text,
        });
    }
}

fn sample_files_with(site: &str, keep_bom: bool) -> Vec<SampleFile> {
    let mut out = Vec::new();
    walk(
        &root().join("fixtures/samples").join(site),
        &format!("fixtures/samples/{site}"),
        keep_bom,
        &mut out,
    );
    out.retain(|file| !rail_core::js::trim(&file.text).is_empty());
    out
}

/// `p2Corpus`'s `sampleFiles(site)`.
fn p2_sample_files(site: &str) -> Vec<SampleFile> {
    sample_files_with(site, true)
}

/// `p4Corpus`'s `sampleFiles(site)`.
fn p4_sample_files(site: &str) -> Vec<SampleFile> {
    sample_files_with(site, false)
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

fn convert(text: &str, filename: Option<&str>) -> ConversionResult {
    rail_core::convert_any(
        text,
        &ConvertOptions {
            source_filename: filename.map(str::to_owned),
            ..ConvertOptions::default()
        },
    )
    .expect("convertAny threw")
}

fn hands(result: &ConversionResult) -> Vec<&PhfHand> {
    result.hands.iter().map(|h| &h.hand).collect()
}

fn ranked(text: &str) -> Vec<(&'static str, u32)> {
    builtin()
        .detect_site(text)
        .iter()
        .map(|c| (c.parser.id(), c.permille))
        .collect()
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

/// The projection two semantically equal hands must agree on (`semantics`
/// of both suites; `legacyNetworks` adds `half`).
fn semantics(hand: &PhfHand) -> Value {
    let value = serde_json::to_value(hand).expect("json");
    let actions: Vec<Value> = value["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|action| {
            json!({
                "street": action["street"],
                "player": action["player"],
                "type": action["type"],
                "amount": action["amount"],
                "streetTotal": action["streetTotal"],
                "allIn": action["allIn"],
                "cards": action.get("cards").cloned().unwrap_or(Value::Null),
                "potName": action.get("potName").cloned().unwrap_or(Value::Null),
                "half": action.get("half").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    json!({
        "handId": value["meta"]["handId"],
        "playedAt": value["playedAt"],
        "game": value["game"],
        "table": value["table"],
        "players": value["players"],
        "board": value["board"],
        "results": value["results"],
        "textStyle": value["meta"]["textStyle"],
        "actions": actions,
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
fn round_trips(hand: &PhfHand) {
    let text = to_standard_text(hand);
    let first = text.lines().next().unwrap_or("");
    let reparsed = parse_standard_hand(&text, &STANDARD)
        .expect("reader threw")
        .unwrap_or_else(|| panic!("{first}"));
    assert!(reparsed.meta.warnings.is_empty(), "{first}");
    assert_eq!(to_standard_text(&reparsed), text);
    assert_eq!(
        semantics(&reparsed),
        semantics(hand),
        "{}",
        hand.meta.hand_id
    );
}

/* ====================================================== p2Xml.test.ts */

static SESSION: LazyLock<Regex> = rail_core::js_regex_lazy!(r"<session\b", "i");

/// `scanXml` "reads every hand in the iPoker corpus": every `<session>` of
/// every file is a tree with a `<game>`.
#[test]
fn the_scanner_reads_every_hand_in_the_ipoker_corpus() {
    let files = p2_sample_files("ipoker");
    assert!(files.len() > 10);
    for file in &files {
        let starts: Vec<usize> = SESSION.find_iter(&file.text).map(|m| m.start()).collect();
        let mut cuts: Vec<usize> = starts.into_iter().filter(|start| *start > 0).collect();
        cuts.insert(0, 0);
        cuts.push(file.text.len());
        for pair in cuts.windows(2) {
            let session = &file.text[pair[0]..pair[1]];
            if !SESSION.is_match(session) {
                continue;
            }
            let root = scan_xml(session)
                .expect("no throw")
                .root
                .unwrap_or_else(|| panic!("{}", file.relative_path));
            assert_eq!(root.tag, "session");
            assert!(
                !children(Some(&root), "game").is_empty(),
                "{}",
                file.relative_path
            );
        }
    }
}

/* ==================================================== p2Parsers.test.ts */

/// `ALLOWED_REASONS` of `p2Parsers.test.ts`.
const P2_ALLOWED_REASONS: [&str; 9] = [
    "unsupported-variant",
    "unsupported-hi-lo",
    "unsupported-locale",
    "truncated-hand",
    "no-winner",
    "inconsistent-pot",
    "unseated-actor",
    "board-size",
    "too-few-players",
];

/// `UNLOCKED_VARIANTS`.
const UNLOCKED_VARIANTS: [Variant; 4] = [
    Variant::Holdem,
    Variant::Omaha,
    Variant::Omaha5,
    Variant::Omaha6,
];

#[test]
fn ipoker_finds_the_corpus() {
    assert!(p2_sample_files("ipoker").len() > 10);
}

#[test]
fn ipoker_every_file_is_attributed_to_its_own_parser() {
    for file in p2_sample_files("ipoker") {
        let top = ranked(&file.text).first().copied();
        assert_eq!(top.map(|t| t.0), Some("ipoker"), "{}", file.relative_path);
        assert!(top.is_some_and(|t| t.1 >= 900), "{}", file.relative_path);
    }
}

#[test]
fn ipoker_every_file_converts_or_refuses_with_a_reason() {
    for file in p2_sample_files("ipoker") {
        let result = convert(&file.text, Some(&file.name));
        assert!(result.stats.total > 0, "{}", file.relative_path);
        assert_eq!(
            result.stats.total,
            result.stats.converted + result.stats.failed
        );
        for failure in &result.failures {
            assert!(
                P2_ALLOWED_REASONS.contains(&failure.reason.as_str()),
                "{}: {}",
                failure.reason,
                failure.message
            );
            assert_eq!(failure.detected_site.as_deref(), Some("ipoker"));
            assert!(failure.message.chars().count() > 10);
        }
        for hand in hands(&result) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            assert!(
                hand.meta.warnings.is_empty(),
                "{at}: {:?}",
                hand.meta.warnings
            );
            assert!(error_codes(hand).is_empty(), "{at}");
            assert_eq!(hand.meta.site_id, "ipoker");
            assert!(!hand.meta.raw_text.is_empty());
            assert!(UNLOCKED_VARIANTS.contains(&hand.game.variant), "{at}");
            assert_ne!(hand.game.variant, Variant::Shortdeck, "{at}");
        }
    }
}

#[test]
fn ipoker_every_file_conserves_chips_in_every_hand() {
    for file in p2_sample_files("ipoker") {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            conserves_chips(hand, &format!("{} {}", file.name, hand.meta.hand_id));
        }
    }
}

#[test]
fn ipoker_every_file_round_trips_through_standard_text() {
    for file in p2_sample_files("ipoker") {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            round_trips(hand);
        }
    }
}

/// "hand keys": the iPoker part (`IPN-`), the first six files.
#[test]
fn ipoker_hand_keys_carry_the_room_prefix() {
    for file in p2_sample_files("ipoker").iter().take(6) {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            assert_eq!(hand.meta.hand_key, hand.meta.hand_id);
            assert!(
                hand.meta.hand_id.starts_with("IPN-"),
                "{}",
                hand.meta.hand_id
            );
        }
    }
}

const P2_SITES: [&str; 3] = ["888poker", "partypoker", "ipoker"];

/// "no 888poker/partypoker/iPoker parser claims a %s sample" - with iPoker
/// now ported, all three.
#[test]
fn no_888poker_partypoker_ipoker_parser_claims_another_rooms_sample() {
    let mut claims = Vec::new();
    for dir in other_sample_sites(&P2_SITES) {
        for file in p2_sample_files(&dir) {
            for (id, _) in ranked(&file.text) {
                if P2_SITES.contains(&id) {
                    claims.push(format!("{id} claims {}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn ipoker_does_not_claim_pokerstars_or_ggpoker_text() {
    let pokerstars = [
        "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
        "Table 'Aaltje II' 6-max Seat #2 is the button",
        "Seat 1: villain ($10 in chips)",
    ]
    .join("\n");
    let gg = [
        "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
        "Table 'NLHPurple70' 6-max Seat #1 is the button",
    ]
    .join("\n");
    for text in [pokerstars, gg] {
        for (id, _) in ranked(&text) {
            assert!(!P2_SITES.contains(&id), "{id}");
        }
    }
}

/* ================================================ unibetParser.test.ts */

/// "routes a Unibet-branded iPoker export to the iPoker parser" (the Unibet
/// half - `unibet` not among the candidates - is real since R0.10d).
#[test]
fn routes_a_unibet_branded_ipoker_export_to_the_ipoker_parser() {
    let holdem = rail_core::js::regex::js_regex(r"Holdem\s+(?:NL|PL|L)\b", "");
    let fixture = p2_sample_files("ipoker")
        .into_iter()
        .find(|file| holdem.is_match(&file.text))
        .expect("a Hold'em iPoker sample");
    let tablename = rail_core::js::regex::js_regex(r"<tablename>[^<]*<\/tablename>", "");
    let nickname = rail_core::js::regex::js_regex(r"<nickname>[^<]*<\/nickname>", "");
    let branded = tablename.replace(
        &fixture.text,
        "<tablename>Unibet Poker, 51069081</tablename>",
    );
    let branded = nickname.replace(&branded, "<nickname>unibet_hero</nickname>");
    assert!(branded.contains("Unibet"));
    let ids: Vec<&str> = ranked(&branded).into_iter().map(|c| c.0).collect();
    assert_eq!(ids.first(), Some(&"ipoker"));
    assert!(!ids.contains(&"unibet"));
}

/// "does not let the iPoker parser claim Unibet plain text".
#[test]
fn does_not_let_the_ipoker_parser_claim_unibet_plain_text() {
    let files = p4_sample_files("unibet");
    assert!(!files.is_empty());
    for file in files {
        for (id, _) in ranked(&file.text) {
            assert_ne!(id, "ipoker", "{}", file.relative_path);
        }
    }
}

/* ============================================== legacyNetworks.test.ts */

/// The MicroGaming dialect signature.
static MG_DIALECT: LazyLock<Regex> =
    rail_core::js_regex_lazy!(r#"<Game\s+hhversion="\d+"\s+id="\d+""#, "i");
/// The other two rooms' signatures (their tests are in `p4_parsers.rs`).
static ONGAME_DIALECT: LazyLock<Regex> =
    rail_core::js_regex_lazy!(r"^\*{5}\s*History for hand\s", "");
static ENTRACTION_DIALECT: LazyLock<Regex> =
    rail_core::js_regex_lazy!(r#"^Game\s#\s*\d+\s+-\s.*-\s+Table\s+""#, "");

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
    OWN_DIRS
        .iter()
        .flat_map(|dir| p4_sample_files(dir))
        .collect()
}

/// `siteFiles(microgaming)`.
fn microgaming_files() -> Vec<SampleFile> {
    all_files()
        .into_iter()
        .filter(|file| dialect_of(file) == Some("microgaming"))
        .collect()
}

/// `handsOf("microgaming", name)`.
fn microgaming_hands(name: &str) -> Vec<PhfHand> {
    let file = p4_sample_files("microgaming")
        .into_iter()
        .find(|entry| entry.name.contains(name))
        .unwrap_or_else(|| panic!("No microgaming fixture matching \"{name}\""));
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

#[test]
fn microgaming_finds_the_corpus() {
    assert!(microgaming_files().len() > 8);
}

#[test]
fn microgaming_every_file_is_attributed_to_its_own_parser() {
    for file in microgaming_files() {
        let ranking = ranked(&file.text);
        assert!(
            ranking.first().is_some_and(|c| c.1 >= 900),
            "{}",
            file.relative_path
        );
        // A shared namespace: nobody else may even be a candidate.
        let ids: Vec<&str> = ranking.iter().map(|c| c.0).collect();
        assert_eq!(ids, ["microgaming"], "{}", file.relative_path);
    }
}

#[test]
fn microgaming_every_file_converts_or_refuses_with_a_reason() {
    for file in microgaming_files() {
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
            assert_eq!(failure.detected_site.as_deref(), Some("microgaming"));
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
            assert_eq!(hand.meta.site_id, "microgaming");
            assert!(
                [Variant::Holdem, Variant::Omaha].contains(&hand.game.variant),
                "{at}"
            );
            if hand.game.hi_lo {
                assert_eq!(hand.game.variant, Variant::Omaha, "{at}");
            }
            // `meta.rawText` is the room's own text, not the normalized form.
            assert!(!hand.meta.raw_text.contains("Poker Hand #"), "{at}");
            assert_eq!(hand.meta.hand_key, hand.meta.hand_id);
            assert!(
                hand.meta.hand_id.starts_with("MG-"),
                "{}",
                hand.meta.hand_id
            );
        }
    }
}

#[test]
fn microgaming_every_file_conserves_chips_in_every_hand() {
    for file in microgaming_files() {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            conserves_chips(hand, &format!("{} {}", file.name, hand.meta.hand_id));
        }
    }
}

#[test]
fn microgaming_every_file_round_trips_through_standard_text() {
    for file in microgaming_files() {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            round_trips(hand);
        }
    }
}

#[test]
fn settles_an_all_in_return_out_of_the_winnings_not_into_the_rake() {
    let hand = &microgaming_hands("05-allin-showdown")[0];
    assert_eq!(hand.results.total_pot, 112);
    assert_eq!(hand.results.fees.rake, 10);
    let returned = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(returned.player, "MrJohnCarter");
    assert_eq!(returned.amount, -160);
    let winners: Vec<(&str, Option<u32>, i64, u32)> = hand
        .results
        .winners
        .iter()
        .map(|w| (w.player.as_str(), w.seat, w.amount, w.runout_index))
        .collect();
    assert_eq!(winners, [("jugins", Some(3), 102, 0)]);
}

#[test]
fn leaves_an_uncalled_bet_in_the_pot_when_the_room_prints_no_return() {
    let hand = &microgaming_hands("01-basic-hand-nlhe")[0];
    assert_eq!(hand.results.total_pot, 4);
    assert_eq!(hand.results.fees.rake, 0);
    assert_eq!(
        hand.actions
            .iter()
            .find(|a| a.kind == ActionType::Uncalled)
            .map(|a| a.amount),
        Some(-12)
    );
}

#[test]
fn records_the_badbeat_jackpot_drop_as_chips_leaving_the_table_not_as_a_fee() {
    let hand = &microgaming_hands("07-disconnected-badbeat-jackpot")[0];
    assert_eq!(hand.results.total_pot, 4700);
    assert_eq!(hand.results.fees.rake, 0);
    let drop = hand
        .chip_movements
        .iter()
        .flatten()
        .find(|m| m.kind == "bad-beat-drop")
        .expect("the drop");
    assert!(!drop.to_pot);
    assert_eq!(drop.from_seat, Some(8));
    assert_eq!(drop.from_player.as_deref(), Some("tuffgong"));
    assert_eq!(drop.amount, 2);
    assert_eq!(drop.raw, None);
    assert_eq!(drop.anchor, ChipMovementAnchor::BeforePostings);
    assert_eq!(seat_out_of_pot(hand, 8), 2);
    assert_eq!(house_into_pot(hand), 0);
}

#[test]
fn reads_a_disconnect_value_as_a_timeout_not_as_chips() {
    let hand = &microgaming_hands("07-disconnected-badbeat-jackpot")[0];
    assert!(!hand.actions.iter().any(|a| a.amount >= 30000));
}

#[test]
fn recovers_names_and_the_currency_from_their_base64_utf16_copies() {
    let hand = &microgaming_hands("01-basic-hand-nlhe")[0];
    assert_eq!(hand.game.unit.code, "EUR");
    assert!(hand.players.iter().any(|p| p.name == "DuckGhoul"));
    assert_eq!(
        hand.table.name.as_deref(),
        Some("Turbo: Micro NLHE 22 - €2 Max")
    );
}

#[test]
fn drops_a_seat_that_was_sitting_out_rather_than_shifting_the_ring() {
    let hand = &microgaming_hands("10-sitting-out")[0];
    for player in &hand.players {
        assert!(player.position.is_some(), "{}", player.name);
    }
}

/// "no legacy-network parser claims a %s sample" - the MicroGaming part
/// (all three rooms: `p4_parsers.rs`).
#[test]
fn no_microgaming_parser_claims_another_rooms_sample() {
    let mut claims = Vec::new();
    for dir in other_sample_sites(&OWN_DIRS) {
        for file in p4_sample_files(&dir) {
            for (id, _) in ranked(&file.text) {
                if id == "microgaming" {
                    claims.push(format!("{id} claims {}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

/// "goes by the text when a sample is filed under the wrong room": every file
/// of the three directories has a dialect; the MicroGaming ones go to
/// `microgaming` (all three rooms: `p4_parsers.rs`).
#[test]
fn goes_by_the_text_when_a_sample_is_filed_under_the_wrong_room() {
    for file in all_files() {
        let dialect = dialect_of(&file);
        assert!(
            dialect.is_some(),
            "{} matches no known dialect",
            file.relative_path
        );
        if dialect == Some("microgaming") {
            assert_eq!(
                ranked(&file.text).first().map(|c| c.0),
                Some("microgaming"),
                "{}",
                file.relative_path
            );
        }
    }
}

#[test]
fn keeps_the_xml_rooms_apart_by_their_root_element() {
    for dir in ["bossmedia", "merge", "ipoker"] {
        for file in p4_sample_files(dir) {
            for (id, _) in ranked(&file.text) {
                assert_ne!(id, "microgaming", "{}", file.relative_path);
            }
        }
    }
}

/// "networks deliberately left unimplemented": no ported parser claims a
/// Boss Media or Merge sample.
#[test]
fn leaves_bossmedia_and_merge_samples_unclaimed() {
    for dir in ["bossmedia", "merge"] {
        let files = p4_sample_files(dir);
        assert!(files.len() > 5, "{dir}");
        for file in files {
            assert!(ranked(&file.text).is_empty(), "{}", file.relative_path);
        }
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
fn does_not_trust_microgamings_lowhandwin_flag_which_marks_both_winners() {
    let file = "microgaming/04-pot-limit-omaha-hilo.txt";
    let mut result = convert(&sample(file), Some(file));
    assert!(result.failures.is_empty());
    assert_eq!(result.hands.len(), 1);
    let hand = result.hands.remove(0).hand;
    assert_eq!(
        halves(&hand),
        [
            ("theweman".to_owned(), 173, Some(PotHalf::Lo)),
            ("hoop".to_owned(), 173, Some(PotHalf::Hi)),
        ]
    );
}

/// `every converted hi/lo fixture` for the two MicroGaming files; the
/// `analyzeAllIn` check is R2.2.
#[test]
fn every_converted_microgaming_hi_lo_fixture_validates_balances_and_round_trips() {
    for file in [
        "microgaming/04-pot-limit-omaha-hilo.txt",
        "microgaming/09-omaha-hilo-showdown-split-pot.txt",
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

/* ------------------------------------------------------- Rust-only units */

/// Refusals the corpus does not reach keep the TypeScript's wording.
#[test]
fn refusals_keep_the_typescript_wording() {
    let refuse = |parser: &dyn SiteParser, text: &str| match psgg_support::parse(parser, text) {
        Err(rail_core::detect::ParseError::Skip(skip)) => {
            (skip.reason.as_str().to_owned(), skip.message)
        }
        other => panic!("expected a refusal, got {other:?}"),
    };
    let mg = rail_core::parsers::microgaming::MicroGamingParser;
    assert_eq!(
        refuse(&IPokerParser, "<session><general/></session>"),
        (
            "no-hands".to_owned(),
            "The session contains no <game> element.".to_owned()
        )
    );
    assert_eq!(
        refuse(&IPokerParser, "<session><game/></session>"),
        (
            "no-header".to_owned(),
            "The <game> element has no gamecode.".to_owned()
        )
    );
    assert_eq!(
        refuse(&IPokerParser, "<game/>"),
        (
            "malformed-xml".to_owned(),
            "The chunk is not a well-formed iPoker session.".to_owned()
        )
    );
    assert_eq!(
        refuse(
            &IPokerParser,
            "<session><general><gametype>Holdem NL $1/$2</gametype></general>\
             <game gamecode=\"1\"><general><players>\
             <player seat=\"1\" name=\"a\" chips=\"$1\"/><player seat=\"2\" name=\"b\" chips=\"$1\"/>\
             </players></general><round></round></game></session>"
        ),
        (
            "unknown-round".to_owned(),
            "Unknown <round no=\"undefined\">.".to_owned()
        )
    );
    assert_eq!(
        refuse(
            &mg,
            "<Game id=\"1\" gametype=\"Hold'em\" istournament=\"1\"/>"
        )
        .0,
        "tournament-unsupported"
    );
    assert_eq!(
        refuse(
            &mg,
            "<Game id=\"1\" gametype=\"Hold'em\"><Seats><Seat num=\"1\" alias=\"a\" \
             balance=\"1\"/></Seats><Gameplay><Action type=\"Win\"><Seat num=\"2\"/></Action>\
             </Gameplay></Game>"
        ),
        (
            "unseated-actor".to_owned(),
            "A <Win> names seat 2, which is not in <Seats>.".to_owned()
        )
    );
    assert_eq!(
        refuse(
            &mg,
            "<Game id=\"1\" gametype=\"Hold'em\"><Seats><Seat num=\"1\" alias=\"a\" \
             balance=\"1\"/></Seats><Gameplay><Action type=\"Call\"/></Gameplay></Game>"
        ),
        (
            "unseated-actor".to_owned(),
            "Action ? (Call) names seat undefined, which is not in <Seats>.".to_owned()
        )
    );
}

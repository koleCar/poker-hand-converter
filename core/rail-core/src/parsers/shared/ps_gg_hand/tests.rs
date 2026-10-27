//! The helpers and the draft of `ps-gg-hand.ts`. The draft's arithmetic is
//! held to the TypeScript over the corpus (`tests/golden_sites.rs`) and over
//! thousands of mutated hands (`tests/psgg_vectors.rs`); these are the unit
//! cases and the source check.

use super::*;
use crate::phf::money::{EUR, USD};

const SOURCE: &str =
    include_str!("../../../../../../web/src/lib/parsers/shared/ps-gg-hand.ts");

/// Every pattern above as the TypeScript writes it: `/literal/flags`, or the
/// body of a `String.raw` template.
const LITERALS: &[&str] = &[
    r"/¥|₩|Rs\.?\s?\d/",
    r"/\b(USD|EUR|GBP|CAD|AUD|NZD|CNY|NOK|SEK|DKK|PLN|RUB|INR|BRL)\b/",
    r"/\d\.\d0(?!\d)/",
    r"/\d\.\d(?!\d)/",
    r"/\d{4}[/-]\d{2}[/-]\d{2}[ T](\d{1,2}):\d{2}:\d{2}/",
    r"/(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/",
    r"/pot\s*limit|\bPL\b|\bPLO-?\d?\b/i",
    r"/no\s*limit|\bNL\b|\bNLO-?\d?\b/i",
    r"/\blimit\b/i",
    r"/^\d+$/",
    r"/^[IVXLCDM]+$/",
    r"/^Seat\s+\d+:\s*/",
    r"/^\((button|small blind|big blind)\)\s*/i",
    r"/(?:showed|mucked)\s+\[([^\]]*)\]/i",
    r"/^folded\s+(?:before Flop|on the (Flop|Turn|River))/i",
    r"/\(didn't bet\)/i",
    r"/^mucked\b/i",
    r"/\bwith\s+(.+?)(?:,\s+(?:and\s+)?(?:won|lost|Cashout Risk)\b.*)?$/i",
    r"/,\s*$/",
    r"/^showed\b/i",
    r"/\bcollected\b/i",
    r"/\r\n|\r|\n/",
];
const TEMPLATES: &[&str] = &[
    r"(?:\$|€|£|¥|₩|R\$|Rs\.?)?\s?([\d,]+(?:\.\d+)?)",
    r"Cashout Risk \(${MONEY}\)",
    r"(?:won|collected)\s+\(${MONEY}\)",
];

#[test]
fn patterns_are_the_typescript_source() {
    for pattern in LITERALS {
        assert!(SOURCE.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES {
        assert!(
            SOURCE.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    assert!(SOURCE.contains("export const MONEY = String.raw`"));
    assert!(SOURCE.contains(MONEY));
}

#[test]
fn splits_lines_on_every_line_ending() {
    assert_eq!(to_lines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
    assert_eq!(to_lines("a\r\r\nb"), ["a", "", "b"]);
    assert_eq!(to_lines(""), [""]);
    assert_eq!(to_lines("a\n"), ["a", ""]);
    assert_eq!(to_lines("a\u{2028}b"), ["a\u{2028}b"]);
    assert_eq!(normalize_newlines("a\rb\r\nc"), "a\nb\nc");
    assert_eq!(strip_bom("\u{FEFF}\u{FEFF}x"), "\u{FEFF}x");
}

#[test]
fn splits_before_line_starts_but_never_at_zero() {
    let re = crate::js::regex::js_regex(r"^H", "");
    assert_eq!(
        split_before_line_starts("Ha\nHb\rHc", &re),
        ["Ha\n", "Hb\r", "Hc"]
    );
    assert_eq!(
        split_before_line_starts("x\u{2028}Hb", &re),
        ["x\u{2028}", "Hb"]
    );
    assert_eq!(split_before_line_starts("", &re), [""]);
    assert_eq!(split_before_line_starts("a\nb", &re), ["a\nb"]);
}

#[test]
fn reads_the_currency_from_the_stakes() {
    let chips = CHIPS.unit();
    assert_eq!(
        unit_for_stakes("$0.25/$0.50 CAD", &chips),
        Some(cash_unit("CAD", "$"))
    );
    assert_eq!(unit_for_stakes("$0.25/$0.50", &chips), Some(USD.unit()));
    assert_eq!(unit_for_stakes("€1/€2 EUR", &chips), Some(EUR.unit()));
    assert_eq!(unit_for_stakes("100/200", &chips), Some(chips.clone()));
    assert_eq!(unit_for_stakes("¥100/¥200", &chips), None);
    assert_eq!(unit_for_stakes("Rs. 10/Rs. 20", &chips), None);
    assert_eq!(unit_for_stakes("Rs10", &chips), None);
    assert!(has_unsupported_currency("₩1"));
    assert!(!has_unsupported_currency("Rs."));
    assert_eq!(symbol_in("$ and €"), "€");
    assert_eq!(buy_in_unit_for("2000+110", Some("USD")), CHIPS.unit());
    assert_eq!(
        buy_in_unit_for("$10+$1", Some("CAD")),
        cash_unit("CAD", "$")
    );
    assert_eq!(buy_in_unit_for("$10+$1", Some("")), USD.unit());
    assert_eq!(buy_in_unit_for("£5", None), crate::phf::money::GBP.unit());
}

#[test]
fn decides_the_decimal_style_from_the_whole_hand() {
    assert_eq!(detect_decimals("$0.50 and $0.5"), DecimalStyle::Fixed2);
    assert_eq!(detect_decimals("$0.5"), DecimalStyle::Minimal);
    assert_eq!(detect_decimals("$0.505"), DecimalStyle::Fixed2);
    assert_eq!(detect_decimals("$0.55 only"), DecimalStyle::Fixed2);
    assert_eq!(detect_decimals("1.5x"), DecimalStyle::Minimal);
    assert_eq!(detect_decimals("1.50"), DecimalStyle::Fixed2);
    assert_eq!(detect_decimals("no amounts"), DecimalStyle::Fixed2);
    assert!(detect_pad_hour("2012/09/11 08:39:12"));
    assert!(!detect_pad_hour("2012/09/11 8:39:12"));
    assert!(detect_pad_hour("no date"));
    assert_eq!(
        parse_played_at("x - 2019/02/31 9:00:00 ET").as_deref(),
        Some("2019-03-03T09:00:00.000Z")
    );
    assert_eq!(parse_played_at("2019/01/01 25:00:00"), None);
}

#[test]
fn reads_limits_and_levels_off_labels() {
    assert_eq!(limit_from_label("PLO-5"), LimitType::Pl);
    assert_eq!(limit_from_label("NLO"), LimitType::Nl);
    assert_eq!(limit_from_label("Hold'em Limit"), LimitType::Fl);
    assert_eq!(
        limit_from_label("Hold'em Pot Limit Pre-Flop, No Limit Post-Flop"),
        LimitType::Pl
    );
    assert_eq!(limit_from_label("Razz"), LimitType::Nl);
    assert_eq!(level_number_of("IV"), Ok(Some(4)));
    assert_eq!(level_number_of("XIV"), Ok(Some(14)));
    assert_eq!(level_number_of("iv"), Ok(Some(4)));
    // `toUpperCase` maps the dotless i to I.
    assert_eq!(level_number_of("ıv"), Ok(Some(4)));
    assert_eq!(level_number_of("IVXLCDM"), Ok(Some(334)));
    assert_eq!(level_number_of("007"), Ok(Some(7)));
    assert_eq!(level_number_of("7a"), Ok(None));
    assert_eq!(level_number_of(""), Ok(None));
    assert_eq!(level_number_of("99999999999"), Err(LevelTooLarge));
}

#[test]
fn reads_summary_seat_prose() {
    let usd = USD.unit();
    let folded = parse_summary_seat(
        "Seat 2: bob (big blind) folded on the Turn (didn't bet)",
        "bob",
        &usd,
    );
    assert_eq!(folded.position_labels, ["(big blind)"]);
    assert_eq!(folded.outcome, SeatOutcome::Folded);
    assert_eq!(folded.folded_street, Some(Street::Turn));
    assert!(folded.didnt_bet);

    let won = parse_summary_seat(
        "Seat 2: nFruit (big blind) showed [Qc Qh] and won ($995) with a pair of Queens, and won ($995) with two pair, Queens and Tens",
        "nFruit",
        &usd,
    );
    assert_eq!(won.outcome, SeatOutcome::Won);
    assert_eq!(won.shown_cards, ["Qc", "Qh"]);
    assert_eq!(won.hand_description.as_deref(), Some("a pair of Queens"));

    let lost = parse_summary_seat(
        "Seat 1: x (button) (small blind) showed [Ah 5c] and lost with two pair, Sixes and Fives,",
        "x",
        &usd,
    );
    assert_eq!(lost.position_labels, ["(button)", "(small blind)"]);
    assert_eq!(lost.outcome, SeatOutcome::Lost);
    assert_eq!(
        lost.hand_description.as_deref(),
        Some("two pair, Sixes and Fives")
    );

    let collected = parse_summary_seat("Seat 3: Hero (big blind) collected ($0.1)", "Hero", &usd);
    assert_eq!(collected.outcome, SeatOutcome::Collected);
    let cashout = parse_summary_seat(
        "Seat 5: d31522d6 showed [Ah Kd] and won ($1) with a pair, Cashout Risk ($19)",
        "d31522d6",
        &usd,
    );
    assert_eq!(cashout.cashout_risk, Some(1900));
    assert_eq!(cashout.hand_description.as_deref(), Some("a pair"));
    let mucked = parse_summary_seat("Seat 1: x (button) mucked [Td 7d]", "x", &usd);
    assert_eq!((mucked.outcome, mucked.mucked), (SeatOutcome::Mucked, true));
    assert_eq!(mucked.shown_cards, ["Td", "7d"]);
    let unknown = parse_summary_seat("Seat 1: x sat here", "x", &usd);
    assert_eq!(unknown.outcome, SeatOutcome::Unknown);
    assert_eq!(unknown.raw, "Seat 1: x sat here");
}

fn init(repair: bool) -> DraftInit {
    DraftInit {
        site_id: "test".to_owned(),
        site_name: "Test".to_owned(),
        parser_id: "test".to_owned(),
        parser_version: "0".to_owned(),
        hand_id: "1".to_owned(),
        hand_key: "T1".to_owned(),
        raw_text: String::new(),
        original_filename: None,
        game: DraftGame {
            variant: Variant::Holdem,
            limit: LimitType::Nl,
            format: GameFormat::Cash,
            label: "Hold'em No Limit".to_owned(),
            unit: USD.unit(),
            small_blind: 5,
            big_blind: 10,
        },
        tournament: None,
        played_at: None,
        text_style: PhfTextStyle::default(),
        repair_missing_uncalled: repair,
        parsed_at: crate::detect::PINNED_PARSED_AT.to_owned(),
    }
}

fn post(draft: &mut StarsHandDraft, name: &str, kind: ActionType, amount: Amount) {
    draft.post(
        name,
        kind,
        amount,
        PostOptions {
            raw_line: "x",
            ..PostOptions::default()
        },
    );
}

#[test]
fn rebuilds_a_dropped_uncalled_return_only_when_it_is_pinned_down() {
    let mut draft = StarsHandDraft::new(init(true));
    draft.seat(1, "a", 1000, false);
    draft.seat(2, "b", 1000, false);
    post(&mut draft, "a", ActionType::SmallBlind, 5);
    post(&mut draft, "b", ActionType::BigBlind, 10);
    draft.raise_to("a", 100, false, None, "a: raises");
    draft.simple("b", ActionType::Fold, Vec::new(), None, "b: folds");
    draft.collect("a", 20, "pot", None, "a collected");
    draft.summary_pot(20, Vec::new(), PhfFees::ZERO);
    let hand = draft.build().expect("hand");
    // At the end of the last betting street, after the fold.
    let uncalled = &hand.actions[4];
    assert_eq!(uncalled.kind, ActionType::Uncalled);
    assert_eq!((uncalled.amount, uncalled.street_total), (-90, 10));
    assert_eq!(uncalled.label, "uncalled $0.9 returned");
    assert_eq!(uncalled.raw_line, "Uncalled bet ($0.9) returned to a");
    assert_eq!(uncalled.source_line, None);
    assert_eq!(
        hand.actions.iter().map(|a| a.index).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4, 5]
    );
    assert_eq!(hand.meta.warnings[0].code, "uncalled-return-reconstructed");
    assert_eq!(hand.results.players[0].contributed, 10);

    // Off unless the site opts in.
    let mut draft = StarsHandDraft::new(init(false));
    draft.seat(1, "a", 1000, false);
    draft.raise_to("a", 100, false, None, "a: raises");
    draft.summary_pot(20, Vec::new(), PhfFees::ZERO);
    assert_eq!(draft.build().expect("hand").actions.len(), 1);
}

#[test]
fn derives_the_pot_and_the_rake_without_a_summary() {
    let mut draft = StarsHandDraft::new(init(false));
    draft.seat(1, "a", 1000, false);
    draft.seat(2, "b", 1000, false);
    post(&mut draft, "a", ActionType::SmallBlind, 50);
    post(&mut draft, "b", ActionType::BigBlind, 50);
    draft.collect("a", 95, "pot", None, "a collected");
    let hand = draft.build().expect("hand");
    assert_eq!(hand.results.total_pot, 100);
    assert_eq!(hand.results.fees.rake, 5);
    assert_eq!(hand.meta.warnings[0].code, "rake-inferred");
    assert_eq!(hand.game.ante_model, AnteModel::None);
}

#[test]
fn reports_an_unseated_straddler_instead_of_seat_minus_one() {
    let mut draft = StarsHandDraft::new(init(false));
    draft.seat(1, "a", 1000, false);
    post(&mut draft, "ghost", ActionType::Straddle, 20);
    assert_eq!(draft.build(), Err(BuildError::UnseatedStraddler));
    assert_eq!(draft.first_unseated_actor(), Some("ghost"));
}

#[test]
fn keeps_the_first_dealt_face_up_seat_as_hero_and_names_the_mover_of_house_money() {
    let mut draft = StarsHandDraft::new(init(false));
    draft.seat(1, "a", 1000, false);
    draft.seat(2, "b", 1000, false);
    draft.seat(2, "b", 5, false);
    draft.dealt("a", Vec::new());
    draft.dealt("b", vec!["Ah".to_owned(), "Zz".to_owned()]);
    draft.dealt("ghost", vec!["2c".to_owned()]);
    assert_eq!(draft.has_invalid_card(), Some("Zz"));
    draft.chip_movement(PhfChipMovement {
        kind: "jackpot".to_owned(),
        from_seat: Some(2),
        from_player: Some("ignored".to_owned()),
        to_pot: false,
        amount: 1,
        raw: None,
        anchor: crate::phf::ChipMovementAnchor::BeforePostings,
    });
    let hand = draft.build().expect("hand");
    assert_eq!(
        hand.meta
            .warnings
            .iter()
            .map(|w| w.code.as_str())
            .collect::<Vec<_>>(),
        ["duplicate-seat-line", "dealt-to-unseated", "no-summary"]
    );
    assert!(hand.players[1].is_hero && !hand.players[0].is_hero);
    assert!(hand.players[0].dealt_announced && hand.players[0].hole_cards.is_empty());
    assert!(hand.meta.text_style.dealt_lines_for_all_players);
    assert_eq!(
        hand.chip_movements
            .as_ref()
            .and_then(|m| m[0].from_player.as_deref()),
        Some("b")
    );
    assert_eq!(hand.results.hero_net, Some(0));
}

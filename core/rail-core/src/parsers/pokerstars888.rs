//! `888poker`: 888poker and its skins - Pacific Poker, LuckyAcePoker.com,
//! Cassava (`frontend/src/lib/parsers/pokerstars888.ts`; the file name is the
//! one the TypeScript parser was commissioned under).
//!
//! The PartyGaming skeleton in 888's vocabulary: a `#Game No :` preamble, a
//! `$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28` stakes
//! line (no zone), lowercase `** Dealing flop **` markers, bracketed amounts,
//! and a `** Summary **` block that is the only place a showdown is reported.
//! No pot total, rake or uncalled return: those are reconstructed by
//! [`build_hand`], with 888's
//! `collected` already net of the winner's uncalled bet.
//!
//! The European client's `25 $/50 $` stakes with comma decimals are refused
//! (`unsupported-locale`) rather than read a hundredfold. Patterns are the
//! TypeScript source verbatim (a test holds them to `pokerstars888.ts`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::partypoker::fallback_max_seats;
use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
};
use super::shared::p2_partygaming::{
    BANNER_REGEX, P888_AMOUNT_REGEX, P888_STAKES_REGEX, banner_and_stakes, bracket_amount,
    bracket_parts, dealing_board, is_chat_line, is_noise_line, iso_from_888_date,
    split_bannered_hands, split_lines, unit_for,
};
use super::shared::variant_lock::{
    HOLDEM_OMAHA, OMAHA_HI_LO, canonical_game_label, normalize_game_name, unsupported_variant_skip,
    variant_of,
};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::parse_amount_js;
use crate::phf::{
    CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant, is_hi_lo_label,
};

/// `VERSION`.
pub const POKER888_PARSER_VERSION: &str = "1.0.0";

/// `P888_VARIANTS`: `["holdem", "omaha"]`.
const P888_VARIANTS: &[Variant] = HOLDEM_OMAHA;
/// `P888_HI_LO`: `Pot Limit OmahaHL` (fixtures 05 and 10).
const P888_HI_LO: &[Variant] = OMAHA_HI_LO;

static BRAND_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\b(?:888poker|888\.com|Pacific Poker|LuckyAcePoker|Cassava)\b",
    "i"
);
static STREET_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?",
    "i"
);
static SEAT_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$", "");
static TABLE_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table\s+(.+?)(?:\s+(\d+)\s+Max)?\s*\((Real|Play) Money\)\s*$",
    "i"
);
static BUTTON_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+)\s+is the button\s*$", "");
static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*{2}\s*Summary\s*\*{2}$", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to\s+(.+?)\s*\[([^\]]*)\]\s*$", "");
static COLLECT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+collected\s*\[\s*([^\]]*?)\s*\]\s*$", "");
static POSTED: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+posts\s+(small blind|big blind|dead blind|ante)\s*\[([^\]]*)\]\s*$",
    "i"
);
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?)\s+(folds|checks)\s*$", "");
static WAGER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+(calls|bets|raises)\s*\[([^\]]*)\]\s*$", "");
static ALL_IN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+is all-In\s*\[([^\]]*)\]\s*$", "i");
static SHOWN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+(shows|mucks)\s*\[([^\]]*)\]\s*$", "");
static NO_SHOW: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+did not show (?:his|her|their) hand\s*$", "i");
static HI_LO_HAND: LazyLock<Regex> = crate::js_regex_lazy!(r"^\((?:Hi|Lo):", "i");
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"pot\s*limit", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"fix(?:ed)?\s*limit", "i");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

/// `limitOf(label)`: 888 writes the limit in front of the game.
fn limit_of(label: &str) -> LimitType {
    if POT_LIMIT.is_match(label) {
        return LimitType::Pl;
    }
    if FIXED_LIMIT.is_match(label) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

/// `pushPost(player, kind, bracket, unit, act)`.
fn post_action(
    street: DraftStreet,
    player: &str,
    kind: &str,
    bracket: &str,
    unit: &CurrencyUnit,
) -> DraftAction {
    if kind == "dead blind" {
        // `posts dead blind [$1 + $2]`: the dead small blind, then the live
        // big blind the player re-enters with.
        let parts = bracket_parts(bracket);
        let first = parts.first().copied().unwrap_or("");
        let dead = parse_amount_js(first, unit);
        let live = parse_amount_js(parts.get(1).copied().unwrap_or(first), unit);
        let mut action = DraftAction::new(street, player, DraftKind::Post);
        let both = parts.len() > 1;
        action.amount = Some(if both { live } else { JsNumber::ZERO });
        action.dead = Some(if both { dead } else { live });
        return action;
    }
    let amount = bracket_amount(bracket, unit);
    let kind = match kind {
        "ante" => DraftKind::Ante,
        "small blind" => DraftKind::SmallBlind,
        _ => DraftKind::BigBlind,
    };
    let mut action = DraftAction::new(street, player, kind);
    action.amount = Some(amount);
    action
}

/// `poker888Parser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let without_bom = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let lines = split_lines(without_bom);
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let banner = lines
        .iter()
        .position(|line| BANNER_REGEX.is_match(js::trim(line)))
        .and_then(|i| BANNER_REGEX.captures(js::trim(lines[i])).map(|c| (i, c)));
    let Some((banner_index, banner)) = banner else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk has no 888poker banner line.",
        ));
    };
    let hand_id = banner[2].to_owned();

    let stakes_line = banner_and_stakes(raw).map_or(String::new(), |head| head.stakes);
    let Some(stakes) = P888_STAKES_REGEX.captures(&stakes_line) else {
        return Err(skip(
            SkipReason::NoHeader,
            "The 888poker stakes line is missing, so the stakes and the game are unknown.",
        ));
    };
    let label = js::trim(&stakes[3]).to_owned();
    // `Pot Limit OmahaHL`: the split-pot marker is spelled out first.
    let game_name = normalize_game_name(&label);
    if let Some(refusal) = unsupported_game_skip(&game_name, P888_HI_LO)
        .or_else(|| unsupported_variant_skip(&game_name, P888_VARIANTS))
    {
        return Err(refusal.into());
    }
    let small = P888_AMOUNT_REGEX.captures(js::trim(&stakes[1]));
    let big = P888_AMOUNT_REGEX.captures(js::trim(&stakes[2]));
    let (Some(small), Some(big)) = (small, big) else {
        // `25 $/50 $` with `3 023,50 $` stacks: refused, not inflated.
        return Err(skip(
            SkipReason::UnsupportedLocale,
            format!(
                "The stakes \"{}/{}\" are not in the English-locale 888 format.",
                &stakes[1], &stakes[2]
            ),
        ));
    };
    let unit = unit_for(if small[1].is_empty() {
        &big[1]
    } else {
        &small[1]
    });
    let played_at = iso_from_888_date(
        &stakes[4], &stakes[5], &stakes[6], &stakes[7], &stakes[8], &stakes[9],
    );

    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut seat_names: HashSet<String> = HashSet::new();
    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    let mut acted: HashSet<String> = HashSet::new();
    let mut table_name: Option<String> = None;
    let mut max_seats = JsNumber::ZERO;
    let mut button_seat: Option<JsNumber> = None;
    let mut street = DraftStreet::Preflop;
    let mut saw_summary = false;
    let mut hero_name: Option<String> = None;

    // `act(player, action)`: an action that makes its player dealt in.
    let act = |acted: &mut HashSet<String>, actions: &mut Vec<DraftAction>, action: DraftAction| {
        acted.insert(action.player.clone());
        actions.push(action);
    };

    for (i, raw_line) in lines.iter().enumerate().skip(banner_index + 1) {
        let line = js::trim(raw_line.strip_prefix('\u{FEFF}').unwrap_or(raw_line));
        let line_no = u32::try_from(i + 1).ok();
        if line.is_empty() {
            continue;
        }
        if P888_STAKES_REGEX.is_match(line) || is_noise_line(line) {
            continue;
        }

        if let Some(table) = TABLE_REGEX.captures(line) {
            table_name = Some(js::trim(&table[1]).to_owned());
            max_seats = JsNumber::parse(table.get(2).map_or("0", |m| m.as_str()));
            continue;
        }

        if let Some(button) = BUTTON_REGEX.captures(line) {
            button_seat = Some(JsNumber::parse(&button[1]));
            continue;
        }

        if let Some(seat) = SEAT_REGEX.captures(line)
            && !saw_summary
        {
            let name = seat[2].to_owned();
            seats.push(DraftSeat {
                seat: JsNumber::parse(&seat[1]),
                name: name.clone(),
                starting_stack: parse_amount_js(&seat[3], &unit),
                // Filled in once the whole hand is read.
                dealt_in: false,
                is_hero: false,
                dealt_cards: Vec::new(),
            });
            seat_names.insert(name);
            continue;
        }

        if let Some(marker) = STREET_REGEX.captures(line) {
            match js::to_lower_case(&marker[1]).as_str() {
                "flop" => street = DraftStreet::Flop,
                "turn" => street = DraftStreet::Turn,
                "river" => street = DraftStreet::River,
                _ => {}
            }
            continue;
        }

        if SUMMARY.is_match(line) {
            saw_summary = true;
            continue;
        }

        if let Some(dealt) = DEALT.captures(line) {
            if let Some(player) = seats.iter_mut().find(|entry| entry.name == dealt[1]) {
                player.is_hero = true;
                player.dealt_cards = extract_cards(&dealt[2]);
                hero_name = Some(player.name.clone());
            }
            continue;
        }

        if let Some(collect) = COLLECT.captures(line)
            && seat_names.contains(&collect[1])
        {
            collected.push(DraftCollect {
                player: collect[1].to_owned(),
                amount: bracket_amount(&collect[2], &unit),
                pot_name: None,
                half: None,
            });
            continue;
        }

        if let Some(posted) = POSTED.captures(line)
            && seat_names.contains(&posted[1])
        {
            let action = post_action(
                street,
                &posted[1],
                &js::to_lower_case(&posted[2]),
                &posted[3],
                &unit,
            );
            act(&mut acted, &mut actions, action);
            continue;
        }

        if let Some(simple) = SIMPLE.captures(line)
            && seat_names.contains(&simple[1])
        {
            let kind = if &simple[2] == "folds" {
                DraftKind::Fold
            } else {
                DraftKind::Check
            };
            act(
                &mut acted,
                &mut actions,
                DraftAction::new(street, &simple[1], kind),
            );
            continue;
        }

        if let Some(wager) = WAGER.captures(line)
            && seat_names.contains(&wager[1])
        {
            let kind = match &wager[2] {
                "calls" => DraftKind::Call,
                "bets" => DraftKind::Bet,
                _ => DraftKind::Raise,
            };
            let mut action = DraftAction::new(street, &wager[1], kind);
            action.amount = Some(bracket_amount(&wager[3], &unit));
            act(&mut acted, &mut actions, action);
            continue;
        }

        if let Some(all_in) = ALL_IN.captures(line)
            && seat_names.contains(&all_in[1])
        {
            let mut action = DraftAction::new(street, &all_in[1], DraftKind::Allin);
            action.amount = Some(bracket_amount(&all_in[2], &unit));
            action.all_in = true;
            act(&mut acted, &mut actions, action);
            continue;
        }

        if let Some(shown) = SHOWN.captures(line)
            && seat_names.contains(&shown[1])
        {
            // Both are printed in the SUMMARY block: the last street reached.
            let kind = if &shown[2] == "shows" {
                DraftKind::Show
            } else {
                DraftKind::Muck
            };
            let mut action = DraftAction::new(street, &shown[1], kind);
            action.cards = Some(extract_cards(&shown[3]));
            actions.push(action);
            continue;
        }

        if let Some(no_show) = NO_SHOW.captures(line)
            && seat_names.contains(&no_show[1])
        {
            let mut action = DraftAction::new(street, &no_show[1], DraftKind::Muck);
            action.cards = Some(Vec::new());
            actions.push(action);
            continue;
        }

        // `(Hi: ...)` / `(Lo: ...)` restate the shown cards.
        if HI_LO_HAND.is_match(line) {
            continue;
        }

        if is_chat_line(line, &seat_names) {
            continue;
        }

        warnings.push(PhfWarning {
            code: "unknown-line".to_owned(),
            message: line.to_owned(),
            line: line_no,
        });
    }

    if !saw_summary {
        return Err(skip(
            SkipReason::TruncatedHand,
            "The hand has no `** Summary **` block, so nothing says what was won.",
        ));
    }
    if collected.is_empty() {
        return Err(skip(
            SkipReason::NoWinner,
            "The summary block names no winner.",
        ));
    }

    for seat in &mut seats {
        seat.dealt_in = acted.contains(&seat.name) || hero_name.as_deref() == Some(&seat.name);
    }
    // The big blind of a walk never acts; a seat that took chips is dealt in.
    for entry in &collected {
        if let Some(seat) = seats.iter_mut().find(|seat| seat.name == entry.player) {
            seat.dealt_in = true;
        }
    }

    let first =
        |street: &str| dealing_board(raw, street).and_then(|cards| cards.into_iter().next());
    let max_seats = if max_seats.is_nan() || max_seats.strict_equals(JsNumber::ZERO) {
        fallback_max_seats(&seats)
    } else {
        max_seats
    };
    let draft = HandDraft {
        site_id: "888poker".to_owned(),
        site_name: "888poker".to_owned(),
        parser_id: "888poker".to_owned(),
        parser_version: POKER888_PARSER_VERSION.to_owned(),
        hand_prefix: "888-".to_owned(),
        hand_id,
        game_label: canonical_game_label(
            variant_of(&label),
            limit_of(&label),
            is_hi_lo_label(&game_name),
        ),
        decimals: DecimalStyle::Fixed2,
        header_small_blind: parse_amount_js(&small[2], &unit),
        header_big_blind: parse_amount_js(&big[2], &unit),
        unit,
        table_name,
        max_seats,
        button_seat,
        played_at,
        seats,
        actions,
        flop: dealing_board(raw, "flop"),
        turn: first("turn"),
        river: first("river"),
        collected,
        // 888 deducts the winner's uncalled bet before printing `collected`.
        collected_includes_uncalled: false,
        raw_text: js::trim(without_bom).to_owned(),
        warnings,
    };

    if let Some(flop) = &draft.flop
        && flop.len() != 3
    {
        return Err(skip(
            SkipReason::BoardSize,
            format!(
                "The flop line lists {} cards, so the hand is corrupt.",
                flop.len()
            ),
        ));
    }

    build_hand(&draft, ctx)
}

/// `poker888Parser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Poker888Parser;

impl SiteParser for Poker888Parser {
    fn id(&self) -> &'static str {
        "888poker"
    }

    fn name(&self) -> &'static str {
        "888poker"
    }

    fn version(&self) -> &'static str {
        POKER888_PARSER_VERSION
    }

    fn hi_lo_variants(&self) -> &'static [Variant] {
        P888_HI_LO
    }

    /// The stakes line is the only unambiguous signal (partypoker prints the
    /// same banner): 0.95 with a known brand in the banner, 0.9 without.
    fn detect(&self, text: &str) -> u32 {
        let Some(head) = banner_and_stakes(text) else {
            return 0;
        };
        if !P888_STAKES_REGEX.is_match(&head.stakes) {
            return 0;
        }
        if BRAND_REGEX.is_match(&head.banner) {
            950
        } else {
            900
        }
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_bannered_hands(text))
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_hand(raw, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/pokerstars888.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/\b(?:888poker|888\.com|Pacific Poker|LuckyAcePoker|Cassava)\b/i",
            r"/^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?/i",
            r"/^Seat\s+(\d+):\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$/",
            r"/^Table\s+(.+?)(?:\s+(\d+)\s+Max)?\s*\((Real|Play) Money\)\s*$/i",
            r"/^Seat\s+(\d+)\s+is the button\s*$/",
            r"/^\*{2}\s*Summary\s*\*{2}$/i",
            r"/^Dealt to\s+(.+?)\s*\[([^\]]*)\]\s*$/",
            r"/^(.+?)\s+collected\s*\[\s*([^\]]*?)\s*\]\s*$/",
            r"/^(.+?)\s+posts\s+(small blind|big blind|dead blind|ante)\s*\[([^\]]*)\]\s*$/i",
            r"/^(.+?)\s+(folds|checks)\s*$/",
            r"/^(.+?)\s+(calls|bets|raises)\s*\[([^\]]*)\]\s*$/",
            r"/^(.+?)\s+is all-In\s*\[([^\]]*)\]\s*$/i",
            r"/^(.+?)\s+(shows|mucks)\s*\[([^\]]*)\]\s*$/",
            r"/^(.+?)\s+did not show (?:his|her|their) hand\s*$/i",
            r"/^\((?:Hi|Lo):/i",
            r"/pot\s*limit/i",
            r"/fix(?:ed)?\s*limit/i",
            r"/[\d,]+(?:\.\d+)?/g",
            r"/^\uFEFF/",
            r"/\r?\n/",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
        assert!(source.contains(&format!(
            "new RegExp(String.raw`{}`, \"im\")",
            super::super::shared::p2_partygaming::BOARD_TEMPLATE
        )));
        assert!(source.contains("const VERSION = \"1.0.0\";"));
        assert!(source.contains("const P888_VARIANTS = [\"holdem\", \"omaha\"] as const;"));
        assert!(source.contains("[2, 4, 6, 9, 10]"));
    }

    #[test]
    fn limit_words() {
        assert_eq!(limit_of("Pot Limit OmahaHL"), LimitType::Pl);
        assert_eq!(limit_of("Fix Limit Holdem"), LimitType::Fl);
        assert_eq!(limit_of("Fixed Limit Holdem"), LimitType::Fl);
        assert_eq!(limit_of("No Limit Holdem"), LimitType::Nl);
    }
}

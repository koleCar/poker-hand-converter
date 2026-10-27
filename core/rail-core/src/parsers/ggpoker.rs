//! `ggpoker`: GGPoker (`web/src/lib/parsers/ggpoker.ts`).
//!
//! GG's export is the text the standard format was modelled on, so the
//! `standard` parser already reads a plain GG cash hand - and on those bytes
//! this parser produces the same hand (a test checks every cash hand of the
//! corpus). It deliberately scores *below* `standard` (0.86 against 0.9) on
//! that plain dialect and outranks it (0.95) only where GG prints what the
//! generic reader gets wrong or has no policy for: Rush & Cash, GG's own
//! tournament header (`Level7 (150/300)` after a free-text name), the
//! non-Hold'em products, all-in insurance.
//!
//! GG specifics read here: anonymised players with the observer named `Hero`,
//! a `Dealt to` line for every seat, EV cashout and all-in insurance (two
//! different products), four widths of fee line, `*** FIRST FLOP ***`
//! runouts and `Hand was run two times`, the bare `straddle` verb whose amount
//! is the street total, short deck's `button blind`, house cash drops.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `ggpoker.ts`). The buy-in token's trailing `(?=\s|$)` is matched as a
//! consumed `(?:\s|$)` - the same match, since only group 1 is read; the
//! multiline probes run at every JavaScript line start.

use std::sync::LazyLock;

use regex::Regex;

use super::shared::ps_gg_hand::{
    BuildError, DraftGame, DraftInit, PostOptions, StarsHandDraft, buy_in_unit_for,
    detect_decimals, detect_pad_hour, has_unsupported_currency, last_bracket_cards,
    level_number_of, limit_from_label, line_number, marker_kind, normalize_newlines, number_u32,
    parse_played_at, runout_index_for_label, skip, split_before_line_starts, strip_bom,
    template_regex, to_lines, u32_or_bug, unit_for_stakes, unrepresentable, unseated,
    variant_from_label,
};
use super::shared::variant_lock::unsupported_variant_skip;
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, SiteParser, SiteParserContext, SkipReason, SplitError, unsupported_game_skip,
};
use crate::js;
use crate::phf::money::CHIPS;
use crate::phf::serialize::matches_at_line_start;
use crate::phf::{
    ActionType, Amount, BUTTON_BLIND_VERB, ChipMovementAnchor, CurrencyUnit, GameFormat,
    PhfChipMovement, PhfFees, PhfHand, PhfPot, PhfTextStyle, PhfTournament, Street, Variant,
    parse_amount, parse_buy_in_token,
};

/// `GGPOKER_PARSER_VERSION`.
pub const GGPOKER_PARSER_VERSION: &str = "1.1.0";

/// `GGPOKER_VARIANTS`: Hold'em, four- and five-card Omaha, short deck. Not
/// `PLO-6`, which has no fixture.
const GGPOKER_VARIANTS: &[Variant] = &[
    Variant::Holdem,
    Variant::Omaha,
    Variant::Omaha5,
    Variant::Shortdeck,
];

/// `PRODUCT_PREFIXES`: the two-letter product code of a hand id.
fn product_for(prefix: &str) -> Option<&'static str> {
    Some(match prefix {
        "HD" => "Hold'em cash",
        "RC" => "Rush & Cash",
        "TM" => "tournament",
        "SD" => "Short Deck",
        "OM" | "PL" => "Omaha",
        "SG" => "Spin & Gold",
        "BR" => "Battle Royale",
        _ => return None,
    })
}

/// `GG_GAME_LABEL` (flag `m`) without the `m`, tried at every line start.
static GG_GAME_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Poker Hand #\S+:\s*(?:ShortDeck|Hold'?em\s+Short\s*Deck|PLO(?:-\d)?|NLO\d?)\b",
    ""
);
static HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:GG\s*)?Poker Hand #([A-Za-z0-9_-]+):\s*(.*)$", "");
static HEADER_PREFIX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:GG\s*)?Poker Hand #[A-Za-z0-9_-]+:", "");
/// The body of `splitHands`' lookahead.
static SPLIT_AT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:GG\s*)?Poker Hand #", "");
static TABLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$",
    ""
);
static SEAT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$", "");
static MARKER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$",
    "i"
);

/// `GG_FEE_LINE` (flag `m`) without the `m`.
static GG_FEE_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Total pot [^|\n]*\|\s*Rake ", "");
static EV_CASHOUT: LazyLock<Regex> =
    crate::js_regex_lazy!(r": (?:Chooses to EV Cashout|Pays Cashout Risk)", "");
static GG_INSURANCE: LazyLock<Regex> = crate::js_regex_lazy!(
    r": (?:get an all-in insurance|pay premium of all-in insurance)",
    ""
);
static GG_BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\b(?:GGPoker|GGPOKER|Natural8|NATURAL8|BestPoker|ClubGG|Rush\s*&\s*Cash)\b",
    ""
);
/// `FOREIGN_BRANDING`: another room's name always wins over ours.
static FOREIGN_BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\b(?:PokerStars|888poker|Pacific Poker|PartyPoker|WPT Global|iPoker)\b",
    "i"
);
static ANY_HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"(?:^|[\r\n])(?:GG\s*)?Poker Hand #", "");
static GG_TOURNAMENT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"-\s*Level\s*(?:[IVXLCDM]+|\d+)\s*\(", "");
static GG_PRODUCT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"(?:^|[\r\n])(?:GG\s*)?Poker Hand #(?:RC|TM|SD|OM|PL|SG|BR)",
    "i"
);

/// `SUFFIX`.
const SUFFIX: &str = r"((?: and is all-in)*)";
static ALL_IN: LazyLock<Regex> = crate::js_regex_lazy!(r"and is all-in", "");

fn all_in_from(suffix: Option<regex::Match<'_>>) -> bool {
    suffix.is_some_and(|m| !m.as_str().is_empty() && ALL_IN.is_match(m.as_str()))
}

/// The members of `CHATTER_REGEX` (joined with `|`, flag `i`).
const CHATTER_MEMBERS: [&str; 13] = [
    r#"\bsaid, ""#,
    r"\bjoins the table\b",
    r"\bleaves the table\b",
    r"\bis sitting out\b",
    r"\bsits out\b",
    r"\bhas returned\b",
    r"\bhas timed out\b",
    r"\bis (?:dis)?connected\b",
    r"\bwill be allowed to play after the button\b",
    r"\bdeclines straddle\b",
    r"\bfinished the tournament in\b",
    r"\breceived? a reward\b",
    r"\benters the table\b",
];
static CHATTER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&CHATTER_MEMBERS.join("|"), "i"));

static BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\s*(\S+?)\s*\/\s*(\S+)", "");

/// `GAME_LABEL_TAIL`'s two `String.raw` halves (concatenated, flag `i`).
const GAME_LABEL_TAIL_PARTS: [&str; 2] = [
    r"\s((?:6\+\s*)?(?:Hold'?em|Omaha(?:\s*Hi/Lo)?|PLO(?:-\d)?|NLO\d?|Short\s?Deck|Stud|Razz|Badugi|Draw)",
    r"(?:\s*\([^)]*\))?(?:\s+(?:No Limit|Pot Limit|Fixed Limit|Limit))?(?:\s*\([^)]*\))?)\s*$",
];
static GAME_LABEL_TAIL: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&GAME_LABEL_TAIL_PARTS.concat(), "i"));
/// `BUY_IN_TOKEN` up to its trailing lookahead, `(?=\s|$)`.
const BUY_IN_TOKEN_BODY: &str =
    r"(?:^|\s)((?:[$€£]\s?[\d.,]+)(?:\+[$€£]?\s?[\d.,]+)*|\d[\d.,]*(?:\+\d[\d.,]*)+|Freeroll)";
/// `BUY_IN_TOKEN` with the lookahead consumed: group 1 of the first match is
/// what the lookahead version captures (same alternatives, same priority).
static BUY_IN_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"{BUY_IN_TOKEN_BODY}(?:\s|$)"), "i"));
static TOURNAMENT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Tournament\s*(?:\(([^]*?)\))?\s*#(\S+?),\s*(.+?)\s+-\s+Level\s*([IVXLCDM]+|\d+)\s*\(([^)]*)\)\s+-\s+(.*)$",
    ""
);
static CASH: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$", "");

/// `parseSummaryFees`' `${name} ${MONEY}` for each column.
static FEE_COLUMNS: LazyLock<[Regex; 5]> = LazyLock::new(|| {
    ["Rake", "Jackpot", "Bingo", "Fortune", "Tax"]
        .map(|name| template_regex(&format!("{name} ${{MONEY}}"), "", ""))
});

static PREFLOP_MARKER: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*{3}\s*PREFLOP\s*\*{3}", "i");
static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY\s*\*\*\*", "i");
static TOTAL_POT: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Total pot ${MONEY}", "", ""));
static POTS: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"(Main|Side) pot(-\d+)? ${MONEY}\.", "", "g"));
static RUN_TIMES: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Hand was run (?:two|three|four) times$", "i");
static BOARD_LABEL_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:FIRST|SECOND|THIRD)$", "i");
static BOARD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+):", "");
static RUSH_TABLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^RushAndCash", "i");
static SITTING_OUT_TAIL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bsitting out\b", "i");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS\s*\*\*\*", "i");
static BOMB_POT: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*BOMB POT\s*\*\*\*", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$", "");
static UNCALLED: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Uncalled bet \(${MONEY}\) returned to (.+)$", "", ""));
static COLLECTED: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?) collected ${MONEY} from (?:the )?(.+?)$", "", ""));
static ANTE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): posts the ante ${MONEY}${SUFFIX}$", SUFFIX, ""));
static BLIND: LazyLock<Regex> = LazyLock::new(|| {
    template_regex(
        r"^(.+?): posts (small|big|button) blind ${MONEY}${SUFFIX}$",
        SUFFIX,
        "",
    )
});
static MISSED: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): posts missed blind ${MONEY}$", "", ""));
static STRADDLE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): straddle ${MONEY}${SUFFIX}$", SUFFIX, ""));
static POST: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): posts (straddle )?${MONEY}${SUFFIX}$", SUFFIX, ""));
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?): (folds|checks)$", "");
static WAGER: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): (calls|bets) ${MONEY}${SUFFIX}$", SUFFIX, ""));
static RAISE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$", SUFFIX, ""));
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$", "");
static MUCK: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): (mucks hand|doesn't show hand)$", "i");
static CASHOUT_CHOOSE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): Chooses to EV Cashout$", "");
static CASHOUT_PAY: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): Pays Cashout Risk \(${MONEY}\)$", "", ""));
static INSURANCE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?): (get an all-in insurance|pay premium of all-in insurance)\b(.*)$",
    ""
);
static CASH_DROP: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Cash Drop to Pot\s*:\s*total ${MONEY}$", "", "i"));

/// What the header says (`Header`).
struct Header {
    hand_id: String,
    product: Option<&'static str>,
    payload: String,
    game: DraftGame,
    tournament: Option<PhfTournament>,
    played_at: Option<String>,
}

/// `blindsFrom`: GG allows spaces around the slash.
fn blinds_from(stakes_text: &str, unit: &CurrencyUnit) -> (Amount, Amount) {
    match BLINDS.captures(stakes_text) {
        Some(c) => (parse_amount(&c[1], unit), parse_amount(&c[2], unit)),
        None => (0, parse_amount(js::trim(stakes_text), unit)),
    }
}

/// `unitFor`.
fn unit_for(stakes_text: &str) -> Option<CurrencyUnit> {
    unit_for_stakes(stakes_text, &CHIPS.unit())
}

/// `parseTournament`: the game label is matched from the end (a closed
/// vocabulary that always sits last), the name is what is left, the buy-in
/// the first money token inside the name.
fn parse_tournament(payload: &str) -> Result<Option<(PhfTournament, DraftGame)>, ParseError> {
    let Some(c) = TOURNAMENT.captures(payload) else {
        return Ok(None);
    };
    let paren_name = c.get(1).map(|m| m.as_str());
    let id = &c[2];
    let body = &c[3];
    let level_label = &c[4];
    let level_stakes = &c[5];

    let tail = GAME_LABEL_TAIL.captures(body);
    let label = js::trim(
        tail.as_ref()
            .and_then(|t| t.get(1))
            .map_or(body, |m| m.as_str()),
    )
    .to_owned();
    let name_part = js::trim(
        tail.as_ref()
            .and_then(|t| t.get(0))
            .map_or("", |m| &body[..m.start()]),
    );
    let buy_in_token = BUY_IN_TOKEN
        .captures(name_part)
        .and_then(|b| b.get(1))
        .map_or("", |m| m.as_str());
    // A name that is nothing but the buy-in is not a name.
    let name = match paren_name {
        Some(name) => Some(name.to_owned()),
        None => (!name_part.is_empty() && name_part != buy_in_token).then(|| name_part.to_owned()),
    };

    // A symbol-less buy-in is play money, not dollars.
    let buy_in_unit = buy_in_unit_for(buy_in_token, None);
    let buy_in = parse_buy_in_token(buy_in_token, &buy_in_unit);
    let Some(unit) = unit_for(level_stakes) else {
        return Ok(None);
    };
    let (small_blind, big_blind) = blinds_from(level_stakes, &unit);
    let level_ante = level_stakes
        .split('/')
        .nth(2)
        .map_or(0, |part| parse_amount(part, &unit));
    let level_number = level_number_of(level_label)
        .map_err(|_| ParseError::Bug(unrepresentable("a level number").message))?;

    let tournament = PhfTournament {
        id: id.to_owned(),
        name,
        buy_in: buy_in.buy_in,
        bounty: Some(buy_in.bounty),
        fee: buy_in.fee,
        buy_in_unit,
        level_label: Some(level_label.to_owned()),
        level_number,
        level_small_blind: small_blind,
        level_big_blind: big_blind,
        level_ante,
        bounties: Vec::new(),
        prize_pool: None,
    };
    let game = DraftGame {
        variant: variant_from_label(&label),
        limit: limit_from_label(&label),
        format: GameFormat::Tournament,
        label,
        unit,
        small_blind,
        big_blind,
    };
    Ok(Some((tournament, game)))
}

/// `parseHeader`.
fn parse_header(line: &str) -> Result<Option<Header>, ParseError> {
    let Some(c) = HEADER.captures(line) else {
        return Ok(None);
    };
    let hand_id = c[1].to_owned();
    let payload = c.get(2).map_or("", |m| m.as_str()).to_owned();
    // `handId.slice(0, 2).toUpperCase()`: the id is ASCII.
    let prefix: String = hand_id.chars().take(2).collect();
    let product = product_for(&js::to_upper_case(&prefix));
    let played_at = parse_played_at(&payload);

    if let Some((tournament, game)) = parse_tournament(&payload)? {
        return Ok(Some(Header {
            hand_id,
            product,
            payload,
            game,
            tournament: Some(tournament),
            played_at,
        }));
    }

    let Some(cash) = CASH.captures(&payload) else {
        return Ok(None);
    };
    let label = js::trim(&cash[1]).to_owned();
    let Some(unit) = unit_for(&cash[2]) else {
        return Ok(None);
    };
    let (small_blind, big_blind) = blinds_from(&cash[2], &unit);
    let game = DraftGame {
        variant: variant_from_label(&label),
        limit: limit_from_label(&label),
        format: GameFormat::Cash,
        label,
        unit,
        small_blind,
        big_blind,
    };
    Ok(Some(Header {
        hand_id,
        product,
        payload: payload.clone(),
        game,
        tournament: None,
        played_at,
    }))
}

/// `parseSummaryFees`: every promo column read on its own, zero when absent.
fn parse_summary_fees(line: &str, unit: &CurrencyUnit) -> PhfFees {
    let [rake, jackpot, bingo, fortune, tax] = FEE_COLUMNS.each_ref().map(|column| {
        column
            .captures(line)
            .map_or(0, |c| parse_amount(&c[1], unit))
    });
    PhfFees {
        rake,
        jackpot,
        bingo,
        fortune,
        tax,
        ..PhfFees::ZERO
    }
}

/// `parseOneHand`.
#[allow(clippy::too_many_lines)]
fn parse_one_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(strip_bom(raw));
    let lines = to_lines(text);
    let first = lines.first().copied().unwrap_or("");
    if has_unsupported_currency(first) {
        return Err(skip(
            SkipReason::UnsupportedCurrency,
            format!("PHF has no unit for the currency in \"{first}\"."),
        ));
    }
    let Some(header) = parse_header(first)? else {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The hand has no GG header line.",
        ));
    };

    // Hi/lo first (with no hi/lo variant at all), then the variant lock.
    if let Some(refusal) = unsupported_game_skip(&header.game.label, &[]) {
        return Err(refusal.into());
    }
    if let Some(refusal) = unsupported_variant_skip(&header.game.label, GGPOKER_VARIANTS) {
        return Err(refusal.into());
    }
    // All-in-or-Fold's `*** PREFLOP ***` layout: one unverified sample.
    if matches_at_line_start(&PREFLOP_MARKER, text) {
        return Err(skip(
            SkipReason::UnsupportedFormat,
            "This hand uses the All-in-or-Fold street layout - a `*** PREFLOP ***` marker and no \
             flop marker - which no verified GGPoker export in the corpus writes. The board would \
             have to come from the SUMMARY block rather than from the deal, so the hand is \
             refused rather than reconstructed.",
        ));
    }
    if ctx.options.cash_only && header.tournament.is_some() {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped because the converter is in cash-only mode.",
        ));
    }

    let unit = header.game.unit.clone();
    let header_big_blind = header.game.big_blind;
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "ggpoker".to_owned(),
        site_name: "GGPoker".to_owned(),
        parser_id: "ggpoker".to_owned(),
        parser_version: GGPOKER_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        // GG ids are unique network-wide and rows stored before this parser
        // keyed on the bare id, so a re-upload still dedupes.
        hand_key: header.hand_id.clone(),
        raw_text: text.to_owned(),
        original_filename: ctx.source_filename.map(str::to_owned),
        game: header.game.clone(),
        tournament: header.tournament.clone(),
        played_at: header.played_at.clone(),
        text_style: PhfTextStyle {
            decimals: detect_decimals(text),
            pad_hour: detect_pad_hour(&header.payload),
            ..PhfTextStyle::default()
        },
        repair_missing_uncalled: false,
        parsed_at: ctx.parsed_at().to_owned(),
    });

    let money = |value: &str| parse_amount(value, &unit);
    let mut in_summary = false;
    // A runout name printed on its own line, waiting for its `Board` line.
    let mut pending_board_label = String::new();

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let raw_line = *raw_line;
        let line = js::trim(raw_line);
        let line_no = line_number(i);
        if line.is_empty() {
            continue;
        }

        if SUMMARY.is_match(line) {
            in_summary = true;
            continue;
        }

        if in_summary {
            if let Some(pot) = TOTAL_POT.captures(line) {
                let before_pipe = line.split('|').next().unwrap_or("");
                let pots: Vec<PhfPot> = POTS
                    .captures_iter(before_pipe)
                    .map(|entry| PhfPot {
                        name: format!("{}{}", &entry[1], entry.get(2).map_or("", |m| m.as_str())),
                        amount: money(&entry[3]),
                    })
                    .collect();
                draft.summary_pot(money(&pot[1]), pots, parse_summary_fees(line, &unit));
                continue;
            }
            if RUN_TIMES.is_match(line) {
                draft.note_run_it_twice();
                continue;
            }
            // Fixture 12: `FIRST` on its own line, then `Board [..]`.
            if BOARD_LABEL_LINE.is_match(line) {
                line.clone_into(&mut pending_board_label);
                continue;
            }
            if let Some(board) = BOARD.captures(line) {
                let label = js::trim(
                    board
                        .get(1)
                        .map_or(pending_board_label.as_str(), |m| m.as_str()),
                )
                .to_owned();
                pending_board_label.clear();
                draft.summary_board(runout_index_for_label(&label), extract_cards(&board[2]));
                continue;
            }
            if let Some(seat) = SUMMARY_SEAT.captures(line) {
                // A seat beyond `u32` can match no player; it is dropped.
                if let Some(number) = number_u32(&seat[1]) {
                    draft.summary_seat(number, line);
                }
                continue;
            }
            if CHATTER.is_match(line) {
                continue;
            }
            draft.warn("unknown-summary-line", line, line_no);
            continue;
        }

        if let Some(table) = TABLE.captures(line) {
            // Rush & Cash: the product code or the table name.
            let name = table.get(1).map_or("", |m| m.as_str());
            let fast_fold = (header.product == Some("Rush & Cash") || RUSH_TABLE.is_match(name))
                .then(|| "Rush & Cash".to_owned());
            let max_seats = u32_or_bug(&table[2], "a table size")?;
            let button = match table.get(4) {
                Some(m) => Some(u32_or_bug(m.as_str(), "a button seat")?),
                None => None,
            };
            draft.set_table(
                (!name.is_empty()).then(|| name.to_owned()),
                max_seats,
                button,
                fast_fold,
            );
            continue;
        }

        if let Some(seat) = SEAT.captures(line) {
            let number = u32_or_bug(&seat[1], "a seat number")?;
            draft.seat(
                number,
                &seat[2],
                money(&seat[3]),
                SITTING_OUT_TAIL.is_match(seat.get(4).map_or("", |m| m.as_str())),
            );
            continue;
        }

        if let Some(marker) = MARKER.captures(line) {
            let label = marker.get(1).map_or("", |m| m.as_str());
            let cards = last_bracket_cards(marker.get(3).map_or("", |m| m.as_str()));
            draft.marker(
                marker_kind(&marker[2]),
                runout_index_for_label(label),
                label,
                &cards,
            );
            continue;
        }

        if HOLE_CARDS.is_match(line) {
            draft.hole_cards_marker();
            continue;
        }
        // A bomb pot is carried on `game.bombPot`, derived from the antes.
        if BOMB_POT.is_match(line) {
            continue;
        }

        // `Dealt to <name> `: dealt in, cards not shown.
        if let Some(dealt) = DEALT.captures(raw_line) {
            let cards = dealt
                .get(2)
                .filter(|m| !m.as_str().is_empty())
                .map(|m| extract_cards(m.as_str()))
                .unwrap_or_default();
            draft.dealt(js::trim(&dealt[1]), cards);
            continue;
        }

        if let Some(uncalled) = UNCALLED.captures(line) {
            draft.uncalled(js::trim(&uncalled[2]), money(&uncalled[1]), line_no, line);
            continue;
        }

        if let Some(collected) = COLLECTED.captures(line) {
            draft.collect(
                js::trim(&collected[1]),
                money(&collected[2]),
                &collected[3],
                line_no,
                line,
            );
            continue;
        }

        if let Some(ante) = ANTE.captures(line) {
            draft.post(
                &ante[1],
                ActionType::Ante,
                money(&ante[2]),
                PostOptions {
                    all_in: all_in_from(ante.get(3)),
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        // `button` is short deck's only blind: a big blind with a verb.
        if let Some(blind) = BLIND.captures(line) {
            let kind = js::to_lower_case(&blind[2]);
            draft.post(
                &blind[1],
                if kind == "small" {
                    ActionType::SmallBlind
                } else {
                    ActionType::BigBlind
                },
                money(&blind[3]),
                PostOptions {
                    all_in: all_in_from(blind.get(4)),
                    verb: (kind == "button").then_some(BUTTON_BLIND_VERB),
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(missed) = MISSED.captures(line) {
            draft.post(
                &missed[1],
                ActionType::MissedBlind,
                money(&missed[2]),
                PostOptions {
                    all_in: false,
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        // The bare `straddle` verb states the street total, like a raise's
        // `to`; the chips added go on the action.
        if let Some(straddle) = STRADDLE.captures(line) {
            let to = money(&straddle[2]);
            let added = to.saturating_sub(draft.committed(&straddle[1]));
            draft.post(
                &straddle[1],
                ActionType::Straddle,
                added,
                PostOptions {
                    all_in: all_in_from(straddle.get(3)),
                    verb: Some("straddle"),
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(post) = POST.captures(line) {
            let amount = money(&post[3]);
            let named = post.get(2).is_some_and(|m| !m.as_str().is_empty());
            // An unnamed preflop `posts` above the big blind is a straddle.
            let straddle =
                named || (draft.current_street() == Street::Preflop && amount > header_big_blind);
            draft.post(
                &post[1],
                if straddle {
                    ActionType::Straddle
                } else {
                    ActionType::MissedBlind
                },
                amount,
                PostOptions {
                    all_in: all_in_from(post.get(4)),
                    verb: named.then_some("posts straddle"),
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(simple) = SIMPLE.captures(line) {
            let kind = if &simple[2] == "folds" {
                ActionType::Fold
            } else {
                ActionType::Check
            };
            draft.simple(&simple[1], kind, Vec::new(), line_no, line);
            continue;
        }

        if let Some(wager) = WAGER.captures(line) {
            let kind = if &wager[2] == "calls" {
                ActionType::Call
            } else {
                ActionType::Bet
            };
            draft.wager(
                &wager[1],
                kind,
                money(&wager[3]),
                all_in_from(wager.get(4)),
                line_no,
                line,
            );
            continue;
        }

        if let Some(raise) = RAISE.captures(line) {
            draft.raise_to(
                &raise[1],
                money(&raise[3]),
                all_in_from(raise.get(4)),
                line_no,
                line,
            );
            continue;
        }

        if let Some(shows) = SHOWS.captures(line) {
            draft.show(
                &shows[1],
                extract_cards(&shows[2]),
                shows.get(3).map(|m| m.as_str()),
                line_no,
                line,
            );
            continue;
        }

        if let Some(muck) = MUCK.captures(line) {
            draft.muck(&muck[1], &muck[2], line_no, line);
            continue;
        }

        // EV Cashout settles with GG, not out of the pot.
        if let Some(choose) = CASHOUT_CHOOSE.captures(line) {
            draft.cashout(&choose[1], ActionType::CashoutChoose, 0, line_no, line);
            continue;
        }
        if let Some(pay) = CASHOUT_PAY.captures(line) {
            draft.cashout(
                &pay[1],
                ActionType::CashoutPay,
                money(&pay[2]),
                line_no,
                line,
            );
            continue;
        }

        // All-in Insurance: a different product, recorded as a warning.
        if let Some(insurance) = INSURANCE.captures(line) {
            if !draft.is_seated(&insurance[1]) {
                draft.warn("unknown-line", line, line_no);
                continue;
            }
            draft.warn("all-in-insurance", line, line_no);
            continue;
        }

        // A house-funded chip drop: a chip movement, not a contribution.
        if let Some(drop) = CASH_DROP.captures(line) {
            draft.chip_movement(PhfChipMovement {
                kind: "cash-drop".to_owned(),
                from_seat: None,
                from_player: None,
                to_pot: true,
                amount: money(&drop[1]),
                raw: Some(line.to_owned()),
                anchor: ChipMovementAnchor::BeforePostings,
            });
            continue;
        }

        if CHATTER.is_match(line) {
            continue;
        }

        draft.warn("unknown-line", line, line_no);
    }

    if draft.player_count() == 0 {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The hand has no seat lines.",
        ));
    }
    // GG names the observer literally `Hero`; `Dealt to` is the fallback.
    if draft.is_seated("Hero") {
        draft.set_hero("Hero");
    }

    let hand = match draft.build() {
        Ok(hand) => hand,
        Err(BuildError::Thrown(thrown)) => return Err(ParseError::Bug(thrown.message)),
        Err(BuildError::UnseatedStraddler) => {
            return Err(unseated(draft.first_unseated_actor().unwrap_or_default()));
        }
    };

    if let Some(stranger) = draft.first_unseated_actor() {
        return Err(unseated(stranger));
    }

    Ok(hand)
}

/// `ggpokerParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct GgPokerParser;

impl SiteParser for GgPokerParser {
    fn id(&self) -> &'static str {
        "ggpoker"
    }

    fn name(&self) -> &'static str {
        "GGPoker"
    }

    fn version(&self) -> &'static str {
        GGPOKER_PARSER_VERSION
    }

    /// 0.95 for GG's own products and branding, 0.86 for the plain cash
    /// dialect (under `standard`'s 0.9 on purpose), 0 for anything carrying
    /// another room's name.
    fn detect(&self, text: &str) -> u32 {
        let head = strip_bom(text);
        if !HEADER_PREFIX.is_match(head) && !ANY_HEADER.is_match(head) {
            return 0;
        }
        if FOREIGN_BRANDING.is_match(head) {
            return 0;
        }
        if GG_BRANDING.is_match(head)
            || GG_PRODUCT.is_match(head)
            || matches_at_line_start(&GG_GAME_LABEL, head)
            || GG_INSURANCE.is_match(head)
            || GG_TOURNAMENT.is_match(head)
        {
            return 950;
        }
        if matches_at_line_start(&GG_FEE_LINE, head) || EV_CASHOUT.is_match(head) {
            return 860;
        }
        0
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        let normalized = normalize_newlines(strip_bom(text));
        Ok(split_before_line_starts(&normalized, &SPLIT_AT)
            .into_iter()
            .map(|chunk| js::trim(strip_bom(chunk)))
            .filter(|chunk| HEADER_PREFIX.is_match(chunk))
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_one_hand(raw, ctx)
    }

    fn short_deck(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests;

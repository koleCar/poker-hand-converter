//! `pokerstars`: PokerStars (`web/src/lib/parsers/pokerstars.ts`).
//!
//! The reference dialect every other room imitates: cash and tournament,
//! Zoom, Home Games, play money, every currency, antes, run-it-twice, side
//! pots, sit-outs and disconnects. The hand semantics are
//! [`StarsHandDraft`]'s; the line grammar below is PokerStars' own.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `pokerstars.ts`). Detection's `.{0,40}` counts UTF-16 code units in
//! JavaScript, so that one probe is written out as code.

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
use super::shared::variant_lock::{HOLDEM_OMAHA, OMAHA_HI_LO, unsupported_variant_skip};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, SiteParser, SiteParserContext, SkipReason, SplitError, unsupported_game_skip,
};
use crate::js;
use crate::phf::hilo::{NO_LOW_LINE, check_no_low_stated};
use crate::phf::money::CHIPS;
use crate::phf::{
    ActionType, Amount, CurrencyUnit, GameFormat, PhfFees, PhfHand, PhfPot, PhfTextStyle,
    PhfTournament, Variant, parse_amount, parse_buy_in_token,
};

/// `POKERSTARS_PARSER_VERSION`.
pub const POKERSTARS_PARSER_VERSION: &str = "1.0.0";

/// `POKERSTARS_VARIANTS`: Hold'em and four-card Omaha.
const POKERSTARS_VARIANTS: &[Variant] = HOLDEM_OMAHA;
/// `POKERSTARS_HI_LO`: four-card Omaha Hi/Lo.
const POKERSTARS_HI_LO: &[Variant] = OMAHA_HI_LO;

static HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^PokerStars(?: ([A-Za-z ]+?))? (?:Hand|Game) #(\d+):\s*(?:\{([^}]*)\}\s*)?(.*)$",
    ""
);
/// `HEADER_PREFIX`, also the body of `splitHands`' lookahead.
static HEADER_PREFIX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^PokerStars(?: [A-Za-z ]+?)? (?:Hand|Game) #\d+:", "");
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

/// `SUFFIX`: the trailing clauses of a wager. A CAP table's `and has reached
/// the $40 cap` is not all-in.
const SUFFIX: &str = r"((?: and (?:is all-in|has reached the \S+ cap))*)";
static ALL_IN: LazyLock<Regex> = crate::js_regex_lazy!(r"and is all-in", "");

fn all_in_from(suffix: Option<regex::Match<'_>>) -> bool {
    suffix.is_some_and(|m| !m.as_str().is_empty() && ALL_IN.is_match(m.as_str()))
}

/// The members of `CHATTER_REGEX` (joined with `|`, flag `i`).
const CHATTER_MEMBERS: [&str; 19] = [
    r#"\bsaid, ""#,
    r"\bjoins the table at seat #\d+",
    r"\bleaves the table\b",
    r"\bis sitting out\b",
    r"\bsits out\b",
    r"\bhas returned\b",
    r"\bstands up\b",
    r"\bhas timed out\b",
    r"\bis (?:dis)?connected\b",
    r"\bwas removed from the table for failing to post\b",
    r"\bwill be allowed to play after the button\b",
    r"\bhas requested TIME\b",
    r"\bis feeling\b",
    r"\bfinished the tournament in\b",
    r"\bwins the tournament and receives\b",
    r"\bre-buys and receives\b",
    r"\breceives? an add-on\b",
    r"\bhas been disconnected\b",
    r"\bLevel changed\b",
];
static CHATTER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&CHATTER_MEMBERS.join("|"), "i"));

static BOUNTY: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?) wins (?:the )?(\S+) (?:bounty|for splitting the elimination)\b.*$",
    ""
);

static BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\s*(\S+)\/(\S+)", "");
static TOURNAMENT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Tournament #(\S+?), (.+?) - (?:Match Round ([IVXLCDM]+), )?Level ([^\s(]+)\s*\(([^)]*)\)\s+-\s+(.*)$",
    ""
);
static BUY_IN_SPLIT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(\S+(?:\+\S+)*)\s+(?:(USD|EUR|GBP|CAD|CNY|NOK|SEK|INR|RUB)\s+)?(.+)$",
    ""
);
static CASH: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$", "");

static RAKE: LazyLock<Regex> = LazyLock::new(|| template_regex(r"Rake ${MONEY}", "", ""));
static SPIN_OFF: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\b(?:Fusion|Split Hold'?em|Unfold|Power Up|Tempest)\b",
    "i"
);
static CANCELLED: LazyLock<Regex> = crate::js_regex_lazy!(r"^Hand cancelled\s*$", "i");
static PRE_FLOP: LazyLock<Regex> = crate::js_regex_lazy!(r"pre-?flop", "i");
static POST_FLOP: LazyLock<Regex> = crate::js_regex_lazy!(r"post-?flop", "i");

static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY\s*\*\*\*", "i");
static TOTAL_POT: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Total pot ${MONEY}", "", ""));
static POTS: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"(Main|Side) pot(-\d+)? ${MONEY}\.", "", "g"));
static RUN_TWICE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Hand was run (?:twice|two times|three times|four times)$",
    "i"
);
static BOARD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+):", "");
static ZOOM_PRODUCT: LazyLock<Regex> = crate::js_regex_lazy!(r"Zoom", "");
static ZOOM_TABLE: LazyLock<Regex> = crate::js_regex_lazy!(r"\bZoom\b", "");
static SITTING_OUT_TAIL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bis sitting out\b", "i");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS\s*\*\*\*", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$", "");
static UNCALLED: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Uncalled bet \(${MONEY}\) returned to (.+)$", "", ""));
static COLLECTED: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?) collected ${MONEY} from (?:the )?(.+?)$", "", ""));
static ANTE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): posts the ante ${MONEY}${SUFFIX}$", SUFFIX, ""));
static BLIND: LazyLock<Regex> = LazyLock::new(|| {
    template_regex(
        r"^(.+?): posts (small|big) blind ${MONEY}${SUFFIX}$",
        SUFFIX,
        "",
    )
});
static BOTH_BLINDS: LazyLock<Regex> = LazyLock::new(|| {
    template_regex(
        r"^(.+?): posts small (?:&|and) big blinds? ${MONEY}${SUFFIX}$",
        SUFFIX,
        "",
    )
});
static DEAD: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): posts ${MONEY}${SUFFIX}$", SUFFIX, ""));
static SIMPLE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): (folds|checks)(?: \[([^\]]*)\])?$", "");
static WAGER: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): (calls|bets) ${MONEY}${SUFFIX}$", SUFFIX, ""));
static RAISE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$", SUFFIX, ""));
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$", "");
static MUCK: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): (mucks hand|doesn't show hand)$", "i");
static SITTING_OUT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)[: ]+(?:is sitting out|sits out)\s*$", "i");
static BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(r"\bPokerStars\b", "");

/// What the header says (`Header`; `playMoney` is unused and left out).
struct Header {
    hand_id: String,
    product: String,
    club_tag: Option<String>,
    payload: String,
    game: DraftGame,
    tournament: Option<PhfTournament>,
    played_at: Option<String>,
}

/// `blindsFrom`: `$0.25/$0.50 - $10 Cap -  USD` → the two blinds.
fn blinds_from(stakes_text: &str, unit: &CurrencyUnit) -> (Amount, Amount) {
    match BLINDS.captures(stakes_text) {
        Some(c) => (parse_amount(&c[1], unit), parse_amount(&c[2], unit)),
        None => (0, parse_amount(js::trim(stakes_text), unit)),
    }
}

/// `unitFor`: `None` for a currency PHF cannot represent.
fn unit_for(stakes_text: &str) -> Option<CurrencyUnit> {
    unit_for_stakes(stakes_text, &CHIPS.unit())
}

/// `level_number_of`, with the TypeScript's out-of-`u32` number as an error.
fn level_number(label: &str) -> Result<Option<u32>, ParseError> {
    level_number_of(label).map_err(|_| ParseError::Bug(unrepresentable("a level number").message))
}

/// `parseTournament`.
fn parse_tournament(payload: &str) -> Result<Option<(PhfTournament, DraftGame)>, ParseError> {
    let Some(c) = TOURNAMENT.captures(payload) else {
        return Ok(None);
    };
    let id = &c[1];
    let buy_in_and_game = &c[2];
    let level_label = &c[4];
    let level_stakes = &c[5];

    let split = BUY_IN_SPLIT.captures(buy_in_and_game);
    let buy_in_token = split
        .as_ref()
        .map_or("", |s| s.get(1).map_or("", |m| m.as_str()));
    let code = split.as_ref().and_then(|s| s.get(2)).map(|m| m.as_str());
    let buy_in_unit = buy_in_unit_for(buy_in_token, code);
    let buy_in = parse_buy_in_token(buy_in_token, &buy_in_unit);
    let label = js::trim(
        split
            .as_ref()
            .and_then(|s| s.get(3))
            .map_or(buy_in_and_game, |m| m.as_str()),
    )
    .to_owned();

    let Some(unit) = unit_for(level_stakes) else {
        return Ok(None);
    };
    let (small_blind, big_blind) = blinds_from(level_stakes, &unit);
    let level_ante = level_stakes
        .split('/')
        .nth(2)
        .map_or(0, |part| parse_amount(part, &unit));

    let tournament = PhfTournament {
        id: id.to_owned(),
        // PokerStars prints only the id, no name.
        name: None,
        buy_in: buy_in.buy_in,
        bounty: Some(buy_in.bounty),
        fee: buy_in.fee,
        buy_in_unit,
        level_label: Some(level_label.to_owned()),
        level_number: level_number(level_label)?,
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
    let hand_id = c[2].to_owned();
    let product = c.get(1).map_or("", |m| m.as_str()).to_owned();
    let club_tag = c.get(3).map(|m| m.as_str().to_owned());
    let payload = c.get(4).map_or("", |m| m.as_str()).to_owned();
    let played_at = parse_played_at(&payload);

    if let Some((tournament, game)) = parse_tournament(&payload)? {
        return Ok(Some(Header {
            hand_id,
            product,
            club_tag,
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
    let stakes_text = &cash[2];
    let Some(unit) = unit_for(stakes_text) else {
        return Ok(None);
    };
    let (small_blind, big_blind) = blinds_from(stakes_text, &unit);
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
        club_tag,
        payload: payload.clone(),
        game,
        tournament: None,
        played_at,
    }))
}

/// `parseSummaryFees`: PokerStars prints `| Rake $x` and nothing else.
fn parse_summary_fees(line: &str, unit: &CurrencyUnit) -> PhfFees {
    PhfFees {
        rake: RAKE.captures(line).map_or(0, |c| parse_amount(&c[1], unit)),
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
            "The hand has no PokerStars header line.",
        ));
    };

    // Hi/lo first, so a refused one keeps naming the real reason.
    if let Some(refusal) = unsupported_game_skip(&header.game.label, POKERSTARS_HI_LO) {
        return Err(refusal.into());
    }
    if let Some(refusal) = unsupported_variant_skip(&header.game.label, POKERSTARS_VARIANTS) {
        return Err(refusal.into());
    }
    // Fusion, Split Hold'em, Unfold, ...: Hold'em by name, not by deal.
    if SPIN_OFF.is_match(&header.game.label) {
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "{} deals differently from Hold'em and is not supported yet.",
                header.game.label
            ),
        ));
    }
    if ctx.options.cash_only && header.tournament.is_some() {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped because the converter is in cash-only mode.",
        ));
    }
    if lines.iter().any(|line| CANCELLED.is_match(js::trim(line))) {
        return Err(skip(
            SkipReason::HandCancelled,
            "PokerStars cancelled the hand.",
        ));
    }

    let unit = header.game.unit.clone();
    let buy_in_unit = header.tournament.as_ref().map(|t| t.buy_in_unit.clone());
    let header_big_blind = header.game.big_blind;
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "pokerstars".to_owned(),
        site_name: "PokerStars".to_owned(),
        parser_id: "pokerstars".to_owned(),
        parser_version: POKERSTARS_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        // Bare integers, namespaced against other rooms' numeric ids.
        hand_key: format!("PS{}", header.hand_id),
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
        // 2011-era exports that drop the uncalled return (fixtures 07, 08).
        repair_missing_uncalled: true,
        parsed_at: ctx.parsed_at().to_owned(),
    });

    // `if (header.clubTag)`: an empty `{}` tag is falsy.
    if let Some(club) = header.club_tag.as_ref().filter(|tag| !tag.is_empty()) {
        draft.warn("home-game", format!("Home Game hand from {club}."), None);
    }
    if PRE_FLOP.is_match(&header.game.label) && POST_FLOP.is_match(&header.game.label) {
        draft.warn(
            "mixed-betting-structure",
            format!(
                "\"{}\" caps preflop and postflop differently; game.limit records the preflop \
                 cap only.",
                header.game.label
            ),
            None,
        );
    }

    let money = |value: &str| parse_amount(value, &unit);
    let mut in_summary = false;
    let mut no_low_stated = false;

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
                // `Side pot-1 $60.`: the index sits after the word "pot".
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
            if RUN_TWICE.is_match(line) {
                draft.note_run_it_twice();
                continue;
            }
            if let Some(board) = BOARD.captures(line) {
                let label = js::trim(board.get(1).map_or("", |m| m.as_str()));
                draft.summary_board(runout_index_for_label(label), extract_cards(&board[2]));
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
            // Zoom: the header product word (newer exports) or the table name
            // (older ones).
            let name = table.get(1).map_or("", |m| m.as_str());
            let zoom = ZOOM_PRODUCT.is_match(&header.product) || ZOOM_TABLE.is_match(name);
            let max_seats = u32_or_bug(&table[2], "a table size")?;
            let button = match table.get(4) {
                Some(m) => Some(u32_or_bug(m.as_str(), "a button seat")?),
                None => None,
            };
            draft.set_table(
                (!name.is_empty()).then(|| name.to_owned()),
                max_seats,
                button,
                zoom.then(|| "Zoom".to_owned()),
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
            // `*** TURN *** [Th Kh Ac] [9d]`: the last group is the new card.
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

        if let Some(blind) = BLIND.captures(line) {
            let kind = if js::to_lower_case(&blind[2]) == "small" {
                ActionType::SmallBlind
            } else {
                ActionType::BigBlind
            };
            draft.post(
                &blind[1],
                kind,
                money(&blind[3]),
                PostOptions {
                    all_in: all_in_from(blind.get(4)),
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        // Both blinds at once: the big is live, the small dead.
        if let Some(both) = BOTH_BLINDS.captures(line) {
            let total = money(&both[2]);
            let big = total.min(if header_big_blind != 0 {
                header_big_blind
            } else {
                total
            });
            draft.post(
                &both[1],
                ActionType::BigBlind,
                big,
                PostOptions {
                    all_in: all_in_from(both.get(3)),
                    verb: Some("posts small & big blinds"),
                    line: line_no,
                    raw_line: line,
                },
            );
            if total > big {
                draft.post(
                    &both[1],
                    ActionType::MissedBlind,
                    total.saturating_sub(big),
                    PostOptions {
                        all_in: false,
                        verb: None,
                        line: line_no,
                        raw_line: line,
                    },
                );
            }
            continue;
        }

        if let Some(dead) = DEAD.captures(line) {
            // PokerStars has no straddle: a bare `posts` is dead money.
            draft.post(
                &dead[1],
                ActionType::MissedBlind,
                money(&dead[2]),
                PostOptions {
                    all_in: all_in_from(dead.get(3)),
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        // `Player6: folds [Ks]`: a card exposed on the way out (fixture 41).
        if let Some(simple) = SIMPLE.captures(line) {
            let exposed = simple
                .get(3)
                .filter(|m| !m.as_str().is_empty())
                .map(|m| extract_cards(m.as_str()));
            if let Some(exposed) = exposed.as_ref().filter(|cards| !cards.is_empty()) {
                draft.warn(
                    "reveal-not-serializable",
                    format!(
                        "{} exposed {} while folding; standard text has no line shape for that \
                         and will not reproduce it.",
                        &simple[1],
                        exposed.join(" ")
                    ),
                    line_no,
                );
            }
            let kind = if &simple[2] == "folds" {
                ActionType::Fold
            } else {
                ActionType::Check
            };
            draft.simple(&simple[1], kind, exposed.unwrap_or_default(), line_no, line);
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

        // Knockout awards move money outside the pot: onto the player.
        if let Some(bounty) = BOUNTY.captures(line)
            && draft.is_seated(&bounty[1])
        {
            let bounty_unit = buy_in_unit.as_ref().unwrap_or(&unit);
            draft.set_bounty(&bounty[1], parse_amount(&bounty[2], bounty_unit));
            continue;
        }

        // Hi/lo: the whole pot went high; checked against the halves later.
        if NO_LOW_LINE.is_match(line) {
            no_low_stated = true;
            continue;
        }

        if CHATTER.is_match(line) {
            // The name is what precedes the phrase (`Kuca :P: is sitting out`).
            if let Some(sitting_out) = SITTING_OUT.captures(line) {
                draft.mark_sitting_out(&sitting_out[1]);
            }
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

    let mut hand = match draft.build() {
        Ok(hand) => hand,
        Err(BuildError::Thrown(thrown)) => return Err(ParseError::Bug(thrown.message)),
        Err(BuildError::UnseatedStraddler) => {
            return Err(unseated(draft.first_unseated_actor().unwrap_or_default()));
        }
    };
    if no_low_stated {
        let warnings = check_no_low_stated(&hand);
        hand.meta.warnings.extend(warnings);
    }

    // Actors missing from the hand's own seat block (fixture 18's
    // `neverJa(1)ger` / `neverJager`) would be attributed to nobody.
    if let Some(stranger) = draft.first_unseated_actor() {
        return Err(unseated(stranger));
    }

    Ok(hand)
}

/// `/(?:^|[\r\n])PokerStars.{0,40}#\d+:/.test(text)`, with JavaScript's `.`
/// counting UTF-16 code units (an astral character is two).
fn header_anywhere(text: &str) -> bool {
    const WORD: &str = "PokerStars";
    text.match_indices(WORD).any(|(at, _)| {
        if at > 0 && !matches!(text.as_bytes()[at - 1], b'\r' | b'\n') {
            return false;
        }
        let mut pos = at + WORD.len();
        let mut units = 0;
        loop {
            if hash_digits_colon(&text[pos..]) {
                return true;
            }
            let Some(c) = text[pos..].chars().next() else {
                return false;
            };
            if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                return false;
            }
            units += c.len_utf16();
            if units > 40 {
                return false;
            }
            pos += c.len_utf8();
        }
    })
}

/// `#\d+:` at the start of `text`.
fn hash_digits_colon(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('#') else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && rest.as_bytes().get(digits) == Some(&b':')
}

/// `pokerstarsParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PokerStarsParser;

impl SiteParser for PokerStarsParser {
    fn id(&self) -> &'static str {
        "pokerstars"
    }

    fn name(&self) -> &'static str {
        "PokerStars"
    }

    fn version(&self) -> &'static str {
        POKERSTARS_PARSER_VERSION
    }

    /// 0.95 for a header (no other site writes `PokerStars`), 0.3 for the
    /// branding alone (a truncated paste or a tournament summary).
    fn detect(&self, text: &str) -> u32 {
        if HEADER_PREFIX.is_match(strip_bom(text)) || header_anywhere(text) {
            return 950;
        }
        if BRANDING.is_match(text) {
            return 300;
        }
        0
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        // Line endings first: bare-`\r` exports exist.
        let normalized = normalize_newlines(strip_bom(text));
        Ok(split_before_line_starts(&normalized, &HEADER_PREFIX)
            .into_iter()
            .map(|chunk| js::trim(strip_bom(chunk)))
            .filter(|chunk| HEADER_PREFIX.is_match(chunk))
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_one_hand(raw, ctx)
    }

    fn hi_lo_variants(&self) -> &'static [Variant] {
        POKERSTARS_HI_LO
    }
}

#[cfg(test)]
mod tests;

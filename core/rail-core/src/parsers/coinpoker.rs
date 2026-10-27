//! `coinpoker`: CoinPoker (`web/src/lib/parsers/coinpoker.ts`).
//!
//! A PokerStars-family grammar: the semantics are [`StarsHandDraft`]'s, the
//! line grammar below is CoinPoker's own. What differs from PokerStars:
//!
//! - `p: raises 4987 and is all-in` carries one amount, the chips *added*,
//!   and no `to`; both raise forms occur in one hand.
//! - Amounts carry no currency symbol; cash tables are USDT (the `₮` in the
//!   table name), held as `USDT` with the symbol `$`.
//! - `(0.01/0.02 )` with a trailing space, no ` - ` before the timestamp,
//!   seat lines with a suffix after the paren (`out of hand`), one blank line
//!   between hands.
//! - `*** HAND CANCELLED ***` is refused; an amount with more decimals than
//!   the unit holds is refused (`unsupported-precision`) rather than rounded.
//!
//! After `build`, each SUMMARY seat result is edited in place: the
//! `(straddle)` tag is lifted out and the rest re-read, and the room's own
//! prose (`raw`) is dropped when the outcome classified, so the serializer
//! regenerates the line with symbols. The hand is owned here, so the edits
//! are on the returned hand exactly as the TypeScript's are on its object.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `coinpoker.ts`).

use std::sync::LazyLock;

use regex::Regex;

use super::shared::ps_gg_hand::{
    BuildError, DraftGame, DraftInit, MarkerKind, PostOptions, StarsHandDraft, last_bracket_cards,
    limit_from_label, line_number, marker_kind, number_u32, parse_played_at, parse_summary_seat,
    skip, split_before_line_starts, strip_bom, to_lines, u32_or_bug, unseated, variant_from_label,
};
use crate::cards::extract_cards;
use crate::detect::{ParseError, SiteParser, SiteParserContext, SkipReason, SplitError};
use crate::js;
use crate::phf::money::{CHIPS, unit_for_code};
use crate::phf::{
    ActionType, CurrencyUnit, DecimalStyle, GameFormat, PhfFees, PhfHand, PhfPlayerResult,
    PhfTextStyle, PhfTournament, SeatOutcome, Variant, parse_amount,
};

/// `COINPOKER_PARSER_VERSION`.
pub const COINPOKER_PARSER_VERSION: &str = "1.0.0";

/// `CASH_UNIT`: `unitForCode("USDT", "$")` - the real currency, a symbol the
/// standard text can write and read back.
fn cash_unit() -> CurrencyUnit {
    unit_for_code("USDT", Some("$"))
}

/// `STAMP`.
const STAMP: &str = r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}";
/// `NUM`: a bare decimal with at most two places.
const NUM: &str = r"(\d+(?:\.\d{1,2})?)";

/// A `String.raw` template with `${NUM}` and `${STAMP}` filled in.
fn template(template: &str, flags: &str) -> Regex {
    js::regex::js_regex(
        &template.replace("${NUM}", NUM).replace("${STAMP}", STAMP),
        flags,
    )
}

macro_rules! template_lazy {
    ($template:expr) => {
        LazyLock::new(|| template($template, ""))
    };
}

static HEADER_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^CoinPoker Hand #\d+:", "");
static HEADER: LazyLock<Regex> = crate::js_regex_lazy!(r"^CoinPoker Hand #(\d+): (.*)$", "");
static CASH: LazyLock<Regex> = template_lazy!(r"^(.+?) \(${NUM}/${NUM} \) (${STAMP}) GMT$");
static TOUR: LazyLock<Regex> = template_lazy!(
    r"^Tournament #(\d+), (.+) \((\d+)/(\d+)(?: ante (\d+))?(?: play)?\) (${STAMP}) GMT$"
);
static TOUR_NAME_AND_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.*?)\s*((?:\d[\s-]*Card\s+)?(?:Hold'?em|Omaha(?:\s+Hi\/Lo)?|Short\s*Deck|Stud(?:\s+Hi\/Lo)?|Razz|Badugi|(?:Triple\s+)?Draw)(?:\s+(?:No|Pot|Fixed)\s+Limit|\s+Limit)?)$",
    ""
);
static TABLE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Table '(.*)' (\d+)-max Seat #(\d+) is the button$", "");
static SEAT: LazyLock<Regex> =
    template_lazy!(r"^Seat (\d+): (.+?) \(${NUM} in chips\)(?: (is sitting out|out of hand))?$");
static MARKER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*\*\*\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$",
    "i"
);
static CHATTER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\bhas timed out$|\bis disconnected$|\bhas reconnected$|\bactivated time-bank \(\d+ seconds?\)$|: didn't post (?:small|big) blind$",
    ""
);
static STRADDLE_TAG: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(Seat \d+: .*?)( \(straddle\))(.*)$", "");

static TOO_PRECISE_CHIPS: LazyLock<Regex> = crate::js_regex_lazy!(r"(?:^|[\s(])\d+\.\d", "");
static TOO_PRECISE_CASH: LazyLock<Regex> = crate::js_regex_lazy!(r"(?:^|[\s(])\d+\.\d{3,}", "");
static HAND_CANCELLED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\*\s*HAND CANCELLED\s*\*\*\*", "i");
static FREEROLL: LazyLock<Regex> = crate::js_regex_lazy!(r"freeroll", "i");
static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY\s*\*\*\*", "i");
static TOTAL_POT: LazyLock<Regex> = template_lazy!(r"^Total pot ${NUM} \| Rake ${NUM}$");
static BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board \[([^\]]*)\]$", "");
static GAME_ENDED: LazyLock<Regex> = template_lazy!(r"^Game ended: ${STAMP} GMT$");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+):", "");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS\s*\*\*\*$", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to (.+?) \[([^\]]*)\]$", "");
static UNCALLED: LazyLock<Regex> = template_lazy!(r"^Uncalled bet \(${NUM}\) returned to (.+)$");
static COLLECTED: LazyLock<Regex> = template_lazy!(r"^(.+?) collected ${NUM} from (.+)$");
static ANTE: LazyLock<Regex> = template_lazy!(r"^(.+?): posts the ante ${NUM}( and is all-in)?$");
static DEAD_BLIND: LazyLock<Regex> =
    template_lazy!(r"^(.+?): posts (?:small|big) blind \(dead\) ${NUM}$");
static BLIND: LazyLock<Regex> =
    template_lazy!(r"^(.+?): posts (small|big) blind ${NUM}( and is all-in)?$");
static STRADDLE: LazyLock<Regex> = template_lazy!(r"^(.+?): posts straddle ${NUM}$");
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?): (folds|checks)$", "");
static WAGER: LazyLock<Regex> = template_lazy!(r"^(.+?): (calls|bets) ${NUM}( and is all-in)?$");
static RAISE_TO: LazyLock<Regex> =
    template_lazy!(r"^(.+?): raises ${NUM} to ${NUM}( and is all-in)?$");
static RAISE_ALL_IN: LazyLock<Regex> = template_lazy!(r"^(.+?): raises ${NUM} and is all-in$");
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): shows \[([^\]]*)\](?: \((.+)\))?$", "");
static MUCK: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): (mucks hand|doesn't show hand)$", "");
static HEADER_ANYWHERE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"(?:^|[\r\n])CoinPoker Hand #\d+:", "");
static BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(r"\bCoinPoker\b", "");

/* ---------------------------------------------------------------- header */

/// `Header` (`payload` is unused and left out).
struct Header {
    hand_id: String,
    game: DraftGame,
    tournament: Option<PhfTournament>,
    played_at: Option<String>,
}

/// `parseHeader`.
fn parse_header(line: &str) -> Option<Header> {
    let c = HEADER.captures(line)?;
    let hand_id = c[1].to_owned();
    let payload = &c[2];
    let played_at = parse_played_at(payload);
    let chips = CHIPS.unit();

    if let Some(tour) = TOUR.captures(payload) {
        // Refusing beats guessing: without a game label the name would
        // absorb the variant.
        let split = TOUR_NAME_AND_LABEL.captures(&tour[2])?;
        let label = split[2].to_owned();
        let small_blind = parse_amount(&tour[3], &chips);
        let big_blind = parse_amount(&tour[4], &chips);
        let name = &split[1];
        return Some(Header {
            hand_id,
            game: DraftGame {
                variant: variant_from_label(&label),
                limit: limit_from_label(&label),
                format: GameFormat::Tournament,
                label,
                // Tournament stacks are chips: bare integers.
                unit: chips.clone(),
                small_blind,
                big_blind,
            },
            tournament: Some(PhfTournament {
                id: tour[1].to_owned(),
                name: (!name.is_empty()).then(|| name.to_owned()),
                // The header states no buy-in at all; the caller flags it.
                buy_in: 0,
                bounty: Some(0),
                fee: 0,
                buy_in_unit: cash_unit(),
                // No level number either, only the blinds in force.
                level_label: None,
                level_number: None,
                level_small_blind: small_blind,
                level_big_blind: big_blind,
                level_ante: parse_amount(tour.get(5).map_or("", |m| m.as_str()), &chips),
                bounties: Vec::new(),
                prize_pool: None,
            }),
            played_at,
        });
    }

    let cash = CASH.captures(payload)?;
    let label = js::trim(&cash[1]).to_owned();
    let unit = cash_unit();
    Some(Header {
        hand_id,
        game: DraftGame {
            variant: variant_from_label(&label),
            limit: limit_from_label(&label),
            format: GameFormat::Cash,
            label,
            small_blind: parse_amount(&cash[2], &unit),
            big_blind: parse_amount(&cash[3], &unit),
            unit,
        },
        tournament: None,
        played_at,
    })
}

/// `assertRepresentable`: refuses a hand whose amounts the unit cannot hold
/// exactly (the header line, whose tournament name has amounts, excluded).
fn assert_representable(lines: &[&str], unit: &CurrencyUnit) -> Result<(), ParseError> {
    let too_precise: &Regex = if unit.minor_units == 1 {
        &TOO_PRECISE_CHIPS
    } else {
        &TOO_PRECISE_CASH
    };
    for line in lines.iter().skip(1) {
        if let Some(m) = too_precise.find(line) {
            return Err(skip(
                SkipReason::UnsupportedPrecision,
                format!(
                    "\"{}\" needs more precision than {} gives (1/{}); the hand is kept rather \
                     than rounded.",
                    m.as_str(),
                    unit.code,
                    unit.minor_units
                ),
            ));
        }
    }
    Ok(())
}

/// `applyStraddleTag`: a SUMMARY seat line with CoinPoker's `(straddle)` tag
/// is re-read without it; the tag is kept as the position label.
fn apply_straddle_tag(result: &mut PhfPlayerResult, unit: &CurrencyUnit) {
    let Some(raw) = result.raw.as_deref() else {
        return;
    };
    let Some(c) = STRADDLE_TAG.captures(raw) else {
        return;
    };
    let parsed = parse_summary_seat(&format!("{}{}", &c[1], &c[3]), &result.player, unit);
    result.position_labels = vec!["(straddle)".to_owned()];
    result.outcome = parsed.outcome;
    if parsed.hand_description.is_some() {
        result.hand_description = parsed.hand_description;
    }
    result.mucked = parsed.mucked;
    result.folded_street = parsed.folded_street;
    result.didnt_bet = parsed.didnt_bet;
    if !parsed.shown_cards.is_empty() {
        result.shown_cards = parsed.shown_cards;
    }
}

/// `parseOneHand`.
#[allow(clippy::too_many_lines)]
fn parse_one_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(strip_bom(raw));
    let lines = to_lines(text);

    let Some(header) = parse_header(lines.first().copied().unwrap_or("")) else {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The hand has no CoinPoker header line.",
        ));
    };
    if header.game.variant != Variant::Holdem {
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "{} is not supported yet; the hand is kept for a future parser.",
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
    // The deal is void and the refunds are not winnings (fixture 15).
    if lines
        .iter()
        .any(|line| HAND_CANCELLED.is_match(js::trim(line)))
    {
        return Err(skip(
            SkipReason::HandCancelled,
            "CoinPoker cancelled the hand and refunded every stake.",
        ));
    }

    let unit = header.game.unit.clone();
    assert_representable(&lines, &unit)?;

    let tournament_name = header
        .tournament
        .as_ref()
        .map(|tournament| tournament.name.clone());
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "coinpoker".to_owned(),
        site_name: "CoinPoker".to_owned(),
        parser_id: "coinpoker".to_owned(),
        parser_version: COINPOKER_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        // Bare integers, namespaced against other rooms' numeric ids.
        hand_key: format!("CP{}", header.hand_id),
        raw_text: text.to_owned(),
        original_filename: ctx.source_filename.map(str::to_owned),
        game: header.game,
        tournament: header.tournament,
        played_at: header.played_at,
        text_style: PhfTextStyle {
            // Not detected: every cash amount has exactly two decimals.
            decimals: DecimalStyle::Fixed2,
            pad_hour: true,
            ..PhfTextStyle::default()
        },
        // No `Uncalled bet` after an uncalled all-in raise is not an export
        // bug (fixture 13): nothing is invented.
        repair_missing_uncalled: false,
        parsed_at: ctx.parsed_at().to_owned(),
    });

    if let Some(name) = tournament_name
        && !FREEROLL.is_match(name.as_deref().unwrap_or(""))
    {
        // `${header.tournament.name}`: a missing name prints `null`.
        draft.warn(
            "buy-in-not-stated",
            format!(
                "CoinPoker's header states no buy-in for \"{}\"; tournament.buyIn is 0.",
                name.as_deref().unwrap_or("null")
            ),
            None,
        );
    }

    let money = |value: &str| parse_amount(value, &unit);
    let mut in_summary = false;

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
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
                draft.summary_pot(
                    money(&pot[1]),
                    Vec::new(),
                    PhfFees {
                        rake: money(&pot[2]),
                        ..PhfFees::ZERO
                    },
                );
                continue;
            }
            if let Some(board) = BOARD.captures(line) {
                draft.summary_board(0, extract_cards(&board[1]));
                continue;
            }
            if GAME_ENDED.is_match(line) {
                continue;
            }
            if let Some(seat) = SUMMARY_SEAT.captures(line) {
                // A seat beyond `u32` can match no player; it is dropped.
                if let Some(number) = number_u32(&seat[1]) {
                    draft.summary_seat(number, line);
                }
                continue;
            }
            draft.warn("unknown-summary-line", line, line_no);
            continue;
        }

        if let Some(table) = TABLE.captures(line) {
            let name = &table[1];
            let max_seats = u32_or_bug(&table[2], "a table size")?;
            let button = u32_or_bug(&table[3], "a button seat")?;
            draft.set_table(
                (!name.is_empty()).then(|| name.to_owned()),
                max_seats,
                Some(button),
                None,
            );
            continue;
        }

        if let Some(seat) = SEAT.captures(line) {
            // Both suffixes mean: occupied, not dealt in (fixture 10).
            let number = u32_or_bug(&seat[1], "a seat number")?;
            draft.seat(number, &seat[2], money(&seat[3]), seat.get(4).is_some());
            continue;
        }

        if let Some(marker) = MARKER.captures(line) {
            let kind = marker_kind(&marker[1]);
            if matches!(kind, MarkerKind::Showdown) {
                draft.marker(kind, 0, "", &[]);
                continue;
            }
            // `*** TURN *** [Jd 6c 5h] [5c]`: the last group is the new card.
            let cards = last_bracket_cards(&marker[2]);
            draft.marker(kind, 0, "", &cards);
            continue;
        }

        if HOLE_CARDS.is_match(line) {
            draft.hole_cards_marker();
            continue;
        }

        // No anonymisation, no `Hero`: this line names the observer.
        if let Some(dealt) = DEALT.captures(line) {
            draft.dealt(&dealt[1], extract_cards(&dealt[2]));
            continue;
        }

        if let Some(uncalled) = UNCALLED.captures(line) {
            draft.uncalled(&uncalled[2], money(&uncalled[1]), line_no, line);
            continue;
        }

        // `... from pot` and `... from side-pot 1` (fixture 14).
        if let Some(collected) = COLLECTED.captures(line) {
            draft.collect(
                &collected[1],
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
                    all_in: ante.get(3).is_some(),
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        // A dead blind goes straight to the pot (fixture 10).
        if let Some(dead) = DEAD_BLIND.captures(line) {
            draft.post(
                &dead[1],
                ActionType::MissedBlind,
                money(&dead[2]),
                PostOptions {
                    all_in: false,
                    verb: Some("posts small blind (dead)"),
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        // A second `posts big blind` is a returning player (fixtures 06, 11).
        if let Some(blind) = BLIND.captures(line) {
            let kind = if &blind[2] == "small" {
                ActionType::SmallBlind
            } else {
                ActionType::BigBlind
            };
            draft.post(
                &blind[1],
                kind,
                money(&blind[3]),
                PostOptions {
                    all_in: blind.get(4).is_some(),
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(straddle) = STRADDLE.captures(line) {
            draft.post(
                &straddle[1],
                ActionType::Straddle,
                money(&straddle[2]),
                PostOptions {
                    all_in: false,
                    verb: Some("posts straddle"),
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
                wager.get(4).is_some(),
                line_no,
                line,
            );
            continue;
        }

        if let Some(raise) = RAISE_TO.captures(line) {
            draft.raise_to(
                &raise[1],
                money(&raise[3]),
                raise.get(4).is_some(),
                line_no,
                line,
            );
            continue;
        }

        // `raises 0.46 and is all-in`: the chips added (fixture 05).
        if let Some(raise) = RAISE_ALL_IN.captures(line) {
            let player = &raise[1];
            let to = draft.committed(player).saturating_add(money(&raise[2]));
            draft.raise_to(player, to, true, line_no, line);
            continue;
        }

        // CoinPoker's own description wording is kept verbatim.
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

    let mut hand = match draft.build() {
        Ok(hand) => hand,
        Err(BuildError::Thrown(thrown)) => return Err(ParseError::Bug(thrown.message)),
        Err(BuildError::UnseatedStraddler) => {
            return Err(unseated(draft.first_unseated_actor().unwrap_or_default()));
        }
    };

    for result in &mut hand.results.players {
        apply_straddle_tag(result, &unit);
        // The room's prose has no currency symbol; the structured fields
        // regenerate it. Dropped only when the outcome classified.
        if result.outcome != SeatOutcome::Unknown {
            result.raw = None;
        }
    }

    // Actors missing from the hand's own seat block.
    if let Some(stranger) = draft.first_unseated_actor() {
        return Err(unseated(stranger));
    }

    Ok(hand)
}

/// `coinpokerParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct CoinPokerParser;

impl SiteParser for CoinPokerParser {
    fn id(&self) -> &'static str {
        "coinpoker"
    }

    fn name(&self) -> &'static str {
        "CoinPoker"
    }

    fn version(&self) -> &'static str {
        COINPOKER_PARSER_VERSION
    }

    /// 0.95 for the header (exclusive to the room), 0.3 for the branding
    /// alone; nothing on body features, which read as PokerStars.
    fn detect(&self, text: &str) -> u32 {
        if HEADER_PREFIX.is_match(strip_bom(text)) || HEADER_ANYWHERE.is_match(text) {
            return 950;
        }
        if BRANDING.is_match(text) {
            return 300;
        }
        0
    }

    /// One blank line separates hands, so the split keys on the header.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(strip_bom(text), &HEADER_PREFIX)
            .into_iter()
            .map(|chunk| js::trim(strip_bom(chunk)))
            .filter(|chunk| HEADER_PREFIX.is_match(chunk))
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_one_hand(raw, ctx)
    }
}

/// `looksLikeCoinPoker`: whether a chunk is a CoinPoker hand by its own text.
pub fn looks_like_coinpoker(text: &str) -> bool {
    HEADER_PREFIX.is_match(js::trim(strip_bom(text)))
}

#[cfg(test)]
mod tests;

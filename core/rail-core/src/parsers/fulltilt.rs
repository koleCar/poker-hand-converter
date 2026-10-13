//! `fulltilt`: Full Tilt Poker (`frontend/src/lib/parsers/fulltilt.ts`).
//!
//! Full Tilt is dead (2016), so the format is fixed forever. It is
//! PokerStars-family in shape but not in wording, and every difference is a
//! way to get a hand silently wrong: `Uncalled bet of $20 returned to X`
//! (no parentheses), `, and is all in` (three words), `, and is capped` (not
//! all-in), action lines without a colon (so table chat is the one line that
//! has one), the button stated *after* the blinds, two header word orders
//! (2011 and 2014, stakes and game swapped), numbered run-it-twice markers
//! (`*** RIVER 2 ***`) with a `*** SUMMARY 2 ***` block per runout, and a
//! `Total pot $40 | Rake $0.50` with no promotional columns. Tournaments are
//! refused: no sample exists. The hand semantics are [`StarsHandDraft`]'s.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `fulltilt.ts`); the detection probe and the split run at every JavaScript
//! line start.
//!
//! **Numbers no PHF holds.** The TypeScript keeps a seat, the table size,
//! the button and a runout index as JavaScript numbers; a PHF holds them as
//! `u32`. Where the TypeScript would *return* a hand holding one (`Seat
//! 99999999999:`, `(99999999999 max)`, `wins pot 99999999999`, the `-1` of a
//! `*** SHOW DOWN 0 ***`), this parser returns the parser error of R0.6's
//! rule instead - but only at the point where the TypeScript returns, so
//! every refusal the TypeScript reaches first is reached here too. Until
//! then such a number is carried as a stand-in that behaves the same (see
//! [`SeatNumbers`] and [`OFF_BOARD`]). A marker numbered past
//! [`MAX_RUNOUT_INDEX`] is refused at once: the TypeScript allocates every
//! runout up to it (and runs out of memory long before `u32`).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::{NoExpand, Regex};

use super::shared::p3_draft::{
    DraftGame, StarsHandDraft, detect_decimals, has_unsupported_currency, normalize_newlines,
    strip_bom, to_lines, unit_for_stakes, variant_from_label,
};
use super::shared::ps_gg_hand::{
    BuildError, DraftInit, MarkerKind, PostOptions, last_bracket_cards, line_number, marker_kind,
    number_u32, skip, split_before_line_starts, template_regex, unrepresentable, unseated,
};
use super::shared::variant_lock::{OMAHA_HI_LO, unsupported_variant_skip};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, SiteParser, SiteParserContext, SkipReason, SplitError, unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::hilo::{StatedAward, assign_hi_lo_halves, check_stated_halves};
use crate::phf::money::CHIPS;
use crate::phf::serialize::{line_starts, parse_instant, to_iso_string};
use crate::phf::{
    ActionType, Amount, CurrencyKind, CurrencyUnit, GameFormat, LimitType, PhfFees, PhfHand,
    PhfTextStyle, PhfWinner, PotHalf, Variant, parse_amount,
};

/// `FULLTILT_PARSER_VERSION`.
pub const FULLTILT_PARSER_VERSION: &str = "1.0.0";

/// `FULLTILT_VARIANTS`: Hold'em and four-card Omaha (one clean `PL Omaha Hi`
/// file).
const FULLTILT_VARIANTS: &[Variant] = &[Variant::Holdem, Variant::Omaha];
/// `FULLTILT_HI_LO`: `PL Omaha H/L` and `FL Omaha H/L`.
const FULLTILT_HI_LO: &[Variant] = OMAHA_HI_LO;

static HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Full Tilt Poker Game #(\d+):\s*(.*)$", "");
/// `HEADER_PREFIX`, also the body of the detection probe and the split's
/// lookahead.
static HEADER_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^Full Tilt Poker Game #\d+:", "");
static BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(r"\bFull Tilt Poker\b", "");

/// `PAYLOAD_REGEX`: `Table Goldring (heads up) - NL Hold'em - $5/$10 -
/// 21:11:15 ET - 2014/01/05`, the tail anchored on the time.
static PAYLOAD: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table (.+?)(?: \(([^)]*)\))? - (.+) - (\d{1,2}):(\d{2}):(\d{2}) ([A-Za-z]+) - (\d{4})\/(\d{2})\/(\d{2})(?: \[.*\])?\s*$",
    ""
);

/// `STAKES`: `$0.25/$0.50`, optionally with an appended ante.
const STAKES: &str =
    r"([$€£]?[\d,]+(?:\.\d+)?\/[$€£]?[\d,]+(?:\.\d+)?(?:\s+Ante\s+[$€£]?[\d,]+(?:\.\d+)?)?)";
/// `^${STAKES}\s+-\s+(.+)$`: the 2011 order.
static OLD_ORDER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"^{STAKES}\s+-\s+(.+)$"), ""));
/// `^(.+?)\s+-\s+${STAKES}$`: the 2014 order.
static NEW_ORDER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"^(.+?)\s+-\s+{STAKES}$"), ""));

/// `MARKER_REGEX`: `*** RIVER 2 *** [..] [..] (Total Pot: $625, ...)`.
static MARKER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*\*\*\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*(\d+)?\s*\*\*\*(.*)$",
    "i"
);
/// `SUMMARY_REGEX`: `*** SUMMARY ***` and `*** SUMMARY 2 ***`.
static SUMMARY: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY\s*(\d+)?\s*\*\*\*", "i");
/// `RUN_PREFIXES`.
const RUN_PREFIXES: [&str; 4] = ["FIRST", "SECOND", "THIRD", "FOURTH"];

/// `SUFFIX`: `and is capped` is a CAP-table clause, not all-in.
const SUFFIX: &str = r"((?:,? and is (?:all in|capped))*)";
static ALL_IN: LazyLock<Regex> = crate::js_regex_lazy!(r"and is all in", "");

/// `allInFrom(suffix)`.
fn all_in_from(suffix: Option<regex::Match<'_>>) -> bool {
    suffix.is_some_and(|m| !m.as_str().is_empty() && ALL_IN.is_match(m.as_str()))
}

/// The members of `NOISE_REGEX` (joined with `|`): lines that move no money
/// and reveal no card. `adds ${MONEY}` is a rebuy between hands.
const NOISE_MEMBERS: [&str; 12] = [
    r"\bhas \d+ seconds left to act$",
    r"\bhas requested TIME$",
    r"\bhas been disconnected$",
    r"\bhas reconnected$",
    r"\bhas timed out$",
    r"\bstands up$",
    r"\bsits down$",
    r"\bis sitting out$",
    r"\bhas returned$",
    r"\bjoins the table\b",
    r"\bleaves the table\b",
    r"\badds ${MONEY}$",
];
static NOISE: LazyLock<Regex> = LazyLock::new(|| template_regex(&NOISE_MEMBERS.join("|"), "", ""));

static FL_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bFL\b|fixed\s*limit", "i");
static PL_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bPL\b|pot\s*limit", "i");
static NL_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bNL\b|no\s*limit", "i");
static LIMIT_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(r"\blimit\b", "i");
static MAX_SEATS: LazyLock<Regex> = crate::js_regex_lazy!(r"(\d+)\s*max", "i");
static HEADS_UP: LazyLock<Regex> = crate::js_regex_lazy!(r"heads up", "i");
static BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\s*(\S+)\/([^\s]+)", "");

static RAKE: LazyLock<Regex> = LazyLock::new(|| template_regex(r"Rake ${MONEY}", "", ""));
static FOLDED_BEFORE_THE_FLOP: LazyLock<Regex> =
    crate::js_regex_lazy!(r"\bfolded before the Flop\b", "i");
static DIDNT_BET_FOLDED: LazyLock<Regex> = crate::js_regex_lazy!(r"\bdidn't bet \(folded\)", "i");

static CANCELLED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Hand #\d+ has been cance?l?led\s*$", "i");
static TOURNAMENT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"\bTournament\b|\bSit & Go\b|\bMatch #", "i");

static TOTAL_POT: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Total pot ${MONEY}", "", ""));
static RUNOUT_POT: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Pot \d+ ${MONEY}$", "", ""));
static BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board:?\s*\[([^\]]*)\]", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+): (.*)$", "");
static SITTING_OUT_END: LazyLock<Regex> = crate::js_regex_lazy!(r"\bis sitting out$", "i");
static SEAT: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Seat (\d+): (.+?) \(${MONEY}\)(.*)$", "", ""));
static SITTING_OUT_TAIL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bis sitting out\b", "i");
static BUTTON: LazyLock<Regex> = crate::js_regex_lazy!(r"^The button is in seat #(\d+)\s*$", "i");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS\s*\*\*\*", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to (.+?) \[([^\]]*)\]\s*$", "");
static BLIND: LazyLock<Regex> = LazyLock::new(|| {
    template_regex(
        r"^(.+?) posts (?:a (dead) )?(?:the )?(small|big) blind of ${MONEY}$",
        "",
        "",
    )
});
static ANTE: LazyLock<Regex> = LazyLock::new(|| template_regex(r"^(.+?) antes ${MONEY}$", "", ""));
static DEAD_POST: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?) posts ${MONEY}$", "", ""));
static UNCALLED: LazyLock<Regex> = LazyLock::new(|| {
    template_regex(
        r"^(?:Uncalled bet|Ante) of ${MONEY} returned to (.+)$",
        "",
        "",
    )
});
static WINS: LazyLock<Regex> = LazyLock::new(|| {
    template_regex(
        r"^(.+?) wins (?:the (high |low )?pot|pot (\d+)) \(${MONEY}\)(?: with .+)?$",
        "",
        "",
    )
});
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?) (folds|checks)$", "");
static WAGER: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?) (bets|calls) ${MONEY}${SUFFIX}$", SUFFIX, ""));
static RAISE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?) raises to ${MONEY}${SUFFIX}$", SUFFIX, ""));
static MUCKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?) mucks$", "");
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?) shows(?: \[([^\]]*)\])?(?: (.+))?$", "");
static RUN_IT_TWICE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Players agree to Run It Twice$", "i");
static SITTING_OUT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?) is sitting out$", "i");
static CHAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?): ", "");
static NUMBERED_POT: LazyLock<Regex> = crate::js_regex_lazy!(r"^pot (\d+)$", "");

/// The stand-in runout index of the actions the TypeScript tags `-1` (after
/// a `*** SHOW DOWN 0 ***`): an index no runout of a hand can have, since a
/// marker past [`MAX_RUNOUT_INDEX`] is refused. Its collects are filed under
/// `pot` and a numbered pot's under `pot N`, so it never shares a hi/lo pot
/// group with a re-tagged collect either.
pub const OFF_BOARD: u32 = u32::MAX;

/// The highest marker runout index read (`*** RIVER 10000 ***`): beyond it
/// the hand is refused with a parser error. The TypeScript pushes one runout
/// per index up to it, which a hostile number turns into an allocation no
/// process survives; a real hand has at most two runouts.
pub const MAX_RUNOUT_INDEX: u32 = 9_999;

/// `limitFromFullTiltLabel(label)`: Full Tilt's two-letter codes.
fn limit_from_full_tilt_label(label: &str) -> LimitType {
    if FL_LABEL.is_match(label) {
        LimitType::Fl
    } else if PL_LABEL.is_match(label) {
        LimitType::Pl
    } else if NL_LABEL.is_match(label) {
        LimitType::Nl
    } else if LIMIT_LABEL.is_match(label) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

/// `maxSeatsFrom(seatDescription)`: `(heads up)` 2, `(6 max)` 6, else 9.
fn max_seats_from(seat_description: Option<&str>) -> JsNumber {
    let Some(description) = seat_description.filter(|d| !d.is_empty()) else {
        return JsNumber::from_u64(9);
    };
    if let Some(max) = MAX_SEATS.captures(description) {
        return JsNumber::parse(&max[1]);
    }
    JsNumber::from_u64(if HEADS_UP.is_match(description) { 2 } else { 9 })
}

/// `blindsFrom(stakesText, unit)`.
fn blinds_from(stakes_text: &str, unit: &CurrencyUnit) -> (Amount, Amount) {
    match BLINDS.captures(stakes_text) {
        None => (0, parse_amount(js::trim(stakes_text), unit)),
        Some(c) => (parse_amount(&c[1], unit), parse_amount(&c[2], unit)),
    }
}

/// `Header`.
struct Header {
    hand_id: String,
    table_name: String,
    /// `maxSeats`, the JavaScript number.
    max_seats: JsNumber,
    game: DraftGame,
    played_at: Option<String>,
    pad_hour: bool,
}

/// `parseHeader(line)`.
fn parse_header(line: &str) -> Option<Header> {
    let header = HEADER.captures(line)?;
    let payload = PAYLOAD.captures(header.get(2).map_or("", |m| m.as_str()))?;
    let table_name = &payload[1];
    let seat_description = payload.get(2).map(|m| m.as_str());
    let middle = &payload[3];
    let (hh, mm, ss) = (&payload[4], &payload[5], &payload[6]);
    let (year, month, day) = (&payload[8], &payload[9], &payload[10]);

    // Two generations, told apart by which half has the stakes' shape.
    let old_order = OLD_ORDER.captures(middle);
    let new_order = NEW_ORDER.captures(middle);
    let (stakes_text, label) = match (&old_order, &new_order) {
        (Some(old), _) => (old.get(1), old.get(2)),
        (None, Some(new)) => (new.get(2), new.get(1)),
        (None, None) => (None, None),
    };
    let stakes_text = stakes_text.map(|m| m.as_str()).filter(|s| !s.is_empty())?;
    let label = label
        .map(|m| js::trim(m.as_str()))
        .filter(|s| !s.is_empty())?;

    let unit = unit_for_stakes(stakes_text, &CHIPS.unit())?;
    let (small_blind, big_blind) = blinds_from(stakes_text, &unit);
    let hour = if hh.len() < 2 {
        format!("0{hh}")
    } else {
        hh.to_owned()
    };
    let played_at =
        parse_instant(&format!("{year}-{month}-{day}T{hour}:{mm}:{ss}Z")).map(to_iso_string);

    let limit = limit_from_full_tilt_label(label);
    // A fixed-limit header states the small and big *bet*: the blinds come
    // from what was posted.
    let fixed = limit == LimitType::Fl;
    Some(Header {
        hand_id: header[1].to_owned(),
        table_name: table_name.to_owned(),
        max_seats: max_seats_from(seat_description),
        game: DraftGame {
            variant: variant_from_label(label),
            limit,
            format: GameFormat::Cash,
            label: label.to_owned(),
            unit,
            small_blind: if fixed { 0 } else { small_blind },
            big_blind: if fixed { 0 } else { big_blind },
        },
        played_at,
        // `hh.length === 2`: the capture is ASCII digits.
        pad_hour: hh.len() == 2,
    })
}

/// `parseSummaryFees(line, unit)`: the rake, nothing else.
fn parse_summary_fees(line: &str, unit: &CurrencyUnit) -> PhfFees {
    PhfFees {
        rake: RAKE.captures(line).map_or(0, |c| parse_amount(&c[1], unit)),
        ..PhfFees::ZERO
    }
}

/// `normalizeSummarySeat(line)`: Full Tilt's fold wordings in the family's.
fn normalize_summary_seat(line: &str) -> String {
    let once = FOLDED_BEFORE_THE_FLOP.replace(line, NoExpand("folded before Flop"));
    DIDNT_BET_FOLDED
        .replace(&once, NoExpand("folded before Flop (didn't bet)"))
        .into_owned()
}

/// Seat numbers as the draft holds them: the `u32` itself, or - for a number
/// beyond `u32` (the TypeScript's `Map` key is the double) - a stand-in, one
/// per distinct double, counting down from `u32::MAX` past every seat number
/// the hand prints. Lookups by the same double find the same stand-in, so
/// the seat block, the summary and the draft agree as they do in the
/// TypeScript.
struct SeatNumbers {
    printed: HashSet<u32>,
    stand_ins: HashMap<String, u32>,
    next: u32,
}

impl SeatNumbers {
    fn new(lines: &[&str]) -> Self {
        static PRINTED: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+):", "");
        let printed = lines
            .iter()
            .filter_map(|line| PRINTED.captures(js::trim(line)))
            .filter_map(|c| number_u32(&c[1]))
            .collect();
        Self {
            printed,
            stand_ins: HashMap::new(),
            next: u32::MAX,
        }
    }

    /// `Number(digits)` as the draft's seat.
    fn key(&mut self, digits: &str) -> u32 {
        if let Some(seat) = number_u32(digits) {
            return seat;
        }
        let double = JsNumber::parse(digits).to_js_string();
        if let Some(stand_in) = self.stand_ins.get(&double) {
            return *stand_in;
        }
        while self.printed.contains(&self.next) {
            self.next -= 1;
        }
        let stand_in = self.next;
        self.next -= 1;
        self.stand_ins.insert(double, stand_in);
        stand_in
    }

    fn is_stand_in(&self, seat: u32) -> bool {
        self.stand_ins.values().any(|s| *s == seat)
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
    if lines.iter().any(|line| CANCELLED.is_match(js::trim(line))) {
        // The deal was voided and the blinds returned.
        return Err(skip(
            SkipReason::HandCancelled,
            "Full Tilt cancelled the hand.",
        ));
    }

    let Some(header) = parse_header(first) else {
        // A tournament header names the tournament where a cash header names
        // the table; that grammar was never recovered.
        if TOURNAMENT.is_match(first) {
            return Err(skip(
                SkipReason::TournamentUnsupported,
                "Full Tilt's tournament hand format is unconfirmed - no real sample exists - so \
                 the hand is kept rather than parsed with an invented grammar.",
            ));
        }
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The chunk has no readable Full Tilt Poker header line.",
        ));
    };
    // Hi/lo first: a refusal that names the split pot is the one a user can
    // act on.
    if let Some(refusal) = unsupported_game_skip(&header.game.label, FULLTILT_HI_LO) {
        return Err(refusal.into());
    }
    if let Some(refusal) = unsupported_variant_skip(&header.game.label, FULLTILT_VARIANTS) {
        return Err(refusal.into());
    }
    if header.game.unit.kind == CurrencyKind::Chips {
        // Play money and tournament chips print bare numbers.
        return Err(skip(
            SkipReason::UnsupportedCurrency,
            "The hand states no currency, so it is chips - play money or a tournament - neither \
             of which is confirmed for Full Tilt.",
        ));
    }

    let unit = header.game.unit.clone();
    let money = |value: &str| parse_amount(value, &unit);
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "fulltilt".to_owned(),
        site_name: "Full Tilt Poker".to_owned(),
        parser_id: "fulltilt".to_owned(),
        parser_version: FULLTILT_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        // Bare integers, namespaced against other rooms' numeric ids.
        hand_key: format!("FT{}", header.hand_id),
        raw_text: text.to_owned(),
        original_filename: ctx.source_filename.map(str::to_owned),
        game: header.game.clone(),
        tournament: None,
        played_at: header.played_at.clone(),
        text_style: PhfTextStyle {
            decimals: detect_decimals(text),
            pad_hour: header.pad_hour,
            ..PhfTextStyle::default()
        },
        repair_missing_uncalled: false,
        parsed_at: ctx.parsed_at().to_owned(),
    });

    let mut seats = SeatNumbers::new(&lines);
    let mut seat_names: HashMap<u32, String> = HashMap::new();
    let mut collectors: HashSet<String> = HashSet::new();
    let mut stated: Vec<StatedAward> = Vec::new();
    let mut button_seat: Option<JsNumber> = None;
    // `summaryBlock`: -1 before any SUMMARY marker.
    let mut summary_block: Option<JsNumber> = None;
    let mut total_pot: Amount = 0;
    let mut fees = PhfFees::ZERO;
    let mut saw_summary = false;
    let mut collapsed_summaries = false;
    let one = JsNumber::from_u64(1);

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let line = js::trim(raw_line);
        let line_no = line_number(i);
        if line.is_empty() {
            continue;
        }

        if let Some(marker) = SUMMARY.captures(line) {
            summary_block = Some(
                marker
                    .get(1)
                    .filter(|m| !m.as_str().is_empty())
                    .map_or(JsNumber::ZERO, |m| JsNumber::parse(m.as_str())),
            );
            saw_summary = true;
            continue;
        }

        if let Some(block) = summary_block {
            if let Some(pot) = TOTAL_POT.captures(line) {
                total_pot = money(&pot[1]);
                fees = parse_summary_fees(line, &unit);
                continue;
            }
            // `Pot 1 $311` heads a per-runout block: the same pot, split.
            if RUNOUT_POT.is_match(line) {
                continue;
            }
            if let Some(board) = BOARD.captures(line) {
                // `Math.max(summaryBlock - 1, 0)`; an index beyond `u32` is
                // one no runout has, so the TypeScript never reads it back.
                if let Some(index) = block
                    .to_i64()
                    .and_then(|n| u32::try_from(n.saturating_sub(1).max(0)).ok())
                {
                    draft.summary_board(index, extract_cards(&board[1]));
                }
                continue;
            }
            if let Some(seat) = SUMMARY_SEAT.captures(line) {
                let number = seats.key(&seat[1]);
                let name = seat_names.get(&number).cloned().unwrap_or_default();
                if SITTING_OUT_END.is_match(&seat[2]) {
                    draft.mark_sitting_out(&name);
                }
                // Run it twice: the first block's prose for the seats it
                // cannot be wrong about; a collector's outcome comes from its
                // collect lines.
                let at_most_one = !block.greater_than(one);
                if at_most_one && !(block.strict_equals(one) && collectors.contains(&name)) {
                    draft.summary_seat(number, &normalize_summary_seat(line));
                }
                if block.greater_than(one) {
                    collapsed_summaries = true;
                }
                continue;
            }
            if NOISE.is_match(line) {
                continue;
            }
            draft.warn("unknown-summary-line", line, line_no);
            continue;
        }

        if let Some(seat) = SEAT.captures(line) {
            let number = seats.key(&seat[1]);
            seat_names.insert(number, seat[2].to_owned());
            draft.seat(
                number,
                &seat[2],
                money(&seat[3]),
                SITTING_OUT_TAIL.is_match(seat.get(4).map_or("", |m| m.as_str())),
            );
            continue;
        }

        if let Some(button) = BUTTON.captures(line) {
            // Stated after the blinds: the table is set once the hand is read.
            button_seat = Some(JsNumber::parse(&button[1]));
            continue;
        }

        if let Some(marker) = MARKER.captures(line) {
            let kind = marker_kind(&marker[1]);
            let numbered = marker.get(2).filter(|m| !m.as_str().is_empty());
            let cards = last_bracket_cards(marker.get(3).map_or("", |m| m.as_str()));
            // `marker[2] ? Number(marker[2]) - 1 : 0`, and the standard
            // text's word for that runout.
            let index = numbered.map_or(Some(0), |m| {
                JsNumber::parse(m.as_str())
                    .to_i64()
                    .map(|n| n.saturating_sub(1))
            });
            let label = match index {
                Some(n) if numbered.is_some() => usize::try_from(n)
                    .ok()
                    .and_then(|n| RUN_PREFIXES.get(n))
                    .copied()
                    .unwrap_or(""),
                _ => "",
            };
            match index {
                Some(-1) => {
                    // `Number("0") - 1`: the TypeScript extends no runout; a
                    // showdown tags what follows -1, a street throws.
                    let field = match kind {
                        MarkerKind::Showdown => {
                            draft.showdown_marker_at(OFF_BOARD, label);
                            continue;
                        }
                        MarkerKind::Flop => "flop",
                        MarkerKind::Turn => "turn",
                        MarkerKind::River => "river",
                    };
                    return Err(ParseError::Bug(format!(
                        "Cannot set properties of undefined (setting '{field}')"
                    )));
                }
                Some(n) if (0..=i64::from(MAX_RUNOUT_INDEX)).contains(&n) => {
                    let index = u32::try_from(n).unwrap_or(MAX_RUNOUT_INDEX);
                    draft.marker(kind, index, label, &cards);
                }
                _ => {
                    return Err(ParseError::Bug(format!(
                        "a runout index of {} is beyond what this port builds (at most {}); \
                         the TypeScript allocates a runout for every index up to it",
                        numbered.map_or("", |m| m.as_str()),
                        MAX_RUNOUT_INDEX
                    )));
                }
            }
            continue;
        }

        if HOLE_CARDS.is_match(line) {
            draft.hole_cards_marker();
            continue;
        }

        if let Some(dealt) = DEALT.captures(line) {
            draft.dealt(&dealt[1], extract_cards(&dealt[2]));
            continue;
        }

        if let Some(blind) = BLIND.captures(line) {
            // A dead blind goes to the pot without counting toward the bet.
            let dead = blind.get(2).is_some_and(|m| !m.as_str().is_empty());
            let kind = if dead {
                ActionType::MissedBlind
            } else if js::to_lower_case(&blind[3]) == "small" {
                ActionType::SmallBlind
            } else {
                ActionType::BigBlind
            };
            draft.post(
                &blind[1],
                kind,
                money(&blind[4]),
                PostOptions {
                    all_in: false,
                    verb: dead.then_some("posts dead blind"),
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(ante) = ANTE.captures(line) {
            draft.post(
                &ante[1],
                ActionType::Ante,
                money(&ante[2]),
                PostOptions {
                    all_in: false,
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(dead) = DEAD_POST.captures(line)
            && draft.is_seated(&dead[1])
        {
            // Re-entering the table owes dead money; Full Tilt has no
            // straddle.
            draft.post(
                &dead[1],
                ActionType::MissedBlind,
                money(&dead[2]),
                PostOptions {
                    all_in: false,
                    verb: None,
                    line: line_no,
                    raw_line: line,
                },
            );
            continue;
        }

        if let Some(uncalled) = UNCALLED.captures(line) {
            draft.uncalled(js::trim(&uncalled[2]), money(&uncalled[1]), line_no, line);
            continue;
        }

        // `X wins the pot ($39.50)`, `X wins pot 2 ($311) with ...`, the
        // hi/lo `X wins the high pot ($61.55)`.
        if let Some(wins) = WINS.captures(line)
            && draft.is_seated(&wins[1])
        {
            let pot_name = wins
                .get(3)
                .filter(|m| !m.as_str().is_empty())
                .map_or_else(|| "pot".to_owned(), |m| format!("pot {}", m.as_str()));
            let half = match wins.get(2).map(|m| js::trim(m.as_str())) {
                Some("high") => Some(PotHalf::Hi),
                Some("low") => Some(PotHalf::Lo),
                _ => None,
            };
            collectors.insert(wins[1].to_owned());
            stated.push(StatedAward {
                player: wins[1].to_owned(),
                amount: money(&wins[4]),
                half,
            });
            draft.collect(&wins[1], money(&wins[4]), &pot_name, line_no, line);
            continue;
        }

        if let Some(simple) = SIMPLE.captures(line)
            && draft.is_seated(&simple[1])
        {
            let kind = if &simple[2] == "folds" {
                ActionType::Fold
            } else {
                ActionType::Check
            };
            draft.simple(&simple[1], kind, Vec::new(), line_no, line);
            continue;
        }

        if let Some(wager) = WAGER.captures(line)
            && draft.is_seated(&wager[1])
        {
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

        if let Some(raise) = RAISE.captures(line)
            && draft.is_seated(&raise[1])
        {
            draft.raise_to(
                &raise[1],
                money(&raise[2]),
                all_in_from(raise.get(3)),
                line_no,
                line,
            );
            continue;
        }

        if let Some(mucks) = MUCKS.captures(line)
            && draft.is_seated(&mucks[1])
        {
            // The standard text spells a muck `mucks hand`.
            draft.muck(&mucks[1], "mucks hand", line_no, line);
            continue;
        }

        // `X shows [Jd Qd]` at an all-in, `X shows two pair, Queens and
        // Threes` at a numbered showdown: both genuine reveals.
        if let Some(shows) = SHOWS.captures(line)
            && draft.is_seated(&shows[1])
            && (shows.get(2).is_some() || shows.get(3).is_some())
        {
            let cards = shows
                .get(2)
                .filter(|m| !m.as_str().is_empty())
                .map(|m| extract_cards(m.as_str()))
                .unwrap_or_default();
            draft.show(
                &shows[1],
                cards,
                shows.get(3).map(|m| m.as_str()),
                line_no,
                line,
            );
            continue;
        }

        if RUN_IT_TWICE.is_match(line) {
            draft.note_run_it_twice();
            continue;
        }

        if NOISE.is_match(line) {
            if let Some(sitting_out) = SITTING_OUT.captures(line) {
                draft.mark_sitting_out(&sitting_out[1]);
            }
            continue;
        }

        // Table chat: action lines carry no colon here, so a seated name
        // before the first `: ` is chat (`pupsaa: idi0t lucker`).
        if let Some(chat) = CHAT.captures(line)
            && draft.is_seated(&chat[1])
        {
            continue;
        }

        draft.warn("unknown-line", line, line_no);
    }

    if draft.player_count() == 0 {
        // Fixture 13: a header and a SUMMARY block, no seat listing.
        return Err(skip(
            SkipReason::NoSeatBlock,
            "The hand has no seat listing, so there is nothing to attribute the action to.",
        ));
    }

    // The table size and the button as the TypeScript passes them; one
    // beyond `u32` is held back and reported where the TypeScript returns.
    let as_u32 = |n: JsNumber| n.to_i64().and_then(|n| u32::try_from(n).ok());
    let mut unrepresentable_what: Option<&'static str> = None;
    let max_seats = as_u32(header.max_seats).unwrap_or_else(|| {
        unrepresentable_what.get_or_insert("a table size");
        0
    });
    let button = button_seat.and_then(|button| {
        let fits = as_u32(button);
        if fits.is_none() {
            unrepresentable_what.get_or_insert("a button seat");
        }
        fits
    });
    draft.set_table(Some(header.table_name.clone()), max_seats, button, None);
    if saw_summary {
        draft.summary_pot(total_pot, Vec::new(), fees);
    }
    if collapsed_summaries {
        draft.warn(
            "run-it-twice-summary",
            "The hand printed one SUMMARY block per runout; the per-seat prose of the first was \
             kept and the winners' outcomes come from their collect lines.",
            None,
        );
    }

    let mut hand = match draft.build() {
        Ok(hand) => hand,
        Err(BuildError::Thrown(thrown)) => return Err(ParseError::Bug(thrown.message)),
        Err(BuildError::UnseatedStraddler) => {
            return Err(unseated(draft.first_unseated_actor().unwrap_or_default()));
        }
    };

    // A collect belongs to the runout its pot number names; the draft tagged
    // it with the last marker's.
    let mut off_board: Vec<bool> = hand
        .actions
        .iter()
        .map(|action| action.runout_index == OFF_BOARD)
        .collect();
    for (action, off) in hand.actions.iter_mut().zip(&mut off_board) {
        let numbered = action
            .pot_name
            .as_deref()
            .and_then(|name| NUMBERED_POT.captures(name))
            .map(|c| JsNumber::parse(&c[1]));
        if action.kind == ActionType::Collect
            && let Some(number) = numbered
        {
            // `Math.max(Number(n) - 1, 0)`.
            *off = false;
            action.runout_index = number
                .to_i64()
                .and_then(|n| u32::try_from(n.saturating_sub(1).max(0)).ok())
                .unwrap_or_else(|| {
                    unrepresentable_what.get_or_insert("a runout index");
                    OFF_BOARD
                });
        }
    }
    if off_board.iter().any(|off| *off) {
        unrepresentable_what.get_or_insert("a runout index");
    }
    hand.results.winners = hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Collect)
        .map(|action| PhfWinner {
            player: action.player.clone(),
            seat: action.seat,
            amount: action.amount,
            runout_index: action.runout_index,
            half: None,
        })
        .collect();
    if hand.game.hi_lo {
        // The halves again, against the moved collects.
        let assigned = assign_hi_lo_halves(&mut hand).map_err(|e| ParseError::Bug(e.message))?;
        let checked = check_stated_halves(&hand, &stated);
        hand.meta
            .warnings
            .retain(|warning| warning.code != "hi-lo-split-unresolved");
        hand.meta.warnings.extend(assigned);
        hand.meta.warnings.extend(checked);
    }

    let seated = draft.seated_names();
    if let Some(stranger) = hand
        .actions
        .iter()
        .find(|action| !seated.contains(&action.player))
    {
        return Err(unseated(&stranger.player));
    }
    if hand
        .players
        .iter()
        .any(|player| seats.is_stand_in(player.seat))
    {
        unrepresentable_what = Some("a seat number");
    }
    if let Some(what) = unrepresentable_what {
        return Err(ParseError::Bug(unrepresentable(what).message));
    }
    Ok(hand)
}

/// `fulltiltParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct FullTiltParser;

impl SiteParser for FullTiltParser {
    fn id(&self) -> &'static str {
        "fulltilt"
    }

    fn name(&self) -> &'static str {
        "Full Tilt Poker"
    }

    fn version(&self) -> &'static str {
        FULLTILT_PARSER_VERSION
    }

    /// 0.95 for a header at any JavaScript line start (no other room writes
    /// it), 0.3 for the name alone.
    fn detect(&self, text: &str) -> u32 {
        let stripped = strip_bom(text);
        if line_starts(stripped).any(|start| HEADER_PREFIX.is_match(&stripped[start..])) {
            return 950;
        }
        if BRANDING.is_match(text) {
            return 300;
        }
        0
    }

    /// On the header, which every hand repeats: covers the two-blank-line
    /// file and a hand-concatenated one alike.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
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
        FULLTILT_HI_LO
    }
}

#[cfg(test)]
mod tests;

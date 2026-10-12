//! The PokerStars line grammar as the rooms that cloned it speak it
//! (`frontend/src/lib/parsers/shared/p3-stars-dialect.ts`): Run It Once and
//! PokerBros' PokerStars-family export. Ported with the PokerStars parser
//! (R0.7) so the two rooms that read it (R0.8, R0.10) find it in place; until
//! they arrive it is exercised by its own tests only.
//!
//! The differences it absorbs: `Table ID '…' 6-Max` (RIO) next to
//! `Table '…' 6-max`, `*** SHOWDOWN ***` next to `*** SHOW DOWN ***`, a
//! showdown reveal with no colon (RIO), a `[hero]` seat tag (RIO), and RIO's
//! "Splash The Pot" house money (`STP added: €0.50`), which becomes a
//! [`PhfChipMovement`] the site parser attaches to the built hand.
//!
//! It is a dispatcher only: headers, refusal policy and provenance stay in
//! the site parsers, the semantics in [`StarsHandDraft`].

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use super::p3_draft::StarsHandDraft;
use super::ps_gg_hand::{
    PostOptions, last_bracket_cards, marker_kind, number_u32, runout_index_for_label,
    template_regex, u32_or_bug,
};
use crate::cards::extract_cards;
use crate::detect::ParseError;
use crate::js::{self, JsNumber};
use crate::phf::{
    ActionType, Amount, ChipMovementAnchor, CurrencyUnit, PhfChipMovement, PhfFees, PhfPot,
    parse_amount,
};

static TABLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table(?: ID)? '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$",
    "i"
);
static SEAT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$", "");
static MARKER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$",
    "i"
);

/// `SUFFIX`.
const SUFFIX: &str = r"((?: and is all-in)*)";
static ALL_IN: LazyLock<Regex> = crate::js_regex_lazy!(r"and is all-in", "");

fn all_in_from(suffix: Option<regex::Match<'_>>) -> bool {
    suffix.is_some_and(|m| !m.as_str().is_empty() && ALL_IN.is_match(m.as_str()))
}

static CHATTER: LazyLock<Regex> = crate::js_regex_lazy!(
    r#"\bsaid, "|\bjoins the table\b|\bleaves the table\b|\bis sitting out\b|\bsits out\b|\bhas timed out\b|\bis (?:dis)?connected\b|\bhas returned\b"#,
    "i"
);

/// `DialectResult`: what the site parser needs back besides the draft.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DialectResult {
    /// Seats the hand listed, for the "is the button even occupied?" check.
    pub seats: Vec<u32>,
    pub button_seat: Option<u32>,
    /// `buttonSeat` as the JavaScript number it is (`button_seat` is `None`
    /// when it does not fit a `u32`).
    pub button_seat_number: Option<JsNumber>,
    /// Table name and size, so a caller can re-state the table with a fixed
    /// button.
    pub table_name: Option<String>,
    pub max_seats: u32,
    /// `maxSeats` as the JavaScript number it is (`max_seats` is 0 when it
    /// does not fit a `u32`).
    pub max_seats_number: JsNumber,
    /// The source printed a `*** SUMMARY ***` block.
    pub saw_summary: bool,
    /// Seat that posted the (first) small blind, for rooms whose stated
    /// button cannot be trusted.
    pub small_blind_seat: Option<u32>,
    /// Chips that entered the pot from outside the players; the site parser
    /// attaches them to the built hand.
    pub chip_movements: Vec<PhfChipMovement>,
}

static POT_TOTAL: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^Total pot ${MONEY}\s*$", "", ""));
static POT_COLUMN: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(Main|Side) pot(?:-(\d+))? ${MONEY}$", "", ""));
static RAKE_COLUMN: LazyLock<Regex> = LazyLock::new(|| template_regex(r"^Rake ${MONEY}$", "", ""));
static STP_COLUMN: LazyLock<Regex> = LazyLock::new(|| template_regex(r"^STP ${MONEY}$", "", ""));

/// `parsePotLine`'s result.
struct PotLine {
    total: Amount,
    pots: Vec<PhfPot>,
    fees: PhfFees,
    /// What the `STP` column claims.
    house_chips: Amount,
}

/// `parsePotLine`: `Total pot €0.75 | Main pot €0.25 | STP €0.50 | Rake €0.04`.
/// A lone `Main` column (RIO prints one whenever it prints `STP`) is no
/// side-pot structure and is dropped.
fn parse_pot_line(line: &str, unit: &CurrencyUnit) -> Option<PotLine> {
    let columns: Vec<&str> = line.split('|').map(js::trim).collect();
    let total = POT_TOTAL.captures(columns[0])?;
    let mut pots = Vec::new();
    let mut fees = PhfFees::ZERO;
    let mut house_chips: Amount = 0;
    for column in &columns[1..] {
        if let Some(pot) = POT_COLUMN.captures(column) {
            let index = pot
                .get(2)
                .filter(|m| !m.as_str().is_empty())
                .map_or(String::new(), |m| format!("-{}", m.as_str()));
            pots.push(PhfPot {
                name: format!("{}{index}", &pot[1]),
                amount: parse_amount(&pot[3], unit),
            });
            continue;
        }
        if let Some(rake) = RAKE_COLUMN.captures(column) {
            fees.rake = parse_amount(&rake[1], unit);
            continue;
        }
        if let Some(stp) = STP_COLUMN.captures(column) {
            house_chips = house_chips.saturating_add(parse_amount(&stp[1], unit));
        }
        // Any other column is left alone.
    }
    Some(PotLine {
        total: parse_amount(&total[1], unit),
        pots: if pots.iter().any(|pot| pot.name.starts_with("Side")) {
            pots
        } else {
            Vec::new()
        },
        fees,
        house_chips,
    })
}

/// `houseChipMovement`: RIO's "Splash The Pot".
fn house_chip_movement(amount: Amount, line: &str) -> PhfChipMovement {
    PhfChipMovement {
        kind: "splash-the-pot".to_owned(),
        from_seat: None,
        from_player: None,
        to_pot: true,
        amount,
        raw: Some(js::trim(line).to_owned()),
        // RIO prints it under `*** HOLE CARDS ***`.
        anchor: ChipMovementAnchor::AfterHoleCards,
    }
}

static UNCALLED_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Uncalled bet \(.*\) returned to ", "");
static SHOW_DOWN: LazyLock<Regex> = crate::js_regex_lazy!(r"SHOW\s?DOWN", "i");

/// `hoistUncalledBeforeShowdown`: an uncalled return RIO prints below
/// `*** SHOWDOWN ***` moved in front of that marker, each line keeping its
/// own number.
fn hoist_uncalled_before_showdown<'a>(lines: &[&'a str]) -> Vec<(&'a str, usize)> {
    let mut out: Vec<(&'a str, usize)> = lines
        .iter()
        .enumerate()
        .map(|(index, text)| (*text, index + 1))
        .collect();
    for i in 0..out.len() {
        if !UNCALLED_LINE.is_match(js::trim(out[i].0)) {
            continue;
        }
        // The nearest marker above it has to be the showdown one.
        let mut marker = None;
        for j in (0..i).rev() {
            let above = js::trim(out[j].0);
            if above.starts_with("***") {
                if SHOW_DOWN.is_match(above) {
                    marker = Some(j);
                }
                break;
            }
        }
        let Some(marker) = marker else {
            continue;
        };
        let moved = out.remove(i);
        out.insert(marker, moved);
    }
    out
}

static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY\s*\*\*\*", "i");
static BOARD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+):", "");
static SITTING_OUT_TAIL: LazyLock<Regex> = crate::js_regex_lazy!(r"\bis sitting out\b", "i");
static HERO_TAG: LazyLock<Regex> = crate::js_regex_lazy!(r"\[hero\]", "i");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS\s*\*\*\*", "i");
static STP_ADDED: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^STP added:\s*${MONEY}\s*$", "", ""));
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
static DEAD: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): posts ${MONEY}${SUFFIX}$", SUFFIX, ""));
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?): (folds|checks)$", "");
static WAGER: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): (calls|bets) ${MONEY}${SUFFIX}$", SUFFIX, ""));
static RAISE: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$", SUFFIX, ""));
static SHOWS: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?):? shows \[([^\]]*)\](?:\s*(?:for |\()(.+?)\)?)?$",
    ""
);
static MUCK: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): (mucks hand|doesn't show hand)$", "i");
static SITTING_OUT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)[: ]+(?:is sitting out|sits out)\s*$", "i");

/// `parseStarsFamilyBody(lines, draft, unit)`: reads every line below the
/// header into `draft`. `lines` is the whole hand including its header line
/// (already parsed by the caller), so warning line numbers match the source.
///
/// `Err` only where the TypeScript keeps a seat number beyond `u32` (a
/// `parser-error` here). A table size or button beyond `u32` is held back by
/// [`StarsHandDraft::set_table_numbers`] and fails `build` only if nothing
/// replaced it (R0.8: PokerBros rewrites a button on an empty seat).
#[allow(clippy::too_many_lines)]
pub fn parse_stars_family_body(
    lines: &[&str],
    draft: &mut StarsHandDraft,
    unit: &CurrencyUnit,
) -> Result<DialectResult, ParseError> {
    let money = |value: &str| parse_amount(value, unit);
    let mut result = DialectResult::default();
    let mut seat_of: HashMap<String, u32> = HashMap::new();
    let ordered = hoist_uncalled_before_showdown(lines);
    let mut in_summary = false;

    for &(raw_line, line_no) in ordered.iter().skip(1) {
        let line = js::trim(raw_line);
        let line_no = u32::try_from(line_no).ok();
        if line.is_empty() {
            continue;
        }

        if SUMMARY.is_match(line) {
            in_summary = true;
            result.saw_summary = true;
            continue;
        }

        if in_summary {
            if let Some(pot) = parse_pot_line(line, unit) {
                draft.summary_pot(pot.total, pot.pots, pot.fees);
                // Promotional chips are stated twice; a disagreement is
                // surfaced.
                let added = result
                    .chip_movements
                    .iter()
                    .fold(0, |sum: Amount, movement| {
                        sum.saturating_add(movement.amount)
                    });
                if pot.house_chips != added {
                    draft.warn(
                        "house-chips-mismatch",
                        format!(
                            "The SUMMARY reports {} of promotional chips but {added} were added.",
                            pot.house_chips
                        ),
                        line_no,
                    );
                }
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
            // A size or button beyond `u32` is held back until the hand is
            // built: a later table line, or the caller, may replace it.
            let button = table
                .get(4)
                .filter(|m| !m.as_str().is_empty())
                .map(|m| JsNumber::parse(m.as_str()));
            let size = JsNumber::parse(&table[2]);
            let size = if size.is_nan() || size.strict_equals(JsNumber::ZERO) {
                JsNumber::ZERO
            } else {
                size
            };
            result.button_seat_number = button;
            result.button_seat =
                button.and_then(|n| n.to_i64().and_then(|n| u32::try_from(n).ok()));
            let name = table.get(1).map_or("", |m| m.as_str());
            result.table_name = (!name.is_empty()).then(|| name.to_owned());
            result.max_seats_number = size;
            result.max_seats = size
                .to_i64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0);
            draft.set_table_numbers(result.table_name.clone(), size, button, None);
            continue;
        }

        if let Some(seat) = SEAT.captures(line) {
            let tail = seat.get(4).map_or("", |m| m.as_str());
            let number = u32_or_bug(&seat[1], "a seat number")?;
            result.seats.push(number);
            seat_of.insert(seat[2].to_owned(), number);
            draft.seat(
                number,
                &seat[2],
                money(&seat[3]),
                SITTING_OUT_TAIL.is_match(tail),
            );
            // RIO tags the observer's own seat.
            if HERO_TAG.is_match(tail) {
                draft.set_hero(&seat[2]);
            }
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

        if let Some(stp) = STP_ADDED.captures(line) {
            result
                .chip_movements
                .push(house_chip_movement(money(&stp[1]), line));
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
            let player = js::trim(&uncalled[2]);
            let stated = money(&uncalled[1]);
            let committed = draft.committed(player);
            let house = result
                .chip_movements
                .iter()
                .filter(|movement| movement.to_pot)
                .fold(0, |sum: Amount, movement| {
                    sum.saturating_add(movement.amount)
                });
            // RIO folds the splash into the printed return; cap it at what
            // was committed, but only when the excess is exactly the splash.
            let amount = if stated.saturating_sub(committed) == house && house > 0 {
                committed
            } else {
                stated
            };
            if amount != stated {
                draft.warn(
                    "uncalled-includes-promo",
                    format!(
                        "The return of {stated} to {player} includes {house} of promotional \
                         chips; {amount} was actually committed and the rest stays in the pot."
                    ),
                    line_no,
                );
            }
            draft.uncalled(player, amount, line_no, line);
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
            let small = js::to_lower_case(&blind[2]) == "small";
            if small && result.small_blind_seat.is_none() {
                result.small_blind_seat = seat_of.get(&blind[1]).copied();
            }
            draft.post(
                &blind[1],
                if small {
                    ActionType::SmallBlind
                } else {
                    ActionType::BigBlind
                },
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

        if let Some(dead) = DEAD.captures(line) {
            // Neither room has a straddle: a bare `posts` is dead money.
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

        // `1087383: shows [8h 9h]` (PokerBros), `Ricky N shows [..] for ..`
        // (RIO, no colon).
        if let Some(shows) = SHOWS.captures(line)
            && draft.is_seated(js::trim(&shows[1]))
        {
            draft.show(
                js::trim(&shows[1]),
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
            if let Some(sitting_out) = SITTING_OUT.captures(line) {
                draft.mark_sitting_out(&sitting_out[1]);
            }
            continue;
        }

        draft.warn("unknown-line", line, line_no);
    }

    Ok(result)
}

#[cfg(test)]
mod tests;

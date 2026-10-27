//! The draft -> PHF builder of the rooms that state a hand as "who put how
//! much in, and who took how much out"
//! (`web/src/lib/parsers/shared/p2-handbuilder.ts`): 888poker,
//! partypoker and PokerBros' party dialect (R0.8), iPoker and MicroGaming
//! (R0.9), Ongame, Entraction and Unibet (R0.10).
//!
//! None of them prints a pot total, a rake line or an uncalled return, so a
//! site parser reads its dialect into a [`HandDraft`] - seats, an ordered
//! action list with the chips each action *adds*, the board and what each
//! player collected - and this module
//!
//! 1. replays the betting into per-street commitments (which turns
//!    partypoker's `raises [$0.70]` into `raises $0.45 to $0.80`),
//! 2. derives the uncalled return,
//! 3. derives the pot and the rake, refusing the hand (`inconsistent-pot`)
//!    when the contributions and the winnings cannot be reconciled,
//! 4. writes GG-style standard text and reads it with
//!    [`parse_standard_hand`] - the route WePlay takes - then puts the site's
//!    own text back on `meta.rawText`.
//!
//! **Amounts are JavaScript numbers** ([`JsNumber`]): the TypeScript computes
//! with doubles and prints the results into the text it re-reads, so a
//! commitment, return, pot or rake is the double the TypeScript has - beyond
//! 2^53 included (`$1e+21` reads back as 121 cents there, and here). Seats,
//! the table size and the button are JavaScript numbers for the same reason:
//! they are printed (`Seat 007:` is read as `Seat 7:`).

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::detect::{ParseError, ParseSkip, SiteParserContext, SkipReason};
use crate::js::{self, JsNumber};
use crate::phf::hilo::{HiLoAward, StatedAward, check_stated_halves, order_hi_lo_awards};
use crate::phf::money::format_amount_js;
use crate::phf::serialize::{StandardContext, parse_standard_hand, utc_fields};
use crate::phf::{
    Amount, CurrencyUnit, DecimalStyle, PhfHand, PhfWarning, PotHalf, is_hi_lo_label,
};

/// `DraftStreet`. `showdown` is generated, never drafted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DraftStreet {
    Preflop,
    Flop,
    Turn,
    River,
    /// Not a street: what a site parser's street table (an object literal)
    /// gives for a key that names a member of `Object.prototype` - MicroGaming
    /// `<Action type="toString">`, iPoker `<round no="constructor">` - carried
    /// as `String()` of that member. The replay has no line list for it, so a
    /// betting action on it throws (`Cannot read properties of undefined
    /// (reading 'push')`, a `parser-error`); a reveal on it is kept.
    Unlisted(&'static str),
}

impl DraftStreet {
    /// The TypeScript string (`String(street)`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preflop => "preflop",
            Self::Flop => "flop",
            Self::Turn => "turn",
            Self::River => "river",
            Self::Unlisted(text) => text,
        }
    }

    const fn index(self) -> Option<usize> {
        match self {
            Self::Preflop => Some(0),
            Self::Flop => Some(1),
            Self::Turn => Some(2),
            Self::River => Some(3),
            Self::Unlisted(_) => None,
        }
    }
}

/// The member of `Object.prototype` an object-literal lookup `TABLE[key]`
/// finds when `key` is not one of the table's own keys, as `String()` of it
/// (what a template literal prints): `None` when there is none, which is
/// TypeScript's `undefined`.
pub fn object_prototype_member(key: &str) -> Option<&'static str> {
    Some(match key {
        "constructor" => "function Object() { [native code] }",
        "__defineGetter__" => "function __defineGetter__() { [native code] }",
        "__defineSetter__" => "function __defineSetter__() { [native code] }",
        "hasOwnProperty" => "function hasOwnProperty() { [native code] }",
        "__lookupGetter__" => "function __lookupGetter__() { [native code] }",
        "__lookupSetter__" => "function __lookupSetter__() { [native code] }",
        "isPrototypeOf" => "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" => "function propertyIsEnumerable() { [native code] }",
        "toString" => "function toString() { [native code] }",
        "valueOf" => "function valueOf() { [native code] }",
        "__proto__" => "[object Object]",
        "toLocaleString" => "function toLocaleString() { [native code] }",
        _ => return None,
    })
}

/// `DRAFT_STREETS`.
pub const DRAFT_STREETS: [DraftStreet; 4] = [
    DraftStreet::Preflop,
    DraftStreet::Flop,
    DraftStreet::Turn,
    DraftStreet::River,
];

/// `DraftSeat`. A seat that sat the hand out is dropped (`dealt_in: false`)
/// rather than carried, so the position ring is not shifted by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftSeat {
    /// `Number(...)` of the seat digits.
    pub seat: JsNumber,
    pub name: String,
    pub starting_stack: JsNumber,
    pub dealt_in: bool,
    pub is_hero: bool,
    /// Cards shown at deal time; normally the hero's only.
    pub dealt_cards: Vec<String>,
}

/// `DraftKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DraftKind {
    Ante,
    SmallBlind,
    BigBlind,
    Post,
    Straddle,
    Fold,
    Check,
    Call,
    Bet,
    Raise,
    /// The source only said "all-in"; the builder works out call/bet/raise.
    Allin,
    Show,
    Muck,
    /// Not a kind: what iPoker's action table gives for a `type` that names a
    /// member of `Object.prototype` (`type="toString"`). No case of the
    /// replay matches it, so it writes nothing and moves no chips; it only
    /// closes the betting street it is on, as every non-reveal does.
    Unmatched,
}

/// `DraftAction`. `undefined` optional fields are `None` / `false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftAction {
    pub street: DraftStreet,
    pub player: String,
    pub kind: DraftKind,
    /// Chips this action adds (or, with `to_total`, the actor's street
    /// total).
    pub amount: Option<JsNumber>,
    /// `amount` is the actor's total for the street, not the increment.
    pub to_total: bool,
    /// Chips added alongside `amount` that do not count toward the street
    /// bet (`posts big blind + dead`, `posts dead blind [$1 + $2]`).
    pub dead: Option<JsNumber>,
    /// The source flagged the action as all-in.
    pub all_in: bool,
    /// Cards a `show` / `muck` revealed.
    pub cards: Option<Vec<String>>,
    /// Showdown hand description.
    pub description: Option<String>,
}

impl DraftAction {
    /// `{ street, player, kind }` with every optional field absent.
    pub fn new(street: DraftStreet, player: &str, kind: DraftKind) -> Self {
        Self {
            street,
            player: player.to_owned(),
            kind,
            amount: None,
            to_total: false,
            dead: None,
            all_in: false,
            cards: None,
            description: None,
        }
    }
}

/// `DraftCollect`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftCollect {
    pub player: String,
    pub amount: JsNumber,
    /// "pot" | "main pot" | "side pot", as the source named it.
    pub pot_name: Option<String>,
    /// The half of a hi/lo pot the room said this paid; orders the collect
    /// lines and is checked against the cards.
    pub half: Option<PotHalf>,
}

impl HiLoAward for DraftCollect {
    fn half(&self) -> Option<PotHalf> {
        self.half
    }

    fn pot_name(&self) -> Option<&str> {
        self.pot_name.as_deref()
    }
}

/// `HandDraft`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandDraft {
    pub site_id: String,
    pub site_name: String,
    pub parser_id: String,
    pub parser_version: String,
    /// Put in front of the site's hand number (`PTY-`, `888-`, `PB`).
    pub hand_prefix: String,
    pub hand_id: String,
    /// Canonical GG-style label, e.g. "Hold'em No Limit".
    pub game_label: String,
    pub unit: CurrencyUnit,
    pub decimals: DecimalStyle,
    /// Blinds from the header; overridden by what was actually posted.
    pub header_small_blind: JsNumber,
    pub header_big_blind: JsNumber,
    pub table_name: Option<String>,
    pub max_seats: JsNumber,
    pub button_seat: Option<JsNumber>,
    /// ISO 8601 UTC, or `None` when the source has no usable timestamp.
    pub played_at: Option<String>,
    pub seats: Vec<DraftSeat>,
    pub actions: Vec<DraftAction>,
    /// `Some(vec![])` is the TypeScript's `[]`: truthy, so the flop marker is
    /// still written.
    pub flop: Option<Vec<String>>,
    pub turn: Option<String>,
    pub river: Option<String>,
    pub collected: Vec<DraftCollect>,
    /// Whether `collected` already contains the winner's own uncalled bet
    /// (partypoker, iPoker: yes; 888poker: no).
    pub collected_includes_uncalled: bool,
    pub raw_text: String,
    pub warnings: Vec<PhfWarning>,
}

/* ------------------------------------------------------------ betting state */

/// A `Map<string, number>`, in insertion order.
type Commits = Vec<(String, JsNumber)>;

fn get_or_zero(map: &Commits, key: &str) -> JsNumber {
    map.iter()
        .find(|(k, _)| k == key)
        .map_or(JsNumber::ZERO, |(_, v)| *v)
}

fn set(map: &mut Commits, key: &str, value: JsNumber) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

/// A JavaScript number's truthiness (`0`, `-0` and `NaN` are falsy).
fn truthy(value: JsNumber) -> bool {
    !value.is_nan() && !value.strict_equals(JsNumber::ZERO)
}

#[derive(Debug, Clone)]
struct Show {
    player: String,
    cards: Vec<String>,
    description: Option<String>,
}

/// `Replay`.
#[derive(Debug, Clone)]
struct Replay {
    lines: [Vec<String>; 4],
    totals: [Commits; 4],
    gross: JsNumber,
    /// Player -> the street they folded on (last fold wins, first position).
    folded: Vec<(String, DraftStreet)>,
    small_blind: JsNumber,
    big_blind: JsNumber,
    small_poster: Option<String>,
    big_poster: Option<String>,
    shows: Vec<Show>,
    mucks: Vec<Show>,
}

fn money(amount: JsNumber, unit: &CurrencyUnit, decimals: DecimalStyle) -> String {
    format_amount_js(amount, unit, decimals, false)
}

/// `replayActions(draft)`: the action list as standard-text lines per street,
/// with the commitments the uncalled return and the pot come from.
fn replay_actions(draft: &HandDraft) -> Result<Replay, ParseError> {
    let (unit, decimals) = (&draft.unit, draft.decimals);
    let mut replay = Replay {
        lines: Default::default(),
        totals: Default::default(),
        gross: JsNumber::ZERO,
        folded: Vec::new(),
        small_blind: JsNumber::ZERO,
        big_blind: JsNumber::ZERO,
        small_poster: None,
        big_poster: None,
        shows: Vec::new(),
        mucks: Vec::new(),
    };
    // `contributed` is kept by the TypeScript and never read; not ported.
    let mut street = DraftStreet::Preflop;
    let mut commit: Commits = Vec::new();
    let mut bet = JsNumber::ZERO;

    let put = |commit: &mut Commits,
               bet: &mut JsNumber,
               gross: &mut JsNumber,
               player: &str,
               live: JsNumber,
               dead: JsNumber|
     -> JsNumber {
        let next = get_or_zero(commit, player) + live;
        set(commit, player, next);
        *bet = bet.max_of(next);
        *gross = *gross + (live + dead);
        next
    };

    for action in &draft.actions {
        match action.kind {
            DraftKind::Show => {
                replay.shows.push(Show {
                    player: action.player.clone(),
                    cards: action.cards.clone().unwrap_or_default(),
                    description: action.description.clone(),
                });
                continue;
            }
            DraftKind::Muck => {
                replay.mucks.push(Show {
                    player: action.player.clone(),
                    cards: action.cards.clone().unwrap_or_default(),
                    description: None,
                });
                continue;
            }
            _ => {}
        }
        // Reveals cannot close a betting street (above): a showdown reveal is
        // tagged with the street it happened on.
        if action.street != street {
            let closed = std::mem::take(&mut commit);
            if let Some(index) = street.index() {
                replay.totals[index] = closed;
            }
            street = action.street;
            bet = JsNumber::ZERO;
        }
        if action.kind == DraftKind::Unmatched {
            // No case of the switch matches.
            continue;
        }
        let Some(line_index) = action.street.index() else {
            // `lines.get(street)` is `undefined`, and every case pushes onto it.
            return Err(ParseError::Bug(
                "Cannot read properties of undefined (reading 'push')".to_owned(),
            ));
        };
        let player = action.player.as_str();
        let all_in = if action.all_in { " and is all-in" } else { "" };
        let already = get_or_zero(&commit, player);
        let stated = action.amount.unwrap_or(JsNumber::ZERO);
        let amount = if action.to_total {
            JsNumber::ZERO.max_of(stated - already)
        } else {
            stated
        };
        let dead = action.dead.unwrap_or(JsNumber::ZERO);
        let gross = &mut replay.gross;
        let out = &mut replay.lines[line_index];

        match action.kind {
            DraftKind::Ante => {
                // Antes are dead: they never count toward the street bet.
                *gross = *gross + amount;
                out.push(format!(
                    "{player}: posts the ante {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            DraftKind::SmallBlind => {
                replay.small_blind = replay.small_blind.max_of(amount);
                if replay.small_poster.is_none() {
                    replay.small_poster = Some(player.to_owned());
                }
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: posts small blind {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            DraftKind::BigBlind => {
                replay.big_blind = replay.big_blind.max_of(amount);
                if replay.big_poster.is_none() {
                    replay.big_poster = Some(player.to_owned());
                }
                // Dead money rides on the same source line and is re-emitted
                // first as a missed blind (the order a round trip keeps).
                if dead.greater_than(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: posts missed blind {}",
                        money(dead, unit, decimals)
                    ));
                }
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: posts big blind {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            DraftKind::Post | DraftKind::Straddle => {
                if dead.greater_than(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: posts missed blind {}",
                        money(dead, unit, decimals)
                    ));
                }
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: posts {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            DraftKind::Fold => {
                if let Some(entry) = replay.folded.iter_mut().find(|(p, _)| p == player) {
                    entry.1 = action.street;
                } else {
                    replay.folded.push((player.to_owned(), action.street));
                }
                out.push(format!("{player}: folds"));
            }
            DraftKind::Check => out.push(format!("{player}: checks")),
            DraftKind::Call => {
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: calls {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            DraftKind::Bet => {
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: bets {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            DraftKind::Raise | DraftKind::Allin => {
                // A call, a bet and a raise read alike here; which one it was
                // follows from the betting state.
                let over = bet;
                let to = put(&mut commit, &mut bet, gross, player, amount, dead);
                let flag = if action.kind == DraftKind::Allin {
                    " and is all-in"
                } else {
                    all_in
                };
                if matches!(to.compare(over), Some(Ordering::Less | Ordering::Equal)) {
                    out.push(format!(
                        "{player}: calls {}{flag}",
                        money(amount, unit, decimals)
                    ));
                } else if over.greater_than(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: raises {} to {}{flag}",
                        money(to - over, unit, decimals),
                        money(to, unit, decimals)
                    ));
                } else {
                    out.push(format!(
                        "{player}: bets {}{flag}",
                        money(amount, unit, decimals)
                    ));
                }
            }
            DraftKind::Show | DraftKind::Muck | DraftKind::Unmatched => {}
        }
    }
    if let Some(index) = street.index() {
        replay.totals[index] = commit;
    }
    Ok(replay)
}

/// The uncalled bet none of these rooms prints.
#[derive(Debug, Clone)]
struct Uncalled {
    player: String,
    amount: JsNumber,
    street: DraftStreet,
}

/// `deriveUncalled(replay)`: on the last street that saw money, whoever
/// committed more than anybody else gets the difference back; a tie returns
/// nothing.
fn derive_uncalled(replay: &Replay) -> Option<Uncalled> {
    for street in DRAFT_STREETS.iter().rev() {
        let Some(index) = street.index() else {
            continue;
        };
        let mut entries: Vec<&(String, JsNumber)> = replay.totals[index]
            .iter()
            .filter(|(_, value)| value.greater_than(JsNumber::ZERO))
            .collect();
        if entries.is_empty() {
            continue;
        }
        // `sort((a, b) => b[1] - a[1])`, as V8 sorts.
        js::sort::sort_by(&mut entries, |a, b| b.1 - a.1);
        let (player, top) = entries[0];
        let second = entries.get(1).map_or(JsNumber::ZERO, |entry| entry.1);
        return top.greater_than(second).then(|| Uncalled {
            player: player.clone(),
            amount: *top - second,
            street: *street,
        });
    }
    None
}

/// `Settlement`.
#[derive(Debug, Clone)]
struct Settlement {
    uncalled: Option<Uncalled>,
    collected: Vec<DraftCollect>,
    total_pot: JsNumber,
    rake: JsNumber,
}

fn sum(entries: &[DraftCollect]) -> JsNumber {
    entries
        .iter()
        .fold(JsNumber::ZERO, |total, entry| total + entry.amount)
}

/// `settle(draft, replay)`: the reading with the uncalled return first, then
/// the one without; `inconsistent-pot` when neither gives a non-negative
/// rake.
fn settle(draft: &HandDraft, replay: &Replay) -> Result<Settlement, ParseSkip> {
    let uncalled = derive_uncalled(replay);
    let reported = sum(&draft.collected);
    let hi_lo = is_hi_lo_label(&draft.game_label);
    let ordered = |entries: Vec<DraftCollect>| {
        if hi_lo {
            order_hi_lo_awards(entries)
        } else {
            entries
        }
    };
    let positive = |entry: &DraftCollect| entry.amount.greater_than(JsNumber::ZERO);

    let with_return = || -> Option<Settlement> {
        let uncalled = uncalled.as_ref()?;
        let mut entries = draft.collected.clone();
        let mut remaining = uncalled.amount;
        if draft.collected_includes_uncalled {
            // A line that matches the return exactly *is* the return;
            // otherwise it is taken off the winner's pots in order.
            let exact = entries.iter().position(|entry| {
                entry.player == uncalled.player && entry.amount.strict_equals(remaining)
            });
            if let Some(exact) = exact {
                entries.remove(exact);
                remaining = JsNumber::ZERO;
            } else {
                for entry in &mut entries {
                    if entry.player != uncalled.player || remaining.strict_equals(JsNumber::ZERO) {
                        continue;
                    }
                    let take = remaining.min_of(entry.amount);
                    entry.amount = entry.amount - take;
                    remaining = remaining - take;
                }
            }
            if remaining.greater_than(JsNumber::ZERO) {
                return None;
            }
        }
        let kept = ordered(entries.into_iter().filter(positive).collect());
        let total_pot = replay.gross - uncalled.amount;
        let rake = total_pot - sum(&kept);
        (!rake.less_than(JsNumber::ZERO)).then(|| Settlement {
            uncalled: Some(uncalled.clone()),
            collected: kept,
            total_pot,
            rake,
        })
    };

    let without_return = || -> Option<Settlement> {
        let kept = ordered(
            draft
                .collected
                .iter()
                .filter(|e| positive(e))
                .cloned()
                .collect(),
        );
        let rake = replay.gross - reported;
        (!rake.less_than(JsNumber::ZERO)).then_some(Settlement {
            uncalled: None,
            collected: kept,
            total_pot: replay.gross,
            rake,
        })
    };

    if let Some(settlement) = with_return().or_else(without_return) {
        return Ok(settlement);
    }
    Err(ParseSkip::new(
        SkipReason::InconsistentPot,
        format!(
            "Players put in {} but the hand reports {} collected, which cannot be reconciled \
             with or without an uncalled return.",
            replay.gross.to_js_string(),
            reported.to_js_string()
        ),
    ))
}

/* ------------------------------------------------------------------ summary */

/// `positionLabelsFor(seat, seats, buttonSeat, blinds)`.
fn position_labels_for(
    seat: JsNumber,
    seats: &[&DraftSeat],
    button_seat: Option<JsNumber>,
    replay: &Replay,
) -> Vec<&'static str> {
    let mut labels = Vec::new();
    let name = seats
        .iter()
        .find(|entry| entry.seat.strict_equals(seat))
        .map(|entry| entry.name.as_str());
    if button_seat.is_some_and(|button| seat.strict_equals(button)) {
        labels.push("(button)");
    }
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        if replay.small_poster.as_deref() == Some(name) {
            labels.push("(small blind)");
        }
        if replay.big_poster.as_deref() == Some(name) {
            labels.push("(big blind)");
        }
    }
    labels
}

/// `capitalize(street)` of a drafted street.
fn capitalized(street: DraftStreet) -> String {
    match street {
        DraftStreet::Preflop => "Preflop".to_owned(),
        DraftStreet::Flop => "Flop".to_owned(),
        DraftStreet::Turn => "Turn".to_owned(),
        DraftStreet::River => "River".to_owned(),
        // Unreached (a fold on such a street throws first); `capitalize`
        // of its ASCII text all the same.
        DraftStreet::Unlisted(text) => {
            let mut chars = text.chars();
            chars.next().map_or_else(String::new, |first| {
                format!(
                    "{}{}",
                    js::to_upper_case(&first.to_string()),
                    chars.as_str()
                )
            })
        }
    }
}

/* -------------------------------------------------------------------- build */

/// `draftToStandardText(draft)`: the draft as standard text; the
/// `inconsistent-pot` refusal when its money cannot be reconciled.
#[allow(clippy::too_many_lines)]
pub fn draft_to_standard_text(draft: &HandDraft) -> Result<String, ParseError> {
    let (unit, decimals) = (&draft.unit, draft.decimals);
    let replay = replay_actions(draft)?;
    let settlement = settle(draft, &replay)?;
    let mut seats: Vec<&DraftSeat> = draft.seats.iter().filter(|seat| seat.dealt_in).collect();
    // `sort((a, b) => a.seat - b.seat)`, as V8 sorts.
    js::sort::sort_by(&mut seats, |a, b| a.seat - b.seat);

    let small_blind = if truthy(replay.small_blind) {
        replay.small_blind
    } else {
        draft.header_small_blind
    };
    let big_blind = if truthy(replay.big_blind) {
        replay.big_blind
    } else {
        draft.header_big_blind
    };
    let stakes = format!(
        "{}/{}",
        money(small_blind, unit, decimals),
        money(big_blind, unit, decimals)
    );
    let date = match draft.played_at.as_deref() {
        Some(iso) if !iso.is_empty() => format_header_date(iso),
        _ => String::new(),
    };

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "Poker Hand #{}{}: {} ({stakes}) - {date}",
        draft.hand_prefix, draft.hand_id, draft.game_label
    ));
    lines.push(format!(
        "Table '{}' {}-max{}",
        draft.table_name.as_deref().unwrap_or(""),
        draft.max_seats.to_js_string(),
        draft.button_seat.map_or(String::new(), |button| format!(
            " Seat #{} is the button",
            button.to_js_string()
        ))
    ));
    for seat in &seats {
        lines.push(format!(
            "Seat {}: {} ({} in chips)",
            seat.seat.to_js_string(),
            seat.name,
            money(seat.starting_stack, unit, decimals)
        ));
    }

    // Posting lines go before `*** HOLE CARDS ***`, the rest after it.
    let preflop = &replay.lines[0];
    let posting_count = preflop.iter().position(|line| !line.contains(": posts "));
    let (postings, preflop_body): (&[String], &[String]) = match posting_count {
        None => (preflop, &[]),
        Some(count) => (&preflop[..count], &preflop[count..]),
    };
    lines.extend(postings.iter().cloned());

    lines.push("*** HOLE CARDS ***".to_owned());
    for seat in &seats {
        if !seat.dealt_cards.is_empty() {
            lines.push(format!(
                "Dealt to {} [{}]",
                seat.name,
                seat.dealt_cards.join(" ")
            ));
        }
    }
    lines.extend(preflop_body.iter().cloned());
    let uncalled_line = |uncalled: &Uncalled| {
        format!(
            "Uncalled bet ({}) returned to {}",
            money(uncalled.amount, unit, decimals),
            uncalled.player
        )
    };
    let uncalled_on = |street: DraftStreet| {
        settlement
            .uncalled
            .as_ref()
            .filter(|uncalled| uncalled.street == street)
    };
    if let Some(uncalled) = uncalled_on(DraftStreet::Preflop) {
        lines.push(uncalled_line(uncalled));
    }

    let turn = draft.turn.as_deref().filter(|card| !card.is_empty());
    let river = draft.river.as_deref().filter(|card| !card.is_empty());
    let mut board: Vec<String> = draft.flop.clone().unwrap_or_default();
    board.extend(turn.map(str::to_owned));
    board.extend(river.map(str::to_owned));
    let emit_street = |lines: &mut Vec<String>, street: DraftStreet, marker: String| {
        lines.push(marker);
        if let Some(index) = street.index() {
            lines.extend(replay.lines[index].iter().cloned());
        }
        if let Some(uncalled) = uncalled_on(street) {
            lines.push(uncalled_line(uncalled));
        }
    };
    if let Some(flop) = &draft.flop {
        emit_street(
            &mut lines,
            DraftStreet::Flop,
            format!("*** FLOP *** [{}]", flop.join(" ")),
        );
    }
    if let Some(turn) = turn {
        let before = &board[..board.len().min(3)];
        emit_street(
            &mut lines,
            DraftStreet::Turn,
            format!("*** TURN *** [{}] [{turn}]", before.join(" ")),
        );
    }
    if let Some(river) = river {
        let before = &board[..board.len().min(4)];
        emit_street(
            &mut lines,
            DraftStreet::River,
            format!("*** RIVER *** [{}] [{river}]", before.join(" ")),
        );
    }

    lines.push("*** SHOWDOWN ***".to_owned());
    for show in &replay.shows {
        let description = show
            .description
            .as_deref()
            .filter(|d| !d.is_empty())
            .map_or(String::new(), |d| format!(" ({d})"));
        lines.push(format!(
            "{}: shows [{}]{description}",
            show.player,
            show.cards.join(" ")
        ));
    }
    for muck in &replay.mucks {
        lines.push(format!("{}: doesn't show hand", muck.player));
    }
    for entry in &settlement.collected {
        lines.push(format!(
            "{} collected {} from {}",
            entry.player,
            money(entry.amount, unit, decimals),
            entry.pot_name.as_deref().unwrap_or("pot")
        ));
    }

    lines.push("*** SUMMARY ***".to_owned());
    let zero = money(JsNumber::ZERO, unit, decimals);
    lines.push(format!(
        "Total pot {} | Rake {} | Jackpot {zero} | Bingo {zero} | Fortune {zero} | Tax {zero}",
        money(settlement.total_pot, unit, decimals),
        money(settlement.rake, unit, decimals)
    ));
    if !board.is_empty() {
        lines.push(format!("Board [{}]", board.join(" ")));
    }

    let mut won_by: HashMap<&str, JsNumber> = HashMap::new();
    for entry in &settlement.collected {
        let total = won_by
            .entry(entry.player.as_str())
            .or_insert(JsNumber::ZERO);
        *total = *total + entry.amount;
    }
    // `new Map(shows.map(...))`: the last reveal of a player wins.
    let last_of = |reveals: &[Show], name: &str| -> Option<usize> {
        reveals.iter().rposition(|reveal| reveal.player == name)
    };

    for seat in &seats {
        let labels = position_labels_for(seat.seat, &seats, draft.button_seat, &replay);
        let head = if labels.is_empty() {
            format!("Seat {}: {}", seat.seat.to_js_string(), seat.name)
        } else {
            format!(
                "Seat {}: {} {}",
                seat.seat.to_js_string(),
                seat.name,
                labels.join(" ")
            )
        };
        let won = won_by
            .get(seat.name.as_str())
            .copied()
            .unwrap_or(JsNumber::ZERO);
        let shown = last_of(&replay.shows, &seat.name).map(|i| &replay.shows[i]);
        let mucked = last_of(&replay.mucks, &seat.name).map(|i| &replay.mucks[i]);
        let folded = replay
            .folded
            .iter()
            .find(|(player, _)| *player == seat.name)
            .map(|(_, street)| *street);

        if let Some(street) = folded {
            let place = if street == DraftStreet::Preflop {
                "folded before Flop".to_owned()
            } else {
                format!("folded on the {}", capitalized(street))
            };
            // "(didn't bet)": no voluntary chip; a blind is not voluntary.
            let voluntary = draft.actions.iter().any(|action| {
                action.player == seat.name
                    && matches!(
                        action.kind,
                        DraftKind::Call | DraftKind::Bet | DraftKind::Raise | DraftKind::Allin
                    )
            });
            let cards = shown
                .or(mucked)
                .filter(|reveal| !reveal.cards.is_empty())
                .map_or(String::new(), |reveal| {
                    format!(", mucked [{}]", reveal.cards.join(" "))
                });
            lines.push(format!(
                "{head} {place}{}{cards}",
                if voluntary { "" } else { " (didn't bet)" }
            ));
            continue;
        }
        let with = |show: &Show| {
            show.description
                .as_deref()
                .filter(|d| !d.is_empty())
                .map_or(String::new(), |d| format!(" with {d}"))
        };
        if let Some(show) = shown {
            if won.greater_than(JsNumber::ZERO) {
                lines.push(format!(
                    "{head} showed [{}] and won ({}){}",
                    show.cards.join(" "),
                    money(won, unit, decimals),
                    with(show)
                ));
            } else {
                lines.push(format!(
                    "{head} showed [{}] and lost{}",
                    show.cards.join(" "),
                    with(show)
                ));
            }
            continue;
        }
        if let Some(muck) = mucked.filter(|muck| !muck.cards.is_empty()) {
            lines.push(format!("{head} mucked [{}]", muck.cards.join(" ")));
            continue;
        }
        if won.greater_than(JsNumber::ZERO) {
            lines.push(format!("{head} collected ({})", money(won, unit, decimals)));
            continue;
        }
        lines.push(format!("{head} mucked"));
    }

    Ok(lines.join("\n"))
}

/// `String(value).padStart(2, "0")`.
fn pad(value: i64) -> String {
    let text = value.to_string();
    if text.len() < 2 {
        format!("0{text}")
    } else {
        text
    }
}

/// `formatHeaderDate(iso)`: `2014-01-06T22:40:28.000Z` -> `2014/01/06
/// 22:40:28`, through `new Date(iso)` (an invalid date prints `NaN` fields).
pub fn format_header_date(iso: &str) -> String {
    let Some(f) = utc_fields(iso) else {
        return "NaN/NaN/NaN NaN:NaN:NaN".to_owned();
    };
    format!(
        "{}/{}/{} {}:{}:{}",
        f.year,
        pad(f.month),
        pad(f.day),
        pad(f.hour),
        pad(f.minute),
        pad(f.second)
    )
}

/// A JavaScript amount as the `Amount` a built hand compares it with: exact
/// for every safe integer, which is every amount a PHF can hold.
fn as_amount(value: JsNumber) -> Amount {
    value.to_i64().unwrap_or(Amount::MIN)
}

/// `buildHand(draft, ctx)`: draft in, PHF out. `meta.rawText` is the site's
/// own text, `meta.handKey` the prefixed id; on a hi/lo hand the halves the
/// room named are checked against the cards.
pub fn build_hand(draft: &HandDraft, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    if draft.seats.iter().filter(|seat| seat.dealt_in).count() < 2 {
        return Err(ParseSkip::new(
            SkipReason::TooFewPlayers,
            "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
        )
        .into());
    }

    let text = draft_to_standard_text(draft)?;
    let context = StandardContext {
        site_id: &draft.site_id,
        site_name: &draft.site_name,
        original_filename: ctx.source_filename,
        parser_id: Some(&draft.parser_id),
        parser_version: Some(&draft.parser_version),
        parsed_at: ctx.parsed_at(),
    };
    let mut hand = match parse_standard_hand(&text, &context) {
        Ok(Some(hand)) => hand,
        Ok(None) => {
            return Err(ParseSkip::new(
                SkipReason::NormalizedUnparseable,
                "The normalized text was not readable as a standard-format hand.",
            )
            .into());
        }
        Err(thrown) => return Err(ParseError::Bug(thrown.message)),
    };

    hand.meta.raw_text.clone_from(&draft.raw_text);
    let mut warnings = draft.warnings.clone();
    warnings.append(&mut hand.meta.warnings);
    hand.meta.warnings = warnings;
    if hand.game.hi_lo {
        // Whatever the room said about the halves has to agree with the cards.
        let settlement = settle(draft, &replay_actions(draft)?)?;
        let stated: Vec<StatedAward> = settlement
            .collected
            .iter()
            .map(|entry| StatedAward {
                player: entry.player.clone(),
                amount: as_amount(entry.amount),
                half: entry.half,
            })
            .collect();
        let mut checked = check_stated_halves(&hand, &stated);
        hand.meta.warnings.append(&mut checked);
    }
    hand.meta.hand_key.clone_from(&hand.meta.hand_id);
    Ok(hand)
}

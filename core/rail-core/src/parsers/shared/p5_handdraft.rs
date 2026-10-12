//! The draft -> PHF builder of Ignition / Bodog / Bovada and ACR / WPN
//! (`frontend/src/lib/parsers/shared/p5-handdraft.ts`, R0.10b).
//!
//! The third sibling of [`super::p2_handbuilder`] (which derives the whole
//! settlement) and [`super::p6_handbuilder`] (which derives it and checks it
//! against the room). Both rooms here *state* the uncalled return, the pot
//! and sometimes the rake, so this builder takes the settlement from the
//! draft and checks the replay against it:
//!
//! 1. replays the betting, turning "chips added" / "street total" into the
//!    standard `raises X to Y` form (both rooms write one token for a bet, a
//!    call and a raise, so the kind follows from the state),
//! 2. keeps live and dead money apart (a dead blind is in the pot but not in
//!    the street bet),
//! 3. refuses a hand whose replay disagrees with the stated pot
//!    (`chip-mismatch`) or with a stated per-player contribution
//!    (`contribution-mismatch`), whose pot nobody collected (`no-winner`) or
//!    whose payouts exceed it (`inconsistent-pot`), and books whatever the pot
//!    lost beyond the stated rake as a jackpot fee,
//! 4. writes GG-style standard text and reads it with [`parse_standard_hand`],
//!    then puts the site's own text back on `meta.rawText`.
//!
//! **Amounts are JavaScript numbers** ([`JsNumber`]), as in the two sibling
//! builders: the TypeScript replays in doubles, prints the results into the
//! text it re-reads and prints them into its refusal messages. Seats, the
//! table size and the button are JavaScript numbers for the same reason
//! (`Seat 007:` prints as `Seat 7:`).

use std::cmp::Ordering;
use std::collections::HashMap;

use super::p2_handbuilder::format_header_date;
use crate::detect::{ParseError, ParseSkip, SiteParserContext, SkipReason};
use crate::js::{self, JsNumber};
use crate::phf::money::format_amount_js;
use crate::phf::serialize::{StandardContext, parse_standard_hand};
use crate::phf::{CurrencyUnit, DecimalStyle, PhfHand, PhfWarning};

/// `P5Street`. `showdown` is generated, never drafted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum P5Street {
    Preflop,
    Flop,
    Turn,
    River,
}

impl P5Street {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preflop => "preflop",
            Self::Flop => "flop",
            Self::Turn => "turn",
            Self::River => "river",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Preflop => 0,
            Self::Flop => 1,
            Self::Turn => 2,
            Self::River => 3,
        }
    }

    /// `capitalize(street)`.
    const fn capitalized(self) -> &'static str {
        match self {
            Self::Preflop => "Preflop",
            Self::Flop => "Flop",
            Self::Turn => "Turn",
            Self::River => "River",
        }
    }
}

/// `P5_STREETS`.
pub const P5_STREETS: [P5Street; 4] = [
    P5Street::Preflop,
    P5Street::Flop,
    P5Street::Turn,
    P5Street::River,
];

/// `TOLERANCE`: one minor unit of slack, the validator's.
fn tolerance() -> JsNumber {
    JsNumber::from_u64(1)
}

/// `P5Seat`. Seats that only sat at the table are dropped (`dealt_in:
/// false`): the position ring is numbered from every seat it is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P5Seat {
    /// `Number(...)` of the seat digits.
    pub seat: JsNumber,
    pub name: String,
    pub starting_stack: JsNumber,
    pub is_hero: bool,
    /// The seat took part in this hand.
    pub dealt_in: bool,
    /// Cards the source printed at deal time, if any.
    pub dealt_cards: Vec<String>,
}

/// `P5Kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum P5Kind {
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
    /// The source printed the return itself; `amount` is what came back.
    Uncalled,
    Show,
    Muck,
}

impl P5Kind {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ante => "ante",
            Self::SmallBlind => "small-blind",
            Self::BigBlind => "big-blind",
            Self::Post => "post",
            Self::Straddle => "straddle",
            Self::Fold => "fold",
            Self::Check => "check",
            Self::Call => "call",
            Self::Bet => "bet",
            Self::Raise => "raise",
            Self::Allin => "allin",
            Self::Uncalled => "uncalled",
            Self::Show => "show",
            Self::Muck => "muck",
        }
    }
}

/// `P5Action`. `undefined` optional fields are `None` / `false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P5Action {
    pub street: P5Street,
    pub player: String,
    pub kind: P5Kind,
    /// Chips this action adds to the pot, unless `to_total` says otherwise.
    pub amount: Option<JsNumber>,
    /// `amount` is the actor's total for the street, not the increment.
    pub to_total: bool,
    /// Chips added alongside `amount` that do not count toward the street
    /// bet (a dead blind owed by a returning player).
    pub dead: Option<JsNumber>,
    /// The source flagged the action as all-in.
    pub all_in: bool,
    /// Cards a `show` / `muck` revealed (hole cards, never a best five).
    pub cards: Option<Vec<String>>,
    /// Showdown hand description, e.g. "Two pair".
    pub description: Option<String>,
}

impl P5Action {
    /// `{ street, player, kind }` with every optional field absent.
    pub fn new(street: P5Street, player: &str, kind: P5Kind) -> Self {
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

/// `P5Collect`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P5Collect {
    pub player: String,
    pub amount: JsNumber,
    /// "pot" | "main pot" | "side pot", as the source named it.
    pub pot_name: Option<String>,
}

/// `P5Tournament`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P5Tournament {
    pub id: String,
    /// Free text the header carried, e.g. "Turbo"; `None` when there is none.
    pub name: Option<String>,
    /// Printed buy-in, e.g. `$25+$2.50`.
    pub buy_in_token: String,
    pub level_label: String,
}

/// `P5Draft`. The TypeScript `Map`s are vectors of pairs in insertion order
/// (a key appears once).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P5Draft {
    pub site_id: String,
    pub site_name: String,
    pub parser_id: String,
    pub parser_version: String,
    pub hand_id: String,
    /// Canonical GG-style label, e.g. "Hold'em No Limit".
    pub game_label: String,
    pub unit: CurrencyUnit,
    pub decimals: DecimalStyle,
    /// Blinds for the header.
    pub small_blind: JsNumber,
    pub big_blind: JsNumber,
    pub table_name: Option<String>,
    pub max_seats: JsNumber,
    pub button_seat: Option<JsNumber>,
    /// ISO 8601 UTC, or `None` when the source omits a usable timestamp.
    pub played_at: Option<String>,
    pub tournament: Option<P5Tournament>,
    pub seats: Vec<P5Seat>,
    pub actions: Vec<P5Action>,
    /// `Some(vec![])` is the TypeScript's truthy `[]`: the flop marker is
    /// still written.
    pub flop: Option<Vec<String>>,
    pub turn: Option<String>,
    pub river: Option<String>,
    pub collected: Vec<P5Collect>,
    /// The pot as the source stated it, or `None` to take the replay's total.
    pub stated_pot: Option<JsNumber>,
    /// The rake as the source stated it, or `None` to call the whole
    /// shortfall rake.
    pub stated_rake: Option<JsNumber>,
    /// Per-player totals the source reports independently of its action
    /// lines (WPN's `Bets:` column), checked against the replay.
    pub stated_contributions: Option<Vec<(String, JsNumber)>>,
    /// Cards each seat held, when the source revealed them outside the deal.
    pub hole_cards: Vec<(String, Vec<String>)>,
    pub raw_text: String,
    pub warnings: Vec<PhfWarning>,
}

/* ------------------------------------------------------------ betting state */

/// A `Map<string, number>`, in insertion order.
type Totals = Vec<(String, JsNumber)>;

fn get_or_zero(map: &Totals, key: &str) -> JsNumber {
    map.iter()
        .find(|(k, _)| k == key)
        .map_or(JsNumber::ZERO, |(_, v)| *v)
}

fn set(map: &mut Totals, key: &str, value: JsNumber) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

/// `Math.abs(a - b) > TOLERANCE` (false when either is `NaN`).
fn off_by_more_than_tolerance(a: JsNumber, b: JsNumber) -> bool {
    (a - b).abs().greater_than(tolerance())
}

fn money(amount: JsNumber, unit: &CurrencyUnit, decimals: DecimalStyle) -> String {
    format_amount_js(amount, unit, decimals, false)
}

#[derive(Debug, Clone)]
struct Reveal {
    player: String,
    cards: Vec<String>,
    description: Option<String>,
}

/// `Replay`. (`lastStreet` is computed by the TypeScript and never read; not
/// ported.)
#[derive(Debug, Clone, Default)]
struct Replay {
    lines: [Vec<String>; 4],
    /// Lines that belong above `*** HOLE CARDS ***`.
    pre_deal: Vec<String>,
    /// Everything every player put in, dead money and returns included.
    gross: JsNumber,
    /// The same total per player.
    contributed: Totals,
    /// Player -> the street they folded on (last fold wins, first position).
    folded: Vec<(String, P5Street)>,
    voluntary: Vec<String>,
    small_poster: Option<String>,
    big_poster: Option<String>,
    shows: Vec<Reveal>,
    mucks: Vec<Reveal>,
}

impl Replay {
    /// `bank(player, amount)`.
    fn bank(&mut self, player: &str, amount: JsNumber) {
        let next = get_or_zero(&self.contributed, player) + amount;
        set(&mut self.contributed, player, next);
        self.gross = self.gross + amount;
    }

    fn add_voluntary(&mut self, player: &str) {
        if !self.voluntary.iter().any(|p| p == player) {
            self.voluntary.push(player.to_owned());
        }
    }
}

/// The street-local betting state of `replayActions`.
struct Betting {
    commit: Totals,
    bet: JsNumber,
}

impl Betting {
    /// `put(player, live, dead)`: `live` toward the street bet, `dead`
    /// straight into the pot.
    fn put(
        &mut self,
        replay: &mut Replay,
        player: &str,
        live: JsNumber,
        dead: JsNumber,
    ) -> JsNumber {
        let next = get_or_zero(&self.commit, player) + live;
        set(&mut self.commit, player, next);
        self.bet = self.bet.max_of(next);
        replay.bank(player, live + dead);
        next
    }
}

/// `replayActions(draft)`: the action list as standard-text lines.
#[allow(clippy::too_many_lines)]
fn replay_actions(draft: &P5Draft) -> Replay {
    let (unit, decimals) = (&draft.unit, draft.decimals);
    let mut replay = Replay::default();
    let mut street = P5Street::Preflop;
    let mut betting = Betting {
        commit: Vec::new(),
        bet: JsNumber::ZERO,
    };

    for action in &draft.actions {
        match action.kind {
            P5Kind::Show => {
                replay.shows.push(Reveal {
                    player: action.player.clone(),
                    cards: action.cards.clone().unwrap_or_default(),
                    description: action.description.clone(),
                });
                continue;
            }
            P5Kind::Muck => {
                replay.mucks.push(Reveal {
                    player: action.player.clone(),
                    cards: action.cards.clone().unwrap_or_default(),
                    description: None,
                });
                continue;
            }
            _ => {}
        }
        // Reveals cannot close a street (above): after an all-in run-out a
        // reveal is tagged with an earlier street than the last that saw
        // money.
        if action.street != street {
            street = action.street;
            betting.commit = Vec::new();
            betting.bet = JsNumber::ZERO;
        }
        let player = action.player.as_str();
        // Antes, blinds and straddles go above the deal; everything else,
        // `post` included, stays in the street body.
        let to_pre_deal = matches!(
            action.kind,
            P5Kind::Ante | P5Kind::SmallBlind | P5Kind::BigBlind | P5Kind::Straddle
        );
        let already = get_or_zero(&betting.commit, player);
        let stated = action.amount.unwrap_or(JsNumber::ZERO);
        let amount = if action.to_total {
            JsNumber::ZERO.max_of(stated - already)
        } else {
            stated
        };
        let dead = action.dead.unwrap_or(JsNumber::ZERO);
        let all_in = if action.all_in { " and is all-in" } else { "" };
        let mut out: Vec<String> = Vec::new();

        match action.kind {
            P5Kind::Ante => {
                // Antes never count toward the street bet: pure dead money.
                replay.bank(player, amount);
                out.push(format!(
                    "{player}: posts the ante {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P5Kind::SmallBlind => {
                if replay.small_poster.is_none() {
                    replay.small_poster = Some(player.to_owned());
                }
                betting.put(&mut replay, player, amount, dead);
                out.push(format!(
                    "{player}: posts small blind {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P5Kind::BigBlind => {
                if replay.big_poster.is_none() {
                    replay.big_poster = Some(player.to_owned());
                }
                // No "+ dead" form in standard text: re-emitted first, as a
                // missed blind.
                if dead.greater_than(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: posts missed blind {}",
                        money(dead, unit, decimals)
                    ));
                }
                betting.put(&mut replay, player, amount, dead);
                out.push(format!(
                    "{player}: posts big blind {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P5Kind::Post | P5Kind::Straddle => {
                if dead.greater_than(JsNumber::ZERO) {
                    replay.pre_deal.push(format!(
                        "{player}: posts missed blind {}",
                        money(dead, unit, decimals)
                    ));
                }
                betting.put(&mut replay, player, amount, dead);
                // A post can be pure dead money with nothing live in it.
                if amount.greater_than(JsNumber::ZERO) || dead.strict_equals(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: posts {}{all_in}",
                        money(amount, unit, decimals)
                    ));
                }
            }
            P5Kind::Fold => {
                if let Some(entry) = replay.folded.iter_mut().find(|(p, _)| p == player) {
                    entry.1 = street;
                } else {
                    replay.folded.push((player.to_owned(), street));
                }
                out.push(format!("{player}: folds"));
            }
            P5Kind::Check => out.push(format!("{player}: checks")),
            P5Kind::Call => {
                replay.add_voluntary(player);
                betting.put(&mut replay, player, amount, dead);
                out.push(format!(
                    "{player}: calls {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P5Kind::Bet => {
                replay.add_voluntary(player);
                betting.put(&mut replay, player, amount, dead);
                out.push(format!(
                    "{player}: bets {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P5Kind::Raise | P5Kind::Allin => {
                // One token for an opening bet, a call and a raise alike.
                replay.add_voluntary(player);
                let over = betting.bet;
                let to = betting.put(&mut replay, player, amount, dead);
                let flag = if action.kind == P5Kind::Allin && !action.all_in {
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
            P5Kind::Uncalled => {
                // The source states the return, so it is replayed, not derived.
                let returned = action.amount.unwrap_or(JsNumber::ZERO);
                set(&mut betting.commit, player, already - returned);
                replay.bank(player, -returned);
                out.push(format!(
                    "Uncalled bet ({}) returned to {player}",
                    money(returned, unit, decimals)
                ));
            }
            P5Kind::Show | P5Kind::Muck => {}
        }
        if to_pre_deal {
            replay.pre_deal.append(&mut out);
        } else {
            replay.lines[street.index()].append(&mut out);
        }
    }
    replay
}

/* ------------------------------------------------------------------ summary */

/// `positionLabelsFor(seat, buttonSeat, blinds)`.
fn position_labels_for(
    seat: &P5Seat,
    button_seat: Option<JsNumber>,
    replay: &Replay,
) -> Vec<&'static str> {
    let mut labels = Vec::new();
    if button_seat.is_some_and(|button| seat.seat.strict_equals(button)) {
        labels.push("(button)");
    }
    if replay.small_poster.as_deref() == Some(seat.name.as_str()) {
        labels.push("(small blind)");
    }
    if replay.big_poster.as_deref() == Some(seat.name.as_str()) {
        labels.push("(big blind)");
    }
    labels
}

/// `p5HeaderDate(iso)`: `2014-01-06T22:40:28.000Z` -> `2014/01/06 22:40:28`
/// (the same function as `p2-handbuilder.ts`'s `formatHeaderDate`).
pub fn p5_header_date(iso: &str) -> String {
    format_header_date(iso)
}

/* -------------------------------------------------------------------- build */

/// `p5DraftToStandardText(draft)`: the draft as standard text; the refusal
/// when the replay disagrees with what the room stated.
#[allow(clippy::too_many_lines)]
pub fn p5_draft_to_standard_text(draft: &P5Draft) -> Result<String, ParseSkip> {
    let (unit, decimals) = (&draft.unit, draft.decimals);
    let replay = replay_actions(draft);
    let mut seats: Vec<&P5Seat> = draft.seats.iter().filter(|seat| seat.dealt_in).collect();
    // `sort((a, b) => a.seat - b.seat)`, as V8 sorts.
    js::sort::sort_by(&mut seats, |a, b| a.seat - b.seat);

    let total_pot = draft.stated_pot.unwrap_or(replay.gross);
    if let Some(stated) = draft.stated_pot
        && off_by_more_than_tolerance(replay.gross, stated)
    {
        return Err(ParseSkip::new(
            SkipReason::ChipMismatch,
            format!(
                "The action stream puts {} in the pot but the hand reports {}; one of the two \
                 readings is wrong.",
                replay.gross.to_js_string(),
                stated.to_js_string()
            ),
        ));
    }
    let paid_out = draft
        .collected
        .iter()
        .fold(JsNumber::ZERO, |sum, entry| sum + entry.amount);
    if paid_out.strict_equals(JsNumber::ZERO) && total_pot.greater_than(tolerance()) {
        // A walk handed straight back leaves a zero pot and no winner; chips
        // in the middle and nobody to take them is a truncated hand.
        return Err(ParseSkip::new(
            SkipReason::NoWinner,
            format!(
                "The hand puts {} in the pot but never says who collected it.",
                total_pot.to_js_string()
            ),
        ));
    }
    let shortfall = total_pot - paid_out;
    if shortfall.less_than(-tolerance()) {
        return Err(ParseSkip::new(
            SkipReason::InconsistentPot,
            format!(
                "Winners collected {} out of a pot of {}, which leaves a negative rake of {}.",
                paid_out.to_js_string(),
                total_pot.to_js_string(),
                shortfall.to_js_string()
            ),
        ));
    }
    // Beyond the stated rake the pot lost an unitemized jackpot drop.
    let rake = draft
        .stated_rake
        .map_or(shortfall, |stated| stated.min_of(shortfall));
    let jackpot = JsNumber::ZERO.max_of(shortfall - rake);

    if let Some(stated_contributions) = &draft.stated_contributions {
        for (player, stated) in stated_contributions {
            let actual = get_or_zero(&replay.contributed, player);
            if off_by_more_than_tolerance(actual, *stated) {
                return Err(ParseSkip::new(
                    SkipReason::ContributionMismatch,
                    format!(
                        "{player} is reported to have put in {} but the action stream replays \
                         to {}.",
                        stated.to_js_string(),
                        actual.to_js_string()
                    ),
                ));
            }
        }
    }

    let stakes = format!(
        "{}/{}",
        money(draft.small_blind, unit, decimals),
        money(draft.big_blind, unit, decimals)
    );
    let date = match draft.played_at.as_deref() {
        Some(iso) if !iso.is_empty() => p5_header_date(iso),
        _ => String::new(),
    };

    let mut lines: Vec<String> = Vec::new();
    if let Some(tournament) = &draft.tournament {
        let name = tournament
            .name
            .as_deref()
            .filter(|name| !name.is_empty())
            .map_or(String::new(), |name| format!("({name}) "));
        lines.push(format!(
            "Poker Hand #{}: Tournament {name}#{}, {} {} - Level {} ({stakes}) - {date}",
            draft.hand_id,
            tournament.id,
            tournament.buy_in_token,
            draft.game_label,
            tournament.level_label
        ));
    } else {
        lines.push(format!(
            "Poker Hand #{}: {} ({stakes}) - {date}",
            draft.hand_id, draft.game_label
        ));
    }
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

    lines.extend(replay.pre_deal.iter().cloned());

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
    lines.extend(replay.lines[0].iter().cloned());

    let turn = draft.turn.as_deref().filter(|card| !card.is_empty());
    let river = draft.river.as_deref().filter(|card| !card.is_empty());
    let mut board: Vec<String> = draft.flop.clone().unwrap_or_default();
    board.extend(turn.map(str::to_owned));
    board.extend(river.map(str::to_owned));
    let emit_street = |lines: &mut Vec<String>, street: P5Street, marker: String| {
        lines.push(marker);
        lines.extend(replay.lines[street.index()].iter().cloned());
    };
    if let Some(flop) = &draft.flop {
        emit_street(
            &mut lines,
            P5Street::Flop,
            format!("*** FLOP *** [{}]", flop.join(" ")),
        );
    }
    if let Some(turn) = turn {
        let before = &board[..board.len().min(3)];
        emit_street(
            &mut lines,
            P5Street::Turn,
            format!("*** TURN *** [{}] [{turn}]", before.join(" ")),
        );
    }
    if let Some(river) = river {
        let before = &board[..board.len().min(4)];
        emit_street(
            &mut lines,
            P5Street::River,
            format!("*** RIVER *** [{}] [{river}]", before.join(" ")),
        );
    }

    lines.push("*** SHOWDOWN ***".to_owned());
    let description_of = |reveal: &Reveal| {
        reveal
            .description
            .as_deref()
            .filter(|description| !description.is_empty())
            .map(str::to_owned)
    };
    for show in &replay.shows {
        lines.push(format!(
            "{}: shows [{}]{}",
            show.player,
            show.cards.join(" "),
            description_of(show).map_or(String::new(), |d| format!(" ({d})"))
        ));
    }
    for muck in &replay.mucks {
        lines.push(format!("{}: doesn't show hand", muck.player));
    }
    for entry in &draft.collected {
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
        "Total pot {} | Rake {} | Jackpot {} | Bingo {zero} | Fortune {zero} | Tax {zero}",
        money(total_pot, unit, decimals),
        money(JsNumber::ZERO.max_of(rake), unit, decimals),
        money(jackpot, unit, decimals)
    ));
    if !board.is_empty() {
        lines.push(format!("Board [{}]", board.join(" ")));
    }

    let mut won_by: HashMap<&str, JsNumber> = HashMap::new();
    for entry in &draft.collected {
        let total = won_by
            .entry(entry.player.as_str())
            .or_insert(JsNumber::ZERO);
        *total = *total + entry.amount;
    }
    // `new Map(shows.map(...))`: the last reveal of a player wins.
    let last_of = |reveals: &'_ [Reveal], name: &str| -> Option<usize> {
        reveals.iter().rposition(|reveal| reveal.player == name)
    };

    for seat in &seats {
        let labels = position_labels_for(seat, draft.button_seat, &replay);
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
        // Only cards the source actually turned over.
        let revealed: &[String] = shown.or(mucked).map_or(&[], |reveal| &reveal.cards);

        if let Some(street) = folded {
            let place = if street == P5Street::Preflop {
                "folded before Flop".to_owned()
            } else {
                format!("folded on the {}", street.capitalized())
            };
            // "(didn't bet)": no voluntary chip; a blind is not voluntary.
            let voluntary = replay.voluntary.contains(&seat.name);
            let cards = if revealed.is_empty() {
                String::new()
            } else {
                format!(", mucked [{}]", revealed.join(" "))
            };
            lines.push(format!(
                "{head} {place}{}{cards}",
                if voluntary { "" } else { " (didn't bet)" }
            ));
            continue;
        }
        let with =
            |show: &Reveal| description_of(show).map_or(String::new(), |d| format!(" with {d}"));
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
        if won.greater_than(JsNumber::ZERO) {
            lines.push(format!("{head} collected ({})", money(won, unit, decimals)));
            continue;
        }
        if !revealed.is_empty() {
            lines.push(format!("{head} mucked [{}]", revealed.join(" ")));
            continue;
        }
        lines.push(format!("{head} mucked"));
    }

    Ok(lines.join("\n"))
}

/// `p5BuildHand(draft, ctx, handKey)`: draft in, PHF out. `meta.rawText` is
/// the site's own text, `meta.handKey` the caller's key; hole cards the
/// source revealed outside the deal fill players the text left without.
pub fn p5_build_hand(
    draft: &P5Draft,
    ctx: &SiteParserContext<'_>,
    hand_key: &str,
) -> Result<PhfHand, ParseError> {
    if draft.seats.iter().filter(|seat| seat.dealt_in).count() < 2 {
        return Err(ParseSkip::new(
            SkipReason::TooFewPlayers,
            "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
        )
        .into());
    }

    let text = p5_draft_to_standard_text(draft)?;
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

    // Cards the source revealed outside the deal block, e.g. in its summary.
    for player in &mut hand.players {
        let cards = draft
            .hole_cards
            .iter()
            .find(|(name, _)| *name == player.name)
            .map(|(_, cards)| cards);
        if let Some(cards) = cards
            && !cards.is_empty()
            && player.hole_cards.is_empty()
        {
            player.hole_cards.clone_from(cards);
        }
    }

    hand.meta.raw_text.clone_from(&draft.raw_text);
    let mut warnings = draft.warnings.clone();
    warnings.append(&mut hand.meta.warnings);
    hand.meta.warnings = warnings;
    hand_key.clone_into(&mut hand.meta.hand_key);
    Ok(hand)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phf::money::{CHIPS, USD};

    const SOURCE: &str =
        include_str!("../../../../../frontend/src/lib/parsers/shared/p5-handdraft.ts");

    #[test]
    fn literals_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            "const TOLERANCE: Amount = 1;",
            r#"export const P5_STREETS: P5Street[] = ["preflop", "flop", "turn", "river"];"#,
            r#"const allIn = action.allIn ? " and is all-in" : "";"#,
            "out.push(`${action.player}: posts the ante ${money(amount, unit, decimals)}${allIn}`);",
            "out.push(`${action.player}: posts small blind ${money(amount, unit, decimals)}${allIn}`);",
            "out.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);",
            "out.push(`${action.player}: posts big blind ${money(amount, unit, decimals)}${allIn}`);",
            "preDeal.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);",
            "if (amount > 0 || dead === 0) {",
            "out.push(`${action.player}: posts ${money(amount, unit, decimals)}${allIn}`);",
            "out.push(`${action.player}: folds`);",
            "out.push(`${action.player}: checks`);",
            "out.push(`${action.player}: calls ${money(amount, unit, decimals)}${allIn}`);",
            "out.push(`${action.player}: bets ${money(amount, unit, decimals)}${allIn}`);",
            r#"const flag = action.kind === "allin" && !action.allIn ? " and is all-in" : allIn;"#,
            "out.push(`${action.player}: calls ${money(amount, unit, decimals)}${flag}`);",
            "`${action.player}: raises ${money(to - over, unit, decimals)} to ` +",
            "`${money(to, unit, decimals)}${flag}`,",
            "out.push(`${action.player}: bets ${money(amount, unit, decimals)}${flag}`);",
            "`Uncalled bet (${money(returned, unit, decimals)}) returned to ${action.player}`,",
            "`The action stream puts ${replay.gross} in the pot but the hand reports ` +",
            "`${draft.statedPot}; one of the two readings is wrong.`,",
            "`The hand puts ${totalPot} in the pot but never says who collected it.`,",
            "`Winners collected ${paidOut} out of a pot of ${totalPot}, which leaves a ` +",
            "`negative rake of ${shortfall}.`,",
            "const rake = draft.statedRake === null ? shortfall : Math.min(draft.statedRake, shortfall);",
            "const jackpot = Math.max(0, shortfall - rake);",
            "`${player} is reported to have put in ${stated} but the action stream ` +",
            "`replays to ${actual}.`,",
            r#"const name = draft.tournament.name ? `(${draft.tournament.name}) ` : "";"#,
            "`Poker Hand #${draft.handId}: Tournament ${name}#${draft.tournament.id}, ` +",
            "`${draft.tournament.buyInToken} ${draft.gameLabel} - ` +",
            "`Level ${draft.tournament.levelLabel} (${stakes}) - ${date}`,",
            "lines.push(`Poker Hand #${draft.handId}: ${draft.gameLabel} (${stakes}) - ${date}`);",
            "`Table '${draft.tableName ?? \"\"}' ${draft.maxSeats}-max` +",
            "(draft.buttonSeat === null ? \"\" : ` Seat #${draft.buttonSeat} is the button`),",
            "`Seat ${seat.seat}: ${seat.name} (${money(seat.startingStack, unit, decimals)} in chips)`,",
            "lines.push(`Dealt to ${seat.name} [${seat.dealtCards.join(\" \")}]`);",
            "emitStreet(\"flop\", `*** FLOP *** [${draft.flop.join(\" \")}]`);",
            "emitStreet(\"turn\", `*** TURN *** [${board.slice(0, 3).join(\" \")}] [${draft.turn}]`);",
            "emitStreet(\"river\", `*** RIVER *** [${board.slice(0, 4).join(\" \")}] [${draft.river}]`);",
            r#"lines.push("*** SHOWDOWN ***");"#,
            "`${show.player}: shows [${show.cards.join(\" \")}]` +",
            "(show.description ? ` (${show.description})` : \"\"),",
            "lines.push(`${muck.player}: doesn't show hand`);",
            "`${entry.player} collected ${money(entry.amount, unit, decimals)} from ${entry.potName ?? \"pot\"}`,",
            "`Total pot ${money(totalPot, unit, decimals)} | Rake ${money(Math.max(0, rake), unit, decimals)} | ` +",
            "`Jackpot ${money(jackpot, unit, decimals)} | Bingo ${zero} | Fortune ${zero} | Tax ${zero}`,",
            "lines.push(`Board [${board.join(\" \")}]`);",
            r#"? "folded before Flop""#,
            ": `folded on the ${capitalize(foldedStreet)}`;",
            "const revealed = revealedCards.length > 0 ? `, mucked [${revealedCards.join(\" \")}]` : \"\";",
            "lines.push(`${head} ${where}${voluntary ? \"\" : \" (didn't bet)\"}${revealed}`);",
            "`${head} showed [${shown.cards.join(\" \")}] and won (${money(won, unit, decimals)})` +",
            "(shown.description ? ` with ${shown.description}` : \"\"),",
            "`${head} showed [${shown.cards.join(\" \")}] and lost` +",
            "lines.push(`${head} collected (${money(won, unit, decimals)})`);",
            "lines.push(`${head} mucked [${revealedCards.join(\" \")}]`);",
            "lines.push(`${head} mucked`);",
            r#""Fewer than two seats were dealt in, so the hand cannot be reconstructed.","#,
            r#""The normalized text was not readable as a standard-format hand.","#,
            "if (cards && cards.length > 0 && player.holeCards.length === 0) {",
            "hand.meta.warnings = [...draft.warnings, ...hand.meta.warnings];",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    fn seat(seat: u64, name: &str, stack: u64) -> P5Seat {
        P5Seat {
            seat: JsNumber::from_u64(seat),
            name: name.to_owned(),
            starting_stack: JsNumber::from_u64(stack),
            is_hero: false,
            dealt_in: true,
            dealt_cards: Vec::new(),
        }
    }

    fn amount(street: P5Street, player: &str, kind: P5Kind, value: u64) -> P5Action {
        let mut action = P5Action::new(street, player, kind);
        action.amount = Some(JsNumber::from_u64(value));
        action
    }

    fn draft() -> P5Draft {
        P5Draft {
            site_id: "acrwpn".to_owned(),
            site_name: "ACR / Winning Poker Network".to_owned(),
            parser_id: "acrwpn".to_owned(),
            parser_version: "1.1.0".to_owned(),
            hand_id: "123".to_owned(),
            game_label: "Hold'em No Limit".to_owned(),
            unit: USD.unit(),
            decimals: DecimalStyle::Fixed2,
            small_blind: JsNumber::from_u64(10),
            big_blind: JsNumber::from_u64(25),
            table_name: Some("T".to_owned()),
            max_seats: JsNumber::from_u64(6),
            button_seat: Some(JsNumber::from_u64(1)),
            played_at: Some("2014-03-09T19:37:22.000Z".to_owned()),
            tournament: None,
            seats: vec![seat(1, "alice", 1000), seat(2, "bob", 1000)],
            actions: vec![
                amount(P5Street::Preflop, "alice", P5Kind::SmallBlind, 10),
                amount(P5Street::Preflop, "bob", P5Kind::BigBlind, 25),
                amount(P5Street::Preflop, "alice", P5Kind::Raise, 40),
                amount(P5Street::Preflop, "bob", P5Kind::Fold, 0),
                amount(P5Street::Preflop, "alice", P5Kind::Uncalled, 25),
            ],
            flop: None,
            turn: None,
            river: None,
            collected: vec![P5Collect {
                player: "alice".to_owned(),
                amount: JsNumber::from_u64(50),
                pot_name: None,
            }],
            stated_pot: None,
            stated_rake: Some(JsNumber::ZERO),
            stated_contributions: Some(vec![
                ("alice".to_owned(), JsNumber::from_u64(25)),
                ("bob".to_owned(), JsNumber::from_u64(25)),
            ]),
            hole_cards: Vec::new(),
            raw_text: "raw".to_owned(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn an_increment_raise_and_its_stated_return_write_the_text() {
        let text = p5_draft_to_standard_text(&draft()).expect("text");
        assert_eq!(
            text,
            "Poker Hand #123: Hold'em No Limit ($0.10/$0.25) - 2014/03/09 19:37:22\n\
             Table 'T' 6-max Seat #1 is the button\n\
             Seat 1: alice ($10 in chips)\n\
             Seat 2: bob ($10 in chips)\n\
             alice: posts small blind $0.10\n\
             bob: posts big blind $0.25\n\
             *** HOLE CARDS ***\n\
             alice: raises $0.25 to $0.50\n\
             bob: folds\n\
             Uncalled bet ($0.25) returned to alice\n\
             *** SHOWDOWN ***\n\
             alice collected $0.50 from pot\n\
             *** SUMMARY ***\n\
             Total pot $0.50 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0\n\
             Seat 1: alice (button) (small blind) collected ($0.50)\n\
             Seat 2: bob (big blind) folded before Flop (didn't bet)"
        );
    }

    #[test]
    fn every_check_refuses_with_the_typescript_message() {
        let mut pot = draft();
        pot.stated_pot = Some(JsNumber::from_u64(60));
        let skip = p5_draft_to_standard_text(&pot).expect_err("pot");
        assert_eq!(skip.reason, SkipReason::ChipMismatch);
        assert_eq!(
            skip.message,
            "The action stream puts 50 in the pot but the hand reports 60; one of the two \
             readings is wrong."
        );

        let mut nobody = draft();
        nobody.collected.clear();
        let skip = p5_draft_to_standard_text(&nobody).expect_err("no winner");
        assert_eq!(skip.reason, SkipReason::NoWinner);
        assert_eq!(
            skip.message,
            "The hand puts 50 in the pot but never says who collected it."
        );

        let mut over = draft();
        over.collected[0].amount = JsNumber::from_u64(52);
        let skip = p5_draft_to_standard_text(&over).expect_err("over");
        assert_eq!(skip.reason, SkipReason::InconsistentPot);
        assert_eq!(
            skip.message,
            "Winners collected 52 out of a pot of 50, which leaves a negative rake of -2."
        );

        let mut column = draft();
        column.stated_contributions = Some(vec![("bob".to_owned(), JsNumber::from_u64(30))]);
        let skip = p5_draft_to_standard_text(&column).expect_err("column");
        assert_eq!(skip.reason, SkipReason::ContributionMismatch);
        assert_eq!(
            skip.message,
            "bob is reported to have put in 30 but the action stream replays to 25."
        );
    }

    #[test]
    fn a_shortfall_above_the_stated_rake_is_a_jackpot_and_dead_money_a_missed_blind() {
        let mut jackpot = draft();
        jackpot.collected[0].amount = JsNumber::from_u64(40);
        jackpot.stated_rake = Some(JsNumber::from_u64(3));
        let text = p5_draft_to_standard_text(&jackpot).expect("text");
        assert!(text.contains("Total pot $0.50 | Rake $0.03 | Jackpot $0.07 |"));

        let mut dead = draft();
        dead.unit = CHIPS.unit();
        let mut post = amount(P5Street::Preflop, "bob", P5Kind::Post, 0);
        post.dead = Some(JsNumber::from_u64(5));
        dead.actions.insert(2, post);
        dead.stated_contributions = None;
        dead.collected[0].amount = JsNumber::from_u64(55);
        dead.tournament = Some(P5Tournament {
            id: "unknown".to_owned(),
            name: Some("Turbo".to_owned()),
            buy_in_token: "$0".to_owned(),
            level_label: "1".to_owned(),
        });
        let text = p5_draft_to_standard_text(&dead).expect("text");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            "Poker Hand #123: Tournament (Turbo) #unknown, $0 Hold'em No Limit - Level 1 \
             (10/25) - 2014/03/09 19:37:22"
        );
        assert_eq!(lines[6], "bob: posts missed blind 5");
        assert_eq!(lines[7], "*** HOLE CARDS ***");
    }

    #[test]
    fn build_refuses_too_few_players_and_fills_summary_hole_cards() {
        let options = crate::detect::ConvertOptions::default();
        let ctx = SiteParserContext {
            source_filename: None,
            options: &options,
        };
        let mut lonely = draft();
        lonely.seats[1].dealt_in = false;
        let Err(ParseError::Skip(skip)) = p5_build_hand(&lonely, &ctx, "WPN123") else {
            panic!("expected a refusal");
        };
        assert_eq!(skip.reason, SkipReason::TooFewPlayers);
        let mut known = draft();
        known.hole_cards = vec![("bob".to_owned(), vec!["Ah".to_owned(), "Kd".to_owned()])];
        let hand = p5_build_hand(&known, &ctx, "WPN123").expect("hand");
        assert_eq!(hand.meta.raw_text, "raw");
        assert_eq!(hand.meta.hand_key, "WPN123");
        let bob = hand.players.iter().find(|p| p.name == "bob").expect("bob");
        assert_eq!(bob.hole_cards, ["Ah", "Kd"]);
    }
}

//! High-low split: which collect paid which half of the pot
//! (`frontend/src/lib/phf/hilo.ts`).
//!
//! PokerStars' text - the format this project writes - does not say which
//! half a collect paid, so the halves are a fact the text *implies*: at a
//! showdown the cards are on the table, and the high hand and the
//! eight-or-better low among the players who were paid say who was paid for
//! what. [`assign_hi_lo_halves`] computes that once, for every builder, and
//! [`hi_lo_payout_contradictions`] is the validator's check that a main pot
//! did not skip a better shown hand. The `check_*` functions compare what a
//! room printed with the evaluation; [`order_hi_lo_awards`] puts a builder's
//! awards in the order the halves are read in.
//!
//! **Only the players who were paid are evaluated**, per pot: a side pot's
//! high is always the best hand among its own winners, so comparing winners
//! with winners needs no reconstruction of who was eligible for what.
//!
//! The TypeScript evaluator throws on a card it cannot read; here that is the
//! `Err` of [`assign_hi_lo_halves`] and [`hi_lo_payout_contradictions`],
//! carrying the same message (`not a card: …`). Sums of amounts are
//! JavaScript number sums ([`JsNumber`]), as there.

use std::sync::LazyLock;

use regex::Regex;

use super::{ActionType, Amount, PhfAction, PhfHand, PhfWarning, PotHalf, hole_card_count};
use crate::eval::STANDARD;
use crate::eval::omaha::{evaluate_omaha, evaluate_omaha_low};
use crate::js::{JsError, JsNumber};
use crate::phf::resolve_runout;

static LEADING_THE: LazyLock<Regex> = crate::js_regex_lazy!(r"^the\s+", "");
static POT_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"\bpots?\b", "g");
static SEPARATORS: LazyLock<Regex> = crate::js_regex_lazy!(r"[\s-]+", "g");

/// `hiLoPotKey(name)`: the comparison key of a pot name - `main pot`, `Main`
/// and `the main pot` agree, as do `side pot-1` and `side pot 1`.
pub fn hi_lo_pot_key(name: Option<&str>) -> String {
    let lower = crate::js::to_lower_case(name.unwrap_or(""));
    let without_the = LEADING_THE.replace(&lower, "");
    let without_pot = POT_WORD.replace_all(&without_the, "");
    let spaced = SEPARATORS.replace_all(&without_pot, " ");
    crate::js::trim(&spaced).to_owned()
}

/// `PotGroup`: the collects of one pot on one runout, in stream order, as
/// indices into `hand.actions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PotGroup {
    pub runout_index: u32,
    pub key: String,
    pub collects: Vec<usize>,
}

/// `hiLoPotGroups(hand)`: the hand's collects grouped by runout and pot key,
/// groups in order of first appearance.
pub fn hi_lo_pot_groups(hand: &PhfHand) -> Vec<PotGroup> {
    let mut groups: Vec<PotGroup> = Vec::new();
    for (i, action) in hand.actions.iter().enumerate() {
        if action.kind != ActionType::Collect {
            continue;
        }
        let key = hi_lo_pot_key(action.pot_name.as_deref());
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.runout_index == action.runout_index && group.key == key)
        {
            group.collects.push(i);
        } else {
            groups.push(PotGroup {
                runout_index: action.runout_index,
                key,
                collects: vec![i],
            });
        }
    }
    groups
}

/// `group.key || "pot"`.
fn label(key: &str) -> &str {
    if key.is_empty() { "pot" } else { key }
}

/// `resolveRunout(hand.board, runoutIndex)`.
fn board_of(hand: &PhfHand, runout_index: u32) -> Vec<String> {
    resolve_runout(
        &hand.board,
        usize::try_from(runout_index).unwrap_or(usize::MAX),
    )
}

/// Distinct values in first-appearance order (`[...new Set(list)]`).
fn distinct<'a>(names: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for name in names {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// One pot's labels for [`assign_hi_lo_halves`], as `(action index, half)`
/// in the order the TypeScript assigns them.
fn group_halves(
    hand: &PhfHand,
    group: &PotGroup,
    unresolved: &mut dyn FnMut(String),
) -> Result<Vec<(usize, PotHalf)>, JsError> {
    let dealt = hole_card_count(hand.game.variant);
    let label = label(&group.key);
    let board = board_of(hand, group.runout_index);
    let collectors = distinct(
        group
            .collects
            .iter()
            .map(|i| hand.actions[*i].player.as_str()),
    );
    let cards_of = |name: &str| -> Option<&[String]> {
        let player = hand.players.iter().find(|entry| entry.name == name)?;
        let dealt = usize::try_from(dealt?).ok()?;
        (player.hole_cards.len() == dealt).then_some(player.hole_cards.as_slice())
    };
    let known: Vec<(&str, Option<&[String]>)> = collectors
        .iter()
        .map(|name| (*name, cards_of(name)))
        .collect();

    let mut halves: Vec<(usize, PotHalf)> = Vec::new();
    if board.len() < 5 || known.iter().any(|(_, cards)| cards.is_none()) {
        // A hand or the board is not known. With one player paid that is a
        // scoop or a pot that went high, and absent already means "not known
        // to be split"; with several, the split itself is lost.
        if collectors.len() > 1 {
            unresolved(format!(
                "The {label} was paid to {}, but {}, so which half each was paid cannot be told.",
                collectors.join(", "),
                if board.len() < 5 {
                    "the board was not dealt out"
                } else {
                    "not every one of them showed a full hand"
                },
            ));
        }
        return Ok(halves);
    }

    let mut hi: Vec<(&str, u32)> = Vec::new();
    let mut lo: Vec<(&str, Option<u32>)> = Vec::new();
    for (name, cards) in &known {
        let cards = cards.unwrap_or_default();
        hi.push((name, evaluate_omaha(cards, &board, &STANDARD)?));
        lo.push((name, evaluate_omaha_low(cards, &board)?));
    }
    let best_hi = hi.iter().map(|(_, value)| *value).max().unwrap_or(0);
    let Some(best_lo) = lo.iter().filter_map(|(_, value)| *value).min() else {
        halves.extend(group.collects.iter().map(|i| (*i, PotHalf::Hi)));
        return Ok(halves);
    };

    for name in &collectors {
        let lines: Vec<usize> = group
            .collects
            .iter()
            .copied()
            .filter(|i| hand.actions[*i].player == *name)
            .collect();
        let won_hi = hi.iter().any(|(n, value)| n == name && *value == best_hi);
        let won_lo = lo
            .iter()
            .any(|(n, value)| n == name && *value == Some(best_lo));
        if won_hi && !won_lo {
            halves.extend(lines.iter().map(|i| (*i, PotHalf::Hi)));
        } else if won_lo && !won_hi {
            halves.extend(lines.iter().map(|i| (*i, PotHalf::Lo)));
        } else if won_hi && won_lo && lines.len() == 2 {
            halves.push((lines[0], PotHalf::Hi));
            halves.push((lines[1], PotHalf::Lo));
        } else if won_hi && won_lo && lines.len() == 1 && collectors.len() == 1 {
            // A scoop on one line: both halves, so neither label.
        } else if won_hi || won_lo {
            unresolved(format!(
                "{name} won both halves of the {label} against other winners, on {} line(s), \
                 so the high and low shares cannot be separated.",
                lines.len()
            ));
        } else {
            unresolved(format!(
                "{name} was paid from the {label}, but holds neither its best high nor its \
                 best low."
            ));
        }
    }
    Ok(halves)
}

/// `assignHiLoHalves(hand)`: sets `half` on every collect of a hi/lo hand,
/// mirrors it onto `results.winners`, and returns what it could not settle
/// (`hi-lo-split-unresolved` warnings). A no-op for a hand that is not
/// hi/lo; idempotent.
///
/// Per pot and runout: nobody contested it → every half absent; no paid
/// player holds a qualifying low → every collect `hi`; otherwise best high
/// only → `hi`, best low only → `lo`, both on two lines → `hi` then `lo`,
/// both alone on one line → a scoop, absent. Anything else is left absent
/// and reported.
///
/// `Err` where the TypeScript throws (a paid player's card or a board card the
/// evaluator cannot read); the hand is then left part-way, as there.
pub fn assign_hi_lo_halves(hand: &mut PhfHand) -> Result<Vec<PhfWarning>, JsError> {
    if !hand.game.hi_lo {
        return Ok(Vec::new());
    }
    let mut warnings: Vec<PhfWarning> = Vec::new();
    let mut unresolved = |message: String| {
        warnings.push(PhfWarning {
            code: "hi-lo-split-unresolved".to_owned(),
            message,
            line: None,
        });
    };

    for action in &mut hand.actions {
        action.half = None;
    }

    let folded: Vec<&str> = hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Fold)
        .map(|action| action.player.as_str())
        .collect();
    let contenders = hand
        .players
        .iter()
        .filter(|player| {
            hand.actions
                .iter()
                .any(|action| action.player == player.name)
                && !folded.contains(&player.name.as_str())
        })
        .count();

    if contenders >= 2 {
        for group in hi_lo_pot_groups(hand) {
            // Each group's labels are written once its evaluations are done,
            // which is where the TypeScript writes them too: an error in a
            // later group leaves the earlier groups labelled, as a throw does.
            let halves = group_halves(hand, &group, &mut unresolved)?;
            for (i, half) in halves {
                hand.actions[i].half = Some(half);
            }
        }
    }

    // Winners are paired with collects by player, amount and runout - not by
    // position - the way the replayer pairs them.
    let collects: Vec<&PhfAction> = hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Collect)
        .collect();
    let mut claimed = vec![false; collects.len()];
    for winner in &mut hand.results.winners {
        winner.half = None;
        let found = collects.iter().enumerate().position(|(i, action)| {
            !claimed[i]
                && action.player == winner.player
                && action.amount == winner.amount
                && action.runout_index == winner.runout_index
        });
        if let Some(index) = found {
            claimed[index] = true;
            winner.half = collects[index].half;
        }
    }
    Ok(warnings)
}

/// `hiLoPayoutContradictions(hand)`: shown hands the main pot's payout
/// contradicts - a player who showed a better high than everyone the main
/// pot paid, or a qualifying low better than any low it paid, and got
/// nothing. Only `pot` / `main pot` groups are checked; a muck does not
/// count as showing. `Err` where the TypeScript throws.
pub fn hi_lo_payout_contradictions(hand: &PhfHand) -> Result<Vec<String>, JsError> {
    if !hand.game.hi_lo {
        return Ok(Vec::new());
    }
    let dealt = hole_card_count(hand.game.variant).and_then(|n| usize::try_from(n).ok());
    let full = |cards: &[String]| dealt.is_some_and(|dealt| cards.len() == dealt);
    let shown: Vec<&str> = hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Show)
        .map(|action| action.player.as_str())
        .collect();
    let showers: Vec<_> = hand
        .players
        .iter()
        .filter(|player| shown.contains(&player.name.as_str()) && full(&player.hole_cards))
        .collect();
    let mut problems = Vec::new();
    for group in hi_lo_pot_groups(hand) {
        if !group.key.is_empty() && group.key != "main" {
            continue;
        }
        let board = board_of(hand, group.runout_index);
        if board.len() < 5 || showers.is_empty() {
            continue;
        }
        let paid = distinct(
            group
                .collects
                .iter()
                .map(|i| hand.actions[*i].player.as_str()),
        );
        let known: Vec<_> = hand
            .players
            .iter()
            .filter(|player| paid.contains(&player.name.as_str()) && full(&player.hole_cards))
            .collect();
        if known.len() != paid.len() {
            continue;
        }

        let mut paid_hi: Option<u32> = None;
        for player in &known {
            let value = evaluate_omaha(&player.hole_cards, &board, &STANDARD)?;
            paid_hi = Some(paid_hi.map_or(value, |best| best.max(value)));
        }
        let mut paid_lo: Option<u32> = None;
        for player in &known {
            if let Some(low) = evaluate_omaha_low(&player.hole_cards, &board)? {
                paid_lo = Some(paid_lo.map_or(low, |best| best.min(low)));
            }
        }
        let label = label(&group.key);
        for player in &showers {
            if paid.contains(&player.name.as_str()) {
                continue;
            }
            // `known` is not empty (the group has a collect, and every payee
            // is known), so there is a paid high.
            let high = evaluate_omaha(&player.hole_cards, &board, &STANDARD)?;
            if paid_hi.is_some_and(|paid_hi| high > paid_hi) {
                problems.push(format!(
                    "{} showed a better high hand than anyone the {label} paid, and was paid \
                     nothing.",
                    player.name
                ));
            }
            let low = evaluate_omaha_low(&player.hole_cards, &board)?;
            if let Some(low) = low
                && paid_lo.is_none_or(|paid_lo| low < paid_lo)
            {
                problems.push(format!(
                    "{} showed a qualifying low better than any the {label} paid, and was paid \
                     nothing.",
                    player.name
                ));
            }
        }
    }
    Ok(problems)
}

/// `NO_LOW_LINE`: PokerStars' line for a hi/lo pot that went entirely high.
pub static NO_LOW_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^No low hand qualified\s*$", "i");

fn mismatch(message: String) -> PhfWarning {
    PhfWarning {
        code: "hi-lo-half-mismatch".to_owned(),
        message,
        line: None,
    }
}

/// `checkNoLowStated(hand)`: the check behind a room's `No low hand
/// qualified` - nothing may have been paid low.
pub fn check_no_low_stated(hand: &PhfHand) -> Vec<PhfWarning> {
    if hand
        .actions
        .iter()
        .any(|action| action.half == Some(PotHalf::Lo))
    {
        vec![mismatch(
            "The text says no low hand qualified, but a low half was paid.".to_owned(),
        )]
    } else {
        Vec::new()
    }
}

/// `StatedAward`: what a room printed about one award.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatedAward {
    pub player: String,
    pub amount: Amount,
    /// The half the room named, or `None` when it did not say.
    pub half: Option<PotHalf>,
}

fn collects(hand: &PhfHand) -> Vec<&PhfAction> {
    hand.actions
        .iter()
        .filter(|action| action.kind == ActionType::Collect)
        .collect()
}

/// `checkStatedHalves(hand, stated)`: compares the halves a room printed
/// (in the order the hand's collects were emitted) with the evaluated ones,
/// and warns on every labelled award that differs.
pub fn check_stated_halves(hand: &PhfHand, stated: &[StatedAward]) -> Vec<PhfWarning> {
    let collects = collects(hand);
    let mut claimed = vec![false; collects.len()];
    let mut warnings = Vec::new();
    for award in stated {
        let found = collects.iter().enumerate().position(|(i, action)| {
            !claimed[i] && action.player == award.player && action.amount == award.amount
        });
        let Some(index) = found else {
            continue;
        };
        claimed[index] = true;
        let Some(half) = award.half else {
            continue;
        };
        let evaluated = collects[index].half;
        if evaluated != Some(half) {
            warnings.push(mismatch(format!(
                "The room paid {} the {} half, but the hands say {}.",
                award.player,
                if half == PotHalf::Hi { "high" } else { "low" },
                match evaluated {
                    Some(PotHalf::Hi) => "the high half",
                    Some(PotHalf::Lo) => "the low half",
                    None => "an unsplit pot",
                },
            )));
        }
    }
    warnings
}

/// A seat's high and low winnings as a room states them (Bovada's `HI` /
/// `LOW`), for [`check_stated_totals`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatedTotals {
    pub hi: Amount,
    pub lo: Amount,
}

/// `checkStatedTotals(hand, stated)`: the same check for a room that states
/// each seat's high and low winnings as totals. `stated` is the TypeScript
/// `Map`, in its insertion order. A seat with an unlabelled award is not
/// checked when the room says it was paid low.
pub fn check_stated_totals(hand: &PhfHand, stated: &[(String, StatedTotals)]) -> Vec<PhfWarning> {
    let mut warnings = Vec::new();
    for (player, room) in stated {
        let collects: Vec<&PhfAction> = collects(hand)
            .into_iter()
            .filter(|action| action.player == *player)
            .collect();
        let unlabelled = collects.iter().any(|action| action.half.is_none());
        if unlabelled && room.lo > 0 {
            continue;
        }
        let sum = |keep: &dyn Fn(&PhfAction) -> bool| {
            collects
                .iter()
                .filter(|action| keep(action))
                .fold(JsNumber::ZERO, |total, action| {
                    total + JsNumber::from_i64(action.amount)
                })
        };
        let hi = sum(&|action| action.half != Some(PotHalf::Lo));
        let lo = sum(&|action| action.half == Some(PotHalf::Lo));
        let (room_hi, room_lo) = (JsNumber::from_i64(room.hi), JsNumber::from_i64(room.lo));
        if !hi.strict_equals(room_hi) || !lo.strict_equals(room_lo) {
            warnings.push(mismatch(format!(
                "The room paid {player} {} high and {} low, but the hands say {} high and {} low.",
                room_hi.to_js_string(),
                room_lo.to_js_string(),
                hi.to_js_string(),
                lo.to_js_string(),
            )));
        }
    }
    warnings
}

/// What [`order_hi_lo_awards`] reads from a draft award.
pub trait HiLoAward {
    fn half(&self) -> Option<PotHalf>;
    fn pot_name(&self) -> Option<&str>;
}

/// `orderHiLoAwards(awards)`: within each pot (pots in order of first
/// appearance), every high share before any low share; otherwise the room's
/// own order.
pub fn order_hi_lo_awards<T: HiLoAward>(awards: Vec<T>) -> Vec<T> {
    let mut pot_order: Vec<String> = Vec::new();
    for award in &awards {
        let key = hi_lo_pot_key(award.pot_name());
        if !pot_order.contains(&key) {
            pot_order.push(key);
        }
    }
    let mut keyed: Vec<(usize, u8, T)> = awards
        .into_iter()
        .map(|award| {
            let key = hi_lo_pot_key(award.pot_name());
            let pot = pot_order.iter().position(|k| *k == key).unwrap_or(0);
            let rank = u8::from(award.half() == Some(PotHalf::Lo));
            (pot, rank, award)
        })
        .collect();
    // Stable, so equal keys keep their index order - the TypeScript's last
    // tie-breaker.
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    keyed.into_iter().map(|(_, _, award)| award).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phf::test_support::{action, hand};

    #[test]
    fn pot_keys_agree_across_spellings() {
        assert_eq!(hi_lo_pot_key(Some("main pot")), "main");
        assert_eq!(hi_lo_pot_key(Some("Main")), "main");
        assert_eq!(hi_lo_pot_key(Some("the main pot")), "main");
        assert_eq!(hi_lo_pot_key(Some("side pot-1")), "side 1");
        assert_eq!(hi_lo_pot_key(Some("Side Pot 1")), "side 1");
        assert_eq!(hi_lo_pot_key(Some("pot")), "");
        assert_eq!(hi_lo_pot_key(None), "");
        assert_eq!(hi_lo_pot_key(Some("jackpots")), "jackpots");
        assert_eq!(hi_lo_pot_key(Some("THE  Pots - x")), "x");
    }

    #[test]
    fn the_no_low_line_is_pokerstars_line() {
        assert!(NO_LOW_LINE.is_match("No low hand qualified"));
        assert!(NO_LOW_LINE.is_match("no LOW hand qualified  "));
        assert!(!NO_LOW_LINE.is_match(" No low hand qualified"));
    }

    fn collect(index: u32, seat: u32, player: &str, amount: i64, pot: &str) -> PhfAction {
        let mut collect = action(index, seat, player, ActionType::Collect, amount);
        collect.pot_name = Some(pot.to_owned());
        collect
    }

    #[test]
    fn checks_what_the_room_stated_against_the_halves() {
        let mut subject = hand();
        subject.game.hi_lo = true;
        subject.actions = vec![
            collect(0, 1, "alpha", 50, "main pot"),
            collect(1, 2, "bravo", 50, "main pot"),
        ];
        subject.actions[0].half = Some(PotHalf::Hi);
        subject.actions[1].half = Some(PotHalf::Lo);
        let stated = |player: &str, half| StatedAward {
            player: player.to_owned(),
            amount: 50,
            half,
        };
        assert!(
            check_stated_halves(
                &subject,
                &[stated("alpha", Some(PotHalf::Hi)), stated("bravo", None)]
            )
            .is_empty()
        );
        let warnings = check_stated_halves(&subject, &[stated("bravo", Some(PotHalf::Hi))]);
        assert_eq!(
            warnings[0].message,
            "The room paid bravo the high half, but the hands say the low half."
        );
        assert_eq!(check_no_low_stated(&subject).len(), 1);

        let totals = |hi, lo| StatedTotals { hi, lo };
        assert!(check_stated_totals(&subject, &[("alpha".to_owned(), totals(50, 0))]).is_empty());
        assert_eq!(
            check_stated_totals(&subject, &[("bravo".to_owned(), totals(50, 0))])[0].message,
            "The room paid bravo 50 high and 0 low, but the hands say 0 high and 50 low."
        );
    }

    #[derive(Debug, PartialEq)]
    struct Draft(&'static str, Option<PotHalf>, Option<&'static str>);

    impl HiLoAward for Draft {
        fn half(&self) -> Option<PotHalf> {
            self.1
        }
        fn pot_name(&self) -> Option<&str> {
            self.2
        }
    }

    #[test]
    fn orders_awards_high_before_low_within_each_pot() {
        let ordered = order_hi_lo_awards(vec![
            Draft("a", Some(PotHalf::Lo), Some("Main pot")),
            Draft("b", Some(PotHalf::Lo), Some("side pot-1")),
            Draft("c", Some(PotHalf::Hi), Some("main")),
            Draft("d", None, Some("Side Pot 1")),
        ]);
        let names: Vec<&str> = ordered.iter().map(|d| d.0).collect();
        assert_eq!(names, ["c", "a", "d", "b"]);
    }
}

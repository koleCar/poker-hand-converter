//! What the filter builder reads of a hand beyond its counters (2026-11-05,
//! the owner's builder V1, schema 19): the hero's bet sizes, what the hero
//! made and drew to on each street, who was in the pot against the hero and
//! whether the hero had position, and the tournament's buy-in, bounty and
//! level. Derived from the PHF and the hand's statistics rows where the
//! list row is written (`batch::PreparedStats::from_phf`: the import, a
//! pull, a recompute), stored on `hand_list`, filtered in SQL.
//!
//! Nothing here is a statistic (guideline §14): these are a hand's facts -
//! a size, a hand category - the way the list's board and result are.

use rail_core::phf::{ActionType, PhfHand, Position, Street};
use rail_stats::Counter;

use crate::batch::PreparedSeat;

/// The builder's facts of one hand.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandExtras {
    /// The hero's first raise preflop when it opened the pot, in tenths of a
    /// big blind (the size raised to).
    pub open_tenths: Option<i64>,
    /// The hero's first bet or raise on the flop, turn and river, as a share
    /// of the pot (percent): a bet over the pot before it, a raise's increment
    /// over the pot after calling.
    pub bet_pct: [Option<i64>; 3],
    /// What the hero made on the flop, turn and river ([`Made`] codes).
    pub made: [Option<i64>; 3],
    /// A top pair's kicker on each street: 1 top, 2 good, 3 weak.
    pub kicker: [Option<i64>; 3],
    /// What the hero drew to on the flop and turn ([`DRAWS`] bits).
    pub draws: [i64; 2],
    /// Players who saw the flop, the hero among them.
    pub players_flop: i64,
    /// The hero saw the flop and acted last on it (`Some(true)`), or not.
    pub hero_ip: Option<bool>,
    /// The opponents in the pot (put money in, or saw the flop): their
    /// seats and positions, spaces around each (` 3 5 `, ` BB CO `).
    pub vs_seats: String,
    pub vs_positions: String,
    /// The tournament's buy-in in cents of its unit (prize pool, bounty and
    /// fee together), whether it had a bounty, its level.
    pub buy_in_cents: Option<i64>,
    pub bounty: bool,
    pub level: Option<i64>,
}

/// A hero's made hand, weakest first; stored as its index.
pub const MADE: &[&str] = &[
    "highCard",
    "underpair",
    "bottomPair",
    "middlePair",
    "topPair",
    "overpair",
    "twoPair",
    "trips",
    "set",
    "straight",
    "flush",
    "fullHouse",
];

/// What a hero draws to, as bits.
pub const DRAWS: &[&str] = &[
    "flushDraw",
    "nutFlushDraw",
    "oesd",
    "gutshot",
    "comboDraw",
    "backdoorFlush",
];

const RANKS: &str = "23456789TJQKA";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Card {
    /// 2 ... 14 (an ace is 14).
    rank: u8,
    suit: u8,
}

fn card(text: &str) -> Option<Card> {
    let mut chars = text.chars();
    let rank = chars.next()?;
    let suit = chars.next()?;
    let rank = u8::try_from(RANKS.find(rank.to_ascii_uppercase())?).ok()? + 2;
    let suit = match suit.to_ascii_lowercase() {
        's' => 0,
        'h' => 1,
        'd' => 2,
        'c' => 3,
        _ => return None,
    };
    Some(Card { rank, suit })
}

fn made_index(name: &str) -> i64 {
    MADE.iter()
        .position(|m| *m == name)
        .map_or(0, |i| i64::try_from(i).unwrap_or(0))
}

fn draw_bit(name: &str) -> i64 {
    DRAWS
        .iter()
        .position(|d| *d == name)
        .map_or(0, |i| 1i64 << i)
}

/// Ranks present (an ace also as 1), as a bit set over 1 ... 14.
fn rank_bits(cards: &[Card]) -> u16 {
    let mut bits = 0u16;
    for c in cards {
        bits |= 1 << c.rank;
        if c.rank == 14 {
            bits |= 1 << 1;
        }
    }
    bits
}

/// A straight in these ranks (five in a row, the wheel too).
fn has_straight(bits: u16) -> bool {
    (1..=10).any(|low| (0..5).all(|i| bits & (1 << (low + i)) != 0))
}

/// The ranks that would complete a straight with one more card.
fn straight_outs(bits: u16) -> Vec<u8> {
    let mut outs = Vec::new();
    for need in 1u8..=14 {
        if bits & (1 << need) != 0 {
            continue;
        }
        let with = bits
            | (1 << need)
            | if need == 14 { 1 << 1 } else { 0 }
            | if need == 1 { 1 << 14 } else { 0 };
        if has_straight(with) {
            let rank = if need == 1 { 14 } else { need };
            if !outs.contains(&rank) {
                outs.push(rank);
            }
        }
    }
    outs
}

/// The hero's made hand and top pair kicker on a board of three to five cards.
fn made_hand(hole: [Card; 2], board: &[Card]) -> (&'static str, Option<i64>) {
    let all: Vec<Card> = hole.iter().chain(board.iter()).copied().collect();
    let count = |rank: u8, cards: &[Card]| cards.iter().filter(|c| c.rank == rank).count();
    // Flush: five of a suit, one of the hero's among them.
    for suit in 0..4 {
        if all.iter().filter(|c| c.suit == suit).count() >= 5 && hole.iter().any(|c| c.suit == suit)
        {
            // A straight flush is in the strongest bucket.
            let suited: Vec<Card> = all.iter().filter(|c| c.suit == suit).copied().collect();
            if has_straight(rank_bits(&suited)) {
                return ("fullHouse", None);
            }
            // Full house or quads beat it; checked below only when no flush.
            let full = full_house(&all, &hole);
            return (if full { "fullHouse" } else { "flush" }, None);
        }
    }
    if full_house(&all, &hole) {
        return ("fullHouse", None);
    }
    // A straight the hero's cards help make.
    if has_straight(rank_bits(&all)) && !has_straight(rank_bits(board)) {
        return ("straight", None);
    }
    let pocket = hole[0].rank == hole[1].rank;
    if pocket && count(hole[0].rank, board) >= 1 {
        return ("set", None);
    }
    for h in hole {
        if count(h.rank, board) >= 2 {
            return ("trips", None);
        }
    }
    let paired: Vec<u8> = hole
        .iter()
        .filter(|h| count(h.rank, board) >= 1)
        .map(|h| h.rank)
        .collect();
    if paired.len() == 2 && hole[0].rank != hole[1].rank {
        return ("twoPair", None);
    }
    let mut board_ranks: Vec<u8> = board.iter().map(|c| c.rank).collect();
    board_ranks.sort_unstable_by(|a, b| b.cmp(a));
    board_ranks.dedup();
    let top = board_ranks.first().copied().unwrap_or(0);
    let bottom = board_ranks.last().copied().unwrap_or(0);
    if pocket {
        let r = hole[0].rank;
        if board
            .iter()
            .any(|c| board.iter().filter(|d| d.rank == c.rank).count() >= 2)
        {
            return ("twoPair", None);
        }
        return (
            if r > top {
                "overpair"
            } else if r < bottom {
                "underpair"
            } else {
                "middlePair"
            },
            None,
        );
    }
    if let Some(&rank) = paired.first() {
        if rank == top {
            let other = if hole[0].rank == rank {
                hole[1].rank
            } else {
                hole[0].rank
            };
            // The best kicker that could be: the highest rank not on the board.
            let mut better = (2..=14u8)
                .rev()
                .filter(|r| *r != top && !board_ranks.contains(r));
            let best = better.next().unwrap_or(0);
            let good: Vec<u8> = better.take(2).collect();
            let kicker = if other >= best {
                1
            } else if good.contains(&other) {
                2
            } else {
                3
            };
            return ("topPair", Some(kicker));
        }
        if rank == bottom {
            return ("bottomPair", None);
        }
        return ("middlePair", None);
    }
    ("highCard", None)
}

/// A full house or quads the hero's cards are part of.
fn full_house(all: &[Card], hole: &[Card; 2]) -> bool {
    let count = |rank: u8| all.iter().filter(|c| c.rank == rank).count();
    let mut ranks: Vec<u8> = all.iter().map(|c| c.rank).collect();
    ranks.sort_unstable();
    ranks.dedup();
    let quads = ranks
        .iter()
        .any(|&r| count(r) >= 4 && hole.iter().any(|h| h.rank == r));
    let trips: Vec<u8> = ranks.iter().copied().filter(|&r| count(r) >= 3).collect();
    let pairs: Vec<u8> = ranks.iter().copied().filter(|&r| count(r) >= 2).collect();
    let full = !trips.is_empty()
        && pairs.len() >= 2
        && hole
            .iter()
            .any(|h| trips.contains(&h.rank) || pairs.contains(&h.rank));
    quads || full
}

/// The hero's draws on a flop or turn: flush draws, straight draws, a
/// backdoor flush draw on the flop.
fn draws(hole: [Card; 2], board: &[Card], made: &str) -> i64 {
    let all: Vec<Card> = hole.iter().chain(board.iter()).copied().collect();
    let mut bits = 0;
    let mut flush_draw = false;
    if made != "flush" && made != "fullHouse" {
        for suit in 0..4 {
            let n = all.iter().filter(|c| c.suit == suit).count();
            let mine = hole.iter().filter(|c| c.suit == suit).count();
            if n == 4 && mine >= 1 {
                flush_draw = true;
                bits |= draw_bit("flushDraw");
                // The nut: the hero holds the highest card of the suit not on the board.
                let highest = (2..=14u8)
                    .rev()
                    .find(|r| !board.iter().any(|c| c.suit == suit && c.rank == *r));
                if hole
                    .iter()
                    .any(|c| c.suit == suit && Some(c.rank) == highest)
                {
                    bits |= draw_bit("nutFlushDraw");
                }
            }
            if board.len() == 3 && n == 3 && mine >= 1 && !flush_draw {
                bits |= draw_bit("backdoorFlush");
            }
        }
    }
    let mut straight_draw = false;
    if made != "straight" && made != "flush" && made != "fullHouse" {
        let with = straight_outs(rank_bits(&all));
        let without = straight_outs(rank_bits(board));
        let mine: Vec<u8> = with.into_iter().filter(|r| !without.contains(r)).collect();
        if mine.len() >= 2 {
            bits |= draw_bit("oesd");
            straight_draw = true;
        } else if mine.len() == 1 {
            bits |= draw_bit("gutshot");
            straight_draw = true;
        }
    }
    if flush_draw && straight_draw {
        bits |= draw_bit("comboDraw");
    }
    bits
}

/// Seats in the order they act after the flop (the small blind first).
fn postflop_order(position: Option<Position>) -> u8 {
    match position.map(Position::as_str) {
        Some("SB") => 1,
        Some("BB") => 2,
        Some("UTG") => 3,
        Some("UTG+1") => 4,
        Some("UTG+2") => 5,
        Some("MP") => 6,
        Some("LJ") => 7,
        Some("HJ") => 8,
        Some("CO") => 9,
        Some("BTN") => 10,
        _ => 0,
    }
}

/// Derive the builder's facts of `hand` from its PHF and its kept rows.
pub fn derive(hand: &PhfHand, rows: &[PreparedSeat]) -> HandExtras {
    let mut extras = HandExtras::default();
    let on = |seat: &PreparedSeat, counter: Counter| seat.values.counters[counter.index()] > 0;
    let hero = rows.iter().find(|seat| seat.row.seat.is_hero);
    let flop_seers: Vec<&PreparedSeat> = rows
        .iter()
        .filter(|seat| on(seat, Counter::flop_seen))
        .collect();
    extras.players_flop = i64::try_from(flop_seers.len()).unwrap_or(0);
    if let Some(hero) = hero {
        let mut seats = Vec::new();
        let mut positions = Vec::new();
        for seat in rows.iter().filter(|seat| !seat.row.seat.is_hero) {
            if on(seat, Counter::vpip) || on(seat, Counter::flop_seen) {
                seats.push(seat.row.seat.seat.to_string());
                if let Some(position) = seat.row.seat.position {
                    positions.push(position.as_str().to_owned());
                }
            }
        }
        if !seats.is_empty() {
            extras.vs_seats = format!(" {} ", seats.join(" "));
            extras.vs_positions = format!(" {} ", positions.join(" "));
        }
        if on(hero, Counter::flop_seen) {
            let mine = postflop_order(hero.row.seat.position);
            extras.hero_ip = Some(
                mine > 0
                    && flop_seers
                        .iter()
                        .filter(|seat| !seat.row.seat.is_hero)
                        .all(|seat| postflop_order(seat.row.seat.position) < mine),
            );
        }
        // Made hands and draws, street by street, where the hero's two cards are known.
        let hole: Vec<Card> = hero
            .row
            .seat
            .hole_cards
            .iter()
            .filter_map(|c| card(c))
            .collect();
        let board: Vec<Card> = rail_core::phf::hand::primary_board(hand)
            .iter()
            .filter_map(|c| card(c))
            .collect();
        if let [a, b] = hole[..] {
            for (street, n) in [(0usize, 3usize), (1, 4), (2, 5)] {
                if board.len() < n {
                    break;
                }
                let (made, kicker) = made_hand([a, b], &board[..n]);
                extras.made[street] = Some(made_index(made));
                extras.kicker[street] = kicker;
                if street < 2 {
                    extras.draws[street] = draws([a, b], &board[..n], made);
                }
            }
        }
        sizes(hand, hero.row.seat.seat, &mut extras);
    }
    if let Some(tournament) = &hand.tournament {
        let minor = i64::from(tournament.buy_in_unit.minor_units.max(1));
        let total = tournament.buy_in + tournament.bounty.unwrap_or(0) + tournament.fee;
        extras.buy_in_cents = Some(total * 100 / minor);
        extras.bounty = tournament.bounty.unwrap_or(0) > 0 || !tournament.bounties.is_empty();
        extras.level = tournament.level_number.map(i64::from);
    }
    extras
}

/// The hero's sizes: the open preflop, the first bet or raise on each later street.
fn sizes(hand: &PhfHand, hero_seat: u32, extras: &mut HandExtras) {
    let big_blind = hand.game.big_blind.max(1);
    let mut pot: i64 = 0;
    let mut street = Street::Preflop;
    let mut level: i64 = 0;
    let mut totals: std::collections::HashMap<u32, i64> = std::collections::HashMap::new();
    let mut raised_preflop = false;
    let mut done = [false; 4];
    for action in hand
        .actions
        .iter()
        .filter(|action| action.runout_index == 0)
    {
        if action.street != street {
            street = action.street;
            level = 0;
            totals.clear();
        }
        let seat = action.seat.unwrap_or(u32::MAX);
        let before = *totals.get(&seat).unwrap_or(&0);
        let index = match street {
            Street::Preflop => 0,
            Street::Flop => 1,
            Street::Turn => 2,
            Street::River => 3,
            _ => 4,
        };
        let voluntary = matches!(action.kind, ActionType::Bet | ActionType::Raise);
        if seat == hero_seat && voluntary && index < 4 && !done[index] {
            done[index] = true;
            if index == 0 {
                if !raised_preflop {
                    extras.open_tenths = Some(action.street_total * 10 / big_blind);
                }
            } else {
                let pct = if action.kind == ActionType::Bet || level == 0 {
                    (pot > 0).then(|| action.amount * 100 / pot)
                } else {
                    let call = (level - before).max(0);
                    let raise_by = action.street_total - level;
                    (pot + call > 0).then(|| raise_by * 100 / (pot + call))
                };
                extras.bet_pct[index - 1] = pct;
            }
        }
        if index == 0 && action.kind == ActionType::Raise {
            raised_preflop = true;
        }
        match action.kind {
            ActionType::Show
            | ActionType::Muck
            | ActionType::Collect
            | ActionType::CashoutChoose
            | ActionType::CashoutPay => {}
            _ => {
                pot += action.amount;
                if action.street_total > 0 {
                    totals.insert(seat, action.street_total);
                    level = level.max(action.street_total);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cards(text: &str) -> Vec<Card> {
        text.split_whitespace().filter_map(card).collect()
    }

    fn made(hole: &str, board: &str) -> &'static str {
        let h = cards(hole);
        made_hand([h[0], h[1]], &cards(board)).0
    }

    #[test]
    fn names_the_made_hands() {
        assert_eq!(made("Ah Kd", "Ks 7c 2d"), "topPair");
        assert_eq!(made("Qh Qd", "Js 7c 2d"), "overpair");
        assert_eq!(made("4h 4d", "Js 7c 6d"), "underpair");
        assert_eq!(made("8h 8d", "Js 7c 2d"), "middlePair");
        assert_eq!(made("7h 5d", "Ks 7c 2d"), "middlePair");
        assert_eq!(made("2h 5d", "Ks 7c 2d"), "bottomPair");
        assert_eq!(made("Kh 7d", "Ks 7c 2d"), "twoPair");
        assert_eq!(made("7h 7d", "Ks 7c 2d"), "set");
        assert_eq!(made("7h Ad", "Ks 7c 7d"), "trips");
        assert_eq!(made("9h 8d", "Ts 7c 6d"), "straight");
        assert_eq!(made("Ah 3h", "Kh 7h 2h"), "flush");
        assert_eq!(made("Kh 7d", "Ks 7c 7s"), "fullHouse");
        assert_eq!(made("Ah 3d", "Ks 7c 2d"), "highCard");
        assert_eq!(made("Ah 3d", "Ks Kc 2d"), "highCard");
    }

    #[test]
    fn grades_a_top_pair_kicker() {
        let h = cards("Ah Kd");
        assert_eq!(made_hand([h[0], h[1]], &cards("Ks 7c 2d")).1, Some(1));
        let h = cards("Qh Kd");
        assert_eq!(made_hand([h[0], h[1]], &cards("Ks 7c 2d")).1, Some(2));
        let h = cards("4h Kd");
        assert_eq!(made_hand([h[0], h[1]], &cards("Ks 7c 2d")).1, Some(3));
    }

    #[test]
    fn finds_the_draws() {
        let d = |hole: &str, board: &str| {
            let h = cards(hole);
            let b = cards(board);
            let (m, _) = made_hand([h[0], h[1]], &b);
            draws([h[0], h[1]], &b, m)
        };
        assert_ne!(d("Ah 3h", "Kh 7h 2c") & draw_bit("nutFlushDraw"), 0);
        assert_ne!(d("9h 8d", "7s 6c 2d") & draw_bit("oesd"), 0);
        assert_ne!(d("9h 7d", "Js Tc 2d") & draw_bit("gutshot"), 0);
        assert_ne!(d("9h 8h", "7h 6h Kc") & draw_bit("comboDraw"), 0);
        assert_ne!(d("Ah 3h", "Kh 7c 2d") & draw_bit("backdoorFlush"), 0);
        assert_eq!(d("Ah Kd", "Ks 7c 2d"), 0);
    }
}

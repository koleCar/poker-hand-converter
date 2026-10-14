//! One corpus hand rewritten for a simulated table.
//!
//! What changes, and nothing else:
//!
//! - the **hand id** on the first line (a fresh one from the caller);
//! - the **table name** on the table line (the first of the first four
//!   lines with `-max` on it), and for tournaments the **tournament id**
//!   on the first two lines;
//! - every `YYYY/M/D H:MM:SS` on the first two lines, moved by one shift so
//!   the hand is played at the caller's time (two stamps of a dual-zone
//!   header keep their difference; the digits keep their widths);
//! - the **seats**, rotated so the hero sits in the table's hero seat
//!   (`Seat N:` lines and `Seat #N is the button`; runs of `Seat N:` lines
//!   re-sorted), which keeps every position;
//! - the **player names**: each player gets the name the table has for the
//!   seat it now sits in, the hero the hero's name. A name is replaced
//!   wherever it stands as a token (not inside a longer word), longest
//!   first, in one pass;
//! - a hand **without a hero** (most of the corpus: test fixtures written
//!   from a rail's view) gets one: a player who is dealt in becomes the
//!   hero, and a `Dealt to` line is added where the room prints it
//!   (`rooms.json` `dealt`) with the cards that player showed, or cards
//!   no one else holds and the board does not use. Nothing else of the
//!   hand changes.
//!
//! The result is then converted with the room's parser and must come back
//! as one hand with exactly the new id, table, tournament, names, seats,
//! stacks, heroes, positions, button and number of actions - otherwise the
//! rewrite is an error and the caller takes another template. So whatever
//! the simulator writes is known to read back as intended.

use std::sync::LazyLock;

use rail_core::detect::ConvertOptions;
use rail_core::phf::PhfHand;
use regex::Regex;

use crate::clock::{Civil, parse_iso_utc};

/// What a hand is rewritten into.
#[derive(Debug, Clone)]
pub struct Target<'a> {
    pub hand_id: &'a str,
    pub table_name: &'a str,
    /// The hand's new time, seconds since the epoch (UTC).
    pub played_at: i64,
    /// Tournaments: the new tournament id.
    pub tournament_id: Option<&'a str>,
    /// The table's hero seat (1-based); the template's hero is moved there.
    pub hero_seat: u32,
    /// The table's player per seat (index = seat - 1).
    pub roster: &'a [String],
    pub hero_name: &'a str,
    /// For a hand without a hero: which dealt-in player becomes the hero
    /// (modulo their number) and which unused cards they get.
    pub hero_pick: u32,
}

/// Where a room prints the hero's `Dealt to` line: right after the line
/// `after`, or right before the line `before` (the first such line).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DealtRule {
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
}

/// A rewritten hand: its text (LF line ends, no separator) and how the
/// core reads it.
#[derive(Debug, Clone)]
pub struct Rewritten {
    pub text: String,
    pub hand: PhfHand,
}

static STAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d{4})/(\d{1,2})/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})").expect("stamp")
});
static SEAT_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^Seat (\d+):").expect("seat line"));
static BUTTON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Seat #(\d+) is the button").expect("button"));

/// Placeholder for the table name while names are replaced (a control
/// character: never part of a name, never a word character).
const TABLE_MARK: &str = "\u{1}TABLE\u{1}";

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Replace each `(from, to)` wherever `from` stands as a token: where its
/// first (last) character is a word character, the character before
/// (after) it is not. Longest first, one pass, so a replacement is never
/// replaced again.
pub fn replace_tokens(text: &str, pairs: &[(String, String)]) -> String {
    let mut pairs: Vec<&(String, String)> = pairs.iter().filter(|(f, _)| !f.is_empty()).collect();
    pairs.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
    let mut out = String::with_capacity(text.len() + 64);
    let mut i = 0;
    let mut prev: Option<char> = None;
    'outer: while i < text.len() {
        let rest = &text[i..];
        for (from, to) in &pairs {
            if !rest.starts_with(from.as_str()) {
                continue;
            }
            let first = from.chars().next().unwrap_or(' ');
            let last = from.chars().next_back().unwrap_or(' ');
            let after = rest[from.len()..].chars().next();
            let left_ok = !word(first) || !prev.is_some_and(word);
            let right_ok = !word(last) || !after.is_some_and(word);
            if left_ok && right_ok {
                out.push_str(to);
                i += from.len();
                prev = from.chars().next_back();
                continue 'outer;
            }
        }
        let c = rest.chars().next().unwrap_or(' ');
        out.push(c);
        i += c.len_utf8();
        prev = Some(c);
    }
    out
}

/// Seat `seat` of a `size`-seat table turned by `delta` seats.
fn rotate(seat: u32, delta: u32, size: u32) -> u32 {
    if size == 0 || seat == 0 {
        return seat;
    }
    (seat - 1 + delta) % size + 1
}

/// Every stamp on the line moved by `shift` seconds, widths kept.
fn shift_stamps(line: &str, shift: i64) -> String {
    STAMP
        .replace_all(line, |caps: &regex::Captures<'_>| {
            let num = |i: usize| caps[i].parse::<i64>().unwrap_or(0);
            let width = |i: usize| caps[i].len();
            let civil = Civil {
                year: num(1),
                month: num(2),
                day: num(3),
                hour: num(4),
                minute: num(5),
                second: num(6),
            };
            let new = Civil::from_unix(civil.to_unix() + shift);
            format!(
                "{:04}/{:0w2$}/{:0w3$} {:0w4$}:{:0w5$}:{:0w6$}",
                new.year,
                new.month,
                new.day,
                new.hour,
                new.minute,
                new.second,
                w2 = width(2),
                w3 = width(3),
                w4 = width(4),
                w5 = width(5),
                w6 = width(6),
            )
        })
        .into_owned()
}

/// Sort each run of consecutive `Seat N:` lines by N (stable).
fn sort_seat_runs(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let seat_of = |line: &str| -> Option<u32> {
        let rest = line.strip_prefix("Seat ")?;
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if rest[digits.len()..].starts_with(':') {
            digits.parse().ok()
        } else {
            None
        }
    };
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        if seat_of(lines[i]).is_some() {
            let start = i;
            while i < lines.len() && seat_of(lines[i]).is_some() {
                i += 1;
            }
            let mut run: Vec<&str> = lines[start..i].to_vec();
            run.sort_by_key(|line| seat_of(line).unwrap_or(0));
            out.extend(run);
        } else {
            out.push(lines[i]);
            i += 1;
        }
    }
    out.join("\n")
}

/// The hand id as the first line prints it: `meta.handId`, or the end of it
/// after a prefix the parser adds (Winamax's `WMX-`).
pub fn text_hand_id<'h>(hand: &'h PhfHand, text: &str) -> Option<&'h str> {
    let first = text.split('\n').next().unwrap_or("");
    let id = hand.meta.hand_id.as_str();
    let mut candidate = id;
    loop {
        if !candidate.is_empty() && first.contains(candidate) {
            return Some(candidate);
        }
        let (_, rest) = candidate.split_once('-')?;
        candidate = rest;
    }
}

/// Hole cards per player for a variant (`None`: not one the simulator
/// gives a hero to).
fn hole_count(hand: &PhfHand) -> Option<usize> {
    use rail_core::phf::Variant;
    match hand.game.variant {
        Variant::Holdem => Some(2),
        Variant::Omaha => Some(4),
        Variant::Omaha5 => Some(5),
        Variant::Omaha6 => Some(6),
        _ => None,
    }
}

/// Give a hero-less hand a hero: the seat chosen, and the text with the
/// `Dealt to` line (under the player's current name).
fn add_hero(
    text: &str,
    hand: &PhfHand,
    rule: &DealtRule,
    pick: u32,
) -> Result<(u32, String), String> {
    let count = hole_count(hand).ok_or("no hero, and not a hold'em or Omaha hand")?;
    let dealt: Vec<&rail_core::phf::PhfPlayer> =
        hand.players.iter().filter(|p| !p.sitting_out).collect();
    if dealt.is_empty() {
        return Err("no player dealt in".into());
    }
    // Players who showed their cards first: their cards are known.
    let mut order: Vec<&rail_core::phf::PhfPlayer> = dealt
        .iter()
        .copied()
        .filter(|p| p.hole_cards.len() == count)
        .collect();
    order.extend(
        dealt
            .iter()
            .copied()
            .filter(|p| p.hole_cards.len() != count),
    );
    let index = usize::try_from(pick).unwrap_or(0) % order.len();
    let player = order[index];
    let cards: Vec<String> = if player.hole_cards.len() == count {
        player.hole_cards.clone()
    } else {
        let mut used: std::collections::HashSet<String> = hand
            .players
            .iter()
            .flat_map(|p| p.hole_cards.iter().chain(&p.dealt_cards).cloned())
            .collect();
        for runout in &hand.board.runouts {
            used.extend(runout.flop.iter().flatten().cloned());
            used.extend(runout.turn.clone());
            used.extend(runout.river.clone());
        }
        let deck: Vec<String> = "23456789TJQKA"
            .chars()
            .flat_map(|r| "shdc".chars().map(move |s| format!("{r}{s}")))
            .filter(|c| !used.contains(c))
            .collect();
        if deck.len() < count * 5 {
            return Err("no cards left for the hero".into());
        }
        let start = usize::try_from(pick).unwrap_or(0) % deck.len();
        (0..count)
            .map(|i| deck[(start + i * 5) % deck.len()].clone())
            .collect()
    };
    let line = format!("Dealt to {} [{}]", player.name, cards.join(" "));
    let lines: Vec<&str> = text.split('\n').collect();
    let at = if let Some(after) = &rule.after {
        lines
            .iter()
            .position(|l| l.trim_end() == after)
            .map(|i| i + 1)
    } else if let Some(before) = &rule.before {
        lines.iter().position(|l| l.trim_end() == before)
    } else {
        None
    }
    .ok_or("no place for the Dealt to line")?;
    let mut out: Vec<&str> = Vec::with_capacity(lines.len() + 1);
    out.extend(&lines[..at]);
    out.push(&line);
    out.extend(&lines[at..]);
    Ok((player.seat, out.join("\n")))
}

/// Rewrite `text` (one hand, as the core split it; `hand` is how the core
/// read it) for `target`, then read it back with `parser` and check it.
/// A hand without a hero is given one by `dealt` (an error without it).
/// `target.hand_id` is the id as the first line prints it (see
/// [`text_hand_id`]).
pub fn rewrite(
    text: &str,
    hand: &PhfHand,
    parser: &str,
    dealt: Option<&DealtRule>,
    target: &Target<'_>,
) -> Result<Rewritten, String> {
    let size = hand.table.max_seats;
    if target.roster.len() < usize::try_from(size).unwrap_or(usize::MAX) {
        return Err(format!(
            "roster of {} for a {size}-seat hand",
            target.roster.len()
        ));
    }
    let old_name = hand.table.name.as_deref().ok_or("no table name")?;
    let old_time = hand
        .played_at
        .as_deref()
        .and_then(parse_iso_utc)
        .ok_or("no time")?;
    let shift = target.played_at - old_time;
    let mut hero_old = hand.players.iter().find(|p| p.is_hero).map(|p| p.seat);
    let added;
    let text = if hero_old.is_some() {
        text
    } else {
        let rule = dealt.ok_or("no hero")?;
        let (seat, with_hero) = add_hero(text, hand, rule, target.hero_pick)?;
        hero_old = Some(seat);
        added = with_hero;
        added.as_str()
    };
    let delta = match hero_old {
        Some(old) if target.hero_seat >= 1 && target.hero_seat <= size => {
            (target.hero_seat + size - old) % size
        }
        _ => 0,
    };

    // The header lines.
    let old_id = text_hand_id(hand, text).ok_or("hand id not on the first line")?;
    let id_prefix = &hand.meta.hand_id[..hand.meta.hand_id.len() - old_id.len()];
    let expected_id = format!("{id_prefix}{}", target.hand_id);
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let first = lines.first_mut().ok_or("empty hand")?;
    let replaced = replace_tokens(first, &[(old_id.to_owned(), target.hand_id.to_owned())]);
    if replaced == *first {
        return Err("hand id not on the first line".into());
    }
    *first = replaced;
    let table_line = lines
        .iter()
        .take(4)
        .position(|line| line.contains("-max") && line.contains(old_name))
        .ok_or("no table line")?;
    lines[table_line] = lines[table_line].replacen(old_name, TABLE_MARK, 1);
    let old_tid = hand.tournament.as_ref().map(|t| t.id.clone());
    for line in lines.iter_mut().take(2) {
        *line = shift_stamps(line, shift);
        if let (Some(old), Some(new)) = (&old_tid, target.tournament_id) {
            *line = replace_tokens(line, &[(old.clone(), new.to_owned())]);
        }
    }
    let mut text = lines.join("\n");

    // Seats.
    if delta != 0 {
        text = SEAT_LINE
            .replace_all(&text, |caps: &regex::Captures<'_>| {
                let seat = caps[1].parse::<u32>().unwrap_or(0);
                format!("Seat {}:", rotate(seat, delta, size))
            })
            .into_owned();
        text = BUTTON
            .replace_all(&text, |caps: &regex::Captures<'_>| {
                let seat = caps[1].parse::<u32>().unwrap_or(0);
                format!("Seat #{} is the button", rotate(seat, delta, size))
            })
            .into_owned();
        text = sort_seat_runs(&text);
    }

    // Names.
    let mut pairs = Vec::with_capacity(hand.players.len());
    let mut expected = Vec::with_capacity(hand.players.len());
    for player in &hand.players {
        let seat = rotate(player.seat, delta, size);
        let index = usize::try_from(seat.saturating_sub(1)).unwrap_or(0);
        let is_hero = Some(player.seat) == hero_old;
        let name = if is_hero {
            target.hero_name.to_owned()
        } else {
            target
                .roster
                .get(index)
                .cloned()
                .ok_or("seat beyond roster")?
        };
        pairs.push((player.name.clone(), name.clone()));
        expected.push((seat, name, player, is_hero));
    }
    let text = replace_tokens(&text, &pairs).replacen(TABLE_MARK, target.table_name, 1);

    // Read it back.
    let options = ConvertOptions {
        site_id: Some(parser.to_owned()),
        ..ConvertOptions::default()
    };
    let result = rail_core::convert_any(&text, &options).map_err(|e| format!("{e:?}"))?;
    if !result.failures.is_empty() || result.hands.len() != 1 {
        return Err(format!(
            "reads back as {} hands and {} refusals ({})",
            result.hands.len(),
            result.failures.len(),
            result
                .failures
                .first()
                .map(|f| f.message.as_str())
                .unwrap_or("")
        ));
    }
    let new = result.hands.into_iter().next().ok_or("no hand")?.hand;
    if new.meta.hand_id != expected_id {
        return Err(format!("hand id reads back as {}", new.meta.hand_id));
    }
    if new.table.name.as_deref() != Some(target.table_name) {
        return Err(format!("table reads back as {:?}", new.table.name));
    }
    if target.tournament_id.is_some()
        && new.tournament.as_ref().map(|t| t.id.as_str()) != target.tournament_id
    {
        return Err("tournament id does not read back".into());
    }
    if new.players.len() != hand.players.len() || new.actions.len() != hand.actions.len() {
        return Err("players or actions differ".into());
    }
    for (seat, name, old, is_hero) in &expected {
        let Some(p) = new.players.iter().find(|p| p.seat == *seat) else {
            return Err(format!("no player in seat {seat}"));
        };
        if p.name != *name
            || p.starting_stack != old.starting_stack
            || p.is_hero != *is_hero
            || p.position != old.position
        {
            return Err(format!(
                "seat {seat} reads back as {} (expected {name})",
                p.name
            ));
        }
    }
    if new.table.button_seat != hand.table.button_seat.map(|b| rotate(b, delta, size)) {
        return Err("button does not read back".into());
    }
    Ok(Rewritten { text, hand: new })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_bounded_and_replaced_once() {
        let pairs = vec![
            ("Al".to_owned(), "Bo".to_owned()),
            ("Player1".to_owned(), "Player10".to_owned()),
            ("Player10".to_owned(), "X".to_owned()),
        ];
        assert_eq!(
            replace_tokens("Al folds. All-in by Player1, Player10 calls", &pairs),
            "Bo folds. All-in by Player10, X calls"
        );
        assert_eq!(replace_tokens("[Al]", &[("[Al]".into(), "y".into())]), "y");
    }

    #[test]
    fn stamps_shift_with_their_widths() {
        assert_eq!(
            shift_stamps("x 2014/01/06 7:22:02 ET [2014/01/06 12:22:02 UTC]", 3600),
            "x 2014/01/06 8:22:02 ET [2014/01/06 13:22:02 UTC]"
        );
        assert_eq!(
            shift_stamps("2013/12/31 23:59:59", 1),
            "2014/01/01 00:00:00"
        );
    }

    #[test]
    fn seat_runs_sort() {
        assert_eq!(
            sort_seat_runs("a\nSeat 3: x\nSeat 1: y\nb\nSeat 2: z"),
            "a\nSeat 1: y\nSeat 3: x\nb\nSeat 2: z"
        );
        assert_eq!(rotate(6, 1, 6), 1);
        assert_eq!(rotate(2, 5, 6), 1);
    }
}

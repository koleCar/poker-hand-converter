//! The session review and the own charts' comparison in the app
//! (docs/RAIL-PLAN.md R5.4; the web's R5.1 `session_review` and R5.3b
//! `preflop_chart_*` readers, over this store).
//!
//! - **A session** is the web's rule (`report_sessions`, `session_review`):
//!   the hero's hands in time order across every table (bomb pots out), a
//!   break longer than the gap starting the next one. It is found by walking
//!   `hand_list` (the hero's rows by time) outwards from one instant until a
//!   break on each side, in chunks, so a review reads its session's rows and
//!   two neighbours, not the history. Without an instant, the latest session
//!   that has **ended**; one that may still be going on is named in
//!   `ongoing` and reviewed only when asked for (A10).
//! - **What a review answers** ([`Reader::session_review`]) is the shape of
//!   `packages/ui/review/model.ts`' `SessionReview` (camelCase JSON): the
//!   summary (bounds, hands, tables, the result in big blinds without EV
//!   cashouts, money for one currency of cash, the all-in EV adjusted
//!   result), the analysis' coverage at a version, and three ranked, capped
//!   lists - per hand its worst graded decision of Inaccurate or worse, its
//!   preflop decision graded against the shipped charts at Inaccurate or
//!   worse, the biggest pots - with what the lists show of each hand.
//!   Grades are read as stored; nothing here grades.
//! - **The own charts** (R5.3b): the stored preflop decisions on the
//!   shipped tree (`decision_analysis.chart_*`, filed by the runner as the
//!   web's `preflop_decision_fields` files them) per situation, class and
//!   action over a period ([`Reader::chart_played`]), the hands behind one
//!   cell ([`Reader::chart_examples`]), and a session's
//!   ([`Reader::session_preflop`]).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::hand_list::segments;
use crate::read::Reader;
use crate::time::{iso_from_ms, ms_from_iso};

/// Rows read per step of the walk outwards.
const CHUNK: i64 = 500;

/// The most hands a list returns.
pub const LIST_MAX: usize = 50;

/// `hand_list.kind`: an EV cashout (its result is left out of the sums).
/// Bomb pots (kind 1) are left out of sessions by the queries.
const KIND_CASHOUT: i64 = 4;

/// What [`Reader::session_review`] is asked.
#[derive(Debug, Clone)]
pub struct ReviewQuery {
    /// Any instant in the session (ISO); `None`: the latest that has ended.
    pub at: Option<String>,
    /// Minutes; a longer break starts a new session.
    pub gap_minutes: i64,
    /// Hands per list, at most [`LIST_MAX`].
    pub limit: usize,
    /// The analysis version the coverage and the lists read.
    pub version: String,
    /// Now, ms (whether the latest session has ended).
    pub now_ms: i64,
}

/// One of the hero's hands as the walk reads it.
#[derive(Debug, Clone)]
struct HeroHand {
    played_at: String,
    ms: i64,
}

/// The hero's hands before (`backwards`) or after `from`, `CHUNK` at a time.
/// (Hands sharing an instant with a chunk's last one may be skipped: a gap
/// of 0, which moves no bound - the web's walk does the same.)
fn chunk(conn: &Connection, from: &str, backwards: bool) -> Result<Vec<HeroHand>> {
    let sql = if backwards {
        "SELECT played_at FROM hand_list
         WHERE played_at < ?1 AND played_at > '' AND hero_net IS NOT NULL AND (kind & 1) = 0
         ORDER BY played_at DESC, hand_key DESC LIMIT ?2"
    } else {
        "SELECT played_at FROM hand_list
         WHERE played_at > ?1 AND hero_net IS NOT NULL AND (kind & 1) = 0
         ORDER BY played_at, hand_key LIMIT ?2"
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params![from, CHUNK], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let played_at = row?;
        if let Some(ms) = ms_from_iso(&played_at) {
            out.push(HeroHand { played_at, ms });
        }
    }
    Ok(out)
}

/// The session around `anchor`: (start, end, the hand before it, the hand
/// after it), as instants.
fn bounds(
    conn: &Connection,
    anchor: &HeroHand,
    gap_ms: i64,
) -> Result<(HeroHand, HeroHand, Option<HeroHand>, Option<HeroHand>)> {
    let mut start = anchor.clone();
    let mut previous = None;
    let mut from = anchor.played_at.clone();
    'back: loop {
        let rows = chunk(conn, &from, true)?;
        let Some(last) = rows.last() else { break };
        let last = last.played_at.clone();
        let full = i64::try_from(rows.len()).unwrap_or(0) >= CHUNK;
        for hand in rows {
            if start.ms - hand.ms > gap_ms {
                previous = Some(hand);
                break 'back;
            }
            start = hand;
        }
        if !full {
            break;
        }
        from = last;
    }
    let mut end = anchor.clone();
    let mut next = None;
    let mut from = anchor.played_at.clone();
    'forward: loop {
        let rows = chunk(conn, &from, false)?;
        let Some(last) = rows.last() else { break };
        let last = last.played_at.clone();
        let full = i64::try_from(rows.len()).unwrap_or(0) >= CHUNK;
        for hand in rows {
            if hand.ms - end.ms > gap_ms {
                next = Some(hand);
                break 'forward;
            }
            end = hand;
        }
        if !full {
            break;
        }
        from = last;
    }
    Ok((start, end, previous, next))
}

/// The anchor hand: the latest at or before `at`, else the first after it;
/// without `at`, the latest.
fn anchor(conn: &Connection, at: Option<&str>) -> Result<Option<HeroHand>> {
    let read = |sql: &str, arg: &str| -> Result<Option<HeroHand>> {
        Ok(conn
            .prepare_cached(sql)?
            .query_row([arg], |row| row.get::<_, String>(0))
            .optional()?
            .and_then(|played_at| ms_from_iso(&played_at).map(|ms| HeroHand { played_at, ms })))
    };
    let before = "SELECT played_at FROM hand_list
         WHERE played_at > '' AND played_at <= ?1 AND hero_net IS NOT NULL AND (kind & 1) = 0
         ORDER BY played_at DESC, hand_key DESC LIMIT 1";
    let after = "SELECT played_at FROM hand_list
         WHERE played_at > ?1 AND hero_net IS NOT NULL AND (kind & 1) = 0
         ORDER BY played_at, hand_key LIMIT 1";
    match at {
        Some(at) => match read(before, at)? {
            Some(hand) => Ok(Some(hand)),
            None => read(after, at),
        },
        // '~' sorts after every ISO instant.
        None => read(before, "~"),
    }
}

/// A session's hand as the review reads it.
#[derive(Debug, Clone)]
struct SessionHand {
    hand_key: String,
    played_at: String,
    segment_id: i64,
    position: Option<String>,
    cards: Option<String>,
    net: i64,
    net_bb_milli: i64,
    board: String,
    pot_type: String,
    kind: i64,
    currency: String,
    symbol: String,
    minor_units: i64,
}

fn session_hands(conn: &Connection, start: &str, end: &str) -> Result<Vec<SessionHand>> {
    let mut stmt = conn.prepare_cached(
        "SELECT hand_key, played_at, segment_id, hero_position, hero_cards, hero_net,
                hero_net_bb_milli, board, pot_type, kind, currency, currency_symbol, minor_units
         FROM hand_list
         WHERE played_at >= ?1 AND played_at <= ?2 AND hero_net IS NOT NULL AND (kind & 1) = 0
         ORDER BY played_at, hand_key",
    )?;
    let rows = stmt.query_map([start, end], |row| {
        Ok(SessionHand {
            hand_key: row.get(0)?,
            played_at: row.get(1)?,
            segment_id: row.get(2)?,
            position: row.get(3)?,
            cards: row.get(4)?,
            net: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            net_bb_milli: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
            board: row.get(7)?,
            pot_type: row.get(8)?,
            kind: row.get(9)?,
            currency: row.get(10)?,
            symbol: row.get(11)?,
            minor_units: row.get(12)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// What a hand's row of the review needs from `hands` and the statistics.
#[derive(Debug, Clone, Default)]
struct HandFacts {
    site: String,
    table: Option<String>,
    small_blind: i64,
    big_blind: i64,
    total_pot: Option<i64>,
    hand_class: Option<String>,
}

fn hand_facts(conn: &Connection, hand_key: &str) -> Result<HandFacts> {
    Ok(conn
        .prepare_cached(
            "SELECT h.site, h.table_name, h.small_blind, h.big_blind, d.total_pot,
                    (SELECT s.hand_class FROM seat_stats s WHERE s.hand_id = d.id AND s.is_hero = 1)
             FROM hands h LEFT JOIN hand_stats d ON d.hand_key = h.hand_key
             WHERE h.hand_key = ?1",
        )?
        .query_row([hand_key], |row| {
            Ok(HandFacts {
                site: row.get(0)?,
                table: row.get(1)?,
                small_blind: row.get(2)?,
                big_blind: row.get(3)?,
                total_pot: row.get(4)?,
                hand_class: row.get(5)?,
            })
        })
        .optional()?
        .unwrap_or_default())
}

/// `round(pot / bb, 2)` as Postgres' numeric does it (half away from zero).
fn pot_bb(pot: i64, bb: i64) -> Option<f64> {
    if bb <= 0 {
        return None;
    }
    let hundredths = (i128::from(pot) * 200 + i128::from(bb)) / (2 * i128::from(bb));
    let text = format!("{}.{:02}", hundredths / 100, hundredths % 100);
    text.parse().ok()
}

/// A stored decision of Inaccurate or worse.
#[derive(Debug, Clone)]
struct Bad {
    hand_key: String,
    played_at: String,
    ord: i64,
    action_index: i64,
    street: String,
    action: String,
    scenario: String,
    source: String,
    grade: String,
    rank: i64,
    ev_loss_bb: Option<f64>,
    ev_loss_pot: Option<f64>,
    best: String,
    chosen_freq: Option<f64>,
    position: Option<String>,
}

/// `ev desc nulls last`.
fn ev_desc(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(a), Some(b)) => b.total_cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn decision_json(bad: &Bad) -> Value {
    json!({
        "handId": bad.hand_key,
        "ord": bad.ord,
        "actionIndex": bad.action_index,
        "street": bad.street,
        "action": bad.action,
        "best": if bad.best.is_empty() { Value::Null } else { json!(bad.best) },
        "scenario": bad.scenario,
        "position": bad.position,
        "source": bad.source,
        "grade": bad.grade,
        "evLossBb": bad.ev_loss_bb,
        "evLossPot": bad.ev_loss_pot,
        "chosenFreq": bad.chosen_freq,
    })
}

fn seat_ok(position: &str) -> bool {
    (1..=8).contains(&position.len())
        && position
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'+')
}

/// The decisions of Inaccurate or worse of these hands at `version`.
fn bad_decisions(conn: &Connection, hands: &[SessionHand], version: &str) -> Result<Vec<Bad>> {
    let mut stmt = conn.prepare_cached(
        "SELECT d.ord, d.action_index, d.street, d.action, d.scenario, d.source, d.grade,
                d.grade_rank, d.ev_loss_bb, d.ev_loss_pot, d.best, d.chosen, d.options, d.facts
         FROM hand_analysis a
         JOIN decision_analysis d ON d.hand_key = a.hand_key
         WHERE a.hand_key = ?1 AND a.analysis_version = ?2 AND d.grade_rank >= 3",
    )?;
    let mut out = Vec::new();
    for hand in hands {
        let mut rows = stmt.query(params![hand.hand_key, version])?;
        while let Some(row) = rows.next()? {
            let chosen: Option<i64> = row.get(11)?;
            let options: Value = serde_json::from_str(&row.get::<_, String>(12)?)
                .map_err(|error| Error::Corrupt(error.to_string()))?;
            let facts: Value = serde_json::from_str(&row.get::<_, String>(13)?)
                .map_err(|error| Error::Corrupt(error.to_string()))?;
            let chosen_freq = chosen
                .and_then(|i| usize::try_from(i).ok())
                .and_then(|i| options.get(i))
                .and_then(|o| o.get("freq"))
                .and_then(Value::as_f64);
            let position = facts
                .get("position")
                .and_then(Value::as_str)
                .filter(|p| seat_ok(p))
                .map(str::to_owned);
            out.push(Bad {
                hand_key: hand.hand_key.clone(),
                played_at: hand.played_at.clone(),
                ord: row.get(0)?,
                action_index: row.get(1)?,
                street: row.get(2)?,
                action: row.get(3)?,
                scenario: row.get(4)?,
                source: row.get(5)?,
                grade: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                rank: row.get(7)?,
                ev_loss_bb: row.get(8)?,
                ev_loss_pot: row.get(9)?,
                best: row.get(10)?,
                chosen_freq,
                position,
            });
        }
    }
    Ok(out)
}

/// Per hand the first by `pick`, then all of them in `order`, `limit` kept.
fn per_hand(
    bad: &[Bad],
    keep: impl Fn(&Bad) -> bool,
    pick: impl Fn(&Bad, &Bad) -> std::cmp::Ordering,
    order: impl Fn(&Bad, &Bad) -> std::cmp::Ordering,
    limit: usize,
) -> Vec<Bad> {
    let mut best: BTreeMap<&str, &Bad> = BTreeMap::new();
    for b in bad.iter().filter(|b| keep(b)) {
        match best.get(b.hand_key.as_str()) {
            Some(current) if pick(current, b) != std::cmp::Ordering::Greater => {}
            _ => {
                best.insert(&b.hand_key, b);
            }
        }
    }
    let mut out: Vec<Bad> = best.into_values().cloned().collect();
    out.sort_by(|a, b| order(a, b));
    out.truncate(limit);
    out
}

/// The review's row of a hand.
fn hand_json(conn: &Connection, hand: &SessionHand, format: &str, version: &str) -> Result<Value> {
    let facts = hand_facts(conn, &hand.hand_key)?;
    let ev: Option<i64> = conn
        .prepare_cached("SELECT ev_net_bb_milli FROM ev_rows WHERE hand_key = ?1")?
        .query_row([&hand.hand_key], |row| row.get(0))
        .optional()?;
    let analysis: Option<(Option<String>, Option<f64>)> = conn
        .prepare_cached(
            "SELECT grade, ev_loss_bb FROM hand_analysis WHERE hand_key = ?1 AND analysis_version = ?2",
        )?
        .query_row(params![hand.hand_key, version], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let split =
        |text: &str| -> Vec<String> { text.split_whitespace().map(str::to_owned).collect() };
    Ok(json!({
        "handId": hand.hand_key,
        "playedAt": hand.played_at,
        "site": facts.site,
        "stakesLabel": Value::Null,
        "smallBlind": facts.small_blind,
        "gameFormat": format,
        "currency": hand.currency,
        "currencySymbol": hand.symbol,
        "minorUnits": hand.minor_units,
        "bigBlind": facts.big_blind,
        "tableName": facts.table,
        "position": hand.position,
        "heroCards": split(hand.cards.as_deref().unwrap_or("")),
        "handClass": facts.hand_class,
        "board": split(&hand.board),
        "potType": if hand.pot_type.is_empty() { Value::Null } else { json!(hand.pot_type) },
        "potBb": facts.total_pot.and_then(|pot| pot_bb(pot, facts.big_blind)),
        "net": hand.net,
        "netBbMilli": hand.net_bb_milli,
        "evNetBbMilli": ev,
        "grade": analysis.as_ref().and_then(|a| a.0.clone()),
        "evLossBb": analysis.and_then(|a| a.1),
    }))
}

fn review(conn: &Connection, query: &ReviewQuery) -> Result<Value> {
    let gap_ms = query.gap_minutes.saturating_mul(60_000);
    let limit = query.limit.clamp(1, LIST_MAX);
    let empty = |ongoing: Value| {
        json!({
            "gapMinutes": query.gap_minutes,
            "session": Value::Null,
            "ongoing": ongoing,
            "coverage": {"hands": 0, "analysed": 0, "graded": 0, "notAnalysed": 0},
            "worst": [], "chartDeviations": [], "pots": [], "hands": {},
        })
    };
    let Some(mut anchor_hand) = anchor(conn, query.at.as_deref())? else {
        return Ok(empty(Value::Null));
    };
    let mut ongoing = Value::Null;
    let mut found = bounds(conn, &anchor_hand, gap_ms)?;
    if query.at.is_none() && query.now_ms - found.1.ms <= gap_ms {
        // The latest session may still be going on: named, not reviewed.
        ongoing = json!({"startedAt": found.0.played_at, "endedAt": found.1.played_at});
        match found.2.clone() {
            Some(previous) => {
                anchor_hand = previous;
                found = bounds(conn, &anchor_hand, gap_ms)?;
            }
            None => return Ok(empty(ongoing)),
        }
    }
    let (start, end, previous, next) = found;
    let hands = session_hands(conn, &start.played_at, &end.played_at)?;
    let dims = segments(conn)?;
    let format_of = |segment: i64| dims.get(&segment).map_or("", |d| d.format.as_str());

    // The summary: `report_sessions`' sums (an EV cashout's result left out).
    let mut tables = BTreeSet::new();
    let (mut net, mut bb, mut ev_delta_bb, mut ev_delta_net, mut all_in) =
        (0_i64, 0_i64, 0_i64, 0_i64, 0_i64);
    let (mut any_cash, mut any_chips) = (false, false);
    let mut currencies = BTreeSet::new();
    let mut minor_units = None;
    let mut symbol = None;
    for hand in &hands {
        let facts = hand_facts(conn, &hand.hand_key)?;
        if let Some(table) = facts.table {
            tables.insert(table);
        }
        let cash = format_of(hand.segment_id) == "cash";
        any_cash |= cash;
        any_chips |= !cash;
        currencies.insert(hand.currency.clone());
        minor_units = Some(minor_units.map_or(hand.minor_units, |m: i64| m.min(hand.minor_units)));
        if cash && symbol.is_none() && !hand.symbol.is_empty() {
            symbol = Some(hand.symbol.clone());
        }
        if hand.kind & KIND_CASHOUT == 0 {
            net += hand.net;
            bb += hand.net_bb_milli;
            let ev: Option<(i64, i64)> = conn
                .prepare_cached("SELECT ev_net, ev_net_bb_milli FROM ev_rows WHERE hand_key = ?1")?
                .query_row([&hand.hand_key], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?;
            if let Some((ev_net, ev_bb)) = ev {
                all_in += 1;
                ev_delta_net += ev_net - hand.net;
                ev_delta_bb += ev_bb - hand.net_bb_milli;
            }
        }
    }
    let one_currency = currencies.len() == 1;
    let mixed_kind = any_cash && any_chips;
    let money = any_cash && !any_chips && one_currency;
    let session = json!({
        "startedAt": start.played_at,
        "endedAt": end.played_at,
        "finished": query.now_ms - end.ms > gap_ms,
        "previousAt": previous.map(|h| h.played_at),
        "nextAt": next.map(|h| h.played_at),
        "hands": hands.len(),
        "tables": tables.len(),
        "allInHands": all_in,
        "mixedUnitKind": mixed_kind,
        "mixedCurrency": currencies.len() > 1,
        "cash": any_cash && !any_chips,
        "currency": if one_currency { currencies.iter().next().cloned() } else { None },
        "currencySymbol": symbol,
        "currencyMinorUnits": if one_currency { minor_units } else { None },
        "netBbMilli": if mixed_kind { None } else { Some(bb) },
        "evNetBbMilli": if mixed_kind { None } else { Some(bb + ev_delta_bb) },
        "net": if money { Some(net) } else { None },
        "evNet": if money { Some(net + ev_delta_net) } else { None },
    });

    // The analysis' coverage at the version.
    let mut coverage = (0_i64, 0_i64, 0_i64);
    {
        let mut stmt = conn.prepare_cached(
            "SELECT status, grade IS NOT NULL FROM hand_analysis
             WHERE hand_key = ?1 AND analysis_version = ?2",
        )?;
        for hand in &hands {
            if let Some((status, graded)) = stmt
                .query_row(params![hand.hand_key, query.version], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
                })
                .optional()?
            {
                coverage.0 += 1;
                coverage.1 += i64::from(graded);
                coverage.2 += i64::from(status == "not-analysed");
            }
        }
    }

    // The lists.
    let bad = bad_decisions(conn, &hands, &query.version)?;
    let worst = per_hand(
        &bad,
        |_| true,
        |a, b| {
            b.rank
                .cmp(&a.rank)
                .then_with(|| ev_desc(a.ev_loss_bb, b.ev_loss_bb))
                .then_with(|| a.ord.cmp(&b.ord))
        },
        |a, b| {
            b.rank
                .cmp(&a.rank)
                .then_with(|| ev_desc(a.ev_loss_bb, b.ev_loss_bb))
                .then_with(|| b.played_at.cmp(&a.played_at))
                .then_with(|| a.hand_key.cmp(&b.hand_key))
        },
        limit,
    );
    let deviations = per_hand(
        &bad,
        |b| b.street == "preflop" && b.source == "chart",
        |a, b| {
            ev_desc(a.ev_loss_bb, b.ev_loss_bb)
                .then_with(|| b.rank.cmp(&a.rank))
                .then_with(|| a.ord.cmp(&b.ord))
        },
        |a, b| {
            ev_desc(a.ev_loss_bb, b.ev_loss_bb)
                .then_with(|| b.rank.cmp(&a.rank))
                .then_with(|| b.played_at.cmp(&a.played_at))
                .then_with(|| a.hand_key.cmp(&b.hand_key))
        },
        limit,
    );
    // The biggest pots in big blinds (crosswise in integers), newest first on a tie.
    let mut pots: Vec<(i64, i64, &SessionHand)> = Vec::new();
    for hand in &hands {
        let facts = hand_facts(conn, &hand.hand_key)?;
        if let Some(pot) = facts.total_pot
            && facts.big_blind > 0
        {
            pots.push((pot, facts.big_blind, hand));
        }
    }
    pots.sort_by(|a, b| {
        (i128::from(b.0) * i128::from(a.1))
            .cmp(&(i128::from(a.0) * i128::from(b.1)))
            .then_with(|| b.2.played_at.cmp(&a.2.played_at))
            .then_with(|| a.2.hand_key.cmp(&b.2.hand_key))
    });
    pots.truncate(limit);

    let by_key: HashMap<&str, &SessionHand> =
        hands.iter().map(|h| (h.hand_key.as_str(), h)).collect();
    let mut named: BTreeSet<&str> = BTreeSet::new();
    named.extend(worst.iter().map(|b| b.hand_key.as_str()));
    named.extend(deviations.iter().map(|b| b.hand_key.as_str()));
    named.extend(pots.iter().map(|p| p.2.hand_key.as_str()));
    let mut rows = Map::new();
    for key in named {
        if let Some(hand) = by_key.get(key) {
            rows.insert(
                key.to_owned(),
                hand_json(conn, hand, format_of(hand.segment_id), &query.version)?,
            );
        }
    }
    Ok(json!({
        "gapMinutes": query.gap_minutes,
        "session": session,
        "ongoing": ongoing,
        "coverage": {
            "hands": hands.len(),
            "analysed": coverage.0,
            "graded": coverage.1,
            "notAnalysed": coverage.2,
        },
        "worst": worst.iter().map(decision_json).collect::<Vec<_>>(),
        "chartDeviations": deviations.iter().map(decision_json).collect::<Vec<_>>(),
        "pots": pots.iter().map(|p| json!({"handId": p.2.hand_key, "potBb": pot_bb(p.0, p.1)})).collect::<Vec<_>>(),
        "hands": Value::Object(rows),
    }))
}

/// One session in the picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionItem {
    pub started_at: String,
    pub ended_at: String,
    pub hands: i64,
    pub tables: i64,
    /// `None` when chips mix with cash.
    pub net_bb_milli: Option<i64>,
}

/// One stored preflop decision on the shipped tree, as the own charts read
/// it (`SessionPreflopDecision`).
#[derive(Debug, Clone, PartialEq)]
pub struct PreflopDecision {
    pub hand_key: String,
    pub ord: i64,
    pub action_index: i64,
    pub played_at: String,
    pub key: String,
    pub cls: i64,
    pub action: String,
    pub scenario: String,
    pub position: Option<String>,
    pub game_format: String,
    pub table_size: i64,
    pub depth_band: i64,
    pub ev_loss_bb: Option<f64>,
}

/// One compared cell: (situation, class, action), its decisions and EV loss.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayedCell {
    pub key: String,
    pub cls: i64,
    pub action: String,
    pub decisions: i64,
    pub ev_loss_bb: f64,
}

/// What the own charts compare: a period and the chart's game.
#[derive(Debug, Clone)]
pub struct CompareQuery {
    pub version: String,
    /// `30d`, `90d`, `365d`, `all`.
    pub period: String,
    /// `cash` or `tournament`.
    pub game_format: String,
    pub table_size: i64,
    pub min_bb: i64,
    pub max_bb: i64,
}

/// What [`Reader::chart_played`] answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Played {
    /// UTC days compared (inclusive); `None` when nothing was played.
    pub from: Option<String>,
    pub to: Option<String>,
    pub cells: Vec<PlayedCell>,
}

/// A hand behind one compared cell.
#[derive(Debug, Clone, PartialEq)]
pub struct ExampleRow {
    pub hand_key: String,
    pub action_index: i64,
    pub played_at: String,
    pub hero_cards: Vec<String>,
    pub site: String,
    pub currency: String,
    pub currency_symbol: String,
    pub minor_units: i64,
    pub small_blind: i64,
    pub big_blind: i64,
    pub ev_loss_bb: Option<f64>,
}

fn formats_of(chart_format: &str) -> &'static [&'static str] {
    if chart_format == "cash" {
        &["cash"]
    } else {
        &["tournament", "sng", "spin"]
    }
}

/// The stored preflop chart decisions at `version` of the hands played
/// between `start` and `end` (inclusive; `hand_stats_played_idx`), with
/// their hand's time and format.
fn preflop_rows(
    conn: &Connection,
    version: &str,
    start: &str,
    end: &str,
    mut each: impl FnMut(PreflopDecision) -> Result<()>,
) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "SELECT hand_key, ord, action_index, played_at, chart_key, hand_class, action, scenario,
                position, game_format, table_size, depth_band, ev_loss_bb
         FROM chart_decisions
         WHERE analysis_version = ?1 AND played_at >= ?2 AND played_at <= ?3",
    )?;
    let mut rows = stmt.query(params![version, start, end])?;
    while let Some(row) = rows.next()? {
        let position: String = row.get(8)?;
        each(PreflopDecision {
            hand_key: row.get(0)?,
            ord: row.get(1)?,
            action_index: row.get(2)?,
            played_at: row.get(3)?,
            key: row.get(4)?,
            cls: row.get(5)?,
            action: row.get(6)?,
            scenario: row.get(7)?,
            position: (!position.is_empty()).then_some(position),
            game_format: row.get(9)?,
            table_size: row.get(10)?,
            depth_band: row.get(11)?,
            ev_loss_bb: row.get(12)?,
        })?;
    }
    Ok(())
}

/// The first instant of a period counted back from the last decision
/// (`preflop_chart_window`): midnight UTC of (last day - days + 1).
fn window_from(last_played: &str, period: &str) -> Option<String> {
    let days = match period {
        "30d" => 30,
        "90d" => 90,
        "365d" => 365,
        _ => return None,
    };
    let ms = ms_from_iso(last_played)?;
    let day = ms.div_euclid(86_400_000);
    Some(iso_from_ms((day - days + 1) * 86_400_000))
}

fn day_of(iso: &str) -> String {
    iso.get(..10).unwrap_or("").to_owned()
}

impl Reader {
    /// One session's review (`SessionReview`'s JSON).
    pub fn session_review(&self, query: &ReviewQuery) -> Result<Value> {
        if !(1..=24 * 60).contains(&query.gap_minutes) {
            return Err(Error::OutOfRange("session gap"));
        }
        self.with(|conn| review(conn, query))
    }

    /// The sessions (bomb pots out) whose last hand is at or after `since`
    /// (ISO; `None`: every one), newest first, at most `limit`.
    pub fn review_sessions(
        &self,
        gap_minutes: i64,
        since: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SessionItem>> {
        let gap_ms = gap_minutes.saturating_mul(60_000);
        self.with(|conn| {
            let dims = segments(conn)?;
            let mut stmt = conn.prepare_cached(
                "SELECT l.played_at, l.hero_net_bb_milli, l.segment_id, l.kind, h.table_name
                 FROM hand_list l JOIN hands h ON h.hand_key = l.hand_key
                 WHERE l.played_at >= ?1 AND l.played_at > '' AND l.hero_net IS NOT NULL
                   AND (l.kind & 1) = 0
                 ORDER BY l.played_at DESC, l.hand_key DESC",
            )?;
            let mut rows = stmt.query([since.unwrap_or("")])?;
            let mut out: Vec<SessionItem> = Vec::new();
            let mut open: Option<(SessionItem, i64, BTreeSet<String>, bool, bool)> = None;
            let close = |(mut item, _, tables, cash, chips): (
                SessionItem,
                i64,
                BTreeSet<String>,
                bool,
                bool,
            )| {
                item.tables = i64::try_from(tables.len()).unwrap_or(i64::MAX);
                if cash && chips {
                    item.net_bb_milli = None;
                }
                item
            };
            while let Some(row) = rows.next()? {
                let played_at: String = row.get(0)?;
                let Some(ms) = ms_from_iso(&played_at) else {
                    continue;
                };
                if open.as_ref().is_some_and(|o| o.1 - ms > gap_ms) {
                    out.extend(open.take().map(close));
                    if out.len() >= limit {
                        break;
                    }
                }
                let session = open.get_or_insert_with(|| {
                    (
                        SessionItem {
                            started_at: played_at.clone(),
                            ended_at: played_at.clone(),
                            hands: 0,
                            tables: 0,
                            net_bb_milli: Some(0),
                        },
                        ms,
                        BTreeSet::new(),
                        false,
                        false,
                    )
                });
                session.0.started_at = played_at;
                session.1 = ms;
                session.0.hands += 1;
                if row.get::<_, i64>(3)? & KIND_CASHOUT == 0 {
                    session.0.net_bb_milli = session
                        .0
                        .net_bb_milli
                        .map(|n| n + row.get::<_, Option<i64>>(1).ok().flatten().unwrap_or(0));
                }
                let segment: i64 = row.get(2)?;
                if dims.get(&segment).is_some_and(|d| d.format == "cash") {
                    session.3 = true;
                } else {
                    session.4 = true;
                }
                if let Some(table) = row.get::<_, Option<String>>(4)? {
                    session.2.insert(table);
                }
            }
            if out.len() < limit {
                out.extend(open.map(close));
            }
            Ok(out)
        })
    }

    /// A session's stored preflop decisions on the shipped tree (between two
    /// instants, inclusive), in time order.
    pub fn session_preflop(
        &self,
        version: &str,
        start: &str,
        end: &str,
    ) -> Result<Vec<PreflopDecision>> {
        self.with(|conn| {
            let mut out = Vec::new();
            preflop_rows(conn, version, start, end, |d| {
                out.push(d);
                Ok(())
            })?;
            out.sort_by(|a, b| {
                a.played_at
                    .cmp(&b.played_at)
                    .then_with(|| a.hand_key.cmp(&b.hand_key))
                    .then_with(|| a.ord.cmp(&b.ord))
            });
            Ok(out)
        })
    }

    /// The review's rows of these hands (at most [`LIST_MAX`]).
    pub fn review_hands(&self, keys: &[String], version: &str) -> Result<Value> {
        if keys.len() > LIST_MAX {
            return Err(Error::OutOfRange("review hands"));
        }
        self.with(|conn| {
            let dims = segments(conn)?;
            let mut stmt = conn.prepare_cached(
                "SELECT l.hand_key, l.played_at, l.segment_id, l.hero_position, l.hero_cards,
                        l.hero_net, l.hero_net_bb_milli, l.board, l.pot_type, l.kind, l.currency,
                        l.currency_symbol, l.minor_units
                 FROM hand_stats s
                 JOIN hand_list l ON l.played_at = coalesce(s.played_at, '') AND l.hand_key = s.hand_key
                 WHERE s.hand_key = ?1",
            )?;
            let mut out = Map::new();
            for key in keys {
                let hand = stmt
                    .query_row([key], |row| {
                        Ok(SessionHand {
                            hand_key: row.get(0)?,
                            played_at: row.get(1)?,
                            segment_id: row.get(2)?,
                            position: row.get(3)?,
                            cards: row.get(4)?,
                            net: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                            net_bb_milli: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                            board: row.get(7)?,
                            pot_type: row.get(8)?,
                            kind: row.get(9)?,
                            currency: row.get(10)?,
                            symbol: row.get(11)?,
                            minor_units: row.get(12)?,
                        })
                    })
                    .optional()?;
                if let Some(hand) = hand {
                    let format = dims.get(&hand.segment_id).map_or("", |d| d.format.as_str());
                    out.insert(key.clone(), hand_json(conn, &hand, format, version)?);
                }
            }
            Ok(Value::Object(out))
        })
    }

    /// The own charts' comparison (`preflop_chart_played`): per (situation,
    /// class, action) the decisions in the chart's game over the period, and
    /// their EV loss against Rail's charts.
    pub fn chart_played(&self, query: &CompareQuery) -> Result<Played> {
        self.with(|conn| {
            let (first, last) = span(conn, &query.version)?;
            let from = last.as_deref().and_then(|l| window_from(l, &query.period));
            if query.period != "all" && from.is_none() {
                return Ok(Played {
                    from: None,
                    to: None,
                    cells: Vec::new(),
                });
            }
            let formats = formats_of(&query.game_format);
            let pick = |i: usize| formats.get(i).copied().unwrap_or(formats[0]);
            let mut stmt = conn.prepare_cached(
                "SELECT chart_key, hand_class, action, count(*), total(ev_loss_bb)
                 FROM chart_decisions
                 WHERE analysis_version = ?1 AND played_at >= coalesce(?8, '')
                   AND table_size = ?2 AND game_format IN (?3, ?4, ?5)
                   AND (depth_band = -1 OR (depth_band + 10 > ?6 AND depth_band <= ?7))
                 GROUP BY 1, 2, 3
                 ORDER BY 1, 2, 3",
            )?;
            let cells = stmt
                .query_map(
                    params![
                        query.version,
                        query.table_size,
                        pick(0),
                        pick(1),
                        pick(2),
                        query.min_bb,
                        query.max_bb,
                        from
                    ],
                    |row| {
                        Ok(PlayedCell {
                            key: row.get(0)?,
                            cls: row.get(1)?,
                            action: row.get(2)?,
                            decisions: row.get(3)?,
                            ev_loss_bb: row.get(4)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let to = last.as_deref().map(day_of);
            let from_day = match &from {
                Some(from) => Some(day_of(from)),
                None => first.as_deref().map(day_of),
            };
            Ok(Played {
                from: if to.is_some() { from_day } else { None },
                to,
                cells,
            })
        })
    }

    /// The hands behind one compared cell (`preflop_chart_examples`), newest
    /// first, at most `limit` (50).
    pub fn chart_examples(
        &self,
        query: &CompareQuery,
        key: &str,
        cls: i64,
        action: &str,
        limit: usize,
    ) -> Result<Vec<ExampleRow>> {
        let limit = i64::try_from(limit.clamp(1, 50)).unwrap_or(50);
        self.with(|conn| {
            let (_, last) = span(conn, &query.version)?;
            let from = last.as_deref().and_then(|l| window_from(l, &query.period));
            let formats = formats_of(&query.game_format);
            let pick = |i: usize| formats.get(i).copied().unwrap_or(formats[0]);
            let mut stmt = conn.prepare_cached(
                "SELECT c.hand_key, c.action_index, c.played_at, c.ev_loss_bb,
                        h.site, h.currency, h.small_blind, h.big_blind, l.hero_cards,
                        l.currency_symbol, l.minor_units
                 FROM chart_decisions c
                 JOIN hands h ON h.hand_key = c.hand_key
                 LEFT JOIN hand_list l ON l.played_at = c.played_at AND l.hand_key = c.hand_key
                 WHERE c.analysis_version = ?1 AND c.played_at >= coalesce(?8, '')
                   AND c.table_size = ?2 AND c.game_format IN (?3, ?4, ?5)
                   AND (c.depth_band = -1 OR (c.depth_band + 10 > ?6 AND c.depth_band <= ?7))
                   AND c.chart_key = ?9 AND c.hand_class = ?10 AND c.action = ?11
                 ORDER BY c.played_at DESC, c.hand_key
                 LIMIT ?12",
            )?;
            let rows = stmt.query_map(
                params![
                    query.version,
                    query.table_size,
                    pick(0),
                    pick(1),
                    pick(2),
                    query.min_bb,
                    query.max_bb,
                    from,
                    key,
                    cls,
                    action,
                    limit
                ],
                |row| {
                    Ok(ExampleRow {
                        hand_key: row.get(0)?,
                        action_index: row.get(1)?,
                        played_at: row.get(2)?,
                        ev_loss_bb: row.get(3)?,
                        site: row.get(4)?,
                        currency: row.get(5)?,
                        small_blind: row.get(6)?,
                        big_blind: row.get(7)?,
                        hero_cards: row
                            .get::<_, Option<String>>(8)?
                            .unwrap_or_default()
                            .split_whitespace()
                            .map(str::to_owned)
                            .collect(),
                        currency_symbol: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                        minor_units: row.get::<_, Option<i64>>(10)?.unwrap_or(1),
                    })
                },
            )?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

/// The first and last time of the stored preflop chart decisions at
/// `version` (the period counts back from the last).
fn span(conn: &Connection, version: &str) -> Result<(Option<String>, Option<String>)> {
    Ok(conn
        .prepare_cached(
            "SELECT min(played_at), max(played_at) FROM chart_decisions
             WHERE analysis_version = ?1 AND played_at > ''",
        )?
        .query_row([version], |row| Ok((row.get(0)?, row.get(1)?)))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pots_round_as_numeric() {
        assert_eq!(pot_bb(250, 100), Some(2.5));
        assert_eq!(pot_bb(1, 3), Some(0.33));
        assert_eq!(pot_bb(2, 3), Some(0.67));
        assert_eq!(pot_bb(5, 1000), Some(0.01));
        assert_eq!(pot_bb(4, 1000), Some(0.0));
        assert_eq!(pot_bb(10, 0), None);
    }

    #[test]
    fn windows_count_back_from_the_last_day() {
        assert_eq!(
            window_from("2026-10-23T22:15:00.000Z", "30d").as_deref(),
            Some("2026-09-24T00:00:00.000Z")
        );
        assert_eq!(
            window_from("2026-10-23T00:00:00.000Z", "365d").as_deref(),
            Some("2025-10-24T00:00:00.000Z")
        );
        assert_eq!(window_from("2026-10-23T00:00:00.000Z", "all"), None);
    }

    #[test]
    fn seats() {
        assert!(seat_ok("BTN") && seat_ok("UTG+1") && seat_ok("MP2"));
        assert!(!seat_ok("") && !seat_ok("btn") && !seat_ok("TOOLONGSEAT"));
    }
}

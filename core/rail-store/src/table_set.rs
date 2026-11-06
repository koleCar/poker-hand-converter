//! A hand's table for its postflop leak rows (migration 20; the web's
//! `analysis_hand_table_set`, `supabase/migrations/20271102090000_leak_row_table.sql`).
//!
//! The window computes a postflop leak row's `chart_set` when it analyses a
//! hand (`handTableSet` in `app/src/analysis/rows.ts`); this is the same rule
//! in Rust, for the rows stored before it did ([`fill_leak_table_sets`], run
//! once by migration 20, as the web migration's backfill). Both are ports of
//! the SQL as written: the table by the players dealt in (those with a
//! position: 2 heads-up, 3-6 6-max, 7-9 9-max), the depth nearest the
//! effective stack - the hero against the deepest opponent who did not fold
//! preflop; a stack the hand does not state reads 100bb - within 20%; `''`
//! for a hand no set answers (not NLHE cash, a straddle or bomb pot, ten or
//! more players, no single hero, no big blind, a depth outside every band).

use std::collections::HashSet;

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::batch::decompress_phf;
use crate::error::{Error, Result};

/// `CHART_SETS` without the straddle set, in its order (ties go to the
/// first): the web's list, and `HAND_TABLE_SETS` in the app. (id, seats,
/// depth in big blinds.)
pub const TABLE_SETS: &[(&str, u32, i128)] = &[
    ("nlhe-cash-6max-40bb", 6, 40),
    ("nlhe-cash-6max-60bb", 6, 60),
    ("nlhe-cash-6max-100bb", 6, 100),
    ("nlhe-cash-6max-150bb", 6, 150),
    ("nlhe-cash-6max-200bb", 6, 200),
    ("nlhe-cash-9max-100bb", 9, 100),
    ("nlhe-cash-9max-150bb", 9, 150),
    ("nlhe-cash-9max-200bb", 9, 200),
    ("nlhe-cash-hu-100bb", 2, 100),
    ("nlhe-cash-hu-150bb", 2, 150),
];

/// `jsonb ->> key` of a value: its text, `None` for JSON null.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// An amount: PHF money is integer minor units (`docs/PHF-SPEC.md` §1).
fn chips(value: Option<&Value>) -> Option<i128> {
    value.and_then(Value::as_i64).map(i128::from)
}

/// The chart set a hand is read on (`analysis_hand_table_set`); `""` when
/// no set answers.
///
/// Exact, in chips rather than big blinds (the workspace denies float
/// arithmetic): every stack is divided by the same big blind, so the
/// deepest stack and the effective one are compared in chips, and a set's
/// distance `|eff - depth bb| / depth bb` is a fraction compared by cross
/// multiplication. A stack the hand does not state is 100 big blinds.
pub fn hand_table_set(phf: &Value) -> String {
    let game = phf.get("game");
    let field = |key: &str| game.and_then(|g| g.get(key)).and_then(Value::as_str);
    let cash = field("variant") == Some("holdem")
        && field("limit") == Some("nl")
        && field("format") == Some("cash");
    let Some(bb) = chips(game.and_then(|g| g.get("bigBlind"))) else {
        return String::new();
    };
    if !cash || bb <= 0 {
        return String::new();
    }
    let empty = Vec::new();
    let acts: Vec<&Value> = phf
        .get("actions")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter(|a| a.is_object())
        .collect();
    let kind = |a: &Value| a.get("type").and_then(Value::as_str).map(str::to_owned);
    if acts
        .iter()
        .any(|a| matches!(kind(a).as_deref(), Some("straddle" | "bomb-ante")))
    {
        return String::new();
    }
    let folded: HashSet<String> = acts
        .iter()
        .filter(|a| {
            a.get("street").and_then(Value::as_str) == Some("preflop")
                && kind(a).as_deref() == Some("fold")
        })
        .filter_map(|a| a.get("seat").and_then(text_of))
        .collect();
    let (mut k, mut heroes) = (0_u32, 0_u32);
    let (mut hero, mut villain): (Option<i128>, Option<i128>) = (None, None);
    for p in phf
        .get("players")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
    {
        if !p.is_object() || !p.get("position").is_some_and(Value::is_string) {
            continue;
        }
        k += 1;
        let stack = chips(p.get("startingStack")).unwrap_or(100 * bb);
        if p.get("isHero") == Some(&Value::Bool(true)) {
            heroes += 1;
            hero = Some(hero.map_or(stack, |h| h.max(stack)));
        } else {
            let seat = p.get("seat").and_then(text_of);
            if seat.is_none_or(|s| !folded.contains(&s)) {
                villain = Some(villain.map_or(stack, |v| v.max(stack)));
            }
        }
    }
    let seats = match k {
        2 => 2,
        3..=6 => 6,
        7..=9 => 9,
        _ => return String::new(),
    };
    let Some(hero) = hero.filter(|_| heroes == 1) else {
        return String::new();
    };
    let eff = hero.min(villain.unwrap_or(hero));
    // (id, |eff - depth|, depth), in chips: the distance is the ratio.
    let mut best: Option<(&str, i128, i128)> = None;
    for &(id, set_seats, depth) in TABLE_SETS {
        if set_seats != seats {
            continue;
        }
        let at = depth * bb;
        let off = (eff - at).abs();
        // Within 20%: off / at <= 1/5.
        if off * 5 > at {
            continue;
        }
        if best.is_none_or(|(_, b_off, b_at)| off * b_at < b_off * at) {
            best = Some((id, off, at));
        }
    }
    best.map(|(id, _, _)| id.to_owned()).unwrap_or_default()
}

/// Migration 20's fill: every stored flop, turn or river leak row with no
/// set takes its hand's table, as the web migration's backfill does. Rows
/// whose hand no set answers keep `''`; a PHF that cannot be read is
/// skipped (its rows keep `''`, untagged, as before). Idempotent.
pub(crate) fn fill_leak_table_sets(conn: &Connection) -> Result<()> {
    let mut read = conn.prepare(
        "SELECT h.hand_key, h.phf, h.phf_size FROM hands h
         WHERE h.hand_key IN (SELECT DISTINCT r.hand_key FROM analysis_leak_rows r
                              WHERE r.chart_set = '' AND r.spot_key NOT LIKE 'preflop|%')",
    )?;
    let mut write = conn.prepare(
        "UPDATE analysis_leak_rows SET chart_set = ?2
         WHERE hand_key = ?1 AND chart_set = '' AND spot_key NOT LIKE 'preflop|%'",
    )?;
    let mut rows = read.query([])?;
    while let Some(row) = rows.next()? {
        let hand_key: String = row.get(0)?;
        let blob: Vec<u8> = row.get(1)?;
        let size: i64 = row.get(2)?;
        let size = u64::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
        let set = match decompress_phf(&blob, size)
            .ok()
            .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        {
            Some(phf) => hand_table_set(&phf),
            None => {
                log::warn!("leak rows of {hand_key}: the PHF could not be read; left untagged");
                continue;
            }
        };
        if !set.is_empty() {
            write.execute(params![hand_key, set])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::hand_table_set;

    /// A cash hand: `stacks` in chips (big blind 2), the hero first, `folds` the seats folding preflop.
    fn hand(stacks: &[i64], folds: &[u32]) -> Value {
        let positions = [
            "BTN", "SB", "BB", "UTG", "HJ", "CO", "UTG1", "UTG2", "MP", "X",
        ];
        let players: Vec<Value> = stacks
            .iter()
            .enumerate()
            .map(|(i, s)| json!({ "seat": i + 1, "position": positions[i], "isHero": i == 0, "startingStack": s }))
            .collect();
        let actions: Vec<Value> = folds
            .iter()
            .map(|s| json!({ "street": "preflop", "type": "fold", "seat": s }))
            .collect();
        json!({
            "game": { "variant": "holdem", "limit": "nl", "format": "cash", "bigBlind": 2 },
            "players": players,
            "actions": actions,
        })
    }

    #[test]
    fn table_by_players_and_depth() {
        assert_eq!(
            hand_table_set(&hand(&[200, 200], &[])),
            "nlhe-cash-hu-100bb"
        );
        assert_eq!(
            hand_table_set(&hand(&[300, 290], &[])),
            "nlhe-cash-hu-150bb"
        );
        assert_eq!(
            hand_table_set(&hand(&[200; 6], &[])),
            "nlhe-cash-6max-100bb"
        );
        assert_eq!(
            hand_table_set(&hand(&[200, 200, 200], &[])),
            "nlhe-cash-6max-100bb"
        );
        assert_eq!(
            hand_table_set(&hand(&[200; 9], &[])),
            "nlhe-cash-9max-100bb"
        );
        // A deep opponent still in raises the effective stack; folded, he does not.
        let mut deep = vec![400; 1];
        deep.extend([200, 200, 200, 200, 800]);
        assert_eq!(hand_table_set(&hand(&deep, &[])), "nlhe-cash-6max-200bb");
        assert_eq!(hand_table_set(&hand(&deep, &[6])), "nlhe-cash-6max-100bb");
        // 120bb is 20% from both heads-up depths: inside both, the first wins.
        assert_eq!(
            hand_table_set(&hand(&[240, 240], &[])),
            "nlhe-cash-hu-100bb"
        );
        // Unstated stacks read 100bb.
        let mut no_stacks = hand(&[1, 1], &[]);
        for p in no_stacks["players"].as_array_mut().expect("players") {
            p.as_object_mut().expect("a player").remove("startingStack");
        }
        assert_eq!(hand_table_set(&no_stacks), "nlhe-cash-hu-100bb");
    }

    #[test]
    fn no_set() {
        assert_eq!(hand_table_set(&hand(&[200; 10], &[])), "");
        assert_eq!(hand_table_set(&hand(&[600, 600], &[])), "");
        assert_eq!(hand_table_set(&hand(&[20; 6], &[])), "");
        let mut tournament = hand(&[200; 6], &[]);
        tournament["game"]["format"] = json!("tournament");
        assert_eq!(hand_table_set(&tournament), "");
        let mut straddle = hand(&[200; 6], &[]);
        straddle["actions"] = json!([{ "street": "preflop", "type": "straddle", "seat": 4 }]);
        assert_eq!(hand_table_set(&straddle), "");
        let mut no_hero = hand(&[200; 6], &[]);
        no_hero["players"][0]["isHero"] = json!(false);
        assert_eq!(hand_table_set(&no_hero), "");
        let mut no_bb = hand(&[200; 6], &[]);
        no_bb["game"]["bigBlind"] = json!(0);
        assert_eq!(hand_table_set(&no_bb), "");
        assert_eq!(hand_table_set(&json!(null)), "");
    }
}

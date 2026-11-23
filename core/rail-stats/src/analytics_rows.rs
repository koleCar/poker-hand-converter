//! The Analytics checker rows (docs/ANALYTICS.md Step 2): what the stat
//! checker needs from each analysed decision, one row per (decision, rate it
//! belongs to). The desktop's store derives them here when it saves a hand's
//! analysis and in its backfill over the stored PHF
//! (`rail_store::checker`); the web derives them in the browser with the
//! TypeScript twin, `web/src/lib/stats/analyticsRows.ts`, line for line.
//! `tests/analytics_rows.rs` and `tests/test/analyticsRows.test.ts` hold
//! both to the same fixture (`tests/data/analytics/rows/`).
//!
//! A row holds the rate and whether the decision took its class
//! ([`Catalogue::membership`], the hero's entry), the reference's share of
//! the class (Σ of its options' frequencies) and whether its best option is
//! in the class (both `None` for a decision without options), the EV loss
//! (0 without one), the size bucket of the bet faced after the flop, the
//! hand class, the spot (`pot|role|hero|opponent`) and whether the scenario
//! is multiway. See the TypeScript module's docs for each field.
//!
//! Rounding: the share to 6 decimals and the EV loss to 3, half away from
//! zero, in both languages.

use serde::Serialize;
use serde_json::Value;

use crate::analytics::{Catalogue, StatKind};
use crate::events::HandEvents;
use rail_core::phf::{ActionType, Position, Street};

/// One stored decision, as far as the rows read it (the web's
/// `DecisionAnalysisInsert`, the store's `DecisionRowIn`).
#[derive(Debug, Clone, Copy)]
pub struct RowsDecision<'a> {
    pub ord: i64,
    pub action_index: i64,
    pub status: &'a str,
    /// The JSON array of options (`action`, `freq`, `ev`).
    pub options: &'a Value,
    pub ev_loss_bb: Option<f64>,
    /// The decision's facts (`SpotFacts`).
    pub facts: &'a Value,
}

/// One checker row.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsRow {
    pub ord: i64,
    pub action_index: i64,
    pub stat: String,
    pub taken: bool,
    pub ref_share: Option<f64>,
    pub best_in: Option<bool>,
    pub ev_loss_bb: f64,
    pub size: String,
    pub hand_class: String,
    pub spot: String,
    pub multiway: bool,
}

/// `x` to `places` decimals, half away from zero.
#[allow(clippy::float_arithmetic)] // the analysis' numbers are floats (JSON)
pub fn round_half_away(x: f64, places: i32) -> f64 {
    let scale = 10_f64.powi(places);
    (x * scale).round() / scale
}

/// A position as the PHF writes it (`BTN`, `UTG+1`, ...).
pub const fn position_name(position: Position) -> &'static str {
    match position {
        Position::Btn => "BTN",
        Position::Sb => "SB",
        Position::Bb => "BB",
        Position::Utg => "UTG",
        Position::Utg1 => "UTG+1",
        Position::Utg2 => "UTG+2",
        Position::Mp => "MP",
        Position::Lj => "LJ",
        Position::Hj => "HJ",
        Position::Co => "CO",
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// The action of the best option: highest EV, then higher frequency, then
/// first listed (`analysis_best_action`).
pub fn best_option(options: &[Value]) -> Option<&str> {
    let mut best: Option<(&str, Option<f64>, Option<f64>)> = None;
    for option in options {
        let Some(action) = option.get("action").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(action, "fold" | "check" | "call" | "bet" | "raise") {
            continue;
        }
        let candidate = (action, number(option.get("ev")), number(option.get("freq")));
        match best {
            None => best = Some(candidate),
            Some(current) => {
                let ev = compare_desc(candidate.1, current.1);
                if ev < 0 || (ev == 0 && compare_desc(candidate.2, current.2) < 0) {
                    best = Some(candidate);
                }
            }
        }
    }
    best.map(|(action, _, _)| action)
}

/// < 0 when `a` sorts before `b` in "descending, nulls last".
fn compare_desc(a: Option<f64>, b: Option<f64>) -> i8 {
    match (a, b) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(a), Some(b)) => {
            if a > b {
                -1
            } else if a < b {
                1
            } else {
                0
            }
        }
    }
}

/// The pot of a postflop decision: `bomb`, else by the preflop raises.
pub const fn pot_of(hand: &HandEvents) -> &'static str {
    if hand.bomb_pot {
        return "bomb";
    }
    match hand.preflop_raises {
        0 => "limped",
        1 => "single-raised",
        2 => "3bet",
        _ => "4bet+",
    }
}

/// The opponent of the hero's decision `order` on `street` (the
/// TypeScript `opponentOf`).
pub fn opponent_of(hand: &HandEvents, hero_seat: u32, order: usize, street: Street) -> String {
    let mut aggressor: Option<(usize, &'static str)> = None;
    let mut live: Vec<&'static str> = Vec::new();
    for seat in &hand.seats {
        if seat.seat == hero_seat {
            continue;
        }
        let position = seat.position.map_or("", position_name);
        let mut folded = false;
        for event in &seat.events {
            if event.order >= order {
                continue;
            }
            if event.action == ActionType::Fold {
                folded = true;
            }
            if event.street == street
                && matches!(event.action, ActionType::Bet | ActionType::Raise)
                && aggressor.is_none_or(|(at, _)| event.order > at)
            {
                aggressor = Some((event.order, position));
            }
        }
        if !folded {
            live.push(position);
        }
    }
    if let Some((_, position)) = aggressor {
        return position.to_owned();
    }
    if street == Street::Preflop {
        return String::new();
    }
    match live.as_slice() {
        [] => String::new(),
        [one] => (*one).to_owned(),
        _ => "multi".to_owned(),
    }
}

/// A decision's spot: `pot|role|hero|opponent`.
pub fn spot_key(pot: &str, role: &str, hero: &str, opponent: &str) -> String {
    format!("{pot}|{role}|{hero}|{opponent}")
}

/// The checker rows of one hand (the TypeScript `analyticsRows`): one per
/// (hero decision, rate it belongs to), in decision order then catalogue
/// order. A member decision without a stored decision is left out.
#[allow(clippy::float_arithmetic)] // Σ of the reference's frequencies (JSON floats)
pub fn analytics_rows(
    catalogue: &Catalogue,
    hand: &HandEvents,
    decisions: &[RowsDecision<'_>],
) -> Vec<AnalyticsRow> {
    let Some(hero) = hand.seats.iter().find(|seat| seat.hero) else {
        return Vec::new();
    };
    let membership: std::collections::BTreeMap<usize, Vec<(usize, bool)>> = catalogue
        .membership(hand)
        .into_iter()
        .filter(|entry| entry.seat == hero.seat)
        .map(|entry| (entry.order, entry.stats))
        .collect();
    let mut sorted: Vec<&RowsDecision<'_>> = decisions.iter().collect();
    sorted.sort_by_key(|decision| decision.ord);
    let hero_position = hero.position.map_or("", position_name);
    let mut rows = Vec::new();
    for decision in sorted {
        let Ok(order) = usize::try_from(decision.ord) else {
            continue;
        };
        let Some(stats) = membership.get(&order) else {
            continue;
        };
        let Some(street) = hero
            .events
            .iter()
            .find(|event| event.order == order)
            .map(|event| event.street)
        else {
            continue;
        };
        let facts = decision.facts;
        let text = |key: &str| facts.get(key).and_then(Value::as_str).unwrap_or("");
        let preflop = street == Street::Preflop;
        let options: &[Value] = decision.options.as_array().map_or(&[], Vec::as_slice);
        let analysed = decision.status == "analysed" && !options.is_empty();
        let best = if analysed { best_option(options) } else { None };
        let spot = spot_key(
            if preflop { "" } else { pot_of(hand) },
            text(if preflop { "preflopScenario" } else { "role" }),
            hero_position,
            &opponent_of(hand, hero.seat, order, street),
        );
        let size = if preflop {
            String::new()
        } else {
            catalogue
                .size_bucket(number(facts.get("facingPot")))
                .map(|bucket| bucket.id.clone())
                .unwrap_or_default()
        };
        let hand_class = if preflop {
            String::new()
        } else {
            let made = facts
                .get("made")
                .and_then(|made| made.get("class"))
                .and_then(Value::as_str);
            let draws: Vec<&str> = facts
                .get("draws")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            catalogue
                .hand_class(made, &draws)
                .map(|class| class.id.clone())
                .unwrap_or_default()
        };
        let ev_loss_bb = round_half_away(
            decision.ev_loss_bb.filter(|x| x.is_finite()).unwrap_or(0.0),
            3,
        );
        let multiway = text("scenario").contains("-mw-");
        for &(index, taken) in stats {
            let Some(stat) = catalogue.stats.get(index) else {
                continue;
            };
            let StatKind::Rate { class, .. } = &stat.kind else {
                continue;
            };
            let ref_share = analysed.then(|| {
                let sum = options
                    .iter()
                    .filter(|option| {
                        option
                            .get("action")
                            .and_then(Value::as_str)
                            .is_some_and(|action| catalogue.in_class(*class, action))
                    })
                    .filter_map(|option| number(option.get("freq")))
                    .fold(0.0, |sum, freq| sum + freq);
                round_half_away(sum, 6)
            });
            rows.push(AnalyticsRow {
                ord: decision.ord,
                action_index: decision.action_index,
                stat: stat.id.clone(),
                taken,
                ref_share,
                best_in: analysed
                    .then(|| best.is_some_and(|best| catalogue.in_class(*class, best))),
                ev_loss_bb,
                size: size.clone(),
                hand_class: hand_class.clone(),
                spot: spot.clone(),
                multiway,
            });
        }
    }
    rows
}

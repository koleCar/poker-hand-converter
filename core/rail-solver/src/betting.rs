//! No-limit betting trees from a bet-size menu (`betting.ts`), rule for rule:
//! the minimum bet and raise, sizes at or near the stack become all-in, sizes
//! landing on the same amount merge, a raise cap per street. Labels are the
//! stats engine's letters with the street total (`B6.5`, `R20`).

use std::collections::HashMap;

use crate::SolverInputError;
use crate::cards::card_code;
use crate::js::{math_round, number_to_string};
use crate::tree::{Edge, Rake, TreeBuilder};

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BetMenu {
    pub bet: Vec<f64>,
    pub raise: Vec<f64>,
    pub all_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all_in_max_pot: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BettingRules {
    pub menus: [BetMenu; 2],
    pub raise_cap: u32,
    pub all_in_threshold: f64,
    pub min_bet: f64,
    /// A node's own actions by its path (`nodeActions`): labels offered in
    /// place of the menu's (a nodelock's custom sizes), see [`node_actions_of`].
    pub node_actions: Option<std::collections::BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Fold,
    Check,
    Call,
    Bet,
    Raise,
    AllIn,
}

impl ActionKind {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Fold => "fold",
            Self::Check => "check",
            Self::Call => "call",
            Self::Bet => "bet",
            Self::Raise => "raise",
            Self::AllIn => "allin",
        }
    }

    fn letter(self) -> &'static str {
        match self {
            Self::Fold => "F",
            Self::Check => "X",
            Self::Call => "C",
            Self::Bet => "B",
            Self::Raise => "R",
            Self::AllIn => "A",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionInfo {
    pub label: String,
    pub kind: ActionKind,
    pub amount: f64,
    pub to: f64,
    pub size_pot: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Street {
    Flop,
    Turn,
    River,
}

impl Street {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Flop => "flop",
            Self::Turn => "turn",
            Self::River => "river",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeInfo {
    pub street: Street,
    pub path: String,
    pub pot: f64,
    pub to_call: f64,
    pub behind: f64,
    pub actions: Vec<ActionInfo>,
}

/// The tree under construction plus the node info a result reads.
#[derive(Debug, Default)]
pub struct Build {
    pub builder: TreeBuilder,
    pub info: HashMap<usize, NodeInfo>,
    /// The first node whose own actions were not legal (`node_actions_of`);
    /// the game's builder returns it. That node keeps the menu's actions.
    pub error: Option<SolverInputError>,
}

/// One street's fixed context (`StreetContext` without the closure).
#[derive(Debug, Clone, Copy)]
pub struct StreetParams<'a> {
    pub street: Street,
    pub pot: f64,
    pub stack: f64,
    pub rake: Option<&'a Rake>,
    pub first: u8,
    pub rules: &'a BettingRules,
    /// Keep node info (a flop game keeps only the flop's).
    pub record_info: bool,
}

const EPS: f64 = 1e-9;

/// At most two decimals, no trailing zeros (`formatAmount`).
#[must_use]
pub fn format_amount(x: f64) -> String {
    number_to_string(math_round(x * 100.0) / 100.0)
}

/// Path segment for a dealt card (`dealtPath`).
#[must_use]
pub fn dealt_path(path: &str, card: u8) -> String {
    format!("{path}|{}|", card_code(card))
}

/// What closes a street: `(state, c0, c1, all_in, path) -> node`.
pub type Close<'c, S> = dyn FnMut(&mut S, f64, f64, bool, &str) -> usize + 'c;

/// Builds one street of betting (`buildStreet`); returns its first node.
pub fn build_street<S: AsMut<Build>>(
    state: &mut S,
    params: &StreetParams<'_>,
    base: [f64; 2],
    path: &str,
    close: &mut Close<'_, S>,
) -> usize {
    street_node(
        state,
        params,
        base,
        close,
        [0.0, 0.0],
        params.first,
        0,
        0.0,
        false,
        path,
    )
}

fn join(at: &str, label: &str) -> String {
    if at.is_empty() || at.ends_with('|') {
        format!("{at}{label}")
    } else {
        format!("{at}-{label}")
    }
}

fn street_node<S: AsMut<Build>>(
    state: &mut S,
    params: &StreetParams<'_>,
    base: [f64; 2],
    close: &mut Close<'_, S>,
    street: [f64; 2],
    to_act: u8,
    raises: u32,
    last_increment: f64,
    checked: bool,
    at: &str,
) -> usize {
    let rules = params.rules;
    let (stack, pot, rake) = (params.stack, params.pot, params.rake);
    let me = usize::from(to_act);
    let op = 1 - me;
    let total0 = base[0] + street[0];
    let total1 = base[1] + street[1];
    let pot_now = pot + total0 + total1;
    let behind_me = stack - (base[me] + street[me]);
    let behind_op = stack - (base[op] + street[op]);
    let to_call = street[op] - street[me];
    let menu = &rules.menus[me];
    let mut edges: Vec<Edge> = Vec::new();
    let mut actions: Vec<ActionInfo> = Vec::new();

    let sized = |fractions: &[f64],
                 amount_of: &dyn Fn(f64) -> f64,
                 floor: f64,
                 pots_of: &dyn Fn(f64) -> f64| {
        let max_amount = behind_me;
        let mut out: Vec<(String, f64)> = Vec::new();
        let mut push = |amount: f64| {
            let a = amount.max(floor).min(max_amount);
            let raise_to = street[me] + a;
            let after_call = pot_now + a + (raise_to - street[op]);
            let all_in =
                max_amount - a <= EPS || max_amount - a < rules.all_in_threshold * after_call;
            let fin = if all_in { max_amount } else { a };
            let key = format_amount(street[me] + fin);
            if let Some(slot) = out.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = fin;
            } else {
                out.push((key, fin));
            }
        };
        for &x in fractions {
            push(amount_of(x));
        }
        if menu.all_in
            && !(pots_of(max_amount) > menu.all_in_max_pot.unwrap_or(f64::INFINITY) + EPS)
        {
            push(max_amount);
        }
        let mut values: Vec<f64> = out.into_iter().map(|(_, v)| v).collect();
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        values
    };

    let describe = |kind: ActionKind, amount: f64, size_pot: f64| {
        let to = street[me] + amount;
        let label = match kind {
            ActionKind::Bet | ActionKind::Raise | ActionKind::AllIn => {
                format!("{}{}", kind.letter(), format_amount(to))
            }
            _ => kind.letter().to_owned(),
        };
        ActionInfo {
            label,
            kind,
            amount,
            to,
            size_pot,
        }
    };

    // The menu's actions, then the node's own in their place where it has them.
    let mut planned: Vec<ActionInfo> = Vec::new();
    if to_call > EPS {
        planned.push(describe(ActionKind::Fold, 0.0, 0.0));
        planned.push(describe(ActionKind::Call, to_call.min(behind_me), 0.0));
        if raises < rules.raise_cap && behind_op > EPS && behind_me > to_call + EPS {
            let pot_after_call = pot_now + to_call;
            let floor = to_call + last_increment.max(rules.min_bet);
            let amounts = sized(
                &menu.raise,
                &|x| to_call + x * pot_after_call,
                floor,
                &|amount| (amount - to_call) / pot_after_call,
            );
            for amount in amounts {
                let kind = if behind_me - amount <= EPS {
                    ActionKind::AllIn
                } else {
                    ActionKind::Raise
                };
                planned.push(describe(kind, amount, (amount - to_call) / pot_after_call));
            }
        }
    } else {
        planned.push(describe(ActionKind::Check, 0.0, 0.0));
        if behind_me > EPS {
            let amounts = sized(&menu.bet, &|x| x * pot_now, rules.min_bet, &|amount| {
                amount / pot_now
            });
            for amount in amounts {
                let kind = if behind_me - amount <= EPS {
                    ActionKind::AllIn
                } else {
                    ActionKind::Bet
                };
                planned.push(describe(kind, amount, amount / pot_now));
            }
        }
    }
    if let Some(own) = rules.node_actions.as_ref().and_then(|m| m.get(at)) {
        let stand = NodeStand {
            street: street[me],
            to_call,
            behind: behind_me,
            pot: pot_now,
        };
        match node_actions_of(at, own, &planned, &stand) {
            Ok(list) => planned = list,
            Err(e) => {
                let build = state.as_mut();
                if build.error.is_none() {
                    build.error = Some(e);
                }
            }
        }
    }

    for info in planned {
        let child_path = join(at, &info.label);
        let child = match info.kind {
            ActionKind::Fold => state
                .as_mut()
                .builder
                .fold(to_act, pot, total0, total1, rake),
            ActionKind::Call => {
                let mut c = [total0, total1];
                c[me] += info.amount;
                let all_in = stack - c[me] <= EPS || behind_op <= EPS;
                close(state, c[0], c[1], all_in, &child_path)
            }
            ActionKind::Check => {
                if checked {
                    close(state, total0, total1, false, &child_path)
                } else {
                    street_node(
                        state,
                        params,
                        base,
                        close,
                        street,
                        op as u8,
                        raises,
                        last_increment,
                        true,
                        &child_path,
                    )
                }
            }
            ActionKind::Bet | ActionKind::Raise | ActionKind::AllIn => {
                let mut next = street;
                next[me] += info.amount;
                let (raises_next, increment) = if to_call > EPS {
                    (raises + 1, next[me] - street[op])
                } else {
                    (raises, info.amount)
                };
                street_node(
                    state,
                    params,
                    base,
                    close,
                    next,
                    op as u8,
                    raises_next,
                    increment,
                    checked,
                    &child_path,
                )
            }
        };
        edges.push(Edge {
            label: info.label.clone(),
            child,
            card: None,
        });
        actions.push(info);
    }

    let build = state.as_mut();
    let id = build.builder.action(to_act, &edges);
    if params.record_info {
        build.info.insert(
            id,
            NodeInfo {
                street: params.street,
                path: at.to_owned(),
                pot: pot_now,
                to_call: to_call.max(0.0),
                behind: behind_me,
                actions,
            },
        );
    }
    id
}

/// Where a node stands, for its own actions (`NodeStand`).
#[derive(Debug, Clone, Copy)]
pub struct NodeStand {
    pub street: f64,
    pub to_call: f64,
    pub behind: f64,
    pub pot: f64,
}

/// A node's own actions from their labels (`nodeActionsOf`): a label among
/// the menu's keeps the menu's action, exact amount included; another is
/// read off the label (`B8.25` bets to 8.25, `A100` is all-in).
///
/// # Errors
/// A label that is not legal at the node, as the TypeScript words it.
pub fn node_actions_of(
    path: &str,
    labels: &[String],
    menu: &[ActionInfo],
    at: &NodeStand,
) -> Result<Vec<ActionInfo>, SolverInputError> {
    let where_ = if path.is_empty() { "the root" } else { path };
    let fail = |label: &str, why: &str| -> SolverInputError {
        SolverInputError(format!("{where_}: {label} {why}"))
    };
    if labels.is_empty() {
        return Err(fail("(none)", "leaves the node without an action"));
    }
    let facing = at.to_call > EPS;
    let mut out: Vec<ActionInfo> = Vec::with_capacity(labels.len());
    for label in labels {
        if out.iter().any(|a| &a.label == label) {
            return Err(fail(label, "is there twice"));
        }
        if let Some(known) = menu.iter().find(|a| &a.label == label) {
            out.push(known.clone());
            continue;
        }
        let letter = label.chars().next().unwrap_or(' ');
        let info = |kind: ActionKind, amount: f64, size_pot: f64| ActionInfo {
            label: label.clone(),
            kind,
            amount,
            to: at.street + amount,
            size_pot,
        };
        if matches!(letter, 'X' | 'F' | 'C') {
            if label.len() > 1 {
                return Err(fail(label, "is not an action"));
            }
            if (letter == 'X') == facing {
                return Err(fail(
                    label,
                    if facing {
                        "faces a bet"
                    } else {
                        "has no bet to answer"
                    },
                ));
            }
            out.push(match letter {
                'X' => info(ActionKind::Check, 0.0, 0.0),
                'F' => info(ActionKind::Fold, 0.0, 0.0),
                _ => info(ActionKind::Call, at.to_call.min(at.behind), 0.0),
            });
            continue;
        }
        let to: f64 = label[1..].parse().unwrap_or(f64::NAN);
        if !matches!(letter, 'B' | 'R' | 'A') || !to.is_finite() {
            return Err(fail(label, "is not an action"));
        }
        let amount = to - at.street;
        let size_pot = |a: f64| {
            if facing {
                (a - at.to_call) / (at.pot + at.to_call)
            } else {
                a / at.pot
            }
        };
        if letter == 'A' {
            if (amount - at.behind).abs() > 0.006 {
                return Err(fail(
                    label,
                    &format!("is not all-in ({})", format_amount(at.street + at.behind)),
                ));
            }
            out.push(info(ActionKind::AllIn, at.behind, size_pot(at.behind)));
            continue;
        }
        if (letter == 'R') != facing {
            return Err(fail(
                label,
                if facing {
                    "is a bet facing a bet"
                } else {
                    "raises no bet"
                },
            ));
        }
        if !(amount > (if facing { at.to_call } else { 0.0 }) + EPS) {
            return Err(fail(label, "is too small"));
        }
        if facing && amount - at.to_call < at.to_call - 0.006 {
            return Err(fail(label, "raises less than the minimum"));
        }
        if !(amount < at.behind - EPS) {
            return Err(fail(label, "is the stack or more: that is all-in"));
        }
        let kind = if facing {
            ActionKind::Raise
        } else {
            ActionKind::Bet
        };
        out.push(info(kind, amount, size_pot(amount)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_format_like_the_typescript() {
        assert_eq!(format_amount(6.5), "6.5");
        assert_eq!(format_amount(20.0), "20");
        assert_eq!(format_amount(10.0 / 3.0), "3.33");
        assert_eq!(format_amount(1.005), "1");
        assert_eq!(format_amount(2.675), "2.68");
    }
}

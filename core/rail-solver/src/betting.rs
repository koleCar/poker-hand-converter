//! No-limit betting trees from a bet-size menu (`betting.ts`), rule for rule:
//! the minimum bet and raise, sizes at or near the stack become all-in, sizes
//! landing on the same amount merge, a raise cap per street. Labels are the
//! stats engine's letters with the street total (`B6.5`, `R20`).

use std::collections::HashMap;

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

    if to_call > EPS {
        let fold = describe(ActionKind::Fold, 0.0, 0.0);
        let child = state
            .as_mut()
            .builder
            .fold(to_act, pot, total0, total1, rake);
        edges.push(Edge {
            label: fold.label.clone(),
            child,
            card: None,
        });
        actions.push(fold);

        let call = describe(ActionKind::Call, to_call.min(behind_me), 0.0);
        let mut c = [total0, total1];
        c[me] += call.amount;
        let all_in = stack - c[me] <= EPS || behind_op <= EPS;
        let call_path = join(at, &call.label);
        let child = close(state, c[0], c[1], all_in, &call_path);
        edges.push(Edge {
            label: call.label.clone(),
            child,
            card: None,
        });
        actions.push(call);

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
                let info = describe(kind, amount, (amount - to_call) / pot_after_call);
                let mut next = street;
                next[me] += amount;
                let increment = next[me] - street[op];
                let child_path = join(at, &info.label);
                let child = street_node(
                    state,
                    params,
                    base,
                    close,
                    next,
                    op as u8,
                    raises + 1,
                    increment,
                    checked,
                    &child_path,
                );
                edges.push(Edge {
                    label: info.label.clone(),
                    child,
                    card: None,
                });
                actions.push(info);
            }
        }
    } else {
        let check = describe(ActionKind::Check, 0.0, 0.0);
        let check_path = join(at, &check.label);
        let child = if checked {
            close(state, total0, total1, false, &check_path)
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
                &check_path,
            )
        };
        edges.push(Edge {
            label: check.label.clone(),
            child,
            card: None,
        });
        actions.push(check);
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
                let info = describe(kind, amount, amount / pot_now);
                let mut next = street;
                next[me] += amount;
                let child_path = join(at, &info.label);
                let child = street_node(
                    state,
                    params,
                    base,
                    close,
                    next,
                    op as u8,
                    raises,
                    amount,
                    checked,
                    &child_path,
                );
                edges.push(Edge {
                    label: info.label.clone(),
                    child,
                    card: None,
                });
                actions.push(info);
            }
        }
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

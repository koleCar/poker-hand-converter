//! A node's own actions (`nodeActions`): a nodelock's custom sizes build
//! their own tree, labels the menu gives keep the menu's exact amounts, and
//! a label that is not legal at the node is an input error.

#![allow(clippy::float_arithmetic, clippy::unwrap_used)]

use rail_solver::subgame::{SpotInput, build_river_game};

fn spot(node_actions: Option<serde_json::Value>) -> SpotInput {
    let range = |k: usize| -> Vec<f64> {
        (0..1326)
            .map(|i| if i % 7 == k { 1.0 } else { 0.0 })
            .collect()
    };
    let mut json = serde_json::json!({
        "board": ["Ks", "5h", "3s", "7d", "2c"],
        "ranges": [range(0), range(3)],
        "pot": 10.0,
        "stack": 50.0,
        "menus": [
            { "bet": [0.33, 0.75], "raise": [1.0], "allIn": true },
            { "bet": [0.5], "raise": [1.0], "allIn": true }
        ]
    });
    if let Some(n) = node_actions {
        json["nodeActions"] = n;
    }
    serde_json::from_value(json).unwrap()
}

fn labels_at(spot: &SpotInput, path: &str) -> Vec<String> {
    let built = build_river_game(spot).unwrap();
    let info = built.info.values().find(|i| i.path == path).unwrap();
    info.actions.iter().map(|a| a.label.clone()).collect()
}

#[test]
fn the_menu_tree_is_unchanged_without_node_actions() {
    assert_eq!(labels_at(&spot(None), ""), ["X", "B3.3", "B7.5", "A50"]);
}

#[test]
fn a_node_offers_its_own_actions() {
    let own = serde_json::json!({ "": ["X", "B15", "A50"], "X": ["B2"] });
    let s = spot(Some(own));
    assert_eq!(labels_at(&s, ""), ["X", "B15", "A50"]);
    // Taking the check away: BTN must bet.
    assert_eq!(labels_at(&s, "X"), ["B2"]);
    // Below a custom size the menu applies again.
    assert_eq!(labels_at(&s, "B15"), ["F", "C", "A50"]);
    let built = build_river_game(&s).unwrap();
    let b15 = built.info.values().find(|i| i.path == "B15").unwrap();
    assert!((b15.to_call - 15.0).abs() < 1e-9);
}

#[test]
fn the_menu_labels_keep_the_menu_amounts() {
    let s = spot(Some(
        serde_json::json!({ "": ["X", "B3.3", "B7.5", "A50"] }),
    ));
    let a = build_river_game(&spot(None)).unwrap();
    let b = build_river_game(&s).unwrap();
    assert_eq!(a.game.tree.size, b.game.tree.size);
    assert_eq!(a.game.tree.payoff, b.game.tree.payoff);
}

#[test]
fn illegal_labels_are_input_errors() {
    for (labels, why) in [
        (serde_json::json!(["C", "B5"]), "has no bet to answer"),
        (serde_json::json!(["X", "R20"]), "raises no bet"),
        (serde_json::json!(["X", "A40"]), "is not all-in"),
        (serde_json::json!(["X", "B60"]), "is the stack or more"),
        (serde_json::json!(["X", "X"]), "is there twice"),
        (serde_json::json!([]), "without an action"),
    ] {
        let err = build_river_game(&spot(Some(serde_json::json!({ "": labels })))).unwrap_err();
        assert!(err.0.contains(why), "{} does not say {why}", err.0);
    }
}

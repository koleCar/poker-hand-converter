//! `tests/test/support/psggCorpus.ts` and `psggInvariants.ts`: the corpus
//! loaders and the invariants the PokerStars and GGPoker suites assert over
//! every hand.
//!
//! The loaders read files the way those suites do - `readFileSync(path,
//! "utf8")`, which keeps a BOM and every line ending and replaces invalid
//! UTF-8 - not through `decodeSource`.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rail_core::detect::{
    ConvertOptions, PINNED_PARSED_AT, ParseError, SiteParser, SiteParserContext,
};
use rail_core::phf::serialize::{StandardContext, parse_standard_hand, to_standard_text};
use rail_core::phf::{ActionType, PhfHand, house_into_pot, resolve_runout, total_fees};

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `CorpusFile`.
#[derive(Debug, Clone)]
pub struct CorpusFile {
    /// File name only.
    pub name: String,
    /// Path relative to the repository root.
    pub relative_path: String,
    pub text: String,
}

/// `readTree(dir, prefix)`: every `.txt` below `dir`, sorted, recursively.
pub fn read_tree(dir: &Path, prefix: &str) -> Vec<CorpusFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
        .into_iter()
        .flat_map(|name| {
            let path = dir.join(&name);
            if path.is_dir() {
                return read_tree(&path, &format!("{prefix}/{name}"));
            }
            if !name.ends_with(".txt") {
                return Vec::new();
            }
            let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            vec![CorpusFile {
                relative_path: format!("{prefix}/{name}"),
                name,
                text: String::from_utf8_lossy(&bytes).into_owned(),
            }]
        })
        .collect()
}

/// `sampleFiles(site)`: `fixtures/samples/<site>/`.
pub fn sample_files(site: &str) -> Vec<CorpusFile> {
    read_tree(
        &root().join("fixtures/samples").join(site),
        &format!("fixtures/samples/{site}"),
    )
}

/// `ownFixtures(site)`: `tests/test/fixtures/<site>/`.
pub fn own_fixtures(site: &str) -> Vec<CorpusFile> {
    read_tree(
        &root().join("tests/test/fixtures").join(site),
        &format!("tests/test/fixtures/{site}"),
    )
}

/// `ggCorpusFiles()`: `gg-hh/`.
pub fn gg_corpus_files() -> Vec<CorpusFile> {
    read_tree(&root().join("gg-hh"), "gg-hh")
}

/// `FOREIGN_SITES`.
pub const FOREIGN_SITES: [&str; 12] = [
    "888poker",
    "bossmedia",
    "coinpoker",
    "entraction",
    "ipoker",
    "merge",
    "microgaming",
    "ongame",
    "partypoker",
    "unibet",
    "weplay",
    "wpt-global",
];

/// `{ sourceFilename: null, options: {} }`.
pub fn parse(parser: &dyn SiteParser, raw: &str) -> Result<PhfHand, ParseError> {
    parse_with(parser, raw, &ConvertOptions::default())
}

pub fn parse_with(
    parser: &dyn SiteParser,
    raw: &str,
    options: &ConvertOptions,
) -> Result<PhfHand, ParseError> {
    parser.parse_hand(
        raw,
        &SiteParserContext {
            source_filename: None,
            options,
        },
    )
}

/// `{ siteId: "standard", siteName: "standard", originalFilename: null }`.
pub const STANDARD: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: PINNED_PARSED_AT,
};

pub fn validates(hand: &PhfHand) -> bool {
    rail_core::validate::validate_hand(hand)
        .expect("validateHand threw")
        .ok()
}

pub fn error_codes(hand: &PhfHand) -> Vec<String> {
    rail_core::validate::validate_hand(hand)
        .expect("validateHand threw")
        .errors()
        .map(|p| p.code.clone())
        .collect()
}

/* ------------------------------------------------------------ invariants */

/// One minor unit of slack, the validator's tolerance.
const TOLERANCE: i64 = 1;

/// `BLIND_SPOT_CODES`.
const BLIND_SPOT_CODES: [&str; 3] = ["unknown-line", "unknown-summary-line", "dealt-to-unseated"];

pub fn blind_spots(hand: &PhfHand) -> Vec<String> {
    hand.meta
        .warnings
        .iter()
        .filter(|w| BLIND_SPOT_CODES.contains(&w.code.as_str()))
        .map(|w| format!("{} {}: {}", hand.meta.hand_id, w.code, w.message))
        .collect()
}

pub fn chip_conservation(hand: &PhfHand) -> Vec<String> {
    let total = hand
        .actions
        .iter()
        .filter(|a| a.kind != ActionType::Collect)
        .fold(house_into_pot(hand), |sum, a| sum + a.amount);
    if (total - hand.results.total_pot).abs() > TOLERANCE {
        vec![format!(
            "{}: players and house put in {total}, pot is {}",
            hand.meta.hand_id, hand.results.total_pot
        )]
    } else {
        Vec::new()
    }
}

pub fn no_negative_stacks(hand: &PhfHand) -> Vec<String> {
    let mut stacks: HashMap<&str, i64> = hand
        .players
        .iter()
        .map(|p| (p.name.as_str(), p.starting_stack))
        .collect();
    for movement in hand.chip_movements.iter().flatten() {
        if !movement.to_pot
            && let Some(from) = &movement.from_player
            && let Some(stack) = stacks.get_mut(from.as_str())
        {
            *stack -= movement.amount;
        }
    }
    let mut problems = Vec::new();
    for action in &hand.actions {
        if action.kind == ActionType::Collect || action.amount == 0 {
            continue;
        }
        let Some(stack) = stacks.get_mut(action.player.as_str()) else {
            continue;
        };
        *stack -= action.amount;
        if *stack < -TOLERANCE {
            problems.push(format!(
                "{}: {} at {} after \"{}\"",
                hand.meta.hand_id, action.player, *stack, action.raw_line
            ));
        }
    }
    problems
}

pub fn pot_fully_awarded(hand: &PhfHand) -> Vec<String> {
    let out: i64 = hand
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::Collect)
        .map(|a| a.amount)
        .sum();
    if out == 0 {
        return Vec::new();
    }
    let fees = total_fees(&hand.results.fees);
    let net = (out + fees - hand.results.total_pot).abs() <= TOLERANCE;
    let gross = (out - hand.results.total_pot).abs() <= TOLERANCE;
    if net || gross {
        Vec::new()
    } else {
        vec![format!(
            "{}: collected {out} + fees {fees} != pot {}",
            hand.meta.hand_id, hand.results.total_pot
        )]
    }
}

pub fn uncalled_within_commitment(hand: &PhfHand) -> Vec<String> {
    let mut problems = Vec::new();
    let mut key = None;
    let mut commit: HashMap<&str, i64> = HashMap::new();
    for action in &hand.actions {
        let action_key = Some((action.street, action.runout_index));
        if action_key != key {
            key = action_key;
            commit.clear();
        }
        let committed = commit.get(action.player.as_str()).copied().unwrap_or(0);
        if action.kind == ActionType::Uncalled && -action.amount > committed + TOLERANCE {
            problems.push(format!(
                "{}: {} returned {} of {committed}",
                hand.meta.hand_id, action.player, -action.amount
            ));
        }
        commit.insert(action.player.as_str(), committed + action.amount);
    }
    problems
}

pub fn seats_and_cards(hand: &PhfHand) -> Vec<String> {
    let mut problems = Vec::new();
    let seated: HashSet<&str> = hand.players.iter().map(|p| p.name.as_str()).collect();
    for action in &hand.actions {
        if !seated.contains(action.player.as_str()) {
            problems.push(format!(
                "{}: \"{}\" acts but is not seated",
                hand.meta.hand_id, action.player
            ));
        }
    }
    let mut cards: Vec<String> = hand
        .players
        .iter()
        .flat_map(|p| p.hole_cards.iter().cloned())
        .collect();
    for (index, run) in hand.board.runouts.iter().enumerate() {
        let resolved = resolve_runout(&hand.board, index);
        if index == 0 {
            cards.extend(resolved);
            continue;
        }
        if run.flop.is_some() {
            cards.extend(resolved.iter().take(3).cloned());
        }
        cards.extend(run.turn.iter().filter(|c| !c.is_empty()).cloned());
        cards.extend(run.river.iter().filter(|c| !c.is_empty()).cloned());
    }
    let mut seen = HashSet::new();
    for card in cards {
        if !seen.insert(card.clone()) {
            problems.push(format!("{}: {card} is dealt twice", hand.meta.hand_id));
        }
    }
    problems
}

pub fn round_trips_through_standard_text(hand: &PhfHand) -> Vec<String> {
    let text = to_standard_text(hand);
    let Ok(Some(back)) = parse_standard_hand(&text, &STANDARD) else {
        return vec![format!(
            "{}: serialized text does not parse back",
            hand.meta.hand_id
        )];
    };
    let moving = |input: &PhfHand| -> Vec<_> {
        input
            .actions
            .iter()
            .filter(|a| a.amount != 0 || a.kind == ActionType::Collect)
            .map(|a| {
                (
                    a.street,
                    a.kind,
                    a.amount,
                    a.street_total,
                    a.player.clone(),
                    a.runout_index,
                )
            })
            .collect()
    };
    let still = |input: &PhfHand| -> Vec<String> {
        let mut out: Vec<String> = input
            .actions
            .iter()
            .filter(|a| a.amount == 0 && a.kind != ActionType::Collect)
            .map(|a| {
                let cards = if a.kind == ActionType::Fold {
                    String::new()
                } else {
                    a.cards.clone().unwrap_or_default().join("")
                };
                format!("{}/{}/{cards}", a.kind.as_str(), a.player)
            })
            .collect();
        // `Array.prototype.sort`: UTF-16 code unit order.
        out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        out
    };
    let board = |input: &PhfHand| -> Vec<Vec<String>> {
        (0..input.board.runouts.len())
            .map(|i| resolve_runout(&input.board, i))
            .collect()
    };
    let movements = |input: &PhfHand| -> Vec<String> {
        let mut out: Vec<String> = input
            .chip_movements
            .iter()
            .flatten()
            .map(|m| {
                format!(
                    "{}/{}/{}/{}",
                    m.kind,
                    m.from_seat.map_or("null".to_owned(), |s| s.to_string()),
                    m.to_pot,
                    m.amount
                )
            })
            .collect();
        out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        out
    };
    let id = &hand.meta.hand_id;
    let mut problems = Vec::new();
    if moving(hand) != moving(&back) {
        problems.push(format!("{id}: money actions changed on round trip"));
    }
    if still(hand) != still(&back) {
        problems.push(format!("{id}: zero-amount actions changed on round trip"));
    }
    if board(hand) != board(&back) {
        problems.push(format!("{id}: board changed on round trip"));
    }
    if hand.results.total_pot != back.results.total_pot {
        problems.push(format!("{id}: pot changed on round trip"));
    }
    if hand.results.fees != back.results.fees {
        problems.push(format!("{id}: fees changed on round trip"));
    }
    if movements(hand) != movements(&back) {
        problems.push(format!("{id}: chip movements changed on round trip"));
    }
    problems
}

pub fn fold_reveal_is_flagged(hand: &PhfHand) -> Vec<String> {
    let exposing = hand
        .actions
        .iter()
        .any(|a| a.kind == ActionType::Fold && a.cards.as_ref().is_some_and(|c| !c.is_empty()));
    if !exposing
        || hand
            .meta
            .warnings
            .iter()
            .any(|w| w.code == "reveal-not-serializable")
    {
        Vec::new()
    } else {
        vec![format!(
            "{}: a fold exposed a card but the hand does not flag the loss",
            hand.meta.hand_id
        )]
    }
}

/// `allInvariants`.
pub fn all_invariants(hand: &PhfHand) -> Vec<String> {
    [
        blind_spots(hand),
        fold_reveal_is_flagged(hand),
        chip_conservation(hand),
        no_negative_stacks(hand),
        pot_fully_awarded(hand),
        uncalled_within_commitment(hand),
        seats_and_cards(hand),
        round_trips_through_standard_text(hand),
    ]
    .concat()
}

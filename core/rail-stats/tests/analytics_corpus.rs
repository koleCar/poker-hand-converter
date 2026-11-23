//! The Analytics catalogue over the whole golden corpus (docs/ANALYTICS.md
//! Step 1), every dealt-in seat of every hand:
//!
//! - **Twins**: every rate with a `coded` twin (VPIP, PFR, open raise,
//!   3-bet, fold to 3-bet, 4-bet, cbet, turn barrel) counts exactly the
//!   coded counters, made and opportunities, on every row.
//! - **Membership**: in `first` / `any` mode a seat has at most one member
//!   decision per rate, exactly when it has the opportunity; in `first` mode
//!   "taken" is the per-hand made.
//! - **The web's port**: `npm run golden:emit` writes what the TypeScript
//!   events (`web/src/lib/stats/events.ts`, hashed field for field) and
//!   catalogue (`analytics.ts`) conclude to `testdata/golden-analytics/`;
//!   the Rust ones must equal them on every hand.

mod support;

use std::fmt::Write as _;

use rail_core::canonical::value_to_canonical_json;
use rail_stats::analytics::{Catalogue, StatKind, catalogue, coded_counters};
use rail_stats::custom::Counts;
use rail_stats::events::{Facing, HandEvents, hand_events};
use rail_stats::{Counter, rows_for};
use serde_json::{Value, json};
use support::{corpus, read_json, root, sha256_hex};

fn counter(name: &str) -> Counter {
    Counter::from_name(name).unwrap_or_else(|| panic!("no counter {name}"))
}

#[test]
fn every_coded_twin_matches_its_counters() {
    let catalogue = catalogue();
    let twins: Vec<(usize, Counter, Counter)> = catalogue
        .stats
        .iter()
        .enumerate()
        .filter_map(|(index, stat)| match &stat.kind {
            StatKind::Rate {
                coded: Some(coded), ..
            } => {
                let (made, opp) = coded_counters(coded).expect("pct(made, opp)");
                Some((index, counter(&made), counter(&opp)))
            }
            _ => None,
        })
        .collect();
    let names: Vec<&str> = twins
        .iter()
        .map(|(index, _, _)| catalogue.stats[*index].id.as_str())
        .collect();
    for want in ["vpip", "pfr", "three_bet", "cbet_flop"] {
        assert!(names.contains(&want), "{want} has a coded twin");
    }
    let mut totals = vec![(0_u64, 0_u64); twins.len()];
    let mut failures = Vec::new();
    let mut rows_total = 0;
    for golden in corpus().hands() {
        let rows = rows_for(&golden.hand);
        let events = hand_events(&golden.hand);
        rows_total += rows.len();
        for (row, seat) in rows.iter().zip(&events.seats) {
            assert_eq!(row.seat.seat, seat.seat);
            let counts = catalogue.counts(&events, seat);
            for ((index, made, opp), total) in twins.iter().zip(&mut totals) {
                let c = &row.seat.counters;
                let want = Counts {
                    made: c[*made],
                    opp: c[*opp],
                };
                total.0 += u64::from(want.made);
                total.1 += u64::from(want.opp);
                if counts[*index] != want && failures.len() < 20 {
                    failures.push(format!(
                        "{} {} seat {} {}: catalogue {:?}, coded {want:?}",
                        golden.file,
                        golden.hand_id,
                        seat.seat,
                        catalogue.stats[*index].id,
                        counts[*index]
                    ));
                }
            }
        }
    }
    let mut report = format!("{rows_total} rows\n");
    for ((index, _, _), (made, opp)) in twins.iter().zip(&totals) {
        let _ = writeln!(
            report,
            "{:<20} {made:>7} / {opp:>7}",
            catalogue.stats[*index].id
        );
    }
    println!("{report}");
    assert!(rows_total > 50_000, "the whole corpus");
    assert!(failures.is_empty(), "{report}\n{}", failures.join("\n"));
}

#[test]
fn membership_matches_the_counts_on_the_corpus() {
    let catalogue = catalogue();
    let mut failures = Vec::new();
    let mut members_total = 0_usize;
    for golden in corpus().hands() {
        let events = hand_events(&golden.hand);
        let members = catalogue.membership(&events);
        members_total += members.len();
        for seat in &events.seats {
            let counts = catalogue.counts(&events, seat);
            for (index, stat) in catalogue.stats.iter().enumerate() {
                let Some(counter) = stat.counter() else {
                    continue;
                };
                let mine: Vec<bool> = members
                    .iter()
                    .filter(|member| member.seat == seat.seat)
                    .flat_map(|member| &member.stats)
                    .filter(|(i, _)| *i == index)
                    .map(|(_, taken)| *taken)
                    .collect();
                let count = counts[index];
                let ok = match counter.mode() {
                    rail_config::stats::predicate::Mode::First => {
                        mine.len() == count.opp as usize
                            && mine.iter().filter(|t| **t).count() == count.made as usize
                    }
                    rail_config::stats::predicate::Mode::Any => {
                        mine.len() == count.opp as usize
                            && mine.iter().filter(|t| **t).count() <= count.made as usize
                    }
                    rail_config::stats::predicate::Mode::Each => {
                        mine.len() == count.opp as usize
                            && mine.iter().filter(|t| **t).count() == count.made as usize
                    }
                };
                if !ok && failures.len() < 20 {
                    failures.push(format!(
                        "{} {} seat {} {}: members {mine:?}, counts {count:?}",
                        golden.file, golden.hand_id, seat.seat, stat.id
                    ));
                }
            }
        }
    }
    assert!(members_total > 50_000, "{members_total} members");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/* -------------------------------------------------- the web's port, equal - */

fn facing(facing: Facing) -> &'static str {
    match facing {
        Facing::None => "none",
        Facing::Limp => "limp",
        Facing::Bet => "bet",
        Facing::Raise => "raise",
    }
}

/// The events in the TypeScript port's shape (`HandEvents`, camelCase).
fn events_json(events: &HandEvents) -> Value {
    let seats: Vec<Value> = events
        .seats
        .iter()
        .map(|seat| {
            let decisions: Vec<Value> = seat
                .events
                .iter()
                .map(|e| {
                    json!({
                        "order": e.order,
                        "street": e.street,
                        "action": e.action,
                        "allIn": e.all_in,
                        "facing": facing(e.facing),
                        "raiseLevel": e.raise_level,
                        "limpers": e.limpers,
                        "callers": e.callers,
                        "firstOnStreet": e.first_on_street,
                        "firstAtLevel": e.first_at_level,
                        "checkedBefore": e.checked_before,
                        "ownRaise": e.own_raise,
                        "facingSteal": e.facing_steal,
                        "facingCbet": e.facing_cbet,
                        "barrels": e.barrels,
                        "initiative": e.initiative,
                        "aheadOfAggressor": e.ahead_of_aggressor,
                        "checkedThrough": e.checked_through,
                        "inPosition": e.in_position,
                        "players": e.players,
                        "potBb": e.pot_bb,
                        "sizeBb": e.size_bb,
                        "sizePot": e.size_pot,
                        "facingSizePot": e.facing_size_pot,
                    })
                })
                .collect();
            json!({
                "seat": seat.seat,
                "hero": seat.hero,
                "position": seat.position,
                "postedBlind": seat.posted_blind,
                "bigBlind": seat.big_blind,
                "preflopAggressor": seat.preflop_aggressor,
                "stackBb": seat.stack_bb,
                "effectiveBb": seat.effective_bb,
                "effectiveFirstActionBb": seat.effective_first_action_bb,
                "sawFlop": seat.saw_flop,
                "sawTurn": seat.saw_turn,
                "sawRiver": seat.saw_river,
                "showdown": seat.showdown,
                "won": seat.won,
                "cardsKnown": seat.cards_known,
                "pocketPair": seat.pocket_pair,
                "suited": seat.suited,
                "events": decisions,
            })
        })
        .collect();
    json!({
        "bombPot": events.bomb_pot,
        "straddle": events.straddle,
        "buttonBlind": events.button_blind,
        "walk": events.walk,
        "dealt": events.dealt,
        "maxSeats": events.max_seats,
        "preflopRaises": events.preflop_raises,
        "seats": seats,
    })
}

/// `seat:id=made/opp,...` per seat, as `tests/scripts/golden/analytics.ts`.
fn counts_text(catalogue: &Catalogue, events: &HandEvents) -> String {
    events
        .seats
        .iter()
        .filter_map(|seat| {
            let mine: Vec<String> = catalogue
                .counts(events, seat)
                .iter()
                .zip(&catalogue.stats)
                .filter(|(count, _)| count.made != 0 || count.opp != 0)
                .map(|(count, stat)| format!("{}={}/{}", stat.id, count.made, count.opp))
                .collect();
            (!mine.is_empty()).then(|| format!("{}:{}", seat.seat, mine.join(",")))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `order@seat:id+,id-,...` per member decision.
fn members_text(catalogue: &Catalogue, events: &HandEvents) -> String {
    catalogue
        .membership(events)
        .iter()
        .map(|member| {
            let stats: Vec<String> = member
                .stats
                .iter()
                .map(|(index, taken)| {
                    format!(
                        "{}{}",
                        catalogue.stats[*index].id,
                        if *taken { "+" } else { "-" }
                    )
                })
                .collect();
            format!("{}@{}:{}", member.order, member.seat, stats.join(","))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn every_corpus_hand_matches_the_typescript_port() {
    let catalogue = catalogue();
    let dir = root().join("testdata/golden-analytics");
    let (mut hands, mut failures) = (0_usize, Vec::new());
    for (file, golden_hands) in &corpus().files {
        let path = dir.join(file);
        assert!(
            path.is_file(),
            "{} is missing; run `npm run golden:emit` in tests/",
            path.display()
        );
        let golden = read_json(&path);
        let entries = golden["hands"].as_array().expect("hands");
        assert_eq!(
            entries.len(),
            golden_hands.len(),
            "{file}: one entry per hand"
        );
        for (entry, hand) in entries.iter().zip(golden_hands) {
            hands += 1;
            assert_eq!(entry["index"].as_u64(), Some(hand.index), "{file}");
            let events = hand_events(&hand.hand);
            let text = value_to_canonical_json(events_json(&events)).expect("canonical");
            let mut wrong = Vec::new();
            if entry["events"].as_str() != Some(sha256_hex(&text).as_str()) {
                wrong.push(format!("events differ; Rust: {text}"));
            }
            let counts = counts_text(catalogue, &events);
            if entry["counts"].as_str() != Some(counts.as_str()) {
                wrong.push(format!("counts: TS {}, Rust {counts}", entry["counts"]));
            }
            let members = members_text(catalogue, &events);
            if entry["members"].as_str() != Some(members.as_str()) {
                wrong.push(format!("members: TS {}, Rust {members}", entry["members"]));
            }
            if !wrong.is_empty() && failures.len() < 5 {
                failures.push(format!("{file} {}: {}", hand.hand_id, wrong.join("\n  ")));
            }
        }
    }
    assert!(hands > 8000, "the whole corpus: {hands} hands");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

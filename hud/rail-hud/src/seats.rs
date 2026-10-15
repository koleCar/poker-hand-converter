//! Which place on the screen a hand history's seat is (R3.6): the table
//! size, the room's seat numbering and the hero's rotation.
//!
//! - **Slots.** A [`TableLayout`] lists where the client draws its seats,
//!   clockwise; slot `i` is where an unrotated client draws its `i`-th seat
//!   (`seat_numbers` says which hand-history seat that is, when the room
//!   does not number a table `1..=size`).
//! - **Preferred seat.** Clients that always draw the hero in one place
//!   (PokerStars, Winamax and ACR offer it) turn the whole table: the hero
//!   goes to the layout's `hero_slot`, everyone else keeps their order
//!   around the table. So seat `s` is drawn at `(slot(s) - slot(hero) +
//!   hero_slot) mod size` ([`slot_of`]). Whether a room's client does is
//!   `sites.json` `tables.preferredSeat` (unknown everywhere until R3.3's
//!   capture) unless the user says otherwise (`hud_room_settings`, R3.6) -
//!   the HUD does not guess from the screen.
//! - **The hero's seat** ([`hero_after`]) comes with each hand
//!   (`PlayerRef.hero`). A hand without the hero - not dealt in, sitting
//!   out, a missed blind - keeps the seat while nobody else sits in it;
//!   someone else in it (the hero left) or no hero ever (observing) means
//!   no rotation: an observer's client draws the table as numbered. A
//!   tournament table move forgets it with the players (the engine), and
//!   the next hand brings the new seat.
//! - **The table size** ([`table_size`]): the window's (its title, else its
//!   last hand's `max_seats`), unless a hand names a seat it does not have
//!   (a size changed under the window: a 9-max table turned 6-max keeps
//!   its numbers, or the other way) - then the smallest usual size holding
//!   every seat. Heads-up is a size like any other (two slots).
//!
//! This is about *where* a panel is drawn, never *what* it shows: the
//! statistics are the same at every seat (PokerStars forbids switching the
//! display by position, stack or opponent; nothing here does).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use rail_config::Config;
use rail_hud_ipc::protocol::PlayerRef;
use rail_store::{RoomSettings, SeatPosition};

use crate::layout::{MAX_SEATS, MIN_SEATS, Positions, TableLayout};

/// What the HUD knows of where each room draws its tables (R3.6): from
/// `sites.json` (measured layouts, whether the client rotates) and from the
/// user (the store's `hud_room_settings` and `hud_seat_positions`, which the
/// app writes).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rooms {
    /// Room -> size -> its measured layout.
    measured: BTreeMap<String, BTreeMap<u32, TableLayout>>,
    /// Room -> `tables.preferredSeat` where known.
    shipped_rotation: BTreeMap<String, bool>,
    /// Room -> the user's answer.
    user_rotation: BTreeMap<String, bool>,
    /// (room, size) -> the panels the user placed.
    positions: BTreeMap<(String, u32), Positions>,
}

impl Rooms {
    /// `sites.json`'s part (the user's stays as it is).
    pub fn set_config(&mut self, config: &Config) {
        self.measured.clear();
        self.shipped_rotation.clear();
        for site in &config.sites {
            if let Some(rotates) = site.tables.preferred_seat {
                self.shipped_rotation.insert(site.id.clone(), rotates);
            }
            let Some(layouts) = &site.tables.seat_layouts else {
                continue;
            };
            let sizes: BTreeMap<u32, TableLayout> = layouts
                .iter()
                .filter_map(|(size, layout)| {
                    let size = size.parse().ok()?;
                    TableLayout::measured(size, layout).map(|l| (size, l))
                })
                .collect();
            if !sizes.is_empty() {
                self.measured.insert(site.id.clone(), sizes);
            }
        }
    }

    /// The user's part, as the store has it now (replacing what was known).
    pub fn set_user(&mut self, positions: Vec<SeatPosition>, settings: Vec<RoomSettings>) {
        self.positions.clear();
        for p in positions {
            self.positions
                .entry((p.site, p.size))
                .or_default()
                .insert(p.slot, (p.x, p.y));
        }
        self.user_rotation = settings
            .into_iter()
            .filter_map(|s| Some((s.site, s.preferred_seat?)))
            .collect();
    }

    /// The room's measured layout for `size` seats; `None`: the default
    /// (the table simulator's geometry).
    pub fn layout(&self, site: &str, size: u32) -> Option<TableLayout> {
        self.measured.get(site)?.get(&size).cloned()
    }

    /// Whether the room's client rotates the table so the hero is always
    /// in one place: the user's word, else `sites.json`'s, else no.
    pub fn rotates(&self, site: &str) -> bool {
        self.user_rotation
            .get(site)
            .or_else(|| self.shipped_rotation.get(site))
            .copied()
            .unwrap_or(false)
    }

    /// The panels the user placed on the room's tables of `size` seats.
    pub fn positions(&self, site: &str, size: u32) -> Positions {
        self.positions
            .get(&(site.to_owned(), size))
            .cloned()
            .unwrap_or_default()
    }

    /// A panel the user just placed (before the store has it).
    pub fn set_position(&mut self, site: &str, size: u32, slot: u32, at: (u32, u32)) {
        self.positions
            .entry((site.to_owned(), size))
            .or_default()
            .insert(slot, at);
    }
}

/// The table size to lay out: the window's (`size`), unless one of `seats`
/// is past it; then (or without one) the smallest of 6, 9 and 10 that has
/// every seat. Clamped to 2 - 10.
pub fn table_size(size: Option<u32>, seats: impl IntoIterator<Item = u32>) -> u32 {
    let highest = seats.into_iter().max().unwrap_or(0);
    if let Some(size) = size.filter(|&s| s >= highest) {
        return size.clamp(MIN_SEATS, MAX_SEATS);
    }
    [6, 9, 10]
        .into_iter()
        .find(|&n| n >= highest)
        .unwrap_or(MAX_SEATS)
}

/// The slot (place on the screen, an index into `layout.slots`) where the
/// hand history's `seat` is drawn; `rotate_to` is the hero's seat when the
/// client rotates the table, `None` when it does not (or the hero is not
/// seated). `None`: no such seat at this table.
pub fn slot_of(layout: &TableLayout, seat: u32, rotate_to: Option<u32>) -> Option<u32> {
    let size = layout.size;
    let index = layout.slot_of_seat(seat)?;
    match rotate_to.and_then(|hero| layout.slot_of_seat(hero)) {
        Some(hero) => Some((index + size - hero + layout.hero_slot % size) % size),
        None => Some(index),
    }
}

/// The hero's seat after a hand with `players`, `before` the seat known
/// so far: the hand's own hero seat; else `before` while no one else sits
/// in it (the hero not dealt in this hand); else none.
pub fn hero_after(players: &[PlayerRef], before: Option<u32>) -> Option<u32> {
    if let Some(seat) = players.iter().find(|p| p.hero).and_then(|p| p.seat) {
        return Some(seat);
    }
    before.filter(|&seat| !players.iter().any(|p| p.seat == Some(seat)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_config::model::SeatLayout;

    fn player(seat: u32, hero: bool) -> PlayerRef {
        PlayerRef {
            hero,
            ..PlayerRef::named(format!("P{seat}")).at(seat)
        }
    }

    /// Every size, the hero at every seat, rotation on and off: the slot
    /// is where the table simulator draws that seat (`--preferred-seat` on
    /// and off), every seat a different slot, the hero at the bottom.
    #[test]
    fn rotation_matches_the_simulator_at_every_size_and_seat() {
        for size in MIN_SEATS..=MAX_SEATS {
            let layout = TableLayout::simulator(size);
            for hero in 1..=size {
                for rotate in [false, true] {
                    let rotate_to = rotate.then_some(hero);
                    let mut seen = std::collections::BTreeSet::new();
                    for seat in 1..=size {
                        let slot = slot_of(&layout, seat, rotate_to)
                            .unwrap_or_else(|| panic!("{size}: seat {seat}"));
                        assert!(seen.insert(slot), "{size} hero {hero}: slot {slot} twice");
                        let drawn = rail_hud_sim::draw::seat_center(size, seat, rotate_to);
                        assert_eq!(
                            layout.slot_center(slot),
                            Some(drawn),
                            "{size} seats, hero {hero}, seat {seat}, rotate {rotate}"
                        );
                    }
                    let hero_slot = slot_of(&layout, hero, rotate_to);
                    assert_eq!(hero_slot, Some(if rotate { 0 } else { hero - 1 }));
                }
                assert_eq!(slot_of(&layout, size + 1, Some(hero)), None);
                assert_eq!(slot_of(&layout, 0, Some(hero)), None);
            }
        }
    }

    /// Heads-up: two slots, the hero at the bottom when rotated, the
    /// villain across.
    #[test]
    fn heads_up() {
        let layout = TableLayout::simulator(2);
        assert_eq!(slot_of(&layout, 2, Some(2)), Some(0));
        assert_eq!(slot_of(&layout, 1, Some(2)), Some(1));
        assert_eq!(slot_of(&layout, 1, None), Some(0));
        assert_eq!(slot_of(&layout, 2, None), Some(1));
    }

    /// A measured layout's own hero slot and numbering: a 6-max table
    /// written with 9-max seat numbers, the hero drawn at slot 3.
    #[test]
    fn a_room_with_its_own_hero_slot_and_numbers() {
        let layout = TableLayout::measured(
            6,
            &SeatLayout {
                seats: vec![
                    [700, 150],
                    [900, 450],
                    [700, 800],
                    [300, 800],
                    [100, 450],
                    [300, 150],
                ],
                plate: [160, 90],
                center: [500, 480],
                hero_slot: 3,
                graphics: vec![],
                seat_numbers: Some(vec![1, 2, 4, 5, 7, 9]),
            },
        )
        .expect("fits");
        // Unrotated: by the numbering.
        assert_eq!(slot_of(&layout, 7, None), Some(4));
        assert_eq!(slot_of(&layout, 3, None), None);
        // The hero at seat 7 is drawn at slot 3; seat 9 (next clockwise)
        // at slot 4, seat 1 at 5, seat 2 at 0.
        assert_eq!(slot_of(&layout, 7, Some(7)), Some(3));
        assert_eq!(slot_of(&layout, 9, Some(7)), Some(4));
        assert_eq!(slot_of(&layout, 1, Some(7)), Some(5));
        assert_eq!(slot_of(&layout, 2, Some(7)), Some(0));
        // A hero seat the layout does not know: no rotation.
        assert_eq!(slot_of(&layout, 2, Some(3)), Some(1));
    }

    /// Observing (no hero), the hero not dealt in, the hero's seat taken
    /// by someone else.
    #[test]
    fn the_heros_seat_from_hand_to_hand() {
        let observed = [player(1, false), player(4, false)];
        assert_eq!(hero_after(&observed, None), None, "observing");
        let dealt = [player(1, false), player(3, true), player(4, false)];
        assert_eq!(hero_after(&dealt, None), Some(3));
        assert_eq!(hero_after(&dealt, Some(5)), Some(3), "the hand says");
        let sitting_out = [player(1, false), player(4, false)];
        assert_eq!(hero_after(&sitting_out, Some(3)), Some(3), "seat kept");
        let left = [player(1, false), player(3, false)];
        assert_eq!(hero_after(&left, Some(3)), None, "someone else sits there");
        // A player without a seat number (an older app) changes nothing.
        let unseated = [PlayerRef::named("X")];
        assert_eq!(hero_after(&unseated, Some(2)), Some(2));
    }

    /// Rotation: the user's word over `sites.json`'s over "no"; measured
    /// layouts per size; the user's positions per (room, size).
    #[test]
    fn rooms() {
        let mut value: serde_json::Value =
            serde_json::from_str(rail_config::SHIPPED).expect("json");
        for site in value["sites"].as_array_mut().expect("sites") {
            if site["id"] == "winamax" {
                site["tables"]["preferredSeat"] = serde_json::json!(true);
                site["tables"]["seatLayouts"] = serde_json::json!({"2": {
                    "seats": [[500, 800], [500, 200]],
                    "plate": [200, 100],
                    "center": [500, 500],
                    "heroSlot": 0,
                    "graphics": [],
                    "seatNumbers": null
                }});
            }
        }
        let config = rail_config::load(&value.to_string(), &rail_core::parsers::REGISTRATION_ORDER)
            .expect("loads");
        let mut rooms = Rooms::default();
        rooms.set_config(&config);
        assert!(rooms.rotates("winamax"));
        assert!(!rooms.rotates("pokerstars"), "unknown is no");
        assert!(rooms.layout("winamax", 2).is_some());
        assert!(rooms.layout("winamax", 6).is_none());
        assert!(rooms.layout("pokerstars", 2).is_none());
        let position = |site: &str, size, slot, x, y| SeatPosition {
            site: site.into(),
            size,
            slot,
            x,
            y,
            updated_at: 0,
        };
        rooms.set_user(
            vec![position("acr", 6, 0, 10, 20), position("acr", 6, 3, 30, 40)],
            vec![
                RoomSettings {
                    site: "winamax".into(),
                    preferred_seat: Some(false),
                },
                RoomSettings {
                    site: "pokerstars".into(),
                    preferred_seat: Some(true),
                },
                RoomSettings {
                    site: "acr".into(),
                    preferred_seat: None,
                },
            ],
        );
        assert!(!rooms.rotates("winamax"), "the user's word wins");
        assert!(rooms.rotates("pokerstars"));
        assert!(!rooms.rotates("acr"));
        assert_eq!(rooms.positions("acr", 6).len(), 2);
        assert!(rooms.positions("acr", 9).is_empty());
        rooms.set_position("acr", 9, 1, (5, 6));
        assert_eq!(rooms.positions("acr", 9).get(&1), Some(&(5, 6)));
        // Reloading the configuration keeps the user's part.
        rooms.set_config(&config);
        assert!(rooms.rotates("pokerstars"));
    }

    /// The window's size, unless a hand names a seat past it (9-max ->
    /// 6-max and back); every size clamped to 2 - 10.
    #[test]
    fn table_sizes() {
        assert_eq!(table_size(Some(6), [1, 6]), 6);
        assert_eq!(table_size(Some(9), [1, 4]), 9, "a 9-max table, few seated");
        assert_eq!(table_size(Some(6), [1, 8]), 9, "a seat past the size");
        assert_eq!(table_size(Some(2), [1, 2]), 2);
        assert_eq!(table_size(Some(1), []), 2);
        assert_eq!(table_size(Some(12), []), 10);
        assert_eq!(table_size(None, [1, 4]), 6);
        assert_eq!(table_size(None, [2, 8]), 9);
        assert_eq!(table_size(None, [10]), 10);
        assert_eq!(table_size(None, [13]), 10);
        assert_eq!(table_size(None, []), 6);
        // The same seats laid out on a 9-max table, then the table turned
        // 6-max: every seat a slot of the new size.
        for size in [9, 6] {
            let layout = TableLayout::simulator(table_size(Some(size), [1, 2, 3]));
            for seat in 1..=3 {
                assert!(slot_of(&layout, seat, Some(2)).is_some_and(|s| s < size));
            }
        }
    }
}

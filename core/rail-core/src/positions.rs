//! Positions from the hand itself: `assignPositions` of
//! `web/src/lib/phf/types.ts`.
//!
//! The pure geometry it builds on is [`crate::phf::game`]
//! (`position_ring`, `dealt_in_seats`, `has_dead_button`,
//! `button_blind_ring`) and [`crate::phf::is_button_blind`]. The pipeline
//! calls [`assign_positions`] through [`HandChecks`](crate::convert::HandChecks)
//! where `convertAny` calls it: after the parser and the backstops, before
//! validation.

use crate::phf::game::map_set;
use crate::phf::{
    ActionType, PhfHand, Position, button_blind_ring, dealt_in_seats, has_dead_button,
    is_button_blind, position_ring,
};

/// `assignPositions(hand)`: sets every player's `position` from who posted
/// the blinds, anchored on the ring of seats that were dealt in. `None` for a
/// seat outside the ring, and for everyone when nothing anchors it.
///
/// - The first posting of each blind wins (a late joiner's mislabelled dead
///   blind must not move the ring).
/// - A button blind alone (GG's ante-only short deck) anchors the
///   [`button_blind_ring`]: the ring starts one seat past it.
/// - Otherwise the small blind is `ring[0]`; without one, the big blind is
///   `ring[1]`; without either (a bomb pot), the button's geometry. A dead
///   button names the live seats against a ring one longer with the button
///   slot dropped.
/// - A dead small blind - none posted, and the button right behind the big
///   blind - is its mirror image: a ring one longer with the small blind slot
///   dropped, starting at the big blind.
pub fn assign_positions(hand: &mut PhfHand) {
    let mut small_blind_seat: Option<u32> = None;
    let mut big_blind_seat: Option<u32> = None;
    let mut button_blind_seat: Option<u32> = None;

    for action in &hand.actions {
        let Some(seat) = action.seat else {
            continue;
        };
        if action.kind == ActionType::SmallBlind && small_blind_seat.is_none() {
            small_blind_seat = Some(seat);
        }
        if is_button_blind(action) {
            button_blind_seat = button_blind_seat.or(Some(seat));
        } else if action.kind == ActionType::BigBlind && big_blind_seat.is_none() {
            big_blind_seat = Some(seat);
        }
    }

    let ring_seats = dealt_in_seats(hand);
    let size = ring_seats.len();
    let index_of = |seat: u32| ring_seats.iter().position(|s| *s == seat);

    let mut positions: Vec<(u32, Position)> = Vec::new();
    let mut place = |start: usize, ring: &[Position]| {
        for (offset, position) in ring.iter().enumerate().take(size) {
            map_set(
                &mut positions,
                ring_seats[(start + offset) % size],
                *position,
            );
        }
    };

    let button_blind_index = button_blind_seat.and_then(index_of);
    if let Some(button_blind_index) = button_blind_index
        && size > 0
        && small_blind_seat.is_none()
        && big_blind_seat.is_none()
    {
        // The button blind is the last name in the ring, so the ring starts
        // one seat past it.
        place((button_blind_index + 1) % size, &button_blind_ring(size));
    } else if size > 0 {
        let dead = has_dead_button(hand, Some(&ring_seats));
        let mut ring = if dead {
            let mut ring = position_ring(size + 1);
            ring.truncate(size);
            ring
        } else {
            position_ring(size)
        };
        let big_blind_index = big_blind_seat.and_then(index_of);
        // ring[0] is the small blind; find which seat that is.
        let start = if let Some(index) = small_blind_seat.and_then(index_of) {
            Some(index)
        } else if let Some(index) = big_blind_index
            && !dead
            && size >= 3
            && hand.table.button_seat == Some(ring_seats[(index + size - 1) % size])
        {
            // A dead small blind: nobody posted it and the button sits right
            // behind the big blind, so the small blind's seat is empty. The
            // ring is one longer with the small blind slot dropped, and
            // starts at the big blind - the button is not the small blind.
            ring = position_ring(size + 1).split_off(1);
            Some(index)
        } else if let Some(index) = big_blind_index {
            // No small blind was posted, and the button is not right behind
            // the big blind: the big blind is always ring[1], so step back
            // one.
            Some((index + size - 1) % size)
        } else {
            // Bomb pots post no blinds at all; geometry is all there is.
            hand.table
                .button_seat
                .and_then(index_of)
                .map(|index| if size == 2 { index } else { (index + 1) % size })
        };
        if let Some(start) = start {
            place(start, &ring);
        }
    }

    for player in &mut hand.players {
        player.position = positions
            .iter()
            .find(|(seat, _)| *seat == player.seat)
            .map(|(_, position)| *position);
    }
}

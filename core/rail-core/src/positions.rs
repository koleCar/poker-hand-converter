//! Positions from the hand itself: `assignPositions` of
//! `frontend/src/lib/phf/types.ts`, R0.5b.
//!
//! The pure geometry it builds on is already here: [`crate::phf::game`]
//! (`position_ring`, `resolve_positions`, `dealt_in_seats`,
//! `has_dead_button`, `button_blind_ring`) and
//! [`crate::phf::is_button_blind`]. The pipeline calls [`assign_positions`]
//! through [`HandChecks`](crate::convert::HandChecks) where `convertAny`
//! calls it.

use crate::phf::PhfHand;

/// `assignPositions`. **R0.5b**: not ported yet; it panics rather than
/// leaving positions silently unset. With no parser registered (R0.5a) the
/// pipeline never gets this far.
pub fn assign_positions(_hand: &mut PhfHand) {
    unimplemented!("assignPositions is ported in R0.5b")
}

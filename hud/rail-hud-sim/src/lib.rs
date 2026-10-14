//! Table simulator (docs/RAIL-PLAN.md A8, R3.1): windows titled like a
//! room's tables, writing real corpus hands to a hand-history folder at
//! play speed - the development and CI harness for the watcher (R1.3) and
//! every HUD step (R3.2 onwards).
//!
//! - [`room`]: `rooms.json` - per room the title and file-name templates,
//!   encoding, separator, sizes, and what of it is sourced or invented;
//!   the test-only title regex.
//! - [`corpus`]: the room's corpus hands that the simulator replays.
//! - [`rewrite`]: one hand rewritten for a table (id, table, time, seats,
//!   names) and read back to prove it.
//! - [`sim`]: tables, the play-speed clock, commands and events.
//! - [`output`]: the simulator's own folder, and appending a hand.
//! - [`draw`]: the drawn table; seat positions as fractions of the client
//!   area.
//! - [`verify`]: a folder read back through `rail_core::convert`.
//!
//! The windows themselves (winit + softbuffer) are in the binary.

#![forbid(unsafe_code)]

pub mod clock;
pub mod command;
pub mod corpus;
pub mod draw;
pub mod names;
pub mod output;
pub mod rewrite;
pub mod room;
pub mod sim;
pub mod verify;

#![forbid(unsafe_code)]
//! Sync between the desktop app and Supabase (docs/RAIL-PLAN.md R1.7-R1.9).
//!
//! - [`auth`]: the app's own account session (R1.7);
//! - [`ingest`]: the calls that put the outbox's hands into Supabase -
//!   rows, batches, `register_hand_source` and `ingest_hands` with the
//!   account's token (R1.8) - and the pull's two reads (R1.9);
//! - [`worker`]: the sync worker that drains the outbox with them and pulls
//!   the account's other hands into the store (R1.9);
//! - [`policy`]: the remote `sites.json` from the web origin - fetched,
//!   checked, merged stricter-only over the shipped copy and cached (R3.10).

pub mod auth;
pub mod ingest;
pub mod policy;
pub mod worker;

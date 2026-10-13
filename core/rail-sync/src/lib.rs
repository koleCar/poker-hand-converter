#![forbid(unsafe_code)]
//! Sync between the desktop app and Supabase (docs/RAIL-PLAN.md R1.7-R1.9).
//!
//! - [`auth`]: the app's own account session (R1.7);
//! - [`ingest`]: the calls that put the outbox's hands into Supabase -
//!   rows, batches, `register_hand_source` and `ingest_hands` with the
//!   account's token (R1.8).
//!
//! Next: the sync worker that drains the outbox with [`ingest`] (R1.9), and
//! the pull of hands that arrived through the web.

pub mod auth;
pub mod ingest;

#![forbid(unsafe_code)]
//! Sync between the desktop app and Supabase (docs/RAIL-PLAN.md R1.7-R1.9).
//!
//! Today: [`auth`], the app's own account session (R1.7). Next: the outbox
//! to Supabase (R1.8 / R1.9), which takes its access token from
//! [`auth::Account::access_token`], and the pull of hands that arrived
//! through the web.

pub mod auth;

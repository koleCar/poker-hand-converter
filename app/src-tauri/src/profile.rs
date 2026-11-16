//! The account's public name (2026-11-16): what other people see instead of
//! the email. Settings → Account shows it, and while it is still the
//! provisional `user_xxxxxxxx` from signup the account chooses its own -
//! once; it cannot be changed afterwards (`rail_sync::ingest::profile`,
//! `20271116130500_username_set_once.sql`).
//!
//! Errors the window acts on come back as codes ([`SIGNED_OUT`],
//! [`UNAVAILABLE`], [`UNREACHABLE`]); a refusal of the name (taken, reserved,
//! its shape, already chosen) is the server's sentence, shown as it is.

use rail_sync::ingest::{AccountProfile, IngestClient, IngestError, SetUsernameError};
use tauri::State;

use crate::account::AccountState;

/// Not signed in.
pub const SIGNED_OUT: &str = "signedOut";
/// This build has no account (no Supabase configured).
pub const UNAVAILABLE: &str = "unavailable";
/// No answer from the server (offline, a timeout, a `5xx`).
pub const UNREACHABLE: &str = "unreachable";

fn code_of(error: IngestError) -> String {
    match error {
        IngestError::SignedOut | IngestError::Unauthorized => SIGNED_OUT.to_owned(),
        IngestError::Transient(_) => UNREACHABLE.to_owned(),
        other => other.to_string(),
    }
}

/// The signed-in account's name; `None` when the server has no profile for it.
#[tauri::command]
pub async fn account_profile(
    account: State<'_, AccountState>,
) -> Result<Option<AccountProfile>, String> {
    let account = account.0.clone().ok_or_else(|| UNAVAILABLE.to_owned())?;
    if account.user().is_none() {
        return Err(SIGNED_OUT.to_owned());
    }
    let client = IngestClient::new(account.config()).map_err(code_of)?;
    client
        .my_profile_as(account.as_ref())
        .await
        .map_err(code_of)
}

/// Choose the account's name, once. The name as the server kept it.
#[tauri::command]
pub async fn account_set_username(
    account: State<'_, AccountState>,
    username: String,
) -> Result<String, String> {
    let account = account.0.clone().ok_or_else(|| UNAVAILABLE.to_owned())?;
    if account.user().is_none() {
        return Err(SIGNED_OUT.to_owned());
    }
    let client = IngestClient::new(account.config()).map_err(code_of)?;
    client
        .set_username_as(account.as_ref(), &username)
        .await
        .map_err(|error| match error {
            SetUsernameError::Refused(sentence) => sentence,
            SetUsernameError::Ingest(error) => code_of(error),
        })
}

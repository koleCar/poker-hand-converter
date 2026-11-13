//! The Trainer's answers, kept in the account: the window sends the rows it
//! graded (`app/src/trainer/outbox.ts` keeps them until they are kept), and
//! `record_trainer_results` stores them with the account's token, as the
//! web's trainer does (`rail_sync::ingest::trainer`).
//!
//! Errors the window acts on come back as codes ([`SIGNED_OUT`],
//! [`RATE_LIMITED`], [`PLAN`], [`UNAVAILABLE`], [`UNREACHABLE`]): it keeps
//! the rows and tries again later. Anything else (a refusal) is a sentence,
//! and the window drops that batch.

use rail_sync::ingest::{IngestClient, IngestError, TRAINER_ROWS_PER_CALL, TrainerResultRow};
use tauri::State;

use crate::account::AccountState;

/// Not signed in: the answers wait for the next sign-in.
pub const SIGNED_OUT: &str = "signedOut";
/// Too many answers this window: they wait.
pub const RATE_LIMITED: &str = "rateLimited";
/// The account's plan does not keep trainer answers.
pub const PLAN: &str = "plan";
/// This build has no account (no Supabase configured).
pub const UNAVAILABLE: &str = "unavailable";
/// No answer from the server (offline, a timeout, a `5xx`): they wait.
pub const UNREACHABLE: &str = "unreachable";

fn code_of(error: IngestError) -> String {
    match error {
        IngestError::SignedOut | IngestError::Unauthorized => SIGNED_OUT.to_owned(),
        IngestError::RateLimited { .. } => RATE_LIMITED.to_owned(),
        IngestError::PlanRequired { .. } => PLAN.to_owned(),
        IngestError::Transient(_) => UNREACHABLE.to_owned(),
        other => other.to_string(),
    }
}

/// Keep up to [`TRAINER_ROWS_PER_CALL`] graded answers in the account; how
/// many the server kept (rows it would refuse are dropped, not counted).
#[tauri::command]
pub async fn trainer_results_record(
    account: State<'_, AccountState>,
    rows: Vec<TrainerResultRow>,
) -> Result<u64, String> {
    let account = account.0.clone().ok_or_else(|| UNAVAILABLE.to_owned())?;
    if account.user().is_none() {
        return Err(SIGNED_OUT.to_owned());
    }
    if rows.is_empty() {
        return Ok(0);
    }
    let rows: Vec<TrainerResultRow> = rows.into_iter().take(TRAINER_ROWS_PER_CALL).collect();
    let client = IngestClient::new(account.config()).map_err(code_of)?;
    client
        .record_trainer_results_as(account.as_ref(), &rows)
        .await
        .map_err(code_of)
}

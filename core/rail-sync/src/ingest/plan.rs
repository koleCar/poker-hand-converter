//! (R6.4) The account's plan, as the desktop app reads it:
//!
//! - `my_entitlements()` (R6.2, `20270908090000_entitlements.sql`) with the
//!   account's token: the effective plan, `enforced`, the features and the
//!   offline grace period;
//! - `billing_enforced()` (R6.4, `20270929090000_billing_enforced.sql`)
//!   with the anon key only: whether paid plans are enforced at all - the
//!   one thing an app that was never signed in needs to know. No account,
//!   no user data;
//! - (Free tier) `solver_open_flop(p_flop)`
//!   (`20271119110000_free_tier_limits.sql`) with the account's token: may
//!   a solver flop open today (and today's flops).

use serde_json::Value;

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;
use crate::entitlements::{ServerEntitlements, flops_of, utc_midnight_ms};

/// (Free tier) `solver_open_flop()`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlopOpen {
    /// The flop may show (Pro, enforcement off, one of today's, or counted
    /// now).
    pub allowed: bool,
    /// Today's flops (canonical keys), in the order they were opened.
    pub flops: Vec<String>,
    /// Distinct flops a day; `None` = unlimited.
    pub cap: Option<u32>,
    /// When the day's flops start again (Unix ms).
    pub resets_at_ms: Option<i64>,
}

impl FlopOpen {
    /// The JSON, field by field; only a literal `true` allows.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let row = value.as_object()?;
        Some(Self {
            allowed: row.get("allowed").and_then(Value::as_bool) == Some(true),
            flops: row.get("flops").map(flops_of).unwrap_or_default(),
            cap: row
                .get("cap")
                .and_then(Value::as_u64)
                .map(|cap| u32::try_from(cap).unwrap_or(u32::MAX)),
            resets_at_ms: row
                .get("resetsAt")
                .and_then(Value::as_str)
                .and_then(utc_midnight_ms),
        })
    }
}

impl IngestClient {
    /// The signed-in account's entitlements.
    pub async fn my_entitlements(&self, token: &Secret) -> Result<ServerEntitlements, IngestError> {
        let bytes = self.call(token, "my_entitlements", "{}".to_owned()).await?;
        ServerEntitlements::parse(&bytes)
            .ok_or_else(|| IngestError::Transient("unreadable entitlements".into()))
    }

    /// [`IngestClient::my_entitlements`] with the account's token (one
    /// refresh and retry after a `401`).
    pub async fn my_entitlements_as(
        &self,
        account: &impl TokenSource,
    ) -> Result<ServerEntitlements, IngestError> {
        with_token(account, |token| async move {
            self.my_entitlements(&token).await
        })
        .await
    }

    /// (Free tier) Open a solver flop (any order of its cards; the server
    /// canonicalises it): counted when it is a new one of today's.
    pub async fn solver_open_flop(
        &self,
        token: &Secret,
        flop: &str,
    ) -> Result<FlopOpen, IngestError> {
        let body = serde_json::json!({ "p_flop": flop }).to_string();
        let bytes = self.call(token, "solver_open_flop", body).await?;
        FlopOpen::parse(&bytes)
            .ok_or_else(|| IngestError::Transient("unreadable flop answer".into()))
    }

    /// [`IngestClient::solver_open_flop`] with the account's token.
    pub async fn solver_open_flop_as(
        &self,
        account: &impl TokenSource,
        flop: &str,
    ) -> Result<FlopOpen, IngestError> {
        with_token(account, |token| async move {
            self.solver_open_flop(&token, flop).await
        })
        .await
    }

    /// Whether the server enforces paid plans, asked with the anon key.
    pub async fn billing_enforced(&self) -> Result<bool, IngestError> {
        let anon = self.anon_key.clone();
        let bytes = self
            .call(&anon, "billing_enforced", "{}".to_owned())
            .await?;
        serde_json::from_slice::<bool>(&bytes)
            .map_err(|_| IngestError::Transient("unreadable enforcement flag".into()))
    }
}

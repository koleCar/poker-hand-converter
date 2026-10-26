//! (R6.4) The account's plan, as the desktop app reads it:
//!
//! - `my_entitlements()` (R6.2, `20270908090000_entitlements.sql`) with the
//!   account's token: the effective plan, `enforced`, the features and the
//!   offline grace period;
//! - `billing_enforced()` (R6.4, `20270929090000_billing_enforced.sql`)
//!   with the anon key only: whether paid plans are enforced at all - the
//!   one thing an app that was never signed in needs to know. No account,
//!   no user data.

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;
use crate::entitlements::ServerEntitlements;

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

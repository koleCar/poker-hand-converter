//! The pull's two reads (docs/RAIL-PLAN.md R1.9), under RLS with the
//! account's token:
//!
//! 1. `hands_since(p_after_created, p_after_id, p_limit)` - a keyset page of
//!    the account's hands by `(created_at, id)`: ids and keys only (~150 B a
//!    hand), so the hands this computer uploaded itself cost almost nothing
//!    to recognise;
//! 2. `GET /rest/v1/hands?select=hand_key,phf&id=in.(...)` - the PHF of the
//!    hands the store does not have.

use serde::Deserialize;
use serde_json::Value;

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;

/// Ids per PHF read: a URL of ~3.8 KB.
pub const PHF_IDS_PER_CALL: usize = 100;

/// One row of `hands_since`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RemoteKey {
    pub id: String,
    /// As the server wrote it (`timestamptz`, microseconds): passed back
    /// unchanged as the cursor.
    pub created_at: String,
    pub hand_key: String,
    /// `web` or `desktop`.
    pub origin: String,
}

/// One hand's PHF from the server.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RemoteHand {
    pub hand_key: String,
    pub phf: Value,
}

impl IngestClient {
    /// A page of the account's hands after the cursor (`None`: from the
    /// start), oldest first.
    pub async fn hands_since(
        &self,
        token: &Secret,
        after: Option<(&str, &str)>,
        limit: u32,
    ) -> Result<Vec<RemoteKey>, IngestError> {
        let body = serde_json::json!({
            "p_after_created": after.map(|(created, _)| created),
            "p_after_id": after.map(|(_, id)| id),
            "p_limit": limit,
        })
        .to_string();
        let bytes = self.call(token, "hands_since", body).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable hands_since page".into()))
    }

    /// The PHF of these hands (at most [`PHF_IDS_PER_CALL`] ids, UUIDs only).
    pub async fn hands_phf(
        &self,
        token: &Secret,
        ids: &[&str],
    ) -> Result<Vec<RemoteHand>, IngestError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if ids.len() > PHF_IDS_PER_CALL || !ids.iter().all(|id| super::is_uuid(id)) {
            return Err(IngestError::Refused {
                status: 0,
                code: "bad-ids".into(),
            });
        }
        let mut url = self
            .rest_base
            .join("hands")
            .unwrap_or_else(|_| self.rest_base.clone());
        url.query_pairs_mut()
            .append_pair("select", "hand_key,phf")
            .append_pair("id", &format!("in.({})", ids.join(",")));
        let bytes = self.send(token, self.http.get(url)).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable hands page".into()))
    }

    /// [`IngestClient::hands_since`] with the account's token.
    pub async fn hands_since_as(
        &self,
        account: &impl TokenSource,
        after: Option<(&str, &str)>,
        limit: u32,
    ) -> Result<Vec<RemoteKey>, IngestError> {
        with_token(account, |token| async move {
            self.hands_since(&token, after, limit).await
        })
        .await
    }

    /// [`IngestClient::hands_phf`] with the account's token.
    pub async fn hands_phf_as(
        &self,
        account: &impl TokenSource,
        ids: &[&str],
    ) -> Result<Vec<RemoteHand>, IngestError> {
        with_token(
            account,
            |token| async move { self.hands_phf(&token, ids).await },
        )
        .await
    }
}

//! The pull's two reads (docs/RAIL-PLAN.md R1.9), under RLS with the
//! account's token:
//!
//! 1. `hands_since(p_after_created, p_after_id, p_limit)` - a keyset page of
//!    the account's hands by `(created_at, id)`: ids and keys only (~150 B a
//!    hand), so the hands this computer uploaded itself cost almost nothing
//!    to recognise;
//! 2. `GET /rest/v1/hands?select=hand_key,phf,standard_text,...&id=in.(...)` -
//!    the hands the store does not have: the PHF, or - on a text-only row
//!    (`20271114090000_text_storage.sql`) - the standard text and the columns
//!    its provenance is restored from ([`RemoteHand::into_phf`]).

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

/// The columns [`IngestClient::hands_phf`] reads.
pub const HAND_COLUMNS: &str =
    "hand_key,phf,standard_text,site,parser_version,source_filename,source_text,created_at";

/// One hand from the server: its PHF, or its standard text and the columns
/// a text-only row is restored from.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RemoteHand {
    pub hand_key: String,
    /// Null on a text-only row.
    #[serde(default)]
    pub phf: Option<Value>,
    #[serde(default)]
    pub standard_text: Option<String>,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub parser_version: Option<String>,
    #[serde(default)]
    pub source_filename: Option<String>,
    #[serde(default)]
    pub source_text: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl RemoteHand {
    /// The hand's PHF: the stored one, or its text parsed and restored
    /// ([`crate::stored_text::hand_of_stored_row`]). `None` when the text no
    /// longer parses with this build.
    pub fn into_phf(self) -> Option<Value> {
        let row = crate::stored_text::StoredColumns {
            hand_key: self.hand_key,
            site: self.site,
            parser_version: self.parser_version,
            source_filename: self.source_filename,
            source_text: self.source_text,
            created_at: self.created_at,
        };
        crate::stored_text::hand_of_stored_row(self.phf, self.standard_text.as_deref(), &row)
    }
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

    /// These hands (at most [`PHF_IDS_PER_CALL`] ids, UUIDs only), as
    /// stored: read each with [`RemoteHand::into_phf`].
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
            .append_pair("select", HAND_COLUMNS)
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

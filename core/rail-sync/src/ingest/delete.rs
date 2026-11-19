//! Deleting the account's hands on the server (2026-11-19,
//! `20271119200000_hand_deletion.sql`), under RLS with the account's token:
//!
//! 1. `delete_hands_by_key(p_keys)` - the hands deleted on this computer,
//!    at most [`DELETE_KEYS_PER_CALL`] a call; keys the server does not hold
//!    are ignored;
//! 2. `delete_all_hands('DELETE')` - every hand the account stored up to the
//!    first call of a wipe, a few seconds a call: called until `done`;
//! 3. `hand_tombstones_since(p_after_at, p_after_seq, p_limit)` - the
//!    deletions made elsewhere (the web, another computer), a keyset page by
//!    `(deleted_at, seq)`, rows older than a minute only. A row without a key
//!    and with `all_before` is a "delete every hand stored up to then".

use serde::Deserialize;

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;

/// Keys per `delete_hands_by_key` call (the server's limit).
pub const DELETE_KEYS_PER_CALL: usize = 200;

/// `delete_hands_by_key`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct KeysDeleted {
    pub deleted: u64,
    /// The keys the server held and deleted.
    #[serde(default)]
    pub keys: Vec<String>,
}

/// One call of `delete_all_hands`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct WipeStep {
    pub deleted: u64,
    pub remaining: u64,
    pub done: bool,
    /// The wipe's instant: hands stored up to it go.
    #[serde(default)]
    pub before: Option<String>,
}

/// One row of `hand_tombstones_since`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Tombstone {
    pub seq: i64,
    /// As the server wrote it: passed back unchanged as the cursor.
    pub deleted_at: String,
    #[serde(default)]
    pub hand_key: Option<String>,
    /// Set on a "delete every hand stored up to then" (ISO instant).
    #[serde(default)]
    pub all_before: Option<String>,
}

impl IngestClient {
    /// Delete these hands of the account (at most [`DELETE_KEYS_PER_CALL`]).
    pub async fn delete_hands_by_key(
        &self,
        token: &Secret,
        keys: &[String],
    ) -> Result<KeysDeleted, IngestError> {
        if keys.len() > DELETE_KEYS_PER_CALL {
            return Err(IngestError::Refused {
                status: 0,
                code: "too-many-keys".into(),
            });
        }
        let body = serde_json::json!({ "p_keys": keys }).to_string();
        let bytes = self.call(token, "delete_hands_by_key", body).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable delete_hands_by_key answer".into()))
    }

    /// One step of deleting every hand of the account.
    pub async fn delete_all_hands(&self, token: &Secret) -> Result<WipeStep, IngestError> {
        let body = serde_json::json!({ "p_confirm": "DELETE" }).to_string();
        let bytes = self.call(token, "delete_all_hands", body).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable delete_all_hands answer".into()))
    }

    /// A page of the account's deletions after the cursor (`None`: from
    /// the start), oldest first.
    pub async fn hand_tombstones_since(
        &self,
        token: &Secret,
        after: Option<(&str, i64)>,
        limit: u32,
    ) -> Result<Vec<Tombstone>, IngestError> {
        let body = serde_json::json!({
            "p_after_at": after.map(|(at, _)| at),
            "p_after_seq": after.map(|(_, seq)| seq),
            "p_limit": limit,
        })
        .to_string();
        let bytes = self.call(token, "hand_tombstones_since", body).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable hand_tombstones_since page".into()))
    }

    /// [`IngestClient::delete_hands_by_key`] with the account's token.
    pub async fn delete_hands_by_key_as(
        &self,
        account: &impl TokenSource,
        keys: &[String],
    ) -> Result<KeysDeleted, IngestError> {
        with_token(account, |token| async move {
            self.delete_hands_by_key(&token, keys).await
        })
        .await
    }

    /// [`IngestClient::delete_all_hands`] with the account's token.
    pub async fn delete_all_hands_as(
        &self,
        account: &impl TokenSource,
    ) -> Result<WipeStep, IngestError> {
        with_token(account, |token| async move {
            self.delete_all_hands(&token).await
        })
        .await
    }

    /// [`IngestClient::hand_tombstones_since`] with the account's token.
    pub async fn hand_tombstones_since_as(
        &self,
        account: &impl TokenSource,
        after: Option<(&str, i64)>,
        limit: u32,
    ) -> Result<Vec<Tombstone>, IngestError> {
        with_token(account, |token| async move {
            self.hand_tombstones_since(&token, after, limit).await
        })
        .await
    }
}

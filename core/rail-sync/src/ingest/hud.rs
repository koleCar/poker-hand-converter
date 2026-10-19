//! (R3.9) The HUD's designs and layouts on the server
//! (`supabase/migrations/20270602090000_hud_layouts.sql`), under RLS with the
//! account's token:
//!
//! 1. `put_hud_layouts(p_rows)` - this computer's changed rows; the server
//!    keeps each only when it is newer (`updatedAt`) than its own and says
//!    which it took;
//! 2. `GET /rest/v1/hud_layouts?select=kind,key,body,updated_at` - every row
//!    of the account (a few hundred at most; pages of 1 000, PostgREST's
//!    `max_rows`).

use rail_store::{HudSyncKind, HudSyncRow};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;

/// Rows per `put_hud_layouts` call (the server takes 500).
pub const HUD_ROWS_PER_PUT: usize = 500;
/// Rows per page of the read (PostgREST's `max_rows`).
pub const HUD_ROWS_PER_PAGE: usize = 1000;
/// Pages read at most (the server keeps at most 5 000 rows an account).
const MAX_PAGES: usize = 6;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PutRow<'a> {
    kind: &'static str,
    key: &'a str,
    body: &'a Option<Value>,
    updated_at: i64,
}

#[derive(Deserialize)]
struct Applied {
    kind: String,
    key: String,
    applied: bool,
}

#[derive(Deserialize)]
struct RemoteRow {
    kind: String,
    key: String,
    body: Option<Value>,
    updated_at: i64,
}

/// What the server did with one row sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutOutcome {
    pub kind: HudSyncKind,
    pub key: String,
    /// `false`: the server's row was as new or newer (the next read brings
    /// it).
    pub applied: bool,
}

impl IngestClient {
    /// Send up to [`HUD_ROWS_PER_PUT`] rows.
    pub async fn put_hud_layouts(
        &self,
        token: &Secret,
        rows: &[HudSyncRow],
    ) -> Result<Vec<PutOutcome>, IngestError> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        if rows.len() > HUD_ROWS_PER_PUT {
            return Err(IngestError::Refused {
                status: 0,
                code: "too-many".into(),
            });
        }
        let body: Vec<PutRow<'_>> = rows
            .iter()
            .map(|row| PutRow {
                kind: row.kind.as_str(),
                key: &row.key,
                body: &row.body,
                updated_at: row.updated_at,
            })
            .collect();
        let body = serde_json::json!({ "p_rows": body }).to_string();
        let bytes = self.call(token, "put_hud_layouts", body).await?;
        let applied: Vec<Applied> = serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable put_hud_layouts answer".into()))?;
        Ok(applied
            .into_iter()
            .filter_map(|row| {
                Some(PutOutcome {
                    kind: HudSyncKind::parse(&row.kind)?,
                    key: row.key,
                    applied: row.applied,
                })
            })
            .collect())
    }

    /// Every row of the account; a kind this build does not know is left
    /// out.
    pub async fn hud_layouts(&self, token: &Secret) -> Result<Vec<HudSyncRow>, IngestError> {
        let mut out = Vec::new();
        for page in 0..MAX_PAGES {
            let mut url = self
                .rest_base
                .join("hud_layouts")
                .unwrap_or_else(|_| self.rest_base.clone());
            url.query_pairs_mut()
                .append_pair("select", "kind,key,body,updated_at")
                .append_pair("order", "kind,key")
                .append_pair("limit", &HUD_ROWS_PER_PAGE.to_string())
                .append_pair("offset", &(page * HUD_ROWS_PER_PAGE).to_string());
            let bytes = self.send(token, self.http.get(url)).await?;
            let rows: Vec<RemoteRow> = serde_json::from_slice(&bytes)
                .map_err(|_| IngestError::Transient("unreadable hud_layouts page".into()))?;
            let full = rows.len() >= HUD_ROWS_PER_PAGE;
            out.extend(rows.into_iter().filter_map(|row| {
                Some(HudSyncRow {
                    kind: HudSyncKind::parse(&row.kind)?,
                    key: row.key,
                    body: row.body.filter(|body| !body.is_null()),
                    updated_at: row.updated_at,
                })
            }));
            if !full {
                break;
            }
        }
        Ok(out)
    }

    /// [`IngestClient::put_hud_layouts`] with the account's token.
    pub async fn put_hud_layouts_as(
        &self,
        account: &impl TokenSource,
        rows: &[HudSyncRow],
    ) -> Result<Vec<PutOutcome>, IngestError> {
        with_token(account, |token| async move {
            self.put_hud_layouts(&token, rows).await
        })
        .await
    }

    /// [`IngestClient::hud_layouts`] with the account's token.
    pub async fn hud_layouts_as(
        &self,
        account: &impl TokenSource,
    ) -> Result<Vec<HudSyncRow>, IngestError> {
        with_token(
            account,
            |token| async move { self.hud_layouts(&token).await },
        )
        .await
    }
}

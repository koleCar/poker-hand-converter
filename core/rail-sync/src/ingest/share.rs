//! A share link from the desktop app: `create_share()` (the web's "Share
//! hand", `supabase/migrations/20270623090000_share_names.sql`) with the
//! account's token.
//!
//! The hand travels as its PHF document and its standard text, as the web
//! sends a hand that is not in the account's library: the app does not know
//! the server's `hands.id` of a synced hand, and the link must not depend on
//! sync having run. Spoilers and names are off, the server's defaults and the
//! web's: the link hides the result in its title and the players' names.

use serde::Deserialize;
use serde_json::Value;

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;

/// What a new link is made of.
#[derive(Debug, Clone, Copy)]
pub struct ShareRequest<'a> {
    /// The hand's canonical PHF, as JSON text.
    pub phf_json: &'a str,
    /// The same hand in the standard text format (the shared page reads it).
    pub standard_text: &'a str,
    /// The link's title (no spoilers), or none.
    pub title: Option<&'a str>,
}

#[derive(Deserialize)]
struct Created {
    slug: String,
}

/// A slug as `generate_share_slug()` makes them: short, URL-safe.
pub fn is_share_slug(slug: &str) -> bool {
    (1..=64).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl IngestClient {
    /// A new share link for one hand: its slug.
    pub async fn create_share(
        &self,
        token: &Secret,
        request: ShareRequest<'_>,
    ) -> Result<String, IngestError> {
        let phf: Value = serde_json::from_str(request.phf_json)
            .map_err(|_| IngestError::Transient("unreadable hand".into()))?;
        let body = serde_json::json!({
            "p_hand_id": Value::Null,
            "p_phf": phf,
            "p_standard_text": request.standard_text,
            "p_title": request.title,
            "p_spoilers": false,
            "p_show_names": false,
        })
        .to_string();
        let bytes = self.call(token, "create_share", body).await?;
        let created: Created = serde_json::from_slice(&bytes)
            .map_err(|_| IngestError::Transient("unreadable share".into()))?;
        if !is_share_slug(&created.slug) {
            return Err(IngestError::Transient("unreadable share".into()));
        }
        Ok(created.slug)
    }

    /// [`IngestClient::create_share`] with the account's token (one refresh
    /// and retry after a `401`).
    pub async fn create_share_as(
        &self,
        account: &impl TokenSource,
        request: ShareRequest<'_>,
    ) -> Result<String, IngestError> {
        with_token(account, |token| async move {
            self.create_share(&token, request).await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::is_share_slug;

    #[test]
    fn a_slug_is_short_and_url_safe() {
        assert!(is_share_slug("aB3_x-9QzK"));
        assert!(!is_share_slug(""));
        assert!(!is_share_slug("a/b"));
        assert!(!is_share_slug("a b"));
        assert!(!is_share_slug(&"a".repeat(65)));
    }
}

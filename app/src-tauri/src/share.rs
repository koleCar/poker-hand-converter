//! "Share hand" from the hand panel: the web's share link
//! (`create_share()`, `rail_sync::ingest::share`), made with the account's
//! token from the hand in the local store, and opened in the default
//! browser on request.
//!
//! The window gets back the link to show and copy. Errors it words itself
//! come back as codes ([`SIGNED_OUT`], [`RATE_LIMITED`], [`UNAVAILABLE`],
//! [`MISSING`]); anything else is a sentence.

use rail_core::phf::PhfHand;
use rail_core::phf::serialize::to_standard_text;
use rail_sync::ingest::{IngestClient, IngestError, ShareRequest, is_share_slug};
use serde::Serialize;
use tauri::State;

use crate::account::{AccountState, web_url};
use crate::commands::StoreState;

/// Not signed in: a link needs an account (opening one never does).
pub const SIGNED_OUT: &str = "signedOut";
/// The account made too many links this hour.
pub const RATE_LIMITED: &str = "rateLimited";
/// This build has no account (no Supabase configured).
pub const UNAVAILABLE: &str = "unavailable";
/// The store has no such hand.
pub const MISSING: &str = "missing";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDto {
    pub slug: String,
    pub url: String,
}

/// `<web>/h/<slug>`, the web's shared-hand page.
fn share_url(origin: &str, slug: &str) -> Result<String, String> {
    let base = url::Url::parse(origin).map_err(|error| error.to_string())?;
    base.join(&format!("h/{slug}"))
        .map(String::from)
        .map_err(|error| error.to_string())
}

fn code_of(error: IngestError) -> String {
    match error {
        IngestError::SignedOut | IngestError::Unauthorized => SIGNED_OUT.to_owned(),
        IngestError::RateLimited { .. } => RATE_LIMITED.to_owned(),
        other => other.to_string(),
    }
}

/// A new share link for a hand in the store.
#[tauri::command]
pub async fn hand_share(
    store: State<'_, StoreState>,
    account: State<'_, AccountState>,
    hand_key: String,
    title: Option<String>,
) -> Result<ShareDto, String> {
    let account = account.0.clone().ok_or_else(|| UNAVAILABLE.to_owned())?;
    if account.user().is_none() {
        return Err(SIGNED_OUT.to_owned());
    }
    let phf_json = store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())?
        .reader()
        .hand_phf(&hand_key)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| MISSING.to_owned())?;
    let hand: PhfHand =
        serde_json::from_str(&phf_json).map_err(|error| format!("unreadable hand: {error}"))?;
    let standard_text = to_standard_text(&hand);
    let title = title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| title.chars().take(200).collect::<String>());

    let client = IngestClient::new(account.config()).map_err(code_of)?;
    let slug = client
        .create_share_as(
            account.as_ref(),
            ShareRequest {
                phf_json: &phf_json,
                standard_text: &standard_text,
                title: title.as_deref(),
            },
        )
        .await
        .map_err(code_of)?;
    let url = share_url(&web_url(), &slug)?;
    Ok(ShareDto { slug, url })
}

/// Open a share link made here in the default browser. Takes the slug, not
/// a URL: the address is always the web's own.
#[tauri::command]
pub fn share_open(slug: String) -> Result<(), String> {
    if !is_share_slug(&slug) {
        return Err("not a share link".to_owned());
    }
    let url = share_url(&web_url(), &slug)?;
    open::that_detached(url).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::share_url;

    #[test]
    fn a_link_is_the_web_page_of_its_slug() {
        assert_eq!(
            share_url("https://poker-hand-converter.vercel.app", "aB3_x-9QzK").as_deref(),
            Ok("https://poker-hand-converter.vercel.app/h/aB3_x-9QzK")
        );
        assert_eq!(
            share_url("http://localhost:3000/", "abc").as_deref(),
            Ok("http://localhost:3000/h/abc")
        );
    }
}

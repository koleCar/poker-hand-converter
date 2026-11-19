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

/// The owner's names switch on a link made here; the state the server kept.
#[tauri::command]
pub async fn share_set_names(
    account: State<'_, AccountState>,
    slug: String,
    show: bool,
) -> Result<bool, String> {
    let account = account.0.clone().ok_or_else(|| UNAVAILABLE.to_owned())?;
    if account.user().is_none() {
        return Err(SIGNED_OUT.to_owned());
    }
    let client = IngestClient::new(account.config()).map_err(code_of)?;
    client
        .set_share_names_as(account.as_ref(), &slug, show)
        .await
        .map_err(code_of)
}

/// `<web>/submit/preview#text=<base64url of the gzipped standard text>`: the
/// web's post preview, with the hand in the fragment, which the browser
/// never sends to a server. The author picks the post's settings there and
/// sees the post before anything is published.
fn forum_preview_url(origin: &str, standard_text: &str) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::Write as _;

    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    gzip.write_all(standard_text.as_bytes())
        .map_err(|error| error.to_string())?;
    let packed = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(gzip.finish().map_err(|error| error.to_string())?);
    let mut url = url::Url::parse(origin)
        .and_then(|base| base.join("submit/preview"))
        .map_err(|error| error.to_string())?;
    url.set_fragment(Some(&format!("text={packed}")));
    Ok(url.into())
}

/// "Post to the forum" from the share panel: the web's post preview for a
/// hand in the store, in the default browser. Needs no account here: the web
/// page asks for one when the author posts.
#[tauri::command]
pub fn forum_preview_open(store: State<'_, StoreState>, hand_key: String) -> Result<(), String> {
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
    let url = forum_preview_url(&web_url(), &to_standard_text(&hand))?;
    open::that_detached(url).map_err(|error| error.to_string())
}

/// `<web>/analysis/hand?key=<hand key>&t=<replayer position>`: the web's
/// page for a hand of the account's library by its dedupe key, which the web
/// resolves to the hand's own page (or says it has not synced yet).
fn hand_web_url(origin: &str, hand_key: &str, position: Option<&str>) -> Result<String, String> {
    let mut url = url::Url::parse(origin)
        .and_then(|base| base.join("analysis/hand"))
        .map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("key", hand_key);
        if let Some(position) = position.filter(|p| !p.is_empty()) {
            query.append_pair("t", position);
        }
    }
    Ok(url.into())
}

/// "Open on the web" in a hand's panel: the hand in the web's library, at
/// the replayer's position, in the default browser. The web asks for the
/// account when the browser is not signed in.
#[tauri::command]
pub fn hand_web_open(hand_key: String, position: Option<String>) -> Result<(), String> {
    let url = hand_web_url(&web_url(), &hand_key, position.as_deref())?;
    open::that_detached(url).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{forum_preview_url, hand_web_url, share_url};

    #[test]
    fn a_hand_on_the_web_is_its_key_and_position() {
        assert_eq!(
            hand_web_url(
                "https://poker-hand-converter.vercel.app",
                "pokerstars:2551 x&y",
                Some("a12")
            )
            .as_deref(),
            Ok(
                "https://poker-hand-converter.vercel.app/analysis/hand?key=pokerstars%3A2551+x%26y&t=a12"
            )
        );
        assert_eq!(
            hand_web_url("http://localhost:3000/", "gg:1", None).as_deref(),
            Ok("http://localhost:3000/analysis/hand?key=gg%3A1")
        );
    }

    #[test]
    fn the_forum_preview_carries_the_hand_in_its_fragment() -> Result<(), String> {
        use base64::Engine as _;
        use std::io::Read as _;

        let text = "Poker Hand #1: Hold'em No Limit ($0.10/$0.20)\nSeat 1: Hero ($20)";
        let url = forum_preview_url("https://poker-hand-converter.vercel.app", text)?;
        let (base, fragment) = url.split_once('#').ok_or("no fragment")?;
        assert_eq!(
            base,
            "https://poker-hand-converter.vercel.app/submit/preview"
        );
        let packed = fragment.strip_prefix("text=").ok_or("no text")?;
        assert!(
            packed
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(packed)
            .map_err(|error| error.to_string())?;
        let mut out = String::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_string(&mut out)
            .map_err(|error| error.to_string())?;
        assert_eq!(out, text);
        Ok(())
    }

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

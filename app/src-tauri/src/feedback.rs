//! "Feedback" in the sidebar and the palette: a bug report, a feature
//! request or a question, with up to three screenshots, sent to the Edge
//! Function `feedback` (`rail_sync::feedback`).
//!
//! The window sends what the user wrote and the screen it was on; this adds
//! the app's version and the platform, and the account's token when signed
//! in (the report then carries the account; signed out it is a visitor's).
//! Errors come back as the function's codes, or `offline`, which the window
//! words.

use rail_sync::feedback::FeedbackClient;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::account::AccountState;

/// This build has no account service (no Supabase configured).
const UNAVAILABLE: &str = "unavailable";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    pub kind: String,
    pub message: String,
    pub email: Option<String>,
    pub website: String,
    /// Data URLs, at most three (the function checks).
    pub images: Vec<String>,
    /// The screen the dialog was opened on.
    pub page: String,
    pub locale: String,
}

fn body(input: FeedbackInput, app_version: &str) -> serde_json::Value {
    let images: Vec<_> = input
        .images
        .into_iter()
        .map(|data| serde_json::json!({ "data": data }))
        .collect();
    serde_json::json!({
        "kind": input.kind,
        "message": input.message,
        "email": input.email,
        "website": input.website,
        "images": images,
        "source": "app",
        "page": input.page,
        "appVersion": app_version,
        "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "locale": input.locale,
    })
}

/// Send one report; `Err` is a code.
#[tauri::command]
pub async fn feedback_send(
    app: AppHandle,
    account: State<'_, AccountState>,
    input: FeedbackInput,
) -> Result<(), String> {
    let account = account.0.clone().ok_or_else(|| UNAVAILABLE.to_owned())?;
    let client = FeedbackClient::new(account.config()).map_err(|error| error.code().to_owned())?;
    let token = if account.user().is_some() {
        account.access_token().await
    } else {
        None
    };
    let version = app.package_info().version.to_string();
    client
        .send(token.as_ref(), &body(input, &version))
        .await
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_adds_the_source_version_and_platform() {
        let value = body(
            FeedbackInput {
                kind: "bug".into(),
                message: "Replayer froze".into(),
                email: None,
                website: String::new(),
                images: vec!["data:image/png;base64,iVBORw0KGgo=".into()],
                page: "hands".into(),
                locale: "en".into(),
            },
            "0.9.1",
        );
        assert_eq!(value["source"], "app");
        assert_eq!(value["appVersion"], "0.9.1");
        assert_eq!(value["page"], "hands");
        assert_eq!(value["email"], serde_json::Value::Null);
        assert_eq!(
            value["images"][0]["data"],
            "data:image/png;base64,iVBORw0KGgo="
        );
        assert!(
            value["platform"]
                .as_str()
                .is_some_and(|platform| platform.starts_with(std::env::consts::OS))
        );
    }
}

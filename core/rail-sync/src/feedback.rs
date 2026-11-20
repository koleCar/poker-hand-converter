//! Feedback from the desktop app: a bug report, a feature request or a
//! question, with up to three screenshots, sent to the Edge Function
//! `feedback` (`supabase/functions/feedback/handler.ts`).
//!
//! The body is the function's JSON as the window built it (the images are
//! data URLs); this module only adds the transport: the anon key, and the
//! account's token when signed in so the report carries the account.
//!
//! Errors come back as the function's codes (`invalid_request`,
//! `too_large`, `rate_limited`, `unavailable`) or `offline` when the request
//! never got an answer. The window words each one.

use std::time::Duration;

use url::Url;

use crate::auth::{AuthConfig, Secret};

/// Three screenshots of up to 3 MB on a slow uplink.
const TIMEOUT: Duration = Duration::from_secs(90);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The function's refusals the window knows; anything else is `unavailable`.
const KNOWN: [&str; 4] = [
    "invalid_request",
    "too_large",
    "rate_limited",
    "unavailable",
];

/// Why a report was not stored, as a code for the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedbackError {
    /// The function answered with one of its codes.
    Refused(&'static str),
    /// No answer: no connection, DNS, TLS, a timeout.
    Offline,
}

impl FeedbackError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Offline => "offline",
        }
    }
}

/// The function's answer to a refused call, as a code.
pub fn refusal(status: u16, body: &[u8]) -> FeedbackError {
    let named = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
        .and_then(|code| KNOWN.into_iter().find(|known| *known == code));
    FeedbackError::Refused(named.unwrap_or(match status {
        413 => "too_large",
        429 => "rate_limited",
        _ => "unavailable",
    }))
}

#[derive(Debug, Clone)]
pub struct FeedbackClient {
    http: reqwest::Client,
    endpoint: Url,
    anon_key: Secret,
}

impl FeedbackClient {
    pub fn new(config: &AuthConfig) -> Result<Self, FeedbackError> {
        // As in `auth::gotrue`: reqwest without a default crypto provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("Rail/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| FeedbackError::Refused("unavailable"))?;
        let endpoint = config
            .supabase_url
            .join("functions/v1/feedback")
            .map_err(|_| FeedbackError::Refused("unavailable"))?;
        Ok(Self {
            http,
            endpoint,
            anon_key: config.anon_key.clone(),
        })
    }

    /// Send one report. `token`: the account's access token, or `None` to
    /// send it as a visitor's.
    pub async fn send(
        &self,
        token: Option<&Secret>,
        body: &serde_json::Value,
    ) -> Result<(), FeedbackError> {
        let bearer = token.unwrap_or(&self.anon_key);
        let response = self
            .http
            .post(self.endpoint.clone())
            .header("apikey", self.anon_key.expose())
            .bearer_auth(bearer.expose())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| FeedbackError::Offline)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|_| FeedbackError::Offline)?;
        if (200..300).contains(&status) {
            return Ok(());
        }
        Err(refusal(status, &bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_refusal_keeps_its_code() {
        assert_eq!(
            refusal(429, br#"{"error":"rate_limited"}"#).code(),
            "rate_limited"
        );
        assert_eq!(
            refusal(400, br#"{"error":"invalid_request"}"#).code(),
            "invalid_request"
        );
        assert_eq!(
            refusal(413, br#"{"error":"too_large"}"#).code(),
            "too_large"
        );
    }

    #[test]
    fn an_unknown_or_unreadable_refusal_falls_back_on_the_status() {
        assert_eq!(refusal(413, b"Payload Too Large").code(), "too_large");
        assert_eq!(refusal(429, b"").code(), "rate_limited");
        assert_eq!(refusal(502, b"<html>").code(), "unavailable");
        assert_eq!(
            refusal(400, br#"{"error":"surprise"}"#).code(),
            "unavailable"
        );
    }

    #[test]
    fn the_endpoint_is_the_projects_function() -> Result<(), FeedbackError> {
        let config = AuthConfig::new(
            "https://abcdefghijklmnopqrst.supabase.co",
            "anon-key",
            "https://rail.example",
        )
        .map_err(|_| FeedbackError::Refused("unavailable"))?;
        let client = FeedbackClient::new(&config)?;
        assert_eq!(
            client.endpoint.as_str(),
            "https://abcdefghijklmnopqrst.supabase.co/functions/v1/feedback"
        );
        Ok(())
    }
}

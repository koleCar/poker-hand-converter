//! The account's public name, as the desktop app reads and sets it:
//!
//! - `my_profile()` (`20261007090000_forum_identity.sql`): the username and
//!   whether it is still the provisional `user_xxxxxxxx` from signup;
//! - `set_username(p_username)`: choose it, once
//!   (`20271116130000_username_set_once.sql`). A refusal (the shape, taken,
//!   reserved, already chosen) is SQLSTATE `22023` with the sentence to show,
//!   which comes back as [`SetUsernameError::Refused`].
//!
//! The name is what other people see instead of the email.

use serde::Deserialize;

use super::{IngestClient, IngestError, PostgrestError, TokenSource, error_of, with_token};
use crate::auth::{ApiError, Secret};

/// The part of `my_profile()` the app shows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub username: String,
    /// Still the name handed out at signup: the account can choose its own.
    pub provisional: bool,
}

/// Why `set_username` did not set the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetUsernameError {
    /// The server's sentence (`22023`): taken, reserved, the shape, or the
    /// name is already chosen.
    Refused(String),
    /// Anything else: signed out, offline, ...
    Ingest(IngestError),
}

impl From<IngestError> for SetUsernameError {
    fn from(error: IngestError) -> Self {
        Self::Ingest(error)
    }
}

/// The username a `set_username` answer names.
#[derive(Deserialize)]
struct UsernameChange {
    username: String,
}

impl IngestClient {
    /// The signed-in account's profile; `None` when the database has none for
    /// it (an account created while the signup trigger was missing).
    pub async fn my_profile(&self, token: &Secret) -> Result<Option<AccountProfile>, IngestError> {
        let bytes = self.call(token, "my_profile", "{}".to_owned()).await?;
        serde_json::from_slice::<Option<AccountProfile>>(&bytes)
            .map_err(|_| IngestError::Transient("unreadable profile".into()))
    }

    /// [`IngestClient::my_profile`] with the account's token (one refresh and
    /// retry after a `401`).
    pub async fn my_profile_as(
        &self,
        account: &impl TokenSource,
    ) -> Result<Option<AccountProfile>, IngestError> {
        with_token(
            account,
            |token| async move { self.my_profile(&token).await },
        )
        .await
    }

    /// Choose the account's username, once. The name as the server kept it.
    pub async fn set_username(
        &self,
        token: &Secret,
        username: &str,
    ) -> Result<String, SetUsernameError> {
        let body = serde_json::json!({ "p_username": username.trim() }).to_string();
        let response = self
            .http
            .post(self.endpoint("set_username"))
            .body(body)
            .header("apikey", self.anon_key.expose())
            .bearer_auth(token.expose())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| IngestError::Transient(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| IngestError::Transient(error.without_url().to_string()))?;
        if (200..300).contains(&status) {
            return serde_json::from_slice::<UsernameChange>(&bytes)
                .map(|change| change.username)
                .map_err(|_| IngestError::Transient("unreadable answer".into()).into());
        }
        if let Some(message) = refusal_of(&bytes) {
            return Err(SetUsernameError::Refused(message));
        }
        Err(error_of(status, &bytes).into())
    }

    /// [`IngestClient::set_username`] with the account's token (one refresh
    /// and retry after a `401`).
    pub async fn set_username_as(
        &self,
        account: &impl TokenSource,
        username: &str,
    ) -> Result<String, SetUsernameError> {
        let token = account.access_token().await.ok_or(IngestError::SignedOut)?;
        match self.set_username(&token, username).await {
            Err(SetUsernameError::Ingest(IngestError::Unauthorized)) => {}
            other => return other,
        }
        // The session may have been revoked or rotated elsewhere: refresh once.
        match account.refresh().await {
            Ok(()) => {}
            Err(ApiError::Rejected { .. }) => return Err(IngestError::SignedOut.into()),
            Err(ApiError::Transient(why)) => return Err(IngestError::Transient(why).into()),
        }
        let token = account.access_token().await.ok_or(IngestError::SignedOut)?;
        self.set_username(&token, username).await
    }
}

/// A `22023` refusal's sentence, kept short and printable.
fn refusal_of(body: &[u8]) -> Option<String> {
    let error = serde_json::from_slice::<PostgrestError>(body).ok()?;
    if error.code.as_deref() != Some("22023") {
        return None;
    }
    let message = error.message?;
    let message = message.trim();
    (!message.is_empty() && message.len() <= 300 && !message.chars().any(char::is_control))
        .then(|| message.to_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_profile_the_app_shows() {
        let bytes =
            br#"{"id":"x","username":"river_rat","provisional":false,"role":"member","karma":3}"#;
        let profile: Option<AccountProfile> = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            profile,
            Some(AccountProfile {
                username: "river_rat".into(),
                provisional: false
            })
        );
        let none: Option<AccountProfile> = serde_json::from_slice(b"null").unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn a_refusal_is_the_servers_sentence() {
        let body =
            br#"{"code":"22023","message":"That username is taken.","details":null,"hint":null}"#;
        assert_eq!(refusal_of(body).as_deref(), Some("That username is taken."));
        let other = br#"{"code":"42501","message":"You must be signed in to choose a username."}"#;
        assert_eq!(refusal_of(other), None);
        assert_eq!(refusal_of(b"not json"), None);
    }
}

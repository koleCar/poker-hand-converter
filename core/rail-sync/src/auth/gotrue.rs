//! Supabase Auth (GoTrue) over HTTPS: the three calls the desktop session
//! needs, and nothing else.
//!
//! - `POST /auth/v1/verify {type: "magiclink", token_hash}`: redeem the
//!   handoff's one-time token for a session of the app's own;
//! - `POST /auth/v1/token?grant_type=refresh_token`: rotate it;
//! - `POST /auth/v1/logout?scope=local`: end this session (only this one:
//!   the browser's stays signed in).
//!
//! None of them needs a captcha: Turnstile guards sign-up, password sign-in
//! and the email endpoints, which the app never calls.

use std::future::Future;
use std::time::Duration;

use serde::Deserialize;
use url::Url;

use super::AuthConfig;
use super::secret::Secret;

/// A session as GoTrue returns it.
#[derive(Debug)]
pub struct Session {
    pub access_token: Secret,
    pub refresh_token: Secret,
    /// The access token's lifetime from now (`expires_in`): scheduled on the
    /// monotonic clock, so a wrong system clock does not matter.
    pub expires_in: Duration,
    pub user: SessionUser,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionUser {
    pub id: String,
    pub email: String,
}

/// Why a call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// GoTrue answered and refused: the token is invalid, expired, already
    /// used or revoked, the session or user is gone. Retrying cannot help.
    /// `code` is GoTrue's `error_code` (or `error`), for the log.
    Rejected { status: u16, code: String },
    /// No answer, a 5xx, a 429 or an answer we could not read: try again
    /// later. Never carries a response body.
    Transient(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected { status, code } => write!(f, "refused ({status} {code})"),
            Self::Transient(why) => write!(f, "not reachable: {why}"),
        }
    }
}

impl std::error::Error for ApiError {}

/// The auth server, as the account manager sees it (a fake in tests).
pub trait AuthApi: Send + Sync + 'static {
    fn verify(&self, token_hash: &Secret)
    -> impl Future<Output = Result<Session, ApiError>> + Send;
    fn refresh(
        &self,
        refresh_token: &Secret,
    ) -> impl Future<Output = Result<Session, ApiError>> + Send;
    fn logout(&self, access_token: &Secret) -> impl Future<Output = Result<(), ApiError>> + Send;
}

/// The real thing: reqwest with rustls (ring) and the OS certificate
/// verifier.
#[derive(Debug, Clone)]
pub struct GoTrue {
    http: reqwest::Client,
    auth_base: Url,
    anon_key: Secret,
}

const TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

impl GoTrue {
    pub fn new(config: &AuthConfig) -> Result<Self, ApiError> {
        // reqwest is built without a default crypto provider (no aws-lc-rs);
        // install ring once per process. A second install is refused, which
        // is fine: one is installed.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("Rail/", env!("CARGO_PKG_VERSION")))
            // Never follow a redirect with a token in the body.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| ApiError::Transient(format!("http client: {error}")))?;
        let auth_base = config
            .supabase_url
            .join("auth/v1/")
            .map_err(|_| ApiError::Transient("bad Supabase URL".into()))?;
        Ok(Self {
            http,
            auth_base,
            anon_key: config.anon_key.clone(),
        })
    }

    fn endpoint(&self, path: &str) -> Url {
        // `path` is one of our literals, so this cannot fail.
        self.auth_base
            .join(path)
            .unwrap_or_else(|_| self.auth_base.clone())
    }

    async fn session(&self, request: reqwest::RequestBuilder) -> Result<Session, ApiError> {
        let response = request
            .header("apikey", self.anon_key.expose())
            .send()
            .await
            .map_err(transient)?;
        let status = response.status();
        if !status.is_success() {
            return Err(refusal(response).await);
        }
        let body: SessionBody = response
            .json()
            .await
            .map_err(|_| ApiError::Transient(format!("unreadable session ({status})")))?;
        body.into_session()
    }
}

impl AuthApi for GoTrue {
    async fn verify(&self, token_hash: &Secret) -> Result<Session, ApiError> {
        let body = serde_json::json!({ "type": "magiclink", "token_hash": token_hash.expose() });
        self.session(self.http.post(self.endpoint("verify")).json(&body))
            .await
    }

    async fn refresh(&self, refresh_token: &Secret) -> Result<Session, ApiError> {
        let body = serde_json::json!({ "refresh_token": refresh_token.expose() });
        let mut url = self.endpoint("token");
        url.set_query(Some("grant_type=refresh_token"));
        self.session(self.http.post(url).json(&body)).await
    }

    async fn logout(&self, access_token: &Secret) -> Result<(), ApiError> {
        let mut url = self.endpoint("logout");
        url.set_query(Some("scope=local"));
        let response = self
            .http
            .post(url)
            .header("apikey", self.anon_key.expose())
            .bearer_auth(access_token.expose())
            .send()
            .await
            .map_err(transient)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(refusal(response).await)
        }
    }
}

fn transient(error: reqwest::Error) -> ApiError {
    // reqwest's Display carries the URL (no secrets: they travel in bodies
    // and headers) and the cause; keep it for the log.
    ApiError::Transient(error.without_url().to_string())
}

/// 4xx except 408/429 is a refusal; everything else is worth retrying.
async fn refusal(response: reqwest::Response) -> ApiError {
    let status = response.status().as_u16();
    if !(400..500).contains(&status) || status == 408 || status == 429 {
        return ApiError::Transient(format!("HTTP {status}"));
    }
    let body: ErrorBody = response.json().await.unwrap_or_default();
    let code = body
        .error_code
        .or(body.error)
        .filter(|code| code.len() <= 64 && code.bytes().all(|b| b.is_ascii_graphic()))
        .unwrap_or_else(|| "unknown".into());
    ApiError::Rejected { status, code }
}

#[derive(Deserialize, Default)]
struct ErrorBody {
    error_code: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct SessionBody {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    user: UserBody,
}

#[derive(Deserialize)]
struct UserBody {
    id: String,
    email: Option<String>,
}

impl SessionBody {
    fn into_session(self) -> Result<Session, ApiError> {
        if self.access_token.is_empty() || self.refresh_token.is_empty() {
            return Err(ApiError::Transient("session without tokens".into()));
        }
        Ok(Session {
            access_token: Secret::new(self.access_token),
            refresh_token: Secret::new(self.refresh_token),
            // GoTrue says 3600; never schedule tighter than a minute.
            expires_in: Duration::from_secs(self.expires_in.clamp(60, 7 * 24 * 3600)),
            user: SessionUser {
                id: self.user.id,
                email: self.user.email.unwrap_or_default(),
            },
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_session_body_reads_and_hides_its_tokens() {
        let body: SessionBody = serde_json::from_str(
            r#"{"access_token":"aaa.bbb.ccc","token_type":"bearer","expires_in":3600,"expires_at":1790000000,
                "refresh_token":"r3fr3sh","user":{"id":"00000000-0000-0000-0000-0000000a0a01","email":"p@example.test","aud":"authenticated"}}"#,
        )
        .unwrap();
        let session = body.into_session().unwrap();
        assert_eq!(session.expires_in, Duration::from_secs(3600));
        assert_eq!(session.user.email, "p@example.test");
        let printed = format!("{session:?}");
        assert!(
            !printed.contains("r3fr3sh") && !printed.contains("aaa.bbb"),
            "{printed}"
        );
    }

    #[test]
    fn endpoints_are_under_auth_v1() {
        let config =
            AuthConfig::new("http://127.0.0.1:55721", "anon", "http://localhost:3000").unwrap();
        let client = GoTrue::new(&config).unwrap();
        assert_eq!(
            client.endpoint("verify").as_str(),
            "http://127.0.0.1:55721/auth/v1/verify"
        );
        assert_eq!(client.endpoint("token").path(), "/auth/v1/token");
    }
}

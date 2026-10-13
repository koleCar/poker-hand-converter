//! The desktop app's own Supabase account session (docs/RAIL-PLAN.md R1.7).
//!
//! - [`handoff`]: the `rail://` sign-in handoff - key pair, state, the
//!   payload's decryption, strict parsing of the callback;
//! - [`gotrue`]: the three auth calls (verify, refresh, logout);
//! - [`account`]: the manager - sign-in in progress, the session, refresh in
//!   the background, sign-out, and what the UI shows.
//!
//! The session is the app's **own**: the handoff carries a one-time token
//! that GoTrue turns into a fresh session with its own refresh-token chain.
//! The browser's refresh token never reaches the app; copying it would make
//! the two clients rotate one chain, and GoTrue's reuse detection would end
//! both.

pub mod account;
pub mod gotrue;
pub mod handoff;
pub mod secret;

use url::Url;

pub use account::{Account, AccountStatus, MemoryStore, Notice, SecretStore};
pub use gotrue::{ApiError, AuthApi, GoTrue, Session, SessionUser};
pub use handoff::{Callback, Handoff, HandoffError, PendingSignIn};
pub use secret::Secret;

/// Where the account lives: the Supabase project, its public anon key, and
/// the web app whose `/auth/desktop` page signs the user in.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub supabase_url: Url,
    /// Public by design (it is in the web's JavaScript too); a `Secret` only
    /// so it stays out of logs.
    pub anon_key: Secret,
    pub web_url: Url,
}

/// Why a configuration was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub &'static str);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for ConfigError {}

impl AuthConfig {
    /// Both URLs must be `https`, or `http` on the loopback interface (a
    /// local Supabase stack and `next dev`). Paths, queries and fragments are
    /// dropped: only the origin is used.
    pub fn new(supabase_url: &str, anon_key: &str, web_url: &str) -> Result<Self, ConfigError> {
        let supabase_url = origin(supabase_url).ok_or(ConfigError("Supabase URL"))?;
        let web_url = origin(web_url).ok_or(ConfigError("web URL"))?;
        let anon_key = anon_key.trim();
        if anon_key.is_empty() || !anon_key.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(ConfigError("anon key"));
        }
        Ok(Self {
            supabase_url,
            anon_key: Secret::new(anon_key),
            web_url,
        })
    }

    /// The host the session belongs to: names the keychain entry, so a
    /// development build against a local stack never touches the real
    /// account's entry.
    pub fn project_host(&self) -> String {
        match (self.supabase_url.host_str(), self.supabase_url.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_owned(),
            _ => "unknown".to_owned(),
        }
    }
}

fn origin(text: &str) -> Option<Url> {
    let url = Url::parse(text.trim()).ok()?;
    let host = url.host_str()?;
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !allowed || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let mut origin = url;
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    Some(origin)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn config_takes_https_or_loopback_http_only() {
        let ok = AuthConfig::new(
            "https://abc.supabase.co/rest?x",
            " key ",
            "https://rail.example/x",
        )
        .unwrap();
        assert_eq!(ok.supabase_url.as_str(), "https://abc.supabase.co/");
        assert_eq!(ok.web_url.as_str(), "https://rail.example/");
        assert_eq!(ok.anon_key.expose(), "key");
        assert_eq!(ok.project_host(), "abc.supabase.co");
        let local =
            AuthConfig::new("http://127.0.0.1:55721", "k", "http://localhost:3000").unwrap();
        assert_eq!(local.project_host(), "127.0.0.1:55721");
        for (supabase, web) in [
            ("http://abc.supabase.co", "https://rail.example"),
            ("https://abc.supabase.co", "http://rail.example"),
            ("https://user:pw@abc.supabase.co", "https://rail.example"),
            ("ftp://abc", "https://rail.example"),
            ("not a url", "https://rail.example"),
        ] {
            assert!(
                AuthConfig::new(supabase, "k", web).is_err(),
                "{supabase} {web}"
            );
        }
        assert!(AuthConfig::new("https://a.supabase.co", "", "https://r.example").is_err());
    }
}

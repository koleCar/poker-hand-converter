//! The desktop sign-in, end to end, against a **local** Supabase stack with
//! the `desktop-handoff` function served (docs/RAIL-PLAN.md R1.7). Not run in
//! CI: it needs Docker. `supabase/functions/desktop-handoff/e2e.sh` sets the
//! stack's URL and keys and a fresh confirmed test user, then runs this:
//!
//! ```text
//! RAIL_E2E_SUPABASE_URL=http://127.0.0.1:55721 RAIL_E2E_ANON_KEY=... \
//! RAIL_E2E_EMAIL=... RAIL_E2E_PASSWORD=... \
//!   cargo run -p rail-sync --example desktop_sign_in_e2e
//! ```
//!
//! The browser's part (sign in, click "Sign in to Rail") is played by plain
//! HTTP calls - the same ones `/auth/desktop` makes; the app's part is the
//! real `rail_sync::auth::Account` with the real GoTrue client. It checks:
//!
//! 1. the function refuses a call without a JWT, and a forged one;
//! 2. the handoff signs the app in as the web user;
//! 3. the link is useless to a second app instance, and spent once used;
//!    the one-time token cannot be redeemed twice;
//! 4. the app's session is its own: refreshing either side does not end the
//!    other, and signing the app out leaves the browser signed in;
//! 5. the per-account budget closes after 10 handoffs an hour.
//!
//! Prints no token, key or password.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use rail_sync::auth::{
    Account, AccountStatus, ApiError, AuthApi, AuthConfig, GoTrue, MemoryStore, Notice,
    PendingSignIn, Secret,
};
use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; see the header"))
}

struct Ctx {
    http: reqwest::Client,
    url: String,
    anon: String,
}

impl Ctx {
    async fn password_sign_in(&self, email: &str, password: &str) -> (Secret, Secret) {
        // Local Turnstile uses Cloudflare's always-pass test secret
        // (supabase/config.toml), which accepts this dummy token.
        let response = self
            .http
            .post(format!("{}/auth/v1/token?grant_type=password", self.url))
            .header("apikey", &self.anon)
            .json(&json!({
                "email": email,
                "password": password,
                "gotrue_meta_security": { "captcha_token": "XXXX.DUMMY.TOKEN.XXXX" }
            }))
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "web sign-in: {}",
            response.status()
        );
        let body: Value = response.json().await.unwrap();
        (
            Secret::new(body["access_token"].as_str().unwrap()),
            Secret::new(body["refresh_token"].as_str().unwrap()),
        )
    }

    /// What `/auth/desktop` sends after the click.
    async fn handoff(&self, jwt: Option<&str>, public: &str, state: &str) -> (u16, Value) {
        let mut request = self
            .http
            .post(format!("{}/functions/v1/desktop-handoff", self.url))
            .header("apikey", &self.anon)
            .json(&json!({ "v": 1, "pub": public, "state": state }));
        if let Some(jwt) = jwt {
            request = request.bearer_auth(jwt);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn user_id(&self, access: &Secret) -> Option<String> {
        let response = self
            .http
            .get(format!("{}/auth/v1/user", self.url))
            .header("apikey", &self.anon)
            .bearer_auth(access.expose())
            .send()
            .await
            .unwrap();
        if !response.status().is_success() {
            return None;
        }
        let body: Value = response.json().await.unwrap();
        body["id"].as_str().map(str::to_owned)
    }
}

fn query(url: &url::Url, key: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap()
}

fn step(text: &str) {
    println!("ok  {text}");
}

#[tokio::main]
async fn main() {
    let url = env("RAIL_E2E_SUPABASE_URL");
    let anon = env("RAIL_E2E_ANON_KEY");
    let email = env("RAIL_E2E_EMAIL");
    let password = env("RAIL_E2E_PASSWORD");
    let config = AuthConfig::new(&url, &anon, "http://localhost:3000").unwrap();
    let gotrue = GoTrue::new(&config).unwrap();
    let ctx = Ctx {
        http: reqwest::Client::new(),
        url: url.trim_end_matches('/').to_owned(),
        anon: anon.clone(),
    };

    // The browser signs in, as on the web (with the captcha).
    let (web_access, web_refresh) = ctx.password_sign_in(&email, &password).await;
    let web_user = ctx.user_id(&web_access).await.expect("web session works");
    step("the browser is signed in");

    // The app starts a sign-in.
    let store = Arc::new(MemoryStore::default());
    let account = Account::new(
        config.clone(),
        gotrue.clone(),
        Box::new(Arc::clone(&store)),
        Box::new(|| {}),
    );
    let page = account.begin_sign_in().unwrap();
    assert_eq!(page.path(), "/auth/desktop");
    let (public, state) = (query(&page, "pub"), query(&page, "state"));

    // 1. No JWT, a forged JWT.
    let (status, _) = ctx.handoff(None, &public, &state).await;
    assert_eq!(status, 401, "no JWT");
    let forged = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2lnbmF0dXJlLW5vdC12YWxpZA";
    let (status, _) = ctx.handoff(Some(forged), &public, &state).await;
    assert_eq!(status, 401, "forged JWT");
    let (status, body) = ctx
        .handoff(Some(web_access.expose()), "short", &state)
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("invalid_request"))
    );
    step("the function refuses no JWT, a forged JWT and a malformed request");

    // 2. The click: only ciphertext comes back.
    let (status, body) = ctx
        .handoff(Some(web_access.expose()), &public, &state)
        .await;
    assert_eq!(status, 200, "handoff: {body}");
    let payload = body["payload"].as_str().unwrap().to_owned();
    assert!(!body.to_string().contains(&email), "no email in the clear");
    let link = format!("rail://auth/callback?state={state}&payload={payload}");

    // 3a. Another app instance on the machine gets the link: useless.
    let thief = Account::new(
        config.clone(),
        gotrue.clone(),
        Box::new(MemoryStore::default()),
        Box::new(|| {}),
    );
    assert_eq!(
        thief.complete_sign_in(&link).await,
        Err(Notice::NotInProgress)
    );
    let _ = thief.begin_sign_in().unwrap();
    assert_eq!(
        thief.complete_sign_in(&link).await,
        Err(Notice::NotInProgress)
    );
    let forged_state = link.replace(
        &state,
        &thief.pending_url().map(|u| query(&u, "state")).unwrap(),
    );
    assert_eq!(
        thief.complete_sign_in(&forged_state).await,
        Err(Notice::InvalidLink),
        "right state, wrong key: does not decrypt"
    );
    step("the link is useless to another app instance");

    // 2 (cont.). The app finishes.
    account.complete_sign_in(&link).await.unwrap();
    let AccountStatus::SignedIn {
        email: shown,
        user_id,
        online: true,
        ..
    } = account.status()
    else {
        panic!("not signed in: {:?}", account.status());
    };
    assert_eq!(
        (shown.as_str(), user_id.as_str()),
        (email.as_str(), web_user.as_str())
    );
    let app_access = account.access_token().await.unwrap();
    assert_ne!(app_access, web_access, "a session of its own");
    assert_eq!(
        ctx.user_id(&app_access).await.as_deref(),
        Some(web_user.as_str())
    );
    let stored: Value = serde_json::from_str(&store.peek().unwrap()).unwrap();
    assert_ne!(
        stored["refreshToken"].as_str().unwrap(),
        web_refresh.expose(),
        "its own refresh-token chain"
    );
    step("the app is signed in as the web user, with its own session");

    // 3b. Spent: the link again, and the token hash at /verify again.
    assert_eq!(
        account.complete_sign_in(&link).await,
        Err(Notice::NotInProgress)
    );
    step("the link is spent after one use");

    // 4. Independence: refresh the app, then the web; both keep working.
    account.refresh().await.unwrap();
    let web_again = gotrue.refresh(&web_refresh).await.expect("web refresh");
    account.refresh().await.unwrap();
    assert!(ctx.user_id(&web_again.access_token).await.is_some());
    assert!(account.access_token().await.is_some());
    step("refreshing the app and the browser does not end either");

    // Sign the app out: its chain ends, the browser's does not.
    let app_refresh = Secret::new(
        serde_json::from_str::<Value>(&store.peek().unwrap()).unwrap()["refreshToken"]
            .as_str()
            .unwrap(),
    );
    account.sign_out().await;
    assert_eq!(account.status(), AccountStatus::SignedOut { notice: None });
    assert!(store.peek().is_none());
    match gotrue.refresh(&app_refresh).await {
        Err(ApiError::Rejected { .. }) => {}
        other => panic!("the app's refresh token still works: {other:?}"),
    }
    assert!(ctx.user_id(&web_again.access_token).await.is_some());
    gotrue
        .refresh(&web_again.refresh_token)
        .await
        .expect("the browser stays signed in");
    step("signing the app out ends its session only");

    // 3c. A one-time token cannot be redeemed twice: a fresh handoff opened
    // the way the app opens it, its token hash sent to /verify two times.
    let pending = PendingSignIn::new().unwrap();
    let (status, body) = ctx
        .handoff(
            Some(web_again.access_token.expose()),
            &pending.public_key(),
            pending.state(),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let handoff = pending.open(body["payload"].as_str().unwrap()).unwrap();
    let first = gotrue.verify(&handoff.token_hash).await.expect("first use");
    match gotrue.verify(&handoff.token_hash).await {
        Err(ApiError::Rejected { .. }) => {}
        other => panic!("a one-time token worked twice: {other:?}"),
    }
    gotrue.logout(&first.access_token).await.unwrap();
    step("the one-time token is refused the second time");

    // 5. The budget: 10 an hour per account (2 spent above).
    let mut refused_at = None;
    for attempt in 3..=12 {
        let pending = PendingSignIn::new().unwrap();
        let (status, body) = ctx
            .handoff(
                Some(web_again.access_token.expose()),
                &pending.public_key(),
                pending.state(),
            )
            .await;
        if status == 429 {
            assert_eq!(body["error"], "rate_limited");
            refused_at = Some(attempt);
            break;
        }
        assert_eq!(status, 200, "attempt {attempt}: {body}");
    }
    assert_eq!(
        refused_at,
        Some(11),
        "the 11th handoff in the hour is refused"
    );
    step("the per-account budget closes at 10 an hour");

    println!("desktop sign-in end to end: all checks passed");
}

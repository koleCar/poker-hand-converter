//! The account manager against a fake GoTrue: sign-in completion and its
//! refusals, refresh and rotation, sign-out, the keychain, the loop.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::*;
use crate::auth::gotrue::SessionUser;
use crate::auth::handoff::seal;

const USER: &str = "00000000-0000-0000-0000-0000000a0a01";
const OTHER: &str = "00000000-0000-0000-0000-0000000b0b01";
const TOKEN_HASH: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4";

/// Answers queued per call; records what was sent.
#[derive(Default)]
struct Fake {
    verify: Mutex<VecDeque<Result<Session, ApiError>>>,
    refresh: Mutex<VecDeque<Result<Session, ApiError>>>,
    verified: Mutex<Vec<String>>,
    refreshed: Mutex<Vec<String>>,
    logged_out: Mutex<Vec<String>>,
}

fn take<T>(queue: &Mutex<VecDeque<T>>) -> T {
    queue.lock().unwrap().pop_front().expect("an answer queued")
}

impl AuthApi for Arc<Fake> {
    async fn verify(&self, token_hash: &Secret) -> Result<Session, ApiError> {
        self.verified
            .lock()
            .unwrap()
            .push(token_hash.expose().to_owned());
        take(&self.verify)
    }
    async fn refresh(&self, refresh_token: &Secret) -> Result<Session, ApiError> {
        self.refreshed
            .lock()
            .unwrap()
            .push(refresh_token.expose().to_owned());
        take(&self.refresh)
    }
    async fn logout(&self, access_token: &Secret) -> Result<(), ApiError> {
        self.logged_out
            .lock()
            .unwrap()
            .push(access_token.expose().to_owned());
        Ok(())
    }
}

fn session(n: u32, user: &str) -> Session {
    Session {
        access_token: Secret::new(format!("access-{n}")),
        refresh_token: Secret::new(format!("refresh-{n}")),
        expires_in: Duration::from_secs(3600),
        user: SessionUser {
            id: user.to_owned(),
            email: "player@example.test".to_owned(),
        },
    }
}

fn config() -> AuthConfig {
    AuthConfig::new("https://abc.supabase.co", "anon", "https://rail.example").unwrap()
}

struct Harness {
    account: Arc<Account<Arc<Fake>>>,
    fake: Arc<Fake>,
    store: Arc<MemoryStore>,
    changes: Arc<AtomicUsize>,
}

fn harness_with(store: Arc<MemoryStore>) -> Harness {
    let fake = Arc::new(Fake::default());
    let changes = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&changes);
    let account = Account::new(
        config(),
        Arc::clone(&fake),
        Box::new(Arc::clone(&store)),
        Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
    );
    Harness {
        account: Arc::new(account),
        fake,
        store,
        changes,
    }
}

fn harness() -> Harness {
    harness_with(Arc::new(MemoryStore::default()))
}

/// Start a sign-in with fixed keys; returns its state and a valid link.
fn start(h: &Harness, user: &str) -> (String, String) {
    let pending = PendingSignIn::from_parts([7; 32], [9; 32], std::time::Instant::now(), 0);
    let public: [u8; 32] = URL_SAFE_NO_PAD
        .decode(pending.public_key())
        .unwrap()
        .try_into()
        .unwrap();
    let state = pending.state().to_owned();
    let plain = format!(
        r#"{{"v":1,"type":"magiclink","tokenHash":"{TOKEN_HASH}","userId":"{user}","email":"player@example.test"}}"#
    );
    let payload = seal(&public, &state, plain.as_bytes(), [3; 32], [5; 12]);
    h.account.begin_with(pending);
    let link = format!("rail://auth/callback?state={state}&payload={payload}");
    (state, link)
}

fn stored(h: &Harness) -> serde_json::Value {
    serde_json::from_str(&h.store.peek().expect("a stored session")).unwrap()
}

#[tokio::test]
async fn a_sign_in_completes_and_the_refresh_token_goes_to_the_store() {
    let h = harness();
    let (_, link) = start(&h, USER);
    assert!(matches!(
        h.account.status(),
        AccountStatus::SigningIn { .. }
    ));
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Ok(session(1, USER)));

    h.account.complete_sign_in(&link).await.unwrap();

    assert_eq!(*h.fake.verified.lock().unwrap(), [TOKEN_HASH]);
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedIn {
            email: "player@example.test".into(),
            user_id: USER.into(),
            online: true,
            notice: None
        }
    );
    let entry = stored(&h);
    assert_eq!(entry["refreshToken"], "refresh-1");
    assert_eq!(entry["userId"], USER);
    assert_eq!(entry["supabaseUrl"], "https://abc.supabase.co/");
    assert!(
        entry.get("accessToken").is_none(),
        "the access token stays in memory"
    );
    assert_eq!(h.account.access_token().await.unwrap().expose(), "access-1");
    assert!(h.changes.load(Ordering::SeqCst) >= 2);

    // The same link again: the sign-in is spent.
    assert_eq!(
        h.account.complete_sign_in(&link).await,
        Err(Notice::NotInProgress)
    );
    assert_eq!(h.fake.verified.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_link_for_another_state_leaves_the_sign_in_waiting() {
    let h = harness();
    let (_, link) = start(&h, USER);
    let other_state = URL_SAFE_NO_PAD.encode([1u8; 32]);
    let forged = format!("rail://auth/callback?state={other_state}&payload=AAAA");
    assert_eq!(
        h.account.complete_sign_in(&forged).await,
        Err(Notice::NotInProgress)
    );
    assert!(matches!(
        h.account.status(),
        AccountStatus::SigningIn { .. }
    ));
    // The real one still works.
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Ok(session(1, USER)));
    h.account.complete_sign_in(&link).await.unwrap();
    assert!(h.account.is_signed_in());
}

#[tokio::test]
async fn a_link_with_no_sign_in_in_progress_is_refused() {
    let h = harness();
    let state = URL_SAFE_NO_PAD.encode([9u8; 32]);
    assert_eq!(
        h.account
            .complete_sign_in(&format!("rail://auth/callback?state={state}&payload=AAAA"))
            .await,
        Err(Notice::NotInProgress)
    );
    assert_eq!(
        h.account.complete_sign_in("rail://somewhere/else").await,
        Err(Notice::InvalidLink)
    );
    assert!(h.fake.verified.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelling_in_the_browser_ends_the_sign_in() {
    let h = harness();
    let (state, _) = start(&h, USER);
    assert_eq!(
        h.account
            .complete_sign_in(&format!(
                "rail://auth/callback?state={state}&error=cancelled"
            ))
            .await,
        Err(Notice::Cancelled)
    );
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedOut {
            notice: Some(Notice::Cancelled)
        }
    );
}

#[tokio::test]
async fn a_tampered_payload_spends_the_sign_in_and_reaches_no_server() {
    let h = harness();
    let (_, link) = start(&h, USER);
    let tampered = link.replace("payload=A", "payload=B");
    assert_ne!(tampered, link);
    assert_eq!(
        h.account.complete_sign_in(&tampered).await,
        Err(Notice::InvalidLink)
    );
    assert!(h.fake.verified.lock().unwrap().is_empty());
    assert_eq!(
        h.account.complete_sign_in(&link).await,
        Err(Notice::NotInProgress)
    );
}

#[tokio::test]
async fn a_refused_or_unreachable_verify_is_reported() {
    let h = harness();
    let (_, link) = start(&h, USER);
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Err(ApiError::Rejected {
            status: 403,
            code: "otp_expired".into(),
        }));
    assert_eq!(
        h.account.complete_sign_in(&link).await,
        Err(Notice::LinkRejected)
    );
    let (_, link) = start(&h, USER);
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Err(ApiError::Transient("offline".into())));
    assert_eq!(
        h.account.complete_sign_in(&link).await,
        Err(Notice::Offline)
    );
    assert!(!h.account.is_signed_in());
    assert!(h.store.peek().is_none());
}

#[tokio::test]
async fn a_session_for_another_user_is_ended_not_kept() {
    let h = harness();
    let (_, link) = start(&h, USER);
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Ok(session(1, OTHER)));
    assert_eq!(
        h.account.complete_sign_in(&link).await,
        Err(Notice::InvalidLink)
    );
    assert_eq!(*h.fake.logged_out.lock().unwrap(), ["access-1"]);
    assert!(!h.account.is_signed_in());
}

async fn signed_in() -> Harness {
    let h = harness();
    let (_, link) = start(&h, USER);
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Ok(session(1, USER)));
    h.account.complete_sign_in(&link).await.unwrap();
    h
}

/// R1.9: a token for one account is never handed out for another.
#[tokio::test]
async fn a_token_is_handed_out_only_for_its_own_account() {
    let h = signed_in().await;
    assert_eq!(
        h.account.user(),
        Some((USER.to_owned(), "player@example.test".to_owned()))
    );
    assert_eq!(
        h.account.access_token_for(USER).await.unwrap().expose(),
        "access-1"
    );
    assert!(h.account.access_token_for(OTHER).await.is_none());
    assert!(
        h.fake.refreshed.lock().unwrap().is_empty(),
        "no refresh spent for another account"
    );
    h.account.sign_out().await;
    assert!(h.account.access_token_for(USER).await.is_none());
    assert_eq!(h.account.user(), None);
}

#[tokio::test]
async fn a_refresh_rotates_the_stored_token() {
    let h = signed_in().await;
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Ok(session(2, USER)));
    h.account.refresh().await.unwrap();
    assert_eq!(*h.fake.refreshed.lock().unwrap(), ["refresh-1"]);
    assert_eq!(stored(&h)["refreshToken"], "refresh-2");
    assert_eq!(h.account.access_token().await.unwrap().expose(), "access-2");
}

#[tokio::test]
async fn a_refused_refresh_signs_out_and_clears_the_store() {
    let h = signed_in().await;
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Err(ApiError::Rejected {
            status: 400,
            code: "refresh_token_already_used".into(),
        }));
    assert!(h.account.refresh().await.is_err());
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedOut {
            notice: Some(Notice::SessionEnded)
        }
    );
    assert!(h.store.peek().is_none());
    assert!(h.account.access_token().await.is_none());
}

#[tokio::test]
async fn an_unreachable_server_keeps_the_session_offline() {
    let h = signed_in().await;
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Err(ApiError::Transient("dns".into())));
    assert!(h.account.refresh().await.is_err());
    assert!(matches!(
        h.account.status(),
        AccountStatus::SignedIn { online: false, .. }
    ));
    assert_eq!(stored(&h)["refreshToken"], "refresh-1");
}

#[tokio::test]
async fn sign_out_ends_this_session_on_the_server() {
    let h = signed_in().await;
    h.account.sign_out().await;
    assert_eq!(*h.fake.logged_out.lock().unwrap(), ["access-1"]);
    assert!(h.store.peek().is_none());
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedOut { notice: None }
    );
}

#[tokio::test]
async fn a_restored_session_refreshes_first_and_can_sign_out() {
    let store = Arc::new(MemoryStore::default());
    store
        .save(&format!(
            r#"{{"v":1,"supabaseUrl":"https://abc.supabase.co/","userId":"{USER}","email":"player@example.test","refreshToken":"refresh-9"}}"#
        ))
        .unwrap();
    let h = harness_with(Arc::clone(&store));
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedIn {
            email: "player@example.test".into(),
            user_id: USER.into(),
            online: false,
            notice: None
        }
    );
    // The loop's first pass refreshes at once: no access token yet.
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Ok(session(10, USER)));
    let next = h.account.tick().await;
    assert!(next.is_some());
    assert_eq!(*h.fake.refreshed.lock().unwrap(), ["refresh-9"]);
    assert!(matches!(
        h.account.status(),
        AccountStatus::SignedIn { online: true, .. }
    ));

    // Sign-out after another restart: no access token, so one refresh first.
    let h = harness_with(store);
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Ok(session(11, USER)));
    h.account.sign_out().await;
    assert_eq!(*h.fake.refreshed.lock().unwrap(), ["refresh-10"]);
    assert_eq!(*h.fake.logged_out.lock().unwrap(), ["access-11"]);
}

#[tokio::test]
async fn a_session_for_another_project_is_not_restored() {
    let store = Arc::new(MemoryStore::default());
    store
        .save(&format!(
            r#"{{"v":1,"supabaseUrl":"http://127.0.0.1:55721/","userId":"{USER}","email":"p@example.test","refreshToken":"r"}}"#
        ))
        .unwrap();
    let h = harness_with(store);
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedOut { notice: None }
    );
}

#[tokio::test]
async fn a_broken_keychain_still_signs_in_for_this_run() {
    let store = Arc::new(MemoryStore::default());
    store.broken.store(true, Ordering::SeqCst);
    let h = harness_with(store);
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedOut {
            notice: Some(Notice::KeychainUnavailable)
        }
    );
    let (_, link) = start(&h, USER);
    h.fake
        .verify
        .lock()
        .unwrap()
        .push_back(Ok(session(1, USER)));
    h.account.complete_sign_in(&link).await.unwrap();
    assert!(matches!(
        h.account.status(),
        AccountStatus::SignedIn {
            notice: Some(Notice::KeychainUnavailable),
            ..
        }
    ));
}

#[tokio::test(start_paused = true)]
async fn a_sign_in_times_out_after_ten_minutes() {
    let h = harness();
    let (_, link) = start(&h, USER);
    tokio::time::advance(Duration::from_secs(9 * 60)).await;
    assert!(matches!(
        h.account.status(),
        AccountStatus::SigningIn {
            seconds_left: 60,
            ..
        }
    ));
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_eq!(
        h.account.status(),
        AccountStatus::SignedOut {
            notice: Some(Notice::TimedOut)
        }
    );
    assert_eq!(
        h.account.complete_sign_in(&link).await,
        Err(Notice::NotInProgress)
    );
}

#[tokio::test(start_paused = true)]
async fn the_loop_refreshes_five_minutes_before_expiry() {
    let h = signed_in().await;
    let account = Arc::clone(&h.account);
    let task = tokio::spawn(async move { account.run().await });
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Ok(session(2, USER)));
    tokio::time::sleep(Duration::from_secs(54 * 60)).await;
    assert!(h.fake.refreshed.lock().unwrap().is_empty());
    tokio::time::sleep(Duration::from_secs(2 * 60)).await;
    assert_eq!(*h.fake.refreshed.lock().unwrap(), ["refresh-1"]);
    // A network error is retried after 30 s, not hammered.
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Err(ApiError::Transient("offline".into())));
    h.fake
        .refresh
        .lock()
        .unwrap()
        .push_back(Ok(session(3, USER)));
    // Refreshed at 55 min, so the next is due at 110 min: it fails, and the
    // retry comes 30 s later.
    tokio::time::sleep(Duration::from_secs(54 * 60 + 10)).await;
    assert_eq!(h.fake.refreshed.lock().unwrap().len(), 2);
    tokio::time::sleep(Duration::from_secs(21)).await;
    assert_eq!(h.fake.refreshed.lock().unwrap().len(), 3);
    assert_eq!(stored(&h)["refreshToken"], "refresh-3");
    task.abort();
}

#[test]
fn the_status_serialises_for_the_window() {
    let status = AccountStatus::SignedIn {
        email: "p@example.test".into(),
        user_id: USER.into(),
        online: true,
        notice: Some(Notice::KeychainUnavailable),
    };
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        serde_json::json!({
            "state": "signedIn", "email": "p@example.test", "userId": USER,
            "online": true, "notice": "keychainUnavailable"
        })
    );
    assert_eq!(
        serde_json::to_value(AccountStatus::SigningIn {
            url: "https://x".into(),
            seconds_left: 5,
            notice: None
        })
        .unwrap(),
        serde_json::json!({ "state": "signingIn", "url": "https://x", "secondsLeft": 5, "notice": null })
    );
    assert_eq!(
        serde_json::to_value(AccountStatus::NotConfigured).unwrap(),
        serde_json::json!({ "state": "notConfigured" })
    );
}

#[test]
fn backoff_doubles_to_ten_minutes() {
    assert_eq!(backoff(1), Duration::from_secs(30));
    assert_eq!(backoff(2), Duration::from_secs(60));
    assert_eq!(backoff(5), Duration::from_secs(480));
    assert_eq!(backoff(6), Duration::from_secs(600));
    assert_eq!(backoff(60), Duration::from_secs(600));
}

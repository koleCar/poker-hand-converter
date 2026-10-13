//! Desktop ingest, end to end, against a **local** Supabase stack with the
//! R1.8 migration (docs/RAIL-PLAN.md R1.8). Not run in CI: it needs Docker.
//!
//! ```text
//! RAIL_E2E_SUPABASE_URL=http://127.0.0.1:55821 RAIL_E2E_ANON_KEY=... \
//! RAIL_E2E_EMAIL=... RAIL_E2E_PASSWORD=... \
//! RAIL_E2E_EMAIL_B=... RAIL_E2E_PASSWORD_B=... \
//!   cargo run -p rail-sync --example desktop_ingest_e2e
//! ```
//!
//! Two confirmed users on the stack (`RAIL_E2E_*_B` is the second). The
//! corpus folders (`RAIL_E2E_CORPUS`, `:`-separated, default `weplay-hh`,
//! `gg-hh` and `fixtures/samples` under the repository) are imported into a
//! fresh local store with `rail-store`, as the watcher would; then the
//! outbox is drained through the real `rail_sync::auth::Account` (its token
//! comes from a refresh, as in the app) and `IngestClient`:
//!
//! 1. every hand the store holds reaches the server: inserted, or rejected
//!    with a reason (none expected for the corpus);
//! 2. a replay of what was sent is all duplicates and stores nothing;
//! 3. the second account sends the same hands into its own library: all
//!    inserted (no collision), and each account reads only its own rows;
//! 4. the second account cannot send into the first one's source.
//!
//! Prints counts and timings; no token, key or password.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::time::Instant;

use rail_store::import::{ImportOptions, import_file};
use rail_store::{Store, time};
use rail_sync::auth::{Account, AuthConfig, GoTrue, MemoryStore, SecretStore};
use rail_sync::ingest::{Batch, IngestClient, IngestError, IngestRow, SourceRegistration};
use serde_json::{Value, json};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; see the header"))
}

/// Password sign-in as the web does it (local Turnstile accepts the dummy
/// token): the user id, the access token and the refresh token.
async fn sign_in(
    http: &reqwest::Client,
    url: &str,
    anon: &str,
    email: &str,
    password: &str,
) -> (String, String, String) {
    let response = http
        .post(format!("{url}/auth/v1/token?grant_type=password"))
        .header("apikey", anon)
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
        "sign-in: {}",
        response.status()
    );
    let body: Value = response.json().await.unwrap();
    (
        body["user"]["id"].as_str().unwrap().to_owned(),
        body["access_token"].as_str().unwrap().to_owned(),
        body["refresh_token"].as_str().unwrap().to_owned(),
    )
}

/// The account manager over a session that came from somewhere else: the
/// keychain entry R1.7 writes, with a refresh token in it.
fn account(config: &AuthConfig, user_id: &str, email: &str, refresh: &str) -> Account<GoTrue> {
    let store = MemoryStore::default();
    store
        .save(
            &json!({
                "v": 1,
                "supabaseUrl": config.supabase_url.as_str(),
                "userId": user_id,
                "email": email,
                "refreshToken": refresh,
            })
            .to_string(),
        )
        .unwrap();
    Account::new(
        config.clone(),
        GoTrue::new(config).unwrap(),
        Box::new(store),
        Box::new(|| {}),
    )
}

fn corpus_files(root: &Path) -> Vec<PathBuf> {
    let dirs = std::env::var("RAIL_E2E_CORPUS")
        .unwrap_or_else(|_| "weplay-hh:gg-hh:fixtures/samples".into());
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = dirs.split(':').map(|d| root.join(d)).collect();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("txt") || e.eq_ignore_ascii_case("xml"))
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

/// Rows the server can see for the bearer, by PostgREST's exact count.
async fn visible_hands(http: &reqwest::Client, url: &str, anon: &str, token: &str) -> u64 {
    let response = http
        .head(format!("{url}/rest/v1/hands?select=id"))
        .header("apikey", anon)
        .bearer_auth(token)
        .header("Prefer", "count=exact")
        .send()
        .await
        .unwrap();
    let range = response.headers()["content-range"]
        .to_str()
        .unwrap()
        .to_owned();
    range.rsplit('/').next().unwrap().parse().unwrap()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let url = env("RAIL_E2E_SUPABASE_URL");
    let anon = env("RAIL_E2E_ANON_KEY");
    let config = AuthConfig::new(&url, &anon, "http://localhost:3000").unwrap();
    let url = url.trim_end_matches('/').to_owned();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::new();

    // ------------------------------------------------- a local store, filled --
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::temp_dir().join(format!("rail-ingest-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::open(dir.join(rail_store::FILE_NAME)).unwrap();
    let started = Instant::now();
    let files = corpus_files(&root);
    for file in &files {
        import_file(&store, file, &ImportOptions::default()).unwrap();
    }
    let status = store.status().unwrap();
    println!(
        "store: {} files imported, {} hands, {} in the outbox ({} ms)",
        files.len(),
        status.hands,
        status.outbox,
        started.elapsed().as_millis()
    );

    // ------------------------------------------------------------ account A --
    let email_a = env("RAIL_E2E_EMAIL");
    let (user_a, _, refresh_a) =
        sign_in(&http, &url, &anon, &email_a, &env("RAIL_E2E_PASSWORD")).await;
    let account_a = account(&config, &user_a, &email_a, &refresh_a);
    let client = IngestClient::new(&config).unwrap();
    let device = format!("00000000-0000-4000-8000-{:012x}", std::process::id());
    let source_a = client
        .register_source_as(
            &account_a,
            &SourceRegistration {
                device_id: device.clone(),
                local_id: "1".into(),
                device_name: Some("e2e".into()),
                label: Some("Corpus".into()),
                site: None,
            },
        )
        .await
        .unwrap();
    println!("A: source registered");

    // 1. Drain the outbox.
    let mut sent: Vec<IngestRow> = Vec::new();
    let (mut inserted, mut duplicates, mut rejected, mut calls, mut bytes) = (0, 0, 0, 0, 0);
    let mut call_ms = Vec::new();
    let started = Instant::now();
    loop {
        let due = store.reader().outbox_due(time::now_ms(), 2000).unwrap();
        if due.is_empty() {
            break;
        }
        let rows: Vec<IngestRow> = due
            .iter()
            .map(|item| IngestRow::from_outbox(item).unwrap())
            .collect();
        for batch in Batch::split(rows) {
            let call = Instant::now();
            let report = client
                .ingest_as(&account_a, &source_a, &batch)
                .await
                .unwrap();
            call_ms.push(call.elapsed().as_millis());
            calls += 1;
            bytes += batch.bytes();
            inserted += report.inserted;
            duplicates += report.duplicates;
            rejected += report.rejected;
            for outcome in report.rejections() {
                println!("  rejected {}: {:?}", outcome.hand_key, outcome.status);
            }
            let keys: Vec<String> = batch.hand_keys().map(str::to_owned).collect();
            // Rejected hands leave the outbox too: sending them again cannot
            // help (R1.9 keeps them with their reason).
            store.outbox_mark_sent(keys, time::now_ms()).unwrap();
            sent.extend(batch.rows().iter().cloned());
        }
    }
    let ms = started.elapsed().as_millis().max(1);
    call_ms.sort_unstable();
    let hands = sent.len();
    println!(
        "A: {hands} hands in {calls} calls, {ms} ms ({} hands/s); inserted {inserted}, duplicates {duplicates}, \
         rejected {rejected}; {} KB of JSON ({} B a hand); call median {} ms, max {} ms",
        u128::try_from(hands).unwrap() * 1000 / ms,
        bytes / 1024,
        bytes / hands.max(1),
        call_ms[call_ms.len() / 2],
        call_ms[call_ms.len() - 1],
    );
    assert_eq!(rejected, 0, "the corpus is all valid");
    assert_eq!(inserted + duplicates, sent.len());
    assert_eq!(store.status().unwrap().outbox, 0, "the outbox is empty");

    // 2. A replay is all duplicates.
    let batches = Batch::split(sent.iter().cloned());
    let mut replay_inserted = 0;
    for batch in &batches {
        let report = client
            .ingest_as(&account_a, &source_a, batch)
            .await
            .unwrap();
        replay_inserted += report.inserted;
        assert_eq!(report.duplicates, batch.len());
    }
    assert_eq!(replay_inserted, 0);
    println!("A: replay of {} hands: all duplicates", sent.len());

    // 3. B: same hands, own library.
    let email_b = env("RAIL_E2E_EMAIL_B");
    let (user_b, token_b, refresh_b) =
        sign_in(&http, &url, &anon, &email_b, &env("RAIL_E2E_PASSWORD_B")).await;
    let account_b = account(&config, &user_b, &email_b, &refresh_b);
    let source_b = client
        .register_source_as(
            &account_b,
            &SourceRegistration {
                device_id: device.clone(),
                local_id: "1".into(),
                device_name: None,
                label: None,
                site: None,
            },
        )
        .await
        .unwrap();
    assert_ne!(
        source_a, source_b,
        "the same device and folder id is another account's own source"
    );
    let first = &batches[0];
    let report = client
        .ingest_as(&account_b, &source_b, first)
        .await
        .unwrap();
    assert_eq!(report.inserted, first.len(), "no collision with A's rows");
    let token_a = account_a.access_token().await.unwrap();
    let seen_a = visible_hands(&http, &url, &anon, token_a.expose()).await;
    let seen_b = visible_hands(&http, &url, &anon, &token_b).await;
    println!("visible: A {seen_a}, B {seen_b}");
    assert_eq!(
        usize::try_from(seen_a).unwrap(),
        inserted,
        "A sees exactly its own"
    );
    assert_eq!(
        usize::try_from(seen_b).unwrap(),
        first.len(),
        "B sees exactly its own"
    );

    // 4. B cannot use A's source.
    assert_eq!(
        client.ingest_as(&account_b, &source_a, first).await,
        Err(IngestError::UnknownSource)
    );
    println!("B: A's source refused");

    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
    println!("desktop ingest e2e: all passed");
}

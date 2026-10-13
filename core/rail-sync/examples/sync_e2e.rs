//! The sync worker, end to end, against a **local** Supabase stack with the
//! R1.8 and R1.9 migrations (docs/RAIL-PLAN.md R1.9). Not run in CI: it
//! needs Docker.
//!
//! ```text
//! RAIL_E2E_SUPABASE_URL=http://127.0.0.1:55921 RAIL_E2E_ANON_KEY=... \
//! RAIL_E2E_EMAIL=... RAIL_E2E_PASSWORD=... \
//! RAIL_E2E_EMAIL_B=... RAIL_E2E_PASSWORD_B=... \
//!   cargo run -p rail-sync --example sync_e2e
//! ```
//!
//! Two fresh confirmed users (B must have no hands). Three parts:
//!
//! 1. **Kill and resume.** The corpus (`RAIL_E2E_CORPUS`, default
//!    `weplay-hh:gg-hh:fixtures/samples`) is imported into a store; a child
//!    process runs the real worker (`Account` + `IngestClient`, no cap) and
//!    is killed (SIGKILL) mid-sync; a new worker on the same store finishes.
//!    The server must then hold exactly the store's hands, once each.
//! 2. **The Phase 1 exit check.** A watched folder, `rail-watch` and the
//!    worker for B behind a TCP proxy that can cut the network: a "session"
//!    is written hand by hand into a file; the connection is cut mid-batch
//!    (the server commits, the answer is lost) and restored. Every hand must
//!    be visible through PostgREST as B within a minute, exactly once; the
//!    same file copied again changes nothing.
//! 3. **The pull.** A hand saved on the web (`save_hands`) as A reaches a
//!    second, empty store through the pull, with the account's desktop
//!    hands; the first store fetches only that one hand's PHF.
//!
//! Prints counts, timings and latencies; no token, key or password.

// A panic ends the example (and its child with it); the kill path waits.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::zombie_processes)]

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use rail_store::import::{ImportOptions, convert_bytes, import_file};
use rail_store::{FileState, Store};
use rail_sync::auth::{Account, AuthConfig, GoTrue, MemoryStore, SecretStore};
use rail_sync::ingest::{IngestClient, IngestRow};
use rail_sync::worker::{StoreAccess, SyncConfig, SyncPhase, SyncWorker};
use rail_watch::{WatchConfig, Watcher};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; see the header"))
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Password sign-in as the web does it (the local Turnstile accepts the
/// dummy token): user id, access token, refresh token.
async fn sign_in(url: &str, anon: &str, email: &str, password: &str) -> (String, String, String) {
    let response = reqwest::Client::new()
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

/// The app's account manager over a fresh session (the keychain entry R1.7
/// writes, in memory).
async fn account(config: &AuthConfig, email: &str, password: &str) -> Arc<Account<GoTrue>> {
    let url = config.supabase_url.as_str().trim_end_matches('/');
    let (user_id, _, refresh) = sign_in(url, config.anon_key.expose(), email, password).await;
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
    Arc::new(Account::new(
        config.clone(),
        GoTrue::new(config).unwrap(),
        Box::new(store),
        Box::new(|| {}),
    ))
}

/// Start a worker on `store`; `rest` is where PostgREST is (the stack, or
/// the proxy in front of it).
fn worker(
    rest: &AuthConfig,
    account: Arc<Account<GoTrue>>,
    store: &Store,
) -> (SyncWorker, tokio::task::JoinHandle<()>) {
    let access = StoreAccess::open(store.path(), store.writer().unwrap()).unwrap();
    let (worker, task) = SyncWorker::new(
        SyncConfig {
            device_name: Some("e2e".into()),
            backoff_first: Duration::from_secs(1),
            backoff_max: Duration::from_secs(5),
            ..SyncConfig::default()
        },
        account,
        IngestClient::new(rest).unwrap(),
        access,
        Box::new(|| {}),
    );
    // Measure the uncapped rate.
    worker.set_cap(None).unwrap();
    (worker, tokio::spawn(task.run()))
}

async fn until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn drained(worker: &SyncWorker, limit: Duration) {
    until("an empty outbox", limit, || {
        let status = worker.status();
        status.phase == SyncPhase::UpToDate && status.outbox == 0
    })
    .await;
}

/// The bearer's hand keys on the server (PostgREST, under RLS).
async fn server_keys(url: &str, anon: &str, token: &str) -> Vec<String> {
    let http = reqwest::Client::new();
    let mut keys = Vec::new();
    loop {
        let page: Vec<Value> = http
            .get(format!(
                "{url}/rest/v1/hands?select=hand_key&order=id&limit=1000&offset={}",
                keys.len()
            ))
            .header("apikey", anon)
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let n = page.len();
        keys.extend(
            page.into_iter()
                .map(|row| row["hand_key"].as_str().unwrap().to_owned()),
        );
        if n < 1000 {
            return keys;
        }
    }
}

fn corpus_files() -> Vec<PathBuf> {
    let dirs = std::env::var("RAIL_E2E_CORPUS")
        .unwrap_or_else(|_| "weplay-hh:gg-hh:fixtures/samples".into());
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = dirs.split(':').map(|d| repo().join(d)).collect();
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

/// The hands imported from this computer's files (not pulled).
fn local_keys(store: &Store) -> BTreeSet<String> {
    store
        .reader()
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT hand_key FROM hands WHERE pulled_at IS NULL")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.collect::<Result<BTreeSet<_>, _>>()?)
        })
        .unwrap()
}

// ------------------------------------------------------------- the proxy --

/// A TCP proxy in front of the stack. While `cut` is set it forwards each
/// request but drops the connection when the answer starts: the server has
/// committed the batch, the client never hears so (a network cut mid-batch).
struct Proxy {
    addr: SocketAddr,
    cut: Arc<AtomicBool>,
    dropped: Arc<AtomicUsize>,
}

async fn proxy(upstream: SocketAddr) -> Proxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cut = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicUsize::new(0));
    let (flag, count) = (Arc::clone(&cut), Arc::clone(&dropped));
    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let (flag, count) = (Arc::clone(&flag), Arc::clone(&count));
            tokio::spawn(async move {
                let Ok(server) = TcpStream::connect(upstream).await else {
                    return;
                };
                let (mut client_read, mut client_write) = client.into_split();
                let (mut server_read, mut server_write) = server.into_split();
                let up = tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut client_read, &mut server_write).await;
                });
                let mut buffer = vec![0u8; 64 * 1024];
                while let Ok(n) = server_read.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                    if flag.load(Ordering::SeqCst) {
                        count.fetch_add(1, Ordering::SeqCst);
                        break; // the answer is lost; the connection drops
                    }
                    if client_write.write_all(&buffer[..n]).await.is_err() {
                        break;
                    }
                }
                up.abort();
            });
        }
    });
    Proxy { addr, cut, dropped }
}

// ----------------------------------------------------------------- child --

/// The killable worker: signs in as A and syncs the store until killed.
async fn child(store_path: &Path) {
    let url = env("RAIL_E2E_SUPABASE_URL");
    let config = AuthConfig::new(&url, &env("RAIL_E2E_ANON_KEY"), "http://localhost:3000").unwrap();
    let account = account(&config, &env("RAIL_E2E_EMAIL"), &env("RAIL_E2E_PASSWORD")).await;
    let store = Store::open(store_path).unwrap();
    let (worker, _task) = worker(&config, account, &store);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let status = worker.status();
        eprintln!(
            "  child: {:?} sent {} outbox {}",
            status.phase, status.sent, status.outbox
        );
    }
}

// ---------------------------------------------------------------- parent --

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("child") {
        child(Path::new(&args[2])).await;
        return;
    }
    let url = env("RAIL_E2E_SUPABASE_URL")
        .trim_end_matches('/')
        .to_owned();
    let anon = env("RAIL_E2E_ANON_KEY");
    let config = AuthConfig::new(&url, &anon, "http://localhost:3000").unwrap();
    let work = std::env::temp_dir().join(format!("rail-sync-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();

    // ============================================ 1. kill and resume (A) ==
    let s1 = work.join("s1").join(rail_store::FILE_NAME);
    let files = corpus_files();
    {
        let store = Store::open(&s1).unwrap();
        let started = Instant::now();
        for file in &files {
            import_file(&store, file, &ImportOptions::default()).unwrap();
        }
        let status = store.status().unwrap();
        println!(
            "1. store: {} files, {} hands queued ({} ms)",
            files.len(),
            status.outbox,
            started.elapsed().as_millis()
        );
        store.close();
    }
    let (_, token_a, _) = sign_in(
        &url,
        &anon,
        &env("RAIL_E2E_EMAIL"),
        &env("RAIL_E2E_PASSWORD"),
    )
    .await;
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("child")
        .arg(&s1)
        .spawn()
        .unwrap();
    let started = Instant::now();
    loop {
        let n = server_keys(&url, &anon, &token_a).await.len();
        if n >= 1500 || started.elapsed() > Duration::from_secs(120) {
            child.kill().unwrap();
            let _ = child.wait();
            assert!(n >= 1500, "the child did not sync");
            println!(
                "1. child killed (SIGKILL) after {} ms with {n} hands on the server",
                started.elapsed().as_millis()
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let store = Store::open(&s1).unwrap();
    let left = store.status().unwrap().outbox;
    let account_a = account(&config, &env("RAIL_E2E_EMAIL"), &env("RAIL_E2E_PASSWORD")).await;
    let (worker_a, task_a) = worker(&config, Arc::clone(&account_a), &store);
    let started = Instant::now();
    drained(&worker_a, Duration::from_secs(600)).await;
    let ms = started.elapsed().as_millis().max(1);
    let local = local_keys(&store);
    let bytes: usize = local
        .iter()
        .map(|key| {
            IngestRow::new(key, &store.reader().hand_phf(key).unwrap().unwrap())
                .unwrap()
                .len()
        })
        .sum();
    println!(
        "1. resumed: {left} hands left after the kill, drained in {ms} ms ({} hands/s, {} KB/s); \
         {} B of JSON a hand on the wire",
        u128::from(left) * 1000 / ms,
        u128::try_from(bytes).unwrap() * u128::from(left)
            / u128::try_from(local.len()).unwrap()
            / ms,
        bytes / local.len()
    );
    let server: Vec<String> = server_keys(&url, &anon, &token_a).await;
    let unique: BTreeSet<String> = server.iter().cloned().collect();
    assert_eq!(server.len(), unique.len(), "no hand twice");
    assert_eq!(unique, local, "the server holds exactly the store's hands");
    println!("1. server = store: {} hands, each once", server.len());

    // ================================ 2. the Phase 1 exit check (B, live) ==
    let s2 = work.join("s2").join(rail_store::FILE_NAME);
    let folder = work.join("s2-hh");
    std::fs::create_dir_all(&folder).unwrap();
    let store_b = Store::open(&s2).unwrap();
    store_b
        .add_source(&folder.to_string_lossy(), true, None)
        .unwrap();
    let account_b = account(
        &config,
        &env("RAIL_E2E_EMAIL_B"),
        &env("RAIL_E2E_PASSWORD_B"),
    )
    .await;
    let (_, token_b, _) = sign_in(
        &url,
        &anon,
        &env("RAIL_E2E_EMAIL_B"),
        &env("RAIL_E2E_PASSWORD_B"),
    )
    .await;
    assert!(
        server_keys(&url, &anon, &token_b).await.is_empty(),
        "B starts empty"
    );
    let upstream: SocketAddr = config
        .supabase_url
        .socket_addrs(|| None)
        .unwrap()
        .into_iter()
        .find(SocketAddr::is_ipv4)
        .unwrap();
    let net = proxy(upstream).await;
    let through = AuthConfig::new(
        &format!("http://{}", net.addr),
        &anon,
        "http://localhost:3000",
    )
    .unwrap();
    let (worker_b, task_b) = worker(&through, account_b, &store_b);
    let waker = worker_b.clone();
    let watcher = Watcher::start(
        store_b.path(),
        store_b.writer().unwrap(),
        WatchConfig::default(),
        move |event| {
            if let rail_watch::WatchEvent::Imported { inserted, .. } = event
                && inserted > 0
            {
                waker.wake();
            }
        },
    )
    .unwrap();

    // The session: file 28 (58 hands, several of them repeated) written
    // hand by hand, each hand under a fresh id - **generated** data, so that
    // every hand is new to the account and to the store.
    let source = std::fs::read_to_string(
        repo().join("fixtures/samples/pokerstars/28-cash-multi-hand-file-no-blank-separator.txt"),
    )
    .unwrap();
    let starts: Vec<usize> = source
        .match_indices("PokerStars Game #")
        .map(|(i, _)| i)
        .collect();
    let base = 900_000_000_000u64 + u64::from(std::process::id()) * 1000;
    let mut hands: Vec<String> = Vec::new();
    for (i, start) in starts.iter().enumerate() {
        let from = if i == 0 { 0 } else { *start };
        let to = starts.get(i + 1).copied().unwrap_or(source.len());
        let chunk = &source[from..to];
        let digits = chunk[chunk.find('#').unwrap() + 1..]
            .split(':')
            .next()
            .unwrap()
            .to_owned();
        hands.push(chunk.replacen(&format!("#{digits}:"), &format!("#{}:", base + i as u64), 1));
    }
    let session = folder.join("HH20140106 Hveen II.txt");
    let poll_seen: Arc<std::sync::Mutex<BTreeMap<String, Instant>>> = Arc::default();
    let poller = {
        let (url, anon, token, seen) = (
            url.clone(),
            anon.clone(),
            token_b.clone(),
            Arc::clone(&poll_seen),
        );
        tokio::spawn(async move {
            loop {
                let keys = server_keys(&url, &anon, &token).await;
                let now = Instant::now();
                {
                    let mut seen = seen.lock().unwrap();
                    for key in keys {
                        seen.entry(key).or_insert(now);
                    }
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
    };
    let mut written: Vec<(String, Instant, bool)> = Vec::new();
    let mut text = String::new();
    for (i, hand) in hands.iter().enumerate() {
        if i == 20 {
            net.cut.store(true, Ordering::SeqCst);
            println!("2. network cut (answers dropped) after hand 20");
        }
        if i == 32 {
            net.cut.store(false, Ordering::SeqCst);
            println!(
                "2. network back after hand 32; {} answers were lost",
                net.dropped.load(Ordering::SeqCst)
            );
        }
        let batch = convert_bytes(
            FileState {
                path: "x".into(),
                source_id: None,
                from_offset: 0,
                to_offset: 0,
                size: 0,
                mtime_ms: None,
                encoding: None,
                site: None,
                last_error: None,
            },
            &session,
            hand.as_bytes(),
            &ImportOptions::default(),
        )
        .unwrap();
        assert_eq!(batch.hands.len(), 1, "one hand per chunk");
        text.push_str(hand);
        let at = Instant::now();
        std::fs::write(&session, &text).unwrap();
        written.push((batch.hands[0].hand_key.clone(), at, (20..32).contains(&i)));
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let expected: BTreeSet<String> = written.iter().map(|(key, _, _)| key.clone()).collect();
    until(
        "every hand of the session on the server",
        Duration::from_secs(120),
        || poll_seen.lock().unwrap().len() >= expected.len(),
    )
    .await;
    drained(&worker_b, Duration::from_secs(60)).await;
    poller.abort();
    let seen = poll_seen.lock().unwrap().clone();
    let mut latencies: Vec<u128> = written
        .iter()
        .map(|(key, at, _)| seen[key].saturating_duration_since(*at).as_millis())
        .collect();
    let cut: Vec<u128> = written
        .iter()
        .filter(|(_, _, during)| *during)
        .map(|(key, at, _)| seen[key].saturating_duration_since(*at).as_millis())
        .collect();
    latencies.sort_unstable();
    println!(
        "2. {} hands written, one every 0.5 s; append -> visible as B through PostgREST: min {} ms, \
         median {} ms, max {} ms; written during the cut: max {} ms",
        written.len(),
        latencies[0],
        latencies[latencies.len() / 2],
        latencies[latencies.len() - 1],
        cut.iter().max().unwrap_or(&0)
    );
    assert!(
        latencies[latencies.len() - 1] < 60_000,
        "every hand within a minute"
    );
    assert!(
        net.dropped.load(Ordering::SeqCst) > 0,
        "the cut lost answers mid-batch"
    );
    let server_b = server_keys(&url, &anon, &token_b).await;
    let unique_b: BTreeSet<String> = server_b.iter().cloned().collect();
    assert_eq!(server_b.len(), unique_b.len(), "no hand twice");
    assert_eq!(unique_b, expected, "exactly the session's hands");
    println!(
        "2. server = session: {} hands, each once, after a cut mid-batch",
        server_b.len()
    );

    // The same file again, under another name: nothing changes.
    std::fs::copy(&session, folder.join("HH20140106 Hveen II (copy).txt")).unwrap();
    tokio::time::sleep(Duration::from_secs(4)).await;
    worker_b.sync_now();
    drained(&worker_b, Duration::from_secs(30)).await;
    assert_eq!(
        store_b.status().unwrap().hands,
        u64::try_from(expected.len()).unwrap()
    );
    assert_eq!(
        server_keys(&url, &anon, &token_b).await.len(),
        expected.len()
    );
    println!("2. the same file imported twice: nothing new, locally or on the server");
    watcher.stop();
    worker_b.stop();
    let _ = task_b.await;

    // ========================================================== 3. pull (A) ==
    let mut phf: Value = serde_json::from_str(
        &store
            .reader()
            .hand_phf(local.iter().next().unwrap())
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let id = format!("e2e-web-{}", std::process::id());
    phf["meta"]["handId"] = json!(id);
    phf["meta"]["handKey"] = json!(id);
    let site = phf["meta"]["siteId"].as_str().unwrap().to_lowercase();
    let web_key = format!("{site}:{id}");
    let saved: Value = reqwest::Client::new()
        .post(format!("{url}/rest/v1/rpc/save_hands"))
        .header("apikey", &anon)
        .bearer_auth(&token_a)
        .json(&json!({ "p_hands": [{
            "hand_key": web_key, "phf": phf, "site": site, "standard_text": "Hand saved on the web"
        }]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["inserted"], 1, "{saved}");
    println!("3. a hand saved on the web as A; waiting 65 s for it to settle");
    tokio::time::sleep(Duration::from_secs(65)).await;

    let s3 = work.join("s3").join(rail_store::FILE_NAME);
    let store3 = Store::open(&s3).unwrap();
    let (worker3, task3) = worker(&config, Arc::clone(&account_a), &store3);
    let started = Instant::now();
    let total = u64::try_from(server.len() + 1).unwrap();
    until(
        "the pull into an empty store",
        Duration::from_secs(600),
        || {
            let status = worker3.status();
            status.pulled >= total && status.phase == SyncPhase::UpToDate
        },
    )
    .await;
    let status3 = store3.status().unwrap();
    assert_eq!(status3.hands, total);
    assert_eq!(status3.outbox, 0, "pulled hands are not queued");
    assert!(store3.reader().hand_phf(&web_key).unwrap().is_some());
    println!(
        "3. an empty second store pulled all {total} of A's hands (the web hand included) in {} ms; \
         nothing queued",
        started.elapsed().as_millis()
    );
    worker_a.sync_now();
    until("the first store's pull", Duration::from_secs(60), || {
        worker_a.status().pulled >= 1
    })
    .await;
    assert_eq!(worker_a.status().pulled, 1, "only the web hand is fetched");
    assert!(store.reader().hand_phf(&web_key).unwrap().is_some());
    println!("3. the first store fetched only the web hand");

    worker3.stop();
    worker_a.stop();
    let _ = task3.await;
    let _ = task_a.await;
    drop(store3);
    drop(store_b);
    drop(store);
    let _ = std::fs::remove_dir_all(&work);
    println!("sync e2e: all passed");
}

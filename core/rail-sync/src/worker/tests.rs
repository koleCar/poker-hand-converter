//! The sync worker against a scripted PostgREST: batching, backoff, the rate
//! limit, 401 then refresh, refused hands, a lost answer, an account change,
//! live-first order, the pull, and the pieces (pacing, backoff, labels).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rail_store::Store;
use rail_store::import::{ImportOptions, import_file};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use super::*;
use crate::auth::AuthConfig;

// ------------------------------------------------------------ the server --

/// What the next `ingest_hands` call gets instead of the normal answer.
#[derive(Debug, Clone)]
enum Act {
    /// Answer with this status and body; store nothing.
    Answer(u16, String),
    /// Store the rows, then answer with this status (the answer is lost).
    StoreThenFail(u16),
}

#[derive(Debug, Clone)]
struct ServerHand {
    id: String,
    seq: u64,
    user: String,
    key: String,
    phf: Value,
    origin: &'static str,
}

/// One call as the server saw it.
#[derive(Debug, Clone)]
struct Call {
    path: String,
    token: String,
    /// `ingest_hands`: the keys sent, in order.
    keys: Vec<String>,
    /// `hands_since`: the cursor sent.
    after: Option<String>,
}

#[derive(Default)]
struct Server {
    hands: Mutex<Vec<ServerHand>>,
    /// (user, device, local id) -> source id.
    sources: Mutex<HashMap<(String, String, String), String>>,
    calls: Mutex<Vec<Call>>,
    script: Mutex<VecDeque<Act>>,
    /// Keys `ingest_hands` refuses, with the reason.
    refuse: Mutex<HashMap<String, String>>,
    seq: AtomicU32,
    /// Refuse every connection (the network is down).
    down: AtomicBool,
    /// (R3.9) `hud_layouts`.
    hud: Mutex<HudRows>,
}

/// (R3.9) The server's `hud_layouts`: (user, kind, key) -> (body, updatedAt).
type HudRows = HashMap<(String, String, String), (Value, i64)>;

impl Server {
    fn uuid(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    fn user_of(token: &str) -> Option<String> {
        let mut parts = token.split(':');
        (parts.next() == Some("tok")).then(|| parts.next().unwrap_or("").to_owned())
    }

    fn rows_of(&self, user: &str) -> Vec<ServerHand> {
        self.hands
            .lock()
            .unwrap()
            .iter()
            .filter(|h| h.user == user)
            .cloned()
            .collect()
    }

    fn ingest_calls(&self) -> Vec<Call> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.path.ends_with("/ingest_hands"))
            .cloned()
            .collect()
    }

    fn handle(&self, method: &str, path: &str, token: &str, body: &[u8]) -> (u16, String) {
        let Some(user) = Self::user_of(token) else {
            return (401, r#"{"code":"PGRST301","message":"JWT invalid"}"#.into());
        };
        let body: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let mut call = Call {
            path: path.split('?').next().unwrap_or("").to_owned(),
            token: token.to_owned(),
            keys: Vec::new(),
            after: None,
        };
        let answer = match (method, call.path.as_str()) {
            ("POST", "/rest/v1/rpc/register_hand_source") => {
                let key = (
                    user.clone(),
                    body["p_device_id"].as_str().unwrap_or("").to_owned(),
                    body["p_local_id"].as_str().unwrap_or("").to_owned(),
                );
                assert!(
                    !body["p_label"].as_str().unwrap_or("").contains(['/', '\\']),
                    "no path in a label"
                );
                let id = self
                    .sources
                    .lock()
                    .unwrap()
                    .entry(key)
                    .or_insert_with(|| self.uuid())
                    .clone();
                (200, format!("\"{id}\""))
            }
            ("POST", "/rest/v1/rpc/ingest_hands") => {
                let rows = body["p_rows"].as_array().cloned().unwrap_or_default();
                call.keys = rows
                    .iter()
                    .map(|r| r["hand_key"].as_str().unwrap_or("").to_owned())
                    .collect();
                let source = body["p_source"].as_str().unwrap_or("");
                let owned = self
                    .sources
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|((u, _, _), id)| *u == user && id == source);
                let act = self.script.lock().unwrap().pop_front();
                match act {
                    Some(Act::Answer(status, body)) => (status, body),
                    _ if !owned => (409, r#"{"code":"23503","message":"No hand source"}"#.into()),
                    act => {
                        let report = self.ingest(&user, &rows);
                        match act {
                            Some(Act::StoreThenFail(status)) => (status, "{}".into()),
                            _ => (200, report.to_string()),
                        }
                    }
                }
            }
            ("POST", "/rest/v1/rpc/hands_since") => {
                let after = body["p_after_created"].as_str().map(|c| {
                    (
                        c.parse::<u64>().unwrap(),
                        body["p_after_id"].as_str().unwrap().to_owned(),
                    )
                });
                call.after = body["p_after_created"].as_str().map(str::to_owned);
                let limit = usize::try_from(body["p_limit"].as_u64().unwrap()).unwrap();
                let mut rows = self.rows_of(&user);
                rows.sort_by(|a, b| (a.seq, &a.id).cmp(&(b.seq, &b.id)));
                let page: Vec<Value> = rows
                    .into_iter()
                    .filter(|h| {
                        after
                            .as_ref()
                            .is_none_or(|(seq, id)| (h.seq, &h.id) > (*seq, id))
                    })
                    .take(limit)
                    .map(|h| {
                        json!({"id": h.id, "created_at": h.seq.to_string(),
                               "hand_key": h.key, "origin": h.origin})
                    })
                    .collect();
                (200, Value::Array(page).to_string())
            }
            ("POST", "/rest/v1/rpc/put_hud_layouts") => {
                // Last writer wins, as `put_hud_layouts` does.
                let rows = body["p_rows"].as_array().cloned().unwrap_or_default();
                let mut hud = self.hud.lock().unwrap();
                let out: Vec<Value> = rows
                    .iter()
                    .map(|row| {
                        let kind = row["kind"].as_str().unwrap().to_owned();
                        let key = row["key"].as_str().unwrap().to_owned();
                        call.keys.push(format!("{kind}/{key}"));
                        let at = row["updatedAt"].as_i64().unwrap();
                        let slot = (user.clone(), kind.clone(), key.clone());
                        let applied = hud.get(&slot).is_none_or(|(_, old)| *old < at);
                        if applied {
                            hud.insert(slot, (row["body"].clone(), at));
                        }
                        json!({"kind": kind, "key": key, "applied": applied})
                    })
                    .collect();
                (200, Value::Array(out).to_string())
            }
            ("GET", "/rest/v1/hud_layouts") => {
                let mut rows: Vec<(String, String, Value, i64)> = self
                    .hud
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|((u, _, _), _)| *u == user)
                    .map(|((_, kind, key), (body, at))| {
                        (kind.clone(), key.clone(), body.clone(), *at)
                    })
                    .collect();
                rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
                let rows: Vec<Value> = rows
                    .into_iter()
                    .map(|(kind, key, body, at)| {
                        json!({"kind": kind, "key": key, "body": body, "updated_at": at})
                    })
                    .collect();
                (200, Value::Array(rows).to_string())
            }
            ("GET", "/rest/v1/hands") => {
                let query = path.split('?').nth(1).unwrap_or("");
                let url = Url::parse(&format!("http://x/?{query}")).unwrap();
                let ids = url
                    .query_pairs()
                    .find(|(k, _)| k == "id")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let ids: Vec<String> = ids
                    .trim_start_matches("in.(")
                    .trim_end_matches(')')
                    .split(',')
                    .map(str::to_owned)
                    .collect();
                call.keys = ids.clone();
                let rows: Vec<Value> = self
                    .rows_of(&user)
                    .into_iter()
                    .filter(|h| ids.contains(&h.id))
                    .map(|h| json!({"hand_key": h.key, "phf": h.phf}))
                    .collect();
                (200, Value::Array(rows).to_string())
            }
            _ => (404, r#"{"code":"PGRST202"}"#.into()),
        };
        self.calls.lock().unwrap().push(call);
        answer
    }

    fn ingest(&self, user: &str, rows: &[Value]) -> Value {
        let mut out = Vec::new();
        let (mut ins, mut dup, mut rej) = (0, 0, 0);
        for row in rows {
            let key = row["hand_key"].as_str().unwrap_or("").to_owned();
            assert_eq!(row["phf"]["meta"]["rawText"], "", "no raw text is sent");
            if let Some(reason) = self.refuse.lock().unwrap().get(&key) {
                rej += 1;
                out.push(json!({"handKey": key, "status": "rejected", "reason": reason}));
                continue;
            }
            let mut hands = self.hands.lock().unwrap();
            if hands.iter().any(|h| h.user == user && h.key == key) {
                dup += 1;
                out.push(json!({"handKey": key, "status": "duplicate"}));
            } else {
                ins += 1;
                let seq = u64::from(self.seq.fetch_add(1, Ordering::SeqCst));
                hands.push(ServerHand {
                    id: format!("10000000-0000-4000-8000-{seq:012x}"),
                    seq,
                    user: user.to_owned(),
                    key: key.clone(),
                    phf: row["phf"].clone(),
                    origin: "desktop",
                });
                out.push(json!({"handKey": key, "status": "inserted"}));
            }
        }
        json!({"received": rows.len(), "inserted": ins, "duplicates": dup, "rejected": rej, "rows": out})
    }
}

/// Serve `server` on a loopback port, one request per connection.
async fn serve(server: Arc<Server>) -> Url {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let server = Arc::clone(&server);
            tokio::spawn(async move {
                if server.down.load(Ordering::SeqCst) {
                    return; // dropped: the client sees a closed connection
                }
                let mut request = Vec::new();
                let mut buffer = vec![0u8; 64 * 1024];
                let (head, body) = loop {
                    let Ok(n) = socket.read(&mut buffer).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..n]);
                    let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&request[..end]).to_string();
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break (head, request[end + 4..end + 4 + length].to_vec());
                    }
                };
                let mut words = head.split_whitespace();
                let method = words.next().unwrap_or("").to_owned();
                let path = words.next().unwrap_or("").to_owned();
                let token = head
                    .lines()
                    .find_map(|l| l.strip_prefix("authorization: Bearer "))
                    .unwrap_or("")
                    .to_owned();
                let (status, body) = server.handle(&method, &path, &token, &body);
                let response = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    url
}

// ----------------------------------------------------------- the account --

#[derive(Default)]
struct FakeAccount {
    user: Mutex<Option<SyncUser>>,
    refreshes: AtomicUsize,
}

impl FakeAccount {
    fn signed_in(id: &str) -> Arc<Self> {
        let account = Arc::new(Self::default());
        account.sign_in(id);
        account
    }

    fn sign_in(&self, id: &str) {
        *self.user.lock().unwrap() = Some(SyncUser {
            user_id: id.to_owned(),
            email: format!("{id}@example.test"),
        });
    }

    fn sign_out(&self) {
        *self.user.lock().unwrap() = None;
    }
}

impl SyncAccount for FakeAccount {
    fn user(&self) -> Option<SyncUser> {
        self.user.lock().unwrap().clone()
    }

    async fn access_token_for(&self, user_id: &str) -> Option<Secret> {
        let current = self.user.lock().unwrap().clone()?;
        (current.user_id == user_id).then(|| {
            Secret::new(format!(
                "tok:{user_id}:{}",
                self.refreshes.load(Ordering::SeqCst)
            ))
        })
    }

    async fn refresh(&self) -> Result<(), ApiError> {
        self.refreshes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

// -------------------------------------------------------------- harness --

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The PokerStars samples, sorted.
fn stars_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(repo().join("fixtures/samples/pokerstars"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "txt"))
        .collect();
    files.sort();
    files
}

fn scratch(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rail-sync-worker-{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn import(store: &Store, files: &[PathBuf]) {
    for file in files {
        import_file(
            store,
            file,
            &ImportOptions {
                parsed_at: Some("2026-10-13T00:00:00.000Z".into()),
                source_id: None,
            },
        )
        .unwrap();
    }
}

fn config() -> SyncConfig {
    SyncConfig {
        batch_hands: 25,
        idle_poll: Duration::from_millis(200),
        pull_every: Duration::from_secs(3600),
        hud_pull_every: Duration::from_secs(3600),
        backoff_first: Duration::from_millis(40),
        backoff_max: Duration::from_millis(400),
        rate_limit_first: Duration::from_millis(80),
        device_name: Some("Test Mac".into()),
        ..SyncConfig::default()
    }
}

struct Rig {
    server: Arc<Server>,
    store: Option<Store>,
    worker: SyncWorker,
    task: Option<tokio::task::JoinHandle<()>>,
    changes: Arc<AtomicUsize>,
    dir: PathBuf,
}

impl Rig {
    async fn new<A: SyncAccount>(
        name: &str,
        account: A,
        files: &[PathBuf],
        config: SyncConfig,
    ) -> Self {
        let server = Arc::new(Server::default());
        let url = serve(Arc::clone(&server)).await;
        let dir = scratch(name);
        let store = Store::open(dir.join("rail.db")).unwrap();
        import(&store, files);
        Self::start(server, &url, store, dir, account, config)
    }

    fn start<A: SyncAccount>(
        server: Arc<Server>,
        url: &Url,
        store: Store,
        dir: PathBuf,
        account: A,
        config: SyncConfig,
    ) -> Self {
        let auth = AuthConfig::new(url.as_str(), "anon-key", "http://localhost:3000").unwrap();
        let client = IngestClient::new(&auth).unwrap();
        let access = StoreAccess::open(store.path(), store.writer().unwrap()).unwrap();
        let changes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&changes);
        let (worker, task) = SyncWorker::new(
            config,
            account,
            client,
            access,
            Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let task = Some(tokio::spawn(task.run()));
        Self {
            server,
            store: Some(store),
            worker,
            task,
            changes,
            dir,
        }
    }

    async fn until(&self, what: &str, mut done: impl FnMut(&SyncStatus) -> bool) -> SyncStatus {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let status = self.worker.status();
            if done(&status) {
                return status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}: {status:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn drained(&self) -> SyncStatus {
        self.until("an empty outbox", |s| {
            s.phase == SyncPhase::UpToDate && s.outbox == 0
        })
        .await
    }

    fn store(&self) -> &Store {
        self.store.as_ref().unwrap()
    }

    fn hands(&self) -> u64 {
        self.store().status().unwrap().hands
    }

    async fn stop(mut self) -> (Store, PathBuf, Arc<Server>) {
        self.worker.stop();
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
        (
            self.store.take().unwrap(),
            self.dir.clone(),
            Arc::clone(&self.server),
        )
    }
}

impl Drop for Rig {
    /// A failed assertion must not hang the test: the store waits for the
    /// worker's writer handle when it closes.
    fn drop(&mut self) {
        self.worker.stop();
    }
}

fn keys_of(calls: &[Call]) -> Vec<String> {
    calls.iter().flat_map(|c| c.keys.clone()).collect()
}

// ---------------------------------------------------------------- tests --

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_outbox_drains_in_batches_under_one_registered_source() {
    let files = stars_files();
    let rig = Rig::new("drain", FakeAccount::signed_in("a"), &files, config()).await;
    let hands = rig.hands();
    assert!(hands > 25, "{hands}");
    let status = rig.drained().await;
    assert_eq!(status.rejected, []);
    assert!(status.last_sync_at.is_some());
    assert!(status.hands_per_second.is_some());

    let calls = rig.server.ingest_calls();
    assert!(calls.iter().all(|c| c.keys.len() <= 25));
    assert_eq!(calls.len(), usize::try_from(hands.div_ceil(25)).unwrap());
    let sent = keys_of(&calls);
    assert_eq!(
        sent.len(),
        usize::try_from(hands).unwrap(),
        "each hand once"
    );
    assert_eq!(rig.server.rows_of("a").len(), sent.len());
    assert!(calls.iter().all(|c| c.token == "tok:a:0"));
    let registered: Vec<_> = rig.server.sources.lock().unwrap().keys().cloned().collect();
    assert_eq!(registered.len(), 1, "one source, registered once");
    assert_eq!(registered[0].2, "unfiled");
    let device = rig.store().reader().kv("sync.device").unwrap().unwrap();
    assert_eq!(registered[0].1, device);
    assert!(SourceId::parse(&device).is_some());
    let owner: SyncUser =
        serde_json::from_str(&rig.store().reader().kv(OWNER_KEY).unwrap().unwrap()).unwrap();
    assert_eq!(owner.user_id, "a", "the first account owns the store");
    assert!(rig.changes.load(Ordering::SeqCst) > 0);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hands_played_last_go_first() {
    let files = stars_files();
    let rig = Rig::new("live", FakeAccount::signed_in("a"), &files[..12], config()).await;
    rig.drained().await;
    let first = &rig.server.ingest_calls()[0];
    let played: Vec<String> = first
        .keys
        .iter()
        .map(|key| {
            let phf: Value =
                serde_json::from_str(&rig.store().reader().hand_phf(key).unwrap().unwrap())
                    .unwrap();
            phf["playedAt"].as_str().unwrap_or("").to_owned()
        })
        .collect();
    let mut sorted = played.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(played, sorted, "newest played first");
    let newest = rig
        .server
        .rows_of("a")
        .iter()
        .map(|h| h.phf["playedAt"].as_str().unwrap_or("").to_owned())
        .max()
        .unwrap();
    assert_eq!(played[0], newest, "the hand played last went first");
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_server_backs_off_and_resumes() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    server.down.store(true, Ordering::SeqCst);
    let dir = scratch("offline");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..6]);
    let hands = store.status().unwrap().hands;
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    let status = rig
        .until("offline", |s| matches!(s.phase, SyncPhase::Offline { .. }))
        .await;
    assert!(status.outbox > 0);
    server.down.store(false, Ordering::SeqCst);
    let status = rig.drained().await;
    assert_eq!(status.retrying, 0);
    assert_eq!(
        server.rows_of("a").len(),
        usize::try_from(hands).unwrap(),
        "every hand, once"
    );
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_batch_waits_its_turn_and_a_lost_answer_costs_one_resend() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    server
        .script
        .lock()
        .unwrap()
        .extend([Act::Answer(503, "{}".into()), Act::StoreThenFail(502)]);
    let dir = scratch("lost");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..6]);
    let hands = usize::try_from(store.status().unwrap().hands).unwrap();
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    rig.drained().await;
    let calls = server.ingest_calls();
    // The 503 batch was retried, the batch whose answer was lost was sent
    // again and came back duplicate: the server has each hand once.
    assert_eq!(server.rows_of("a").len(), hands);
    let sent = keys_of(&calls);
    assert!(
        sent.len() > hands,
        "resends happened: {} of {hands}",
        sent.len()
    );
    let mut unique = sent.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), hands);
    let synced: u64 = rig.store().status().unwrap().outbox;
    assert_eq!(synced, 0);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_spent_budget_waits_then_probes_with_one_hand() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    server.script.lock().unwrap().push_back(Act::Answer(
        500,
        r#"{"code":"53400","message":"Write rate limit exceeded for bucket \"desktop_ingest:a\" (150000 per 00:10:00). Try again later."}"#.into(),
    ));
    let dir = scratch("rate");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..6]);
    let hands = usize::try_from(store.status().unwrap().hands).unwrap();
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    rig.until("rate limited", |s| {
        matches!(s.phase, SyncPhase::RateLimited { .. })
    })
    .await;
    rig.drained().await;
    let calls = server.ingest_calls();
    let sizes: Vec<usize> = calls.iter().map(|c| c.keys.len()).collect();
    assert_eq!(sizes[0], 25.min(hands), "the refused batch");
    assert_eq!(sizes[1], 1, "then one hand as a probe");
    assert!(sizes[2] > 1, "then full batches: {sizes:?}");
    assert_eq!(server.rows_of("a").len(), hands);
    // No attempt was counted against the hands.
    assert_eq!(rig.worker.status().retrying, 0);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_401_refreshes_once_and_sends_with_the_new_token() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    server.script.lock().unwrap().push_back(Act::Answer(
        401,
        r#"{"code":"PGRST301","message":"JWT expired"}"#.into(),
    ));
    let dir = scratch("401");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..2]);
    let account = FakeAccount::signed_in("a");
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        Arc::clone(&account),
        config(),
    );
    rig.drained().await;
    assert_eq!(account.refreshes.load(Ordering::SeqCst), 1);
    let tokens: Vec<String> = server
        .ingest_calls()
        .iter()
        .map(|c| c.token.clone())
        .collect();
    assert_eq!(tokens[0], "tok:a:0");
    assert!(tokens[1..].iter().all(|t| t == "tok:a:1"), "{tokens:?}");
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_hands_are_kept_with_their_reason_and_not_resent() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    let dir = scratch("refused");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..4]);
    let hands = usize::try_from(store.status().unwrap().hands).unwrap();
    let now = rail_store::time::now_ms() + 1;
    let all: Vec<String> = store
        .reader()
        .outbox_next(now, now, 100)
        .unwrap()
        .into_iter()
        .map(|e| e.hand_key)
        .collect();
    server.refuse.lock().unwrap().extend([
        (all[0].clone(), "invalid".to_owned()),
        (all[1].clone(), "invalid".to_owned()),
        (all[2].clone(), "shape".to_owned()),
    ]);
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    let status = rig.drained().await;
    assert_eq!(
        status.rejected,
        [
            RejectedCount {
                reason: "invalid".into(),
                count: 2
            },
            RejectedCount {
                reason: "shape".into(),
                count: 1
            }
        ]
    );
    assert_eq!(server.rows_of("a").len(), hands - 3);
    let sent = keys_of(&server.ingest_calls()).len();
    assert_eq!(sent, hands, "each hand sent once");

    // "Sync now" does not resend them...
    rig.worker.sync_now();
    tokio::time::sleep(Duration::from_millis(300)).await;
    rig.drained().await;
    assert_eq!(keys_of(&server.ingest_calls()).len(), hands);

    // ..."Try again" does, and now the server takes them.
    server.refuse.lock().unwrap().clear();
    rig.worker.retry_rejected();
    rig.until("the refused hands sent", |s| {
        s.rejected.is_empty() && s.outbox == 0 && s.phase == SyncPhase::UpToDate
    })
    .await;
    assert_eq!(server.rows_of("a").len(), hands);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_account_gets_nothing_until_the_user_agrees() {
    let files = stars_files();
    let account = FakeAccount::signed_in("a");
    let rig = Rig::new("accounts", Arc::clone(&account), &files[..4], config()).await;
    rig.drained().await;
    let first = rig.server.rows_of("a").len();

    // Signed out: hands arrive, nothing is sent.
    account.sign_out();
    rig.worker.account_changed();
    rig.until("signed out", |s| s.phase == SyncPhase::SignedOut)
        .await;
    import(rig.store(), &files[4..8]);
    rig.worker.wake();
    let status = rig.until("counted", |s| s.outbox > 0).await;
    let waiting = status.outbox;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let calls_before = rig.server.ingest_calls().len();

    // Another account: asked, nothing sent or pulled.
    account.sign_in("b");
    rig.worker.account_changed();
    let status = rig
        .until("the question", |s| {
            matches!(s.phase, SyncPhase::AccountMismatch { .. })
        })
        .await;
    let total = rig.hands();
    assert_eq!(
        status.phase,
        SyncPhase::AccountMismatch {
            owner_email: Some("a@example.test".into()),
            email: "b@example.test".into(),
            local_hands: total,
        }
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(rig.server.ingest_calls().len(), calls_before);
    assert!(
        rig.server
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|c| !c.token.starts_with("tok:b")),
        "nothing at all with B's token"
    );

    // "Keep apart": still nothing.
    rig.worker.answer_account("b", false);
    rig.until("declined", |s| {
        matches!(s.phase, SyncPhase::Declined { .. })
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(rig.server.ingest_calls().len(), calls_before);

    // Back to A: the waiting hands go to A.
    account.sign_in("a");
    rig.worker.account_changed();
    rig.drained().await;
    assert_eq!(
        rig.server.rows_of("a").len(),
        first + usize::try_from(waiting).unwrap()
    );
    assert!(rig.server.rows_of("b").is_empty());

    // B again, and this time upload: every local hand goes to B.
    account.sign_in("b");
    rig.worker.account_changed();
    rig.until("the question again", |s| {
        matches!(s.phase, SyncPhase::Declined { .. })
    })
    .await;
    rig.worker.answer_account("b", true);
    rig.drained().await;
    assert_eq!(
        rig.server.rows_of("b").len(),
        usize::try_from(total).unwrap()
    );
    assert_eq!(
        rig.server.rows_of("a").len(),
        first + usize::try_from(waiting).unwrap(),
        "A got nothing more"
    );
    let owner: SyncUser =
        serde_json::from_str(&rig.store().reader().kv(OWNER_KEY).unwrap().unwrap()).unwrap();
    assert_eq!(owner.user_id, "b");
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pause_holds_everything_and_survives_a_restart() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    let dir = scratch("pause");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..3]);
    // Paused while signed out (so nothing went yet), then restarted.
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        Arc::new(FakeAccount::default()),
        config(),
    );
    rig.until("signed out", |s| s.phase == SyncPhase::SignedOut)
        .await;
    rig.worker.set_paused(true).unwrap();
    let (store, dir, server) = rig.stop().await;
    let before = server.calls.lock().unwrap().len();

    // A new worker on the same store starts paused.
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    let status = rig.until("paused", |s| s.phase == SyncPhase::Paused).await;
    assert!(status.paused && status.outbox > 0);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let ingested_while_paused = server
        .calls
        .lock()
        .unwrap()
        .iter()
        .skip(before)
        .filter(|c| c.path.ends_with("/ingest_hands"))
        .count();
    assert_eq!(ingested_while_paused, 0);
    rig.worker.set_paused(false).unwrap();
    rig.drained().await;
    rig.stop().await;
}

/// (R6.4) The server refuses a Free account's desktop rows with `PT402`
/// (HTTP 402, R6.2): sync holds with the feature, counts no attempt, sends
/// nothing more, keeps every hand queued - and goes on once the app's next
/// plan check allows it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_402_holds_sync_with_the_hands_queued_until_the_plan_allows_it() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    server.script.lock().unwrap().push_back(Act::Answer(
        402,
        r#"{"code":"PT402","message":"Syncing hands from the desktop app is a Pro feature. Upgrade to Pro to sync.","details":null,"hint":"desktop_sync"}"#.into(),
    ));
    let dir = scratch("plan402");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..3]);
    let hands = store.status().unwrap().hands;
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    let status = rig
        .until("held by the plan", |s| {
            s.phase
                == SyncPhase::PlanRequired {
                    feature: "desktop_sync".into(),
                }
        })
        .await;
    assert_eq!(status.retrying, 0, "no attempt counted");
    // Several idle polls: nothing more is sent, every hand still waits.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(server.ingest_calls().len(), 1, "the refused call only");
    let status = rig.worker.status();
    assert_eq!(status.outbox, hands);
    assert!(matches!(status.phase, SyncPhase::PlanRequired { .. }));
    assert!(server.rows_of("a").is_empty());
    // The plan was checked again and allows sync.
    rig.worker.set_plan_allows(true);
    rig.drained().await;
    assert_eq!(server.rows_of("a").len(), usize::try_from(hands).unwrap());
    rig.stop().await;
}

/// (R6.4) The app's own check said the plan lacks desktop sync: nothing is
/// sent or pulled - no call at all - until it says otherwise.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_apps_plan_check_holds_sync_without_a_call() {
    let files = stars_files();
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    let dir = scratch("plancheck");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..3]);
    let account = Arc::new(FakeAccount::default());
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        Arc::clone(&account),
        config(),
    );
    rig.until("signed out", |s| s.phase == SyncPhase::SignedOut)
        .await;
    rig.worker.set_plan_allows(false);
    account.sign_in("a");
    rig.worker.account_changed();
    rig.until(
        "held by the plan",
        |s| matches!(&s.phase, SyncPhase::PlanRequired { feature } if feature == "desktop_sync"),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(server.calls.lock().unwrap().len(), 0, "no call at all");
    // Signed out again: the usual phase, not the plan's.
    account.sign_out();
    rig.worker.account_changed();
    rig.until("signed out", |s| s.phase == SyncPhase::SignedOut)
        .await;
    account.sign_in("a");
    rig.worker.set_plan_allows(true);
    rig.drained().await;
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_source_is_registered_again() {
    let files = stars_files();
    let rig = Rig::new(
        "unknown",
        FakeAccount::signed_in("a"),
        &files[..2],
        config(),
    )
    .await;
    rig.drained().await;
    // The server forgot the folder (say, a reset): register again, go on.
    rig.server.sources.lock().unwrap().clear();
    let before = rig.hands();
    import(rig.store(), &files[2..6]);
    let total = rig.hands();
    assert!(total > before);
    rig.worker.wake();
    let server = Arc::clone(&rig.server);
    rig.until("drained again", |s| {
        s.outbox == 0 && server.rows_of("a").len() == usize::try_from(total).unwrap()
    })
    .await;
    let registrations = rig
        .server
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.path.ends_with("/register_hand_source"))
        .count();
    assert_eq!(registrations, 2);
    assert_eq!(
        usize::try_from(rig.hands()).unwrap(),
        rig.server.rows_of("a").len()
    );
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pull_stores_the_accounts_other_hands_once_without_queueing_them() {
    let files = stars_files();
    // The account's library on the server: hands uploaded on the web and
    // from another computer, from PHF made here.
    let source_dir = scratch("pull-source");
    let source = Store::open(source_dir.join("rail.db")).unwrap();
    import(&source, &files[..10]);
    let now = rail_store::time::now_ms() + 1;
    let remote = source.reader().outbox_next(now, now, 1000).unwrap();
    let server = Arc::new(Server::default());
    for (i, entry) in remote.iter().enumerate() {
        let seq = u64::from(server.seq.fetch_add(1, Ordering::SeqCst));
        server.hands.lock().unwrap().push(ServerHand {
            id: format!("20000000-0000-4000-8000-{seq:012x}"),
            seq,
            user: "a".into(),
            key: entry.hand_key.clone(),
            phf: serde_json::from_str(&entry.phf).unwrap(),
            origin: if i % 2 == 0 { "web" } else { "desktop" },
        });
    }
    let url = serve(Arc::clone(&server)).await;
    // This computer has two of those hands already, from its own file.
    let dir = scratch("pull");
    let store = Store::open(dir.join("rail.db")).unwrap();
    import(&store, &files[..1]);
    let own = store.status().unwrap().hands;
    let rig = Rig::start(
        Arc::clone(&server),
        &url,
        store,
        dir,
        FakeAccount::signed_in("a"),
        SyncConfig {
            pull_page: 7,
            ..config()
        },
    );
    let status = rig
        .until("pulled", |s| {
            s.phase == SyncPhase::UpToDate && s.outbox == 0 && s.pulled > 0
        })
        .await;
    let total = u64::try_from(remote.len()).unwrap();
    assert_eq!(status.pulled, total - own);
    assert_eq!(rig.hands(), total);
    assert_eq!(
        rig.store().status().unwrap().outbox,
        0,
        "pulled hands are not queued"
    );
    for entry in &remote {
        assert_eq!(
            rig.store()
                .reader()
                .hand_phf(&entry.hand_key)
                .unwrap()
                .as_deref(),
            Some(entry.phf.as_str()),
            "the same canonical PHF"
        );
    }
    let calls = server.calls.lock().unwrap().clone();
    let fetched: usize = calls
        .iter()
        .filter(|c| c.path == "/rest/v1/hands")
        .map(|c| c.keys.len())
        .sum();
    assert_eq!(
        fetched,
        usize::try_from(total - own).unwrap(),
        "only the missing PHF is fetched"
    );
    let pages: Vec<&Call> = calls
        .iter()
        .filter(|c| c.path.ends_with("/hands_since"))
        .collect();
    assert!(pages.len() >= usize::try_from(total.div_ceil(7)).unwrap());
    assert_eq!(pages[0].after, None);
    let cursor = rig.store().reader().kv("sync.pull.a").unwrap().unwrap();
    assert!(cursor.contains("createdAt"));

    // Again: from the cursor, nothing new.
    let before = calls.len();
    rig.worker.sync_now();
    rig.until("pulled again", |_| {
        server.calls.lock().unwrap()[before..]
            .iter()
            .any(|c| c.path.ends_with("/hands_since"))
    })
    .await;
    let calls = server.calls.lock().unwrap().clone();
    let again: Vec<&Call> = calls[before..]
        .iter()
        .filter(|c| c.path.ends_with("/hands_since"))
        .collect();
    assert_eq!(
        again[0].after.as_deref(),
        Some((total - 1).to_string().as_str())
    );
    assert!(calls[before..].iter().all(|c| c.path != "/rest/v1/hands"));
    rig.stop().await;
}

// ---------------------------------------------------------------- pieces --

#[test]
fn the_pacer_spaces_sends_to_the_cap() {
    let start = Instant::now();
    let mut pacer = Pacer::default();
    assert_eq!(pacer.wait(start), None);
    // 1 MB at 1 MB/s: the next send waits a second from the start.
    pacer.sent(1_000_000, Some(1_000_000), start);
    assert_eq!(pacer.wait(start), Some(Duration::from_secs(1)));
    assert_eq!(
        pacer.wait(start + Duration::from_millis(400)),
        Some(Duration::from_millis(600))
    );
    // A send started before the slot was free still adds after it.
    pacer.sent(500_000, Some(1_000_000), start + Duration::from_millis(200));
    assert_eq!(pacer.wait(start), Some(Duration::from_millis(1500)));
    assert_eq!(pacer.wait(start + Duration::from_secs(2)), None);
    // No cap: no wait.
    pacer.sent(10_000_000, None, start);
    assert_eq!(pacer.wait(start), None);
}

#[test]
fn backoff_doubles_with_jitter_to_its_cap() {
    let first = Duration::from_secs(5);
    let max = Duration::from_secs(600);
    for _ in 0..50 {
        let one = backoff(first, max, 1);
        assert!(
            one >= Duration::from_millis(2500) && one <= first,
            "{one:?}"
        );
        let three = backoff(first, max, 3);
        assert!(three >= Duration::from_secs(10) && three <= Duration::from_secs(20));
        let many = backoff(first, max, 40);
        assert!(many >= Duration::from_secs(300) && many <= max);
    }
}

#[test]
fn a_folder_label_is_never_a_path() {
    assert_eq!(
        source_label(Some("weplay"), "/Users/p/Library/WePlay/hands/"),
        "weplay - hands"
    );
    assert_eq!(
        source_label(
            None,
            r"C:\Users\p\AppData\Local\PokerStars\HandHistory\Hero"
        ),
        "Hero"
    );
    assert_eq!(source_label(None, "/"), "folder");
    let long = source_label(Some("x"), &format!("/a/{}", "y".repeat(500)));
    assert_eq!(long.chars().count(), 120);
    for label in [
        source_label(Some("a/b"), "/c"),
        source_label(Some(r"a\b"), "/c"),
    ] {
        assert!(!label.contains(['/', '\\']), "{label}");
    }
}

#[test]
fn a_device_id_is_a_random_v4_uuid() {
    let a = new_device_id();
    let b = new_device_id();
    assert_ne!(a, b);
    assert!(SourceId::parse(&a).is_some(), "{a}");
    assert_eq!(&a[14..15], "4");
    assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
}

#[test]
fn the_status_serialises_for_the_window() {
    let status = SyncStatus {
        phase: SyncPhase::AccountMismatch {
            owner_email: Some("a@example.test".into()),
            email: "b@example.test".into(),
            local_hands: 3,
        },
        rejected: vec![RejectedCount {
            reason: "invalid".into(),
            count: 2,
        }],
        ..SyncStatus::default()
    };
    let value = serde_json::to_value(&status).unwrap();
    assert_eq!(value["phase"]["state"], "accountMismatch");
    assert_eq!(value["phase"]["ownerEmail"], "a@example.test");
    assert_eq!(value["phase"]["localHands"], 3);
    assert_eq!(value["rejected"][0]["reason"], "invalid");
    assert_eq!(value["cap"], DEFAULT_CAP);
    let offline = serde_json::to_value(SyncPhase::Offline { retry_at_ms: 5 }).unwrap();
    assert_eq!(offline, json!({"state": "offline", "retryAtMs": 5}));
}

/// (R3.9) The HUD's layouts follow the account to another computer: one
/// computer's design, assignment, dragged panel and room setting reach the
/// other through the server, and its hook runs; a later edit on the second
/// wins over an earlier one on the first (last writer by `updatedAt`), on
/// both; a delete and a reset travel as tombstones; nothing is resent once
/// sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hud_layouts_follow_the_account() {
    let server = Arc::new(Server::default());
    let url = serve(Arc::clone(&server)).await;
    let open = |name: &str| {
        let dir = scratch(name);
        let store = Store::open(dir.join("rail.db")).unwrap();
        (store, dir)
    };
    let (laptop, laptop_dir) = open("hud-laptop");
    let writer = laptop.writer().unwrap();
    writer
        .save_hud_layout("d-0001", r#"{"version":1,"name":"Laptop's"}"#)
        .unwrap();
    writer
        .set_hud_layout_assignment("pokerstars", 0, "cash", Some("d-0001"))
        .unwrap();
    writer.set_hud_seat_position("acr", 6, 2, 300, 400).unwrap();
    writer.set_hud_seat_position("acr", 6, 3, 500, 600).unwrap();
    writer
        .set_hud_preferred_seat("winamax", Some(true))
        .unwrap();
    drop(writer);
    // The laptop takes the account's HUD rows back on its own schedule
    // (`hud_pull_every`), with no "Sync now" or other event: that is how
    // another computer's edit reaches it.
    let laptop = Rig::start(
        Arc::clone(&server),
        &url,
        laptop,
        laptop_dir,
        FakeAccount::signed_in("a"),
        SyncConfig {
            hud_pull_every: Duration::from_millis(150),
            ..config()
        },
    );
    laptop
        .until("the laptop's rows on the server", |_| {
            server.hud.lock().unwrap().len() == 5
                && laptop.store().reader().hud_sync_dirty().unwrap().is_empty()
        })
        .await;

    // The desktop takes them all, and hears it.
    let (desktop, desktop_dir) = open("hud-desktop");
    let desktop = Rig::start(
        Arc::clone(&server),
        &url,
        desktop,
        desktop_dir,
        FakeAccount::signed_in("a"),
        config(),
    );
    let heard = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&heard);
    desktop.worker.on_hud_layouts(move || {
        count.fetch_add(1, Ordering::SeqCst);
    });
    desktop.worker.sync_now();
    desktop
        .until("the laptop's layouts here", |_| {
            desktop.store().reader().hud_seat_positions().unwrap().len() == 2
        })
        .await;
    let reader = desktop.store().reader();
    assert_eq!(reader.hud_layouts().unwrap()[0].id, "d-0001");
    assert_eq!(
        reader.hud_layout_assignments().unwrap()[0].layout_id,
        "d-0001"
    );
    assert_eq!(
        reader.hud_room_settings().unwrap()[0].preferred_seat,
        Some(true)
    );
    assert!(
        reader.hud_sync_dirty().unwrap().is_empty(),
        "pulled rows are not sent back"
    );
    laptop
        .until("the hook", |_| heard.load(Ordering::SeqCst) > 0)
        .await;

    // An edit on the laptop, then a later one on the desktop: the desktop's
    // wins on both. The desktop also resets slot 3 and deletes nothing yet.
    laptop
        .store()
        .writer()
        .unwrap()
        .save_hud_layout("d-0001", r#"{"version":1,"name":"Laptop, edited"}"#)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let desk = desktop.store().writer().unwrap();
    desk.save_hud_layout("d-0001", r#"{"version":1,"name":"Desktop's"}"#)
        .unwrap();
    desk.clear_hud_seat_positions("acr", Some(6)).unwrap();
    drop(desk);
    // The desktop sends its edit and its reset (whatever the laptop's
    // older edit did on the server meanwhile, the desktop's is newer).
    desktop.worker.sync_now();
    desktop
        .until("the desktop's edit on the server", |_| {
            let hud = server.hud.lock().unwrap();
            hud.get(&("a".into(), "layout".into(), "d-0001".into()))
                .is_some_and(|(body, _)| body["name"] == "Desktop's")
                && hud
                    .get(&("a".into(), "seat_position".into(), "acr|6|2".into()))
                    .is_some_and(|(body, _)| body.is_null())
        })
        .await;
    // The laptop takes it by its own HUD pull - no "Sync now" here.
    for rig in [&laptop, &desktop] {
        rig.until("the desktop's edit everywhere", |_| {
            let reader = rig.store().reader();
            reader.hud_layouts().unwrap()[0]
                .design
                .contains("Desktop's")
                && reader.hud_seat_positions().unwrap().is_empty()
                && reader.hud_sync_dirty().unwrap().is_empty()
        })
        .await;
    }
    // The design deleted on the laptop: a tombstone, and its assignment
    // cleared, on the desktop too.
    let lap = laptop.store().writer().unwrap();
    assert!(lap.delete_hud_layout("d-0001").unwrap());
    drop(lap);
    laptop.worker.sync_now();
    laptop
        .until("the delete sent", |_| {
            server
                .hud
                .lock()
                .unwrap()
                .get(&("a".into(), "layout".into(), "d-0001".into()))
                .is_some_and(|(body, _)| body.is_null())
        })
        .await;
    desktop.worker.sync_now();
    desktop
        .until("the delete here", |_| {
            let reader = desktop.store().reader();
            reader.hud_layouts().unwrap().is_empty()
                && reader.hud_layout_assignments().unwrap().is_empty()
        })
        .await;
    // Nothing is sent twice: every row went out once per change.
    let puts: Vec<String> = server
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.path.ends_with("/put_hud_layouts"))
        .flat_map(|c| c.keys.clone())
        .collect();
    let layout_puts = puts.iter().filter(|k| *k == "layout/d-0001").count();
    assert_eq!(layout_puts, 4, "save, edit, edit, delete: {puts:?}");
    laptop.stop().await;
    desktop.stop().await;
}

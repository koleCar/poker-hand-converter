//! The app's half of the web/app parity test (docs/RAIL-PLAN.md R4.4).
//!
//! Driven by `tests/scripts/parity/parity.test.ts` (`npm run parity` in
//! `tests/`), against a **local** Supabase stack; not meant to be run by
//! hand. It does what the desktop app does with a folder of hand histories,
//! with the app's own code from file to server:
//!
//! 1. a fresh local store (`rail-store`) and the watcher (`rail-watch`) on
//!    the folder, added as the app adds one ("Import everything",
//!    subfolders): the incremental reader converts with `rail-core`;
//! 2. the sync worker (`rail_sync::worker`) with the account manager over
//!    the session the harness made (a refresh token, as the keychain holds
//!    it), woken by every import as the app wakes it: the outbox goes out
//!    through `IngestClient` to `ingest_hands` from the folder's own
//!    `hand_sources` row;
//! 3. done when every file is read to its end, nothing is queued or being
//!    read, and the worker is up to date with an empty outbox.
//!
//! Only the upload cap is lifted (`set_cap(None)`): it paces the bytes,
//! never what is sent.
//!
//! Environment: `RAIL_PARITY_URL`, `RAIL_PARITY_ANON_KEY`,
//! `RAIL_PARITY_USER_ID`, `RAIL_PARITY_EMAIL`, `RAIL_PARITY_REFRESH` (a
//! refresh token of that user), `RAIL_PARITY_FOLDER` (the folder to watch)
//! and `RAIL_PARITY_WORK` (an empty directory for the store). Prints one JSON
//! line - counts and timings, never a token - and exits non-zero when a hand
//! was refused by the server or the run timed out.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rail_store::Store;
use rail_sync::auth::{Account, AuthConfig, GoTrue, MemoryStore, SecretStore};
use rail_sync::ingest::IngestClient;
use rail_sync::worker::{StoreAccess, SyncConfig, SyncPhase, SyncWorker};
use rail_watch::{NewSource, WatchConfig, WatchEvent, Watcher, scan};
use serde_json::json;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; see the header"))
}

/// The files the watcher will read under `folder` (its own rule).
fn candidates(folder: &Path) -> BTreeSet<PathBuf> {
    let mut out = BTreeSet::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if scan::is_candidate(&path) {
                out.insert(path);
            }
        }
    }
    out
}

/// Files of the store read to their end, and files it knows at all.
fn files_read(store: &Store) -> (i64, i64) {
    store
        .reader()
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT count(*), coalesce(sum(read_offset = size), 0) FROM files",
                [],
                |row| Ok((row.get(1)?, row.get(0)?)),
            )?)
        })
        .unwrap()
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = env("RAIL_PARITY_URL");
    let anon = env("RAIL_PARITY_ANON_KEY");
    let config = AuthConfig::new(&url, &anon, "http://localhost:3000").unwrap();
    let folder = PathBuf::from(env("RAIL_PARITY_FOLDER"));
    let work = PathBuf::from(env("RAIL_PARITY_WORK"));
    let expected = candidates(&folder);
    let expected_files = i64::try_from(expected.len()).unwrap();

    // The account, as the app holds it after a sign-in (R1.7).
    let secrets = MemoryStore::default();
    secrets
        .save(
            &json!({
                "v": 1,
                "supabaseUrl": config.supabase_url.as_str(),
                "userId": env("RAIL_PARITY_USER_ID"),
                "email": env("RAIL_PARITY_EMAIL"),
                "refreshToken": env("RAIL_PARITY_REFRESH"),
            })
            .to_string(),
        )
        .unwrap();
    let account = Arc::new(Account::new(
        config.clone(),
        GoTrue::new(&config).unwrap(),
        Box::new(secrets),
        Box::new(|| {}),
    ));

    let store = Store::open(work.join(rail_store::FILE_NAME)).unwrap();
    let access = StoreAccess::open(store.path(), store.writer().unwrap()).unwrap();
    let (worker, task) = SyncWorker::new(
        SyncConfig {
            device_name: Some("parity".into()),
            backoff_first: Duration::from_secs(1),
            backoff_max: Duration::from_secs(5),
            ..SyncConfig::default()
        },
        account,
        IngestClient::new(&config).unwrap(),
        access,
        Box::new(|| {}),
    );
    worker.set_cap(None).unwrap();
    let running = tokio::spawn(task.run());

    let started = Instant::now();
    let waker = worker.clone();
    let watcher = Watcher::start(
        store.path(),
        store.writer().unwrap(),
        WatchConfig::default(),
        move |event| {
            if let WatchEvent::Imported { inserted, .. } = event
                && inserted > 0
            {
                waker.wake();
            }
        },
    )
    .unwrap();
    watcher
        .add_source_with(&folder, &NewSource::default())
        .unwrap();

    // Imported: every file read to its end, nothing left to read.
    let deadline = started + Duration::from_secs(600);
    let import_ms = loop {
        let (done, known) = files_read(&store);
        let status = watcher.status().unwrap();
        let idle = status.queued == 0
            && status.reading == 0
            && status
                .sources
                .iter()
                .all(|s| s.pending == 0 && s.backfill.is_none());
        if idle && known == expected_files && done == known {
            break started.elapsed().as_millis();
        }
        if Instant::now() > deadline {
            eprintln!(
                "parity_app: import timed out: {done} of {known} files read to the end, {} expected",
                expected.len()
            );
            std::process::exit(3);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };

    // Synced: nothing waiting.
    worker.sync_now();
    let synced = Instant::now();
    loop {
        let status = worker.status();
        if status.phase == SyncPhase::UpToDate && status.outbox == 0 {
            break;
        }
        if Instant::now() > deadline {
            eprintln!(
                "parity_app: sync timed out: phase {:?}, {} hands wait",
                status.phase, status.outbox
            );
            std::process::exit(3);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let sync_ms = synced.elapsed().as_millis();

    let counts = store.status().unwrap();
    let status = worker.status();
    watcher.stop();
    worker.stop();
    let _ = running.await;
    let rejected: u64 = status.rejected.iter().map(|r| r.count).sum();
    println!(
        "{}",
        json!({
            "files": expected.len(),
            "hands": counts.hands,
            "quarantined": counts.quarantined,
            "rejected": status.rejected.iter().map(|r| json!({"reason": r.reason, "count": r.count})).collect::<Vec<_>>(),
            "importMs": import_ms,
            "syncMs": sync_ms,
        })
    );
    if rejected > 0 {
        std::process::exit(4);
    }
}

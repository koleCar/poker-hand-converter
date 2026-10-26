//! The flop library's files against a local HTTP server (R5.4): a chunk is
//! fetched once and kept, a manifest is fetched again when old and kept for
//! when the bucket is away, a missing file is not remembered, failures say
//! what they were, and paths outside the library are refused.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

/// One scripted answer: status and body.
type Answer = (u16, Vec<u8>);

/// A server answering each connection from the script, in order; records
/// each request line.
async fn server(script: Vec<Answer>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        for (status, body) in script {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                request.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n")
                    && text.contains("\r\n\r\n")
                {
                    log.lock().expect("log").push(text[..end].to_owned());
                    break;
                }
                if n == 0 {
                    break;
                }
            }
            let head = format!(
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let _ = socket.shutdown().await;
        }
    });
    (origin, seen)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rail-floplib-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

const CHUNK: &str = "nlhe-cash-6max-100bb/flop-m1/ffffr/2c3d4h.bin";
const MANIFEST: &str = "nlhe-cash-6max-100bb/flop-m1/manifest.json";

fn bytes(outcome: FileOutcome) -> (Vec<u8>, bool) {
    match outcome {
        FileOutcome::Bytes { bytes, cached } => (bytes, cached),
        other => panic!("expected bytes, got {other:?}"),
    }
}

#[test]
fn paths_are_the_librarys_only() {
    assert_eq!(check_path(CHUNK), Ok(FileKind::Chunk));
    assert_eq!(check_path(MANIFEST), Ok(FileKind::Manifest));
    for bad in [
        "",
        "manifest.json",
        "a/b/c/d/e.bin",
        "a/b/../x.bin",
        "a/../b/c.bin",
        "a/b/c/.bin",
        "a//c/d.bin",
        "/etc/passwd",
        "a/b/c/d.txt",
        "a/b/c d/e.bin",
        "a\\b/c/d.bin",
        "a/b/manifest.json/x",
    ] {
        assert!(check_path(bad).is_err(), "{bad:?} must be refused");
    }
}

#[test]
fn the_bucket_url_is_https_or_this_computer() {
    assert_eq!(
        bucket_url("https://abc.supabase.co/")
            .expect("url")
            .as_str(),
        "https://abc.supabase.co/storage/v1/object/public/flop-library/"
    );
    assert!(bucket_url("http://127.0.0.1:54321").is_ok());
    assert!(bucket_url("http://example.com").is_err());
    assert!(bucket_url("ftp://example.com").is_err());
}

#[tokio::test]
async fn a_chunk_is_fetched_once_and_kept() {
    let (origin, seen) = server(vec![(200, vec![1, 2, 3])]).await;
    let dir = temp_dir("chunk");
    let cache =
        FlopLibraryCache::new(&dir, Some(bucket_url(&origin).expect("url"))).expect("cache");
    assert_eq!(
        bytes(cache.file(CHUNK).await.expect("file")),
        (vec![1, 2, 3], false)
    );
    // The second ask is the disk's: the server has nothing more to say.
    assert_eq!(
        bytes(cache.file(CHUNK).await.expect("file")),
        (vec![1, 2, 3], true)
    );
    assert_eq!(
        seen.lock().expect("log").as_slice(),
        [format!("GET /{BUCKET_PATH}/{CHUNK} HTTP/1.1")]
    );
    assert_eq!(cache.disk_usage(), (3, 1));
    // Offline (no bucket at all), what is on disk still answers.
    let offline = FlopLibraryCache::new(&dir, None).expect("cache");
    assert_eq!(
        bytes(offline.file(CHUNK).await.expect("file")),
        (vec![1, 2, 3], true)
    );
    assert_eq!(
        offline
            .file("nlhe-cash-6max-100bb/flop-m1/ffffr/5c6d7h.bin")
            .await,
        Ok(FileOutcome::Offline)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn missing_files_and_failures_are_not_kept() {
    let (origin, _) = server(vec![
        (400, b"{}".to_vec()),
        (404, vec![]),
        (429, vec![]),
        (503, vec![]),
        (200, vec![9]),
    ])
    .await;
    let dir = temp_dir("failures");
    let cache =
        FlopLibraryCache::new(&dir, Some(bucket_url(&origin).expect("url"))).expect("cache");
    assert_eq!(cache.file(CHUNK).await, Ok(FileOutcome::Absent));
    assert_eq!(cache.file(CHUNK).await, Ok(FileOutcome::Absent));
    assert_eq!(cache.file(CHUNK).await, Ok(FileOutcome::Transient(429)));
    assert_eq!(cache.file(CHUNK).await, Ok(FileOutcome::Transient(503)));
    assert_eq!(
        bytes(cache.file(CHUNK).await.expect("file")),
        (vec![9], false)
    );
    // Nothing listens any more: offline.
    let gone = FlopLibraryCache::new(&dir, Some(bucket_url(&origin).expect("url"))).expect("cache");
    assert_eq!(
        gone.file("nlhe-cash-6max-100bb/flop-m1/ffffr/5c6d7h.bin")
            .await,
        Ok(FileOutcome::Offline)
    );
    assert!(!gone.reachable(MANIFEST).await);
    assert!(cache.file("../../etc/passwd").await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_manifest_is_fetched_again_when_old_and_kept_for_offline() {
    let (origin, seen) = server(vec![
        (200, b"[1]".to_vec()),
        (200, b"[2]".to_vec()),
        (503, vec![]),
    ])
    .await;
    let dir = temp_dir("manifest");
    let cache =
        FlopLibraryCache::new(&dir, Some(bucket_url(&origin).expect("url"))).expect("cache");
    assert_eq!(
        bytes(cache.file(MANIFEST).await.expect("file")),
        (b"[1]".to_vec(), false)
    );
    // Fresh: the disk answers.
    assert_eq!(
        bytes(cache.file(MANIFEST).await.expect("file")),
        (b"[1]".to_vec(), true)
    );
    // Old: fetched again.
    let local = cache.local(MANIFEST);
    let old = SystemTime::now() - MANIFEST_MAX_AGE - Duration::from_secs(60);
    std::fs::File::options()
        .write(true)
        .open(&local)
        .expect("open")
        .set_modified(old)
        .expect("age it");
    assert_eq!(
        bytes(cache.file(MANIFEST).await.expect("file")),
        (b"[2]".to_vec(), false)
    );
    // Old again and the bucket is failing: the copy on disk answers.
    std::fs::File::options()
        .write(true)
        .open(&local)
        .expect("open")
        .set_modified(old)
        .expect("age it");
    assert_eq!(
        bytes(cache.file(MANIFEST).await.expect("file")),
        (b"[2]".to_vec(), true)
    );
    assert_eq!(seen.lock().expect("log").len(), 3);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn reachable_keeps_the_manifest() {
    let (origin, _) = server(vec![(200, b"{}".to_vec())]).await;
    let dir = temp_dir("reachable");
    let cache =
        FlopLibraryCache::new(&dir, Some(bucket_url(&origin).expect("url"))).expect("cache");
    assert!(cache.reachable(MANIFEST).await);
    assert!(!cache.reachable(CHUNK).await, "only a manifest is a probe");
    assert_eq!(
        bytes(cache.file(MANIFEST).await.expect("file")),
        (b"{}".to_vec(), true)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

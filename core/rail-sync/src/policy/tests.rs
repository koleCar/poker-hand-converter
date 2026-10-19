//! The remote `sites.json` against a local HTTP server (R3.10): a stricter
//! copy applies and is cached, a looser one is ignored with a note, an
//! invalid one is refused whole, a failure keeps the last good copy, a
//! `304` keeps it current, and the cache brings it back after a restart.

use std::sync::Mutex;

use rail_config::Site;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

fn parsers() -> Vec<&'static str> {
    rail_core::parsers::REGISTRATION_ORDER.to_vec()
}

fn shipped() -> Config {
    rail_config::load_shipped(&parsers()).expect("the shipped sites.json")
}

/// The shipped file with `edit` applied, as the web would serve it.
fn remote_with(edit: impl Fn(&mut serde_json::Value)) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(rail_config::SHIPPED).expect("shipped json");
    edit(&mut value);
    value.to_string()
}

fn site_mut<'a>(value: &'a mut serde_json::Value, id: &str) -> &'a mut serde_json::Value {
    value["sites"]
        .as_array_mut()
        .expect("sites")
        .iter_mut()
        .find(|s| s["id"] == id)
        .expect("site")
}

fn permitted(policy: &Policy, id: &str) -> bool {
    policy.config.site(id).is_some_and(Site::hud_permitted)
}

/// One scripted answer: status, extra headers, body.
type Answer = (u16, Vec<(&'static str, String)>, String);

/// A one-connection-per-request server answering from a script; records
/// each request's head (lower-cased).
async fn server(script: Vec<Answer>) -> (Url, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = Url::parse(&format!(
        "http://{}/{REMOTE_PATH}",
        listener.local_addr().expect("addr")
    ))
    .expect("url");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        for (status, headers, body) in script {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = socket.read(&mut buffer).await.unwrap_or(0);
                request.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    log.lock()
                        .expect("log")
                        .push(text[..end].to_ascii_lowercase());
                    break;
                }
                if n == 0 {
                    break;
                }
            }
            let mut head = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n");
            for (name, value) in headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            let response = format!(
                "{head}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    (url, seen)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rail-policy-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn keeper(url: &Url, dir: &Path) -> PolicyKeeper {
    PolicyKeeper::open(
        shipped(),
        &parsers(),
        PolicyCache::new(dir),
        Some(PolicyFetcher::new(url.clone()).expect("fetcher")),
    )
}

fn outcome(keeper: &PolicyKeeper) -> Outcome {
    keeper.last_check().expect("a check").outcome
}

/// A remote copy that switches PokerStars off applies at once, is cached,
/// and is in force again after a restart - before any look at the web.
#[tokio::test]
async fn a_stricter_remote_applies_and_is_cached() {
    let off = remote_with(|v| site_mut(v, "pokerstars")["hud"]["allowed"] = false.into());
    let (url, _) = server(vec![(200, vec![("etag", "\"v1\"".into())], off.clone())]).await;
    let dir = temp_dir("stricter");
    let keeper = keeper(&url, &dir);
    assert!(permitted(&keeper.current(), "pokerstars"), "shipped first");
    assert!(keeper.current().remote.is_none());

    let changed = keeper.check().await.expect("a new policy");
    assert_eq!(outcome(&keeper), Outcome::Updated);
    assert!(!permitted(&changed, "pokerstars"));
    assert!(permitted(&changed, "winamax") && permitted(&changed, "acr"));
    assert_eq!(changed.remote.as_deref(), Some(off.as_str()));
    assert!(changed.fetched_at.is_some());
    assert_eq!(
        std::fs::read_to_string(keeper.cache_file()).expect("cached"),
        off
    );

    // A restart: the cached copy is in force before anything is fetched
    // (nothing is listening any more).
    let again = PolicyKeeper::open(shipped(), &parsers(), PolicyCache::new(&dir), None);
    assert!(!permitted(&again.current(), "pokerstars"));
    assert_eq!(again.current().fetched_at, changed.fetched_at);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A remote copy that would allow a room the shipped copy does not is
/// taken for everything else, but that room stays unknown - with a note.
#[tokio::test]
async fn a_looser_remote_is_ignored_with_a_note() {
    let looser = remote_with(|v| {
        let hud = &mut site_mut(v, "888poker")["hud"];
        hud["allowed"] = true.into();
        hud["source"] = "https://example.invalid/888-policy".into();
        hud["checkedAt"] = "2026-10-19".into();
        hud["restrictions"] =
            serde_json::to_value(rail_config::model::HudRestrictions::NONE).expect("json");
        site_mut(v, "ggpoker")["hud"]["allowed"] = true.into();
        site_mut(v, "ggpoker")["hud"]["source"] = "https://example.invalid/gg".into();
        site_mut(v, "ggpoker")["hud"]["checkedAt"] = "2026-10-19".into();
        site_mut(v, "ggpoker")["hud"]["restrictions"] =
            serde_json::to_value(rail_config::model::HudRestrictions::NONE).expect("json");
    });
    let (url, _) = server(vec![(200, vec![], looser)]).await;
    let dir = temp_dir("looser");
    let keeper = keeper(&url, &dir);
    let policy = keeper.check().await.expect("taken (for the rest)");
    assert!(!permitted(&policy, "888poker"), "unknown stays unknown");
    assert!(
        !permitted(&policy, "ggpoker"),
        "prohibited stays prohibited"
    );
    assert_eq!(
        policy.config.site("888poker").map(|s| s.hud.allowed),
        Some(None)
    );
    for id in ["888poker", "ggpoker"] {
        assert!(
            policy
                .notes
                .iter()
                .any(|n| matches!(n, MergeNote::LooserHudIgnored { id: noted, .. } if noted == id)),
            "{id}: {:?}",
            policy.notes
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A file that does not pass is refused whole: not JSON, an unknown field
/// (the schema is strict), another version, a validator rule broken (an
/// allowed room without a source). The copy in force stays, and so does the
/// cache.
#[tokio::test]
async fn an_invalid_file_is_refused_whole() {
    let off = remote_with(|v| site_mut(v, "acr")["hud"]["allowed"] = false.into());
    let unknown_field = remote_with(|v| {
        site_mut(v, "acr")["hud"]["allowed"] = false.into();
        site_mut(v, "pokerstars")["hud"]["override"] = true.into();
    });
    let version = remote_with(|v| v["version"] = 2.into());
    let no_source = remote_with(|v| {
        site_mut(v, "pokerstars")["hud"]["source"] = serde_json::Value::Null;
        site_mut(v, "acr")["hud"]["allowed"] = false.into();
    });
    let (url, _) = server(vec![
        (200, vec![], off.clone()),
        (200, vec![], "{ not json".into()),
        (200, vec![], unknown_field),
        (200, vec![], version),
        (200, vec![], no_source),
    ])
    .await;
    let dir = temp_dir("invalid");
    let keeper = keeper(&url, &dir);
    keeper.check().await.expect("the stricter copy");
    assert!(!permitted(&keeper.current(), "acr"));
    for what in ["not json", "unknown field", "version", "validator"] {
        assert!(keeper.check().await.is_none(), "{what}: nothing changes");
        assert!(
            matches!(outcome(&keeper), Outcome::Refused { .. }),
            "{what}: {:?}",
            outcome(&keeper)
        );
        let current = keeper.current();
        assert!(!permitted(&current, "acr"), "{what}: the last good copy");
        assert!(permitted(&current, "pokerstars"), "{what}");
        assert_eq!(current.remote.as_deref(), Some(off.as_str()), "{what}");
        assert_eq!(
            std::fs::read_to_string(keeper.cache_file()).expect("cached"),
            off,
            "{what}: the cache keeps the good copy"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Offline, a server error, a body too large: the last good copy stays.
#[tokio::test]
async fn a_failure_keeps_the_last_good_copy() {
    let off = remote_with(|v| site_mut(v, "winamax")["hud"]["allowed"] = false.into());
    let huge = " ".repeat(MAX_BYTES + 1);
    let (url, _) = server(vec![
        (200, vec![], off.clone()),
        (503, vec![], "{}".into()),
        (200, vec![], huge),
        (
            301,
            vec![("location", "https://example.invalid/".into())],
            String::new(),
        ),
    ])
    .await;
    let dir = temp_dir("failure");
    let keeper = keeper(&url, &dir);
    keeper.check().await.expect("the stricter copy");
    for what in ["503", "too large", "a redirect"] {
        assert!(keeper.check().await.is_none(), "{what}");
        assert!(
            matches!(outcome(&keeper), Outcome::Failed { .. }),
            "{what}: {:?}",
            outcome(&keeper)
        );
        assert!(!permitted(&keeper.current(), "winamax"), "{what}");
    }
    // Nothing listening at all (the script is over: the server is gone).
    assert!(keeper.check().await.is_none());
    assert!(matches!(outcome(&keeper), Outcome::Failed { .. }));
    assert!(!permitted(&keeper.current(), "winamax"));
    assert_eq!(keeper.current().remote.as_deref(), Some(off.as_str()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// With no copy yet, a failure is the shipped policy.
#[tokio::test]
async fn a_failure_before_any_copy_is_the_shipped_policy() {
    let (url, _) = server(vec![(500, vec![], String::new())]).await;
    let dir = temp_dir("first-failure");
    let keeper = keeper(&url, &dir);
    assert!(keeper.check().await.is_none());
    let current = keeper.current();
    assert!(current.remote.is_none());
    assert_eq!(*current.config, shipped());
    assert!(!keeper.cache_file().exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The validators of the cached copy go with the next look; a `304` keeps
/// it current. Validators that do not belong to the cached text (a damaged
/// record) are not sent.
#[tokio::test]
async fn validators_make_the_next_look_conditional() {
    let off = remote_with(|v| site_mut(v, "acr")["hud"]["allowed"] = false.into());
    let date = "Mon, 19 Oct 2026 08:00:00 GMT".to_owned();
    let (url, seen) = server(vec![
        (
            200,
            vec![("etag", "\"abc\"".into()), ("last-modified", date.clone())],
            off.clone(),
        ),
        (304, vec![], String::new()),
        (304, vec![], String::new()),
    ])
    .await;
    let dir = temp_dir("validators");
    let keeper = keeper(&url, &dir);
    keeper.check().await.expect("first copy");
    assert!(keeper.check().await.is_none());
    assert_eq!(outcome(&keeper), Outcome::Current);
    {
        let seen = seen.lock().expect("seen");
        assert!(!seen[0].contains("if-none-match"), "{}", seen[0]);
        assert!(seen[1].contains("if-none-match: \"abc\""), "{}", seen[1]);
        assert!(
            seen[1].contains(&format!("if-modified-since: {}", date.to_ascii_lowercase())),
            "{}",
            seen[1]
        );
        assert!(seen[1].contains("accept: application/json"));
    }
    assert!(!permitted(&keeper.current(), "acr"));

    // The record no longer matches the text: the next start sends nothing
    // conditional (and still uses the text, which passes on its own).
    std::fs::write(
        keeper.cache_file(),
        remote_with(|v| site_mut(v, "acr")["hud"]["allowed"] = false.into()) + " ",
    )
    .expect("touch");
    let restarted = self::keeper(&url, &dir);
    assert!(!permitted(&restarted.current(), "acr"));
    assert!(restarted.check().await.is_none());
    let seen = seen.lock().expect("seen");
    assert!(!seen[2].contains("if-none-match"), "{}", seen[2]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A cached file that does not pass (damaged, or a newer build's) is not
/// used: the shipped policy.
#[test]
fn a_damaged_cache_is_not_used() {
    let dir = temp_dir("damaged");
    std::fs::create_dir_all(&dir).expect("dir");
    let cache = PolicyCache::new(&dir);
    std::fs::write(cache.file(), "{\"version\": 1, \"sites\": [").expect("write");
    let keeper = PolicyKeeper::open(shipped(), &parsers(), cache, None);
    assert!(keeper.current().remote.is_none());
    assert_eq!(*keeper.current().config, shipped());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Only HTTPS, or HTTP to this computer.
#[test]
fn only_https_or_loopback() {
    let ok = |url: &str| PolicyFetcher::new(Url::parse(url).expect("url")).is_ok();
    assert!(ok("https://poker-hand-converter.vercel.app/sites.json"));
    assert!(ok("http://127.0.0.1:3000/sites.json"));
    assert!(ok("http://localhost:3000/sites.json"));
    assert!(ok("http://[::1]:3000/sites.json"));
    assert!(!ok("http://poker-hand-converter.vercel.app/sites.json"));
    assert!(!ok("http://10.0.0.1/sites.json"));
    assert!(!ok("ftp://example.invalid/sites.json"));
    assert!(!ok("file:///etc/sites.json"));
    let web = Url::parse("https://poker-hand-converter.vercel.app").expect("url");
    assert_eq!(
        remote_url(&web).expect("url").as_str(),
        "https://poker-hand-converter.vercel.app/sites.json"
    );
    let web = Url::parse("https://example.invalid/app/").expect("url");
    assert_eq!(
        remote_url(&web).expect("url").as_str(),
        "https://example.invalid/sites.json"
    );
    assert!(remote_url(&Url::parse("http://example.invalid").expect("url")).is_err());
}

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

fn phf(id: &str, raw: &str) -> String {
    serde_json::json!({
        "schema": "phf/1",
        "meta": { "siteId": "weplay", "handId": id, "handKey": id, "rawText": raw },
        "game": { "smallBlind": 50, "bigBlind": 100 },
    })
    .to_string()
}

fn row(id: &str) -> IngestRow {
    IngestRow::new(&format!("weplay:{id}"), &phf(id, "Weplay Hand #1\nlines")).unwrap()
}

#[test]
fn a_row_carries_the_phf_without_its_raw_text() {
    let row = row("7");
    assert_eq!(row.hand_key(), "weplay:7");
    let value: Value = serde_json::from_str(&row.json).unwrap();
    assert_eq!(value["hand_key"], "weplay:7");
    assert_eq!(value["phf"]["meta"]["rawText"], "");
    assert_eq!(value["phf"]["game"]["bigBlind"], 100);
    assert!(!row.json.contains('\n'), "compact JSON");
    // The canonical store layout (pretty, sorted) is accepted as it is.
    let pretty =
        serde_json::to_string_pretty(&serde_json::from_str::<Value>(&phf("8", "x")).unwrap())
            .unwrap();
    assert!(IngestRow::new("weplay:8", &pretty).is_ok());
}

#[test]
fn unreadable_and_oversized_rows_are_refused() {
    assert_eq!(IngestRow::new("k", "not json"), Err(RowError::Unreadable));
    assert_eq!(IngestRow::new("k", "[]"), Err(RowError::Unreadable));
    assert_eq!(
        IngestRow::new("k", r#"{"meta":"x"}"#),
        Err(RowError::Unreadable)
    );
    let big = serde_json::json!({ "meta": {}, "pad": "x".repeat(MAX_PHF_BYTES) }).to_string();
    assert!(matches!(
        IngestRow::new("k", &big),
        Err(RowError::TooLarge(_))
    ));
    // The raw text does not count: it is not sent.
    let raw = serde_json::json!({ "meta": { "rawText": "x".repeat(MAX_PHF_BYTES) } }).to_string();
    assert!(IngestRow::new("k", &raw).is_ok());
}

#[test]
fn batches_stop_at_500_hands() {
    let batches = Batch::split((0..1201).map(|i| row(&i.to_string())));
    assert_eq!(
        batches.iter().map(Batch::len).collect::<Vec<_>>(),
        [500, 500, 201]
    );
    let keys: Vec<String> = batches
        .iter()
        .flat_map(|b| b.hand_keys().map(str::to_owned))
        .collect();
    assert_eq!(keys.len(), 1201);
    assert_eq!(keys[0], "weplay:0");
    assert_eq!(keys[1200], "weplay:1200");
}

#[test]
fn batches_stop_at_the_byte_limit() {
    let pad = "x".repeat(200 * 1024);
    let rows: Vec<IngestRow> = (0..50)
        .map(|i| {
            let text = serde_json::json!({ "meta": {}, "pad": pad, "n": i }).to_string();
            IngestRow::new(&format!("weplay:{i}"), &text).unwrap()
        })
        .collect();
    let batches = Batch::split(rows);
    assert!(batches.len() > 1);
    for batch in &batches {
        assert!(
            batch.bytes() + ENVELOPE_BYTES <= MAX_BATCH_BYTES,
            "{}",
            batch.bytes()
        );
        let source = SourceId::parse("84df2fe5-9a45-4a04-9ad2-33dfdb43d07e").unwrap();
        assert!(batch.body(&source).len() <= MAX_BATCH_BYTES);
    }
    assert_eq!(batches.iter().map(Batch::len).sum::<usize>(), 50);
}

#[test]
fn the_body_is_the_rpc_arguments() {
    let mut batch = Batch::new();
    batch.push(row("1")).unwrap();
    batch.push(row("2")).unwrap();
    let source = SourceId::parse("84DF2FE5-9a45-4a04-9ad2-33dfdb43d07e").unwrap();
    let body: Value = serde_json::from_str(&batch.body(&source)).unwrap();
    assert_eq!(body["p_source"], "84df2fe5-9a45-4a04-9ad2-33dfdb43d07e");
    assert_eq!(body["p_rows"].as_array().unwrap().len(), 2);
    assert_eq!(body["p_rows"][1]["hand_key"], "weplay:2");
    assert!(SourceId::parse("not-a-uuid").is_none());
    assert!(SourceId::parse("84df2fe5x9a45-4a04-9ad2-33dfdb43d07e").is_none());
}

fn two_rows() -> Batch {
    Batch::split([row("1"), row("2")]).remove(0)
}

#[test]
fn a_report_is_read_row_by_row() {
    let body = br#"{"received":2,"inserted":1,"duplicates":0,"rejected":1,"rows":[
        {"handKey":"weplay:1","status":"inserted"},
        {"handKey":"weplay:2","status":"rejected","reason":"invalid","field":"hero_cards"}]}"#;
    let report = report_of(body, &two_rows()).unwrap();
    assert_eq!(report.stored_keys().collect::<Vec<_>>(), ["weplay:1"]);
    assert_eq!(
        report.rejections().next().unwrap().status,
        RowStatus::Rejected {
            reason: RejectReason::Invalid,
            field: Some("hero_cards".into())
        }
    );
    let shape = br#"{"received":2,"inserted":0,"duplicates":1,"rejected":1,"rows":[
        {"status":"rejected","reason":"brand-new"},{"handKey":"weplay:2","status":"duplicate"}]}"#;
    let report = report_of(shape, &two_rows()).unwrap();
    assert_eq!(report.rows[0].hand_key, "weplay:1");
    assert_eq!(
        report.rows[0].status,
        RowStatus::Rejected {
            reason: RejectReason::Other("brand-new".into()),
            field: None
        }
    );
    assert!(report.rows[1].status.is_stored());
}

#[test]
fn a_report_that_does_not_match_the_batch_is_unreadable() {
    for body in [
        &br#"{"received":1,"inserted":1,"duplicates":0,"rejected":0,"rows":[{"handKey":"weplay:1","status":"inserted"}]}"#[..],
        br#"{"received":2,"inserted":2,"duplicates":0,"rejected":0,"rows":[
            {"handKey":"weplay:2","status":"inserted"},{"handKey":"weplay:1","status":"inserted"}]}"#,
        br#"{"received":2,"inserted":2,"duplicates":0,"rejected":0,"rows":[
            {"handKey":"weplay:1","status":"inserted"},{"handKey":"weplay:2","status":"maybe"}]}"#,
        b"<html>",
    ] {
        assert!(matches!(report_of(body, &two_rows()), Err(IngestError::Transient(_))));
    }
}

#[test]
fn errors_map_to_what_the_worker_does_next() {
    let body =
        |code: &str| format!(r#"{{"code":"{code}","message":"m","details":null,"hint":null}}"#);
    assert_eq!(
        error_of(401, body("PGRST301").as_bytes()),
        IngestError::Unauthorized
    );
    assert_eq!(
        error_of(401, body("42501").as_bytes()),
        IngestError::Unauthorized
    );
    assert_eq!(
        error_of(500, body("53400").as_bytes()),
        IngestError::RateLimited {
            window: RateWindow::Unknown
        }
    );
    let limited = |bucket: &str| {
        format!(
            r#"{{"code":"53400","message":"Write rate limit exceeded for bucket \"{bucket}:00000000-0000-0000-0000-000000000001\" (150000 per 00:10:00). Try again later."}}"#
        )
    };
    assert_eq!(
        error_of(500, limited("desktop_ingest").as_bytes()),
        IngestError::RateLimited {
            window: RateWindow::Minutes
        }
    );
    assert_eq!(
        error_of(500, limited("desktop_ingest_day").as_bytes()),
        IngestError::RateLimited {
            window: RateWindow::Day
        }
    );
    assert_eq!(
        error_of(500, limited("hand_source").as_bytes()),
        IngestError::RateLimited {
            window: RateWindow::Minutes
        }
    );
    assert_eq!(
        error_of(409, body("23503").as_bytes()),
        IngestError::UnknownSource
    );
    assert_eq!(
        error_of(400, body("22023").as_bytes()),
        IngestError::Refused {
            status: 400,
            code: "22023".into()
        }
    );
    assert_eq!(
        error_of(400, b"nonsense"),
        IngestError::Refused {
            status: 400,
            code: "unknown".into()
        }
    );
    // (R6.4) R6.2's refusal: PT402 / HTTP 402, the feature from the hint.
    let plan = |hint: &str| {
        format!(
            r#"{{"code":"PT402","message":"This is a Pro feature.","details":null,"hint":{hint}}}"#
        )
    };
    assert_eq!(
        error_of(402, plan(r#""desktop_sync""#).as_bytes()),
        IngestError::PlanRequired {
            feature: "desktop_sync".into()
        }
    );
    assert_eq!(
        error_of(400, plan(r#""hand_cap""#).as_bytes()),
        IngestError::PlanRequired {
            feature: "hand_cap".into()
        }
    );
    assert_eq!(
        error_of(402, plan("null").as_bytes()),
        IngestError::PlanRequired {
            feature: "unknown".into()
        }
    );
    assert_eq!(
        error_of(402, plan(r#""<script>""#).as_bytes()),
        IngestError::PlanRequired {
            feature: "unknown".into()
        },
        "only a plain feature name is kept"
    );
    assert_eq!(
        error_of(402, b""),
        IngestError::PlanRequired {
            feature: "unknown".into()
        }
    );
    assert!(matches!(error_of(503, b""), IngestError::Transient(_)));
    assert!(matches!(error_of(429, b""), IngestError::Transient(_)));
    assert!(matches!(
        error_of(500, body("XX000").as_bytes()),
        IngestError::Transient(_)
    ));
}

// ------------------------------------------------- the token, end to end --

/// An account stand-in: hands out `token-N`, counts refreshes.
struct FakeAccount {
    token: Mutex<Option<String>>,
    refreshes: AtomicUsize,
    refresh_result: Result<(), ApiError>,
}

impl FakeAccount {
    fn new(token: Option<&str>, refresh_result: Result<(), ApiError>) -> Self {
        Self {
            token: Mutex::new(token.map(str::to_owned)),
            refreshes: AtomicUsize::new(0),
            refresh_result,
        }
    }
}

impl TokenSource for FakeAccount {
    async fn access_token(&self) -> Option<Secret> {
        self.token.lock().unwrap().clone().map(Secret::new)
    }

    async fn refresh(&self) -> Result<(), ApiError> {
        let n = self.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
        if self.refresh_result.is_ok() {
            *self.token.lock().unwrap() = Some(format!("token-{}", n + 1));
        }
        self.refresh_result.clone()
    }
}

/// A one-connection-per-request HTTP server answering from a script;
/// records each request's bearer token and path.
async fn server(script: Vec<(u16, String)>) -> (Url, Arc<Mutex<Vec<(String, String)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for (status, body) in script {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let n = socket.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        let path = text.split_whitespace().nth(1).unwrap_or("").to_owned();
                        let token = text[..end]
                            .lines()
                            .find_map(|l| l.strip_prefix("authorization: Bearer "))
                            .unwrap_or("")
                            .to_owned();
                        log.lock().unwrap().push((path, token));
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (url, seen)
}

fn client(url: &Url) -> IngestClient {
    let config = AuthConfig::new(url.as_str(), "anon-key", "http://localhost:3000").unwrap();
    IngestClient::new(&config).unwrap()
}

const OK_REPORT: &str = r#"{"received":2,"inserted":2,"duplicates":0,"rejected":0,"rows":[
    {"handKey":"weplay:1","status":"inserted"},{"handKey":"weplay:2","status":"inserted"}]}"#;
const UNAUTHORIZED: &str = r#"{"code":"PGRST301","message":"JWT expired"}"#;

fn source() -> SourceId {
    SourceId::parse("84df2fe5-9a45-4a04-9ad2-33dfdb43d07e").unwrap()
}

#[tokio::test]
async fn a_401_refreshes_once_and_retries_with_the_new_token() {
    let (url, seen) = server(vec![(401, UNAUTHORIZED.into()), (200, OK_REPORT.into())]).await;
    let account = FakeAccount::new(Some("token-1"), Ok(()));
    let report = client(&url)
        .ingest_as(&account, &source(), &two_rows())
        .await
        .unwrap();
    assert_eq!(report.inserted, 2);
    assert_eq!(account.refreshes.load(Ordering::SeqCst), 1);
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        [
            ("/rest/v1/rpc/ingest_hands".to_owned(), "token-1".to_owned()),
            ("/rest/v1/rpc/ingest_hands".to_owned(), "token-2".to_owned())
        ]
    );
}

#[tokio::test]
async fn a_second_401_is_unauthorized() {
    let (url, _) = server(vec![(401, UNAUTHORIZED.into()), (401, UNAUTHORIZED.into())]).await;
    let account = FakeAccount::new(Some("token-1"), Ok(()));
    let result = client(&url)
        .ingest_as(&account, &source(), &two_rows())
        .await;
    assert_eq!(result, Err(IngestError::Unauthorized));
    assert_eq!(account.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_refused_refresh_is_signed_out() {
    let (url, seen) = server(vec![(401, UNAUTHORIZED.into())]).await;
    let account = FakeAccount::new(
        Some("token-1"),
        Err(ApiError::Rejected {
            status: 400,
            code: "refresh_token_not_found".into(),
        }),
    );
    let result = client(&url)
        .ingest_as(&account, &source(), &two_rows())
        .await;
    assert_eq!(result, Err(IngestError::SignedOut));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn no_token_sends_nothing() {
    let (url, seen) = server(vec![]).await;
    let account = FakeAccount::new(None, Ok(()));
    let result = client(&url)
        .ingest_as(&account, &source(), &two_rows())
        .await;
    assert_eq!(result, Err(IngestError::SignedOut));
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rate_limits_and_unknown_sources_are_not_retried() {
    let (url, seen) = server(vec![
        (
            500,
            r#"{"code":"53400","message":"Write rate limit exceeded"}"#.into(),
        ),
        (409, r#"{"code":"23503","message":"No hand source"}"#.into()),
    ])
    .await;
    let account = FakeAccount::new(Some("token-1"), Ok(()));
    let ingest = client(&url);
    assert_eq!(
        ingest.ingest_as(&account, &source(), &two_rows()).await,
        Err(IngestError::RateLimited {
            window: RateWindow::Unknown
        })
    );
    assert_eq!(
        ingest.ingest_as(&account, &source(), &two_rows()).await,
        Err(IngestError::UnknownSource)
    );
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(account.refreshes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn registering_returns_the_source_id() {
    let (url, seen) = server(vec![(
        200,
        r#""84DF2FE5-9a45-4a04-9ad2-33dfdb43d07e""#.into(),
    )])
    .await;
    let account = FakeAccount::new(Some("token-1"), Ok(()));
    let id = client(&url)
        .register_source_as(
            &account,
            &SourceRegistration {
                device_id: "00000000-0000-0000-0000-00000000aaaa".into(),
                local_id: "3".into(),
                device_name: Some("Laptop".into()),
                label: Some("WePlay - hands".into()),
                site: Some("weplay".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(id, source());
    assert_eq!(
        seen.lock().unwrap()[0].0,
        "/rest/v1/rpc/register_hand_source"
    );
}

// ------------------------------------------------------ the plan (R6.4) --

#[tokio::test]
async fn the_accounts_entitlements_are_read_with_its_token() {
    let answer = r#"{"plan":"pro","reason":"subscription","enforced":true,
        "features":{"library_unlimited":true,"hand_cap":null,"desktop_sync":true,"hud":true,
                    "reports_full":true,"analysis":true,"learn":true},
        "usage":{"handsStored":12},"limits":{"freeHandCap":10000},
        "validUntil":"2027-01-01T00:00:00+00:00","graceUntil":null,"offlineGraceDays":14,
        "checkedAt":"2026-10-26T10:00:00+00:00"}"#;
    let (url, seen) = server(vec![(401, UNAUTHORIZED.into()), (200, answer.into())]).await;
    let account = FakeAccount::new(Some("token-1"), Ok(()));
    let got = client(&url).my_entitlements_as(&account).await.unwrap();
    assert_eq!(got.plan, crate::entitlements::Plan::Pro);
    assert!(got.enforced && got.features.hud);
    assert_eq!(got.offline_grace_days, 14);
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen[0],
        ("/rest/v1/rpc/my_entitlements".into(), "token-1".into())
    );
    assert_eq!(seen[1].1, "token-2", "refreshed once after the 401");
}

#[tokio::test]
async fn the_public_flag_is_read_with_the_anon_key_only() {
    let (url, seen) = server(vec![
        (200, "true".into()),
        (200, "false".into()),
        (404, r#"{"code":"PGRST202"}"#.into()),
    ])
    .await;
    let ingest = client(&url);
    assert_eq!(ingest.billing_enforced().await, Ok(true));
    assert_eq!(ingest.billing_enforced().await, Ok(false));
    // A server without the function (production before R6.4): not an
    // answer - the app keeps "unknown".
    assert!(matches!(
        ingest.billing_enforced().await,
        Err(IngestError::Refused { status: 404, .. })
    ));
    let seen = seen.lock().unwrap().clone();
    assert!(
        seen.iter()
            .all(|(path, token)| path == "/rest/v1/rpc/billing_enforced" && token == "anon-key")
    );
}

#[tokio::test]
async fn an_unreadable_answer_is_not_an_answer() {
    let (url, _) = server(vec![(200, "[]".into()), (200, r#""yes""#.into())]).await;
    let account = FakeAccount::new(Some("token-1"), Ok(()));
    let ingest = client(&url);
    assert!(matches!(
        ingest.my_entitlements_as(&account).await,
        Err(IngestError::Transient(_))
    ));
    assert!(matches!(
        ingest.billing_enforced().await,
        Err(IngestError::Transient(_))
    ));
}

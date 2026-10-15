//! The app's side of the HUD process (docs/RAIL-PLAN.md R3.2), with the real
//! `rail-hud` binary: started, authenticated, health-checked, restarted
//! with a backoff when it dies, shut down; strangers refused.

use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use rail_hud_ipc::auth::Token;
use rail_hud_ipc::client::connect_authenticated;
use rail_hud_ipc::protocol::HudMessage;
use rail_hud_ipc::supervisor::{Event, Phase, Supervisor, SupervisorConfig};

fn config() -> SupervisorConfig {
    let mut config = SupervisorConfig::new(env!("CARGO_BIN_EXE_rail-hud"));
    config.args = vec![
        "--store".into(),
        "/nonexistent/rail-hud-test/rail.db".into(),
    ];
    config.health_interval = Duration::from_millis(100);
    config.health_timeout = Duration::from_secs(5);
    config.backoff_min = Duration::from_millis(100);
    config.backoff_max = Duration::from_millis(400);
    config
}

fn start(config: SupervisorConfig) -> (Supervisor, Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let supervisor = Supervisor::start(config, move |event| {
        let _ = tx.send(event);
    })
    .expect("supervisor");
    (supervisor, rx)
}

/// The next event `pick` accepts, within 20 s.
fn wait_for<T>(rx: &Receiver<Event>, mut pick: impl FnMut(&Event) -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let event = rx.recv_timeout(left).expect("an event in time");
        if let Some(value) = pick(&event) {
            return value;
        }
    }
}

fn kill(pid: u32) {
    let status = if cfg!(windows) {
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .map(|o| o.status)
    } else {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
    };
    assert!(status.expect("kill runs").success(), "killed {pid}");
}

fn alive(pid: u32) -> bool {
    if cfg!(windows) {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

#[test]
fn started_checked_restarted_and_stopped() {
    let (supervisor, rx) = start(config());
    let first = wait_for(&rx, |e| match e {
        Event::Connected { pid } => Some(*pid),
        _ => None,
    });
    // Health answers come back with the HUD's state.
    let report = wait_for(&rx, |e| match e {
        Event::Message(HudMessage::Health { report, .. }, _) => Some(report.clone()),
        _ => None,
    });
    assert!(!report.store_open, "no store at that path");
    assert_eq!(report.attached, 0);
    let status = supervisor.status();
    assert_eq!(status.phase, Phase::Running);
    assert_eq!((status.pid, status.starts), (Some(first), 1));
    assert!(supervisor.is_connected());

    // It dies: the supervisor notices and starts another, with a new token.
    kill(first);
    let reason = wait_for(&rx, |e| match e {
        Event::Disconnected { reason } => Some(reason.clone()),
        _ => None,
    });
    assert!(!reason.is_empty());
    let second = wait_for(&rx, |e| match e {
        Event::Connected { pid } => Some(*pid),
        _ => None,
    });
    assert_ne!(first, second);
    assert_eq!(supervisor.status().starts, 2);
    assert!(supervisor.status().last_exit.is_some());

    // Shut down on exit: it is gone, and so is the endpoint.
    let endpoint = supervisor.endpoint().to_owned();
    let started = Instant::now();
    supervisor.stop();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(supervisor.status().phase, Phase::Stopped);
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(second) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(second), "the HUD exited");
    assert!(!supervisor.send(rail_hud_ipc::AppMessage::Resync));
    if cfg!(unix) {
        assert!(!std::path::Path::new(&endpoint).exists(), "socket removed");
    }
}

/// A HUD that exits before connecting is started again, the waits growing.
#[test]
fn a_failing_hud_is_retried_with_a_backoff() {
    let mut config = config();
    config.args = vec!["--frobnicate".into()];
    let (supervisor, _rx) = start(config);
    let deadline = Instant::now() + Duration::from_secs(20);
    while supervisor.status().starts < 4 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let status = supervisor.status();
    assert!(status.starts >= 4, "{status:?}");
    assert!(
        status
            .last_exit
            .as_deref()
            .is_some_and(|e| e.contains("before connecting")),
        "{status:?}"
    );
    assert!(!supervisor.is_connected());
    supervisor.stop();
}

/// No binary (a development build that did not build the HUD): said so.
#[test]
fn a_missing_hud_is_reported() {
    let (supervisor, _rx) = start(SupervisorConfig::new(
        std::env::temp_dir().join("no-such-rail-hud-binary"),
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while supervisor.status().phase != Phase::NotInstalled && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(supervisor.status().phase, Phase::NotInstalled);
    let started = Instant::now();
    supervisor.stop();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "stop does not wait 30 s"
    );
}

/// Another process of the same user that finds the endpoint cannot talk:
/// it has no token.
#[test]
fn a_stranger_is_refused() {
    let (supervisor, rx) = start(config());
    wait_for(&rx, |e| matches!(e, Event::Connected { .. }).then_some(()));
    let stranger = connect_authenticated(supervisor.endpoint(), &Token::generate().expect("token"));
    assert!(stranger.is_err(), "a stranger was let in");
    // The HUD that was started is still the one connected.
    assert!(supervisor.is_connected());
    assert_eq!(supervisor.status().starts, 1);
    supervisor.stop();
}

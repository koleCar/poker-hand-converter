//! The app's side: start the HUD process, keep it alive, talk to it
//! (docs/RAIL-PLAN.md §3.2, R3.2).
//!
//! - **Start.** The HUD is the binary the app bundles as a Tauri sidecar
//!   (`bundle.externalBin`): next to the app's own executable. It is started
//!   with [`crate::ENDPOINT_ARG`] and the endpoint, standard input a pipe
//!   whose first line is a fresh [`Token`] for this process only (a
//!   restarted HUD gets a new one; an old process's token is worthless),
//!   standard output discarded and standard error forwarded line by line to
//!   the app's log (target `rail_hud`). On Windows without a console window.
//! - **Connect.** One listener for the app's life ([`Listener`]); an
//!   acceptor thread runs the handshake on every connection (5 s to finish
//!   on Unix) against the current token, and only the process that was
//!   just started is taken (the pid it proved with the token).
//! - **Health.** Every `health_interval` the app sends `health {seq}`; no
//!   answer for `health_timeout` (a hung HUD), the process exiting, or the
//!   connection closing - and the HUD is stopped and started again.
//! - **Backoff.** Restarts wait `backoff_min`, doubling up to
//!   `backoff_max`; a run that lasted `stable_after` starts the backoff
//!   over. It never gives up: the HUD is how the user sees their tables.
//! - **Never blocking the app.** [`Supervisor::send`] queues (see
//!   [`crate::link`]); every wait is on the supervisor's own threads.
//! - **Shutdown.** [`Supervisor::stop`] sends `shutdown`, closes the HUD's
//!   standard input (the HUD also exits on that alone - which is what
//!   happens when the app crashes), waits `shutdown_grace`, then kills it.
//! - **Missing binary.** A development build run before `cargo build -p
//!   rail-hud`: the status says so and the binary is looked for again every
//!   30 s.

use std::ffi::OsString;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::auth::{Peer, Token, server_handshake};
use crate::link::{Incoming, Link, Sent};
use crate::protocol::{AppMessage, HealthReport, HudMessage};
use crate::transport::{Connection, Endpoint, Listener, connect};

/// How the HUD is run and watched.
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// The HUD binary.
    pub program: PathBuf,
    /// Arguments before [`crate::ENDPOINT_ARG`] (the store path, ...).
    pub args: Vec<OsString>,
    pub health_interval: Duration,
    /// No health answer for this long: restart.
    pub health_timeout: Duration,
    /// From start to an authenticated connection.
    pub connect_timeout: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// A run at least this long resets the backoff.
    pub stable_after: Duration,
    /// After `shutdown`, how long the HUD may take to exit before it is
    /// killed.
    pub shutdown_grace: Duration,
    /// Messages that may wait for the HUD.
    pub queue: usize,
}

impl SupervisorConfig {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            health_interval: Duration::from_secs(2),
            health_timeout: Duration::from_secs(10),
            connect_timeout: Duration::from_secs(15),
            backoff_min: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            stable_after: Duration::from_secs(60),
            shutdown_grace: Duration::from_millis(1500),
            queue: 1024,
        }
    }
}

/// What the app hears, on the supervisor's threads.
#[derive(Debug, Clone)]
pub enum Event {
    /// A HUD process connected and authenticated.
    Connected { pid: u32 },
    /// A message from it, with the moment it was read.
    Message(HudMessage, Instant),
    /// It is gone (exited, hung, disconnected); a restart follows unless
    /// the supervisor is stopping. Whatever it said about open tables no
    /// longer holds.
    Disconnected { reason: String },
}

/// Where the supervisor is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// The binary is not next to the app (a development build).
    NotInstalled,
    /// Started, waiting for its connection.
    Starting,
    /// Connected and answering.
    Running,
    /// Waiting before the next start.
    Backoff,
    Stopped,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotInstalled => "not-installed",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Backoff => "backoff",
            Self::Stopped => "stopped",
        }
    }
}

/// The supervisor's state for the app's status line.
#[derive(Debug, Clone)]
pub struct Status {
    pub phase: Phase,
    pub pid: Option<u32>,
    /// Processes started so far.
    pub starts: u32,
    /// Why the last one ended.
    pub last_exit: Option<String>,
    /// Its last health answer and how long ago it came.
    pub health: Option<HealthReport>,
    pub health_age: Option<Duration>,
    /// Messages dropped because the HUD did not keep up.
    pub dropped: u64,
}

type OnEvent = Arc<dyn Fn(Event) + Send + Sync>;

struct State {
    stopping: bool,
    phase: Phase,
    pid: Option<u32>,
    starts: u32,
    last_exit: Option<String>,
    health: Option<(Instant, HealthReport)>,
    dropped: u64,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    link: Mutex<Option<Link<AppMessage>>>,
    /// The token of the process being started; `None` once it connected.
    token: Mutex<Option<Token>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    fn stopping(&self) -> bool {
        lock(&self.state).stopping
    }

    /// Sleep up to `timeout`, or less when [`Supervisor::stop`] is called.
    /// Returns whether the supervisor is stopping.
    fn wait(&self, timeout: Duration) -> bool {
        let state = lock(&self.state);
        if state.stopping {
            return true;
        }
        let (state, _) = self
            .wake
            .wait_timeout(state, timeout)
            .unwrap_or_else(PoisonError::into_inner);
        state.stopping
    }

    fn set(&self, f: impl FnOnce(&mut State)) {
        f(&mut lock(&self.state));
    }
}

/// The HUD's supervisor. Dropping it stops it.
pub struct Supervisor {
    shared: Arc<Shared>,
    endpoint: Endpoint,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Supervisor")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl Supervisor {
    /// Listen, and start (and keep restarting) the HUD. `on_event` runs on
    /// the supervisor's threads and must not block.
    pub fn start(
        config: SupervisorConfig,
        on_event: impl Fn(Event) + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        let listener = Listener::bind()?;
        let endpoint = listener.endpoint();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                stopping: false,
                phase: Phase::Starting,
                pid: None,
                starts: 0,
                last_exit: None,
                health: None,
                dropped: 0,
            }),
            wake: Condvar::new(),
            link: Mutex::new(None),
            token: Mutex::new(None),
        });
        let (conn_tx, conn_rx) = mpsc::channel::<(Connection, Peer)>();
        {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("rail-hud-accept".to_owned())
                .spawn(move || accept_loop(&listener, &shared, &conn_tx))?;
        }
        let thread = {
            let shared = Arc::clone(&shared);
            let endpoint = endpoint.clone();
            let on_event: OnEvent = Arc::new(on_event);
            std::thread::Builder::new()
                .name("rail-hud-supervisor".to_owned())
                .spawn(move || run(&config, &endpoint, &shared, &conn_rx, &on_event))?
        };
        Ok(Self {
            shared,
            endpoint,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// The endpoint the HUD connects to.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Queue a message for the HUD; never waits. `false` when no HUD is
    /// connected or the queue was full (it will be told to resync).
    pub fn send(&self, message: AppMessage) -> bool {
        lock(&self.shared.link)
            .as_ref()
            .is_some_and(|link| link.send(message) == Sent::Queued)
    }

    /// A HUD is connected.
    pub fn is_connected(&self) -> bool {
        lock(&self.shared.link)
            .as_ref()
            .is_some_and(|link| !link.is_closed())
    }

    pub fn status(&self) -> Status {
        let dropped = lock(&self.shared.link).as_ref().map_or(0, Link::dropped);
        let state = lock(&self.shared.state);
        Status {
            phase: state.phase,
            pid: state.pid,
            starts: state.starts,
            last_exit: state.last_exit.clone(),
            health: state.health.as_ref().map(|(_, report)| report.clone()),
            health_age: state.health.as_ref().map(|(at, _)| at.elapsed()),
            dropped: state.dropped + dropped,
        }
    }

    /// Shut the HUD down and stop supervising (on app exit). Waits at most
    /// about `shutdown_grace`.
    pub fn stop(&self) {
        let Some(thread) = lock(&self.thread).take() else {
            return; // stopped already
        };
        // Asked politely first, while the link is still up.
        self.send(AppMessage::Shutdown);
        self.shared.set(|state| state.stopping = true);
        self.shared.wake.notify_all();
        let _ = thread.join();
        // The acceptor waits in `accept`: a connection wakes it, it sees
        // `stopping` and drops the listener (removing the socket).
        let _ = connect(&self.endpoint);
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(
    listener: &Listener,
    shared: &Arc<Shared>,
    conn_tx: &mpsc::Sender<(Connection, Peer)>,
) {
    loop {
        let accepted = listener.accept();
        if shared.stopping() {
            return;
        }
        let mut conn = match accepted {
            Ok(conn) => conn,
            Err(error) => {
                log::warn!("hud: accept: {error}");
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let shared = Arc::clone(shared);
        let conn_tx = conn_tx.clone();
        // Each handshake on its own thread: a peer that connects and says
        // nothing holds only that thread (5 s on Unix).
        let spawned = std::thread::Builder::new()
            .name("rail-hud-handshake".to_owned())
            .spawn(move || {
                let Some(token) = lock(&shared.token).clone() else {
                    log::warn!("hud: a connection while no HUD is starting: closed");
                    return;
                };
                if let Err(error) = conn.set_read_timeout(Some(Duration::from_secs(5))) {
                    log::warn!("hud: {error}");
                    return;
                }
                match server_handshake(&mut conn.reader, &mut conn.writer, &token) {
                    Ok(peer) => {
                        if conn.set_read_timeout(None).is_ok() {
                            let _ = conn_tx.send((conn, peer));
                        }
                    }
                    Err(error) => log::warn!("hud: a connection refused: {error}"),
                }
            });
        if let Err(error) = spawned {
            log::warn!("hud: handshake thread: {error}");
        }
    }
}

/// The HUD process being supervised.
struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    started: Instant,
}

impl Running {
    fn exited(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(format!("exited ({status})")),
            Ok(None) => None,
            Err(error) => Some(format!("lost ({error})")),
        }
    }

    /// Close its standard input (it exits on that), give it `grace`, then
    /// kill it.
    fn end(mut self, grace: Duration) -> Option<String> {
        drop(self.stdin.take());
        let deadline = Instant::now() + grace;
        loop {
            if let Some(exit) = self.exited() {
                return Some(exit);
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        None
    }
}

fn spawn(config: &SupervisorConfig, endpoint: &str, token: &Token) -> std::io::Result<Running> {
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .arg(crate::ENDPOINT_ARG)
        .arg(endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        /// `CREATE_NO_WINDOW`: the HUD is a console program; started from
        /// the windowed app it would otherwise get a console of its own.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take();
    let written = stdin
        .as_mut()
        .map(|stdin| {
            stdin
                .write_all(format!("{}\n", token.to_hex()).as_bytes())
                .and_then(|()| stdin.flush())
        })
        .unwrap_or_else(|| Err(std::io::Error::other("no standard input")));
    if let Err(error) = written {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    if let Some(stderr) = child.stderr.take() {
        let pid = child.id();
        let _ = std::thread::Builder::new()
            .name("rail-hud-stderr".to_owned())
            .spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    log::info!(target: "rail_hud", "[{pid}] {line}");
                }
            });
    }
    Ok(Running {
        child,
        stdin,
        started: Instant::now(),
    })
}

/// Wait for the started process's connection. `None`: it exited, took too
/// long, or the supervisor is stopping (`Err` says which).
fn await_connection(
    config: &SupervisorConfig,
    shared: &Shared,
    conn_rx: &Receiver<(Connection, Peer)>,
    running: &mut Running,
) -> Result<Connection, String> {
    let pid = running.child.id();
    loop {
        if shared.stopping() {
            return Err("stopping".to_owned());
        }
        match conn_rx.recv_timeout(Duration::from_millis(50)) {
            Ok((conn, peer)) if peer.pid == pid => return Ok(conn),
            // Another process with this token: cannot be (one token per
            // process), but nothing is taken that is not the one started.
            Ok((_, peer)) => log::warn!("hud: pid {} connected, expected {pid}", peer.pid),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("no acceptor".to_owned()),
        }
        if let Some(exit) = running.exited() {
            return Err(format!("{exit} before connecting"));
        }
        if running.started.elapsed() >= config.connect_timeout {
            return Err(format!(
                "no connection within {} s",
                config.connect_timeout.as_secs()
            ));
        }
    }
}

/// Watch a connected HUD until it must be restarted (or the supervisor
/// stops). Returns why it ended.
fn monitor(config: &SupervisorConfig, shared: &Shared, running: &mut Running) -> String {
    let mut seq = 0u64;
    let mut next_health = Instant::now();
    let connected_at = Instant::now();
    loop {
        if shared.wait(Duration::from_millis(50)) {
            return "stopping".to_owned();
        }
        if let Some(exit) = running.exited() {
            return exit;
        }
        let closed = lock(&shared.link).as_ref().is_none_or(Link::is_closed);
        if closed {
            return "the connection closed".to_owned();
        }
        let now = Instant::now();
        if now >= next_health {
            seq += 1;
            if let Some(link) = lock(&shared.link).as_ref() {
                link.send(AppMessage::Health { seq });
            }
            next_health = now + config.health_interval;
        }
        let last_answer = lock(&shared.state)
            .health
            .as_ref()
            .map_or(connected_at, |(at, _)| (*at).max(connected_at));
        if now.duration_since(last_answer) >= config.health_timeout {
            return format!("no health answer for {} s", config.health_timeout.as_secs());
        }
    }
}

fn run(
    config: &SupervisorConfig,
    endpoint: &str,
    shared: &Arc<Shared>,
    conn_rx: &Receiver<(Connection, Peer)>,
    on_event: &OnEvent,
) {
    let mut backoff = config.backoff_min;
    let mut missing_logged = false;
    loop {
        if shared.stopping() {
            break;
        }
        if !config.program.is_file() {
            if !missing_logged {
                log::warn!(
                    "hud: {} is not there (build it: cargo build -p rail-hud); looking again every 30 s",
                    config.program.display()
                );
                missing_logged = true;
            }
            shared.set(|state| state.phase = Phase::NotInstalled);
            if shared.wait(Duration::from_secs(30)) {
                break;
            }
            continue;
        }
        missing_logged = false;

        let token = match Token::generate() {
            Ok(token) => token,
            Err(error) => {
                log::error!("hud: {error}");
                if shared.wait(config.backoff_max) {
                    break;
                }
                continue;
            }
        };
        // Connections that finished a handshake for an earlier process.
        while conn_rx.try_recv().is_ok() {}
        *lock(&shared.token) = Some(token.clone());
        shared.set(|state| {
            state.phase = Phase::Starting;
            state.starts += 1;
            state.health = None;
        });
        let ended = match spawn(config, endpoint, &token) {
            Err(error) => {
                *lock(&shared.token) = None;
                format!("did not start: {error}")
            }
            Ok(mut running) => {
                let pid = running.child.id();
                shared.set(|state| state.pid = Some(pid));
                log::info!("hud: started, pid {pid}");
                let reason = match await_connection(config, shared, conn_rx, &mut running) {
                    Err(reason) => reason,
                    Ok(conn) => {
                        *lock(&shared.token) = None;
                        serve(config, shared, on_event, conn, pid, &mut running)
                    }
                };
                *lock(&shared.token) = None;
                let lasted = running.started.elapsed();
                // Ended first, the link closed after: a `shutdown` queued by
                // `stop` gets written while the HUD is given its grace.
                let exit = running.end(config.shutdown_grace);
                if let Some(link) = lock(&shared.link).take() {
                    shared.set(|state| state.dropped += link.dropped());
                    link.close();
                    on_event(Event::Disconnected {
                        reason: reason.clone(),
                    });
                }
                if lasted >= config.stable_after {
                    backoff = config.backoff_min;
                }
                match exit {
                    Some(exit) => format!("{reason}; {exit}"),
                    None => format!("{reason}; killed"),
                }
            }
        };
        let stopping = shared.stopping();
        if !stopping {
            log::warn!("hud: {ended}; starting again in {} ms", backoff.as_millis());
        }
        shared.set(|state| {
            state.pid = None;
            state.last_exit = Some(ended);
            state.phase = Phase::Backoff;
        });
        if stopping || shared.wait(backoff) {
            break;
        }
        backoff = (backoff * 2).min(config.backoff_max);
    }
    shared.set(|state| {
        state.phase = Phase::Stopped;
        state.pid = None;
    });
}

/// Run a connected HUD: the link, the events, the health checks.
fn serve(
    config: &SupervisorConfig,
    shared: &Arc<Shared>,
    on_event: &OnEvent,
    conn: Connection,
    pid: u32,
    running: &mut Running,
) -> String {
    let link = {
        let shared = Arc::clone(shared);
        let on_event = Arc::clone(on_event);
        Link::start(
            conn,
            "rail-hud-link",
            config.queue,
            Some(AppMessage::Resync),
            move |incoming: Incoming<HudMessage>| match incoming {
                Incoming::Message(message, at) => {
                    if let HudMessage::Health { report, .. } = &message {
                        let report = report.clone();
                        shared.set(|state| state.health = Some((at, report)));
                    }
                    on_event(Event::Message(message, at));
                }
                Incoming::Closed(reason) => {
                    if let Some(reason) = reason {
                        log::warn!("hud: connection: {reason}");
                    }
                }
            },
        )
    };
    let link = match link {
        Ok(link) => link,
        Err(error) => return format!("no link threads: {error}"),
    };
    *lock(&shared.link) = Some(link);
    shared.set(|state| state.phase = Phase::Running);
    log::info!("hud: connected, pid {pid}");
    on_event(Event::Connected { pid });
    monitor(config, shared, running)
}

//! (T2, docs/research/TABLE-TILING.md §4.3) Table tiling's placement
//! worker: a thread of its own that carries out the tiler's moves
//! (`crate::tiling::Move`) through the backend's [`Placer`], so the HUD's
//! loop never waits on a placement - twelve tables at up to 300 ms of
//! read-back each would otherwise stall every overlay for seconds - and
//! the overlays keep following the tables as they move (the moves reach
//! the loop as the platform's own events).
//!
//! **Safety rules (misclicks cost money):** a table is never moved while a
//! mouse button is down, nor within [`QUIET_AFTER_CLICK`] of the last
//! click or release ([`QuietGuard`]). The mouse is sampled every
//! [`SAMPLE_EVERY`] whatever is queued (on Windows that sampling is the
//! only record of a click: `GetAsyncKeyState` says what is down now, and
//! a press since the last sample; macOS also says how long ago the last
//! press was), and checked again right before **each** placement, so a
//! click in the middle of re-tiling twelve tables stops the rest. Moves
//! wait in a queue meanwhile, **coalesced**: a newer move of a window
//! replaces one not yet carried out, and a window the user took over is
//! cancelled (`crate::tiling::Tiler::take_cancels`). Nothing is retried
//! here: the tiler decides on every answer.

#![forbid(unsafe_code)]

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::platform::{MouseState, Placer, PlatformError, Rect, WindowId};
use crate::tiling::{Mouse, Move, USER_MOVE_CLICK};

/// No table moves until this long after the last mouse press or release.
pub const QUIET_AFTER_CLICK: Duration = Duration::from_millis(600);

/// How often the worker reads the mouse.
pub const SAMPLE_EVERY: Duration = Duration::from_millis(25);

/// What the mouse did lately, as the safety rules read it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QuietGuard {
    /// A button was down at the last sample.
    down: bool,
    /// The last press or release seen (or said by the system).
    last_click: Option<Instant>,
}

impl QuietGuard {
    /// A sample of the mouse taken at `now`.
    pub fn note(&mut self, now: Instant, mouse: MouseState) {
        if mouse.down || self.down {
            // Held, or released since the last sample: activity now.
            self.last_click = Some(now);
        }
        self.down = mouse.down;
        if let Some(at) = mouse.since_click.and_then(|since| now.checked_sub(since)) {
            self.last_click = Some(self.last_click.map_or(at, |last| last.max(at)));
        }
    }

    /// Whether a table may move at `now`: no button down, no click in the
    /// last [`QUIET_AFTER_CLICK`].
    pub fn quiet(&self, now: Instant) -> bool {
        !self.down
            && self
                .last_click
                .is_none_or(|at| now.saturating_duration_since(at) >= QUIET_AFTER_CLICK)
    }

    /// The mouse as the tiler reads a table's change: a button down now,
    /// down in the last [`USER_MOVE_CLICK`], or neither.
    pub fn activity(&self, now: Instant) -> Mouse {
        if self.down {
            Mouse::Down
        } else if self.recent(now, USER_MOVE_CLICK) {
            Mouse::Recent
        } else {
            Mouse::Idle
        }
    }

    /// Whether a button is down or was in the last `within`: a table that
    /// moved then was moved by the user (`crate::tiling::USER_MOVE_CLICK`).
    pub fn recent(&self, now: Instant, within: Duration) -> bool {
        self.down
            || self
                .last_click
                .is_some_and(|at| now.saturating_duration_since(at) < within)
    }
}

/// A placement carried out: the answer for the tiler
/// (`crate::tiling::Tiler::placed`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    pub id: WindowId,
    pub seq: u64,
    pub result: Result<Rect, PlatformError>,
}

#[derive(Debug)]
enum Request {
    Place(Move),
    Cancel(WindowId),
}

/// The worker thread and its queue. Dropped: the thread ends after the
/// placement it may be carrying out, and whatever was queued is not done
/// (tiling switched off leaves windows where they are).
#[derive(Debug)]
pub struct Worker {
    requests: Option<Sender<Request>>,
    done: Receiver<Done>,
    guard: Arc<Mutex<QuietGuard>>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    /// Start the thread with the backend's placer.
    pub fn start(placer: Box<dyn Placer>) -> std::io::Result<Self> {
        let (requests, inbox) = mpsc::channel();
        let (outbox, done) = mpsc::channel();
        let guard = Arc::new(Mutex::new(QuietGuard::default()));
        let shared = Arc::clone(&guard);
        let thread = std::thread::Builder::new()
            .name("rail-hud-tiling".to_owned())
            .spawn(move || run(placer, &inbox, &outbox, &shared))?;
        Ok(Self {
            requests: Some(requests),
            done,
            guard,
            thread: Some(thread),
        })
    }

    /// Queue a move (replacing one of the same window not carried out yet).
    pub fn place(&self, m: Move) {
        if let Some(requests) = &self.requests {
            let _ = requests.send(Request::Place(m));
        }
    }

    /// Drop a queued move of window `id`.
    pub fn cancel(&self, id: WindowId) {
        if let Some(requests) = &self.requests {
            let _ = requests.send(Request::Cancel(id));
        }
    }

    /// The placements carried out since the last call; never blocks.
    pub fn results(&self) -> Vec<Done> {
        self.done.try_iter().collect()
    }

    /// The mouse as the worker last sampled it.
    pub fn guard(&self) -> QuietGuard {
        *self.guard.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.requests = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The worker's loop: take requests, sample the mouse, carry out the
/// oldest queued move when the mouse is quiet - one at a time, sampling
/// again before the next. Ends when the [`Worker`] is dropped.
fn run(
    mut placer: Box<dyn Placer>,
    inbox: &Receiver<Request>,
    outbox: &Sender<Done>,
    guard: &Mutex<QuietGuard>,
) {
    let mut queue: Vec<Move> = Vec::new();
    let mut quiet = false;
    loop {
        // Waiting for work or the next sample; straight on while moves
        // are due.
        let first = if quiet && !queue.is_empty() {
            match inbox.try_recv() {
                Ok(request) => Some(request),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return,
            }
        } else {
            match inbox.recv_timeout(SAMPLE_EVERY) {
                Ok(request) => Some(request),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        };
        for request in first.into_iter().chain(inbox.try_iter()) {
            match request {
                Request::Place(m) => match queue.iter_mut().find(|q| q.id == m.id) {
                    Some(queued) => *queued = m,
                    None => queue.push(m),
                },
                Request::Cancel(id) => queue.retain(|q| q.id != id),
            }
        }
        let now = Instant::now();
        let mouse = placer.mouse();
        quiet = {
            let mut guard = guard.lock().unwrap_or_else(PoisonError::into_inner);
            guard.note(now, mouse);
            guard.quiet(now)
        };
        if quiet && !queue.is_empty() {
            let m = queue.remove(0);
            let result = placer.place(m.id, m.want);
            if outbox
                .send(Done {
                    id: m.id,
                    seq: m.seq,
                    result,
                })
                .is_err()
            {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(since: Option<u64>) -> MouseState {
        MouseState {
            down: false,
            since_click: since.map(Duration::from_millis),
        }
    }

    /// The guard: quiet with no click; a button held is never quiet; the
    /// release counts as a click; the system's "since the last press"
    /// counts too.
    #[test]
    fn the_guard_waits_for_quiet() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut guard = QuietGuard::default();
        assert!(guard.quiet(t0));
        assert!(!guard.recent(t0, Duration::from_secs(2)));
        guard.note(
            ms(0),
            MouseState {
                down: true,
                since_click: None,
            },
        );
        assert!(!guard.quiet(ms(5000)), "held");
        assert!(guard.recent(ms(5000), Duration::from_secs(2)));
        guard.note(ms(1000), MouseState::default());
        assert!(!guard.quiet(ms(1599)), "released at 1000");
        assert!(guard.quiet(ms(1600)));
        assert!(guard.recent(ms(2999), Duration::from_secs(2)));
        assert!(!guard.recent(ms(3000), Duration::from_secs(2)));
        // macOS: a click between samples, said by the system.
        guard.note(ms(5000), press(Some(100)));
        assert!(!guard.quiet(ms(5499)));
        assert!(guard.quiet(ms(5500)));
        // An older press never makes the last one older.
        guard.note(ms(5100), press(Some(10_000)));
        assert!(!guard.quiet(ms(5499)));
    }

    /// A placer that records what it did and whose mouse a test holds.
    #[derive(Debug, Clone, Default)]
    struct Fake {
        placed: Arc<Mutex<Vec<(WindowId, Rect, Instant)>>>,
        mouse: Arc<Mutex<MouseState>>,
    }

    impl Placer for Fake {
        fn place(&mut self, id: WindowId, want: Rect) -> Result<Rect, PlatformError> {
            std::thread::sleep(Duration::from_millis(20));
            self.placed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((id, want, Instant::now()));
            Ok(want)
        }

        fn mouse(&mut self) -> MouseState {
            *self.mouse.lock().unwrap_or_else(PoisonError::into_inner)
        }
    }

    fn mv(id: u64, seq: u64, x: i32) -> Move {
        let want = Rect {
            x,
            y: 0,
            width: 100,
            height: 100,
        };
        Move {
            id: WindowId(id),
            seq,
            want,
            outer: want,
        }
    }

    fn wait_for(worker: &Worker, n: usize) -> Vec<Done> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got = Vec::new();
        while got.len() < n {
            assert!(Instant::now() < deadline, "{got:?}");
            got.extend(worker.results());
            std::thread::sleep(Duration::from_millis(5));
        }
        got
    }

    /// The worker places off the caller's thread, waits while the mouse is
    /// down and 600 ms after, keeps only the latest move of a window and
    /// drops a cancelled one.
    #[test]
    fn the_worker_waits_coalesces_and_cancels() {
        let fake = Fake::default();
        let worker = Worker::start(Box::new(fake.clone())).expect("worker");
        let started = Instant::now();
        worker.place(mv(1, 1, 10));
        let done = wait_for(&worker, 1);
        assert_eq!(done[0].seq, 1);
        assert_eq!(done[0].result.as_ref().map(|r| r.x), Ok(10));

        // Held: nothing moves; the queue coalesces meanwhile.
        fake.mouse.lock().expect("mouse").down = true;
        std::thread::sleep(SAMPLE_EVERY * 3);
        worker.place(mv(2, 2, 20));
        worker.place(mv(3, 3, 30));
        worker.place(mv(2, 4, 40));
        worker.cancel(WindowId(3));
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            worker.results().is_empty(),
            "nothing while the button is down"
        );
        assert!(
            worker
                .guard()
                .recent(Instant::now(), Duration::from_secs(1))
        );
        fake.mouse.lock().expect("mouse").down = false;
        let released = Instant::now();
        let done = wait_for(&worker, 1);
        assert_eq!((done[0].id, done[0].seq), (WindowId(2), 4), "the latest");
        std::thread::sleep(Duration::from_millis(100));
        assert!(worker.results().is_empty(), "the cancelled one never");
        let placed = fake.placed.lock().expect("placed").clone();
        assert_eq!(placed.len(), 2);
        assert!(
            placed[1].2.duration_since(released) + SAMPLE_EVERY >= QUIET_AFTER_CLICK,
            "{:?} after the release",
            placed[1].2.duration_since(released)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        drop(worker);
    }
}

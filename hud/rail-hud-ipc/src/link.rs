//! An authenticated connection as two threads: one reads frames and hands
//! them to a callback, one writes frames from a bounded queue. [`Link::send`]
//! never blocks: a full queue drops the message (and, when the link was
//! given one, the next write is preceded by a resync message telling the
//! peer it missed something), a closed link refuses it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::time::Instant;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::MAX_FRAME;
use crate::frame::{FrameError, read_frame, write_frame};
use crate::transport::{Closer, Connection};

/// What the reading thread hands over.
#[derive(Debug)]
pub enum Incoming<In> {
    /// A message, with the moment it was read (the start of a latency).
    Message(In, Instant),
    /// The connection ended: `None` when the peer closed it, else why.
    Closed(Option<String>),
}

/// What became of a [`Link::send`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    Queued,
    /// The queue was full: dropped (the peer will be told to resync).
    Dropped,
    /// The link is closed.
    Closed,
}

/// The sending side of a connection; the threads end when the connection
/// does, or when the link is dropped (the writer) and the peer then closes
/// (the reader).
#[derive(Debug)]
pub struct Link<Out> {
    tx: SyncSender<Out>,
    closed: Arc<AtomicBool>,
    overflowed: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    closer: Closer,
}

impl<Out> Link<Out>
where
    Out: Serialize + Clone + Send + 'static,
{
    /// Start the two threads on `conn`. `capacity` messages may wait to be
    /// written; `resync` (if any) is written before the next message after
    /// one was dropped. `on_incoming` runs on the reading thread: keep it
    /// short.
    pub fn start<In, F>(
        conn: Connection,
        name: &str,
        capacity: usize,
        resync: Option<Out>,
        mut on_incoming: F,
    ) -> std::io::Result<Self>
    where
        In: DeserializeOwned + Send + 'static,
        F: FnMut(Incoming<In>) + Send + 'static,
    {
        let (mut reader, mut writer, closer) = conn.split();
        let (tx, rx) = mpsc::sync_channel::<Out>(capacity.max(1));
        let closed = Arc::new(AtomicBool::new(false));
        let overflowed = Arc::new(AtomicBool::new(false));

        let writer_closed = Arc::clone(&closed);
        let writer_overflowed = Arc::clone(&overflowed);
        let writer_closer = closer.clone();
        std::thread::Builder::new()
            .name(format!("{name}-write"))
            .spawn(move || {
                for message in rx {
                    if writer_overflowed.swap(false, Ordering::SeqCst)
                        && let Some(resync) = &resync
                        && write_frame(&mut writer, resync, MAX_FRAME).is_err()
                    {
                        break;
                    }
                    match write_frame(&mut writer, &message, MAX_FRAME) {
                        Ok(()) => {}
                        // A message too large for a frame is a bug on this
                        // side, not a broken link: dropped and logged.
                        Err(FrameError::Size { len, max }) => {
                            log::error!("ipc: a message of {len} bytes (limit {max}) not sent");
                        }
                        Err(_) => break,
                    }
                }
                writer_closed.store(true, Ordering::SeqCst);
                writer_closer.close();
            })?;

        let reader_closed = Arc::clone(&closed);
        let reader_closer = closer.clone();
        std::thread::Builder::new()
            .name(format!("{name}-read"))
            .spawn(move || {
                let reason = loop {
                    match read_frame::<In>(&mut reader, MAX_FRAME) {
                        Ok(message) => on_incoming(Incoming::Message(message, Instant::now())),
                        Err(FrameError::Closed) => break None,
                        Err(error) => break Some(error.to_string()),
                    }
                };
                reader_closed.store(true, Ordering::SeqCst);
                reader_closer.close();
                on_incoming(Incoming::Closed(reason));
            })?;

        Ok(Self {
            tx,
            closed,
            overflowed,
            dropped: Arc::new(AtomicU64::new(0)),
            closer,
        })
    }

    /// Queue `message`; never waits.
    pub fn send(&self, message: Out) -> Sent {
        if self.is_closed() {
            return Sent::Closed;
        }
        match self.tx.try_send(message) {
            Ok(()) => Sent::Queued,
            Err(TrySendError::Full(_)) => {
                self.overflowed.store(true, Ordering::SeqCst);
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Sent::Dropped
            }
            Err(TrySendError::Disconnected(_)) => Sent::Closed,
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Messages dropped because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Close the connection now (the reader's callback then gets
    /// `Closed`).
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.closer.close();
    }
}

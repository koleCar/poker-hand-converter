//! Length-prefixed JSON: a frame is a 4-byte big-endian length, then that
//! many bytes of one JSON value. Zero-length and oversized frames are
//! refused before anything is allocated.

use std::fmt;
use std::io::{self, Read, Write};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Why a frame could not be read or written.
#[derive(Debug)]
pub enum FrameError {
    /// The peer closed the connection between frames.
    Closed,
    Io(io::Error),
    /// The length is 0 or above the limit in force.
    Size {
        len: u32,
        max: u32,
    },
    /// Not the JSON of the expected message.
    Json(serde_json::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("the peer closed the connection"),
            Self::Io(error) => write!(f, "{error}"),
            Self::Size { len, max } => write!(f, "a frame of {len} bytes (limit {max})"),
            Self::Json(error) => write!(f, "not a message: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Write `value` as one frame and flush. Refuses (without writing) a value
/// whose JSON is larger than `max`.
pub fn write_frame<T: Serialize>(
    writer: &mut impl Write,
    value: &T,
    max: u32,
) -> Result<(), FrameError> {
    let body = serde_json::to_vec(value).map_err(FrameError::Json)?;
    let len = u32::try_from(body.len()).unwrap_or(u32::MAX);
    if len == 0 || len > max {
        return Err(FrameError::Size { len, max });
    }
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&body);
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Read one frame of at most `max` bytes and parse it.
pub fn read_frame<T: DeserializeOwned>(reader: &mut impl Read, max: u32) -> Result<T, FrameError> {
    let mut prefix = [0u8; 4];
    // A clean end of stream before a frame starts is a close, not an error.
    let mut got = 0;
    while got < prefix.len() {
        match reader.read(&mut prefix[got..]) {
            Ok(0) if got == 0 => return Err(FrameError::Closed),
            Ok(0) => return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into())),
            Ok(n) => got += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    let len = u32::from_be_bytes(prefix);
    if len == 0 || len > max {
        return Err(FrameError::Size { len, max });
    }
    let mut body = vec![0u8; usize::try_from(len).unwrap_or(usize::MAX)];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(FrameError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AppMessage, PlayerRef};

    #[test]
    fn frames_round_trip_back_to_back() {
        let messages = vec![
            AppMessage::Health { seq: 1 },
            AppMessage::HandImported {
                site: "pokerstars".into(),
                table: Some("T".into()),
                hand_key: "pokerstars:1".into(),
                players: vec![PlayerRef::named("Ana")],
                timing: None,
            },
            AppMessage::Shutdown,
        ];
        let mut wire = Vec::new();
        for message in &messages {
            write_frame(&mut wire, message, 1024).expect("write");
        }
        assert_eq!(&wire[..4], &[0, 0, 0, 25], "big-endian length first");
        let mut reader = wire.as_slice();
        for message in &messages {
            let read: AppMessage = read_frame(&mut reader, 1024).expect("read");
            assert_eq!(&read, message);
        }
        assert!(matches!(
            read_frame::<AppMessage>(&mut reader, 1024),
            Err(FrameError::Closed)
        ));
    }

    #[test]
    fn sizes_are_limited_both_ways() {
        let big = AppMessage::Policy {
            remote: Some("x".repeat(2000)),
        };
        let mut wire = Vec::new();
        assert!(matches!(
            write_frame(&mut wire, &big, 1024),
            Err(FrameError::Size { max: 1024, .. })
        ));
        assert!(wire.is_empty(), "nothing written");
        write_frame(&mut wire, &big, 4096).expect("fits the larger limit");
        assert!(matches!(
            read_frame::<AppMessage>(&mut wire.as_slice(), 1024),
            Err(FrameError::Size { max: 1024, .. })
        ));
        // A hostile length is refused before allocating.
        let hostile = [0xff, 0xff, 0xff, 0xff, b'{'];
        assert!(matches!(
            read_frame::<AppMessage>(&mut hostile.as_slice(), crate::MAX_FRAME),
            Err(FrameError::Size { len: u32::MAX, .. })
        ));
        let empty = [0, 0, 0, 0];
        assert!(matches!(
            read_frame::<AppMessage>(&mut empty.as_slice(), 1024),
            Err(FrameError::Size { len: 0, .. })
        ));
    }

    #[test]
    fn truncated_and_garbage_frames_are_errors() {
        let mut wire = Vec::new();
        write_frame(&mut wire, &AppMessage::Resync, 1024).expect("write");
        let cut = &wire[..wire.len() - 2];
        assert!(matches!(
            read_frame::<AppMessage>(&mut &cut[..], 1024),
            Err(FrameError::Io(_))
        ));
        assert!(matches!(
            read_frame::<AppMessage>(&mut &wire[..2], 1024),
            Err(FrameError::Io(_))
        ));
        let garbage = [0, 0, 0, 3, b'a', b'b', b'c'];
        assert!(matches!(
            read_frame::<AppMessage>(&mut garbage.as_slice(), 1024),
            Err(FrameError::Json(_))
        ));
    }
}

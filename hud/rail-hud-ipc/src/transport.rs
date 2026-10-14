//! The local endpoint (docs/RAIL-PLAN.md §3.2): a Unix domain socket on
//! macOS and Linux, a named pipe on Windows. The app listens, the HUD
//! connects; an [`Endpoint`] is the text the HUD is given (`--ipc`).
//!
//! **Unix.** A new folder `rail-hud-<random>` in the user's temporary
//! directory (macOS: the per-user `$TMPDIR`; `/tmp` when that path would be
//! too long for a socket address), created `0700` - `mkdir` fails rather
//! than follow anything already there - holding `hud.sock`, `chmod 0600`
//! right after `bind`. Only the user (and root) can reach it. Both are
//! removed when the [`Listener`] is dropped.
//!
//! **Windows.** `\\.\pipe\rail-hud-<pid>-<random>`, created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE` (the app fails rather than join a pipe
//! someone else made first), `PIPE_REJECT_REMOTE_CLIENTS`, and the DACL
//! `D:P(A;;GA;;;OW)(A;;GA;;;SY)`: full access for the pipe's owner (the
//! user running the app) and SYSTEM, nobody else - the default DACL would
//! give Everyone and Anonymous read access.
//!
//! Either way other users cannot connect, and the user's other processes
//! fail the handshake ([`crate::auth`]).

use std::io::{self, Read, Write};
use std::time::Duration;

/// Where the HUD connects: a socket path (Unix) or a pipe name (Windows).
pub type Endpoint = String;

/// An accepted or connected stream, before it is split into a reader and a
/// writer.
pub struct Connection {
    pub(crate) reader: Box<dyn Read + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    closer: Closer,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Connection(..)")
    }
}

/// Closes a connection from another thread (the reader may be blocked in a
/// read): on Unix a `shutdown` of the socket; on Windows the halves close
/// when both are dropped.
#[derive(Debug, Clone)]
pub struct Closer(#[cfg(unix)] Option<std::sync::Arc<std::os::unix::net::UnixStream>>);

impl Closer {
    pub fn close(&self) {
        #[cfg(unix)]
        if let Some(stream) = &self.0 {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Connection {
    /// Limit how long a read may wait (the handshake; `None`: forever).
    /// Windows' synchronous pipes have no read timeout: there only the
    /// user's own processes can connect at all.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(stream) = &self.closer.0 {
            stream.set_read_timeout(timeout)?;
        }
        #[cfg(not(unix))]
        let _ = timeout;
        Ok(())
    }

    /// The reader, the writer and a way to close both.
    pub fn split(self) -> (Box<dyn Read + Send>, Box<dyn Write + Send>, Closer) {
        (self.reader, self.writer, self.closer)
    }

    pub fn closer(&self) -> Closer {
        self.closer.clone()
    }
}

#[cfg(unix)]
mod imp {
    use std::fs::{DirBuilder, Permissions};
    use std::io;
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use super::{Closer, Connection, Endpoint};

    /// The longest socket path we use: `sun_path` is 104 bytes on macOS
    /// (108 on Linux), with its terminating zero.
    const MAX_SOCKET_PATH: usize = 100;

    #[derive(Debug)]
    pub struct Listener {
        inner: UnixListener,
        dir: PathBuf,
        path: PathBuf,
    }

    fn base_dir() -> PathBuf {
        let temp = std::env::temp_dir();
        // `rail-hud-<16 hex>/hud.sock` is 34 bytes more.
        if temp.as_os_str().len() + 35 > MAX_SOCKET_PATH {
            PathBuf::from("/tmp")
        } else {
            temp
        }
    }

    impl Listener {
        pub fn bind() -> io::Result<Self> {
            let base = base_dir();
            for _ in 0..8 {
                let dir = base.join(format!("rail-hud-{}", crate::auth::random_hex(8)?));
                match DirBuilder::new().mode(0o700).create(&dir) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
                // `mode` is filtered by the umask, which can only take bits
                // away; set it exactly anyway.
                std::fs::set_permissions(&dir, Permissions::from_mode(0o700))?;
                let path = dir.join("hud.sock");
                let bound = UnixListener::bind(&path).and_then(|inner| {
                    std::fs::set_permissions(&path, Permissions::from_mode(0o600))?;
                    Ok(inner)
                });
                return match bound {
                    Ok(inner) => Ok(Self { inner, dir, path }),
                    Err(error) => {
                        let _ = std::fs::remove_file(&path);
                        let _ = std::fs::remove_dir(&dir);
                        Err(error)
                    }
                };
            }
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "no fresh folder for the HUD socket",
            ))
        }

        pub fn endpoint(&self) -> Endpoint {
            self.path.to_string_lossy().into_owned()
        }

        pub fn accept(&self) -> io::Result<Connection> {
            let (stream, _) = self.inner.accept()?;
            wrap(stream)
        }

        pub fn socket_path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_dir(&self.dir);
        }
    }

    fn wrap(stream: UnixStream) -> io::Result<Connection> {
        let reader = stream.try_clone()?;
        let control = stream.try_clone()?;
        Ok(Connection {
            reader: Box::new(reader),
            writer: Box::new(stream),
            closer: Closer(Some(Arc::new(control))),
        })
    }

    pub fn connect(endpoint: &str) -> io::Result<Connection> {
        wrap(UnixStream::connect(endpoint)?)
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::time::Duration;

    use interprocess::ConnectWaitMode;
    use interprocess::os::windows::named_pipe::{
        DuplexPipeStream, PipeListener, PipeListenerOptions, PipeMode, pipe_mode,
    };
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use widestring::U16CString;

    use super::{Closer, Connection, Endpoint};

    /// Owner rights and SYSTEM, full access; the DACL is protected (nothing
    /// inherited), so nobody else is in it.
    const DACL: &str = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";

    pub struct Listener {
        inner: PipeListener<pipe_mode::Bytes, pipe_mode::Bytes>,
        name: String,
    }

    impl std::fmt::Debug for Listener {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Listener")
                .field("name", &self.name)
                .finish()
        }
    }

    impl Listener {
        pub fn bind() -> io::Result<Self> {
            let name = format!(
                r"\\.\pipe\rail-hud-{}-{}",
                std::process::id(),
                crate::auth::random_hex(8)?
            );
            let sddl = U16CString::from_str(DACL).map_err(io::Error::other)?;
            let descriptor = SecurityDescriptor::deserialize(&sddl)?;
            let inner = PipeListenerOptions::new()
                .path(name.as_str())
                .mode(PipeMode::Bytes)
                .accept_remote(false)
                .security_descriptor(Some(descriptor))
                .create_duplex::<pipe_mode::Bytes>()?;
            Ok(Self { inner, name })
        }

        pub fn endpoint(&self) -> Endpoint {
            self.name.clone()
        }

        pub fn accept(&self) -> io::Result<Connection> {
            Ok(wrap(self.inner.accept()?))
        }
    }

    fn wrap(stream: DuplexPipeStream<pipe_mode::Bytes>) -> Connection {
        let (reader, writer) = stream.split();
        Connection {
            reader: Box::new(reader),
            writer: Box::new(writer),
            closer: Closer(),
        }
    }

    pub fn connect(endpoint: &str) -> io::Result<Connection> {
        Ok(wrap(
            DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path_with_wait_mode(
                endpoint,
                ConnectWaitMode::Timeout(Duration::from_secs(5)),
            )?,
        ))
    }
}

pub use imp::{Listener, connect};

#[cfg(test)]
mod tests {

    use super::*;

    /// Both directions at once over the real endpoint, from two threads per
    /// side (Windows: a synchronous pipe that serialised reads and writes
    /// would hang here).
    #[test]
    fn duplex_over_the_real_endpoint() {
        let listener = Listener::bind().expect("bind");
        let endpoint = listener.endpoint();
        let server = std::thread::spawn(move || {
            let conn = listener.accept().expect("accept");
            let (mut reader, mut writer, _closer) = conn.split();
            let echo = std::thread::spawn(move || {
                let mut got = vec![0u8; 64 * 1024];
                reader.read_exact(&mut got).expect("server reads");
                got
            });
            writer.write_all(&[7u8; 64 * 1024]).expect("server writes");
            writer.flush().expect("flush");
            echo.join().expect("echo")
        });
        let conn = connect(&endpoint).expect("connect");
        let (mut reader, mut writer, _closer) = conn.split();
        let sent = std::thread::spawn(move || {
            writer.write_all(&[9u8; 64 * 1024]).expect("client writes");
            writer.flush().expect("flush");
            writer
        });
        let mut got = vec![0u8; 64 * 1024];
        reader.read_exact(&mut got).expect("client reads");
        assert!(got.iter().all(|&b| b == 7));
        let _writer = sent.join().expect("writer");
        let at_server = server.join().expect("server");
        assert!(at_server.iter().all(|&b| b == 9));
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_is_the_users_only_and_goes_away() {
        use std::os::unix::fs::PermissionsExt as _;

        let listener = Listener::bind().expect("bind");
        let socket = listener.socket_path().to_path_buf();
        let dir = socket.parent().expect("dir").to_path_buf();
        let mode = |p: &std::path::Path| {
            std::fs::metadata(p).expect("metadata").permissions().mode() & 0o777
        };
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&socket), 0o600);
        assert!(socket.as_os_str().len() <= 100);
        let other = Listener::bind().expect("a second one");
        assert_ne!(other.endpoint(), listener.endpoint());
        drop(listener);
        assert!(!socket.exists() && !dir.exists());
    }

    #[cfg(windows)]
    #[test]
    fn pipe_names_are_fresh() {
        let listener = Listener::bind().expect("bind");
        assert!(listener.endpoint().starts_with(r"\\.\pipe\rail-hud-"));
        let other = Listener::bind().expect("a second one");
        assert_ne!(other.endpoint(), listener.endpoint());
    }

    #[test]
    fn nothing_listening_is_an_error() {
        let listener = Listener::bind().expect("bind");
        let endpoint = listener.endpoint();
        drop(listener);
        assert!(connect(&endpoint).is_err());
    }
}

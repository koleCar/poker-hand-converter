//! Who may talk on the channel.
//!
//! The app makes a fresh random [`Token`] (256 bits) for every HUD process
//! it starts and writes it as the first line of the HUD's standard input -
//! an inherited pipe nobody else can read (a command-line argument would be
//! visible to every user in the process list; the environment of a process
//! is readable by its user's other processes on some systems and cannot be
//! cleared without `unsafe` in Rust 2024).
//!
//! The handshake is a mutual challenge-response over that shared secret,
//! before any other message:
//!
//! ```text
//! HUD -> app   client_hello  { protocol, nonce: Nc, pid }
//! app -> HUD   server_hello  { protocol, nonce: Ns, proof: HMAC(T, "server" Nc Ns) }
//! HUD -> app   client_proof  { proof: HMAC(T, "client" Nc Ns) }
//! app -> HUD   welcome
//! ```
//!
//! HMAC-SHA256 (RFC 2104 over `sha2`, checked against RFC 4231's vectors),
//! compared in constant time; nonces are 256 random
//! bits each, so a recorded handshake cannot be replayed. The HUD checks the
//! app's proof before giving its own, so a process that squats on the
//! endpoint learns nothing. A wrong version or proof gets `refused` and the
//! connection closed. Frames are limited to
//! [`crate::MAX_HANDSHAKE_FRAME`] until `welcome`.

use std::fmt;
use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::frame::{FrameError, read_frame, write_frame};
use crate::{MAX_HANDSHAKE_FRAME, PROTOCOL_VERSION};

/// Bytes of a token and of a nonce.
const SECRET_BYTES: usize = 32;

/// The shared secret of one HUD process. `Debug` does not print it.
#[derive(Clone, PartialEq, Eq)]
pub struct Token([u8; SECRET_BYTES]);

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(..)")
    }
}

impl Token {
    /// A new random token.
    pub fn generate() -> Result<Self, AuthError> {
        Ok(Self(random()?))
    }

    /// The token as the HUD reads it: 64 lowercase hex digits.
    pub fn to_hex(&self) -> String {
        hex(&self.0)
    }

    /// A token from its hex form (surrounding whitespace ignored).
    pub fn from_hex(text: &str) -> Option<Self> {
        let bytes = unhex(text.trim())?;
        Some(Self(bytes.try_into().ok()?))
    }
}

/// Why a handshake failed.
#[derive(Debug)]
pub enum AuthError {
    Frame(FrameError),
    /// The peer speaks another protocol version.
    Version {
        ours: u32,
        theirs: u32,
    },
    /// The peer's proof is wrong: it does not know the token.
    BadProof,
    /// The peer refused us, saying why.
    Refused(String),
    /// A message out of order, or a malformed nonce.
    Unexpected(String),
    /// The system's random source failed.
    Random,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame(error) => write!(f, "{error}"),
            Self::Version { ours, theirs } => {
                write!(f, "protocol {theirs} offered, this side speaks {ours}")
            }
            Self::BadProof => f.write_str("the peer does not know the token"),
            Self::Refused(reason) => write!(f, "refused: {reason}"),
            Self::Unexpected(what) => write!(f, "unexpected: {what}"),
            Self::Random => f.write_str("no random numbers from the system"),
        }
    }
}

impl std::error::Error for AuthError {}

impl From<FrameError> for AuthError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

/// The handshake's messages (never seen after it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Handshake {
    ClientHello {
        protocol: u32,
        nonce: String,
        pid: u32,
    },
    ServerHello {
        protocol: u32,
        nonce: String,
        proof: String,
    },
    ClientProof {
        proof: String,
    },
    Welcome,
    Refused {
        reason: String,
    },
}

/// What the app learns about the HUD that connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer {
    /// The process id the HUD says it has (it proved the token, so it is the
    /// HUD the app started with that token).
    pub pid: u32,
}

fn random() -> Result<[u8; SECRET_BYTES], AuthError> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| AuthError::Random)?;
    Ok(bytes)
}

/// `bytes` random bytes as hex (folder and pipe names).
pub(crate) fn random_hex(bytes: usize) -> std::io::Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(hex(&buf))
}

/// HMAC-SHA256 (RFC 2104).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for ((inner, outer), key) in inner_pad.iter_mut().zip(&mut outer_pad).zip(&block) {
        *inner ^= key;
        *outer ^= key;
    }
    let inner = Sha256::new()
        .chain_update(inner_pad)
        .chain_update(message)
        .finalize();
    let outer = Sha256::new()
        .chain_update(outer_pad)
        .chain_update(inner)
        .finalize();
    let mut tag = [0u8; 32];
    tag.copy_from_slice(&outer);
    tag
}

/// Equal, in time that does not depend on where they differ.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    text.as_bytes()
        .chunks(2)
        .map(|pair| Some((digit(pair[0])? << 4) | digit(pair[1])?))
        .collect()
}

/// A nonce as sent: 64 hex digits.
fn nonce() -> Result<String, AuthError> {
    Ok(hex(&random()?))
}

fn check_nonce(nonce: &str) -> Result<(), AuthError> {
    match unhex(nonce) {
        Some(bytes) if bytes.len() == SECRET_BYTES => Ok(()),
        _ => Err(AuthError::Unexpected("a malformed nonce".to_owned())),
    }
}

/// What each side signs: its role, the version and both nonces.
fn transcript(role: &str, protocol: u32, client: &str, server: &str) -> Vec<u8> {
    format!("rail-hud-ipc/{protocol} {role}\n{client}\n{server}").into_bytes()
}

fn proof(token: &Token, role: &str, protocol: u32, client: &str, server: &str) -> String {
    hex(&hmac_sha256(
        &token.0,
        &transcript(role, protocol, client, server),
    ))
}

fn verify(
    token: &Token,
    role: &str,
    protocol: u32,
    client: &str,
    server: &str,
    proof: &str,
) -> bool {
    let Some(tag) = unhex(proof) else {
        return false;
    };
    constant_time_eq(
        &hmac_sha256(&token.0, &transcript(role, protocol, client, server)),
        &tag,
    )
}

fn send(writer: &mut impl Write, message: &Handshake) -> Result<(), AuthError> {
    Ok(write_frame(writer, message, MAX_HANDSHAKE_FRAME)?)
}

fn receive(reader: &mut impl Read) -> Result<Handshake, AuthError> {
    Ok(read_frame(reader, MAX_HANDSHAKE_FRAME)?)
}

fn refuse(writer: &mut impl Write, reason: &str) {
    // Best effort: the connection is closed right after either way.
    let _ = send(
        writer,
        &Handshake::Refused {
            reason: reason.to_owned(),
        },
    );
}

/// The app's side: the HUD must prove it knows `token`.
pub fn server_handshake(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: &Token,
) -> Result<Peer, AuthError> {
    let (protocol, client_nonce, pid) = match receive(reader)? {
        Handshake::ClientHello {
            protocol,
            nonce,
            pid,
        } => (protocol, nonce, pid),
        other => {
            refuse(writer, "client_hello expected");
            return Err(AuthError::Unexpected(format!("{other:?}")));
        }
    };
    if protocol != PROTOCOL_VERSION {
        refuse(
            writer,
            &format!("protocol {protocol} offered, the app speaks {PROTOCOL_VERSION}"),
        );
        return Err(AuthError::Version {
            ours: PROTOCOL_VERSION,
            theirs: protocol,
        });
    }
    check_nonce(&client_nonce)?;
    let server_nonce = nonce()?;
    send(
        writer,
        &Handshake::ServerHello {
            protocol,
            proof: proof(token, "server", protocol, &client_nonce, &server_nonce),
            nonce: server_nonce.clone(),
        },
    )?;
    match receive(reader)? {
        Handshake::ClientProof { proof }
            if verify(
                token,
                "client",
                protocol,
                &client_nonce,
                &server_nonce,
                &proof,
            ) =>
        {
            send(writer, &Handshake::Welcome)?;
            Ok(Peer { pid })
        }
        Handshake::ClientProof { .. } => {
            refuse(writer, "authentication failed");
            Err(AuthError::BadProof)
        }
        other => {
            refuse(writer, "client_proof expected");
            Err(AuthError::Unexpected(format!("{other:?}")))
        }
    }
}

/// The HUD's side: the app must prove it knows `token` first; then the HUD
/// proves it too.
pub fn client_handshake(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: &Token,
    pid: u32,
) -> Result<(), AuthError> {
    client_handshake_as(reader, writer, token, pid, PROTOCOL_VERSION)
}

fn client_handshake_as(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: &Token,
    pid: u32,
    protocol: u32,
) -> Result<(), AuthError> {
    let client_nonce = nonce()?;
    send(
        writer,
        &Handshake::ClientHello {
            protocol,
            nonce: client_nonce.clone(),
            pid,
        },
    )?;
    let server_nonce = match receive(reader)? {
        Handshake::ServerHello {
            protocol: theirs,
            nonce,
            proof,
        } => {
            if theirs != protocol {
                return Err(AuthError::Version {
                    ours: protocol,
                    theirs,
                });
            }
            check_nonce(&nonce)?;
            if !verify(token, "server", protocol, &client_nonce, &nonce, &proof) {
                // Not the app that started us: give it nothing.
                return Err(AuthError::BadProof);
            }
            nonce
        }
        Handshake::Refused { reason } => return Err(AuthError::Refused(reason)),
        other => return Err(AuthError::Unexpected(format!("{other:?}"))),
    };
    send(
        writer,
        &Handshake::ClientProof {
            proof: proof(token, "client", protocol, &client_nonce, &server_nonce),
        },
    )?;
    match receive(reader)? {
        Handshake::Welcome => Ok(()),
        Handshake::Refused { reason } => Err(AuthError::Refused(reason)),
        other => Err(AuthError::Unexpected(format!("{other:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Read, Write};
    use std::sync::mpsc;

    use super::*;

    /// One direction of an in-memory duplex connection.
    struct Pipe {
        rx: mpsc::Receiver<Vec<u8>>,
        buffer: Vec<u8>,
    }

    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.buffer.is_empty() {
                match self.rx.recv() {
                    Ok(bytes) => self.buffer = bytes,
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.buffer.len());
            buf[..n].copy_from_slice(&self.buffer[..n]);
            self.buffer.drain(..n);
            Ok(n)
        }
    }

    struct Sink(mpsc::Sender<Vec<u8>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .send(buf.to_vec())
                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn duplex() -> ((Pipe, Sink), (Pipe, Sink)) {
        let (a_tx, a_rx) = mpsc::channel();
        let (b_tx, b_rx) = mpsc::channel();
        (
            (
                Pipe {
                    rx: a_rx,
                    buffer: Vec::new(),
                },
                Sink(b_tx),
            ),
            (
                Pipe {
                    rx: b_rx,
                    buffer: Vec::new(),
                },
                Sink(a_tx),
            ),
        )
    }

    fn run(
        server_token: Token,
        client_token: Token,
        protocol: u32,
    ) -> (Result<Peer, AuthError>, Result<(), AuthError>) {
        let ((mut sr, mut sw), (mut cr, mut cw)) = duplex();
        let server = std::thread::spawn(move || server_handshake(&mut sr, &mut sw, &server_token));
        let client = client_handshake_as(&mut cr, &mut cw, &client_token, 4242, protocol);
        drop((cr, cw));
        (server.join().expect("server thread"), client)
    }

    #[test]
    fn tokens_are_random_and_read_back() {
        let a = Token::generate().expect("token");
        let b = Token::generate().expect("token");
        assert_ne!(a, b);
        assert_eq!(a.to_hex().len(), 64);
        assert_eq!(
            Token::from_hex(&format!(" {}\n", a.to_hex())),
            Some(a.clone())
        );
        assert_eq!(Token::from_hex(&a.to_hex().to_uppercase()), Some(a.clone()));
        assert_eq!(Token::from_hex("abc"), None);
        assert_eq!(Token::from_hex(&"g".repeat(64)), None);
        assert_eq!(Token::from_hex(&"a".repeat(62)), None);
        assert_eq!(format!("{a:?}"), "Token(..)", "never printed");
    }

    /// RFC 4231 test cases 1, 2, 6 and 7 (a short key, a key shorter than
    /// the tag, keys longer than a block).
    #[test]
    fn hmac_is_hmac_sha256() {
        let long: &[u8] = b"This is a test using a larger than block-size key and a larger \
than block-size data. The key needs to be hashed before being used by the HMAC algorithm.";
        let cases: [(&[u8], &[u8], &str); 4] = [
            (
                &[0x0b; 20],
                b"Hi There",
                "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
            ),
            (
                b"Jefe",
                b"what do ya want for nothing?",
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            ),
            (
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First",
                "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            ),
            (
                &[0xaa; 131],
                long,
                "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
            ),
        ];
        for (key, message, expected) in cases {
            assert_eq!(hex(&hmac_sha256(key, message)), expected);
        }
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn same_token_is_welcome() {
        let token = Token::generate().expect("token");
        let (server, client) = run(token.clone(), token, PROTOCOL_VERSION);
        assert_eq!(server.expect("server accepts"), Peer { pid: 4242 });
        client.expect("client is welcome");
    }

    /// A client with another token is refused - and since the client checks
    /// the server first, it is also the client that stops: neither side
    /// learns anything that would help it next time.
    #[test]
    fn another_token_fails_both_ways() {
        let (server, client) = run(
            Token::generate().expect("token"),
            Token::generate().expect("token"),
            PROTOCOL_VERSION,
        );
        assert!(matches!(client, Err(AuthError::BadProof)), "{client:?}");
        // The client hung up without a proof.
        assert!(matches!(server, Err(AuthError::Frame(_))), "{server:?}");
    }

    /// A client that knows the token but a server that does not (a process
    /// squatting on the endpoint): the client never sends its proof.
    #[test]
    fn a_squatter_gets_no_proof() {
        let ((mut sr, mut sw), (mut cr, mut cw)) = duplex();
        let token = Token::generate().expect("token");
        let squatter = std::thread::spawn(move || {
            let hello: Handshake = read_frame(&mut sr, MAX_HANDSHAKE_FRAME).expect("hello");
            let Handshake::ClientHello { .. } = hello else {
                panic!("{hello:?}");
            };
            write_frame(
                &mut sw,
                &Handshake::ServerHello {
                    protocol: PROTOCOL_VERSION,
                    nonce: hex(&[7; 32]),
                    proof: hex(&[0; 32]),
                },
                MAX_HANDSHAKE_FRAME,
            )
            .expect("write");
            // Whatever comes next is all it gets.
            read_frame::<Handshake>(&mut sr, MAX_HANDSHAKE_FRAME)
        });
        let result = client_handshake(&mut cr, &mut cw, &token, 1);
        assert!(matches!(result, Err(AuthError::BadProof)));
        drop((cr, cw));
        assert!(matches!(
            squatter.join().expect("thread"),
            Err(FrameError::Closed)
        ));
    }

    #[test]
    fn another_version_is_refused_with_a_reason() {
        let token = Token::generate().expect("token");
        let (server, client) = run(token.clone(), token, PROTOCOL_VERSION + 1);
        assert!(matches!(
            server,
            Err(AuthError::Version {
                ours: PROTOCOL_VERSION,
                ..
            })
        ));
        match client {
            Err(AuthError::Refused(reason)) => assert!(reason.contains("protocol"), "{reason}"),
            other => panic!("{other:?}"),
        }
    }

    /// Anything else first, or an oversized hello, is refused.
    #[test]
    fn garbage_first_is_refused() {
        let ((mut sr, mut sw), (mut cr, mut cw)) = duplex();
        let token = Token::generate().expect("token");
        let server = std::thread::spawn(move || server_handshake(&mut sr, &mut sw, &token));
        write_frame(
            &mut cw,
            &Handshake::ClientProof { proof: "00".into() },
            MAX_HANDSHAKE_FRAME,
        )
        .expect("write");
        let answer: Handshake = read_frame(&mut cr, MAX_HANDSHAKE_FRAME).expect("answer");
        assert!(matches!(answer, Handshake::Refused { .. }));
        assert!(matches!(
            server.join().expect("thread"),
            Err(AuthError::Unexpected(_))
        ));

        let ((mut sr, mut sw), (_cr, mut cw)) = duplex();
        let token = Token::generate().expect("token");
        let server = std::thread::spawn(move || server_handshake(&mut sr, &mut sw, &token));
        cw.write_all(&(MAX_HANDSHAKE_FRAME + 1).to_be_bytes())
            .expect("write");
        assert!(matches!(
            server.join().expect("thread"),
            Err(AuthError::Frame(FrameError::Size { .. }))
        ));
    }
}

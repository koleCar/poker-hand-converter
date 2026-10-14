#![forbid(unsafe_code)]
//! The channel between the app and the HUD process (docs/RAIL-PLAN.md §3.2,
//! R3.2), used by both sides.
//!
//! - [`protocol`]: the messages, both directions, versioned
//!   ([`PROTOCOL_VERSION`]); an unknown message type is read as `Unknown`
//!   and ignored, so a newer peer's additions do not break an older one.
//! - [`frame`]: length-prefixed JSON - a 4-byte big-endian length, then the
//!   message - with a size limit ([`MAX_FRAME`]; [`MAX_HANDSHAKE_FRAME`]
//!   until the peer has proven itself).
//! - [`auth`]: a random [`auth::Token`] per HUD process, handed to it on its
//!   standard input (never on the command line, which other users can read,
//!   nor in the environment), and a mutual challenge-response handshake
//!   (HMAC-SHA256 over both sides' nonces): the HUD proves it was started by
//!   this app, and the app proves it is the app that started the HUD.
//! - [`transport`]: a Unix domain socket in a fresh `0700` folder, the
//!   socket itself `0600` (macOS, Linux), or a named pipe whose DACL lets in
//!   only its owner and SYSTEM, local clients only, first instance only
//!   (Windows). Other users cannot connect at all; other processes of the
//!   same user can, and fail the handshake.
//! - [`link`]: a connection as two threads - one reads, one writes from a
//!   bounded queue - so a send never blocks the caller: the app never waits
//!   for the HUD, and a full queue drops the message and tells the HUD to
//!   [`protocol::AppMessage::Resync`].
//! - [`supervisor`]: the app's side - start the HUD (a Tauri sidecar: the
//!   binary next to the app's own), hand it its token, accept its
//!   connection, check its health, restart it with a backoff when it dies or
//!   stops answering, and shut it down on exit.
//! - [`client`]: the HUD's side - read the token, connect, authenticate.

pub mod auth;
pub mod client;
pub mod frame;
pub mod link;
pub mod protocol;
pub mod supervisor;
pub mod transport;

pub use protocol::{AppMessage, HudMessage, PlayerRef};

/// The protocol this build speaks. Both ends ship together (the HUD is the
/// app's sidecar), so a mismatch is a broken install: the handshake refuses
/// it and says which versions met.
pub const PROTOCOL_VERSION: u32 = 1;

/// The largest message after the handshake: 1 MiB (a `policy` message
/// carries a whole `sites.json`, ~35 KB today; a hand is a few hundred
/// bytes).
pub const MAX_FRAME: u32 = 1 << 20;

/// The largest message during the handshake, before the peer has proven
/// it knows the token: an unauthenticated peer cannot make either side
/// allocate more than this.
pub const MAX_HANDSHAKE_FRAME: u32 = 1024;

/// The name of the argument that gives the HUD the endpoint to connect to.
pub const ENDPOINT_ARG: &str = "--ipc";

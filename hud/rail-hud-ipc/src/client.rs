//! The HUD's side: read the token the app wrote on standard input, connect
//! to the endpoint it was given, authenticate.

use std::io::{self, BufRead};
use std::time::Duration;

use crate::auth::{AuthError, Token, client_handshake};
use crate::transport::{Connection, connect};

/// How long the handshake may take before the HUD gives up.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The first line of `input`: the token. The rest of `input` stays open -
/// its end is how the HUD learns that the app is gone.
pub fn read_token(input: &mut impl BufRead) -> io::Result<Token> {
    let mut line = String::new();
    // A token line is 65 bytes; refuse to read an unbounded line.
    let read = io::Read::take(&mut *input, 256).read_line(&mut line)?;
    if read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "no token on standard input (the HUD is started by the app)",
        ));
    }
    Token::from_hex(&line).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not a token"))
}

/// Why the HUD could not join the app.
#[derive(Debug)]
pub enum ConnectError {
    Io(io::Error),
    Auth(AuthError),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Auth(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ConnectError {}

/// Connect to `endpoint` and run the handshake; the connection returned is
/// authenticated both ways.
pub fn connect_authenticated(endpoint: &str, token: &Token) -> Result<Connection, ConnectError> {
    let mut conn = connect(endpoint).map_err(ConnectError::Io)?;
    conn.set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(ConnectError::Io)?;
    client_handshake(
        &mut conn.reader,
        &mut conn.writer,
        token,
        std::process::id(),
    )
    .map_err(ConnectError::Auth)?;
    conn.set_read_timeout(None).map_err(ConnectError::Io)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_the_first_line_only() {
        let token = Token::generate().expect("token");
        let text = format!("{}\nrest stays\n", token.to_hex());
        let mut input = io::Cursor::new(text.into_bytes());
        assert_eq!(read_token(&mut input).expect("token"), token);
        let mut rest = String::new();
        input.read_line(&mut rest).expect("rest");
        assert_eq!(rest, "rest stays\n");
        assert!(read_token(&mut io::Cursor::new(Vec::new())).is_err());
        assert!(read_token(&mut io::Cursor::new(b"nope\n".to_vec())).is_err());
        assert!(read_token(&mut io::Cursor::new(vec![b'a'; 10_000])).is_err());
    }
}

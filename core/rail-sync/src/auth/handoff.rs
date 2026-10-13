//! The desktop sign-in handoff (docs/RAIL-PLAN.md R1.7, amendment A6).
//!
//! The app cannot sign in by itself: email + password needs Turnstile, which
//! is bound to the web domain. So the user signs in on the web, in their own
//! browser, and the web hands the app a credential through a `rail://` deep
//! link. A deep link is not a private channel - any program on the machine
//! can register the `rail` scheme and receive it - so what travels in it must
//! be useless to anyone but the app instance that asked for it.
//!
//! The protocol, `rail-desktop-handoff/1`:
//!
//! 1. The app makes a [`PendingSignIn`]: a fresh X25519 key pair and a random
//!    `state`, kept in memory only, for [`FLOW_TTL`]. It opens
//!    `<web>/auth/desktop?v=1&pub=<public key>&state=<state>&t=<unix time>`
//!    in the system browser.
//! 2. The web page makes sure the user is signed in (Turnstile, password
//!    managers, Google all work there), asks "Sign in to Rail on this
//!    computer?" and, on the click, calls the Edge Function
//!    `desktop-handoff` with the user's JWT, `pub` and `state`.
//! 3. The function mints a one-time magic-link token for that user and
//!    encrypts it to `pub` (ephemeral X25519, HKDF-SHA-256, AES-256-GCM with
//!    `state` as associated data) - see [`Sealed payload`](#payload). Only
//!    the ciphertext leaves the function.
//! 4. The page redirects to `rail://auth/callback?state=..&payload=..`.
//! 5. The app takes its pending sign-in **out** (one callback per sign-in,
//!    whatever its outcome), checks `state`, decrypts, and redeems the token
//!    at GoTrue's `/verify`, which returns a session of the app's own: its
//!    own refresh-token chain, independent of the browser's.
//!
//! # Payload
//!
//! `base64url(1 || epk[32] || nonce[12] || ciphertext || tag[16])`, where
//! `epk` is the function's ephemeral X25519 public key, the AES-256-GCM key
//! is `HKDF-SHA-256(ikm = X25519(epk, app), salt = epk || app_pub, info =
//! "rail-desktop-handoff/1")`, and the associated data is
//! `"rail-desktop-handoff/1\n" + state`. The plaintext is JSON:
//! `{"v":1,"type":"magiclink","tokenHash":..,"userId":..,"email":..}`.
//! The Deno side is `supabase/functions/desktop-handoff/handoff.ts`; the
//! test vector in its `testdata/` is checked by both.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::hkdf::{HKDF_SHA256, Salt};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use url::Url;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

use super::secret::Secret;

/// The protocol's name: HKDF info, and the prefix of the associated data.
pub const PROTOCOL: &str = "rail-desktop-handoff/1";

/// The deep-link scheme the app registers.
pub const SCHEME: &str = "rail";

/// Where the web sends the browser at the end: `rail://auth/callback`.
pub const CALLBACK_HOST: &str = "auth";
pub const CALLBACK_PATH: &str = "/callback";

/// How long a sign-in waits for its callback. The key pair lives that long
/// and no longer; the web page refuses a request older than this too (same
/// machine, same clock: the `t` parameter).
pub const FLOW_TTL: Duration = Duration::from_secs(10 * 60);

const PAYLOAD_VERSION: u8 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// A real payload is ~300 characters; anything far larger is not ours.
const MAX_PAYLOAD_CHARS: usize = 4096;
/// `state` and `pub` are 32 bytes each: 43 base64url characters.
const B64_32_LEN: usize = 43;

/// Why a callback or a payload was refused. Never carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffError {
    /// Not a `rail://auth/callback` URL at all.
    NotACallback,
    /// A callback, but a parameter is missing or has the wrong shape.
    Malformed(&'static str),
    /// The payload did not decrypt: tampered with, for another sign-in, or
    /// not from our function.
    Decrypt,
    /// It decrypted, but the content is not what the function sends.
    Content(&'static str),
    /// The system random generator failed (practically never).
    Random,
}

impl std::fmt::Display for HandoffError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotACallback => f.write_str("not a rail://auth/callback link"),
            Self::Malformed(what) => write!(f, "malformed callback: {what}"),
            Self::Decrypt => f.write_str("the sign-in payload did not decrypt"),
            Self::Content(what) => write!(f, "unexpected sign-in payload: {what}"),
            Self::Random => f.write_str("no randomness available"),
        }
    }
}

impl std::error::Error for HandoffError {}

/// One sign-in in progress: the key pair and `state`, in memory only.
pub struct PendingSignIn {
    secret: StaticSecret,
    public: [u8; KEY_LEN],
    state: String,
    started: Instant,
    issued_at_unix: u64,
}

impl std::fmt::Debug for PendingSignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `state` is not secret (it is in the browser's address bar), the
        // private key is.
        f.debug_struct("PendingSignIn")
            .field("state", &self.state)
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

impl PendingSignIn {
    /// A fresh key pair and state from the system's random generator.
    pub fn new() -> Result<Self, HandoffError> {
        let rng = SystemRandom::new();
        let mut secret = [0u8; KEY_LEN];
        let mut state = [0u8; KEY_LEN];
        rng.fill(&mut secret).map_err(|_| HandoffError::Random)?;
        rng.fill(&mut state).map_err(|_| HandoffError::Random)?;
        let issued_at_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let pending = Self::from_parts(secret, state, Instant::now(), issued_at_unix);
        secret.zeroize();
        Ok(pending)
    }

    /// From given bytes: the test vectors, and tests with a clock.
    #[doc(hidden)]
    pub fn from_parts(
        secret: [u8; KEY_LEN],
        state: [u8; KEY_LEN],
        started: Instant,
        issued_at_unix: u64,
    ) -> Self {
        let secret = StaticSecret::from(secret);
        let public = PublicKey::from(&secret).to_bytes();
        Self {
            secret,
            public,
            state: URL_SAFE_NO_PAD.encode(state),
            started,
            issued_at_unix,
        }
    }

    /// The `state` the callback must carry back.
    pub fn state(&self) -> &str {
        &self.state
    }

    /// The public key, base64url: the `pub` parameter.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public)
    }

    /// When this sign-in stops waiting.
    pub fn deadline(&self) -> Instant {
        self.started + FLOW_TTL
    }

    pub fn is_expired(&self, now: Instant) -> bool {
        now >= self.deadline()
    }

    /// The page to open in the browser: `<web>/auth/desktop?v=1&pub=..&state=..&t=..`.
    pub fn authorize_url(&self, web: &Url) -> Url {
        let mut url = web.clone();
        url.set_path("/auth/desktop");
        url.set_fragment(None);
        url.query_pairs_mut()
            .clear()
            .append_pair("v", "1")
            .append_pair("pub", &self.public_key())
            .append_pair("state", &self.state)
            .append_pair("t", &self.issued_at_unix.to_string());
        url
    }

    /// Decrypt a payload sealed to this sign-in's key and `state`.
    pub fn open(&self, payload: &str) -> Result<Handoff, HandoffError> {
        if payload.len() > MAX_PAYLOAD_CHARS {
            return Err(HandoffError::Malformed("payload too long"));
        }
        let bytes = decode_b64(payload).ok_or(HandoffError::Malformed("payload encoding"))?;
        let min = 1 + KEY_LEN + NONCE_LEN + TAG_LEN;
        if bytes.len() < min || bytes[0] != PAYLOAD_VERSION {
            return Err(HandoffError::Malformed("payload version or length"));
        }
        let mut epk = [0u8; KEY_LEN];
        epk.copy_from_slice(&bytes[1..=KEY_LEN]);
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&bytes[1 + KEY_LEN..1 + KEY_LEN + NONCE_LEN]);
        let mut sealed = bytes[1 + KEY_LEN + NONCE_LEN..].to_vec();

        let key = derive_key(&self.secret, &epk, &self.public)?;
        let aad = associated_data(&self.state);
        let plain = key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad.as_bytes()),
                &mut sealed,
            )
            .map_err(|_| HandoffError::Decrypt)?;
        let parsed: Result<Plain, HandoffError> = serde_json::from_slice(plain)
            .map_err(|_| HandoffError::Content("not the expected JSON"));
        plain.zeroize();
        let parsed = parsed?;
        parsed.validate()
    }
}

/// What the function handed over: a one-time token hash for GoTrue's
/// `/verify`, and whom it is for (checked against the session it returns).
#[derive(Debug)]
pub struct Handoff {
    pub token_hash: Secret,
    pub user_id: String,
    pub email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plain {
    v: u8,
    #[serde(rename = "type")]
    kind: String,
    token_hash: String,
    user_id: String,
    email: String,
}

impl Plain {
    fn validate(self) -> Result<Handoff, HandoffError> {
        if self.v != 1 {
            return Err(HandoffError::Content("version"));
        }
        if self.kind != "magiclink" {
            return Err(HandoffError::Content("token type"));
        }
        let printable = |s: &str| s.bytes().all(|b| b.is_ascii_graphic());
        if self.token_hash.is_empty() || self.token_hash.len() > 512 || !printable(&self.token_hash)
        {
            return Err(HandoffError::Content("token hash"));
        }
        if self.user_id.len() != 36 || !printable(&self.user_id) {
            return Err(HandoffError::Content("user id"));
        }
        if self.email.is_empty() || self.email.len() > 320 {
            return Err(HandoffError::Content("email"));
        }
        Ok(Handoff {
            token_hash: Secret::new(self.token_hash.clone()),
            user_id: self.user_id.clone(),
            email: self.email.clone(),
        })
    }
}

impl Drop for Plain {
    fn drop(&mut self) {
        self.token_hash.zeroize();
    }
}

/// A `rail://auth/callback` link, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Callback {
    /// The web handed over a payload for the sign-in with this `state`.
    Payload { state: String, payload: String },
    /// The user cancelled in the browser, or the web gave up: `reason` is a
    /// short code (`cancelled`, ...), shown as a notice, never trusted.
    Refused { state: String, reason: String },
}

impl Callback {
    pub fn state(&self) -> &str {
        match self {
            Self::Payload { state, .. } | Self::Refused { state, .. } => state,
        }
    }
}

/// Parse a deep link. Anything that is not exactly
/// `rail://auth/callback?state=<43>&(payload=..|error=<code>)` is refused.
pub fn parse_callback(link: &str) -> Result<Callback, HandoffError> {
    let url = Url::parse(link.trim()).map_err(|_| HandoffError::NotACallback)?;
    if url.scheme() != SCHEME
        || url.host_str() != Some(CALLBACK_HOST)
        || url.path().trim_end_matches('/') != CALLBACK_PATH
    {
        return Err(HandoffError::NotACallback);
    }
    let mut state = None;
    let mut payload = None;
    let mut error = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "state" => &mut state,
            "payload" => &mut payload,
            "error" => &mut error,
            _ => continue,
        };
        if slot.is_some() {
            return Err(HandoffError::Malformed("repeated parameter"));
        }
        *slot = Some(value.into_owned());
    }
    let state = state.ok_or(HandoffError::Malformed("no state"))?;
    if !is_b64_32(&state) {
        return Err(HandoffError::Malformed("state"));
    }
    match (payload, error) {
        (Some(payload), None) => Ok(Callback::Payload { state, payload }),
        (None, Some(reason)) => {
            let ok = !reason.is_empty()
                && reason.len() <= 40
                && reason
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'-');
            if !ok {
                return Err(HandoffError::Malformed("error code"));
            }
            Ok(Callback::Refused { state, reason })
        }
        _ => Err(HandoffError::Malformed(
            "needs exactly one of payload, error",
        )),
    }
}

fn is_b64_32(value: &str) -> bool {
    value.len() == B64_32_LEN && decode_b64(value).is_some_and(|bytes| bytes.len() == KEY_LEN)
}

/// Strict base64url without padding (the engine refuses padding and
/// non-canonical trailing bits).
fn decode_b64(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value).ok()
}

fn associated_data(state: &str) -> String {
    format!("{PROTOCOL}\n{state}")
}

fn derive_key(
    secret: &StaticSecret,
    epk: &[u8; KEY_LEN],
    app_public: &[u8; KEY_LEN],
) -> Result<LessSafeKey, HandoffError> {
    let shared = secret.diffie_hellman(&PublicKey::from(*epk));
    // A low-order point gives an all-zero secret that anyone can compute.
    if !shared.was_contributory() {
        return Err(HandoffError::Decrypt);
    }
    let mut salt_bytes = [0u8; 2 * KEY_LEN];
    salt_bytes[..KEY_LEN].copy_from_slice(epk);
    salt_bytes[KEY_LEN..].copy_from_slice(app_public);
    let prk = Salt::new(HKDF_SHA256, &salt_bytes).extract(shared.as_bytes());
    let info = [PROTOCOL.as_bytes()];
    let okm = prk
        .expand(&info, &AES_256_GCM)
        .map_err(|_| HandoffError::Decrypt)?;
    let key = UnboundKey::from(okm);
    Ok(LessSafeKey::new(key))
}

/// The function's side, for tests: seal `plain` to `app_public` / `state`.
#[cfg(test)]
pub(crate) fn seal(
    app_public: &[u8; KEY_LEN],
    state: &str,
    plain: &[u8],
    ephemeral: [u8; KEY_LEN],
    nonce: [u8; NONCE_LEN],
) -> String {
    let eph = StaticSecret::from(ephemeral);
    let epk = PublicKey::from(&eph).to_bytes();
    // `derive_key` with the roles swapped gives the same key: X25519 is
    // symmetric, salt and info do not depend on who computes them.
    let shared = eph.diffie_hellman(&PublicKey::from(*app_public));
    let mut salt_bytes = [0u8; 2 * KEY_LEN];
    salt_bytes[..KEY_LEN].copy_from_slice(&epk);
    salt_bytes[KEY_LEN..].copy_from_slice(app_public);
    let prk = Salt::new(HKDF_SHA256, &salt_bytes).extract(shared.as_bytes());
    let info = [PROTOCOL.as_bytes()];
    let okm = prk.expand(&info, &AES_256_GCM).expect("hkdf");
    let key = LessSafeKey::new(UnboundKey::from(okm));
    let mut buffer = plain.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(associated_data(state).as_bytes()),
        &mut buffer,
    )
    .expect("seal");
    let mut out = vec![PAYLOAD_VERSION];
    out.extend_from_slice(&epk);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buffer);
    URL_SAFE_NO_PAD.encode(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const PLAIN: &str = r#"{"v":1,"type":"magiclink","tokenHash":"0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4","userId":"00000000-0000-0000-0000-0000000a0a01","email":"player@example.test"}"#;

    fn pending() -> PendingSignIn {
        PendingSignIn::from_parts([7; 32], [9; 32], Instant::now(), 1_790_000_000)
    }

    fn public_of(p: &PendingSignIn) -> [u8; 32] {
        decode_b64(&p.public_key()).unwrap().try_into().unwrap()
    }

    #[test]
    fn a_sealed_payload_opens_with_the_right_key_and_state() {
        let p = pending();
        let payload = seal(
            &public_of(&p),
            p.state(),
            PLAIN.as_bytes(),
            [3; 32],
            [5; 12],
        );
        let handoff = p.open(&payload).unwrap();
        assert_eq!(handoff.user_id, "00000000-0000-0000-0000-0000000a0a01");
        assert_eq!(handoff.email, "player@example.test");
        assert_eq!(handoff.token_hash.expose().len(), 56);
    }

    #[test]
    fn another_sign_ins_key_or_state_does_not_open_it() {
        let p = pending();
        let other_key = PendingSignIn::from_parts([8; 32], [9; 32], Instant::now(), 0);
        let other_state = PendingSignIn::from_parts([7; 32], [10; 32], Instant::now(), 0);
        let payload = seal(
            &public_of(&p),
            p.state(),
            PLAIN.as_bytes(),
            [3; 32],
            [5; 12],
        );
        assert_eq!(other_key.open(&payload).unwrap_err(), HandoffError::Decrypt);
        assert_eq!(
            other_state.open(&payload).unwrap_err(),
            HandoffError::Decrypt
        );
        // Sealed to the right key but bound to another state.
        let wrong_state = seal(
            &public_of(&p),
            other_state.state(),
            PLAIN.as_bytes(),
            [3; 32],
            [5; 12],
        );
        assert_eq!(p.open(&wrong_state).unwrap_err(), HandoffError::Decrypt);
    }

    #[test]
    fn any_flipped_bit_is_refused() {
        let p = pending();
        let payload = seal(
            &public_of(&p),
            p.state(),
            PLAIN.as_bytes(),
            [3; 32],
            [5; 12],
        );
        let bytes = decode_b64(&payload).unwrap();
        for index in 1..bytes.len() {
            let mut tampered = bytes.clone();
            tampered[index] ^= 0x01;
            let err = p.open(&URL_SAFE_NO_PAD.encode(&tampered)).unwrap_err();
            assert!(
                matches!(err, HandoffError::Decrypt),
                "byte {index}: {err:?}"
            );
        }
        let mut version = bytes;
        version[0] = 2;
        assert!(matches!(
            p.open(&URL_SAFE_NO_PAD.encode(&version)),
            Err(HandoffError::Malformed(_))
        ));
    }

    #[test]
    fn a_low_order_ephemeral_key_is_refused() {
        let p = pending();
        // The all-zero point: X25519 with it is zero for every key.
        let mut bytes = vec![PAYLOAD_VERSION];
        bytes.extend_from_slice(&[0; 32]);
        bytes.extend_from_slice(&[0; 12 + 40]);
        assert_eq!(
            p.open(&URL_SAFE_NO_PAD.encode(bytes)).unwrap_err(),
            HandoffError::Decrypt
        );
    }

    #[test]
    fn content_is_checked_after_decryption() {
        let p = pending();
        let open = |plain: &str| {
            let payload = seal(
                &public_of(&p),
                p.state(),
                plain.as_bytes(),
                [3; 32],
                [5; 12],
            );
            p.open(&payload)
        };
        let wrong_type = PLAIN.replace("magiclink", "recovery");
        assert_eq!(
            open(&wrong_type).unwrap_err(),
            HandoffError::Content("token type")
        );
        let extra = PLAIN.replace("{\"v\":1,", "{\"v\":1,\"accessToken\":\"x\",");
        assert!(matches!(
            open(&extra).unwrap_err(),
            HandoffError::Content(_)
        ));
        assert!(matches!(
            open("not json").unwrap_err(),
            HandoffError::Content(_)
        ));
    }

    #[test]
    fn the_authorize_url_carries_key_state_and_time_only() {
        let p = pending();
        let web = Url::parse("https://rail.example/some/page?x=1#frag").unwrap();
        let url = p.authorize_url(&web);
        assert_eq!(url.path(), "/auth/desktop");
        assert_eq!(url.fragment(), None);
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["v", "pub", "state", "t"]);
        assert_eq!(pairs[1].1, p.public_key());
        assert_eq!(pairs[1].1.len(), 43);
        assert_eq!(pairs[2].1, p.state());
        assert_eq!(pairs[3].1, "1790000000");
    }

    #[test]
    fn a_sign_in_expires_after_ten_minutes() {
        let start = Instant::now();
        let p = PendingSignIn::from_parts([7; 32], [9; 32], start, 0);
        assert!(!p.is_expired(start + Duration::from_secs(599)));
        assert!(p.is_expired(start + FLOW_TTL));
    }

    #[test]
    fn fresh_sign_ins_differ() {
        let a = PendingSignIn::new().unwrap();
        let b = PendingSignIn::new().unwrap();
        assert_ne!(a.state(), b.state());
        assert_ne!(a.public_key(), b.public_key());
    }

    #[test]
    fn callbacks_parse_strictly() {
        let state = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
        assert_eq!(
            parse_callback(&format!("rail://auth/callback?state={state}&payload=abc")).unwrap(),
            Callback::Payload {
                state: state.into(),
                payload: "abc".into()
            }
        );
        assert_eq!(
            parse_callback(&format!(
                "rail://auth/callback/?error=cancelled&state={state}"
            ))
            .unwrap(),
            Callback::Refused {
                state: state.into(),
                reason: "cancelled".into()
            }
        );
        for bad in [
            "https://auth/callback?state=x&payload=y".to_owned(),
            format!("rail://evil/callback?state={state}&payload=y"),
            format!("rail://auth/other?state={state}&payload=y"),
            "rail://auth/callback?payload=y".to_owned(),
            "rail://auth/callback?state=short&payload=y".to_owned(),
            format!("rail://auth/callback?state={state}"),
            format!("rail://auth/callback?state={state}&payload=a&error=cancelled"),
            format!("rail://auth/callback?state={state}&state={state}&payload=a"),
            format!("rail://auth/callback?state={state}&error=%3Cscript%3E"),
            "not a url".to_owned(),
        ] {
            assert!(parse_callback(&bad).is_err(), "{bad}");
        }
    }

    /// The cross-language vector: sealed by the Deno function's code
    /// (`handoff.ts`, fixed keys and nonce), opened here.
    #[test]
    fn the_functions_test_vector_opens() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Vector {
            app_secret: String,
            app_public: String,
            ephemeral_secret: String,
            nonce: String,
            state: String,
            payload: String,
            plaintext: String,
        }
        let vector: Vector = serde_json::from_str(include_str!(
            "../../../../supabase/functions/desktop-handoff/testdata/vector.json"
        ))
        .unwrap();
        let secret: [u8; 32] = decode_b64(&vector.app_secret).unwrap().try_into().unwrap();
        let state: [u8; 32] = decode_b64(&vector.state).unwrap().try_into().unwrap();
        let p = PendingSignIn::from_parts(secret, state, Instant::now(), 0);
        assert_eq!(p.public_key(), vector.app_public);
        assert_eq!(p.state(), vector.state);
        let handoff = p.open(&vector.payload).unwrap();
        let plain: serde_json::Value = serde_json::from_str(&vector.plaintext).unwrap();
        assert_eq!(handoff.token_hash.expose(), plain["tokenHash"]);
        assert_eq!(handoff.user_id, plain["userId"]);
        assert_eq!(handoff.email, plain["email"]);
        // And Rust seals the same bytes from the same inputs.
        let eph: [u8; 32] = decode_b64(&vector.ephemeral_secret)
            .unwrap()
            .try_into()
            .unwrap();
        let nonce: [u8; 12] = decode_b64(&vector.nonce).unwrap().try_into().unwrap();
        assert_eq!(
            seal(
                &public_of(&p),
                p.state(),
                vector.plaintext.as_bytes(),
                eph,
                nonce
            ),
            vector.payload
        );
    }
}

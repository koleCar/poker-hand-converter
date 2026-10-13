/**
 * `rail-desktop-handoff/1`: the payload the web hands to the desktop app
 * through a `rail://` deep link (docs/RAIL-PLAN.md R1.7, amendment A6).
 *
 * A deep link is not a private channel: any program on the machine can
 * register the `rail` scheme. So the one-time token in it is encrypted to a
 * key pair the app made for this one sign-in and keeps in memory only, and
 * bound to the sign-in's `state`:
 *
 *   payload = base64url(1 || epk[32] || nonce[12] || ciphertext || tag[16])
 *   key     = HKDF-SHA-256(ikm = X25519(eph, app), salt = epk || app_pub,
 *                          info = "rail-desktop-handoff/1"), AES-256-GCM
 *   aad     = "rail-desktop-handoff/1\n" + state
 *
 * The app's side is `core/rail-sync/src/auth/handoff.rs`; `testdata/vector.json`
 * is checked by both (`handoff_test.ts`, and the Rust test
 * `the_functions_test_vector_opens`).
 *
 * WebCrypto only: no third-party code on the path that handles a session
 * credential.
 */

export const PROTOCOL = "rail-desktop-handoff/1";

/** What the app decrypts. Field order is the wire order (JSON.stringify). */
export interface HandoffPlain {
  v: 1;
  type: "magiclink";
  tokenHash: string;
  userId: string;
  email: string;
}

/** The request the web page sends. */
export interface HandoffRequest {
  /** The app's X25519 public key, 32 bytes. */
  appPublic: Uint8Array;
  /** The sign-in's state, base64url of 32 bytes (kept as text: it is the AAD). */
  state: string;
}

const B64_32 = /^[A-Za-z0-9_-]{43}$/;

export function encodeB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Strict: base64url, no padding, canonical (re-encodes to the same text). */
export function decodeB64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return encodeB64Url(bytes) === text ? bytes : null;
}

/**
 * Validate the page's JSON body: `{ v: 1, pub, state }`, nothing else.
 * Returns null for anything else; the caller answers `invalid_request`.
 */
export function parseRequest(body: unknown): HandoffRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "pub,state,v") return null;
  if (record.v !== 1) return null;
  const { pub, state } = record;
  if (typeof pub !== "string" || typeof state !== "string") return null;
  if (!B64_32.test(pub) || !B64_32.test(state)) return null;
  const appPublic = decodeB64Url(pub);
  const stateBytes = decodeB64Url(state);
  if (!appPublic || appPublic.length !== 32 || !stateBytes || stateBytes.length !== 32) return null;
  return { appPublic, state };
}

/** Fixed inputs for the test vector; never passed in production. */
export interface SealOptions {
  ephemeral?: CryptoKeyPair;
  nonce?: Uint8Array;
}

/** Encrypt `plain` to the app's key, bound to `state`. */
export async function seal(
  appPublic: Uint8Array,
  state: string,
  plain: HandoffPlain,
  options: SealOptions = {},
): Promise<string> {
  const appKey = await crypto.subtle.importKey("raw", appPublic as BufferSource, { name: "X25519" }, false, []);
  const ephemeral = options.ephemeral ??
    ((await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair);
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  // WebCrypto throws on an all-zero result (a low-order app key).
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: appKey }, ephemeral.privateKey, 256);
  const key = await deriveAesKey(new Uint8Array(shared), epk, appPublic, ["encrypt"]);
  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(plain));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: associatedData(state), tagLength: 128 },
      key,
      data,
    ),
  );
  data.fill(0);
  const out = new Uint8Array(1 + 32 + 12 + sealed.length);
  out[0] = 1;
  out.set(epk, 1);
  out.set(nonce, 33);
  out.set(sealed, 45);
  return encodeB64Url(out);
}

/**
 * The app's side, in TypeScript: for the tests (and the local end-to-end
 * script). The app itself does this in Rust.
 */
export async function open(
  appPrivate: CryptoKey,
  appPublic: Uint8Array,
  state: string,
  payload: string,
): Promise<HandoffPlain> {
  const bytes = decodeB64Url(payload);
  if (!bytes || bytes.length < 1 + 32 + 12 + 16 || bytes[0] !== 1) throw new Error("malformed payload");
  const epk = bytes.slice(1, 33);
  const nonce = bytes.slice(33, 45);
  const peer = await crypto.subtle.importKey("raw", epk as BufferSource, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, appPrivate, 256);
  const key = await deriveAesKey(new Uint8Array(shared), epk, appPublic, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: associatedData(state), tagLength: 128 },
    key,
    bytes.slice(45) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as HandoffPlain;
}

function associatedData(state: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${PROTOCOL}\n${state}`);
}

async function deriveAesKey(
  shared: Uint8Array,
  epk: Uint8Array,
  appPublic: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(appPublic, 32);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(PROTOCOL) },
    ikm,
    256,
  );
  shared.fill(0);
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, usages);
}

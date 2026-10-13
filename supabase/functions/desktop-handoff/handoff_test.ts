/**
 * `deno test supabase/functions/` - the payload format (`handoff.ts`).
 * No network, no permissions beyond reading `testdata/`.
 */

import { decodeB64Url, encodeB64Url, type HandoffPlain, open, parseRequest, seal } from "./handoff.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
}

async function rejects(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error("expected a rejection");
}

const PLAIN: HandoffPlain = {
  v: 1,
  type: "magiclink",
  tokenHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4",
  userId: "00000000-0000-0000-0000-0000000a0a01",
  email: "player@example.test",
};

async function appKeys(): Promise<{ privateKey: CryptoKey; publicBytes: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicBytes: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

const STATE = encodeB64Url(new Uint8Array(32).fill(9));

Deno.test("a payload opens with the app's key and state", async () => {
  const app = await appKeys();
  const payload = await seal(app.publicBytes, STATE, PLAIN);
  assertEquals(await open(app.privateKey, app.publicBytes, STATE, payload), PLAIN);
});

Deno.test("each payload is different (fresh ephemeral key and nonce)", async () => {
  const app = await appKeys();
  const a = await seal(app.publicBytes, STATE, PLAIN);
  const b = await seal(app.publicBytes, STATE, PLAIN);
  assert(a !== b);
});

Deno.test("another key or another state does not open it", async () => {
  const app = await appKeys();
  const other = await appKeys();
  const payload = await seal(app.publicBytes, STATE, PLAIN);
  await rejects(open(other.privateKey, other.publicBytes, STATE, payload));
  await rejects(open(app.privateKey, app.publicBytes, encodeB64Url(new Uint8Array(32).fill(1)), payload));
});

Deno.test("a flipped bit is refused", async () => {
  const app = await appKeys();
  const bytes = decodeB64Url(await seal(app.publicBytes, STATE, PLAIN))!;
  for (const index of [1, 20, 33, 44, 45, bytes.length - 1]) {
    const tampered = bytes.slice();
    tampered[index] ^= 1;
    await rejects(open(app.privateKey, app.publicBytes, STATE, encodeB64Url(tampered)));
  }
});

Deno.test("a low-order app key is refused", async () => {
  await rejects(seal(new Uint8Array(32), STATE, PLAIN));
});

Deno.test("the request is validated strictly", () => {
  const pub = encodeB64Url(new Uint8Array(32).fill(4));
  assert(parseRequest({ v: 1, pub, state: STATE }) !== null);
  for (
    const bad of [
      null,
      [],
      "x",
      { v: 2, pub, state: STATE },
      { v: 1, pub },
      { v: 1, pub, state: STATE, email: "x@example.test" },
      { v: 1, pub: pub.slice(1), state: STATE },
      { v: 1, pub: pub + "A", state: STATE },
      { v: 1, pub: pub.replace(/.$/, "B"), state: STATE }, // non-canonical last character
      { v: 1, pub: "+".repeat(43), state: STATE },
      { v: 1, pub, state: 7 },
    ]
  ) {
    assertEquals(parseRequest(bad), null, JSON.stringify(bad));
  }
});

Deno.test("base64url round-trips and refuses padding", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  assertEquals(Array.from(decodeB64Url(encodeB64Url(bytes))!), Array.from(bytes));
  assertEquals(decodeB64Url("AAA="), null);
  assertEquals(decodeB64Url("A"), null);
});

Deno.test("the test vector re-seals byte for byte (the Rust side opens it)", async () => {
  const vector = JSON.parse(await Deno.readTextFile(new URL("./testdata/vector.json", import.meta.url)));
  const importPair = async (d: string, x: string): Promise<CryptoKeyPair> => ({
    privateKey: await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", d, x }, { name: "X25519" }, true, [
      "deriveBits",
    ]),
    publicKey: await crypto.subtle.importKey("raw", decodeB64Url(x)! as BufferSource, { name: "X25519" }, true, []),
  });
  const ephemeral = await importPair(vector.ephemeralSecret, vector.ephemeralPublic);
  const app = await importPair(vector.appSecret, vector.appPublic);
  const plain = JSON.parse(vector.plaintext) as HandoffPlain;
  assertEquals(JSON.stringify(plain), vector.plaintext);
  const payload = await seal(decodeB64Url(vector.appPublic)!, vector.state, plain, {
    ephemeral,
    nonce: decodeB64Url(vector.nonce)!,
  });
  assertEquals(payload, vector.payload);
  assertEquals(await open(app.privateKey, decodeB64Url(vector.appPublic)!, vector.state, payload), plain);
});

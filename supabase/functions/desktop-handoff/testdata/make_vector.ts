/**
 * Writes `vector.json`: one payload sealed with fixed keys and a fixed nonce,
 * which `handoff_test.ts` re-seals byte for byte and the Rust side
 * (`core/rail-sync/src/auth/handoff.rs`) opens. Run once; the keys are test
 * keys made here and protect nothing.
 *
 *   deno run --allow-write=supabase/functions/desktop-handoff/testdata \
 *     supabase/functions/desktop-handoff/testdata/make_vector.ts
 */

import { encodeB64Url, type HandoffPlain, seal } from "../handoff.ts";

async function pair(): Promise<{ d: string; x: string; keys: CryptoKeyPair }> {
  const keys = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  return { d: jwk.d!, x: jwk.x!, keys };
}

const app = await pair();
const ephemeral = await pair();
const state = encodeB64Url(crypto.getRandomValues(new Uint8Array(32)));
const nonce = crypto.getRandomValues(new Uint8Array(12));
const plain: HandoffPlain = {
  v: 1,
  type: "magiclink",
  tokenHash: "5c1f3b7e0a9d4c2b8e6f1a3d5b7c9e0f2a4c6e8b0d1f3a5c7e9b2d4f",
  userId: "00000000-0000-0000-0000-0000000a0a01",
  email: "vector@example.test",
};
const appPublic = Uint8Array.from(atob(app.x.replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0));
const payload = await seal(appPublic, state, plain, { ephemeral: ephemeral.keys, nonce });

const vector = {
  comment: "rail-desktop-handoff/1 test vector: test keys, protect nothing. Made by make_vector.ts.",
  appSecret: app.d,
  appPublic: app.x,
  ephemeralSecret: ephemeral.d,
  ephemeralPublic: ephemeral.x,
  state,
  nonce: encodeB64Url(nonce),
  plaintext: JSON.stringify(plain),
  payload,
};
await Deno.writeTextFile(new URL("./vector.json", import.meta.url), JSON.stringify(vector, null, 2) + "\n");
console.log("wrote vector.json");

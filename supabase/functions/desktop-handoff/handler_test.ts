/**
 * `deno test supabase/functions/` - the HTTP side (`handler.ts`) against a
 * fake GoTrue and PostgREST. No network.
 */

import { type Env, handle } from "./handler.ts";
import { encodeB64Url, open } from "./handoff.ts";

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
}

const ENV: Env = { supabaseUrl: "http://supabase.test", anonKey: "anon-key", serviceRoleKey: "service-key" };
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
const USER_ID = "00000000-0000-0000-0000-0000000a0a01";
const STATE = encodeB64Url(new Uint8Array(32).fill(9));

interface Fake {
  user?: Record<string, unknown> | number;
  budget?: number | { status: number; body: unknown };
  minted?: Record<string, unknown> | number;
}

/** A fetch that answers the three upstream calls and records them. */
function fakeFetch(fake: Fake, calls: { url: string; headers: Headers; body: string | null }[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers, body: typeof init?.body === "string" ? init.body : null });
    const reply = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(body === null ? null : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (url.endsWith("/auth/v1/user")) {
      return typeof fake.user === "number" ? reply(fake.user, { msg: "bad jwt" }) : reply(200, fake.user ?? {});
    }
    if (url.endsWith("/rest/v1/rpc/claim_desktop_sign_in")) {
      if (typeof fake.budget === "object") return reply(fake.budget.status, fake.budget.body);
      return reply(fake.budget ?? 204, null);
    }
    if (url.endsWith("/auth/v1/admin/generate_link")) {
      return typeof fake.minted === "number" ? reply(fake.minted, { msg: "nope" }) : reply(200, fake.minted ?? {});
    }
    return reply(404, {});
  }) as typeof fetch;
}

const CONFIRMED = { id: USER_ID, email: "player@example.test", email_confirmed_at: "2026-10-01T10:00:00Z" };
const MINTED = { id: USER_ID, hashed_token: "abc123hashed", verification_type: "magiclink" };

async function appKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicBytes: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

function request(body: unknown, jwt: string | null = JWT, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://functions.test/desktop-handoff", {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

async function call(req: Request, fake: Fake) {
  const calls: { url: string; headers: Headers; body: string | null }[] = [];
  const response = await handle(req, ENV, fakeFetch(fake, calls));
  return { response, body: await response.json().catch(() => null), calls };
}

Deno.test("success: the token is minted for the caller and only ciphertext comes back", async () => {
  const app = await appKeys();
  const { response, body, calls } = await call(
    request({ v: 1, pub: encodeB64Url(app.publicBytes), state: STATE }),
    { user: CONFIRMED, minted: MINTED },
  );
  assertEquals(response.status, 200);
  assertEquals(Object.keys(body).sort(), ["payload", "v"]);
  const text = JSON.stringify(body);
  assertEquals(text.includes("abc123hashed"), false, "the plain token must not be in the response");
  assertEquals(text.includes("player@example.test"), false, "nor the email");
  const plain = await open(app.privateKey, app.publicBytes, STATE, body.payload);
  assertEquals(plain, {
    v: 1,
    type: "magiclink",
    tokenHash: "abc123hashed",
    userId: USER_ID,
    email: "player@example.test",
  });

  // The user check and the budget go out as the user; only generate_link uses the service role.
  assertEquals(calls.map((c) => new URL(c.url).pathname), [
    "/auth/v1/user",
    "/rest/v1/rpc/claim_desktop_sign_in",
    "/auth/v1/admin/generate_link",
  ]);
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${JWT}`);
  assertEquals(calls[1].headers.get("authorization"), `Bearer ${JWT}`);
  assertEquals(calls[1].headers.get("apikey"), "anon-key");
  assertEquals(calls[2].headers.get("authorization"), "Bearer service-key");
  assertEquals(JSON.parse(calls[2].body!), { type: "magiclink", email: "player@example.test" });
});

Deno.test("no bearer token: refused before anything is called", async () => {
  const { response, body, calls } = await call(
    request({ v: 1, pub: encodeB64Url(new Uint8Array(32).fill(4)), state: STATE }, null),
    {},
  );
  assertEquals(response.status, 401);
  assertEquals(body, { error: "not_signed_in" });
  assertEquals(calls.length, 0);
});

Deno.test("an invalid token is refused by GoTrue's answer", async () => {
  const { response, body, calls } = await call(
    request({ v: 1, pub: encodeB64Url(new Uint8Array(32).fill(4)), state: STATE }),
    { user: 401 },
  );
  assertEquals(response.status, 401);
  assertEquals(body, { error: "not_signed_in" });
  assertEquals(calls.length, 1);
});

Deno.test("a malformed request is refused before the user is looked up", async () => {
  for (const bad of ["not json", { v: 1, pub: "x", state: STATE }, { v: 1, state: STATE }, "x".repeat(4000)]) {
    const { response, body, calls } = await call(request(bad), { user: CONFIRMED });
    assertEquals(response.status, 400, JSON.stringify(bad).slice(0, 40));
    assertEquals(body, { error: "invalid_request" });
    assertEquals(calls.length, 0);
  }
});

Deno.test("unconfirmed, anonymous or email-less accounts get no token", async () => {
  const pub = encodeB64Url(new Uint8Array(32).fill(4));
  const cases: [Record<string, unknown>, string][] = [
    [{ ...CONFIRMED, email_confirmed_at: null }, "email_unconfirmed"],
    [{ ...CONFIRMED, is_anonymous: true }, "account_not_supported"],
    [{ id: USER_ID, email: "", email_confirmed_at: "2026-10-01T10:00:00Z" }, "account_not_supported"],
  ];
  for (const [user, error] of cases) {
    const { response, body, calls } = await call(request({ v: 1, pub, state: STATE }), { user, minted: MINTED });
    assertEquals(response.status, 403);
    assertEquals(body, { error });
    assertEquals(calls.length, 1, "nothing after the user lookup");
  }
});

Deno.test("over the budget: 429 and no token minted", async () => {
  const { response, body, calls } = await call(
    request({ v: 1, pub: encodeB64Url(new Uint8Array(32).fill(4)), state: STATE }),
    {
      user: CONFIRMED,
      budget: { status: 400, body: { code: "53400", message: "Write rate limit exceeded" } },
      minted: MINTED,
    },
  );
  assertEquals(response.status, 429);
  assertEquals(body, { error: "rate_limited" });
  assertEquals(calls.length, 2);
});

Deno.test("a token minted for another account is not handed over", async () => {
  const { response, body } = await call(
    request({ v: 1, pub: encodeB64Url(new Uint8Array(32).fill(4)), state: STATE }),
    { user: CONFIRMED, minted: { ...MINTED, id: "00000000-0000-0000-0000-0000000b0b01" } },
  );
  assertEquals(response.status, 503);
  assertEquals(body, { error: "unavailable" });
});

Deno.test("GET is refused; OPTIONS answers the preflight", async () => {
  const get = await call(request(null, JWT, "GET"), {});
  assertEquals(get.response.status, 405);
  const preflight = await handle(new Request("http://functions.test/desktop-handoff", { method: "OPTIONS" }), ENV);
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
});

Deno.test("logs carry no token, email or user id", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const app = await appKeys();
    await call(request({ v: 1, pub: encodeB64Url(app.publicBytes), state: STATE }), {
      user: CONFIRMED,
      minted: MINTED,
    });
    await call(request({ v: 1, pub: encodeB64Url(app.publicBytes), state: STATE }), {
      user: { ...CONFIRMED, email_confirmed_at: null },
    });
  } finally {
    console.log = original;
  }
  const logged = lines.join("\n");
  for (const secret of [JWT, "abc123hashed", "player@example.test", USER_ID, STATE]) {
    assertEquals(logged.includes(secret), false, `logged ${secret}`);
  }
  assertEquals(lines.length, 2);
});

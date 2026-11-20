/**
 * `deno test supabase/functions/` - `feedback` against a fake GoTrue,
 * PostgREST and Storage. No network.
 *
 * Covers: a visitor's report and an account's (the image path, the row);
 * an expired token falling back to a visitor; validation (kind, message,
 * email, image type by its bytes, too many or too large images); the
 * honeypot; the rate limits; an insert failure removing the uploaded images.
 */

import { ACCOUNT_PER_DAY, type Env, handle, MAX_IMAGE_BYTES, sniff, VISITOR_PER_HOUR } from "./handler.ts";

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(condition: unknown, message = ""): void {
  if (!condition) throw new Error(message || "assertion failed");
}

const USER_ID = "00000000-0000-0000-0000-0000000feed1";
const REPORT_ID = "11111111-2222-3333-4444-555555555555";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
const ENV: Env = { supabaseUrl: "http://supabase.test", anonKey: "anon-key", serviceRoleKey: "service-key" };

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));
const JPEG = "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 9, 9));
const TEXT = btoa("not an image at all");

interface World {
  userOk: boolean;
  recent: number;
  insertStatus: number;
  uploads: { name: string; type: string | null; size: number }[];
  deleted: string[][];
  rows: Record<string, unknown>[];
  countFilters: string[];
}

function world(overrides: Partial<World> = {}): World {
  return {
    userOk: true,
    recent: 0,
    insertStatus: 201,
    uploads: [],
    deleted: [],
    rows: [],
    countFilters: [],
    ...overrides,
  };
}

function fakeFetch(w: World): typeof fetch {
  const respond = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.endsWith("/auth/v1/user")) {
      return w.userOk ? Response.json({ id: USER_ID }) : new Response("{}", { status: 401 });
    }
    if (url.includes("/rest/v1/feedback?") && method === "HEAD") {
      assertEquals(headers.get("authorization"), "Bearer service-key", "count with the service role");
      w.countFilters.push(url);
      return new Response(null, { status: 200, headers: { "content-range": `*/${w.recent}` } });
    }
    if (url.endsWith("/rest/v1/feedback") && method === "POST") {
      w.rows.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: w.insertStatus });
    }
    if (url.startsWith("http://supabase.test/storage/v1/object/feedback/") && method === "POST") {
      const body = init?.body as Uint8Array;
      w.uploads.push({
        name: url.slice("http://supabase.test/storage/v1/object/feedback/".length),
        type: headers.get("content-type"),
        size: body.length,
      });
      return Response.json({ Key: "ok" });
    }
    if (url.endsWith("/storage/v1/object/feedback") && method === "DELETE") {
      w.deleted.push(JSON.parse(String(init?.body)).prefixes);
      return Response.json([]);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return ((input: string | URL | Request, init?: RequestInit) => {
    try {
      return Promise.resolve(respond(input, init));
    } catch (error) {
      return Promise.reject(error);
    }
  }) as typeof fetch;
}

function post(body: unknown, token?: string, address = "203.0.113.7"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": address };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://fn.test/feedback", { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(w: World, body: unknown, token?: string) {
  const response = await handle(post(body, token), ENV, fakeFetch(w), () => 1_800_000_000_000, () => REPORT_ID);
  return { status: response.status, body: await response.json() };
}

const BASE = { kind: "bug", message: "The replayer freezes on the river.", source: "web", page: "/library" };

Deno.test("a visitor's report with an image is stored under anon/", async () => {
  const w = world();
  const result = await call(w, { ...BASE, images: [{ data: PNG }], email: "me@example.test" });
  assertEquals(result, { status: 201, body: { id: REPORT_ID } });
  assertEquals(w.uploads, [{ name: `anon/${REPORT_ID}/1.png`, type: "image/png", size: 11 }]);
  assertEquals(w.rows.length, 1);
  const row = w.rows[0];
  assertEquals(row.user_id, null);
  assertEquals(row.email, "me@example.test");
  assertEquals(row.images, [`anon/${REPORT_ID}/1.png`]);
  assert(typeof row.client_hash === "string" && (row.client_hash as string).length === 32, "keyed hash");
  assert(!JSON.stringify(row).includes("203.0.113.7"), "no address in the row");
  assert(w.countFilters[0].includes("user_id=is.null"), "visitors counted per address");
});

Deno.test("an account's report carries the user and its images go under <id>/", async () => {
  const w = world();
  const result = await call(w, { ...BASE, source: "app", images: [{ data: PNG }, { data: JPEG }] }, JWT);
  assertEquals(result.status, 201);
  assertEquals(w.uploads.map((u) => u.name), [`${USER_ID}/${REPORT_ID}/1.png`, `${USER_ID}/${REPORT_ID}/2.jpg`]);
  assertEquals(w.rows[0].user_id, USER_ID);
  assertEquals(w.rows[0].source, "app");
  assert(w.countFilters[0].includes(`user_id=eq.${USER_ID}`), "accounts counted per user");
});

Deno.test("a token GoTrue refuses sends the report as a visitor's", async () => {
  const w = world({ userOk: false });
  const result = await call(w, BASE, JWT);
  assertEquals(result.status, 201);
  assertEquals(w.rows[0].user_id, null);
});

Deno.test("the anon key as bearer is a visitor, without asking GoTrue", async () => {
  const anonKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.YW5vbg";
  const w = world();
  let askedGoTrue = false;
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/auth/v1/user")) askedGoTrue = true;
    return fakeFetch(w)(input, init);
  }) as typeof fetch;
  const response = await handle(post(BASE, anonKey), { ...ENV, anonKey }, fetchFn);
  assertEquals(response.status, 201);
  await response.body?.cancel();
  assertEquals(askedGoTrue, false);
  assertEquals(w.rows[0].user_id, null);
});

Deno.test("invalid reports are refused with a code", async () => {
  const cases: [unknown, number, string][] = [
    [{ ...BASE, kind: "rant" }, 400, "invalid_request"],
    [{ ...BASE, message: "   " }, 400, "invalid_request"],
    [{ ...BASE, message: "x".repeat(4001) }, 400, "invalid_request"],
    [{ ...BASE, email: "not-an-email" }, 400, "invalid_request"],
    [{ ...BASE, source: "cli" }, 400, "invalid_request"],
    [{ ...BASE, images: [{ data: TEXT }] }, 400, "invalid_request"],
    [{ ...BASE, images: [{ data: "%%%" }] }, 400, "invalid_request"],
    [{ ...BASE, images: [{ data: PNG }, { data: PNG }, { data: PNG }, { data: PNG }] }, 413, "too_large"],
    [{ ...BASE, images: [{ data: "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 400) }] }, 413, "too_large"],
    ["just a string", 400, "invalid_request"],
  ];
  for (const [body, status, error] of cases) {
    const w = world();
    const result = await call(w, body);
    assertEquals(result, { status, body: { error } }, JSON.stringify(body).slice(0, 80));
    assertEquals(w.rows.length, 0, "nothing stored");
    assertEquals(w.uploads.length, 0, "nothing uploaded");
  }
});

Deno.test("the honeypot answers success and stores nothing", async () => {
  const w = world();
  const result = await call(w, { ...BASE, website: "http://spam.test" });
  assertEquals(result.status, 201);
  assertEquals(w.rows.length, 0);
  assertEquals(w.countFilters.length, 0);
});

Deno.test("the rate limits", async () => {
  const visitor = world({ recent: VISITOR_PER_HOUR });
  assertEquals(await call(visitor, BASE), { status: 429, body: { error: "rate_limited" } });
  const account = world({ recent: VISITOR_PER_HOUR });
  assertEquals((await call(account, BASE, JWT)).status, 201, "an account has a larger allowance");
  const busy = world({ recent: ACCOUNT_PER_DAY });
  assertEquals(await call(busy, BASE, JWT), { status: 429, body: { error: "rate_limited" } });
});

Deno.test("a failed insert removes the uploaded images", async () => {
  const w = world({ insertStatus: 500 });
  const result = await call(w, { ...BASE, images: [{ data: PNG }] });
  assertEquals(result, { status: 503, body: { error: "unavailable" } });
  assertEquals(w.deleted, [[`anon/${REPORT_ID}/1.png`]]);
});

Deno.test("only POST, and OPTIONS for CORS", async () => {
  const w = world();
  const get = await handle(new Request("http://fn.test/feedback"), ENV, fakeFetch(w));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  const options = await handle(new Request("http://fn.test/feedback", { method: "OPTIONS" }), ENV, fakeFetch(w));
  assertEquals(options.status, 204);
  assertEquals(options.headers.get("access-control-allow-origin"), "*");
});

Deno.test("sniff knows the four types by their bytes", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  assertEquals(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.ext, "png");
  assertEquals(sniff(bytes(0xff, 0xd8, 0xff, 0xdb))?.ext, "jpg");
  assertEquals(sniff(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))?.ext, "gif");
  assertEquals(sniff(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))?.ext, "webp");
  assertEquals(sniff(bytes(0x3c, 0x73, 0x76, 0x67)), null, "SVG is refused");
});

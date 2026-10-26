/**
 * `deno test supabase/functions/` - `account-delete` against a fake GoTrue,
 * PostgREST and Storage that keep the deletion's state the way the database
 * does (`account_deletions`). No network.
 *
 * Covers: the steps in order and each marked; idempotency (a finished step is
 * not run again, a second call after the end is "signed out"); a failure in
 * the middle recorded and resumed by the next call; the time budget (202);
 * the billing step failing closed; the user-side refusals mapped to codes.
 */

import { type Env, handle, STEPS } from "./handler.ts";
import { billingFrom, BillingUnavailable, cancelForDeletion, cancellerFor } from "./billing.ts";

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
}
function assert(condition: unknown, message = ""): void {
  if (!condition) throw new Error(message || "assertion failed");
}

const USER_ID = "00000000-0000-0000-0000-0000000d0e01";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
const ENV: Env = {
  supabaseUrl: "http://supabase.test",
  anonKey: "anon-key",
  serviceRoleKey: "service-key",
  // Replaced per world in `call` (a fake of R6.3's `cancelOwnerSubscriptions`).
  cancelBilling: () => Promise.reject(new Error("no world")),
  timeBudgetMs: 100_000,
  handsBatch: 2,
};

interface World {
  /** The auth user exists. */
  user: boolean;
  /** begin_account_deletion's refusal, if any. */
  beginError?: { status: number; body: unknown };
  /** account_deletions' row. */
  row: { steps: Record<string, string | null>; completedAt: string | null; lastError: string | null } | null;
  billing: { customerId: string | null; subscriptionId: string | null; status: string | null };
  objects: { bucket_id: string; name: string }[];
  hands: number;
  /** Calls that should fail once: "storage", "content", "hands", "auth", "billingHook". */
  failOnce: Set<string>;
  calls: string[];
  billingHookCalls: unknown[];
  /** What R6.3's cancellation answers: done (default), no profile, Stripe not configured. */
  billingCancel?: "ok" | "no_profile" | "not_configured";
}

function world(overrides: Partial<World> = {}): World {
  return {
    user: true,
    row: null,
    billing: { customerId: null, subscriptionId: null, status: null },
    objects: [
      { bucket_id: "hand-uploads", name: `${USER_ID}/up1/a.gz` },
      { bucket_id: "hand-uploads", name: `${USER_ID}/up1/b.gz` },
    ],
    hands: 5,
    failOnce: new Set(),
    calls: [],
    billingHookCalls: [],
    ...overrides,
  };
}

function fakeFetch(w: World): typeof fetch {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const failing = (key: string) => {
    if (w.failOnce.has(key)) {
      w.failOnce.delete(key);
      return true;
    }
    return false;
  };
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : null;
    const path = url.replace(ENV.supabaseUrl, "");
    w.calls.push(`${init?.method ?? "GET"} ${path}`);
    const service = headers.get("authorization") === `Bearer ${ENV.serviceRoleKey}`;

    if (path === "/auth/v1/user") {
      assertEquals(headers.get("authorization"), `Bearer ${JWT}`, "the user is looked up with their own token");
      return w.user ? reply(200, { id: USER_ID }) : reply(403, { msg: "User from sub claim in JWT does not exist" });
    }
    if (path === "/rest/v1/rpc/begin_account_deletion") {
      assert(!service, "the deletion is started as the user, not the service role");
      if (w.beginError) return reply(w.beginError.status, w.beginError.body);
      if (!w.row) w.row = { steps: {}, completedAt: null, lastError: null };
      return reply(200, { steps: w.row.steps });
    }
    assert(service, `${path} is called with the service role`);
    if (path === "/rest/v1/rpc/billing_account") {
      // R6.3's own reader, reached when the real cancellation runs.
      return reply(200, [{ customer_id: w.billing.customerId }]);
    }
    if (path === "/rest/v1/rpc/account_deletion_state") {
      return reply(200, w.row ? { ...w.row, billing: w.billing } : null);
    }
    if (path === "/rest/v1/rpc/account_deletion_mark") {
      if (!w.row) return reply(200, null);
      if (body.p_error) {
        w.row.lastError = `${body.p_step}: ${body.p_error}`;
      } else if (body.p_step === "completed") {
        w.row.completedAt ??= "now";
      } else {
        w.row.steps[body.p_step] ??= "now";
        w.row.lastError = null;
      }
      return reply(200, w.row);
    }
    if (path === "/rest/v1/rpc/account_storage_objects") {
      if (failing("storageList")) return reply(500, {});
      return reply(200, w.objects.slice(0, body.p_limit));
    }
    if (path.startsWith("/storage/v1/object/")) {
      assertEquals(init?.method, "DELETE");
      if (failing("storage")) return reply(500, {});
      const bucket = decodeURIComponent(path.slice("/storage/v1/object/".length));
      w.objects = w.objects.filter((o) => !(o.bucket_id === bucket && body.prefixes.includes(o.name)));
      return reply(200, []);
    }
    if (path === "/rest/v1/rpc/erase_account_content") {
      if (failing("content")) return reply(500, {});
      w.row!.steps.content ??= "now";
      return reply(200, { postsDeleted: 0 });
    }
    if (path === "/rest/v1/rpc/erase_account_hands") {
      if (failing("hands")) return reply(500, {});
      if (failing("busy")) return reply(200, -1);
      if (w.hands < 5 && failing("slowBatch")) return reply(500, { code: "57014" });
      const n = Math.min(w.hands, body.p_limit);
      w.hands -= n;
      if (n === 0) w.row!.steps.hands ??= "now";
      return reply(200, n);
    }
    if (path === `/auth/v1/admin/users/${USER_ID}`) {
      assertEquals(init?.method, "DELETE");
      if (failing("auth")) return reply(500, {});
      if (!w.user) return reply(404, {});
      w.user = false;
      return reply(200, {});
    }
    return reply(404, {});
  }) as typeof fetch;
}

function request(body: unknown = { confirm: "alice" }, jwt: string | null = JWT, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://functions.test/account-delete", {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

/** A fake of R6.3's `cancelOwnerSubscriptions` over the world. */
function fakeCanceller(w: World): Env["cancelBilling"] {
  return (owner) => {
    w.billingHookCalls.push(owner);
    w.calls.push("CANCEL subscriptions");
    if (w.failOnce.delete("billingHook")) return Promise.reject(new Error("Stripe answered 500"));
    if (w.billingCancel === "no_profile") return Promise.resolve({ ok: false, error: "no_profile" });
    if (w.billingCancel === "not_configured") return Promise.resolve({ ok: false, error: "stripe_not_configured" });
    w.billing.status = "canceled";
    return Promise.resolve({ ok: true, canceled: 1, hadCustomer: true });
  };
}

async function call(w: World, env: Env = ENV, req: Request = request(), now?: () => number) {
  const withBilling = env === ENV ? { ...env, cancelBilling: fakeCanceller(w) } : env;
  const response = await handle(req, withBilling, fakeFetch(w), now);
  return { status: response.status, body: await response.json().catch(() => null) };
}

Deno.test("a deletion runs every step in order, marks each, and deletes the auth user last", async () => {
  const w = world();
  const { status, body } = await call(w);
  assertEquals(status, 200);
  assertEquals(body, { status: "deleted" });
  assertEquals(w.objects.length, 0, "the stored objects are deleted");
  assertEquals(w.hands, 0, "the hands are deleted");
  assertEquals(w.user, false, "the auth user is deleted");
  assertEquals(w.row?.completedAt, "now");
  for (const step of STEPS) assertEquals(w.row?.steps[step], "now", `${step} is marked`);
  const order = (prefix: string) => w.calls.findIndex((c) => c.includes(prefix));
  assert(order("begin_account_deletion") < order("/storage/v1/object/hand-uploads"), "begin first");
  assert(order("/storage/v1/object/") < order("erase_account_content"), "storage before the content");
  assert(order("erase_account_content") < order("erase_account_hands"), "content before the hands");
  assert(order("erase_account_hands") < order(`/auth/v1/admin/users/${USER_ID}`), "the auth user last");
  assertEquals(w.calls.filter((c) => c.includes("erase_account_hands")).length, 4, "5 hands in batches of 2, then 0");
});

Deno.test("idempotent: after the end the token names nobody, and a finished step is never run again", async () => {
  const w = world();
  await call(w);
  const again = await call(w);
  assertEquals(again.status, 401);
  assertEquals(again.body, { error: "not_signed_in" });

  // A request whose steps are all done but whose auth user survived (the
  // last call failed): only the auth user is deleted.
  const w2 = world({
    row: {
      steps: { billing: "t", storage: "t", content: "t", hands: "t" },
      completedAt: null,
      lastError: null,
    },
  });
  const { status } = await call(w2);
  assertEquals(status, 200);
  assertEquals(w2.calls.some((c) => c.includes("erase_account") || c.includes("/storage/")), false);
  assertEquals(w2.user, false);
});

Deno.test("a failure is recorded and the next call resumes at that step", async () => {
  const w = world({ failOnce: new Set(["content"]) });
  const first = await call(w);
  assertEquals(first.status, 503);
  assertEquals(first.body, { error: "unavailable" });
  assertEquals(w.row?.steps.storage, "now", "the step before it stays done");
  assertEquals(w.row?.steps.content ?? null, null);
  assert(w.row?.lastError?.startsWith("content:"), "the error is noted on the request");
  assertEquals(w.user, true, "nothing after the failed step ran");
  assertEquals(w.hands, 5);

  const calls = w.calls.length;
  const second = await call(w, ENV, request({}));
  assertEquals(second.status, 200, "resumed without the confirmation");
  const resumed = w.calls.slice(calls);
  assertEquals(resumed.some((c) => c.includes("/storage/v1/object/")), false, "storage is not run again");
  assertEquals(w.user, false);
});

Deno.test("a storage failure stops before the content and is retried", async () => {
  const w = world({ failOnce: new Set(["storage"]) });
  assertEquals((await call(w)).status, 503);
  assertEquals(w.objects.length, 2);
  assertEquals(w.calls.some((c) => c.includes("erase_account_content")), false);
  assertEquals((await call(w)).status, 200);
  assertEquals(w.objects.length, 0);
});

Deno.test("an auth failure at the very end leaves the request open for the next call", async () => {
  const w = world({ failOnce: new Set(["auth"]) });
  assertEquals((await call(w)).status, 503);
  assertEquals(w.row?.completedAt, null);
  assertEquals(w.user, true);
  assertEquals((await call(w)).status, 200);
  assertEquals(w.user, false);
});

Deno.test("a large library: the call answers 202 when its time is up, and the next one continues", async () => {
  const w = world({ hands: 9 });
  let t = 0;
  const clock = () => (t += 40); // every reading is 40 ms later
  const env = { ...ENV, timeBudgetMs: 100 };
  const first = await call(w, env, request(), clock);
  assertEquals(first.status, 202);
  assertEquals(first.body, { status: "in_progress", step: "hands" });
  assert(w.hands > 0 && w.hands < 9, "some hands went");
  assertEquals(w.user, true);
  let rounds = 0;
  for (;;) {
    t = 0;
    const next = await call(w, env, request({}), clock);
    rounds++;
    if (next.status === 200) break;
    assertEquals(next.status, 202);
    assert(rounds < 10, "it finishes");
  }
  assertEquals(w.hands, 0);
  assertEquals(w.user, false);
});

Deno.test("hands another call is deleting: this one waits and goes on", async () => {
  const w = world({ failOnce: new Set(["busy"]) });
  assertEquals((await call(w)).status, 200);
  assertEquals(w.hands, 0);
  assertEquals(w.user, false);
});

Deno.test("a slow batch after some progress is not a failure: 202, and the next call goes on", async () => {
  const w = world({ failOnce: new Set(["slowBatch"]) });
  const first = await call(w);
  assertEquals(first.status, 202);
  assertEquals(first.body, { status: "in_progress", step: "hands" });
  assertEquals((await call(w, ENV, request({}))).status, 200);
  assertEquals(w.user, false);
});

Deno.test("billing: a paying account's subscriptions are canceled first, before anything is deleted", async () => {
  const w = world({ billing: { customerId: "cus_1", subscriptionId: "sub_1", status: "active" } });
  assertEquals((await call(w)).status, 200);
  assertEquals(w.billingHookCalls, [USER_ID]);
  const order = (prefix: string) => w.calls.findIndex((c) => c.includes(prefix));
  assert(order("CANCEL") < order("/storage/v1/object/"), "billing before anything is deleted");
  assertEquals(w.user, false);
});

Deno.test("billing: when Stripe fails, nothing is deleted, and the next call tries again", async () => {
  const w = world({
    billing: { customerId: "cus_1", subscriptionId: "sub_1", status: "active" },
    failOnce: new Set(["billingHook"]),
  });
  const first = await call(w);
  assertEquals(first.status, 503);
  assertEquals(first.body, { error: "billing_unavailable" });
  assertEquals(w.objects.length, 2);
  assertEquals(w.hands, 5);
  assertEquals(w.user, true);
  assert(w.row?.lastError?.startsWith("billing:"));
  assertEquals((await call(w, ENV, request({}))).status, 200);
  assertEquals(w.billingHookCalls.length, 2);
  assertEquals(w.user, false);
});

Deno.test("billing: Stripe not configured, or no profile: nothing can bill the account, the deletion goes on", async () => {
  for (const answer of ["not_configured", "no_profile"] as const) {
    const w = world({ billing: { customerId: "cus_1", subscriptionId: null, status: null }, billingCancel: answer });
    assertEquals((await call(w)).status, 200, answer);
    assertEquals(w.user, false);
  }
});

Deno.test("billing: an account that never paid is not looked up at Stripe", async () => {
  const none = world();
  assertEquals((await call(none)).status, 200);
  assertEquals(none.billingHookCalls, []);
  let threw = false;
  try {
    await cancelForDeletion(() => Promise.reject(new Error("down")), USER_ID, billingFrom({ customerId: "c" }), fetch);
  } catch (error) {
    threw = error instanceof BillingUnavailable;
  }
  assert(threw, "a failing cancellation fails closed");
  assertEquals(
    await cancelForDeletion(() => Promise.reject(new Error("never")), USER_ID, billingFrom(null), fetch),
    "none",
  );
});

Deno.test("billing: the production canceller is R6.3's, and without a Stripe key it lets the deletion go on", async () => {
  // No STRIPE_SECRET_KEY in this test's environment: R6.3's code reads the
  // account's customer, finds Stripe unconfigured and says so.
  const w = world({ billing: { customerId: "cus_1", subscriptionId: "sub_1", status: "active" } });
  const env = {
    ...ENV,
    cancelBilling: cancellerFor({
      supabaseUrl: ENV.supabaseUrl,
      anonKey: ENV.anonKey,
      serviceRoleKey: ENV.serviceRoleKey,
      stripeSecretKey: "",
      stripeWebhookSecret: "",
      stripeApiVersion: "",
      priceMonth: "",
      priceYear: "",
      earlyUserCoupon: "",
      portalConfiguration: "",
      successUrl: "",
      cancelUrl: "",
      portalReturnUrl: "",
    }),
  };
  assertEquals((await call(w, env)).status, 200);
  assert(w.calls.some((c) => c.includes("/rest/v1/rpc/billing_account")), "R6.3's reader was asked");
  assertEquals(w.user, false);
});

Deno.test("the user-side refusals: re-sign-in, confirmation, budget", async () => {
  const cases: [unknown, number, string][] = [
    [{ code: "28000", hint: "reauth_required", message: "Sign in again" }, 403, "reauth_required"],
    [{ code: "22023", hint: "confirmation_mismatch", message: "Type your username" }, 400, "confirmation_mismatch"],
    [{ code: "53400", message: "rate limit" }, 429, "rate_limited"],
    [{ code: "XX000", message: "boom" }, 503, "unavailable"],
  ];
  for (const [error, status, code] of cases) {
    const w = world({ beginError: { status: 400, body: error } });
    const out = await call(w);
    assertEquals(out.status, status, code);
    assertEquals(out.body, { error: code });
    assertEquals(w.calls.some((c) => c.includes("service") || c.includes("erase") || c.includes("admin")), false);
    assertEquals(w.user, true);
  }
});

Deno.test("refuses what is not the page: no token, other methods, bad bodies; answers CORS preflight", async () => {
  const w = world();
  assertEquals((await call(w, ENV, request({}, null))).status, 401);
  assertEquals((await call(w, ENV, request({}, JWT, "GET"))).status, 405);
  assertEquals((await call(w, ENV, request("not json"))).status, 400);
  assertEquals((await call(w, ENV, request({ confirm: 7 }))).status, 400);
  assertEquals((await call(w, ENV, request({ confirm: "x".repeat(2000) }))).status, 400);
  const preflight = await handle(
    new Request("http://functions.test/account-delete", { method: "OPTIONS" }),
    ENV,
    fakeFetch(w),
  );
  assertEquals(preflight.status, 204);
  assertEquals(w.calls.length, 0, "nothing reached upstream");
  assertEquals(
    (await call(w, { ...ENV, serviceRoleKey: "" })).body,
    { error: "unavailable" },
    "no service key: unavailable",
  );
});

Deno.test("an object outside the user's folder is never deleted", async () => {
  const w = world({ objects: [{ bucket_id: "hand-uploads", name: "someone-else/x.gz" }] });
  const out = await call(w);
  assertEquals(out.status, 503);
  assertEquals(w.objects.length, 1);
  assertEquals(w.user, true);
});

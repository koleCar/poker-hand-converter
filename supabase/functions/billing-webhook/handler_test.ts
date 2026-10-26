/**
 * `deno test` - `billing-webhook` against signed fixture events
 * (`testdata/events.json`), a locally generated secret, a fake Stripe and a
 * fake PostgREST. No network.
 *
 * Each of the six event types reads the subscription back from Stripe and
 * makes exactly one `billing_apply_subscription` call with the mapped plan;
 * a bad, tampered, re-timed or expired signature is refused before anything
 * is read; other types and the other mode are acknowledged and dropped; the
 * database's outcomes (duplicate, stale, unknown customer) come back as 200
 * so Stripe stops retrying; Stripe or the database down -> 5xx so it retries.
 * The database side of idempotency and ordering is pgTAP `billing_stripe`.
 */

import { handle } from "./handler.ts";
import {
  assert,
  assertEquals,
  type Call,
  fakeFetch,
  fakeKey,
  newWebhookSecret,
  type Route,
  stripeSubscription,
  testEnv,
} from "../_shared/billing/test_util.ts";
import { signPayload } from "../_shared/billing/stripe.ts";

const EVENTS: Record<string, unknown>[] = JSON.parse(
  await Deno.readTextFile(new URL("./testdata/events.json", import.meta.url)),
);
const event = (type: string) => structuredClone(EVENTS.find((e) => e.type === type)!);

const SECRET = newWebhookSecret();
const ENV = testEnv({ stripeWebhookSecret: SECRET });
const NOW = 1_792_592_200;

const START = new Date(1_790_000_000_000).toISOString();
const END = new Date(1_792_592_000_000).toISOString();

async function signed(body: unknown, options: { secret?: string; at?: number; header?: string } = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const header = options.header ?? await signPayload(options.secret ?? SECRET, payload, options.at ?? NOW);
  return new Request("http://functions.test/billing-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": header },
    body: payload,
  });
}

function routes(subscription: Route, outcome: Route = { body: "applied" }): Record<string, Route> {
  return {
    "GET /v1/subscriptions/sub_rail1": subscription,
    "POST /rest/v1/rpc/billing_apply_subscription": outcome,
  };
}

async function deliver(request: Request, fake: Record<string, Route>, env = ENV) {
  const { fetchFn, calls } = fakeFetch(fake);
  const response = await handle(request, env, { fetchFn, nowSeconds: NOW });
  return { response, body: await response.json(), calls };
}

const applyCall = (calls: Call[]) => calls.filter((c) => c.key === "POST /rest/v1/rpc/billing_apply_subscription");

const CASES: { type: string; stripe: Record<string, unknown>; expect: Record<string, unknown> }[] = [
  {
    type: "checkout.session.completed",
    stripe: stripeSubscription(),
    expect: { p_plan: "pro", p_period: "month", p_status: "active", p_current_period_end: END },
  },
  {
    type: "customer.subscription.created",
    stripe: stripeSubscription({ status: "incomplete" }),
    expect: { p_plan: "free", p_period: "month", p_status: null, p_current_period_end: null },
  },
  {
    type: "customer.subscription.updated",
    stripe: stripeSubscription({ cancel_at_period_end: true }),
    expect: { p_plan: "pro", p_period: "month", p_status: "canceled", p_current_period_end: END },
  },
  {
    type: "customer.subscription.deleted",
    stripe: stripeSubscription({ status: "canceled", ended_at: 1_791_000_000, canceled_at: 1_791_000_000 }),
    expect: {
      p_plan: "pro",
      p_period: "month",
      p_status: "canceled",
      p_current_period_end: new Date(1_791_000_000_000).toISOString(),
    },
  },
  {
    type: "invoice.paid",
    stripe: stripeSubscription(),
    expect: { p_plan: "pro", p_period: "month", p_status: "active", p_current_period_end: END },
  },
  {
    type: "invoice.payment_failed",
    stripe: stripeSubscription({ status: "past_due" }),
    expect: { p_plan: "pro", p_period: "month", p_status: "past_due", p_current_period_end: START },
  },
];

for (const c of CASES) {
  Deno.test(`${c.type}: the subscription read back from Stripe -> one billing_apply_subscription call`, async () => {
    const e = event(c.type);
    const { response, body, calls } = await deliver(await signed(e), routes({ body: c.stripe }));
    assertEquals(response.status, 200);
    assertEquals(body, { received: true, outcome: "applied" });
    assertEquals(calls.map((x) => x.key), [
      "GET /v1/subscriptions/sub_rail1",
      "POST /rest/v1/rpc/billing_apply_subscription",
    ]);
    // Stripe: the secret key, the pinned version.
    assertEquals(calls[0].headers.get("authorization"), `Bearer ${ENV.stripeSecretKey}`);
    assertEquals(calls[0].headers.get("stripe-version"), "2025-03-31.basil");
    // The database: the service role, the event's id and time, the mapped plan.
    assertEquals(calls[1].headers.get("authorization"), `Bearer ${ENV.serviceRoleKey}`);
    assertEquals(calls[1].json, {
      p_event_id: e.id,
      p_event_type: c.type,
      p_event_created: new Date((e.created as number) * 1000).toISOString(),
      p_customer_id: "cus_rail1",
      p_subscription_id: "sub_rail1",
      ...c.expect,
    });
  });
}

Deno.test("the state is Stripe's, not the delivery's: an event's own status is not used", async () => {
  // The created event says `incomplete`; Stripe says `active` now.
  const { calls } = await deliver(
    await signed(event("customer.subscription.created")),
    routes({ body: stripeSubscription() }),
  );
  assertEquals(applyCall(calls)[0].json?.p_status, "active");
});

Deno.test("the customer is the subscription's own, not the event's", async () => {
  const e = event("invoice.paid");
  (e.data as { object: Record<string, unknown> }).object.customer = "cus_someone_else";
  const { calls } = await deliver(await signed(e), routes({ body: stripeSubscription() }));
  assertEquals(applyCall(calls)[0].json?.p_customer_id, "cus_rail1");
});

Deno.test("signature: tampered, another secret, re-timed, expired, missing - 400 and nothing read", async () => {
  const e = event("invoice.paid");
  const good = JSON.stringify(e);
  const header = await signPayload(SECRET, good, NOW);
  const tampered = good.replace('"status":"paid"', '"status":"void"');
  const cases: Request[] = [
    await signed(tampered, { header }),
    await signed(e, { secret: newWebhookSecret() }),
    await signed(e, { header: header.replace(`t=${NOW}`, `t=${NOW - 5}`) }),
    await signed(e, { at: NOW - 301 }),
    await signed(e, { at: NOW + 301 }),
    await signed(e, { header: "" }),
    await signed(e, { header: "t=abc,v1=xyz" }),
  ];
  for (const request of cases) {
    const { response, body, calls } = await deliver(request, routes({ body: stripeSubscription() }));
    assertEquals(response.status, 400);
    assertEquals(body, { error: "bad_signature" });
    assertEquals(calls.length, 0, "nothing is fetched for a bad signature");
  }
});

Deno.test("a signed body that is not an event: 400", async () => {
  for (
    const body of [
      "not json",
      JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
      JSON.stringify({ object: "event", id: "x", type: "invoice.paid", created: 1 }),
    ]
  ) {
    const { response } = await deliver(await signed(body), routes({ body: stripeSubscription() }));
    assertEquals(response.status, 400, body);
  }
});

Deno.test("no webhook secret configured: 503 (Stripe retries once it is set)", async () => {
  const { response, calls } = await deliver(
    await signed(event("invoice.paid")),
    {},
    testEnv({ stripeWebhookSecret: "" }),
  );
  assertEquals(response.status, 503);
  assertEquals(calls.length, 0);
});

Deno.test("no secret key: a handled event is 503, an unhandled one is still acknowledged", async () => {
  const env = testEnv({ stripeWebhookSecret: SECRET, stripeSecretKey: "" });
  assertEquals((await deliver(await signed(event("invoice.paid")), {}, env)).response.status, 503);
  const other = { ...event("invoice.paid"), type: "customer.created" };
  assertEquals((await deliver(await signed(other), {}, env)).response.status, 200);
});

Deno.test("other event types are acknowledged and dropped", async () => {
  for (const type of ["customer.created", "invoice.created", "payment_intent.succeeded", "charge.refunded"]) {
    const { response, body, calls } = await deliver(await signed({ ...event("invoice.paid"), type }), {});
    assertEquals([response.status, body.outcome, calls.length], [200, "ignored", 0], type);
  }
});

Deno.test("an event of the other mode (live with a test key) is dropped", async () => {
  const { response, body, calls } = await deliver(await signed({ ...event("invoice.paid"), livemode: true }), {});
  assertEquals([response.status, body.outcome, calls.length], [200, "other_mode", 0]);
  const live = testEnv({ stripeWebhookSecret: SECRET, stripeSecretKey: fakeKey("live") });
  const test = await deliver(await signed(event("invoice.paid")), {}, live);
  assertEquals([test.response.status, test.body.outcome], [200, "other_mode"]);
});

Deno.test("no subscription in the event (a one-off invoice, a payment-mode checkout): acknowledged", async () => {
  const invoice = event("invoice.paid");
  delete (invoice.data as { object: Record<string, unknown> }).object.parent;
  const checkout = event("checkout.session.completed");
  (checkout.data as { object: Record<string, unknown> }).object.mode = "payment";
  for (const e of [invoice, checkout]) {
    const { response, body, calls } = await deliver(await signed(e), {});
    assertEquals([response.status, body.outcome, calls.length], [200, "ignored", 0]);
  }
});

Deno.test("the database's outcomes come back as 200: duplicate, stale, unknown customer, not current", async () => {
  for (const outcome of ["duplicate", "stale", "unknown_customer", "not_current"]) {
    const { response, body } = await deliver(
      await signed(event("customer.subscription.updated")),
      routes({ body: stripeSubscription() }, { body: outcome }),
    );
    assertEquals([response.status, body.outcome], [200, outcome]);
  }
});

Deno.test("a subscription Stripe does not know: acknowledged, nothing written", async () => {
  const { response, body, calls } = await deliver(
    await signed(event("invoice.paid")),
    routes({ status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing" } } }),
  );
  assertEquals([response.status, body.outcome, applyCall(calls).length], [200, "no_such_subscription", 0]);
});

Deno.test("Stripe or the database down: 5xx so Stripe retries", async () => {
  const stripeDown = await deliver(await signed(event("invoice.paid")), routes({ status: 500, body: {} }));
  assertEquals(stripeDown.response.status, 502);
  const dbDown = await deliver(
    await signed(event("invoice.paid")),
    routes({ body: stripeSubscription() }, { status: 503, body: { code: "57P01" } }),
  );
  assertEquals(dbDown.response.status, 500);
});

Deno.test("only POST; an oversized body is refused before it is verified", async () => {
  const { fetchFn } = fakeFetch({});
  const get = await handle(new Request("http://functions.test/billing-webhook"), ENV, { fetchFn, nowSeconds: NOW });
  assertEquals(get.status, 405);
  const big = "x".repeat(1024 * 1024 + 1);
  const response = await handle(await signed(big), ENV, { fetchFn, nowSeconds: NOW });
  assertEquals(response.status, 413);
});

Deno.test("logs carry no payload, email, address or secret", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await deliver(await signed(event("checkout.session.completed")), routes({ body: stripeSubscription() }));
    await deliver(await signed(event("invoice.paid"), { secret: newWebhookSecret() }), {});
  } finally {
    console.log = original;
  }
  const all = lines.join("\n");
  assert(lines.length === 2, `two log lines, got ${lines.length}`);
  for (const secret of ["player@example.test", "HR", SECRET, ENV.stripeSecretKey, ENV.serviceRoleKey, "cus_rail1"]) {
    assert(!all.includes(secret), `the log does not contain ${secret}`);
  }
});

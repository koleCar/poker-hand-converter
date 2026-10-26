/**
 * `deno test` - `billing-checkout` against a fake GoTrue, PostgREST and
 * Stripe. No network.
 */

import { handle, resetConfigCache } from "./handler.ts";
import {
  assert,
  assertEquals,
  type Call,
  CONFIRMED_USER,
  CONSENT,
  fakeFetch,
  JWT,
  type Route,
  testEnv,
  unconfiguredEnv,
  USER_ID,
} from "../_shared/billing/test_util.ts";
import type { BillingEnv } from "../_shared/billing/config.ts";
import { CONSENT_TEXTS, SUBMIT_MESSAGE, TERMS } from "../_shared/billing/consent.ts";

const ENV = testEnv();
const SESSION_URL = "https://checkout.stripe.com/c/pay/cs_test_rail1";
const CONSENT_ID = "00000000-0000-0000-0000-0000000c0501";

interface Account {
  customer_id?: string | null;
  subscription_id?: string | null;
  plan?: string;
  plan_status?: string | null;
  current_period_end?: string | null;
  early_user?: boolean;
}

function account(fields: Account = {}) {
  return {
    customer_id: null,
    subscription_id: null,
    plan: "free",
    plan_status: null,
    current_period_end: null,
    early_user: false,
    ...fields,
  };
}

function routes(overrides: Record<string, Route> = {}, acct: Account = {}): Record<string, Route> {
  return {
    "GET /auth/v1/user": { body: CONFIRMED_USER },
    "POST /rest/v1/rpc/billing_claim": { status: 204 },
    "POST /rest/v1/rpc/billing_account": { body: [account(acct)] },
    "POST /v1/customers": { body: { id: "cus_new1", object: "customer" } },
    "POST /rest/v1/rpc/billing_set_customer": (call) => ({ body: call.json?.p_customer_id }),
    "POST /rest/v1/rpc/billing_record_consent": { body: CONSENT_ID },
    "POST /v1/checkout/sessions": { body: { id: "cs_test_rail1", url: SESSION_URL } },
    "POST /rest/v1/rpc/billing_consent_set_session": { body: true },
    "GET /v1/prices/price_promonth": {
      body: {
        id: "price_promonth",
        active: true,
        unit_amount: 699,
        currency: "eur",
        tax_behavior: "inclusive",
        recurring: { interval: "month" },
      },
    },
    "GET /v1/prices/price_proyear": {
      body: {
        id: "price_proyear",
        active: true,
        unit_amount: 5999,
        currency: "eur",
        tax_behavior: "inclusive",
        recurring: { interval: "year" },
      },
    },
    "GET /v1/coupons/EARLY30": { body: { id: "EARLY30", percent_off: 30, duration: "forever" } },
    ...overrides,
  };
}

/** What the upgrade step sends: the period, the page's language, both boxes ticked. */
function order(period: string, locale = "en", consent: unknown = CONSENT): Record<string, unknown> {
  return { period, locale, consent };
}

function post(body: unknown, jwt: string | null = JWT): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://functions.test/billing-checkout", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(jwt: string | null = JWT): Request {
  return new Request("http://functions.test/billing-checkout", {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  });
}

async function call(request: Request, fake: Record<string, Route>, env: BillingEnv = ENV) {
  resetConfigCache();
  const { fetchFn, calls } = fakeFetch(fake);
  const response = await handle(request, env, fetchFn);
  return { response, body: await response.json().catch(() => null), calls };
}

const sessionCall = (calls: Call[]) => calls.find((c) => c.key === "POST /v1/checkout/sessions");

Deno.test("checkout: a new customer, Stripe Tax on, the account's id as the reference, the URL back", async () => {
  const { response, body, calls } = await call(post(order("year", "hr")), routes());
  assertEquals(response.status, 200);
  assertEquals(body, { url: SESSION_URL });
  assertEquals(calls.map((c) => c.key), [
    "GET /auth/v1/user",
    "POST /rest/v1/rpc/billing_claim",
    "POST /rest/v1/rpc/billing_account",
    "POST /v1/customers",
    "POST /rest/v1/rpc/billing_set_customer",
    "POST /rest/v1/rpc/billing_record_consent",
    "POST /v1/checkout/sessions",
    "POST /rest/v1/rpc/billing_consent_set_session",
  ]);
  // The budget and the account are the verified caller's, with the service role.
  assertEquals(calls[1].json, { p_owner: USER_ID, p_kind: "checkout" });
  assertEquals(calls[1].headers.get("authorization"), `Bearer ${ENV.serviceRoleKey}`);
  // The customer: the account's email, the account id as metadata, an idempotency key.
  const customer = calls[3];
  assertEquals(customer.form?.get("email"), CONFIRMED_USER.email);
  assertEquals(customer.form?.get("metadata[owner_id]"), USER_ID);
  assert((customer.headers.get("idempotency-key") ?? "").startsWith(`rail-customer-${USER_ID}-`), "idempotent");
  assertEquals(calls[4].json, { p_owner: USER_ID, p_customer_id: "cus_new1" });

  const form = sessionCall(calls)!.form!;
  assertEquals(Object.fromEntries(form), {
    mode: "subscription",
    customer: "cus_new1",
    client_reference_id: USER_ID,
    "line_items[0][price]": "price_proyear",
    "line_items[0][quantity]": "1",
    "automatic_tax[enabled]": "true",
    billing_address_collection: "required",
    "tax_id_collection[enabled]": "true",
    "customer_update[address]": "auto",
    "customer_update[name]": "auto",
    "subscription_data[metadata][owner_id]": USER_ID,
    "subscription_data[metadata][consent_id]": CONSENT_ID,
    "metadata[owner_id]": USER_ID,
    "metadata[consent_id]": CONSENT_ID,
    "custom_text[submit][message]": SUBMIT_MESSAGE.hr,
    locale: "hr",
    success_url: ENV.successUrl,
    cancel_url: ENV.cancelUrl,
  });
});

Deno.test("checkout: an existing customer is reused; an early user gets the coupon (or promotion code)", async () => {
  const { calls } = await call(post(order("month")), routes({}, { customer_id: "cus_old1", early_user: true }));
  assert(!calls.some((c) => c.key === "POST /v1/customers"), "no new customer");
  const form = sessionCall(calls)!.form!;
  assertEquals(form.get("customer"), "cus_old1");
  assertEquals(form.get("line_items[0][price]"), "price_promonth");
  assertEquals(form.get("discounts[0][coupon]"), "EARLY30");
  assertEquals(form.get("locale"), "en");
  assertEquals(form.get("custom_text[submit][message]"), SUBMIT_MESSAGE.en);

  const promo = await call(
    post(order("month")),
    routes({}, { customer_id: "cus_old1", early_user: true }),
    testEnv({ earlyUserCoupon: "promo_early" }),
  );
  assertEquals(sessionCall(promo.calls)!.form!.get("discounts[0][promotion_code]"), "promo_early");
});

Deno.test("checkout: no discount for an account that is not an early user, or with no coupon configured", async () => {
  const late = await call(post(order("month")), routes({}, { early_user: false }));
  assert(!sessionCall(late.calls)!.body!.includes("discounts"), "no discount");
  const none = await call(
    post(order("month")),
    routes({}, { early_user: true }),
    testEnv({ earlyUserCoupon: "" }),
  );
  assert(!sessionCall(none.calls)!.body!.includes("discounts"), "no coupon configured");
});

Deno.test("checkout: the stored customer wins a race (billing_set_customer returns the first)", async () => {
  const { calls } = await call(
    post(order("month")),
    routes({ "POST /rest/v1/rpc/billing_set_customer": { body: "cus_first" } }),
  );
  assertEquals(sessionCall(calls)!.form!.get("customer"), "cus_first");
});

Deno.test("checkout: an account with a subscription is refused (no second one)", async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  for (
    const acct of [
      { plan: "pro", plan_status: "active", subscription_id: "sub_1", customer_id: "cus_1" },
      { plan: "pro", plan_status: "trialing", subscription_id: "sub_1", customer_id: "cus_1" },
      { plan: "pro", plan_status: "past_due", subscription_id: "sub_1", customer_id: "cus_1" },
      {
        plan: "pro",
        plan_status: "canceled",
        subscription_id: "sub_1",
        customer_id: "cus_1",
        current_period_end: future,
      },
    ]
  ) {
    const { response, body, calls } = await call(post(order("month")), routes({}, acct));
    assertEquals([response.status, body], [409, { error: "already_subscribed" }], JSON.stringify(acct));
    assert(!sessionCall(calls), "no session");
  }
  // Ended, or Pro granted by hand without a subscription: may buy.
  for (
    const acct of [
      {
        plan: "pro",
        plan_status: "canceled",
        subscription_id: "sub_1",
        customer_id: "cus_1",
        current_period_end: past,
      },
      { plan: "pro", plan_status: null, subscription_id: null },
    ]
  ) {
    const { response } = await call(post(order("month")), routes({}, acct));
    assertEquals(response.status, 200, JSON.stringify(acct));
  }
});

Deno.test("checkout: not configured (no keys) -> 503 unavailable and Stripe is never called", async () => {
  const { response, body, calls } = await call(post(order("month")), routes(), unconfiguredEnv());
  assertEquals([response.status, body], [503, { error: "unavailable" }]);
  assert(
    !calls.some((c) => c.url.includes("/v1/") && !c.url.includes("/auth/") && !c.url.includes("/rest/")),
    "no Stripe",
  );
  // Only one period on sale: the other is unavailable.
  const monthOnly = testEnv({ priceYear: "" });
  assertEquals((await call(post(order("year")), routes(), monthOnly)).response.status, 503);
  assertEquals((await call(post(order("month")), routes(), monthOnly)).response.status, 200);
});

Deno.test("checkout: the consent is recorded before the session, with what the server knows", async () => {
  const { calls } = await call(post(order("year", "hr")), routes());
  const record = calls.find((c) => c.key === "POST /rest/v1/rpc/billing_record_consent")!;
  const index = (key: string) => calls.findIndex((c) => c.key === key);
  assert(
    index("POST /rest/v1/rpc/billing_record_consent") < index("POST /v1/checkout/sessions"),
    "recorded before the session",
  );
  // The account from the verified token; the wording's and the terms' hashes
  // from the server's own table, in the language the page was in.
  assertEquals(record.json, {
    p_owner: USER_ID,
    p_kinds: ["terms", "immediate_performance"],
    p_terms_version: TERMS.version,
    p_terms_sha256: TERMS.sha256.hr,
    p_text_version: CONSENT.version,
    p_text_sha256: CONSENT_TEXTS[CONSENT.version].hr,
    p_locale: "hr",
    p_period: "year",
  });
  assertEquals(record.headers.get("authorization"), `Bearer ${ENV.serviceRoleKey}`);
  // The session id goes back onto the record.
  const link = calls.find((c) => c.key === "POST /rest/v1/rpc/billing_consent_set_session")!;
  assertEquals(link.json, { p_consent: CONSENT_ID, p_owner: USER_ID, p_session_id: "cs_test_rail1" });
  // Nothing the browser adds is recorded: an extra field changes nothing.
  const extra = await call(
    post({ ...order("year", "hr"), owner: "someone", consent: { ...CONSENT, termsSha256: "f".repeat(64) } }),
    routes(),
  );
  assertEquals(extra.calls.find((c) => c.key === "POST /rest/v1/rpc/billing_record_consent")!.json, record.json);
});

Deno.test("checkout: no consent, a box not ticked or an unknown wording -> refused before anything is called", async () => {
  const cases: [unknown, string][] = [
    [{ period: "month", locale: "en" }, "consent_required"],
    [order("month", "en", null), "consent_required"],
    [order("month", "en", true), "consent_required"],
    [order("month", "en", [CONSENT]), "consent_required"],
    [order("month", "en", { ...CONSENT, terms: false }), "consent_required"],
    [order("month", "en", { ...CONSENT, immediatePerformance: false }), "consent_required"],
    [order("month", "en", { ...CONSENT, immediatePerformance: "true" }), "consent_required"],
    [order("month", "en", { version: CONSENT.version }), "consent_required"],
    [order("month", "en", { ...CONSENT, version: "1999-01-01" }), "consent_outdated"],
    [order("month", "en", { ...CONSENT, version: "toString" }), "consent_outdated"],
    [order("month", "en", { terms: true, immediatePerformance: true }), "consent_outdated"],
    // The language says which text was read: the page always sends it.
    [order("month", "de"), "invalid_request"],
    [{ period: "month", consent: CONSENT }, "invalid_request"],
  ];
  for (const [body, error] of cases) {
    const { response, body: answer, calls } = await call(post(body), routes());
    assertEquals([response.status, answer], [400, { error }], JSON.stringify(body));
    assertEquals(calls.length, 0, "refused before any call");
  }
});

Deno.test("checkout: the consent cannot be recorded -> no session", async () => {
  const down = routes({ "POST /rest/v1/rpc/billing_record_consent": { status: 500, body: {} } });
  const { response, calls } = await call(post(order("month")), down);
  assertEquals(response.status, 503);
  assert(!sessionCall(calls), "no session without a record");
  const empty = routes({ "POST /rest/v1/rpc/billing_record_consent": { body: null } });
  const second = await call(post(order("month")), empty);
  assertEquals(second.response.status, 503);
  assert(!sessionCall(second.calls), "no session without a record id");
});

Deno.test("checkout: writing the session id back may fail; the URL still comes back", async () => {
  const failing = routes({ "POST /rest/v1/rpc/billing_consent_set_session": { status: 500, body: {} } });
  const { response, body } = await call(post(order("month")), failing);
  assertEquals([response.status, body], [200, { url: SESSION_URL }]);
});

Deno.test("checkout: who may call", async () => {
  assertEquals((await call(post(order("month"), null), routes())).response.status, 401);
  assertEquals(
    (await call(post(order("month")), routes({ "GET /auth/v1/user": { status: 401 } }))).response.status,
    401,
  );
  const anonymous = routes({ "GET /auth/v1/user": { body: { id: USER_ID, is_anonymous: true } } });
  assertEquals((await call(post(order("month")), anonymous)).body, { error: "account_not_supported" });
  const unconfirmed = routes({ "GET /auth/v1/user": { body: { id: USER_ID, email: "a@x.test" } } });
  assertEquals((await call(post(order("month")), unconfirmed)).body, { error: "email_unconfirmed" });
  const noProfile = routes({ "POST /rest/v1/rpc/billing_account": { body: [] } });
  assertEquals((await call(post(order("month")), noProfile)).response.status, 403);
});

Deno.test("checkout: bad requests", async () => {
  for (const body of [{}, { period: "week" }, "not json", "[]", { period: "month", pad: "x".repeat(2000) }]) {
    const { response, calls } = await call(post(body), routes());
    assertEquals(response.status, 400, JSON.stringify(body));
    assertEquals(calls.length, 0, "refused before any call");
  }
  const put = new Request("http://functions.test/billing-checkout", {
    method: "PUT",
    headers: { Authorization: `Bearer ${JWT}` },
  });
  assertEquals((await call(put, routes())).response.status, 405);
  const options = await call(new Request("http://functions.test/billing-checkout", { method: "OPTIONS" }), routes());
  assertEquals(options.response.status, 204);
});

Deno.test("checkout: over the budget -> 429; Stripe or the database down -> 5xx", async () => {
  const limited = routes({ "POST /rest/v1/rpc/billing_claim": { status: 400, body: { code: "53400" } } });
  assertEquals((await call(post(order("month")), limited)).body, { error: "rate_limited" });
  const stripeDown = routes({ "POST /v1/checkout/sessions": { status: 500, body: { error: { type: "api_error" } } } });
  assertEquals((await call(post(order("month")), stripeDown)).response.status, 502);
  const dbDown = routes({ "POST /rest/v1/rpc/billing_account": { status: 500, body: {} } });
  assertEquals((await call(post(order("month")), dbDown)).response.status, 503);
});

Deno.test("config (GET): prices and the discount as Stripe has them; nothing secret", async () => {
  const { response, body } = await call(get(), routes());
  assertEquals(response.status, 200);
  assertEquals(body, {
    available: true,
    prices: {
      month: { amount: 699, currency: "eur", interval: "month", taxInclusive: true },
      year: { amount: 5999, currency: "eur", interval: "year", taxInclusive: true },
    },
    earlyDiscountPercent: 30,
  });
  const text = JSON.stringify(body);
  assert(!text.includes("price_") && !text.includes("sk_") && !text.includes("EARLY30"), "no ids or keys");
});

Deno.test("config (GET): unconfigured, Stripe down or a wrong price -> available false, never an error", async () => {
  assertEquals((await call(get(), routes(), unconfiguredEnv())).body.available, false);
  const down = routes({
    "GET /v1/prices/price_promonth": { status: 500, body: {} },
  });
  assertEquals((await call(get(), down)).body, {
    available: false,
    prices: { month: null, year: null },
    earlyDiscountPercent: null,
  });
  const wrongInterval = routes({
    "GET /v1/prices/price_proyear": {
      body: { active: true, unit_amount: 5, currency: "eur", recurring: { interval: "month" } },
    },
  });
  const { body } = await call(get(), wrongInterval);
  assertEquals([body.available, body.prices.year], [true, null]);
  assertEquals((await call(get(null), routes())).response.status, 401);
});

Deno.test("config (GET): cached for ten minutes", async () => {
  resetConfigCache();
  const { fetchFn, calls } = fakeFetch(routes());
  await handle(get(), ENV, fetchFn);
  await handle(get(), ENV, fetchFn);
  assertEquals(calls.filter((c) => c.key.startsWith("GET /v1/prices/")).length, 2, "two prices, read once");
});

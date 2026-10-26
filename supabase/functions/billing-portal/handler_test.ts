/**
 * `deno test` - `billing-portal` against a fake GoTrue, PostgREST and
 * Stripe. No network.
 */

import { handle } from "./handler.ts";
import {
  assertEquals,
  CONFIRMED_USER,
  fakeFetch,
  JWT,
  type Route,
  testEnv,
  unconfiguredEnv,
  USER_ID,
} from "../_shared/billing/test_util.ts";
import type { BillingEnv } from "../_shared/billing/config.ts";

const ENV = testEnv();
const PORTAL_URL = "https://billing.stripe.com/p/session/test_rail1";

function routes(overrides: Record<string, Route> = {}, customer: string | null = "cus_rail1"): Record<string, Route> {
  return {
    "GET /auth/v1/user": { body: CONFIRMED_USER },
    "POST /rest/v1/rpc/billing_claim": { status: 204 },
    "POST /rest/v1/rpc/billing_account": {
      body: [{
        customer_id: customer,
        subscription_id: "sub_rail1",
        plan: "pro",
        plan_status: "active",
        current_period_end: null,
        early_user: false,
      }],
    },
    "POST /v1/billing_portal/sessions": { body: { url: PORTAL_URL } },
    ...overrides,
  };
}

function post(body: unknown = {}, jwt: string | null = JWT): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("http://functions.test/billing-portal", { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(request: Request, fake: Record<string, Route>, env: BillingEnv = ENV) {
  const { fetchFn, calls } = fakeFetch(fake);
  const response = await handle(request, env, fetchFn);
  return { response, body: await response.json().catch(() => null), calls };
}

Deno.test("portal: the caller's own customer, the configured return address, the URL back", async () => {
  const { response, body, calls } = await call(post({ locale: "hr" }), routes());
  assertEquals([response.status, body], [200, { url: PORTAL_URL }]);
  assertEquals(calls.map((c) => c.key), [
    "GET /auth/v1/user",
    "POST /rest/v1/rpc/billing_claim",
    "POST /rest/v1/rpc/billing_account",
    "POST /v1/billing_portal/sessions",
  ]);
  assertEquals(calls[1].json, { p_owner: USER_ID, p_kind: "portal" });
  assertEquals(calls[2].json, { p_owner: USER_ID });
  assertEquals(Object.fromEntries(calls[3].form!), {
    customer: "cus_rail1",
    return_url: ENV.portalReturnUrl,
    locale: "hr",
  });
});

Deno.test("portal: a configured portal configuration is passed; a customer id in the body is ignored", async () => {
  const env = testEnv({ portalConfiguration: "bpc_rail" });
  const { calls } = await call(post({ customer: "cus_someone_else" }), routes(), env);
  const form = calls[3].form!;
  assertEquals([form.get("customer"), form.get("configuration")], ["cus_rail1", "bpc_rail"]);
});

Deno.test("portal: an account that never checked out -> 409 no_customer", async () => {
  const { response, body, calls } = await call(post(), routes({}, null));
  assertEquals([response.status, body], [409, { error: "no_customer" }]);
  assertEquals(calls.length, 3);
});

Deno.test("portal: not configured -> 503; not signed in -> 401; over budget -> 429; Stripe down -> 502", async () => {
  assertEquals((await call(post(), routes(), unconfiguredEnv())).body, { error: "unavailable" });
  assertEquals((await call(post({}, null), routes())).response.status, 401);
  const limited = routes({ "POST /rest/v1/rpc/billing_claim": { status: 400, body: { code: "53400" } } });
  assertEquals((await call(post(), limited)).response.status, 429);
  const down = routes({ "POST /v1/billing_portal/sessions": { status: 500, body: {} } });
  assertEquals((await call(post(), down)).response.status, 502);
  const get = new Request("http://functions.test/billing-portal", { headers: { Authorization: `Bearer ${JWT}` } });
  assertEquals((await call(get, routes())).response.status, 405);
  assertEquals(
    (await call(new Request("http://functions.test/billing-portal", { method: "OPTIONS" }), routes())).response.status,
    204,
  );
});

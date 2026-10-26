/**
 * `deno test` - `billing-cancel` (and `cancelOwnerSubscriptions`, which
 * R6.5's account deletion uses) against a fake PostgREST and Stripe.
 */

import { handle } from "./handler.ts";
import { cancelOwnerSubscriptions } from "../_shared/billing/cancel.ts";
import {
  assertEquals,
  fakeFetch,
  JWT,
  type Route,
  SERVICE_KEY,
  testEnv,
  unconfiguredEnv,
  USER_ID,
} from "../_shared/billing/test_util.ts";
import type { BillingEnv } from "../_shared/billing/config.ts";

const ENV = testEnv();

function routes(overrides: Record<string, Route> = {}, customer: string | null = "cus_rail1"): Record<string, Route> {
  return {
    "POST /rest/v1/rpc/billing_account": {
      body: [{
        customer_id: customer,
        subscription_id: "sub_a",
        plan: "pro",
        plan_status: "active",
        current_period_end: null,
        early_user: true,
      }],
    },
    "GET /v1/subscriptions": {
      body: {
        object: "list",
        has_more: false,
        data: [
          { id: "sub_a", status: "active" },
          { id: "sub_b", status: "past_due" },
          { id: "sub_c", status: "canceled" },
          { id: "sub_d", status: "incomplete_expired" },
        ],
      },
    },
    "DELETE /v1/subscriptions/sub_a": { body: { id: "sub_a", status: "canceled" } },
    "DELETE /v1/subscriptions/sub_b": { body: { id: "sub_b", status: "canceled" } },
    ...overrides,
  };
}

function post(body: unknown, token: string | null = SERVICE_KEY): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://functions.test/billing-cancel", { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(request: Request, fake: Record<string, Route>, env: BillingEnv = ENV) {
  const { fetchFn, calls } = fakeFetch(fake);
  const response = await handle(request, env, fetchFn);
  return { response, body: await response.json().catch(() => null), calls };
}

Deno.test("cancel: every live subscription of the account's customer, now; the ended ones left alone", async () => {
  const { response, body, calls } = await call(post({ owner: USER_ID }), routes());
  assertEquals([response.status, body], [200, { canceled: 2, hadCustomer: true }]);
  assertEquals(calls.map((c) => c.key), [
    "POST /rest/v1/rpc/billing_account",
    "GET /v1/subscriptions",
    "DELETE /v1/subscriptions/sub_a",
    "DELETE /v1/subscriptions/sub_b",
  ]);
  assertEquals(Object.fromEntries(calls[1].form!), { customer: "cus_rail1", status: "all", limit: "100" });
});

Deno.test("cancel: an account that never paid -> nothing to do, even with Stripe unset", async () => {
  const { response, body, calls } = await call(post({ owner: USER_ID }), routes({}, null), unconfiguredEnv());
  assertEquals([response.status, body, calls.length], [200, { canceled: 0, hadCustomer: false }, 1]);
});

Deno.test("cancel: a customer but Stripe unset, or Stripe down -> 503 (do not delete the account yet)", async () => {
  assertEquals((await call(post({ owner: USER_ID }), routes(), unconfiguredEnv())).response.status, 503);
  const down = routes({ "DELETE /v1/subscriptions/sub_b": { status: 500, body: {} } });
  assertEquals((await call(post({ owner: USER_ID }), down)).response.status, 503);
  const noProfile = routes({ "POST /rest/v1/rpc/billing_account": { body: [] } });
  assertEquals((await call(post({ owner: USER_ID }), noProfile)).response.status, 404);
});

Deno.test("cancel: only the service role key; a user's token or nothing is refused", async () => {
  for (const token of [null, JWT, `${SERVICE_KEY}x`]) {
    const { response, calls } = await call(post({ owner: USER_ID }, token), routes());
    assertEquals([response.status, calls.length], [401, 0], String(token));
  }
  assertEquals((await call(post({ owner: "not-a-uuid" }), routes())).response.status, 400);
  assertEquals((await call(new Request("http://functions.test/billing-cancel"), routes())).response.status, 405);
});

Deno.test("cancelOwnerSubscriptions pages through a long list", async () => {
  let page = 0;
  const fake = routes({
    "GET /v1/subscriptions": (c) => {
      page++;
      return c.form?.get("starting_after") === "sub_a"
        ? { body: { has_more: false, data: [{ id: "sub_b", status: "trialing" }] } }
        : { body: { has_more: true, data: [{ id: "sub_a", status: "active" }] } };
    },
  });
  const { fetchFn } = fakeFetch(fake);
  assertEquals(await cancelOwnerSubscriptions(ENV, USER_ID, fetchFn), { ok: true, canceled: 2, hadCustomer: true });
  assertEquals(page, 2);
});

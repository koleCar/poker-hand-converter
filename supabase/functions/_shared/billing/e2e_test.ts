/**
 * The three billing functions end to end against a **local** Supabase stack
 * (real GoTrue, PostgREST and the R6.2 / R6.3 migrations), with Stripe
 * played by a fake (no network beyond 127.0.0.1, no Stripe account).
 * Skipped unless asked for - CI runs `deno test --allow-read=.`:
 *
 *   RAIL_BILLING_E2E_URL=http://127.0.0.1:<api port> \
 *   RAIL_BILLING_E2E_ANON_KEY=... RAIL_BILLING_E2E_SERVICE_KEY=... \
 *     deno test --allow-read=. --allow-env --allow-net=127.0.0.1 _shared/billing/e2e_test.ts
 *
 * (the keys from `supabase status -o env`; a local stack only - the test
 * creates a user, and refuses any URL that is not 127.0.0.1 / localhost).
 *
 * Checkout links a customer and opens a session; signed events then move the
 * plan (incomplete -> active -> a late older event ignored -> the same
 * event again ignored -> past due -> canceled) and `my_entitlements()` shows
 * each state to the user; the portal opens; the cancel path cancels. The
 * checkout's consent is recorded (sealed from the client), linked to the
 * session, and loses its owner when the account is deleted.
 */

import { handle as checkout } from "../../billing-checkout/handler.ts";
import { handle as portal } from "../../billing-portal/handler.ts";
import { handle as webhook } from "../../billing-webhook/handler.ts";
import { handle as cancel } from "../../billing-cancel/handler.ts";
import { assert, assertEquals, CONSENT, newWebhookSecret, stripeSubscription, testEnv } from "./test_util.ts";
import { signPayload } from "./stripe.ts";

const granted = (variable: string) => Deno.permissions.querySync({ name: "env", variable }).state === "granted";
const enabled = granted("RAIL_BILLING_E2E_URL") && Boolean(Deno.env.get("RAIL_BILLING_E2E_URL"));

Deno.test({
  name: "billing end to end on a local stack (fake Stripe)",
  ignore: !enabled,
  async fn() {
    const url = Deno.env.get("RAIL_BILLING_E2E_URL")!.replace(/\/+$/, "");
    assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url), "a local stack only");
    const anonKey = Deno.env.get("RAIL_BILLING_E2E_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("RAIL_BILLING_E2E_SERVICE_KEY") ?? "";
    const secret = newWebhookSecret();
    const env = testEnv({ supabaseUrl: url, anonKey, serviceRoleKey: serviceKey, stripeWebhookSecret: secret });

    // A fresh confirmed user, signed in.
    const email = `billing-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const password = crypto.randomUUID();
    const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
    const created = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    assertEquals(created.status, 200, "user created");
    const userId = (await created.json()).id as string;
    const token = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      // The stack's Turnstile test secret accepts any token.
      body: JSON.stringify({ email, password, gotrue_meta_security: { captcha_token: "XXXX.DUMMY.TOKEN.XXXX" } }),
    });
    const session = await token.json();
    const jwt = session.access_token as string;
    assert(typeof jwt === "string", `signed in (${token.status} ${session.error_code ?? ""})`);

    // Stripe, played here; everything else is the real stack.
    const customer = `cus_e2e${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let stripeState: Record<string, unknown> = stripeSubscription({ customer, status: "incomplete" });
    const stripeCalls: string[] = [];
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(input));
      if (target.hostname !== "api.stripe.com") return fetch(input, init);
      const key = `${init?.method ?? "GET"} ${target.pathname}`;
      stripeCalls.push(key);
      const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      if (key === "POST /v1/customers") return reply({ id: customer });
      if (key === "POST /v1/checkout/sessions") {
        return reply({ id: "cs_test_e2e", url: "https://checkout.stripe.com/c/pay/cs_test_e2e" });
      }
      if (key === "POST /v1/billing_portal/sessions") return reply({ url: "https://billing.stripe.com/p/session/e2e" });
      if (key === "GET /v1/subscriptions/sub_rail1") return reply(stripeState);
      if (key === "GET /v1/subscriptions") return reply({ has_more: false, data: [stripeState] });
      if (key === "DELETE /v1/subscriptions/sub_rail1") return reply({ ...stripeState, status: "canceled" });
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof fetch;

    const rpc = async (name: string, body: unknown, bearer = serviceKey) => {
      const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const account = async () => (await rpc("billing_account", { p_owner: userId })).body[0];
    const mine = async () => (await rpc("my_entitlements", {}, jwt)).body;

    // A client cannot reach the service-role functions (PostgREST: 401 or 403
    // for a missing privilege, depending on its version).
    for (
      const name of [
        "billing_account",
        "billing_set_customer",
        "billing_apply_subscription",
        "billing_record_consent",
        "billing_consent_set_session",
      ]
    ) {
      const status = (await rpc(name, { p_owner: userId }, jwt)).status;
      assert(status === 401 || status === 403 || status === 404, `${name}: client refused (${status})`);
    }

    // Checkout: a customer is created and linked, a session opened.
    const opened = await checkout(
      new Request("http://local/billing-checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ period: "month", locale: "hr", consent: CONSENT }),
      }),
      env,
      fetchFn,
    );
    assertEquals(opened.status, 200, "checkout opens");
    assertEquals((await account()).customer_id, customer);

    // The consent: recorded for this account, linked to the session; the
    // client can neither read nor write it.
    const consents = async (bearer = serviceKey) => {
      const response = await fetch(
        `${url}/rest/v1/billing_consents?select=owner_id,kinds,locale,period,text_version,checkout_session_id` +
          `&owner_id=eq.${userId}&order=consented_at`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${bearer}` } },
      );
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const recorded = await consents();
    assertEquals(recorded.status, 200, "the service role reads the consents");
    assertEquals(recorded.body, [{
      owner_id: userId,
      kinds: ["terms", "immediate_performance"],
      locale: "hr",
      period: "month",
      text_version: CONSENT.version,
      checkout_session_id: "cs_test_e2e",
    }]);
    const sealed = await consents(jwt);
    assert(sealed.status === 401 || sealed.status === 403, `consents sealed from the client (${sealed.status})`);

    let now = Math.floor(Date.now() / 1000);
    const deliver = async (id: string, type: string, created: number, object: Record<string, unknown>) => {
      const payload = JSON.stringify({ id, object: "event", type, created, livemode: false, data: { object } });
      const response = await webhook(
        new Request("http://local/billing-webhook", {
          method: "POST",
          headers: { "Stripe-Signature": await signPayload(secret, payload, now) },
          body: payload,
        }),
        env,
        { fetchFn, nowSeconds: now },
      );
      assertEquals(response.status, 200, `${id} accepted`);
      return (await response.json()).outcome as string;
    };
    const subObject = { object: "subscription", id: "sub_rail1", customer };
    const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);

    assertEquals(await deliver(`evt_${run}_1`, "customer.subscription.created", now, subObject), "applied");
    assertEquals((await mine()).subscription.plan, "free", "incomplete: not Pro yet");

    stripeState = stripeSubscription({ customer });
    assertEquals(
      await deliver(`evt_${run}_2`, "invoice.paid", now + 1, {
        object: "invoice",
        customer,
        subscription: "sub_rail1",
      }),
      "applied",
    );
    let e = await mine();
    assertEquals([e.subscription.plan, e.subscription.status, e.subscription.period], ["pro", "active", "month"]);

    // A late, older event and a redelivery change nothing.
    stripeState = stripeSubscription({ customer, status: "canceled", ended_at: now - 100 });
    assertEquals(await deliver(`evt_${run}_0`, "customer.subscription.updated", now - 5, subObject), "stale");
    assertEquals(
      await deliver(`evt_${run}_2`, "invoice.paid", now + 1, {
        object: "invoice",
        customer,
        subscription: "sub_rail1",
      }),
      "duplicate",
    );
    assertEquals((await mine()).subscription.status, "active");

    // A failed renewal, then the end.
    stripeState = stripeSubscription({ customer, status: "past_due" });
    assertEquals(
      await deliver(`evt_${run}_3`, "invoice.payment_failed", now + 2, {
        object: "invoice",
        customer,
        subscription: "sub_rail1",
      }),
      "applied",
    );
    assertEquals((await mine()).subscription.status, "past_due");

    // The portal opens for a customer.
    const portalResponse = await portal(
      new Request("http://local/billing-portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
      fetchFn,
    );
    assertEquals(portalResponse.status, 200, "portal opens");

    // The cancel path (R6.5) cancels the live subscription; the deletion event lands.
    const cancelled = await cancel(
      new Request("http://local/billing-cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ owner: userId }),
      }),
      env,
      fetchFn,
    );
    assertEquals(await cancelled.json(), { canceled: 1, hadCustomer: true });
    now += 10;
    const ended = Math.floor(Date.now() / 1000) - 1;
    stripeState = stripeSubscription({ customer, status: "canceled", ended_at: ended, canceled_at: ended });
    assertEquals(await deliver(`evt_${run}_4`, "customer.subscription.deleted", now, subObject), "applied");
    e = await mine();
    assertEquals([e.subscription.status, e.subscription.plan], ["canceled", "pro"]);
    assert(stripeCalls.includes("DELETE /v1/subscriptions/sub_rail1"), "Stripe asked to cancel");

    // Checkout again after the end: allowed (the subscription is over).
    const again = await checkout(
      new Request("http://local/billing-checkout", {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ period: "year", locale: "en", consent: CONSENT }),
      }),
      env,
      fetchFn,
    );
    assertEquals(again.status, 200, "a new checkout after the end");

    // Clean up the user (cascades to the profile; the log keeps no owner).
    await (await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: admin })).body?.cancel();
    // The fake Stripe answers every session with the same id: the second
    // checkout's consent keeps no session id (the column is unique), the
    // first keeps its own - both stay, without their owner.
    const kept = await fetch(
      `${url}/rest/v1/billing_consents?select=owner_id,period&checkout_session_id=eq.cs_test_e2e`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${serviceKey}` } },
    );
    assertEquals(await kept.json(), [{ owner_id: null, period: "month" }], "the consent stays, without its owner");
  },
});

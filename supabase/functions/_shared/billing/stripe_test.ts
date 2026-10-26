/**
 * `deno test` - the Stripe pieces without the network: form encoding, the
 * request's headers, errors without secrets, and the webhook signature
 * (Stripe's scheme; a header made by the official SDK; tampered, re-signed
 * with another secret, too old, too new, malformed).
 */

import { assert, assertEquals, fakeFetch, fakeKey, newWebhookSecret } from "./test_util.ts";
import {
  encodeForm,
  keyMode,
  signPayload,
  StripeError,
  stripeRequest,
  timingSafeEqual,
  verifyStripeSignature,
} from "./stripe.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const KEY = fakeKey("test");

Deno.test("form encoding: nested objects and arrays in Stripe's bracket form; null and undefined left out", () => {
  assertEquals(
    decodeURIComponent(encodeForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      automatic_tax: { enabled: true },
      discounts: undefined,
      metadata: { owner_id: "u-1", skip: null },
    })),
    "mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&automatic_tax[enabled]=true&metadata[owner_id]=u-1",
  );
  assertEquals(encodeForm({ email: "a+b@x.test" }), "email=a%2Bb%40x.test");
});

Deno.test("key mode: test, live, restricted; anything else is no key", () => {
  assertEquals(keyMode(fakeKey("test")), "test");
  assertEquals(keyMode(fakeKey("live", "rk")), "live");
  assertEquals(keyMode(""), null);
  assertEquals(keyMode("pk_test_abcdefgh123"), null);
  assertEquals(keyMode("sk_test_short"), null);
});

Deno.test("requests pin the API version, send the key only as a bearer, put GET params in the query", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ id: "x" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const options = { secretKey: KEY, apiVersion: "2025-03-31.basil", fetchFn };
  await stripeRequest(options, "GET", "/v1/subscriptions", { customer: "cus_1", status: "all" });
  await stripeRequest(options, "POST", "/v1/customers", { email: "e@x.test" }, "idem-1");
  const get = new Headers(calls[0].init.headers);
  assertEquals(calls[0].url, "https://api.stripe.com/v1/subscriptions?customer=cus_1&status=all");
  assertEquals(get.get("stripe-version"), "2025-03-31.basil");
  assertEquals(get.get("authorization"), `Bearer ${KEY}`);
  assertEquals(calls[0].init.body, undefined);
  const post = new Headers(calls[1].init.headers);
  assertEquals(calls[1].url, "https://api.stripe.com/v1/customers");
  assertEquals(calls[1].init.body, "email=e%40x.test");
  assertEquals(post.get("idempotency-key"), "idem-1");
  assertEquals(post.get("content-type"), "application/x-www-form-urlencoded");
});

Deno.test("a Stripe refusal becomes a StripeError with status, type and code - never the key", async () => {
  const fetchFn = fakeFetch({
    "GET /v1/prices/price_x": {
      status: 404,
      body: { error: { type: "invalid_request_error", code: "resource_missing", message: "No such price" } },
    },
  }).fetchFn;
  try {
    await stripeRequest({ secretKey: KEY, apiVersion: "v", fetchFn }, "GET", "/v1/prices/price_x");
    throw new Error("no error");
  } catch (error) {
    assert(error instanceof StripeError, "a StripeError");
    assertEquals([error.status, error.type, error.code], [404, "invalid_request_error", "resource_missing"]);
    assert(!error.message.includes("sk_test"), "no key in the message");
  }
  const down = (() => Promise.reject(new TypeError("dns"))) as unknown as typeof fetch;
  try {
    await stripeRequest({ secretKey: KEY, apiVersion: "v", fetchFn: down }, "GET", "/v1/x");
    throw new Error("no error");
  } catch (error) {
    assert(error instanceof StripeError && error.status === 0, "unreachable is status 0");
  }
});

Deno.test("signature: a header made by Stripe's official SDK verifies (testdata/sdk_vector.json)", async () => {
  const vector = JSON.parse(await Deno.readTextFile(new URL("./testdata/sdk_vector.json", import.meta.url)));
  const result = await verifyStripeSignature(enc(vector.payload), vector.header, vector.secret, {
    nowSeconds: vector.timestamp + 10,
  });
  assertEquals(result, { ok: true, timestamp: vector.timestamp });
  // Our own signer produces the SDK's header byte for byte.
  assertEquals(await signPayload(vector.secret, vector.payload, vector.timestamp), vector.header);
});

Deno.test("signature: our signed fixture verifies; tampered, other secret, old, future and malformed do not", async () => {
  const secret = newWebhookSecret();
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid" });
  const now = 1_800_000_000;
  const header = await signPayload(secret, payload, now);
  const verify = (body: string, h: string | null, s = secret, at = now) =>
    verifyStripeSignature(enc(body), h, s, { nowSeconds: at });

  assertEquals(await verify(payload, header), { ok: true, timestamp: now });
  assertEquals((await verify(payload.replace("invoice.paid", "invoice.payment_failed"), header)).ok, false);
  assertEquals(await verify(payload + " ", header), { ok: false, reason: "mismatch" });
  assertEquals(await verify(payload, header, newWebhookSecret()), { ok: false, reason: "mismatch" });
  assertEquals(await verify(payload, header, secret, now + 301), { ok: false, reason: "outside_tolerance" });
  assertEquals(await verify(payload, header, secret, now - 301), { ok: false, reason: "outside_tolerance" });
  assertEquals((await verify(payload, header, secret, now + 300)).ok, true);
  assertEquals(await verify(payload, null), { ok: false, reason: "no_header" });
  assertEquals(await verify(payload, "garbage"), { ok: false, reason: "bad_header" });
  assertEquals(await verify(payload, `t=${now}`), { ok: false, reason: "bad_header" });
  assertEquals(await verify(payload, `v1=${"0".repeat(64)}`), { ok: false, reason: "bad_header" });
  assertEquals(await verify(payload, header, ""), { ok: false, reason: "no_secret" });
  // A re-signed timestamp without the secret: the signature no longer matches.
  assertEquals(await verify(payload, header.replace(`t=${now}`, `t=${now + 1000}`), secret, now + 1000), {
    ok: false,
    reason: "mismatch",
  });
});

Deno.test("signature: any v1 may match (a secret being rolled); v0 is ignored", async () => {
  const secret = newWebhookSecret();
  const payload = '{"id":"evt_2"}';
  const now = 1_800_000_000;
  const good = (await signPayload(secret, payload, now)).split("v1=")[1];
  const header = `t=${now},v1=${"a".repeat(64)},v1=${good},v0=${"b".repeat(64)}`;
  assertEquals((await verifyStripeSignature(enc(payload), header, secret, { nowSeconds: now })).ok, true);
  const onlyV0 = `t=${now},v0=${good}`;
  assertEquals((await verifyStripeSignature(enc(payload), onlyV0, secret, { nowSeconds: now })).ok, false);
});

Deno.test("timingSafeEqual", () => {
  assert(timingSafeEqual("abc", "abc"), "equal");
  assert(!timingSafeEqual("abc", "abd"), "differs");
  assert(!timingSafeEqual("abc", "abcd"), "length");
  assert(!timingSafeEqual("", "a"), "empty");
});

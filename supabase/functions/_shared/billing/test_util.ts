/**
 * Test helpers for the billing functions: assertions, a fake `fetch` that
 * plays GoTrue, PostgREST and Stripe (no network), a test environment, and a
 * locally generated webhook secret.
 */

import type { BillingEnv } from "./config.ts";

export function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** `whsec_` + 32 random bytes, made here for one test: no endpoint's secret. */
export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A made-up key of a mode, assembled at run time so no key-shaped literal is
 * in the repository (secret scanners): never a real key.
 */
export function fakeKey(mode: "test" | "live", prefix: "sk" | "rk" = "sk"): string {
  return [prefix, mode, "0".repeat(16) + "rail"].join("_");
}

export const USER_ID = "00000000-0000-0000-0000-0000000b1001";
export const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
export const SERVICE_KEY = "service-role-key-for-tests-0001";

export function testEnv(overrides: Partial<BillingEnv> = {}): BillingEnv {
  return {
    supabaseUrl: "http://supabase.test",
    anonKey: "anon-key",
    serviceRoleKey: SERVICE_KEY,
    stripeSecretKey: fakeKey("test"),
    stripeWebhookSecret: "",
    stripeApiVersion: "2025-03-31.basil",
    priceMonth: "price_promonth",
    priceYear: "price_proyear",
    earlyUserCoupon: "EARLY30",
    portalConfiguration: "",
    successUrl: "https://rail.test/billing/success",
    cancelUrl: "https://rail.test/billing/cancel",
    portalReturnUrl: "https://rail.test/settings#plan",
    ...overrides,
  };
}

/** No Stripe configuration at all: what production has until the owner sets it. */
export function unconfiguredEnv(): BillingEnv {
  return testEnv({
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    priceMonth: "",
    priceYear: "",
    earlyUserCoupon: "",
    successUrl: "",
    cancelUrl: "",
    portalReturnUrl: "",
  });
}

export interface Reply {
  status?: number;
  body?: unknown;
}

export type Route = Reply | ((call: Call) => Reply);

export interface Call {
  method: string;
  url: string;
  /** `METHOD /path` without host or query. */
  key: string;
  headers: Headers;
  body: string | null;
  /** The body, parsed: JSON for PostgREST, form fields for Stripe. */
  json: Record<string, unknown> | null;
  form: URLSearchParams | null;
}

/** A fetch answering `"METHOD /path"` routes (404 otherwise), recording every call. */
export function fakeFetch(routes: Record<string, Route>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const headers = new Headers(init?.headers);
    const contentType = headers.get("content-type") ?? "";
    let json: Record<string, unknown> | null = null;
    if (body && contentType.includes("json")) json = JSON.parse(body);
    const form = body && contentType.includes("x-www-form-urlencoded")
      ? new URLSearchParams(body)
      : method !== "POST"
      ? url.searchParams
      : null;
    const call: Call = { method, url: url.toString(), key: `${method} ${url.pathname}`, headers, body, json, form };
    calls.push(call);
    const route = routes[call.key];
    const reply: Reply = route === undefined ? { status: 404, body: { error: { type: "not_found" } } } : (
      typeof route === "function" ? route(call) : route
    );
    const status = reply.status ?? 200;
    return Promise.resolve(
      new Response(status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { fetchFn, calls };
}

export const CONFIRMED_USER = {
  id: USER_ID,
  email: "player@example.test",
  email_confirmed_at: "2026-10-01T10:00:00Z",
};

/** A subscription as Stripe's 2025-03-31 API returns it (period on the items). */
export function stripeSubscription(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_rail1",
    object: "subscription",
    customer: "cus_rail1",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    livemode: false,
    items: {
      object: "list",
      data: [{
        id: "si_1",
        object: "subscription_item",
        current_period_start: 1_790_000_000,
        current_period_end: 1_792_592_000,
        price: { id: "price_promonth", object: "price", recurring: { interval: "month", interval_count: 1 } },
      }],
    },
    ...fields,
  };
}

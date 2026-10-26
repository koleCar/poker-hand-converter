/**
 * `deno test` - Stripe's subscription -> the plan (`planFromSubscription`),
 * for every status, both API shapes, and which subscription an event is about.
 */

import { assertEquals, stripeSubscription } from "./test_util.ts";
import { periodBounds, planFromSubscription, subscriptionOfEvent } from "./subscription.ts";

const START = "2026-09-21T14:13:20.000Z"; // 1_790_000_000
const END = "2026-10-21T14:13:20.000Z"; // 1_792_592_000

Deno.test("active and trialing: Pro, as is, to the period's end; the period from the price", () => {
  assertEquals(planFromSubscription(stripeSubscription()), {
    plan: "pro",
    period: "month",
    status: "active",
    currentPeriodEnd: END,
  });
  const yearly = stripeSubscription({
    status: "trialing",
    items: {
      data: [{
        current_period_start: 1_790_000_000,
        current_period_end: 1_792_592_000,
        price: { recurring: { interval: "year" } },
      }],
    },
  });
  assertEquals(planFromSubscription(yearly), {
    plan: "pro",
    period: "year",
    status: "trialing",
    currentPeriodEnd: END,
  });
});

Deno.test("set to cancel: canceled (no grace) at the period's end, or at cancel_at", () => {
  assertEquals(planFromSubscription(stripeSubscription({ cancel_at_period_end: true })), {
    plan: "pro",
    period: "month",
    status: "canceled",
    currentPeriodEnd: END,
  });
  assertEquals(
    planFromSubscription(stripeSubscription({ cancel_at: 1_791_000_000 })).currentPeriodEnd,
    new Date(1_791_000_000_000).toISOString(),
  );
});

Deno.test("past_due and unpaid: past_due from the period's start (when the renewal fell due)", () => {
  assertEquals(planFromSubscription(stripeSubscription({ status: "past_due" })), {
    plan: "pro",
    period: "month",
    status: "past_due",
    currentPeriodEnd: START,
  });
  assertEquals(planFromSubscription(stripeSubscription({ status: "unpaid" })).status, "past_due");
});

Deno.test("canceled: to when it really ended", () => {
  assertEquals(planFromSubscription(stripeSubscription({ status: "canceled", ended_at: 1_791_000_000 })), {
    plan: "pro",
    period: "month",
    status: "canceled",
    currentPeriodEnd: new Date(1_791_000_000_000).toISOString(),
  });
  assertEquals(
    planFromSubscription(stripeSubscription({ status: "canceled", canceled_at: 1_790_500_000 })).currentPeriodEnd,
    new Date(1_790_500_000_000).toISOString(),
  );
  assertEquals(planFromSubscription(stripeSubscription({ status: "canceled" })).currentPeriodEnd, END);
});

Deno.test("not paid for (incomplete, incomplete_expired, paused, unknown): Free, no status", () => {
  for (const status of ["incomplete", "incomplete_expired", "paused", "something_new", undefined]) {
    assertEquals(planFromSubscription(stripeSubscription({ status })), {
      plan: "free",
      period: "month",
      status: null,
      currentPeriodEnd: null,
    }, String(status));
  }
  assertEquals(planFromSubscription(null), { plan: "free", period: null, status: null, currentPeriodEnd: null });
});

Deno.test("the period's bounds before 2025-03-31 (on the subscription) and after (on the items)", () => {
  assertEquals(periodBounds({ current_period_start: 10, current_period_end: 20 }), { start: 10, end: 20 });
  assertEquals(
    periodBounds({
      items: {
        data: [{ current_period_start: 10, current_period_end: 20 }, {
          current_period_start: 5,
          current_period_end: 30,
        }],
      },
    }),
    { start: 5, end: 30 },
  );
  assertEquals(
    planFromSubscription({
      status: "active",
      current_period_end: 1_792_592_000,
      plan: { interval: "year" },
      items: { data: [] },
    }),
    { plan: "pro", period: "year", status: "active", currentPeriodEnd: END },
  );
});

Deno.test("which subscription an event is about", () => {
  assertEquals(
    subscriptionOfEvent("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_1",
      customer: "cus_1",
    }),
    { subscription: "sub_1", customer: "cus_1" },
  );
  assertEquals(subscriptionOfEvent("checkout.session.completed", { mode: "payment", customer: "cus_1" }), null);
  assertEquals(
    subscriptionOfEvent("customer.subscription.updated", { object: "subscription", id: "sub_2", customer: "cus_2" }),
    { subscription: "sub_2", customer: "cus_2" },
  );
  // An invoice before 2025-03-31 and after (the subscription under parent).
  assertEquals(subscriptionOfEvent("invoice.paid", { subscription: "sub_3", customer: "cus_3" }), {
    subscription: "sub_3",
    customer: "cus_3",
  });
  assertEquals(
    subscriptionOfEvent("invoice.payment_failed", {
      customer: { id: "cus_4" },
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_4" } },
    }),
    { subscription: "sub_4", customer: "cus_4" },
  );
  assertEquals(subscriptionOfEvent("invoice.paid", { customer: "cus_5" }), null, "a one-off invoice");
  assertEquals(subscriptionOfEvent("invoice.paid", { subscription: "in_not_a_sub" }), null);
});

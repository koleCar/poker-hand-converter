/**
 * Stripe's subscription -> the plan on the profile (R6.2's
 * `billing_set_plan(owner, plan, period, status, current_period_end, ...)`).
 * Pure; `subscription_test.ts` covers every status.
 *
 * R6.2's rules (`billing_plan_state`) read the fields like this: active /
 * trialing are Pro to `current_period_end` plus the payment grace; past_due
 * is Pro to `current_period_end` plus the grace; canceled is Pro to
 * `current_period_end`, no grace; a `free` plan is Free. So:
 *
 *   Stripe                          plan   status     current_period_end
 *   active / trialing               pro    as is      the period's end
 *   ... set to cancel (at period    pro    canceled   when it ends (cancel_at,
 *       end or at a date)                             else the period's end)
 *   past_due                        pro    past_due   the period's START: when
 *                                                     the unpaid renewal fell
 *                                                     due (Stripe moves the
 *                                                     period on before it is
 *                                                     paid, so the end would
 *                                                     give a whole unpaid
 *                                                     period plus the grace)
 *   unpaid (retries exhausted)      pro    past_due   the period's start: the
 *                                                     grace has run out by
 *                                                     then, so Free, while
 *                                                     the page still says
 *                                                     "payment overdue"
 *   canceled                        pro    canceled   ended_at (when it really
 *                                                     ended), else canceled_at,
 *                                                     else the period's end
 *   incomplete / incomplete_expired free   null       null (first payment not
 *   / paused                                          made: nothing was paid)
 *
 * The period (`month` | `year`) is the first item's price interval. The
 * 2025-03-31 API moved `current_period_*` from the subscription to its items;
 * both places are read, so a webhook endpoint on either version works.
 */

export type PlanStatus = "active" | "trialing" | "past_due" | "canceled";

export interface PlanUpdate {
  plan: "free" | "pro";
  period: "month" | "year" | null;
  status: PlanStatus | null;
  /** ISO 8601, or null. */
  currentPeriodEnd: string | null;
}

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const iso = (
  seconds: number | null,
): string | null => (seconds === null ? null : new Date(seconds * 1000).toISOString());

/** A Stripe id field: a string, or an expanded object with an `id`. */
export function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 255) return value;
  const id = obj(value).id;
  return typeof id === "string" && id.length > 0 && id.length <= 255 ? id : null;
}

function items(subscription: Obj): Obj[] {
  const data = obj(subscription.items).data;
  return Array.isArray(data) ? data.map(obj) : [];
}

/** The subscription's period bounds, wherever this API version keeps them. */
export function periodBounds(subscription: Obj): { start: number | null; end: number | null } {
  let start = int(subscription.current_period_start);
  let end = int(subscription.current_period_end);
  for (const item of items(subscription)) {
    const s = int(item.current_period_start);
    const e = int(item.current_period_end);
    if (s !== null && (start === null || s < start)) start = s;
    if (e !== null && (end === null || e > end)) end = e;
  }
  return { start, end };
}

export function periodOf(subscription: Obj): "month" | "year" | null {
  const first = items(subscription)[0] ?? {};
  const interval = obj(obj(obj(first).price).recurring).interval ?? obj(subscription.plan).interval;
  return interval === "month" || interval === "year" ? interval : null;
}

export function planFromSubscription(raw: unknown): PlanUpdate {
  const sub = obj(raw);
  const period = periodOf(sub);
  const { start, end } = periodBounds(sub);
  const cancelAt = int(sub.cancel_at);
  const ending = sub.cancel_at_period_end === true || cancelAt !== null;

  switch (sub.status) {
    case "active":
    case "trialing":
      if (ending) {
        return { plan: "pro", period, status: "canceled", currentPeriodEnd: iso(cancelAt ?? end) };
      }
      return { plan: "pro", period, status: sub.status, currentPeriodEnd: iso(end) };
    case "past_due":
    case "unpaid":
      return { plan: "pro", period, status: "past_due", currentPeriodEnd: iso(start ?? end) };
    case "canceled":
      return {
        plan: "pro",
        period,
        status: "canceled",
        currentPeriodEnd: iso(int(sub.ended_at) ?? int(sub.canceled_at) ?? end),
      };
    default:
      // incomplete, incomplete_expired, paused, or anything new: not paid for.
      return { plan: "free", period, status: null, currentPeriodEnd: null };
  }
}

/** The six event types the webhook acts on. */
export const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

/**
 * The subscription (and customer) an event is about, or null when it is not
 * about one (a one-off payment, a Checkout in another mode). Only ids are
 * taken from the event: the subscription itself is read back from Stripe.
 */
export function subscriptionOfEvent(
  type: string,
  object: unknown,
): { subscription: string; customer: string | null } | null {
  const o = obj(object);
  let subscription: string | null = null;
  if (type === "checkout.session.completed") {
    if (o.mode !== "subscription") return null;
    subscription = idOf(o.subscription);
  } else if (type.startsWith("customer.subscription.")) {
    subscription = o.object === "subscription" ? idOf(o.id) : null;
  } else if (type.startsWith("invoice.")) {
    subscription = idOf(o.subscription) ??
      idOf(obj(obj(o.parent).subscription_details).subscription);
  }
  if (!subscription || !subscription.startsWith("sub_")) return null;
  return { subscription, customer: idOf(o.customer) };
}

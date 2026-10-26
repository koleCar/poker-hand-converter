/**
 * The deletion's billing step (docs/RAIL-PLAN.md R6.5): before an account is
 * deleted, its subscriptions must stop - a deleted account that is still
 * charged is the worst outcome of the whole flow, so the step fails closed.
 *
 * - No payment-provider customer or subscription on the profile (every
 *   account that never paid): nothing to do, no call.
 * - Otherwise R6.3's `cancelOwnerSubscriptions` (`_shared/billing/
 *   cancel.ts`, the same code the `billing-cancel` function runs) cancels
 *   every live subscription of the account's Stripe customer **now**:
 *     - done, or "no profile" (nothing left to bill): the deletion goes on;
 *     - "Stripe not configured" (no secret key on the project): nobody can
 *       be billed, so the deletion goes on (the log says so);
 *     - Stripe or the database unreachable / refusing (it throws): the step
 *       fails, nothing else is touched, and the next call tries again.
 *
 * The Stripe customer and its invoices are kept by Stripe as tax records
 * (the privacy policy says so); only the subscriptions are canceled.
 */

import { cancelOwnerSubscriptions, type CancelResult } from "../_shared/billing/cancel.ts";
import { type BillingEnv, billingEnvFromDeno } from "../_shared/billing/config.ts";

export interface BillingInfo {
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
}

/** Cancels an account's subscriptions; R6.3's in production, a fake in the tests. */
export type Canceller = (owner: string, fetchFn: typeof fetch) => Promise<CancelResult>;

/** R6.3's cancellation over a billing environment. */
export function cancellerFor(env: BillingEnv): Canceller {
  return (owner, fetchFn) => cancelOwnerSubscriptions(env, owner, fetchFn);
}

/** Production: the function's own environment (the service role, the Stripe key). */
export const stripeCanceller: Canceller = (owner, fetchFn) => cancellerFor(billingEnvFromDeno())(owner, fetchFn);

export type BillingOutcome = "none" | "canceled" | "stripe_not_configured";

export class BillingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingUnavailable";
  }
}

export function billingFrom(value: unknown): BillingInfo {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : null);
  return { customerId: text(v.customerId), subscriptionId: text(v.subscriptionId), status: text(v.status) };
}

export async function cancelForDeletion(
  cancel: Canceller,
  userId: string,
  billing: BillingInfo,
  fetchFn: typeof fetch,
): Promise<BillingOutcome> {
  if (billing.customerId === null && billing.subscriptionId === null) {
    return "none";
  }
  let result: CancelResult;
  try {
    result = await cancel(userId, fetchFn);
  } catch (error) {
    throw new BillingUnavailable(error instanceof Error ? error.message : "the cancellation failed");
  }
  if (result.ok) return result.canceled > 0 ? "canceled" : "none";
  if (result.error === "no_profile") return "none";
  return "stripe_not_configured";
}

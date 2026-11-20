/**
 * The Pro waitlist (owner, 2026-11-19): until Stripe is connected nobody can
 * subscribe, so every "Upgrade to Pro" opens "Pro is coming" instead of the
 * checkout, and takes an email address for one message when Pro opens
 * (`20271119210000_pro_waitlist.sql`).
 *
 * The checkout flow (`checkout.ts`, `CheckoutDialog`) is untouched: once
 * `billing-checkout` answers `available: true` for a signed-in account, its
 * upgrade goes there again by itself ({@link upgradeRoute}).
 */

import type { BillingOffer } from "./checkout";
import { DatabaseRpcError, rpc } from "../db/client";

/** Where "Upgrade to Pro" leads for one reader. */
export type UpgradeRoute =
  /** Paid plans are not open (or cannot be known: signed out): "Pro is coming". */
  | "waitlist"
  /** Stripe is configured: the confirmation, then Checkout. */
  | "checkout"
  /** Signed in, the offer not read yet: the button waits. */
  | "wait";

/**
 * A visitor cannot ask `billing-checkout` (it needs an account), so they are
 * treated as "not open" and get the waitlist. When paid plans open, change
 * the signed-out answer to `"checkout"` (the pricing page then asks them to
 * sign in first, as it did before the waitlist).
 */
export function upgradeRoute(signedIn: boolean, offer: BillingOffer | null): UpgradeRoute {
  if (!signedIn) return "waitlist";
  if (offer === null) return "wait";
  return offer.available ? "checkout" : "waitlist";
}

/** Where the dialog was opened (stored with the address). */
export type WaitlistSource = "pricing" | "settings" | "app";

export type WaitlistError = "invalid_email" | "rate_limited" | "failed";

export type WaitlistResult = { ok: true; already: boolean } | { ok: false; error: WaitlistError };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The server's own check, so the form can say so before sending. */
export function looksLikeEmail(value: string): boolean {
  const email = value.trim();
  return email.length >= 3 && email.length <= 254 && EMAIL.test(email);
}

/** Adds an address (idempotent). `already` is true only for the caller's own address. */
export async function joinProWaitlist(
  email: string,
  source: WaitlistSource,
  locale: "en" | "hr",
): Promise<WaitlistResult> {
  if (!looksLikeEmail(email)) return { ok: false, error: "invalid_email" };
  try {
    const data = await rpc<{ ok?: unknown; already?: unknown } | null>("join_pro_waitlist", {
      p_email: email.trim(),
      p_source: source,
      p_locale: locale,
    });
    return { ok: true, already: data?.already === true };
  } catch (error) {
    const code = error instanceof DatabaseRpcError ? error.code : null;
    if (code === "22023") return { ok: false, error: "invalid_email" };
    if (code === "53400") return { ok: false, error: "rate_limited" };
    return { ok: false, error: "failed" };
  }
}

/** Whether the signed-in account is on the list; null when it cannot be told. */
export async function myProWaitlist(): Promise<{ joined: boolean; email: string | null } | null> {
  try {
    const data = await rpc<{ joined?: unknown; email?: unknown } | null>("my_pro_waitlist");
    return { joined: data?.joined === true, email: typeof data?.email === "string" ? data.email : null };
  } catch {
    return null;
  }
}

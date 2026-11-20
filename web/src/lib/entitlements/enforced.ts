"use client";

/**
 * Whether paid plans are enforced, for a visitor who is not signed in
 * (`billing_enforced()`, `20270929090000_billing_enforced.sql`: the switch
 * and nothing else, callable with the anon key).
 *
 * A signed-in account learns it from `my_entitlements().enforced`; a
 * signed-out visitor has no account to ask with, and the Free-tier display
 * (the bar's "Pricing", the solver's "sign in to open flops") must stay off
 * while enforcement is. Asked once per page load; any failure is "off",
 * today's behaviour.
 */

import { useEffect, useState } from "react";
import { isDatabaseConfigured, rpc } from "../db/client";

let asked: Promise<boolean> | null = null;
let known: boolean | null = null;

export function fetchBillingEnforced(): Promise<boolean> {
  if (!isDatabaseConfigured) return Promise.resolve(false);
  asked ??= rpc<boolean>("billing_enforced").then(
    (value) => (known = value === true),
    () => (known = false),
  );
  return asked;
}

/** The switch for a signed-out visitor: null while asking, or when `ask` is false. */
export function useBillingEnforced(ask: boolean): boolean | null {
  const [value, setValue] = useState<boolean | null>(known);
  useEffect(() => {
    if (!ask) return;
    let active = true;
    void fetchBillingEnforced().then((on) => {
      if (active) setValue(on);
    });
    return () => {
      active = false;
    };
  }, [ask]);
  return ask ? value : null;
}

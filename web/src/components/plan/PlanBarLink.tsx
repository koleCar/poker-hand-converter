"use client";

/**
 * The bar's way to Pro (the pricing round's PR-Locks): a gold "Upgrade" for
 * a signed-in Free account, a plain "Pricing" link for a signed-out visitor,
 * nothing for Pro. Only while paid plans are enforced: with enforcement off
 * the bar is as it was.
 */

import Link from "next/link";
import { useAuth } from "../../lib/auth";
import { isFreeEnforced } from "../../lib/db/entitlements";
import { useBillingEnforced } from "../../lib/entitlements/enforced";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./plan.module.css";

export function PlanBarLink() {
  const t = useDict().pricing.bar;
  const auth = useAuth();
  const { entitlements } = useEntitlements();
  const signedOut = auth.configured && auth.status === "signed-out";
  const enforced = useBillingEnforced(signedOut);

  if (signedOut) {
    return enforced ? (
      <Link href={paths.pricing()} className="btn btn--ghost btn--sm">
        {t.pricing}
      </Link>
    ) : null;
  }
  return isFreeEnforced(entitlements) ? (
    <Link href={paths.pricing()} className={`btn btn--sm ${styles.gold}`}>
      {t.upgrade}
    </Link>
  ) : null;
}

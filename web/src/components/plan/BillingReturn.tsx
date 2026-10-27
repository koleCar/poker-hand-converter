"use client";

/**
 * The pages Stripe Checkout returns to (Rail R6.3): `/billing/success` and
 * `/billing/cancel`.
 *
 * Neither trusts the address: arriving on the success page grants nothing.
 * The plan changes only when Stripe's webhook has recorded the payment; the
 * success page re-reads `my_entitlements()` every two seconds for half a
 * minute and says so once the subscription runs (or that it is taking long,
 * and the plan will update by itself).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppFrame } from "../shell/AppFrame";
import { subscriptionRunning } from "../../lib/billing/checkout";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./plan.module.css";

const POLL_MS = 2000;
const POLL_TRIES = 15;

export function BillingReturnScreen({ kind }: { kind: "success" | "cancel" }) {
  return <AppFrame tab={null}>{() => (kind === "success" ? <BillingSuccess /> : <BillingCancel />)}</AppFrame>;
}

export function BillingCancel() {
  const b = useDict().plan.billing.cancel;
  return (
    <section className={`card ${styles.returnCard}`} aria-labelledby="billing-return-heading">
      <h1 id="billing-return-heading" className={styles.returnHeading}>
        {b.heading}
      </h1>
      <p>{b.body}</p>
      <div className={styles.actions}>
        <Link href={paths.settingsPlan()} className="btn btn--primary">
          {b.back}
        </Link>
      </div>
    </section>
  );
}

export function BillingSuccess() {
  const { status, entitlements, refresh } = useEntitlements();
  const running = subscriptionRunning(entitlements);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (running || status === "none" || tries >= POLL_TRIES) return;
    const timer = setTimeout(() => {
      void refresh().finally(() => setTries((n) => n + 1));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [running, status, tries, refresh]);

  return <BillingSuccessView running={running} slow={!running && tries >= POLL_TRIES} />;
}

/** The success page's body for a state (rendered by the tests as is). */
export function BillingSuccessView({ running, slow }: { running: boolean; slow: boolean }) {
  const b = useDict().plan.billing.success;
  return (
    <section className={`card ${styles.returnCard}`} aria-labelledby="billing-return-heading" aria-live="polite">
      <h1 id="billing-return-heading" className={styles.returnHeading}>
        {b.heading}
      </h1>
      <p>{b.body}</p>
      <p className={styles.small}>{b.confirmation}</p>
      {running ? (
        <p className="notice notice--info">{b.active}</p>
      ) : slow ? (
        <p className="notice notice--warn">{b.slow}</p>
      ) : (
        <p className="muted">{b.waiting}</p>
      )}
      <div className={styles.actions}>
        <Link href={paths.settingsPlan()} className="btn btn--primary">
          {b.back}
        </Link>
      </div>
    </section>
  );
}

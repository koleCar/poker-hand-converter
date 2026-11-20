"use client";

/**
 * The pages Stripe Checkout returns to (Rail R6.3; the pricing round's
 * PR-Checkout): `/billing/success` and `/billing/cancel`.
 *
 * Neither trusts the address: arriving on the success page grants nothing.
 * The plan changes only when Stripe's webhook has recorded the payment; the
 * success page re-reads `my_entitlements()` every two seconds for half a
 * minute ("Turning on Pro…"), then says "You're on Pro" - or that it is
 * taking long, and the plan will update by itself.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { AppFrame } from "../shell/AppFrame";
import { subscriptionRunning } from "../../lib/billing/checkout";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { ProBadge } from "./ProLock";
import styles from "./plan.module.css";

const POLL_MS = 2000;
const POLL_TRIES = 15;

export function BillingReturnScreen({ kind }: { kind: "success" | "cancel" }) {
  return <AppFrame tab={null}>{() => (kind === "success" ? <BillingSuccess /> : <BillingCancel />)}</AppFrame>;
}

export function BillingCancel() {
  const t = useDict().pricing.cancel;
  return (
    <section className={`card ${styles.returnCard}`} aria-labelledby="billing-return-heading">
      <h1 id="billing-return-heading" className={styles.returnTitle}>
        {t.heading}
      </h1>
      <div className={styles.actions}>
        <Link href={paths.pricing()} className="btn">
          {t.back}
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
  const en = useDict();
  const t = en.pricing.success;
  const legal = en.plan.billing.success;
  if (running) {
    return (
      <section className={`card ${styles.returnCard} ${styles.returnDone}`} aria-labelledby="billing-return-heading" aria-live="polite">
        <ProBadge />
        <h1 id="billing-return-heading" className={styles.returnHeading}>
          {t.done}
        </h1>
        <div className={styles.actions}>
          <Link href={paths.analysis()} className={`btn ${styles.gold}`}>
            {t.openAnalysis}
          </Link>
          <Link href={paths.download()} className="btn">
            {/* A phone cannot download the app: there it only shows it. */}
            <span className={styles.wideOnly}>{t.getApp}</span>
            <span className={styles.narrowOnly}>{t.seeApp}</span>
          </Link>
        </div>
        <p className={styles.dim}>{t.receipt}</p>
        <p className={styles.dim}>{legal.confirmation}</p>
      </section>
    );
  }
  return (
    <section className={`card ${styles.returnCard}`} aria-labelledby="billing-return-heading" aria-live="polite">
      {slow ? null : <RailLoader size="small" label={t.waiting} />}
      <h1 id="billing-return-heading" className={styles.returnTitle}>
        {t.waiting}
      </h1>
      <p className={styles.dim}>{slow ? t.slow : t.waitingNote}</p>
      <p className={styles.dim}>{legal.confirmation}</p>
    </section>
  );
}

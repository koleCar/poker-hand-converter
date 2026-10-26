"use client";

/**
 * The Pro badge and the lock shown in place of a Pro feature (Rail R6.2).
 *
 * Shown only when the database would refuse the feature anyway: enforcement
 * on and the account's plan without it (`useEntitlements().locked`). While
 * enforcement is off - until paid plans launch - neither ever renders.
 */

import Link from "next/link";
import type { Feature } from "../../lib/db/entitlements";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./plan.module.css";

export function ProBadge() {
  const t = useDict().plan;
  return <span className={styles.badge}>{t.badge}</span>;
}

export function ProLock({ feature }: { feature: Feature }) {
  const t = useDict().plan;
  return (
    <section className={`card ${styles.lock}`} aria-labelledby={`pro-lock-${feature}`}>
      <h2 id={`pro-lock-${feature}`} className={styles.lockHead}>
        <ProBadge /> {t.lock.heading}
      </h2>
      <p className={styles.lockBody}>{t.lock.body[feature]}</p>
      <div className={styles.actions}>
        <Link href={paths.upgrade()} className="btn btn--primary">
          {t.upgrade}
        </Link>
        <Link href={paths.settingsPlan()} className="btn btn--ghost">
          {t.lock.seePlan}
        </Link>
      </div>
    </section>
  );
}

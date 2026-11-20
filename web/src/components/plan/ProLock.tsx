"use client";

/**
 * The Pro badge, the lock shown in place of a Pro screen, and a Pro-only
 * control (Rail R6.2; the Free-tier display of the pricing round).
 *
 * Shown only when the database would refuse the feature anyway: enforcement
 * on and the account's plan without it (`useEntitlements().locked`). While
 * enforcement is off - until paid plans launch - none of them renders.
 *
 * The lock is a teaser, never a dead end: a blurred skeleton of the screen
 * (no real data behind it), the Pro badge, one line of what it does and a
 * gold "See Pro" to `/pricing`.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { Feature } from "../../lib/db/entitlements";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./plan.module.css";

export function ProBadge() {
  const t = useDict().plan;
  return <span className={styles.badge}>{t.badge}</span>;
}

/** The gold "See Pro" (or another label) to the pricing page. */
export function SeeProLink({ label, small = true }: { label?: string; small?: boolean }) {
  const t = useDict().pricing.lock;
  return (
    <Link href={paths.pricing()} className={`btn ${small ? "btn--sm " : ""}${styles.gold}`}>
      {label ?? t.see}
    </Link>
  );
}

export function ProLock({ feature, compact = false }: { feature: Feature; compact?: boolean }) {
  const t = useDict().pricing.lock;
  const line = t.line[feature];
  return (
    <section className={`${styles.lock} ${compact ? styles.lockCompact : ""}`} aria-label={line}>
      <div className={styles.lockPreview} aria-hidden="true">
        <div className={styles.skel} style={{ width: "40%" }} />
        <div className={`${styles.skel} ${styles.skelTall}`} style={{ width: "80%" }} />
        <div className={styles.skel} style={{ width: "65%" }} />
        <div className={styles.skel} style={{ width: "55%" }} />
        {compact ? null : (
          <>
            <div className={`${styles.skel} ${styles.skelTall}`} style={{ width: "70%" }} />
            <div className={styles.skel} style={{ width: "45%" }} />
          </>
        )}
      </div>
      <div className={styles.lockCover}>
        <ProBadge />
        <p className={styles.lockLine}>{line}</p>
        <SeeProLink />
      </div>
    </section>
  );
}

/**
 * A control that is Pro (the solver's Nodelock): a button that does nothing,
 * with a lock, and on hover or focus "X is part of Pro. See Pro".
 */
export function LockedControl({ label, children }: { label: string; children?: ReactNode }) {
  const t = useDict().pricing.lock;
  return (
    <span className={styles.lockedControl}>
      <button type="button" className="btn btn--sm" aria-disabled="true">
        <LockIcon />
        {children ?? label}
      </button>
      <span className={styles.tip} role="tooltip">
        {t.tip(label)}
        <Link href={paths.pricing()}>{t.see}</Link>
      </span>
    </span>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

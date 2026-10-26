"use client";

/**
 * Account -> Plan (Rail R6.2), on `/settings#plan`: the plan in effect, what
 * the account pays for, the library against the Free cap, the early-user
 * discount, and "Upgrade" (disabled until R6.3's checkout). While
 * enforcement is off it says so: everything is open and no limit applies.
 */

import type { Entitlements } from "../../lib/db/entitlements";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { ProBadge } from "./ProLock";
import styles from "./plan.module.css";

/** `2026-10-29T08:02:17Z` -> `29 October 2026`, as the settings screen words dates. */
function formatDay(iso: string, intl: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(intl, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export function PlanPanel() {
  const t = useDict().plan;
  const { status, entitlements } = useEntitlements();

  if (status === "none") {
    return null;
  }

  return (
    <section id="plan" className={`card ${styles.panel}`} aria-labelledby="settings-plan">
      <h2 id="settings-plan" className={styles.heading}>
        {t.heading}
      </h2>
      {status !== "ready" || !entitlements ? (
        <p className={status === "loading" ? "muted" : "notice notice--warn"}>
          {status === "loading" ? t.loading : status === "unavailable" ? t.unavailable : t.loadFailed}
        </p>
      ) : (
        <PlanDetails entitlements={entitlements} />
      )}
    </section>
  );
}

/** The panel's body for one answer of `my_entitlements()`. */
export function PlanDetails({ entitlements: e }: { entitlements: Entitlements }) {
  const en = useDict();
  const t = en.plan;
  const count = (value: number) => value.toLocaleString(en.chrome.intl);
  const day = (iso: string) => formatDay(iso, en.chrome.intl);
  const sub = e.subscription;
  const cap = e.features.hand_cap;
  const stored = e.usage.handsStored;
  const full = cap !== null && stored >= cap;

  return (
    <>
      <p className={styles.current}>
        <strong>{t.current(t.name[e.plan])}</strong>
        {e.plan === "pro" && e.enforced ? <ProBadge /> : null}
      </p>
      {!e.enforced ? <p className="notice notice--info">{t.notEnforced}</p> : null}

      {sub.plan === "pro" ? (
        <p className="muted">
          {[
            sub.status ? t.status[sub.status] : t.granted,
            sub.period === "month" ? t.billedMonthly : sub.period === "year" ? t.billedYearly : null,
            e.graceUntil
              ? t.graceUntil(day(e.graceUntil))
              : sub.currentPeriodEnd
                ? sub.status === "canceled" || sub.status === null
                  ? t.endsOn(day(sub.currentPeriodEnd))
                  : t.renews(day(sub.currentPeriodEnd))
                : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}

      <h3 className={styles.subheading}>{t.usageHeading}</h3>
      {cap !== null ? (
        <>
          <div
            className={styles.meter}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={Math.min(stored, cap)}
            aria-label={t.usageHeading}
          >
            <div
              className={`${styles.meterFill} ${full ? styles.meterFull : ""}`}
              style={{ width: `${cap > 0 ? Math.min(100, (stored / cap) * 100) : 100}%` }}
            />
          </div>
          <p className={styles.small}>{t.usage(count(stored), count(cap))}</p>
          {full ? <p className="notice notice--warn">{t.full}</p> : null}
        </>
      ) : (
        <p className={styles.small}>
          {t.usageUnlimited(count(stored))}
          {e.limits.freeHandCap !== null && !e.enforced ? ` ${t.freeHolds(count(e.limits.freeHandCap))}` : null}
        </p>
      )}

      {e.earlyUser.is && e.earlyUser.discountPercent > 0 ? (
        <p className="notice notice--info">{t.early(e.earlyUser.discountPercent)}</p>
      ) : null}

      <h3 className={styles.subheading}>{t.includedHeading}</h3>
      <ul className={styles.list}>
        <li>{t.freeIncludes}</li>
        <li>{t.proIncludes}</li>
      </ul>

      {/* Checkout is R6.3: until then the button says plans open soon. */}
      {e.enforced && e.plan !== "pro" ? (
        <div className={styles.actions}>
          <button type="button" className="btn btn--primary" disabled aria-describedby="settings-plan-soon">
            {t.upgrade}
          </button>
          <span id="settings-plan-soon" className="muted">
            {t.upgradeSoon}
          </span>
        </div>
      ) : null}
    </>
  );
}

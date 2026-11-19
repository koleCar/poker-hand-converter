"use client";

/**
 * Account -> Plan (Rail R6.2, R6.3), on `/settings#plan`: the plan in effect
 * and what the account pays for, the library against the Free cap, today's
 * use on Free (hands saved, flops opened), "Manage subscription" (Stripe's
 * Customer Portal) and the way to `/pricing`, where Pro is bought. While
 * paid plans are not open, Upgrade opens "Pro is coming" (the Pro waitlist)
 * here instead. While enforcement is off it says so in one line: everything
 * is open.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  billingView,
  fetchBillingOffer,
  openBillingPortal,
  type BillingError,
  type BillingOffer,
} from "../../lib/billing/checkout";
import { upgradeRoute } from "../../lib/billing/waitlist";
import { isFreeEnforced, type Entitlements } from "../../lib/db/entitlements";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict, useLocale } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./plan.module.css";
import rows from "../account/rows.module.css";
import { Icon } from "@rail/ui/icon/Icon";
import { BusyLabel } from "../shell/BusyLabel";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { ProWaitlistDialog } from "./ProWaitlistDialog";

/** Over this share of the Free cap the library meter turns yellow. */
export const METER_NEAR = 0.9;

/**
 * `2026-10-29T08:02:17Z` -> `29 October 2026`, as the settings screen words
 * dates. Croatian writes `29. listopada 2026.`; the closing dot is dropped
 * because every sentence that carries a date ends with its own.
 */
function formatDay(iso: string, intl: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(intl, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(date)
    .replace(/\.$/, "");
}

/** The reader's clock time of an instant (`01:00`), for the daily reset. */
export function formatClock(iso: string, intl: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString(intl, { hour: "2-digit", minute: "2-digit" });
}

export function PlanPanel() {
  const t = useDict().plan;
  const { status, entitlements } = useEntitlements();

  if (status === "none") {
    return null;
  }

  return (
    <section id="plan" className={rows.group} aria-labelledby="settings-plan">
      <h2 id="settings-plan" className={rows.groupLabel}>
        {t.heading}
      </h2>
      <div className={rows.card}>
        {status === "loading" ? (
          <div className={`${rows.row} ${rows.rowWide}`}>
            <RailLoader size="inline" showLabel label={t.loading} />
          </div>
        ) : status !== "ready" || !entitlements ? (
          <div className={`${rows.row} ${rows.rowWide}`}>
            <span className={rows.error}>{status === "unavailable" ? t.unavailable : t.loadFailed}</span>
          </div>
        ) : (
          <PlanDetails entitlements={entitlements} />
        )}
      </div>
    </section>
  );
}

/** The plan's rows for one answer of `my_entitlements()`: the plan, the library, today on Free. */
export function PlanDetails({ entitlements: e }: { entitlements: Entitlements }) {
  const en = useDict();
  const t = en.plan;
  const b = t.billing;
  const count = (value: number) => value.toLocaleString(en.chrome.intl);
  const day = (iso: string) => formatDay(iso, en.chrome.intl);
  const sub = e.subscription;
  const cap = e.features.hand_cap;
  const stored = e.usage.handsStored;
  const full = cap !== null && stored >= cap;
  const near = cap !== null && !full && cap > 0 && stored / cap > METER_NEAR;
  const view = billingView(e);
  const end = sub.currentPeriodEnd;
  const free = isFreeEnforced(e);
  const dayCap = free ? e.limits.dailyHandCap : null;
  const flopCap = free && !e.features.solver_unlimited ? e.limits.dailyFlopCap : null;

  const tone = e.plan === "pro" ? rows.gold : !e.enforced ? rows.blue : rows.grey;
  const subLine =
    sub.plan === "pro"
      ? [
          sub.status ? t.status[sub.status] : t.granted,
          sub.period ? t.billed[sub.period] : null,
          // Past due and canceled have their own line below.
          sub.status === "past_due" || sub.status === "canceled"
            ? null
            : e.graceUntil
              ? t.graceUntil(day(e.graceUntil))
              : end
                ? sub.status === null
                  ? t.endsOn(day(end))
                  : t.renews(day(end))
                : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return (
    <>
      <div className={rows.row}>
        <span className={rows.rowLabel}>{t.heading}</span>
        <span className={rows.value}>
          <span className={rows.inline}>
            <span className={`${rows.badge} ${tone}`} title={t.current(t.name[e.plan])}>
              {e.plan === "pro" ? <Icon name="star" /> : null}
              {t.name[e.plan]}
            </span>
            {!e.enforced ? <span className={`${rows.badge} ${rows.blue}`}>{t.earlyAccess}</span> : null}
          </span>
          {subLine ? <span className={rows.muted}>{subLine}</span> : null}
          {!e.enforced ? <span className={rows.muted}>{t.notEnforced}</span> : null}
          {view.notice === "past_due" ? (
            <span className={rows.error}>{e.graceUntil ? b.pastDueUntil(day(e.graceUntil)) : b.pastDue}</span>
          ) : null}
          {view.notice === "canceled_until" && end ? <span className={rows.muted}>{b.canceledUntil(day(end))}</span> : null}
          {view.notice === "ended" && end ? <span className={rows.muted}>{b.ended(day(end))}</span> : null}
        </span>
        <span className={rows.actions}>
          {view.manage ? <ManageButton /> : null}
          {free && view.upgrade ? (
            <UpgradeAction label={t.upgrade} />
          ) : (
            <Link href={paths.pricing()} className="btn btn--ghost btn--sm">
              {t.pricing}
            </Link>
          )}
        </span>
      </div>

      <div className={rows.row}>
        <span className={rows.rowLabel}>{t.usageHeading}</span>
        <span className={rows.value}>
          {cap !== null ? (
            <>
              <span className={rows.text}>{t.usage(count(stored), count(cap))}</span>
              <div
                className={styles.meter}
                role="meter"
                aria-valuemin={0}
                aria-valuemax={cap}
                aria-valuenow={Math.min(stored, cap)}
                aria-label={t.usageHeading}
              >
                <div
                  className={`${styles.meterFill} ${full ? styles.meterFull : near ? styles.meterNear : ""}`}
                  style={{ width: `${cap > 0 ? Math.min(100, (stored / cap) * 100) : 100}%` }}
                />
              </div>
              {full ? <span className={rows.error}>{t.full}</span> : null}
            </>
          ) : (
            <span className={rows.text}>{t.usageUnlimited(count(stored))}</span>
          )}
        </span>
        <span className={rows.actions}>
          <Link href={paths.library()} className="btn btn--ghost btn--sm">
            {t.open}
          </Link>
        </span>
      </div>

      {dayCap !== null || flopCap !== null ? (
        <div className={rows.row}>
          <span className={rows.rowLabel}>{t.todayHeading}</span>
          <span className={rows.value}>
            <span className={rows.text}>
              {[
                dayCap !== null ? t.handsToday(count(e.usage.handsToday), count(dayCap)) : null,
                flopCap !== null ? t.flopsToday(count(e.usage.flopsToday.length), count(flopCap)) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {e.usage.dayResetsAt ? (
              <span className={rows.muted}>{t.resets(formatClock(e.usage.dayResetsAt, en.chrome.intl))}</span>
            ) : null}
          </span>
          <span />
        </div>
      ) : null}
    </>
  );
}

/**
 * Settings' Upgrade: a link to `/pricing` while paid plans are open (or not
 * known yet), "Pro is coming" in place while they are not.
 */
function UpgradeAction({ label }: { label: string }) {
  const [offer, setOffer] = useState<BillingOffer | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchBillingOffer().then((value) => {
      if (active) setOffer(value);
    });
    return () => {
      active = false;
    };
  }, []);

  if (upgradeRoute(true, offer) !== "waitlist") {
    return (
      <Link href={paths.pricing()} className={`btn btn--sm ${styles.gold}`}>
        {label}
      </Link>
    );
  }
  return (
    <>
      <button type="button" className={`btn btn--sm ${styles.gold}`} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? <ProWaitlistDialog source="settings" onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ManageButton() {
  const en = useDict();
  const b = en.plan.billing;
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BillingError | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    const result = await openBillingPortal(locale);
    if (result.ok) {
      window.location.assign(result.url);
      return;
    }
    setBusy(false);
    setError(result.error);
  };

  return (
    <>
      <button type="button" className="btn btn--sm" onClick={open} disabled={busy} title={b.manageHint}>
        <BusyLabel busy={busy} busyLabel={b.opening}>
          {b.manage}
        </BusyLabel>
      </button>
      {error ? (
        <span className={rows.error} role="alert">
          {b.errors[error]}
        </span>
      ) : null}
    </>
  );
}

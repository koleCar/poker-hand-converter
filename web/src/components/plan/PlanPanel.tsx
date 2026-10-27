"use client";

/**
 * Account -> Plan (Rail R6.2, R6.3), on `/settings#plan`: the plan in effect,
 * what the account pays for, the library against the Free cap, the
 * early-user discount, and paying: "Upgrade to Pro" (monthly or yearly, to
 * Stripe Checkout) or "Manage subscription" (Stripe's Customer Portal).
 * While enforcement is off it says so: everything is open and no limit
 * applies - buying Pro early is allowed and recorded. Until the owner
 * configures Stripe, the upgrade is disabled: "paid plans open soon".
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  billingView,
  consentComplete,
  discounted,
  fetchBillingOffer,
  formatPrice,
  openBillingPortal,
  startCheckout,
  NO_CONSENT,
  type BillingError,
  type BillingOffer,
  type CheckoutConsent,
  type Period,
} from "../../lib/billing/checkout";
import type { Entitlements } from "../../lib/db/entitlements";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict, useLocale } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { ProBadge } from "./ProLock";
import styles from "./plan.module.css";

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

export function PlanPanel() {
  const t = useDict().plan;
  const { status, entitlements } = useEntitlements();
  // What is on sale, as Stripe has it (no secret; null while asking).
  const [offer, setOffer] = useState<BillingOffer | null>(null);
  const signedIn = status !== "none";

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    void fetchBillingOffer().then((value) => {
      if (active) setOffer(value);
    });
    return () => {
      active = false;
    };
  }, [signedIn]);

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
        <PlanDetails entitlements={entitlements} offer={offer} />
      )}
    </section>
  );
}

/**
 * The panel's body for one answer of `my_entitlements()`, and what is on sale
 * (`offer`: null = not known yet or not on sale).
 */
export function PlanDetails({ entitlements: e, offer = null }: { entitlements: Entitlements; offer?: BillingOffer | null }) {
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
      {!e.enforced ? (
        <p className="notice notice--info">{offer?.available ? t.billing.notEnforcedOnSale : t.notEnforced}</p>
      ) : null}

      {sub.plan === "pro" ? (
        <p className="muted">
          {[
            sub.status ? t.status[sub.status] : t.granted,
            sub.period === "month" ? t.billedMonthly : sub.period === "year" ? t.billedYearly : null,
            // Past due and canceled have their own notice below (`Billing`).
            sub.status === "past_due" || sub.status === "canceled"
              ? null
              : e.graceUntil
                ? t.graceUntil(day(e.graceUntil))
                : sub.currentPeriodEnd
                  ? sub.status === null
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

      <Billing entitlements={e} offer={offer} />
    </>
  );
}

/**
 * Paying (R6.3): the subscription's notices, "Manage subscription" (the
 * Stripe portal) for an account with a subscription, and "Upgrade to Pro"
 * (monthly or yearly, prices from Stripe) for one without. With checkout
 * not configured, the upgrade stays disabled - "paid plans open soon" - and
 * only where R6.2 showed it (enforcement on, the plan without Pro).
 */
function Billing({ entitlements: e, offer }: { entitlements: Entitlements; offer: BillingOffer | null }) {
  const en = useDict();
  const t = en.plan;
  const b = t.billing;
  const view = billingView(e);
  const day = (iso: string) => formatDay(iso, en.chrome.intl);
  const end = e.subscription.currentPeriodEnd;
  const onSale = offer !== null && offer.available;

  return (
    <>
      {view.notice === "past_due" ? (
        <p className="notice notice--warn">{e.graceUntil ? b.pastDueUntil(day(e.graceUntil)) : b.pastDue}</p>
      ) : null}
      {view.notice === "canceled_until" && end ? <p className="notice notice--info">{b.canceledUntil(day(end))}</p> : null}
      {view.notice === "ended" && end ? <p className="muted">{b.ended(day(end))}</p> : null}

      {view.manage ? <ManageButton /> : null}

      {view.upgrade && onSale ? (
        <UpgradeChooser offer={offer} earlyUser={e.earlyUser.is} enforced={e.enforced} />
      ) : view.upgrade && e.enforced && e.plan !== "pro" ? (
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

function ManageButton() {
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
    <div className={styles.billing}>
      <div className={styles.actions}>
        <button type="button" className="btn btn--ghost" onClick={open} disabled={busy} aria-describedby="plan-manage-hint">
          {busy ? b.opening : b.manage}
        </button>
      </div>
      <p id="plan-manage-hint" className={styles.small}>
        {b.manageHint}
      </p>
      {error ? (
        <p className="notice notice--error" role="alert">
          {b.errors[error]}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Monthly or yearly, each with Stripe's price (and the early-user price), the
 * two consents, then Checkout. `initialConsent` is for the tests (the page
 * always starts with both boxes unticked).
 */
export function UpgradeChooser({
  offer,
  earlyUser,
  enforced,
  initialConsent = NO_CONSENT,
}: {
  offer: BillingOffer;
  earlyUser: boolean;
  enforced: boolean;
  initialConsent?: CheckoutConsent;
}) {
  const en = useDict();
  const t = en.plan;
  const b = t.billing;
  const locale = useLocale();
  const periods = (["month", "year"] as const).filter((p) => offer.prices[p] !== null);
  const [period, setPeriod] = useState<Period>(periods[0] ?? "month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BillingError | null>(null);
  const [consent, setConsent] = useState<CheckoutConsent>(initialConsent);
  const percent = earlyUser ? offer.earlyDiscountPercent : null;
  const chosen = offer.prices[period];
  const agreed = consentComplete(consent);

  const go = async () => {
    if (!agreed) return;
    setBusy(true);
    setError(null);
    const result = await startCheckout(period, locale, consent);
    if (result.ok) {
      window.location.assign(result.url);
      return;
    }
    setBusy(false);
    setError(result.error);
  };

  return (
    <div className={styles.billing}>
      <fieldset className={styles.periods} disabled={busy}>
        <legend className={styles.subheading}>{b.choose}</legend>
        {periods.map((p) => {
          const price = offer.prices[p];
          if (!price) return null;
          const money = (amount: number) => formatPrice(amount, price.currency, en.chrome.intl);
          const per = p === "month" ? b.perMonth : b.perYear;
          return (
            <label key={p} className={`${styles.period} ${period === p ? styles.periodOn : ""}`}>
              <input type="radio" name="plan-period" value={p} checked={period === p} onChange={() => setPeriod(p)} />
              <span className={styles.periodText}>
                <strong>{p === "month" ? b.monthly : b.yearly}</strong>
                <span>{per(money(price.amount))}</span>
                {percent ? (
                  <span className={styles.small}>{b.withDiscount(per(money(discounted(price.amount, percent))), percent)}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className={styles.small}>
        {chosen?.taxInclusive ? b.vatIncluded : b.vatAdded} {b.vatNote}
      </p>
      {!enforced ? <p className={styles.small}>{b.earlyAccessNote}</p> : null}
      <ConsentFields
        consent={consent}
        disabled={busy}
        onChange={(next) => {
          setConsent(next);
          if (error === "consent_required" || error === "consent_outdated") setError(null);
        }}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={go}
          disabled={busy || !chosen || !agreed}
          aria-describedby={agreed ? undefined : "plan-consent-required"}
        >
          {busy ? b.working : t.upgrade}
        </button>
        {agreed ? null : (
          <span id="plan-consent-required" className={styles.small}>
            {b.consent.required}
          </span>
        )}
      </div>
      {error ? (
        <p className="notice notice--error" role="alert">
          {b.errors[error]}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The two consents before Checkout (R6.3 addendum): the terms (a link to
 * `/terms`), and the request that Pro start immediately with the
 * acknowledgement about the right of withdrawal. Plain native checkboxes,
 * unticked until the person ticks them; each required.
 */
export function ConsentFields({
  consent,
  disabled = false,
  onChange,
}: {
  consent: CheckoutConsent;
  disabled?: boolean;
  onChange: (next: CheckoutConsent) => void;
}) {
  const c = useDict().plan.billing.consent;
  return (
    <fieldset className={styles.consent} disabled={disabled}>
      <legend className={styles.subheading}>{c.legend}</legend>
      <label className={styles.consentItem}>
        <input
          type="checkbox"
          name="plan-consent-terms"
          required
          checked={consent.terms}
          onChange={(event) => onChange({ ...consent, terms: event.target.checked })}
        />
        <span>
          {c.termsBefore}
          <Link href={paths.terms()} target="_blank" rel="noopener">
            {c.termsLink}
          </Link>
        </span>
      </label>
      <label className={styles.consentItem}>
        <input
          type="checkbox"
          name="plan-consent-immediate"
          required
          checked={consent.immediatePerformance}
          onChange={(event) => onChange({ ...consent, immediatePerformance: event.target.checked })}
        />
        <span>{c.immediate}</span>
      </label>
    </fieldset>
  );
}

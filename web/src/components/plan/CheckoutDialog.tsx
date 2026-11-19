"use client";

/**
 * The confirmation before Stripe Checkout (the pricing round's PR-Checkout,
 * step 2): the period (switchable), what is paid today and after, the two
 * required consents (R6.3 addendum, `billing_consents`) and "Continue to
 * payment", which asks `billing-checkout` for a session and goes there.
 *
 * Both boxes start unticked and both are required; the function refuses
 * without them and records them before it opens the session.
 */

import Link from "next/link";
import { useState } from "react";
import { Dialog } from "@rail/ui/dialog/Dialog";
import {
  consentComplete,
  formatPrice,
  NO_CONSENT,
  PERIODS,
  startCheckout,
  type BillingError,
  type BillingPrice,
  type CheckoutConsent,
  type Period,
} from "../../lib/billing/checkout";
import { useDict, useLocale } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { BusyLabel } from "../shell/BusyLabel";
import styles from "./plan.module.css";
import pricing from "./pricing.module.css";

export function CheckoutDialog({
  period: initialPeriod,
  prices,
  onClose,
  initialConsent = NO_CONSENT,
}: {
  period: Period;
  /** Stripe's prices for the periods on sale (the dialog opens only when checkout is open). */
  prices: Record<Period, BillingPrice | null>;
  onClose: () => void;
  /** For the tests: the page always starts with both boxes unticked. */
  initialConsent?: CheckoutConsent;
}) {
  const en = useDict();
  const t = en.pricing;
  const b = en.plan.billing;
  const locale = useLocale();
  const periods = PERIODS.filter((p) => prices[p] !== null);
  const [period, setPeriod] = useState<Period>(prices[initialPeriod] ? initialPeriod : (periods[0] ?? initialPeriod));
  const [consent, setConsent] = useState<CheckoutConsent>(initialConsent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BillingError | null>(null);
  const price = prices[period];
  const agreed = consentComplete(consent);
  const money = (p: BillingPrice) => formatPrice(p.amount, p.currency, en.chrome.intl);

  const go = async () => {
    if (!agreed || !price) return;
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
    <Dialog title={t.confirm.title} onClose={onClose}>
      <span className={pricing.periodSwitch} role="group" aria-label={t.periodLabel}>
        {periods.map((p) => (
          <button
            key={p}
            type="button"
            className={p === period ? pricing.periodOn : undefined}
            aria-pressed={p === period}
            disabled={busy}
            onClick={() => setPeriod(p)}
          >
            {t.periods[p]}
          </button>
        ))}
      </span>
      {price ? (
        <div className={pricing.today}>
          <div className={pricing.todayRow}>
            <strong>{t.confirm.today}</strong>
            <strong className={pricing.todayPrice}>{money(price)}</strong>
          </div>
          <span className={styles.dim}>
            {t.confirm.then[period](formatPrice(price.amount, price.currency, en.chrome.intl, true))} {t.confirm.tax}
          </span>
        </div>
      ) : null}
      <ConsentFields
        consent={consent}
        disabled={busy}
        onChange={(next) => {
          setConsent(next);
          if (error === "consent_required" || error === "consent_outdated") setError(null);
        }}
      />
      {error ? (
        <p className="notice notice--error" role="alert">
          {b.errors[error]}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={`btn ${styles.gold} ${pricing.pay}`}
          onClick={go}
          disabled={busy || !price || !agreed}
          aria-describedby={agreed ? undefined : "plan-consent-required"}
        >
          <BusyLabel busy={busy} busyLabel={b.working}>
            {t.confirm.pay}
          </BusyLabel>
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
          {t.confirm.cancel}
        </button>
      </div>
      {agreed ? null : (
        <span id="plan-consent-required" className={styles.dim}>
          {b.consent.required}
        </span>
      )}
    </Dialog>
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
    <fieldset className={styles.consent} disabled={disabled} aria-label={c.legend}>
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

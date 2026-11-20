"use client";

/**
 * `/pricing` (the pricing round's PR-B-Table, approved 2026-11-19): Free
 * against Pro in one table whose column heads hold the prices and the
 * period switch (Monthly / 6 months / Yearly).
 *
 * Prices are Stripe's (`billing-checkout` GET, signed in) and otherwise the
 * owner's list prices. "Upgrade to Pro" ({@link upgradeRoute}):
 *
 *   not on sale "Pro is coming" (the Pro waitlist) - every period, and every
 *               visitor, since a signed-out page cannot ask Stripe's state;
 *   on sale     the confirmation (period, price, the two consents), then
 *               `billing-checkout` POST and Stripe Checkout. A visitor is
 *               asked to sign in first, the chosen period kept
 *               (sessionStorage), once `upgradeRoute` lets visitors through.
 *
 * Public: nothing here reads an account until someone signs in. The plan
 * shown as current is what the account pays for (or Free), not the
 * effective plan, which is Pro for everyone while enforcement is off.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import {
  billingView,
  fetchBillingOffer,
  formatPrice,
  PERIOD_MONTHS,
  PERIODS,
  savingPercent,
  shownPrices,
  type BillingOffer,
  type Period,
} from "../../lib/billing/checkout";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { AppFrame } from "../shell/AppFrame";
import { upgradeRoute, type WaitlistSource } from "../../lib/billing/waitlist";
import { CheckoutDialog } from "./CheckoutDialog";
import { ManageButton } from "./PlanPanel";
import { ProBadge } from "./ProLock";
import { ProWaitlistDialog } from "./ProWaitlistDialog";
import styles from "./plan.module.css";
import p from "./pricing.module.css";

/** The period a signed-out visitor chose, kept across the sign-in. */
const PENDING_KEY = "rail.pricing.pending";

/** The Free plan's numbers when the account's own are not known (the owner's, 2026-11-19). */
const FREE_DEFAULTS = { perDay: 500, library: 10_000, flops: 3 };

function isPeriod(value: unknown): value is Period {
  return typeof value === "string" && (PERIODS as readonly string[]).includes(value);
}

function readPending(): Period | null {
  try {
    const value = window.sessionStorage.getItem(PENDING_KEY);
    return isPeriod(value) ? value : null;
  } catch {
    return null;
  }
}

function writePending(period: Period | null): void {
  try {
    if (period) window.sessionStorage.setItem(PENDING_KEY, period);
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Private mode: the visitor picks the period again after signing in.
  }
}

/**
 * `period`: the address's `?period=` (the desktop app and Settings link with one);
 * `from`: `?from=` (`app` from the desktop app, kept with a waitlist address).
 */
export function PricingScreen({ period = null, from = null }: { period?: string | null; from?: string | null }) {
  const source: WaitlistSource = from === "app" ? "app" : "pricing";
  return (
    <AppFrame tab={null}>
      {() => <Pricing initialPeriod={isPeriod(period) ? period : "month"} source={source} />}
    </AppFrame>
  );
}

type Cell = boolean | string;
type Row = { group: string } | { label: string; note?: string; free: Cell; pro: Cell };

/** The table's rows, as the contract's plans table has them (no Learn, no early-user line). */
export function pricingRows(t: Dict["pricing"], count: (n: number) => string, free = FREE_DEFAULTS): Row[] {
  const r = t.rows;
  const unlimited = t.cells.unlimited;
  return [
    { group: t.groups.hands },
    { ...r.upload, free: true, pro: true },
    { ...r.perDay, free: t.cells.hands(count(free.perDay)), pro: unlimited },
    { ...r.library, free: t.cells.library(count(free.library)), pro: unlimited },
    { ...r.deleteHands, free: true, pro: true },
    { ...r.share, free: true, pro: true },
    { group: t.groups.statistics },
    { ...r.graph, free: true, pro: true },
    { ...r.reports, free: false, pro: true },
    { ...r.players, free: false, pro: true },
    { group: t.groups.desktop },
    { ...r.desktopImport, free: true, pro: true },
    { ...r.sync, free: true, pro: true },
    { ...r.tiling, free: true, pro: true },
    { ...r.hud, free: false, pro: true },
    { group: t.groups.study },
    { ...r.solver, free: t.cells.flops(count(free.flops)), pro: unlimited },
    { ...r.nodelock, free: false, pro: true },
    { ...r.analysis, free: false, pro: true },
    { ...r.trainer, free: false, pro: true },
    { ...r.review, free: false, pro: true },
  ];
}

function Pricing({ initialPeriod, source }: { initialPeriod: Period; source: WaitlistSource }) {
  const en = useDict();
  const t = en.pricing;
  const auth = useAuth();
  const { status, entitlements } = useEntitlements();
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [offer, setOffer] = useState<BillingOffer | null>(null);
  const [confirming, setConfirming] = useState<Period | null>(null);
  const [waitlist, setWaitlist] = useState(false);
  const signedIn = auth.isSignedIn;
  const count = (n: number) => n.toLocaleString(en.chrome.intl);

  // A period chosen before signing in comes back with the visitor.
  useEffect(() => {
    const pending = readPending();
    if (pending) setPeriod(pending);
  }, []);

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

  const view = entitlements ? billingView(entitlements) : null;
  // What the account pays for: Pro only with a subscription (or Pro granted).
  const onPro = view !== null && !view.upgrade;
  const onSale = offer?.available === true;
  const prices = shownPrices(offer);
  const known = signedIn && status === "ready" && offer !== null;
  const route = upgradeRoute(signedIn, offer);

  // Signed in with a period still pending: straight to the confirmation.
  useEffect(() => {
    if (!known) return;
    const pending = readPending();
    if (!pending) return;
    writePending(null);
    if (onSale && !onPro) setConfirming(pending);
  }, [known, onSale, onPro]);

  const upgrade = useCallback(() => {
    if (route === "waitlist") {
      setWaitlist(true);
      return;
    }
    if (!signedIn) {
      writePending(period);
      const price = prices[period];
      auth.requestSignIn(t.signInReason(t.periods[period], formatPrice(price.amount, price.currency, en.chrome.intl, true)));
      return;
    }
    if (route === "checkout") setConfirming(period);
  }, [route, signedIn, period, prices, auth, t, en.chrome.intl]);

  const shown = prices[period];
  const money = (amount: number, whole = false) => formatPrice(amount, shown.currency, en.chrome.intl, whole);
  const perMonth = money(Math.round(shown.amount / PERIOD_MONTHS[period]), true);
  const bill =
    period === "month" ? t.bill.month : t.bill[period](money(shown.amount, true));
  const free = {
    perDay: entitlements?.limits.dailyHandCap ?? FREE_DEFAULTS.perDay,
    library: entitlements?.limits.freeHandCap ?? FREE_DEFAULTS.library,
    flops: entitlements?.limits.dailyFlopCap ?? FREE_DEFAULTS.flops,
  };
  const rows = pricingRows(t, count, free);

  let proAction: ReactNode;
  if (onPro) {
    proAction = view?.manage ? (
      <ManageButton />
    ) : (
      <span className={`btn ${p.cta}`} aria-disabled="true">
        {t.currentPlan}
      </span>
    );
  } else {
    proAction = (
      <button
        type="button"
        className={`btn ${styles.gold} ${p.cta}`}
        onClick={upgrade}
        disabled={auth.status === "loading" || route === "wait"}
      >
        {t.upgrade}
      </button>
    );
  }

  return (
    <div className={p.wrap}>
      <div className={p.table} role="table" aria-label={t.plansLabel}>
        <div className={`${p.row} ${p.head}`} role="row">
          <div className={p.first} role="columnheader">
            <span className={p.periodSwitch} role="group" aria-label={t.periodLabel}>
              {PERIODS.map((id) => {
                const save = savingPercent(prices, id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={id === period ? p.periodOn : undefined}
                    aria-pressed={id === period}
                    onClick={() => setPeriod(id)}
                  >
                    {t.periods[id]}
                    {save > 0 ? <span className={p.save}>−{save}%</span> : null}
                  </button>
                );
              })}
            </span>
            {signedIn && view ? <span className={p.dim}>{t.youAreOn(onPro ? t.pro : t.free)}</span> : null}
          </div>
          <div className={p.c} role="columnheader">
            <span className={p.planName}>{t.free}</span>
            <span className={p.price}>{t.zero}</span>
            <span className={p.bill}>{t.forever}</span>
            {signedIn && view && !onPro ? (
              <span className={`btn ${p.cta}`} aria-disabled="true">
                {t.currentPlan}
              </span>
            ) : null}
          </div>
          <div className={`${p.c} ${p.pro}`} role="columnheader">
            <ProBadge />
            <span className={p.price}>
              {perMonth}
              <span className={p.per}>{t.perMonth}</span>
            </span>
            <span className={p.bill}>{bill}</span>
            {proAction}
          </div>
        </div>
        {rows.map((row) =>
          "group" in row ? (
            <div key={row.group} className={`${p.row} ${p.group}`} role="row">
              <div role="cell">{row.group}</div>
              {/* The plans' names over each group, shown on a phone only: there
                  the prices are cards above the table, not its column heads. */}
              <div role="cell" className={p.c}>
                <span className={p.groupPlan} aria-hidden="true">
                  {t.free}
                </span>
              </div>
              <div role="cell" className={`${p.c} ${p.pro}`}>
                <span className={p.groupPlan} aria-hidden="true">
                  {t.pro}
                </span>
              </div>
            </div>
          ) : (
            <div key={row.label} className={p.row} role="row">
              <div role="rowheader">
                <span>{row.label}</span>
                {row.note ? <span className={p.note}>{row.note}</span> : null}
              </div>
              <div className={p.c} role="cell">
                <CellMark value={row.free} t={t} />
              </div>
              <div className={`${p.c} ${p.pro}`} role="cell">
                <CellMark value={row.pro} t={t} gold />
              </div>
            </div>
          ),
        )}
      </div>
      <ul className={p.foot}>
        <li>{t.foot.cancel}</li>
        <li className={p.dot} aria-hidden="true">·</li>
        <li>{t.foot.keep}</li>
        <li className={p.dot} aria-hidden="true">·</li>
        <li>{t.foot.tax}</li>
      </ul>
      {confirming ? (
        <CheckoutDialog period={confirming} prices={offer?.prices ?? prices} onClose={() => setConfirming(null)} />
      ) : null}
      {waitlist ? <ProWaitlistDialog source={source} onClose={() => setWaitlist(false)} /> : null}
    </div>
  );
}

function CellMark({ value, t, gold = false }: { value: Cell; t: Dict["pricing"]; gold?: boolean }) {
  if (typeof value === "string") {
    return <span className={gold ? p.txtGold : p.txt}>{value}</span>;
  }
  if (value) {
    return (
      <svg
        className={gold ? p.yesGold : p.yes}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={t.included}
      >
        <path d="M5 12l5 5 9-10" />
      </svg>
    );
  }
  return (
    <svg
      className={p.no}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      role="img"
      aria-label={t.notIncluded}
    >
      <path d="M7 12h10" />
    </svg>
  );
}

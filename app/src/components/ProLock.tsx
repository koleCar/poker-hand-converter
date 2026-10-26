/**
 * (R6.4) The lock shown in place of a Pro feature, and the plan's lines in
 * Settings, Account.
 *
 * Shown only when the app holds the feature back - enforcement on and the
 * effective plan without it (`useEntitlements().locked`); while enforcement
 * is off (today) neither ever renders a lock. What it offers follows why:
 * signed out - "Sign in" (and "Upgrade"); the plan is Free - "Upgrade";
 * not checked yet or the offline grace period is over - "Check again".
 * "Upgrade" opens the web's Plan panel, where Pro is bought (R6.3).
 */
import { useT, type Dict } from "../i18n";
import { liveDateFormat } from "../i18n/format";
import type { EntitlementsStatus, PlanFeature } from "../lib/ipc";
import { useEntitlements } from "../lib/useEntitlements";
import styles from "./ProLock.module.css";

const WHEN = liveDateFormat({ dateStyle: "medium", timeStyle: "short" });

/** Why, in words, from the plan's reason. */
export function lockReason(status: EntitlementsStatus, p: Dict["plan"]): string {
  switch (status.effective.reason) {
    case "signedOut":
      return p.reasons.signedOut;
    case "notChecked":
      return p.reasons.notChecked;
    case "graceExpired":
      return p.reasons.graceExpired(status.offlineGraceDays ?? 14);
    default:
      return p.reasons.free;
  }
}

export interface ProLockViewProps {
  feature: PlanFeature;
  status: EntitlementsStatus;
  onSignIn: () => void;
  onUpgrade: () => void;
  onCheck: () => void;
  checking?: boolean;
  /** A smaller card inside a screen (Reports' situation tabs, the HUD screen). */
  compact?: boolean;
}

/** The lock itself, given the plan: what the tests render in each language. */
export function ProLockView({ feature, status, onSignIn, onUpgrade, onCheck, checking = false, compact = false }: ProLockViewProps) {
  const p = useT().plan;
  const reason = status.effective.reason;
  const id = `pro-lock-${feature}`;
  return (
    <section className={`${styles.lock}${compact ? ` ${styles.compact}` : ""}`} aria-labelledby={id} data-feature={feature}>
      <h2 id={id} className={styles.heading}>
        {p.heading}
      </h2>
      <p className={styles.body}>{p.features[feature]}</p>
      <p className={styles.reason}>{lockReason(status, p)}</p>
      <div className={styles.actions}>
        {reason === "signedOut" ? (
          <button type="button" className={styles.button} onClick={onSignIn}>
            {p.signIn}
          </button>
        ) : null}
        {reason === "notChecked" || reason === "graceExpired" ? (
          <button type="button" className={styles.button} disabled={checking} onClick={onCheck}>
            {checking ? p.checking : p.checkAgain}
          </button>
        ) : null}
        <button
          type="button"
          className={reason === "free" ? styles.button : styles.secondary}
          onClick={onUpgrade}
        >
          {p.upgrade}
        </button>
      </div>
    </section>
  );
}

/** The lock, connected: renders nothing unless `feature` is held back. */
export function ProLock({ feature, compact = false }: { feature: PlanFeature; compact?: boolean }) {
  const plan = useEntitlements();
  if (plan.status === null || !plan.locked(feature)) {
    return null;
  }
  return (
    <ProLockView
      feature={feature}
      status={plan.status}
      onSignIn={plan.signIn}
      onUpgrade={plan.upgrade}
      onCheck={plan.checkNow}
      checking={plan.checking}
      compact={compact}
    />
  );
}

/** Settings, Account, Plan: what the plan allows and when it was checked. */
export function PlanPanel() {
  const p = useT().plan;
  const plan = useEntitlements();
  if (plan.status === null) {
    return <p className={styles.muted}>{plan.error ?? p.settings.loading}</p>;
  }
  const when = (ms: number) => WHEN.format(ms);
  const effective = plan.status.effective;
  return (
    <div className={styles.lines}>
      {planLines(plan.status, p, when).map((line) => (
        <p key={line} className={styles.line}>
          {line}
        </p>
      ))}
      {effective.plan !== "open" ? (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={plan.checking} onClick={plan.checkNow}>
            {plan.checking ? p.checking : p.checkAgain}
          </button>
          {effective.plan === "free" ? (
            <button type="button" className={styles.button} onClick={plan.upgrade}>
              {p.upgrade}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The plan in a line or two (Settings, Account), given its status. */
export function planLines(status: EntitlementsStatus, p: Dict["plan"], when: (ms: number) => string): string[] {
  const effective = status.effective;
  const lines: string[] = [];
  if (effective.plan === "open") {
    lines.push(p.settings.open);
  } else if (effective.plan === "pro") {
    lines.push(effective.proUntilMs !== null ? p.settings.proUntil(when(effective.proUntilMs)) : p.settings.pro);
  } else {
    lines.push(p.settings.free);
    if (effective.reason !== "free") lines.push(lockReason(status, p));
  }
  if (status.handsStored !== null && status.handCap !== null && effective.plan !== "open") {
    lines.push(p.settings.handsStored(status.handsStored, status.handCap));
  }
  if (status.check.succeededAtMs !== null && effective.plan !== "open") {
    lines.push(p.settings.lastChecked(when(status.check.succeededAtMs)));
  }
  if (status.check.failing && effective.plan !== "open") {
    lines.push(p.settings.offline);
  }
  return lines;
}

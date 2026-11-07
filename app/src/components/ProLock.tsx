/**
 * (R6.4) The lock shown in place of a Pro feature (Settings' plan badge is
 * `screens/settings/Account.tsx`).
 *
 * Shown only when the app holds the feature back - enforcement on and the
 * effective plan without it (`useEntitlements().locked`); while enforcement
 * is off (today) neither ever renders a lock. What it offers follows why:
 * signed out - "Sign in" (and "Upgrade"); the plan is Free - "Upgrade";
 * not checked yet or the offline grace period is over - "Check again".
 * "Upgrade" opens the web's Plan panel, where Pro is bought (R6.3).
 */
import { useT, type Dict } from "../i18n";
import type { EntitlementsStatus, PlanFeature } from "../lib/ipc";
import { useEntitlements } from "../lib/useEntitlements";
import styles from "./ProLock.module.css";

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

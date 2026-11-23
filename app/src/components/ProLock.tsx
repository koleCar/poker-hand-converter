/**
 * (R6.4, free tier) The lock shown in place of a Pro feature: a blurred
 * skeleton of the screen behind a small card - the Pro badge, one line of
 * what it does, a gold "See Pro" (the web's pricing page in the browser).
 * Settings' plan badge is `screens/settings/Account.tsx`; the solver's
 * locked Nodelock is `solver/nodelock/slot.tsx`.
 *
 * Shown only when the app holds the feature back - enforcement on and the
 * effective plan without it (`useEntitlements().locked`); while enforcement
 * is off (today) nothing here ever renders. When the plan is not just Free
 * the card says why in one more line and offers the way out beside "See
 * Pro": signed out - "Sign in"; not checked yet or the offline grace period
 * is over - "Check again".
 */
import { useT, type Dict } from "../i18n";
import type { EntitlementsStatus, PlanFeature } from "../lib/ipc";
import { useEntitlements } from "../lib/useEntitlements";
import styles from "./ProLock.module.css";

/** Why, in words, when it is more than the Free plan (`null`: just Free). */
export function lockReason(status: EntitlementsStatus, p: Dict["plan"]): string | null {
  switch (status.effective.reason) {
    case "signedOut":
      return p.reasons.signedOut;
    case "notChecked":
      return p.reasons.notChecked;
    case "graceExpired":
      return p.reasons.graceExpired(status.offlineGraceDays ?? 14);
    default:
      return null;
  }
}

export interface ProLockViewProps {
  feature: PlanFeature;
  status: EntitlementsStatus;
  onSignIn: () => void;
  onUpgrade: () => void;
  onCheck: () => void;
  checking?: boolean;
  /** A smaller lock inside a screen (Reports' situation tabs, the HUD editor). */
  compact?: boolean;
  /** The one line, when the screen has its own (the Trainer, Players). */
  line?: string;
  /**
   * One line inside a screen that keeps its free part (Analytics: the
   * player's own numbers stay, docs/ANALYTICS.md Step 12): the badge, the
   * line, the buttons; no skeleton.
   */
  inline?: boolean;
}

/** The skeleton behind the card: no real data, just the screen's rhythm. */
function Skeleton({ compact }: { compact: boolean }) {
  return (
    <div className={styles.preview} aria-hidden="true">
      <span className={`${styles.skel} ${styles.w38}`} />
      <span className={`${styles.skel} ${styles.block}`} />
      {!compact && <span className={`${styles.skel} ${styles.w72}`} />}
      <span className={`${styles.skel} ${styles.w56}`} />
      {!compact && <span className={`${styles.skel} ${styles.block}`} />}
    </div>
  );
}

/** The lock itself, given the plan: what the tests render in each language. */
export function ProLockView({
  feature,
  status,
  onSignIn,
  onUpgrade,
  onCheck,
  checking = false,
  compact = false,
  line,
  inline = false,
}: ProLockViewProps) {
  const p = useT().plan;
  const reason = status.effective.reason;
  const why = lockReason(status, p);
  const id = `pro-lock-${feature}`;
  const buttons = (
    <>
      <button type="button" className={styles.gold} onClick={onUpgrade}>
        {p.upgrade}
      </button>
      {reason === "signedOut" && (
        <button type="button" className={styles.ghost} onClick={onSignIn}>
          {p.signIn}
        </button>
      )}
      {(reason === "notChecked" || reason === "graceExpired") && (
        <button type="button" className={styles.ghost} disabled={checking} onClick={onCheck}>
          {checking ? p.checking : p.checkAgain}
        </button>
      )}
    </>
  );
  if (inline) {
    return (
      <section className={styles.inline} aria-labelledby={id} data-feature={feature}>
        <span className={styles.badge}>{p.pro}</span>
        <span id={id} className={styles.inlineLine}>
          {line ?? p.features[feature]}
          {why ? <span className={styles.reason}> {why}</span> : null}
        </span>
        {buttons}
      </section>
    );
  }
  return (
    <section className={`${styles.lock}${compact ? ` ${styles.compact}` : ""}`} aria-labelledby={id} data-feature={feature}>
      <Skeleton compact={compact} />
      <div className={styles.cover}>
        <div className={styles.card}>
          <span className={styles.badge}>{p.pro}</span>
          <p id={id} className={styles.line}>
            {line ?? p.features[feature]}
          </p>
          {why && <p className={styles.reason}>{why}</p>}
          <div className={styles.actions}>{buttons}</div>
        </div>
      </div>
    </section>
  );
}

/** The lock, connected: renders nothing unless `feature` is held back. */
export function ProLock({ feature, compact = false, line }: { feature: PlanFeature; compact?: boolean; line?: string }) {
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
      line={line}
    />
  );
}

/** The gold "See Pro" (the web's pricing page), for a row or a card. */
export function SeeProButton({ onClick }: { onClick: () => void }) {
  const p = useT().plan;
  return (
    <button type="button" className={styles.gold} onClick={onClick}>
      {p.upgrade}
    </button>
  );
}

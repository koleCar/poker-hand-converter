/**
 * Settings, Account (R1.7, R1.9, R6.4): a tile with who is signed in and
 * sign in / out, then one card with the plan's badge and sync's status,
 * each with its one action. The first-run screen keeps the longer
 * `AccountPanel`.
 */
import { Icon, type IconName } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import { useT, type Dict } from "../../i18n";
import { liveDateFormat } from "../../i18n/format";
import { ipc, type AccountStatus, type EntitlementsStatus, type SyncStatus } from "../../lib/ipc";
import { useAccount } from "../../lib/useAccount";
import { useEntitlements } from "../../lib/useEntitlements";
import { useSync } from "../../lib/useSync";
import styles from "./Settings.module.css";

const DAY = liveDateFormat({ dateStyle: "medium" });
const CLOCK = liveDateFormat({ hour: "2-digit", minute: "2-digit" });

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The account, the plan and sync, in Settings. */
export function Account({ account }: { account: ReturnType<typeof useAccount> }) {
  const configured = account.account !== null && account.account.state !== "notConfigured";
  return (
    <>
      <AccountTile {...account} />
      {configured && (
        <div className={styles.card}>
          <PlanRow />
          <SyncRow />
        </div>
      )}
    </>
  );
}

/** Who is signed in (a round initial, the email) and Sign in / Sign out; a notice or error under it. */
function AccountTile({ account, error, busy, run }: ReturnType<typeof useAccount>) {
  const d = useT().account;
  if (account?.state === "notConfigured") {
    return <p className={styles.note}>{d.notConfigured}</p>;
  }
  const notice = account?.notice ? d.notices[account.notice] : null;
  return (
    <>
      {account === null ? (
        <div className={styles.tile}>
          <span className={`${styles.avatar} ${styles.avatarEmpty}`} aria-hidden="true" />
          {error ? <p className={styles.error}>{d.failed(error)}</p> : <RailLoader size="inline" label={d.loading} showLabel />}
        </div>
      ) : (
        <TileBody account={account} busy={busy} run={run} />
      )}
      {notice && <p className={styles.note}>{notice}</p>}
      {account !== null && error && <p className={`${styles.note} ${styles.error}`}>{d.failed(error)}</p>}
    </>
  );
}

function TileBody({
  account,
  busy,
  run,
}: {
  account: Exclude<AccountStatus, { state: "notConfigured" }>;
  busy: boolean;
  run: (command: () => Promise<AccountStatus>) => Promise<void>;
}) {
  const d = useT().account;
  switch (account.state) {
    case "signedIn":
      return (
        <div className={styles.tile}>
          <span className={styles.avatar} aria-hidden="true">
            {account.email.charAt(0)}
          </span>
          <span className={styles.inline}>
            <span className={`${styles.strong} ${styles.ellipsis}`}>{account.email}</span>
            {!account.online && <span className={styles.pill}>{d.offlineBadge}</span>}
          </span>
          <span className={styles.actions}>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run(ipc.accountSignOut)}>
              {busy ? d.signingOut : d.signOut}
            </button>
          </span>
        </div>
      );
    case "signedOut":
      return (
        <div className={styles.tile}>
          <span className={`${styles.avatar} ${styles.avatarEmpty}`} aria-hidden="true" />
          <span className={styles.strong}>{d.notSignedInShort}</span>
          <span className={styles.actions}>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void run(ipc.accountSignIn)}
            >
              {d.signInShort}
            </button>
          </span>
        </div>
      );
    case "signingIn":
      return (
        <div className={styles.tile}>
          <span className={`${styles.avatar} ${styles.avatarEmpty}`} aria-hidden="true" />
          <span className={styles.value} aria-live="polite">
            <span className={styles.strong}>{d.waitingShort}</span>
            <span className={styles.muted}>{d.timeLeft(minutes(account.secondsLeft))}</span>
          </span>
          <span className={styles.actions}>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run(ipc.accountOpenSignInPage)}>
              {d.openAgain}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void run(ipc.accountCancelSignIn)}
            >
              {d.cancel}
            </button>
          </span>
        </div>
      );
  }
}

/** The plan badge's look and its one action. */
export interface PlanBadge {
  tone: "blue" | "gold" | "yellow" | "grey" | "red" | "dashed";
  icon: IconName | null;
  label: string;
  action: "checkAgain" | "upgrade" | "signIn" | null;
}

/**
 * (R6.4) The plan as one badge, coloured by what can be used now: everything
 * (enforcement off), Pro, Pro held offline (the last check failed: it holds
 * until `proUntilMs`), Free, Pro past its offline grace, or no plan yet.
 */
export function planBadge(status: EntitlementsStatus, b: Dict["plan"]["badge"], when: (ms: number) => string): PlanBadge {
  const effective = status.effective;
  if (effective.plan === "open") return { tone: "blue", icon: "check", label: b.open, action: null };
  if (effective.plan === "pro") {
    return status.check.failing && effective.proUntilMs !== null
      ? { tone: "yellow", icon: "cloudOff", label: b.proOffline(when(effective.proUntilMs)), action: "checkAgain" }
      : { tone: "gold", icon: "star", label: b.pro, action: null };
  }
  switch (effective.reason) {
    case "free":
      return { tone: "grey", icon: "minus", label: b.free, action: "upgrade" };
    case "graceExpired":
      return { tone: "red", icon: "lock", label: b.reconnect, action: "checkAgain" };
    case "signedOut":
      return { tone: "dashed", icon: null, label: b.none, action: "signIn" };
    case "notChecked":
      return { tone: "dashed", icon: null, label: b.none, action: "checkAgain" };
    default:
      return { tone: "dashed", icon: null, label: b.none, action: null };
  }
}

/** The plan row: its badge and, when there is something to do, the action. */
function PlanRow() {
  const p = useT().plan;
  const plan = useEntitlements();
  const badge = plan.status ? planBadge(plan.status, p.badge, (ms) => DAY.format(ms)) : null;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>
        {p.settings.heading}
      </span>
      <span className={styles.value}>
        {badge ? (
          <span className={`${styles.badge} ${styles[badge.tone]}`}>
            {badge.icon && <Icon name={badge.icon} />}
            {badge.label}
          </span>
        ) : plan.error ? (
          <span className={styles.error}>{plan.error}</span>
        ) : (
          <RailLoader size="inline" label={p.settings.loading} showLabel />
        )}
      </span>
      <span className={styles.actions}>
        {badge?.action === "upgrade" && (
          <button type="button" className="btn btn--primary btn--sm" onClick={plan.upgrade}>
            {p.upgrade}
          </button>
        )}
        {badge?.action === "checkAgain" && (
          <button type="button" className="btn btn--sm" disabled={plan.checking} onClick={plan.checkNow}>
            {plan.checking ? p.checking : p.checkAgain}
          </button>
        )}
        {badge?.action === "signIn" && (
          <button type="button" className="btn btn--sm" onClick={plan.signIn}>
            {p.signIn}
          </button>
        )}
      </span>
    </div>
  );
}

function SyncRow() {
  const sync = useSync();
  return <SyncRowView sync={sync.sync} error={sync.error} busy={sync.busy} run={sync.run} />;
}

interface SyncAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/**
 * Sync with the web (R1.9) as one row: a short status on the left, one
 * action on the right (two to answer "upload this computer's hands to the
 * new account?"), the server's refusals as a pill, and while syncing a thin
 * bar of sent of total along the row's bottom edge.
 */
export function SyncRowView({
  sync,
  error,
  busy,
  run,
}: {
  sync: SyncStatus | null | undefined;
  error: string | null;
  busy: boolean;
  run: (command: () => Promise<SyncStatus>) => Promise<void>;
}) {
  const t = useT();
  const d = t.sync;
  const s = d.short;

  let line: string | null = null;
  let tone = styles.strong;
  let actions: SyncAction[] = [];
  let progress: number | null = null;
  const refused = sync ? sync.rejected.reduce((sum, r) => sum + r.count, 0) : 0;

  if (sync === null) {
    line = s.off;
    tone = styles.muted;
  } else if (sync !== undefined) {
    const phase = sync.phase;
    const clock = (ms: number) => CLOCK.format(ms);
    const command = (label: string, step: () => Promise<SyncStatus>, primary = false): SyncAction => ({
      label,
      primary,
      onClick: () => void run(step),
    });
    const pause = command(s.pause, () => ipc.syncSetPaused(true));
    switch (phase.state) {
      case "starting":
        line = d.starting;
        tone = styles.muted;
        break;
      case "signedOut":
        line = s.signedOut;
        tone = styles.muted;
        break;
      case "paused":
        line = s.paused;
        tone = styles.warning;
        actions = [command(s.resume, () => ipc.syncSetPaused(false), true)];
        break;
      case "accountMismatch":
        line = s.mismatch(phase.ownerEmail ?? d.anotherAccount);
        tone = styles.warning;
        actions = [
          command(s.upload, () => ipc.syncAnswerAccount(true), true),
          command(s.keepApart, () => ipc.syncAnswerAccount(false)),
        ];
        break;
      case "declined":
        line = s.declined(phase.email);
        tone = styles.muted;
        actions = [command(s.upload, () => ipc.syncAnswerAccount(true))];
        break;
      case "syncing": {
        const total = Math.max(sync.total, sync.sent);
        line = s.syncing(sync.sent, total);
        progress = total > 0 ? Math.min(100, (sync.sent * 100) / total) : 0;
        actions = [pause];
        break;
      }
      case "upToDate":
        line = s.upToDate;
        actions = [pause];
        break;
      case "offline":
        line = s.offline;
        tone = styles.muted;
        actions = [command(d.syncNow, ipc.syncNow)];
        break;
      case "rateLimited":
        line = s.rateLimited(clock(phase.retryAtMs));
        tone = styles.warning;
        break;
      case "failed":
        line = s.failed(clock(phase.retryAtMs));
        tone = styles.error;
        actions = [command(d.tryAgain, ipc.syncNow)];
        break;
      case "planRequired":
        line = s.planRequired;
        tone = styles.muted;
        actions = [{ label: t.plan.upgrade, primary: true, onClick: () => void ipc.entitlementsOpenUpgrade() }];
        break;
    }
    // The server's refusals: tried again after an update, in place of the everyday action.
    const quiet = phase.state === "syncing" || phase.state === "upToDate" || phase.state === "offline";
    if (refused > 0 && quiet) {
      actions = [command(d.tryAgain, ipc.syncRetryRejected)];
    }
  }

  const failure = sync !== undefined && error ? d.failedAction(error) : null;
  const detail = sync && sync.phase.state === "failed" ? sync.phase.message : undefined;

  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>
        {d.heading}
      </span>
      <span className={styles.value}>
        {sync === undefined ? (
          error ? (
            <span className={styles.error}>{d.failedAction(error)}</span>
          ) : (
            <RailLoader size="inline" label={d.loading} showLabel />
          )
        ) : (
          <span className={styles.inline}>
            <span className={`${tone} ${styles.ellipsis}`} title={detail} aria-live="polite">
              {line}
            </span>
            {refused > 0 && <span className={styles.pill}>{s.refused(refused)}</span>}
          </span>
        )}
        {failure && <span className={styles.error}>{failure}</span>}
      </span>
      <span className={styles.actions}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? "btn btn--primary btn--sm" : "btn btn--sm"}
            disabled={busy}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </span>
      {progress !== null && (
        <span
          className={styles.progress}
          role="progressbar"
          aria-label={line ?? d.heading}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <span className={styles.progressFill} style={{ width: `${progress}%` }} />
        </span>
      )}
    </div>
  );
}

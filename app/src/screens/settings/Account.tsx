/**
 * Settings, Account (R1.7, R1.9, R6.4): a tile with who is signed in and
 * sign in / out, then one card with the plan's badge and sync's status,
 * each with its one action. The first-run screen keeps the longer
 * `AccountPanel`. (Free tier) On Free while plans are enforced, the plan
 * row is followed by the web library's meter (yellow over 90 %) and today's
 * use (hands synced, solver flops); "See Pro" and "Manage plan" open the
 * web.
 */
import { Icon, type IconName } from "@rail/ui/icon/Icon";
import { useEffect, useState, type FormEvent } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import { SeeProButton } from "../../components/ProLock";
import { useT, type Dict } from "../../i18n";
import { liveDateFormat } from "../../i18n/format";

import { errorText, ipc, type AccountProfile, type AccountStatus, type EntitlementsStatus, type SyncStatus } from "../../lib/ipc";
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

/** The account, its name, the plan and sync, in Settings. */
export function Account({ account }: { account: ReturnType<typeof useAccount> }) {
  const configured = account.account !== null && account.account.state !== "notConfigured";
  const signedInAs = account.account?.state === "signedIn" ? account.account.email : null;
  const profile = useProfile(signedInAs);
  return (
    <>
      <AccountTile {...account} name={profile.profile && !profile.profile.provisional ? profile.profile.username : null} />
      {configured && (
        <div className={styles.card}>
          {signedInAs !== null && <NameRow {...profile} />}
          <PlanRows />
          <SyncRow />
        </div>
      )}
      {profile.notice && <p className={`${styles.note} ${styles.success}`}>{profile.notice}</p>}
    </>
  );
}

interface ProfileState {
  profile: AccountProfile | null;
  /** The last load failed (offline, ...): the row offers to try again. */
  failed: boolean;
  loading: boolean;
  notice: string | null;
  reload: () => void;
  saved: (name: string) => void;
}

/** The signed-in account's public name, loaded again whenever the account changes. */
function useProfile(signedInAs: string | null): ProfileState {
  const n = useT().account.name;
  const [state, setState] = useState<{ for: string | null; profile: AccountProfile | null; failed: boolean }>({
    for: null,
    profile: null,
    failed: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (signedInAs === null) return;
    let live = true;
    ipc
      .accountProfile()
      .then((profile) => {
        if (live) setState({ for: signedInAs, profile, failed: false });
      })
      .catch(() => {
        if (live) setState({ for: signedInAs, profile: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [signedInAs, attempt]);

  const current = state.for === signedInAs && signedInAs !== null;
  return {
    profile: current ? state.profile : null,
    failed: current && state.failed,
    loading: signedInAs !== null && !current,
    notice: current ? notice : null,
    reload: () => setAttempt((value) => value + 1),
    saved: (name) => {
      setState({ for: signedInAs, profile: { username: name, provisional: false }, failed: false });
      setNotice(n.saved(name));
    },
  };
}

/** The shape rules, before the round trip; the server checks the rest. */
function nameProblem(n: Dict["account"]["name"], name: string): string | null {
  if (name.length < 3) return n.tooShort;
  if (name.length > 24) return n.tooLong;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return n.badCharacters;
  if (!/^[A-Za-z0-9]/.test(name)) return n.badStart;
  return null;
}

/** The server's refusal (`set_username`'s sentences), in the app's language. */
function refusalText(n: Dict["account"]["name"], error: string): string {
  switch (error) {
    case "That username is taken.":
      return n.refused.taken;
    case "That username is not available.":
      return n.refused.notAvailable;
    case "That username is not allowed.":
      return n.refused.notAllowed;
    case "Your username is already set. It cannot be changed.":
      return n.refused.alreadySet;
    case 'Names starting with "user_" are reserved for new accounts.':
      return n.refused.reservedPrefix;
    case "unreachable":
    case "signedOut":
    case "unavailable":
      return n.offline;
    default:
      return error;
  }
}

/**
 * The public name: what others see instead of the email. Chosen: shown and
 * locked. Still the signup's `user_xxxxxxxx`: "Choose", which opens the
 * field in the row; saved once, for good.
 */
function NameRow({ profile, failed, loading, reload, saved }: ProfileState) {
  const d = useT().account;
  const n = d.name;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const problem = trimmed ? nameProblem(n, trimmed) : null;

  if (loading || failed || profile === null) {
    return (
      <div className={styles.row}>
        <span className={styles.rowLabel}>{n.label}</span>
        <span className={styles.value}>
          {loading ? <RailLoader size="inline" label={n.label} /> : <span className={styles.muted}>{n.loadFailed}</span>}
        </span>
        <span className={styles.actions}>
          {!loading && (
            <button type="button" className="btn btn--sm" onClick={reload}>
              {n.retry}
            </button>
          )}
        </span>
      </div>
    );
  }

  if (!profile.provisional) {
    return (
      <div className={styles.row}>
        <span className={styles.rowLabel}>{n.label}</span>
        <span className={styles.value}>
          <span className={`${styles.strong} ${styles.ellipsis}`}>{profile.username}</span>
          <span className={styles.muted}>{n.locked}</span>
        </span>
        <span className={`${styles.actions} ${styles.muted}`} aria-hidden="true">
          <Icon name="lock" />
        </span>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className={styles.row}>
        <span className={styles.rowLabel}>{n.label}</span>
        <span className={styles.value}>
          <span className={`${styles.badge} ${styles.yellow}`}>{n.notChosen}</span>
          <span className={styles.muted}>{n.hint}</span>
        </span>
        <span className={styles.actions}>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing(true)}>
            {n.choose}
          </button>
        </span>
      </div>
    );
  }

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const local = nameProblem(n, trimmed);
    if (local) {
      setError(local);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      saved(await ipc.accountSetUsername(trimmed));
    } catch (e) {
      setError(refusalText(n, errorText(e)));
      setBusy(false);
    }
  };

  const message = error ?? problem;
  return (
    <form className={`${styles.row} ${styles.rowStack}`} onSubmit={(event) => void save(event)}>
      <label className={styles.rowLabel} htmlFor="settings-name">
        {n.label}
      </label>
      <span className={styles.value}>
        <input
          id="settings-name"
          className={styles.input}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          maxLength={24}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          aria-invalid={Boolean(message)}
          aria-describedby="settings-name-hint"
        />
        <span id="settings-name-hint" className={message ? styles.error : styles.muted} role={error ? "alert" : undefined}>
          {message ?? (trimmed ? n.confirm(trimmed) : n.rules)}
        </span>
        <span className={styles.muted}>{n.hint}</span>
        <span className={styles.inline}>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !trimmed || Boolean(problem)}>
            {busy ? n.saving : n.save}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setValue("");
              setError(null);
            }}
          >
            {d.cancel}
          </button>
        </span>
      </span>
    </form>
  );
}

/** Who is signed in (a round initial, the name and the email) and Sign in / Sign out; a notice or error under it. */
function AccountTile({ account, error, busy, run, name }: ReturnType<typeof useAccount> & { name: string | null }) {
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
        <TileBody account={account} busy={busy} run={run} name={name} />
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
  name,
}: {
  account: Exclude<AccountStatus, { state: "notConfigured" }>;
  busy: boolean;
  run: (command: () => Promise<AccountStatus>) => Promise<void>;
  /** The chosen public name, shown over the email (null: not chosen or not loaded). */
  name: string | null;
}) {
  const d = useT().account;
  switch (account.state) {
    case "signedIn":
      return (
        <div className={styles.tile}>
          <span className={styles.avatar} aria-hidden="true">
            {(name ?? account.email).charAt(0)}
          </span>
          <span className={styles.value}>
            <span className={styles.inline}>
              <span className={`${styles.strong} ${styles.ellipsis}`}>{name ?? account.email}</span>
              {!account.online && <span className={styles.pill}>{d.offlineBadge}</span>}
            </span>
            {name !== null && <span className={`${styles.muted} ${styles.ellipsis}`}>{account.email}</span>}
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

/** The plan's rows: its badge and its one action, then on Free the library and today. */
function PlanRows() {
  const plan = useEntitlements();
  return (
    <>
      <PlanRowView plan={plan} />
      {plan.status && <UsageRowsView status={plan.status} />}
    </>
  );
}

/** The plan row: its badge and, when there is something to do, the action. */
export function PlanRowView({ plan }: { plan: Pick<ReturnType<typeof useEntitlements>, "status" | "error" | "checking" | "upgrade" | "manage" | "checkNow" | "signIn"> }) {
  const p = useT().plan;
  const badge = plan.status ? planBadge(plan.status, p.badge, (ms) => DAY.format(ms)) : null;
  // Pro (or Free) while enforced: the subscription is managed on the web.
  const manage = plan.status?.effective.plan === "pro" && badge?.action === null;
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
        {badge?.action === "upgrade" && <SeeProButton onClick={plan.upgrade} />}
        {manage && (
          <button type="button" className="btn btn--sm" onClick={plan.manage}>
            {p.manage}
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

/**
 * (Free tier) On Free while plans are enforced: the web library's meter
 * (yellow over 90 %), and today's use against the day's caps with when the
 * day starts again. Nothing otherwise.
 */
export function UsageRowsView({ status }: { status: EntitlementsStatus }) {
  const p = useT().plan;
  const s = p.settings;
  if (status.effective.plan !== "free") return null;
  const library = status.handCap !== null && status.handsStored !== null ? { stored: status.handsStored, cap: status.handCap } : null;
  const share = library && library.cap > 0 ? Math.min(1, library.stored / library.cap) : 0;
  const hands = status.dailyHandCap !== null ? s.handsToday(status.handsToday ?? 0, status.dailyHandCap) : null;
  const flops = status.dailyFlopCap !== null ? s.flopsToday(status.flopsToday.length, status.dailyFlopCap) : null;
  const today = [hands, flops].filter((part): part is string => part !== null);
  return (
    <>
      {library && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{s.library}</span>
          <span className={styles.value}>
            <span
              className={`${styles.meter} ${share > 0.9 ? styles.meterFull : ""}`}
              role="meter"
              aria-label={s.library}
              aria-valuemin={0}
              aria-valuemax={library.cap}
              aria-valuenow={library.stored}
            >
              <span className={styles.meterFill} style={{ width: `${share * 100}%` }} />
            </span>
          </span>
          <span className={`${styles.actions} ${share > 0.9 ? styles.warning : styles.muted}`}>
            {s.libraryCount(library.stored, library.cap)}
          </span>
        </div>
      )}
      {today.length > 0 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{s.today}</span>
          <span className={styles.value}>
            <span className={styles.inline}>
              <span className={styles.strong}>{today.join(" · ")}</span>
              {status.dayResetsAtMs !== null && <span className={styles.muted}>{s.resets(CLOCK.format(status.dayResetsAtMs))}</span>}
            </span>
          </span>
          <span className={styles.actions} />
        </div>
      )}
    </>
  );
}

function SyncRow() {
  const sync = useSync();
  return <SyncRowView sync={sync.sync} error={sync.error} busy={sync.busy} run={sync.run} />;
}

interface SyncAction {
  label: string;
  primary?: boolean;
  /** "See Pro": the gold button. */
  gold?: boolean;
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
        actions = [{ label: t.plan.upgrade, gold: true, onClick: () => void ipc.entitlementsOpenUpgrade() }];
        break;
      case "dailyCap":
        line = s.dailyCap(phase.cap, clock(phase.resetsAtMs));
        tone = styles.muted;
        actions = [{ label: t.plan.upgrade, gold: true, onClick: () => void ipc.entitlementsOpenUpgrade() }];
        break;
      case "libraryFull":
        line = s.libraryFull(phase.cap);
        tone = styles.warning;
        actions = [{ label: t.plan.upgrade, gold: true, onClick: () => void ipc.entitlementsOpenUpgrade() }];
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
        {actions.map((action) =>
          action.gold ? (
            <SeeProButton key={action.label} onClick={action.onClick} />
          ) : (
            <button
              key={action.label}
              type="button"
              className={action.primary ? "btn btn--primary btn--sm" : "btn btn--sm"}
              disabled={busy}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ),
        )}
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

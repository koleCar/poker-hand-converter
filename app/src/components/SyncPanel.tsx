/**
 * Sync with the web (R1.9), under Settings, Account: what sync is doing
 * ("Syncing 120 of 4 000 hands", up to date, offline, paused, waiting for an
 * answer after another account signed in), the hands the server refused
 * per reason, and the controls: Sync now, Pause, the upload limit for a
 * large backlog, and the answer to "upload this computer's hands to the new
 * account?". (R6.4) Held by the plan: why, and "Upgrade to Pro".
 */
import { useT } from "../i18n";
import { ipc, type SyncStatus } from "../lib/ipc";
import { liveDateFormat, liveNumberFormat } from "../i18n/format";
import styles from "./SyncPanel.module.css";

const number = liveNumberFormat();
const CLOCK = liveDateFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The choices of the upload limit, bytes a second (`null`: none). */
const CAPS: [key: "slow" | "normal" | "fast" | "none", bytes: number | null][] = [
  ["slow", 256 * 1024],
  ["normal", 1024 * 1024],
  ["fast", 4 * 1024 * 1024],
  ["none", null],
];

function clock(ms: number): string {
  return CLOCK.format(ms);
}

function limit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${number.format(bytes / (1024 * 1024))} MB/s` : `${number.format(bytes / 1024)} KB/s`;
}

export function SyncPanel({
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

  if (sync === undefined) {
    return <p className={styles.muted}>{error ? d.failedAction(error) : d.loading}</p>;
  }
  if (sync === null) {
    return <p className={styles.muted}>{d.off}</p>;
  }

  const phase = sync.phase;
  const failure = error ? <p className={styles.error}>{d.failedAction(error)}</p> : null;
  const owner = (email: string | null) => email ?? d.anotherAccount;

  let line: string;
  let tone = styles.body;
  switch (phase.state) {
    case "starting":
      line = d.starting;
      break;
    case "signedOut":
      line = d.signedOut(sync.outbox);
      tone = styles.muted;
      break;
    case "paused":
      line = d.paused(sync.outbox);
      tone = styles.notice;
      break;
    case "accountMismatch":
      line = d.mismatch(owner(phase.ownerEmail), phase.email, phase.localHands);
      tone = styles.notice;
      break;
    case "declined":
      line = d.declined(phase.email);
      tone = styles.notice;
      break;
    case "syncing":
      line = d.syncing(sync.sent, Math.max(sync.total, sync.sent));
      break;
    case "upToDate":
      line = d.upToDate;
      break;
    case "offline":
      line = d.offline(sync.outbox);
      tone = styles.muted;
      break;
    case "rateLimited":
      line = d.rateLimited(clock(phase.retryAtMs));
      tone = styles.notice;
      break;
    case "failed":
      line = d.failed(phase.message, clock(phase.retryAtMs));
      tone = styles.error;
      break;
    case "planRequired":
      line = d.planRequired(sync.outbox);
      tone = styles.notice;
      break;
  }

  const details: string[] = [];
  if (phase.state === "syncing" && sync.handsPerSecond !== null && sync.bytesPerSecond !== null) {
    details.push(d.speed(sync.handsPerSecond, Math.round(sync.bytesPerSecond / 1024)));
  }
  if (phase.state === "syncing" && sync.capNow !== null) {
    details.push(d.capped(limit(sync.capNow)));
  }
  if (sync.retrying > 0 && phase.state !== "offline") {
    details.push(d.retrying(sync.retrying));
  }
  if (sync.lastSyncAt !== null && (phase.state === "upToDate" || phase.state === "offline")) {
    details.push(d.lastSync(clock(sync.lastSyncAt)));
  }
  if (sync.pulled > 0) {
    details.push(d.pulled(sync.pulled));
  }
  if (sync.pullSkipped > 0) {
    details.push(d.pullSkipped(sync.pullSkipped));
  }
  const refused = sync.rejected.reduce((sum, r) => sum + r.count, 0);
  const active = phase.state !== "signedOut" && phase.state !== "accountMismatch" && phase.state !== "declined";
  const capKey = CAPS.find(([, bytes]) => bytes === sync.cap)?.[0] ?? "normal";

  return (
    <div className={styles.panel}>
      <p className={tone} aria-live="polite">
        {line}
      </p>
      {details.map((text) => (
        <p key={text} className={styles.muted}>
          {text}
        </p>
      ))}

      {phase.state === "accountMismatch" && (
        <>
          <p className={styles.body}>{d.mismatchQuestion(phase.email)}</p>
          <p className={styles.muted}>{d.mismatchHint}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => void run(() => ipc.syncAnswerAccount(true))}
            >
              {d.upload(phase.email)}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => void run(() => ipc.syncAnswerAccount(false))}
            >
              {d.keepApart}
            </button>
          </div>
        </>
      )}
      {phase.state === "planRequired" && (
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => void ipc.entitlementsOpenUpgrade()}>
            {t.plan.upgrade}
          </button>
        </div>
      )}
      {phase.state === "declined" && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void run(() => ipc.syncAnswerAccount(true))}
          >
            {d.uploadInstead(phase.email)}
          </button>
        </div>
      )}

      {refused > 0 && (
        <div className={styles.rejected}>
          <p className={styles.notice}>{d.rejectedHeading(refused)}</p>
          <ul className={styles.reasons}>
            {sync.rejected.map((r) => (
              <li key={r.reason}>
                <span>{d.reasons[r.reason] ?? d.otherReason(r.reason)}</span>
                <span className={styles.count}>{number.format(r.count)}</span>
              </li>
            ))}
          </ul>
          <p className={styles.muted}>{d.rejectedHint}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => void run(ipc.syncRetryRejected)}
            >
              {d.tryAgain}
            </button>
          </div>
        </div>
      )}

      {failure}

      {active && (
        <div className={styles.actions}>
          {!sync.paused && (
            <button type="button" className={styles.button} disabled={busy} onClick={() => void run(ipc.syncNow)}>
              {d.syncNow}
            </button>
          )}
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void run(() => ipc.syncSetPaused(!sync.paused))}
          >
            {sync.paused ? d.resume : d.pause}
          </button>
          <label className={styles.cap}>
            <span>{d.capLabel}</span>
            <select
              value={capKey}
              disabled={busy}
              onChange={(event) => {
                const bytes = CAPS.find(([key]) => key === event.target.value)?.[1] ?? null;
                void run(() => ipc.syncSetCap(bytes));
              }}
            >
              {CAPS.map(([key]) => (
                <option key={key} value={key}>
                  {d.caps[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

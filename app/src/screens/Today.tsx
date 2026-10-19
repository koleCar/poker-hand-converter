import { useEffect, useState } from "react";

import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { errorText, inApp, ipc, type StoreStatus } from "../lib/ipc";
import { go } from "../lib/router";
import { hudState, refusedRoomNames } from "../lib/hudCompliance";
import { useAccount } from "../lib/useAccount";
import { useHudCompliance } from "../lib/useHudCompliance";
import { useSync } from "../lib/useSync";
import { ImportStatus } from "./ImportStatus";
import { SessionPanel } from "./today/SessionPanel";
import { liveNumberFormat } from "../i18n/format";
import styles from "./Today.module.css";

/** How often the counts refresh while the screen is open. */
const REFRESH_MS = 5000;

const number = liveNumberFormat();

/** Today: who is signed in (R1.7), how sync stands (R1.9) and the HUD at the
 * tables - on how many, and which it left alone because the room does not
 * allow it (R3.10) -, the current
 * session - its result, hands, statistics and biggest pots (R2.7b) - the
 * watcher's folders with a backfill's progress (R1.3, R1.6) and the local
 * store's counts (R1.2). */
export function Today() {
  const t = useT();
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    let live = true;
    const load = () => {
      ipc
        .storeStatus()
        .then((next) => {
          if (live) {
            setStatus(next);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (live) {
            setError(errorText(e));
          }
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const d = t.today;
  const failure = error ?? status?.error ?? null;
  const tiles: [label: string, value: number][] = status
    ? [
        [d.hands, status.hands],
        [d.handsToday, status.handsToday],
        [d.outbox, status.outbox],
        [d.files, status.files],
        [d.folders, status.sources],
        [d.quarantined, status.quarantined],
        [d.unsupported, status.unsupported],
        [d.filesWithErrors, status.filesWithErrors],
      ]
    : [];

  return (
    <>
      <ScreenHeader title={t.screens.today.title} lead={t.screens.today.lead} />
      <AccountLine />
      <SyncLine />
      <HudLine />
      <SessionPanel />
      <ImportStatus />
      <section className={styles.section} aria-labelledby="today-store">
        <h2 id="today-store" className={styles.heading}>
          {d.heading}
        </h2>
        {!inApp && <p className={styles.muted}>{d.unavailable}</p>}
        {inApp && failure && (
          <p className={styles.error} role="alert">
            {d.storeError(failure)}
          </p>
        )}
        {inApp && !failure && !status && <p className={styles.muted}>{d.loading}</p>}
        {status && !status.error && (
          <>
            <dl className={styles.tiles}>
              {tiles.map(([label, value]) => (
                <div key={label} className={styles.tile}>
                  <dt className={styles.label}>{label}</dt>
                  <dd className={styles.value}>{number.format(value)}</dd>
                </div>
              ))}
            </dl>
            {status.hands === 0 && <p className={styles.muted}>{d.empty}</p>}
            <p className={styles.muted}>
              {d.storeFile} <span className={styles.mono}>{status.path}</span>
            </p>
          </>
        )}
      </section>
    </>
  );
}

/** One line: signed in as whom (and whether online), or not signed in. */
function AccountLine() {
  const t = useT();
  const { account } = useAccount();
  if (!account || account.state === "notConfigured") {
    return null;
  }
  const text =
    account.state === "signedIn"
      ? account.online
        ? t.account.signedInAs(account.email)
        : `${t.account.signedInAs(account.email)} · ${t.account.offline}`
      : account.state === "signingIn"
        ? t.account.signingInShort
        : t.account.notSignedIn;
  return (
    <p className={styles.account}>
      <span>{text}</span>
      <button type="button" className={styles.link} onClick={() => go("settings")}>
        {t.today.account}
      </button>
    </p>
  );
}

/** One line: how sync with the web stands (R1.9); nothing when sync is off
 * or nobody is signed in (the account line says so). */
function SyncLine() {
  const t = useT();
  const { sync } = useSync();
  if (!sync || sync.phase.state === "signedOut" || sync.phase.state === "starting") {
    return null;
  }
  const d = t.sync.today;
  let text: string;
  switch (sync.phase.state) {
    case "upToDate":
      text = d.upToDate;
      break;
    case "syncing":
      text = sync.sent > 0 ? d.syncing(sync.sent, Math.max(sync.total, sync.sent)) : d.waiting(sync.outbox);
      break;
    case "offline":
      text = d.offline;
      break;
    case "paused":
      text = d.paused;
      break;
    case "accountMismatch":
    case "declined":
      text = d.question;
      break;
    case "rateLimited":
      text = d.waiting(sync.outbox);
      break;
    case "failed":
      text = d.problem;
      break;
  }
  return (
    <p className={styles.account}>
      <span>{text}</span>
      <button type="button" className={styles.link} onClick={() => go("settings")}>
        {d.details}
      </button>
    </p>
  );
}

/** One line: the HUD at the tables (R3.10) - off, on how many tables, and
 * how many it left alone because their room does not allow it, with the
 * HUD screen a click away for the why. */
function HudLine() {
  const t = useT();
  const { status, policy } = useHudCompliance();
  if (!inApp || status === null) {
    return null;
  }
  const d = t.hudStatus.today;
  const state = hudState(status);
  const rooms = refusedRoomNames(status, policy);
  let text =
    state === "off"
      ? d.off
      : state === "starting"
        ? d.starting
        : status.tables.length === 0
          ? d.none
          : d.tables(status.tables.length);
  if (status.refused.length > 0) {
    text = `${text} · ${d.refused(status.refused.length, rooms.join(", "))}`;
  }
  return (
    <p className={styles.account}>
      <span>{text}</span>
      <button type="button" className={styles.link} onClick={() => go("hud")}>
        {d.details}
      </button>
    </p>
  );
}

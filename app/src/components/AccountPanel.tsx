/**
 * The desktop account (R1.7), shared by Settings, Account and the first-run
 * screen's step 1: sign in through the browser, wait for it, see who is
 * signed in, sign out. `children` adds actions next to Sign in (the first-run
 * screen's "Use offline").
 */
import type { ReactNode } from "react";

import { useT } from "../i18n";
import { ipc, type AccountNotice, type AccountStatus } from "../lib/ipc";
import styles from "./AccountPanel.module.css";

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AccountPanel({
  account,
  error,
  busy,
  run,
  allowSignOut = true,
  children,
}: {
  account: AccountStatus | null;
  error: string | null;
  busy: boolean;
  run: (command: () => Promise<AccountStatus>) => Promise<void>;
  /** The first-run screen offers no sign-out. */
  allowSignOut?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const d = t.account;
  const notice = (n: AccountNotice | null | undefined) => (n ? <p className={styles.notice}>{d.notices[n]}</p> : null);
  const failure = error ? <p className={styles.error}>{d.failed(error)}</p> : null;

  if (account === null) {
    return <p className={styles.muted}>{error ? d.failed(error) : d.loading}</p>;
  }

  switch (account.state) {
    case "notConfigured":
      return <p className={styles.muted}>{d.notConfigured}</p>;

    case "signedOut":
      return (
        <>
          <p className={styles.body}>{d.signedOut}</p>
          {notice(account.notice)}
          {failure}
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void run(ipc.accountSignIn)}>
              {d.signIn}
            </button>
            {children}
          </div>
        </>
      );

    case "signingIn":
      return (
        <>
          <p className={styles.body} aria-live="polite">
            {d.waiting(minutes(account.secondsLeft))}
          </p>
          <p className={styles.muted}>{d.waitingHint}</p>
          {notice(account.notice)}
          {failure}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => void run(ipc.accountOpenSignInPage)}
            >
              {d.openAgain}
            </button>
            <button
              type="button"
              className={styles.link}
              disabled={busy}
              onClick={() => void run(ipc.accountCancelSignIn)}
            >
              {d.cancel}
            </button>
          </div>
        </>
      );

    case "signedIn":
      return (
        <>
          <p className={styles.signedIn}>{d.signedInAs(account.email)}</p>
          <p className={account.online ? styles.muted : styles.notice}>{account.online ? d.online : d.offline}</p>
          {notice(account.notice)}
          {failure}
          {allowSignOut && (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => void run(ipc.accountSignOut)}
              >
                {busy ? d.signingOut : d.signOut}
              </button>
            </div>
          )}
        </>
      );
  }
}

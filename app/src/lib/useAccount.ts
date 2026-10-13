/**
 * The desktop account's status (`account_status`, R1.7), kept current:
 * loaded at once, again whenever the app says it changed
 * (`account-changed`), and every second while a sign-in waits for the
 * browser (the countdown).
 */
import { useCallback, useEffect, useState } from "react";

import { errorText, inApp, ipc, onAccountChanged, type AccountStatus } from "./ipc";

export function useAccount(): {
  account: AccountStatus | null;
  error: string | null;
  /** Run an account command; its answer becomes the status. */
  run: (command: () => Promise<AccountStatus>) => Promise<void>;
  busy: boolean;
} {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    ipc
      .accountStatus()
      .then((next) => {
        setAccount(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    reload();
    return onAccountChanged(reload);
  }, [reload]);

  const waiting = account?.state === "signingIn";
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = window.setInterval(reload, 1000);
    return () => window.clearInterval(timer);
  }, [waiting, reload]);

  const run = useCallback(async (command: () => Promise<AccountStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await command());
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { account, error, run, busy };
}

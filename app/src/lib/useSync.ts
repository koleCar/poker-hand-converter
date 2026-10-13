/**
 * The sync status (`sync_status`, R1.9), kept current: loaded at once, again
 * whenever the app says it changed (`sync-changed`, `account-changed`), and
 * every few seconds for the times it shows ("tries again at ...").
 */
import { useCallback, useEffect, useState } from "react";

import { errorText, inApp, ipc, onAccountChanged, onSyncChanged, type SyncStatus } from "./ipc";

const REFRESH_MS = 5000;

export function useSync(): {
  /** `undefined` while loading; `null` when sync is off in this build. */
  sync: SyncStatus | null | undefined;
  error: string | null;
  /** Run a sync command; its answer becomes the status. */
  run: (command: () => Promise<SyncStatus>) => Promise<void>;
  busy: boolean;
} {
  const [sync, setSync] = useState<SyncStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    ipc
      .syncStatus()
      .then((next) => {
        setSync(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    reload();
    const stopSync = onSyncChanged(reload);
    const stopAccount = onAccountChanged(reload);
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => {
      stopSync();
      stopAccount();
      window.clearInterval(timer);
    };
  }, [reload]);

  const run = useCallback(async (command: () => Promise<SyncStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setSync(await command());
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { sync, error, run, busy };
}

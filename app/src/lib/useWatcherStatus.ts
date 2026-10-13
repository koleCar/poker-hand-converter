/**
 * The watcher's status (`watcher_status`), kept current: loaded at once,
 * again whenever the app says it changed (`watcher-changed`, at most once a
 * second: imports, backfill progress, a folder's state - R1.6), and every
 * few seconds as a fallback.
 */
import { useCallback, useEffect, useState } from "react";

import { errorText, inApp, ipc, onWatcherChanged, type WatchStatus } from "./ipc";

/** The fallback refresh while nothing is reported. */
const FALLBACK_MS = 5000;

export function useWatcherStatus(): {
  status: WatchStatus | null;
  error: string | null;
  reload: () => void;
} {
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    ipc
      .watcherStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    reload();
    const stop = onWatcherChanged(reload);
    const timer = window.setInterval(reload, FALLBACK_MS);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [reload]);

  return { status, error, reload };
}

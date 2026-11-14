/**
 * The sidebar's update card: the update's status as the app has it
 * (`update_status`), loaded at once and replaced by every
 * `updates-changed` event (a check's answer, download progress, a failure),
 * with the user's steps: check, download, install and restart.
 * Outside the app the status stays `null`.
 */
import { useCallback, useEffect, useState } from "react";

import { errorText, inApp, ipc, onUpdatesChanged, type UpdateStatus } from "./ipc";

export interface UseUpdates {
  /** `null` while loading or outside the app. */
  status: UpdateStatus | null;
  /** A command that was refused (the status carries the steps' own failures). */
  error: string | null;
  check: () => void;
  download: () => void;
  install: () => void;
  setAutomatic: (enabled: boolean) => void;
  openDownloadPage: () => void;
}

export function useUpdates(): UseUpdates {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    let heard = false;
    const stop = onUpdatesChanged((next) => {
      heard = true;
      setStatus(next);
    });
    ipc
      .updateStatus()
      .then((next) => {
        // An event heard meanwhile is newer than this answer.
        if (live && !heard) setStatus(next);
      })
      .catch((e: unknown) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
      stop();
    };
  }, []);

  const run = useCallback((step: Promise<UpdateStatus | null>) => {
    setError(null);
    step
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  return {
    status,
    error,
    check: useCallback(() => run(ipc.updateCheck()), [run]),
    download: useCallback(() => run(ipc.updateDownload()), [run]),
    install: useCallback(() => run(ipc.updateInstall()), [run]),
    setAutomatic: useCallback((enabled: boolean) => run(ipc.setCheckForUpdates(enabled)), [run]),
    openDownloadPage: useCallback(() => run(ipc.updateOpenDownloadPage()), [run]),
  };
}

/**
 * GitHub's generated release notes, made readable as plain text: no
 * heading marks or bold, each change without its "by @someone in <link>"
 * tail, and without GitHub's "What's Changed" heading and "Full Changelog"
 * line.
 */
export function readableNotes(notes: string): string {
  return notes
    .split(/\r?\n/)
    .filter((line) => !/^\s*\*\*Full Changelog\*\*/i.test(line) && !/^#{1,6}\s+What's Changed\s*$/i.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\s+by @[\w-]+ in https?:\/\/\S+\s*$/, "")
        .replace(/^\s*[*-]\s+/, "• "),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

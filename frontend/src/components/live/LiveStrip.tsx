"use client";

/**
 * The shell's live strip (Rail R4.3), above a live screen's content:
 *
 * - a web upload running in another tab or on another device of the account
 *   ("Saving 120 000 of ~1 000 000 hands from a web upload"), with a bar when
 *   the total is known, then "finished" for a few seconds;
 * - the desktop app syncing ("Desktop app syncing: 12 500 hands so far");
 * - on screens that do not re-read on their own, "N new hands arrived -
 *   refresh": the reader decides when the screen changes under them.
 *
 * Accessibility: the counts change every couple of seconds, so they are not
 * in a live region (a screen reader would read every tick). A separate,
 * visually hidden `aria-live="polite"` region announces only beginnings and
 * ends - an upload started elsewhere, an upload finished, the desktop app
 * syncing, new hands to show. Renders nothing when there is nothing to say.
 */

import { useEffect, useRef } from "react";
import type { DesktopSyncState } from "../../lib/live/arrivals";
import type { UploadActivity } from "../../lib/live/activity";
import { useDict } from "../../lib/i18n/client";
import styles from "./live.module.css";

interface LiveStripProps {
  uploads: UploadActivity[];
  /** An active desktop sync, or null. */
  desktop: DesktopSyncState | null;
  /** Hands that arrived and are not on screen yet (notify screens); null when none. */
  newHands: number | null;
  onRefresh?: () => void;
}

function uploadText(t: ReturnType<typeof useDict>["chrome"]["live"], upload: UploadActivity): string {
  switch (upload.state) {
    case "done":
      return t.uploadDone(upload.inserted, upload.duplicates);
    case "paused":
      return t.uploadPaused(upload.sent);
    case "retrying":
      return t.uploadRetrying(upload.sent);
    case "waiting":
      return t.uploadWaiting(upload.sent);
    default:
      return t.uploadSaving(upload.sent, upload.total, upload.estimated);
  }
}

export function LiveStrip({ uploads, desktop, newHands, onRefresh }: LiveStripProps) {
  const t = useDict().chrome.live;
  const region = useRef<HTMLDivElement | null>(null);
  const seen = useRef<{ uploads: Map<string, string>; desktop: boolean; newHands: boolean }>({
    uploads: new Map(),
    desktop: false,
    newHands: false,
  });

  // Announce what began or ended since the last render; never a count tick.
  useEffect(() => {
    const before = seen.current;
    const said: string[] = [];
    const next = new Map<string, string>();
    for (const upload of uploads) {
      next.set(upload.id, upload.state);
      const was = before.uploads.get(upload.id);
      if (upload.state === "done" && was !== "done") {
        said.push(uploadText(t, upload));
      } else if (was === undefined && upload.state !== "done") {
        said.push(t.announceUpload);
      }
    }
    if (desktop && !before.desktop) said.push(t.announceDesktop);
    if (newHands !== null && !before.newHands) said.push(t.newHands(newHands));
    seen.current = { uploads: next, desktop: desktop !== null, newHands: newHands !== null };
    // The region is written directly: it is an announcement, not state to render.
    if (said.length > 0 && region.current) region.current.textContent = said.join(" ");
  }, [uploads, desktop, newHands, t]);

  const empty = uploads.length === 0 && !desktop && newHands === null;

  return (
    <>
      <div ref={region} className={styles.srOnly} aria-live="polite" role="status" />
      {empty ? null : (
        <section className={styles.strip} aria-label={t.region}>
          {uploads.map((upload) => {
            const percent =
              upload.total && upload.state !== "done"
                ? Math.min(100, Math.round((upload.sent / upload.total) * 100))
                : null;
            const text = uploadText(t, upload);
            return (
              <div key={upload.id} className={styles.line} title={t.elsewhere}>
                <span
                  className={`${styles.dot} ${upload.state === "done" ? styles.dotDone : upload.state === "saving" ? "" : styles.dotWarn}`}
                  aria-hidden="true"
                />
                <span className={styles.text}>{text}</span>
                {percent !== null ? (
                  <span
                    className={styles.bar}
                    role="progressbar"
                    aria-label={text}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span className={styles.barFill} style={{ width: `${Math.max(2, percent)}%` }} />
                  </span>
                ) : null}
              </div>
            );
          })}
          {desktop ? (
            <div className={styles.line}>
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.text}>{t.desktopSyncing(desktop.hands)}</span>
            </div>
          ) : null}
          {newHands !== null && onRefresh ? (
            <button type="button" className={`btn btn--sm ${styles.fresh}`} onClick={onRefresh}>
              {t.newHands(newHands)}
            </button>
          ) : null}
        </section>
      )}
    </>
  );
}

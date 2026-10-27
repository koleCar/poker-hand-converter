/**
 * The owner's switch: show the players' screen names on this share link
 * (R4.5). Off by default - a stranger with the link sees Hero, Villain1,
 * Villain2… - and the database enforces it (`read_share`,
 * `20270623090000_share_names.sql`); this only flips the link's flag.
 *
 * Only the link's owner gets a state back from `share_names_state`, so for
 * anyone else (or nobody signed in) this renders nothing - the same posture
 * as `AnalysisShareToggle`, whose look it shares.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useAuth } from "../../lib/auth";
import { setShareNames, shareNamesState, type ShareNamesState } from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import styles from "../analysis/AnalysisShareToggle.module.css";

export function ShareNamesToggle({
  slug,
  refreshOnChange = false,
  className,
}: {
  slug: string;
  /** Re-render the server page after a change: the share page reads its hand on the server. */
  refreshOnChange?: boolean;
  className?: string;
}) {
  const t = useDict().chrome.share.names;
  const auth = useAuth();
  const router = useRouter();
  const describedBy = useId();
  const [state, setState] = useState<ShareNamesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.isSignedIn) return;
    let live = true;
    shareNamesState(slug).then(
      (next) => {
        if (live) setState(next);
      },
      // Not the reader's link, or a database without the migration: no switch.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, slug]);

  if (!auth.isSignedIn || !state) return null;

  async function toggle(next: boolean) {
    const before = state;
    setBusy(true);
    setError(null);
    setState((current) => (current ? { ...current, showNames: next } : current));
    try {
      const saved = await setShareNames(slug, next);
      setState(saved);
      if (refreshOnChange) router.refresh();
    } catch (err) {
      setState(before);
      setError(t.failed(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.box}${className ? ` ${className}` : ""}`}>
      <label className={styles.row}>
        <input
          type="checkbox"
          checked={state.showNames}
          disabled={busy}
          aria-describedby={describedBy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>{t.label}</span>
      </label>
      <p id={describedBy} className={styles.text}>
        {t.explain}
      </p>
      <p className={styles.status} role="status">
        {busy ? t.saving : state.showNames ? t.shown : t.hidden}
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

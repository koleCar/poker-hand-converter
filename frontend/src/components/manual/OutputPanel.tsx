"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { isDatabaseConfigured, rebuildStats, saveHand } from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import type { BuildResult } from "../../lib/manual";
import { toStandardText } from "../../lib/phf";
import { copyToClipboard, downloadText, outputFileName } from "../converter/handoff";
import { ReplayViewer } from "../replayer/ReplayViewer";
import { ShareHandButton } from "../share/ShareHandButton";
import styles from "./manual.module.css";

interface OutputPanelProps {
  built: BuildResult | null;
  /** Set once this exact hand is in the library; `id` is its row when known. */
  stored: { id: string | null } | null;
  onStored: (id: string | null) => void;
  /** Lets the shell refresh its stored-hand counter. */
  onSaved?: () => void;
}

/**
 * The finished hand: the replayer, and the ways out of the editor — download,
 * copy, share, save. Saving is the only thing on the page that talks to a
 * server, and only when the user asks, exactly like the paste box on
 * `/convert` (`upload/SingleHandPanel.tsx`, whose save flow this follows).
 */
export function OutputPanel({ built, stored, onStored, onSaved }: OutputPanelProps) {
  const dict = useDict();
  const t = dict.manual.output;
  const auth = useAuth();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const wantsSaveRef = useRef(false);
  const hand = built?.ok ? built.hand : null;

  async function save() {
    if (!hand || stored) return;
    if (!auth.isSignedIn) {
      wantsSaveRef.current = true;
      auth.requestSignIn(dict.converter.save.signInReason);
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await saveHand(hand, toStandardText(hand));
      onStored(result.id);
      setNotice({ kind: "info", text: result.duplicate ? dict.converter.save.alreadySaved : dict.converter.save.saved });
      onSaved?.();
      if (!result.duplicate) void rebuildStats().catch(() => undefined);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : dict.converter.save.failed });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (auth.isSignedIn && wantsSaveRef.current) {
      wantsSaveRef.current = false;
      void save();
    }
    // Same latch as `SingleHandPanel`: only the sign-in itself should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isSignedIn]);

  if (!built) {
    return (
      <section className="card">
        <h2 className={styles.heading}>{t.heading}</h2>
        <p className={styles.dim}>{t.notReady}</p>
      </section>
    );
  }

  if (!built.ok) {
    return (
      <section className="card">
        <h2 className={styles.heading}>{t.heading}</h2>
        <div className="notice notice--error">
          <p>{t.refused}</p>
          <ul>
            {built.errors.map((error, i) => (
              <li key={i}>{error.message}</li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  const text = toStandardText(built.hand);
  return (
    <>
      <section className="card">
        <div className={styles.headRow}>
          <h2 className={styles.heading}>{t.heading}</h2>
          <div className={styles.row}>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => downloadText(outputFileName(`${built.hand.meta.handId}.txt`, t.fileStem, t.fileStem), text)}
            >
              {t.download}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={async () =>
                setNotice((await copyToClipboard(text)) ? { kind: "info", text: t.copied } : { kind: "error", text: t.copyFailed })
              }
            >
              {t.copy}
            </button>
            {isDatabaseConfigured && !stored ? (
              <button type="button" className="btn btn--primary btn--sm" disabled={saving} onClick={() => void save()}>
                {saving ? dict.converter.save.saving : dict.converter.save.button}
              </button>
            ) : null}
          </div>
        </div>
        {built.warnings.length > 0 ? (
          <div className="notice notice--warn">
            <p>{t.warnings}</p>
            <ul>
              {built.warnings.map((warning, i) => (
                <li key={i}>{warning.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {notice ? <p className={`notice notice--${notice.kind}`}>{notice.text}</p> : null}
      </section>

      <section className="card card--flush">
        <ReplayViewer
          key={text}
          hand={built.hand}
          site={dict.manual.title}
          urlSync={false}
          headerExtra={<ShareHandButton hand={built.hand} storedHandId={stored?.id ?? null} iconOnly />}
        />
      </section>
    </>
  );
}

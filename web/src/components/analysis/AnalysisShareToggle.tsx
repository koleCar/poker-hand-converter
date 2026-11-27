/**
 * The owner's switch: show this hand's analysis wherever the hand is public
 * (A7.1, `docs/ANALYSIS-PLAN.md` §8.4 — private by default, a per-hand
 * opt-in).
 *
 * One flag per hand, whichever door the owner comes through: the analysis
 * page, the publish dialog, the share dialog, their own poll or thread. The
 * hand is named by a surface the owner made (`hand`, `published`, `post`,
 * `share`), and the database answers only to the owner — anyone else gets
 * nothing, and this renders nothing.
 *
 * The copy says exactly what becomes visible and where, and says so before
 * the box is ticked.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ANALYSIS_VERSION } from "../../lib/analysis/types";
import { useAuth } from "../../lib/auth";
import { analysisShareState, setAnalysisShare, type AnalysisShareState, type ShareSurface } from "../../lib/db/analysisShare";
import { useDict } from "../../lib/i18n/client";
import { SettingRow, TipLine } from "@rail/ui/share/SettingRow";
import { paths } from "../../lib/routes";
import styles from "./AnalysisShareToggle.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

export function AnalysisShareToggle({
  surface,
  id,
  poll = false,
  onChange,
  refreshOnChange = false,
  compact = false,
  onState,
  className,
}: {
  surface: ShareSurface;
  id: string;
  /** Add the poll's rule: the reference shows only after a reader votes. */
  poll?: boolean;
  onChange?: (state: AnalysisShareState) => void;
  /** Re-render the server page after a change: a public page whose analysis was read on the server. */
  refreshOnChange?: boolean;
  /** One row with the explanation on hover: the share popover and the post preview. */
  compact?: boolean;
  /** The state as loaded, and after every change: the post preview draws the analysis from it. */
  onState?: (state: AnalysisShareState) => void;
  className?: string;
}) {
  const t = useDict().analysis.share.toggle;
  const auth = useAuth();
  const router = useRouter();
  const describedBy = useId();
  const [state, setState] = useState<AnalysisShareState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onStateRef = useRef(onState);
  useEffect(() => {
    onStateRef.current = onState;
  });

  useEffect(() => {
    if (!auth.isSignedIn) return;
    let live = true;
    analysisShareState(surface, id).then(
      (next) => {
        if (!live) return;
        setState(next);
        if (next) onStateRef.current?.(next);
      },
      // A database without this migration, or a hand that is not the reader's:
      // either way there is no switch to draw.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, surface, id]);

  if (!auth.isSignedIn || !state) return null;

  async function toggle(next: boolean) {
    const before = state;
    setBusy(true);
    setError(null);
    // The box follows the click at once; a refusal puts it back and says why.
    setState((current) => (current ? { ...current, shared: next } : current));
    try {
      const saved = await setAnalysisShare(surface, id, next);
      setState(saved);
      onChange?.(saved);
      onState?.(saved);
      if (refreshOnChange) router.refresh();
    } catch (err) {
      setState(before);
      setError(t.failed(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  const analysed = state.versions.includes(ANALYSIS_VERSION);

  if (compact) {
    const row = t.row;
    // Nothing to share yet: a link to run it rather than a switch that shares nothing.
    const action =
      !analysed && !state.shared ? (
        surface === "hand" ? <a href={paths.analysisHand(id)}>{row.analyse}</a> : <span>{row.notAnalysed}</span>
      ) : undefined;
    return (
      <SettingRow
        icon="bars"
        label={row.label}
        checked={state.shared}
        status={busy ? t.saving : state.shared ? row.shared : row.private}
        busy={busy}
        onToggle={(next) => void toggle(next)}
        action={action}
        error={error}
        explain={
          action ? (
            <TipLine current>{row.notAnalysedText}</TipLine>
          ) : (
            <>
              <TipLine current={!state.shared}>
                <b>{row.off}</b> · {poll ? row.offTextPoll : row.offText}
              </TipLine>
              <TipLine current={state.shared}>
                <b>{row.on}</b> · {poll ? row.onTextPoll : row.onText}
              </TipLine>
            </>
          )
        }
      />
    );
  }

  return (
    <div className={`${styles.box} rail-fade${className ? ` ${className}` : ""}`}>
      <label className={styles.row}>
        <input
          type="checkbox"
          checked={state.shared}
          disabled={busy}
          aria-describedby={describedBy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>{t.label}</span>
      </label>
      <div id={describedBy} className="stack">
        <p className={styles.text}>{t.explain}</p>
        {poll ? <p className={styles.text}>{t.pollNote}</p> : null}
        {state.shared && !analysed ? <Dismissible className={styles.warn}>{t.notAnalysed}</Dismissible> : null}
      </div>
      <p className={styles.status} role="status">
        {busy ? t.saving : state.shared ? t.shared : t.private}
      </p>
      {error ? (
        <Dismissible className={styles.error} role="alert">
          {error}
        </Dismissible>
      ) : null}
    </div>
  );
}

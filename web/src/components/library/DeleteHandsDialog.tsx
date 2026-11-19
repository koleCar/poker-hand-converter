"use client";

/**
 * The confirmation before hands are deleted (owner, 2026-11-19: every delete
 * asks first, with the count). A selection asks once; every hand asks for
 * the word DELETE typed. A big delete shows its progress; the dialog stays
 * until it is done (closing a tab half way leaves a wipe for the server's
 * cron job to finish).
 */

import { Dialog } from "@rail/ui/dialog/Dialog";
import { useState, type FormEvent } from "react";
import type { DeleteProgress } from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import styles from "../account/account.module.css";
import rows from "../account/rows.module.css";

type State = { kind: "idle" } | { kind: "running"; progress: DeleteProgress | null } | { kind: "failed"; message: string };

export function DeleteHandsDialog({
  count,
  all = false,
  run,
  onClose,
  onDone,
}: {
  /** How many hands go (for "all": how many the library holds). */
  count: number;
  /** Every hand: the word must be typed. */
  all?: boolean;
  run: (onProgress: (progress: DeleteProgress) => void) => Promise<number>;
  onClose: () => void;
  onDone: (deleted: number) => void;
}) {
  const t = useDict().converter.library.delete;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [typed, setTyped] = useState("");
  const running = state.kind === "running";
  const armed = !all || typed.trim().toUpperCase() === t.allWord;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!armed || running) return;
    setState({ kind: "running", progress: null });
    try {
      const deleted = await run((progress) => setState({ kind: "running", progress }));
      onDone(deleted);
    } catch (error) {
      setState({ kind: "failed", message: t.failed(error instanceof Error ? error.message : String(error)) });
    }
  }

  const progress = state.kind === "running" ? state.progress : null;
  const share = progress && progress.total > 0 ? Math.min(1, progress.deleted / progress.total) : 0;

  return (
    <Dialog title={all ? t.allDialogTitle(count) : t.title(count)} onClose={() => (running ? undefined : onClose())}>
      <form className={rows.fields} onSubmit={(event) => void submit(event)}>
        <p className={rows.muted}>{all ? t.allBody : t.body(count)}</p>
        {all ? (
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={16}
            disabled={running}
            placeholder={t.allType}
            aria-label={t.allType}
          />
        ) : null}
        {running && (progress?.total ?? 0) > 1 ? (
          <div className={styles.progress}>
            <p className={rows.muted} role="status">
              {t.deleting(progress?.deleted ?? 0, progress?.total ?? count)}
            </p>
            <div
              className={styles.meter}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
            >
              <div className={styles.meterFill} style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
          </div>
        ) : null}
        {state.kind === "failed" ? (
          <p className={rows.error} role="alert">
            {state.message}
          </p>
        ) : null}
        <div className={rows.buttons}>
          {/* First: the dialog opens on it (showModal focuses the first control), so Enter does not delete. */}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} disabled={running}>
            {t.cancel}
          </button>
          <button type="submit" className={`btn btn--sm ${rows.dangerSolid}`} disabled={!armed || running}>
            {all ? t.allConfirm : t.button}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

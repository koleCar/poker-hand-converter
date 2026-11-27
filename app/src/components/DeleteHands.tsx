/**
 * Deleting hands (2026-11-19, the owner: one hand, a selection, or every
 * hand, always behind a confirmation): the dialog names how many go, says
 * once that the account's copy goes too and that nothing brings them back,
 * and shows a big delete's progress (`hands-delete-progress`). Every hand
 * ({@link DeleteAllHands}) asks for more: the number of hands, or DELETE,
 * typed. The store keeps the statistics exact and the sync worker deletes
 * the account's copy (`src-tauri/src/delete.rs`).
 */
import { Dialog } from "@rail/ui/dialog/Dialog";
import { useEffect, useId, useState } from "react";

import { useT } from "../i18n";
import { errorText, ipc, onHandsDeleteProgress } from "../lib/ipc";
import styles from "./DeleteHands.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

/** Confirm, then delete `handKeys`; `onDone` with how many went. */
export function DeleteHands({
  handKeys,
  onClose,
  onDone,
}: {
  handKeys: readonly string[];
  onClose: () => void;
  onDone: (deleted: number) => void;
}) {
  const t = useT().hands.actions.remove;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => (busy ? onHandsDeleteProgress(setProgress) : undefined), [busy]);

  const confirm = () => {
    setBusy(true);
    setError(null);
    ipc
      .handsDelete([...handKeys])
      .then(onDone)
      .catch((e: unknown) => {
        setError(t.failed(errorText(e)));
        setBusy(false);
        setProgress(null);
      });
  };

  return (
    <Dialog title={t.title(handKeys.length)} onClose={busy ? () => undefined : onClose}>
      <p className={styles.body}>{t.body}</p>
      {progress !== null ? (
        <p className={styles.progress} role="status">
          <progress max={progress.total} value={progress.done} />
          <span>{t.progress(progress.done, progress.total)}</span>
        </p>
      ) : null}
      {error !== null ? (
        <Dismissible className={styles.error} role="alert">
          {error}
        </Dismissible>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>
          {t.cancel}
        </button>
        <button type="button" className={styles.danger} disabled={busy} onClick={confirm}>
          {busy ? t.deleting : t.confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** Confirm with the count typed, then delete every hand; `onDone` with how many went. */
export function DeleteAllHands({ onClose, onDone }: { onClose: () => void; onDone: (deleted: number) => void }) {
  const dict = useT();
  const d = dict.settings.danger;
  const t = dict.hands.actions.remove;
  const inputId = useId();
  const [count, setCount] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    ipc
      .handsCount()
      .then((n) => {
        if (live) setCount(n);
      })
      .catch((e: unknown) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const answer = typed.trim();
  const confirmed =
    count !== null &&
    count > 0 &&
    (answer.toUpperCase() === "DELETE" || (answer.replace(/[^0-9]/g, "") === String(count) && /\d/.test(answer)));

  const confirm = () => {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    ipc
      .handsDeleteAll()
      .then(onDone)
      .catch((e: unknown) => {
        setError(t.failed(errorText(e)));
        setBusy(false);
      });
  };

  return (
    <Dialog title={d.deleteHandsTitle} onClose={busy ? () => undefined : onClose}>
      {count === null ? null : count === 0 ? (
        <p className={styles.body}>{d.deleteHandsNone}</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <p className={styles.body}>{d.deleteHandsBody(count)}</p>
          <label className={styles.label} htmlFor={inputId}>
            {d.deleteHandsType(count)}
          </label>
          <input
            id={inputId}
            className={styles.input}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}

          />
        </form>
      )}
      {error !== null ? (
        <Dismissible className={styles.error} role="alert">
          {error}
        </Dismissible>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>
          {t.cancel}
        </button>
        {count !== null && count > 0 ? (
          <button type="button" className={styles.danger} disabled={busy || !confirmed} onClick={confirm}>
            {busy ? t.deleting : d.deleteHandsConfirm}
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}

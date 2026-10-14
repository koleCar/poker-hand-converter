import { useEffect, useState } from "react";

import { useT } from "../i18n";
import { errorText, ipc, type RefusedHand } from "../lib/ipc";
import { Dialog } from "@rail/ui/dialog/Dialog";
import styles from "./RawTextDialog.module.css";

/**
 * A refused hand's raw text (R1.6): the chunk the core could not read, as
 * the room wrote it (line ends normalised), monospace and selectable, with
 * a button that copies it - for a bug report or a look at what went wrong.
 */
export function RawTextDialog({ hand, onClose }: { hand: RefusedHand; onClose: () => void }) {
  const t = useT();
  const d = t.refused;
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    ipc
      .quarantineRawText(hand.id)
      .then((raw) => {
        if (!live) {
          return;
        }
        if (raw === null) {
          setFailure(d.gone);
        } else {
          setText(raw);
        }
      })
      .catch((e: unknown) => live && setFailure(d.textFailed(errorText(e))));
    return () => {
      live = false;
    };
  }, [hand.id, d]);

  const copy = async () => {
    if (text === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog title={d.textHeading} onClose={onClose} wide>
      <dl className={styles.facts}>
        <dt>{d.reason}</dt>
        <dd>
          <code className={styles.code}>{hand.reason}</code> {hand.message}
        </dd>
        <dt>{d.file}</dt>
        <dd className={styles.mono}>{hand.file}</dd>
        <dt>{d.parser}</dt>
        <dd>{hand.detectedSite ? d.parserVersion(hand.detectedSite, hand.parserVersion) : d.noParser}</dd>
      </dl>
      {text === null && failure === null && <p className={styles.muted}>{d.textLoading}</p>}
      {failure !== null && <p className={styles.error}>{failure}</p>}
      {text !== null && (
        <pre className={styles.text} tabIndex={0} aria-label={d.textLabel}>
          {text}
        </pre>
      )}
      <div aria-live="polite" className={styles.live}>
        {copied === true && <p className={styles.success}>{d.copied}</p>}
        {copied === false && <p className={styles.error}>{d.copyFailed}</p>}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onClose}>
          {d.close}
        </button>
        <button type="button" className={styles.button} disabled={text === null} onClick={() => void copy()}>
          {d.copy}
        </button>
      </div>
    </Dialog>
  );
}

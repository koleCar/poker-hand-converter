/**
 * Debug builds only (see `ImportStatus.tsx`): pick a folder and watch it,
 * through the `dev_add_folder` command, which exists only in a debug Rust
 * build (`src-tauri/src/dev.rs`). The real ways in are the first-run
 * discovery (R1.4) and Settings, Folders (R1.5).
 */
import { useState } from "react";

import { useT } from "../i18n";
import { errorText, ipc } from "../lib/ipc";
import styles from "./ImportStatus.module.css";

export default function DevAddFolder({ onAdded }: { onAdded: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      if ((await ipc.dev.addFolder()) !== null) {
        onAdded();
      }
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.dev}>
      <button type="button" className={styles.button} disabled={busy} onClick={() => void add()}>
        {busy ? t.dev.adding : t.dev.addFolder}
      </button>
      <p className={styles.muted}>{t.dev.addFolderNote}</p>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

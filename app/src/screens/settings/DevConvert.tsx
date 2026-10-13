/**
 * Debug builds only (see `Settings.tsx`): pick a file, run `rail_core::convert`
 * on it through the `convert_file` command, show the counts. The commands
 * exist only in a debug Rust build (`src-tauri/src/dev.rs`).
 */
import { useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type ConvertSummary } from "../../lib/ipc";
import styles from "./Settings.module.css";

export default function DevConvert() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ConvertSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    try {
      const path = await ipc.dev.pickFile();
      if (!path) return;
      setBusy(true);
      setSummary(await ipc.dev.convertFile(path));
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const d = t.dev;
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{d.heading}</h2>
      <p className={styles.hint}>{d.note}</p>
      <button type="button" className={styles.button} disabled={busy} onClick={() => void run()}>
        {busy ? d.running : d.pick}
      </button>
      {error && <p className={styles.error}>{error}</p>}
      {summary && (
        <dl className={styles.facts}>
          <dt>{d.file}</dt>
          <dd className={styles.mono}>{summary.fileName}</dd>

          <dt>{d.encoding}</dt>
          <dd>{summary.encoding}</dd>

          <dt>{d.detected}</dt>
          <dd>{summary.detected ? d.detectedAs(summary.detected[0], summary.detected[1]) : d.nothing}</dd>

          <dt>{d.hands}</dt>
          <dd>{summary.hands}</dd>

          <dt>{d.refused}</dt>
          <dd>{summary.refused}</dd>

          <dt>{d.byParser}</dt>
          <dd>{summary.byParser.length ? summary.byParser.map(([p, n]) => `${p}: ${n}`).join(", ") : d.nothing}</dd>

          <dt>{d.firstRefusals}</dt>
          <dd className={styles.mono}>{summary.firstRefusals.length ? summary.firstRefusals.join(", ") : d.nothing}</dd>

          <dt>{d.time}</dt>
          <dd>{d.millis(summary.millis)}</dd>
        </dl>
      )}
      {summary?.problem && <p className={styles.error}>{d.problem(summary.problem)}</p>}
      {summary?.error && <p className={styles.error}>{d.error(summary.error)}</p>}
      {summary?.unrecognized && <p className={styles.hint}>{d.unrecognized}</p>}
    </section>
  );
}

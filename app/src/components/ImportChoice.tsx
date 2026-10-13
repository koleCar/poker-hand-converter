import { useId } from "react";

import { useT } from "../i18n";
import styles from "./ImportChoice.module.css";

/**
 * "Import everything" or "Only new hands" (guideline §3): what happens to the
 * hands already in a folder when it is added. The first-run screen and
 * Settings, Folders both ask it.
 */
export function ImportChoice({
  legend,
  onlyNew,
  onChange,
  disabled = false,
}: {
  legend: string;
  onlyNew: boolean;
  onChange: (onlyNew: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const name = useId();
  return (
    <fieldset className={styles.choices} disabled={disabled}>
      <legend>{legend}</legend>
      <label className={styles.choice}>
        <input type="radio" name={name} checked={!onlyNew} onChange={() => onChange(false)} />
        <span>
          {t.importChoice.importAll}
          <br />
          <span className={styles.hint}>{t.importChoice.importAllHint}</span>
        </span>
      </label>
      <label className={styles.choice}>
        <input type="radio" name={name} checked={onlyNew} onChange={() => onChange(true)} />
        <span>
          {t.importChoice.onlyNew}
          <br />
          <span className={styles.hint}>{t.importChoice.onlyNewHint}</span>
        </span>
      </label>
    </fieldset>
  );
}

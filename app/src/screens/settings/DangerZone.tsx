import { Icon } from "@rail/ui/icon/Icon";
import { useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc } from "../../lib/ipc";
import styles from "./Settings.module.css";

/**
 * Settings, Danger zone (R6.5): deleting the account - on the web, where the
 * user signs in and confirms (the app never deletes an account itself, and
 * the deletion never reaches this computer's data). Shown only when this
 * build has an account service.
 */
export function DangerZone() {
  const t = useT();
  const d = t.settings.danger;
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    ipc.accountOpenWebPage("delete-account").catch((e: unknown) => setError(d.openFailed(errorText(e))));
  };

  return (
    <section className={styles.group} aria-labelledby="settings-danger">
      <h2 id="settings-danger" className={`${styles.groupLabel} ${styles.dangerLabel}`}>
        {t.settings.sections.danger}
      </h2>
      <div className={styles.tile}>
        <span className={styles.dangerIcon}>
          <Icon name="trash" />
        </span>
        <span className={styles.strong}>{d.deleteAccount}</span>
        <span className={styles.actions}>
          <button type="button" className={`btn btn--sm ${styles.dangerButton}`} onClick={open}>
            {d.delete}
          </button>
        </span>
      </div>
      {error && <p className={`${styles.note} ${styles.error}`}>{error}</p>}
    </section>
  );
}

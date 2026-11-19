import { Icon } from "@rail/ui/icon/Icon";
import { useState } from "react";

import { DeleteAllHands } from "../../components/DeleteHands";
import { useT } from "../../i18n";
import { errorText, ipc } from "../../lib/ipc";
import styles from "./Settings.module.css";

/**
 * Settings, Danger zone: deleting every hand (2026-11-19: here and from
 * the account, behind a typed confirmation, `DeleteAllHands`), and (R6.5)
 * deleting the account - on the web, where the user signs in and confirms
 * (the app never deletes an account itself, and the deletion never reaches
 * this computer's data); that one only when this build has an account
 * service (`accountService`).
 */
export function DangerZone({ accountService }: { accountService: boolean }) {
  const t = useT();
  const d = t.settings.danger;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

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
        <span className={styles.strong}>{d.deleteHands}</span>
        <span className={styles.actions}>
          <button
            type="button"
            className={`btn btn--sm ${styles.dangerButton}`}
            onClick={() => {
              setNotice(null);
              setConfirming(true);
            }}
          >
            {d.delete}
          </button>
        </span>
      </div>
      {notice && (
        <p className={styles.note} role="status">
          {notice}
        </p>
      )}
      {accountService ? (
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
      ) : null}
      {error && <p className={`${styles.note} ${styles.error}`}>{error}</p>}
      {confirming ? (
        <DeleteAllHands
          onClose={() => setConfirming(false)}
          onDone={(deleted) => {
            setConfirming(false);
            setNotice(d.deleteHandsDone(deleted));
          }}
        />
      ) : null}
    </section>
  );
}

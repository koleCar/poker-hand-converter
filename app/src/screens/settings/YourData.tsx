import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type AppInfo, type WebPage } from "../../lib/ipc";
import styles from "./Settings.module.css";

/**
 * Settings, Account, Your data (R6.5): what this computer keeps and where,
 * how to remove it, and the account's export and deletion - on the web,
 * where the user signs in and confirms (the app never deletes an account
 * itself, and the deletion never reaches this computer's data).
 */
export function YourData() {
  const t = useT();
  const d = t.account.yourData;
  const [app, setApp] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc
      .appInfo()
      .then(setApp)
      .catch(() => setApp(null));
  }, []);

  const open = (page: WebPage) => {
    setError(null);
    ipc.accountOpenWebPage(page).catch((e: unknown) => setError(d.openFailed(errorText(e))));
  };

  return (
    <>
      <h3 id="settings-your-data" className={styles.subheading}>
        {d.heading}
      </h3>
      <p className={styles.muted}>{d.local}</p>
      {app && (
        <dl className={styles.facts}>
          <dt>{d.dataDir}</dt>
          <dd className={styles.mono}>{app.dataDir ?? t.settings.about.unknown}</dd>
          <dt>{d.settingsFile}</dt>
          <dd className={styles.mono}>{app.settingsFile}</dd>
          <dt>{d.logs}</dt>
          <dd className={styles.mono}>{app.logDir ?? t.settings.about.unknown}</dd>
        </dl>
      )}
      <p className={styles.muted}>{d.removeLocal}</p>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={() => open("your-data")}>
          {d.export}
        </button>
        <button type="button" className={styles.button} onClick={() => open("delete-account")}>
          {d.delete}
        </button>
      </div>
      <p className={styles.muted}>{d.deleteHint}</p>
      <button type="button" className={styles.linkButton} onClick={() => open("privacy")}>
        {d.privacy}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </>
  );
}

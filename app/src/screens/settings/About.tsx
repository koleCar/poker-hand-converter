import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type AppInfo, type CoreInfo } from "../../lib/ipc";
import styles from "./Settings.module.css";

/** Settings, About: what this build is, and the proof that it reaches the core. */
export function About() {
  const t = useT();
  const [core, setCore] = useState<CoreInfo | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([ipc.coreInfo(), ipc.appInfo()])
      .then(([coreInfo, appInfo]) => {
        setCore(coreInfo);
        setApp(appInfo);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  const a = t.settings.about;
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{a.heading}</h2>
      {error && <p className={styles.error}>{error}</p>}
      {!error && (!core || !app) && <p className={styles.muted}>{t.settings.loading}</p>}
      {core && app && (
        <dl className={styles.facts}>
          <dt>{a.version}</dt>
          <dd>{app.version}</dd>

          <dt>{a.core}</dt>
          <dd>
            {core.coreVersion}
            {" · "}
            <span title={core.parsers.join(", ")}>{a.parsers(core.parsers.length)}</span>
          </dd>

          <dt>{a.handFormat}</dt>
          <dd className={styles.mono}>{core.phfSchema}</dd>

          <dt>{a.sites}</dt>
          <dd>
            {core.sites !== null
              ? a.sitesCount(core.sites, core.configVersion)
              : a.configError(core.configError ?? a.unknown)}
          </dd>

          <dt>{a.logs}</dt>
          <dd className={styles.mono}>{app.logDir ?? a.unknown}</dd>

          <dt>{a.settingsFile}</dt>
          <dd className={styles.mono}>{app.settingsFile}</dd>
        </dl>
      )}
    </section>
  );
}

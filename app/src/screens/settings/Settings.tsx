import { lazy, Suspense } from "react";

import { ScreenHeader } from "../../components/ScreenHeader";
import { useT } from "../../i18n";
import { inApp } from "../../lib/ipc";
import { screenHref, SETUP } from "../../lib/router";
import { About } from "./About";
import { Preferences } from "./Preferences";
import styles from "./Settings.module.css";

// Debug builds only: in a production bundle `import.meta.env.DEV` is `false`
// and the import is dropped, so the panel is not shipped.
const DevConvert = import.meta.env.DEV ? lazy(() => import("./DevConvert")) : null;

export function Settings() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.settings.title} lead={t.screens.settings.lead} />
      {inApp ? (
        <div className={styles.sections}>
          {/* Settings, Folders proper is R1.5; until then, the first-run screen. */}
          <section className={styles.section}>
            <h2 className={styles.heading}>{t.settings.folders.heading}</h2>
            <p className={styles.hint}>{t.settings.folders.body}</p>
            <a className={styles.button} href={screenHref(SETUP)}>
              {t.settings.folders.open}
            </a>
          </section>
          <Preferences />
          <About />
          {DevConvert && (
            <Suspense fallback={null}>
              <DevConvert />
            </Suspense>
          )}
        </div>
      ) : (
        <p className={styles.muted}>{t.settings.unavailable}</p>
      )}
    </>
  );
}

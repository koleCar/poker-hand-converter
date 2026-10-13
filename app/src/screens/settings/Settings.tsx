import { lazy, Suspense } from "react";

import { ScreenHeader } from "../../components/ScreenHeader";
import { useT } from "../../i18n";
import { inApp } from "../../lib/ipc";
import { About } from "./About";
import { Folders } from "./Folders";
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
          <Folders />
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

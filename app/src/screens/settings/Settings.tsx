import { lazy, Suspense, useEffect, type ReactNode } from "react";

import { ScreenHeader } from "../../components/ScreenHeader";
import { useT } from "../../i18n";
import { inApp } from "../../lib/ipc";
import { useRouteParam } from "../../lib/router";
import { About } from "./About";
import { Account } from "./Account";
import { Folders } from "./Folders";
import { Preferences } from "./Preferences";
import { RefusedAll } from "./RefusedAll";
import styles from "./Settings.module.css";

// Debug builds only: in a production bundle `import.meta.env.DEV` is `false`
// and the import is dropped, so the panel is not shipped.
const DevConvert = import.meta.env.DEV ? lazy(() => import("./DevConvert")) : null;
// The statistics pass's controls (R2.3), until R2.7's screens.
const DevStats = import.meta.env.DEV ? lazy(() => import("./DevStats")) : null;

/** A section the command palette can open (`#/settings/<id>`, R2.8). */
function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={`section-${id}`} className={styles.anchor} tabIndex={-1}>
      {children}
    </div>
  );
}

export function Settings() {
  const t = useT();
  const section = useRouteParam();

  // Opened on a section (the palette's "Settings: Folders", "Refused
  // hands"): bring it into view and put focus there, so the keyboard
  // continues from it.
  useEffect(() => {
    if (section === null) return;
    const frame = window.requestAnimationFrame(() => {
      const node = document.getElementById(`section-${section}`);
      node?.scrollIntoView({ block: "start" });
      node?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [section]);

  return (
    <>
      <ScreenHeader title={t.screens.settings.title} lead={t.screens.settings.lead} />
      {inApp ? (
        <div className={styles.sections}>
          <Anchor id="account">
            <Account />
          </Anchor>
          <Anchor id="folders">
            <Folders />
          </Anchor>
          <Anchor id="refused">
            <RefusedAll />
          </Anchor>
          <Preferences />
          <Anchor id="about">
            <About />
          </Anchor>
          {DevStats && (
            <Suspense fallback={null}>
              <DevStats />
            </Suspense>
          )}
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

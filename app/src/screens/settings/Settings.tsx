import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import headerStyles from "../../components/ScreenHeader.module.css";
import { useT } from "../../i18n";
import { inApp, ipc } from "../../lib/ipc";
import { useRouteParam } from "../../lib/router";
import { useAccount } from "../../lib/useAccount";
import { Account } from "./Account";
import { CustomStats } from "./CustomStats";
import { DangerZone } from "./DangerZone";
import { Folders } from "./Folders";
import { Preferences } from "./Preferences";
import styles from "./Settings.module.css";
import { Updates } from "./Updates";

// Debug builds only: in a production bundle `import.meta.env.DEV` is `false`
// and the import is dropped, so the panel is not shipped.
const DevConvert = import.meta.env.DEV ? lazy(() => import("./DevConvert")) : null;
// The statistics pass's controls (R2.3), until R2.7's screens.
const DevStats = import.meta.env.DEV ? lazy(() => import("./DevStats")) : null;

/**
 * A group of settings under its small label, and a section the command
 * palette can open (`#/settings/<id>`, R2.8). Without a label, the group's
 * card says what it is (Your statistics).
 */
function Group({ id, label, children }: { id: string; label?: string; children: ReactNode }) {
  return (
    <section
      id={`section-${id}`}
      className={`${styles.group} ${styles.anchor}`}
      tabIndex={-1}
      aria-labelledby={label ? `settings-${id}` : undefined}
    >
      {label && (
        <h2 id={`settings-${id}`} className={styles.groupLabel}>
          {label}
        </h2>
      )}
      {children}
    </section>
  );
}

/** The app's version, small, under everything. */
function Version() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    ipc
      .appInfo()
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(null));
  }, []);
  return version ? <p className={styles.version}>{t.settings.version(version)}</p> : null;
}

/**
 * Settings, top to bottom: the account (plan, sync), the hand-history
 * folders, the user's own statistics, appearance and startup, updates, the
 * danger zone and the version. Each group is a small label over a card of
 * rows: the information on the left, the action on the right.
 */
export function Settings() {
  const t = useT();
  const g = t.settings.sections;
  const section = useRouteParam();
  const account = useAccount();
  const configured = account.account !== null && account.account.state !== "notConfigured";

  // Opened on a section (the palette's "Settings: Folders"): bring it into
  // view and put focus there, so the keyboard continues from it.
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
      {/* No header at all (2026-11-07): the first section starts the page; the heading stays for assistive technology. */}
      <h1 className={headerStyles.visuallyHidden}>{t.screens.settings.title}</h1>
      {inApp ? (
        <div className={styles.page}>
          <Group id="account" label={g.account}>
            <Account account={account} />
          </Group>
          <Group id="folders" label={g.folders}>
            <Folders />
          </Group>
          <Group id="statistics">
            <CustomStats />
          </Group>
          <Group id="appearance" label={g.appearance}>
            <Preferences />
          </Group>
          <Group id="updates" label={g.updates}>
            <Updates />
          </Group>
          {configured && <DangerZone />}
          <Version />
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

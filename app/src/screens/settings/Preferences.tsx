import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type Settings, type Theme } from "../../lib/ipc";
import { applyTheme } from "../../lib/theme";
import styles from "./Settings.module.css";

const THEMES: readonly Theme[] = ["system", "dark", "light"];

/** Appearance and startup: the settings `settings.rs` keeps. */
export function Preferences() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc
      .getSettings()
      .then(setSettings)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  const save = (change: Promise<Settings>) => {
    change
      .then((next) => {
        setSettings(next);
        setError(null);
        applyTheme(next.theme);
      })
      .catch((e: unknown) => setError(errorText(e)));
  };

  const themeLabel: Record<Theme, string> = {
    system: t.settings.appearance.system,
    dark: t.settings.appearance.dark,
    light: t.settings.appearance.light,
  };

  return (
    <>
      <section className={styles.section}>
        <h2 className={styles.heading}>{t.settings.appearance.heading}</h2>
        <div className={styles.row}>
          <span className={styles.label}>{t.settings.appearance.theme}</span>
          <div className={styles.segmented} role="group" aria-label={t.settings.appearance.theme}>
            {THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                className={styles.segment}
                aria-pressed={settings?.theme === theme}
                disabled={!settings}
                onClick={() => save(ipc.setTheme(theme))}
              >
                {themeLabel[theme]}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>{t.settings.startup.heading}</h2>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={settings?.startAtLogin ?? false}
            disabled={!settings}
            onChange={(event) => save(ipc.setStartAtLogin(event.target.checked))}
          />
          <span>
            <span className={styles.label}>{t.settings.startup.startAtLogin}</span>
            <br />
            <span className={styles.hint}>{t.settings.startup.startAtLoginHint}</span>
          </span>
        </label>
        {error && <p className={styles.error}>{t.settings.saveFailed(error)}</p>}
      </section>
    </>
  );
}

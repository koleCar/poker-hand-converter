import { useEffect, useId, useState } from "react";

import { useT } from "../../i18n";
import { LOCALES, type Locale } from "../../i18n/types";
import { adoptSettings } from "../../lib/appearance";
import { errorText, ipc, type Settings, type Theme } from "../../lib/ipc";
import styles from "./Settings.module.css";
import { Toggle } from "./Toggle";

const THEMES: readonly Theme[] = ["system", "dark", "light"];

/** One choice of several as a row: its name, then pressed buttons (the theme, the language). */
function Choice<T extends string>({
  label,
  values,
  current,
  names,
  disabled,
  onChoose,
  lang,
}: {
  label: string;
  values: readonly T[];
  current: T | undefined;
  names: Record<T, string>;
  disabled: boolean;
  onChoose: (value: T) => void;
  /** Each value's own language (a language's name is written in it). */
  lang?: (value: T) => string;
}) {
  return (
    <div className={`${styles.row} ${styles.rowWide}`}>
      <span>{label}</span>
      <div className={styles.segmented} role="group" aria-label={label}>
        {values.map((value) => (
          <button
            key={value}
            type="button"
            className={styles.segment}
            aria-pressed={current === value}
            disabled={disabled}
            lang={lang?.(value)}
            onClick={() => onChoose(value)}
          >
            {names[value]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Appearance and startup: the settings `settings.rs` keeps. The theme and
 * the language (R2.8) are saved first and painted when the save answered
 * (`lib/appearance.ts`), so the window never shows what the file does not
 * hold; the language also relabels the tray. (The density stays a setting,
 * and a palette command, without a row here.)
 */
export function Preferences() {
  const t = useT();
  const a = t.settings.appearance;
  const startupId = useId();
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
        adoptSettings(next);
      })
      .catch((e: unknown) => setError(errorText(e)));
  };

  const themeNames: Record<Theme, string> = { system: a.system, dark: a.dark, light: a.light };
  const languageNames: Record<Locale, string> = a.languages;

  return (
    <>
      <div className={styles.card}>
        <Choice
          label={a.theme}
          values={THEMES}
          current={settings?.theme}
          names={themeNames}
          disabled={!settings}
          onChoose={(theme) => save(ipc.setTheme(theme))}
        />
        <Choice
          label={a.language}
          values={LOCALES}
          current={settings?.locale}
          names={languageNames}
          disabled={!settings}
          lang={(locale) => locale}
          onChoose={(locale) => save(ipc.setLocale(locale))}
        />
      </div>
      <div id="section-startup" className={`${styles.card} ${styles.anchor}`} tabIndex={-1}>
        <div className={`${styles.row} ${styles.rowWide}`}>
          <label htmlFor={startupId}>{t.settings.startup.startAtLogin}</label>
          <Toggle
            id={startupId}
            checked={settings?.startAtLogin ?? false}
            disabled={!settings}
            onChange={(on) => save(ipc.setStartAtLogin(on))}
          />
        </div>
      </div>
      {error && (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {t.settings.saveFailed(error)}
        </p>
      )}
    </>
  );
}

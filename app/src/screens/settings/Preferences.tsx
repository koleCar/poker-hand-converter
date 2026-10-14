import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { LOCALES, type Locale } from "../../i18n/types";
import { adoptSettings } from "../../lib/appearance";
import { errorText, ipc, type Density, type Settings, type Theme } from "../../lib/ipc";
import styles from "./Settings.module.css";

const THEMES: readonly Theme[] = ["system", "dark", "light"];
const DENSITIES: readonly Density[] = ["comfortable", "compact"];

/** One choice of several, as pressed buttons (the theme, the density, the language). */
function Choice<T extends string>({
  label,
  hint,
  values,
  current,
  names,
  disabled,
  onChoose,
  lang,
}: {
  label: string;
  hint?: string;
  values: readonly T[];
  current: T | undefined;
  names: Record<T, string>;
  disabled: boolean;
  onChoose: (value: T) => void;
  /** Each value's own language (a language's name is written in it). */
  lang?: (value: T) => string;
}) {
  return (
    <div className={styles.row}>
      <span>
        <span className={styles.label}>{label}</span>
        {hint ? (
          <>
            <br />
            <span className={styles.hint}>{hint}</span>
          </>
        ) : null}
      </span>
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
 * Appearance and startup: the settings `settings.rs` keeps. The theme, the
 * density and the language (R2.8) are saved first and painted when the save
 * answered (`lib/appearance.ts`), so the window never shows what the file
 * does not hold; the language also relabels the tray.
 */
export function Preferences() {
  const t = useT();
  const a = t.settings.appearance;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<{ where: "appearance" | "startup"; reason: string } | null>(null);

  useEffect(() => {
    ipc
      .getSettings()
      .then(setSettings)
      .catch((e: unknown) => setError({ where: "appearance", reason: errorText(e) }));
  }, []);

  const save = (change: Promise<Settings>, where: "appearance" | "startup" = "appearance") => {
    change
      .then((next) => {
        setSettings(next);
        setError(null);
        adoptSettings(next);
      })
      .catch((e: unknown) => setError({ where, reason: errorText(e) }));
  };
  const errorIn = (where: "appearance" | "startup") =>
    error?.where === where ? (
      <p className={styles.error} role="alert">
        {t.settings.saveFailed(error.reason)}
      </p>
    ) : null;

  const themeNames: Record<Theme, string> = { system: a.system, dark: a.dark, light: a.light };
  const densityNames: Record<Density, string> = { comfortable: a.comfortable, compact: a.compact };
  const languageNames: Record<Locale, string> = a.languages;

  return (
    <>
      <section id="section-appearance" className={styles.section} tabIndex={-1}>
        <h2 className={styles.heading}>{a.heading}</h2>
        <Choice
          label={a.theme}
          values={THEMES}
          current={settings?.theme}
          names={themeNames}
          disabled={!settings}
          onChoose={(theme) => save(ipc.setTheme(theme))}
        />
        <Choice
          label={a.density}
          hint={a.densityHint}
          values={DENSITIES}
          current={settings?.density}
          names={densityNames}
          disabled={!settings}
          onChoose={(density) => save(ipc.setDensity(density))}
        />
        <Choice
          label={a.language}
          hint={a.languageHint}
          values={LOCALES}
          current={settings?.locale}
          names={languageNames}
          disabled={!settings}
          lang={(locale) => locale}
          onChoose={(locale) => save(ipc.setLocale(locale))}
        />
        {errorIn("appearance")}
      </section>

      <section id="section-startup" className={styles.section} tabIndex={-1}>
        <h2 className={styles.heading}>{t.settings.startup.heading}</h2>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={settings?.startAtLogin ?? false}
            disabled={!settings}
            onChange={(event) => save(ipc.setStartAtLogin(event.target.checked), "startup")}
          />
          <span>
            <span className={styles.label}>{t.settings.startup.startAtLogin}</span>
            <br />
            <span className={styles.hint}>{t.settings.startup.startAtLoginHint}</span>
          </span>
        </label>
        {errorIn("startup")}
      </section>
    </>
  );
}

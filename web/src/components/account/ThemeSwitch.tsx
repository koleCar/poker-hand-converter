"use client";

/**
 * System / Light / Dark: a segmented control on {@link setThemePreference}.
 * Drawn by the caller (the user menu, Settings) through `classNames`, like
 * `LanguageSwitch`.
 */

import { useDict } from "../../lib/i18n/client";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme";

const OPTIONS: readonly ThemePreference[] = ["system", "light", "dark"];

export function ThemeSwitch({
  classNames,
  asMenu = false,
}: {
  classNames: { group: string; option: string };
  /** Inside a `role="menu"` (the user menu): radio menu items, `aria-checked`. */
  asMenu?: boolean;
}) {
  const t = useDict().account.theme;
  const current = useThemePreference();
  return (
    <div className={classNames.group} role="group" aria-label={t.label}>
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={classNames.option}
          role={asMenu ? "menuitemradio" : undefined}
          aria-checked={asMenu ? option === current : undefined}
          aria-pressed={asMenu ? undefined : option === current}
          onClick={() => setThemePreference(option)}
        >
          {t[option]}
        </button>
      ))}
    </div>
  );
}

import { useT } from "../i18n";
import { SCREENS, screenHref, type Screen } from "../lib/router";
import { MOD_KEY, openPalette } from "./Palette";
import styles from "./Sidebar.module.css";

export function Sidebar({ current }: { current: Screen }) {
  const t = useT();
  return (
    <nav className={styles.sidebar} aria-label={t.nav.label}>
      <div className={styles.brand}>{t.brand.name}</div>
      {/* The command palette for the mouse (R2.8); Cmd/Ctrl + K from anywhere. */}
      <button
        type="button"
        className={styles.search}
        onClick={openPalette}
        aria-label={t.nav.searchLabel}
        title={t.nav.searchLabel}
        aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+K" : "Control+K"}
      >
        <span>{t.nav.search}</span>
        <kbd className={styles.kbd} aria-hidden="true">{`${MOD_KEY}${MOD_KEY === "⌘" ? "" : "+"}K`}</kbd>
      </button>
      <ul className={styles.list}>
        {SCREENS.map((screen) => (
          <li key={screen}>
            <a
              className={screen === current ? `${styles.link} ${styles.active}` : styles.link}
              href={screenHref(screen)}
              aria-current={screen === current ? "page" : undefined}
            >
              {t.nav[screen]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

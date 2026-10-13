import { useT } from "../i18n";
import { SCREENS, screenHref, type Screen } from "../lib/router";
import styles from "./Sidebar.module.css";

export function Sidebar({ current }: { current: Screen }) {
  const t = useT();
  return (
    <nav className={styles.sidebar} aria-label={t.nav.label}>
      <div className={styles.brand}>{t.brand.name}</div>
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

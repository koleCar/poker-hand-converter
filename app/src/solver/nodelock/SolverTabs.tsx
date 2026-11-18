import { Icon } from "@rail/ui/icon/Icon";

import { useT } from "../../i18n";
import { go } from "../../lib/router";
import styles from "./nodelock.module.css";

/**
 * The switch between the library (the clean solve) and My nodelocks, above
 * both: one joined pill like Cash | Tournaments, the active side filled. Each
 * side goes back to where it was left; a spinner while a lock is solving.
 */
export function SolverTabs({
  locks,
  libraryParam,
  locksParam,
  solving,
}: {
  locks: boolean;
  libraryParam: string | null;
  locksParam: string;
  solving: boolean;
}) {
  const t = useT().nodelock;
  return (
    <div className={styles.switch} role="tablist" aria-label={t.tabsLabel}>
      <button
        type="button"
        role="tab"
        aria-selected={!locks}
        className={styles.switchTab}
        title={t.libraryHint}
        onClick={() => {
          if (locks) go("solver", libraryParam);
        }}
      >
        {t.library}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={locks}
        className={styles.switchTab}
        title={t.mineHint}
        onClick={() => {
          if (!locks) go("solver", locksParam);
        }}
      >
        <Icon name="lock" />
        {t.mine}
        {solving ? <span className={styles.tabSpinner} aria-label={t.sidebarSolving} /> : null}
      </button>
    </div>
  );
}


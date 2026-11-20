import { useT } from "../../i18n";
import { go } from "../../lib/router";
import { LockGlyph, Segmented } from "../door";
import styles from "./nodelock.module.css";

/**
 * The switch between the library (the clean solve) and My nodelocks, at the
 * start of the library's top row in both (SV-A): the library's own joined
 * pill. Each side goes back to where it was left; a spinner while a lock is
 * solving.
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
    <Segmented
      tabs
      label={t.tabsLabel}
      value={locks ? "mine" : "library"}
      options={[
        { value: "library", label: t.library, title: t.libraryHint },
        {
          value: "mine",
          title: t.mineHint,
          label: (
            <>
              <LockGlyph />
              {t.mine}
              {solving ? <span className={styles.tabSpinner} role="img" aria-label={t.sidebarSolving} /> : null}
            </>
          ),
        },
      ]}
      onChange={(side) => go("solver", side === "mine" ? locksParam : libraryParam)}
    />
  );
}

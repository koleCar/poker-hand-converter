/**
 * Cash | Tournaments, under the search: the one kind of game every screen
 * shows (`lib/gameKind.ts`). A kind with no hands is greyed out unless it is
 * the one shown. Collapsed, one button with the kind's first letter flips it.
 */
import { GAME_KINDS, type GameKind } from "@rail/ui/hands/gameKind";
import { useUiStrings } from "@rail/ui/i18n";

import { setAppKind, useAppKind } from "../lib/gameKind";
import styles from "./Sidebar.module.css";

export function SidebarKind({ collapsed }: { collapsed: boolean }) {
  const ui = useUiStrings();
  const t = ui.hands.kinds;
  const { kind, counts } = useAppKind();
  const empty = (each: GameKind) => counts !== null && kind !== each && counts[each] === 0;
  const title = (each: GameKind) => (counts === null ? t[each] : `${t[each]} · ${ui.hands.count(counts[each])}`);

  if (collapsed) {
    const other: GameKind = kind === "tournament" ? "cash" : "tournament";
    const shown = kind ?? "cash";
    return (
      <button
        type="button"
        className={styles.kindFlip}
        aria-label={`${t.label}: ${t[shown]}`}
        title={`${title(shown)} → ${t[other]}`}
        disabled={kind === null || empty(other)}
        onClick={() => setAppKind(other)}
      >
        {t[shown].slice(0, 1)}
      </button>
    );
  }

  return (
    <div className={styles.kinds} role="group" aria-label={t.label}>
      {GAME_KINDS.map((each) => (
        <button
          key={each}
          type="button"
          aria-pressed={kind === each}
          disabled={empty(each)}
          title={title(each)}
          onClick={() => setAppKind(each)}
        >
          {t[each]}
        </button>
      ))}
    </div>
  );
}

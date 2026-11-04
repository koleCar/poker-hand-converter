/**
 * The Cash | Tournaments switch: one kind of game shown at a time, never both
 * (the owner's rule, 2026-11-04). The plain control under `KindToggle` (the
 * Hands and Reports filter's) and the screens that keep the kind themselves
 * (web Analysis, the app's Top leaks, Session review and Live). A kind with no
 * hands is greyed out unless it is the one shown.
 */
import { useUiStrings } from "../i18n";
import { GAME_KINDS, type GameKind } from "./gameKind";
import styles from "./KindToggle.module.css";

export function KindSwitch({
  kind,
  counts,
  onChange,
  className,
}: {
  /** The kind shown; null while it is being decided (nothing pressed). */
  kind: GameKind | null;
  /** Hands of each kind, when known (greys out an empty kind, titles each). */
  counts: Record<GameKind, number> | null;
  onChange: (kind: GameKind) => void;
  className?: string;
}) {
  const ui = useUiStrings();
  const t = ui.hands.kinds;
  return (
    <div className={className ?? styles.switch} role="group" aria-label={t.label}>
      {GAME_KINDS.map((each) => (
        <button
          key={each}
          type="button"
          className={`chip-btn${kind === each ? " is-active" : ""}`}
          aria-pressed={kind === each}
          disabled={counts !== null && kind !== each && counts[each] === 0}
          title={counts === null ? undefined : ui.hands.count(counts[each])}
          onClick={() => {
            if (kind !== each) onChange(each);
          }}
        >
          {t[each]}
        </button>
      ))}
    </div>
  );
}

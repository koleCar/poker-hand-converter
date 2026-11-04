/**
 * The Cash / Tournaments toggle over the Hands and Reports screens
 * (`gameKind.ts`): shown when the hands hold both kinds or one is chosen, it
 * switches the filter's formats to the other kind, keeping every other
 * choice. A kind with no hands under the other filters is greyed out.
 */
import { useUiStrings } from "../i18n";
import type { FilterState } from "./filter";
import { GAME_KINDS, hasBothKinds, kindCounts, kindOf, withKind } from "./gameKind";
import styles from "./KindToggle.module.css";
import type { HandFacets } from "./model";

export function KindToggle({
  filter,
  facets,
  onChange,
}: {
  /** The filter shown (already narrowed to one kind). */
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
}) {
  const ui = useUiStrings();
  const t = ui.hands.kinds;
  const counts = kindCounts(facets);
  const current = kindOf(filter.formats);
  if (facets === null || (!hasBothKinds(facets) && current === null)) return null;
  return (
    <div className={styles.toggle} role="group" aria-label={t.label}>
      {GAME_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className={`chip-btn${current === kind ? " is-active" : ""}`}
          aria-pressed={current === kind}
          disabled={current !== kind && counts[kind] === 0}
          title={ui.hands.count(counts[kind])}
          onClick={() => {
            if (current !== kind) onChange(withKind(filter, kind, facets));
          }}
        >
          {t[kind]}
        </button>
      ))}
    </div>
  );
}

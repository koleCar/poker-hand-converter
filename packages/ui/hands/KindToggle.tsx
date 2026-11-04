/**
 * The Cash / Tournaments toggle over the Hands and Reports screens
 * (`gameKind.ts`): shown when the hands hold both kinds or one is chosen, it
 * switches the filter's formats to the other kind, keeping every other
 * choice. A kind with no hands under the other filters is greyed out.
 */
import type { FilterState } from "./filter";
import { hasBothKinds, kindCounts, kindOf, withKind } from "./gameKind";
import { KindSwitch } from "./KindSwitch";
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
  const counts = kindCounts(facets);
  const current = kindOf(filter.formats);
  if (facets === null || (!hasBothKinds(facets) && current === null)) return null;
  return (
    <KindSwitch
      kind={current}
      counts={counts}
      className={styles.toggle}
      onChange={(kind) => onChange(withKind(filter, kind, facets))}
    />
  );
}

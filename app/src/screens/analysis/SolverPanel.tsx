/**
 * A hand's analysis beside the Solver: the right half of the split view,
 * showing the Solver library at the decision picked on the left
 * (`solver/spot.ts` says where that is). It is the Solver tab's browser, so
 * the spot can be walked from there - other actions, the turn and river
 * solved live - and "Open in Solver" carries the view to the tab.
 */
import { useCallback, useRef } from "react";

import { useT } from "../../i18n";
import { go } from "../../lib/router";
import { SolverHostProvider, SolverLibrary, type SolverView } from "../../solver/door";
import { useSolverHost } from "../../solver/host";
import { solverParam } from "../../solver/param";
import type { SolverSpot } from "../../solver/spot";
import styles from "./Analysis.module.css";

export function SolverPanel({ spot }: { spot: SolverSpot | null }) {
  const s = useT().analysis.hand.solver;
  const host = useSolverHost();
  const view = useRef<SolverView | null>(null);
  const onView = useCallback((next: SolverView) => {
    view.current = next;
  }, []);

  return (
    <aside className={styles.solverPanel} aria-label={s.label}>
      {spot ? (
        <>
          <div className={styles.solverHead}>
            {spot.fromFlop && <span className={styles.muted}>{s.fromFlop}</span>}
            <button type="button" className={styles.link} onClick={() => view.current && go("solver", solverParam(view.current))}>
              {s.open}
            </button>
          </div>
          <SolverHostProvider host={host}>
            {/* A new spot starts the browser over at it. */}
            <SolverLibrary
              key={spot.id}
              initialSet={spot.set}
              initialLine={spot.line}
              initialFlop={spot.flop}
              initialNode={spot.node}
              initialTurn={spot.turn}
              initialPath={spot.path}
              initialWalk={spot.walk}
              onView={onView}
            />
          </SolverHostProvider>
        </>
      ) : (
        <p className={styles.muted}>{s.none}</p>
      )}
    </aside>
  );
}

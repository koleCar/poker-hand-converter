/**
 * The Solver tab: the web's Solver library (`/solver`) in the app - the
 * preflop charts seat by seat, every library flop's strategy, and any turn
 * and river solved on the spot from the flop's ranges. The view lives in the
 * route (`#/solver/set=…&line=…&flop=…&node=…&turn=…`), so going back to the
 * tab lands where it was left. A screen that helps with play: hidden while a
 * poker table is open (A10, `duringPlay.ts`).
 */
import { useCallback, useState } from "react";

import { replaceParam, useRouteParam } from "../lib/router";
import { SolverHostProvider, SolverLibrary, type SolverView } from "../solver/door";
import { useSolverHost } from "../solver/host";
import { parseSolverParam, solverParam } from "../solver/param";

export function Solver() {
  const host = useSolverHost();
  const param = useRouteParam();
  // Read once: afterwards the library owns the view and only writes it back.
  const [initial] = useState(() => parseSolverParam(param));
  const onView = useCallback((view: SolverView) => replaceParam("solver", solverParam(view)), []);
  return (
    <SolverHostProvider host={host}>
      <SolverLibrary
        initialSet={initial.set}
        initialLine={initial.line}
        initialFlop={initial.flop}
        initialNode={initial.node}
        initialTurn={initial.turn}
        onView={onView}
      />
    </SolverHostProvider>
  );
}

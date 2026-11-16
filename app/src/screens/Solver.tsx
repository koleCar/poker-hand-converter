/**
 * The Solver tab: the web's Solver library (`/solver`) in the app - the
 * preflop charts seat by seat, every library flop's strategy, and any turn
 * and river solved on the spot from the flop's ranges. The view lives in the
 * route (`#/solver/set=…&line=…&flop=…&node=…&turn=…`), so going back to the
 * tab lands where it was left. A screen that helps with play: hidden while a
 * poker table is open (A10, `duringPlay.ts`).
 *
 * The app adds the nodelock (`solver/nodelock/`, `docs/NODELOCK.md` §5),
 * solved on this computer: the library's slot (the Nodelock action, the
 * banner, a locked solution in place of the library's), the editor, and My
 * nodelocks beside the library (`#/solver/locks`).
 */
import { useCallback, useMemo, useState } from "react";

import { replaceParam, useRouteParam } from "../lib/router";
import { SolverHostProvider, SolverLibrary, type SolverView } from "../solver/door";
import { useSolverHost } from "../solver/host";
import { Editor } from "../solver/nodelock/Editor";
import { History, LOCKS_PARAM, SolverTabs } from "../solver/nodelock/History";
import styles from "../solver/nodelock/nodelock.module.css";
import { useNodelockSession } from "../solver/nodelock/session";
import { useNodelockSlot } from "../solver/nodelock/slot";
import { parseSolverParam, solverParam } from "../solver/param";

/** The library's last view, for the switch back from My nodelocks. */
let lastView: string | null = null;

export function Solver() {
  const param = useRouteParam();
  const session = useNodelockSession();
  const base = useSolverHost();
  const locks = param === LOCKS_PARAM;
  return (
    <div className={styles.screen}>
      <SolverTabs locks={locks} libraryParam={lastView} />
      {/* Opening a nodelock mounts the library again on the view it names. */}
      {locks ? <History libraryParam={lastView} /> : <Library key={session.opened} />}
      {session.editor ? <Editor open={session.editor} solverT={base.t} /> : null}
    </div>
  );
}

function Library() {
  const base = useSolverHost();
  const nodelock = useNodelockSlot();
  const host = useMemo(() => ({ ...base, nodelock }), [base, nodelock]);
  const param = useRouteParam();
  // Read once: afterwards the library owns the view and only writes it back.
  const [initial] = useState(() => parseSolverParam(param));
  const onView = useCallback((view: SolverView) => {
    lastView = solverParam(view);
    replaceParam("solver", lastView);
  }, []);
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

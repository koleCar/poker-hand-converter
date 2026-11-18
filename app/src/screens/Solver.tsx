/**
 * The Solver tab: the web's Solver library (`/solver`) in the app - the
 * preflop charts seat by seat, every library flop's strategy, and any turn
 * and river solved on the spot from the flop's ranges. The view lives in the
 * route (`#/solver/set=…&line=…&flop=…&node=…&turn=…`), so going back to the
 * tab lands where it was left. A screen that helps with play: hidden while a
 * poker table is open (A10, `duringPlay.ts`).
 *
 * The app adds the nodelock (`solver/nodelock/`, `docs/NODELOCK.md` §5),
 * solved on this computer, under two tabs:
 *
 * - Library: always the clean solve, with the Nodelock action on a decision.
 * - My nodelocks: the tree of the user's locks on the left (§7.1), and beside
 *   it the open lock on its spot (`#/solver/lock=<id>&set=…`), or one quiet
 *   line when none is open (`#/solver/locks`).
 */
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useT } from "../i18n";
import { replaceParam, useRouteParam } from "../lib/router";
import { SolverHostProvider, SolverLibrary, type SolverView } from "../solver/door";
import { useSolverHost } from "../solver/host";
import { Editor } from "../solver/nodelock/Editor";
import styles from "../solver/nodelock/nodelock.module.css";
import {
  LOCKS_PARAM,
  lockIdOf,
  lockParam,
  openLock,
  useNodelockSession,
  viewParam,
  type ActiveLock,
} from "../solver/nodelock/session";
import { useNodelockSlot } from "../solver/nodelock/slot";
import { SolverTabs } from "../solver/nodelock/SolverTabs";
import { NodelockSplit } from "../solver/nodelock/tree/NodelockSplit";
import treeStyles from "../solver/nodelock/tree/tree.module.css";
import { parseSolverParam, solverParam } from "../solver/param";

/** The library's last view, for the switch back from My nodelocks. */
let lastView: string | null = null;
/** My nodelocks' last place (nothing open, or a lock open on its spot), for the switch back from the library. */
let lastLocks: string = LOCKS_PARAM;

export function Solver() {
  const t = useT().nodelock;
  const param = useRouteParam();
  const session = useNodelockSession();
  const base = useSolverHost();
  const lockId = lockIdOf(param);
  const locks = param === LOCKS_PARAM || lockId !== null;
  useEffect(() => {
    if (locks && param) lastLocks = param;
  }, [locks, param]);
  return (
    <div className={styles.screen}>
      <SolverTabs locks={locks} libraryParam={lastView} locksParam={lastLocks} solving={session.running !== null} />
      {locks ? (
        <NodelockSplit openId={lockId}>
          {lockId ? <OpenLock key={lockId} id={lockId} /> : <p className={treeStyles.pick}>{t.tree.pick}</p>}
        </NodelockSplit>
      ) : (
        <Library key={session.opened} lock={null} />
      )}
      {session.editor ? <Editor open={session.editor} solverT={base.t} /> : null}
    </div>
  );
}

/** My nodelocks on one lock: read from the store when the route names one not open yet (the app reopened on it). */
function OpenLock({ id }: { id: string }) {
  const t = useT().nodelock;
  const session = useNodelockSession();
  const active = session.active?.row.id === id ? session.active : null;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (active || asked.current === id) return;
    asked.current = id;
    void openLock(id, { navigate: false }).then((ok) => {
      if (!ok) replaceParam("solver", LOCKS_PARAM);
    });
  }, [id, active]);
  if (!active) return <RailLoader label={t.opening} centered />;
  return <Library key={session.opened} lock={active} />;
}

function Library({ lock }: { lock: ActiveLock | null }) {
  const base = useSolverHost();
  const param = useRouteParam();
  // Read once: afterwards the library owns the view and only writes it back.
  const [initial] = useState(() => parseSolverParam(param));
  const shown = useRef(lock ? viewParam(lock.summary) : (lastView ?? ""));
  const view = useCallback(() => shown.current, []);
  const nodelock = useNodelockSlot(lock, view);
  const host = useMemo(() => ({ ...base, nodelock }), [base, nodelock]);
  const lockId = lock?.row.id ?? null;
  const onView = useCallback(
    (next: SolverView) => {
      shown.current = solverParam(next);
      if (lockId) {
        replaceParam("solver", lockParam(lockId, shown.current));
      } else {
        lastView = shown.current;
        replaceParam("solver", lastView);
      }
    },
    [lockId],
  );
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

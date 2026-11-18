/**
 * The app's side of the Solver library's nodelock slot (`SolverHost.nodelock`,
 * `docs/NODELOCK.md` §5.1, §7.2–7.4), in two modes:
 *
 * - the Library tab: the clean solve. Only the Nodelock action on a
 *   decision's card; no locked chunk, no marks, whatever lock is open.
 * - My nodelocks on one lock: the locked chunk in place of the library's, a
 *   lock icon on every locked action (`LockMark`, its popover says how it is
 *   locked), the Compare with GTO toggle at the end of the view's tabs, and
 *   the Nodelock action on every decision (a lock on the lock, §7.4). No
 *   banner: which lock is open is the tree's selected row.
 *
 * A solve's progress shows in My nodelocks (`SolveProgress`) and the sidebar.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { useEffect, useMemo, useState } from "react";

import { useLocale, useT, type Dict } from "../../i18n";
import {
  actionColours,
  classOfCombo,
  exploreHistory,
  exploreNode,
  liveTurnCached,
  nodelockSuggestEn,
  nodelockSuggestHr,
  rangesAt,
  type Archetype,
  type FlopChunk,
  type NodelockAt,
  type NodelockMark,
  type NodelockNode,
  type SolverDict,
  type SolverNodelock,
} from "../door";
import { useSolverHost } from "../host";
import type { LockSet } from "./contract";
import { nodelockData, onNodelocksChanged, type NodeLockRow } from "./data";
import { closeLockPopover, LockMark, type LockPopoverData } from "./LockMark";
import { markIndex, markPath, nodeMark, type MarkedNode, type NodeMark } from "./marks";
import styles from "./nodelock.module.css";
import {
  arrivedAt,
  boardText,
  cancelSolve,
  editLock,
  openEditor,
  openLock,
  parseRow,
  setCompare,
  useNodelockSession,
  type ActiveLock,
  type RunningSolve,
} from "./session";

type NodelockDict = Dict["nodelock"];

export function useNodelockSlot(lock: ActiveLock | null, view: () => string): SolverNodelock {
  void view;
  const session = useNodelockSession();
  const t = useT().nodelock;
  const solverT = useSolverHost().t;
  const names = (useLocale() === "hr" ? nodelockSuggestHr : nodelockSuggestEn).names;
  const ancestors = useAncestors(lock?.row ?? null);
  const compare = lock ? session.compare : false;
  const marks = useMemo(
    () => (lock ? lockMarks(lock, ancestors, { solver: solverT, t, preset: (id) => names[id as Archetype] ?? id }) : null),
    [lock, ancestors, solverT, t, names],
  );
  return useMemo<SolverNodelock>(
    () => ({
      override: lock?.override ?? null,
      compare,
      compareLabel: t.gto,
      shareDelta: t.shareDelta,
      nodeAction: (at) => (lock ? null : <NodeAction at={at} />),
      banner: (at) => <PendingEdit at={at} />,
      tabTools: (at) => (lock && at?.locked ? <CompareToggle on={compare} /> : null),
      lockMark: marks ?? undefined,
    }),
    [lock, compare, marks, t],
  );
}

function NodeAction({ at }: { at: NodelockAt }) {
  const t = useT().nodelock;
  const position = at.chunk.header.players[at.chunk.result.nodes[at.node].player];
  return (
    <button type="button" className={`btn btn--sm ${styles.nodeAction}`} title={t.actionTitle(position)} onClick={() => openEditor(at)}>
      <Icon name="lock" />
      {t.action}
    </button>
  );
}

/** Compare with GTO: a quiet toggle at the right end of the view's tabs (§7.2). */
function CompareToggle({ on }: { on: boolean }) {
  const t = useT().nodelock;
  return (
    <button type="button" className={styles.compareToggle} aria-pressed={on} onClick={() => setCompare(!on)}>
      <span className={styles.compareSwitch} aria-hidden="true" />
      {t.compare}
    </button>
  );
}

/** Above the view: nothing shown, but a saved lock being edited opens the editor once its decision is on screen. */
function PendingEdit({ at }: { at: NodelockAt | null }) {
  const pending = useNodelockSession().pendingEdit;
  useEffect(() => {
    if (at && pending) arrivedAt(at);
  }, [at, pending]);
  // A popover open on a decision closes when the view moves on.
  const where = at ? `${at.set}/${at.line}/${at.flop}/${at.node}/${at.turn?.card ?? ""}` : "";
  useEffect(() => closeLockPopover, [where]);
  return null;
}

/** A solve running on this computer: a quiet line with its progress and Cancel. */
export function SolveProgress({ running }: { running: RunningSolve }) {
  const t = useT().nodelock;
  return (
    <div className={styles.progress} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <div className={styles.progressText}>
        <strong>{running.name}</strong>
        <span>{running.progress ? t.progress(running.share, running.progress.etaMs === null ? null : running.progress.etaMs / 1000) : t.starting}</span>
        <span className={styles.muted}>{t.solvingHere}</span>
      </div>
      <button type="button" className="btn btn--sm" onClick={cancelSolve}>
        {t.cancel}
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- lock marks - */

export interface Ancestor {
  id: string;
  name: string;
  set: LockSet;
  preset: string | null;
}

/** The lock a row is built on (§7.5 `parent_id`), or null: on the library. */
export function parentOf(row: NodeLockRow): string | null {
  return (row as NodeLockRow & { parent_id?: string | null }).parent_id ?? null;
}

const NONE: Ancestor[] = [];

/** The open lock's chain to its root, nearest first; read again when a lock changes here. */
function useAncestors(row: NodeLockRow | null): Ancestor[] {
  const [chain, setChain] = useState<{ id: string; list: Ancestor[] }>({ id: "", list: NONE });
  const id = row?.id ?? "";
  const parent = row ? parentOf(row) : null;
  useEffect(() => {
    if (!parent) return;
    let live = true;
    const read = () =>
      void nodelockData
        .list()
        .then((rows) => {
          const byId = new Map(rows.map((x) => [x.id, x]));
          const list: Ancestor[] = [];
          const seen = new Set<string>();
          for (let at = byId.get(parent); at && !seen.has(at.id); at = byId.get(parentOf(at) ?? "")) {
            seen.add(at.id);
            const parsed = parseRow(at);
            if (parsed) list.push({ id: at.id, name: at.name, set: parsed.lockSet, preset: at.preset });
          }
          if (live) setChain({ id, list });
        })
        .catch(() => undefined);
    read();
    const stop = onNodelocksChanged(read);
    return () => {
      live = false;
      stop();
    };
  }, [id, parent]);
  return parent && chain.id === id ? chain.list : NONE;
}

/** On a turn chunk: a river decision once a deal lies between it and the root. */
function streetOf(node: NodelockNode): "flop" | "turn" | "river" {
  if (!node.turn) return "flop";
  const nodes = node.chunk.result.nodes;
  for (let i = node.node; nodes[i].parent >= 0; i = nodes[i].parent) {
    if (nodes[nodes[i].parent].kind === "chance") return "river";
  }
  return "turn";
}

function strategyRows(chunk: FlopChunk, index: number): Float32Array[] {
  const node = chunk.result.nodes[index];
  const n = chunk.result.hands[node.player].length;
  return Array.from({ length: node.actions.length }, (_, a) => node.strategy.subarray(a * n, (a + 1) * n));
}

/**
 * GTO at a decision, [action][hand] in the shown chunk's hand order: the
 * library's flop, or the library's live turn when it was solved this session.
 * Null when it is not at hand (or the lock is built on another's result).
 */
function gtoAt(node: NodelockNode, key: string, based: boolean): Float32Array[] | null {
  if (based) return null;
  const shown = node.chunk.result.nodes[node.node];
  const base = node.turn ? liveTurnCached(key, node.turn.chance, node.turn.card) : node.library;
  if (!base) return null;
  if (base === node.chunk) return strategyRows(base, node.node);
  const index = base.result.nodes.findIndex((n) => n.kind === "action" && n.path === shown.path);
  if (index < 0) return null;
  const player = shown.player as 0 | 1;
  const hands = base.result.hands[player];
  const own = node.chunk.result.hands[player];
  if (hands.length !== own.length || hands.some((h, i) => h !== own[i])) return null;
  return strategyRows(base, index);
}

function sameActions(labels: readonly string[], actions: ReadonlyArray<{ label: string }>): boolean {
  return labels.length === actions.length && labels.every((label, a) => label === actions[a].label);
}

interface Marked {
  marked: MarkedNode;
  mark: NodeMark;
  hasGto: boolean;
}

/** The slot's `lockMark` for an open lock: the decisions it (or an ancestor) locks, each with its icon and popover. */
function lockMarks(
  lock: ActiveLock,
  ancestors: Ancestor[],
  words: { solver: SolverDict; t: NodelockDict; preset: (id: string) => string },
): (node: NodelockNode) => NodelockMark | null {
  const { solver: solverT, t } = words;
  const index = markIndex(lock.lockSet, ancestors);
  const presets = new Map(ancestors.map((x) => [x.id, x.preset]));
  const based = Boolean((lock.lockSet as LockSet & { base?: unknown }).base);
  /** Per chunk and decision: its mark's numbers, worked out once. */
  const cache = new WeakMap<FlopChunk, Map<number, Marked | null>>();

  const read = (node: NodelockNode): Marked | null => {
    let byNode = cache.get(node.chunk);
    if (!byNode) {
      byNode = new Map();
      cache.set(node.chunk, byNode);
    }
    const known = byNode.get(node.node);
    if (known !== undefined) return known;
    const shown = node.chunk.result.nodes[node.node];
    const turn = node.turn ? { dealPath: node.library.result.nodes[node.turn.chance]?.path ?? "", card: node.turn.card } : null;
    const marked = shown?.kind === "action" ? index.get(markPath(shown.path, turn)) : undefined;
    let value: Marked | null = null;
    if (marked && marked.spec.player === shown.player && sameActions(marked.spec.actions, exploreNode(node.chunk, node.node).actions)) {
      const player = shown.player as 0 | 1;
      const hands = node.chunk.result.hands[player];
      // A lock built on another's result is GTO only against that base, which is not at hand here.
      const gto = gtoAt(node, lock.override.key, marked.from === null && based);
      const mark = nodeMark(marked.spec, {
        hands,
        reach: rangesAt(node.chunk.result, node.node)[player],
        cell: Uint8Array.from(hands, (combo) => classOfCombo(combo)),
        gto,
        rest: gto ?? strategyRows(node.chunk, node.node),
      });
      value = { marked, mark, hasGto: gto !== null };
    }
    byNode.set(node.node, value);
    return value;
  };

  const popover = (node: NodelockNode, { marked, mark, hasGto }: Marked): LockPopoverData => {
    const view = exploreNode(node.chunk, node.node);
    const history = exploreHistory(node.chunk, node.node);
    const river = node.turn ? (history.find((s) => s.card)?.card ?? null) : null;
    const board = [...node.chunk.result.board, ...(river ? [river] : [])].map((card) => node.picked.toPicked(card));
    const lastDeal = history.map((s) => Boolean(s.card)).lastIndexOf(true);
    const before = history.slice(lastDeal + 1).at(-1) ?? null;
    const parts = [view.position, solverT.panel.streetName(streetOf(node)), boardText(board)];
    if (before) parts.push(t.markAfter(solverT.panel.step(before.position, solverT.action(before.action.kind, before.action.sizePot, before.action.amount))));
    const colours = actionColours(view.actions);
    // The row's summary has GTO's shares at the decision it was made at.
    const primary = marked.from === null && marked.spec.path === lock.row.node_path;
    const preset = marked.from ? (presets.get(marked.from.id) ?? null) : primary ? lock.row.preset : null;
    const summaryGto = !hasGto && primary && lock.summary.shifts.length === view.actions.length ? lock.summary.shifts.map((s) => s.gto) : null;
    return {
      title: parts.join(" · "),
      actions: view.actions.map((a, k) => ({ label: a.label, name: solverT.action(a.kind, a.sizePot, a.amount), colour: colours[k] })),
      mark,
      gto: summaryGto,
      preset: preset ? words.preset(preset) : null,
      from: marked.from,
      only: marked.from !== null || lock.lockSet.nodes.length <= 1,
    };
  };

  return (node) => {
    const value = read(node);
    if (!value) return null;
    const { marked, mark } = value;
    const id = `${lock.row.id}|${marked.spec.path}`;
    return {
      actions: new Set(marked.spec.actions.filter((_, a) => mark.locked[a])),
      render: (action) => (
        <LockMark
          key={`lock-${action ?? ""}`}
          id={id}
          action={action}
          data={() => popover(node, value)}
          onEdit={() => editLock(lock.row, null)}
          onRemove={() => undefined}
          onOpenFrom={(from) => void openLock(from)}
        />
      ),
    };
  };
}

/**
 * The app's side of the Solver library's nodelock slot (`SolverHost.nodelock`,
 * `docs/NODELOCK.md` §5.1, §7.2–7.4), in two modes:
 *
 * - the Library tab: the clean solve. Only the `Lock BB` action at the
 *   toolbar's right end; no locked chunk, no marks, whatever lock is open.
 * - My nodelocks on one lock: the locked chunk in place of the library's, a
 *   lock icon on every locked action (`LockMark`, its popover says how it is
 *   locked), the Compare with GTO switch at the toolbar's end, and the
 *   `Lock BB` action on every decision (a lock on the lock, §7.4, planned by
 *   `lineage.ts`; Edit lock and Remove this lock make siblings). No banner:
 *   which lock is open is the tree's selected row.
 *
 * The slot's controls are the library's own (`ToolButton`, `Switch`), so they
 * read as part of its toolbar ("Studio", SV-A). A solve's progress shows in
 * the tree's row and the sidebar.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { useEffect, useMemo } from "react";

import { useLocale, useT, type Dict } from "../../i18n";
import {
  actionColours,
  classOfCombo,
  exploreHistory,
  exploreNode,
  liveTurnCached,
  liveTurnId,
  LockGlyph,
  nodelockSuggestEn,
  nodelockSuggestHr,
  rangesAt,
  Switch,
  ToolButton,
  type Archetype,
  type FlopChunk,
  type NodelockAt,
  type NodelockMark,
  type NodelockNode,
  type SolverDict,
  type SolverNodelock,
} from "../door";
import { go } from "../../lib/router";
import { useEntitlements } from "../../lib/useEntitlements";
import { useSolverHost } from "../host";
import type { NodelockSummary } from "./contract";
import { nodelockData } from "./data";
import { closeLockPopover, LockMark, type LockPopoverData } from "./LockMark";
import { markIndex, markPath, nodeMark, type MarkedNode, type NodeMark } from "./marks";
import { lockOwner, planRemoveLock, siblingName } from "./lineage";
import {
  arrivedAt,
  boardText,
  editInLock,
  LOCKS_PARAM,
  openEditor,
  openLock,
  parseRow,
  setCompare,
  startSolve,
  useNodelockSession,
  type ActiveLock,
} from "./session";
import { lockPath } from "./spot";

type NodelockDict = Dict["nodelock"];

export function useNodelockSlot(lock: ActiveLock | null, view: () => string): SolverNodelock {
  void view;
  const session = useNodelockSession();
  const t = useT().nodelock;
  const solverT = useSolverHost().t;
  const names = (useLocale() === "hr" ? nodelockSuggestHr : nodelockSuggestEn).names;
  const compare = lock ? session.compare : false;
  // (Free tier) Nodelock is Pro: on a plan without it the action is a locked button.
  const plan = useEntitlements();
  const locked = plan.status !== null && plan.locked("nodelock");
  const upgrade = plan.upgrade;
  const marks = useMemo(
    () => (lock ? lockMarks(lock, { solver: solverT, t, preset: (id) => names[id as Archetype] ?? id }) : null),
    [lock, solverT, t, names],
  );
  return useMemo<SolverNodelock>(
    () => ({
      override: lock?.override ?? null,
      compare,
      compareLabel: t.gto,
      shareDelta: t.shareDelta,
      // Inside a lock every decision can be locked too: a lock on the lock (§7.4).
      nodeAction: (at) => (locked ? <LockedNodeAction onUpgrade={upgrade} /> : <NodeAction at={at} lock={lock} />),
      banner: (at) => <PendingEdit at={at} />,
      tabTools: (at) => (lock && at?.locked ? <CompareToggle on={compare} /> : null),
      lockMark: marks ?? undefined,
    }),
    [lock, compare, marks, t, locked, upgrade],
  );
}

/** Nodelock on a plan without it: the action with its lock, "Nodelock is part of Pro. See Pro" on hover; a click opens the pricing page. */
export function LockedNodeAction({ onUpgrade }: { onUpgrade: () => void }) {
  const p = useT().plan;
  return (
    <ToolButton tone="lock" title={`${p.tip(p.solver.nodelock)} ${p.upgrade}`} onClick={onUpgrade}>
      <Icon name="lock" />
      {p.solver.nodelock}
    </ToolButton>
  );
}

function NodeAction({ at, lock }: { at: NodelockAt; lock: ActiveLock | null }) {
  const t = useT().nodelock;
  const position = at.chunk.header.players[at.chunk.result.nodes[at.node].player];
  const open = () => {
    if (!lock) return openEditor(at);
    const within = { open: { row: lock.row, set: lock.lockSet }, ancestors: lock.ancestors, edit: false };
    // A decision already locked in the chain opens on its lock (re-locking it replaces it).
    const owner = lockOwner(within.open, within.ancestors, lockPath(at));
    openEditor(at, owner ? { lockSet: owner.set, preset: null, name: null } : null, within);
  };
  return (
    <ToolButton tone="lock" title={t.actionTitle(position)} onClick={open}>
      <LockGlyph />
      {t.lockActor(position)}
    </ToolButton>
  );
}

/** Compare with GTO (§7.2): the library's switch at the toolbar's end. */
function CompareToggle({ on }: { on: boolean }) {
  const t = useT().nodelock;
  return (
    <Switch on={on} onChange={setCompare}>
      {t.compare}
    </Switch>
  );
}

/** Above the view: nothing shown, but a saved lock being edited opens the editor once its decision is on screen. */
function PendingEdit({ at }: { at: NodelockAt | null }) {
  const pending = useNodelockSession().pendingEdit;
  useEffect(() => {
    shownAt = at;
  }, [at]);
  useEffect(() => {
    if (at && pending) arrivedAt(at);
  }, [at, pending]);
  // A popover open on a decision closes when the view moves on.
  const where = at ? `${at.set}/${at.line}/${at.flop}/${at.node}/${at.turn?.card ?? ""}` : "";
  useEffect(() => closeLockPopover, [where]);
  return null;
}

/* ----------------------------------------------------------- lock marks - */

/** The decision on screen, for Edit lock and Remove this lock in a lock popover. */
let shownAt: NodelockAt | null = null;

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
  // A lock with its own sizes offers other actions here: GTO never played them.
  if (index < 0 || base.result.nodes[index].labels.join(" ") !== shown.labels.join(" ")) return null;
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
  words: { solver: SolverDict; t: NodelockDict; preset: (id: string) => string },
): (node: NodelockNode) => NodelockMark | null {
  const { solver: solverT, t } = words;
  const open = { row: lock.row, set: lock.lockSet };
  const index = markIndex(
    lock.lockSet,
    lock.ancestors.map((x) => ({ id: x.row.id, name: x.row.name, set: x.set })),
  );
  const presets = new Map(lock.ancestors.map((x) => [x.row.id, x.row.preset]));
  const based = Boolean(lock.lockSet.base);
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
      only: planRemoveLock(open, lock.ancestors, marked.spec.path) === null,
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
          onEdit={() => editAt(lock, node, marked)}
          onRemove={() => void removeAt(lock, marked, t)}
          onOpenFrom={(from) => void openLock(from)}
        />
      ),
    };
  };
}

/** The view of a decision on the action strip, to go to it. */
function viewOf(lock: ActiveLock, node: NodelockNode): NodelockSummary["view"] {
  const { set, line, flop } = lock.summary.view;
  return { set, line, flop, node: node.node, ...(node.turn ? { turn: liveTurnId(node.turn.chance, node.turn.card) } : {}) };
}

/**
 * Edit lock (§7.3): the editor on this decision with its lock loaded; the
 * solve is a sibling of the lock that owns it. A decision not on screen is
 * gone to first.
 */
function editAt(lock: ActiveLock, node: NodelockNode, marked: MarkedNode): void {
  const within = { open: { row: lock.row, set: lock.lockSet }, ancestors: lock.ancestors, edit: true };
  const owner = lockOwner(within.open, within.ancestors, marked.spec.path);
  const from = { lockSet: owner?.set ?? lock.lockSet, preset: owner?.row.preset ?? null, name: null };
  const at = shownAt;
  if (at && at.chunk === node.chunk && at.node === node.node) openEditor(at, from, within);
  else editInLock(lock.row.id, viewOf(lock, node), from, within);
}

/** Remove this lock (§7.3): the owner's lock without this decision, solved as its sibling `<name> (2)`. */
async function removeAt(lock: ActiveLock, marked: MarkedNode, t: NodelockDict): Promise<void> {
  const at = shownAt;
  const open = { row: lock.row, set: lock.lockSet };
  const plan = planRemoveLock(open, lock.ancestors, marked.spec.path);
  const owner = lockOwner(open, lock.ancestors, marked.spec.path);
  const parsed = owner ? parseRow(owner.row) : null;
  if (!at || !plan || !owner || !parsed) return;
  const names = await nodelockData.list().then((rows) => rows.map((row) => row.name), () => []);
  const started = await startSolve({
    at,
    lockSet: plan.set,
    name: siblingName(owner.row.name, names),
    preset: owner.row.preset,
    summary: parsed.summary,
    plan,
  });
  if (started === true || started === "queued") go("solver", LOCKS_PARAM);
  else window.alert(started === "noEngine" ? t.noEngine : t.startError);
}

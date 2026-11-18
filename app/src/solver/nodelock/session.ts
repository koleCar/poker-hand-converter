/**
 * The nodelock's state for the window's life, outside any screen: the
 * editor being open, the one solve running (it goes on while the user browses
 * or leaves the Solver tab), the finished solve's notice, the locked solution
 * shown in the library, and compare on or off. A small external store, read
 * with `useNodelockSession()`.
 *
 * ```
 * Solve on this computer ─▶ a row saved `solving` at once ─▶ the engine, progress here
 *   ─▶ `solved` with the chunk and the stats (or `failed` / `cancelled`) ─▶ the sidebar's notice ─▶ Open
 * Open (notice, history) ─▶ the row's chunk ─▶ My nodelocks on its spot (`#/solver/lock=<id>&…`)
 * ```
 *
 * **Locks on locks** (§7.4): a solve asked for inside an open lock carries
 * its plan (`lineage.ts`'s `planChildLock`): the new row is the parent's
 * child, and a based set is solved on its base row's stored chunk, not the
 * library's.
 *
 * The library tab is always the clean solve: a locked solution shows only in
 * My nodelocks, never on the library's own view.
 */
import { useSyncExternalStore } from "react";

import { ipc } from "../../lib/ipc";
import { go } from "../../lib/router";
import { decodeChunk, liveTurnId, type NodelockAt, type NodelockOverride } from "../door";
import { solverParam } from "../param";
import { lockHashOf, type LockSet, type NodelockEngine, type NodelockProgress, type NodelockSummary } from "./contract";
import { nodelockData, type NodeLockInput, type NodeLockRow } from "./data";
import { pickEngine } from "./engine";
import { lockChain, type LockPlan, type LockRef } from "./lineage";

export interface RunningSolve {
  id: string;
  name: string;
  /** `set/line/flop` of the chunk, and the live turn's id on a turn lock: where the banner shows progress. */
  key: string;
  startedAt: number;
  /** The locked board in cards (`Q♠6♥3♦`, and the turn on a turn lock). */
  board: string;
  progress: NodelockProgress | null;
  /** How far the solve is, 0–1 (elapsed over elapsed + ETA); never goes back. Null until the engine has an ETA. */
  share: number | null;
}

/** The solves started since the queue was last empty: the sidebar's "1 of 3 done". */
export interface SolveBatch {
  done: number;
  total: number;
}

const SUIT_SIGN: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** Cards as text with suit signs: `Q♠6♥3♦`. */
export function boardText(cards: readonly string[]): string {
  return cards.map((card) => `${card[0]}${SUIT_SIGN[card[1]] ?? card[1]}`).join("");
}

/** A solve's share done from its progress, held at or above `previous` and below 1 until it ends. */
export function shareOf(progress: NodelockProgress, previous: number | null): number | null {
  if (progress.etaMs === null) return previous;
  const share = progress.elapsedMs / Math.max(1, progress.elapsedMs + progress.etaMs);
  return Math.min(0.99, Math.max(previous ?? 0, share));
}

export interface SolveNotice {
  id: string;
  name: string;
  status: "solved" | "failed";
}

export interface ActiveLock {
  /** The row, without its chunk. */
  row: NodeLockRow;
  lockSet: LockSet;
  summary: NodelockSummary;
  override: NodelockOverride;
  /** Its parent, then the parent's, to the root (`planChildLock`'s `ancestors`); empty for a lock on the library. */
  ancestors: LockRef[];
}

export interface EditorOpen {
  at: NodelockAt;
  /** A saved lock being edited (or duplicated): its lock fills the editor. */
  from: { lockSet: LockSet; preset: string | null; name: string | null } | null;
  /**
   * Opened inside a lock (§7.4): the open lock and its chain, for
   * `planChildLock`. `edit`: Edit lock, a sibling of the lock that owns the
   * node (`planEditLock`). Absent: a lock on the library.
   */
  within?: EditorWithin | null;
}

export interface EditorWithin {
  open: LockRef;
  ancestors: LockRef[];
  edit: boolean;
}

export interface NodelockSession {
  editor: EditorOpen | null;
  running: RunningSolve | null;
  /** Solves asked for while another runs: they start one after another. */
  queue: SolveRequest[];
  batch: SolveBatch;
  notice: SolveNotice | null;
  active: ActiveLock | null;
  compare: boolean;
  /** Counts Opens: the Solver tab reads its view again from the route. */
  opened: number;
  /** A saved lock to edit (Edit lock, Duplicate and edit): the editor opens once the library shows its decision. */
  pendingEdit: { view: NodelockSummary["view"]; from: NonNullable<EditorOpen["from"]>; within?: EditorWithin | null } | null;
}

let state: NodelockSession = {
  editor: null,
  running: null,
  queue: [],
  batch: { done: 0, total: 0 },
  notice: null,
  active: null,
  compare: false,
  opened: 0,
  pendingEdit: null,
};
/** Set from the moment a solve is taken on until the queue is empty (`running` is set only once its row is saved). */
let busy = false;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;

/**
 * The engine keeps the last spot's solver for a warm start (the next lock on
 * the same spot starts from it), which holds ~1–3 GB. It is kept while the
 * user is still locking, and freed this long after the last solve ended.
 */
export const WARM_KEEP_MS = 10 * 60 * 1000;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function keepWarm(engine: NodelockEngine): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (!state.running) engine.release?.();
  }, WARM_KEEP_MS);
}

function set(next: Partial<NodelockSession>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNodelockSession(): NodelockSession {
  return useSyncExternalStore(subscribe, () => state);
}

export function nodelockSession(): NodelockSession {
  return state;
}

/** Where a lock's chunk lives in the library, and on a turn lock its live turn. */
export function lockKey(at: Pick<NodelockAt, "set" | "line" | "flop" | "turn">): string {
  const chunk = `${at.set}/${at.line}/${at.flop}`;
  return at.turn ? `${chunk}/${liveTurnId(at.turn.chance, at.turn.card)}` : chunk;
}

export function openEditor(at: NodelockAt, from: EditorOpen["from"] = null, within: EditorWithin | null = null): void {
  set({ editor: { at, from, within } });
}

export function closeEditor(): void {
  set({ editor: null });
}

export function setCompare(compare: boolean): void {
  set({ compare });
}

/** My nodelocks, the list (`#/solver/locks`). */
export const LOCKS_PARAM = "locks";

/** My nodelocks on one solved lock, at `view` (a library view's param). */
export function lockParam(id: string, view: string): string {
  return `lock=${encodeURIComponent(id)}${view ? `&${view}` : ""}`;
}

/** The lock a Solver param opens, or null (the library, or the list). */
export function lockIdOf(param: string | null): string | null {
  if (!param || !param.startsWith("lock=")) return null;
  return new URLSearchParams(param).get("lock") || null;
}

export function dismissNotice(): void {
  set({ notice: null });
}

export interface SolveRequest {
  at: NodelockAt;
  /** `plan.set` when there is a plan. */
  lockSet: LockSet;
  name: string;
  preset: string | null;
  summary: NodelockSummary;
  /**
   * Where the row goes and what it is solved on (`planChildLock`,
   * `planEditLock`, `planRemoveLock`). Absent: a root on the library, at the
   * top level.
   */
  plan?: Pick<LockPlan, "parentId" | "baseRowId" | "folderId">;
}

/**
 * The chunk a lock is solved on, as bytes: its base row's stored result
 * (§7.4), or the library chunk as served.
 */
async function baselineOf(request: SolveRequest): Promise<Uint8Array> {
  const { at, lockSet, plan } = request;
  if (lockSet.base) {
    const base = plan?.baseRowId ? await nodelockData.get(plan.baseRowId) : null;
    if (!base?.result || base.status !== "solved" || base.lock_hash !== lockSet.base.lockHash) throw new Error("the lock's base is not solved");
    return base.result;
  }
  return new Uint8Array(await ipc.flopLibraryFile(`${at.set}/${at.library.header.tree}/${at.line}/${at.flop}.bin`));
}

/**
 * Starts a solve on this computer: true, "queued" when another is solving
 * (it starts right after, one at a time: each takes every core and up to
 * ~3 GB), or why not.
 */
export async function startSolve(request: SolveRequest): Promise<true | "queued" | "noEngine" | "failed"> {
  const engine = await pickEngine();
  if (!engine) return "noEngine";
  if (busy) {
    set({ queue: [...state.queue, request], batch: { ...state.batch, total: state.batch.total + 1 }, editor: null });
    return "queued";
  }
  busy = true;
  set({ batch: { done: 0, total: 1 } });
  const started = await run(engine, request);
  if (!started) idle();
  return started ? true : "failed";
}

/** The queue is done: nothing solving, the counter back to nothing. */
function idle(): void {
  busy = false;
  set({ running: null, batch: { done: 0, total: 0 } });
}

/** One solve ended (any way): count it, then start the next in the queue, or end. */
async function next(engine: NodelockEngine): Promise<void> {
  set({ running: null, batch: { ...state.batch, done: state.batch.done + 1 } });
  while (state.queue.length) {
    const [request, ...rest] = state.queue;
    set({ queue: rest });
    if (await run(engine, request)) return;
    // It could not start: counted, and its notice says so.
    set({ batch: { ...state.batch, done: state.batch.done + 1 }, notice: { id: "", name: request.name, status: "failed" } });
  }
  idle();
}

/** Saves the solve's row and sets the engine going; false when it could not start. */
async function run(engine: NodelockEngine, request: SolveRequest): Promise<boolean> {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  const now = Date.now();
  const { lockSet, at, plan } = request;
  const node = lockSet.nodes[0];
  const row: NodeLockInput = {
    name: request.name,
    set_id: lockSet.spot.set,
    line: lockSet.spot.line,
    flop: lockSet.spot.flop,
    turn: lockSet.spot.turn ?? null,
    river: lockSet.spot.river ?? null,
    street: node.street,
    node_path: node.path,
    lock_json: lockSet,
    lock_hash: await lockHashOf(lockSet),
    preset: request.preset,
    status: "solving",
    engine: engine.kind,
    threads: engine.threads,
    iterations: null,
    exploitability_pct: null,
    seconds: null,
    peak_mb: null,
    summary_json: request.summary,
    parent_id: plan?.parentId ?? null,
    // Only a root lives in a folder: children move with their root.
    folder_id: plan?.parentId ? null : (plan?.folderId ?? null),
  };
  let id: string;
  let baseline: Uint8Array;
  try {
    // The chunk the lock is made on: the library's as served, or its base lock's (the engine checks it).
    baseline = await baselineOf(request);
    id = await nodelockData.save(row);
  } catch {
    return false;
  }
  const saved = { ...row, id };
  controller = new AbortController();
  const signal = controller.signal;
  set({
    running: { id, name: row.name, key: lockKey(at), startedAt: now, board: boardText(at.board), progress: null, share: null },
    editor: null,
  });

  void engine
    .solve(
      { lockSet, baseline },
      (progress) => {
        const running = state.running;
        if (running?.id === id) set({ running: { ...running, progress, share: shareOf(progress, running.share) } });
      },
      signal,
    )
    .then(
      async ({ chunk, stats }) => {
        await nodelockData.save(
          {
            ...saved,
            status: "solved",
            engine: stats.engine || engine.kind,
            threads: stats.threads,
            iterations: stats.iterations,
            exploitability_pct: stats.exploitabilityPct,
            seconds: stats.seconds,
            peak_mb: stats.peakMb,
          },
          chunk,
        );
        set({ notice: { id, name: row.name, status: "solved" } });
      },
      async () => {
        const status = signal.aborted ? "cancelled" : "failed";
        await nodelockData.save({ ...saved, status }).catch(() => undefined);
        if (status === "failed") set({ notice: { id, name: row.name, status: "failed" } });
      },
    )
    .catch(() => undefined)
    .finally(() => {
      controller = null;
      keepWarm(engine);
      void next(engine);
    });
  return true;
}

/** Cancels the solve running now; the queue goes on with the next. */
export function cancelSolve(): void {
  controller?.abort();
}

/** Cancels the solve running now and every one waiting. */
export function cancelAll(): void {
  set({ queue: [], batch: { ...state.batch, total: state.batch.total - state.queue.length } });
  controller?.abort();
}

/** A stored row's lock and summary, or null when they do not read. */
export function parseRow(row: NodeLockRow): { lockSet: LockSet; summary: NodelockSummary } | null {
  const lockSet = row.lock_json as LockSet | null;
  const summary = row.summary_json as NodelockSummary | null;
  return summary?.view && lockSet?.nodes?.length ? { lockSet, summary } : null;
}

/** The Solver tab's route for a lock's view. */
export function viewParam(summary: NodelockSummary): string {
  return solverParam(summary.view);
}

/**
 * A lock's ancestors (nearest first) and, for a based lock, its base's
 * chunk. Rows from a store without `parent_id` give no ancestors; the base
 * is then found by its hash.
 */
async function lineageOf(row: NodeLockRow, lockSet: LockSet): Promise<{ ancestors: LockRef[]; base: Uint8Array | null } | null> {
  const rows = await nodelockData.list().catch(() => [] as NodeLockRow[]);
  const chain = lockChain(rows.some((r) => r.id === row.id) ? rows : [...rows, row], row.id) ?? [];
  const ancestors = chain.slice(1);
  if (!lockSet.base) return { ancestors, base: null };
  const hash = lockSet.base.lockHash;
  const baseRow = ancestors.find((lock) => lock.row.lock_hash === hash)?.row ?? rows.find((r) => r.lock_hash === hash && r.status === "solved");
  const base = baseRow ? await nodelockData.get(baseRow.id).catch(() => null) : null;
  return base?.result && base.status === "solved" ? { ancestors, base: base.result } : null;
}

/**
 * Shows a solved nodelock in My nodelocks: its chunk replaces the library's
 * (a flop lock) or one live turn's (a turn or river lock), on the view it was
 * made from. A turn lock built on a flop lock (§7.4) shows on that lock's
 * flop: the base's chunk replaces the library's too. `navigate: false` when
 * the route already names it (the app reopened on it). False when it cannot
 * be read.
 */
export async function openLock(id: string, { navigate = true }: { navigate?: boolean } = {}): Promise<boolean> {
  const row = await nodelockData.get(id).catch(() => null);
  const bytes = row?.result ?? null;
  const parsed = row ? parseRow(row) : null;
  if (!row || !bytes || !parsed || row.status !== "solved") return false;
  let chunk;
  try {
    chunk = decodeChunk(bytes);
  } catch {
    return false;
  }
  const { lockSet, summary } = parsed;
  const key = `${row.set_id}/${row.line}/${row.flop}`;
  const turnId = summary.view.turn ?? null;
  const { result: _result, ...listed } = row;
  void _result;
  const lineage = await lineageOf(listed, lockSet);
  if (!lineage) return false;
  let baseFlop: ReturnType<typeof decodeChunk> | null;
  try {
    baseFlop = lineage.base ? decodeChunk(lineage.base) : null;
  } catch {
    return false;
  }
  const override: NodelockOverride =
    lockSet.nodes[0].street === "flop" || !turnId
      ? { key, id: row.id, flop: chunk, turn: null }
      : { key, id: row.id, flop: baseFlop, turn: { id: turnId, chunk } };
  // The route first: My nodelocks mounts the locked view it names.
  if (navigate) go("solver", lockParam(row.id, viewParam(summary)));
  set({
    active: { row: listed, lockSet, summary, override, ancestors: lineage.ancestors },
    notice: state.notice?.id === id ? null : state.notice,
    editor: null,
    compare: false,
    pendingEdit: null,
    opened: state.opened + 1,
  });
  return true;
}

/**
 * Edits a saved lock (or a copy of it, `name` its new name): back on GTO at
 * the decision it was made at, with the editor opening there on its lock.
 * The solve it leads to is a new nodelock; the old one stays in the history.
 */
export function editLock(row: NodeLockRow, name: string | null): boolean {
  const parsed = parseRow(row);
  if (!parsed) return false;
  go("solver", viewParam(parsed.summary));
  set({
    active: null,
    compare: false,
    editor: null,
    opened: state.opened + 1,
    pendingEdit: { view: parsed.summary.view, from: { lockSet: parsed.lockSet, preset: row.preset, name } },
  });
  return true;
}

/**
 * Edits a decision of the open lock that is not on screen (Edit lock in a
 * lock popover, §7.3): My nodelocks moves to it, and the editor opens there
 * on its lock once the view shows it.
 */
export function editInLock(lockId: string, view: NodelockSummary["view"], from: NonNullable<EditorOpen["from"]>, within: EditorWithin): void {
  go("solver", lockParam(lockId, solverParam(view)));
  set({ editor: null, opened: state.opened + 1, pendingEdit: { view, from, within } });
}

/** The view shows `at`: a pending edit made at this decision opens the editor here (on the library, or in a lock for an edit inside it). */
export function arrivedAt(at: NodelockAt): void {
  const pending = state.pendingEdit;
  if (!pending || (at.locked && !pending.within)) return;
  const view = pending.view;
  const turn = at.turn ? liveTurnId(at.turn.chance, at.turn.card) : undefined;
  if (at.set !== view.set || at.preflop !== view.line || at.node !== view.node || turn !== view.turn) return;
  set({ pendingEdit: null, editor: { at, from: pending.from, within: pending.within ?? null } });
}

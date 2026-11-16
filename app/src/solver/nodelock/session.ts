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
 * Open (notice, history) ─▶ the row's chunk ─▶ the library's override, the Solver tab on its view
 * ```
 */
import { useSyncExternalStore } from "react";

import { ipc } from "../../lib/ipc";
import { go } from "../../lib/router";
import { decodeChunk, liveTurnId, type NodelockAt, type NodelockOverride } from "../door";
import { solverParam } from "../param";
import { lockHashOf, type LockSet, type NodelockEngine, type NodelockProgress, type NodelockSummary } from "./contract";
import { nodelockData, type NodeLockInput, type NodeLockRow } from "./data";
import { pickEngine } from "./engine";

export interface RunningSolve {
  id: string;
  name: string;
  /** `set/line/flop` of the chunk, and the live turn's id on a turn lock: where the banner shows progress. */
  key: string;
  startedAt: number;
  progress: NodelockProgress | null;
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
}

export interface EditorOpen {
  at: NodelockAt;
  /** A saved lock being edited (or duplicated): its lock fills the editor. */
  from: { lockSet: LockSet; preset: string | null; name: string | null } | null;
}

export interface NodelockSession {
  editor: EditorOpen | null;
  running: RunningSolve | null;
  notice: SolveNotice | null;
  active: ActiveLock | null;
  compare: boolean;
  /** Counts Opens: the Solver tab reads its view again from the route. */
  opened: number;
  /** A saved lock to edit (Edit lock, Duplicate and edit): the editor opens once the library shows its decision. */
  pendingEdit: { view: NodelockSummary["view"]; from: NonNullable<EditorOpen["from"]> } | null;
}

let state: NodelockSession = { editor: null, running: null, notice: null, active: null, compare: false, opened: 0, pendingEdit: null };
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

export function openEditor(at: NodelockAt, from: EditorOpen["from"] = null): void {
  set({ editor: { at, from } });
}

export function closeEditor(): void {
  set({ editor: null });
}

export function setCompare(compare: boolean): void {
  set({ compare });
}

export function backToGto(): void {
  set({ active: null, compare: false });
}

export function dismissNotice(): void {
  set({ notice: null });
}

export interface SolveRequest {
  at: NodelockAt;
  lockSet: LockSet;
  name: string;
  preset: string | null;
  summary: NodelockSummary;
}

/** Starts a solve on this computer: true, or why not. */
export async function startSolve(request: SolveRequest): Promise<true | "busy" | "noEngine" | "failed"> {
  if (state.running) return "busy";
  const engine = await pickEngine();
  if (!engine) return "noEngine";
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  const now = Date.now();
  const { lockSet, at } = request;
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
  };
  let id: string;
  let baseline: Uint8Array;
  try {
    // The library chunk the lock is made on, as served (the engine checks its ranges against it).
    baseline = new Uint8Array(await ipc.flopLibraryFile(`${at.set}/${at.library.header.tree}/${at.line}/${at.flop}.bin`));
    id = await nodelockData.save(row);
  } catch {
    return "failed";
  }
  const saved = { ...row, id };
  controller = new AbortController();
  const signal = controller.signal;
  set({ running: { id, name: row.name, key: lockKey(at), startedAt: now, progress: null }, editor: null });

  void engine
    .solve(
      { lockSet, baseline },
      (progress) => {
        if (state.running?.id === id) set({ running: { ...state.running, progress } });
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
        set({ running: null, notice: { id, name: row.name, status: "solved" } });
      },
      async () => {
        const status = signal.aborted ? "cancelled" : "failed";
        await nodelockData.save({ ...saved, status }).catch(() => undefined);
        set({ running: null, notice: status === "failed" ? { id, name: row.name, status: "failed" } : state.notice });
      },
    )
    .catch(() => set({ running: null }))
    .finally(() => {
      controller = null;
      keepWarm(engine);
    });
  return true;
}

export function cancelSolve(): void {
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
 * Shows a solved nodelock in the library: its chunk replaces the library's
 * (a flop lock) or one live turn's (a turn or river lock), and the Solver
 * tab opens on the view it was made from. False when it cannot be read.
 */
export async function openLock(id: string): Promise<boolean> {
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
  const override: NodelockOverride =
    lockSet.nodes[0].street === "flop" || !turnId
      ? { key, id: row.id, flop: chunk, turn: null }
      : { key, id: row.id, flop: null, turn: { id: turnId, chunk } };
  // The route first: the Solver tab mounts the library on the view it names.
  go("solver", viewParam(summary));
  set({
    active: { row: listed, lockSet, summary, override },
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

/** The library shows `at`: a pending edit made at this decision opens the editor here. */
export function arrivedAt(at: NodelockAt): void {
  const pending = state.pendingEdit;
  if (!pending || at.locked) return;
  const view = pending.view;
  const turn = at.turn ? liveTurnId(at.turn.chance, at.turn.card) : undefined;
  if (at.set !== view.set || at.preflop !== view.line || at.node !== view.node || turn !== view.turn) return;
  set({ pendingEdit: null, editor: { at, from: pending.from } });
}

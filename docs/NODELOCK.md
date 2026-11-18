# Nodelock (desktop app only)

The owner's brief (2026-11-16):

- Nodelock exists **only in the desktop app**. It solves on **this computer's
  CPU and memory**, and the app says so plainly. The web gets no nodelock
  option.
- Nodelocks are **stored locally** on the computer. The user can open the
  **history** of earlier nodelocks, delete them, start new ones and so on. The
  history must make clear what was done.
- The **nodelock screen** must be clear and intuitive, laid out like GTO
  Wizard's editor, which the owner likes. Copy the layout and the interaction
  model, not GTOW's branding. It is drawn in Rail's own dark style (`an.css`
  tokens on the map canvas, app CSS modules).
- **Suggestions.** When the user locks a node, Rail proposes what a given
  opponent type would do there. For example, a *tight* BTN on the flop, or an
  *aggressive* opponent on the turn.

Background:
- the study of GTOW: canvas page "Ideas — Nodelock", stickies `nlIA` and `nlRun`;
- timing: sticky `nlTime`;
- the existing exploit lab: `web/src/lib/solver/lock.ts`.

## 0. Numbers that shaped this

- One flop-m1 library solve in TS runs on **one thread**: ~11.5 s per DCFR
  iteration (measured with 6 solves at once).
  - 2.5 % of the pot ≈ 60 iterations ≈ 13 min.
  - 1 % of the pot ≈ 100 iterations ≈ 20 min.
  - Peak memory 0.6–1.8 GB with `i16` storage.
- The M2 Pro has **6 performance and 4 efficiency cores**.
- GTOW answers in seconds because it solves one street at a time and a value
  network estimates the rest. Rail has no value net.
- Rail therefore gets its speed from three things:
  - **parallel turn subtrees**: every core;
  - a **native Rust engine**;
  - a **warm start**: the next lock on the same spot continues from the last
    solve.

**Measured, worker-thread split (workstream E, 2026-11-16).** Spot:
`nlhe-cash-6max-100bb` `btn-bb` `Ks5h3s`, flop-m1, `i16`. Harness:
`tests/scripts/nodelock/cli.mjs`, Node `worker_threads` with the app
engine's partition (`SplitCoordinator` + `SplitPart`). The M2 Pro was not
idle: the nightly flop library ran 3 solves the whole time, so these
numbers are pessimistic.

| Run | Wall time | Per iteration | Peak RSS |
|---|---|---|---|
| Sequential, 10 iterations | 125 s | 13.1 s | 1.11 GB |
| Split, 6 threads, 10 iterations (same exploitability, 40.921 %) | 32 s | 3.34 s | 1.46 GB |
| Split, 6 threads, to the 1 % target: 120 iterations, 0.785 % (1.018 % at the check at 100) | **356 s** | 2.97 s | 1.43 GB |

- Speed-up ≈ 3.9× on 6 threads. Building the parts takes 0.3–0.6 s.
- Sequential to the same 120 iterations ≈ 120 × 13.1 s ≈ 26 min (not run
  to the end).
- 9 threads on an idle machine were not measured. Estimate: 36 turn classes
  over 9 parts gives about 2.2 s per iteration, ≈ 4.5 min to 1 %.
- A warm re-solve was not timed on the real spot.

Targets on the M2 Pro, flop lock to 1 %:

| Engine | Target |
|---|---|
| TS worker pool | ≤ 5 min |
| Native | ≤ 2 min |
| Warm re-solve on the same spot | ≤ 40 s |
| Turn lock | a few seconds |
| River lock | under 1 s |

**Native engine as built (2026-11-16, workstream N).** Release build,
`cargo run --release -p rail-solver --example bench -- target/rail-solver-fixtures/flop-m1-spot.json --threads N`
(the spot from `npm run solver:fixtures` in `tests/`): set
`nlhe-cash-6max-100bb`, line `btn-bb`, flop `Ks5h3s`, flop-m1 tree
(547,392 nodes, 1,429 boards, 443 vs 541 hands), measured from iteration 40
every 10. The M2 Pro was **not idle**: the nightly flop library's three
TypeScript workers ran throughout (load average 7–19), so these are upper
bounds.

| Threads | Storage | Iterations | To 1 % of the pot | Median iteration | Memory |
|---|---|---|---|---|---|
| 1 | f32 | 100 | 523 s (8.7 min) | 5.0 s | 3.1 GB |
| 6 | f32 | 100 | 107 s | 0.92 s | 3.1 GB |
| 9 | f32 | 100 | **75 s** | 0.57 s | 3.1 GB |
| 9 | i16 | 110 | 73 s | 0.60 s | 1.1 GB |

- The TypeScript took 50.9 s for the first 4 iterations of the same spot
  (one measurement included); the native engine 4.1 s at 9 threads, with
  bit-identical strategies and a byte-identical chunk.
- f32 is the default when it fits two fifths of the memory, else i16
  (`nodelock_solve.rs`). i16 needs a few more iterations (its quantisation)
  but a third of the memory.

**Native warm re-solve (2026-11-16).** Measured with
`cargo run --release -p rail-solver --example warm -- target/rail-solver-fixtures/flop-m1-spot.json <the spot's library chunk> --threads 9 --storage f32 [--second S] --cold-too`
on the same spot and its library chunk as the baseline. The machine was
**not idle**: the nightly flop library ran 3 solves throughout (load average
10–17).
- First lock: BTN's node after BB checks, "always bet 33 %" (`B1.82`), with
  "player" earlier nodes. Cold to 1 %: 80 iterations, 34–40 s, 3.1 GB.
- Second lock on the same node, warm (`NODELOCK_WARM_ITERATION` = 10, as the
  worker engine), against the same lock solved cold:

| Second lock | Warm: iterations, to 1 % | Cold: iterations, to 1 % |
|---|---|---|
| Bet 90 %, check 10 % (a small change) | 60, **23.6 s** (0.58 %) | 80, 34.3 s |
| Bet 50 %, check 50 % (a big change) | 100, 44.1 s (0.72 %) | 80, 37.0 s |

- The warm start meets the ≤ 40 s target when the new lock is close to the
  last one. After a big change it is slower than a cold solve: the kept
  regrets point the wrong way for longer than ten iterations of restarted
  averaging make up. The TS worker engine has the same semantics, so the
  same holds there.
- Exploitability is only measured from iteration 40, every 20, so a warm
  solve cannot stop before 40 (30 iterations after the restart).
- Showdowns are ~43 % of a single thread's time. Gathering the opponent's
  reach once per showdown in strength order, so that both sweeps read it in
  sequence, stays bit-identical but was 3–6 % slower on one thread
  (4.6–4.7 s vs 4.8–5.0 s per iteration). It was not kept.

## 1. The lock model (shared library code, `web/src/lib/solver/nodelock.ts`)

This is library code with no UI, so the app can import it through
`@rail/web-lib`. The web imports none of it into a page.

```ts
export type LockEarlier = "none" | "player" | "all";   // GTOW's three Apply options; default "player"

export interface NodeLockSpec {
  street: "flop" | "turn" | "river";
  /** The node's address as the Solver library's view names it: the same `node` (and `turn`/`river` cards) the route uses. */
  path: string;
  player: 0 | 1;                       // 0 = out of position, as in the chunk
  actions: string[];                   // the node's action labels, so a tree mismatch is caught
  /** [action][combo] over the 1,326 canonical combos (`combos.ts` order); rows sum to 1 where locked. */
  strategy: number[][];
  /** 1,326 flags: 1 = this combo's strategy is fixed; 0 = it adapts in the solve (GTOW: "unlocked hands adapt"). */
  locked: number[];
}

export interface LockSet {
  version: 1;
  spot: { set: string; line: string; flop: string; turn?: string; river?: string };
  nodes: NodeLockSpec[];               // one or more nodes, either player
  earlier: LockEarlier;                // freeze the ancestors' strategies at the baseline solve
  targetPct: number;                   // 1 = standard, 2.5 = quick
}

export function lockHash(set: LockSet): string;   // sha-256 hex of the canonical JSON
```

**Earlier nodes.** "player" freezes the locked player's strategy at every
ancestor decision node, at the baseline (library) strategy. "all" freezes
both players. Freezing them keeps the range that arrives at the locked node as
it was.

**As built (workstream E)** — `web/src/lib/solver/nodelock.ts`, exported from
`@rail/web-lib/solver`; tests in `tests/test/solver/nodelock.test.ts`:
- The types and `lockHash` exactly as above. The canonical JSON sorts object
  keys at every level (`canonicalJson`); the SHA-256 is synchronous
  (`sha256Hex`).
- **Paths** (as U's `lockPath`, §5.6). A flop node's `path` is its chunk
  path (`X-B1.82`). A turn or river node's is the flop chunk's deal path,
  the turn card and the node's path in the live turn's result:
  `X-X~Kd/B2.5` (turn), `X-X~Kd/X-X|7h|X` (river). `lockPathOf(flopDeal,
  turn, turnPath)` builds one; `splitLockPath` takes one apart.
- **One game per lock set** (`lockGameStreet`): every node on the flop, or
  every node under one deal and turn card (turn and river nodes mixed).
  Flop and turn nodes cannot be locked together.
- `lockSymmetries(set, board)`: the suit relabellings the lock keeps. The
  solve uses isomorphism only under them (`FlopSpot.symmetry` /
  `TurnSpot.symmetry`), so a lock on one suited combo stays exact. It just
  saves less.
- `applyNodelock(built, solver, set, { pathOf?, baseline? })` freezes the
  locks and the earlier nodes (`earlierNodes`). It throws `NodelockError`
  when a path is missing, the player differs, or the action labels differ.
  `chunkBaseline(chunk, built)` reads a flop chunk's strategies onto a game.
- `combos.ts`: `combosToHands`, `handsToCombos`, `comboRowsToHands`,
  `handRowsToCombos` (1,326-combo rows ↔ a solver's hand list).
- Chunks: `FlopChunkHeader.lockHash?` marks a nodelock result
  (`nodelockHeader`). A flop lock's chunk is a flop-level chunk like the
  library's. A turn or river lock's chunk holds the deal's whole turn game
  (`street: "turn"`, `scope: "all"`), the same as a live turn's
  `FlopChunk`. Library chunks read as before.

## 2. Engine

### 2.1 Frozen nodes in DCFR (`web/src/lib/solver/cfr.ts`)

- `Solver.freeze(node, strategy[action][hand], mask[hand])`.
  - A frozen hand plays the fixed strategy.
  - Its regrets are never updated.
  - Its average strategy *is* the fixed strategy.
- An unfrozen hand in the same node regret-matches as before.
- Exploitability and best response keep working. The frozen player's best
  response is reported, but the "locked" value is the one that matters.

### 2.2 Parallel turn subtrees, deterministic

In alternating DCFR, the opponent's reach at every chance node is known before
a traversal. Each iteration for player p therefore runs in three steps:

1. **Top-down.** Walk the flop part: every flop-level chance node (a turn deal)
   gets its opponent reach vector.
2. **Parallel.** Solve each turn-class subtree for that reach. These are
   independent, and each worker owns a fixed set of subtrees, regrets
   included.
3. **Bottom-up.** Back the values up the flop part and update the flop regrets.

The subtrees are combined in a fixed order, so the parallel result is
**bit-identical** to the sequential one. This is a test.

### 2.3 Same spot as the library

- `nodelockSpot(set, line, flop)` builds the exact `FlopSpot` the library
  job solved: ranges from the chart set's line, pot, stack, rake and
  `FLOP_PROFILE`.
- It moves the job-building logic out of `tests/scripts/flop-library/run.ts`
  into `web/src/lib/analysis/`, so the runner and the app share it.
- Test: for a sample of jobs, `jobSpot(job)` deep-equals `nodelockSpot(...)`.

### 2.4 Reference and engine interface

- `solveNodelock(spot, lockSet, opts)` is the sequential reference. It returns
  the result and a chunk, encoded with `encodeChunk`. The header carries
  `lockHash`.
- Turn and river locks re-solve from the chunk's ranges at the deal, the way
  `liveTurn.ts` does, with the locks applied.

```ts
interface NodelockProgress { iteration: number; exploitabilityPct: number | null; elapsedMs: number; etaMs: number | null; memoryMb: number }
interface NodelockEngine {
  kind: "workers" | "native";
  threads: number;
  solve(req: { lockSet: LockSet; maxIterations?: number }, onProgress: (p: NodelockProgress) => void, signal: AbortSignal):
    Promise<{ chunk: Uint8Array; stats: { iterations: number; exploitabilityPct: number; seconds: number; peakMb: number; threads: number; engine: string } }>;
}
```

### 2.1–2.4 as built (workstream E)

**Frozen nodes** (`cfr.ts`, both storages):
- `Solver.freeze(node, strategy, mask?)`, `unfreezeAll()`, `frozenNodes`.
- `exploitability()` measures the **locked** game: frozen hands play frozen
  in the best response too, so it goes to zero. `exploitability({
  unconstrained: true })` and `bestResponse()` let the frozen player
  deviate. `bestResponse()` against a fully frozen node equals `lock.ts`'s
  `exploitLab` (tested).
- `restartAverage(t)` is the warm start. It keeps the regrets, drops the
  average and goes on from iteration `t`
  (`NODELOCK_WARM_ITERATION = 10`; at `t = 1` DCFR's discount would wipe the
  regrets).

**Split** (`split.ts`):
- The units are the turn deals (the first chance nodes below the flop). The
  turn cards (one per suit class) are split into N groups of about equal
  river work. The split is fixed: `splitCards`, biggest first, each to the
  lightest group.
- A part (`SplitPart`) builds a **partial game**: `buildFlopGame(spot, {
  keepTurn })` keeps only its own turn cards' subtrees, with their regrets,
  tree and boards. The others lead to an empty chance node. The coordinator
  (`SplitCoordinator`) builds the flop only.
- Values cross as **`Float64Array`**, not `Float32Array`. Bit-identity
  needs the sums at full precision. They are still transferable, with no
  SharedArrayBuffer.
- The solve, the exploitability and the evaluation are generators
  (`SplitRun`). `driveSync` runs the parts in-thread; `driveAsync` hands each
  traversal to a pool.
- Bit-identical to `Solver.run` at any iteration count and any N, in `i16`
  and `f32`, with frozen nodes (`tests/test/solver/split.test.ts`,
  `nodelock.test.ts`).

**Same spot as the library** (`web/src/lib/analysis/flopJob.ts`):
- `lineSpot`, `Job`, `jobOf`, `libraryJob`, `jobSpot`, `jobHeader` and
  `nodelockSpot(charts: ChartSet, line: string, flop: string): FlopSpot`.
- The runner (`tests/scripts/flop-library/run.ts`, `full.ts`, `job.ts`,
  `spots.ts`) uses them. `tests/test/solver/nodelockSpot.test.ts` checks
  four lines × four flops of `nlhe-cash-6max-100bb` against the runner's
  old job.

**Reference solve** (`web/src/lib/analysis/nodelock.ts`, `@rail/web-lib/analysis/nodelock`):
- `nodelockSpotOf(set, baseline: FlopChunk, charts?) → NodelockSpot`:
  - `{ street: "flop", spot }` for a flop lock (charts needed);
  - `{ street: "turn", spot, deal, card }` for a turn or river lock (the
    deal's `liveTurnSpot`).
- `solveNodelock(spot, set, { baseline, maxIterations?, storage?,
  onIteration?, warm? }) → { result, chunk, header, solver, warm, built,
  stats }`.
  - Flop: the library profile (`nodelockFlopRun`), `i16`. `checkBaseline`
    refuses a chunk whose hands, pot or stack differ from the game.
  - Turn and river: the live turn's tree and DCFR, `f32`. The flop stays the
    chunk's, so `earlier: "none"` frees only the turn and river decisions.
    Earlier turn and river nodes freeze at the **unlocked turn solve** (the
    live turn), solved first and kept in `warm.turnBaseline`. The locked
    solve then goes on from it warm.
  - `stats.warm` says whether the solve went on from `warm`'s solver. A
    turn game's warm solver without the unlocked baseline (its last lock had
    `earlier: "none"`) is not used when the new lock needs that baseline: the
    solve starts cold and says `warm: false`. The worker engine reports this
    flag as it is.

**Engine interface** (`app/src/solver/nodelock/engine/types.ts`), as §2.4
plus:
- `NodelockRequest.baseline: Uint8Array` is **required**: the library chunk
  bytes the view shows.
- `NodelockStats.warm: boolean`.
- `NodelockEngine.release()` drops the warm state and stops the workers.
- One solve at a time; a second call rejects. A cancel rejects with the
  signal's reason (an `AbortError`).

### 2.5 The two engines

- **Worker engine** (`app/src/solver/nodelock/engine/`): a pool of
  `navigator.hardwareConcurrency - 1` module workers in the app's webview.
  - Messages are transferable `Float32Array`s, with no SharedArrayBuffer (the
    webview is not cross-origin isolated).
  - It is the fallback, and the first engine to ship.
- **Native engine** (`core/rail-solver`, Tauri commands): a parity port of
  the TS solver.
  - rayon over turn subtrees; NEON/SSE through portable `f32` lanes; f32
    storage when memory allows.
  - Commands: `nodelock_solve_start(req) -> job id`, progress events
    `nodelock://progress`, `nodelock_solve_cancel(id)`.
  - Parity: on toy games and one real spot at a fixed iteration count, the
    strategies match the TS reference within 1e-4 and the exploitability
    within 1e-3 % of the pot.
  - The app uses it when present and says which engine ran.
  - **As built:** `core/rail-solver` (parity fixtures from
    `tests/scripts/rail-solver`, bit-identical with the TypeScript on every
    fixture and on the real flop-m1 spot), `app/src-tauri/src/nodelock_solve.rs`
    (`nodelock_engine_info`, `nodelock_solve_start`, `nodelock://progress`,
    `nodelock://done`, `nodelock_solve_cancel`, `nodelock_solve_result`) and
    `app/src/solver/nodelock/engine/native.ts` (`createNativeEngine()`). The
    window builds the reference's game (`nodelockSpotOf`) and Rust runs
    `solveNodelock`'s steps (`rail_solver::nodelock`): the same chunk bytes
    as the TypeScript reference for a flop lock and a turn lock with
    "player" earlier nodes, at 1 and 3 threads (`nodelock.json` fixture).
    It defaults to float32 storage when that fits two fifths of the memory
    (the reference: 16-bit on the flop), so an app solve is not bit-identical
    to the worker engine's, only as accurate.
- **Warm start.** Within one app session the engine keeps the last solver of
  a spot in memory. A new lock on the same spot starts from it.

**Native warm start and the command path as built (2026-11-16):**
- `rail_solver::nodelock::run_nodelock_warm(req, &mut Option<NodelockWarm>,
  cancel, on_progress)`. `run_nodelock` is the same with no warm state.
  - `NodelockWarm` holds the built game, its solver and, for a turn game, the
    unlocked baseline.
  - Its key is the spot as solved (symmetry included), the DCFR parameters,
    the storage asked for, the threads and the memory budget, plus the
    baseline string. Run settings (iterations, target) are not part of it.
  - Same key: the old freezes are dropped (`unfreeze_all`), the average is
    restarted at `WARM_ITERATION` (10), the new locks are frozen, and the
    solve goes on with the old regrets. The turn rule is the reference's
    (above). Any other key frees the old solver before the new game is built.
  - The state is kept after a cancel or an error too, as the worker engine
    keeps its parts.
- `nodelock_solve.rs` keeps it in one process-wide slot. A solve takes it out
  while it runs and puts its own back.
  - `nodelock_release` (the engine's `release()`) frees it. A solve running
    at that moment does not store its solver.
  - One solve at a time: a second `nodelock_solve_start` is refused, and
    `native.ts` refuses a second `solve` as the worker engine does.
  - `stats.warm` comes back in `nodelock://done` and in the engine's stats.
- **Parity:** `core/rail-solver/tests/fixtures/nodelock-warm.json` (written
  by `npm run solver:fixtures`). It is the TypeScript worker engine
  (`createWorkerEngine`, its workers in-thread) checked against
  `solveNodelock` with `warm`, on the reduced Ks5h3s flop.
  - Flop: a lock, then a second lock on the same node, warm.
  - Turn: on one deal, "none", then "player" (cold: no unlocked baseline
    yet), then "player" warm.
  - At 1 and 3 threads the native engine gives every step's chunk bytes (the
    reference's FNV hash), the worker's strategies, the exploitability bit
    for bit, and the same `warm` flags (`parity.rs`,
    `nodelock_warm_matches_the_worker_engine`).
- **The command path, end to end** (`nodelock_solve.rs`,
  `tests::commands::a_solve_through_the_commands`). It goes through Tauri's
  IPC on the mock runtime (`get_ipc_response`), with the request exactly as
  `native.ts` builds it: `app/src-tauri/tests/fixtures/nodelock-request.json`,
  from `nativeRequestOf` in `engine/request.ts`.
  - `nodelock_engine_info`.
  - A cold solve: progress events, then `nodelock://done` with `warm: false`.
    `nodelock_solve_result` gives raw bytes that decode and carry the
    lock's `lockHash`, once only.
  - A second lock: warm, with its own `lockHash`.
  - A second start while a long solve runs is refused.
  - `nodelock_solve_cancel`: done with `ok: false, error: "cancelled"` and
    no chunk.
  - After `nodelock_release`, the next solve is cold.
  - `tests/test/appNodelockNative.test.ts` checks that `nativeRequestOf`
    rebuilds that fixture from the small spot, and that `nativeRequest`
    sends the turn steps' requests of `nodelock-warm.json`.

**Worker engine as built** (`app/src/solver/nodelock/engine/`, tests in
`tests/test/appNodelockEngine.test.ts`):
- For U: `import { createWorkerEngine } from
  "<…>/solver/nodelock/engine"`. `createWorkerEngine({ threads? })` returns
  a `NodelockEngine`. The index also exports the types, `lockHash`,
  `defaultThreads` and `etaOf`.
- Imports of the web library go through `engine/door.ts` only (ESLint
  allows that file).
- **Flop locks** run split. The coordinator runs on the window's thread and
  walks only the flop's decisions. The parts live in
  `hardwareConcurrency - 1` module workers.
- **Turn and river locks** run whole (`solveNodelock`) in one extra worker
  of their own. A cancel terminates it without touching the flop parts.
- **Warm start.** The parts and the coordinator of the last flop spot stay
  in memory; a cancel keeps them. A worker error drops them, and the next
  solve starts cold. The turn worker keeps its last deal's solver and
  unlocked baseline.
- **Progress.** Sent after every iteration. `etaMs` comes from a power law
  through the last two measurements; it is null until there are two.
  `memoryMb` is the solvers' arrays across all threads (not RSS).

## 3. Local storage (`core/rail-store`, migration `0024_node_locks.sql`)

```sql
CREATE TABLE node_locks (
  id TEXT PRIMARY KEY,                -- uuid v4
  name TEXT NOT NULL,                 -- auto: "Tight BTN · A♣T♣6♦ · BTN vs BB", user can rename
  created_at INTEGER NOT NULL,        -- unix ms
  updated_at INTEGER NOT NULL,
  set_id TEXT NOT NULL, line TEXT NOT NULL, flop TEXT NOT NULL, turn TEXT, river TEXT,
  street TEXT NOT NULL CHECK (street IN ('flop','turn','river')),
  node_path TEXT NOT NULL,            -- first locked node, for the list
  lock_json TEXT NOT NULL,            -- LockSet
  lock_hash TEXT NOT NULL,
  preset TEXT,                        -- suggestion id it started from, if any
  status TEXT NOT NULL CHECK (status IN ('draft','solving','solved','failed','cancelled')),
  engine TEXT, threads INTEGER, iterations INTEGER, exploitability_pct REAL, seconds REAL, peak_mb REAL,
  summary_json TEXT,                  -- headline numbers for the list (frequency shifts, EV gain of the responder)
  result BLOB                         -- the locked solve's chunk bytes (~100 KB)
);
CREATE INDEX node_locks_updated ON node_locks(updated_at DESC);
CREATE INDEX node_locks_spot ON node_locks(set_id, line, flop);
```

- **Tauri commands:** `nodelock_list` (no blob), `nodelock_get`,
  `nodelock_save` (upsert), `nodelock_rename`, `nodelock_delete(ids)`. Typed
  wrappers live in `app/src/lib/ipc.ts`.
- **Never synced.** `rail-sync` ignores the table, and a test says so.
- A row in `solving` at app start becomes `cancelled`.

As built (workstream S):
- Store: `rail_store::node_locks` (`NodeLockRow`, `Reader::node_locks(spot)` /
  `node_lock(id)`, `WriterHandle::save_node_lock` / `rename_node_lock` /
  `delete_node_locks`); `Store::open` cancels `solving` rows. Documented in
  `core/rail-store/SCHEMA.md`.
- Commands: `app/src-tauri/src/nodelock_store.rs`. Rows cross as JSON with the
  column names (snake_case), `lock_json` and `summary_json` parsed, plus
  `result_size` (`length(result)`, null without a chunk). The chunk crosses as
  bytes: `nodelock_get` answers a raw frame and `nodelock_save` takes one
  (u32 LE JSON length, the row's JSON, the chunk).
- A save replaces the whole row, the chunk included: saving without one
  clears it. A rename bumps `updated_at`.
- `ipc.ts`:
  ```ts
  nodelockList(spot?: NodeLockSpot | null): Promise<NodeLockRow[]>
  nodelockGet(id: string): Promise<NodeLock | null>            // NodeLock = NodeLockRow & { result: Uint8Array | null }
  nodelockSave(row: NodeLockInput, result?: Uint8Array | null): Promise<NodeLockSaved>   // { id, created_at, updated_at }
  nodelockRename(id: string, name: string): Promise<boolean>
  nodelockDelete(ids: string[]): Promise<number>
  ```
  `NodeLockRow.lock_json` is `NodeLockSet` (`unknown` until U points it at
  `LockSet`).

## 4. Suggestions (`web/src/lib/solver/nodelockSuggest.ts`, pure, tested)

`suggestLocks(ctx, archetype) → { id, title, explanation, nodes: NodeLockSpec[] }`.

**Context:**
- street;
- the locked player's role: preflop aggressor or caller, in or out of position;
- node kind: first to act, facing a bet, or facing a raise;
- the actions;
- the baseline strategy at the node;
- per-combo action EVs from the chunk where it has them, else hand strength
  against the opponent's range. These decide **which hands move first**.

**Archetypes, with EN/HR titles and one-line explanations:**

| Archetype | Betting / first to act | Facing a bet | Facing a raise |
|---|---|---|---|
| Tight (nit) | bets ×0.6, drops bluffs first (weakest), keeps value | folds +15 pp (weakest calls first), raises ×0.5 (value only) | folds +20 pp |
| Aggressive (LAG) | bets +20 pp, adds bluffs with equity first; turn/river: prefers the bigger size | raises ×2 (semi-bluffs first), folds −10 pp | 3-bets/jams ×1.5 |
| Calling station | bets value only, ×0.7 | folds ×0.5, raises ×0.3 | folds ×0.5 |
| Overfolder | unchanged | folds +20 pp | folds +25 pp |
| Passive | bets ×0.5, never raises | raises → 0 (to call) | raises → 0 |

- Street matters: the turn and river multipliers are stronger for
  "Aggressive" (barrels) and "Overfolder" (gives up).
- The owner's examples must come out as described: a tight BTN on the flop,
  and an aggressive opponent on the turn.
- The result is a normal editable lock. The editor shows it, and the user
  tweaks it before solving.
- Later: "From this player's stats" when the spot was opened from a hand, out
  of the villain's own numbers with sample sizes (canvas variant C).

**As built** (tests: `tests/test/solver/nodelockSuggest.test.ts`):
- Exports: `suggestLocks(ctx, archetype, dict?)`, `availableArchetypes(ctx)`,
  `ARCHETYPES`, `nodelockSuggestEn`, `nodelockSuggestHr`, and the types
  `SuggestContext`, `NodelockSuggestion`, `NodelockSuggestDict`,
  `Archetype`, `NodeKind`, `Street`. `NodeLockSpec` is declared locally
  until §1's `nodelock.ts` lands (TODO in the file).
- Archetype ids: `tight`, `aggressive`, `station`, `overfolder`, `passive`.
  The suggestion's `id` is the archetype; it goes into `node_locks.preset`.
- Node kinds: `first`, `facingBet`, `facingRaise`.
- The context carries the action labels (the tree's `X`/`B1.82`/`F`/`C`/
  `R5.4`/`A100`, or words; `kinds`/`amounts` override them), the baseline
  `[action][combo]`, the player's reach per combo, and either `ev`
  (`[action][combo]`) or `strength` (per combo, higher is stronger).
- Groups: fold; passive (check, call); aggressive (bet, raise, all-in).
  "×m" and "+pp" apply to the group's reach-weighted share. A rule only moves
  its own way: when an earlier rule already went past its target, it is
  skipped. Fold rules run first.
- Turn and river, for "aggressive" and "overfolder" only: pp shifts ×1.25
  (turn) and ×1.5 (river); a multiplier's excess over 1 scales the same way
  (raises ×2 become ×2.25 on the turn). The aggressive player also moves
  40 % (turn) or 60 % (river) of every smaller bet or raise size to the
  biggest one (not all-in).
- Where leaving hands go: to their own mix outside the group, else to check
  or call. Tight's dropped raises go to fold. "Never raises" moves all of
  the raises to call.
- Which hands move: with EVs, the cheapest to switch first (EV of the
  hand's mix outside the group minus inside). Costs within `evTolerance`
  (0.01 bb) tie, and the tie goes to strength, the hand's EV under the
  baseline. Without EVs, by strength: folds take the weakest first, and
  bets and raises lose the weakest first.
- Every combo is locked, and every combo's row sums to 1 (empty rows go to
  check or call). `availableArchetypes` drops any archetype that changes no
  row: overfolder when first to act, passive facing an all-in, and tight,
  station and passive when the range never bets.
- Titles: "Tight BTN on the flop" / "Tight BTN na flopu", "Aggressive
  opponent on the turn" / "Agresivan protivnik na turnu".

## 5. UI (app only: `app/src/solver/nodelock/`)

### 5.1 Entry and slot
- `SolverHost` gets an optional `nodelock` slot. The web never sets it, so
  the web shows no nodelock.
- Through the slot the app can:
  - render a **Nodelock** action on the node card of any heads-up library
    spot (flop, turn, river);
  - render a banner above the view;
  - give the library a **chunk override**, so a locked solution is shown in
    place of the library chunk.

### 5.2 The editor
A full-screen overlay laid out like GTOW's.

- **Left: Set strategy.**
  - Modes **Hands / Range / Hand classes**.
  - Per-action sliders with typed % and a hold lock per action.
  - Paint brush (choose an action or a mix, then click or drag over the grid).
  - Reset, Undo, Redo.
  - A **Suggestions** block: archetype chips with a one-line explanation. A
    click fills the editor; the user can still edit.
- **Right: the 13×13 grid.**
  - Views Range / Hand classes / Combos.
  - A Current-strategy bar with the GTO marks.
  - Lock all, Unlock all, Invert, and a lock badge on locked cells.
- **Footer.**
  - "Lock earlier nodes": None / This player's / All (default This player's).
  - Accuracy: Standard 1 % / Quick 2.5 %.
  - Primary **Solve on this computer**, with the engine line underneath:
    "Uses up to 9 of 10 cores and about 1.2 GB. Nothing leaves this
    computer."

### 5.3 Solving
- The solve does not block. Progress shows the iteration, accuracy, elapsed
  time and ETA, with Cancel.
- The user can keep browsing; a notification arrives when it is done.
- A row is saved as `solving` at once, then `solved` with its result.

### 5.4 The result
- The Solver's two tabs, Library | My nodelocks, are one joined pill like
  Cash | Tournaments. **Library is always the clean solve**: no banner, no
  locked chunk, only the Nodelock action. Starting a solve switches to My
  nodelocks, where its progress shows above the list.
- A solved lock opens in **My nodelocks**, on its spot, behind a clear amber
  **Nodelocked** banner. It shows the lock summary, Back to GTO (the Library
  tab on the same view), Edit lock, and Compare (GTO vs locked at any node:
  frequency and EV deltas). Off the locked decision the banner turns quiet,
  says the view is GTO, and offers Go to the locked spot.
- Live turns from a locked chunk work as today.

### 5.5 History
Under the Solver tab, next to the library: **My nodelocks**.

- A list with:
  - name;
  - spot cards and line;
  - the locked node;
  - preset;
  - date;
  - status;
  - accuracy;
  - time;
  - engine.
- Actions:
  - search and filter by spot;
  - open;
  - rename;
  - duplicate and edit;
  - delete, with a confirm that says it cannot be undone;
  - multi-select delete.
- Empty state: one line and the way in. Follow `clean-ui` rules: no titles or
  subtitles that repeat the sidebar.

All strings are EN + HR in the app's i18n.

### 5.6 As built (workstream U)

- **Slot** (`web/src/components/solver/host.tsx`): `SolverNodelock` with
  `override` (`{ key: set/line/flop, id, flop, turn: { id: liveTurnId, chunk } }`),
  `compare`, `nodeAction(at)` and `banner(at)`; `NodelockAt` says where the
  view is. Only `app/src/screens/Solver.tsx` sets it.
- **Files** (`app/src/solver/nodelock/`):
  - `editor/state.ts`: the pure reducer (`tests/test/appNodelockEditor.test.ts`);
  - `spot.ts`: the decision read off the chunk, the lock's address, the
    suggestions' context;
  - `Editor.tsx`, `slot.tsx` (action and banners), `History.tsx` (since v2 the tree, §7.1),
    `SidebarNodelock.tsx` (progress and "ready" on every screen);
  - `session.ts`: the open editor, the one running solve, the notice, the
    lock being shown;
  - `data.ts`: the store's `ipc.nodelock*`;
  - `engine.ts`: picks `createNativeEngine()`, else `createWorkerEngine()`,
    from `./engine/*.ts`. With neither, the editor says this build cannot
    solve yet.
- **Lock path.** On the flop, the flop chunk's node path (`X-B1.82`). On a
  turn or river, the flop chunk's deal path, the turn card and the live
  turn's node path: `X-X~Kd/B2.5`.
- **`summary_json`**: `{ view (SolverView, to open it again), position,
  players, steps, shifts: [{ label, gto, locked }] }`.
- **Routes.** My nodelocks is `#/solver/locks`; an open lock is
  `#/solver/lock=<id>&set=…` (reopened from the store after a restart); the
  library is `#/solver/set=…`.
- `lock_hash` is §1's `lockHash` (canonical-JSON sha-256). `contract.ts`
  re-exports §1's `LockSet`, `NodeLockSpec` and `LockEarlier`, and `ipc.ts`'s
  `NodeLockSet` is `LockSet`.

## 6. Workstreams (agents)

| # | Branch / worktree | Owns | Depends on |
|---|---|---|---|
| E | `nodelock-engine` | §1, §2.1–2.4, the worker engine in `app/src/solver/nodelock/engine/`, `tests/scripts/flop-library` spot move | — |
| N | `nodelock-native` | `core/rail-solver`, Tauri solve commands, parity tests | §1 types (from this doc), E's freeze semantics |
| S | `nodelock-store` | §3: migration, store, commands, `ipc.ts` wrappers | — |
| G | `nodelock-suggest` | §4 | §1 types |
| U | `nodelock-ui` | §5, the `SolverHost` slot | E, S, G on prestaging (builds against this doc's interfaces until then) |

Every workstream follows `CLAUDE.md`:
- its own worktree from `origin/prestaging`;
- the local checks for the area it touched;
- a rebase, then a push to `prestaging`;
- no PRs and no batch PRs.

The web must build and show no nodelock.

## 7. Nodelock v2: the tree, lock marks, locks on locks (owner, 2026-11-18)

The owner's brief, looking at a solved lock in My nodelocks:

- There is no way back to earlier nodelocks. My nodelocks needs a **tree of
  the solves we have**, which the user can **arrange, group and delete**.
- The amber **Nodelocked banner goes**.
- In a nodelocked solve, a **locked action carries a lock icon**. Hovering it
  (or clicking, which pins it) shows **how the action is locked**.
- **More than one lock.** In a locked solve every other decision can be
  locked too. Lock the flop, get the result, then lock an action on the turn
  of that result, and so on.

### 7.1 My nodelocks is a tree beside the solve

The My nodelocks tab is two columns: the **tree** on the left (resizable,
~260 px, collapsible like the app sidebar) and the **open lock's solve** on
the right. Opening a lock no longer leaves the list, so going back to an older
lock is one click. With nothing open, the right side shows one quiet line
("Pick a nodelock, or lock a decision in the Library") — no titles.

**What the tree holds.**
- **Folders**, made by the user, nested, any depth. A new user has none.
- **Locks.** A lock made on top of another lock (§7.4) is that lock's
  **child** and always sits under it: the tree shows how the solves were
  built. Only a root lock (one made on the library) lives in a folder;
  children move with their root.
- Order is the user's (`sort`), new items go to the top of where they land.

**A row** (one line, no wrapping): status dot or spinner with % while
solving / queued / failed / cancelled; the name; on the right, muted, the
board (`Q♠6♥3♦`, turn card added for a turn lock) and how many nodes are
locked (`2🔒`). Hover shows the row's full summary: spot, line, locked
nodes with GTO → locked shifts, accuracy, time, engine, date.

**Actions.**
- Click opens. Arrow keys move, Enter opens, F2 / double-click renames in
  place, Delete deletes.
- Multi-select: Cmd/Ctrl-click, Shift-click.
- Drag and drop: a lock or folder onto a folder moves it in; between rows
  reorders; onto the tree's empty area moves to the top level. A child lock
  cannot be dragged out of its parent (the drop is refused, the row shakes).
- Right-click menu (and a `⋯` button on hover): Open, Rename, New folder
  here, Move to… (folder picker), Duplicate and edit, Delete.
- Toolbar above the tree, icons only with titles: New folder, Search
  (filters by name, board, line; matching rows keep their ancestors),
  Collapse all.
- **Delete** asks once, saying exactly what goes and that it cannot be
  undone: "Delete 3 nodelocks (1 folder, 2 locks built on them)?" Deleting a
  lock deletes its whole branch; deleting a folder deletes everything in it.
  A lock that is solving is cancelled first.
- Expanded folders and the tree width persist (localStorage).

#### As built (U1)

- **Files** (`app/src/solver/nodelock/tree/`):
  - `model.ts`, pure (`tests/test/appNodelockTree.test.ts`): `buildTree`
    (folders, root locks by `folder_id`, children by `parent_id`; siblings by
    `sort`, then folders first, then id, as the store; orphans and cycles go to the top
    level), `visibleRows`, `filterTree` (every word, any case; matches keep
    their ancestors), `rangeKeys`, `topmost`, `deleteArgs`, `locksUnder`,
    `canMove` / `planDrop` (the drop rules), `folderHere`, `folderChoices`,
    `boardCards`. Row keys are `f:<id>` / `l:<id>`.
  - `NodelockTree.tsx`: the tree, toolbar, menu, rename, delete confirm;
    `HoverCard.tsx`: the row's summary; `NodelockSplit.tsx`: the two
    columns, resize handle and hidden strip; `persist.ts`: localStorage
    (`rail.nodelockTree.open` / `.width` / `.hidden`, try/catch).
  - `History.tsx` is gone; `SolverTabs` moved to `SolverTabs.tsx`.
- **Drag** is pointer-based, not HTML drag and drop (a webview can take that
  for file drops). A folder row splits top 25 % before / middle into /
  bottom 25 % after (an open folder: no "after", it means into); a lock row
  splits in halves. Held 0.7 s over a closed folder, it opens. A child lock
  chosen together with its root moves with the branch; alone it is refused
  and shakes. A drop that changes nothing is no drop.
- **Moves** go through `nodelockData.move`: `before` an item, no anchor for
  the top of the folder, and S2's `after` anchor (the last item that stays)
  for its end. A new folder is saved with a `sort` below its siblings' (the
  top) and opens for renaming.
- **Delete** sends the topmost chosen rows (`deleteArgs`) to
  `nodelockFolderDelete` and `nodelockDelete`; the question's counts are
  `nodelockDeletePreview`'s (`locks + descendants` nodelocks, `folders`,
  `descendants` "built on them"), or the tree's own count if the preview
  fails. A lock solving in the branch is cancelled first and the delete waits
  until the session has saved its `cancelled` row, so the save cannot bring
  the row back.
- **Rows.** The running solve (`useNodelockSession().running`): spinner and
  `%`. Failed: red dot; cancelled / an old `solving`: grey dot; draft:
  hollow. Solved: nothing. Queued solves have no row yet (the session saves a
  row when a solve starts), so they show only in the sidebar.
- **Open lock.** Clicking a solved lock calls `openLock`; the route's lock is
  selected and its ancestors opened once (they can be closed again). The
  right side is `OpenLock` as before, keyed by the lock id; with nothing
  open, one quiet line.

### 7.2 No banner

The amber banner and the quiet "off the locked spot" banner are removed.
What they carried moves:
- **Which lock is open**: the selected row in the tree.
- **Back to GTO**: the Library tab, as today (it opens the same view).
- **Compare with GTO**: a quiet toggle at the right end of the
  `Strategy + EV | Ranges` tab row, shown only in My nodelocks.
- **Edit lock**: in the lock popover (§7.3).
- Accuracy / time / engine: the row's hover card.
- **Go to the locked spot**: clicking a locked node in the tree's hover card,
  or the popover.
- A solve's progress: its row in the tree (and the sidebar, as today).

### 7.3 Lock marks and the lock popover

In My nodelocks, every **locked decision** marks its locked actions:
- in the action strip (the position cards along the top, flop/turn/river
  cards included): a small lock icon after each locked action's label, and a
  lock on the card's corner;
- in the strategy panel's action rows on the right ("Check 100%"): the same
  icon after the label.

An action counts as locked when the node is in the lock set and at least one
locked combo plays it with weight > 0 (or the editor held it at 0 %:
then it shows the icon too, with `0 %`).

**Popover** on hover (pinned by click, Esc / click outside closes):
- the node: `BB · Flop · Q♠6♥3♦ · after BTN bet 33 %`;
- per action: `GTO 46.0 % → locked 75.0 %`, bars in the action colours;
- `312 of 1,081 combos fixed · the rest adapt` (or `all combos fixed`);
- a 13×13 mini grid of the locked strategy (locked cells full, unlocked
  dimmed);
- where the lock came from: the preset name, or "Hands painted" / "Range";
- **Edit lock** (opens the editor on this node with this lock loaded; the
  result is a new sibling, §7.4) and **Remove this lock** (a new sibling
  without this node; disabled when it is the only node).
- Locks inherited from a parent lock (§7.4) are marked too, with the
  parent's name in the popover ("from *Passive BB*") and a link to open it.

**As built (U2)**:
- **Slot** (`web/src/components/solver/host.tsx`): `SolverNodelock` gains
  `tabTools(at)` (rendered at the right end of the `Strategy + EV | Ranges`
  row) and `lockMark(node: NodelockNode) → NodelockMark | null`.
  `NodelockNode` is any decision on the action strip or in the panel
  (`library`, the shown `flop`, the `chunk` it is in, `node`, `turn` as in
  `NodelockAt`, `picked`); `NodelockMark` is `{ actions: Set<label>,
  render(action | null) }`. `PostflopBar`'s `DecisionCard` draws
  `render(label)` after each locked option and `render(null)` in the card
  (bottom corner: the head holds the seat and stack, and the bar clips
  anything outside the card); `StrategyView` takes `actionMark(key)` after an
  action box's label. The web sets neither, so it renders nothing new (`.seat`
  only gained `position: relative`). `banner(at)` stays for the pending
  edit but draws nothing.
- **Banner removed** (`slot.tsx`, its CSS and strings). Compare is
  `CompareToggle` in `tabTools`, shown in My nodelocks while the view is the
  lock's solve (`at.locked`).
- **Marks** (`app/src/solver/nodelock/marks.ts`, pure,
  `tests/test/appNodelockMarks.test.ts`): `markPath` builds a decision's
  lock path, `markIndex(own, ancestors)` maps every locked path to its spec
  (own nodes first, then the nearest ancestor's), `nodeMark(spec, spot)` gives
  per action `locked` (a fixed combo plays it, or the lock took GTO's share
  of the fixed combos to 0 %), `gto` and locked `shares` (fixed combos at the
  lock, the rest at GTO), `fixed` / `reaching` combos, `origin` ("range"
  when every reaching combo is fixed, else "painted") and the 169 grid cells.
- **GTO at hand** (`slot.tsx`): the library's flop chunk; on a turn the
  library's live turn when it was solved this session (`liveTurnCached`);
  else, for the row's own first node, `summary.shifts`; else the popover
  shows only the locked shares. A based lock's own nodes have no GTO here.
- **Popover** (`LockMark.tsx`): one open at a time (a small store), hover
  opens, click pins, Esc / outside click closes, closes when the view moves.
  Rendered in a portal, placed under (or over) the icon. The icon after an
  action's label sits inside that action's button, so it is a pointer target
  that does not take the action; the card's corner lock is a real button.
  Ancestors are read from `nodelock_list` by `parent_id`; an inherited mark
  says "From *name*" with a link that opens that lock.

### 7.4 Locks on locks

Inside an open lock **every** decision (flop, turn, river, either player)
offers the **Nodelock** action on its card, exactly as the Library does. The
new lock is always a **new row, child of the open one**; nothing is ever
re-solved in place. What it solves depends on the decision's **game**
(`lockGameStreet`: the flop, or one turn card with its rivers):

| The new node is in… | The child's lock set | Base chunk it solves on |
|---|---|---|
| the open lock's own game | the open lock's nodes + the new one | the same base as the open lock (the library, or its own base) |
| a later game (a turn under a flop lock, a river already counts as the turn's game) | only the new node | **the open lock's result chunk** (`base`) |
| an earlier game (the flop while a turn lock is open) | the flop ancestor's nodes + the new one, child of that ancestor (or a new root when the ancestor is the library) | as row 1 for that ancestor |

So "lock flop → solve → lock turn → solve" is row 2: the turn game is
re-solved from the *locked* flop result's ranges at that deal, with the flop
strategy as the parent solved it.

- Re-locking a node already in the set (Edit lock) replaces that node's spec
  in the child's set. The editor opens on the current locked spec.
- **Edit lock** and **Remove this lock** follow the same table and always
  make a **sibling** (same parent as the open lock), named `<name> (2)`.
- The editor's footer says what the solve will be, one quiet line:
  "Builds on *Passive BB*: the turn is solved from its result" /
  "Adds to *Passive BB*'s flop locks: the flop is solved again (~1–2 min)".
- Lock path, symmetries and `lockGameStreet` are unchanged: one lock set is
  still one game. Chaining is what spans streets.

**Lock model** (`web/src/lib/solver/nodelock.ts`, §1):

```ts
export interface LockBase {
  /** The parent lock's `lock_hash`: the chunk this set is solved on. */
  lockHash: string;
  /** Its street game, for checking. */
  street: "flop" | "turn";
}
export interface LockSet {
  version: 1;               // unchanged: `base` is optional
  spot: …;
  nodes: NodeLockSpec[];
  earlier: LockEarlier;
  targetPct: number;
  /** Absent: solved on the library chunk (every v1 lock). */
  base?: LockBase;
}
```
- `lockHash` includes `base`, so the same turn lock on two parents differs.
- `earlier` on a based set freezes ancestors at the **base** chunk's
  strategy, not the library's.
- `planChildLock(open: { row: NodeLockRow; set: LockSet } , ancestors, at, spec)
  → { parentId: string | null; set: LockSet; baseRowId: string | null; kind: "same" | "later" | "earlier" }`
  in `app/src/solver/nodelock/lineage.ts` (pure, tested) implements the
  table. `ancestors` is the open lock's chain to the root.

**Engine.** A based solve gets the base row's chunk where it would get the
library chunk: `nodelockSpotOf(lockSet, baseChunk, charts)` for the ranges
at the deal, `baseline` = the base chunk's bytes for the earlier nodes. Both
engines (workers and native) already take these as inputs; the app passes
the parent's chunk instead of the served library file. A based chunk's
header carries `lockHash` (its own) and `baseHash`.

### 7.5 Storage (migration `0025_node_lock_tree.sql`)

```sql
CREATE TABLE node_lock_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES node_lock_folders(id) ON DELETE CASCADE,
  sort REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE node_locks ADD COLUMN folder_id TEXT;   -- root locks only; NULL = top level
ALTER TABLE node_locks ADD COLUMN parent_id TEXT;   -- the lock this one is built on; NULL = on the library
ALTER TABLE node_locks ADD COLUMN sort REAL NOT NULL DEFAULT 0;
CREATE INDEX node_locks_parent ON node_locks(parent_id);
CREATE INDEX node_locks_folder ON node_locks(folder_id);
```
- Existing rows: `folder_id` NULL, `parent_id` NULL, `sort` = −`updated_at`
  (newest first, as the list showed them).
- `sort` is a fractional index: moving between two rows takes the midpoint;
  the store renumbers a sibling list when gaps get below 1e-6.
- Deleting a lock deletes its descendants (the store walks `parent_id`; no FK,
  so a v1 store opens unchanged). Deleting a folder deletes its subfolders
  and every lock (and branch) in them. Both in one transaction.
- Still never synced.

Tauri commands / `ipc.ts` (additions; existing ones unchanged, `NodeLockRow`
gains `folder_id`, `parent_id`, `sort`):
```ts
nodelockFolders(): Promise<NodeLockFolder[]>          // { id, name, parent_id, sort, created_at, updated_at }
nodelockFolderSave(f: { id?: string; name: string; parent_id: string | null; sort?: number }): Promise<NodeLockFolder>
nodelockFolderDelete(ids: string[]): Promise<{ folders: number; locks: number }>
nodelockMove(items: { kind: "lock" | "folder"; id: string }[], to: { folder_id: string | null; before?: { kind: "lock" | "folder"; id: string } | null }): Promise<boolean>
nodelockDelete(ids: string[]): Promise<number>        // now: with descendants; returns rows deleted
nodelockDeletePreview(locks: string[], folders: string[]): Promise<{ folders: number; locks: number; descendants: number }>
```
`nodelockSave` takes `parent_id` (and `folder_id` for a root); `nodelockMove`
refuses a child lock, a folder into its own subtree, and returns false.

**As built (S2).** `rail_store::node_locks` (`NodeLockFolder`,
`NodeLockItem`, `NodeLockPlace`, `NodeLockDeleted`, `NodeLockDeletePreview`),
commands in `app/src-tauri/src/nodelock_store.rs` (all `async`), wrappers
and types in `ipc.ts` as above; `core/rail-store/SCHEMA.md`. Where it
differs from or adds to the spec:
- **The place is the first save's.** `nodelockSave` reads `parent_id` /
  `folder_id` for a **new** row only and puts it at the **top** of its list;
  a later save of the same id (the solve's end, an edit) keeps `folder_id`,
  `parent_id` and `sort` as stored, whatever it sends, so a move made while a
  lock solves is not undone. `sort` is ignored on a save. In `NodeLockInput`
  `parent_id` and `folder_id` are **optional** (absent: a root on the top
  level), so a v1 caller still type-checks.
- A new row whose `parent_id` does not exist is **refused** (an error): a
  branch deleted while its solve ran is not brought back as an orphan. A
  child's `folder_id` is always stored NULL. An unknown `folder_id` puts a
  new root on the top level.
- **One list per folder:** a folder's subfolders and root locks share one
  `sort` space (ties: folders first, then id), so a move's anchor can be
  either kind. A lock's children are a list of their own.
- `nodelockMove(items, to)`: `to` also takes `after?: { kind, id } | null`
  (used when `before` is absent), so a drop below the last row can say so;
  neither: the **top** of the folder. Several items land together in the
  given order. Besides a child lock and a folder into its own subtree, it
  returns false (nothing changed) for an unknown item, target folder or
  anchor, an anchor that is not in the target folder or is being moved, or
  no items. A moved folder's `updated_at` changes, a moved lock's does not.
- **Renumbering**: also when a double cannot split the gap, not only below
  1e-6: migrated sorts are ~-1.7e12, where a double steps by ~2e-4, so a
  dozen halvings between two of them would collide first. The list becomes
  0, 1, 2, … in the move's transaction.
- `nodelockFolderSave` rejects (an error, not false) a name that is empty or
  over 200 characters, a parent that is unknown, the folder itself or inside
  it. No `sort`: the top of the list for a new folder or one that changes
  parent, else where it was. An extra index `node_lock_folders_parent`.
- `nodelockDeletePreview` counts: `folders` (subfolders included), `locks`
  (each deleted lock whose parent is not deleted) and `descendants` (the
  rest); `locks + descendants` is what `nodelockDelete` /
  `nodelockFolderDelete` return as rows. `nodelockFolderDelete` returns
  `locks` as every lock row, branches included.
- `nodelockList` still orders by `updated_at`; the tree sorts by `sort`.

### 7.6 Workstreams (v2 agents)

Each in its own worktree from `origin/prestaging`, local checks for what it
touched, rebase, push to `prestaging` (CLAUDE.md). No PRs.

| # | Worktree | Owns |
|---|---|---|
| S2 | `nodelock-tree-store` | §7.5: migration 0025, `rail_store::node_locks` folders/move/delete-with-descendants, Tauri commands, `ipc.ts` types + wrappers, SCHEMA.md, tests |
| E2 | `nodelock-chain` | §7.4: `LockBase` + hash, based solves in `nodelock.ts`/both engines (`baseHash` header, earlier nodes from the base), `lineage.ts` `planChildLock` + tests, `session.ts` `startSolve` taking a parent (base chunk from the store, `parent_id` saved) |
| U1 | `nodelock-tree-ui` | §7.1: the tree (`app/src/solver/nodelock/tree/`), the two-column My nodelocks in `Solver.tsx`, `History.tsx` replaced, drag/drop, menus, delete confirm, search, persistence, EN+HR strings |
| U2 | `nodelock-marks` | §7.2–7.3 and the UI of §7.4: banner removed, Compare toggle, lock marks + popover (slot additions in `web/src/components/solver/host.tsx` + `StrategyView` / action strip, web shows none), the Nodelock action inside a lock, Edit/Remove as siblings, the editor's footer line, EN+HR strings |

U1 and U2 build against this section's interfaces until S2 and E2 land, then
rebase onto them. `i18n/en.ts`/`hr.ts` conflicts are expected: keep both
sides.

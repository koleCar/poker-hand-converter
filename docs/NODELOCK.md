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

Targets on the M2 Pro, flop lock to 1 %:

| Engine | Target |
|---|---|
| TS worker pool | ≤ 5 min |
| Native | ≤ 2 min |
| Warm re-solve on the same spot | ≤ 40 s |
| Turn lock | a few seconds |
| River lock | under 1 s |

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
- **Warm start.** Within one app session the engine keeps the last solver of
  a spot in memory. A new lock on the same spot starts from it.

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
- The Solver view switches to the locked solution behind a clear amber
  **Nodelocked** banner. It shows the lock summary, Back to GTO, Edit lock,
  and Compare (GTO vs locked at any node: frequency and EV deltas).
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

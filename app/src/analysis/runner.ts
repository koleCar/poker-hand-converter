/**
 * The app's analysis runner (docs/RAIL-PLAN.md R5.4): every hand in the
 * store analysed at the app's `ANALYSIS_VERSION`, in the background, at low
 * priority, and never while a poker table is open (A10).
 *
 * The loop, one page of {@link PAGE} hands at a time:
 *
 * 1. **The gate** (`analysis_gate`, Rust): not while the user has paused
 *    it, not while the HUD has a table open, not while a backfill runs or
 *    the statistics pass works (R2.3's rule: import and statistics first).
 *    Asked before every page; a table opening also stops the page in flight
 *    at once ({@link AnalysisRunner.tablesOpen}: the worker is terminated).
 * 2. **Which hands**: those without a row at the version, newest first (the
 *    web's "recent first" read), a keyset page at a time; new hands imported
 *    start the walk again from the newest ({@link AnalysisRunner.wake}).
 *    Then, when the flop library can be reached, hands analysed without it.
 * 3. **The opponents' statistics** for the page's hands (analysis/20,
 *    `VillainCounters`, the web's batching and cache) from the store
 *    (`analysis_villains`, the web's `villain_counters` over it), kept for
 *    the run, read afresh for the next.
 * 4. **The worker** analyses the page (`worker.ts`, the web's library);
 *    the rows are written (`analysis_save`) and the next page waits
 *    {@link BREATHER_MS}.
 *
 * **Offline**: when a page could not fetch a flop library file, the next
 * pages go without the library (graded as the web grades a hand whose chunk
 * cannot be fetched, the rows marked) until a probe every {@link PROBE_MS}
 * finds the bucket again; then those hands are analysed again.
 *
 * Nothing on startup: the first look is {@link START_DELAY_MS} after the
 * window opens. Idle, the worker is let go (the chart sets it loaded are
 * hundreds of megabytes) and made again for the next page. A hand the
 * engine throws on is left unanalysed (as on the web) and not tried again
 * until the app starts again.
 *
 * Pure apart from its dependencies ({@link RunnerDeps}), which the tests
 * replace.
 */
import type { PageHand, PageResult } from "./engine";
import { ANALYSIS_VERSION, VILLAIN_MIN_HANDS, VillainCounters, type PhfHand, type TournamentSettingsMap, type VillainStatsMap } from "./library";
import type { StoreHandRow } from "./rows";

/** Hands per page (one worker job). */
export const PAGE = 20;
/** The first look after the window opens. */
export const START_DELAY_MS = 20_000;
/** Between pages: the analysis is a background job. */
export const BREATHER_MS = 250;
/** How often a closed gate is asked again. */
export const GATE_POLL_MS = 5_000;
/** How often an idle runner looks for work (new hands also wake it). */
export const IDLE_POLL_MS = 60_000;
/** How often, while offline, the runner looks whether the flop library answers again. */
export const PROBE_MS = 10 * 60_000;

export type GateReason = "paused" | "tables" | "backfill" | "statistics" | "store";

export interface RunnerGate {
  run: boolean;
  reason: GateReason | null;
  paused: boolean;
}

export interface RunnerCounts {
  hands: number;
  current: number;
  stale: number;
  missing: number;
  offline: number;
  notAnalysable: number;
}

export interface PendingDto {
  handKey: string;
  playedAt: string;
  phf: string;
}

type Cursor = { playedAt: string; handKey: string };

/** What the runner uses: the IPC, the worker, the clock. */
export interface RunnerDeps {
  gate(): Promise<RunnerGate>;
  counts(version: string): Promise<RunnerCounts>;
  pending(version: string, after: Cursor | null, limit: number): Promise<PendingDto[]>;
  offline(version: string, limit: number): Promise<PendingDto[]>;
  reachable(): Promise<boolean>;
  villains(
    players: { site: string; player: string }[],
    minHands: number,
  ): Promise<{ site: string; player: string; vpipOpp: number; vpip: number; pfr: number }[]>;
  analyse(
    page: PageHand[],
    villains: VillainStatsMap | null,
    library: boolean,
    signal: AbortSignal,
    tournaments?: TournamentSettingsMap | null,
  ): Promise<PageResult>;
  /** (R5.5) The user's settings per tournament; absent or failing: none (the standard assumptions). */
  tournaments?(): Promise<TournamentSettingsMap | null>;
  save(rows: StoreHandRow[]): Promise<{ saved: number; missing: number }>;
  /** Wait `ms`, or less when the signal fires. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** Going idle: let go of what the analysis holds (the worker and its chart sets). */
  release?(): void;
}

/** What the runner is doing, for Settings and the analysis screens. */
export interface RunnerStatus {
  phase: "starting" | "waiting" | "running" | "idle" | "stopped" | "error";
  /** Why it waits (`phase` "waiting"). */
  reason: GateReason | null;
  paused: boolean;
  counts: RunnerCounts | null;
  /** Hands analysed and written since the app started. */
  analysed: number;
  /** Hands the engine threw on, since the app started. */
  failed: number;
  /** Hands a second over the last page; null before the first. */
  handsPerSecond: number | null;
  /** Whether the flop library answered at the last look. */
  library: boolean;
  lastError: string | null;
  version: string;
}

export class AnalysisRunner {
  private readonly deps: RunnerDeps;
  private readonly version: string;
  private status: RunnerStatus;
  private readonly listeners = new Set<() => void>();
  private readonly written = new Set<() => void>();
  private running = false;
  private stopped = false;
  /** A wake that came while no wait was on: the next wait returns at once. */
  private woken = false;
  private wait: AbortController | null = null;
  private page: AbortController | null = null;
  private cursor: Cursor | null = null;
  private readonly failedKeys = new Set<string>();
  private villains: VillainCounters | null = null;
  private reachable = true;
  private lastProbe = Number.NEGATIVE_INFINITY;

  constructor(deps: RunnerDeps, version: string = ANALYSIS_VERSION) {
    this.deps = deps;
    this.version = version;
    this.status = {
      phase: "starting",
      reason: null,
      paused: false,
      counts: null,
      analysed: 0,
      failed: 0,
      handsPerSecond: null,
      library: true,
      lastError: null,
      version,
    };
  }

  /** The status now (a new object after each change). */
  current(): RunnerStatus {
    return this.status;
  }

  /** Hear every status change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hear when rows were written (the analysis screens read again). */
  onRows(listener: () => void): () => void {
    this.written.add(listener);
    return () => this.written.delete(listener);
  }

  private set(patch: Partial<RunnerStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Start the loop after `delayMs` (the first look waits: nothing heavy on startup). */
  start(delayMs: number = START_DELAY_MS): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.loop(delayMs);
  }

  /** End the loop for good (the app is quitting); the page in flight is dropped. */
  stop(): void {
    this.stopped = true;
    this.page?.abort();
    this.wake();
    this.set({ phase: "stopped" });
  }

  /** New hands, a pause lifted, a table closed: look now, newest hands first. */
  wake(): void {
    this.cursor = null;
    this.woken = true;
    this.wait?.abort();
  }

  /** (A10) A poker table opened: the page in flight stops now. Closed: look again. */
  tablesOpen(open: boolean): void {
    if (open) {
      this.page?.abort();
      this.set({ phase: "waiting", reason: "tables" });
    } else {
      this.wake();
    }
  }

  /** The user paused (the page in flight stops) or resumed. */
  paused(paused: boolean): void {
    if (paused) {
      this.page?.abort();
      this.set({ paused, phase: "waiting", reason: "paused" });
    } else {
      this.set({ paused });
    }
    this.wake();
  }

  private async sleep(ms: number): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return;
    }
    const controller = new AbortController();
    this.wait = controller;
    await this.deps.sleep(ms, controller.signal);
    if (this.wait === controller) this.wait = null;
    this.woken = false;
  }

  private async loop(delayMs: number): Promise<void> {
    await this.deps.sleep(delayMs, new AbortController().signal);
    while (!this.stopped) {
      try {
        await this.step();
      } catch (error) {
        if (this.stopped) return;
        this.set({ phase: "error", lastError: error instanceof Error ? error.message : String(error) });
        await this.sleep(GATE_POLL_MS);
      }
    }
  }

  /** One turn of the loop: a page analysed, or a wait. Public for the tests. */
  async step(): Promise<void> {
    const gate = await this.deps.gate();
    if (!gate.run) {
      this.set({ phase: "waiting", reason: gate.reason, paused: gate.paused });
      await this.sleep(GATE_POLL_MS);
      return;
    }
    this.set({ paused: gate.paused });
    // Offline since a fetch failed: now and then, does the bucket answer again?
    if (!this.reachable && this.deps.now() - this.lastProbe >= PROBE_MS) {
      this.lastProbe = this.deps.now();
      this.reachable = await this.deps.reachable();
      this.set({ library: this.reachable });
    }
    const counts = await this.deps.counts(this.version);
    this.set({ counts });
    let hands: PendingDto[] = [];
    if (counts.missing > this.failedKeys.size) {
      const read = await this.deps.pending(this.version, this.cursor, PAGE);
      const last = read[read.length - 1];
      if (last) {
        this.cursor = { playedAt: last.playedAt, handKey: last.handKey };
        hands = read.filter((hand) => !this.failedKeys.has(hand.handKey));
        // A page of hands that failed before: on to the next.
        if (hands.length === 0) return;
      } else if (this.cursor !== null) {
        // The walk reached the oldest hand: again from the newest.
        this.cursor = null;
        return;
      }
    }
    if (hands.length === 0 && counts.offline > 0 && this.reachable) {
      // Hands graded without the flop library, now that it answers.
      hands = (await this.deps.offline(this.version, PAGE)).filter((hand) => !this.failedKeys.has(hand.handKey));
    }
    if (hands.length === 0) {
      // Nothing to do: the next run reads the opponents' statistics afresh.
      this.villains = null;
      this.cursor = null;
      if (this.status.phase !== "idle") this.deps.release?.();
      this.set({ phase: "idle", reason: null });
      await this.sleep(IDLE_POLL_MS);
      return;
    }
    await this.analyse(hands);
    await this.sleep(BREATHER_MS);
  }

  private async analyse(pending: PendingDto[]): Promise<void> {
    const page: PageHand[] = [];
    for (const hand of pending) {
      try {
        page.push({ handKey: hand.handKey, phf: JSON.parse(hand.phf) as PhfHand });
      } catch {
        this.failedKeys.add(hand.handKey);
      }
    }
    if (page.length === 0) return;
    this.villains ??= new VillainCounters((players) => this.deps.villains(players, VILLAIN_MIN_HANDS));
    let villains: VillainStatsMap | null;
    try {
      villains = await this.villains.statsFor(page.map((hand) => hand.phf));
    } catch {
      // The store did not answer: the population ranges.
      villains = null;
    }
    // R5.5: read per page - a save re-queues its tournament's hands, which the next pages then read with it.
    const tournaments = this.deps.tournaments ? await this.deps.tournaments().catch(() => null) : null;
    const library = this.reachable;
    this.set({ phase: "running", reason: null, library });
    const controller = new AbortController();
    this.page = controller;
    const started = this.deps.now();
    let result: PageResult;
    try {
      result = await this.deps.analyse(page, villains, library, controller.signal, tournaments);
    } catch (error) {
      // Stopped (a table opened, a pause, quitting): analysed again later.
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      this.page = null;
    }
    for (const key of result.failed) this.failedKeys.add(key);
    if (library && result.rows.some((row) => !row.flop_library)) {
      // A flop library file could not be fetched: the next pages go without
      // the library until a probe finds the bucket again.
      this.reachable = false;
      this.lastProbe = this.deps.now();
    }
    if (result.rows.length > 0) {
      await this.deps.save(result.rows);
      for (const listener of this.written) listener();
    }
    const seconds = Math.max(0.001, (this.deps.now() - started) / 1000);
    this.set({
      analysed: this.status.analysed + result.rows.length,
      failed: this.failedKeys.size,
      handsPerSecond: page.length / seconds,
      library: this.reachable,
      lastError: null,
    });
  }
}

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
 *    So it goes month by month, newest month first (2026-11-18: the status
 *    shows the month under way and every month's count, {@link RunnerDeps.months});
 *    the user can send one month to the front ({@link AnalysisRunner.focus}).
 *    Then, when the flop library can be reached, hands analysed without it.
 * 3. **The opponents' statistics** for the page's hands (analysis/20,
 *    `VillainCounters`, the web's batching and cache) from the store
 *    (`analysis_villains`, the web's `villain_counters` over it), kept for
 *    the run, read afresh for the next.
 * 4. **The workers** analyse the pages (`worker.ts`, the web's library):
 *    {@link RunnerDeps.lanes} pages at once (2026-11-19), each on its own
 *    worker; a worker takes the next page as soon as its own is written, so
 *    one slow hand (a turn solve can take most of a minute) holds up its own
 *    worker only. The rows are written (`analysis_save`) page by page; a
 *    hand in flight is never read into a second page. Between pages,
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

/**
 * (2026-11-19) Workers analysing pages at once: half the cores, at most
 * four (each one holds its own chart sets, a few hundred MB), at least one.
 * Measured on real hands: nearly all the time goes to the few hands that
 * reach the turn (a live turn and river solve, one core each), so pages on
 * several workers go about as many times faster.
 */
export function analysisLanes(cores: number = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 1): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/** (R6.4) `plan`: enforcement on and the plan without the analysis. */
export type GateReason = "paused" | "tables" | "backfill" | "statistics" | "store" | "plan";

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

/** One month's count (`played_at`'s UTC `YYYY-MM`; '' for hands without a date). */
export interface MonthCounts {
  month: string;
  hands: number;
  current: number;
}

type Cursor = { playedAt: string; handKey: string };

/** The month a hand was played in (`YYYY-MM`, UTC as `played_at`); '' without a date. */
export function monthOf(playedAt: string): string {
  return /^\d{4}-\d{2}/.test(playedAt) ? playedAt.slice(0, 7) : "";
}

/** The month after `YYYY-MM`. */
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${String(year + 1).padStart(4, "0")}-01` : `${month.slice(0, 4)}-${String(m + 1).padStart(2, "0")}`;
}

/** What the runner uses: the IPC, the workers, the clock. */
export interface RunnerDeps {
  /** Pages analysed at once, each on its own worker (absent: 1). */
  lanes?: number;
  gate(): Promise<RunnerGate>;
  counts(version: string): Promise<RunnerCounts>;
  /** The counts month by month, newest first; absent: no months in the status. */
  months?(version: string): Promise<MonthCounts[]>;
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
    /** Which worker (0 to `lanes` - 1). */
    lane?: number,
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
  /** The counts month by month, newest first (read while hands are left); null before. */
  months: MonthCounts[] | null;
  /** The month of the page under way (or the last one); null before the first. */
  month: string | null;
  /** The month the user sent to the front, until it is done; null: newest first. */
  focus: string | null;
  /** Hands analysed and written since the app started. */
  analysed: number;
  /** Hands the engine threw on, since the app started. */
  failed: number;
  /** Hands a second, every worker together (each one's last page); null before the first. */
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
  private readonly lanes: number;
  /** The pages in flight, by lane. */
  private readonly inFlight = new Map<number, { controller: AbortController; done: Promise<void> }>();
  private readonly inFlightKeys = new Set<string>();
  /** Each lane's last page: hands a second. */
  private readonly lanePace = new Map<number, number>();
  /** A page failed: the next turn waits before going on. */
  private backoff = false;
  private cursor: Cursor | null = null;
  private focusMonth: string | null = null;
  private readonly failedKeys = new Set<string>();
  private villains: VillainCounters | null = null;
  private reachable = true;
  private lastProbe = Number.NEGATIVE_INFINITY;

  constructor(deps: RunnerDeps, version: string = ANALYSIS_VERSION) {
    this.deps = deps;
    this.version = version;
    this.lanes = Math.max(1, Math.floor(deps.lanes ?? 1));
    this.status = {
      phase: "starting",
      reason: null,
      paused: false,
      counts: null,
      months: null,
      month: null,
      focus: null,
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
    this.abortAll();
    this.wake();
    this.set({ phase: "stopped" });
  }

  /** New hands, a pause lifted, a table closed: look now, newest hands first. */
  wake(): void {
    this.cursor = null;
    this.woken = true;
    this.wait?.abort();
  }

  /**
   * Analyse `month` (`YYYY-MM`) next, then on as before (older months, then
   * the newest again); null: back to newest first. The page in flight
   * finishes first.
   */
  focus(month: string | null): void {
    this.focusMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : null;
    this.set({ focus: this.focusMonth });
    this.wake();
  }

  /** (A10) A poker table opened: the page in flight stops now. Closed: look again. */
  tablesOpen(open: boolean): void {
    if (open) {
      this.abortAll();
      this.set({ phase: "waiting", reason: "tables" });
    } else {
      this.wake();
    }
  }

  /** The user paused (the page in flight stops) or resumed. */
  paused(paused: boolean): void {
    if (paused) {
      this.abortAll();
      this.set({ paused, phase: "waiting", reason: "paused" });
    } else {
      this.set({ paused });
    }
    this.wake();
  }

  /** Stop every page in flight (analysed again later). */
  private abortAll(): void {
    for (const page of this.inFlight.values()) page.controller.abort();
  }

  private freeLane(): number | null {
    for (let lane = 0; lane < this.lanes; lane += 1) if (!this.inFlight.has(lane)) return lane;
    return null;
  }

  /** Wait until a page in flight is done (at once when none is). */
  private async settle(): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([...this.inFlight.values()].map((page) => page.done));
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

  /** One turn of the loop: a page started (and, every worker busy, one finished), or a wait. Public for the tests. */
  async step(): Promise<void> {
    if (this.backoff) {
      this.backoff = false;
      await this.sleep(GATE_POLL_MS);
    }
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
    // The months while hands are left, and once more when the last are done.
    const monthsLeft = counts.missing > 0 || (this.status.months?.some((m) => m.current < m.hands) ?? false);
    const months = monthsLeft && this.deps.months ? await this.deps.months(this.version).catch(() => null) : null;
    this.set(months ? { counts, months } : { counts });
    // Every worker busy: wait for one.
    if (this.freeLane() === null) {
      await this.settle();
      return;
    }
    const free = (hand: PendingDto) => !this.failedKeys.has(hand.handKey) && !this.inFlightKeys.has(hand.handKey);
    let hands: PendingDto[] = [];
    if (counts.missing > this.failedKeys.size + this.inFlightKeys.size) {
      const focus = this.focusMonth;
      // A month sent to the front: the walk starts at its newest hand
      // (before the next month's first, in the keyset's order).
      if (focus && this.cursor === null) this.cursor = { playedAt: nextMonth(focus), handKey: "" };
      const read = await this.deps.pending(this.version, this.cursor, PAGE);
      const last = read[read.length - 1];
      const inFocus = focus ? read.filter((hand) => monthOf(hand.playedAt) === focus) : read;
      if (focus && inFocus.length === 0) {
        // The month is done: newest first again.
        this.focusMonth = null;
        this.cursor = null;
        this.set({ focus: null });
        return;
      }
      if (last) {
        this.cursor = { playedAt: last.playedAt, handKey: last.handKey };
        hands = inFocus.filter(free);
        // A page of hands that failed before, or are in flight: on to the next.
        if (hands.length === 0) return;
      } else if (this.cursor !== null) {
        // The walk reached the oldest hand: again from the newest.
        this.cursor = null;
        return;
      }
    }
    if (hands.length === 0 && counts.offline > 0 && this.reachable) {
      // Hands graded without the flop library, now that it answers.
      hands = (await this.deps.offline(this.version, PAGE)).filter(free);
    }
    if (hands.length === 0 && this.inFlight.size > 0) {
      // The rest is in flight: wait for it.
      await this.settle();
      return;
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
    this.dispatch(hands);
    if (this.freeLane() === null) await this.settle();
    await this.sleep(BREATHER_MS);
  }

  /** Start a page on a free lane (the caller checked there is one). */
  private dispatch(pending: PendingDto[]): void {
    const lane = this.freeLane();
    if (lane === null) return;
    const controller = new AbortController();
    for (const hand of pending) this.inFlightKeys.add(hand.handKey);
    const done = this.analyse(pending, lane, controller)
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.backoff = true;
        this.set({ phase: "error", lastError: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.inFlight.delete(lane);
        for (const hand of pending) this.inFlightKeys.delete(hand.handKey);
      });
    this.inFlight.set(lane, { controller, done });
  }

  private async analyse(pending: PendingDto[], lane: number, controller: AbortController): Promise<void> {
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
    if (controller.signal.aborted) return;
    this.set({ phase: "running", reason: null, library, month: monthOf(pending[0]?.playedAt ?? "") });
    const started = this.deps.now();
    let result: PageResult;
    try {
      result = await this.deps.analyse(page, villains, library, controller.signal, tournaments, lane);
    } catch (error) {
      // Stopped (a table opened, a pause, quitting): analysed again later.
      if (controller.signal.aborted) return;
      throw error;
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
    this.lanePace.set(lane, page.length / seconds);
    // Every lane at the pace the lanes have shown (one lane: its last page's).
    const paces = [...this.lanePace.values()];
    const pace = (paces.reduce((sum, value) => sum + value, 0) / paces.length) * this.lanes;
    this.set({
      analysed: this.status.analysed + result.rows.length,
      failed: this.failedKeys.size,
      handsPerSecond: pace,
      library: this.reachable,
      lastError: null,
    });
  }
}

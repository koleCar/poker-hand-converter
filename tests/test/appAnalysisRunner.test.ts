/**
 * The desktop app's analysis runner, worker and worker client
 * (docs/RAIL-PLAN.md R5.4, `app/src/analysis/`), with their dependencies
 * faked:
 *
 * - the gate: a closed gate (paused, a table open, a backfill, the
 *   statistics pass) analyses nothing; a table opening stops the page in
 *   flight, which is analysed again after;
 * - the queue: newest first, page by page, each hand once; a wake (new
 *   hands) starts again from the newest; a hand the engine throws on is not
 *   tried again; idle when nothing is left;
 * - offline: a page whose flop library files could not be fetched turns the
 *   library off for the next pages until a probe finds it, then the hands
 *   analysed without it come back;
 * - the opponents' statistics are read from the store for the page's hands;
 * - the worker: its flop library fetches go to the window and back, and an
 *   offline answer fails the next fetches at once without waiting;
 * - the client: a stopped page terminates the worker.
 */
import { describe, expect, it } from "vitest";

import type { PageHand, PageResult } from "../../app/src/analysis/engine";
import type { StoreHandRow } from "../../app/src/analysis/rows";
import {
  AnalysisRunner,
  analysisLanes,
  monthOf,
  nextMonth,
  PAGE,
  type MonthCounts,
  type PendingDto,
  type RunnerCounts,
  type RunnerDeps,
  type RunnerGate,
} from "../../app/src/analysis/runner";
import { BASE, createWorker, OFFLINE_MS, type FetchOutcome, type WorkerRequest, type WorkerResponse } from "../../app/src/analysis/worker";
import { fetchOutcomeOfError, Stopped, workerAnalyser } from "../../app/src/analysis/workerClient";
import { FlopLibraryLoader } from "../../web/src/lib/analysis/index";

const V = "analysis/34";

/** A store of `n` hands, newest first by key order: h000 is the newest (`playedAt` of the i-th, never rising). */
function fakeStore(n: number, playedAt: (i: number) => string = () => "2026-10-01T00:00:00.000Z") {
  const keys = Array.from({ length: n }, (_, i) => `h${String(i).padStart(3, "0")}`);
  const rows = new Map<string, StoreHandRow>();
  const phf = (key: string) =>
    JSON.stringify({ handId: key, meta: { siteId: "pokerstars" }, players: [{ name: "Hero", isHero: true }, { name: `v-${key}`, isHero: false }], actions: [] });
  return {
    keys,
    rows,
    counts(): RunnerCounts {
      const current = [...rows.values()].filter((r) => r.analysis_version === V).length;
      const offline = [...rows.values()].filter((r) => r.analysis_version === V && !r.flop_library).length;
      return { hands: keys.length, current, stale: 0, missing: keys.length - current, offline, notAnalysable: 0 };
    },
    months(): MonthCounts[] {
      const out: MonthCounts[] = [];
      keys.forEach((key, i) => {
        const month = playedAt(i).slice(0, 7);
        let m = out.find((o) => o.month === month);
        if (!m) out.push((m = { month, hands: 0, current: 0 }));
        m.hands += 1;
        if (rows.get(key)?.analysis_version === V) m.current += 1;
      });
      return out;
    },
    pending(after: { playedAt: string; handKey: string } | null, limit: number): PendingDto[] {
      // A cursor without a key: from the first hand played before it (the keyset's order).
      const start = !after ? 0 : after.handKey === "" ? keys.findIndex((_, i) => playedAt(i) < after.playedAt) : keys.indexOf(after.handKey) + 1;
      return keys
        .map((key, i) => ({ handKey: key, playedAt: playedAt(i), phf: phf(key) }))
        .slice(start < 0 ? keys.length : start)
        .filter((hand) => !rows.has(hand.handKey))
        .slice(0, limit);
    },
    offline(limit: number): PendingDto[] {
      return [...rows.values()]
        .filter((r) => !r.flop_library)
        .slice(0, limit)
        .map((r) => ({ handKey: r.hand_key, playedAt: "", phf: phf(r.hand_key) }));
    },
  };
}

/** Let pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function row(handKey: string, flopLibrary: boolean): StoreHandRow {
  return {
    hand_key: handKey,
    analysis_version: V,
    status: "full",
    reason: null,
    hero_seat: 1,
    grade: "good",
    score: 90,
    ev_loss_bb: 0,
    ev_loss_pot: 0,
    approximations: [],
    pot_type: "single-raised",
    flop_library: flopLibrary,
    decisions: [],
  };
}

interface Harness {
  runner: AnalysisRunner;
  store: ReturnType<typeof fakeStore>;
  gate: RunnerGate;
  pages: string[][];
  villainAsks: { site: string; player: string }[][];
  libraryFlags: boolean[];
  probes: number;
  online: boolean;
  /** Keys the engine throws on. */
  broken: Set<string>;
  /** While true, a page waits until its signal fires. */
  hang: boolean;
  /** While true, a page waits until the test finishes it (`finish`). */
  manual: boolean;
  /** The pages waiting to be finished, oldest first: finish one with its lane's result. */
  open: { lane: number; finish: () => void }[];
  /** The lane each page went to. */
  lanesUsed: number[];
  clock: number;
  released: number;
  step(): Promise<void>;
}

function harness(n: number, playedAt?: (i: number) => string, lanes?: number): Harness {
  const store = fakeStore(n, playedAt);
  const h: Harness = {
    runner: null as unknown as AnalysisRunner,
    store,
    gate: { run: true, reason: null, paused: false },
    pages: [],
    villainAsks: [],
    libraryFlags: [],
    probes: 0,
    online: true,
    broken: new Set(),
    hang: false,
    manual: false,
    open: [],
    lanesUsed: [],
    clock: 0,
    released: 0,
    step: () => h.runner.step(),
  };
  const deps: RunnerDeps = {
    lanes,
    gate: async () => h.gate,
    counts: async () => store.counts(),
    months: async () => store.months(),
    pending: async (_version, after, limit) => store.pending(after, limit),
    offline: async (_version, limit) => store.offline(limit),
    reachable: async () => {
      h.probes += 1;
      return h.online;
    },
    villains: async (players) => {
      h.villainAsks.push(players);
      return players.map((p) => ({ ...p, hands: 50, vpipOpp: 50, vpip: 20, pfr: 15 }));
    },
    analyse: (page: PageHand[], _villains, library, signal, _tournaments, lane = 0): Promise<PageResult> => {
      h.pages.push(page.map((hand) => hand.handKey));
      h.lanesUsed.push(lane);
      h.libraryFlags.push(library);
      h.clock += 1000;
      const result = {
        rows: page.filter((hand) => !h.broken.has(hand.handKey)).map((hand) => row(hand.handKey, library && h.online)),
        failed: page.filter((hand) => h.broken.has(hand.handKey)).map((hand) => hand.handKey),
      };
      if (h.manual) {
        return new Promise((resolve, reject) => {
          h.open.push({ lane, finish: () => resolve(result) });
          signal.addEventListener("abort", () => reject(new Stopped()), { once: true });
        });
      }
      if (!h.hang) return Promise.resolve(result);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Stopped()), { once: true }));
    },
    save: async (rows) => {
      for (const r of rows) store.rows.set(r.hand_key, r);
      return { saved: rows.length, missing: 0 };
    },
    sleep: async () => undefined,
    now: () => h.clock,
    release: () => {
      h.released += 1;
    },
  };
  h.runner = new AnalysisRunner(deps, V);
  return h;
}

describe("the analysis runner", () => {
  it("analyses every hand once, newest first, a page at a time, then idles", async () => {
    const h = harness(45);
    for (let i = 0; i < 6; i += 1) await h.step();
    expect(h.pages).toEqual([h.store.keys.slice(0, PAGE), h.store.keys.slice(PAGE, 2 * PAGE), h.store.keys.slice(2 * PAGE)]);
    expect(h.store.rows.size).toBe(45);
    expect(h.runner.current()).toMatchObject({ phase: "idle", analysed: 45, failed: 0 });
    expect(h.runner.current().counts?.missing).toBe(0);
    expect(h.runner.current().handsPerSecond).toBeCloseTo(5, 5);
    // Idle: the worker was let go, once.
    await h.step();
    expect(h.released).toBe(1);
  });

  it("waits while the gate is closed, and a table opening stops the page in flight", async () => {
    const h = harness(30);
    for (const reason of ["paused", "tables", "backfill", "statistics"] as const) {
      h.gate = { run: false, reason, paused: reason === "paused" };
      await h.step();
      expect(h.pages).toEqual([]);
      expect(h.runner.current()).toMatchObject({ phase: "waiting", reason, paused: reason === "paused" });
    }
    h.gate = { run: true, reason: null, paused: false };
    h.hang = true;
    const running = h.step();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.runner.current().phase).toBe("running");
    h.runner.tablesOpen(true);
    await running;
    expect(h.store.rows.size).toBe(0);
    expect(h.runner.current()).toMatchObject({ phase: "waiting", reason: "tables" });
    // Closed again: the same hands, from the newest.
    h.hang = false;
    h.runner.tablesOpen(false);
    await h.step();
    expect(h.pages[1]).toEqual(h.pages[0]);
    expect(h.store.rows.size).toBe(PAGE);
  });

  it("reads the opponents' statistics of the page's hands, each player once a run", async () => {
    const h = harness(25);
    await h.step();
    await h.step();
    const asked = h.villainAsks.flat().map((p) => p.player);
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).toEqual(h.store.keys.map((key) => `v-${key}`));
    expect(h.villainAsks.every((players) => players.every((p) => p.site === "pokerstars"))).toBe(true);
  });

  it("does not try a hand the engine threw on again, and is idle when only those are left", async () => {
    const h = harness(5);
    h.broken.add("h002");
    await h.step();
    expect(h.runner.current().failed).toBe(1);
    await h.step();
    await h.step();
    expect(h.pages).toEqual([h.store.keys]);
    expect(h.runner.current().phase).toBe("idle");
  });

  it("starts again from the newest hands when woken", async () => {
    const h = harness(50);
    await h.step();
    // New hands arrive "above" the cursor: a wake reads from the newest again.
    h.store.keys.unshift("new1", "new0");
    h.runner.wake();
    await h.step();
    expect(h.pages[1].slice(0, 2)).toEqual(["new1", "new0"]);
  });

  it("goes month by month, newest first, says which month, and sends a chosen month to the front", async () => {
    // h000-h014 November, h015-h034 October, h035-h049 September.
    const h = harness(50, (i) => (i < 15 ? "2026-11-20T10:00:00.000Z" : i < 35 ? "2026-10-20T10:00:00.000Z" : "2026-09-20T10:00:00.000Z"));
    await h.step();
    expect(h.pages[0]).toEqual(h.store.keys.slice(0, PAGE));
    expect(h.runner.current()).toMatchObject({ month: "2026-11", focus: null });
    expect(h.runner.current().months).toEqual([
      { month: "2026-11", hands: 15, current: 0 },
      { month: "2026-10", hands: 20, current: 0 },
      { month: "2026-09", hands: 15, current: 0 },
    ]);
    // September to the front: its hands, then newest first again.
    h.runner.focus("2026-09");
    expect(h.runner.current().focus).toBe("2026-09");
    await h.step();
    expect(h.pages[1]).toEqual(h.store.keys.slice(35));
    expect(h.runner.current().month).toBe("2026-09");
    await h.step();
    expect(h.runner.current().focus).toBeNull();
    await h.step();
    expect(h.pages[2]).toEqual(h.store.keys.slice(PAGE, 35));
    expect(h.runner.current().month).toBe("2026-10");
    expect(h.runner.current().months?.find((m) => m.month === "2026-09")).toEqual({ month: "2026-09", hands: 15, current: 15 });
    await h.step();
    expect(h.runner.current().months?.every((m) => m.current === m.hands)).toBe(true);
    // Not a month: ignored.
    h.runner.focus("soon");
    expect(h.runner.current().focus).toBeNull();
    expect(monthOf("")).toBe("");
    expect(monthOf("2026-03-01T00:00:00.000Z")).toBe("2026-03");
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-09")).toBe("2026-10");
  });

  it("keeps a page on every worker, never the same hand twice, and a slow page holds up its own worker only", async () => {
    const h = harness(100, undefined, 3);
    h.manual = true;
    // Three pages start, one per worker, without waiting for each other.
    await h.step();
    await h.step();
    const third = h.step();
    await flush();
    expect(h.pages).toEqual([h.store.keys.slice(0, 20), h.store.keys.slice(20, 40), h.store.keys.slice(40, 60)]);
    expect(h.lanesUsed).toEqual([0, 1, 2]);
    expect(h.runner.current().phase).toBe("running");
    // Every worker busy: the turn waits. The second page (lane 1) is done first; the first is the slow one.
    h.open.splice(1, 1)[0]!.finish();
    await third;
    expect(h.store.rows.size).toBe(PAGE);
    const fourth = h.step();
    await flush();
    expect(h.lanesUsed[3]).toBe(1);
    expect(h.pages[3]).toEqual(h.store.keys.slice(60, 80));
    // Lane 2 done; the slow first page (lane 0) and lane 1's are still in flight.
    h.open.find((page) => page.lane === 2)!.finish();
    await fourth;
    h.open = h.open.filter((page) => page.lane !== 2);
    // Woken (new hands): the walk starts from the newest again, but the hands in flight are not read twice.
    h.runner.wake();
    await h.step();
    await h.step();
    const fifth = h.step();
    await flush();
    expect(h.pages[4]).toEqual(h.store.keys.slice(80, 100));
    expect(h.lanesUsed[4]).toBe(2);
    const seen = h.pages.flat();
    expect(new Set(seen).size).toBe(seen.length);
    h.open.find((page) => page.lane === 2)!.finish();
    await fifth;
    h.open = h.open.filter((page) => page.lane !== 2);
    // A table opens: every page in flight stops; they come back later.
    h.runner.tablesOpen(true);
    await flush();
    expect(h.runner.current()).toMatchObject({ phase: "waiting", reason: "tables" });
    h.manual = false;
    h.runner.tablesOpen(false);
    for (let i = 0; i < 12; i += 1) await h.step();
    expect(h.store.rows.size).toBe(100);
    expect(h.runner.current().phase).toBe("idle");
    // Three lanes at a page a second: three pages' hands a second.
    expect(h.runner.current().handsPerSecond).toBeGreaterThan(20);
  });

  it("uses half the cores for workers, at most four, at least one", () => {
    expect([1, 2, 4, 8, 10, 16].map((cores) => analysisLanes(cores))).toEqual([1, 1, 2, 4, 4, 4]);
  });

  it("goes without the flop library while it cannot be reached, then analyses those hands again", async () => {
    const h = harness(60);
    h.online = false;
    await h.step(); // tried with the library; the files could not be fetched
    expect(h.libraryFlags).toEqual([true]);
    await h.step();
    await h.step();
    expect(h.libraryFlags).toEqual([true, false, false]);
    expect(h.probes).toBe(0);
    expect(h.runner.current().library).toBe(false);
    expect(h.store.counts().offline).toBe(60);
    // Nothing missing, offline rows waiting: no probe before its time.
    await h.step();
    expect(h.runner.current().phase).toBe("idle");
    expect(h.probes).toBe(0);
    h.clock += 10 * 60_000;
    h.online = true;
    await h.step();
    expect(h.probes).toBe(1);
    expect(h.libraryFlags.at(-1)).toBe(true);
    for (let i = 0; i < 4; i += 1) await h.step();
    expect(h.store.counts().offline).toBe(0);
    expect(h.runner.current().library).toBe(true);
  });
});

describe("the analysis worker", () => {
  /** A worker over a fake scope; `answers` are the window's replies to its fetches, in order. */
  function worker(answers: FetchOutcome[], clock: () => number) {
    const asked: string[] = [];
    const scope = {
      onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
      postMessage(message: WorkerResponse) {
        if (message.type !== "fetch") return;
        asked.push(message.path);
        const outcome = answers.shift() ?? { kind: "absent" };
        setTimeout(() => scope.onmessage?.({ data: { type: "fetched", reqId: message.reqId, outcome } } as MessageEvent<WorkerRequest>), 0);
      },
    };
    const bridge = createWorker(scope, clock);
    return { asked, bridge };
  }

  it("asks the window for the flop library's files and reads its answers", async () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ entries: [{ line: "btn-bb", flop: "Ts7h4d" }] }));
    const { asked, bridge } = worker(
      [{ kind: "bytes", bytes: manifest.buffer.slice(0) as ArrayBuffer }, { kind: "absent" }, { kind: "transient", status: 429 }],
      () => 0,
    );
    const ok = await bridge.fetch(`${BASE}/nlhe-cash-6max-100bb/flop-m1/manifest.json`);
    expect(ok.ok).toBe(true);
    expect(await ok.json()).toEqual({ entries: [{ line: "btn-bb", flop: "Ts7h4d" }] });
    const absent = await bridge.fetch(`${BASE}/nlhe-cash-6max-100bb/flop-m1/btn-bb/2c3c4c.bin`);
    expect([absent.ok, absent.status]).toEqual([false, 404]);
    expect(bridge.failures()).toBe(0);
    const busy = await bridge.fetch(`${BASE}/nlhe-cash-6max-100bb/flop-m1/btn-bb/2c3c4c.bin`);
    expect([busy.ok, busy.status]).toEqual([false, 429]);
    expect(bridge.failures()).toBe(1);
    expect(asked).toEqual([
      "nlhe-cash-6max-100bb/flop-m1/manifest.json",
      "nlhe-cash-6max-100bb/flop-m1/btn-bb/2c3c4c.bin",
      "nlhe-cash-6max-100bb/flop-m1/btn-bb/2c3c4c.bin",
    ]);
  });

  it("fails every fetch at once for a minute after an offline answer", async () => {
    let now = 0;
    const { asked, bridge } = worker([{ kind: "offline" }], () => now);
    await expect(bridge.fetch(`${BASE}/s/t/manifest.json`)).rejects.toThrow("offline");
    expect(bridge.failures()).toBe(1);
    // Within the minute: refused without asking the window.
    now += OFFLINE_MS - 1;
    await expect(bridge.fetch(`${BASE}/s/t/manifest.json`)).rejects.toThrow("offline");
    expect(asked).toHaveLength(1);
    // After it: asked again.
    now += 1;
    const again = await bridge.fetch(`${BASE}/s/t/manifest.json`);
    expect(again.status).toBe(404);
    expect(asked).toHaveLength(2);
  });

  it("a loader over a refusing fetch gives up after its tries without waiting (the worker's offline sleep)", async () => {
    let calls = 0;
    const started = Date.now();
    const loader = new FlopLibraryLoader(
      BASE,
      async () => {
        calls += 1;
        throw new Error("offline");
      },
      undefined,
      // A set published for this loader only: none is since analysis/41, and then nothing is fetched at all.
      { sleep: () => Promise.resolve(), sets: ["nlhe-cash-6max-100bb"] },
    );
    expect(await loader.ready("nlhe-cash-6max-100bb")).toBe(false);
    expect(calls).toBe(4);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("the worker client", () => {
  class FakeWorker {
    onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    posted: unknown[] = [];
    postMessage(message: unknown) {
      this.posted.push(message);
      const request = message as WorkerRequest;
      if (request.type === "analyse") {
        // Ask for a file first, then answer once it came back.
        setTimeout(() => this.onmessage?.({ data: { type: "fetch", reqId: 7, path: "s/t/manifest.json" } } as MessageEvent<WorkerResponse>), 0);
      }
      if (request.type === "fetched") {
        const job = (this.posted.find((m) => (m as WorkerRequest).type === "analyse") as { jobId: number }).jobId;
        setTimeout(() => this.onmessage?.({ data: { type: "analysed", jobId: job, rows: [], failed: [] } } as unknown as MessageEvent<WorkerResponse>), 0);
      }
    }
    terminate() {
      this.terminated = true;
    }
  }

  it("answers the worker's fetches and returns the page", async () => {
    const made: FakeWorker[] = [];
    const fetched: string[] = [];
    const client = workerAnalyser(
      async (path) => {
        fetched.push(path);
        return { kind: "absent" };
      },
      () => {
        const w = new FakeWorker();
        made.push(w);
        return w as unknown as Worker;
      },
    );
    const result = await client.analyse([], null, true);
    expect(result).toEqual({ rows: [], failed: [] });
    expect(fetched).toEqual(["s/t/manifest.json"]);
    expect(made[0].posted.some((m) => (m as WorkerRequest).type === "fetched")).toBe(true);
  });

  it("terminates the worker when the page is stopped", async () => {
    const made: FakeWorker[] = [];
    const client = workerAnalyser(
      () => new Promise<FetchOutcome>(() => undefined),
      () => {
        const w = new FakeWorker();
        made.push(w);
        return w as unknown as Worker;
      },
    );
    const controller = new AbortController();
    const page = client.analyse([], null, true, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(page).rejects.toBeInstanceOf(Stopped);
    expect(made[0].terminated).toBe(true);
    // The next page makes a new worker.
    void client.analyse([], null, true).catch(() => undefined);
    expect(made).toHaveLength(2);
  });

  it("reads Rust's rejections", () => {
    expect(fetchOutcomeOfError("absent")).toEqual({ kind: "absent" });
    expect(fetchOutcomeOfError("transient:429")).toEqual({ kind: "transient", status: 429 });
    expect(fetchOutcomeOfError("offline")).toEqual({ kind: "offline" });
    expect(fetchOutcomeOfError("the flop library is off")).toEqual({ kind: "offline" });
  });
});

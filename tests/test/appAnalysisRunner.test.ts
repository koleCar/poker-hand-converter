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
import { AnalysisRunner, PAGE, type PendingDto, type RunnerCounts, type RunnerDeps, type RunnerGate } from "../../app/src/analysis/runner";
import { BASE, createWorker, OFFLINE_MS, type FetchOutcome, type WorkerRequest, type WorkerResponse } from "../../app/src/analysis/worker";
import { fetchOutcomeOfError, Stopped, workerAnalyser } from "../../app/src/analysis/workerClient";
import { FlopLibraryLoader } from "../../web/src/lib/analysis/index";

const V = "analysis/34";

/** A store of `n` hands, newest first by key order: h000 is the newest. */
function fakeStore(n: number) {
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
    pending(after: { playedAt: string; handKey: string } | null, limit: number): PendingDto[] {
      const start = after ? keys.indexOf(after.handKey) + 1 : 0;
      return keys
        .slice(start)
        .filter((key) => !rows.has(key))
        .slice(0, limit)
        .map((key) => ({ handKey: key, playedAt: "2026-10-01T00:00:00.000Z", phf: phf(key) }));
    },
    offline(limit: number): PendingDto[] {
      return [...rows.values()]
        .filter((r) => !r.flop_library)
        .slice(0, limit)
        .map((r) => ({ handKey: r.hand_key, playedAt: "", phf: phf(r.hand_key) }));
    },
  };
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
  clock: number;
  released: number;
  step(): Promise<void>;
}

function harness(n: number): Harness {
  const store = fakeStore(n);
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
    clock: 0,
    released: 0,
    step: () => h.runner.step(),
  };
  const deps: RunnerDeps = {
    gate: async () => h.gate,
    counts: async () => store.counts(),
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
    analyse: (page: PageHand[], _villains, library, signal): Promise<PageResult> => {
      h.pages.push(page.map((hand) => hand.handKey));
      h.libraryFlags.push(library);
      h.clock += 1000;
      const result = {
        rows: page.filter((hand) => !h.broken.has(hand.handKey)).map((hand) => row(hand.handKey, library && h.online)),
        failed: page.filter((hand) => h.broken.has(hand.handKey)).map((hand) => hand.handKey),
      };
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
      { sleep: () => Promise.resolve() },
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

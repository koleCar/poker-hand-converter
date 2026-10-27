/**
 * Bulk upload, the saving side (docs/RAIL-PLAN.md R4.2): the chunked,
 * retried, resumable save (`web/src/components/converter/bulkSaver.ts`),
 * its manifest (`uploadManifest.ts`) and the calls it makes
 * (`web/src/lib/db/upload.ts`), against a fake server and a fake
 * Supabase client.
 */

import { describe, expect, it, vi } from "vitest";

import { createBulkSaver, ingestRowOf, type SaverOptions } from "../../web/src/components/converter/bulkSaver";
import type { SourceInfo } from "../../web/src/components/converter/bulkRun";
import type { StreamBatch } from "../../web/src/components/converter/pipeline";
import {
  isSameUpload,
  memoryManifestStore,
  newManifest,
  resumeStateOf,
} from "../../web/src/components/converter/uploadManifest";
import {
  classifyFailure,
  createUploadApi,
  UploadError,
  type IngestRow,
  type UploadApi,
  type UploadClient,
  type UploadErrorKind,
} from "../../web/src/lib/db/upload";
import type { ConversionFailure } from "../../web/src/lib/phf/detect";
import type { PhfHand } from "../../web/src/lib/phf/types";

/* ------------------------------------------------------------- fixtures - */

function hand(id: string): PhfHand {
  return {
    schema: "phf/1",
    meta: { siteId: "weplay", siteName: "WePlay", handId: id, handKey: id, rawText: `Weplay Hand #${id}\nthe original text` },
  } as unknown as PhfHand;
}

function failure(id: string): ConversionFailure {
  return { fingerprint: `fp-${id}`, rawText: `junk ${id}`, reason: "unknown-site" } as unknown as ConversionFailure;
}

/** Batches of `size` hands for a source, as the worker posts them. */
function batches(key: string, sourceId: string, total: number, size: number, prefix = key): StreamBatch[] {
  const out: StreamBatch[] = [];
  for (let start = 0, index = 0; start < total; start += size, index += 1) {
    const hands = Array.from({ length: Math.min(size, total - start) }, (_, i) => hand(`${prefix}-${start + i}`));
    out.push({ sourceId, key, index, last: start + size >= total, hands, failures: [], done: start + hands.length, total });
  }
  return out;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An `ingest_hands` and Storage that behave like the real ones, with scripted failures. */
function fakeServer() {
  const stored = new Map<string, IngestRow>();
  const objects = new Map<string, Blob>();
  const calls: IngestRow[][] = [];
  const failures: Array<UploadError | null> = [];
  const originalFailures: Array<UploadError | null> = [];
  let registered = 0;
  let gate: Promise<void> | null = null;
  let originalGate: Promise<void> | null = null;
  const recorded: ConversionFailure[][] = [];
  const api: UploadApi = {
    userId: async () => "user-1",
    registerWebSource: async () => {
      registered += 1;
      return `source-${registered}`;
    },
    ingest: async (_source, rows) => {
      if (gate) await gate;
      const scripted = failures.shift();
      if (scripted) throw scripted;
      calls.push(rows);
      const report = { received: rows.length, inserted: 0, duplicates: 0, rejected: 0, rows: [] as Array<{ handKey: string; status: "inserted" | "duplicate" | "rejected"; reason?: string }> };
      for (const row of rows) {
        const phf = row.phf as { meta: { rawText: string; handKey: string } };
        if (phf.meta.rawText !== "") {
          report.rejected += 1;
          report.rows.push({ handKey: row.hand_key, status: "rejected", reason: "raw-text" });
        } else if (phf.meta.handKey.startsWith("bad")) {
          report.rejected += 1;
          report.rows.push({ handKey: row.hand_key, status: "rejected", reason: "invalid" });
        } else if (stored.has(row.hand_key)) {
          report.duplicates += 1;
          report.rows.push({ handKey: row.hand_key, status: "duplicate" });
        } else {
          stored.set(row.hand_key, row);
          report.inserted += 1;
          report.rows.push({ handKey: row.hand_key, status: "inserted" });
        }
      }
      return report;
    },
    storeOriginal: async (path, blob) => {
      if (originalGate) await originalGate;
      const scripted = originalFailures.shift();
      if (scripted) throw scripted;
      if (objects.has(path)) return "exists";
      objects.set(path, blob);
      return "stored";
    },
    recordFailures: async (batch) => {
      recorded.push(batch);
      return { created: batch.length, updated: 0 };
    },
  };
  return {
    api,
    stored,
    objects,
    calls,
    failures,
    originalFailures,
    recorded,
    registered: () => registered,
    setGate: (p: Promise<void> | null) => {
      gate = p;
    },
    setOriginalGate: (p: Promise<void> | null) => {
      originalGate = p;
    },
  };
}

function saverFor(server: ReturnType<typeof fakeServer>, overrides: Partial<SaverOptions> = {}) {
  const store = overrides.store === undefined ? memoryManifestStore() : overrides.store;
  const manifest = overrides.manifest ?? newManifest("user-1", [{ path: "export.zip", size: 1000 }], false, "upload-1");
  const acks: number[] = [];
  const sleeps: number[] = [];
  const states: string[] = [];
  const saver = createBulkSaver({
    api: server.api,
    store,
    manifest,
    userId: "user-1",
    ack: (n) => acks.push(n),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    now: () => 0,
    onChange: (p) => {
      if (states.at(-1) !== p.state) states.push(p.state);
    },
    ...overrides,
  });
  return { saver, store, manifest, acks, sleeps, states };
}

const transient = () => new UploadError("transient", "fetch failed");

/* ------------------------------------------------------------ the saver - */

describe("the bulk save", () => {
  it("saves in bounded calls, without the original text, and reports what the server did", async () => {
    const server = fakeServer();
    const { saver } = saverFor(server, { maxHandsPerCall: 50 });
    for (const batch of batches("k1", "s1", 120, 40)) saver.addBatch(batch);
    saver.endSource("k1");
    saver.close();
    const done = await saver.idle();
    expect(done.state).toBe("done");
    expect(done.inserted).toBe(120);
    expect(server.calls.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(server.calls.flat().every((row) => (row.phf as PhfHand).meta.rawText === "")).toBe(true);
    expect(server.calls.flat()[0].hand_key).toBe("weplay:k1-0");
  });

  it("keeps each call under the byte limit too", async () => {
    const server = fakeServer();
    const rowBytes = JSON.stringify(ingestRowOf(hand("k1-0"))).length;
    const { saver } = saverFor(server, { maxHandsPerCall: 250, maxBytesPerCall: rowBytes * 7 + 3 });
    for (const batch of batches("k1", "s1", 30, 10)) saver.addBatch(batch);
    saver.close();
    await saver.idle();
    expect(Math.max(...server.calls.map((c) => c.length))).toBe(7);
    expect(server.stored.size).toBe(30);
  });

  it("re-uploading the same file inserts nothing: every hand is a duplicate", async () => {
    const server = fakeServer();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { saver } = saverFor(server);
      for (const batch of batches("k1", "s1", 300, 100)) saver.addBatch(batch);
      saver.close();
      const done = await saver.idle();
      expect([done.inserted, done.duplicates]).toEqual(attempt === 0 ? [300, 0] : [0, 300]);
    }
    expect(server.stored.size).toBe(300);
  });

  it("holds the converter back while the queue is full", async () => {
    const server = fakeServer();
    const gate = deferred();
    server.setGate(gate.promise);
    const { saver, acks } = saverFor(server, { maxHandsPerCall: 50, maxQueuedHands: 100 });
    const all = batches("k1", "s1", 200, 40);
    saver.addBatch(all[0]);
    saver.addBatch(all[1]);
    expect(acks).toEqual([1, 1]);
    saver.addBatch(all[2]); // 120 queued: no room
    saver.addBatch(all[3]);
    expect(acks).toEqual([1, 1]);
    expect(saver.progress().queued).toBe(160);
    server.setGate(null);
    gate.resolve();
    saver.addBatch(all[4]);
    saver.close();
    await saver.idle();
    // Every batch acknowledged in the end, and only once there was room.
    expect(acks.reduce((a, b) => a + b, 0)).toBe(5);
    expect(server.stored.size).toBe(200);
  });

  it("retries a transient failure with exponential backoff", async () => {
    const server = fakeServer();
    server.failures.push(transient(), transient(), null);
    const { saver, sleeps, states } = saverFor(server, { retry: { baseMs: 1000, maxMs: 30_000, attempts: 6 } });
    for (const batch of batches("k1", "s1", 100, 100)) saver.addBatch(batch);
    saver.close();
    const done = await saver.idle();
    expect(sleeps).toEqual([1000, 2000]);
    expect(states).toContain("retrying");
    expect(done.state).toBe("done");
    expect(done.inserted).toBe(100);
  });

  it("pauses when the retries run out, keeps everything queued, and resumes", async () => {
    const server = fakeServer();
    server.failures.push(transient(), transient(), transient());
    const { saver, acks } = saverFor(server, { retry: { baseMs: 10, maxMs: 100, attempts: 2 }, maxQueuedHands: 50 });
    for (const batch of batches("k1", "s1", 100, 50)) saver.addBatch(batch);
    const paused = await saver.idle();
    expect(paused).toMatchObject({ state: "paused", pauseReason: "offline", queued: 100, inserted: 0 });
    // A full queue: neither batch acknowledged while paused.
    expect(acks.reduce((a, b) => a + b, 0)).toBe(0);
    saver.resume();
    saver.close();
    const done = await saver.idle();
    expect(done).toMatchObject({ state: "done", inserted: 100, queued: 0 });
    expect(acks.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("waits out the account's 10-minute budget, pauses on its daily one or a lost session", async () => {
    const server = fakeServer();
    server.failures.push(new UploadError("rate-limited", "desktop_ingest:"), null);
    const first = saverFor(server, { budgetWaitMs: 60_000 });
    first.saver.addBatch(batches("k1", "s1", 10, 10)[0]);
    first.saver.close();
    expect(await first.saver.idle()).toMatchObject({ state: "done", inserted: 10 });
    expect(first.sleeps).toEqual([60_000]);
    expect(first.states).toContain("waiting-budget");

    for (const [kind, reason] of [["rate-limited-day", "day-budget"], ["signed-out", "signed-out"]] as Array<[UploadErrorKind, string]>) {
      server.failures.push(new UploadError(kind, kind));
      const { saver } = saverFor(server);
      saver.addBatch(batches(`k-${kind}`, "s1", 10, 10)[0]);
      expect(await saver.idle()).toMatchObject({ state: "paused", pauseReason: reason });
    }
  });

  it("counts a refused call's rows as refused and carries on", async () => {
    const server = fakeServer();
    server.failures.push(new UploadError("refused", "ingest_hands: bad request"));
    const { saver } = saverFor(server, { maxHandsPerCall: 10 });
    for (const batch of batches("k1", "s1", 30, 10)) saver.addBatch(batch);
    saver.close();
    const done = await saver.idle();
    expect(done).toMatchObject({ state: "done", inserted: 20, refused: 10, refusedReasons: { call: 10 } });
    expect(done.lastError).toMatch(/bad request/);
  });

  it("counts rows the server rejects, by reason", async () => {
    const server = fakeServer();
    const { saver } = saverFor(server);
    saver.addBatch({ ...batches("k1", "s1", 5, 5)[0], hands: [hand("ok-1"), hand("bad-1"), hand("bad-2"), hand("ok-2")] });
    saver.close();
    expect(await saver.idle()).toMatchObject({ inserted: 2, refused: 2, refusedReasons: { invalid: 2 } });
  });

  it("registers the web source again when the server has lost it", async () => {
    const server = fakeServer();
    server.failures.push(new UploadError("unknown-source", "No hand source"));
    const { saver } = saverFor(server);
    saver.addBatch(batches("k1", "s1", 10, 10)[0]);
    saver.close();
    expect(await saver.idle()).toMatchObject({ state: "done", inserted: 10 });
    expect(server.registered()).toBe(2);
  });

  it("records the refused hands in the corpus, a bounded sample of them", async () => {
    const server = fakeServer();
    const { saver } = saverFor(server, { maxFailures: 250 });
    const batch = batches("k1", "s1", 10, 10)[0];
    saver.addBatch({ ...batch, failures: Array.from({ length: 300 }, (_, i) => failure(String(i))) });
    saver.close();
    const done = await saver.idle();
    expect(server.recorded.map((b) => b.length)).toEqual([200, 50]);
    expect(done.failuresRecorded).toEqual({ created: 250, updated: 0 });
  });
});

/* -------------------------------------------------------------- resume - */

describe("resuming an upload", () => {
  it("records per source the batches stored and when it is done; a finished upload is forgotten", async () => {
    const server = fakeServer();
    // Calls of 40: A's three batches, then B's first; then the session ends.
    server.failures.push(null, null, null, null, new UploadError("signed-out", "JWT expired"));
    const { saver, store, manifest } = saverFor(server, { maxHandsPerCall: 40 });
    for (const batch of batches("A", "a", 120, 40)) saver.addBatch(batch);
    saver.endSource("A");
    for (const batch of batches("B", "b", 80, 40)) saver.addBatch(batch);
    const paused = await saver.idle();
    expect(paused).toMatchObject({ state: "paused", pauseReason: "signed-out", inserted: 160, sourcesDone: 1 });

    const records = await store!.sources(manifest.id);
    expect(resumeStateOf(records)).toEqual({ done: ["A"], batches: [["B", 1]] });
    const saved = await store!.latest("user-1");
    expect(saved).toMatchObject({ id: "upload-1", finished: false, counts: { inserted: 160, sourcesDone: 1 } });

    saver.resume();
    saver.endSource("B");
    saver.close();
    expect(await saver.idle()).toMatchObject({ state: "done", inserted: 200 });
    expect(await store!.latest("user-1")).toBeNull();
    expect(await store!.sources(manifest.id)).toEqual([]);
  });

  it("a resumed run picks up the counts, and its repeats are duplicates, never copies", async () => {
    const server = fakeServer();
    const store = memoryManifestStore();
    const manifest = newManifest("user-1", [{ path: "export.zip", size: 1000 }], false, "upload-1");
    server.failures.push(null, new UploadError("rate-limited-day", "desktop_ingest_day:"));
    const first = saverFor(server, { store, manifest, maxHandsPerCall: 50 });
    for (const batch of batches("A", "a", 100, 50)) first.saver.addBatch(batch);
    expect(await first.saver.idle()).toMatchObject({ state: "paused", inserted: 50 });

    // The next day, the same files again: the worker skips batch 0 of A.
    const resumed = (await store.latest("user-1"))!;
    expect(isSameUpload(resumed, [{ path: "export.zip", size: 1000 }])).toBe(true);
    expect(isSameUpload(resumed, [{ path: "export.zip", size: 999 }])).toBe(false);
    expect(resumeStateOf(await store.sources(resumed.id)).batches).toEqual([["A", 1]]);
    const second = saverFor(server, { store, manifest: resumed, maxHandsPerCall: 50 });
    // Even a batch sent again (the resume record is an optimisation) is harmless.
    for (const batch of batches("A", "a", 100, 50)) second.saver.addBatch(batch);
    second.saver.endSource("A");
    second.saver.close();
    expect(await second.saver.idle()).toMatchObject({ state: "done", inserted: 100, duplicates: 50 });
    expect(server.stored.size).toBe(100);
  });
});

/* ----------------------------------------------------------- originals - */

describe("kept originals (A2's opt-in)", () => {
  const source = (key: string, path: string, text = "the original"): SourceInfo => ({
    id: `id-${key}`,
    key,
    name: path,
    bytes: text.length,
    encoding: "UTF-8",
    original: { path, blob: new Blob([text]) },
  });

  it("go under <uid>/<upload id>/, and a source is done only once its original is stored", async () => {
    const server = fakeServer();
    const gate = deferred();
    server.setOriginalGate(gate.promise);
    const { saver, store, manifest } = saverFor(server);
    saver.addSource(source("A", "export.zip/a.txt.0000.gz"));
    for (const batch of batches("A", "a", 10, 10)) saver.addBatch(batch);
    saver.endSource("A");
    await vi.waitFor(() => expect(server.stored.size).toBe(10));
    expect((await store!.sources(manifest.id)).find((r) => r.key === "A")?.done ?? false).toBe(false);
    server.setOriginalGate(null);
    gate.resolve();
    saver.close();
    const done = await saver.idle();
    expect(done).toMatchObject({ originalsStored: 1, sourcesDone: 1 });
    expect([...server.objects.keys()]).toEqual(["user-1/upload-1/export.zip/a.txt.0000.gz"]);
  });

  it("an original already stored by an earlier attempt counts as stored", async () => {
    const server = fakeServer();
    server.objects.set("user-1/upload-1/a.gz", new Blob(["x"]));
    const { saver } = saverFor(server);
    saver.addSource(source("A", "a.gz"));
    saver.endSource("A");
    saver.close();
    expect(await saver.idle()).toMatchObject({ originalsStored: 1, originalsFailed: 0, sourcesDone: 1 });
  });

  it("an original the server refuses does not hold the hands up", async () => {
    const server = fakeServer();
    server.originalFailures.push(new UploadError("refused", "storage: Payload too large"));
    const { saver } = saverFor(server);
    saver.addSource(source("A", "a.gz"));
    for (const batch of batches("A", "a", 10, 10)) saver.addBatch(batch);
    saver.endSource("A");
    saver.close();
    expect(await saver.idle()).toMatchObject({ state: "done", inserted: 10, originalsStored: 0, originalsFailed: 1, sourcesDone: 1 });
  });
});

/* ------------------------------------------------------------ the calls - */

describe("the calls and their failures", () => {
  it("classifies failures the way the desktop's sync does", () => {
    expect(classifyFailure("53400", 400, 'Write rate limit exceeded for bucket "desktop_ingest:u"')).toBe("rate-limited");
    expect(classifyFailure("53400", 400, 'Write rate limit exceeded for bucket "desktop_ingest_day:u"')).toBe("rate-limited-day");
    expect(classifyFailure("42501", 403, "You must be signed in")).toBe("signed-out");
    expect(classifyFailure("PGRST301", 401, "JWT expired")).toBe("signed-out");
    expect(classifyFailure("23503", 409, "No hand source")).toBe("unknown-source");
    expect(classifyFailure("57014", 500, "canceling statement due to statement timeout")).toBe("transient");
    expect(classifyFailure("", 0, "TypeError: fetch failed")).toBe("transient");
    expect(classifyFailure(null, 502, "Bad gateway")).toBe("transient");
    expect(classifyFailure(null, 429, "Too many requests")).toBe("transient");
    expect(classifyFailure("22023", 400, "ingest_hands accepts at most 500 hands")).toBe("refused");
  });

  function fakeClient(answers: {
    rpc?: (fn: string, args: Record<string, unknown>) => unknown;
    upload?: (path: string) => unknown;
  }) {
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const uploads: Array<[string, string, Record<string, unknown>, string]> = [];
    const client: UploadClient = {
      auth: { getSession: async () => ({ data: { session: { user: { id: "user-1" } } } }) },
      rpc: async (fn, args) => {
        rpcCalls.push([fn, args]);
        return answers.rpc!(fn, args) as Awaited<ReturnType<UploadClient["rpc"]>>;
      },
      storage: {
        from: (bucket) => ({
          upload: async (path, body, options) => {
            uploads.push([bucket, path, options, body.type]);
            return answers.upload!(path) as Awaited<ReturnType<ReturnType<UploadClient["storage"]["from"]>["upload"]>>;
          },
        }),
      },
    };
    return { api: createUploadApi(client), rpcCalls, uploads };
  }

  it("sends rows to ingest_hands from the web source and reads its report", async () => {
    const report = { received: 1, inserted: 1, duplicates: 0, rejected: 0, rows: [{ handKey: "weplay:1", status: "inserted" }] };
    const { api, rpcCalls } = fakeClient({
      rpc: (fn) => (fn === "register_web_hand_source" ? { data: "src-9", error: null, status: 200 } : { data: report, error: null, status: 200 }),
    });
    expect(await api.userId()).toBe("user-1");
    expect(await api.registerWebSource()).toBe("src-9");
    expect(await api.ingest("src-9", [ingestRowOf(hand("1"))])).toEqual(report);
    expect(rpcCalls.map(([fn]) => fn)).toEqual(["register_web_hand_source", "ingest_hands"]);
    expect(rpcCalls[1][1]).toMatchObject({ p_source: "src-9" });
  });

  it("turns errors and dropped connections into the right kind", async () => {
    const cases: Array<[unknown, UploadErrorKind]> = [
      [{ data: null, error: { code: "53400", message: 'bucket "desktop_ingest_day:u"' }, status: 400 }, "rate-limited-day"],
      [{ data: null, error: { code: "57014", message: "timeout" }, status: 500 }, "transient"],
      [{ data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 }, "transient"],
      [{ data: null, error: { code: "22023", message: "too many" }, status: 400 }, "refused"],
      [{ data: { not: "a report" }, error: null, status: 200 }, "transient"],
    ];
    for (const [answer, kind] of cases) {
      const { api } = fakeClient({ rpc: () => answer });
      await expect(api.ingest("s", [])).rejects.toMatchObject({ kind });
    }
    const { api } = fakeClient({
      rpc: () => {
        throw new TypeError("network down");
      },
    });
    await expect(api.ingest("s", [])).rejects.toMatchObject({ kind: "transient" });
    await expect(api.registerWebSource()).rejects.toMatchObject({ kind: "transient" });
  });

  it("stores an original privately as gzip, without overwriting; an existing object is success", async () => {
    const answers: Record<string, unknown> = {
      "u/1/new.gz": { data: { path: "u/1/new.gz" }, error: null },
      "u/1/old.gz": { data: null, error: Object.assign(new Error("The resource already exists"), { status: 400, statusCode: "409" }) },
      "u/1/big.gz": { data: null, error: Object.assign(new Error("Payload too large"), { status: 413, statusCode: "413" }) },
      "u/1/rls.gz": { data: null, error: Object.assign(new Error("new row violates row-level security policy"), { status: 400, statusCode: "403" }) },
      "u/1/down.gz": { data: null, error: Object.assign(new Error("fetch failed"), { name: "StorageUnknownError" }) },
    };
    const { api, uploads } = fakeClient({ upload: (path) => answers[path] });
    const blob = new Blob(["x"]);
    expect(await api.storeOriginal("u/1/new.gz", blob)).toBe("stored");
    expect(await api.storeOriginal("u/1/old.gz", blob)).toBe("exists");
    await expect(api.storeOriginal("u/1/big.gz", blob)).rejects.toMatchObject({ kind: "refused" });
    await expect(api.storeOriginal("u/1/rls.gz", blob)).rejects.toMatchObject({ kind: "refused" });
    await expect(api.storeOriginal("u/1/down.gz", blob)).rejects.toMatchObject({ kind: "transient" });
    // storage-js sends a Blob with its own type: an untyped one would be refused by the bucket.
    expect(uploads[0]).toEqual(["hand-uploads", "u/1/new.gz", { contentType: "application/gzip", upsert: false, cacheControl: "3600" }, "application/gzip"]);
  });
});

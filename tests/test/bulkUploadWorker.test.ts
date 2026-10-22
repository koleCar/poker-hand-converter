/**
 * Bulk upload through the conversion worker (docs/RAIL-PLAN.md R4.2): the
 * `bulk` request reads a dropped zip itself, converts with the committed
 * WebAssembly core exactly as the R4.1 pipeline does, and never runs more
 * than its window of batches ahead of the page's acknowledgements.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkerRequest, WorkerResponse } from "../../frontend/src/workers/convert.worker";
import { resetConversionEngine, wasmEngine, type ConversionEngine } from "../../frontend/src/lib/wasm/engine";
import { diskFetch, loadWebCore, pipelineRun, plain } from "./support/webConversion";
import { buildZip, file } from "./support/zipWriter";
import { decodeSource } from "../../frontend/src/components/converter/inputs";

const sample = (path: string) => readFileSync(new URL(`../../fixtures/samples/${path}`, import.meta.url));
const STARS = sample("pokerstars/28-cash-multi-hand-file-no-blank-separator.txt");
const WEPLAY = sample("weplay/01-cash-nlhe-8max-0.25-0.50.txt");
const decoded = (bytes: Buffer) => decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer).text;

let wasm: ConversionEngine;

beforeAll(async () => {
  wasm = wasmEngine(await loadWebCore());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetConversionEngine();
});

/** Runs the worker module on one request, acknowledging batches like the page, late. */
async function runBulkWorker(request: WorkerRequest, ackDelayMs = 5) {
  const replies: WorkerResponse[] = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const scope: { onmessage?: (event: MessageEvent<WorkerRequest>) => void; postMessage(m: WorkerResponse): void } = {
    postMessage(message) {
      replies.push(plain(message));
      if (message.type === "bulk-batch") {
        outstanding += 1;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        setTimeout(() => {
          outstanding -= 1;
          scope.onmessage!({ data: { type: "ack", jobId: message.jobId, batches: 1 } } as MessageEvent<WorkerRequest>);
        }, ackDelayMs);
      }
      if (message.type === "done" || message.type === "error") {
        done();
      }
    },
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("fetch", diskFetch([]));
  vi.resetModules();
  await import("../../frontend/src/workers/convert.worker");
  const engineModule = await import("../../frontend/src/lib/wasm/engine");
  engineModule.resetConversionEngine();
  scope.onmessage!({ data: request } as MessageEvent<WorkerRequest>);
  await finished;
  return { replies, maxOutstanding };
}

describe("the worker's bulk path", () => {
  it("reads a zip and converts it batch for batch like the pipeline, within its window", async () => {
    const big = Buffer.concat([WEPLAY, Buffer.from("\n\n"), WEPLAY.subarray(3), Buffer.from("\n\n"), WEPLAY.subarray(3)]);
    const zip = buildZip([
      { name: "hands/stars.txt", data: STARS },
      { name: "hands/screenshot.png", data: "png" },
      { name: "hands/2026/weplay.txt", data: big },
    ]);
    const { replies, maxOutstanding } = await runBulkWorker({
      type: "bulk",
      jobId: 3,
      items: [{ kind: "file", file: file("export.zip", zip), path: "Exports/export.zip" }],
      options: { validate: true },
      keepOriginals: false,
      resume: { done: [], batches: [] },
      window: 2,
    });

    expect(replies.at(-1)).toEqual({ type: "done", jobId: 3, cancelled: false, engine: "wasm" });
    expect(maxOutstanding).toBeLessThanOrEqual(2);
    const sources = replies.filter((r) => r.type === "bulk-source");
    expect(sources.map((r) => r.type === "bulk-source" && r.source.name)).toEqual([
      "export.zip → hands/stars.txt",
      "export.zip → hands/2026/weplay.txt",
    ]);

    for (const [name, bytes] of [["export.zip → hands/stars.txt", STARS], ["export.zip → hands/2026/weplay.txt", big]] as const) {
      const source = sources.find((r) => r.type === "bulk-source" && r.source.name === name)!;
      const id = source.type === "bulk-source" ? source.source.id : "";
      const got = replies
        .filter((r) => r.type === "bulk-batch" && r.sourceId === id)
        .map((r) => {
          if (r.type !== "bulk-batch") throw new Error();
          const { type: _t, jobId: _j, key: _k, index: _i, last: _l, ...batch } = r;
          return { ...batch, sourceId: "source" };
        });
      const expected = await pipelineRun(wasm, name, decoded(bytes));
      expect(got).toEqual(expected.batches);
    }
    const consumed = replies.reduce((sum, r) => sum + (r.type === "bulk-consumed" ? r.bytes : 0), 0);
    expect(consumed).toBe(zip.length);
    expect(replies.reduce((sum, r) => sum + (r.type === "bulk-consumed" ? r.other : 0), 0)).toBe(1);
  });

  it("skips what the resume state says is stored", async () => {
    const zip = buildZip([{ name: "a.txt", data: STARS }, { name: "b.txt", data: WEPLAY }]);
    const items: Extract<WorkerRequest, { type: "bulk" }>["items"] = [{ kind: "file", file: file("e.zip", zip), path: "e.zip" }];
    const first = await runBulkWorker({ type: "bulk", jobId: 4, items, options: { validate: true }, keepOriginals: false, resume: { done: [], batches: [] }, window: 4 });
    const keys = first.replies.flatMap((r) => (r.type === "bulk-source" ? [r.source.key] : []));
    const second = await runBulkWorker({ type: "bulk", jobId: 5, items, options: { validate: true }, keepOriginals: false, resume: { done: [keys[0]], batches: [] }, window: 4 });
    expect(second.replies.flatMap((r) => (r.type === "bulk-source" ? [r.source.name] : []))).toEqual(["e.zip → b.txt"]);
    expect(second.replies.reduce((sum, r) => sum + (r.type === "bulk-consumed" ? r.done : 0), 0)).toBe(1);
  });

  it("stops between batches when cancelled, even while waiting for an acknowledgement", async () => {
    const zip = buildZip([{ name: "w.txt", data: Buffer.concat([WEPLAY, Buffer.from("\n\n"), WEPLAY.subarray(3)]) }]);
    const replies: WorkerResponse[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const scope: { onmessage?: (event: MessageEvent<WorkerRequest>) => void; postMessage(m: WorkerResponse): void } = {
      postMessage(message) {
        replies.push(plain(message));
        // Never acknowledged: the worker waits after its window, until cancelled.
        if (message.type === "bulk-batch" && replies.filter((r) => r.type === "bulk-batch").length === 1) {
          setTimeout(() => scope.onmessage!({ data: { type: "cancel", jobId: 6 } } as MessageEvent<WorkerRequest>), 20);
        }
        if (message.type === "done" || message.type === "error") done();
      },
    };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("fetch", diskFetch([]));
    vi.resetModules();
    await import("../../frontend/src/workers/convert.worker");
    (await import("../../frontend/src/lib/wasm/engine")).resetConversionEngine();
    scope.onmessage!({
      data: { type: "bulk", jobId: 6, items: [{ kind: "file", file: file("w.zip", zip), path: "w.zip" }], options: { validate: true }, keepOriginals: false, resume: { done: [], batches: [] }, window: 1 },
    } as MessageEvent<WorkerRequest>);
    await finished;
    expect(replies.filter((r) => r.type === "bulk-batch")).toHaveLength(1);
    expect(replies.at(-1)).toEqual({ type: "done", jobId: 6, cancelled: true, engine: "wasm" });
  });
});

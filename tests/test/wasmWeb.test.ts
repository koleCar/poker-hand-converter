/**
 * The web converts with the WebAssembly core (docs/RAIL-PLAN.md R4.1).
 *
 * The committed package (`web/src/lib/wasm/rail-core/`, which CI holds
 * to a fresh build) is loaded the ways the web loads it, and every web caller
 * that turns text into PHF is checked against the TypeScript parsers, which
 * stay as the fallback and the oracle:
 *
 * - the converter's pipeline, batch for batch, on one sample of every corpus
 *   directory (the whole corpus is `tests/scripts/wasm/web.test.ts`, run by
 *   `npm run wasm:shadow`);
 * - the worker, through its message protocol;
 * - `engine.convert` as the single-hand box and share links call it (no file
 *   name);
 * - the loader: the one request it makes is the `.wasm` next to its own
 *   module (the converter's "zero server requests" promise), and when the
 *   module cannot be loaded the TypeScript parsers convert instead, with one
 *   warning;
 * - text the core would read differently (CRLF, a BOM, whitespace) goes to
 *   the TypeScript engine.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  resetConversionEngine,
  typescriptEngine,
  wasmEngine,
  type ConversionEngine,
} from "../../web/src/lib/wasm/engine";
import { wasmUrl, type RailCore } from "../../web/src/lib/wasm/core";
import type { WorkerRequest, WorkerResponse } from "../../web/src/workers/convert.worker";
import { decodedText, diskFetch, loadWebCore, pipelineRun, plain } from "./support/webConversion";

const SAMPLES = fileURLToPath(new URL("../../fixtures/samples/", import.meta.url));

/** Hand histories under `dir`, in byte order, nested directories included. */
function inputsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...inputsUnder(path));
    } else if (/\.(txt|xml)$/i.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** The first hand history of every sample directory (rooms with and without a parser). */
function oneSamplePerDirectory(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const dir of readdirSync(SAMPLES).sort()) {
    if (!statSync(join(SAMPLES, dir)).isDirectory()) {
      continue;
    }
    for (const path of inputsUnder(join(SAMPLES, dir))) {
      const text = decodedText(path);
      if (text !== null) {
        out.push({ name: basename(path), text });
        break;
      }
    }
  }
  return out;
}

/** The engine module with a fresh WebAssembly glue: nothing loaded, nothing chosen. */
async function freshEngineModule(): Promise<typeof import("../../web/src/lib/wasm/engine")> {
  vi.resetModules();
  return import("../../web/src/lib/wasm/engine");
}

let core: RailCore;
let wasm: ConversionEngine;
const ts = typescriptEngine();

beforeAll(async () => {
  core = await loadWebCore();
  wasm = wasmEngine(core);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetConversionEngine();
});

describe("the committed WebAssembly package", () => {
  it("is the core this code reads", () => {
    expect(core.formats()).toEqual({ convert: "rail-convert/1", phf: "phf/1" });
  });

  it("is served from next to its loader", () => {
    expect(wasmUrl().href).toMatch(/\/web\/src\/lib\/wasm\/rail-core\/rail_core_wasm_bg\.wasm$/);
  });
});

describe("the converter's pipeline: WASM equals TypeScript", () => {
  const samples = oneSamplePerDirectory();

  it("covers every sample directory", () => {
    // 22 directories; `phh/` holds only PHH files and `wpt-global/` only notes.
    expect(samples.length).toBeGreaterThanOrEqual(20);
  });

  it.each(samples.map((s) => [s.name, s] as const))("%s", async (_name, sample) => {
    const expected = await pipelineRun(ts, sample.name, sample.text);
    const actual = await pipelineRun(wasm, sample.name, sample.text);
    expect(expected.kind).toBe("typescript");
    expect(actual.kind).toBe("wasm");
    expect(actual.starts).toEqual(expected.starts);
    expect(actual.ended).toEqual(expected.ended);
    expect(actual.batches).toEqual(expected.batches);
  });

  it("batches a large file: progress, then the same hands", async () => {
    // Every WePlay sample in one text: more than one batch of 100.
    const dir = join(SAMPLES, "weplay");
    const text = readdirSync(dir)
      .filter((name) => name.endsWith(".txt"))
      .sort()
      .map((name) => decodedText(join(dir, name)))
      .filter((t): t is string => t !== null)
      .join("\n\n");
    const expected = await pipelineRun(ts, "weplay-all.txt", text);
    const actual = await pipelineRun(wasm, "weplay-all.txt", text);
    expect(actual.batches.length).toBe(expected.batches.length);
    expect(actual.batches).toEqual(expected.batches);
    expect(actual.starts).toEqual(expected.starts);
  });
});

describe("single-hand box and share links: convert without a file name", () => {
  it("one pasted hand", async () => {
    const [sample] = oneSamplePerDirectory().filter((s) => s.text.startsWith("PokerStars"));
    const hand = sample.text.split(/\n{2,}(?=PokerStars)/)[0];
    const expected = plain(await ts.convert(hand, { sourceFilename: null, validate: true }));
    const actual = plain(await wasm.convert(hand, { sourceFilename: null, validate: true }));
    expect(actual.hands.length).toBe(1);
    expect(actual.hands[0].meta.originalFilename).toBeNull();
    expect(actual).toEqual(expected);
    // Share links call it with no options at all.
    expect(plain(await wasm.convert(hand))).toEqual(plain(await ts.convert(hand)));
  });

  it("text nothing recognises: the same refusal", async () => {
    const text = "these are my notes from last night\nnothing to see";
    const expected = plain(await ts.convert(text, { sourceFilename: null }));
    const actual = plain(await wasm.convert(text, { sourceFilename: null }));
    expect(actual.failures[0].reason).toBe("unknown-site");
    expect(actual).toEqual(expected);
  });

  it("text the core would read differently goes to the TypeScript engine", async () => {
    const fallback = typescriptEngine();
    const convert = vi.spyOn(fallback, "convert");
    const split = vi.spyOn(fallback, "split");
    const engine = wasmEngine(core, fallback);
    const [sample] = oneSamplePerDirectory().filter((s) => s.text.startsWith("PokerStars"));
    for (const text of [sample.text.replace(/\n/g, "\r\n"), `﻿${sample.text}`, "   \n\t\n", ""]) {
      expect(plain(await engine.convert(text, { sourceFilename: "x.txt" }))).toEqual(
        plain(await ts.convert(text, { sourceFilename: "x.txt" })),
      );
      expect(plain(await engine.split(text))).toEqual(plain(await ts.split(text)));
    }
    expect(convert).toHaveBeenCalledTimes(4);
    expect(split).toHaveBeenCalledTimes(4);
    convert.mockClear();
    await engine.convert(sample.text, { sourceFilename: "x.txt" });
    expect(convert).not.toHaveBeenCalled();
  });
});

describe("loading the core", () => {
  const [sample] = oneSamplePerDirectory().filter((s) => s.text.startsWith("PokerStars"));

  it("fetches only the .wasm next to its loader, and converts with it", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", diskFetch(requested));
    const { conversionEngine } = await freshEngineModule();
    const engine = await conversionEngine();
    expect(engine.kind).toBe("wasm");
    expect(await conversionEngine()).toBe(engine);
    const run = await pipelineRun(engine, sample.name, sample.text);
    expect(run.batches[0].hands.length).toBeGreaterThan(0);
    // The converter's promise: nothing else is requested, and that one URL is
    // a sibling of the loader's own module (a static file of the same origin
    // in the browser).
    expect(requested).toEqual([wasmUrl().href]);
  });

  it("falls back to the TypeScript parsers, with one warning, when the module cannot be loaded", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { conversionEngine } = await freshEngineModule();
    const engine = await conversionEngine();
    expect(engine.kind).toBe("typescript");
    await conversionEngine();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/TypeScript parsers/);
    const run = await pipelineRun(engine, sample.name, sample.text);
    expect(run).toEqual({ ...(await pipelineRun(wasm, sample.name, sample.text)), kind: "typescript" });
  });

  it("a module that is not WebAssembly falls back too", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>404</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { conversionEngine } = await freshEngineModule();
    expect((await conversionEngine()).kind).toBe("typescript");
  });
});

describe("the conversion worker", () => {
  async function runWorker(request: WorkerRequest): Promise<WorkerResponse[]> {
    const replies: WorkerResponse[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const scope: { onmessage?: (event: MessageEvent<WorkerRequest>) => void; postMessage(m: WorkerResponse): void } = {
      postMessage(message) {
        replies.push(plain(message));
        if (message.type === "done" || message.type === "error") {
          done();
        }
      },
    };
    vi.stubGlobal("self", scope);
    vi.resetModules();
    await import("../../web/src/workers/convert.worker");
    // The worker module and its pipeline are fresh; so is their engine choice.
    const engineModule = await import("../../web/src/lib/wasm/engine");
    engineModule.resetConversionEngine();
    scope.onmessage!({ data: request } as MessageEvent<WorkerRequest>);
    await finished;
    return replies;
  }

  const samples = oneSamplePerDirectory().filter((s) => /^(PokerStars|Poker Hand #|Winamax)/.test(s.text));

  it("converts with the WASM core and says so", async () => {
    vi.stubGlobal("fetch", diskFetch([]));
    const sources = samples.map((s, i) => ({ id: `s${i}`, name: s.name, text: s.text }));
    const replies = await runWorker({ type: "convert", jobId: 7, sources, options: { validate: true } });
    const done = replies.at(-1)!;
    expect(done).toEqual({ type: "done", jobId: 7, cancelled: false, engine: "wasm" });

    // The same messages, hands and failures as the TypeScript pipeline.
    const expected: unknown[] = [];
    for (const [i, s] of samples.entries()) {
      const run = await pipelineRun(ts, s.name, s.text);
      expected.push(
        ...run.starts.map((start) => ({ type: "source-start", jobId: 7, ...start, sourceId: `s${i}` })),
        ...run.batches.map((batch) => ({ type: "batch", jobId: 7, ...batch, sourceId: `s${i}` })),
        { type: "source-end", jobId: 7, sourceId: `s${i}` },
      );
    }
    expect(replies.slice(0, -1)).toEqual(expected);
  });

  it("falls back to the TypeScript parsers inside the worker", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("blocked");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sources = [{ id: "a", name: samples[0].name, text: samples[0].text }];
    const replies = await runWorker({ type: "convert", jobId: 8, sources, options: { validate: true } });
    expect(replies.at(-1)).toEqual({ type: "done", jobId: 8, cancelled: false, engine: "typescript" });
    const batches = replies.filter((r) => r.type === "batch");
    expect(batches.length).toBeGreaterThan(0);
    const run = await pipelineRun(wasm, samples[0].name, samples[0].text);
    expect(batches.map(({ type: _t, jobId: _j, ...b }) => ({ ...b, sourceId: "source" }))).toEqual(run.batches);
  });
});

/**
 * The web's conversion path (docs/RAIL-PLAN.md R4.1) for the tests: the
 * committed WebAssembly package (`web/src/lib/wasm/rail-core/`), its
 * engine and the TypeScript engine, and one run of the converter's pipeline
 * reduced to plain data so two runs compare with `toEqual`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeSource } from "../../../web/src/components/converter/inputs";
import { runPipeline, type PipelineBatch, type SourceStart } from "../../../web/src/components/converter/pipeline";
import { railCore, type RailCore, type RailCoreGlue } from "../../../web/src/lib/wasm/core";
import type { ConversionEngine } from "../../../web/src/lib/wasm/engine";

export const WEB_PACKAGE = new URL("../../../web/src/lib/wasm/rail-core/", import.meta.url);
export const PINNED_PARSED_AT = "1970-01-01T00:00:00.000Z";

/** The committed module, instantiated from its bytes (no fetch). */
export async function loadWebCore(): Promise<RailCore> {
  const glue = (await import("../../../web/src/lib/wasm/rail-core/rail_core_wasm.js")) as unknown as RailCoreGlue;
  await glue.default({ module_or_path: readFileSync(new URL("rail_core_wasm_bg.wasm", WEB_PACKAGE)) });
  return railCore(glue);
}

/**
 * A `fetch` that serves `file:` URLs from disk with `application/wasm`, and
 * records every URL asked for. Node's own `fetch` refuses `file:` URLs, which
 * is how the tests make the module fail to load.
 */
export function diskFetch(requested: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url.href);
    return new Response(readFileSync(fileURLToPath(url)), { headers: { "Content-Type": "application/wasm" } });
  }) as typeof fetch;
}

/** A value as JSON would carry it (no `undefined`), with `parsedAt` pinned in every hand. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) => (key === "parsedAt" ? PINNED_PARSED_AT : v)) as T;
}

/** A corpus file decoded the way the converter decodes it, or `null` when it refuses it. */
export function decodedText(path: string): string | null {
  const bytes = readFileSync(path);
  const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return decoded.problem ? null : decoded.text;
}

export interface PipelineRun {
  kind: ConversionEngine["kind"];
  starts: SourceStart[];
  batches: PipelineBatch[];
  ended: string[];
}

/** One source through the converter's pipeline with `engine`, as plain data. */
export async function pipelineRun(engine: ConversionEngine, name: string, text: string): Promise<PipelineRun> {
  const starts: SourceStart[] = [];
  const batches: PipelineBatch[] = [];
  const ended: string[] = [];
  const kind = await runPipeline(
    [{ id: "source", name, text }],
    { validate: true },
    {
      onSourceStart: (start) => starts.push(start),
      onBatch: (batch) => batches.push(batch),
      onSourceEnd: (id) => ended.push(id),
      isCancelled: () => false,
    },
    engine,
  );
  return plain({ kind, starts, batches, ended });
}

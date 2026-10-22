/**
 * The web's conversion path over the whole corpus (docs/RAIL-PLAN.md R4.1),
 * run by `npm run wasm:shadow` beside the shadow mode.
 *
 * Shadow mode (`shadow.test.ts`) holds the core to the TypeScript pipeline
 * file by file, bytes in. The web feeds the core differently - the text the
 * converter already decoded, in batches of 100 hands re-joined with a blank
 * line, through `lib/wasm/engine.ts` - so this holds *that* path to the one
 * it replaced: for every corpus file the converter's pipeline with the
 * WebAssembly engine (the committed package `frontend/src/lib/wasm/rail-core/`,
 * which CI checks is a fresh build) gives the same source starts, batches,
 * hands, failures (fingerprints, confidences, raw text) as with the TypeScript
 * engine, and so does one whole-file `convert` (the single-hand box).
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { typescriptEngine, wasmEngine } from "../../../frontend/src/lib/wasm/engine.js";
import { ROOT, listInputs } from "../golden/emit.js";
import { decodedText, loadWebCore, pipelineRun, plain } from "../../test/support/webConversion.js";

describe("the web's conversion path, WASM against TypeScript", () => {
  it("every corpus file through the converter's pipeline and a whole-file convert", async () => {
    const core = await loadWebCore();
    const wasm = wasmEngine(core);
    const ts = typescriptEngine();
    const inputs = listInputs();
    const failed: string[] = [];
    let files = 0;
    let hands = 0;
    let failures = 0;
    let batches = 0;
    const seconds = { wasm: 0, ts: 0 };

    for (const path of inputs) {
      const text = decodedText(join(ROOT, path));
      if (text === null) {
        continue;
      }
      files += 1;
      const name = path.split("/").pop()!;
      let started = performance.now();
      const expected = await pipelineRun(ts, name, text);
      seconds.ts += (performance.now() - started) / 1000;
      started = performance.now();
      const actual = await pipelineRun(wasm, name, text);
      seconds.wasm += (performance.now() - started) / 1000;

      const problems: string[] = [];
      if (JSON.stringify(actual.starts) !== JSON.stringify(expected.starts)) {
        problems.push(`source start: TS ${JSON.stringify(expected.starts)}, WASM ${JSON.stringify(actual.starts)}`);
      }
      try {
        expect(actual.batches).toEqual(expected.batches);
      } catch {
        problems.push(`batches differ (${expected.batches.length} TS, ${actual.batches.length} WASM)`);
      }
      const whole = { sourceFilename: name, validate: true };
      try {
        expect(plain(await wasm.convert(text, whole))).toEqual(plain(await ts.convert(text, whole)));
      } catch {
        problems.push("whole-file convert differs");
      }
      if (problems.length > 0) {
        failed.push(`${path}: ${problems.join("; ")}`);
      }
      batches += expected.batches.length;
      for (const batch of expected.batches) {
        hands += batch.hands.length;
        failures += batch.failures.length;
      }
    }

    const rate = (s: number) => `${Math.round(hands / s)} hands/s (${s.toFixed(2)} s)`;
    console.log(
      `web path: ${files - failed.length} / ${files} decodable files equal, ${batches} batches, ${hands} hands, ` +
        `${failures} failures; pipeline TypeScript ${rate(seconds.ts)}, WASM ${rate(seconds.wasm)} (first pass, cold)`,
    );
    expect(failed.slice(0, 20), `${failed.length} files differ`).toEqual([]);
    expect(files).toBeGreaterThanOrEqual(500);
    expect(hands).toBeGreaterThanOrEqual(8000);
  });
});

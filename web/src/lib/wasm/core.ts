/**
 * The WebAssembly core in the browser (docs/RAIL-PLAN.md R4.1).
 *
 * `rail-core-wasm` built with `wasm-bindgen --target web` is committed next to
 * this file (`rail-core/`: CI's Linux build, installed with `npm run
 * wasm:web-from-ci` in `tests/`; CI rebuilds it and fails when the copy
 * differs - Vercel has no Rust). The glue
 * is an ES module whose default export instantiates the module; it is handed
 * the `.wasm` as `new URL(..., import.meta.url)`, which the bundler emits as a
 * content-hashed static file of this origin (`/_next/static/media/...`,
 * cached for a year, `application/wasm`). Loading it is the one request the
 * conversion path makes, and it carries nothing of the user's.
 *
 * The typed face (`railCore`) mirrors `core/rail-core-wasm/js/index.ts`, whose
 * types it takes: that file lives outside the web app's folder, where Next
 * compiles no runtime code, so only its declarations cross.
 */

import type {
  ConvertOptions,
  ConvertResult,
  Detection,
  RailCore,
  RailCoreWasm,
  Sample,
  Split,
} from "../../../../core/rail-core-wasm/js/index";

export type { ConvertOptions, ConvertResult, Detection, RailCore, RailCoreWasm, Split };

/** The glue's exports: the raw functions and its `init`. */
export type RailCoreGlue = RailCoreWasm & {
  default(input?: { module_or_path: URL | Response | BufferSource | WebAssembly.Module }): Promise<unknown>;
};

/** Types the raw exports of an instantiated module (`railCore` in `js/index.ts`). */
export function railCore(raw: RailCoreWasm): RailCore {
  return {
    convert: (bytes, filename, options) =>
      JSON.parse(raw.convert(bytes, filename, JSON.stringify(options))) as ConvertResult,
    detect: (bytes) => JSON.parse(raw.detect(bytes)) as Detection,
    split: (bytes) => JSON.parse(raw.split(bytes)) as Split,
    serialize: (phf) => raw.serialize(JSON.stringify(phf)),
    anonymise: (bytes) => JSON.parse(raw.anonymise(bytes)) as Sample,
    formats: () => JSON.parse(raw.formats()) as { convert: string; phf: string },
  };
}

/** Where the module is served from: next to this file, same origin. */
export function wasmUrl(): URL {
  return new URL("./rail-core/rail_core_wasm_bg.wasm", import.meta.url);
}

/**
 * Instantiates the committed module and checks it is the format this code
 * reads. Throws when it cannot: no WebAssembly, a blocked or failed fetch, a
 * CSP without `wasm-unsafe-eval`, a different document format.
 */
export async function instantiateRailCore(): Promise<RailCore> {
  const glue = (await import("./rail-core/rail_core_wasm.js")) as unknown as RailCoreGlue;
  await glue.default({ module_or_path: wasmUrl() });
  const core = railCore(glue);
  const formats = core.formats();
  if (formats.convert !== "rail-convert/1" || formats.phf !== "phf/1") {
    throw new Error(`the WebAssembly core writes ${formats.convert} / ${formats.phf}`);
  }
  return core;
}

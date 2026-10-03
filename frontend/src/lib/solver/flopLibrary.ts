/**
 * The flop library's stored form (phase A5b): one **chunk** per chart set,
 * tree, preflop line and representative flop, fetched on demand.
 *
 * A chunk is a flop solve's flop-level result - every flop decision node
 * with the acting player's strategy and EV per combo, and the turn deals
 * below them with no subtree - plus a header naming exactly what was solved:
 * the chart set (and its model hash: a regenerated set is a different
 * library), the line, the canonical flop, the pot and stack, the tree, the
 * rake, the exploitability reached. `FLOPLIB_VERSION` changes with the
 * layout; the solve inside carries `SOLVER_VERSION`.
 *
 * **Layout**, little-endian:
 *
 * ```
 * 0   "RFLB"            magic
 * 4   u16 1             layout revision
 * 6   u16 0             reserved
 * 8   u32 H             header length
 * 12  H bytes           header: UTF-8 JSON (`FlopChunkHeader`)
 *     pad to 4
 *     the solve         `encodeSolution` (format.ts): strategies as u16, EVs as f32
 * ```
 *
 * Strategies are 16-bit (1/65535, renormalised on decode), EVs stay float32
 * (EV loss is a difference of two of them, `format.ts`). A chunk of the
 * widest single-raised line (BTN–BB) is ~100 KB, a 3-bet pot's ~60 KB; about half gzipped.
 *
 * **Where chunks live.** `<set>/<tree>/<line>/<flop>.bin` under a base URL,
 * next to a `manifest.json` listing what exists. The batch runner
 * (`tests/scripts/flop-library`) writes them; the analysis worker fetches a
 * chunk only for a hand that needs it (`lib/analysis/flopLibrary.ts`). They
 * are never bundled into a page.
 */

import { decodeSolution, encodeSolution, SOLVER_VERSION, SolutionFormatError, utf8Decode, utf8Encode } from "./format";
import type { SolveResult } from "./solve";

export const FLOPLIB_VERSION = "floplib/1";

const MAGIC = [0x52, 0x46, 0x4c, 0x42]; // "RFLB"
const LAYOUT = 1;

const pad4 = (x: number) => (x + 3) & ~3;

/** What a chunk was solved from. Everything a reader must match before trusting it. */
export interface FlopChunkHeader {
  version: typeof FLOPLIB_VERSION;
  solver: string;
  /** Chart set id, version and model hash (`ChartSet.id`, `.version`, `.model.hash`). */
  charts: { id: string; version: string; hash: string };
  /** Tree profile id, e.g. `flop-m1`. */
  tree: string;
  /** Line id (`FLOP_LINES`) and its chart line key. */
  line: string;
  lineKey: string;
  /** Positions, out of position first: player 0 of the solve is `players[0]`. */
  players: [string, string];
  /** Canonical flop key, e.g. `Qs7h2d`. */
  flop: string;
  /** Pot at the flop and effective stack, bb. */
  pot: number;
  stack: number;
  rake: { name: string; percent: number; cap: number };
  /** Exploitability target the solve ran to, % of the pot. */
  targetPct: number;
}

export interface FlopChunk {
  header: FlopChunkHeader;
  /** The flop-level solve (`nodes: "flop"`), board in the canonical flop's suits. */
  result: SolveResult;
}

/** Thrown when bytes are not a flop library chunk of this layout and version. */
export class FlopChunkFormatError extends Error {}

/** The path of a chunk under the library's base URL. */
export function chunkPath(set: string, tree: string, line: string, flop: string): string {
  for (const part of [set, tree, line, flop]) {
    if (!/^[A-Za-z0-9._+-]+$/.test(part)) throw new RangeError(`bad chunk path part ${JSON.stringify(part)}`);
  }
  return `${set}/${tree}/${line}/${flop}.bin`;
}

/** Encodes a chunk. Deterministic: the same solve and header give the same bytes. */
export function encodeChunk(header: FlopChunkHeader, result: SolveResult): Uint8Array {
  if (result.street !== "flop" || result.scope !== "flop") {
    throw new RangeError("a flop library chunk holds a flop-level flop solve (nodes: \"flop\")");
  }
  const json = utf8Encode(JSON.stringify(header));
  const solve = encodeSolution(result);
  const start = pad4(12 + json.length);
  const bytes = new Uint8Array(start + solve.length);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(4, LAYOUT, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, json.length, true);
  bytes.set(json, 12);
  bytes.set(solve, start);
  return bytes;
}

/** Reads only a chunk's header (cheap: no per-hand arrays). */
export function chunkHeader(input: Uint8Array | ArrayBuffer): FlopChunkHeader {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12 || MAGIC.some((b, k) => bytes[k] !== b)) {
    throw new FlopChunkFormatError("not a flop library chunk");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = view.getUint16(4, true);
  if (layout !== LAYOUT) throw new FlopChunkFormatError(`chunk layout ${layout}, expected ${LAYOUT}`);
  const length = view.getUint32(8, true);
  const header = JSON.parse(utf8Decode(bytes.subarray(12, 12 + length))) as FlopChunkHeader;
  if (header.version !== FLOPLIB_VERSION) {
    throw new FlopChunkFormatError(`chunk is ${header.version}, this build reads ${FLOPLIB_VERSION}`);
  }
  if (header.solver !== SOLVER_VERSION) {
    throw new FlopChunkFormatError(`chunk was solved by ${header.solver}, this build is ${SOLVER_VERSION}`);
  }
  return header;
}

/** Decodes a chunk. Throws `FlopChunkFormatError` on anything that is not one this build reads. */
export function decodeChunk(input: Uint8Array | ArrayBuffer): FlopChunk {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = chunkHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = pad4(12 + view.getUint32(8, true));
  let result: SolveResult;
  try {
    result = decodeSolution(bytes.subarray(start));
  } catch (error) {
    if (error instanceof SolutionFormatError) throw new FlopChunkFormatError(error.message);
    throw error;
  }
  if (result.street !== "flop") throw new FlopChunkFormatError(`chunk holds a ${result.street} solve`);
  return { header, result: { ...result, scope: "flop" } };
}

/** One entry of a library's `manifest.json`. */
export interface FlopManifestEntry {
  line: string;
  flop: string;
  path: string;
  bytes: number;
  iterations: number;
  exploitabilityPct: number;
  /** Wall time of the solve, seconds; machine-dependent, never part of the chunk. */
  seconds: number;
  /** The solver's typed arrays and the worker's peak resident memory, MB. */
  solverMb: number;
  peakRssMb: number;
}

/** A library's `manifest.json`: what was solved, with what, and what each solve cost. */
export interface FlopManifest {
  version: typeof FLOPLIB_VERSION;
  solver: string;
  charts: { id: string; version: string; hash: string };
  tree: string;
  /** Machine and run notes (cores, Node version): free-form. */
  machine?: Record<string, unknown>;
  entries: FlopManifestEntry[];
}

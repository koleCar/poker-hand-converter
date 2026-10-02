/**
 * `SOLVER_VERSION` and the stored form of a solution.
 *
 * **The version is part of every cache key.** A solved spot is cached by
 * `(spot key, SOLVER_VERSION)` (plan §3.4). Anything that can change a
 * strategy - the DCFR parameters, the tree rules in `betting.ts`, the stopping
 * target, the blob layout - is a new version, exactly like `STATS_VERSION`, and
 * a blob of another version is a cache miss, never a best effort.
 *
 * **Blob layout**, little-endian:
 *
 * ```
 * 0   "RSLV"            magic
 * 4   u16 1             layout revision
 * 6   u16 0             reserved
 * 8   u32 H             header length
 * 12  H bytes           header: UTF-8 JSON, everything that is not per hand
 *     pad to 4
 *     u16[n0], u16[n1]  combo index of each hand (padded to 4)
 *     f32[n0], f32[n1]  initial weights
 *     f32[n0], f32[n1]  root EV per hand
 *     per action node, in node order:
 *       u16[actions*n]  strategy, quantised to 1/65535 (padded to 4)
 *       f32[actions*n]  EV per action per hand
 * ```
 *
 * Strategies are quantised because they are the bulk of the blob and nothing
 * reads them more finely than a tenth of a percent; on decode each hand's
 * column is renormalised so it sums to exactly 1 again. EVs stay `f32`: EV loss
 * is a difference of two of them, and quantising both would put the error
 * where the grade is decided. A typical river spot is a few hundred KB.
 */

import type { SolvedNode, SolveResult } from "./solve";

export const SOLVER_VERSION = "solver/1";

const MAGIC = [0x52, 0x53, 0x4c, 0x56]; // "RSLV"
const LAYOUT = 1;

/** Thrown when a blob is not a solution of this layout and version. */
export class SolutionFormatError extends Error {}

interface Header {
  version: string;
  street: SolveResult["street"];
  board: string[];
  pot: number;
  stack: number;
  firstToAct: 0 | 1;
  iterations: number;
  stoppedBy: SolveResult["stoppedBy"];
  exploitability: number;
  exploitabilityPct: number;
  exploitabilityMbb: number;
  value: [number, number];
  memoryBytes: number;
  n: [number, number];
  nodes: Omit<SolvedNode, "strategy" | "ev">[];
}

const pad4 = (x: number) => (x + 3) & ~3;

/** Encodes a solution as a versioned binary blob. */
export function encodeSolution(result: SolveResult): Uint8Array {
  const n: [number, number] = [result.hands[0].length, result.hands[1].length];
  const header: Header = {
    version: result.version,
    street: result.street,
    board: result.board,
    pot: result.pot,
    stack: result.stack,
    firstToAct: result.firstToAct,
    iterations: result.iterations,
    stoppedBy: result.stoppedBy,
    exploitability: result.exploitability,
    exploitabilityPct: result.exploitabilityPct,
    exploitabilityMbb: result.exploitabilityMbb,
    value: result.value,
    memoryBytes: result.memoryBytes,
    n,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nodes: result.nodes.map(({ strategy, ev, ...rest }) => rest),
  };
  const json = utf8Encode(JSON.stringify(header));

  let size = pad4(12 + json.length);
  size += pad4(2 * (n[0] + n[1]));
  size += 4 * 2 * (n[0] + n[1]);
  for (const node of result.nodes) {
    size += pad4(2 * node.strategy.length) + 4 * node.ev.length;
  }

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(4, LAYOUT, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, json.length, true);
  bytes.set(json, 12);
  let at = pad4(12 + json.length);

  for (const hands of result.hands) {
    for (const combo of hands) {
      view.setUint16(at, combo, true);
      at += 2;
    }
  }
  at = pad4(at);
  for (const array of [...result.weights, ...result.rootEv]) {
    for (const x of array) {
      view.setFloat32(at, x, true);
      at += 4;
    }
  }
  for (const node of result.nodes) {
    for (const x of node.strategy) {
      view.setUint16(at, Math.round(Math.min(1, Math.max(0, x)) * 65535), true);
      at += 2;
    }
    at = pad4(at);
    for (const x of node.ev) {
      view.setFloat32(at, x, true);
      at += 4;
    }
  }
  return bytes;
}

/** Decodes a blob from `encodeSolution`. Throws `SolutionFormatError` on anything else. */
export function decodeSolution(input: Uint8Array | ArrayBuffer): SolveResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12 || MAGIC.some((b, k) => bytes[k] !== b)) {
    throw new SolutionFormatError("not a solver blob");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const layout = view.getUint16(4, true);
  if (layout !== LAYOUT) {
    throw new SolutionFormatError(`blob layout ${layout}, expected ${LAYOUT}`);
  }
  const length = view.getUint32(8, true);
  const header = JSON.parse(utf8Decode(bytes.subarray(12, 12 + length))) as Header;
  if (header.version !== SOLVER_VERSION) {
    throw new SolutionFormatError(`blob is ${header.version}, this build is ${SOLVER_VERSION}`);
  }
  let at = pad4(12 + length);
  const [n0, n1] = header.n;

  const hands: [Uint16Array, Uint16Array] = [new Uint16Array(n0), new Uint16Array(n1)];
  for (const array of hands) {
    for (let i = 0; i < array.length; i += 1) {
      array[i] = view.getUint16(at, true);
      at += 2;
    }
  }
  at = pad4(at);
  const floats = (count: number) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = view.getFloat32(at, true);
      at += 4;
    }
    return out;
  };
  const weights: [Float32Array, Float32Array] = [floats(n0), floats(n1)];
  const rootEv: [Float32Array, Float32Array] = [floats(n0), floats(n1)];

  const nodes: SolvedNode[] = header.nodes.map((node) => {
    if (node.kind !== "action") {
      return { ...node, strategy: new Float32Array(0), ev: new Float32Array(0) };
    }
    const size = node.player === 0 ? n0 : n1;
    const count = node.labels.length;
    const strategy = new Float32Array(count * size);
    for (let k = 0; k < strategy.length; k += 1) {
      strategy[k] = view.getUint16(at, true) / 65535;
      at += 2;
    }
    at = pad4(at);
    for (let i = 0; i < size; i += 1) {
      let sum = 0;
      for (let a = 0; a < count; a += 1) {
        sum += strategy[a * size + i];
      }
      for (let a = 0; a < count; a += 1) {
        strategy[a * size + i] = sum > 0 ? strategy[a * size + i] / sum : 1 / count;
      }
    }
    return { ...node, strategy, ev: floats(count * size) };
  });

  return {
    version: SOLVER_VERSION,
    street: header.street,
    board: header.board,
    pot: header.pot,
    stack: header.stack,
    firstToAct: header.firstToAct,
    hands,
    weights,
    iterations: header.iterations,
    stoppedBy: header.stoppedBy,
    exploitability: header.exploitability,
    exploitabilityPct: header.exploitabilityPct,
    exploitabilityMbb: header.exploitabilityMbb,
    value: header.value,
    rootEv,
    nodes,
    memoryBytes: header.memoryBytes,
  };
}

/*
 * UTF-8 by hand: `TextEncoder` exists in browsers, workers and Node alike, but
 * it is typed by the DOM and Node libs, and this module stays free of both.
 * The header is ASCII in practice; the full range is handled anyway.
 */

function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return Uint8Array.from(out);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let k = 0; k < bytes.length; ) {
    const b = bytes[k];
    let cp: number;
    if (b < 0x80) {
      cp = b;
      k += 1;
    } else if (b < 0xe0) {
      cp = ((b & 31) << 6) | (bytes[k + 1] & 63);
      k += 2;
    } else if (b < 0xf0) {
      cp = ((b & 15) << 12) | ((bytes[k + 1] & 63) << 6) | (bytes[k + 2] & 63);
      k += 3;
    } else {
      cp = ((b & 7) << 18) | ((bytes[k + 1] & 63) << 12) | ((bytes[k + 2] & 63) << 6) | (bytes[k + 3] & 63);
      k += 4;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * The flop realisation table (`analysis/15`, `FLOP_REALISATION` in
 * `lib/analysis/multiway.ts`): measured on the flop library, and checked
 * against it held out.
 *
 * At every flop node of a chunk where the actor faces a bet or a raise (a
 * node with a call and a fold), every combo of the actor's range has, from
 * the solve, the EV of calling and of folding. The approximate call the
 * analysis makes on a multiway flop says
 *
 *     EV(call) − EV(fold)  ≈  R · equity · raked pot after the call − toCall
 *
 * with the combo's exact equity against the bettor's range at the node
 * (`nodeEquities`: every turn and river, card removal exact) and `R` a factor
 * per realisation category (position × `flopRealisationCategory`). `R` is
 * fitted by weighted least squares in units of the pot, each node's range
 * weighted by its reach (each node counts once). Every third combo of a
 * range is measured (`SAMPLE_EVERY`), which is plenty and a third of the work.
 * A call that puts the caller all-in is marked (`Sample.allIn`): it ends the
 * betting and realises its equity exactly, so since `analysis/17` the fit
 * leaves it out and the analysis applies no factor there (the turn's rule).
 *
 * **Held out.** Fitted on the flops whose name hashes even, judged on the
 * others, against the library's own grade (§2, all of the node's options) of
 * the same action: how often the call-or-fold verdict agrees, the |ΔEV|, and
 * the approximate grade's agreement by margin (`FLOP_MARGIN_POT`): a grade
 * of Mistake that the library calls Perfect or Good is a false alarm.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FLOP_PROFILE } from "../../../frontend/src/lib/analysis/flopLibrary.js";
import { grade, gradeRank } from "../../../frontend/src/lib/analysis/grading.js";
import { flopRealisationCategory } from "../../../frontend/src/lib/analysis/multiway.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";
import type { Grade } from "../../../frontend/src/lib/analysis/types.js";
import { evaluateMasks, STANDARD } from "../../../frontend/src/lib/equity/evaluator.js";
import { comboHi, comboLo, decodeChunk, rangesAt, type FlopChunk } from "../../../frontend/src/lib/solver/index.js";

/** Every `SAMPLE_EVERY`-th combo of a range is measured. */
export const SAMPLE_EVERY = 3;
/** Combos under this share of the node's range are left out. */
export const MIN_SHARE = 1e-5;

/** Per runout (turn and river): every combo's hand value, -1 where a card collides; and the combos sorted by value. */
export interface Runouts {
  count: number;
  values: [Int32Array, Int32Array];
  orders: [Uint16Array, Uint16Array];
}

/**
 * Every runout of `toCome` cards - two from the flop (turn and river), one
 * from the turn (the river, `turnRealisation.ts`) - and each combo's value.
 */
export function runouts(board: readonly number[], hands: readonly [Uint16Array, Uint16Array], toCome: 1 | 2 = 2): Runouts {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const base = [0, 0, 0, 0];
  for (const c of board) base[c & 3] |= 1 << (c >> 2);
  // One card to come is a "pair" of the same card twice.
  const pairs: Array<[number, number]> = [];
  for (let t = 0; t < 52; t += 1) {
    if (dead[t]) continue;
    if (toCome === 1) pairs.push([t, t]);
    else for (let r = t + 1; r < 52; r += 1) if (!dead[r]) pairs.push([t, r]);
  }
  const values = hands.map((list) => new Int32Array(pairs.length * list.length)) as [Int32Array, Int32Array];
  pairs.forEach(([t, r], k) => {
    const m = [...base];
    m[t & 3] |= 1 << (t >> 2);
    m[r & 3] |= 1 << (r >> 2);
    hands.forEach((list, p) => {
      for (let i = 0; i < list.length; i += 1) {
        const a = comboHi(list[i]);
        const b = comboLo(list[i]);
        if (a === t || a === r || b === t || b === r) {
          values[p][k * list.length + i] = -1;
          continue;
        }
        const mm = [m[0], m[1], m[2], m[3]];
        mm[a & 3] |= 1 << (a >> 2);
        mm[b & 3] |= 1 << (b >> 2);
        values[p][k * list.length + i] = evaluateMasks(STANDARD, mm[0], mm[1], mm[2], mm[3]);
      }
    });
  });
  const orders = hands.map((list, p) => {
    const n = list.length;
    const out = new Uint16Array(pairs.length * n);
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let k = 0; k < pairs.length; k += 1) {
      const v = values[p].subarray(k * n, (k + 1) * n);
      idx.sort((x, y) => v[x] - v[y]);
      out.set(idx, k * n);
    }
    return out;
  }) as [Uint16Array, Uint16Array];
  return { count: pairs.length, values, orders };
}

/**
 * The equity of every combo of player `p` against player `o`'s range
 * (`weights`, in `hands[o]`'s order) over every turn and river: a sweep per
 * runout over both players' combos sorted by value, card removal by
 * per-card sums (inclusion-exclusion; the identical combo added back).
 */
export function nodeEquities(pre: Runouts, hands: readonly [Uint16Array, Uint16Array], p: 0 | 1, weights: ArrayLike<number>): Float64Array {
  const o = 1 - p;
  const hn = hands[p].length;
  const on = hands[o].length;
  const num = new Float64Array(hn);
  const den = new Float64Array(hn);
  const oHi = Array.from(hands[o], (c) => comboHi(c));
  const oLo = Array.from(hands[o], (c) => comboLo(c));
  const hHi = Array.from(hands[p], (c) => comboHi(c));
  const hLo = Array.from(hands[p], (c) => comboLo(c));
  const at = new Map<number, number>();
  hands[o].forEach((c, j) => at.set(c, j));
  const same = Array.from(hands[p], (c) => at.get(c) ?? -1);
  const lessCard = new Float64Array(52);
  const allCard = new Float64Array(52);
  for (let k = 0; k < pre.count; k += 1) {
    const ov = pre.values[o].subarray(k * on, (k + 1) * on);
    const hv = pre.values[p].subarray(k * hn, (k + 1) * hn);
    const oo = pre.orders[o].subarray(k * on, (k + 1) * on);
    const ho = pre.orders[p].subarray(k * hn, (k + 1) * hn);
    allCard.fill(0);
    let all = 0;
    for (let j = 0; j < on; j += 1) {
      if (ov[j] < 0 || !(weights[j] > 0)) continue;
      all += weights[j];
      allCard[oHi[j]] += weights[j];
      allCard[oLo[j]] += weights[j];
    }
    lessCard.fill(0);
    let less = 0;
    let next = 0;
    for (let q = 0; q < hn; q += 1) {
      const i = ho[q];
      const v = hv[i];
      if (v < 0) continue;
      while (next < on && ov[oo[next]] < v) {
        const j = oo[next];
        if (ov[j] >= 0 && weights[j] > 0) {
          less += weights[j];
          lessCard[oHi[j]] += weights[j];
          lessCard[oLo[j]] += weights[j];
        }
        next += 1;
      }
      let tie = 0;
      let tieCards = 0;
      for (let t = next; t < on && ov[oo[t]] === v; t += 1) {
        const j = oo[t];
        if (!(weights[j] > 0)) continue;
        tie += weights[j];
        if (oHi[j] === hHi[i] || oLo[j] === hHi[i]) tieCards += weights[j];
        if (oHi[j] === hLo[i] || oLo[j] === hLo[i]) tieCards += weights[j];
      }
      const s = same[i];
      const sw = s >= 0 && ov[s] >= 0 ? weights[s] : 0;
      const sLess = s >= 0 && ov[s] >= 0 && ov[s] < v ? weights[s] : 0;
      const sTie = s >= 0 && ov[s] === v ? weights[s] : 0;
      num[i] += less - lessCard[hHi[i]] - lessCard[hLo[i]] + sLess + (tie - tieCards + sTie) / 2;
      den[i] += all - allCard[hHi[i]] - allCard[hLo[i]] + sw;
    }
  }
  const out = new Float64Array(hn);
  for (let i = 0; i < hn; i += 1) out[i] = den[i] > 0 ? num[i] / den[i] : 0;
  return out;
}

/** One measured combo at one node facing a bet. Amounts are fractions of the node's pot. */
export interface Sample {
  key: string;
  /** The line id (`btn-bb`, `sb-limp`, ...). */
  line: string;
  train: boolean;
  /** Reach share within the node's range. */
  w: number;
  /** equity × raked pot after the call. */
  x: number;
  /** EV(call) − EV(fold) + toCall. */
  y: number;
  toCall: number;
  /** The library's options (fold, call, raises merged by best EV and summed frequency). */
  fold: { f: number; e: number };
  call: { f: number; e: number };
  raise: { f: number; e: number } | null;
  /** The call puts the caller all-in: no betting is left, so it realises its equity exactly (`analysis/17` leaves these out of the fit). */
  allIn?: boolean;
}

const hashOf = (text: string) => {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
};

/** The samples of one chunk. The solve's player 1 acts last on every street (in position). */
export function chunkSamples(chunk: FlopChunk): Sample[] {
  const result = chunk.result;
  const board = toIndices(result.board);
  const hands = result.hands;
  const pre = runouts(board, hands);
  const rake = chunk.header.rake;
  const train = (hashOf(chunk.header.flop) & 1) === 0;
  const out: Sample[] = [];
  result.nodes.forEach((node, index) => {
    if (node.kind !== "action" || node.toCall <= 0 || node.street !== "flop") return;
    const callEdge = node.actions.findIndex((a) => a.kind === "call");
    const foldEdge = node.actions.findIndex((a) => a.kind === "fold");
    if (callEdge < 0 || foldEdge < 0) return;
    const p = node.player as 0 | 1;
    const allIn = node.toCall >= node.behind - 1e-9;
    const reach = rangesAt(result, index);
    const equities = nodeEquities(pre, hands, p, reach[1 - p]);
    const n = hands[p].length;
    let total = 0;
    for (let i = 0; i < n; i += 1) total += reach[p][i];
    if (!(total > 0)) return;
    const after = node.pot + node.toCall;
    const raked = after - Math.min(after * rake.percent, rake.cap);
    const position = p === 1 ? "ip" : "oop";
    for (let i = 0; i < n; i += SAMPLE_EVERY) {
      const w = reach[p][i] / total;
      if (!(w > MIN_SHARE)) continue;
      let raise: Sample["raise"] = null;
      node.actions.forEach((a, k) => {
        if (k === callEdge || k === foldEdge) return;
        const e = node.ev[k * n + i] / node.pot;
        const f = node.strategy[k * n + i];
        raise = raise ? { f: raise.f + f, e: Math.max(raise.e, e) } : { f, e };
      });
      const combo = hands[p][i];
      const evCall = node.ev[callEdge * n + i] / node.pot;
      const evFold = node.ev[foldEdge * n + i] / node.pot;
      out.push({
        line: chunk.header.line,
        key: `${position}|${flopRealisationCategory([comboHi(combo), comboLo(combo)], board)}`,
        train,
        w,
        x: (equities[i] * raked) / node.pot,
        y: evCall - evFold + node.toCall / node.pot,
        toCall: node.toCall / node.pot,
        fold: { f: node.strategy[foldEdge * n + i], e: evFold },
        call: { f: node.strategy[callEdge * n + i], e: evCall },
        raise,
        ...(allIn ? { allIn: true } : {}),
      });
    }
  });
  return out;
}

/** Every chunk of the sets under `dir` (`<dir>/<set>/<tree>/<line>/<flop>.bin`). */
export function librarySamples(dir: string, sets: readonly string[], tree = FLOP_PROFILE.tree): { samples: Sample[]; chunks: number } {
  const samples: Sample[] = [];
  let chunks = 0;
  for (const set of sets) {
    const root = join(dir, set, tree);
    if (!existsSync(root)) continue;
    for (const line of readdirSync(root).sort()) {
      if (line.endsWith(".json")) continue;
      for (const file of readdirSync(join(root, line)).sort()) {
        if (!file.endsWith(".bin")) continue;
        const bytes = readFileSync(join(root, line, file));
        const chunk = decodeChunk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        for (const s of chunkSamples(chunk)) samples.push(s);
        chunks += 1;
      }
    }
  }
  return { samples, chunks };
}

/** Least squares per key: R = Σ w·x·y / Σ w·x². */
export function fitRealisation(samples: readonly Sample[]): Map<string, { r: number; weight: number }> {
  const sums = new Map<string, { xy: number; xx: number; w: number }>();
  for (const s of samples) {
    const t = sums.get(s.key) ?? { xy: 0, xx: 0, w: 0 };
    t.xy += s.w * s.x * s.y;
    t.xx += s.w * s.x * s.x;
    t.w += s.w;
    sums.set(s.key, t);
  }
  return new Map([...sums].map(([k, t]) => [k, { r: t.xx > 0 ? t.xy / t.xx : 1, weight: t.w }]));
}

export interface Agreement {
  /** The call-or-fold verdict agrees with the library's EVs. */
  sameVerdict: number;
  /** Mean |Δ(call − fold)|, % of the pot. */
  evPot: number;
  /** The approximate grade is Mistake or worse and the library's Perfect or Good. */
  falseAlarm: number;
  /** The library's is Mistake or worse and the approximate one Perfect or Good. */
  miss: number;
  /** Of the approximate Mistakes, the share the library calls Mistake or worse too. */
  mistakePrecision: number;
  /** Of the approximate Perfects, the share the library calls Perfect or Good. */
  perfectPrecision: number;
  /** Both say Perfect/Good, or both say Inaccurate or worse. */
  sameSide: number;
}

const libraryGrade = (s: Sample, action: "call" | "fold"): Grade => {
  const options = [s.fold, s.call, ...(s.raise ? [s.raise] : [])].map((o, k) => ({ action: (k === 0 ? "fold" : "call") as "fold", freq: o.f, ev: o.e }));
  return grade({ options, chosen: action === "fold" ? 0 : 1, pot: 1 }).grade;
};

/** The approximate grade of a sample's call or fold under factor `r` and `margin` (the analysis's `gradeFlopCall`). */
export function approxGrade(delta: number, action: "call" | "fold", margin: number): Grade {
  const beyond = Math.sign(delta) * Math.max(0, Math.abs(delta) - margin);
  const callBest = delta > 0;
  const options = [
    { action: "fold" as const, freq: callBest ? 0 : 1, ev: 0 },
    { action: "call" as const, freq: callBest ? 1 : 0, ev: beyond },
  ];
  return grade({ options, chosen: action === "fold" ? 0 : 1, pot: 1, capAtMistake: true }).grade;
}

/** How a factor table agrees with the library on `samples` (call and fold each count half). */
export function agreement(samples: readonly Sample[], factor: (key: string) => number, margin: number): Agreement {
  let w = 0;
  let verdict = 0;
  let ev = 0;
  let falseAlarm = 0;
  let miss = 0;
  let mistakes = 0;
  let mistakesRight = 0;
  let perfects = 0;
  let perfectsRight = 0;
  let side = 0;
  for (const s of samples) {
    const delta = factor(s.key) * s.x - s.toCall;
    const truth = s.call.e - s.fold.e;
    w += s.w;
    if (delta > 0 === truth > 0) verdict += s.w;
    ev += s.w * Math.abs(delta - truth);
    for (const action of ["call", "fold"] as const) {
      const lib = gradeRank(libraryGrade(s, action));
      const ours = gradeRank(approxGrade(delta, action, margin));
      const half = s.w / 2;
      if (ours >= 3 && lib <= 1) falseAlarm += half;
      if (lib >= 3 && ours <= 1) miss += half;
      if (ours >= 3) {
        mistakes += half;
        if (lib >= 3) mistakesRight += half;
      }
      if (ours === 0) {
        perfects += half;
        if (lib <= 1) perfectsRight += half;
      }
      if (ours >= 2 === lib >= 2) side += half;
    }
  }
  return {
    sameVerdict: verdict / w,
    evPot: (100 * ev) / w,
    falseAlarm: falseAlarm / w,
    miss: miss / w,
    mistakePrecision: mistakes > 0 ? mistakesRight / mistakes : 1,
    perfectPrecision: perfects > 0 ? perfectsRight / perfects : 1,
    sameSide: side / w,
  };
}

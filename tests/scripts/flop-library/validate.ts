/**
 * How good is reading a flop from its representative? (`--validate`)
 *
 * For every solved flop that is not a representative but whose
 * representative is solved on the same line, each flop node is read two
 * ways for every combo of the real flop's own solve:
 *
 * - **truth**: the combo's own strategy and EVs in its own solve;
 * - **mapped**: what the library would give it - the reach-weighted mean of
 *   its hand category on the representative (`categoryReader`), exactly as
 *   the analysis reads a mapped flop;
 * - and, as the floor, **own categories**: the mean of its category on its
 *   own flop - the error of reading by category at all, with no mapping.
 *
 * Reported per pair, reach-weighted over the flop nodes both solves share:
 * the total-variation distance between the strategies (½ Σ |Δfreq|), the
 * mean |ΔEV| per action in % of the pot, how often the highest-frequency
 * action agrees, and how often the passive action (check or call) gets the
 * same grade (§2) under both.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { categoryReader, flopBucket } from "../../../frontend/src/lib/analysis/flopLibrary.js";
import { grade } from "../../../frontend/src/lib/analysis/grading.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";
import {
  comboHi,
  comboLo,
  decodeChunk,
  FLOP_REPRESENTATIVES,
  flopCards,
  mapFlop,
  rangesAt,
  type FlopChunk,
} from "../../../frontend/src/lib/solver/index.js";

export interface PairReport {
  line: string;
  flop: string;
  representative: string;
  distance: number;
  nodes: number;
  /** Mapped vs truth. */
  tv: number;
  evPot: number;
  sameBest: number;
  samePassiveGrade: number;
  /** Own categories vs truth: the floor. */
  tvOwn: number;
  evPotOwn: number;
}

export function comparePair(flop: FlopChunk, rep: FlopChunk): PairReport {
  const truth = flop.result;
  const own = categoryReader(truth, toIndices(truth.board));
  const mapped = categoryReader(rep.result, toIndices(rep.result.board));
  const board = toIndices(truth.board);
  const repPaths = new Map(rep.result.nodes.map((n, i) => [`${n.kind}:${n.path}`, i]));
  let w = 0;
  let tv = 0;
  let ev = 0;
  let best = 0;
  let passive = 0;
  let tvOwn = 0;
  let evOwn = 0;
  let nodes = 0;
  truth.nodes.forEach((node, index) => {
    if (node.kind !== "action") return;
    const at = repPaths.get(`action:${node.path}`);
    if (at === undefined) return;
    nodes += 1;
    const p = node.player;
    const n = truth.hands[p].length;
    const count = node.actions.length;
    const reach = rangesAt(truth, index)[p];
    const passiveEdge = node.actions.findIndex((a) => a.kind === "check" || a.kind === "call");
    truth.hands[p].forEach((combo, i) => {
      const r = reach[i];
      if (!(r > 0)) return;
      const bucket = flopBucket([comboHi(combo), comboLo(combo)], board);
      const m = mapped(at, bucket);
      const o = own(index, bucket);
      if (!m || !o) return;
      const freq = Array.from({ length: count }, (_, a) => node.strategy[a * n + i]);
      const evs = Array.from({ length: count }, (_, a) => node.ev[a * n + i]);
      let d = 0;
      let dOwn = 0;
      let e = 0;
      let eOwn = 0;
      for (let a = 0; a < count; a += 1) {
        d += Math.abs(freq[a] - m.strategy[a]);
        dOwn += Math.abs(freq[a] - o.strategy[a]);
        e += Math.abs(evs[a] - m.ev[a]);
        eOwn += Math.abs(evs[a] - o.ev[a]);
      }
      w += r;
      tv += (r * d) / 2;
      tvOwn += (r * dOwn) / 2;
      ev += (r * e) / count / node.pot;
      evOwn += (r * eOwn) / count / node.pot;
      const argmax = (xs: number[]) => xs.indexOf(Math.max(...xs));
      if (argmax(freq) === argmax(m.strategy)) best += r;
      if (passiveEdge >= 0) {
        const opts = (f: number[], v: number[]) => f.map((x, a) => ({ action: "check" as const, freq: x, ev: v[a] }));
        const g1 = grade({ options: opts(freq, evs), chosen: passiveEdge, pot: node.pot }).grade;
        const g2 = grade({ options: opts(m.strategy, m.ev), chosen: passiveEdge, pot: node.pot }).grade;
        if (g1 === g2) passive += r;
      }
    });
  });
  const mapping = mapFlop(flopCards(flop.header.flop));
  return {
    line: flop.header.line,
    flop: flop.header.flop,
    representative: rep.header.flop,
    distance: mapping.distance,
    nodes,
    tv: tv / w,
    evPot: (100 * ev) / w,
    sameBest: best / w,
    samePassiveGrade: passive / w,
    tvOwn: tvOwn / w,
    evPotOwn: (100 * evOwn) / w,
  };
}

/** Every (flop, representative) pair solved on the same line under `treeDir`. */
export function validateDir(treeDir: string, entries: readonly { line: string; flop: string }[]): PairReport[] {
  const has = new Set(entries.map((e) => `${e.line}/${e.flop}`));
  const load = (line: string, flop: string) => decodeChunk(readFileSync(join(treeDir, line, `${flop}.bin`)));
  const out: PairReport[] = [];
  for (const entry of entries) {
    if (FLOP_REPRESENTATIVES.includes(entry.flop)) continue;
    const rep = mapFlop(flopCards(entry.flop)).representative;
    if (!has.has(`${entry.line}/${rep}`)) continue;
    out.push(comparePair(load(entry.line, entry.flop), load(entry.line, rep)));
  }
  return out;
}

/**
 * How far one chart set is from another read with its earliest seats folded:
 * the evidence for reading 8- and 7-handed tables on the 9-max sets (and
 * 5- to 3-handed on 6-max) instead of solving them (docs/CHARTS.md §6.2).
 *
 * For every node of the smaller set, the node of the bigger set at the same
 * line behind `folds` leading folds: the actor's range-weighted action shares
 * (what a report quotes), and per hand class the frequency difference
 * (L1 / 2 = the share of the class that plays differently) and the EV
 * difference, weighted by the smaller set's reach and range.
 */

import { CLASS_COMBOS } from "../../../frontend/src/lib/solver/handClasses.js";
import type { ChartSet } from "../../../frontend/src/lib/charts/format.js";

export interface SetComparison {
  /** Nodes of the smaller set; those the bigger set also has. */
  nodes: number;
  matched: number;
  /** Reach-weighted mean over matched nodes of the range-weighted per-class frequency difference (L1 / 2). */
  freqDiff: number;
  /** Largest range-weighted action-share difference at a node reached at least 1e-3, and where. */
  worstShare: { line: string; diff: number };
  /** Reach-weighted mean absolute EV difference, bb, over classes in range. */
  evDiff: number;
  /** Action shares at the first decision of each seat (RFI), smaller vs bigger. */
  rfi: { seat: string; small: number; big: number }[];
}

function shares(set: ChartSet, line: string): number[] | null {
  const node = set.nodes.get(line);
  if (!node) return null;
  let total = 0;
  for (let i = 0; i < 169; i += 1) total += CLASS_COMBOS[i] * node.range[i];
  return node.options.map((_, a) => {
    let s = 0;
    for (let i = 0; i < 169; i += 1) s += CLASS_COMBOS[i] * node.range[i] * node.freq[a * 169 + i];
    return s / total;
  });
}

export function compareSets(small: ChartSet, big: ChartSet): SetComparison {
  const folds = big.game.positions.length - small.game.positions.length;
  const prefix = "f".repeat(folds);
  let matched = 0;
  let weight = 0;
  let freqDiff = 0;
  let evDiff = 0;
  let evWeight = 0;
  let worst = { line: "", diff: 0 };
  for (const node of small.nodes.values()) {
    const other = big.nodes.get(prefix + node.line);
    if (!other || other.options.length !== node.options.length) continue;
    matched += 1;
    let total = 0;
    let diff = 0;
    for (let i = 0; i < 169; i += 1) {
      const w = CLASS_COMBOS[i] * node.range[i];
      if (w <= 0) continue;
      let l1 = 0;
      for (let a = 0; a < node.options.length; a += 1) {
        l1 += Math.abs(node.freq[a * 169 + i] - other.freq[a * 169 + i]);
        evDiff += node.reach * w * Math.abs(node.ev[a * 169 + i] - other.ev[a * 169 + i]);
        evWeight += node.reach * w;
      }
      diff += (w * l1) / 2;
      total += w;
    }
    if (total > 0) {
      freqDiff += node.reach * (diff / total);
      weight += node.reach;
    }
    if (node.reach >= 1e-3) {
      const a = shares(small, node.line) as number[];
      const b = shares(big, prefix + node.line) as number[];
      const d = Math.max(...a.map((x, k) => Math.abs(x - b[k])));
      if (d > worst.diff) worst = { line: node.line, diff: d };
    }
  }
  const rfi: SetComparison["rfi"] = [];
  small.game.positions.forEach((seat, k) => {
    if (seat === "BB") return;
    const a = shares(small, "f".repeat(k));
    const b = shares(big, prefix + "f".repeat(k));
    if (!a || !b) return;
    rfi.push({ seat, small: 1 - a[0], big: 1 - b[0] });
  });
  return {
    nodes: small.nodes.size,
    matched,
    freqDiff: weight > 0 ? freqDiff / weight : 0,
    worstShare: worst,
    evDiff: evWeight > 0 ? evDiff / evWeight : 0,
    rfi,
  };
}

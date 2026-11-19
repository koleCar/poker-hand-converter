/**
 * Totals of a v0 chart set (docs/PREFLOP-PLAN.md §4.2 step 4: totals, not
 * single hands): raise-first-in by position, the small blind's first-in
 * strategy, the big blind's defence against each open (everyone between
 * folding), and each seat's 3-bet frequency against a single open. Shares
 * are of the actor's range (combo- and reach-weighted), in percent to 0.1.
 */

import type { ChartSet } from "../../../web/src/lib/charts/format.js";
import { split, vsOpenLine } from "../preflop-charts/report.js";

export interface SetTotals {
  /** Raise (or all-in) first in, by seat; every seat but the one with the option. */
  rfi: Record<string, number>;
  /** The small blind first in: fold / complete / raise. Null when the set has no such node. */
  sb: { fold: number; limp: number; raise: number } | null;
  /** The big blind against each seat's open, everyone between folding: continue (call + 3-bet), call, 3-bet. */
  bbDefence: Record<string, { defend: number; call: number; threeBet: number }>;
  /** Per seat: 3-bet share against a single open (no callers), averaged over the openers by how often the node is reached. */
  threeBet: Record<string, number>;
}

const pct = (x: number) => Math.round(1000 * x) / 10;
const raised = (s: Record<string, number>) => (s.raise ?? 0) + (s.allin ?? 0);

export function setTotals(charts: ChartSet): SetTotals {
  const positions = charts.game.positions;
  const n = positions.length;
  const rfi: Record<string, number> = {};
  // The last seat in action order has the option (the big blind, or the straddler): it never acts first in.
  for (let p = 0; p < n - 1; p += 1) {
    const s = split(charts, "f".repeat(p));
    if (s) rfi[positions[p]] = pct(raised(s));
  }
  const sbIndex = positions.indexOf("SB");
  const sbSplit = sbIndex >= 0 ? split(charts, "f".repeat(sbIndex)) : null;
  const sb = sbSplit ? { fold: pct(sbSplit.fold ?? 0), limp: pct(sbSplit.call ?? 0), raise: pct(raised(sbSplit)) } : null;

  const bbDefence: SetTotals["bbDefence"] = {};
  const bb = positions.indexOf("BB");
  for (let o = 0; o < bb; o += 1) {
    const s = split(charts, vsOpenLine(positions, positions[o], "BB"));
    if (!s) continue;
    bbDefence[positions[o]] = { defend: pct(1 - (s.fold ?? 0)), call: pct(s.call ?? 0), threeBet: pct(raised(s)) };
  }

  const threeBet: Record<string, number> = {};
  for (let d = 1; d < n; d += 1) {
    let weight = 0;
    let sum = 0;
    for (let o = 0; o < d; o += 1) {
      const line = vsOpenLine(positions, positions[o], positions[d]);
      const node = charts.nodes.get(line);
      const s = split(charts, line);
      if (!node || !s) continue;
      weight += node.reach;
      sum += node.reach * raised(s);
    }
    if (weight > 0) threeBet[positions[d]] = pct(sum / weight);
  }
  return { rfi, sb, bbDefence, threeBet };
}

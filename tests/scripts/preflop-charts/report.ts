/**
 * The tables docs/CHARTS.md §8 quotes, from a chart set: raise-first-in
 * widths, every "folded to the defender" response to an open (fold / call /
 * 3-bet), the opener against a 3-bet, the big blind against a limp.
 *
 *     npx vitest run --config scripts/preflop-charts/vitest.config.ts report
 *
 * prints them for the committed set (`report.test.ts`).
 */

import type { ChartSet } from "../../../frontend/src/lib/charts/format.js";
import { CLASS_COMBOS } from "../../../frontend/src/lib/solver/handClasses.js";

const POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

/** Per action, share of the actor's range at a node (combo- and reach-weighted). */
function split(charts: ChartSet, line: string): Record<string, number> | null {
  const node = charts.nodes.get(line);
  if (!node) return null;
  const out: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i < 169; i += 1) total += CLASS_COMBOS[i] * node.range[i];
  node.options.forEach((o, a) => {
    let sum = 0;
    for (let i = 0; i < 169; i += 1) sum += CLASS_COMBOS[i] * node.range[i] * node.freq[a * 169 + i];
    out[o.action] = (out[o.action] ?? 0) + sum / total;
  });
  return out;
}

const pct = (x: number | undefined) => (x === undefined ? "  -  " : `${(100 * x).toFixed(1)}%`.padStart(6));

/** The tables docs/CHARTS.md §8 quotes. */
export function report(charts: ChartSet): string {
  const lines: string[] = [];
  lines.push("RFI (raise / limp):");
  for (let p = 0; p < 5; p += 1) {
    const s = split(charts, "f".repeat(p));
    if (!s) continue;
    lines.push(`  ${POSITIONS[p].padEnd(4)} ${pct(1 - (s.fold ?? 0))}  raise ${pct(s.raise)}${s.call ? `  limp ${pct(s.call)}` : ""}`);
  }
  lines.push("Facing an open (folded to the defender): continue = call + 3-bet");
  for (let o = 0; o < 5; o += 1) {
    for (let d = o + 1; d < 6; d += 1) {
      const line = "f".repeat(o) + "r" + "f".repeat(d - o - 1);
      const s = split(charts, line);
      if (!s) {
        lines.push(`  ${POSITIONS[d].padEnd(4)} vs ${POSITIONS[o].padEnd(4)} (${line}) not in the set`);
        continue;
      }
      lines.push(
        `  ${POSITIONS[d].padEnd(4)} vs ${POSITIONS[o].padEnd(4)} continue ${pct(1 - (s.fold ?? 0))}  call ${pct(s.call)}  3-bet ${pct(s.raise)}`,
      );
    }
  }
  lines.push("Opener facing a 3-bet (heads-up):");
  for (const [name, line] of [
    ["UTG vs BTN", "rffrff"],
    ["CO vs BTN", "ffrrff"],
    ["BTN vs BB", "fffrfr"],
    ["BTN vs SB", "fffrrf"],
    ["SB vs BB", "ffffrr"],
  ] as const) {
    const s = split(charts, line);
    lines.push(`  ${name.padEnd(11)} ${s ? `fold ${pct(s.fold)}  call ${pct(s.call)}  4-bet ${pct(s.raise)}` : "not in the set"}`);
  }
  const limp = split(charts, "ffffc");
  if (limp) lines.push(`BB vs SB limp: check ${pct(limp.check)}  raise ${pct(limp.raise)}`);
  return lines.join("\n");
}


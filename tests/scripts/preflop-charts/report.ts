/**
 * The tables docs/CHARTS.md §8 quotes, from a chart set of any table size:
 * raise-first-in widths, every "folded to the defender" response to an open
 * (fold / call / 3-bet), the opener against a 3-bet, the big blind against a
 * limp.
 *
 *     npm run charts:report                                   # every committed set
 *     CHARTS_FILE=path npm run charts:report                  # one file
 *
 * prints them (`report.test.ts`).
 */

import type { ChartSet } from "../../../frontend/src/lib/charts/format.js";
import { CLASS_COMBOS } from "../../../frontend/src/lib/solver/handClasses.js";

/** Per action, share of the actor's range at a node (combo- and reach-weighted). */
export function split(charts: ChartSet, line: string): Record<string, number> | null {
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

/** The line where `defender` faces an open by `opener`, everyone else folding. */
export function vsOpenLine(positions: readonly string[], opener: string, defender: string): string {
  const o = positions.indexOf(opener);
  const d = positions.indexOf(defender);
  return "f".repeat(o) + "r" + "f".repeat(d - o - 1);
}

/** The opener's node facing a 3-bet from `threeBettor`, everyone else folding. */
export function vs3betLine(positions: readonly string[], opener: string, threeBettor: string): string {
  const o = positions.indexOf(opener);
  const t = positions.indexOf(threeBettor);
  return vsOpenLine(positions, opener, threeBettor) + "r" + "f".repeat(positions.length - 1 - t);
}

const pct = (x: number | undefined) => (x === undefined ? "  -  " : `${(100 * x).toFixed(1)}%`.padStart(6));

/** The tables docs/CHARTS.md §8 quotes. */
export function report(charts: ChartSet): string {
  const positions = charts.game.positions;
  const n = positions.length;
  const lines: string[] = [];
  lines.push(`${charts.id} (${charts.version}): ${charts.nodes.size} nodes`);
  lines.push("RFI (raise / limp):");
  for (let p = 0; p < n - 1; p += 1) {
    const s = split(charts, "f".repeat(p));
    if (!s) continue;
    lines.push(`  ${positions[p].padEnd(5)} ${pct(1 - (s.fold ?? 0))}  raise ${pct(s.raise ?? s.allin)}${s.call ? `  limp ${pct(s.call)}` : ""}`);
  }
  lines.push("Facing an open (folded to the defender): continue = call + 3-bet");
  for (let o = 0; o < n - 1; o += 1) {
    for (let d = o + 1; d < n; d += 1) {
      const line = vsOpenLine(positions, positions[o], positions[d]);
      const s = split(charts, line);
      if (!s) {
        lines.push(`  ${positions[d].padEnd(5)} vs ${positions[o].padEnd(5)} (${line}) not in the set`);
        continue;
      }
      lines.push(
        `  ${positions[d].padEnd(5)} vs ${positions[o].padEnd(5)} continue ${pct(1 - (s.fold ?? 0))}  call ${pct(s.call)}  3-bet ${pct((s.raise ?? 0) + (s.allin ?? 0))}`,
      );
    }
  }
  lines.push("Opener facing a 3-bet (heads-up):");
  for (const [opener, threeBettor] of [
    [positions[0], "BTN"],
    ["CO", "BTN"],
    ["BTN", "BB"],
    ["BTN", "SB"],
    ["SB", "BB"],
  ] as const) {
    const line = vs3betLine(positions, opener, threeBettor);
    const s = split(charts, line);
    const name = `${opener} vs ${threeBettor}`;
    lines.push(`  ${name.padEnd(11)} ${s ? `fold ${pct(s.fold)}  call ${pct(s.call)}  4-bet ${pct((s.raise ?? 0) + (s.allin ?? 0))}` : "not in the set"}`);
  }
  const limp = split(charts, "f".repeat(n - 2) + "c");
  if (limp) lines.push(`BB vs SB limp: check ${pct(limp.check)}  raise ${pct(limp.raise)}`);
  lines.push(...limpReport(charts));
  return lines.join("\n");
}

/** The line where seat `seat` faces a limp by `limper`, everyone else folding. */
export function vsLimpLine(limper: number, seat: number): string {
  return "f".repeat(limper) + "c" + "f".repeat(seat - limper - 1);
}

/**
 * Limped pots (`charts/4`, docs/CHARTS.md §8.3): every seat behind the first
 * seat's limp and behind the cutoff's (fold / over-limp / isolate; the big
 * blind check / isolate), and the limper facing the button's isolation.
 */
export function limpReport(charts: ChartSet): string[] {
  const positions = charts.game.positions;
  const n = positions.length;
  const btn = positions.indexOf("BTN");
  if (!charts.nodes.has("c" + "f".repeat(btn - 1))) return [];
  const out: string[] = ["Facing one limp, everyone else folding (fold / over-limp / isolate; BB: check / isolate):"];
  for (const limper of [0, btn - 1]) {
    for (let seat = limper + 1; seat < n; seat += 1) {
      const line = vsLimpLine(limper, seat);
      const s = split(charts, line);
      const who = `${positions[seat]} vs ${positions[limper]} limp`;
      if (!s) {
        out.push(`  ${who.padEnd(18)} (${line}) not in the set`);
        continue;
      }
      const iso = (s.raise ?? 0) + (s.allin ?? 0);
      out.push(
        positions[seat] === "BB"
          ? `  ${who.padEnd(18)} check ${pct(s.check)}  isolate ${pct(iso)}`
          : `  ${who.padEnd(18)} fold ${pct(s.fold)}  over-limp ${pct(s.call)}  isolate ${pct(iso)}`,
      );
    }
  }
  out.push("The limper facing the button's isolation (fold / call / re-raise):");
  for (const limper of [0, btn - 1]) {
    const line = vsLimpLine(limper, btn) + "r" + "ff";
    const s = split(charts, line);
    out.push(`  ${positions[limper].padEnd(5)} ${s ? `fold ${pct(s.fold)}  call ${pct(s.call)}  re-raise ${pct((s.raise ?? 0) + (s.allin ?? 0))}` : "not in the set"}`);
  }
  const limpers = [...charts.nodes.values()].filter((node) => node.limpers.some((p) => p !== "SB" && p !== "BB")).length;
  out.push(`Nodes behind an open limp: ${limpers} of ${charts.nodes.size}`);
  return out;
}

/**
 * Generates the committed preflop chart set:
 * `frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json`.
 *
 *     cd tests && npm run charts:generate
 *
 * Deterministic: the equity sample is seeded and the solver reads no clock, so
 * a rerun with the same code writes the same bytes (the script says whether
 * the file changed). The equity table is cached in `.cache/` (git-ignored)
 * because it is the slowest step and depends only on its boards and seed.
 *
 * Environment (for experiments; the committed set uses the defaults):
 * `CHARTS_ITERATIONS`, `CHARTS_BOARDS`, `CHARTS_OUT`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

import { generateChartSet, PRODUCTION_ITERATIONS } from "../../../frontend/src/lib/charts/generate.js";
import { loadCharts, serializeCharts } from "../../../frontend/src/lib/charts/format.js";
import { nodeReaches } from "../../../frontend/src/lib/charts/build.js";
import { CLASS_COMBOS } from "../../../frontend/src/lib/solver/handClasses.js";
import {
  DEFAULT_EQUITY_BOARDS,
  DEFAULT_EQUITY_SEED,
  preflopEquityTable,
  type PreflopEquityTable,
} from "../../../frontend/src/lib/solver/preflopEquity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const OUT = process.env.CHARTS_OUT ?? join(ROOT, "frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json");
const ITERATIONS = Number(process.env.CHARTS_ITERATIONS ?? PRODUCTION_ITERATIONS);
const BOARDS = Number(process.env.CHARTS_BOARDS ?? DEFAULT_EQUITY_BOARDS);

function cachedEquity(): PreflopEquityTable {
  const dir = join(HERE, ".cache");
  const file = join(dir, `equity-${BOARDS}-${DEFAULT_EQUITY_SEED}.bin`);
  const meta = `${file}.json`;
  if (existsSync(file) && existsSync(meta)) {
    const bytes = readFileSync(file);
    const equity = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { equity, ...JSON.parse(readFileSync(meta, "utf8")) };
  }
  const t0 = performance.now();
  const table = preflopEquityTable({ boards: BOARDS, seed: DEFAULT_EQUITY_SEED });
  console.log(`equity table: ${BOARDS} boards in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, Buffer.from(table.equity.buffer));
  writeFileSync(meta, JSON.stringify({ boards: table.boards, seed: table.seed, standardError: table.standardError }));
  return table;
}

it("generates the 6-max 100bb chart set", () => {
  const started = performance.now();
  const equity = cachedEquity();
  let last = performance.now();
  const result = generateChartSet({
    equity,
    equityBoards: BOARDS,
    iterations: ITERATIONS,
    onProgress: (p) => {
      if (p.phase === "solve") {
        const now = performance.now();
        console.log(`iteration ${p.iteration}: NashConv ${p.nashConvMbb?.toFixed(2)} mbb/hand (${((now - last) / 1000).toFixed(1)} s)`);
        last = now;
      }
    },
  });
  const text = serializeCharts(result.charts);
  const previous = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  const seconds = (performance.now() - started) / 1000;

  // Report.
  const charts = loadCharts(JSON.parse(text));
  const width = (line: string) => {
    const node = charts.nodes.get(line);
    if (!node) return "-";
    const fold = node.options.findIndex((o) => o.action === "fold");
    let sum = 0;
    for (let i = 0; i < 169; i += 1) sum += CLASS_COMBOS[i] * (1 - node.freq[fold * 169 + i]);
    return `${((100 * sum) / 1326).toFixed(1)}%`;
  };
  const share = (line: string, action: string) => {
    const node = charts.nodes.get(line);
    if (!node) return "-";
    const a = node.options.findIndex((o) => o.action === action);
    if (a < 0) return "-";
    let sum = 0;
    let total = 0;
    for (let i = 0; i < 169; i += 1) {
      const w = CLASS_COMBOS[i] * node.range[i];
      sum += w * node.freq[a * 169 + i];
      total += w;
    }
    return `${((100 * sum) / total).toFixed(1)}%`;
  };
  console.log("\n=== preflop charts ===");
  console.log(`file: ${OUT}`);
  console.log(`bytes: ${Buffer.byteLength(text)}; nodes: ${charts.nodes.size} of ${result.tree.actionNodes}`);
  console.log(`changed: ${previous === null ? "new file" : previous === text ? "no (identical bytes)" : "yes"}`);
  console.log(`time: ${seconds.toFixed(1)} s for ${result.solver.iterations} iterations`);
  console.log(`NashConv: ${result.final.nashConvMbb.toFixed(3)} mbb/hand; per position ${result.final.gainMbb.map((g) => g.toFixed(3)).join(", ")}`);
  console.log(`heads-up BvB: ${JSON.stringify(result.headsUp)}`);
  console.log(`strategy change per checkpoint: ${result.convergence.map((c) => `${c.iteration}:${c.strategyChange}`).join(" ")}`);
  console.log(`RFI: UTG ${width("")} HJ ${width("f")} CO ${width("ff")} BTN ${width("fff")} SB ${width("ffff")} (SB limp ${share("ffff", "call")}, raise ${share("ffff", "raise")})`);
  console.log(`BB vs BTN open: defend ${width("fffrf")} (call ${share("fffrf", "call")}, 3-bet ${share("fffrf", "raise")})`);
  console.log(`SB vs BTN open: 3-bet ${share("fffr", "raise")}, call ${share("fffr", "call")}`);
  console.log(`BTN vs CO open: 3-bet ${share("ffr", "raise")}, call ${share("ffr", "call")}`);
  console.log(`CO open vs BTN 3-bet: 4-bet ${share("ffrrff", "raise")}, call ${share("ffrrff", "call")}, fold ${share("ffrrff", "fold")}`);
  const reaches = nodeReaches(result.solver);
  const counts = [1e-3, 1e-4, 2e-5, 1e-5, 1e-6, 0].map(
    (t) => `>=${t}: ${Array.from(reaches).filter((r) => r >= t).length}`,
  );
  console.log(`action nodes by reach: ${counts.join(", ")}`);
  const excluded = (result.charts.model as { excluded: { unconverged: unknown[] } }).excluded.unconverged;
  console.log(`left out as unconverged: ${excluded.length} ${JSON.stringify(excluded)}`);
});

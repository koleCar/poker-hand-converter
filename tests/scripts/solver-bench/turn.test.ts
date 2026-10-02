/**
 * Turn benchmark (phase A5a): the speed-ups one at a time, and the gap the
 * coarse tree leaves against a fuller one. `npm run bench:turn` from
 * `tests/`; several minutes. Times are printed, not asserted (they describe
 * the machine); convergence is asserted, so a regression fails loudly.
 *
 * Spots: a big-blind-defence-like range against a button-like range, ~300 v
 * ~240 combos on the turn, on twelve boards of every suit structure (rainbow,
 * three suits, two-tone, monotone, paired), single-raised pot depth
 * (pot 10, 90 behind). Amounts in big blinds, rake 5% capped at 3.
 *
 * 1. **Speed**, each row adding one thing:
 *    - `phase S`: the phase-S turn tree (75% + all-in, raises 75% + all-in,
 *      one raise, on both streets), all 44 river cards;
 *    - `A5a menu`: the A5a tree (`lib/analysis/turn.ts`): the turn's all-in
 *      only up to three pots, a river below it of 75% and all-in with no
 *      raise (the hand's own turn sizes, which grading adds, are not in these
 *      spots);
 *    - `+ isomorphism`: one river card per suit class;
 *    - `+ sampling`: stratified public chance sampling in four strata.
 *    Exploitability is always measured exactly over the full tree.
 * 2. **The gap of the coarse tree**, on four boards: the A5a solve against a
 *    solve of the same spot with the river menu the river grades use (33 /
 *    75 / 150% and all-in, raises 75% and all-in, two raises) and the turn
 *    all-in always offered, solved to 0.5%. Reported: the difference in the
 *    game's value (% of the pot), and per hand at the first decision and
 *    facing a bet after a check, the mean absolute difference in how often
 *    the hand checks (or folds) and in the EV of checking (or calling), %
 *    of the pot; plus how often the two would give a hand's check or bet the
 *    same grade.
 */

import { describe, expect, it } from "vitest";

import {
  buildTurnGame,
  parseCards,
  parseRange,
  rangeSize,
  solveBuilt,
  type BetMenu,
  type SolveResult,
  type TurnSpot,
} from "../../../frontend/src/lib/solver/index.js";
import { grade } from "../../../frontend/src/lib/analysis/grading.js";
import {
  TURN_DCFR,
  TURN_MENU,
  TURN_RAISE_CAP,
  TURN_RIVER_MENU,
  TURN_RIVER_RAISE_CAP,
} from "../../../frontend/src/lib/analysis/turn.js";

const BB_DEF =
  "TT-22,AJs-A2s,KJs-K5s,QJs-Q8s,JTs-J8s,T9s-T7s,98s-96s,87s-85s,76s-75s,65s-64s,54s,AJo-A8o,KJo-K9o,QJo-Q9o,JTo-J9o,T9o";
const BTN = "AA-22,AKs-A2s,KQs-K8s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,65s,AKo-ATo,KQo-KTo,QJo";

const BOARDS = [
  "QsJh7d4c", // four suits
  "Ks8h3d2c",
  "AsTd6h6c",
  "9h8c5d2h", // three suits
  "JdTc4h9c",
  "7c6c4d2s",
  "Ks8h3s2h", // two suits
  "9h8h2c5h",
  "QdJs5d3s",
  "AsKs7s2d", // monotone flop + a fourth suit
  "Th7h3h2h", // monotone turn
  "KsKh7d2c", // paired, two interchangeable suits
].map((b) => [b.slice(0, 2), b.slice(2, 4), b.slice(4, 6), b.slice(6, 8)]);

const PHASE_S: BetMenu = { bet: [0.75], raise: [0.75], allIn: true };
const RICH_RIVER: BetMenu = { bet: [0.33, 0.75, 1.5], raise: [0.75], allIn: true };
const RICH_TURN: BetMenu = { bet: [0.75], raise: [0.75], allIn: true };

function spot(board: string[], over: Partial<TurnSpot>): TurnSpot {
  return {
    board,
    ranges: [BB_DEF, BTN],
    pot: 10,
    stack: 90,
    menus: [TURN_MENU, TURN_MENU],
    riverMenus: [TURN_RIVER_MENU, TURN_RIVER_MENU],
    raiseCap: TURN_RAISE_CAP,
    riverRaiseCap: TURN_RIVER_RAISE_CAP,
    allInThreshold: 0.1,
    minBet: 1,
    rake: { percent: 0.05, cap: 3 },
    ...over,
  };
}

interface Config {
  name: string;
  over: Partial<TurnSpot>;
  sampling?: { groups: number; seed: number };
  checkFrom: number;
  checkEvery: number;
}

const CONFIGS: Config[] = [
  {
    name: "phase S tree, 44 rivers",
    over: { menus: [PHASE_S, PHASE_S], riverMenus: [PHASE_S, PHASE_S], riverRaiseCap: 1 },
    checkFrom: 30,
    checkEvery: 10,
  },
  { name: "A5a menu", over: {}, checkFrom: 30, checkEvery: 10 },
  { name: "A5a menu + isomorphism", over: { isomorphism: true }, checkFrom: 30, checkEvery: 10 },
  {
    name: "A5a menu + isomorphism + sampling (4)",
    over: { isomorphism: true },
    sampling: { groups: 4, seed: 1 },
    checkFrom: 120,
    checkEvery: 40,
  },
];

const quant = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function solve(s: TurnSpot, c: Pick<Config, "sampling" | "checkFrom" | "checkEvery">, target: number): { result: SolveResult; ms: number } {
  const t0 = performance.now();
  const result = solveBuilt(buildTurnGame(s), {
    maxIterations: 2000,
    targetExploitability: target,
    checkFrom: c.checkFrom,
    checkEvery: c.checkEvery,
    dcfr: TURN_DCFR,
    sampling: c.sampling,
    nodes: "turn",
  });
  return { result, ms: performance.now() - t0 };
}

describe("turn benchmark", () => {
  it("solves every board to 1% of the pot, each speed-up in turn", () => {
    // Warm the JIT.
    solve(spot(BOARDS[0], {}), CONFIGS[1], 5);
    const summary = [];
    for (const config of CONFIGS) {
      const ms: number[] = [];
      const its: number[] = [];
      const mb: number[] = [];
      let worst = 0;
      for (const board of BOARDS) {
        const { result, ms: t } = solve(spot(board, config.over), config, 1);
        expect(result.exploitabilityPct, `${config.name} ${board.join("")}`).toBeLessThanOrEqual(1);
        ms.push(t);
        its.push(result.iterations);
        mb.push(result.memoryBytes / 1e6);
        worst = Math.max(worst, result.exploitabilityPct);
      }
      summary.push({
        config: config.name,
        "median ms": Math.round(quant(ms, 0.5)),
        "p90 ms": Math.round(quant(ms, 0.9)),
        "max ms": Math.round(quant(ms, 1)),
        "iterations (median)": quant(its, 0.5),
        "worst expl %pot": Number(worst.toFixed(3)),
        "solver MB (median)": Number(quant(mb, 0.5).toFixed(1)),
      });
    }
    const board = parseCards(BOARDS[0]);
    console.log(`ranges: ${rangeSize(parseRange(BB_DEF), board).toFixed(0)} v ${rangeSize(parseRange(BTN), board).toFixed(0)} combos`);
    console.table(summary);
  });

  it("measures the gap of the coarse tree against a fuller one", () => {
    const rows = [];
    for (const board of [BOARDS[0], BOARDS[3], BOARDS[6], BOARDS[10]]) {
      const coarse = solve(spot(board, { isomorphism: true }), CONFIGS[2], 1).result;
      const rich = solve(
        spot(board, {
          isomorphism: true,
          menus: [RICH_TURN, RICH_TURN],
          riverMenus: [RICH_RIVER, RICH_RIVER],
          riverRaiseCap: 2,
        }),
        { checkFrom: 30, checkEvery: 10 },
        0.5,
      ).result;
      expect(rich.exploitabilityPct).toBeLessThanOrEqual(0.5);
      const pot = 10;
      // Compare at the root (first to act) and facing a bet after a check.
      const compare = (path: string, passive: "check" | "call") => {
        const a = coarse.nodes.find((n) => n.path === path && n.kind === "action");
        const b = rich.nodes.find((n) => n.path === path && n.kind === "action");
        if (!a || !b) return null;
        const pa = a.actions.findIndex((x) => x.kind === passive);
        const pb = b.actions.findIndex((x) => x.kind === passive);
        const p = a.player;
        const n = coarse.hands[p].length;
        let freq = 0;
        let ev = 0;
        let agree = 0;
        let count = 0;
        for (let i = 0; i < n; i += 1) {
          const combo = coarse.hands[p][i];
          const j = rich.hands[p].indexOf(combo);
          if (j < 0) continue;
          const m = rich.hands[p].length;
          freq += Math.abs(a.strategy[pa * n + i] - b.strategy[pb * m + j]);
          ev += (Math.abs(a.ev[pa * n + i] - b.ev[pb * m + j]) / pot) * 100;
          // The passive move's grade under each tree, against the options each offers.
          const options = (node: typeof a, k: number, size: number) =>
            node.actions.map((_, x) => ({ action: "check" as const, freq: node.strategy[x * size + k], ev: node.ev[x * size + k] }));
          const ga = grade({ options: options(a, i, n), chosen: pa, pot: a.pot }).grade;
          const gb = grade({ options: options(b, j, m), chosen: pb, pot: b.pot }).grade;
          if (ga === gb) agree += 1;
          count += 1;
        }
        return { freq: freq / count, ev: ev / count, agree: agree / count };
      };
      const root = compare("", "check");
      const vsBet = compare("X-B7.5", "call");
      rows.push({
        board: board.join(""),
        "coarse expl %": Number(coarse.exploitabilityPct.toFixed(2)),
        "rich expl %": Number(rich.exploitabilityPct.toFixed(2)),
        "value gap %pot": Number(((Math.abs(coarse.value[0] - rich.value[0]) / 10) * 100).toFixed(2)),
        "root |Δ check freq|": root ? Number(root.freq.toFixed(3)) : "-",
        "root |Δ EV(check)| %pot": root ? Number(root.ev.toFixed(2)) : "-",
        "root same grade (check)": root ? Number(root.agree.toFixed(3)) : "-",
        "vs bet |Δ call freq|": vsBet ? Number(vsBet.freq.toFixed(3)) : "-",
        "vs bet |Δ EV(call)| %pot": vsBet ? Number(vsBet.ev.toFixed(2)) : "-",
        "vs bet same grade (call)": vsBet ? Number(vsBet.agree.toFixed(3)) : "-",
      });
    }
    console.table(rows);
  });
});

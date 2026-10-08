/**
 * The exploit lab (Learn L4, `lib/solver/lock.ts`, `lib/training/lab.ts`).
 *
 * 1. **The lock** moves a group's share exactly, hands whole in order, the
 *    last one partly; a mask and a fallback do what they say.
 * 2. **The lab on a game solved by hand**: the clairvoyance game (a polarised
 *    bettor against one bluff-catcher, `toys.ts`) at its closed-form
 *    equilibrium. Lock the bluff-catcher's folds and every number the lab
 *    reports — the best response, what it gains, what it risks against the
 *    baseline and against a counter — is worked out by hand below and
 *    matched. These are also the numbers `node-locking-in-rail` and
 *    `when-not-to-exploit` state (their checks recompute the arithmetic).
 * 3. **The river lab**: items are deterministic in their seed, the lock moves
 *    the opponent's share to the preset, the gain is not negative, the
 *    question's answer is the best response's own best action, and the
 *    grader accepts exactly the actions within tolerance of it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { clairvoyanceGame, exploitLab, groupShareOf, lockedStrategy, Solver } from "../../frontend/src/lib/solver/index.js";
import { generateLab, gradeLab, LAB_PRESETS, LAB_TOLERANCE, type LabItem } from "../../frontend/src/lib/training/lab.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

describe("the lock", () => {
  // Two actions [fold, call], four hands, weakest first.
  const count = 2;
  const n = 4;
  const reach = [1, 1, 1, 1];
  const order = [0, 1, 2, 3];
  // Equilibrium: hand 0 folds, hand 1 mixes half, hands 2 and 3 call. Folds: 1.5 of 4 = 37.5%.
  const strategy = [1, 0.5, 0, 0, 0, 0.5, 1, 1];

  it("raises a share by folding the first hands in order, the last one partly", () => {
    const out = lockedStrategy(strategy, count, n, reach, { group: [0], share: 0.625, order, fallback: 1 });
    // 2.5 of 4: hand 1 folds fully (+0.5), hand 2 half (+0.5).
    expect(Array.from(out)).toEqual([1, 1, 0.5, 0, 0, 0, 0.5, 1]);
    expect(groupShareOf(out, count, n, reach, [0])).toBeCloseTo(0.625, 12);
  });

  it("lowers a share by moving the last hands out first, to the fallback when they play nothing else", () => {
    const out = lockedStrategy(strategy, count, n, reach, { group: [0], share: 0, order, fallback: 1 });
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it("locks only the masked hands, and measures the share over them", () => {
    const mask = [1, 1, 0, 0];
    // Over hands 0 and 1 folds are 1.5 of 2; lock to 1 of 2: hand 1 (last in order among them) leaves first.
    const out = lockedStrategy(strategy, count, n, reach, { group: [0], share: 0.5, order, mask, fallback: 1 });
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 0, 1, 1, 1]);
    expect(groupShareOf(out, count, n, reach, [0], mask)).toBeCloseTo(0.5, 12);
  });

  it("weights hands by their reach", () => {
    const out = lockedStrategy(strategy, count, n, [0, 1, 1, 2], { group: [0], share: 0.5, order, fallback: 1 });
    // Folds now 0.5 of 4; need 2 of 4: hand 1 +0.5, hand 2 +1, hand 3 0... = 2.
    expect(groupShareOf(out, count, n, [0, 1, 1, 2], [0])).toBeCloseTo(0.5, 12);
    expect(out[3]).toBe(0);
  });
});

/**
 * The clairvoyance game, pot 1, a bet of `s = 1`, the bettor holding the nuts
 * half the time (`v = 0.5`). Equilibrium (`clairvoyanceSolution`): the
 * bluff-catcher calls 1 / (1 + s) = 50%; air bets v·s / ((1 + s)(1 − v)) = 50%;
 * the bettor's value is v·(1 + s·½) = 0.75.
 *
 * Lock the bluff-catcher to fold 75% (call c = 0.25):
 *  - a bluff earns (1 − c)·1 − c·s = 0.75 − 0.25 = 0.5 > 0 (checking air earns 0): the best response bluffs every air hand;
 *  - the nuts earn 1 + s·c = 1.25 betting;
 *  - best response: 0.5·1.25 + 0.5·0.5 = 0.875; the baseline against the lock: 0.625 + 0.5·0.5·0.5 = 0.75;
 *    gain 0.875 − 0.75 = 0.125 (an eighth of the pot);
 *  - against the baseline caller (c = ½) a bluff earns ½ − ½ = 0: the exploit loses nothing, 0.75;
 *  - against a caller who calls everything (its best response to all-air bets): nuts 0.5·2 = 1, air 0.5·(−1) = −0.5,
 *    0.5 in all: it gives back 0.75 − 0.5 = 0.25 (a quarter of the pot), twice what it gained;
 *  - the baseline against that same caller: 1 − 0.25 = 0.75: nothing lost.
 */
describe("the lab on the clairvoyance game (worked by hand)", () => {
  const s = 1;
  const v = 0.5;
  const game = clairvoyanceGame(s, v);
  const tree = game.tree;
  const facing = tree.children[tree.childStart[tree.root] + 1];

  function solved(): Solver {
    const solver = new Solver(game);
    // The closed-form equilibrium, exactly: bettor [check][nuts, air], [bet][nuts, air]; caller [fold], [call].
    solver.setAverageStrategy(tree.root, [0, 0.5, 1, 0.5]);
    solver.setAverageStrategy(facing, [0.5, 0.5]);
    return solver;
  }

  it("measures the best response to an over-folder, what it gains and what it risks", () => {
    const solver = solved();
    const lab = exploitLab(solver, 0, [{ node: facing, group: [0], share: 0.75, order: [0], fallback: 1 }], { keep: 0 });
    expect(lab.equilibrium).toBeCloseTo(0.75, 12);
    expect(lab.equilibriumVsLock).toBeCloseTo(0.75, 12);
    expect(lab.bestVsLock).toBeCloseTo(0.875, 12);
    expect(lab.gain).toBeCloseTo(0.125, 12);
    expect(lab.bestVsEquilibrium).toBeCloseTo(0.75, 12);
    expect(lab.riskVsEquilibrium).toBeCloseTo(0, 12);
    expect(lab.bestVsCounter).toBeCloseTo(0.5, 12);
    expect(lab.riskVsCounter).toBeCloseTo(0.25, 12);
    expect(lab.baselineRisk).toBeCloseTo(0, 12);
    // The response: the nuts bet, and so does every air hand.
    const root = lab.response.get(tree.root)!.strategy;
    expect(Array.from(root)).toEqual([0, 0, 1, 1]);
    // EVs per action against the lock: check [nuts 1, air 0], bet [1.25, 0.5].
    const ev = Array.from(lab.response.get(tree.root)!.ev);
    expect(ev.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([1, 0, 1.25, 0.5]);
    // The solver is left as it was.
    expect(Array.from(solver.averageStrategy(facing))).toEqual([0.5, 0.5]);
    expect(solver.value(0)).toBeCloseTo(0.75, 12);
  });

  it("measures the best response to a calling station: stop bluffing, with the same gain and risk", () => {
    const lab = exploitLab(solved(), 0, [{ node: facing, group: [0], share: 0.25, order: [0], fallback: 1 }], { keep: 0 });
    // c = 0.75: a bluff earns 0.25 − 0.75 = −0.5, so air checks; nuts 1 + 0.75 = 1.75.
    expect(lab.bestVsLock).toBeCloseTo(0.875, 12);
    expect(lab.equilibriumVsLock).toBeCloseTo(0.75, 12);
    expect(lab.gain).toBeCloseTo(0.125, 12);
    expect(lab.riskVsEquilibrium).toBeCloseTo(0, 12);
    // Its counter folds everything to a bettor who never bluffs: nuts win 1 half the time.
    expect(lab.bestVsCounter).toBeCloseTo(0.5, 12);
    expect(lab.riskVsCounter).toBeCloseTo(0.25, 12);
    expect(Array.from(lab.response.get(tree.root)!.strategy)).toEqual([0, 1, 1, 0]);
  });

  it("keeps the equilibrium mix where the response is indifferent", () => {
    // Locked at the equilibrium itself: every air hand is indifferent, so nothing changes.
    const lab = exploitLab(solved(), 0, [{ node: facing, group: [0], share: 0.5, order: [0], fallback: 1 }], { keep: 1e-9 });
    expect(Array.from(lab.response.get(tree.root)!.strategy)).toEqual([0, 0.5, 1, 0.5]);
    expect(lab.gain).toBeCloseTo(0, 12);
  });

  it("agrees with a solve of the game, not only with the closed form", () => {
    const solver = new Solver(game);
    solver.iterate(4000);
    const lab = exploitLab(solver, 0, [{ node: facing, group: [0], share: 0.75, order: [0], fallback: 1 }], { keep: 1e-6 });
    expect(lab.gain).toBeCloseTo(0.125, 2);
    expect(lab.riskVsCounter).toBeCloseTo(0.25, 2);
    expect(Math.abs(lab.riskVsEquilibrium)).toBeLessThan(0.01);
  });
});

describe("the river lab", () => {
  const items: LabItem[] = [];
  const presets = Object.keys(LAB_PRESETS) as Array<keyof typeof LAB_PRESETS>;

  it("deals the same item for the same seed, for every preset", () => {
    for (const [k, preset] of presets.entries()) {
      const seed = 9100 + k;
      const item = generateLab(CHARTS, { preset }, seed);
      expect(item, preset).not.toBeNull();
      expect(generateLab(CHARTS, { preset }, seed)).toEqual(item);
      items.push(item!);
    }
  }, 120_000);

  it("locks the opponent at the preset's share, and never reports a negative gain", () => {
    for (const item of items) {
      const preset = LAB_PRESETS[item.preset];
      for (const lock of item.locks) {
        const want = preset.lock === "fold-to-bet" ? Math.min(1, Math.max(0, lock.equilibrium + preset.value)) : preset.value;
        expect(lock.locked, item.preset).toBeCloseTo(want, 3);
      }
      expect(item.value).toBe(preset.value);
      expect(item.numbers.gain, item.preset).toBeGreaterThan(-1e-3);
      expect(Number.isFinite(item.numbers.riskVsCounter)).toBe(true);
      expect(item.views.length).toBeGreaterThan(0);
    }
  });

  it("asks for the best response's own best action, and grades with its tolerance", () => {
    for (const item of items) {
      const q = item.question;
      const best = Math.max(...q.ev);
      expect(q.right.length).toBeGreaterThan(0);
      for (let a = 0; a < q.ev.length; a += 1) {
        const within = q.ev[a] >= best - LAB_TOLERANCE * item.views[q.view].potBb - 1e-9;
        expect(q.right.includes(a), `${item.preset} action ${a}`).toBe(within);
        expect(gradeLab(item, a).correct).toBe(within);
      }
      // The exploit changes the answer: the baseline's most played action is not the only right one.
      const eqTop = q.eq.indexOf(Math.max(...q.eq));
      expect(q.right.length === 1 && q.right[0] === eqTop, item.preset).toBe(false);
    }
  });
});

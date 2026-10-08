/**
 * Learn L3: the directions the turn and river lessons state, checked against
 * Rail's own turn and river solves before they were written (the way L2
 * checked its flop claims against the flop library).
 *
 * Not part of `npm test`: it solves a few dozen turns and a few hundred
 * rivers. Run `npm run learn:directions` from `tests/`. It prints, per
 * situation, the share of the hero's range (reach-weighted) that takes each
 * group of actions, overall and by hand category — the same categories and
 * groups as the range split (`lib/training/split.ts`), the same solves as the
 * trainer's turn and river spots. The lessons quote no frequency from it: they
 * state directions ("bets more", "checks most"), and this is where each
 * direction was read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

import { riverCategory, turnCategory } from "../../../frontend/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import { cardIndex } from "../../../frontend/src/lib/equity/evaluator.js";
import { comboHi, comboLo, rangesAt, type SolveResult } from "../../../frontend/src/lib/solver/index.js";
import { heroNode } from "../../../frontend/src/lib/training/flop.js";
import { riverSetup, type RiverSpotOptions } from "../../../frontend/src/lib/training/river.js";
import { seeded } from "../../../frontend/src/lib/training/rng.js";
import { turnSetup, type TurnSpotOptions } from "../../../frontend/src/lib/training/turn.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

const RIVERS = Number(process.env.RIVERS ?? 30);
const TURNS = Number(process.env.TURNS ?? 10);

type Group = string;

/** The split's groups, with the river's sizes kept apart: small ≤ 50%, big ≤ 100%, overbet; an all-in apart too. */
function groupOf(result: SolveResult, node: number, a: number): Group {
  const at = result.nodes[node];
  const action = at.actions[a];
  if (at.toCall > 0) return action.kind === "fold" ? "fold" : action.kind === "call" ? "call" : "raise";
  if (action.kind === "check") return "check";
  if (action.kind === "allin") return "allin";
  return action.sizePot <= 0.5 + 1e-9 ? "small" : action.sizePot <= 1 + 1e-9 ? "big" : "overbet";
}

class Tally {
  readonly rows = new Map<string, Map<Group, number>>();
  readonly weight = new Map<string, number>();
  spots = 0;
  add(key: string, group: Group, w: number) {
    let row = this.rows.get(key);
    if (!row) this.rows.set(key, (row = new Map()));
    row.set(group, (row.get(group) ?? 0) + w);
  }
  addWeight(key: string, w: number) {
    this.weight.set(key, (this.weight.get(key) ?? 0) + w);
  }
  print(title: string) {
    const groups = new Set<string>();
    for (const row of this.rows.values()) for (const g of row.keys()) groups.add(g);
    const order = ["fold", "check", "call", "small", "big", "overbet", "allin", "raise"].filter((g) => groups.has(g));
    const lines = [`\n### ${title} (${this.spots} spots)`, `| category | share | ${order.join(" | ")} |`, `|---|---|${order.map(() => "---").join("|")}|`];
    const prefixOf = (key: string) => (key.includes(" ") ? `${key.split(" ")[0]} ` : "");
    const keys = [...this.rows.keys()].sort((a, b) => prefixOf(a).localeCompare(prefixOf(b)) || (this.weight.get(b) ?? 0) - (this.weight.get(a) ?? 0));
    for (const key of keys) {
      const w = this.weight.get(key) ?? 0;
      const total = this.weight.get(`${prefixOf(key)}ALL`) ?? 1;
      if (key !== "ALL" && w / total < 0.02) continue;
      const row = this.rows.get(key)!;
      lines.push(`| ${key} | ${((w / total) * 100).toFixed(1)}% | ${order.map((g) => `${(((row.get(g) ?? 0) / w) * 100).toFixed(0)}%`).join(" | ")} |`);
    }
    console.log(lines.join("\n"));
  }
}

/** Adds the hero's whole range at `node`, by category and overall ("ALL"). */
function tallyNode(tally: Tally, result: SolveResult, node: number, categoryOf: (hole: [number, number]) => string, prefix = "") {
  const at = result.nodes[node];
  const p = at.player as 0 | 1;
  const n = result.hands[p].length;
  const reach = rangesAt(result, node)[p];
  let total = 0;
  for (let i = 0; i < n; i += 1) total += reach[i];
  if (!(total > 0)) return;
  for (let i = 0; i < n; i += 1) {
    const w = reach[i] / total;
    if (!(w > 0)) continue;
    const combo = result.hands[p][i];
    const key = prefix + categoryOf([comboHi(combo), comboLo(combo)]);
    tally.addWeight(key, w);
    tally.addWeight(`${prefix}ALL`, w);
    for (let a = 0; a < at.actions.length; a += 1) {
      const f = w * at.strategy[a * n + i];
      const g = groupOf(result, node, a);
      tally.add(key, g, f);
      tally.add(`${prefix}ALL`, g, f);
    }
  }
}

/** The turn card against the flop: an overcard, a third card of a suit, a pairing card, or a lower card. */
function turnClass(board: string[]): string {
  const idx = board.map(cardIndex);
  const rank = (c: number) => c >> 2;
  const suit = (c: number) => c & 3;
  const flop = idx.slice(0, 3);
  const turn = idx[3];
  if (flop.some((c) => rank(c) === rank(turn))) return "pairs";
  if (flop.filter((c) => suit(c) === suit(turn)).length >= 2) return "flush-card";
  if (rank(turn) > Math.max(...flop.map(rank))) return "overcard";
  return "lower";
}

function riverRun(title: string, options: RiverSpotOptions, facing: "check" | "bet" | "raise" | undefined, split: (board: string[], before: string) => string = () => "") {
  const tally = new Tally();
  for (let s = 0; s < RIVERS * 4 && tally.spots < RIVERS; s += 1) {
    const seed = 7919 * (s + 1);
    const rng = seeded(seed);
    const setup = riverSetup(CHARTS, { ...options, facing: facing === "raise" ? "any" : facing }, rng, seed);
    if (!setup) continue;
    const result = setup.solve.result;
    const walked = heroNode(result, setup.solve.hero, facing, rng, "river");
    if (!walked) continue;
    const board = setup.board.map(cardIndex);
    const last = walked.steps.at(-1);
    const before = last ? `${result.nodes[last.node].actions[last.edge].kind}${Math.round(result.nodes[last.node].actions[last.edge].sizePot * 100)}` : "first";
    const prefix = split(setup.board, before);
    tallyNode(tally, result, walked.node, (hole) => riverCategory(hole, board), prefix ? `${prefix} ` : "");
    tally.spots += 1;
  }
  tally.print(title);
}

function turnRun(title: string, options: TurnSpotOptions, facing: "check" | "bet" | undefined, split: (board: string[], flop: string, spr: number) => string = () => "") {
  turnRunN(TURNS, title, options, facing, split);
}

function turnRunN(
  count: number,
  title: string,
  options: TurnSpotOptions,
  facing: "check" | "bet" | undefined,
  split: (board: string[], flop: string, spr: number) => string | null = () => "",
) {
  const tally = new Tally();
  for (let s = 0; s < count * 4 && tally.spots < count; s += 1) {
    const seed = 104729 * (s + 1);
    const rng = seeded(seed);
    const setup = turnSetup(CHARTS, options, rng, seed);
    if (!setup) continue;
    const result = setup.solve.result;
    const walked = heroNode(result, setup.solve.hero, facing, rng, "turn");
    if (!walked) continue;
    const board = setup.board.map(cardIndex);
    const flop = (setup.toTurn.flop ?? []).map((a) => a.type).join("-");
    const prefix = split(setup.board, flop, setup.stack / result.pot);
    if (prefix === null) continue;
    tallyNode(tally, result, walked.node, (hole) => turnCategory(hole, board), prefix ? `${prefix} ` : "");
    tally.spots += 1;
  }
  tally.print(title);
}

describe("turn and river directions (L3)", () => {
  it("rivers", () => {
    riverRun("River, in position, checked to (SRP)", { pot: "srp", seat: "ip" }, "check");
    riverRun("River, out of position, first to act (SRP)", { pot: "srp", seat: "oop" }, undefined);
    riverRun("River, in position, facing a bet, by its size (SRP)", { pot: "srp", seat: "ip" }, "bet", (_b, before) => before);
    riverRun("River, facing a raise of the hero's bet (SRP)", { pot: "srp" }, "raise");
    riverRun("River, 3-bet pot, in position, checked to", { pot: "3bp", seat: "ip" }, "check");
    riverRun("River, 3-bet pot, in position, facing a bet", { pot: "3bp", seat: "ip" }, "bet");
    riverRun("River, the preflop raiser in position, checked to (SRP)", { pot: "srp", seat: "ip", role: "pfr" }, "check");
    riverRun("River, the caller in position, checked to (SRP)", { pot: "srp", seat: "ip", role: "caller" }, "check");
  });

  it("turns", () => {
    turnRun("Turn, the raiser in position, checked to, by turn card (SRP)", { pot: "srp", seat: "ip", role: "pfr" }, "check", (board, flop) =>
      flop.includes("bet") ? turnClass(board) : "flop-checked",
    );
    turnRun("Turn, the caller out of position, first to act, by flop line (SRP)", { pot: "srp", seat: "oop", role: "caller" }, undefined, (_b, flop) =>
      flop.includes("bet") ? "flop-bet-called" : "flop-checked",
    );
    turnRun("Turn, the caller out of position, facing a bet (SRP)", { pot: "srp", seat: "oop", role: "caller" }, "bet");
    turnRun("Turn, the caller in position, facing a bet (SRP)", { pot: "srp", seat: "ip", role: "caller" }, "bet");
    turnRun("Turn, 3-bet pot, the caller, facing a bet", { pot: "3bp", role: "caller" }, "bet");
  });

  it("turns by card and depth", () => {
    const many = TURNS * 3;
      turnRunN(many, "Turn, the raiser in position, checked to after its flop bet was called, by turn card (SRP)", { pot: "srp", seat: "ip", role: "pfr" }, "check", (board, flop) =>
        flop.includes("bet") ? turnClass(board) : null,
      );
      turnRunN(TURNS * 2, "Turn, 3-bet pot, the 3-bettor in position, checked to, by SPR", { pot: "3bp", seat: "ip", role: "pfr" }, "check", (_b, _f, spr) =>
        spr < 2.5 ? "spr<2.5" : "spr>=2.5",
      );
      turnRunN(TURNS * 2, "Turn, 3-bet pot, the 3-bettor out of position, first to act, by SPR", { pot: "3bp", seat: "oop", role: "pfr" }, undefined, (_b, _f, spr) =>
        spr < 2.5 ? "spr<2.5" : "spr>=2.5",
      );
  });
});

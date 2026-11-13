/**
 * The desktop app's leak list per table and pot (`docs/ANALYSIS-PLAN.md`
 * §10, 2026-11-06): the open item of the 2026-11-02 and 2026-11-05 entries.
 *
 * - **Table**: a flop, turn or river row the app stores carries its hand's
 *   table (`handTableSet`, the web's `analysis_hand_table_set` ported as
 *   written), `''` when no set answers; a preflop row keeps its chart set.
 * - **Pot**: the store keeps the hand's pot type and returns a postflop spot
 *   per pot (`pot`: `3bp`, `4bp`; rail-store's `leaks.rs`, tested there);
 *   `spotRow` hands it on.
 * - **Leak list**: the web's own `groupLeaks` over the store's rows splits
 *   heads-up, 6-max and 9-max, single-raised, 3-bet and 4-bet+ areas with the
 *   same seat, role and side, exactly as on the web, and a leak's examples
 *   are asked on its table and pot.
 */
import "./support/appWindow";

import { beforeEach, describe, expect, it } from "vitest";

import { HAND_TABLE_SETS, handTableSet, leakColumns, storeRow } from "../../app/src/analysis/rows";
import type { SpotSumsDto } from "../../app/src/lib/ipc";
import { fetchLeakExamples, fetchTopLeaks, spotRow } from "../../app/src/lib/leaksSource";
import { groupLeaks, handsPot, handsTable, parseLeakId } from "../../web/src/lib/analysis/leaks";
import { CHART_SETS, PLANNED_CHART_SETS } from "../../web/src/lib/charts/registry";
import type { DecisionAnalysisInsert, HandAnalysisInsert } from "../../web/src/lib/db/analysisRows";
import { setInvokeHandler } from "./support/tauriCore";

const POSITIONS = ["BTN", "SB", "BB", "UTG", "HJ", "CO", "UTG1", "UTG2", "MP", "X"];

/** A cash hand, big blind 2: `stacks` in chips, the hero first, `folds` the seats folding preflop. */
function hand(stacks: Array<number | null>, folds: number[] = [], game: Record<string, unknown> = {}) {
  return {
    game: { variant: "holdem", limit: "nl", format: "cash", bigBlind: 2, ...game },
    players: stacks.map((stack, i) => ({
      seat: i + 1,
      position: POSITIONS[i],
      isHero: i === 0,
      ...(stack === null ? {} : { startingStack: stack }),
    })),
    actions: folds.map((seat) => ({ street: "preflop", type: "fold", seat })),
  };
}

/** The leak rows' table buckets (a fixed table-and-depth list since charts/11): the classic planned sets, plus the 9-max 60bb bucket. */
const BUCKETS = [
  ...[40, 60, 100, 150, 200].map((depth) => ({ id: `nlhe-cash-6max-${depth}bb`, seats: 6, depth })),
  ...[60, 100, 150, 200].map((depth) => ({ id: `nlhe-cash-9max-${depth}bb`, seats: 9, depth })),
  ...[100, 150].map((depth) => ({ id: `nlhe-cash-hu-${depth}bb`, seats: 2, depth })),
];

describe("a hand's table (analysis_hand_table_set)", () => {
  it("holds the table-and-depth buckets: every classic planned set, and every classic set shipped", () => {
    expect(HAND_TABLE_SETS.map((s) => [s.id, s.seats, s.depth])).toEqual(BUCKETS.map((s) => [s.id, s.seats, s.depth]));
    for (const id of PLANNED_CHART_SETS.filter((x) => !/-(ante|straddle)$/.test(x))) expect(HAND_TABLE_SETS.map((s) => s.id)).toContain(id);
    for (const spec of CHART_SETS.filter((s) => !s.straddle && !s.ante)) expect(HAND_TABLE_SETS.map((s) => s.id)).toContain(spec.id);
  });

  it("reads the table by the players dealt in and the depth by the effective stack", () => {
    expect(handTableSet(hand([200, 200]))).toBe("nlhe-cash-hu-100bb");
    expect(handTableSet(hand([300, 290]))).toBe("nlhe-cash-hu-150bb");
    expect(handTableSet(hand([200, 200, 200]))).toBe("nlhe-cash-6max-100bb");
    expect(handTableSet(hand(Array(6).fill(200)))).toBe("nlhe-cash-6max-100bb");
    expect(handTableSet(hand(Array(9).fill(200)))).toBe("nlhe-cash-9max-100bb");
    expect(handTableSet(hand(Array(9).fill(300)))).toBe("nlhe-cash-9max-150bb");
    // A deep opponent still in deepens the effective stack; folded, he does not.
    const deep = [400, 200, 200, 200, 200, 800];
    expect(handTableSet(hand(deep))).toBe("nlhe-cash-6max-200bb");
    expect(handTableSet(hand(deep, [6]))).toBe("nlhe-cash-6max-100bb");
    // 120bb is 20% from both heads-up depths: inside both, the first wins (as in Rust).
    expect(handTableSet(hand([240, 240]))).toBe("nlhe-cash-hu-100bb");
    // A stack the hand does not state reads 100bb.
    expect(handTableSet(hand([null, null]))).toBe("nlhe-cash-hu-100bb");
  });

  it("is '' for a hand no set answers", () => {
    expect(handTableSet(hand(Array(10).fill(200)))).toBe("");
    expect(handTableSet(hand([600, 600]))).toBe("");
    expect(handTableSet(hand(Array(6).fill(20)))).toBe("");
    expect(handTableSet(hand(Array(6).fill(200), [], { format: "tournament" }))).toBe("");
    expect(handTableSet(hand(Array(6).fill(200), [], { limit: "pl" }))).toBe("");
    expect(handTableSet(hand(Array(6).fill(200), [], { bigBlind: 0 }))).toBe("");
    const straddle = hand(Array(6).fill(200));
    straddle.actions.push({ street: "preflop", type: "straddle", seat: 4 });
    expect(handTableSet(straddle)).toBe("");
    const noHero = hand(Array(6).fill(200));
    noHero.players[0].isHero = false;
    expect(handTableSet(noHero)).toBe("");
    expect(handTableSet(null)).toBe("");
  });
});

function decision(ord: number, street: string, source: string, facts: Record<string, unknown>): DecisionAnalysisInsert {
  return {
    ord,
    action_index: ord * 2 + 3,
    street,
    action: "call",
    status: "analysed",
    reason: null,
    node: "n",
    scenario: street === "preflop" ? "vs-open" : "oop-caller",
    source,
    grade: "mistake",
    score: 50,
    ev_loss_bb: 1,
    ev_loss_pot: 0.1,
    freq_diff: null,
    options: [{ action: "fold", freq: 1, ev: 0 }],
    chosen: null,
    flags: [],
    approximations: [],
    facing_bet: true,
    pot_bb: 6,
    pot_odds: null,
    mdf: null,
    facts: facts as never,
  } as DecisionAnalysisInsert;
}

function analysed(potType: string): HandAnalysisInsert {
  return {
    hand_id: "k",
    analysis_version: "analysis/34",
    status: "full",
    reason: null,
    hero_seat: 3,
    grade: "mistake",
    score: 50,
    ev_loss_bb: 3,
    ev_loss_pot: 0.3,
    approximations: [],
    pot_type: potType,
    decisions: [
      decision(0, "preflop", "chart", { chart: { set: "nlhe-cash-6max-100bb", line: "ffffr" }, position: "BB" }),
      decision(1, "flop", "solver", { position: "BB" }),
      decision(2, "turn", "heuristic", { position: "BB" }),
      decision(3, "river", "solver", { position: "BB" }),
    ],
  } as HandAnalysisInsert;
}

describe("the rows the app stores", () => {
  it("give every postflop row the hand's table, a preflop row its chart set, and keep the hand's pot", () => {
    for (const [phf, set] of [
      [hand([200, 200]), "nlhe-cash-hu-100bb"],
      [hand(Array(6).fill(200)), "nlhe-cash-6max-100bb"],
      [hand(Array(9).fill(400)), "nlhe-cash-9max-200bb"],
      [hand(Array(10).fill(200)), ""],
    ] as const) {
      for (const pot of ["single-raised", "3bet", "4bet+"]) {
        const row = storeRow(analysed(pot), "k", "BB", true, handTableSet(phf));
        expect(row.pot_type).toBe(pot);
        expect(row.decisions.map((d) => [d.street, d.chart_set])).toEqual([
          ["preflop", "nlhe-cash-6max-100bb"],
          ["flop", set],
          ["turn", set],
          ["river", set],
        ]);
      }
    }
  });

  it("never gives a preflop row the hand's table", () => {
    const offCharts = decision(0, "preflop", "heuristic", { position: "BB" });
    expect(leakColumns(offCharts, "BB", "nlhe-cash-hu-100bb").chart_set).toBe("");
    // Without a table (an older caller) a postflop row stays ''.
    expect(leakColumns(decision(1, "flop", "solver", {}), "BB").chart_set).toBe("");
  });
});

/** One spot's sums as the store returns them. */
const sums = (set: string | null, pot: string | null, decisions: number): SpotSumsDto => ({
  key: "river|oop-caller||BB|call|fold",
  set,
  ...(pot ? { pot } : {}),
  decisions,
  nonPerfect: decisions,
  mistakes: decisions,
  evLossBb: decisions * 1.5,
  evLossPot: decisions * 0.15,
  scoreSum: decisions * 50,
  scoreSq: decisions * 2500,
});

describe("the desktop leak list", () => {
  const rows = [
    sums("nlhe-cash-6max-100bb", null, 40),
    sums("nlhe-cash-6max-100bb", "3bp", 30),
    sums("nlhe-cash-6max-100bb", "4bp", 20),
    sums("nlhe-cash-hu-100bb", null, 40),
    sums("nlhe-cash-hu-100bb", "3bp", 30),
    sums("nlhe-cash-9max-100bb", null, 40),
    // Hands no set answers (and rows stored before the store's migration 20 could fill them): untagged, with 6-max.
    sums(null, null, 10),
  ];
  const sample = { hands: 200, graded: 210, rows };
  const dto = {
    last: "2026-11-05",
    current: { from: "2026-10-07", to: "2026-11-05" },
    prior: { from: "2026-09-07", to: "2026-10-06" },
    sample,
    now: sample,
    was: sample,
  };

  beforeEach(() => setInvokeHandler((command) => (command === "top_leaks" ? dto : [])));

  it("hands each spot's pot on to the web's rows", () => {
    expect(spotRow(rows[1]).pot).toBe("3bp");
    expect(spotRow(rows[0])).not.toHaveProperty("pot");
  });

  it("splits areas by table and pot with the web's own grouping, as on the web", async () => {
    const report = await fetchTopLeaks({}, "all");
    const app = groupLeaks(report.sample.rows, { hands: report.sample.hands });
    const finest = app.filter((l) => l.level === 0).map((l) => l.id);
    const base = "river~oop-caller~oop-caller~BB~-~call~fold";
    expect(new Set(finest)).toEqual(
      new Set([base, `${base}~3bp`, `${base}~4bp`, `${base}~hu`, `${base}~hu~3bp`, `${base}~9max`]),
    );
    for (const id of finest) expect(parseLeakId(id)).not.toBeNull();
    const untagged = app.find((l) => l.id === base);
    // 6-max single-raised and the rows with no set.
    expect(untagged?.decisions).toBe(50);
  });

  it("asks each leak's examples on its table and pot", async () => {
    const report = await fetchTopLeaks({}, "all");
    const leaks = groupLeaks(report.sample.rows, { hands: report.sample.hands }).filter((l) => l.level === 0);
    const asked: Record<string, unknown>[] = [];
    setInvokeHandler((command, args) => {
      asked.push({ command, ...args });
      return [];
    });
    await fetchLeakExamples(
      {},
      leaks.map((leak) => ({ id: leak.id, keys: leak.keys, table: handsTable(leak.attrs, leak.level), pot: handsPot(leak.attrs) })),
      null,
      5,
    );
    const scopes = asked.map((a) => `${String(a.table)}/${String(a.pot)}`).sort();
    expect(scopes).toEqual(["9max/other", "hu/3bp", "hu/other", "other/3bp", "other/4bp", "other/other"]);
    expect(asked.every((a) => a.command === "leak_examples")).toBe(true);
    // Without a scope (an older caller): every table and pot.
    asked.length = 0;
    await fetchLeakExamples({}, [{ id: "x", keys: ["river|oop-caller||BB|call|fold"] }], null, 5);
    expect(asked[0]).toMatchObject({ table: null, pot: null });
  });
});

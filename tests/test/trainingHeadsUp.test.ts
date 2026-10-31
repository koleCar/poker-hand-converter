/**
 * The trainer and the study plan on the heads-up sets (`charts/8`,
 * `charts/9`, `docs/ANALYSIS-PLAN.md` §10, 2026-10-28). Heads-up the small
 * blind is the button: first to act preflop, last after the flop.
 *
 * - **Preflop**: both heads-up sets deal every family a two-handed table
 *   has (no squeeze), as two-handed hands graded from the same set; a
 *   heads-up node is also blind vs blind.
 * - **Leaks and the plan**: a heads-up chart row is tagged `hu` (its own
 *   situation, not the 6-max blinds'), and its area's trainer target deals
 *   on the heads-up set it was met on - a heads-up leak maps to a heads-up
 *   drill, through the task reference and the trainer's address.
 * - **River and turn**: the heads-up lines (`RIVER_LINES_HU`), dealt as
 *   two-handed hands and graded exactly as the analysis grades them.
 * - **Flop**: the heads-up 100bb library lines, on a chunk solved here with
 *   a small tree (as `flopLibraryHeadsUp.test.ts`); a set with no chunk in
 *   the test's library (here the heads-up 150bb set) deals nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeHand, FLOP_LINES_HU, FLOP_PROFILE, memoryLibrary, type FlopProfile } from "../../web/src/lib/analysis/index.js";
import { atLevel, leakId, parseLeakId, spotAttrs, type SpotRow } from "../../web/src/lib/analysis/leaks.js";
import { loadCharts, type ChartSet } from "../../web/src/lib/charts/index.js";
import { decodeChunk, type FlopChunk } from "../../web/src/lib/solver/index.js";
import { flopAnswer, generateFlopSpot } from "../../web/src/lib/training/flop.js";
import {
  dealPreflop,
  familiesOf,
  generateRiverSpot,
  generateTurnSpot,
  gradeAnswer,
  preflopAnswer,
  riverAnswer,
  riverLines,
  trainerFamilies,
  trainerNodes,
  trainerSeats,
  turnAnswer,
} from "../../web/src/lib/training/index.js";
import { trainingChartSets } from "../../web/src/lib/training/jobs.js";
import { focusAreas, parseFocus, parseTrainerRef, trainerRef, trainerTarget } from "../../web/src/lib/training/plan.js";
import { parseTrainState, riverSetOf, targetQuery, trainQuery, DEFAULT_TRAIN_STATE } from "../../web/src/components/analysis/train/trainState.js";
import { solveJob, type Job } from "../scripts/flop-library/job.js";
import { lineSpot } from "../scripts/flop-library/spots.js";
import { fullLibrary } from "./charts/support.js";

const HU100 = "nlhe-cash-hu-100bb";
const HU150 = "nlhe-cash-hu-150bb";
const library = fullLibrary();
const set = (id: string): ChartSet => library.sets.get(id)!;

/* ------------------------------------------------------------ preflop - */

describe("heads-up preflop spots", () => {
  it("are dealt in every family a two-handed table has, as two-handed hands graded from the same set", () => {
    expect(trainerSeats(2)).toEqual(["SB", "BB"]);
    expect(trainerFamilies(2)).not.toContain("squeeze");
    for (const id of [HU100, HU150]) {
      for (const family of trainerFamilies(2)) {
        const spot = dealPreflop(library, { set: id, family, bias: "borderline" }, 5);
        if (!spot) throw new Error(`no ${family} spot on ${id}`);
        expect(spot.set).toBe(id);
        expect(spot.family).toBe(family);
        expect(spot.hand.players).toHaveLength(2);
        expect(spot.script.seats).toEqual(["SB", "BB"]);
        expect(spot.script.stackBb).toBe(set(id).game.stackBb);
        spot.menu.forEach((_, index) => {
          const { hand, actionIndex } = preflopAnswer(spot, index);
          const mine = gradeAnswer(hand, actionIndex, library);
          expect(mine?.source, `${id} ${family}`).toBe("chart");
          expect(mine?.facts.chart?.set).toBe(id);
          expect(mine?.facts.chart?.line).toBe(spot.line);
        });
      }
      expect(dealPreflop(library, { set: id, family: "squeeze" }, 5)).toBeNull();
    }
  });

  it("file every node as blind vs blind, and its scenario as its own family", () => {
    const families = Object.fromEntries([...set(HU100).nodes.values()].map((node) => [node.line, familiesOf(node)]));
    expect(families[""]).toEqual(["rfi", "bvb"]);
    expect(families.r).toEqual(["vs-open", "bvb"]);
    // The small blind's limp raised: a limper facing a raise, which the analysis calls `vs-open`.
    expect(families.cr).toEqual(["vs-open", "bvb"]);
    expect(families.c).toEqual(["vs-limp", "bvb"]);
    expect(families.rr).toEqual(["vs-3bet", "bvb"]);
    expect(families.rrr).toEqual(["vs-4bet", "bvb"]);
    // The 6-max blinds keep theirs.
    const sixMax = library.nodes.get("ffffr")!;
    expect(familiesOf(sixMax)).toEqual(["bvb"]);
    // Against the raiser asked for.
    for (const node of trainerNodes(set(HU100), "vs-3bet", "SB", "BB")) expect(node.line).toBe("rr");
  });
});

/* --------------------------------------------------- leaks and the plan - */

function row(scenario: string, line: string, position: string, taken: string, best: string, decisions: number, chartSet: string | null, evLossBb = 0): SpotRow {
  const mistakes = taken === best ? 0 : decisions;
  return {
    key: ["preflop", scenario, line, position, taken, best].join("|"),
    set: chartSet,
    street: "preflop",
    scenario,
    line,
    position,
    taken,
    best,
    decisions,
    hands: decisions,
    nonPerfect: mistakes,
    mistakes,
    evLossBb,
    evLossPot: 0,
    scoreSum: 100 * (decisions - mistakes),
    scoreSq: 10000 * (decisions - mistakes),
  };
}

describe("heads-up leaks", () => {
  it("are their own situations, tagged `hu`, not the 6-max blinds'", () => {
    const hu = spotAttrs(row("vs-open", "r", "BB", "fold", "call", 3, HU100));
    expect(hu).toMatchObject({ hero: "BB", villain: "SB", table: "hu" });
    expect(leakId(hu)).toBe("preflop~vs-open~vs-raise~BB~SB~fold~call~hu");
    expect(parseLeakId(leakId(hu))).toEqual(hu);
    expect(atLevel(hu, 1).table).toBe("hu");
    expect(atLevel(hu, 2).table).toBeUndefined();
    const sixMax = spotAttrs(row("vs-open", "ffffr", "BB", "fold", "call", 3, "nlhe-cash-6max-100bb"));
    expect(sixMax).toMatchObject({ hero: "BB", villain: "SB" });
    expect(sixMax.table).toBeUndefined();
    expect(parseLeakId("preflop~vs-open~vs-raise~BB~SB~fold~call~6max")).toBeNull();
  });
});

describe("a heads-up leak in the study plan", () => {
  // The small blind folding too much first in, and the big blind folding to the open, on the heads-up sets.
  const rows = [
    row("unopened", "", "SB", "fold", "raise", 14, HU100, 6),
    row("unopened", "", "SB", "raise", "raise", 20, HU100),
    row("vs-open", "r", "BB", "fold", "call", 6, HU100, 3),
    row("vs-open", "r", "BB", "fold", "call", 2, HU150, 1),
    row("vs-open", "r", "BB", "call", "call", 15, HU100),
    row("bb-option", "c", "BB", "check", "raise", 12, HU100, 1),
    // The 6-max small blind's own open, which must not join the heads-up one.
    row("unopened", "ffff", "SB", "fold", "raise", 12, "nlhe-cash-6max-100bb", 2),
  ];
  const areas = focusAreas(rows, 200);
  const area = (id: string) => areas.find((a) => a.id === id)!;

  it("maps to a heads-up drill on the set it was met on, through the task reference and the address", () => {
    const open = area("preflop~unopened~first-in~SB~-~hu");
    expect(open.trainer).toEqual({ mode: "preflop", family: "rfi", seat: "SB", vs: null, set: HU100 });
    expect(area("preflop~unopened~first-in~SB~-").trainer).toEqual({
      mode: "preflop",
      family: "rfi",
      seat: "SB",
      vs: null,
      set: "nlhe-cash-6max-100bb",
    });
    const defend = area("preflop~vs-open~vs-raise~BB~SB~hu");
    expect(defend.trainer).toEqual({ mode: "preflop", family: "vs-open", seat: "BB", vs: "SB", set: HU100 });
    expect(area("preflop~bb-option~first-in~BB~-~hu").trainer).toEqual({ mode: "preflop", family: "vs-limp", seat: "BB", vs: null, set: HU100 });

    for (const focus of [open, defend, area("preflop~bb-option~first-in~BB~-~hu")]) {
      const target = focus.trainer!;
      if (target.mode !== "preflop") throw new Error("not a preflop target");
      // The task reference the database keeps (`study_tasks.ref`), and back.
      const ref = trainerRef(target);
      expect(ref).toMatch(/^(preflop|river)(\/[A-Za-z0-9+-]{1,20}){0,5}$/);
      expect(parseTrainerRef(ref)).toEqual(target);
      // The trainer's address keeps the set, and deals the spot on it.
      const state = parseTrainState(Object.fromEntries(new URLSearchParams(targetQuery(target))));
      expect(state.set).toBe(HU100);
      for (let seed = 1; seed <= 4; seed += 1) {
        const spot = dealPreflop(library, { set: state.set, family: state.family, seat: state.seat, vs: state.vs }, seed)!;
        expect(spot.set).toBe(HU100);
        expect(spot.hero).toBe(target.seat);
        expect(spot.family).toBe(target.family);
        expect(spot.hand.players).toHaveLength(2);
      }
    }
    // A stored focus keeps the tag.
    expect(parseFocus(JSON.parse(JSON.stringify([defend])))[0].where.table).toBe("hu");
  });

  it("stays heads-up when its leaks name no set, and keeps a set of its own table only", () => {
    const where = { street: "preflop", scenario: "vs-3bet", family: "vs-reraise", hero: "SB", villain: "BB", table: "hu" };
    expect(trainerTarget(where)).toEqual({ mode: "preflop", family: "vs-3bet", seat: "SB", vs: "BB", set: HU100 });
    expect(trainerTarget(where, HU150)).toEqual({ mode: "preflop", family: "vs-3bet", seat: "SB", vs: "BB", set: HU150 });
    expect(trainerTarget(where, "nlhe-cash-6max-100bb")).toEqual({ mode: "preflop", family: "vs-3bet", seat: "SB", vs: "BB", set: HU100 });
  });
});

/* ------------------------------------------------------ the address - */

describe("the trainer's address", () => {
  it("keeps a heads-up table for the preflop and the river trainer, and a 9-max one for preflop only", () => {
    const hu = { ...DEFAULT_TRAIN_STATE, mode: "river" as const, set: HU150 };
    expect(trainQuery(hu)).toBe(`mode=river&set=${HU150}`);
    expect(parseTrainState({ mode: "river", set: HU150 }).set).toBe(HU150);
    expect(riverSetOf(HU150)).toBe(HU150);
    expect(riverSetOf("nlhe-cash-9max-100bb")).toBe(DEFAULT_TRAIN_STATE.set);
    expect(trainQuery({ ...hu, set: "nlhe-cash-9max-100bb" })).toBe("mode=river");
    expect(trainQuery({ ...DEFAULT_TRAIN_STATE, set: HU100 })).toBe(`set=${HU100}`);
  });
});

/* ---------------------------------------------------- river and turn - */

/** The analysis' own verdict on one decision of a hand, from a full run. */
const analysed = (hand: Parameters<typeof analyzeHand>[0], actionIndex: number, turn = false) =>
  analyzeHand(structuredClone(hand), { charts: library, turn }).decisions.find((d) => d.actionIndex === actionIndex);

describe("heads-up river spots", () => {
  it("come from the heads-up lines, as two-handed hands, and grade exactly as the analysis grades them", () => {
    expect(riverLines(set(HU100)).map((line) => line.id)).toEqual(["hu-sb-bb", "hu-sb-limp-raise", "hu-sb-bb-3bet", "hu-sb-limp"]);
    let checked = 0;
    for (const id of [HU100, HU150]) {
      for (let seed = 1; seed < 12 && checked < (id === HU100 ? 2 : 3); seed += 1) {
        const spot = generateRiverSpot(library, { set: id, bias: "range" }, seed);
        if (!spot) continue;
        expect(spot.set).toBe(id);
        expect(spot.lineId).toMatch(/^hu-/);
        expect(spot.hand.players).toHaveLength(2);
        // The big blind is out of position on every heads-up line; both ranges are the heads-up charts'.
        expect(spot.seat === "oop" ? spot.hero : spot.villain).toBe("BB");
        expect(spot.sources).toEqual({ hero: "chart", villain: "chart" });
        expect(spot.cards.some((card) => spot.board.includes(card))).toBe(false);
        for (let index = 0; index < spot.menu.length; index += 1) {
          const { hand, actionIndex } = riverAnswer(spot, index);
          const mine = gradeAnswer(hand, actionIndex, library);
          expect(mine).toEqual(analysed(hand, actionIndex));
          expect(mine?.source).toBe("solver");
          expect(mine?.approximations).not.toContain("off-tree-size");
        }
        checked += 1;
      }
    }
    expect(checked).toBe(3);
    // The pot and the seat asked for.
    const spot = generateRiverSpot(library, { set: HU100, pot: "3bp", seat: "ip" }, 3);
    expect(spot?.lineId).toBe("hu-sb-bb-3bet");
    expect(spot?.hero).toBe("SB");
  }, 120_000);

  it("deal a heads-up turn graded as the analysis grades it, turn solve on", () => {
    const spot = generateTurnSpot(library, { set: HU100, pot: "srp", seat: "ip", role: "pfr", facing: "check" }, 4);
    if (!spot) throw new Error("no heads-up turn spot");
    expect(spot.set).toBe(HU100);
    expect(spot.lineId).toBe("hu-sb-bb");
    expect(spot.hero).toBe("SB");
    expect(spot.hand.players).toHaveLength(2);
    const answer = turnAnswer(spot, 0);
    const graded = gradeAnswer(answer.hand, answer.actionIndex, library, { turn: true });
    const full = analysed(answer.hand, answer.actionIndex, true);
    expect(graded?.source).toBe("solver");
    expect(graded?.street).toBe("turn");
    expect(graded?.grade).toBe(full?.grade);
    expect(graded?.options).toEqual(full?.options);
  }, 120_000);

  it("load the heads-up set for the job and its answer", () => {
    expect(trainingChartSets({ type: "river", jobId: 1, options: { set: HU150 }, seed: 1 })).toEqual([HU150]);
    expect(trainingChartSets({ type: "turn", jobId: 1, options: { set: HU100 }, seed: 1 })).toEqual([HU100]);
    expect(trainingChartSets({ type: "flop", jobId: 1, options: { set: HU100 }, seed: 1 })).toEqual([HU100]);
    expect(trainingChartSets({ type: "river", jobId: 1, options: {}, seed: 1 })).toEqual([]);
  });
});

/* -------------------------------------------------------------- flop - */

const SMALL: FlopProfile = {
  ...FLOP_PROFILE,
  tree: "flop-test",
  flopMenu: { bet: [0.33, 0.75], raise: [], allIn: false },
  flopRaiseCap: 0,
  turnMenu: { bet: [], raise: [], allIn: false },
  riverMenu: { bet: [], raise: [], allIn: false },
  targetPct: 2,
  maxIterations: 40,
  checkFrom: 40,
  checkEvery: 40,
};

describe("heads-up flop spots", () => {
  const charts = loadCharts(JSON.parse(readFileSync(join(import.meta.dirname, `../../web/src/lib/charts/data/${HU100}.json`), "utf8")));
  const line = FLOP_LINES_HU.find((l) => l.id === "sb-bb-4bet")!;
  let chunk: FlopChunk;

  beforeAll(() => {
    const spot = lineSpot(charts, line);
    const job: Job = {
      id: `${line.id}/Ts7h4d`,
      line: line.id,
      lineKey: line.key,
      flop: "Ts7h4d",
      players: spot.players,
      ranges: [Array.from(spot.ranges[0]), Array.from(spot.ranges[1])],
      pot: spot.pot,
      stack: spot.stack,
      charts: { id: charts.id, version: charts.version, hash: charts.model.hash },
      rake: { name: "test", percent: 0.05, cap: 3 },
      profile: SMALL,
    };
    chunk = decodeChunk(solveJob(job).bytes);
  }, 120_000);

  it("are dealt from the heads-up library lines and graded from the same chunk", () => {
    const flops = memoryLibrary([chunk]);
    let dealt = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      const spot = generateFlopSpot(library, flops, { set: HU100 }, seed);
      if (!spot) continue;
      dealt += 1;
      expect(spot.set).toBe(HU100);
      expect(spot.lineId).toBe("sb-bb-4bet");
      expect(spot.flop).toBe("Ts7h4d");
      expect(spot.hand.players).toHaveLength(2);
      expect(spot.seat === "oop" ? spot.hero : spot.villain).toBe("BB");
      const { hand, actionIndex } = flopAnswer(spot, 0);
      const graded = gradeAnswer(hand, actionIndex, library, { flopLibrary: flops });
      expect(graded?.source).toBe("solver");
      expect(graded?.facts.flop).toMatchObject({ source: "library", line: "sb-bb-4bet", flop: "Ts7h4d", mapped: false, path: spot.path });
      expect(graded?.options.length).toBe(spot.menu.length);
    }
    expect(dealt).toBeGreaterThan(4);
    // The 6-max default deals none of these chunks, and a set with no chunk here (heads-up 150bb) deals nothing.
    expect(generateFlopSpot(library, flops, {}, 1)).toBeNull();
    expect(generateFlopSpot(library, flops, { set: HU150 }, 1)).toBeNull();
  });
});

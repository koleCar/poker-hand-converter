/**
 * The Train tab's flop mode (`docs/ANALYSIS-PLAN.md` §10, 2026-10-28): a
 * heads-up flop from Rail's flop library on a table the library is solved
 * for, graded exactly as Learn L2's flop exercises are, and kept as a
 * `trainer_results` row of mode `flop`
 * (`20271028090000_trainer_flop_mode.sql`).
 *
 * - **The address**: the mode, its table (the library's sets, else the
 *   default) and its filters survive a round trip; a table the library is
 *   not solved for deals the default set.
 * - **The job**: the mode's options name the set whose manifest is read and
 *   whose charts are loaded; a set with no manifest (heads-up 150bb) deals
 *   nothing.
 * - **A spot and its row**: on the committed pilot chunks, a spot dealt from
 *   the mode's options is graded by the solver, and its row passes the
 *   table's checks.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_LIBRARY_SETS, FLOP_PROFILE, memoryLibrary } from "../../web/src/lib/analysis/index.js";
import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { decodeChunk, type FlopManifest } from "../../web/src/lib/solver/index.js";
import { needsFlopLibrary, prepareFlopLibrary, runTrainingJob, trainingChartSets, type TrainingRequest } from "../../web/src/lib/training/jobs.js";
import {
  DEFAULT_TRAIN_STATE,
  FLOP_TRAINER_SETS,
  flopSetOf,
  parseTrainState,
  spotOptions,
  TRAIN_MODES,
  trainerResultOf,
  trainQuery,
  type TrainState,
} from "../../web/src/components/analysis/train/trainState.js";
import { fullLibrary } from "./charts/support.js";

const HU100 = "nlhe-cash-hu-100bb";
const HU150 = "nlhe-cash-hu-150bb";
const library = fullLibrary();

/* ------------------------------------------------------- the address - */

describe("the flop mode's address", () => {
  it("is a mode of its own, between preflop and river", () => {
    expect(TRAIN_MODES).toEqual(["preflop", "flop", "river", "drills"]);
    expect(parseTrainState({ mode: "flop" }).mode).toBe("flop");
  });

  it("offers the tables the flop library is solved for, and deals the default elsewhere", () => {
    expect(FLOP_TRAINER_SETS.map((spec) => spec.id)).toEqual([...FLOP_LIBRARY_SETS]);
    expect(FLOP_TRAINER_SETS.map((spec) => spec.players)).toEqual([6, 6, 9, 2, 2]);
    for (const id of FLOP_LIBRARY_SETS) expect(flopSetOf(id)).toBe(id);
    expect(flopSetOf("nlhe-cash-6max-40bb")).toBe(DEFAULT_CHART_SET);
    expect(flopSetOf("nlhe-cash-9max-150bb")).toBe(DEFAULT_CHART_SET);
  });

  it("keeps its table and filters through a round trip, defaults left out", () => {
    const state: TrainState = { ...DEFAULT_TRAIN_STATE, mode: "flop", set: HU100, pot: "3bp", side: "oop", role: "caller", facing: "bet", deal: "range" };
    const query = trainQuery(state);
    expect(query).toBe(`mode=flop&set=${HU100}&pot=3bp&side=oop&role=caller&facing=bet&deal=range`);
    expect(parseTrainState(Object.fromEntries(new URLSearchParams(query)))).toEqual(state);
    expect(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "flop" })).toBe("mode=flop");
    // A table the library is not solved for is the default set's, so it is left out.
    expect(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "flop", set: "nlhe-cash-6max-40bb" })).toBe("mode=flop");
    // The facing filter is the flop's own; an unknown one reads as any.
    expect(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "river", facing: "raise" })).toBe("mode=river");
    expect(parseTrainState({ mode: "flop", facing: "shove" }).facing).toBe("any");
  });
});

/* ------------------------------------------------------------ the job - */

const flopRequest = (state: TrainState, seed = 7): TrainingRequest => ({ type: "flop", jobId: 1, options: spotOptions("flop", state), seed });

describe("the flop mode's job", () => {
  it("deals on the table's set, with the river's filters and what the hero faces", () => {
    const state: TrainState = { ...DEFAULT_TRAIN_STATE, mode: "flop", set: HU100, pot: "srp", side: "ip", role: "pfr", facing: "check" };
    expect(spotOptions("flop", state)).toEqual({ set: HU100, pot: "srp", seat: "ip", role: "pfr", facing: "check", bias: "borderline" });
    expect(spotOptions("flop", { ...state, set: "nlhe-cash-6max-60bb" }).set).toBe(DEFAULT_CHART_SET);
    const request = flopRequest(state);
    expect(needsFlopLibrary(request)).toBe(true);
    expect(trainingChartSets(request)).toEqual([HU100]);
  });

  it("reads the table's manifest, and deals nothing on a set the bucket has none for", async () => {
    for (const set of [HU100, HU150, "nlhe-cash-9max-100bb", "nlhe-cash-6max-150bb"]) {
      const asked: string[] = [];
      // An empty bucket: every manifest is missing, as heads-up 150bb's is.
      const loader = {
        tree: FLOP_PROFILE.tree,
        has: () => false,
        get: () => null,
        ready: async (name: string) => {
          asked.push(name);
          return false;
        },
        load: async () => null,
      };
      const request = flopRequest({ ...DEFAULT_TRAIN_STATE, mode: "flop", set });
      const prepared = await prepareFlopLibrary(request, library, loader);
      expect(asked).toEqual([set]);
      const response = runTrainingJob(request, library, prepared);
      expect(response.type === "spot" && response.spot).toBeNull();
    }
  });
});

/* ------------------------------------------------- a spot and its row - */

const PILOT = join(import.meta.dirname, "../scripts/flop-library/pilot", DEFAULT_CHART_SET, FLOP_PROFILE.tree);
const manifest = existsSync(join(PILOT, "manifest.json")) ? (JSON.parse(readFileSync(join(PILOT, "manifest.json"), "utf8")) as FlopManifest) : null;
const sameCharts = manifest !== null && manifest.charts.hash === library.sets.get(DEFAULT_CHART_SET)!.model.hash;

describe.runIf(sameCharts)("a flop answer kept by the mode", () => {
  const flops = memoryLibrary(manifest!.entries.map((entry) => decodeChunk(readFileSync(join(PILOT, entry.path)))));

  it("is graded from the chunk it was dealt from, and kept as a row the table's checks pass", async () => {
    const loader = { ...flops, ready: async () => true, load: async (set: string, line: string, flop: string) => flops.get(set, line, flop) };
    let kept = 0;
    for (const seed of [3, 41, 599, 7001]) {
      const request = flopRequest({ ...DEFAULT_TRAIN_STATE, mode: "flop" }, seed);
      const dealt = runTrainingJob(request, library, await prepareFlopLibrary(request, library, loader));
      if (dealt.type !== "spot" || !dealt.spot || dealt.spot.kind !== "flop") continue;
      const spot = dealt.spot;
      expect(spot.set).toBe(DEFAULT_CHART_SET);
      const answer: TrainingRequest = { type: "answer", jobId: 2, spot, menuIndex: 0 };
      const graded = runTrainingJob(answer, library, await prepareFlopLibrary(answer, library, loader));
      if (graded.type !== "graded" || !graded.decision?.grade) throw new Error(`seed ${seed}: not graded`);
      const d = graded.decision;
      expect(d.source).toBe("solver");
      expect(d.facts.flop).toMatchObject({ source: "library", line: spot.lineId, flop: spot.flop, mapped: false });
      const row = trainerResultOf(spot, { grade: d.grade!, evLoss: d.evLoss ?? 0, evLossPot: d.evLossPot ?? 0, score: d.score ?? 0 }, d.facts.handClass);
      expect(row).toMatchObject({ mode: "flop", family: spot.pot, spot: spot.lineId, position: spot.hero, grade: d.grade });
      // `trainer_results`' checks.
      expect(row!.family).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      expect(row!.spot.length).toBeLessThanOrEqual(200);
      expect(row!.position).toMatch(/^[A-Z0-9+]{1,8}$/);
      if (row!.handClass !== null) expect(row!.handClass).toMatch(/^[2-9TJQKA]{2}[so]?$/);
      expect(row!.score).toBeGreaterThanOrEqual(0);
      expect(row!.score).toBeLessThanOrEqual(100);
      kept += 1;
    }
    expect(kept).toBeGreaterThan(0);
  });
});

describe("the trainer result of a spot", () => {
  it("is not kept for a turn spot, which no mode deals", () => {
    const turn = { kind: "turn" } as Parameters<typeof trainerResultOf>[0];
    expect(trainerResultOf(turn, { grade: "good", evLoss: 0, evLossPot: 0, score: 90 }, null)).toBeNull();
  });
});

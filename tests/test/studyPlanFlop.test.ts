/**
 * The study plan's flop trainer target (`docs/ANALYSIS-PLAN.md` §10,
 * 2026-10-31): a flop focus area on a line Rail's flop library solves sends
 * the learner to the Train tab's flop mode, and its task counts the kept flop
 * answers (`trainer_results` mode `flop`: family the pot type, spot the line
 * id, the hero's seat) as `study_plan` counts them
 * (`20271031090000_study_plan_flop_target.sql`, pinned by pgTAP).
 *
 * - **The mapping**: seat, role and side pick the library's lines on the
 *   first table that has one (6-max, full ring, heads-up); what the hero
 *   faced picks the node; one line is named; a multiway spot or a seat no
 *   line holds keeps no trainer.
 * - **The task**: its reference, filter and target as the database takes
 *   them, read back from a reference and from a stored focus snapshot.
 * - **The address**: the plan's link opens the flop mode with the table,
 *   seat, role, side, facing and line set, and the trainer deals there.
 * - **The count**: a flop answer dealt from that address, on the committed
 *   pilot chunks, is a row the task's filter counts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE, memoryLibrary, type SpotRow } from "../../web/src/lib/analysis/index.js";
import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { decodeChunk, type FlopManifest } from "../../web/src/lib/solver/index.js";
import { prepareFlopLibrary, runTrainingJob, type TrainingRequest } from "../../web/src/lib/training/jobs.js";
import {
  TRAIN_TARGET,
  flopTargetSeatings,
  focusAreas,
  parseFocus,
  parseTrainerRef,
  planTasks,
  rpcTask,
  trainerMatch,
  trainerRef,
  trainerTarget,
  type AreaWhere,
  type TrainerTarget,
} from "../../web/src/lib/training/plan.js";
import {
  DEFAULT_TRAIN_STATE,
  flopLinesAt,
  flopSeatsAt,
  parseTrainState,
  spotOptions,
  targetQuery,
  trainerResultOf,
  trainQuery,
} from "../../web/src/components/analysis/train/trainState.js";
import { planEn } from "../../web/src/lib/i18n/ns/analysisPlan.en.js";
import { planHr } from "../../web/src/lib/i18n/ns/analysisPlan.hr.js";
import { courseEn } from "../../web/src/lib/i18n/ns/course.en.js";
import { courseHr } from "../../web/src/lib/i18n/ns/course.hr.js";
import { fullLibrary } from "./charts/support.js";

const SIX = DEFAULT_CHART_SET;
const NINE = "nlhe-cash-9max-100bb";
const HU100 = "nlhe-cash-hu-100bb";

const flop = (scenario: string, hero: string, family = scenario.replace(/^(pfr|caller|limped)-(ip|oop)-/, "")): AreaWhere => ({
  street: "flop",
  scenario,
  family,
  hero,
  villain: "-",
});

/** `save_study_plan`'s check on a train task's reference. */
const REF = /^(preflop|river)(\/[A-Za-z0-9+-]{1,30}){0,5}$|^flop(\/[A-Za-z0-9+-]{1,30}){6,7}$/;
/** `save_study_plan`'s check on a trainer filter's spots. */
const MATCH_SPOT = /^[a-z0-9][a-z0-9-]{0,39}:[A-Z0-9+]{1,8}$/;

/* --------------------------------------------------------- the mapping - */

// Skipped since analysis/41: a flop trainer target names a flop-library table (6-max 100bb, full ring,
// heads-up), and no flop library is published on the GTO Wizard ranges - nor are those classic sets
// transcribed yet (the default set is the 6-max 100bb ante set, whose id is too long for a trainer
// reference's 20-character part). Re-enable when a library on the current ranges ships.
describe.skip("a flop area's trainer", () => {
  it("is the flop trainer on the library lines of the hero's seat, role and side", () => {
    // The big blind defending a single-raised pot, facing the c-bet: four openers, one task.
    const bb = trainerTarget(flop("caller-oop-vs-bet", "BB"));
    // An untagged area is single-raised since 2026-11-05 (a 3-bet or 4-bet+ pot is its own area).
    expect(bb).toEqual({ mode: "flop", set: SIX, pot: "srp", side: "oop", role: "caller", seat: "BB", facing: "bet", line: null });
    expect(trainerMatch(bb!)).toEqual({
      mode: "flop",
      family: "srp",
      position: "BB",
      spots: ["btn-bb:BB", "co-bb:BB", "hj-bb:BB", "utg-bb:BB"],
    });
  });

  it("deals what the hero faced: first out of position, behind a check in position, a bet, a raise", () => {
    // The small blind's open called; its 3-bet of the button called is the 3-bet pot area's (§10 2026-11-05).
    expect(trainerMatch(trainerTarget(flop("pfr-oop-first", "SB"))!).spots).toEqual(["sb-bb:SB"]);
    expect(trainerTarget(flop("pfr-oop-first", "SB"))).toMatchObject({ mode: "flop", set: SIX, line: "sb-bb", facing: "any" });
    expect(trainerMatch(trainerTarget({ ...flop("pfr-oop-first", "SB"), pot: "3bp" })!).spots).toEqual(["btn-sb-3bet:SB"]);
    expect(trainerTarget(flop("pfr-ip-first", "BTN"))).toMatchObject({ mode: "flop", facing: "check", side: "ip" });
    expect(trainerTarget(flop("pfr-ip-vs-bet", "BTN"))).toMatchObject({ mode: "flop", facing: "bet" });
    expect(trainerTarget(flop("caller-oop-vs-raise", "BB"))).toMatchObject({ mode: "flop", facing: "raise" });
  });

  it("names the line when exactly one fits", () => {
    // The small blind's limp, checked behind: one line.
    expect(trainerTarget(flop("limped-oop-first", "SB"))).toEqual({
      mode: "flop",
      set: SIX,
      pot: "limped",
      side: "oop",
      role: "any",
      seat: "SB",
      facing: "any",
      line: "sb-limp",
    });
    // The cutoff calling the button's 3-bet out of position (the 3-bet pot area): `co-btn-3bet` only.
    const coThree = { ...flop("caller-oop-first", "CO"), pot: "3bp" };
    expect(trainerTarget(coThree)).toMatchObject({ set: SIX, pot: "3bp", line: "co-btn-3bet" });
    const match = trainerMatch(trainerTarget(coThree)!);
    expect(match).toEqual({ mode: "flop", family: "3bp", position: "CO", spots: ["co-btn-3bet:CO"] });
    // Single-raised, the cutoff never calls out of position on a library line.
    expect(trainerTarget(flop("caller-oop-first", "CO"))).toBeNull();
  });

  it("finds the table that has the line: full ring for its own seats, heads-up for the small blind in position", () => {
    expect(trainerTarget(flop("pfr-ip-first", "LJ"))).toMatchObject({ mode: "flop", set: NINE, seat: "LJ", line: "lj-bb" });
    // No 6-max or full-ring line has the small blind in position; heads-up, the small blind is the button.
    const sb = trainerTarget(flop("pfr-ip-first", "SB"));
    expect(sb).toMatchObject({ mode: "flop", set: HU100, pot: "srp", seat: "SB", side: "ip", role: "pfr", facing: "check", line: "sb-bb" });
    expect(trainerMatch(sb!)).toMatchObject({ family: "srp", spots: ["sb-bb:SB"] });
    // Its 4-bet pot (the `~4bp` area, §10 2026-11-05): the trainer files a 4-bet pot as a 3-bet one, so the line is named.
    const four = trainerTarget({ ...flop("pfr-ip-first", "SB"), pot: "4bp" });
    expect(four).toMatchObject({ mode: "flop", set: HU100, pot: "3bp", seat: "SB", line: "sb-bb-4bet" });
    expect(trainerMatch(four!)).toMatchObject({ family: "3bp", spots: ["sb-bb-4bet:SB"] });
    // ... and its 3-bet pot the 3-bet line alone, never the 4-bet one the same filter would deal.
    expect(trainerTarget({ ...flop("pfr-ip-first", "SB"), pot: "3bp" })).toBeNull();
    expect(trainerTarget({ ...flop("pfr-oop-first", "BB"), pot: "3bp", table: "hu" })).toMatchObject({ set: HU100, line: "sb-bb-3bet" });
  });

  it("keeps an area merged past the seat, or past everything but the street", () => {
    expect(trainerTarget(flop("pfr-oop-first", "*"))).toEqual({
      mode: "flop",
      set: SIX,
      pot: "srp",
      side: "oop",
      role: "pfr",
      seat: null,
      facing: "any",
      // Single-raised, the preflop raiser is out of position on one line only: the small blind's open.
      line: "sb-bb",
    });
    const street = trainerTarget({ street: "flop", scenario: "*", family: "*", hero: "*", villain: "*" });
    expect(street).toEqual({ mode: "flop", set: SIX, pot: "srp", side: "any", role: "any", seat: null, facing: "any", line: null });
    // Every single-raised flop answer counts (since 2026-11-05: a 3-bet pot is another area's).
    expect(trainerMatch(street!)).toMatchObject({ mode: "flop", family: "srp", position: null });
    expect(trainerMatch(street!).spots).toHaveLength(12);
    expect(trainerMatch({ ...(street as Extract<TrainerTarget, { mode: "flop" }>), pot: "any" })).toEqual({
      mode: "flop",
      family: null,
      position: null,
      spots: null,
    });
    expect(trainerTarget({ street: "flop", scenario: "*", family: "vs-raise", hero: "*", villain: "*" })).toMatchObject({ facing: "raise" });
  });

  it("keeps no trainer for a multiway spot or a seat no library line holds", () => {
    expect(trainerTarget(flop("pfr-mw-oop-first", "UTG", "first"))).toBeNull();
    // The library's lines have no under-the-gun caller, on any table.
    expect(trainerTarget(flop("caller-oop-vs-bet", "UTG"))).toBeNull();
    expect(trainerTarget(flop("caller-ip-first", "UTG+1"))).toBeNull();
    // The turn keeps none either.
    expect(trainerTarget({ ...flop("pfr-oop-first", "BTN"), street: "turn" })).toBeNull();
  });

  it("counts only lines and seats the target deals", () => {
    for (const [scenario, hero] of [
      ["caller-oop-vs-bet", "BB"],
      ["pfr-ip-first", "BTN"],
      ["pfr-ip-first", "SB"],
      ["pfr-ip-first", "LJ"],
      ["limped-ip-vs-bet", "BB"],
    ] as const) {
      const target = trainerTarget(flop(scenario, hero))!;
      expect(target.mode).toBe("flop");
      if (target.mode !== "flop") continue;
      const seatings = flopTargetSeatings(target);
      expect(seatings.length).toBeGreaterThan(0);
      for (const s of seatings) {
        expect(s.hero).toBe(hero);
        expect(flopLinesAt(target.set).some((line) => line.id === s.line.id)).toBe(true);
      }
      const match = trainerMatch(target);
      expect(match.spots).toEqual([...new Set(seatings.map((s) => `${s.line.id}:${s.hero}`))].sort());
      for (const spot of match.spots!) expect(spot).toMatch(MATCH_SPOT);
      expect(match.spots!.length).toBeLessThanOrEqual(40);
    }
  });
});

/* ------------------------------------------------------------ the task - */

// Skipped since analysis/41: a flop trainer target names a flop-library table (6-max 100bb, full ring,
// heads-up), and no flop library is published on the GTO Wizard ranges - nor are those classic sets
// transcribed yet (the default set is the 6-max 100bb ante set, whose id is too long for a trainer
// reference's 20-character part). Re-enable when a library on the current ranges ships.
describe.skip("a flop area's task", () => {
  const targets: TrainerTarget[] = [
    trainerTarget(flop("caller-oop-vs-bet", "BB"))!,
    trainerTarget(flop("limped-oop-first", "SB"))!,
    trainerTarget(flop("pfr-ip-first", "SB"))!,
    trainerTarget(flop("pfr-ip-first", "LJ"))!,
    trainerTarget({ street: "flop", scenario: "*", family: "*", hero: "*", villain: "*" })!,
  ];

  it("writes a reference the database takes, read back as its target", () => {
    expect(trainerRef(targets[0])).toBe("flop/nlhe-cash-6max-100bb/srp/oop/caller/BB/bet");
    expect(trainerRef(targets[1])).toBe("flop/nlhe-cash-6max-100bb/limped/oop/any/SB/any/sb-limp");
    for (const target of targets) {
      const ref = trainerRef(target);
      expect(ref).toMatch(REF);
      expect(ref.length).toBeLessThanOrEqual(120);
      expect(parseTrainerRef(ref)).toEqual(target);
    }
    for (const junk of [
      "flop",
      "flop/nlhe-cash-6max-100bb/any/oop/caller/BB",
      "flop/nlhe-cash-6max-40bb/any/oop/caller/BB/bet",
      "flop/nlhe-cash-6max-100bb/any/oop/caller/XX/bet",
      "flop/nlhe-cash-6max-100bb/any/oop/caller/BB/shove",
      "flop/nlhe-cash-6max-100bb/any/oop/caller/BB/bet/sb-bb-4bet",
      "flop/nlhe-cash-6max-100bb/any/oop/caller/BB/bet/btn-bb/x",
    ]) {
      expect(parseTrainerRef(junk)).toBeNull();
    }
  });

  it("is a week's flop trainer target, filtered by mode, family, seat and (line, seat)", () => {
    const rows: SpotRow[] = [
      // The big blind calling the button's c-bet away too often: 12 decisions, 6 folds the solve calls.
      {
        key: "flop|caller-oop-vs-bet||BB|fold|call",
        street: "flop",
        scenario: "caller-oop-vs-bet",
        line: "",
        position: "BB",
        taken: "fold",
        best: "call",
        decisions: 12,
        hands: 12,
        nonPerfect: 6,
        mistakes: 6,
        evLossBb: 9,
        evLossPot: 1.2,
        scoreSum: 700,
        scoreSq: 50000,
      },
    ];
    const [area] = focusAreas(rows, 60);
    expect(area.trainer).toEqual(targets[0]);
    const tasks = planTasks({ areas: [area], hands: {}, drills: new Map() });
    const train = tasks.find((task) => task.kind === "train")!;
    expect(train.target).toBe(TRAIN_TARGET.flop);
    expect(TRAIN_TARGET.flop).toBeGreaterThan(TRAIN_TARGET.river);
    expect(TRAIN_TARGET.flop).toBeLessThan(TRAIN_TARGET.preflop);
    expect(rpcTask(train)).toMatchObject({
      kind: "train",
      ref: "flop/nlhe-cash-6max-100bb/srp/oop/caller/BB/bet",
      target: 15,
      match_mode: "flop",
      match_family: "srp",
      match_position: "BB",
      match_spots: ["btn-bb:BB", "co-bb:BB", "hj-bb:BB", "utg-bb:BB"],
      spot_keys: null,
    });
    // A stored focus snapshot keeps the target.
    expect(parseFocus(JSON.parse(JSON.stringify([area])))[0].trainer).toEqual(targets[0]);
    // A tampered one keeps what is valid and drops a line the table does not have.
    const [tampered] = parseFocus([{ ...area, trainer: { ...targets[0], line: "nonsense", facing: "shove", seat: "XX" } }]);
    expect(tampered.trainer).toEqual({ ...targets[0], seat: null, facing: "any", line: null });
  });
});

/* --------------------------------------------------------- the address - */

// Skipped since analysis/41: a flop trainer target names a flop-library table (6-max 100bb, full ring,
// heads-up), and no flop library is published on the GTO Wizard ranges - nor are those classic sets
// transcribed yet (the default set is the 6-max 100bb ante set, whose id is too long for a trainer
// reference's 20-character part). Re-enable when a library on the current ranges ships.
describe.skip("a flop task's link", () => {
  it("opens the flop mode with the table, seat, role, side, facing and line", () => {
    const query = targetQuery(trainerTarget(flop("caller-oop-vs-bet", "BB"))!);
    expect(query).toBe("mode=flop&pot=srp&side=oop&role=caller&seat=BB&facing=bet");
    const state = parseTrainState(Object.fromEntries(new URLSearchParams(query)));
    expect(spotOptions("flop", state)).toEqual({ set: SIX, pot: "srp", seat: "oop", role: "caller", facing: "bet", hero: "BB", bias: "borderline" });

    const limp = targetQuery(trainerTarget(flop("limped-oop-first", "SB"))!);
    expect(limp).toBe("mode=flop&pot=limped&side=oop&seat=SB&line=sb-limp");
    expect(spotOptions("flop", parseTrainState(Object.fromEntries(new URLSearchParams(limp))))).toMatchObject({ hero: "SB", line: "sb-limp" });

    const hu = targetQuery(trainerTarget(flop("pfr-ip-first", "SB"))!);
    expect(hu).toBe(`mode=flop&set=${HU100}&pot=srp&side=ip&role=pfr&seat=SB&facing=check&line=sb-bb`);
    expect(trainQuery(parseTrainState(Object.fromEntries(new URLSearchParams(hu))))).toBe(hu);
  });

  it("drops a seat or a line the table's flops do not have", () => {
    expect(flopSeatsAt(SIX)).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(flopSeatsAt(HU100)).toEqual(["SB", "BB"]);
    expect(flopSeatsAt(NINE)).not.toContain("UTG+1");
    // A preflop seat carried over to the flop is not a filter there when no line has it.
    const state = { ...DEFAULT_TRAIN_STATE, mode: "flop" as const, set: NINE, seat: "UTG+1" as const };
    expect(spotOptions("flop", state)).not.toHaveProperty("hero");
    expect(trainQuery(state)).toBe(`mode=flop&set=${NINE}`);
    // A line of another table is not read from an address.
    expect(parseTrainState({ mode: "flop", set: SIX, line: "sb-limp-raise" }).line).toBeNull();
    expect(parseTrainState({ mode: "flop", set: HU100, line: "sb-limp-raise" }).line).toBe("sb-limp-raise");
  });
});

/* ----------------------------------------------------------- the words - */

describe("a flop task's words", () => {
  it("name every line of a table apart, in English and Croatian (the trainer's line filter)", () => {
    for (const set of [SIX, NINE, HU100]) {
      for (const lineName of [courseEn.spot.lineName, courseHr.spot.lineName]) {
        const names = flopLinesAt(set).map((line) => lineName(line.id));
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name).not.toMatch(/RAISE|4BET|LIMP/);
      }
    }
    expect(courseEn.spot.lineName("btn-bb-3bet")).toBe("BTN–BB 3-bet pot");
    expect(courseEn.spot.lineName("sb-bb-4bet")).toBe("SB–BB 4-bet pot");
    expect(courseEn.spot.lineName("sb-limp-raise")).toBe("SB–BB limp-raised pot");
  });

  it("say what the task trains", () => {
    expect(planEn.tasks.trainFlop("caller", "oop", null, "BB", "bet", null)).toBe(
      "flop, as BB, as the preflop caller, out of position, facing a bet",
    );
    expect(planEn.tasks.trainFlop(null, null, null, null, null, null)).toBe("any flop");
    expect(planHr.tasks.trainFlop("pfr", "ip", null, "SB", "check", null, true)).toBe(
      "flop, s pozicije SB, kao preflop raiser, u poziciji, nakon checka, heads-up",
    );
  });
});

/* ----------------------------------------------------------- the count - */

const library = fullLibrary();
const PILOT = join(import.meta.dirname, "../scripts/flop-library/pilot", DEFAULT_CHART_SET, FLOP_PROFILE.tree);
const manifest = existsSync(join(PILOT, "manifest.json")) ? (JSON.parse(readFileSync(join(PILOT, "manifest.json"), "utf8")) as FlopManifest) : null;
const sameCharts = manifest !== null && manifest.charts.hash === library.sets.get(DEFAULT_CHART_SET)!.model.hash;

/** `study_plan`'s count of one trainer answer against a task's filter. */
const counts = (match: ReturnType<typeof trainerMatch>, row: { mode: string; family: string; spot: string; position: string | null }) =>
  row.mode === match.mode &&
  (match.family === null || row.family === match.family) &&
  (match.position === null || row.position === match.position) &&
  (match.spots === null || match.spots.includes(`${row.spot}:${row.position ?? ""}`));

describe.runIf(sameCharts)("a flop answer dealt from the task's link", () => {
  // needs the flop-library pilot chunks, deleted with Rail's own ranges (analysis/41): none are solved on the GTO Wizard ranges yet.
  if (!sameCharts) {
    it.skip("waits for a flop library on the GTO Wizard ranges", () => {});
    return;
  }
  const flops = memoryLibrary(manifest!.entries.map((entry) => decodeChunk(readFileSync(join(PILOT, entry.path)))));
  const loader = { ...flops, ready: async () => true, load: async (set: string, line: string, at: string) => flops.get(set, line, at) };

  it("is dealt on the area's lines and seat, and counts towards the task", async () => {
    const target = trainerTarget(flop("caller-oop-vs-bet", "BB"))!;
    const match = trainerMatch(target);
    const state = parseTrainState(Object.fromEntries(new URLSearchParams(targetQuery(target))));
    let counted = 0;
    for (const seed of [3, 41, 599, 7001, 31337]) {
      const request: TrainingRequest = { type: "flop", jobId: 1, options: spotOptions("flop", state), seed };
      const dealt = runTrainingJob(request, library, await prepareFlopLibrary(request, library, loader));
      if (dealt.type !== "spot" || !dealt.spot || dealt.spot.kind !== "flop") continue;
      const spot = dealt.spot;
      // The pilot holds `btn-bb` and `btn-bb-3bet`; the big blind calls only on the first.
      expect(spot.lineId).toBe("btn-bb");
      expect(spot.hero).toBe("BB");
      expect(spot.facing).not.toBeNull();
      const row = trainerResultOf(spot, { grade: "good", evLoss: 0.1, evLossPot: 0.01, score: 90 }, null)!;
      expect(counts(match, row)).toBe(true);
      // The same answer from the other seat, or as a river answer, does not count.
      expect(counts(match, { ...row, position: "BTN" })).toBe(false);
      expect(counts(match, { ...row, mode: "river" })).toBe(false);
      counted += 1;
    }
    expect(counted).toBeGreaterThan(0);
  });
});

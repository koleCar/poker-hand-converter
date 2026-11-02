/**
 * A postflop leak's table in the study plan (`docs/ANALYSIS-PLAN.md` §10,
 * 2026-11-02): since `20271102090000_leak_row_table.sql` a flop, turn or
 * river leak row carries its hand's chart set (`analysis_hand_table_set`,
 * pinned by pgTAP `leak_row_table.test.sql`), and the plan deals the area's
 * trainer on that table.
 *
 * - **The database's list**: the migration's sets are `CHART_SETS` without
 *   the straddle set, in its order (ties go to the first, as `pickChartSet`).
 * - **The leak finder**: a postflop leak's id is what it was (no table tag);
 *   its `sets` count the tables its decisions were met on.
 * - **The flop**: a heads-up big-blind leak deals the heads-up lines at the
 *   nearest depth, a 6-max one the 6-max lines, a full-ring one the full-ring
 *   lines; a heads-up area is never dealt another table's lines; a row with no
 *   set (written before) keeps the old guess.
 * - **The river**: a heads-up leak deals the heads-up lines (`hu-` ids), its
 *   reference, filter, address and words say so; 6-max and full ring keep
 *   the 6-max lines, the reference as it was.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { groupLeaks, type SpotRow } from "../../web/src/lib/analysis/leaks.js";
import { CHART_SETS, DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { generateRiverSpot } from "../../web/src/lib/training/index.js";
import { RIVER_LINES_HU } from "../../web/src/lib/training/river.js";
import {
  areaSet,
  flopTargetSeatings,
  focusAreas,
  parseFocus,
  parseTrainerRef,
  planTasks,
  rpcTask,
  tableSets,
  trainerMatch,
  trainerRef,
  trainerTarget,
  type AreaWhere,
} from "../../web/src/lib/training/plan.js";
import { parseTrainState, spotOptions, targetQuery } from "../../web/src/components/analysis/train/trainState.js";
import { planEn } from "../../web/src/lib/i18n/ns/analysisPlan.en.js";
import { planHr } from "../../web/src/lib/i18n/ns/analysisPlan.hr.js";
import { fullLibrary } from "./charts/support.js";

const SIX = DEFAULT_CHART_SET;
const SIX150 = "nlhe-cash-6max-150bb";
const SIX200 = "nlhe-cash-6max-200bb";
const NINE = "nlhe-cash-9max-100bb";
const NINE150 = "nlhe-cash-9max-150bb";
const HU100 = "nlhe-cash-hu-100bb";
const HU150 = "nlhe-cash-hu-150bb";

/** `save_study_plan`'s checks on a train task. */
const REF = /^(preflop|river)(\/[A-Za-z0-9+-]{1,20}){0,5}$|^flop(\/[A-Za-z0-9+-]{1,20}){6,7}$/;
const MATCH_SPOT = /^[a-z0-9][a-z0-9-]{0,39}:[A-Z0-9+]{1,8}$/;

function row(street: string, scenario: string, position: string, taken: string, best: string, decisions: number, set: string | null, evLossBb = 0): SpotRow {
  const mistakes = taken === best ? 0 : decisions;
  return {
    key: [street, scenario, "", position, taken, best].join("|"),
    set,
    street,
    scenario,
    line: "",
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

const where = (street: string, scenario: string, hero: string): AreaWhere => ({
  street,
  scenario,
  family: scenario.replace(/^(pfr|caller|limped)-(ip|oop)-/, ""),
  hero,
  villain: "-",
});

/* ------------------------------------------------------------ the list - */

describe("the database's table helper", () => {
  it("knows exactly the plain chart sets, in CHART_SETS' order", () => {
    const sql = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20271102090000_leak_row_table.sql"), "utf8");
    const listed = [...sql.matchAll(/\('(nlhe-cash-[a-z0-9-]+)', (\d+), (\d+), (\d+)\)/g)].map((m) => ({
      id: m[1],
      players: Number(m[2]),
      stackBb: Number(m[3]),
      n: Number(m[4]),
    }));
    const plain = CHART_SETS.filter((spec) => !spec.straddle);
    expect(listed.map(({ id, players, stackBb }) => ({ id, players, stackBb }))).toEqual(
      plain.map(({ id, players, stackBb }) => ({ id, players, stackBb })),
    );
    expect(listed.map((x) => x.n)).toEqual(plain.map((_, i) => i + 1));
  });
});

/* ------------------------------------------------------ the leak finder - */

describe("a postflop leak with its table", () => {
  it("keeps its id and counts the tables it was met on", () => {
    const rows = [
      row("river", "caller-oop-vs-bet", "BB", "fold", "call", 4, HU100, 3),
      row("river", "caller-oop-vs-bet", "BB", "fold", "call", 2, SIX, 1),
      row("river", "caller-oop-vs-bet", "BB", "call", "call", 30, HU100),
    ];
    const [leak] = groupLeaks(rows, { hands: 100 });
    expect(leak.id).toBe("river~caller-oop-vs-bet~vs-bet~BB~-~fold~call");
    expect(leak.attrs.table).toBeUndefined();
    expect(leak.sets).toEqual({ [HU100]: 4, [SIX]: 2 });
    expect(areaSet([leak])).toBe(HU100);
  });

  it("orders a table's sets by depth from the area's own", () => {
    expect(tableSets(HU150, [SIX, SIX150, NINE, HU100, HU150])).toEqual([HU150, HU100]);
    expect(tableSets(SIX200, [SIX, SIX150, NINE, HU100, HU150])).toEqual([SIX150, SIX]);
    expect(tableSets(NINE150, [SIX, SIX150, NINE, HU100, HU150])).toEqual([NINE]);
    expect(tableSets(null, [SIX])).toEqual([]);
    expect(tableSets("nlhe-cash-6max-100bb-straddle", [SIX])).toEqual([]);
    expect(tableSets("junk", [SIX])).toEqual([]);
  });
});

/* ------------------------------------------------------------- the flop - */

describe("a flop area on its own table", () => {
  it("deals a heads-up big-blind leak on the heads-up lines, at the nearest depth", () => {
    const bb = where("flop", "caller-oop-vs-bet", "BB");
    for (const [set, deal] of [
      [HU100, HU100],
      [HU150, HU150],
    ] as const) {
      const target = trainerTarget(bb, set);
      expect(target).toMatchObject({ mode: "flop", set: deal, seat: "BB", side: "oop", role: "caller", facing: "bet" });
      if (target?.mode !== "flop") throw new Error("not a flop target");
      const seatings = flopTargetSeatings(target);
      expect(seatings.length).toBeGreaterThan(0);
      // Heads-up the big blind defends the small blind's open (and its limp raised): never a 6-max opener's.
      for (const s of seatings) expect(s.villain).toBe("SB");
      const ref = trainerRef(target);
      expect(ref).toMatch(REF);
      expect(parseTrainerRef(ref)).toEqual(target);
      const state = parseTrainState(Object.fromEntries(new URLSearchParams(targetQuery(target))));
      expect(spotOptions("flop", state).set).toBe(deal);
    }
  });

  it("deals a 6-max leak on 6-max lines and a full-ring one on full-ring lines", () => {
    const bb = where("flop", "caller-oop-vs-bet", "BB");
    expect(trainerTarget(bb, SIX)).toMatchObject({ mode: "flop", set: SIX });
    // 200bb has no library: the 6-max library set nearest it.
    expect(trainerTarget(bb, SIX200)).toMatchObject({ mode: "flop", set: SIX150 });
    expect(trainerTarget(bb, NINE)).toMatchObject({ mode: "flop", set: NINE });
    expect(trainerTarget(bb, NINE150)).toMatchObject({ mode: "flop", set: NINE });
    expect(trainerMatch(trainerTarget(bb, NINE)!).spots).toContain("lj-bb:BB");
  });

  it("never deals a heads-up area on another table's lines", () => {
    // The small blind in position exists heads-up only; the button heads-up is the small blind.
    expect(trainerTarget(where("flop", "pfr-ip-first", "SB"), HU100)).toMatchObject({ set: HU100 });
    expect(trainerTarget(where("flop", "pfr-ip-first", "BTN"), HU100)).toBeNull();
    // ... and a 6-max area is not sent to the heads-up table for a seat 6-max lacks there.
    expect(trainerTarget(where("flop", "pfr-ip-first", "SB"), SIX)).toBeNull();
  });

  it("keeps the old guess for a row written before (no set)", () => {
    expect(trainerTarget(where("flop", "caller-oop-vs-bet", "BB"))).toMatchObject({ set: SIX });
    expect(trainerTarget(where("flop", "caller-oop-vs-bet", "BB"), "")).toMatchObject({ set: SIX });
    expect(trainerTarget(where("flop", "pfr-ip-first", "LJ"), null)).toMatchObject({ set: NINE });
    expect(trainerTarget(where("flop", "pfr-ip-first", "SB"), null)).toMatchObject({ set: HU100 });
  });

  it("goes from the leak rows to a heads-up task", () => {
    const rows = [
      row("flop", "caller-oop-vs-bet", "BB", "fold", "call", 9, HU150, 6),
      row("flop", "caller-oop-vs-bet", "BB", "fold", "call", 1, SIX, 0.5),
      row("flop", "caller-oop-vs-bet", "BB", "call", "call", 40, HU150),
    ];
    const [area] = focusAreas(rows, 300);
    expect(area.trainer).toMatchObject({ mode: "flop", set: HU150, seat: "BB" });
    const [task] = planTasks({ areas: [area], drills: new Map(), hands: {}, previous: null }).filter((t) => t.kind === "train");
    expect(task.ref).toMatch(REF);
    expect(task.ref.startsWith(`flop/${HU150}/`)).toBe(true);
    expect(rpcTask(task).match_mode).toBe("flop");
    expect(parseFocus(JSON.parse(JSON.stringify([area])))[0].trainer).toEqual(area.trainer);
  });
});

/* ------------------------------------------------------------ the river - */

describe("a river area on its own table", () => {
  const library = fullLibrary();

  it("deals a heads-up leak on the heads-up lines, counted by their ids", () => {
    const oop = trainerTarget(where("river", "caller-oop-first", "BB"), HU100);
    expect(oop).toEqual({ mode: "river", pot: "any", side: "oop", role: "caller", set: HU100 });
    const match = trainerMatch(oop!);
    expect(match.mode).toBe("river");
    expect(match.spots!.length).toBeGreaterThan(0);
    for (const spot of match.spots!) {
      expect(spot).toMatch(MATCH_SPOT);
      expect(spot).toMatch(/^hu-/);
      expect(RIVER_LINES_HU.some((line) => spot.startsWith(`${line.id}:`))).toBe(true);
    }
    // Merged to the street, a heads-up area still counts only heads-up answers.
    const street = trainerTarget({ street: "river", scenario: "*", family: "*", hero: "*", villain: "*" }, HU150)!;
    expect(street).toEqual({ mode: "river", pot: "any", side: "any", role: "any", set: HU150 });
    expect(trainerMatch(street).spots!.every((s) => s.startsWith("hu-"))).toBe(true);
  });

  it("writes the set into the reference, the snapshot, the address and the words", () => {
    const target = trainerTarget(where("river", "pfr-ip-vs-bet", "SB"), HU150)!;
    expect(target).toEqual({ mode: "river", pot: "any", side: "ip", role: "pfr", set: HU150 });
    const ref = trainerRef(target);
    expect(ref).toBe(`river/any/ip/pfr/${HU150}`);
    expect(ref).toMatch(REF);
    expect(parseTrainerRef(ref)).toEqual(target);
    // A set the river has no heads-up lines for is not a river reference.
    expect(parseTrainerRef(`river/any/ip/pfr/${SIX}`)).toBeNull();
    expect(parseTrainerRef("river/any/ip/pfr/junk")).toBeNull();
    const state = parseTrainState(Object.fromEntries(new URLSearchParams(targetQuery(target))));
    expect(state.mode).toBe("river");
    expect(spotOptions("river", state)).toMatchObject({ set: HU150, seat: "ip", role: "pfr" });
    expect(planEn.tasks.trainRiver("pfr", "ip", null, true)).toContain("heads-up");
    expect(planHr.tasks.trainRiver("pfr", "ip", null, true)).toContain("heads-up");
    expect(planEn.tasks.trainRiver("pfr", "ip", null)).not.toContain("heads-up");
  });

  it("is dealt where the task counts it", () => {
    const target = trainerTarget(where("river", "caller-oop-first", "BB"), HU100)!;
    const options = spotOptions("river", parseTrainState(Object.fromEntries(new URLSearchParams(targetQuery(target)))));
    const counted = new Set(trainerMatch(target).spots);
    let dealt = 0;
    for (let seed = 1; seed < 10 && dealt < 2; seed += 1) {
      const spot = generateRiverSpot(library, options, seed);
      if (!spot) continue;
      dealt += 1;
      expect(spot.set).toBe(HU100);
      expect(spot.hero).toBe("BB");
      expect(counted.has(`${spot.lineId}:${spot.hero}`)).toBe(true);
    }
    expect(dealt).toBe(2);
  });

  it("keeps the 6-max lines and the old reference at 6-max and full ring, and for rows with no set", () => {
    const bb = where("river", "caller-oop-first", "BB");
    for (const set of [SIX, SIX200, NINE, null, ""]) {
      const target = trainerTarget(bb, set);
      expect(target).toEqual({ mode: "river", pot: "any", side: "oop", role: "caller" });
      expect(trainerRef(target!)).toBe("river/any/oop/caller");
      expect(trainerMatch(target!).spots!.some((s) => s.startsWith("hu-"))).toBe(false);
      expect(parseTrainState(Object.fromEntries(new URLSearchParams(targetQuery(target!)))).set).toBe(SIX);
    }
  });
});

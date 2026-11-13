/**
 * A postflop leak area per table (`docs/ANALYSIS-PLAN.md` §10, 2026-11-02):
 * since `20271102090000_leak_row_table.sql` a flop, turn or river leak row
 * carries its hand's chart set, and the leak finder now tags a postflop spot
 * by it as it tags a preflop chart spot (`~hu`, `~9max`; 6-max and no set
 * untagged).
 *
 * - **Split**: heads-up, 6-max and 9-max rows with the same seat, role and
 *   side are three leaks, three focus areas, each trainer on its own table.
 * - **Thin spots**: a postflop tag is kept at every level, so a thin heads-up
 *   spot climbs on its own and never into a 6-max area; preflop the tag still
 *   goes with the seat.
 * - **Counting**: a spot key names no table, so a leak's or area's numbers
 *   are its keys in its own situations (a 6-max row on a heads-up area's key
 *   is not its); the hands filter (`handsTable`) says which table to read.
 * - **Old data**: untagged ids parse and read as before, a snapshot stored
 *   before keeps its numbers (every table on its keys), its area's weeks
 *   carry over to the tagged area, rows with no set stay untagged.
 */

import { describe, expect, it } from "vitest";

import {
  groupLeaks,
  handsTable,
  leakId,
  parseLeakId,
  spotAttrs,
  tableOfSet,
  type SpotRow,
} from "../../web/src/lib/analysis/leaks.js";
import { leakPeriod } from "../../web/src/lib/analysis/topLeaks.js";
import { FLOP_LIBRARY_SETS } from "../../web/src/lib/analysis/flopLibrary.js";
import { CHART_SETS, DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import {
  areaChange,
  areaPeriod,
  focusAreas,
  legacyAreaId,
  parseFocus,
  planFocus,
  planTasks,
  rpcTask,
  trainerMatch,
  trainerRef,
  trainerTarget,
} from "../../web/src/lib/training/plan.js";
import { leaksEn } from "../../web/src/lib/i18n/ns/analysisLeaks.en.js";
import { leaksHr } from "../../web/src/lib/i18n/ns/analysisLeaks.hr.js";

const SIX = DEFAULT_CHART_SET;
/** Since charts/11 the trainers deal only on transcribed sets, the flop on a published library: those cases wait. */
const HU_SHIPPED = ["nlhe-cash-hu-100bb", "nlhe-cash-hu-150bb"].every((id) => CHART_SETS.some((spec) => spec.id === id));
const FLOP_LIVE = FLOP_LIBRARY_SETS.length > 0;
const NINE = "nlhe-cash-9max-100bb";
const NINE150 = "nlhe-cash-9max-150bb";
const HU100 = "nlhe-cash-hu-100bb";
const HU150 = "nlhe-cash-hu-150bb";

/** `save_study_plan`'s checks: a drill task's reference (the area id) and a train task's. */
const DRILL_REF = /^[A-Za-z0-9*~+-]{1,120}$/;
const TRAIN_REF = /^(preflop|river)(\/[A-Za-z0-9+-]{1,20}){0,5}$|^flop(\/[A-Za-z0-9+-]{1,20}){6,7}$/;

function row(
  street: string,
  scenario: string,
  position: string,
  taken: string,
  best: string,
  decisions: number,
  set: string | null,
  evLossBb = 0,
  line = "",
): SpotRow {
  const mistakes = taken === best ? 0 : decisions;
  return {
    key: [street, scenario, line, position, taken, best].join("|"),
    set,
    street,
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

/** The big blind calling out of position and facing a river bet, on one table: 12 folds of a call, 30 calls. */
const bbRiver = (set: string | null, ev = 6) => [
  row("river", "caller-oop-vs-bet", "BB", "fold", "call", 12, set, ev),
  row("river", "caller-oop-vs-bet", "BB", "call", "call", 30, set),
];
/** The same on the flop. */
const bbFlop = (set: string | null, ev = 6) => [
  row("flop", "caller-oop-vs-bet", "BB", "fold", "call", 12, set, ev),
  row("flop", "caller-oop-vs-bet", "BB", "call", "call", 30, set),
];

/* ------------------------------------------------------------ the split - */

describe("a postflop leak per table", () => {
  it("tags a postflop row by its set, and leaves 6-max and no set untagged", () => {
    const tag = (set: string | null) => spotAttrs(row("river", "pfr-ip-first", "BTN", "check", "bet", 1, set)).table;
    expect(tag(HU100)).toBe("hu");
    expect(tag(HU150)).toBe("hu");
    expect(tag(NINE)).toBe("9max");
    expect(tag(NINE150)).toBe("9max");
    expect(tag(SIX)).toBeUndefined();
    expect(tag("nlhe-cash-6max-100bb-straddle")).toBeUndefined();
    expect(tag(null)).toBeUndefined();
    expect(tag("")).toBeUndefined();
    expect(tableOfSet(HU150)).toBe("hu");
    expect(tableOfSet(NINE)).toBe("9max");
    expect(tableOfSet(SIX)).toBeNull();
    // The flop and the turn as the river.
    expect(spotAttrs(row("flop", "caller-oop-vs-bet", "BB", "fold", "call", 1, HU100)).table).toBe("hu");
    expect(spotAttrs(row("turn", "caller-oop-vs-bet", "BB", "fold", "call", 1, NINE)).table).toBe("9max");
  });

  it("splits heads-up, 6-max and 9-max rows with the same seat, role and side", () => {
    const rows = [...bbRiver(HU100, 9), ...bbRiver(SIX, 6), ...bbRiver(NINE, 3)];
    const leaks = groupLeaks(rows, { hands: 500 });
    expect(leaks.map((leak) => leak.id)).toEqual([
      "river~caller-oop-vs-bet~vs-bet~BB~-~fold~call~hu",
      "river~caller-oop-vs-bet~vs-bet~BB~-~fold~call",
      "river~caller-oop-vs-bet~vs-bet~BB~-~fold~call~9max",
    ]);
    for (const leak of leaks) {
      expect(leak.level).toBe(0);
      expect(leak.decisions).toBe(12);
      expect(leak.spotDecisions).toBe(42);
      expect(Object.keys(leak.sets)).toHaveLength(1);
      expect(parseLeakId(leak.id)).toEqual(leak.attrs);
      expect(leak.id).toMatch(DRILL_REF);
    }
    // One key on all three tables: each leak's keys are the same, its situations its own.
    expect(new Set(leaks.map((leak) => leak.keys.join()))).toHaveProperty("size", 1);
    expect(new Set(leaks.map((leak) => leak.situationKeys.join()))).toHaveProperty("size", 3);
  });

  it("gives three focus areas, each trainer on its own table", () => {
    const river = focusAreas([...bbRiver(HU100, 9), ...bbRiver(SIX, 6), ...bbRiver(NINE, 3)], 500);
    expect(river.map((area) => area.id)).toEqual([
      "river~caller-oop-vs-bet~vs-bet~BB~-~hu",
      "river~caller-oop-vs-bet~vs-bet~BB~-",
      "river~caller-oop-vs-bet~vs-bet~BB~-~9max",
    ]);
    expect(river.map((area) => area.where.table)).toEqual(["hu", undefined, "9max"]);
    expect(river.map((area) => area.spotDecisions)).toEqual([42, 42, 42]);
    // The heads-up river deals the heads-up lines (once the heads-up sets ship); 6-max and full ring the 6-max lines.
    if (HU_SHIPPED) {
      expect(river[0].trainer).toEqual({ mode: "river", pot: "srp", side: "ip", role: "caller", set: HU100 });
      expect(trainerMatch(river[0].trainer!).spots!.every((s) => s.startsWith("hu-"))).toBe(true);
    }
    expect(river[1].trainer).toEqual({ mode: "river", pot: "srp", side: "ip", role: "caller" });
    expect(river[2].trainer).toEqual({ mode: "river", pot: "srp", side: "ip", role: "caller" });

    // The flop trainer waits for a flop library solved on the transcribed sets.
    if (!FLOP_LIVE || !HU_SHIPPED) return;
    const flop = focusAreas([...bbFlop(HU150, 9), ...bbFlop(SIX, 6), ...bbFlop(NINE150, 3)], 500);
    expect(flop.map((area) => area.where.table)).toEqual(["hu", undefined, "9max"]);
    expect(flop.map((area) => (area.trainer?.mode === "flop" ? area.trainer.set : null))).toEqual([HU150, SIX, NINE]);
    // Heads-up the big blind only ever defends the small blind's open; full ring it also defends the lojack's.
    expect(trainerMatch(flop[0].trainer!).spots!.every((s) => s.startsWith("sb-"))).toBe(true);
    expect(trainerMatch(flop[2].trainer!).spots).toContain("lj-bb:BB");
    expect(trainerMatch(flop[1].trainer!).spots).not.toContain("lj-bb:BB");

    // The week's tasks: a drill and a train task per area, every reference inside the database's checks.
    const drills = new Map(flop.flatMap((area) => area.keys.map((key) => [key, { items: 2, due: 1 }] as const)));
    const tasks = planTasks({ areas: flop, drills, hands: {}, previous: null });
    const train = tasks.filter((task) => task.kind === "train");
    expect(train.map((task) => task.ref.split("/")[1])).toEqual([HU150, SIX, NINE]);
    for (const task of train) expect(task.ref).toMatch(TRAIN_REF);
    const drill = tasks.filter((task) => task.kind === "drill");
    expect(drill.map((task) => task.ref)).toEqual(flop.map((area) => area.id));
    for (const task of drill) expect(rpcTask(task).ref).toMatch(DRILL_REF);
  });

  it("names the table in the words, English and Croatian", () => {
    const [hu, six, nine] = groupLeaks([...bbRiver(HU100, 9), ...bbRiver(SIX, 6), ...bbRiver(NINE, 3)], { hands: 500 });
    expect(leaksEn.context(hu.attrs)).toBe("As the preflop caller, out of position, facing a bet (BB, heads-up)");
    expect(leaksEn.context(nine.attrs)).toBe("As the preflop caller, out of position, facing a bet (BB, 9-max)");
    expect(leaksEn.context(six.attrs)).toBe("As the preflop caller, out of position, facing a bet (BB)");
    expect(leaksHr.context(hu.attrs)).toMatch(/\(BB, heads-up\)$/);
    expect(leaksHr.context(nine.attrs)).toMatch(/\(BB, 9-max\)$/);
    expect(leaksHr.context(six.attrs)).toMatch(/\(BB\)$/);
    // Merged past the seat, the table still shows.
    const street = { street: "river", scenario: "*", family: "*", hero: "*", villain: "*", table: "hu" };
    expect(leaksEn.context(street)).toBe("Any spot (heads-up)");
    expect(leaksHr.context(street)).toMatch(/\(heads-up\)$/);
    // Preflop as before.
    expect(leaksEn.context({ street: "preflop", scenario: "unopened", family: "first-in", hero: "UTG", villain: "-", table: "9max" })).toBe(
      "UTG first in (9-max)",
    );
  });
});

/* ------------------------------------------------------------ thin spots - */

describe("a thin postflop spot", () => {
  it("climbs on its own table and never into another table's area", () => {
    // Heads-up: two thin river spots (5 decisions each). 6-max: the same two spots, thin too.
    const rows = [
      row("river", "caller-oop-vs-bet", "BB", "fold", "call", 2, HU100, 2),
      row("river", "caller-oop-vs-bet", "BB", "call", "call", 3, HU100),
      row("river", "pfr-ip-vs-bet", "SB", "fold", "call", 2, HU100, 2),
      row("river", "pfr-ip-vs-bet", "SB", "call", "call", 3, HU100),
      row("river", "caller-oop-vs-bet", "BB", "fold", "call", 2, SIX, 1),
      row("river", "caller-oop-vs-bet", "BB", "call", "call", 3, SIX),
      row("river", "pfr-ip-vs-bet", "BTN", "fold", "call", 2, SIX, 1),
      row("river", "pfr-ip-vs-bet", "BTN", "call", "call", 3, SIX),
    ];
    const leaks = groupLeaks(rows, { hands: 100 });
    // Each table's two spots merge at the family (facing a bet: 10 decisions), each on its own table.
    expect(leaks.map((leak) => leak.id)).toEqual([
      "river~*~vs-bet~*~*~fold~call~hu",
      "river~*~vs-bet~*~*~fold~call",
    ]);
    expect(leaks.map((leak) => leak.level)).toEqual([3, 3]);
    expect(leaks.map((leak) => leak.spotDecisions)).toEqual([10, 10]);
    expect(Object.keys(leaks[0].sets)).toEqual([HU100]);
    expect(Object.keys(leaks[1].sets)).toEqual([SIX]);
    // The hands behind them: each its own table.
    expect(handsTable(leaks[0].attrs, leaks[0].level)).toBe("hu");
    expect(handsTable(leaks[1].attrs, leaks[1].level)).toBe("other");

    // Thinner still, they reach the street - heads-up still apart.
    const thinner = groupLeaks(
      rows.map((r) => (r.taken === r.best ? { ...r, decisions: 1, hands: 1 } : r)),
      { hands: 100 },
    );
    expect(thinner.map((leak) => leak.id)).toEqual(["river~*~*~*~*~fold~call~hu", "river~*~*~*~*~fold~call"]);
    expect(thinner.map((leak) => leak.level)).toEqual([4, 4]);
    const areas = focusAreas(rows.map((r) => (r.taken === r.best ? { ...r, decisions: 1, hands: 1 } : r)), 100);
    if (HU_SHIPPED) expect(areas[0].trainer).toEqual({ mode: "river", pot: "srp", side: "any", role: "any", set: HU100 });
    expect(areas[1].trainer).toEqual({ mode: "river", pot: "srp", side: "any", role: "any" });
  });

  it("keeps the preflop rule: the tag goes with the seat", () => {
    const rows = [
      row("preflop", "unopened", "SB", "fold", "raise", 2, HU100, 2),
      row("preflop", "unopened", "SB", "raise", "raise", 3, HU100),
      row("preflop", "unopened", "CO", "fold", "raise", 2, SIX, 1),
      row("preflop", "unopened", "CO", "raise", "raise", 3, SIX),
    ];
    const leaks = groupLeaks(rows, { hands: 100 });
    expect(leaks.map((leak) => leak.id)).toEqual(["preflop~unopened~first-in~*~*~fold~raise"]);
    expect(handsTable(leaks[0].attrs, leaks[0].level)).toBeNull();
    // At the seat, the table filter names it.
    expect(handsTable({ street: "preflop", table: "hu" }, 0)).toBe("hu");
    expect(handsTable({ street: "preflop" }, 1)).toBe("other");
    expect(handsTable({ street: "preflop" }, 2)).toBeNull();
    expect(handsTable({ street: "river" }, 4)).toBe("other");
    expect(handsTable({ street: "river", table: "9max" }, 4)).toBe("9max");
  });
});

/* ------------------------------------------------------------- counting - */

describe("an area's numbers on its own table", () => {
  it("counts its key's rows only in its own situations", () => {
    const rows = [...bbRiver(HU100, 9), ...bbRiver(SIX, 6)];
    const [hu, six] = focusAreas(rows, 500);
    const period = { rows, hands: 500 };
    expect(areaPeriod(hu, rows, 500)).toMatchObject({ spot: 42, mistakes: 12, evLossBb: 9 });
    expect(areaPeriod(six, rows, 500)).toMatchObject({ spot: 42, mistakes: 12, evLossBb: 6 });
    expect(areaChange(hu, period, period).current.mistakes).toBe(12);
    const [huLeak] = groupLeaks(rows, { hands: 500 });
    expect(leakPeriod(huLeak, rows)).toMatchObject({ spot: 42, mistakes: 12, evLossBb: 9 });
  });
});

/* -------------------------------------------------------------- old data - */

describe("data from before the split", () => {
  it("parses untagged and tagged postflop ids", () => {
    const old = "river~caller-oop-vs-bet~vs-bet~BB~-~fold~call";
    expect(parseLeakId(old)).toMatchObject({ street: "river", hero: "BB" });
    expect(parseLeakId(old)!.table).toBeUndefined();
    expect(leakId(parseLeakId(old)!)).toBe(old);
    expect(parseLeakId(`${old}~hu`)!.table).toBe("hu");
    expect(parseLeakId(`${old}~9max`)!.table).toBe("9max");
    expect(parseLeakId(`${old}~6max`)).toBeNull();
  });

  it("keeps rows with no set untagged, together with 6-max", () => {
    const leaks = groupLeaks([...bbRiver(null, 2), ...bbRiver(SIX, 3)], { hands: 100 });
    expect(leaks.map((leak) => leak.id)).toEqual(["river~caller-oop-vs-bet~vs-bet~BB~-~fold~call"]);
    expect(leaks[0].decisions).toBe(24);
  });

  it("reads a snapshot stored before as it was then", () => {
    // Last week's plan, stored before: one untagged area over every table's rows.
    const stored = JSON.parse(
      JSON.stringify([
        {
          id: "river~caller-oop-vs-bet~vs-bet~BB~-",
          where: { street: "river", scenario: "caller-oop-vs-bet", family: "vs-bet", hero: "BB", villain: "-" },
          level: 0,
          partial: false,
          leaks: [{ id: "river~caller-oop-vs-bet~vs-bet~BB~-~fold~call", taken: "fold", best: "call", evLossBb: 15, mistakes: 24 }],
          keys: ["river|caller-oop-vs-bet||BB|fold|call"],
          situations: ["river~caller-oop-vs-bet~vs-bet~BB~-"],
          evLossBb: 15,
          per100: 3,
          spotDecisions: 84,
          mistakes: 24,
          confidence: "high",
          tentative: false,
          concepts: ["mdf-alpha"],
          trainer: { mode: "river", pot: "any", side: "ip", role: "caller" },
          weeks: 2,
          reviews: [],
        },
      ]),
    );
    const [area] = parseFocus(stored);
    expect(area.id).toBe("river~caller-oop-vs-bet~vs-bet~BB~-");
    expect(area.postflopTables).toBe(false);
    expect(area.trainer).toEqual({ mode: "river", pot: "any", side: "ip", role: "caller" });
    // Its retrospective counts every table's rows, as it did when it was written.
    const rows = [...bbRiver(HU100, 9), ...bbRiver(SIX, 6)];
    expect(areaPeriod(area, rows, 500)).toMatchObject({ spot: 84, mistakes: 24, evLossBb: 15 });

    // This week: the heads-up area is the tagged one, and its weeks carry on from the untagged one.
    const focus = planFocus({ rows, hands: 500, graded: 500, previous: { focus: [area], tasks: [] } });
    expect(focus.areas.map((a) => [a.id, a.weeks])).toEqual([
      ["river~caller-oop-vs-bet~vs-bet~BB~-~hu", 3],
      ["river~caller-oop-vs-bet~vs-bet~BB~-", 3],
    ]);
    expect(legacyAreaId(focus.areas[0].where)).toBe(area.id);

    // A snapshot stored after the split: no carry-over from the 6-max area to the heads-up one.
    const fresh = parseFocus(JSON.parse(JSON.stringify([focus.areas[1]])));
    expect(fresh[0].postflopTables).toBe(true);
    const next = planFocus({ rows, hands: 500, graded: 500, previous: { focus: fresh, tasks: [] } });
    expect(next.areas.map((a) => [a.id, a.weeks])).toEqual([
      ["river~caller-oop-vs-bet~vs-bet~BB~-~hu", 1],
      ["river~caller-oop-vs-bet~vs-bet~BB~-", 4],
    ]);
    // And its numbers are its own table's.
    expect(areaPeriod(fresh[0], rows, 500)).toMatchObject({ spot: 42, mistakes: 12, evLossBb: 6 });
  });

  // Flop areas' trainers wait for a flop library on the transcribed sets.
  it.runIf(FLOP_LIVE && HU_SHIPPED)("round-trips a tagged area's snapshot and trainer", () => {
    const areas = focusAreas([...bbFlop(HU100, 9), ...bbFlop(NINE, 6)], 500);
    const back = parseFocus(JSON.parse(JSON.stringify(areas)));
    expect(back.map((a) => a.id)).toEqual(areas.map((a) => a.id));
    expect(back.map((a) => a.where)).toEqual(areas.map((a) => a.where));
    expect(back.map((a) => a.trainer)).toEqual(areas.map((a) => a.trainer));
    for (const a of back) expect(trainerRef(a.trainer!)).toMatch(TRAIN_REF);
    // A tagged snapshot whose trainer was dropped still deals on its table.
    const where = back[1].where;
    expect(trainerTarget(where, null)).toMatchObject({ mode: "flop", set: NINE });
    expect(trainerTarget(back[0].where, null)).toMatchObject({ mode: "flop", set: HU100 });
  });
});

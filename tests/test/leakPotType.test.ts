/**
 * A postflop leak area per pot type (`docs/ANALYSIS-PLAN.md` §10, 2026-11-05;
 * `20271105090000_leak_pot_type.sql`): the leak list returns a flop, turn or
 * river row per spot, set and pot (`pot`: `3bp`, `4bp` for a 3-bet or 4-bet+
 * pot), and the leak finder tags such a spot `~3bp` / `~4bp` after its table
 * tag; single-raised, limped and unknown pots stay untagged.
 *
 * - **Split**: single-raised, 3-bet and 4-bet+ rows with the same seat, role,
 *   side and table are three leaks and three areas; preflop never carries one.
 * - **Thin spots**: the pot tag is kept at every level, like the postflop table.
 * - **Counting**: an area's numbers come only from its own pot's rows.
 * - **Readers**: the hands, examples and drills on the area's pot
 *   (`handsPot`, `leakPot`, `drill_queue_on_area`, `drill_due_by_spot_pots`),
 *   each falling back on an older database.
 * - **Study plan**: the flop and river targets deal the area's pot's lines
 *   only, or none; the words name the pot.
 * - **Old data**: old ids parse, a snapshot stored before keeps its numbers
 *   (every pot in its situations) and passes its weeks on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  drillsOn,
  groupLeaks,
  handsPot,
  handsTable,
  leakId,
  parseLeakId,
  spotAttrs,
  type SpotDrills,
  type SpotRow,
} from "../../web/src/lib/analysis/leaks.js";
import {
  areaPeriod,
  areaPot,
  focusAreas,
  parseFocus,
  parseTrainerRef,
  planFocus,
  planTasks,
  potlessAreaId,
  trainerMatch,
  trainerRef,
  trainerTarget,
  type FocusArea,
} from "../../web/src/lib/training/plan.js";
import { leaksEn } from "../../web/src/lib/i18n/ns/analysisLeaks.en.js";
import { leaksHr } from "../../web/src/lib/i18n/ns/analysisLeaks.hr.js";

const rpc = vi.fn();
vi.mock("../../web/src/lib/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rpc: (...args: unknown[]) => rpc(...args),
  currentUserId: () => Promise.resolve("00000000-0000-0000-0000-0000000000a1"),
}));

const { DatabaseRpcError } = await import("../../web/src/lib/db/client.js");
const { drillsBySpotFromPayload, fetchDrillQueue } = await import("../../web/src/lib/db/training.js");
const { fetchLeakHands, fetchLeaks } = await import("../../web/src/lib/db/analysisLeaks.js");
const { fetchLeakExamples } = await import("../../web/src/lib/db/topLeaks.js");
const { drillQuery, dueDrillQuery, parseTrainState, trainQuery } = await import("../../web/src/components/analysis/train/trainState.js");

const SIX = "nlhe-cash-6max-100bb";
const HU100 = "nlhe-cash-hu-100bb";
const KEY = "flop|pfr-oop-vs-bet||BB|fold|call";
/** Since charts/11 the flop trainer waits for a library on the transcribed sets, the heads-up river for the heads-up sets. */
const { FLOP_LIBRARY_SETS } = await import("../../web/src/lib/analysis/flopLibrary.js");
const { CHART_SETS } = await import("../../web/src/lib/charts/index.js");
const FLOP_LIVE = FLOP_LIBRARY_SETS.length > 0;
const HU_SHIPPED = CHART_SETS.some((spec) => spec.id === HU100);

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
  pot: string | null,
  evLossBb = 0,
): SpotRow {
  const mistakes = taken === best ? 0 : decisions;
  return {
    key: [street, scenario, "", position, taken, best].join("|"),
    set,
    ...(pot ? { pot } : {}),
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

/** The big blind as the preflop raiser out of position, folding to a bet it should call: 12 folds, 30 calls. */
const bb = (street: string, set: string | null, pot: string | null, ev = 6) => [
  row(street, "pfr-oop-vs-bet", "BB", "fold", "call", 12, set, pot, ev),
  row(street, "pfr-oop-vs-bet", "BB", "call", "call", 30, set, pot),
];

beforeEach(() => {
  rpc.mockReset();
});

/* ------------------------------------------------------------ the split - */

describe("a postflop leak per pot", () => {
  it("tags a postflop row by its pot, never a preflop one, and leaves the rest untagged", () => {
    const tag = (street: string, pot: string | null) => spotAttrs(row(street, "pfr-oop-vs-bet", "BB", "fold", "call", 1, SIX, pot)).pot;
    for (const street of ["flop", "turn", "river"]) {
      expect(tag(street, "3bp")).toBe("3bp");
      expect(tag(street, "4bp")).toBe("4bp");
      expect(tag(street, null)).toBeUndefined();
      expect(tag(street, "other")).toBeUndefined();
      expect(tag(street, "srp")).toBeUndefined();
    }
    expect(spotAttrs(row("preflop", "vs-3bet", "BB", "fold", "call", 1, SIX, "3bp")).pot).toBeUndefined();
  });

  it("splits single-raised, 3-bet and 4-bet+ rows with the same seat, role, side and table", () => {
    const rows = [...bb("flop", SIX, null, 9), ...bb("flop", SIX, "3bp", 6), ...bb("flop", SIX, "4bp", 3), ...bb("flop", HU100, "3bp", 2)];
    const leaks = groupLeaks(rows, { hands: 500 });
    expect(leaks.map((leak) => leak.id)).toEqual([
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~fold~call",
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~fold~call~3bp",
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~fold~call~4bp",
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~fold~call~hu~3bp",
    ]);
    for (const leak of leaks) {
      expect([leak.level, leak.decisions, leak.spotDecisions]).toEqual([0, 12, 42]);
      expect(leak.keys).toEqual([KEY]);
      expect(leak.id).toMatch(DRILL_REF);
      expect(parseLeakId(leak.id)).toEqual(leak.attrs);
    }
    expect(leaks.map((leak) => handsPot(leak.attrs))).toEqual(["other", "3bp", "4bp", "3bp"]);
    expect(leaks.map((leak) => handsTable(leak.attrs, leak.level))).toEqual(["other", "other", "other", "hu"]);

    const areas = focusAreas(rows, 500);
    expect(areas.map((area) => area.id)).toEqual([
      "flop~pfr-oop-vs-bet~vs-bet~BB~-",
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~3bp",
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~4bp",
      "flop~pfr-oop-vs-bet~vs-bet~BB~-~hu~3bp",
    ]);
    expect(areas.map((area) => area.spotDecisions)).toEqual([42, 42, 42, 42]);
    expect(areas.every((area) => area.postflopPots === true && area.id.length <= 120)).toBe(true);
    expect(areas.map((area) => areaPot(area))).toEqual(["other", "3bp", "4bp", "3bp"]);
  });

  it("names the pot in both languages, with the table", () => {
    const where = { street: "flop", scenario: "pfr-oop-vs-bet", family: "vs-bet", hero: "BB", villain: "-" };
    expect(leaksEn.context({ ...where, pot: "3bp" })).toMatch(/\(BB, 3-bet pot\)$/);
    expect(leaksEn.context({ ...where, table: "hu", pot: "4bp" })).toMatch(/\(BB, heads-up, 4-bet\+ pot\)$/);
    expect(leaksHr.context({ ...where, table: "hu", pot: "3bp" })).toMatch(/\(BB, heads-up, 3-bet pot\)$/);
    expect(leaksEn.context(where)).not.toContain("pot)");
    // Merged past the seat: the tags in their own bracket.
    expect(leaksEn.context({ ...where, scenario: "*", hero: "*", pot: "3bp" })).toBe("Facing a bet (3-bet pot)");
    expect(leaksHr.context({ ...where, scenario: "*", hero: "*", pot: "3bp" })).toMatch(/\(3-bet pot\)$/);
  });
});

/* ------------------------------------------------------------ thin spots - */

describe("a thin spot in a 3-bet pot", () => {
  it("climbs on its own pot and never into the single-raised area", () => {
    const rows = [
      row("river", "pfr-oop-vs-bet", "BB", "fold", "call", 3, SIX, "3bp", 4),
      row("river", "caller-ip-vs-bet", "BTN", "fold", "call", 3, SIX, "3bp", 3),
      ...bb("river", SIX, null, 9),
      row("river", "caller-ip-vs-bet", "BTN", "fold", "call", 3, SIX, null, 1),
    ];
    const leaks = groupLeaks(rows, { hands: 100 });
    // The single-raised big blind stands on its own; the two thin 3-bet pot spots climb to the street together,
    // tagged, beside (never into) the thin single-raised button spot's own street-level leak.
    expect(leaks.map((leak) => [leak.id, leak.level, leak.decisions])).toEqual([
      ["river~pfr-oop-vs-bet~vs-bet~BB~-~fold~call", 0, 12],
      ["river~*~*~*~*~fold~call~3bp", 4, 6],
      ["river~*~*~*~*~fold~call", 4, 3],
    ]);
    expect(leaksEn.context(leaks[1].attrs)).toBe("Any spot (3-bet pot)");
  });
});

/* ------------------------------------------------------------- counting - */

describe("an area's numbers", () => {
  it("come from its own pot's rows only", () => {
    const rows = [...bb("river", SIX, null, 9), ...bb("river", SIX, "3bp", 6)];
    const [single, three] = focusAreas(rows, 500);
    expect(three.where.pot).toBe("3bp");
    expect(areaPeriod(single, rows, 500)).toMatchObject({ spot: 42, mistakes: 12, evLossBb: 9 });
    expect(areaPeriod(three, rows, 500)).toMatchObject({ spot: 42, mistakes: 12, evLossBb: 6 });
  });
});

/* -------------------------------------------------------------- old ids - */

describe("ids", () => {
  it("parse old ids, a table, a pot, and a table then a pot; refuse anything else", () => {
    const base = "river~pfr-oop-vs-bet~vs-bet~BB~-~fold~call";
    expect(parseLeakId(base)).toMatchObject({ street: "river", best: "call" });
    expect(parseLeakId(base)).not.toHaveProperty("pot");
    expect(parseLeakId(`${base}~hu`)).toMatchObject({ table: "hu" });
    expect(parseLeakId(`${base}~3bp`)).toMatchObject({ pot: "3bp" });
    expect(parseLeakId(`${base}~3bp`)).not.toHaveProperty("table");
    expect(parseLeakId(`${base}~9max~4bp`)).toMatchObject({ table: "9max", pot: "4bp" });
    for (const junk of [`${base}~3bp~hu`, `${base}~3bp~4bp`, `${base}~hu~9max`, `${base}~srp`, `${base}~hu~3bp~x`]) {
      expect(parseLeakId(junk)).toBeNull();
    }
    expect(parseLeakId("preflop~vs-3bet~vs-reraise~BB~BTN~fold~call~3bp")).toBeNull();
    expect(leakId(parseLeakId(`${base}~hu~3bp`)!)).toBe(`${base}~hu~3bp`);
  });
});

/* ------------------------------------------------------------ the plan - */

describe("the study plan on a pot", () => {
  it.runIf(FLOP_LIVE && HU_SHIPPED)("deals a 3-bet pot area the table's 3-bet pot lines, a 4-bet+ one its 4-bet line or nothing", () => {
    const where = { street: "flop", scenario: "pfr-oop-vs-bet", family: "vs-bet", hero: "BB", villain: "-" };
    const three = trainerTarget({ ...where, pot: "3bp" }, SIX);
    expect(three).toEqual({ mode: "flop", set: SIX, pot: "3bp", side: "oop", role: "pfr", seat: "BB", facing: "bet", line: null });
    expect(trainerMatch(three!)).toEqual({ mode: "flop", family: "3bp", position: "BB", spots: ["btn-bb-3bet:BB", "co-bb-3bet:BB"] });
    expect(trainerTarget({ ...where, pot: "3bp", table: "hu" }, HU100)).toMatchObject({ set: HU100, pot: "3bp", line: "sb-bb-3bet" });
    // No 6-max 4-bet pot line: no trainer, never a 3-bet pot's lines.
    expect(trainerTarget({ ...where, pot: "4bp" }, SIX)).toBeNull();
    const four = trainerTarget({ ...where, scenario: "caller-oop-vs-bet", pot: "4bp", table: "hu" }, HU100);
    expect(four).toMatchObject({ mode: "flop", set: HU100, pot: "3bp", line: "sb-bb-4bet", seat: "BB" });
    expect(trainerMatch(four!).spots).toEqual(["sb-bb-4bet:BB"]);
    // Single-raised, the big blind never raised preflop out of position on a library line.
    expect(trainerTarget(where, SIX)).toBeNull();
    for (const target of [three!, four!]) {
      expect(trainerRef(target)).toMatch(TRAIN_REF);
      expect(parseTrainerRef(trainerRef(target))).toEqual(target);
    }
  });

  it("deals the river's 3-bet pots, a single-raised area its single-raised ones, and none for 4-bet+", () => {
    const where = { street: "river", scenario: "pfr-oop-vs-bet", family: "vs-bet", hero: "BB", villain: "-" };
    expect(trainerTarget({ ...where, pot: "3bp" })).toEqual({ mode: "river", pot: "3bp", side: "ip", role: "pfr" });
    expect(trainerTarget(where)).toEqual({ mode: "river", pot: "srp", side: "ip", role: "pfr" });
    expect(trainerTarget({ ...where, pot: "4bp" })).toBeNull();
    if (HU_SHIPPED) expect(trainerTarget({ ...where, pot: "3bp" }, HU100)).toEqual({ mode: "river", pot: "3bp", side: "ip", role: "pfr", set: HU100 });
    expect(trainerRef(trainerTarget({ ...where, pot: "3bp" })!)).toBe("river/3bp/ip/pfr");
  });

  it("gives each pot's area its own drills and hands filter", () => {
    const rows = [...bb("flop", SIX, null, 9), ...bb("flop", SIX, "3bp", 6)];
    const areas = focusAreas(rows, 500);
    const drills: Map<string, SpotDrills> = new Map([
      [KEY, { items: 5, due: 5, tables: { other: { items: 5, due: 5 } }, pots: { other: { other: { items: 2, due: 2 }, "3bp": { items: 3, due: 3 } } } }],
    ]);
    const tasks = planTasks({ areas, drills, hands: {}, previous: null }).filter((task) => task.kind === "drill");
    expect(tasks.map((task) => [task.ref, task.target])).toEqual([
      [areas[0].id, 2],
      [areas[1].id, 3],
    ]);
    // An older database's rows (no pots) count on the table, as before.
    const old: Map<string, SpotDrills> = new Map([[KEY, { items: 5, due: 5, tables: { other: { items: 5, due: 5 } } }]]);
    expect(drillsOn(old, [KEY], "other", "3bp")).toEqual({ items: 5, due: 5 });
    expect(drillsOn(drills, [KEY], null, "3bp")).toEqual({ items: 3, due: 3 });
    expect(drillsOn(drills, [KEY], "hu", "3bp")).toEqual({ items: 0, due: 0 });
    expect(drillsOn(drills, [KEY], "other")).toEqual({ items: 5, due: 5 });
  });
});

/* ------------------------------------------------------------- old data - */

describe("a snapshot stored before postflop pots", () => {
  const rows = [...bb("river", SIX, null, 9), ...bb("river", SIX, "3bp", 6)];
  const stored: FocusArea = {
    ...focusAreas([...bb("river", SIX, null, 15)], 500)[0],
    postflopTables: true,
    postflopPots: undefined,
    weeks: 2,
  };

  it("keeps its numbers: every pot's rows in its situations", () => {
    const [area] = parseFocus(JSON.parse(JSON.stringify([stored])));
    expect(area.postflopPots).toBe(false);
    expect(areaPot(area)).toBeNull();
    expect(areaPeriod(area, rows, 500)).toMatchObject({ spot: 84, mistakes: 24, evLossBb: 15 });
  });

  it("passes its weeks on to the area it split into, and a new snapshot round-trips", () => {
    const focus = planFocus({ rows, hands: 500, graded: 500, previous: { focus: [stored], tasks: [] } });
    const three = focus.areas.find((area) => area.where.pot === "3bp")!;
    expect(potlessAreaId(three.where)).toBe(stored.id);
    expect(three.weeks).toBe(3);
    expect(focus.areas.find((area) => !area.where.pot)!.weeks).toBe(3);
    // A snapshot written since: its own pot, no weeks handed across pots.
    const [back] = parseFocus(JSON.parse(JSON.stringify([three])));
    expect(back).toMatchObject({ id: three.id, where: { pot: "3bp" }, postflopPots: true });
    const next = planFocus({ rows, hands: 500, graded: 500, previous: { focus: [{ ...back, weeks: 5 }], tasks: [] } });
    expect(next.areas.find((area) => !area.where.pot)!.weeks).toBe(1);
    expect(next.areas.find((area) => area.where.pot === "3bp")!.weeks).toBe(6);
  });
});

/* ------------------------------------------------------- the web's source - */

describe("the web's source", () => {
  const missing = () => new DatabaseRpcError("x", "Could not find the function", "PGRST202");

  it("reads a row's pot from the leak list, and none where it sends none", async () => {
    rpc.mockResolvedValueOnce({
      rows: [
        { key: KEY, set: SIX, pot: "3bp", street: "flop", decisions: 3 },
        { key: KEY, set: SIX, street: "flop", decisions: 4 },
      ],
    });
    const report = await fetchLeaks({});
    expect(report!.rows.map((r) => r.pot)).toEqual(["3bp", undefined]);
    expect(report!.rows[1]).not.toHaveProperty("pot");
  });

  it("asks the hands and the examples on a pot", async () => {
    rpc.mockResolvedValueOnce({ total: 0, rows: [] });
    await fetchLeakHands({}, { keys: [KEY], table: "other", pot: "3bp" });
    expect(rpc).toHaveBeenLastCalledWith("analysis_leak_hands", expect.objectContaining({
      p_filters: expect.objectContaining({ leakTable: "other", leakPot: "3bp" }),
    }));
    rpc.mockResolvedValueOnce({ total: 0, rows: [] });
    await fetchLeakHands({}, { keys: [KEY] });
    expect(rpc.mock.lastCall![1].p_filters).not.toHaveProperty("leakPot");

    rpc.mockResolvedValueOnce({ leaks: [] });
    await fetchLeakExamples({}, { leaks: [{ id: "a", keys: [KEY], table: "hu", pot: "4bp" }, { id: "b", keys: [KEY], pot: null }], window: null, limit: 15 });
    expect(rpc).toHaveBeenLastCalledWith("analysis_leak_examples", expect.objectContaining({
      p_leaks: [{ id: "a", keys: [KEY], table: "hu", pot: "4bp" }, { id: "b", keys: [KEY] }],
    }));
  });

  it("deals an area's drills from drill_queue_on_area, falling back to the table's reader", async () => {
    rpc.mockResolvedValueOnce([{ id: "d1", handId: "h1", spotKey: KEY, table: "other", pot: "3bp", due: true }]);
    await fetchDrillQueue({ keys: [KEY], table: "other", pot: "3bp" });
    expect(rpc).toHaveBeenLastCalledWith("drill_queue_on_area", expect.objectContaining({ p_table: "other", p_pot: "3bp", p_keys: [KEY] }));

    rpc.mockReset();
    rpc.mockRejectedValueOnce(missing()).mockResolvedValueOnce([{ id: "d2" }]);
    expect((await fetchDrillQueue({ keys: [KEY], table: "hu", pot: "3bp" })).map((d) => d.id)).toEqual(["d2"]);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(["drill_queue_on_area", "drill_queue_on_table"]);

    rpc.mockReset();
    rpc.mockResolvedValueOnce([]);
    await fetchDrillQueue({ keys: [KEY], pot: "3bp" });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(["drill_queue"]);

    rpc.mockReset();
    rpc.mockRejectedValueOnce(new DatabaseRpcError("x", "Unknown leak pot", "22023"));
    await expect(fetchDrillQueue({ keys: [KEY], table: "hu", pot: "3bp" })).rejects.toThrow("Unknown leak pot");
  });

  it("reads drill_due_by_spot_pots' rows", () => {
    const map = drillsBySpotFromPayload([
      { key: KEY, items: 5, due: 4, tables: { other: { items: 5, due: 4 } }, pots: { other: { "3bp": { items: 3, due: "2" }, srp: { items: 9, due: 9 } }, x: {} } },
    ]);
    expect(map.get(KEY)?.pots).toEqual({ other: { "3bp": { items: 3, due: 2 } } });
  });

  it("carries the pot in a drills address with the table, and drops it without one", () => {
    const due = dueDrillQuery([KEY], "other", "3bp");
    expect(new URLSearchParams(due).get("drillPot")).toBe("3bp");
    const state = parseTrainState(Object.fromEntries(new URLSearchParams(due)));
    expect(state).toMatchObject({ mode: "drills", spots: [KEY], table: "other", drillPot: "3bp" });
    expect(trainQuery(state)).toBe(due);
    expect(drillQuery([KEY], null, "3bp")).not.toContain("drillPot");
    expect(parseTrainState({ spots: KEY, drillPot: "3bp" }).drillPot).toBeNull();
    expect(parseTrainState({ spots: KEY, table: "hu", drillPot: "srp" }).drillPot).toBeNull();
    // The river and flop trainers' own pot filter is another key.
    expect(parseTrainState({ spots: KEY, table: "hu", drillPot: "4bp" })).toMatchObject({ drillPot: "4bp", pot: "any" });
  });
});

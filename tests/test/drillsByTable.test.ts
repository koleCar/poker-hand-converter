/**
 * Drills and top-leak examples on a leak area's table (`docs/ANALYSIS-PLAN.md`
 * §10, 2026-11-04; `20271104120000_drills_by_table.sql`). A spot key names no
 * table, so a heads-up area's keys also hold the 6-max blinds' drills and
 * examples; the readers now take the area's table (`handsTable`).
 *
 * - **Counting** (`drillsOn`): an area's drills are its keys' on its table;
 *   no table (a level above the table) every table's; an older database's
 *   rows with no split count whole, as before.
 * - **The plan**: a heads-up, a 6-max and a 9-max area on the same keys each
 *   get a drill task for their own table's due drills only.
 * - **Addresses** (`trainState`): a drill task's and "Drill this"'s address
 *   carries the table with the keys, and reads it back; a table without keys,
 *   or an unknown one, is dropped.
 * - **The web's source** (`lib/db`): the queue on a table calls
 *   `drill_queue_on_table`, the counts `drill_due_by_spot_tables`, each
 *   falling back to the old reader on a database without them; the
 *   examples send a leak's table only when it has one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { drillsOn, groupLeaks, handsTable, type SpotDrills, type SpotRow } from "../../web/src/lib/analysis/leaks.js";
import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { focusAreas, planTasks } from "../../web/src/lib/training/plan.js";

const rpc = vi.fn();
vi.mock("../../web/src/lib/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rpc: (...args: unknown[]) => rpc(...args),
  currentUserId: () => Promise.resolve("00000000-0000-0000-0000-0000000000a1"),
}));

const { DatabaseRpcError } = await import("../../web/src/lib/db/client.js");
const { drillsBySpotFromPayload, fetchDrillQueue, fetchDrillsBySpot } = await import("../../web/src/lib/db/training.js");
const { fetchLeakExamples } = await import("../../web/src/lib/db/topLeaks.js");
const { DEFAULT_TRAIN_STATE, drillQuery, dueDrillQuery, parseTrainState, trainQuery } = await import(
  "../../web/src/components/analysis/train/trainState.js"
);

const SIX = DEFAULT_CHART_SET;
const NINE = "nlhe-cash-9max-100bb";
const HU100 = "nlhe-cash-hu-100bb";
const KEY = "flop|caller-oop-vs-bet||BB|fold|call";
const OK_KEY = "flop|caller-oop-vs-bet||BB|call|call";

function row(taken: string, decisions: number, set: string, evLossBb = 0): SpotRow {
  const mistakes = taken === "call" ? 0 : decisions;
  return {
    key: ["flop", "caller-oop-vs-bet", "", "BB", taken, "call"].join("|"),
    set,
    street: "flop",
    scenario: "caller-oop-vs-bet",
    line: "",
    position: "BB",
    taken,
    best: "call",
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
/** The big blind folding a flop it should call, on one table: 12 folds, 30 calls. */
const bbFlop = (set: string, ev: number) => [row("fold", 12, set, ev), row("call", 30, set)];

/** One key's drills: 6 in all (4 heads-up, 2 on 6-max), 3 due (2 heads-up, 1 6-max); the 9-max area has none. */
const SPLIT: Map<string, SpotDrills> = new Map([
  [KEY, { items: 6, due: 3, tables: { hu: { items: 4, due: 2 }, other: { items: 2, due: 1 } } }],
]);

beforeEach(() => {
  rpc.mockReset();
});

/* ------------------------------------------------------------- counting - */

describe("an area's drills on its table", () => {
  it("sums its keys on the table, every table without one, and an old row whole", () => {
    expect(drillsOn(SPLIT, [KEY, OK_KEY], "hu")).toEqual({ items: 4, due: 2 });
    expect(drillsOn(SPLIT, [KEY], "other")).toEqual({ items: 2, due: 1 });
    expect(drillsOn(SPLIT, [KEY], "9max")).toEqual({ items: 0, due: 0 });
    expect(drillsOn(SPLIT, [KEY], null)).toEqual({ items: 6, due: 3 });
    // An older database sent no split: the key counts whole, as before.
    const old = new Map([[KEY, { items: 6, due: 3 }]]);
    expect(drillsOn(old, [KEY], "hu")).toEqual({ items: 6, due: 3 });
    expect(drillsOn(new Map(), [KEY], "hu")).toEqual({ items: 0, due: 0 });
  });

  it("reads drill_due_by_spot_tables' rows, and an old reader's without a split", () => {
    const map = drillsBySpotFromPayload([
      { key: KEY, items: "6", due: 3, tables: { hu: { items: 4, due: 2 }, other: { items: 2, due: "1" }, "6max": { items: 9, due: 9 } } },
      { key: OK_KEY, items: 1, due: 0 },
    ]);
    expect(map.get(KEY)).toEqual(SPLIT.get(KEY));
    expect(map.get(OK_KEY)).toEqual({ items: 1, due: 0 });
    expect(map.get(OK_KEY)?.tables).toBeUndefined();
    expect(drillsBySpotFromPayload(null).size).toBe(0);
  });
});

/* ------------------------------------------------------------- the plan - */

describe("the plan's drill tasks", () => {
  const areas = focusAreas([...bbFlop(HU100, 9), ...bbFlop(SIX, 6), ...bbFlop(NINE, 3)], 500);
  const drillTasks = (drills: ReadonlyMap<string, SpotDrills>) =>
    planTasks({ areas, drills, hands: {}, previous: null }).filter((task) => task.kind === "drill");

  it("splits one key into three areas, each reading its own table", () => {
    expect(areas.map((area) => area.where.table)).toEqual(["hu", undefined, "9max"]);
    expect(new Set(areas.map((area) => area.keys.join()))).toHaveProperty("size", 1);
    expect(areas.map((area) => handsTable(area.where, area.level))).toEqual(["hu", "other", "9max"]);
  });

  it("asks each area for its own table's due drills only", () => {
    const tasks = drillTasks(SPLIT);
    expect(tasks.map((task) => [task.ref, task.target])).toEqual([
      [areas[0].id, 2],
      [areas[1].id, 1],
    ]);
    expect(tasks.every((task) => task.spotKeys?.includes(KEY))).toBe(true);
  });

  it("counts every table's on a database with no split, as before", () => {
    const tasks = drillTasks(new Map([[KEY, { items: 6, due: 3 }]]));
    expect(tasks.map((task) => task.target)).toEqual([3, 3, 3]);
  });
});

/* ------------------------------------------------------------ addresses - */

describe("the drills' address", () => {
  it("carries the table with the keys and reads it back", () => {
    const due = dueDrillQuery([KEY], "hu");
    expect(new URLSearchParams(due).get("table")).toBe("hu");
    const state = parseTrainState(Object.fromEntries(new URLSearchParams(due)));
    expect(state).toMatchObject({ mode: "drills", spots: [KEY], table: "hu", all: false });
    expect(trainQuery(state)).toBe(due);

    const leak = drillQuery([KEY], "other");
    expect(parseTrainState(Object.fromEntries(new URLSearchParams(leak)))).toMatchObject({ spots: [KEY], table: "other", all: true });
  });

  it("leaves the table out without keys, with none, or when unknown", () => {
    expect(dueDrillQuery(null, "hu")).toBe("mode=drills");
    expect(dueDrillQuery([KEY])).not.toContain("table=");
    expect(drillQuery([KEY])).not.toContain("table=");
    expect(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "drills", table: "hu" })).toBe("mode=drills");
    expect(parseTrainState({ mode: "drills", table: "hu" }).table).toBeNull();
    expect(parseTrainState({ spots: KEY, table: "6max" }).table).toBeNull();
    expect(parseTrainState({ spots: KEY, table: "9max" }).table).toBe("9max");
    expect(DEFAULT_TRAIN_STATE.table).toBeNull();
  });
});

/* ------------------------------------------------------- the web's source - */

describe("the web's source", () => {
  const missing = () => new DatabaseRpcError("x", "Could not find the function", "PGRST202");

  it("deals a table's drills from drill_queue_on_table, every table's from drill_queue", async () => {
    rpc.mockResolvedValueOnce([{ id: "d1", handId: "h1", spotKey: KEY, table: "hu", due: true }]);
    const queue = await fetchDrillQueue({ keys: [KEY], table: "hu", dueOnly: false, limit: 20 });
    expect(rpc).toHaveBeenLastCalledWith("drill_queue_on_table", expect.objectContaining({ p_table: "hu", p_keys: [KEY], p_due_only: false, p_limit: 20 }));
    expect(queue[0]).toMatchObject({ id: "d1", handId: "h1", due: true });

    rpc.mockResolvedValueOnce([]);
    await fetchDrillQueue({ keys: [KEY], table: null });
    expect(rpc).toHaveBeenLastCalledWith("drill_queue", expect.not.objectContaining({ p_table: expect.anything() }));
  });

  it("falls back to drill_queue on a database without the table reader, and rethrows anything else", async () => {
    rpc.mockRejectedValueOnce(missing()).mockResolvedValueOnce([{ id: "d2" }]);
    const queue = await fetchDrillQueue({ keys: [KEY], table: "9max" });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(["drill_queue_on_table", "drill_queue"]);
    expect(queue.map((item) => item.id)).toEqual(["d2"]);

    rpc.mockRejectedValueOnce(new DatabaseRpcError("x", "Unknown leak table", "22023"));
    await expect(fetchDrillQueue({ keys: [KEY], table: "hu" })).rejects.toThrow("Unknown leak table");
  });

  it("counts drills per spot from drill_due_by_spot_tables, or drill_due_by_spot on an older database", async () => {
    // Since 20271105090000 the per-pot reader first (`leakPotType.test.ts`); without it, the per-table one.
    rpc.mockRejectedValueOnce(missing()).mockResolvedValueOnce([{ key: KEY, items: 6, due: 3, tables: { hu: { items: 4, due: 2 } } }]);
    expect((await fetchDrillsBySpot()).get(KEY)?.tables).toEqual({ hu: { items: 4, due: 2 } });
    expect(rpc).toHaveBeenLastCalledWith("drill_due_by_spot_tables", expect.objectContaining({ p_version: expect.stringMatching(/^analysis\//) }));

    rpc.mockReset();
    rpc.mockRejectedValueOnce(missing()).mockRejectedValueOnce(missing()).mockResolvedValueOnce([{ key: KEY, items: 6, due: 3 }]);
    expect((await fetchDrillsBySpot()).get(KEY)).toEqual({ items: 6, due: 3 });
    expect(rpc).toHaveBeenLastCalledWith("drill_due_by_spot", expect.anything());
  });

  it("asks for each top leak's examples on its table, sending none for every table", async () => {
    const [hu, six] = groupLeaks([...bbFlop(HU100, 9), ...bbFlop(SIX, 6)], { hands: 500 });
    rpc.mockResolvedValueOnce({ leaks: [] });
    await fetchLeakExamples({}, {
      leaks: [hu, six].map((leak) => ({ id: leak.id, keys: leak.keys, table: handsTable(leak.attrs, leak.level) })).concat([{ id: "all", keys: [KEY], table: null }]),
      window: null,
      limit: 15,
    });
    expect(rpc).toHaveBeenCalledWith("analysis_leak_examples", expect.objectContaining({
      p_leaks: [
        { id: hu.id, keys: hu.keys, table: "hu" },
        { id: six.id, keys: six.keys, table: "other" },
        { id: "all", keys: [KEY] },
      ],
    }));
  });
});

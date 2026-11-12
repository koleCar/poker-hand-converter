/**
 * The desktop app's Tables screen (T5, docs/research/TABLE-TILING.md §4.5):
 * the displays scaled into the preview, stacked tables drawn as one box,
 * the rooms listed or folded, the RNG's band editing kept valid by the same
 * checks as `RngSettings::validate` (`hud/rail-hud-ipc/src/settings.rs`),
 * and the user's layouts. Pure TypeScript (`app/src/screens/tables/model.ts`),
 * so it runs here; the app has no test runner of its own.
 */
import { describe, expect, it } from "vitest";

import type {
  HudPolicy,
  HudStatus,
  MonitorInfo,
  RngSettings,
  RoomPolicy,
  TiledTable,
  TilingSettings,
  TilingSlot,
} from "../../app/src/lib/ipc.js";
import {
  MAX_BANDS,
  MAX_LABEL,
  addLayout,
  bandShare,
  bandSpans,
  chooseLayout,
  deleteLayout,
  displayCounts,
  newLayoutId,
  newLayoutName,
  previewLayout,
  previewTables,
  removeBand,
  renameLayout,
  rngAllowedAnywhere,
  actionSlotAllowedAnywhere,
  rngProblem,
  roomRows,
  setBandColour,
  setBandEnd,
  setBandLabel,
  setRoomOn,
  setTimer,
  splitBand,
} from "../../app/src/screens/tables/model.js";
import {
  RNG_OPACITY_MAX,
  RNG_OPACITY_MIN,
  RNG_SCALE_MAX,
  RNG_SCALE_MIN,
  rngOpacity,
  rngRoomOn,
  rngScale,
  setRngOpacity,
  setRngRoomOn,
  setRngScale,
  verdictOf,
} from "../../app/src/screens/tables/model.js";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** A 1920 x 1080 primary (40 px taskbar) and a 2560 x 1440 to its right, listed second first. */
const MONITORS: MonitorInfo[] = [
  { index: 1, primary: false, bounds: rect(1920, 0, 2560, 1440), workArea: rect(1920, 0, 2560, 1400), scalePermille: 1250 },
  { index: 0, primary: true, bounds: rect(0, 0, 1920, 1080), workArea: rect(0, 0, 1920, 1040), scalePermille: 1000 },
];

/** The shipped RNG defaults (`RngSettings::default`). */
function rng(): RngSettings {
  return {
    enabled: false,
    min: 1,
    max: 100,
    bands: [
      { upTo: 33, colour: "#5c6370" },
      { upTo: 66, colour: "#8b929e" },
      { upTo: 100, colour: "#c5cad3" },
    ],
    triggers: { newHand: true, click: true },
    perRoom: {},
  };
}

function tiling(): TilingSettings {
  return { enabled: true, active: { kind: "auto" }, layouts: [], autoSwitch: [], closeGaps: false, perRoom: {} };
}

function room(id: string, name: string, tiling: Partial<RoomPolicy["tiling"]>, extra: Partial<RoomPolicy> = {}): RoomPolicy {
  return {
    id,
    name,
    kind: "room",
    allowed: null,
    permitted: false,
    source: null,
    checkedAt: null,
    notes: "",
    restrictions: null,
    stricterThanShipped: false,
    closed: false,
    tiling: { allowed: null, permitted: false, needsApproval: false, ...tiling },
    rng: { allowed: null, permitted: false, needsApproval: false },
    actionSlot: { allowed: null, permitted: false, needsApproval: false },
    ...extra,
  };
}

const POLICY: HudPolicy = {
  rooms: [
    room("pokerstars", "PokerStars", { allowed: true, permitted: true }),
    room("ggpoker", "GGPoker", { allowed: false }),
    room("winamax", "Winamax", { allowed: false, needsApproval: true }),
    room("acr", "ACR", { allowed: true, permitted: true }),
    room("unibet", "Unibet Poker", { allowed: false }),
    room("ipoker", "iPoker network", {}, { kind: "network" }),
    room("fulltilt", "Full Tilt Poker", { allowed: false }, { closed: true }),
    room("standard", "Rail standard", { allowed: false }, { kind: "format" }),
  ],
  remote: false,
  url: null,
  fetchedAt: null,
  lastCheck: null,
  notes: [],
};

function status(windows: TiledTable[], tables: HudStatus["tables"] = []): HudStatus {
  return {
    phase: "running",
    error: null,
    tablesOpen: tables.length,
    tablesWaiting: 0,
    tables,
    refused: [],
    remotePolicy: false,
    permissionNeeded: null,
    permissionDeferred: null,
    tiling: { enabled: true, tables: windows.length, layout: "auto", monitors: MONITORS, windows },
  };
}

describe("the monitors preview", () => {
  it("draws every display at one scale, side by side in layout order, inside the space given", () => {
    const layout = previewLayout(MONITORS, 1000, 400, 20);
    expect(layout.displays.map((d) => d.monitor.index)).toEqual([0, 1]);
    // The row's width decides: (1000 - 20) / (1920 + 2560).
    const scale = 980 / 4480;
    expect(layout.scale).toBeCloseTo(scale);
    const [primary, second] = layout.displays;
    expect(primary.width).toBeCloseTo(1920 * scale);
    expect(second.width / primary.width).toBeCloseTo(2560 / 1920);
    expect(second.left).toBeCloseTo(primary.width + 20);
    expect(layout.width).toBeCloseTo(1000);
    expect(layout.height).toBeCloseTo(1440 * scale);
    // The taskbar is what the work area leaves.
    expect(primary.work.top).toBe(0);
    expect(primary.work.height).toBeCloseTo(1040 * scale);
    // A short space: the height decides.
    const short = previewLayout(MONITORS, 10_000, 144, 20);
    expect(short.scale).toBeCloseTo(0.1);
    expect(previewLayout([], 1000, 300, 20).displays).toEqual([]);
  });

  it("puts each table in its display, a stack in one box, and counts both", () => {
    const layout = previewLayout(MONITORS, 1000, 300, 20);
    const windows: TiledTable[] = [
      { site: "pokerstars", table: "A", rect: rect(0, 0, 960, 520), monitor: 0 },
      { site: "acr", table: "B", rect: rect(960, 0, 960, 520), monitor: 0, stacked: true },
      // The same slot, another room's aspect ratio: a little narrower.
      { site: "pokerstars", table: "C", rect: rect(990, 0, 900, 520), monitor: 0, stacked: true },
      { site: "acr", table: "D", rect: rect(1920, 0, 1280, 700), monitor: 1, pinned: true },
    ];
    const primary = previewTables(layout.displays[0], windows, layout.scale);
    expect(primary.map((b) => [b.table.table, b.count])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
    expect(primary[1].left).toBeCloseTo(960 * layout.scale);
    expect(displayCounts(primary)).toEqual({ shown: 2, stacked: 1 });
    const second = previewTables(layout.displays[1], windows, layout.scale);
    expect(second.map((b) => b.table.table)).toEqual(["D"]);
    expect(second[0].left).toBe(0);
    // Hanging off the display: clipped to it.
    const off = previewTables(layout.displays[0], [{ site: "acr", rect: rect(1800, 900, 400, 400), monitor: 0 }], layout.scale);
    expect(off[0].left + off[0].width).toBeCloseTo(layout.displays[0].width);
  });
});

describe("the rooms", () => {
  it("lists the rooms tiling may move, then others with a table open; folds the rest; leaves out formats and closed clients", () => {
    const { shown, folded } = roomRows(POLICY, tiling(), status([], [
      { site: "ggpoker", window: 1, table: "x", waiting: false },
      { site: "winamax", window: 2, table: "y", waiting: false },
    ]));
    expect(shown.map((r) => [r.id, r.verdict, r.tables])).toEqual([
      ["pokerstars", "allowed", 0],
      ["acr", "allowed", 0],
      ["winamax", "approval", 1],
      ["ggpoker", "notAllowed", 1],
    ]);
    expect(folded.map((r) => r.id)).toEqual(["unibet", "ipoker"]);
  });

  it("counts the tiled tables, and keeps the user's switch (on unless off)", () => {
    const windows: TiledTable[] = [
      { site: "pokerstars", rect: rect(0, 0, 10, 10), monitor: 0 },
      { site: "pokerstars", rect: rect(10, 0, 10, 10), monitor: 0 },
    ];
    const off = setRoomOn(tiling(), "acr", false);
    expect(off.perRoom).toEqual({ acr: false });
    expect(setRoomOn(off, "acr", true).perRoom).toEqual({});
    const { shown } = roomRows(POLICY, off, status(windows));
    expect(shown.find((r) => r.id === "pokerstars")).toMatchObject({ tables: 2, on: true });
    expect(shown.find((r) => r.id === "acr")).toMatchObject({ tables: 0, on: false });
    expect(roomRows(POLICY, tiling(), null).shown.map((r) => r.id)).toEqual(["pokerstars", "acr"]);
  });

  it("enables the RNG only where a room allows it", () => {
    expect(rngAllowedAnywhere(POLICY)).toBe(false);
    const one = { ...POLICY, rooms: [room("acr", "ACR", {}, { rng: { allowed: true, permitted: true, needsApproval: false } })] };
    expect(rngAllowedAnywhere(one)).toBe(true);
  });

  // (T7) The slot editor's "Action Required" is greyed while no room
  // allows the slot - every room today.
  it("offers the Action Required slot only where a room allows it", () => {
    expect(actionSlotAllowedAnywhere(POLICY)).toBe(false);
    const one = { ...POLICY, rooms: [room("acr", "ACR", {}, { actionSlot: { allowed: true, permitted: true, needsApproval: false } })] };
    expect(actionSlotAllowedAnywhere(one)).toBe(true);
    // A room listed as allowed but not permitted here (no signal for this system): no.
    const elsewhere = { ...POLICY, rooms: [room("acr", "ACR", {}, { actionSlot: { allowed: true, permitted: false, needsApproval: false } })] };
    expect(actionSlotAllowedAnywhere(elsewhere)).toBe(false);
  });
});

describe("the RNG's bands", () => {
  it("spans the range, each band from the one before's end", () => {
    const spans = bandSpans(rng());
    expect(spans.map((s) => [s.from, s.to])).toEqual([
      [1, 33],
      [34, 66],
      [67, 100],
    ]);
    expect(bandShare(spans[2], rng())).toBeCloseTo(0.34);
    expect(rngProblem(rng())).toBeNull();
  });

  it("moves an edge only between its neighbours, never the last band's end", () => {
    expect(setBandEnd(rng(), 0, 50).bands.map((b) => b.upTo)).toEqual([50, 66, 100]);
    expect(setBandEnd(rng(), 0, 80).bands.map((b) => b.upTo)).toEqual([65, 66, 100]);
    expect(setBandEnd(rng(), 1, 0).bands.map((b) => b.upTo)).toEqual([33, 34, 100]);
    expect(setBandEnd(rng(), 0, -5).bands[0].upTo).toBe(1);
    expect(setBandEnd(rng(), 2, 90)).toEqual(rng());
    for (const end of [-10, 0, 1, 33, 64, 65, 66, 99, 500]) {
      expect(rngProblem(setBandEnd(rng(), 0, end))).toBeNull();
      expect(rngProblem(setBandEnd(rng(), 1, end))).toBeNull();
    }
  });

  it("splits, removes, names and colours bands and stays valid", () => {
    const split = splitBand(rng(), 0);
    expect(split.bands.map((b) => b.upTo)).toEqual([17, 33, 66, 100]);
    expect(new Set(split.bands.map((b) => b.colour)).size).toBe(4);
    expect(rngProblem(split)).toBeNull();
    let many = rng();
    for (let i = 0; i < 20; i += 1) {
      const spans = bandSpans(many);
      const widest = spans.reduce((best, span, at) => (span.to - span.from > spans[best].to - spans[best].from ? at : best), 0);
      many = splitBand(many, widest);
    }
    expect(many.bands).toHaveLength(MAX_BANDS);
    expect(rngProblem(many)).toBeNull();
    // A one-number band cannot split.
    const narrow = setBandEnd(setBandEnd(rng(), 1, 34), 0, 33);
    expect(splitBand(narrow, 1)).toEqual(narrow);

    expect(removeBand(rng(), 1).bands.map((b) => b.upTo)).toEqual([33, 100]);
    expect(removeBand(rng(), 2).bands.map((b) => b.upTo)).toEqual([33, 100]);
    const one = removeBand(removeBand(rng(), 0), 0);
    expect(one.bands).toHaveLength(1);
    expect(removeBand(one, 0)).toEqual(one);
    expect(rngProblem(one)).toBeNull();

    const named = setBandLabel(rng(), 0, "  Fold  ");
    expect(named.bands[0].label).toBe("Fold");
    expect(setBandLabel(named, 0, "   ").bands[0]).not.toHaveProperty("label");
    expect([...(setBandLabel(rng(), 0, "x".repeat(40)).bands[0].label ?? "")]).toHaveLength(MAX_LABEL);
    expect(setBandColour(rng(), 0, "#ABCDEF").bands[0].colour).toBe("#abcdef");
    expect(setBandColour(rng(), 0, "red")).toEqual(rng());
  });

  it("refuses what the Rust side refuses", () => {
    const refused = (change: (r: RngSettings) => void) => {
      const r = structuredClone(rng());
      change(r);
      return rngProblem(r);
    };
    expect(refused((r) => (r.max = 0))).toBe("range");
    expect(refused((r) => ((r.max = 10_001), (r.bands[2].upTo = 10_001)))).toBe("range");
    expect(refused((r) => (r.bands = []))).toBe("bandCount");
    expect(refused((r) => ([r.bands[0], r.bands[1]] = [r.bands[1], r.bands[0]]))).toBe("order");
    expect(refused((r) => (r.bands[1].upTo = 33))).toBe("order");
    expect(refused((r) => (r.bands[0].upTo = 0))).toBe("outside");
    expect(refused((r) => r.bands.pop())).toBe("lastEnd");
    expect(refused((r) => (r.bands[2].upTo = 101))).toBe("outside");
    expect(refused((r) => (r.bands[0].colour = "#12345g"))).toBe("colour");
    expect(refused((r) => (r.bands[0].label = ""))).toBe("label");
    expect(refused((r) => (r.bands[0].label = "x".repeat(MAX_LABEL + 1)))).toBe("label");
    expect(refused((r) => (r.triggers.timerSecs = 0))).toBe("timer");
    expect(refused((r) => (r.triggers.timerSecs = 3601))).toBe("timer");
    // 0 - 99 with a timer, and a one-number range.
    expect(refused((r) => ((r.min = 0), (r.max = 99), (r.bands = [{ upTo: 99, colour: "#000000" }]), (r.triggers.timerSecs = 3600)))).toBeNull();
    expect(refused((r) => ((r.min = 7), (r.max = 7), (r.bands = [{ upTo: 7, colour: "#000000" }])))).toBeNull();
  });

  it("switches the timer on and off within 1 s - 1 h", () => {
    expect(setTimer(rng(), 10).triggers.timerSecs).toBe(10);
    expect(setTimer(rng(), 99_999).triggers.timerSecs).toBe(3600);
    expect(setTimer(rng(), 0).triggers.timerSecs).toBe(1);
    expect(setTimer(setTimer(rng(), 10), null).triggers).not.toHaveProperty("timerSecs");
  });
});

describe("layouts", () => {
  const slots: TilingSlot[] = [
    { id: "s1", monitor: 0, rect: { x: 0, y: 0, width: 500, height: 500 }, kind: "play", rooms: null, stack: true },
  ];

  it("saves a captured arrangement as a layout in force, with a fresh id and name", () => {
    const added = addLayout(tiling(), slots, "  Cash 2×3 ");
    expect(added?.layouts.map((l) => [l.id, l.name])).toEqual([["layout-1", "Cash 2×3"]]);
    expect(added?.active).toEqual({ kind: "custom", id: "layout-1" });
    expect(addLayout(tiling(), [], "x")).toBeNull();
    expect(addLayout(tiling(), slots, "   ")).toBeNull();
    const layouts = [{ id: "layout-2", name: "Layout 2", slots, autoSwitch: [] }];
    expect(newLayoutId(layouts)).toBe("layout-3");
    expect(newLayoutName(layouts, (n) => `Layout ${n}`)).toBe("Layout 3");
    expect(newLayoutName([], (n) => `Layout ${n}`)).toBe("Layout 1");
  });

  it("renames, picks and deletes, the auto grid taking over with the rules that led to it gone", () => {
    const base = addLayout(tiling(), slots, "Mine");
    expect(base).not.toBeNull();
    const settings: TilingSettings = {
      ...base!,
      autoSwitch: [{ minTables: 5, layoutId: "layout-1" }, { minTables: 9, layoutId: "auto" }],
    };
    expect(renameLayout(settings, "layout-1", "Ours").layouts[0].name).toBe("Ours");
    expect(renameLayout(settings, "layout-1", " ").layouts[0].name).toBe("Mine");
    expect(chooseLayout(settings, "auto").active).toEqual({ kind: "auto" });
    expect(chooseLayout(settings, "layout-1").active).toEqual({ kind: "custom", id: "layout-1" });
    const gone = deleteLayout(settings, "layout-1");
    expect(gone.layouts).toEqual([]);
    expect(gone.active).toEqual({ kind: "auto" });
    expect(gone.autoSwitch).toEqual([{ minTables: 9, layoutId: "auto" }]);
  });
});

describe("the RNG per room (T5 follow-up)", () => {
  const allowRng = { rng: { allowed: true, permitted: true, needsApproval: false } };

  it("reads each room's RNG verdict from the policy, approval from its own flag", () => {
    expect(verdictOf(room("a", "A", {}, allowRng), "rng")).toBe("allowed");
    expect(verdictOf(room("w", "W", {}, { rng: { allowed: false, permitted: false, needsApproval: true } }), "rng")).toBe("approval");
    expect(verdictOf(room("g", "G", { allowed: true, permitted: true }), "rng")).toBe("notAllowed");
    expect(verdictOf(room("g", "G", { allowed: true, permitted: true }))).toBe("allowed");
  });

  it("stores only the rooms switched off, and the row carries the switch", () => {
    const off = setRngRoomOn(rng(), "acr", false);
    expect(off.perRoom).toEqual({ acr: false });
    expect(rngRoomOn(off, "acr")).toBe(false);
    expect(rngRoomOn(off, "pokerstars")).toBe(true);
    expect(setRngRoomOn(off, "acr", true).perRoom).toEqual({});
    const rows = roomRows(POLICY, tiling(), null, off).shown;
    expect(rows.find((r) => r.id === "acr")).toMatchObject({ rngVerdict: "notAllowed", rngOn: false });
    expect(rows.find((r) => r.id === "pokerstars")).toMatchObject({ rngVerdict: "notAllowed", rngOn: true });
    // Without the RNG settings: on.
    expect(roomRows(POLICY, tiling(), null).shown.every((r) => r.rngOn)).toBe(true);
  });

  it("lists a room the RNG may show on even when tiling may not move it", () => {
    const policy = { ...POLICY, rooms: [...POLICY.rooms, room("chico", "Chico", { allowed: false }, allowRng)] };
    const { shown, folded } = roomRows(policy, tiling(), null, rng());
    expect(shown.map((r) => r.id)).toEqual(["pokerstars", "acr", "chico"]);
    expect(shown[2]).toMatchObject({ verdict: "notAllowed", rngVerdict: "allowed" });
    expect(folded.map((r) => r.id)).not.toContain("chico");
  });
});

describe("the RNG's size and opacity (T5 follow-up)", () => {
  it("reads 100 % when a row has neither", () => {
    expect(rngScale(rng())).toBe(100);
    expect(rngOpacity(rng())).toBe(100);
    expect(rngProblem(rng())).toBeNull();
  });

  it("keeps a slider's value whole and in range", () => {
    expect(setRngScale(rng(), 149.6).scale).toBe(150);
    expect(setRngScale(rng(), 10).scale).toBe(RNG_SCALE_MIN);
    expect(setRngScale(rng(), 900).scale).toBe(RNG_SCALE_MAX);
    expect(setRngOpacity(rng(), 0).opacity).toBe(RNG_OPACITY_MIN);
    expect(setRngOpacity(rng(), 101).opacity).toBe(RNG_OPACITY_MAX);
    const r = rng();
    expect(setRngScale(r, Number.NaN)).toBe(r);
    expect(rngProblem(setRngOpacity(setRngScale(rng(), 200), 30))).toBeNull();
  });

  it("refuses what RngSettings::validate refuses", () => {
    expect(rngProblem({ ...rng(), scale: RNG_SCALE_MIN - 1 })).toBe("scale");
    expect(rngProblem({ ...rng(), scale: RNG_SCALE_MAX + 1 })).toBe("scale");
    expect(rngProblem({ ...rng(), scale: 100.5 })).toBe("scale");
    expect(rngProblem({ ...rng(), opacity: RNG_OPACITY_MIN - 1 })).toBe("opacity");
    expect(rngProblem({ ...rng(), opacity: RNG_OPACITY_MAX + 1 })).toBe("opacity");
    expect(rngProblem({ ...rng(), scale: RNG_SCALE_MIN, opacity: RNG_OPACITY_MIN })).toBeNull();
  });
});

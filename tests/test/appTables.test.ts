/**
 * The desktop app's Tables screen (T5, docs/research/TABLE-TILING.md §4.5):
 * the displays scaled into the preview, stacked tables drawn as one box,
 * the rooms listed or folded, and the user's layouts. Pure TypeScript (`app/src/screens/tables/model.ts`),
 * so it runs here; the app has no test runner of its own.
 */
import { describe, expect, it } from "vitest";

import type {
  HudPolicy,
  HudStatus,
  MonitorInfo,
  RoomPolicy,
  TiledTable,
  TilingSettings,
  TilingSlot,
} from "../../app/src/lib/ipc.js";
import {
  addLayout,
  chooseLayout,
  deleteLayout,
  displayCounts,
  newLayoutId,
  newLayoutName,
  previewLayout,
  previewTables,
  renameLayout,
  actionSlotAllowedAnywhere,
  roomRows,
  setRoomOn,
  verdictOf,
} from "../../app/src/screens/tables/model.js";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** A 1920 x 1080 primary (40 px taskbar) and a 2560 x 1440 to its right, listed second first. */
const MONITORS: MonitorInfo[] = [
  { index: 1, primary: false, bounds: rect(1920, 0, 2560, 1440), workArea: rect(1920, 0, 2560, 1400), scalePermille: 1250 },
  { index: 0, primary: true, bounds: rect(0, 0, 1920, 1080), workArea: rect(0, 0, 1920, 1040), scalePermille: 1000 },
];

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

describe("the policy's verdicts", () => {
  it("reads each room's verdict from the policy, approval from its own flag", () => {
    expect(verdictOf(room("g", "G", { allowed: true, permitted: true }))).toBe("allowed");
    expect(verdictOf(room("w", "W", { allowed: false, needsApproval: true }))).toBe("approval");
    expect(verdictOf(room("u", "U", { allowed: false }))).toBe("notAllowed");
  });
});

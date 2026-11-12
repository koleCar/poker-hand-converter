/**
 * The desktop app's slot editor and auto-switch rules (T5 follow-up,
 * docs/research/TABLE-TILING.md §4.3, §4.5): drawing, moving, resizing,
 * snapping and clamping in thousandths of the work area, the conversion
 * from and to pixels, the layout edits, and the checks that mirror
 * `Layout::validate`, `check_rules` and `TilingSettings::validate`
 * (`hud/rail-hud-ipc/src/settings.rs`). Pure TypeScript
 * (`app/src/screens/tables/slots.ts`).
 */
import { describe, expect, it } from "vitest";

import type { MonitorInfo, SlotRect, TilingLayout, TilingSettings, TilingSlot } from "../../app/src/lib/ipc.js";
import {
  FALLBACK_MONITOR,
  GRID_LINES,
  MAX_RULES,
  MAX_SLOTS,
  MIN_SIZE,
  NO_SNAP,
  addRule,
  addSlot,
  clearOwnRules,
  deltaPermille,
  drawRect,
  duplicateLayout,
  editorMonitors,
  effectiveRules,
  fitArea,
  freeSpot,
  fromPixels,
  layoutProblem,
  makeSlot,
  moveRect,
  newSlotId,
  normalise,
  nudgeRect,
  removeRule,
  removeSlot,
  reorderSlot,
  resizeRect,
  ruleInForce,
  rulesProblem,
  saveLayout,
  setRuleCount,
  setRuleLayout,
  setSlotRooms,
  snapTargets,
  snapValue,
  tilingProblem,
  toPermille,
  toPixels,
  uniqueName,
  type SnapTargets,
} from "../../app/src/screens/tables/slots.js";

const GRID: SnapTargets = { on: true, xs: [], ys: [] };

function slot(id: string, rect: SlotRect, monitor = 0): TilingSlot {
  return { id, monitor, rect, kind: "play", rooms: null, stack: true };
}

function layout(id: string, slots: TilingSlot[] = [slot("s1", { x: 0, y: 0, width: 500, height: 1000 })]): TilingLayout {
  return { id, name: `Layout ${id}`, slots, autoSwitch: [] };
}

function settings(change: Partial<TilingSettings> = {}): TilingSettings {
  return {
    enabled: true,
    active: { kind: "auto" },
    layouts: [layout("layout-1")],
    autoSwitch: [],
    closeGaps: false,
    perRoom: {},
    ...change,
  };
}

function monitor(index: number, width: number, height: number, primary = false): MonitorInfo {
  return {
    index,
    primary,
    bounds: { x: index * 3000, y: 0, width, height },
    workArea: { x: index * 3000, y: 0, width, height: height - 40 },
    scalePermille: 1000,
  };
}

describe("thousandths and pixels", () => {
  it("converts a pointer offset to whole thousandths, clamped", () => {
    expect(toPermille(0, 800)).toBe(0);
    expect(toPermille(400, 800)).toBe(500);
    expect(toPermille(1, 3)).toBe(333);
    expect(toPermille(-20, 800)).toBe(0);
    expect(toPermille(900, 800)).toBe(1000);
    expect(toPermille(10, 0)).toBe(0);
    // A drag's distance is not clamped.
    expect(deltaPermille(-400, 800)).toBe(-500);
    expect(deltaPermille(1600, 800)).toBe(2000);
  });

  it("round-trips a slot rect through pixels of any size", () => {
    const rect = { x: 125, y: 333, width: 375, height: 667 };
    for (const [w, h] of [
      [1000, 1000],
      [640, 360],
      [1920, 1040],
      [333, 777],
    ]) {
      expect(fromPixels(toPixels(rect, w, h), w, h)).toEqual(rect);
    }
    expect(toPixels({ x: 500, y: 0, width: 500, height: 1000 }, 800, 450)).toEqual({ left: 400, top: 0, width: 400, height: 450 });
  });

  it("normalises to whole thousandths inside the work area", () => {
    expect(normalise({ x: 900.4, y: -3, width: 200, height: 0 })).toEqual({ x: 800, y: 0, width: 200, height: 1 });
    expect(fromPixels({ left: 700, top: 100, width: 300, height: 100 }, 800, 400)).toEqual({ x: 875, y: 250, width: 125, height: 250 });
  });

  it("fits a work area into the room the editor has", () => {
    expect(fitArea({ width: 1920, height: 1080 }, 960, 320)).toEqual({ width: (1920 * 320) / 1080, height: 320 });
    expect(fitArea({ width: 1000, height: 2000 }, 400, 1000)).toEqual({ width: 400, height: 800 });
    expect(fitArea({ width: 0, height: 10 }, 400, 400)).toEqual({ width: 0, height: 0 });
  });
});

describe("snapping", () => {
  it("the grid has 25 lines from 0 to 1000", () => {
    expect(GRID_LINES).toHaveLength(25);
    expect(GRID_LINES[0]).toBe(0);
    expect(GRID_LINES[12]).toBe(500);
    expect(GRID_LINES[24]).toBe(1000);
  });

  it("goes to the nearest grid line, a near slot edge first, nothing when off", () => {
    expect(snapValue(260, [], true)).toBe(250);
    expect(snapValue(495, [], true)).toBe(500);
    expect(snapValue(260, [270], true)).toBe(270);
    expect(snapValue(260, [290], true)).toBe(250);
    expect(snapValue(260, [270, 262], true)).toBe(262);
    expect(snapValue(261, [270], false)).toBe(261);
  });

  it("takes the other slots' edges on the same monitor only", () => {
    const slots = [slot("a", { x: 0, y: 0, width: 300, height: 400 }), slot("b", { x: 300, y: 0, width: 200, height: 1000 }), slot("c", { x: 10, y: 10, width: 10, height: 10 }, 1)];
    expect(snapTargets(slots, 0, "b", true)).toEqual({ on: true, xs: [0, 300], ys: [0, 400] });
    expect(snapTargets(slots, 0, null, false)).toBe(NO_SNAP);
  });
});

describe("drawing", () => {
  it("draws from either corner", () => {
    const rect = { x: 100, y: 200, width: 300, height: 400 };
    expect(drawRect({ x: 100, y: 200 }, { x: 400, y: 600 }, NO_SNAP)).toEqual(rect);
    expect(drawRect({ x: 400, y: 600 }, { x: 100, y: 200 }, NO_SNAP)).toEqual(rect);
    expect(drawRect({ x: 400, y: 200 }, { x: 100, y: 600 }, NO_SNAP)).toEqual(rect);
  });

  it("snaps the edges to the grid, or a neighbour's edge", () => {
    expect(drawRect({ x: 10, y: 5 }, { x: 490, y: 510 }, GRID)).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(drawRect({ x: 505, y: 5 }, { x: 990, y: 990 }, { on: true, xs: [497], ys: [] })).toEqual({ x: 497, y: 0, width: 503, height: 1000 });
  });

  it("a click or a sliver draws nothing", () => {
    expect(drawRect({ x: 100, y: 100 }, { x: 100, y: 100 }, NO_SNAP)).toBeNull();
    expect(drawRect({ x: 100, y: 100 }, { x: 100 + MIN_SIZE - 1, y: 500 }, NO_SNAP)).toBeNull();
    expect(drawRect({ x: 90, y: 100 }, { x: 100, y: 500 }, GRID)).toBeNull();
    expect(drawRect({ x: 100, y: 100 }, { x: 100 + MIN_SIZE, y: 500 }, NO_SNAP)).not.toBeNull();
  });
});

describe("moving", () => {
  const rect = { x: 100, y: 100, width: 300, height: 200 };

  it("moves by the drag, kept inside, size unchanged", () => {
    expect(moveRect(rect, 50, -20, NO_SNAP)).toEqual({ x: 150, y: 80, width: 300, height: 200 });
    expect(moveRect(rect, 5000, 5000, NO_SNAP)).toEqual({ x: 700, y: 800, width: 300, height: 200 });
    expect(moveRect(rect, -5000, -5000, NO_SNAP)).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it("snaps by the nearer edge", () => {
    // Left edge 245 → 250 (5 away); right edge 545 → 542 (3 away): the right wins.
    expect(moveRect({ x: 100, y: 0, width: 300, height: 1000 }, 145, 0, GRID).x).toBe(242);
    // Onto a neighbour's edge.
    expect(moveRect(rect, 395, 0, { on: true, xs: [800], ys: [] }).x).toBe(500);
  });
});

describe("resizing", () => {
  const rect = { x: 200, y: 200, width: 400, height: 400 };

  it("drags only the handle's edges", () => {
    expect(resizeRect(rect, "e", 100, 999, NO_SNAP)).toEqual({ x: 200, y: 200, width: 500, height: 400 });
    expect(resizeRect(rect, "nw", -50, -100, NO_SNAP)).toEqual({ x: 150, y: 100, width: 450, height: 500 });
    expect(resizeRect(rect, "s", 0, 100, NO_SNAP)).toEqual({ x: 200, y: 200, width: 400, height: 500 });
  });

  it("never past the work area nor under the smallest size", () => {
    expect(resizeRect(rect, "se", 9999, 9999, NO_SNAP)).toEqual({ x: 200, y: 200, width: 800, height: 800 });
    expect(resizeRect(rect, "w", 9999, 0, NO_SNAP)).toEqual({ x: 600 - MIN_SIZE, y: 200, width: MIN_SIZE, height: 400 });
    expect(resizeRect(rect, "n", 0, -9999, NO_SNAP)).toEqual({ x: 200, y: 0, width: 400, height: 600 });
  });

  it("snaps the dragged edge", () => {
    expect(resizeRect(rect, "e", 60, 0, GRID)).toEqual({ x: 200, y: 200, width: 467, height: 400 });
    expect(resizeRect(rect, "e", 90, 0, { on: true, xs: [688], ys: [] })).toEqual({ x: 200, y: 200, width: 488, height: 400 });
  });
});

describe("keys", () => {
  const rect = { x: 100, y: 100, width: 300, height: 200 };

  it("arrows move a fine step, or to the next grid line", () => {
    expect(nudgeRect(rect, "ArrowRight", false, false)).toEqual({ ...rect, x: 105 });
    expect(nudgeRect(rect, "ArrowUp", false, false)).toEqual({ ...rect, y: 95 });
    expect(nudgeRect(rect, "ArrowRight", false, true)).toEqual({ ...rect, x: 125 });
    expect(nudgeRect(rect, "ArrowLeft", false, true)).toEqual({ ...rect, x: 83 });
    expect(nudgeRect({ ...rect, x: 700 }, "ArrowRight", false, true)).toEqual({ ...rect, x: 700 });
    expect(nudgeRect({ ...rect, x: 0 }, "ArrowLeft", false, false)).toEqual({ ...rect, x: 0 });
  });

  it("Shift + arrows move the right or bottom edge", () => {
    expect(nudgeRect(rect, "ArrowRight", true, false)).toEqual({ ...rect, width: 305 });
    expect(nudgeRect(rect, "ArrowDown", true, true)).toEqual({ ...rect, height: 233 });
    expect(nudgeRect({ ...rect, width: MIN_SIZE }, "ArrowLeft", true, false)).toEqual({ ...rect, width: MIN_SIZE });
    expect(nudgeRect({ ...rect, x: 700 }, "ArrowRight", true, true)).toEqual({ ...rect, x: 700, width: 300 });
  });
});

describe("the editor's monitors", () => {
  it("falls back to one 1920×1080 display before the HUD has said", () => {
    expect(editorMonitors([], [])).toEqual([FALLBACK_MONITOR]);
  });

  it("keeps the HUD's order and adds a missing slot monitor shaped as the primary", () => {
    const known = [monitor(1, 1920, 1080), monitor(0, 2560, 1440, true)];
    const shown = editorMonitors(known, [slot("s1", { x: 0, y: 0, width: 10, height: 10 }, 3)]);
    expect(shown.map((m) => m.index)).toEqual([0, 1, 3]);
    expect(shown[2].workArea).toEqual(known[1].workArea);
    expect(shown[2].primary).toBe(false);
  });
});

describe("a layout's slots", () => {
  it("names new slots as the capture does, never twice", () => {
    expect(newSlotId([])).toBe("s1");
    expect(newSlotId([slot("s2", { x: 0, y: 0, width: 1, height: 1 })])).toBe("s3");
    expect(newSlotId([slot("s1", { x: 0, y: 0, width: 1, height: 1 }), slot("s3", { x: 0, y: 0, width: 1, height: 1 })])).toBe("s4");
  });

  it("puts '+ Slot' in the first free quarter", () => {
    const left = slot("s1", { x: 0, y: 0, width: 500, height: 1000 });
    expect(freeSpot([], 0)).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(freeSpot([left], 0)).toEqual({ x: 500, y: 0, width: 500, height: 500 });
    expect(freeSpot([left], 1)).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    const full = [left, slot("s2", { x: 500, y: 0, width: 500, height: 1000 })];
    expect(freeSpot(full, 0)).toEqual({ x: 250, y: 250, width: 500, height: 500 });
  });

  it("adds, removes, reorders and filters slots", () => {
    let l = layout("l", []);
    l = addSlot(l, makeSlot(l.slots, 0, { x: 0, y: 0, width: 500, height: 1000 }));
    l = addSlot(l, makeSlot(l.slots, 0, { x: 500, y: 0, width: 500, height: 1000 }));
    l = addSlot(l, makeSlot(l.slots, 1, { x: 0, y: 0, width: 1000, height: 1000 }));
    expect(l.slots.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(l.slots.every((s) => s.stack && s.kind === "play" && s.rooms === null)).toBe(true);
    expect(reorderSlot(l, "s3", -1).slots.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
    expect(reorderSlot(l, "s1", -1)).toBe(l);
    expect(reorderSlot(l, "s1", 9).slots.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
    expect(removeSlot(l, "s2").slots.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(setSlotRooms(l, "s1", ["acr", "acr", "pokerstars"]).slots[0].rooms).toEqual(["acr", "pokerstars"]);
    expect(setSlotRooms(l, "s1", []).slots[0].rooms).toBeNull();
    const many = { ...l, slots: Array.from({ length: MAX_SLOTS }, (_, i) => slot(`s${i + 1}`, { x: 0, y: 0, width: 10, height: 10 })) };
    expect(addSlot(many, slot("x", { x: 0, y: 0, width: 10, height: 10 }))).toBe(many);
  });
});

describe("validation as settings.rs", () => {
  it("accepts overlapping slots (settings.rs allows them)", () => {
    const l = layout("l", [slot("s1", { x: 0, y: 0, width: 600, height: 1000 }), slot("s2", { x: 400, y: 0, width: 600, height: 1000 })]);
    expect(layoutProblem(l)).toBeNull();
  });

  it("refuses what Layout::validate refuses", () => {
    const ok = layout("l");
    const s1 = ok.slots[0];
    expect(layoutProblem(ok)).toBeNull();
    expect(layoutProblem({ ...ok, id: "auto" })).toBe("id");
    expect(layoutProblem({ ...ok, id: "" })).toBe("id");
    expect(layoutProblem({ ...ok, id: "x".repeat(65) })).toBe("id");
    expect(layoutProblem({ ...ok, name: "  " })).toBe("name");
    expect(layoutProblem({ ...ok, name: "x".repeat(81) })).toBe("name");
    expect(layoutProblem({ ...ok, slots: [s1, { ...s1 }] })).toBe("slotTwice");
    expect(layoutProblem({ ...ok, slots: [{ ...s1, id: "" }] })).toBe("slotId");
    expect(layoutProblem({ ...ok, slots: [{ ...s1, monitor: 16 }] })).toBe("monitor");
    expect(layoutProblem({ ...ok, slots: [{ ...s1, rect: { x: 501, y: 0, width: 500, height: 10 } }] })).toBe("rect");
    expect(layoutProblem({ ...ok, slots: [{ ...s1, rect: { x: 0, y: 0, width: 0, height: 10 } }] })).toBe("rect");
    expect(layoutProblem({ ...ok, slots: [{ ...s1, rect: { x: 0.5, y: 0, width: 10, height: 10 } }] })).toBe("rect");
    expect(layoutProblem({ ...ok, slots: [{ ...s1, rooms: [""] }] })).toBe("rooms");
    expect(layoutProblem({ ...ok, slots: Array.from({ length: 65 }, (_, i) => slot(`s${i}`, { x: 0, y: 0, width: 1, height: 1 })) })).toBe("slotCount");
  });

  it("the editor saves no empty layout, but a stored one validates", () => {
    const empty = layout("l", []);
    expect(layoutProblem(empty)).toBe("empty");
    expect(layoutProblem(empty, false)).toBeNull();
    expect(tilingProblem(settings({ layouts: [empty] }))).toBeNull();
  });

  it("refuses what TilingSettings::validate refuses", () => {
    expect(tilingProblem(settings())).toBeNull();
    expect(tilingProblem(settings({ layouts: [layout("a"), layout("a")] }))).toBe("layoutTwice");
    expect(tilingProblem(settings({ active: { kind: "custom", id: "gone" } }))).toBe("active");
    expect(tilingProblem(settings({ autoSwitch: [{ minTables: 3, layoutId: "gone" }] }))).toBe("target");
    expect(tilingProblem(settings({ layouts: [{ ...layout("a"), autoSwitch: [{ minTables: 0, layoutId: "auto" }] }] }))).toBe("minTables");
    expect(tilingProblem(settings({ perRoom: { [""]: false } }))).toBe("roomId");
    expect(tilingProblem(settings({ layouts: Array.from({ length: 33 }, (_, i) => layout(`l${i}`)) }))).toBe("layoutCount");
    const big = Array.from({ length: 32 }, (_, i) =>
      layout(
        `l${i}`,
        Array.from({ length: 64 }, (_, j) => slot(`s${j}`, { x: 0, y: 0, width: 10, height: 10 })),
      ),
    );
    expect(tilingProblem(settings({ layouts: big }))).toBe("size");
  });
});

describe("saving layouts", () => {
  it("a new layout gets a fresh id and goes in force", () => {
    const base = settings();
    const drawn = { ...layout("layout-2"), name: "  Mine  " };
    const saved = saveLayout(base, drawn, false);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.settings.layouts).toHaveLength(2);
    expect(saved.settings.layouts[1]).toMatchObject({ id: "layout-2", name: "Mine", autoSwitch: [] });
    expect(saved.settings.active).toEqual({ kind: "custom", id: "layout-2" });
  });

  it("overwriting keeps the id, the layout's own rules and what is in force", () => {
    const own = [{ minTables: 4, layoutId: "auto" }];
    const base = settings({ layouts: [{ ...layout("layout-1"), autoSwitch: own }] });
    const edited = { ...base.layouts[0], name: "Renamed", slots: [slot("s1", { x: 0, y: 0, width: 1000, height: 1000 })], autoSwitch: [] };
    const saved = saveLayout(base, edited, true);
    expect(saved.ok && saved.settings.layouts).toEqual([{ ...edited, autoSwitch: own }]);
    expect(saved.ok && saved.settings.active).toEqual({ kind: "auto" });
  });

  it("refuses with the reason", () => {
    expect(saveLayout(settings(), layout("x", []), false)).toEqual({ ok: false, problem: "empty" });
    expect(saveLayout(settings(), { ...layout("x"), name: "" }, false)).toEqual({ ok: false, problem: "name" });
    const full = settings({ layouts: Array.from({ length: 32 }, (_, i) => layout(`l${i}`)) });
    expect(saveLayout(full, layout("x"), false)).toEqual({ ok: false, problem: "layoutCount" });
    // Overwriting still works when full.
    expect(saveLayout(full, { ...layout("l3"), name: "Three" }, true).ok).toBe(true);
  });

  it("duplicates with a new id, name and its own rules, in force", () => {
    const base = settings({ layouts: [{ ...layout("layout-1"), autoSwitch: [{ minTables: 6, layoutId: "auto" }] }] });
    const copy = duplicateLayout(base, "layout-1", "Copy");
    expect(copy?.ok).toBe(true);
    if (!copy?.ok) return;
    const made = copy.settings.layouts[1];
    expect(made).toMatchObject({ id: "layout-2", name: "Copy", slots: base.layouts[0].slots, autoSwitch: [{ minTables: 6, layoutId: "auto" }] });
    expect(copy.settings.active).toEqual({ kind: "custom", id: "layout-2" });
    expect(duplicateLayout(base, "gone", "x")).toBeNull();
  });

  it("finds a free name", () => {
    const layouts = [{ ...layout("a"), name: "Mine copy" }, { ...layout("b"), name: "mine copy 2" }];
    expect(uniqueName(layouts, "Other")).toBe("Other");
    expect(uniqueName(layouts, "Mine copy")).toBe("Mine copy 3");
    expect([...uniqueName([{ ...layout("c"), name: "x".repeat(80) }], "x".repeat(90))]).toHaveLength(80);
  });
});

describe("auto-switch by table count", () => {
  const two = settings({ layouts: [layout("layout-1"), layout("layout-2")] });

  it("adds rules two tables apart, sorted, at most 16", () => {
    let s: TilingSettings | null = two;
    s = addRule(s as TilingSettings);
    expect(s?.autoSwitch).toEqual([{ minTables: 4, layoutId: "auto" }]);
    s = addRule(s as TilingSettings);
    expect(s?.autoSwitch.map((r) => r.minTables)).toEqual([4, 6]);
    let many = two;
    for (let i = 0; i < MAX_RULES; i += 1) many = addRule(many) ?? many;
    expect(many.autoSwitch).toHaveLength(MAX_RULES);
    expect(addRule(many)).toBeNull();
  });

  it("edits keep the list sorted; a duplicate count is caught", () => {
    const s = { ...two, autoSwitch: [{ minTables: 8, layoutId: "layout-2" }, { minTables: 3, layoutId: "layout-1" }] };
    const moved = setRuleCount(s, 0, 10);
    expect(moved.autoSwitch).toEqual([{ minTables: 8, layoutId: "layout-2" }, { minTables: 10, layoutId: "layout-1" }]);
    expect(rulesProblem(moved.autoSwitch, moved.layouts)).toBeNull();
    const twice = setRuleCount(s, 0, 8);
    expect(rulesProblem(twice.autoSwitch, twice.layouts)).toBe("duplicate");
    expect(rulesProblem(setRuleCount(s, 0, 0).autoSwitch, s.layouts)).toBe("minTables");
    expect(setRuleLayout(s, 1, "auto").autoSwitch[1]).toEqual({ minTables: 8, layoutId: "auto" });
    expect(rulesProblem(setRuleLayout(s, 1, "gone").autoSwitch, s.layouts)).toBe("target");
    expect(removeRule(s, 0).autoSwitch).toEqual([{ minTables: 8, layoutId: "layout-2" }]);
    expect(rulesProblem(Array.from({ length: 17 }, (_, i) => ({ minTables: i + 1, layoutId: "auto" })), [])).toBe("ruleCount");
  });

  it("the rule in force is the largest count reached", () => {
    const rules = [{ minTables: 3, layoutId: "a" }, { minTables: 8, layoutId: "b" }, { minTables: 5, layoutId: "c" }];
    expect(ruleInForce(rules, 2)).toBeNull();
    expect(ruleInForce(rules, 3)?.layoutId).toBe("a");
    expect(ruleInForce(rules, 7)?.layoutId).toBe("c");
    expect(ruleInForce(rules, 12)?.layoutId).toBe("b");
    expect(ruleInForce([], 12)).toBeNull();
  });

  it("reads the layout in force's own rules first, as Engine::effective does", () => {
    const own = [{ minTables: 2, layoutId: "auto" }];
    const s = settings({
      layouts: [{ ...layout("layout-1"), autoSwitch: own }, layout("layout-2")],
      autoSwitch: [{ minTables: 5, layoutId: "layout-2" }],
    });
    expect(effectiveRules(s)).toEqual({ rules: s.autoSwitch, own: null });
    const forced = { ...s, active: { kind: "custom" as const, id: "layout-1" } };
    expect(effectiveRules(forced)).toEqual({ rules: own, own: forced.layouts[0] });
    expect(effectiveRules({ ...s, active: { kind: "custom", id: "layout-2" } }).own).toBeNull();
    expect(effectiveRules(clearOwnRules(forced, "layout-1"))).toEqual({ rules: s.autoSwitch, own: null });
  });
});

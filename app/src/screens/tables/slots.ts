/**
 * The slot editor's and the auto-switch rules' logic (T5 follow-up,
 * docs/research/TABLE-TILING.md §4.3, §4.5), pure, so
 * `tests/test/appTableSlots.test.ts` runs it:
 *
 * - **Geometry**: a slot's rect is stored as `rail_hud_ipc::settings::SlotRect`,
 *   whole thousandths of its monitor's work area. Drawing, moving and
 *   resizing work in thousandths too ({@link drawRect}, {@link moveRect},
 *   {@link resizeRect}, {@link nudgeRect}), always clamped inside the work
 *   area, optionally snapped to a 1/{@link GRID} grid and, closer still, to
 *   the other slots' edges ({@link snapTargets}).
 * - **Layouts**: slots added, removed, reordered (the order is the fill
 *   order: `rail_hud::tiling` gives a table the first free slot), a layout
 *   saved new or over the old one, duplicated.
 * - **Validation**: the same checks as `Layout::validate` and
 *   `TilingSettings::validate` ({@link layoutProblem}, {@link tilingProblem},
 *   {@link rulesProblem}), so the screen never sends what the app would
 *   refuse. Slots may overlap: `settings.rs` allows it.
 * - **Auto-switch**: the rules by table count the engine reads
 *   (`Engine::effective`: the layout in force's own rules when it has any,
 *   else `TilingSettings.autoSwitch`) and the one in force for a count.
 */
import type { AutoSwitch, MonitorInfo, SlotRect, TilingLayout, TilingSettings, TilingSlot } from "../../lib/ipc";
import { MAX_LAYOUTS, MAX_NAME, newLayoutId } from "./model";

// ---------------------------------------------------------------------
// Limits (`rail_hud_ipc::settings`).

/** The whole work area, thousandths. */
export const FULL = 1000;
/** Slots a layout has at most (`MAX_SLOTS`). */
export const MAX_SLOTS = 64;
/** The longest id (`MAX_ID`). */
export const MAX_ID = 64;
/** Rooms a slot's filter names at most (`MAX_ROOMS`). */
export const MAX_ROOMS = 64;
/** A slot's monitor is below this (`MAX_MONITORS`). */
export const MAX_MONITORS = 16;
/** Auto-switch rules at most (`MAX_RULES`). */
export const MAX_RULES = 16;
/** The largest settings object, bytes of JSON (`MAX_SETTINGS_BYTES`). */
export const MAX_SETTINGS_BYTES = 32 * 1024;
/** The auto grid's layout id (`AUTO_LAYOUT`). */
export const AUTO_LAYOUT = "auto";

/** The snap grid: this many steps across and down. */
export const GRID = 24;
/** The smallest slot the editor draws or resizes to, thousandths. */
export const MIN_SIZE = 20;
/** How near (thousandths) another slot's edge pulls an edge onto it. */
export const EDGE_PULL = 12;
/** A key nudges this far (thousandths) when the grid is off. */
export const FINE_STEP = 5;

// ---------------------------------------------------------------------
// Geometry.

export interface Point {
  x: number;
  y: number;
}

/** The grid's lines, thousandths: `0, 42, 83, ... 1000`. */
export const GRID_LINES: readonly number[] = Array.from({ length: GRID + 1 }, (_, k) => Math.round((k * FULL) / GRID));

/** Where edges snap: the grid (when `on`) and the other slots' edges on that monitor. */
export interface SnapTargets {
  on: boolean;
  /** Vertical edges (x) of the other slots. */
  xs: number[];
  /** Horizontal edges (y) of the other slots. */
  ys: number[];
}

/** No snapping at all. */
export const NO_SNAP: SnapTargets = { on: false, xs: [], ys: [] };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** `offset` pixels of `size` as whole thousandths, inside 0 - 1000. */
export function toPermille(offset: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(offset)) return 0;
  return clamp(Math.round((offset / size) * FULL), 0, FULL);
}

/** `offset` pixels of `size` as thousandths, not clamped (a drag's distance may run past an edge). */
export function deltaPermille(offset: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(offset)) return 0;
  return Math.round((offset / size) * FULL);
}

/** A slot's rect in pixels of a `width × height` work area. */
export function toPixels(rect: SlotRect, width: number, height: number): { left: number; top: number; width: number; height: number } {
  return {
    left: (rect.x / FULL) * width,
    top: (rect.y / FULL) * height,
    width: (rect.width / FULL) * width,
    height: (rect.height / FULL) * height,
  };
}

/** A pixel rect of a `width × height` work area as a valid slot rect (whole thousandths, inside, at least 1 each way). */
export function fromPixels(px: { left: number; top: number; width: number; height: number }, width: number, height: number): SlotRect {
  const x0 = toPermille(px.left, width);
  const y0 = toPermille(px.top, height);
  const x1 = toPermille(px.left + px.width, width);
  const y1 = toPermille(px.top + px.height, height);
  return normalise({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
}

/** Whole thousandths, at least 1 wide and tall, inside the work area. */
export function normalise(rect: SlotRect): SlotRect {
  const width = clamp(Math.round(rect.width), 1, FULL);
  const height = clamp(Math.round(rect.height), 1, FULL);
  return {
    x: clamp(Math.round(rect.x), 0, FULL - width),
    y: clamp(Math.round(rect.y), 0, FULL - height),
    width,
    height,
  };
}

/** `v` onto the nearest of `edges` within {@link EDGE_PULL}, else (snap on) the nearest grid line. */
export function snapValue(v: number, edges: readonly number[], on: boolean): number {
  if (!on) return v;
  let best: number | null = null;
  for (const edge of edges) {
    if (Math.abs(edge - v) <= EDGE_PULL && (best === null || Math.abs(edge - v) < Math.abs(best - v))) best = edge;
  }
  if (best !== null) return best;
  let line = GRID_LINES[0];
  for (const l of GRID_LINES) if (Math.abs(l - v) < Math.abs(line - v)) line = l;
  return line;
}

/** The edges of `slots` on `monitor` but `except`, to snap to (`on`: snapping is on). */
export function snapTargets(slots: readonly TilingSlot[], monitor: number, except: string | null, on: boolean): SnapTargets {
  if (!on) return NO_SNAP;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const slot of slots) {
    if (slot.monitor !== monitor || slot.id === except) continue;
    xs.push(slot.rect.x, slot.rect.x + slot.rect.width);
    ys.push(slot.rect.y, slot.rect.y + slot.rect.height);
  }
  return { on, xs, ys };
}

/**
 * The rect a drag from `a` to `b` draws (either corner first), its edges
 * snapped, inside the work area; `null` when it is smaller than
 * {@link MIN_SIZE} either way (a click, not a drag).
 */
export function drawRect(a: Point, b: Point, snap: SnapTargets): SlotRect | null {
  const x0 = clamp(snapValue(Math.min(a.x, b.x), snap.xs, snap.on), 0, FULL);
  const x1 = clamp(snapValue(Math.max(a.x, b.x), snap.xs, snap.on), 0, FULL);
  const y0 = clamp(snapValue(Math.min(a.y, b.y), snap.ys, snap.on), 0, FULL);
  const y1 = clamp(snapValue(Math.max(a.y, b.y), snap.ys, snap.on), 0, FULL);
  if (x1 - x0 < MIN_SIZE || y1 - y0 < MIN_SIZE) return null;
  return normalise({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** Along one axis: `start` moved by `delta`, kept inside, then its nearer edge snapped. */
function moveAxis(start: number, size: number, delta: number, edges: readonly number[], on: boolean): number {
  const free = clamp(start + delta, 0, FULL - size);
  if (!on) return Math.round(free);
  const byStart = snapValue(free, edges, true);
  const byEnd = snapValue(free + size, edges, true) - size;
  const best = Math.abs(byStart - free) <= Math.abs(byEnd - free) ? byStart : byEnd;
  return clamp(Math.round(best), 0, FULL - size);
}

/** `rect` moved by `(dx, dy)` thousandths, kept inside the work area, size unchanged, snapped by its nearer edge. */
export function moveRect(rect: SlotRect, dx: number, dy: number, snap: SnapTargets): SlotRect {
  return {
    x: moveAxis(rect.x, rect.width, dx, snap.xs, snap.on),
    y: moveAxis(rect.y, rect.height, dy, snap.ys, snap.on),
    width: rect.width,
    height: rect.height,
  };
}

/** Which edges a resize handle drags: `n`, `ne`, `e`, ... */
export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const HANDLES: readonly Handle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/**
 * `rect` with the edges of `handle` dragged by `(dx, dy)` thousandths and
 * snapped; the other edges stay. Never smaller than {@link MIN_SIZE} (or
 * the rect's own size, if it is smaller still) and never outside the work
 * area.
 */
export function resizeRect(rect: SlotRect, handle: Handle, dx: number, dy: number, snap: SnapTargets): SlotRect {
  let left = rect.x;
  let right = rect.x + rect.width;
  let top = rect.y;
  let bottom = rect.y + rect.height;
  const minW = Math.min(MIN_SIZE, rect.width);
  const minH = Math.min(MIN_SIZE, rect.height);
  if (handle.includes("w")) left = clamp(snapValue(left + dx, snap.xs, snap.on), 0, right - minW);
  if (handle.includes("e")) right = clamp(snapValue(right + dx, snap.xs, snap.on), left + minW, FULL);
  if (handle.includes("n")) top = clamp(snapValue(top + dy, snap.ys, snap.on), 0, bottom - minH);
  if (handle.includes("s")) bottom = clamp(snapValue(bottom + dy, snap.ys, snap.on), top + minH, FULL);
  return normalise({ x: left, y: top, width: right - left, height: bottom - top });
}

/** The grid line after (`dir` 1) or before (-1) `v`; `v` itself at the end. */
function nextLine(v: number, dir: 1 | -1): number {
  if (dir > 0) return GRID_LINES.find((l) => l > v) ?? FULL;
  return [...GRID_LINES].reverse().find((l) => l < v) ?? 0;
}

export type Arrow = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export function isArrow(key: string): key is Arrow {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

/**
 * An arrow key on a slot: moves it one step (`resize` false) or moves its
 * right / bottom edge one step (`resize` true: Shift). A step is the next
 * grid line when snapping is on, else {@link FINE_STEP}.
 */
export function nudgeRect(rect: SlotRect, key: Arrow, resize: boolean, grid: boolean): SlotRect {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const dir: 1 | -1 = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
  if (resize) {
    if (horizontal) {
      const right = rect.x + rect.width;
      const next = grid ? nextLine(right, dir) : right + dir * FINE_STEP;
      const end = clamp(next, rect.x + Math.min(MIN_SIZE, rect.width), FULL);
      return normalise({ ...rect, width: end - rect.x });
    }
    const bottom = rect.y + rect.height;
    const next = grid ? nextLine(bottom, dir) : bottom + dir * FINE_STEP;
    const end = clamp(next, rect.y + Math.min(MIN_SIZE, rect.height), FULL);
    return normalise({ ...rect, height: end - rect.y });
  }
  if (horizontal) {
    const x = grid ? nextLine(rect.x, dir) : rect.x + dir * FINE_STEP;
    return normalise({ ...rect, x: clamp(x, 0, FULL - rect.width) });
  }
  const y = grid ? nextLine(rect.y, dir) : rect.y + dir * FINE_STEP;
  return normalise({ ...rect, y: clamp(y, 0, FULL - rect.height) });
}

export function overlaps(a: SlotRect, b: SlotRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// ---------------------------------------------------------------------
// The editor's monitors.

/** A monitor the editor draws when the HUD has not said which there are: a 1920×1080 primary. */
export const FALLBACK_MONITOR: MonitorInfo = {
  index: 0,
  primary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  scalePermille: 1000,
};

/**
 * The monitors the editor offers, in layout order: the HUD's (else
 * {@link FALLBACK_MONITOR}), and, for a slot on a monitor this computer
 * does not have, the primary's shape under that index (the engine puts
 * such a slot on the primary).
 */
export function editorMonitors(known: readonly MonitorInfo[], slots: readonly TilingSlot[]): MonitorInfo[] {
  const shown = known.filter((m) => m.workArea.width > 0 && m.workArea.height > 0).sort((a, b) => a.index - b.index);
  const list = shown.length > 0 ? shown : [FALLBACK_MONITOR];
  const primary = list.find((m) => m.primary) ?? list[0];
  const have = new Set(list.map((m) => m.index));
  const extra = [...new Set(slots.map((s) => s.monitor))].filter((i) => !have.has(i) && i < MAX_MONITORS).sort((a, b) => a - b);
  return [...list, ...extra.map((index) => ({ ...primary, index, primary: false }))];
}

/** The largest `w × h` of the work area's shape inside `maxW × maxH`. */
export function fitArea(area: { width: number; height: number }, maxW: number, maxH: number): { width: number; height: number } {
  if (!(area.width > 0 && area.height > 0) || !(maxW > 0 && maxH > 0)) return { width: 0, height: 0 };
  const scale = Math.min(maxW / area.width, maxH / area.height);
  return { width: area.width * scale, height: area.height * scale };
}

// ---------------------------------------------------------------------
// A layout's slots.

/** An id no slot of `slots` has: `s1`, `s2`, ... (as `capture_slots` names them). */
export function newSlotId(slots: readonly TilingSlot[]): string {
  const taken = new Set(slots.map((s) => s.id));
  let n = slots.length + 1;
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** A play slot on `monitor` at `rect`, stackable (as a captured one). */
export function makeSlot(slots: readonly TilingSlot[], monitor: number, rect: SlotRect): TilingSlot {
  return { id: newSlotId(slots), monitor, rect: normalise(rect), kind: "play", rooms: null, stack: true };
}

/** Where "+ Slot" puts a slot: the first quarter of the work area no slot overlaps, else the middle. */
export function freeSpot(slots: readonly TilingSlot[], monitor: number): SlotRect {
  const half = FULL / 2;
  const quarters: SlotRect[] = [
    { x: 0, y: 0, width: half, height: half },
    { x: half, y: 0, width: half, height: half },
    { x: 0, y: half, width: half, height: half },
    { x: half, y: half, width: half, height: half },
  ];
  const mine = slots.filter((s) => s.monitor === monitor);
  return quarters.find((q) => !mine.some((s) => overlaps(s.rect, q))) ?? { x: 250, y: 250, width: half, height: half };
}

/** `layout` with `slot` appended (last in the fill order); unchanged at {@link MAX_SLOTS}. */
export function addSlot(layout: TilingLayout, slot: TilingSlot): TilingLayout {
  if (layout.slots.length >= MAX_SLOTS) return layout;
  return { ...layout, slots: [...layout.slots, slot] };
}

export function removeSlot(layout: TilingLayout, id: string): TilingLayout {
  return { ...layout, slots: layout.slots.filter((s) => s.id !== id) };
}

export function updateSlot(layout: TilingLayout, id: string, change: Partial<Omit<TilingSlot, "id">>): TilingLayout {
  return { ...layout, slots: layout.slots.map((s) => (s.id === id ? { ...s, ...change } : s)) };
}

/** Slot `id` earlier (`by` < 0) or later in the fill order, kept inside the list. */
export function reorderSlot(layout: TilingLayout, id: string, by: number): TilingLayout {
  const from = layout.slots.findIndex((s) => s.id === id);
  if (from < 0) return layout;
  const to = clamp(from + by, 0, layout.slots.length - 1);
  if (to === from) return layout;
  const slots = [...layout.slots];
  const [slot] = slots.splice(from, 1);
  slots.splice(to, 0, slot);
  return { ...layout, slots };
}

/** A slot's room filter: none checked is any room (`null`). */
export function setSlotRooms(layout: TilingLayout, id: string, rooms: readonly string[]): TilingLayout {
  const unique = [...new Set(rooms)].slice(0, MAX_ROOMS);
  return updateSlot(layout, id, { rooms: unique.length === 0 ? null : unique });
}

// ---------------------------------------------------------------------
// Validation (`Layout::validate`, `check_rules`, `TilingSettings::validate`).

/** Why `Layout::validate` would refuse a layout (or the editor: one with no slot). */
export type LayoutProblem = "id" | "name" | "empty" | "slotCount" | "slotId" | "slotTwice" | "monitor" | "rect" | "rooms";

function badId(id: string): boolean {
  const length = [...id].length;
  return length === 0 || length > MAX_ID;
}

function wholeIn(v: number, lo: number, hi: number): boolean {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * `Layout::validate`'s checks, in its order, plus the editor's own: a
 * layout it saves has a slot (`needSlot`; the Rust side allows none).
 */
export function layoutProblem(layout: TilingLayout, needSlot = true): LayoutProblem | null {
  if (badId(layout.id) || layout.id === AUTO_LAYOUT) return "id";
  if (layout.name.trim() === "" || [...layout.name].length > MAX_NAME) return "name";
  if (needSlot && layout.slots.length === 0) return "empty";
  if (layout.slots.length > MAX_SLOTS) return "slotCount";
  for (const [i, slot] of layout.slots.entries()) {
    if (badId(slot.id)) return "slotId";
    if (layout.slots.slice(0, i).some((s) => s.id === slot.id)) return "slotTwice";
    if (!wholeIn(slot.monitor, 0, MAX_MONITORS - 1)) return "monitor";
    const r = slot.rect;
    if (
      !wholeIn(r.x, 0, FULL) ||
      !wholeIn(r.y, 0, FULL) ||
      !wholeIn(r.width, 1, FULL) ||
      !wholeIn(r.height, 1, FULL) ||
      r.x + r.width > FULL ||
      r.y + r.height > FULL
    ) {
      return "rect";
    }
    if (slot.rooms !== null && slot.rooms !== undefined && (slot.rooms.length > MAX_ROOMS || slot.rooms.some(badId))) return "rooms";
  }
  return null;
}

/** Why `check_rules` would refuse a rule list. */
export type RulesProblem = "ruleCount" | "minTables" | "duplicate" | "target";

/** `check_rules`: at most {@link MAX_RULES}; each count a whole number from 1, once; each target a layout or the auto grid. */
export function rulesProblem(rules: readonly AutoSwitch[], layouts: readonly TilingLayout[]): RulesProblem | null {
  if (rules.length > MAX_RULES) return "ruleCount";
  for (const [i, rule] of rules.entries()) {
    if (!Number.isInteger(rule.minTables) || rule.minTables < 1) return "minTables";
    if (rules.slice(0, i).some((r) => r.minTables === rule.minTables)) return "duplicate";
    if (rule.layoutId !== AUTO_LAYOUT && !layouts.some((l) => l.id === rule.layoutId)) return "target";
  }
  return null;
}

export type TilingProblem = LayoutProblem | RulesProblem | "layoutCount" | "layoutTwice" | "active" | "roomId" | "size";

/** `TilingSettings::validate`'s checks, in its order. */
export function tilingProblem(settings: TilingSettings): TilingProblem | null {
  if (settings.layouts.length > MAX_LAYOUTS) return "layoutCount";
  for (const [i, layout] of settings.layouts.entries()) {
    const found = layoutProblem(layout, false);
    if (found !== null) return found;
    if (settings.layouts.slice(0, i).some((l) => l.id === layout.id)) return "layoutTwice";
  }
  for (const layout of settings.layouts) {
    const found = rulesProblem(layout.autoSwitch, settings.layouts);
    if (found !== null) return found;
  }
  const found = rulesProblem(settings.autoSwitch, settings.layouts);
  if (found !== null) return found;
  if (settings.active.kind === "custom") {
    const id = settings.active.id;
    if (!settings.layouts.some((l) => l.id === id)) return "active";
  }
  const rooms = Object.keys(settings.perRoom);
  if (rooms.length > MAX_ROOMS || rooms.some(badId)) return "roomId";
  if (new TextEncoder().encode(JSON.stringify(settings)).length > MAX_SETTINGS_BYTES) return "size";
  return null;
}

// ---------------------------------------------------------------------
// Saving layouts.

/** `name`, or with " 2", " 3", ... after it when a layout is called that (case ignored); at most {@link MAX_NAME} characters. */
export function uniqueName(layouts: readonly TilingLayout[], name: string): string {
  const taken = new Set(layouts.map((l) => l.name.trim().toLowerCase()));
  const cut = (text: string, room: number) => [...text.trim()].slice(0, room).join("");
  let candidate = cut(name, MAX_NAME);
  for (let k = 2; taken.has(candidate.toLowerCase()) && k < 1000; k += 1) {
    const suffix = ` ${k}`;
    candidate = cut(name, MAX_NAME - suffix.length) + suffix;
  }
  return candidate;
}

/** A fresh layout for the editor (not yet in the settings). */
export function blankLayout(settings: TilingSettings, name: string): TilingLayout {
  return { id: newLayoutId(settings.layouts), name, slots: [], autoSwitch: [] };
}

/** The settings a save gives, or why it cannot be saved. */
export type Saved = { ok: true; settings: TilingSettings } | { ok: false; problem: TilingProblem };

/**
 * The edited `layout` into the settings: over the layout of its id
 * (`overwrite`, keeping that layout's own rules), or as a new layout with a
 * fresh id put in force at once. Refused (with the reason) when the layout
 * or the settings would not validate, or there is no room for another
 * layout.
 */
export function saveLayout(settings: TilingSettings, layout: TilingLayout, overwrite: boolean): Saved {
  const name = [...layout.name.trim()].slice(0, MAX_NAME).join("");
  const own = layoutProblem({ ...layout, name });
  if (own !== null) return { ok: false, problem: own };
  let next: TilingSettings;
  if (overwrite && settings.layouts.some((l) => l.id === layout.id)) {
    next = {
      ...settings,
      layouts: settings.layouts.map((l) => (l.id === layout.id ? { ...layout, name, autoSwitch: l.autoSwitch } : l)),
    };
  } else {
    if (settings.layouts.length >= MAX_LAYOUTS) return { ok: false, problem: "layoutCount" };
    const id = newLayoutId(settings.layouts);
    next = {
      ...settings,
      layouts: [...settings.layouts, { ...layout, id, name, autoSwitch: [] }],
      active: { kind: "custom", id },
    };
  }
  const problem = tilingProblem(next);
  return problem === null ? { ok: true, settings: next } : { ok: false, problem };
}

/** A copy of layout `id` named `name`, its own rules too, put in force (its slots are the same, so nothing moves). */
export function duplicateLayout(settings: TilingSettings, id: string, name: string): Saved | null {
  const layout = settings.layouts.find((l) => l.id === id);
  if (!layout) return null;
  const saved = saveLayout(settings, { ...layout, name }, false);
  if (!saved.ok || layout.autoSwitch.length === 0) return saved;
  const next = saved.settings;
  const copy = next.active.kind === "custom" ? next.active.id : null;
  return {
    ok: true,
    settings: { ...next, layouts: next.layouts.map((l) => (l.id === copy ? { ...l, autoSwitch: [...layout.autoSwitch] } : l)) },
  };
}

// ---------------------------------------------------------------------
// Auto-switch by table count.

/** Where the rules in force come from: the layout in force's own, or the settings' (`Engine::effective`). */
export interface EffectiveRules {
  rules: AutoSwitch[];
  /** The layout in force when its own rules apply (they are not the ones this screen edits). */
  own: TilingLayout | null;
}

export function effectiveRules(settings: TilingSettings): EffectiveRules {
  const active = settings.active.kind === "custom" ? settings.active.id : null;
  const base = active === null ? undefined : settings.layouts.find((l) => l.id === active);
  if (base && base.autoSwitch.length > 0) return { rules: base.autoSwitch, own: base };
  return { rules: settings.autoSwitch, own: null };
}

/** The rule `tables` open tables reach: the one with the largest count at most that (`Engine::effective`). */
export function ruleInForce(rules: readonly AutoSwitch[], tables: number): AutoSwitch | null {
  let best: AutoSwitch | null = null;
  for (const rule of rules) {
    if (rule.minTables <= tables && (best === null || rule.minTables > best.minTables)) best = rule;
  }
  return best;
}

/** Rules by count, lowest first. */
export function sortRules(rules: readonly AutoSwitch[]): AutoSwitch[] {
  return [...rules].sort((a, b) => a.minTables - b.minTables);
}

function withRules(settings: TilingSettings, rules: AutoSwitch[]): TilingSettings {
  return { ...settings, autoSwitch: sortRules(rules) };
}

/** A new rule: two tables past the highest count (4 for the first), to the auto grid. `null` at {@link MAX_RULES}. */
export function addRule(settings: TilingSettings): TilingSettings | null {
  if (settings.autoSwitch.length >= MAX_RULES) return null;
  const highest = settings.autoSwitch.reduce((max, r) => Math.max(max, r.minTables), 2);
  return withRules(settings, [...settings.autoSwitch, { minTables: highest + 2, layoutId: AUTO_LAYOUT }]);
}

/** Rule `index` (of the sorted list) from `minTables` on; the list re-sorted. May leave a duplicate: check with {@link rulesProblem}. */
export function setRuleCount(settings: TilingSettings, index: number, minTables: number): TilingSettings {
  const rules = sortRules(settings.autoSwitch);
  if (!rules[index]) return settings;
  rules[index] = { ...rules[index], minTables: Math.round(minTables) };
  return withRules(settings, rules);
}

export function setRuleLayout(settings: TilingSettings, index: number, layoutId: string): TilingSettings {
  const rules = sortRules(settings.autoSwitch);
  if (!rules[index]) return settings;
  rules[index] = { ...rules[index], layoutId };
  return withRules(settings, rules);
}

export function removeRule(settings: TilingSettings, index: number): TilingSettings {
  return withRules(
    settings,
    sortRules(settings.autoSwitch).filter((_, i) => i !== index),
  );
}

/** Layout `id`'s own rules dropped, so the settings' rules apply to it too. */
export function clearOwnRules(settings: TilingSettings, id: string): TilingSettings {
  return { ...settings, layouts: settings.layouts.map((l) => (l.id === id ? { ...l, autoSwitch: [] } : l)) };
}

/**
 * The Tables screen's logic (T5, docs/research/TABLE-TILING.md §4.5),
 * pure, so `tests/test/appTables.test.ts` runs it:
 *
 * - **The monitors preview**: each display drawn to one scale side by side
 *   ({@link previewLayout}), the tiled tables inside it, stacked tables as
 *   one box with a count ({@link previewTables}).
 * - **The rooms**: which rooms are listed and which fold away
 *   ({@link roomRows}). Whether a room may be tiled is the Rust side's
 *   (`hud_policy`'s `tiling`), never decided here.
 * - **Layouts**: a captured arrangement saved as a user layout, renamed,
 *   deleted (with the rules that pointed at it).
 */
import type {
  HudPolicy,
  HudStatus,
  LayoutRef,
  MonitorInfo,
  RoomPolicy,
  ScreenRect,
  TiledTable,
  TilingLayout,
  TilingSettings,
  TilingSlot,
} from "../../lib/ipc";

// ---------------------------------------------------------------------
// The monitors preview.

/** A display in the preview, pixels of the preview. */
export interface PreviewDisplay {
  monitor: MonitorInfo;
  /** From the preview's left edge. */
  left: number;
  width: number;
  height: number;
  /** The work area inside it (what is left is the taskbar, menu bar or Dock). */
  work: { left: number; top: number; width: number; height: number };
}

export interface PreviewLayout {
  /** Preview pixels per screen pixel, one for every display. */
  scale: number;
  displays: PreviewDisplay[];
  width: number;
  height: number;
}

/**
 * Every display at one scale (so a 4K one looks larger than a 1080p one),
 * side by side in the order layouts name them, bottom-aligned, the whole
 * row at most `maxWidth` wide (gaps of `gap` included) and `maxHeight` tall.
 */
export function previewLayout(monitors: readonly MonitorInfo[], maxWidth: number, maxHeight: number, gap: number): PreviewLayout {
  const shown = [...monitors].filter((m) => m.bounds.width > 0 && m.bounds.height > 0).sort((a, b) => a.index - b.index);
  if (shown.length === 0) return { scale: 0, displays: [], width: 0, height: 0 };
  const totalWidth = shown.reduce((sum, m) => sum + m.bounds.width, 0);
  const tallest = Math.max(...shown.map((m) => m.bounds.height));
  const room = Math.max(1, maxWidth - gap * (shown.length - 1));
  const scale = Math.min(room / totalWidth, maxHeight / tallest);
  let left = 0;
  const displays = shown.map((monitor): PreviewDisplay => {
    const width = monitor.bounds.width * scale;
    const height = monitor.bounds.height * scale;
    const work = place(monitor.workArea, monitor.bounds, scale, width, height);
    const display = { monitor, left, width, height, work };
    left += width + gap;
    return display;
  });
  return { scale, displays, width: left - gap, height: tallest * scale };
}

/** `rect` (screen pixels) inside a display of `bounds`, preview pixels, clipped to the display. */
function place(rect: ScreenRect, bounds: ScreenRect, scale: number, maxW: number, maxH: number) {
  const x0 = clamp((rect.x - bounds.x) * scale, 0, maxW);
  const y0 = clamp((rect.y - bounds.y) * scale, 0, maxH);
  const x1 = clamp((rect.x + rect.width - bounds.x) * scale, 0, maxW);
  const y1 = clamp((rect.y + rect.height - bounds.y) * scale, 0, maxH);
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A box in a display of the preview: one table, or a stack of them. */
export interface PreviewTable {
  /** The table drawn (a stack's first). */
  table: TiledTable;
  /** Tables in it (2 or more: a stack). */
  count: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The tables on one display as boxes: a stacked table whose centre lies in
 * another stacked table's rect joins its box (a stack's tables may differ
 * by a room's aspect ratio). Tables of other displays are left out.
 */
export function previewTables(display: PreviewDisplay, windows: readonly TiledTable[], scale: number): PreviewTable[] {
  const boxes: { table: TiledTable; rect: ScreenRect; count: number }[] = [];
  for (const table of windows) {
    if (table.monitor !== display.monitor.index) continue;
    const stack = table.stacked ? boxes.find((b) => b.table.stacked && holdsCentre(b.rect, table.rect)) : undefined;
    if (stack) {
      stack.count += 1;
    } else {
      boxes.push({ table, rect: table.rect, count: 1 });
    }
  }
  return boxes
    .map((box) => ({
      table: box.table,
      count: box.count,
      ...place(box.rect, display.monitor.bounds, scale, display.width, display.height),
    }))
    .filter((box) => box.width > 0 && box.height > 0);
}

function holdsCentre(outer: ScreenRect, inner: ScreenRect): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return cx >= outer.x && cx < outer.x + outer.width && cy >= outer.y && cy < outer.y + outer.height;
}

/** A display's caption counts: the boxes, and the tables stacked under them. */
export function displayCounts(boxes: readonly PreviewTable[]): { shown: number; stacked: number } {
  return {
    shown: boxes.length,
    stacked: boxes.reduce((sum, box) => sum + box.count - 1, 0),
  };
}

// ---------------------------------------------------------------------
// The rooms.

/** How a room's tiling policy reads on the screen. */
export type RoomVerdict = "allowed" | "notAllowed" | "approval";

export interface RoomRow {
  id: string;
  name: string;
  /** Tiling's verdict. */
  verdict: RoomVerdict;
  /** Its tables open now (the tiled ones, else the HUD's). */
  tables: number;
  /** The user's tiling switch (on unless switched off). */
  on: boolean;
}

/** A room's verdict for tiling (`tool` "tiling") or the RNG ("rng"), as the Rust side decided it. */
export function verdictOf(room: RoomPolicy, tool: "tiling" | "rng" = "tiling"): RoomVerdict {
  const policy = room[tool];
  if (policy.permitted) return "allowed";
  return policy.needsApproval ? "approval" : "notAllowed";
}

/** Whether the user lets tiling move this room's tables (`TilingSettings::room_enabled`). */
export function roomOn(settings: TilingSettings, site: string): boolean {
  return settings.perRoom[site] ?? true;
}

/** The user's switch for a room: on is the default, so it is stored only when off. */
export function setRoomOn(settings: TilingSettings, site: string, on: boolean): TilingSettings {
  const perRoom = { ...settings.perRoom };
  if (on) delete perRoom[site];
  else perRoom[site] = false;
  return { ...settings, perRoom };
}

/**
 * The rooms card: the rooms tiling may move, then
 * the others with a table open now (approval first, then by name); every
 * other room folds into "N more rooms not allowed". Rail's own format and
 * closed clients are not rooms anyone plays: left out.
 */
export function roomRows(
  policy: HudPolicy,
  settings: TilingSettings,
  status: HudStatus | null,
): { shown: RoomRow[]; folded: RoomRow[] } {
  const tiled = new Map<string, number>();
  for (const table of status?.tiling?.windows ?? []) tiled.set(table.site, (tiled.get(table.site) ?? 0) + 1);
  const open = new Map<string, number>();
  for (const table of [...(status?.tables ?? []), ...(status?.refused ?? [])]) {
    open.set(table.site, (open.get(table.site) ?? 0) + 1);
  }
  const rows = policy.rooms
    .filter((room) => room.kind !== "format" && !room.closed)
    .map(
      (room): RoomRow => ({
        id: room.id,
        name: room.name,
        verdict: verdictOf(room),
        tables: tiled.get(room.id) ?? open.get(room.id) ?? 0,
        on: roomOn(settings, room.id),
      }),
    );
  const isAllowed = (row: RoomRow) => row.verdict === "allowed";
  const allowed = rows.filter(isAllowed);
  const rest = rows.filter((row) => !isAllowed(row));
  const withTables = rest
    .filter((row) => row.tables > 0)
    .sort((a, b) => Number(b.verdict === "approval") - Number(a.verdict === "approval") || a.name.localeCompare(b.name));
  return { shown: [...allowed, ...withTables], folded: rest.filter((row) => row.tables === 0) };
}

/** (T7) Whether any room allows the Action Required slot (none yet; an older Rust side says nothing: no). */
export function actionSlotAllowedAnywhere(policy: HudPolicy): boolean {
  return policy.rooms.some((room) => room.actionSlot?.permitted === true);
}

// ---------------------------------------------------------------------
// Layouts.

/** The longest layout name (`MAX_NAME`). */
export const MAX_NAME = 80;
/** Layouts a user keeps at most (`MAX_LAYOUTS`). */
export const MAX_LAYOUTS = 32;

/** The layout in force's id: `auto` for the auto grid. */
export function activeId(active: LayoutRef): string {
  return active.kind === "auto" ? "auto" : active.id;
}

/** An id no layout of `layouts` has (and never `auto`). */
export function newLayoutId(layouts: readonly TilingLayout[]): string {
  const taken = new Set(layouts.map((l) => l.id));
  let n = layouts.length + 1;
  while (taken.has(`layout-${n}`)) n += 1;
  return `layout-${n}`;
}

/** The first of `name(1)`, `name(2)`, ... no layout is called (case ignored). */
export function newLayoutName(layouts: readonly TilingLayout[], name: (n: number) => string): string {
  const taken = new Set(layouts.map((l) => l.name.trim().toLowerCase()));
  let n = layouts.length + 1;
  while (taken.has(name(n).toLowerCase())) n += 1;
  return name(n);
}

/** A layout name as stored: trimmed, at most {@link MAX_NAME} characters; `null` when empty. */
export function cleanName(name: string): string | null {
  const text = [...name.trim()].slice(0, MAX_NAME).join("");
  return text === "" ? null : text;
}

/**
 * The captured slots saved as a new layout, in force at once (the tables
 * are where its slots are, so nothing moves). `null` when there is nothing
 * to save or no room for another layout.
 */
export function addLayout(settings: TilingSettings, slots: readonly TilingSlot[], name: string): TilingSettings | null {
  const clean = cleanName(name);
  if (slots.length === 0 || clean === null || settings.layouts.length >= MAX_LAYOUTS) return null;
  const id = newLayoutId(settings.layouts);
  return {
    ...settings,
    layouts: [...settings.layouts, { id, name: clean, slots: [...slots], autoSwitch: [] }],
    active: { kind: "custom", id },
  };
}

export function renameLayout(settings: TilingSettings, id: string, name: string): TilingSettings {
  const clean = cleanName(name);
  if (clean === null) return settings;
  return { ...settings, layouts: settings.layouts.map((l) => (l.id === id ? { ...l, name: clean } : l)) };
}

/**
 * Layout `id` gone: the auto grid takes over where it was in force, and
 * every auto-switch rule that led to it goes too (else the settings would
 * not validate).
 */
export function deleteLayout(settings: TilingSettings, id: string): TilingSettings {
  const keep = (rules: TilingLayout["autoSwitch"]) => rules.filter((rule) => rule.layoutId !== id);
  return {
    ...settings,
    layouts: settings.layouts.filter((l) => l.id !== id).map((l) => ({ ...l, autoSwitch: keep(l.autoSwitch) })),
    autoSwitch: keep(settings.autoSwitch),
    active: settings.active.kind === "custom" && settings.active.id === id ? { kind: "auto" } : settings.active,
  };
}

export function chooseLayout(settings: TilingSettings, id: string): TilingSettings {
  const active: LayoutRef = id === "auto" ? { kind: "auto" } : { kind: "custom", id };
  return { ...settings, active };
}

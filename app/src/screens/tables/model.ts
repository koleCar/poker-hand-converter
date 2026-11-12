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
 * - **The RNG's bands**: editing that keeps them valid, and the same checks
 *   as `RngSettings::validate` (`rail_hud_ipc::settings`), so the screen
 *   never sends what the app would refuse.
 * - **Layouts**: a captured arrangement saved as a user layout, renamed,
 *   deleted (with the rules that pointed at it).
 */
import type {
  HudPolicy,
  HudStatus,
  LayoutRef,
  MonitorInfo,
  RngBand,
  RngSettings,
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
  /** (T5 follow-up) The RNG's verdict (`hud_policy`'s `rng`). */
  rngVerdict: RoomVerdict;
  /** The user's RNG switch for the room (on unless switched off). */
  rngOn: boolean;
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

/** (T5 follow-up) Whether the user wants the RNG on this room's tables (`RngSettings::room_enabled`). */
export function rngRoomOn(rng: RngSettings, site: string): boolean {
  return rng.perRoom[site] ?? true;
}

/** The user's RNG switch for a room: on is the default, so it is stored only when off. The room's policy still decides first. */
export function setRngRoomOn(rng: RngSettings, site: string, on: boolean): RngSettings {
  const perRoom = { ...rng.perRoom };
  if (on) delete perRoom[site];
  else perRoom[site] = false;
  return { ...rng, perRoom };
}

/**
 * The rooms card: the rooms tiling may move or the RNG may show on, then
 * the others with a table open now (approval first, then by name); every
 * other room folds into "N more rooms not allowed". Rail's own format and
 * closed clients are not rooms anyone plays: left out.
 */
export function roomRows(
  policy: HudPolicy,
  settings: TilingSettings,
  status: HudStatus | null,
  rng: RngSettings | null = null,
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
        rngVerdict: verdictOf(room, "rng"),
        rngOn: rng === null ? true : rngRoomOn(rng, room.id),
      }),
    );
  const isAllowed = (row: RoomRow) => row.verdict === "allowed" || row.rngVerdict === "allowed";
  const allowed = rows.filter(isAllowed);
  const rest = rows.filter((row) => !isAllowed(row));
  const withTables = rest
    .filter((row) => row.tables > 0)
    .sort((a, b) => Number(b.verdict === "approval") - Number(a.verdict === "approval") || a.name.localeCompare(b.name));
  return { shown: [...allowed, ...withTables], folded: rest.filter((row) => row.tables === 0) };
}

/** Whether any room allows the RNG (else its switch is off and says why). */
export function rngAllowedAnywhere(policy: HudPolicy): boolean {
  return policy.rooms.some((room) => room.rng.permitted);
}

/** (T7) Whether any room allows the Action Required slot (none yet; an older Rust side says nothing: no). */
export function actionSlotAllowedAnywhere(policy: HudPolicy): boolean {
  return policy.rooms.some((room) => room.actionSlot?.permitted === true);
}

// ---------------------------------------------------------------------
// The RNG's bands (`rail_hud_ipc::settings::RngSettings`).

/** The RNG's largest number (`RNG_LIMIT`). */
export const RNG_LIMIT = 10_000;
/** Colour bands at most (`MAX_BANDS`). */
export const MAX_BANDS = 10;
/** The longest band label, characters (`MAX_LABEL`). */
export const MAX_LABEL = 24;
/** The longest timer, seconds (`MAX_TIMER_SECS`). */
export const MAX_TIMER_SECS = 3600;
/** The timer a fresh "Every N s" starts with. */
export const DEFAULT_TIMER_SECS = 10;
/** (T5 follow-up) The widget's size, percent (`RNG_SCALE_MIN` - `RNG_SCALE_MAX`). */
export const RNG_SCALE_MIN = 50;
export const RNG_SCALE_MAX = 200;
/** Its opacity, percent (`RNG_OPACITY_MIN` - `RNG_OPACITY_MAX`). */
export const RNG_OPACITY_MIN = 30;
export const RNG_OPACITY_MAX = 100;
/** Both, when the settings have neither (`RNG_DEFAULT_PCT`). */
export const RNG_DEFAULT_PCT = 100;

/** The widget's size, percent: the stored one (100 when an older build stored none). */
export function rngScale(rng: RngSettings): number {
  return rng.scale ?? RNG_DEFAULT_PCT;
}

/** The widget's opacity, percent (100 when none is stored). */
export function rngOpacity(rng: RngSettings): number {
  return rng.opacity ?? RNG_DEFAULT_PCT;
}

/** The widget's size set to `pct`, a whole percent kept within 50 - 200. */
export function setRngScale(rng: RngSettings, pct: number): RngSettings {
  if (!Number.isFinite(pct)) return rng;
  return { ...rng, scale: clamp(Math.round(pct), RNG_SCALE_MIN, RNG_SCALE_MAX) };
}

/** The widget's opacity set to `pct`, a whole percent kept within 30 - 100. */
export function setRngOpacity(rng: RngSettings, pct: number): RngSettings {
  if (!Number.isFinite(pct)) return rng;
  return { ...rng, opacity: clamp(Math.round(pct), RNG_OPACITY_MIN, RNG_OPACITY_MAX) };
}

/** A new band's colour: the next of these not in use (neutral, as the defaults). */
const BAND_COLOURS = ["#5c6370", "#8b929e", "#c5cad3", "#3e7cb1", "#5aa469", "#d1a03f", "#c0504d", "#8e6bbf", "#4fa3a5", "#e8eef6"];

/** A band as drawn: the numbers it covers. */
export interface BandSpan {
  from: number;
  to: number;
  colour: string;
  label: string | null;
}

/** Each band's first and last number (from the band before's end, or the range's start). */
export function bandSpans(rng: RngSettings): BandSpan[] {
  let from = rng.min;
  return rng.bands.map((band) => {
    const span = { from, to: band.upTo, colour: band.colour, label: band.label ?? null };
    from = band.upTo + 1;
    return span;
  });
}

/** A band's share of the bar, 0 - 1. */
export function bandShare(span: BandSpan, rng: RngSettings): number {
  const total = rng.max - rng.min + 1;
  return total > 0 ? (span.to - span.from + 1) / total : 0;
}

function withBands(rng: RngSettings, bands: RngBand[]): RngSettings {
  return { ...rng, bands };
}

/**
 * Band `index` ends at `upTo`, kept inside its neighbours (one number at
 * least each); the last band always ends at the range's end.
 */
export function setBandEnd(rng: RngSettings, index: number, upTo: number): RngSettings {
  if (index < 0 || index >= rng.bands.length - 1 || !Number.isFinite(upTo)) return rng;
  const low = index === 0 ? rng.min : rng.bands[index - 1].upTo + 1;
  const high = rng.bands[index + 1].upTo - 1;
  const end = clamp(Math.round(upTo), low, high);
  return withBands(
    rng,
    rng.bands.map((band, i) => (i === index ? { ...band, upTo: end } : band)),
  );
}

/** Band `index` split in two at its middle (when it has two numbers and there is room for a band). */
export function splitBand(rng: RngSettings, index: number): RngSettings {
  const spans = bandSpans(rng);
  const span = spans[index];
  if (!span || span.to <= span.from || rng.bands.length >= MAX_BANDS) return rng;
  const used = new Set(rng.bands.map((b) => b.colour.toLowerCase()));
  const colour = BAND_COLOURS.find((c) => !used.has(c)) ?? BAND_COLOURS[0];
  const middle = Math.floor((span.from + span.to) / 2);
  const bands = [...rng.bands];
  bands.splice(index, 0, { upTo: middle, colour });
  return withBands(rng, bands);
}

/** Band `index` gone, its numbers to the band after it (the last band's to the one before). */
export function removeBand(rng: RngSettings, index: number): RngSettings {
  if (rng.bands.length <= 1 || index < 0 || index >= rng.bands.length) return rng;
  const bands = rng.bands.filter((_, i) => i !== index);
  if (index === rng.bands.length - 1) bands[bands.length - 1] = { ...bands[bands.length - 1], upTo: rng.max };
  return withBands(rng, bands);
}

/** Band `index`'s label: trimmed, at most {@link MAX_LABEL} characters; empty is none. */
export function setBandLabel(rng: RngSettings, index: number, label: string): RngSettings {
  const text = [...label.trim()].slice(0, MAX_LABEL).join("");
  return withBands(
    rng,
    rng.bands.map((band, i) => {
      if (i !== index) return band;
      const next = { ...band };
      if (text === "") delete next.label;
      else next.label = text;
      return next;
    }),
  );
}

export function setBandColour(rng: RngSettings, index: number, colour: string): RngSettings {
  if (!isHexColour(colour)) return rng;
  return withBands(
    rng,
    rng.bands.map((band, i) => (i === index ? { ...band, colour: colour.toLowerCase() } : band)),
  );
}

/** The timer on (`secs`) or off (`null`), within 1 s - 1 h. */
export function setTimer(rng: RngSettings, secs: number | null): RngSettings {
  const triggers = { ...rng.triggers };
  if (secs === null) delete triggers.timerSecs;
  else triggers.timerSecs = clamp(Math.round(secs), 1, MAX_TIMER_SECS);
  return { ...rng, triggers };
}

export function isHexColour(text: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(text);
}

/** Why `RngSettings::validate` would refuse it (one of these), or `null`. */
export type RngProblem = "range" | "bandCount" | "outside" | "order" | "colour" | "label" | "lastEnd" | "timer" | "scale" | "opacity";

/** `RngSettings::validate`'s checks, in its order (the rooms' ids and the size are the app's to check). */
export function rngProblem(rng: RngSettings): RngProblem | null {
  if (rng.max > RNG_LIMIT || rng.max < rng.min) return "range";
  if (rng.bands.length === 0 || rng.bands.length > MAX_BANDS) return "bandCount";
  let floor: number | null = null;
  for (const band of rng.bands) {
    if (band.upTo < rng.min || band.upTo > rng.max) return "outside";
    if (floor !== null && band.upTo <= floor) return "order";
    floor = band.upTo;
    if (!isHexColour(band.colour)) return "colour";
    const label = band.label;
    if (label !== undefined && label !== null && (label.trim() === "" || [...label].length > MAX_LABEL)) return "label";
  }
  if (floor !== rng.max) return "lastEnd";
  const secs = rng.triggers.timerSecs;
  if (secs !== undefined && secs !== null && !(secs >= 1 && secs <= MAX_TIMER_SECS)) return "timer";
  const scale = rngScale(rng);
  if (!Number.isInteger(scale) || scale < RNG_SCALE_MIN || scale > RNG_SCALE_MAX) return "scale";
  const opacity = rngOpacity(rng);
  if (!Number.isInteger(opacity) || opacity < RNG_OPACITY_MIN || opacity > RNG_OPACITY_MAX) return "opacity";
  return null;
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

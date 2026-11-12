/**
 * (T5 follow-up) The slot editor, in place of the displays while it is
 * open: one display's work area drawn to its shape (the HUD's monitors,
 * `tiling_status`), its slots numbered in fill order.
 *
 * - Drag on an empty spot to draw a slot; drag a slot to move it, its
 *   handles to resize it. "Snap" pulls edges onto a 1/24 grid and the
 *   other slots' edges.
 * - Keyboard: Tab reaches each slot; arrows move it, Shift + arrows resize
 *   it, Delete removes it, Escape lets it go. "+ Slot" adds one without a
 *   pointer.
 * - The selected slot: earlier / later in the fill order, "Stack", the
 *   rooms it takes, and (T7) "Action Required": a table moves there while
 *   its room's client signals your turn - greyed with the reason while no
 *   room allows it (`hud_policy`'s `actionSlot`), which is every room
 *   today. An action slot is drawn dashed and never stacks.
 * - Save over the layout, or as a new one (put in force at once). Every
 *   save is checked as `TilingSettings::validate` checks it.
 *
 * The geometry is `./slots` (whole thousandths of the work area, as
 * `SlotRect` stores them).
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { PillSwitch } from "../../components/ScreenHeader";
import { useT } from "../../i18n";
import type { HudPolicy, HudStatus, SlotRect, TilingLayout, TilingSettings } from "../../lib/ipc";
import { PopoverButton } from "../hud/popovers";
import { useWidth } from "./Monitors";
import { MAX_NAME, actionSlotAllowedAnywhere } from "./model";
import {
  HANDLES,
  MAX_SLOTS,
  addSlot,
  deltaPermille,
  drawRect,
  editorMonitors,
  fitArea,
  freeSpot,
  isArrow,
  makeSlot,
  moveRect,
  nudgeRect,
  removeSlot,
  reorderSlot,
  resizeRect,
  saveLayout,
  setSlotRooms,
  snapTargets,
  toPermille,
  toPixels,
  updateSlot,
  type Handle,
  type Point,
} from "./slots";
import styles from "./Tables.module.css";

/** The tallest the work area is drawn, and the section's padding both sides. */
const MAX_HEIGHT = 320;
const PADDING = 44;

/** What the editor opens on: a layout of the settings (`existing`) or a new one. */
export interface EditorTarget {
  layout: TilingLayout;
  existing: boolean;
}

type Drag =
  | { kind: "draw"; start: Point }
  | { kind: "move"; id: string; origin: SlotRect; x0: number; y0: number }
  | { kind: "resize"; id: string; handle: Handle; origin: SlotRect; x0: number; y0: number };

export function SlotEditor({
  settings,
  status,
  policy,
  target,
  onSave,
  onClose,
}: {
  settings: TilingSettings;
  status: HudStatus | null;
  policy: HudPolicy;
  target: EditorTarget;
  onSave: (next: TilingSettings) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useT().tables;
  const s = t.editor;
  const [layout, setLayout] = useState(target.layout);
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const known = status?.tiling?.monitors ?? [];
  const monitors = editorMonitors(known, layout.slots);
  const [monitorIndex, setMonitorIndex] = useState(() => layout.slots[0]?.monitor ?? monitors[0].index);
  const monitor = monitors.find((m) => m.index === monitorIndex) ?? monitors[0];

  const ref = useRef<HTMLElement>(null);
  const width = useWidth(ref);
  const area = fitArea(monitor.workArea, Math.max(0, width - PADDING), MAX_HEIGHT);

  const change = (next: TilingLayout) => {
    setProblem(null);
    setLayout(next);
  };
  const slot = layout.slots.find((x) => x.id === selected) ?? null;
  const number = slot === null ? 0 : layout.slots.indexOf(slot) + 1;

  const add = () => {
    if (layout.slots.length >= MAX_SLOTS) return;
    const made = makeSlot(layout.slots, monitor.index, freeSpot(layout.slots, monitor.index));
    change(addSlot(layout, made));
    setSelected(made.id);
  };

  const save = (overwrite: boolean) => {
    const saved = saveLayout(settings, layout, overwrite);
    if (!saved.ok) {
      setProblem(s.problem[saved.problem]);
      return;
    }
    setBusy(true);
    void onSave(saved.settings).then((ok) => {
      setBusy(false);
      if (ok) onClose();
    });
  };

  const options = monitors.map((m) => ({ id: String(m.index), label: String(m.index + 1) }));

  return (
    <section ref={ref} className={styles.editor} aria-label={s.label}>
      <div className={styles.editorBar}>
        <input
          className={`${styles.input} ${styles.nameInput}`}
          aria-label={t.layoutName}
          value={layout.name}
          maxLength={MAX_NAME}
          onChange={(e) => change({ ...layout, name: e.target.value })}
        />
        {monitors.length > 1 ? (
          <PillSwitch label={t.displays} options={options} value={String(monitor.index)} onChange={(id) => setMonitorIndex(Number(id))} />
        ) : null}
        <button type="button" className="btn btn--sm" disabled={layout.slots.length >= MAX_SLOTS} onClick={add}>
          {s.addSlot}
        </button>
        <button type="button" className={`chip-btn${snap ? " is-active" : ""}`} aria-pressed={snap} title={s.snapHint} onClick={() => setSnap((on) => !on)}>
          {s.snap}
        </button>
        <span className={styles.spacer} />
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          {s.cancel}
        </button>
        {target.existing ? (
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => save(false)}>
            {s.saveNew}
          </button>
        ) : null}
        <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => save(target.existing)}>
          {s.save}
        </button>
      </div>
      {known.length === 0 ? <p className={styles.hint}>{s.unknownDisplays}</p> : null}
      <Surface
        layout={layout}
        monitor={monitor.index}
        width={area.width}
        height={area.height}
        snap={snap}
        selected={selected}
        onSelect={setSelected}
        onChange={change}
      />
      <p className={styles.caption}>{t.display(monitor.index + 1, monitor.bounds.width, monitor.bounds.height)}</p>
      {slot !== null ? (
        <div className={styles.editorBar}>
          <span className={styles.slotTitle}>{s.slot(number)}</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-label={s.earlier}
            title={s.earlier}
            disabled={number <= 1}
            onClick={() => change(reorderSlot(layout, slot.id, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-label={s.later}
            title={s.later}
            disabled={number >= layout.slots.length}
            onClick={() => change(reorderSlot(layout, slot.id, 1))}
          >
            ›
          </button>
          {slot.kind !== "action" ? (
            <button
              type="button"
              className={`chip-btn${slot.stack ? " is-active" : ""}`}
              aria-pressed={slot.stack}
              title={s.stackHint}
              onClick={() => change(updateSlot(layout, slot.id, { stack: !slot.stack }))}
            >
              {s.stack}
            </button>
          ) : null}
          <ActionToggle
            on={slot.kind === "action"}
            allowed={actionSlotAllowedAnywhere(policy)}
            onChange={(on) => change(updateSlot(layout, slot.id, { kind: on ? "action" : "play" }))}
          />
          <RoomFilter
            policy={policy}
            rooms={slot.rooms ?? []}
            onChange={(rooms) => change(setSlotRooms(layout, slot.id, rooms))}
          />
          <button
            type="button"
            className={`btn btn--sm btn--ghost ${styles.danger}`}
            onClick={() => {
              change(removeSlot(layout, slot.id));
              setSelected(null);
            }}
          >
            {s.removeSlot}
          </button>
        </div>
      ) : (
        <p className={styles.hint}>{s.hint}</p>
      )}
      {problem !== null ? <p className={styles.error}>{problem}</p> : null}
    </section>
  );
}

/** The work area: draw, move, resize; the slots as numbered boxes. */
function Surface({
  layout,
  monitor,
  width,
  height,
  snap,
  selected,
  onSelect,
  onChange,
}: {
  layout: TilingLayout;
  monitor: number;
  width: number;
  height: number;
  snap: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: TilingLayout) => void;
}) {
  const s = useT().tables.editor;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<SlotRect | null>(null);

  const box = () => ref.current?.getBoundingClientRect() ?? null;
  const pointAt = (event: PointerEvent): Point | null => {
    const b = box();
    if (b === null) return null;
    return { x: toPermille(event.clientX - b.left, b.width), y: toPermille(event.clientY - b.top, b.height) };
  };
  const targets = (except: string | null) => snapTargets(layout.slots, monitor, except, snap);

  /** The drag's result for the pointer at `event`. */
  const follow = (event: PointerEvent): { draw: SlotRect | null } | null => {
    const d = drag.current;
    const b = box();
    if (d === null || b === null) return null;
    if (d.kind === "draw") {
      const p = pointAt(event);
      return { draw: p === null ? null : drawRect(d.start, p, targets(null)) };
    }
    const dx = deltaPermille(event.clientX - d.x0, b.width);
    const dy = deltaPermille(event.clientY - d.y0, b.height);
    const rect = d.kind === "move" ? moveRect(d.origin, dx, dy, targets(d.id)) : resizeRect(d.origin, d.handle, dx, dy, targets(d.id));
    onChange(updateSlot(layout, d.id, { rect }));
    return { draw: null };
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = event.target as HTMLElement;
    const handle = element.closest<HTMLElement>("[data-handle]");
    const slotElement = element.closest<HTMLElement>("[data-slot]");
    const id = slotElement?.dataset.slot ?? null;
    const slot = id === null ? undefined : layout.slots.find((x) => x.id === id);
    event.preventDefault();
    ref.current?.setPointerCapture(event.pointerId);
    if (slot) {
      onSelect(slot.id);
      slotElement?.focus();
      const h = handle?.dataset.handle as Handle | undefined;
      drag.current =
        h !== undefined
          ? { kind: "resize", id: slot.id, handle: h, origin: slot.rect, x0: event.clientX, y0: event.clientY }
          : { kind: "move", id: slot.id, origin: slot.rect, x0: event.clientX, y0: event.clientY };
      return;
    }
    const start = pointAt(event);
    if (start === null) return;
    // The slot let go of: no longer the keys' either.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur();
    onSelect(null);
    drag.current = { kind: "draw", start };
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const result = follow(event);
    if (result !== null && drag.current?.kind === "draw") setGhost(result.draw);
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const result = follow(event);
    drag.current = null;
    setGhost(null);
    if (d?.kind === "draw" && result?.draw && layout.slots.length < MAX_SLOTS) {
      const made = makeSlot(layout.slots, monitor, result.draw);
      onChange(addSlot(layout, made));
      onSelect(made.id);
    }
  };

  const cancel = () => {
    drag.current = null;
    setGhost(null);
  };

  const key = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    const slot = layout.slots.find((x) => x.id === id);
    if (!slot) return;
    if (isArrow(event.key)) {
      event.preventDefault();
      onChange(updateSlot(layout, id, { rect: nudgeRect(slot.rect, event.key, event.shiftKey, snap) }));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onChange(removeSlot(layout, id));
      onSelect(null);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onSelect(null);
      event.currentTarget.blur();
    }
  };

  const pct = (v: number) => Math.round(v / 10);
  return (
    <div
      ref={ref}
      className={styles.surface}
      data-snap={snap}
      style={{ width, height, "--grid-x": `${width / 24}px`, "--grid-y": `${height / 24}px` } as CSSProperties}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
    >
      {layout.slots.map((slot, index) => {
        if (slot.monitor !== monitor) return null;
        const px = toPixels(slot.rect, width, height);
        const on = slot.id === selected;
        const r = slot.rect;
        return (
          <div
            key={slot.id}
            data-slot={slot.id}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={s.slotLabel(index + 1, pct(r.x), pct(r.y), pct(r.width), pct(r.height))}
            className={styles.slot}
            data-selected={on}
            data-kind={slot.kind}
            style={{ left: px.left, top: px.top, width: px.width, height: px.height }}
            onFocus={() => onSelect(slot.id)}
            onKeyDown={(event) => key(event, slot.id)}
          >
            <span className={styles.slotNumber}>{index + 1}</span>
            {slot.stack && slot.kind !== "action" ? (
              <span className={styles.slotStack} aria-hidden="true">
                ⧉
              </span>
            ) : null}
            {on
              ? HANDLES.map((h) => <span key={h} data-handle={h} data-pos={h} className={styles.handle} aria-hidden="true" />)
              : null}
          </div>
        );
      })}
      {ghost !== null ? <span className={styles.ghost} style={toPixels(ghost, width, height)} aria-hidden="true" /> : null}
    </div>
  );
}

/**
 * (T7) The selected slot as an Action Required slot, or not. Greyed with
 * the reason while no room allows it; a slot that is one already can be
 * switched back.
 */
function ActionToggle({ on, allowed, onChange }: { on: boolean; allowed: boolean; onChange: (on: boolean) => void }) {
  const s = useT().tables.editor;
  const disabled = !allowed && !on;
  return (
    <>
      <button
        type="button"
        className={`chip-btn${on ? " is-active" : ""}`}
        aria-pressed={on}
        disabled={disabled}
        title={allowed ? s.actionHint : s.actionNotAllowed}
        onClick={() => onChange(!on)}
      >
        {s.action}
      </button>
      {disabled ? <span className={styles.warn}>{s.actionNotAllowed}</span> : null}
    </>
  );
}

/** The rooms a slot takes: none checked is any. Rooms tiling may move, and any the slot already names. */
function RoomFilter({ policy, rooms, onChange }: { policy: HudPolicy; rooms: readonly string[]; onChange: (rooms: string[]) => void }) {
  const s = useT().tables.editor;
  const listed = policy.rooms.filter((room) => room.kind !== "format" && (room.tiling.permitted || rooms.includes(room.id)));
  return (
    <PopoverButton
      label={s.rooms}
      content={rooms.length === 0 ? s.anyRoom : s.someRooms(rooms.length)}
      className="btn btn--sm btn--ghost"
      align="start"
      popoverClassName={styles.popover}
    >
      {() => (
        <div className={styles.form} role="group" aria-label={s.rooms}>
          {listed.map((room) => (
            <label key={room.id} className={styles.check}>
              <input
                type="checkbox"
                checked={rooms.includes(room.id)}
                onChange={(e) => onChange(e.target.checked ? [...rooms, room.id] : rooms.filter((r) => r !== room.id))}
              />
              <span>{room.name}</span>
            </label>
          ))}
        </div>
      )}
    </PopoverButton>
  );
}

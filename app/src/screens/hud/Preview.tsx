/**
 * The HUD editor's preview (R3.9): the design on a table of the room and
 * size picked - made-up players and numbers, the user's dragged panels of
 * that room and size - painted from the HUD renderer's own scene
 * (`hud_preview`: `rail_hud::scene::compose` under the room's permit), so
 * the room's rules cut it down exactly as at a real table.
 *
 * A panel is dragged to where the user wants it: its centre is kept for
 * the room and table size (`hud_set_seat_position`, the row a drag at a
 * real table writes, R3.6), so the HUD puts it there at every such table.
 * "Put panels back" forgets them (R3.6's reset). The keyboard moves a
 * focused panel with the arrows (Shift: further). A click on a number (a
 * press that does not move the panel), or Enter on a focused panel, opens
 * that statistic's settings by it (`CellSettings`).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useLocale, useT } from "../../i18n";
import {
  errorText,
  inApp,
  ipc,
  type HudDesign,
  type HudEditorState,
  type HudPreview,
  type PreviewItem,
  type PreviewRect,
} from "../../lib/ipc";
import { problemText, statLabel } from "./problems";
import styles from "./HudEditor.module.css";

/** The table sizes offered: heads-up, 6-max, 9-max. */
const SIZES = [2, 6, 9];
/** How long edits pause before the preview is drawn again. */
const PREVIEW_DEBOUNCE_MS = 150;
/** An arrow key moves a panel this many pixels of the preview (Shift: four times). */
const KEY_STEP_PX = 6;

const rgba = ([r, g, b, a]: [number, number, number, number]) => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
const inside = (item: PreviewRect, panel: PreviewRect) => {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  return cx >= panel.x && cx <= panel.x + panel.w && cy >= panel.y && cy <= panel.y + panel.h;
};

interface Offset {
  dx: number;
  dy: number;
}

export function Preview({
  design,
  state,
  room,
  size,
  selected,
  onRoom,
  onSize,
  onOpenCell,
  onChanged,
  announce,
}: {
  design: HudDesign;
  state: HudEditorState;
  room: string;
  size: number;
  /** The statistic whose settings are open (its numbers are outlined). */
  selected: string | null;
  onRoom: (room: string) => void;
  onSize: (size: number) => void;
  onOpenCell: (stat: string, anchor: Element) => void;
  /** The store changed (a panel moved, a reset): read the state again. */
  onChanged: () => void;
  announce: (message: string) => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const [preview, setPreview] = useState<HudPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Panels moved here, until the preview drawn after the move comes back. */
  const [moved, setMoved] = useState<Record<number, Offset>>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const start = useRef<{ slot: number; x: number; y: number; pointer: number } | null>(null);
  /** The dragged panel's latest offset (the state may not have rendered yet on release). */
  const last = useRef<Offset | null>(null);
  const label = statLabel(state.stats, locale);
  const roomName = state.rooms.find((r) => r.id === room)?.name ?? room;
  const dragged = state.positions.find((p) => p.site === room && p.size === size)?.panels ?? 0;

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    const timer = window.setTimeout(() => {
      ipc
        .hudPreview(design, room, size)
        .then((value) => {
          if (!live) return;
          setPreview(value);
          setMoved({});
          setError(null);
        })
        .catch((reason: unknown) => {
          if (live) setError(errorText(reason));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [design, room, size, state]);

  /** The pointer in the preview's own pixels. */
  const point = (event: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    if (!svg.current || !matrix) return { x: event.clientX, y: event.clientY };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  };

  /** Keep where panel `slot` now is: its centre in thousandths of the table. */
  const keep = (slot: number, rect: PreviewRect, offset: Offset) => {
    if (!preview) return;
    const clamp = (v: number) => Math.round(Math.min(1000, Math.max(0, v)));
    const x = clamp(((rect.x + offset.dx + rect.w / 2) / preview.width) * 1000);
    const y = clamp(((rect.y + offset.dy + rect.h / 2) / preview.height) * 1000);
    ipc
      .hudSetSeatPosition(room, preview.size, slot, x, y)
      .then(() => {
        announce(h.panelMoved(slot + 1));
        onChanged();
      })
      .catch((reason: unknown) => {
        setMoved((all) => {
          const next = { ...all };
          delete next[slot];
          return next;
        });
        setNotice(errorText(reason));
      });
  };

  const onDown = (event: PointerEvent<SVGGElement>, slot: number) => {
    if (event.button !== 0) return;
    const p = point(event);
    const before = moved[slot] ?? { dx: 0, dy: 0 };
    start.current = { slot, x: p.x - before.dx, y: p.y - before.dy, pointer: event.pointerId };
    last.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(slot);
  };
  const onMove = (event: PointerEvent<SVGGElement>, rect: PreviewRect) => {
    const s = start.current;
    if (!s || s.pointer !== event.pointerId || !preview) return;
    const p = point(event);
    const dx = Math.min(Math.max(p.x - s.x, -rect.x), preview.width - rect.x - rect.w);
    const dy = Math.min(Math.max(p.y - s.y, -rect.y), preview.height - rect.y - rect.h);
    last.current = { dx, dy };
    setMoved((all) => ({ ...all, [s.slot]: { dx, dy } }));
  };
  const onUp = (event: PointerEvent<SVGGElement>, rect: PreviewRect) => {
    const s = start.current;
    if (!s || s.pointer !== event.pointerId) return;
    start.current = null;
    setDragging(null);
    const offset = last.current;
    last.current = null;
    if (offset && (Math.abs(offset.dx) > 1 || Math.abs(offset.dy) > 1)) {
      keep(s.slot, rect, offset);
      return;
    }
    // A press that did not move: the number under it opens its settings.
    if (event.type !== "pointerup") return;
    const hit = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el instanceof SVGElement && el.dataset.stat !== undefined);
    if (hit instanceof SVGElement && hit.dataset.stat) onOpenCell(hit.dataset.stat, hit);
  };
  const onKey = (event: KeyboardEvent<SVGGElement>, slot: number, rect: PreviewRect) => {
    if (event.key === "Enter") {
      const first = event.currentTarget.querySelector<SVGElement>("[data-stat]");
      if (first?.dataset.stat) {
        event.preventDefault();
        onOpenCell(first.dataset.stat, first);
      }
      return;
    }
    const step = KEY_STEP_PX * (event.shiftKey ? 4 : 1);
    const delta: Record<string, Offset> = {
      ArrowLeft: { dx: -step, dy: 0 },
      ArrowRight: { dx: step, dy: 0 },
      ArrowUp: { dx: 0, dy: -step },
      ArrowDown: { dx: 0, dy: step },
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    const before = moved[slot] ?? { dx: 0, dy: 0 };
    const next = { dx: before.dx + d.dx, dy: before.dy + d.dy };
    setMoved((all) => ({ ...all, [slot]: next }));
    keep(slot, rect, next);
  };

  // Each painted item goes with the panel it is drawn on; the rest stays put.
  const owner = (item: PreviewItem) => preview?.panels.find((panel) => inside(item.rect, panel.rect))?.slot ?? null;
  const loose = preview?.items.filter((item) => owner(item) === null) ?? [];

  return (
    <div className={styles.preview}>
      <div className={styles.previewBar}>
        <div className={styles.pills} role="radiogroup" aria-label={h.room}>
          {state.rooms.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={r.id === room}
              className={`chip-btn${r.id === room ? " is-active" : ""}`}
              onClick={() => onRoom(r.id)}
            >
              {r.name}
            </button>
          ))}
        </div>
        <div className={styles.pills} role="radiogroup" aria-label={h.seats}>
          {SIZES.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === size}
              className={`chip-btn${n === size ? " is-active" : ""}`}
              onClick={() => onSize(n)}
            >
              {h.sizeShort(n)}
            </button>
          ))}
        </div>
        {dragged > 0 ? (
          <button
            type="button"
            className={`btn btn--ghost ${styles.barEnd}`}
            title={h.dragged(dragged)}
            onClick={() => {
              ipc
                .hudResetSeatPositions(room, size)
                .then((gone) => {
                  announce(h.resetDone(gone));
                  onChanged();
                })
                .catch((reason: unknown) => setNotice(errorText(reason)));
            }}
          >
            {h.resetDragged}
          </button>
        ) : null}
      </div>
      {error ? <p className={styles.error}>{h.previewFailed(error)}</p> : null}
      {preview ? (
        <div className={styles.tableWrap}>
          <svg
            ref={svg}
            className={styles.table}
            viewBox={`0 0 ${preview.width} ${preview.height}`}
            role="group"
            aria-label={h.previewLabel(roomName, h.seatsN(preview.size))}
          >
            <rect x={0} y={0} width={preview.width} height={preview.height} className={styles.tableBack} />
            <ellipse
              cx={preview.width / 2}
              cy={preview.height * 0.45}
              rx={preview.width * 0.42}
              ry={preview.height * 0.33}
              className={styles.felt}
            />
            <rect
              x={preview.board.x}
              y={preview.board.y}
              width={preview.board.w}
              height={preview.board.h}
              rx={6}
              className={styles.board}
            />
            {preview.plates.map((plate, slot) => (
              <g key={slot}>
                <rect
                  x={plate.x}
                  y={plate.y}
                  width={plate.w}
                  height={plate.h}
                  rx={8}
                  className={slot === preview.heroSlot ? `${styles.plate} ${styles.plateHero}` : styles.plate}
                />
                <text
                  x={plate.x + plate.w / 2}
                  y={plate.y + plate.h / 2}
                  className={styles.plateText}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {slot === preview.heroSlot
                    ? h.you
                    : h.stackBb(preview.panels.find((panel) => panel.slot === slot)?.stackBb ?? 0)}
                </text>
              </g>
            ))}
            {loose.map((item, index) => (
              <Painted key={`loose-${index}`} item={item} />
            ))}
            {preview.panels.map((panel) => {
              const offset = moved[panel.slot] ?? { dx: 0, dy: 0 };
              const items = preview.items.filter((item) => owner(item) === panel.slot);
              return (
                <g
                  key={panel.slot}
                  className={dragging === panel.slot ? `${styles.panelGroup} ${styles.panelGroupDragging}` : styles.panelGroup}
                  transform={`translate(${offset.dx} ${offset.dy})`}
                  tabIndex={0}
                  role="button"
                  aria-label={h.panelAt(panel.slot + 1)}
                  onPointerDown={(event) => onDown(event, panel.slot)}
                  onPointerMove={(event) => onMove(event, panel.rect)}
                  onPointerUp={(event) => onUp(event, panel.rect)}
                  onPointerCancel={(event) => onUp(event, panel.rect)}
                  onKeyDown={(event) => onKey(event, panel.slot, panel.rect)}
                >
                  {items.map((item, index) => (
                    <Painted key={index} item={item} />
                  ))}
                  {panel.cells.map((cell) => (
                    <rect
                      key={cell.stat}
                      data-stat={cell.stat}
                      x={cell.rect.x}
                      y={cell.rect.y}
                      width={cell.rect.w}
                      height={cell.rect.h}
                      rx={3}
                      className={cell.stat === selected ? `${styles.cellHit} ${styles.cellHitOn}` : styles.cellHit}
                    />
                  ))}
                  <rect
                    x={panel.rect.x - 3}
                    y={panel.rect.y - 3}
                    width={panel.rect.w + 6}
                    height={panel.rect.h + 6}
                    rx={7}
                    className={panel.placedByUser ? `${styles.panelHandle} ${styles.panelPlaced}` : styles.panelHandle}
                  />
                </g>
              );
            })}
          </svg>
        </div>
      ) : null}
      {preview && preview.problems.length > 0 ? (
        <div
          className={preview.problems.every((p) => p.code === "labels") ? styles.noteBox : styles.refusedBox}
          aria-live="polite"
        >
          <p>
            {preview.problems.every((p) => p.code === "labels") ? h.roomNotes(roomName) : h.roomRefused(roomName)}{" "}
            {preview.problems.map((problem) => problemText(problem, h.problems, label)).join("; ")}
          </p>
        </div>
      ) : null}
      {notice ? (
        <p className={styles.hint} role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** One item of the HUD's scene. */
function Painted({ item }: { item: PreviewItem }) {
  if (item.kind === "fill") {
    return (
      <rect
        x={item.rect.x}
        y={item.rect.y}
        width={item.rect.w}
        height={item.rect.h}
        rx={item.radius}
        style={{ fill: rgba(item.color) }}
      />
    );
  }
  return (
    <text
      x={item.rect.x + item.rect.w / 2}
      y={item.rect.y + item.rect.h / 2}
      textAnchor="middle"
      dominantBaseline="central"
      style={{ fill: rgba(item.color), fontSize: item.px, fontWeight: item.bold ? 700 : 400 }}
    >
      {item.text}
    </text>
  );
}

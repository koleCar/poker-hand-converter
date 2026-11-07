/**
 * The HUD editor's panel (R3.9): the panel's grid as the HUD draws it -
 * `rows` x `columns` slots, a statistic or empty each (an empty slot is
 * blank space at the table) - and the panel's options beside it.
 *
 * The grid is sized by dragging its right edge (a column more or fewer),
 * its bottom edge (a row) or its corner (both); it shrinks only while the
 * last row or column is empty. Statistics come from the library
 * (`StatLibrary`): dropped on a slot they go there (the one already there
 * moves to the first empty slot), dropped just past the right or bottom
 * edge they add a column or a row; a cell dragged onto another slot swaps
 * with it. A click on a cell opens its settings by it (`CellSettings`).
 *
 * The keyboard does the same without a mouse: the edges and the corner are
 * focusable and take the arrow keys; a statistic in the library is added to
 * the first empty slot with Enter; a focused cell moves with Alt+arrows and
 * goes with Delete. Every change is announced (`announce`).
 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useLocale, useT } from "../../i18n";
import type { HudDesign, HudEditorState } from "../../lib/ipc";
import { Toggle } from "../settings/Toggle";
import { useDrag, useDropZone, type DragItem } from "./drag";
import { minSize, placeOf, resize, roomFor, slotOfStat, slots, statCount, withSlot } from "./grid";
import styles from "./HudEditor.module.css";

export const PANEL_ZONE = "panel";

type Words = ReturnType<typeof useT>["hudEditor"];
type Limits = HudEditorState["limits"];

/** The panel's edits, shared with the library (which adds to it) and the cell's settings (Remove). */
export function panelActions(
  design: HudDesign,
  limits: Limits,
  label: (id: string) => string,
  onChange: (next: HudDesign) => void,
  announce: (message: string) => void,
  words: Words,
) {
  const onPanel = (id: string) => slotOfStat(design, id) >= 0;
  const full = statCount(design) >= limits.maxCells;
  const said = (next: HudDesign, slot: number) => {
    const { row, col } = placeOf(next, slot);
    return [row + 1, col + 1] as const;
  };
  /** `design` made big enough for row `row`, column `col` (`null`: past the limits). */
  const reach = (row: number, col: number): HudDesign | null => {
    if (row >= limits.maxRows || col >= limits.maxColumns) return null;
    if (row < design.rows && col < design.columns) return { ...design, cells: slots(design) };
    return resize(design, Math.max(design.rows, row + 1), Math.max(design.columns, col + 1));
  };
  const refuseNew = (stat: string) => {
    if (onPanel(stat)) return true;
    if (full) {
      announce(words.full(limits.maxCells));
      return true;
    }
    return false;
  };

  /** Into the first empty slot (the grid grows when there is none). */
  const add = (stat: string) => {
    if (refuseNew(stat)) return;
    const room = roomFor(design, limits);
    if (!room) {
      announce(words.noRoom);
      return;
    }
    const next = withSlot(room.design, room.slot, { stat });
    onChange(next);
    announce(words.announceAdded(label(stat), ...said(next, room.slot)));
  };
  /** Into the slot at `row`, `col`; the statistic there moves to the first empty slot. */
  const placeAt = (stat: string, row: number, col: number) => {
    if (refuseNew(stat)) return;
    const grown = reach(row, col);
    if (!grown) return;
    const slot = row * grown.columns + col;
    const occupant = grown.cells[slot] ?? null;
    let next = withSlot(grown, slot, { stat });
    if (occupant) {
      const room = roomFor(next, limits);
      if (!room) {
        announce(words.noRoom);
        return;
      }
      next = withSlot(room.design, room.slot, occupant);
    }
    onChange(next);
    announce(words.announceAdded(label(stat), row + 1, col + 1));
  };
  /** The cell in slot `from` to `row`, `col`, swapping with what is there. */
  const moveTo = (from: number, row: number, col: number) => {
    const moving = design.cells[from];
    if (!moving) return;
    const grown = reach(row, col);
    if (!grown || row < 0 || col < 0) return;
    const was = placeOf(design, from);
    const fromSlot = was.row * grown.columns + was.col;
    const to = row * grown.columns + col;
    if (fromSlot === to) return;
    const cells = slots(grown);
    cells[fromSlot] = cells[to] ?? null;
    cells[to] = moving;
    onChange({ ...grown, cells });
    announce(words.announceMoved(label(moving.stat), row + 1, col + 1));
  };
  const remove = (stat: string) => {
    const slot = slotOfStat(design, stat);
    if (slot < 0) return;
    const overrides = { ...(design.overrides ?? {}) };
    delete overrides[stat];
    onChange({ ...withSlot(design, slot, null), overrides });
    announce(words.announceRemoved(label(stat)));
  };
  return { onPanel, full, add, placeAt, moveTo, remove };
}

type Actions = ReturnType<typeof panelActions>;
type Edge = "columns" | "rows" | "both";

export function PanelEditor({
  design,
  state,
  selected,
  label,
  actions,
  onOpenCell,
  onChange,
  announce,
}: {
  design: HudDesign;
  state: HudEditorState;
  /** The statistic whose settings are open. */
  selected: string | null;
  label: (id: string) => string;
  actions: Actions;
  onOpenCell: (stat: string, anchor: Element) => void;
  onChange: (next: HudDesign) => void;
  announce: (message: string) => void;
}) {
  const h = useT().hudEditor;
  const locale = useLocale();
  const id = useId();
  const limits = state.limits;
  const byId = new Map(state.stats.map((stat) => [stat.id, stat]));
  const { onPanel, full, placeAt, moveTo, remove } = actions;
  const { dragging, spot, begin } = useDrag();
  const grid = useRef<HTMLDivElement>(null);
  const resizing = useRef<{ edge: Edge; pointer: number } | null>(null);
  const [tip, setTip] = useState(false);
  const least = minSize(design);

  const accepts = (item: DragItem) =>
    item.kind === "cell" || ((item.kind === "stat" || item.kind === "popup") && !onPanel(item.id) && !full);
  useDropZone(PANEL_ZONE, accepts, (item, at) => {
    if (at.row === undefined || at.col === undefined) return;
    if (item.kind === "cell") moveTo(item.slot, at.row, at.col);
    else placeAt(item.id, at.row, at.col);
  });

  const setSize = (rows: number, columns: number, say: boolean) => {
    const r = Math.max(least.rows, Math.min(limits.maxRows, rows));
    const c = Math.max(least.columns, Math.min(limits.maxColumns, columns));
    if (r === design.rows && c === design.columns) {
      if (say) announce(rows < least.rows || columns < least.columns ? h.cannotShrink : h.announceSize(r, c));
      return;
    }
    onChange(resize(design, r, c));
    if (say) announce(h.announceSize(r, c));
  };

  /** The grid's size under the pointer: past half a slot's pitch, a slot more. */
  const sizeAt = (event: PointerEvent, edge: Edge) => {
    const box = grid.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    const gapX = parseFloat(style.columnGap) || 0;
    const gapY = parseFloat(style.rowGap) || 0;
    const pitchX = (rect.width + gapX) / design.columns;
    const pitchY = (rect.height + gapY) / design.rows;
    const columns = edge === "rows" ? design.columns : Math.round((event.clientX - rect.left + gapX) / pitchX);
    const rows = edge === "columns" ? design.rows : Math.round((event.clientY - rect.top + gapY) / pitchY);
    setSize(rows, columns, false);
  };
  const onHandleDown = (event: PointerEvent<HTMLElement>, edge: Edge) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = { edge, pointer: event.pointerId };
    setTip(true);
  };
  const onHandleMove = (event: PointerEvent<HTMLElement>) => {
    const now = resizing.current;
    if (now?.pointer === event.pointerId) sizeAt(event, now.edge);
  };
  const onHandleUp = (event: PointerEvent<HTMLElement>) => {
    if (resizing.current?.pointer !== event.pointerId) return;
    resizing.current = null;
    setTip(false);
    announce(h.announceSize(design.rows, design.columns));
  };
  const onHandleKey = (event: KeyboardEvent<HTMLElement>, edge: Edge) => {
    const step: Record<string, [number, number]> = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
    };
    const by = step[event.key];
    if (!by) return;
    const [dr, dc] = by;
    if ((edge === "columns" && dr !== 0) || (edge === "rows" && dc !== 0)) return;
    event.preventDefault();
    setSize(design.rows + dr, design.columns + dc, true);
  };

  const onCellKey = (event: KeyboardEvent, slot: number, stat: string) => {
    const { row, col } = placeOf(design, slot);
    const to: Record<string, [number, number]> = {
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
    };
    const target = to[event.key];
    if (event.altKey && target) {
      event.preventDefault();
      const [r, c] = target;
      if (r >= 0 && c >= 0 && r < design.rows && c < design.columns) moveTo(slot, r, c);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(stat);
    }
  };

  const over = (row: number, col: number) =>
    dragging !== null && spot?.zone === PANEL_ZONE && spot.row === row && spot.col === col;
  const droppable = dragging !== null && accepts(dragging);
  const cells = slots(design);
  const sizeText = h.sizeText(design.rows, design.columns);

  return (
    <div className={styles.panelLayout}>
      <div className={styles.gridArea}>
        <div
          className={droppable && spot?.zone === PANEL_ZONE ? `${styles.panelBox} ${styles.panelBoxOver}` : styles.panelBox}
          data-zone={PANEL_ZONE}
          data-end={cells.length}
        >
          <div
            ref={grid}
            className={styles.grid}
            role="group"
            aria-label={h.cellsLabel(design.rows, design.columns)}
            style={{ gridTemplateColumns: `repeat(${design.columns}, var(--slot-width))` }}
          >
            {cells.map((cell, slot) => {
              const { row, col } = placeOf(design, slot);
              const common = { "data-slot": slot, "data-row": row, "data-col": col };
              if (cell === null) {
                return (
                  <div
                    key={`empty-${slot}`}
                    {...common}
                    className={over(row, col) ? `${styles.slotEmpty} ${styles.slotOver}` : styles.slotEmpty}
                    aria-hidden="true"
                  >
                    +
                  </div>
                );
              }
              const stat = byId.get(cell.stat);
              const classes = [
                styles.slotCell,
                selected === cell.stat ? styles.slotSelected : "",
                over(row, col) ? styles.slotOver : "",
                dragging?.kind === "cell" && dragging.slot === slot ? styles.slotDragged : "",
                stat?.cardSplit ? styles.slotCards : "",
              ].join(" ");
              return (
                <button
                  key={cell.stat}
                  type="button"
                  {...common}
                  className={classes}
                  aria-haspopup="dialog"
                  aria-expanded={selected === cell.stat}
                  aria-label={h.cellLabel(label(cell.stat), row + 1, col + 1)}
                  title={stat?.name[locale] ?? cell.stat}
                  onPointerDown={(event) => begin(event, { kind: "cell", slot, id: cell.stat, label: label(cell.stat) })}
                  onClick={(event) => onOpenCell(cell.stat, event.currentTarget)}
                  onKeyDown={(event) => onCellKey(event, slot, cell.stat)}
                >
                  {label(cell.stat)}
                  {cell.when ? <span className={styles.slotWhen} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          {droppable && design.columns < limits.maxColumns ? (
            <div className={styles.outsideColumn} aria-hidden="true">
              {Array.from({ length: design.rows }, (_, row) => (
                <div
                  key={row}
                  data-slot={-1}
                  data-row={row}
                  data-col={design.columns}
                  className={over(row, design.columns) ? `${styles.slotOutside} ${styles.slotOver}` : styles.slotOutside}
                />
              ))}
            </div>
          ) : null}
          {droppable && design.rows < limits.maxRows ? (
            <div
              className={styles.outsideRow}
              aria-hidden="true"
              style={{ gridTemplateColumns: `repeat(${design.columns}, var(--slot-width))` }}
            >
              {Array.from({ length: design.columns }, (_, col) => (
                <div
                  key={col}
                  data-slot={-1}
                  data-row={design.rows}
                  data-col={col}
                  className={over(design.rows, col) ? `${styles.slotOutside} ${styles.slotOver}` : styles.slotOutside}
                />
              ))}
            </div>
          ) : null}
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={h.resizeColumns}
            aria-valuenow={design.columns}
            aria-valuemin={least.columns}
            aria-valuemax={limits.maxColumns}
            aria-valuetext={sizeText}
            className={styles.edgeRight}
            tabIndex={0}
            onPointerDown={(event) => onHandleDown(event, "columns")}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={(event) => onHandleKey(event, "columns")}
          />
          <span
            role="separator"
            aria-orientation="horizontal"
            aria-label={h.resizeRows}
            aria-valuenow={design.rows}
            aria-valuemin={least.rows}
            aria-valuemax={limits.maxRows}
            aria-valuetext={sizeText}
            className={styles.edgeBottom}
            tabIndex={0}
            onPointerDown={(event) => onHandleDown(event, "rows")}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={(event) => onHandleKey(event, "rows")}
          />
          <span role="button" aria-label={h.resizeBoth(sizeText)} className={styles.edgeCorner} tabIndex={0}
            onPointerDown={(event) => onHandleDown(event, "both")}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onKeyDown={(event) => onHandleKey(event, "both")} />
          {tip ? (
            <span className={styles.sizeTip} aria-hidden="true">
              {h.sizeTip(design.rows, design.columns)}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.options}>
        <label className={styles.optionRow}>
          <span>{h.thresholds}</span>
          <select
            className={styles.select}
            value={design.maxColourThresholds === null ? "all" : String(design.maxColourThresholds)}
            onChange={(event) =>
              onChange({
                ...design,
                maxColourThresholds: event.target.value === "all" ? null : Number(event.target.value),
              })
            }
          >
            <option value="all">{h.thresholdsAll}</option>
            {[4, 3, 2, 1, 0].map((n) => (
              <option key={n} value={n}>
                {h.thresholdsN(n)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.optionRow}>
          <label htmlFor={`${id}-legend`}>{h.legend}</label>
          <Toggle id={`${id}-legend`} checked={design.legend} onChange={(legend) => onChange({ ...design, legend })} />
        </div>
        <div className={styles.optionRow} title={h.labelsHint}>
          <label htmlFor={`${id}-labels`}>{h.labels}</label>
          <Toggle
            id={`${id}-labels`}
            checked={design.playerLabels}
            onChange={(playerLabels) => onChange({ ...design, playerLabels })}
          />
        </div>
      </div>
    </div>
  );
}

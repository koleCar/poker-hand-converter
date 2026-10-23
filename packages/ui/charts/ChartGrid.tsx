/**
 * The 13 x 13 grid of one situation (R5.3): each hand class drawn as its mix
 * (raise, call, all-in, the rest), painted with a brush by a click, a drag
 * (mouse, pen or finger: the grid takes the gesture, `touch-action: none`)
 * or the keyboard (arrow keys move, Enter or Space paints). On a phone the
 * cells are 25 px, under the 44 px of R4.5d, so the same classes are also a
 * list of 44 px buttons, one rank at a time ({@link RankPicker}) - the touch
 * path `responsive.mjs` takes the grid's `[role=gridcell]` exception for.
 *
 * Read-only when `onPaint` is absent (the comparison draws it with marks).
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { useUiStrings } from "../i18n";
import { CLASS_COUNT, CLASS_NAMES, RANKS, percentOf, type ChartNode, type RestAction } from "./model";
import styles from "./Charts.module.css";

/** A cell's background: the mix left to right (raise, call, all-in, then the rest). */
export function mixStyle(node: ChartNode | null, cls: number, rest: RestAction): CSSProperties {
  if (!node) return {};
  const r = node.freq.raise[cls];
  const c = node.freq.call[cls];
  const a = node.freq.allin[cls];
  const restColour = rest === "check" ? "var(--chart-check)" : "var(--chart-fold)";
  return {
    background: `linear-gradient(90deg, var(--chart-raise) 0 ${r}%, var(--chart-call) ${r}% ${r + c}%, var(--chart-allin) ${r + c}% ${r + c + a}%, ${restColour} ${r + c + a}% 100%)`,
  };
}

/** "Raise 50 %, Fold 50 %" for a cell's accessible name. */
export function useMixText(rest: RestAction) {
  const t = useUiStrings().charts;
  return (node: ChartNode | null, cls: number): string => {
    if (!node) return t.brush.rest(t.actions[rest], 100);
    const parts: string[] = [];
    for (const action of ["raise", "call", "allin"] as const) {
      if (node.freq[action][cls] > 0) parts.push(t.brush.rest(t.actions[action], node.freq[action][cls]));
    }
    const left = percentOf(node, rest, cls);
    if (left > 0 || parts.length === 0) parts.push(t.brush.rest(t.actions[rest], left));
    return parts.join(", ");
  };
}

export interface ChartGridProps {
  node: ChartNode | null;
  rest: RestAction;
  label: string;
  /** Paint these classes (a stroke: one undo step per `onStrokeStart`). */
  onPaint?: (classes: number[]) => void;
  onStrokeStart?: () => void;
  /** Per class, a count to mark on the cell (the comparison's deviations). */
  marks?: ReadonlyArray<number>;
  /** The selected cell (the comparison's). */
  selected?: number | null;
  onSelect?: (cls: number) => void;
}

export function ChartGrid({ node, rest, label, onPaint, onStrokeStart, marks, selected = null, onSelect }: ChartGridProps) {
  const t = useUiStrings().charts;
  const mixText = useMixText(rest);
  const painting = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const touched = useRef(new Set<number>());
  const [focus, setFocus] = useState(0);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);

  const paintAt = (x: number, y: number) => {
    if (!onPaint || typeof document === "undefined") return;
    const hit = document.elementFromPoint(x, y);
    const cell = hit instanceof Element ? hit.closest<HTMLElement>("[data-cls]") : null;
    const cls = cell ? Number(cell.dataset.cls) : -1;
    if (cls >= 0 && !touched.current.has(cls)) {
      touched.current.add(cls);
      onPaint([cls]);
    }
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!onPaint || event.button > 0) return;
    painting.current = true;
    touched.current = new Set();
    last.current = { x: event.clientX, y: event.clientY };
    onStrokeStart?.();
    paintAt(event.clientX, event.clientY);
    event.preventDefault();
  };
  // Every cell the pointer crossed since the last event, not only where it is
  // now: a fast drag reports few points.
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!painting.current) return;
    const from = last.current ?? { x: event.clientX, y: event.clientY };
    const steps = Math.max(1, Math.ceil(Math.hypot(event.clientX - from.x, event.clientY - from.y) / 4));
    for (let i = 1; i <= steps; i += 1) {
      paintAt(from.x + ((event.clientX - from.x) * i) / steps, from.y + ((event.clientY - from.y) * i) / steps);
    }
    last.current = { x: event.clientX, y: event.clientY };
  };
  const up = () => {
    painting.current = false;
    last.current = null;
  };

  const key = (event: KeyboardEvent<HTMLButtonElement>, cls: number) => {
    const row = Math.floor(cls / 13);
    const col = cls % 13;
    const next =
      event.key === "ArrowRight" ? row * 13 + Math.min(12, col + 1)
      : event.key === "ArrowLeft" ? row * 13 + Math.max(0, col - 1)
      : event.key === "ArrowDown" ? Math.min(12, row + 1) * 13 + col
      : event.key === "ArrowUp" ? Math.max(0, row - 1) * 13 + col
      : event.key === "Home" ? row * 13
      : event.key === "End" ? row * 13 + 12
      : -1;
    if (next < 0) return;
    event.preventDefault();
    setFocus(next);
    cells.current[next]?.focus();
  };

  const activate = (cls: number, keyboard: boolean) => {
    setFocus(cls);
    if (onSelect) onSelect(cls);
    else if (onPaint && keyboard) {
      onStrokeStart?.();
      onPaint([cls]);
    }
  };

  return (
    <div
      className={`${styles.grid}${onPaint ? ` ${styles.paintable}` : ""}`}
      role="grid"
      aria-label={label}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
    >
      {Array.from({ length: 13 }, (_, row) => (
        <div key={row} role="row" className={styles.gridRow}>
          {Array.from({ length: 13 }, (_, col) => {
            const cls = row * 13 + col;
            const name = CLASS_NAMES[cls];
            const mark = marks?.[cls] ?? 0;
            return (
              <button
                key={cls}
                type="button"
                role="gridcell"
                data-cls={cls}
                ref={(element) => {
                  cells.current[cls] = element;
                }}
                tabIndex={cls === focus ? 0 : -1}
                aria-selected={onSelect ? selected === cls : undefined}
                aria-label={t.grid.cell(name, mixText(node, cls))}
                className={`${styles.cell}${row === col ? ` ${styles.pair}` : ""}${mark > 0 ? ` ${styles.marked}` : ""}${selected === cls ? ` ${styles.cellSelected}` : ""}`}
                style={mixStyle(node, cls, rest)}
                onKeyDown={(event) => key(event, cls)}
                onClick={(event) => activate(cls, event.detail === 0)}
              >
                <span className={styles.cellName}>{name}</span>
                {mark > 0 ? <span className={styles.cellMark}>{mark}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * The touch path: one rank's 25 classes (its pair, its suited and offsuit hands with that
 * card) as 44 px buttons, each painted with a tap.
 */
export function RankPicker({
  node,
  rest,
  onPaint,
}: {
  node: ChartNode | null;
  rest: RestAction;
  onPaint: (classes: number[]) => void;
}) {
  const t = useUiStrings().charts;
  const mixText = useMixText(rest);
  const [rank, setRank] = useState(0);
  // The rank's row and column of the grid: its pair, its suited hands, its offsuit hands.
  const classes: number[] = [];
  for (let k = 0; k < 13; k += 1) classes.push(rank * 13 + k);
  for (let k = 0; k < 13; k += 1) if (k !== rank) classes.push(k * 13 + rank);
  const shown = classes.filter((cls, i) => classes.indexOf(cls) === i && cls < CLASS_COUNT);
  return (
    <div className={styles.rankPicker}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t.grid.byRank}</span>
        <select value={rank} onChange={(event) => setRank(Number(event.target.value))}>
          {[...RANKS].map((r, i) => (
            <option key={r} value={i}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.muted}>{t.grid.byRankHelp}</p>
      <div className={styles.rankList}>
        {shown.map((cls) => (
          <button
            key={cls}
            type="button"
            className={styles.rankItem}
            aria-label={t.grid.cell(CLASS_NAMES[cls], mixText(node, cls))}
            onClick={() => onPaint([cls])}
          >
            <span className={styles.swatch} style={mixStyle(node, cls, rest)} aria-hidden="true" />
            {CLASS_NAMES[cls]}
          </button>
        ))}
      </div>
    </div>
  );
}

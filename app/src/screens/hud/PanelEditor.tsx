/**
 * The HUD editor's panel (R3.9): the panel's cells laid out as the HUD
 * draws them, its options, and the settings of the cell picked.
 *
 * Statistics come from the library (`StatLibrary`): dragged onto the panel
 * they go in where the marker shows; a cell dragged onto another moves
 * there. The keyboard does the same without a mouse: a statistic in the
 * library is added at the end with Enter; a focused cell moves with
 * Alt+Left / Alt+Right and goes with Delete; the cell's settings have Move
 * earlier / Move later / Remove. Every change is announced (`announce`).
 */
import { type KeyboardEvent, type ReactNode } from "react";

import { useLocale, useT } from "../../i18n";
import type { DesignCell, HudDesign, HudEditorState, StatOverride } from "../../lib/ipc";
import { CellSettings } from "./CellSettings";
import { useDrag, useDropZone, type DragItem } from "./drag";
import styles from "./HudEditor.module.css";

export const PANEL_ZONE = "panel";

/** The panel's edits, shared with the library (which adds to it). */
export function panelActions(
  design: HudDesign,
  max: number,
  label: (id: string) => string,
  onChange: (next: HudDesign) => void,
  onSelect: (index: number | null) => void,
  announce: (message: string) => void,
  words: ReturnType<typeof useT>["hudEditor"],
) {
  const onPanel = (id: string) => design.cells.some((cell) => cell.stat === id);
  const full = design.cells.length >= max;
  const insert = (stat: string, at: number) => {
    if (onPanel(stat)) return;
    if (full) {
      announce(words.full(max));
      return;
    }
    const cells = [...design.cells];
    const index = Math.max(0, Math.min(at, cells.length));
    cells.splice(index, 0, { stat });
    onChange({ ...design, cells });
    onSelect(index);
    announce(words.announceAdded(label(stat), index + 1));
  };
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || from >= design.cells.length) return;
    const cells = [...design.cells];
    const [cell] = cells.splice(from, 1);
    const index = Math.max(0, Math.min(to, cells.length));
    cells.splice(index, 0, cell);
    onChange({ ...design, cells });
    onSelect(index);
    announce(words.announceMoved(label(cell.stat), index + 1));
  };
  const remove = (index: number) => {
    const cell = design.cells[index];
    if (!cell) return;
    const overrides = { ...(design.overrides ?? {}) };
    delete overrides[cell.stat];
    onChange({ ...design, cells: design.cells.filter((_, i) => i !== index), overrides });
    onSelect(null);
    announce(words.announceRemoved(label(cell.stat)));
  };
  return { onPanel, full, insert, move, remove };
}

export function PanelEditor({
  design,
  state,
  selected,
  label,
  onSelect,
  onChange,
  announce,
  library,
}: {
  design: HudDesign;
  state: HudEditorState;
  selected: number | null;
  label: (id: string) => string;
  onSelect: (index: number | null) => void;
  onChange: (next: HudDesign) => void;
  announce: (message: string) => void;
  /** The statistics library, right under the cells it fills. */
  library: ReactNode;
}) {
  const h = useT().hudEditor;
  const locale = useLocale();
  const max = state.limits.maxCells;
  const byId = new Map(state.stats.map((stat) => [stat.id, stat]));
  const { onPanel, full, insert, move, remove } = panelActions(design, max, label, onChange, onSelect, announce, h);
  const { dragging, spot, begin } = useDrag();
  const columns = Math.max(1, design.columns);

  useDropZone(
    PANEL_ZONE,
    (item: DragItem) => item.kind === "cell" || ((item.kind === "stat" || item.kind === "popup") && !onPanel(item.id) && !full),
    (item, at) => {
      if (item.kind === "cell") move(item.index, item.index < at.index ? at.index - 1 : at.index);
      else insert(item.id, at.index);
    },
  );

  const onCellKey = (event: KeyboardEvent, index: number) => {
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      move(index, index - 1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      move(index, index + 1);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(index);
    }
  };

  const marker = spot?.zone === PANEL_ZONE ? spot.index : null;
  const cell = selected === null ? undefined : design.cells[selected];
  const setColumns = (n: number) => onChange({ ...design, columns: Math.max(1, Math.min(state.limits.maxColumns, n)) });

  return (
    <div className={styles.panelLayout}>
      <div className={styles.canvasColumn}>
        <div className={styles.canvasToolbar}>
          <div className={styles.stepper} role="group" aria-label={h.columns}>
            <span className={styles.toolLabel}>{h.columns}</span>
            <button
              type="button"
              className={styles.stepButton}
              aria-label={h.fewerColumns}
              title={h.fewerColumns}
              disabled={design.columns <= 1}
              onClick={() => setColumns(design.columns - 1)}
            >
              −
            </button>
            <output className={styles.stepValue}>{design.columns}</output>
            <button
              type="button"
              className={styles.stepButton}
              aria-label={h.moreColumns}
              title={h.moreColumns}
              disabled={design.columns >= state.limits.maxColumns}
              onClick={() => setColumns(design.columns + 1)}
            >
              +
            </button>
          </div>
          <label className={styles.toolField}>
            <span className={styles.toolLabel}>{h.thresholds}</span>
            <select
              className={styles.inputSm}
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
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={design.legend}
              onChange={(event) => onChange({ ...design, legend: event.target.checked })}
            />
            <span>{h.legend}</span>
          </label>
          <label className={styles.toggle} title={h.labelsHint}>
            <input
              type="checkbox"
              checked={design.playerLabels}
              onChange={(event) => onChange({ ...design, playerLabels: event.target.checked })}
            />
            <span>{h.labels}</span>
          </label>
        </div>

        <div className={styles.canvas}>
          <div
            role="list"
            aria-label={h.cellsLabel}
            data-zone={PANEL_ZONE}
            data-end={design.cells.length}
            className={dragging && marker !== null ? `${styles.hudPanel} ${styles.hudPanelOver}` : styles.hudPanel}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(4.75rem, 1fr))` }}
          >
            {design.cells.map((c, index) => {
              const stat = byId.get(c.stat);
              const name = stat?.name[locale] ?? c.stat;
              const classes = [
                styles.cell,
                selected === index ? styles.cellSelected : "",
                marker === index ? styles.markBefore : "",
                marker === design.cells.length && index === design.cells.length - 1 ? styles.markAfter : "",
                dragging?.kind === "cell" && dragging.index === index ? styles.cellDragged : "",
                stat?.cardSplit ? styles.cellCards : "",
              ].join(" ");
              return (
                <div key={c.stat} role="listitem" data-slot={index} className={classes}>
                  <button
                    type="button"
                    className={styles.cellButton}
                    aria-pressed={selected === index}
                    aria-label={h.cellLabel(label(c.stat), index + 1)}
                    title={name}
                    onPointerDown={(event) => begin(event, { kind: "cell", index, id: c.stat, label: label(c.stat) })}
                    onClick={() => onSelect(selected === index ? null : index)}
                    onKeyDown={(event) => onCellKey(event, index)}
                  >
                    <span className={styles.cellLabel}>{label(c.stat)}</span>
                    <span className={styles.cellName}>{name}</span>
                    {c.when ? <span className={styles.cellWhen}>{h.cellWhen}</span> : null}
                  </button>
                  <button
                    type="button"
                    className={styles.cellRemove}
                    aria-label={h.removeNamed(label(c.stat))}
                    title={h.removeNamed(label(c.stat))}
                    onClick={() => remove(index)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {!full ? (
              <div
                role="listitem"
                className={
                  marker === design.cells.length && design.cells.length === 0
                    ? `${styles.dropEnd} ${styles.dropEndOver}`
                    : styles.dropEnd
                }
                style={design.cells.length === 0 ? { gridColumn: "1 / -1" } : undefined}
              >
                {design.cells.length === 0 ? h.emptyPanel : h.dropHere}
              </div>
            ) : null}
          </div>
        </div>
        <p className={styles.hint}>{h.panelHint}</p>
        {library}
      </div>

      <aside className={styles.inspector} aria-label={h.cell}>
        {cell === undefined || selected === null ? (
          <div className={styles.inspectorEmpty}>
            <p className={styles.inspectorTitle}>{h.cell}</p>
            <p className={styles.hint}>{h.cellNone}</p>
          </div>
        ) : (
          <CellSettings
            key={cell.stat}
            index={selected}
            cell={cell}
            stat={byId.get(cell.stat)}
            override={design.overrides?.[cell.stat] ?? {}}
            maxDecimals={state.limits.maxDecimals}
            count={design.cells.length}
            onMove={(to) => move(selected, to)}
            onRemove={() => remove(selected)}
            onCell={(next: DesignCell) =>
              onChange({ ...design, cells: design.cells.map((c, i) => (i === selected ? next : c)) })
            }
            onOverride={(next: StatOverride) => {
              const overrides = { ...(design.overrides ?? {}) };
              if (next.bands === undefined && next.decimals === undefined && next.minSample === undefined) {
                delete overrides[cell.stat];
              } else {
                overrides[cell.stat] = next;
              }
              onChange({ ...design, overrides });
            }}
          />
        )}
      </aside>
    </div>
  );
}

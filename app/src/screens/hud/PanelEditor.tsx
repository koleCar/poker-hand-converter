/**
 * The HUD editor's panel (R3.9): the statistics list, the panel's cells
 * and the settings of the cell picked.
 *
 * Drag and drop: a statistic dragged from the list onto a cell goes in
 * before it (onto the space after the cells: at the end); a cell dragged
 * onto another moves there. The keyboard does the same without a mouse: a
 * statistic's Add button puts it at the end; a focused cell moves with
 * Alt+Left / Alt+Right and goes with Delete; the cell's settings have Move
 * earlier / Move later / Remove. Every change is announced (`announce`).
 */
import { useId, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import type { StatGroup, StatTone } from "@rail/ui/model/stats";

import { useLocale, useT } from "../../i18n";
import type { DesignBand, DesignCell, HudDesign, HudEditorState, HudStat, StatOverride } from "../../lib/ipc";
import styles from "./HudEditor.module.css";

const GROUPS: readonly StatGroup[] = ["preflop", "postflop", "showdown", "results"];
const TONES: readonly StatTone[] = ["very-low", "low", "normal", "high", "very-high"];
/** The drag payload's type. */
const DRAG_TYPE = "text/plain";

export function PanelEditor({
  design,
  state,
  editable,
  selected,
  onSelect,
  onChange,
  announce,
}: {
  design: HudDesign;
  state: HudEditorState;
  editable: boolean;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onChange: (next: HudDesign) => void;
  announce: (message: string) => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [over, setOver] = useState<number | null>(null);
  const hintId = useId();
  const max = state.limits.maxCells;
  const stats = state.stats;
  const byId = useMemo(() => new Map(stats.map((stat) => [stat.id, stat])), [stats]);
  const label = (id: string) => byId.get(id)?.label[locale] ?? id;
  const onPanel = (id: string) => design.cells.some((cell) => cell.stat === id);
  const full = design.cells.length >= max;

  const palette = stats.filter((stat) => !stat.heroOnly && !stat.money);
  const needle = query.trim().toLowerCase();
  const matches = (stat: HudStat) =>
    needle === "" ||
    stat.label[locale].toLowerCase().includes(needle) ||
    stat.name[locale].toLowerCase().includes(needle) ||
    stat.id.includes(needle);

  const setCells = (cells: DesignCell[]) => onChange({ ...design, cells });

  const insert = (stat: string, at: number) => {
    if (!editable || onPanel(stat) || full) {
      if (full) announce(h.full(max));
      return;
    }
    const cells = [...design.cells];
    const index = Math.max(0, Math.min(at, cells.length));
    cells.splice(index, 0, { stat });
    setCells(cells);
    onSelect(index);
    announce(h.announceAdded(label(stat), index + 1));
  };

  const move = (from: number, to: number) => {
    if (!editable || from === to || from < 0 || from >= design.cells.length) return;
    const cells = [...design.cells];
    const [cell] = cells.splice(from, 1);
    const index = Math.max(0, Math.min(to, cells.length));
    cells.splice(index, 0, cell);
    setCells(cells);
    onSelect(index);
    announce(h.announceMoved(label(cell.stat), index + 1));
  };

  const remove = (index: number) => {
    if (!editable) return;
    const cell = design.cells[index];
    if (!cell) return;
    const overrides = { ...(design.overrides ?? {}) };
    delete overrides[cell.stat];
    onChange({ ...design, cells: design.cells.filter((_, i) => i !== index), overrides });
    onSelect(null);
    announce(h.announceRemoved(label(cell.stat)));
  };

  const onDrop = (event: DragEvent, at: number) => {
    event.preventDefault();
    setOver(null);
    const data = event.dataTransfer.getData(DRAG_TYPE);
    if (data.startsWith("stat:")) insert(data.slice(5), at);
    if (data.startsWith("cell:")) {
      const from = Number(data.slice(5));
      move(from, from < at ? at - 1 : at);
    }
  };
  const allowDrop = (event: DragEvent, at: number) => {
    if (!editable) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(at);
  };

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

  const cell = selected === null ? undefined : design.cells[selected];

  return (
    <div className={styles.panelEditor}>
      <section className={styles.palette} aria-labelledby={`${hintId}-palette`}>
        <h3 id={`${hintId}-palette`} className={styles.subheading}>
          {h.palette}
        </h3>
        <input
          type="search"
          className={styles.input}
          value={query}
          placeholder={h.paletteSearch}
          aria-label={h.paletteSearch}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className={styles.hint}>{h.paletteHint}</p>
        <div className={styles.paletteList}>
          {GROUPS.map((group) => {
            const shown = palette.filter((stat) => stat.group === group && matches(stat));
            return shown.length === 0 ? null : (
              <div key={group} className={styles.paletteGroup}>
                <h4 className={styles.groupName}>{t.reports.stats.groups[group]}</h4>
                <ul className={styles.plainList}>
                  {shown.map((stat) => {
                    const placed = onPanel(stat.id);
                    return (
                      <li key={stat.id} className={styles.paletteRow}>
                        <span
                          className={placed ? `${styles.chip} ${styles.chipPlaced}` : styles.chip}
                          draggable={editable && !placed}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(DRAG_TYPE, `stat:${stat.id}`);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          title={stat.description[locale]}
                        >
                          {stat.label[locale]}
                        </span>
                        <span className={styles.statName}>
                          {stat.name[locale]}
                          {stat.custom ? <span className={styles.badge}>{h.yours}</span> : null}
                          {stat.cardSplit ? <span className={styles.badgeWarn}>{h.cards}</span> : null}
                          {placed ? <span className={styles.muted}>{h.onPanel}</span> : null}
                        </span>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={!editable || placed || full}
                          aria-label={h.addNamed(stat.label[locale])}
                          onClick={() => insert(stat.id, design.cells.length)}
                        >
                          {h.add}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {palette.every((stat) => !matches(stat)) ? <p className={styles.hint}>{h.noMatch}</p> : null}
        </div>
      </section>

      <section className={styles.cellsColumn} aria-labelledby={`${hintId}-panel`}>
        <h3 id={`${hintId}-panel`} className={styles.subheading}>
          {h.cellsHeading}
        </h3>
        <p id={hintId} className={styles.hint}>
          {h.panelHint}
        </p>
        <div
          role="list"
          aria-label={h.cellsLabel}
          aria-describedby={hintId}
          className={styles.cells}
          style={{ gridTemplateColumns: `repeat(${Math.max(1, design.columns)}, minmax(0, 1fr))` }}
        >
          {design.cells.map((c, index) => (
            <div key={c.stat} role="listitem" className={styles.cellSlot}>
              <button
                type="button"
                draggable={editable}
                className={[
                  styles.cell,
                  selected === index ? styles.cellSelected : "",
                  over === index ? styles.cellOver : "",
                  byId.get(c.stat)?.cardSplit ? styles.cellCards : "",
                ].join(" ")}
                aria-pressed={selected === index}
                aria-label={h.cellLabel(label(c.stat), index + 1)}
                onClick={() => onSelect(selected === index ? null : index)}
                onKeyDown={(event) => onCellKey(event, index)}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, `cell:${index}`);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => allowDrop(event, index)}
                onDragLeave={() => setOver(null)}
                onDrop={(event) => onDrop(event, index)}
              >
                <span className={styles.cellLabel}>{label(c.stat)}</span>
                {c.when ? <span className={styles.cellWhen}>{h.cellWhen}</span> : null}
              </button>
            </div>
          ))}
          {editable && !full ? (
            <div
              role="listitem"
              className={over === design.cells.length ? `${styles.dropEnd} ${styles.cellOver}` : styles.dropEnd}
              onDragOver={(event) => allowDrop(event, design.cells.length)}
              onDragLeave={() => setOver(null)}
              onDrop={(event) => onDrop(event, design.cells.length)}
            >
              {design.cells.length === 0 ? h.emptyPanel : h.dropHere}
            </div>
          ) : null}
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{h.columns}</span>
            <select
              className={styles.input}
              value={design.columns}
              disabled={!editable}
              onChange={(event) => onChange({ ...design, columns: Number(event.target.value) })}
            >
              {Array.from({ length: state.limits.maxColumns }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{h.thresholds}</span>
            <select
              className={styles.input}
              value={design.maxColourThresholds === null ? "all" : String(design.maxColourThresholds)}
              disabled={!editable}
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
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={design.legend}
            disabled={!editable}
            onChange={(event) => onChange({ ...design, legend: event.target.checked })}
          />
          <span>{h.legend}</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={design.playerLabels}
            disabled={!editable}
            onChange={(event) => onChange({ ...design, playerLabels: event.target.checked })}
          />
          <span>
            {h.labels}
            <span className={styles.hintBlock}>{h.labelsHint}</span>
          </span>
        </label>
      </section>

      <section className={styles.cellSettings} aria-labelledby={`${hintId}-cell`}>
        <h3 id={`${hintId}-cell`} className={styles.subheading}>
          {cell ? `${h.cell}: ${label(cell.stat)}` : h.cell}
        </h3>
        {cell === undefined || selected === null ? (
          <p className={styles.hint}>{h.cellNone}</p>
        ) : (
          <CellSettings
            key={cell.stat}
            index={selected}
            cell={cell}
            stat={byId.get(cell.stat)}
            override={design.overrides?.[cell.stat] ?? {}}
            editable={editable}
            maxDecimals={state.limits.maxDecimals}
            count={design.cells.length}
            onMove={(to) => move(selected, to)}
            onRemove={() => remove(selected)}
            onCell={(next) => setCells(design.cells.map((c, i) => (i === selected ? next : c)))}
            onOverride={(next) => {
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
      </section>
    </div>
  );
}

/** One band as the form holds it: the limit as typed. */
interface BandForm {
  below: string;
  tone: StatTone;
}

function CellSettings({
  index,
  cell,
  stat,
  override,
  editable,
  maxDecimals,
  count,
  onMove,
  onRemove,
  onCell,
  onOverride,
}: {
  index: number;
  cell: DesignCell;
  stat: HudStat | undefined;
  override: StatOverride;
  editable: boolean;
  maxDecimals: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  onCell: (next: DesignCell) => void;
  onOverride: (next: StatOverride) => void;
}) {
  const h = useT().hudEditor;
  const locale = useLocale();
  const id = useId();
  const [bands, setBands] = useState<BandForm[]>(() =>
    (override.bands ?? stat?.bands ?? []).map((band) => ({
      below: band.below === undefined ? "" : String(band.below),
      tone: band.tone,
    })),
  );
  const own = override.bands !== undefined;

  const commitBands = (next: BandForm[]) => {
    setBands(next);
    const parsed: DesignBand[] = next.map((band, i) =>
      i === next.length - 1 || band.below.trim() === ""
        ? { tone: band.tone }
        : { below: Number(band.below.replace(",", ".")), tone: band.tone },
    );
    onOverride({ ...override, bands: parsed });
  };

  return (
    <div className={styles.settings}>
      {stat ? <p className={styles.hint}>{stat.name[locale]}</p> : null}
      <div className={styles.row}>
        <button type="button" className="btn btn--sm" disabled={!editable || index === 0} onClick={() => onMove(index - 1)}>
          {h.moveEarlier}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!editable || index >= count - 1}
          onClick={() => onMove(index + 1)}
        >
          {h.moveLater}
        </button>
        <button type="button" className="btn btn--sm" disabled={!editable} onClick={onRemove}>
          {h.remove}
        </button>
      </div>

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>{h.decimals}</span>
          <select
            className={styles.input}
            value={override.decimals === undefined ? "default" : String(override.decimals)}
            disabled={!editable}
            onChange={(event) =>
              onOverride({
                ...override,
                decimals: event.target.value === "default" ? undefined : Number(event.target.value),
              })
            }
          >
            <option value="default">{h.asDefinition("0")}</option>
            {Array.from({ length: maxDecimals + 1 }, (_, i) => i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{h.minSample}</span>
          <input
            type="number"
            min={0}
            className={styles.input}
            value={override.minSample ?? ""}
            placeholder={h.asDefinition(String(stat?.minSample ?? ""))}
            disabled={!editable}
            onChange={(event) =>
              onOverride({
                ...override,
                minSample: event.target.value === "" ? undefined : Math.max(0, Math.floor(Number(event.target.value))),
              })
            }
          />
        </label>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{h.bands}</legend>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={own}
            disabled={!editable}
            onChange={(event) => {
              if (event.target.checked) {
                commitBands(bands.length > 0 ? bands : [{ below: "", tone: "normal" }]);
              } else {
                onOverride({ ...override, bands: undefined });
                setBands(
                  (stat?.bands ?? []).map((band) => ({
                    below: band.below === undefined ? "" : String(band.below),
                    tone: band.tone,
                  })),
                );
              }
            }}
          />
          <span>{h.bandsOwn}</span>
        </label>
        {own ? (
          <>
            <p className={styles.hint}>{h.bandsHint}</p>
            {bands.map((band, i) => {
              const last = i === bands.length - 1;
              return (
                <div key={i} className={styles.bandRow}>
                  {last ? null : (
                    <input
                      className={styles.inputNarrow}
                      inputMode="decimal"
                      value={band.below}
                      aria-label={h.bandBelow(i + 1)}
                      disabled={!editable}
                      onChange={(event) =>
                        commitBands(bands.map((b, j) => (j === i ? { ...b, below: event.target.value } : b)))
                      }
                    />
                  )}
                  <select
                    className={styles.input}
                    value={band.tone}
                    aria-label={h.bandTone(i + 1)}
                    disabled={!editable}
                    onChange={(event) =>
                      commitBands(bands.map((b, j) => (j === i ? { ...b, tone: event.target.value as StatTone } : b)))
                    }
                  >
                    {TONES.map((tone) => (
                      <option key={tone} value={tone}>
                        {h.tones[tone]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn--sm btn--icon"
                    aria-label={h.removeBand(i + 1)}
                    title={h.removeBand(i + 1)}
                    disabled={!editable || bands.length <= 1}
                    onClick={() => commitBands(bands.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="btn btn--sm"
              disabled={!editable || bands.length >= 5}
              onClick={() =>
                commitBands([...bands.slice(0, -1), { below: "", tone: "normal" }, ...bands.slice(-1)])
              }
            >
              {h.addBand}
            </button>
          </>
        ) : null}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{h.stackLegend}</legend>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={cell.when !== undefined}
            disabled={!editable}
            aria-describedby={`${id}-stack`}
            onChange={(event) =>
              onCell(event.target.checked ? { ...cell, when: { belowBb: 20 } } : { stat: cell.stat })
            }
          />
          <span>{h.stack}</span>
        </label>
        <p id={`${id}-stack`} className={styles.hintWarn}>
          {h.stackHint}
        </p>
        {cell.when ? (
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>{h.stackAtLeast}</span>
              <input
                type="number"
                min={1}
                max={1000}
                className={styles.inputNarrow}
                value={cell.when.atLeastBb ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  onCell({
                    ...cell,
                    when: {
                      ...cell.when,
                      atLeastBb: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{h.stackBelow}</span>
              <input
                type="number"
                min={1}
                max={1000}
                className={styles.inputNarrow}
                value={cell.when.belowBb ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  onCell({
                    ...cell,
                    when: {
                      ...cell.when,
                      belowBb: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

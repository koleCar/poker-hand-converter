/**
 * One group's editor: the values as toggle pills (no counts: the row says
 * how many hands match, once), a yes/no as three pills with "any" first,
 * the date's presets and its custom days, a typed value, and two richer
 * ones - the hero's seat on a table (`SeatPicker`) and the starting hands on
 * a 13×13 grid (`RangeMatrix`). The same editor fills a chip's popover, the
 * "+ Add filter" menu and a pane of the builder.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { useUiStrings } from "../i18n";
import {
  DATE_PRESETS,
  POT_OPS,
  isInstant,
  potParts,
  potText,
  type DatePreset,
  type FilterState,
  type PotOp,
  type PotUnit,
} from "./filter";
import { kindOf } from "./gameKind";
import {
  FLAG_GROUPS,
  LIST_GROUPS,
  TEXT_GROUPS,
  combosOf,
  rangePercent,
  selectedOf,
  useGroupWords,
  withValues,
  type GroupId,
  type GroupOption,
} from "./groups";
import styles from "./FilterBar.module.css";
import type { HandFacets, HandSession } from "./model";
import { useHandSessions } from "./sessions";

export interface GroupEditorProps {
  group: GroupId;
  filter: FilterState;
  facets: HandFacets | null;
  onChange: (filter: FilterState) => void;
  /**
   * The builder edits a draft, so a typed value applies as it is typed and
   * the seats sit round a table; a chip's popover applies to the list, so a
   * typed value waits for Enter.
   */
  variant: "popover" | "builder";
  /** Show the group's name above it (the builder lists several per pane). */
  titled?: boolean | undefined;
}

export function GroupEditor({ group, filter, facets, onChange, variant, titled = false }: GroupEditorProps) {
  const strings = useUiStrings();
  const t = strings.hands.filters;
  const words = useGroupWords();
  const name = words.name(group);
  const list = LIST_GROUPS[group];
  const flag = FLAG_GROUPS[group];
  const text = TEXT_GROUPS[group];

  let body = null;
  if (group === "position" && variant === "builder") {
    body = (
      <SeatPicker
        options={words.options(group, filter, facets)}
        selected={filter.positions}
        onChange={(positions) => onChange({ ...filter, positions })}
      />
    );
  } else if (list) {
    const options = words.options(group, filter, facets);
    body =
      options.length === 0 && group === "tags" ? (
        <p className={styles.hint}>{t.noTags}</p>
      ) : (
        <Pills
          label={name}
          options={options}
          selected={selectedOf(group, filter, facets)}
          onChange={(next) => onChange(withValues(group, filter, next, facets))}
        />
      );
  } else if (flag) {
    const pairs =
      group === "allIn"
        ? t.allIn
        : group === "notes"
          ? t.notes
          : group === "knownCards"
            ? t.builder.knownCardsValues
            : group === "bounty"
              ? t.builder.bountyValues
              : t.showdownValues;
    const value = filter[flag];
    body = (
      <Pills
        label={name}
        single
        options={[
          { value: "any", label: t.clear },
          { value: "yes", label: pairs.yes },
          { value: "no", label: pairs.no },
        ]}
        selected={[value === null ? "any" : value ? "yes" : "no"]}
        onChange={(next) => {
          const chosen = next[0] ?? "any";
          onChange({ ...filter, [flag]: chosen === "any" ? null : chosen === "yes" });
        }}
      />
    );
  } else if (group === "date") {
    body = (
      <div className={styles.editorStack}>
        <Pills
          label={name}
          single
          options={[{ value: "any", label: t.clear }, ...DATE_PRESETS.map((value) => ({ value, label: t.dates[value] }))]}
          selected={[filter.date ?? "any"]}
          onChange={(next) => {
            const chosen = next[0] ?? "any";
            onChange({ ...filter, date: chosen === "any" ? null : (chosen as DatePreset) });
          }}
        />
        <SessionPicker filter={filter} onChange={onChange} />
        {filter.date === "custom" && !isInstant(filter.dateFrom) ? (
          <div className={styles.range}>
            <label>
              {t.dates.from}
              <input type="date" value={filter.dateFrom} onChange={(event) => onChange({ ...filter, dateFrom: event.target.value })} />
            </label>
            <label>
              {t.dates.to}
              <input type="date" value={filter.dateTo} onChange={(event) => onChange({ ...filter, dateTo: event.target.value })} />
            </label>
          </div>
        ) : null}
      </div>
    );
  } else if (group === "potSize") {
    body = <PotSizeField filter={filter} live={variant === "builder"} onChange={onChange} />;
  } else if (text) {
    const hints: Record<typeof text, { label: string; hint: string; numeric?: boolean }> = {
      board: { label: t.search.board, hint: t.search.boardHint },
      playerName: { label: t.search.player, hint: t.search.playerHint },
      tableName: { label: t.search.tableName, hint: t.search.tableNameHint },
      minPot: { label: t.search.minPot, hint: t.search.minPotHint, numeric: true },
      heroStack: { label: t.builder.heroStack, hint: t.builder.rangeHint },
      netRange: { label: t.builder.netRange, hint: t.builder.netRangeHint },
      evLoss: { label: t.builder.evLoss, hint: t.builder.evLossHint, numeric: true },
      openSize: { label: t.builder.openSize, hint: t.builder.rangeHint },
      vsVpip: { label: t.builder.vsVpip, hint: t.builder.vsVpipHint },
      buyIn: { label: t.builder.buyIn, hint: t.builder.buyInHint },
    };
    const field = hints[text];
    body = (
      <TextField
        label={field.label}
        hint={field.hint}
        numeric={field.numeric === true}
        value={filter[text]}
        live={variant === "builder"}
        onCommit={(value) => onChange({ ...filter, [text]: value })}
      />
    );
  } else if (group === "heroHand") {
    body = (
      <div className={styles.editorStack}>
        <RangeMatrix selected={filter.heroRange} onChange={(heroRange) => onChange({ ...filter, heroRange })} />
        <TextField
          label={t.range.exact}
          hint={t.range.exactHint}
          numeric={false}
          value={filter.heroCards}
          live={variant === "builder"}
          onCommit={(heroCards) => onChange({ ...filter, heroCards })}
        />
      </div>
    );
  }

  if (!titled) return body;
  return (
    <section className={styles.editorSection} aria-label={name}>
      <h4 className={styles.editorTitle}>{name}</h4>
      {body}
    </section>
  );
}

/** Toggle pills: any number on (none on is "any"), or exactly one with `single`. */
/**
 * One of the hero's latest sessions as the date: its first hand to its last,
 * exact instants (the kind of game the filter has, or both).
 */
function SessionPicker({ filter, onChange }: { filter: FilterState; onChange: (next: FilterState) => void }) {
  const strings = useUiStrings();
  const t = strings.hands.filters.builder;
  const load = useHandSessions();
  const kind = kindOf(filter.formats);
  const [sessions, setSessions] = useState<HandSession[] | null>(null);
  useEffect(() => {
    if (load === null) return;
    let live = true;
    load(kind).then(
      (found) => {
        if (live) setSessions(found);
      },
      () => {
        if (live) setSessions([]);
      },
    );
    return () => {
      live = false;
    };
  }, [load, kind]);
  if (load === null || sessions === null || sessions.length === 0) return null;
  const chosen =
    filter.date === "custom"
      ? sessions.find((session) => session.startedAt === filter.dateFrom && session.endedAt === filter.dateTo)
      : undefined;
  const when = new Intl.DateTimeFormat(strings.intlLocale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className={styles.range}>
      <label>
        {t.session}
        <select
          value={chosen ? chosen.startedAt : ""}
          onChange={(event) => {
            const session = sessions.find((candidate) => candidate.startedAt === event.target.value);
            onChange(
              session
                ? { ...filter, date: "custom", dateFrom: session.startedAt, dateTo: session.endedAt }
                : { ...filter, date: null, dateFrom: "", dateTo: "" },
            );
          }}
        >
          <option value="">{t.sessionAny}</option>
          {sessions.map((session) => (
            <option key={session.startedAt} value={session.startedAt}>
              {t.sessionLabel(when.format(new Date(session.startedAt)), strings.hands.count(session.hands))}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function Pills({
  label,
  options,
  selected,
  onChange,
  single = false,
}: {
  label: string;
  options: readonly GroupOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  single?: boolean | undefined;
}) {
  const on = new Set(selected);
  return (
    <div role="group" aria-label={label} className={styles.pills}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.pill}
          aria-pressed={on.has(option.value)}
          onClick={() => {
            if (single) {
              onChange([option.value]);
              return;
            }
            const next = new Set(on);
            if (next.has(option.value)) next.delete(option.value);
            else next.add(option.value);
            onChange(options.map((o) => o.value).filter((value) => next.has(value)));
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A typed value: applied as typed in the builder, on Enter (or leaving the field) in a popover. */
function TextField({
  label,
  hint,
  numeric,
  value,
  live,
  onCommit,
}: {
  label: string;
  hint: string;
  numeric: boolean;
  value: string;
  live: boolean;
  onCommit: (value: string) => void;
}) {
  const t = useUiStrings().hands.filters;
  const [draft, setDraft] = useState(value);
  // The value changed from outside (cleared from the row): the field follows.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <form
      className={styles.textField}
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label>
        <span>{label}</span>
        <input
          value={draft}
          spellCheck={false}
          inputMode={numeric ? "decimal" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (live) onCommit(event.target.value);
          }}
          onBlur={live ? undefined : commit}
        />
        <small>{hint}</small>
      </label>
      {live ? null : (
        <button type="submit" className="btn btn--primary btn--sm" disabled={draft === value}>
          {t.apply}
        </button>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------- pot */

interface PotDraft {
  unit: PotUnit;
  op: PotOp;
  a: string;
  b: string;
}

const potDraftOf = (filter: FilterState): PotDraft => ({ unit: filter.potUnit, ...potParts(filter.potSize) });

/**
 * The pot's size (2026-11-08): big blinds or the table's money, greater
 * than, less than or between, one or two amounts. Applied as typed in the
 * builder, with Apply (or Enter) in a popover.
 */
function PotSizeField({
  filter,
  live,
  onChange,
}: {
  filter: FilterState;
  live: boolean;
  onChange: (filter: FilterState) => void;
}) {
  const t = useUiStrings().hands.filters;
  const p = t.builder.pot;
  const [draft, setDraft] = useState<PotDraft>(() => potDraftOf(filter));
  // Changed from outside (cleared from the row): the field follows, unless
  // it is what the draft already says (a "between" with one amount typed).
  const [seen, setSeen] = useState(`${filter.potUnit} ${filter.potSize}`);
  const key = `${filter.potUnit} ${filter.potSize}`;
  if (seen !== key) {
    setSeen(key);
    if (draft.unit !== filter.potUnit || potText(draft.op, draft.a, draft.b) !== filter.potSize) {
      setDraft(potDraftOf(filter));
    }
  }
  const nextOf = (d: PotDraft): FilterState => ({ ...filter, potUnit: d.unit, potSize: potText(d.op, d.a, d.b) });
  const changed = (next: FilterState) => next.potUnit !== filter.potUnit || next.potSize !== filter.potSize;
  const update = (patch: Partial<PotDraft>) => {
    const d = { ...draft, ...patch };
    setDraft(d);
    const next = nextOf(d);
    if (live && changed(next)) onChange(next);
  };
  const pending = changed(nextOf(draft));
  return (
    <form
      className={styles.editorStack}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) onChange(nextOf(draft));
      }}
    >
      <Pills
        label={p.unit}
        single
        options={[
          { value: "bb", label: p.units.bb },
          { value: "money", label: p.units.money },
        ]}
        selected={[draft.unit]}
        onChange={(next) => update({ unit: next[0] === "money" ? "money" : "bb" })}
      />
      <Pills
        label={p.op}
        single
        options={POT_OPS.map((value) => ({ value, label: p.ops[value] }))}
        selected={[draft.op]}
        onChange={(next) => update({ op: (POT_OPS as string[]).includes(next[0] ?? "") ? (next[0] as PotOp) : "gt" })}
      />
      <div className={styles.range}>
        <label>
          {draft.op === "between" ? p.ops.between : p.amount}
          <input
            value={draft.a}
            inputMode="decimal"
            spellCheck={false}
            onChange={(event) => update({ a: event.target.value })}
          />
        </label>
        {draft.op === "between" ? (
          <label>
            {p.and}
            <input
              value={draft.b}
              inputMode="decimal"
              spellCheck={false}
              onChange={(event) => update({ b: event.target.value })}
            />
          </label>
        ) : null}
      </div>
      <p className={styles.hint}>{draft.unit === "money" ? p.hintMoney : p.hintBb}</p>
      {live ? null : (
        <div>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!pending}>
            {t.apply}
          </button>
        </div>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ seats */

/**
 * The hero's seat on a table: the seats round an oval in the order the
 * action goes (the first to act top left, the big blind last, on the left),
 * any number on.
 */
export function SeatPicker({
  options,
  selected,
  onChange,
}: {
  options: readonly GroupOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const t = useUiStrings().hands.filters.seats;
  const on = new Set(selected);
  const count = options.length;
  const step = 360 / Math.max(count, 1);
  return (
    <div className={styles.seatsCard}>
      <div className={styles.seatsHead}>
        <span>{t.hero}</span>
        <button type="button" className={styles.textButton} aria-pressed={selected.length === 0} onClick={() => onChange([])}>
          {t.any}
        </button>
      </div>
      <div role="group" aria-label={t.table} className={styles.table}>
        <div className={styles.felt} aria-hidden="true" />
        {options.map((option, index) => {
          const angle = ((-90 - step / 2 + index * step) * Math.PI) / 180;
          // Percentages of the table's box: the seats sit just inside its edge.
          const left = 50 + 43 * Math.cos(angle);
          const top = 50 + 40 * Math.sin(angle);
          return (
            <button
              key={option.value}
              type="button"
              className={styles.seat}
              style={{ left: `${left}%`, top: `${top}%` }}
              aria-pressed={on.has(option.value)}
              onClick={() => {
                const next = new Set(on);
                if (next.has(option.value)) next.delete(option.value);
                else next.add(option.value);
                onChange(options.map((o) => o.value).filter((value) => next.has(value)));
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ range */

const RANKS = "AKQJT98765432".split("");

/** The 169 classes, row by row: pairs on the diagonal, suited above it, offsuit below. */
const CLASSES: string[] = RANKS.flatMap((high, row) =>
  RANKS.map((low, col) => (row === col ? high + low : row < col ? `${high}${low}s` : `${low}${high}o`)),
);

/**
 * The starting hands on the usual 13×13 grid. Click a cell, or drag across
 * cells to paint them on (or off, when the first one was on); the arrow
 * keys move through the grid (one tab stop) and Space or Enter picks.
 */
export function RangeMatrix({ selected, onChange }: { selected: readonly string[]; onChange: (next: string[]) => void }) {
  const strings = useUiStrings();
  const t = strings.hands.filters.range;
  const on = useMemo(() => new Set(selected), [selected]);
  const [focus, setFocus] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  // While the pointer is down: whether cells are being painted on or off,
  // and the last cell painted (a fast drag skips cells: the line between
  // the two is painted too).
  const paint = useRef<boolean | null>(null);
  const last = useRef(0);
  const latest = useRef(on);
  useEffect(() => {
    latest.current = on;
  }, [on]);

  useEffect(() => {
    const stop = () => {
      paint.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const setMany = (classes: readonly string[], value: boolean) => {
    const next = new Set(latest.current);
    for (const handClass of classes) {
      if (value) next.add(handClass);
      else next.delete(handClass);
    }
    latest.current = next;
    onChange(CLASSES.filter((c) => next.has(c)));
  };
  const set = (handClass: string, value: boolean) => setMany([handClass], value);

  /** The cells on the straight line from one cell to another, both included. */
  const line = (from: number, to: number): string[] => {
    const [r0, c0, r1, c1] = [Math.floor(from / 13), from % 13, Math.floor(to / 13), to % 13];
    const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0), 1);
    const cells: string[] = [];
    for (let step = 0; step <= steps; step += 1) {
      const row = Math.round(r0 + ((r1 - r0) * step) / steps);
      const col = Math.round(c0 + ((c1 - c0) * step) / steps);
      const handClass = CLASSES[row * 13 + col];
      if (handClass) cells.push(handClass);
    }
    return cells;
  };

  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (paint.current === null) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-cell]");
    const index = cell ? Number(cell.dataset.cell) : -1;
    if (index < 0 || index === last.current) return;
    setMany(line(last.current, index), paint.current);
    last.current = index;
  };
  const add = (test: (handClass: string) => boolean) => () => {
    onChange(CLASSES.filter((c) => on.has(c) || test(c)));
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 13, ArrowUp: -13 };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const next = Math.min(168, Math.max(0, focus + move));
    setFocus(next);
    grid.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  const combos = selected.reduce((sum, c) => sum + combosOf(c), 0);
  const percent = rangePercent(selected).toLocaleString(strings.intlLocale);

  return (
    <div className={styles.matrixWrap}>
      <div className={styles.matrixTools}>
        <button type="button" className={styles.mini} onClick={add((c) => c.length === 2)}>
          {t.pairs}
        </button>
        <button type="button" className={styles.mini} onClick={add((c) => c.endsWith("s"))}>
          {t.suited}
        </button>
        <button type="button" className={styles.mini} onClick={add((c) => "AKQJT".includes(c[0] ?? "") && "AKQJT".includes(c[1] ?? ""))}>
          {t.broadway}
        </button>
        <button type="button" className={styles.mini} onClick={add((c) => c.startsWith("A"))}>
          {t.aces}
        </button>
        <button type="button" className={styles.mini} onClick={() => onChange(CLASSES.filter((c) => !on.has(c)))}>
          {t.invert}
        </button>
        <button type="button" className={styles.mini} onClick={() => onChange([])} disabled={selected.length === 0}>
          {t.clear}
        </button>
      </div>
      <div ref={grid} role="group" aria-label={t.label} className={styles.matrix} onKeyDown={onKey} onPointerMove={onMove}>
        {CLASSES.map((handClass, index) => {
          const kind = handClass.length === 2 ? styles.pair : handClass.endsWith("s") ? styles.suited : styles.offsuit;
          return (
            <button
              key={handClass}
              type="button"
              className={`${styles.cell} ${kind}`}
              aria-pressed={on.has(handClass)}
              data-cell={index}
              tabIndex={index === focus ? 0 : -1}
              onFocus={() => setFocus(index)}
              onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
                if (event.button !== 0) return;
                event.preventDefault();
                // The cell keeps getting the pointer's moves unless released.
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                const value = !latest.current.has(handClass);
                paint.current = value;
                last.current = index;
                setFocus(index);
                set(handClass, value);
              }}
              onClick={(event) => {
                // A pointer click was handled on the way down; this is the keyboard's.
                if (event.detail === 0) set(handClass, !on.has(handClass));
              }}
            >
              {handClass}
            </button>
          );
        })}
      </div>
      <div className={styles.matrixFoot}>
        <span>{t.hint}</span>
        <strong>{t.summary(combos, percent)}</strong>
      </div>
    </div>
  );
}

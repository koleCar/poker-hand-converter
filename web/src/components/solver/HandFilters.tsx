/**
 * The hand filters (the Solver library's panel, beside both tabs): pick made
 * hands, draws, equity buckets and suits, and every view of the decision -
 * the grid, the actions' shares, both ranges - counts only the combos that
 * pass (`passes` in `lib/solver/ranges.ts`).
 *
 * Include and exclude are two lists, one edited at a time. Within a group the
 * picked categories add up; across groups a combo has to match each. Every row
 * shows the share of the acting player's range it holds here and, as a bar,
 * how that part of the range plays (the actions' colours); its ▲ picks it and
 * every row above it (a hand and everything stronger). The active filters
 * show as chips on the view's toolbar (`ActiveFilters`), each removed by a
 * click.
 */

"use client";

import { useMemo, useState } from "react";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { useSolverDict, type SolverDict } from "./host";
import {
  comboIds,
  DRAWS,
  EQ_BANDS,
  EQ_BUCKETS,
  filterId,
  MADE_HANDS,
  type FilterGroup,
  type HandFilter,
} from "../../lib/solver";
import analysis from "../analysis/analysis.module.css";
import type { RangeData } from "./rangeData";
import { Chip, MixBar, Segmented, ToolButton } from "./ui";
import styles from "./solver.module.css";

type Dict = SolverDict;
type Mode = "include" | "exclude";

const SUITS: Suit[] = ["s", "h", "d", "c"];

interface Row {
  id: string;
  label: string;
  share: number;
  /** Per action: its share of the category's reach. */
  mix: number[];
}

/** A filter id's label. */
export function filterLabel(id: string, t: Dict): string {
  const [group, value] = id.split(":") as [FilterGroup, string];
  switch (group) {
    case "made":
      return t.filters.made[value as keyof Dict["filters"]["made"]];
    case "draw":
      return t.filters.draw[value as keyof Dict["filters"]["draw"]];
    case "eq":
      return t.filters.eq[value as keyof Dict["filters"]["eq"]];
    case "band":
      return t.filters.band(value);
    default:
      return t.filters.suit(SUIT_SYMBOL[value[1] as Suit], value[0] === "s");
  }
}

/** The active filters as chips (the view's toolbar): a click removes one. */
export function ActiveFilters({ filter, onFilter }: { filter: HandFilter; onFilter: (next: HandFilter) => void }) {
  const t = useSolverDict();
  const active = [...filter.include.map((id) => ({ id, mode: "include" as const })), ...filter.exclude.map((id) => ({ id, mode: "exclude" as const }))];
  if (!active.length) return null;
  return (
    <>
      {active.map(({ id, mode }) => (
        <Chip
          key={`${mode}${id}`}
          out={mode === "exclude"}
          label={t.filters.remove(filterLabel(id, t))}
          onRemove={() => onFilter({ ...filter, [mode]: filter[mode].filter((x) => x !== id) })}
        >
          {t.filters.active(mode)} {filterLabel(id, t)}
        </Chip>
      ))}
    </>
  );
}

export function HandFilters({
  data,
  filter,
  onFilter,
  colours,
}: {
  data: RangeData | null;
  filter: HandFilter;
  onFilter: (next: HandFilter) => void;
  /** The actions' colours (`actionColours`), in the node's order. */
  colours: readonly string[];
}) {
  const t = useSolverDict();
  const [mode, setMode] = useState<Mode>("include");
  const picked = filter[mode];

  // The acting player's share of each category, filter or not, and how it plays.
  const shares = useMemo(() => {
    const out = new Map<string, { share: number; mix: number[] }>();
    if (!data) return out;
    const p = data.ranges.actor;
    const side = data.ranges.sides[p];
    const size = side.hands.length;
    let all = 0;
    side.hands.forEach((_, i) => {
      const r = side.reach[i];
      if (r <= 0) return;
      all += r;
      for (const id of comboIds(data.cards[p][i], data.features[p][i], data.equity ? data.equity[p][i] : Number.NaN)) {
        let entry = out.get(id);
        if (!entry) {
          entry = { share: 0, mix: new Array<number>(data.actions).fill(0) };
          out.set(id, entry);
        }
        entry.share += r;
        for (let a = 0; a < data.actions; a += 1) entry.mix[a] += r * data.strategy[a * size + i];
      }
    });
    for (const entry of out.values()) {
      entry.mix = entry.mix.map((m) => (entry.share > 0 ? m / entry.share : 0));
      entry.share = all > 0 ? entry.share / all : 0;
    }
    return out;
  }, [data]);

  if (!data) return null;
  const river = data.ranges.board.length >= 5;
  const rows = (group: FilterGroup, values: readonly string[]): Row[] =>
    values
      .map((value) => filterId(group, value))
      .filter((id) => (shares.get(id)?.share ?? 0) > 0 || picked.includes(id))
      .map((id) => ({ id, label: filterLabel(id, t), share: shares.get(id)?.share ?? 0, mix: shares.get(id)?.mix ?? [] }));

  const set = (next: string[]) => onFilter({ ...filter, [mode]: next });
  const toggle = (id: string) => set(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const andAbove = (group: FilterGroup, list: Row[], at: number) => {
    const others = picked.filter((id) => !id.startsWith(`${group}:`));
    set([...others, ...list.slice(0, at + 1).map((row) => row.id)]);
  };

  const groups: Array<{ group: Exclude<FilterGroup, "suit">; list: Row[]; hint?: string }> = [
    { group: "made", list: rows("made", MADE_HANDS) },
    { group: "eq", list: data.equity ? rows("eq", EQ_BUCKETS) : [], hint: t.filters.eqHint },
    ...(river ? [] : [{ group: "draw" as const, list: rows("draw", DRAWS) }]),
    { group: "band", list: data.equity ? rows("band", EQ_BANDS) : [] },
  ];
  const active = filter.include.length + filter.exclude.length;

  return (
    <div className={styles.filters}>
      <div className={styles.filterTop}>
        <Segmented
          label={t.filters.title}
          size="sm"
          value={mode}
          options={(["include", "exclude"] as const).map((m) => ({ value: m, label: t.filters[m] }))}
          onChange={setMode}
        />
        {active ? (
          <ToolButton size="sm" onClick={() => onFilter({ include: [], exclude: [] })}>
            {t.filters.clear}
          </ToolButton>
        ) : null}
      </div>

      <div className={styles.suitRow}>
        {([false, true] as const).map((suited) => (
          <div key={String(suited)} className={styles.suitGroup}>
            <span className={analysis.muted}>{suited ? t.filters.suited : t.filters.offsuit}</span>
            {SUITS.map((suit) => {
              const id = filterId("suit", `${suited ? "s" : "o"}${suit}`);
              return (
                <button
                  key={suit}
                  type="button"
                  className={`${styles.suitToggle} ${styles[`suitText${suit.toUpperCase()}`] ?? ""}`}
                  aria-pressed={picked.includes(id)}
                  aria-label={filterLabel(id, t)}
                  title={filterLabel(id, t)}
                  onClick={() => toggle(id)}
                >
                  {suited ? `${SUIT_SYMBOL[suit]}${SUIT_SYMBOL[suit]}` : SUIT_SYMBOL[suit]}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <p className={analysis.muted}>{t.filters.forPlayer(data.ranges.sides[data.ranges.actor].position)}</p>
      {!data.equity ? <p className={analysis.muted}>{t.ranges.computing}</p> : null}

      <div className={styles.filterGroups}>
        {groups
          .filter(({ list }) => list.length > 0)
          .map(({ group, list, hint }) => (
            <section key={group} className={styles.filterGroup} aria-label={t.filters.groups[group]}>
              <h3 className={styles.filterHead} title={hint}>
                {t.filters.groups[group]}
              </h3>
              <ul className={styles.filterRows}>
                {list.map((row, at) => {
                  const on = picked.includes(row.id);
                  const other = filter[mode === "include" ? "exclude" : "include"].includes(row.id);
                  return (
                    <li key={row.id} className={styles.filterRow}>
                      <button
                        type="button"
                        className={`${styles.filterPick} ${on ? (mode === "include" ? styles.filterOn : styles.filterOff) : ""} ${other ? styles.filterOther : ""}`}
                        aria-pressed={on}
                        onClick={() => toggle(row.id)}
                      >
                        <span className={styles.filterName}>{row.label}</span>
                        <span className={styles.filterShare}>{t.filters.share(row.share)}</span>
                        <MixBar mix={row.mix} colours={colours} thin />
                      </button>
                      <button
                        type="button"
                        className={styles.filterAbove}
                        aria-label={t.filters.andAbove(row.label)}
                        title={t.filters.andAbove(row.label)}
                        onClick={() => andAbove(group, list, at)}
                      >
                        ▲
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}

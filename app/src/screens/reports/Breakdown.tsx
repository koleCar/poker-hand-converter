/**
 * Reports' breakdowns (guideline §6: "results by position and situation";
 * R2.7b): the hero's hands of the filter split one way at a time - by
 * position, stake, table size, room or game (the rollups' rows, with the
 * report), or by pot type, stack depth, players dealt in, street reached or
 * starting hand (one pass over the hero's rows, asked for when such a tab
 * opens). A table, as on the web: a row per value, a column per statistic,
 * every value the R2.4 definition's with its R2.5 reliability (faded on a
 * thin sample, the sample and interval in its tooltip). Starting hands are
 * the web's 13 x 13 grid as well.
 *
 * The tab is the route's parameter (`#/reports/<tab>`), which is how the
 * command palette opens one.
 */
import { useId, useRef, type KeyboardEvent } from "react";
import type { StatDefinition } from "@rail/ui/model/stats";
import { StatValue } from "@rail/ui/stats/StatValue";

import { useLocale, useT } from "../../i18n";
import type { Breakdowns, HandFacets, Report, StatGroup } from "../../lib/ipc";
import { FORMAT_ORDER, POSITION_ORDER, POT_TYPE_ORDER, SIZE_ORDER } from "../hands/filter";
import { stakeLabel } from "../hands/format";
import { HandMatrix } from "./HandMatrix";
import styles from "./Reports.module.css";

export const TABS = [
  "position",
  "potType",
  "stack",
  "handClass",
  "players",
  "street",
  "stake",
  "size",
  "site",
  "format",
] as const;

export type Tab = (typeof TABS)[number];

/** The tabs whose rows come from the breakdowns by situation. */
const SITUATION: readonly Tab[] = ["potType", "stack", "handClass", "players", "street"];

export function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

export function needsBreakdowns(tab: Tab): boolean {
  return SITUATION.includes(tab);
}

const STACK_ORDER = ["0-20", "20-40", "40-70", "70-100", "100-150", "150-250", "250+"];
const STREET_ORDER = ["preflop", "flop", "turn", "river", "showdown"];

function rank(order: readonly string[], key: string): number {
  const index = order.indexOf(key);
  return index < 0 ? order.length : index;
}

/** A tab's rows, in the order a player reads them. */
function ordered(tab: Tab, rows: StatGroup[]): StatGroup[] {
  const list = [...rows];
  const by = (order: readonly string[]) => list.sort((a, b) => rank(order, a.key) - rank(order, b.key));
  switch (tab) {
    case "position":
      return by(POSITION_ORDER);
    case "potType":
      return by(POT_TYPE_ORDER);
    case "stack":
      return by(STACK_ORDER);
    case "street":
      return by(STREET_ORDER);
    case "size":
      return by(SIZE_ORDER);
    case "format":
      return by(FORMAT_ORDER);
    case "players":
      return list.sort((a, b) => Number(a.key) - Number(b.key));
    default:
      // Stakes, rooms and starting hands: the biggest sample first.
      return list.sort((a, b) => b.hands - a.hands || a.key.localeCompare(b.key));
  }
}

function rowsOf(tab: Tab, report: Report, breakdowns: Breakdowns | null): StatGroup[] | null {
  switch (tab) {
    case "position":
      return report.byPosition;
    case "stake":
      return report.byStake;
    case "size":
      return report.bySize;
    case "site":
      return report.bySite;
    case "format":
      return report.byFormat;
    case "potType":
      return breakdowns?.potType ?? null;
    case "stack":
      return breakdowns?.stack ?? null;
    case "handClass":
      return breakdowns?.handClass ?? null;
    case "players":
      return breakdowns?.players ?? null;
    case "street":
      return breakdowns?.street ?? null;
  }
}

/** A row's first cell. */
function useLabel(tab: Tab, facets: HandFacets | null): (row: StatGroup) => string {
  const t = useT();
  const f = t.hands.filters;
  const b = t.reports.breakdown;
  return (row) => {
    const key = row.key;
    switch (tab) {
      case "position":
        return key === "" ? b.noPosition : key;
      case "stake": {
        if (key === "chips") return f.chips;
        const facet = facets?.stakes.find((stake) => stake.value === key);
        return (facet ? stakeLabel(facet) : null) ?? key;
      }
      case "size":
        return (f.sizes as Record<string, string>)[key] ?? key;
      case "site":
        return row.label ?? key;
      case "format":
        return (f.formats as Record<string, string>)[key] ?? key;
      case "potType":
        return (f.potTypes as Record<string, string>)[key] ?? key;
      case "stack":
        return b.stacks[key] ?? key;
      case "players":
        return key === "2" ? b.headsUp : b.handed(key);
      case "street":
        return b.streets[key] ?? key;
      case "handClass":
        return key === "" ? b.unknown : key;
    }
  };
}

interface BreakdownProps {
  report: Report;
  breakdowns: Breakdowns | null;
  loading: boolean;
  definitions: readonly StatDefinition[];
  facets: HandFacets | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
}

export function Breakdown({ report, breakdowns, loading, definitions, facets, tab, onTab }: BreakdownProps) {
  const t = useT();
  const b = t.reports.breakdown;
  const label = useLabel(tab, facets);
  const rows = rowsOf(tab, report, breakdowns);
  const columns = (breakdowns && needsBreakdowns(tab) ? breakdowns.columns : report.columns).map(
    (id) => definitions.find((definition) => definition.id === id) ?? null,
  );
  const tabsRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Arrow keys move between tabs (the ARIA tabs pattern).
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const chosen = TABS[next];
    if (chosen) {
      onTab(chosen);
      tabsRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
    }
  };

  return (
    <section className={styles.card} aria-labelledby={`${panelId}-heading`}>
      <div className={styles.cardHead}>
        <h2 id={`${panelId}-heading`} className={styles.cardTitle}>
          {b.heading}
        </h2>
      </div>
      <div className={styles.tabs} role="tablist" aria-label={b.splitBy} ref={tabsRef} onKeyDown={onKey}>
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            id={`${panelId}-${entry}`}
            aria-selected={entry === tab}
            aria-controls={`${panelId}-panel`}
            tabIndex={entry === tab ? 0 : -1}
            className={`chip-btn ${styles.tab}${entry === tab ? " is-active" : ""}`}
            onClick={() => onTab(entry)}
          >
            {b.tabs[entry]}
          </button>
        ))}
      </div>
      <div id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className={styles.panel}>
        {rows === null ? (
          <p className={styles.muted} role="status" aria-busy={loading}>
            {b.computing}
          </p>
        ) : rows.length === 0 ? (
          <p className={styles.muted}>{b.empty}</p>
        ) : (
          <>
            {tab === "handClass" ? <HandMatrix rows={rows} columns={columns} /> : null}
            <GroupTable head={b.heads[tab]} rows={ordered(tab, rows)} columns={columns} label={label} />
          </>
        )}
      </div>
    </section>
  );
}

/** Rows of groups, a column per statistic. */
export function GroupTable({
  head,
  rows,
  columns,
  label,
}: {
  head: string;
  rows: StatGroup[];
  columns: (StatDefinition | null)[];
  label: (row: StatGroup) => string;
}) {
  const locale = useLocale();
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{head}</th>
            {columns.map((definition, index) =>
              definition ? (
                <th key={definition.id} scope="col" className={styles.number} title={definition.name[locale]}>
                  {definition.label[locale]}
                </th>
              ) : (
                <th key={index} scope="col" />
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{label(row)}</th>
              {row.stats.map((shown, index) => {
                const definition = columns[index];
                return (
                  <td key={definition?.id ?? index} className={styles.number}>
                    {definition ? <StatValue shown={shown} unit={definition.format.unit} /> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


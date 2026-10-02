/**
 * The HUD, one row per position — or per table size, stack depth, stake, room.
 *
 * A table rather than a chart, deliberately: the reader compares *across* a
 * row ("my BTN is fine, my SB bleeds") and *down* a column ("my 3-bet is 4% from
 * every seat"), and a grid of numbers is the one layout that does both.
 *
 * Every rate is `rates()` from `lib/stats` over the row's sums — the same
 * division the HUD tiles use — so a cell and the tile above it can only
 * disagree if the samples do.
 */

"use client";

import { useEffect, useState } from "react";
import {
  fetchStatsBreakdown,
  type BreakdownGroup,
  type BreakdownRow,
  type StakeVolume,
  type StatsBreakdown,
  type StatsFilters,
} from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { getParser } from "../../lib/phf";
import { emptyMoney, rates, type StatsRates } from "../../lib/stats";
import { POSITIONS } from "../handFilters";
import { countIn, numberFormat, stakeLabel, useIntlLocale } from "./format";

interface BreakdownPanelProps {
  filters: StatsFilters;
  /** The library's stakes, to label `stakes` keys and to know if the split is worth offering. */
  stakes: StakeVolume[];
  /** Bumped when the numbers above reload, so this follows them. */
  refreshToken: number;
}

/** In button order; labels and headings are `stats.breakdown.groups`. */
const GROUPS = ["position", "pot_type", "table_size", "stack_bb", "stakes", "site"] as const satisfies readonly BreakdownGroup[];

/** Below this many opportunities a percentage is shown, but dimmed. */
const THIN_SAMPLE = 20;

type Column = {
  /** Also the key of its heading and tooltip in `stats.columns`. */
  id: keyof Dict["stats"]["columns"];
  rate: (r: StatsRates) => number | null;
  opp: (row: BreakdownRow) => number;
};

const COLUMNS: Column[] = [
  { id: "vpip", rate: (r) => r.vpip, opp: (x) => x.counters.vpip_opp },
  { id: "pfr", rate: (r) => r.pfr, opp: (x) => x.counters.pfr_opp },
  { id: "rfi", rate: (r) => r.rfi, opp: (x) => x.counters.rfi_opp },
  { id: "threeBet", rate: (r) => r.threeBet, opp: (x) => x.counters.three_bet_opp },
  { id: "foldToThreeBet", rate: (r) => r.foldToThreeBet, opp: (x) => x.counters.fold_to_three_bet_opp },
  { id: "steal", rate: (r) => r.steal, opp: (x) => x.counters.steal_opp },
  { id: "cbet", rate: (r) => r.cbetFlop, opp: (x) => x.counters.cbet_flop_opp },
  { id: "wtsd", rate: (r) => r.wtsd, opp: (x) => x.counters.wtsd_opp },
  { id: "wsd", rate: (r) => r.wsd, opp: (x) => x.counters.wsd_opp },
];

const STACK_ORDER = ["0-20", "20-40", "40-70", "70-100", "100-150", "150-250", "250+"];
const POT_ORDER = ["walk", "limped", "single-raised", "3bet", "4bet+", "bomb"];

function order(group: BreakdownGroup, rows: BreakdownRow[]): BreakdownRow[] {
  const sorted = [...rows];
  const rank = (list: readonly string[], key: string | null) => {
    const index = key === null ? -1 : list.indexOf(key);
    return index === -1 ? list.length : index;
  };
  if (group === "position") {
    sorted.sort((a, b) => rank(POSITIONS, a.key) - rank(POSITIONS, b.key));
  } else if (group === "pot_type") {
    sorted.sort((a, b) => rank(POT_ORDER, a.key) - rank(POT_ORDER, b.key));
  } else if (group === "stack_bb") {
    sorted.sort((a, b) => rank(STACK_ORDER, a.key) - rank(STACK_ORDER, b.key));
  } else if (group === "table_size") {
    sorted.sort((a, b) => Number(a.key ?? 99) - Number(b.key ?? 99));
  }
  // `stakes` and `site` keep the server's order: biggest sample first.
  return sorted;
}

function label(group: BreakdownGroup, key: string | null, stakes: StakeVolume[], t: Dict["stats"]): string {
  if (key === null) {
    return t.breakdown.unknown;
  }
  if (group === "site") {
    return getParser(key)?.name ?? key;
  }
  if (group === "pot_type") {
    return t.breakdown.potTypes[key] ?? key;
  }
  if (group === "table_size") {
    return key === "2" ? t.breakdown.headsUp : t.breakdown.handed(key);
  }
  if (group === "stakes") {
    const match = stakes.find(
      (stake) => `${stake.currency}:${stake.smallBlind ?? ""}:${stake.bigBlind ?? ""}` === key,
    );
    return match ? stakeLabel(match, t.common.unknownStakes) : key;
  }
  return key;
}

export function BreakdownPanel({ filters, stakes, refreshToken }: BreakdownPanelProps) {
  const t = useDict().stats;
  const en = t.breakdown;
  const locale = useIntlLocale();
  const count = countIn(locale);
  const pct = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const bb100 = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: "exceptZero" });
  const [group, setGroup] = useState<BreakdownGroup>("position");
  const [data, setData] = useState<StatsBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let live = true;
    fetchStatsBreakdown(JSON.parse(filterKey) as StatsFilters, group).then(
      (next) => {
        if (live) {
          setData(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (live) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [filterKey, group, refreshToken]);

  // A split with one value is not a split: stakes are offered only when the
  // scope spans several.
  const scopedStakes = stakes.filter(
    (stake) => !filters.gameFormat || stake.gameFormat === filters.gameFormat,
  );
  const offered = GROUPS.filter((entry) => {
    if (entry === "stakes") {
      return scopedStakes.length > 1 && filters.bigBlind === undefined;
    }
    return true;
  });

  const current = en.groups[GROUPS.find((entry) => entry === group) ?? GROUPS[0]];
  const rows = data && data.group === group ? order(group, data.rows) : [];
  const moneyShown = rows.some((row) => row.money !== null);

  return (
    <section className="card stats-group">
      <div className="card__head stats-breakdown__head">
        <h3>{en.heading}</h3>
        <div className="stats-scope__formats" role="group" aria-label={en.splitBy}>
          {offered.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`btn btn--sm${entry === group ? " btn--primary" : ""}`}
              aria-pressed={entry === group}
              onClick={() => setGroup(entry)}
            >
              {en.groups[entry].label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="notice notice--error">{error}</p> : null}

      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th scope="col">{current.head}</th>
              <th scope="col" className="num">
                {t.common.handsHead}
              </th>
              {moneyShown ? (
                <th scope="col" className="num" title={en.bb100Title}>
                  {t.common.bb100}
                </th>
              ) : null}
              {COLUMNS.map((column) => (
                <th key={column.id} scope="col" className="num" title={t.columns[column.id].title}>
                  {t.columns[column.id].head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const r = rates({
                counters: row.counters,
                money: row.money ?? emptyMoney(),
                moneyHands: row.moneyHands,
              });
              return (
                <tr key={row.key ?? "unknown"}>
                  <th scope="row">{label(group, row.key, stakes, t)}</th>
                  <td className="num">{count(row.counters.hands)}</td>
                  {moneyShown ? (
                    <td
                      className={`num ${
                        row.money === null || r.bb100 === null
                          ? ""
                          : r.bb100 >= 0
                            ? "is-up"
                            : "is-down"
                      } ${row.moneyHands < 100 ? "is-thin" : ""}`}
                      title={
                        row.money ? en.moneyTitle(bb100.format(r.netBb), row.moneyHands) : undefined
                      }
                    >
                      {row.money && r.bb100 !== null ? bb100.format(r.bb100) : "—"}
                    </td>
                  ) : null}
                  {COLUMNS.map((column) => {
                    const value = column.rate(r);
                    const opp = column.opp(row);
                    return (
                      <td
                        key={column.id}
                        className={`num ${opp < THIN_SAMPLE ? "is-thin" : ""}`}
                        title={value === null ? undefined : en.opportunities(opp)}
                      >
                        {value === null ? "—" : pct.format(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted stats-breakdown__note">{en.note(THIN_SAMPLE)}</p>
    </section>
  );
}

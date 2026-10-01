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
import { getParser } from "../../lib/phf";
import { emptyMoney, rates, type StatsRates } from "../../lib/stats";
import { POSITIONS } from "../handFilters";
import { count, stakeLabel } from "./format";

interface BreakdownPanelProps {
  filters: StatsFilters;
  /** The library's stakes, to label `stakes` keys and to know if the split is worth offering. */
  stakes: StakeVolume[];
  /** Bumped when the numbers above reload, so this follows them. */
  refreshToken: number;
}

const GROUPS: Array<{ id: BreakdownGroup; label: string; head: string }> = [
  { id: "position", label: "Position", head: "Position" },
  { id: "table_size", label: "Table size", head: "Players" },
  { id: "stack_bb", label: "Stack depth", head: "Stack (bb)" },
  { id: "stakes", label: "Stakes", head: "Stakes" },
  { id: "site", label: "Room", head: "Room" },
];

/** Below this many opportunities a percentage is shown, but dimmed. */
const THIN_SAMPLE = 20;

const PCT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const BB100 = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
  signDisplay: "exceptZero",
});

type Column = {
  id: string;
  head: string;
  title: string;
  rate: (r: StatsRates) => number | null;
  opp: (row: BreakdownRow) => number;
};

const COLUMNS: Column[] = [
  { id: "vpip", head: "VPIP", title: "Voluntarily put money in pot", rate: (r) => r.vpip, opp: (x) => x.counters.vpip_opp },
  { id: "pfr", head: "PFR", title: "Preflop raise", rate: (r) => r.pfr, opp: (x) => x.counters.pfr_opp },
  { id: "rfi", head: "RFI", title: "Raised first in", rate: (r) => r.rfi, opp: (x) => x.counters.rfi_opp },
  { id: "3b", head: "3-bet", title: "3-bet facing one raise", rate: (r) => r.threeBet, opp: (x) => x.counters.three_bet_opp },
  { id: "f3b", head: "F3B", title: "Fold to 3-bet after opening", rate: (r) => r.foldToThreeBet, opp: (x) => x.counters.fold_to_three_bet_opp },
  { id: "steal", head: "Steal", title: "Steal attempt from CO, BTN or SB", rate: (r) => r.steal, opp: (x) => x.counters.steal_opp },
  { id: "cbet", head: "Cbet", title: "Flop continuation bet", rate: (r) => r.cbetFlop, opp: (x) => x.counters.cbet_flop_opp },
  { id: "wtsd", head: "WTSD", title: "Went to showdown, having seen a flop", rate: (r) => r.wtsd, opp: (x) => x.counters.wtsd_opp },
  { id: "wsd", head: "W$SD", title: "Won money at showdown", rate: (r) => r.wsd, opp: (x) => x.counters.wsd_opp },
];

const STACK_ORDER = ["0-20", "20-40", "40-70", "70-100", "100-150", "150-250", "250+"];

function order(group: BreakdownGroup, rows: BreakdownRow[]): BreakdownRow[] {
  const sorted = [...rows];
  const rank = (list: readonly string[], key: string | null) => {
    const index = key === null ? -1 : list.indexOf(key);
    return index === -1 ? list.length : index;
  };
  if (group === "position") {
    sorted.sort((a, b) => rank(POSITIONS, a.key) - rank(POSITIONS, b.key));
  } else if (group === "stack_bb") {
    sorted.sort((a, b) => rank(STACK_ORDER, a.key) - rank(STACK_ORDER, b.key));
  } else if (group === "table_size") {
    sorted.sort((a, b) => Number(a.key ?? 99) - Number(b.key ?? 99));
  }
  // `stakes` and `site` keep the server's order: biggest sample first.
  return sorted;
}

function label(group: BreakdownGroup, key: string | null, stakes: StakeVolume[]): string {
  if (key === null) {
    return "Unknown";
  }
  if (group === "site") {
    return getParser(key)?.name ?? key;
  }
  if (group === "table_size") {
    return key === "2" ? "Heads-up" : `${key}-handed`;
  }
  if (group === "stakes") {
    const match = stakes.find(
      (stake) => `${stake.currency}:${stake.smallBlind ?? ""}:${stake.bigBlind ?? ""}` === key,
    );
    return match ? stakeLabel(match) : key;
  }
  return key;
}

export function BreakdownPanel({ filters, stakes, refreshToken }: BreakdownPanelProps) {
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
    if (entry.id === "stakes") {
      return scopedStakes.length > 1 && filters.bigBlind === undefined;
    }
    return true;
  });

  const current = GROUPS.find((entry) => entry.id === group) ?? GROUPS[0];
  const rows = data && data.group === group ? order(group, data.rows) : [];
  const moneyShown = rows.some((row) => row.money !== null);

  return (
    <section className="card stats-group">
      <div className="card__head stats-breakdown__head">
        <h3>Breakdown</h3>
        <div className="stats-scope__formats" role="group" aria-label="Split by">
          {offered.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`btn btn--sm${entry.id === group ? " btn--primary" : ""}`}
              aria-pressed={entry.id === group}
              onClick={() => setGroup(entry.id)}
            >
              {entry.label}
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
                Hands
              </th>
              {moneyShown ? (
                <th scope="col" className="num" title="Big blinds won per 100 hands">
                  bb/100
                </th>
              ) : null}
              {COLUMNS.map((column) => (
                <th key={column.id} scope="col" className="num" title={column.title}>
                  {column.head}
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
                  <th scope="row">{label(group, row.key, stakes)}</th>
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
                        row.money ? `${BB100.format(r.netBb)} bb over ${count(row.moneyHands)} hands` : undefined
                      }
                    >
                      {row.money && r.bb100 !== null ? BB100.format(r.bb100) : "—"}
                    </td>
                  ) : null}
                  {COLUMNS.map((column) => {
                    const value = column.rate(r);
                    const opp = column.opp(row);
                    return (
                      <td
                        key={column.id}
                        className={`num ${opp < THIN_SAMPLE ? "is-thin" : ""}`}
                        title={value === null ? undefined : `${count(opp)} opportunities`}
                      >
                        {value === null ? "—" : PCT.format(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted stats-breakdown__note">
        Grey numbers rest on fewer than {THIN_SAMPLE} opportunities, and a dotted win rate on
        fewer than 100 hands — a direction, not a reading.
      </p>
    </section>
  );
}

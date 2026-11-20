/**
 * Reports' statistics as matrices, the way an opponent's profile shows them
 * (`players/PlayerStats.tsx`, the Players redesign): a strip of the numbers
 * read first, then preflop, the steal and the blinds, showdown and results
 * by the hero's position (a total column, then each position the report has
 * hands in), and postflop by street. Names are the definitions' short labels
 * (VPIP, 3B, W$SD...); the full name and what it counts are in the tooltip.
 *
 * Every cell is a `Shown` as the surface computed it: the total from the
 * report's summary, a position's from `Report.positionStats` (every shipped
 * definition; a surface that does not send them shows the total column
 * only). This lays them out and divides nothing: the value at its
 * reliability's opacity, a thin sample's size beside it, the sample and
 * interval in its tooltip, its tone's colour. The user's own statistics
 * (R2.10, the desktop's) follow in a table of their own, total only.
 */
import type { ReactNode } from "react";

import { POSITION_ORDER } from "../hands/filter";
import { useUiStrings } from "../i18n";
import type { Shown, StatDefinition } from "../model/stats";
import { countIn } from "../stats/format";
import styles from "../stats/StatMatrix.module.css";
import { useStatTip } from "../stats/StatTip";
import { decimalMark, shownText } from "../stats/StatValue";
import { shownOf, textLocale } from "./definitions";
import type { Definition, Report } from "./model";

type StreetRowKey = keyof ReturnType<typeof useUiStrings>["reports"]["stats"]["streetRows"];

interface PositionRow {
  id: string;
  /** The positions it applies to (all when absent); the total always. */
  only?: (position: string) => boolean;
}

interface StreetRow {
  key: StreetRowKey;
  /** All streets, flop, turn, river; `null` where it does not apply. */
  cells: readonly [string | null, string | null, string | null, string | null];
}

const notBigBlind = (position: string) => position !== "BB";
const stealer = (position: string) => position === "CO" || position === "BTN" || position === "SB";
const blind = (position: string) => position === "SB" || position === "BB";

const PREFLOP: readonly PositionRow[] = [
  { id: "vpip" },
  { id: "pfr" },
  { id: "rfi", only: notBigBlind },
  { id: "limp", only: notBigBlind },
  { id: "iso" },
  { id: "cold_call" },
  { id: "three_bet" },
  { id: "fold_to_three_bet" },
  { id: "call_three_bet" },
  { id: "four_bet" },
  { id: "fold_to_four_bet" },
  { id: "five_bet" },
  { id: "squeeze" },
];

const STEAL: readonly PositionRow[] = [
  { id: "steal", only: stealer },
  { id: "fold_to_steal", only: blind },
  { id: "call_steal", only: blind },
  { id: "three_bet_vs_steal", only: blind },
];

const SHOWDOWN: readonly PositionRow[] = [{ id: "saw_flop" }, { id: "wwsf" }, { id: "wtsd" }, { id: "wsd" }];

const RESULTS: readonly PositionRow[] = [
  { id: "bb_per_100" },
  { id: "allin_ev_bb_per_100" },
  { id: "net_bb" },
  { id: "rake_per_100" },
];

const POSTFLOP: readonly StreetRow[] = [
  { key: "cbet", cells: [null, "cbet_flop", "cbet_turn", "cbet_river"] },
  { key: "foldToCbet", cells: [null, "fold_to_cbet_flop", "fold_to_cbet_turn", "fold_to_cbet_river"] },
  { key: "raiseCbet", cells: [null, "raise_cbet_flop", "raise_cbet_turn", "raise_cbet_river"] },
  { key: "donk", cells: [null, "donk_flop", "donk_turn", "donk_river"] },
  { key: "checkRaise", cells: [null, "check_raise_flop", "check_raise_turn", "check_raise_river"] },
  {
    key: "af",
    cells: ["aggression_factor", "aggression_factor_flop", "aggression_factor_turn", "aggression_factor_river"],
  },
  {
    key: "afq",
    cells: [
      "aggression_frequency",
      "aggression_frequency_flop",
      "aggression_frequency_turn",
      "aggression_frequency_river",
    ],
  },
];

/** The strip over the matrices (bb/100 is in the summary above). */
const KEY_STATS = [
  "vpip",
  "pfr",
  "rfi",
  "three_bet",
  "fold_to_three_bet",
  "steal",
  "cbet_flop",
  "aggression_factor",
  "wtsd",
  "wsd",
];

function rank(position: string): number {
  const index = POSITION_ORDER.indexOf(position);
  return index < 0 ? POSITION_ORDER.length : index;
}

export function ReportStats({ report, definitions }: { report: Report; definitions: readonly Definition[] }) {
  const all = useUiStrings();
  const t = all.reports.stats;
  const locale = all.intlLocale;
  const count = countIn(locale);
  const mark = decimalMark(locale);
  const text = textLocale(locale);
  const tip = useStatTip();
  const { summary } = report;

  const total = (id: string) => shownOf(definitions, summary.stats, id, summary.ids);
  const columns = report.positionColumns ?? [];
  const byPosition = new Map(
    (report.positionStats ?? [])
      .filter((row) => row.key !== "" && row.hands > 0)
      .map((row) => [row.key, row.stats] as const),
  );
  const positions = [...byPosition.keys()].sort((a, b) => rank(a) - rank(b));
  const at = (id: string, position: string) => {
    const stats = byPosition.get(position);
    return stats ? shownOf(definitions, stats, id, columns) : null;
  };

  /** A value; a thin sample's size beside it unless `quiet` (the results: their sample is the hands row's). */
  const cell = (found: { definition: StatDefinition; shown: Shown } | null, key: string, quiet = false) => {
    if (found === null) return <td key={key} className={styles.matrixEmpty} />;
    const { definition, shown } = found;
    const thin = !quiet && shown.reliability.level !== "ok" && shown.sample !== null && shown.sample > 0;
    return (
      <td
        key={key}
        data-tone={shown.tone ?? undefined}
        {...tip.on({ definition, shown, context: positions.includes(key) ? key : undefined })}
      >
        <span style={{ opacity: shown.reliability.opacity }}>{shownText(shown, definition.format.unit, mark, count)}</span>
        {thin ? <sub className={styles.matrixSample}>{count(shown.sample ?? 0)}</sub> : null}
      </td>
    );
  };

  /** A short name with the full one, what it counts and its ideal range on hover. */
  const name = (short: string, full: string, definition?: StatDefinition): ReactNode => {
    const on = tip.on({ definition, name: full, label: short });
    return short === full ? (
      <span {...on}>{short}</span>
    ) : (
      <abbr className={styles.abbr} {...on}>
        {short}
      </abbr>
    );
  };
  const definitionName = (definition: StatDefinition) => name(definition.label[text], definition.name[text], definition);

  const head = (labels: readonly string[]) => (
    <thead>
      <tr>
        <th scope="col" className={styles.matrixLabel}>
          <span className={styles.visuallyHidden}>{t.stat}</span>
        </th>
        {labels.map((label) => (
          <th scope="col" key={label}>
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );

  const positionTable = (caption: string, rows: readonly PositionRow[], withHands: boolean, quiet = false) => {
    const listed = rows.flatMap((row) => {
      const found = total(row.id);
      return found ? [{ row, found }] : [];
    });
    if (listed.length === 0) return null;
    const hands = withHands ? total("hands") : null;
    return (
      <table className={styles.matrix}>
        <caption className={styles.matrixCaption}>
          <span className={styles.matrixCaptionText}>{caption}</span>
        </caption>
        {head([t.total, ...positions])}
        <tbody>
          {hands ? (
            <tr className={styles.matrixHands}>
              <th scope="row" className={styles.matrixLabel}>
                {t.hands}
              </th>
              {cell(hands, "total")}
              {positions.map((position) => cell(at("hands", position), position))}
            </tr>
          ) : null}
          {listed.map(({ row, found }) => (
            <tr key={row.id}>
              <th scope="row" className={styles.matrixLabel}>
                {definitionName(found.definition)}
              </th>
              {cell(found, "total", quiet)}
              {positions.map((position) =>
                cell(row.only && !row.only(position) ? null : at(row.id, position), position, quiet),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const yours = definitions.filter((definition) => definition.custom && total(definition.id) !== null);

  return (
    <div className={styles.statsBlock}>
      <dl className={styles.keyStats}>
        {KEY_STATS.map((id) => {
          const found = total(id);
          if (found === null) return null;
          const { definition, shown } = found;
          return (
            <div key={id} className={styles.keyStat} data-tone={shown.tone ?? undefined}>
              <dd style={{ opacity: shown.reliability.opacity }} {...tip.on({ definition, shown })}>
                {shownText(shown, definition.format.unit, mark, count)}
              </dd>
              <dt>{definitionName(definition)}</dt>
            </div>
          );
        })}
      </dl>

      <div className={styles.matrices}>
        <div className={styles.matrixColumn}>
          {positionTable(t.sections.preflop, PREFLOP, true)}
          {positionTable(t.sections.steal, STEAL, false)}
        </div>
        <div className={styles.matrixColumn}>
          <table className={styles.matrix}>
            <caption className={styles.matrixCaption}>
              <span className={styles.matrixCaptionText}>{t.sections.postflop}</span>
            </caption>
            {head([t.streets.all, t.streets.flop, t.streets.turn, t.streets.river])}
            <tbody>
              {POSTFLOP.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className={styles.matrixLabel}>
                    {name(t.streetRows[row.key].short, t.streetRows[row.key].full)}
                  </th>
                  {row.cells.map((id, index) => cell(id === null ? null : total(id), String(index)))}
                </tr>
              ))}
            </tbody>
          </table>
          {positionTable(t.sections.showdown, SHOWDOWN, false)}
          {positionTable(t.sections.results, RESULTS, false, true)}
          {yours.length > 0 ? (
            <table className={styles.matrix}>
              <caption className={styles.matrixCaption}>
                <span className={styles.matrixCaptionText}>{t.sections.yours}</span>
              </caption>
              {head([t.total])}
              <tbody>
                {yours.map((definition) => (
                  <tr key={definition.id}>
                    <th scope="row" className={styles.matrixLabel}>
                      {definitionName(definition)}
                    </th>
                    {cell(total(definition.id), "total")}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
      {tip.layer}
    </div>
  );
}

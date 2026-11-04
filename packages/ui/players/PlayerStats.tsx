/**
 * An opponent's statistics as matrices (the Players redesign, after Hand2Note's
 * statistics dashboard): a strip of the numbers read first, then preflop, the
 * steal and the blinds, and showdown by position class (Total, EP, MP, CO,
 * BTN, SB, BB) and postflop by street (Flop, Turn, River).
 *
 * A cell is a definition's `Shown` as the store computed it - this lays them
 * out and divides nothing: the value at its reliability's opacity, a thin
 * sample's size beside it, the sample and interval in its tooltip, its tone's
 * colour. A cell with no definition yet ("planned") is drawn as a dash and its
 * row dimmed: the layout shows where the statistic goes before the engine
 * counts it. A cell that does not apply (a big blind's open raise) is empty.
 */
import { useUiStrings } from "../i18n";
import type { Shown, StatDefinition } from "../model/stats";
import { shownOf, textLocale } from "../reports/definitions";
import { countIn } from "../stats/format";
import { decimalMark, shownText, shownTitle } from "../stats/StatValue";
import { POSITION_CLASSES, type PlayerProfile as Profile } from "./model";
import styles from "./Players.module.css";

type RowKey = keyof ReturnType<typeof useUiStrings>["players"]["profile"]["rows"];
type Position = (typeof POSITION_CLASSES)[number];

/** A statistic's id, `PLANNED` (no definition yet) or `null` (does not apply). */
const PLANNED = "planned";
type Cell = string | null;

interface PositionRow {
  label: RowKey;
  /** The definition, or `PLANNED`. */
  id: string;
  /** The positions it applies to (all when absent); the total always. */
  only?: readonly Position[];
}

interface StreetRow {
  label: RowKey;
  /** All streets, flop, turn, river. */
  cells: readonly [Cell, Cell, Cell, Cell];
}

const OPENERS: readonly Position[] = ["EP", "MP", "CO", "BTN", "SB"];
const STEALERS: readonly Position[] = ["CO", "BTN", "SB"];
const BLINDS: readonly Position[] = ["SB", "BB"];

const PREFLOP: readonly PositionRow[] = [
  { label: "vpip", id: "vpip" },
  { label: "pfr", id: "pfr" },
  { label: "rfi", id: "rfi", only: OPENERS },
  { label: "limp", id: "limp", only: OPENERS },
  { label: "limpFold", id: PLANNED, only: OPENERS },
  { label: "iso", id: "iso" },
  { label: "coldCall", id: "cold_call" },
  { label: "threeBet", id: "three_bet" },
  { label: "foldTo3Bet", id: "fold_to_three_bet" },
  { label: "call3Bet", id: "call_three_bet" },
  { label: "fourBet", id: "four_bet" },
  { label: "foldTo4Bet", id: "fold_to_four_bet" },
  { label: "fiveBet", id: "five_bet" },
  { label: "squeeze", id: "squeeze" },
];

const STEAL: readonly PositionRow[] = [
  { label: "steal", id: "steal", only: STEALERS },
  { label: "stealFoldTo3Bet", id: PLANNED, only: STEALERS },
  { label: "foldToSteal", id: "fold_to_steal", only: BLINDS },
  { label: "callSteal", id: "call_steal", only: BLINDS },
  { label: "threeBetSteal", id: "three_bet_vs_steal", only: BLINDS },
];

const SHOWDOWN: readonly PositionRow[] = [
  { label: "sawFlop", id: "saw_flop" },
  { label: "wwsf", id: "wwsf" },
  { label: "wtsd", id: "wtsd" },
  { label: "wsd", id: "wsd" },
  { label: "winRate", id: "bb_per_100" },
];

const POSTFLOP: readonly StreetRow[] = [
  { label: "cbet", cells: [null, "cbet_flop", "cbet_turn", "cbet_river"] },
  { label: "cbet3Bet", cells: [null, PLANNED, PLANNED, PLANNED] },
  { label: "foldToCbet", cells: [null, "fold_to_cbet_flop", "fold_to_cbet_turn", "fold_to_cbet_river"] },
  { label: "raiseCbet", cells: [null, "raise_cbet_flop", "raise_cbet_turn", "raise_cbet_river"] },
  { label: "donk", cells: [null, "donk_flop", "donk_turn", "donk_river"] },
  { label: "checkRaise", cells: [null, "check_raise_flop", "check_raise_turn", "check_raise_river"] },
  { label: "betVsMissed", cells: [null, null, PLANNED, PLANNED] },
  { label: "af", cells: ["aggression_factor", "aggression_factor_flop", "aggression_factor_turn", "aggression_factor_river"] },
  { label: "afq", cells: ["aggression_frequency", "aggression_frequency_flop", "aggression_frequency_turn", "aggression_frequency_river"] },
];

/** The strip over the matrices: the numbers a reader looks for first. */
const KEY_STATS = ["vpip", "pfr", "three_bet", "fold_to_three_bet", "cbet_flop", "aggression_factor", "wtsd", "wsd", "bb_per_100"];

type Lookup = (id: string, stats: readonly Shown[]) => { definition: StatDefinition; shown: Shown } | null;

export function PlayerStats({ profile, definitions }: { profile: Profile; definitions: readonly StatDefinition[] }) {
  const all = useUiStrings();
  const t = all.players.profile;
  const locale = all.intlLocale;
  const count = countIn(locale);
  const mark = decimalMark(locale);
  const text = textLocale(locale);
  const lookup: Lookup = (id, stats) => shownOf(definitions, stats, id);

  const columns = profile.positionStats ?? [];
  const byPosition = new Map(columns.map((column) => [column.key, column.stats]));
  const positions = POSITION_CLASSES.filter((position) => byPosition.has(position));

  const value = (id: string | null, stats: readonly Shown[] | undefined, key: string) => {
    if (id === null || stats === undefined) return <td key={key} className={styles.matrixEmpty} />;
    if (id === PLANNED) {
      return (
        <td key={key} className={styles.matrixPlanned} title={t.planned}>
          –
        </td>
      );
    }
    const found = lookup(id, stats);
    if (found === null) return <td key={key} className={styles.matrixEmpty} />;
    const { definition, shown } = found;
    const thin = shown.reliability.level !== "ok" && shown.sample !== null && shown.sample > 0;
    return (
      <td key={key} data-tone={shown.tone ?? undefined} title={shownTitle(shown, all, count)}>
        <span style={{ opacity: shown.reliability.opacity }}>{shownText(shown, definition.format.unit, mark, count)}</span>
        {thin ? <sub className={styles.matrixSample}>{count(shown.sample ?? 0)}</sub> : null}
      </td>
    );
  };

  const positionTable = (caption: string, rows: readonly PositionRow[], withHands: boolean) => (
    <table className={styles.matrix}>
      <caption className={styles.matrixCaption}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col" className={styles.matrixLabel}>
            <span className={styles.visuallyHidden}>{t.stat}</span>
          </th>
          <th scope="col">{t.total}</th>
          {positions.map((position) => (
            <th scope="col" key={position}>
              {position}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {withHands ? (
          <tr className={styles.matrixHands}>
            <th scope="row" className={styles.matrixLabel}>
              {t.rows.hands}
            </th>
            {value("hands", profile.stats, "total")}
            {positions.map((position) => value("hands", byPosition.get(position), position))}
          </tr>
        ) : null}
        {rows.map((row) => (
          <tr key={row.label} className={row.id === PLANNED ? styles.matrixPlannedRow : undefined}>
            <th scope="row" className={styles.matrixLabel} title={row.id === PLANNED ? t.planned : definitionText(row.id)}>
              {t.rows[row.label]}
            </th>
            {value(row.id, profile.stats, "total")}
            {positions.map((position) =>
              value(row.only && !row.only.includes(position) ? null : row.id, byPosition.get(position), position),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );

  function definitionText(id: string): string | undefined {
    const definition = definitions.find((entry) => entry.id === id);
    return definition?.description[text];
  }

  const streets = [t.streets.all, t.streets.flop, t.streets.turn, t.streets.river];

  return (
    <div className={styles.statsBlock}>
      <dl className={styles.keyStats}>
        {KEY_STATS.map((id) => {
          const found = lookup(id, profile.stats);
          if (found === null) return null;
          const { definition, shown } = found;
          return (
            <div key={id} className={styles.keyStat} data-tone={shown.tone ?? undefined} title={shownTitle(shown, all, count)}>
              <dd style={{ opacity: shown.reliability.opacity }}>{shownText(shown, definition.format.unit, mark, count)}</dd>
              <dt>{definition.label[text]}</dt>
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
            <caption className={styles.matrixCaption}>{t.sections.postflop}</caption>
            <thead>
              <tr>
                <th scope="col" className={styles.matrixLabel}>
                  <span className={styles.visuallyHidden}>{t.stat}</span>
                </th>
                {streets.map((street) => (
                  <th scope="col" key={street}>
                    {street}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {POSTFLOP.map((row) => (
                <tr
                  key={row.label}
                  className={row.cells.every((cell) => cell === null || cell === PLANNED) ? styles.matrixPlannedRow : undefined}
                >
                  <th scope="row" className={styles.matrixLabel}>
                    {t.rows[row.label]}
                  </th>
                  {row.cells.map((cell, index) => value(cell, profile.stats, String(index)))}
                </tr>
              ))}
            </tbody>
          </table>
          {positionTable(t.sections.showdown, SHOWDOWN, false)}
        </div>
      </div>
    </div>
  );
}

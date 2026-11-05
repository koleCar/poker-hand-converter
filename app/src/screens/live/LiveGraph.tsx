/**
 * The Live screen's graph card (redesigned 2026-11-05, the owner's variant
 * B): one toolbar row over the shared win-rate graph - the session's result
 * (signed, coloured, in the screen's unit), its hands and its rate per 100
 * hands (bb/100, or the money's /100), then one chip per line that shows or
 * hides it, and the bb | money switch. The values of every line are the
 * graph's hover tooltip, not a legend under it; zoom and pan are the
 * graph's own (`@rail/ui/stats/WinrateGraph`).
 *
 * The graph is the Reports graph over the session's hands: `report` with
 * the session's start as the filter and no end, so a hand that lands moves
 * it. Read again whenever the session's hand count changes.
 */
import { kindFormats, type GameKind } from "@rail/ui/hands/gameKind";
import { useUiStrings } from "@rail/ui/i18n";
import { WinrateGraph, type SeriesKey, type WinrateGraphMoney } from "@rail/ui/stats/WinrateGraph";
import { useEffect, useState } from "react";

import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { errorText, ipc, type Report, type Session, type Units } from "../../lib/ipc";
import { GRAPH_POINTS } from "../../lib/reportSource";
import { bigBlinds, signedMoney, unitOf } from "../hands/format";
import { hasMoney, moneyUnitOf, useRate, type LiveUnit } from "./units";
import styles from "./Live.module.css";

/** The money view's currency, when the session has one. */
function moneyOf(units: Units): WinrateGraphMoney | null {
  if (units.mixedKind || units.mixedCurrency || units.currency === null || units.minorUnits === null) {
    return null;
  }
  const unit = unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits });
  const minorUnits = units.minorUnits;
  return { minorUnits, format: (amount: number) => signedMoney(unit, Math.round(amount * minorUnits)) };
}

/** The session's report (its kind of game's hands only), read again when a hand lands. */
function useSessionReport(startedAt: string, hands: number, kind: GameKind): { report: Report | null; error: string | null } {
  const [state, setState] = useState<{ report: Report | null; error: string | null }>({ report: null, error: null });
  useEffect(() => {
    let live = true;
    ipc
      .report({ from: startedAt, formats: kindFormats(kind) }, GRAPH_POINTS)
      .then((report) => {
        if (live) setState({ report, error: null });
      })
      .catch((error: unknown) => {
        if (live) setState((was) => ({ ...was, error: errorText(error) }));
      });
    return () => {
      live = false;
    };
  }, [startedAt, hands, kind]);
  return state;
}

/** The lines in the toolbar's order. */
const LINES: readonly SeriesKey[] = ["total", "allInEv", "showdown", "nonShowdown"];

interface LiveGraphProps {
  session: Session;
  kind: GameKind;
  unit: LiveUnit;
  onUnit: (unit: LiveUnit) => void;
}

export function LiveGraph({ session, kind, unit, onUnit }: LiveGraphProps) {
  const d = useT().live;
  const series = useUiStrings().winrateGraph.series;
  const { report, error } = useSessionReport(session.startedAt, session.hands, kind);
  const [hidden, setHidden] = useState<ReadonlySet<SeriesKey>>(() => new Set());
  const rate = useRate(session, unit);

  const money = report ? moneyOf(report.units) : null;
  const moneyUnit = moneyUnitOf(session);
  const inMoney = unit === "money" && moneyUnit !== null && session.net !== null;
  const value = inMoney ? session.net : session.netBbMilli;
  const result = inMoney && moneyUnit ? signedMoney(moneyUnit, session.net as number) : value !== null ? d.bb(bigBlinds(value)) : "—";
  const tone = (sign: number | null) => (sign === null || sign === 0 ? "" : sign > 0 ? styles.up : styles.down);

  const withEv = report?.graph.allInEv != null && report.graph.allInEv.allInHands > 0;
  const lines = LINES.filter((key) => key !== "allInEv" || withEv);
  const label = (key: SeriesKey) => series[key].label;
  const toggle = (key: SeriesKey) =>
    setHidden((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else if (lines.some((other) => other !== key && !next.has(other))) next.add(key);
      return next;
    });

  return (
    <section className={styles.card} aria-label={d.graph.label}>
      <div className={styles.toolbar}>
        <strong className={`${styles.toolResult} ${tone(value === null ? null : Math.sign(value))}`}>{result}</strong>
        <span className={styles.toolFigure}>{d.handsCount(session.hands)}</span>
        {rate ? (
          <span className={styles.toolFigure} title={d.rateTitle}>
            <span className={`${styles.toolValue} ${tone(rate.sign)}`}>{rate.value}</span> {rate.unit}
          </span>
        ) : null}
        <span className={styles.toolDivider} aria-hidden="true" />
        <span className={styles.lines} role="group" aria-label={d.graph.lines}>
          {lines.map((key) => {
            const off = hidden.has(key);
            return (
              <button
                key={key}
                type="button"
                className={off ? `${styles.line} ${styles.lineOff}` : styles.line}
                aria-pressed={!off}
                title={typeof series[key].hint === "string" ? series[key].hint : undefined}
                onClick={() => toggle(key)}
              >
                <span className={`stats-key stats-key--${key}`} aria-hidden="true" />
                {label(key)}
              </button>
            );
          })}
        </span>
        <span className={styles.toolSpacer} />
        <div className={styles.unitSwitch} role="group" aria-label={d.graph.unit}>
          <button type="button" className={unit === "bb" ? styles.on : undefined} aria-pressed={unit === "bb"} onClick={() => onUnit("bb")}>
            {d.graph.bigBlinds}
          </button>
          <button
            type="button"
            className={unit === "money" ? styles.on : undefined}
            aria-pressed={unit === "money"}
            disabled={!hasMoney(session) || money === null}
            onClick={() => onUnit("money")}
          >
            {session.units.symbol ?? d.graph.money}
          </button>
        </div>
      </div>
      {session.units.mixedKind ? <p className={styles.notice}>{d.mixedKind}</p> : null}
      {!session.units.mixedKind && session.units.mixedCurrency ? <p className={styles.notice}>{d.mixedCurrency}</p> : null}
      {report ? (
        <WinrateGraph graph={report.graph} unit={inMoney ? "money" : "bb"} money={money} legend={false} hidden={hidden} />
      ) : error !== null ? (
        <StateMessage kind="error" compact>
          {d.graph.error(error)}
        </StateMessage>
      ) : (
        <StateMessage kind="loading" compact>
          {d.graph.loading}
        </StateMessage>
      )}
    </section>
  );
}

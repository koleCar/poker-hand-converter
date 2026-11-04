/**
 * The Live screen's graph card: the session's figures - result, big blinds,
 * hands, hands per hour, one size each - over the shared win-rate graph
 * (`@rail/ui/stats/WinrateGraph`: total, all-in EV, showdown, non-showdown
 * in the trackers' colours), in big blinds or money.
 *
 * The graph is the Reports graph over the session's hands: `report` with
 * the session's start as the filter and no end, so a hand that lands moves
 * it. Read again whenever the session's hand count changes.
 */
import { WinrateGraph, type WinrateGraphMoney } from "@rail/ui/stats/WinrateGraph";
import { useEffect, useState } from "react";

import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { errorText, ipc, type Report, type Session, type Units } from "../../lib/ipc";
import { GRAPH_POINTS } from "../../lib/reportSource";
import { bigBlinds, count, signedMoney, unitOf } from "../hands/format";
import { MIN_MINUTES_FOR_RATE, minutesBetween } from "./model";
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

/** The session's report, read again when a hand lands. */
function useSessionReport(startedAt: string, hands: number): { report: Report | null; error: string | null } {
  const [state, setState] = useState<{ report: Report | null; error: string | null }>({ report: null, error: null });
  useEffect(() => {
    let live = true;
    ipc
      .report({ from: startedAt }, GRAPH_POINTS)
      .then((report) => {
        if (live) setState({ report, error: null });
      })
      .catch((error: unknown) => {
        if (live) setState((was) => ({ ...was, error: errorText(error) }));
      });
    return () => {
      live = false;
    };
  }, [startedAt, hands]);
  return state;
}

export function LiveGraph({ session }: { session: Session }) {
  const t = useT();
  const d = t.live;
  const { report, error } = useSessionReport(session.startedAt, session.hands);
  const [unit, setUnit] = useState<"bb" | "money">("bb");

  const units = session.units;
  const moneyUnit =
    units.currency !== null && units.minorUnits !== null
      ? unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits })
      : null;
  const money = report ? moneyOf(report.units) : null;
  const shownUnit = unit === "money" && money !== null ? "money" : "bb";
  const minutes = minutesBetween(session.startedAt, session.endedAt);
  const tone = (value: number | null) => (value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down);

  const figures: { label: string; value: string; className?: string; title?: string }[] = [
    {
      label: d.result,
      value: session.net !== null && moneyUnit ? signedMoney(moneyUnit, session.net) : "—",
      className: tone(session.net),
    },
    {
      label: d.resultBb,
      value: session.netBbMilli !== null ? bigBlinds(session.netBbMilli) : "—",
      className: tone(session.netBbMilli),
    },
    { label: d.hands, value: count(session.hands) },
    {
      label: d.perHour,
      value: minutes >= MIN_MINUTES_FOR_RATE ? count(Math.round((session.hands * 60) / minutes)) : "—",
      title: d.perHourTitle,
    },
  ];

  return (
    <section className={styles.card} aria-label={d.graph.label}>
      <div className={styles.cardHead}>
        <dl className={styles.figures}>
          {figures.map((figure) => (
            <div key={figure.label} className={styles.figure} title={figure.title}>
              <dt>{figure.label}</dt>
              <dd className={figure.className}>{figure.value}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.toggle} role="group" aria-label={d.graph.unit}>
          <button
            type="button"
            className={`chip-btn${shownUnit === "bb" ? " is-active" : ""}`}
            aria-pressed={shownUnit === "bb"}
            onClick={() => setUnit("bb")}
          >
            {d.graph.bigBlinds}
          </button>
          <button
            type="button"
            className={`chip-btn${shownUnit === "money" ? " is-active" : ""}`}
            aria-pressed={shownUnit === "money"}
            disabled={money === null}
            onClick={() => setUnit("money")}
          >
            {units.symbol ?? d.graph.money}
          </button>
        </div>
      </div>
      {units.mixedKind ? <p className={styles.notice}>{d.mixedKind}</p> : null}
      {!units.mixedKind && units.mixedCurrency ? <p className={styles.notice}>{d.mixedCurrency}</p> : null}
      {report ? (
        <WinrateGraph graph={report.graph} unit={shownUnit} money={money} />
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

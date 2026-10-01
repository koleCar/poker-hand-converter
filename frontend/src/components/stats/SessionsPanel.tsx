/**
 * Sessions and the bankroll (#54): "how did my evening go", and the line that
 * all the evenings add up to.
 *
 * A session is a run of hands with no gap longer than the chosen break, across
 * every table — a multi-tabler's night is one session. The server groups them
 * (`stats_sessions`); this draws the list and the running total.
 *
 * The bankroll line is in money when the scope is one currency of cash, and in
 * big blinds otherwise: chips are not money and two currencies do not add. It
 * is plotted per session, not per day or per hand, because the session is the
 * unit a player remembers — "the Tuesday I lost three buy-ins" — and the x-axis
 * should be something the reader can point at.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchStatsSessions, type StatsFilters, type StatsSessions } from "../../lib/db";
import { count, money } from "./format";

const GAPS = [15, 30, 60, 120];
const SHOWN = 15;
const WIDTH = 640;
const HEIGHT = 140;
const PAD = 6;

const BB = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Money when the scope is one currency of cash; big blinds otherwise. */
function inMoneyOf(data: StatsSessions | null): boolean {
  return Boolean(data?.currency && data.currencyMinorUnits);
}

function valueOf(data: StatsSessions | null, session: { net: number | null; netBbMilli: number | null }): number | null {
  if (inMoneyOf(data)) return session.net;
  return session.netBbMilli === null ? null : session.netBbMilli / 1000;
}

function duration(start: string, end: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function SessionsPanel({ filters, refreshToken }: { filters: StatsFilters; refreshToken: number }) {
  const [gap, setGap] = useState(30);
  const [data, setData] = useState<StatsSessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const key = JSON.stringify(filters);

  useEffect(() => {
    let live = true;
    fetchStatsSessions(JSON.parse(key) as StatsFilters, gap).then(
      (next) => {
        if (live) {
          setData(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [key, gap, refreshToken]);

  const inMoney = inMoneyOf(data);
  const value = (session: { net: number | null; netBbMilli: number | null }) => valueOf(data, session);
  const show = (amount: number): string =>
    inMoney && data?.currency && data.currencyMinorUnits
      ? `${amount > 0 ? "+" : ""}${money(amount, data.currency, data.currencyMinorUnits)}`
      : `${BB.format(amount)} bb`;

  const line = useMemo(() => {
    if (!data || data.sessions.length < 2) return null;
    const chronological = [...data.sessions].reverse();
    const points: number[] = [0];
    for (const session of chronological) {
      points.push(points[points.length - 1] + (valueOf(data, session) ?? 0));
    }
    const min = Math.min(0, ...points);
    const max = Math.max(0, ...points);
    const span = max - min || 1;
    const x = (index: number) => PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2);
    const y = (amount: number) => PAD + (1 - (amount - min) / span) * (HEIGHT - PAD * 2);
    return {
      path: points.map((amount, index) => `${x(index).toFixed(1)},${y(amount).toFixed(1)}`).join(" "),
      zero: y(0),
      end: points[points.length - 1],
    };
  }, [data]);

  if (!data || data.sessions.length === 0) {
    return error ? <p className="notice notice--error">{error}</p> : null;
  }

  const rows = all ? data.sessions : data.sessions.slice(0, SHOWN);

  return (
    <section className="card stats-group">
      <div className="card__head stats-breakdown__head">
        <h3>Sessions</h3>
        <label className="field field--narrow">
          <span className="field__label">A break longer than</span>
          <select value={gap} onChange={(event) => setGap(Number(event.target.value))}>
            {GAPS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {line ? (
        <figure className="stats-bankroll">
          <figcaption className="muted">
            Bankroll over {count(data.sessions.length)} sessions:{" "}
            <strong className={line.end >= 0 ? "stats-up" : "stats-down"}>{show(line.end)}</strong>
          </figcaption>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`Bankroll, ${show(line.end)} over ${data.sessions.length} sessions`}>
            <line className="stats-bankroll__zero" x1={0} x2={WIDTH} y1={line.zero} y2={line.zero} />
            <polyline className="stats-bankroll__line" points={line.path} />
          </svg>
        </figure>
      ) : null}

      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col" className="num">Length</th>
              <th scope="col" className="num">Hands</th>
              <th scope="col" className="num">Tables</th>
              <th scope="col" className="num">Result</th>
              <th scope="col" className="num">bb/100</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((session) => {
              const result = value(session);
              const bb100 =
                session.netBbMilli === null || session.hands === 0 ? null : (session.netBbMilli / 1000 / session.hands) * 100;
              return (
                <tr key={session.startedAt}>
                  <th scope="row">
                    {DAY.format(new Date(session.startedAt))}
                    <span className="stats-opponents__room">
                      {TIME.format(new Date(session.startedAt))}–{TIME.format(new Date(session.endedAt))}
                    </span>
                  </th>
                  <td className="num">{duration(session.startedAt, session.endedAt)}</td>
                  <td className="num">{count(session.hands)}</td>
                  <td className="num">{session.tables}</td>
                  <td className={`num ${result === null ? "" : result >= 0 ? "is-up" : "is-down"}`}>
                    {result === null ? "—" : show(result)}
                  </td>
                  <td className={`num ${session.hands < 100 ? "is-thin" : ""}`}>
                    {bb100 === null ? "—" : BB.format(bb100)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.sessions.length > SHOWN ? (
        <div>
          <button type="button" className="btn btn--sm" onClick={() => setAll(!all)}>
            {all ? "Show the latest only" : `Show all ${count(data.sessions.length)} sessions`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

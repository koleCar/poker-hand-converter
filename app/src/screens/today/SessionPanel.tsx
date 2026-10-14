/**
 * Today's session (guideline §6 "Danas": the current session, its result,
 * hands played; R2.7b): the latest run of the hero's hands with no break
 * longer than the web's 30 minutes, across every table (`stats_sessions`'
 * rule, `rail_store::report`). Its result in money and in big blinds under
 * the web's refusals, hands and hands per hour, its key statistics with
 * their reliability, and its biggest pots, which open in Hands.
 *
 * Kept current by the watcher's change events (a hand imported moves it),
 * and once a minute (a session stops being "current" with time alone).
 */
import { useCallback, useEffect, useState } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { StatTable } from "@rail/ui/stats/StatTable";

import { useLocale, useT } from "../../i18n";
import { errorText, inApp, ipc, onWatcherChanged, type HandRow, type Session } from "../../lib/ipc";
import { go, screenHref } from "../../lib/router";
import { statRows, useStatDefinitions } from "../../lib/useStatDefinitions";
import { bigBlinds, count, signedMoney, stakes, unitOf } from "../hands/format";
import styles from "./SessionPanel.module.css";

/** The session's key statistics, in this order. */
const KEY_STATS = [
  "vpip",
  "pfr",
  "three_bet",
  "fold_to_three_bet",
  "cbet_flop",
  "aggression_frequency",
  "wtsd",
  "wsd",
  "bb_per_100",
  "allin_ev_bb_per_100",
];

/** Below this the session is too short for a rate per hour. */
const MIN_MINUTES_FOR_RATE = 10;

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const BB = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

/** A pot in big blinds, from the list row's minor units. */
function potBb(row: HandRow): string | null {
  return row.bigBlind > 0 ? BB.format(row.totalPot / row.bigBlind) : null;
}

function useSession(): { session: Session | null; loaded: boolean; error: string | null } {
  const [state, setState] = useState<{ session: Session | null; loaded: boolean; error: string | null }>({
    session: null,
    loaded: false,
    error: null,
  });
  const load = useCallback(() => {
    ipc
      .today()
      .then((today) => setState({ session: today.session, loaded: true, error: null }))
      .catch((error: unknown) => setState((was) => ({ ...was, loaded: true, error: errorText(error) })));
  }, []);
  useEffect(() => {
    if (!inApp) return;
    load();
    const stop = onWatcherChanged(load);
    const timer = window.setInterval(load, 60_000);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [load]);
  return state;
}

export function SessionPanel() {
  const t = useT();
  const d = t.today.session;
  const locale = useLocale();
  const definitions = useStatDefinitions();
  const { session, loaded, error } = useSession();

  let body;
  if (!inApp) {
    body = <p className={styles.muted}>{t.today.unavailable}</p>;
  } else if (error !== null) {
    body = <p className={styles.error}>{d.error(error)}</p>;
  } else if (!loaded) {
    body = <p className={styles.muted}>{d.loading}</p>;
  } else if (session === null) {
    body = <p className={styles.muted}>{d.none}</p>;
  } else {
    body = <SessionBody session={session} />;
  }

  const heading = session === null ? d.heading : session.current ? d.current : d.last;
  return (
    <section className={styles.section} aria-labelledby="today-session">
      <div className={styles.head}>
        <h2 id="today-session" className={styles.heading}>
          {heading}
        </h2>
        {session ? (
          <a className={styles.link} href={screenHref("reports")}>
            {d.reports}
          </a>
        ) : null}
      </div>
      {body}
      {session && definitions ? (
        <div className={styles.stats}>
          <StatTable
            caption={d.stats}
            showCaption
            rows={statRows(definitions, session.stats, locale, (definition) => KEY_STATS.includes(definition.id)).sort(
              (a, b) => KEY_STATS.indexOf(a.id) - KEY_STATS.indexOf(b.id),
            )}
          />
          <p className={styles.note}>{d.statsNote}</p>
        </div>
      ) : null}
      {session && session.biggestPots.length > 0 ? <BiggestPots rows={session.biggestPots} /> : null}
    </section>
  );
}

function SessionBody({ session }: { session: Session }) {
  const t = useT();
  const d = t.today.session;
  const minutes = minutesBetween(session.startedAt, session.endedAt);
  const duration = d.duration(minutes);
  const when = session.current
    ? `${d.started(TIME.format(new Date(session.startedAt)))} · ${d.lasted(duration)}`
    : `${d.range(DAY_TIME.format(new Date(session.startedAt)), TIME.format(new Date(session.endedAt)))} · ${duration}`;
  const units = session.units;
  const unit =
    units.currency !== null && units.minorUnits !== null
      ? unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits })
      : null;
  const perHour =
    minutes >= MIN_MINUTES_FOR_RATE ? count(Math.round((session.hands * 60) / minutes)) : "—";
  const tiles: { label: string; value: string; title?: string; tone?: "up" | "down" }[] = [
    {
      label: d.result,
      value: session.net !== null && unit ? signedMoney(unit, session.net) : "—",
      tone: session.net === null ? undefined : session.net > 0 ? "up" : session.net < 0 ? "down" : undefined,
    },
    {
      label: d.resultBb,
      value: session.netBbMilli !== null ? bigBlinds(session.netBbMilli) : "—",
      tone:
        session.netBbMilli === null
          ? undefined
          : session.netBbMilli > 0
            ? "up"
            : session.netBbMilli < 0
              ? "down"
              : undefined,
    },
    { label: d.hands, value: count(session.hands) },
    { label: d.perHour, value: perHour, title: d.perHourTitle },
  ];
  if (session.tables !== null) {
    tiles.push({ label: d.tables, value: count(session.tables) });
  }
  return (
    <>
      <p className={styles.when}>{when}</p>
      <dl className={styles.tiles}>
        {tiles.map((tile) => (
          <div key={tile.label} className={styles.tile} title={tile.title}>
            <dt className={styles.label}>{tile.label}</dt>
            <dd className={`${styles.value} ${tile.tone ? styles[tile.tone] : ""}`}>{tile.value}</dd>
          </div>
        ))}
      </dl>
      {units.mixedKind ? <p className={styles.notice}>{d.mixedKind}</p> : null}
      {!units.mixedKind && units.mixedCurrency ? <p className={styles.notice}>{d.mixedCurrency}</p> : null}
      <p className={styles.note}>{d.rule(session.gapMinutes)}</p>
    </>
  );
}

/** The session's biggest pots, each a link into Hands. */
function BiggestPots({ rows }: { rows: HandRow[] }) {
  const t = useT();
  const d = t.today.session;
  return (
    <div className={styles.pots}>
      <h3 className={styles.subheading}>{d.pots}</h3>
      <p className={styles.note}>{d.potsNote}</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{d.potColumns.time}</th>
            <th scope="col">{d.potColumns.stakes}</th>
            <th scope="col">{d.potColumns.cards}</th>
            <th scope="col" className={styles.number}>
              {d.potColumns.pot}
            </th>
            <th scope="col" className={styles.number}>
              {d.potColumns.result}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pot = potBb(row);
            const net = row.heroNet === null ? "—" : signedMoney(unitOf(row), row.heroNet);
            return (
              <tr key={row.handKey}>
                <td>
                  <a
                    className={styles.link}
                    href={screenHref("hands", row.handKey)}
                    aria-label={d.openHand(row.siteHandId)}
                    onClick={(event) => {
                      event.preventDefault();
                      go("hands", row.handKey);
                    }}
                  >
                    {row.playedAt ? TIME.format(new Date(row.playedAt)) : "—"}
                  </a>
                </td>
                <td>{`${row.siteName} ${stakes(row)}`}</td>
                <td>{row.heroCards.length > 0 ? <CardRow cards={row.heroCards} size="xs" /> : "—"}</td>
                <td className={styles.number}>{pot === null ? "—" : d.potBb(pot)}</td>
                <td
                  className={`${styles.number} ${row.heroNet !== null && row.heroNet > 0 ? styles.up : row.heroNet !== null && row.heroNet < 0 ? styles.down : ""}`}
                >
                  {net}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live (guideline §6 "Danas", renamed): the session being played, as it is
 * played. Redesigned after the owner's brief of 2026-11-05 ("as clean as
 * possible"): no title - the sidebar says where the reader is - only the
 * session's state in one pill (playing since when, for how long, at how many
 * tables; else offline) beside the Cash | Tournaments switch; under it the
 * graph with its toolbar, the statistics as coloured tiles and the hands.
 *
 * A session is the latest run of the hero's hands with no break longer than
 * the web's 30 minutes, across every table (`stats_sessions`' rule,
 * `rail_store::report`); it is live while its newest hand is within that
 * gap of now. Without one the screen says it is offline and offers the last
 * session, which opens Reports filtered to exactly its hands.
 *
 * One kind of game at a time, never cash and tournament hands together
 * (the owner's rule, 2026-11-04): the Cash | Tournaments switch, opening on
 * the kind being played (else the one with more hands in its latest
 * session); a cash evening split by a tournament is two cash sessions.
 *
 * The unit (big blinds or money) is the screen's, not the graph's: the
 * result, the per-100 rate, the hands' results and the last session all
 * follow it.
 *
 * Kept current by the watcher's change events (a hand imported moves it),
 * and once a minute (a session stops being live with time alone). The
 * import status lives in Settings, Folders.
 */
import { kindFormats, withKind, type GameKind } from "@rail/ui/hands/gameKind";
import { KindSwitch } from "@rail/ui/hands/KindSwitch";
import { useCallback, useEffect, useState } from "react";

import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { liveDateFormat } from "../i18n/format";
import { errorText, inApp, ipc, onStatsDataChanged, type Report, type Session } from "../lib/ipc";
import { go, screenHref } from "../lib/router";
import { bigBlinds, signedMoney } from "./hands/format";
import { EMPTY_FILTER, requestFilter } from "./hands/filter";
import { LiveGraph } from "./live/LiveGraph";
import { LiveHands } from "./live/LiveHands";
import { LiveStats } from "./live/LiveStats";
import { minutesBetween } from "./live/model";
import { hasMoney, moneyUnitOf, useRate, type LiveUnit } from "./live/units";
import styles from "./live/Live.module.css";

const TIME = liveDateFormat({ hour: "2-digit", minute: "2-digit" });
const DAY_TIME = liveDateFormat({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface SessionState {
  session: Session | null;
  /** The kind shown and both kinds' hands (null until read). */
  kind: GameKind | null;
  counts: Record<GameKind, number> | null;
  loaded: boolean;
  error: string | null;
}

function useSession(asked: GameKind | null): SessionState {
  const [state, setState] = useState<SessionState>({ session: null, kind: null, counts: null, loaded: false, error: null });
  const load = useCallback(() => {
    ipc
      .today(asked)
      .then((today) =>
        setState({
          session: today.session,
          kind: today.kind,
          counts: { cash: today.kinds.cash.hands, tournament: today.kinds.tournament.hands },
          loaded: true,
          error: null,
        }),
      )
      .catch((error: unknown) => setState((was) => ({ ...was, loaded: true, error: errorText(error) })));
  }, [asked]);
  useEffect(() => {
    if (!inApp) return;
    load();
    const stop = onStatsDataChanged(load);
    const timer = window.setInterval(load, 60_000);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [load]);
  return state;
}

export function Live() {
  const t = useT();
  const d = t.live;
  const [askedKind, setAskedKind] = useState<GameKind | null>(null);
  const [unit, setUnit] = useState<LiveUnit>("bb");
  const { session, kind, counts, loaded, error } = useSession(askedKind);
  const live = session !== null && session.current;
  const shownUnit: LiveUnit = unit === "money" && session !== null && hasMoney(session) ? "money" : "bb";

  let body;
  if (!inApp) {
    body = <p className={styles.muted}>{d.unavailable}</p>;
  } else if (error !== null) {
    body = <StateMessage kind="error">{d.error(error)}</StateMessage>;
  } else if (!loaded) {
    body = <StateMessage kind="loading">{d.loading}</StateMessage>;
  } else if (session === null || !session.current || kind === null) {
    body = session && kind !== null ? <LastSession session={session} kind={kind} unit={shownUnit} /> : <NoSession />;
  } else {
    body = (
      <>
        <LiveGraph session={session} kind={kind} unit={shownUnit} onUnit={setUnit} />
        <LiveStats session={session} />
        <LiveHands session={session} kind={kind} unit={shownUnit} />
      </>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        {/* The sidebar names the screen; the heading stays for assistive technology. */}
        <h1 className={styles.visuallyHidden}>{t.screens.live.title}</h1>
        {inApp && loaded && error === null ? (
          live ? (
            <span className={styles.status} role="status">
              <span className={styles.pulse} aria-hidden="true" />
              {d.status.playing}
              <span className={styles.statusMeta}>
                {[
                  TIME.format(new Date(session.startedAt)),
                  d.duration(minutesBetween(session.startedAt, session.endedAt)),
                  session.tables !== null ? d.tables(session.tables) : null,
                ]
                  .filter((part) => part !== null)
                  .map((part) => ` · ${part}`)
                  .join("")}
              </span>
            </span>
          ) : (
            <span className={`${styles.status} ${styles.offline}`} role="status">
              <span className={styles.offlineDot} aria-hidden="true" />
              {d.status.offline}
              <span className={styles.statusMeta}> · {d.status.noSession}</span>
            </span>
          )
        ) : null}
        {inApp && loaded && kind !== null ? (
          <KindSwitch kind={kind} counts={counts} onChange={setAskedKind} className={styles.kinds} />
        ) : null}
      </header>
      {body}
    </div>
  );
}

/** No session on and none before it: one quiet line. */
function NoSession() {
  const d = useT().live.empty;
  return (
    <section className={styles.empty} aria-labelledby="live-empty">
      <h2 id="live-empty" className={styles.emptyTitle}>
        {d.title}
      </h2>
      <p className={styles.emptyText}>{d.hint}</p>
    </section>
  );
}

/** The last session's report, for its small graph. */
function useLastReport(session: Session, kind: GameKind): Report | null {
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    let live = true;
    const to = new Date(Date.parse(session.endedAt) + 1000).toISOString();
    ipc
      .report({ from: session.startedAt, to, formats: kindFormats(kind) }, 60)
      .then((value) => {
        if (live) setReport(value);
      })
      .catch(() => {
        if (live) setReport(null);
      });
    return () => {
      live = false;
    };
  }, [session.startedAt, session.endedAt, kind]);
  return report;
}

/** The small graph's path over a 300 x 56 box, and where zero is. */
function sparkline(report: Report | null): { line: string; zero: number; up: boolean } | null {
  const buckets = report?.graph.buckets ?? [];
  if (buckets.length < 2) return null;
  const values = [0, ...buckets.map((bucket) => bucket.cumNetBbMilli)];
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const span = Math.max(1, high - low);
  const y = (value: number) => 4 + ((high - value) / span) * 48;
  const line = values
    .map((value, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * 300).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ");
  return { line, zero: y(0), up: (values[values.length - 1] ?? 0) >= 0 };
}

/**
 * No session on: the last one, as one card that is plainly a way in - its
 * time, its result in the screen's unit, its hands and rate, a small graph -
 * opening Reports filtered to exactly its hands.
 */
function LastSession({ session, kind, unit }: { session: Session; kind: GameKind; unit: LiveUnit }) {
  const d = useT().live;
  const report = useLastReport(session, kind);
  const spark = sparkline(report);
  const rate = useRate(session, unit);
  const money = moneyUnitOf(session);
  const inMoney = unit === "money" && money !== null && session.net !== null;
  const value = inMoney ? session.net : session.netBbMilli;
  const result = inMoney && money ? signedMoney(money, session.net as number) : value !== null ? d.bb(bigBlinds(value)) : "—";
  const tone = value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down;

  const open = () => {
    const filter = withKind({ ...EMPTY_FILTER, date: "custom", dateFrom: session.startedAt, dateTo: session.endedAt }, kind, null);
    requestFilter(filter, "reports");
    go("reports");
  };

  return (
    <a
      className={styles.lastCard}
      href={screenHref("reports")}
      title={d.empty.reportsTitle}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
    >
      <span className={styles.lastBody}>
        <span className={styles.lastLabel}>{d.empty.last}</span>
        <span className={styles.lastWhen}>
          {d.empty.range(DAY_TIME.format(new Date(session.startedAt)), TIME.format(new Date(session.endedAt)))}
        </span>
        <span className={styles.lastFigures}>
          <strong className={`${styles.lastResult} ${tone}`}>{result}</strong>
          <span className={styles.muted}>
            {[d.handsCount(session.hands), rate ? `${rate.value} ${rate.unit}` : null].filter((part) => part !== null).join(" · ")}
          </span>
        </span>
      </span>
      {spark ? (
        <svg className={styles.spark} viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true">
          <path d={`M0,${spark.zero.toFixed(1)} H300`} className={styles.sparkZero} />
          <path d={spark.line} className={spark.up ? styles.sparkUp : styles.sparkDown} />
        </svg>
      ) : null}
      <span className={styles.link}>{d.empty.reports}</span>
      <span className={styles.chevron} aria-hidden="true">
        ›
      </span>
    </a>
  );
}

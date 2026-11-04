/**
 * Live (guideline §6 "Danas", renamed): the session being played, as it is
 * played. Its title says whether a session is on; under it the session's
 * graph with its figures (result, big blinds, hands, hands per hour), its
 * key statistics as short labels with the full name and target range on
 * hover, and its hands, newest first, a page at a time.
 *
 * A session is the latest run of the hero's hands with no break longer than
 * the web's 30 minutes, across every table (`stats_sessions`' rule,
 * `rail_store::report`); it is live while its newest hand is within that
 * gap of now. Without one the screen says so and shows the last session.
 *
 * Kept current by the watcher's change events (a hand imported moves it),
 * and once a minute (a session stops being live with time alone). The
 * import status lives in Settings, Folders.
 */
import { useCallback, useEffect, useState } from "react";

import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { liveDateFormat } from "../i18n/format";
import { errorText, inApp, ipc, onStatsDataChanged, type Session } from "../lib/ipc";
import { screenHref, SETUP } from "../lib/router";
import { useWatcherStatus } from "../lib/useWatcherStatus";
import { signedMoney, unitOf, bigBlinds, count } from "./hands/format";
import { LiveGraph } from "./live/LiveGraph";
import { LiveHands } from "./live/LiveHands";
import { LiveStats } from "./live/LiveStats";
import { minutesBetween } from "./live/model";
import styles from "./live/Live.module.css";

const TIME = liveDateFormat({ hour: "2-digit", minute: "2-digit" });
const DAY_TIME = liveDateFormat({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface SessionState {
  session: Session | null;
  loaded: boolean;
  error: string | null;
}

function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ session: null, loaded: false, error: null });
  const load = useCallback(() => {
    ipc
      .today()
      .then((today) => setState({ session: today.session, loaded: true, error: null }))
      .catch((error: unknown) => setState((was) => ({ ...was, loaded: true, error: errorText(error) })));
  }, []);
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
  const { session, loaded, error } = useSession();
  const live = session !== null && session.current;

  let body;
  if (!inApp) {
    body = <p className={styles.muted}>{d.unavailable}</p>;
  } else if (error !== null) {
    body = <StateMessage kind="error">{d.error(error)}</StateMessage>;
  } else if (!loaded) {
    body = <StateMessage kind="loading">{d.loading}</StateMessage>;
  } else if (session === null || !session.current) {
    body = <NoSession last={session} />;
  } else {
    body = (
      <>
        <LiveGraph session={session} />
        <LiveStats session={session} />
        <LiveHands session={session} />
      </>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t.screens.live.title}</h1>
        {live ? (
          <>
            <span className={styles.badge}>
              <span className={styles.pulse} aria-hidden="true" />
              {d.playing}
            </span>
            <span className={styles.meta}>
              {[
                d.since(TIME.format(new Date(session.startedAt))),
                d.duration(minutesBetween(session.startedAt, session.endedAt)),
                session.tables !== null ? d.tables(session.tables) : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </>
        ) : null}
      </header>
      {body}
    </div>
  );
}

/** No session on: what starts one, the watcher's state, and the last session. */
function NoSession({ last }: { last: Session | null }) {
  const t = useT();
  const d = t.live.empty;
  const { status } = useWatcherStatus();
  const folders = status?.sources.filter((source) => source.state !== "disabled").length ?? null;
  return (
    <>
      <section className={styles.empty} aria-labelledby="live-empty">
        <div className={styles.emptyBody}>
          <h2 id="live-empty" className={styles.emptyTitle}>
            {d.title}
          </h2>
          <p className={styles.emptyText}>{d.text}</p>
          {status?.running && folders !== null ? (
            folders > 0 ? (
              <p className={styles.chips}>
                <span className={styles.chip}>
                  <span className={styles.dot} aria-hidden="true" />
                  {d.watching(folders)}
                </span>
                {status.paused ? <span className={styles.chip}>{d.paused}</span> : null}
              </p>
            ) : (
              <p className={styles.emptyText}>
                {d.noFolders}{" "}
                <a href={screenHref(SETUP)}>{d.findFolders}</a>
              </p>
            )
          ) : null}
        </div>
      </section>
      {last ? <LastSession session={last} /> : null}
    </>
  );
}

function LastSession({ session }: { session: Session }) {
  const t = useT();
  const d = t.live;
  const units = session.units;
  const unit =
    units.currency !== null && units.minorUnits !== null
      ? unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits })
      : null;
  const tone = (value: number | null) => (value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down);
  const minutes = minutesBetween(session.startedAt, session.endedAt);
  return (
    <section className={styles.section} aria-labelledby="live-last">
      <h2 id="live-last" className={styles.heading}>
        {d.empty.last}
      </h2>
      <a className={styles.lastCard} href={screenHref("reports")}>
        <span className={styles.muted}>
          {`${d.empty.range(DAY_TIME.format(new Date(session.startedAt)), TIME.format(new Date(session.endedAt)))} · ${d.duration(minutes)}`}
        </span>
        <dl className={styles.lastFigures}>
          <div>
            <dt>{d.result}</dt>
            <dd className={tone(session.net)}>
              {session.net !== null && unit ? signedMoney(unit, session.net) : "—"}
            </dd>
          </div>
          <div>
            <dt>{d.resultBb}</dt>
            <dd className={tone(session.netBbMilli)}>
              {session.netBbMilli !== null ? bigBlinds(session.netBbMilli) : "—"}
            </dd>
          </div>
          <div>
            <dt>{d.hands}</dt>
            <dd>{count(session.hands)}</dd>
          </div>
        </dl>
        <span className={styles.link}>{d.empty.reports}</span>
      </a>
      <p className={styles.note}>{d.empty.rule(session.gapMinutes)}</p>
    </section>
  );
}

/**
 * The Players screen (`/players`, R4.5c).
 *
 * The screen itself is the shared Players screen
 * (`@rail/ui/players/PlayersScreen`, the desktop app's since R2.7c) over the
 * web's opponent summaries (`lib/db/playersSource.ts`): the opponents of
 * rooms that show screen names, most hands together first, searched by the
 * start of a name, by room, by game and "with a note"; beside the list one
 * opponent's profile - their statistics, their rows by position, stake,
 * table size and game, your result against them, your note, and "hands with
 * this player" into the library. Colour tags and labels are the desktop
 * app's (the owner's decision, 2026-10-23: no sync): the web's source
 * declares none, and the screen leaves them out.
 *
 * Around it, this page's own:
 *
 * - **The opt-in.** Opponents exist on the web only while opponent
 *   statistics are on (villain rows, about six times the storage of the
 *   hero's own; a setting of this browser, as the Statistics screen's
 *   opponents panel keeps it). Off, the page says what turning them on
 *   costs and does, and turns them on: the setting, then the rebuild that
 *   reads the opponents of the hands already stored.
 * - **The states**: no database, signed out, a database without the
 *   readers (PGRST202: "not set up"), an error - each says which.
 * - **Live arrival** (R1.10): hands the desktop app syncs while the page is
 *   open get their statistics derived (opponents included) and the list
 *   reads again; one catch-up at a time.
 * - **Where it sits**: under the Statistics tab (`stats/StatsNav.tsx`), not
 *   in the bar.
 * - **The open player** is page state, and "hands with this player" parks
 *   the opponent for the library (`library/playerHandoff.ts`) rather than
 *   putting a screen name in the address.
 */

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PlayerRef } from "@rail/ui/hands/model";
import { PlayersScreen } from "@rail/ui/players/PlayersScreen";
import type { PlayerQuery } from "@rail/ui/players/model";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  isDatabaseConfigured,
  isMissingSchemaError,
  rebuildStats,
  setVillainRowsEnabled,
  villainRowsEnabled,
} from "../../lib/db";
import { webPlayersSource } from "../../lib/db/playersSource";
import { WEB_DEFINITIONS } from "../../lib/db/reportSource";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import type { ArrivalBatch } from "../../lib/live/arrivals";
import { paths } from "../../lib/routes";
import { parkPlayerFilter } from "../library/playerHandoff";
import { StatsNav } from "../stats/StatsNav";
import "../../styles/stats.css";

interface PlayersTabProps {
  /** Bumped by the shell after an upload lands, so the list follows it. */
  refreshToken?: number;
  /** The latest live batch from the shell (`AppFrame`, R1.10); null until one arrives. */
  arrival?: ArrivalBatch | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "working"; done: number }
  | { kind: "error"; message: string };

/** The setting changes in this tab through `turnOn`; nothing to subscribe to. */
const subscribeNever = () => () => undefined;

/** Identifiers in the "not set up" notice: names, not prose, so not translated. */
const PLAYERS_MIGRATION = "supabase/migrations/20270714090000_players_screen.sql";

export function PlayersTab({ refreshToken = 0, arrival = null }: PlayersTabProps) {
  const dict = useDict();
  const t = dict.stats;
  const en = t.players;
  const auth = useAuth();
  const router = useRouter();
  // The setting lives in this browser's storage, which the server render
  // cannot see: null until hydrated, so no card flashes in the wrong state.
  const stored = useSyncExternalStore(subscribeNever, villainRowsEnabled, () => null);
  const [override, setOverride] = useState<boolean | null>(null);
  const enabled = override ?? stored;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [installed, setInstalled] = useState(true);
  const [selected, setSelected] = useState<PlayerRef | null>(null);
  /** Bumped when the opponents change under the screen (a rebuild, an arrival, an upload): it reads again. */
  const [generation, setGeneration] = useState(0);

  const base = useMemo(() => webPlayersSource(dict.converter.library.standardFormat), [dict]);
  // A database without the readers (PGRST202) says "not set up", not a stack trace.
  const source = useMemo(
    () => ({
      ...base,
      list: (query: PlayerQuery) =>
        base.list(query).catch((error: unknown) => {
          if (isMissingSchemaError(error)) setInstalled(false);
          throw error;
        }),
    }),
    [base],
  );

  // Hands without their statistics (uploaded from another browser, where
  // the setting was off, or arrived from the desktop app) catch up: one
  // rebuild at a time, rounds that land during one fold into the next.
  const catchingUp = useRef(false);
  const catchUpAgain = useRef(false);
  const catchUp = useCallback(async () => {
    if (catchingUp.current) {
      catchUpAgain.current = true;
      return;
    }
    catchingUp.current = true;
    try {
      do {
        catchUpAgain.current = false;
        await rebuildStats().catch(() => undefined);
        setGeneration((value) => value + 1);
      } while (catchUpAgain.current);
    } finally {
      catchingUp.current = false;
    }
  }, []);

  useEffect(() => {
    if (isDatabaseConfigured && auth.isSignedIn && stored) void catchUp();
  }, [auth.isSignedIn, stored, refreshToken, catchUp]);

  const handledArrival = useRef(0);
  useEffect(() => {
    if (!arrival || arrival.seq === handledArrival.current) return;
    handledArrival.current = arrival.seq;
    if (isDatabaseConfigured && auth.isSignedIn && enabled) void catchUp();
  }, [arrival, auth.isSignedIn, enabled, catchUp]);

  const turnOn = useCallback(async () => {
    if (!setVillainRowsEnabled(true)) {
      setPhase({ kind: "error", message: t.opponents.storageRefused });
      return;
    }
    setOverride(true);
    setPhase({ kind: "working", done: 0 });
    try {
      await rebuildStats((progress) => setPhase({ kind: "working", done: progress.processed }));
      setPhase({ kind: "idle" });
      setGeneration((value) => value + 1);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [t]);

  const header = (
    <header className="stats__head">
      <h2>{en.heading}</h2>
    </header>
  );

  if (!isDatabaseConfigured) {
    return (
      <div className="stats">
        {header}
        <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    return (
      <div className="stats">
        {header}
        <div className="card stats-empty">
          <h3>{en.signInHeading}</h3>
          <p className="muted">{en.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {t.tab.signIn}
          </button>
        </div>
      </div>
    );
  }

  if (enabled === null) {
    return null;
  }

  if (!installed) {
    return (
      <div className="stats">
        {header}
        <div className="card stats-empty">
          <h3>{t.tab.notInstalledHeading}</h3>
          <p className="muted">
            {en.notInstalledBefore}
            <code>{PLAYERS_MIGRATION}</code>
            {t.tab.notInstalledBody.afterFile}
          </p>
          <button type="button" className="btn" onClick={() => setInstalled(true)}>
            {t.common.tryAgain}
          </button>
        </div>
      </div>
    );
  }

  const status =
    phase.kind === "working" ? (
      <p className="notice notice--info" role="status" aria-live="polite">
        {t.opponents.reading} {phase.done > 0 ? t.common.hands(phase.done) : ""}
      </p>
    ) : phase.kind === "error" ? (
      <p className="notice notice--error" role="alert">
        {phase.message}
      </p>
    ) : null;

  if (!enabled) {
    return (
      <div className="stats">
        <StatsNav current="players" />
        {header}
        <section className="card stats-empty">
          <h3>{en.offHeading}</h3>
          {status}
          <p className="muted">{en.offBody}</p>
          <div>
            <button
              type="button"
              className="btn btn--primary"
              disabled={phase.kind === "working"}
              onClick={() => void turnOn()}
            >
              {t.opponents.turnOn}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="stats">
      <StatsNav current="players" />
      <PlayersScreen
        key={auth.user?.id ?? ""}
        source={source}
        definitions={WEB_DEFINITIONS}
        selected={selected}
        onSelect={setSelected}
        onHandsWith={(player) => {
          parkPlayerFilter(player);
          router.push(paths.library());
        }}
        title={en.heading}
        titleTag="h2"
        notice={status}
        emptyText={phase.kind === "working" ? t.opponents.reading : en.empty}
        notesFootnote={en.notesFootnote}
        reloadToken={generation}
        renderState={(kind, text) => (
          <div
            className={kind === "error" ? "notice notice--error" : "card stats-empty"}
            role={kind === "error" ? "alert" : "status"}
          >
            {kind === "error" ? text : <p className="muted">{text}</p>}
          </div>
        )}
      />
    </div>
  );
}

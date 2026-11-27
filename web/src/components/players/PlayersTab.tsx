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
 *   hero's own; a setting of the account, `derive_options`, as the
 *   Statistics screen's opponents panel keeps it). Off, the page says what
 *   turning them on costs and does, and turns them on: the setting (which
 *   queues every stored hand on the server), then the server working them
 *   out (`deriveNow`) with the count shown.
 * - **The states**: no database, signed out, a database without the
 *   readers (PGRST202: "not set up"), an error - each says which.
 * - **Live arrival** (R1.10): hands the desktop app syncs while the page is
 *   open are worked out on the server (docs/POOL.md P1); the list reads
 *   again.
 * - **Where it sits**: under the Statistics tab (`stats/StatsNav.tsx`), not
 *   in the bar.
 * - **The open player** is page state, and "hands with this player" parks
 *   the opponent for the library (`library/playerHandoff.ts`) rather than
 *   putting a screen name in the address.
 */

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { PlayerRef } from "@rail/ui/hands/model";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { PlayersScreen } from "@rail/ui/players/PlayersScreen";
import type { PlayerQuery } from "@rail/ui/players/model";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  isDatabaseConfigured,
  isMissingSchemaError,
} from "../../lib/db";
import { deriveNow, setOpponentStats, useOpponentStats } from "../../lib/db/derive";
import { webPlayersSource } from "../../lib/db/playersSource";
import { WEB_DEFINITIONS } from "../../lib/db/reportSource";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import type { ArrivalBatch } from "../../lib/live/arrivals";
import { paths } from "../../lib/routes";
import { parkPlayerFilter } from "../library/playerHandoff";
import { StatsNav } from "../stats/StatsNav";
import "../../styles/stats.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

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

/** Identifiers in the "not set up" notice: names, not prose, so not translated. */
const PLAYERS_MIGRATION = "supabase/migrations/20270714090000_players_screen.sql";

export function PlayersTab({ refreshToken = 0, arrival = null }: PlayersTabProps) {
  const dict = useDict();
  const t = dict.stats;
  const en = t.players;
  const auth = useAuth();
  const router = useRouter();
  // The account's setting: null until read, so no card flashes in the wrong state.
  const stored = useOpponentStats(auth.isSignedIn ? (auth.user?.id ?? null) : null);
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

  // An upload or a live batch: the list reads again (the server works the
  // hands out; nothing is derived here).
  const reloadKey = `${generation}|${refreshToken}|${arrival?.seq ?? 0}`;

  const turnOn = useCallback(async () => {
    setPhase({ kind: "working", done: 0 });
    try {
      await setOpponentStats(true);
      setOverride(true);
      await deriveNow((progress) => setPhase({ kind: "working", done: progress.processed }));
      setPhase({ kind: "idle" });
      setGeneration((value) => value + 1);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const header = (
    <header className="stats__head">
      <h2>{en.heading}</h2>
    </header>
  );

  if (!isDatabaseConfigured) {
    return (
      <div className="stats">
        {header}
        <Dismissible className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</Dismissible>
      </div>
    );
  }

  if (!auth.isSignedIn) {
    // The session restoring is not "signed out": the loader, not the gate.
    if (auth.status === "loading") {
      return (
        <div className="stats">
          {header}
          <RailLoader label={dict.settings.loading} centered />
        </div>
      );
    }
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
      <Dismissible className="notice notice--info stats-coverage rail-fade" role="status" aria-live="polite" messageKey="working">
        <span aria-hidden="true">
          <RailLoader size="inline" label={t.opponents.reading} delay={0} />
        </span>
        {t.opponents.reading} {phase.done > 0 ? t.common.hands(phase.done) : ""}
      </Dismissible>
    ) : phase.kind === "error" ? (
      <Dismissible className="notice notice--error" role="alert">
        {phase.message}
      </Dismissible>
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
        onHandsWith={(player, kind) => {
          parkPlayerFilter(player, kind);
          router.push(paths.library());
        }}
        title={en.heading}
        titleTag="h2"
        notice={status}
        emptyText={phase.kind === "working" ? t.opponents.reading : en.empty}
        notesFootnote={en.notesFootnote}
        reloadToken={reloadKey}
        renderState={(kind, text, compact) =>
          // Nothing to show while opponents are being read is still loading.
          kind === "loading" || (kind === "empty" && phase.kind === "working") ? (
            <RailLoader label={text} size={compact ? "small" : "section"} showLabel={!compact} centered />
          ) : (
            kind === "error" ? (
              <Dismissible as="div" className="notice notice--error rail-fade" role="alert">
                {text}
              </Dismissible>
            ) : (
              <div className="card stats-empty rail-fade" role="status">
                <p className="muted">{text}</p>
              </div>
            )
          )
        }
      />
    </div>
  );
}

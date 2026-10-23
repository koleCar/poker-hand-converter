/**
 * Players (guideline §6 "Igrači"; R2.7c). Since R4.5c the screen itself is
 * the shared package's (`@rail/ui/players/PlayersScreen`), which the web's
 * `/players` renders too; this is the app's side of it: the store as its
 * `PlayersSource` (colours, labels and notes, kept on this computer), the
 * definitions, the open player in the address (`#/players/<site>:<name>`,
 * which is how the command palette and the HUD popup open one), the
 * rebuild and indexing notices, and "hands with this player" into Hands.
 */
import { useEffect, useState } from "react";
import { PlayersScreen } from "@rail/ui/players/PlayersScreen";
import styles from "@rail/ui/players/Players.module.css";

import { RecomputeNotice, recomputing } from "../components/RecomputeNotice";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { useRowHeight } from "../lib/appearance";
import { inApp, ipc, type StatsStatus } from "../lib/ipc";
import { storePlayersSource } from "../lib/playersSource";
import { go, replaceParam, useRouteParam } from "../lib/router";
import { useStatDefinitions } from "../lib/useStatDefinitions";
import { EMPTY_FILTER, requestFilter } from "./hands/filter";
import { parsePlayerParam, playerParam } from "./players/param";

/** The store's rebuild after an upgrade and its indexing of new opponents, polled while either runs. */
function useRebuild(): StatsStatus | null {
  const [status, setStatus] = useState<StatsStatus | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      ipc
        .statsStatus()
        .then((value) => {
          if (stopped) return;
          setStatus(value);
          if (recomputing(value) || value.activity === "indexing" || value.playersUnindexed > 0) {
            timer = window.setTimeout(poll, 3000);
          }
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

export function Players() {
  const t = useT();
  const p = t.players;
  const selected = parsePlayerParam(useRouteParam());
  const definitions = useStatDefinitions();
  const rebuild = useRebuild();
  const rowHeight = useRowHeight();

  if (!inApp) {
    return (
      <div className={styles.screen}>
        <h1 className={styles.title}>{t.screens.players.title}</h1>
        <p className={styles.message}>{p.unavailable}</p>
      </div>
    );
  }

  const notice = recomputing(rebuild) ? (
    <RecomputeNotice status={rebuild} filling={p.rebuilding} className={styles.notice} />
  ) : rebuild && rebuild.playersUnindexed > 0 && rebuild.activity !== "idle" ? (
    <p className={styles.notice} role="status">
      {p.indexing(rebuild.playersUnindexed)}
    </p>
  ) : null;

  return (
    <PlayersScreen
      source={storePlayersSource}
      definitions={definitions}
      selected={selected}
      onSelect={(player) => replaceParam("players", player === null ? null : playerParam(player.site, player.player))}
      onHandsWith={(player) => {
        requestFilter({ ...EMPTY_FILTER, player });
        go("hands");
      }}
      title={t.screens.players.title}
      notice={notice}
      emptyText={p.empty}
      notesFootnote={p.profile.localOnly}
      renderState={(kind, text, compact) => (
        <StateMessage kind={kind} compact={compact}>
          {text}
        </StateMessage>
      )}
      fill
      densityKey={rowHeight}
    />
  );
}

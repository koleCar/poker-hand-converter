"use client";

/**
 * The Analysis tab's Multiway and Bomb pots pages on the web (analysis/45,
 * design `ideas-potkinds` variant C): Supabase's data (`lib/db/potKinds.ts`)
 * handed to the shared views (`@rail/ui/potKinds`), as the app does from its
 * store. The other Analysis pages read heads-up spots only.
 */

import { BombPotsView, MultiwayView } from "@rail/ui/potKinds/PotKinds";
import type { BombSummary, MultiwaySummary, PotKindDecision } from "@rail/ui/potKinds/model";
import { useUiStrings } from "@rail/ui/i18n";
import { useEffect, useState } from "react";

import { fetchBombSummary, fetchMultiwaySummary, fetchPotKindDecisions } from "../../../lib/db/potKinds";
import { paths } from "../../../lib/routes";
import { AnalysisNav } from "../AnalysisNav";
import { TopLeaks } from "../leaks/TopLeaks";

const decisionHref = (row: PotKindDecision) => paths.analysisHand(row.handKey, `t=a${row.actionIndex}`);

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

function useLoaded<T>(load: () => Promise<T>, refreshToken: number): Loaded<T> {
  const [state, setState] = useState<{ token: number; value: Loaded<T> }>({ token: -1, value: { status: "loading" } });
  useEffect(() => {
    let live = true;
    load()
      .then((data) => live && setState({ token: refreshToken, value: { status: "ready", data } }))
      .catch((error: unknown) =>
        live && setState({ token: refreshToken, value: { status: "error", message: error instanceof Error ? error.message : String(error) } }),
      );
    return () => {
      live = false;
    };
    // `load` is a module function per page; the token re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);
  return state.token === refreshToken ? state.value : { status: "loading" };
}

function Message({ children }: { children: string }) {
  return <p className="muted">{children}</p>;
}

export function BombPotsTab({ refreshToken }: { refreshToken: number }) {
  const t = useUiStrings().potKinds;
  const summary = useLoaded<BombSummary>(fetchBombSummary, refreshToken);
  const worth = useLoaded<PotKindDecision[]>(() => fetchPotKindDecisions("bomb"), refreshToken);
  return (
    <div className="stats">
      <AnalysisNav current="bomb" />
      {summary.status === "loading" ? (
        <Message>{t.bomb.loading}</Message>
      ) : summary.status === "error" || summary.data.hands === 0 ? (
        <Message>{t.bomb.empty}</Message>
      ) : (
        <BombPotsView summary={summary.data} worth={worth.status === "ready" ? worth.data : null} decisionHref={decisionHref} />
      )}
    </div>
  );
}

export function MultiwayTab({ refreshToken }: { refreshToken: number }) {
  const t = useUiStrings().potKinds;
  const summary = useLoaded<MultiwaySummary>(fetchMultiwaySummary, refreshToken);
  const worth = useLoaded<PotKindDecision[]>(() => fetchPotKindDecisions("mw"), refreshToken);
  return (
    <div className="stats">
      <AnalysisNav current="multiway" />
      {summary.status === "loading" ? (
        <Message>{t.mw.loading}</Message>
      ) : summary.status === "error" || summary.data.decisions === 0 ? (
        <Message>{t.mw.empty}</Message>
      ) : (
        <MultiwayView
          summary={summary.data}
          worth={worth.status === "ready" ? worth.data : null}
          decisionHref={decisionHref}
          spots={<TopLeaks scopeKey="{}" generation={refreshToken} backQuery="" initialPeriod="all" potKind="mw" />}
        />
      )}
    </div>
  );
}

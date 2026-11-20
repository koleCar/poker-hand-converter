/**
 * The Analysis screen's Multiway and Bomb pots tabs in the app (analysis/45):
 * the store's data handed to the shared views (`@rail/ui/potKinds`). The
 * bomb pots are summed here from their stored PHF (`bombSummary`); the
 * multiway hands from the store's own sums (`multiway_summary`).
 */

import { BombPotsView, MultiwayView } from "@rail/ui/potKinds/PotKinds";
import type { BombSummary, MultiwaySummary, PotKindDecision } from "@rail/ui/potKinds/model";
import { useUiStrings } from "@rail/ui/i18n";
import { useEffect, useState, type ReactNode } from "react";

import { StateMessage } from "../../components/StateMessage";
import { ANALYSIS_VERSION, bombSummary, type PhfHand } from "../../analysis/library";
import { ipc } from "../../lib/ipc";
import { screenHref } from "../../lib/router";
import { viewParam } from "./view";

const hrefOf = (back: "bomb" | "multiway") => (row: PotKindDecision) =>
  screenHref("analysis", viewParam({ kind: "hand", key: row.handKey, actionIndex: row.actionIndex, back }));

export function BombPotsTab({ hidden, reload }: { hidden: boolean; reload: number }) {
  const t = useUiStrings().potKinds;
  const [summary, setSummary] = useState<BombSummary | null | "error">(null);
  const [worth, setWorth] = useState<PotKindDecision[] | null>(null);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    void (async () => {
      try {
        const phfs = await ipc.bombPotPhfs();
        const hands = phfs.map((text) => JSON.parse(text) as PhfHand);
        if (live) setSummary(bombSummary(hands));
        const rows = await ipc.potKindDecisions(ANALYSIS_VERSION, "bomb", 12);
        if (live) setWorth(rows);
      } catch {
        if (live) setSummary("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [hidden, reload]);

  if (hidden) return null;
  if (summary === null) return <StateMessage kind="loading">{t.bomb.loading}</StateMessage>;
  if (summary === "error" || summary.hands === 0) return <StateMessage kind="empty">{t.bomb.empty}</StateMessage>;
  return <BombPotsView summary={summary} worth={worth} decisionHref={hrefOf("bomb")} />;
}

export function MultiwayTab({ hidden, reload, spots }: { hidden: boolean; reload: number; spots: ReactNode }) {
  const t = useUiStrings().potKinds;
  const [summary, setSummary] = useState<MultiwaySummary | null | "error">(null);
  const [worth, setWorth] = useState<PotKindDecision[] | null>(null);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    void (async () => {
      try {
        const s = await ipc.multiwaySummary(ANALYSIS_VERSION);
        if (live) setSummary(s);
        const rows = await ipc.potKindDecisions(ANALYSIS_VERSION, "mw", 12);
        if (live) setWorth(rows);
      } catch {
        if (live) setSummary("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [hidden, reload]);

  if (hidden) return null;
  if (summary === null) return <StateMessage kind="loading">{t.mw.loading}</StateMessage>;
  if (summary === "error" || summary.decisions === 0) return <StateMessage kind="empty">{t.mw.empty}</StateMessage>;
  return <MultiwayView summary={summary} worth={worth} spots={spots} decisionHref={hrefOf("multiway")} />;
}

import { useCallback, useEffect, useState } from "react";
import { ConverterTab } from "../components/ConverterTab";
import { ReplayerTab } from "../components/ReplayerTab";
import { AppShell, type ShellTab } from "../components/shell/AppShell";
import { countHands } from "../lib/handStore";
import { isSupabaseConfigured } from "../lib/supabase";
import { NotFoundPage } from "./NotFoundPage";
import type { RouteMatch } from "./routes";
import { paths } from "./routes";
import { useDocumentMeta } from "./useDocumentMeta";

const META: Record<ShellTab, { title: string; description: string; path: string }> = {
  converter: {
    title: "Poker hand history converter — WePlay, PokerStars, GGPoker | PokerConverter",
    description:
      "Convert hand histories from any poker room into the standard format Holdem Manager and PokerTracker import. Free, in your browser, nothing uploaded.",
    path: paths.converter(),
  },
  replayer: {
    title: "Poker hand replayer | PokerConverter",
    description:
      "Replay any poker hand action by action, filter your saved hands, and share a hand with a single link.",
    path: paths.replayer(),
  },
};

export default function AppPage({ route }: { route: RouteMatch }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [storedCount, setStoredCount] = useState<number | null>(null);

  const tab: ShellTab | null =
    route.name === "converter" ? "converter" : route.name === "replayer" ? "replayer" : null;

  const refreshCount = useCallback(() => {
    if (!isSupabaseConfigured) {
      return;
    }
    void countHands().then(setStoredCount);
  }, []);

  useEffect(refreshCount, [refreshCount, refreshToken]);

  const handleHandsSaved = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  const meta = tab
    ? META[tab]
    : {
        title: "Page not found | PokerConverter",
        description: "That address does not match anything in PokerConverter.",
        path: route.pathname,
      };
  useDocumentMeta({
    title: meta.title,
    description: meta.description,
    canonicalPath: meta.path,
    noIndex: tab === null,
  });

  return (
    <AppShell tab={tab} dbConfigured={isSupabaseConfigured} storedCount={storedCount}>
      {tab === "converter" ? <ConverterTab onHandsSaved={handleHandsSaved} /> : null}
      {tab === "replayer" ? <ReplayerTab refreshToken={refreshToken} /> : null}
      {tab === null ? <NotFoundPage /> : null}
    </AppShell>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { ReplayerTab } from "../components/ReplayerTab";
import { AppShell, type ShellTab } from "../components/shell/AppShell";
import { UploadTab } from "../components/upload/UploadTab";
import { useAuth } from "../lib/auth";
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
    title: "My poker hands | PokerConverter",
    description:
      "Browse, filter and replay every poker hand you have saved, and share one with a single link.",
    path: paths.replayer(),
  },
};

export default function AppPage({ route }: { route: RouteMatch }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [storedCount, setStoredCount] = useState<number | null>(null);
  const auth = useAuth();

  const tab: ShellTab | null =
    route.name === "converter" ? "converter" : route.name === "replayer" ? "replayer" : null;

  const refreshCount = useCallback(() => {
    if (!isSupabaseConfigured || !auth.isSignedIn) {
      return;
    }
    void countHands().then(setStoredCount);
  }, [auth.isSignedIn]);

  useEffect(refreshCount, [refreshCount, refreshToken]);

  /**
   * Offer the dialog once, to someone who has never answered the question.
   *
   * Not a gate: dismissing it, or choosing "continue without an account",
   * leaves a fully working converter. It exists because the alternative is a
   * person converting a 5000-hand file and only then discovering that saving it
   * needed an account. `askedRef` keeps a re-render from reopening a dialog the
   * user just closed.
   */
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || !auth.configured || auth.status !== "signed-out" || auth.isGuest) {
      return;
    }
    askedRef.current = true;
    auth.requestSignIn();
  }, [auth]);

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
    <AppShell
      tab={tab}
      dbConfigured={isSupabaseConfigured}
      // The chip counts "hands in your library", so it is meaningless without
      // one. Derived rather than cleared on sign-out, so the last account's
      // number can never be left sitting in the bar for the next visitor.
      storedCount={auth.isSignedIn ? storedCount : null}
    >
      {tab === "converter" ? <UploadTab onHandsSaved={handleHandsSaved} /> : null}
      {tab === "replayer" ? <ReplayerTab refreshToken={refreshToken} /> : null}
      {tab === null ? <NotFoundPage /> : null}
    </AppShell>
  );
}

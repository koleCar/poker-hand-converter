import { useCallback, useEffect, useRef, useState } from "react";
import { hasPendingHand } from "../components/converter/handoff";
import { ReplayerTab } from "../components/ReplayerTab";
import { AppShell, type ShellTab } from "../components/shell/AppShell";
import { StatsTab } from "../components/stats/StatsTab";
import { UploadTab } from "../components/upload/UploadTab";
import { useAuth } from "../lib/auth";
import { countHands } from "../lib/db";
import { isSupabaseConfigured } from "../lib/supabase";
import { navigate } from "./navigation";
import { NotFoundPage } from "./NotFoundPage";
import type { RouteMatch } from "./routes";
import { paths } from "./routes";
import { useDocumentMeta } from "./useDocumentMeta";

const META: Record<ShellTab, { title: string; description: string; path: string }> = {
  converter: {
    title: "Poker hand history converter — WePlay, PokerStars, GGPoker | Rail",
    description:
      "Convert hand histories from any poker room into the standard format Holdem Manager and PokerTracker import. Free, in your browser, nothing uploaded.",
    path: paths.converter(),
  },
  replayer: {
    title: "Hand history | Rail",
    description:
      "Browse, filter and replay every poker hand you have saved, and share one with a single link.",
    path: paths.replayer(),
  },
  stats: {
    title: "Statistics | Rail",
    description:
      "VPIP, PFR, 3-bet, continuation bets and a showdown / non-showdown win-rate graph, over every hand you have saved.",
    path: paths.stats(),
  },
};

export default function AppPage({ route }: { route: RouteMatch }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [storedCount, setStoredCount] = useState<number | null>(null);
  const auth = useAuth();

  const tab: ShellTab | null =
    route.name === "converter"
      ? "converter"
      : route.name === "replayer"
        ? "replayer"
        : route.name === "stats"
          ? "stats"
          : null;

  const refreshCount = useCallback(() => {
    if (!isSupabaseConfigured || !auth.isSignedIn) {
      return;
    }
    void countHands().then(setStoredCount);
  }, [auth.isSignedIn]);

  useEffect(refreshCount, [refreshCount, refreshToken]);

  /**
   * Who gets a hand history, and when the answer is known.
   *
   * `settled` matters as much as `hasHistory`: on a cold load both the session
   * and the count arrive a beat late, and acting on "no hands" before they do
   * would bounce a signed-in user off their own library.
   */
  const settled = auth.status !== "loading" && (!auth.isSignedIn || storedCount !== null);
  const hasHistory = auth.isSignedIn && (storedCount ?? 0) > 0;

  /**
   * A hand the converter parked keeps the route open on its own.
   *
   * Latched during render rather than in an effect, because `ReplayerTab`
   * consumes the `sessionStorage` key when it mounts — which is before any
   * effect here could look. Without the latch the hand would open and the
   * redirect below would close it again on the next render.
   */
  const [handedOver, setHandedOver] = useState(false);
  if (tab === "replayer") {
    if (!handedOver && hasPendingHand()) {
      setHandedOver(true);
    }
  } else if (handedOver) {
    setHandedOver(false);
  }

  const historyOpen = hasHistory || handedOver;

  // The tab is hidden in this state, so the address has to agree with the bar:
  // an old bookmark or a stale link lands on the converter instead of a screen
  // that is one sign-in gate all the way down.
  useEffect(() => {
    if (tab === "replayer" && settled && !historyOpen) {
      navigate(paths.converter(), { replace: true });
    }
  }, [tab, settled, historyOpen]);

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
        title: "Page not found | Rail",
        description: "That address does not match anything on Rail.",
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
      showHistoryTab={historyOpen}
      dbConfigured={isSupabaseConfigured}
      // The chip counts "hands in your library", so it is meaningless without
      // one. Derived rather than cleared on sign-out, so the last account's
      // number can never be left sitting in the bar for the next visitor.
      storedCount={auth.isSignedIn ? storedCount : null}
    >
      {tab === "converter" ? <UploadTab onHandsSaved={handleHandsSaved} /> : null}
      {/* Rendered while the answer is still unknown — the tab has its own
          loading states, and unmounting it once `settled` says no keeps the
          redirect from flashing a library on the way out. */}
      {tab === "replayer" && (historyOpen || !settled) ? (
        <ReplayerTab refreshToken={refreshToken} onHandsSaved={handleHandsSaved} />
      ) : null}
      {/* Deliberately not behind the `historyOpen` redirect the replayer uses.
          The tab is still hidden from the bar until there is a library behind
          it, but a typed or bookmarked /stats renders the screen and lets it
          explain itself — "sign in", "nothing saved yet", "statistics are not
          set up on this database". Bouncing someone to the converter instead
          would answer a question they asked by pretending they did not. */}
      {tab === "stats" ? <StatsTab refreshToken={refreshToken} /> : null}
      {tab === null ? <NotFoundPage /> : null}
    </AppShell>
  );
}

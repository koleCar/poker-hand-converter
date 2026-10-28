"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { hasPendingHand } from "../converter/handoff";
import { AppShell, type ShellTab } from "./AppShell";
import { markSignInOffered, useAuth, wasSignInOffered } from "../../lib/auth";
import { countHands } from "../../lib/db";
import { paths } from "../../lib/routes";
import { isSupabaseConfigured } from "../../lib/supabase/config";
import {
  DESKTOP_SYNC_QUIET_MS,
  noteDesktopBatch,
  type ArrivalBatch,
  type DesktopSyncState,
} from "../../lib/live/arrivals";
import { LiveStrip } from "../live/LiveStrip";
import { ProLock } from "../plan/ProLock";
import type { Feature } from "../../lib/db/entitlements";
import { useEntitlements } from "../../lib/entitlements/context";
import { useHandArrivals } from "../live/useHandArrivals";
import { useOtherUploads } from "../live/useLiveActivity";

/**
 * Everything the three signed-in screens share, minus the screen.
 *
 * This is what is left of `routes/AppPage.tsx` once the App Router owns route
 * matching. It used to be a switch over `route.name` that rendered one of three
 * tabs; now each route has its own `page.tsx` and mounts this around its own
 * content. The state it holds — the stored-hand count, the "have they been
 * asked to sign in yet" latch, the replayer hand-off — is genuinely shared and
 * genuinely client-side, so it stays in one component rather than being copied
 * into three pages.
 *
 * `children` is a function rather than a node because the tabs need two values
 * this component owns (`refreshToken`, `onHandsSaved`) and React Server
 * Components cannot be handed a callback through a `children` prop. Both sides
 * of this boundary are client components, so a render prop is free.
 */

export interface AppFrameContext {
  /** Bumped whenever hands are saved; tabs re-query on change. */
  refreshToken: number;
  onHandsSaved: () => void;
  /**
   * The latest batch of hands that arrived live (Rail R1.10): from the
   * desktop app or another tab. Null until something arrives, and always null
   * on a screen that is not `live`. Its `seq` changes once per debounced
   * batch, never per hand.
   */
  arrival: ArrivalBatch | null;
}

interface AppFrameProps {
  tab: ShellTab | null;
  /**
   * Bounce to the converter when the visitor has no library and no hand parked.
   *
   * True for `/library` only. The tab is hidden in that state, so the address
   * has to agree with the bar: an old bookmark or a stale link lands on the
   * converter instead of a screen that is one sign-in gate all the way down.
   *
   * Deliberately false for `/stats`, which renders and explains itself instead
   * — "sign in", "nothing saved yet", "statistics are not set up on this
   * database". Bouncing someone to the converter there would answer a question
   * they asked by pretending they did not.
   */
  redirectWhenEmpty?: boolean;
  /**
   * Listen for hands arriving in the account while the screen is open
   * (Realtime, `components/live/useHandArrivals.ts`), and show the live strip
   * (R4.3: uploads in the account's other tabs, the desktop app syncing).
   *
   * - `true`: the screen re-reads on its own from `arrival` (`/library`,
   *   `/stats`).
   * - `"notify"`: the screen is not touched; the strip offers "N new hands
   *   arrived - refresh", which bumps `refreshToken` (the analysis screens,
   *   whose re-read is a visible reload).
   *
   * Never the converter, whose promise is no server requests (its own upload
   * publishes itself, `useUploadPresence`).
   */
  live?: boolean | "notify";
  /**
   * The Pro feature the screen is (R6.2). When the database would refuse it
   * - enforcement on and the account's plan without it - the screen shows
   * the lock instead of a page of refusals. Defaults from the tab: Analysis
   * is `analysis`, Learn is `learn`; `null` opts out. Never shown while
   * enforcement is off.
   */
  feature?: Feature | null;
  /** Edge to edge (`AppShell.wide`). */
  wide?: boolean;
  children: (context: AppFrameContext) => ReactNode;
}

/** The Pro feature each tab is, unless the screen says otherwise. */
const TAB_FEATURE: Partial<Record<ShellTab, Feature>> = { analysis: "analysis", learn: "learn" };

export function AppFrame({ tab, redirectWhenEmpty = false, live = false, feature, wide = false, children }: AppFrameProps) {
  const router = useRouter();
  const entitlements = useEntitlements();
  const screenFeature = feature === undefined ? (tab ? (TAB_FEATURE[tab] ?? null) : null) : feature;
  const screenLocked = screenFeature !== null && entitlements.locked(screenFeature);
  // A Pro screen waits for the answer (once per page load) rather than
  // firing its readers into refusals the lock then covers.
  const screenPending = screenFeature !== null && entitlements.status === "loading";
  const lockedTabs = (Object.keys(TAB_FEATURE) as ShellTab[]).filter((id) => {
    const tabFeature = TAB_FEATURE[id];
    return tabFeature !== undefined && entitlements.locked(tabFeature);
  });
  const [refreshToken, setRefreshToken] = useState(0);
  const [storedCount, setStoredCount] = useState<number | null>(null);
  const auth = useAuth();

  const refreshCount = useCallback(() => {
    if (!isSupabaseConfigured || !auth.isSignedIn) {
      return;
    }
    void countHands().then(setStoredCount);
  }, [auth.isSignedIn]);

  useEffect(refreshCount, [refreshCount, refreshToken]);

  // Hands arriving live move the chip and are handed to the screen. Keyed by
  // the account, so a sign-out or a switch drops the subscription and the
  // last account's batch with it.
  const liveUser = live && isSupabaseConfigured && auth.isSignedIn ? (auth.user?.id ?? null) : null;
  const [arrival, setArrival] = useState<{ user: string; batch: ArrivalBatch } | null>(null);
  /** Notify screens: hands that arrived since the screen last read (R4.3). */
  const [unseen, setUnseen] = useState<{ user: string; hands: number } | null>(null);
  const [desktop, setDesktop] = useState<{ user: string; sync: DesktopSyncState } | null>(null);
  const onArrival = useCallback(
    (batch: ArrivalBatch) => {
      if (!liveUser) return;
      if (live === "notify") {
        // A resync alone (a reconnect, count unknown) may have brought
        // nothing: no button for it.
        if (batch.hands > 0) {
          setUnseen((current) => ({
            user: liveUser,
            hands: (current && current.user === liveUser ? current.hands : 0) + batch.hands,
          }));
        }
      } else {
        setArrival({ user: liveUser, batch });
      }
      if (batch.desktopHands > 0) {
        const now = Date.now();
        setDesktop((current) => {
          const sync = noteDesktopBatch(current && current.user === liveUser ? current.sync : null, batch, now);
          return sync ? { user: liveUser, sync } : null;
        });
      }
      refreshCount();
    },
    [live, liveUser, refreshCount],
  );
  useHandArrivals(liveUser, onArrival);
  const currentArrival = arrival && arrival.user === liveUser ? arrival.batch : null;
  const otherUploads = useOtherUploads(liveUser);

  // The desktop line goes once the sync has been quiet long enough: every
  // batch makes a new state object, so this restarts with each one.
  const desktopSync = desktop && desktop.user === liveUser ? desktop.sync : null;
  useEffect(() => {
    if (!desktopSync) return;
    const timer = setTimeout(
      () => setDesktop((current) => (current && current.sync === desktopSync ? null : current)),
      DESKTOP_SYNC_QUIET_MS,
    );
    return () => clearTimeout(timer);
  }, [desktopSync]);
  // `/library` says which device is syncing under its own heading (R1.10).
  const shownDesktop = tab === "library" ? null : desktopSync;
  const unseenHands = live === "notify" && unseen && unseen.user === liveUser ? unseen.hands : null;
  const showUnseen = useCallback(() => {
    setUnseen(null);
    setRefreshToken((current) => current + 1);
  }, []);

  /**
   * Who gets a hand history, and when the answer is known.
   *
   * `settled` matters as much as `hasHistory`: on a cold load the count arrives
   * a beat late, and acting on "no hands" before it does would bounce a
   * signed-in user off their own library. The session itself no longer lags —
   * `initialUser` comes from the server — so `status === "loading"` is now a
   * rare state rather than the first frame of every load.
   */
  const settled = auth.status !== "loading" && (!auth.isSignedIn || storedCount !== null);
  const hasHistory = auth.isSignedIn && (storedCount ?? 0) > 0;

  /**
   * A hand the converter parked keeps the route open on its own.
   *
   * Latched during render rather than in an effect, because `LibraryHands`
   * consumes the `sessionStorage` key when it mounts — which is before any
   * effect here could look. Without the latch the hand would open and the
   * redirect below would close it again on the next render.
   */
  const [handedOver, setHandedOver] = useState(false);
  if (redirectWhenEmpty) {
    if (!handedOver && hasPendingHand()) {
      setHandedOver(true);
    }
  } else if (handedOver) {
    setHandedOver(false);
  }

  const historyOpen = hasHistory || handedOver;

  useEffect(() => {
    if (redirectWhenEmpty && settled && !historyOpen) {
      router.replace(paths.convert());
    }
  }, [redirectWhenEmpty, settled, historyOpen, router]);

  /**
   * Offer the dialog once per browser session, to someone who has never
   * answered the question.
   *
   * Not a gate: dismissing it, or choosing "continue without an account",
   * leaves a fully working converter. It exists because the alternative is a
   * person converting a 5000-hand file and only then discovering that saving it
   * needed an account. The latch is per session, not per mount (`lib/auth/offer.ts`):
   * every route mounts its own `AppFrame`, and a visitor who closed the dialog
   * must not get it back on the next link they follow.
   */
  useEffect(() => {
    if (wasSignInOffered() || !auth.configured || auth.status !== "signed-out" || auth.isGuest) {
      return;
    }
    markSignInOffered();
    auth.requestSignIn();
  }, [auth]);

  const refreshEntitlements = entitlements.refresh;
  const onHandsSaved = useCallback(() => {
    setRefreshToken((current) => current + 1);
    // The plan's usage (hands stored against the cap) follows a save.
    void refreshEntitlements();
  }, [refreshEntitlements]);

  /** True while the library route is still deciding whether to bounce. */
  const holdForRedirect = redirectWhenEmpty && !historyOpen && settled;

  return (
    <AppShell
      tab={tab}
      showHistoryTab={historyOpen}
      dbConfigured={isSupabaseConfigured}
      // The chip counts "hands in your library", so it is meaningless without
      // one. Derived rather than cleared on sign-out, so the last account's
      // number can never be left sitting in the bar for the next visitor.
      storedCount={auth.isSignedIn ? storedCount : null}
      lockedTabs={lockedTabs}
      wide={wide}
    >
      {/* Rendered while the answer is still unknown — the tabs have their own
          loading states, and unmounting once `settled` says no keeps the
          redirect from flashing a library on the way out. */}
      {holdForRedirect || !liveUser ? null : (
        <LiveStrip uploads={otherUploads} desktop={shownDesktop} newHands={unseenHands} onRefresh={showUnseen} />
      )}
      {holdForRedirect || screenPending ? null : screenLocked && screenFeature ? (
        <ProLock feature={screenFeature} />
      ) : (
        children({ refreshToken, onHandsSaved, arrival: currentArrival })
      )}
    </AppShell>
  );
}

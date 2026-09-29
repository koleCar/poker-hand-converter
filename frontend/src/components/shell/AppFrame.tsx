"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { hasPendingHand } from "../converter/handoff";
import { AppShell, type ShellTab } from "./AppShell";
import { useAuth } from "../../lib/auth";
import { countHands } from "../../lib/db";
import { paths } from "../../lib/routes";
import { isSupabaseConfigured } from "../../lib/supabase/config";

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
  children: (context: AppFrameContext) => ReactNode;
}

export function AppFrame({ tab, redirectWhenEmpty = false, children }: AppFrameProps) {
  const router = useRouter();
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
   * Latched during render rather than in an effect, because `ReplayerTab`
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

  const onHandsSaved = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

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
    >
      {/* Rendered while the answer is still unknown — the tabs have their own
          loading states, and unmounting once `settled` says no keeps the
          redirect from flashing a library on the way out. */}
      {holdForRedirect ? null : children({ refreshToken, onHandsSaved })}
    </AppShell>
  );
}

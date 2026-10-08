"use client";

/**
 * Holds the session for the whole app.
 *
 * Three things here are worth more than their line count:
 *
 *  * **`onAuthStateChange` is the source of truth, not the promise returns.**
 *    A session can start or end without this app asking — a token refresh
 *    fails, another tab signs out, the OAuth callback lands. Deriving state
 *    from the subscription means all four paths converge on one code path, and
 *    the sign-in functions below never have to set state at all.
 *  * **`initialUser` comes from the server.** The root layout resolves it with
 *    `getServerUser()` — a real, signature-verified `getUser()` — and hands it
 *    down. That kills the `status: "loading"` first paint, and with it the
 *    "flash the sign-in dialog at every returning user on every reload"
 *    problem. `"loading"` survives only for the case it was always really for:
 *    no server answer at all.
 *  * **The server's answer is a starting point, not a lock.** The subscription
 *    still overrides it a beat later, because the tab can outlive the render —
 *    another tab signs out, a refresh fails, an hour passes.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isCaptchaEnabled, isSupabaseConfigured } from "../supabase/config";
import { getBrowserSupabase } from "../supabase/browser";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./context";
import {
  isGoogleAuthOffered,
  resendConfirmation,
  sendPasswordReset as sendPasswordResetRequest,
  signInWithGoogle as startGoogleSignIn,
  signInWithPassword,
  signOut as endSession,
  signUpWithPassword,
  toAuthUser,
  updatePassword,
  type AuthUser,
} from "./session";

/**
 * Remembers that this browser chose "continue without an account".
 *
 * `localStorage`, not state: the point of the choice is that it survives a
 * reload, otherwise the dialog is back on the next visit and the answer was
 * worth nothing.
 */
const GUEST_KEY = "pokerconverter.guest";

function readGuestFlag(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === "yes";
  } catch {
    return false;
  }
}

function writeGuestFlag(value: boolean) {
  try {
    if (value) {
      localStorage.setItem(GUEST_KEY, "yes");
    } else {
      localStorage.removeItem(GUEST_KEY);
    }
  } catch {
    // A browser with storage blocked just gets asked again next visit.
  }
}

interface AuthProviderProps {
  children: ReactNode;
  /**
   * The verified user, resolved server-side by the root layout.
   *
   * `undefined` means "nobody asked the server" (a purely client render, or a
   * build with no database) and keeps the old `"loading"` behaviour. `null`
   * means the server asked and the answer was "signed out", which is a fact and
   * is rendered as one.
   */
  initialUser?: AuthUser | null;
}

export function AuthProvider({ children, initialUser }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>(() => {
    if (!isSupabaseConfigured) {
      return "signed-out";
    }
    if (initialUser === undefined) {
      return "loading";
    }
    return initialUser ? "signed-in" : "signed-out";
  });
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [isGuest, setIsGuest] = useState(readGuestFlag);
  const [signInPrompt, setSignInPrompt] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      return;
    }
    let active = true;

    // `onAuthStateChange` fires an INITIAL_SESSION event on subscribe, which
    // covers the restore-from-cookie case and the OAuth callback alike. The
    // explicit getSession() below is only a belt-and-braces guard for the
    // unlikely case where that event is missed.
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) {
        return;
      }
      setUser(toAuthUser(session?.user));
      setStatus(session ? "signed-in" : "signed-out");
      if (session) {
        // Signing in ends guest mode, and closes the dialog that asked for it.
        setIsGuest(false);
        writeGuestFlag(false);
        setSignInOpen(false);
        setSignInPrompt(null);
      }
      if (event === "SIGNED_OUT") {
        setIsGuest(false);
        writeGuestFlag(false);
      }
    });

    // `getSession()` and not `getUser()`: this runs in the tab, against a cookie
    // this origin wrote, and a network round trip on every mount to re-confirm
    // what the server already told us in `initialUser` would be a page-load cost
    // for no new information. Server code has the opposite rule — see
    // `lib/supabase/server.ts`.
    void supabase.auth.getSession().then(({ data: current }) => {
      if (!active) {
        return;
      }
      setUser(toAuthUser(current.session?.user));
      setStatus(current.session ? "signed-in" : "signed-out");
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const requestSignIn = useCallback((reason?: string) => {
    setSignInPrompt(reason ?? null);
    setSignInOpen(true);
  }, []);

  const dismissSignIn = useCallback(() => {
    setSignInOpen(false);
    setSignInPrompt(null);
  }, []);

  const continueAsGuest = useCallback(() => {
    setIsGuest(true);
    writeGuestFlag(true);
    setSignInOpen(false);
    setSignInPrompt(null);
  }, []);

  const signOut = useCallback(async () => {
    await endSession();
    // The subscription above clears the rest; only the guest flag is ours.
    setIsGuest(false);
    writeGuestFlag(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isSignedIn: status === "signed-in",
      isGuest,
      configured: isSupabaseConfigured,
      googleOffered: isGoogleAuthOffered,
      captchaEnabled: isCaptchaEnabled,
      signIn: signInWithPassword,
      signUp: signUpWithPassword,
      signInWithGoogle: startGoogleSignIn,
      sendPasswordReset: sendPasswordResetRequest,
      resendConfirmation,
      updatePassword,
      signOut,
      continueAsGuest,
      requestSignIn,
      dismissSignIn,
      signInPrompt,
      signInOpen,
    }),
    [status, user, isGuest, signOut, continueAsGuest, requestSignIn, dismissSignIn, signInPrompt, signInOpen],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Holds the session for the whole app.
 *
 * Two things here are worth more than their line count:
 *
 *  * **`onAuthStateChange` is the source of truth, not the promise returns.**
 *    A session can start or end without this app asking — a token refresh
 *    fails, another tab signs out, the OAuth redirect lands. Deriving state
 *    from the subscription means all four paths converge on one code path, and
 *    the sign-in functions below never have to set state at all.
 *  * **`status` starts at `"loading"`.** Reading the stored session is async,
 *    so a provider that started at `"signed-out"` would flash the sign-in
 *    dialog at every returning user on every reload.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isSupabaseConfigured, supabase } from "../supabase";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./context";
import {
  isGoogleAuthOffered,
  sendPasswordReset as sendPasswordResetRequest,
  signInWithGoogle as startGoogleSignIn,
  signInWithPassword,
  signOut as endSession,
  signUpWithPassword,
  toAuthUser,
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(
    isSupabaseConfigured ? "loading" : "signed-out",
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isGuest, setIsGuest] = useState(readGuestFlag);
  const [signInPrompt, setSignInPrompt] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);

  useEffect(() => {
    if (!supabase) {
      return;
    }
    let active = true;

    // `onAuthStateChange` fires an INITIAL_SESSION event on subscribe, which
    // covers the restore-from-storage case and the OAuth redirect alike. The
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
      signIn: signInWithPassword,
      signUp: signUpWithPassword,
      signInWithGoogle: startGoogleSignIn,
      sendPasswordReset: sendPasswordResetRequest,
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

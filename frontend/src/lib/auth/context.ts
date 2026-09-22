/**
 * The auth context and its hook.
 *
 * Split out of `AuthProvider.tsx` so that file exports only a component:
 * `react-refresh/only-export-components` disables fast refresh for any module
 * that mixes the two, and losing HMR on the provider means losing it for the
 * whole tree underneath.
 */

import { createContext, useContext } from "react";
import type { AuthUser, SignUpOutcome } from "./session";

export type AuthStatus =
  /** The stored session is still being read. Render nothing auth-dependent yet. */
  | "loading"
  | "signed-in"
  | "signed-out";

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Convenience for `status === "signed-in"`. */
  isSignedIn: boolean;
  /**
   * The user has explicitly chosen to carry on without an account.
   *
   * This is not a second kind of session — a guest is signed out in every way
   * that matters to the database. It only records that they have already been
   * asked, so the app stops putting the dialog in front of them.
   */
  isGuest: boolean;
  /** False in a build with no Supabase credentials; hide every auth affordance. */
  configured: boolean;
  googleOffered: boolean;

  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpOutcome>;
  signInWithGoogle: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  continueAsGuest: () => void;

  /**
   * Opens the sign-in dialog, optionally explaining why it appeared.
   *
   * Lives on the context rather than in each component because the reason is
   * always local ("Sign in to save these 412 hands") while the dialog is
   * always global.
   */
  requestSignIn: (reason?: string) => void;
  dismissSignIn: () => void;
  /** Null when the dialog is closed; the string is the prompt to show. */
  signInPrompt: string | null;
  signInOpen: boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth() must be used inside <AuthProvider>.");
  }
  return value;
}

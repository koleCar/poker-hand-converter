/**
 * The sign-in / sign-up dialog.
 *
 * Opened from anywhere through `useAuth().requestSignIn(reason)`, so the reason
 * a person is looking at it — "Sign in to save these 412 hands" — travels with
 * the call site while the dialog itself stays in one place.
 *
 * Three decisions worth knowing about:
 *
 *  * **"Continue without an account" is a first-class button, not fine print.**
 *    Everything that runs in the browser works without an account: converting,
 *    previewing, downloading, replaying a pasted hand. Hiding that behind a
 *    dismissed modal would make the app look like it needs a login to do the
 *    thing it does best.
 *  * **The dialog never blocks a share link.** `/h/:slug` does not render it at
 *    all; a stranger following a link is not a lead to be converted.
 *  * **Sign-up and sign-in are one form with a toggle**, because on this
 *    project they are literally the same two fields and the same button. The
 *    only real difference is what a wrong password means.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../lib/auth";

type Mode = "sign-in" | "sign-up" | "reset";

const TITLES: Record<Mode, string> = {
  "sign-in": "Sign in",
  "sign-up": "Create an account",
  reset: "Reset your password",
};

const SUBMIT: Record<Mode, string> = {
  "sign-in": "Sign in",
  "sign-up": "Create account",
  reset: "Send reset link",
};

export function AuthDialog() {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const open = auth.signInOpen && auth.configured;

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setNotice(null);
    emailRef.current?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        auth.dismissSignIn();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mode, auth]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "sign-in") {
        await auth.signIn(email, password);
        // No success state to set: the provider's auth subscription closes the
        // dialog as soon as the session lands.
      } else if (mode === "sign-up") {
        const outcome = await auth.signUp(email, password);
        if (outcome.kind === "confirm-email") {
          setNotice(`Check ${outcome.email} for a confirmation link, then sign in.`);
          setMode("sign-in");
        }
      } else {
        await auth.sendPasswordReset(email);
        setNotice(`If ${email.trim()} has an account, a reset link is on its way.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setBusy(true);
    setError(null);
    try {
      // On success the browser leaves the page, so there is nothing after this.
      await auth.signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <div
      className="authdlg__scrim"
      onPointerDown={(event) => {
        if (!panelRef.current?.contains(event.target as Node)) {
          auth.dismissSignIn();
        }
      }}
    >
      <div
        className="authdlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="authdlg-title"
        ref={panelRef}
      >
        <button
          type="button"
          className="authdlg__close"
          onClick={auth.dismissSignIn}
          aria-label="Close"
        >
          ✕
        </button>

        <h2 id="authdlg-title" className="authdlg__title">
          {TITLES[mode]}
        </h2>
        <p className="authdlg__lead">
          {auth.signInPrompt ?? "Your hands stay private to your account."}
        </p>

        {auth.googleOffered ? (
          <>
            <button
              type="button"
              className="btn authdlg__google"
              onClick={() => void handleGoogle()}
              disabled={busy}
            >
              <span aria-hidden="true" className="authdlg__google-mark">
                G
              </span>
              Continue with Google
            </button>
            <p className="authdlg__or">
              <span>or</span>
            </p>
          </>
        ) : null}

        <form className="authdlg__form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="authdlg__field">
            <span>Email</span>
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              spellCheck={false}
            />
          </label>

          {mode !== "reset" ? (
            <label className="authdlg__field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                required
                minLength={6}
              />
            </label>
          ) : null}

          {error ? (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="notice notice--info" role="status">
              {notice}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary authdlg__submit" disabled={busy}>
            {busy ? "Working…" : SUBMIT[mode]}
          </button>
        </form>

        <div className="authdlg__switch">
          {mode === "sign-in" ? (
            <>
              <button type="button" className="linkish" onClick={() => setMode("sign-up")}>
                Create an account
              </button>
              <button type="button" className="linkish" onClick={() => setMode("reset")}>
                Forgot your password?
              </button>
            </>
          ) : (
            <button type="button" className="linkish" onClick={() => setMode("sign-in")}>
              ← Back to sign in
            </button>
          )}
        </div>

        <div className="authdlg__guest">
          <button type="button" className="btn btn--ghost btn--sm" onClick={auth.continueAsGuest}>
            Continue without an account
          </button>
          {/* The one thing a guest cannot work out by trying: converting works,
              keeping does not. Without it the button reads as "lose features". */}
          <small className="muted">Converting works. Saving and sharing need an account.</small>
        </div>
      </div>
    </div>
  );
}

"use client";

/**
 * "Pro is coming" (owner, 2026-11-19): what every "Upgrade to Pro" opens
 * while paid plans are not open. One line, the email (the account's,
 * editable; empty for a visitor), one required box saying it is only for
 * this, "Notify me"; then "You're on the list". A signed-in account already
 * on the list sees that straight away.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "@rail/ui/dialog/Dialog";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useAuth } from "../../lib/auth";
import {
  joinProWaitlist,
  looksLikeEmail,
  myProWaitlist,
  type WaitlistError,
  type WaitlistSource,
} from "../../lib/billing/waitlist";
import { useDict, useLocale } from "../../lib/i18n/client";
import { BusyLabel } from "../shell/BusyLabel";
import styles from "./plan.module.css";
import p from "./pricing.module.css";

type State = "checking" | "editing" | "sending" | "done" | "already";

export function ProWaitlistDialog({
  source,
  onClose,
  initialState,
}: {
  source: WaitlistSource;
  onClose: () => void;
  /** For the tests: the dialog decides by itself. */
  initialState?: State;
}) {
  const w = useDict().pricing.waitlist;
  const locale = useLocale();
  const auth = useAuth();
  const signedIn = auth.isSignedIn;
  const [email, setEmail] = useState(auth.user?.email ?? "");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<State>(initialState ?? (signedIn ? "checking" : "editing"));
  const [error, setError] = useState<WaitlistError | null>(null);

  useEffect(() => {
    if (initialState || !signedIn) return;
    let active = true;
    void myProWaitlist().then((mine) => {
      if (!active) return;
      if (mine?.joined) {
        if (mine.email) setEmail(mine.email);
        setState("already");
      } else {
        setState("editing");
      }
    });
    return () => {
      active = false;
    };
  }, [signedIn, initialState]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!consent) return;
    if (!looksLikeEmail(email)) {
      setError("invalid_email");
      return;
    }
    setState("sending");
    setError(null);
    const result = await joinProWaitlist(email, source, locale);
    if (result.ok) {
      setState(result.already ? "already" : "done");
      return;
    }
    setState("editing");
    setError(result.error);
  };

  const busy = state === "sending";

  return (
    <Dialog title={w.title} onClose={onClose}>
      {state === "checking" ? (
        <RailLoader size="inline" showLabel label={w.checking} />
      ) : state === "done" || state === "already" ? (
        <div className={p.wlDone} role="status">
          <p className={p.wlDoneLine}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12l5 5 9-10" />
            </svg>
            {state === "done" ? w.done : w.already}
          </p>
          {email.trim() ? <p className={styles.dim}>{w.doneNote(email.trim())}</p> : null}
          <div className={styles.actions}>
            <button type="button" className="btn" onClick={onClose}>
              {w.close}
            </button>
          </div>
        </div>
      ) : (
        <form className={p.wlForm} onSubmit={(event) => void submit(event)} noValidate>
          <p className={styles.small}>{w.line}</p>
          <label className={p.wlField}>
            <span>{w.email}</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              spellCheck={false}
              required
              maxLength={254}
              value={email}
              disabled={busy}
              aria-invalid={error === "invalid_email" ? true : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error === "invalid_email") setError(null);
              }}
            />
          </label>
          <label className={styles.consentItem}>
            <input
              type="checkbox"
              name="pro-waitlist-consent"
              required
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>{w.consent}</span>
          </label>
          {error ? (
            <p className="notice notice--error" role="alert">
              {w.errors[error]}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="submit"
              className={`btn ${styles.gold}`}
              disabled={busy || !consent || email.trim() === ""}
            >
              <BusyLabel busy={busy} busyLabel={w.submit}>
                {w.submit}
              </BusyLabel>
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {w.cancel}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

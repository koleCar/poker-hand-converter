"use client";

import { useEffect, useState } from "react";
import { AppFrame } from "../../../components/shell/AppFrame";
import { useAuth } from "../../../lib/auth";
import {
  desktopCallbackUrl,
  desktopCancelUrl,
  markDesktopRequestUsed,
  requestDesktopHandoff,
  takeDesktopRequest,
  type DesktopHandoffError,
  type DesktopRequest,
  type DesktopRequestResult,
} from "../../../lib/auth/desktop";
import { useDict } from "../../../lib/i18n/client";
import type { Dict } from "../../../lib/i18n/types";
import styles from "./desktop.module.css";

/** Client half of `/auth/desktop`. */
export function DesktopSignInScreen() {
  return <AppFrame tab={null}>{() => <DesktopSignIn />}</AppFrame>;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "working" }
  | { kind: "sent"; url: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: DesktopHandoffError };

function errorText(d: Dict["desktop"], error: DesktopHandoffError): string {
  switch (error) {
    case "not_signed_in":
      return d.errors.notSignedIn;
    case "invalid_request":
      return d.errors.invalid;
    case "email_unconfirmed":
      return d.errors.unconfirmed;
    case "account_not_supported":
      return d.errors.unsupported;
    case "rate_limited":
      return d.errors.rateLimited;
    case "unavailable":
      return d.errors.unavailable;
    case "failed":
      return d.errors.failed;
  }
}

function requestProblem(d: Dict["desktop"], result: DesktopRequestResult): string | null {
  switch (result.kind) {
    case "ok":
      return null;
    case "none":
    case "invalid":
      return d.errors.invalid;
    case "expired":
      return d.errors.expired;
    case "used":
      return d.errors.used;
  }
}

function DesktopSignIn() {
  const t = useDict();
  const d = t.desktop;
  const auth = useAuth();
  // Read once, after hydration: the request lives in this tab's address bar
  // or sessionStorage, neither of which the server render can see.
  const [request, setRequest] = useState<DesktopRequestResult | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });

  useEffect(() => {
    setRequest(takeDesktopRequest());
  }, []);

  const heading = (
    <h1 id="desktop-heading" className={styles.heading}>
      {d.heading}
    </h1>
  );

  if (!auth.configured) {
    return (
      <section className={`card ${styles.card}`} aria-labelledby="desktop-heading">
        {heading}
        <p className="notice notice--warn">{d.notConfigured}</p>
      </section>
    );
  }

  if (request === null || auth.status === "loading") {
    return (
      <section className={`card ${styles.card}`} aria-labelledby="desktop-heading">
        {heading}
        <p className="muted">{d.checking}</p>
      </section>
    );
  }

  if (phase.kind === "sent") {
    return (
      <section className={`card ${styles.card}`} aria-labelledby="desktop-heading" aria-live="polite">
        <h1 id="desktop-heading" className={styles.heading}>
          {d.done.heading}
        </h1>
        <p>{d.done.body}</p>
        <div className={styles.actions}>
          <a className="btn btn--primary" href={phase.url}>
            {d.done.openAgain}
          </a>
        </div>
        <p className="muted">{d.done.close}</p>
      </section>
    );
  }

  if (phase.kind === "cancelled") {
    return (
      <section className={`card ${styles.card}`} aria-labelledby="desktop-heading" aria-live="polite">
        <h1 id="desktop-heading" className={styles.heading}>
          {d.cancelled.heading}
        </h1>
        <p className="muted">{d.cancelled.body}</p>
      </section>
    );
  }

  const problem = requestProblem(d, request);
  if (problem || request.kind !== "ok") {
    return (
      <section className={`card ${styles.card}`} aria-labelledby="desktop-heading">
        {heading}
        <p className="notice notice--warn">{problem}</p>
      </section>
    );
  }
  const pending: DesktopRequest = request.request;

  if (!auth.isSignedIn || !auth.user) {
    return (
      <section className={`card ${styles.card}`} aria-labelledby="desktop-heading">
        {heading}
        <p>{d.signedOut.body}</p>
        <div className={styles.actions}>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn(d.signedOut.reason)}>
            {d.signedOut.cta}
          </button>
        </div>
      </section>
    );
  }

  const approve = async () => {
    // The ten minutes may have run out while the page stood open.
    const fresh = takeDesktopRequest();
    if (fresh.kind !== "ok" || fresh.request.state !== pending.state) {
      setRequest(fresh);
      return;
    }
    setPhase({ kind: "working" });
    const result = await requestDesktopHandoff(pending);
    if (!result.ok) {
      setPhase({ kind: "failed", error: result.error });
      return;
    }
    markDesktopRequestUsed(pending.state);
    const url = desktopCallbackUrl(pending.state, result.payload);
    setPhase({ kind: "sent", url });
    window.location.assign(url);
  };

  const cancel = () => {
    markDesktopRequestUsed(pending.state);
    setPhase({ kind: "cancelled" });
    window.location.assign(desktopCancelUrl(pending.state));
  };

  const otherAccount = async () => {
    try {
      await auth.signOut();
    } finally {
      auth.requestSignIn(d.signedOut.reason);
    }
  };

  const working = phase.kind === "working";
  const unconfirmed = !auth.user.emailConfirmed;
  const failure = phase.kind === "failed" ? errorText(d, phase.error) : unconfirmed ? d.errors.unconfirmed : null;

  return (
    <section className={`card ${styles.card}`} aria-labelledby="desktop-heading">
      {heading}
      <p>{d.confirm.account(auth.user.email ?? auth.user.displayName)}</p>
      <p className={styles.question}>{d.confirm.question}</p>
      <p className="muted">{d.confirm.detail}</p>
      {failure && (
        <p className="notice notice--error" role="alert">
          {failure}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={working || unconfirmed}
          onClick={() => void approve()}
        >
          {working ? d.confirm.working : d.confirm.approve}
        </button>
        <button type="button" className="btn btn--ghost" disabled={working} onClick={() => void otherAccount()}>
          {d.confirm.otherAccount}
        </button>
        <button type="button" className="btn btn--ghost" disabled={working} onClick={cancel}>
          {d.confirm.cancel}
        </button>
      </div>
    </section>
  );
}

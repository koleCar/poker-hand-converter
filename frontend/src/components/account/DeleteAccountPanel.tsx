"use client";

/**
 * Settings -> Delete account (Rail R6.5, GDPR Art. 17), on
 * `/settings#delete-account` (the desktop app's "Delete my account" opens
 * it). The user reads what happens, types the username and the password
 * again (a fresh sign-in: the server refuses a session older than 15
 * minutes), and the Edge Function `account-delete` deletes the account in
 * resumable steps (`lib/account/deletion.ts`). A deletion that stopped half
 * way shows here and can be continued.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { runAccountDeletion } from "../../lib/account/deletion";
import { useAuth } from "../../lib/auth";
import {
  callAccountDelete,
  myAccountDeletion,
  type DeleteErrorCode,
  type DeletionState,
} from "../../lib/db/accountData";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { Turnstile } from "../auth/Turnstile";
import styles from "./account.module.css";

/** Set when the account is gone, so the signed-out Settings page can say so. */
export const ACCOUNT_DELETED_FLAG = "rail.accountDeleted";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; step: string | null }
  | { kind: "error"; message: string };

/** What happens, before anything is typed. Exported for the tests. */
export function DeletionExplainer({ t }: { t: Dict["yourData"]["delete"] }) {
  return (
    <>
      <p>
        <strong>{t.intro}</strong>
      </p>
      <h3 className={styles.subheading}>{t.whatHeading}</h3>
      <ul className={styles.list}>
        {t.what.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className={`muted ${styles.small}`}>{t.desktopNote}</p>
    </>
  );
}

export function DeleteAccountPanel({ username }: { username: string }) {
  const en = useDict();
  const t = en.yourData.delete;
  const auth = useAuth();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pending, setPending] = useState<DeletionState | null>(null);
  const section = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#delete-account") {
      section.current?.scrollIntoView();
    }
    let live = true;
    myAccountDeletion()
      .then((state) => {
        if (live) setPending(state);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const matches = confirm.trim().toLowerCase() === username.toLowerCase();
  const working = phase.kind === "working";

  const errorText = (code: DeleteErrorCode) => t.errors[code];

  async function finish(confirmText: string | null) {
    setPhase({ kind: "working", step: null });
    const outcome = await runAccountDeletion(callAccountDelete, confirmText, (step) =>
      setPhase({ kind: "working", step }),
    );
    if (outcome.status === "deleted") {
      try {
        window.sessionStorage.setItem(ACCOUNT_DELETED_FLAG, "1");
      } catch {
        // Storage may be off; the page just will not say it.
      }
      // The session names a user that no longer exists: drop it here.
      await auth.signOut().catch(() => undefined);
      return;
    }
    setPhase({ kind: "error", message: errorText(outcome.code) });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!matches) {
      setPhase({ kind: "error", message: t.mismatch });
      return;
    }
    if (password.length === 0) {
      setPhase({ kind: "error", message: t.needPassword });
      return;
    }
    const email = auth.user?.email;
    if (!email) {
      setPhase({ kind: "error", message: t.errors.not_signed_in });
      return;
    }
    setPhase({ kind: "working", step: null });
    // A fresh sign-in: proves it is the account holder, and gives the
    // session the recent sign-in time the server asks for.
    try {
      await auth.signIn(email, password, captchaToken ?? undefined);
    } catch {
      setPhase({ kind: "error", message: t.wrongPassword });
      if (auth.captchaEnabled) setCaptchaReset((value) => value + 1);
      return;
    } finally {
      setPassword("");
    }
    await finish(confirm.trim());
  }

  return (
    <section
      id="delete-account"
      ref={section}
      className={`card ${styles.panel} ${styles.dangerZone}`}
      aria-labelledby="settings-delete-account"
    >
      <h2 id="settings-delete-account" className={styles.heading}>
        {t.heading}
      </h2>

      {pending && !working ? (
        <div className="notice notice--warn">
          <p className={styles.small}>{t.resumeNotice}</p>
          <div className={styles.actions}>
            <button type="button" className={`btn ${styles.danger}`} onClick={() => void finish(null)}>
              {t.resume}
            </button>
          </div>
        </div>
      ) : null}

      <DeletionExplainer t={t} />
      <p className={styles.small}>
        <a href="#your-data">{t.exportFirst}</a>
      </p>

      <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
        <label className={styles.field}>
          <span>{t.confirmLabel(username)}</span>
          <input
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={64}
            disabled={working}
            required
          />
        </label>
        {/* Tells a password manager which account the password belongs to. */}
        <input type="email" autoComplete="username" value={auth.user?.email ?? ""} readOnly hidden />
        <label className={styles.field}>
          <span>{t.passwordLabel}</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={working}
            required
            aria-describedby="delete-account-password-hint"
          />
        </label>
        <p id="delete-account-password-hint" className={`muted ${styles.small}`}>
          {t.passwordHint}
        </p>
        {auth.captchaEnabled ? <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} /> : null}

        {phase.kind === "working" ? (
          <p className="notice notice--info" role="status">
            {phase.step && phase.step in t.step ? t.step[phase.step as keyof typeof t.step] : t.deleting}
          </p>
        ) : null}
        {phase.kind === "error" ? (
          <p className="notice notice--error" role="alert">
            {phase.message}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button
            type="submit"
            className={`btn ${styles.danger}`}
            disabled={working || !matches || password.length === 0 || (auth.captchaEnabled && !captchaToken)}
          >
            {t.submit}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The signed-out Settings page, right after a deletion. Exported for the tests. */
export function AccountDeletedNotice({ t }: { t: Dict["yourData"]["delete"] }) {
  return (
    <section className={`card ${styles.panel}`} role="status">
      <h1 className={styles.heading}>{t.deletedHeading}</h1>
      <p>{t.deletedBody}</p>
    </section>
  );
}

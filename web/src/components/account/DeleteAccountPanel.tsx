"use client";

/**
 * Delete account (Rail R6.5, GDPR Art. 17), on its own page,
 * `/settings/delete-account` (Settings' danger zone and the desktop app's
 * "Delete my account" open it; the old `/settings#delete-account` redirects). The user reads what happens, types the username and the password
 * again (a fresh sign-in: the server refuses a session older than 15
 * minutes), and the Edge Function `account-delete` deletes the account in
 * resumable steps (`lib/account/deletion.ts`). A deletion that stopped half
 * way shows here and can be continued.
 */

import { useEffect, useState, type FormEvent } from "react";
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
import { RailLoader } from "@rail/ui/loader/RailLoader";
import Link from "next/link";
import { Icon, type IconName } from "@rail/ui/icon/Icon";
import { paths } from "../../lib/routes";
import styles from "./account.module.css";
import rows from "./rows.module.css";

/** Set when the account is gone, so the signed-out Settings page can say so. */
export const ACCOUNT_DELETED_FLAG = "rail.accountDeleted";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; step: string | null }
  | { kind: "error"; message: string };

const WHAT_ICONS: IconName[] = ["cards", "link", "megaphone", "star", "users"];

/** What happens, before anything is typed. Exported for the tests. */
export function DeletionExplainer({ t }: { t: Dict["yourData"]["delete"] }) {
  return (
    <>
      <section className={rows.group} aria-labelledby="delete-account-what">
        <h2 id="delete-account-what" className={rows.groupLabel}>
          {t.whatHeading}
        </h2>
        <p className={rows.note}>{t.intro}</p>
        <ul className={`${rows.card} ${styles.plain}`}>
          {t.what.map((line, index) => (
            <li key={line} className={rows.what}>
              <span className={rows.icon} aria-hidden="true">
                <Icon name={WHAT_ICONS[index] ?? "info"} />
              </span>
              <span>{line}</span>
            </li>
          ))}
          <li className={rows.what}>
            <span className={rows.icon} aria-hidden="true">
              <Icon name="info" />
            </span>
            <span className={rows.muted}>{t.desktopNote}</span>
          </li>
        </ul>
      </section>
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

  useEffect(() => {
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
    <div id="delete-account" className={rows.page}>
      <Link href={paths.settings()} className={rows.back}>
        <Icon name="chevronLeft" />
        {en.settings.heading}
      </Link>

      <div className={`${rows.tile} ${rows.tileDanger}`}>
        <span className={rows.dangerIcon} aria-hidden="true">
          <Icon name="trash" />
        </span>
        <span className={rows.value}>
          <h1 className={`${rows.strong} ${rows.big}`}>{en.settings.danger.title}</h1>
        </span>
        <span />
      </div>

      {pending && !working ? (
        <div className="notice notice--warn">
          <p className={rows.text}>{t.resumeNotice}</p>
          <div className={rows.buttons}>
            <button type="button" className={`btn btn--sm ${rows.dangerSolid}`} onClick={() => void finish(null)}>
              {t.resume}
            </button>
          </div>
        </div>
      ) : null}

      <DeletionExplainer t={t} />

      <div className={rows.tile}>
        <span className={rows.icon} aria-hidden="true">
          <Icon name="download" />
        </span>
        <span className={rows.value}>
          <span className={rows.strong}>{t.exportFirst}</span>
          <span className={rows.muted}>{t.exportFirstHint}</span>
        </span>
        <span className={rows.actions}>
          <Link href={`${paths.settings()}#your-data`} className="btn btn--sm">
            {t.download}
          </Link>
        </span>
      </div>

      <form className={rows.group} onSubmit={(event) => void handleSubmit(event)} aria-labelledby="delete-account-confirm">
        <h2 id="delete-account-confirm" className={`${rows.groupLabel} ${rows.dangerLabel}`}>
          {t.confirmHeading}
        </h2>
        <div className={rows.card}>
          <div className={`${rows.row} ${rows.rowStack}`}>
            <label className={rows.rowLabel} htmlFor="delete-account-username">
              {t.usernameLabel}
            </label>
            <div className={rows.fields}>
              <input
                id="delete-account-username"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                disabled={working}
                required
                placeholder={username}
                aria-label={t.confirmLabel(username)}
                aria-describedby="delete-account-username-hint"
              />
              <p id="delete-account-username-hint" className={matches ? rows.success : rows.muted}>
                {t.typeHint(username)}
              </p>
            </div>
          </div>
          <div className={`${rows.row} ${rows.rowStack}`}>
            <label className={rows.rowLabel} htmlFor="delete-account-password">
              {t.passwordShort}
            </label>
            <div className={rows.fields}>
              {/* Tells a password manager which account the password belongs to. */}
              <input type="email" autoComplete="username" value={auth.user?.email ?? ""} readOnly hidden />
              <input
                id="delete-account-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={working}
                required
                aria-describedby="delete-account-password-hint"
              />
              <p id="delete-account-password-hint" className={rows.muted}>
                {t.passwordHint}
              </p>
            </div>
          </div>
          {auth.captchaEnabled ? (
            <div className={`${rows.row} ${rows.rowStack}`}>
              <span className={rows.rowLabel}>{t.checkLabel}</span>
              <div className={rows.fields}>
                <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} />
              </div>
            </div>
          ) : null}
        </div>

        {phase.kind === "working" ? (
          <RailLoader
            size="small"
            showLabel
            label={phase.step && phase.step in t.step ? t.step[phase.step as keyof typeof t.step] : t.deleting}
          />
        ) : null}
        {phase.kind === "error" ? (
          <p className={rows.error} role="alert">
            {phase.message}
          </p>
        ) : null}

        <div className={`${rows.buttons} ${styles.end}`}>
          <Link href={paths.settings()} className="btn btn--ghost">
            {t.cancel}
          </Link>
          <button
            type="submit"
            className={`btn ${rows.dangerSolid}`}
            disabled={working || !matches || password.length === 0 || (auth.captchaEnabled && !captchaToken)}
          >
            {t.submit}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The signed-out Settings page, right after a deletion. Exported for the tests. */
export function AccountDeletedNotice({ t }: { t: Dict["yourData"]["delete"] }) {
  return (
    <section className={rows.tile} role="status">
      <span className={rows.avatar} aria-hidden="true">
        <Icon name="check" />
      </span>
      <span className={rows.value}>
        <h1 className={`${rows.strong} ${rows.big}`}>{t.deletedHeading}</h1>
        <span className={rows.muted}>{t.deletedBody}</span>
      </span>
      <span className={rows.actions}>
        <Link href={paths.home()} className="btn btn--sm">
          {t.home}
        </Link>
      </span>
    </section>
  );
}

"use client";

import Link from "next/link";
import { LanguageSwitch } from "../../components/shell/LanguageSwitch";
import { useState, type FormEvent } from "react";
import { Turnstile } from "../../components/auth/Turnstile";
import { AppFrame } from "../../components/shell/AppFrame";
import { useAuth } from "../../lib/auth";
import { setUsername, usernameErrorMessage, type MyProfile } from "../../lib/db/profiles";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import styles from "./settings.module.css";

/** Client half of `/settings`. */
export function SettingsScreen() {
  return <AppFrame tab={null}>{() => <SettingsBody />}</AppFrame>;
}

function LanguageSection() {
  const en = useDict();
  return (
    <section className={`card ${styles.section}`} aria-labelledby="settings-language">
      <h2 id="settings-language" className={styles.subheading}>
        {en.language.label}
      </h2>
      <LanguageSwitch variant="full" />
      <p className="muted">{en.language.hint}</p>
    </section>
  );
}

function SettingsBody() {
  const en = useDict();
  const auth = useAuth();
  const { status, profile, refresh } = useMyProfile();

  if (!auth.isSignedIn) {
    return (
      <section className={`card ${styles.section}`}>
        <h1 className={styles.heading}>{en.settings.heading}</h1>
        <p className="muted">{en.settings.signedOut}</p>
        <div>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {en.settings.signInCta}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="stack">
      <h1 className={styles.heading}>{en.settings.heading}</h1>
      <LanguageSection />
      {status === "ready" && profile ? (
        <>
          <UsernameSection profile={profile} onSaved={refresh} />
          <PostingSection profile={profile} />
        </>
      ) : (
        <p className={status === "loading" ? "muted" : "notice notice--warn"}>
          {status === "loading"
            ? en.settings.loading
            : status === "unavailable"
              ? en.settings.unavailable
              : en.settings.loadFailed}
        </p>
      )}
    </div>
  );
}

/** `2026-10-29T08:02:17Z` -> `29 October 2026`, the way the server words it. */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * The shape rules, checked before the round trip so "too short" does not need
 * one. Reservations, blocked terms and "taken" are the server's to answer.
 */
function localProblem(en: Dict, name: string): string | null {
  if (name.length < 3) return en.settings.username.tooShort;
  if (name.length > 24) return en.settings.username.tooLong;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return en.settings.username.badCharacters;
  if (!/^[A-Za-z0-9]/.test(name)) return en.settings.username.badStart;
  return null;
}

function UsernameSection({ profile, onSaved }: { profile: MyProfile; onSaved: () => Promise<void> }) {
  const en = useDict();
  const [value, setValue] = useState(profile.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const trimmed = value.trim();
  const locked =
    profile.nextUsernameChangeAt !== null && new Date(profile.nextUsernameChangeAt).getTime() > Date.now();
  // A capitalisation-only change is allowed inside the 30 days: the address
  // does not move. Everything else waits.
  const caseOnly = trimmed.toLowerCase() === profile.username.toLowerCase();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (trimmed === profile.username) {
      setNotice(en.settings.username.unchanged);
      return;
    }
    const problem = localProblem(en, trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const result = await setUsername(trimmed);
      await onSaved();
      setValue(result.username);
      setNotice(en.settings.username.saved(result.username));
    } catch (err) {
      setError(usernameErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card ${styles.section}`} aria-labelledby="settings-username">
      <h2 id="settings-username" className={styles.subheading}>
        {en.settings.username.heading}
      </h2>

      {profile.provisional ? (
        <p className="notice notice--info">{en.settings.username.provisional}</p>
      ) : null}

      <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
        <label className={styles.field}>
          <span>{en.settings.username.label}</span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={24}
            required
            aria-describedby="settings-username-hint"
          />
        </label>
        <p id="settings-username-hint" className={`muted ${styles.hint}`}>
          {en.settings.username.hint}
        </p>
        <p className={`muted ${styles.hint}`}>
          {en.settings.username.rules}
          {locked && profile.nextUsernameChangeAt
            ? ` ${en.settings.username.nextChange(formatDay(profile.nextUsernameChangeAt))}`
            : null}
        </p>

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

        <div className={styles.actions}>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || (locked && !caseOnly)}
          >
            {busy ? en.settings.username.saving : en.settings.username.save}
          </button>
          <Link href={paths.profile(profile.username)} className="btn btn--ghost">
            {en.settings.username.viewProfile}
          </Link>
        </div>
      </form>
    </section>
  );
}

function PostingSection({ profile }: { profile: MyProfile }) {
  const en = useDict();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const email = auth.user?.email ?? null;
  // The only block the account can do something about from here.
  const canResend = Boolean(email) && auth.user?.emailConfirmed === false;

  async function resend() {
    if (!email) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await auth.resendConfirmation(email, captchaToken ?? undefined);
      setNotice(en.settings.posting.resent(email));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (auth.captchaEnabled) {
        setCaptchaReset((value) => value + 1);
      }
    }
  }

  return (
    <section className={`card ${styles.section}`} aria-labelledby="settings-posting">
      <h2 id="settings-posting" className={styles.subheading}>
        {en.settings.posting.heading}
      </h2>
      {profile.postingBlockReason ? (
        <>
          <p>{en.settings.posting.blocked}</p>
          {/* Verbatim from the server: the same sentence a post attempt would
              raise, so the two can never disagree. */}
          <p className="notice notice--warn">{profile.postingBlockReason}</p>
        </>
      ) : (
        <p>{en.settings.posting.ok}</p>
      )}

      {canResend ? (
        <div className={styles.form}>
          {auth.captchaEnabled ? (
            <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} />
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
          <div>
            <button
              type="button"
              className="btn"
              disabled={busy || (auth.captchaEnabled && !captchaToken)}
              onClick={() => void resend()}
            >
              {busy ? en.settings.posting.resending : en.settings.posting.resend}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

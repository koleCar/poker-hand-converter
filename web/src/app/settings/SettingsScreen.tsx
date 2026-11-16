"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { Turnstile } from "../../components/auth/Turnstile";
import { AppFrame } from "../../components/shell/AppFrame";
import { BusyLabel } from "../../components/shell/BusyLabel";
import { LanguageSwitch } from "../../components/shell/LanguageSwitch";
import { PlanPanel } from "../../components/plan/PlanPanel";
import { YourDataPanel } from "../../components/account/YourDataPanel";
import { ACCOUNT_DELETED_FLAG, AccountDeletedNotice } from "../../components/account/DeleteAccountPanel";
import rows from "../../components/account/rows.module.css";
import { useAuth } from "../../lib/auth";
import { setUsername, usernameErrorMessage, type MyProfile } from "../../lib/db/profiles";
import { useDict, useLocale } from "../../lib/i18n/client";
import { localizeServerMessage } from "../../lib/i18n/serverErrors";
import type { Dict } from "../../lib/i18n/types";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";

/**
 * Client half of `/settings`: Profile settings, laid out like the desktop
 * app's Settings - no title, a small label over each card of rows (the label,
 * the value, the action). Account (the name, the email, posting, the
 * password), Plan, Language, Your data, and the danger zone, which only links
 * to `/settings/delete-account`.
 *
 * The username is chosen once (`20271116130500_username_set_once.sql`): it is
 * what other people see instead of the email, so it is an identity, not a
 * nickname.
 */
export function SettingsScreen() {
  return <AppFrame tab={null}>{() => <SettingsBody />}</AppFrame>;
}

function SettingsBody() {
  const en = useDict();
  const auth = useAuth();
  const router = useRouter();
  const { profile } = useMyProfile();
  const g = en.settings.sections;

  // Signed in (again): a deletion notice from earlier in this tab is over.
  useEffect(() => {
    if (!auth.isSignedIn) return;
    try {
      window.sessionStorage.removeItem(ACCOUNT_DELETED_FLAG);
    } catch {
      // Storage off: nothing to clear.
    }
  }, [auth.isSignedIn]);

  // The deletion used to live at `/settings#delete-account` (older desktop
  // apps still open that): it has its own page now.
  useEffect(() => {
    if (window.location.hash === "#delete-account") {
      router.replace(paths.deleteAccount());
    }
  }, [router]);

  if (!auth.isSignedIn) {
    return <SignedOut />;
  }

  return (
    <div className={rows.page}>
      <h1 className={rows.visuallyHidden}>{en.settings.heading}</h1>
      <AccountGroup />
      <PlanPanel />
      <section className={rows.group} aria-labelledby="settings-language">
        <h2 id="settings-language" className={rows.groupLabel}>
          {g.language}
        </h2>
        <div className={rows.card}>
          <div className={rows.row}>
            <span className={rows.rowLabel}>{en.language.label}</span>
            <span className={rows.muted}>{en.language.hint}</span>
            <span className={rows.actions}>
              <LanguageSwitch variant="full" classNames={{ group: rows.segmented, option: rows.segment }} />
            </span>
          </div>
        </div>
      </section>
      <YourDataPanel username={profile?.username ?? null} />
      <section className={rows.group} aria-labelledby="settings-danger">
        <h2 id="settings-danger" className={`${rows.groupLabel} ${rows.dangerLabel}`}>
          {g.danger}
        </h2>
        <div className={rows.tile}>
          <span className={rows.dangerIcon} aria-hidden="true">
            <Icon name="trash" />
          </span>
          <span className={rows.value}>
            <span className={rows.strong}>{en.settings.danger.title}</span>
            <span className={rows.muted}>{en.settings.danger.hint}</span>
          </span>
          <span className={rows.actions}>
            <Link href={paths.deleteAccount()} className={`btn btn--sm ${rows.dangerButton}`}>
              {en.settings.danger.open}
            </Link>
          </span>
        </div>
      </section>
    </div>
  );
}

const noSubscription = () => () => undefined;

function readDeletedFlag(): boolean {
  try {
    return window.sessionStorage.getItem(ACCOUNT_DELETED_FLAG) === "1";
  } catch {
    return false; // Storage off: the plain signed-out page.
  }
}

/** Signed out: the state and one action - or, right after a deletion, that it is done. */
function SignedOut() {
  const en = useDict();
  const auth = useAuth();
  // The tab's own storage: false on the server render, the flag after hydration.
  const deleted = useSyncExternalStore(noSubscription, readDeletedFlag, () => false);
  if (deleted) {
    return (
      <div className={rows.page}>
        <AccountDeletedNotice t={en.yourData.delete} />
      </div>
    );
  }
  return (
    <div className={rows.page}>
      <div className={rows.tile}>
        <span className={`${rows.avatar} ${rows.avatarEmpty}`} aria-hidden="true" />
        <span className={rows.value}>
          <h1 className={`${rows.strong} ${rows.text}`}>{en.settings.signedOut}</h1>
          <span className={rows.muted}>{en.settings.signedOutHint}</span>
        </span>
        <span className={rows.actions}>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => auth.requestSignIn()}>
            {en.settings.signInCta}
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The shape rules, checked before the round trip so "too short" does not need
 * one. Reservations, blocked terms and "taken" are the server's to answer.
 */
function usernameProblem(en: Dict, name: string): string | null {
  if (name.length < 3) return en.settings.username.tooShort;
  if (name.length > 24) return en.settings.username.tooLong;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return en.settings.username.badCharacters;
  if (!/^[A-Za-z0-9]/.test(name)) return en.settings.username.badStart;
  return null;
}

/** The account: who you are (tile), then the name, the email, posting and the password. */
function AccountGroup() {
  const en = useDict();
  const auth = useAuth();
  const { status, profile, refresh } = useMyProfile();
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const email = auth.user?.email ?? "";
  const chosen = profile && !profile.provisional ? profile.username : null;
  const shown = chosen ?? (email || "?");

  return (
    <section className={rows.group} aria-labelledby="settings-account">
      <h2 id="settings-account" className={rows.groupLabel}>
        {en.settings.sections.account}
      </h2>
      <div className={rows.tile}>
        {auth.user?.avatarUrl ? (
          <img className={rows.avatar} src={auth.user.avatarUrl} alt="" width={40} height={40} />
        ) : (
          <span className={rows.avatar} aria-hidden="true">
            {shown.charAt(0)}
          </span>
        )}
        <span className={rows.value}>
          <span className={`${rows.strong} ${rows.big}`}>{chosen ?? email}</span>
          {chosen && email ? <span className={rows.muted}>{email}</span> : null}
        </span>
        <span className={rows.actions}>
          {chosen ? (
            <Link href={paths.profile(chosen)} className="btn btn--sm">
              {en.settings.publicProfile}
            </Link>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              try {
                await auth.signOut();
              } finally {
                setSigningOut(false);
              }
            }}
          >
            <BusyLabel busy={signingOut} busyLabel={en.settings.signingOut}>
              {en.settings.signOut}
            </BusyLabel>
          </button>
        </span>
      </div>

      <div className={rows.card}>
        {status === "ready" && profile ? (
          <UsernameRow
            profile={profile}
            onSaved={async (name) => {
              await refresh();
              setNotice(en.settings.username.saved(name));
            }}
          />
        ) : status === "loading" ? (
          <div className={`${rows.row} ${rows.rowWide}`}>
            <RailLoader size="inline" label={en.settings.loading} showLabel />
          </div>
        ) : (
          <div className={`${rows.row} ${rows.rowWide}`}>
            <span className={rows.value}>
              <span className={rows.error}>
                {status === "unavailable" ? en.settings.unavailable : en.settings.loadFailed}
              </span>
              {status === "unavailable" ? null : <span className={rows.muted}>{en.settings.loadFailedHint}</span>}
            </span>
            {status === "unavailable" ? null : (
              <span className={rows.actions}>
                <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
                  {en.settings.retry}
                </button>
              </span>
            )}
          </div>
        )}
        <EmailRow />
        {status === "ready" && profile ? <PostingRow profile={profile} /> : null}
        <PasswordRow />
      </div>
      {notice ? (
        <p className={`${rows.note} ${rows.success}`} role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The username. Chosen: shown, locked. Not chosen yet (the signup's
 * `user_xxxxxxxx`): "Choose your name", which opens the field in the row.
 */
function UsernameRow({ profile, onSaved }: { profile: MyProfile; onSaved: (name: string) => Promise<void> }) {
  const en = useDict();
  const locale = useLocale();
  const u = en.settings.username;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const problem = trimmed ? usernameProblem(en, trimmed) : null;

  if (!profile.provisional) {
    return (
      <div className={rows.row}>
        <span className={rows.rowLabel}>{u.label}</span>
        <span className={rows.value}>
          <span className={rows.strong}>{profile.username}</span>
          <span className={rows.muted}>{u.locked}</span>
        </span>
        <span className={`${rows.actions} ${rows.muted}`} aria-hidden="true">
          <Icon name="lock" />
        </span>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className={rows.row}>
        <span className={rows.rowLabel}>{u.label}</span>
        <span className={rows.value}>
          <span className={`${rows.badge} ${rows.yellow}`}>{u.provisional}</span>
          <span className={rows.muted}>{u.chooseLong}</span>
        </span>
        <span className={rows.actions}>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing(true)}>
            {u.choose}
          </button>
        </span>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const local = usernameProblem(en, trimmed);
    if (local) {
      setError(local);
      return;
    }
    setBusy(true);
    try {
      const result = await setUsername(trimmed);
      await onSaved(result.username);
    } catch (err) {
      setError(localizeServerMessage(usernameErrorMessage(err), locale));
      setBusy(false);
    }
  }

  const message = error ?? problem;
  return (
    <form className={`${rows.row} ${rows.rowStack}`} onSubmit={(event) => void handleSubmit(event)}>
      <label className={rows.rowLabel} htmlFor="settings-username">
        {u.label}
      </label>
      <div className={rows.fields}>
        <input
          id="settings-username"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          required
          autoFocus
          aria-describedby="settings-username-hint"
          aria-invalid={Boolean(message)}
        />
        <p
          id="settings-username-hint"
          className={message ? rows.error : rows.muted}
          role={error ? "alert" : undefined}
        >
          {message ?? (trimmed ? u.confirm(trimmed) : u.hint)}
        </p>
        <p className={rows.muted}>{u.chooseLong}</p>
        <div className={rows.buttons}>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !trimmed || Boolean(problem)}>
            <BusyLabel busy={busy} busyLabel={u.saving}>
              {u.save}
            </BusyLabel>
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setValue("");
              setError(null);
            }}
          >
            {en.settings.cancel}
          </button>
        </div>
      </div>
    </form>
  );
}

/** The email: only its owner sees it. Unconfirmed, a resend. */
function EmailRow() {
  const en = useDict();
  const auth = useAuth();
  const e = en.settings.email;
  const p = en.settings.posting;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const email = auth.user?.email ?? null;
  if (!email) return null;
  const unconfirmed = auth.user?.emailConfirmed === false;

  async function resend() {
    if (!email) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await auth.resendConfirmation(email, captchaToken ?? undefined);
      setNotice(p.resent(email));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (auth.captchaEnabled) setCaptchaReset((value) => value + 1);
    }
  }

  return (
    <div className={rows.row}>
      <span className={rows.rowLabel}>{e.label}</span>
      <span className={rows.value}>
        <span className={rows.inline}>
          <span className={rows.text}>{email}</span>
          <span className={`${rows.badge} ${unconfirmed ? rows.yellow : rows.green}`}>
            {unconfirmed ? e.unconfirmed : e.confirmed}
          </span>
        </span>
        <span className={rows.muted}>{e.private}</span>
        {unconfirmed && auth.captchaEnabled ? <Turnstile onToken={setCaptchaToken} resetSignal={captchaReset} /> : null}
        {error ? (
          <span className={rows.error} role="alert">
            {error}
          </span>
        ) : null}
        {notice ? (
          <span className={rows.success} role="status">
            {notice}
          </span>
        ) : null}
      </span>
      <span className={rows.actions}>
        {unconfirmed ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || (auth.captchaEnabled && !captchaToken)}
            onClick={() => void resend()}
          >
            <BusyLabel busy={busy} busyLabel={p.resending}>
              {p.resend}
            </BusyLabel>
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Whether the account may post; the server's own sentence when not. */
function PostingRow({ profile }: { profile: MyProfile }) {
  const p = useDict().settings.posting;
  const blocked = profile.postingBlockReason;
  return (
    <div className={rows.row}>
      <span className={rows.rowLabel}>{p.label}</span>
      <span className={rows.value}>
        <span className={`${rows.badge} ${blocked ? rows.yellow : rows.green}`}>{blocked ? p.blocked : p.ok}</span>
        {/* Verbatim from the server: the sentence a post attempt would raise. */}
        {blocked ? <span className={rows.muted}>{blocked}</span> : null}
      </span>
      <span />
    </div>
  );
}

/** GoTrue's `password_min_length` on this project; it re-checks on save. */
const MIN_PASSWORD_LENGTH = 6;

function PasswordRow() {
  const en = useDict();
  const auth = useAuth();
  const locale = useLocale();
  const w = en.settings.password;
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className={rows.row}>
        <span className={rows.rowLabel}>{w.label}</span>
        <span className={rows.value}>
          <span className={rows.secret} aria-hidden="true">
            ••••••••
          </span>
          {notice ? (
            <span className={rows.success} role="status">
              {notice}
            </span>
          ) : null}
        </span>
        <span className={rows.actions}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            {en.settings.change}
          </button>
        </span>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(w.tooShort);
      return;
    }
    if (password !== confirm) {
      setError(w.mismatch);
      return;
    }
    setBusy(true);
    try {
      await auth.updatePassword(password);
      setPassword("");
      setConfirm("");
      setEditing(false);
      setNotice(w.saved);
    } catch (err) {
      setError(err instanceof Error ? localizeServerMessage(err.message, locale) : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`${rows.row} ${rows.rowStack}`} onSubmit={(event) => void handleSubmit(event)}>
      <span className={rows.rowLabel}>{w.label}</span>
      <div className={rows.fields}>
        {/* Tells a password manager which account the new password belongs to. */}
        <input type="email" autoComplete="username" value={auth.user?.email ?? ""} readOnly hidden />
        <label className={rows.fieldLabel} htmlFor="settings-password-new">
          {w.newLabel}
        </label>
        <input
          id="settings-password-new"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          autoFocus
          aria-describedby="settings-password-hint"
        />
        <label className={rows.fieldLabel} htmlFor="settings-password-confirm">
          {w.confirmLabel}
        </label>
        <input
          id="settings-password-confirm"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        <p id="settings-password-hint" className={rows.muted}>
          {w.hint}
        </p>
        {error ? (
          <p className={rows.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={rows.buttons}>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
            <BusyLabel busy={busy} busyLabel={w.saving}>
              {w.save}
            </BusyLabel>
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setPassword("");
              setConfirm("");
              setError(null);
            }}
          >
            {en.settings.cancel}
          </button>
        </div>
      </div>
    </form>
  );
}

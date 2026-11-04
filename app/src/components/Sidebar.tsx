import { useT } from "../i18n";
import { offeredScreens } from "../lib/duringPlay";
import { SCREENS, screenHref, type Screen } from "../lib/router";
import { useAccount } from "../lib/useAccount";
import { useUpdates } from "../lib/useUpdates";
import { MOD_KEY, openPalette } from "./Palette";
import styles from "./Sidebar.module.css";

/** The screens; (A10, R3.10) while a poker table is open, without those that
 * help with play. At the foot, a newer Rail when there is one, and who is
 * signed in (R1.7). */
export function Sidebar({ current, tablesOpen }: { current: Screen; tablesOpen: boolean }) {
  const t = useT();
  return (
    <nav className={styles.sidebar} aria-label={t.nav.label}>
      <div className={styles.brand}>{t.brand.name}</div>
      {/* The command palette for the mouse (R2.8); Cmd/Ctrl + K from anywhere. */}
      <button
        type="button"
        className={styles.search}
        onClick={openPalette}
        aria-label={t.nav.searchLabel}
        title={t.nav.searchLabel}
        aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+K" : "Control+K"}
      >
        <span>{t.nav.search}</span>
        <kbd className={styles.kbd} aria-hidden="true">{`${MOD_KEY}${MOD_KEY === "⌘" ? "" : "+"}K`}</kbd>
      </button>
      <ul className={styles.list}>
        {offeredScreens(SCREENS, tablesOpen).map((screen) => (
          <li key={screen}>
            <a
              className={screen === current ? `${styles.link} ${styles.active}` : styles.link}
              href={screenHref(screen)}
              aria-current={screen === current ? "page" : undefined}
            >
              {t.nav[screen]}
            </a>
          </li>
        ))}
      </ul>
      <UpdateFoot />
      <AccountFoot />
    </nav>
  );
}

/** A newer Rail found (or downloaded): a quiet link to Settings, Updates. */
function UpdateFoot() {
  const t = useT();
  const { status } = useUpdates();
  const phase = status?.phase;
  if (!phase || (phase.state !== "available" && phase.state !== "ready")) {
    return null;
  }
  // "Install" only where this copy can install it (Settings says why not).
  const installable = phase.state === "ready" && status?.installBlocker === null;
  const text = installable ? t.nav.updateReady(phase.version) : t.nav.updateAvailable(phase.version);
  return (
    <a
      className={styles.update}
      href={screenHref("settings", "updates")}
      title={phase.state === "ready" ? t.settings.updates.ready(phase.version) : t.settings.updates.available(phase.version)}
    >
      <span className={styles.updateDot} aria-hidden="true" />
      <span className={styles.email}>{text}</span>
    </a>
  );
}

/** A profile icon with the signed-in email (or a sign-in prompt), a click
 * away from the account in Settings; nothing when this build has no account
 * service. */
function AccountFoot() {
  const t = useT();
  const { account } = useAccount();
  if (!account || account.state === "notConfigured") {
    return null;
  }
  const signedIn = account.state === "signedIn";
  const text = signedIn ? account.email : account.state === "signingIn" ? t.nav.signingIn : t.nav.signIn;
  const title = signedIn
    ? account.online
      ? t.account.signedInAs(account.email)
      : `${t.account.signedInAs(account.email)} · ${t.nav.offline}`
    : account.state === "signingIn"
      ? t.account.signingInShort
      : t.account.notSignedIn;
  return (
    <a className={styles.account} href={screenHref("settings")} title={title} aria-label={`${t.nav.account}: ${title}`}>
      <span className={signedIn ? `${styles.avatar} ${styles.avatarOn}` : styles.avatar} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
        {signedIn && !account.online && <span className={styles.offline} />}
      </span>
      <span className={styles.email}>{text}</span>
    </a>
  );
}

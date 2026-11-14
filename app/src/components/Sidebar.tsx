import { useEffect, useState } from "react";
import { RailMark } from "@rail/ui/brand/RailMark";
import { Icon, type IconName } from "@rail/ui/icon/Icon";
import { useT } from "../i18n";
import { offeredScreens } from "../lib/duringPlay";
import { SCREENS, screenHref, type Screen } from "../lib/router";
import { useAccount } from "../lib/useAccount";
import { MOD_KEY, openPalette } from "./Palette";
import styles from "./Sidebar.module.css";
import { SidebarUpdate } from "./SidebarUpdate";

/** One icon per screen: all a collapsed sidebar shows of it. */
const SCREEN_ICONS: Record<Screen, IconName> = {
  live: "home",
  hands: "cards",
  reports: "barChart",
  players: "users",
  analysis: "trend",
  solver: "grid",
  trainer: "star",
  hud: "gauge",
  tables: "tiles",
  import: "upload",
  settings: "settings",
};

/** The wordmark is the product name, not copy: the same in every language (as on the web). */
const WORDMARK = "rail";

const COLLAPSED_KEY = "rail.sidebarCollapsed";

/** Shown as `⌘B` / `Ctrl+B`. */
const TOGGLE_KEY = "b";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // A webview without storage: the next start opens the sidebar full.
  }
}

/** Collapsed or full, remembered across starts; Cmd/Ctrl + B flips it. */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => setCollapsed((was) => !was);
  useEffect(() => writeCollapsed(collapsed), [collapsed]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== TOGGLE_KEY) return;
      event.preventDefault();
      setCollapsed((was) => !was);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [collapsed, toggle];
}

const shortcut = (key: string) => `${MOD_KEY}${MOD_KEY === "⌘" ? "" : "+"}${key.toUpperCase()}`;

/** The screens; (A10, R3.10) while a poker table is open, without those that
 * help with play. At the foot, a newer Rail whenever there is one, with its
 * download and install, and who is signed in (R1.7). Collapsed, it keeps only the icons: every label is still
 * there, clipped, so a screen reader names each link the same in both states,
 * and the pointer gets a tooltip. */
export function Sidebar({ current, tablesOpen }: { current: Screen; tablesOpen: boolean }) {
  const t = useT();
  const [collapsed, toggle] = useCollapsed();
  const toggleLabel = `${collapsed ? t.nav.expand : t.nav.collapse} (${shortcut(TOGGLE_KEY)})`;
  return (
    <nav className={collapsed ? `${styles.sidebar} ${styles.collapsed}` : styles.sidebar} aria-label={t.nav.label}>
      <div className={styles.head}>
        {/* The lockup, as on the web: the mark, and the wordmark whose `i` carries the accent dot. */}
        <div className={styles.brand} role="img" aria-label={t.brand.name} title={collapsed ? t.brand.name : undefined}>
          <span className={styles.markBox}>
            <RailMark size={28} className={styles.mark} />
          </span>
          <span className={styles.wordmark} aria-hidden="true">
            {WORDMARK.slice(0, 2)}
            <span className={styles.wordmarkI}>{WORDMARK[2]}</span>
            {WORDMARK.slice(3)}
          </span>
        </div>
        <button
          type="button"
          className={styles.toggle}
          onClick={toggle}
          aria-label={collapsed ? t.nav.expand : t.nav.collapse}
          aria-expanded={!collapsed}
          aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+B" : "Control+B"}
          title={toggleLabel}
        >
          <Icon name="sidebar" className={styles.icon} />
        </button>
      </div>
      {/* The command palette for the mouse (R2.8); Cmd/Ctrl + K from anywhere. */}
      <button
        type="button"
        className={styles.search}
        onClick={openPalette}
        aria-label={t.nav.searchLabel}
        title={t.nav.searchLabel}
        aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+K" : "Control+K"}
      >
        <Icon name="search" className={styles.icon} />
        <span className={styles.label}>{t.nav.search}</span>
        <kbd className={styles.kbd} aria-hidden="true">
          {shortcut("k")}
        </kbd>
      </button>
      <ul className={styles.list}>
        {offeredScreens(SCREENS, tablesOpen).map((screen) => (
          <li key={screen}>
            <a
              className={screen === current ? `${styles.link} ${styles.active}` : styles.link}
              href={screenHref(screen)}
              aria-current={screen === current ? "page" : undefined}
              title={collapsed ? t.nav[screen] : undefined}
            >
              <Icon name={SCREEN_ICONS[screen]} className={styles.icon} />
              <span className={styles.label}>{t.nav[screen]}</span>
            </a>
          </li>
        ))}
      </ul>
      <SidebarUpdate collapsed={collapsed} tablesOpen={tablesOpen} />
      <AccountFoot />
    </nav>
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

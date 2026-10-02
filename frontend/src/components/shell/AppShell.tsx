"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { paths } from "../../lib/routes";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { AuthDialog } from "../auth/AuthDialog";
import { UserMenu } from "../auth/UserMenu";
import { NotificationsBell } from "../forum/NotificationsBell";
import { BrandMark } from "./BrandMark";
import { DbStatusChip } from "./DbStatusChip";
import { LanguageSwitch } from "./LanguageSwitch";

/**
 * The bar, the tabs and the dialog — everything a signed-in screen has above
 * the content.
 *
 * The tab ids are the route names now (`convert`, `library`, `stats`) rather
 * than the old `converter` / `replayer`, so there is one vocabulary for "which
 * screen is this" instead of two that have to be mapped onto each other. The
 * navigation itself is `next/link`: the hand-rolled `<Link>`/`navigate()` pair
 * that used to live in `routes/router.tsx` is gone, and with it the click
 * handler that re-implemented modifier-key and middle-click semantics.
 */
export type ShellTab = "forum" | "convert" | "library" | "stats" | "analysis";

const TABS: Array<{ id: ShellTab; label: (en: Dict) => string; path: string }> = [
  { id: "forum", label: (en) => en.nav.forum, path: paths.home() },
  { id: "convert", label: (en) => en.nav.convert, path: paths.convert() },
  { id: "library", label: (en) => en.nav.library, path: paths.library() },
  { id: "stats", label: (en) => en.nav.stats, path: paths.stats() },
  { id: "analysis", label: (en) => en.nav.analysis, path: paths.analysis() },
];

interface AppShellProps {
  /** Null on routes with no tab (e.g. 404). */
  tab: ShellTab | null;
  /**
   * Whether the hand-history and statistics tabs are offered at all.
   *
   * False for a visitor with nothing in them — signed out, or signed in with an
   * empty library. A tab that can only lead to "you have no hands" is an
   * invitation to a dead end, so it stays out of the bar until there is
   * something behind it, and the bar collapses to the one thing the app does
   * for a first-time visitor. Statistics sit behind the same gate for the same
   * reason, and a stronger one: a HUD over zero hands is not an empty screen,
   * it is a screen of dashes that looks broken. Analysis is the same case as
   * statistics.
   */
  showHistoryTab: boolean;
  dbConfigured: boolean;
  storedCount: number | null;
  children: ReactNode;
}

export function AppShell({
  tab,
  showHistoryTab,
  dbConfigured,
  storedCount,
  children,
}: AppShellProps) {
  const en = useDict();
  // The forum and the converter are for everyone; the library and statistics
  // wait until there is something in them.
  const tabs = TABS.filter((entry) => entry.id === "forum" || entry.id === "convert" || showHistoryTab);
  const navRef = useRef<HTMLElement | null>(null);

  // On a phone the tab strip scrolls sideways (five tabs do not fit 375px);
  // keep the current screen's tab in view rather than leaving it off the edge.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>(".shell__tab.is-active");
    if (active && nav && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    }
  }, [tab, tabs.length]);

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className={`shell__bar-inner ${tabs.length > 1 ? "" : "shell__bar-inner--no-tabs"}`}>
          <BrandMark />

          {/* One tab is not a choice — rendering it would be a permanently
              selected label next to the logo. */}
          {tabs.length > 1 ? (
            <nav ref={navRef} className="shell__tabs" role="tablist" aria-label={en.nav.sections}>
              {tabs.map((entry) => (
                <Link
                  key={entry.id}
                  role="tab"
                  href={entry.path}
                  aria-selected={tab === entry.id}
                  className={`shell__tab ${tab === entry.id ? "is-active" : ""}`}
                >
                  <span className="shell__tab-label">{entry.label(en)}</span>
                </Link>
              ))}
            </nav>
          ) : null}

          <div className="shell__bar-end">
            <DbStatusChip configured={dbConfigured} storedCount={storedCount} />
            <NotificationsBell />
            <LanguageSwitch />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Rendered by the shell, not by each screen, so `requestSignIn()` works
          from anywhere in the tree. The shared-hand page has no shell and
          therefore never shows it — a stranger following a link is not
          someone to put a sign-up form in front of. */}
      <AuthDialog />

      {!dbConfigured ? <p className="shell__offline-banner">{en.shell.offlineBanner}</p> : null}

      <main className="shell__main">{children}</main>
    </div>
  );
}

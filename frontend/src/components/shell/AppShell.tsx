"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { paths } from "../../lib/routes";
import { en } from "../../lib/i18n/en";
import { AuthDialog } from "../auth/AuthDialog";
import { UserMenu } from "../auth/UserMenu";
import { BrandMark } from "./BrandMark";
import { DbStatusChip } from "./DbStatusChip";

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
export type ShellTab = "convert" | "library" | "stats";

const TABS: Array<{ id: ShellTab; label: string; path: string }> = [
  { id: "convert", label: en.nav.convert, path: paths.convert() },
  { id: "library", label: en.nav.library, path: paths.library() },
  { id: "stats", label: en.nav.stats, path: paths.stats() },
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
   * it is a screen of dashes that looks broken.
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
  const tabs = TABS.filter((entry) => entry.id === "convert" || showHistoryTab);

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className={`shell__bar-inner ${tabs.length > 1 ? "" : "shell__bar-inner--no-tabs"}`}>
          <BrandMark />

          {/* One tab is not a choice — rendering it would be a permanently
              selected label next to the logo. */}
          {tabs.length > 1 ? (
            <nav className="shell__tabs" role="tablist" aria-label={en.nav.sections}>
              {tabs.map((entry) => (
                <Link
                  key={entry.id}
                  role="tab"
                  href={entry.path}
                  aria-selected={tab === entry.id}
                  className={`shell__tab ${tab === entry.id ? "is-active" : ""}`}
                >
                  <span className="shell__tab-label">{entry.label}</span>
                </Link>
              ))}
            </nav>
          ) : null}

          <div className="shell__bar-end">
            <DbStatusChip configured={dbConfigured} storedCount={storedCount} />
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

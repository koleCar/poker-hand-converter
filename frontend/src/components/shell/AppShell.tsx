import type { ReactNode } from "react";
import { navigate } from "../../routes/navigation";
import { paths, toHref } from "../../routes/routes";
import { AuthDialog } from "../auth/AuthDialog";
import { UserMenu } from "../auth/UserMenu";
import { BrandMark } from "./BrandMark";
import { DbStatusChip } from "./DbStatusChip";

export type ShellTab = "converter" | "replayer";

const TABS: Array<{ id: ShellTab; label: string; path: string }> = [
  { id: "converter", label: "Upload hand", path: paths.converter() },
  { id: "replayer", label: "Hand history", path: paths.replayer() },
];

interface AppShellProps {
  /** Null on routes with no tab (e.g. 404). */
  tab: ShellTab | null;
  /**
   * Whether the hand-history tab is offered at all.
   *
   * False for a visitor with nothing in it — signed out, or signed in with an
   * empty library. A tab that can only lead to "you have no hands" is an
   * invitation to a dead end, so it stays out of the bar until there is
   * something behind it, and the bar collapses to the one thing the app does
   * for a first-time visitor.
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
  const tabs = TABS.filter((entry) => entry.id !== "replayer" || showHistoryTab);

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className={`shell__bar-inner ${tabs.length > 1 ? "" : "shell__bar-inner--no-tabs"}`}>
          <BrandMark />

          {/* One tab is not a choice — rendering it would be a permanently
              selected label next to the logo. */}
          {tabs.length > 1 ? (
            <nav className="shell__tabs" role="tablist" aria-label="Sections">
              {tabs.map((entry) => (
                <a
                  key={entry.id}
                  role="tab"
                  href={toHref(entry.path)}
                  aria-selected={tab === entry.id}
                  className={`shell__tab ${tab === entry.id ? "is-active" : ""}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    navigate(entry.path);
                  }}
                >
                  <span className="shell__tab-label">{entry.label}</span>
                </a>
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

      {!dbConfigured ? (
        <p className="shell__offline-banner">
          No database configured — the library and sharing are off. Converting still works.
        </p>
      ) : null}

      <main className="shell__main">{children}</main>
    </div>
  );
}

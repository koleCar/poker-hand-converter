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
  { id: "replayer", label: "My hands", path: paths.replayer() },
];

interface AppShellProps {
  /** Null on routes with no tab (e.g. 404). */
  tab: ShellTab | null;
  dbConfigured: boolean;
  storedCount: number | null;
  children: ReactNode;
}

export function AppShell({ tab, dbConfigured, storedCount, children }: AppShellProps) {
  return (
    <div className="shell">
      <header className="shell__bar">
        <div className="shell__bar-inner">
          <BrandMark />

          <nav className="shell__tabs" role="tablist" aria-label="Sections">
            {TABS.map((entry) => (
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

import type { ReactNode } from "react";
import { navigate } from "../../routes/navigation";
import { paths, toHref } from "../../routes/routes";
import { BrandMark } from "./BrandMark";
import { DbStatusChip } from "./DbStatusChip";

export type ShellTab = "converter" | "replayer";

const TABS: Array<{ id: ShellTab; label: string; hint: string; path: string }> = [
  { id: "converter", label: "Converter", hint: "Any poker room", path: paths.converter() },
  { id: "replayer", label: "Replayer", hint: "Library & upload", path: paths.replayer() },
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
                <span className="shell__tab-hint">{entry.hint}</span>
              </a>
            ))}
          </nav>

          <div className="shell__bar-end">
            <DbStatusChip configured={dbConfigured} storedCount={storedCount} />
          </div>
        </div>
      </header>

      {!dbConfigured ? (
        <p className="shell__offline-banner">
          No database is configured, so the hand library and sharing are unavailable. Converting
          and replaying an uploaded hand still work.
        </p>
      ) : null}

      <main className="shell__main">{children}</main>
    </div>
  );
}

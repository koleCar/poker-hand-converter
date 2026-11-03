"use client";

import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { useLinkStatus } from "next/link";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import styles from "./NavProgress.module.css";

/**
 * "Your click landed": a thin line along the bottom of the app bar while a
 * link in the bar is navigating.
 *
 * Every screen is rendered on the server per request (the root layout reads
 * the session cookie), so a tab press waits for a round trip before anything
 * changes. Before this the bar sat still for that wait and the app looked
 * stuck. The `loading.tsx` boundaries (`RouteLoading`) cover most of it once
 * the route's loading state is prefetched; this covers the moment before, and
 * every navigation that was not prefetched.
 *
 * `useLinkStatus` only answers inside a `<Link>`, so each link in the bar
 * holds a `<NavPending />` that reports to the bar through context, and the
 * bar draws one line for all of them. The line is invisible for its first
 * 150ms (a CSS delay, like `RailLoader`'s), so a navigation that is already
 * cached does not flash it.
 *
 * The same reporting works below the bar: a `PendingScope` around a list and
 * its sort / paging links dims the list (`PendingDims`, the shared
 * `.rail-dims`) while one of those links is on its way. That is the case
 * `loading.tsx` cannot cover: a change of query string keeps the screen
 * mounted, so the old list would otherwise sit there unchanged until the new
 * one replaced it.
 */

type Report = (key: string, pending: boolean) => void;

const NavPendingContext = createContext<Report | null>(null);
const ScopePendingContext = createContext(false);

/** State for the bar: whether any of its links is pending, and the reporter to provide. */
export function useNavPendingState(): { pending: boolean; report: Report } {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback<Report>((key, pending) => {
    setKeys((current) => {
      if (current.has(key) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return { pending: keys.size > 0, report };
}

export function NavPendingProvider({ report, children }: { report: Report; children: ReactNode }) {
  return <NavPendingContext.Provider value={report}>{children}</NavPendingContext.Provider>;
}

/**
 * Collects the `NavPending`s of the links inside it (still lighting the bar's
 * line too) so a `PendingDims` / `PendingLoader` inside can react to them.
 */
export function PendingScope({ children }: { children: ReactNode }) {
  const parent = useContext(NavPendingContext);
  const { pending, report } = useNavPendingState();
  const chained = useCallback<Report>(
    (key, value) => {
      report(key, value);
      parent?.(key, value);
    },
    [report, parent],
  );
  return (
    <NavPendingContext.Provider value={chained}>
      <ScopePendingContext.Provider value={pending}>{children}</ScopePendingContext.Provider>
    </NavPendingContext.Provider>
  );
}

/** Content that dims, in place, while a link of its `PendingScope` navigates. */
export function PendingDims({ className, children }: { className?: string; children: ReactNode }) {
  const pending = useContext(ScopePendingContext);
  return (
    <div className={`rail-dims${className ? ` ${className}` : ""}`} aria-busy={pending}>
      {children}
    </div>
  );
}

/** The inline loader beside a scope's links, while one of them navigates. */
export function PendingLoader({ label }: { label: string }) {
  const pending = useContext(ScopePendingContext);
  return pending ? <RailLoader size="inline" label={label} /> : null;
}

/**
 * Put inside a `<Link>` in the bar: lights the bar's line while that link is
 * navigating, and (with `mark`, for a tab, which is `position: relative`)
 * draws a short bar under the pressed tab's label.
 */
export function NavPending({ mark = true }: { mark?: boolean }) {
  const { pending } = useLinkStatus();
  const report = useContext(NavPendingContext);
  const key = useId();

  useEffect(() => {
    report?.(key, pending);
  }, [report, key, pending]);
  // A link that unmounts mid-navigation (the bar re-rendering on arrival)
  // must not leave the line on.
  useEffect(() => () => report?.(key, false), [report, key]);

  return pending && mark ? <span className={styles.pendingMark} aria-hidden="true" /> : null;
}

/** The line itself. Sits at the bottom edge of the (sticky, positioned) bar. */
export function NavProgressLine({ pending }: { pending: boolean }) {
  return pending ? (
    <span className={styles.line} aria-hidden="true">
      <span className={styles.runner} />
    </span>
  ) : null;
}

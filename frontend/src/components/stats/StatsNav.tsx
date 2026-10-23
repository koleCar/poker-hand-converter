/**
 * Statistics' two screens (R4.5c): Reports (`/stats`) and Players
 * (`/players`), the desktop app's two. Players sits under the Statistics tab
 * rather than in the bar: the bar already scrolls on a phone with six tabs,
 * and a seventh pushed Analysis and Learn out of view on a laptop's width.
 */

"use client";

import Link from "next/link";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";

export function StatsNav({ current }: { current: "reports" | "players" }) {
  const nav = useDict().nav;
  const entries = [
    { id: "reports", label: nav.stats, href: paths.stats() },
    { id: "players", label: nav.players, href: paths.players() },
  ] as const;
  return (
    <nav className="stats-nav" aria-label={nav.stats}>
      {entries.map((entry) => (
        <Link
          key={entry.id}
          href={entry.href}
          className={`chip-btn${entry.id === current ? " is-active" : ""}`}
          aria-current={entry.id === current ? "page" : undefined}
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}

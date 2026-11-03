"use client";

import { usePathname } from "next/navigation";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useDict } from "../../lib/i18n/client";
import type { Dict } from "../../lib/i18n/types";
import { AppFrame } from "./AppFrame";
import type { ShellTab } from "./AppShell";
import { BrandMark } from "./BrandMark";

/**
 * What every `loading.tsx` renders: the screen's own frame, with the right tab
 * lit, and the Rail loader where the screen will be.
 *
 * Each page mounts its own shell (`ServerFrame` / `AppFrame`), so a bare
 * loader in a `loading.tsx` would drop the bar for the length of the wait —
 * the tabs vanishing on every tab press is worse than the stall it replaces.
 * So the boundary draws the bar itself.
 *
 * Why the address decides the tab and the word, rather than a prop per file:
 * which boundary shows is up to the router, not the file tree as one reads
 * it. A boundary in folder X catches a wait for X's *child*, and a navigation
 * that was not prefetched waits in a boundary above the one the destination's
 * folder has — `app/loading.tsx` for most of them. A hard-coded "forum" there
 * would light the wrong tab for every such navigation. When a boundary shows,
 * the URL has already moved to the destination, so `usePathname` names it.
 *
 * The frame here never holds for the plan (`feature={null}`) and subscribes to
 * nothing live; the screen's own frame does both when it arrives.
 */

type RouteWord = keyof Dict["loading"]["route"];

interface RouteChrome {
  /** `shell`: the app bar; `share`: the slim share-page bar; `embed`: nothing around it. */
  chrome: "shell" | "share" | "embed";
  tab: ShellTab | null;
  word: RouteWord | null;
  wide?: boolean;
}

/** First match wins; `prefix` matches the segment and everything below it. */
const ROUTES: Array<{ prefix: string; route: RouteChrome }> = [
  { prefix: "/embed", route: { chrome: "embed", tab: null, word: "hand" } },
  { prefix: "/h", route: { chrome: "share", tab: null, word: "hand" } },
  { prefix: "/p", route: { chrome: "share", tab: null, word: "hand" } },
  { prefix: "/search", route: { chrome: "shell", tab: "forum", word: "search" } },
  { prefix: "/submit", route: { chrome: "shell", tab: "forum", word: "submit" } },
  { prefix: "/convert", route: { chrome: "shell", tab: "convert", word: "convert" } },
  { prefix: "/library", route: { chrome: "shell", tab: "library", word: "library" } },
  { prefix: "/stats", route: { chrome: "shell", tab: "stats", word: "stats" } },
  { prefix: "/players", route: { chrome: "shell", tab: "stats", word: "players" } },
  { prefix: "/analysis", route: { chrome: "shell", tab: "analysis", word: "analysis" } },
  { prefix: "/solver", route: { chrome: "shell", tab: "solver", word: "solver", wide: true } },
  { prefix: "/learn", route: { chrome: "shell", tab: "learn", word: "learn" } },
  { prefix: "/settings", route: { chrome: "shell", tab: null, word: "settings" } },
  { prefix: "/saved", route: { chrome: "shell", tab: null, word: "saved" } },
  { prefix: "/notifications", route: { chrome: "shell", tab: null, word: "notifications" } },
  { prefix: "/mod", route: { chrome: "shell", tab: null, word: "mod" } },
  { prefix: "/u", route: { chrome: "shell", tab: null, word: "profile" } },
  { prefix: "/billing", route: { chrome: "shell", tab: null, word: "billing" } },
];

/** `/f/<board>/<post>…` is a thread; `/` and `/f/<board>` are feeds. */
function forumRoute(pathname: string): RouteChrome | null {
  if (pathname === "/") return { chrome: "shell", tab: "forum", word: "feed" };
  if (pathname === "/f" || pathname.startsWith("/f/")) {
    const depth = pathname.split("/").filter(Boolean).length;
    return { chrome: "shell", tab: "forum", word: depth > 2 ? "thread" : "feed" };
  }
  return null;
}

export function routeChrome(pathname: string): RouteChrome {
  const forum = forumRoute(pathname);
  if (forum) return forum;
  const match = ROUTES.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  // The legal pages, the desktop sign-in and anything new: the bar, no tab.
  return match ? match.route : { chrome: "shell", tab: null, word: null };
}

export function RouteLoading() {
  const en = useDict();
  const route = routeChrome(usePathname() ?? "/");
  const label = route.word ? en.loading.route[route.word] : en.loading.generic;

  if (route.chrome === "embed") {
    return <RailLoader size="section" centered label={label} />;
  }

  if (route.chrome === "share") {
    return (
      <div className="sharepage">
        <header className="sharepage__bar">
          <div className="sharepage__bar-inner">
            <BrandMark showTagline={false} />
          </div>
        </header>
        <main className="sharepage__main">
          <RailLoader size="page" centered showLabel label={label} />
        </main>
      </div>
    );
  }

  return (
    <AppFrame tab={route.tab} feature={null} wide={route.wide ?? false}>
      {() => <RailLoader size="page" centered showLabel label={label} />}
    </AppFrame>
  );
}

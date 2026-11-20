/**
 * `/solver`'s Solver library: the shared browser (`SolverLibrary`) with the
 * web as its host - the dictionary of the page's language, the public
 * bucket's flop library, a full solve where one is served (local), the view
 * kept in the address bar so a link lands on it, and the Free plan's flops a
 * day (`../plan/SolverGate.tsx`; nothing while enforcement is off).
 */

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, type ComponentProps } from "react";
import { flopLibraryBase, FlopLibraryLoader } from "../../lib/analysis/flopLibrary";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { SUPABASE_URL } from "../../lib/supabase/config";
import { useLockedSolverTools, useWebFlopGate } from "../plan/SolverGate";
import { SolverHostProvider, type SolverHost } from "./host";
import { SolverLibrary, type SolverView } from "./SolverLibrary";

/** Where full solves are served: `NEXT_PUBLIC_FULL_SOLVE_BASE`, else `/full-solve` in development (`fullSolve.ts`). */
function fullSolveBase(): string | null {
  const base = process.env.NEXT_PUBLIC_FULL_SOLVE_BASE;
  if (base) return base.replace(/\/$/, "");
  return process.env.NODE_ENV === "development" ? "/full-solve" : null;
}

let loader: FlopLibraryLoader | null | undefined;
function libraryLoader(): FlopLibraryLoader | null {
  if (loader === undefined) {
    const base = flopLibraryBase(SUPABASE_URL);
    loader = base ? new FlopLibraryLoader(base, (url) => fetch(url)) : null;
  }
  return loader;
}

export function WebSolverLibrary(props: Omit<ComponentProps<typeof SolverLibrary>, "onView">) {
  const t = useDict().solver;
  const router = useRouter();
  // Flops a day and the locked Nodelock: only for Free (or signed out) while paid plans are enforced.
  const flops = useWebFlopGate();
  const lockedTools = useLockedSolverTools();
  const host = useMemo<SolverHost>(
    () => ({
      t,
      loader: libraryLoader(),
      fullSolveBase: fullSolveBase(),
      link: (view) => `${window.location.origin}${paths.solver(view)}`,
      flops,
      lockedTools,
    }),
    [t, flops, lockedTools],
  );
  const onView = useCallback((view: SolverView) => router.replace(paths.solver(view), { scroll: false }), [router]);
  return (
    <SolverHostProvider host={host}>
      <SolverLibrary {...props} onView={onView} />
    </SolverHostProvider>
  );
}

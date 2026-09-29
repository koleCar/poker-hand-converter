"use client";

import type { ReactNode } from "react";
import { AppFrame } from "./AppFrame";
import type { ShellTab } from "./AppShell";

/**
 * `AppFrame` around server-rendered content.
 *
 * `AppFrame` takes its children as a render function, which a Server Component
 * cannot pass across the boundary. This adapter can: it receives the already
 * rendered tree as an ordinary prop and hands it back from a function created on
 * this side. The page itself stays server HTML — which, for the forum and for
 * profiles, is the whole point.
 */
export function ServerFrame({ tab = null, children }: { tab?: ShellTab | null; children: ReactNode }) {
  return <AppFrame tab={tab}>{() => children}</AppFrame>;
}

"use client";

import type { ReactNode } from "react";
import { AppFrame } from "../../../components/shell/AppFrame";

/**
 * `AppFrame` around server-rendered content.
 *
 * `AppFrame` takes its children as a render function, which a Server Component
 * cannot pass across the boundary. This adapter can: it receives the already
 * rendered tree as an ordinary prop and hands it back from a function created on
 * this side. The profile itself stays server HTML.
 */
export function ProfileFrame({ children }: { children: ReactNode }) {
  return <AppFrame tab={null}>{() => children}</AppFrame>;
}

"use client";

import { useEffect } from "react";

/**
 * Registers `public/sw.js` (#55), production only: in development a cached
 * chunk would fight hot reload, and the reason for the worker — opening the
 * converter with no network — is a property of a deployed build.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}

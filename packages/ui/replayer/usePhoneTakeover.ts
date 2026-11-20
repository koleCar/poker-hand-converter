"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * On a phone, an opened hand takes the whole screen.
 *
 * A dismissable replayer (`full` mode with an `onClose`, i.e. a hand opened
 * from a list) is drawn in-flow on a desktop, beside or under what opened it.
 * On a phone that leaves the felt squeezed between the site's bars with the
 * list scrolling underneath, so below `PHONE_QUERY` the replayer covers the
 * viewport instead — its own header with a back arrow on top, the transport at
 * the bottom, nothing of the page around it.
 *
 * The back gesture closes it, the way a full-screen view on a phone is
 * expected to: opening pushes one history entry (keeping the router's own
 * state in it), the browser's back pops it and calls `onClose`, and closing
 * any other way takes the entry back off so a later back press does not land
 * on a ghost.
 */
export const PHONE_QUERY = "(max-width: 899px)";

const LOCK_CLASS = "rp-takeover-lock";
const STATE_KEY = "__rpTakeover";

/**
 * A history entry about to be taken back off. Deferred one task so that a
 * replayer replaced by another (the next hand opened from the list, or React's
 * development double-mount) inherits the entry instead of popping it and
 * pushing a new one — an immediate `history.back()` would fire its `popstate`
 * at the replacement and close it.
 */
let pendingBack: number | null = null;

export function usePhoneTakeover(enabled: boolean, onClose: (() => void) | undefined): boolean {
  // Read synchronously on a client render, so a hand opened from a list is a
  // takeover from its first frame instead of mounting in-flow and moving.
  const narrow = useSyncExternalStore(subscribePhone, isPhone, notPhone);

  const active = enabled && narrow && onClose !== undefined;
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add(LOCK_CLASS);

    let popped = false;
    if (pendingBack !== null) {
      window.clearTimeout(pendingBack);
      pendingBack = null;
    } else {
      const state = (window.history.state ?? {}) as Record<string, unknown>;
      window.history.pushState({ ...state, [STATE_KEY]: true }, "");
    }
    const onPop = () => {
      popped = true;
      closeRef.current?.();
    };
    window.addEventListener("popstate", onPop);

    return () => {
      root.classList.remove(LOCK_CLASS);
      window.removeEventListener("popstate", onPop);
      const current = window.history.state as Record<string, unknown> | null;
      if (!popped && current?.[STATE_KEY]) {
        pendingBack = window.setTimeout(() => {
          pendingBack = null;
          window.history.back();
        }, 0);
      }
    };
  }, [active]);

  return active;
}

function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isPhone(): boolean {
  return window.matchMedia(PHONE_QUERY).matches;
}

function notPhone(): boolean {
  return false;
}

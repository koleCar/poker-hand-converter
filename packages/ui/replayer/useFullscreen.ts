/**
 * Fullscreen for the replayer, on every device that has a screen.
 *
 * Two mechanisms, because the platforms disagree:
 *
 *  * **Native** — the Fullscreen API on the replayer's root. Desktop browsers
 *    and Android Chrome. On a phone it then *tries* to lock landscape, which is
 *    the orientation a poker table wants; a refusal is ignored, because the
 *    layout already has a tall shape for portrait.
 *  * **Overlay** — iPhone Safari does not implement element fullscreen for
 *    anything but `<video>`. There the replayer becomes `position: fixed` over
 *    the whole viewport (`data-fullscreen="overlay"` in replayer.css) and the
 *    page underneath stops scrolling. Visually it is the same thing minus the
 *    browser chrome, which only the native path can hide.
 *
 * Either way the layout needs nothing new: the replayer is already sized off
 * `--rp-block` and its own container queries, so "fullscreen" is just a bigger
 * box, and the cards grow with it.
 */

"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

export type FullscreenMode = "off" | "native" | "overlay";

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};
type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

function currentFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function nativeSupported(element: FullscreenElement): boolean {
  return typeof element.requestFullscreen === "function" || typeof element.webkitRequestFullscreen === "function";
}

const LOCK_CLASS = "rp-fullscreen-lock";

export function useFullscreen(rootRef: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState<FullscreenMode>("off");

  // Keep in step with the browser: Esc, the system back gesture and the
  // browser's own "exit full screen" all leave fullscreen without asking us.
  useEffect(() => {
    function onChange() {
      const root = rootRef.current;
      setMode((previous) => {
        if (currentFullscreenElement() && currentFullscreenElement() === root) return "native";
        return previous === "native" ? "off" : previous;
      });
    }
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [rootRef]);

  // The overlay owns the viewport: the page under it must not scroll, and Esc
  // must close it the way it closes native fullscreen.
  useEffect(() => {
    if (mode !== "overlay") {
      return;
    }
    document.documentElement.classList.add(LOCK_CLASS);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMode("off");
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove(LOCK_CLASS);
      window.removeEventListener("keydown", onKey);
    };
  }, [mode]);

  const enter = useCallback(async () => {
    const root = rootRef.current as FullscreenElement | null;
    if (!root) return;
    if (nativeSupported(root)) {
      try {
        await (root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen?.());
        setMode("native");
        const orientation = screen.orientation as LockableOrientation | undefined;
        if (window.matchMedia("(pointer: coarse)").matches && orientation?.lock) {
          orientation.lock("landscape").catch(() => {
            // Refused or unsupported: portrait has its own table shape.
          });
        }
        return;
      } catch {
        // Some embedded webviews expose the API and then refuse it.
      }
    }
    setMode("overlay");
    root.focus();
  }, [rootRef]);

  const exit = useCallback(async () => {
    const doc = document as FullscreenDocument;
    if (currentFullscreenElement()) {
      try {
        await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.());
      } catch {
        // Already out.
      }
    }
    setMode("off");
  }, []);

  const toggle = useCallback(() => (mode === "off" ? enter() : exit()), [mode, enter, exit]);

  return { mode, enter, exit, toggle };
}

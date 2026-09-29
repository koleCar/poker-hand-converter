/**
 * Cloudflare Turnstile, the captcha Supabase Auth checks on sign-up, password
 * sign-in and reset emails (`[auth.captcha]` in `supabase/config.toml`).
 *
 * Rendered only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set — see
 * `isCaptchaEnabled` for why the key and the dashboard switch go together.
 *
 * Two things that are easy to get wrong:
 *
 *  * **A token is single-use.** GoTrue spends it on the first request that
 *    carries it, successful or not, so after every submit the widget has to be
 *    reset or the second attempt fails with a captcha error that looks like the
 *    first attempt's fault. Callers bump `resetSignal` for that.
 *  * **The script is loaded once, explicitly.** `render=explicit` stops it from
 *    scanning the DOM for `.cf-turnstile` on its own, so a dialog that mounts
 *    and unmounts renders exactly one widget each time and removes it after.
 */

"use client";

import { useEffect, useRef } from "react";
import { TURNSTILE_SITE_KEY } from "../../lib/supabase/config";

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      theme?: "auto" | "light" | "dark";
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.onload = () =>
        window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load."));
      script.onerror = () => {
        // Let a later mount try again rather than caching the failure forever.
        scriptPromise = null;
        reject(new Error("Turnstile did not load."));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

interface TurnstileProps {
  /** Called with a fresh token, or with null when the last one expired or failed. */
  onToken: (token: string | null) => void;
  /** Change it to throw away the current token and ask for a new one. */
  resetSignal: number;
}

export function Turnstile({ onToken, resetSignal }: TurnstileProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<string | null>(null);
  // The latest callback, without re-rendering the widget when it changes.
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !hostRef.current) {
      return;
    }
    let cancelled = false;
    const host = hostRef.current;

    loadTurnstile()
      .then((api) => {
        if (cancelled) {
          return;
        }
        const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
        widgetRef.current = api.render(host, {
          sitekey: TURNSTILE_SITE_KEY!,
          theme,
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));

    return () => {
      cancelled = true;
      if (widgetRef.current && window.turnstile) {
        window.turnstile.remove(widgetRef.current);
      }
      widgetRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (resetSignal === 0 || !widgetRef.current || !window.turnstile) {
      return;
    }
    onTokenRef.current(null);
    window.turnstile.reset(widgetRef.current);
  }, [resetSignal]);

  return <div ref={hostRef} className="captcha" />;
}

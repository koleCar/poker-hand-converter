"use client";

import { useSyncExternalStore } from "react";
import { appDownloadUrl, detectPlatform, type AppPlatform } from "../../lib/download";
import { useDict } from "../../lib/i18n/client";
import styles from "./download.module.css";

const ORDER: readonly AppPlatform[] = ["mac", "windows"];

/**
 * The two installers. Both are always offered; once the browser says which
 * desktop OS this is, that one goes first and becomes the primary button.
 * Read from the browser on hydration, so the server HTML (both equal, macOS
 * first) is what a crawler and a first paint see.
 */
export function DownloadButtons() {
  const en = useDict();
  const platform = useSyncExternalStore(neverChanges, browserPlatform, () => null);

  const order = platform === "windows" ? [...ORDER].reverse() : ORDER;

  return (
    <div className={styles.buttons}>
      {order.map((id) => (
        <div key={id} className={styles.option}>
          <a
            className={`btn ${platform === null || platform === id ? "btn--primary" : styles.secondary} ${styles.button}`}
            href={appDownloadUrl(id)}
            data-platform={id}
          >
            <DownloadIcon />
            {en.download[id].cta}
          </a>
          <span className={styles.detail}>{en.download[id].detail}</span>
        </div>
      ))}
    </div>
  );
}

/** The OS never changes under an open page: nothing to subscribe to. */
function neverChanges() {
  return () => {};
}

function browserPlatform(): AppPlatform | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const detected = detectPlatform(nav.userAgent, nav.userAgentData?.platform ?? nav.platform);
  // An iPad asks for the desktop site as a Mac; only a Mac without a touch screen is one.
  return detected === "mac" && nav.maxTouchPoints > 1 ? null : detected;
}

function DownloadIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 3v10M5.5 8.8 10 13.3l4.5-4.5M4 17h12" />
    </svg>
  );
}

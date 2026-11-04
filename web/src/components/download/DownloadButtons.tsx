"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useAuth } from "../../lib/auth";
import { appDownloadPath, detectPlatform, downloadAccess, type AppPlatform, type DownloadAccess } from "../../lib/download";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { ProBadge } from "../plan/ProLock";
import styles from "./download.module.css";

const ORDER: readonly AppPlatform[] = ["mac", "windows"];

/**
 * The two installers, for an account whose plan includes the desktop app
 * (Rail Pro, `downloadAccess`). Signed out, the place of the buttons is
 * "Sign in to download"; on a plan without the app, the upgrade. The buttons
 * link to the web's `/download/<platform>`, which checks the plan again on the
 * server before it hands over the file - this component only says so first.
 *
 * Once the browser says which desktop OS this is, its installer goes first and
 * becomes the primary button. The server HTML is the "checking" line: the
 * session lives in the browser.
 */
export function DownloadButtons() {
  const en = useDict();
  const t = en.download.gate;
  const auth = useAuth();
  const entitlements = useEntitlements();
  const platform = useSyncExternalStore(neverChanges, browserPlatform, () => null);
  const access = clientAccess(auth.status, auth.configured, entitlements.status, entitlements.entitlements);

  if (access === "checking") {
    return (
      <p className={styles.gateNote} role="status">
        {t.checking}
      </p>
    );
  }

  if (access === "signin") {
    return (
      <div className={styles.gate}>
        <button
          type="button"
          className={`btn btn--primary ${styles.button}`}
          onClick={() => auth.requestSignIn(t.signInReason)}
        >
          {t.signIn}
        </button>
        <span className={styles.detail}>{t.signInDetail}</span>
      </div>
    );
  }

  if (access === "pro") {
    return (
      <div className={styles.gate}>
        <p className={styles.gateNote}>
          <ProBadge /> {t.proBody}
        </p>
        <div className={styles.buttons}>
          <Link href={paths.upgrade()} className={`btn btn--primary ${styles.button}`}>
            {en.plan.upgrade}
          </Link>
          <Link href={paths.settingsPlan()} className={`btn btn--ghost ${styles.button}`}>
            {en.plan.lock.seePlan}
          </Link>
        </div>
      </div>
    );
  }

  if (access === "unknown") {
    return (
      <div className={styles.gate}>
        <p className={styles.gateNote} role="alert">
          {t.error}
        </p>
        <button type="button" className={`btn ${styles.secondary} ${styles.button}`} onClick={() => void entitlements.refresh()}>
          {t.retry}
        </button>
      </div>
    );
  }

  const order = platform === "windows" ? [...ORDER].reverse() : ORDER;
  return (
    <div className={styles.buttons}>
      {order.map((id) => (
        <div key={id} className={styles.option}>
          <a
            className={`btn ${platform === null || platform === id ? "btn--primary" : styles.secondary} ${styles.button}`}
            href={appDownloadPath(id)}
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

type ClientAccess = DownloadAccess | "checking";
type EntitlementsValue = ReturnType<typeof useEntitlements>;

/** `downloadAccess` from what the browser knows, with "still finding out" in front of it. */
export function clientAccess(
  authStatus: ReturnType<typeof useAuth>["status"],
  authConfigured: boolean,
  status: EntitlementsValue["status"],
  entitlements: EntitlementsValue["entitlements"],
): ClientAccess {
  // A build without a database has no accounts, so no plan can allow it.
  if (!authConfigured) return "unknown";
  if (authStatus === "loading") return "checking";
  if (authStatus === "signed-out") return downloadAccess(false, null);
  if (status === "loading" || status === "none") return "checking";
  return downloadAccess(true, status === "ready" ? entitlements : null);
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

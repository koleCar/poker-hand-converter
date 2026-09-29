"use client";

import Link from "next/link";
import { AppFrame } from "../components/shell/AppFrame";
import { en } from "../lib/i18n/en";
import { paths } from "../lib/routes";
import styles from "./home.module.css";

/**
 * Client half of `/`.
 *
 * Inside `AppFrame` with `tab={null}`, so the bar, the sign-in dialog and the
 * "no database configured" banner all behave exactly as they do on the other
 * screens — a landing page that quietly lost the sign-in affordance would be a
 * regression nobody notices until somebody cannot sign in.
 */
export function HomeScreen({ authFailed }: { authFailed: boolean }) {
  return (
    <AppFrame tab={null}>
      {() => (
        <div className="stack">
          {authFailed ? <p className="notice notice--warn">{en.auth.callbackFailed}</p> : null}

          <section className={`card ${styles.hero}`}>
            <h1 className={styles.heading}>{en.home.heading}</h1>
            <p className={styles.body}>{en.home.body}</p>
            <div className={styles.actions}>
              <Link href={paths.convert()} className="btn btn--primary">
                {en.home.convertCta}
              </Link>
              <Link href={paths.library()} className="btn btn--ghost">
                {en.home.libraryCta}
              </Link>
            </div>
            <p className="muted">{en.home.note}</p>
          </section>
        </div>
      )}
    </AppFrame>
  );
}

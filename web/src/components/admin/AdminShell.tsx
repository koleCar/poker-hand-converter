"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { AppFrame } from "../shell/AppFrame";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./admin.module.css";

/**
 * The admin pages' frame: the site's shell (wide), and the two sections,
 * Users and Reports, as a quiet segmented control. Whether the caller is an
 * admin is the database's answer (every admin function refuses anyone else);
 * the sections show "Admins only" on that refusal.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <AppFrame tab={null} wide>
      {() => <AdminBody>{children}</AdminBody>}
    </AppFrame>
  );
}

function AdminBody({ children }: { children: ReactNode }) {
  const t = useDict().admin;
  const auth = useAuth();
  const pathname = usePathname() ?? "";
  if (auth.status === "loading") {
    return <RailLoader label={t.loading} />;
  }
  if (!auth.isSignedIn) {
    return <p className={styles.state}>{t.signIn}</p>;
  }
  const onReports = pathname.startsWith(paths.adminReports());
  return (
    <div className={styles.page}>
      <nav className={styles.sections} aria-label={t.nav.label}>
        <Link href={paths.admin()} className={onReports ? styles.section : `${styles.section} ${styles.sectionOn}`}>
          {t.nav.users}
        </Link>
        <Link href={paths.adminReports()} className={onReports ? `${styles.section} ${styles.sectionOn}` : styles.section}>
          {t.nav.reports}
        </Link>
      </nav>
      {children}
    </div>
  );
}

/** A section's load failure: "Admins only" on a refusal, else the reason and a retry. */
export function AdminError({ denied, reason, onRetry }: { denied: boolean; reason: string; onRetry: () => void }) {
  const t = useDict().admin;
  if (denied) return <p className={styles.state}>{t.denied}</p>;
  return (
    <div className={styles.state}>
      <p>{t.error(reason)}</p>
      <button type="button" className="btn btn--sm" onClick={onRetry}>
        {t.retry}
      </button>
    </div>
  );
}

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
 * The admin pages' frame: the site's shell (wide), and the sections, Users,
 * Reports and the Pro waitlist, as a quiet segmented control. Whether the caller is an
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
  const current = pathname.startsWith(paths.adminReports())
    ? "reports"
    : pathname.startsWith(paths.adminWaitlist())
      ? "waitlist"
      : "users";
  const sections = [
    { id: "users", href: paths.admin(), label: t.nav.users },
    { id: "reports", href: paths.adminReports(), label: t.nav.reports },
    { id: "waitlist", href: paths.adminWaitlist(), label: t.nav.waitlist },
  ] as const;
  return (
    <div className={styles.page}>
      <nav className={styles.sections} aria-label={t.nav.label}>
        {sections.map((section) => (
          <Link
            key={section.id}
            href={section.href}
            className={section.id === current ? `${styles.section} ${styles.sectionOn}` : styles.section}
            aria-current={section.id === current ? "page" : undefined}
          >
            {section.label}
          </Link>
        ))}
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

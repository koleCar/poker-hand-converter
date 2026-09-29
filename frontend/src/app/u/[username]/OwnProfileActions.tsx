"use client";

import Link from "next/link";
import { en } from "../../../lib/i18n/en";
import { useMyProfile } from "../../../lib/profile/context";
import { ReportButton } from "../../../components/forum/ReportButton";
import { paths } from "../../../lib/routes";
import styles from "./profile.module.css";

/**
 * The owner's extras on their own profile, decided in the browser.
 *
 * Client-side on purpose: the page HTML is then identical for every visitor,
 * so nothing about who is looking can end up in a cached render.
 */
export function OwnProfileActions({ profileId, username }: { profileId: string; username: string }) {
  const { profile } = useMyProfile();
  if (!profile || profile.id !== profileId) {
    // Somebody else's profile: the one thing to offer is a report.
    return profile ? <ReportButton subject={{ type: "profile", username }} defaultReason="harassment" /> : null;
  }
  return (
    <div className={styles.own}>
      <small className="muted">{en.profile.yours}</small>
      <Link href={paths.settings()} className="btn btn--sm">
        {en.profile.editCta}
      </Link>
    </div>
  );
}

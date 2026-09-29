import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { OwnProfileActions } from "./OwnProfileActions";
import { ProfileFrame } from "./ProfileFrame";
import { en } from "../../../lib/i18n/en";
import { paths } from "../../../lib/routes";
import { readProfile, type PublicProfile } from "../../../lib/server/profiles";
import styles from "./profile.module.css";

/**
 * A public profile.
 *
 * Server-rendered from `profiles_public`, which is readable by `anon` — so this
 * page shows a stranger exactly what the view's column list allows and nothing
 * else. There is no "signed in as the owner" variant of the data: the owner's
 * extras (the edit link) are a client component that compares ids after
 * hydration, so the HTML is the same for everyone and can be cached as such.
 *
 * ## Old names
 *
 * `set_username()` keeps an account's previous name reserved for it for a year,
 * and `resolve_username()` maps the old name to the current one, so a link to
 * `/u/<old>` keeps working: it redirects permanently (308, Next's
 * `permanentRedirect`; for a GET it is the same instruction as a 301). The same
 * redirect settles capitalisation, so every profile has one URL.
 *
 * ## `noindex`, for now
 *
 * A profile with nothing on it is a thin page, and a few thousand of them is
 * how a new site teaches a search engine it is mostly empty. F7 gives profiles
 * something to show (published hands); that is when indexing should be decided,
 * per profile, on whether there is anything to index.
 */

interface PageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const result = await readProfile(decodeURIComponent(username));
  const name = result.status === "ok" ? result.profile.username : null;

  return {
    title: name ? en.profile.metaTitle(name) : en.meta.notFound.title,
    description: name ? en.profile.metaDescription(name) : en.meta.notFound.description,
    alternates: name ? { canonical: paths.profile(name) } : undefined,
    robots: { index: false, follow: true },
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const { username } = await params;
  const result = await readProfile(decodeURIComponent(username));

  if (result.status === "redirect") {
    permanentRedirect(paths.profile(result.username));
  }
  if (result.status === "not-found") {
    notFound();
  }

  return (
    <ProfileFrame>
      {result.status === "ok" ? (
        <ProfileContent profile={result.profile} />
      ) : (
        <section className="card stack">
          <h1 className={styles.name}>{en.profile.unavailable.heading}</h1>
          <p className="muted">{en.profile.unavailable.body}</p>
          <div>
            <Link href={paths.home()} className="btn">
              {en.profile.homeCta}
            </Link>
          </div>
        </section>
      )}
    </ProfileFrame>
  );
}

/** `2026-09-29` -> `September 2026`, in UTC so it is the same for everyone. */
function formatJoined(joinedOn: string): string {
  const date = new Date(`${joinedOn}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return joinedOn;
  }
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function ProfileContent({ profile }: { profile: PublicProfile }) {
  return (
    <div className="stack">
      <section className={`card ${styles.header}`}>
        <span className={styles.avatar} aria-hidden="true">
          {profile.username.charAt(0).toUpperCase()}
        </span>
        <div className={styles.identity}>
          <h1 className={styles.name}>{profile.username}</h1>
          <p className={styles.facts}>
            <span>{en.profile.joined(formatJoined(profile.joinedOn))}</span>
            <span aria-hidden="true">·</span>
            <span>{en.profile.karma(profile.karma)}</span>
          </p>
        </div>
        <OwnProfileActions profileId={profile.id} />
      </section>

      <section className={`card ${styles.empty}`}>
        <h2 className={styles.emptyHeading}>{en.profile.emptyHeading}</h2>
        <p className="muted">{en.profile.emptyBody}</p>
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { OwnProfileActions } from "./OwnProfileActions";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";
import { publishedHandsByAuthor, type PublishedHandSummary } from "../../../lib/server/published";
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
 * ## Indexed only with something on it
 *
 * A profile with nothing on it is a thin page, and a few thousand of them is
 * how a new site teaches a search engine it is mostly empty. So a profile is
 * `index` exactly when it lists at least one published hand, and `noindex`
 * until then.
 */

interface PageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const en = await getDict();
  const { username } = await params;
  const result = await readProfile(decodeURIComponent(username));
  const name = result.status === "ok" ? result.profile.username : null;
  const hands = name ? await publishedHandsByAuthor(name) : [];

  return {
    title: name ? en.profile.metaTitle(name) : en.meta.notFound.title,
    description: name ? en.profile.metaDescription(name) : en.meta.notFound.description,
    alternates: name ? { canonical: paths.profile(name) } : undefined,
    robots: { index: hands.length > 0, follow: true },
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const en = await getDict();
  const { username } = await params;
  const result = await readProfile(decodeURIComponent(username));

  if (result.status === "redirect") {
    permanentRedirect(paths.profile(result.username));
  }
  if (result.status === "not-found") {
    notFound();
  }

  return (
    <ServerFrame>
      {result.status === "ok" ? (
        <ProfileContent profile={result.profile} hands={await publishedHandsByAuthor(result.profile.username)} />
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
    </ServerFrame>
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

async function ProfileContent({ profile, hands }: { profile: PublicProfile; hands: PublishedHandSummary[] }) {
  const en = await getDict();
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
        <OwnProfileActions profileId={profile.id} username={profile.username} />
      </section>

      {hands.length ? (
        <section className={`card ${styles.empty}`}>
          <h2 className={styles.emptyHeading}>{en.profile.publishedHeading}</h2>
          <ul className={styles.hands}>
            {hands.map((hand) => (
              <li key={hand.publicId}>
                <Link href={paths.publishedHand(hand.publicId)} className={styles.handLink}>
                  {hand.title ?? en.profile.untitledHand(hand.stakesLabel ?? "")}
                </Link>
                <small className="muted">
                  {[hand.heroPosition, hand.heroCards.join(" "), hand.playedOn].filter(Boolean).join(" · ")}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className={`card ${styles.empty}`}>
          <h2 className={styles.emptyHeading}>{en.profile.emptyHeading}</h2>
          <p className="muted">{en.profile.emptyBody}</p>
        </section>
      )}
    </div>
  );
}

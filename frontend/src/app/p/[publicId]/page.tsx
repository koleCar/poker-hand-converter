import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HandSummary } from "../../../components/hand/HandSummary";
import { ReplayViewer } from "../../../components/replayer/ReplayViewer";
import { decodePosition, POSITION_PARAM, type ReplayPosition } from "../../../components/replayer/position";
import { buildSharePreview, formatStakes, shortGameName } from "../../../components/share/preview";
import { BrandMark } from "../../../components/shell/BrandMark";
import { en } from "../../../lib/i18n/en";
import { getParser } from "../../../lib/parsers";
import type { PhfHand } from "../../../lib/phf/types";
import { canonicalUrl, paths } from "../../../lib/routes";
import { readPublishedHand, type PublishedHand } from "../../../lib/server/published";
import styles from "./published.module.css";

/**
 * A published hand. Public, server-rendered, and — unlike `/h/:slug` —
 * **indexable**.
 *
 * The difference is the whole point of F7. A share slug is a capability URL:
 * knowing it is the authorisation, so it must never be enumerable, and it is
 * `noindex`. A published hand is something its owner chose to put in front of
 * everyone, as a scrubbed copy with no raw room text, no table, no hand number
 * and — by default — no opponent names. That is content, and content wants to be
 * found.
 *
 * The page is the static summary first (`HandSummary`: real text about real
 * cards, which is what ranks) and the replayer second, as a client island.
 */

interface PageProps {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function headline(published: PublishedHand): string {
  if (published.title) {
    return published.title;
  }
  const hand = published.phf;
  const hero = hand.players.find((player) => player.isHero);
  const heroText = hero
    ? [hero.position, hero.holeCards.length ? hero.holeCards.join(" ") : null].filter(Boolean).join(" ")
    : null;
  return en.published.headline(formatStakes(hand), shortGameName(hand.game.label), heroText || null);
}

function formatDay(day: string | null): string | null {
  if (!day) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { publicId } = await params;
  const result = await readPublishedHand(publicId);
  if (result.status !== "ok") {
    return {
      title: en.published.metaTitleFallback,
      robots: { index: false, follow: true },
    };
  }
  const published = result.hand;
  // Spoilers closed: an unfurl is permanently at the deal.
  const preview = buildSharePreview(published.phf, { spoilers: false });
  const title = `${headline(published)} | Rail`;
  const url = canonicalUrl(paths.publishedHand(published.publicId));
  return {
    title,
    description: preview.description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: "article",
      siteName: en.brand.name,
      title,
      description: preview.description,
      url,
      images: [{ url: "/og-default.png", width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title, description: preview.description, images: ["/og-default.png"] },
  };
}

export default async function PublishedHandPage({ params, searchParams }: PageProps) {
  const { publicId } = await params;
  // `?t=` read here, on the server, and handed to the replayer: if the client
  // read it from the URL instead, the server would render the deal and the
  // client the linked moment, and hydration would throw the tree away.
  const rawT = (await searchParams)[POSITION_PARAM];
  const initialPosition = decodePosition(Array.isArray(rawT) ? rawT[0] : rawT);
  const result = await readPublishedHand(publicId);

  if (result.status === "not-found") {
    notFound();
  }

  return (
    <div className="sharepage">
      <header className="sharepage__bar">
        <div className="sharepage__bar-inner">
          <BrandMark showTagline={false} />
          <div className="sharepage__bar-actions">
            <Link href={paths.convert()} className="btn btn--primary btn--sm">
              {en.published.convertCta}
            </Link>
          </div>
        </div>
      </header>

      <main className={`sharepage__main ${styles.main}`}>
        {result.status === "ok" ? (
          <PublishedContent published={result.hand} initialPosition={initialPosition} />
        ) : (
          <Gone kind={result.status} />
        )}
      </main>
    </div>
  );
}

function PublishedContent({
  published,
  initialPosition,
}: {
  published: PublishedHand;
  initialPosition: ReplayPosition | null;
}) {
  const hand: PhfHand = published.phf;
  const siteName = getParser(published.site)?.name ?? published.site;
  const playedOn = formatDay(published.playedOn);

  return (
    <article className={styles.article}>
      <header className={styles.header}>
        <h1 className={styles.title}>{headline(published)}</h1>
        <p className={styles.facts}>
          <span>{en.published.facts.site(siteName)}</span>
          <span aria-hidden="true">·</span>
          <span>{en.published.facts.handed(hand.players.length)}</span>
          {playedOn ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{en.published.facts.playedOn(playedOn)}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>
            {en.published.facts.by}{" "}
            {published.author ? (
              <Link href={paths.profile(published.author.username)}>{published.author.username}</Link>
            ) : (
              en.published.facts.anonymous
            )}
          </span>
        </p>
        <p className={styles.mode}>{en.published.modeNote[published.mode]}</p>
      </header>

      <section className={`card ${styles.card}`}>
        <HandSummary hand={hand} />
      </section>

      <section className={styles.replay} aria-label={en.published.replayHeading}>
        <ReplayViewer hand={hand} site={siteName} initialPosition={initialPosition} />
      </section>
    </article>
  );
}

function Gone({ kind }: { kind: "deleted" | "removed" | "unconfigured" | "error" }) {
  const copy =
    kind === "deleted"
      ? en.published.gone.deleted
      : kind === "removed"
        ? en.published.gone.removed
        : en.published.gone.unavailable;
  return (
    <section className="sharepage__problem">
      <span className="sharepage__problem-mark" aria-hidden="true">
        ♠
      </span>
      <h1>{copy.heading}</h1>
      <p>{copy.body}</p>
      <div className="sharepage__problem-actions">
        <Link href={paths.home()} className="btn btn--primary">
          {en.published.homeCta}
        </Link>
      </div>
    </section>
  );
}

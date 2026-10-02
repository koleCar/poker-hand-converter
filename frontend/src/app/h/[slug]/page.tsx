import type { Metadata } from "next";
import Link from "next/link";
import { buildSharePreview, formatPlayedAt, formatStakes, shortGameName } from "../../../components/share/preview";
import { BrandMark } from "../../../components/shell/BrandMark";
import { ReplayViewer } from "../../../components/replayer/ReplayViewer";
import { decodePosition, POSITION_PARAM, type ReplayPosition } from "../../../components/replayer/position";
import { RecordShareView } from "./RecordShareView";
import { parseHand } from "../../../lib/phf";
import type { PhfHand } from "../../../lib/phf/types";
import { getDict } from "../../../lib/i18n/server";
import type { Dict } from "../../../lib/i18n/types";
import { paths, sharedHandUrl } from "../../../lib/routes";
import { readShare, type ShareReadResult } from "../../../lib/server/shares";

/**
 * A shared hand. Server-rendered, with real per-request metadata.
 *
 * ## What this replaced
 *
 * `frontend/api/share-meta.ts` plus the User-Agent rewrite in
 * `frontend/vercel.json`. Both are deleted. That setup served a stripped HTML
 * document with per-hand Open Graph tags *only* to requests whose UA matched a
 * crawler regex, and gave humans the SPA with generic tags patched in by an
 * effect after hydration.
 *
 * Serving one thing to crawlers and another to people is a fork with no
 * upside once the framework can render on the server: the regex had to be
 * maintained against every new unfurl bot, it silently failed for anything not
 * on the list, and a UA-gated document is indistinguishable from cloaking to
 * anyone auditing it. Now there is one render, one set of tags, and `curl` with
 * no UA tricks sees exactly what Slack sees.
 *
 * ## `noindex, follow`
 *
 * A change from the old behaviour, where shares were indexable. A share slug is
 * a **capability URL** — knowing it is the authorization, which is precisely
 * why `read_share` is `security definer` and works for a stranger with no
 * account. Putting one in a search index destroys the only property that makes
 * that safe: its enumeration resistance. The two are a contradiction, and the
 * index is the half that goes.
 *
 * `follow` rather than `none`, so the links *out* of this page — to the
 * converter and the library — still carry.
 *
 * ## Spoilers
 *
 * `buildSharePreview` gates everything derived from `hand.results` on the
 * share's own `spoilers` column, defaulting closed. An unfurl has no frame
 * position: it is permanently at the deal, so "Villain wins $312" in an
 * `og:description` answers "what would you do here?" before anyone opens the
 * link. Same rule, same single implementation, as the in-app replayer chrome.
 */

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Both halves of the page read the hand the same way, from the same cache. */
function handOf(result: ShareReadResult): PhfHand | null {
  const text = result.share?.standardText;
  return text ? parseHand(text) : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const en = await getDict();
  const { slug } = await params;
  const result = await readShare(slug);
  const hand = handOf(result);

  const preview = hand
    ? buildSharePreview(hand, { spoilers: result.share?.spoilers === true })
    : null;

  const title = preview?.title ?? en.meta.sharedHand.fallbackTitle;
  const description = preview?.description ?? en.meta.sharedHand.fallbackDescription;
  const url = sharedHandUrl(slug);

  return {
    title,
    description,
    alternates: { canonical: url },
    // See the header. A capability URL in the search index is a contradiction.
    robots: { index: false, follow: true },
    openGraph: {
      type: "article",
      siteName: en.brand.name,
      title,
      description,
      url,
      images: [{ url: "/og-default.png", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og-default.png"],
    },
  };
}

export default async function SharedHandPage({ params, searchParams }: PageProps) {
  const en = await getDict();
  const { slug } = await params;
  // Read on the server and passed down, so the server render and the first
  // client render open at the same moment; otherwise `?t=` links hydrate with a
  // mismatch and React discards the server tree.
  const rawT = (await searchParams)[POSITION_PARAM];
  const initialPosition = decodePosition(Array.isArray(rawT) ? rawT[0] : rawT);
  // Same call, same request, one round trip: `readShare` is `cache()`d, and
  // supabase-js RPCs are POSTs that Next's fetch memoisation would not dedupe.
  const result = await readShare(slug);
  const hand = handOf(result);

  return (
    <div className="sharepage">
      <header className="sharepage__bar">
        <div className="sharepage__bar-inner">
          <BrandMark showTagline={false} />
          <div className="sharepage__bar-actions">
            <Link href={paths.library()} className="sharepage__bar-link">
              {en.share.ownHandsLink}
            </Link>
            <Link href={paths.convert()} className="btn btn--primary btn--sm">
              {en.share.openAppCta}
            </Link>
          </div>
        </div>
      </header>

      <main className="sharepage__main">
        {hand && result.share ? (
          <>
            {/* The counter is a client beacon, fired once per session. It used
                to be a side effect of resolving, which meant a reload counted
                again and every Slack unfurl counted as a reader. */}
            <RecordShareView slug={slug} />
            <SharedHandContent
              hand={hand}
              createdAt={result.share.createdAt}
              views={result.share.views}
              slug={slug}
              initialPosition={initialPosition}
            />
          </>
        ) : (
          <SharedHandProblem
            kind={result.status === "ok" ? "unparseable" : result.status}
          />
        )}
      </main>

      <footer className="sharepage__footer">
        <p>
          <strong>{en.brand.name}</strong> {en.share.footerBlurb}
        </p>
        <Link href={paths.convert()} className="btn btn--sm">
          {en.share.tryFreeCta}
        </Link>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------------- content */

async function SharedHandContent({
  hand,
  createdAt,
  views,
  slug,
  initialPosition,
}: {
  hand: PhfHand;
  createdAt: string | null;
  views: number;
  slug: string;
  initialPosition: ReplayPosition | null;
}) {
  const en = await getDict();
  const sharedAt = formatPlayedAt(createdAt);

  return (
    <>
      {/* The hand itself is the page — the heading stays for screen readers
          only, so the replay opens without spoilers above it. */}
      <h1 className="sharepage__sr-title">
        {formatStakes(hand)} {shortGameName(hand.game.label)}
      </h1>

      {/* The replayer owns `?t=` on this page: the address follows the moment on
          screen, and copying it copies that moment. The opening position is read
          back off the same parameter, resolved lossy-tolerantly — see
          `replayer/position.ts`. */}
      <section className="sharepage__replay">
        <ReplayViewer hand={hand} initialPosition={initialPosition} />
      </section>

      <section className="sharepage__cta">
        <div>
          <h2>{en.share.ctaHeading}</h2>
          <p>{en.share.ctaBody}</p>
        </div>
        <div className="sharepage__cta-actions">
          <Link href={paths.library()} className="btn btn--primary">
            {en.share.ctaReplayer}
          </Link>
          <Link href={paths.convert()} className="btn btn--ghost">
            {en.share.ctaConvert}
          </Link>
        </div>
      </section>

      <p className="sharepage__shared-at">
        {[
          sharedAt ? en.share.sharedAt(sharedAt) : null,
          views > 0 ? en.share.views(views) : null,
          paths.sharedHand(slug),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </>
  );
}

type ProblemKind = "not-found" | "unconfigured" | "unparseable" | "error";

function problems(en: Dict): Record<ProblemKind, { title: string; body: string }> {
  return {
    "not-found": en.share.problems.notFound,
    unconfigured: en.share.problems.unconfigured,
    unparseable: en.share.problems.unparseable,
    error: { title: en.share.problems.error.title, body: en.share.problems.gone.body },
  };
}

async function SharedHandProblem({ kind }: { kind: ProblemKind }) {
  const en = await getDict();
  const table = problems(en);
  const copy = table[kind] ?? table["not-found"];

  return (
    <section className="sharepage__problem">
      <span className="sharepage__problem-mark" aria-hidden="true">
        ♠
      </span>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <div className="sharepage__problem-actions">
        <Link href={paths.library()} className="btn btn--primary">
          {en.share.problemReplayCta}
        </Link>
        <Link href={paths.convert()} className="btn btn--ghost">
          {en.share.problemHomeCta}
        </Link>
      </div>
    </section>
  );
}

import type { MetadataRoute } from "next";
import { CONCEPT_IDS } from "../lib/learn/concepts";
import { REFERENCE_IDS, writtenLessons } from "../lib/learn/course";
import { canonicalUrl, paths } from "../lib/routes";
import { recentPosts } from "../lib/server/forum";
import { recentPublishedHands } from "../lib/server/published";

/**
 * `/sitemap.xml`.
 *
 * The home page, the converter, the Learn tab and its written lessons
 * (`/learn/**`), the concept library (`/analysis/learn/**`),
 * the preflop chart browser (`/analysis/charts`),
 * every forum thread and every published hand (`/p/:id`) — the whole set of
 * pages that are public, stable and the same for everybody.
 * Published hands are the content F7 exists to create; they are listed from
 * the table the visibility policy guards, so a removed hand drops out of this
 * file on the next render.
 *
 * Deliberately absent:
 *
 *  * `/h/:slug` — a capability URL. Enumerating them into a public XML file is
 *    the exact inverse of the property that makes sharing safe. See
 *    `app/h/[slug]/page.tsx`.
 *  * `/library`, `/stats`, `/analysis` (apart from `/analysis/learn` and
 *    `/analysis/charts`) — one
 *    account's own rows behind RLS. A crawler sees a sign-in prompt, which is
 *    a soft 404 with extra steps.
 *  * the redirect aliases (`/upload`, `/replay`, …) — listing a URL that 308s
 *    tells a crawler to follow a hop it did not need to take.
 *
 * `SITE_URL` is `NEXT_PUBLIC_SITE_URL`, defaulting to the current free
 * `*.vercel.app` host. When `rail.poker` goes live this file needs no edit.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [hands, posts] = await Promise.all([recentPublishedHands(), recentPosts()]);
  return [
    {
      url: canonicalUrl(paths.home()),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: canonicalUrl(paths.convert()),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: canonicalUrl(paths.convertManual()),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: canonicalUrl(paths.learn()),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    // Written lessons only: a "coming soon" page is an outline, not yet worth a crawl.
    ...writtenLessons().map((meta) => ({
      url: canonicalUrl(paths.lesson(meta.id)),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    // The reference pages (L1.1): L1's orientation, maths and range lessons, kept as reading.
    ...REFERENCE_IDS.map((id) => ({
      url: canonicalUrl(paths.learnReference(id)),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
    {
      url: canonicalUrl(paths.analysisLearn()),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: canonicalUrl(paths.analysisCharts()),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    ...CONCEPT_IDS.map((id) => ({
      url: canonicalUrl(paths.analysisConcept(id)),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...posts.map((post) => ({
      url: canonicalUrl(paths.post(...post.path)),
      lastModified: post.createdAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...hands.map((hand) => ({
      url: canonicalUrl(paths.publishedHand(hand.publicId)),
      lastModified: hand.createdAt,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}

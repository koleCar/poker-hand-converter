import type { MetadataRoute } from "next";
import { canonicalUrl, paths } from "../lib/routes";
import { recentPosts } from "../lib/server/forum";
import { recentPublishedHands } from "../lib/server/published";

/**
 * `/sitemap.xml`.
 *
 * The home page, the converter, every forum thread and every published hand (`/p/:id`) — the
 * whole set of pages that are public, stable and the same for everybody.
 * Published hands are the content F7 exists to create; they are listed from
 * the table the visibility policy guards, so a removed hand drops out of this
 * file on the next render.
 *
 * Deliberately absent:
 *
 *  * `/h/:slug` — a capability URL. Enumerating them into a public XML file is
 *    the exact inverse of the property that makes sharing safe. See
 *    `app/h/[slug]/page.tsx`.
 *  * `/library`, `/stats` — one account's own rows behind RLS. A crawler sees
 *    a sign-in prompt, which is a soft 404 with extra steps.
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

import type { MetadataRoute } from "next";
import { canonicalUrl, paths } from "../lib/routes";

/**
 * `/sitemap.xml`.
 *
 * Two entries, and that is not an oversight — it is the whole set of pages that
 * are public, stable and the same for everybody.
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
export default function sitemap(): MetadataRoute.Sitemap {
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
  ];
}

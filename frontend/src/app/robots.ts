import type { MetadataRoute } from "next";
import { canonicalUrl, paths } from "../lib/routes";

/**
 * `/robots.txt`.
 *
 * `/h/` is disallowed, and the pages under it also carry `noindex, follow` from
 * `generateMetadata`. Both, deliberately: `robots.txt` stops the crawl,
 * `noindex` stops the *indexing* of a URL discovered some other way — a link
 * from a forum post, a browser's telemetry, a toolbar. A share slug is a
 * capability URL whose enumeration resistance is the whole security model, and
 * a rule that only works if the crawler found it through us is not a rule.
 *
 * `/library`, `/stats` and `/auth` are one account's own screens behind RLS.
 * There is nothing on them for a signed-out crawler and nothing worth spending
 * crawl budget on.
 *
 * `/` and `/convert` are the two public surfaces and are the whole sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // `/embed/` duplicates `/p/` without its context; `/api/` is machinery.
      disallow: ["/h/", "/embed/", "/api/", paths.library(), paths.stats(), "/auth/"],
    },
    sitemap: canonicalUrl("/sitemap.xml"),
  };
}

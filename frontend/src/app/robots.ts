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
 * `/library`, `/stats`, `/analysis` and `/auth` are one account's own screens behind RLS.
 * There is nothing on them for a signed-out crawler and nothing worth spending
 * crawl budget on — except `/analysis/learn`, the concept library, which reads
 * no account data and is allowed back in explicitly. Crawlers resolve a
 * conflict by the longest matching rule, so the `allow` wins under it.
 *
 * `/`, `/convert` and the concept library are the public surfaces in the sitemap,
 * with the forum threads and published hands.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", paths.analysisLearn()],
      // `/embed/` duplicates `/p/` without its context; `/api/` is machinery.
      disallow: ["/h/", "/embed/", "/api/", paths.library(), paths.stats(), paths.analysis(), "/auth/"],
    },
    sitemap: canonicalUrl("/sitemap.xml"),
  };
}

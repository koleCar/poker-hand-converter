/**
 * The addresses the app has, and the one URL it has to be able to write down.
 *
 * This is what is left of `src/routes/routes.ts` after the App Router took over
 * matching. The matcher (`matchRoute`), the alias table (`ALIASES`), the pattern
 * list (`PATTERNS`), the base-path helpers (`BASE` / `toAppPath` / `toHref`) and
 * the `RouteMatch` type are all gone: Next's file-system router matches, and
 * `next.config.ts` redirects. Keeping a second, hand-rolled answer to "what does
 * this path mean" alongside the framework's is how the two drift apart.
 *
 * What stays is the part the framework does not own: a typed table of paths so a
 * rename is one edit rather than a grep, and `sharedHandUrl`, which is the only
 * place in the app that needs an *absolute* URL.
 *
 * NOTE (see README, "The rule that keeps the test harness alive"): this file is
 * `lib/`, but it is not one of the pure-TypeScript modules the backend harness
 * imports — `lib/{phf,parsers,replay,cards,format,stats}`. Those may never touch
 * `process.env`. This one may, and does, for `NEXT_PUBLIC_SITE_URL`.
 */

export const paths = {
  /** The feed. As of #27 this is the landing page, not the converter. */
  home: () => "/",
  convert: () => "/convert",
  library: () => "/library",
  stats: () => "/stats",
  sharedHand: (slug: string) => `/h/${encodeURIComponent(slug)}`,
} as const;

/**
 * Canonical origin, for the paths that have to be absolute — a clipboard link,
 * an `og:url`, a sitemap entry, an OAuth redirect.
 *
 * It is a variable rather than a literal because the product is on a free
 * `*.vercel.app` host until `rail.poker` is registered, and moving should be a
 * config change rather than a code change. **The default keeps the current host
 * working with nothing set**, which is the whole point: a missing env var must
 * not silently produce `https://undefined/h/abc` in somebody's clipboard.
 *
 * `NEXT_PUBLIC_` because `sharedHandUrl` runs in the browser as well as on the
 * server; Next inlines the literal `process.env.NEXT_PUBLIC_SITE_URL` at build
 * time, so it must be written out in full here rather than looked up
 * dynamically.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://poker-hand-converter.vercel.app"
).replace(/\/+$/, "");

/**
 * Absolute URL for a share slug — what actually gets copied to the clipboard.
 *
 * In the browser the live origin is always right and is used directly, so a
 * preview deploy copies preview links rather than production ones. `SITE_URL`
 * only covers the case where there is no browser: `generateMetadata`, the
 * sitemap, the OAuth redirect.
 */
export function sharedHandUrl(slug: string): string {
  const origin = typeof window === "undefined" ? SITE_URL : window.location.origin;
  return `${origin}${paths.sharedHand(slug)}`;
}

/**
 * Absolute URL for any app-relative path.
 *
 * Server-side only by intent — it always uses `SITE_URL`, because the two
 * callers (`generateMetadata` and `sitemap.ts`) want the canonical host even
 * when rendering happens on a preview deployment.
 */
export function canonicalUrl(path: string): string {
  return `${SITE_URL}${path}`;
}

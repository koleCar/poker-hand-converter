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
  /**
   * A public profile. Every top-level segment here is also a row in
   * `username_reservations` (seeded by `20261007090000_forum_identity.sql`), so
   * a new top-level route belongs in that seed in the same change.
   */
  profile: (username: string) => `/u/${encodeURIComponent(username)}`,
  settings: () => "/settings",
  /** The forum. `/` is the all-boards feed; a board has its own. */
  board: (slug: string) => `/f/${encodeURIComponent(slug)}`,
  /**
   * A post. The slug is decoration: the id is the key, and a stale or wrong
   * slug 308s to the current one, so an edited title never breaks a link.
   */
  post: (board: string, publicId: string, slug: string) =>
    `/f/${encodeURIComponent(board)}/${encodeURIComponent(publicId)}/${encodeURIComponent(slug)}`,
  /** A comment permalink: the post, plus `#c-<seq>`. Never the comment's uuid. */
  comment: (board: string, publicId: string, slug: string, seq: number) =>
    `/f/${encodeURIComponent(board)}/${encodeURIComponent(publicId)}/${encodeURIComponent(slug)}#c-${seq}`,
  submit: () => "/submit",
  notifications: () => "/notifications",
  saved: () => "/saved",
  mod: () => "/mod",
  takedown: () => "/takedown",
  search: (query?: string) => (query ? `/search?q=${encodeURIComponent(query)}` : "/search"),
  /** A published hand. Public, indexable — unlike `/h/:slug`. */
  publishedHand: (publicId: string) => `/p/${encodeURIComponent(publicId)}`,
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

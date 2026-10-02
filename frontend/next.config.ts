import type { NextConfig } from "next";

/**
 * Next.js configuration.
 *
 * ## Why the root directory is still `frontend`
 *
 * `tests/test/*.ts` imports `../../frontend/src/lib/phf/serialize.js` and a
 * dozen more relative paths, and 3114 tests across 435 fixtures hang off them.
 * Moving the app to a sibling directory, or hoisting `src/` a level, would
 * break every one of them. So the App Router lives at `frontend/src/app/`,
 * which Next resolves natively, and `frontend/src/lib/**` did not move a byte.
 *
 * ## Redirects
 *
 * Permanent (308), because these addresses have been shared and indexed. The
 * product decision behind them is #27: `/` is the feed now, so the converter —
 * which used to *be* `/` — moves to `/convert`, and the replayer becomes the
 * library.
 *
 * `/convert` itself was an alias for `/` in the old hand-rolled matcher, so a
 * link to `/convert` written any time in the past lands exactly where it always
 * did. That is the one alias that got *more* correct by moving.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  async redirects() {
    return [
      // The converter's old addresses. `/` is deliberately NOT in this list:
      // it is the feed now, and redirecting it would make the feed unreachable.
      { source: "/upload", destination: "/convert", permanent: true },
      { source: "/converter", destination: "/convert", permanent: true },

      // The replayer became the library.
      { source: "/replay", destination: "/library", permanent: true },
      { source: "/replayer", destination: "/library", permanent: true },
      { source: "/hands", destination: "/library", permanent: true },

      // Spellings of /stats the old ALIASES table carried.
      { source: "/statistics", destination: "/stats", permanent: true },
      { source: "/graph", destination: "/stats", permanent: true },
    ];
  },

  async headers() {
    return [
      {
        // Clickjacking: nothing on this site may be framed by another origin —
        // a framed /settings or /mod under a transparent overlay is a click
        // nobody meant to make. `frame-ancestors` is the standard; the legacy
        // header is for browsers that predate it.
        //
        // Except `/embed/*` (#52), which exists to be framed and holds nothing
        // but a replayer of a hand that is already public or link-shared.
        source: "/((?!embed/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        // The service worker must be re-checked on every load, or a deploy that
        // changes it waits for a cache to expire before any browser sees it.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
      {
        // Fonts are versioned in the filename (see `public/fonts/`), because
        // `public/` is copied verbatim and cannot be content-hashed.
        source: "/fonts/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;

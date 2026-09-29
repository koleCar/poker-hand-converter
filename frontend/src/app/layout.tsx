/**
 * The document, and the four things that have to be true before anything else
 * renders: the fonts, the cascade order, the theme attribute, and the session.
 *
 * ## The import order below is load-bearing. Do not sort it.
 *
 * It reproduces, exactly, the order the old `main.tsx` produced:
 *
 *     fonts.css      was the inline <style> in index.html, so it came first
 *     index.css      -> @imports tokens/{primitives,semantic,theme-light,motion}
 *     shell.css
 *     share.css
 *     auth.css
 *     styles/app.css -> @imports cards.css, replayer.css
 *
 * Three of those relationships are order-dependent rather than stylistic:
 *
 *  * `theme-light.css` uses `[data-theme="light"]`, the *same* specificity as
 *    the `:root` it overrides, so it only wins by arriving later. It is pulled
 *    in by `index.css` in the right order, which is why `index.css` is a single
 *    import here rather than four.
 *  * The token block sits in `@layer tokens` and everything else is unlayered,
 *    so component sheets beat tokens regardless — but only as long as nothing
 *    below adds a layer of its own.
 *  * `app.css` last, because its `.btn` / `.card` families are the base that
 *    `converter.css`, `stats.css` and the rest override.
 *
 * The remaining sheets — `overlay.css`, `converter.css`, `upload.css`,
 * `stats.css` — stay imported from the components that own them, so Next
 * code-splits them onto the routes that use them. They were the lazily-injected
 * chunk CSS under Vite too, so their cascade position is unchanged.
 *
 * Deliberately **not Tailwind**. These ~4400 lines carry the replayer's
 * container-query layout, which is genuinely hard CSS and was tuned against
 * real screenshots; rewriting it mid-migration is how the pixel behaviour gets
 * lost. New components use CSS Modules.
 */

import "../styles/fonts.css";
import "../index.css";
import "../styles/shell.css";
import "../styles/share.css";
import "../styles/auth.css";
import "../styles/app.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SessionImport } from "../components/auth/SessionImport";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { toAuthUser } from "../lib/auth/user";
import { en } from "../lib/i18n/en";
import { SITE_URL } from "../lib/routes";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { getServerUser } from "../lib/supabase/server";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: en.meta.home.title,
  description: en.meta.home.description,
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    siteName: en.brand.name,
    title: en.meta.home.title,
    description: en.meta.home.description,
    images: [{ url: "/og-default.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: en.meta.home.title,
    description: en.meta.home.description,
    images: ["/og-default.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f14",
};

/**
 * Resolve the theme and put it on `<html>` before the first stylesheet applies.
 *
 * Order of authority:
 *   1. an explicit choice the user made, persisted in localStorage
 *   2. the OS preference, if they have never chosen
 *   3. dark
 *
 * This used to run in `main.tsx`, *after* the CSS had already applied the dark
 * default, which cost a light-preference user a one-frame dark flash on every
 * load. That file's comment said "move it into the head at the Next.js
 * migration"; this is that. Blocking and inline in `<head>` is the only place
 * it works — anything deferred paints first and corrects afterwards, which is
 * the flash.
 *
 * Deliberately not React state: the value is read once per document and written
 * to an attribute the CSS owns, so putting it in a context would mean
 * re-rendering the tree to change a string on `<html>`.
 *
 * There is no UI for (1) yet — this is only the mechanism, so adding a toggle
 * later is `localStorage.setItem("rail.theme", next)` plus the same attribute
 * write.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("rail.theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","dark")}})()`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  /**
   * The session, resolved on the server with a signature-verifying `getUser()`.
   *
   * This is what removes the `status: "loading"` first paint: the provider is
   * told who the visitor is before React hydrates, so a returning user never
   * sees the sign-in dialog flash past. `undefined` when there is no database
   * at all, which keeps the provider's old behaviour for an offline build.
   */
  const initialUser = isSupabaseConfigured ? toAuthUser(await getServerUser()) : undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="preload"
          href="/fonts/inter-v4.1-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {/* Mounted once, for sixty days. See the file header — it has a
            deletion date on it. */}
        <SessionImport />
        {/* `#root` is kept deliberately. `index.css` sizes `html, body, #root`
            to 100% and `.app` / `.shell` are `min-height: 100%` against it, so
            without this element every full-height layout in the app would
            resolve its percentage against nothing and collapse. Renaming it is
            a CSS change, not a markup change. */}
        <div id="root">
          {/* AuthProvider wraps every route rather than sitting inside one: the
              session is the same on every screen, and re-subscribing to
              `onAuthStateChange` per navigation would drop and recreate the
              listener for no reason. */}
          <AuthProvider initialUser={initialUser}>{children}</AuthProvider>
        </div>
      </body>
    </html>
  );
}

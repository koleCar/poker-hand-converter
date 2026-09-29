/**
 * The two credentials, and the one boolean everything else branches on.
 *
 * Split out of the clients so that "is there a database?" can be answered by a
 * module with no `@supabase/ssr` import in it — the offline converter must not
 * pull a client library it will never construct.
 *
 * ## Why the names changed
 *
 * `VITE_SUPABASE_URL` → `NEXT_PUBLIC_SUPABASE_URL`, and the same for the anon
 * key. Vite inlined `import.meta.env.VITE_*`; Next inlines
 * `process.env.NEXT_PUBLIC_*`. Both must be written out **literally** — a
 * computed lookup like `process.env[name]` is not inlined and silently becomes
 * `undefined` in the browser bundle, which is why there is no helper here.
 *
 * **Vercel project settings must be updated before the first deploy**, in all
 * three environments. See the deployment runbook in the README.
 *
 * ## Why the anon key being public is fine
 *
 * The deployed bundle is public, so this key is public by construction — anyone
 * can read it out of the JavaScript and talk to PostgREST directly. Every RLS
 * policy in `supabase/migrations/` is written for exactly that caller. The
 * service-role key is a different matter and **does not appear in this app at
 * all**; see `lib/supabase/server.ts`.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * True when both Supabase env vars are present.
 *
 * The converter is a pure client-side function, so the app is fully usable
 * without a database: you can still convert files and download the output. Only
 * the library, the failure corpus and share links need this to be true, and the
 * UI is expected to say so plainly rather than fail at the first request.
 */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Shown by the UI when a database-backed feature is unavailable. */
export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  "Database is not connected. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
  "to enable saving, browsing and sharing hands. Conversion and download work without it.";

/**
 * Whether to offer the Google button.
 *
 * Defaults to on. The provider still has to be enabled in the Supabase
 * dashboard with a real client id and secret — until it is, pressing the button
 * produces an explanatory message rather than a dead end. Set
 * `NEXT_PUBLIC_AUTH_GOOGLE="off"` to hide it entirely.
 */
export const isGoogleAuthOffered =
  isSupabaseConfigured && process.env.NEXT_PUBLIC_AUTH_GOOGLE !== "off";

/**
 * Cloudflare Turnstile site key, or undefined when captcha is off.
 *
 * This has to agree with the project: Supabase → Authentication → Attack
 * Protection holds the matching **secret**, and once that is switched on GoTrue
 * refuses a sign-up, a password sign-in or a reset email that does not carry a
 * token. So the two are turned on together — a key here with protection off is
 * a widget that proves nothing, and protection on with no key here is a sign-in
 * form that can never succeed.
 *
 * Public by design, like the anon key: a Turnstile site key identifies the
 * widget, the secret stays in Supabase.
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined;

export const isCaptchaEnabled = isSupabaseConfigured && Boolean(TURNSTILE_SITE_KEY);

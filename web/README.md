# `web/` — the Rail web app

The Next.js 15 (App Router) site at **https://poker-hand-converter.vercel.app**:
the converter, the library and replayer, statistics, players, analysis, the
course, the forum, share links and the account pages. It reads and writes the
same Supabase data as the desktop app, so a hand synced by the app shows up
here and a file converted here shows up in the app.

This README is the map of the folder. The long-form reference for the web
app — the pipeline, the refusal principle, the corpus, bulk upload, live
arrival, the load-bearing rules, deployment — is
[`docs/WEB.md`](../docs/WEB.md); this file links into it rather than repeating
it.

---

## What runs where

```
                      browser tab                                  Supabase (EU)
 ┌───────────────────────────────────────────────────────┐   ┌─────────────────────┐
 │ /convert  ─ File handles ─▶ workers/convert.worker.ts │   │                     │
 │                              │ lib/wasm/engine.ts     │   │ Postgres + RLS      │
 │                              ▼                        │   │  hands, hand_stats, │
 │                 rail-core (WASM) or lib/parsers (TS)  │   │  report summaries,  │
 │                              │ PhfHand[]              │   │  forum, profiles …  │
 │                              ▼                        │   │                     │
 │      download as text ◀── preview / replayer          │   │ Auth (cookies)      │
 │                              │ opt-in save            │   │ Realtime            │
 │                              ▼                        │   │ Storage (opt-in     │
 │                 lib/db/* (anon key + user session) ───┼──▶│  original files)    │
 │ /library /stats /players /analysis  ◀─ RPCs under RLS─┼───│ Edge Functions      │
 └───────────────────────────────────────────────────────┘   └─────────────────────┘
         ▲  server renders (RSC) as the user or as anon:
         │  /, /f, /p, /u, /h, /learn, OG images, sitemap, feeds  (lib/server/*)
```

- **Parsing happens in the browser.** A dropped file is read, decoded,
  detected, parsed and serialized in a Web Worker; nothing leaves the tab
  unless the signed-in user saves. See
  [docs/WEB.md, "The converter makes no server requests"](../docs/WEB.md#the-converter-makes-no-server-requests).
- **Every query runs as the user.** There is no service-role key anywhere in
  this app. The browser and the server both talk to Supabase with the public
  anon key plus the reader's session cookie, and RLS decides what exists
  (`lib/supabase/server.ts` explains why that line does not move).
- **The server renders only what needs it**: the session cookie, and public
  pages that must be the same for everyone (forum, published hands, profiles,
  share links, course pages, Open Graph images). Public pages read as `anon`.
- **Without Supabase configured** the app is an offline converter: convert,
  preview, download and replay work; the library and sharing say they are
  unavailable.

---

## Routes

Everything under [`src/app/`](src/app/). `src/lib/routes.ts` (`paths`) is the
typed list of addresses the code links to; every top-level segment is also a
reserved username (see the comment on `paths.profile`).

### Converting and your hands

| Route | What it is |
| --- | --- |
| `/convert` | The converter: drop files, a folder or a zip, or paste text. Conversion in `workers/convert.worker.ts`; optional save to the library while converting; refused hands listed with their reason. [WEB.md: bulk upload](../docs/WEB.md#bulk-upload-r42). |
| `/convert/manual` | Manual hand entry: build a hand action by action (`lib/manual/`). Kept in `localStorage` until finished; leaves the tab only on an explicit save. |
| `/library` | The shared Hands screen (`@rail/ui/hands`) over `lib/db/handsSource.ts`, with the replayer beside the list. Not indexed. |
| `/stats` | The shared Reports screen (`@rail/ui/reports`) over `lib/db/reportSource.ts`, plus the web's own tiles, sessions and opponents panels (`components/stats/StatsTab.tsx`). |
| `/players` | The shared Players screen (`@rail/ui/players`) over `lib/db/playersSource.ts`. Pro feature `reports_full`. |
| `/h/[slug]` | A share link: a capability URL to one hand, server-rendered with Open Graph tags, `noindex`; names hidden unless the owner turned them on. [WEB.md: share links](../docs/WEB.md#share-links-and-names-r45). |
| `/embed/h/[slug]` | The same share as a bare replayer for an `<iframe>`; never indexed. |

### Analysis (`/analysis/*`)

All private and not indexed (one account's rows behind RLS), except the two
public study pages. Gated by the Pro feature `analysis` (see
[Plans](#plans-and-the-pro-lock)). Specified in
[`docs/ANALYSIS-PLAN.md`](../docs/ANALYSIS-PLAN.md).

| Route | What it is |
| --- | --- |
| `/analysis` | Every hero decision with its facts and grades; the "three biggest leaks" card. |
| `/analysis/h/[handId]` | One hand in the replayer with the Analysis sheet. |
| `/analysis/session` | Session review (R5.1): the shared `@rail/ui/review` screen over `lib/db/sessionReview.ts`. |
| `/analysis/leaks` | Leaks: the spots that cost the most EV, ranked. |
| `/analysis/reports` | Your frequencies against the reference. |
| `/analysis/progress` | Score and EV lost over time. |
| `/analysis/train` | The trainer: preflop and river spots, drills of your own mistakes (`workers/training.worker.ts`). |
| `/analysis/plan` | The study plan: this week's focus from the leaks, with a checklist. |
| `/analysis/my-charts` | Your own preflop charts (R5.3): the shared `@rail/ui/charts` screen over `lib/db/preflopCharts.ts`. |
| `/analysis/charts` | **Public, indexable.** Rail's preflop chart browser ([`docs/CHARTS.md`](../docs/CHARTS.md)). |
| `/analysis/learn`, `/analysis/learn/[concept]` | **Public, indexable.** The concept library. |

### Learn (`/learn/*`)

The course ([`docs/LEARN-PLAN.md`](../docs/LEARN-PLAN.md)). Pages render the
catalogue on the server and read no account there; progress is read in the
browser, from the account when signed in and from browser storage otherwise.

| Route | What it is |
| --- | --- |
| `/learn` | The course map, the "how Rail teaches" panel and the reference pages. Public. |
| `/learn/[lesson]` | One lesson: sections, checkpoints, practice graded by Rail's engine. Public. |
| `/learn/placement` | The placement test: a module passed marks its lessons "tested out". Not indexed. |
| `/learn/review` | The review queue of missed quiz items (spaced repetition) and the daily dose. Not indexed. |
| `/learn/reference/[page]` | One reference page; `/learn/reference` itself redirects to the course map. |

### Community

| Route | What it is |
| --- | --- |
| `/` | The forum: every board's threads (server-rendered as `anon`). RSS at `/feed.xml`. |
| `/f` | Redirects to `/`. |
| `/f/[board]` | One board's threads; RSS at `/f/[board]/feed.xml`. |
| `/f/[board]/[publicId]/[[...slug]]` | A thread. The id is the key; a stale board or slug redirects (308) to the canonical address. |
| `/submit` | New post; `?hand=<published id>` attaches one of your published hands. |
| `/p/[publicId]` | A published hand: a scrubbed copy its owner chose to make public. Unlike `/h/`, indexable. |
| `/embed/p/[publicId]` | A published hand as a bare replayer for an `<iframe>`. |
| `/u/[username]` | A public profile from the `profiles_public` view; an old name redirects to the current one for a year. |
| `/search` | Full-text search over the forum (`?q=`). Not indexed. |
| `/saved` | Your bookmarked posts (`my_saved_posts`). |
| `/notifications` | Your notifications (`my_notifications`). |
| `/mod` | The moderation queue; every action is gated per caller by the RPCs (`lib/db/moderation.ts`). |
| `/takedown` | How a room or a player asks for a hand to be taken down (the `hh-takedown` report reason and the mod queue). |

### Account, billing and legal

| Route | What it is |
| --- | --- |
| `/settings` | Language, username, posting, the Plan panel (`#plan`), password, "Your data" (export) and account deletion. Client-rendered; not indexed. |
| `/billing/success`, `/billing/cancel` | Where Stripe Checkout returns. They grant nothing — the webhook does — and the success page waits for the plan to show it. |
| `/terms`, `/privacy` | The drafts in `docs/legal/`, copied into `src/lib/legal/texts.generated.ts` by `scripts/legal-docs.mjs`. |
| `/auth/callback` | Route handler: every sign-in returns here; exchanges `?code=` for a cookie session; `?next=` must be in a fixed allow-list (`lib/auth/nextPath.ts`). |
| `/auth/desktop` | Signs the desktop app in through this browser (R1.7). See [Auth](#auth). |

### Machine-facing

| Route | What it is |
| --- | --- |
| `/api/oembed` | oEmbed for this site's own `/p/` and `/h/` links only; never fetches the given URL. |
| `/api/stats/rebuild` | Derives statistics for the caller's hands that have none at the current `stats_version`, next to the database, **as the user** (security-invoker RPCs, RLS). |
| `/og/p/[publicId]`, `/og/post/[publicId]` | Open Graph images for a published hand and a forum thread. |
| `/icons/[size]` | The manifest's PNG icons (192, 512). |
| `apple-icon.tsx`, `manifest.ts`, `sitemap.ts`, `robots.ts` | Touch icon, PWA manifest (opens on the converter), `/sitemap.xml` (public, stable pages only), `/robots.txt` (`/h/` and the private screens disallowed). |
| `/sites.json` | Not a route: `scripts/sites-json.mjs` copies `config/sites.json` to `public/sites.json` before every dev and build; the desktop app downloads it to keep its HUD room policy current (stricter only). |

Old addresses redirect permanently in `next.config.ts`: `/upload`,
`/converter` → `/convert`; `/replay`, `/replayer`, `/hands` → `/library`;
`/statistics`, `/graph` → `/stats`.

`public/sw.js` is a service worker that keeps the converter working with no
network (static assets cache-first, pages network-first, `/convert` precached).

---

## Key modules (`src/`)

| Path | What it does |
| --- | --- |
| `middleware.ts` | One job: refresh the Supabase session cookie before every render (`lib/supabase/middleware.ts`). Static assets are excluded. |
| `lib/supabase/` | The only modules that construct a Supabase client: `config.ts` (the two public env vars and `isSupabaseConfigured`), `browser.ts` (cookie sessions, PKCE, `detectSessionInUrl: false`), `server.ts` (as the user, or as `anon` for shared renders; never the service role), `middleware.ts`. |
| `lib/db/` | Browser-side data layer. `client.ts` is the only importer of supabase-js (`rpc()`, the not-configured branch, plan refusals); one file per area (`hands.ts`, `shares.ts`, `stats*.ts`, `analysis*.ts`, `forum.ts`, `learn.ts`, `entitlements.ts`, `accountData.ts` …); the shared screens' sources (`handsSource.ts`, `reportSource.ts`, `playersSource.ts`, `sessionReview.ts`, `preflopCharts.ts`, `dataSource.ts`). Server code must not import it. |
| `lib/server/` | `server-only` readers for server renders: shares, published hands, profiles, the forum, shared analyses. |
| `lib/phf/` | The hand format: `types.ts` (re-exports the types generated from the Rust model), `validate.ts`, `serialize.ts`, `detect.ts`. Spec: [`docs/PHF-SPEC.md`](../docs/PHF-SPEC.md). |
| `lib/parsers/` | The 19 TypeScript parsers and their registry: the fallback engine and CI's oracle for the Rust core. |
| `lib/wasm/` | `rail-core/` (the committed WebAssembly build — CI's Linux build, never a local one), `core.ts` (loader), `engine.ts` (picks `wasm` or `typescript` once per page or worker). [WEB.md: the WASM core](../docs/WEB.md#the-conversion-core-is-webassembly-r41). |
| `workers/` | `convert.worker.ts` (conversion and bulk upload), `analysis.worker.ts` (analysis rebuilds and river/turn study solves), `training.worker.ts` (dealing and grading trainer spots). |
| `lib/stats/`, `lib/equity/` | The statistics engine (`stats/2`; displayed statistics from `definitions.json`, a copy of `config/stats/standard.json`) and all-in EV. Spec: [`docs/STATS-SPEC.md`](../docs/STATS-SPEC.md). |
| `lib/analysis/`, `lib/solver/`, `lib/charts/`, `lib/training/` | Hand analysis, the postflop solver, the preflop chart library, the trainer's jobs. |
| `lib/learn/` | The course: catalogue, lessons, practice generators, mastery and review scheduling. |
| `lib/replay.ts`, `lib/cards.ts`, `lib/format.ts` | PHF → replay frames; cards; number formatting. |
| `lib/auth/` | `AuthProvider`, `session.ts` (auth calls with user-facing errors), `nextPath.ts` (the redirect allow-list), `desktop.ts` (the desktop sign-in handoff). |
| `lib/entitlements/` | `EntitlementsProvider` (reads `my_entitlements()` once), `planRefusal.ts` (routes every `PT402` refusal to one upgrade prompt). |
| `lib/live/` | Pure rules for live updates: `arrivals.ts` (when a `hand_arrivals` signal becomes a refetch), `activity.ts` (upload progress across tabs). The sockets are in `components/live/`. |
| `lib/i18n/` | `en.ts`, `hr.ts`, namespaces in `ns/`; `server.ts` picks the request's locale (the `rail.locale` cookie, else `Accept-Language`, else English); `ui.ts` cuts the shared package's `UiStrings` from these dictionaries. |
| `lib/account/` | The data export (a ZIP built in the browser) and the account deletion loop. |
| `lib/billing/checkout.ts` | Calls the `billing-checkout` / `billing-portal` Edge Functions as the user; holds no secret. |
| `components/` | The web's own screens and pieces: `converter/`, `library/`, `stats/`, `players/`, `analysis/`, `learn/`, `forum/`, `share/`, `shell/` (`AppShell`, `AppFrame`, `ServerFrame`), `plan/`, `account/`, `live/`, `auth/` … |
| `styles/` | The web's global CSS, imported in a pinned order from `app/layout.tsx`. New components use CSS Modules. |

The shared screens (Hands, Reports, Players, session review, charts, the
replayer, stat tiles) live in [`packages/ui`](../packages/ui/); the web
implements their `*Source` interfaces over Supabase. See
[`packages/ui/README.md`](../packages/ui/README.md).

---

## Auth

- **Cookie sessions** through `@supabase/ssr`. Email and password; Google when
  configured (`NEXT_PUBLIC_AUTH_GOOGLE=off` hides the button); Cloudflare
  Turnstile when its site key is set.
- **`getUser()`, never `getSession()`, on the server.** `getSession()` does not
  verify the JWT signature. `lib/db/client.ts` uses `getSession()` and is
  therefore browser-only.
- **One return address.** Every sign-in (Google, confirmation mail, password
  reset) lands on `/auth/callback`, which exchanges the code server-side. A
  failed exchange goes to `/?auth=failed`. `?next=` is one of a fixed set of
  relative paths or `/`.
- **The desktop app** opens `/auth/desktop?v=1&pub=..&state=..&t=..` in the
  system browser. The page moves the values into `sessionStorage`, has the
  user sign in if needed, asks for confirmation, calls the Edge Function
  `desktop-handoff` with the user's own token, and redirects to
  `rail://auth/callback` with a one-time token encrypted to the app's key.
  Threat model: [`docs/DATABASE.md`](../docs/DATABASE.md), "Desktop sign-in".
- **A guest is simply signed out.** Converting and replaying work; nothing is
  stored. The converter keeps a finished run (up to 20 000 hands) and offers
  to save it after sign-in.

## Plans and the Pro lock

The database is the gate. `my_entitlements()` (migration
`20270908090000_entitlements.sql`) says what the account may use; every
gated function calls `require_entitlement` and refuses a Free account with
SQLSTATE `PT402` (HTTP 402) once `billing_settings.enforcement_enabled` is
on. **Today it is off, so every account is effectively Pro and nothing
renders locked.**

The UI only says it first: `components/plan/ProLock.tsx` replaces a screen
when `useEntitlements().locked(feature)` is true. Features
(`lib/db/entitlements.ts`): `desktop_sync`, `hud`, `reports_full` (the
situation breakdowns, sessions, opponents and `/players`), `analysis` (the
private `/analysis` screens), `learn` (recording lesson results and review
cards), plus the Free hand cap (`plan_limits`: 10 000 stored hands for Free,
unlimited for Pro). Basic statistics — the report, graph and chips — are not
gated. Stripe setup: [`docs/BILLING.md`](../docs/BILLING.md).

## Live updates

Signed in, the library's screens follow the account through Supabase
Realtime: the per-account `hand_arrivals` row (the desktop app or another
tab saved hands) and presence on the private `activity:<uid>` channel (an
upload running in another tab or device). `/library` and `/stats` refresh by
themselves; the analysis screens offer "new hands arrived — refresh". No
hand content travels this way.
Details: [WEB.md, "Live progress and arrival"](../docs/WEB.md#live-progress-and-arrival-r110-r43).

---

## Build, run, test

```bash
cd web
npm install                  # also links @rail/ui from ../packages/ui
cp .env.example .env.local   # optional; without it the app is an offline converter
npm run dev                  # http://localhost:3000 (Turbopack); dev:webpack is the fallback
npm run build && npm start   # production build
npm run lint                 # ESLint (framework-free lib, i18n rule, …)
npm run lint:css             # stylelint: no primitive tokens, no raw hex
npm run typecheck            # tsc --noEmit (CI runs `npx tsc -b`)
```

`dev` and `build` first run `scripts/sites-json.mjs` (publishes
`config/sites.json` as `/sites.json`; refuses a file that is not JSON v1) and
`scripts/legal-docs.mjs` (regenerates the legal texts module). After editing
`docs/legal/`, run one of them before committing, or the `legalPages` test
fails. `scripts/contrast-sweep.js` is a WCAG contrast check to paste into the
browser console; it is not in CI.

Environment variables (`.env.example`; set in Vercel for all three
environments):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The project and its public anon key. Unset: offline converter. |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for absolute URLs and the OAuth redirect; defaults to the current `*.vercel.app` host. |
| `NEXT_PUBLIC_AUTH_GOOGLE` | `off` hides "Continue with Google". |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile; must match the secret configured in Supabase Auth. |

The web has no test runner of its own. Its libraries are tested from
[`tests/`](../tests/) (Vitest over the real corpus, `npm test` there), which
imports `web/src/lib/**` directly — which is why that layer may not import
the framework. CI job **"Lint, typecheck, build"** runs lint, `lint:css`,
`tsc -b` and `npm run build` here; the parity, WASM and share-names checks
run from `tests/`.

---

## Rules that bind this folder

Each has a lint rule or test behind it; reasons in
[WEB.md, "Rules that are load-bearing"](../docs/WEB.md#rules-that-are-load-bearing).

- **Refuse when unsure.** A hand that cannot be converted faithfully is
  refused with a reason and shown to the user, never approximated.
  [WEB.md, "The refusal principle"](../docs/WEB.md#the-refusal-principle).
- **Hand histories never leave the tab** on `/convert` and
  `/convert/manual` unless the signed-in user saves. Original files are
  uploaded only with "Also keep the original files" ticked.
- **The pure layer is framework-free.** Nothing under
  `src/lib/{phf,parsers,replay,cards,format,stats}` imports `next/*`,
  `server-only` or reads `process.env`.
- **No service-role key, ever.** Server code is a typed wrapper around an RPC
  run as the user.
- **User-facing strings go through `lib/i18n/`** (enforced on `src/app/**`).
- **CSS Modules and design tokens**; the global CSS import order in
  `app/layout.tsx` is load-bearing — do not sort it.
- **Displayed statistics are data** (`config/stats/`), never a formula in a
  component.
- **The committed WASM build is CI's.** After a core change run
  `npm run wasm:web-from-ci` in `tests/` and commit
  `src/lib/wasm/rail-core/`.
- **Money is integer minor units**, as in PHF.

## Deployment

Vercel, root directory `web`, framework pinned in `vercel.json` (which also
disables deployments from `staging`). The build needs `../packages/ui`, so
"Include files outside the root directory in the Build Step" must stay on.
Production deploys from `main`. Runbook:
[WEB.md, "Deployment (Vercel)"](../docs/WEB.md#deployment-vercel).

## Further reading

| Question | Document |
| --- | --- |
| How the web app works in depth | [`docs/WEB.md`](../docs/WEB.md) |
| Schema, RLS, migrations | [`docs/DATABASE.md`](../docs/DATABASE.md), [`supabase/`](../supabase/) |
| The hand format and writing a parser | [`docs/PHF-SPEC.md`](../docs/PHF-SPEC.md) |
| What each statistic means | [`docs/STATS-SPEC.md`](../docs/STATS-SPEC.md) |
| Analysis, the course, the charts | [`docs/ANALYSIS-PLAN.md`](../docs/ANALYSIS-PLAN.md), [`docs/LEARN-PLAN.md`](../docs/LEARN-PLAN.md), [`docs/CHARTS.md`](../docs/CHARTS.md) |
| Paid plans and Stripe | [`docs/BILLING.md`](../docs/BILLING.md) |
| The plan and its steps (R-numbers) | [`docs/RAIL-PLAN.md`](../docs/RAIL-PLAN.md) |

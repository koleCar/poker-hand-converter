# PokerConverter

A browser-based converter and replayer for poker hand histories.

Drop an export from almost any poker room into it and you get back one
canonical representation of every hand — which you can then download as
tracker-importable text, step through in a visual replayer, keep in a
searchable library, or hand to someone else as a link.

The conversion runs entirely in the browser — hand histories never leave the
tab. The data store is Supabase (Postgres + PostgREST), and every query the app
makes runs **as the signed-in user**, policed by RLS; there is no service-role
key in the app and no privileged middle tier. Next.js renders on the server for
the two things that need it: the session cookie, and the Open Graph tags on a
shared hand.

Converting, previewing, downloading and replaying need no account at all. An
account is what gives you a *library*: hands you save belong to you and nobody
else can read them. The one deliberate exception is a share link — anyone you
send one to can replay that hand without signing in.

Live: **https://poker-hand-converter.vercel.app**

---

## The pipeline

There is one idea underneath the whole project: **PHF**, the Poker Hand Format
(`phf/1`). It is a typed JSON document that describes a hand completely —
money as integer minor units, an authoritative action stream, run-it-twice as
an array rather than a special case, and mandatory provenance saying which
parser produced it from which bytes.

Everything else is a conversion into or out of that one shape:

```
raw text / XML
      │
      ├─ detectSite(text)             → ranked parser candidates, scored 0..1
      ├─ parser.splitHands(text)      → one chunk per hand
      ├─ parser.parseHand(chunk)      → PhfHand
      ├─ assignPositions(hand)        → BTN/SB/BB/… from the posted blinds
      ├─ validateHand(hand)           → errors (refuse) / warnings (keep, flag)
      │
      ├─ toStandardText(hand)         → GG-style text, for tracker import
      ├─ buildReplay(hand)            → frames, for the replayer
      ├─ handInsertFromPhf(hand)      → a `hands` row, for the library
      └─ ConversionFailure[]          → the corpus of what we could not read
```

The GG-style plain text this app produces is **one output of PHF, not the
source of truth**. It exists for exactly one reason: Holdem Manager and
PokerTracker import that shape, and their importers are byte-sensitive. So the
serializer preserves things no structured field should have to model —
decimal style, digit grouping, which fee columns the summary printed, an
incidental triple space in a GG tournament header — and a round-trip test
asserts `toStandardText(parseStandardText(t)) === t` over the whole corpus.

Full specification, including the type system and the invariants the validator
enforces: **[`docs/PHF-SPEC.md`](docs/PHF-SPEC.md)**.

---

## The refusal principle

This is the design decision that shaped everything else, so it is worth
stating plainly rather than listing as a feature.

**A hand that cannot be converted faithfully is refused.** It is not
approximated, not guessed at, not silently dropped. It is recorded — with its
original text, the site we thought wrote it, how confident we were, which
pipeline stage gave up and why — in the `unparsed_hands` corpus, and the user
is told it was refused.

The reason is that the failure modes here are not symmetrical. A hand that
fails to convert is a visible, recoverable annoyance: the user sees it, and the
raw text is still on disk. A hand that converts *wrongly* — a raise sized off
the wrong number, a pot that balances because a rounding error cancelled
itself, a play-money table counted into a real-money win rate — gets imported
into a tracker and quietly poisons a player's statistics. They will not notice.
They will make decisions on it for months. There is no way back, because the
tracker's database no longer distinguishes the bad rows from the good ones.

So the bias runs one way: **refuse when unsure**. Concretely, that means

- every parser throws `ParseSkip(reason, message)` for a format it recognises
  but is not certain it can represent — unsupported variants, corrupt sources,
  ambiguous amounts, all-in-or-fold tables, cancelled hands;
- `parseAmountStrict` refuses `1 234,50 €` rather than guessing at the
  separators, because the wrong guess is off by 100x and still balances;
- any line a parser does not understand becomes a recorded warning, never a
  silent drop, and the corpus tests fail the build if a site a parser claims to
  understand produces warnings;
- `validateHand` treats a chip-conservation or payout mismatch as an *error*,
  which means the hand is never stored as a normal hand.

Several parsers deliberately refuse formats they could plausibly have handled.
The GGPoker parser carries a `FOREIGN_BRANDING` guard that rejects WPT Global
files even though they look close enough to try, because "close enough" is how
you get wrong bet sizing. That rejection is the correct behaviour, not a gap.

High-low split is the clearest case of all. An `Omaha Hi/Lo` hand read as plain
Omaha *balances perfectly* - the summary states who collected what, so chip
conservation, payout conservation and every other invariant in `validateHand`
pass. There is no downstream check that would ever catch it, and half of every
pot would be attributed to the wrong rule. So it is refused by name,
`unsupported-hi-lo`, rather than left to look like a hand we understood.

The corpus is the other half of the deal. A refusal is not a dead end — it is
a work item with a reproduction attached. `unparsed_gaps` rolls the corpus up
by site, stage and reason, ordered by how often each one is hit, and the top
row is the answer to "which parser do we write next".

---

## Coverage

**19 registered parsers** (`frontend/src/lib/parsers/`), covering rather more
than 19 rooms — the Ignition parser also handles Bodog and Bovada, the Chico
parser handles its skins, and ACR/WPN covers the network:

| Shape | Parsers |
| --- | --- |
| PokerStars-family text | PokerStars, GGPoker, WePlay, CoinPoker |
| `***** Hand History for Game *****` text | partypoker, 888poker, PokerBros |
| XML | iPoker, MicroGaming |
| Its own dialect | Winamax, ACR/WPN, Ignition (also Bodog and Bovada), Chico (BetOnline, PayNoRake, ActionPoker, Gear Poker), Full Tilt, Ongame, Entraction, Unibet, Run It Once |
| Our own output | `standard` — the GG-style text this app emits, so its own exports round-trip |

"PokerStars-family in shape" is not the same as "safe to parse with a
PokerStars regex", which is why Full Tilt sits in the last row despite looking
like a member: `Uncalled bet **of** $20`, action lines with no colon, the
button declared after the blinds, and two incompatible header word orders.
Each of those is a way to produce a hand that balances against itself and is
still wrong.

### Variants

Each parser carries its own variant allowlist
(`frontend/src/lib/parsers/shared/variant-lock.ts`), and a variant goes on a
room's list only once that room's own fixtures convert it cleanly. Reading a
room's Hold'em says nothing about whether it reads that room's Omaha.

| Reads | Parsers |
| --- | --- |
| Hold'em, four- and five-card Omaha | GGPoker, Entraction |
| Hold'em and four-card Omaha | PokerStars, partypoker, 888poker, iPoker, MicroGaming, Winamax, ACR/WPN, Ignition, Chico, Full Tilt, Ongame, Unibet |
| Hold'em only | WePlay, CoinPoker, PokerBros, Run It Once |

Every room refuses Hi/Lo (`unsupported-hi-lo`), short deck, stud, razz and
draw games. Two of the Omaha rows come with caveats:

- **Chico** labels its four-card hands `Hold'em Pot Limit`, so the variant is
  taken from the number of cards dealt. Only 4 of the 17 hands in its one Omaha
  file convert. The other 13 are refused because the network's own pot
  accounting doesn't add up: a printed `Rake 0.00` on hands that were raked, or
  side pots missing from the summary. Their variant has nothing to do with it.
- **Run It Once** has one Omaha file, and it is refused. It is a
  splash-the-pot side-pot hand whose `collected` lines count the promotional
  money twice. Nothing in the file says which pot the money really went to.

Which formats can share a parser, and why the "everything is a PokerStars
clone" intuition is wrong, is worked through in
[`docs/research/FORMAT-MATRIX.md`](docs/research/FORMAT-MATRIX.md). What to
build next and what each one costs is in
[`docs/research/COVERAGE-PLAN.md`](docs/research/COVERAGE-PLAN.md). Per-room
detail lives in the 22 documents under `docs/research/hh-formats/`.

### The corpus

**413 real hand-history files across 22 site directories**, in
`fixtures/samples/`. **There are no synthetic fixtures.** Every file is a real
export or a real data-mined sample, and each site directory carries a
`SOURCES.md` recording where its files came from and what is verified about
them. Two directories are deliberately special: `wpt-global/` is empty and its
`SOURCES.md` explains that no sample can exist, because the room removed
hand-history export in June 2026; `phh/` holds the PHH interchange spec rather
than a room.

Alongside that sit the two original corpora the project started from —
`weplay-hh/` (104 real WePlay exports, across two account folders) and
`gg-hh/` (10 reference files in the GG format, used as the byte-exactness
target for what the serializer must produce) — plus
`tests/test/fixtures/`, which holds regression cases that each exist because
a specific real hand broke something.

A caveat worth knowing before trusting a row in the matrix: the corpus is
cash-heavy and era-skewed. Only a few rooms have verified tournament samples,
and the legacy-network files are roughly 2012–2015, so partypoker and 888 are
verified *for that era*.

### `.gitattributes` — do not "tidy" this

```
fixtures/** -text -diff
gg-hh/** -text -diff
weplay-hh/** -text -diff
tests/test/fixtures/** -text -diff
```

Real exports ship with CRLF, bare CR, UTF-16LE and Windows-1252 bytes, and the
parsers exist precisely to survive that. Git's autocrlf normalisation (at least
one machine here has `core.autocrlf=input`) rewrites CRLF to LF *on commit*,
which silently turns a CRLF test case into an LF one while the working tree
still looks correct. Marking the fixture trees binary means the stored blob is
the original bytes. Removing these lines will corrupt the evidence the
byte-exactness tests depend on, and it will not be obvious that it happened.

Encoding is handled as a corpus-wide property rather than a per-site quirk: 22
of the 413 files are not UTF-8, and you cannot tell which from the site, the
era or a `0x80` sniff. See `FORMAT-MATRIX.md` §5 for why the only correct test
is "attempt a strict UTF-8 decode, then check for a BOM, then try
Windows-1252".

---

## The app

**Next.js 15, App Router**, in `frontend/src/app/`. The hand-rolled matcher that
used to live in `frontend/src/routes/` is gone — Next's file-system router
matches and `next.config.ts` redirects, and keeping a second answer to "what
does this path mean" alongside the framework's is how the two drift apart.

| Route | What it is |
| --- | --- |
| `/` | **The feed.** Placeholder for now: it says so, and points at the two things that work. This is where the product is going, which is why the converter had to move off it. |
| `/convert` | **Converter.** Drop files, a folder, a zip, or paste text. Detection and conversion run in a Web Worker and start immediately — the intent of dropping a hand history on a hand-history converter is not ambiguous, and there is a cancel button. Converted hands are saved to the library (toggleable), refused hands go to the corpus, and the output is downloadable per file or combined. **This route makes zero server requests**; see below. |
| `/library` | **Library and replayer.** Pick a hand from your library with filters, or upload/paste a single one. Animated table: pot per street, bets in front of each seat, all-in state, dealer button, run-it-twice boards, final pot distribution. Play/pause, step, scrub, jump to a street, 0.5×–4× speed, reveal all known cards. Keyboard: `←`/`→` step, `space` play/pause, `Home`/`End`. |
| `/stats` | **Statistics.** VPIP, PFR, 3-bet, c-bets and a showdown / non-showdown win-rate graph over your library. Renders and explains itself when signed out rather than bouncing you somewhere else. |
| `/h/:slug` | **A shared hand.** A capability URL to one hand, server-rendered, with real per-request Open Graph tags from `generateMetadata`. `noindex, follow` — a capability URL in a search index is a contradiction. |
| `/auth/callback` | The one address every sign-in returns to. Exchanges `?code=` for a cookie session; `?next=` is validated against a fixed allow-list of relative paths. |

Permanent (308) redirects, in `next.config.ts`, for every address these screens
used to have: `/upload` and `/converter` → `/convert`; `/replay`, `/replayer`
and `/hands` → `/library`; `/statistics` and `/graph` → `/stats`. `/` is
deliberately not redirected — it is the feed now.

### The converter makes no server requests

A file dropped on `/convert` is read, decoded, detected, parsed and serialized
entirely in the tab, and handed back as a `Blob` download. **Hand histories
never leave the browser.** The only traffic the page can generate is the app's
own JavaScript and an explicit, opt-in save to your own library when you are
signed in.

That is a promise the code has to keep, so it is written down three times: as a
standing comment in `frontend/src/app/convert/page.tsx`, as a line of UI copy on
the page itself (so a change that breaks it also makes the app tell a visible
lie), and here. It is verified by driving the real page with a browser and
asserting that no request leaves the origin.

The table, cards and chips are generated as CSS and SVG inside the app. No
image assets, so nothing to license, nothing to load at runtime, and it stays
sharp at any resolution.

**Without a database** the app still converts, previews, downloads and replays
an uploaded hand. The library and sharing are disabled and the UI says so
explicitly rather than failing silently.

---

## Running it

```bash
cd frontend
npm install
cp .env.example .env.local   # then fill in the Supabase URL and anon key
npm run dev
```

Default: `http://localhost:3000`.

`npm run dev` uses Turbopack. It is verified — including that it handles the
`new Worker(new URL(…, import.meta.url))` in `conversionClient.ts`, which was
the one genuine unknown of the migration — and the full 7.9 MB corpus converts
to byte-identical output under it. `npm run dev:webpack` is the escape hatch if
that ever stops being true.

`.env.local` is optional — see the paragraph above for what you lose without
it.

## Tests

```bash
cd tests
npm test
```

**3188 tests across 29 files.** `tests/` is a test harness with no runtime of
its own — it exercises the frontend libraries directly against the real corpus.
Nothing is asserted against a hand somebody made up.

What they actually check, per hand, over every sample file:

- **Detection** — the right parser ranks first for every file in the corpus.
- **No unknown lines** — a hand a parser claims to understand parses with
  `meta.warnings === []`, so an unhandled line shape fails the build rather
  than reaching a user.
- **Validation** — every emitted hand satisfies the PHF invariants; every
  refused hand carries a machine-readable reason.
- **Round trip** — `parseStandardText(toStandardText(h))` is semantically equal
  to `h`.
- **Byte compatibility** — the re-serialized text is byte-identical to the
  source, which is what tracker import depends on.
- **Positions** — resolved positions are cross-checked against the rooms' own
  `(button)` / `(small blind)` summary labels, at every table size from
  heads-up to nine-handed.
- **Replay** — no stack goes negative at any point, and the whole pot is
  awarded in the final frame.

## Adding a poker room

1. Write `frontend/src/lib/parsers/<site>.ts` exporting a `SiteParser`.
2. Add one `registerParser` call in `frontend/src/lib/parsers/index.ts`.
3. Put real sample files in `fixtures/samples/<site>/` with a `SOURCES.md`, and
   add the site to `tests/test/support/corpus.ts` so the table-driven tests
   pick it up.

Nothing else changes: detection, validation, failure recording, the text
serializer, the replayer and the database layer all work off `PhfHand`.

The contract, an annotated skeleton, the two strategies for building a hand
(normalise-to-standard-text vs. build-the-object-directly), and the six tests a
new parser must come with are in
[`docs/PHF-SPEC.md` §8](docs/PHF-SPEC.md). Read §1 and §2 first — the money
rules are where a new parser is most likely to go quietly wrong.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `frontend/src/lib/phf/` | The format: `types.ts`, `validate.ts`, `serialize.ts`, `detect.ts` |
| `frontend/src/lib/parsers/` | One file per poker room, plus `shared/` helpers and the registry |
| `frontend/src/lib/db/` | Supabase client layer — save, search, corpus, shares, anonymization |
| `frontend/src/lib/replay.ts` | PHF → replay frames |
| `frontend/src/lib/supabase/` | `config`, `browser`, `server`, `middleware` — the only modules that construct a Supabase client |
| `frontend/src/lib/server/` | Server-only readers. `server-only` imported, never reachable from the browser bundle |
| `frontend/src/lib/i18n/` | `en.ts`. Every user-facing string on the App Router surfaces |
| `frontend/src/lib/routes.ts` | `paths` and `sharedHandUrl`. What survived the old route table |
| `frontend/src/app/` | The App Router: pages, layout, `sitemap.ts`, `robots.ts`, `auth/callback` |
| `frontend/src/components/` | `converter/`, `replayer/`, `share/`, `shell/`, `stats/`, `auth/` |
| `frontend/src/styles/` | ~4400 lines of global CSS, plus the token layer. New components use CSS Modules |
| `frontend/src/workers/` | Conversion off the main thread |
| `tests/` | Test harness only — no runtime backend |
| `supabase/migrations/` | Schema |
| `fixtures/samples/` | The real hand-history corpus, one directory per site |
| `gg-hh/`, `weplay-hh/` | The original reference and source corpora the project started from |
| `docs/` | `PHF-SPEC.md`, `DATABASE.md`, and `research/` |

---

## Rules that are load-bearing

Three conventions here are not style preferences. Each one has a lint rule
behind it, and each one was written down because breaking it is cheap, silent,
and expensive to undo.

### 1. The pure-TypeScript layer may not import the framework

**Nothing under `frontend/src/lib/{phf,parsers,replay,cards,format,stats}` may
import `next/*`, `server-only`, or read `process.env`.**

`tests/test/*.ts` imports those modules directly, by relative path —
`../../frontend/src/lib/phf/serialize.js` and a dozen more — under plain Node
with no bundler and no framework. **3114 tests across 435 fixtures hang off
that.** A single framework import anywhere in that subtree breaks all of them at
once, and the failure reads as an unrelated module-resolution error rather than
as "somebody put a Next import in the parser layer".

It is also why **the Vercel root directory stays `frontend`** and why
`frontend/src/lib/**` did not move when the App Router arrived. The App Router
lives at `frontend/src/app/`, which Next resolves natively, precisely so that
`lib/` could stay exactly where the test harness expects it.

Anything Next-shaped goes in `lib/supabase/`, `lib/server/` or `app/`.
`lib/routes.ts` and `lib/i18n/` are deliberately outside the rule: they are app
configuration, not corpus code, and nothing in `tests/test` imports them.

Enforced by `no-restricted-imports` and `no-restricted-properties` in
`frontend/eslint.config.js`, scoped to exactly those paths.

### 2. The CSS is an asset, not debt

~4400 lines of global CSS, imported in a **pinned order** from
`frontend/src/app/layout.tsx`. That order is load-bearing and is documented in
the file: `theme-light.css` overrides `:root` at the same specificity and only
wins by arriving later, and `styles/app.css` has to come last because its
`.btn` / `.card` families are the base the component sheets override. Sheets
that belong to one screen (`converter.css`, `stats.css`, `upload.css`,
`overlay.css`) stay imported from their components so Next code-splits them.

**New components use CSS Modules. Not Tailwind.** Rewriting every component
mid-migration is how the replayer's container-query layout — genuinely hard CSS,
tuned against real screenshots — gets quietly lost, and the rebrand arrives as
token changes, for which custom properties are the cheapest interface.

The design tokens each declare their own `@layer tokens` block. They used to be
put in that layer by the importer (`@import "..." layer(tokens)`), which does
**not** survive the Next build: css-loader emits the layer condition in the
media slot, producing `@media layer(tokens){…}`, which is not a valid media
query and which every browser therefore drops. The symptom is an app that
builds and lints cleanly and renders as unstyled HTML. Do not reintroduce that
form.

`stylelint.config.js` still enforces the two rules that matter: no primitive
tokens and no raw hex outside `src/styles/tokens/`.

### 3. User-facing strings go through `lib/i18n/en.ts`

The product is English-only and Croatian is coming. The difference between "add
a locale" and "refactor every component" is decided now, not then.

Enforced by a `no-restricted-syntax` rule on **`src/app/**`** — bare JSX text
and bare `alt` / `title` / `placeholder` / `aria-label` attributes are errors
there. The scope is a stated limit, not an oversight: the pre-existing
components under `src/components/**` still carry several hundred inline strings,
and hauling them through `en.ts` during a framework migration is how a sentence
that explains a refusal reason loses a comma. What the scoping buys is that the
pile **cannot grow** — new UI lands in `src/app/**`, and a new file there cannot
ship a bare literal.

---

## Database (Supabase)

Project `riybwcfnclphacnfawiq` (`poker converter`), Postgres 17. Baseline
migration: `supabase/migrations/20260916190000_phf_baseline.sql`. Client layer:
`frontend/src/lib/db/`. Nothing else in the app touches Supabase.

Every column, the RLS reasoning, which query each index serves, how to apply a
migration and how to triage the corpus are in
**[`docs/DATABASE.md`](docs/DATABASE.md)**. The short version:

| Table | What it holds |
| --- | --- |
| `hands` | One successfully converted hand: the canonical `phf jsonb` document, the rendered `standard_text`, the original `source_text`, plus a denormalized column per searchable field (site, hero, position, cards, board, stakes, pot, profit, …). Unique on `hand_key`, so re-uploading a file is a no-op. |
| `unparsed_hands` | The **failure corpus**. Deduped by `fingerprint` with an occurrence counter and a triage `status`. |
| `unparsed_gaps` | View: the corpus rolled up by site / stage / reason, ordered by impact. |
| `shares` | Short-slug public links to one hand. Sealed from the client; reachable only through `create_share()` and the `read_share()` / `record_share_view()` pair. |

Money is stored as **integer minor units** everywhere, matching PHF.

### Anonymized rooms

Some rooms do not print persistent screen names, and the failure mode is
silent, so the schema models it explicitly. `hands.site_anonymization` says
what the names on a row are worth:

| Value | Meaning | Example |
| --- | --- | --- |
| `none` | Persistent screen names | PokerStars, WePlay |
| `positional` | Position labels that remap every hand | Ignition, Bodog, Bovada |
| `opaque-id` | Per-session tokens — hashes or numeric ids | GGPoker, data-mined ACR/WPN |

`positional` is the destructive one. Ignition writes `Dealer`, `Small Blind`,
`UTG+2` in place of names, and the button rotates, so "UTG+1" is a different
human every hand. Filtering `player_names = 'UTG+1'` over those rows would not
error — it would confidently return a different person from every row. So
those names are dropped before they reach the database, `player_names` and
`winners` are empty for such rows, and `hero_position` / `showdown_positions` /
`winner_positions` carry the identity instead. For those sites, position *is*
the identity.

Detection is per-hand and partly structural, not a hard-coded site list, so a
future anonymizing room gets labelled correctly the first time someone uploads
one. See `frontend/src/lib/db/anonymization.ts`.

### Accounts and RLS, briefly

The deployed bundle is public, so the anon key is public by construction —
anyone can read it out of the JavaScript and talk to PostgREST directly. Every
policy is therefore written for an untrusted caller, and the *only* thing that
separates two users' hands is the database, never the UI.

- Every row in `hands` has an `owner_id`. `select` and `insert` are policed by
  `owner_id = auth.uid()`, so there is no query a client can construct that
  returns somebody else's hand. `anon` has no grant on the table at all.
- `update` and `delete` are refused **everywhere**, for everyone, on every
  table. Counters that must move (share views, failure occurrences) do so
  inside `security definer` functions that can touch nothing else.
- `shares` has no grants and no policies. A slug is a capability URL, so
  `read_share()` is the only door and it is `security definer` — which is
  exactly why a share link works for a stranger with no account, and why
  `create_share()` has to check ownership explicitly rather than lean on RLS.
  `read_share` is `stable` and returns an explicit projection; the view counter
  lives in `record_share_view`, a separate `volatile` function, so a page can be
  rendered (and its unfurl tags generated) without counting a reader. The
  combined `resolve_share` is deprecated and removable on or after 2026-11-27.
- Dedupe is `(owner_id, hand_key)`, not `hand_key`. A global key would tell the
  second person to upload a hand "already stored" and then show them nothing,
  because the row they collided with is not theirs to read.
- `unparsed_hands` holds raw uploads, so a row is readable only by whoever
  submitted it. The corpus stays globally deduped — the occurrence counter is
  the whole point of the table — but reading across it is a service-role job.

Signing in uses Supabase Auth with **cookie sessions** (`@supabase/ssr`): email
+ password, or Google once the provider is configured in the dashboard. Every
sign-in returns to one address, `/auth/callback`, which exchanges the code
server-side; `?next=` there is validated against a fixed allow-list of relative
paths, because an open redirect on a page that has just minted a session is an
account-takeover vector rather than a phishing nuisance.

Server-side code resolves identity with **`getUser()`, never `getSession()`** —
`getSession()` decodes the cookie without verifying the JWT signature, which is
fine for a value this origin wrote into its own storage and wrong for input that
arrived over the wire. A **guest** is simply signed out: everything
client-side works, and nothing is stored, because there is no id to store it
under. The converter holds a finished run in memory and offers to save it after
sign-in, so the login never arrives before the value does.

### Applying migrations

**`supabase db push` does not work here** — the CLI cannot get a login role.
Use the Management API with the personal access token from the macOS keychain;
the exact commands and the verification queries (including how to confirm RLS
through the *anon* key rather than the PAT, which proves nothing) are in
[`docs/DATABASE.md`](docs/DATABASE.md#applying-a-migration).

---

## Deployment (Vercel)

Production is **https://poker-hand-converter.vercel.app**. Every push to `main`
deploys.

- **Root directory**: `frontend`. This is not cosmetic — see "The rule that
  keeps the test harness alive" below.
- **Framework preset**: Next.js (build `npm run build`, output `.next`).
  `frontend/vercel.json` pins `"framework": "nextjs"` so the project setting
  cannot silently disagree with the repository; it also keeps the
  `deploymentEnabled.staging: false` guard. Everything else that file used to
  carry — the SPA rewrite and the User-Agent fork for `/h/:slug` — is gone,
  because the framework renders on the server now.
- **Environment variables**, in all three environments:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_SITE_URL` (optional; defaults to the current `*.vercel.app` host)

Without those the deploy still works, as an offline converter.

> **These were renamed at the Next.js cutover** (`VITE_*` → `NEXT_PUBLIC_*`),
> because Vite inlined `import.meta.env.VITE_*` and Next inlines
> `process.env.NEXT_PUBLIC_*`. **Update the Vercel project settings before the
> first deploy**, or production ships as an offline converter — which it will
> say plainly in the UI, but which is still not what anyone wants.
>
> Two other one-time steps, both outside this repository:
>
> 1. Add `<NEXT_PUBLIC_SITE_URL>/auth/callback` to Supabase → Authentication →
>    URL Configuration → Redirect URLs, for every environment. The old list
>    covered `localhost:5173` / `:4173`, which were the Vite ports; `next dev`
>    serves on 3000, and the callback is now a single fixed address rather than
>    "whatever page you happened to be on".
> 2. Expect **every existing session to be signed out** on cutover: the token
>    moves from `localStorage["sb-<ref>-auth-token"]` to cookies.
>    `components/auth/SessionImport.tsx` carries one over on the user's next
>    visit and then deletes itself. That file has a deletion date in its header
>    — **2026-11-28** — and nothing else references it.

Manual deploy:

```bash
cd frontend
npx vercel deploy --prod
```

Vercel is the only way the frontend ships. An older path served the built
`dist/` out of a Supabase Storage bucket; it was deleted because SPA routes
404'd there and it was the one place in the repo that handled a service-role
key. The two migrations that created that bucket (`20260226123000`,
`20260308091000`) are still applied and are now inert — leave them alone rather
than writing a migration to undo history.

---

## Where to read next

| Question | Document |
| --- | --- |
| What is a hand, exactly? What are the invariants? | [`docs/PHF-SPEC.md`](docs/PHF-SPEC.md) |
| How do I write a parser for a new room? | [`docs/PHF-SPEC.md` §8](docs/PHF-SPEC.md) |
| What does column X mean? Why is the RLS like that? | [`docs/DATABASE.md`](docs/DATABASE.md) |
| What does room X's format look like? | `docs/research/hh-formats/<site>.md` |
| Which formats are alike? Which can share a parser? | [`docs/research/FORMAT-MATRIX.md`](docs/research/FORMAT-MATRIX.md) |
| Which room should we support next, and what will it cost? | [`docs/research/COVERAGE-PLAN.md`](docs/research/COVERAGE-PLAN.md) |
| Where did this sample file come from? | `fixtures/samples/<site>/SOURCES.md` |

# PokerConverter

A browser-based converter and replayer for poker hand histories.

Drop an export from almost any poker room into it and you get back one
canonical representation of every hand — which you can then download as
tracker-importable text, step through in a visual replayer, keep in a
searchable library, or hand to someone else as a link.

Everything runs in the browser. The only backend is Supabase (Postgres +
PostgREST); there is no server of ours in the request path.

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
`backend/test/fixtures/`, which holds regression cases that each exist because
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
backend/test/fixtures/** -text -diff
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

Three routes, hand-rolled matching in `frontend/src/routes/` (a router runtime
was not worth the bytes on a public landing page):

| Route | What it is |
| --- | --- |
| `/` | **Converter.** Drop files, a folder, a zip, or paste text. Detection and conversion run in a Web Worker and start immediately — the intent of dropping a hand history on a hand-history converter is not ambiguous, and there is a cancel button. Converted hands are saved to the library (toggleable), refused hands go to the corpus, and the output is downloadable per file or combined. |
| `/replay` | **Replayer.** Pick a hand from the library with filters, or upload/paste a single one. Animated table: pot per street, bets in front of each seat, all-in state, dealer button, run-it-twice boards, final pot distribution. Play/pause, step, scrub, jump to a street, 0.5×–4× speed, reveal all known cards. Keyboard: `←`/`→` step, `space` play/pause, `Home`/`End`. |
| `/h/:slug` | **A shared hand.** A capability URL to one hand, resolved server-side. Code-split from the rest of the app so a stranger opening a link does not download the converter. |

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

Default: `http://localhost:5173`.

`.env.local` is optional — see the paragraph above for what you lose without
it.

## Tests

```bash
cd backend
npm test
```

**2595 tests across 23 files.** `backend/` is a test harness, not a runtime
backend — it exercises the frontend libraries directly against the real corpus.
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
   add the site to `backend/test/support/corpus.ts` so the table-driven tests
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
| `frontend/src/components/` | `converter/`, `replayer/`, `share/`, `shell/` |
| `frontend/src/routes/` | The three routes and the hand-rolled matcher |
| `frontend/src/workers/` | Conversion off the main thread |
| `backend/` | Test harness only — no runtime backend |
| `supabase/migrations/` | Schema |
| `fixtures/samples/` | The real hand-history corpus, one directory per site |
| `gg-hh/`, `weplay-hh/` | The original reference and source corpora the project started from |
| `docs/` | `PHF-SPEC.md`, `DATABASE.md`, and `research/` |

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
| `shares` | Short-slug public links to one hand. Sealed from the client; reachable only through `create_share()` / `resolve_share()`. |

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
  `resolve_share()` is the only door and it is `security definer` — which is
  exactly why a share link works for a stranger with no account, and why
  `create_share()` has to check ownership explicitly rather than lean on RLS.
- Dedupe is `(owner_id, hand_key)`, not `hand_key`. A global key would tell the
  second person to upload a hand "already stored" and then show them nothing,
  because the row they collided with is not theirs to read.
- `unparsed_hands` holds raw uploads, so a row is readable only by whoever
  submitted it. The corpus stays globally deduped — the occurrence counter is
  the whole point of the table — but reading across it is a service-role job.

Signing in uses Supabase Auth: email + password, or Google once the provider is
configured in the dashboard. A **guest** is simply signed out: everything
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

- **Root directory**: `frontend`
- **Framework preset**: Vite (build `npm run build`, output `dist`)
- **Environment variables**, in all three environments:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

Without those the deploy still works, as an offline converter.

Manual deploy:

```bash
cd frontend
npx vercel deploy --prod
```

### Legacy: Supabase Storage hosting

Kept only as a manual fallback. The workflow
(`.github/workflows/deploy-frontend-supabase-storage.yml`, bucket
`frontend-site`) no longer runs on push — `workflow_dispatch` only. Needs the
`SUPABASE_PROJECT_REF` and `SUPABASE_SERVICE_ROLE_KEY` secrets. The two storage
migrations (`20260226123000`, `20260308091000`) exist to keep this path alive
and are otherwise untouched.

```bash
SUPABASE_PROJECT_REF="<project-ref>" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
node scripts/deploy-frontend-to-supabase.mjs
```

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

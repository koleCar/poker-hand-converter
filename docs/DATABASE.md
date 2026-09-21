# Database

Supabase project `riybwcfnclphacnfawiq` (`poker converter`). Postgres 17.

The schema is defined by two migrations:

| Migration | What it does |
| --- | --- |
| `20260916190000_phf_baseline.sql` | The baseline: `hands`, `unparsed_hands`, `shares`, RLS, RPCs. |
| `20260916210000_position_search_and_anonymization.sql` | Adds `site_anonymization` and the position search columns. |

The client layer that talks to them is `frontend/src/lib/db/`. Nothing else in
the app touches Supabase.

- [Threat model](#threat-model-read-this-first)
- [Tables](#tables)
- [Player identity and anonymized rooms](#player-identity-and-anonymized-rooms)
- [Functions (RPCs)](#functions-rpcs)
- [RLS policies and grants](#rls-policies-and-grants)
- [Indexes and the queries they serve](#indexes-and-the-queries-they-serve)
- [Applying a migration](#applying-a-migration)
- [Adding a search column later](#adding-a-search-column-later)
- [Triaging the unparsed corpus into new parsers](#triaging-the-unparsed-corpus-into-new-parsers)

---

## Threat model (read this first)

**The app has no login and none is planned.** The deployed bundle is a public
static asset, so `VITE_SUPABASE_ANON_KEY` is public by construction: anyone can
read it out of the JavaScript and talk to PostgREST directly with `curl`. Every
policy in the schema assumes an untrusted, unauthenticated, unidentifiable
caller.

The rules the schema holds to:

| # | Rule | Why it is acceptable |
| --- | --- | --- |
| 1 | Anon may **read** hands | Converted hands are the public product surface. Anyone who loads the site can already see them. There is no user, so there is nothing user-private. |
| 2 | Anon may **insert** hands | That is the product. The worst case is junk rows, which the service role can delete. |
| 3 | Anon may **never** update or delete anything | Data loss is the one outcome we refuse to expose. No table has an `UPDATE` or `DELETE` policy, and the grants do not include those verbs either. |
| 4 | Counters move only inside `security definer` functions | Failure occurrence counts and share view counts *have* to increment, but giving anon a general `UPDATE` grant to allow it would also let it rewrite hands. The functions can touch exactly those columns and nothing else. |
| 5 | Anon may not enumerate `shares` | A share slug is a capability URL. Being able to `select *` would hand out every private link ever created. The table has no grants and no policies at all; `resolve_share(slug)` is the only door and it takes an exact slug. |
| 6 | Junk volume is bounded | `CHECK` constraints cap text sizes and validate shapes; a statement-level trigger enforces a global insert-rate budget. |

Anything destructive (deleting junk, retiring corpus rows, editing triage
status) is a **service role** operation, done from the Supabase dashboard SQL
editor or through the Management API.

### What an attacker can actually do

* Insert bogus hands and bogus failure records, until the rate limiter closes
  the window. Cost: some rows to clean up.
* Read every stored hand. Already true by loading the site.
* Create share links. Bounded to 300/hour globally.
* Resolve a share slug they already know. That is the feature.

### What they cannot do

* Delete or modify a stored hand, a corpus entry, or a share.
* List share slugs.
* Read or write `ingest_rate_limit`, or call `enforce_rate_limit` /
  `generate_share_slug` (both revoked from `anon` and `authenticated` — note
  that Supabase's default privileges grant `EXECUTE` on new functions to those
  roles, so a bare `revoke ... from public` is *not* enough and the migration
  revokes them by name).
* Store an unbounded blob: `hands.source_text` and `hands.standard_text` are
  capped at 200 000 characters, `hands.phf` at 1 MiB, and
  `unparsed_hands.raw_text` at 128 KiB.

### Rate limiting

Without a login there is no per-user identity to key a limiter on, and the
client IP is not visible to Postgres through PostgREST. So `ingest_rate_limit`
is a **global** fixed-window circuit breaker per logical bucket, not fair-share
throttling. It turns "someone scripts inserts overnight" into "someone gets
errors after a while".

| Bucket | Budget | Enforced by |
| --- | --- | --- |
| `hands_insert` | 25 000 rows / 10 min | `hands_rate_limit()` statement trigger |
| `unparsed_insert` | 5 000 records / 10 min | `record_conversion_failures()` |
| `share_create` | 300 shares / hour | `create_share()` |

Budgets are an order of magnitude above real use: a 5000-hand upload spends
5 000 of the 25 000 hand budget. Single requests are capped separately — 1 000
rows per `INSERT` statement, 500 hands per `save_hands()` call, 200 records per
`record_conversion_failures()` call.

`ingest_rate_limit` has RLS enabled with **no policies** and all grants revoked,
so it is invisible to the anon key; only the `security definer` functions reach
it.

### `security` and `search_path` on functions

Every function sets `search_path = ''` and schema-qualifies every reference.
`pg_catalog` is always implicitly searched, so built-ins still resolve; anything
in `public` or `extensions` is written out in full. With a public anon key an
attacker cannot create objects in `public` anyway, but an empty search path
removes the whole class of shadowing bugs for free and is what the Supabase
linter asks for.

`security invoker` is the default: the function is a convenience wrapper and RLS
still applies. `security definer` is used **only** where the caller must be
allowed to do something RLS forbids, and each one is annotated in the SQL with
why:

| Function | Security | Reason |
| --- | --- | --- |
| `save_hands` | invoker | Inserts must stay subject to the `hands` RLS policy and the rate-limit trigger. |
| `search_hands`, `get_hand`, `hands_facets`, `unparsed_summary` | invoker | Read-only; RLS already allows public select. |
| `record_conversion_failures` | **definer** | Anon has `SELECT` but no `INSERT`/`UPDATE` on `unparsed_hands`, precisely so a caller cannot forge an occurrence count or flip `status`. This is the only write path and it whitelists the columns it touches. |
| `create_share` | **definer** | `shares` is sealed from anon. The function generates the slug itself, so a caller cannot choose one. |
| `resolve_share` | **definer** | Reads a sealed table *and* increments `views`, which is an `UPDATE`. Keyed strictly by slug equality, returns exactly one row. |
| `enforce_rate_limit` | **definer** | The counter table is unreachable from anon. Not granted to clients. |
| `hands_rate_limit` (trigger) | **definer** | Has to call `enforce_rate_limit`, which anon cannot execute. |

---

## Tables

### `hands` — one row per successfully converted hand

Three representations are stored on purpose:

| Column | What it is | Why it exists |
| --- | --- | --- |
| `phf jsonb` | The canonical PHF v1 document (`frontend/src/lib/phf/types.ts`) | Source of truth. The replayer reads this. |
| `standard_text text` | GG-style rendering, derived from `phf` | Holdem Manager import is byte-sensitive; storing the render means we never re-serialize, and never risk a serializer change silently altering an old export. |
| `source_text text` | The original site text | So a hand can be **re-converted** after a parser bug is fixed, without asking the user for the file again. |

Everything after those three is a **denormalized search layer**: derivable from
`phf`, but only indexable if it lives in its own column.

| Column | Type | Source in PHF | Why |
| --- | --- | --- | --- |
| `id` | uuid pk | — | Row identity; used by share links. |
| `hand_key` | text **unique** | `"<meta.siteId>:<meta.handKey>"` | Dedupe. Re-uploading the same file is a no-op. PHF's own `handKey` is only unique *within* a site, so the site prefix is what makes it globally safe. |
| `schema_version` | text | `hand.schema` | Which PHF version wrote the row; lets a future `phf/2` coexist. |
| `parser_version` | text | `meta.parserVersion` | Tells you which hands to re-convert after a parser fix. |
| `site` | text | `meta.siteId` (lowercased) | Primary facet. |
| `site_hand_id` | text | `meta.handId` | Cross-referencing against the site's own records. |
| `variant` | text | `game.variant` | Free text, not an enum: new variants should be a parser change, not a migration. |
| `limit_type` | text | `game.limit` | `nl` / `pl` / `fl`. |
| `game_format` | enum | `game.format` | `cash` / `tournament` / `sng` / `spin`. |
| `tournament_id` | text | `tournament.id` | "Every hand from this tournament" is the natural drill-down. |
| `currency` | text | `game.unit.code` | `USD`, `CHIPS`, … |
| `currency_minor_units` | smallint | `game.unit.minorUnits` | **Required for display.** The list view never ships `phf`, so without this a client holding `total_pot = 12500` cannot tell $125.00 from 12 500 chips. |
| `currency_symbol` | text | `game.unit.symbol` | Display only; empty for chips. |
| `small_blind`, `big_blind`, `ante` | bigint | `game.*` | Minor units. `big_blind` is the stakes facet key. |
| `stakes_label` | text | derived | Pre-rendered `$0.50/$1`, so the UI does not format the same string for every row. |
| `table_name` | text | `table.name` | Filtered with a substring match. |
| `max_seats` | smallint | `table.maxSeats` | 6-max vs full ring. |
| `played_at` | timestamptz | `hand.playedAt` | Default sort and date-range filter. |
| `hero_name` | text | hero player | Common filter; a session is "my hands". |
| `hero_seat`, `hero_position` | smallint / text | hero player | `BTN`, `CO`, `UTG+1`… Constrained to the PHF `Position` vocabulary and indexed with `played_at`. |
| `hero_cards` | text[] | hero `holeCards` | GIN-indexed; "hero held Ah". Normalized to canonical `Rs` casing by a trigger. |
| `hero_hand_class` | text | derived | `AKs` / `AKo` / `TT`. The filter players actually think in. Null for non-two-card variants. |
| `board_cards` | text[] | primary runout | GIN-indexed; "board contains Qh Jh". **Primary runout only** — including a run-it-twice second board would make the filter match a card that only ever appeared on the second run. |
| `player_names` | text[] | all players | GIN-indexed; "hands where villain X was at the table". **Empty when `site_anonymization = 'positional'`** — see below. |
| `player_count` | smallint | `players.length` | Table size filter. |
| `site_anonymization` | enum | derived | `none` / `positional` / `opaque-id`. What the names in this row are worth. See the next section. |
| `player_positions` | text[] | `players[].position` | Roster of positions dealt in. For an anonymized room this is the only per-seat roster there is. Not indexed — see the index table. |
| `showdown_positions` | text[] | derived | Positions that reached showdown. GIN-indexed; the cross-site "which villain" filter. |
| `winner_positions` | text[] | derived | Positions that collected a pot. GIN-indexed. The **only** winner record on a `positional` hand. |
| `street_reached` | text + CHECK | `results.streetReached` | Text rather than an enum: compared against client strings constantly, and text avoids enum-cast friction in PostgREST filters. |
| `went_to_showdown` | boolean | `results.wentToShowdown` | Partial index; a very common filter. |
| `total_pot` | bigint | `results.totalPot` | Minor units, before fees. Sort key and "min pot" filter. |
| `rake` | bigint | `totalFees(results.fees)` | **Total** fees taken out of the pot — rake plus jackpot/promo drops. The breakdown stays in `phf.results.fees`. |
| `hero_profit` | bigint | `results.heroNet` | Signed, minor units. Sort key; "hands hero won". |
| `winners` | text[] | `results.winners` | Deduped player names. |
| `source_filename` | text | `meta.originalFilename` | "Which file did this come from". |
| `created_at` | timestamptz | server `now()` | Set by the normalizing trigger, not the client: a row cannot be backdated. |

**Triggers**

* `hands_normalize_before_insert` (BEFORE INSERT, row) — canonicalises card
  casing (`AH`/`ah` → `Ah`), lowercases `site`/`variant`/`limit_type`/`street_reached`,
  uppercases `hero_position` and `currency`, trims identifiers, folds empty
  strings to `NULL` so facet lists do not sprout blank entries, fills
  `player_count` from `player_names`, and stamps `created_at`.
* `hands_rate_limit_after_insert` (AFTER INSERT, **statement**, with a transition
  table) — rejects statements over 1 000 rows and charges the `hands_insert`
  budget. Statement level so a 500-row batch costs one counter update.

**Constraints worth knowing**

| Constraint | Enforces |
| --- | --- |
| `hands_hero_cards_ok`, `hands_board_cards_ok` | Structurally valid card codes; ≤ 6 hole cards, ≤ 10 board cards. |
| `hands_players_ok`, `hands_winners_ok` | ≤ 24 entries. |
| `hands_pot_ok`, `hands_rake_ok`, `hands_blinds_ok` | Non-negative money. |
| `hands_phf_object`, `hands_phf_schema`, `hands_phf_size` | `phf` is a JSON object whose `schema` (if present) starts with `phf/`, under 1 MiB. |
| `hands_hand_class_ok` | `hero_hand_class` matches `^[2-9TJQKA]{2}[so]?$`. |
| `hands_hero_position_ok` | `hero_position` is in the PHF `Position` vocabulary. |
| `hands_player_positions_ok`, `hands_showdown_positions_ok`, `hands_winner_positions_ok` | Same vocabulary, ≤ 24 entries each. |
| `hands_positional_anonymity` | A `positional` hand carries **no** `player_names` and **no** `winners`. See [Player identity](#player-identity-and-anonymized-rooms). |

### `unparsed_hands` — the failure corpus

This is a **product feature, not an error log**. Every hand history we could not
convert is kept verbatim so a converter can be written for it later, and the
table is the backlog for "which site do we support next".

| Column | Why |
| --- | --- |
| `fingerprint` **unique** | sha-256 hex of the whitespace-normalized raw text. The same unsupported hand seen a hundred times is one row with `occurrences = 100`, not a hundred rows. |
| `raw_text` | The sample itself. Capped at 128 KiB. |
| `detected_site`, `detection_confidence` | What the detector guessed, and how sure it was. A confident wrong guess and a shrug are different problems. |
| `stage` (enum) | Where the pipeline gave up: `split` / `detect` / `parse` / `validate` / `serialize`. Tells you whether you need a new parser or a fix to an existing one. |
| `reason` | Machine code, e.g. `unknown-site`. The grouping key for gap analysis. |
| `message` | Human readable, shown in the UI. |
| `parser_version` | Which build failed. A record that stops reappearing after a release is fixed. |
| `source_filename` | Context for the person triaging. |
| `status` (enum) | `new` → `triaged` → `parser-written`, or `wontfix`. Drives the decision of what to build next. Only a human (service role) sets it; the ingest RPC never touches it. |
| `notes` | Triage scratchpad. |
| `occurrences` | How often this exact text has been submitted. The impact signal. |
| `first_seen_at` / `last_seen_at` | How long it has been a problem, and whether it still is. |

Mirrors the `ConversionFailure` interface in `frontend/src/lib/phf/detect.ts`
exactly, plus `status` / `notes` / counters.

### `unparsed_gaps` (view)

`unparsed_hands` rolled up by `(detected_site, stage, reason, status)` with
`distinct_hands`, `total_occurrences` and first/last seen. Declared
`security_invoker = true`, so the base table's RLS still applies to whoever
selects from it.

Order by `total_occurrences desc` and the top row is the highest-value parser to
write next.

### `shares` — short public links

| Column | Why |
| --- | --- |
| `slug` **unique** | 10 characters from a 31-symbol ambiguity-free alphabet (`23456789abcdefghjkmnpqrstuvwxyz` — no `0`, `1`, `i`, `l`, `o`), generated server-side with `gen_random_bytes`. ≈ 8.2 × 10¹⁴ combinations. Server-side because a client-chosen slug is how you overwrite or enumerate someone else's share. |
| `hand_id` | FK to `hands`, `ON DELETE CASCADE`. Preferred: the share follows the stored row instead of pinning a stale copy. |
| `phf` + `standard_text` | The embedded alternative, for a hand that was never saved (offline, or saving turned off). A `CHECK` requires one of `hand_id` / `phf`. |
| `title` | Optional label for the share page. |
| `views`, `last_viewed_at` | Bumped by `resolve_share`. |
| `created_at` | — |

### `ingest_rate_limit`

Internal. One row per bucket, fixed-window counter. No RLS policies, no grants.

---

## Player identity and anonymized rooms

Most rooms print persistent screen names. Two do not, and the failure mode is
silent rather than loud, which is what makes it dangerous.

| `site_anonymization` | What the names are | Rooms | Usable as identities? |
| --- | --- | --- | --- |
| `none` | Persistent screen names | PokerStars, WePlay, ACR/WPN (normal dialects), … | yes |
| `positional` | Position labels that remap every hand | Ignition / Bodog / Bovada | **no** |
| `opaque-id` | Per-session tokens: hashes or numeric ids | GGPoker, ACR/WPN data-mined dialect | within one session only |

### Why `positional` is a correctness problem, not a cosmetic one

Ignition prints every seat as its position relative to the button — `Dealer`,
`Small Blind`, `UTG+2` — and tags the hero `[ME]`. **The button rotates every
hand.** So `player_names = 'UTG+1'` is a different human in every row. A filter
on it does not error and does not return nothing; it returns a plausible-looking
page of hands involving unrelated people. It looks like it worked.

So for `positional` hands the schema stores **no** `player_names` and **no**
`winners`. A row that cannot answer "who played" now says so instead of
answering wrongly. Three things make that safe:

* **`hero_name` is kept.** It is the one real identity in such a hand (the
  parser rewrites the `[ME]` seat to `Hero`). Hero filtering, hero win-rate and
  "my hands" all keep working. Only *villain* filtering is unavailable, and the
  UI is expected to visibly disable it rather than quietly return junk.
* **Position replaces the name.** `PhfPlayer.position` is resolved from the
  button and the posted blinds by `assignPositions`, completely independently of
  what the room called the seats — so it is trustworthy exactly where the names
  are not. For Ignition, position *is* the identity.
* **Nothing is lost.** The original names are still in `phf` and in
  `source_text`. Only the *indexed identity columns* are blanked.

A `CHECK` constraint (`hands_positional_anonymity`) makes this an invariant
rather than a convention:

```sql
check (site_anonymization <> 'positional'
       or (cardinality(player_names) = 0 and cardinality(winners) = 0))
```

A client that tags a hand `positional` cannot also smuggle the pseudonyms into
the identity columns, by bug or on purpose. Verified live: the insert is
rejected with `23514`.

### Why `opaque-id` rooms keep their names

GGPoker hashes each villain to eight hex characters; ACR/WPN's data-mined
dialect replaces every screen name with a numeric id and marks no hero. These
are unreadable and may not survive a session boundary — but unlike a positional
pseudonym, a token never maps to a *different human*, and within one session it
groups correctly. Discarding it would be irreversible information loss.
Labelling it lets the UI render it honestly and refuse to make cross-session
claims. Only `positional` is destructive enough to justify blanking.

### How the value is derived

`frontend/src/lib/db/anonymization.ts`, per hand, in this order:

1. **Site registry** — `ignition` → `positional`, `ggpoker` → `opaque-id`.
2. **Parser warning codes** — a hand carrying `numeric-player-ids` is
   `opaque-id`. This has to be per-hand, not per-site: ACR/WPN's mined dialect
   shares a `siteId` with its two normal dialects, so only the warning
   distinguishes them. Note that Ignition's `mvs-player-hashes` warning is
   deliberately **not** treated as `opaque-id` — those hashes are provenance
   recorded in the warning text, while the *names* on that hand are still
   positional pseudonyms.
3. **Structural fallback** — if *every* villain name is a position label
   (`Dealer`, `Small Blind`, `UTG+N`) or an opaque token (`[0-9a-f]{6,}` /
   `\d{5,}`), the names are not identities regardless of which room produced
   them.

Step 3 is what makes a future anonymizing room a data value rather than a code
change: it gets labelled correctly the first time somebody uploads one. It is
deliberately conservative — it requires unanimity across at least two villains,
so one player called `Dealer` at a table of normal names changes nothing — and
it is recoverable even when wrong, because `phf` keeps the original names.

### What the UI must do

Branch on the column, never on a hard-coded site list:

```ts
import { hasUsablePlayerNames, anonymizationNote } from "../lib/db";

if (!hasUsablePlayerNames(row.anonymization)) {
  // disable the villain-name filter, show anonymizationNote(row.anonymization),
  // and offer showdownPositions / winnerPositions instead
}
```

---

## Functions (RPCs)

All are callable by `anon` and `authenticated` unless noted.

| Function | Returns | What it does |
| --- | --- | --- |
| `save_hands(p_hands jsonb)` | `{received, inserted, duplicates}` | Batch-inserts hands, deduping on `hand_key` with `ON CONFLICT DO NOTHING`. Returns exact counts, which is what removes the old "probe which of these already exist" round trips. Max 500 per call. |
| `search_hands(p_filters jsonb, p_limit int, p_offset int)` | `{total, limit, offset, rows}` | The whole browse filter set, sorted, paginated, **with the total count**, in one call. Sort keys are whitelisted, so the query stays on an index. Heavy columns (`phf`, `standard_text`, `source_text`) are excluded: a page of 50 hands should be kilobytes. |
| `get_hand(p_id uuid)` | full row as jsonb | The payload, fetched only when a hand is actually opened. |
| `hands_facets()` | jsonb | Every distinct filter value the browse UI offers — sites, heroes, tables, stakes, variants, limit types, formats, hand classes, streets, the `played_at` range, and the corpus total — in one round trip. |
| `record_conversion_failures(p_failures jsonb)` | `{received, created, updated, skipped}` | Upserts `ConversionFailure` records by fingerprint, incrementing `occurrences` atomically. Truncates over-long fields and skips malformed records rather than failing the batch: losing a sample we cannot reproduce is worse than storing a lossy one. Never writes `status` or `notes`. Max 200 per call. |
| `unparsed_summary(p_limit int)` | jsonb | `unparsed_gaps` ordered by impact, plus totals and a `byStatus` breakdown. The answer to "which converter next". |
| `create_share(p_hand_id, p_phf, p_standard_text, p_title)` | `{id, slug}` | Allocates a slug (retrying on collision) and inserts one row. |
| `resolve_share(p_slug text)` | jsonb or `null` | Resolves a slug **and** increments its view counter, in one round trip. Returns the share plus the joined hand. `null` for unknown *or* malformed slugs — deliberately indistinguishable, so probing tells an attacker nothing. |
| `enforce_rate_limit(...)` | void | Internal. `service_role` only. |
| `generate_share_slug(int)` | text | Internal. `service_role` only. |

`search_hands` filter keys (all optional): `site`, `board[]`, `heroCards[]`,
`heroHandClasses[]`, `heroName`, `player`, `tableName`, `variant`, `limitType`,
`gameFormat`, `tournamentId`, `bigBlind`, `street`, `showdownOnly`,
`heroWonOnly`, `minPot`, `from`, `to`, `heroPositions[]`,
`showdownPositions[]`, `winnerPositions[]`, `anonymization`, `sort`.

Card and position arrays are normalized server-side, so `["ah","KH"]` and
`["btn"]` both match. Sort: `played_desc` (default), `played_asc`, `pot_desc`,
`profit_desc`, `profit_asc`, `created_desc`.

The three position filters use **overlap (`&&`), not containment (`@>`)**:
`heroPositions: ["BTN","CO"]` reads as "hero was on the button *or* in the
cutoff". Containment would be wrong — a hand has exactly one hero position, so
containment of a two-element array would match nothing at all.

`hands_facets()` additionally returns `heroPositions` (with counts — a lopsided
distribution is itself informative), `showdownPositions`, and `anonymizations`
(with counts, so the UI can tell whether the name filter is safe to offer at
all).

---

## RLS policies and grants

RLS and grants are two independent layers and both are set explicitly. Supabase
ships `alter default privileges in schema public grant all on tables/functions
to anon, authenticated, service_role`, so **every new object starts
over-permissioned** and the migration revokes first, then grants.

| Table | Grants (`anon`, `authenticated`) | Policies |
| --- | --- | --- |
| `hands` | `SELECT`, `INSERT` | `hands_public_select` (`USING true`), `hands_public_insert` (`WITH CHECK true`). No `UPDATE`/`DELETE` policy — with RLS on and no permissive policy, both are refused regardless of grants. |
| `unparsed_hands` | `SELECT` only | `unparsed_public_select` (`USING true`). Writes go through the definer RPC; a direct `INSERT` would let a caller invent an occurrence count or set `status = 'wontfix'` on someone else's row. |
| `unparsed_gaps` (view) | `SELECT` | `security_invoker`, so the base table's policy applies. |
| `shares` | **none** | **none**. Sealed. `create_share` / `resolve_share` only. |
| `ingest_rate_limit` | **none** | **none**. Internal. |

Verified live — `anon` gets `42501 permission denied` on `DELETE`/`UPDATE` of
`hands`, on `SELECT` of `shares` and `ingest_rate_limit`, on `INSERT` into
`unparsed_hands`, and on `EXECUTE` of `enforce_rate_limit` and
`generate_share_slug`.

### Data-shape invariants are enforced, not conventional

RLS answers "may this caller write at all". It says nothing about *what* they
write, and with a public anon key the client is not trustworthy — a bug and an
attacker are indistinguishable from the server's side. So the rules that keep
the data honest are `CHECK` constraints, not client discipline.

The one that matters most is `hands_positional_anonymity`, because violating it
produces a filter that looks like it works (see
[Player identity](#player-identity-and-anonymized-rooms)). Probed live with the
anon key, sending rows a correct client would never send:

| Attempt | Result |
| --- | --- |
| `site_anonymization='positional'` **+** `player_names=['Dealer','UTG+1']` | `23514 hands_positional_anonymity` |
| `site_anonymization='positional'` **+** `winners=['Dealer']` | `23514 hands_positional_anonymity` |
| `showdown_positions=['MIDDLE']` | `23514 hands_showdown_positions_ok` |
| `hero_position='MIDDLE'` | `23514 hands_hero_position_ok` |

All four rejected. A client cannot smuggle per-hand pseudonyms into the identity
columns, by bug or on purpose, and cannot invent a position outside the PHF
vocabulary — which is what lets the position filters be treated as total.

Re-run these after any change to `save_hands` or the `hands` constraints: they
are the cheapest regression test in the project, and a `201` on the migration
tells you nothing about whether they still hold.

---

## Indexes and the queries they serve

Indexes were chosen from the browse UI's actual query shape, which is "one or
two filters plus a sort", not by reflexively indexing every column.

| Index | Query it serves |
| --- | --- |
| `hands_hand_key_uidx` (unique) | Dedupe on insert; `findHandId()`. |
| `hands_board_gin`, `hands_hero_cards_gin`, `hands_players_gin` | Containment (`@>`) predicates: "board contains these cards", "hero holds these cards", "player X was at the table". These are the filters that need GIN — btree cannot answer them. |
| `hands_played_at_idx` | The default list order. |
| `hands_created_at_idx` | "Recently imported". |
| `hands_site_played_idx`, `hands_hero_played_idx`, `hands_class_played_idx`, `hands_stakes_played_idx`, `hands_format_played_idx`, `hands_tournament_idx` | Composite `(filter column, played_at desc)`. Every one of these is "filter by a low-cardinality column, then sort by time". A single-column index would force a sort of the whole matching set; the composite serves filter and order in one scan. The hero / class / stakes / tournament ones are partial (`WHERE … IS NOT NULL`) because the null side is never filtered on. |
| `hands_total_pot_idx`, `hands_hero_profit_idx` | The "biggest pot" and "best/worst result" sort orders, and the `minPot` filter. |
| `hands_showdown_idx` | `showdownOnly`. Partial on the selective side, so it is far smaller than indexing a skewed boolean. |
| `hands_table_trgm` | `tableName` is filtered with a substring `ILIKE`; only a trigram GIN index can accelerate that. |
| `hands_hero_position_played_idx` | "Hero was on the button", the most common position filter, plus the default sort. Partial on `hero_position IS NOT NULL`. |
| `hands_showdown_positions_gin`, `hands_winner_positions_gin` | Overlap (`&&`) filters. Selective: a showdown involves 0–2 seats and a pot usually has one winner. |

Deliberately **not** indexed:

* `player_positions` — on a 6-max table it is the same six values on every row,
  so a containment filter matches nearly everything and the planner would never
  choose the index. It is stored for display and roster completeness (it is the
  only per-seat roster an anonymized hand has), not for filtering.
* `site_anonymization` — three values, overwhelmingly skewed. The UI reads it
  per row to decide what to render; nobody pages through it.
| `unparsed_fingerprint_uidx` | The dedupe upsert. |
| `unparsed_status_seen_idx` | The triage queue: "everything still `new`, newest first". |
| `unparsed_site_reason_idx` | The `unparsed_gaps` grouping; also serves site-only lookups. |
| `unparsed_occurrences_idx` | "What hurts most" ordering. |
| `shares_slug_uidx` | `resolve_share`. The only way into the table. |
| `shares_hand_idx` | "Does this hand already have a share?" |

---

## Applying a migration

**`supabase db push` does not work on this project.** The CLI cannot get a login
role (no database password is stored), and it will fail with an auth error. This
bites everyone once. Use the Management API instead.

Apply **every** migration the live project is missing, in filename order. To see
which those are:

```bash
PAT=$(security find-generic-password -s "Supabase CLI" -a supabase -w \
      | sed 's/^go-keyring-base64://' | base64 -d)   # keychain, base64-wrapped by the CLI's keyring lib

curl -s -X POST "https://api.supabase.com/v1/projects/riybwcfnclphacnfawiq/database/query" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{"query":"select version, name from supabase_migrations.schema_migrations order by version;"}'

ls supabase/migrations/*.sql | xargs -n1 basename   # compare against this
```

Then, for each missing one — set `MIGRATION` and run the same two commands.
Nothing below is specific to a particular file, so do not edit the commands:

```bash
MIGRATION=supabase/migrations/20260916210000_position_search_and_anonymization.sql

# 1. Run it.
curl -s -X POST "https://api.supabase.com/v1/projects/riybwcfnclphacnfawiq/database/query" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'query': open(sys.argv[1]).read()}))" "$MIGRATION")"

# 2. Record it, or the next person to run `supabase migration list` sees drift.
#    Version and name are derived from the filename, never retyped.
curl -s -X POST "https://api.supabase.com/v1/projects/riybwcfnclphacnfawiq/database/query" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json, os, sys
stem = os.path.basename(sys.argv[1])[:-4]
version, _, name = stem.partition('_')
print(json.dumps({'query':
  'insert into supabase_migrations.schema_migrations (version, name) '
  f\"values ('{version}', '{name}') on conflict (version) do nothing;\"}))" "$MIGRATION")"
```

The endpoint runs the whole file in one transaction and returns `[]` with HTTP
201 on success, or `{"message": "Failed to run sql query: ERROR: ..."}` with 400.

### Do not trust a 201

A successful HTTP status means the SQL ran, not that the schema is what you
intended. Always verify the resulting state:

```sql
-- tables, views, and whether RLS is on
select c.relname, c.relkind, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','v') order by 1;

-- policies
select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public';

-- grants that actually exist (this is where Supabase's default privileges bite)
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated');

-- function security and search_path
select proname, prosecdef, proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';

-- who can execute what
select p.proname, pg_get_userbyid(x.grantee)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x on x.privilege_type = 'EXECUTE'
where n.nspname = 'public';
```

Then run a real round trip through the **anon** key, not the PAT — the PAT is a
superuser and proves nothing about RLS:

```bash
# frontend/.env.local has the values; `supabase projects api-keys --project-ref riybwcfnclphacnfawiq` prints them
curl -X POST "$VITE_SUPABASE_URL/rest/v1/rpc/hands_facets" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY"
```

and confirm the negative cases still fail: `DELETE /rest/v1/hands`,
`PATCH /rest/v1/hands`, `GET /rest/v1/shares` must all return `42501`.

Migrations apply in filename order. `20260916210000` depends on the baseline
having run first.

### The baseline is re-runnable

`20260916190000_phf_baseline.sql` drops the objects it creates before creating
them, so it can be applied repeatedly while iterating. That is safe here only
because the owner authorised a full reset and every stored hand can be
re-derived by re-uploading the source files. **Do not copy that pattern into a
later migration** — a normal migration must be additive, and
`20260916210000_position_search_and_anonymization.sql` is the worked example of
one: it adds columns, backfills them from `phf`, and drops nothing.

One consequence to remember: because the baseline recreates `hands` and
`hands_normalize()` from scratch, re-running it reverts the later migration.
Re-apply every migration after it, in order.

The storage-bucket migrations (`20260226123000`, `20260308091000`) are left
untouched. They keep the legacy `frontend-site` Supabase hosting path working,
which a GitHub workflow still references even though production is on Vercel.

---

## Adding a search column later

**Because `phf` is stored in full, every denormalized column is a backfill away.**
That is the single most useful property of this schema, and it means the right
policy is to add a search column when a query needs it — not in anticipation of
one. Speculative denormalization costs a migration now *and* forever after; a
deferred one costs a five-minute migration exactly when someone wants it.

**This is not a theory — it is how the position columns got here.** They were
added by `20260916210000`, a whole parser project after the baseline, and all
three were reconstructed for **169 already-stored rows** purely from `phf`, with
no re-upload and no data loss. 165 of the 169 got a full position roster; the
other 4 correctly got none, because those hands have an unknown button and PHF
declines to guess a position it cannot resolve.

So when you are tempted to add a column "while we are in here" because it might
be wanted later: it will cost the same then as now, and you will know by then
whether anyone actually wants it. Here is the whole pattern:

```sql
alter table public.hands add column player_positions text[] not null default '{}';

update public.hands h
set player_positions = coalesce((
  select array_agg(distinct p ->> 'position')
  from jsonb_array_elements(h.phf -> 'players') as p
  where p ->> 'position' is not null
), '{}'::text[]);
```

Do the same for the next one, then teach `handInsertFromPhf` to send it,
`toHandSummary` to read it, and `save_hands` / `search_hands` to carry it.

### Deliberately not denormalized (yet)

PHF carries more than the search layer projects. These are the fields most
likely to be asked for next, and why they are still only in `phf`:

| PHF field | Candidate query | Status |
| --- | --- | --- |
| `PhfTable.fastFold` | "my Zoom hands" — a genuinely different game strategically, and a clean low-cardinality split | **Strongest candidate.** It is the brand string (`Zoom`, `Rush`, `Snap`), so it would make a good facet as well as a filter. Add it the moment a UI offers the toggle. |
| `PhfChipMovement` | "hands with a Splash the Pot / bad-beat drop" | Niche. Note that it does **not** disturb the existing columns: `total_pot` is still `results.totalPot` and chip conservation is now `Σ contributions + Σ house-into-pot === totalPot`, so a pot that exceeds the sum of player contributions is now legal and correct. |
| `PhfTournament.bounty`, `prizePool` | "PKO hands", "tournaments over $X" | Niche; `tournament_id` already supports the drill-down that matters. |

`rake` is computed with PHF's own `totalFees()` rather than by summing the fee
breakdown here, so new fee categories are picked up automatically without a
schema change.

---

## Triaging the unparsed corpus into new parsers

The corpus exists so that "we cannot convert this site yet" becomes a work item
instead of a shrug. The loop:

**1. Find the biggest gap.**

```sql
select * from public.unparsed_gaps order by total_occurrences desc limit 20;
```

or from the app, `fetchUnparsedSummary()`. Read the columns together:

* `stage = 'detect'` with a `null` site — nobody recognises this format.
  **Write a new detector + parser.**
* `stage = 'detect'` with a site and low `detection_confidence` — the detector
  is too timid. **Tune the existing detector's signals**, do not write a parser.
* `stage = 'parse'` with a known site — our parser has a hole. **Fix the
  existing parser**; the sample in `raw_text` is your test case.
* `stage = 'validate'` — it parsed but the numbers do not add up. Usually a
  missing action type or an ante model we do not model. **Highest-value bugs**,
  because they mean we may be storing wrong hands elsewhere too.
* `stage = 'serialize'` — valid PHF that the text renderer chokes on. Affects
  Holdem Manager export only.

`total_occurrences ≫ distinct_hands` means many users hit the same thing; a
large `distinct_hands` means a whole format is missing.

**2. Pull the samples.**

```sql
select fingerprint, source_filename, raw_text
from public.unparsed_hands
where detected_site is not distinct from 'pokerstars' and reason = 'unknown-site'
order by occurrences desc
limit 5;
```

**3. Mark them as being worked on** (service role — the anon key cannot write
`status`):

```sql
update public.unparsed_hands
set status = 'triaged',
    notes  = 'PokerStars Zoom header variant; see PR #42'
where fingerprint in ('…');
```

**4. Write the parser** in `frontend/src/lib/parsers/`, using the `raw_text`
samples as fixtures. Register it with `registerParser()`.

**5. Close the loop.** After the release, set `status = 'parser-written'` for the
fingerprints it covers. If they stop reappearing — `last_seen_at` stops moving
while `parser_version` in new records advances — the fix landed. If they *do*
reappear with a newer `parser_version`, the RPC refreshes `stage`/`reason`/
`message` on every hit, so the row now tells you how it fails *today*, which is
exactly the signal you want.

**6. `wontfix`** is for corrupt uploads, non-hand-history text, and formats
deliberately out of scope. Marking them keeps the `new` queue meaningful.

Statuses are never touched by ingestion, so a re-upload cannot silently reopen
something you already decided about.

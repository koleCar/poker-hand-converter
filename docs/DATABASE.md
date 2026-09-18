# Database

Supabase project `riybwcfnclphacnfawiq` (`poker converter`). Postgres 17.

The schema is defined by one baseline migration,
`supabase/migrations/20260916190000_phf_baseline.sql`. The client layer that
talks to it is `frontend/src/lib/db/`. Nothing else in the app touches Supabase.

- [Threat model](#threat-model-read-this-first)
- [Tables](#tables)
- [Functions (RPCs)](#functions-rpcs)
- [RLS policies and grants](#rls-policies-and-grants)
- [Indexes and the queries they serve](#indexes-and-the-queries-they-serve)
- [Applying a migration](#applying-a-migration)
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
| `hero_seat`, `hero_position` | smallint / text | hero player | `BTN`, `CO`, `UTG+1`… enables "3-bet from the CO" style filters. |
| `hero_cards` | text[] | hero `holeCards` | GIN-indexed; "hero held Ah". Normalized to canonical `Rs` casing by a trigger. |
| `hero_hand_class` | text | derived | `AKs` / `AKo` / `TT`. The filter players actually think in. Null for non-two-card variants. |
| `board_cards` | text[] | primary runout | GIN-indexed; "board contains Qh Jh". **Primary runout only** — including a run-it-twice second board would make the filter match a card that only ever appeared on the second run. |
| `player_names` | text[] | all players | GIN-indexed; "hands where villain X was at the table". |
| `player_count` | smallint | `players.length` | Table size filter. |
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

**Constraints worth knowing**: `hero_cards` ≤ 6 and `board_cards` ≤ 10 entries,
all structurally valid card codes; `player_names`/`winners` ≤ 24; `total_pot`,
`rake` and the blinds non-negative; `phf` must be a JSON object whose `schema`
(if present) starts with `phf/`; `hero_hand_class` must match `^[2-9TJQKA]{2}[so]?$`.

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
`heroWonOnly`, `minPot`, `from`, `to`, `sort`. Card arrays are normalized
server-side, so `["ah","KH"]` matches. Sort: `played_desc` (default),
`played_asc`, `pot_desc`, `profit_desc`, `profit_asc`, `created_desc`.

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

```bash
# The personal access token lives in the macOS keychain, base64-wrapped by the
# Go keyring library the CLI uses.
PAT=$(security find-generic-password -s "Supabase CLI" -a supabase -w \
      | sed 's/^go-keyring-base64://' | base64 -d)

curl -X POST "https://api.supabase.com/v1/projects/riybwcfnclphacnfawiq/database/query" \
  -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json;print(json.dumps({'query':open('supabase/migrations/20260916190000_phf_baseline.sql').read()}))")"
```

The endpoint runs the whole file in one transaction and returns `[]` with HTTP
201 on success, or `{"message": "Failed to run sql query: ERROR: ..."}` with 400.

Then keep the CLI's migration history in sync by hand, or the next person to run
`supabase migration list` will see drift:

```bash
curl -X POST "https://api.supabase.com/v1/projects/riybwcfnclphacnfawiq/database/query" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{"query":"insert into supabase_migrations.schema_migrations (version, name) values ('"'"'20260916190000'"'"', '"'"'phf_baseline'"'"') on conflict (version) do nothing;"}'
```

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

### The baseline is re-runnable

`20260916190000_phf_baseline.sql` drops the objects it creates before creating
them, so it can be applied repeatedly while iterating. That is safe here only
because the owner authorised a full reset and every stored hand can be
re-derived by re-uploading the source files. **Do not copy that pattern into a
later migration** — a normal migration must be additive.

The storage-bucket migrations (`20260226123000`, `20260308091000`) are left
untouched. They keep the legacy `frontend-site` Supabase hosting path working,
which a GitHub workflow still references even though production is on Vercel.

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

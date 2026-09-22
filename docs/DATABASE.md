# Database

Supabase project `riybwcfnclphacnfawiq` (`poker converter`). Postgres 17.

The schema is defined by three migrations:

| Migration | What it does |
| --- | --- |
| `20260916190000_phf_baseline.sql` | The baseline: `hands`, `unparsed_hands`, `shares`, RLS, RPCs. |
| `20260916210000_position_search_and_anonymization.sql` | Adds `site_anonymization` and the position search columns. |
| `20260922130000_user_accounts_and_ownership.sql` | Adds accounts: `hands.owner_id`, owner-scoped RLS, per-library dedupe, `shares.owner_id`, `unparsed_hands.submitted_by`. |

The client layer that talks to them is `frontend/src/lib/db/`. Nothing else in
the app touches Supabase.

- [Threat model](#threat-model-read-this-first)
- [Verifying the isolation](#verifying-the-isolation)
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

**The app has accounts, and the database is the only thing enforcing them.**
The deployed bundle is a public static asset, so `VITE_SUPABASE_ANON_KEY` is
public by construction: anyone can read it out of the JavaScript and talk to
PostgREST directly with `curl`, with any JWT they legitimately hold. So the
question every policy answers is not "will the UI ask for this" but "what
happens when a signed-in stranger asks for it directly".

There are exactly three kinds of caller:

| Caller | What they are | What they can reach |
| --- | --- | --- |
| **`anon`** | Logged out, or a guest who chose to carry on without an account | `resolve_share(slug)` and nothing else. No grant on `hands`, no write anywhere. |
| **`authenticated`** | Signed in, identified by `auth.uid()` | Their own hands, their own shares, their own corpus samples. Nobody else's, by any query. |
| **`service_role`** | Us, from the dashboard or the Management API | Everything. Triage, cleanup, backfills. |

The rules the schema holds to:

| # | Rule | Why |
| --- | --- | --- |
| 1 | A hand belongs to exactly one account | `hands.owner_id` is `not null` and references `auth.users`. Both policies on the table are `owner_id = (select auth.uid())`, so there is no client-constructible query that returns another person's hand. |
| 2 | A client can never choose the owner | `save_hands` writes `auth.uid()` explicitly and ignores the payload's `owner_id`; the normalizing trigger overwrites it again; the RLS `with check` rejects the row regardless. Three independent guards, because the payload goes through `jsonb_populate_recordset` and is fully attacker-controlled. |
| 3 | Dedupe is per library | `(owner_id, hand_key)`, not `hand_key`. A global key would tell the second uploader of a hand "duplicate" and then show them nothing — the row they collided with is not theirs to read. |
| 4 | Anon may **never** write anything | `save_hands`, `create_share` and `record_conversion_failures` are revoked from `anon` *and* raise an explicit "you must be signed in" error, so the client gets a sentence instead of `42501`. |
| 5 | Nobody may update or delete anything | Data loss is the one outcome we refuse to expose. No table has an `UPDATE` or `DELETE` policy — not even for the owner — and the grants do not include those verbs. "Delete my hand" is a real feature, but it needs its own UI and its own confirmation, and the verb should not exist before something guards it. |
| 6 | Counters move only inside `security definer` functions | Share views and failure occurrences *have* to increment, but a general `UPDATE` grant would also let a caller rewrite hands. |
| 7 | A share slug is a capability URL, and works for anyone | `shares` has no grants and no policies at all. `resolve_share(slug)` is the only door, takes an exact slug, and is `security definer` — so it deliberately reads past the owner policy on `hands`. That *is* the feature: send someone a link and they replay the hand with no account. |
| 8 | Raw uploads are not public | `unparsed_hands.raw_text` is verbatim hand history somebody uploaded. It is readable only by its submitter. The row itself stays globally deduped, because `occurrences` is the entire point of the table. |
| 9 | Junk volume is bounded | `CHECK` constraints cap text sizes and validate shapes; a statement-level trigger enforces a global insert-rate budget. |

Anything destructive (deleting junk, retiring corpus rows, editing triage
status) is a **service role** operation, done from the Supabase dashboard SQL
editor or through the Management API.

### What a signed-in attacker can actually do

* Fill **their own** library with junk, until the rate limiter closes the
  window. Cost: some rows to clean up, attributable to one account.
* Create share links to their own hands. Bounded to 300/hour globally.
* Resolve a share slug they already know. That is the feature.

### What they cannot do

* Read, write, modify or delete another account's hand — including by putting
  someone else's `owner_id` in the payload, or by guessing a hand `id`.
* Mint a share link to a hand they do not own. `create_share` is `security
  definer`, so RLS does **not** protect it; the ownership check is written out
  explicitly, and it returns the same error for "no such hand" and "not yours"
  so it cannot be used as an existence oracle.
* List share slugs, or read another account's raw corpus sample.
* Read or write `ingest_rate_limit`, or call `enforce_rate_limit` /
  `generate_share_slug` (both revoked from `anon` and `authenticated` — note
  that Supabase's default privileges grant `EXECUTE` on new functions to those
  roles, so a bare `revoke ... from public` is *not* enough and the migration
  revokes them by name).
* Store an unbounded blob: `hands.source_text` and `hands.standard_text` are
  capped at 200 000 characters, `hands.phf` at 1 MiB, and
  `unparsed_hands.raw_text` at 128 KiB.

All of the above is verified live against the deployed project rather than
argued from the SQL; the script is in
[Verifying the isolation](#verifying-the-isolation).

### Rate limiting

`ingest_rate_limit` predates accounts and is still keyed by *bucket*, not by
user: it is a **global** fixed-window circuit breaker, not fair-share
throttling. It turns "someone scripts inserts overnight" into "someone gets
errors after a while".

Accounts now make a per-user limiter possible — `auth.uid()` is a key the old
model did not have — and that would be the right change if one account ever
manages to exhaust a shared budget and lock everyone else out. It has not been
made yet because the budgets are an order of magnitude above real use, and a
per-user counter is a strictly larger table with a cleanup job attached.

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
| `create_share` | **definer** | `shares` is sealed from clients. The function generates the slug itself, so a caller cannot choose one — and because being definer means RLS on `hands` does not apply inside it, it checks `owner_id` by hand. |
| `resolve_share` | **definer** | Reads a sealed table *and* increments `views`, which is an `UPDATE`. Keyed strictly by slug equality, returns exactly one row. |
| `enforce_rate_limit` | **definer** | The counter table is unreachable from anon. Not granted to clients. |
| `hands_rate_limit` (trigger) | **definer** | Has to call `enforce_rate_limit`, which anon cannot execute. |

---

## Verifying the isolation

A migration returning `201` proves the SQL ran, not that two accounts are
actually separated. Prove it the way an attacker would: with two real JWTs and
`curl`. The Management-API PAT is a superuser and proves nothing about RLS, so
it must not appear anywhere in this test.

Run it after **any** change to the policies, to `save_hands`, or to
`create_share`. It is the cheapest regression test in the project.

```bash
cd frontend  # .env.local has the URL and anon key
URL=$(grep VITE_SUPABASE_URL .env.local | cut -d'"' -f2)
KEY=$(grep VITE_SUPABASE_ANON_KEY .env.local | cut -d'"' -f2)
TAG=$(openssl rand -hex 4)

signup() {  # -> access token
  curl -s -X POST "$URL/auth/v1/signup" -H "apikey: $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$1-$TAG@example.com\",\"password\":\"test-pw-123456\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}
rpc() {     # rpc <fn> <json> [token]
  curl -s -X POST "$URL/rest/v1/rpc/$1" -H "apikey: $KEY" \
    -H "Authorization: Bearer ${3:-$KEY}" -H "Content-Type: application/json" -d "$2"
}

A=$(signup a); B=$(signup b)
HAND='{"hand_key":"pokerstars:'"$TAG"'","phf":{"schema":"phf/1"},"standard_text":"x","site":"pokerstars"}'

rpc save_hands   "{\"p_hands\":[$HAND]}" "$A"   # -> inserted 1
rpc search_hands '{"p_filters":{}}'      "$B"   # -> total 0        <- the whole point
rpc save_hands   "{\"p_hands\":[$HAND]}" "$B"   # -> inserted 1, NOT a duplicate
rpc search_hands '{"p_filters":{}}'      ""     # -> permission denied for anon
```

The full version of this — nineteen assertions covering forged `owner_id`,
cross-account `get_hand`, sharing somebody else's hand, and corpus reads — was
run against the live project when accounts landed and all nineteen passed. The
cases that matter most, because each one is a silent leak rather than a loud
failure:

| Attempt | Expected |
| --- | --- |
| B calls `search_hands` after A saved | `total: 0` |
| B calls `get_hand(A's id)` | `null` |
| A sends `owner_id: <B's id>` in `save_hands` | Row lands on **A**; B's library stays empty |
| B saves a `hand_key` A already has | `inserted: 1` — a new row, not a duplicate |
| B calls `create_share(A's hand id)` | Error, identical to "no such hand" |
| anon calls `search_hands` / `save_hands` / `create_share` | Permission denied |
| anon calls `resolve_share(slug of A's hand)` | **Succeeds** — this one must not be locked down |
| anon `GET /rest/v1/hands` or `/rest/v1/shares` | `42501` |
| B reads `unparsed_hands` after A submitted a sample | `[]` |

Remember to delete the test accounts afterwards; `on delete cascade` takes
their hands and shares with them.

```sql
delete from auth.users where email like '%@example.com';
```

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
| `owner_id` | uuid → `auth.users` | server `auth.uid()` | **The access-control column.** Both RLS policies compare against it. `on delete cascade`, so deleting an account takes its library with it. A client cannot set it — see rule 2 of the threat model. |
| `hand_key` | text, unique **with `owner_id`** | `"<meta.siteId>:<meta.handKey>"` | Dedupe within one library. Re-uploading the same file is a no-op; uploading a hand another account already has is a new row. PHF's own `handKey` is only unique *within* a site, so the site prefix is what makes it safe to compare at all. |
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
| `submitted_by` | The account that **first** submitted this sample, and the only one that can read `raw_text` back. Later submitters bump `occurrences` without taking over the row: re-attributing it would silently move read access between accounts. Rows collected before accounts existed have `null` here and are readable only by the service role. |

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
| `owner_id` | Who created the link. **Not** a read gate — `resolve_share` ignores it, because a link has to work for a stranger. It exists so a link is attributable and so a deleted account takes its links with it. |
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

| Function | Callable by | Returns | What it does |
| --- | --- | --- | --- |
| `save_hands(p_hands jsonb)` | `authenticated` | `{received, inserted, duplicates}` | Batch-inserts hands **into the caller's library**, deduping on `(owner_id, hand_key)` with `ON CONFLICT DO NOTHING`. Returns exact counts, which is what removes the old "probe which of these already exist" round trips. Ignores any `owner_id` in the payload. Max 500 per call. |
| `search_hands(p_filters jsonb, p_limit int, p_offset int)` | `authenticated` | `{total, limit, offset, rows}` | The whole browse filter set, sorted, paginated, **with the total count**, in one call. Scoped to the caller by RLS, not by a filter — there is no filter key that could ask for anyone else's hands. Sort keys are whitelisted, so the query stays on an index. Heavy columns (`phf`, `standard_text`, `source_text`) are excluded: a page of 50 hands should be kilobytes. |
| `get_hand(p_id uuid)` | `authenticated` | full row as jsonb | The payload, fetched only when a hand is actually opened. `null` for an unknown id *and* for another account's id — indistinguishable by design. |
| `hands_facets()` | `authenticated` | jsonb | Every distinct filter value the browse UI offers — sites, heroes, tables, stakes, variants, limit types, formats, hand classes, streets, the `played_at` range — for the caller's own hands. A site you have never played is not a useful filter to offer. |
| `record_conversion_failures(p_failures jsonb)` | `authenticated` | `{received, created, updated, skipped}` | Upserts `ConversionFailure` records by fingerprint, incrementing `occurrences` atomically and recording the first submitter. Truncates over-long fields and skips malformed records rather than failing the batch: losing a sample we cannot reproduce is worse than storing a lossy one. Never writes `status` or `notes`. Max 200 per call. |
| `unparsed_summary(p_limit int)` | `anon`, `authenticated` | jsonb | `unparsed_gaps` ordered by impact, plus totals and a `byStatus` breakdown. `security invoker`, so a client sees only its own submissions; the cross-corpus answer to "which converter next" is a service-role query. |
| `create_share(p_hand_id, p_phf, p_standard_text, p_title)` | `authenticated` | `{id, slug}` | Allocates a slug (retrying on collision) and inserts one row owned by the caller. **Refuses a `p_hand_id` the caller does not own** — it is `security definer`, so this check is not optional. |
| `resolve_share(p_slug text)` | `anon`, `authenticated` | jsonb or `null` | Resolves a slug **and** increments its view counter, in one round trip. Returns the share plus the joined hand, ignoring ownership entirely — a link works for anyone, which is the point. `null` for unknown *or* malformed slugs, deliberately indistinguishable, so probing tells an attacker nothing. |
| `enforce_rate_limit(...)` | `service_role` | void | Internal. |
| `generate_share_slug(int)` | `service_role` | text | Internal. |

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

| Table | `anon` | `authenticated` | Policies |
| --- | --- | --- | --- |
| `hands` | **none** | `SELECT`, `INSERT` | `hands_owner_select` / `hands_owner_insert`, both `owner_id = (select auth.uid())`. No `UPDATE`/`DELETE` policy — with RLS on and no permissive policy, both are refused regardless of grants, for owners too. |
| `unparsed_hands` | `SELECT` | `SELECT` | `unparsed_own_select` (`submitted_by = (select auth.uid())`). Writes go through the definer RPC; a direct `INSERT` would let a caller invent an occurrence count or set `status = 'wontfix'` on someone else's row. |
| `unparsed_gaps` (view) | `SELECT` | `SELECT` | `security_invoker`, so the base table's policy applies. |
| `shares` | **none** | **none** | **none**. Sealed. `create_share` / `resolve_share` only. |
| `ingest_rate_limit` | **none** | **none** | **none**. Internal. |

Why `anon` keeps a `SELECT` *grant* on `unparsed_hands` while having none on
`hands`: a missing grant raises `42501` before RLS is consulted, and
`unparsed_summary()` is `security invoker` and granted to `anon`. Leaving the
grant lets it answer zeros for a logged-out caller instead of erroring, and the
policy — false for a null `auth.uid()` — is what actually keeps the rows away.
`hands` needs no such accommodation because every function that reads it is
revoked from `anon` outright.

`(select auth.uid())` rather than a bare `auth.uid()` in every policy: Postgres
hoists the scalar subquery into an InitPlan and evaluates it once per statement
instead of once per row.

### `owner_id` is checked twice, on purpose

RLS covers the `security invoker` functions — `save_hands`, `search_hands`,
`get_hand`, `hands_facets` all inherit the owner policy for free, and that is
why none of them contains an owner filter.

It does **not** cover `create_share`, which is `security definer` and therefore
runs with the function owner's privileges, seeing every row in `hands`. Without
an explicit `h.owner_id = auth.uid()` in its body, any signed-in caller could
mint a public link to a stranger's hand by guessing a uuid. That check is the
single most load-bearing line in the migration, and it returns the same error
for "no such hand" as for "not your hand" so it cannot be used to probe which
uuids exist.

### Data-shape invariants are enforced, not conventional

RLS answers "whose rows may this caller touch". It says nothing about *what*
they write into their own — and having an account does not make a client
trustworthy: a bug and an attacker are still indistinguishable from the
server's side. So the rules that keep the data honest are `CHECK` constraints,
not client discipline.

The one that matters most is `hands_positional_anonymity`, because violating it
produces a filter that looks like it works (see
[Player identity](#player-identity-and-anonymized-rooms)). Probed live with a
real signed-in JWT (the anon key can no longer insert at all), sending rows a
correct client would never send:

| Attempt | Result |
| --- | --- |
| `site_anonymization='positional'` **+** `player_names=['Dealer','UTG+1']` | `23514 hands_positional_anonymity` |
| `site_anonymization='positional'` **+** `winners=['Dealer']` | `23514 hands_positional_anonymity` |
| `showdown_positions=['MIDDLE']` | `23514 hands_showdown_positions_ok` |
| `hero_position='MIDDLE'` | `23514 hands_hero_position_ok` |

All four rejected. A client cannot smuggle per-hand pseudonyms into the identity
columns, by bug or on purpose, and cannot invent a position outside the PHF
vocabulary — which is what lets the position filters be treated as total.

Re-run these after any change to `save_hands` or the `hands` constraints,
alongside [the isolation checks](#verifying-the-isolation). A `201` on the
migration tells you nothing about whether either still holds.

---

## Indexes and the queries they serve

Indexes were chosen from the browse UI's actual query shape, which is "one or
two filters plus a sort", not by reflexively indexing every column.

| Index | Query it serves |
| --- | --- |
| `hands_owner_hand_key_uidx` (unique, `(owner_id, hand_key)`) | Dedupe on insert, per library; `findHandId()`. Replaced the globally-unique `hands_hand_key_uidx` when accounts landed — see rule 3 of the threat model for why a global key is a correctness bug, not just a policy choice. |
| `hands_owner_played_idx` (`(owner_id, played_at desc)`) | The default list order, which is now always "my hands, newest first". The owner predicate is on every single query, so it belongs at the front of the sort index. |
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
having run first, and `20260922130000` depends on both.

### `20260922130000` is destructive and must not be re-run

It opens with `delete from public.shares; delete from public.hands;`. That was
correct exactly once: the 914 hands stored before accounts existed had no owner
and no way to acquire one, so they could not be made reachable under the new
policies, and clearing them is what let `owner_id` be `not null` rather than a
nullable column every query has to remember. Re-running the file today would
delete real user libraries. Everything after those two statements is idempotent
(`add column if not exists`, `create or replace`), so if you need to re-apply
it, delete the two `delete` statements first.

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

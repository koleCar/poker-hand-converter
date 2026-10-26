# Database

Supabase project `riybwcfnclphacnfawiq` (`poker converter`). Postgres 17.

The schema is defined by four migrations:

| Migration | What it does |
| --- | --- |
| `20260916190000_phf_baseline.sql` | The baseline: `hands`, `unparsed_hands`, `shares`, RLS, RPCs. |
| `20260916210000_position_search_and_anonymization.sql` | Adds `site_anonymization` and the position search columns. |
| `20260922130000_user_accounts_and_ownership.sql` | Adds accounts: `hands.owner_id`, owner-scoped RLS, per-library dedupe, `shares.owner_id`, `unparsed_hands.submitted_by`. |
| `20261003090000_share_projection.sql` | Splits `resolve_share` into `read_share` + `record_share_view` and stops the share payload from being a whole `hands` row. See [Share resolution](#share-resolution-read_share--record_share_view). |
| `20261007090000_forum_identity.sql` | Profiles, usernames, reservations, roles and posting gates (F6, #28 / #29). See [Identity](#identity-profiles-usernames-and-gates). |
| `20261012090000_forum_publishing.sql` | Published hands: a scrubbed copy, `scrub_phf`, `publish_hand` (F7, #30 / #31). See [Publishing](#publishing-a-hand). |
| `20261019090000_forum_core.sql` | Boards, posts, threaded and anchored comments, votes, ranking, audit, search (F8, #32–#34, #37). See [The forum](#the-forum). |
| `20261026090000_forum_social.sql` | Saves, thread subscriptions, notifications, mentions, realtime, nightly reconciliation (F9, #38 / #39). See [Notifications](#notifications-and-realtime). |
| `20261102090000_forum_moderation.sql` | Reports, mod queue, moderator and admin powers, bans, shadowbans, revisions, append-only audit, per-actor limits, spam gate (F10, #40 / #41). See [Moderation](#moderation-and-anti-abuse). |
| `20270414090000_unparsed_registry.sql` | Rail R0.11: `unparsed_hands` becomes the unsupported-format registry for the desktop app too - `origin`, `os`, `client_version`, `consented_at`, `anonymiser_version`, `guessed_site`, `guess_confidence`, the consent rule, two more `unparsed_gaps` columns. See [`unparsed_hands`](#unparsed_hands--the-failure-corpus) and `docs/unsupported-formats.md`. |
| `20270421090000_desktop_sign_in.sql` | Rail R1.7: `claim_desktop_sign_in()`, the per-account budget of the desktop sign-in handoff (10 an hour). The handoff itself is the Edge Function `supabase/functions/desktop-handoff`. See [Desktop sign-in](#desktop-sign-in-the-edge-function-desktop-handoff). |
| `20270428090000_desktop_ingest.sql` | Rail R1.8: hands synced by the desktop app. `hands.origin`, `standard_text` nullable for desktop rows only (Q4: PHF only, no standard or source text), `hand_sources`, `register_hand_source`, `ingest_hands` (every search column derived from the PHF on the server), per-account desktop budgets. See [Desktop ingest](#desktop-ingest-hand_sources-and-ingest_hands). |
| `20270505090000_desktop_pull.sql` | Rail R1.9: the desktop sync worker's pull. `hands_since(p_after_created, p_after_id, p_limit)` (invoker, the caller's rows by keyset `(created_at, id)`, ids / keys / origins only, rows at least a minute old) and its index `hands_owner_created_idx`. See [The desktop pull](#the-desktop-pull-hands_since). |
| `20270602090000_hud_layouts.sql` | Rail R3.9: the desktop HUD's designs, assignments, dragged panel positions and per-room settings follow the account to another computer. `hud_layouts` (one row per owner, kind and key; a null body is a tombstone; last writer wins by the client's `updated_at`), select-own RLS, written only by `put_hud_layouts(p_rows)` (definer). See [The HUD's layouts](#the-huds-layouts-hud_layouts). Not applied to production. |
| `20270609090000_hand_origin_upload.sql`, `20270609091000_web_bulk_upload.sql` | Rail R4.2: the web's bulk upload. `hand_origin` gains `upload`; `register_web_hand_source()` (the account's one web source); `ingest_hands` takes it besides the app's folders and writes `origin = 'upload'` rows (PHF only, as desktop rows); the private bucket `hand-uploads` with owner-folder policies for the opt-in originals (A2). See [Web bulk upload](#web-bulk-upload-the-web-source-and-hand-uploads). Not applied to production. |
| `20270512090000_hand_arrivals.sql` | Rail R1.10: live arrival on the web. `hand_arrivals` (one row per account, bumped once per insert statement on `hands` by the statement trigger `hands_signal_arrival`: a counter, how many hands, their origin, the time; no hand content), select-own RLS, in the `supabase_realtime` publication; `hands` stays out of it. See [Live arrival on the web](#live-arrival-on-the-web-hand_arrivals). |
| `20270616090000_live_activity.sql` | Rail R4.3: live progress of an upload in the account's other tabs and devices. The first `realtime.messages` policies: on the private channel `activity:<uid>`, the account itself may receive (presence, broadcast) and send presence; nobody else, not `anon`, no broadcast sent. No table, no function, no per-batch write (Presence lives in Realtime's memory). See [Live progress across tabs](#live-progress-across-tabs-activityuid). Not applied to production. |
| `20270623093000_stats_seats_and_budget.sql` | Rail R4.4 findings F1, F2: seat numbers past 24 (Ignition tournaments) - `hand_stats.seat`, `hand_stats_ev.seat`, `hand_analysis.hero_seat` any `smallint` from 0, `comments.anchor_seat` from 1; statistics inserts charged per account (`hand_stats_insert:<uid>` 1 000 000 / 10 min, `hand_stats_insert_day:<uid>` 10 000 000 / day) with the global `hand_stats_insert` a 3 000 000 / 10 min ceiling, through `hand_stats_charge_budget()` (no client grant). See [Rate limiting](#rate-limiting) and the statistics rebuild. Not applied to production. |

Later migrations not listed above (`share_spoilers`, `omaha_hand_class`,
`hand_stats`, `hand_stats_prune`) carry their own reasoning in their headers.

The client layer that talks to them is `frontend/src/lib/db/`. Nothing else in
the app touches Supabase.

- [Threat model](#threat-model-read-this-first)
- [Verifying the isolation](#verifying-the-isolation)
- [Tables](#tables)
- [Player identity and anonymized rooms](#player-identity-and-anonymized-rooms)
- [Functions (RPCs)](#functions-rpcs)
- [Identity: profiles, usernames and gates](#identity-profiles-usernames-and-gates)
- [Publishing a hand](#publishing-a-hand)
- [The forum](#the-forum)
- [Notifications and realtime](#notifications-and-realtime)
- [Moderation and anti-abuse](#moderation-and-anti-abuse)
- [Hand analysis](#hand-analysis-hand_analysis-decision_analysis)
- [Desktop ingest](#desktop-ingest-hand_sources-and-ingest_hands)
- [RLS policies and grants](#rls-policies-and-grants)
- [Indexes and the queries they serve](#indexes-and-the-queries-they-serve)
- [Applying a migration](#applying-a-migration)
- [Adding a search column later](#adding-a-search-column-later)
- [Triaging the unparsed corpus into new parsers](#triaging-the-unparsed-corpus-into-new-parsers)

---

## Threat model (read this first)

**The app has accounts, and the database is the only thing enforcing them.**
The deployed bundle is public, so `NEXT_PUBLIC_SUPABASE_ANON_KEY` is public by
construction: anyone can read it out of the JavaScript and talk to
PostgREST directly with `curl`, with any JWT they legitimately hold. So the
question every policy answers is not "will the UI ask for this" but "what
happens when a signed-in stranger asks for it directly".

There are exactly three kinds of caller:

| Caller | What they are | What they can reach |
| --- | --- | --- |
| **`anon`** | Logged out, or a guest who chose to carry on without an account | `read_share(slug)` / `record_share_view(slug)`, the `profiles_public` view, `resolve_username(name)`, visible rows of `published_hands` (plus `read_published_hand` / `published_hands_by_author`), and `read_shared_analysis(surface, id, version)` — a hand's analysis, only where its owner shared it and the hand is already public to the caller. No grant on `hands` or `profiles`, no write anywhere except that one view counter. |
| **`authenticated`** | Signed in, identified by `auth.uid()` | Their own hands, their own shares, their own corpus samples. Nobody else's, by any query. |
| **`service_role`** | Us, from the dashboard or the Management API; and one Edge Function, `desktop-handoff` (R1.7), with the runtime's own key | Everything. Triage, cleanup, backfills. The function uses it for exactly one call: minting a one-time sign-in token for the account whose JWT called it ([Desktop sign-in](#desktop-sign-in-the-edge-function-desktop-handoff)). |

The rules the schema holds to:

| # | Rule | Why |
| --- | --- | --- |
| 1 | A hand belongs to exactly one account | `hands.owner_id` is `not null` and references `auth.users`. Both policies on the table are `owner_id = (select auth.uid())`, so there is no client-constructible query that returns another person's hand. |
| 2 | A client can never choose the owner | `save_hands` writes `auth.uid()` explicitly and ignores the payload's `owner_id`; the normalizing trigger overwrites it again; the RLS `with check` rejects the row regardless. Three independent guards, because the payload goes through `jsonb_populate_recordset` and is fully attacker-controlled. |
| 3 | Dedupe is per library | `(owner_id, hand_key)`, not `hand_key`. A global key would tell the second uploader of a hand "duplicate" and then show them nothing — the row they collided with is not theirs to read. |
| 4 | Anon may **never** write anything | `save_hands`, `create_share` and `record_conversion_failures` are revoked from `anon` *and* raise an explicit "you must be signed in" error, so the client gets a sentence instead of `42501`. |
| 5 | No client role holds an `UPDATE` or `DELETE` grant, on any table, ever | Rewritten for the forum (F8), not dropped. Edits, deletes and changed votes exist now, and every one is a narrow `security definer` function: actor from `auth.uid()`, ownership checked explicitly, a whitelisted column set, a `moderation_actions` row in the same transaction, and `enforce_rate_limit`. **A definer function fails closed when a column is added; an UPDATE policy fails open** — it lets the caller set every granted column (`score`, `hot_rank`, `author_id`) until its `with check` is amended. Deletes are soft everywhere. |
| 6 | Counters move only inside `security definer` functions | Share views and failure occurrences *have* to increment, but a general `UPDATE` grant would also let a caller rewrite hands. |
| 7 | A share slug is a capability URL, and works for anyone | `shares` has no grants and no policies at all. `read_share(slug)` is the only door, takes an exact slug, and is `security definer` — so it deliberately reads past the owner policy on `hands`. That *is* the feature: send someone a link and they replay the hand with no account. |
| 7a | A capability URL means the **payload** is the boundary | There is no authentication step left to tighten once the slug is out, so the only control is what the function returns. `read_share` names every output key; it never does `select to_jsonb(row)`. See [Share resolution](#share-resolution-read_share--record_share_view). |
| 8 | Raw uploads are not public | `unparsed_hands.raw_text` is verbatim hand history somebody uploaded. It is readable only by its submitter. The row itself stays globally deduped, because `occurrences` is the entire point of the table. |
| 8a | A desktop sample leaves the machine only anonymised, and only with consent | A desktop row (`origin = 'desktop'`) must carry `consented_at`, `anonymiser_version`, `os` and `client_version` and be at most 64 KiB: the RPC skips a record without them and a `CHECK` constraint refuses such a row from any writer. The database cannot see that a text is anonymised; the client sends only `rail_core::anonymise` output (tested over the whole corpus), and `anonymiser_version` lets rows from a faulty version be found and deleted. |
| 8b | A desktop hand is its PHF and nothing else, and only one door writes it | Q4: a row with `origin = 'desktop'` (or, since R4.2, `'upload'`: the web's bulk save) has no `standard_text`, no `source_text` and an empty `meta.rawText` (CHECK `hands_text_by_origin`, any writer). The insert policy admits `origin = 'web'` only, so `ingest_hands` (definer) is the one way in, and it derives every search column from the PHF itself: a desktop client cannot set them. |
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
That point came for the desktop-sized writes: hand ingest (R1.8, R4.2) and
statistics (R4.4's F2) are charged per account, because one 1 000 000-hand
library would otherwise hold a shared budget for hours.

| Bucket | Budget | Enforced by |
| --- | --- | --- |
| `hands_insert` | 25 000 **web** rows / 10 min (desktop rows are not counted since R1.8) | `hands_rate_limit()` statement trigger |
| `hand_stats_insert:<user>` | 1 000 000 rows / 10 min **per account**, `hand_stats` and `hand_stats_ev` together (every origin's statistics) | `hand_stats_rate_limit()` / `hand_stats_ev_rate_limit()` statement triggers, through `hand_stats_charge_budget()`, per owner of the rows inserted |
| `hand_stats_insert_day:<user>` | 10 000 000 rows / day **per account** | the same |
| `hand_stats_insert` | 3 000 000 rows / 10 min, everyone: a ceiling, not a share (it was the only bucket, 200 000, until R4.4's finding F2) | the same |
| `unparsed_insert` | 5 000 records / 10 min | `record_conversion_failures()` |
| `share_create` | 300 shares / hour | `create_share()` |
| `share_view:<slug>` | 600 views / hour **per slug** | `record_share_view()` |
| `drill_sync:<user>` | 120 syncs / 10 min **per account** | `sync_drill_items()` |
| `drill_review:<user>` | 600 answers / 10 min **per account** | `review_drill()` |
| `trainer_results:<user>` | 1 200 rows / 10 min **per account** | `record_trainer_results()` |
| `analysis_share:<user>` | 120 switches / 10 min **per account** | `set_analysis_share()` |
| `study_plan:<user>` | 60 plans / 10 min **per account** | `save_study_plan()` |
| `study_task:<user>` | 600 ticks / 10 min **per account** | `set_study_task()` |
| `lesson_results:<user>` | 300 calls (≤ 100 results each) / 10 min **per account** | `record_lesson_results()` |
| `lesson_cards:<user>` | 120 calls (≤ 20 cards each) / 10 min **per account** | `add_lesson_cards()` |
| `lesson_review:<user>` | 600 reviews / 10 min **per account** | `review_lesson_card()` |
| `desktop_sign_in:<user>` | 10 handoffs / hour **per account** | `claim_desktop_sign_in()`, called by the `desktop-handoff` Edge Function as the user |
| `desktop_ingest:<user>` | 150 000 rows / 10 min **per account** | `ingest_hands()`, every row received (duplicates and rejections too) - from the app's folders and from the web's bulk upload (R4.2) alike: one ingest budget per account |
| `desktop_ingest_day:<user>` | 2 000 000 rows / day **per account** | `ingest_hands()` |
| `hand_source:<user>` | 120 registrations / 10 min **per account** | `register_hand_source()`, and `register_web_hand_source()` when it creates the source |

`share_view` is the one per-key bucket, because the thing it protects is
per-key: a view counter anyone can increment by holding a URL is a vanity metric
a `for` loop can ruin, and a global budget would let one hammered link stop
every other link from counting. It accrues one `ingest_rate_limit` row per
viewed slug; the table is tiny and service-role-readable, so pruning stale
windows is a cron job rather than a schema change. Over-budget is **swallowed**
there, not raised — a missed increment is invisible, a raised `53400` is a red
error on a page whose job is to show a hand.

Budgets are an order of magnitude above real use: a 5000-hand upload spends
5 000 of the 25 000 hand budget. Single requests are capped separately — 1 000
rows per `INSERT` statement, 500 hands per `save_hands()` call, 200 records per
`record_conversion_failures()` call.

`ingest_rate_limit` has RLS enabled with **no policies** and all grants revoked,
so it is invisible to the anon key; only the `security definer` functions reach
it.

### Desktop sign-in: the Edge Function `desktop-handoff`

R1.7 (`docs/RAIL-PLAN.md`, amendment A6). The desktop app cannot sign in by
itself - password sign-in needs Turnstile, which is bound to the web's
domain - so it signs in through the web, and this is the one place a
service-role key is used outside the dashboard.

* The app opens `/auth/desktop?v=1&pub=<X25519 public key>&state=<random>&t=<time>`
  in the system browser. The user signs in there as usual and clicks
  "Sign in to Rail" (no silent approval: a page that approved on load would
  sign in whatever program opened it).
* The page calls the function with the user's own access token and
  `{v, pub, state}`. The function refuses a call without a bearer token,
  verifies the token with GoTrue (`GET /auth/v1/user`), refuses an
  anonymous user, a user without an email and **an unconfirmed email** (a
  magic link confirms the address it is for, so minting one would confirm
  an address nobody proved), spends one unit of `claim_desktop_sign_in()`
  **as the user**, and only then calls
  `POST /auth/v1/admin/generate_link {type: "magiclink", email}` with the
  service role. Nothing is emailed. It checks the token was minted for the
  same user id.
* It returns the token **encrypted** to `pub` (ephemeral X25519, HKDF-SHA-256,
  AES-256-GCM, `state` as associated data). The browser only ever holds
  ciphertext; the page redirects to `rail://auth/callback?state=..&payload=..`,
  and only the app instance that holds the private key can open it. The app
  redeems the token at `/auth/v1/verify`, which gives it **its own session**:
  the browser's refresh token never reaches the app (two clients rotating one
  refresh token would trip GoTrue's reuse detection and end both).
* Logs carry outcomes only - no token, email, user id or body.
* Side effect worth knowing: GoTrue keeps one magic-link/recovery token per
  user, so a desktop sign-in invalidates a password-reset email sent
  shortly before it.
* `verify_jwt = false` for this function (`supabase/config.toml`): the
  gateway's check only knows the legacy HS256 secret and rejects tokens
  signed with asymmetric JWT keys; the function's own GoTrue check accepts
  both.

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
| `search_hands`, `get_hand`, `library_facets`, `library_count`, `unparsed_summary` | invoker | Read-only; RLS already allows public select. |
| `record_conversion_failures` | **definer** | Anon has `SELECT` but no `INSERT`/`UPDATE` on `unparsed_hands`, precisely so a caller cannot forge an occurrence count or flip `status`. This is the only write path and it whitelists the columns it touches. Since R0.11 it also cannot be made to forge `origin` or `consented_at` on an existing row: a repeat never rewrites them. |
| `unparsed_consent_instant` | invoker | Parses a client's consent time without raising (ISO 8601 with a zone, not in the future, not before 2026). No client may execute it; only the definer above calls it. |
| `create_share` | **definer** | `shares` is sealed from clients. The function generates the slug itself, so a caller cannot choose one — and because being definer means RLS on `hands` does not apply inside it, it checks `owner_id` by hand. |
| `read_share` | **definer** | Reads a sealed table, and reads past the owner policy on `hands` — that is the feature. Keyed strictly by slug equality, returns exactly one row, and projects its output columns by name because RLS cannot help inside a definer body. |
| `record_share_view` | **definer** | `views` is an `UPDATE`, and no client role has `UPDATE` on any table. Touches two columns on one row selected by slug equality. |
| `resolve_share` | **definer** | Deprecated wrapper over the two above; removal on or after 2026-11-27. |
| `phf_redact_private` | invoker | Pure jsonb→jsonb, no table access. Not granted to clients; it is an internal of `read_share`. |
| `enforce_rate_limit` | **definer** | The counter table is unreachable from anon. Not granted to clients. |
| `claim_desktop_sign_in` | **definer** | Calls `enforce_rate_limit`, which no client may execute; the bucket is built from `auth.uid()` alone. Executable by `authenticated` only (R1.7). |
| `hands_rate_limit` (trigger) | **definer** | Has to call `enforce_rate_limit`, which anon cannot execute. |
| `ingest_hands` | **definer** | Desktop rows may only be written here (the insert policy refuses them on the direct path) and the source counters have no client UPDATE grant. Owner from `auth.uid()`, source checked to be the caller's, budget spent first, every column but `hand_key` and `phf` derived on the server. `authenticated` only (R1.8). |
| `register_hand_source` | **definer** | `hand_sources` has no client write grant. Owner from `auth.uid()`; updates only the descriptive columns of the caller's own row. `authenticated` only (R1.8). |
| `register_web_hand_source` | **definer** | `hand_sources` has no client write grant. Owner from `auth.uid()`; returns (creating on first use) the caller's one `web` source. `authenticated` only (R4.2). |
| `hand_row_from_phf`, `hand_row_problem`, `phf_*` helpers | invoker | Pure: the PHF-to-row mapping and the constraint mirror `ingest_hands` uses. No client may execute them. |
| `hands_since` | invoker | Reads the caller's own rows (explicit `owner_id = auth.uid()` and RLS): ids, times, keys, origins. `authenticated` only (R1.9). |
| `put_hud_layouts` | **definer** | `hud_layouts` has no client write grant. Owner from `auth.uid()` (the conflict target includes it, so another account's row with the same key is never touched); the batch validated whole (kinds, keys per kind, bodies, times) before anything is written; at most 500 rows a call and 5 000 an account; rate-limited (`hud_layouts:`). `authenticated` only (R3.9). |
| `hands_signal_arrival` (trigger) | **definer** | `hand_arrivals` has no client write grant and `save_hands` runs as the caller. Reads only the statement's transition table, upserts one row per owner in it; a failure is swallowed so it never fails a save. No client may execute it (R1.10). |

---

## Identity: profiles, usernames and gates

`20261007090000_forum_identity.sql`. Everything the forum does later — author
lines, `/u/[name]`, vote weighting, moderation — hangs off this, so it shipped
before anything depends on it. The SQL headers carry the full reasoning; this is
the map.

### Doors

`profiles` is **sealed**: RLS on, no policies, no grants — not even SELECT on
your own row, because a self-select policy would hand an account its own
`is_shadowbanned` flag. So there are exactly these ways in:

| Door | Who | What it gives |
| --- | --- | --- |
| `profiles_public` (view) | `anon`, `authenticated` | `id`, `username`, `username_lower`, `karma`, `joined_on` (a **date**, not the signup timestamp). Owner-run, not `security_invoker`, so **the column list is the security boundary** — adding a column is a privacy decision. The Supabase advisor flags it as `security_definer_view`; that is the intent. |
| `my_profile()` | `authenticated` | The caller's own row as a named projection, plus `postingBlockReason`. Omits `is_shadowbanned` and `unsubscribe_token`. |
| `set_username(name)` | `authenticated` | The only client-caused write to `profiles`. |
| `resolve_username(name)` | `anon`, `authenticated` | "What is this name called now": `{username, redirect}` or `null`. Never returns an id, a reason or an expiry. |

### Username rules

| Rule | Where |
| --- | --- |
| `^[A-Za-z0-9][A-Za-z0-9_]{2,23}$` — every wider character class is a homoglyph surface, and the name is a URL | `profiles_username_shape` CHECK, mirrored by `username_shape_problem()` for the sentence |
| Case-insensitive uniqueness | unique index on the generated `username_lower` — never a pre-flight `exists`, which races |
| Provisional `user_<8 base-36>` at signup, from a CSPRNG, **never from the email** | `handle_new_user()` trigger on `auth.users` |
| **No profile for anonymous sign-ins** — still enabled on the live project, and one profile per `signInAnonymously()` would let a loop fill `profiles_public` | `handle_new_user()` and the backfill skip `is_anonymous` |
| `user_…` cannot be chosen | `username_shape_problem()` |
| Once per 30 days; a capitalisation-only change is free; the provisional name does not count | `set_username()` |
| Old name reserved **for the same account** for a year; `/u/<old>` redirects for that year; the owner can take it back | `username_reservations` + `set_username()` + `resolve_username()` |
| Route segments and staff-sounding names reserved for nobody | seeded into `username_reservations` — **a new top-level route belongs in that seed** |
| Slurs, matched after folding `_` and `0 1 3 4 5 7` → `o i e a s t`; short terms that are innocent fragments match `exact` only | `username_blocked_terms` — data, extended by the service role |
| A deleted account's name is reserved for nobody for a year | `profiles_reserve_on_delete` trigger |

`set_username()` has no rate limit, deliberately: every refusal is a raise, a
raise rolls back the counter increment with it, and whether a name is taken is
public through the view anyway.

### Gates and roles

| Function | Security | Granted to | Answers |
| --- | --- | --- | --- |
| `posting_block_reason(uid)` | definer (reads `auth.users.email_confirmed_at`) | **nobody** — it takes a uid, which would make it an oracle | `NULL`, or the sentence: banned (with until-date), email unconfirmed, account under 10 minutes old. A shadowban is **not** a reason. |
| `vote_weight(uid)` | definer | **nobody** — its answer reveals a shadowban | `0` under 24 h, banned, shadowbanned or **negative** karma; else `1`. |
| `is_moderator()` | definer — **must** be: an invoker function read from a policy on `profiles` recurses forever | `anon`, `authenticated` | Caller only; no argument. |
| `is_board_moderator(board)` | definer, same reason | `anon`, `authenticated` | Caller only. |

`vote_weight` says **negative** karma where #29 said "zero": every account starts
at zero and karma comes from weighted votes, so a zero rule would mean no vote
ever weighs anything. The function comment has the full argument, and the note
for #32 to add "has contributed" once posts exist.

Roles are a column read per call, **not a JWT claim**: a claim is frozen until
the token refreshes, so an emergency de-modding would take up to an hour.
Policies call them as `(select public.is_moderator())` for one InitPlan per
statement.

`board_moderators.board_id` has no foreign key yet; `public.boards` arrives with
#32, and that migration adds it.

### What still has to happen outside the repo

* **Email confirmation.** The gate reads `email_confirmed_at`, which is always
  set while the live project has `mailer_autoconfirm = true`. Turning it off
  needs real SMTP first (the built-in mailer only delivers to the project's team
  members), then `mailer_autoconfirm = false` **and**
  `mailer_allow_unverified_email_sign_ins = true` together, so confirmation gates
  the first post rather than sign-in.
* **Turnstile.** A Cloudflare site key in `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and
  the matching secret under Authentication → Attack Protection, switched on
  together — either one alone locks people out or protects nothing.

### Tests

`supabase/tests/database/identity.test.sql` — 68 pgTAP assertions run as `anon`
and `authenticated` for real (not as a superuser): the grant wall, every
username rule, reservations and reclaiming, redirects, the gates, the vote
weight, roles, and deleted accounts. `supabase test db` runs it; CI runs it on
every PR against a fresh Postgres with every migration applied.

---

## Publishing a hand

`20261012090000_forum_publishing.sql`. A published hand is a **copy**, made by
`publish_hand(hand_id, mode, title)` from the caller's own stored row and run
through `scrub_phf()` in SQL. The client never sends the document.

| Property | How it holds |
| --- | --- |
| No raw room text, table, hand number, tournament number, exact time, filename | No such columns on `published_hands`; `scrub_phf` removes each one from `phf` too; the `published_hands_phf_scrubbed` CHECK (`phf_is_scrubbed()`) rejects a document that still has one — even from the service role |
| Opponent names replaced by default | `mode` defaults to `pseudonyms` (Hero / Villain1..n); `positions` uses each seat's resolved position; `as-imported` is behind a warning in the UI |
| A name in a field nobody listed does not leak | `publish_hand` searches every string in the scrubbed document for every original name (whole-token) and **refuses** if one survives. Skipped for `positional` rooms, whose "names" are position labels |
| Not an existence oracle | "not yours" and "no such hand" raise the same sentence |
| No bulk | one hand per call, 20/day per account (counts only successes — a refusal rolls the counter back), and idempotent per hand |
| No opponent-name search | there is no `player_names` column to query |
| Per-room kill switch | a row in `publish_blocked_sites` |
| Posting gates apply | `posting_block_reason()` is asked first |
| Which private row it came from stays private | `published_hand_sources`, sealed |

Reads: `published_hands` is `SELECT`-able by everyone, with one policy —
`status = 'visible' and deleted_at is null`. `read_published_hand(public_id)`
(invoker, named keys) and `published_hands_by_author(username)` sit on top. A
deleted or removed publication returns `{status}` only, via the definer
`published_hand_status()`, so its page can say "removed" instead of 404.
`unpublish_hand(public_id)` is the owner's soft delete.

**The whole-corpus check** — every real hand in the repo, scrubbed in every
mode, then serialized and replayed, with nothing identifying allowed to
survive — is `tests/scripts/scrub-corpus/`. Run it when a parser or a PHF
field changes; it is how `game.straddles[].player` was found.

The `hh-takedown` report reason (#31) lands with the reports table (#40).

---

## The forum

`20261019090000_forum_core.sql`. Everything below is enforced in the schema;
the app only asks.

| Piece | Shape | Why |
| --- | --- | --- |
| `boards` | slug, name, seeded (`nlhe`, `mtt`, `plo`, `general`) | `board_moderators.board_id` gets its foreign key here |
| `posts` | `public_id` (8 chars, share alphabet), `kind` text/hand, `published_hand_id` → `published_hands` (never `hands`), title, plain-text body, generated `slug` | A stale or wrong slug 308s to the current one, so edits never break links |
| ranking | `hot_rank`, `controversy` (posts) and `best_rank` (comments, Wilson) are **STORED generated columns** over immutable functions | Cannot be forged, cannot drift, needs no UPDATE grant. `forum_hot_rank` converts `at time zone 'UTC'` before `extract(epoch)` — without that it is only STABLE and the generated column is illegal |
| votes | `post_votes` / `comment_votes`, `weight` from `vote_weight()` at vote time; counters **recounted from the rows** on every vote | Cannot drift. `score` is weighted and deliberately not `up - down`; that gap is the anti-brigading mechanism |
| karma | recounted for the author on every vote, minus the implicit self-upvotes | Your vote on your own post is not the community's opinion of you |
| `comments` | adjacency list + fixed-width path (6 base-36 chars per level from a per-post `seq`), depth ≤ 10 | `order by path` is depth-first; `like prefix%` is a subtree on a plain btree. Not `ltree` (`search_path = ''` would force `OPERATOR(extensions.<@)` everywhere) |
| anchors (#34) | `anchor_action_index` (`PhfAction.index`), `anchor_street`, `anchor_seat` | The same stable key as `?t=a<n>` — never a frame index |
| tombstones | a deleted comment keeps its row with `body` and `author_id` null; the words go into `moderation_actions` | Replies stay attached to what they answered |
| `moderation_actions` | one row per edit and delete, previous values in `details` | Sealed; the mod queue (#40) reads it |
| search (#37) | generated `search_tsv` over a `lang regconfig` column; `websearch_to_tsquery`; posts and comments scanned separately and merged | `to_tsvector(regconfig, text)` is IMMUTABLE, `text::regconfig` is not — Croatian becomes a data change |

**Visibility is RLS, once.** `posts_visible_select`: visible, not deleted,
author not shadowbanned (except to the author). `comments_visible_select`:
author not shadowbanned, and the post visible. The feed, `get_post`,
`get_post_comments` and `search_forum` are `security invoker`, so none of them
restates a rule and search cannot become a side channel around moderation.

**Writes** (`create_post`, `edit_post`, `delete_post`, `vote_post`,
`create_comment`, `edit_comment`, `delete_comment`, `vote_comment`) are
definer, rate-limited per account, and ask `posting_block_reason()` before
anything that puts words in front of people. `create_comment` takes one row lock
on the post, which serialises the `seq` allocation and keeps `comment_count`
exact in the same stroke.

**Feed** (`forum_feed`): keyset pagination with an opaque `<key>~<uuid>` cursor
(the key is an ISO timestamp for "new", never a float epoch), one statement per
sort so each is served from its partial index — verified with `EXPLAIN`.

**What the app does with it:** forum pages render as `anon` (see
`getAnonServerSupabase`), so the HTML is the same for everybody; "my votes" and
"is this mine" are client islands. **Not yet ISR**: the root layout reads the
session cookie, which makes every route dynamic. True ISR needs the forum
routes under their own root layout (route groups) — tracked as a follow-up.
Server rendering is unaffected: crawlers get the full thread and its
`DiscussionForumPosting` JSON-LD either way.

Tests: `supabase/tests/database/forum.test.sql` — 63 assertions.

---

## Notifications and realtime

`20261026090000_forum_social.sql`.

| Table | Read by | Written by |
| --- | --- | --- |
| `saved_posts` | select-own | `save_post(public_id, saved)` |
| `thread_subscriptions` (`watching` / `muted`) | select-own | `set_thread_subscription`, plus auto-watch when you post (trigger) or comment (fan-out) |
| `notifications` | select-own; `my_notifications`, `unread_notification_count` | `fan_out_comment_notifications` only; `mark_notifications_read` sets `read_at` |

`anon` has SELECT on `notifications` with no policy (`20270519090000`), so it reads zero rows. Without the privilege Realtime sends an anonymous socket an empty "Error 401" notice for *every* change, which leaks when each account is notified; the same pattern as `hand_arrivals` (R1.10).

**`fan_out_comment_notifications`** is called from `create_comment` (not a
trigger — self-suppression, mutes and caps are product rules). One row per
person, in priority order: the replied-to comment's author, the post's author
for a top-level comment, up to **5** `@mentions`, up to **50** watchers. Never:
the commenter, anyone who muted the thread (a mute silences replies and
mentions too), a banned account, and — for everyone — nobody at all when the
commenter is shadowbanned.

**Realtime**, for exactly four things:

* the unread badge — Postgres Changes on `notifications`, filtered
  `user_id=eq.<uid>`. `notifications` is in the `supabase_realtime`
  publication, and the select-own policy is what keeps the feed private. **The
  client must `realtime.setAuth(token)` before joining**: a channel joined as
  `anon` subscribes successfully and then receives nothing.
* "N new comments" on an open thread — **Broadcast** from the
  `comments_broadcast` trigger via `realtime.send(…, 'post:<public_id>', false)`.
  Not Postgres Changes: RLS per subscriber per row on a hot table is the
  scaling cliff. Public, because the payload is a count and a seq; skipped for
  a shadowbanned author.
* live arrival of hands on `/library` and `/stats` (Rail R1.10) - Postgres
  Changes on `hand_arrivals`, one row per account, filtered
  `owner_id=eq.<uid>`; `hands` itself is not published. See
  [Live arrival on the web](#live-arrival-on-the-web-hand_arrivals).
* an upload's progress in the account's other tabs (Rail R4.3) - **Presence**
  on the **private** channel `activity:<uid>`, the only private channel; its
  authorisation is the `realtime.messages` policies of
  `20270616090000_live_activity.sql`. See
  [Live progress across tabs](#live-progress-across-tabs-activityuid).

**What a socket gets for a table it cannot select (measured in R1.10).**
Realtime does not run RLS for a subscriber whose role lacks SELECT on the
table's columns; it sends that subscriber a content-free `"Error 401:
Unauthorized"` notice for **every** change of the table instead (measured
on `hand_arrivals` before its anon grant; `realtime.apply_rls` checks column
privileges first). `notifications` has no `anon` grant, so by the same path
an anonymous socket subscribed to it learns *when* anybody gets a
notification - no ids, no content. `hand_arrivals` avoids it with a `SELECT` grant to `anon` and no
policy for it (anon reads zero rows, so Realtime sends anon nothing).
`notifications` is unchanged here; the same one-line grant would close it.

**Nightly** (`pg_cron`, created by the migration where it can be):
`recount_forum_counters()` + `recount_forum_karma()` at 03:17, and
`sweep_rate_limits()` hourly — per-actor buckets (`'comment:<uid>'`) would
otherwise grow `ingest_rate_limit` forever. All three are service-role only
and idempotent.

Tests: `supabase/tests/database/social.test.sql` — 35 assertions.

---

## Moderation and anti-abuse

`20261102090000_forum_moderation.sql`.

**The visibility rule, once.** `posts_read`: visible + not deleted + author not
shadow-hidden, **or** you are the author, **or** you moderate the board.
`comments_read`: the post is readable, and the comment is not spam or
shadow-hidden unless you wrote it or moderate the board. A removed comment
stays as a tombstone: its body moves into `moderation_actions` and comes back
on restore. There is no query the app could write that returns removed content
to a stranger.

| Who | Can |
| --- | --- |
| Board moderator (`board_moderators`) | On their board: remove / restore posts and comments, lock, pin, retitle, see and resolve its reports |
| Moderator (`role`) | All of that everywhere; ban ≤ 30 days; shadowban; spam queue; account standing (`mod_user`) and vote overlap |
| Admin | Roles, boards, board moderators, bans over 30 days and permanent, hard purge |

Bans keep read access (a ban is `posting_block_reason` and nothing else).
Nobody bans themselves, and only an admin acts on staff.

**Audit.** `moderation_actions` is append-only: a trigger refuses UPDATE and
DELETE even for the service role, except the foreign-key action that nulls
`actor_id` when an account is deleted. `content_revisions` is written by a
trigger on every title/body change (author or moderator) and is **public**
while the content is — `get_revisions(post, seq)`.

**Reports.** `report_content(type, …, reason)` — one per reporter per subject,
20/day per account. Reasons include `hh-takedown`, the takedown path promised in
#31 (see `/takedown`, 48-hour response).

**Rate limits (#41)**, each action with a per-account **and** a global bucket:

| Action | Per account | Global |
| --- | --- | --- |
| Post | 5 / hour | 500 / hour |
| Comment | 30 / 10 min | 5000 / 10 min |
| Vote | 200 / hour | 50000 / hour, **+ 400 / hour per subject** |
| Publish | 20 / day | 500 / day |
| Report | 20 / day | 2000 / day |

The per-subject vote bucket is the one that catches a brigade (many accounts,
one vote each). Buckets are swept hourly by `sweep_rate_limits`.

**Spam gate.** `forum_spam_verdict`: more than two links under 50 karma, the
same body (`body_fingerprint`, sha-256 of the normalised text) within 7 days,
or a near-copy (`extensions.similarity` > 0.9) of one of the author's last ten.
Spam is **created, not rejected** — `status = 'spam'`, visible to the author and
the moderators, queued in `mod_spam_queue`. `forum_fingerprint` is declared
IMMUTABLE around `convert_to`, which is only STABLE; that holds because the
database encoding (UTF8) is fixed at creation.

**Vote overlap.** `mod_vote_overlap` (no client grants) and
`mod_vote_overlap_for(username)` for moderators. A signal, never an action.

Tests: `supabase/tests/database/moderation.test.sql` — 58 assertions.

---

## Sessions, bankroll and opponent notes

`20261214090000`. **Sessions are computed, not stored:** `stats_sessions`
(retired in `20270818090000`; the web reads R4.5c-1's `report_sessions`, the
same rule over the shared filter) grouped the caller's hero rows into runs with no gap longer than
`p_gap_minutes` (default 30, across every table at once) with a window
function over `played_at`; the bankroll is their running sum. Bomb pots and
straddles count here (a bankroll is what happened to the money); the usual
money refusals apply (chips with cash: no money; two currencies: bb only).

**Notes** (`player_notes`) are private: select-own, and no write grants —
`set_player_note` (definer) is the only writer, edits the caller's own row in
place, and deletes it when cleared. A note can only be written on a player
the caller has sat with **in a room with real screen names**
(`hands.site_anonymization = 'none'` and the name in `hands.player_names`).
Positional rooms have no `player_names` by constraint, so they can never
pass; `opaque-id` rooms are refused too, because a per-session token would
carry the note to whoever gets it next.

Tests: `supabase/tests/database/sessions_notes.test.sql`.

## Polls: "what would you do?"

`20261130090000` lets a hand post stop at one of the author's own decisions
and ask readers to answer before they see the rest. The gate is the
database's, in three places, because a client-side "hide until voted" is a CSS
rule between a reader and the answer:

| What | How it stays hidden |
| --- | --- |
| The hand | Its published copy moves to `status = 'poll'`, which `published_hands_public_select` does not match — so `/p/:id`, the author's list, the sitemap, `get_post.handPhf` and the feed card all lose it at once. `read_poll` (definer) returns `poll_phf(...)` — actions before the decision, runout 0 through that street, the hero's cards unless hidden, no villain cards, no results, no source text — until the caller has voted or is the author or a moderator; then the whole document. |
| The discussion | `comments_read` gains `and not poll_hides_answer(post_id)`, which covers `get_post_comments`, a direct table read and anything later that reads through the policy. |
| The votes | `post_polls` / `poll_votes` are sealed; reads are counts through `read_poll` / `poll_public`, never voters. |
| The reference answer (A7.1) | Only when the author shared the hand's analysis, and only through `read_shared_analysis('post', …)`, which returns nothing while `poll_hides_answer` is true for the caller — and never through the sealed hand's `published` surface. See [Hand analysis](#hand-analysis-hand_analysis-decision_analysis). |

`create_poll_post` runs `create_post` (every gate and limit a post gets), then
seals the hand. The hand must be the caller's, visible, and not the subject of
another post; the decision must be a hero action, and the options must include
what the hero did. `vote_poll`: one final vote, not the author, banned accounts
refused, rate-limited on the vote buckets. `/p/:id` of a sealed hand says it is
a poll and links to it (`poll_post_of_hand`), nothing more.

Tests: `supabase/tests/database/polls.test.sql`, including a check that no
villain card, turn or river appears anywhere in the spot document.

## Statistics: `hand_stats`, coverage and rebuild

`hand_stats` (`20261005090000`) holds one row per (hand, dealt-in seat,
`stats_version`), derived from `hands.phf` by `lib/stats`. It is derived data:
everything in it can be rebuilt from the documents, which is why it is the one
table with a delete path (`prune_hand_stats`, definer, can only remove the
caller's rows at *other* versions).

**Who writes it.** Nobody in the browser any more. After a save, the client
calls `POST /api/stats/rebuild`, a route handler that runs **as the user** (anon
key + their cookie, no service role) and loops:

1. `hands_needing_stats(version, after, limit)`: invoker, a keyset page of the
   caller's hands that have a hero and no row at `version`, with their `phf`;
2. derive with `lib/stats` next to the database;
3. `save_hand_stats(rows)`: invoker, resolves `hand_key` under RLS;
4. on the last slice, `prune_hand_stats(version)` drops older generations.

Each request works for ~8 s and returns a cursor; the client calls again until
`done`. "Missing" is computed, not tracked, so an interrupted run resumes by
being run again, and two concurrent runs are harmless (`on conflict do nothing`).
The `/stats` screen reads `stats_coverage(version)` and starts a rebuild on its
own when anything is missing or stale, so a `STATS_VERSION` bump needs no
migration and no button press.

**Every origin goes through it** (R4.4). A desktop row (`ingest_hands` from the
app) and an upload row (`ingest_hands` from the web source) arrive with the PHF
only and get their statistics from this rebuild, exactly as a `save_hands` web
row: the converter starts it after a bulk save, and `/stats` starts it for hands
synced from the app. `npm run parity` (tests/) holds the rows of the two paths
equal byte for byte over the corpus.

**Seats and refusals** (R4.4's F1, `20270623093000`). A seat is the room's own
seat number, not an index: Ignition's tournament seats run past 24 (to 1 227 in
the corpus). `hand_stats.seat`, `hand_stats_ev.seat` and `hand_analysis.hero_seat`
take any `smallint` from 0 (`comments.anchor_seat` from 1) - the bound
`hands.hero_seat` always had; counts stay as they were (`max_seats` 2-24, `player_count` 1-24).
Before, `hand_stats_seat_ok` (0-24) refused the page holding such a hand, and
since "missing" is computed, every later rebuild of that account failed on the
same page. The route now also survives any such hand: when `save_hand_stats` or
`save_hand_ev` refuses a call for its data (SQLSTATE class 22 or 23), it retries
the call hand by hand (`lib/db/statsSave.ts`), skips the hands still refused and
counts them in `failed` (the coverage line's "could not be read"); the next run
tries them again. Any other error (the budget, the session) still fails the
slice.

**Budget** (R4.4's F2, same migration). The inserts are charged to the account
(`hand_stats_insert:<uid>`, 1 000 000 rows / 10 min and 10 000 000 / day), with
the global `hand_stats_insert` kept only as a ceiling (3 000 000 / 10 min); see
[Rate limiting](#rate-limiting). The route writes ~1 250 rows a second from one
tab (measured locally), under the account's budget, so a 1 000 000-hand library
(~2 000 000 rows hero-only, ~7 000 000 with villain rows) rebuilds at the route's
pace - ~30 minutes, ~1.5 hours with villains - without touching anybody else's.
The day budget is there because `stats_version` is free text, so an account's
rows are not bounded by its hands; 10 000 000 is a full rebuild with villain rows
and EV with room to spare.

**Coverage** returns `{hands, atVersion, stale, missing, withoutHero,
obsoleteRows, stakes}`. Hands with no hero seat (observed tables) are counted
apart, because they can never have hero rows and would otherwise be "missing"
forever. `stakes` (format × currency × blinds, by volume) drives the screen's
format/stake picker: a sample mixing cash and chips has no win rate, so the
screen opens on the biggest format instead of an empty headline.

**Reports.** *Retired in `20270818090000`* - nothing called them after
R4.5c-2 (the web's `/stats` is the shared Reports screen over R4.5c-1's
`report_*` readers), and over an account's own million hands they took
12-27 s. `report_summaries.test.sql` keeps their last bodies as pg_temp
copies, the oracle they are for `report_graph`, `report_situations` and
`report_sessions`. What follows is their history. `stats_summary` and
`stats_graph` were invoker functions that summed under RLS. Their helpers (`hand_stats_filter_sql`, `hand_stats_counter_keys`,
`hand_stats_money_keys`, `stats_empty_*`) must be executable by
`authenticated`: an invoker function runs with the caller's privileges, and
revoking them (as `20261005090000` did) broke the screen for every real user.
They read no table, so there is nothing to protect. `20261109090000` restores
the grants and fixes `prune_hand_stats`, which joined on a non-existent `id`.

**Breakdown** (retired with the reports above). `stats_breakdown(filters, group)` (`20261116090000`) was the
summary split by one dimension: `position`, `table_size`, `site`, `stakes`,
`hand_class` (the 13x13 matrix) or `stack_bb` (the hero's own stack in bands —
not effective stack, which needs villain stacks). The group key picks a literal
out of a fixed `case`; anything else is 22023. The filters are the same bound
`$1..$20` as the summary's, and the money refusals are the same: chips with cash
carry no money at all, mixed currencies carry bb only. A row carries the dozen
counters a table shows, not all ninety.

**Opponents** (`20261123090000`) are opt-in per browser (`villainRowsEnabled`),
because a row per opponent per hand is ~5x the hero rows (measured: 27 272
villain rows for 5 448 hands, `hand_stats` 21 MB next to `hands` 40 MB).
Turning it on passes `p_villains` to `hands_needing_stats`, so hands that have
hero rows but no villain rows get rebuilt; turning it off calls
`prune_villain_stats`, the schema's second delete — definer, caller's own
non-hero rows only, cannot reach hero rows. `stats_opponents` lists opponents
from `none` rooms only: `positional` rooms have no villain rows, and
`opaque-id` rows are counted (`opaqueRows`) but not listed, because summing a
per-session hash across sessions invents a person. Each row carries the
caller's own bb result in the hands they shared (a join to the hero row of the
same hand). The search is a prefix match with `like` metacharacters escaped.

**Opponents' counters by key** (`20270526090000`, analysis/20).
`villain_counters(p_players jsonb, p_filters jsonb)` answers the analysis'
question rather than the panel's: the counters `lib/analysis/villain.ts` reads
(`hands`, `vpip_opp`, `vpip`, `pfr`) for exactly the named opponents, an array
of `{site, player}` keys, at most 500 per call (anything else — not an array, a
key that is not two non-empty strings, 501 keys — is 22023). It replaced the
analysis' read of `stats_opponents`, whose 200-row cap left a learner's
opponents past the 200 biggest samples on the population range. Same rules as
`stats_opponents`: `security invoker` with `owner_id = auth.uid()` on top of
`hand_stats`' RLS, `none` rooms only, no bomb pots, and the same
`statsVersion` (default `stats/1`, so the client always sends it),
`gameFormat` and `minHands` filters. A key named twice is answered once. Read
only: no grant on any table changes. The client batches the opponents of each
chunk of hands it analyses and asks each player once per run
(`lib/db/villainCounters.ts`).

**All-in EV** (`20261207090000`) is computed by `lib/equity` (exhaustive
enumeration for hold'em, seeded Monte Carlo for preflop Omaha; the evNet of a
hand sums to its net exactly) and stored in `hand_stats_ev`, a sibling table so
an equity fix never re-inserts statistics and `ev_version` moves on its own.
Every evaluated hero hand gets a row — `applicable = false, ev_net = net` for
the ~95% with no all-in — so "not evaluated yet" is computed
(`stats_ev_missing`, `hands_needing_stats(..., p_ev_version)`) and the existing
rebuild route catches a library up without re-deriving it to find the hands
that matter. `report_graph` (before it, `stats_graph`) joins it in and returns
`cum_ev_bb_milli` per point plus `allInEv: {evVersion, allInHands}`; the EV line is the
total line with each all-in paid at the equity the hands had when the money
went in.

**stats/2** (`20261221090000`) adds `pot_type` (walk, limped, single-raised,
3bet, 4bet+, bomb) and a `pot_type` breakdown group. It is the first version
bump, and it runs the path M2 built for it: every library reads as stale,
`/stats` re-derives it next to the database and prunes the stats/1 rows on
the last slice — measured locally on 5,448 hands, no button pressed. Every
report defaults to `stats/1` when not told otherwise, so the client always
sends `statsVersion` (`withVersion` in `lib/db/stats.ts`).

**Report summaries** (`20270707090000`, RAIL-PLAN R4.5c-1). A report over
one account's 1 000 000 hands read the account's whole `hand_stats` heap
(3-7 s a report, `stats_opponents` 21-41 s, `stats_coverage` 10 s), so three
tables now summarise it, kept by statement triggers on `hand_stats`
(`hand_stats_summaries_*`: AFTER INSERT adds the statement's rows, AFTER
DELETE subtracts them, in the writer's own transaction; an UPDATE recounts its
owners, a TRUNCATE empties them):

| Table | Per | Holds | Read by |
| --- | --- | --- | --- |
| `hero_rollups` | owner, version, UTC day, segment (room, format, variant, limit, size class, currency, minor units, blinds, stake), hero position, kind (bomb 1, straddle 2, cashout 4) | every counter and money sum, the showdown share of the result (big blinds and money: the graph's lines) | `report_open`, `report_facets`, `report_graph` (its days), `stats_coverage` |
| `hero_report_rows` | hero row | the segment's derived values, the result, the situation (pot type, stack band, hand class, players, street), the breakdown columns' counters; `hero_report_rows_time_idx` covers the graph's and sessions' columns in time order | `report_graph` (the days it cuts inside), `report_situations`, `report_sessions`, `stats_ev_missing` |
| `player_stats` | owner, version, room, opponent (opaque-id rooms under ''), segment | `stats_opponents`' counters, the hero's result in the hands shared, first / last hand (stale after a delete: read again) | `stats_opponents` |

RLS select for the owner on all three, no writes for anyone; the trigger
functions and `report_summaries_rebuild(owner)` are definer with an empty
`search_path` and granted to nobody; `refresh_report_summaries()` recounts the
caller's own (rate limited, the repair). The readers - `report_open`,
`report_graph`, `report_situations`, `report_sessions`, `report_facets` - are
invoker functions over the shared screens' `HandFilter` (sites, formats,
variants, limits, sizes, stakes, positions, from / to and the bomb / straddle
/ cashout options), with the `stats_*` money refusals; a date range is whole
days from the rollup and its partial days from the rows. `stats_opponents`,
`stats_coverage` and `stats_ev_missing` keep their answers and read the
summaries. The graph cuts its points by hands but at day ends: with T =
hands / points, a day of at most T hands goes whole to one point, a bigger day
is read hand by hand (every point is an exact cumulative sum; the points are
about T hands apart). At 1M hands a filter change (`report_open` +
`report_graph` + `report_facets`) answers in 0.1-0.3 s; the plan's R4.5c-1
*As built* has the table. Costs: +10-12 ms on a 1 000-row `save_hand_stats`
call (~60 ms), the backfill ~100 s for 6M rows.

**The Players screen's readers** (`20270714090000`, RAIL-PLAN R4.5c-3), the
shared Players screen's on the web, invoker, `search_path = ''`, for
`authenticated` only:

- `players_list(p_query)` - from `player_stats`: one line per opponent of a
  room with real names (every segment summed), the hero's hands with them
  and result against them per kind (cash / chips), first and last seen (read
  again from the rows when a delete made them stale), whether
  `player_notes` holds a note; filtered by room, kind (`all` / `cash` /
  `chips`), a case-insensitive prefix of the name (LIKE's characters taken
  literally) and "with a note"; most hands together first, at most 500. With
  the scope's counts (`players`, `matching`, `cashHands`, `chipsHands`), no
  result when the scope mixes chips with cash (`mixedKind`), the opaque-id
  opponents' rows counted (`hiddenHands`). The desktop's
  `Reader::player_list` rules.
- `player_profile(site, player, kind, version)` - what `player_stats` holds
  for them (`seen`), their note and tags, and their villain rows of the kind
  summed (bomb pots out, an EV cashout's money out) in total and by
  position, stake, table size and game (`hand_stats_villain_idx`), with a
  sample per cash stake for its label; big blinds withheld when chips and
  cash mix; `seen: null` for a name that is no opponent of a room with real
  names. The client makes the statistics (`showStat` of the shipped
  definitions, hero-only ones and money withheld).
- `player_sites(version)` - the rooms with listed opponents.

`players` is reserved as a username (`/players` is a top-level route). At 1M
hands (74 305 opponents) the list answers in 0.26-0.29 s and the rooms in
0.05 s; a profile reads the opponent's rows: 0.09 s for one with 20 368,
1.3 s for the copied set's biggest (267 464 rows; 4 s cold).

**Session review** (`20270721090000`, RAIL-PLAN R5.1).
`session_review(filter, at, gap, limit)` - invoker, `search_path = ''`,
planned per call, anon refused - answers one session of the caller's:
`report_sessions`' rule (the hero's hands under the shared filter in time
order, a break longer than `gap` minutes starts the next), found by walking
`hero_report_rows_time_idx` outwards from `at` (the latest session that has
ended when `at` is null; a later one is returned as `ongoing`) in chunks of
500, so it reads the session's hands and its two neighbours. It returns the
summary (`report_sessions`' result, the all-in EV adjustment of
`report_open`, money for one currency of cash only), the analysis counts at
the `analysisVersion` the filter names, and three lists of at most `limit`
(50): per hand its worst graded `decision_analysis` row of Inaccurate or
worse; per hand its preflop `source = 'chart'` row of Inaccurate or worse;
the biggest `hands.total_pot / big_blind`; with the listed hands described.
Every other read is by key (`hands`, `hand_stats_ev`, `hand_analysis`,
`decision_analysis`). At 1M hands: 2-19 ms warm.

### Tests

`supabase/tests/database/stats_ev.test.sql`: the catch-up predicate, the
graph before and after evaluation (total unchanged, EV line paid at equity),
the summary, RLS resolution on write, no-op rewrites, no UPDATE, isolation,
anon.

`supabase/tests/database/villain_stats.test.sql`: listing, ordering, the
hero-result join, opaque-id exclusion, minHands, escaped search, the villain
backfill predicate (and positional hands never needing it), prune touching only
the caller's villain rows, anon.

`supabase/tests/database/villain_counters.test.sql` (20 assertions): an
invoker function; one row per named opponent the caller has rows for; cash
only with `gameFormat`, never a bomb pot, never another user's rows; the same
counters `stats_opponents` reports; minHands; opaque-id hashes never summed;
the room as part of the key; the version default; a key named twice counted
once; 500 keys accepted and 501 refused; malformed input refused; a second
user sees only their own; anon cannot execute it.

`supabase/tests/database/stats_rebuild.test.sql`: coverage arithmetic,
keyset paging, clamping, cross-user isolation, anon refusal, prune, and the
reports (`report_open`, `report_graph`) running as a signed-in user.

`supabase/tests/database/players_screen.test.sql` (46): `players_list`
against the list written out over the villain and hero rows themselves (not
over `player_stats`) for every filter and after deletes, `player_profile`'s
sums by group against the rows, the note and its tags, the mixed-kind
refusal, nobody's profile, RLS (B's answers over B's rows), anon refused,
the `players` reservation.

`supabase/tests/database/report_summaries.test.sql` (91): the three summaries
equal a from-scratch aggregation of `hand_stats` for random rows (rooms of
every anonymisation, cash in two currencies and three chip formats, bomb pots,
straddles, cashouts, two versions) written in statements of every size, as
the user through `save_hand_stats` and directly; and again after a hand's
cascade, an old version pruned in slices, the hero's row alone, an opponent
row alone, opponent rows pruned and written again, a hero row after its
opponents, a write refused by the budget (nothing moved), a rebuild, a repair
of broken summaries and an UPDATE. The readers against a scan of the rows:
`report_open`'s totals and five breakdowns (dates cut inside days, whole days,
one bound, every group and option, the money refusals, the EV sum),
`report_facets`, `report_graph` against its rule written out hand by hand,
`report_situations` = `stats_breakdown`, `report_sessions` = `stats_sessions`
(both kept there as pg_temp copies since they were retired),
and `stats_opponents`, `stats_coverage` (one version and two) and
`stats_ev_missing` = their previous bodies. RLS, grants, anon.

`supabase/tests/database/session_review.test.sql` (47): which session (the
latest that has ended, an ongoing one named, an instant inside, before every
hand, bomb pots, other gaps, a break of exactly the gap), every session equal
to `report_sessions`' bounds, hands, tables and result under four settings,
a 1 200-hand session walked across chunks, the summary's money and EV rules,
the three lists' order, cap and contents, the analysis counts, another and a
malformed analysis version, another account, anon.

## Hand analysis: `hand_analysis`, `decision_analysis`

Phase A1 of `docs/ANALYSIS-PLAN.md` (`20261228090000_analysis.sql`), with the
grade-aware reports of A2b (`20270104090000_analysis_grades.sql`). The engine
is `frontend/src/lib/analysis` (pure TypeScript, run over the corpus by
`tests/test/analysisCorpus.test.ts`); these tables hold its answer. Since
`analysis/2` the grade columns are filled for preflop decisions graded against
the charts (`source = 'chart'`); postflop rows are still heuristic.

| Table | Key | What it holds |
| --- | --- | --- |
| `hand_analysis` | `(hand_id, analysis_version)` | Status (`full` / `partial` / `not-analysed`), the not-analysed `reason`, the hand's `grade` / `score` / `ev_loss_*` (null until a phase brings a reference strategy), `decisions` / `analysed` / `flag_count` / `worst_flag`, `approximations`, `pot_type`. |
| `decision_analysis` | `(hand_id, analysis_version, ord)` | One row per hero decision: `street`, `action`, `action_index` (what the replayer seeks to), `status` / `reason`, `scenario`, `source`, the grade columns (narrow, for `group by street, grade`), `options` jsonb, `flags` jsonb, pot geometry (`facing_bet`, `pot_bb`, `pot_odds`, `mdf`) and `facts` jsonb for the hand panel. FK to `hand_analysis`, cascading. |

**Stricter than `hand_stats`.** Both tables are `select` to `authenticated`
under an owner policy and nothing else — no INSERT, no DELETE, nothing to
`anon`. The only write is `save_hand_analysis`, `security definer`, which
checks ownership itself (`hands.id` joined with `owner_id = auth.uid()`; a
foreign id is skipped exactly like an unknown one) and **computes the hand
row's aggregates from the decisions it was sent**, so `decisions`,
`analysed`, `flag_count` and `worst_flag` cannot be forged and cannot disagree
with the decision rows. CHECK constraints hold the status against the counts
and cap every flag's severity at `inaccurate` (§3.6). Decisions are only ever
written for a hand row inserted in the same call, so a replayed request cannot
graft decisions onto an existing analysis. The only delete is
`prune_hand_analysis` (definer, the caller's rows at other versions only).
Rate limit: per account, `analysis_insert:<uid>`, 60 000 rows / 10 min.

**Where it runs.** In the browser: `runAnalysis` (`lib/db/analysis.ts`) pages
through `hands_needing_analysis` (invoker; every hand, hero or not, with the
`phf` trimmed of `meta.rawText` and the per-action `rawLine`/`label`), runs
`analyzeHand` in `workers/analysis.worker.ts`, writes 50 hands per call, and
prunes older versions on the last page. "Missing" is computed, so it resumes
by being run again. `/analysis` runs it on its own only for up to 300 new hands
on an already-analysed library; a first run or a version change is a button.
Since A5a (`20270125090000_analysis_turn.sql`; no table or grant change) a
pool of up to four workers analyses chunks of 20 hands side by side, and the
button can start with the most recent 200 / 500 / 1,000 hands:
`hands_needing_analysis_recent(version, before_played, before_id, limit)`
(invoker, `search_path` pinned, `authenticated` only) is the same trimmed page
newest first (`played_at` desc, undated last, then `id` desc), keyset on the
last row. A newest-first run never prunes; turn grades are ordinary
`decision_analysis` rows (`street = 'turn'`, `source = 'solver'`).
Since A9 (`20270310090000_analysis_multiway.sql`) `source` may also be
`'approx'`: a multiway river call or fold graded by showdown EV against
narrowed ranges, capped at Mistake; its numbers are in `facts.multiway`
(no table, grant or signature change; the check constraint names four
sources).

**Reports** (all invoker, all take `analysisVersion` — the client always sends
it): `analysis_coverage(version)`, `analysis_overview(filters)` (graded moves
and hands, the Perfect…Blunder distribution overall and per street, EV loss in
bb and in pots, mean score, hands with a Mistake or worse),
`analysis_breakdown(filters, group)` (`street` / `position` / `pot_type` /
`preflop_scenario` / `scenario`, whitelisted; per group the five grade counts,
EV loss and score), `analysis_hands(filters, sort, limit, offset)` (sort
whitelisted, incl. `ev_loss` and `ev_loss_pot`; each decision carries its EV
loss) and `analysis_hand(hand_id, version)`. They share
`analysis_scope(filters)` (filters incl. `grade` — the hand's worst grade
exactly — and `minGrade` — at least that bad; an unknown grade is 22023),
`analysis_version_of(filters)` and `analysis_grade_rank(grade)`, all granted
to `authenticated` — the `20261109090000` lesson. Defence against MDF counts
postflop decisions only.

**Reports against the reference** (A3, `20270111090000_analysis_reports.sql`;
no table or grant change): `analysis_node_actions(filters)` counts the graded
chart decisions (`source = 'chart'`, a grade, a choice) per chart node
(`facts.chart.set` / `facts.chart.line`) × chosen action (decisions, those
worse than Perfect, EV lost) and per node × hand class × action, the analysed
postflop decisions per street × role scenario × action, and the filter facets
(rooms, stakes, first and last hand — over the version only, ignoring the other
filters). `analysis_node_hands(filters, nodes, action, deviations, sort, limit,
offset)` is the list behind a row: graded decisions at up to 200 `<set>:<line>`
keys, by default only those worse than Perfect, sorted by EV loss (keys,
actions and sorts validated, 22023 otherwise). Both are invoker over
`analysis_scope`; their helper `analysis_chosen_action(options, chosen)` (the
option taken as a chart action, `allin` for a stored shove) is granted to
`authenticated` and not to `anon`. The reference frequencies themselves are
chart arithmetic in the browser (`lib/analysis/reports.ts`).

**Leaks and progress** (A6, `20270201090000_analysis_leaks.sql`; no table or
grant change): `analysis_leaks(filters)` sums the graded decisions per finest
spot — street, scenario, chart line, seat, action taken, best action — with
decisions, hands, those worse than Perfect, those Inaccurate or worse, EV lost
in bb and pots, and score sums and sums of squares; plus graded hands, first
and last date, and the facets. `analysis_leak_hands(filters, keys, deviations,
sort, limit, offset)` is the list behind a leak (up to 500 spot keys, shape
and sort validated, 22023 otherwise). `analysis_trend(filters, bucket, group,
gap_minutes)` sums the same per ISO week, month or session (`bucket`
whitelisted; sessions by the `stats_sessions` gap rule over every analysed
hand) and per `all` / `street` / `position` / `pot_type`. All three are
invoker over `analysis_scope` through the helper
`analysis_graded_decisions(filters)`; their helpers `analysis_best_action`
(the highest-EV option), `analysis_spot_key` (the one key string the list and
its hands share) and `analysis_graded_facets(version)` are granted to
`authenticated` and not to `anon`. Grouping into leaks, merging thin spots,
ranking and period comparison are `lib/analysis/leaks.ts`.

**Training** (A7, `20270208090000_analysis_training.sql`): three new tables,
all owner-scoped with RLS select-own and **no client INSERT, UPDATE or
DELETE grant**, nothing to `anon`.

| Table | Key | What |
| --- | --- | --- |
| `drill_items` | `id`; unique `(owner_id, hand_id, action_index)` | One drill per own graded decision of Mistake or worse (Inaccurate on request): the `analysis_version` and `ord` of its row, `street`, the leak finder's `spot_key`, the source grade and EV loss, and its SM-2 state (`reps`, `lapses`, `ease` 1.30–3.00, `interval_days` 0–365, `due_at`, `reviews`, `last_grade`). FK to `hands`, cascading. |
| `drill_reviews` | `id` | Every answer to a drill: option chosen, grade, EV loss, SM-2 quality, and the schedule it led to. FK to `drill_items`, cascading. |
| `trainer_results` | `id` | Every graded trainer answer: `mode` (`preflop` / `river` / `drill`), family, spot, seat, hand class, grade, EV loss (bb and pot), score. |

Writes are three `security definer` functions with explicit `auth.uid()`
ownership checks and per-account rate limits: `sync_drill_items(version,
min_grade)` builds drills from the caller's own decisions (joined to `hands`
on id *and* owner; idempotent; a drill seen at another version is re-pointed
and keeps its schedule; 120 / 10 min); `review_drill(item, chosen, grade,
ev_loss)` names the drill by id *and* owner ("No such drill." P0002 either
way), checks the option index against the stored options, and reschedules
with `drill_next` (600 / 10 min); `record_trainer_results(rows)` takes at
most 50 rows whose columns the table checks (1 200 rows / 10 min). The answer's
grade comes from the browser (`lib/training`): a false one only reschedules
the sender's own drills. Reads are invoker: `drill_queue(version, keys,
due_only, limit)`, `drill_summary(version, until)` (due now, due by the end of
the reader's day, and graded Mistakes not drilled yet), `drill_due_by_spot`
(the Leaks rows' counts) and `trainer_summary(days)`; their helpers
`drill_quality`, `drill_next` (SM-2, the same cases as
`lib/training/schedule.ts`) and `drill_keys_valid` are granted to
`authenticated` and not to `anon`.

**Sharing an analysis** (A7.1, `20270222090000_analysis_share.sql`; plan
§8.4: private by default, a per-hand opt-in). One table, `analysis_shares`
(`hand_id` primary key → `hands`, cascading; `owner_id`; `shared`;
timestamps): RLS select-own to `authenticated`, nothing to `anon`, **no
client INSERT, UPDATE or DELETE grant**. Switching off writes `shared =
false`; nothing is deleted. A row rather than a column on `hands`, which
has an owner UPDATE policy: the flag that decides what strangers read is
not one more column a generic update can set.

A hand is named by a **surface**: `hand` (its uuid), `published`
(`/p/<public_id>`), `post` (a thread or a poll), `share` (`/h/<slug>`).
`analysis_share_target(surface, id)` (definer, granted to nobody) resolves
it to the private hand and the account that put it there
(`published_hand_sources` / `shares`).

| Function | Security | Who | What |
| --- | --- | --- | --- |
| `set_analysis_share(surface, id, shared)` | **definer** | `authenticated` | The hand behind the surface must be the caller's (`hands.owner_id`) *and* the surface the caller's own; "That hand does not exist." (22023) for a foreign and an unknown hand alike; 120 / 10 min; upsert. |
| `analysis_share_state(surface, id)` | **definer** | `authenticated` | `{handId, shared, versions}` for the owner, null for anyone else. The toggle's read. |
| `read_shared_analysis(surface, id, version)` | **definer** | `anon`, `authenticated` | The analysis at `version` — or, when the hand has none there, its newest older version flagged `staleVersion: true` (A5a, `20270224090000`) — only when (1) the surface is public to the caller by its own page's rule, restated: `published` — visible and not deleted; `post` — the `posts_read` predicate as `read_poll` restates it, the hand not deleted or removed, and **for a poll only once `poll_hides_answer` is false** (voted, author, moderator); `share` — the slug is the capability, as for `read_share`; a hand uuid is never a public surface; (2) the hand is the surface author's own; (3) `analysis_shares.shared`. Null for every other case alike. |

The read names its output keys (`analysis_hand`'s, without `handId`), and
projects every decision's `options` to the seven `OptionAnalysis` keys,
`flags` to code / severity / params, and `facts` to the listed `SpotFacts`
keys (`analysis_public_facts` — a new facts key needs a line there; `turn`
and `flop` are listed for A5, `multiway` since A9). The rows are written by the owner's browser,
so a key nobody listed does not reach a stranger. **`facts.villain` never
does** (`analysis/20`: an opponent's VPIP / PFR counters and sample from the
owner's private library — the owner's, not the hand's): it is not on that
list, and since `20270407090000_shared_analysis_strip_villain.sql` the reader
also removes it itself (`analysis_public_facts(d.facts) - 'villain'`), so a
later line on the list cannot let it through; the turn's and river's own
`villain` (the range's shape, from the hand) stays. The owner's own
`analysis_hand` still returns it. The browser drops it again on every shared
read (`withoutOwnerFacts`, `lib/analysis/share.ts`: the server render's
`readSharedAnalysisAnon`, the poll's `readSharedAnalysis`, the sheet's
`asHandAnalysis`). Facts are hero-centric by
construction (hero's cards, the board to the decision, positions, pot
geometry, equities against ranges named by line and seat): no villain hole
cards and no screen names are inputs, so the scrubbed copy's pseudonyms
have nothing to mask. The one place the public view hides more — a poll
before the reveal — gets nothing at all. The page then draws the analysis
only if every decision lands on a hero action of the copy it shows
(`analysisFitsHand`), the published document, a thread's hand or a share
page's re-parsed text alike.

**Study plan** (A8b, `20270215090000_analysis_study_plan.sql`): two new
tables, owner-scoped with RLS select-own and **no client INSERT, UPDATE or
DELETE grant**, nothing to `anon`.

| Table | Key | What |
| --- | --- | --- |
| `study_plans` | `id`; unique `(owner_id, week_start)` | One plan per ISO week (named by its Monday): `kind` (`leaks` / `fundamentals`), the `analysis_version` it was built from, the focus areas as the browser built them (`focus`, at most three, 64 KB) and a small `baseline` (hands, moves, last hand, EV lost). |
| `study_tasks` | `id`; unique `(plan_id, kind, ref)` | The week's checklist: `read` (a concept id), `train` (a trainer filter: `match_mode`, `match_family`, `match_position`, `match_spots` as `<line>:<seat>`), `drill` (`spot_keys`, or none for every drill), `review` (`hand_id`, FK to `hands`, cascading); a `target` 1–200 and a manual `done_at`. FK to `study_plans`, cascading. |

Writes are two `security definer` functions with explicit `auth.uid()`
checks and per-account rate limits: `save_study_plan(week, kind, version,
focus, baseline, tasks)` upserts the caller's plan for this, last or next UTC
week (`study_week_valid`), validates every task (kind, reference shape,
target, focus index, trainer filter, spot keys with `drill_keys_valid`, no
duplicates, at most 40) and a review hand against the caller's own hands
("No such hand." P0002), refuses a malformed plan whole, and keeps the
`done_at` of the tasks a rebuild keeps by `(kind, ref)` (60 / 10 min);
`set_study_task(task, done)` ticks a task named by id *and* owner ("No such
task." either way), this week's or last week's only (600 / 10 min). The read
`study_plan(week, from)` is invoker and counts progress inside
`[from, from + 7 days)` (`from` the reader's local Monday, within a day of
`week_start`): trainer answers matching a task's filter, distinct drills of
its spot keys answered; its helpers `study_week` and `study_week_valid` are
granted to `authenticated` and not to `anon`. The focus snapshot is shape-
and size-checked only: it is shown back to its owner alone.

### Tests

`supabase/tests/database/analysis.test.sql`: no client INSERT/UPDATE/DELETE
grant on either table; definer/invoker and `search_path` on every function;
the helpers executable by `authenticated`; the route reservation; the writer's
ownership check (a foreign and an unknown id, one answer), server-computed
aggregates, duplicates that graft nothing, version and status checks, the
severity cap; coverage, the trimmed document, overview arithmetic, the
breakdown and sort whitelists, isolation between two users, anon, prune.
`analysis_grades.test.sql` (A2b): unchanged table grants; invoker and
`search_path` on the replaced reports and the grade helper; the grade
filters and their whitelist; graded moves and hands, EV loss and score; the
distribution overall, by street, by preflop scenario, position and pot type;
the EV-loss sorts; isolation and anon. `analysis_reports.test.sql` (A3):
unchanged table grants; invoker, `search_path` and grants on both reports and
the helper; the per-node, per-class and postflop counts; `allin` for a shove;
every filter, facets that ignore them, one version per report; the deviation
list's order, paging, action filter and validation; isolation and anon. `analysis_leaks.test.sql` (A6): unchanged table grants; invoker,
`search_path` and grants on the three reports and four helpers; the best
action and the spot key; per-spot sums (Perfect moves counted, Good not a
mistake), dates and facets; every filter and one version per report; the
leak list's order, deviations, paging and validation; weekly, monthly and
session buckets (and the gap), per street and seat; isolation and anon. `analysis_training.test.sql` (A7): no client write grant on the three
tables and RLS on; definer writers and invoker readers, `search_path` and
grants; the SM-2 table; drills only from the caller's own Mistakes and
Blunders, once, with the spot key, re-pointed at a new version; reviews of
one's own drill only, option bounds and input validation; queue, summary and
per-spot counts; trainer results and their summary; isolation and anon.
`analysis_share.test.sql` (A7.1, 53 assertions): no client write grant on
`analysis_shares`, RLS on, anon cannot read it; definer and `search_path`
on all seven functions, internals executable by nobody, the switch and the
state not by anon; off by default on every surface; only the owner
switches, by any of their surfaces, with one error for foreign and unknown;
the public read: shared and published / in a thread / by a share link
returns the projected analysis (no ids, no unlisted keys), and nothing for
another version, a malformed one, a hand id, another user's private hand,
an unpublished or removed hand; a poll: nothing to anon, a non-voter, or
through the sealed page, the reference once voted, to the author and a
moderator, and nothing again once switched off.
`analysis_share_fallback.test.sql` (A5a): `read_shared_analysis` still
definer with an empty `search_path` and open to anon; with no row at the
requested version the newest older one, flagged `staleVersion`; no flag at
the version; never a newer row; once re-analysed the current row; switched
off, nothing at any version.
`analysis_share_villain.test.sql` (analysis/20, 15 assertions):
`read_shared_analysis` still definer with an empty `search_path`, open to
anon and authenticated, not to public, and dropping `villain` in its own
body; a decision stored with `facts.villain` comes back without it (to anon,
a signed-in stranger and the owner alike, at the version and through the
older-version fallback, no counter anywhere in the document), every other
fact — the turn's and river's range shapes included — and the rest of the
analysis unchanged; the owner's `analysis_hand` still has it.
`analysis_turn.test.sql` (A5a): invoker, `search_path` and grants on the
newest-first page; its order (undated last), the version kept apart, the
trimmed document, keyset paging to the end; a malformed version, isolation,
anon; still no client write grant on the analysis tables.

`analysis_study_plan.test.sql` (A8b): no client write grant on either table
and RLS on; definer writers and invoker reader and helpers, `search_path` and
grants; which weeks a plan may name; progress from trainer answers (mode,
family, seat, river line and seat) and drill reviews inside the week only,
and ticks; validation refusing a plan whole; another account's hand; the
rollover (one row per week, last week untouched, a rebuild keeping ticks by
kind and reference); an old week's tasks closed; isolation between two users
and anon.

`learn_progress.test.sql` (Learn L1, 50 assertions): see below.

## Your preflop charts: `preflop_chart_sets`, `preflop_decision_rows`

`20270811090000`, `20270811100000` (R5.3; `docs/CHARTS.md` §11 is what a user
chart is, and how it differs from the shipped ones).

**`preflop_chart_sets`** - one row per chart set of a user's: `name` (1-80
characters, trimmed), `game_format` (`cash` / `tournament`), `table_size`
(2 / 6 / 9), `stack_min_bb` / `stack_max_bb` (1-1000, low to high),
`format_version` (1; a later format migrates rows by it) and `nodes`, a JSON
object keyed by situation (`rfi:CO`, `vs-open:BB:BTN`) whose values hold per
action (`raise`, `call`, `allin`) base64 of 169 bytes - whole percents per
class - and an optional `raiseBb`. **Unlike most tables here, the owner writes
it directly** (PostgREST `insert` / `update` / `delete`): it holds nothing a
server-computed aggregate depends on, only the user's own percents, so RLS
(`owner_id = (select auth.uid())` for select, insert, update and delete; no
`anon` grant) is the access rule, and a `before` trigger,
`preflop_chart_sets_guard` (definer, so it can count and rate limit), is the
shape and limit rule: the keys must be situations of the set's table
(`preflop_chart_key_ok`, `isPlausible` in `model.ts`), only the actions a
situation allows (the big blind facing limpers checks, so no `call`), each
value base64 of exactly 169 bytes, every percent and each class's sum at most
100, a raise size in (0, 1000]; at most 300 situations (and 400 KiB) a set,
50 sets an account (counted under an advisory lock), 120 writes per 10
minutes (`enforce_rate_limit`, `preflop_charts:<owner>`). An update keeps the
row's id, owner and creation time whatever it sends.

**`preflop_decision_rows` / `preflop_decision_totals`** - the played side,
R5.2's way: one narrow row per preflop decision the analysis graded on the
shipped tree (`street = 'preflop' and source = 'chart'`, a plain set - not
the straddle set - a line and a hand class in `facts`): situation key
(`preflop_chart_node_key`; `''` when the vocabulary does not name the line),
table size of the set read, effective stack in 10 bb steps (`-1` unknown),
class (0-168, `preflop_class_index`), action (`fold`, `check`, `call`,
`raise`, `allin`), scenario, seat, time, format, EV loss against Rail's
charts and grade; the totals sum them per (owner, version, format, table,
depth step, key, class, action). Select-own, no client write. Kept by two
statement triggers on `decision_analysis` (`decision_analysis_preflop_rows_*`:
insert adds; delete - a prune, a hand or an account deleted - subtracts using
the rows' own values), each under a per-account advisory lock;
`preflop_decision_rows_rebuild(owner)` (definer, granted to nobody) recounts
one account, and the migration backfills every account with analysed
decisions. Nothing here changes a decision, a grade or `analysis/N`.

**Readers** (invoker, `search_path = ''`, `authenticated` only, owner-first
as `20270804090000_owner_first_readers.sql` has every reader be: the owner
bound once, `owner_id` on every table read, a plan per call):
`preflop_chart_played(version, period, format, table, min_bb, max_bb)` -
`[key, class, action, decisions, EV loss]` cells for a chart's game, all
time from the totals, 30 / 90 / 365 days (counted back from the last
decision's day) from the rows; `preflop_chart_examples(..., key, class,
action, limit)` - the hands behind one cell, newest first, at most 50;
`preflop_chart_session(filter, from, to)` - one session's decisions under the
shared filter's groups (as `session_review` reads them, through
`hero_report_rows`), at most 7 days and 5,000 decisions;
`preflop_chart_review_hands(filter, hand_ids)` - `session_review`'s hand row
for up to 50 of the caller's hands.

Tests: `supabase/tests/database/preflop_charts.test.sql` (the sets) and `preflop_charts_compare.test.sql` (the played side).

## Learn: `lesson_progress`, `lesson_cards`

Learn L1 (`20270317090000_learn_progress.sql`, `docs/LEARN-PLAN.md`). The
course ships with the app; exercises are generated and graded in the
browser. Two tables keep a signed-in learner's state, owner-scoped with RLS
select-own, **no client INSERT, UPDATE or DELETE grant**, nothing to `anon`
(a signed-out learner keeps the same two things in the browser's storage):

| Table | Key | What |
| --- | --- | --- |
| `lesson_progress` | `(owner_id, lesson_id)` | `status` `started` / `passed` (sticky, with `passed_at`), and `exercises`: per exercise id the latest `correct`/`total`, an ever-`passed` flag and `attempts` (16 KB). |
| `lesson_cards` | `id`; unique `(owner_id, item_key)` | A missed quiz item: its `kind` (`chart-quiz`, `solver-spot`, `calc`, `classify`), a small `item` spec (kind and seed, ≤ 2 KB) the browser regenerates it from, and the drills' SM-2 state (`reps`, `lapses`, `ease`, `interval_days`, `due_at`, `reviews`, `last_grade`). |

Writes are three `security definer` functions with explicit `auth.uid()`
checks, `search_path = ''` and per-account rate limits:
`record_lesson_results(rows)` (≤ 100; lesson and exercise ids by shape,
`0 ≤ correct ≤ total ≤ 1000`; validated whole; at most 200 lessons per
account, since the database does not know the catalogue);
`add_lesson_cards(cards)` (≤ 20; kind, key and item shape; a card missed
again is due now; at most 2,000 per account); `review_lesson_card(card,
grade)` (named by id *and* owner, "No such card." either way; the schedule is
`drill_quality` + `drill_next`, the drills' own). Results and grades come
from the browser and are shape-checked only: a false one marks only its
sender's lessons. Reads are plain selects under RLS.

The study plan's `study_tasks.kind` gains `lesson` (reference: a lesson id):
`save_study_plan` accepts it and `study_plan` counts it done when the
caller's `lesson_progress` row for it is `passed`. `learn` joins
`username_reservations` (a new top-level route).

### Tests

`learn_progress.test.sql`: no client write grant on either table, no grant
at all to anon, RLS on; the three writers definer, every function (and the
replaced study-plan pair) with an empty `search_path`, `study_plan` still
invoker; execute for `authenticated` (with the SM-2 helpers) and not for
anon; the route reservation; latest score, sticky exercise and lesson passes,
attempts; validation refusing a batch whole; the 200-lesson cap; cards once
per item, missed again due now, kinds and shapes and the 20-card batch;
SM-2 on review (pass: a day, fail: relearned in ten minutes); another
account's card; isolation; the plan's lesson task done only for the passing
account; anon reads and writes nothing.

## Desktop ingest: `hand_sources` and `ingest_hands`

`20270428090000_desktop_ingest.sql` (Rail R1.8, `docs/RAIL-PLAN.md`). The
desktop app keeps every hand in its local store and syncs it here; this is
the server side of that.

**What a desktop row is (Q4, 2026-10-13).** The PHF and nothing else:
`standard_text` and `source_text` are null and `meta.rawText` is empty. The
originals stay on the user's disk; the standard text is rendered from the
PHF wherever the web needs it (`storedStandardText` in `lib/db/mapping.ts`:
`getHand`, `read_share` on both the page and the client). A row is ~3.6 KB
(PHF ~2.9 KB) against ~7.3 KB for a web row. With `meta.rawText` empty the
serializer cannot read a room's presentation quirks off the source, so 220 of
the corpus's 8 422 hands (almost all GG) render with small differences from
the room's text (trailing space on blank `Dealt to` lines, a replayed header,
`SHOW DOWN`, fee columns); every one reads back as the same hand. Per-seat
statistics go through `save_hand_stats` as for web rows; until the Rust
stats engine (R2.1) the web's `/api/stats/rebuild` derives them from the PHF,
which works for desktop rows unchanged.

**`hand_sources`.** One row per folder the app watches on one device
(`kind = 'folder'`; one `web` source per account holds the web's bulk uploads, R4.2, [below](#web-bulk-upload-the-web-source-and-hand-uploads)). The app's
random per-installation `device_id`, its own `local_id` for the folder, a
device name, a label (room plus the folder's last component - **never a
path**: `/` or `\` is refused) and the site; received / inserted / duplicate
/ rejected counters, the last rejection and the last ingest, maintained by
`ingest_hands`. Readable by its owner; no client write grant;
`register_hand_source` is idempotent, 200 sources per account. Hands do not
point at their source (16 bytes a hand for a link nothing reads yet);
`hands.origin` is what the pull (R1.9) needs.

**`ingest_hands(p_source, p_rows)`.** At most 500 rows and 8 MiB per call
(22023 otherwise); the source must be the caller's (23503, the same for
"unknown" and "not yours"); the budget is spent before anything is written
(53400; per account, see [Rate limiting](#rate-limiting)). Each row is
`{hand_key, phf}`. **The server derives every search column** from the PHF
with `hand_row_from_phf()`, the SQL twin of `handInsertFromPhf`
(`lib/db/mapping.ts`) - so a desktop row's columns are a function of its PHF
whoever sent it, as `fast_fold` already was - and checks the derived row
against the `hands` rules with `hand_row_problem()`, so one bad hand is
rejected alone instead of failing the insert. Then one `insert ... on
conflict (owner_id, hand_key) do nothing`. The answer lists every row in
input order:

| `status` | Meaning |
| --- | --- |
| `inserted` | New in the caller's library. |
| `duplicate` | Already there (sent before, uploaded on the web, or earlier in the same batch). Nothing rewritten. |
| `rejected` | With `reason`: `shape` (not an object, or the PHF lacks what the mapping reads), `schema` (not `phf/1`), `hand-key` (not `site:id`, or not the PHF's own key), `raw-text` (Q4), `too-large` (over 256 KiB), `invalid` (plus `field`: the column whose rule the derived row breaks). |

**The mapping is held to the TypeScript by a test.** `npm run
desktop-ingest:parity` (tests/, needs `RAIL_PARITY_PSQL` pointing at a local
stack's `psql`) saves every corpus hand through `save_hands` with the
TypeScript row and through `ingest_hands` with only its PHF, in one
rolled-back transaction, and compares every column: 7 496 distinct hands, 0
differences. `npm run desktop-ingest:fixture` regenerates
`supabase/tests/database/desktop_ingest_parity.test.sql` (37 hands covering
every parser and the mapping's special cases), which CI runs. **Change
`handInsertFromPhf` and `hand_row_from_phf` together**, and run both.

### Tests

`supabase/tests/database/desktop_ingest.test.sql`: definer settings and
grants, `hand_sources` sealed, refusals, idempotent registration, path
labels refused, replays are duplicates and store nothing, counters, another
account can neither read, collide with nor use a source, every rejection
reason in one mixed batch, the text rule from every writer, both budgets, a
refused call writes nothing, the web's global budget untouched, the stats
rebuild and `save_hand_stats` on desktop rows.
`supabase/tests/database/desktop_ingest_parity.test.sql`: generated, above.

### Web bulk upload: the web source and `hand-uploads`

`20270609090000_hand_origin_upload.sql` and `20270609091000_web_bulk_upload.sql`
(Rail R4.2). The converter saves a drop of any size while it converts it
(`frontend/src/components/converter/bulkSaver.ts`), through **`ingest_hands`
from the account's web source** rather than `save_hands`:

- `save_hands` spends the web's **global** `hands_insert` budget (25 000 rows
  per 10 minutes for everyone): a 1 000 000-hand upload would need seven
  hours and lock every other account out meanwhile. `ingest_hands` spends the
  account's own (the `desktop_ingest` buckets above).
- A `save_hands` row carries the original text twice (`source_text`, the
  PHF's `meta.rawText`) plus the standard text, ~7.3 KB; an ingested row is
  the PHF alone, its columns derived here (A5, Q4). From the web the original
  text leaves the tab only on the user's explicit opt-in (A2), below.
- The same hand from the app and from the web is the same row - tested over
  the whole corpus, statistics included, by `npm run parity` (R4.4).

`register_web_hand_source()` returns the caller's one `hand_sources` row of
kind `web` (unique per account since R1.8), creating it on first use.
`ingest_hands` accepts that source as well as folders; its rows are
`origin = 'upload'` - the desktop row's shape (CHECK `hands_text_by_origin`
now names both), written from the browser. The insert policy still admits
`origin = 'web'` only, so neither shape can be written through PostgREST or
`save_hands`; a hand saved one at a time (paste box, replayer) is still a
`save_hands` web row. `hand_arrivals` reports an upload as `web`.

**The bucket `hand-uploads`** holds the originals a user chose to keep
("Also keep the original files", off by default, per visit): private, 50 MiB
an object, `application/gzip` only; objects at `<uid>/<upload id>/<path>.<hash>.gz`.
Policies on `storage.objects` (`hand_uploads_owner_select`, `_insert`,
`_delete`, all `to authenticated`) require the first path segment to be
`auth.uid()`: an account lists, reads, stores and deletes its own originals
and nothing else; no UPDATE policy (an original is never rewritten; the
client uploads with `upsert: false` and treats "already exists" as done);
`anon` has no policy. Storage objects do not cascade from `auth.users`:
account deletion, when it is built, must remove `hand-uploads/<uid>/`.

#### Tests

`supabase/tests/database/web_bulk_upload.test.sql`: the function's settings
and grants, one stable web source per account, upload rows (shape, origin,
derived columns), a repeat is all duplicates, the original text refused per
row, the counters, the account's budget charged and the global one not,
another account can neither send from the source nor see its rows, the text
rule from every writer, the bucket's settings, and the policies: own folder
insert / list / delete, another account's folder and a non-uid top folder
refused, no update, another account and `anon` see and delete nothing.

### The desktop pull: `hands_since`

`20270505090000_desktop_pull.sql` (Rail R1.9). The app keeps the account's
whole library in its local store, so the app and the web show the same
hands: it uploads its own with `ingest_hands` and **pulls the rest** - hands
saved on the web and hands synced from the account's other computers.
Which device sent a row is not recorded per hand, so the pull walks every
row of the account, **keys first**: `hands_since(p_after_created,
p_after_id, p_limit)` returns a keyset page (`(created_at, id)` ascending,
at most 1 000) of `id, created_at, hand_key, origin` - ~150 bytes a row -
and the app fetches the PHF (`GET /rest/v1/hands?select=hand_key,phf&id=in.
(...)`, plain RLS) only for the keys its store lacks. A device's own uploads
cost it ~150 bytes each to recognise.

**Why rows younger than a minute are left out.** `created_at` is set to
`now()` by `hands_normalize`: the inserting transaction's *start*. A
transaction can commit after one that started later, and a cursor that
moved past the later row would never see the earlier one. Every client
write reaches `hands` through PostgREST as `authenticated` (`save_hands`,
`ingest_hands`), whose `statement_timeout` (8 s on Supabase) ends a
transaction long before a minute, so a row older than a minute that is not
yet visible cannot exist. The price is a minute or two before a web upload
reaches the app (it pulls every five minutes anyway; the web's own live path
is Realtime, R1.10).

Invoker, `search_path` pinned, explicit owner filter plus RLS, EXECUTE for
`authenticated` only; index `hands_owner_created_idx (owner_id, created_at,
id)`. No write path, no new grant on a table.

`supabase/tests/database/desktop_pull.test.sql` (17): invoker and grants, the
result columns (no PHF), anon / no-uid / half-cursor refusals, pages that
visit every settled row once in order (ties on `created_at` included),
desktop and web rows alike, never another account's, a fresh row hidden
until it settles and then found after the cursor, the page size clamped.

### Live arrival on the web: `hand_arrivals`

`20270512090000_hand_arrivals.sql` (Rail R1.10). The web's `/library` and
`/stats` refresh on their own when hands land in the account - a desktop
`ingest_hands` call (up to 500 hands) or a `save_hands` call from another
tab. The client side is `components/live/useHandArrivals.ts` (the
subscription) and `lib/live/arrivals.ts` (when a signal becomes a refetch).

**Why not Postgres Changes on `hands`.** Realtime decodes every published
row with wal2json and sends the whole record: the PHF (~2.9 KB, up to
256 KiB) and, on web rows, the standard and source text - ~2 MB to every
open tab for a 500-hand batch, to say "refresh". A column list on the
publication does not help: Realtime reads the slot with wal2json's
`add-tables`, which ignores column lists. Every insert - a 500 000-hand
backfill - would also be decoded and checked against RLS once per
subscriber per row. And with `hands` out of the publication, no filter, no
setting and no Realtime bug can put a hand on a socket.

**The signal.** `hand_arrivals` holds **one row per account**: `id` (a
random uuid primary key), `owner_id` (unique), `seq` (bumped per signal),
`hands` (how many the statement added), `origin` (`web` / `desktop`),
`arrived_at`. The statement-level trigger `hands_signal_arrival` (after
insert on `hands`, after `hands_rate_limit_after_insert`, reading the
transition table) upserts it once per owner per **statement**: one
`ingest_hands` call is one change of ~320 bytes on the wire, whatever its
size; a call that added nothing (all duplicates) signals nothing. The
trigger swallows its own failure - a live signal must never fail a save;
the page re-reads on reconnect. The first arrival is an INSERT, every later
one an UPDATE; the client listens for both.

**Who receives what** (the threat model's question; checked end to end by
`npm run realtime:arrivals` in `tests/`, against a local stack):

| Subscriber | Receives |
| --- | --- |
| A, filter `owner_id=eq.A` | A's changes |
| A, filter `owner_id=eq.B` (forged) | nothing: Realtime re-reads each INSERT / UPDATE as the subscriber, and the select-own policy hides B's row |
| A, no filter | A's changes only, same reason |
| `anon`, no filter | nothing: `anon` has a SELECT grant and no policy (without the grant it would get a content-free 401 notice per change; see [Notifications and realtime](#notifications-and-realtime)) |
| anyone listening for DELETE, no filter | when an account is deleted (the cascade is the only delete), the deleted row's primary key - a random uuid, not the owner. RLS cannot be applied to a row that is gone, which is why the key is not `owner_id` |

What a subscriber learns is its own row: that its own library grew, by how
much, from where. Nothing about any hand and nothing about anyone else.

**Cost.** One row per account, one upsert per insert statement (a row lock
on that account's row until the inserting transaction commits: two
`ingest_hands` calls of one account from two computers queue on it for the
rest of the call, as they already queue on their source counters). Realtime
work is per signal, not per hand.

**The web** debounces (a refetch 1.5 s after the last signal; while a
backfill keeps signalling, after 5 s, then 10, 20 and at most every 30 s),
does nothing while the tab is hidden (one refetch when it is shown again),
treats a reconnect as a signal (events in the gap are lost), and removes the
channel on unmount and sign-out. `/library` re-reads the first page in
place while the reader is at the top of it, or shows "N new hands - show"
(scrolled down, or past the first page; R4.3); `/stats` re-reads quietly and
runs `/api/stats/rebuild` for the new hands; the analysis screens (overview,
reports, progress, leaks, plan) are not touched and offer "N new hands
arrived - refresh" instead (R4.3). "Hands arriving from <device>"
under the library heading reads `hand_sources.last_ingest_at` (select-own),
shown for ten minutes after the last sync.

`supabase/tests/database/hand_arrivals.test.sql` (29): RLS on, the one
select-own policy, grants (no client writes; anon reads nothing), the
random primary key, `hand_arrivals` in the publication and `hands` not, the
columns a change carries, the trigger's definer settings and grants and
that it is per statement; one `ingest_hands` call and one `save_hands` call
are one signal each with their count and origin, all duplicates is no
signal, each account reads only its own row and a forged owner finds
nothing, a client cannot insert, bump or delete a signal, and a failing
signal does not fail the save.

### Live progress across tabs: `activity:<uid>`

`20270616090000_live_activity.sql` (Rail R4.3). A bulk upload (R4.2) knows
its progress in the tab that runs it; every other tab and device of the
account shows it too ("Saving 120 000 of ~1 000 000 hands from a web
upload", then "finished"). The uploading tab publishes a ~200-byte summary
- a random upload id, a state, counts; no hand, no file name - as its
**Presence** on the private Realtime channel `activity:<uid>`, at most every
2 s while counts move and every 15 s while they do not. Client:
`components/live/activityChannel.ts`, `lib/live/activity.ts`.

**Why Presence, not a progress row.** No database write per batch: Presence
state lives in Realtime's memory, where a progress row would be an UPDATE,
a WAL decode and an RLS check per subscriber for each of a 1M-hand upload's
~4 000 calls. Stale progress expires by itself: an entry belongs to its
socket, so a closed tab's goes when the socket does (~0.6 s on a close,
measured; Realtime's heartbeat timeout otherwise), and the web drops an
entry that has not changed for 45 s. A tab opened mid-upload gets the
current state on join.

**Authorisation.** A private join makes Realtime run, as the socket's role
with `request.jwt.claims` and `realtime.topic` set, a SELECT (receive) and
an INSERT (send) on `realtime.messages`, rolled back. RLS on that table was
on with no policy, so every private join was refused; these are its first
two policies, both `to authenticated`:

| Policy | Admits |
| --- | --- |
| `live_activity_own_receive` (select) | `extension in ('presence', 'broadcast')`, `realtime.topic() = 'activity:' \|\| auth.uid()`, and the row's `topic` is that topic |
| `live_activity_own_send` (insert) | `extension = 'presence'`, the same topic rule |

Receiving names `broadcast` because Realtime's join is itself a broadcast
read: with presence alone the join is refused (measured on the local
stack's Realtime 2.73). Sending is presence only, so nothing can be
broadcast on the topic. Checked end to end by `npm run realtime:activity`
(`tests/scripts/realtime-activity/check.mjs`, local stacks only):

| Socket | Outcome |
| --- | --- |
| A on `activity:<A>` | joins, tracks; A's other device sees the entry at once, its updates, and its leave when the tab closes (~0.6 s) |
| B on `activity:<A>`, `anon` on `activity:<A>`, A on `activity:<B>` | join refused ("Unauthorized: You do not have permissions to read from this Channel topic") |
| B or `anon` on a **public** channel named `activity:<A>` | a different channel: none of A's presence arrives there, and nothing tracked there reaches A's private one |
| A broadcasting on its own private channel | not delivered (no send policy for broadcast; a control run with one delivered it) |

The bell's and the arrivals' channels are public channels guarded by table
RLS and are not affected. Hosted project: nothing to configure; "allow
public access" in the Realtime settings must stay on for those two.

`supabase/tests/database/live_activity.test.sql` (27): exactly these two
policies on `realtime.messages`, for `authenticated`, select and insert, RLS
on; the owner may receive presence and broadcast on its own topic and send
presence, not broadcast, not another topic's rows; A on B's topic and B on
A's receive nothing and send nothing; another topic, no topic, or a topic
that only starts with the uid opens nothing; `anon` nothing at all.

### The HUD's layouts: `hud_layouts`

`20270602090000_hud_layouts.sql` (Rail R3.9). The desktop app keeps the
HUD's designs (what a panel and its popup show), which design each room,
table size and game gets, where the user dragged panels, and their per-room
"my client seats me at the bottom" in its local store
(`core/rail-store/SCHEMA.md`, migrations 13 and 15). The sync worker sends
the rows written there since the last sync and takes the account's rows
back, so a second computer shows the same HUD.

**One table, four kinds** (`kind`, `key`, `body`): `layout` (the design's
id; the design as JSON), `assignment` (`site|size|format`;
`{"layout": id}`), `seat_position` (`site|size|slot`; `{"x", "y"}` in
thousandths of the table's client area), `room_setting` (`site`;
`{"preferredSeat"}`). A **null body is a tombstone** - a deleted design, a
cleared assignment, a reset panel, a room left to its settings - so a delete
reaches the other computers instead of being lost as a missing row.

**Last writer wins by `updated_at`** - the writing computer's clock in
milliseconds, carried with the row. `put_hud_layouts` upserts each row only
when it is newer than the stored one and answers which it took; the client
reads the whole table back (`GET /rest/v1/hud_layouts`, a few hundred rows
at most) and applies each row that is newer than its own (a tie keeps the
local row: `rail_store::WriterHandle::hud_sync_apply`). Two computers with
skewed clocks resolve by their clocks; a time more than a day ahead is
refused, so a runaway clock cannot pin a row.

**Threat model.** Everything in it is the user's own: no other account reads
or writes a row (select-own RLS; the definer writer takes the owner from
`auth.uid()` only, and its conflict target includes it). `anon` has no grant
at all. **The content comes from the client**: the server checks shapes and
bounds - the kind, the key's shape per kind, a body that is an object of at
most 32 KiB or null, a sane time, 500 rows a call, 5 000 an account, the rate
limit - and not the design. A false or malicious row only changes its own
account's HUD, and the client treats pulled designs as untrusted: a design
this build cannot read is skipped (`HudDesign::parse`), keys and bodies out
of range are refused by the local store, and the HUD enforces every room's
restrictions on whatever it draws (`PanelDesign::enforce`), so a synced
design can never put, say, a card-split statistic on a PokerStars table.
Nothing in a row is a hand, a player or a statistic's value: designs name
statistics by id, positions are geometry.

`supabase/tests/database/hud_layouts.test.sql` (35): grants (no client
writes, nothing for anon), RLS, the writer's definer settings; new rows taken,
an older or equal row refused and said so, a tombstone stored and replaced by
a newer row; every refusal (not an array, not an object, an unknown kind,
malformed keys of each kind, a non-object or oversized body, a time before
2020 or days ahead, one bad row refusing the batch, 500 a call, 5 000 an
account); two accounts with the same key apart; anon reads and writes
nothing.

## Verifying the isolation

A migration returning `201` proves the SQL ran, not that two accounts are
actually separated. Prove it the way an attacker would: with two real JWTs and
`curl`. The Management-API PAT is a superuser and proves nothing about RLS, so
it must not appear anywhere in this test.

Run it after **any** change to the policies, to `save_hands`, or to
`create_share`. It is the cheapest regression test in the project.

```bash
cd frontend  # .env.local has the URL and anon key
URL=$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | cut -d'"' -f2)
KEY=$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY .env.local | cut -d'"' -f2)
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
| anon calls `read_share(slug of A's hand)` | **Succeeds** — this one must not be locked down |
| that response contains `source_text`, `owner_id` or `phf.meta.rawText` | **Must not** — see [Share resolution](#share-resolution-read_share--record_share_view) |
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
| `standard_text text` | GG-style rendering, derived from `phf`. **Null on desktop rows** (R1.8, Q4): readers render it from `phf` (`storedStandardText` in `lib/db/mapping.ts`) | Holdem Manager import is byte-sensitive; storing the render means we never re-serialize, and never risk a serializer change silently altering an old export. |
| `source_text text` | The original site text. Null on desktop rows: the originals stay on the user's disk (Q4) | So a hand can be **re-converted** after a parser bug is fixed, without asking the user for the file again. |

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
| `origin` | enum `hand_origin` | — | `web` (`save_hands`), `desktop` (`ingest_hands` from an app folder, R1.8) or `upload` (`ingest_hands` from the account's web source: the converter's bulk save, R4.2). Decides the text rule below (`desktop` and `upload` rows are PHF only); the direct insert path can only write `web`. |

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
| `hands_text_by_origin` | A web row has `standard_text`; a desktop row has no `standard_text`, no `source_text` and an empty `phf.meta.rawText` (Q4). |
| `hands_desktop_phf_size` | A desktop row's `phf` is at most 256 KiB. |

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
| `origin` (enum `unparsed_origin`) | `web` (default; verbatim `raw_text`) or `desktop` (anonymised `raw_text`). Which client **created** the row; never changed afterwards. R0.11. |
| `os`, `client_version` | The last desktop client that reported the fingerprint (`windows` / `macos` / `linux`; a version string). Refreshed on every desktop repeat, also on a web row. Required on a desktop row. |
| `consented_at` | When the user agreed to share the sample. Required on a desktop row, never set on a web row, set at insert only (it describes `raw_text`, which a repeat never rewrites). Not after `first_seen_at` + 5 minutes. |
| `anonymiser_version` | The anonymiser that produced `raw_text` (`rail-anon/1`). Required on a desktop row; `null` means verbatim. |
| `guessed_site`, `guess_confidence` | For a file no parser claims: the core's guess - a detector below the threshold, or a known format's signature (`bossmedia`, `merge`). Separate from `detected_site`, which names the parser that refused a hand and groups `unparsed_gaps`. |

Mirrors the `ConversionFailure` interface in `frontend/src/lib/phf/detect.ts`
exactly, plus `status` / `notes` / counters, plus the R0.11 registry fields
the desktop app sends (`docs/unsupported-formats.md`).

The consent rule is two `CHECK` constraints, `unparsed_desktop_consent` (a
desktop row has consent, anonymiser version, OS and client version) and
`unparsed_desktop_sample_size` (at most 64 KiB), with
`unparsed_consent_before_sample`, `unparsed_os_ok`,
`unparsed_client_version_ok`, `unparsed_anonymiser_version_ok`,
`unparsed_guessed_site_len` and `unparsed_guess_confidence_ok` for shapes.
pgTAP: `supabase/tests/database/unparsed_registry.test.sql`.

### `unparsed_gaps` (view)

`unparsed_hands` rolled up by `(detected_site, stage, reason, status)` with
`distinct_hands`, `total_occurrences` and first/last seen, and since R0.11
`desktop_hands` (rows created by the desktop app) and `guessed_sites` (the
distinct `guessed_site` values, sorted). Declared
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
| `owner_id` | Who created the link. **Not** a read gate — `read_share` ignores it, because a link has to work for a stranger. It is also never returned to the reader. It exists so a link is attributable and so a deleted account takes its links with it. |
| `views`, `last_viewed_at` | Bumped by `record_share_view`, never by `read_share`. |
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
| `search_hands(p_filters jsonb, p_limit int, p_offset int)` | `authenticated` | `{total, limit, offset, rows}` | The whole browse filter set, sorted, paginated, **with the total count**, in one call. Scoped to the caller by RLS and, since `20270804090000`, by an explicit bound owner as well ([Owner first](#owner-first-a-readers-work-is-the-callers-rows)) — there is no filter key that could ask for anyone else's hands. Sort keys are whitelisted, so the query stays on an index. Heavy columns (`phf`, `standard_text`, `source_text`) are excluded: a page of 50 hands should be kilobytes. |
| `get_hand(p_id uuid)` | `authenticated` | full row as jsonb | The payload, fetched only when a hand is actually opened. `null` for an unknown id *and* for another account's id — indistinguishable by design. |
| `library_count()` | `authenticated` | bigint | How many hands the caller has stored (the web's header badge). From `library_hand_counts`, not a pass over the hands (`20270818090000`). It replaced the badge's read of `hands_facets()` - every distinct filter value of the library, computed to show one number - which was retired with it (the browse UI's counts are `library_facets` since R4.5b). |
| `record_conversion_failures(p_failures jsonb)` | `authenticated` | `{received, created, updated, skipped}` | Upserts `ConversionFailure` records by fingerprint, incrementing `occurrences` atomically and recording the first submitter. Truncates over-long fields and skips malformed records rather than failing the batch: losing a sample we cannot reproduce is worse than storing a lossy one. Never writes `status` or `notes`. Max 200 per call. Optional keys since R0.11: `origin` (`web` when absent; an unknown value skips the record), `os`, `clientVersion`, `consentedAt`, `anonymiserVersion`, `guessedSite`, `guessConfidence`. A `desktop` record without a valid `consentedAt`, `anonymiserVersion`, `os` and `clientVersion`, or over 64 KiB, is skipped. |
| `unparsed_summary(p_limit int)` | `anon`, `authenticated` | jsonb | `unparsed_gaps` ordered by impact, plus totals and a `byStatus` breakdown. `security invoker`, so a client sees only its own submissions; the cross-corpus answer to "which converter next" is a service-role query. |
| `create_share(p_hand_id, p_phf, p_standard_text, p_title)` | `authenticated` | `{id, slug}` | Allocates a slug (retrying on collision) and inserts one row owned by the caller. **Refuses a `p_hand_id` the caller does not own** — it is `security definer`, so this check is not optional. |
| `read_share(p_slug text)` | `anon`, `authenticated` | jsonb or `null` | Resolves a slug to `{slug, title, views, createdAt, handId, phf, standardText}` and nothing else, ignoring ownership entirely — a link works for anyone, which is the point. `stable`, no side effects. `null` for unknown *or* malformed slugs, deliberately indistinguishable, so probing tells an attacker nothing. |
| `record_share_view(p_slug text)` | `anon`, `authenticated` | boolean | Increments `views` / `last_viewed_at` for one slug. Returns `false` instead of raising when throttled, unknown or malformed. |
| `resolve_share(p_slug text)` | `anon`, `authenticated` | jsonb or `null` | **Deprecated — remove on or after 2026-11-27.** Thin wrapper over the two above, kept only for clients built before the projection fix. No longer returns the `hand` key. |
| `enforce_rate_limit(...)` | `service_role` | void | Internal. |
| `generate_share_slug(int)` | `service_role` | text | Internal. |
| `phf_redact_private(jsonb)` | `service_role` | jsonb | Internal. Strips the private keys from a PHF document's `meta`. |
| `register_hand_source(p_device_id, p_local_id, p_device_name, p_label, p_site)` | `authenticated` | uuid | Registers (or renames) a folder the desktop app watches; idempotent per account + device + local id. No paths: a label with `/` or `\` is 22023. R1.8. |
| `ingest_hands(p_source uuid, p_rows jsonb)` | `authenticated` | `{received, inserted, duplicates, rejected, rows}` | Desktop sync: `{hand_key, phf}` rows into the caller's library from one of their sources, every search column derived from the PHF. See [Desktop ingest](#desktop-ingest-hand_sources-and-ingest_hands). R1.8. |
| `register_web_hand_source()` | `authenticated` | uuid | The caller's web hand source, created on first use; the converter's bulk save sends `ingest_hands` from it. R4.2. |
| `hands_since(p_after_created timestamptz, p_after_id uuid, p_limit int)` | `authenticated` | `setof (id, created_at, hand_key, origin)` | The desktop pull: a keyset page of the caller's hands, oldest first, rows at least a minute old, at most 1 000. See [The desktop pull](#the-desktop-pull-hands_since). R1.9. |
| `put_hud_layouts(p_rows jsonb)` | `authenticated` | jsonb `[{kind, key, applied}]` | The desktop HUD's layout rows `{kind, key, body, updatedAt}` (at most 500), each kept only when newer than the stored one. See [The HUD's layouts](#the-huds-layouts-hud_layouts). R3.9. |
| `villain_counters(p_players jsonb, p_filters jsonb)` | `authenticated` | `setof (site, player, hands, vpip_opp, vpip, pfr)` | The caller's own counters for the named opponents (`{site, player}` keys, at most 500 per call), `none` rooms only, no bomb pots; invoker, read only. The analysis' per-villain ranges (analysis/20), without `stats_opponents`' cap of 200. See [Statistics](#statistics-hand_stats-coverage-and-rebuild). |

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

`hands_facets()` (retired in `20270818090000`) additionally returned
`heroPositions` (with counts — a lopsided distribution is itself informative),
`showdownPositions`, and `anonymizations` (with counts, so the UI could tell
whether the name filter is safe to offer at all); `library_facets` carries
the same groups.

### Share resolution: `read_share` + `record_share_view`

`20261003090000_share_projection.sql` replaced the single `resolve_share` with a
read and a counter. Two independent reasons.

**1. The payload was the whole row.** The baseline did
`select to_jsonb(h) into v_hand`, then returned `v_hand` under a `hand` key. A
share slug is a capability URL handed to strangers on purpose, so once it is out
there is no authentication step left to tighten — the only control left is what
the function chooses to return. `to_jsonb(row)` makes that a function of the
*table definition*, which means everyone with a link was getting `source_text`
(the verbatim site text, every opponent's screen name), `owner_id` (the sharer's
`auth.users` uuid, a stable correlator across every link they ever post),
`hand_key` / `site_hand_id` and `source_filename` — and a column added to
`hands` years later for an unrelated reason would have joined them silently.

`read_share` names its seven output keys one at a time: `slug`, `title`,
`views`, `createdAt`, `handId`, `phf`, `standardText`. Adding a column to `hands`
now changes nothing; widening the share payload requires editing that file,
which is the review gate we want. **Any path that publishes a hand to someone
who does not own it should copy this shape rather than invent a second one.**

`phf` goes through `public.phf_redact_private()`, which drops four `meta` keys:

| Key | Why it goes |
| --- | --- |
| `meta.rawText` | The hand's slice of the uploaded file, verbatim. This is `source_text` by another name — stripping the column and leaving this would fix nothing. |
| `meta.originalFilename` | The uploader's local filename. Frequently a real name. |
| `meta.warnings` | Parser diagnostics quote source lines, so they are a partial `rawText` with extra steps. |
| `meta.parsedAt` | Says nothing about the hand and everything about the owner's session times. |

It is a **deny-list**, deliberately: `meta` is versioned by the PHF schema and a
new *rendering* key upstream must keep working without a migration. The trade is
that a new *sensitive* key needs a line in that function — so the rule for
`frontend/src/lib/phf/types.ts` is that anything user-identifying goes into
`meta` only if it is added to the deny-list in the same change.

What stays exposed: `standardText` and the redacted `phf` still carry the
opponents' screen names and everybody's shown hole cards. That is not an
oversight — it *is* the hand, and a replayer with the names blanked out is not
the feature anyone asked to share. What goes is the material that has nothing to
do with replaying.

**2. The counter forced the read to be a write.** Because `resolve_share` did an
`UPDATE`, it had to be `volatile`, so PostgREST would not serve it over GET,
nothing above it could cache it, and a read-only consumer could not exist.
Open Graph tags for link-unfurl crawlers had to come from somewhere, and every
crawler prefetch counted as a human view — Slack alone unfurls a link once per
member who sees it, so `views` measured "times pasted", not "times read".
`read_share` is now `stable` and writes nothing; `record_share_view` is
`volatile` and does nothing else.

Since the Next.js cutover (#26) the consumer is `frontend/src/app/h/[slug]/`,
an RSC whose `generateMetadata` and page body both call `read_share` through one
React `cache()` — so the tags and the page are one round trip and neither
counts. The counter is a client beacon (`RecordShareView.tsx`) with a
`sessionStorage` guard, which a crawler does not run. The edge function that
used to serve UA-sniffed tags, `frontend/api/share-meta.ts`, is deleted.

Consequence for callers: `read_share` returns the count **before** your view.
`resolveShare()` in `frontend/src/lib/db/shares.ts` fires `record_share_view`
fire-and-forget after a successful read, so the view is never counted for a slug
that did not resolve and the page never waits on a counter.

`resolve_share` survives as a thin wrapper for un-migrated clients, **scheduled
for removal on or after 2026-11-27**. It no longer returns `hand` — that key
existed only as a whole-row dump and is not a compatibility surface worth
keeping; old clients read it into an optional field and render `null` without
complaint. Before dropping it, check the Supabase logs for `rpc/resolve_share`
in the preceding week.

Verify with the **anon key**, never a PAT — a PAT bypasses RLS and holds every
grant, so a leak test that passes under one proves nothing:

```bash
curl -s "$SUPABASE_URL/rest/v1/rpc/read_share" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "authorization: Bearer $SUPABASE_ANON_KEY" \
  -H 'content-type: application/json' \
  -d '{"p_slug":"<a real slug>"}' \
| jq '[ (has("hand")|not), (has("source_text")|not), (has("owner_id")|not)
      , (.phf.meta|has("rawText")|not), (.phf.meta|has("originalFilename")|not)
      , (.phf.meta|has("warnings")|not), (.phf.meta|has("parsedAt")|not) ] | all'
```

Must print `true`, and so must the same call against `rpc/resolve_share` — the
deprecated wrapper is not a bypass.

---

## RLS policies and grants

RLS and grants are two independent layers and both are set explicitly. Supabase
ships `alter default privileges in schema public grant all on tables/functions
to anon, authenticated, service_role`, so **every new object starts
over-permissioned** and the migration revokes first, then grants.

| Table | `anon` | `authenticated` | Policies |
| --- | --- | --- | --- |
| `hands` | **none** | `SELECT`, `INSERT` | `hands_owner_select` / `hands_owner_insert`, both `owner_id = (select auth.uid())`; the insert policy also requires `origin = 'web'` (R1.8: desktop rows only through `ingest_hands`). No `UPDATE`/`DELETE` policy — with RLS on and no permissive policy, both are refused regardless of grants, for owners too. |
| `unparsed_hands` | `SELECT` | `SELECT` | `unparsed_own_select` (`submitted_by = (select auth.uid())`). Writes go through the definer RPC; a direct `INSERT` would let a caller invent an occurrence count or set `status = 'wontfix'` on someone else's row. |
| `unparsed_gaps` (view) | `SELECT` | `SELECT` | `security_invoker`, so the base table's policy applies. |
| `shares` | **none** | **none** | **none**. Sealed. `create_share` / `read_share` / `record_share_view` only. |
| `ingest_rate_limit` | **none** | **none** | **none**. Internal. |
| `hand_sources` | **none** | `SELECT` | `hand_sources_owner_select` (`owner_id = (select auth.uid())`). Written only by `register_hand_source` and `ingest_hands`. |
| `preflop_chart_sets` | **none** | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | One owner-only policy per command, all `owner_id = (select auth.uid())`; `preflop_chart_sets_guard` (before insert or update) checks the nodes' shape and the limits and keeps an update's id and owner (R5.3). |
| `preflop_decision_rows`, `preflop_decision_totals` | **none** | `SELECT` | Select-own. Written only by the triggers on `decision_analysis` and `preflop_decision_rows_rebuild` (R5.3). |
| `hud_layouts` | **none** | `SELECT` | `hud_layouts_owner_select` (`owner_id = (select auth.uid())`). Written only by `put_hud_layouts` (R3.9). |
| `hand_arrivals` | `SELECT` | `SELECT` | `hand_arrivals_own_select` (`to authenticated`, `owner_id = (select auth.uid())`); none for `anon`, so anon reads zero rows. Written only by the `hands_signal_arrival` trigger. The anon grant is for Realtime: see [Live arrival on the web](#live-arrival-on-the-web-hand_arrivals). |

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
`get_hand`, `library_facets` all inherit the owner policy for free. Readers that
aggregate or page over an account's rows filter by the owner explicitly as
well, for speed rather than for safety: see [Owner first](#owner-first-a-readers-work-is-the-callers-rows).

It does **not** cover `create_share`, which is `security definer` and therefore
runs with the function owner's privileges, seeing every row in `hands`. Without
an explicit `h.owner_id = auth.uid()` in its body, any signed-in caller could
mint a public link to a stranger's hand by guessing a uuid. That check is the
single most load-bearing line in the migration, and it returns the same error
for "no such hand" as for "not your hand" so it cannot be used to probe which
uuids exist.

### Owner first: a reader's work is the caller's rows

Every table here holds every account's rows, and one account may hold a
million hands. A reader's time must depend only on the caller's rows - not on
what other accounts hold. RLS alone does not give that: the policy's
`owner_id = (select auth.uid())` is an InitPlan, a value the planner does not
know when it plans, so it estimates "the caller's rows" as rows / distinct
owners - half of every table when there are two accounts, for the small one
as for the big one. Found in R5.1 (`20270804090000_owner_first_readers.sql`):
beside a 1 000 000-hand account, a 7 496-hand account's `library_facets` took
16-24 s (a hash join over all 6M `hand_stats` rows and 1M `hand_stats_ev`
rows, estimated 503 748 hands for 7 496), `hands_facets` 39-62 s (thirteen
sequential scans of the whole 2 GB `hands` table), a filtered `library_page`
4-9 s (a global sort index walked across both accounts). The rule for every
owner-scoped reader (`library_*`, `search_hands`, `stats_*`,
`report_*`, `players_list`, `player_profile`, `player_sites`,
`my_player_notes`, `villain_counters`, `hands_needing_stats`, `hands_since`,
`unparsed_summary`, R5.1's `session_review`, R5.2's `analysis_top_leaks` and `analysis_leak_examples`;
since `20270818090000` also every `analysis_*` reader, `hands_needing_analysis*`,
`drill_*`, `trainer_summary`, `study_plan`, `get_hand` and the forum's
`my_post_state`, `my_saved_posts`, `my_notifications`,
`unread_notification_count` - RLS alone, an InitPlan, or for
`analysis_leak_sample` the owner as an argument, before):

1. **PL/pgSQL, the caller in a variable**: `v_owner uuid := auth.uid();` -
   never a SQL function, whose owner would be the InitPlan again.
2. **`owner_id = v_owner` on every owner table the statement reads, joins
   included** (`left join hand_stats hs on hs.hand_id = h.id and hs.owner_id =
   v_owner ...`). In dynamic SQL the owner is a bound parameter (`$4`), never
   `(select auth.uid())`. The predicate equals the policy's, so no answer
   changes; RLS stays on every table (defence in depth).
3. **Planned per call**: `set plan_cache_mode = force_custom_plan`. A custom
   plan sees the owner's value and its row count (the column's statistics);
   a cached generic plan is planned for "some owner", and PostgREST's pooled
   connections serve every account. (A `create or replace` drops `set`
   clauses it does not repeat: repeat it.)
4. **Indexes lead with `owner_id`**, sort indexes included
   (`hands_owner_played_idx`, `hands_owner_played_asc_idx`,
   `hands_owner_pot_idx`, `hands_owner_profit_desc_idx` / `_asc_idx`,
   `hands_owner_created_idx`); the global `hands_played_at_idx`,
   `hands_total_pot_idx`, `hands_hero_profit_idx` and `hands_created_at_idx`
   are gone - a page walked them across every account and filtered the owner
   out.
5. **Expressions the planner can estimate**: a filter on a cast or a helper
   (`game_format::text`, `library_size(...)`) gets a guess of half a percent
   per value unless there are statistics on it (`hands_library_groups`,
   `hand_stats_library_groups`, `create statistics` on the expressions);
   with the guess a big account's page sorted a million rows instead of
   walking its index to the first hundred.
6. **Under RLS only a leakproof operator is an index condition.** The policy
   runs before the query's own predicates, so `ilike`, `@>`, `&&` (not
   leakproof) are filters on rows already fetched, never index conditions,
   whatever index exists: the trigram index on `table_name` was never used
   by a reader. A search by a part of something is answered by leakproof
   operators instead - the library's table-name search matches the part
   against the caller's distinct table names (a skip scan of
   `hands_owner_table_idx`, `=` and `>` on text) and reads the hands by those
   names (`20270818090000`). (`hands_board_gin`, `hands_hero_cards_gin`,
   `hands_players_gin`, `hands_showdown_positions_gin`,
   `hands_winner_positions_gin` are in the same position: the library's card,
   board, player and position searches filter the owner's rows in the page's
   order.)
7. **An account's own million rows**: a reader that counts or groups every
   hand of the caller reads a summary kept by triggers in the writer's
   transaction, as R4.5c-1's `hero_rollups`, the library's counts
   ([below](#the-librarys-counts-library_hand_counts-library_hero_counts))
   and the analysis screens' summaries
   ([below](#the-analysis-screens-summaries)) do.

pgTAP `owner_first_readers` holds the rule: every reader above is PL/pgSQL,
invoker and `force_custom_plan`; no `hands` index sorts all accounts
together; and, measured rather than planned, a 30-hand account's call of
each reader returns under 1 500 tuples from the tables' heaps and indexes
(this transaction's `pg_stat_get_xact_tuples_returned`) beside a 6 000-hand
account - the old definitions read every account's rows there. A new
owner-scoped reader joins its list. Since `20270818090000` the list holds the
analysis, drill, trainer, study and forum readers too (beside the big
account's 9 000 graded decisions), and `owner_first_analysis` holds each of
them to its previous body on two accounts. Since `20270825090000` the list
holds the `<reader>_scan` bodies as well, and the guard measures the
summaries' other paths (a range, a seat, the hand rows, a scan).

### The library's counts: `library_hand_counts`, `library_hero_counts`

`library_facets` (the counts beside the library's chips, each group's values
under the other groups' filters) read every hand joined to its hero row and
EV row: 7.7-10 s at 1M hands. Since `20270818090000` it reads two summaries
per (owner, UTC month, the library's groups):

| Table | Counts |
| --- | --- |
| `library_hand_counts` | hands per room, format, variant, limit, size, stake (with the currency and blinds the chip shows), position, result, anonymity |
| `library_hero_counts` | per statistics version and the same groups plus pot type and stack band: with `ev_version = ''` every hero row, with `'ev/N'` the hero rows whose EV row at N is an all-in |
| `library_counts_stale` | accounts whose counts could not be kept exactly (below) |

A filter's rows are a signed sum: each hand once without pot type, stack or
all-in; minus, plus each hero row moving its hand to its pot type and stack;
minus, plus each all-in pair moving it to all-in - exactly `library_rows`'
left joins. A range reads its whole months from the counts and the hands of
its partial months from `library_rows`; a search the counts do not hold (hero
cards or class, board, a player, showdown, table name, minimum pot, showdown
or winner positions) reads every hand as before. `library_count()` is the
sum of `library_hand_counts`.

Kept by statement triggers on `hands`, `hand_stats` (hero rows) and
`hand_stats_ev` (all-ins), in the writer's transaction, under R4.5c-1's
account lock (so a hero row and its EV row written by two transactions are
paired by the later one). A hand deleted while its account stays (no path
does that today) cascades to its hero rows before its own trigger runs, and
they can no longer say which counts they were in: the account is marked in
`library_counts_stale` and its readers read the hands until
`library_counts_rebuild(owner)` (also run by `refresh_report_summaries`)
counts it again. An UPDATE of any of the three tables recounts its accounts;
an account deleted takes its counts with it. RLS select-own on the three
tables; the triggers and the rebuild are definer, granted to nobody.

pgTAP `library_counts` (43): kept = recounted after every write path,
`library_facets` = its previous body on 177 random filters for two accounts
(ranges on and across UTC month bounds, hands without a time, every group,
versions, searches) and stale; `library_page` = its previous body for table
names (`%`, `_`, `\` literal) and every order; an unfiltered call reads no hand,
statistics or EV row.

### The analysis screens' summaries

The Analysis screens' readers computed over every graded decision of the
account on each call - `decision_analysis` joined to `hands`, each row's
options and facts unpacked: at a generated 1M-hand account (2.15M
decisions) `analysis_overview` took 58 s, the leak finder, its hands, the
trend and the drill spots over two minutes. Since `20270825090000` they read
narrow rows and sums kept by statement triggers on `hand_analysis` and
`decision_analysis`, R4.5c-1's and R5.2's way. No grade, chart, constant or
`analysis/N` changed: the stored grades are summed.

| Table | Holds | Read by |
| --- | --- | --- |
| `analysis_hand_rows` | one row per `hand_analysis` row: the hand's groups (time, room, format, stake, seat), the analysis columns, and what its decisions add up to (streets, flag codes, graded / chart / node counts, graded grade counts and sums) | `analysis_hands` (every filter), the session trend, facets' first and last |
| `analysis_month_hands` | analysed hands per (owner, version, UTC month); version `''` = at any version, each hand once | `analysis_coverage`, `hands_needing_analysis_recent` |
| `analysis_leak_rows` (R5.2's) | one row per decision - **every** decision since `20270825090000`, graded or not - with its hand's day, room, stake, format, seat, pot type, street, status, source, spot key, chart set, grade, score, EV loss (and whether it was none), and for a graded preflop chart decision its node and chosen action | a date range, a room or a stake (the readers' rows path); example hands of the leak list and the chart nodes |
| `analysis_leak_totals` | graded decisions per (owner, version, format, seat, pot type, spot key, chart set), all time, with distinct hands | `analysis_leaks`, `analysis_leak_sample`, `drill_due_by_spot` |
| `analysis_leak_stake_totals` | the same per (owner, version, room, currency, big blind, spot key, chart set) | `analysis_leaks` under a room or stake chip |
| `analysis_trend_days` | graded decisions of dated hands per (owner, version, UTC day, group: all / street / position / pot type, key) with distinct hands and first / last time | `analysis_trend` week and month |
| `analysis_overview_hands`, `_decisions`, `_flags`, `_keys` | per (owner, version, format, seat, pot type): hands by status, reason, grade, flagged, approximations; decisions by street, scenario, status, reason, grade, worst flag (facing, defended, MDF, score, EV sums); flags by street, code, severity; hands with a (graded) decision per street, scenario, preflop scenario | `analysis_overview`, `analysis_breakdown`, `analysis_hands`' count |
| `analysis_node_totals` | node decisions with a chosen action per (set, line, scenario, hand class, action); analysed postflop decisions per (street, scenario, action); all time | `analysis_node_actions` |
| `analysis_graded_sites` | hands with a graded / graded preflop chart / node decision per (owner, version, room, stake) | `analysis_graded_facets`, the node report's facets and hand count |

R5.2's `analysis_leak_days` and `analysis_leak_day_hands` are gone: once spot
keys are as varied as play, a day held about one sum row per decision (1.94M
rows for 1.98M decisions at 1M hands), no cheaper than the decisions; the
all-time totals and the windows' rows replace them (`analysis_top_leaks`
and `analysis_leak_sample` read those).

**Which path a reader takes** (`analysis_filter_of` reads the filters
exactly as `analysis_scope` did; `analysis_filter_sums_ok` /
`_rows_ok` route): the overview's own filters (format, seat, pot type) are
answered from the sums (the leak report under a room or stake from the
stake totals); a date range, a room or a stake otherwise from the leak rows
or hand rows in scope (bounded by the scope, not the account) - a leak
report over a range holding most of the history (Learn's "before you passed
the lesson") as the totals less the rows outside it; a filter the
web never sends to a report (status, grade, minimum grade, flagged, street,
flag) from the reader's previous body, kept as `<reader>_scan`
(`analysis_overview_scan`, `_breakdown_scan`, `_node_actions_scan`,
`_node_hands_scan`, `_leaks_scan`, `_leak_hands_scan`, `_trend_scan`,
`hands_needing_analysis_recent_scan`) - so every input keeps its previous
answer. `analysis_hands` answers every filter from the hand rows (its count
from the overview's hand counts when they hold the filter).
`hands_needing_analysis_recent` walks only the months whose library count
(`library_hand_counts`) exceeds the analysed count at the version (the
previous walk when the library counts are stale).

**Kept** by four statement triggers in the writer's transaction, under
R5.2's per-account lock: `hand_analysis` insert / delete (hand rows, month
and overview hand counts) and `decision_analysis` insert / delete (leak rows
and every other sum; delete - a prune, a hand or an account deleted -
subtracts with the leak rows' own groups, the hand may be gone). "A hand
counted once in a group" is decided against the statement's hands' leak rows
before it. A trend day whose first or last time goes is looked up again
among the rows it keeps. Two invariants of the only writer
(`save_hand_analysis`) are relied on, as R5.2 did: an analysis row's owner is
its hand's owner, and a hand's time, room, stake and seat do not change.
`analysis_leak_summaries_rebuild(owner)` (definer, granted to nobody)
recounts all of it - the repair after a write that bypassed the triggers,
and the migration's backfill. RLS select-own on every table, no client
write grant.

**Cost** (`20270825090000` at a generated 1M-hand account, details in
docs/RAIL-PLAN.md §15): every listed reader under ~0.4 s on its default
call (overview 0.19 s, node report 0.28 s, leaks 0.37 s, hand list 3 ms)
except the trend by **session** (2.1 s; 6 s by street): a session needs
every hand of the scope in time order, so it reads the hand rows whole (the
Progress view's default, weeks, takes 4 ms). A writer pays ~150-200 ms more
per 200 analysed hands (`save_hand_analysis` 160-234 ms against 17-25 ms
without the summary triggers); the summaries take ≈ 860 MB per million
decisions (leak rows 530 MB, hand rows ~260 MB, the sums ~65 MB).

pgTAP `analysis_screen_summaries` (24): the tables' RLS and grants, the
definer triggers and rebuild, the invoker readers; every reader equal to
its previous body (the `_scan` copies, and verbatim `20270818090000` bodies
for those with no scan) on 1 400+ calls - 28 filter sets (each alone,
combined, empty strings, case and spaces, ranges on and off UTC midnight,
the scan filters), every group, sort, bucket and gap - for two accounts
after the first writes (in batches), after a re-analysis at a new version,
after a prune, after a hand and a decision deleted and decisions added to a
stored hand; the triggers' sums equal to a rebuild after each of those; a
deleted account leaving nothing. `owner_first_analysis` holds the summed
readers to their bodies before `20270818090000` too.

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
| `hands_owner_played_asc_idx` (`(owner_id, played_at asc nulls last, id)`) | "Oldest first" (`library_page`, `search_hands`): a backward scan of the descending index gives nulls first. `20270804090000`; the global `hands_played_at_idx` it and `hands_owner_played_idx` replace was dropped — see [Owner first](#owner-first-a-readers-work-is-the-callers-rows). |
| `hands_owner_pot_idx`, `hands_owner_profit_desc_idx`, `hands_owner_profit_asc_idx` | The "biggest pot", "best result" and "worst result" orders, and `minPot`, per owner (`20270804090000`; replaced the global `hands_total_pot_idx` and `hands_hero_profit_idx`). |
| `hands_owner_library_idx` (`(owner_id)` including the library's group columns) | `library_facets`' counts read the owner's hands index-only instead of every column (`20270804090000`). |
| `hand_stats_owner_hero_cover_idx` (`(owner_id, stats_version, hand_id) include (seat, net_bb_milli, pot_type, starting_stack_bb_tenths) where is_hero`) | The hero's row by hand within the owner's range: the library's counts (index only) and pages, `hands_needing_stats` (`20270804090000`). |
| `hands_owner_created_idx` (`(owner_id, created_at, id)`) | The desktop pull's keyset, `hands_since` (R1.9): one range scan per page, the row comparison `(created_at, id) > cursor` included. |
| `hands_site_played_idx`, `hands_hero_played_idx`, `hands_class_played_idx`, `hands_stakes_played_idx`, `hands_format_played_idx`, `hands_tournament_idx` | Composite `(filter column, played_at desc)`. Every one of these is "filter by a low-cardinality column, then sort by time". A single-column index would force a sort of the whole matching set; the composite serves filter and order in one scan. The hero / class / stakes / tournament ones are partial (`WHERE … IS NOT NULL`) because the null side is never filtered on. |
| `hands_showdown_idx` | `showdownOnly`. Partial on the selective side, so it is far smaller than indexing a skewed boolean. |
| `hands_owner_table_idx` (`(owner_id, table_name) where table_name is not null`) | The library's table-name search: the caller's distinct table names by a skip scan, then the hands by name (`20270818090000`). Replaced `hands_table_trgm`, a global trigram index no reader could use under RLS ([rule 6](#owner-first-a-readers-work-is-the-callers-rows)). |
| `library_hand_counts_key`, `library_hero_counts_key` (unique, owner first) | `library_facets` and `library_count` read an owner's (version's) counts by range. |
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
| `shares_slug_uidx` | `read_share` / `record_share_view`. The only way into the table. |
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

### Regenerate the client types

`frontend/src/lib/db/database.types.ts` is generated from the migrations and
every Supabase client is `SupabaseClient<Database>`, so a renamed table, column
or function is a type error. After adding a migration, apply it locally and run:

```bash
supabase gen types typescript --local --schema public > frontend/src/lib/db/database.types.ts
```

CI ("Migrations and pgTAP") regenerates it from a fresh database with the same
CLI version and fails on any difference.

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
curl -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/unparsed_summary" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

and confirm the negative cases still fail: `DELETE /rest/v1/hands`,
`PATCH /rest/v1/hands`, `GET /rest/v1/shares` must all return `42501`.

Migrations apply in filename order. `20260916210000` depends on the baseline
having run first, and `20260922130000` depends on both.

### `20260922130000` opens with a delete, gated on the first run

It starts with `delete from public.shares; delete from public.hands;`. That was
correct exactly once: the 914 hands stored before accounts existed had no owner
and no way to acquire one, so they could not be made reachable under the new
policies, and clearing them is what let `owner_id` be `not null` rather than a
nullable column every query has to remember.

The two statements now sit inside a `do $gate$` block that runs them only when
`public.hands` has no `owner_id` column — i.e. only when ownership has not been
introduced yet, which is the exact condition that made them correct. On an
already-migrated database the block is a no-op, and everything after it is
idempotent anyway (`add column if not exists`, `create or replace`,
`create index if not exists`), so the whole file is safe to re-apply.

The check has to come *before* the `alter table public.hands add column
owner_id`, because that `add column` is what makes the condition false. Do not
reorder them, and do not "simplify" the gate into an unconditional delete.

### The baseline is re-runnable

`20260916190000_phf_baseline.sql` drops the objects it creates before creating
them, so it can be applied repeatedly while iterating. That is safe here only
because the owner authorised a full reset and every stored hand can be
re-derived by re-uploading the source files. **Do not copy that pattern into a
later migration** — a normal migration must be additive, and
`20260916210000_position_search_and_anonymization.sql` is the worked example of
one: it adds columns, backfills them from `phf`, and drops nothing.

### A baseline re-run silently reverts `20260916210000`

This is the one that bites, because nothing errors. `20260916190000_phf_baseline.sql`
opens with `drop table if exists public.hands cascade` and then recreates the
table and `hands_normalize()` from scratch. The `cascade` takes the dependent
objects with it, and the fresh definitions do not know about anything a later
migration added. So after any baseline re-run, the database is missing
everything `20260916210000_position_search_and_anonymization.sql` contributed:

- the `site_anonymization` column and its enum default,
- `player_positions`, `showdown_positions`, `winner_positions` and their
  backfill from `phf`,
- the CHECK constraint that keeps positional-anonymity hands from storing
  pseudonyms in `player_names` / `winners`,
- the position indexes, and the `hands_normalize()` body that normalizes
  positions at all.

Nothing raises. Inserts keep succeeding, position filters just quietly return
nothing, and `search_hands` answers wrongly rather than failing — which is the
failure mode `20260916210000` was written to prevent in the first place.

**So: after re-running the baseline, re-apply every later migration in filename
order** — `20260916210000`, then `20260922130000`. Both are safe to re-apply
(`20260922130000` is gated, see above), so the correct move is always to replay
the whole chain rather than to guess which parts survived.

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

The weekly pass over this - the two queries, the `new-format` issue label,
and the formats we know of without a sample - is in
`docs/unsupported-formats.md`.

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

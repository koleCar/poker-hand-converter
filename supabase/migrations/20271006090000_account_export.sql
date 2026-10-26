-- ===========================================================================
-- Rail R6.5: the account's data inventory and its export (GDPR Art. 15 / 20)
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.5. A signed-in account downloads everything the
-- service holds about it: profile and plan, hands (their PHF as stored),
-- statistics and analysis, sources, charts, settings, notes, HUD layouts,
-- shares, what it wrote on the forum, its votes, reports and notifications,
-- its learning progress, the conversion failures it sent, and the original
-- files it chose to keep. The browser builds the ZIP (see "Why the browser"
-- below); this migration is what it reads.
--
-- ## The inventory: one row per place that holds an account's data
--
-- `account_data_inventory` names every table (and Storage bucket) that holds
-- rows of an account, which columns hold the account id, whether and where
-- the export carries it, and what account deletion does to it. It is data
-- the readers below are driven by - a section can only be exported if it is
-- in the inventory - and pgTAP `account_data` fails when a table with an
-- account column, or a private bucket, is missing from it. **A migration
-- that adds such a table adds its inventory row**, deciding both questions.
--
--   export: `file`      exported as its own file (`export_file`)
--           `profile`   folded into `profile.json`
--           `derived`   not exported: a summary or cache rebuilt from rows
--                       that are exported (`note` names them)
--           `internal`  not exported: operational state with no content of
--                       the account's own (a counter, a rate-limit window)
--           `on_request` not in the self-service export (moderation records
--                       naming other people), answered on request
--   on_delete: `cascade`  removed with the auth user (foreign key)
--              `erase`    removed by the deletion before the auth user
--              `anonymise` kept without the account (others' threads)
--              `retain`   kept, for the reason in `note`
--
-- ## The readers
--
-- Owner first (`docs/DATABASE.md`): PL/pgSQL, the caller read once into a
-- variable, `owner = v_owner` on every table, each call planned for that
-- owner (`plan_cache_mode = force_custom_plan`), keyset pages on an index
-- that starts with the owner. A cursor is the last row's key as JSON.
--
--   export_my_manifest()              the counts, the inventory, the format
--                                     version; charged 10 a day
--   export_my_profile()               profile.json (definer: `profiles` and
--                                     `auth.users` are sealed)
--   export_my_hands(after, n, derived) a page of hands (keyset on
--                                     `(created_at, id)`, `hands_owner_
--                                     created_idx`) and, with `derived`, the
--                                     same hands' statistics, EV and analysis
--                                     rows (by hand id, their primary keys)
--   export_my_rows(section, after, n) a page of a table RLS already lets the
--                                     owner read (invoker)
--   export_my_sealed(section, after, n) a page of a table clients cannot
--                                     select, or not all of their own rows
--                                     (definer: shares, the forum's rows
--                                     including removed and deleted ones,
--                                     votes, reports, HUD layouts whose
--                                     select policy needs `desktop_sync`)
--
-- Every page is charged to `account_export_page:<uid>` (5 000 pages an
-- hour; a 1 000 000-hand account is ~1 000 hand pages). Nothing here is
-- gated by a plan: every account may export (pgTAP `entitlements`' free
-- list).
--
-- ## Why the browser builds the ZIP
--
-- A 1 000 000-hand account is ~3.6 GB of PHF and more again of derived rows.
-- An Edge Function has a wall-clock limit (150-400 s) and ~256 MB of
-- memory, and a stored copy on the server would be one more place holding
-- the data. The browser pages through the readers, deflates each file as it
-- goes (`CompressionStream`) and writes the ZIP straight to disk where the
-- browser can (File System Access), else to a Blob the browser spills to
-- disk. No copy is stored anywhere but the user's machine.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The inventory
-- ---------------------------------------------------------------------------

create table public.account_data_inventory (
  name           text primary key,
  kind           text not null check (kind in ('table', 'bucket', 'auth')),
  owner_columns  text[] not null,
  export         text not null check (export in ('file', 'profile', 'derived', 'internal', 'on_request')),
  export_file    text,
  export_reader  text check (export_reader in ('hands', 'rows', 'sealed', 'profile', 'storage')),
  export_section text unique,
  export_key     text[],
  export_omit    text[] not null default '{}',
  on_delete      text not null check (on_delete in ('cascade', 'erase', 'anonymise', 'retain')),
  note           text not null check (char_length(note) between 3 and 600),
  check ((export in ('file', 'profile')) = (export_reader is not null)),
  check ((export = 'file') = (export_file is not null)),
  check ((export_reader in ('rows', 'sealed', 'storage')) = (export_section is not null and export_key is not null)),
  check (export_reader is distinct from 'hands' or export_section is not null)
);

comment on table public.account_data_inventory is
  'R6.5: every place that holds an account''s rows - what the export carries and what deletion does. '
  'pgTAP account_data fails when a table with an account column or a private bucket is missing.';

alter table public.account_data_inventory enable row level security;
revoke all on public.account_data_inventory from anon, authenticated;

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  -- The account itself
  ('auth.users', 'auth', '{id}', 'profile', null, 'profile', null, null, '{}', 'erase',
   'Email, sign-up and last sign-in times. Deleted last, through the Auth admin API; GoTrue''s own tables '
   '(identities, sessions, refresh tokens, MFA factors, one-time tokens) cascade with it.'),
  ('public.profiles', 'table', '{id}', 'profile', null, 'profile', null, null, '{}', 'cascade',
   'Username, role, karma, digest choice, ban state, plan and subscription fields. Not exported: the '
   'unsubscribe token (a capability) and the shadowban flag (a moderation measure).'),
  ('public.username_reservations', 'table', '{reserved_for}', 'profile', null, 'profile', null, null, '{}', 'retain',
   'An old username stays reserved: for the account for a year after a rename, and for nobody for a year after '
   'the account is deleted (profiles_reserve_on_delete), so nobody can take over a known name.'),
  ('public.board_moderators', 'table', '{user_id,granted_by}', 'profile', null, 'profile', null, null, '{}', 'cascade',
   'Boards the account moderates. granted_by is set null on others'' rows.'),

  -- Hands and what is derived from them
  ('public.hands', 'table', '{owner_id}', 'file', 'hands/hands-NNNN.ndjson', 'hands', 'hands', null, '{}', 'erase',
   'Every stored hand: its PHF as stored, key, origin, times, and the standard / source text where the web kept '
   'it. The search columns are derived from the PHF and not repeated. Deleted in batches before the account.'),
  ('public.hand_stats', 'table', '{owner_id}', 'file', 'hand_stats/hand_stats-NNNN.ndjson', 'hands', 'hand_stats', null, '{}', 'cascade',
   'Per-seat statistics of each hand, every stored version. Derived from the PHF; exported because it is held.'),
  ('public.hand_stats_ev', 'table', '{owner_id}', 'file', 'hand_stats/hand_stats_ev-NNNN.ndjson', 'hands', 'hand_stats_ev', null, '{}', 'cascade',
   'All-in EV per seat. Derived from the PHF.'),
  ('public.hand_analysis', 'table', '{owner_id}', 'file', 'analysis/hand_analysis-NNNN.ndjson', 'hands', 'hand_analysis', null, '{}', 'cascade',
   'Each hand''s analysis, every stored version.'),
  ('public.decision_analysis', 'table', '{owner_id}', 'file', 'analysis/decision_analysis-NNNN.ndjson', 'hands', 'decision_analysis', null, '{}', 'cascade',
   'Each graded decision of each hand.'),
  ('public.hand_sources', 'table', '{owner_id}', 'file', 'hand_sources.ndjson', 'rows', 'hand_sources', '{id}', '{}', 'cascade',
   'The desktop app''s folders (device, label, counters) and the web''s upload source.'),
  ('public.hand_arrivals', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'One counter row: when hands last arrived and how many, for the live strip. No hand content.'),
  ('public.shares', 'table', '{owner_id}', 'file', 'shares.ndjson', 'sealed', 'shares', '{id}', '{}', 'cascade',
   'Share links the account made, with their payload and view counts. The links stop working.'),
  ('public.analysis_shares', 'table', '{owner_id}', 'file', 'analysis_shares.ndjson', 'rows', 'analysis_shares', '{hand_id}', '{}', 'cascade',
   'Which hands'' analyses the account shared.'),
  ('public.unparsed_hands', 'table', '{submitted_by}', 'file', 'conversion_failures.ndjson', 'rows', 'unparsed_hands', '{id}', '{}', 'erase',
   'Hand histories the converter could not read, sent signed in. Web samples are verbatim text and are deleted; '
   'desktop samples were anonymised on the computer with consent and stay, unlinked (submitted_by set null).'),

  -- Analysis summaries: rebuilt from the rows above
  ('public.analysis_graded_sites', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_hand_rows', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of hand_analysis.'),
  ('public.analysis_leak_rows', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_leak_stake_totals', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_leak_totals', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_month_hands', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of hand_analysis.'),
  ('public.analysis_node_totals', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_overview_decisions', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_overview_flags', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_overview_hands', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of hand_analysis.'),
  ('public.analysis_overview_keys', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.analysis_trend_days', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of decision_analysis.'),
  ('public.preflop_decision_rows', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Preflop decisions of decision_analysis, for the own-chart comparison.'),
  ('public.preflop_decision_totals', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of preflop_decision_rows.'),
  ('public.hero_report_rows', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'The hero''s rows of hand_stats, for the reports.'),
  ('public.hero_rollups', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Summary of hand_stats.'),
  ('public.player_stats', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Opponents'' statistics, summed from hand_stats.'),
  ('public.library_hand_counts', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Counts of hands.'),
  ('public.library_hero_counts', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'Counts of hands.'),
  ('public.library_counts_stale', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade', 'A flag: the counts above need a rebuild.'),

  -- The account's own settings and study
  ('public.player_notes', 'table', '{owner_id}', 'file', 'player_notes.ndjson', 'rows', 'player_notes', '{site,player}', '{}', 'cascade',
   'Notes on opponents.'),
  ('public.preflop_chart_sets', 'table', '{owner_id}', 'file', 'preflop_charts.ndjson', 'rows', 'preflop_chart_sets', '{id}', '{}', 'cascade',
   'Own preflop charts.'),
  ('public.tournament_settings', 'table', '{owner_id}', 'file', 'tournament_settings.ndjson', 'rows', 'tournament_settings', '{site,tournament_id}', '{}', 'cascade',
   'Payouts, field and players left the account entered per tournament.'),
  ('public.hud_layouts', 'table', '{owner_id}', 'file', 'hud_layouts.ndjson', 'sealed', 'hud_layouts', '{kind,key}', '{}', 'cascade',
   'The desktop HUD''s designs, assignments and positions (sealed here: the select policy needs desktop_sync).'),
  ('public.drill_items', 'table', '{owner_id}', 'file', 'learning/drill_items.ndjson', 'rows', 'drill_items', '{hand_id,action_index}', '{}', 'cascade',
   'Drill cards made from the account''s decisions.'),
  ('public.drill_reviews', 'table', '{owner_id}', 'file', 'learning/drill_reviews.ndjson', 'rows', 'drill_reviews', '{reviewed_at,id}', '{}', 'cascade',
   'Drill answers.'),
  ('public.trainer_results', 'table', '{owner_id}', 'file', 'learning/trainer_results.ndjson', 'rows', 'trainer_results', '{created_at,id}', '{}', 'cascade',
   'Trainer answers.'),
  ('public.study_plans', 'table', '{owner_id}', 'file', 'learning/study_plans.ndjson', 'rows', 'study_plans', '{week_start}', '{}', 'cascade',
   'Weekly study plans.'),
  ('public.study_tasks', 'table', '{owner_id}', 'file', 'learning/study_tasks.ndjson', 'rows', 'study_tasks', '{id}', '{}', 'cascade',
   'Study plan tasks.'),
  ('public.lesson_progress', 'table', '{owner_id}', 'file', 'learning/lesson_progress.ndjson', 'rows', 'lesson_progress', '{lesson_id}', '{}', 'cascade',
   'Course progress.'),
  ('public.lesson_cards', 'table', '{owner_id}', 'file', 'learning/lesson_cards.ndjson', 'rows', 'lesson_cards', '{item_key}', '{}', 'cascade',
   'Course review cards.'),

  -- The forum
  ('public.posts', 'table', '{author_id}', 'file', 'forum/posts.ndjson', 'sealed', 'posts', '{id}',
   '{search_tsv,hot_rank,controversy,body_fingerprint}', 'anonymise',
   'Posts, including removed and deleted ones. On deletion: a post others replied to stays with its title and '
   'body replaced and no author; any other post is deleted.'),
  ('public.comments', 'table', '{author_id}', 'file', 'forum/comments.ndjson', 'sealed', 'comments', '{id}',
   '{search_tsv,best_rank,body_fingerprint}', 'anonymise',
   'Comments, including removed ones. On deletion each becomes a tombstone (no words, no author), as a deleted '
   'comment does, so the replies under it stay in place.'),
  ('public.content_revisions', 'table', '{edited_by}', 'file', 'forum/revisions.ndjson', 'sealed', 'content_revisions', '{id}', '{}', 'erase',
   'Earlier versions of what the account edited. On deletion the revisions of the account''s own posts and '
   'comments are deleted; edited_by is set null on others''.'),
  ('public.published_hands', 'table', '{author_id}', 'file', 'forum/published_hands.ndjson', 'sealed', 'published_hands', '{id}', '{}', 'anonymise',
   'Published (scrubbed) copies of hands. On deletion: a hand under a kept thread stays, re-scrubbed with '
   'pseudonyms and without an author; every other one is deleted.'),
  ('public.published_hand_sources', 'table', '{author_id}', 'file', 'forum/published_hand_sources.ndjson', 'sealed', 'published_hand_sources', '{published_id}', '{}', 'cascade',
   'Which stored hand each publication came from.'),
  ('public.post_votes', 'table', '{user_id}', 'file', 'forum/post_votes.ndjson', 'sealed', 'post_votes', '{post_id}', '{}', 'erase',
   'Votes on posts. Deleted, and the posts'' counts and their authors'' karma recounted.'),
  ('public.comment_votes', 'table', '{user_id}', 'file', 'forum/comment_votes.ndjson', 'sealed', 'comment_votes', '{comment_id}', '{}', 'erase',
   'Votes on comments. Deleted, and the counts and karma recounted.'),
  ('public.poll_votes', 'table', '{user_id}', 'file', 'forum/poll_votes.ndjson', 'sealed', 'poll_votes', '{post_id}', '{}', 'cascade',
   'Answers to "what would you do?" polls.'),
  ('public.saved_posts', 'table', '{user_id}', 'file', 'forum/saved_posts.ndjson', 'rows', 'saved_posts', '{post_id}', '{}', 'cascade',
   'Saved posts.'),
  ('public.thread_subscriptions', 'table', '{user_id}', 'file', 'forum/thread_subscriptions.ndjson', 'rows', 'thread_subscriptions', '{post_id}', '{}', 'cascade',
   'Watched and muted threads.'),
  ('public.notifications', 'table', '{user_id,actor_id}', 'file', 'forum/notifications.ndjson', 'rows', 'notifications', '{id}', '{}', 'erase',
   'Notifications the account received (cascade), and those its comments caused others (deleted).'),
  ('public.reports', 'table', '{reporter_id,resolved_by,subject_id}', 'file', 'forum/reports.ndjson', 'sealed', 'reports', '{subject_type,subject_id}', '{}', 'anonymise',
   'Reports the account filed. On deletion they stay for the moderators without the reporter and without the '
   'free-text details.'),
  ('public.moderation_actions', 'table', '{actor_id,target_id,subject_id}', 'on_request', null, null, null, null, '{}', 'retain',
   'The append-only moderation log. On deletion the words of the account''s own posts, comments and hands are '
   'removed from it (R6.5) and actor_id is set null; the record of what was done stays, for the forum''s safety '
   'and legal claims.'),

  -- Operational state
  ('public.ingest_rate_limit', 'table', '{}', 'internal', null, null, null, null, '{}', 'erase',
   'Rate-limit windows, some named after the account (''comment:<id>''). Swept after two days; the deletion '
   'removes the account''s at once.'),

  -- Storage
  ('storage.hand-uploads', 'bucket', '{name}', 'file', 'originals/<path>', 'storage', 'hand_uploads', '{name}', '{}', 'erase',
   'Original files the account chose to keep on a web upload (gzip, under <id>/). Deleted through the Storage '
   'API before the account; the database cascade does not remove stored files.');

-- R6.3's webhook log (`20270915090000_billing_stripe.sql`, built in parallel):
-- listed when it exists, so the inventory stays complete whichever of the two
-- lands first (a fresh reset applies R6.3's migration before this one).
insert into public.account_data_inventory (name, kind, owner_columns, export, on_delete, note)
select 'public.billing_events', 'table', '{owner_id}', 'internal', 'anonymise',
       'Stripe webhook events handled for the account (event id, type, time, outcome; no payload, no amount) - '
       'the idempotency log. owner_id is set null when the profile is deleted; rows are pruned after 90 days.'
where to_regclass('public.billing_events') is not null;

-- ---------------------------------------------------------------------------
-- 2. Indexes the readers (and the deletion's cascades) start from
-- ---------------------------------------------------------------------------
--
-- The forum's author indexes are partial (visible, not deleted); the export
-- reads every row of the author's, and the deletion finds them all.

create index if not exists posts_author_all_idx on public.posts (author_id, id) where author_id is not null;
create index if not exists comments_author_all_idx on public.comments (author_id, id) where author_id is not null;
create index if not exists published_hands_author_all_idx on public.published_hands (author_id, id) where author_id is not null;
create index if not exists content_revisions_edited_by_idx on public.content_revisions (edited_by, id) where edited_by is not null;
create index if not exists poll_votes_user_idx on public.poll_votes (user_id, post_id);
create index if not exists published_hand_sources_author_idx on public.published_hand_sources (author_id, published_id);
-- `analysis_shares_owner_idx` covers shared rows only; the export reads them all.
create index if not exists analysis_shares_owner_all_idx on public.analysis_shares (owner_id, hand_id);

-- ---------------------------------------------------------------------------
-- 3. Budgets
-- ---------------------------------------------------------------------------

-- One page of any reader. Executable by the caller (the invoker readers run
-- as the caller and cannot reach `enforce_rate_limit`); it only ever charges
-- the caller's own bucket.
create or replace function public.account_export_charge()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  perform public.enforce_rate_limit('account_export_page:' || v_uid::text, 1, 5000, interval '1 hour');
end;
$$;

revoke all on function public.account_export_charge() from public;
revoke execute on function public.account_export_charge() from anon;
grant execute on function public.account_export_charge() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A page of a table, generic over the inventory
-- ---------------------------------------------------------------------------
--
-- The table, its owner column, key and omitted columns come from the
-- inventory (sealed, written only by migrations; read through a definer
-- helper); the owner is always the caller, `auth.uid()`, bound into the
-- query; the cursor's values are cast to the key columns' own types.
--
-- `account_export_page` is invoker: called by `export_my_rows` it runs as
-- the caller (RLS applies as well as the owner predicate); called by the
-- definer `export_my_sealed` it runs as that function's owner. A client
-- calling it directly gets no more than `export_my_rows` gives: a sealed
-- section is refused by the missing grant.

create or replace function public.account_export_entry(p_section text, p_reader text)
returns public.account_data_inventory
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.account_data_inventory;
begin
  select * into v from public.account_data_inventory
  where export_section = p_section and export_reader = p_reader;
  if not found then
    raise exception 'There is no export section "%".', left(coalesce(p_section, ''), 64) using errcode = '22023';
  end if;
  return v;
end;
$$;

revoke all on function public.account_export_entry(text, text) from public;
revoke execute on function public.account_export_entry(text, text) from anon;
grant execute on function public.account_export_entry(text, text) to authenticated;

create or replace function public.account_export_page(p_section text, p_reader text, p_after jsonb, p_limit integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_limit   integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_entry   public.account_data_inventory;
  v_table   text;
  v_keys    text;
  v_lastkey text;
  v_desc    text;
  v_cursor  text;
  v_result  jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  v_entry := public.account_export_entry(p_section, p_reader);
  perform public.account_export_charge();

  v_table := split_part(v_entry.name, '.', 2);
  select string_agg(format('t.%I', k), ', ' order by o),
         string_agg(format('%L, t.%I', k, k), ', ' order by o),
         string_agg(format('t.%I desc', k), ', ' order by o)
    into v_keys, v_lastkey, v_desc
  from unnest(v_entry.export_key) with ordinality u(k, o);

  if p_after is not null then
    if jsonb_typeof(p_after) <> 'object'
       or exists (select 1 from unnest(v_entry.export_key) k where p_after ->> k is null) then
      raise exception 'The export cursor is not valid.' using errcode = '22023';
    end if;
    select string_agg(format('%L::%s', p_after ->> k, format_type(a.atttypid, a.atttypmod)), ', ' order by o)
      into v_cursor
    from unnest(v_entry.export_key) with ordinality u(k, o)
    join pg_catalog.pg_attribute a on a.attrelid = format('public.%I', v_table)::regclass and a.attname = k;
  end if;

  execute format(
    $q$
    with page as (
      select t.* from public.%1$I t
      where t.%2$I = $1 %3$s
      order by %4$s
      limit $2
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(to_jsonb(t) - $3 order by %4$s) from page t), '[]'::jsonb),
      'next', case when (select count(*) from page) = $2
                   then (select jsonb_build_object(%5$s) from page t order by %6$s limit 1) end)
    $q$,
    v_table, v_entry.owner_columns[1],
    case when v_cursor is null then '' else format('and (%s) > (%s)', v_keys, v_cursor) end,
    v_keys, v_lastkey, v_desc)
  into v_result
  using v_owner, v_limit, v_entry.export_omit;
  return v_result;
end;
$$;

revoke all on function public.account_export_page(text, text, jsonb, integer) from public;
revoke execute on function public.account_export_page(text, text, jsonb, integer) from anon;
grant execute on function public.account_export_page(text, text, jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The readers
-- ---------------------------------------------------------------------------

-- Tables the owner already reads under RLS: invoker, so RLS applies too.
create or replace function public.export_my_rows(p_section text, p_after jsonb default null, p_limit integer default 2000)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_rows  jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;

  -- The original files kept on an upload: their names and sizes (each file
  -- is downloaded through Storage, under the same owner-folder policy).
  if p_section = 'hand_uploads' then
    perform public.account_export_charge();
    with page as (
      select o.name collate "C" as name, o.created_at, (o.metadata ->> 'size')::bigint as size
      from storage.objects o
      where o.bucket_id = 'hand-uploads'
        and o.name collate "C" >= v_owner::text || '/' and o.name collate "C" < v_owner::text || '0'
        and (p_after is null or o.name collate "C" > (p_after ->> 'name'))
      order by o.name collate "C"
      limit v_limit
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'createdAt', created_at, 'size', size) order by name) from page), '[]'::jsonb),
      'next', case when (select count(*) from page) = v_limit
                   then (select jsonb_build_object('name', max(name)) from page) end)
    into v_rows;
    return v_rows;
  end if;

  return public.account_export_page(p_section, 'rows', p_after, v_limit);
end;
$$;

revoke all on function public.export_my_rows(text, jsonb, integer) from public;
revoke execute on function public.export_my_rows(text, jsonb, integer) from anon;
grant execute on function public.export_my_rows(text, jsonb, integer) to authenticated;

-- Sealed tables: definer, the owner bound explicitly (in account_export_page). Each section is a
-- table whose rows the account wrote, read in full (a removed post too).
create or replace function public.export_my_sealed(p_section text, p_after jsonb default null, p_limit integer default 2000)
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  return public.account_export_page(p_section, 'sealed', p_after, v_limit);
end;
$$;

revoke all on function public.export_my_sealed(text, jsonb, integer) from public;
revoke execute on function public.export_my_sealed(text, jsonb, integer) from anon;
grant execute on function public.export_my_sealed(text, jsonb, integer) to authenticated;

-- A page of hands, and with p_derived the same hands' statistics and
-- analysis rows. Keyset on (created_at, id): `hands_owner_created_idx`;
-- the derived rows by hand id: their primary keys start with it.
create or replace function public.export_my_hands(p_after jsonb default null, p_limit integer default 1000, p_derived boolean default true)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  -- 2 000 hands a page; 1 000 with their derived rows (~25 MB of JSON, ~2 s:
  -- a 2 000-hand page with them is ~55 MB and nears the 8 s statement timeout).
  v_limit   integer := least(greatest(coalesce(p_limit, 1000), 1), case when p_derived then 1000 else 2000 end);
  v_created timestamptz;
  v_id      uuid;
  v_ids     uuid[];
  v_hands   jsonb;
  v_last    jsonb;
  v_n       integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  perform public.account_export_charge();
  if p_after is not null then
    begin
      v_created := (p_after ->> 'created_at')::timestamptz;
      v_id := (p_after ->> 'id')::uuid;
    exception when others then
      raise exception 'The export cursor is not valid.' using errcode = '22023';
    end;
    if v_created is null or v_id is null then
      raise exception 'The export cursor is not valid.' using errcode = '22023';
    end if;
  end if;

  with page as (
    select h.id, h.hand_key, h.origin, h.created_at, h.schema_version, h.parser_version, h.source_filename,
           h.standard_text, h.source_text, h.phf
    from public.hands h
    where h.owner_id = v_owner
      and (v_created is null or (h.created_at, h.id) > (v_created, v_id))
    order by h.created_at, h.id
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'handKey', p.hand_key, 'origin', p.origin, 'createdAt', p.created_at,
           'schemaVersion', p.schema_version, 'parserVersion', p.parser_version,
           'sourceFilename', p.source_filename, 'standardText', p.standard_text, 'sourceText', p.source_text,
           'phf', p.phf) order by p.created_at, p.id), '[]'::jsonb),
         array_agg(p.id order by p.created_at, p.id),
         count(*)::integer,
         (array_agg(jsonb_build_object('created_at', p.created_at, 'id', p.id) order by p.created_at desc, p.id desc))[1]
    into v_hands, v_ids, v_n, v_last
  from page p;

  if not p_derived or v_n = 0 then
    return jsonb_build_object('hands', v_hands, 'next', case when v_n = v_limit then v_last end);
  end if;

  return jsonb_build_object(
    'hands', v_hands,
    'hand_stats', coalesce((select jsonb_agg(to_jsonb(s) order by s.hand_id, s.stats_version, s.seat)
                              from public.hand_stats s where s.hand_id = any (v_ids) and s.owner_id = v_owner), '[]'::jsonb),
    'hand_stats_ev', coalesce((select jsonb_agg(to_jsonb(e) order by e.hand_id, e.ev_version, e.seat)
                                 from public.hand_stats_ev e where e.hand_id = any (v_ids) and e.owner_id = v_owner), '[]'::jsonb),
    'hand_analysis', coalesce((select jsonb_agg(to_jsonb(a) order by a.hand_id, a.analysis_version)
                                 from public.hand_analysis a where a.hand_id = any (v_ids) and a.owner_id = v_owner), '[]'::jsonb),
    'decision_analysis', coalesce((select jsonb_agg(to_jsonb(d) order by d.hand_id, d.analysis_version, d.ord)
                                     from public.decision_analysis d where d.hand_id = any (v_ids) and d.owner_id = v_owner), '[]'::jsonb),
    'next', case when v_n = v_limit then v_last end);
end;
$$;

revoke all on function public.export_my_hands(jsonb, integer, boolean) from public;
revoke execute on function public.export_my_hands(jsonb, integer, boolean) from anon;
grant execute on function public.export_my_hands(jsonb, integer, boolean) to authenticated;

-- profile.json: the sealed profile, the auth account, roles, reservations,
-- the plan. Named keys: the unsubscribe token and the shadowban flag stay out.
create or replace function public.export_my_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_p     public.profiles%rowtype;
  v_u     record;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  perform public.enforce_rate_limit('account_export_page:' || v_owner::text, 1, 5000, interval '1 hour');

  select u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at into v_u
  from auth.users u where u.id = v_owner;
  select * into v_p from public.profiles where id = v_owner;

  return jsonb_build_object(
    'account', jsonb_build_object(
      'id', v_owner,
      'email', v_u.email,
      'createdAt', v_u.created_at,
      'lastSignInAt', v_u.last_sign_in_at,
      'emailConfirmedAt', v_u.email_confirmed_at),
    'profile', case when v_p.id is null then null else jsonb_build_object(
      'username', v_p.username,
      'usernameChangedAt', v_p.username_changed_at,
      'role', v_p.role,
      'karma', v_p.karma,
      'digest', v_p.digest,
      'bannedUntil', v_p.banned_until,
      'banReason', v_p.ban_reason,
      'createdAt', v_p.created_at) end,
    'plan', case when v_p.id is null then null else jsonb_build_object(
      'plan', v_p.plan,
      'period', v_p.plan_period,
      'status', v_p.plan_status,
      'currentPeriodEnd', v_p.current_period_end,
      'updatedAt', v_p.plan_updated_at,
      'earlyUser', v_p.early_user,
      'earlyUserSince', v_p.early_user_since,
      'paymentProviderCustomerId', v_p.billing_customer_id,
      'paymentProviderSubscriptionId', v_p.billing_subscription_id) end,
    'boardsModerated', coalesce((select jsonb_agg(jsonb_build_object('board', b.slug, 'since', m.granted_at) order by b.slug)
                                   from public.board_moderators m join public.boards b on b.id = m.board_id
                                  where m.user_id = v_owner), '[]'::jsonb),
    'reservedUsernames', coalesce((select jsonb_agg(jsonb_build_object('username', r.username_lower, 'reason', r.reason,
                                                                        'expiresAt', r.expires_at) order by r.username_lower)
                                     from public.username_reservations r where r.reserved_for = v_owner), '[]'::jsonb));
end;
$$;

revoke all on function public.export_my_profile() from public;
revoke execute on function public.export_my_profile() from anon;
grant execute on function public.export_my_profile() to authenticated;

-- What an export will hold: a row count per exported section (the derived
-- rows ride with the hands, so they are not counted here: counting 6M
-- statistics rows would cost more than the page), the inventory for the
-- README, the format version. Charged 10 exports a day.
create or replace function public.export_my_manifest()
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner  uuid := auth.uid();
  v_counts jsonb := '{}'::jsonb;
  v_n      bigint;
  r        public.account_data_inventory;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  perform public.enforce_rate_limit('account_export:' || v_owner::text, 1, 10, interval '1 day');

  for r in select * from public.account_data_inventory
           where export_reader in ('rows', 'sealed') order by name loop
    execute format('select count(*) from public.%I where %I = $1', split_part(r.name, '.', 2), r.owner_columns[1])
      into v_n using v_owner;
    v_counts := v_counts || jsonb_build_object(r.export_section, v_n);
  end loop;
  v_counts := v_counts
    || jsonb_build_object('hands', (select count(*) from public.hands where owner_id = v_owner))
    || jsonb_build_object('hand_uploads', (select count(*) from storage.objects o
                                            where o.bucket_id = 'hand-uploads'
                                              and o.name collate "C" >= v_owner::text || '/'
                                              and o.name collate "C" < v_owner::text || '0'));

  return jsonb_build_object(
    'format', 'rail-account-export/1',
    'generatedAt', now(),
    'accountId', v_owner,
    'counts', v_counts,
    'uploadBytes', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o
                     where o.bucket_id = 'hand-uploads'
                       and o.name collate "C" >= v_owner::text || '/'
                       and o.name collate "C" < v_owner::text || '0'),
    'inventory', (select jsonb_agg(jsonb_build_object(
                    'name', i.name, 'export', i.export, 'file', i.export_file, 'reader', i.export_reader,
                    'section', i.export_section, 'onDelete', i.on_delete, 'note', i.note) order by i.name)
                  from public.account_data_inventory i));
end;
$$;

revoke all on function public.export_my_manifest() from public;
revoke execute on function public.export_my_manifest() from anon;
grant execute on function public.export_my_manifest() to authenticated;

commit;

-- ===========================================================================
-- Rail R6.5: account deletion (GDPR Art. 17)
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.5. The deletion is run by the Edge Function
-- `account-delete` (service role), invoked with the user's own JWT, in
-- steps that can each be repeated and resume where a failed or timed-out
-- call stopped:
--
--   0. `begin_account_deletion(confirm)` - **as the user**: the typed
--      username must match, the session must have signed in within the last
--      15 minutes (the JWT's `amr`), 5 starts an hour. Records the request
--      in `account_deletions` (or returns the one in progress: a resumed
--      deletion needs neither again).
--   1. billing  - the subscription canceled at the payment provider (the
--      function's hook for R6.3; nothing to do while nobody can pay).
--   2. storage  - every object under `<id>/` in the buckets the inventory
--      lists (`hand-uploads`), deleted through the Storage API: the
--      database cascade does not remove stored files.
--   3. content  - `erase_account_content(id)`: the public content and the
--      traces in other people's rows (below), in one transaction.
--   4. hands    - `erase_account_hands(id, n)`: the hands in batches (their
--      statistics, analysis, shares and drills cascade), so a 1 000 000-hand
--      library is not one statement the auth API would time out on.
--   5. the auth user deleted (Auth admin API): every remaining owner row
--      cascades (`account_data_inventory`, on_delete = cascade).
--
-- No grace period: the user confirms with the username and a fresh sign-in,
-- is offered the export first, and the deletion starts at once ("without
-- undue delay", Art. 17(1)). Backups are the hosting provider's (see the
-- privacy policy).
--
-- ## Public content (`erase_account_content`)
--
-- Personal data goes; other people's contributions stay where they were.
--
--   * posts - a post another account replied to (a visible comment by
--     someone else) stays so the thread does: title "[deleted]", empty body,
--     no author, its revisions deleted. Every other post is deleted (its own
--     comments, votes, saves, polls and notifications cascade).
--   * comments - each becomes the tombstone a deleted comment already is
--     (no body, no author), so replies stay attached; revisions deleted.
--   * published hands - one under a kept thread stays, without author or
--     title, re-scrubbed with pseudonyms if it was published "as imported";
--     every other one is deleted.
--   * votes - deleted, and the posts' and comments' counts and their
--     authors' karma recounted at once (not left to the nightly recount).
--   * notifications the account's comments caused others - deleted.
--   * reports it filed - kept for the moderators, without reporter or
--     free-text details.
--   * the moderation log - the words of its own content (a removed post's
--     body, kept in `details`) replaced by `{"erased": "account-deleted"}`;
--     the record of the action stays (the append-only trigger allows exactly
--     this, inside this function).
--   * conversion failures it sent from the web (verbatim text) - deleted;
--     desktop samples (anonymised on the computer, with consent) stay,
--     unlinked by the cascade.
--   * rate-limit windows named after it, and Auth's audit-log lines that
--     name it as the actor (where the database role may delete them).
--
-- What stays, and why, is the inventory's `retain` rows: the username
-- reserved for nobody for a year, the moderation log's records, and this
-- table's row (the id and the step times, no content) for 30 days after
-- completion as the record that the request was carried out.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The request and its steps
-- ---------------------------------------------------------------------------

create table public.account_deletions (
  user_id         uuid primary key,
  requested_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  billing_done_at timestamptz,
  storage_done_at timestamptz,
  content_done_at timestamptz,
  hands_done_at   timestamptz,
  completed_at    timestamptz,
  attempts        integer not null default 1 check (attempts >= 1),
  last_error      text check (last_error is null or char_length(last_error) <= 500)
);

comment on table public.account_deletions is
  'R6.5: one row per account deletion - the account id (no foreign key: it outlives the account) and when each '
  'step finished. No content. Purged 30 days after completion (purge_account_deletions).';

alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from anon, authenticated;

insert into public.account_data_inventory (name, kind, owner_columns, export, on_delete, note) values
  ('public.account_deletions', 'table', '{user_id}', 'internal', 'retain',
   'The deletion''s own progress: the account id and the time of each step, no content. Kept 30 days after '
   'completion as the record that the request was carried out, then purged.');

create or replace function public.account_deletion_json(p public.account_deletions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p.user_id is null then null else jsonb_build_object(
    'requestedAt', p.requested_at,
    'updatedAt', p.updated_at,
    'steps', jsonb_build_object(
      'billing', p.billing_done_at,
      'storage', p.storage_done_at,
      'content', p.content_done_at,
      'hands', p.hands_done_at),
    'completedAt', p.completed_at,
    'attempts', p.attempts,
    'lastError', p.last_error) end;
$$;

revoke all on function public.account_deletion_json(public.account_deletions) from public;
revoke execute on function public.account_deletion_json(public.account_deletions) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. As the user: start (or resume), and read the state
-- ---------------------------------------------------------------------------

-- How recently this session signed in, from the JWT's `amr` (GoTrue writes
-- one entry per method with its time; a refreshed token keeps them).
create or replace function public.session_authenticated_at()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select to_timestamp(max((e ->> 'timestamp')::double precision))
  from jsonb_array_elements(
         case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) e
  where jsonb_typeof(e -> 'timestamp') = 'number';
$$;

revoke all on function public.session_authenticated_at() from public;
revoke execute on function public.session_authenticated_at() from anon, authenticated;

create or replace function public.begin_account_deletion(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_row     public.account_deletions;
  v_name    text;
  v_signed  timestamptz;
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete your account.' using errcode = '42501';
  end if;

  -- A deletion in progress is resumed: it was confirmed when it started.
  update public.account_deletions
     set attempts = attempts + 1, updated_at = now()
   where user_id = v_uid and completed_at is null
  returning * into v_row;
  if found then
    return public.account_deletion_json(v_row);
  end if;

  perform public.enforce_rate_limit('account_delete:' || v_uid::text, 1, 5, interval '1 hour');

  v_signed := public.session_authenticated_at();
  if v_signed is null or v_signed < now() - interval '15 minutes' then
    raise exception 'Sign in again to delete your account: the last sign-in must be within 15 minutes.'
      using errcode = '28000', hint = 'reauth_required';
  end if;

  select coalesce(p.username_lower, lower(u.email)) into v_name
  from auth.users u left join public.profiles p on p.id = u.id
  where u.id = v_uid;
  if v_name is null or lower(btrim(coalesce(p_confirm, ''))) <> v_name then
    raise exception 'Type your username exactly to confirm the deletion.'
      using errcode = '22023', hint = 'confirmation_mismatch';
  end if;

  insert into public.account_deletions (user_id) values (v_uid)
  on conflict (user_id) do update
    set requested_at = now(), updated_at = now(), attempts = 1, last_error = null,
        billing_done_at = null, storage_done_at = null, content_done_at = null, hands_done_at = null,
        completed_at = null
  returning * into v_row;
  return public.account_deletion_json(v_row);
end;
$$;

revoke all on function public.begin_account_deletion(text) from public;
revoke execute on function public.begin_account_deletion(text) from anon;
grant execute on function public.begin_account_deletion(text) to authenticated;

create or replace function public.my_account_deletion()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.account_deletions;
begin
  if auth.uid() is null then
    return null;
  end if;
  select * into v_row from public.account_deletions where user_id = auth.uid() and completed_at is null;
  return public.account_deletion_json(v_row);
end;
$$;

revoke all on function public.my_account_deletion() from public;
revoke execute on function public.my_account_deletion() from anon;
grant execute on function public.my_account_deletion() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Service role: the function's view of a request, and its step marks
-- ---------------------------------------------------------------------------

create or replace function public.account_deletion_state(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.account_deletions;
  v_p   record;
begin
  select * into v_row from public.account_deletions where user_id = p_user;
  if not found then
    return null;
  end if;
  select pr.billing_customer_id, pr.billing_subscription_id, pr.plan_status into v_p
  from public.profiles pr where pr.id = p_user;
  return public.account_deletion_json(v_row) || jsonb_build_object(
    'billing', jsonb_build_object(
      'customerId', v_p.billing_customer_id,
      'subscriptionId', v_p.billing_subscription_id,
      'status', v_p.plan_status));
end;
$$;

revoke all on function public.account_deletion_state(uuid) from public;
revoke execute on function public.account_deletion_state(uuid) from anon, authenticated;
grant execute on function public.account_deletion_state(uuid) to service_role;

-- A step done (its time kept if it was done before), or a failure noted.
create or replace function public.account_deletion_mark(p_user uuid, p_step text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.account_deletions;
begin
  if p_step not in ('billing', 'storage', 'content', 'hands', 'completed') then
    raise exception 'Unknown deletion step "%".', left(coalesce(p_step, ''), 32) using errcode = '22023';
  end if;
  if p_error is not null then
    update public.account_deletions
       set last_error = left(p_step || ': ' || p_error, 500), updated_at = now()
     where user_id = p_user
    returning * into v_row;
  else
    update public.account_deletions
       set billing_done_at = case when p_step = 'billing' then coalesce(billing_done_at, now()) else billing_done_at end,
           storage_done_at = case when p_step = 'storage' then coalesce(storage_done_at, now()) else storage_done_at end,
           content_done_at = case when p_step = 'content' then coalesce(content_done_at, now()) else content_done_at end,
           hands_done_at   = case when p_step = 'hands'   then coalesce(hands_done_at, now())   else hands_done_at end,
           completed_at    = case when p_step = 'completed' then coalesce(completed_at, now()) else completed_at end,
           last_error = null,
           updated_at = now()
     where user_id = p_user
    returning * into v_row;
  end if;
  return public.account_deletion_json(v_row);
end;
$$;

revoke all on function public.account_deletion_mark(uuid, text, text) from public;
revoke execute on function public.account_deletion_mark(uuid, text, text) from anon, authenticated;
grant execute on function public.account_deletion_mark(uuid, text, text) to service_role;

-- The stored objects under `<id>/` in every bucket the inventory lists, a
-- page at a time (the function deletes them through the Storage API and
-- asks again until none is left).
create or replace function public.account_storage_objects(p_user uuid, p_limit integer default 1000)
returns table (bucket_id text, name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select o.bucket_id, o.name
  from storage.objects o
  where o.bucket_id = any (select substr(i.name, 9) from public.account_data_inventory i where i.kind = 'bucket')
    and o.name collate "C" >= p_user::text || '/'
    and o.name collate "C" < p_user::text || '0'
  order by o.bucket_id, o.name collate "C"
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
end;
$$;

revoke all on function public.account_storage_objects(uuid, integer) from public;
revoke execute on function public.account_storage_objects(uuid, integer) from anon, authenticated;
grant execute on function public.account_storage_objects(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The moderation log: append-only, except the erasure of an account's words
-- ---------------------------------------------------------------------------

create or replace function public.moderation_actions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.actor_id is null
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
    return new;
  end if;
  -- R6.5: `erase_account_content` replaces the words of the erased
  -- account's own content, and nothing else, while it runs for that account.
  if tg_op = 'UPDATE'
     and old.subject_id is not null
     and current_setting('rail.erasing_account', true) = old.subject_id::text
     and new.details = '{"erased": "account-deleted"}'::jsonb
     and (to_jsonb(new) - 'details' - 'actor_id') = (to_jsonb(old) - 'details' - 'actor_id')
     and (new.actor_id is null or new.actor_id = old.actor_id) then
    return new;
  end if;
  raise exception 'moderation_actions is append-only' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The content and the traces in others' rows
-- ---------------------------------------------------------------------------

create or replace function public.erase_account_content(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keep_posts   uuid[];
  v_keep_hands   uuid[];
  v_posts        uuid[];
  v_comments     uuid[];
  v_authors      uuid[];
  v_counts       jsonb := '{}'::jsonb;
  v_n            integer;
  v_id           uuid;
begin
  if p_user is null then
    raise exception 'No account to erase.' using errcode = '22023';
  end if;
  perform set_config('rail.erasing_account', p_user::text, true);

  -- Votes: the posts and comments they counted on, and those authors.
  select coalesce(array_agg(post_id), '{}') into v_posts from public.post_votes where user_id = p_user;
  select coalesce(array_agg(comment_id), '{}') into v_comments from public.comment_votes where user_id = p_user;
  delete from public.post_votes where user_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('postVotes', v_n);
  delete from public.comment_votes where user_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('commentVotes', v_n);
  foreach v_id in array v_posts loop
    perform public.forum_recount_post(v_id);
  end loop;
  foreach v_id in array v_comments loop
    perform public.forum_recount_comment(v_id);
  end loop;
  select coalesce(array_agg(distinct a), '{}') into v_authors from (
    select p.author_id as a from public.posts p where p.id = any (v_posts)
    union select c.author_id from public.comments c where c.id = any (v_comments)) x
  where a is not null and a <> p_user;

  -- The moderation log: the words of the account's own content.
  update public.moderation_actions
     set details = '{"erased": "account-deleted"}'::jsonb
   where subject_id = p_user
     and target_type in ('post', 'comment', 'published_hand')
     and details is distinct from '{"erased": "account-deleted"}'::jsonb;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('moderationDetailsErased', v_n);

  -- Posts: kept where someone else replied, deleted otherwise.
  select coalesce(array_agg(p.id), '{}') into v_keep_posts
  from public.posts p
  where p.author_id = p_user
    and exists (select 1 from public.comments c
                 where c.post_id = p.id and c.author_id is not null and c.author_id <> p_user
                   and c.status = 'visible' and c.deleted_at is null);

  select coalesce(array_agg(x.id), '{}') into v_keep_hands from (
    select p.published_hand_id as id from public.posts p
     where p.id = any (v_keep_posts) and p.published_hand_id is not null
    union
    select pp.published_hand_id from public.post_polls pp where pp.post_id = any (v_keep_posts)) x
  join public.published_hands h on h.id = x.id and h.author_id = p_user;

  update public.posts
     set title = '[deleted]', body = '', author_id = null
   where id = any (v_keep_posts);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('postsAnonymised', v_n);
  -- Their earlier versions (including the one the edit above just kept).
  delete from public.content_revisions where post_id = any (v_keep_posts) and comment_id is null;

  delete from public.posts where author_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('postsDeleted', v_n);

  -- Comments: tombstones, as a deleted comment is.
  update public.posts p
     set comment_count = greatest(p.comment_count - x.n, 0)
    from (select c.post_id, count(*)::integer as n from public.comments c
           where c.author_id = p_user and c.deleted_at is null group by c.post_id) x
   where p.id = x.post_id;
  delete from public.content_revisions r
   using public.comments c
   where r.comment_id = c.id and c.author_id = p_user;
  update public.comments
     set body = null, author_id = null, deleted_at = coalesce(deleted_at, now())
   where author_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('commentsTombstoned', v_n);

  -- Karma of the authors whose posts and comments the votes counted on.
  foreach v_id in array v_authors loop
    perform public.forum_recount_karma(v_id);
  end loop;

  -- Published hands: kept under a kept thread, deleted otherwise.
  update public.published_hands
     set phf = case when mode = 'as-imported' then public.scrub_phf(phf, 'pseudonyms') else phf end,
         mode = case when mode = 'as-imported' then 'pseudonyms'::public.publish_mode else mode end,
         title = null,
         author_id = null
   where id = any (v_keep_hands);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('publishedHandsAnonymised', v_n);
  delete from public.published_hands where author_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('publishedHandsDeleted', v_n);

  -- What the account's comments caused in others' inboxes.
  delete from public.notifications where actor_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('notificationsCaused', v_n);

  -- Reports it filed: kept, unlinked, without its words.
  update public.reports set reporter_id = null, details = null where reporter_id = p_user;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('reportsAnonymised', v_n);

  -- Conversion failures sent from the web: verbatim text.
  delete from public.unparsed_hands where submitted_by = p_user and origin = 'web';
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('conversionFailuresDeleted', v_n);

  -- Rate-limit windows named after it.
  delete from public.ingest_rate_limit where bucket like '%' || p_user::text || '%';

  -- Auth's audit log lines naming it as the actor, where this role may.
  begin
    delete from auth.audit_log_entries where payload ->> 'actor_id' = p_user::text;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('authAuditLines', v_n);
  exception when insufficient_privilege or undefined_table then
    v_counts := v_counts || jsonb_build_object('authAuditLines', null);
  end;

  update public.account_deletions
     set content_done_at = coalesce(content_done_at, now()), last_error = null, updated_at = now()
   where user_id = p_user;
  return v_counts;
end;
$$;

revoke all on function public.erase_account_content(uuid) from public;
revoke execute on function public.erase_account_content(uuid) from anon, authenticated;
grant execute on function public.erase_account_content(uuid) to service_role;

-- The hands, a batch at a time. Returns how many it deleted; 0 marks the
-- step done; -1: the hands left are being deleted by another call. 200 a
-- call by default: the cascade (~6 statistics rows a hand, the analysis) is
-- random I/O - measured on a 1 000 000-hand account, a cold batch of 500 took
-- 3-6 s and sometimes more under load, against PostgREST's 8 s statement
-- timeout; a warm one 0.2 s.
create or replace function public.erase_account_hands(p_user uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_n integer;
begin
  if p_user is null then
    raise exception 'No account to erase.' using errcode = '22023';
  end if;
  -- The summary triggers skip this statement (section 6): the account's
  -- summaries go with it. Should the deletion stall, its library counts are
  -- marked for a rebuild.
  perform set_config('rail.erasing_account', p_user::text, true);
  insert into public.library_counts_stale (owner_id) values (p_user) on conflict (owner_id) do nothing;
  -- Rows another call is deleting (a second tab, a retried request) are
  -- skipped, not waited for.
  with batch as (
    select h.id from public.hands h
     where h.owner_id = p_user
     order by h.id
     limit least(greatest(coalesce(p_limit, 200), 1), 5000)
     for update skip locked
  )
  delete from public.hands d using batch where d.id = batch.id and d.owner_id = p_user;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- None left, or every one left is another call's: -1 = busy, try again.
    if exists (select 1 from public.hands h where h.owner_id = p_user) then
      return -1;
    end if;
    update public.account_deletions
       set hands_done_at = coalesce(hands_done_at, now()), last_error = null, updated_at = now()
     where user_id = p_user;
  end if;
  return v_n;
end;
$$;

revoke all on function public.erase_account_hands(uuid, integer) from public;
revoke execute on function public.erase_account_hands(uuid, integer) from anon, authenticated;
grant execute on function public.erase_account_hands(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The summaries do not follow an account being erased
-- ---------------------------------------------------------------------------
--
-- Measured on a 1 000 000-hand account: a batch of 500 hands took 1.7 s, of
-- which the statement-level delete triggers that keep the account's
-- summaries (report rollups, library counts, analysis rows) took ~1 s -
-- work for rows the deletion removes anyway. Each such trigger on the hand
-- tables gets a WHEN that skips it while `rail.erasing_account` is set (only
-- inside `erase_account_hands` and `erase_account_content`, for one
-- transaction; a client cannot reach either). The definitions are re-created
-- from `pg_get_triggerdef`, names and functions unchanged, so a later
-- migration that re-creates one of these triggers must keep the WHEN
-- (pgTAP `account_data` checks).

do $erase$
declare
  r record;
  v_def text;
begin
  for r in
    select t.oid, t.tgname, c.relname
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal
      and c.relnamespace = 'public'::regnamespace
      and c.relname in ('hands', 'hand_stats', 'hand_stats_ev', 'hand_analysis', 'decision_analysis')
      and (t.tgtype & 8) <> 0      -- delete
      and (t.tgtype & 1) = 0       -- for each statement
      and t.tgqual is null
  loop
    v_def := pg_get_triggerdef(r.oid);
    if position(' EXECUTE FUNCTION ' in v_def) = 0 then
      raise exception 'unexpected trigger definition: %', v_def;
    end if;
    v_def := replace(v_def, ' EXECUTE FUNCTION ',
      ' WHEN (coalesce(current_setting(''rail.erasing_account'', true), '''') = '''') EXECUTE FUNCTION ');
    execute format('drop trigger %I on public.%I', r.tgname, r.relname);
    execute v_def;
  end loop;
end;
$erase$;

-- ---------------------------------------------------------------------------
-- 7. The server finishes a deletion the page left
-- ---------------------------------------------------------------------------
--
-- Deleting a 1 000 000-hand library takes the better part of an hour (the
-- cascade to ~6M statistics rows and the analysis is I/O-bound: measured
-- ~3 s for a cold batch of 500 on a local stack). The page calls the
-- function again while it answers 202, but nobody should have to keep a tab
-- open for an hour: once billing, storage and content are done - the steps
-- that need the Edge Function - pg_cron carries on every minute
-- (`finish_account_deletions`, ~50 s of batches, a commit after each), and
-- when no hand is left deletes the auth user (every remaining row cascades)
-- and marks the request completed. A call of the function meanwhile works
-- beside it (`skip locked`) or finds the account gone.

-- One step of a pending deletion, for one account; the procedure below
-- commits after each. 'hands': a batch went; 'busy': another call holds the
-- hands left; 'completed'; 'waiting': a step before the hands is not done;
-- 'kept': the auth user could not be deleted from SQL (the function will).
create or replace function public.account_deletion_continue(p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.account_deletions;
  v_n   integer;
begin
  select * into v_row from public.account_deletions where user_id = p_user;
  if not found or v_row.completed_at is not null then
    return 'completed';
  end if;
  if v_row.billing_done_at is null or v_row.storage_done_at is null or v_row.content_done_at is null then
    return 'waiting';
  end if;
  if v_row.hands_done_at is null then
    v_n := public.erase_account_hands(p_user, 200);
    if v_n > 0 then
      return 'hands';
    elsif v_n < 0 then
      return 'busy';
    end if;
  end if;
  begin
    delete from auth.users where id = p_user;
  exception when insufficient_privilege then
    return 'kept';
  end;
  update public.account_deletions
     set completed_at = coalesce(completed_at, now()), last_error = null, updated_at = now()
   where user_id = p_user;
  return 'completed';
end;
$$;

revoke all on function public.account_deletion_continue(uuid) from public;
revoke execute on function public.account_deletion_continue(uuid) from anon, authenticated;

-- pg_cron's job. A procedure (neither definer nor with a `set` clause: either
-- forbids a commit inside), run as the job's owner; executable by nobody
-- else. Every name in it is schema-qualified.
create or replace procedure public.finish_account_deletions(p_seconds integer default 50)
language plpgsql
as $$
declare
  v_until timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_seconds, 50), 1), 300));
  v_user  uuid;
  v_state text;
begin
  for v_user in
    select user_id from public.account_deletions
     where completed_at is null and content_done_at is not null
     order by requested_at
  loop
    loop
      exit when clock_timestamp() > v_until;
      v_state := public.account_deletion_continue(v_user);
      commit;
      exit when v_state <> 'hands';
    end loop;
    exit when clock_timestamp() > v_until;
  end loop;
end;
$$;

revoke all on procedure public.finish_account_deletions(integer) from public;
revoke execute on procedure public.finish_account_deletions(integer) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Purge
-- ---------------------------------------------------------------------------

create or replace function public.purge_account_deletions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.account_deletions
   where coalesce(completed_at, updated_at) < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.purge_account_deletions() from public;
revoke execute on function public.purge_account_deletions() from anon, authenticated;

do $cron$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); schedule purge_account_deletions and finish_account_deletions by hand', sqlerrm;
    return;
  end;
  perform cron.unschedule(jobid) from cron.job where jobname in ('account-deletions-purge', 'account-deletions-finish');
  perform cron.schedule('account-deletions-purge', '23 4 * * *', 'select public.purge_account_deletions();');
  perform cron.schedule('account-deletions-finish', '* * * * *', 'call public.finish_account_deletions(50);');
end;
$cron$;

commit;

-- ===========================================================================
-- Rail: the Trainer's sessions (`docs/TRAINER.md` §7, 2026-11-16)
-- ===========================================================================
--
-- A training session is a name and the Trainer's settings, fixed for its
-- life: the player picks what to train once ("BB defence vs BTN open"),
-- trains it as long as they like, comes back to it any day, and reviews its
-- history. Changing a setting starts a new session; the old one stays as it
-- was. Each answer keeps the spot it was given on (`spot_ref`: the deal's
-- request and seed, which re-deal it exactly), so a session can deal a spot
-- the player has already played and show what they answered then.
--
--   trainer_sessions         one row per session: name, settings (the fields
--                            that differ from the defaults, `settingsFields`),
--                            archived, created, last played.
--   trainer_session_answers  every graded answer in a session: the hero's
--                            cards, the board, the spot's key, the move and
--                            the best move, grade, EV lost, score and the
--                            spot's deal (null for a whole hand's decision).
--
--   save_trainer_session              creates or updates one of the caller's
--                                     sessions (name, settings, archived).
--   record_trainer_session_answers    records answers in one of the caller's
--                                     sessions (at most 50 per call).
--   trainer_session_list              the caller's sessions with their
--                                     hands, score, EV lost, grade counts.
--
-- `trainer_results` is unchanged: every answer still goes there too (the
-- study plan counts it), whatever session it was given in.
--
-- ## The security model (as `20270208090000_analysis_training.sql`)
--
--   * No client role holds INSERT, UPDATE or DELETE on either table;
--     `select` to `authenticated`, scoped to the owner by RLS; nothing to
--     `anon`.
--   * Writes go through `security definer` functions with an explicit
--     `auth.uid()` ownership check: a session is written only by its owner,
--     answers only into a session the caller owns (another account's session
--     and no session get the same answer).
--   * Every write is rate-limited per account; at most 300 sessions an
--     account.
--   * The grade comes from the client (the Trainer grades in the browser
--     with the analysis engine); the database checks the shape and the
--     bounds. A false grade skews only the player's own history.
--   * Pro: the three functions are listed in `entitlement_gates` (feature
--     `analysis`, as the Trainer is) and gated by `entitlement_gates_apply()`.
--   * The account's data: both tables are in `account_data_inventory`,
--     exported as `learning/trainer_sessions.ndjson` and
--     `learning/trainer_session_answers.ndjson`, deleted with the account.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.trainer_sessions (
  id         uuid primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  -- The settings that differ from the defaults (`settingsFields`), strings only.
  settings   jsonb not null default '{}'::jsonb
             check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 4000),
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  played_at  timestamptz not null default now()
);

comment on table public.trainer_sessions is
  'A Trainer session: a name and fixed settings. Written only by save_trainer_session.';

create index if not exists trainer_sessions_owner_idx on public.trainer_sessions (owner_id, played_at desc);

create table if not exists public.trainer_session_answers (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.trainer_sessions (id) on delete cascade,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  street      text not null check (street in ('preflop', 'flop', 'turn', 'river')),
  -- The hero's two cards and the board, as `Kd`, concatenated.
  cards       text not null check (cards ~ '^([2-9TJQKA][cdhs]){2}$'),
  board       text not null default '' check (board ~ '^([2-9TJQKA][cdhs]){0,5}$'),
  -- What makes two answers the same spot (`components/trainer/sessions.ts`, `spotKey`).
  spot_key    text not null check (char_length(spot_key) between 1 and 300),
  position    text check (position ~ '^[A-Z0-9+]{1,8}$'),
  hand_class  text check (hand_class ~ '^[2-9TJQKA]{2}[so]?$'),
  move        text not null check (char_length(move) between 1 and 60),
  best        text not null default '' check (char_length(best) <= 60),
  grade       text not null check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  ev_loss_bb  numeric(12, 3) not null check (ev_loss_bb between 0 and 1000),
  score       numeric(6, 2) not null check (score between 0 and 100),
  -- The deal (`{ request, seed }`) that gives the spot again; null for a whole hand's decision.
  spot_ref    jsonb check (spot_ref is null or (jsonb_typeof(spot_ref) = 'object' and pg_column_size(spot_ref) <= 2000))
);

comment on table public.trainer_session_answers is
  'Every graded answer in a Trainer session. Written only by record_trainer_session_answers.';

create index if not exists trainer_session_answers_session_idx on public.trainer_session_answers (session_id, created_at);
create index if not exists trainer_session_answers_owner_idx on public.trainer_session_answers (owner_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. RLS: select-own, nothing else
-- ---------------------------------------------------------------------------

alter table public.trainer_sessions enable row level security;
alter table public.trainer_session_answers enable row level security;

revoke all on public.trainer_sessions from anon, authenticated;
revoke all on public.trainer_session_answers from anon, authenticated;
grant select on public.trainer_sessions to authenticated;
grant select on public.trainer_session_answers to authenticated;

drop policy if exists trainer_sessions_owner_select on public.trainer_sessions;
create policy trainer_sessions_owner_select on public.trainer_sessions
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists trainer_session_answers_owner_select on public.trainer_session_answers;
create policy trainer_session_answers_owner_select on public.trainer_session_answers
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. save_trainer_session
-- ---------------------------------------------------------------------------
--
-- The id is the client's (a UUID it made), so a session can be used before
-- the call returns. A new id creates the session; the caller's own id updates
-- its name, settings and archived flag; another account's id is refused like
-- a malformed one would be (`42501`).

create or replace function public.save_trainer_session(
  p_id       uuid,
  p_name     text,
  p_settings jsonb,
  p_archived boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_other uuid;
  v_count integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep training sessions.' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'save_trainer_session needs an id.' using errcode = '22023';
  end if;
  if p_settings is not null and exists (
       select 1 from jsonb_each(p_settings) e where jsonb_typeof(e.value) <> 'string' or char_length(e.key) > 40) then
    raise exception 'Session settings are short names with string values.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('trainer_sessions:' || v_owner::text, 1, 300, interval '10 minutes');

  select s.owner_id into v_other from public.trainer_sessions s where s.id = p_id;
  if found and v_other <> v_owner then
    raise exception 'No such session.' using errcode = '42501';
  end if;
  if not found then
    select count(*) into v_count from public.trainer_sessions s where s.owner_id = v_owner;
    if v_count >= 300 then
      raise exception 'At most 300 training sessions; archive or reuse one.' using errcode = '53400';
    end if;
    insert into public.trainer_sessions (id, owner_id, name, settings, archived)
    values (p_id, v_owner, btrim(p_name), coalesce(p_settings, '{}'::jsonb), coalesce(p_archived, false));
  else
    update public.trainer_sessions s
       set name = btrim(p_name),
           settings = coalesce(p_settings, s.settings),
           archived = coalesce(p_archived, s.archived)
     where s.id = p_id and s.owner_id = v_owner;
  end if;

  return jsonb_build_object('id', p_id);
end;
$$;

comment on function public.save_trainer_session(uuid, text, jsonb, boolean) is
  'Creates or updates one of the caller''s Trainer sessions. Definer with an explicit ownership check; '
  'rate-limited; at most 300 sessions an account.';

revoke all on function public.save_trainer_session(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.save_trainer_session(uuid, text, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. record_trainer_session_answers
-- ---------------------------------------------------------------------------
--
-- `p_rows`: [{ at, street, cards, board, spot_key, position, hand_class, move,
-- best, grade, ev_loss_bb, score, spot_ref }], at most 50. A row the table's
-- checks refuse fails the call (23514): never half-written. `at` is when the
-- answer was given (an outbox may send it later); a time in the future or
-- more than 30 days back is taken as now.

create or replace function public.record_trainer_session_answers(p_session uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep training sessions.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_trainer_session_answers expects a JSON array.' using errcode = '22023';
  end if;
  -- The ownership check: definer functions are not protected by RLS.
  if not exists (select 1 from public.trainer_sessions s where s.id = p_session and s.owner_id = v_owner) then
    raise exception 'No such session.' using errcode = '42501';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object('inserted', 0);
  end if;
  if v_received > 50 then
    raise exception 'record_trainer_session_answers accepts at most 50 rows per call (got %).', v_received
      using errcode = '53400';
  end if;

  perform public.enforce_rate_limit('trainer_session_answers:' || v_owner::text, v_received, 1200, interval '10 minutes');

  with ins as (
    insert into public.trainer_session_answers (session_id, owner_id, created_at, street, cards, board, spot_key,
                                                position, hand_class, move, best, grade, ev_loss_bb, score, spot_ref)
    select p_session, v_owner,
           case when x.at is null or x.at > now() or x.at < now() - interval '30 days' then now() else x.at end,
           x.street, x.cards, coalesce(x.board, ''), x.spot_key, nullif(x.position, ''), nullif(x.hand_class, ''),
           x.move, coalesce(x.best, ''), x.grade, round(x.ev_loss_bb, 3), round(x.score, 2),
           case when jsonb_typeof(x.spot_ref) = 'object' then x.spot_ref end
    from jsonb_to_recordset(p_rows) as x(
      at timestamptz, street text, cards text, board text, spot_key text, position text, hand_class text,
      move text, best text, grade text, ev_loss_bb numeric, score numeric, spot_ref jsonb)
    returning 1
  )
  select count(*) into v_inserted from ins;

  update public.trainer_sessions s set played_at = now() where s.id = p_session and s.owner_id = v_owner;

  return jsonb_build_object('inserted', v_inserted);
end;
$$;

comment on function public.record_trainer_session_answers(uuid, jsonb) is
  'Records graded answers in one of the caller''s Trainer sessions (at most 50 per call). Definer with an '
  'explicit ownership check; rate-limited; the table''s checks validate every column.';

revoke all on function public.record_trainer_session_answers(uuid, jsonb) from public, anon;
grant execute on function public.record_trainer_session_answers(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. trainer_session_list (invoker, RLS)
-- ---------------------------------------------------------------------------
--
-- The caller's sessions, last played first, each with its answers counted:
-- hands, today's hands (UTC day of `p_today_from`), score sum, EV lost, the
-- five grade counts. One pass over the caller's answers (`owner_idx`).

create or replace function public.trainer_session_list(p_today_from timestamptz default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read training sessions.' using errcode = '42501';
  end if;
  with totals as (
    select a.session_id,
           count(*) as hands,
           count(*) filter (where a.created_at >= coalesce(p_today_from, date_trunc('day', now()))) as today,
           sum(a.score) as score_sum,
           sum(a.ev_loss_bb) as ev_loss,
           count(*) filter (where a.grade = 'perfect') as perfect,
           count(*) filter (where a.grade = 'good') as good,
           count(*) filter (where a.grade = 'inaccurate') as inaccurate,
           count(*) filter (where a.grade = 'mistake') as mistake,
           count(*) filter (where a.grade = 'blunder') as blunder
    from public.trainer_session_answers a
    where a.owner_id = v_owner
    group by a.session_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'name', s.name, 'settings', s.settings, 'archived', s.archived,
           'created_at', s.created_at, 'played_at', s.played_at,
           'hands', coalesce(t.hands, 0), 'today', coalesce(t.today, 0),
           'score_sum', coalesce(t.score_sum, 0), 'ev_loss', coalesce(t.ev_loss, 0),
           'counts', jsonb_build_object('perfect', coalesce(t.perfect, 0), 'good', coalesce(t.good, 0),
                                        'inaccurate', coalesce(t.inaccurate, 0), 'mistake', coalesce(t.mistake, 0),
                                        'blunder', coalesce(t.blunder, 0)))
         order by s.played_at desc), '[]'::jsonb)
  into v_out
  from public.trainer_sessions s
  left join totals t on t.session_id = s.id
  where s.owner_id = v_owner;
  return v_out;
end;
$$;

comment on function public.trainer_session_list(timestamptz) is
  'The caller''s Trainer sessions, last played first, with hands, today''s hands, score sum, EV lost and '
  'grade counts. Invoker, RLS-scoped.';

revoke all on function public.trainer_session_list(timestamptz) from public, anon;
grant execute on function public.trainer_session_list(timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Pro (R6.2) and the account's data (R6.5)
-- ---------------------------------------------------------------------------

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.save_trainer_session(uuid,text,jsonb,boolean)', 'analysis', 'trainer sessions'),
  ('public.record_trainer_session_answers(uuid,jsonb)', 'analysis', 'trainer sessions'),
  ('public.trainer_session_list(timestamp with time zone)', 'analysis', 'trainer sessions')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

select public.entitlement_gates_apply();

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.trainer_sessions', 'table', '{owner_id}', 'file', 'learning/trainer_sessions.ndjson', 'rows', 'trainer_sessions',
   '{created_at,id}', '{}', 'cascade', 'Trainer sessions: name and settings.'),
  ('public.trainer_session_answers', 'table', '{owner_id}', 'file', 'learning/trainer_session_answers.ndjson', 'rows',
   'trainer_session_answers', '{created_at,id}', '{}', 'cascade', 'Answers given in Trainer sessions.')
on conflict (name) do nothing;

commit;

-- pgTAP: a shared analysis survives a version bump (A5a) --
-- `20270224090000_analysis_share_fallback.sql`.
--
--   * still security definer with an empty search_path, executable by anon;
--   * a hand with no row at the requested version shows its newest older
--     row, flagged `staleVersion`; with a row at the version, that row and no
--     flag; never a newer row than asked for;
--   * the owner's opt-in still decides: switched off, nothing at any version.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(9);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000a5f1', 'fallback.a@example.com', now() - interval '40 days', now() - interval '40 days');

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon() to anon, authenticated;

insert into public.hands (id, owner_id, hand_key, phf, standard_text, source_text, site, played_at, hero_seat) values
  ('00000000-0000-0000-0000-00000000a5f9', '00000000-0000-0000-0000-00000000a5f1', 'pokerstars:fb1',
   '{"schema":"phf/1","meta":{"siteId":"pokerstars","handId":"fb1","handKey":"fb1"},"actions":[]}',
   'std', 'raw', 'pokerstars', now(), 1);

create function pg_temp.analysis_at(p_version text, p_grade text) returns jsonb language sql as $$
  select jsonb_build_object(
    'hand_id', '00000000-0000-0000-0000-00000000a5f9', 'analysis_version', p_version, 'status', 'full', 'hero_seat', 1,
    'pot_type', 'single-raised', 'grade', p_grade, 'score', 90, 'ev_loss_bb', 0.1, 'ev_loss_pot', 0.01,
    'approximations', '[]'::jsonb,
    'decisions', jsonb_build_array(
      jsonb_build_object('ord', 0, 'action_index', 1, 'street', 'turn', 'action', 'check', 'status', 'analysed',
        'node', 'n', 'scenario', 'pfr-ip-first', 'source', 'solver', 'grade', p_grade, 'score', 90,
        'ev_loss_bb', 0.1, 'ev_loss_pot', 0.01, 'freq_diff', 0.1,
        'options', '[{"action":"check","freq":0.4,"ev":1.6},{"action":"bet","size":3.4,"sizePot":0.75,"freq":0.6,"ev":1.7}]'::jsonb,
        'chosen', 0, 'flags', '[]'::jsonb, 'approximations', '["coarse-river"]'::jsonb, 'facing_bet', false, 'pot_bb', 4.5,
        'facts', '{"street":"turn","turn":{"tree":"turn-m1","role":"medium"}}'::jsonb)));
$$;
grant execute on function pg_temp.analysis_at(text, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000000a5f1');
select public.save_hand_analysis(jsonb_build_array(pg_temp.analysis_at('analysis/3', 'good')));
select set_config('test.slug', public.create_share('00000000-0000-0000-0000-00000000a5f9') ->> 'slug', true);
select public.set_analysis_share('share', current_setting('test.slug'), true);

select ok(
  (select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%' from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'read_shared_analysis'),
  'still security definer with an empty search_path');
select ok(has_function_privilege('anon', 'public.read_shared_analysis(text, text, text)', 'execute'), 'anon may call it');

select pg_temp.act_as_anon();
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/4') ->> 'analysisVersion', 'analysis/3',
  'no row at analysis/4: the newest older one');
select is((public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/4') ->> 'staleVersion')::boolean, true,
  '... flagged as an older version');
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/3') ? 'staleVersion', false,
  'at its own version: no flag');
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/2'), null,
  'never a newer row than asked for');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a5f1');
select public.save_hand_analysis(jsonb_build_array(pg_temp.analysis_at('analysis/4', 'perfect')));
select pg_temp.act_as_anon();
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/4') ->> 'grade', 'perfect',
  'once re-analysed: the current row');
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/4') ? 'staleVersion', false,
  '... unflagged');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a5f1');
select public.set_analysis_share('share', current_setting('test.slug'), false);
select pg_temp.act_as_anon();
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/9'), null,
  'switched off: nothing, at any version');

select * from finish();
rollback;

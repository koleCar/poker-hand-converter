-- pgTAP: an opponent's statistics never leave through a share (analysis/20) --
-- `20270407090000_shared_analysis_strip_villain.sql`.
--
--   * `read_shared_analysis` still security definer with an empty
--     search_path, executable by anon and authenticated, not by public, and
--     drops `villain` itself after the facts projection (whose key list
--     already leaves it out);
--   * a decision whose stored facts carry `villain` (the owner's VPIP / PFR
--     counters on an opponent, `SpotFacts.villain`) comes back without it, on
--     every public surface, to anon and to a signed-in stranger, at the
--     version and through the stale-version fallback;
--   * every other fact comes back unchanged - the turn's and river's own
--     `villain` (the range's shape, read from the hand) included;
--   * the owner's own read (`analysis_hand`) still has it: nothing stored is
--     dropped.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(15);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000a201', 'villain.owner@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a202', 'villain.other@example.com', now() - interval '40 days', now() - interval '40 days');

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
  ('00000000-0000-0000-0000-00000000a209', '00000000-0000-0000-0000-00000000a201', 'pokerstars:vl1',
   '{"schema":"phf/1","meta":{"siteId":"pokerstars","handId":"vl1","handKey":"vl1"},"actions":[]}',
   'std', 'raw', 'pokerstars', now(), 1);

-- The facts a stranger may see, and the same facts with the owner's statistics.
create function pg_temp.public_facts() returns jsonb language sql as $$
  select '{"street":"river","potBb":12.5,"toCallBb":6,"potOdds":0.25,
           "equity":{"value":0.41,"range":"bb-defence:BB"},
           "river":{"role":"bluff-catcher","villainCombos":88,"villain":{"strong":0.3,"medium":0.3,"weak":0.4,"shape":"polar"}},
           "turn":{"tree":"turn-m1","villain":{"strong":0.2,"medium":0.5,"weak":0.3,"shape":"merged"}},
           "multiway":{"players":3,"opponents":[{"position":"BB","range":"bb-defence:BB","approx":["range-villain"]}]}}'::jsonb;
$$;
create function pg_temp.villain() returns jsonb language sql as $$
  select '{"position":"BB","range":"bb-defence:BB","hands":312,"passive":0.24,"shrunk":0.23,
           "stats":{"vpipOpp":312,"vpip":110,"pfr":35}}'::jsonb;
$$;
grant execute on function pg_temp.public_facts(), pg_temp.villain() to anon, authenticated;

create function pg_temp.analysis_at(p_version text) returns jsonb language sql as $$
  select jsonb_build_object(
    'hand_id', '00000000-0000-0000-0000-00000000a209', 'analysis_version', p_version, 'status', 'full', 'hero_seat', 1,
    'pot_type', 'single-raised', 'grade', 'good', 'score', 90, 'ev_loss_bb', 0.1, 'ev_loss_pot', 0.01,
    'approximations', '["range-villain"]'::jsonb,
    'decisions', jsonb_build_array(
      jsonb_build_object('ord', 0, 'action_index', 1, 'street', 'river', 'action', 'call', 'status', 'analysed',
        'node', 'n', 'scenario', 'pfr-ip-vs-bet', 'source', 'solver', 'grade', 'good', 'score', 90,
        'ev_loss_bb', 0.1, 'ev_loss_pot', 0.01, 'freq_diff', 0.1,
        'options', '[{"action":"fold","freq":0.4,"ev":0},{"action":"call","freq":0.6,"ev":0.2}]'::jsonb,
        'chosen', 1, 'flags', '[]'::jsonb, 'approximations', '["range-villain"]'::jsonb, 'facing_bet', true, 'pot_bb', 12.5,
        'facts', pg_temp.public_facts() || jsonb_build_object('villain', pg_temp.villain())),
      jsonb_build_object('ord', 1, 'action_index', 2, 'street', 'river', 'action', 'check', 'status', 'analysed',
        'node', 'n2', 'scenario', 'pfr-ip-first', 'source', 'solver', 'grade', 'perfect', 'score', 100,
        'ev_loss_bb', 0, 'ev_loss_pot', 0, 'freq_diff', 0,
        'options', '[{"action":"check","freq":1,"ev":1}]'::jsonb,
        'chosen', 0, 'flags', '[]'::jsonb, 'approximations', '[]'::jsonb, 'facing_bet', false, 'pot_bb', 24.5,
        'facts', '{"street":"river","potBb":24.5}'::jsonb)));
$$;
grant execute on function pg_temp.analysis_at(text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000000a201');
select public.save_hand_analysis(jsonb_build_array(pg_temp.analysis_at('analysis/20')));
select set_config('test.slug', public.create_share('00000000-0000-0000-0000-00000000a209') ->> 'slug', true);
select public.set_analysis_share('share', current_setting('test.slug'), true);

-- Unchanged security.
select ok(
  (select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%' from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'read_shared_analysis'),
  'still security definer with an empty search_path');
select ok(has_function_privilege('anon', 'public.read_shared_analysis(text, text, text)', 'execute'), 'anon may still call it');
select ok(has_function_privilege('authenticated', 'public.read_shared_analysis(text, text, text)', 'execute'), 'authenticated may still call it');
select ok(
  not exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public' and routine_name = 'read_shared_analysis' and grantee = 'PUBLIC'),
  'public may not');
select ok(
  pg_get_functiondef('public.read_shared_analysis(text, text, text)'::regprocedure) like '%analysis_public_facts(d.facts) - ''villain''%',
  'the reader drops it itself, not only by the projection''s list');

-- The owner keeps it.
select ok(public.analysis_hand('00000000-0000-0000-0000-00000000a209', 'analysis/20') -> 'decisions' -> 0 -> 'facts' ? 'villain',
  'the owner''s own read still has the stored statistics');

select pg_temp.act_as_anon();
select set_config('test.read', public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/20')::text, true);
select isnt(current_setting('test.read'), '', 'anon reads the shared analysis');
select is(current_setting('test.read')::jsonb -> 'decisions' -> 0 -> 'facts' ? 'villain', false,
  'no villain key in a decision whose stored facts carry one');
select is(current_setting('test.read')::jsonb -> 'decisions' -> 0 -> 'facts', pg_temp.public_facts(),
  'every other fact unchanged, the turn''s and river''s range shapes included');
select is(current_setting('test.read')::jsonb -> 'decisions' -> 1 -> 'facts', '{"street":"river","potBb":24.5}'::jsonb,
  'a decision without statistics unchanged');
select is(current_setting('test.read')::jsonb ->> 'grade', 'good', 'the rest of the analysis unchanged');
select is(
  (select count(*)::int from jsonb_path_query(current_setting('test.read')::jsonb, 'strict $.**.vpipOpp')),
  0, 'no counter anywhere in the document');

select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/21') -> 'decisions' -> 0 -> 'facts' ? 'villain',
  false, 'none through the older-version fallback either');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a202');
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/20') -> 'decisions' -> 0 -> 'facts' ? 'villain',
  false, 'none to a signed-in stranger');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a201');
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/20') -> 'decisions' -> 0 -> 'facts' ? 'villain',
  false, 'none to the owner through the public read: the public read is the public projection');

select * from finish();
rollback;

-- pgTAP: a hand's table knows the 9-max 60bb set (`20271108090000_table_set_9max_60bb.sql`).
--
-- What has to hold:
--
--   * security, as `20271102090000` set it: the helper is immutable, invoker,
--     with an empty search_path, executable by `authenticated`, not `anon`;
--   * 7-9 handed hands at 48-72bb effective read the 9-max 60bb set; 9-max
--     73-79bb and under 48bb read no set; every set another hand read before
--     is unchanged (9-max 100bb, 6-max 60bb, heads-up).
--
-- The backfill the migration runs is `20271102090000`'s, unchanged, and is
-- tested by `leak_row_table.test.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(9);

-- A PHF with what the helper reads (as `leak_row_table.test.sql`'s): the game,
-- the players (position, hero, starting stack in big blinds at a $1 big
-- blind) and the preflop folds.
create function pg_temp.phf(p_players jsonb, p_folds int[] default '{}')
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'game', jsonb_build_object('variant', 'holdem', 'limit', 'nl', 'format', 'cash', 'bigBlind', 100, 'smallBlind', 50),
    'players', (select jsonb_agg(jsonb_build_object('seat', (n)::int, 'name', 'p' || n, 'position', p ->> 0,
                                                    'isHero', (p ->> 2)::boolean, 'startingStack', (p ->> 1)::numeric * 100)
                                 order by n)
                from jsonb_array_elements(p_players) with ordinality as e(p, n)),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('street', 'preflop', 'seat', s, 'type', 'fold') order by s)
                         from unnest(p_folds) s), '[]'::jsonb));
$$;

-- Nine dealt in, every stack `p_bb`, the hero on the button.
create function pg_temp.nine(p_bb numeric) returns jsonb language sql immutable as $$
  select pg_temp.phf(jsonb_build_array(
    jsonb_build_array('UTG', p_bb, false), jsonb_build_array('UTG+1', p_bb, false), jsonb_build_array('UTG+2', p_bb, false),
    jsonb_build_array('LJ', p_bb, false), jsonb_build_array('HJ', p_bb, false), jsonb_build_array('CO', p_bb, false),
    jsonb_build_array('BTN', p_bb, true), jsonb_build_array('SB', p_bb, false), jsonb_build_array('BB', p_bb, false)));
$$;

-- ----------------------------------------------------------- security --

select ok(
  (select p.provolatile = 'i' and not p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.oid = 'public.analysis_hand_table_set(jsonb)'::regprocedure),
  'the table helper is still immutable, invoker, with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.analysis_hand_table_set(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_hand_table_set(jsonb)', 'execute'),
  '... executable by authenticated, not by anon');

-- ------------------------------------------------------------ the set --

select is(public.analysis_hand_table_set(pg_temp.nine(60)), 'nlhe-cash-9max-60bb',
  'nine dealt in at 60bb: the 9-max 60bb set');
select is(
  array[public.analysis_hand_table_set(pg_temp.nine(48)), public.analysis_hand_table_set(pg_temp.nine(72))],
  array['nlhe-cash-9max-60bb', 'nlhe-cash-9max-60bb'],
  '... its band is 48-72bb');
select is(public.analysis_hand_table_set(pg_temp.phf(
    '[["UTG",50,false],["LJ",50,false],["HJ",50,false],["CO",50,false],["BTN",50,true],["SB",50,false],["BB",50,false]]')),
  'nlhe-cash-9max-60bb', 'seven dealt in at 50bb: 9-max 60bb');
select is(public.analysis_hand_table_set(pg_temp.phf(
    '[["UTG",200,false],["UTG+1",55,false],["UTG+2",55,false],["LJ",55,false],["HJ",55,false],["CO",55,false],["BTN",55,true],["SB",55,false],["BB",55,false]]', '{1}')),
  'nlhe-cash-9max-60bb', 'a deep UTG who folded does not deepen the spot: 9-max 60bb');
select is(
  array[public.analysis_hand_table_set(pg_temp.nine(75)), public.analysis_hand_table_set(pg_temp.nine(45))],
  array['', ''],
  'no set at 75bb (20% from neither 60 nor 100bb) or 45bb');
select is(
  array[public.analysis_hand_table_set(pg_temp.nine(100)), public.analysis_hand_table_set(pg_temp.nine(80))],
  array['nlhe-cash-9max-100bb', 'nlhe-cash-9max-100bb'],
  '9-max at 80 and 100bb: still the 9-max 100bb set');
select is(
  array[public.analysis_hand_table_set(pg_temp.phf(
          '[["UTG",60,false],["HJ",60,false],["CO",60,false],["BTN",60,true],["SB",60,false],["BB",60,false]]')),
        public.analysis_hand_table_set(pg_temp.phf('[["SB",100,true],["BB",120,false]]'))],
  array['nlhe-cash-6max-60bb', 'nlhe-cash-hu-100bb'],
  'six dealt in at 60bb and heads-up at 100bb: their sets, as before');

select * from finish();

rollback;

-- pgTAP: the free tier's daily limits, the solver's flops and the six-month
-- period - `20271119110000_free_tier_limits.sql` (and the early-user removal,
-- `20271119120000`).
--
-- What has to hold:
--
--   * the plans: Free saves 500 hands and opens 3 flops a UTC day and has
--     desktop sync only; Pro is unlimited with every feature;
--   * a flop key is canonicalised whatever its order and case, and refused
--     when it is not three distinct cards;
--   * enforcement off (the default): nothing is counted, recorded or refused;
--   * enforcement on, Free: 3 distinct flops, re-opening one is free, the
--     4th is refused, the next day starts again; the day's hand cap refuses
--     a statement whole (web save, direct insert and desktop ingest alike),
--     duplicates cost nothing, the next day starts again;
--   * Pro: every flop and every hand, nothing recorded for flops;
--   * `my_entitlements()` carries the new keys; `half_year` is a period.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(58);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000071f001', 'ft.free@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000071f002', 'ft.free2@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000071a001', 'ft.pro@example.com', now(), now() - interval '30 days');

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
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
create function pg_temp.phf(p_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'meta', jsonb_build_object(
      'siteId', 'weplay', 'siteName', 'WePlay', 'handId', p_id, 'handKey', p_id,
      'originalFilename', 'HH20261001.txt', 'parserId', 'weplay', 'parserVersion', '1.0.0',
      'warnings', '[]'::jsonb, 'rawText', '', 'parsedAt', '1970-01-01T00:00:00.000Z',
      'textStyle', jsonb_build_object('decimals', 'minimal')),
    'game', jsonb_build_object(
      'variant', 'holdem', 'limit', 'nl', 'format', 'cash', 'ante', 0,
      'unit', jsonb_build_object('code', 'USD', 'symbol', '$', 'minorUnits', 100, 'kind', 'cash'),
      'smallBlind', 50, 'bigBlind', 100),
    'table', jsonb_build_object('name', 'Table 1', 'maxSeats', 6),
    'tournament', null,
    'players', jsonb_build_array(
      jsonb_build_object('seat', 1, 'name', 'HeroName', 'isHero', true, 'position', 'BTN', 'holeCards', jsonb_build_array('Ah', 'Kh')),
      jsonb_build_object('seat', 2, 'name', 'Villain1', 'isHero', false, 'position', 'SB'),
      jsonb_build_object('seat', 3, 'name', 'Villain2', 'isHero', false, 'position', 'BB')),
    'actions', '[]'::jsonb,
    'board', jsonb_build_object('runouts', jsonb_build_array(
      jsonb_build_object('flop', jsonb_build_array('2c', '3d', '4s'), 'turn', '5h', 'river', null))),
    'results', jsonb_build_object(
      'streetReached', 'turn', 'wentToShowdown', false, 'totalPot', 300, 'heroNet', 200,
      'fees', jsonb_build_object('rake', 5, 'jackpot', 1, 'bingo', 0, 'fortune', 0, 'tax', 0, 'other', 0),
      'winners', jsonb_build_array(jsonb_build_object('player', 'HeroName', 'seat', 1)),
      'players', '[]'::jsonb),
    'playedAt', '2026-10-01T12:00:00.000Z');
$$;
create function pg_temp.row(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('hand_key', 'weplay:' || p_id, 'phf', pg_temp.phf(p_id));
$$;
create function pg_temp.webs(p_from integer, p_to integer) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('hand_key', 'weplay:' || i, 'phf', pg_temp.phf(i::text),
                                      'site', 'weplay', 'standard_text', 'Poker Hand #' || i) order by i)
    from generate_series(p_from, p_to) i;
$$;
create function pg_temp.refusal(p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_hint  text;
begin
  begin
    execute p_sql;
    return null;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    return v_state || ':' || coalesce(v_hint, '');
  end;
end;
$$;
-- The detail of a refused statement, as JSON.
create function pg_temp.refusal_detail(p_sql text) returns jsonb language plpgsql as $$
declare
  v_detail text;
begin
  begin
    execute p_sql;
    return null;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return v_detail::jsonb;
  end;
end;
$$;
create function pg_temp.open(p_flop text) returns text language sql as $$
  select (e ->> 'allowed') || '/' || (e ->> 'flop') || '/' || coalesce(e ->> 'cap', 'null') || '/'
         || (select coalesce(string_agg(f, ',' order by o), '') from jsonb_array_elements_text(e -> 'flops') with ordinality x(f, o))
    from public.solver_open_flop(p_flop) e;
$$;
create function pg_temp.resets_at() returns text language sql as $$
  select to_char((now() at time zone 'UTC')::date + 1, 'YYYY-MM-DD') || 'T00:00:00Z';
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.as_postgres(), pg_temp.phf(text),
  pg_temp.row(text), pg_temp.webs(integer, integer), pg_temp.refusal(text), pg_temp.refusal_detail(text),
  pg_temp.open(text), pg_temp.resets_at() to anon, authenticated;

-- ---------------------------------------------------------- the plans --

select is((select string_agg(plan || ':' || coalesce(daily_hand_cap::text, 'null') || '/' || coalesce(daily_flop_cap::text, 'null')
                             || '/' || array_to_string(features, ','), ' ' order by plan)
             from public.plan_limits),
  'free:500/3/desktop_sync pro:null/null/desktop_sync,hud,reports_full,analysis,learn,solver_unlimited,nodelock',
  'Free: 500 hands and 3 flops a day, desktop sync; Pro: unlimited, every feature');

select throws_ok($$ update public.plan_limits set features = array['tiling'] where plan = 'free' $$, '23514', null,
  'features stay in the fixed set (tiling and the RNG are never a feature)');
select lives_ok($$ insert into public.entitlement_gates (function_sig, feature) values ('public.x()', 'nodelock');
                   delete from public.entitlement_gates where function_sig = 'public.x()' $$,
  'a gate may name the new features');

select ok(has_function_privilege('authenticated', 'public.solver_open_flop(text)', 'execute')
          and has_function_privilege('authenticated', 'public.solver_flops_today()', 'execute')
          and not has_function_privilege('anon', 'public.solver_open_flop(text)', 'execute')
          and not has_function_privilege('anon', 'public.solver_flops_today()', 'execute'),
  'the solver''s flop functions: signed-in callers only');
select ok(not has_function_privilege('authenticated', 'public.solver_flop_key(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_plan_limits(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_day_resets_at()', 'execute')
          and not has_table_privilege('authenticated', 'public.solver_flop_claims', 'insert, update, delete')
          and not has_table_privilege('authenticated', 'public.hand_daily_counts', 'insert, update, delete')
          and not has_table_privilege('anon', 'public.solver_flop_claims', 'select')
          and not has_table_privilege('anon', 'public.hand_daily_counts', 'select'),
  'the helpers and the counters'' writes are internal');
select ok((select relrowsecurity from pg_class where oid = 'public.solver_flop_claims'::regclass)
          and (select relrowsecurity from pg_class where oid = 'public.hand_daily_counts'::regclass),
  'both counters have RLS');

-- ------------------------------------------------------------ flop keys --

select is((select array_agg(coalesce(public.solver_flop_key(x), '-') order by o)
             from unnest(array['Ks7d2c', '2c 7d Ks', 'ks7D2C', 'Ks,7d,2c', 'AdAhAs', '7c7s7h', 'TsJsQs']) with ordinality u(x, o)),
  array['Ks7d2c', 'Ks7d2c', 'Ks7d2c', 'Ks7d2c', 'AsAhAd', '7s7h7c', 'QsJsTs'],
  'a flop key: rank descending, then suit s h d c, whatever the order and case');
select is((select array_agg(coalesce(public.solver_flop_key(x), '-') order by o)
             from unnest(array['Ks7d', 'Ks7d2c3h', 'Kx7d2c', '1s7d2c', '10s9s8s', 'KsKs2c', '', null]) with ordinality u(x, o)),
  array['-', '-', '-', '-', '-', '-', '-', '-'],
  '... and none for anything that is not three distinct cards');

-- ---------------------------------------------------- enforcement is off --

select pg_temp.act_as('00000000-0000-0000-0000-00000071f001');
select is((select array_agg(pg_temp.open(f) order by f) from unnest(array['Ks7d2c', 'AsAhAd', 'QsJsTs', '9h8h7h', '2c3d4s']) f),
  array['true/4s3d2c/null/', 'true/9h8h7h/null/', 'true/AsAhAd/null/', 'true/Ks7d2c/null/', 'true/QsJsTs/null/'],
  'off: a Free account opens every flop, no cap, nothing recorded');
select is((select count(*)::int from public.solver_flop_claims), 0, '... no claim was stored');
select is(public.solver_flops_today(), jsonb_build_object('flops', '[]'::jsonb, 'cap', null, 'resetsAt', pg_temp.resets_at()),
  'off: solver_flops_today says no cap');
select throws_ok($$ select public.solver_open_flop('Kx7d2c') $$, '22023', 'Not a flop.', 'a flop that is not one is refused');

select is(public.my_entitlements() -> 'limits',
  jsonb_build_object('freeHandCap', 10000, 'dailyHandCap', null, 'dailyFlopCap', null),
  'off: my_entitlements has no daily caps');
select is(public.my_entitlements() -> 'usage',
  jsonb_build_object('handsStored', 0, 'handsToday', 0, 'flopsToday', '[]'::jsonb, 'dayResetsAt', pg_temp.resets_at()),
  '... and its usage carries today''s hands, today''s flops and the next reset');
select is((select array_agg(k order by k) from jsonb_object_keys(public.my_entitlements()) k),
  array['checkedAt', 'enforced', 'features', 'graceUntil', 'limits', 'offlineGraceDays', 'plan', 'reason',
        'subscription', 'usage', 'validUntil'],
  'my_entitlements'' keys (no earlyUser)');

select pg_temp.as_postgres();
update public.plan_limits set daily_hand_cap = 3 where plan = 'free';
select pg_temp.act_as('00000000-0000-0000-0000-00000071f001');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 5)) $$, 'off: a Free account saves past the day''s cap');
select is((select count(*)::int from public.hand_daily_counts), 0, '... and nothing is counted');

select pg_temp.act_as_anon();
select throws_ok($$ select public.solver_open_flop('Ks7d2c') $$, '42501', null, 'anon: solver_open_flop refused');
select throws_ok($$ select public.solver_flops_today() $$, '42501', null, 'anon: solver_flops_today refused');

-- ----------------------------------------------- enforcement on: flops --

select pg_temp.as_postgres();
update public.billing_settings set enforcement_enabled = true;
select public.billing_set_plan('00000000-0000-0000-0000-00000071a001', 'pro', 'half_year', 'active', now() + interval '100 days');

select pg_temp.act_as('00000000-0000-0000-0000-00000071f001');
select is(pg_temp.open('2c 7d Ks'), 'true/Ks7d2c/3/Ks7d2c', 'on, Free: the first flop is recorded (canonical)');
select is(pg_temp.open('ks7d2C'), 'true/Ks7d2c/3/Ks7d2c', 're-opening it is free: still one');
select is(pg_temp.open('AdAhAs'), 'true/AsAhAd/3/Ks7d2c,AsAhAd', 'the second');
select is(pg_temp.open('QsJsTs'), 'true/QsJsTs/3/Ks7d2c,AsAhAd,QsJsTs', 'the third');
select is(pg_temp.open('9h8h7h'), 'false/9h8h7h/3/Ks7d2c,AsAhAd,QsJsTs', 'a fourth distinct flop is refused');
select is(pg_temp.open('AsAhAd'), 'true/AsAhAd/3/Ks7d2c,AsAhAd,QsJsTs', '... one of today''s stays open');
select is((select (e - 'flops') || jsonb_build_object('n', jsonb_array_length(e -> 'flops')) from public.solver_open_flop('9h8h7h') e),
  jsonb_build_object('allowed', false, 'flop', '9h8h7h', 'cap', 3, 'resetsAt', pg_temp.resets_at(), 'n', 3),
  'the answer''s shape: allowed, flop, flops, cap, resetsAt');
select is(public.solver_flops_today(),
  jsonb_build_object('flops', jsonb_build_array('Ks7d2c', 'AsAhAd', 'QsJsTs'), 'cap', 3, 'resetsAt', pg_temp.resets_at()),
  'solver_flops_today: today''s flops and the cap, claiming nothing');
select is(public.my_entitlements() -> 'usage' -> 'flopsToday', jsonb_build_array('Ks7d2c', 'AsAhAd', 'QsJsTs'),
  'my_entitlements: usage.flopsToday');
select is((select count(*)::int from public.solver_flop_claims), 3, 'the account reads its own claims');

select pg_temp.act_as('00000000-0000-0000-0000-00000071f002');
select is((select count(*)::int from public.solver_flop_claims), 0, '... and nobody else''s');
select is(pg_temp.open('9h8h7h'), 'true/9h8h7h/3/9h8h7h', 'another Free account has its own three');

-- The next day.
select pg_temp.as_postgres();
update public.solver_flop_claims set day = day - 1 where owner_id = '00000000-0000-0000-0000-00000071f001';
select pg_temp.act_as('00000000-0000-0000-0000-00000071f001');
select is(public.solver_flops_today() -> 'flops', '[]'::jsonb, 'the next day: no flop of yesterday counts');
select is(pg_temp.open('9h8h7h'), 'true/9h8h7h/3/9h8h7h', '... a new flop opens');
select pg_temp.as_postgres();
select is((select count(*)::int from public.solver_flop_claims where owner_id = '00000000-0000-0000-0000-00000071f001'), 1,
  '... and yesterday''s claims are pruned');

select pg_temp.act_as('00000000-0000-0000-0000-00000071a001');
select is((select array_agg(pg_temp.open(f) order by f) from unnest(array['Ks7d2c', 'AsAhAd', 'QsJsTs', '9h8h7h']) f),
  array['true/9h8h7h/null/', 'true/AsAhAd/null/', 'true/Ks7d2c/null/', 'true/QsJsTs/null/'],
  'on, Pro: every flop, no cap');
select pg_temp.as_postgres();
select is((select count(*)::int from public.solver_flop_claims where owner_id = '00000000-0000-0000-0000-00000071a001'), 0,
  '... nothing recorded');

-- ------------------------------------------- enforcement on: the day's hands --

select pg_temp.act_as('00000000-0000-0000-0000-00000071f002');
select is(public.my_entitlements() -> 'limits', jsonb_build_object('freeHandCap', 10000, 'dailyHandCap', 3, 'dailyFlopCap', 3),
  'on, Free: my_entitlements has the daily caps');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 2)) $$, 'two hands today: under the day''s cap (3)');
select is((public.my_entitlements() -> 'usage' ->> 'handsToday')::int, 2, 'usage.handsToday: two');
select is(pg_temp.refusal($$ select public.save_hands(pg_temp.webs(3, 4)) $$), 'PT402:daily_cap',
  'two more would make four today: refused');
select is(pg_temp.refusal_detail($$ select public.save_hands(pg_temp.webs(3, 4)) $$),
  jsonb_build_object('cap', 3, 'savedToday', 2, 'attempted', 2, 'resetsAt', pg_temp.resets_at()),
  '... the detail: cap, saved today, attempted, the reset');
select is((select count(*)::int from public.hands where owner_id = auth.uid()), 2, '... the statement whole: still two');
select is((public.my_entitlements() -> 'usage' ->> 'handsToday')::int, 2, '... and the count is not bumped');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 3)) $$, 'two old and one new: only the new one counts');
select is((public.my_entitlements() -> 'usage' ->> 'handsToday')::int, 3, '... three today');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 3)) $$, 'all duplicates at the cap: nothing counted, nothing refused');
select is(pg_temp.refusal($$ insert into public.hands (owner_id, hand_key, phf, standard_text, site, game_format,
                                 currency, currency_minor_units, small_blind, big_blind, played_at, origin)
                               values (auth.uid(), 'weplay:direct', pg_temp.phf('direct'), 'Poker Hand #direct',
                                       'weplay', 'cash', 'USD', 100, 50, 100, now(), 'web') $$),
  'PT402:daily_cap', 'a direct insert is refused too');
select is(pg_temp.refusal($$ select public.ingest_hands(public.register_hand_source('00000000-0000-0000-0000-0000007100d1', 'f1'),
                                                        jsonb_build_array(pg_temp.row('d1'))) $$),
  'PT402:daily_cap', '... and the desktop''s sync (web and desktop share the day)');

select pg_temp.as_postgres();
update public.hand_daily_counts set day = day - 1 where owner_id = '00000000-0000-0000-0000-00000071f002';
select pg_temp.act_as('00000000-0000-0000-0000-00000071f002');
select is((public.my_entitlements() -> 'usage' ->> 'handsToday')::int, 0, 'the next day: nothing saved today');
select lives_ok($$ select public.ingest_hands(public.register_hand_source('00000000-0000-0000-0000-0000007100d1', 'f1'),
                                              jsonb_build_array(pg_temp.row('d1'))) $$,
  '... the desktop''s sync goes through (desktop sync is free)');
select is((public.my_entitlements() -> 'usage' ->> 'handsToday')::int, 1, '... one today');

select pg_temp.act_as('00000000-0000-0000-0000-00000071a001');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 6)) $$, 'on, Pro: past the Free day''s cap');
select is(public.my_entitlements() -> 'usage' -> 'handsToday', '6'::jsonb, '... counted all the same');
select is(public.my_entitlements() #>> '{subscription,period}', 'half_year', 'half_year is a plan period');

-- ------------------------------------------------------------ half year --

select pg_temp.as_postgres();
select public.billing_set_customer('00000000-0000-0000-0000-00000071f001', 'cus_ft1');
select is(public.billing_apply_subscription('evt_ft_half', 'customer.subscription.created', now(), 'cus_ft1', 'sub_ft1',
                                            'pro', 'half_year', 'active', now() + interval '180 days'),
  'applied', 'the webhook applies a half-year subscription ...');
select is((select plan || '/' || plan_period from public.profiles where id = '00000000-0000-0000-0000-00000071f001'),
  'pro/half_year', '... and the profile holds the half-year period');
select lives_ok($$ select public.billing_record_consent('00000000-0000-0000-0000-00000071a001',
                     array['terms', 'immediate_performance'], 'draft-x', repeat('a', 64), '2026-10-26', repeat('b', 64),
                     'en', 'half_year') $$,
  'a consent may name the half-year period');

-- Off again: nothing refused.
update public.billing_settings set enforcement_enabled = false;
select pg_temp.act_as('00000000-0000-0000-0000-00000071f002');
select lives_ok($$ select public.save_hands(pg_temp.webs(10, 20)) $$, 'off again: the day''s cap is not checked');

select * from finish();
rollback;

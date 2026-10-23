-- pgTAP: the played preflop decisions a user's chart is compared with (R5.3)
-- -- `20270811100000_preflop_charts_compare.sql`.
--
-- What has to hold:
--
--   * security: the two played tables are select-own with no client write
--     and nothing for `anon`; the trigger functions and the rebuild are
--     definer and executable by no client role; the readers are invoker
--     with an empty search_path, executable by `authenticated`, not `anon`;
--   * the situation key of a shipped line is the TypeScript's
--     (`packages/ui/charts/nodeKey.ts`; the cases between the KEY CASES
--     markers are `tests/test/preflopCharts.test.ts`' answers, checked
--     there); the class index is the shipped order;
--   * the played rows: one per preflop chart decision, keyed, with its class,
--     action (an all-in raise is `allin`), table and depth step; none for a
--     heuristic, postflop or straddled decision; the totals equal the rows
--     after inserts, a deleted hand, a pruned decision, and a rebuild;
--     `preflop_chart_played` over all time and a window, inside the chart's
--     game; examples newest first, inside the game; the session reader under
--     the shared filter and the review's hand rows;
--   * one account never reads another's; a deleted account leaves nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(42);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000c53a1', 'charts.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000c53b1', 'charts.b@example.com', now(), now());

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

-- 169 percents as stored: `p_value` at the named classes' indexes, 0 elsewhere.
create function pg_temp.b64(p_classes int[], p_value int) returns text language plpgsql as $$
declare
  v bytea := decode(repeat('00', 169), 'hex');
  c int;
begin
  foreach c in array p_classes loop
    v := set_byte(v, c, p_value);
  end loop;
  return replace(encode(v, 'base64'), E'\n', '');
end;
$$;
grant execute on function pg_temp.b64(int[], int) to authenticated;

-- Whether an insert as the current user fails with a message like the pattern.
create function pg_temp.refused(p_sql text, p_like text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlerrm like p_like;
end;
$$;
grant execute on function pg_temp.refused(text, text) to authenticated, anon;

-- Rows a statement changed, as the current user.
create function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function pg_temp.affected(text) to authenticated;

-- ---------------------------------------------------------- security --

select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('preflop_decision_rows', 'preflop_decision_totals')),
  'the two played tables exist with row level security');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('preflop_decision_rows', 'preflop_decision_totals')
     and grantee = 'anon'),
  0, '... nothing at all for anon');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('preflop_decision_rows', 'preflop_decision_totals')
     and grantee = 'authenticated' and privilege_type <> 'SELECT'),
  0, '... no client write grant');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename in ('preflop_decision_rows', 'preflop_decision_totals')
     and cmd = 'SELECT' and qual like '%auth.uid()%'),
  2, '... each readable by its owner only');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 3 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('preflop_decision_rows_on_insert', 'preflop_decision_rows_on_delete', 'preflop_decision_rows_rebuild')),
  'the two triggers and the rebuild are security definer');
select ok(
  not has_function_privilege('authenticated', 'public.preflop_decision_rows_rebuild(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.preflop_decision_rows_rebuild(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.preflop_decision_rows_on_insert()', 'execute')
  and not has_function_privilege('authenticated', 'public.preflop_decision_rows_on_delete()', 'execute'),
  '... executable by no client role');
select ok(
  (select bool_and(not p.prosecdef)
          and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and count(*) = 4
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('preflop_chart_played', 'preflop_chart_examples', 'preflop_chart_session', 'preflop_chart_review_hands')),
  'the readers are security invoker with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.preflop_chart_played(text, text, text, integer, numeric, numeric)', 'execute')
  and has_function_privilege('authenticated', 'public.preflop_chart_examples(text, text, text, integer, numeric, numeric, text, integer, text, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.preflop_chart_session(jsonb, timestamptz, timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.preflop_chart_review_hands(jsonb, uuid[])', 'execute')
  and not has_function_privilege('anon', 'public.preflop_chart_played(text, text, text, integer, numeric, numeric)', 'execute')
  and not has_function_privilege('anon', 'public.preflop_chart_examples(text, text, text, integer, numeric, numeric, text, integer, text, integer)', 'execute')
  and not has_function_privilege('anon', 'public.preflop_chart_session(jsonb, timestamptz, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.preflop_chart_review_hands(jsonb, uuid[])', 'execute'),
  '... executable by authenticated, not by anon');
select is(
  (select count(*)::int from pg_trigger
   where tgrelid = 'public.decision_analysis'::regclass
     and tgname in ('decision_analysis_preflop_rows_insert', 'decision_analysis_preflop_rows_delete')),
  2, 'decision_analysis carries the two statement triggers');

-- ------------------------------------------------------------ the key rule --

create temp table keycases (set_id text, line text, key text) on commit drop;
-- KEY CASES BEGIN (generated from packages/ui/charts/nodeKey.ts; checked by tests/test/preflopCharts.test.ts)
insert into keycases values
  ('nlhe-cash-6max-100bb', '', 'rfi:UTG'),
  ('nlhe-cash-6max-100bb', 'c', 'vs-limp:HJ:UTG'),
  ('nlhe-cash-6max-100bb', 'cc', 'vs-limp:CO:UTG'),
  ('nlhe-cash-6max-100bb', 'ccc', 'vs-limp:BTN:UTG'),
  ('nlhe-cash-6max-100bb', 'cccf', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'cccff', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'ccf', 'vs-limp:BTN:UTG'),
  ('nlhe-cash-6max-100bb', 'ccfc', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'ccfcf', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'ccff', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'ccffc', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'ccffcr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'ccffcrf', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'ccffcrff', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'ccfff', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'ccfffr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'ccfffrf', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'ccffr', null),
  ('nlhe-cash-6max-100bb', 'ccffrf', 'vs-iso:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'ccffrff', 'vs-iso:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'ccfr', null),
  ('nlhe-cash-6max-100bb', 'ccfrf', null),
  ('nlhe-cash-6max-100bb', 'ccfrff', 'vs-iso:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'ccfrffc', 'vs-iso:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'ccfrfff', 'vs-iso:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'ccfrffr', null),
  ('nlhe-cash-6max-100bb', 'ccfrffrf', null),
  ('nlhe-cash-6max-100bb', 'ccr', null),
  ('nlhe-cash-6max-100bb', 'ccrf', null),
  ('nlhe-cash-6max-100bb', 'ccrff', null),
  ('nlhe-cash-6max-100bb', 'ccrfff', 'vs-iso:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'ccrfffc', 'vs-iso:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'ccrffff', 'vs-iso:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'ccrfffr', null),
  ('nlhe-cash-6max-100bb', 'ccrfffrf', null),
  ('nlhe-cash-6max-100bb', 'cf', 'vs-limp:CO:UTG'),
  ('nlhe-cash-6max-100bb', 'cfc', 'vs-limp:BTN:UTG'),
  ('nlhe-cash-6max-100bb', 'cfcc', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfccf', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfcf', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfcfc', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfcfcr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'cfcfcrc', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'cfcfcrcf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cfcfcrf', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'cfcfcrfc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cfcfcrff', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cfcff', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfcffr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'cfcffrc', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'cfcffrf', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'cfcfr', null),
  ('nlhe-cash-6max-100bb', 'cfcfrf', 'vs-iso:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'cfcfrfc', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'cfcfrff', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'cfcfrfr', null),
  ('nlhe-cash-6max-100bb', 'cfcfrfrf', null),
  ('nlhe-cash-6max-100bb', 'cfcr', null),
  ('nlhe-cash-6max-100bb', 'cfcrf', null),
  ('nlhe-cash-6max-100bb', 'cfcrfc', 'vs-iso:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'cfcrff', 'vs-iso:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'cfcrffc', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'cfcrfff', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'cfcrffr', null),
  ('nlhe-cash-6max-100bb', 'cfcrffrf', null),
  ('nlhe-cash-6max-100bb', 'cfcrrf', null),
  ('nlhe-cash-6max-100bb', 'cff', 'vs-limp:BTN:UTG'),
  ('nlhe-cash-6max-100bb', 'cffc', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'cffcc', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cffccr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'cffccrc', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'cffccrcf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cffccrf', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'cffccrfc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cffccrff', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cffccrr', null),
  ('nlhe-cash-6max-100bb', 'cffccrrf', null),
  ('nlhe-cash-6max-100bb', 'cffccrrff', null),
  ('nlhe-cash-6max-100bb', 'cffcf', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cffcfr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'cffcfrc', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'cffcfrf', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'cffcfrr', null),
  ('nlhe-cash-6max-100bb', 'cffcfrrf', null),
  ('nlhe-cash-6max-100bb', 'cffcr', null),
  ('nlhe-cash-6max-100bb', 'cffcrc', 'vs-iso:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'cffcrcf', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'cffcrf', 'vs-iso:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'cffcrfc', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'cffcrff', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'cffcrfr', null),
  ('nlhe-cash-6max-100bb', 'cffcrfrf', null),
  ('nlhe-cash-6max-100bb', 'cffcrfrfa', null),
  ('nlhe-cash-6max-100bb', 'cffcrr', null),
  ('nlhe-cash-6max-100bb', 'cffcrrf', null),
  ('nlhe-cash-6max-100bb', 'cffcrrff', null),
  ('nlhe-cash-6max-100bb', 'cfff', 'vs-limp:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfffc', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cfffcr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'cfffcrc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cfffcrf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'cfffcrr', null),
  ('nlhe-cash-6max-100bb', 'cfffcrrf', null),
  ('nlhe-cash-6max-100bb', 'cfffcrrfa', null),
  ('nlhe-cash-6max-100bb', 'cffff', 'vs-limp:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'cffffr', 'vs-iso:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'cfffr', null),
  ('nlhe-cash-6max-100bb', 'cfffrc', 'vs-iso:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'cfffrcr', null),
  ('nlhe-cash-6max-100bb', 'cfffrcrf', null),
  ('nlhe-cash-6max-100bb', 'cfffrf', 'vs-iso:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'cfffrfr', null),
  ('nlhe-cash-6max-100bb', 'cfffrfra', null),
  ('nlhe-cash-6max-100bb', 'cfffrr', null),
  ('nlhe-cash-6max-100bb', 'cfffrrf', null),
  ('nlhe-cash-6max-100bb', 'cffr', null),
  ('nlhe-cash-6max-100bb', 'cffrc', null),
  ('nlhe-cash-6max-100bb', 'cffrcf', 'vs-iso:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'cffrcfr', null),
  ('nlhe-cash-6max-100bb', 'cffrcfrf', null),
  ('nlhe-cash-6max-100bb', 'cffrf', null),
  ('nlhe-cash-6max-100bb', 'cffrfc', 'vs-iso:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'cffrfcr', null),
  ('nlhe-cash-6max-100bb', 'cffrfcrf', null),
  ('nlhe-cash-6max-100bb', 'cffrff', 'vs-iso:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'cffrffr', null),
  ('nlhe-cash-6max-100bb', 'cffrffra', null),
  ('nlhe-cash-6max-100bb', 'cffrfr', null),
  ('nlhe-cash-6max-100bb', 'cffrfra', null),
  ('nlhe-cash-6max-100bb', 'cffrfraf', null),
  ('nlhe-cash-6max-100bb', 'cffrfrc', null),
  ('nlhe-cash-6max-100bb', 'cffrfrf', null),
  ('nlhe-cash-6max-100bb', 'cffrfrfa', null),
  ('nlhe-cash-6max-100bb', 'cffrr', null),
  ('nlhe-cash-6max-100bb', 'cffrrf', null),
  ('nlhe-cash-6max-100bb', 'cffrrfa', null),
  ('nlhe-cash-6max-100bb', 'cffrrfaf', null),
  ('nlhe-cash-6max-100bb', 'cffrrfc', null),
  ('nlhe-cash-6max-100bb', 'cffrrff', null),
  ('nlhe-cash-6max-100bb', 'cffrrffa', null),
  ('nlhe-cash-6max-100bb', 'cfr', null),
  ('nlhe-cash-6max-100bb', 'cfrc', null),
  ('nlhe-cash-6max-100bb', 'cfrcf', null),
  ('nlhe-cash-6max-100bb', 'cfrcff', 'vs-iso:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'cfrcffr', null),
  ('nlhe-cash-6max-100bb', 'cfrcffrf', null),
  ('nlhe-cash-6max-100bb', 'cfrf', null),
  ('nlhe-cash-6max-100bb', 'cfrfc', null),
  ('nlhe-cash-6max-100bb', 'cfrfcf', 'vs-iso:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'cfrfcfr', null),
  ('nlhe-cash-6max-100bb', 'cfrfcfrf', null),
  ('nlhe-cash-6max-100bb', 'cfrff', null),
  ('nlhe-cash-6max-100bb', 'cfrffc', 'vs-iso:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'cfrffcr', null),
  ('nlhe-cash-6max-100bb', 'cfrffcrf', null),
  ('nlhe-cash-6max-100bb', 'cfrfff', 'vs-iso:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'cfrfffr', null),
  ('nlhe-cash-6max-100bb', 'cfrfffra', null),
  ('nlhe-cash-6max-100bb', 'cfrffr', null),
  ('nlhe-cash-6max-100bb', 'cfrffra', null),
  ('nlhe-cash-6max-100bb', 'cfrffraf', null),
  ('nlhe-cash-6max-100bb', 'cfrffrc', null),
  ('nlhe-cash-6max-100bb', 'cfrffrf', null),
  ('nlhe-cash-6max-100bb', 'cfrffrfa', null),
  ('nlhe-cash-6max-100bb', 'cfrfr', null),
  ('nlhe-cash-6max-100bb', 'cfrfrf', null),
  ('nlhe-cash-6max-100bb', 'cfrfrfa', null),
  ('nlhe-cash-6max-100bb', 'cfrfrfaf', null),
  ('nlhe-cash-6max-100bb', 'cfrfrfc', null),
  ('nlhe-cash-6max-100bb', 'cfrfrff', null),
  ('nlhe-cash-6max-100bb', 'cfrfrffa', null),
  ('nlhe-cash-6max-100bb', 'cfrr', null),
  ('nlhe-cash-6max-100bb', 'cfrrf', null),
  ('nlhe-cash-6max-100bb', 'cfrrff', null),
  ('nlhe-cash-6max-100bb', 'cfrrffa', null),
  ('nlhe-cash-6max-100bb', 'cfrrffaf', null),
  ('nlhe-cash-6max-100bb', 'cfrrffc', null),
  ('nlhe-cash-6max-100bb', 'cfrrfff', null),
  ('nlhe-cash-6max-100bb', 'cfrrfffa', null),
  ('nlhe-cash-6max-100bb', 'cr', null),
  ('nlhe-cash-6max-100bb', 'crc', null),
  ('nlhe-cash-6max-100bb', 'crcf', null),
  ('nlhe-cash-6max-100bb', 'crcff', null),
  ('nlhe-cash-6max-100bb', 'crcfff', 'vs-iso:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'crcfffr', null),
  ('nlhe-cash-6max-100bb', 'crcfffrf', null),
  ('nlhe-cash-6max-100bb', 'crf', null),
  ('nlhe-cash-6max-100bb', 'crfc', null),
  ('nlhe-cash-6max-100bb', 'crfcf', null),
  ('nlhe-cash-6max-100bb', 'crfcff', 'vs-iso:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'crfcffr', null),
  ('nlhe-cash-6max-100bb', 'crfcffrf', null),
  ('nlhe-cash-6max-100bb', 'crff', null),
  ('nlhe-cash-6max-100bb', 'crffc', null),
  ('nlhe-cash-6max-100bb', 'crffcf', 'vs-iso:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'crffcfr', null),
  ('nlhe-cash-6max-100bb', 'crfff', null),
  ('nlhe-cash-6max-100bb', 'crfffc', 'vs-iso:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'crfffcr', null),
  ('nlhe-cash-6max-100bb', 'crfffcrf', null),
  ('nlhe-cash-6max-100bb', 'crffff', 'vs-iso:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'crffffr', null),
  ('nlhe-cash-6max-100bb', 'crffffra', null),
  ('nlhe-cash-6max-100bb', 'crfffr', null),
  ('nlhe-cash-6max-100bb', 'crfffra', null),
  ('nlhe-cash-6max-100bb', 'crfffraf', null),
  ('nlhe-cash-6max-100bb', 'crfffrc', null),
  ('nlhe-cash-6max-100bb', 'crfffrf', null),
  ('nlhe-cash-6max-100bb', 'crfffrfa', null),
  ('nlhe-cash-6max-100bb', 'crffr', null),
  ('nlhe-cash-6max-100bb', 'crffrf', null),
  ('nlhe-cash-6max-100bb', 'crffrfa', null),
  ('nlhe-cash-6max-100bb', 'crffrfaf', null),
  ('nlhe-cash-6max-100bb', 'crffrfc', null),
  ('nlhe-cash-6max-100bb', 'crffrff', null),
  ('nlhe-cash-6max-100bb', 'crffrffa', null),
  ('nlhe-cash-6max-100bb', 'crfr', null),
  ('nlhe-cash-6max-100bb', 'crfrf', null),
  ('nlhe-cash-6max-100bb', 'crfrff', null),
  ('nlhe-cash-6max-100bb', 'crfrffa', null),
  ('nlhe-cash-6max-100bb', 'crfrffaf', null),
  ('nlhe-cash-6max-100bb', 'crfrffc', null),
  ('nlhe-cash-6max-100bb', 'crfrfff', null),
  ('nlhe-cash-6max-100bb', 'crfrfffa', null),
  ('nlhe-cash-6max-100bb', 'crr', null),
  ('nlhe-cash-6max-100bb', 'crrf', null),
  ('nlhe-cash-6max-100bb', 'crrff', null),
  ('nlhe-cash-6max-100bb', 'crrfff', null),
  ('nlhe-cash-6max-100bb', 'crrfffa', null),
  ('nlhe-cash-6max-100bb', 'crrfffaf', null),
  ('nlhe-cash-6max-100bb', 'crrfffc', null),
  ('nlhe-cash-6max-100bb', 'crrffff', null),
  ('nlhe-cash-6max-100bb', 'crrffffa', null),
  ('nlhe-cash-6max-100bb', 'f', 'rfi:HJ'),
  ('nlhe-cash-6max-100bb', 'fc', 'vs-limp:CO:HJ'),
  ('nlhe-cash-6max-100bb', 'fcc', 'vs-limp:BTN:HJ'),
  ('nlhe-cash-6max-100bb', 'fccc', 'vs-limp:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcccf', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fccf', 'vs-limp:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'fccfc', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fccfcr', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'fccfcrf', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'fccfcrff', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fccff', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fccffr', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'fccffrc', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'fccffrf', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'fccfr', null),
  ('nlhe-cash-6max-100bb', 'fccfrf', 'vs-iso:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'fccfrfc', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'fccfrff', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'fccr', null),
  ('nlhe-cash-6max-100bb', 'fccrf', null),
  ('nlhe-cash-6max-100bb', 'fccrff', 'vs-iso:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'fccrffc', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'fccrfff', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'fccrffr', null),
  ('nlhe-cash-6max-100bb', 'fccrffrf', null),
  ('nlhe-cash-6max-100bb', 'fcf', 'vs-limp:BTN:HJ'),
  ('nlhe-cash-6max-100bb', 'fcfc', 'vs-limp:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcfcc', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcfccr', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'fcfccrc', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fcfccrcf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fcfccrf', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fcfccrfc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fcfccrff', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fcfccrr', null),
  ('nlhe-cash-6max-100bb', 'fcfccrrf', null),
  ('nlhe-cash-6max-100bb', 'fcfccrrff', null),
  ('nlhe-cash-6max-100bb', 'fcfcf', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcfcfr', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'fcfcfrc', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fcfcfrf', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fcfcfrr', null),
  ('nlhe-cash-6max-100bb', 'fcfcfrrf', null),
  ('nlhe-cash-6max-100bb', 'fcfcr', null),
  ('nlhe-cash-6max-100bb', 'fcfcrc', 'vs-iso:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'fcfcrcf', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fcfcrf', 'vs-iso:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'fcfcrfc', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fcfcrff', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fcfcrfr', null),
  ('nlhe-cash-6max-100bb', 'fcfcrfrf', null),
  ('nlhe-cash-6max-100bb', 'fcfcrr', null),
  ('nlhe-cash-6max-100bb', 'fcfcrrf', null),
  ('nlhe-cash-6max-100bb', 'fcfcrrff', null),
  ('nlhe-cash-6max-100bb', 'fcff', 'vs-limp:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcffc', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcffcr', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'fcffcrc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fcffcrf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fcffcrr', null),
  ('nlhe-cash-6max-100bb', 'fcffcrrf', null),
  ('nlhe-cash-6max-100bb', 'fcffcrrfa', null),
  ('nlhe-cash-6max-100bb', 'fcfff', 'vs-limp:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'fcfffr', 'vs-iso:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'fcffr', null),
  ('nlhe-cash-6max-100bb', 'fcffrc', 'vs-iso:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'fcffrcr', null),
  ('nlhe-cash-6max-100bb', 'fcffrcrf', null),
  ('nlhe-cash-6max-100bb', 'fcffrf', 'vs-iso:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'fcffrfr', null),
  ('nlhe-cash-6max-100bb', 'fcffrfra', null),
  ('nlhe-cash-6max-100bb', 'fcffrr', null),
  ('nlhe-cash-6max-100bb', 'fcffrrf', null),
  ('nlhe-cash-6max-100bb', 'fcffrrfa', null),
  ('nlhe-cash-6max-100bb', 'fcfr', null),
  ('nlhe-cash-6max-100bb', 'fcfrc', null),
  ('nlhe-cash-6max-100bb', 'fcfrcf', 'vs-iso:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'fcfrcfr', null),
  ('nlhe-cash-6max-100bb', 'fcfrcfrf', null),
  ('nlhe-cash-6max-100bb', 'fcfrf', null),
  ('nlhe-cash-6max-100bb', 'fcfrfc', 'vs-iso:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'fcfrfcr', null),
  ('nlhe-cash-6max-100bb', 'fcfrfcrf', null),
  ('nlhe-cash-6max-100bb', 'fcfrff', 'vs-iso:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'fcfrffr', null),
  ('nlhe-cash-6max-100bb', 'fcfrffra', null),
  ('nlhe-cash-6max-100bb', 'fcfrfr', null),
  ('nlhe-cash-6max-100bb', 'fcfrfra', null),
  ('nlhe-cash-6max-100bb', 'fcfrfraf', null),
  ('nlhe-cash-6max-100bb', 'fcfrfrc', null),
  ('nlhe-cash-6max-100bb', 'fcfrfrf', null),
  ('nlhe-cash-6max-100bb', 'fcfrfrfa', null),
  ('nlhe-cash-6max-100bb', 'fcfrr', null),
  ('nlhe-cash-6max-100bb', 'fcfrrf', null),
  ('nlhe-cash-6max-100bb', 'fcfrrfa', null),
  ('nlhe-cash-6max-100bb', 'fcfrrfaf', null),
  ('nlhe-cash-6max-100bb', 'fcfrrfc', null),
  ('nlhe-cash-6max-100bb', 'fcfrrff', null),
  ('nlhe-cash-6max-100bb', 'fcfrrffa', null),
  ('nlhe-cash-6max-100bb', 'fcr', null),
  ('nlhe-cash-6max-100bb', 'fcrc', null),
  ('nlhe-cash-6max-100bb', 'fcrcf', null),
  ('nlhe-cash-6max-100bb', 'fcrcff', 'vs-iso:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'fcrcffr', null),
  ('nlhe-cash-6max-100bb', 'fcrcffrf', null),
  ('nlhe-cash-6max-100bb', 'fcrcfr', null),
  ('nlhe-cash-6max-100bb', 'fcrcfrf', null),
  ('nlhe-cash-6max-100bb', 'fcrcrf', null),
  ('nlhe-cash-6max-100bb', 'fcrcrff', null),
  ('nlhe-cash-6max-100bb', 'fcrf', null),
  ('nlhe-cash-6max-100bb', 'fcrfc', null),
  ('nlhe-cash-6max-100bb', 'fcrfcf', 'vs-iso:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'fcrfcfr', null),
  ('nlhe-cash-6max-100bb', 'fcrfcfrf', null),
  ('nlhe-cash-6max-100bb', 'fcrff', null),
  ('nlhe-cash-6max-100bb', 'fcrffc', 'vs-iso:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'fcrffcr', null),
  ('nlhe-cash-6max-100bb', 'fcrffcrf', null),
  ('nlhe-cash-6max-100bb', 'fcrfff', 'vs-iso:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'fcrfffr', null),
  ('nlhe-cash-6max-100bb', 'fcrfffra', null),
  ('nlhe-cash-6max-100bb', 'fcrffr', null),
  ('nlhe-cash-6max-100bb', 'fcrffra', null),
  ('nlhe-cash-6max-100bb', 'fcrffraf', null),
  ('nlhe-cash-6max-100bb', 'fcrffrc', null),
  ('nlhe-cash-6max-100bb', 'fcrffrf', null),
  ('nlhe-cash-6max-100bb', 'fcrffrfa', null),
  ('nlhe-cash-6max-100bb', 'fcrfr', null),
  ('nlhe-cash-6max-100bb', 'fcrfrf', null),
  ('nlhe-cash-6max-100bb', 'fcrfrfa', null),
  ('nlhe-cash-6max-100bb', 'fcrfrfaf', null),
  ('nlhe-cash-6max-100bb', 'fcrfrfc', null),
  ('nlhe-cash-6max-100bb', 'fcrfrff', null),
  ('nlhe-cash-6max-100bb', 'fcrfrffa', null),
  ('nlhe-cash-6max-100bb', 'fcrr', null),
  ('nlhe-cash-6max-100bb', 'fcrrf', null),
  ('nlhe-cash-6max-100bb', 'fcrrff', null),
  ('nlhe-cash-6max-100bb', 'fcrrffa', null),
  ('nlhe-cash-6max-100bb', 'fcrrffaf', null),
  ('nlhe-cash-6max-100bb', 'fcrrffc', null),
  ('nlhe-cash-6max-100bb', 'fcrrfff', null),
  ('nlhe-cash-6max-100bb', 'fcrrfffa', null),
  ('nlhe-cash-6max-100bb', 'ff', 'rfi:CO'),
  ('nlhe-cash-6max-100bb', 'ffc', 'vs-limp:BTN:CO'),
  ('nlhe-cash-6max-100bb', 'ffcc', 'vs-limp:SB:CO'),
  ('nlhe-cash-6max-100bb', 'ffccc', 'vs-limp:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffcccr', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'ffcccrc', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'ffcccrf', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'ffcccrff', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'ffcccrr', null),
  ('nlhe-cash-6max-100bb', 'ffcccrrf', null),
  ('nlhe-cash-6max-100bb', 'ffcccrrff', null),
  ('nlhe-cash-6max-100bb', 'ffccf', 'vs-limp:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffccfr', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'ffccfrc', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'ffccfrf', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'ffccfrr', null),
  ('nlhe-cash-6max-100bb', 'ffccfrrf', null),
  ('nlhe-cash-6max-100bb', 'ffccr', null),
  ('nlhe-cash-6max-100bb', 'ffccrc', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'ffccrf', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'ffccrfc', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'ffccrff', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'ffccrfr', null),
  ('nlhe-cash-6max-100bb', 'ffccrfrf', null),
  ('nlhe-cash-6max-100bb', 'ffcf', 'vs-limp:SB:CO'),
  ('nlhe-cash-6max-100bb', 'ffcfc', 'vs-limp:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffcfcr', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'ffcfcrc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'ffcfcrf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'ffcfcrr', null),
  ('nlhe-cash-6max-100bb', 'ffcfcrrf', null),
  ('nlhe-cash-6max-100bb', 'ffcfcrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffcff', 'vs-limp:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffcffr', 'vs-iso:CO:BB'),
  ('nlhe-cash-6max-100bb', 'ffcffrra', null),
  ('nlhe-cash-6max-100bb', 'ffcfr', null),
  ('nlhe-cash-6max-100bb', 'ffcfrc', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'ffcfrcr', null),
  ('nlhe-cash-6max-100bb', 'ffcfrcrf', null),
  ('nlhe-cash-6max-100bb', 'ffcfrf', 'vs-iso:CO:SB'),
  ('nlhe-cash-6max-100bb', 'ffcfrfr', null),
  ('nlhe-cash-6max-100bb', 'ffcfrfra', null),
  ('nlhe-cash-6max-100bb', 'ffcfrr', null),
  ('nlhe-cash-6max-100bb', 'ffcfrrf', null),
  ('nlhe-cash-6max-100bb', 'ffcfrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffcr', null),
  ('nlhe-cash-6max-100bb', 'ffcrc', null),
  ('nlhe-cash-6max-100bb', 'ffcrcf', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'ffcrcfr', null),
  ('nlhe-cash-6max-100bb', 'ffcrcfrf', null),
  ('nlhe-cash-6max-100bb', 'ffcrf', null),
  ('nlhe-cash-6max-100bb', 'ffcrfc', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'ffcrfcr', null),
  ('nlhe-cash-6max-100bb', 'ffcrfcra', null),
  ('nlhe-cash-6max-100bb', 'ffcrfcraf', null),
  ('nlhe-cash-6max-100bb', 'ffcrfcrc', null),
  ('nlhe-cash-6max-100bb', 'ffcrfcrf', null),
  ('nlhe-cash-6max-100bb', 'ffcrfcrfa', null),
  ('nlhe-cash-6max-100bb', 'ffcrff', 'vs-iso:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'ffcrffr', null),
  ('nlhe-cash-6max-100bb', 'ffcrffra', null),
  ('nlhe-cash-6max-100bb', 'ffcrfr', null),
  ('nlhe-cash-6max-100bb', 'ffcrfra', null),
  ('nlhe-cash-6max-100bb', 'ffcrfraf', null),
  ('nlhe-cash-6max-100bb', 'ffcrfrc', null),
  ('nlhe-cash-6max-100bb', 'ffcrfrf', null),
  ('nlhe-cash-6max-100bb', 'ffcrfrfa', null),
  ('nlhe-cash-6max-100bb', 'ffcrr', null),
  ('nlhe-cash-6max-100bb', 'ffcrra', null),
  ('nlhe-cash-6max-100bb', 'ffcrraf', null),
  ('nlhe-cash-6max-100bb', 'ffcrraff', null),
  ('nlhe-cash-6max-100bb', 'ffcrrf', null),
  ('nlhe-cash-6max-100bb', 'ffcrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffcrrfaf', null),
  ('nlhe-cash-6max-100bb', 'ffcrrfc', null),
  ('nlhe-cash-6max-100bb', 'ffcrrff', null),
  ('nlhe-cash-6max-100bb', 'ffcrrffa', null),
  ('nlhe-cash-6max-100bb', 'fff', 'rfi:BTN'),
  ('nlhe-cash-6max-100bb', 'fffc', 'vs-limp:SB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffcc', 'vs-limp:BB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffccr', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fffccrc', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fffccrf', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fffccrr', null),
  ('nlhe-cash-6max-100bb', 'fffccrrf', null),
  ('nlhe-cash-6max-100bb', 'fffccrrfa', null),
  ('nlhe-cash-6max-100bb', 'fffcf', 'vs-limp:BB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffcfr', 'vs-iso:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fffcfrr', null),
  ('nlhe-cash-6max-100bb', 'fffcfrra', null),
  ('nlhe-cash-6max-100bb', 'fffcr', null),
  ('nlhe-cash-6max-100bb', 'fffcrc', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fffcrcr', null),
  ('nlhe-cash-6max-100bb', 'fffcrcra', null),
  ('nlhe-cash-6max-100bb', 'fffcrcraf', null),
  ('nlhe-cash-6max-100bb', 'fffcrcrf', null),
  ('nlhe-cash-6max-100bb', 'fffcrf', 'vs-iso:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fffcrfr', null),
  ('nlhe-cash-6max-100bb', 'fffcrfra', null),
  ('nlhe-cash-6max-100bb', 'fffcrr', null),
  ('nlhe-cash-6max-100bb', 'fffcrra', null),
  ('nlhe-cash-6max-100bb', 'fffcrraf', null),
  ('nlhe-cash-6max-100bb', 'fffcrrc', null),
  ('nlhe-cash-6max-100bb', 'fffcrrf', null),
  ('nlhe-cash-6max-100bb', 'fffcrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffff', 'rfi:SB'),
  ('nlhe-cash-6max-100bb', 'ffffc', 'vs-limp:BB:SB'),
  ('nlhe-cash-6max-100bb', 'ffffcr', 'vs-iso:SB:BB'),
  ('nlhe-cash-6max-100bb', 'ffffcrr', null),
  ('nlhe-cash-6max-100bb', 'ffffcrrr', null),
  ('nlhe-cash-6max-100bb', 'ffffcrrra', null),
  ('nlhe-cash-6max-100bb', 'ffffr', 'vs-open:BB:SB'),
  ('nlhe-cash-6max-100bb', 'ffffrr', 'vs-3bet:SB:BB'),
  ('nlhe-cash-6max-100bb', 'ffffrrr', 'vs-4bet:BB:SB'),
  ('nlhe-cash-6max-100bb', 'ffffrrra', 'vs-allin:SB:BB'),
  ('nlhe-cash-6max-100bb', 'fffr', 'vs-open:SB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffrc', 'squeeze:BB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffrcr', null),
  ('nlhe-cash-6max-100bb', 'fffrcrc', null),
  ('nlhe-cash-6max-100bb', 'fffrcrcr', null),
  ('nlhe-cash-6max-100bb', 'fffrcrf', null),
  ('nlhe-cash-6max-100bb', 'fffrcrfr', null),
  ('nlhe-cash-6max-100bb', 'fffrcrr', null),
  ('nlhe-cash-6max-100bb', 'fffrcrrf', null),
  ('nlhe-cash-6max-100bb', 'fffrcrrfa', null),
  ('nlhe-cash-6max-100bb', 'fffrf', 'vs-open:BB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffrfr', 'vs-3bet:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fffrfrr', 'vs-4bet:BB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffrfrra', 'vs-allin:BTN:BB'),
  ('nlhe-cash-6max-100bb', 'fffrr', null),
  ('nlhe-cash-6max-100bb', 'fffrrf', 'vs-3bet:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fffrrfr', 'vs-4bet:SB:BTN'),
  ('nlhe-cash-6max-100bb', 'fffrrfra', 'vs-allin:BTN:SB'),
  ('nlhe-cash-6max-100bb', 'fffrrr', null),
  ('nlhe-cash-6max-100bb', 'fffrrra', null),
  ('nlhe-cash-6max-100bb', 'fffrrraf', null),
  ('nlhe-cash-6max-100bb', 'fffrrrc', null),
  ('nlhe-cash-6max-100bb', 'fffrrrf', null),
  ('nlhe-cash-6max-100bb', 'fffrrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffr', 'vs-open:BTN:CO'),
  ('nlhe-cash-6max-100bb', 'ffrc', 'squeeze:SB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrcf', 'squeeze:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrf', 'vs-open:SB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrfc', 'squeeze:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrfcr', null),
  ('nlhe-cash-6max-100bb', 'ffrfcrc', null),
  ('nlhe-cash-6max-100bb', 'ffrfcrf', null),
  ('nlhe-cash-6max-100bb', 'ffrfcrr', null),
  ('nlhe-cash-6max-100bb', 'ffrfcrrf', null),
  ('nlhe-cash-6max-100bb', 'ffrfcrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffrff', 'vs-open:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrffr', 'vs-3bet:CO:BB'),
  ('nlhe-cash-6max-100bb', 'ffrffrr', 'vs-4bet:BB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrffrra', 'vs-allin:CO:BB'),
  ('nlhe-cash-6max-100bb', 'ffrfr', null),
  ('nlhe-cash-6max-100bb', 'ffrfrf', 'vs-3bet:CO:SB'),
  ('nlhe-cash-6max-100bb', 'ffrfrfr', 'vs-4bet:SB:CO'),
  ('nlhe-cash-6max-100bb', 'ffrfrfra', 'vs-allin:CO:SB'),
  ('nlhe-cash-6max-100bb', 'ffrfrr', null),
  ('nlhe-cash-6max-100bb', 'ffrfrra', null),
  ('nlhe-cash-6max-100bb', 'ffrfrraf', null),
  ('nlhe-cash-6max-100bb', 'ffrfrrf', null),
  ('nlhe-cash-6max-100bb', 'ffrfrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffrr', null),
  ('nlhe-cash-6max-100bb', 'ffrrf', null),
  ('nlhe-cash-6max-100bb', 'ffrrff', 'vs-3bet:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'ffrrffr', 'vs-4bet:BTN:CO'),
  ('nlhe-cash-6max-100bb', 'ffrrffra', 'vs-allin:CO:BTN'),
  ('nlhe-cash-6max-100bb', 'ffrrfr', null),
  ('nlhe-cash-6max-100bb', 'ffrrfra', null),
  ('nlhe-cash-6max-100bb', 'ffrrfraf', null),
  ('nlhe-cash-6max-100bb', 'ffrrfrc', null),
  ('nlhe-cash-6max-100bb', 'ffrrfrf', null),
  ('nlhe-cash-6max-100bb', 'ffrrfrfa', null),
  ('nlhe-cash-6max-100bb', 'ffrrr', null),
  ('nlhe-cash-6max-100bb', 'ffrrra', null),
  ('nlhe-cash-6max-100bb', 'ffrrraf', null),
  ('nlhe-cash-6max-100bb', 'ffrrraff', null),
  ('nlhe-cash-6max-100bb', 'ffrrrf', null),
  ('nlhe-cash-6max-100bb', 'ffrrrfa', null),
  ('nlhe-cash-6max-100bb', 'ffrrrfaf', null),
  ('nlhe-cash-6max-100bb', 'ffrrrfc', null),
  ('nlhe-cash-6max-100bb', 'ffrrrff', null),
  ('nlhe-cash-6max-100bb', 'ffrrrffa', null),
  ('nlhe-cash-6max-100bb', 'fr', 'vs-open:CO:HJ'),
  ('nlhe-cash-6max-100bb', 'frf', 'vs-open:BTN:HJ'),
  ('nlhe-cash-6max-100bb', 'frfc', 'squeeze:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'frfcc', 'squeeze:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'frfcf', 'squeeze:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'frfcfr', null),
  ('nlhe-cash-6max-100bb', 'frfcfrc', null),
  ('nlhe-cash-6max-100bb', 'frfcfrf', null),
  ('nlhe-cash-6max-100bb', 'frfcfrr', null),
  ('nlhe-cash-6max-100bb', 'frfcfrrf', null),
  ('nlhe-cash-6max-100bb', 'frfcr', null),
  ('nlhe-cash-6max-100bb', 'frfcrf', null),
  ('nlhe-cash-6max-100bb', 'frfcrfc', null),
  ('nlhe-cash-6max-100bb', 'frfcrff', null),
  ('nlhe-cash-6max-100bb', 'frfcrfr', null),
  ('nlhe-cash-6max-100bb', 'frfcrfrf', null),
  ('nlhe-cash-6max-100bb', 'frff', 'vs-open:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'frffc', 'squeeze:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'frffcr', null),
  ('nlhe-cash-6max-100bb', 'frffcrc', null),
  ('nlhe-cash-6max-100bb', 'frffcrf', null),
  ('nlhe-cash-6max-100bb', 'frffcrr', null),
  ('nlhe-cash-6max-100bb', 'frffcrrf', null),
  ('nlhe-cash-6max-100bb', 'frffcrrfa', null),
  ('nlhe-cash-6max-100bb', 'frfff', 'vs-open:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'frfffr', 'vs-3bet:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'frfffrr', 'vs-4bet:BB:HJ'),
  ('nlhe-cash-6max-100bb', 'frfffrra', 'vs-allin:HJ:BB'),
  ('nlhe-cash-6max-100bb', 'frffr', null),
  ('nlhe-cash-6max-100bb', 'frffrf', 'vs-3bet:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'frffrfr', 'vs-4bet:SB:HJ'),
  ('nlhe-cash-6max-100bb', 'frffrfra', 'vs-allin:HJ:SB'),
  ('nlhe-cash-6max-100bb', 'frffrr', null),
  ('nlhe-cash-6max-100bb', 'frffrra', null),
  ('nlhe-cash-6max-100bb', 'frffrraf', null),
  ('nlhe-cash-6max-100bb', 'frffrrf', null),
  ('nlhe-cash-6max-100bb', 'frffrrfa', null),
  ('nlhe-cash-6max-100bb', 'frfr', null),
  ('nlhe-cash-6max-100bb', 'frfrf', null),
  ('nlhe-cash-6max-100bb', 'frfrff', 'vs-3bet:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'frfrffr', 'vs-4bet:BTN:HJ'),
  ('nlhe-cash-6max-100bb', 'frfrffra', 'vs-allin:HJ:BTN'),
  ('nlhe-cash-6max-100bb', 'frfrfr', null),
  ('nlhe-cash-6max-100bb', 'frfrfra', null),
  ('nlhe-cash-6max-100bb', 'frfrfraf', null),
  ('nlhe-cash-6max-100bb', 'frfrfrc', null),
  ('nlhe-cash-6max-100bb', 'frfrfrf', null),
  ('nlhe-cash-6max-100bb', 'frfrfrfa', null),
  ('nlhe-cash-6max-100bb', 'frfrr', null),
  ('nlhe-cash-6max-100bb', 'frfrrf', null),
  ('nlhe-cash-6max-100bb', 'frfrrfa', null),
  ('nlhe-cash-6max-100bb', 'frfrrfaf', null),
  ('nlhe-cash-6max-100bb', 'frfrrff', null),
  ('nlhe-cash-6max-100bb', 'frfrrffa', null),
  ('nlhe-cash-6max-100bb', 'frr', null),
  ('nlhe-cash-6max-100bb', 'frrf', null),
  ('nlhe-cash-6max-100bb', 'frrff', null),
  ('nlhe-cash-6max-100bb', 'frrfff', 'vs-3bet:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'frrfffr', 'vs-4bet:CO:HJ'),
  ('nlhe-cash-6max-100bb', 'frrfffra', 'vs-allin:HJ:CO'),
  ('nlhe-cash-6max-100bb', 'frrffr', null),
  ('nlhe-cash-6max-100bb', 'frrffra', null),
  ('nlhe-cash-6max-100bb', 'frrffraf', null),
  ('nlhe-cash-6max-100bb', 'frrffrc', null),
  ('nlhe-cash-6max-100bb', 'frrffrf', null),
  ('nlhe-cash-6max-100bb', 'frrffrfa', null),
  ('nlhe-cash-6max-100bb', 'frrfr', null),
  ('nlhe-cash-6max-100bb', 'frrfrf', null),
  ('nlhe-cash-6max-100bb', 'frrfrfa', null),
  ('nlhe-cash-6max-100bb', 'frrfrfaf', null),
  ('nlhe-cash-6max-100bb', 'frrfrff', null),
  ('nlhe-cash-6max-100bb', 'frrfrffa', null),
  ('nlhe-cash-6max-100bb', 'frrr', null),
  ('nlhe-cash-6max-100bb', 'frrraff', null),
  ('nlhe-cash-6max-100bb', 'frrrafff', null),
  ('nlhe-cash-6max-100bb', 'frrrf', null),
  ('nlhe-cash-6max-100bb', 'frrrfa', null),
  ('nlhe-cash-6max-100bb', 'frrrfaf', null),
  ('nlhe-cash-6max-100bb', 'frrrfaff', null),
  ('nlhe-cash-6max-100bb', 'frrrff', null),
  ('nlhe-cash-6max-100bb', 'frrrffa', null),
  ('nlhe-cash-6max-100bb', 'frrrffaf', null),
  ('nlhe-cash-6max-100bb', 'frrrfff', null),
  ('nlhe-cash-6max-100bb', 'frrrfffa', null),
  ('nlhe-cash-6max-100bb', 'r', 'vs-open:HJ:UTG'),
  ('nlhe-cash-6max-100bb', 'rf', 'vs-open:CO:UTG'),
  ('nlhe-cash-6max-100bb', 'rff', 'vs-open:BTN:UTG'),
  ('nlhe-cash-6max-100bb', 'rffc', 'squeeze:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'rffcc', 'squeeze:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'rffcf', 'squeeze:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'rffcfr', null),
  ('nlhe-cash-6max-100bb', 'rffcfrc', null),
  ('nlhe-cash-6max-100bb', 'rffcfrf', null),
  ('nlhe-cash-6max-100bb', 'rffcfrr', null),
  ('nlhe-cash-6max-100bb', 'rffcfrrf', null),
  ('nlhe-cash-6max-100bb', 'rffcr', null),
  ('nlhe-cash-6max-100bb', 'rffcrf', null),
  ('nlhe-cash-6max-100bb', 'rffcrfc', null),
  ('nlhe-cash-6max-100bb', 'rffcrff', null),
  ('nlhe-cash-6max-100bb', 'rffcrfr', null),
  ('nlhe-cash-6max-100bb', 'rffcrfrf', null),
  ('nlhe-cash-6max-100bb', 'rfff', 'vs-open:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'rfffc', 'squeeze:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'rfffcr', null),
  ('nlhe-cash-6max-100bb', 'rfffcrc', null),
  ('nlhe-cash-6max-100bb', 'rfffcrf', null),
  ('nlhe-cash-6max-100bb', 'rfffcrr', null),
  ('nlhe-cash-6max-100bb', 'rfffcrrf', null),
  ('nlhe-cash-6max-100bb', 'rffff', 'vs-open:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'rffffr', 'vs-3bet:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'rffffrr', 'vs-4bet:BB:UTG'),
  ('nlhe-cash-6max-100bb', 'rffffrra', 'vs-allin:UTG:BB'),
  ('nlhe-cash-6max-100bb', 'rfffr', null),
  ('nlhe-cash-6max-100bb', 'rfffrf', 'vs-3bet:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'rfffrfr', 'vs-4bet:SB:UTG'),
  ('nlhe-cash-6max-100bb', 'rfffrfra', 'vs-allin:UTG:SB'),
  ('nlhe-cash-6max-100bb', 'rfffrr', null),
  ('nlhe-cash-6max-100bb', 'rfffrrf', null),
  ('nlhe-cash-6max-100bb', 'rfffrrfa', null),
  ('nlhe-cash-6max-100bb', 'rffr', null),
  ('nlhe-cash-6max-100bb', 'rffrf', null),
  ('nlhe-cash-6max-100bb', 'rffrff', 'vs-3bet:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'rffrffr', 'vs-4bet:BTN:UTG'),
  ('nlhe-cash-6max-100bb', 'rffrffra', 'vs-allin:UTG:BTN'),
  ('nlhe-cash-6max-100bb', 'rffrfr', null),
  ('nlhe-cash-6max-100bb', 'rffrfra', null),
  ('nlhe-cash-6max-100bb', 'rffrfraf', null),
  ('nlhe-cash-6max-100bb', 'rffrfrf', null),
  ('nlhe-cash-6max-100bb', 'rffrfrfa', null),
  ('nlhe-cash-6max-100bb', 'rffrr', null),
  ('nlhe-cash-6max-100bb', 'rffrrf', null),
  ('nlhe-cash-6max-100bb', 'rffrrfa', null),
  ('nlhe-cash-6max-100bb', 'rffrrfaf', null),
  ('nlhe-cash-6max-100bb', 'rffrrff', null),
  ('nlhe-cash-6max-100bb', 'rffrrffa', null),
  ('nlhe-cash-6max-100bb', 'rfr', null),
  ('nlhe-cash-6max-100bb', 'rfrf', null),
  ('nlhe-cash-6max-100bb', 'rfrff', null),
  ('nlhe-cash-6max-100bb', 'rfrfff', 'vs-3bet:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'rfrfffr', 'vs-4bet:CO:UTG'),
  ('nlhe-cash-6max-100bb', 'rfrfffra', 'vs-allin:UTG:CO'),
  ('nlhe-cash-6max-100bb', 'rfrffr', null),
  ('nlhe-cash-6max-100bb', 'rfrffra', null),
  ('nlhe-cash-6max-100bb', 'rfrffraf', null),
  ('nlhe-cash-6max-100bb', 'rfrffrc', null),
  ('nlhe-cash-6max-100bb', 'rfrffrf', null),
  ('nlhe-cash-6max-100bb', 'rfrffrfa', null),
  ('nlhe-cash-6max-100bb', 'rfrfr', null),
  ('nlhe-cash-6max-100bb', 'rfrfrf', null),
  ('nlhe-cash-6max-100bb', 'rfrfrfa', null),
  ('nlhe-cash-6max-100bb', 'rfrfrfaf', null),
  ('nlhe-cash-6max-100bb', 'rfrfrff', null),
  ('nlhe-cash-6max-100bb', 'rfrfrffa', null),
  ('nlhe-cash-6max-100bb', 'rfrr', null),
  ('nlhe-cash-6max-100bb', 'rfrrf', null),
  ('nlhe-cash-6max-100bb', 'rfrrff', null),
  ('nlhe-cash-6max-100bb', 'rfrrffa', null),
  ('nlhe-cash-6max-100bb', 'rfrrffaf', null),
  ('nlhe-cash-6max-100bb', 'rfrrfff', null),
  ('nlhe-cash-6max-100bb', 'rfrrfffa', null),
  ('nlhe-cash-6max-100bb', 'rr', null),
  ('nlhe-cash-6max-100bb', 'rrf', null),
  ('nlhe-cash-6max-100bb', 'rrff', null),
  ('nlhe-cash-6max-100bb', 'rrfff', null),
  ('nlhe-cash-6max-100bb', 'rrffff', 'vs-3bet:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'rrffffr', 'vs-4bet:HJ:UTG'),
  ('nlhe-cash-6max-100bb', 'rrffffra', 'vs-allin:UTG:HJ'),
  ('nlhe-cash-6max-100bb', 'rrfffr', null),
  ('nlhe-cash-6max-100bb', 'rrfffra', null),
  ('nlhe-cash-6max-100bb', 'rrfffraf', null),
  ('nlhe-cash-6max-100bb', 'rrfffrf', null),
  ('nlhe-cash-6max-100bb', 'rrfffrfa', null),
  ('nlhe-cash-6max-100bb', 'rrffr', null),
  ('nlhe-cash-6max-100bb', 'rrffrf', null),
  ('nlhe-cash-6max-100bb', 'rrffrfa', null),
  ('nlhe-cash-6max-100bb', 'rrffrfaf', null),
  ('nlhe-cash-6max-100bb', 'rrffrff', null),
  ('nlhe-cash-6max-100bb', 'rrffrffa', null),
  ('nlhe-cash-6max-100bb', 'rrfr', null),
  ('nlhe-cash-6max-100bb', 'rrfrf', null),
  ('nlhe-cash-6max-100bb', 'rrfrff', null),
  ('nlhe-cash-6max-100bb', 'rrfrffa', null),
  ('nlhe-cash-6max-100bb', 'rrfrffaf', null),
  ('nlhe-cash-6max-100bb', 'rrfrfff', null),
  ('nlhe-cash-6max-100bb', 'rrfrfffa', null),
  ('nlhe-cash-6max-100bb', 'rrr', null),
  ('nlhe-cash-6max-100bb', 'rrrf', null),
  ('nlhe-cash-6max-100bb', 'rrrff', null),
  ('nlhe-cash-6max-100bb', 'rrrfff', null),
  ('nlhe-cash-6max-100bb', 'rrrfffa', null),
  ('nlhe-cash-6max-100bb', 'rrrfffaf', null),
  ('nlhe-cash-6max-100bb', 'rrrffff', null),
  ('nlhe-cash-6max-100bb', 'rrrffffa', null),
  ('nlhe-cash-hu-100bb', '', 'rfi:SB'),
  ('nlhe-cash-hu-100bb', 'c', 'vs-limp:BB:SB'),
  ('nlhe-cash-hu-100bb', 'cr', 'vs-iso:SB:BB'),
  ('nlhe-cash-hu-100bb', 'crr', null),
  ('nlhe-cash-hu-100bb', 'crrr', null),
  ('nlhe-cash-hu-100bb', 'crrra', null),
  ('nlhe-cash-hu-100bb', 'r', 'vs-open:BB:SB'),
  ('nlhe-cash-hu-100bb', 'rr', 'vs-3bet:SB:BB'),
  ('nlhe-cash-hu-100bb', 'rrr', 'vs-4bet:BB:SB'),
  ('nlhe-cash-hu-100bb', 'rrra', 'vs-allin:SB:BB'),
  ('nlhe-cash-9max-100bb', '', 'rfi:UTG'),
  ('nlhe-cash-9max-100bb', 'c', 'vs-limp:UTG+1:UTG'),
  ('nlhe-cash-9max-100bb', 'cf', 'vs-limp:UTG+2:UTG'),
  ('nlhe-cash-9max-100bb', 'cff', 'vs-limp:LJ:UTG'),
  ('nlhe-cash-9max-100bb', 'cfff', 'vs-limp:HJ:UTG'),
  ('nlhe-cash-9max-100bb', 'cffff', 'vs-limp:CO:UTG'),
  ('nlhe-cash-9max-100bb', 'cfffff', 'vs-limp:BTN:UTG'),
  ('nlhe-cash-9max-100bb', 'cffffff', 'vs-limp:SB:UTG'),
  ('nlhe-cash-9max-100bb', 'f', 'rfi:UTG+1'),
  ('nlhe-cash-9max-100bb', 'fc', 'vs-limp:UTG+2:UTG+1'),
  ('nlhe-cash-9max-100bb', 'fcf', 'vs-limp:LJ:UTG+1'),
  ('nlhe-cash-9max-100bb', 'fcff', 'vs-limp:HJ:UTG+1'),
  ('nlhe-cash-9max-100bb', 'fcfff', 'vs-limp:CO:UTG+1'),
  ('nlhe-cash-9max-100bb', 'fcffff', 'vs-limp:BTN:UTG+1'),
  ('nlhe-cash-9max-100bb', 'fcfffff', 'vs-limp:SB:UTG+1'),
  ('nlhe-cash-9max-100bb', 'ff', 'rfi:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffc', 'vs-limp:LJ:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffcf', 'vs-limp:HJ:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffcff', 'vs-limp:CO:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffcfff', 'vs-limp:BTN:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffcffff', 'vs-limp:SB:UTG+2'),
  ('nlhe-cash-9max-100bb', 'fff', 'rfi:LJ'),
  ('nlhe-cash-9max-100bb', 'fffc', 'vs-limp:HJ:LJ'),
  ('nlhe-cash-9max-100bb', 'fffcf', 'vs-limp:CO:LJ'),
  ('nlhe-cash-9max-100bb', 'fffcff', 'vs-limp:BTN:LJ'),
  ('nlhe-cash-9max-100bb', 'ffff', 'rfi:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffc', 'vs-limp:CO:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffcf', 'vs-limp:BTN:HJ'),
  ('nlhe-cash-9max-100bb', 'fffff', 'rfi:CO'),
  ('nlhe-cash-9max-100bb', 'fffffc', 'vs-limp:BTN:CO'),
  ('nlhe-cash-9max-100bb', 'ffffff', 'rfi:BTN'),
  ('nlhe-cash-9max-100bb', 'fffffff', 'rfi:SB'),
  ('nlhe-cash-9max-100bb', 'fffffffc', 'vs-limp:BB:SB'),
  ('nlhe-cash-9max-100bb', 'fffffffcr', 'vs-iso:SB:BB'),
  ('nlhe-cash-9max-100bb', 'fffffffcrr', null),
  ('nlhe-cash-9max-100bb', 'fffffffr', 'vs-open:BB:SB'),
  ('nlhe-cash-9max-100bb', 'fffffffrr', 'vs-3bet:SB:BB'),
  ('nlhe-cash-9max-100bb', 'ffffffr', 'vs-open:SB:BTN'),
  ('nlhe-cash-9max-100bb', 'ffffffrc', 'squeeze:BB:BTN'),
  ('nlhe-cash-9max-100bb', 'ffffffrf', 'vs-open:BB:BTN'),
  ('nlhe-cash-9max-100bb', 'ffffffrfr', 'vs-3bet:BTN:BB'),
  ('nlhe-cash-9max-100bb', 'ffffffrr', null),
  ('nlhe-cash-9max-100bb', 'ffffffrrf', 'vs-3bet:BTN:SB'),
  ('nlhe-cash-9max-100bb', 'fffffr', 'vs-open:BTN:CO'),
  ('nlhe-cash-9max-100bb', 'fffffrc', 'squeeze:SB:CO'),
  ('nlhe-cash-9max-100bb', 'fffffrcf', 'squeeze:BB:CO'),
  ('nlhe-cash-9max-100bb', 'fffffrf', 'vs-open:SB:CO'),
  ('nlhe-cash-9max-100bb', 'fffffrfc', 'squeeze:BB:CO'),
  ('nlhe-cash-9max-100bb', 'fffffrff', 'vs-open:BB:CO'),
  ('nlhe-cash-9max-100bb', 'fffffrffr', 'vs-3bet:CO:BB'),
  ('nlhe-cash-9max-100bb', 'fffffrfr', null),
  ('nlhe-cash-9max-100bb', 'fffffrfrf', 'vs-3bet:CO:SB'),
  ('nlhe-cash-9max-100bb', 'fffffrr', null),
  ('nlhe-cash-9max-100bb', 'fffffrrf', null),
  ('nlhe-cash-9max-100bb', 'fffffrrff', 'vs-3bet:CO:BTN'),
  ('nlhe-cash-9max-100bb', 'ffffr', 'vs-open:CO:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffrf', 'vs-open:BTN:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffrfc', 'squeeze:SB:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffrff', 'vs-open:SB:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffrffc', 'squeeze:BB:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffrfff', 'vs-open:BB:HJ'),
  ('nlhe-cash-9max-100bb', 'ffffrfffr', 'vs-3bet:HJ:BB'),
  ('nlhe-cash-9max-100bb', 'ffffrffr', null),
  ('nlhe-cash-9max-100bb', 'ffffrffrf', 'vs-3bet:HJ:SB'),
  ('nlhe-cash-9max-100bb', 'ffffrfr', null),
  ('nlhe-cash-9max-100bb', 'ffffrfrf', null),
  ('nlhe-cash-9max-100bb', 'ffffrfrff', 'vs-3bet:HJ:BTN'),
  ('nlhe-cash-9max-100bb', 'ffffrr', null),
  ('nlhe-cash-9max-100bb', 'ffffrrf', null),
  ('nlhe-cash-9max-100bb', 'ffffrrff', null),
  ('nlhe-cash-9max-100bb', 'ffffrrfff', 'vs-3bet:HJ:CO'),
  ('nlhe-cash-9max-100bb', 'fffr', 'vs-open:HJ:LJ'),
  ('nlhe-cash-9max-100bb', 'fffrf', 'vs-open:CO:LJ'),
  ('nlhe-cash-9max-100bb', 'fffrff', 'vs-open:BTN:LJ'),
  ('nlhe-cash-9max-100bb', 'fffrfff', 'vs-open:SB:LJ'),
  ('nlhe-cash-9max-100bb', 'fffrfffc', 'squeeze:BB:LJ'),
  ('nlhe-cash-9max-100bb', 'fffrffff', 'vs-open:BB:LJ'),
  ('nlhe-cash-9max-100bb', 'fffrffffr', 'vs-3bet:LJ:BB'),
  ('nlhe-cash-9max-100bb', 'fffrfffr', null),
  ('nlhe-cash-9max-100bb', 'fffrfffrf', 'vs-3bet:LJ:SB'),
  ('nlhe-cash-9max-100bb', 'fffrffr', null),
  ('nlhe-cash-9max-100bb', 'fffrffrf', null),
  ('nlhe-cash-9max-100bb', 'fffrffrff', 'vs-3bet:LJ:BTN'),
  ('nlhe-cash-9max-100bb', 'fffrfr', null),
  ('nlhe-cash-9max-100bb', 'fffrfrf', null),
  ('nlhe-cash-9max-100bb', 'fffrfrff', null),
  ('nlhe-cash-9max-100bb', 'fffrfrfff', 'vs-3bet:LJ:CO'),
  ('nlhe-cash-9max-100bb', 'fffrr', null),
  ('nlhe-cash-9max-100bb', 'fffrrf', null),
  ('nlhe-cash-9max-100bb', 'fffrrff', null),
  ('nlhe-cash-9max-100bb', 'fffrrfff', null),
  ('nlhe-cash-9max-100bb', 'fffrrffff', 'vs-3bet:LJ:HJ'),
  ('nlhe-cash-9max-100bb', 'ffr', 'vs-open:LJ:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrf', 'vs-open:HJ:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrff', 'vs-open:CO:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrfff', 'vs-open:BTN:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrfffc', 'squeeze:SB:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrffff', 'vs-open:SB:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrffffc', 'squeeze:BB:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrfffff', 'vs-open:BB:UTG+2'),
  ('nlhe-cash-9max-100bb', 'ffrfffffr', 'vs-3bet:UTG+2:BB'),
  ('nlhe-cash-9max-100bb', 'ffrffffr', null),
  ('nlhe-cash-9max-100bb', 'ffrffffrf', 'vs-3bet:UTG+2:SB'),
  ('nlhe-cash-9max-100bb', 'ffrfffr', null),
  ('nlhe-cash-9max-100bb', 'ffrfffrf', null),
  ('nlhe-cash-9max-100bb', 'ffrfffrff', 'vs-3bet:UTG+2:BTN'),
  ('nlhe-cash-9max-100bb', 'ffrffr', null),
  ('nlhe-cash-9max-100bb', 'ffrffrf', null),
  ('nlhe-cash-9max-100bb', 'ffrffrff', null),
  ('nlhe-cash-9max-100bb', 'ffrffrfff', 'vs-3bet:UTG+2:CO'),
  ('nlhe-cash-9max-100bb', 'ffrfr', null),
  ('nlhe-cash-9max-100bb', 'ffrfrf', null),
  ('nlhe-cash-9max-100bb', 'ffrfrff', null),
  ('nlhe-cash-9max-100bb', 'ffrfrfff', null),
  ('nlhe-cash-9max-100bb', 'ffrfrffff', 'vs-3bet:UTG+2:HJ'),
  ('nlhe-cash-9max-100bb', 'ffrr', null),
  ('nlhe-cash-9max-100bb', 'ffrrf', null),
  ('nlhe-cash-9max-100bb', 'ffrrff', null),
  ('nlhe-cash-9max-100bb', 'ffrrfff', null),
  ('nlhe-cash-9max-100bb', 'ffrrffff', null),
  ('nlhe-cash-9max-100bb', 'ffrrfffff', 'vs-3bet:UTG+2:LJ'),
  ('nlhe-cash-9max-100bb', 'fr', 'vs-open:UTG+2:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frf', 'vs-open:LJ:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frff', 'vs-open:HJ:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frfff', 'vs-open:CO:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frffff', 'vs-open:BTN:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frffffc', 'squeeze:SB:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frffffcf', 'squeeze:BB:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frfffff', 'vs-open:SB:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frfffffc', 'squeeze:BB:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frffffff', 'vs-open:BB:UTG+1'),
  ('nlhe-cash-9max-100bb', 'frfffffr', null),
  ('nlhe-cash-9max-100bb', 'frfffffrf', 'vs-3bet:UTG+1:SB'),
  ('nlhe-cash-9max-100bb', 'frffffr', null),
  ('nlhe-cash-9max-100bb', 'frffffrf', null),
  ('nlhe-cash-9max-100bb', 'frffffrff', 'vs-3bet:UTG+1:BTN'),
  ('nlhe-cash-9max-100bb', 'frfffr', null),
  ('nlhe-cash-9max-100bb', 'frfffrf', null),
  ('nlhe-cash-9max-100bb', 'frfffrff', null),
  ('nlhe-cash-9max-100bb', 'frfffrfff', 'vs-3bet:UTG+1:CO'),
  ('nlhe-cash-9max-100bb', 'frffr', null),
  ('nlhe-cash-9max-100bb', 'frffrf', null),
  ('nlhe-cash-9max-100bb', 'frffrff', null),
  ('nlhe-cash-9max-100bb', 'frffrfff', null),
  ('nlhe-cash-9max-100bb', 'frffrffff', 'vs-3bet:UTG+1:HJ'),
  ('nlhe-cash-9max-100bb', 'frfr', null),
  ('nlhe-cash-9max-100bb', 'frfrf', null),
  ('nlhe-cash-9max-100bb', 'frfrff', null),
  ('nlhe-cash-9max-100bb', 'frfrfff', null),
  ('nlhe-cash-9max-100bb', 'frfrffff', null),
  ('nlhe-cash-9max-100bb', 'frfrfffff', 'vs-3bet:UTG+1:LJ'),
  ('nlhe-cash-9max-100bb', 'frr', null),
  ('nlhe-cash-9max-100bb', 'frrf', null),
  ('nlhe-cash-9max-100bb', 'frrff', null),
  ('nlhe-cash-9max-100bb', 'frrfff', null),
  ('nlhe-cash-9max-100bb', 'frrffff', null),
  ('nlhe-cash-9max-100bb', 'frrfffff', null),
  ('nlhe-cash-9max-100bb', 'frrffffff', 'vs-3bet:UTG+1:UTG+2'),
  ('nlhe-cash-9max-100bb', 'r', 'vs-open:UTG+1:UTG'),
  ('nlhe-cash-9max-100bb', 'rf', 'vs-open:UTG+2:UTG'),
  ('nlhe-cash-9max-100bb', 'rff', 'vs-open:LJ:UTG'),
  ('nlhe-cash-9max-100bb', 'rfff', 'vs-open:HJ:UTG'),
  ('nlhe-cash-9max-100bb', 'rffff', 'vs-open:CO:UTG'),
  ('nlhe-cash-9max-100bb', 'rfffff', 'vs-open:BTN:UTG'),
  ('nlhe-cash-9max-100bb', 'rffffff', 'vs-open:SB:UTG'),
  ('nlhe-cash-9max-100bb', 'rffffffc', 'squeeze:BB:UTG'),
  ('nlhe-cash-9max-100bb', 'rfffffff', 'vs-open:BB:UTG'),
  ('nlhe-cash-9max-100bb', 'rfffffr', null),
  ('nlhe-cash-9max-100bb', 'rfffffrf', null),
  ('nlhe-cash-9max-100bb', 'rfffffrff', 'vs-3bet:UTG:BTN'),
  ('nlhe-cash-9max-100bb', 'rffffr', null),
  ('nlhe-cash-9max-100bb', 'rffffrf', null),
  ('nlhe-cash-9max-100bb', 'rffffrff', null),
  ('nlhe-cash-9max-100bb', 'rffffrfff', 'vs-3bet:UTG:CO'),
  ('nlhe-cash-9max-100bb', 'rfffr', null),
  ('nlhe-cash-9max-100bb', 'rfffrf', null),
  ('nlhe-cash-9max-100bb', 'rfffrff', null),
  ('nlhe-cash-9max-100bb', 'rfffrfff', null),
  ('nlhe-cash-9max-100bb', 'rfffrffff', 'vs-3bet:UTG:HJ'),
  ('nlhe-cash-9max-100bb', 'rffr', null),
  ('nlhe-cash-9max-100bb', 'rffrf', null),
  ('nlhe-cash-9max-100bb', 'rffrff', null),
  ('nlhe-cash-9max-100bb', 'rffrfff', null),
  ('nlhe-cash-9max-100bb', 'rffrffff', null),
  ('nlhe-cash-9max-100bb', 'rffrfffff', 'vs-3bet:UTG:LJ'),
  ('nlhe-cash-9max-100bb', 'rfr', null),
  ('nlhe-cash-9max-100bb', 'rfrf', null),
  ('nlhe-cash-9max-100bb', 'rfrff', null),
  ('nlhe-cash-9max-100bb', 'rfrfff', null),
  ('nlhe-cash-9max-100bb', 'rfrffff', null),
  ('nlhe-cash-9max-100bb', 'rfrfffff', null),
  ('nlhe-cash-9max-100bb', 'rfrffffff', 'vs-3bet:UTG:UTG+2'),
  ('nlhe-cash-9max-100bb', 'rr', null),
  ('nlhe-cash-9max-100bb', 'rrf', null),
  ('nlhe-cash-9max-100bb', 'rrff', null),
  ('nlhe-cash-9max-100bb', 'rrfff', null),
  ('nlhe-cash-9max-100bb', 'rrffff', null),
  ('nlhe-cash-9max-100bb', 'rrfffff', null),
  ('nlhe-cash-9max-100bb', 'rrffffff', null),
  ('nlhe-cash-9max-100bb', 'rrfffffff', 'vs-3bet:UTG:UTG+1'),
  ('nlhe-cash-6max-100bb-straddle', '', null),
  ('nlhe-cash-6max-100bb-straddle', 'fffrf', null),
  ('nlhe-cash-6max-40bb', 'rffffa', 'vs-3bet:UTG:BB'),
  ('nlhe-cash-6max-40bb', 'rffffrf', null)
;
-- KEY CASES END

select is(
  (select count(*)::int from keycases where public.preflop_chart_node_key(set_id, line) is distinct from key),
  0, 'preflop_chart_node_key gives the TypeScript''s key for every case');
select ok((select count(*) from keycases) > 900, '... over more than 900 shipped lines');
select is(
  array[public.preflop_class_index('AA'), public.preflop_class_index('AKs'), public.preflop_class_index('AKo'),
        public.preflop_class_index('KAs'), public.preflop_class_index('72o'), public.preflop_class_index('22'),
        public.preflop_class_index('A1s'), public.preflop_class_index('AAs')],
  array[0, 1, 13, 1, 163, 168, null, null]::smallint[],
  'preflop_class_index: the shipped order, either rank first, nothing for a non-class');
-- ------------------------------------------------------------ played rows --
--
--   a1 30 Mar cash 6max "ff"     rfi:CO          AKo raise        100bb  0
--   a2 20 Mar cash 6max "fffrf"  vs-open:BB:BTN  72o call          95bb  1.5
--   a3 10 Jan cash 6max "rffffr" vs-3bet:UTG:BB  AA  raise all in 100bb  0
--   a4 29 Mar tourn 9max ""      rfi:UTG         KK  raise         30bb  0
--   a5 28 Mar cash 6max "rfr"    '' (cold 4-bet) QQ  fold         100bb  0.4
--   a6 27 Mar cash: a preflop heuristic decision and a flop solver one (not rows)
--   a7 26 Mar cash, the straddle set (not a row)
--   a2 again at analysis/4: 72o fold (another version)
--   b1 25 Mar cash 6max "ff"     rfi:CO          AKo fold   (account B)

reset role;
select set_config('request.jwt.claims', '', true);

create temp table gen (id uuid, owner uuid, n text, at timestamptz, fmt text, pos text, cards text[], cls text)
  on commit drop;
insert into gen values
  ('00000000-0000-0000-0000-0000000c5301', '00000000-0000-0000-0000-0000000c53a1', 'a1', '2026-03-30T10:00:00Z', 'cash', 'CO', '{Ad,Kc}', 'AKo'),
  ('00000000-0000-0000-0000-0000000c5302', '00000000-0000-0000-0000-0000000c53a1', 'a2', '2026-03-20T10:00:00Z', 'cash', 'BB', '{7d,2c}', '72o'),
  ('00000000-0000-0000-0000-0000000c5303', '00000000-0000-0000-0000-0000000c53a1', 'a3', '2026-01-10T10:00:00Z', 'cash', 'UTG', '{Ad,Ac}', 'AA'),
  ('00000000-0000-0000-0000-0000000c5304', '00000000-0000-0000-0000-0000000c53a1', 'a4', '2026-03-29T10:00:00Z', 'tournament', 'UTG', '{Kd,Kc}', 'KK'),
  ('00000000-0000-0000-0000-0000000c5305', '00000000-0000-0000-0000-0000000c53a1', 'a5', '2026-03-28T10:00:00Z', 'cash', 'HJ', '{Qd,Qc}', 'QQ'),
  ('00000000-0000-0000-0000-0000000c5306', '00000000-0000-0000-0000-0000000c53a1', 'a6', '2026-03-27T10:00:00Z', 'cash', 'BTN', '{9d,8d}', '98s'),
  ('00000000-0000-0000-0000-0000000c5307', '00000000-0000-0000-0000-0000000c53a1', 'a7', '2026-03-26T10:00:00Z', 'cash', 'UTG', '{Jd,Jc}', 'JJ'),
  ('00000000-0000-0000-0000-0000000c53b9', '00000000-0000-0000-0000-0000000c53b1', 'b1', '2026-03-25T10:00:00Z', 'cash', 'CO', '{Ah,Kd}', 'AKo');

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, table_name, total_pot,
                          hero_profit, site_hand_id)
select g.id, g.owner, 'pokerstars:pc' || g.n, '{"schema":"phf/1"}', 'std', 'pokerstars', g.fmt::public.game_format,
       'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, g.at, 1, g.pos, g.cards, g.cls, 'T1', 1000, 0, 'pc' || g.n
from gen g;

insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, game_format,
                               currency, currency_minor_units, big_blind, played_at, won, contributed, net, net_bb_milli,
                               table_name, "position", max_seats, player_count, is_bomb_pot, has_cashout, pot_type)
select g.id, g.owner, 'stats/2', 1, 'pokerstars:pc' || g.n, 'pokerstars', true, 1, g.fmt::public.game_format, 'USD', 100, 200,
       g.at, 0, 200, -200, -1000, 'T1', g.pos, 6, 6, false, false, 'single-raised'
from gen g;

insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, hero_seat, decisions, analysed)
select g.id, g.owner, 'analysis/3', 'full', 1, 1, 1 from gen g;
insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, hero_seat, decisions, analysed)
values ('00000000-0000-0000-0000-0000000c5302', '00000000-0000-0000-0000-0000000c53a1', 'analysis/4', 'full', 1, 1, 1);

create function pg_temp.facts(p_cls text, p_set text, p_line text, p_eff numeric, p_allin boolean) returns jsonb
language sql as $$
  select jsonb_build_object('handClass', p_cls, 'position', 'X', 'effStackBb', p_eff, 'allIn', p_allin,
                            'chart', jsonb_build_object('set', p_set, 'line', p_line));
$$;

insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status,
                                      node, scenario, source, grade, ev_loss_bb, facts) values
  ('00000000-0000-0000-0000-0000000c5301', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 4, 'preflop', 'raise', 'analysed',
   'n', 'unopened', 'chart', 'perfect', 0, pg_temp.facts('AKo', 'nlhe-cash-6max-100bb', 'ff', 100, false)),
  ('00000000-0000-0000-0000-0000000c5302', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 7, 'preflop', 'call', 'analysed',
   'n', 'vs-open', 'chart', 'blunder', 1.5, pg_temp.facts('72o', 'nlhe-cash-6max-100bb', 'fffrf', 95, false)),
  ('00000000-0000-0000-0000-0000000c5303', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 9, 'preflop', 'raise', 'analysed',
   'n', 'vs-3bet', 'chart', 'perfect', 0, pg_temp.facts('AA', 'nlhe-cash-6max-100bb', 'rffffr', 100, true)),
  ('00000000-0000-0000-0000-0000000c5304', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 2, 'preflop', 'raise', 'analysed',
   'n', 'unopened', 'chart', 'good', 0, pg_temp.facts('KK', 'nlhe-cash-9max-100bb', '', 30, false)),
  ('00000000-0000-0000-0000-0000000c5305', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 5, 'preflop', 'fold', 'analysed',
   'n', 'vs-3bet-cold', 'chart', 'inaccurate', 0.4, pg_temp.facts('QQ', 'nlhe-cash-6max-100bb', 'rfr', 100, false)),
  ('00000000-0000-0000-0000-0000000c5306', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 4, 'preflop', 'raise', 'analysed',
   'n', 'unopened', 'heuristic', null, null, '{"handClass":"98s"}'),
  ('00000000-0000-0000-0000-0000000c5306', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 1, 9, 'flop', 'bet', 'analysed',
   'n', 'cbet', 'solver', 'good', 0, '{}'),
  ('00000000-0000-0000-0000-0000000c5307', '00000000-0000-0000-0000-0000000c53a1', 'analysis/3', 0, 4, 'preflop', 'raise', 'analysed',
   'n', 'unopened', 'chart', 'good', 0, pg_temp.facts('JJ', 'nlhe-cash-6max-100bb-straddle', '', 100, false)),
  ('00000000-0000-0000-0000-0000000c5302', '00000000-0000-0000-0000-0000000c53a1', 'analysis/4', 0, 7, 'preflop', 'fold', 'analysed',
   'n', 'vs-open', 'chart', 'good', 0, pg_temp.facts('72o', 'nlhe-cash-6max-100bb', 'fffrf', 95, false)),
  ('00000000-0000-0000-0000-0000000c53b9', '00000000-0000-0000-0000-0000000c53b1', 'analysis/3', 0, 4, 'preflop', 'fold', 'analysed',
   'n', 'unopened', 'chart', 'mistake', 0.3, pg_temp.facts('AKo', 'nlhe-cash-6max-100bb', 'ff', 100, false));


select is(
  (select string_agg(right(hand_id::text, 2) || ' ' || node_key || ' ' || hand_class || ' ' || action || ' '
                     || table_size || ' ' || depth_band || ' ' || game_format, '; ' order by hand_id)
   from public.preflop_decision_rows where owner_id = '00000000-0000-0000-0000-0000000c53a1' and analysis_version = 'analysis/3'),
  '01 rfi:CO 13 raise 6 100 cash; 02 vs-open:BB:BTN 163 call 6 90 cash; 03 vs-3bet:UTG:BB 0 allin 6 100 cash; '
  '04 rfi:UTG 14 raise 9 30 tournament; 05  28 fold 6 100 cash',
  'one row per preflop chart decision: its key, class, action (an all-in raise is allin), table, depth step and format');
select is(
  (select count(*)::int from public.preflop_decision_rows where hand_id in ('00000000-0000-0000-0000-0000000c5306', '00000000-0000-0000-0000-0000000c5307')),
  0, '... none for a heuristic, a postflop or a straddled decision');

create function pg_temp.totals_match(p_owner uuid) returns boolean language sql as $$
  select not exists (
    (select analysis_version, game_format, table_size, depth_band, node_key, hand_class, action, count(*)::int, sum(ev_loss_bb)
     from public.preflop_decision_rows where owner_id = p_owner group by 1, 2, 3, 4, 5, 6, 7)
    except
    (select analysis_version, game_format, table_size, depth_band, node_key, hand_class, action, decisions, ev_loss_bb
     from public.preflop_decision_totals where owner_id = p_owner))
  and not exists (
    (select analysis_version, game_format, table_size, depth_band, node_key, hand_class, action, decisions, ev_loss_bb
     from public.preflop_decision_totals where owner_id = p_owner)
    except
    (select analysis_version, game_format, table_size, depth_band, node_key, hand_class, action, count(*)::int, sum(ev_loss_bb)
     from public.preflop_decision_rows where owner_id = p_owner group by 1, 2, 3, 4, 5, 6, 7));
$$;
select ok(pg_temp.totals_match('00000000-0000-0000-0000-0000000c53a1'), 'the totals equal the rows');

-- The cells as text, sorted.
create function pg_temp.cells(p jsonb) returns text language sql as $$
  select coalesce(string_agg(c ->> 0 || ' ' || (c ->> 1) || ' ' || (c ->> 2) || ' ' || (c ->> 3) || ' ' || (c ->> 4)::numeric,
                             '; ' order by (c ->> 0) collate "C", (c ->> 1)::int, c ->> 2), '')
  from jsonb_array_elements(p -> 'cells') c;
$$;
grant execute on function pg_temp.cells(jsonb) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53a1');
select is(pg_temp.cells(public.preflop_chart_played('analysis/3', 'all', 'cash', 6, 80, 120)),
          ' 28 fold 1 0.400; rfi:CO 13 raise 1 0.000; vs-3bet:UTG:BB 0 allin 1 0.000; vs-open:BB:BTN 163 call 1 1.500',
          'played, all time: the cash 6-max decisions at 80-120 bb, with the EV loss');
select is(
  (select p ->> 'from' || ' ' || (p ->> 'to') from (select public.preflop_chart_played('analysis/3', 'all', 'cash', 6, 80, 120) p) x),
  '2026-01-10 2026-03-30', '... over the account''s analysed days');
select is(pg_temp.cells(public.preflop_chart_played('analysis/3', '30d', 'cash', 6, 80, 120)),
          ' 28 fold 1 0.400; rfi:CO 13 raise 1 0.000; vs-open:BB:BTN 163 call 1 1.500',
          'played, 30 days: from 1 March (the last decision on 30 March) - January''s 3-bet left out');
select is(
  (select p ->> 'from' || ' ' || (p ->> 'to') from (select public.preflop_chart_played('analysis/3', '30d', 'cash', 6, 80, 120) p) x),
  '2026-03-01 2026-03-30', '... and says so');
select is(pg_temp.cells(public.preflop_chart_played('analysis/3', 'all', 'cash', 6, 100, 120)),
          ' 28 fold 1 0.400; rfi:CO 13 raise 1 0.000; vs-3bet:UTG:BB 0 allin 1 0.000',
          'a stack range of 100-120 bb leaves out the 95 bb decision');
select is(pg_temp.cells(public.preflop_chart_played('analysis/3', 'all', 'tournament', 9, 20, 40)),
          'rfi:UTG 14 raise 1 0.000', 'a 9-max tournament chart reads the tournament hand');
select is(pg_temp.cells(public.preflop_chart_played('analysis/4', 'all', 'cash', 6, 80, 120)),
          'vs-open:BB:BTN 163 fold 1 0.000', 'another version reads its own rows only');
select ok(pg_temp.refused($$select public.preflop_chart_played('analysis/3', '7d', 'cash', 6, 80, 120)$$, 'Unknown period%')
          and pg_temp.refused($$select public.preflop_chart_played('analysis/3', 'all', 'cash', 7, 80, 120)$$, 'Unknown table%')
          and pg_temp.refused($$select public.preflop_chart_played('v3', 'all', 'cash', 6, 80, 120)$$, 'Unknown analysis%'),
          'played: a bad period, table or version is refused');

select is(
  (select string_agg(right(e ->> 'handId', 2) || ' ' || (e ->> 'actionIndex') || ' ' || (e -> 'heroCards' ->> 0), ', ')
   from jsonb_array_elements(public.preflop_chart_examples('analysis/3', 'all', 'cash', 6, 80, 120, 'vs-open:BB:BTN', 163, 'call', 5)) e),
  '02 7 7d', 'examples: the hand behind a cell, at its decision');
select is(
  jsonb_array_length(public.preflop_chart_examples('analysis/3', 'all', 'cash', 6, 100, 120, 'vs-open:BB:BTN', 163, 'call', 5)),
  0, '... inside the chart''s stack range');
select ok(pg_temp.refused($$select public.preflop_chart_examples('analysis/3', 'all', 'cash', 6, 80, 120, 'rfi:CO', 169, 'raise', 5)$$,
                          'Bad example%'),
          'examples: a class outside 0-168 is refused');

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53b1');
select is(pg_temp.cells(public.preflop_chart_played('analysis/3', 'all', 'cash', 6, 80, 120)),
          'rfi:CO 13 fold 1 0.300', 'another account reads only its own decision');
select is(
  jsonb_array_length(public.preflop_chart_examples('analysis/3', 'all', 'cash', 6, 80, 120, 'vs-open:BB:BTN', 163, 'call', 5)),
  0, '... and none of the first account''s examples');
select pg_temp.act_as_anon();
select ok(pg_temp.refused($$select public.preflop_chart_played('analysis/3', 'all', 'cash', 6, 80, 120)$$, '%permission denied%'),
          'anon cannot read played decisions');

-- ------------------------------------------------------- the session reader --

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53a1');
select is(
  (select string_agg(right(d ->> 'handId', 2) || ' ' || (d ->> 'key') || ' ' || (d ->> 'cls') || ' ' || (d ->> 'action')
                     || ' ' || coalesce(d ->> 'depthBand', '-'), ', ' order by d ->> 'handId')
   from jsonb_array_elements(public.preflop_chart_session(
          '{"statsVersion":"stats/2","analysisVersion":"analysis/3"}', '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')) d),
  '01 rfi:CO 13 raise 100, 04 rfi:UTG 14 raise 30, 05  28 fold 100',
  'the session reader: the decisions of the hands in the window');
select is(
  (select string_agg(right(d ->> 'handId', 2), ',' order by d ->> 'handId')
   from jsonb_array_elements(public.preflop_chart_session(
          '{"statsVersion":"stats/2","analysisVersion":"analysis/3","formats":["cash"],"positions":["CO","HJ"]}',
          '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')) d),
  '01,05', '... under the shared filter''s groups');
select ok(pg_temp.refused($$select public.preflop_chart_session('{}', '2026-03-01T00:00:00Z', '2026-03-20T00:00:00Z')$$,
                          'A session is at most 7 days%'),
          '... a window over 7 days is refused');
select is(
  (select jsonb_object_keys(public.preflop_chart_review_hands('{"statsVersion":"stats/2","analysisVersion":"analysis/3"}',
     array['00000000-0000-0000-0000-0000000c5301', '00000000-0000-0000-0000-0000000c53b9']::uuid[]))),
  '00000000-0000-0000-0000-0000000c5301', 'the review''s rows: the account''s own hands only');
select is(
  (select r -> '00000000-0000-0000-0000-0000000c5301' ->> 'netBbMilli' || ' ' || (r -> '00000000-0000-0000-0000-0000000c5301' ->> 'handClass')
   from (select public.preflop_chart_review_hands('{"statsVersion":"stats/2","analysisVersion":"analysis/3"}',
                 array['00000000-0000-0000-0000-0000000c5301']::uuid[]) r) x),
  '-1000 AKo', '... with session_review''s fields');
select ok(pg_temp.refused($$select public.preflop_chart_review_hands('{}', (select array_agg(gen_random_uuid()) from generate_series(1, 51)))$$,
                          'At most 50 hands%'),
          '... at most 50 at a time');

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53b1');
select is(
  jsonb_array_length(public.preflop_chart_session('{"statsVersion":"stats/2","analysisVersion":"analysis/3"}',
                                                  '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')),
  0, 'another account''s session reader sees none of the first''s decisions');

-- ------------------------------------------------- deletes and the rebuild --

reset role;
select set_config('request.jwt.claims', '', true);
delete from public.hands where id = '00000000-0000-0000-0000-0000000c5302';
select is(
  (select count(*)::int from public.preflop_decision_rows where hand_id = '00000000-0000-0000-0000-0000000c5302'),
  0, 'a deleted hand takes its rows (both versions) with it');
select ok(pg_temp.totals_match('00000000-0000-0000-0000-0000000c53a1')
          and not exists (select 1 from public.preflop_decision_totals where node_key = 'vs-open:BB:BTN'),
          '... and its totals');

delete from public.decision_analysis where hand_id = '00000000-0000-0000-0000-0000000c5303' and analysis_version = 'analysis/3';
select ok(not exists (select 1 from public.preflop_decision_rows where hand_id = '00000000-0000-0000-0000-0000000c5303')
          and pg_temp.totals_match('00000000-0000-0000-0000-0000000c53a1'),
          'a pruned decision takes its row and its totals');

create temp table before_rebuild on commit drop as
  select * from public.preflop_decision_totals where owner_id = '00000000-0000-0000-0000-0000000c53a1';
select is((public.preflop_decision_rows_rebuild('00000000-0000-0000-0000-0000000c53a1') ->> 'rows')::int, 3,
          'the rebuild recounts the account''s rows');
select ok(
  not exists (select * from before_rebuild except select * from public.preflop_decision_totals where owner_id = '00000000-0000-0000-0000-0000000c53a1')
  and not exists (select * from public.preflop_decision_totals where owner_id = '00000000-0000-0000-0000-0000000c53a1' except select * from before_rebuild),
  '... to what the triggers kept');

delete from auth.users where id = '00000000-0000-0000-0000-0000000c53b1';
select is(
  (select count(*)::int from public.preflop_decision_rows where owner_id = '00000000-0000-0000-0000-0000000c53b1')
    + (select count(*)::int from public.preflop_decision_totals where owner_id = '00000000-0000-0000-0000-0000000c53b1'),
  0, 'a deleted account leaves no rows or totals');

select * from finish();
rollback;

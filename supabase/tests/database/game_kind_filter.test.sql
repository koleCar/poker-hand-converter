-- pgTAP: one game kind at a time -- `20271104090000_game_kind_filter.sql`.
--
-- The readers take `gameKind` (cash, or every tournament format) beside the
-- one `gameFormat`, and the drill readers a `p_kind`. What has to hold:
--
--   * a kind's formats: cash alone; tournament, Sit & Go and Spin together;
--     an unknown kind refused;
--   * a reader asked for a kind reads that kind's hands only, the two kinds
--     add up to every hand, and a format outside the kind named reads none;
--   * the drills likewise; a call naming no kind answers as before.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(16);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000b1dd1', 'kind.a@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- One cash hand, one tournament hand, one Spin: each with a graded Mistake.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-0000000b1d01', '00000000-0000-0000-0000-0000000b1dd1', 'weplay:kind1',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['Qh','Jh'], '2026-03-02T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b1d02', '00000000-0000-0000-0000-0000000b1dd1', 'weplay:kind2',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'tournament', 'USD', 100, 50, 100, -100,
   array['Kc','Qd'], '2026-03-03T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b1d03', '00000000-0000-0000-0000-0000000b1dd1', 'weplay:kind3',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'spin', 'USD', 100, 50, 100, -100,
   array['Ah','2d'], '2026-03-04T10:00:00Z');

select pg_temp.act_as('00000000-0000-0000-0000-0000000b1dd1');

select is(public.save_hand_analysis((
  select jsonb_agg(jsonb_build_object(
    'hand_id', h, 'analysis_version', 'analysis/3', 'status', 'full', 'hero_seat', 3,
    'pot_type', 'single-raised', 'grade', 'mistake', 'score', 50, 'ev_loss_bb', 0.8, 'ev_loss_pot', 0.05,
    'approximations', '[]'::jsonb, 'decisions', jsonb_build_array(jsonb_build_object(
      'ord', 0, 'action_index', 7, 'street', 'preflop', 'action', 'fold', 'status', 'analysed', 'node', 'n',
      'scenario', 'vs-open', 'source', 'chart', 'grade', 'mistake', 'score', 50, 'ev_loss_bb', 0.8,
      'ev_loss_pot', 0.05, 'freq_diff', 1,
      'options', '[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.2}]'::jsonb,
      'chosen', 0, 'flags', '[]'::jsonb, 'approximations', '[]'::jsonb, 'facing_bet', true, 'pot_bb', 4,
      'facts', '{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}'::jsonb))))
  from unnest(array['00000000-0000-0000-0000-0000000b1d01', '00000000-0000-0000-0000-0000000b1d02',
                    '00000000-0000-0000-0000-0000000b1d03']::uuid[]) h)) ->> 'inserted', '3',
  'three graded hands: cash, tournament, Spin');

-- ------------------------------------------------------------ the kinds --

select is(public.game_kind_formats('cash'), array['cash'], 'cash: the cash format alone');
select is(public.game_kind_formats('tournament'), array['tournament', 'sng', 'spin'],
  'tournament: every chip format');
select is(public.game_kind_formats(null), null::text[], 'no kind: every format');
select throws_ok($$select public.game_kind_formats('both')$$, '22023', null, 'an unknown kind is refused');
select is(
  array[public.filter_formats('{"gameFormat":"sng"}')::text, public.filter_formats('{"gameKind":"cash"}')::text,
        public.filter_formats('{"gameKind":"tournament","gameFormat":"spin"}')::text,
        public.filter_formats('{"gameKind":"tournament","gameFormat":"cash"}')::text,
        coalesce(public.filter_formats('{}')::text, '-')],
  array['{sng}', '{cash}', '{spin}', '{}', '-'],
  'a filter''s formats: the format, else the kind''s; a format outside the kind is none; nothing is every one');

-- ------------------------------------------------------------ readers --

select is(
  array(select (public.analysis_overview(jsonb_build_object('analysisVersion', 'analysis/3') || f) ->> 'hands')::int
        from unnest(array['{}', '{"gameKind":"cash"}', '{"gameKind":"tournament"}', '{"gameFormat":"spin"}',
                          '{"gameKind":"tournament","gameFormat":"cash"}']::jsonb[]) with ordinality u(f, o) order by o),
  array[3, 1, 2, 1, 0],
  'analysis_overview (sums): every hand, cash, the tournaments, a format, a format outside its kind');
select is(
  array(select (public.analysis_hands(jsonb_build_object('analysisVersion', 'analysis/3', 'status', 'full') || f) ->> 'total')::int
        from unnest(array['{}', '{"gameKind":"cash"}', '{"gameKind":"tournament"}']::jsonb[]) with ordinality u(f, o) order by o),
  array[3, 1, 2],
  'analysis_hands (a list filter: the scan): every hand, cash, the tournaments');
select is(
  array(select (public.analysis_leaks(jsonb_build_object('analysisVersion', 'analysis/3') || f) ->> 'graded')::int
        from unnest(array['{}', '{"gameKind":"cash"}', '{"gameKind":"tournament"}']::jsonb[]) with ordinality u(f, o) order by o),
  array[3, 1, 2],
  'analysis_leaks: the graded decisions of every hand, of cash, of the tournaments');
select is(
  array(select (public.analysis_trend(jsonb_build_object('analysisVersion', 'analysis/3') || f, 'month', 'all', 45) -> 'rows' -> 0 ->> 'graded')::int
        from unnest(array['{}', '{"gameKind":"cash"}', '{"gameKind":"tournament"}']::jsonb[]) with ordinality u(f, o) order by o),
  array[3, 1, 2],
  'analysis_trend: a month of every hand, of cash, of the tournaments');
select is(
  array(select (public.analysis_top_leaks(jsonb_build_object('analysisVersion', 'analysis/3') || f, 'all') -> 'sample' ->> 'graded')::int
        from unnest(array['{}', '{"gameKind":"cash"}', '{"gameKind":"tournament"}']::jsonb[]) with ordinality u(f, o) order by o),
  array[3, 1, 2],
  'analysis_top_leaks: every hand, cash, the tournaments');

-- ------------------------------------------------------------- drills --

select is((public.drill_summary('analysis/3') -> 'candidates')::int, 3, 'before a sync: three candidates');
select is(public.sync_drill_items('analysis/3') ->> 'inserted', '3', 'a drill from each Mistake');
select is(
  array[(public.drill_summary('analysis/3') ->> 'items')::int,
        (public.drill_summary('analysis/3', null, 'cash') ->> 'items')::int,
        (public.drill_summary('analysis/3', null, 'tournament') ->> 'items')::int],
  array[3, 1, 2],
  'drill_summary: every drill, cash''s, the tournaments''');
select is(
  array[jsonb_array_length(public.drill_queue('analysis/3', null, false)),
        jsonb_array_length(public.drill_queue('analysis/3', null, false, 20, 'cash')),
        jsonb_array_length(public.drill_queue('analysis/3', null, false, 20, 'tournament'))],
  array[3, 1, 2],
  'drill_queue: every drill, cash''s, the tournaments''');
select is(
  array(select coalesce((select sum((r ->> 'items')::int) from jsonb_array_elements(public.drill_due_by_spot('analysis/3', null, k)) r), 0)::int
        from unnest(array[null, 'cash', 'tournament']) with ordinality u(k, o) order by o),
  array[3, 1, 2],
  'drill_due_by_spot: every drill, cash''s, the tournaments''');

select * from finish();
rollback;

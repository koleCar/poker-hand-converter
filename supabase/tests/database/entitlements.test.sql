-- pgTAP: Rail R6.2, plans and entitlements in the database --
-- `20270908090000_entitlements.sql`.
--
-- What has to hold:
--
--   * the plan fields live on the sealed `profiles`: no client reads or
--     writes them, `profiles_public` does not show them, the settings and
--     the gate list are sealed, and the one writer (`billing_set_plan`) is
--     the service role's;
--   * every gated function opens with its guard, and every function a
--     client may execute is either gated or on this file's free list (a new
--     reader has to be put on one side of the line);
--   * no early users any more (`20271119120000`);
--   * `my_entitlements()` per state, and anon refused;
--   * **enforcement off (the default): nothing changes** - no gated
--     function refuses a Free account, no cap is checked;
--   * enforcement on: a Free account is refused every gated function, its
--     own chart sets and tournament settings, and a save past the cap - at the
--     boundary, the statement whole, duplicates free; basic statistics and
--     desktop sync (free since `20271119110000`) stay open; a Pro account
--     (and its grace states) is allowed everything. The daily caps and the
--     solver flops are `free_tier.test.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(65);

-- Free, Pro, and the Pro states; created a while ago.
insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000062f001', 'ent.free@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000062f002', 'ent.free2@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000062a001', 'ent.pro@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000062a002', 'ent.states@example.com', now(), now() - interval '30 days');

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

-- A small hold'em hand (as `hand_arrivals`).
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
create function pg_temp.web(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('hand_key', 'weplay:' || p_id, 'phf', pg_temp.phf(p_id),
                            'site', 'weplay', 'standard_text', 'Poker Hand #' || p_id);
$$;
create function pg_temp.webs(p_from integer, p_to integer) returns jsonb language sql as $$
  select jsonb_agg(pg_temp.web(i::text) order by i) from generate_series(p_from, p_to) i;
$$;

-- A function called with a typed null for every argument: 'ok' or the
-- SQLSTATE it raised (rolled back either way).
create function pg_temp.call_state(p_sig text) returns text language plpgsql as $$
declare
  v_oid  oid := p_sig::regprocedure;
  v_name text;
  v_args text;
  v_set  boolean;
begin
  select quote_ident(n.nspname) || '.' || quote_ident(p.proname), p.proretset,
         coalesce((select string_agg('null::' || format_type(t, null), ', ' order by o)
                   from unnest(p.proargtypes::oid[]) with ordinality a(t, o)), '')
    into v_name, v_set, v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.oid = v_oid;
  begin
    if v_set then
      execute format('select count(*) from %s(%s)', v_name, v_args);
    else
      execute format('select %s(%s)', v_name, v_args);
    end if;
    raise sqlstate 'ZZ000';
  exception
    when sqlstate 'ZZ000' then return 'ok';
    when others then return sqlstate;
  end;
end;
$$;
-- The gate list, for the client roles (the table itself is sealed).
create temp table gate_list as select function_sig, feature from public.entitlement_gates;
grant select on pg_temp.gate_list to anon, authenticated;

-- The gated functions that refused the caller with PT402 (p_refused), or
-- that did not (not p_refused), each with what it answered.
create function pg_temp.gates(p_refused boolean) returns text[] language plpgsql as $$
declare
  v_out text[] := '{}';
  g record;
  v_got text;
begin
  for g in select e.function_sig from pg_temp.gate_list e order by 1 loop
    v_got := pg_temp.call_state(g.function_sig);
    if (v_got = 'PT402') = p_refused then
      v_out := v_out || (g.function_sig || '=' || v_got);
    end if;
  end loop;
  return v_out;
end;
$$;
-- The SQLSTATE and hint of a statement (null when it ran).
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
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.as_postgres(),
  pg_temp.phf(text), pg_temp.row(text), pg_temp.web(text), pg_temp.webs(integer, integer),
  pg_temp.call_state(text), pg_temp.gates(boolean), pg_temp.refusal(text) to anon, authenticated;

-- ---------------------------------------------------------- the schema --

select is((select array_agg(column_name::text order by column_name) from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles'
              and column_name in ('plan', 'plan_period', 'plan_status', 'current_period_end', 'plan_updated_at',
                                  'early_user', 'early_user_since', 'billing_customer_id', 'billing_subscription_id')),
  array['billing_customer_id', 'billing_subscription_id', 'current_period_end',
        'plan', 'plan_period', 'plan_status', 'plan_updated_at'],
  'profiles carries the plan, its period, status and end and the provider ids (no early-user mark: 20271119120000)');

select ok(not has_any_column_privilege('authenticated', 'public.profiles', 'select, insert, update, references')
          and not has_any_column_privilege('anon', 'public.profiles', 'select, insert, update, references')
          and not has_table_privilege('authenticated', 'public.profiles', 'delete'),
  'profiles stays sealed: no client privilege on any column');

select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles_public'),
  array['id', 'username', 'username_lower', 'karma', 'joined_on'],
  'profiles_public shows none of it');

select ok(not has_any_column_privilege('authenticated', 'public.billing_settings', 'select, insert, update')
          and not has_any_column_privilege('anon', 'public.billing_settings', 'select, insert, update')
          and not has_any_column_privilege('authenticated', 'public.plan_limits', 'select, insert, update')
          and not has_any_column_privilege('anon', 'public.plan_limits', 'select, insert, update')
          and not has_any_column_privilege('authenticated', 'public.entitlement_gates', 'select, insert, update')
          and not has_any_column_privilege('anon', 'public.entitlement_gates', 'select, insert, update'),
  'the settings, the plans and the gate list are sealed');

select ok(not has_function_privilege('authenticated', 'public.billing_set_plan(uuid, text, text, text, timestamptz, text, text)', 'execute')
          and not has_function_privilege('anon', 'public.billing_set_plan(uuid, text, text, text, timestamptz, text, text)', 'execute')
          and has_function_privilege('service_role', 'public.billing_set_plan(uuid, text, text, text, timestamptz, text, text)', 'execute'),
  'billing_set_plan is the service role''s only (R6.3''s webhook)');

select ok(not has_function_privilege('authenticated', 'public.has_entitlement(uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.has_entitlement(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_plan_state(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_stored_hands(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_plan_limits(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.solver_flops_of(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.entitlement_gates_apply()', 'execute'),
  'what takes an owner (an oracle on other accounts'' plans) and the maintenance functions: no client');

select ok(has_function_privilege('authenticated', 'public.my_entitlements()', 'execute')
          and not has_function_privilege('anon', 'public.my_entitlements()', 'execute')
          and has_function_privilege('authenticated', 'public.has_my_entitlement(text)', 'execute')
          and not has_function_privilege('anon', 'public.has_my_entitlement(text)', 'execute'),
  'my_entitlements and has_my_entitlement: signed-in callers only');

select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('billing_plan_state', 'has_entitlement', 'has_my_entitlement', 'require_entitlement',
                                'billing_stored_hands', 'my_entitlements', 'billing_set_plan', 'billing_plan_limits',
                                'solver_flops_of', 'solver_open_flop', 'solver_flops_today',
                                'hands_enforce_plan', 'entitlement_row_guard')
              and not (p.prosecdef and p.proconfig @> array['search_path=""'])),
  null, 'every new definer pins search_path to empty');

select is((select enforcement_enabled::text || '/' || free.hand_cap || '/' || coalesce(pro.hand_cap::text, 'unlimited') || '/'
                  || array_to_string(pro.features, ',') || '/' || cardinality(free.features)
             from public.billing_settings, public.plan_limits free, public.plan_limits pro
            where free.plan = 'free' and pro.plan = 'pro'),
  'false/10000/unlimited/desktop_sync,hud,reports_full,analysis,learn,solver_unlimited,nodelock/1',
  'enforcement is off by default; Free holds 10 000 hands and has desktop sync only; Pro is unlimited with all seven');

select pg_temp.act_as('00000000-0000-0000-0000-00000062f001');
select throws_ok($$ update public.profiles set plan = 'pro' where id = auth.uid() $$, '42501',
  null, 'a client cannot give itself Pro');
select throws_ok($$ select public.billing_set_plan(auth.uid(), 'pro') $$, '42501',
  null, '... not through the writer either');
select pg_temp.as_postgres();

-- ------------------------------------------------------------ the gates --

select is((select array_agg(e.function_sig order by 1) from public.entitlement_gates e
            where (select count(*) from regexp_matches(pg_get_functiondef(e.function_sig::regprocedure),
                     E'\n[ \t]*begin[ \t]*\n  perform public\\.require_entitlement\\(''' || e.feature || E'''\\);', 'gi')) <> 1
               or (select count(*) from regexp_matches(pg_get_functiondef(e.function_sig::regprocedure),
                     'require_entitlement\(', 'g')) <> 1),
  null, 'every gated function opens with its guard, once (a re-created function must keep the line)');

-- The line between Free and Pro, for every function a client may execute.
-- A new client-callable function fails this until it is put on one side:
-- a row in `entitlement_gates` (Pro) or a name here (free).
select is((select array_agg(distinct p.proname::text order by p.proname::text) from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
              and has_function_privilege('authenticated', p.oid, 'execute')
              and not exists (select 1 from public.entitlement_gates e where e.function_sig::regprocedure = p.oid)
              and p.proname not in (
                -- forum, moderation, identity, notifications, publishing, sharing
                'admin_create_board', 'admin_purge', 'admin_set_board_moderator', 'admin_set_role',
                'can_moderate_board', 'can_moderate_post', 'create_comment', 'create_poll_post', 'create_post',
                'create_share', 'delete_comment', 'delete_post', 'edit_comment', 'edit_post', 'forum_author_hidden',
                'forum_best_rank', 'forum_board_counts', 'forum_controversy', 'forum_feed', 'forum_fingerprint', 'forum_hot_rank',
                'forum_post_is_poll',
                'forum_path_segment', 'forum_post_json', 'forum_slugify', 'get_post', 'get_post_comments',
                'get_revisions', 'is_admin', 'is_board_moderator', 'is_moderator', 'mark_notifications_read',
                'mod_ban', 'mod_edit_post_title', 'mod_queue', 'mod_resolve_report', 'mod_set_comment_status',
                'mod_set_post_flags', 'mod_set_post_status', 'mod_set_published_hand_status', 'mod_shadowban',
                'mod_spam_queue', 'mod_unban', 'mod_user', 'mod_vote_overlap_for', 'moderation_actions_append_only',
                'my_comment_votes', 'my_notifications', 'my_post_state', 'my_post_votes', 'my_profile',
                'my_published_hand_ids', 'my_saved_posts', 'poll_hides_answer', 'poll_post_of_hand', 'poll_public',
                'post_status', 'publish_hand', 'published_hand_status', 'published_hands_by_author', 'read_poll',
                'read_published_hand', 'read_share', 'record_share_view', 'report_content', 'resolve_share',
                'resolve_username', 'save_post', 'search_forum', 'set_share_names', 'set_thread_subscription',
                'set_username', 'share_names_state', 'unpublish_hand', 'unread_notification_count', 'vote_comment',
                'vote_poll', 'vote_post',
                -- the library (under the cap) and the converter's failure registry
                'get_hand', 'ingest_hands', 'library_count', 'library_facets', 'library_list', 'library_page',
                'library_result', 'library_rows', 'library_size', 'library_stack', 'library_stake', 'rail_stack_bucket',
                'library_table_names', 'library_where', 'library_beyond_rollups', 'library_builder_where',
                'library_builder_ids', 'library_act_sql', 'library_number', 'record_conversion_failures',
                'register_web_hand_source', 'save_hands',
                'search_hands', 'unparsed_summary', 'normalize_cards', 'normalize_positions', 'is_card_array',
                'is_position_array',
                -- basic statistics and their upkeep; notes
                'report_open', 'report_graph', 'report_facets', 'report_hand_ids', 'stats_coverage', 'stats_empty_graph',
                'stats_ev_missing', 'hands_needing_stats', 'save_hand_stats', 'save_hand_ev',
                'save_hand_facts', 'hand_facts_missing',
                'hand_stats_ev_normalize', 'prune_hand_stats', 'prune_villain_stats', 'refresh_report_summaries',
                'my_player_notes', 'set_player_note',
                -- a shared analysis is read by anyone; switching one's own share and pruning stay free
                'read_shared_analysis', 'analysis_share_state', 'set_analysis_share', 'prune_hand_analysis',
                -- the desktop app signs in with any plan (it reads its entitlements after)
                'claim_desktop_sign_in',
                -- pure helpers: no table, or a date of the caller's own rows
                'analysis_best_action', 'analysis_chosen_action', 'analysis_filter_of', 'analysis_filter_rows_ok',
                -- the Hands list's hands for an analysis reader (the readers themselves are gated)
                'analysis_hand_ids',
                'analysis_filter_sums_ok', 'analysis_grade_rank', 'analysis_hand_table_set', 'analysis_leak_table_of', 'analysis_leak_pot_of',
                'analysis_trimmed_phf',
                'analysis_month_of', 'analysis_spot_key',
                'analysis_street_bit', 'analysis_version_of', 'drill_keys_valid', 'drill_next', 'drill_quality',
                'filter_formats', 'game_kind_formats',
                -- Analytics (20271122090000): the checker's filter readers (the readers themselves are gated)
                'analytics_membership_version_of', 'analytics_pot_kind_of',
                'preflop_chart_key_ok', 'preflop_chart_node_key', 'preflop_chart_nodes_problem',
                'preflop_chart_seats', 'preflop_chart_set_table', 'preflop_chart_window', 'preflop_class_index',
                'preflop_decision_fields', 'study_week', 'study_week_valid',
                -- R5.5: the settings validator is pure (immutable, no table) and
                -- answers the shape before a save; the writes it checks are gated
                -- by `tournament_settings_entitlement`
                'tournament_settings_problem',
                -- the entitlements themselves
                -- the admin page (20271119100000): each refuses a non-admin itself
                'admin_feedback', 'admin_feedback_counts', 'admin_feedback_set_status', 'admin_user', 'admin_users',
                'my_entitlements', 'has_my_entitlement', 'require_entitlement',
                -- the solver's daily flops: open to every plan, counted for a capped one
                'solver_open_flop', 'solver_flops_today',
                -- R6.4: whether enforcement is on, for an app with no account (the switch only)
                'billing_enforced',
                -- R6.5: every account may export its data and delete itself
                'export_my_manifest', 'export_my_profile', 'export_my_hands', 'export_my_rows', 'export_my_sealed',
                'account_export_page', 'account_export_entry', 'account_export_charge',
                'begin_account_deletion', 'my_account_deletion',
                -- hand deletion (20271119200000): every plan deletes its own hands
                'delete_hands', 'delete_hands_by_key', 'delete_all_hands', 'hand_tombstones_since',
                -- the Pro waitlist (20271119210000): anyone may join; the admin list refuses non-admins
                'join_pro_waitlist', 'my_pro_waitlist', 'admin_pro_waitlist')),
  null, 'every client-callable function is gated or named free here');

select is((select string_agg(feature || ':' || n, ' ' order by feature)
             from (select feature, count(*) as n from public.entitlement_gates group by 1) x),
  'analysis:60 desktop_sync:3 learn:3 reports_full:6',
  'the gate list: 60 analysis (20271116090000: the trainer''s sessions; 20271119250000: the Multiway and Bomb pots pages; 20271122090000: the Analytics checker; 20271122100000: the Pool tab), 3 desktop sync, 3 learn, 6 full reports');

-- ---------------------------------------------------------- early users --

select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('billing_mark_early_users', 'profiles_mark_early_user'))
          + (select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'billing_settings' and column_name like 'early_user%'),
  0, 'no early users: the marking functions and the settings are gone (20271119120000)');

-- --------------------------------------------------- enforcement is off --

select pg_temp.act_as('00000000-0000-0000-0000-00000062f001');
select is(public.my_entitlements() - 'checkedAt' - 'usage' - 'subscription',
  jsonb_build_object(
    'plan', 'pro', 'reason', 'not_enforced', 'enforced', false,
    'features', jsonb_build_object('library_unlimited', true, 'hand_cap', null, 'desktop_sync', true, 'hud', true,
                                   'reports_full', true, 'analysis', true, 'learn', true,
                                   'solver_unlimited', true, 'nodelock', true),
    'limits', jsonb_build_object('freeHandCap', 10000, 'dailyHandCap', null, 'dailyFlopCap', null),
    'validUntil', null, 'graceUntil', null, 'offlineGraceDays', 14),
  'off: a Free account''s effective plan is Pro, every feature, no cap');
select is(public.my_entitlements() -> 'subscription' ->> 'plan', 'free', '... its own plan is still Free');
select ok(not (public.my_entitlements() ? 'earlyUser'), '... and there is no early-user state');
select ok(public.has_my_entitlement('analysis') and public.has_my_entitlement('desktop_sync'),
  'has_my_entitlement: everything while off');

select is(pg_temp.gates(true), '{}'::text[], 'off: no gated function refuses a Free account (PT402)');

select pg_temp.as_postgres();
update public.plan_limits set hand_cap = 3 where plan = 'free';
select pg_temp.act_as('00000000-0000-0000-0000-00000062f001');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 5)) $$, 'off: a Free account saves past the cap');
select is((public.my_entitlements() -> 'usage' ->> 'handsStored')::int, 5, 'usage counts its stored hands');
select lives_ok($$
  select public.ingest_hands(public.register_hand_source('00000000-0000-0000-0000-0000006200d1', 'f1'),
                             jsonb_build_array(pg_temp.row('d1')))
$$, 'off: a Free account syncs from the desktop');
select pg_temp.as_postgres();
insert into public.hud_layouts (owner_id, kind, key, body, updated_at) values
  ('00000000-0000-0000-0000-00000062f001', 'room_setting', 'pokerstars', '{"preferredSeat": true}', 1),
  ('00000000-0000-0000-0000-00000062a001', 'room_setting', 'pokerstars', '{"preferredSeat": true}', 1);
select pg_temp.act_as('00000000-0000-0000-0000-00000062f001');
select is((select count(*)::int from public.hud_layouts), 1, 'off: a Free account reads its HUD layouts');

-- ---------------------------------------------------- enforcement is on --

select pg_temp.as_postgres();
update public.billing_settings set enforcement_enabled = true;
select public.billing_set_plan('00000000-0000-0000-0000-00000062a001', 'pro', 'month', 'active', now() + interval '20 days');

select pg_temp.act_as('00000000-0000-0000-0000-00000062f001');
select is(public.my_entitlements() - 'checkedAt' - 'usage' - 'subscription',
  jsonb_build_object(
    'plan', 'free', 'reason', 'free', 'enforced', true,
    'features', jsonb_build_object('library_unlimited', false, 'hand_cap', 3, 'desktop_sync', true, 'hud', false,
                                   'reports_full', false, 'analysis', false, 'learn', false,
                                   'solver_unlimited', false, 'nodelock', false),
    'limits', jsonb_build_object('freeHandCap', 3, 'dailyHandCap', 500, 'dailyFlopCap', 3),
    'validUntil', null, 'graceUntil', null, 'offlineGraceDays', 14),
  'on: a Free account is Free, with the caps; desktop sync is free');
select ok(not public.has_my_entitlement('analysis'), 'has_my_entitlement agrees');

select is((select array_agg(x order by x) from unnest(pg_temp.gates(false)) x
            where split_part(x, '=', 1) not in (select g.function_sig from pg_temp.gate_list g where g.feature = 'desktop_sync')),
  null, 'on: every gated function but desktop sync''s refuses a Free account with PT402');
select is(pg_temp.refusal($$ select public.report_situations('{}') $$), 'PT402:reports_full',
  '... with the feature as the hint');
select is((select array_agg(f || '=' || pg_temp.call_state(f)) from unnest(array[
             'public.report_open(jsonb)', 'public.report_graph(jsonb,integer)', 'public.report_facets(jsonb)',
             'public.stats_coverage(text)', 'public.hands_needing_stats(text,uuid,integer,boolean,text,text)',
             'public.library_count()', 'public.library_page(jsonb,jsonb,integer)']) f
            where pg_temp.call_state(f) = 'PT402'),
  null, 'basic statistics and the library stay open to Free');

-- The cap, at the boundary: a fresh Free account, cap 3.
select pg_temp.act_as('00000000-0000-0000-0000-00000062f002');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 2)) $$, 'two hands: under the cap');
select is(pg_temp.refusal($$ select public.save_hands(pg_temp.webs(3, 4)) $$), 'PT402:hand_cap',
  'two more would make four: refused');
select is(public.library_count(), 2::bigint, '... the statement whole: still two');
select lives_ok($$ select public.save_hands(pg_temp.webs(3, 3)) $$, 'the third: exactly at the cap');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 3)) $$, 'all duplicates at the cap: nothing stored, nothing refused');
select is(pg_temp.refusal($$ select public.save_hands(pg_temp.webs(4, 4)) $$), 'PT402:hand_cap', 'the fourth: refused');
select is(pg_temp.refusal($$ insert into public.hands (owner_id, hand_key, phf, standard_text, site, game_format,
                                 currency, currency_minor_units, small_blind, big_blind, played_at, origin)
                               values (auth.uid(), 'weplay:direct', pg_temp.phf('direct'), 'Poker Hand #direct',
                                       'weplay', 'cash', 'USD', 100, 50, 100, now(), 'web') $$),
  'PT402:hand_cap', '... by a direct insert too');
select is(pg_temp.refusal($$ select public.ingest_hands(public.register_web_hand_source(),
                                                        jsonb_build_array(pg_temp.row('u4'))) $$),
  'PT402:hand_cap', '... and by the web''s bulk upload');
do $$
declare v_detail text;
begin
  perform public.save_hands(pg_temp.webs(9, 9));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  perform set_config('ent.detail', v_detail, true);
end;
$$;
select is(current_setting('ent.detail')::jsonb, '{"cap": 3, "stored": 3, "attempted": 1}'::jsonb,
  'the refusal says the cap, what is stored and what was attempted');
select is((public.my_entitlements() -> 'usage' ->> 'handsStored')::int, 3, 'usage: three of three');

select pg_temp.act_as('00000000-0000-0000-0000-00000062f001');
select is(pg_temp.refusal($$ select public.ingest_hands(
             (select s.id from public.hand_sources s where s.owner_id = auth.uid() and s.kind <> 'web'),
             jsonb_build_array(pg_temp.row('d2'))) $$),
  'PT402:hand_cap', 'a Free account''s desktop sync is not refused for the plan, only by the full library');
select is((select count(*)::int from public.hud_layouts), 1, 'a Free account reads its HUD layouts (desktop sync is free)');
select is(pg_temp.refusal($$ insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                               values ('Mine', 'cash', 6, 80, 120) $$),
  'PT402:analysis', 'a Free account cannot write an own chart set');
select is(pg_temp.refusal($$ insert into public.tournament_settings (site, tournament_id, settings)
                               values ('weplay', 't1', '{}') $$),
  'PT402:analysis', 'nor tournament settings (ICM grading)');

-- Pro: everything, past the cap.
select pg_temp.act_as('00000000-0000-0000-0000-00000062a001');
select is(public.my_entitlements() ->> 'plan', 'pro', 'on: a paying account is Pro');
select is(pg_temp.gates(true), '{}'::text[], 'on: no gated function refuses it');
select lives_ok($$ select public.save_hands(pg_temp.webs(1, 6)) $$, 'it saves past the Free cap');
select lives_ok($$
  select public.ingest_hands(public.register_hand_source('00000000-0000-0000-0000-0000006200d2', 'f1'),
                             jsonb_build_array(pg_temp.row('d3')))
$$, 'it syncs from the desktop');
select is((select count(*)::int from public.hud_layouts), 1, 'it reads its HUD layouts');
select lives_ok($$ insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                   values ('Mine', 'cash', 6, 80, 120) $$, 'it writes own chart sets');
select lives_ok($$ insert into public.tournament_settings (site, tournament_id, settings)
                   values ('weplay', 't1', '{}') $$, 'and tournament settings');

-- The plan states (enforcement on).
create function pg_temp.state_of(p_plan text, p_status text, p_end timestamptz) returns text language plpgsql as $$
begin
  perform pg_temp.as_postgres();
  perform public.billing_set_plan('00000000-0000-0000-0000-00000062a002', p_plan, 'year', p_status, p_end);
  perform pg_temp.act_as('00000000-0000-0000-0000-00000062a002');
  return (select e ->> 'plan' || '/' || (e ->> 'reason') || '/' || (e ->> 'graceUntil' is not null)::text
            from public.my_entitlements() e);
end;
$$;
grant execute on function pg_temp.state_of(text, text, timestamptz) to authenticated;
select is(pg_temp.state_of('pro', 'trialing', now() + interval '5 days'), 'pro/subscription/false', 'trialing: Pro');
select is(pg_temp.state_of('pro', 'active', now() - interval '2 days'), 'pro/grace/true',
  'active, the renewal late (2 days past the end): Pro in grace');
select is(pg_temp.state_of('pro', 'past_due', now() - interval '3 days'), 'pro/grace/true', 'past due within 7 days: Pro in grace');
select is(pg_temp.state_of('pro', 'past_due', now() - interval '8 days'), 'free/expired/false', 'past due past the grace: Free');
select is(pg_temp.state_of('pro', 'canceled', now() + interval '3 days'), 'pro/canceled_until_period_end/false',
  'canceled: Pro to the end of the paid period ...');
select is(pg_temp.state_of('pro', 'canceled', now() - interval '1 day'), 'free/expired/false', '... and Free after it');
select is(pg_temp.state_of('pro', null, null), 'pro/granted/false', 'granted by hand, no end: Pro');
select is(pg_temp.state_of('free', null, null), 'free/free/false', 'Free: Free');
select is(pg_temp.refusal($$ select public.analysis_overview('{}') $$), 'PT402:analysis', '... and refused');

-- Anyone else.
select pg_temp.act_as_anon();
select throws_ok($$ select public.my_entitlements() $$, '42501', null, 'anon: my_entitlements refused');
select throws_ok($$ select public.require_entitlement('analysis') $$, '42501', null,
  'anon: the guard refuses (sign in)');
select pg_temp.as_postgres();
select lives_ok($$ select public.require_entitlement('analysis') $$, 'plain SQL (no user, no client role) passes the guard');
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
set local role service_role;
select lives_ok($$ select public.require_entitlement('analysis') $$, 'the service role (no user) passes the guard');
select pg_temp.as_postgres();

-- Off again: the Free account is back to everything.
update public.billing_settings set enforcement_enabled = false;
select pg_temp.act_as('00000000-0000-0000-0000-00000062f002');
select lives_ok($$ select public.save_hands(pg_temp.webs(4, 8)) $$, 'off again: the cap is not checked');
select is(pg_temp.gates(true), '{}'::text[], 'off again: nothing refused');

select * from finish();
rollback;

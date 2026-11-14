-- ===========================================================================
-- Rail: GTO Wizard chart sets - an ante set's preflop decisions are filed
-- ===========================================================================
--
-- `charts/11` (`analysis/41`): every preflop range is a GTO Wizard solution,
-- transcribed, and hands where every seat posts an ante are graded on ante
-- sets, `nlhe-cash-{6,9}max-<depth>bb-ante` (`web/src/lib/charts/registry.ts`).
-- Their seats are the plain tables' seats, so a decision graded on one is a
-- situation of the user's own charts like any other (R5.3,
-- `20270811100000_preflop_charts_compare.sql`).
--
-- What changes:
--
--   * `preflop_chart_set_table(p_set)`: re-created as `20270901090000` wrote
--     it, a plain set's id now optionally ending in `-ante`. The straddle set
--     (`-straddle`) still has no table. `preflop_chart_node_key` and
--     `preflop_decision_fields` read it, so an ante set's line gets its
--     situation key and table and its decisions reach `preflop_chart_played`.
--     Still immutable, empty search_path, executable as before.
--
-- Not changed: no table, grant, RLS policy or other function. The leak rows'
-- table (`analysis_hand_table_set`) keeps its table-and-depth list: a hand's
-- table there is a bucket for the leak list's table filter, not the set it
-- was graded on, so an ante hand's postflop rows file under the plain set
-- of its table and depth, as before. Grades change with `analysis/41`,
-- written by the clients' rebuild.
-- ===========================================================================

begin;

-- The table size of a shipped set (plain or ante), or of the push/fold game's chart tables, by id; null for anything else.
create or replace function public.preflop_chart_set_table(p_set text)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_set ~ '^nlhe-cash-6max-[0-9]{1,3}bb(-ante)?$' then 6::smallint
    when p_set ~ '^nlhe-cash-9max-[0-9]{1,3}bb(-ante)?$' then 9::smallint
    when p_set ~ '^nlhe-cash-hu-[0-9]{1,3}bb$' then 2::smallint
    when p_set = 'icm-pushfold-6max' then 6::smallint
    when p_set = 'icm-pushfold-9max' then 9::smallint
    when p_set = 'icm-pushfold-hu' then 2::smallint
  end;
$$;

commit;

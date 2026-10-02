-- Hand analysis, phase A9: multiway postflop (`docs/ANALYSIS-PLAN.md` §7, §10).
--
-- `analysis/7` stores two new things, both in existing columns:
--
--   * an approximate grade (`source = 'approx'`): a multiway river call or
--     fold graded by its showdown EV against narrowed ranges, capped at
--     Mistake and labelled approximate. The `decision_analysis.source` check
--     named three sources; it now names four.
--   * the multiway facts (`facts.multiway`: each opponent's range and the
--     field's equity, the MDF split, fold equity, the next card's outs, the
--     approximate EV). A shared analysis projects facts by a list of known
--     keys (`analysis_public_facts`, A7.1); `multiway` joins it, so a shared
--     multiway decision shows the same facts its owner sees.
--
-- No new table, grant, policy or function signature: the writer is still
-- `save_hand_analysis` (definer, as the caller), the reads are unchanged.

alter table public.decision_analysis drop constraint if exists decision_analysis_source_check;
alter table public.decision_analysis
  add constraint decision_analysis_source_check check (source in ('chart', 'solver', 'heuristic', 'approx'));

create or replace function public.analysis_public_facts(p_facts jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p_facts) = 'object' then p_facts else '{}'::jsonb end) f
  where f.key = any (array[
    'street', 'position', 'inPosition', 'players', 'scenario', 'preflopScenario', 'role', 'facing',
    'potBb', 'toCallBb', 'heroStackBb', 'effStackBb', 'spr', 'potOdds', 'mdf', 'facingPot', 'betPot',
    'behindBb', 'allIn', 'holeCards', 'handClass', 'board', 'texture', 'made', 'draws', 'blockers',
    'equity', 'chart', 'river', 'turn', 'flop', 'multiway'
  ]);
$$;

revoke all on function public.analysis_public_facts(jsonb) from public, anon, authenticated;

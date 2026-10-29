-- ===========================================================================
-- Rail: the trainer keeps flop answers (`trainer_results.mode = 'flop'`)
-- ===========================================================================
--
-- The Train tab gains a flop mode (`docs/ANALYSIS-PLAN.md` §10, 2026-10-28):
-- a heads-up flop dealt from Rail's flop library, graded by the analysis
-- exactly as Learn L2's flop exercises are. Signed in, each graded answer is
-- kept like the preflop and river trainers' (`20270208090000_analysis_training.sql`):
-- mode `flop`, family the pot type, spot the library line id, the hero's seat
-- and hand class, the grade, EV loss and score.
--
-- What changes: the mode check on `trainer_results` takes `flop` beside
-- `preflop`, `river` and `drill`. Nothing else:
--
--   * `record_trainer_results` (security definer, `auth.uid()` as the owner,
--     at most 50 rows, `enforce_rate_limit`, the R6.2 entitlement gate) never
--     names a mode - "the table's checks validate every column" - so it is
--     left as it is, gate and grants included. Re-creating it here would have
--     to re-apply the gate (`entitlement_gates_apply`) for nothing.
--   * `trainer_summary` (invoker, RLS) groups by whatever mode a row has, so
--     flop answers appear as their own row without a change.
--   * The account export (`learning/trainer_results.ndjson`) copies the table's
--     rows whatever their mode.
--   * Grants, RLS and policies are untouched: still select-own for
--     `authenticated`, nothing for `anon`, no client INSERT / UPDATE / DELETE.
--
-- Additive: the new check is a superset of the old one, so every stored row
-- passes it (the `add constraint` validates them) and nothing is deleted.
-- ===========================================================================

begin;

alter table public.trainer_results drop constraint if exists trainer_results_mode_check;
alter table public.trainer_results
  add constraint trainer_results_mode_check check (mode in ('preflop', 'flop', 'river', 'drill'));

comment on table public.trainer_results is
  'Every graded trainer answer (preflop, flop, river, drill). Written only by record_trainer_results.';

commit;

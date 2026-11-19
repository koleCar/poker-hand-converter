-- The entitlement gates of the pot-kind work (CI on batch #397, 2026-11-19):
--
-- - 20271119240000_analysis_heads_up.sql re-created seven gated analysis
--   readers from bodies written before the gates (20270908090000), so they
--   lost their `perform public.require_entitlement('analysis')` line;
--   `entitlement_gates_apply()` puts it back (it skips a function that has it).
-- - 20271119230000_analysis_pot_kinds.sql's three readers open with the
--   guard already; they join the gate list, as every analysis reader is Pro.

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.analysis_bomb_hands(text,timestamp with time zone,uuid,integer)', 'analysis', 'the Bomb pots page'),
  ('public.analysis_multiway_summary(text,text)', 'analysis', 'the Multiway page'),
  ('public.analysis_pot_kind_decisions(text,text,integer)', 'analysis', 'the Multiway and Bomb pots pages')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

select public.entitlement_gates_apply();

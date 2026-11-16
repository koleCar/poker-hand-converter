-- hand_facts in the account data inventory.
--
-- 20271116130000_hand_facts.sql added an owner table without an inventory
-- row, so account_data.test.sql (every table with an account column decides
-- export and deletion) failed. Like the analysis summaries, it is derived:
-- rebuilt from the hands' PHF, which is exported, and it cascades from
-- auth.users on owner_id (and from hands on hand_id).

begin;

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.hand_facts', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'The filter builder''s facts of each hand, per facts version. Derived from the PHF of hands.')
on conflict (name) do nothing;

commit;

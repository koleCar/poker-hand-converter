-- Rail R4.2: bulk upload (docs/RAIL-PLAN.md R4.2), part 1 of 2.
--
-- A new value of `hand_origin`: `upload`, a hand the web's converter saved in
-- bulk through `ingest_hands` from the account's web source. The value is
-- added in a migration of its own because Postgres refuses to use an enum
-- value in the transaction that adds it, and the next migration's CHECK
-- constraint and function use it.

alter type public.hand_origin add value if not exists 'upload';

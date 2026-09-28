-- ============================================================================
-- Widen `hands.hero_hand_class` to hold an Omaha starting-hand class.
-- ============================================================================
--
-- `20260916190000_phf_baseline.sql` wrote the guard for a Hold'em-only app:
--
--     constraint hands_hand_class_ok
--       check (hero_hand_class is null or hero_hand_class ~ '^[2-9TJQKA]{2}[so]?$')
--
-- Two rank characters and an optional `s` / `o`. That is exactly right for
-- `AKs`, `AKo`, `TT` - and it cannot express a hand with four, five or six hole
-- cards, so it blocks the Omaha hand class outright. `hands_hero_cards_ok`
-- already allows `cardinality(hero_cards) <= 6`; this is the one place in the
-- schema that still assumes two.
--
-- ## The Omaha form
--
-- `frontend/src/lib/cards.ts` -> `omahaHandClass()`. Ranks high to low, then a
-- dash, then the sizes of the suit groups holding two or more cards, largest
-- first, or `r` when every suit is a singleton:
--
--     AhKhQdJd   -> 'AKQJ-22'     double suited
--     AhKhQdJc   -> 'AKQJ-2'      single suited
--     AhKsQdJc   -> 'AKQJ-r'      rainbow
--     AhKhQhJc   -> 'AKQJ-3'      three of a suit
--     AhKhQdJdTc -> 'AKQJT-22'    five-card Omaha, same rules
--
-- The Hold'em form is unchanged and keeps its own branch; `handClass()` still
-- produces `AKs` for two cards and nothing about the rows already stored moves.
--
-- ## Why a new file rather than an edit
--
-- `20260916190000` has been applied. Editing an applied migration makes the
-- file disagree with every database that ran it, so the check is replaced here
-- instead. The replacement is a strict superset of the old pattern - every
-- value that satisfied the old one satisfies the new one - so the constraint
-- validates against the existing rows without a rewrite and without a window in
-- which the column is unguarded.
--
-- This is still a *shape* guard, in the spirit of its neighbours in that file:
-- it says "this is a hand class and not a paragraph", not "these ranks could
-- have been dealt". `[2-6]{1,3}` therefore accepts a suffix like `65` that no
-- real hand produces, the same way `hands_max_seats_ok` accepts a 23-seat
-- table. The canonical form is the serializer's job; the constraint's job is to
-- keep junk and unbounded text out of an indexed column.
--
-- Not applied to `public.stored_hands`: that table's `hero_hand_class` never
-- had a check constraint, only an index, so it already accepts the new form.
-- ============================================================================

alter table public.hands
  drop constraint if exists hands_hand_class_ok;

alter table public.hands
  add constraint hands_hand_class_ok check (
    hero_hand_class is null
    -- Hold'em / short deck: 'AA', 'AKs', 'AKo'.
    or hero_hand_class ~ '^[2-9TJQKA]{2}[so]?$'
    -- Omaha, 4-6 hole cards: 'AKQJ-22', 'AKQJ-r', 'AKQJT9-222'.
    or hero_hand_class ~ '^[2-9TJQKA]{4,6}-(r|[2-6]{1,3})$'
  );

comment on column public.hands.hero_hand_class is
  'Canonical starting-hand class. Two cards: AKs / AKo / TT. Four to six cards '
  '(Omaha): ranks high to low, a dash, then the sizes of the suit groups of two '
  'or more (AKQJ-22 is double suited), or r for rainbow. Null when the variant '
  'has no meaningful starting-hand class.';

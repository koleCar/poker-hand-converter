-- ============================================================================
-- hand_stats: one row per (hand, dealt-in seat), and the two reports over it.
-- ============================================================================
--
-- The statistics engine is split down the middle: all **semantics** live in
-- TypeScript (`frontend/src/lib/stats/**`, specified in `docs/STATS-SPEC.md`),
-- all **arithmetic** lives here. A pure function turns one `PhfHand` into N
-- flat rows of integer counters; nothing in this file does more than `sum()`,
-- `group by` and `ntile()`.
--
-- That split is not an aesthetic preference. `backend/test/` runs 3000+
-- assertions over 524 real hand-history files from nineteen rooms, and a
-- `plpgsql` definition of "3-bet" cannot be tested that way -- while the stat
-- definitions are precisely the code that most needs it, because every one of
-- them is a place PokerTracker 4 and Holdem Manager 3 disagree. Add to that the
-- cost (a VPIP computed over `hands.phf` detoasts a 5-50 KB jsonb document per
-- hand) and the fact that the continuation-bet chain is a stateful walk that
-- becomes three nested window functions per street in SQL, and the line falls
-- where it falls.
--
-- **Consequence: no rate is ever stored.** A stored percentage cannot be
-- combined with a second sample, which is the one thing a stats table has to be
-- able to do. Rows carry `made` and `opp`; the division happens at read time.
--
-- ## Why one row per seat rather than one row per hero
--
-- Hero-only is a one-way door. Opponent statistics -- a HUD, a player report,
-- "how often does this regular fold to a 3-bet" -- are the obvious next feature,
-- and a hero-only table cannot grow into them without rewriting every row.
--
-- Per-player, on the other hand, multiplies the row count by about six, and at
-- 500k hands that is ~3M rows which does not fit the free tier.
--
-- So the *schema* supports per-player from day one and the *writer* emits hero
-- rows only, until a setting turns villains on. Turning them on is then a
-- client change, not a migration -- which is the whole point.
--
-- **Villain rows are never written for `site_anonymization = 'positional'`.**
-- An Ignition "UTG+1" is a different human every hand, so a per-player row keyed
-- on that name would silently average strangers together. That is enforced
-- twice -- in the writer and by `hand_stats_positional_anonymity` below, which
-- mirrors `hands_positional_anonymity` from
-- `20260916210000_position_search_and_anonymization.sql`.
--
-- ## Why the invariants are CHECK constraints
--
-- A derivation bug should be a **write failure**, not a wrong report. A wrong
-- report is invisible: `pfr > vpip` is arithmetically fine, renders as a
-- plausible percentage, and simply tells a player something untrue about their
-- game forever. The constraints below turn every structural identity the
-- derivation claims into something the database refuses to store.
--
-- The same reasoning is why a non-binary decision is stored as its **full leg
-- set** (fold + call + raise) rather than as the numerator alone. Facing a bet
-- there are exactly three legal replies, so `fold + call + raise = opp` is an
-- identity a constraint can hold; and it yields three statistics per column
-- group instead of one, at no extra cost.
--
-- ## What this file deliberately does not do
--
--   * **It does not touch `save_hands`.** That function is security-critical
--     and three guards deep (explicit `auth.uid()` in the insert list, the
--     normalizing trigger, the RLS `with check`). Stats get their own writer:
--     the client sends `hand_key`, and `save_hand_stats` resolves it to a
--     `hands.id` as `security invoker`, so the RLS policy on `public.hands`
--     scopes the lookup for free and a caller cannot attach statistics to
--     somebody else's hand. `hands.fast_fold` is filled by the normalizing
--     trigger from `phf` instead, server-side, for the same reason.
--   * **It creates no rollup table.** `docs/DATABASE.md` argues that a deferred
--     denormalization costs exactly the same migration later, and by then you
--     know whether anyone wants it. One composite index carries M1.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. hands.fast_fold
-- ---------------------------------------------------------------------------
--
-- `docs/DATABASE.md` nominates `PhfTable.fastFold` as the strongest remaining
-- denormalization candidate ("add it the moment a UI offers the toggle"), and
-- statistics are that moment: Zoom / Rush & Cash is a strategically different
-- game -- no table image, no history on anyone, a permanent 6-max-ish dynamic --
-- so a win rate that mixes it with regular tables is two populations averaged.
--
-- It is the brand string (`Zoom`, `Rush & Cash`, `Snap`), not a boolean, which
-- makes it a facet as well as a filter.
--
-- Filled **server-side from `phf`**, not from the client payload. `save_hands`
-- projects an explicit column list and is not being touched, so a client-sent
-- `fast_fold` would be dropped on the floor anyway; deriving it in the
-- normalizing trigger means the value is a function of the canonical document
-- and cannot be forged, and it keeps the one security-critical function in this
-- schema out of a change it does not need.

alter table public.hands
  add column if not exists fast_fold text;

alter table public.hands
  drop constraint if exists hands_fast_fold_len;

alter table public.hands
  add constraint hands_fast_fold_len
    check (fast_fold is null or char_length(fast_fold) between 1 and 64);

comment on column public.hands.fast_fold is
  'Fast-fold brand from PhfTable.fastFold (Zoom / Rush & Cash / Snap), or null for a regular table. Derived server-side from phf by hands_normalize().';

-- Backfill. Exactly the pattern `docs/DATABASE.md` documents for a deferred
-- column: `phf` is stored in full, so every denormalization is a backfill away.
-- Guarded on `fast_fold is null` so re-running the file is a no-op rather than
-- a full-table rewrite.
update public.hands h
   set fast_fold = nullif(btrim(h.phf -> 'table' ->> 'fastFold'), '')
 where h.fast_fold is null
   and nullif(btrim(h.phf -> 'table' ->> 'fastFold'), '') is not null;

-- The normalizing trigger, recreated wholesale so the body stays one readable
-- unit (the same convention `20260922130000` used). The only change against
-- that version is the `fast_fold` block.
create or replace function public.hands_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.owner_id := (select auth.uid());
  end if;

  new.hero_cards   := coalesce(public.normalize_cards(new.hero_cards), '{}'::text[]);
  new.board_cards  := coalesce(public.normalize_cards(new.board_cards), '{}'::text[]);
  new.player_names := coalesce(new.player_names, '{}'::text[]);
  new.winners      := coalesce(new.winners, '{}'::text[]);

  new.player_positions   := public.normalize_positions(new.player_positions);
  new.showdown_positions := public.normalize_positions(new.showdown_positions);
  new.winner_positions   := public.normalize_positions(new.winner_positions);

  new.hand_key        := btrim(new.hand_key);
  new.site            := lower(btrim(new.site));
  new.variant         := nullif(lower(btrim(coalesce(new.variant, ''))), '');
  new.limit_type      := nullif(lower(btrim(coalesce(new.limit_type, ''))), '');
  new.tournament_id   := nullif(btrim(coalesce(new.tournament_id, '')), '');
  new.currency        := upper(btrim(new.currency));
  new.hero_name       := nullif(btrim(coalesce(new.hero_name, '')), '');
  new.hero_position   := nullif(upper(btrim(coalesce(new.hero_position, ''))), '');
  new.hero_hand_class := nullif(btrim(coalesce(new.hero_hand_class, '')), '');
  new.table_name      := nullif(btrim(coalesce(new.table_name, '')), '');
  new.stakes_label    := nullif(btrim(coalesce(new.stakes_label, '')), '');
  new.street_reached  := nullif(lower(btrim(coalesce(new.street_reached, ''))), '');
  new.source_filename := nullif(btrim(coalesce(new.source_filename, '')), '');

  -- Read off the canonical document, never off the client's column. A payload
  -- key cannot set it, which is what keeps a filter dimension honest without
  -- widening `save_hands`. `left(...)` rather than a raise: a room inventing a
  -- 200-character brand name should not fail somebody's upload.
  new.fast_fold := left(
    nullif(btrim(coalesce(new.phf -> 'table' ->> 'fastFold', '')), ''),
    64
  );

  if new.player_count is null then
    new.player_count := nullif(cardinality(new.player_names), 0);
    -- A positional-anonymity hand has no names to count, but it does have a
    -- roster of positions, which is the same number.
    if new.player_count is null then
      new.player_count := nullif(cardinality(new.player_positions), 0);
    end if;
  end if;

  -- created_at is server-authoritative; a client cannot backdate a row.
  new.created_at := now();

  return new;
end;
$$;

revoke execute on function public.hands_normalize() from public, anon, authenticated;

create index if not exists hands_fast_fold_idx
  on public.hands (fast_fold, played_at desc nulls last)
  where fast_fold is not null;

-- ---------------------------------------------------------------------------
-- 2. stat_count -- the counter domain
-- ---------------------------------------------------------------------------
--
-- Ninety counter columns. At `integer` that is 360 bytes of every row spent on
-- numbers that never leave single digits; at `smallint` it is 180, and at one
-- row per hand the difference decides whether a library's statistics fit beside
-- the hands they were derived from.
--
-- A domain rather than ninety `check (x >= 0)` constraints, and rather than one
-- `check (least(c1, ..., c90) >= 0)`: `least()` is variadic and Postgres caps a
-- function call at 100 arguments, so that formulation would be six counters away
-- from failing to compile. The domain carries the rule once and keeps carrying
-- it however many counters are added.
--
-- Guarded rather than `create domain if not exists`, which does not exist.

do $domain$
begin
  if not exists (
    select 1
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'stat_count'
  ) then
    create domain public.stat_count as smallint
      constraint stat_count_nonneg check (value >= 0);
  end if;
end
$domain$;

comment on domain public.stat_count is
  'A derived statistics counter: a non-negative count of opportunities or actions in one hand. smallint because none of them can approach 32767 and 90 columns of them are on every row.';

-- ---------------------------------------------------------------------------
-- 3. hand_stats
-- ---------------------------------------------------------------------------
--
-- Dimensions are denormalized onto the row on purpose. A report filters by
-- stake, position, variant, fast-fold brand and date; joining back to
-- `public.hands` for those would put a 5-50 KB TOASTed `phf` document in the
-- path of every aggregate, which is the exact cost the TypeScript/SQL split was
-- drawn to avoid. They are copies of immutable facts about a hand that has
-- already been played, so they cannot drift.
--
-- The primary key is `(hand_id, stats_version, seat)` rather than
-- `(hand_id, seat)`: `stats_version` is bumped whenever a counter changes
-- *meaning*, and rows derived under two different meanings must not be summed
-- together. Keying on it lets a re-derivation land alongside the old rows so the
-- two can be compared before the old ones are dropped, and makes every query in
-- this file state the version it is reading.

create table if not exists public.hand_stats (
  -- ------------------------------------------------------------- identity
  -- `on delete cascade` on both: deleting a hand takes its statistics with it,
  -- and deleting an account takes the library and the statistics together.
  hand_id       uuid not null references public.hands(id)  on delete cascade,
  owner_id      uuid not null references auth.users(id)    on delete cascade,
  stats_version text not null default 'stats/1',
  seat          smallint not null,

  -- ---------------------------------------------------- hand dimensions
  -- `hand_key` is carried as well as `hand_id` because it is what the client
  -- sends: `save_hands` returns counts rather than ids, so the writer resolves
  -- `(owner_id, hand_key)` to a uuid under RLS instead.
  hand_key      text not null,
  site_id       text not null,
  site_hand_id  text,
  played_at     timestamptz,
  variant       text,
  limit_type    text,
  game_format   public.game_format        not null default 'cash',
  -- Carried so the positional-anonymity rule is enforceable on this row alone,
  -- without a join to the hand it came from.
  site_anonymization public.site_anonymization not null default 'none',
  currency      text not null default 'USD',
  currency_minor_units smallint not null default 100,
  small_blind   bigint,
  big_blind     bigint,
  player_count  smallint,
  max_seats     smallint,
  table_name    text,
  tournament_id text,
  fast_fold     text,

  -- Exclusion flags. `is_bomb_pot` is excluded from every aggregate by default
  -- and `has_cashout` from the money series only -- see `stats_summary` below,
  -- and `defaultExclusions` in `frontend/src/lib/stats/rates.ts`, which has to
  -- agree with it.
  has_straddle      boolean not null default false,
  is_bomb_pot       boolean not null default false,
  is_big_blind_ante boolean not null default false,
  is_run_it_twice   boolean not null default false,
  has_cashout       boolean not null default false,
  is_walk           boolean not null default false,

  street_reached text,
  total_pot      bigint,
  house_into_pot bigint,
  fees           bigint,

  -- --------------------------------------------------------- seat identity
  -- `player` is the empty string rather than null for a seat with no name, so
  -- a future per-player group-by never has to decide what null means.
  player   text not null default '',
  is_hero  boolean not null default false,
  position text,
  hole_cards text[] not null default '{}',
  hand_class text,
  starting_stack bigint,
  starting_stack_bb_tenths integer,

  -- ------------------------------------------------------------- counters
  -- Every column below is transcribed from `ZERO_COUNTERS` in
  -- `frontend/src/lib/stats/types.ts`, in declaration order, and
  -- `backend/test/statsDerive.test.ts` asserts a derived row's keys against
  -- that same list. A counter added there without a column here fails a test
  -- rather than being silently dropped on the way to the database.
  --
  -- `public.stat_count` rather than `integer`: 90 columns at two bytes each
  -- instead of four is 180 bytes a row, and at one row per hand that is the
  -- difference between a hero's stats fitting beside their hands on the free
  -- tier and not. Nothing here can approach 32767: every counter but the raw
  -- per-street action counts is 0 or 1, and those are bounded by how many
  -- raises one betting round can physically hold.
  hands                    public.stat_count not null default 0,

  -- Preflop. Every one of these is 0 or 1: a preflop opportunity is counted at
  -- the seat's *first* qualifying decision, so action coming back around does
  -- not count a second one.
  vpip_opp                 public.stat_count not null default 0,
  vpip                     public.stat_count not null default 0,
  pfr_opp                  public.stat_count not null default 0,
  pfr                      public.stat_count not null default 0,
  rfi_opp                  public.stat_count not null default 0,
  rfi                      public.stat_count not null default 0,
  iso_opp                  public.stat_count not null default 0,
  iso                      public.stat_count not null default 0,
  limp_opp                 public.stat_count not null default 0,
  limp                     public.stat_count not null default 0,
  cold_call_opp            public.stat_count not null default 0,
  cold_call                public.stat_count not null default 0,
  three_bet_opp            public.stat_count not null default 0,
  three_bet                public.stat_count not null default 0,
  four_bet_opp             public.stat_count not null default 0,
  four_bet                 public.stat_count not null default 0,
  five_bet_opp             public.stat_count not null default 0,
  five_bet                 public.stat_count not null default 0,
  squeeze_opp              public.stat_count not null default 0,
  squeeze                  public.stat_count not null default 0,
  steal_opp                public.stat_count not null default 0,
  steal                    public.stat_count not null default 0,
  fold_to_steal_opp        public.stat_count not null default 0,
  fold_to_steal            public.stat_count not null default 0,
  call_steal               public.stat_count not null default 0,
  three_bet_vs_steal       public.stat_count not null default 0,
  fold_to_three_bet_opp    public.stat_count not null default 0,
  fold_to_three_bet        public.stat_count not null default 0,
  call_three_bet           public.stat_count not null default 0,
  raise_vs_three_bet       public.stat_count not null default 0,
  fold_to_four_bet_opp     public.stat_count not null default 0,
  fold_to_four_bet         public.stat_count not null default 0,
  call_four_bet            public.stat_count not null default 0,
  raise_vs_four_bet        public.stat_count not null default 0,

  -- Postflop. `*_seen` is "the street was dealt and you had not folded", which
  -- is deliberately not an opportunity -- a player all-in preflop sees every
  -- street and has a decision on none of them.
  flop_seen                public.stat_count not null default 0,
  turn_seen                public.stat_count not null default 0,
  river_seen               public.stat_count not null default 0,
  cbet_flop_opp            public.stat_count not null default 0,
  cbet_flop                public.stat_count not null default 0,
  cbet_turn_opp            public.stat_count not null default 0,
  cbet_turn                public.stat_count not null default 0,
  cbet_river_opp           public.stat_count not null default 0,
  cbet_river               public.stat_count not null default 0,
  fold_to_cbet_flop_opp    public.stat_count not null default 0,
  fold_to_cbet_flop        public.stat_count not null default 0,
  call_cbet_flop           public.stat_count not null default 0,
  raise_cbet_flop          public.stat_count not null default 0,
  fold_to_cbet_turn_opp    public.stat_count not null default 0,
  fold_to_cbet_turn        public.stat_count not null default 0,
  call_cbet_turn           public.stat_count not null default 0,
  raise_cbet_turn          public.stat_count not null default 0,
  fold_to_cbet_river_opp   public.stat_count not null default 0,
  fold_to_cbet_river       public.stat_count not null default 0,
  call_cbet_river          public.stat_count not null default 0,
  raise_cbet_river         public.stat_count not null default 0,
  donk_flop_opp            public.stat_count not null default 0,
  donk_flop                public.stat_count not null default 0,
  donk_turn_opp            public.stat_count not null default 0,
  donk_turn                public.stat_count not null default 0,
  donk_river_opp           public.stat_count not null default 0,
  donk_river               public.stat_count not null default 0,
  check_raise_flop_opp     public.stat_count not null default 0,
  check_raise_flop         public.stat_count not null default 0,
  check_raise_turn_opp     public.stat_count not null default 0,
  check_raise_turn         public.stat_count not null default 0,
  check_raise_river_opp    public.stat_count not null default 0,
  check_raise_river        public.stat_count not null default 0,

  -- Raw postflop action counts, the aggression factor's ingredients. These are
  -- the only counters that routinely exceed 1: a street can be raised back and
  -- forth, and the ratio needs totals rather than "did it happen".
  bet_flop                 public.stat_count not null default 0,
  raise_flop               public.stat_count not null default 0,
  call_flop                public.stat_count not null default 0,
  check_flop               public.stat_count not null default 0,
  fold_flop                public.stat_count not null default 0,
  bet_turn                 public.stat_count not null default 0,
  raise_turn               public.stat_count not null default 0,
  call_turn                public.stat_count not null default 0,
  check_turn               public.stat_count not null default 0,
  fold_turn                public.stat_count not null default 0,
  bet_river                public.stat_count not null default 0,
  raise_river              public.stat_count not null default 0,
  call_river               public.stat_count not null default 0,
  check_river              public.stat_count not null default 0,
  fold_river               public.stat_count not null default 0,

  -- Showdown.
  wwsf_opp                 public.stat_count not null default 0,
  wwsf                     public.stat_count not null default 0,
  wtsd_opp                 public.stat_count not null default 0,
  wtsd                     public.stat_count not null default 0,
  wsd_opp                  public.stat_count not null default 0,
  wsd                      public.stat_count not null default 0,

  -- Flags. `cashed_out` is a counter rather than a boolean so it sums into
  -- "how many of these hands did I sell equity in", which is the number that
  -- decides whether a graph's money series can be trusted at all.
  cashed_out               public.stat_count not null default 0,

  -- ---------------------------------------------------------------- money
  -- PHF minor units, except `net_bb_milli`, which is thousandths of a big
  -- blind so that samples taken at different stakes can be summed. bb/100 is
  -- `sum(net_bb_milli) / 10 / hands`.
  won                      bigint not null default 0,
  contributed              bigint not null default 0,
  net                      bigint not null default 0,
  net_bb_milli             bigint not null default 0,
  rake_paid                bigint not null default 0,
  out_of_pot               bigint not null default 0,
  cashout_risk             bigint not null default 0,

  created_at timestamptz not null default now(),

  primary key (hand_id, stats_version, seat),

  -- --------------------------------------------------------- shape guards
  constraint hand_stats_version_ok  check (stats_version ~ '^stats/[0-9]+$'),
  constraint hand_stats_seat_ok     check (seat between 0 and 24),
  constraint hand_stats_key_len     check (char_length(hand_key) between 1 and 200),
  constraint hand_stats_site_len    check (char_length(site_id) between 1 and 64),
  constraint hand_stats_player_len  check (char_length(player) <= 120),
  constraint hand_stats_table_len   check (table_name is null or char_length(table_name) <= 200),
  constraint hand_stats_fast_fold_len check (fast_fold is null or char_length(fast_fold) between 1 and 64),
  constraint hand_stats_hole_cards_ok
    check (public.is_card_array(hole_cards) and cardinality(hole_cards) <= 6),
  constraint hand_stats_position_ok
    check (position is null or public.is_position_array(array[position])),
  constraint hand_stats_hand_class_ok
    check (hand_class is null or char_length(hand_class) <= 12),
  constraint hand_stats_street_ok
    check (street_reached is null
           or street_reached in ('preflop', 'flop', 'turn', 'river', 'showdown')),
  constraint hand_stats_minor_units_ok check (currency_minor_units in (1, 10, 100, 1000)),

  -- ------------------------------------------------------- the invariants
  --
  -- An Ignition villain is a different human every hand, so a per-player row
  -- keyed on a positional pseudonym would average strangers together and look
  -- exactly like a real player report while doing it. The writer refuses to
  -- emit those rows; this is the second lock, and it mirrors
  -- `hands_positional_anonymity` on the table these rows are derived from.
  constraint hand_stats_positional_anonymity
    check (is_hero or site_anonymization <> 'positional'),

  -- One row is one seat in one hand, so this is the sample size and it is
  -- always exactly one. Summed, it is the hand count of a report.
  constraint hand_stats_hands_one check (hands = 1),

  -- The headline chain. A player who raised preflop necessarily put money in
  -- voluntarily, and both are bounded by the one preflop decision the seat had.
  constraint hand_stats_vpip_pfr check (pfr <= vpip and vpip <= vpip_opp),

  -- `made <= opp`, every pair, from OPPORTUNITY_PAIRS in `lib/stats/types.ts`.
  constraint hand_stats_preflop_opportunities
    check (vpip <= vpip_opp
      and pfr <= pfr_opp
      and rfi <= rfi_opp
      and iso <= iso_opp
      and limp <= limp_opp
      and cold_call <= cold_call_opp
      and three_bet <= three_bet_opp
      and four_bet <= four_bet_opp
      and five_bet <= five_bet_opp
      and squeeze <= squeeze_opp
      and steal <= steal_opp),
  constraint hand_stats_postflop_opportunities
    check (cbet_flop <= cbet_flop_opp
      and cbet_turn <= cbet_turn_opp
      and cbet_river <= cbet_river_opp
      and donk_flop <= donk_flop_opp
      and donk_turn <= donk_turn_opp
      and donk_river <= donk_river_opp
      and check_raise_flop <= check_raise_flop_opp
      and check_raise_turn <= check_raise_turn_opp
      and check_raise_river <= check_raise_river_opp),
  constraint hand_stats_showdown_opportunities
    check (wwsf <= wwsf_opp
      and wtsd <= wtsd_opp
      and wsd <= wsd_opp),

  -- Leg sets, from LEG_SETS. Facing a bet there are exactly three legal
  -- replies and no fourth, so any drift here means a decision walk lost an
  -- action or counted a spot that never existed.
  constraint hand_stats_legs_fold_to_steal
    check (fold_to_steal + call_steal + three_bet_vs_steal = fold_to_steal_opp),
  constraint hand_stats_legs_fold_to_three_bet
    check (fold_to_three_bet + call_three_bet + raise_vs_three_bet = fold_to_three_bet_opp),
  constraint hand_stats_legs_fold_to_four_bet
    check (fold_to_four_bet + call_four_bet + raise_vs_four_bet = fold_to_four_bet_opp),
  constraint hand_stats_legs_fold_to_cbet_flop
    check (fold_to_cbet_flop + call_cbet_flop + raise_cbet_flop = fold_to_cbet_flop_opp),
  constraint hand_stats_legs_fold_to_cbet_turn
    check (fold_to_cbet_turn + call_cbet_turn + raise_cbet_turn = fold_to_cbet_turn_opp),
  constraint hand_stats_legs_fold_to_cbet_river
    check (fold_to_cbet_river + call_cbet_river + raise_cbet_river = fold_to_cbet_river_opp),

  -- You cannot see the river without having seen the turn, you cannot show
  -- down without having seen the flop, and you cannot win a showdown you were
  -- not in. From STREET_CHAINS.
  constraint hand_stats_street_chain
    check (river_seen <= turn_seen and turn_seen <= flop_seen and flop_seen <= 1),
  constraint hand_stats_showdown_chain
    check (wsd <= wtsd and wtsd <= flop_seen
           and wwsf_opp = flop_seen and wtsd_opp = flop_seen and wsd_opp = wtsd),

  -- A bomb pot has no preflop betting round at all: everyone antes and the
  -- flop is dealt. Every preflop opportunity is therefore 0 by construction,
  -- and a row that says otherwise is a derivation that mis-detected the format.
  constraint hand_stats_bomb_pot
    check (not is_bomb_pot
      or (vpip_opp = 0
           and pfr_opp = 0
           and rfi_opp = 0
           and iso_opp = 0
           and limp_opp = 0
           and cold_call_opp = 0
           and three_bet_opp = 0
           and four_bet_opp = 0
           and five_bet_opp = 0
           and squeeze_opp = 0
           and steal_opp = 0
           and fold_to_steal_opp = 0
           and fold_to_three_bet_opp = 0
           and fold_to_four_bet_opp = 0)),

  -- The money identity. `won` is after the fees taken out of the pot and
  -- `contributed` is net of uncalled returns, which is what makes the seats of
  -- one hand sum to the house's take.
  constraint hand_stats_net check (net = won - contributed),
  constraint hand_stats_money_signs
    check (won >= 0 and contributed >= 0 and rake_paid >= 0 and cashout_risk >= 0),

  -- `cashed_out` is a property of the seat; `has_cashout` is a property of the
  -- hand. A seat cannot have sold equity in a hand where nobody did.
  constraint hand_stats_cashout_agrees check (cashed_out = 0 or has_cashout)
);

comment on table public.hand_stats is
  'Derived statistics: one row per (hand, dealt-in seat, stats_version). Integer counters only -- every rate is computed at read time. Semantics live in frontend/src/lib/stats and are specified in docs/STATS-SPEC.md.';
comment on column public.hand_stats.stats_version is
  'The counter semantics these numbers were derived under. Bumped when a counter changes meaning; rows of two versions must never be summed together, which is why it is in the primary key and in every query.';
comment on column public.hand_stats.is_hero is
  'Whether this seat is the library owner. The writer emits hero rows only until a setting turns villains on; the schema supports both so that turning them on is a client change rather than a migration.';
comment on column public.hand_stats.net_bb_milli is
  'net in thousandths of a big blind, so samples at different stakes can be summed. bb/100 is sum(net_bb_milli) / 10 / hands.';

-- The one composite index. `(owner_id, stats_version, played_at)` is the shape
-- of every query in this file -- one library, one version of the definitions,
-- ordered by or bounded on time -- and `where is_hero` keeps it to the rows M1
-- actually reads even after villain rows start landing beside them.
create index if not exists hand_stats_hero_idx
  on public.hand_stats (owner_id, stats_version, played_at)
  where is_hero;

-- Not a second reporting index: this is the writer's lookup path, `(owner_id,
-- hand_key)` being what a client can name a hand by.
create index if not exists hand_stats_owner_hand_key_idx
  on public.hand_stats (owner_id, hand_key);

-- ---------------------------------------------------------------------------
-- 4. Normalizing trigger
-- ---------------------------------------------------------------------------
--
-- Same posture as `hands_normalize`: whatever the client sent for `owner_id` is
-- overwritten from the session. When there is no session the value is left
-- alone, so a service-role backfill can set it explicitly -- that caller is
-- already trusted and RLS does not apply to it either way.
--
-- Everything else here is the canonicalization that makes a `group by` honest:
-- two rows that differ only by the casing of a position or by trailing
-- whitespace in a table name are one thing, and a report that splits them into
-- two is wrong in a way nobody will notice.

create or replace function public.hand_stats_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.owner_id := (select auth.uid());
  end if;

  new.hand_key      := btrim(new.hand_key);
  new.site_id       := lower(btrim(new.site_id));
  new.site_hand_id  := nullif(btrim(coalesce(new.site_hand_id, '')), '');
  new.variant       := nullif(lower(btrim(coalesce(new.variant, ''))), '');
  new.limit_type    := nullif(lower(btrim(coalesce(new.limit_type, ''))), '');
  new.currency      := upper(btrim(new.currency));
  new.table_name    := nullif(btrim(coalesce(new.table_name, '')), '');
  new.tournament_id := nullif(btrim(coalesce(new.tournament_id, '')), '');
  new.fast_fold     := left(nullif(btrim(coalesce(new.fast_fold, '')), ''), 64);
  new.street_reached := nullif(lower(btrim(coalesce(new.street_reached, ''))), '');

  new.player     := left(coalesce(btrim(new.player), ''), 120);
  new.position   := nullif(upper(btrim(coalesce(new.position, ''))), '');
  new.hole_cards := coalesce(public.normalize_cards(new.hole_cards), '{}'::text[]);
  new.hand_class := nullif(btrim(coalesce(new.hand_class, '')), '');

  -- The writer already refuses to emit villain rows for a positionally
  -- anonymised room. Blanking the name here as well means that even if a future
  -- writer starts emitting them, the pseudonym never reaches a column anything
  -- groups by -- the same treatment `handInsertFromPhf` gives `player_names`.
  if new.site_anonymization = 'positional' and not new.is_hero then
    new.player := '';
  end if;

  new.created_at := now();

  return new;
end;
$$;

revoke execute on function public.hand_stats_normalize() from public, anon, authenticated;

drop trigger if exists hand_stats_normalize_before_insert on public.hand_stats;
create trigger hand_stats_normalize_before_insert
before insert on public.hand_stats
for each row execute function public.hand_stats_normalize();

-- ---------------------------------------------------------------------------
-- 5. Rate limit -- its own bucket, deliberately
-- ---------------------------------------------------------------------------
--
-- `hands_insert` is 25 000 per ten minutes and it is **global**, not per user:
-- PostgREST does not expose a client IP to Postgres, so the limiter is a
-- circuit breaker per logical bucket rather than fair-share throttling.
--
-- Sharing that bucket with statistics would be a live outage waiting to happen.
-- Re-deriving an existing library after a `stats_version` bump is a backfill of
-- one row per stored hand, submitted as fast as the client can post it -- and if
-- it spent the same budget, the first person to run one would lock every other
-- user out of *uploading hands at all* for ten minutes. A separate bucket makes
-- the worst case "my backfill slowed down".
--
-- The ceiling is higher than `hands_insert` for the same reason: these rows are
-- an order of magnitude cheaper (no `phf`, no `source_text`, no `standard_text`
-- -- a few hundred bytes against tens of kilobytes), so the number that
-- represents comparable load is a larger one.

create or replace function public.hand_stats_rate_limit()
returns trigger
language plpgsql
-- security definer for the same reason `hands_rate_limit` is: `authenticated`
-- is deliberately not granted EXECUTE on `enforce_rate_limit`, because that
-- would let any caller burn another bucket's budget on purpose. This trigger
-- reads nothing but its transition table and passes fixed arguments.
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  select count(*) into v_rows from inserted;

  if v_rows > 2000 then
    raise exception 'Batch too large: % stats rows in one statement (max 2000).', v_rows
      using errcode = '53400';
  end if;

  perform public.enforce_rate_limit('hand_stats_insert', v_rows, 200000, interval '10 minutes');
  return null;
end;
$$;

revoke execute on function public.hand_stats_rate_limit() from public, anon, authenticated;

drop trigger if exists hand_stats_rate_limit_after_insert on public.hand_stats;
create trigger hand_stats_rate_limit_after_insert
after insert on public.hand_stats
referencing new table as inserted
for each statement execute function public.hand_stats_rate_limit();

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
--
-- Same posture as `public.hands` since `20260922130000`: `anon` loses the table
-- entirely, `authenticated` gets `select` and `insert` and nothing else, and the
-- policies scope both to the owner. `(select auth.uid())` rather than a bare
-- `auth.uid()` so Postgres hoists it into an InitPlan and evaluates it once per
-- statement instead of once per row -- which matters far more here than it does
-- on a 25-row page of hands, because these are the rows an aggregate scans.

alter table public.hand_stats enable row level security;

revoke all on public.hand_stats from anon;
revoke all on public.hand_stats from authenticated;
grant select, insert, delete on public.hand_stats to authenticated;

drop policy if exists hand_stats_owner_select on public.hand_stats;
drop policy if exists hand_stats_owner_insert on public.hand_stats;
drop policy if exists hand_stats_owner_delete on public.hand_stats;

create policy hand_stats_owner_select on public.hand_stats
for select to authenticated
using (owner_id = (select auth.uid()));

create policy hand_stats_owner_insert on public.hand_stats
for insert to authenticated
with check (owner_id = (select auth.uid()));

-- **The one deliberate exception to "no UPDATE, no DELETE".**
--
-- Everywhere else in this schema a client can insert and read and nothing else,
-- because the rows are irreplaceable: a hand history someone uploaded cannot be
-- reconstructed if they delete it by accident, so the verb stays off the table
-- until there is a confirmation flow behind it.
--
-- These rows are the opposite. Every one of them is a pure function of a
-- `hands.phf` document that is still sitting in the same database -- deleting
-- them destroys nothing and costs one re-derivation. And there has to be a way
-- to remove them, because `stats_version` exists: the whole point of versioning
-- the counters is that a bump lets new rows land beside the old ones so the two
-- can be compared, and that is only a workflow if the loser can then be cleared.
-- Without DELETE, the first redefinition of `steal_opp` strands a dead copy of
-- every row in every library, permanently, with no support path short of a
-- migration.
--
-- Still no UPDATE. A statistics row is not something to edit -- if it is wrong,
-- the derivation is wrong, and the answer is to delete it and derive again.
create policy hand_stats_owner_delete on public.hand_stats
for delete to authenticated
using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 7. save_hand_stats
-- ---------------------------------------------------------------------------
--
-- `security invoker`, which is what makes the hand lookup safe without a single
-- explicit ownership check: `public.hands` is scoped by `hands_owner_select`, so
-- the join below can only ever resolve a `hand_key` the caller owns. A caller
-- naming somebody else's hand gets zero rows out of the join and a `skipped`
-- count back, which is the same answer they get for a hand that does not exist.
-- That indistinguishability is deliberate -- otherwise this is an oracle for
-- "does this hand key exist in another library".
--
-- `on conflict do nothing`, never `do update`: a re-derivation under the same
-- `stats_version` is by definition identical, and one under a new version is a
-- new primary key. There is no case where an existing row should change, which
-- is the same argument that keeps UPDATE off the table.

create or replace function public.save_hand_stats(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
  v_resolved integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_stats expects a JSON array of stats rows'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0, 'skipped', 0);
  end if;
  if v_received > 1000 then
    raise exception 'save_hand_stats accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_populate_recordset(null::public.hand_stats, p_rows)
  ),
  deduped as (
    select distinct on (hand_key, stats_version, seat) *
    from input
    where hand_key is not null and btrim(hand_key) <> ''
    order by hand_key, stats_version, seat
  ),
  resolved as (
    -- RLS on `public.hands` is the ownership check. `(owner_id, hand_key)` is
    -- unique, so this is at most one row per input.
    select d.*, h.id as resolved_hand_id
    from deduped d
    join public.hands h on h.hand_key = d.hand_key
  ),
  ins as (
    insert into public.hand_stats (
      hand_id, owner_id, stats_version, seat, hand_key, site_id, site_hand_id,
      played_at, variant, limit_type, game_format, site_anonymization,
      currency, currency_minor_units, small_blind, big_blind, player_count,
      max_seats, table_name, tournament_id, fast_fold, has_straddle,
      is_bomb_pot, is_big_blind_ante, is_run_it_twice, has_cashout, is_walk,
      street_reached, total_pot, house_into_pot, fees, player, is_hero,
      position, hole_cards, hand_class, starting_stack,
      starting_stack_bb_tenths, hands, vpip_opp, vpip, pfr_opp, pfr, rfi_opp,
      rfi, iso_opp, iso, limp_opp, limp, cold_call_opp, cold_call,
      three_bet_opp, three_bet, four_bet_opp, four_bet, five_bet_opp,
      five_bet, squeeze_opp, squeeze, steal_opp, steal, fold_to_steal_opp,
      fold_to_steal, call_steal, three_bet_vs_steal, fold_to_three_bet_opp,
      fold_to_three_bet, call_three_bet, raise_vs_three_bet,
      fold_to_four_bet_opp, fold_to_four_bet, call_four_bet,
      raise_vs_four_bet, flop_seen, turn_seen, river_seen, cbet_flop_opp,
      cbet_flop, cbet_turn_opp, cbet_turn, cbet_river_opp, cbet_river,
      fold_to_cbet_flop_opp, fold_to_cbet_flop, call_cbet_flop,
      raise_cbet_flop, fold_to_cbet_turn_opp, fold_to_cbet_turn,
      call_cbet_turn, raise_cbet_turn, fold_to_cbet_river_opp,
      fold_to_cbet_river, call_cbet_river, raise_cbet_river, donk_flop_opp,
      donk_flop, donk_turn_opp, donk_turn, donk_river_opp, donk_river,
      check_raise_flop_opp, check_raise_flop, check_raise_turn_opp,
      check_raise_turn, check_raise_river_opp, check_raise_river, bet_flop,
      raise_flop, call_flop, check_flop, fold_flop, bet_turn, raise_turn,
      call_turn, check_turn, fold_turn, bet_river, raise_river, call_river,
      check_river, fold_river, wwsf_opp, wwsf, wtsd_opp, wtsd, wsd_opp, wsd,
      cashed_out, won, contributed, net, net_bb_milli, rake_paid, out_of_pot,
      cashout_risk
    )
    select
      r.resolved_hand_id, v_owner, r.stats_version, r.seat, r.hand_key,
      r.site_id, r.site_hand_id, r.played_at, r.variant, r.limit_type,
      r.game_format, r.site_anonymization, r.currency, r.currency_minor_units,
      r.small_blind, r.big_blind, r.player_count, r.max_seats, r.table_name,
      r.tournament_id, r.fast_fold, r.has_straddle, r.is_bomb_pot,
      r.is_big_blind_ante, r.is_run_it_twice, r.has_cashout, r.is_walk,
      r.street_reached, r.total_pot, r.house_into_pot, r.fees, r.player,
      r.is_hero, r.position, r.hole_cards, r.hand_class, r.starting_stack,
      r.starting_stack_bb_tenths, r.hands, r.vpip_opp, r.vpip, r.pfr_opp,
      r.pfr, r.rfi_opp, r.rfi, r.iso_opp, r.iso, r.limp_opp, r.limp,
      r.cold_call_opp, r.cold_call, r.three_bet_opp, r.three_bet,
      r.four_bet_opp, r.four_bet, r.five_bet_opp, r.five_bet, r.squeeze_opp,
      r.squeeze, r.steal_opp, r.steal, r.fold_to_steal_opp, r.fold_to_steal,
      r.call_steal, r.three_bet_vs_steal, r.fold_to_three_bet_opp,
      r.fold_to_three_bet, r.call_three_bet, r.raise_vs_three_bet,
      r.fold_to_four_bet_opp, r.fold_to_four_bet, r.call_four_bet,
      r.raise_vs_four_bet, r.flop_seen, r.turn_seen, r.river_seen,
      r.cbet_flop_opp, r.cbet_flop, r.cbet_turn_opp, r.cbet_turn,
      r.cbet_river_opp, r.cbet_river, r.fold_to_cbet_flop_opp,
      r.fold_to_cbet_flop, r.call_cbet_flop, r.raise_cbet_flop,
      r.fold_to_cbet_turn_opp, r.fold_to_cbet_turn, r.call_cbet_turn,
      r.raise_cbet_turn, r.fold_to_cbet_river_opp, r.fold_to_cbet_river,
      r.call_cbet_river, r.raise_cbet_river, r.donk_flop_opp, r.donk_flop,
      r.donk_turn_opp, r.donk_turn, r.donk_river_opp, r.donk_river,
      r.check_raise_flop_opp, r.check_raise_flop, r.check_raise_turn_opp,
      r.check_raise_turn, r.check_raise_river_opp, r.check_raise_river,
      r.bet_flop, r.raise_flop, r.call_flop, r.check_flop, r.fold_flop,
      r.bet_turn, r.raise_turn, r.call_turn, r.check_turn, r.fold_turn,
      r.bet_river, r.raise_river, r.call_river, r.check_river, r.fold_river,
      r.wwsf_opp, r.wwsf, r.wtsd_opp, r.wtsd, r.wsd_opp, r.wsd, r.cashed_out,
      r.won, r.contributed, r.net, r.net_bb_milli, r.rake_paid, r.out_of_pot,
      r.cashout_risk
    from resolved r
    -- Villain rows for a positionally anonymised room are refused here as well
    -- as by `hand_stats_positional_anonymity`, so a client that sends them gets
    -- them dropped rather than the whole batch rejected. The constraint is what
    -- makes it impossible; this is what makes it survivable.
    where r.is_hero or r.site_anonymization <> 'positional'
    on conflict (hand_id, stats_version, seat) do nothing
    returning 1
  )
  select (select count(*) from resolved)::integer,
         (select count(*) from ins)::integer
    into v_resolved, v_inserted;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   coalesce(v_inserted, 0),
    -- Rows whose hand was found but that were already stored.
    'duplicates', coalesce(v_resolved, 0) - coalesce(v_inserted, 0),
    -- Rows naming a hand this caller does not have. Not an error: a client that
    -- derives statistics for a batch it then fails to save should report a
    -- number, not throw.
    'skipped',    v_received - coalesce(v_resolved, 0)
  );
end;
$$;

revoke all on function public.save_hand_stats(jsonb) from public;
revoke execute on function public.save_hand_stats(jsonb) from anon;
grant execute on function public.save_hand_stats(jsonb) to authenticated;

comment on function public.save_hand_stats(jsonb) is
  'Insert derived statistics rows for hands the caller owns, resolving hand_key to hands.id under RLS. Requires a session. Returns {received, inserted, duplicates, skipped}.';

-- ---------------------------------------------------------------------------
-- 8. The filter predicate, written once
-- ---------------------------------------------------------------------------
--
-- `stats_summary` and `stats_graph` have to filter identically or the headline
-- number and the graph beneath it will disagree over the same sample, which is
-- the single most damaging thing a statistics page can do. So the predicate
-- exists once, here, and both functions execute it.
--
-- It follows the `search_hands` pattern exactly: numbered, explicitly cast
-- placeholders bound through `EXECUTE ... USING`. **Nothing out of `p_filters`
-- is ever interpolated into SQL.** The explicit casts are not decoration --
-- `EXECUTE ... USING` cannot infer a type from `$n is null` alone.
--
-- **The parameter order is the contract.** Both callers below bind exactly this
-- list, in exactly this order:
--
--    $1  owner              uuid
--    $2  statsVersion       text
--    $3  from               timestamptz
--    $4  to                 timestamptz
--    $5  site               text
--    $6  variant            text
--    $7  limitType          text
--    $8  gameFormat         public.game_format
--    $9  currency           text
--   $10  bigBlind           bigint
--   $11  positions          text[]
--   $12  handClasses        text[]
--   $13  tournamentId       text
--   $14  fastFold           text     -- a specific brand
--   $15  fastFoldOnly       boolean  -- null: either; true: only; false: never
--   $16  minPlayers         integer
--   $17  maxPlayers         integer
--   $18  includeBombPots    boolean
--   $19  includeStraddled   boolean
--   $20  includeCashouts    boolean  -- money aggregates only, never the filter
--
-- `$1` duplicates what RLS already enforces. That is on purpose: the policy's
-- predicate is applied after planning in a way that does not always reach the
-- index, and `hand_stats_hero_idx` leads with `owner_id`. Writing it out is
-- what puts the report on the index instead of on a sequential scan.
--
-- `is_hero` is hard-coded rather than exposed as a filter key. M1 reports on
-- the library owner and nothing else, the index is partial on exactly that
-- predicate, and a villain report needs a whole screen of its own to be worth
-- anything -- so the honest thing is for the door not to exist yet.

create or replace function public.hand_stats_filter_sql()
returns text
language sql
immutable
set search_path = ''
as $fn$
  select $w$
    where hs.owner_id      = $1::uuid
      and hs.stats_version = $2::text
      and hs.is_hero
      and ($3::timestamptz is null or hs.played_at >= $3::timestamptz)
      and ($4::timestamptz is null or hs.played_at <= $4::timestamptz)
      and ($5::text is null or hs.site_id    = $5::text)
      and ($6::text is null or hs.variant    = $6::text)
      and ($7::text is null or hs.limit_type = $7::text)
      and ($8::public.game_format is null or hs.game_format = $8::public.game_format)
      and ($9::text   is null or hs.currency  = $9::text)
      and ($10::bigint is null or hs.big_blind = $10::bigint)
      and (cardinality($11::text[]) = 0 or hs.position   = any($11::text[]))
      and (cardinality($12::text[]) = 0 or hs.hand_class = any($12::text[]))
      and ($13::text is null or hs.tournament_id = $13::text)
      and ($14::text is null or hs.fast_fold     = $14::text)
      and ($15::boolean is null or (hs.fast_fold is not null) = $15::boolean)
      and ($16::integer is null or hs.player_count >= $16::integer)
      and ($17::integer is null or hs.player_count <= $17::integer)
      -- Bomb pots are excluded from everything by default. Every preflop
      -- opportunity in one is 0 by construction, so including them dilutes
      -- nothing but `hands` -- which is the denominator of bb/100, so a table
      -- setting would move a player's win rate.
      and ($18::boolean is true or not hs.is_bomb_pot)
      -- Straddled hands are included by default. Their counters are honest
      -- under the "a straddle is a blind" rule, but the positions mean
      -- something different when a player behind the blinds has a live blind,
      -- so a position report over a mixed sample is muddy. The key exists so
      -- they can be dropped wholesale.
      and ($19::boolean is true or not hs.has_straddle)
      -- $20 is bound but never filtered on here. EV-cashout hands are
      -- excluded from the *money* series only, as a `filter` on each
      -- aggregate in the two callers, never from the counters and never from
      -- the sample -- the hand was still played, it is only its result that is
      -- not what the pot says.
  $w$;
$fn$;

revoke all on function public.hand_stats_filter_sql() from public;
revoke execute on function public.hand_stats_filter_sql() from anon, authenticated;

comment on function public.hand_stats_filter_sql() is
  'The single WHERE clause behind stats_summary and stats_graph, as parameterized SQL text. Internal: the numbered placeholder order is a contract between this function and its two callers.';

-- ---------------------------------------------------------------------------
-- 9. Helpers -- the key lists and the empty answers
-- ---------------------------------------------------------------------------
--
-- The key lists are what let `stats_summary` split one flat aggregate row into
-- `counters` and `money` without a 180-argument `jsonb_build_object`, which
-- Postgres will not compile. They are transcribed from `ZERO_COUNTERS` and
-- `ZERO_MONEY` in `frontend/src/lib/stats/types.ts`, the same source the column
-- list above comes from.

create or replace function public.hand_stats_counter_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'hands', 'vpip_opp', 'vpip', 'pfr_opp', 'pfr',
    'rfi_opp', 'rfi', 'iso_opp', 'iso', 'limp_opp',
    'limp', 'cold_call_opp', 'cold_call', 'three_bet_opp', 'three_bet',
    'four_bet_opp', 'four_bet', 'five_bet_opp', 'five_bet', 'squeeze_opp',
    'squeeze', 'steal_opp', 'steal', 'fold_to_steal_opp', 'fold_to_steal',
    'call_steal', 'three_bet_vs_steal', 'fold_to_three_bet_opp', 'fold_to_three_bet', 'call_three_bet',
    'raise_vs_three_bet', 'fold_to_four_bet_opp', 'fold_to_four_bet', 'call_four_bet', 'raise_vs_four_bet',
    'flop_seen', 'turn_seen', 'river_seen', 'cbet_flop_opp', 'cbet_flop',
    'cbet_turn_opp', 'cbet_turn', 'cbet_river_opp', 'cbet_river', 'fold_to_cbet_flop_opp',
    'fold_to_cbet_flop', 'call_cbet_flop', 'raise_cbet_flop', 'fold_to_cbet_turn_opp', 'fold_to_cbet_turn',
    'call_cbet_turn', 'raise_cbet_turn', 'fold_to_cbet_river_opp', 'fold_to_cbet_river', 'call_cbet_river',
    'raise_cbet_river', 'donk_flop_opp', 'donk_flop', 'donk_turn_opp', 'donk_turn',
    'donk_river_opp', 'donk_river', 'check_raise_flop_opp', 'check_raise_flop', 'check_raise_turn_opp',
    'check_raise_turn', 'check_raise_river_opp', 'check_raise_river', 'bet_flop', 'raise_flop',
    'call_flop', 'check_flop', 'fold_flop', 'bet_turn', 'raise_turn',
    'call_turn', 'check_turn', 'fold_turn', 'bet_river', 'raise_river',
    'call_river', 'check_river', 'fold_river', 'wwsf_opp', 'wwsf',
    'wtsd_opp', 'wtsd', 'wsd_opp', 'wsd', 'cashed_out'
  ]::text[];
$$;

create or replace function public.hand_stats_money_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'won', 'contributed', 'net', 'net_bb_milli', 'rake_paid',
    'out_of_pot', 'cashout_risk'
  ]::text[];
$$;

revoke all on function public.hand_stats_counter_keys() from public;
revoke all on function public.hand_stats_money_keys()   from public;
revoke execute on function public.hand_stats_counter_keys() from anon, authenticated;
revoke execute on function public.hand_stats_money_keys()   from anon, authenticated;

-- The empty answers, defined once so that "signed out", "no hands yet" and
-- "every hand filtered away" are the same shape as a real response. A client
-- that has to branch on `null` versus `{}` versus a populated object is a
-- client that will get one of the three wrong.

create or replace function public.stats_empty_summary(p_version text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'statsVersion',       p_version,
    'hands',              0,
    'moneyHands',         0,
    'counters',           '{}'::jsonb,
    'money',              '{}'::jsonb,
    'currency',           null,
    'currencyMinorUnits', null,
    'mixedCurrency',      false,
    'mixedUnitKind',      false,
    'moneyAvailable',     true,
    'firstHandAt',        null,
    'lastHandAt',         null
  );
$$;

create or replace function public.stats_empty_graph(p_version text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'statsVersion',       p_version,
    'buckets',            '[]'::jsonb,
    'hands',              0,
    'moneyHands',         0,
    'currency',           null,
    'currencyMinorUnits', null,
    'mixedCurrency',      false,
    'mixedUnitKind',      false,
    'moneyAvailable',     true,
    'allInEv',            null
  );
$$;

revoke all on function public.stats_empty_summary(text) from public;
revoke all on function public.stats_empty_graph(text)   from public;
revoke execute on function public.stats_empty_summary(text) from anon, authenticated;
revoke execute on function public.stats_empty_graph(text)   from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. stats_summary
-- ---------------------------------------------------------------------------
--
-- One scan, one row: every counter summed, every money column summed, and the
-- three facts needed to decide whether the money may be reported at all.
--
-- ## The two refusals
--
-- **Never sum money across currencies.** `sum(net)` over a sample of dollars
-- and euros is a number with no unit, and it is the kind of wrong that looks
-- right -- it renders, it is roughly the right size, and it is meaningless.
-- When the sample spans more than one currency the minor-unit money keys are
-- removed from the response and `mixedCurrency` is set; `net_bb_milli` stays,
-- because a big blind is a unit of the *game* rather than of a currency, and
-- summing big blinds across stakes is the entire reason that column exists.
--
-- **Never sum chips and cash.** A tournament's chips are not money at all --
-- they are scoring tokens whose relationship to value is the payout structure --
-- so mixing them with a cash game is worse than mixing two currencies, and it is
-- not rescued by normalizing to big blinds either: a tournament big blind is a
-- fraction of a shrinking stack and a cash big blind is a fixed price. So this
-- refusal removes the money object **entirely**, `net_bb_milli` included, and
-- sets `mixedUnitKind`. The counters are unaffected: a 3-bet percentage over
-- mixed formats is a coarse number but it is a real one.
--
-- Both are reported as flags rather than raised as errors. The caller asked a
-- reasonable question about a sample they did not know was mixed; the useful
-- answer is the part that is true plus a note about the part that is not.

create or replace function public.stats_summary(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_from     timestamptz := nullif(btrim(coalesce(p_filters ->> 'from', '')), '')::timestamptz;
  v_to       timestamptz := nullif(btrim(coalesce(p_filters ->> 'to', '')), '')::timestamptz;
  v_site     text := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_variant  text := nullif(btrim(coalesce(p_filters ->> 'variant', '')), '');
  v_limit    text := nullif(lower(btrim(coalesce(p_filters ->> 'limitType', ''))), '');
  v_format   public.game_format;
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_positions text[];
  v_classes   text[];
  v_tourney  text := nullif(btrim(coalesce(p_filters ->> 'tournamentId', '')), '');
  v_fast     text := nullif(btrim(coalesce(p_filters ->> 'fastFold', '')), '');
  v_fast_only boolean := nullif(btrim(coalesce(p_filters ->> 'fastFoldOnly', '')), '')::boolean;
  v_min_players integer := nullif(btrim(coalesce(p_filters ->> 'minPlayers', '')), '')::integer;
  v_max_players integer := nullif(btrim(coalesce(p_filters ->> 'maxPlayers', '')), '')::integer;
  v_bomb     boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeBombPots', '')), '')::boolean, false);
  v_straddle boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeStraddled', '')), '')::boolean, true);
  v_cashouts boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeCashouts', '')), '')::boolean, false);
  v_where    text := public.hand_stats_filter_sql();
  v_all      jsonb;
  v_counters jsonb;
  v_money    jsonb;
  v_mixed_currency boolean;
  v_mixed_kind     boolean;
begin
  if v_owner is null then
    return public.stats_empty_summary(v_version);
  end if;

  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;

  v_positions := coalesce(
    public.normalize_positions(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'positions', '[]'::jsonb)))
    ), '{}'::text[]);
  v_classes := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'handClasses', '[]'::jsonb))),
    '{}'::text[]);

  -- One scan. `to_jsonb(t)` over an explicitly projected subquery, which is the
  -- shape `search_hands` uses -- never `to_jsonb(hs)` over the table, which is
  -- how `20261003090000_share_projection.sql` describes a payload leaking.
  -- `jsonb_build_object` is not an option here: it is variadic and Postgres
  -- caps a call at 100 arguments, while 90 counters alone would need 180.
  execute format($q$
    select to_jsonb(t) from (
      select
           count(*)::bigint                                  as row_count,
           count(distinct hs.currency)::integer              as currency_count,
           count(distinct (hs.game_format = 'cash'))::integer as unit_kind_count,
           min(hs.currency)                                  as currency,
           min(hs.currency_minor_units)::integer             as currency_minor_units,
           min(hs.played_at)                                 as first_hand_at,
           max(hs.played_at)                                 as last_hand_at,
           count(*) filter (where $20::boolean or not hs.has_cashout)::bigint as money_hands,
           coalesce(sum(hs.hands), 0)::bigint as hands,
           coalesce(sum(hs.vpip_opp), 0)::bigint as vpip_opp,
           coalesce(sum(hs.vpip), 0)::bigint as vpip,
           coalesce(sum(hs.pfr_opp), 0)::bigint as pfr_opp,
           coalesce(sum(hs.pfr), 0)::bigint as pfr,
           coalesce(sum(hs.rfi_opp), 0)::bigint as rfi_opp,
           coalesce(sum(hs.rfi), 0)::bigint as rfi,
           coalesce(sum(hs.iso_opp), 0)::bigint as iso_opp,
           coalesce(sum(hs.iso), 0)::bigint as iso,
           coalesce(sum(hs.limp_opp), 0)::bigint as limp_opp,
           coalesce(sum(hs.limp), 0)::bigint as limp,
           coalesce(sum(hs.cold_call_opp), 0)::bigint as cold_call_opp,
           coalesce(sum(hs.cold_call), 0)::bigint as cold_call,
           coalesce(sum(hs.three_bet_opp), 0)::bigint as three_bet_opp,
           coalesce(sum(hs.three_bet), 0)::bigint as three_bet,
           coalesce(sum(hs.four_bet_opp), 0)::bigint as four_bet_opp,
           coalesce(sum(hs.four_bet), 0)::bigint as four_bet,
           coalesce(sum(hs.five_bet_opp), 0)::bigint as five_bet_opp,
           coalesce(sum(hs.five_bet), 0)::bigint as five_bet,
           coalesce(sum(hs.squeeze_opp), 0)::bigint as squeeze_opp,
           coalesce(sum(hs.squeeze), 0)::bigint as squeeze,
           coalesce(sum(hs.steal_opp), 0)::bigint as steal_opp,
           coalesce(sum(hs.steal), 0)::bigint as steal,
           coalesce(sum(hs.fold_to_steal_opp), 0)::bigint as fold_to_steal_opp,
           coalesce(sum(hs.fold_to_steal), 0)::bigint as fold_to_steal,
           coalesce(sum(hs.call_steal), 0)::bigint as call_steal,
           coalesce(sum(hs.three_bet_vs_steal), 0)::bigint as three_bet_vs_steal,
           coalesce(sum(hs.fold_to_three_bet_opp), 0)::bigint as fold_to_three_bet_opp,
           coalesce(sum(hs.fold_to_three_bet), 0)::bigint as fold_to_three_bet,
           coalesce(sum(hs.call_three_bet), 0)::bigint as call_three_bet,
           coalesce(sum(hs.raise_vs_three_bet), 0)::bigint as raise_vs_three_bet,
           coalesce(sum(hs.fold_to_four_bet_opp), 0)::bigint as fold_to_four_bet_opp,
           coalesce(sum(hs.fold_to_four_bet), 0)::bigint as fold_to_four_bet,
           coalesce(sum(hs.call_four_bet), 0)::bigint as call_four_bet,
           coalesce(sum(hs.raise_vs_four_bet), 0)::bigint as raise_vs_four_bet,
           coalesce(sum(hs.flop_seen), 0)::bigint as flop_seen,
           coalesce(sum(hs.turn_seen), 0)::bigint as turn_seen,
           coalesce(sum(hs.river_seen), 0)::bigint as river_seen,
           coalesce(sum(hs.cbet_flop_opp), 0)::bigint as cbet_flop_opp,
           coalesce(sum(hs.cbet_flop), 0)::bigint as cbet_flop,
           coalesce(sum(hs.cbet_turn_opp), 0)::bigint as cbet_turn_opp,
           coalesce(sum(hs.cbet_turn), 0)::bigint as cbet_turn,
           coalesce(sum(hs.cbet_river_opp), 0)::bigint as cbet_river_opp,
           coalesce(sum(hs.cbet_river), 0)::bigint as cbet_river,
           coalesce(sum(hs.fold_to_cbet_flop_opp), 0)::bigint as fold_to_cbet_flop_opp,
           coalesce(sum(hs.fold_to_cbet_flop), 0)::bigint as fold_to_cbet_flop,
           coalesce(sum(hs.call_cbet_flop), 0)::bigint as call_cbet_flop,
           coalesce(sum(hs.raise_cbet_flop), 0)::bigint as raise_cbet_flop,
           coalesce(sum(hs.fold_to_cbet_turn_opp), 0)::bigint as fold_to_cbet_turn_opp,
           coalesce(sum(hs.fold_to_cbet_turn), 0)::bigint as fold_to_cbet_turn,
           coalesce(sum(hs.call_cbet_turn), 0)::bigint as call_cbet_turn,
           coalesce(sum(hs.raise_cbet_turn), 0)::bigint as raise_cbet_turn,
           coalesce(sum(hs.fold_to_cbet_river_opp), 0)::bigint as fold_to_cbet_river_opp,
           coalesce(sum(hs.fold_to_cbet_river), 0)::bigint as fold_to_cbet_river,
           coalesce(sum(hs.call_cbet_river), 0)::bigint as call_cbet_river,
           coalesce(sum(hs.raise_cbet_river), 0)::bigint as raise_cbet_river,
           coalesce(sum(hs.donk_flop_opp), 0)::bigint as donk_flop_opp,
           coalesce(sum(hs.donk_flop), 0)::bigint as donk_flop,
           coalesce(sum(hs.donk_turn_opp), 0)::bigint as donk_turn_opp,
           coalesce(sum(hs.donk_turn), 0)::bigint as donk_turn,
           coalesce(sum(hs.donk_river_opp), 0)::bigint as donk_river_opp,
           coalesce(sum(hs.donk_river), 0)::bigint as donk_river,
           coalesce(sum(hs.check_raise_flop_opp), 0)::bigint as check_raise_flop_opp,
           coalesce(sum(hs.check_raise_flop), 0)::bigint as check_raise_flop,
           coalesce(sum(hs.check_raise_turn_opp), 0)::bigint as check_raise_turn_opp,
           coalesce(sum(hs.check_raise_turn), 0)::bigint as check_raise_turn,
           coalesce(sum(hs.check_raise_river_opp), 0)::bigint as check_raise_river_opp,
           coalesce(sum(hs.check_raise_river), 0)::bigint as check_raise_river,
           coalesce(sum(hs.bet_flop), 0)::bigint as bet_flop,
           coalesce(sum(hs.raise_flop), 0)::bigint as raise_flop,
           coalesce(sum(hs.call_flop), 0)::bigint as call_flop,
           coalesce(sum(hs.check_flop), 0)::bigint as check_flop,
           coalesce(sum(hs.fold_flop), 0)::bigint as fold_flop,
           coalesce(sum(hs.bet_turn), 0)::bigint as bet_turn,
           coalesce(sum(hs.raise_turn), 0)::bigint as raise_turn,
           coalesce(sum(hs.call_turn), 0)::bigint as call_turn,
           coalesce(sum(hs.check_turn), 0)::bigint as check_turn,
           coalesce(sum(hs.fold_turn), 0)::bigint as fold_turn,
           coalesce(sum(hs.bet_river), 0)::bigint as bet_river,
           coalesce(sum(hs.raise_river), 0)::bigint as raise_river,
           coalesce(sum(hs.call_river), 0)::bigint as call_river,
           coalesce(sum(hs.check_river), 0)::bigint as check_river,
           coalesce(sum(hs.fold_river), 0)::bigint as fold_river,
           coalesce(sum(hs.wwsf_opp), 0)::bigint as wwsf_opp,
           coalesce(sum(hs.wwsf), 0)::bigint as wwsf,
           coalesce(sum(hs.wtsd_opp), 0)::bigint as wtsd_opp,
           coalesce(sum(hs.wtsd), 0)::bigint as wtsd,
           coalesce(sum(hs.wsd_opp), 0)::bigint as wsd_opp,
           coalesce(sum(hs.wsd), 0)::bigint as wsd,
           coalesce(sum(hs.cashed_out), 0)::bigint as cashed_out,
           coalesce(sum(hs.won) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as won,
           coalesce(sum(hs.contributed) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as contributed,
           coalesce(sum(hs.net) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as net,
           coalesce(sum(hs.net_bb_milli) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as net_bb_milli,
           coalesce(sum(hs.rake_paid) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as rake_paid,
           coalesce(sum(hs.out_of_pot) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as out_of_pot,
           coalesce(sum(hs.cashout_risk) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as cashout_risk
      from public.hand_stats hs
      %1$s
    ) t
  $q$, v_where)
    into v_all
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts;

  if v_all is null or (v_all ->> 'row_count')::bigint = 0 then
    return public.stats_empty_summary(v_version);
  end if;

  v_mixed_currency := (v_all ->> 'currency_count')::integer > 1;
  v_mixed_kind     := (v_all ->> 'unit_kind_count')::integer > 1;

  v_counters := (
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(v_all) e
    where e.key = any(public.hand_stats_counter_keys())
  );
  v_money := (
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(v_all) e
    where e.key = any(public.hand_stats_money_keys())
  );

  if v_mixed_kind then
    -- Chips and cash in one sample. Nothing denominated survives, not even the
    -- big-blind figure.
    v_money := null;
  elsif v_mixed_currency then
    -- Dollars and euros in one sample. The bb figure survives; the currency
    -- ones do not.
    v_money := v_money - 'won' - 'contributed' - 'net' - 'rake_paid'
                       - 'out_of_pot' - 'cashout_risk';
  end if;

  return jsonb_build_object(
    'statsVersion',       v_version,
    'hands',              coalesce((v_counters ->> 'hands')::bigint, 0),
    'moneyHands',         coalesce((v_all ->> 'money_hands')::bigint, 0),
    'counters',           v_counters,
    'money',              v_money,
    'currency',           case when v_mixed_currency or v_mixed_kind then null else v_all ->> 'currency' end,
    'currencyMinorUnits', case when v_mixed_currency or v_mixed_kind then null else (v_all ->> 'currency_minor_units')::integer end,
    'mixedCurrency',      v_mixed_currency,
    'mixedUnitKind',      v_mixed_kind,
    'moneyAvailable',     v_money is not null,
    'firstHandAt',        v_all -> 'first_hand_at',
    'lastHandAt',         v_all -> 'last_hand_at'
  );
end;
$$;

revoke all on function public.stats_summary(jsonb) from public;
revoke execute on function public.stats_summary(jsonb) from anon;
grant execute on function public.stats_summary(jsonb) to authenticated;

comment on function public.stats_summary(jsonb) is
  'Every counter and every money column summed over the caller''s own hero rows. security invoker, so RLS scopes the sample. Refuses to sum money across currencies (mixedCurrency, bb only) and refuses to sum chips with cash (mixedUnitKind, no money at all).';

-- ---------------------------------------------------------------------------
-- 11. stats_graph
-- ---------------------------------------------------------------------------
--
-- Four cumulative series: total, showdown, non-showdown, and a slot for all-in
-- EV that M1 leaves null.
--
-- ## Why showdown / non-showdown is the chart worth building first
--
-- It is the one decomposition that turns "I am losing" into a diagnosis. The
-- non-showdown line is what your aggression wins and loses before cards are
-- turned over; the showdown line is what your hand selection and your calls are
-- worth once they are. A losing graph where non-showdown falls steadily and
-- showdown climbs is a player folding too much and paying off; the mirror image
-- is a player bluffing into calling stations. The total line alone cannot tell
-- those apart, and they need opposite fixes.
--
-- It costs nothing to compute: a hand is a showdown hand exactly when `wtsd = 1`,
-- which is already stored, so the split is two `filter` clauses rather than two
-- more columns. Storing them would put the definition of "showdown" in a second
-- place, and the second place is where it goes stale.
--
-- ## Why the buckets are by hand count and not by time
--
-- `ntile()` over the hand ordering, never `date_trunc()`. A player who took
-- three months off between two sessions must not be given forty percent of the
-- x-axis for zero volume -- the shape of a win-rate graph is about sample, and a
-- flat stretch that means "I did not play" is indistinguishable from one that
-- means "I broke even for 20 000 hands". The x-axis is therefore cumulative
-- hands, with the date range of each bucket carried alongside for the tooltip.
--
-- ## The same two refusals as `stats_summary`
--
-- Mixed currency strips the minor-unit series and leaves the big-blind ones;
-- chips mixed with cash refuses the graph outright. A win-rate graph is a money
-- graph, so unlike the summary there is nothing left to draw in that second
-- case, and the honest response is an empty series with a flag rather than a
-- plausible curve.
--
-- EV-cashout hands are out of the money series by default and counted in the
-- hand total: the player sold their equity mid-hand, so `won - contributed` is
-- not their result, but the hand was still played. That is why each bucket
-- reports `money_hands` separately from `hands` -- bb/100 has to divide by the
-- former.

create or replace function public.stats_graph(
  p_filters jsonb    default '{}'::jsonb,
  p_buckets integer  default 60
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_from     timestamptz := nullif(btrim(coalesce(p_filters ->> 'from', '')), '')::timestamptz;
  v_to       timestamptz := nullif(btrim(coalesce(p_filters ->> 'to', '')), '')::timestamptz;
  v_site     text := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_variant  text := nullif(btrim(coalesce(p_filters ->> 'variant', '')), '');
  v_limit    text := nullif(lower(btrim(coalesce(p_filters ->> 'limitType', ''))), '');
  v_format   public.game_format;
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_positions text[];
  v_classes   text[];
  v_tourney  text := nullif(btrim(coalesce(p_filters ->> 'tournamentId', '')), '');
  v_fast     text := nullif(btrim(coalesce(p_filters ->> 'fastFold', '')), '');
  v_fast_only boolean := nullif(btrim(coalesce(p_filters ->> 'fastFoldOnly', '')), '')::boolean;
  v_min_players integer := nullif(btrim(coalesce(p_filters ->> 'minPlayers', '')), '')::integer;
  v_max_players integer := nullif(btrim(coalesce(p_filters ->> 'maxPlayers', '')), '')::integer;
  v_bomb     boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeBombPots', '')), '')::boolean, false);
  v_straddle boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeStraddled', '')), '')::boolean, true);
  v_cashouts boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeCashouts', '')), '')::boolean, false);
  v_where    text := public.hand_stats_filter_sql();
  -- Bounded: one bucket is a single point and 400 is already more than there
  -- are pixels across a chart on a phone. A caller asking for 100 000 would
  -- otherwise be asking for a sort with 100 000 groups.
  v_buckets  integer := least(greatest(coalesce(p_buckets, 60), 1), 400);
  v_meta     jsonb;
  v_rows     jsonb;
  v_mixed_currency boolean;
  v_mixed_kind     boolean;
  v_total    bigint;
begin
  if v_owner is null then
    return public.stats_empty_graph(v_version);
  end if;

  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;

  v_positions := coalesce(
    public.normalize_positions(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'positions', '[]'::jsonb)))
    ), '{}'::text[]);
  v_classes := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'handClasses', '[]'::jsonb))),
    '{}'::text[]);

  execute format($q$
    select to_jsonb(t) from (
      select
        count(*)::bigint                                   as row_count,
        count(distinct hs.currency)::integer               as currency_count,
        count(distinct (hs.game_format = 'cash'))::integer as unit_kind_count,
        min(hs.currency)                                   as currency,
        min(hs.currency_minor_units)::integer              as currency_minor_units,
        count(*) filter (where $20::boolean or not hs.has_cashout)::bigint as money_hands
      from public.hand_stats hs
      %1$s
    ) t
  $q$, v_where)
    into v_meta
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts;

  v_total := coalesce((v_meta ->> 'row_count')::bigint, 0);
  if v_total = 0 then
    return public.stats_empty_graph(v_version);
  end if;

  v_mixed_currency := (v_meta ->> 'currency_count')::integer > 1;
  v_mixed_kind     := (v_meta ->> 'unit_kind_count')::integer > 1;

  if v_mixed_kind then
    -- Refused outright. Every series on this chart is money.
    return jsonb_build_object(
      'statsVersion',       v_version,
      'buckets',            '[]'::jsonb,
      'hands',              v_total,
      'moneyHands',         coalesce((v_meta ->> 'money_hands')::bigint, 0),
      'currency',           null,
      'currencyMinorUnits', null,
      'mixedCurrency',      v_mixed_currency,
      'mixedUnitKind',      true,
      'moneyAvailable',     false,
      'allInEv',            null
    );
  end if;

  execute format($q$
    with base as (
      select hs.played_at, hs.hand_key, hs.wtsd, hs.net, hs.net_bb_milli, hs.has_cashout
      from public.hand_stats hs
      %1$s
    ),
    ordered as (
      -- `hand_key` breaks the tie so the bucketing is deterministic: two hands
      -- with the same timestamp (common -- a fast-fold pool deals several a
      -- second) must not land in different buckets on two different runs, or
      -- the graph would shimmer between reloads.
      select b.*, ntile($21::integer) over (order by b.played_at asc nulls last, b.hand_key) as bucket
      from base b
    ),
    per_bucket as (
      select
        o.bucket,
        count(*)::bigint as hands,
        count(*) filter (where $20::boolean or not o.has_cashout)::bigint as money_hands,
        coalesce(sum(o.net_bb_milli)
                 filter (where $20::boolean or not o.has_cashout), 0)::bigint as net_bb_milli,
        coalesce(sum(o.net_bb_milli)
                 filter (where ($20::boolean or not o.has_cashout) and o.wtsd = 1), 0)::bigint as sd_bb_milli,
        coalesce(sum(o.net_bb_milli)
                 filter (where ($20::boolean or not o.has_cashout) and o.wtsd = 0), 0)::bigint as nsd_bb_milli,
        coalesce(sum(o.net)
                 filter (where $20::boolean or not o.has_cashout), 0)::bigint as net,
        min(o.played_at) as first_played_at,
        max(o.played_at) as last_played_at
      from ordered o
      group by o.bucket
    )
    select coalesce(jsonb_agg(to_jsonb(t) order by t.bucket), '[]'::jsonb) from (
      select
        p.bucket,
        p.hands,
        p.money_hands,
        p.first_played_at,
        p.last_played_at,
        sum(p.hands)        over o as cum_hands,
        sum(p.money_hands)  over o as cum_money_hands,
        sum(p.net_bb_milli) over o as cum_net_bb_milli,
        sum(p.sd_bb_milli)  over o as cum_sd_bb_milli,
        sum(p.nsd_bb_milli) over o as cum_nsd_bb_milli,
        sum(p.net)          over o as cum_net
      from per_bucket p
      window o as (order by p.bucket rows between unbounded preceding and current row)
    ) t
  $q$, v_where)
    into v_rows
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts,
          v_buckets;

  if v_mixed_currency then
    -- Dollars and euros in one sample: the big-blind series survive, the
    -- currency one is removed rather than rendered as a number with no unit.
    select coalesce(jsonb_agg(e - 'cum_net'), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) e;
  end if;

  return jsonb_build_object(
    'statsVersion',       v_version,
    'buckets',            coalesce(v_rows, '[]'::jsonb),
    'hands',              v_total,
    'moneyHands',         coalesce((v_meta ->> 'money_hands')::bigint, 0),
    'currency',           case when v_mixed_currency then null else v_meta ->> 'currency' end,
    'currencyMinorUnits', case when v_mixed_currency then null else (v_meta ->> 'currency_minor_units')::integer end,
    'mixedCurrency',      v_mixed_currency,
    'mixedUnitKind',      false,
    'moneyAvailable',     true,
    -- The fourth series. All-in EV needs an equity calculator over the runout,
    -- which is a piece of work in its own right (#44); the key is here so the
    -- chart can render its legend slot from day one and a client written today
    -- does not need a change when it arrives.
    'allInEv',            null
  );
end;
$$;

revoke all on function public.stats_graph(jsonb, integer) from public;
revoke execute on function public.stats_graph(jsonb, integer) from anon;
grant execute on function public.stats_graph(jsonb, integer) to authenticated;

comment on function public.stats_graph(jsonb, integer) is
  'Cumulative total / showdown / non-showdown win-rate series over the caller''s own hero rows, bucketed by ntile() on hand count rather than on time. Same two refusals as stats_summary. allInEv is a reserved null until #44.';

-- ---------------------------------------------------------------------------
-- 12. Verification
-- ---------------------------------------------------------------------------
--
-- Run these against a real session, not the service role: the service role
-- bypasses RLS, so a scoping test that passes under it proves nothing.
--
--   -- 1. A caller cannot attach statistics to somebody else's hand.
--   --    Expect {"received":1,"inserted":0,"duplicates":0,"skipped":1}.
--   select public.save_hand_stats(
--     jsonb_build_array(jsonb_build_object(
--       'hand_key', '<a hand_key from another account>',
--       'stats_version', 'stats/1', 'seat', 1, 'site_id', 'ggpoker',
--       'is_hero', true, 'hands', 1, 'currency', 'USD'
--     ))
--   );
--
--   -- 2. The invariants really do refuse. Expect 23514, constraint
--   --    "hand_stats_vpip_pfr".
--   select public.save_hand_stats(
--     jsonb_build_array(jsonb_build_object(
--       'hand_key', '<one of your own>', 'seat', 1, 'site_id', 'ggpoker',
--       'is_hero', true, 'hands', 1, 'vpip_opp', 1, 'vpip', 0, 'pfr', 1
--     ))
--   );
--
--   -- 3. Mixed currency returns bb and no dollars.
--   select public.stats_summary('{}'::jsonb) -> 'money' ? 'net' as has_currency_money,
--          public.stats_summary('{}'::jsonb) ->> 'mixedCurrency' as mixed;
--
--   -- 4. Chips and cash together return no money at all.
--   select public.stats_summary('{}'::jsonb) -> 'money' as money,
--          public.stats_summary('{}'::jsonb) ->> 'mixedUnitKind' as mixed_kind;
--
--   -- 5. The report is on the index, not on a sequential scan.
--   explain (analyze, buffers) select public.stats_summary('{}'::jsonb);

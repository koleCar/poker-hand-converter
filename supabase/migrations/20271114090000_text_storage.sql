-- Store the standard text, not the PHF JSON (docs/DATABASE.md, "The phf /
-- standard_text contract").
--
-- `hands.phf` is most of the table: ~2.75 KB a hand after TOAST compression,
-- against ~1.2 KB for the hand's standard text, which reads back as the same
-- hand. From here a row holds either its PHF (every row written before, and
-- every hand whose text does not read back identically) or its standard text
-- alone, `phf` null. Readers that need the whole hand parse the text and put
-- back the provenance a text cannot carry from the row's columns
-- (`storedText.ts` / `stored_text.rs`: `site`, `hand_key`, `parser_version`,
-- `source_filename`, `source_text`, `created_at`).
--
-- The write path stays PHF-in
-- ----------------------------
-- Clients still send the PHF: the server derives the row from it (as it
-- always has) and then, in `hands_normalize`, drops it when the row carries a
-- standard text that its writer vouches for. A client sends a text only when
-- it **verified** it: rendered,
-- parsed back, restored from the columns the server will store, and equal to
-- the PHF but for the cosmetic paths (per-action line numbers and verbatim
-- lines, WePlay's dealt-lines flag, the conversion time). Measured on the
-- corpus: every WePlay hand and 644 of 645 GG hands verify; rooms whose text
-- loses something (CoinPoker, Full Tilt, most PokerStars) do not, and keep
-- their PHF. So:
--
--  * `ingest_hands` (desktop, web bulk upload) takes an optional
--    `standard_text` per row - only new clients send it, and only verified;
--  * `save_hands` (the web's single save) has always sent a display copy of
--    the text, unverified, so it stores the text only for a row that also
--    says `"text_verified": true`; an older client's row keeps its PHF and
--    loses nothing but the display copy (readers render it from the PHF).
--
-- Only those two say so to the trigger (`rail.hands_text_verified`, set
-- around their own insert): a direct insert, a test fixture or a data copy
-- that carries a display copy of the text keeps its PHF, as before.
--
-- Rows written before stay as they are. Converting them is the backfill's job
-- (`tests/scripts/text-storage/backfill.mjs` verifies each row, then
-- `hands_store_text` below applies the verified ones).
--
-- `table_set`
-- -----------
-- The postflop leak readers chose a hand's chart set by parsing its PHF
-- (`analysis_hand_table_set(phf)`). It is now a column, filled at insert
-- before the PHF goes, and backfilled here for the rows that have one. The
-- readers fall back to the PHF for a row whose column is still null (a row
-- copied in with triggers off), so nothing reads a wrong set meanwhile.
--
-- Storage
-- -------
-- `toast_tuple_target` does not do what it seems to: Postgres only starts
-- toasting a row over the compiled-in TOAST_TUPLE_THRESHOLD (~2 KB); the
-- reloption moves the *target* once it has started, not the threshold.
-- Measured on this image (PostgreSQL 17.6): a ~1.2 KB text in a ~1.5 KB row is
-- stored uncompressed with `toast_tuple_target = 256`, with `storage main`
-- and with neither. A text-only row is therefore stored as plain text unless
-- the row is over ~2 KB (long hands), where it is compressed. Lowering the
-- target would only push those long rows' text out of line (an extra TOAST
-- read each), so it is left alone. `standard_text` gets `storage main`: in a
-- row over the threshold the toaster then compresses it in place and moves
-- the other wide columns (`phf`, `source_text`) out first, so the text a
-- reader needs stays in the heap row.
--
-- Publishing and sharing
-- ----------------------
-- `publish_hand` and `create_share` read the stored PHF server-side. For a
-- text-only row the client sends the parsed hand (`p_phf`), and the server
-- checks it against the stored row (`hand_phf_matches`: the row it derives
-- from `p_phf` has the same key, site, time, players, cards, pot, profit and
-- result) before it scrubs it exactly as before. A hand-linked share of a
-- text-only hand keeps a redacted snapshot in `shares.phf` (written by
-- `create_share`, or by `hands_store_text` before it drops a PHF), so
-- `read_share` - unchanged: live PHF, else the snapshot - never needs a PHF
-- the row no longer has. Published hands and polls read `published_hands`,
-- a snapshot already; `erase_account_content` only rewrites that snapshot.

-- --------------------------------------------------------------- columns --

alter table public.hands alter column phf drop not null;

alter table public.hands add column if not exists table_set text;

alter table public.hands alter column standard_text set storage main;

comment on column public.hands.phf is
  'The PHF document, or null when the row is its standard_text (20271114090000): a reader '
  'parses the text and restores the provenance from the row''s columns (storedText.ts).';
comment on column public.hands.standard_text is
  'The hand''s standard text. With phf null it is the hand (verified to read back as the PHF '
  'it was derived from); with phf present a display copy, or null.';
comment on column public.hands.table_set is
  'The preflop chart set of a NLHE cash hand (analysis_hand_table_set), filled at insert: '
  'an empty string when none fits, null only on a row not yet backfilled.';

-- A row is its PHF or its text: never neither.
alter table public.hands drop constraint if exists hands_has_payload;
alter table public.hands add constraint hands_has_payload
  check (phf is not null or coalesce(standard_text, '') <> '');

-- Q4 still holds for desktop and upload rows - no source text, no raw text in
-- a PHF - but they may now carry a standard text, and a web row may have
-- none (an unverified one is not stored).
alter table public.hands drop constraint if exists hands_text_by_origin;
alter table public.hands add constraint hands_text_by_origin check (
  origin = 'web'
  or (origin in ('desktop', 'upload')
      and source_text is null
      and coalesce(phf -> 'meta' ->> 'rawText', '') = ''));

-- ---------------------------------------------------------- the trigger --

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

  -- The leak readers' chart set (20271114090000), off the document as well.
  new.table_set := case when new.phf is null then coalesce(new.table_set, '')
                        else public.analysis_hand_table_set(new.phf) end;

  if new.player_count is null then
    new.player_count := nullif(cardinality(new.player_names), 0);
    -- A positional-anonymity hand has no names to count, but it does have a
    -- roster of positions, which is the same number.
    if new.player_count is null then
      new.player_count := nullif(cardinality(new.player_positions), 0);
    end if;
  end if;

  -- (20271114090000) Every column is derived; a row with a verified standard
  -- text is that text from here on. Only the writers that know the text was
  -- verified (`save_hands`, `ingest_hands`) say so, for their own insert
  -- (`rail.hands_text_verified`, transaction-local, reset after it): a
  -- direct insert, a fixture or a data copy with a display copy of the text
  -- keeps its PHF.
  if new.phf is not null and coalesce(new.standard_text, '') <> ''
     and coalesce(current_setting('rail.hands_text_verified', true), '') = 'on' then
    new.phf := null;
  end if;

  -- created_at is server-authoritative; a client cannot backdate a row.
  new.created_at := now();

  return new;
end;
$$;

-- The rows that have a PHF get their chart set now. (A fresh project has no
-- rows yet; rows copied in later with triggers off are filled by
-- `hands_store_text`, and read through the PHF until then.)
update public.hands
   set table_set = public.analysis_hand_table_set(phf)
 where table_set is null and phf is not null;

-- ----------------------------------------------------------- save_hands --

create or replace function public.save_hands(p_hands jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save hands.'
      using errcode = '42501';
  end if;

  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'save_hands expects a JSON array of hand rows'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_hands);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0);
  end if;
  if v_received > 500 then
    raise exception 'save_hands accepts at most 500 hands per call (got %)', v_received
      using errcode = '53400';
  end if;

  -- The texts below are verified ones (or none): `hands_normalize` drops
  -- those rows' PHF.
  perform set_config('rail.hands_text_verified', 'on', true);
  with input as (
    select (jsonb_populate_record(null::public.hands, e)).*,
           -- (20271114090000) The text replaces the PHF only when the client
           -- checked that it reads back as it; an older client's display copy
           -- is not stored, and the row keeps its PHF.
           coalesce(e -> 'text_verified' = 'true'::jsonb, false) as text_verified
    from jsonb_array_elements(p_hands) e
  ),
  deduped as (
    select distinct on (hand_key) *
    from input
    where hand_key is not null and btrim(hand_key) <> ''
    order by hand_key
  ),
  ins as (
    insert into public.hands (
      owner_id,
      hand_key, phf, standard_text, source_text, schema_version, parser_version,
      site, site_hand_id, variant, limit_type, game_format, tournament_id,
      currency, currency_minor_units, currency_symbol,
      small_blind, big_blind, ante, stakes_label,
      table_name, max_seats, played_at,
      hero_name, hero_seat, hero_position, hero_cards, hero_hand_class,
      board_cards, player_names, player_count,
      street_reached, went_to_showdown, total_pot, rake, hero_profit, winners,
      source_filename,
      site_anonymization, player_positions, showdown_positions, winner_positions
    )
    select
      -- Not `d.owner_id`: whatever the client put in the payload is ignored.
      v_owner,
      d.hand_key, d.phf,
      case when d.text_verified and d.phf is not null then d.standard_text end,
      d.source_text,
      coalesce(d.schema_version, 'phf/1'), d.parser_version,
      d.site, d.site_hand_id, d.variant, d.limit_type,
      coalesce(d.game_format, 'cash'::public.game_format),
      d.tournament_id,
      coalesce(d.currency, 'USD'),
      coalesce(d.currency_minor_units, 100::smallint),
      d.currency_symbol,
      d.small_blind, d.big_blind, d.ante, d.stakes_label,
      d.table_name, d.max_seats, d.played_at,
      d.hero_name, d.hero_seat, d.hero_position,
      coalesce(d.hero_cards, '{}'::text[]), d.hero_hand_class,
      coalesce(d.board_cards, '{}'::text[]),
      coalesce(d.player_names, '{}'::text[]), d.player_count,
      d.street_reached, coalesce(d.went_to_showdown, false),
      d.total_pot, d.rake, d.hero_profit, coalesce(d.winners, '{}'::text[]),
      d.source_filename,
      coalesce(d.site_anonymization, 'none'::public.site_anonymization),
      coalesce(d.player_positions, '{}'::text[]),
      coalesce(d.showdown_positions, '{}'::text[]),
      coalesce(d.winner_positions, '{}'::text[])
    from deduped d
    -- Per-library dedupe. Uploading a hand another account already has is a
    -- new row, not a duplicate: it is your copy of your hand.
    on conflict (owner_id, hand_key) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from ins;
  perform set_config('rail.hands_text_verified', '', true);

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   v_inserted,
    'duplicates', v_received - v_inserted
  );
end;
$$;

-- --------------------------------------------------------- ingest_hands --
--
-- An optional `standard_text` per row (a string, at most 200 000 characters):
-- the client verified it, and the row keeps it instead of the PHF.

create or replace function public.ingest_hands(p_source uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_owner     uuid := (select auth.uid());
  v_received  integer;
  v_elem      jsonb;
  v_phf       jsonb;
  v_text      text;
  v_key       text;
  v_reason    text;
  v_field     text;
  v_row       public.hands;
  v_rows      public.hands[] := '{}';
  v_seen      text[] := '{}';
  v_keys      text[] := '{}';
  v_statuses  text[] := '{}';
  v_reasons   text[] := '{}';
  v_fields    text[] := '{}';
  v_inserted  text[];
  v_out       jsonb := '[]'::jsonb;
  v_n_ins     integer := 0;
  v_n_dup     integer := 0;
  v_n_rej     integer := 0;
  v_last_rej  text;
  v_status    text;
  v_kind      public.hand_source_kind;
  v_origin    public.hand_origin;
begin
  if v_owner is null then
    raise exception 'You must be signed in to sync hands.'
      using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'ingest_hands expects a JSON array of {hand_key, phf, standard_text?}'
      using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 500 then
    raise exception 'ingest_hands accepts at most 500 hands per call (got %)', v_received
      using errcode = '22023';
  end if;
  if octet_length(p_rows::text) > 8388608 then
    raise exception 'ingest_hands accepts at most 8 MiB per call'
      using errcode = '22023';
  end if;

  -- The same answer for "no such source" and "not yours". A folder's rows
  -- are the app's (`desktop`); the web source's are a bulk upload's
  -- (`upload`, R4.2) - the same PHF-only shape, written from the browser.
  select s.kind into v_kind
    from public.hand_sources s
   where s.id = p_source and s.owner_id = v_owner;
  if v_kind is null then
    raise exception 'No hand source with id %', p_source using errcode = '23503';
  end if;
  v_origin := case v_kind when 'web' then 'upload' else 'desktop' end;

  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0,
                              'rejected', 0, 'rows', '[]'::jsonb);
  end if;

  perform public.enforce_rate_limit('desktop_ingest:' || v_owner::text,
                                    v_received, 150000, interval '10 minutes');
  perform public.enforce_rate_limit('desktop_ingest_day:' || v_owner::text,
                                    v_received, 2000000, interval '1 day');

  for v_i in 0 .. v_received - 1 loop
    v_elem   := p_rows -> v_i;
    v_phf    := v_elem -> 'phf';
    v_key    := case when jsonb_typeof(v_elem -> 'hand_key') = 'string'
                     then v_elem ->> 'hand_key' end;
    v_reason := null;
    v_field  := null;
    -- (20271114090000) The hand's standard text, sent only when the client
    -- verified that it reads back as the PHF; the row then keeps the text
    -- and drops the PHF (`hands_normalize`).
    v_text   := case when jsonb_typeof(v_elem -> 'standard_text') = 'string'
                     then nullif(v_elem ->> 'standard_text', '') end;

    if jsonb_typeof(v_elem) is distinct from 'object'
       or jsonb_typeof(v_phf) is distinct from 'object'
       or jsonb_typeof(v_elem -> 'standard_text') not in ('string', 'null') then
      v_reason := 'shape';
    elsif v_phf ->> 'schema' is distinct from 'phf/1' then
      v_reason := 'schema';
    elsif octet_length(v_phf::text) > 262144 or char_length(v_text) > 200000 then
      v_reason := 'too-large';
    elsif coalesce(v_phf -> 'meta' ->> 'rawText', '') <> '' then
      -- Q4: the original text stays on the user's disk; from the web it
      -- goes to Storage, and only when the user opts in (A2, R4.2).
      v_reason := 'raw-text';
    else
      begin
        v_row := public.hand_row_from_phf(v_phf);
        v_row.standard_text := v_text;
      exception when others then
        v_reason := 'shape';
      end;
      if v_reason is null then
        if v_key is null or v_key <> v_row.hand_key then
          v_reason := 'hand-key';
        else
          v_field := public.hand_row_problem(v_row);
          if v_field = 'hand_key' then
            v_reason := 'hand-key';
            v_field := null;
          elsif v_field is not null then
            v_reason := 'invalid';
          end if;
        end if;
      end if;
    end if;

    if v_reason is not null then
      v_status := 'rejected';
    elsif v_row.hand_key = any (v_seen) then
      v_status := 'duplicate';
    else
      v_status := 'pending';
      v_seen := v_seen || v_row.hand_key;
      v_rows := v_rows || v_row;
    end if;

    v_keys     := v_keys || v_key;
    v_statuses := v_statuses || v_status;
    v_reasons  := v_reasons || v_reason;
    v_fields   := v_fields || v_field;
  end loop;

  -- The texts are the clients' verified ones: `hands_normalize` drops those
  -- rows' PHF (20271114090000).
  perform set_config('rail.hands_text_verified', 'on', true);
  with ins as (
    insert into public.hands (
      owner_id, origin,
      hand_key, phf, standard_text, source_text, schema_version, parser_version,
      site, site_hand_id, variant, limit_type, game_format, tournament_id,
      currency, currency_minor_units, currency_symbol,
      small_blind, big_blind, ante, stakes_label,
      table_name, max_seats, played_at,
      hero_name, hero_seat, hero_position, hero_cards, hero_hand_class,
      board_cards, player_names, player_count,
      street_reached, went_to_showdown, total_pot, rake, hero_profit, winners,
      source_filename,
      site_anonymization, player_positions, showdown_positions, winner_positions
    )
    select
      v_owner, v_origin,
      d.hand_key, d.phf, d.standard_text, null, d.schema_version, d.parser_version,
      d.site, d.site_hand_id, d.variant, d.limit_type, d.game_format, d.tournament_id,
      d.currency, d.currency_minor_units, d.currency_symbol,
      d.small_blind, d.big_blind, d.ante, d.stakes_label,
      d.table_name, d.max_seats, d.played_at,
      d.hero_name, d.hero_seat, d.hero_position, d.hero_cards, d.hero_hand_class,
      d.board_cards, d.player_names, d.player_count,
      d.street_reached, d.went_to_showdown, d.total_pot, d.rake, d.hero_profit, d.winners,
      d.source_filename,
      d.site_anonymization, d.player_positions, d.showdown_positions, d.winner_positions
    from unnest(v_rows) as d
    on conflict (owner_id, hand_key) do nothing
    returning hand_key
  )
  select coalesce(array_agg(hand_key), '{}') into v_inserted from ins;
  perform set_config('rail.hands_text_verified', '', true);

  for v_i in 1 .. v_received loop
    v_status := v_statuses[v_i];
    if v_status = 'pending' then
      v_status := case when v_keys[v_i] = any (v_inserted) then 'inserted' else 'duplicate' end;
    end if;
    if v_status = 'inserted' then
      v_n_ins := v_n_ins + 1;
    elsif v_status = 'duplicate' then
      v_n_dup := v_n_dup + 1;
    else
      v_n_rej := v_n_rej + 1;
      v_last_rej := v_reasons[v_i];
    end if;
    v_out := v_out || jsonb_strip_nulls(jsonb_build_object(
      'handKey', v_keys[v_i],
      'status',  v_status,
      'reason',  v_reasons[v_i],
      'field',   v_fields[v_i]));
  end loop;

  update public.hand_sources s
     set hands_received  = s.hands_received + v_received,
         hands_inserted  = s.hands_inserted + v_n_ins,
         hands_duplicate = s.hands_duplicate + v_n_dup,
         hands_rejected  = s.hands_rejected + v_n_rej,
         last_rejection  = coalesce(v_last_rej, s.last_rejection),
         last_ingest_at  = now(),
         updated_at      = now()
   where s.id = p_source and s.owner_id = v_owner;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   v_n_ins,
    'duplicates', v_n_dup,
    'rejected',   v_n_rej,
    'rows',       v_out
  );
end;
$function$;

-- ------------------------------------------- the leak screens' chart set --
--
-- The postflop rows' table, from the column (the PHF only for a row not yet
-- backfilled). Bodies otherwise as `20271105090000_leak_pot_type.sql` left
-- them.

create or replace function public.analysis_leak_hands_scan(p_filters jsonb DEFAULT '{}'::jsonb, p_keys text[] DEFAULT NULL::text[], p_deviations boolean DEFAULT true, p_sort text DEFAULT 'ev_loss'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
returns jsonb
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  v_table  text := nullif(btrim(coalesce(p_filters ->> 'leakTable', '')), '');
  v_pot    text := nullif(btrim(coalesce(p_filters ->> 'leakPot', '')), '');
  v_version text := public.analysis_version_of(p_filters);
  v_total  bigint;
  v_rows   jsonb;
begin
  perform public.require_entitlement('analysis');  -- R6.2 entitlement gate
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 500 then
    raise exception 'analysis_leak_hands needs between 1 and 500 spot keys.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_keys) k
    where k is null
       or k !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$'
  ) then
    raise exception 'Not a spot key.' using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;
  if v_table is not null and v_table not in ('hu', '9max', 'other') then
    raise exception 'Unknown leak table: %', v_table using errcode = '22023';
  end if;
  if v_pot is not null and v_pot not in ('3bp', '4bp', 'other') then
    raise exception 'Unknown leak pot: %', v_pot using errcode = '22023';
  end if;

  with m as materialized (
    select g.*
    from public.analysis_graded_decisions(p_filters) g
    -- The decision's set as the leak rows keep it (20271102090000), read only under a table filter.
    left join public.decision_analysis dt
      on v_table is not null and g.source = 'chart'
     and dt.hand_id = g.hand_id and dt.ord = g.ord and dt.analysis_version = v_version and dt.owner_id = v_owner
    left join public.hands ht
      on v_table is not null and g.street <> 'preflop' and ht.id = g.hand_id and ht.owner_id = v_owner
    where g.spot_key = any (p_keys)
      and (not v_dev or g.grade <> 'perfect')
      and (v_table is null
           or public.analysis_leak_table_of(
                case when g.source = 'chart'
                      and coalesce(dt.facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
                     then dt.facts -> 'chart' ->> 'set'
                     when g.street <> 'preflop'
                     then coalesce(ht.table_set, public.analysis_hand_table_set(ht.phf)) end) = v_table)
      -- The hand's pot type, as the leak rows keep it (20271105090000).
      and (v_pot is null or public.analysis_leak_pot_of(g.pot_type) = v_pot)
  ),
  page as (
    select
      row_number() over (
        order by
          case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
          case when v_sort = 'oldest' then m.played_at end asc nulls last,
          m.played_at desc nulls last,
          m.hand_id,
          m.ord
      ) as rn,
      m.hand_id,
      m.ord,
      jsonb_build_object(
        'handId',      m.hand_id,
        'ord',         m.ord,
        'actionIndex', m.action_index,
        'playedAt',    m.played_at,
        'site',        h.site,
        'stakesLabel', h.stakes_label,
        'position',    m."position",
        'heroCards',   to_jsonb(h.hero_cards),
        'street',      m.street,
        'scenario',    m.scenario,
        'line',        m.line,
        'taken',       m.taken,
        'best',        m.best,
        'source',      m.source,
        'grade',       m.grade,
        'evLossBb',    m.ev_loss_bb,
        'evLossPot',   m.ev_loss_pot
      ) as base
    from m
    join public.hands h on h.id = m.hand_id and h.owner_id = v_owner
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((
           select jsonb_agg(p.base || jsonb_build_object(
                    'handClass', dd.facts ->> 'handClass',
                    'options',   dd.options,
                    'chosen',    dd.chosen) order by p.rn)
           from page p
           join public.decision_analysis dd
             on dd.hand_id = p.hand_id and dd.ord = p.ord
            and dd.analysis_version = public.analysis_version_of(p_filters) and dd.owner_id = v_owner), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$function$;

create or replace function public.analysis_leaks_scan(p_filters jsonb DEFAULT '{}'::jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  v_out     jsonb;
begin
  perform public.require_entitlement('analysis');  -- R6.2 entitlement gate
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;

  with g as materialized (
    select d.*,
           case when d.source = 'chart'
                 and coalesce(dd.facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
                then dd.facts -> 'chart' ->> 'set'
                -- A postflop decision: its hand's table (20271102090000), as the leak rows keep it.
                when d.street <> 'preflop'
                then nullif(coalesce(hh.table_set, public.analysis_hand_table_set(hh.phf)), '') end as chart_set,
           -- A postflop decision in a 3-bet or 4-bet+ pot: its tag (20271105090000).
           case when d.street <> 'preflop' then nullif(public.analysis_leak_pot_of(d.pot_type), 'other') end as pot
    from public.analysis_graded_decisions(p_filters) d
    left join public.decision_analysis dd
      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version and dd.owner_id = v_owner
    left join public.hands hh
      on d.street <> 'preflop' and hh.id = d.hand_id and hh.owner_id = v_owner
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',  (select count(distinct hand_id) from g),
    'graded', (select count(*) from g),
    'first',  (select min(played_at) from g),
    'last',   (select max(played_at) from g),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key',        x.spot_key,
               'set',        x.chart_set,
               'street',     x.street,
               'scenario',   x.scenario,
               'line',       x.line,
               'position',   x.pos,
               'taken',      x.taken,
               'best',       x.best,
               'decisions',  x.n,
               'hands',      x.hands,
               'nonPerfect', x.non_perfect,
               'mistakes',   x.mistakes,
               'evLossBb',   x.ev_bb,
               'evLossPot',  x.ev_pot,
               'scoreSum',   x.score_sum,
               'scoreSq',    x.score_sq)
               || case when x.pot is not null then jsonb_build_object('pot', x.pot) else '{}'::jsonb end
             order by x.spot_key, x.chart_set nulls first, x.pot nulls first)
      from (
        select g.spot_key, g.chart_set, g.pot, g.street, g.scenario, g.line, g."position" as pos, g.taken, g.best,
               count(*) as n,
               count(distinct g.hand_id) as hands,
               count(*) filter (where g.grade <> 'perfect') as non_perfect,
               count(*) filter (where public.analysis_grade_rank(g.grade) >= 3) as mistakes,
               round(sum(g.ev_loss_bb), 3) as ev_bb,
               round(sum(g.ev_loss_pot), 4) as ev_pot,
               round(coalesce(sum(g.score), 0), 2) as score_sum,
               round(coalesce(sum(g.score * g.score), 0), 2) as score_sq
        from g
        group by g.spot_key, g.chart_set, g.pot, g.street, g.scenario, g.line, g."position", g.taken, g.best
      ) x), '[]'::jsonb),
    'facets', public.analysis_graded_facets(v_version)
  ) into v_out;

  return v_out;
end;
$function$;

-- ------------------------------------------------- the leak readers' set --

create or replace function public.analysis_leak_rows_table_set()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.chart_set := coalesce((
    select coalesce(h.table_set, public.analysis_hand_table_set(h.phf))
    from public.hands h
    where h.id = new.hand_id and h.owner_id = new.owner_id), '');
  return new;
end;
$$;

create or replace function public.analysis_leak_rows_table_backfill()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_n     integer;
  v_all   integer := 0;
begin
  for v_owner in
    select distinct x.owner_id from public.analysis_leak_rows x
    where x.street <> 'preflop' and x.chart_set = ''
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || v_owner::text, 0));

    update public.analysis_leak_rows x
       set chart_set = s.set
      from (select h.id, coalesce(h.table_set, public.analysis_hand_table_set(h.phf)) as set
            from public.hands h
            where h.owner_id = v_owner
              and exists (select 1 from public.analysis_leak_rows y
                          where y.hand_id = h.id and y.street <> 'preflop' and y.chart_set = '')) s
     where x.owner_id = v_owner and x.hand_id = s.id and x.street <> 'preflop' and x.chart_set = '' and s.set <> '';
    get diagnostics v_n = row_count;
    v_all := v_all + v_n;
    continue when v_n = 0;

    delete from public.analysis_leak_totals where owner_id = v_owner;
    insert into public.analysis_leak_totals (
      owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, decisions, hands,
      non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, count(*),
           count(distinct hand_id), count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from public.analysis_leak_rows
    where owner_id = v_owner and grade is not null
    group by 1, 2, 3, 4, 5, 6, 7;

    delete from public.analysis_leak_stake_totals where owner_id = v_owner;
    insert into public.analysis_leak_stake_totals (
      owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, decisions, hands,
      non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, count(*),
           count(distinct hand_id), count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from public.analysis_leak_rows
    where owner_id = v_owner and grade is not null
    group by 1, 2, 3, 4, 5, 6, 7;
  end loop;
  return v_all;
end;
$$;

-- ---------------------------------------------- the readers of whole hands --
--
-- The rebuild (stats) and the analysis read whole hands. Each row now comes
-- with its PHF (trimmed as before) or, on a text-only row, its standard text
-- and the columns the reader restores the provenance from; the parsing - and
-- what the SQL used to strip off the actions - is the client's
-- (`handOfStoredRow`). New return types, so drop and create.

drop function if exists public.hands_needing_stats(text, uuid, integer, boolean, text);
create function public.hands_needing_stats(
  p_version    text,
  p_after      uuid    default null,
  p_limit      integer default 100,
  p_villains   boolean default false,
  p_ev_version text    default null
)
returns table (
  id uuid, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'You must be signed in to rebuild statistics.' using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'hands_needing_stats needs a stats_version.' using errcode = '22023';
  end if;

  return query
  select hd.id, hd.phf,
         case when hd.phf is null then hd.standard_text end,
         hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at
  from public.hands hd
  where hd.owner_id = v_owner
    and hd.hero_seat is not null
    and (p_after is null or hd.id > p_after)
    and (
      not exists (
        select 1 from public.hand_stats s
        where s.owner_id = v_owner and s.stats_version = p_version and s.is_hero and s.hand_id = hd.id)
      or (
        coalesce(p_villains, false)
        and hd.site_anonymization <> 'positional'
        and not exists (
          select 1 from public.hand_stats s
          where s.hand_id = hd.id and s.stats_version = p_version and s.owner_id = v_owner and not s.is_hero))
      or (
        p_ev_version is not null
        and not exists (
          select 1 from public.hand_stats_ev e
          where e.hand_id = hd.id and e.ev_version = p_ev_version and e.owner_id = v_owner))
    )
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.hands_needing_stats(text, uuid, integer, boolean, text) is
  'The caller''s hands with a hero and no statistics at p_version (or no villain rows, or no '
  'EV row at p_ev_version), by id: each with its phf, or its standard_text and the columns '
  'a reader restores it from (20271114090000). At most 200 a page; RLS-scoped.';
revoke all on function public.hands_needing_stats(text, uuid, integer, boolean, text) from public, anon;
grant execute on function public.hands_needing_stats(text, uuid, integer, boolean, text) to authenticated, service_role;

-- The analysis reads the PHF without `meta.rawText` and the actions without
-- `rawLine` / `label` (bytes it never looks at); a text-only row is parsed
-- whole on the client.
create or replace function public.analysis_trimmed_phf(p_phf jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_phf is null then null
    else jsonb_set(
      p_phf #- '{meta,rawText}',
      '{actions}',
      coalesce((select jsonb_agg(a - 'rawLine' - 'label' order by ord)
                from jsonb_array_elements(p_phf -> 'actions') with ordinality as x(a, ord)),
               '[]'::jsonb))
  end;
$$;
revoke all on function public.analysis_trimmed_phf(jsonb) from public, anon;
grant execute on function public.analysis_trimmed_phf(jsonb) to authenticated, service_role;

drop function if exists public.hands_needing_analysis(text, uuid, integer);
create function public.hands_needing_analysis(
  p_version text,
  p_after   uuid    default null,
  p_limit   integer default 100
)
returns table (
  id uuid, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_owner uuid := auth.uid();
begin
  perform public.require_entitlement('analysis');  -- R6.2 entitlement gate
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis needs an analysis_version.' using errcode = '22023';
  end if;

  return query
  select hd.id, public.analysis_trimmed_phf(hd.phf),
         case when hd.phf is null then hd.standard_text end,
         hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at
  from public.hands hd
  where hd.owner_id = v_owner
    and (p_after is null or hd.id > p_after)
    and not exists (
      select 1 from public.hand_analysis a
      where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;
revoke all on function public.hands_needing_analysis(text, uuid, integer) from public, anon;
grant execute on function public.hands_needing_analysis(text, uuid, integer) to authenticated, service_role;

drop function if exists public.hands_needing_analysis_recent(text, timestamptz, uuid, integer);
drop function if exists public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer);

create function public.hands_needing_analysis_recent_scan(
  p_version       text,
  p_before_played timestamptz default null,
  p_before_id     uuid        default null,
  p_limit         integer     default 100
)
returns table (
  id uuid, played_at timestamptz, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_owner  uuid := auth.uid();
  v_before timestamptz := coalesce(p_before_played, '-infinity'::timestamptz);
begin
  perform public.require_entitlement('analysis');  -- R6.2 entitlement gate
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis_recent needs an analysis_version.' using errcode = '22023';
  end if;

  return query
  select hd.id,
         hd.played_at,
         public.analysis_trimmed_phf(hd.phf),
         case when hd.phf is null then hd.standard_text end,
         hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at
  from public.hands hd
  where hd.owner_id = v_owner
    and (p_before_id is null
         or (coalesce(hd.played_at, '-infinity'::timestamptz), hd.id) < (v_before, p_before_id))
    and not exists (
      select 1 from public.hand_analysis a
      where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)
  order by coalesce(hd.played_at, '-infinity'::timestamptz) desc, hd.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;
revoke all on function public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer) to authenticated, service_role;

create function public.hands_needing_analysis_recent(
  p_version       text,
  p_before_played timestamptz default null,
  p_before_id     uuid        default null,
  p_limit         integer     default 100
)
returns table (
  id uuid, played_at timestamptz, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_owner  uuid := auth.uid();
  v_before timestamptz := coalesce(p_before_played, '-infinity'::timestamptz);
  v_left   integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_from   date;
  v_month  date;
  v_n      integer;
begin
  perform public.require_entitlement('analysis');  -- R6.2 entitlement gate
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis_recent needs an analysis_version.' using errcode = '22023';
  end if;
  -- Counts that cannot be trusted: the previous walk over every hand.
  if exists (select 1 from public.library_counts_stale s where s.owner_id = v_owner) then
    return query select * from public.hands_needing_analysis_recent_scan(p_version, p_before_played, p_before_id, p_limit);
    return;
  end if;

  -- The cursor's month: later months are behind it.
  v_from := case when p_before_id is null then null
                 when v_before = '-infinity'::timestamptz then '-infinity'::date
                 else public.analysis_month_of(v_before) end;

  for v_month in
    select c.month
    from (select l.month, sum(l.hands) as hands from public.library_hand_counts l
          where l.owner_id = v_owner group by l.month) c
    left join public.analysis_month_hands a
      on a.owner_id = v_owner and a.analysis_version = p_version and a.month = c.month
    where c.hands > coalesce(a.hands, 0)
      and (v_from is null or c.month <= v_from)
    order by c.month desc
  loop
    return query
    select hd.id,
           hd.played_at,
           public.analysis_trimmed_phf(hd.phf),
           case when hd.phf is null then hd.standard_text end,
           hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at
    from public.hands hd
    where hd.owner_id = v_owner
      and (case when v_month = '-infinity'::date then hd.played_at is null
                else hd.played_at >= (v_month::timestamp at time zone 'UTC')
                     and hd.played_at < ((v_month + interval '1 month')::timestamp at time zone 'UTC') end)
      and (p_before_id is null
           or (coalesce(hd.played_at, '-infinity'::timestamptz), hd.id) < (v_before, p_before_id))
      and not exists (
        select 1 from public.hand_analysis a
        where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)
    order by coalesce(hd.played_at, '-infinity'::timestamptz) desc, hd.id desc
    limit v_left;
    get diagnostics v_n = row_count;
    v_left := v_left - v_n;
    exit when v_left <= 0;
  end loop;
end;
$$;
revoke all on function public.hands_needing_analysis_recent(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.hands_needing_analysis_recent(text, timestamptz, uuid, integer) to authenticated, service_role;

-- ------------------------------------------- a client's copy of a stored hand --

-- Whether `p_phf` is the stored hand `p_hand`: the row the server derives from
-- it (`hand_row_from_phf`, the ingest's own mapping) agrees with the stored one
-- on the key, the room, the time, the players, the cards, the pot, the result
-- and the profit. It is what `publish_hand` and `create_share` require of the
-- document a client sends for a text-only row (whose PHF the server no longer
-- has): the client parsed the stored text and restored it (`handOfStoredRow`);
-- a document for another hand, or an edited one, is refused.
create or replace function public.hand_phf_matches(p_hand public.hands, p_phf jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.hands;
begin
  if p_hand.id is null or p_phf is null or jsonb_typeof(p_phf) <> 'object'
     or octet_length(p_phf::text) > 1048576 then
    return false;
  end if;
  begin
    r := public.hand_row_from_phf(p_phf);
  exception when others then
    return false;
  end;
  return r.hand_key = p_hand.hand_key
     and lower(btrim(r.site)) = p_hand.site
     and r.played_at is not distinct from p_hand.played_at
     and r.player_names = p_hand.player_names
     and r.winners = p_hand.winners
     and coalesce(public.normalize_cards(r.hero_cards), '{}'::text[]) = p_hand.hero_cards
     and coalesce(public.normalize_cards(r.board_cards), '{}'::text[]) = p_hand.board_cards
     and r.hero_seat is not distinct from p_hand.hero_seat
     and r.total_pot is not distinct from p_hand.total_pot
     and r.hero_profit is not distinct from p_hand.hero_profit
     and r.went_to_showdown = p_hand.went_to_showdown;
end;
$$;
comment on function public.hand_phf_matches(public.hands, jsonb) is
  'Whether a client''s PHF is the stored hand (20271114090000): hand_row_from_phf(p_phf) '
  'against the row - key, site, time, players, winners, cards, hero seat, pot, profit, '
  'showdown. publish_hand and create_share require it for a text-only row.';
revoke all on function public.hand_phf_matches(public.hands, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------- publishing --

drop function if exists public.publish_hand(uuid, public.publish_mode, text);
create function public.publish_hand(
  p_hand_id uuid,
  p_mode    public.publish_mode default 'pseudonyms',
  p_title   text                default null,
  p_phf     jsonb               default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_block     text;
  v_hand      public.hands%rowtype;
  v_phf       jsonb;
  v_existing  text;
  v_doc       jsonb;
  v_doc_text  text;
  v_title     text := nullif(btrim(coalesce(p_title, '')), '');
  v_public_id text;
  v_id        uuid;
  v_attempt   integer := 0;
  r           record;
begin
  if v_uid is null then
    raise exception 'You must be signed in to publish a hand.' using errcode = '42501';
  end if;

  v_block := public.posting_block_reason(v_uid);
  if v_block is not null then
    raise exception '%', v_block using errcode = '22023';
  end if;

  select * into v_hand from public.hands h where h.id = p_hand_id and h.owner_id = v_uid;
  if not found then
    raise exception 'That hand does not exist.' using errcode = '22023';
  end if;

  if exists (select 1 from public.publish_blocked_sites b where b.site = lower(v_hand.site)) then
    raise exception 'Hands from this poker room cannot be published.' using errcode = '22023';
  end if;

  if v_title is not null and char_length(v_title) > 140 then
    raise exception 'Titles are at most 140 characters.' using errcode = '22023';
  end if;

  -- Idempotent: the same hand, published again, is the same publication.
  select p.public_id into v_existing
  from public.published_hand_sources s
  join public.published_hands p on p.id = s.published_id
  where s.author_id = v_uid and s.hand_id = v_hand.id
    and p.deleted_at is null;
  if found then
    return jsonb_build_object('publicId', v_existing, 'alreadyPublished', true);
  end if;

  -- The stored document; for a text-only row (20271114090000), the client's
  -- parse of the stored text, once it is shown to be this hand. Either way
  -- it goes through the same scrubber and the same leak assertion below.
  v_phf := v_hand.phf;
  if v_phf is null then
    if p_phf is null then
      raise exception 'This hand is stored as text: send its parsed document to publish it.'
        using errcode = '22023';
    end if;
    if not public.hand_phf_matches(v_hand, p_phf) then
      raise exception 'The hand sent is not the stored hand, so it was not published.'
        using errcode = '22023';
    end if;
    v_phf := p_phf;
  end if;

  v_doc := public.scrub_phf(v_phf, p_mode);
  if v_doc is null or not public.phf_is_scrubbed(v_doc) then
    raise exception 'This hand could not be prepared for publishing.' using errcode = '22023';
  end if;

  -- The leak assertion. See the function header.
  if p_mode <> 'as-imported' and v_hand.site_anonymization <> 'positional' then
    -- Every string value in the document, decoded -- not `v_doc::text`, where
    -- a name containing a quote or a backslash would be JSON-escaped and the
    -- search would sail past it.
    select string_agg(v #>> '{}', E'\n') into v_doc_text
    from jsonb_path_query(v_doc, 'strict $.** ? (@.type() == "string")') as v;
    v_doc_text := coalesce(v_doc_text, '');
    for r in
      select p ->> 'name' as name
      from jsonb_array_elements(coalesce(v_phf -> 'players', '[]'::jsonb)) p
    loop
      if r.name is null or r.name in ('Hero') or r.name ~ '^(Villain|Seat)[0-9]+(_[0-9]+)?$' then
        continue;
      end if;
      if v_doc_text ~ ('(^|[^[:alnum:]_])'
                       || regexp_replace(r.name, '([\\.^$|()\[\]{}*+?-])', '\\\1', 'g')
                       || '($|[^[:alnum:]_])') then
        raise exception 'This hand could not be anonymised safely, so it was not published. Nothing was made public.'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  perform public.enforce_rate_limit('publish:' || v_uid::text, 1, 20, interval '1 day');
  perform public.enforce_rate_limit('publish:*', 1, 500, interval '1 day');

  loop
    v_attempt := v_attempt + 1;
    v_public_id := public.generate_share_slug(10);
    begin
      insert into public.published_hands (
        public_id, author_id, mode, title, phf,
        site, variant, limit_type, game_format, currency, currency_minor_units, currency_symbol,
        small_blind, big_blind, ante, stakes_label, max_seats, player_count, fast_fold,
        site_anonymization, hero_position, hero_cards, hero_hand_class, board_cards,
        street_reached, went_to_showdown, total_pot, hero_profit, played_on
      ) values (
        v_public_id, v_uid, p_mode, v_title, v_doc,
        v_hand.site, v_hand.variant, v_hand.limit_type, v_hand.game_format, v_hand.currency,
        v_hand.currency_minor_units, v_hand.currency_symbol,
        v_hand.small_blind, v_hand.big_blind, v_hand.ante, v_hand.stakes_label, v_hand.max_seats,
        v_hand.player_count, v_hand.fast_fold,
        v_hand.site_anonymization, v_hand.hero_position, v_hand.hero_cards, v_hand.hero_hand_class,
        v_hand.board_cards, v_hand.street_reached, v_hand.went_to_showdown, v_hand.total_pot,
        v_hand.hero_profit, (v_hand.played_at at time zone 'UTC')::date
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.published_hand_sources (published_id, author_id, hand_id)
  values (v_id, v_uid, v_hand.id);

  return jsonb_build_object('publicId', v_public_id, 'alreadyPublished', false);
end;
$$;

comment on function public.publish_hand(uuid, public.publish_mode, text, jsonb) is
  'Publishes one of the caller''s hands: scrub_phf in SQL, the leak assertion, then a '
  'published_hands copy. For a text-only row (20271114090000) the client sends its parse of '
  'the stored text as p_phf, which must be the stored hand (hand_phf_matches); otherwise '
  'p_phf is ignored.';
revoke all on function public.publish_hand(uuid, public.publish_mode, text, jsonb) from public, anon;
grant execute on function public.publish_hand(uuid, public.publish_mode, text, jsonb) to authenticated, service_role;

-- ----------------------------------------------------------------- sharing --

create or replace function public.create_share(
  p_hand_id       uuid    default null,
  p_phf           jsonb   default null,
  p_standard_text text    default null,
  p_title         text    default null,
  p_spoilers      boolean default false,
  p_show_names    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_slug  text;
  v_id    uuid;
  v_hand  public.hands%rowtype;
  v_phf   jsonb := p_phf;
  v_text  text  := p_standard_text;
begin
  if v_owner is null then
    raise exception 'You must be signed in to create a share link.'
      using errcode = '42501';
  end if;

  if p_hand_id is null and p_phf is null then
    raise exception 'create_share needs either a hand id or an embedded PHF payload'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('share_create', 1, 300, interval '1 hour');

  if p_hand_id is not null then
    select * into v_hand from public.hands h
     where h.id = p_hand_id and h.owner_id = v_owner;
    if not found then
      raise exception 'No stored hand with id %', p_hand_id using errcode = '23503';
    end if;
    v_text := null;
    if v_hand.phf is not null then
      -- The share follows the stored row (`read_share` reads its PHF).
      v_phf := null;
    else
      -- (20271114090000) A text-only row: the share keeps the client's parse
      -- of it, once it is shown to be this hand, without its private meta.
      -- `read_share` falls back to it, so the share never needs a PHF the row
      -- does not have.
      if not public.hand_phf_matches(v_hand, p_phf) then
        raise exception 'This hand is stored as text: send its parsed document to share it.'
          using errcode = '22023';
      end if;
      v_phf := public.phf_redact_private(p_phf);
    end if;
  end if;

  for i in 1..8 loop
    v_slug := public.generate_share_slug(10);
    begin
      insert into public.shares (slug, hand_id, phf, standard_text, title, owner_id, spoilers, show_names)
      values (
        v_slug,
        p_hand_id,
        v_phf,
        v_text,
        nullif(btrim(coalesce(p_title, '')), ''),
        v_owner,
        coalesce(p_spoilers, false),
        -- An explicit null is "no choice made", which is hidden.
        coalesce(p_show_names, false)
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_slug := null;
    end;
  end loop;

  if v_id is null then
    raise exception 'Could not allocate a unique share slug' using errcode = '53400';
  end if;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'showNames', coalesce(p_show_names, false));
end;
$$;

-- -------------------------------------------------------------- the export --

-- `standardText` was already in every row; `site` joins it so a text-only
-- row (`phf` null) can be read back from the export alone.
create or replace function public.export_my_hands(p_after jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 1000, p_derived boolean DEFAULT true)
returns jsonb
language plpgsql
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  v_owner   uuid := auth.uid();
  -- 2 000 hands a page; 1 000 with their derived rows (~25 MB of JSON, ~2 s:
  -- a 2 000-hand page with them is ~55 MB and nears the 8 s statement timeout).
  v_limit   integer := least(greatest(coalesce(p_limit, 1000), 1), case when p_derived then 1000 else 2000 end);
  v_created timestamptz;
  v_id      uuid;
  v_ids     uuid[];
  v_hands   jsonb;
  v_last    jsonb;
  v_n       integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  perform public.account_export_charge();
  if p_after is not null then
    begin
      v_created := (p_after ->> 'created_at')::timestamptz;
      v_id := (p_after ->> 'id')::uuid;
    exception when others then
      raise exception 'The export cursor is not valid.' using errcode = '22023';
    end;
    if v_created is null or v_id is null then
      raise exception 'The export cursor is not valid.' using errcode = '22023';
    end if;
  end if;

  with page as (
    select h.id, h.hand_key, h.site, h.origin, h.created_at, h.schema_version, h.parser_version, h.source_filename,
           h.standard_text, h.source_text, h.phf
    from public.hands h
    where h.owner_id = v_owner
      and (v_created is null or (h.created_at, h.id) > (v_created, v_id))
    order by h.created_at, h.id
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'handKey', p.hand_key, 'site', p.site, 'origin', p.origin, 'createdAt', p.created_at,
           'schemaVersion', p.schema_version, 'parserVersion', p.parser_version,
           'sourceFilename', p.source_filename, 'standardText', p.standard_text, 'sourceText', p.source_text,
           'phf', p.phf) order by p.created_at, p.id), '[]'::jsonb),
         array_agg(p.id order by p.created_at, p.id),
         count(*)::integer,
         (array_agg(jsonb_build_object('created_at', p.created_at, 'id', p.id) order by p.created_at desc, p.id desc))[1]
    into v_hands, v_ids, v_n, v_last
  from page p;

  if not p_derived or v_n = 0 then
    return jsonb_build_object('hands', v_hands, 'next', case when v_n = v_limit then v_last end);
  end if;

  return jsonb_build_object(
    'hands', v_hands,
    'hand_stats', coalesce((select jsonb_agg(to_jsonb(s) order by s.hand_id, s.stats_version, s.seat)
                              from public.hand_stats s where s.hand_id = any (v_ids) and s.owner_id = v_owner), '[]'::jsonb),
    'hand_stats_ev', coalesce((select jsonb_agg(to_jsonb(e) order by e.hand_id, e.ev_version, e.seat)
                                 from public.hand_stats_ev e where e.hand_id = any (v_ids) and e.owner_id = v_owner), '[]'::jsonb),
    'hand_analysis', coalesce((select jsonb_agg(to_jsonb(a) order by a.hand_id, a.analysis_version)
                                 from public.hand_analysis a where a.hand_id = any (v_ids) and a.owner_id = v_owner), '[]'::jsonb),
    'decision_analysis', coalesce((select jsonb_agg(to_jsonb(d) order by d.hand_id, d.analysis_version, d.ord)
                                     from public.decision_analysis d where d.hand_id = any (v_ids) and d.owner_id = v_owner), '[]'::jsonb),
    'next', case when v_n = v_limit then v_last end);
end;
$function$;

-- ---------------------------------------------------------- the backfill --

-- Applies the backfill's verified texts (`tests/scripts/text-storage/
-- backfill.mjs`: `{id, standard_text}` of its `ok` rows, at most 1000 a call).
-- For each listed hand that still has its PHF, in this order: its chart set
-- (if the row has none yet), a redacted snapshot of the PHF for each of its
-- hand-linked share links that has none (so `read_share` keeps working), then
-- the text, and the PHF dropped. A hand already without a PHF is skipped, so
-- a batch can be sent again. Service role only: the text is trusted to be the
-- verified one.
create or replace function public.hands_store_text(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_received integer;
  v_shares   integer;
  v_stored   integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'hands_store_text expects a JSON array of {id, standard_text}'
      using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 1000 then
    raise exception 'hands_store_text takes at most 1000 rows per call (got %)', v_received
      using errcode = '22023';
  end if;

  create temp table if not exists hands_store_text_input (
    id   uuid primary key,
    text text not null
  ) on commit drop;
  truncate pg_temp.hands_store_text_input;
  insert into pg_temp.hands_store_text_input (id, text)
  select distinct on ((e ->> 'id')::uuid) (e ->> 'id')::uuid, e ->> 'standard_text'
  from jsonb_array_elements(p_rows) e
  where jsonb_typeof(e -> 'id') = 'string'
    and jsonb_typeof(e -> 'standard_text') = 'string'
    and btrim(e ->> 'standard_text') <> ''
    and char_length(e ->> 'standard_text') <= 200000;

  update public.shares s
     set phf = public.phf_redact_private(h.phf)
    from public.hands h
    join pg_temp.hands_store_text_input i on i.id = h.id
   where s.hand_id = h.id and s.phf is null and h.phf is not null;
  get diagnostics v_shares = row_count;

  update public.hands h
     set table_set     = coalesce(h.table_set, public.analysis_hand_table_set(h.phf)),
         standard_text = i.text,
         phf           = null
    from pg_temp.hands_store_text_input i
   where h.id = i.id and h.phf is not null;
  get diagnostics v_stored = row_count;

  return jsonb_build_object('received', v_received, 'stored', v_stored,
                            'skipped', v_received - v_stored, 'sharesSnapshotted', v_shares);
end;
$$;

comment on function public.hands_store_text(jsonb) is
  'The text-storage backfill''s apply step (20271114090000): for each {id, standard_text} '
  'whose hand still has a PHF - fill table_set, snapshot its share links'' PHF, store the '
  'text, drop the PHF. Service role only.';
revoke all on function public.hands_store_text(jsonb) from public, anon, authenticated;
grant execute on function public.hands_store_text(jsonb) to service_role;

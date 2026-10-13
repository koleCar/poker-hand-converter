-- Rail R0.11: the unsupported-format registry on `unparsed_hands`
-- (docs/RAIL-PLAN.md R0.11, amendment A4; docs/RAIL_GUIDELINE.md,
-- "Registar nepodrzanih formata").
--
-- The desktop app keeps a local registry of files no parser claims (R1.2)
-- and, with the user's consent, sends an anonymised sample of each to the
-- table the web already fills: `unparsed_hands`, through the RPC the web
-- already calls, `record_conversion_failures`. A4 extends the table instead
-- of adding `unsupported_formats` beside it - two tables for one thing drift
-- apart. Additive only: every existing row becomes `origin = 'web'`, and a
-- web client that sends exactly what it sends today gets exactly what it
-- gets today.
--
-- New columns:
--
--   origin             'web' (default) or 'desktop': which client created the
--                      row - and so whose rules its `raw_text` follows.
--   os                 'windows' / 'macos' / 'linux': the last desktop client
--                      that reported the fingerprint.
--   client_version     that client's version.
--   consented_at       when the user agreed to share the sample. Required on
--                      a desktop row; describes the row's `raw_text`, so it is
--                      set once, at insert, and never rewritten.
--   anonymiser_version which anonymiser produced `raw_text` (`rail-anon/1`,
--                      `rail_core::anonymise::ANONYMISER_VERSION`). Required
--                      on a desktop row; `null` means verbatim (web).
--   guessed_site,      the core's guess below the detection threshold, or a
--   guess_confidence   known format's signature (`rail_core::unrecognized`).
--                      Kept apart from `detected_site`, which names the parser
--                      that refused a hand and groups `unparsed_gaps`.
--
-- The consent rule is in the database twice: the RPC drops a desktop record
-- that lacks a valid consent time, an anonymiser version, an OS or a client
-- version, or whose sample is longer than 64 KiB (counted in `skipped`, the
-- way it already drops a malformed record); and a CHECK constraint refuses
-- such a row whatever writes it.
--
-- What the database cannot check is that a sample really is anonymised: it
-- sees text. The desktop client sends only `rail_core::anonymise` output,
-- and that guarantee is tested in `core/rail-core/tests/anonymise.rs`; the
-- version column says which rules a row went through, so a row produced by
-- a version later found wanting can be found and deleted.
--
-- Security model unchanged (docs/DATABASE.md, threat model): no client
-- INSERT / UPDATE / DELETE on the table; the definer RPC is the only door,
-- with an empty search_path, the `auth.uid()` check, validation and
-- `enforce_rate_limit`; reads stay under `unparsed_own_select` (a row is
-- readable by its first submitter only). The consent-time parser is a plain
-- invoker helper that no client may execute.
--
-- `unparsed_gaps` gains two trailing columns - `desktop_hands` and
-- `guessed_sites` - for the weekly triage (docs/unsupported-formats.md);
-- its grouping and existing columns are unchanged.

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

do $$
begin
  create type public.unparsed_origin as enum ('web', 'desktop');
exception when duplicate_object then
  null;
end;
$$;

comment on type public.unparsed_origin is
  'Which client created an unparsed_hands row: the web converter (verbatim sample) or the desktop app (anonymised sample, with consent).';

alter table public.unparsed_hands
  add column if not exists origin public.unparsed_origin not null default 'web',
  add column if not exists os text,
  add column if not exists client_version text,
  add column if not exists consented_at timestamptz,
  add column if not exists anonymiser_version text,
  add column if not exists guessed_site text,
  add column if not exists guess_confidence real;

alter table public.unparsed_hands
  drop constraint if exists unparsed_os_ok,
  drop constraint if exists unparsed_client_version_ok,
  drop constraint if exists unparsed_anonymiser_version_ok,
  drop constraint if exists unparsed_guessed_site_len,
  drop constraint if exists unparsed_guess_confidence_ok,
  drop constraint if exists unparsed_consent_before_sample,
  drop constraint if exists unparsed_desktop_consent,
  drop constraint if exists unparsed_desktop_sample_size;

alter table public.unparsed_hands
  add constraint unparsed_os_ok
    check (os is null or os in ('windows', 'macos', 'linux')),
  add constraint unparsed_client_version_ok
    check (client_version is null or client_version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$'),
  add constraint unparsed_anonymiser_version_ok
    check (anonymiser_version is null or anonymiser_version ~ '^[0-9A-Za-z][0-9A-Za-z.+_/-]{0,63}$'),
  add constraint unparsed_guessed_site_len
    check (guessed_site is null or char_length(guessed_site) between 1 and 64),
  add constraint unparsed_guess_confidence_ok
    check (guess_confidence is null or (guess_confidence >= 0 and guess_confidence <= 1)),
  -- Consent comes before the sample (five minutes of client clock skew).
  add constraint unparsed_consent_before_sample
    check (consented_at is null or consented_at <= first_seen_at + interval '5 minutes'),
  -- The consent rule: a desktop row exists only with the user's consent, an
  -- anonymiser version, and the client that sent it.
  add constraint unparsed_desktop_consent
    check (origin = 'web' or (consented_at is not null
                              and anonymiser_version is not null
                              and os is not null
                              and client_version is not null)),
  -- A desktop sample is `shareable_sample`, at most 64 KiB.
  add constraint unparsed_desktop_sample_size
    check (origin = 'web' or char_length(raw_text) <= 65536);

comment on column public.unparsed_hands.origin is
  'Which client created the row: web (verbatim raw_text) or desktop (anonymised raw_text, consented_at set). Never changed after insert.';
comment on column public.unparsed_hands.os is
  'The OS of the last desktop client that reported this fingerprint: windows, macos or linux.';
comment on column public.unparsed_hands.client_version is
  'The version of the last desktop client that reported this fingerprint.';
comment on column public.unparsed_hands.consented_at is
  'When the user agreed to share this sample. Required for origin = desktop; set at insert only.';
comment on column public.unparsed_hands.anonymiser_version is
  'The anonymiser that produced raw_text (rail_core::anonymise::ANONYMISER_VERSION). Required for origin = desktop; null means verbatim.';
comment on column public.unparsed_hands.guessed_site is
  'For a file no parser claims: a detector score below the threshold, or a known format''s signature (rail_core::unrecognized).';
comment on column public.unparsed_hands.guess_confidence is
  'The confidence of guessed_site, 0..1.';

-- ---------------------------------------------------------------------------
-- 2. The consent time, parsed without failing
-- ---------------------------------------------------------------------------
--
-- Recording a failure must never itself fail (`record_conversion_failures`
-- truncates and skips rather than raises), and a cast of client text to
-- timestamptz raises on `2026-02-31`. This parses an ISO 8601 instant with
-- an explicit zone - so the result does not depend on the session's
-- TimeZone - and returns null for anything else, for a time in the future
-- (beyond five minutes of skew) or before the registry existed.

create or replace function public.unparsed_consent_instant(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if p_value is null
     or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    return null;
  end if;
  begin
    v_at := p_value::timestamptz;
  exception when others then
    return null;
  end;
  if v_at > now() + interval '5 minutes' or v_at < timestamptz '2026-01-01 00:00:00+00' then
    return null;
  end if;
  return v_at;
end;
$$;

revoke all on function public.unparsed_consent_instant(text) from public, anon, authenticated;

comment on function public.unparsed_consent_instant(text) is
  'Parses a client consent time (ISO 8601 with a zone), null when malformed, in the future or before 2026. Called by record_conversion_failures only.';

-- ---------------------------------------------------------------------------
-- 3. The one write path, extended
-- ---------------------------------------------------------------------------
--
-- `20260922130000`'s function with the new optional keys: `origin`, `os`,
-- `clientVersion`, `consentedAt`, `anonymiserVersion`, `guessedSite`,
-- `guessConfidence`. Everything else - the session check, the 200-record
-- batch, the rate limit, truncation, the dedupe, first-submitter ownership,
-- the counters - is as it was.

create or replace function public.record_conversion_failures(p_failures jsonb)
returns jsonb
language plpgsql
-- Still `security definer`: the write path has to stay the only way a caller
-- can touch this table, so that `status`, `notes`, `occurrences` and now
-- `origin` and `consented_at` cannot be forged. Anonymous callers are refused.
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_new      integer;
  v_touched  integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to contribute conversion samples.'
      using errcode = '42501';
  end if;

  if p_failures is null or jsonb_typeof(p_failures) <> 'array' then
    raise exception 'record_conversion_failures expects a JSON array'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_failures);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'created', 0, 'updated', 0, 'skipped', 0);
  end if;
  if v_received > 200 then
    raise exception 'record_conversion_failures accepts at most 200 records per call (got %)', v_received
      using errcode = '53400';
  end if;

  perform public.enforce_rate_limit('unparsed_insert', v_received, 5000, interval '10 minutes');

  with input as (
    select
      lower(btrim(coalesce(f ->> 'fingerprint', '')))                      as fingerprint,
      f ->> 'rawText'                                                      as raw_text,
      left(nullif(btrim(coalesce(f ->> 'detectedSite', '')), ''), 64)      as detected_site,
      case
        when nullif(btrim(coalesce(f ->> 'detectionConfidence', '')), '') is null then null
        else least(greatest(btrim(f ->> 'detectionConfidence')::real, 0::real), 1::real)
      end                                                                  as detection_confidence,
      case lower(btrim(coalesce(f ->> 'stage', '')))
        when 'split'     then 'split'
        when 'detect'    then 'detect'
        when 'validate'  then 'validate'
        when 'serialize' then 'serialize'
        else 'parse'
      end::public.conversion_stage                                         as stage,
      left(coalesce(nullif(btrim(coalesce(f ->> 'reason', '')), ''), 'unknown'), 120)         as reason,
      left(coalesce(nullif(btrim(coalesce(f ->> 'message', '')), ''), 'unspecified'), 2000)   as message,
      left(coalesce(nullif(btrim(coalesce(f ->> 'parserVersion', '')), ''), 'unknown'), 64)   as parser_version,
      left(nullif(btrim(coalesce(f ->> 'sourceFilename', '')), ''), 255)   as source_filename,
      -- R0.11. An absent origin is the web, as before; an unknown one drops
      -- the record.
      case lower(btrim(coalesce(f ->> 'origin', '')))
        when ''        then 'web'
        when 'web'     then 'web'
        when 'desktop' then 'desktop'
      end                                                                  as origin,
      case lower(btrim(coalesce(f ->> 'os', '')))
        when 'windows' then 'windows'
        when 'macos'   then 'macos'
        when 'linux'   then 'linux'
      end                                                                  as os,
      case
        when btrim(coalesce(f ->> 'clientVersion', '')) ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$'
          then btrim(f ->> 'clientVersion')
      end                                                                  as client_version,
      public.unparsed_consent_instant(btrim(f ->> 'consentedAt'))          as consented_at,
      case
        when btrim(coalesce(f ->> 'anonymiserVersion', '')) ~ '^[0-9A-Za-z][0-9A-Za-z.+_/-]{0,63}$'
          then btrim(f ->> 'anonymiserVersion')
      end                                                                  as anonymiser_version,
      left(nullif(btrim(coalesce(f ->> 'guessedSite', '')), ''), 64)       as guessed_site,
      case
        when btrim(coalesce(f ->> 'guessConfidence', '')) ~ '^[0-9]*[.]?[0-9]+$'
          then least(greatest(btrim(f ->> 'guessConfidence')::real, 0::real), 1::real)
      end                                                                  as guess_confidence
    from jsonb_array_elements(p_failures) as f
  ),
  deduped as (
    select distinct on (fingerprint) *
    from input
    where fingerprint ~ '^[0-9a-f]{64}$'
      and raw_text is not null
      and char_length(raw_text) between 1 and 131072
      and origin is not null
      -- The consent rule (also a CHECK constraint): a desktop sample comes
      -- with the user's consent, the anonymiser that made it, the client
      -- that sent it, and within the 64 KiB sample cap.
      and (origin = 'web'
           or (consented_at is not null
               and anonymiser_version is not null
               and os is not null
               and client_version is not null
               and char_length(raw_text) <= 65536))
    order by fingerprint
  ),
  upserted as (
    insert into public.unparsed_hands as u (
      fingerprint, raw_text, detected_site, detection_confidence,
      stage, reason, message, parser_version, source_filename, submitted_by,
      origin, os, client_version, consented_at, anonymiser_version,
      guessed_site, guess_confidence
    )
    select
      d.fingerprint, d.raw_text, d.detected_site, d.detection_confidence,
      d.stage, d.reason, d.message, d.parser_version, d.source_filename, v_owner,
      d.origin::public.unparsed_origin, d.os, d.client_version,
      -- A web row carries no consent of its own: the web keeps its samples
      -- under its own rules (sign-in, read by the submitter only).
      case when d.origin = 'desktop' then d.consented_at end,
      case when d.origin = 'desktop' then d.anonymiser_version end,
      d.guessed_site, d.guess_confidence
    from deduped d
    on conflict (fingerprint) do update
      set occurrences   = u.occurrences + 1,
          last_seen_at  = now(),
          stage          = excluded.stage,
          reason         = excluded.reason,
          message        = excluded.message,
          parser_version = excluded.parser_version,
          detected_site  = coalesce(excluded.detected_site, u.detected_site),
          detection_confidence = coalesce(excluded.detection_confidence, u.detection_confidence),
          source_filename = coalesce(u.source_filename, excluded.source_filename),
          -- First submitter keeps the row. Re-attributing it to whoever
          -- uploaded it most recently would silently move read access between
          -- accounts, and `occurrences` already records that it was seen again.
          submitted_by    = coalesce(u.submitted_by, excluded.submitted_by),
          -- R0.11. `origin`, `consented_at` and `anonymiser_version` describe
          -- `raw_text`, which a repeat never rewrites, so they stay. The
          -- client and the guess are refreshed like the diagnostics above.
          os               = coalesce(excluded.os, u.os),
          client_version   = coalesce(excluded.client_version, u.client_version),
          guessed_site     = coalesce(excluded.guessed_site, u.guessed_site),
          guess_confidence = coalesce(excluded.guess_confidence, u.guess_confidence)
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert)::integer, count(*)::integer
  into v_new, v_touched
  from upserted;

  return jsonb_build_object(
    'received', v_received,
    'created',  coalesce(v_new, 0),
    'updated',  coalesce(v_touched, 0) - coalesce(v_new, 0),
    'skipped',  v_received - coalesce(v_touched, 0)
  );
end;
$$;

revoke all on function public.record_conversion_failures(jsonb) from public;
revoke execute on function public.record_conversion_failures(jsonb) from anon;
grant execute on function public.record_conversion_failures(jsonb) to authenticated;

comment on function public.record_conversion_failures(jsonb) is
  'Upsert ConversionFailure records by fingerprint, incrementing occurrences atomically. Requires a session; records the first submitter. A desktop record (origin = desktop) needs consentedAt, anonymiserVersion, os and clientVersion, or it is skipped.';

-- ---------------------------------------------------------------------------
-- 4. unparsed_gaps: two trailing columns for the weekly triage
-- ---------------------------------------------------------------------------

create or replace view public.unparsed_gaps
with (security_invoker = true) as
select
  coalesce(u.detected_site, '(unknown)') as detected_site,
  u.stage,
  u.reason,
  u.status,
  count(*)::bigint          as distinct_hands,
  sum(u.occurrences)::bigint as total_occurrences,
  min(u.first_seen_at)      as first_seen_at,
  max(u.last_seen_at)       as last_seen_at,
  count(*) filter (where u.origin = 'desktop')::bigint as desktop_hands,
  coalesce(
    array_agg(distinct u.guessed_site order by u.guessed_site) filter (where u.guessed_site is not null),
    '{}'::text[]
  )                         as guessed_sites
from public.unparsed_hands u
group by 1, 2, 3, 4;

comment on view public.unparsed_gaps is
  'Failure corpus rolled up by site / stage / reason / status, with the desktop share and the core''s guesses. Order by total_occurrences to find the highest-value parser to write next. security_invoker so the base table RLS still applies.';

revoke all on public.unparsed_gaps from anon, authenticated;
grant select on public.unparsed_gaps to anon, authenticated;

commit;

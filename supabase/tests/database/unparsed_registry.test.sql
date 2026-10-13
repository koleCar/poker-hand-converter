-- pgTAP: Rail R0.11, the unsupported-format registry -- `20270414090000_unparsed_registry.sql`.
--
-- What has to hold:
--
--   * the new columns, their types and defaults; every existing row and every
--     web record (the keys the web sends today) is `origin = 'web'`;
--   * the security model is unchanged: no client INSERT / UPDATE / DELETE on
--     `unparsed_hands`, RLS on, the writer `security definer` with an empty
--     search_path, executable by `authenticated` and not by `anon`; the
--     consent-time helper executable by no client;
--   * the consent rule: a desktop record is stored only with a valid consent
--     time, an anonymiser version, an OS and a client version, and within
--     the 64 KiB sample cap - otherwise it is skipped, without failing the
--     batch; and a CHECK constraint refuses such a row from any writer;
--   * a repeat counts, keeps the row's origin and consent, refreshes the
--     client and the guess;
--   * one user still cannot read another's rows, through the table or the
--     view; the view carries `desktop_hands` and `guessed_sites`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(41);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a0a01', 'registry.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000b0b01', 'registry.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon() to anon, authenticated;

-- A desktop record, valid unless a test overrides a key.
create function pg_temp.desktop(p_fingerprint text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'fingerprint', p_fingerprint,
    'rawText', '<HISTORY ID="1"><PLAYER NAME="Player1" SEAT="1"/></HISTORY>',
    'stage', 'detect',
    'reason', 'unknown-site',
    'message', 'The text does not match any hand history format we recognise.',
    'parserVersion', '0',
    'sourceFilename', 'session1.xml',
    'origin', 'desktop',
    'os', 'windows',
    'clientVersion', '0.1.0',
    'consentedAt', '2026-06-01T10:00:00Z',
    'anonymiserVersion', 'rail-anon/1',
    'guessedSite', 'bossmedia',
    'guessConfidence', 1
  ) || p_extra;
$$;
grant execute on function pg_temp.desktop(text, jsonb) to anon, authenticated;

-- -------------------------------------------------------------- schema --

select col_type_is('public', 'unparsed_hands', 'origin', 'unparsed_origin', 'origin is the unparsed_origin enum');
select ok(
  (select column_default like '''web''::%' from information_schema.columns
   where table_schema = 'public' and table_name = 'unparsed_hands' and column_name = 'origin'),
  'origin defaults to web');
select col_not_null('public', 'unparsed_hands', 'origin', 'origin is not null');
select is(enum_range(null::public.unparsed_origin)::text[], array['web', 'desktop'], 'the two origins');
select col_type_is('public', 'unparsed_hands', 'consented_at', 'timestamp with time zone', 'consented_at is a timestamptz');
select ok(
  (select count(*) = 6 from information_schema.columns
   where table_schema = 'public' and table_name = 'unparsed_hands'
     and column_name in ('os', 'client_version', 'consented_at', 'anonymiser_version', 'guessed_site', 'guess_confidence')
     and is_nullable = 'YES'),
  'os, client_version, consented_at, anonymiser_version, guessed_site, guess_confidence exist and are nullable');
select ok(
  (select count(*) = 2 from information_schema.columns
   where table_schema = 'public' and table_name = 'unparsed_gaps'
     and column_name in ('desktop_hands', 'guessed_sites')),
  'unparsed_gaps has desktop_hands and guessed_sites');

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'unparsed_hands'
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client write grant on unparsed_hands');
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.unparsed_hands'::regclass),
  'RLS is on');
select ok(
  (select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.oid = 'public.record_conversion_failures(jsonb)'::regprocedure),
  'the writer is security definer with an empty search_path');
select ok(
  (select not p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.oid = 'public.unparsed_consent_instant(text)'::regprocedure),
  'the consent-time helper is invoker with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.record_conversion_failures(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.record_conversion_failures(jsonb)', 'execute'),
  'authenticated may record, anon may not');
select ok(
  not has_function_privilege('authenticated', 'public.unparsed_consent_instant(text)', 'execute')
  and not has_function_privilege('anon', 'public.unparsed_consent_instant(text)', 'execute'),
  'no client may execute the consent-time helper');

-- ----------------------------------------------------------- the web --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a0a01');

select is(
  public.record_conversion_failures(jsonb_build_array(jsonb_build_object(
    'fingerprint', repeat('1', 64), 'rawText', 'Unknown Poker Hand #1', 'stage', 'detect',
    'reason', 'unknown-site', 'message', 'm', 'parserVersion', '0', 'sourceFilename', 'a.txt'))),
  '{"received":1,"created":1,"updated":0,"skipped":0}'::jsonb,
  'A records a web failure with the keys the web sends today');
select is(
  (select format('%s:%s:%s:%s:%s', origin, os is null, client_version is null, consented_at is null, anonymiser_version is null)
   from public.unparsed_hands where fingerprint = repeat('1', 64)),
  'web:t:t:t:t', 'it is a web row with no desktop fields');
select is(
  public.record_conversion_failures(jsonb_build_array(jsonb_build_object(
    'fingerprint', repeat('2', 64), 'rawText', 'x', 'origin', 'web', 'consentedAt', '2026-06-01T10:00:00Z',
    'anonymiserVersion', 'rail-anon/1'))) ->> 'created',
  '1', 'a web record that sends consent and an anonymiser version is stored');
select is(
  (select format('%s:%s:%s', origin, consented_at is null, anonymiser_version is null)
   from public.unparsed_hands where fingerprint = repeat('2', 64)),
  'web:t:t', 'without them: they describe a desktop sample only');

-- ------------------------------------------------------- the desktop --

select is(
  public.record_conversion_failures(jsonb_build_array(pg_temp.desktop(repeat('a', 64)))),
  '{"received":1,"created":1,"updated":0,"skipped":0}'::jsonb,
  'A records a desktop sample with consent');
select is(
  (select format('%s|%s|%s|%s|%s|%s|%s', origin, os, client_version, consented_at = '2026-06-01T10:00:00Z'::timestamptz,
                 anonymiser_version, guessed_site, guess_confidence)
   from public.unparsed_hands where fingerprint = repeat('a', 64)),
  'desktop|windows|0.1.0|t|rail-anon/1|bossmedia|1', 'every desktop field is stored');

select is(
  public.record_conversion_failures(jsonb_build_array(
    pg_temp.desktop(repeat('b', 64), '{"consentedAt": null}'),
    pg_temp.desktop(repeat('c', 64)) - 'consentedAt',
    pg_temp.desktop(repeat('d', 64), '{"consentedAt": "2099-01-01T00:00:00Z"}'),
    pg_temp.desktop(repeat('e', 64), '{"consentedAt": "2026-02-31T10:00:00Z"}'),
    pg_temp.desktop(repeat('f', 64), '{"consentedAt": "yesterday"}'),
    pg_temp.desktop(repeat('0', 63) || '9', '{"consentedAt": "2026-06-01T10:00:00"}'),
    pg_temp.desktop(repeat('0', 62) || '98', '{"consentedAt": "2020-06-01T10:00:00Z"}')
  )),
  '{"received":7,"created":0,"updated":0,"skipped":7}'::jsonb,
  'a desktop record without a valid consent time is skipped: missing, null, future, impossible, not a time, no zone, too old');
select is(
  public.record_conversion_failures(jsonb_build_array(
    pg_temp.desktop(repeat('0', 61) || '987') - 'anonymiserVersion',
    pg_temp.desktop(repeat('0', 60) || '9876', '{"anonymiserVersion": "rail anon"}'),
    pg_temp.desktop(repeat('0', 59) || '98765', '{"os": "beos"}'),
    pg_temp.desktop(repeat('0', 58) || '987654') - 'os',
    pg_temp.desktop(repeat('0', 57) || '9876543') - 'clientVersion',
    pg_temp.desktop(repeat('0', 56) || '98765432', '{"clientVersion": "1.0; drop table"}'),
    pg_temp.desktop(repeat('0', 55) || '987654321', jsonb_build_object('rawText', repeat('x', 65537))),
    pg_temp.desktop(repeat('0', 54) || '9876543210', '{"origin": "mobile"}')
  )),
  '{"received":8,"created":0,"updated":0,"skipped":8}'::jsonb,
  'and so is one without an anonymiser version, a known OS or a client version, one over 64 KiB, and an unknown origin');
select is(
  (select count(*)::int from public.unparsed_hands
   where fingerprint in (repeat('b', 64), repeat('c', 64), repeat('d', 64), repeat('e', 64), repeat('f', 64))
      or fingerprint like '00000%'),
  0, 'none of them was stored');
select is(
  public.record_conversion_failures(jsonb_build_array(
    pg_temp.desktop(repeat('3', 64), '{"consentedAt": "2026-06-01T12:00:00+02:00", "os": "MacOS", "clientVersion": "0.2.0-beta.1"}'),
    pg_temp.desktop(repeat('4', 64), jsonb_build_object('rawText', repeat('x', 65536), 'consentedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
  )),
  '{"received":2,"created":2,"updated":0,"skipped":0}'::jsonb,
  'an offset zone, a mixed-case OS, a pre-release version, a 64 KiB sample and a consent given just now are fine');
select is(
  (select format('%s:%s', os, consented_at = '2026-06-01T10:00:00Z'::timestamptz)
   from public.unparsed_hands where fingerprint = repeat('3', 64)),
  'macos:t', 'the OS is normalised and the offset honoured');

-- ------------------------------------------------------------ repeats --

select is(
  public.record_conversion_failures(jsonb_build_array(
    pg_temp.desktop(repeat('a', 64), '{"os": "linux", "clientVersion": "0.3.0", "consentedAt": "2026-07-01T00:00:00Z", "anonymiserVersion": "rail-anon/2", "guessedSite": "merge", "guessConfidence": 0.75}'))),
  '{"received":1,"created":0,"updated":1,"skipped":0}'::jsonb,
  'the same desktop file again is an update');
select is(
  (select format('%s|%s|%s|%s|%s|%s|%s|%s', occurrences, origin, os, client_version,
                 consented_at = '2026-06-01T10:00:00Z'::timestamptz, anonymiser_version, guessed_site, guess_confidence)
   from public.unparsed_hands where fingerprint = repeat('a', 64)),
  '2|desktop|linux|0.3.0|t|rail-anon/1|merge|0.75',
  'it counts, keeps origin, consent and anonymiser (they describe raw_text), refreshes the client and the guess');
select is(
  public.record_conversion_failures(jsonb_build_array(pg_temp.desktop(repeat('1', 64)))) ->> 'updated',
  '1', 'a desktop client reporting a file the web recorded is an update');
select is(
  (select format('%s|%s|%s|%s|%s', occurrences, origin, os, consented_at is null, raw_text)
   from public.unparsed_hands where fingerprint = repeat('1', 64)),
  '2|web|windows|t|Unknown Poker Hand #1', 'the row stays a web row with its own text; the client is recorded');

-- ------------------------------------------------- the constraint --

reset role;

select throws_ok(
  $$insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version, origin, os, client_version, anonymiser_version)
    values (repeat('5', 64), 'x', 'detect', 'unknown-site', 'm', '0', 'desktop', 'windows', '0.1.0', 'rail-anon/1')$$,
  '23514', null, 'a desktop row without consent is refused whatever writes it');
select throws_ok(
  $$insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version, origin, os, client_version, consented_at)
    values (repeat('6', 64), 'x', 'detect', 'unknown-site', 'm', '0', 'desktop', 'windows', '0.1.0', now())$$,
  '23514', null, 'and without an anonymiser version');
select throws_ok(
  $$insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version, origin, os, client_version, consented_at, anonymiser_version)
    values (repeat('7', 64), repeat('x', 65537), 'detect', 'unknown-site', 'm', '0', 'desktop', 'windows', '0.1.0', now(), 'rail-anon/1')$$,
  '23514', null, 'and longer than 64 KiB');
select throws_ok(
  $$insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version, consented_at)
    values (repeat('8', 64), 'x', 'detect', 'unknown-site', 'm', '0', now() + interval '1 hour')$$,
  '23514', null, 'consent cannot postdate the sample');
select lives_ok(
  $$insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version)
    values (repeat('9', 64), 'x', 'detect', 'unknown-site', 'm', '0')$$,
  'a row written as before is a web row');
select is(
  (select origin::text from public.unparsed_hands where fingerprint = repeat('9', 64)),
  'web', 'and gets the default');

-- --------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000b0b01');

select is(
  (select count(*)::int from public.unparsed_hands),
  0, 'B reads none of A''s rows');
select is(
  (select count(*)::int from public.unparsed_gaps),
  0, 'nor anything of them through the view');
select is(
  public.record_conversion_failures(jsonb_build_array(pg_temp.desktop(repeat('a', 64), '{"os": "macos", "guessedSite": "merge", "guessConfidence": 0.75}'))) ->> 'updated',
  '1', 'B reporting the same file counts it');
select is(
  (select count(*)::int from public.unparsed_hands),
  0, 'without gaining read access to A''s row');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a0a01');

select is(
  (select format('%s:%s', desktop_hands, guessed_sites)
   from public.unparsed_gaps where detected_site = '(unknown)' and reason = 'unknown-site'),
  '3:{bossmedia,merge}', 'A''s view counts its desktop rows and lists the guesses');

select pg_temp.act_as_anon();

select throws_ok(
  $$select public.record_conversion_failures('[]'::jsonb)$$,
  '42501', null, 'anon cannot record');
select is(
  (select count(*)::int from public.unparsed_hands),
  0, 'anon reads nothing');

select * from finish();
rollback;

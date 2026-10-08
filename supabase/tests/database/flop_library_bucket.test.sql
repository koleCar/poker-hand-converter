-- pgTAP: the flop library's Storage bucket -- `20270331090000_flop_library_bucket.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(7);

select is(
  (select public from storage.buckets where id = 'flop-library'),
  true,
  'the flop-library bucket exists and is public'
);
select is(
  (select file_size_limit from storage.buckets where id = 'flop-library'),
  1048576::bigint,
  'chunks are capped at 1 MB'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'flop-library'),
  array['application/octet-stream', 'application/json'],
  'only chunks and manifests'
);
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') || coalesce(with_check, '')) like '%flop-library%'),
  0,
  'no storage.objects policy mentions the bucket: no client list or write'
);

-- An object placed by the service role (as the upload script does).
insert into storage.objects (bucket_id, name, owner)
values ('flop-library', 'nlhe-cash-6max-100bb/flop-m1/manifest.json', null);

set local role authenticated;
select is(
  (select count(*)::int from storage.objects where bucket_id = 'flop-library'),
  0,
  'authenticated cannot list the bucket'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('flop-library', 'x/evil.bin')$$,
  '42501',
  null,
  'authenticated cannot write to the bucket'
);
reset role;

set local role anon;
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('flop-library', 'x/evil.bin')$$,
  '42501',
  null,
  'anon cannot write to the bucket'
);
reset role;

select * from finish();
rollback;

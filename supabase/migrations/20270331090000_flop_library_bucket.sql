-- The flop library (A5b, docs/ANALYSIS-PLAN.md §10): the solved flop chunks
-- the analysis worker fetches (`<set>/<tree>/manifest.json`, then
-- `<set>/<tree>/<line>/<flop>.bin`). Public and read-only: a public bucket
-- serves its objects by URL without any policy, and storage.objects gets no
-- policy for this bucket at all - so anon and authenticated can neither list,
-- write, update nor delete. Chunks are uploaded by the owner's local script
-- (tests/scripts/flop-library/upload.sh) with the service role, which never
-- leaves that script's environment.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flop-library', 'flop-library', true, 1048576, array['application/octet-stream', 'application/json'])
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public)
values ('frontend-site', 'frontend-site', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'frontend_site_public_read'
  ) then
    create policy frontend_site_public_read
      on storage.objects
      for select
      using (bucket_id = 'frontend-site');
  end if;
end
$$;

-- Feedback: bug reports, feature requests and questions from the web and the
-- desktop app, each with up to three screenshots.
--
-- Written only by the `feedback` Edge Function with the service role: it
-- validates the report, checks the sender's rate limit and stores the images
-- in the private `feedback` bucket. Nobody reads the table through the API;
-- the reports are read in the Supabase dashboard for now.
--
-- Anyone may send one, signed in or not. A signed-in sender's report carries
-- `user_id` (and goes with the account on deletion); a visitor's carries only
-- what they typed. `client_hash` is a keyed hash of the sender's address, kept
-- for the rate limit and never reversible to the address without the key.

begin;

create table public.feedback (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('bug', 'feature', 'question')),
  message     text not null check (char_length(btrim(message)) between 1 and 4000),
  email       text check (email is null or (char_length(email) <= 320 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  user_id     uuid references auth.users (id) on delete cascade,
  source      text not null check (source in ('web', 'app')),
  page        text check (char_length(page) <= 500),
  app_version text check (char_length(app_version) <= 50),
  platform    text check (char_length(platform) <= 300),
  locale      text check (char_length(locale) <= 20),
  images      text[] not null default '{}' check (cardinality(images) <= 3),
  client_hash text check (char_length(client_hash) <= 128),
  status      text not null default 'new' check (status in ('new', 'read', 'done', 'spam'))
);

comment on table public.feedback is
  'Bug reports, feature requests and questions sent from the web and the desktop app through the feedback Edge '
  'Function. images are object names in the private feedback bucket.';

create index feedback_created_at_idx on public.feedback (created_at desc);
create index feedback_user_idx on public.feedback (user_id, created_at) where user_id is not null;
create index feedback_client_idx on public.feedback (client_hash, created_at) where client_hash is not null;

alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;

-- The screenshots: private, images only, 3 MB each (the dialog shrinks larger
-- ones before sending). A signed-in sender's are under `<user id>/`, so the
-- account deletion removes them; a visitor's under `anon/`.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback', 'feedback', false, 3145728, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.feedback', 'table', '{user_id}', 'on_request', null, null, null, null, '{}', 'cascade',
   'Bug reports, feature requests and questions the account sent: the text, the optional reply email, the page '
   'or screen, app version and platform. Deleted with the account.'),
  ('storage.feedback', 'bucket', '{name}', 'on_request', null, null, null, null, '{}', 'erase',
   'Screenshots attached to the account''s feedback, under <id>/. Deleted through the Storage API before the '
   'account; the database cascade does not remove stored files.')
on conflict (name) do nothing;

commit;

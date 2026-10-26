-- ===========================================================================
-- Rail R6.3 addendum: the consent recorded before Stripe Checkout opens
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.3 *As built*, "Consent at checkout"; R6.5's terms
-- (`docs/legal/TERMS*.md`, section 9). EU consumer law (Directive
-- 2011/83/EU art. 16(m) as amended; the Croatian Zakon o zaštiti
-- potrošača): Pro starts at once, so before it starts the consumer expressly
-- asks for that and acknowledges what it does to the right of withdrawal,
-- and the trader must be able to show it. The web's upgrade step has two
-- unticked checkboxes, both required; `billing-checkout` refuses without
-- them and records them **here, before the Checkout Session exists**, then
-- passes the record's id to Stripe (the session's and the subscription's
-- metadata, `consent_id`) and writes the session id back.
--
--   * `billing_consents`: one row per consent given - the account, both kinds,
--     the version and SHA-256 of the checkbox wording and of the terms (in the
--     language shown), the language, the period chosen, the server's time,
--     the Checkout Session id once created. **Service role only** (RLS on, no
--     client grant), so nothing new is client-callable and `entitlements`'
--     free list is unchanged. Evidence, so it cannot be rewritten: only the
--     session id may be set (once) and the owner cleared (account deletion).
--     **No IP address or user agent**: the account (a verified token) is who
--     gave it and the server's clock is when; an IP would add personal data
--     without proving more (GDPR Art. 5(1)(c)).
--   * `billing_record_consent(...)`: inserts one, returns its id.
--   * `billing_consent_set_session(consent, owner, session)`: the session id,
--     once, on the account's own record.
--   * The account's data (R6.5): exported (`billing/consents.ndjson`, the
--     sealed reader) - the account's own copy of what it agreed to; on
--     deletion the row stays without its owner (`owner_id` set null): with
--     the session id it is the trader's proof of the request, tied to the
--     Stripe records kept as tax records (GDPR Art. 17(3)(b), (e)).
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The record
-- ---------------------------------------------------------------------------

create table if not exists public.billing_consents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete set null,
  -- Both boxes, always: the function refuses without either.
  kinds text[] not null
    constraint billing_consents_kinds_ok check (kinds = array['terms', 'immediate_performance']::text[]),
  -- The terms the first box linked to: the owner's version and the document's hash in `locale`.
  terms_version text not null
    constraint billing_consents_terms_version_ok check (terms_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  terms_sha256 text not null
    constraint billing_consents_terms_sha_ok check (terms_sha256 ~ '^[0-9a-f]{64}$'),
  -- The checkboxes' wording: its version and the hash of its text in `locale`.
  text_version text not null
    constraint billing_consents_text_version_ok check (text_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  text_sha256 text not null
    constraint billing_consents_text_sha_ok check (text_sha256 ~ '^[0-9a-f]{64}$'),
  locale text not null
    constraint billing_consents_locale_ok check (locale in ('en', 'hr')),
  period text not null
    constraint billing_consents_period_ok check (period in ('month', 'year')),
  consented_at timestamptz not null default now(),
  checkout_session_id text unique
    constraint billing_consents_session_ok check (checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$')
);

-- The export's keyset (owner first) and the deletion's `set null`.
create index if not exists billing_consents_owner_idx
  on public.billing_consents (owner_id, consented_at, id) where owner_id is not null;

alter table public.billing_consents enable row level security;
revoke all on public.billing_consents from anon, authenticated;
grant select, insert, update, delete on public.billing_consents to service_role;

comment on table public.billing_consents is
  'R6.3: the consent given before Stripe Checkout opens (terms; immediate start and the withdrawal acknowledgement) - '
  'account, wording and terms versions and hashes, language, period, time, Checkout Session. Service role only; '
  'only the session id (once) and the owner (deletion) can change.';

-- Evidence: an update may only set the session id where there is none, or
-- clear the owner (the foreign key's `set null` when the account goes).
create or replace function public.billing_consents_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.kinds, new.terms_version, new.terms_sha256, new.text_version, new.text_sha256, new.locale,
      new.period, new.consented_at)
     is distinct from
     (old.id, old.kinds, old.terms_version, old.terms_sha256, old.text_version, old.text_sha256, old.locale,
      old.period, old.consented_at)
     or (new.owner_id is distinct from old.owner_id and new.owner_id is not null)
     or (new.checkout_session_id is distinct from old.checkout_session_id and old.checkout_session_id is not null)
  then
    raise exception 'A recorded consent cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists billing_consents_immutable on public.billing_consents;
create trigger billing_consents_immutable
  before update on public.billing_consents
  for each row execute function public.billing_consents_immutable();

revoke all on function public.billing_consents_immutable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Writing it (billing-checkout)
-- ---------------------------------------------------------------------------

create or replace function public.billing_record_consent(
  p_owner uuid,
  p_kinds text[],
  p_terms_version text,
  p_terms_sha256 text,
  p_text_version text,
  p_text_sha256 text,
  p_locale text,
  p_period text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_owner is null or not exists (select 1 from public.profiles p where p.id = p_owner) then
    raise exception 'No profile for that account.' using errcode = 'P0002';
  end if;
  insert into public.billing_consents
    (owner_id, kinds, terms_version, terms_sha256, text_version, text_sha256, locale, period)
  values
    (p_owner, p_kinds, p_terms_version, p_terms_sha256, p_text_version, p_text_sha256, p_locale, p_period)
  returning id into v_id;
  return v_id;
end;
$$;

-- The Checkout Session the consent was given for, once; on the account's own
-- record only. False when there is no such record or it already has one.
create or replace function public.billing_consent_set_session(p_consent uuid, p_owner uuid, p_session_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null or p_session_id !~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$' then
    raise exception 'Not a Stripe Checkout Session id.' using errcode = '22023';
  end if;
  update public.billing_consents
     set checkout_session_id = p_session_id
   where id = p_consent and owner_id = p_owner and checkout_session_id is null;
  return found;
end;
$$;

revoke all on function public.billing_record_consent(uuid, text[], text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.billing_consent_set_session(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.billing_record_consent(uuid, text[], text, text, text, text, text, text) to service_role;
grant execute on function public.billing_consent_set_session(uuid, uuid, text) to service_role;

comment on function public.billing_record_consent(uuid, text[], text, text, text, text, text, text) is
  'R6.3: records the checkout consent (both kinds) before the Checkout Session is created; returns its id. '
  'Service role only (billing-checkout).';

-- ---------------------------------------------------------------------------
-- 3. The account's data (R6.5)
-- ---------------------------------------------------------------------------

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.billing_consents', 'table', '{owner_id}', 'file', 'billing/consents.ndjson', 'sealed', 'billing_consents',
   '{consented_at,id}', '{}', 'anonymise',
   'Consents given at checkout: the terms, and the request that Pro start at once with the acknowledgement about '
   'the right of withdrawal - wording and terms versions and hashes, language, period, time, the Stripe Checkout '
   'Session. No IP address. On deletion the row stays without the account (owner_id set null): it proves the '
   'request, tied to the Stripe records kept as tax records.')
on conflict (name) do nothing;

commit;

-- Rail R1.7: desktop sign-in (docs/RAIL-PLAN.md R1.7, amendment A6).
--
-- The desktop app signs in through the web: `/auth/desktop` calls the Edge
-- Function `desktop-handoff`, which mints a one-time magic-link token for the
-- caller with the service role and returns it encrypted to the app's key
-- (supabase/functions/desktop-handoff/). Minting is the one thing here that
-- needs a budget: each call is a token that signs the account in, and an
-- admin call to GoTrue.
--
-- `claim_desktop_sign_in()` is that budget. The function calls it **as the
-- user** (with the user's JWT, before it uses the service role), so the bucket
-- is keyed by `auth.uid()` here and by nothing the caller sends. Calling it
-- directly only spends one's own budget.
--
-- 10 per hour per account: a sign-in is one call; a user who opens the page,
-- cancels and tries again a few times stays well inside it, and a stolen web
-- session cannot mint tokens in bulk.
--
-- No table: the counter is `ingest_rate_limit`, as for every per-account
-- budget since F8 (bucket `desktop_sign_in:<uid>`).

create or replace function public.claim_desktop_sign_in()
returns void
language plpgsql
-- security definer: `enforce_rate_limit` is not executable by clients and
-- writes `ingest_rate_limit`, which no client role can touch. No argument,
-- no table or column name from the caller; the bucket is built from
-- auth.uid() alone.
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'You must be signed in to sign in to the desktop app.'
      using errcode = '42501';
  end if;
  perform public.enforce_rate_limit('desktop_sign_in:' || v_uid::text, 1, 10, interval '1 hour');
end;
$$;

-- Supabase's default privileges grant EXECUTE on new functions to anon and
-- authenticated; a bare `revoke ... from public` is not enough.
revoke all on function public.claim_desktop_sign_in() from public, anon, authenticated;
grant execute on function public.claim_desktop_sign_in() to authenticated;

comment on function public.claim_desktop_sign_in() is
  'Desktop sign-in budget (R1.7): 10 handoffs per hour per account, bucket desktop_sign_in:<uid>. Called by the desktop-handoff Edge Function with the user''s JWT. Raises 42501 for anon, 53400 over budget.';

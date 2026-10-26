# Billing: setting up Stripe (owner's guide)

Rail sells one paid plan, **Pro**, billed monthly or yearly, through Stripe
Billing with **Stripe Tax** for EU VAT (`docs/RAIL-PLAN.md` R6.1 to R6.3). The
code is in place and does nothing until you configure it: with no Stripe
secrets set, every billing function answers "unavailable", the web shows
"Paid plans open soon", and nothing else changes.

This guide is everything you do in Stripe, Supabase and Vercel, in order.
Do all of it in **test mode** first, end to end, then repeat it in live mode.

Nothing here has been done for you: no Stripe account, product, key, secret
or webhook exists yet, and no function is deployed.

---

## 1. How it fits together

```
Settings -> Plan (web)
   |  GET  billing-checkout  -> prices as Stripe has them (no secret)
   |  POST billing-checkout  -> Stripe Checkout Session (Stripe Tax on) -> URL
   |  POST billing-portal    -> Stripe Customer Portal session -> URL
   v
Stripe Checkout / Customer Portal (Stripe's pages)
   |
   |  events, signed with the endpoint's secret
   v
billing-webhook (Edge Function, no JWT, signature checked)
   |  reads the subscription back from Stripe, maps it to the plan
   v
billing_apply_subscription(...)  (service role; idempotent, out-of-order safe)
   -> billing_set_plan(...) (R6.2) -> profiles.plan / plan_status / ...
   -> my_entitlements() shows it; the database enforces it once
      billing_settings.enforcement_enabled is true
```

- **No secret is in the web app.** The web calls the functions with the
  user's own sign-in; the functions hold the Stripe key.
- **Prices are configuration**, not code: the price ids are secrets you set;
  the amounts, currency and VAT behaviour are read from Stripe. Changing a
  price later = create a new price in Stripe and set its id; nothing is
  redeployed. Existing subscribers stay on their old price until you migrate
  them in Stripe.
- **The plan is changed only by Stripe's webhook.** Arriving on the success
  page grants nothing.

| Function | Who calls it | Auth |
| --- | --- | --- |
| `billing-checkout` | the web (Settings -> Plan) | the user's token, checked with GoTrue |
| `billing-portal` | the web (Settings -> Plan) | the user's token, checked with GoTrue |
| `billing-webhook` | Stripe | `Stripe-Signature` (HMAC-SHA256, 5-minute tolerance) |
| `billing-cancel` | server only (R6.5's account deletion) | the service role key |

---

## 2. Products and prices

In the Stripe Dashboard (test mode):

1. **Product catalogue -> Add product**: name `Rail Pro`, description of what
   Pro includes. Tax code: the SaaS code for consumers (Stripe lists
   "Software as a service (SaaS) - personal use"; check the exact code in the
   Dashboard picker).
2. Add **two recurring prices** to it:
   - monthly: amount, currency EUR, billing period **Monthly**;
   - yearly: amount, currency EUR, billing period **Yearly**.
   For both, set **Include tax in price: Yes** (`tax_behavior = inclusive`):
   EU consumers expect prices with VAT included, and the web then says
   "Prices include VAT". (Exclusive prices also work; the web then says VAT is
   added at checkout.)
3. Copy each price's id (`price_...`). They become
   `STRIPE_PRICE_PRO_MONTH` and `STRIPE_PRICE_PRO_YEAR`.

Leave one of the two unset if you sell only one period; the web then shows only
the other.

---

## 3. Stripe Tax (EU VAT)

1. **Settings -> Tax**: set the business's head office address (Croatia) and
   the default product tax code (step 2), and turn Stripe Tax on.
2. **Registrations**: add where you are registered to collect tax:
   - **Croatia** (your domestic VAT registration);
   - **EU One-Stop Shop (OSS), Union scheme**, for consumers in other EU
     countries. You register for OSS with the Croatian Tax Administration
     (Porezna uprava) first, then add it in Stripe.
   Stripe only calculates tax where a registration exists. Below the EU
   distance-selling threshold (EUR 10,000 a year across the EU) Croatian VAT
   may apply to all EU consumers - **ask your accountant** which applies to
   you, and whether you are in the VAT system at all (a business outside it
   does not charge VAT: with no registration Stripe Tax collects nothing, but
   still charges its per-transaction fee - then say so, and the checkout's
   `automatic_tax` can be made a setting).
3. What the checkout does (already coded): `automatic_tax` on; the billing
   address is required (the evidence of the customer's country); businesses
   can enter a **VAT number** (`tax_id_collection`), and Stripe applies the
   reverse charge for a valid EU B2B number; the address and tax id are saved
   on the customer.
4. File the OSS return quarterly from Stripe's tax reports (Tax -> Reports).

---

## 4. The early users' discount

Every account created before the launch is an early user
(`profiles.early_user`, R6.2) and keeps a lifetime discount while subscribed.

1. **Product catalogue -> Coupons -> New**: percent off (the same percent as
   `billing_settings.early_user_discount_percent`, default **30**), duration
   **Forever**, applies to `Rail Pro`. Give it a readable id, e.g. `EARLY30`.
2. Its id becomes `STRIPE_EARLY_USER_COUPON`. A promotion code id
   (`promo_...`) also works.
3. The checkout applies it **automatically** to early users only (the
   database decides who is one; nothing the browser sends). "Forever" means
   for as long as that subscription lasts; an early user who subscribes again
   later gets it again.
4. Keep the two numbers equal: the Plan panel's early-user note reads the
   database setting, the price shown in the chooser reads the coupon.

---

## 5. The Customer Portal

**Settings -> Billing -> Customer portal**:

- allow: update payment methods, view invoice history, update billing
  address and tax ids, **cancel subscriptions** (at the end of the period
  recommended), **switch plans** between the monthly and yearly price of
  `Rail Pro` (add both to the portal's product list);
- business information: name, privacy policy and terms links (R6.5's pages);
- the default return link can stay empty: the function sends
  `BILLING_PORTAL_RETURN_URL`.

Optional: if you create a second portal configuration, set its id
(`bpc_...`) as `STRIPE_PORTAL_CONFIGURATION`.

**Settings -> Billing -> Subscriptions and emails**: turn on Smart Retries;
"If all retries for a payment fail": **cancel the subscription** (or mark it
unpaid - both end Pro); send emails about failed payments and expiring cards.
Rail keeps Pro for `billing_settings.payment_grace_days` (7) after a renewal
falls due and is not paid, then shows Free with "Payment overdue".

**Settings -> Payments -> Checkout and Payment Links / Emails**: send email
receipts for successful payments.

---

## 6. The webhook endpoint

**Developers -> Webhooks -> Add endpoint**:

- URL: `https://riybwcfnclphacnfawiq.supabase.co/functions/v1/billing-webhook`
- **API version**: `2025-03-31.basil` or newer (the function reads both the
  older and newer shapes, and reads the subscription back with its pinned
  version anyway);
- events, exactly these six:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`
- copy the **signing secret** (`whsec_...`): `STRIPE_WEBHOOK_SECRET`.

Other event types are acknowledged and ignored. An event for a customer Rail
does not know (made in the Dashboard, `stripe trigger`, a deleted account) is
logged and answered 200. A test-mode event reaching a live key (or the
reverse) is ignored.

---

## 7. Secrets and settings

### Supabase (the functions)

Set these on the project (they are read at request time; no redeploy needed
after a change):

```sh
supabase secrets set --project-ref riybwcfnclphacnfawiq \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_PRO_MONTH=price_... \
  STRIPE_PRICE_PRO_YEAR=price_... \
  STRIPE_EARLY_USER_COUPON=EARLY30 \
  BILLING_SUCCESS_URL=https://<site>/billing/success \
  BILLING_CANCEL_URL=https://<site>/billing/cancel \
  BILLING_PORTAL_RETURN_URL=https://<site>/settings#plan
```

| Secret | Required | What |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | `sk_test_...` / `sk_live_...`. Better: a **restricted key** (`rk_...`) with write on Customers, Checkout Sessions, Customer portal, Subscriptions and read on Prices, Coupons, Promotion codes. |
| `STRIPE_WEBHOOK_SECRET` | yes | The endpoint's `whsec_...` (step 6). |
| `STRIPE_PRICE_PRO_MONTH` | one of the two | `price_...`, monthly. |
| `STRIPE_PRICE_PRO_YEAR` | one of the two | `price_...`, yearly. |
| `STRIPE_EARLY_USER_COUPON` | no | Coupon id or `promo_...`; unset = no discount. |
| `BILLING_SUCCESS_URL` | yes | `https://<site>/billing/success`. |
| `BILLING_CANCEL_URL` | yes | `https://<site>/billing/cancel`. |
| `BILLING_PORTAL_RETURN_URL` | for the portal | `https://<site>/settings#plan`. |
| `STRIPE_PORTAL_CONFIGURATION` | no | `bpc_...`; unset = the default portal. |
| `STRIPE_API_VERSION` | no | Overrides the pinned `2025-03-31.basil`. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are set by
Supabase inside every function; do not set them.

Checkout opens when the key, at least one price and both return URLs are set;
the portal when the key and its return URL are set. Return URLs must be
`https` (or `http://localhost` / `127.0.0.1` for local testing).

### Vercel (the web)

**Nothing.** The web needs no Stripe value and no new variable: it calls the
functions through the Supabase URL and anon key it already has. Never put a
Stripe secret key or the service role key in Vercel.

---

## 8. Deploying the functions

Once the database migrations `20270908090000_entitlements.sql` and
`20270915090000_billing_stripe.sql` are applied to production (prod checklist):

```sh
supabase functions deploy billing-checkout --project-ref riybwcfnclphacnfawiq --no-verify-jwt
supabase functions deploy billing-portal   --project-ref riybwcfnclphacnfawiq --no-verify-jwt
supabase functions deploy billing-webhook  --project-ref riybwcfnclphacnfawiq --no-verify-jwt
supabase functions deploy billing-cancel   --project-ref riybwcfnclphacnfawiq --no-verify-jwt
```

`--no-verify-jwt` is required (`supabase/config.toml` explains each): the
webhook gets no JWT from Stripe, `billing-cancel` takes the service role key,
and the two the web calls check the user's token themselves with GoTrue.

---

## 9. Testing in test mode

### With the web (the real path)

1. Settings -> Plan: choose monthly or yearly, **Upgrade to Pro**.
2. Pay with Stripe's test card `4242 4242 4242 4242` (any future date, any
   CVC), a Croatian or other EU address; try a VAT number like
   `HR12345678901` for the business path.
3. Back on `/billing/success`, the page waits for the webhook and says Pro is
   on. Settings -> Plan shows "Active", the period and the renewal date, and
   **Manage subscription** opens the portal.
4. Failures: `4000 0000 0000 0341` attaches but fails at the next charge;
   with a **test clock** (Billing -> Test clocks) you can move a customer's time
   to the renewal and watch `past_due`, the grace period and the end.
5. Cancel in the portal: Plan says "canceled, Pro stays on until ...".

### With the Stripe CLI

```sh
stripe login                              # your account, test mode
stripe listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed \
  --forward-to https://riybwcfnclphacnfawiq.supabase.co/functions/v1/billing-webhook
```

`stripe listen` prints its own `whsec_...`; while forwarding, that is the
secret the function must have (set it as `STRIPE_WEBHOOK_SECRET`, and put the
endpoint's back afterwards). Then:

```sh
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.payment_failed
```

`stripe trigger` creates its own new customers, which Rail does not know, so
these are answered 200 and logged `unknown_customer` - they prove the
endpoint, the signature and the secret. The plan itself is tested by a real
test-mode checkout (above). To resend a real event: `stripe events resend
evt_...` (it is logged `duplicate` the second time).

### Locally (no deployment)

```sh
supabase start
supabase functions serve --env-file ./supabase/.env.billing   # gitignored; the test secrets above
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/billing-webhook
```

The web's dev server against the local stack then shows the real chooser.
`BILLING_*_URL` may be `http://localhost:3000/...`.

### What happened to an event

```sql
select id, type, event_created, outcome, received_at
  from public.billing_events order by received_at desc limit 20;
```

Outcomes: `applied`, `duplicate` (never stored: the id is already there),
`stale` (older than the account's newest), `unknown_customer`, `not_current`
(a dead subscription that is not the account's live one), `ignored`. Function
logs (Dashboard -> Edge Functions -> Logs) show the event id, type and outcome
- never a payload, email, address or key.

`billing_events_prune()` (service role / SQL) deletes rows older than 90 days.

---

## 10. Launch order

1. Test mode end to end (section 9) against production's functions, with test
   keys.
2. In **live mode**, repeat sections 2-6: product and prices, Stripe Tax
   registrations, coupon, portal, webhook endpoint (each has its own ids and
   secret in live mode).
3. Replace the secrets with the live ones (`sk_live_...`/`rk_live_...`, the
   live `whsec_...`, live price and coupon ids).
4. Deploy the functions if not already (section 8) - the commands are also
   in the launch checklist in `docs/RAIL-PLAN.md` R6.3.
5. Then R6.2's launch checklist: the early-user cutoff
   (`billing_settings.early_user_cutoff` + `billing_mark_early_users()`),
   `plan_limits`, Pro by hand where wanted, and last **enforcement on**
   (`update public.billing_settings set enforcement_enabled = true;`).
   Before that last step, run R6.4's launch check (`docs/RAIL-PLAN.md`
   R6.4 *As built*, "Launch checklist addition"): the desktop app signed
   out, on Free and on Pro (online and offline) against a test project with
   enforcement on, and the web's converter at the Free cap - see section 12.

Buying Pro while enforcement is still off is allowed and recorded (the
subscription is real; everything is open to everyone anyway).

---

## 11. Cancelling for an account (account deletion, R6.5)

Before an account is deleted, its subscription must stop, or Stripe keeps
charging a card for an account that no longer exists:

- from another Edge Function in `supabase/functions/`: import
  `cancelOwnerSubscriptions(env, ownerId)` from `_shared/billing/cancel.ts`
  (environment from `billingEnvFromDeno()`);
- from anywhere server-side: `POST /functions/v1/billing-cancel` with
  `Authorization: Bearer <service role key>` and `{ "owner": "<uuid>" }`.

Every live subscription of the account's customer is cancelled **now** (no
proration, no refund - refund in the Dashboard if you choose). Answers: `200
{ canceled, hadCustomer }` (an account that never paid: `{ canceled: 0,
hadCustomer: false }`, even with Stripe unset); `503` if the account has a
customer but Stripe cannot be reached or is not configured - **do not delete
the account then**. The Stripe customer and its invoices are kept (tax
records); deleting the customer is your decision. After deletion, the log rows
lose their owner (`owner_id` set null); later events for that customer are
`unknown_customer`.

---

## 12. What the plan changes in the app and on the web (R6.4)

Nothing until enforcement is on. After that (`docs/RAIL-PLAN.md` R6.4
*As built*):

- **The desktop app** reads `my_entitlements()` when signed in (at start, on
  sign-in, every 4 hours, on sync) and keeps the answer for
  `billing_settings.offline_grace_days` (14) offline; signed out, it asks the
  public `billing_enforced()` (the switch only). Without an account, or on
  Free, the HUD does not start (a running one is never stopped mid-session),
  the analysis and the full reports are locked, and sync waits ("Upgrade to
  Pro" opens `<web>/settings#plan`). Import, the local library (never
  capped), the replayer and basic statistics stay. Changing
  `offline_grace_days` reaches each app at its next check.
- **The web** shows one upgrade prompt for any refused Pro call (HTTP 402)
  and, in the converter, notices near and at the Free cap; a bulk upload
  past the cap saves every hand that fits and then pauses until the account
  upgrades.
- After a purchase, the app's Pro arrives with its next check (or "Check
  again" in Settings -> Account -> Plan).

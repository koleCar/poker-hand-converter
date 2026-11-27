# Field pool and analytics worked out once

Plan, 2026-11-27. The owner's choices are in [§2](#2-decisions).

## 1. Why

The web works a hand out only after a screen asks for it. Each tab catches up
while it is open:

- **Pool** counts opponents in the browser while the tab is open ("Counting
  your opponents: 82,054 hands to go", `backfillPool`).
  - Deleting one hand empties the owner's whole pool
    (`pool_counted_hands_reset`), so it starts again.
  - Every read works out again who is a reg and who is a fish, from all of
    `player_stats`.
  - Every read counts the pending hands by an anti-join over `hands`.
- **"You with a fish in the pot" / "You, regs only"** run `report_open` again
  with the vs-type filter. On a big account that hits the statement timeout.
- **Statistics, facts, EV and checker rows** come from `/api/stats/rebuild`,
  `factsCatchUp` and `backfillAnalyticsRows`. Each is started by the page and
  walks "what is still missing" (`hands_needing_*`). The walk itself times
  out ("Statistics could not be brought up to date").

The desktop app already works hands out in its background steps; this plan is
about the web and the shared server side.

**Goal:**
- A hand is read **once**, when it arrives (or when a version changes).
- Every product (statistics, facts, EV, checker rows, the pool) comes from
  that one read.
- Pages only read finished sums, never count. While work is pending they show
  one line, "N hands still being processed", read from a counter rather than
  computed.

## 2. Decisions

| | Choice |
|---|---|
| Whose hands make the pool | **Every Rail user's hands, anonymised**: a population pool per field. The player's own pool stays beside it. |
| What a field is | **Room · format (cash / MTT / SNG) · game and limit · table size · currency · stake.** Example: GG · cash · NLHE · 6-max · USD · 0.25/0.50. A coarser view (room + stake, room) is a sum of fields. |
| When a hand is worked out | **On arrival, on the server.** A queue fills on insert. The upload drains its own hands at once, and a scheduled worker drains everything else (desktop sync, old hands, version changes). |

**Still open (the owner's call before step P4):**
1. **Consent for the shared pool:** on by default with a switch to turn it
   off (opt-out), or off until the user turns it on (opt-in). Either way the
   privacy policy (`docs/legal`) needs a paragraph before P4 ships.
2. **The worker's credential:** a scheduled route can work for every user
   only through a privileged key. The plan gives the worker no table access:
   it may call only three definer functions (`derive_claim`, `derive_save`,
   `derive_fail`) through a dedicated role. The service role is never used.
3. **Thresholds for showing a field:** default at least 5 contributing
   accounts, 50 distinct players and 2,000 hands. Below that the field shows
   "Not enough hands yet".
4. **Free / Pro:** the player's own pool is Pro (as now). The shared field
   pool could be Pro too, or a Free teaser showing only the reg : fish ratio.

## 3. Shape

```
hands insert / version bump
        │  trigger
        ▼
derive_queue (hand_id, owner_id, reason, tries, claimed_at)
        │  ├─ the uploader's request drains its own rows right away (as the user)
        │  └─ cron worker drains the rest (derive role, definer functions only)
        ▼
one parse ─► hand_stats · hand_facts · hand_ev · checker rows · hero_report_rows
          └► pool_hand_seats (per hand: field, each named seat's rates + result)
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
owner rollups per field    field_hands (one row per hand_key, deduplicated
(pool_players +            across accounts; players as salted hashes)
 pool_player_stats,                 │  nightly pg_cron
 field column; a delete             ▼
 subtracts, never wipes)    field_pool (field × type × stat sums)
        │                   field_player_types
        ▼                           │
player_types (owner)                ▼
        │                   Pool tab: "Rail field" columns
        ▼
Pool tab: "Your pool" columns; "with a fish / regs only" read from
hero_report_rows.opp_mix
```

## 4. Data

- **`hands.field_key`:** text, derived by `hands_normalize` from the columns
  the report segment already uses (room, format, variant, limit, size class,
  currency, blinds). The same key everywhere: rollups, the picker,
  `field_hands`.
- **`derive_queue`:** one row per hand per reason (`new`, `stats/N`,
  `facts/N`, `analytics/N`). A version bump enqueues by a single `insert …
  select`, in batches, out of hours. `derive_pending(owner)` reads a counter
  table kept by the queue's trigger, never `count(*)` over `hands`.
- **`pool_hand_seats`:** `(hand_id, owner_id, field_key, seats jsonb)`.
  `seats` holds each named opponent's `[made, opp]` per catalogue rate and
  its net bb. With it, a deleted hand subtracts its own seats from the
  owner's rollups instead of emptying them.
- **Owner rollups:** `pool_players` / `pool_player_stats` get `field_key`
  instead of `game_format` in the key. The reads sum fields. No more
  `pool_counted_hands`: the queue is the pending list.
- **`player_types` (owner):** `(owner_id, site_id, player, kind, n)`.
  Refreshed by the worker for the players a drained page touched (VPIP / PFR
  from `player_stats`, the rule `analytics_pool` uses today). The Pool read
  becomes a join with a small table.
- **`hero_report_rows.opp_mix`:** `fish` (a fish saw the flop or put money
  in), `regs` (only typed regs), `mixed` / `unknown`. Set from
  `player_types` when the row is written, and re-tagged nightly for the
  owner's players whose type changed. "You with a fish" and "You, regs only"
  become one more column on the existing rollups, not a second `report_open`.
- **Shared pool:**
  - `field_hands (hand_key primary key, field_key, seats jsonb, first_seen)`:
    each player is `hmac(site || name, pool_salt)`. The salt lives in Vault
    and is never readable by clients. The first contributor's copy is kept and
    later uploads of the same `hand_key` add nothing.
  - `field_contributors (hand_key, owner_id)`: who gave it. When a user
    deletes the hand or their account, or turns consent off, their link
    goes. A hand with no links left goes in the nightly job.
  - `field_pool (field_key, kind, stat, made, opp)` plus
    `field_pool_results (field_key, kind, players, hands, net_bb, net_bb_sq)`
    and `field_player_types`: rebuilt nightly by `field_pool_refresh()`
    (pg_cron, 03:xx UTC) from `field_hands`. A full GROUP BY: at a million
    hands that is minutes, out of hours, and needs no undo logic.
  - Clients read only `field_pool_read(field_keys[])`. It refuses fields
    under the thresholds and never returns a player or a hash.
- **RLS:** every new table is owner-select only, or no client grant at all
  for `field_*`. Entitlement gates and `account_data_inventory` rows follow
  the pattern of `20271122100000`. `field_hands` is listed as `derived,
  anonymised, not exported`.

## 5. Steps

Each step ends with its tests and a `Status:` block, as in
`docs/ANALYTICS.md`. Steps are sequential.

### P1 — The queue and one pass

- Migration: `derive_queue`, its counter, the insert trigger,
  `derive_claim(limit)` / `derive_save(...)` / `derive_fail(...)`.
- `web/src/lib/derive/onePass.ts`: one parse gives every product
  (`handDerivation`, EV, `backfillAnalyticsRows`' rows, `poolHand`).
- `/api/derive` (as the user: their own queue, a time-boxed slice). Called by
  the upload right after `ingest_hands` / the web upload returns.
- `/api/derive/cron` (Vercel cron every minute, `CRON_SECRET`, derive role):
  drains every owner's queue oldest first, capped per run.
- **Retire the page-driven catch-ups:** `StatsTab`'s automatic rebuild,
  `factsCatchUp`, `useChecker`'s `filling`, `backfillPool`. They become one
  "N hands still being processed" line from `derive_pending`.
- **Done when:** a fresh upload of 5,000 hands shows full Analytics without
  opening a tab first, and no page calls a `hands_needing_*` reader.

### P2 — Fields

- `hands.field_key` + backfill (batched, out of hours). Pool rollups keyed by
  field. `pool_hand_seats` written by the one pass. A delete subtracts.
- `analytics_pool` reads fields. The filter's rooms, formats and stakes all
  apply now, not only the kind and the rooms.
- **Done when:** deleting one hand changes the pool by that hand only, and a
  GG NL50 6-max filter shows that field's regs and fish.

### P3 — Types and the "vs fish" figures precomputed

- `player_types`, `opp_mix` on `hero_report_rows` and its rollups, the
  nightly re-tag.
- The Pool's "You with a fish" / "You, regs only" read the rollups.
  `report_open` is no longer called by the Pool tab.
- **Done when:** the Pool tab on the biggest prod account opens in under a
  second with nothing pending. The perf gate in `tests/` covers it.

### P4 — The shared field pool (after the consent decision)

- Consent setting (`profiles.share_field_pool`, the Settings switch, HR +
  EN), privacy policy paragraph.
- `field_hands`, `field_contributors`, the salt in Vault, the one pass also
  writing `field_hands` when consent is on, `field_pool_refresh()` on
  pg_cron, `field_pool_read`.
- **Done when:** two test accounts that uploaded the same hand count it
  once. A field under the thresholds says so. Turning consent off removes
  the account's hands at the next refresh. pgTAP covers that no client role
  can read `field_hands` or a player hash.

### P5 — The Pool tab

- Canvas first: an Ideas page with the field picker and the columns You ·
  Your pool (regs / fish) · Rail field (regs / fish). The exploit sentence
  compares the target with the field when the player's own pool is too
  small. Code only after the owner picks a design.
- Same component on web and desktop (`packages/ui/analytics/Pool.tsx`).

### P6 — Desktop

- `rail_store::pool` gets the field split (its background step already
  counts once).
- Signed-in Pro reads `field_pool_read` for the Rail field columns. Hands
  synced from the desktop enter the queue like any other insert, so they are
  contributed under the same consent.

### P7 — Rollout

- Prod migrations before the main promotion (`CLAUDE.md`).
- Version-bump enqueue and `field_key` backfill in batches, out of hours.
- The first `field_pool_refresh()` by hand, then pg_cron.
- `docs/DATABASE.md`, `docs/GUIDE.md` (Pool), `docs/ANALYTICS.md` Step 10
  points here.

## 6. Not in this plan

- Composition stats from shown hands (Step 10 left them out).
- Per-player reads of the shared pool. They are never offered: the shared
  pool answers only "how does this field play", never "how does this
  player play".

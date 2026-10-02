# STATS — the derivation engine, version `stats/1`

A poker statistic is not arithmetic. `sum(vpip) / sum(vpip_opp)` is arithmetic;
deciding what a VPIP *opportunity* is turns out to be forty separate judgement
calls, and PokerTracker 4 and Holdem Manager 3 — the two trackers a player will
compare these numbers against — disagree on a dozen of them.

This document states every one of those calls, and every place the two trackers
diverge, so that "our 3-bet is 7.5% and PT4 says 8.1%" is a question with an
answer rather than a bug report nobody can close.

```
PhfHand ──handFacts()──▶ HandFacts ──statsRows()──▶ StatsRow[]  (one per seat)
                                                         │
                                                   aggregate() + rates()
```

Implementation:

| File | Contents |
| --- | --- |
| `frontend/src/lib/stats/types.ts` | the counter set, `STATS_VERSION`, the structural rulebook |
| `frontend/src/lib/stats/context.ts` | the shared read of a hand: decisions, aggressors, flags |
| `frontend/src/lib/stats/derive.ts` | `handFacts(hand)` — the entry point |
| `frontend/src/lib/stats/preflop.ts` | every preflop counter |
| `frontend/src/lib/stats/postflop.ts` | streets seen, the cbet chain, donks, check-raises |
| `frontend/src/lib/stats/showdown.ts` | WWSF, WTSD, W$SD |
| `frontend/src/lib/stats/money.ts` | `won` / `contributed` / `net` / `rake_paid` |
| `frontend/src/lib/stats/mapping.ts` | the flat row and the checked-in column list |
| `frontend/src/lib/stats/rates.ts` | summing rows, and rates at read time |
| `tests/test/statsDerive.test.ts` | the corpus-wide property suite |
| `tests/test/statsSpots.test.ts` | one pinned hand per hard case |
| `tests/test/support/statsInvariants.ts` | the invariants, as pure functions |
| `tests/test/fixtures/stats/` | seventeen hand-written spot hands, in standard text |

> ### Read this before you add a counter
>
> **An opportunity is a decision point that actually existed.** Never "the
> street was reached", never "the player was still in the hand". A player who is
> all-in before the flop sees the flop, the turn and the river and has no
> decision on any of them — so `flop_seen` is 1 and `cbet_flop_opp` is 0.
>
> Getting this backwards is the single commonest way a stats engine goes quietly
> wrong: both readings produce plausible numbers, nothing fails, and a short
> stack's cbet% simply reads low forever.

---

## 1. Why the semantics are in TypeScript and the arithmetic is in SQL

A pure TS function turns one `PhfHand` into N flat rows of integer counters; SQL
never does more than `sum()` and `group by`. Three independent reasons, any one
decisive:

1. **The corpus harness.** `tests/` runs 3000+ assertions over 524 real hand
   history files from nineteen rooms. A `plpgsql` 3-bet definition cannot be
   tested that way, and the stat definitions are precisely the code that most
   needs it — every one of them is a place two trackers disagree.
2. **Cost.** `hands.phf` is a TOASTed `jsonb` document of 5–50 KB. VPIP over
   500k hands means detoasting every one: tens of gigabytes of I/O per report on
   a shared-CPU instance.
3. **Expressibility.** The continuation-bet chain is a stateful walk over an
   ordered stream. In SQL that is three nested window functions per street; in
   TypeScript it is a for-loop with two variables. The SQL version will be wrong
   and you will not find out.

Consequence: **no rate is ever stored.** A stored percentage cannot be combined
with another sample, which is the one thing a stats table has to be able to do.
Rows carry `made` and `opp`; `rates.ts` divides at read time.

---

## 2. The import rule

**`frontend/src/lib/stats/**` may import only `lib/phf/types`,
`lib/phf/validate` and `lib/cards`.** No Supabase, no React, no `window`, no
`process`.

That is what lets `tests/test/` import the module directly and run it over the
whole corpus, and what will let a server-side backfill run the identical
function over stored hands. `lib/replay.ts` obeys the same rule and is the
precedent. `tests/test/statsDerive.test.ts` asserts it by reading the source
files, because the first `import { supabase }` would work perfectly in the
browser and only fail months later in a route handler.

---

## 3. What counts as a decision

Five action types represent a player choosing something:

`fold` · `check` · `call` · `bet` · `raise`

Everything else is filtered out before a counter sees it, and each exclusion has
its own failure mode:

| Excluded | Why |
| --- | --- |
| `isPostingAction(type)` — `ante`, `small-blind`, `big-blind`, `straddle`, `post`, `missed-blind`, `bomb-ante` | Forced money. Never voluntary, never aggression, never a decision. |
| `uncalled` | **A negative-amount bookkeeping event, not a move.** Left in the stream it appears as the last thing the bettor did on the street, which breaks every last-aggressor search and every "who acted after the bet" walk. |
| `show` · `muck` · `collect` · `cashout-choose` · `cashout-pay` | Results, not choices. |

`isDecision(action)` in `context.ts` is the single test the whole module funnels
through.

### 3.1 Raise levels

The spine of every preflop counter. `raisesBefore` counts only voluntary `raise`
actions on the street, so:

| `raisesBefore` at your decision | You are facing | Your raise would be |
| --- | --- | --- |
| 0 | the blinds (or a straddle) | an **open** (RFI or isolation) |
| 1 | an open raise | a **3-bet** |
| 2 | a 3-bet | a **4-bet** |
| 3 | a 4-bet | a **5-bet** |

### 3.2 Preflop opportunities are 0 or 1 per hand

Counted at the seat's **first** qualifying decision. Action comes back around
three or four times in a raised pot, and a counter that fired on each pass would
make one 4-bet war look like a whole session. Asserted over the corpus:
`counterStructure` fails any preflop counter above 1.

---

## 4. Where PT4 and HM3 disagree — and what we chose

These are the calls. Each one is implemented, pinned by a fixture in
`tests/test/fixtures/stats/`, and asserted in `statsSpots.test.ts`.

### 4.1 A straddle is a blind, not a raise

**PT4: blind. HM3: raise. We take PT4.**

A straddle is forced money posted before the cards. Counting it as aggression
corrupts everything downstream at once: the first voluntary raise becomes a
3-bet, the real 3-bet becomes a 4-bet, and the error propagates into
fold-to-3-bet, squeeze, cold-call and steal defence simultaneously. It would
also credit the straddler with a `pfr` they never chose to make.

`has_straddle` is on every row so straddled hands can be excluded wholesale
instead, which is the honest way to handle a structure whose positions do not
mean what they normally mean.

Fixture: `02-straddle-open-is-not-a-three-bet.txt`.

### 4.2 A walk gives the big blind `vpip_opp = 0`

**PT4: no opportunity. HM3: a hand the player did not put money in. We take
PT4.**

Everyone folds, the big blind never acts, and there was no decision. HM3's rule
drags big-blind VPIP down by roughly the walk rate, which makes a nit and a
tight player in a loose game look alike.

The hand still counts for money: `hands` is 1, the blind is real, and bb/100 is
computed over the full hand count.

The guard is explicit in `preflop.ts` rather than left to fall out of "the seat
made no decision", so that a room which prints a redundant `checks` for a walked
big blind does not quietly switch us to HM3's definition.

Fixture: `01-walk.txt`.

### 4.3 RFI requires the pot to be folded to you

**PT4: folded-to. HM3: any first raise. We take PT4.**

A raise over limpers is an **isolation raise** — a different decision, against a
different range, for a different reason. Conflating the two makes a player's
apparent open-raise frequency higher than it is by exactly the rate at which
they punish limpers, which at a loose table is most of the number.

Both are counted: `rfi` / `rfi_opp` for the unopened pot, `iso` / `iso_opp` when
at least one player has already limped. Together they partition every first
decision at raise level 0.

Fixture: `05-isolation-raise-is-not-rfi.txt`.

### 4.4 A turn continuation bet requires the flop cbet to have been *called*

**PT4: called. HM3: any turn bet by the preflop raiser. We take PT4.**

That is the definition that answers "do I barrel". HM3's merges two opposite
lines: "I bet the flop, got called, and fired again" and "I bet the flop, got
raised, called the raise, and then led the turn". The second is not a barrel and
a player who does it often has a completely different leak.

A raise ends the chain. The river link has the same shape, one street on.

Fixtures: `09-turn-cbet-needs-a-called-flop-cbet.txt`,
`10-raised-flop-cbet-ends-the-chain.txt`, `17-triple-barrel-and-rake.txt`.

### 4.5 Steal is 0 heads-up, 0 with a straddle and 0 with a button blind

**Both trackers count heads-up steals. We do not.**

`positionRing(2)` is `["SB","BB"]` — heads-up the button *is* the small blind and
**no seat is labelled `BTN`** (PHF-SPEC §3.5). Every small-blind raise heads-up
is therefore a steal by definition, so the stat carries no information: it is
just the small blind's open-raise frequency under a different name, and quoting
it next to a 6-max steal% invites a comparison that means nothing.

A straddle kills it for a different reason. With a straddler acting after the
blinds, "folded to the cutoff" no longer means "only the blinds are left", which
is the entire premise of the stat.

A button blind kills it for a third. GG's short deck is ante-only: everybody
antes and the button alone posts a blind (PHF-SPEC §3.6). There is no small or
big blind to steal from, positions are named from the button with no `SB` or
`BB` (PHF-SPEC §3.5), and "folded to the cutoff" means one player left, who is
both the button and the blind. That is a real spot with its own price, but it
is not the one the stat measures, and pooling the two would make neither mean
anything.

`fold_to_steal_opp` is 0 under all three conditions too, for consistency. None
of this needed a `STATS_VERSION` bump: no stored row predates it, because every
short-deck hand was refused at conversion until the same change.

Fixtures: `14-heads-up-has-no-steal.txt`; the button blind in
`tests/test/shortDeck.test.ts`.

### 4.6 A blind calling a raise is not a cold call

**PT4 and HM3 agree; stated because it is easy to get wrong.**

Cold calling means putting money in with nothing already committed. A blind
calling a raise is *defending* — a different price, a different range, a
different decision. `cold_call_opp` requires the seat to have posted neither a
blind, a dead post nor a straddle.

Fixture: `08-blind-defence-is-not-a-cold-call.txt`.

### 4.7 A dead post is money in the pot and is not VPIP

**PT4 and HM3 agree.** `isPostingAction()` is the whole test. The money lands in
`contributed` and therefore in `net`; the seat gets `vpip_opp = 1` if it had a
decision and `vpip = 0`.

Fixture: `03-dead-post-is-not-vpip.txt`.

### 4.8 Reaching a showdown is derived from folds, not read off `results`

`PhfResults.wentToShowdown` and `PhfPlayerResult.wentToShowdown` are denormalized
copies that each parser fills in from its own room's summary prose. Two parsers
reading the same hand can disagree, and nothing guarantees the field survives a
round trip through standard text.

The structural fact — **two or more players never folded** — is true of the
action stream alone, is identical for every parser, survives serialization, and
is simply what a showdown *is*.

---

## 5. Derive from the action stream, not from `game`

`game.straddles` and `game.anteModel` are populated by exactly two of the
nineteen parsers (`parsers/shared/ps-gg-hand.ts` and `phf/serialize.ts`). The
other seventeen leave them at their defaults, so reading them would make every
WePlay, Winamax or iPoker hand silently report "no straddle" and "no ante" —
silently, because the resulting numbers are all perfectly plausible.

| Fact | Derived as |
| --- | --- |
| `has_straddle` | `actions.some(a => a.type === "straddle")` |
| `is_bomb_pot` | a `bomb-ante` action, or ≥2 ante posters and no blind posted at all |
| `is_big_blind_ante` | exactly one ante poster at a table with more than one seat |
| `is_run_it_twice` | `board.runouts.length > 1` |
| `has_cashout` | a `cashout-choose` or `cashout-pay` action |
| `is_walk` | a big blind was posted, every preflop decision is a fold, and none of them is the big blind's |
| `street_reached` | the widest runout, cross-checked against the streets that carry actions |

### 5.1 `assignPositions` mutates

`assignPositions(hand)` writes `player.position` onto every seat of the hand it
is given. `buildContext` calls it **only when every position is already null**,
which is the case for a hand straight out of a parser that does not resolve
positions itself.

Calling it unconditionally would overwrite a caller's deliberate labelling;
calling it twice would make the derivation non-deterministic in its side
effects. The `deterministic` invariant exists to catch exactly that, because the
guard is invisible at the call site and is the kind of thing a later change
removes by accident.

### 5.2 Never assume two hole cards

`handClass` is computed only when `holeCardCount(variant) === 2`. It returns
`null` for anything else, which is the correct answer rather than a gap: there
is no agreed one-token class notation for an Omaha hand. Short deck deals two
and uses the Hold'em notation over the nine ranks it has (81 of the 169
classes); a card the deck cannot hold gets no class. Routing through
`holeCardCount` keeps the reason visible and stays additive-tolerant if the
`Variant` union grows.

---

## 6. The counters

Naming: `<name>_opp` is the denominator, `<name>` is the numerator. Leg sets —
`fold_to_X` / `call_X` / `raise_X` — sum to their opportunity **exactly**,
because a player facing a bet has three legal replies and no fourth.

### 6.1 Preflop

| Counter | Opportunity | Action |
| --- | --- | --- |
| `vpip` | The seat had a voluntary preflop decision. 0 for a bomb pot and 0 for a walked big blind. | `call`, `bet` or `raise` preflop |
| `pfr` | Same denominator as `vpip_opp`. | any preflop `raise` |
| `rfi` | First decision, no raise and no limper before it | raised |
| `iso` | First decision, no raise, at least one limper | raised |
| `limp` | First decision, no raise, and something to call (so the seat could not simply check) | called |
| `cold_call` | First decision facing a raise, not in a blind or straddle seat | called |
| `three_bet` | First decision at raise level 1 | raised |
| `four_bet` | First decision at raise level 2 | raised |
| `five_bet` | First decision at raise level 3 | raised |
| `squeeze` | First decision at raise level 1 with ≥1 caller since the raise | raised |
| `steal` | Unopened pot, seat in CO/BTN/SB, ≥3 dealt in, no straddle, no button blind | raised |
| `fold_to_steal` | Seat is in a blind, a steal was attempted, and this is its first decision with nobody having re-raised in between | legs: fold / `call_steal` / `three_bet_vs_steal` |
| `fold_to_three_bet` | The seat's own raise was the open, and it now faces a 3-bet **with a decision to make** | legs: fold / `call_three_bet` / `raise_vs_three_bet` |
| `fold_to_four_bet` | The seat 3-bet and now faces a 4-bet | legs: fold / `call_four_bet` / `raise_vs_four_bet` |

`rfi_opp + iso_opp` partitions "first decision at raise level 0": exactly one of
the two fires. `limp_opp` is the subset of that where the seat was not able to
check.

Note that `four_bet_opp` and `fold_to_three_bet_opp` describe the same betting
level from different sides: the first is "anybody facing a 3-bet", the second is
"the original raiser facing a 3-bet". A cold 4-bet by a third player counts for
the former and not the latter, which is the distinction that makes both worth
having.

### 6.2 Postflop

`flop_seen` / `turn_seen` / `river_seen`: the street was dealt and the seat had
not folded before it. **This is not an opportunity in the sense of §Read-this** —
it counts a player who was all-in preflop, because they were genuinely still in
the hand, and it is the denominator for WWSF and WTSD.

| Counter | Opportunity | Action |
| --- | --- | --- |
| `cbet_flop` | The preflop raiser's first flop decision, with no bet in front of it | bet |
| `cbet_turn` | The flop cbet was made **and called**, and the raiser has a turn decision with no bet in front of it | bet |
| `cbet_river` | As above, one street on | bet |
| `fold_to_cbet_<street>` | An opponent's first decision after the cbet, with nobody having raised in between | legs: fold / call / raise |
| `donk_<street>` | First decision on the street, no bet yet, and the previous street's aggressor is live and has not acted yet | bet |
| `check_raise_<street>` | The seat checked and then got the action back against a bet | raised |

Raw counts `bet_/raise_/call_/check_/fold_<street>` feed the aggression factor
and are the only counters that can exceed 1.

Three deliberate consequences:

- **A limped pot has no cbet opportunity for anybody.** There is no preflop
  raiser, so there is nothing to continue. (`12-limped-pot-has-no-cbet.txt`)
- **A donk bet removes the raiser's cbet opportunity.** Somebody led into them;
  that is a fold-to-donk spot, not a continuation bet.
  (`11-donk-bet-removes-the-cbet-spot.txt`)
- **A fold that answers a *raise* of the cbet is not a fold-to-cbet.** Counting
  it would overstate how often the continuation bet itself worked.
  (`16-fold-to-cbet-legs.txt`)

A street that checks through leaves no aggressor, so there is no donk
opportunity on the next street — a bet there is just a bet.

### 6.3 Showdown

All three are quoted over `flop_seen`, so the denominators cannot disagree:

| Counter | Opportunity | Action |
| --- | --- | --- |
| `wwsf` | `flop_seen` | collected chips from some pot |
| `wtsd` | `flop_seen` | two or more players never folded, and this seat is one |
| `wsd` | `wtsd` | collected chips |

"Won" means *collected from a pot*, not "finished the hand ahead". A player who
wins the main pot and loses the side pot won at showdown; a player whose `net`
is positive only because an uncalled bet came back won nothing at all.

---

## 7. Money

Everything is in PHF minor units. The identity the engine is pinned to:

```
Σ net over all seats  ===  houseIntoPot(hand) - totalFees(hand.results.fees)
```

The players collectively win exactly what the house dropped in and lose exactly
what the house took out; everything else is a transfer between seats and
cancels. One line, asserted over every hand of 524 files, and it catches nearly
every money bug there is — a lost uncalled return, a double-counted side pot, a
collect attributed to the wrong seat, a promotional drop silently dropped.

### 7.1 Rooms disagree about what a collect line means

Two shapes exist in the corpus, differing by exactly the rake:

- **Net.** GG and PokerStars write what the winner actually received; the
  collects sum to `totalPot - fees`.
- **Gross.** WePlay and several legacy networks write the gross pot on the
  collect line and report the fees only in the summary; the collects sum to
  `totalPot`.

`potFullyAwarded` in `psggInvariants.ts` accepts both, which is right for a
parser — the text says what it says. It is **not** right for a win rate: a
winner whose `won` is gross is credited with money that went to the house, and
every WePlay graph would read high by the rake.

`money.ts` detects the shape arithmetically — the collects reconcile against one
pot or the other — and normalizes it away, so `won` always means *chips that
landed in the stack*. This was found by the money identity failing on more than
a hundred corpus files the first time it was run, and is exactly the class of
error the identity exists to catch: nothing else in the pipeline noticed,
because every one of those hands balances perfectly against itself.

`rake_paid` attributes the fees to the **winners**, split in proportion to what
each collected, by largest remainder so the shares sum to the hand's fee total
exactly. That is not a model: the fees come out of the pot as it is pushed, so
the seat that took the pot is the seat that paid them.

### 7.2 Big-blind ante — documented, not fixed

Under a big-blind ante one seat posts the ante for the whole table, so its
`contributed` carries every other player's share. That money is real and it
stays in `net`: the hand genuinely cost that seat that much.

What it means is that **a report filtered to the big blind alone is
misleading** — it reads worse than the seat actually did, because over a full
orbit the cost is shared. `is_big_blind_ante` is on every row so the sample can
be split, and that is as far as the engine goes. Netting the ante out would
break the identity in §7 and would be a modelling choice no room reports.

Fixture: `15-big-blind-ante.txt`.

### 7.3 EV cashout — excluded from money series by default

GG lets a player sell their equity mid-hand. `won - contributed` is then not
their result: they took a settlement outside the pot. The hand carries
`has_cashout`, the seat carries `cashed_out` and `cashout_risk`, and
`aggregate()` drops these hands from the money series unless asked not to.

This is an invisible error if left alone — the graph is simply wrong for every
GG player, by an amount that looks like variance.

The money identity skips hands with a `cashout-pay` for the same reason: the
collects genuinely do not reconcile against what went in.

### 7.4 Run it twice needs no special case

`won` sums the collects across every runout, so realized bb/100 is exactly
right. That is PHF design rule 3 paying off: `board.runouts` is an array and
nothing downstream needs an `if (runTwice)`.

Fixture: pinned against a real GG hand in `statsSpots.test.ts`.

### 7.5 Chips that never reach the pot

MicroGaming's `BadBeatContribution` leaves a stack and goes to the house without
passing through the pot. It is real money, but adding it to `net` would break
the identity in §7, so it lives in `out_of_pot` and the documented "off the
table" figure is `net - out_of_pot`.

It is also the one thing the standard-text round trip loses — the GG dialect has
no line shape for it — which is why `out_of_pot` is excluded from the round-trip
comparison and `outOfPotLossIsExplained` asserts the loss is only ever that.
Exactly the treatment `psggInvariants.ts` gives a fold's exposed card.

### 7.6 Normalized money

`net_bb_milli` is `net` in thousandths of a big blind, rounded **half away from
zero** so that a win and a loss of the same size round symmetrically.
`Math.round` breaks ties upward, which over hundreds of thousands of hands is a
visible drift in a figure quoted to two decimal places.

`bb/100 = sum(net_bb_milli) / 1000 / money_hands * 100`. Note `money_hands`, not
`hands`: the two differ whenever the sample contains an EV cashout.

---

## 8. Bomb pots

Everybody antes, nobody posts a blind, and the deal goes straight to the flop.
There is no preflop betting round for an opportunity to exist in, so **every
preflop counter is 0** — not "0 made out of 1 opportunity", which would drag
VPIP down by the bomb frequency, and the bomb frequency is a house setting
rather than a property of the player.

`aggregate()` excludes bomb pots from **everything** by default, including the
hand count, because leaving them in would dilute the denominator of bb/100 the
same way.

Everyone who anted has `flop_seen = 1`, which is the whole point of the game.
Nobody is the preflop aggressor, so nobody continuation-bets.

---

## 9. The invariants

The suite asserts *properties*, not numbers. There is no known-good reference to
diff against, and manufacturing one would only move the question to "is the
reference right".

| Invariant | What it catches |
| --- | --- |
| **Money conservation** (§7) | nearly every money bug |
| **Pot reconciliation** — `Σ contributed === totalPot - houseIntoPot` | a whole seat dropped from the derivation, which conservation alone would not see |
| **Fee shares sum** | a rounding leak in the largest-remainder split |
| **Structure** — `made <= opp`, leg sets sum exactly, streets are monotone, preflop counters cap at 1, everything is a non-negative integer | a decision walk that lost an action or counted a spot that did not exist |
| **Round trip** — `handFacts(parseStandardHand(toStandardText(h)))` equals `handFacts(h)` for money and every preflop counter | a counter keyed off one room's wording rather than off PHF structure |
| **Determinism** — two calls are byte-identical | accidental mutation of the input, especially via `assignPositions` |
| **Schema drift** — row keys are exactly `STATS_COLUMNS` | a counter that is derived, never stored, and read as zero forever |
| **Import purity** (§2) | the module quietly becoming un-runnable on a server |

The round trip is the one worth dwelling on. The standard text is the GG
dialect, so every non-GG hand in the corpus makes it a genuine cross-dialect
test: GG writes `posts straddle`, WePlay writes it differently, PokerStars does
not write it at all. If any counter read a room's prose rather than the action
stream, the numbers would move when the hand came back through a different
dialect.

---

## 10. Versioning

`STATS_VERSION` is stamped on every row. Bump it when a counter changes
*meaning*: rows derived under the old rule can no longer be summed with rows
derived under the new one, and the backfill keys off the tag.

Adding a counter is **additive** and does not need a bump — but it does need a
column in `mapping.ts`, and the schema-drift invariant will say so.

---

## 11. Deliberate non-decisions

Recorded so they are not relitigated:

- **No positional breakdown inside the row.** A row already carries `position`,
  so `group by position` gives every positional stat for free. Storing
  `vpip_btn`, `vpip_co`, ... would multiply the column count by nine to answer a
  question SQL answers in a clause.
- **No `fold_to_donk`, no `probe`, no `float`.** Each is a real stat and each is
  a new opportunity walk; they are additive later and none of them is needed to
  prove the semantics, which is what M0 is for.
- **`rake_paid` is attributed to the winner, not split by contribution.** PT4
  offers both readings. The winner attribution is exact — the fees physically
  come out of the pot being pushed — and the contribution split is a model that
  no room reports and that nothing can check. Choosing the checkable one is what
  makes `rakeSharesSum` an invariant rather than a tolerance.
- **Aggression is postflop only.** Preflop aggression is already fully described
  by PFR, 3-bet and 4-bet; folding aggression frequency across both halves of
  the hand produces a number that moves when a player's preflop range changes
  and means nothing about how they play a flop.
- **Straddled hands are included by default.** Their counters are honest under
  the "straddle is a blind" rule; what is muddy is a *positional* report over a
  mixed sample. `has_straddle` is on the row so that report can drop them, and
  making it the default would silently shrink every sample instead.

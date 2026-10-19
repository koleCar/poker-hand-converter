# STATS — the derivation engine, version `stats/2`

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
| `frontend/src/lib/stats/display.ts` | the display definitions of `config/stats/` evaluated (§13) |
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

### 7.7 All-in EV is the same money divided differently

`hand_stats_ev` (`lib/equity/allInEv.ts`, versioned separately as `ev/1`)
splits each pot at the moment of an all-in by equity instead of by the board
that came. It reads the awarded total the way §7.1 does and takes the fees off
every pot at the same rate, so `Σ evNet` over the seats equals `Σ net` - the
identity above holds for EV too, and `equityCorpus.test.ts` asserts it on
every corpus hand. A hand with no all-in to adjust still gets a row, with
`ev_net = net`. The Rust port (`core/rail-equity`, docs/RAIL-PLAN.md R2.2)
computes equity as exact integer shares of 1/27720 of a board, replays the
TypeScript's double arithmetic for the pot split in `JsNumber`, and is held
to the TypeScript's rows and analyses for every corpus hand
(`testdata/golden-ev/`).

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

| Version | Change |
| --- | --- |
| `stats/1` | M1 (#43). |
| `stats/2` | Adds `pot_type` (walk, bomb, limped, single-raised, 3bet, 4bet+). Additive, but stored rows had no value for it, so the bump makes the rebuild re-derive them. |

A bump changes the Rust port too (§12): `STATS_VERSION` in `rail-stats` must
equal the TypeScript's, and a test says so.

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

---

## 12. The Rust implementation

`core/rail-stats` (docs/RAIL-PLAN.md R2.1) is this engine ported to Rust for
the desktop app and the HUD: every counter, every call in §4 and every rule in
§3, §5, §7 and §8, ported as the TypeScript has it, oddities included. The
module layout mirrors the TypeScript file for file:

| TypeScript | Rust |
| --- | --- |
| `types.ts` | `rail_stats::counters` (`Counter`, `SeatCounters`, `SeatMoney`, the rulebook) |
| `context.ts` | `rail_stats::context` |
| `preflop.ts`, `postflop.ts`, `showdown.ts`, `money.ts` | the modules of the same names |
| `derive.ts` | `rail_stats::derive` (`hand_facts`, `pot_type_of`, `hand_class`) |
| `mapping.ts` | `rail_stats::mapping` (`StatsRow`, `stats_rows`, `StatsRow::to_json`) |
| `rates.ts` | `aggregate`: `rail_stats::display::aggregate` (R2.4); the rates: the display definitions of §13 (`rail_stats::display`), equal to `rates()` |

`rail_stats::rows_for(&hand)` is `statsRows(handFacts(hand))`.

**The TypeScript stays the oracle** until the web moves to the Rust core
(R4.x). A change of meaning lands in `frontend/src/lib/stats` first, with its
spot fixture and its version bump, and regenerates the stats goldens
(`npm run golden:emit` in `tests/`, `testdata/golden-stats/`); the Rust port
then sees it as a failing diff. The Rust tests are:

- the golden diff: every corpus hand's rows equal to the TypeScript's, byte for
  byte in canonical JSON (`tests/corpus.rs`);
- the invariants of §9, ported (`tests/support/invariants.rs`), over the whole
  corpus;
- the spot fixtures of `tests/test/fixtures/stats/` with the expectations of
  `statsSpots.test.ts`, and the short-deck and pot-type spots
  (`tests/spots.rs`);
- seeded mutations of golden hands through both engines (`tests/vectors.rs`,
  `tests/data/stats-vectors.mjs`);
- the column lists and `STATS_VERSION` against `types.ts` and `mapping.ts`
  (`tests/columns.rs`).

Where the port has to choose, it chooses the TypeScript's arithmetic:

- the three divisions done in doubles - `net_bb_milli`,
  `starting_stack_bb_tenths` and the largest-remainder fee split, whose
  ordering compares fractional parts as doubles - run in
  `rail_core::js::JsNumber`, IEEE-754 emulated in integers, so they round
  exactly as the browser does;
- `-0` (a loss under half a thousandth of a big blind) is 0 in Rust and is
  written as 0 by the oracle;
- `buildContext` runs `assignPositions` on the caller's hand in place when
  every position is null; the port does it on a copy and leaves the caller's
  hand alone, with the same rows;
- two players sharing a seat number give two rows for that seat, both
  describing the last such player, as the TypeScript's `Map`s do.

---

## 13. Display definitions (`config/stats/`)

The counters above are code: each one is a judgement call, ported and
golden-tested. What a screen or the HUD **shows** is data (amendment A11,
docs/RAIL-PLAN.md R2.4): `config/stats/standard.json`, checked by
`config/stats/stats.schema.json`, read by the desktop app and the HUD in Rust
(`rail_config::stats` parses and validates, `rail_stats::display` evaluates)
and by the web (`frontend/src/lib/stats/display.ts`, over `definitions.json`,
a checked copy). A new displayed statistic is a definition there, not a
division in a component (guideline §14; `tests/test/statDisplay.test.ts`
scans for the latter).

A definition:

| Field | Meaning |
| --- | --- |
| `id` | stable, `[a-z][a-z0-9_]*`; layouts and user overrides refer to it |
| `group` | `preflop`, `postflop`, `showdown`, `results` |
| `players` | `any`, or `hero` (all-in EV exists for the hero only) |
| `label`, `name`, `description` | `{ "en": ..., "hr": ... }`: the HUD's short label, the full name, one sentence |
| `formula` | the value, over the counters (below) |
| `format` | `unit` (`percent`, `bb_per_100`, `bb`, `ratio`, `count`, `money` in minor units) and `decimals` (0-6) |
| `sample` | `of` (a formula; defaults to a `pct`'s opportunities) and `min` (0 to 10^9): full opacity and level `ok` from `min` up (reliability, below) |
| `bands` | ascending `{ "below": x, "tone": t }`, the last without `below`; tones `very-low` .. `very-high` are positions on a scale, not colours |
| `hud` | default membership: `panel` (4-6), `popup`, `none` |

**The formula language.** Numbers, names, `+ - * /` (left-associative, `*`
and `/` first), unary minus, parentheses, `pct(made, opportunities)` and
`sum(a, b, ...)`. Names: every counter of §6 (`COUNTER_KEYS`), every money
column of §7 (`MONEY_KEYS`, summed over the money rows only), `money_hands`
(the hands whose money is counted - what bb/100 divides by, because EV
cashouts are out of the money, §7.3) and `ev_net_bb_milli` (the hero's
`net_bb_milli` with each evaluated all-in's luck taken out, §7.7). Nothing
else is reachable: no comparisons, no conditionals, no other functions; at
most 1 000 bytes and 32 levels of nesting.

**Arithmetic is JavaScript's**, because the web prints doubles. Every input is
a `number` (sums of counters and money are integers far below 2^53, so exact);
every operator is one IEEE-754 double operation, in the formula's order (Rust:
`rail_core::js::JsNumber`). `pct(made, opp)` is `(made * 100) / opp` and has
no value unless `opp > 0`, exactly `rates.ts`'s `pct`; `a / b` has none when
`b` is 0; a missing input (`ev_net_bb_milli` for a villain) or a non-finite
result has none either, and a screen shows a dash. The order is part of the
definition: `(23 * 100) / 80` is 28.75 and prints "28.8" at one decimal,
`(23 / 80) * 100` is 28.749999999999996 and prints "28.7".

**Text is the web's `Intl.NumberFormat`** at `decimals` minimum and maximum
fraction digits (`formatFixed` / `format_fixed`): the shortest decimal that
reads back as the double, rounded half away from zero, with a minus sign on
any negative value ("-0.0" for -0.04). Not `Number.prototype.toFixed`, which
rounds the double's exact binary value: `(-0.15).toFixed(1)` is "-0.1", every
browser's `Intl` prints "-0.2". A UI may localise the decimal mark; the digits
are these. Bands compare the unrounded value.

**Reliability** (R2.5; `rail_stats::reliability`, `lib/stats/reliability.ts`):
every value is shown with how far to trust it, in the same arithmetic as the
value (doubles, `JsNumber` in Rust - which gained a correctly rounded `sqrt`,
`Math.sqrt`'s IEEE-754 square root), so the app, the HUD and the web dim the
same values by the same amount.

- **Interval, rates only.** A `pct(made, opportunities)` gets the 95% Wilson
  score interval, in percentage points, computed in this order with
  `z = 1.959964` (the web's long-standing constant; a table's
  1.959963984540054 moves the eighth digit):
  `z2 = z * z`, `centre = made + z2 / 2`,
  `spread = z * sqrt((made * (n - made)) / n + z2 / 4)`,
  `low = made === 0 ? 0 : ((centre - spread) * 100) / (n + z2)`,
  `high = made === n ? 100 : ((centre + spread) * 100) / (n + z2)`,
  clamped to 0-100 - the textbook `(p + z²/2n ± z·√(p(1-p)/n + z²/4n²)) /
  (1 + z²/n)` multiplied through by `n`. None unless `n > 0` and
  `0 <= made <= n`. Wilson, not `p ± z·√(p(1-p)/n)`: that leaves 0-100 near
  the edges and prints "±0" for 0 of 3 (Wilson: 0-56.1%). The bounds are
  printed at the definition's decimals, like the value ("n = 80, 95% CI
  20.0-39.5%").
- **No interval for anything else.** A win rate's would need the variance of
  the per-hand result, and the counters and rollups are sums, not sums of
  squares; a "±" from an assumed standard deviation would be a guess shown
  as a measurement. A ratio (AF) is not a proportion. Their reliability is
  their sample.
- **Level**, from the sample (`sample.of`, or the rate's opportunities)
  against `sample.min`: `ok` from `min` (always when `min` is 0) - R2.4's
  `full`; `low` from a quarter of `min` (an interval at most twice the width
  at `min`, since widths shrink with `√n`); `insufficient` below that or with
  no sample.
- **Opacity**: 1 from `min`; below it `0.6 + 0.4 * sqrt(sample / min)`, 0.6
  with no sample. It rises with the precision and reaches 1 exactly where the
  level turns `ok`; 0.6 keeps large figures legible (it was the web's
  small-sample opacity). A screen may keep a stronger floor where small text
  must keep its contrast (the web's win-rate headline stays at 0.8).

Rust and TypeScript give the same bits over the corpus and synthetic totals
(`core/rail-stats/tests/data/reliability-vectors.mjs` writes them, checking
each interval against `lib/analysis/reports.ts`'s independent Wilson
implementation; `cargo test -p rail-stats --test reliability` and
`tests/test/statReliability.test.ts` replay).

The starting set (32):

| Group | Statistics (formula) |
| --- | --- |
| results | hands (`hands`), bb/100 (`net_bb_milli / 1000 / money_hands * 100`), all-in EV bb/100 (`ev_net_bb_milli / ...`, hero), result in bb (`net_bb_milli / 1000`), rake per 100 (`rake_paid / money_hands * 100`, money) |
| preflop | VPIP, PFR, RFI, limp, iso, cold call, 3-bet, fold to 3-bet, 4-bet, fold to 4-bet, squeeze, steal, fold to steal - each `pct(x, x_opp)` |
| postflop | saw flop (`pct(flop_seen, hands)`), cbet flop / turn / river, fold to flop / turn cbet, raise flop cbet (`pct(raise_cbet_flop, fold_to_cbet_flop_opp)`), donk flop, check-raise flop, AF (`sum(bets, raises) / sum(calls)`, sample: bets + raises + calls), AFq (`pct(bets + raises, bets + raises + calls + folds)`) |
| showdown | WWSF, WTSD, W$SD - `pct(x, x_opp)` |

Every one `rates.ts` also computes (29 of 32) gives the same double over the
corpus and 600 synthetic totals, and the same text as `Intl`
(`core/rail-stats/tests/data/display-vectors.mjs` checks before it writes;
`cargo test -p rail-stats --test display` and `statDisplay.test.ts` replay).
The thresholds and minimum samples are starting values for 6-max no-limit,
for the user to change (R3.9 keeps a user's changes as an override by `id`).

---

## 14. Custom statistics: decision events and the predicate language

The counters of §6 stay code: each one is a judgement call, ported and
golden-tested. A **user's own** statistic (docs/RAIL-PLAN.md R2.10,
amendment A11) needs a new opportunity without new code, so the engine also
exports every seat's **decision events** - each decision with the betting
state it was made in - and a small **predicate language** defines a counter
as a filter over them. A predicate is never a counter of §6 in disguise: the
two are compared on the whole corpus (§14.4), and they agree on every row
except the twelve the language cannot see.

| File | Contents |
| --- | --- |
| `core/rail-stats/src/events.rs` | `hand_events(&PhfHand) -> HandEvents`: the events (§14.1) |
| `core/rail-config/src/stats/predicate.rs` | the grammar and the parser, errors with byte spans (§14.2) |
| `core/rail-stats/src/custom.rs` | the fields, `CustomCounter` (evaluation), `CustomSet` (a user's definitions validated and compiled), `EVENTS_VERSION` |
| `core/rail-stats/tests/custom_acceptance.rs` | the standard set in the language against the coded counters (§14.4) |
| `core/rail-stats/tests/events.rs` | the facts the acceptance test does not reach (sizes, position) on pinned hands |
| `core/rail-store/src/custom.rs` | the definitions in the user's store, the background count, the sums |

Rust only: the desktop app is the consumer. The web shows a user's statistic
once it runs the Rust core (R4.1) or ports `events.rs` and `custom.rs`; it
does not yet.

### 14.1 Decision events

`hand_events` builds the same `StatsContext` as `hand_facts` (§3) - the same
five decision types, raise levels with the straddle as a blind (§4.1), the
same preflop aggressor, cbet chain (§4.4) and steal attempt (§4.5) - and
gives one `SeatEvents` per dealt-in seat, in `rows_for`'s order, each with
one `DecisionEvent` per decision. Nothing reads them back into a counter of
§6; `EVENTS_VERSION` (`events/1`) changes when a field changes meaning, and
the stored custom counts are then made again.

Sizes are integers in **thousandths** (of a big blind, or of a percentage
point), rounded down; a size the hand cannot give - no big blind, an empty
pot, a check - has **no value**, and a field with no value fails every test
(`not` turns that round). In the language they read as decimals: `size_pot
<= 33.3`, `stack_bb > 40`.

**The hand** (the same on every event of the hand):

| Field | Kind | Value |
| --- | --- | --- |
| `bomb_pot` | yes/no | §8 (`is_bomb_pot`) |
| `straddle` | yes/no | a straddle was posted (`has_straddle`) |
| `button_blind` | yes/no | GG short deck's button blind (§4.5) |
| `walk` | yes/no | `is_walk` (§4.2) |
| `dealt` | number | seats dealt in |
| `max_seats` | number | the table's size |
| `preflop_raises` | number | voluntary preflop raises: 0 limped, 1 single-raised, 2 a 3-bet pot, 3+ 4-bet or more (`pot_type` as a number) |

**The seat** (the same on every event of the seat):

| Field | Kind | Value |
| --- | --- | --- |
| `hero` | yes/no | the hero's seat |
| `position` | `utg` `utg1` `utg2` `mp` `lj` `hj` `co` `btn` `sb` `bb` | PHF's position, lower case without `+`; none when the hand has none |
| `posted_blind` | yes/no | posted a blind, a dead post, a missed blind or a straddle (the cold-call and fold-to-steal test, §4.6) |
| `big_blind` | yes/no | the first `big-blind` poster (a button blind too) |
| `preflop_aggressor` | yes/no | the last preflop raiser |
| `stack_bb` | number | starting stack in big blinds |
| `effective_bb` | number | the smaller of the seat's starting stack and the largest other dealt-in seat's, in big blinds |
| `saw_flop`, `saw_turn`, `saw_river` | yes/no | `flop_seen` / `turn_seen` / `river_seen` (§6.2: the street was dealt and the seat had not folded - all-in seats included) |
| `showdown` | yes/no | `wtsd`'s test: two or more seats never folded and this is one (§4.8) |
| `won` | yes/no | collected chips from a pot (§6.3) |
| `cards_known` | yes/no | (R3.9) the seat's hole cards are known: the hero's, or a villain's shown (PHF `holeCards`) |
| `pocket_pair` | yes/no | (R3.9) two known hole cards of one rank; none unless exactly two cards are known |
| `suited` | yes/no | (R3.9) two known hole cards of one suit; none unless exactly two cards are known |

**Card fields (R3.9).** `cards_known`, `pocket_pair` and `suited` read the
seat's cards, so a statistic whose predicate names one - or whose formula
reads such a statistic's counters - is **card-split**
(`CustomSet::card_split`): it counts only hands whose cards were seen, and
PokerStars forbids it on a HUD (`sites.json` `noCardSplitStats`: the HUD
editor refuses it there and the overlay drops it). `not pocket_pair` is true
where the cards are unknown (a field without a value fails its test, `not`
turns that round): write `cards_known and not pocket_pair`. Adding the
fields changed no other field's meaning, so `EVENTS_VERSION` stays
`events/1`.

**The decision:**

| Field | Kind | Value |
| --- | --- | --- |
| `street` | `preflop` `flop` `turn` `river` | |
| `action` | `fold` `check` `call` `bet` `raise` | |
| `all_in` | yes/no | the action put the seat all in |
| `facing` | `none` `limp` `bet` `raise` | preflop: `none` an unopened pot (blinds and straddles only), `limp` one or more limpers and no raise, `raise` a voluntary raise; postflop: `none` nothing bet yet, `bet` a bet, `raise` a raise. Preflop `none` + `limp` partition raise level 0 exactly as RFI and iso do (§4.3) |
| `raise_level` | number | voluntary raises before on the street (`raisesBefore`, §3.1) |
| `limpers` | number | preflop at raise level 0: the players who limped before; otherwise 0 |
| `callers` | number | calls since the last bet or raise on the street (the squeeze test) |
| `first_on_street` | yes/no | the seat's first decision on the street |
| `first_at_level` | yes/no | the seat's first decision on the street at this raise level |
| `checked_before` | yes/no | the seat checked earlier on the street |
| `own_raise` | number | the level the seat's latest raise on the street made: 1 it opened, 2 it 3-bet, ...; 0 none |
| `facing_steal` | yes/no | preflop: the hand's steal attempt (§6.1, all of §4.5's conditions) was another seat's, and it is still the only raise |
| `facing_cbet` | yes/no | the street's continuation bet (§6.2) was another seat's, made before this decision, and nobody has raised since |
| `barrels` | number | the cbets of earlier streets, each called and not raised, unbroken from the flop: 0 on the flop, 1 on the turn after a called flop cbet, 2 on the river after two (§4.4) |
| `initiative` | yes/no | the seat made the previous street's last bet or raise (on the flop: the preflop raiser); preflop false |
| `ahead_of_aggressor` | yes/no | the previous street's aggressor is another seat, still in the hand on this street, that has not acted on it yet (the donk test) |
| `in_position` | yes/no | postflop: the seat is the last to make its first decision on the street - it acts last among the seats that can act; none preflop |
| `players` | number | seats still in the hand when the street began (all-in seats included); preflop the seats dealt in |
| `multiway` | yes/no | `players` is 3 or more |
| `pot_bb` | number | the pot before the decision (every posting, call, bet and raise so far, uncalled returns taken back), big blinds |
| `size_bb` | number | a call, bet or raise: the seat's total on the street after it - a raise's "to" - in big blinds |
| `size_pot` | number | a bet: its chips as a percentage of the pot before it; a raise: the chips over the call as a percentage of the pot after the call (a pot-sized raise is 100) |
| `facing_size_pot` | number | the `size_pot` of the last bet or raise on the street before this decision; none when nothing voluntary was bet (preflop blinds are not a bet) |

The size classes a tracker names - a third of the pot, half, pot, overbet;
an open to 2.5 bb - are comparisons on these: `size_pot <= 40`,
`size_bb >= 2.5 and size_bb < 3`.

### 14.2 The predicate language

```text
counter    := mode condition ("=>" condition)?
mode       := "first" | "any" | "each"
condition  := conj ("or" conj)*
conj       := neg ("and" neg)*
neg        := "not" neg | "(" condition ")" | test
test       := field
            | field ("=" | "!=" | "<" | "<=" | ">" | ">=") value
            | field "in" "(" value ("," value)* ")"
value      := number | word        number := [0-9]+ ("." [0-9]{1,3})?
```

The condition before `=>` is the **opportunity**, the one after it the
**action** (without `=>` every opportunity is made). `and` binds tighter than
`or`, `not` tighter than both. A bare field must be yes/no; a yes/no field
compares to `true` / `false`; a choice field compares with `=`, `!=` or `in`
to its own words; a number field with every comparison to numbers of at most
three decimals (kept as thousandths: exact). Nothing else exists - no
arithmetic, no functions, no other names - and a predicate is at most 1 000
bytes and 32 levels deep, `in` at most 32 values: like a formula (§13), it
cannot reach anything but the event in front of it.

**Modes** - how a seat's events in one hand count:

| Mode | Opportunities | Made |
| --- | --- | --- |
| `first` | 1 if any event passes the opportunity | 1 if the **first** such event passes the action |
| `any` | 1 if any event passes the opportunity | 1 if **any** such event passes the action |
| `each` | every event that passes the opportunity | every one of those that passes the action |

`first` and `any` are §3.2's "0 or 1 per hand". The coded counters' two
shapes of "first" are both a `first` predicate: "the first decision at raise
level 1" is `first raise_level = 1`, and "the first decision, if it is
unopened" is `first first_on_street and facing = none` - the
`first_on_street` / `first_at_level` fields turn "first, then test" into
"first that passes".

**Errors** carry the byte offset and length of what they are about - an
unknown field (with the nearest name when one is a typo away: `stret` ->
`street`), a word that is not one of the field's, a comparison its kind does
not have, a number with four decimals, an unclosed parenthesis - and the
editor underlines exactly that span. The messages are English, as the
formula language's are.

### 14.3 A user's statistic

A user's statistic is an R2.4 definition (§13: id, labels, description,
formula, format, sample, bands) and, optionally, a predicate. With one it has
two counters of its own, named by its id: `<id>` (made) and `<id>_opp`
(opportunities); its formula defaults to `pct(<id>, <id>_opp)` and may be
any formula over those, the ninety coded counters, the money columns and
other user statistics' counters (`rail_stats::custom::CustomSet`: an id may
not be a shipped id, a counter, another statistic or another statistic's
counter; a statistic whose counters another formula reads cannot be renamed
or deleted until that one changes). Without one it is a formula over the
existing counters only. A formula that reads the hero's all-in EV is the
hero's (`players: hero`).

Definitions live in the user's store, not in `config/stats/`
(`custom_stats`, `core/rail-store/SCHEMA.md` "Custom statistics"). The
background pass counts each predicate over every stored hand from its PHF,
on the seats the store keeps (§9's rows: the hero, and villains unless the
room is positionally anonymised), and sums the counts the way the coded
rollups are summed - the hero's per hand and per (segment, position, day,
kind), every kept seat's per (site, player, scope, segment) with bomb pots
left out - so a report's filter and the HUD's lookup read them as they read
the coded counters.

### 14.4 The standard set in the language

`core/rail-stats/tests/custom_acceptance.rs` writes the standard counters as
predicates and compares them with the coded counters on **every dealt-in seat
of every corpus hand: 8 422 hands, 51 464 rows**, opportunities and made
alike. With `PF` = `street = preflop and not bomb_pot and not (walk and
big_blind)` (the guard every preflop counter has in code, §4.2, §8):

| Counter | Predicate | Opportunities | Made | Rows that differ |
| --- | --- | ---: | ---: | ---: |
| `vpip` | `any PF => action in (call, bet, raise)` | 49 390 | 15 122 | 0 |
| `pfr` | `any PF => action = raise` | 49 390 | 8 017 | 0 |
| `rfi` | `first PF and first_on_street and facing = none => action = raise` | 22 088 | 5 423 | 0 |
| `iso` | `first PF and first_on_street and facing = limp => action = raise` | 6 198 | 1 014 | 0 |
| `limp` | `first PF and first_on_street and raise_level = 0 and action != check => action = call` | 27 030 | 3 047 | 0 |
| `cold_call` | `first PF and first_on_street and raise_level >= 1 and not posted_blind => action = call` | 9 341 | 1 332 | 0 |
| `three_bet` | `first PF and raise_level = 1 => action = raise` | 20 087 | 1 504 | 0 |
| `four_bet` | `first PF and raise_level = 2 => action = raise` | 4 080 | 240 | 0 |
| `five_bet` | `first PF and raise_level = 3 => action = raise` | 406 | 42 | 0 |
| `squeeze` | `first PF and raise_level = 1 and first_at_level and callers >= 1 => action = raise` | 4 255 | 290 | 0 |
| `steal` | `first PF and first_on_street and facing = none and position in (co, btn, sb) and not straddle and not button_blind and dealt >= 3 => action = raise` | 7 838 | 2 672 | 0 |
| `fold_to_steal` (+ `call_steal`, `three_bet_vs_steal`) | `first PF and facing_steal and posted_blind and first_on_street => action = fold` (`call`; `in (raise, bet)`) | 4 331 | 2 642 / 1 237 / 452 | 0 |
| `fold_to_three_bet` (+ legs) | `first PF and raise_level = 2 and own_raise = 1 => action = fold` | 1 427 | 637 / 624 / 166 | 0 |
| `fold_to_four_bet` (+ legs) | `first PF and raise_level = 3 and own_raise = 2 => action = fold` | 221 | 76 / 109 / 36 | 0 |
| `cbet_flop` / `_turn` / `_river` | `first street = flop and first_on_street and preflop_aggressor and barrels = 0 and facing = none and not bomb_pot => action = bet` (turn: `barrels = 1`, river: `barrels = 2`) | 3 441 / 760 / 144 | 1 826 / 368 / 86 | 0 |
| `fold_to_cbet_<street>` (+ `call_cbet`, `raise_cbet`) | `first street = flop and facing_cbet => action = fold` (`call`; `in (raise, bet)`) | 2 208 / 382 / 87 | 1 115 / 158 / 34 | 0 |
| `donk_<street>` | `first street = flop and first_on_street and facing = none and ahead_of_aggressor => action = bet` | 3 083 / 990 / 464 | 323 / 92 / 58 | 0 |
| `check_raise_<street>` | `first street = flop and checked_before and facing != none => action = raise` | 3 028 / 1 339 / 660 | 206 / 87 / 35 | 0 |
| `bet_/raise_/call_/check_/fold_<street>` | `each street = flop => action = bet` ... (made only: the raw counts have no opportunity) | - | e.g. `bet_flop` 3 175 | 0 |
| `flop_seen` | `any saw_flop` (opportunities only) | 13 616 | - | **12** |
| `wtsd` | `any saw_flop => showdown` | 13 616 | 4 417 | **12** |
| `wwsf` | `any saw_flop => won` | 13 616 | 5 417 | **12** |
| `wsd` | `any saw_flop and showdown => won` | 4 417 | 2 232 | **12** |

**Every preflop and postflop counter matches exactly**, legs included: the
judgement calls of §4 - the straddle as a blind, the walked big blind, RFI
against isolation, the called-cbet chain, no steal heads-up, straddled or
with a button blind, a blind's call is not a cold call, a fold to a raised
cbet is not a fold to the cbet - are all expressible, because the events
carry the context the code decides them on.

**The one difference: a seat with no decision at all.** The showdown family
counts over `flop_seen`, which includes a player all in before the flop
(§Read-this): they see the flop without deciding anything. The language
reaches a seat only through its events, so a seat that **never made a
decision in the whole hand** has nothing for `any` to find. In the corpus
that is 12 of the 51 464 rows - players all in by posting a blind or the
antes (Ignition and Chico regression files, cash and tournament, limit and
no-limit; in one heads-up limit hand both players), a WePlay tournament
player all in by the ante (the same hand twice in the corpus) and a WePlay
bomb-pot player all in by the bomb ante - and the acceptance test checks that
every differing row is such a seat. A player who shoved preflop has the shove as an event, and is
counted exactly. Closing the gap would take a synthetic "dealt in" event per
seat; it is not built, because a custom showdown statistic over seats that
never acted is not one anybody has asked for, and the coded WTSD, WWSF and
W$SD stay what reports show.

Cost (release, M2 Pro, the corpus): building a hand's events takes
**~4.8 µs**, evaluating all 57 predicates above on every seat **~9 µs**
(~0.16 µs a counter a hand) - next to `rows_for`'s ~6.6 µs. The background
pass, which also reads the PHF back from the store, counts **~26 000 hands a
second** on one thread for one statistic, and adding statistics costs little
(~34-39 µs a hand either way).

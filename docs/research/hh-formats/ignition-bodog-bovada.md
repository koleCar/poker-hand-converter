# Ignition / Bodog / Bovada (PaiWangLuo network) hand history format

**This is the most important document in this four-site research pass.** Ignition/Bodog/Bovada
is the one site whose anonymization scheme is genuinely different from every other room a
parser is likely to already support, and a parser author who has only seen one example hand will
almost certainly build the wrong mental model. Real samples were found — see §1 — so nothing
here is speculative invention, but read all of §11 before writing any player-identity logic.

## 1. Overview & status

**Confirmed from real samples (56 files total: 4 from an independent open-source converter,
52 from a maintained poker tracker's own regression corpus — see
`fixtures/samples/ignition/SOURCES.md`; dated 2012-04 through 2022-10):**
- Six confirmed real brand strings used interchangeably as the header's site name over time:
  `Bovada`, `Bodog`, `Bodog.com`, `Bodog.eu`, `Bodog UK`, `Ignition` (roughly chronological:
  Bodog → Bovada (~2013 US rebrand) → Ignition (~2016 second US rebrand), with `.eu`/`UK`/`.com`
  as concurrent non-US-facing skins of the same underlying platform/software).
- Full cash and tournament grammar for hold'em, Omaha, Omaha Hi/Lo, and 7-card stud/stud Hi/Lo.
- **Zone Poker** (this network's fast-fold product): confirmed real from 2013 through 2021.
- The positional-pseudonym anonymization scheme itself, in full, across every era (§11) — this
  is the single fact this whole document exists to nail down, and it is fully confirmed by real
  bytes, not inferred.
- A newer (confirmed 2021+) header variant tagged `[MVS]` with an additional `Table Info:` line
  and a `Player Info:` line carrying a **stable-looking per-seat hashed pseudo-ID**, layered on
  top of (not replacing) the ordinary positional display name.
- Bounty/knockout tournaments, rebuy/add-on tournaments, disconnect/timeout sequences, all-in
  at the blind-posting stage (before hole cards are even dealt), and at least one real
  historical grammar change (`raises X to Y` formatting) that the fpdb-3 maintainers themselves
  had to add a regression test for.

**NOT confirmed / not found:**
- `Bodog Canada` and `Bodog88` are listed as alternative brand strings in the reference parser's
  own regex but no fixture bearing either string was found.
- Run-it-twice: no sample found on this network anywhere in this research pass.
- Whether the `[MVS]` per-seat hash in `Player Info:` is stable for the same real player across
  *separate* hands — every MVS-tagged fixture obtained is either a single hand or a set of hands
  that don't share overlapping seats, so this specific claim could not be tested against real
  data. Treat it as "plausible, structurally suggestive, unconfirmed" (see §11).
- Nothing newer than 2022-10 was found; cannot confirm the format is unchanged since then.

## 2. Detection signature

```
^(Ignition|Bovada|Bodog(\.com|\.eu|\sUK|\sCanada|88)?)\sHand\s\#C?\d+
```
(This is the reference parser's own `re_identify`, confirmed against real headers of five of
the six alternatives.) No other site in this four-site survey, nor PokerStars/GGPoker/iPoker/
etc., uses any of these six literal brand-plus-"Hand"-tokens. This is an unambiguous, safe
detector on its own — no secondary confirmation is needed. If a secondary confirmation is
wanted anyway: the button marker `Dealer : Set dealer` (or `Set dealer/Bring in spot` for stud)
appearing as its own action-stream line is unique to this network among all sites surveyed here
(every other site marks the button on the header/table line, not as a mid-hand action).

## 3. Full verbatim example hands

### Cash game, Zone Poker (real — `fixtures/samples/ignition/matt57225-converter-samples/1.txt`)

```
Ignition Hand #3589791199 Zone Poker ID#1232 HOLDEMZonePoker No Limit - 2018-04-07 13:54:40
Seat 1: UTG+1 ($19.58 in chips)
Seat 2: UTG+2 [ME] ($49.50 in chips)
Seat 3: Dealer ($58.62 in chips)
Seat 4: Small Blind ($9.91 in chips)
Seat 5: Big Blind ($60.27 in chips)
Seat 6: UTG ($47.42 in chips)
Dealer : Set dealer [3]
Small Blind : Small Blind $0.25
Big Blind : Big blind $0.50
*** HOLE CARDS ***
UTG+1 : Card dealt to a spot [Ks 4c]
UTG+2 [ME] : Card dealt to a spot [5c 9d]
Dealer : Card dealt to a spot [6h 9h]
Small Blind : Card dealt to a spot [9c 2h]
Big Blind : Card dealt to a spot [5h Td]
UTG : Card dealt to a spot [6s 3c]
Big Blind : Leave(Auto)
UTG+2 [ME] : Leave(Auto)
UTG+1 : Leave(Auto)
Dealer : Leave(Auto)
UTG : Folds
UTG : Leave(Auto)
UTG+1 : Folds
UTG+2 [ME] : Folds
Dealer : Folds
Small Blind : Folds
Small Blind : Leave(Auto)
Big Blind : Showdown(High Card)
Big Blind : Hand result $0.75
Enter(Auto)
Enter(Auto)
Enter(Auto)
Dealer : Enter(Auto)
Enter(Auto)
Enter(Auto)
*** SUMMARY ***
Total Pot($0.75)
Seat+1: UTG+1 lost with High Card [Ks 4c]
Seat+2: UTG+2 lost with High Card [5c 9d]
Seat+3: Dealer lost with High Card [6h 9h]
Seat+4: Small Blind Folded before the RIVER
Seat+5: Big Blind $0.75 with High Card [5h Td]
Seat+6: UTG Folded before the RIVER
```

### Tournament (real — `fixtures/samples/ignition/matt57225-converter-samples/2.txt`, trimmed)

```
Bovada Hand #3598182127: HOLDEM Tournament #19768742 TBL#1, Turbo- Level 2 (20/40) - 2017-12-03 17:43:01
Seat 1: Dealer (350 in chips)
Seat 3: Small Blind [ME] (720 in chips)
Seat 2: Big Blind (430 in chips)
Dealer : Set dealer [1]
Small Blind [ME] : Small blind 20
Big Blind : Big blind 40
*** HOLE CARDS ***
Dealer : Card dealt to a spot [2s Qc]
Small Blind [ME] : Card dealt to a spot [6d 3h]
Big Blind : Card dealt to a spot [9d 6c]
Dealer : Folds
Small Blind [ME] : Folds
Big Blind : Does not show [9d 6c] (High Card)
Big Blind : Hand Result 60
*** SUMMARY ***
Total Pot(60)
Seat+1: Dealer Folded on the FLOP
Seat+3: Small Blind Folded on the FLOP
Seat+2: Big Blind 60 [Does not show]
```

### Newest confirmed header variant, `[MVS]` (real — `fixtures/samples/ignition/fpdb3-regression-corpus/cash__NLHE-USD - $0.25-$0.50 - 202103.MVS.version.txt`, trimmed)

```
Bovada Hand #4086249181 TBL#23799796 HOLDEM No Limit [MVS] - 2021-03-11 22:58:57 UTC
Table Info: Version: 1, Type: MVS, Stakes: $0.25-$0.50, Table: 000A031E-0
Seat 1: Big Blind ($98.75 in chips)
Seat 2: UTG ($18.11 in chips)
Seat 3: UTG+1 [ME] ($75.67 in chips)
Seat 4: UTG+2 ($69.62 in chips)
Seat 6: Small Blind ($77.69 in chips)
Dealer : Set dealer [5]
Player Info: Seat1: P1-d07e9231948e51d3174b777a4673828d, Seat2: P2-44fbd5113ff5581f5a26b0ba89c64fce, Seat4: P4-4be1435659dd6477e8716fba5499e672, Seat6: P6-0bce045b1715d3fe9f17816328eec5e2
Small Blind : Small Blind $0.25
Big Blind : Big Blind $0.50
*** HOLE CARDS ***
Big Blind : Card dealt to a spot [Kc Js]
UTG+1 [ME] : Card dealt to a spot [Kd Qs]
```

## 4. Header grammar

```
<Brand> Hand #<id>[: | ][Zone Poker ID#<zoneid>|TBL#<tableid>] <GAME>[ Tournament #<tourno> TBL#<n>, <Speed>- Level <n> (<sb>/<bb>)] [No Limit|Pot Limit|Fixed Limit]?[ [MVS]] - <date>[ UTC]
```
- `<Brand>` confirmed values: `Bovada`, `Bodog`, `Bodog.com`, `Bodog.eu`, `Bodog UK`, `Ignition`.
- `<GAME>` confirmed tokens: `HOLDEM`, `OMAHA`, `OMAHA HiLo`, `7CARD`, `7CARD HiLo`, plus the
  Zone Poker variants `HOLDEMZonePoker`, `OMAHAZonePoker`, `OMAHA HiLoZonePoker` — the "ZonePoker"
  suffix is concatenated directly onto the game token with **no space**.
- Cash-game table id is `TBL#<n>` after the hand id; Zone Poker uses `Zone Poker ID#<n>` in the
  same position instead (this is the pool/lobby id the player queued into, not a fixed table).
- Tournament header inserts `Tournament #<tourno> TBL#<tableno>, <Speed>- Level <n>
  (<sb>/<bb>)` — note the **hyphen glued directly to the speed word with no space**
  (`Turbo- Level 2`), confirmed real across multiple files/years.
- Punctuation after the hand id is inconsistent even for the same brand: some real headers use
  a colon (`Ignition Hand #4300979169: HOLDEM Tournament...`), others use none (`Ignition Hand
  #3589791199 Zone Poker ID#1232...`) — don't assume the colon is always present.
- `[MVS]` (confirmed 2021+) is a bracketed tag appended near the end of the header line, and its
  presence triggers two additional header-area lines not present otherwise (see below):
  ```
  Table Info: Version: <n>, Type: MVS, Stakes: <sb>-<bb>, Table: <guid>[, Buyin: <amt>+<fee>, TableType: <MTT|...>]
  Player Info: Seat<n>: P<n>-<32-hex-char-hash>[, Seat<n>: P<n>-<hash>...]
  ```
  `Buyin:`/`TableType:` fields on the `Table Info:` line are confirmed present for tournaments
  and appear absent for cash (based on the samples obtained). See §11 for what `Player Info:`
  means for player identity.
- Date/time: `YYYY-MM-DD HH:MM:SS` with no timezone in older files; `YYYY-MM-DD HH:MM:SS UTC`
  confirmed in `[MVS]`-era (2021+) files. Treat timezone presence as era-correlated but not
  guaranteed for anything between.
- A real, maintainer-flagged historical grammar change exists around 2012-08 in how raise
  amounts are rendered on the action lines (see the `raise.to.format.change` fixture) — the
  header grammar itself does not appear to have changed as sharply as the action-line grammar
  did, but be aware format drift is real and dated, not hypothetical, on this network.

## 5. Table/seat lines, button, max seats

**Flop games (hold'em/Omaha):**
```
Seat <n>: <position-name>[ [ME]] (<cur><amt> in chips)
```
- Amount and hero tag order is fixed: the `[ME]` tag comes **after** the position name and
  **before** the parenthesized stack, e.g. `Seat 2: UTG+2 [ME] ($49.50 in chips)`.
- Seat numbers in ordinary cash/small-tournament hands are small (1-9); **large arbitrary seat
  numbers (e.g. 65, 146, 17) are confirmed real in at least one big-field `[MVS]`-era tournament
  fixture** — do not assume seat numbers are bounded by table max-seats in tournaments.
- Seat lines are not guaranteed to be in ascending numeric order — confirmed real
  ("out.of.order.seats" fixture).

**Stud games:**
```
Seat+<n>[ [ME]]: <amt> in chips
```
Note the `+` immediately after `Seat` (not a space) and the different amount-field shape (no
"Seat <n>:" colon-then-space-then-name; format is `Seat+<n>[ [ME]]:` then the amount directly,
no player-name field at all in the seat line itself — position names for stud appear only in
the later action-stream lines as `Seat+<n>` tokens, e.g. `Seat+4 [ME] : Card dealt to a spot
[...]`).

**Button marker (both game families, its own action-stream line, not part of the seat block):**
```
Dealer : Set dealer [<n>]
Dealer : Set dealer/Bring in spot [<n>]     (stud — also marks the forced bring-in obligation)
```

## 6. Blinds, antes, straddle, dead blinds, "waiting"

Confirmed verbatim (flop games):
```
Small Blind : Small Blind $<amt>              (also seen lowercase: "Small blind $<amt>")
Big Blind : Big blind $<amt>
<name> : Posts chip $<amt>                    (post-to-enter / catch-up post)
<name> : Posts dead chip $<amt>
```
Confirmed verbatim (stud):
```
Seat+<n>[ [ME]] : Ante chip <amt>
Seat+<n>[ [ME]] : Big blind/Bring in <amt>
Seat+<n>[ [ME]] : Bring_in chip <amt>
```
An all-in can occur **before hole cards are even dealt**, as part of posting a blind for a
short stack — confirmed real (`Big Blind [ME] : All-in 166` appearing before `*** HOLE CARDS
***`, immediately followed by `Dealer : Ante chip 240` and `Dealer : Return uncalled portion of
bet 74` — all still pre-deal). A parser must not assume all pre-deal lines are simple blind
posts.

## 7. Street markers (verbatim, confirmed)

```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx] [Xx] [Xx]
*** SUMMARY ***
```
No `*** SHOW DOWN ***` marker was found on this network in any real sample — showdown reveals
are ordinary action-stream lines (`<name> : Showdown [<cards>] (<hand desc>)` or `<name> : Does
not show [<cards>] (<hand desc>)`), not a separate street section. No confirmed `*** 3RD STREET
***`/etc. marker text was found in the stud samples obtained either — stud street transitions
in our fixtures happen silently via `Card dealt to a spot`/`received`-style lines with no `***`
banner (contrast WPN's stud, which does have explicit `*** Third street ***` banners — do not
port that assumption to this network).

## 8. Action verbs — exact phrasing (confirmed)

`Folds`, `Checks`, `Calls $<amt>` / `Call $<amt>` (**both singular and plural confirmed real,
inconsistent** — see gotchas), `Bets $<amt>` / `bets $<amt>`, `Raises $<amt> to $<amt>` /
`raises $<amt> to $<amt>` (**capitalization is inconsistent even within one era**), `Double
bets` (confirmed distinct token in the reference parser's action-type list — meaning unconfirmed
by us in a fixture, likely a heads-up-specific double-sized-bet convention), `All-in $<amt>` /
`All-in(raise) $<amt> to $<amt>` / `All-in(raise-timeout)` (a raise that is also an all-in
carries a parenthetical qualifier suffix on the verb itself, not a separate trailing phrase like
Ignition's own uncalled-bet convention — contrast Winamax/WPN's ` and is all-in` suffix
approach, which this network does **not** use for raises specifically, though it does use a
similar ` and is all-in` for `Return uncalled portion of bet` sequences elsewhere — see below).

Uncalled bet: `<name> : Return uncalled portion of bet <amt>` (confirmed real, note: **no
dollar sign** on the amount in several samples even though other lines on the same hand do use
`$`).

Not shown: `<name> : Does not show [<cards>] (<hand desc>)`.

Shown: `<name> : Showdown [<cards>] (<hand desc>)` (flop games) and, per the parser's regex,
`<name> : Shows [<cards>] (<hand desc>)` / `<name> : Mucks [<cards>] (<hand desc>)` as
alternative verbs — only `Showdown` and `Does not show` were directly observed in our fixture
excerpts, the `Shows`/`Mucks` forms are confirmed only via parser regex, not directly quoted
from a fixture we read in full (they are very likely real given the regex explicitly handles
them, but flagged here for honesty about direct-observation vs regex-inference).

Payout: `<name> : Hand result $<amt>` (cash) / `<name> : Hand Result <amt>` (tournament, no `$`,
capital R) — **capitalization and currency-symbol presence differ between cash and tournament**,
confirmed real in both forms.

Tournament-specific bust-out sequence, confirmed real and complete:
```
<name> : Ranking <n>
<name> : Prize Cash [$<amt>]
<name> : Stand
```
(`Stand` = the player physically leaves the tournament table after busting; `Ranking 1` = the
winner.)

Bounty/knockout, confirmed real:
```
<name> : BOUNTY PRIZE [$<amt>]
```
and, in the summary block: `... BOUNTY awarded:$<amt>` appended directly after the hand-desc
clause with **no space** before "BOUNTY".

Zone Poker table-shuffle noise (confirmed real, must be recognized and skipped, not treated as
a player action): `<name> : Leave(Auto)`, bare `Enter(Auto)` (sometimes with no name prefix at
all — confirmed real, a bare `Enter(Auto)` line with nothing before it), `<name> : Table enter
user`, `<name> : Table deposit $<amt>`.

## 9. SUMMARY / pot / rake line layout

**Flop games:**
```
*** SUMMARY ***
Total Pot($<amt>)                     (cash — dollar sign inside the parens)
Total Pot(<amt>)                      (tournament — no dollar sign)
Board [<cards>]
Seat+<n>: <position-name>[ [Does not show]| <amt> with <hand desc> [<cards>]|lost with <hand desc> [<cards>]|Folded (before|on) the <STREET>]
```
- Note the summary's seat token is `Seat+<n>:` **even for flop games** — this differs from the
  seat-listing block at the top of the hand, which uses `Seat <n>:` (space, not plus) for flop
  games. The `+` appears **only** in the summary line and in stud seat-listing lines — a subtle,
  confirmed-real, easy-to-miss inconsistency between the header block and the summary block for
  hold'em/Omaha hands specifically.
- No `Rake` figure is printed anywhere in the summary block in any sample obtained — this
  network's hand history text apparently never states rake explicitly (or it wasn't present in
  any fixture we found); a parser needing rake must compute it externally (buy-in minus prize
  pool, or pot minus payouts) rather than expect a `Rake` token.
- `Folded before the <STREET>` / `Folded on the <STREET>` — same "before vs. on" asymmetry
  pattern also seen on the Chico network (see `chico.md` §9) — confirmed independently here.

## 10. Date/time format and timezone convention

`YYYY-MM-DD HH:MM:SS` with no timezone through at least 2018; `YYYY-MM-DD HH:MM:SS UTC` in
confirmed `[MVS]`-era (2021+) samples. No other timezone token was ever observed on this
network in any era — when present, it is always literally `UTC`.

## 11. Anonymized-player conventions — the core reason this document exists

**Every seat at the table is displayed by its position relative to the button, not by the
player's real screen name, for every hand, on every table type, in every era we found real
samples for.** Confirmed real positional tokens: `Dealer` (button seat), `Small Blind`,
`Big Blind`, `UTG`, `UTG+1`, `UTG+2`, `UTG+3`, `UTG+4`, `UTG+5` (i.e. `UTG+N` for every seat
between the big blind and the button, numbered outward from UTG). For stud games, the
equivalent seat-position tokens were not separately observed as named strings — stud hands in
our fixtures reference seats purely as `Seat+<n>` with no positional word at all (no "Bring-in
seat" label, etc.) — confirmed absence, not confirmed presence of a different scheme.

**The button rotates every hand, so the *same real player* is called a different positional
name in every successive hand** — `Dealer` in one hand might be `UTG+2` two hands later. **This
is the single most important structural fact for a parser or any downstream consumer to
internalize**: there is no persistent, human-readable player identity anywhere in the ordinary
(non-`[MVS]`) hand text. A tool trying to track "how did this one player do over a session"
cannot do it from the display name at all in the pre-2021 format — the position resets every
hand and carries no memory.

**Hero is marked separately and independently of position**: the literal suffix ` [ME]` is
appended directly after the positional name, in every place that name appears (seat line,
action lines, showdown line), e.g. `UTG+2 [ME]`, `Big Blind [ME]`, `Seat+4 [ME]`. This is
confirmed real in every era of fixture obtained, including the very earliest (2012) and the very
latest (2021+) samples. **Hero's positional name still changes every hand exactly like every
other seat's does** — only the `[ME]` tag is stable; the position word next to it is not.
Because of this, "hero" is trivially identifiable by grepping for the literal substring `[ME]`
anywhere in the hand, but **no other seat is identifiable across hands at all** in the
pre-`[MVS]` format — there is no equivalent tag for villains.

**What happens when the same positional name recurs within one hand**: it can't — each position
token (`Dealer`, `Small Blind`, `Big Blind`, `UTG`, `UTG+1`, …) is assigned to exactly one seat
per hand by construction (there is exactly one button, one small blind, etc., and UTG+N
increments monotonically around the remaining seats). There is no observed case of two seats
sharing a positional name within a single hand in any fixture obtained. (Contrast the Chico
network, which we found *does* have a real duplicate-seat-number bug — no equivalent defect was
found here.)

**The `[MVS]`-era `Player Info:` line is a second, independent, seat-indexed identity channel**,
layered on top of (not replacing) the positional name scheme above:
```
Player Info: Seat1: P1-d07e9231948e51d3174b777a4673828d, Seat2: P2-44fbd5113ff5581f5a26b0ba89c64fce, ...
```
Each token is `P<seat-number>-<32-hex-character-hash>`. This looks exactly like what you'd want
for cross-hand player tracking (a stable pseudonymous ID independent of the position-based
display name) — **but we could not confirm this from real data**, because no `[MVS]`-tagged
fixture with more than one hand sharing overlapping seats was found in this research pass. Do
not assume the hash is a stable per-player identifier without independent verification; treat
it as a promising, structurally-suggestive lead for a future research pass rather than a
confirmed fact. If it does turn out to be stable, it would be the *only* way to link the same
real player across hands anywhere in this entire format, in any era — which is exactly why it's
worth flagging so prominently rather than silently omitting it.

**Practical implication for a parser/converter**: if the goal is to reconstruct a
PokerStars-style hand history with real, stable player names (as every open-source converter
found in this research explicitly exists to do), **that goal is fundamentally unachievable from
the hand-history text alone** for pre-`[MVS]` hands other than hero. Every villain in every hand
must be assigned an arbitrary, hand-scoped synthetic name (e.g. "Seat 3", "Villain_UTG+2") by
the converter itself — this is not a parsing gap to fix, it's an inherent property of the source
data. Converters that claim to recover "real" villain names across hands (several forum threads
found during this research allude to attempts at this) are necessarily guessing/correlating via
external heuristics (stack-size continuity, action timing, etc.), not reading them from the text.

## 12. File naming, hands per file, encoding + line endings

- No canonical real-export file-naming convention was recoverable (both corpora used here
  rename fixtures for their own test taxonomies).
- Multi-hand files are separated by blank-line runs; the reference parser's own splitter uses
  `re.split("\n\n+")` (one or more blank lines) as the general splitter and a stricter
  `"(\n\n\n+)"` variant for a specific tail-cleanup step — meaning single-blank-line separation
  is the norm, unlike Winamax's five-blank-line convention.
- All fixtures obtained in this research pass were plain ASCII/UTF-8-compatible with standard
  LF line endings — no BOM, no UTF-16 variant found for this network (contrast WPN, which has
  both).
- One real fixture (`matt57225-converter-samples/4.txt`) is **itself truncated mid-hand** in the
  upstream repository (ends at a bare `*** SUMMARY ***` with nothing after it) — kept verbatim
  as evidence that raw exports/copies of this format can arrive incomplete in the wild; a parser
  should not crash outright on an incomplete tail, only fail to fully resolve that one hand.

## 13. Gotchas

1. **No persistent player identity for anyone except hero** in the ordinary (pre-`[MVS]`)
   format — see §11 in full before designing any player-tracking logic.
2. Positional name != table position stability — `Dealer`/`Small Blind`/`Big Blind`/`UTG+N` are
   reassigned fresh every hand as the button rotates; never cache "who is UTG+2" across hands.
3. `[ME]` hero tag placement is positional-name-then-tag-then-stack on the seat line
   (`UTG+2 [ME] ($49.50 in chips)`) but name-then-tag-then-colon on action lines (`UTG+2 [ME] :
   Folds`) — the tag's surrounding whitespace/punctuation differs by context; don't assume one
   regex covers both.
4. Verb capitalization is genuinely inconsistent even within the same era/brand — `Folds` vs
   (implicitly, per parser regex) lowercase variants, `Raises`/`raises`, `Bets`/`bets` all
   confirmed as accepted alternatives by the reference parser; do not assume Title Case.
5. `Calls`/`Call` (with and without the plural `s`) are both real, confirmed by the reference
   parser's explicit handling of both as distinct literal alternatives.
6. Amounts sometimes omit the currency symbol even mid-hand on a table that uses `$` elsewhere
   (e.g. `Return uncalled portion of bet 74` with no `$`, on the same hand where blinds were
   posted as `$0.25`) — don't assume symbol presence is consistent within one hand.
7. Cash tournament payout uses `Hand result $<amt>` (lowercase r, dollar sign); tournament-mode
   payout uses `Hand Result <amt>` (capital R, no dollar sign) — same semantic event, two
   different renderings depending on cash-vs-tournament, confirmed real in both forms.
8. The summary block's seat token is `Seat+<n>:` for **every** game type including hold'em/
   Omaha, even though that same hand's header seat-listing block used plain `Seat <n>:` (no
   plus) for hold'em/Omaha — a real, confirmed, easy-to-miss `+`-presence inconsistency between
   the two blocks.
9. All-in can occur before `*** HOLE CARDS ***` (posting a short-stacked blind) — a street-aware
   parser must handle actions in a "pre-deal" phase, not assume all pre-`HOLE CARDS` lines are
   simple, atomic blind posts.
10. Stud hands have **no player names on the seat-listing line at all** (`Seat+<n>: <amt> in
    chips`) — positional identity for stud only exists in the later action-stream `Seat+<n>`
    tokens; there is no analog of hold'em's `Small Blind`/`Big Blind`/`UTG+N` words for stud in
    any sample obtained.
11. Zone Poker hands can contain bare, unprefixed `Enter(Auto)` lines with no player name at
    all before the colon — don't assume every action-stream line has a `<name> :` prefix.
12. A confirmed, dated (2012-08) grammar change exists in how raise amounts are rendered — if
    supporting hands from 2012 specifically, do not assume the same regex works across the whole
    2012 calendar year.
13. `[MVS]`-era big-field tournaments can have large, arbitrary seat numbers (not bounded by
    1-max-seats) — don't validate seat numbers against the table's stated max-seat count.
14. At least one real fixture is itself an incomplete/truncated hand (missing its summary body)
    — design for graceful partial-hand handling, not a hard parse failure on EOF-mid-hand.

## 14. Sample index

See `fixtures/samples/ignition/SOURCES.md` for the full file-by-file table — 4 files in
`matt57225-converter-samples/` (2017-2018, cash Zone Poker + tournament) and 52 files in
`fpdb3-regression-corpus/` (2012-2022, cash and tournament, hold'em/Omaha/Omaha-8/stud/Zone
Poker/`[MVS]`).

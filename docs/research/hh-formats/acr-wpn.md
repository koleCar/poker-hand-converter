# America's Cardroom / WPN (Winning Poker Network) hand history format

Covers America's Cardroom (ACR), Black Chip Poker, True Poker, Ya Poker — all skins of the
Winning Poker Network (WPN, "PaiWangLuo"-adjacent US-facing network; WPN itself is sometimes
called "PRR"/"Poker Rewards" internally, a string that appears literally inside old-format
`Game ID:` lines, see §4).

## 1. Overview & status — READ THIS FIRST

**WPN hand histories are not one format. We found real, dated samples proving at least three
generations of the grammar, and the encoding is unpredictable across all of them.** A parser
built from a single example (of any era) will silently fail on the others. This is the most
important thing this document has to say.

| Era | Confirmed date range | Header shape | Confirmed from |
|---|---|---|---|
| A | 2013-2014 | `Game started at: Y/M/D H:MM:SS` + `Game ID: <id> <sb>/<bb> <table> (<Game>)` | 40 REAL files (hhsmithy corpus) |
| A/B (same grammar, later) | persisted to at least 2019 | identical to Era A | 6+ REAL files (fpdb-3 corpus, dated 2016, 2018, 2019) |
| C (modern) | confirmed from 2019-01 through 2022-07 (newest sample obtained) | `Hand #<id> - <Game>(<Limit>) - <stakes> - <date> UTC` (cash) / `Game Hand #<id> - Tournament #<id> - ... - Level N (...)- <date> UTC` (tournament) | 15+ REAL files (fpdb-3 corpus) |

All three are confirmed real (not inferred) — see `fixtures/samples/acr-wpn/SOURCES.md` for the
exact file list. We have **no sample newer than 2022-07**, so we cannot confirm era C is still
current; treat "is this still the live format" as an open question a parser should be able to
detect and fail loudly on rather than silently mis-parse.

**Encoding is not tied to era.** We found a 2016-dated era-A/B file that is UTF-16LE, and a
2019-dated era-A/B file (same grammar family) that is plain ASCII. **Every parser must sniff
encoding per file** (try UTF-8-with-BOM, then UTF-16LE-with-BOM, then fall back to cp1252/ASCII)
rather than assume one. This is the only site in this entire four-site research pass where we
found real UTF-16LE hand history files.

**A rarer fourth variant** exists: a 2018-dated tournament file using era-A/B grammar but with
every player's screen name replaced by a bare numeric ID (`Seat 5: 794927806 (1980).`) — an
aggregated/"data-mined" export mode, distinct from a player's own hand history. Real, confirmed,
but we could not determine what triggers this mode (public database export? a specific tool?).

## 2. Detection signature

WPN hand histories **never print a site or skin name anywhere in the hand text**, in any era —
confirmed across all 77 files obtained (see SOURCES.md). This is itself a fact worth encoding:
if your header-detection logic is "look for a known site name string", WPN will never match
that way and you must use structural signatures instead.

- **Era A/B**: unambiguous — the literal string `Game started at: ` begins every hand, and the
  second line begins `Game ID: `. No other site in this survey uses this pair of literals.
  ```
  ^Game started at: \d{4}/\d{1,2}/\d{1,2} \d{1,2}:\d{1,2}:\d{1,2}$
  ```
- **Era C** is the hard case: its header is a bare `Hand #<digits> - ` or `Game Hand #<digits> -
  ` with **no site name at all**, which superficially resembles Unibet's `Unibet Hand
  #1558006027 - ...` and could in principle collide with a truncated/re-exported PokerStars-like
  file. The WPN parser maintainers themselves ran into this and fixed it by **anchoring the
  regex to the start of a line** so it doesn't match mid-string inside another room's
  site-prefixed header (`^(?:Game\s)?Hand\s\#\d+\s\-\s`, confirmed from `WinningToFpdb.py`
  source comment: *"Anchor the bare 'Hand #' / 'Game Hand #' header to the start of a line so it
  does not also match other rooms whose header is '<Room> Hand #...'"*). For disambiguation from
  a genuine PokerStars file specifically (which never has a bare `Hand #` header — it is always
  `PokerStars Hand #...` or `PokerStars Game #...`), the anchored-bare-`Hand #` pattern above is
  itself already sufficient and safe. The single strongest secondary confirmation once the file
  is provisionally identified as era-C-WPN-like: the literal recurring line
  `Main pot $<amt> | Rake $<amt>` (or without the `$`) printed **after every street header**,
  including immediately after `*** HOLE CARDS ***` — this line does not exist in PokerStars,
  Winamax, Ignition/Bovada, or (per our Chico sample set) Chico output, and is the single most
  distinctive WPN-era-C fingerprint found in this research.
- **Distinguishing era-C WPN from Chico** (both are bare, site-name-less, PokerStars-adjacent
  formats — see `chico.md` §2): Chico's header always has an explicit skin brand name followed
  by ` Game #<id>:` (`BetOnline Poker Game #...`, `Tiger Gaming Game #...`, etc.) — WPN era C
  never has a brand name at all. If the header brand-name field is present, it's Chico (or one
  of PokerStars/GGPoker/etc., none of which are WPN); if entirely absent and the line starts
  with a bare `Hand #`/`Game Hand #`, it's WPN era C.

## 3. Full verbatim example hands

### Cash game, era A (real — `fixtures/samples/acr-wpn/hhsmithy-corpus/CashGame_HandActionTests_BasicHand.txt`)

```
Game started at: 2014/3/9 19:37:22
Game ID: 261679750 2/4 Braunite ( Beast ) (Omaha)
Seat 5 is the button
Seat 1: ap1104 (173.82).
Seat 3: Pokergodacolyte (386.70).
Seat 4: cuzimwhite (377.18).
Seat 5: primume (262.17).
Seat 6: HanSoloDolo (400).
Player HanSoloDolo has small blind (2)
Player ap1104 has big blind (4)
Player HanSoloDolo received a card.
Player HanSoloDolo received a card.
Player ap1104 received a card.
Player ap1104 received a card.
Player Pokergodacolyte received a card.
Player Pokergodacolyte received a card.
Player cuzimwhite received a card.
Player cuzimwhite received a card.
Player primume received a card.
Player primume received a card.
Player Pokergodacolyte raises (12)
Player cuzimwhite calls (12)
Player primume folds
Player HanSoloDolo calls (10)
Player ap1104 calls (8)
*** FLOP ***: [Qd 4d 7d]
Player HanSoloDolo checks
Player ap1104 checks
Player Pokergodacolyte checks
Player cuzimwhite checks
*** TURN ***: [Qd 4d 7d] [Jc]
Player HanSoloDolo checks
Player ap1104 checks
Player Pokergodacolyte checks
Player cuzimwhite checks
*** RIVER ***: [Qd 4d 7d Jc] [10d]
Player HanSoloDolo checks
Player ap1104 checks
Player Pokergodacolyte checks
Player cuzimwhite checks
Player ap1104 mucks cards
Player Pokergodacolyte mucks cards
Player cuzimwhite mucks cards
------ Summary ------
Pot: 45.75. Rake 2
Board: [Qd 4d 7d Jc 10d]
Player ap1104 mucks (does not show cards). Bets: 12. Collects: 0. Loses: 12.
Player Pokergodacolyte mucks (does not show cards). Bets: 12. Collects: 0. Loses: 12.
Player cuzimwhite mucks (does not show cards). Bets: 12. Collects: 0. Loses: 12.
Player primume does not show cards.Bets: 0. Collects: 0. Wins: 0.
*Player HanSoloDolo shows: Three Of Kind of 10s [10h Js 10c 5c]. Bets: 12. Collects: 45.75. Wins: 33.75.
Game ended at: 2014/3/9 19:38:54
```

### Cash game, era C / modern (real — `fixtures/samples/acr-wpn/fpdb3-regression-corpus/cash__NLHE-9max-USD-0.01-0.02-201911.CASHID-TN-Miramar (Cap) GAMETYPE.txt`)

```
Hand #151588328 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC
Miramar (Cap) 9-max Seat #1 is the button
Seat 1: BrokenRec ($0.00) is sitting out
Seat 2: Papabear2016 ($0.90)
Seat 3: ccZORBAcc ($1.40)
Seat 6: Itspinkynigga ($0.69)
Seat 9: IrishPimp2233 ($2.66)
Papabear2016 posts the small blind $0.01
ccZORBAcc posts the big blind $0.02
*** HOLE CARDS ***
Dealt to ccZORBAcc [9c Qd]
Itspinkynigga folds
IrishPimp2233 raises $0.05 to $0.05
Papabear2016 calls $0.04
ccZORBAcc calls $0.03
*** FLOP *** [Qh 5c 4d]
Main pot $0.15 | Rake $0.00
Papabear2016 checks
ccZORBAcc bets $0.11
IrishPimp2233 caps $0.55
Papabear2016 folds
ccZORBAcc calls $0.44
*** TURN *** [Qh 5c 4d] [As]
Main pot $1.19 | Rake $0.06
*** RIVER *** [Qh 5c 4d As] [6c]
Main pot $1.19 | Rake $0.06
*** SHOW DOWN ***
Main pot $1.19 | Rake $0.06
ccZORBAcc shows [9c Qd] (a pair of Queens [Qh Qd As 9c 6c])
IrishPimp2233 shows [7d 6d] (a pair of Sixs [6d 6c As Qh 7d])
ccZORBAcc collected $1.19 from main pot
*** SUMMARY ***
Total pot $1.19 | Rake $0.04 | JP Fee $0.02
Board [Qh 5c 4d As 6c]
Seat 2: Papabear2016 (small blind) folded on the Flop
Seat 3: ccZORBAcc (big blind) showed [9c Qd] and won $1.19 with a pair of Queens [Qh Qd As 9c 6c]
Seat 6: Itspinkynigga folded on the Pre-Flop and did not bet
Seat 9: IrishPimp2233 showed [7d 6d] and lost with a pair of Sixs [6d 6c As Qh 7d]
```
(Note: `Total pot` rake, `$0.04`, differs from the per-street `Rake $0.06` shown mid-hand, plus a
separate `JP Fee $0.02` — the mid-hand `Main pot | Rake` line is a running/interim figure, not
final; only trust the `*** SUMMARY ***` block's numbers.)

### Tournament, era C / modern (real — `fixtures/samples/acr-wpn/fpdb3-regression-corpus/tour__NLHE-8max-NA-0-0-202207.GTD.txt`, newest sample obtained)

```
Game Hand #1296393662 - $5,000 GTD Tournament #27099516 - Holdem(No Limit) - Level 10 (3000.00/6000.00)- 2022/07/11 01:11:44 UTC
Table '99' 8-max Seat #3 is the button
Seat 1: Player0 (323265.00)
Seat 5: Hero (112303.00)
Player0 posts ante 900.00
Hero posts ante 900.00
Player3 posts the small blind 3000.00
Hero posts the big blind 6000.00
*** HOLE CARDS ***
Main pot 7200.00
Dealt to Hero [Qd Jc]
Player5 raises 12000.00 to 12000.00
Player6 calls 12000.00
Hero calls 6000.00
*** FLOP *** [6h 4c 6s]
Main pot 46200.00
Hero checks
*** RIVER *** [6h 4c 6s 7d] [3c]
Main pot 46200.00
Hero bets 30954.00
Player5 folds
Player6 folds
Uncalled bet (30954.00) returned to Hero
Hero does not show
*** SUMMARY ***
Total pot 46200.00
Seat 5: Hero did not show and won 46200.00
```
(Trimmed for length — see the fixture file for the full seat/action list. Note the header's `)-`
with **no space** between the blinds-parenthesis close and the dash.)

## 4. Header grammar

**Era A/B:**
```
Game started at: <Y>/<M>/<D> <H>:<MIN>:<S>
Game ID: <id> <sb>/<bb> <table info> (<Game>)[ <N>-max]
Seat <n> is the button
```
- `<Game>` observed: `Hold'em`, `Omaha`, `Seven Cards Stud`, `Six Plus Hold'em`. Confirmed
  historical literal tag `(PRR)` appears inline in the table-info field on many but not all
  files (e.g. `2/4 Braunite ( Beast ) (Omaha)` has no PRR tag; `0.02/0.05 6+ (PRR) ($5 Max) (Six
  Plus Hold'em)` does) — meaning is unconfirmed (plausibly "Poker Rewards" / WPN's internal
  network label) but its presence/absence is not diagnostic of anything else we could determine.
- Table-info free text can itself contain irregular internal spacing that is **real, not a
  copy artifact** — e.g. `Braunite ( Beast )`, `Barstowite   (Short, JP)` (three spaces). Do not
  "clean up" whitespace when parsing table names; preserve or explicitly strip only where safe.
- `- CAP -` and `(JP)` (jackpot-table) tokens can appear embedded in the table-info text.
- Play-money tables use the same grammar with no currency symbol (e.g. `Wichita Falls`,
  amounts unadorned).
- Date has **no leading zeros** (`2014/3/9`, not `2014/03/09`) and no timezone suffix at all in
  era A/B (contrast era C, which always ends `UTC`).

**Era C (modern), cash:**
```
Hand #<id> - <Game>(<Limit>) - <cur><sb>/<cur><bb> - <Y>/<M>/<D> <H>:<M>:<S> UTC
<table name>[ (<qualifier>)] <N>-max Seat #<n> is the button
```
- `<Game>(<Limit>)` has **no space** before the parenthesis: `Holdem(No Limit)`,
  `Omaha H/L(Fixed Limit)`. Note `Holdem` here — no apostrophe — unlike Winamax's `Holdem` and
  PokerStars' `Hold'em`; this is itself a small disambiguator worth keeping in mind if a
  normalizer is shared across sites.
- The table-name line for cash games has **no `Table` keyword and no quotes** at all — it's the
  bare location name directly followed by `<N>-max Seat #<n> is the button`, e.g. `Fort Lupton
  9-max Seat #5 is the button` or `Miramar (Cap) 9-max Seat #1 is the button`. This is a real,
  confirmed structural difference from both Chico (`Table 'Name' N-Max, Seat #n is the button`)
  and PokerStars (`Table 'Name' N-max Seat #n is the button`) — WPN era-C cash omits `Table`
  and the quote marks entirely. **Tournament tables, however, do use `Table '<n>'`** (quoted,
  usually a bare number) — see the tournament example above. A parser must handle both shapes.

**Era C (modern), tournament:**
```
Game Hand #<id> - [<buyin/gtd text> ]Tournament #<tourno> - <Game>(<Limit>) - Level <n> (<sb>/<bb>)- <Y>/<M>/<D> <H>:<M>:<S> UTC
```
- Note the confirmed **missing space** between the blinds-parenthesis close and the following
  dash: `(3000.00/6000.00)- 2022/07/11...`. A regex written from a cash-game example (which does
  have consistent spacing) will not match this without accounting for it.
- Optional GTD-amount / tournament-name prefix observed as free text before `Tournament #`
  (e.g. `$5,000 GTD Tournament #27099516`).

## 5. Table/seat lines, button, max seats

```
Seat <n>: <player>[ (<amt>)][.]
```
- Era A/B: amount is in bare parens with a **trailing period** on the line:
  `Seat 1: ap1104 (173.82).` The period is part of the real grammar, not a typo — confirmed
  across all 40 era-A files.
- Era C: amount is `($<amt>)` with **no trailing period**: `Seat 1: BrokenRec ($0.00) is
  sitting out`. Sitting-out status, when present, is appended directly to the seat line itself
  in era C (`is sitting out`) — a structural difference from era A/B, where sitting-out is
  reported later as its own action-stream line (`Player X sitting out`), never on the seat line.
- Button: `Seat <n> is the button` (era A/B, bare, own line) vs `Seat #<n> is the button`
  appended to the end of the table-name line (era C, inline, hash before the number).
- Max-seat values observed: 2 (heads-up), 6, 8, 9. No confirmed 10-max WPN sample (contrast
  Chico, which is 10-max by default, §"Detection" note in `chico.md`).

## 6. Blinds, antes, straddle, dead blinds, waiting

**Era A/B (verbatim, confirmed):**
```
Player <name> has small blind (<amt>)
Player <name> has big blind (<amt>)
Player <name> posts (<amt>)
Player <name> posts (<amt>) as a dead bet
Player <name> straddle (<amt>)
Player <name> ante (<amt>)
Player <name> is timed out.
Player <name> wait BB
Player <name> sitting out
```
`posts (<amt>) as a dead bet` is immediately followed on the next line by a plain
`posts (<amt>)` for the live portion — two lines for one dead+live post, confirmed in
`PostingDead.txt`.

**Era C (verbatim, confirmed):**
```
<name> posts the small blind $<amt>
<name> posts the big blind $<amt>
<name> posts dead $<amt>
<name> posts ante <amt>
```
No straddle sample exists in era C in our corpus — unconfirmed whether the verb changes.

## 7. Street markers — exact spelling per era (confirmed)

**Era A/B, hold'em/Omaha:**
```
*** FLOP ***: [Xx Xx Xx]
*** TURN ***: [Xx Xx Xx] [Xx]
*** RIVER ***: [Xx Xx Xx Xx] [Xx]
```
Note the **colon immediately after the stars**, before the bracket — a hard structural marker
of era A/B, absent in era C.

**Era A/B, seven-card stud (confirmed, mixed case, distinct set):**
```
*** Third street ***
*** Fourth street ***
*** Fifth street ***
*** Sixth street ***
```
(No explicit "Seventh street"/river marker line was observed before the final action in our
stud samples — the seventh card is dealt silently via `received card:`/`received a card.`
lines with no preceding `***` marker in the fixtures we have; unconfirmed whether one exists.)

**Era C, all games (confirmed, no colon):**
```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx Xx] [Xx]
*** SHOW DOWN ***
*** SUMMARY ***
```
Every one of these (except `*** SUMMARY ***`) is immediately followed by a
`Main pot <cur><amt> | Rake <cur><amt>` line before any action resumes — era C only, and the
single strongest fingerprint of this era (see §2).

## 8. Action verbs — exact phrasing

**Era A/B (confirmed verbatim):** `Player <name> folds`, `checks`, `calls (<amt>)`,
`raises (<amt>)` — **see the correction immediately below, this is the single most damaging thing
to get wrong in this format** — `bets (<amt>)`, `allin (<amt>)`, `mucks cards`, `is timed out.`.
Uncalled bet:
`Uncalled bet (<amt>) returned to <name>`. Showdown-with-cards:
`*Player <name> shows: <hand description> [<cards>]. Bets: X. Collects: Y. Wins: Z.` — leading
`*` marks the shown/winning hand specifically (mirrors WPN's own summary convention, not
optional decoration). Not-shown: two variants confirmed for the identical situation —
`Player <name> does not show cards.Bets: ...` (uncontracted, **no space before "Bets:"** — real,
confirmed in multiple 2014 files) and `Player <name> doesn't show cards.Bets: ...` (contracted,
confirmed in a different 2016/2019 file) — **a parser must accept both spellings**.

### CORRECTION: era A/B `raises (N)` is the chips the player ADDS, not a street total

**An earlier revision of this document said `(N)` was the "absolute raise-to amount, not a
delta". That was wrong, and it is corrected here rather than softened, because a parser written
from it overstates every raise by a player who already had chips in on that street — and still
balances on the many hands where the raiser was first in, so the bug hides.** ACR/WPN is the
largest US-facing pool in this project, which makes this the most consequential error in the
research set.

**The correct reading:** `(N)` is the number of chips the player puts in *with this action*. The
player's new street total is `their prior street investment + N`.

Note carefully that this is **not** the PokerStars sense of "delta" either. PokerStars' `raises X
to Y` puts the increment *over the current bet* in `X`. ACR puts the *chips added by this
player* in `(N)`. The two differ whenever the raiser already has money in front of them, which is
exactly the blind-vs-button case that occurs constantly.

**Decisive single hand** — `hhsmithy-corpus/CashGame_PlayerTests_WaitingBB.txt`, blinds 0.10/0.25:

```
Player ButtonSmasher has small blind (0.10)
Player Garzvorgh has big blind (0.25)
Player ButtonSmasher raises (0.40)
Player Garzvorgh folds
Uncalled bet (0.25) returned to ButtonSmasher
------ Summary ------
Pot: 0.50. Rake 0
Player Garzvorgh does not show cards.Bets: 0.25. Collects: 0. Loses: 0.25.
*Player ButtonSmasher mucks (does not show cards). Bets: 0.25. Collects: 0.50. Wins: 0.25.
```

Three readings, checked against the four independent numbers the file already states
(the returned amount, both `Bets:` figures, and `Pot:`):

| reading | street total | uncalled returned | matches printed 0.25? |
|---|---|---|---|
| absolute street total (**old claim**) | 0.40 | 0.40 − 0.25 = **0.15** | ✗ |
| PokerStars-style increment over current bet | 0.25 + 0.40 = 0.65 | 0.65 − 0.25 = **0.40** | ✗ |
| **chips added by this player** | 0.10 + 0.40 = 0.50 | 0.50 − 0.25 = **0.25** | ✓ |

Only the third reading also reproduces `Bets: 0.25` (0.50 staked − 0.25 returned) and
`Pot: 0.50` (0.25 + 0.25).

**Corpus-wide verification.** Each reading was simulated over every era-A/B hand containing a
raise, replaying the action lines and reconciling the result against the per-player `Bets:`
column that the format prints independently — so the file validates the hypothesis rather than
the other way round:

| reading | hands matching `Bets:` | hands mismatching |
|---|---|---|
| **chips added** | **87** | 8 |
| absolute street total (old claim) | 53 | 42 |
| increment over current bet | 2 | 93 |

The 8 residual mismatches under the correct reading are *not* raise-semantics failures: they are
one ante tournament (every player off by exactly the 10-chip ante, which the simulation did not
model) and one capped PLO file (cap mechanics). Note also that the wrong reading still matched 53
hands — that is the trap, and it is why this needed a whole-corpus check rather than a spot check.

Independently corroborated by parser agent 5, which cross-checks every legacy hand per player
against the `Bets:` column and refuses a hand rather than storing it when the reading disagrees,
across 122 hands.

**Cross-site note:** this "chips added" semantic is the same one used by WePlay and by
Ignition/Bodog/Bovada, and differs from PokerStars, GGPoker and Winamax. See
`COVERAGE-PLAN.md` §4 trap 1 — it is the most common cross-site parser bug in this project.

**Era C (confirmed verbatim):** `<name> folds`, `checks`, `calls $<amt>`,
`raises $<amt> to $<amt>` (delta-then-total, unlike era A/B), `bets $<amt>`, `caps $<amt>`
(cap-game action verb, distinct from raise), `posts ante <amt>`. All-in is a suffix, confirmed
form ` and is all-in` seen appended to a raise line in the WinningToFpdb regex comments (not
directly observed in our fixture text, but the regex explicitly matches
`\s*(and\sis\sall\-in)?\s*$` — treat as confirmed-by-parser-evidence, not confirmed-by-fixture).
Uncalled bet: `Uncalled bet (<amt>) returned to <name>` — same shape as era A/B. Not-shown:
`<name> does not show`. Showdown: `<name> shows [<cards>] (<lowercase hand description>
[<best-five-reconstructed>])`, e.g. `a pair of Queens [Qh Qd As 9c 6c]` — the bracketed
best-five-card reconstruction after the description is era-C-specific and not present in era
A/B's showdown line.

## 9. SUMMARY / pot / rake line layout

**Era A/B:**
```
------ Summary ------
Pot: <amt>. Rake <amt>[. JP fee <amt>]
Board: [<cards>]
Player <name> [mucks (does not show cards)|does not show cards|doesn't show cards].Bets: <amt>. Collects: <amt>. [Wins|Loses]: <amt>.
```
`Board:` has a **colon**, matching Winamax's convention but for an unrelated reason (pure
coincidence — do not assume any shared lineage). `JP fee` (lowercase, jackpot-table rake
component) appears as an optional third clause on the Pot line, confirmed in stud/jackpot
tables.

**Era C:**
```
*** SUMMARY ***
Total pot <cur><amt>[ | Rake <cur><amt>][ | JP Fee <cur><amt>]
Board [<cards>]
Seat <n>: <name>[ (small blind)|(big blind)|(button)] [folded on the <Street>[ and did not bet]|showed [<cards>] and (won|lost) ...|did not show and won <amt>]
```
`Board` here has **no colon** (contrast era A/B and Winamax) — matches PokerStars' and Chico's
convention. `JP Fee` is Title Case here (contrast lowercase `JP fee` in era A/B) — same concept,
different capitalization, a real inconsistency to normalize defensively rather than assume one
casing.

## 10. Date/time format and timezone convention

Era A/B: `Y/M/D H:MM:SS` with **no leading zeros anywhere** (`2014/3/9 19:37:22`,
`2016/8/2 11:17:19`) and **no timezone at all** printed on the header line. Era C: `Y/M/D
H:MM:SS UTC`, always zero-padded, always explicitly `UTC` — confirmed in every era-C file
obtained, no other timezone token seen.

## 11. Anonymized-player conventions

WPN does **not** use Ignition-style positional pseudonyms — real screen names are used in both
eras, for both hero and villains, with one confirmed exception: the "data mined format"
tournament sample (§1) where every player, hero included presumably, is replaced by a bare
numeric ID with no other marker distinguishing which one (if any) is the exporting player. We
could not determine from that single file whether hero is identifiable at all in that mode —
flag this as an open gap rather than guessing. In both normal eras, hero has no special marker
on the seat line at all (unlike Ignition's `[ME]`); hero is identifiable only via the
`Dealt to <name> [<cards>]` line, same mechanism as Winamax.

## 12. File naming, hands per file, encoding + line endings

- fpdb-3's own naming convention for its regression fixtures (not WPN's real export names)
  encodes game/max/currency/stakes/date/note in the filename, e.g.
  `NLHE-9max-USD-0.02-0.05-202104.post.dead.txt` — useful as a human index but not
  representative of what WPN itself names files as.
- Era A/B multi-hand files are separated by a **single blank line** (contrast Winamax's five).
- **Encoding must be sniffed per file, not assumed**: confirmed real files exist as UTF-8 with
  BOM (era A, 2014), UTF-16LE (era A/B grammar, dated 2016), and plain ASCII (era A/B grammar,
  dated 2016 AND 2019 — i.e. the *same* grammar era appears in more than one encoding, so
  encoding cannot be used as an era signal either). We have no evidence either way for era C's
  encoding beyond that our era-C fixtures are plain ASCII/UTF-8-compatible.

## 13. Gotchas

1. **Three structural grammars exist for the same network** — detect the era from the header
   shape before choosing a parsing strategy; don't assume any single example generalizes.
2. **Encoding is unpredictable and uncorrelated with era** — always sniff (try UTF-8 BOM, then
   UTF-16LE BOM, then a fallback codepage) rather than hardcode one.
3. **Era A/B `raises (N)` is the chips the player ADDS with that action** — new street total =
   their prior street investment + N. It is **not** the absolute street total (an earlier
   revision of this doc claimed that; it was wrong — see the correction in §8), and it is **not**
   PokerStars' increment-over-the-current-bet either. The three readings diverge only when the
   raiser already has chips in front of them, which is why a wrong reading still balances on
   about half the corpus and hides. Verified by replaying every era-A/B raise hand against the
   independently-printed per-player `Bets:` column: chips-added 87 match / 8 explainable,
   absolute-total 53/42, increment 2/93. Era C uses explicit `X to Y` instead — a genuinely
   different convention, so do not port one era's raise-size logic to the other.
4. Two spellings of "does not show" exist for the identical situation in era A/B
   (`does not show cards.` vs `doesn't show cards.`) with **no space before `Bets:`** in both —
   handle both, and don't assume a space that isn't there.
5. `Board:` has a colon in era A/B, no colon in era C — don't reuse one era's board-line regex
   for the other, and don't assume this maps consistently to any other site either.
6. Cash-game era-C table lines omit the word `Table` and quote marks entirely; tournament
   era-C table lines include both. Same era, two different shapes depending on game type.
7. The header's blinds-parenthesis-to-dash spacing is inconsistent even within era C
   (tournament: `)-`, no space; cash: `- ` with a space) — don't assume uniform whitespace.
8. WPN skins (ACR, Black Chip, True Poker, Ya Poker) are **textually indistinguishable** from
   each other in the hand history body — there is no brand string anywhere. If your application
   needs to know which skin a file came from, that information must come from outside the hand
   text (account metadata, filename, folder structure), not from parsing.
9. A rare "data mined" export mode anonymizes every player to a numeric ID while otherwise
   using era-A/B grammar — a parser that assumes "the seat name is always a screen name usable
   as a stable player key" will silently treat every hand's numeric IDs as if they were
   meaningful and stable identities; they may or may not be, and we could not confirm either way.
10. Table-name free text can contain irregular real internal whitespace (double/triple spaces,
    stray parens) — do not "normalize" whitespace inside a table name field, it may be load-
    bearing for round-tripping the original text.
11. `Main pot` mid-hand rake figures in era C are **interim, not final** — always read the
    `*** SUMMARY ***` block's `Total pot`/`Rake` for the authoritative final numbers.

## 14. Sample index

See `fixtures/samples/acr-wpn/SOURCES.md` for the full file-by-file table — 40 files in
`hhsmithy-corpus/` (era A, 2014, cash only) and 37 files in `fpdb3-regression-corpus/` (mixed
eras A/B and C, 2015-2022, cash and tournament, hold'em/Omaha/Omaha-8/stud/short-deck).

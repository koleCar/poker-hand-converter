# GGPoker (GGNetwork) hand history format

Covers GGPoker and its skins: Natural8, BestPoker, GGPoker UK/ON, ClubGG. Per-skin differences are
called out inline wherever real evidence exists; everywhere else the honest answer is "not found."

## 1. Overview & status

**Confirmed from real, in-repo samples (files 01-10):** `gg-hh/*.txt`, copied byte-for-byte into
`fixtures/samples/ggpoker/`. 10 files, 431 hands total, all `Poker Hand #HD...`, all `NLHPurple`
Rush & Cash 6-max Hold'em No Limit cash tables, $0.25/$0.5, dated February 2026. This is the only
material in this document captured directly as ground truth; everything else is secondary.

**Confirmed from real secondary sources (files 11-32):** copied from `jejellyroll-fr/fpdb-3`'s
`regression-test-files/` tree — an actively maintained fork of the FPDB poker tracker, which lists
GGPoker as "golden-covered" (i.e. these exact files back that project's own regression snapshots
against a live parser). These fill in tournament (`#TM`), Rush & Cash PLO (`#RC`), PLO/PLO-5
(`#OM`), Short Deck (`#SD`), straddle/over-straddle, missed blind, side pot, run-it-three-times,
**and a real, verified All-in Insurance hand** — none of which exist in the primary corpus. See
`fixtures/samples/ggpoker/SOURCES.md` for the full per-file breakdown.

**Sourced but explicitly flagged as lower-confidence (files 33-35):** three files from the same
project's `tests/fixtures/hands/ggpoker/` directory (not its regression corpus) show concrete
fingerprints of being hand-authored rather than captured: one uses a `#TM` prefix on a plain cash
hand with no tournament clause at all (contradicting the otherwise-universal `#TM` = tournament
pattern seen across every one of the other 33 files), one has transparently sequential fake
anonymization ids, and one has a `*** PREFLOP ***` marker that appears nowhere else in this entire
research pass. Any claim sourced only from these three is marked unverified below rather than
folded in as confirmed fact — see `fixtures/samples/ggpoker/SOURCES.md` for the details.

**Explicitly NOT found, despite a genuinely hard search** (GitHub code search across dozens of
open-source parsers/converters/trackers, PokerTracker/Hold'em Manager forums, Hand2Note's own
GGPoker guide, and general web search):

- **Any real Natural8 or BestPoker hand history file.** The strongest evidence found is
  circumstantial: `jokerlin/gg_converter_gui`, an open-source converter tool whose UI displays a
  Natural8 logo, has conversion logic keyed entirely on the literal string `Poker Hand #RC`
  (`str::replace(&hands, "Poker Hand #RC", "PokerStars Hand #20")`), which is *suggestive* that
  Natural8's real export uses the exact same `#RC` grammar as mainline GGPoker's Rush & Cash — but
  this is inference from a tool's implementation, not an actual Natural8 file, and should be
  weighted accordingly. No BestPoker sample or even a secondhand description of one was found at
  all. `fixtures/samples/natural8/` and `fixtures/samples/bestpoker/` were deliberately left
  uncreated rather than populated with a guess.
- **A real ClubGG hand history file** — but one real header *was* recovered, quoted verbatim by a
  user in a PokerTracker support-forum bug report, and it is genuinely different from mainline
  GGPoker (see §4 and §13). This is the strongest evidence in this document that "the skin" is not
  always just a cosmetic wrapper around identical GG grammar — `fixtures/samples/clubgg/` was also
  left uncreated since no full file was ever obtained.
- Rabbit Hunt, Flip&Go, Spin & Gold, Battle Royale: not found in any real or secondary sample.
- A bounty/knockout **award** line: two real KO tournament hands are in the corpus (files 29, 32),
  but no hand anywhere states a bounty was collected — bounty resolution does not appear to live in
  the per-hand text at all (independently, this is also true for CoinPoker — see `coinpoker.md`).

Do not fill any of the above gaps with an invented grammar.

## 2. Detection signature

GGPoker's header, taken alone, is dangerously generic:

```
Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
```

`Poker Hand #<id>: <game> - <timestamp>` by itself is *not* a safe signature. What actually
disambiguates GGPoker from everything else, in order of reliability:

1. **The hand-id prefix set encodes game/table type, not skin**, and every prefix confirmed across
   the trustworthy corpus (files 01-32, minus the removed empty file 20 — see
   `fixtures/samples/ggpoker/SOURCES.md` — and excluding the three flagged test fixtures) is
   followed by a purely numeric id with no separator: `HD` (Hold'em cash), `RC` (Rush & Cash, seen on both
   Hold'em and PLO), `TM` (Tournament — always paired with a `Tournament #<id>,` clause, with zero
   exceptions across 31 trustworthy files), `OM` (Omaha cash, PLO/PLO-5), `SD` (Short Deck). A
   regex like `^Poker Hand #(HD|RC|TM|OM|SD)\d+:` is a strong, low-false-positive signature. (A
   sixth prefix, `AF`, is claimed by one flagged, likely-synthetic test fixture only — see §1 — and
   should not be added to a production detector without independent confirmation.)
2. **`*** SHOWDOWN ***` with NO space**, every single time, across all 34 fixture files with zero
   exceptions. PokerStars and CoinPoker both spell it `*** SHOW DOWN ***` with a space. This is a
   one-character discriminator that is extremely cheap to check.
3. **The rake line's shape.** GGPoker's summary line is `Total pot X` optionally followed by `|
   Rake Y`, optionally followed by `| Jackpot Z | Bingo Z`, optionally followed by `| Fortune Z |
   Tax Z` (see §9 for the four concretely observed combinations). No other site researched anywhere
   in this project emits a `Jackpot`/`Bingo`/`Fortune`/`Tax` breakdown at all. CoinPoker's is always
   a bare `Total pot X | Rake Y` with nothing else, or `Total pot X | Rake Y` — never more.
4. **`Dealt to <name> ` for every seat, even ones with no visible cards.** No other room in this
   project's research emits a placeholder "Dealt to" line for hidden hands at all. Whether it
   carries a trailing space varies (see §13) but the line's existence at all is a reliable
   corroborating signal.

Recommended combined signature: `^Poker Hand #(HD|RC|TM|OM|SD)\d+:.*$` on the first line, AND the
literal string `*** SHOWDOWN ***` (no space) present somewhere in the body. Do not rely on the
header alone, and do not assume every skin necessarily matches this — see §13 for ClubGG.

## 3. Full verbatim example hands

### 3.1 Cash (real, in-repo — file 01)

```
Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
Table 'NLHPurple70' 6-max Seat #1 is the button
Seat 1: 8c668f2d ($81.22 in chips)
Seat 2: da2a0a00 ($11.75 in chips)
Seat 3: 41ff0a42 ($50.99 in chips)
Seat 4: Hero ($82.8 in chips)
Seat 5: a28e4f77 ($34.98 in chips)
Seat 6: fb779d10 ($11.68 in chips)
da2a0a00: posts small blind $0.25
41ff0a42: posts big blind $0.5
*** HOLE CARDS ***
Dealt to 8c668f2d 
Dealt to da2a0a00 
Dealt to 41ff0a42 
Dealt to Hero [5s 8c]
Dealt to a28e4f77 
Dealt to fb779d10 
Hero: folds
a28e4f77: folds
fb779d10: raises $0.5 to $1
8c668f2d: folds
da2a0a00: calls $0.75
41ff0a42: calls $0.5
*** FLOP *** [Tc 4h Ad]
da2a0a00: checks
41ff0a42: checks
fb779d10: bets $1.5
da2a0a00: folds
41ff0a42: folds
Uncalled bet ($1.5) returned to fb779d10
*** SHOWDOWN ***
fb779d10 collected $2.85 from pot
*** SUMMARY ***
Total pot $3 | Rake $0.15 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Tc 4h Ad]
Seat 1: 8c668f2d (button) folded before Flop (didn't bet)
Seat 2: da2a0a00 (small blind) folded on the Flop
Seat 3: 41ff0a42 (big blind) folded on the Flop
Seat 4: Hero folded before Flop (didn't bet)
Seat 5: a28e4f77 folded before Flop (didn't bet)
Seat 6: fb779d10 won ($2.85)
```
(lines 12-17 each end with a trailing space after the id/`Hero` — invisible above; see §13)

### 3.2 Tournament, bounty/KO (REAL secondary — file 29)

```
Poker Hand #TM599808286: Tournament #25313424, L-03: $52.50 Bounty Hunters Main Event Hold'em No Limit - Level1(100/200) - 2021/04/04 16:06:27
Table '89' 8-max Seat #3 is the button
Seat 1: dee3697a (24,940 in chips)
Seat 2: 23c555f (25,580 in chips)
Seat 3: 5bf8188d (24,440 in chips)
Seat 4: ef3b178a (24,740 in chips)
Seat 5: 598c3984 (24,940 in chips)
Seat 6: Hero (24,940 in chips)
Seat 7: 430ef639 (24,940 in chips)
Seat 8: fd98a38c (25,480 in chips)
5bf8188d: posts the ante 30
fd98a38c: posts the ante 30
598c3984: posts the ante 30
23c555f: posts the ante 30
430ef639: posts the ante 30
ef3b178a: posts the ante 30
Hero: posts the ante 30
dee3697a: posts the ante 30
ef3b178a: posts small blind 100
598c3984: posts big blind 200
*** HOLE CARDS ***
Dealt to dee3697a
Dealt to 23c555f
Dealt to 5bf8188d
Dealt to ef3b178a
Dealt to 598c3984
Dealt to Hero [9s 9h]
Dealt to 430ef639
Dealt to fd98a38c
Hero: raises 200 to 400
430ef639: folds
fd98a38c: raises 1,005 to 1,405
dee3697a: folds
23c555f: folds
5bf8188d: folds
ef3b178a: folds
598c3984: folds
Hero: calls 1,005
*** FLOP *** [4s 2c Ks]
Hero: checks
fd98a38c: bets 1,675
Hero: folds
Uncalled bet (1,675) returned to fd98a38c
*** SHOWDOWN ***
fd98a38c collected 3,350 from pot
*** SUMMARY ***
Total pot 3,350 | Rake 0 | Jackpot 0 | Bingo 0
Board [4s 2c Ks]
Seat 1: dee3697a folded before Flop
Seat 2: 23c555f folded before Flop
Seat 3: 5bf8188d (button) folded before Flop
Seat 4: ef3b178a (small blind) folded before Flop
Seat 5: 598c3984 (big blind) folded before Flop
Seat 6: Hero folded on the Flop
Seat 7: 430ef639 folded before Flop
Seat 8: fd98a38c won (3,350)
```
Note: tournament chip amounts use thousands-separator commas and **no currency symbol**; the rake
line here has only 3 fields (no Fortune/Tax — see §9); `Dealt to <name>` has **no** trailing space
in this file (contrast §3.1 — see §13).

### 3.3 All-in Insurance (REAL secondary, verified by direct inspection — file 15)

```
23aca38f: shows [6s Jd Kc Ts] (Pair of Kings and Pair of Sixes)
Hero: shows [5s Jh Ac Kh] (Pair of Kings)
23aca38f: get an all-in insurance (premium ($0/$4/$0) for ($0/$10.8/$0) - (Mandatory/Main/Sub))
*** RIVER *** [6c Kd Qc 3s] [6h]
23aca38f: pay premium of all-in insurance ($4)
*** SHOWDOWN ***
23aca38f collected $37.5 from pot
*** SUMMARY ***
Total pot $37.5
Board [6c Kd Qc 3s 6h]
```
(full hand — seats, blinds, preflop, flop, turn — in the fixture file itself; note the SUMMARY here
has **no `Rake` field at all**, just `Total pot $37.5` — see §9.) This is a **different mechanic
from EV Cashout** (§3.4/§8): the verbs (`get an all-in insurance`, `pay premium of all-in
insurance`) and the parenthetical shape (three slash-separated dollar tuples plus a
`Mandatory/Main/Sub` label) do not resemble `Chooses to EV Cashout`/`Pays Cashout Risk` at all.
Whether GG runs both features simultaneously today, or Insurance is an older name/mechanic since
replaced by EV Cashout, could not be established from the evidence gathered — the Insurance sample
is from a 2020-dated fpdb regression file, while EV Cashout is confirmed in the 2026 in-repo corpus,
which is at least consistent with Insurance being older and possibly superseded, but that is
speculation, not a finding. **Implement them as two independent, non-overlapping code paths.**

### 3.4 EV Cashout / all-in equity buyout (REAL, in-repo — file 04)

```
Poker Hand #HD2735972142: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 06:24:30
Table 'NLHPurple11' 6-max Seat #3 is the button
Seat 1: 4d960f58 ($54.65 in chips)
Seat 2: b65c35c8 ($53.59 in chips)
Seat 3: 364e5533 ($50 in chips)
Seat 4: Hero ($50 in chips)
Seat 5: d31522d6 ($44.37 in chips)
Seat 6: 6d09f27f ($85.04 in chips)
Hero: posts small blind $0.25
d31522d6: posts big blind $0.5
*** HOLE CARDS ***
Dealt to 4d960f58 
Dealt to b65c35c8 
Dealt to 364e5533 
Dealt to Hero [Qs 8h]
Dealt to d31522d6 
Dealt to 6d09f27f 
6d09f27f: folds
4d960f58: raises $0.6 to $1.1
b65c35c8: folds
364e5533: folds
Hero: folds
d31522d6: raises $2.4 to $3.5
4d960f58: raises $5.5 to $9
d31522d6: calls $5.5
*** FLOP *** [Jc 7s 9s]
d31522d6: checks
4d960f58: bets $6
d31522d6: raises $29.37 to $35.37 and is all-in
4d960f58: calls $29.37
d31522d6: shows [Kd Qd] (King high)
4d960f58: shows [Ac As] (a pair of Aces)
*** TURN *** [Jc 7s 9s] [Ts]
d31522d6: Chooses to EV Cashout
*** RIVER *** [Jc 7s 9s Ts] [Ah]
d31522d6: Pays Cashout Risk ($19)
*** SHOWDOWN ***
d31522d6 collected $84.49 from pot
*** SUMMARY ***
Total pot $88.99 | Rake $4 | Jackpot $0.5 | Bingo $0 | Fortune $0 | Tax $0
Board [Jc 7s 9s Ts Ah]
Seat 1: 4d960f58 showed [Ac As] and lost with three of a kind, Aces
Seat 2: b65c35c8 folded before Flop (didn't bet)
Seat 3: 364e5533 (button) folded before Flop (didn't bet)
Seat 4: Hero (small blind) folded before Flop
Seat 5: d31522d6 (big blind) showed [Kd Qd] and won ($84.49) with a straight, Ace to Ten, Cashout Risk ($19)
Seat 6: 6d09f27f folded before Flop (didn't bet)
```

### 3.5 Run-it-twice (REAL, in-repo — file 02)

```
*** FIRST FLOP *** [3s 6s 2d]
d971c0c0: checks
Hero: bets $0.91
d971c0c0: raises $2.29 to $3.2
Hero: raises $4.3 to $7.5
d971c0c0: raises $17.41 to $24.91 and is all-in
Hero: calls $17.41
d971c0c0: shows [3d 2h] (two pair, Threes and Twos)
Hero: shows [4s Ks] (King high)
*** FIRST TURN *** [3s 6s 2d] [7d]
*** FIRST RIVER *** [3s 6s 2d 7d] [6h]
*** SECOND TURN *** [3s 6s 2d] [5d]
*** SECOND RIVER *** [3s 6s 2d 5d] [Kh]
*** FIRST SHOWDOWN ***
d971c0c0 collected $24.74 from pot
*** SECOND SHOWDOWN ***
Hero collected $24.73 from pot
*** SUMMARY ***
Total pot $52.57 | Rake $2.6 | Jackpot $0.5 | Bingo $0 | Fortune $0 | Tax $0
Hand was run two times
FIRST Board [3s 6s 2d 7d 6h]
SECOND Board [5d Kh]
```
(full seats/blinds/preflop omitted for brevity. When the all-in happens on the flop, only
`TURN`/`RIVER` get `FIRST`/`SECOND` variants — no `SECOND FLOP`, since the flop is shared. When the
all-in happens preflop, `FIRST FLOP`/`SECOND FLOP` both appear, each independent — confirmed in
file 07. Run-it-**three**-times also exists and works the same way — confirmed real, file 17.)

## 4. Header line grammar

Every observed shape, tagged with its evidence source:

| Game | Prefix | Header shape | Evidence |
|---|---|---|---|
| Hold'em No Limit, cash | `HD` | `Poker Hand #HD<id>: Hold'em No Limit ($sb/$bb) - YYYY/MM/DD HH:MM:SS` | REAL, in-repo |
| Hold'em/Omaha, Rush & Cash | `RC` | `Poker Hand #RC<id>: <Game> ($sb/$bb) - YYYY/MM/DD HH:MM:SS` — confirmed with `<Game>` = `Omaha Pot Limit` | REAL secondary (file 13) |
| Tournament | `TM` | `Poker Hand #TM<id>: Tournament #<tid>, <name> <Game> - Level<N>(<sb>/<bb>) - YYYY/MM/DD HH:MM:SS` — always paired with `Tournament #<tid>,`, no exceptions in 31 trustworthy files | REAL secondary (files 27, 29, 30, 32) |
| Omaha (PL or NL) cash, incl. PLO-5 | `OM` | `Poker Hand #OM<id>: Omaha Pot Limit ($sb/$bb) - ...` **or the bare abbreviation** `PLO ($sb/$bb) - ...` / `PLO-5 ($sb/$bb) - ...` with no "Omaha ... Limit" wording at all | REAL secondary (files 14/35, 19-26) |
| Short Deck No Limit | `SD` | `Poker Hand #SD<id>: ShortDeck No Limit ($stake) - ...` — **single stake number, not an sb/bb pair** | REAL secondary (files 11-12) |
| "All-in or Fold Omaha" (unverified) | `AF` | `Poker Hand #AF<id>: Omaha No Limit ($sb/$bb) - ...` | **Only in a flagged, likely-synthetic test fixture (file 33)** — do not trust without independent confirmation; see §1. |

Tournament name/header irregularities, all confirmed real:

- **Inconsistent internal whitespace.** File 27 has a confirmed real **triple space** before the
  Level clause: `Hold'em No Limit   - Level14(300/600)`. Within the trustworthy corpus, `Level`
  clauses appear both **without** a space before the parenthesis (`Level1(100/200)`,
  `Level18(1,250/2,500)`) and **with** one (`Level2 (60/120)`, `Level10 (1,000/2,000)`) — this is
  not a single-file fluke, it recurs across multiple independent files. An independent open-source
  Rust parser (`erikfastermann/poker-toolkit`) built its cash-header regex as `Hold'em No Limit
  *\(` (a `*` meaning zero-or-more spaces) specifically to absorb this class of anomaly, which
  corroborates it as a real, recurring GG quirk rather than a one-off transcription artifact.
- **Blind levels use thousands-separator commas** once stakes get large: `Level18(1,250/2,500)`,
  `Level10 (1,000/2,000)`.
- **Tournament names can contain colons, dollar signs, commas, and bracketed clauses**, making them
  fundamentally undelimitable by any single punctuation character: `Tournament #9364957, WSOP #77:
  $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10
  (1,000/2,000)`. Anchor parsing on the outermost fixed tokens (`Tournament #<digits>, ` at the
  start, ` - Level<N>` near the end) rather than splitting on any punctuation that can also appear
  inside the free-text name.
- **The game-type token embedded in a tournament name is not limited to the same handful of
  strings used in cash headers**: `Omaholic Bounty $8.40 Omaha (NL postflop) - Level18(...)` uses
  `Omaha (NL postflop)`, distinct from `Omaha Pot Limit`/`PLO` used elsewhere in the very same
  corpus for what is presumably the same underlying game.

Currency: every real/secondary cash example found was USD (`$`). No non-USD currency or play-money
header example was found.

## 5. Table/seat lines, button, max seats

```
Table '<name>' <N>-max Seat #<k> is the button
Seat <n>: <name> ($<stack> in chips)      [cash]
Seat <n>: <name> (<stack> in chips)       [tournament, comma thousands-separator, no $]
```

- In-repo corpus: always `6-max`, table names always `NLHPurple<n>` (a Rush & Cash pool name — the
  same handful of names recur across different hands as players get reshuffled between tables,
  normal for a fast-fold pool).
- Secondary corpus: `6-max` for PLO/PLO-5 cash, `8-max` for every tournament file, `5-max` for
  Short Deck. **6-max is not a universal constant** — it's specific to the NLH/PLO cash formats
  seen; tournaments here were consistently 8-max, Short Deck consistently 5-max.
- Not every seat number 1..N is necessarily occupied — e.g. the run-it-thrice PLO file has seats 1,
  2, 3, 5, 6 with no seat 4 (a player busted/left; the seat is simply omitted, not shown empty).
- Tournament table names are a bare number (`Table '89'`, `Table '137'`) — no descriptive name,
  contrasting cash tables' themed pool names.

## 6. Blinds, antes, straddle, dead blinds

- `<name>: posts small blind <amt>` / `posts big blind <amt>` — universal.
- `<name>: posts missed blind <amt>` — confirmed real, in-repo and secondary (PLO too, file 22),
  confirming it's not NLH-specific. Posted **in addition to**, not instead of, the player's next
  normal blind.
- `<name>: posts the ante <amt>` — confirmed real only in secondary (tournament/Short Deck files);
  never in the in-repo cash corpus, which uses no antes. Every seat posts on its own line, all
  **before** the small/big blind lines, in an order that followed table seating from the seat after
  the button in every real example checked — not confirmed to be a deterministic rule, just an
  observation.
- `<name>: straddle <amt>` — **bare verb, no `posts`**, confirmed real, secondary only (files 19,
  24, 26). **Re-straddle/over-straddle restates the player's new cumulative total, not an
  increment**: `9e7f64d4: straddle $0.5` followed later by `9e7f64d4: straddle $15.35 and is
  all-in` in the same hand — the second number is the new total committed, not an additional
  $15.35.
- Short Deck has a **button blind** instead of a small blind: `Hero: posts button blind $0.02` —
  the button posts what would be the small blind elsewhere, and there's no separate small-blind
  seat in that hand.
- No dead-blind notation (a `(dead)` qualifier) was found anywhere in the GG corpus — contrast
  CoinPoker, which has one (see `coinpoker.md`).

## 7. Street markers

Standard: `*** HOLE CARDS ***`, `*** FLOP ***`, `*** TURN ***`, `*** RIVER ***`, `*** SHOWDOWN
***` (always no space, zero exceptions across 34 files), `*** SUMMARY ***`.

Run-it-multiple variants, confirmed real (twice: files 02/03/07; thrice: file 17):
`*** FIRST/SECOND/THIRD FLOP/TURN/RIVER/SHOWDOWN ***`. Which of `FLOP`/`TURN`/`RIVER` actually gets
duplicated depends on which street the all-in happened on — see the note under §3.5. The number of
`*** <ORDINAL> SHOWDOWN ***` blocks always matches "Hand was run N times" in the summary, and each
is followed by one or more `<name> collected <amt> from pot` lines (more than one indicates a side
pot — see §9).

A `*** PREFLOP ***` marker was claimed in one flagged, likely-synthetic test fixture (file 33) and
nowhere else — do not add it to a production parser's marker set without independent confirmation.

## 8. Action verbs

Universal, confirmed real: `folds`, `checks`, `calls <amt>[ and is all-in]`, `bets <amt>[ and is
all-in]`, `raises <amt> to <amt>[ and is all-in]`, `shows [<cards>][ (<description>)]`. No `mucks`
verb was observed anywhere — a player who doesn't show simply has no `shows` line at all.

**GG-specific:**

- `Uncalled bet ($<amt>) returned to <name>` — universal.
- `<name> collected $<amt> from pot` (no parens around amount) — the live-action award line, always
  under a `*** SHOWDOWN ***`-family marker, **regardless of whether an actual showdown of cards
  happened** — see §13.
- `<name>: shows [<cards>]` with **no** trailing `(<description>)` — confirmed real (13 occurrences
  in-repo) exclusively when the show happens **before any community cards are dealt**. Once the
  board has at least a flop, every real `shows` line carries a description.
- **EV Cashout** (REAL, in-repo, files 04/06): `<name>: Chooses to EV Cashout` announces opting
  into GG's current all-in equity buyout; `<name>: Pays Cashout Risk ($<amt>)` fires once per
  remaining street (confirmed twice in one hand in file 06, once per street). SUMMARY gets a
  suffix: `... and won ($X) with <hand>, Cashout Risk ($Y)`.
- **All-in Insurance** (REAL secondary, file 15 — see §3.3 for full verified context):
  ```
  <name>: get an all-in insurance (premium ($a/$b/$c) for ($x/$y/$z) - (Mandatory/Main/Sub))
  <name>: pay premium of all-in insurance ($amt)
  ```
  This is a **different mechanic from EV Cashout** — different verbs, different parenthetical
  shape, and no equivalent SUMMARY suffix was observed for it. See §3.3 for what is and isn't known
  about how these two relate.
- `Cash Drop to Pot : total $<amt>` — a promotional pot-seeding line, confirmed real secondary only
  (file 13), appearing between the seat list and the blind-posting lines. Note the space before the
  colon.

## 9. SUMMARY block and rake line grammar

```
*** SUMMARY ***
Total pot <amt>[ | Rake <amt>[ | Jackpot <amt> | Bingo <amt>[ | Fortune <amt> | Tax <amt>]]]
[Hand was run <N> times]
[<ORDINAL> ]Board [<cards>]
Seat <n>: <name>[ (<position>)] <result>
```

**The rake line has four concretely observed shapes — it is not a fixed-field format:**

1. `Total pot <amt>` — **no `Rake` field at all.** Confirmed real across an entire file (28: all 59
   hands) and inside individual hands of another (15, the Insurance file, and 31).
2. `Total pot <amt> | Rake <amt>` — 2 fields.
3. `Total pot <amt> | Rake <amt> | Jackpot <amt> | Bingo <amt>` — 4 fields. Confirmed real,
   tournament (file 29) and Short Deck/PLO secondary files.
4. `Total pot <amt> | Rake <amt> | Jackpot <amt> | Bingo <amt> | Fortune <amt> | Tax <amt>` — 6
   fields. Confirmed real, exclusively in the 2026 in-repo cash corpus.

Build a parser that tolerates 0, 2, 4, or 6 trailing fields — do not assume `Rake` is always
present just because `Total pot` is, and do not assume all four extra fields travel together.

Other confirmed real facts:

- `Board [<cards>]` — **no** space padding inside the brackets, ever, in any GG file (contrast
  CoinPoker, which pads this line — see `coinpoker.md` §9).
- Run-it-multiple summaries add `Hand was run <N> times` and prefix each board with its ordinal:
  `FIRST Board [...]`, `SECOND Board [...]`. **When divergence starts after the flop, later boards
  only list the diverging cards** (e.g. `SECOND Board [5d Kh]` showing only turn+river) — a naive
  "board is always 5 cards" assumption breaks here.
- **`collected` vs `won` in the per-seat SUMMARY result**: `collected` is used when the pot was won
  with no community cards ever dealt (a pure preflop fold-out); `won` is used in every other case
  (postflop uncontested pot, or a genuine showdown-with-description). Confirmed by an exhaustive
  grep of the full 10-file in-repo corpus: every `collected (<amt>)` summary line occurs in a hand
  whose summary has no `Board [...]` line at all; every hand with a `Board [...]` line uses `won`
  for its winner(s), zero exceptions in 431 hands. Derived by induction from one corpus, not from
  GG documentation — very likely, not provably exhaustive.
- **Side pots**: no dedicated label anywhere. Only inferable from **more than one `<name> collected
  $<amt> from pot` line under the same showdown marker** (confirmed real, file 21 — two different
  players each collect a portion of the same run's pot).
- Hold'em hand-rank phrasing is consistent: `a pair of X`, `two pair, X and Y`, `three of a kind,
  X`, `a straight, X to Y`, `a flush X high`, `a full house, X full of Y`, `four of a kind, X`, `X
  high`. **PLO/PLO-5 uses a visibly different style**: capitalized and `and`-joined, e.g. `Pair of
  Kings and Pair of Jacks`, `King High Flush`, and — in the very same small secondary corpus — one
  full house rendered as `Fives Full over Nines` (using "over," matching CoinPoker's PLO-adjacent
  wording) elsewhere alongside GG's own Hold'em-style "full of" wording for a different hand's full
  house. This internal inconsistency was not resolved; treat PLO hand-description wording as
  genuinely variable, not reducible to one template.

## 10. Date/time format and timezone convention

`YYYY/MM/DD HH:MM:SS`, no timezone suffix of any kind, anywhere, in any real or secondary sample.
(Contrast CoinPoker, which always suffixes a literal `GMT`.) Not established which timezone this
actually represents.

## 11. Anonymized-player conventions

Confirmed from the in-repo corpus by direct measurement:

- Non-hero seats are replaced with a **lowercase hexadecimal id, 7 or 8 characters long** — both
  lengths measured present with no fixed width, consistent with an unpadded hex encoding of an
  underlying integer. **Do not assume a fixed-length id.**
- **Hero is always the literal string `Hero`**, in every seat/action/summary line, zero exceptions
  across 431 in-repo hands.
- **The same hex id represents the same real player across multiple hands at the same table, and
  persists across separate export files for the same table**: files 03 and 09 are both table
  `NLHPurple73`, captured about 30 minutes apart, sharing two identical opponent ids between them.
  Cross-table or cross-session id stability was not testable from this corpus (each table's id set
  was disjoint from every other table's) — unconfirmed, not assumed.
- The secondary fpdb corpus uses the same hex-id style for non-hero seats, corroborating this is a
  stable, long-standing GG convention rather than something specific to 2026.

## 12. File naming convention, hands per file, encoding

In-repo filenames: `GG<YYYYMMDD>-<HHMM> - <TableName> - <sb> - <bb> - <N>max.txt`, e.g.
`GG20260217-0405 - NLHPurple70 - 0.25 - 0.5 - 6max.txt`. The `HHMM` corresponds roughly (not
exactly) to the first hand's time; files are per-table, per-session exports containing many hands
(19-69 in this corpus) separated by exactly one blank line. Encoding: ASCII, LF line endings
(confirmed via `od -c`/`grep -c $'\r'` — zero CR bytes across the whole corpus), no BOM.

## 13. Gotchas

- **The `*** SHOWDOWN ***` block fires on every hand that reaches a resolution, not only on hands
  with an actual card showdown.** A hand where everyone folds to a single raiser on the flop still
  gets `*** SHOWDOWN ***` followed by a bare `<name> collected $<amt> from pot` line with no cards
  shown. Don't use this marker as a proxy for "cards were shown."
- **`Dealt to <name> ` has a trailing space for every non-Hero seat in the in-repo 2026 corpus,
  confirmed by byte inspection (`od -c`) and independently corroborated by two different
  third-party parsers' regexes** (`erikfastermann/poker-toolkit`'s `Dealt to {NAME} (?:\[...\])?$`
  built to make the cards group optional-with-trailing-content, and `jokerlin/gg_converter_gui`'s
  literal `Dealt to [0-9A-Za-z_]{0,}\s+` used to strip these lines). **The secondary 2020-2021 fpdb
  corpus has no such trailing space anywhere.** Whether that's a real format change GG made between
  2021 and 2026, or an artifact of how fpdb stored its regression files, is not resolved — a parser
  should tolerate both with and without the trailing space.
- **Hex anonymized ids are 7-or-8 characters, not a fixed width.** See §11.
- **The rake line's field count varies across four shapes (0/2/4/6 trailing fields), not a fixed
  6.** See §9. A parser hardcoded to split on exactly 6 `|`-separated segments will throw on most
  of the secondary corpus (tournaments, PLO, Short Deck) and even on some in-repo-adjacent cases
  (bare `Total pot` with no rake at all).
- **`collected` vs `won` in the SUMMARY is not arbitrary but is also not documented anywhere by
  GG** — see §9's induced rule. Get this wrong and a per-player win/loss reconciliation will
  silently misfire on preflop-only pots.
- **PLO/PLO-5 hand-strength descriptions use different capitalization and joining words than
  Hold'em's, and are even internally inconsistent with each other** (`full of` vs `over` for full
  houses, observed in the same small secondary corpus). Do not build one shared hand-description
  string table across game types.
- **Run-it-multiple boards after the first street only list the diverging cards**, not a full
  5-card board, in `SECOND Board`/`THIRD Board` summary lines. See §9.
- **Side pots have no explicit label** — inferred only from multiple `collected ... from pot` lines
  under one showdown marker. See §9.
- **Tournament headers have irregular internal whitespace** (a confirmed real triple-space case,
  plus inconsistent spacing before `Level` clause parentheses across multiple independent files,
  corroborated by a third-party parser's regex built to tolerate exactly this). A header regex with
  fixed single spaces will fail to match some real tournaments.
- **Tournament names are not safely delimitable by punctuation** — they can contain colons, dollar
  amounts, commas, and bracketed clauses. See §4.
- **`shows [<cards>]` omits its `(<description>)` parenthetical specifically for preflop all-in
  reveals**, and only then. See §8.
- **Antes are posted as a batch of individual per-seat lines before the blinds**, not a combined
  line; posting order was seating order from the seat after the button in every real example, but
  this is an observation, not a guaranteed rule.
- **A straddle/over-straddle line restates the player's new cumulative committed amount, not an
  incremental one.** See §6.
- **All-in Insurance and EV Cashout are two distinct, differently-worded mechanics** — do not merge
  their parsing paths on the assumption one is a rename of the other. See §3.3/§8.
- **One claimed hand-id prefix (`AF`) and one claimed street marker (`*** PREFLOP ***`) come only
  from a single flagged, likely-synthetic test fixture** that also misuses the otherwise-universal
  `#TM` = tournament rule on a plain cash hand and anonymizes players with transparently sequential
  fake ids. Do not treat either as confirmed GG grammar without independent evidence.
- **A real ClubGG header, quoted by a user in a PokerTracker forum bug report** (secondary,
  transcribed via WebFetch so exact whitespace is not guaranteed — indicative, not byte-exact),
  diverges from mainline GGPoker in several ways at once:
  ```
  Poker Hand #ring_623971570: NLH No Limit ($0.5/$1) - 2024/12/08 20:15:26
  Table 'NLH - $.50 / $1' 9-max Seat #7 is the button
  ```
  — an alphanumeric `ring_`-prefixed hand id (not the numeric-only `HD`/`RC`/`TM`/`OM`/`SD` set),
  the game-type text `NLH No Limit` instead of `Hold'em No Limit`, a stakes-descriptive table name
  instead of a themed pool name, and 9-max instead of 6-max. The forum thread's own context is a
  bug report: PokerTracker 4 rejected the import with "Unrecognized game type: nlh no limit
  ($0.5/$1)" — independent evidence that ClubGG's real export genuinely breaks parsers built only
  against mainline GGPoker text. **If ClubGG support is required, give it its own detection branch
  and its own game-type string table — do not assume it shares GGPoker's signature.**
- **Natural8 likely shares GGPoker's `#RC` grammar byte-for-byte, based on one converter tool's
  implementation, but this was never confirmed against an actual Natural8 export.** Treat "one
  parser covers the whole network" as a reasonable working assumption for Natural8 specifically,
  revisit the instant a real Natural8 sample surfaces, and do NOT extend that same assumption to
  ClubGG (see above) or BestPoker (zero evidence either way).

## 14. Sample index

| file(s) | status | demonstrates |
|---|---|---|
| `01`-`10` (in-repo) | REAL | Baseline `HD` cash grammar; EV Cashout (04, 06); run-it-twice, flop-all-in (03) and preflop-all-in (07) and plain (02); missed blind (06, 07); `collected` vs `won` split; mid-street `shows` with no description (07) |
| `11`-`12` | REAL secondary | `#SD` Short Deck: button blind, single-stake header, ante+straddle, 5-max |
| `13` | REAL secondary | `#RC` on a PLO hand; `Cash Drop to Pot` promo line |
| `14`, `35` | REAL secondary | Plain `#OM` PLO cash, `Omaha Pot Limit` wording |
| `15` | REAL secondary | **Verified real All-in Insurance hand**; bare no-Rake-field summary |
| `16`, `23` | REAL secondary | Run-it-twice on PLO/PLO-5 |
| `17` | REAL secondary | Run-it-**three**-times; PLO hand-description casing |
| `18`, `22` | REAL secondary | Missed blind on PLO/PLO-5 |
| `19`, `24`, `26` | REAL secondary | Straddle and over-straddle (bare `straddle` verb, cumulative-total restatement) |
| `21` | REAL secondary | Side pot (two collectors under one showdown marker); Jackpot fee |
| `25` | REAL secondary | Baseline PLO-5, no special mechanic |
| `27` | REAL secondary | Confirmed real triple-space tournament-header anomaly |
| `28` | REAL secondary | Entire file uses bare no-Rake-field summary shape |
| `29`, `32` | REAL secondary | `#TM`, ante batch, 8-max, KO/bounty tournaments with no bounty-award line in the text |
| `30` | REAL secondary | WSOP-branded tournament name with brackets/commas/dollar signs |
| `31` | REAL secondary | PLO tournament |
| `33`-`35` | **flagged, lower confidence** | Claimed `#AF` prefix and `*** PREFLOP ***` marker (33, unverified); `#TM` misused on a cash hand plus sequential fake ids (34, treated as synthetic); plain PLO cash (35) |

See `fixtures/samples/ggpoker/SOURCES.md` for full provenance, retrieval dates, and the exact
byte-verification method used for every file.

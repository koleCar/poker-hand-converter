# Chico network hand history format

Covers TigerGaming, BetOnline, Sportsbetting.ag — commonly-cited skins of the "Chico" poker
network (also historically branded PayNoRake, ActionPoker.com, Gear Poker). All confirmed real
samples in this research come from the `BetOnline` brand family; see §1 and
`fixtures/samples/chico/SOURCES.md` for exactly which brand strings were and were not directly
observed.

## 1. Overview & status

**Confirmed from real samples (16 files, 2011-08 through 2016-05 — see SOURCES.md):**
- Full cash and tournament header/seat/action/summary grammar, PLO and NLHE.
- Four distinct skin brand strings observed directly in header text: `BetOnline Poker`,
  `PayNoRake`, `ActionPoker.com`, `Gear Poker`. Each has small but real per-skin styling
  differences (§8, §13) even though they share one underlying grammar family.
- Play-money tables, dead-blind/late-post grammar, side-pot summary lines, in-hand chat, mid-
  hand seat join/leave events, and at least one genuine site-side data-quality bug (duplicate
  seat number within one hand).

**NOT confirmed — asserted only by parser source code, no real fixture obtained:**
- The brand strings `Tiger Gaming` and `SportsBetting.ag Poker` — **this directly touches the
  project brief's named target "TigerGaming"**. We found zero real bytes bearing either brand
  string. The claim that they share this exact grammar rests entirely on
  `fpdb_3_legacy/BetOnlineToFpdb.py`'s own regex, which lists all six brand strings (including
  these two) as interchangeable alternatives in the same position of the same pattern
  (`re_game_info`, `re_identify`, and the `skins` dict all enumerate the same six names). This is
  reasonably strong secondary evidence — it's a real, currently-maintained parser's own
  developer's claim, not a guess — but it is still unconfirmed by an actual TigerGaming/
  SportsBetting.ag hand. **Do not present this as equivalent in confidence to the brand strings
  we do have real bytes for.**
- No sample newer than 2016-05, no Stud/Razz/Draw/Badugi sample despite the parser declaring
  support for them, no PLO8 (Hi/Lo) sample.

## 2. Detection signature

Chico's header always embeds an explicit skin brand name immediately before ` Game #`:

```
^(BetOnline\sPoker|PayNoRake|ActionPoker\.com|Gear\sPoker|SportsBetting\.ag\sPoker|Tiger\sGaming)\sGame\s\#\d+
```

This is the exact `re_identify` regex from the real, currently-maintained `BetOnlineToFpdb.py`
parser. **This is the key structural fact that disambiguates Chico from both PokerStars and
WPN/ACR, which this project's brief specifically flags as a risk**: PokerStars' header is
`PokerStars Hand #...` or `PokerStars Game #...` (brand name `PokerStars`, not one of the six
Chico brand strings, and PokerStars uses `Hand #`/`Game #` — Chico always uses `Game #`, never
bare `Hand #`). WPN/ACR era C (see `acr-wpn.md`) never prints **any** brand name at all — a bare
`Hand #<id> -` or `Game Hand #<id> -`. So the disambiguation rule is simply: **if there is a
recognized brand name immediately before `Game #`, it's Chico; if the header is a bare `Hand
#`/`Game Hand #` with no brand name, it's WPN era C; anything else (a different brand name
entirely) is neither.** Secondary confirmation once "Chico-like" is suspected: the
per-seat position suffix directly on the seat-listing line itself (`Seat 8: Player0 (1.55 in
chips) - Small Blind`) — WPN/PokerStars never put position tags on the seat-listing lines, only
in the summary.

## 3. Full verbatim example hands

### Cash game (real — `fixtures/samples/chico/fpdb3-regression-corpus/cash__NLHE-10max-0.25-0.50-201204.post.dead.txt`)

```
BetOnline Poker Game #1002134798: Hold'em No Limit ($0.25/0.50) - 2012/04/11 01:59:39 GMT Daylight Time
Table 'Blade Runner' 10-Max, Seat #5 is the button
Seat 4: Player9 (43.42 in chips)
Seat 8: Player6 (56.54 in chips)
Seat 5: Player3 (126.09 in chips) - The button
Seat 9: Player4 (332.23 in chips)
Seat 2: Player8 (41.05 in chips)
Seat 6: Player1 (60.12 in chips) - Small Blind
Seat 0: Player2 (39.79 in chips)
Seat 1: Player7 (17.50 in chips)
Seat 3: Player0 (38.63 in chips)
Seat 7: Player5 (48.25 in chips) - Big Blind
Player1: posts small blind 0.25
Player5: posts big blind 0.50
Player0: post dead 0.50
*** HOLE CARDS ***
Dealt to Player6 [2h 3c]
Player6: folds
Player4: folds
Player2: folds
Player7: folds
Player8: folds
Player0: checks
Player9: raises 1.50 to 1.50
Player3: folds
Player1: calls 1.25
Player5: calls 1.00
Player0: calls 1.00
*** FLOP *** [6c 7s Qc]
Player1: checks
Player5: bets 4.68
Player0: calls 4.68
Player9: folds
Player1: folds
*** TURN *** [6c 7s Qc][10d]
Player5: bets 11.12
Player0: folds
Uncalled bet (11.12) returned to Player5
*** SUMMARY ***
Total pot 14.83 | Rake 0.78
Board [6c 7s Qc 10d]
Seat 4: Player9 folded on the Flop
Seat 8: Player6 folded before Flop
Seat 5: Player3 folded before Flop
Seat 9: Player4 folded before Flop
Seat 2: Player8 folded before Flop
Seat 6: Player1 folded on the Flop
Seat 0: Player2 folded before Flop
Seat 1: Player7 folded before Flop
Seat 3: Player0 folded on the Turn
Seat 7: Player5 collected (14.83)
```

### Tournament (real — `fixtures/samples/chico/fpdb3-regression-corpus/tour__NLHE-10max-USD-MTT-201603.two.players.one.seat.txt`)

```
BetOnline Poker Game #1587454316: Tournament #7212650: Hold'em $10.00/$20.00 - 2016/03/21 16:48:06 Eastern Daylight Time
Table '7212650-076' 10-Max, Seat #3 is the button
Seat 9: Player0 (1425.00 in chips)
Seat 8: Player1 (755.00 in chips)
Seat 7: Player2 (2642.50 in chips) - Big Blind
Seat 6: Player3 (1455.00 in chips)
Seat 5: Player4 (1495.00 in chips) - Small Blind
Seat 1: Player5 (10172.50 in chips)
Seat 0: Player6 (765.00 in chips)
Seat 2: Player7 (775.00 in chips)
Seat 4: Player8 (800.00 in chips)
Seat 5: Player9 (1495.00 in chips) - Small Blind
Player0: ante processed 0.00
Player1: ante processed 0.00
Player8: posts small blind 30.00
Player4: posts big blind 60.00
*** HOLE CARDS ***
Dealt to Player9 [5h Qs]
Player3: folds
Player10 joins the table at seat #3
Player2: raises 120.00 to 120.00
Player5: calls 120.00
*** FLOP *** [3h 4h 2c]
Player2: bets 2522.50
Player5: calls 2522.50
*** SHOW DOWN ***
Player2 shows Jc Jd
Player5 shows 4s 5s
*** SUMMARY ***
Total pot 5375.00
Board [3h 4h 2c 3s Jh]
Seat 7: Player2 showed [Jc Jd] and won (5375.00)
Seat 1: Player5 showed [4s 5s] but did not win
```
(Note the duplicate seat 5 — `Player4` and `Player9` are both listed at `Seat 5` in the same
hand. This is a genuine data-quality defect present in the real source file, not a copy error —
kept verbatim, filename literally flags it. A parser must not assume seat numbers are unique
within a hand on this network.)

## 4. Header grammar

**Cash:**
```
<Brand> Game #<id>: <Game>[ <Limit>] [(<cur><sb>/<bb>)] - <date> <timezone>
```
- `<Brand>` confirmed values: `BetOnline Poker`, `PayNoRake`, `ActionPoker.com`, `Gear Poker`.
  `SportsBetting.ag Poker` and `Tiger Gaming` unconfirmed (§1).
- `<Game>` confirmed: `Hold'em` (bare, no limit suffix — Gear Poker sample) and `Hold'em No
  Limit`/`Hold'em Pot Limit` (with limit suffix and parenthesized stakes — BetOnline/PayNoRake
  samples). A parser cannot assume the limit-type and stakes clause is always present.
- Date/time format varies by era/skin: `2012/04/11 01:59:39 GMT Daylight Time` (full timezone
  name, with seconds), `2012/06/07 08:58 GMT Standard Time` (full timezone name, **no seconds**
  — confirmed in the PayNoRake sample), `2016/04/05 08:08:59 Eastern Daylight Time` (full
  timezone name, with seconds), `2012-04-03 02:10:06` (ISO-ish dashes, **no timezone at all** —
  confirmed in the Gear Poker/ActionPoker samples). At least four distinct date/timezone shapes
  confirmed across only 16 files — do not assume a single date format.
- Play-money cash tables: `Table <name> (Play Money) Seat #<n> is the button` — same overall
  shape as real-money, `(Play Money)` literal replacing the real-money seat/limit info; table
  name has **no quotes** in the one play-money sample obtained (contrast real-money's quoted
  table name, see §5) — unconfirmed whether that's because it's play money or because it's the
  Gear Poker skin specifically; only one sample exists so this can't be disambiguated further.

**Tournament:**
```
<Brand> Game #<id>: Tournament #<tourno>: <Game> <sb>/<bb> - <date> <timezone>
```
- Note the **second colon**, after `Tournament #<tourno>`, before the game name.
- Blinds for the tournament-level display have **no currency symbol and no parentheses**
  (`Hold'em $10.00/$20.00` uses a `$` prefix on the first number only in one sample, but
  `Hold'em 10/20`-shaped plain numbers were also seen — inconsistent, don't assume a fixed
  currency-symbol placement here).
- At least one real file (`tour__...2011-08.nobuyinfee.txt`) begins with a non-hand lobby
  message, `Tournament will start in a moment.`, before the first real hand header — a splitter
  must be able to discard this.

## 5. Table/seat lines, button, max seats

```
Table '<name>' <N>-Max, Seat #<n> is the button
Seat <n>: <player> (<amt> in chips|in Chips)[ - <position/status>]
```
- `<N>-Max` — capital `M`, and every confirmed real-money sample in this corpus is **10-Max**
  (this network appears to default to full-ring 10-max tables; no 6-max/heads-up sample was
  found here, unlike the other three sites in this project which all had smaller-table samples).
- A **comma** follows `<N>-Max` before `Seat #<n> is the button` — a small but real
  disambiguator versus WPN/PokerStars, which have no comma there.
- Per-skin capitalization differs: BetOnline/PayNoRake/GearPoker use lowercase `in chips`;
  ActionPoker.com uses `in Chips` (capital C) — confirmed directly from fixture text.
- **Position tags appear directly on the seat-listing line itself**, appended with ` - `:
  `- Small Blind`, `- Big Blind`, `- The button`, `- Sitting out`. This is the single most
  useful structural signature distinguishing this network's seat block from WPN/PokerStars,
  which never annotate position on the seat-listing line (only in the summary block). Confirmed
  absent specifically in the ActionPoker.com sample — that skin only reports position later, in
  the summary, as a parenthetical (`(Small Blind)`) — so this convention is not universal across
  every skin, only confirmed for BetOnline/PayNoRake/GearPoker-family output.
- Seat numbers are **not guaranteed unique within a hand** — see the "two players, one seat"
  fixture (§3). A parser must not build a seat→player map assuming 1:1 uniqueness without a
  defensive check.

## 6. Blinds, antes, straddle, dead blinds, post-to-enter

Confirmed verbatim (cash, BetOnline/PayNoRake family):
```
<name>: posts small blind <amt>
<name>: posts big blind <amt>
<name>: post dead <amt>
<name>: post now <amt>
```
`post now` (no "small"/"big blind"/"dead" qualifier at all) is the catch-up post for a player
joining or returning mid-orbit — confirmed real, distinct verb from a normal blind post. No
straddle sample was found anywhere in this corpus; unconfirmed whether/how this network
supports it.

### `post dead` under-reports by exactly one small blind

**This is the one place in the Chico format where the text does not state a real chip movement,
and it has to be inferred.** A returning player's entry fee is the ordinary "big blind live,
small blind dead" pair, but **only the live half is written down**. The dead small blind is
silently added to the pot.

Confirmed on both `post dead` hands in the corpus, independently, both at $0.25/$0.50:

| hand | printed | contributions sum to | printed pot + rake | shortfall |
|---|---|---|---|---|
| `cash__NLHE-10max-0.25-0.50-201204.post.dead.txt` #1002134798 | `Player0: post dead 0.50` | 15.36 | 14.83 + 0.78 = **15.61** | **0.25** |
| `cash__NLHE-10max-USD-0.25-0.05-201108.txt` #900203618 | `Player5: post dead 0.00` | 44.99 | 42.98 + 2.26 = **45.24** | **0.25** |

In both, the shortfall is exactly one small blind (0.25 at these stakes), and adding a dead
small blind back makes the derived gross pot match the printed `Total pot + Rake` exactly.

Note the second case in particular: the printed amount is `post dead 0.00`, yet 0.25 still
entered the pot. So the printed number is **not** the total posted and cannot be used as one —
even a zero there does not mean nothing was posted.

**How to handle it, and why the inference is safe.** Add one small blind to the pot for every
`post dead` line, on top of the printed amount. This is the single inference the shipped Chico
parser makes, and it is self-policing: the printed `Rake` gives an independent check, so if the
assumption were wrong the derived rake would stop matching the printed rake — hand by hand, on
every `post dead` hand, not just in aggregate. It currently matches exactly in both (0.78 and
2.26).

**Confidence: high but not absolute.** The mechanic is the standard dead-blind rule and the
arithmetic closes in both available hands, but *two* hands at *one* stake level is a thin base.
If a `post dead` hand at different stakes ever fails the rake check, this is the first assumption
to revisit. Documented nowhere in vendor material — derived from the bytes.

Confirmed verbatim (tournament):
```
<name>: ante processed <amt>
```
A zero-value ante (`ante processed 0.00`) is printed explicitly rather than omitted — confirmed
in the "zero.ante" fixture.

ActionPoker.com skin variant (Title Case, trailing periods):
```
Player0: Posts small blind 1.00.
Player9: Posts big blind 2.00.
```

## 7. Street markers (verbatim, confirmed)

```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx][Xx]
*** RIVER *** [Xx Xx Xx][Xx][Xx]
*** SHOW DOWN ***
*** SUMMARY ***
```
No colon after the stars (contrast WPN era A/B). **Turn/river brackets have no space between
them** in the BetOnline-family samples — `[6c 7s Qc][10d]`, not `[6c 7s Qc] [10d]` — a real,
easy-to-miss detail if reusing a WPN- or PokerStars-shaped regex that expects a space there.
ActionPoker.com, by contrast, **does** use a space: `[10S 6D 7S] [6C]` — yet another confirmed
per-skin styling difference within the same network.

## 8. Action verbs — exact phrasing, including per-skin variants

BetOnline/PayNoRake/GearPoker family (lowercase, colon after name, no trailing period):
`<name>: folds`, `checks`, `calls <amt>`, `bets <amt>`, `raises <delta> to <total>`. All-in
suffix is ` and is all in` — **space, not a hyphen** (contrast every other site in this project,
which all hyphenate "all-in"). Showdown **inline action line has no card brackets and
space-separated ranks/suits**: `Player2 shows Jc Jd` (2-card) / `Player6 shows As 4d 6d Ad`
(4-card PLO) — but the **later SUMMARY line for the identical event does use brackets**:
`Seat 7: Player2 showed [Jc Jd] and won (5375.00)`. This inconsistency is real and confirmed by
direct fixture inspection, not a hypothesis — a parser must handle the bracket-less inline form
and the bracketed summary form as two different regexes for what is semantically the same
information.

**A confirmed, non-obvious formatting quirk**: the first raise of a betting round sometimes
prints the identical number twice — `Player2: raises 120.00 to 120.00`, `Player2: raises 0.75
to 0.75` — where a normal raise shows a real delta (`raises 3.35 to 3.45`). This is present in
real fixture bytes across two unrelated hands in two different files, so it is a genuine quirk
of this network's own export (likely: the "raise delta" field is computed incorrectly by the
site itself for a player's first raise action after only blinds have been posted), not a copy
artifact. Do not "fix" or normalize it away — preserve and handle both shapes.

ActionPoker.com skin variant (Title Case verbs, trailing period on every line):
`Player8: Folds.`, `Player5: Calls 2.00.`, `Player9: Checks.`, `Player0: Calls 1.00.`.

Special sentinel name: the literal string `Unknown player` can appear in place of a real seat
name when the site itself could not attribute an action (`Unknown player: raises 15.75 to
18.75 and is all in`) — confirmed real, must be treated as a valid-but-unidentified actor rather
than crashing a name lookup.

Uncalled bet: `Uncalled bet (<amt>) returned to <name>` — same shape as WPN/PokerStars.

Mid-hand table events, interleaved directly into the action stream with no special delimiter,
confirmed real: `<name> joins the table at seat #<n>`, `<name> has left the table`, and in-hand
chat `<name> said "<free text>"` (the chat text can itself contain commas, ellipses, and
poker-notation-looking substrings — do not try to parse it as an action).

## 9. SUMMARY / pot / rake line layout

```
*** SUMMARY ***
Total pot <amt> | Rake <amt>
[Total pot <amt> | Rake <amt>]...   <- can repeat, once per side pot component
Board [<cards>]
Seat <n>: <name>[ showed [<cards>] and (won|lost)( <amt>)?| collected (<amt>)|folded (before|on the) <Street>( and did not bet)?]
```
- `Board` has **no colon** (contrast Winamax and WPN era A/B; matches WPN era C and PokerStars).
- **Multiple `Total pot | Rake` lines can appear per hand, and one of them can appear BEFORE the
  `*** SUMMARY ***` marker**, not inside the block. Do not assume they are all in the summary.
- **There is no rule — first, last, or sum — that recovers the hand's grand total from these
  lines. Do not try.** An earlier revision of this document claimed the last line is the grand
  total. **That claim was wrong, and wrong in both directions.** It is corrected here rather than
  softened, because a stated rule that fails both ways is worse than no rule. Measured across the
  whole corpus (40 multi-line hands), three distinct patterns occur:

  | pattern | hands | what the lines mean |
  |---|---|---|
  | **identical line printed twice** | 30 | Pure duplication, 2011-era files. `Total pot 0.95 \| Rake 0.05` appears verbatim twice, two lines apart. **Summing double-counts the pot.** |
  | **two distinct lines** | 8 | Genuine pot components — but ordered **side pot first, main pot last**. **Taking the last under-reports.** |
  | **four distinct lines, differing rakes** | 1 | Arithmetic does not close at all; see below. |

  Worked example of the two-line case, `cash__NLHE-10max-USD-0.01-0.02-201605.winner.no.show.txt`,
  verified by hand:

  ```
  Total pot 0.42 | Rake 0.04      <- BEFORE *** SUMMARY ***; this is the SIDE pot
  *** SUMMARY ***
  Total pot 0.29 | Rake 0.04      <- this is the MAIN pot
  ...
  Seat 0: Player2 collected (0.42)
  Seat 4: Player4 showed [Kh Kc] and won (0.29)
  ```

  Contributions sum to 0.75 gross; 0.75 − 0.04 rake = 0.71 distributed = 0.42 + 0.29. Player4 was
  all-in for 0.07, so the main pot he is eligible for is the smaller 0.29 and it is printed
  **last**. Taking the last line as the grand total reports 0.29 for a 0.71 pot.

- **The `Rake` value is the hand's total rake, repeated identically on every line** — it is not
  per-pot. True in 39 of 40 multi-line hands. This is what makes the practical rule below work.

- **Practical rule, and what the shipped parser does:** read **only the rake** from these lines,
  and reconcile the pot itself from the action lines plus the per-seat `collected (x)` /
  `won (x)` amounts. Those are internally consistent where the `Total pot` lines are not.

- **The one hand where nothing closes.** In `cash__PLO-10max-USD-0.05-0.10-201209.txt`, hand
  `#1073059444` prints four lines with *differing* rakes
  (`6.91|1.35`, `3.95|1.10`, `10.30|0.60`, `11.55|0.60`), yet the summary lists exactly one
  winner (`Player2 ... won (11.55)`) and marks every other shown hand "but did not win".
  Contributions sum to 34.41, the four printed pots sum to 32.71, and the rakes sum to 3.65 —
  none of which reconcile. **This hand is self-inconsistent source data, not a format variant to
  model.** Treat it as corrupt and skip it; do not derive a four-pot grammar from it.
- Folded-preflop wording is `folded before Flop` (no "the"); folded-postflop wording is
  `folded on the Flop`/`Turn`/`River` (with "the") — the asymmetry (before X vs. on the X) is
  real, confirmed, and easy to miss if writing one regex for both cases.
- ActionPoker.com skin variant: `Folded on the Turn` (capital F), `Is Sitting Out` (own summary
  line, Title Case, not seen as a seat-line suffix on this skin).

## 10. Date/time format and timezone convention

At least four distinct shapes confirmed (see §4): `YYYY/MM/DD HH:MM:SS <Full Timezone Name>`,
`YYYY/MM/DD HH:MM <Full Timezone Name>` (no seconds), and `YYYY-MM-DD HH:MM:SS` (no timezone at
all). Confirmed timezone strings: `GMT Daylight Time`, `GMT Standard Time`,
`Eastern Daylight Time`. No abbreviation form (`EDT`/`GMT`) was found in any real fixture in
this corpus, despite that being a common abbreviation elsewhere — always full names here.

## 11. Anonymized-player conventions

**The site itself does not anonymize players** — every confirmed real fixture uses ordinary
persistent screen names for both hero and villains, with hero identified only via the
`Dealt to <name> [<cards>]` line (same mechanism as Winamax and WPN), no dedicated hero marker
on the seat line. The `Player0`, `Player1`, … names visible in this fixture set are an artifact
of fpdb-3's own regression-fixture sanitization (see SOURCES.md caveat) — do not treat them as
representative of what a real hand history's player-name field looks like; treat only their
*position and grammar* as representative.

## 12. File naming, hands per file, encoding + line endings

- No canonical real file-naming convention was recoverable (fpdb-3's fixture names encode its
  own test taxonomy). All files obtained are plain ASCII/UTF-8-compatible text with standard LF
  line endings (verified with `file`); no BOM, no UTF-16 variant found for this network in this
  corpus (contrast WPN, which has both).
- Multi-hand files are separated by triple-blank-line runs in the parser's own splitting regex
  (`re_split_hands = re.compile("\n\n\n+")`) — i.e. **at least 3 consecutive newlines**, not 1 —
  confirmed by reading the parser source; the individual per-hand fixtures in this corpus are
  mostly single-hand so this wasn't independently re-confirmed byte-for-byte against a real
  multi-hand file, but is asserted with reasonably high confidence given it's read directly from
  the live regex, not inferred.

## 13. Gotchas

1. Brand name is mandatory and load-bearing for site detection — always match it, never assume
   "Chico" from structure alone, since WPN era C is structurally similar (no colon on street
   markers, no colon on `Board`) but has no brand name at all.
2. Two of the six skins this parser (and this project's brief) name — `Tiger Gaming` and
   `SportsBetting.ag Poker` — are unconfirmed by any real byte in this research pass. Treat
   their exact grammar as "very likely, not verified."
3. Per-skin styling genuinely differs (case, trailing periods, space-vs-no-space in turn/river
   brackets, presence/absence of per-seat position tags) even within one network — do not write
   one regex assuming BetOnline's exact styling covers ActionPoker.com or Gear Poker too; each
   confirmed skin in this doc has at least one concrete divergence.
4. Showdown "shows" has brackets in the summary but not in the inline action line — two
   different regexes needed for the same semantic event.
5. The first raise of a betting round can show an identical number for delta and total
   (`raises 120.00 to 120.00`) — a real site quirk, not noise; do not discard or "fix" it.
6. **Multiple `Total pot | Rake` lines per hand, with no rule that recovers the grand total.**
   One can appear *before* `*** SUMMARY ***`. In 2011-era files the identical line is printed
   twice (summing double-counts); in side-pot hands the two distinct lines are ordered **side pot
   first, main pot last** (taking the last under-reports). Read only the **rake** from these
   lines — it is the hand total, repeated — and reconcile the pot from the action lines and the
   per-seat `collected`/`won` amounts. Full evidence in §9. *An earlier revision of this document
   said "only the last is authoritative"; that was wrong in both directions.*
7. **A Chico header can lie about the game variant.** All 17 hands in
   `cash__PLO-10max-USD-0.05-0.10-201209.txt` are headed `Hold'em Pot Limit` and every one deals
   **four** hole cards (`Dealt to Hero [3s Jd 8s 4d]`). Verified: 17/17 headers say Hold'em,
   17/17 deal four cards. A parser that trusts the header label silently converts 17 Omaha hands
   as Hold'em, which corrupts every derived hand strength downstream. **Derive the variant from
   the dealt-card count, not from the header token**, and treat a disagreement between the two as
   a reason to trust the cards. (Upstream fpdb-3 evidently knows this too — it files the fixture
   under `PLO-` despite the header.)
8. Seat numbers are not guaranteed unique within a single hand (confirmed real defect) — do not
   build a seat-indexed map without a collision check.
9. `Unknown player` is a real, valid sentinel actor name, not an error to reject.
10. In-hand chat lines (`<name> said "..."`) and table join/leave events
   (`<name> joins the table at seat #<n>`, `<name> has left the table`) are interleaved directly
   into the action stream with no delimiter — a naive "every line matches one of these five verb
   patterns" parser will throw on these unless it explicitly recognizes and skips them.
11. At least one file begins with non-hand lobby text (`Tournament will start in a moment.`) —
    a splitter must tolerate leading noise before the first real header.
12. Date/timezone format is not stable even within the BetOnline brand itself across 2011-2016
    (four distinct shapes confirmed) — do not hardcode one date-parsing pattern.
13. Play-money and real-money table lines differ in whether the table name is quoted — only one
    play-money sample exists, so don't over-generalize, but do handle unquoted table names.
14. **`post dead` silently omits a dead small blind.** The printed amount is not the total
    posted — even `post dead 0.00` still moves 0.25 into the pot at 0.25/0.50. Add one small
    blind per `post dead` line; the printed `Rake` validates the inference hand by hand. See §6.

## 14. Sample index

See `fixtures/samples/chico/SOURCES.md` for the full file-by-file table (16 files, all REAL,
2011-08 to 2016-05, cash and tournament, NLHE and PLO).

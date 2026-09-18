# Full Tilt Poker — hand history format

## 1. Overview & status

Full Tilt Poker (FTP) operated as a standalone client from 2004, was seized/
shut down after Black Friday (2011), relaunched under new ownership in
late 2012, and was folded into PokerStars/Amaya's infrastructure and finally
shut down as a standalone client in 2016 (its games moved into the
PokerStars client as a "Full Tilt" tab, later removed entirely). **No live
site exists.** All evidence here is a mix of REAL cash-game hand text and
parser source code, both confirmed. There is **no tournament sample** in
this research — see §14 and §13 (Gotchas). Do not treat the tournament
grammar sketched informally in §3 as confirmed; it is not.

- Cash-game text hand-history format: **CONFIRMED from real samples** (50
  hands mined from a pre-existing test corpus, see fixtures).
- Tournament text hand-history format: **existed** (FTP definitely produced
  tournament hand histories historically — FTOPS/SCOOP-era forum threads
  reference "Level" and tournament IDs in FTP-style hands), but **no
  real sample was recovered** in this research, and the reference parser
  used as secondary evidence (`FullTiltPokerFastParserImpl.cs`) explicitly
  throws `NotImplementedException` for `ParseTournamentId` / `ParseBuyin` —
  i.e. even that library never implemented FTP tournament parsing. Treat FTP
  tournament grammar as **unconfirmed**.

## 2. Detection signature

```
^Full Tilt Poker Game #\d+:
```

Concretely, line 1 of every hand always starts with `Full Tilt Poker Game #`
followed by a numeric hand ID and a colon. This is unambiguous and appears in
100% of the corpus (50/50 real samples).

## 3. Full verbatim example hands

### Cash — minimal heads-up NLHE (`fixtures/samples/full-tilt/01-cash-nlhe-headsup-basic.txt`)

```
Full Tilt Poker Game #33727950903: Table Goldring (heads up) - NL Hold'em - $5/$10 - 21:11:15 ET - 2014/01/05
Seat 1: Rene Lacoste ($1,000)
Seat 2: ElkY ($1,044.50)
Rene Lacoste posts the small blind of $5
ElkY posts the big blind of $10
The button is in seat #1
*** HOLE CARDS ***
Rene Lacoste raises to $20
ElkY calls $10
*** FLOP *** [3s 6d 8h] (Total Pot: $40, 2 Players)
ElkY checks
Rene Lacoste bets $20
ElkY folds
Uncalled bet of $20 returned to Rene Lacoste
Rene Lacoste mucks
Rene Lacoste wins the pot ($39.50)
*** SUMMARY ***
Total pot $40 | Rake $0.50
Board: [3s 6d 8h]
Seat 1: Rene Lacoste (small blind) collected ($39.50), mucked
Seat 2: ElkY (big blind) folded on the Flop
```
(File ends without a trailing newline, byte-exact, UTF-8 BOM at the start —
see §12.)

### Cash — Run It Twice (`fixtures/samples/full-tilt/02-cash-nlhe-cap-run-it-twice.txt`)

Excerpt (full file is the fixture):
```
Full Tilt Poker Game #35456787343: Table Myron (6 max) - CAP NL Hold'em - $5/$10 - 04:44:44 ET - 2015/04/08
...
*** TURN *** [Td 3d 3h] [Qh] (Total Pot: $145, 2 Players)
1mperial checks
Darkking_pt bets $72.50
1mperial has 15 seconds left to act
1mperial raises to $240, and is capped
Darkking_pt calls $167.50, and is capped
Players agree to Run It Twice
1mperial shows [Jd Qd]
Darkking_pt shows [6d Ad]
*** RIVER 1 *** [Td 3d 3h Qh] [Ac] (Total Pot: $625, 2 Players, 2 All-In)
*** RIVER 2 *** [Td 3d 3h Qh] [2h] (Total Pot: $625, 2 Players, 2 All-In)
*** SHOW DOWN 1 ***
1mperial shows two pair, Queens and Threes
Darkking_pt shows two pair, Aces and Threes
*** SHOW DOWN 2 ***
1mperial shows two pair, Queens and Threes
Darkking_pt shows a pair of Threes
Darkking_pt wins pot 1 ($311) with two pair, Aces and Threes
1mperial wins pot 2 ($311) with two pair, Queens and Threes
*** SUMMARY ***
Total pot $625 | Rake $3
*** SUMMARY 1 ***
Pot 1 $311
Board: [Td 3d 3h Qh Ac]
...
*** SUMMARY 2 ***
Pot 2 $311
Board: [Td 3d 3h Qh 2h]
...
```

No tournament example available (see §1).

## 4. Header grammar

Two header word orders exist across the corpus (dates observed 2011 vs
2014, both REAL):

**"New" order** (2014 samples, the majority of the corpus):
```
Full Tilt Poker Game #<handid>: Table <name>[ (<seatdesc>)] - <gametype> - <sb>/<bb>[ Ante <ante>] - <hh:mm:ss> ET - <yyyy/mm/dd>
```
Example: `Full Tilt Poker Game #33728803548: Table Crane (6 max) - CAP NL Hold'em - $0.05/$0.10 - 05:11:48 ET - 2014/01/06`

**"Old" order** (`fixtures/samples/full-tilt/06-cash-cap-nlhe-old-header-format-2011.txt`, dated 2011):
```
Full Tilt Poker Game #<handid>: Table <name>[ (<seatdesc>)] - <sb>/<bb> - <cap$> Cap No Limit Hold'em - <hh:mm:ss> ET - <yyyy/mm/dd>
```
Example: `Full Tilt Poker Game #28617512574: Table Bri (6 max) - $0.25/$0.50 - $15 Cap No Limit Hold'em - 18:46:08 ET - 2011/02/28`

The reference parser (`FullTiltPokerFastParserImpl.cs`, `ParseGameType`/
`ParseLimit`) explicitly branches on `splitter[2].Contains("/")` to
distinguish the two orders — this is real, dated evidence the header format
changed at some point between 2011 and 2014, not a hypothetical.

`<seatdesc>` is one of: absent (full ring / 9-max), `heads up`, `6 max`,
`6 max, shallow`, `New to the Game`, `New to the Game, 6 max` (all observed
in the corpus).

`<gametype>` values observed (verbatim, with surrounding spaces significant
per the parser's `switch`): ` NL Hold'em `, ` CAP NL Hold'em `, ` FL Hold'em `,
` PL Hold'em `, ` PL Omaha Hi `, ` FL Omaha H/L `, ` NL Omaha H/L `.
(`Cap Pot Limit Omaha Hi/H-L` and plain `Pot Limit Omaha`/`Omaha H/L` variants
are referenced in the parser's switch statement but not present in the local
corpus — secondary evidence only.)

One fixture (`10-cash-nlhe-dealt-to-hero-dual-timezone-anonymized.txt`, names
anonymized, treat with caution — see its SOURCES.md entry) shows a dual-timezone
header suffix: `12:52:55 CET - 2013/01/01 [12:52:55 ET - 2013/01/01]`. This
shape is not corroborated by any other fixture in the corpus; flagged as
low-confidence.

Currency symbols seen in the parser's `switch` (secondary evidence, not all
present in local fixtures): `$` (USD), `€`, `£`.

## 5. Table/seat lines

```
Seat <n>: <name> (<$stack>)[, is sitting out]
```
Seat numbering is sparse — not all seats 1..maxseats are necessarily present
(e.g. a 6-max table may only list seats 5, 6, 7 if that's who's seated —
see `08-cash-flo8-fixed-limit-omaha-hilo.txt`). Names can contain spaces
(`Rene Lacoste`, `Da Poker Pirate`, `El Viejo Tico`). No explicit seat-count
field in the header for full-ring games (absence of a `(...)` block after the
table name means 9-max, per the parser).

## 6. Blinds/antes/straddle

```
<name> antes $<amount>
<name> posts the small blind of $<amount>
<name> posts the big blind of $<amount>
<name> posts a dead small blind of $<amount>
<name> posts $<amount>                          (generic post, e.g. re-entering the table)
The button is in seat #<n>
```
Note the **button line comes after** the blind-posting lines, not before —
confirmed in every fixture. No straddle syntax observed or referenced in the
parser.

## 7. Street markers (exact spelling)

```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx] (Total Pot: $<n>, <k> Players[, <j> All-In])
*** TURN *** [Xx Xx Xx] [Xx] (Total Pot: $<n>, <k> Players[, <j> All-In])
*** RIVER *** [Xx Xx Xx Xx] [Xx] (Total Pot: $<n>, <k> Players[, <j> All-In])
*** SHOW DOWN ***
*** SUMMARY ***
```
Run-it-twice variant: `*** RIVER 1 ***` / `*** RIVER 2 ***`,
`*** SHOW DOWN 1 ***` / `*** SHOW DOWN 2 ***`,
`*** SUMMARY ***` (aggregate) followed by `*** SUMMARY 1 ***` / `*** SUMMARY 2 ***`.

## 8. Action verbs (exact phrasing)

| Action | Exact text |
|---|---|
| Fold | `<name> folds` |
| Check | `<name> checks` |
| Bet | `<name> bets $<amount>` |
| Call | `<name> calls $<amount>` |
| Raise | `<name> raises to $<amount>` |
| All-in (call/bet/raise suffix) | `..., and is all in` (note: **no hyphen**, "all in" not "all-in") |
| Capped (cap-game max) | `..., and is capped` |
| Uncalled bet return | `Uncalled bet of $<amount> returned to <name>` |
| Ante returned (edge case) | `Ante of $<amount> returned to <name>` |
| Mucks | `<name> mucks` |
| Shows | `<name> shows [Xx Xx]` |
| Wins (single winner) | `<name> wins the pot ($<amount>)` |
| Wins (run-it-twice, pot N) | `<name> wins pot <n> ($<amount>)` |
| Wins hi/lo split | `<name> wins the high pot ($<amount>)` / `<name> wins the low pot ($<amount>)` |
| Collected (summary line) | `Seat <n>: <name>[...] collected ($<amount>)[, mucked]` |
| Sits out | `<name> is sitting out` (seat listing) |
| Stands up | `<name> stands up` |
| Sits down | `<name> sits down` |
| Rebuy/top-up | `<name> adds $<amount>` |
| Disconnected | `<name> has been disconnected` |
| Reconnected | `<name> has reconnected` |
| Timeout | `<name> has timed out` |
| Time bank warning | `<name> has 15 seconds left to act` |
| Chat line | `<name>: <arbitrary text>` (only distinguishable from action lines by the ": " and by not matching the `*** ... ***` shape — see parser's `IsChatLine`) |
| Cancelled hand | `Hand #<handid> has been canceled` (referenced in parser source, no real sample recovered locally — see Gotchas) |

Run It Twice trigger phrase: `Players agree to Run It Twice`.

Showdown descriptions embed hand-rank English text directly, e.g.
`<name> shows two pair, Queens and Threes`,
`<name> shows Ace King high, for high and 6,5,4,2,A, for low` (Omaha Hi/Lo).

## 9. SUMMARY/pot/rake layout

```
*** SUMMARY ***
Total pot $<amount> | Rake $<amount>
Board: [Xx Xx Xx Xx Xx]            (omitted entirely if hand ended preflop)
Seat <n>: <name>[ (button|small blind|big blind)] <outcome>
```
`<outcome>` variants observed: `collected ($<amt>)[, mucked]`,
`folded before the Flop`, `folded on the Flop|Turn|River`,
`didn't bet (folded)`, `is sitting out`,
`showed [Xx Xx] and won ($<amt>) with <hand description>`,
`showed [Xx Xx] and lost with <hand description>`,
`mucked`.

Run-it-twice hands additionally emit `*** SUMMARY 1 ***` / `*** SUMMARY 2 ***`
blocks, each with its own `Pot <n> $<amount>` line and `Board:` line, after
the aggregate `*** SUMMARY ***` block.

## 10. Date/time format + timezone

`<hh:mm:ss> ET - <yyyy/mm/dd>` in the header — **always US Eastern
Time** (the reference parser hard-codes `TimeZoneInfo.FindSystemTimeZoneById
("Eastern Standard Time")` regardless of daylight saving, i.e. treat "ET" as
a fixed offset label rather than assuming it flips between EST/EDT — verify
against wall-clock behavior before relying on this for exact UTC conversion).
One low-confidence fixture shows an alternate dual-zone suffix (see §4);
not corroborated elsewhere.

## 11. Anonymized-player conventions

None observed in the real corpus — genuine screen names appear throughout
(`ElkY`, `jobetzu`, `theking881`, etc.), including apparently real full names
with spaces. The one fixture using `Opponent1..5`/`FT_Hero` placeholders is
flagged in its own SOURCES.md entry as likely anonymized by the party that
built the historical test corpus, not a Full Tilt platform convention.

## 12. File naming + export directory + hands per file + encoding/line endings

- Encoding: **UTF-8 with BOM** (`EF BB BF` at file start) in every fixture
  checked.
- Line endings: LF (`\n`) only — verified via `xxd`, no `\r`.
- Multi-hand files: hands are concatenated with **two blank lines** between
  them (confirmed via `05-cash-nlhe-multi-hand-file.txt`), no per-hand
  header/footer markers beyond the normal `Full Tilt Poker Game #` line.
- No information recovered on Full Tilt's own native export directory
  structure or filenames (the corpus is a parser test suite, not a raw
  client export) — flagged as unknown rather than guessed.

## 13. Gotchas

- **Old vs new header word order** (§4) — a parser must detect both, or it
  will misparse any pre-~2012 hand.
- **`is sitting out` interacts with `IsValidHand`**: the reference parser
  considers a hand invalid unless `handLines[1]` starts with `"Seat "` — a
  hand record consisting of only a header + `*** SUMMARY ***` (no seat
  listing, no actions — see `13-cash-edge-case-no-actions-summary-only.txt`)
  is a real edge case in the corpus and must be handled (skip/flag, don't
  crash).
- **`Uncalled bet of $X returned to <name>`** uses the word "of", unlike
  many PokerStars-family sites which use `Uncalled bet ($X) returned to
  <name>` with the amount in parens — do not conflate the two grammars when
  reusing a PokerStars-derived parser skeleton.
- **All-in spelling**: `and is all in` (three words, no hyphen) — differs
  from PokerStars' `and is all-in`.
- **`, and is capped`** appears only in CAP-limit games and must not be
  confused with the all-in suffix.
- **Cancelled-hand marker** (`Hand #<id> has been canceled`, American
  spelling) is referenced in the reference parser's `IsValidOrCancelledHand`
  but **no real sample was found** — treat the exact surrounding grammar
  (is it a whole extra line, does the rest of the hand still parse, etc.) as
  unconfirmed.
- **Tournament format is entirely unconfirmed** (§1, §3) — do not invent one.
  If a parser needs to support Full Tilt tournaments, that is new research,
  not an extrapolation from this doc.
- **Rake can be `$0`** in play-money/micro hands (`Rake $0`) — not always
  present as a fraction.
- **Duplicate-hand artifact**: the corpus's own "10 hands in one file" test
  fixture actually contains 5 unique hands each duplicated once — verified
  byte-for-byte identical pairs — almost certainly an artifact of how that
  specific fixture was assembled by its original authors, not a Full Tilt
  export behavior. Don't design around "files sometimes contain exact
  duplicate hands" based on this one file alone.

## 14. Sample index

All fixtures at `fixtures/samples/full-tilt/` (14 files, all REAL bytes
copied from a pre-existing open-source test corpus — no fixture in this
directory was authored/transcribed by this research pass). See
`fixtures/samples/full-tilt/SOURCES.md` for full provenance and caveats per
file, including the two files (`09-...`, `10-...`) that are partial
fragments / have anonymized names rather than being pristine full real
hands.

No tournament fixture exists in this directory (see §1). No fixture exists
for the "Hand #N has been canceled" case (see Gotchas).

# Run It Once Poker — hand history format

## 1. Overview & status

Run It Once Poker (RIO), Phil Galfond's site, launched 2019 and **closed
permanently in 2022**. No live site exists to pull fresh samples. This
research is built on **4 REAL fixtures** recovered from the open-source
**fpdb** ("Free Open Source Poker Database") project's regression-test
corpus, plus the corresponding parser source
(`fpdb_3_legacy/PokerStarsToFpdb.py`) as secondary confirmation. fpdb ships a
dedicated `Run It Once Poker` site (`site_id = 26`) inside its PokerStars
family parser — RIO's grammar is a close PokerStars derivative (this matches
the site's contemporaneous reputation as running "the PokerStars-format
clone room"). Both cash and tournament hand text are confirmed from real
samples; a separate tournament **summary** file format is also confirmed.

## 2. Detection signature

```
^Run It Once Poker (Hand|Tournament) #\d+
```

More precisely, from the shared PokerStars-family site regex used by fpdb
(only the RIO-relevant alternative shown):
```
Run It Once Poker(?: Hand| Tournament)? \#\d+
```
Cash/tournament hand files start `Run It Once Poker Hand #<id>:`. Tournament
summary files start `Run It Once Poker Tournament #<id>, <tournament name>`.

## 3. Full verbatim example hands

### Cash NLHE with Splash-the-Pot (`fixtures/samples/run-it-once/01-cash-nlhe-splash-the-pot-mucked-showdown.txt`)

```
Run It Once Poker Hand #30266126:  Hold'em No Limit (€0.05/€0.10) - 2019/06/25 16:12 UTC [2019/06/25 17:12 CET]
Table ID '30263259' 6-Max Seat #1 is the button
Seat 1: TestPlayer_1 (€17.56 in chips)
Seat 2: Clint Y (€14.07 in chips)
Seat 3: Galen U (€10 in chips)
Seat 4: Danielle J (€10 in chips)
Seat 5: Dawson D (€10 in chips)
Clint Y: posts small blind €0.05
Galen U: posts big blind €0.10
*** HOLE CARDS ***
STP added: €0.50
Dealt to TestPlayer_1 [6s 8h]
Dealt to Clint Y [4d 9c]
Dealt to Galen U [Js 7d]
Dealt to Danielle J [5c 5s]
Dealt to Dawson D [Ks Jc]
Danielle J: calls €0.10
Dawson D: folds
TestPlayer_1: folds
Clint Y: folds
Galen U: checks
*** FLOP *** [6h Jd 4c]
Galen U: bets €0.21
Danielle J: folds
Galen U: mucks hand
*** SHOWDOWN ***
Galen U: mucks hand
Uncalled bet (€0.71) returned to Galen U
Galen U collected €0.71 from pot
*** SUMMARY ***
Total pot €0.75 | Main pot €0.25 | STP €0.50 | Rake €0.04
Board [6h Jd 4c]
Seat 5: Dawson D folded before Flop
Seat 1: TestPlayer_1 (button) folded before Flop
Seat 2: Clint Y (small blind) folded before Flop
Seat 4: Danielle J folded before Turn
Seat 3: Galen U (big blind) mucked hand and won €0.71
```

Note: `TestPlayer_1` is likely a placeholder name from wherever this
regression fixture originated (unconfirmed whether RIO itself or the fpdb
contributor introduced it) — all other names look like ordinary usernames.

### Tournament hand (`fixtures/samples/run-it-once/03-tournament-nlhe-3max-hand.txt`)

```
Run It Once Poker Hand #55582352: Tournament #158168, €4.69+€0.31 Cub3d, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC [2021/04/12 17:01 CET]
Table ID '55582350' 3-Max Seat #5 is the button
Seat 1: Lyle N (500 in chips)
Seat 3: Doc (500 in chips) [hero]
Seat 5: Vance K (500 in chips)
Lyle N: posts small blind 10
Doc: posts big blind 20
*** HOLE CARDS ***
Dealt to Lyle N [Kd 5d]
Dealt to Doc [9s 4s]
Dealt to Vance K [8c 5c]
Vance K: raises 20 to 40
Lyle N: calls 30
Doc: calls 20
*** FLOP *** [Js Tc 7d]
...
```
(full hand in the fixture file)

### Tournament summary file (`fixtures/samples/run-it-once/04-tournament-summary-sng.txt`, full file — it's only 10 lines)

```
Run It Once Poker Tournament #158168, Cubed SNG No Limit Hold 'Em
Buy-In: €5.00
3 players
Tournament started 2021/04/12 17:01:17 CET [2021/04/12 11:01:17 ET]

1: Vance K, €12.50
2: Doc
3: Lyle N

You finished in 2nd place (eliminated at hand #55582410).
```
This is a **separate file** from the hand-by-hand history, generated per
tournament (not per hand) — a "tournament summary" export analogous to
PokerStars' own tournament summary files. Note the American-typo-free but
unusual `Hold 'Em` capitalization/spacing here vs `Hold'em` in the hand
files, and the "You finished in..." framing being written from the
requesting player's point of view (i.e. this file is inherently
player-specific, not a room-wide export).

## 4. Header grammar

Cash:
```
Run It Once Poker Hand #<handid>:  <Game> <Limit> (<CUR><sb>/<CUR><bb>) - <yyyy/mm/dd hh:mm> UTC [<yyyy/mm/dd hh:mm> <local-tz-abbr>]
```
(note the **double space** after the hand-id colon in the cash sample —
preserved verbatim in the fixture, not a transcription error.)

Tournament:
```
Run It Once Poker Hand #<handid>: Tournament #<tourneyid>, <CUR><buyin>+<CUR><rake> <tourney name>, <Game> <Limit> (<sb>/<bb>) - <yyyy/mm/dd hh:mm> UTC [<yyyy/mm/dd hh:mm> <local-tz-abbr>]
```
Tournament chip amounts (`sb`/`bb`) carry **no currency symbol** (they're
tournament chips, not real money) — contrast with the cash header where
every amount is prefixed with the currency symbol.

`<Game> <Limit>` observed: `Hold'em No Limit`, `Omaha Pot Limit`. Per the
shared fpdb PokerStars-family regex (secondary evidence, not all seen
locally), the broader `GAME`/`LIMIT` vocabulary (Razz, Stud, Omaha Hi/Lo,
etc. × No Limit/Pot Limit/Fixed Limit) is presumably available to RIO too,
but only NLHE and PLO are confirmed from real RIO bytes.

## 5. Table/seat lines

```
Table ID '<tableid>' <n>-Max Seat #<btn> is the button
Seat <n>: <name> (<CUR><stack> in chips)[ [hero]]
```
Two distinctive traits vs plain PokerStars:
- `Table ID '<id>'` (PokerStars just writes `Table '<name>'` without the
  literal word "ID").
- `<n>-Max` is capitalized `Max` (PokerStars writes `<n>-max` lowercase) —
  confirmed in all 4 fixtures.
- The hero's own seat line carries a trailing `[hero]` tag in the
  tournament sample (not observed in the cash samples — possibly a
  tournament-only or export-context-dependent feature; flagged, not
  overgeneralized).

## 6. Blinds/antes/straddle

```
<name>: posts small blind <CUR><amount>
<name>: posts big blind <CUR><amount>
STP added: <CUR><amount>
```
Note the **colon after the player name** (`<name>: posts...`), unlike Full
Tilt's `<name> posts the small/big blind of $X` — RIO uses PokerStars-style
`Name: action` syntax throughout. No ante or straddle example was present in
the local fixtures (not ruled out, just unconfirmed).

`STP` = **"Splash The Pot"**, a PokerStars/RIO cash-game promotion where the
site adds free money to the pot; appears right after `*** HOLE CARDS ***`
as `STP added: <CUR><amount>` and is reconciled later in the summary line
`... | STP <CUR><amount> | ...`.

## 7. Street markers (exact spelling)

```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx Xx] [Xx]
*** SHOWDOWN ***
*** SUMMARY ***
```
**Important**: RIO spells it `*** SHOWDOWN ***` as one word — this differs
from PokerStars' own `*** SHOW DOWN ***` (two words) despite RIO otherwise
being a close PokerStars clone. Confirmed in both cash fixtures. Do not
reuse a PokerStars regex for this line unmodified.

## 8. Action verbs (exact phrasing)

| Action | Exact text |
|---|---|
| Fold | `<name>: folds` |
| Check | `<name>: checks` |
| Bet | `<name>: bets <CUR><amount>` |
| Call | `<name>: calls <CUR><amount>` |
| Raise | `<name>: raises <CUR><delta> to <CUR><total>` |
| All-in suffix | `and is all-in` (hyphenated, PokerStars-style) |
| Uncalled bet return | `Uncalled bet (<CUR><amount>) returned to <name>` (amount in parens, unlike Full Tilt's `of` phrasing) |
| Mucks (no showdown reveal) | `<name>: mucks hand` |
| Shows | `<name> shows [Xx Xx Xx Xx] for <hand description> [<best-5-card readout>]` (note: **no colon** before "shows" here, unlike fold/check/bet/call/raise which all use `Name: action`) |
| Wins main pot | `<name> collected <CUR><amount> from pot` |
| Wins side pot | `<name> collected <CUR><amount> from side pot <n>` |
| Duplicate shows line | Observed once in the PLO/side-pot fixture: the exact same `Ricky N shows [...]` line appears twice in a row in the real file — preserved verbatim as a genuine RIO export quirk (see fixture SOURCES.md), not deduplicated |

## 9. SUMMARY/pot/rake layout

Cash (no side pot):
```
*** SUMMARY ***
Total pot <CUR><amount> | Main pot <CUR><amount> | STP <CUR><amount> | Rake <CUR><amount>
Board [Xx Xx Xx]
Seat <n>: <name>[ (button|small blind|big blind)] <outcome>
```
Cash (with side pot):
```
Total pot <CUR><amount> | Main pot <CUR><amount> | Side pot <CUR><amount> | STP <CUR><amount> | Rake <CUR><amount>
```
Tournament (no rake, no STP):
```
Total pot <amount> | Rake 0
```
`<outcome>` variants seen: `folded before Flop`, `folded before Turn`,
`folded before River`, `mucked hand and won <CUR><amount>`,
`showed [Xx Xx Xx Xx] and won <CUR><amount> with <hand description>`,
`mucked [Xx Xx Xx Xx] and lost`. Note `folded before Flop` (RIO) vs Full
Tilt's `folded before the Flop` — no "the".

Seat-summary line ordering in the SUMMARY block is **not seat-number order**
— confirmed in every fixture the summary lists seats in a different order
than 1..n (e.g. `Seat 5, Seat 1, Seat 2, Seat 4, Seat 3` in fixture 01).
Reason unknown (possibly action/elimination order); do not assume ascending
seat order when parsing this block.

## 10. Date/time format + timezone

Dual-timestamp, always UTC first then a local zone in brackets:
```
<yyyy/mm/dd> <hh:mm> UTC [<yyyy/mm/dd> <hh:mm> <TZ>]
```
`<TZ>` abbreviations observed: `CET`, `ET`. Minute-precision only in hand
headers (no seconds) — contrast with Full Tilt/PokerStars which include
seconds. The tournament summary file uses second-precision instead:
`2021/04/12 17:01:17 CET [2021/04/12 11:01:17 ET]`.

## 11. Anonymized-player conventions

None platform-native observed. `TestPlayer_1` in fixture 01 looks like it
may be a placeholder introduced upstream (unconfirmed origin) — flagged, not
treated as a documented RIO convention.

## 12. File naming + export directory + hands per file + encoding/line endings

- Encoding: valid UTF-8, € as the standard 3-byte `E2 82 AC` sequence, no
  BOM in the 4 fixtures checked.
- No information recovered on RIO's native client export directory,
  filenames, or hands-per-file convention — the fixtures are individual
  files from a parser regression-test corpus, not a raw client export
  session. Flagged as unknown, not guessed.
- Tournament **hand** histories and tournament **summaries** are confirmed
  to be two distinct file formats/exports (see §3).

## 13. Gotchas

- **`*** SHOWDOWN ***` (one word)** vs PokerStars' `*** SHOW DOWN ***` (two
  words) — easy to get wrong if bootstrapping from a PokerStars parser.
- **`Table ID '<id>'`** vs PokerStars' plain `Table '<name>'` — the literal
  word "ID" is part of the line and the quoted value is a numeric table ID,
  not a human table name.
- **`<n>-Max`** capitalized, vs PokerStars' `<n>-max`.
- Tournament stakes have no currency symbol; cash stakes always do — a
  parser must not assume a currency symbol is always present in the parens
  after the game name.
- **Seat lines in the SUMMARY block are not in seat-number order** (§9) —
  don't index into them positionally.
- One real fixture contains a **duplicated `shows` line** (§8) — a strict
  parser should tolerate a repeated identical action line rather than
  erroring, since it's attested in real RIO output.
- `[hero]` tag on the seat line (tournament fixture only) is unconfirmed as
  a general rule — don't assume it's always present or always absent.
- This site's grammar is close to, but **not identical to**, PokerStars' —
  the temptation to reuse a PokerStars parser wholesale will silently break
  on the SHOWDOWN spelling and the Table-ID line at minimum.

## 14. Sample index

All 4 fixtures at `fixtures/samples/run-it-once/`, all REAL bytes retrieved
via `curl` from the fpdb project's regression-test corpus on GitHub — see
`fixtures/samples/run-it-once/SOURCES.md` for exact URLs and per-file notes.
Covers: cash NLHE (mucked showdown + Splash-the-Pot), cash PLO (side pot +
full showdown + Splash-the-Pot), one tournament hand (3-max), one tournament
summary file (SNG). No full multi-hand session file was found (each fixture
is a single hand or a single summary).

# PokerBros — hand history format

## 1. Overview & status

PokerBros (`com.kpgame.PokerBros`) is a **live** mobile-only (iOS/Android, no
official Windows/Mac client) club/agent poker app, popular in Asia and
increasingly elsewhere. This is one of the two highest real-world-value
platforms in this research batch (the other being PPPoker) — but it is also
one of the hardest to get primary evidence for, because there is no
downloadable desktop client to inspect and no public raw-export sample
found anywhere.

**What is confirmed:**
- The app has an in-app **"Hand History" viewer** covering the **previous 6
  days** of play (multiple independent user/support sources agree on this:
  PokerTracker forums, bsbpoker.com's PokerBros FAQ, kingshands.com). This is
  a viewer/limited-export feature, not a full historical archive.
- At least one independent source (kingshands.com, a hand-converter vendor)
  states in-app export "produces a file that the poker tracker does not
  recognise" — i.e. whatever the app spits out is **not** natively
  PT4/HM3-importable.
- A whole cottage industry of third-party "Asian Hand Converters" exists
  specifically to bridge PokerBros (and PPPoker, ClubGG, ecosystem-mates) to
  PokerTracker 4 / Holdem Manager 3 / DriveHUD / Hand2Note. PokerTracker's
  own support forum confirms PT4's PokerBros integration is via a
  third-party converter (branded "EliteHud" in PT4-side docs, "Asian Hand
  Converter"/DriveHUD elsewhere) — **not native support** — and that the
  HUD only works in **club games**, not lobby/ring games.
- Real bytes recovered (see fixtures) show that **a text hand-history
  grammar for PokerBros does exist and is used in practice** — two REAL
  fixtures from the open-source **fpdb** project's regression-test corpus
  encode the identical underlying hand in two different dialects (a
  partypoker-classic-style dialect and a PokerStars-family-style dialect).
  fpdb ships first-class parsing support for both, with `site_id = 29` and
  `sitename = "PokerBros"`.

**What is NOT confirmed:** whether either of those two dialects is what
PokerBros' own in-app "Hand History" export produces, versus being purely a
third-party converter's synthetic output format built to satisfy
PT4/fpdb's existing parsers. No sample of the raw in-app export itself
(before any converter touches it) was found anywhere — not on GitHub, not
on any forum, not in any vendor's public documentation. **This is the
central negative finding for this platform: the true native/raw PokerBros
export format is unknown.** Any parser built from the two fixtures here is
really parsing "PokerBros data as rendered by a specific converter," which
is a legitimate and common real-world need, but is a different claim from
"parsing PokerBros' native format."

## 2. Detection signature

Two dialects, both confirmed from real bytes:

**Dialect A (partypoker-classic-style):**
```
^\*{5}\sHand\sHistory\s(F|f)or\sGame\s\d+\s\*{5}\s\(PokerBros\)
```
i.e. a line starting `***** Hand History for Game <digits> ***** (PokerBros)`
— the literal string `(PokerBros)` at the end of the header line is what
distinguishes it from a real partypoker/WPN hand (which would say `(Party)`,
`(WPN)`, etc. in the same position — this is fpdb's own site-tagging
convention baked into the sample, confirmed via
`fpdb_3_legacy/PartyPokerToFpdb.py`'s `SITE` regex group).

**Dialect B (PokerStars-family-style):**
```
^PokerBros Hand #\d+:
```
Confirmed real and distinct from tools that instead fake `PokerStars Hand
#...` verbatim (see §13 Gotchas — this varies by converter/tool).

## 3. Full verbatim example hands

Both fixtures encode the **same real hand** (same cards: hero `8h 9h` vs.
villain `Th Ts` visible at showdown in dialect B; same board `4d Jd Tc Qs
4s`; same final pot). No tournament example was found for PokerBros in
either dialect.

### Dialect A — `fixtures/samples/pokerbros/01-cash-nlhe-party-dialect-with-hud-stats.txt` (CRLF preserved, shown here with `\r\n` implicit)

```
***** Hand History for Game 1111111111 ***** (PokerBros)
$100.00 USD NL Holdem - Friday, March 19, 07:51:54 ET 2021
Table Myanmar888887748727 (Real Money)
Seat 1 is the button
Seat 1: Hero ( $122.40 USD ) - (21.60 / 16.35 / 5.71 / 18k)
Seat 3: Player3 ( $184.00 USD ) - (19.75 / 11.79 / 3.97 / 485)
Seat 4: Player4 ( $115.05 USD ) - (31.91 / 25.53 / - / 47)
Seat 5: Player5 ( $57.65 USD ) - (41.51 / 25.00 / 8.05 / 215)
Seat 6: Player6 ( $113.95 USD ) - (25.11 / 21.42 / 6.02 / 2.4k)
Player3 posts small blind [$0.50 USD].
Player4 posts big blind [$1.00 USD].
** Dealing down cards **
Dealt to Player3 [ 8h 9h ]
Player5 folds
Player6 folds
Hero raises [$2.50 USD]
Player3 calls [$2.00 USD]
Player4 folds
** Dealing Flop ** [ 4d, Jd, Tc ]
Player3 bets [$4.00 USD]
Hero calls [$4.00 USD]
** Dealing Turn ** [ Qs ]
Player3 bets [$9.33 USD]
Hero raises [$36.32 USD]
Player3 calls [$26.99 USD]
** Dealing River ** [ 4s ]
Player3 checks
Hero bets [$79.58 USD]
Player3 calls [$79.58 USD]
Player3 wins $241.55 USD
```
Note `Dealt to Player3 [8h 9h]` even though seating order and later action
suggest `Hero` should be the one with those cards in dialect B's showdown —
this is preserved exactly as it appears in the real file; it may reflect
that this specific converter mis-attributes hole cards to the wrong seat in
this dialect, or that "Hero" in this anonymized fixture isn't the same
person as `1087383`/dialect-B's Hero-equivalent. Flagged, not resolved.

### Dialect B — `fixtures/samples/pokerbros/02-cash-nlhe-pokerstars-dialect-same-hand.txt`

```
PokerBros Hand #1616183514566: Hold'em No Limit ($0.5/$1 USD) - 2021/03/19 19:51:54 UTC
Table 'Myanmar888887748727' 6-max Seat #2 is the button
Seat 1: 1087383 ($122.4 in chips)
Seat 3: 1081005 ($184.0 in chips)
Seat 4: 1236927 ($115.05 in chips)
Seat 5: 793547 ($57.65 in chips)
Seat 6: 1084145 ($113.95 in chips)
1081005: posts small blind $0.5
1236927: posts big blind $1
*** HOLE CARDS ***
Dealt to 1087383 [8h 9h]
793547: folds
1084145: folds
1087383: raises $1.5 to $2.5
1081005: calls $2.0
1236927: folds
*** FLOP *** [4d Jd Tc]
1081005: bets $4.0
1087383: calls $4.0
*** TURN *** [4d Jd Tc] [Qs]
1081005: bets $9.33
1087383: raises $26.99 to $36.32
1081005: calls $26.99
*** RIVER *** [4d Jd Tc Qs] [4s]
1081005: checks
1087383: bets $79.58 and is all-in
1081005: calls $79.58
*** SHOW DOWN ***
1087383: shows [8h 9h]
1081005: shows [Th Ts]
1081005 collected $241.55 from pot
*** SUMMARY ***
Total pot $245.80 | Rake $4.25
Board [4d Jd Tc Qs 4s]
Seat 1: 1087383 showed [8h 9h] and lost
Seat 3: 1081005 (small blind) showed [Th Ts] and won ($241.55)
Seat 4: 1236927 (big blind) folded before Flop
Seat 5: 793547 folded before Flop (didn't bet)
Seat 6: 1084145 folded before Flop (didn't bet)
```

## 4-10. Grammar sections (both dialects observed)

Given only one hand is confirmed in each dialect, the grammar below is
described narrowly — treat anything not literally present in the two
fixtures as **unconfirmed**, not extrapolated.

**Dialect A (party-classic):**
- Header: `***** Hand History for Game <id> ***** (PokerBros)` then
  `<CUR><stakes> <Currency> NL Holdem - <Weekday>, <Month> <Day>,
  <hh:mm:ss> ET <year>` then `Table <name> (Real Money)`.
- Seats: `Seat <n>: <name> ( <CUR><stack> <CUR-code> ) - (<vpip>% / <pfr>%
  / <3bet>% / <hands-played, e.g. "18k">)` — the HUD-stat tuple in
  parentheses is the standout feature of this dialect; it is **not**
  present in genuine partypoker hand histories, so it was added by whichever
  tool produced this specific export (almost certainly a HUD-integrated
  converter, given the VPIP/PFR/3-bet/hands-count shape).
  "hands-played" abbreviates with a `k` suffix at scale (`18k`, `2.4k`,
  `485`, `47`).
- Blinds: `<name> posts small/big blind [<CUR><amount> <CUR-code>].`
  (trailing period after the closing bracket, confirmed).
- Streets: `** Dealing down cards **`, `** Dealing Flop ** [ Xx, Xx, Xx ]`
  (comma-separated cards, spaces inside brackets), `** Dealing Turn ** [
  Xx ]`, `** Dealing River ** [ Xx ]`.
- Actions: `<name> folds`, `<name> checks`, `<name> bets [<CUR><amount>
  <CUR-code>]`, `<name> calls [<CUR><amount> <CUR-code>]`, `<name> raises
  [<CUR><amount> <CUR-code>]`. Cross-referencing against dialect B's
  explicit `raises <delta> to <total>` phrasing for the same real actions:
  dialect A's bracketed raise amount is the **raise-to total**
  (`Hero raises [$2.50 USD]` ↔ dialect B `raises $1.5 to $2.5`;
  `Hero raises [$36.32 USD]` ↔ dialect B `raises $26.99 to $36.32`), while
  its bracketed call amount is the **incremental amount added** (`Player3
  calls [$26.99 USD]` ↔ dialect B `calls $26.99`) — both dialects agree once
  you know dialect A collapses "raise by X to Y" down to just "Y". Confirmed
  consistent across every action in the shared hand, not ambiguous.
- Win line: `<name> wins <CUR><amount> <CUR-code>` — no explicit `***
  SUMMARY ***` section in this dialect at all; the file simply ends after
  the win line.
- Line endings: **CRLF** (`\r\n`), confirmed via `file`/hexdump.

**Dialect B (PokerStars-family):**
- Header: `PokerBros Hand #<id>: <Game> <Limit> (<CUR><sb>/<CUR><bb>
  <CUR-code>) - <yyyy/mm/dd hh:mm:ss> UTC`.
- Table: `Table '<name>' <n>-max Seat #<btn> is the button`.
- Seats: `Seat <n>: <name> (<CUR><stack> in chips)` — plain, no HUD stats.
- Players named by **bare numeric ID** rather than nickname (matches
  PokerBros' default of displaying numeric user IDs unless a custom
  nickname is set).
- Blinds/actions: `<name>: posts small/big blind <CUR><amount>`, `<name>:
  folds/checks/bets <CUR><amount>/calls <CUR><amount>/raises <CUR><delta>
  to <CUR><total>`, all-in suffix `and is all-in`.
- Streets: `*** HOLE CARDS ***`, `*** FLOP *** [Xx Xx Xx]`, `*** TURN ***
  [board] [Xx]`, `*** RIVER *** [board] [Xx]`, `*** SHOW DOWN ***` (two
  words, PokerStars-style — contrast with Run It Once Poker's one-word
  `*** SHOWDOWN ***`, a different site entirely, documented separately).
  `Dealt to <name> [Xx Xx]` for hole cards.
- Summary: `Total pot <CUR><amount> | Rake <CUR><amount>`, `Board [board]`,
  `Seat <n>: <name>[ (button|small blind|big blind)] <outcome>` with
  outcomes `showed [Xx Xx] and won/lost (<CUR><amount>)`, `folded before
  Flop[ (didn't bet)]`.
- Line endings: **LF only**, no CRLF, no BOM (confirmed via `file`).

## 11. Anonymized-player conventions

Dialect A uses `Hero`/`Player3`..`Player6` — almost certainly redaction
applied by whoever contributed the fpdb regression fixture (real PokerBros
nicknames are free text). Dialect B uses bare numeric IDs
(`1087383`, `1081005`, ...) which may or may not be redacted — this matches
PokerBros' genuine default display-name behavior closely enough that it is
plausibly **not** redacted, just how the account happened to be configured.
Not enough evidence to be certain either way; flagged rather than asserted.

## 12. File naming + export directory + hands per file + encoding/line endings

Unknown for the real in-app export (no sample found — see §1). For the two
confirmed fixtures: single-hand files, dialect A is CRLF/ASCII, dialect B is
LF/ASCII, both retrieved as individually-named regression-test files from
fpdb, not as a raw multi-hand session export.

## 13. Gotchas

- **The single biggest gotcha: nobody has published what PokerBros' own
  in-app export actually looks like.** Everything downstream (fpdb's two
  dialects, DriveHUD's Asian Hand Converter, "EliteHud") is a third-party
  reconstruction/relabeling for PT4/HM3/fpdb compatibility. A parser author
  should treat "PokerBros format" as **"whatever a specific converter
  emits,"** plural, not a single canonical grammar — and should expect to
  encounter more dialect variants in the wild than the two documented here.
- **Converters disagree on how honest to be about the site name.** The
  PPPoker-side "PPPokerHA" tool (see `pppoker.md`) writes a bald-faced
  `PokerStars Hand #...` header to satisfy strict PT4 parsing; the fpdb
  PokerBros dialect B instead honestly writes `PokerBros Hand #...` and
  relies on fpdb's own multi-site-aware regex. A universal converter must
  not assume the header site name truthfully identifies the origin room.
- **HUD/tracking only works in club games, not PokerBros lobby ring
  games** (PokerTracker forum), which may correlate with when a text
  export is even obtainable at all — lobby-game data may be less
  accessible to converters than club-game data.
- Six-day rolling export window (multiple sources) means any pipeline
  built on the in-app feature (once its format is known) must poll at
  least that often or lose data permanently.

## 14. Sample index

`fixtures/samples/pokerbros/` — 2 REAL files (one hand, two dialects),
sourced from the open-source fpdb project's regression-test suite via
`curl` (byte-exact). See `fixtures/samples/pokerbros/SOURCES.md`. No
tournament sample, no raw/native in-app export sample, no multi-hand file
sample — all three are explicit, stated gaps rather than filled with
invented content.

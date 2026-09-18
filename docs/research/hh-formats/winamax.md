# Winamax hand history format

## 1. Overview & status

Winamax (France/EU-licensed room, winamax.fr / winamax.es / winamax.de) exports plain-text hand
histories in its own bespoke grammar — not a PokerStars/iPoker/Chico clone. It is easy to detect
and, for cash games, easy to parse; there are, however, real encoding traps (see §12/§13).

**Confirmed from real samples (27 files, all cash games, dated 2013-10 through 2015-03 — see
`fixtures/samples/winamax/SOURCES.md`):**
- Full cash-game header/seat/action/summary grammar for Hold'em No Limit and Omaha Pot Limit.
- Blind posting, 3-bet/4-bet sizing (`raises X to Y`), all-in tagging, uncalled-bet return,
  showdown (`shows`/`mucked`), multi-hand file separation, heads-up blind convention, 6-max and
  9-max tables, two distinct real text encodings.
- This specific corpus is old enough (2013-2015) that it predates Winamax's later table-capacity
  options, but every field we could cross-check (2020s screenshots seen in secondary sources,
  the Winamax support site) still shows the identical `HandId:` grammar, so we treat the header
  format itself as stable across the whole 2013-present era. Nothing in this doc claims the
  *current* export is byte-identical beyond the header/seat/action grammar — only that no
  breaking change has surfaced.

**NOT confirmed from a real sample — inferred from a secondary source only:**
- The **tournament header grammar** (`Winamax Poker - Tournament "..." buyIn: ... level: ... -
  HandId: ...`). This was found via a WebFetch of a 2014 PokerTracker support-forum thread
  (`pokertracker.com/forums/viewtopic.php?p=264998&t=53533`) reporting an import bug; the
  fetch tool converts HTML to markdown and can normalize whitespace, and no raw `.txt` export
  was obtainable from that thread (no downloadable attachment, only inline pasted text). It is
  **not** byte-verified and there is **no fixture file for it** in this fixture set — do not
  harden a parser's tournament-header regex against it without finding a raw export first. See
  §4 for exactly what was and wasn't corroborated.
- We could not find a real Omaha Hi/Lo (5-card or 4-card) Winamax sample; the one file in the
  source corpus whose name suggested it (`OmahaHiLo.txt`) turned out on inspection to not be a
  Winamax hand at all (a mislabeled iPoker-network XML export that ended up in the wrong folder
  upstream — see SOURCES.md) and was excluded from this fixture set entirely.
- No fast-fold ("Blitz") sample was found, though Winamax's fast-fold product does exist; we
  found no textual evidence either way of what its hand-history header looks like.

## 2. Detection signature

Single most reliable anchor — the literal substring `Winamax Poker - ` at the start of the
first line of a hand (this is also exactly what the reference C# parser uses to split a
multi-hand file: `new Regex("(Winamax Poker - )")`):

```
^Winamax Poker - (CashGame|Tournament)
```

This cannot be confused with any of the other three sites in this project: none of Ignition/
Bovada/Bodog, ACR/WPN, or Chico ever emit the literal token `Winamax`. It also cannot be
confused with PokerStars (`PokerStars Hand #...` / `PokerStars Game #...`) or any iPoker-style
XML export. A secondary, streets-level confirmation if the header line is ever stripped: the
literal marker `*** ANTE/BLINDS ***`, which is unique to Winamax among all sites surveyed in
this project (PokerStars has no equivalent marker line at all; WPN/Chico/Ignition all post
blinds as ordinary action lines with no dedicated street header for them).

## 3. Full verbatim example hands

### Cash game (real, byte-exact — `fixtures/samples/winamax/hhsmithy-corpus/CashGame_HandActionTests_BasicHand.txt`)

```
Winamax Poker - CashGame - HandId: #5335178-3970-1383796438 - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC
Table: 'Milwaukee 02' 5-max (real money) Seat #5 is the button
Seat 1: totti6720 (99.36€)
Seat 2: titi250 (64.76€)
Seat 3: Dbrz34 (13.23€)
Seat 4: sined20 (90.75€)
Seat 5: fanf4K UR0 (94.85€)
*** ANTE/BLINDS ***
totti6720 posts small blind 0.25€
titi250 posts big blind 0.50€
*** PRE-FLOP ***
Dbrz34 calls 0.50€
sined20 raises 1€ to 1.50€
fanf4K UR0 folds
totti6720 folds
titi250 folds
Dbrz34 calls 1€
*** FLOP *** [4d Kc 9c]
Dbrz34 checks
sined20 bets 2.50€
Dbrz34 folds
sined20 collected 6.01€ from pot
*** SUMMARY ***
Total pot 6.01€ | Rake 0.24€
Board: [4d Kc 9c]
Seat 4: sined20 won 6.01€
```

(Note the file has a UTF-8 BOM before `Winamax`, not shown above, and a trailing space after
`*** PRE-FLOP ***` on its own line — both are real, see §13.)

### Tournament (NOT byte-verified — reconstructed from a secondary source, see §1; treat with caution, no fixture file backs this)

Reported header + table line from a 2014 PokerTracker forum thread about a Winamax import bug:

```
Winamax Poker - Tournament "PPT Freeroll" buyIn: Free level: 0 - HandId: #330562020497686531-1-1397588416 - Holdem no limit (10/20) - 2014/04/15 19:00:16 UTC
Table: 'PPT Freeroll(76964968)#002' 9-max (real money) Seat #2 is the button
```

Everything after the table line (seats/actions/summary) was not reproduced in the source and is
therefore not documented here at all — do not guess it.

## 4. Header grammar

Cash game (confirmed):
```
Winamax Poker - CashGame - HandId: #<table>-<hand>-<total> - <Game> (<sb><cur>/<bb><cur>) - <YYYY>/<MM>/<DD> <HH>:<MM>:<SS> UTC
```
- `<Game>` observed values: `Holdem no limit`, `Omaha pot limit`. The reference parser extracts
  the game string by splitting on `-` and taking the 6th field then trimming the parenthesized
  stakes — i.e. it is whitespace- and hyphen-sensitive; do not assume a fixed column offset.
- Stakes have **no thousands separator** and the currency symbol (`€`) is **appended directly
  to each number with no space**: `0.25€/0.50€`, `5€/10€`. Observed range 0.05€/0.10€ to
  5€/10€ in this corpus.
- `HandId` is 3 dash-joined integers: table id, hand-in-table id, and a global Winamax hand
  counter. The reference parser only uses the first two joined together as its internal hand
  id (documented in its own source comment) because the third number alone is "too long".
- Timezone in this corpus is always `UTC`. The reference C# parser (comment + switch statement)
  also handles `CEST`, `CET`, and `PST` as literal timezone suffixes it has seen in the wild —
  these were not present in any file we obtained, so treat them as plausible-but-unconfirmed.
- **Tournament** header adds `Tournament "<name>" buyIn: <buyin> level: <n> -` between `CashGame`
  (replaced by `Tournament`) and `HandId:` — see §3 caveat; buyIn format for a real-money
  tournament (e.g. `5€ + 0.50€`) was not observed anywhere and is a pure guess if a parser needs
  one — do not encode it without further evidence.
- Play-money tables: the table line's `(real money)` parenthetical is the only observed
  real/play marker (see §5); we found no play-money-labelled sample, so the play-money literal
  string (presumably `(play money)`) is unconfirmed.

## 5. Table/seat lines, button, max seats

```
Table: '<table name>' <N>-max (real money) Seat #<n> is the button
Seat <n>: <player name> (<stack><cur>)
```
- `<N>-max` observed values: 2, 5, 6, 9 (heads-up through full ring). This is the table's
  *capacity*, independent of how many seats are actually occupied — a "5-max" table with 2
  players seated is normal and appears in this corpus (`CashGame_Seats_6-Max.txt`, despite its
  filename, is actually a 5-max-capacity table with 2 seated players; read the file, not the
  filename).
- Seat numbering is **not necessarily contiguous or 1-based-first**: seats can start at 2 and
  skip numbers freely, matching whichever physical seats are occupied (see
  `CashGame_Tables_Table2.txt`: only seats 2 and 5 exist).
- There is no dedicated hero marker in the seat line at all (contrast Ignition's `[ME]` or
  WPN/PokerStars conventions elsewhere) — hero is identified purely by the later
  `Dealt to <name> [<cards>]` line (§8), which is absent entirely if hero folded before ever
  being dealt a hand history worth exporting cards for, or in old-format historical hands.

## 6. Blinds, antes, straddle, dead blinds

```
*** ANTE/BLINDS ***
<player> posts small blind <amt><cur>
<player> posts big blind <amt><cur>
```
No confirmed real sample contains an ante, a straddle, or a "waiting for big blind" line. The
reference parser's source contains defensive code for two unconfirmed variants worth flagging
for a parser author (mined from comments/logic in `WinamaxFastParserImpl.cs`, not verified
against a real file in this corpus):
- Dead-blind posting with a trailing qualifier, shape `<player> posts small/big blind
  <amt><cur> out of position` — the parser detects this by checking whether the line ends in
  the letter `n` and, if so, treats the post as `HandActionType.POSTS` (dead money) rather than
  a live blind, and strips a fixed 16-character suffix. **Unconfirmed by any fixture.**
- A line ending in the letter `d`, treated as a "denies big blind"-style skip
  (comment: `// Nhat60 denies big blind`) — also **unconfirmed by any fixture**, kept here only
  as a documented gotcha so a parser doesn't crash on it if encountered live.

## 7. Street markers (verbatim, confirmed)

```
*** ANTE/BLINDS ***
*** PRE-FLOP ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx Xx] [Xx]
*** SHOW DOWN ***
*** SUMMARY ***
```
- `*** PRE-FLOP ***` in every sample has a **trailing space** after it on its own line before
  the newline (`"*** PRE-FLOP *** \n"`) — a literal-string parser must not require an exact
  end-of-line immediately after the third asterisk.
- Turn and river repeat all previously-known board cards inside the first bracket, then the new
  card in a second bracket — this is unlike PokerStars, which shows only the new card outside a
  repeated-cards bracket for turn/river in its own idiom (`*** TURN *** [Ah Kd Qc] [Js]` — same
  shape, coincidentally, but worth confirming per-site rather than assuming).
- If the hand ends without reaching showdown (someone wins uncontested), `*** SHOW DOWN ***`
  is simply absent and `*** SUMMARY ***` follows the last played street directly.

## 8. Action verbs (confirmed, verbatim)

- `<player> posts small blind <amt><cur>` / `posts big blind <amt><cur>`
- `<player> calls <amt><cur>`
- `<player> bets <amt><cur>`
- `<player> raises <amt><cur> to <amt><cur>`
- `<player> checks`
- `<player> folds`
- All-in is **not a separate verb** — it is any of the above four money-verbs with the literal
  suffix ` and is all-in` appended to the same line, e.g.
  `LEROISALO raises 20.35€ to 22.85€ and is all-in`.
- `<player> collected <amt><cur> from pot` — the uncontested-pot-win line, appears immediately
  after the last action on the winning street, *before* `*** SUMMARY ***`.
- `Dealt to <player> [<card1> <card2>]` — appears once, right after `*** ANTE/BLINDS ***` and
  before `*** PRE-FLOP ***`, and (in this corpus) **only ever for the hero seat**. This is the
  sole mechanism for identifying which player is "hero" in a Winamax file.
- Showdown: `<player> shows [<cards>] (<hand description>)`, e.g.
  `nico86190 shows [Qh Qc] (One pair : Queens)` — note the **colon inside the parenthetical**
  (`One pair : Queens`, `Two pairs : Aces and 7`, `high card : Ace`), a distinctly
  French-translated-to-English idiom not seen on any other site in this survey.
- We found **no** uncalled-bet-return line, no disconnect/timeout/sit-out line, and no
  run-it-twice line in any real sample. Given the reference parser has no code path for any of
  these either, treat their exact wording as genuinely unknown rather than merely un-sampled.

## 9. SUMMARY / pot / rake line layout

```
*** SUMMARY ***
Total pot <amt><cur> | Rake <amt><cur>
Board: [<cards>]
Seat <n>: <player> (<small blind>) (<big blind>) (<button>) showed [<cards>] and won <amt><cur> with <hand description>
Seat <n>: <player> (<button>) mucked
Seat <n>: <player> won <amt><cur>
```
- When rake is exactly zero the rake field is **not** `Rake 0€` — it is the literal string
  `No rake` (`Total pot 30€ | No rake`), confirmed in three separate files. A parser must handle
  both forms.
- `Board: [<cards>]` uses a **colon** — `Board:` not `Board` — this is a hard, confirmed
  disambiguator versus PokerStars/WPN/Chico, all of which write `Board [<cards>]` with no colon
  (see the other three docs in this set). Only present if the hand reached the flop.
  Absent entirely for hands that ended preflop.
  - Position tags `(small blind)`, `(big blind)`, `(button)` are concatenated directly after
  the player name with no separator beyond a single space each, in whatever subset applies
  (a player can be both small blind and button heads-up, as shown in
  `CashGame_HandActionTests_BasicHand.txt`'s sibling files).
- The reference parser recovers total pot by reading `Total pot X` and then *re-adding* the
  rake to it, with an explicit code comment noting the printed "Total pot" figure has already
  had rake subtracted out by Winamax — i.e. **`Total pot` in the file is pot-minus-rake, not the
  gross pot**, a real and easy-to-miss gotcha for any parser computing pot size independently.

## 10. Date/time format and timezone convention

`YYYY/MM/DD HH:MM:SS <TZ>` embedded directly in the header line's tail, e.g.
`2013/11/07 03:53:58 UTC`. Only `UTC` observed in real samples; `CEST`/`CET`/`PST` are
plausible per the reference parser's switch statement but unconfirmed here.

## 11. Anonymized-player conventions

**Winamax does not anonymize players at all.** Every seat line and action line uses the real,
persistent screen name of the player exactly as it appears at the table (`totti6720`,
`sined20`, `WM_Hero`, `benhansen`, etc.). This is a structural difference from Ignition/Bodog/
Bovada (positional pseudo-names, see that doc) and is worth stating explicitly since a parser
author coming from that doc might otherwise expect some anonymization here — there is none.
The only hero-identifying mechanism is the `Dealt to <name> [...]` line (§8), not a naming
convention.

## 12. File naming, hands per file, encoding + line endings

- No canonical file-naming convention was recoverable from this corpus (the HHSmithy fixtures
  are renamed for their own test taxonomy, not Winamax's real export names).
- Multiple hands can appear in one file, separated by **5 consecutive blank lines**
  (`\n\n\n\n\n`, confirmed in `CashGame_MultipleHandsTests_10MultipleHands.txt`) — noticeably
  more padding than most other sites in this survey (PokerStars typically uses 1). A
  line-count-based or single-blank-line splitter will silently merge hands or (worse) treat the
  padding lines as an empty "hand" if not filtered.
- **Encoding is not uniform even within this one small, same-era corpus**: most files are
  UTF-8 with a BOM (`EF BB BF`) and LF-only line endings; two files
  (`ValidHand.txt`/`InValidHand.txt`) have **no BOM** and encode the € sign as **Windows-1252**
  (byte `0x80`), which renders as U+FFFD if blindly decoded as UTF-8. A robust parser must
  sniff encoding per-file rather than assume UTF-8.

## 13. Gotchas (would break a regex written from a single example)

1. Trailing space after `*** PRE-FLOP ***` on its own line — don't require exact end-of-line.
2. `Total pot` in the summary is **net of rake**, not gross — re-add rake before comparing to
   the sum of all bets, or you will be off by exactly the rake amount.
3. `No rake` is a distinct literal string, not `Rake 0€` — handle both branches.
4. `Board:` has a colon (Winamax-specific); do not reuse a PokerStars/WPN/Chico `Board ` (no
   colon) regex unmodified.
5. Table capacity (`N-max`) is independent of occupied-seat count; never assume all N seats
   have a `Seat n:` line.
6. Seat numbers are sparse/non-contiguous — index by the number after `Seat `, never by line
   position.
7. Hand description grammar embeds a colon (`One pair : Queens`) — a naive split on `:` for
   line-structure purposes (e.g. "everything before the first colon is the key") will misfire
   on showdown lines.
8. All-in is a suffix on an ordinary action line (` and is all-in`), not a distinct verb —
   strip the suffix before matching the verb, not after.
9. Encoding is not guaranteed to be UTF-8 (see §12) — sniff, don't assume.
10. Multi-hand files use a 5-blank-line separator, not 1.
11. The one corpus file literally named `OmahaHiLo.txt` is not a Winamax hand at all (it's a
    mislabeled iPoker-network XML export) — don't trust upstream test-fixture filenames as
    ground truth for either game type or even site of origin; always verify from the content.
12. There exists at least one genuinely malformed real-world-adjacent sample
    (`InValidHand.txt`, itself a corpus author's synthetic negative test, not a real Winamax
    export) with a misspelled site name and mangled markers — useful for validating that a
    parser's format-detection step correctly *rejects* garbage, but do not mine its grammar.

## 14. Sample index

See `fixtures/samples/winamax/SOURCES.md` for the full file-by-file table (27 files, all REAL,
all cash games, 2013-10 to 2015-03).

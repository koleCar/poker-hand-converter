# PokerStars hand history format

Status: a working, tested parser already exists against the 45 fixtures in
`fixtures/samples/pokerstars/`. This document is weighted toward the
**detection signature** (§2) and **gotchas** (§13) — the things a parser that
only ever saw a happy-path sample would get wrong — per an explicit priority
request from the coordinating session. The middle, "grammar of a normal hand"
sections are intentionally brisk; read the fixtures themselves for full
detail, this doc mostly tells you *where to look* and *what will break you*.

Every claim below is tagged REAL (backed by a byte-exact fixture in this
repo), TRANSCRIBED (backed by a fixture that is provenance-honest about being
lossy — see `fixtures/samples/pokerstars/SOURCES.md`), or INFERRED (secondary
source only — support docs, other parsers' source code, forum posts — no
fixture exists). Treat INFERRED claims as hypotheses to verify, not facts.

Two REAL fixtures were removed from the corpus during review for being
doctored/not-a-hand; see the "Note: file numbering has gaps" section of
`SOURCES.md` for exactly what was wrong with them and why. That review is
itself useful context for a parser author: it proves that "came from a
well-known open-source parser's test suite" is necessary but **not**
sufficient evidence that a sample is a byte-exact raw export — always check
seat-name/action-name agreement and uncalled-bet arithmetic yourself.

---

## 1. Overview & status

PokerStars hand histories are line-oriented, one blank-line-or-more-separated
blocks of plain text, one block per hand, written by the PokerStars client
itself when "Save My Hand History" is enabled (off by default — INFERRED,
from PokerStars/tracker support docs, no fixture demonstrates the opt-in UI).
There is no wrapping container format (no XML/JSON/CSV) — it is the same
free-text shape PokerStars has used since at least 2007, with the two
principal changes over that time being (a) the header line's literal prefix
and (b) minor punctuation/casing tweaks to individual action lines.

What's REAL in this corpus: cash Hold'em (NLHE/PLHE/FLHE) 2-max through
10-max, PLO and PLO Hi/Lo (NL/PL/FL), 7-Card Stud and Stud Hi/Lo, Razz,
5-Card Draw-family (Badugi, 2-7 Single Draw), Zoom/fast-fold (both header
styles — see §2), Home Games (play money), tournament MTT/STT/HU-SNG
including knockout-bounty and rebuy tournaments, run-it-twice, and
USD/EUR/GBP currencies plus a chips-only play-money notation. What's a gap:
**Spin & Go** (no real sample found anywhere — see `SOURCES.md`), a full
HORSE rotation, tournament run-it-twice, and a 1st-place `wins the tournament
and receives $X` line (we have plenty of "finished the tournament in Nth
place" but nothing that reaches the win).

## 2. Detection signature

**Primary signature (use this one):**

```regex
^PokerStars (Game|Hand|Zoom Hand|Home Game Hand) #\d+:
```

This is safe against every other network we've researched: no other site's
header contains the literal string `PokerStars`, and the `#<digits>:` shape
immediately after one of those four fixed words is consistent across every
REAL sample in this corpus regardless of era, currency, or game type. Anchor
it to the start of the line (or start of file, accounting for a possible
leading UTF-8 BOM `\xEF\xBB\xBF` — see §12) — do not anchor to start-of-string
across a whole multi-hand file, because a BOM only ever appears before the
*first* hand's header, never before subsequent hands in the same file (REAL,
files 27/28/33 and the fpdb tournament corpus).

**Four historical/product header variants, all REAL:**

| Literal prefix | Era / product (REAL evidence) | Example (REAL) |
|---|---|---|
| `PokerStars Game #` | Cash games, at least through 2014 (file 01, 2014/01/06); tournaments too (files 34-40, 2010-2011) | `PokerStars Game #109681344065:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 7:22:02 ET` |
| `PokerStars Hand #` | Cash, seen as early as 2012 (file 05/11, 2012) **and** 2013 (file 30, EUR) **coexisting** with `Game #` still in use in 2014 (file 01) — the rename is **not a clean chronological cutover**, don't gate other format decisions on which prefix a hand uses | `PokerStars Hand #78782145143:  Hold'em No Limit (£0.10/£0.25 GBP) - ...` |
| `PokerStars Zoom Hand #` | Fast-fold cash, REAL as early as 2014 (file 32, WET/ET) and as late as 2017 (file 31, UTC) | `PokerStars Zoom Hand #171598493667:  Hold'em No Limit ($0.01/$0.02) - 2017/06/10 17:17:14 UTC [...]` |
| `PokerStars Home Game Hand #` | Home Games club play, REAL 2020 (file 33) | `PokerStars Home Game Hand #215486308040: {Club #3225207}  Hold'em No Limit (50/100) - 2020/06/18 14:56:21 ET` |

**Gotcha inside the signature itself:** a Zoom table is not reliably
detectable from the header alone. File 02 is a genuine Zoom/fast-fold hand
whose header is the plain `PokerStars Game #...` form — the *only* tell is
the substring `Zoom` inside the single-quoted table name (`Table 'Triangulum
Zoom 40-100 bb' ...`). File 32/31 show the *other*, unambiguous form where
the header itself says `Zoom Hand #`. **A correct classifier must check
both** the header prefix and the table-name string; relying on either alone
under-detects Zoom hands from some client versions. (REAL, both forms
attested.)

**Tournament vs. cash is not a header-prefix distinction** — it's encoded
entirely in the free-text segment between the first `:` and the ` - ` before
the timestamp. A cash header's mid-section is just
`  <Game> (<stakes> <CCY>)`; a tournament header's is
`  Tournament #<id>, <buyin>+<fee> <CCY> <Game> - Level <roman-or-arabic>
(<sb>/<bb>)` (REAL, files 34-42) or, for a HU SNG match,
`Tournament #<id>, <buyin>+<fee> <CCY> <Game> - Match Round <N>, Level <N>
(<sb>/<bb>)` (REAL, file 35 — note the *extra* `Match Round N,` clause that
only appears for heads-up SNG matches, easy to miss if you only ever tested
against MTT/STT). Detect "is this a tournament" by searching for the literal
substring `Tournament #` right after the header's first colon-and-two-spaces,
not by any separate marker.

**Two-space rule:** every REAL header has **two spaces**, not one, between
the header colon and the game description: `PokerStars Hand
#124689908714:  Omaha Pot Limit (...)`. A regex written against a
single-spaced hand-transcribed example (easy to introduce by hand-typing a
test fixture) will silently fail on every real export.

## 3. Full verbatim example hands

See `fixtures/samples/pokerstars/01-cash-nlhe-6max-ante.txt` (cash) and
`fixtures/samples/pokerstars/34-tour-stt-nlhe-8bet-preflop-dualtimestamp.txt`
(tournament) for complete, byte-exact REAL examples — reproducing them here
would just be a stale copy that can drift from the fixtures. If you need a
Zoom, Home Game, run-it-twice, Stud, Razz, or Draw example verbatim, see
files 31/32, 33, 03, 44, 45, 46/43 respectively.

## 4. Header line grammar (brisk — see fixtures for exhaustive cases)

```
PokerStars <Kind> #<digits>:<sp><sp><GameDesc> - <timestamp>[ [<dual-timestamp>]]
```

- `<GameDesc>` for cash: `<Variant> (<SB>/<BB>[ - $<N> Cap - ] <CCY-code-or-omitted>)`
  — REAL variants seen: `Hold'em No Limit`, `Hold'em Limit` (no "No"/"Pot"
  qualifier — fixed-limit just says `Limit`), `Hold'em Pot Limit`, `Omaha Pot
  Limit`, `Omaha Hi/Lo Pot Limit`, `Omaha Hi/Lo No Limit`, `7 Card Stud Hi/Lo
  Limit`, `Razz Limit`, `Badugi Limit`. Cap games insert
  ` - $<N> Cap - ` with a **double space** before the currency code (file
  22: `($0.50/$1.00 - $20 Cap -  USD)`).
- Currency is expressed either as a 3-letter code after the amounts (`USD`,
  `EUR`, `GBP` all REAL) or, for play money, by omitting both the code and
  any symbol and using bare integers (REAL, file 37: `2000+110`, file 33:
  `50/100`). Symbol-prefixed amounts (`$`, `€`, `£`) are REAL; we found no
  `¥`-denominated sample (INFERRED that PokerStars supports it — not
  fixture-backed).
- `<GameDesc>` for tournaments: `Tournament #<id>, <buyin>+<fee>[+<bounty>]
  <CCY-or-omitted> <Variant> - Level <roman> (<sb>/<bb>)`. Knockout
  tournaments have a **three-part** buy-in, `buyin+fee+bounty` (REAL, file
  42: `$1.00+$0.25+$0.15 USD`). Mixed-game tournament legs prepend the
  rotation's outer name: `Mixed Hold'em (Hold'em Limit)` (REAL, file 39).
  Cap/mixed-betting tournaments can even mix betting structures in one
  string: `Hold'em Pot Limit Pre-Flop, No Limit Post-Flop` (REAL, file 36).
- Home Game header inserts a club tag right after the header colon and
  before the game description: `{Club #3225207}  Hold'em No Limit (50/100)`
  (REAL, file 33) — note it, too, uses the double-space-after-tag
  convention, mirroring the double-space-after-colon rule.

## 5. Table/seat lines, button, max seats, table name quoting

```
Table '<name>' <N>-max[ (Play Money)] Seat #<N> is the button
Seat <N>: <name> (<amount> in chips)[ is sitting out]
```

- `<name>` is single-quoted and may itself contain an apostrophe (REAL, file
  06: `Table 'Isildur's PLO 50' 2-max ...` — the field is **not** escaped,
  you cannot regex-match "up to the next `'`" naively).
- `(Play Money)` is appended right after the max-seats number, **only** on
  play-money tables (REAL, file 33). Its absence does not imply real money —
  cross-check the header's currency/chips notation too (see §4).
- **Stud/Razz tables have no button and no `Seat #N is the button` clause at
  all** — the table line is just `Table '<name>' <N>-max` (REAL, files
  44/45). Draw-family games (Badugi, 2-7) *do* have a button (REAL, file 46).
  A parser that unconditionally expects a button clause on the table line
  will fail on every Stud/Razz hand.
- Seat lines commonly end in a **trailing space** even when there is no
  suffix to follow (REAL, nearly every file, e.g. `Seat 1: Player_L ($47.26
  in chips) `) — but not always: 2011-era exports have no trailing space at
  all (REAL, files 07/08, both now labeled TRANSCRIBED but the no-trailing-
  space convention itself matches other untouched 2011 files too). Never
  `.rstrip()` and compare for exact equality against a hardcoded string.

## 6. Blinds, antes, straddle, dead blinds, sitting out

- `<name>: posts small blind <amt>` / `posts big blind <amt>` / `posts the
  ante <amt>` (REAL, ante: file 01). A player can post a blind **and** be
  simultaneously all-in: `posts big blind 20 and is all-in` (REAL, file 37).
- We found no REAL PokerStars sample of straddling or an explicit "posts
  small & big blind" combined-catch-up line (both exist on other sites in
  this repo's broader corpus, e.g. WinningPoker). Treat straddle support as
  INFERRED/unverified for PokerStars specifically.
- `<name>: is sitting out` can appear **for a player with no seat line at
  all** (REAL, files 07/12 — the player joined/was present too late or too
  briefly to get a seat line printed, then immediately `leaves the table` or
  the hand is `Hand cancelled`). Do not treat an action-line name absent
  from the seat block as automatically an error — see §13's consistency-
  check caveat.
- `<name>: has timed out` / `<name> is sitting out` / `<name> has returned`
  is a real three-step sequence for a disconnect-and-back player within a
  single hand (REAL, file 36). `<name> is disconnected` (no "has timed out"
  prefix) is a separate, REAL, simpler form (file 45). We found no REAL
  sample of the compound phrase "has timed out while disconnected" —
  INFERRED from other parsers' regexes only.

## 7. Street markers — exact spelling (REAL, exhaustive list found in corpus)

```
*** HOLE CARDS ***
*** DEALING HANDS ***          (draw/badugi games — not "HOLE CARDS")
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx Xx] [Xx]
*** FIRST DRAW ***  / *** SECOND DRAW ***      (draw games)
*** 3rd STREET *** / *** 4th *** / 5th / 6th / 7th   (stud/razz)
*** FIRST FLOP *** / *** SECOND FLOP ***       (run it twice)
*** FIRST TURN *** / *** SECOND TURN ***
*** FIRST RIVER *** / *** SECOND RIVER ***
*** SHOW DOWN ***               (note the SPACE — see gotcha below)
*** FIRST SHOW DOWN *** / *** SECOND SHOW DOWN ***
*** SUMMARY ***
```

**Cross-site confusion trap (leading with this because it's the single most
common bug we'd expect):** PokerStars spells it `*** SHOW DOWN ***` with a
space. GGPoker spells the equivalent marker `*** SHOWDOWN ***`, no space. If
your detector/parser is shared across sites, a hardcoded no-space string
will silently never match on PokerStars, and vice versa.

**Run-it-twice pot-counting trap (the other big one):** a run-it-twice hand
prints `*** FIRST SHOW DOWN ***` and `*** SECOND SHOW DOWN ***` as two fully
separate blocks, and **the same winning player's `collected` line appears
twice** — once per board (REAL, file 03: `FLATC@T collected $10 from side
pot` appears under both FIRST and SECOND SHOW DOWN, immediately followed by
`FLATC@T collected $1503.50 from main pot`, also duplicated). If you sum
every `collected` line in the hand to reconcile against `Total pot`, you
will double-count and be off by roughly the size of the pot. The `*** SUMMARY
***` total pot is the singular, correct total; the `collected` lines under
each `SHOW DOWN` block are each one board's *share* of that same total, not
additional money.

## 8. Action verbs — exact phrasing (brisk; see fixtures for full paradigm)

Standard: `folds `, `checks `, `calls <amt>`, `bets <amt>`, `raises <amt> to
<amt>` — note the **trailing space** after verbs with no argument (`folds `,
`checks `) is present on the overwhelming majority of REAL files but is
**not universal** (2011-era files 07/08 have no trailing space). Never
gate correctness on trailing whitespace; strip only for comparison, never
for round-trip byte reproduction.

Other REAL-attested phrasings, verbatim:
- `Uncalled bet ($<amt>) returned to <name>` — this is the single most
  important line to check for presence when validating whether a sample is
  a genuine raw export; see §13.
- `<name>: shows [Ah Kd] (a pair of Aces)` / `<name>: mucks hand ` /
  `<name>: doesn't show hand ` / a lone-card showdown `<name>: shows [Qc]`
  (REAL, file 20 — not every shown hand has the expected number of cards;
  don't assume 2 for Hold'em / 4 for Omaha inside a `shows` line without
  checking the actual variant and card count printed).
- `No low hand qualified` — its own bare line, between the last `shows`/
  `collected` line and `*** SUMMARY ***`, only in Hi/Lo games (REAL, files
  17/21).
- `<name>: brings in for <amt>` — Stud/Razz forced-bet verb, not a blind
  (REAL, files 44/45).
- `<name>: discards <N> card(s)[ [<cards>]]` — draw games; the discarded
  cards are **sometimes shown, sometimes not**, in the same file even (REAL,
  file 46: `discards 1 card` then later `discards 2 cards [8h 6s]`).
- `<name> joins the table at seat #<N> ` / `<name> leaves the table` —
  can fire for a player who never had (or no longer has, in the case of
  leaving) a seat line printed in this particular hand's header (REAL,
  files 09/19).
- `<name> wins the $<amt> bounty for eliminating <name2>` immediately
  followed by `<name2> finished the tournament in <Nth> place[ and received
  $<amt>.]` — both lines sit **between** the hand's last showdown/collect
  line and `*** SUMMARY ***`, not inside the summary block itself (REAL,
  file 42). The `and received $<amt>.` clause is only present when there was
  a real-money min-cash; a min-cash-less finish is just `finished the
  tournament in <Nth> place` with no trailing clause (REAL, file 37).
- `<name> re-buys and receives <N> chips for <amt>` — REAL for a rebuy
  tournament (file 40: `for £5.00`) and, in the wild-not-in-this-corpus
  case, `for N FPPs` per grep of the underlying fpdb source we mined
  (`NLHE-FPP-MTT-1r-201005.AllinLotsRebuy.txt`, not itself copied into this
  repo's fixtures — a further gap if a byte-exact FPP-rebuy fixture is
  needed later).
- We found **no REAL sample** of: rabbit hunting, cashout, insurance, "said,"
  disconnect chat suppression, or "was removed from the table for failing to
  post". The in-hand chat line **is** REAL though: `<name> said, "<text>"`
  (file 03: `FLATC@T said, "hehe"`) — note it has no colon after the name,
  unlike every action line, and the message is double-quoted verbatim
  (including whatever the player typed).

## 9. SUMMARY block layout

```
*** SUMMARY ***
Total pot <amt>[ Main pot <amt>. Side pot <amt>.] | Rake <amt> [trailing space, usually]
[Hand was run twice]
[FIRST Board [...] / SECOND Board [...]  |  Board [...]]
Seat <N>: <name>[ (button)][ (small blind)][ (big blind)] <result-phrase>
```

Side-pot summary shape is REAL and exact: `Total pot $3030 Main pot $3007.
Side pot $20. | Rake $3 ` (file 03) — note the periods after each sub-pot
amount and that `Main pot`/`Side pot` are only present at all when a side
pot existed; a plain hand just has `Total pot $X | Rake $Y`. A cancelled
hand's summary can be as short as one seat line with `collected ($0)` and no
`Total pot`/`Board` lines at all (REAL, file 12).

## 10. Date/time format and timezone convention

```
YYYY/MM/DD H:MM:SS <TZ>[ [YYYY/MM/DD H:MM:SS ET]]
```

REAL: the hour is **not zero-padded** (`0:40:18`, file 03). The bracketed
second timestamp, when present, is always labelled `ET` regardless of what
the primary timezone is — REAL primary-timezone abbreviations seen in this
corpus: `ET`, `CET`, `WET`, `PT`, `MSK`, `UTC`. Some REAL hands have **no**
bracketed second timestamp at all when the primary zone already is `ET`
(file 01) — the dual-timestamp form is not universal, only appears when the
primary zone differs from ET.

## 11. Anonymized-player conventions

PokerStars itself does not anonymize; every anonymization seen in this
corpus was introduced **upstream by the third-party repo we mined it from**,
not by PokerStars — see `SOURCES.md`'s per-file provenance column for which
files have `Player0`/`Player1`/... substituted for real usernames (this is
common in the `fpdb` tournament corpus, files 34-43) versus real usernames
kept (files 01-33, 44-46, 48). `Hero` as a literal username is real client
behavior (PokerStars itself writes `Hero` for the hand-history-owning
player's own seat in some export contexts) but is also sometimes used by
tracker tools as their own anonymization convention — do not assume every
`Hero` you see was written by the PokerStars client itself.

## 12. File naming, export directory, hands per file, encoding, line endings

- **Encoding/BOM:** most REAL files start with a UTF-8 BOM (`EF BB BF`), but
  this is **not universal** — file 41 has no BOM at all, byte-for-byte
  verified. Never require a BOM to detect a valid PokerStars file.
- **Line endings:** LF-only is common (most of the HHSmithy-derived files),
  but CRLF is also REAL (file 48, and the fpdb-derived `NLHE-USD-STT-...
  .ShowsOneCard.txt` source of file 41), and — the extreme case — **bare CR
  only, no LF anywhere in the file** is REAL (file 11, an old-Mac-style line
  ending; verify with `xxd`, a text editor will render it as one giant
  line). A byte-safe parser must split on `\r\n|\r|\n`, never assume `\n`.
- **Blank-line hand separator:** normally two hands in one file are
  separated by (at least) one fully blank line (REAL, file 27), but this is
  **not guaranteed** — file 28 is the same 10 hands with all blank-line
  separators stripped, so hand boundaries there are only detectable via the
  header regex from §2, never via blank lines alone.
- **File naming:** REAL evidence (from the *filenames* the exporting client
  itself produced, preserved verbatim by the MichlF corpus) follows
  `HH<YYYYMMDD> <table name> - <stakes> - <Game Type>.txt`, e.g. `HH20200618
  lets gooooo - 50-100 - Play Money No Limit Hold'em.txt`. Default export
  directory is INFERRED from tracker-support documentation, not from any
  fixture: Windows `%LOCALAPPDATA%\PokerStars\HandHistory\<username>\`, Mac
  `~/Library/Application Support/PokerStars/HandHistory/<username>/`. Local
  saving is off by default (INFERRED, same sources).

## 13. Gotchas

Ordered roughly by how likely each is to actually bite a parser, most
dangerous first:

1. **A missing `Uncalled bet ($X) returned to <name>` line is a strong
   signal the sample was transcribed (forum paste), not a raw export, even
   if the pot arithmetic still closes.** We found exactly this defect in two
   files during review (`fixtures/samples/pokerstars/07-...txt` and
   `08-...txt`, both now labeled `TRANSCRIBED (lossy)` in `SOURCES.md`).
   Real raw exports always print this line before the winner's `collected`
   line whenever the last aggressive action wasn't fully called. If you are
   evaluating whether a newly-found "PokerStars hand" sample is trustworthy
   ground truth, this is the fastest single check to run.
2. **Run-it-twice double-counts naively summed `collected` lines** — see §7.
   This is the highest-value single fact in this document for someone
   writing pot-reconciliation logic.
3. **`*** SHOW DOWN ***` (PokerStars, space) vs `*** SHOWDOWN ***` (GGPoker,
   no space)** — see §7. Also: `PokerStars Zoom Hand #` vs plain `PokerStars
   Game #` with just a `Zoom` substring in the table name — a Zoom detector
   must check both (§2).
4. **Seat-block names and action-line names can legitimately disagree** for
   a player who joined/left too late/early to get a seat line — but they
   must **never** disagree for a player who *does* have a seat line. We
   found one REAL-looking file that violated exactly this (mismatched
   `neverJa(1)ger`/`neverJager` and `Blahdi:42eblah`/`Blahdieblah` for
   players who *did* have seat lines) and removed it as doctored rather than
   trust it — see `SOURCES.md`. Any future "PokerStars sample" acquired from
   an untrusted source should be checked the same way before being trusted:
   diff the set of names in `Seat N: <name> (...)` lines against the set of
   names immediately before `:` in action lines; every action name should
   either be in the seat set or be independently explained by a
   join/leave/sitting-out/cancelled-hand line (§6).
5. **Player names can contain almost any printable character** — colons
   (`wo_olly :D`, file 05), slashes and square brackets (`/\ntiHer[]`, file
   04), `@` (`FLATC@T`, file 03), apostrophes (`d'okairon`, file 31), spaces
   (`Poker Elfe 1`, seen in the fpdb KO tournament corpus), and mis-decoded
   multi-byte currency glyphs that survive as mojibake inside a name from a
   different encoding pass upstream (`SW_KaiZâ‚¬R`, file 09 — verified this
   is in the *source* file, not something we introduced). Never assume a
   colon, bracket, or the string `folds`/`posts`/`checks` appearing inside
   what you think is a name field means you've mis-parsed a line boundary —
   it might just be the name.
6. **Amounts have no universal decimal convention.** USD/EUR/GBP cash amounts
   have 2 decimal places when fractional (`$0.05`) but bare integers when
   whole (`$1`, not `$1.00`) — REAL, mixed within the same file (file 01:
   `$0.05` and `$0.10` both appear, but file 03 has bare `$10`/`$20`).
   Tournament/play-money chip amounts are always bare integers with **no**
   currency symbol and **no** thousands separator (`77568`, file 42's KO
   hand) — do not assume a comma-grouped thousands separator ever appears;
   none was found in this corpus.
7. **BOM and line-ending presence are both inconsistent within the same
   corpus, sometimes within files that are otherwise identical in shape**
   (§12). Detect the header regex first; do not gate detection on BOM
   presence, and do not assume any single line-ending style when computing
   byte offsets or re-serializing a hand.
8. **The `PokerStars Game #` → `PokerStars Hand #` rename is not a clean
   chronological cutover** — REAL evidence has `Hand #` in use in 2012/2013
   while `Game #` is still in use in 2014 (§2). Do not use the header prefix
   alone to infer a hand's date, and do not assume any dataset's files are
   sorted by which prefix they use.
9. **Stud/Razz tables have no button line at all** (§5) — a parser that
   requires a `Seat #N is the button` clause on every table line will throw
   on 100% of Stud/Razz hands.
10. **A hand can be missing its entire `*** SUMMARY ***` block** — file 13
    is a REAL, genuinely truncated/invalid export (ends right after the last
    action line with an `is disconnected` and no summary at all). A parser
    that assumes every well-formed hand has a summary block will need an
    explicit "invalid/incomplete hand" path, because real captured data
    contains these.
11. **A hand can be `Hand cancelled`** before dealing even starts, with an
    abbreviated seat list and a summary containing only a `collected ($0)`
    line and no board/pot-total lines (REAL, file 12).
12. **Localized (non-English) PokerStars client output was actively
    searched for and not found.** One candidate file had a Cyrillic
    *filename* but 100% English *content* (removed from this corpus for
    being misleading — see `SOURCES.md`). Do not assume localization
    exists in a particular shape (e.g. translated street markers) without a
    real sample; treat any such claim elsewhere as unverified.
13. **Spin & Go format is entirely unverified.** Every "PokerStars Spin & Go
    hand history" found during a broad GitHub/web search was itself a
    fabricated test fixture from another developer's project (sequential
    fake hand IDs, dates far in the future). We deliberately did not copy
    any of them into this repo's fixtures. If a Spin & Go parser is needed,
    treat it as "probably a normal 3-max hyper-turbo tournament header,
    exactly like §4's tournament grammar" as a hypothesis only, not a fact.

## 14. Sample index

See `fixtures/samples/pokerstars/SOURCES.md` for the authoritative,
per-file table (provenance URL, retrieval date, REAL/TRANSCRIBED status,
excerpting notes, and what each file demonstrates) — duplicating it here
would only create a second copy to keep in sync. As of this writing there are
**45 files** in `fixtures/samples/pokerstars/` (numbered 01-48 with gaps at
18, 29, and 47 — see `SOURCES.md` for why those three were removed after
review), covering cash Hold'em/Omaha/Stud/Razz/Draw/Badugi, Zoom (both header
styles), Home Games, and tournament MTT/STT/HU-SNG including knockout-bounty
and rebuy tournaments. Zero files are SYNTHETIC.

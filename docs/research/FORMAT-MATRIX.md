# Hand history format matrix

At-a-glance comparison of every hand-history dialect we have investigated, plus
the analysis of which ones can share a parser.

**How to read the confidence column.** Every row is marked with how the facts in
it were established:

- **verified** — derived mechanically from real sample files now in
  `fixtures/samples/<site>/`. Trust these.
- **secondary** — documented from forum posts, vendor docs or third-party
  parser source, without a real sample in hand. Plausible, not proven.
- **none** — no trustworthy sample and no reliable documentation found. Treat
  every cell in the row as a guess. **Do not write a parser off a `none` row.**

Per-site detail lives in `docs/research/hh-formats/<site>.md`. Build-order
recommendations live in `COVERAGE-PLAN.md`.

---

## 1. Core structure

| Site | Conf. | Container | Header line opener | Street markers | Showdown marker |
|---|---|---|---|---|---|
| **PokerStars** | verified | plain text | `PokerStars Hand #<id>:` / `Game #` / `Zoom Hand #` | `*** HOLE CARDS ***`, `*** FLOP *** [x y z]`, `*** TURN *** [..] [x]` | `*** SHOW DOWN ***` (**space**) |
| **WePlay** | verified | plain text | `Weplay Hand #<id>:` | same as PokerStars | `*** SHOW DOWN ***` |
| **GGPoker** | verified | plain text | `Poker Hand #<prefix><id>:` | same as PokerStars | `*** SHOWDOWN ***` (**no space**) |
| **WPT Global** | secondary | plain text | `WPT Global Hand #<id>:` — PokerStars-family, **not** GG-derived | PokerStars-style | PokerStars-style |
| **CoinPoker** | verified | plain text | `CoinPoker Hand #<id>:` | `*** HOLE CARDS ***`, `*** FLOP *** [x y z]`, plus `*** HAND CANCELLED ***` | `*** SHOW DOWN ***` (**space**) |
| **partypoker** | verified | plain text | `***** Hand History for Game <id> *****` | `** Dealing down cards **`, `** Dealing Flop ** [ Qs, 7h, 2s ]` | none — no showdown marker |
| **888poker** | verified | plain text | `***** 888poker Hand History for Game <id> *****`, preceded by `#Game No : <id>` | `** Dealing down cards **`, `** Dealing flop **` (**either casing**) | `** Summary **` only |
| **Winamax** | verified | plain text | `Winamax Poker - CashGame - HandId: #a-b-c -` | `*** ANTE/BLINDS ***`, `*** PRE-FLOP ***`, `*** FLOP *** [3c 7d 2s]` | `*** SHOW DOWN ***` |
| **Full Tilt** | verified | plain text | `Full Tilt Poker Game #<id>: Table <name> (6 max) - ...` | `*** HOLE CARDS ***`, `*** FLOP ***` | `*** SHOW DOWN ***` |
| **ACR / WPN** | verified | plain text | `Game started at: <ts>` then `Game ID: <id> <stakes> <table>` | `*** FLOP ***: [3h 4c 2c]` (**colon after stars**) | none — `------ Summary ------` |
| **OnGame** | verified | plain text | `***** History for hand <id> *****` | `---` then `Dealing pocket cards` | none — `Summary:` |
| **Entraction** | verified | column-aligned text | `Game # <id> - Texas Hold'em No Limit EUR 0.50/1.00 - Table "X"` | `Flop    6d - 8d - 9h` | none |
| **iPoker** | verified | **XML** | `<session sessioncode=...><general><gametype>` | `<round no="0">` … `<round no="4">` | n/a — structural |
| **Merge** | verified | **XML** | `<description type="Holdem" stakes=.../><game id=...>` | `<round id="PREFLOP" sequence="2">` | `<round id="SHOWDOWN">` |
| **MicroGaming** | verified | **XML** | `<Game hhversion="4" id=... tablename=...>` | `<Action seq=... type="SmallBlind">` | n/a — structural |
| **BossMedia** | verified | **XML** | `<HISTORY ID=... TABLE=... GAME="GAME_OMA">` | `<ACTION TYPE="HAND_BLINDS">` | n/a — structural |
| **Ignition / Bodog / Bovada** | verified | plain text | `Ignition Hand #<id> Zone Poker ID#<n> HOLDEMZonePoker No Limit - <ts>` | `*** HOLE CARDS ***`, `*** FLOP *** [x y z]` | *see site doc* |
| **Chico (TigerGaming/BetOnline)** | verified | plain text | `<SkinBrand> Game #<id>: Hold'em - <ts>` | *see site doc* | *see site doc* |
| **Unibet** | verified (5 files) | plain text | modern `Unibet Hand #<id> - …`; legacy `Game #<id>: Table <cur><n> <limit> - …` | *see site doc* | *see site doc* |
| **PPPoker** | verified negative | **no native text export** | N/A | — | — |
| **Pokerbros** | verified | plain text, **two dialects** | A: `***** Hand History for Game <id> ***** (PokerBros)`; B: *see site doc* | Dialect A is partypoker-shaped | *see site doc* |
| **Run It Once** | *see site doc* | plain text | `Run It Once Poker (Hand\|Tournament) #<id>` | *see site doc* | *see site doc* |
| **PokerTracker 4 / HM3** | *see site doc* | re-emits site text | n/a | n/a | n/a |

Where a cell says *see site doc*, the site doc in `hh-formats/` is authoritative
and more detailed than this table can be; if the two ever disagree, the site doc
wins. Every site listed here now has a doc.

## 2. Semantics

| Site | Conf. | Card sep. | Currency placement | Anonymisation | Run it twice | Ante model | Rake / fee line | Tournaments |
|---|---|---|---|---|---|---|---|---|
| **PokerStars** | verified | `[Qh Jc 3h]` space | `$0.05/$0.10 USD` prefix + code | none | yes — `*** FIRST/SECOND FLOP ***` **and** `*** FIRST/SECOND SHOW DOWN ***` | per-player `posts the ante` | `Total pot $1.27 \| Rake $0.06` | yes (no local sample) |
| **WePlay** | verified | `[7s 2c]` space | `$` prefix; **bare integers in tournaments** | none | yes — boards only, single `SHOW DOWN` | per-player ante; bomb pots use ante and **no blinds** | `Total pot X \| Rake Y` — **rake not deducted** | yes — verified |
| **GGPoker** | verified | `[5s 8c]` space | `$` prefix | **7–8 char hex ids**; hero literal `Hero` | yes — and **three runs exist** (`run.it.thrice`) | per-player ante; Short Deck uses a single stake | **four shapes**, tail fields optional: `Total pot $N` / `+ \| Rake` / `+ \| Jackpot \| Bingo` / `+ \| Fortune \| Tax` | yes — `#TM` prefix, verified |
| **partypoker** | verified | `[ Qs, 7h, 2s ]` **comma + padding** | `[$0.05 USD]` bracketed, suffixed code | none | not observed | not observed | not in corpus | not in corpus |
| **888poker** | verified | `[ Jc, Kc, 3c ]` **comma + padding** | `[$0.05]` bracketed, no code | none | not observed | not observed | not in corpus | not in corpus |
| **Winamax** | verified | `[3c 7d 2s]` space | **trailing** `0.50€` | none | not observed | `*** ANTE/BLINDS ***` section | `Total pot 14.02€ \| Rake 0.98€` | yes (no local sample) |
| **CoinPoker** | verified | `[Jd 6c 5h]` space; SUMMARY board is **padded** `[ Jd 6c 5h ]` | **none at all** — bare decimals; `₮` only in table names | none | not observed | per-player ante, `(sb/bb ante N play)` in header | `Total pot X \| Rake Y` (2 fields) | yes — verified |
| **Full Tilt** | verified | `[..]` space | `$` prefix | none | yes — `RunItTwiceTests` fixture | `Ante.txt` fixture | `Total pot $0.10 \| Rake $0` | yes (no local sample) |
| **ACR / WPN** | verified | `[3h 4c 2c]` space | bare `(0.10)` parenthesised, no symbol | none in corpus | not observed | not observed | `Pot: 7.73. Rake 0.41` | not in corpus |
| **OnGame** | verified | space | `$` prefix | none | no | no | `Rake taken: $0.00` | not in corpus |
| **Entraction** | verified | `6d - 8d - 9h` **dash-separated** | `EUR 100.00` prefixed code | none | no | no | `Rake:    EUR 0.70` | not in corpus |
| **iPoker** | verified | `<cards>X X</cards>` | `chips="$326.20"` attribute | none | n/a | n/a | attribute-based | not in corpus |
| **Merge** | verified | XML attribute | `balance="$33.81"` | none | n/a | n/a | attribute-based | not in corpus |
| **MicroGaming** | verified | XML attribute | `stakes="0.01\|0.02"` + base64 symbol | base64 `unicodealias` alongside `alias` | n/a | n/a | `rake="0"` attribute | `istournament="0"` flag |
| **BossMedia** | verified | `<CARD LINK="b">` | `STAKES="100.00/200.00"` + `TABLECURRENCY="SEK"` | none | n/a | n/a | attribute-based | `TABLETOURNEYID` attribute |

## 3. Detection signals

The shipped parser layer scores candidates with `detect(text) => 0..1` and picks
the best, rather than matching one boolean regex
(`frontend/src/lib/phf/detect.ts`). So each site gets a **strong** signal and,
where one exists, a corroborating **weak** signal plus the thing it is most
likely to be confused with.

| Site | Conf. | Strong signal | Corroborating | Confusable with |
|---|---|---|---|---|
| **PokerStars** | verified | `/^PokerStars (Zoom \|Home Game )?(Hand\|Game) #\d+:/m` | `*** SHOW DOWN ***` spelling; ` in chips) ` trailing space | GG and WePlay share the body grammar but not the opener |
| **WePlay** | verified | `/^Weplay Hand #\d+:/m` | `(Money 3)` on table line | nothing — unique token |
| **GGPoker** | verified | `/^Poker Hand #[A-Z]{2}\d+:/m` — the two-letter prefix encodes **game type**, not skin (`HD`, `RC`, `OM`, `SD`, `TM`, `AF` all observed) | `\| Jackpot \| Bingo` in the rake line; `*** SHOWDOWN ***` no space; hex player ids | **PokerStars** — `Poker Hand #` is generic. Note the rake tail is optional, so absence of `Jackpot` does not rule GG out; the prefixed hand id is the reliable signal |
| **partypoker** | verified | `/^\*{5} Hand History for Game \d+ \*{5}$/m` | `** Dealing down cards **`; no `** Summary **` | **888poker** — same banner shape |
| **888poker** | verified | `/^\*{5} 888poker Hand History for Game \d+ \*{5}$/m` | preceding `#Game No : \d+` line; `** Summary **` present | **partypoker** — differs only by the `888poker` token and the Summary marker |
| **Winamax** | verified | `/^Winamax Poker - /m` | `*** ANTE/BLINDS ***`; trailing-`€` amounts; `Board: [` with colon | nothing |
| **CoinPoker** | verified | `/^CoinPoker Hand #\d+:/m` | stakes group with a **space before `)`**; no ` - ` before the timestamp; `Game ended: ` in SUMMARY | nothing once the header matches |
| **Ignition/Bovada** | verified | `/^(Ignition\|Bovada\|Bodog) Hand #\d+/m` | `Card dealt to a spot`; `Set dealer [N]`; positional pseudo-names | nothing |
| **Full Tilt** | verified | `/^Full Tilt Poker Game #\d+:/m` | `The button is in seat #\d+`; `Uncalled bet of ` | nothing |
| **ACR / WPN** | verified | `/^Game ID: \d+ /m` preceded by `/^Game started at: /m` | `Player .+ received a card\.`; `------ Summary ------` | nothing — very distinctive |
| **OnGame** | verified | `/^\*{5} History for hand \S+ \*{5}$/m` | `Players in round:`; `Rake taken:` | partypoker's `*****` banner — different wording |
| **Entraction** | verified | `/^Game # \d+ - /m` | `Players(max \d+):`; column padding | nothing |
| **iPoker** | verified | `/<session sessioncode=/` | `<tablecurrency>`, `<ipoints>` | other XML — `<ipoints>` is unique |
| **Merge** | verified | `/<description type=.* stakes=/` | `<round id="BLINDS"` | Merge vs iPoker both XML; root element differs |
| **MicroGaming** | verified | `/<Game hhversion=/` | `unicodealias=` base64 | nothing |
| **BossMedia** | verified | `/<HISTORY ID=.*GAMEKIND=/` | `GAME="GAME_OMA"` style enums | nothing |

---

## 4. Which sites can share a parser

This is the question that decides how much code gets written. The honest answer
is that the "everything is a PokerStars clone" intuition is **wrong** — it holds
for exactly one family, and that family is smaller than it looks.

### Family A — the PokerStars text family (one parser, dialect switches)

**PokerStars, WePlay, GGPoker, WPT Global.**

These genuinely share a grammar: `Seat <n>: <name> ($<x> in chips)`,
`<name>: <verb> <amount>`, `*** <STREET> *** [cards]` with space-separated
two-character cards, `Uncalled bet ($x) returned to <p>`,
`Total pot X | Rake Y`, and a `Seat n: <name> (<position>) <outcome>` summary.
A single tokeniser handles all four. The dialect switches needed are small and
enumerable:

- showdown marker spelling (`SHOW DOWN` vs `SHOWDOWN`)
- rake line field count (2 vs 6)
- run-it-twice shape: PokerStars and GGPoker emit **per-run showdown blocks**
  (`*** FIRST SHOW DOWN ***` / `*** FIRST SHOWDOWN ***`) with a `collected` line
  inside each, so a winner collects twice and a naive sum double-counts the pot;
  WePlay emits the two boards but only **one** showdown block
- the `raises X to Y` semantic (see below — this one is not cosmetic)
- anonymisation (GG hex ids, none elsewhere)
- high-card phrasing (`(Ace high)` GG vs `(high card Ace)` PokerStars/WePlay)

**The one that is not a cosmetic switch** is WePlay's `raises X to Y`, where `X`
is the chips the player *adds*, not the raise increment over the current bet
(verified on 6766 of 6771 raises). PokerStars and GGPoker use the increment. A
shared parser must drive off `Y` — the post-action street total, which is
unambiguous in every dialect — and never off `X`. Any implementation that
carries `X` through will produce silently wrong bet sizing on one dialect while
passing all tests on the other two.

Full Tilt is a **near-member**: same skeleton, but the table name lives in the
header instead of a `Table '...'` line, the button is declared *after* the
blinds (`The button is in seat #6`), uncalled bets read `Uncalled bet of $x`
rather than `($x)`, wins read `wins the pot ($x)`, and summary seat lines can
carry two comma-joined outcomes (`collected ($0.10), mucked`). Worth attaching
to Family A as a fifth dialect only if Full Tilt is ever wanted; it is a dead
site, so the answer is probably no.

### Family B — the `***** Hand History for Game *****` family (one parser, two dialects)

**partypoker, 888poker.**

Structurally near-identical to each other and *completely unlike* Family A:
comma-separated padded cards (`[ Qs, 7h, 2s ]`), bracketed amounts
(`posts small blind [$0.05 USD].`), `** Dealing Flop **` street markers, a
`Total number of players : 9/9` line, seat lines in **arbitrary order** rather
than seat order, and no `*** SUMMARY ***` at all — partypoker just ends with
`<player> wins $0.53 USD`. A Family A parser shares literally no regex with
these. One parser covers both, with the dialect switches being the `888poker`
banner token, the leading `#Game No :` line, the presence of `** Summary **`,
and the USD currency-code suffix.

Two traps here that are easy to miss from a single sample: 888 uses **both**
`** Dealing Flop **` and `** Dealing flop **` casings within its own corpus, so
matching must be case-insensitive; and partypoker interleaves table events like
`rickybobby83 has left the table.` into the action stream.

**Pokerbros joins this family**, which is the most useful clustering result from
the later research. Its Dialect A is
`***** Hand History for Game <id> ***** (PokerBros)` — the partypoker banner with
a brand token appended. That makes a club app, which we had assumed would need
bespoke work, close to free once Family B exists. The trailing `(PokerBros)` is
also what disambiguates it from genuine partypoker, so the family parser needs a
brand-token capture rather than a bare banner match. Pokerbros has a second,
unrelated dialect as well; see `hh-formats/pokerbros.md`.

### Family C — XML (one parser each; no sharing)

**iPoker, Merge, MicroGaming, BossMedia.**

All four are XML, and that is the entire extent of their similarity. The
schemas are unrelated: iPoker uses `<round no="N">` with numeric `type` codes on
`<action>`; Merge uses `<round id="PREFLOP">` with string `type="SMALL_BLIND"`
event names; MicroGaming uses a flat `<Action seq type="SmallBlind">` list plus
base64-encoded table and player names alongside the plain ones; BossMedia uses
`<ACTION TYPE="HAND_BLINDS" KIND="HAND_SB">` with enum-style values and
`<CARD LINK="b">` children for face-down cards.

They share an XML *parser* but not a hand *parser*. The real win is that XML
removes the entire class of whitespace and player-name-tokenising bugs that
dominates the text formats — these are the easiest formats to get correct, just
not shareable with each other.

### Family D — genuinely their own thing (one parser each)

- **Winamax.** Closest to Family A in skeleton but diverges everywhere it
  counts: `*** ANTE/BLINDS ***` and `*** PRE-FLOP ***` markers that Family A
  lacks, currency **suffixed** to every amount (`0.50€`), a colon on the summary
  board line (`Board: [...]`), and French-derived hand descriptions
  (`(One pair : 3)`) that will not match any English hand-description table.
  Attaching it to Family A costs more in conditionals than writing it standalone.
- **ACR / WPN.** Not a PokerStars clone despite frequent claims that it is.
  `Game started at:` / `Game ID:` header pair, every action line prefixed
  `Player `, hole cards dealt one line per card (`Player X received a card.`),
  `*** FLOP ***: [..]` with a colon after the stars, bare parenthesised amounts
  with no currency symbol, and an `------ Summary ------` block with per-player
  `Bets: / Collects: / Loses:` accounting. Also emits run-together text with no
  separating space (`does not show cards.Bets: 0.25.`).
- **OnGame.** `***** History for hand R5-... *****`, `---` street separators,
  `Main pot: $1.00 won by Dbcee89 ($1.00)`, and a summary that reports per-seat
  `net:` deltas rather than contributions.
- **Entraction.** Column-aligned fixed-width text, dash-separated board
  (`6d - 8d - 9h`), `Payback` instead of an uncalled-bet return, and a trailing
  `Game ended 2012-05-30 15:49:35 GMT+01:00`. Fixed-width alignment means
  player names are **space-padded**, so naive whitespace splitting mangles them.

### What this means for effort

Four text parsers (Family A, Family B, Winamax, ACR) plus four XML parsers cover
every dialect we have verified samples for. Of those, Family A and Family B are
the only ones where a second site is nearly free once the first is written.

CoinPoker joins **Family A** — its body grammar is PokerStars-shaped and it is
the cheapest remaining high-traffic addition, though it needs its own header
regex and several wording overrides (see `hh-formats/coinpoker.md`).

Ignition/Bodog/Bovada is confirmed as its own thing and resists the analysis
entirely, because positional pseudo-names instead of player names is a property
no other dialect has — the difficulty there is in the data model, not the
tokeniser.

Unibet, Pokerbros and Run It Once, listed here in an earlier revision as
unsampled, all have corpora and shipping parsers now; they are placed in the
families above. The only sites that still cannot be placed in this analysis are
**WPT Global** (no obtainable sample — the room removed export in June 2026) and
**PPPoker** (no native text format exists to classify).

---

## 5. Encoding is a corpus-wide property, not a per-site quirk

Three separate site research passes each independently hit an encoding problem
and each wrote it up as their own site's oddity. It is not. Scanning every
fixture in the corpus shows a consistent cross-cutting picture that a site doc
cannot see:

| encoding | files | sites |
|---|---|---|
| valid UTF-8 (with or without BOM) | 391 | everything else |
| **Windows-1252** (raw `0x80` = `€`) | 8 | Winamax 4, MicroGaming 3, Unibet 1 |
| **UTF-16LE with BOM** (`FF FE`) | 14 | ACR/WPN |

Four consequences worth designing the file-read path around, rather than
patching per site:

1. **A converter that assumes UTF-8 is wrong on 22 of 413 real files (5%).**
   These are genuine exports, not corpus damage.
2. **Encoding does not correlate with era, site, or game type.** In the ACR
   corpus a 2016 UTF-16LE file sits beside a 2016 ASCII file of identical
   grammar. You cannot infer the encoding from anything except the bytes.
3. **Sniffing for `0x80` is the wrong test — it both over- and under-detects.**
   It misses the 14 UTF-16LE files entirely (they contain no `0x80`), and it
   false-positives on valid UTF-8: `fixtures/samples/weplay/04-tournament-mtt-ante-9max.txt`
   contains 78 `0x80` bytes and is perfectly valid UTF-8, because `0x80` is a
   legal continuation byte — there, part of the en dash `–` (`E2 80 93`) in a
   tournament name. The correct test is "attempt a strict UTF-8 decode; on
   failure, check for a `FF FE`/`FE FF` BOM, else try Windows-1252".
4. **Every one of the 14 UTF-16LE files has an odd byte length** — a truncated
   final code unit. A lenient reader ignores the stray byte; a strict
   `utf-16-le` decoder throws on all 14. Decode with error tolerance on the
   final unit.

Per-file detail lives in each site's `SOURCES.md`
(`winamax`, `microgaming`, `unibet`, `acr-wpn`).

## 6. Known gaps in this matrix

Recorded explicitly so they are not mistaken for coverage:

- **Tournament coverage, once the biggest hole here, is now broad.** Nine sites
  have real tournament fixtures: Ignition 28, ACR/WPN 11, PokerStars 10,
  GGPoker 7, CoinPoker 5, Chico 4, Run It Once 2, Unibet 2, WePlay 2 — including
  bounty/KO, satellites, rebuys, freerolls and ante structures.
  Still cash-only: **partypoker, 888poker, Winamax, OnGame, Entraction, Merge,
  MicroGaming and BossMedia.** For those eight, tournament headers, bounty
  awards, level changes and finishing positions remain unverified.
  (Note for anyone grepping: MicroGaming and BossMedia carry `istournament="0"`
  and `TABLETOURNEYID=""` on every hand — those attributes are present but empty,
  so a naive search for "tournament" false-positives on the entire corpus.)
- **Era skew.** The HHSmithy-derived corpus is roughly 2012–2015. partypoker and
  888 have both been through platform changes since. Anything marked verified
  for those two is verified *for that era*.
- **No verified samples at all** for WPT Global, PPPoker, and the GG skins
  Natural8 / BestPoker / ClubGG. See the individual site docs and
  `COVERAGE-PLAN.md` §2.
- **Two corpora exist with no parser:** `merge` (12 files, tractable — the
  cheapest remaining pickup) and `bossmedia` (10 files, blocked on suit
  labelling: the rank half of the numeric card ID is solved, but the corpus
  contains no flush, so which suit index means which suit is unconstrainable
  from it). `phh` (4 files) is an interchange spec, not a site.
- **WPT Global cannot be sampled going forward.** The room removed hand-history
  export in June 2026, so only pre-June-2026 exports can exist at all.
- **The GG skin question is answered without a skin sample.** A dedicated
  Natural8 converter's entire transformation is
  `"Poker Hand #RC" -> "PokerStars Hand #20"`, which means Natural8 emits the
  same header shape as GGPoker with no skin branding. The two-letter hand-id
  prefix encodes **game type** (`HD`, `RC`, `OM`, `SD`, `TM`, `AF`), not skin.
  Recorded as secondary evidence: converter source plus reporting, not an export.

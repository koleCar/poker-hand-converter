# CoinPoker — hand history format

## 1. Overview & status

**Status: verified from a large real corpus.** Everything below was derived
mechanically from real CoinPoker client exports shipped in the public repo
[`nlin1027/CoinPoker-HUD-WIP`](https://github.com/nlin1027/CoinPoker-HUD-WIP)
— roughly 4.2 million lines of raw log across five files, covering cash and
tournaments from 2024-11 to 2026-01. The curated fixture set is in
`fixtures/samples/coinpoker/` (16 files, all REAL, all machine-verified
byte-exact against the source); see that directory's `SOURCES.md`.

Claims that are *not* backed by a real sample are marked **(inferred)** inline.
Things the corpus proves absent are in §14 as negative findings — treat those as
*unknown*, not as *proven absent from the format*.

**Why this site matters.** Public traffic trackers for 2026 put CoinPoker at
roughly 2,016 concurrent cash players against PokerStars' 2,198 — the same tier
by that metric. It currently has no parser.

**Family: PokerStars-derived.** CoinPoker sits in the same family as PokerStars,
WePlay and GGPoker (see `FORMAT-MATRIX.md` §4): `Seat n: name (x in chips)`,
`name: verb amount`, `*** STREET *** [cards]`, `Uncalled bet (x) returned to p`,
`Total pot x | Rake y`, `Seat n: name (position) outcome`. A PokerStars parser
gets most of the way. The divergences are listed in §13 and several of them
change *numbers*, not just strings.

---

## 2. Detection signature

**Strong signal:**

```regex
/^CoinPoker Hand #\d+:/m
```

Unambiguous — no other room emits the literal `CoinPoker Hand #`. Verified on
every hand in a ~4.2M-line corpus.

**Corroborating signals**, useful for a graded confidence score (the parser
registry scores `detect(text) => 0..1` rather than matching one boolean):

- `\(\d+\.?\d*\/\d+\.?\d* \)` — the stakes group has a **space before the
  closing paren**, which PokerStars never emits.
- No ` - ` between the stakes group and the timestamp (PokerStars has one).
- `Game ended: ` line inside the SUMMARY block — unique among the family.
- `₮` (U+20AE, Tether) in table names on cash tables.
- Amounts carry **no currency symbol at all**.

**Confusable with:** nothing, once the header matches. Before the header
matches, the body alone would score as PokerStars — so do not detect CoinPoker
on body features.

---

## 3. Full verbatim example hands

### 3.1 Cash

From `fixtures/samples/coinpoker/01-cash-multi-hand-baseline.txt`:

```
CoinPoker Hand #256459677: Hold'em No Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT
Table 'NL ₮2 IV' 7-max Seat #1 is the button
Seat 1: Vandalar (2.67 in chips)
Seat 2: SpaceBird (2.63 in chips)
Seat 3: ANeed4AName (3.52 in chips)
Seat 4: wornsothin (2.00 in chips)
Seat 5: Miyamoto (2.00 in chips) out of hand
Seat 6: Marvin1 (2.00 in chips)
Seat 7: nlin (1.85 in chips)
SpaceBird: posts small blind 0.01
ANeed4AName: posts big blind 0.02
*** HOLE CARDS ***
Dealt to nlin [5d 9c]
wornsothin: raises 0.03 to 0.05
Marvin1: folds
nlin: folds
Vandalar: folds
SpaceBird: folds
ANeed4AName: raises 0.11 to 0.16
wornsothin: calls 0.11
*** FLOP *** [Jd 6c 5h]
ANeed4AName: checks
wornsothin: checks
*** TURN *** [Jd 6c 5h] [5c]
ANeed4AName: bets 0.21
wornsothin: folds
Uncalled bet (0.21) returned to ANeed4AName
ANeed4AName collected 0.31 from pot
ANeed4AName: doesn't show hand
*** SUMMARY ***
Total pot 0.33 | Rake 0.02
Board [ Jd 6c 5h 5c ]
Game ended: 2025/06/19 18:53:39 GMT
Seat 1: Vandalar (button) folded before Flop (didn't bet)
Seat 2: SpaceBird (small blind) folded before Flop
Seat 3: ANeed4AName (big blind) collected (0.31)
Seat 4: wornsothin folded on the Turn
Seat 5: Miyamoto folded before Flop (didn't bet)
Seat 6: Marvin1 folded before Flop (didn't bet)
Seat 7: nlin folded before Flop (didn't bet)
```

Note three things that differ from PokerStars in this one hand: the stakes group
`(0.01/0.02 )` has a trailing space and there is **no ` - `** before the
timestamp; the seat line for Miyamoto carries an `out of hand` suffix *after*
the closing paren; and `Board [ Jd 6c 5h 5c ]` is space-padded inside the
brackets while `*** FLOP *** [Jd 6c 5h]` on the same hand is not.

### 3.2 Tournament

From `fixtures/samples/coinpoker/15-tour-hand-cancelled.txt` — a cancelled hand,
which also shows the tournament header and ante grammar:

```
CoinPoker Hand #185509980: Tournament #1287772, Bankroll Starter Freeroll Hold'em No Limit (400/800 ante 100 play) 2024/12/23 16:35:17 GMT
Table '12' 7-max Seat #1 is the button
Seat 1: karimaharran (43966 in chips)
Seat 2: HimemoriLuna (1035 in chips)
Seat 3: Gurujeee6445 (310 in chips) is sitting out
Seat 4: Bareis (14486 in chips)
Seat 5: Card5mast3r (274 in chips) is sitting out
Seat 6: Bieropener420 (476 in chips) is sitting out
Seat 7: nlin (10824 in chips)
karimaharran: posts the ante 100
HimemoriLuna: posts the ante 100
Gurujeee6445: posts the ante 100
Bareis: posts the ante 100
Card5mast3r: posts the ante 100
Bieropener420: posts the ante 100
nlin: posts the ante 100
HimemoriLuna: posts small blind 400
Gurujeee6445: posts big blind 210 and is all-in
*** HOLE CARDS ***
Dealt to nlin [5h Jc]
Bareis: folds
Card5mast3r: folds
Bieropener420: folds
nlin: folds
karimaharran: folds
HimemoriLuna: folds
*** HAND CANCELLED ***
All bets returned (1310)
*** SUMMARY ***
Total pot 1310 | Rake 0
Board [ ]
Game ended: 2024/12/23 16:35:38 GMT
Seat 1: karimaharran (button) collected (100)
Seat 2: HimemoriLuna (small blind) collected (500)
Seat 3: Gurujeee6445 (big blind) collected (310)
Seat 4: Bareis collected (100)
Seat 5: Card5mast3r collected (100)
Seat 6: Bieropener420 collected (100)
Seat 7: nlin collected (100)
```

---

## 4. Header grammar

### Cash

```
CoinPoker Hand #<id>: <Game> (<sb>/<bb> ) <YYYY>/<MM>/<DD> <HH>:<MM>:<SS> GMT
```

```regex
^CoinPoker Hand #(\d+): (.+?) \(([\d.]+)\/([\d.]+) \) (\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) GMT$
```

- **Space before the closing paren** of the stakes group. Always.
- **No ` - ` separator** before the timestamp, unlike PokerStars.
- **No currency symbol** anywhere — stakes and all amounts are bare decimals.
  The currency is USDT, signalled only by the `₮` glyph in the table name.
- Observed `<Game>`: `Hold'em No Limit` only.
- Observed stakes: `0.01/0.02`, `0.02/0.05`. Higher stakes **(inferred)** to use
  the same grammar; unverified.

### Tournament

```
CoinPoker Hand #<id>: Tournament #<tid>, <name> <Game> (<sb>/<bb> ante <a> play) <timestamp> GMT
```

```regex
^CoinPoker Hand #(\d+): Tournament #(\d+), (.+) (Hold'em No Limit) \((\d+)\/(\d+) ante (\d+) play\) (\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) GMT$
```

- The ante is **inside the blind group**, followed by a literal `play` token.
- Tournament names contain commas, `₮`, digits and free text:
  `₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD`. **Do not split the header
  on commas.** Anchor the name between `Tournament #<digits>, ` and the game
  type, and match the game type greedily from the right.
- Tournament amounts are bare integers (chip counts).

---

## 5. Table and seat lines

```
Table '<name>' <N>-max Seat #<n> is the button
```

```regex
^Table '(.+)' (\d+)-max Seat #(\d+) is the button$
```

Cash table names carry the Tether glyph: `NL ₮2 IV`, `NL ₮5 II`. Tournament
table names are bare integers: `'12'`, `'2'`, `'24'`. Only `7-max` was observed.

Seat lines — **note the optional suffix after the closing paren**:

```
Seat <n>: <name> (<stack> in chips)
Seat <n>: <name> (<stack> in chips) is sitting out
Seat <n>: <name> (<stack> in chips) out of hand
```

```regex
^Seat (\d+): (.+?) \(([\d.]+) in chips\)(?: (is sitting out|out of hand))?$
```

A regex anchored `in chips\)$` silently drops ~7% of seat lines (32,459
`is sitting out` and 16,759 `out of hand` occurrences in the corpus).

**Dead buttons are common, and take two different real shapes:**

- The button can sit on a seat number that has **no seat line at all** —
  `13-tour-pko-bounty.txt` has `Table '2' 7-max Seat #2 is the button` while
  the seat list only contains seats 1, 3, 4, 5, 6, 7 (no seat 2 anywhere). A
  parser that assumes the button's seat number must resolve to a listed player
  will fail to find one here — correctly, since there isn't one.
- The button can sit on a seat that **is** listed but is `out of hand` —
  `14-tour-satellite-seats-gtd.txt` has `Seat 2: Vir9Howei (2500 in chips) out
  of hand` as the button seat, and the SUMMARY still labels that seat
  `(button) folded before Flop (didn't bet)` even though the player was never
  dealt into the hand. Do not assume the button seat is always an active
  participant.

---

## 6. Blinds, antes, straddle

```
<p>: posts small blind <amt>
<p>: posts small blind (dead) <amt>
<p>: posts big blind <amt>
<p>: posts big blind <amt> and is all-in
<p>: posts the ante <amt>
<p>: posts straddle <amt>
<p>: didn't post big blind
```

- Ante model: per-player ante posted **before** the blinds, tournaments only.
- Straddle: `posts straddle 0.04`, and the straddler gets a `(straddle)`
  position tag in the SUMMARY seat line — a fourth position token alongside
  `(button)`, `(small blind)`, `(big blind)`.
- `didn't post big blind` is a **non-action** line and must not be treated as a
  bet.
- **`posts small blind (dead) <amt>`** — confirmed real,
  `fixtures/samples/coinpoker/10-cash-seat-out-of-hand-sittingout.txt`:
  `waqqas: posts small blind (dead) 0.01`. This is **dead money with no street
  commitment**: it goes in the pot but does not count toward what that player
  owes to see the flop, so a later `waqqas: calls 0.06` from the same player in
  the same hand is a **full call**, not a completion of the dead amount already
  posted. Getting this wrong changes the chip arithmetic, not just the prose —
  a parser that treats the dead blind as a live partial bet will under-credit
  that player's call by the dead amount every time.
- **A second, live `posts big blind` can occur in the same hand**, from a
  different seat than the actual big-blind position — observed in
  `06-cash-timebank-disconnect.txt` (`waqqas: posts big blind 0.02` at the real
  BB seat, then `HornyMelon: posts big blind 0.02` from seat 1, who then
  `checks` preflop as a live participant) and again in
  `11-cash-mucks-hand.txt`. This reads as a player buying back into the game
  mid-orbit and posting a live big blind to re-enter immediately rather than
  waiting for their own big blind to come around — both postings are real
  chips into the pot from two different players in the same hand, not a
  duplicate/typo line.

---

## 7. Street markers

Complete observed set:

```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx Xx] [Xx]
*** SHOW DOWN ***
*** HAND CANCELLED ***
*** SUMMARY ***
```

- **`*** SHOW DOWN ***` with a space** — PokerStars style, *not* GGPoker's
  `*** SHOWDOWN ***`.
- **`*** HAND CANCELLED ***`** is CoinPoker-specific in our corpus (30
  occurrences). It replaces the showdown block and is followed by
  `All bets returned (<total>)`, an empty `Board [ ]`, and per-seat refund lines
  using the `collected (n)` verb.
- No run-it-twice markers exist in the corpus. See §14.

Cards inside street markers are space-separated with **no inner padding**;
cards in the SUMMARY `Board` line **are padded**. See §13.3.

---

## 8. Action verbs

```
<p>: folds
<p>: checks
<p>: calls <amt>
<p>: calls <amt> and is all-in
<p>: bets <amt>
<p>: bets <amt> and is all-in
<p>: raises <amt> to <amt>
<p>: raises <amt> and is all-in          ← ONE amount, no "to"
<p>: shows [Xx Xx] (<description>)
<p>: mucks hand
<p>: doesn't show hand
<p> collected <amt> from pot
<p> collected <amt> from side-pot <n>          ← side pot, hyphenated, 1-indexed
Uncalled bet (<amt>) returned to <p>
All bets returned (<amt>)
<p> has timed out
<p> is disconnected
<p> has reconnected
<p> activated time-bank (<n> seconds)
```

The all-in raise form is the trap:

```regex
^(.+?): raises ([\d.]+)(?: to ([\d.]+))?( and is all-in)?$
```

Both forms occur in the same hand — `StoicMind: raises 0.16 to 0.18` next to
`waqqas: raises 0.46 and is all-in`. A `raises (\d+) to (\d+)` pattern drops
every all-in raise (159 occurrences in one log slice).

---

## 9. SUMMARY block

```
*** SUMMARY ***
Total pot <amt> | Rake <amt>
Board [ <cards> ]
Game ended: <YYYY>/<MM>/<DD> <HH>:<MM>:<SS> GMT
Seat <n>: <name> [(position)] <outcome>
```

- Rake line has exactly **two** fields — no Jackpot/Bingo/Fortune/Tax (GGPoker).
  **Correction (2026-09-17): an earlier version of this document additionally
  claimed "no Main/Side breakdown" on this line. That part was wrong — see the
  side-pot correction below. The `Total pot <amt> | Rake <amt>` line itself is
  still always exactly two fields; the side-pot information lives in the
  *action* section, not in this summary line.**
- `Game ended:` is a CoinPoker-only line and a good corroborating detection
  signal.
- `Board [ ]` appears, empty and space-padded, on cancelled hands.

Seat outcome grammar:

```
Seat n: P collected (<amt>)
Seat n: P folded before Flop
Seat n: P folded before Flop (didn't bet)
Seat n: P folded on the Flop|Turn|River
Seat n: P showed [Xx Xx] and won (<amt>) with <description>
Seat n: P showed [Xx Xx]                        ← loser: NOTHING after the cards
```

**The loser's line is bare.** CoinPoker never states who lost — there is no
`and lost with …` clause, unlike PokerStars, WePlay and GGPoker which all emit
one. Measured on a 4M-line slice: 332 `showed … and won … with …` against 169
bare `showed [..]`. A parser that determines showdown participation by looking
for `and lost` finds nobody.

Both `collected (x)` and `won (x)` verbs appear (2,580 vs 784 in the same
slice): `collected` on the action line and on refund/uncontested summary lines,
`won` in the `showed … and won …` showdown form.

---

## 10. Date / time

```
2025/06/19 18:53:04 GMT
```

`YYYY/MM/DD HH:MM:SS` followed by the literal `GMT`, zero-padded, 24-hour. Both
the header timestamp and the `Game ended:` timestamp use it. No bracketed second
timezone. **Always GMT** across the whole corpus.

---

## 11. Anonymisation

**None.** Real usernames throughout, including the hero. There is no `Hero`
literal — the hero is identified only by the `Dealt to <name>` line, the same
convention as WePlay. A converter emitting GG-style `Hero` must rename based on
that line.

---

## 12. Files, encoding, line endings

| Property | Value |
|---|---|
| Encoding | UTF-8, **no BOM**. Files containing `₮` are UTF-8; pure-ASCII logs also occur. |
| Line endings | **LF only**. No CRLF anywhere in ~4.2M lines. |
| Hand separator | **one** blank line (`\n\n`) — PokerStars and WePlay use two |
| Hands per file | 1 to >100,000 |

File naming and the client's default export directory are **not determined** —
the corpus came from a third party's HUD logs, not a captured client install.
**(inferred: unverified.)**

---

## 13. Gotchas

Ordered by damage.

### 13.1 `raises N and is all-in` has no `to`

See §8. Both forms coexist in one hand. This is the single most likely cause of
dropped actions.

### 13.2 Hand-description wording differs from every other site

- **`three of kind, Aces`** — CoinPoker's own output omits the "a". PokerStars
  says `three of a kind`. This is a typo in the site's output, not in our
  fixture.
- **`a full house, Aces over Fours`** — "over", where PokerStars and WePlay say
  `Aces full of Fours`.
- **`Ace high`** — GG-style, not PokerStars' `high card Ace`.

Any hand-description lookup table built against PokerStars wording misses all
three. If you normalise descriptions, normalise these explicitly.

### 13.3 Board bracket padding is inconsistent within one hand

`*** FLOP *** [Jd 6c 5h]` has no inner padding; `Board [ Jd 6c 5h 5c ]` in the
SUMMARY of the same hand does. Strip and split on whitespace rather than
matching a fixed layout. Cancelled hands emit `Board [ ]`.

### 13.4 Seat lines have suffixes after the closing paren

`(2.00 in chips) out of hand` and `(2.00 in chips) is sitting out`. Anchoring
`in chips\)$` loses both.

### 13.5 The loser's summary line is bare

No `and lost with …` clause ever. Determine showdown participants from the
`X: shows [..]` action lines, not from the summary.

### 13.6 Stakes group has a trailing space, and there is no ` - ` before the date

`Hold'em No Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT`. A PokerStars-shaped
header regex expecting `\) - ` fails on every CoinPoker hand.

### 13.7 Tournament names contain commas and the game-type string

`₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD Hold'em No Limit (…)`. Do not
split on commas; anchor the name between `Tournament #\d+, ` and the game type,
matching the game type from the right.

### 13.8 Non-ASCII in table names

`₮` is U+20AE. Table names are not ASCII-safe. Read as UTF-8.

### 13.9 One blank line separates hands, not two

A splitter tuned to PokerStars' `\n\n\n` treats a whole CoinPoker file as one
hand.

### 13.10 No currency symbol anywhere

Amounts are bare decimals in cash and bare integers in tournaments. Currency
must be inferred from context (USDT), not parsed. Do not assume a `$` prefix is
optional-but-present.

### 13.11 `*** HAND CANCELLED ***` breaks pot accounting

There is no winner; every player is refunded via `collected (n)` summary lines
whose sum equals `Total pot`, and `Rake` is 0. A pot-distribution assertion
written for normal hands needs an explicit branch.

---

## 14. Negative findings

Grepped across the full multi-million-line corpus, not spot-checked. Treat as
**unknown**, not as proven absent from the format — **and see the withdrawal
below before trusting any single line of this list**.

> **WITHDRAWN (2026-09-17): "No side pots" was a false negative caused by a
> spelling mismatch, not a real absence.** This document previously claimed
> zero `side pot` / `main pot` occurrences. CoinPoker does not spell it either
> of those ways — it spells the side pot **hyphenated**, `side-pot <n>`
> (1-indexed), and calls the main pot simply `pot`, e.g. `Alena160520 collected
> 52 from pot` for the main share and `Alena160520 collected 52 from side-pot
> 1` for the side share, both under the same `*** SHOW DOWN ***` block, in
> `fixtures/samples/coinpoker/14-tour-satellite-seats-gtd.txt`. The arithmetic
> reconciles exactly: two players are all-in for 2461 and 2487, a third calls
> the full 2487, giving a side pot of `(2487 − 2461) × 2 = 52` on top of a
> 7611 main pot, `Total pot 7663`. **The lesson, stated plainly so the next
> person doesn't repeat it: a negative finding produced by grepping for the
> spelling used on a different site is not a negative finding, it's an
> untested assumption wearing the clothes of one.** The side-pot grammar is
> now documented in §8 and §9.
- **No run-it-twice.** Zero `FIRST`/`SECOND` markers.
- **No Omaha or any non-Hold'em game.**
- **No rabbit hunt, no all-in insurance, no cashout.**
- **No bounty award lines**, even in the PKO tournament sample — the PKO is
  identifiable only from the tournament name.
- **No tournament finish/elimination lines** ("finished in Nth place", "wins the
  tournament").
- **Only `7-max`** table size, and only two cash stake levels.

---

## 15. Sample index

See `fixtures/samples/coinpoker/SOURCES.md` for the full table with provenance.
16 files, all REAL, all machine-verified byte-exact: 11 cash
(`01`–`11`) covering the baseline format, showdowns, straddle, the all-in raise
form, time-bank/disconnect, `didn't post big blind`, the two description-wording
quirks, seat-line suffixes and mucks; and 5 tournament (`12`–`16`) covering the
ante-and-`play` header, PKO, satellites, a cancelled hand and a freeroll.

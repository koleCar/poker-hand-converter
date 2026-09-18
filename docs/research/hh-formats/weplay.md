# WePlay Poker — hand history format

## 1. Overview & status

**Status: fully verified from a large real in-repo corpus.** Everything in this
document was derived mechanically from `weplay-hh/` in this repository:

- 104 real export files, **6402 hands**, two different accounts
  (`weplay-hh/kole1992/`, `weplay-hh/h.kolaric992@gmail.com/`)
- Cash (NLHE, 6-max and 8-max, $0.25/$0.50 up to $2/$5), Bomb Pot cash tables,
  and MTT tournaments (freezeout + PKO)
- Date range Jan–Feb 2026

Nothing here is inferred unless it says so. Where a claim is a frequency count
it is stated as such.

WePlay is **very close to the PokerStars dialect** — close enough that a
PokerStars parser gets ~90% of the way — but it has several semantic differences
that silently produce **wrong numbers** rather than parse errors. Those are in
§13 and they are the reason this doc exists.

The most important of them, up front:

| # | Difference from PokerStars | Consequence if missed |
|---|---|---|
| 1 | `raises X to Y` — `X` is **chips added by this player**, not the raise increment | Every raise size is wrong |
| 2 | `Total pot` is **pre-rake**, and `collected` amounts sum to `Total pot`, so rake is *not* deducted anywhere | Pot never balances, or balances only by luck |
| 3 | Tournament header `Level N (sb/bb)` blinds are **stale and wrong** | Wrong blind level on every tournament hand |
| 4 | A duplicated `*** HOLE CARDS ***` block can appear **after** `*** SHOW DOWN ***` | Street state machine resets mid-hand |

---

## 2. Detection signature

```regex
^\xEF\xBB\xBF?Weplay Hand #\d+:
```

Practical form (after BOM stripping, multiline):

```regex
/^Weplay Hand #\d+:/m
```

This is unambiguous — no other network emits the literal token `Weplay Hand #`.
Verified against all 6402 hands: every hand starts with it, and every file
starts with it (after the BOM).

Do **not** try to detect on `*** SHOW DOWN ***` or `Hold'em No Limit ($x/$y)`:
those are shared with PokerStars and several clones.

---

## 3. Full verbatim example hands

### 3.1 Cash hand (8-max, uncalled bet, timeout, no showdown)

From `fixtures/samples/weplay/01-cash-nlhe-8max-0.25-0.50.txt`, first hand.
Note the **BOM before `Weplay`**, the **double space after the colon** in the
header, and the **trailing space** after `Rake $0` and after `folded before Flop`.

```
Weplay Hand #71443807:  Hold'em No Limit ($0.25/$0.50) - 2026/01/03 14:40:47 UTC
Table 'Manchester #1'(11555801) 8-max (Money 3) Seat #7 is the button
Seat 2: kole1992 ($53.64 in chips)
Seat 3: ryzenn ($67.21 in chips)
Seat 4: WinHof ($64.71 in chips)
Seat 5: neso22 ($80.32 in chips)
Seat 6: JTs98o ($132.27 in chips)
Seat 7: Pit1987 ($68.43 in chips)
kole1992: posts small blind $0.25
ryzenn: posts big blind $0.50
*** HOLE CARDS ***
Dealt to kole1992 [7s 2c]
WinHof: folds
neso22: folds
JTs98o: folds
Pit1987: raises $1.50 to $1.50
kole1992: folds
ryzenn: folds
Uncalled bet ($1) returned to Pit1987
*** SHOW DOWN ***
Pit1987 has timed out
Pit1987: doesn't show hand
Pit1987 collected $1.25 from pot
*** SUMMARY ***
Total pot $1.25 | Rake $0 
Seat 2: kole1992 (small blind) folded before Flop 
Seat 3: ryzenn (big blind) folded before Flop 
Seat 4: WinHof folded before Flop (didn't bet)
Seat 5: neso22 folded before Flop (didn't bet)
Seat 6: JTs98o folded before Flop (didn't bet)
Seat 7: Pit1987 (button) collected ($1.25)
```

Observe `Pit1987: raises $1.50 to $1.50`. Pit1987 had put in nothing, so the
chips he adds equal his total bet. PokerStars would have written
`raises $1 to $1.50` here (increment over the $0.50 BB). See §13.1.

### 3.2 Cash hand, run it twice (from `06-cash-run-it-twice-6max.txt`)

```
Weplay Hand #72076323:  Hold'em No Limit ($0.50/$1) - 2026/01/09 17:05:37 UTC
Table 'Belgrade #1'(11575800) 6-max (Money 3) Seat #5 is the button
Seat 1: guerillAA13 ($112.28 in chips)
Seat 2: mekkmester ($111.68 in chips)
Seat 3: kole1992 ($100 in chips)
Seat 4: Bastille ($191.95 in chips)
Seat 5: tinkieri ($121.03 in chips)
Seat 6: KoTBalu ($58.68 in chips)
KoTBalu: posts small blind $0.50
guerillAA13: posts big blind $1
*** HOLE CARDS ***
Dealt to kole1992 [3s 9h]
mekkmester: calls $1
kole1992: folds
Bastille: folds
tinkieri: folds
KoTBalu: raises $4.50 to $5
guerillAA13: raises $15 to $16
mekkmester: folds
KoTBalu: raises $53.68 to $58.68 and is all-in
guerillAA13: calls $42.68
*** FIRST FLOP *** [8d 5h 2s]
*** FIRST TURN *** [8d 5h 2s] [Td]
*** FIRST RIVER *** [8d 5h 2s Td] [Ts]
*** SECOND FLOP *** [7s 4d Qd]
*** SECOND TURN *** [7s 4d Qd] [6d]
*** SECOND RIVER *** [7s 4d Qd 6d] [2d]
*** SHOW DOWN ***
KoTBalu: shows [Kc Ad] (a pair of Tens)
guerillAA13: shows [Jd Js] (two pair, Jacks and Tens)
guerillAA13 collected $59.19 from pot
KoTBalu collected $59.17 from pot
*** SUMMARY ***
Total pot $118.36 | Rake $5.91 
Hand was run two times
FIRST Board [8d 5h 2s Td Ts]
SECOND Board [7s 4d Qd 6d 2d]
Seat 1: guerillAA13 (big blind) showed [Jd Js] and won ($59.19) with two pair, Jacks and Tens
Seat 2: mekkmester folded before Flop 
Seat 3: kole1992 folded before Flop (didn't bet)
Seat 4: Bastille folded before Flop (didn't bet)
Seat 5: tinkieri (button) folded before Flop (didn't bet)
Seat 6: KoTBalu (small blind) showed [Kc Ad] and won ($59.17) with a pair of Tens
```

Note: `KoTBalu: raises $4.50 to $5` — KoTBalu is the SB with $0.50 already in,
so chips added = $4.50. Again PokerStars semantics would say `raises $4 to $5`.

Note also: **both** players' seat lines say `won`, because each won one run.
The `(a pair of Tens)` hand description on the `shows` line describes only the
**first** board.

### 3.3 Bomb pot cash hand (from `03-cash-bomb-pot-ante-only.txt`)

Bomb pots are a normal cash table with `Bomb Pot (3BB-5BB)` in the table name.
**There are no blinds at all** — every seated player posts an identical
randomised ante, there is no preflop betting round, and play starts on the flop.

```
Weplay Hand #72075042:  Hold'em No Limit ($0.25/$0.50) - 2026/01/09 17:00:25 UTC
Table 'Liverpool Bomb Pot (3BB-5BB) #2'(11421800) 8-max (Money 3) Seat #7 is the button
Seat 2: petike21 ($76.64 in chips)
Seat 3: Dave96 ($45.20 in chips)
Seat 4: Liam ($47.60 in chips)
Seat 5: guerillAA13 ($74.40 in chips)
Seat 6: KoTBalu ($36.68 in chips)
Seat 7: Bastille ($53.32 in chips)
Seat 8: kole1992 ($50 in chips)
petike21: posts the ante $2.23
Dave96: posts the ante $2.23
Liam: posts the ante $2.23
guerillAA13: posts the ante $2.23
KoTBalu: posts the ante $2.23
Bastille: posts the ante $2.23
kole1992: posts the ante $2.23
*** HOLE CARDS ***
Dealt to kole1992 [6c Ks]
*** FLOP *** [Ad 3c 7d]
kole1992 has timed out
kole1992: checks
petike21: bets $4.68
Dave96: folds
Liam has timed out
Liam: folds
Liam: sits out 
guerillAA13: folds
KoTBalu: folds
Bastille: folds
kole1992: folds
Uncalled bet ($4.68) returned to petike21
*** SHOW DOWN ***
petike21: doesn't show hand
petike21 collected $15.61 from pot
*** SUMMARY ***
Total pot $15.61 | Rake $0.78 
Board [Ad 3c 7d]
Seat 2: petike21 collected ($15.61)
Seat 3: Dave96 folded on the Flop 
Seat 4: Liam folded on the Flop 
Seat 5: guerillAA13 folded on the Flop 
Seat 6: KoTBalu folded on the Flop 
Seat 7: Bastille (button) folded on the Flop 
Seat 8: kole1992 folded on the Flop
```

Note: all 7 listed players post the ante — it is posted by everyone dealt in,
with no button/blind exemption. The hand id / header is otherwise indistinguishable from a
normal cash hand; **the only signal that this is a bomb pot is the table name
plus the absence of any `posts small blind` line**.

### 3.4 Tournament hand (from `04-tournament-mtt-ante-9max.txt`)

```
Weplay Hand #75876427: Tournament (ILWP series - MAIN EVENT – In Love With Poker)#11275334, $100+$9 Hold'em No Limit - Level VI (100/200) - 2026/02/15 19:02:51 UTC
Table '11275334 24'(11628216) 9-max Seat #6 is the button
Seat 1: kylienCarbad (19100 in chips)
Seat 2: Antondomld (17373 in chips)
Seat 3: Pirateschips (30557 in chips)
Seat 4: MaeMan6 (38195 in chips)
Seat 5: postjoy75 (28305 in chips)
Seat 6: kole1992 (32366 in chips)
Seat 7: agafac (21970 in chips)
Seat 8: Wandeinreich59 (17628 in chips)
Seat 9: lokicola123 (19800 in chips)
kylienCarbad: posts the ante 35
Antondomld: posts the ante 35
Pirateschips: posts the ante 35
MaeMan6: posts the ante 35
postjoy75: posts the ante 35
kole1992: posts the ante 35
agafac: posts the ante 35
Wandeinreich59: posts the ante 35
lokicola123: posts the ante 35
agafac: posts small blind 150
Wandeinreich59: posts big blind 300
*** HOLE CARDS ***
Dealt to kole1992 [8s 5c]
lokicola123: calls 300
kylienCarbad: folds
Antondomld: raises 1300 to 1300
Pirateschips: folds
MaeMan6: folds
postjoy75: folds
kole1992: folds
agafac: folds
Wandeinreich59: folds
lokicola123: folds
Uncalled bet (1000) returned to Antondomld
*** SHOW DOWN ***
Antondomld: doesn't show hand
Antondomld collected 1365 from pot
*** SUMMARY ***
Total pot 1365 | Rake 0 
Seat 1: kylienCarbad folded before Flop 
Seat 2: Antondomld collected (1365)
Seat 3: Pirateschips folded before Flop 
Seat 4: MaeMan6 folded before Flop 
Seat 5: postjoy75 folded before Flop 
Seat 6: kole1992 (button) folded before Flop 
Seat 7: agafac (small blind) folded before Flop 
Seat 8: Wandeinreich59 (big blind) folded before Flop 
Seat 9: lokicola123 folded before Flop 
```

Four things to note:

1. **Only ONE space after the colon** in the tournament header
   (`Hand #75876427: Tournament`), versus **TWO** in the cash header
   (`Hand #71443807:  Hold'em`). See §13.3.
2. The header says `Level VI (100/200)` but the actual posted blinds are
   **150/300**. The header blinds are wrong. See §13.4.
3. Tournament amounts have **no currency symbol** — bare integers. The buy-in
   in the header (`$100+$9`) *does* carry `$`.
4. The tournament name contains an **en dash (U+2013)** — `MAIN EVENT – In Love
   With Poker`. Non-ASCII in the header is normal.

---

## 4. Header line grammar

Two forms only, both confirmed across all 6402 hands.

### 4.1 Cash

```
Weplay Hand #<handId>:  <Game> (<sb>/<bb>) - <YYYY>/<MM>/<DD> <HH>:<MM>:<SS> UTC
```

```regex
^Weplay Hand #(\d+):\s{2}(.+?) \((\$?[\d.]+)\/(\$?[\d.]+)\) - (\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) UTC$
```

Observed `<Game>` values in corpus: `Hold'em No Limit` only.
Observed stake strings: `$0.25/$0.50`, `$0.50/$1`, `$1/$2`, `$2/$5`.

Note the **inconsistent decimal formatting inside one header**:
`$0.50/$1` — the SB has two decimals, the BB has none. Never assume a fixed
number of decimal places. Amounts are `$` + a decimal with 0, 1 or 2 places.

Only `$` was observed. Other currencies and play money are **not confirmed** —
if WePlay supports them, the shape is unknown. *(inference: likely `€`/`£` with
the same grammar, but unverified.)*

### 4.2 Tournament

```
Weplay Hand #<handId>: Tournament (<tourneyName>)#<tourneyId>, <buyin>+<fee> <Game> - Level <ROMAN> (<sb>/<bb>) - <timestamp> UTC
```

```regex
^Weplay Hand #(\d+): Tournament \((.+)\)#(\d+), (\$[\d.]+)\+(\$[\d.]+) (.+?) - Level ([IVXLC]+) \((\d+)\/(\d+)\) - (\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) UTC$
```

- **One** space after `Hand #N:`, not two.
- No space or comma between `)` and `#<tourneyId>`.
- Level is a **Roman numeral**: observed `VI VII IX X XI XII XIII XIV XV XVI
  XVII XVIII XIX`.
- The tourney name may contain `(`, `)`, `-`, `–`, and other non-ASCII. Because
  the name is delimited by `(` … `)#`, a greedy match to `)#\d+` is required —
  a lazy `\(([^)]*)\)` breaks on names containing parentheses.
- Bounty/PKO tournaments use the same grammar; the buy-in split
  (`$15+$3` for a PKO vs `$15+$1.50` for a freezeout) is the only hint, and it
  is not reliable. **No explicit bounty line was found anywhere in the corpus.**
  See §8.

No Zoom/fast-fold variant exists. No Omaha or mixed-game hand appears in the
corpus; the repo's converter explicitly skips Omaha, which implies WePlay does
serve it, but **no Omaha sample was available to verify its header**.

---

## 5. Table / seat lines

```
Table '<name>'(<tableId>) <N>-max[ (<ringName>)] Seat #<n> is the button
```

```regex
^Table '(.+)'\((\d+)\) (\d+)-max(?: \((.+)\))? Seat #(\d+) is the button$
```

- **No space** between the closing `'` and `(`.
- `(Money 3)` appears on cash tables only — it is a ring/limit-group label.
  Tournament tables have no such suffix.
- Cash table names are city names with a `#n` suffix: `Manchester #1`,
  `Novi Sad #1`, `Niš Bomb Pot (3BB-5BB) #1`. They contain spaces, `#`,
  parentheses, digits, and **non-ASCII** (`Niš`). The `'` delimiter is the only
  reliable boundary; a name containing `'` was not observed but is not
  structurally excluded.
- Tournament table names are `'<tourneyId> <tableNumber>'`, e.g. `'11275334 24'`.
- Observed `-max` values: `6`, `7`, `8`, `9`.

Seat lines:

```
Seat <n>: <playerName> ($<stack> in chips)     ← cash
Seat <n>: <playerName> (<stack> in chips)      ← tournament (no $)
```

```regex
^Seat (\d+): (.+?) \((\$?[\d.]+) in chips\)$
```

**Seat numbers are not contiguous and do not start at 1.** Empty seats are
simply omitted. A `6-max` table can list seats 1, 3, 4, 5, 6 (see §3.2 — seat 2
is absent in other hands of that file). Never index players by seat order.

**Player names contain spaces and punctuation.** Across 365 distinct names in
the corpus: `marko bulatovic` (space), `X-factors`, `J-Remy` (hyphen), `M.C.`,
`GGG.ChampioNn` (dots), `DEMO,ne00` (comma). Names are also purely numeric with
underscores: `2469840_411750`, `490700_7267`. **Always anchor on the delimiter,
never on a name charset.**

---

## 6. Blinds, antes, straddle

All confirmed from real samples.

```
<player>: posts small blind <amt>
<player>: posts big blind <amt>
<player>: posts straddle <amt>
<player>: posts the ante <amt>
<player>: posts the ante <amt> and is all-in
<player>: declines straddle
```

```regex
^(.+?): posts (small blind|big blind|straddle|the ante) (\$?[\d.]+)( and is all-in)?$
^(.+?): declines straddle$
```

- **Ante model differs by game type:**
  - *Tournaments*: every player posts an equal ante **before** the blinds. It is
    a classic per-player ante, not a BB-ante.
  - *Bomb pot cash*: every player posts an equal randomised ante of roughly
    3–5 BB (e.g. `$2.23` at $0.25/$0.50), and **no blinds are posted at all**.
  - *Normal cash*: no ante.
- **Straddle**: `posts straddle $4` at $1/$2 (2× BB), `$5` at some tables,
  `$10` observed. `declines straddle` is an explicit **non-action** line emitted
  when a player is offered the straddle and passes — it is not a bet and must
  be ignored for pot accounting, but it *does* appear in the blind-posting
  region before `*** HOLE CARDS ***`.
- The straddler's straddle counts as their street investment, which is why the
  subsequent `raises X to Y` uses `X = Y − straddle` (§13.1).
- No `posts small & big blinds` / dead-blind / post-to-enter line was found.
  *(Whether WePlay supports posting out of turn is unverified.)*

---

## 7. Street markers

Exact strings, confirmed exhaustively — this is the **complete** set:

```
*** HOLE CARDS ***
*** FLOP *** [Xx Xx Xx]
*** TURN *** [Xx Xx Xx] [Xx]
*** RIVER *** [Xx Xx Xx Xx] [Xx]
*** FIRST FLOP *** [Xx Xx Xx]
*** FIRST TURN *** [Xx Xx Xx] [Xx]
*** FIRST RIVER *** [Xx Xx Xx Xx] [Xx]
*** SECOND FLOP *** [Xx Xx Xx]
*** SECOND TURN *** [Xx Xx Xx] [Xx]
*** SECOND RIVER *** [Xx Xx Xx Xx] [Xx]
*** SHOW DOWN ***
*** SUMMARY ***
```

- **`*** SHOW DOWN ***` with a space**, PokerStars-style — *not* GGPoker's
  `*** SHOWDOWN ***`. This is a common conversion bug when moving WePlay → GG.
- There is **no `*** PRE-FLOP ***`** marker (unlike Winamax).
- Turn/River repeat the prior board in a first bracket and give the new card in
  a second bracket, PokerStars-style.
- Run-it-twice uses `FIRST`/`SECOND`. Only two runs were observed; a `THIRD`
  variant is *not confirmed*.
- `*** SHOW DOWN ***` is emitted even when **nobody shows** — e.g. everyone
  folded to an uncalled bet (§3.1). Do not treat its presence as "went to
  showdown". Use the presence of at least one `: shows [` line instead.

Card notation: `<Rank><suit>` with rank in `23456789TJQKA` and suit in `cdhs`,
space-separated inside `[...]`. No commas.

---

## 8. Action verbs — complete vocabulary

Every distinct line shape in the corpus. `P` = player name, `A` = amount
(`$`-prefixed in cash, bare in tournaments).

### Betting actions

```
P: folds
P: checks
P: calls A
P: calls A and is all-in
P: bets A
P: bets A and is all-in
P: raises A to B
P: raises A to B and is all-in
```

```regex
^(.+?): (folds|checks)$
^(.+?): (calls|bets) (\$?[\d.]+)( and is all-in)?$
^(.+?): raises (\$?[\d.]+) to (\$?[\d.]+)( and is all-in)?$
```

There is **no `all-in`-only verb**; all-in is always the ` and is all-in`
suffix on `calls`/`bets`/`raises`/`posts the ante`.

### Pot returns and awards

```
Uncalled bet (A) returned to P
P collected A from pot
P collected A from main pot
P collected A from side pot
```

```regex
^Uncalled bet \((\$?[\d.]+)\) returned to (.+)$
^(.+) collected (\$?[\d.]+) from (pot|main pot|side pot)$
```

Note: the collected/uncalled lines use **no colon** after the player name,
unlike every betting action. `Uncalled bet` puts the amount in parentheses.
There is no numbered side pot (`side pot-2`) in the corpus; with three or more
all-in tiers the shape is *unverified*.

### Showdown

```
P: shows [Xx Xx] (<hand description>)
P: shows [] (<hand description>)          ← yes, really; 4 occurrences
P: mucks hand
P: doesn't show hand
```

```regex
^(.+?): shows \[([^\]]*)\] \((.+)\)$
^(.+?): (mucks hand|doesn't show hand)$
```

The card list inside `[...]` **can be empty** (`shows []`) while the SUMMARY
line for the same player still carries the real cards. 4 hands in the corpus do
this. A `\[(\w\w \w\w)\]` regex throws a parse error on these; use
`\[([^\]]*)\]` and fall back to the SUMMARY line.

Hand descriptions follow the PokerStars wording exactly:
`high card Ace`, `a pair of Kings`, `two pair, Kings and Fives`,
`three of a kind, Queens`, `a straight, Nine to King`, `a flush, Ace high`,
`a full house, Queens full of Tens`. Note `Deuce`/`Deuces` for twos.

### Table / connection events

```
P has timed out
P has timed out while being disconnected
P is connected 
P is disconnected 
P: sits out 
P joins the table at seat #<n>
P leaves the table
```

```regex
^(.+) has timed out( while being disconnected)?$
^(.+) is (connected|disconnected) $
^(.+?): sits out $
^(.+) joins the table at seat #(\d+)$
^(.+) leaves the table$
```

**Note the trailing spaces**: `is connected `, `is disconnected `, `sits out `
all end with a space. Anchoring a regex with `$` immediately after the word
fails. Also note the inconsistency: `sits out` uses a colon after the name,
`has timed out` / `is connected` / `joins the table` / `leaves the table` do not.

These lines appear **interleaved with betting actions**, including inside the
`*** SHOW DOWN ***` block, and must be skipped rather than treated as actions.

### Not present in the corpus

The following were searched for and **do not occur** — either WePlay does not
emit them or the corpus does not cover the situation:

- rabbit hunting
- bounty / knockout awards (even in the PKO sample `05-tournament-pko-9max.txt`)
- cashout / all-in insurance
- run-it-twice *offers* (only the resulting FIRST/SECOND boards appear)
- chat / `said,` lines
- "finished the tournament in Nth place" / "wins the tournament"
- hand-cancelled lines
- `is sitting out` on seat lines (only the standalone `P: sits out ` line)
- `was removed from the table for failing to post`

Treat all of these as **unknown**, not as "does not exist".

---

## 9. SUMMARY block

```
*** SUMMARY ***
Total pot A | Rake B 
Total pot A Main pot C. Side pot D. | Rake B 
Hand was run two times
Board [Xx Xx Xx Xx Xx]
FIRST Board [Xx Xx Xx Xx Xx]
SECOND Board [Xx Xx Xx Xx Xx]
Seat <n>: <name> [(position)]... <outcome>
```

Pot line:

```regex
^Total pot (\$?[\d.]+)(?: Main pot (\$?[\d.]+)\. Side pot (\$?[\d.]+)\.)? \| Rake (\$?[\d.]+) $
```

- There is **a trailing space** after the rake amount on every pot line.
- In the split-pot form there is **no `|` before `Main pot`**, and the main/side
  amounts are each terminated by a **literal period**. This is unlike
  PokerStars (`Total pot $60.84 Main pot $49.68. Side pot $11.16. | Rake $3.04`
  is actually the same shape as PokerStars here, but many clones differ — the
  WePlay shape is confirmed).
- `Rake` is the only fee field. **There is no Jackpot / Bingo / Fortune / Tax
  field** — that is GGPoker. A WePlay→GG converter has to synthesise them.
- `Hand was run two times` appears immediately before the board lines when
  run-it-twice happened, and `Board` is replaced by `FIRST Board` + `SECOND
  Board`.
- The `Board` line is **absent entirely** when the hand ended preflop.

Seat outcome lines — the full observed grammar:

```
Seat n: P collected ($x)
Seat n: P mucked
Seat n: P folded before Flop 
Seat n: P folded before Flop (didn't bet)
Seat n: P folded on the Flop 
Seat n: P folded on the Turn 
Seat n: P folded on the River 
Seat n: P showed [Xx Xx] and won ($x) with <hand description>
Seat n: P showed [Xx Xx] and lost with <hand description>
Seat n: P folded on the Flop showed [Xx Xx] and lost with <hand description>
Seat n: P folded on the Turn showed [Xx Xx] and lost with <hand description>
Seat n: P folded before Flop (didn't bet)showed [Xx Xx] and lost with <hand description>
```

Position markers `(button)`, `(small blind)`, `(big blind)` are inserted
between the name and the outcome, and **more than one can appear**:

```
Seat 6: GizmoGradac (button) (big blind) collected ($7)
Seat 4: Misi23 (button) (big blind) folded on the River 
```

(Heads-up, where the button is also the big blind in WePlay's ordering.) A
regex matching a single optional `\(([^)]+)\)` group silently drops the second.

---

## 10. Date / time

```
2026/01/03 14:40:47 UTC
```

`YYYY/MM/DD HH:MM:SS` followed by the literal string `UTC`. **Always UTC**,
always zero-padded, always 24-hour, no bracketed second timezone (unlike
PokerStars' `[… ET]` dual stamp). Verified across the whole corpus.

---

## 11. Anonymized players

**WePlay does not anonymize.** Real screen names are used for every player,
including the hero. There are no hex ids (GGPoker) and no positional
pseudo-names (Bodog/Ignition).

The hero is identified only implicitly: **the hero is the player named on the
`Dealt to` line.** There is no `Hero` literal and no other marker. A converter
that emits a GG-style file with `Hero` must rename based on the `Dealt to`
player, and must do so consistently across every hand in the file (the hero is
the same in all hands of one export file, since the export is per-account).

---

## 12. Files, encoding, line endings

| Property | Value |
|---|---|
| Encoding | **UTF-8 with BOM** (`EF BB BF`) — on every file |
| Line endings | **LF only** (`\n`). No CRLF anywhere in 104 files. |
| Hand separator | exactly two blank lines, i.e. `\n\n\n` between hands |
| Trailing bytes | file ends with a single `\n`, no trailing blank lines |
| Hands per file | 1 to 434; median 45. **Never assume one hand per file.** |
| Trailing whitespace | pervasive — 100+ lines per file end with a space |

File name grammar, cash:

```
HH<YYYYMMDD> <tableName> (#<tableId>) - $<sb>-$<bb> - <ringName> No Limit Hold_em.txt
```

e.g. `HH20260103 Manchester #1 (#11555801) - $0.25-$0.50 - Money 3 No Limit Hold_em.txt`

File name grammar, tournament:

```
HH<YYYYMMDD> T<tourneyId> (#<n>) No Limit Hold_em $<buyin> + $<fee>.txt
```

e.g. `HH20260215 T11275334 (#1) No Limit Hold_em $100 + $9.txt`

Note: `Hold_em` with an **underscore** (the apostrophe is illegal in filenames),
and the buy-in in the filename is spaced `$100 + $9` while the header is
unspaced `$100+$9`. Filenames contain `$`, `#`, spaces and non-ASCII (`Niš`) —
shell-quote them.

One file = one table = one calendar day. In the corpus, exports are grouped per
account into a directory named after the account's email or screen name.

Default export directory: **not determined** — the in-repo corpus was delivered
as a directory tree, not captured from a client install. *(Unverified.)*

---

## 13. Gotchas

These are ordered by how much damage they do.

### 13.1 `raises X to Y` — X is chips added, NOT the raise increment

**Verified on 6771 raise actions: 6766 match "X = Y − player's prior investment
this street".** The 5 exceptions are all straddle hands where the straddle post
is the prior investment (they match once the straddle is accounted for).

| | PokerStars | WePlay |
|---|---|---|
| Meaning of `X` in `raises X to Y` | raise increment over the current bet | chips this player adds now |
| BB $0.50, button raises to $1.50 | `raises $1 to $1.50` | `raises $1.50 to $1.50` |
| SB $0.50 in a $0.50/$1 game raises to $5 | `raises $4 to $5` | `raises $4.50 to $5` |

Practical rule: **ignore `X` entirely and drive everything off `Y`.** `Y` is the
player's total street investment after the action and is unambiguous in both
dialects. If you must emit PokerStars/GG output, recompute `X` as
`Y − (current highest bet on the street before this action)`.

### 13.2 Rake is reported but never deducted

Verified across 3915 raked hands:

```
sum(all contributions) − sum(uncalled bets returned)  ==  Total pot
sum(collected amounts)                                ==  Total pot
```

So the `Rake` figure is **additional information that balances against
nothing**. In PokerStars and GGPoker, `collected` sums to `Total pot − Rake`.

Consequence: a pot-balance assertion written for PokerStars semantics fails on
every raked WePlay hand, and a converter that passes the amounts through
unchanged produces a GG-format file that a GG-aware consumer will read as
"rake charged twice" or "rake not charged". Decide explicitly which convention
your canonical format uses and convert.

One hand (`#73831931`) is off by $0.25 from even this rule — a presumed dead
small blind that is never posted in the text. Budget for a small tolerance.

### 13.3 One space vs two after the header colon

```
Weplay Hand #71443807:  Hold'em No Limit ...     ← cash: TWO spaces
Weplay Hand #75876427: Tournament (...)          ← tournament: ONE space
```

`^Weplay Hand #(\d+): (.+)$` silently leaves a leading space on the cash game
string. Use `:\s+` or `:\s{1,2}`.

### 13.4 Tournament header blind level is stale and wrong

The `Level <ROMAN> (sb/bb)` blinds in the header **never advance**. Across the
tournament corpus the header is stuck on the level-1 or level-2 blinds while
the actual posted blinds climb:

| Header says | Actually posted |
|---|---|
| `Level VI (100/200)` | 150/300 |
| `Level IX (100/200)` | 350/700 |
| `Level XIV (100/200)` | 1000/2000 |
| `Level XIX (50/100)` | 2500/5000 |

**Always derive blinds from the `posts small blind` / `posts big blind` lines.**
The header blinds are useful only as a fallback when nobody posts (which does
not happen in practice). The Roman-numeral level itself does advance correctly
and can be trusted.

One outlier posts `220/1600` — an SB that is not half the BB, presumably a
short all-in blind post. Do not assert `sb * 2 == bb`.

### 13.5 A duplicated `*** HOLE CARDS ***` block after `*** SHOW DOWN ***`

**417 of 6402 hands (6.5%)** contain a second `*** HOLE CARDS ***` + `Dealt to`
pair, emitted *inside* the showdown section:

```
Uncalled bet ($10) returned to erl90
*** SHOW DOWN ***
*** HOLE CARDS ***
Dealt to kole1992 [3s Ts]
erl90 has timed out
erl90: doesn't show hand
erl90 collected $12 from pot
*** SUMMARY ***
```

A street state machine that resets on `*** HOLE CARDS ***` will rewind to
preflop and then mis-attribute the `collected` line. Guard: once `*** SHOW DOWN
***` or `*** SUMMARY ***` has been seen, ignore further `*** HOLE CARDS ***`
markers; and deduplicate `Dealt to` by player.

### 13.6 `shows []` — empty hole cards at showdown

4 occurrences. `Operationskills: shows [] (a pair of Fours)` while the SUMMARY
line for the same player reads `showed [Ac Ah]`. Parse `\[([^\]]*)\]` and treat
an empty list as "unknown, recover from SUMMARY".

### 13.7 Missing space before `showed` in SUMMARY

```
Seat 7: podjerrr (button) folded before Flop (didn't bet)showed [Kh 9s] and lost with a pair of Fours
```

No space between `(didn't bet)` and `showed`. Also semantically contradictory —
the player folded preflop without betting yet has a shown hand and a made hand
description. Tokenise on `showed \[` rather than on whitespace.

### 13.8 Two position markers on one seat line

`Seat 6: GizmoGradac (button) (big blind) collected ($7)` — heads-up hands.
Loop over parenthesised tokens; do not capture just one.

### 13.9 Player names are hostile

Confirmed in-corpus: spaces (`marko bulatovic`), dots (`M.C.`), commas
(`DEMO,ne00`), hyphens (`X-factors`, `J-Remy`), and all-numeric-with-underscore
(`490700_7267`). Anchor on `: ` after the name for action lines and on
` (\$?[\d.]+ in chips\)$` for seat lines. A name could in principle contain
`: ` — not observed, but if robustness matters, resolve action-line names
against the seat roster rather than by regex alone.

### 13.10 Amount formatting is inconsistent

`$0.50` and `$1` and `$53.64` all appear, sometimes in the same line
(`($0.50/$1)`). Tournaments drop the `$` entirely (`posts the ante 35`,
`Total pot 1365 | Rake 0`). Use `\$?[\d.]+` everywhere and decide currency from
the header form, not from the presence of `$` on each amount. No thousands
separators were observed (`Total pot 1365`, not `1,365`) — but the largest
observed pot is 5 digits, so 6+ digits is *unverified*.

### 13.11 Seat numbers are sparse

A `8-max` table routinely lists only seats 2,3,4,5,6,7 or 4,6,8. Never assume
seats 1..N, never derive position from list order without using the button
seat number.

### 13.12 `*** SHOW DOWN ***` does not mean a showdown occurred

It is emitted on every hand including those won by an uncalled bet preflop.
Detect real showdowns via `: shows [`.

### 13.13 The BOM

Every file starts with `EF BB BF`. `^Weplay Hand #` fails on the first hand of
every file unless you strip it (or read with `utf-8-sig`).

---

## 14. Sample index

All files in `fixtures/samples/weplay/` are **byte-identical copies** of real
exports already committed under `weplay-hh/`. The full 104-file corpus remains
there; these nine are the curated variant set.

| File | Hands | Demonstrates |
|---|---|---|
| `01-cash-nlhe-8max-0.25-0.50.txt` | 78 | Baseline cash format; uncalled bet, timeout, `doesn't show hand`, rake 0 and rake > 0 |
| `02-cash-nlhe-6max-straddle-1-2.txt` | 45 | `posts straddle $4`, `declines straddle`, and the raise-semantics case `raises $14 to $18` off a straddle |
| `03-cash-bomb-pot-ante-only.txt` | 22 | Bomb pot: equal randomised ante, **no blinds**, no preflop street, `sits out `, `has timed out` |
| `04-tournament-mtt-ante-9max.txt` | 78 | Tournament header, Roman level, per-player ante, no currency symbols, stale header blinds, en dash in tourney name |
| `05-tournament-pko-9max.txt` | 44 | PKO tournament — confirms **no bounty lines are emitted** |
| `06-cash-run-it-twice-6max.txt` | 32 | `*** FIRST/SECOND FLOP/TURN/RIVER ***`, `Hand was run two times`, `FIRST Board`/`SECOND Board`, two winners both marked `won` |
| `07-cash-side-pot-empty-shows-bracket.txt` | 53 | Main/side pot split, `collected from main pot`/`from side pot`, `Total pot … Main pot …. Side pot ….` line, and `shows []` with cards only in SUMMARY |
| `08-cash-duplicated-hole-cards-block.txt` | 19 | The duplicated `*** HOLE CARDS ***` after `*** SHOW DOWN ***` corruption (§13.5) |
| `09-cash-nonascii-table-name.txt` | 34 | Non-ASCII table name `Niš Bomb Pot (3BB-5BB) #1` in header and filename |

Hand counts above are exact (`grep -c 'Weplay Hand #'`), 405 hands total.

For exhaustive coverage — every hand-description string, every seat-outcome
variant, all 365 player names — run analyses against the full `weplay-hh/` tree
rather than these nine files.

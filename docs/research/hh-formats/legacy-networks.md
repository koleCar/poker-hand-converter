# Legacy / bonus networks — MicroGaming, BossMedia, Entraction, OnGame (+ OnGameIt), Merge

These five networks are secondary/bonus scope for the converter: all are legacy or defunct
skins/platforms (MicroGaming's poker network shut down in 2016; BossMedia was folded into
Microgaming's platform; Entraction was acquired and wound down around 2014-2015; OnGame was
sold off and progressively shut down through the mid-2010s; Merge Gaming Network shut down
in 2017). Real player-facing traffic on any of them today is effectively zero. Each is
documented here from a real ~2012-2015 cash-game corpus (see below) with light additional
verification (a couple of quick, targeted web searches) rather than the full 14-section
treatment used for the primary sites — per network this doc gives: overview/status, a
detection signature, one full example hand, condensed grammar notes, gotchas, and a sample
index. All five corpora were sourced from the [HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser)
unit-test fixtures (retrieved 2026-09-16) — a parser library that ships its own real-world
sample hand histories for unit testing. That corpus itself contains a number of mislabeled
or empty files (see each network's Gotchas section and its `fixtures/samples/<site>/SOURCES.md`);
those were identified and excluded from the fixtures kept here.

---

## MicroGaming

### 1. Overview & status

MicroGaming Poker Network (MPN) was a skin/network model (not a single site) used by dozens
of poker rooms; it shut down in 2016. **Confirmed from a real sample corpus** (36 files,
`HandActionTests`/`GameTypeTests`/`Seats`/etc., dated 2013-2015). Format: single-hand XML
fragments (`<Game>...</Game>`), UTF-8 with BOM, LF line endings.

### 2. Detection signature

```regex
<Game hhversion="\d+" id="\d+"
```

Hand-splitting regex used by the reference parser: `(<Game hhversion)`. Verified not to
match any BossMedia/Entraction/OnGame/Merge sample in this repo's fixtures.

### 3. Full verbatim example hand

From `fixtures/samples/microgaming/01-basic-hand-nlhe.txt`:

```
<Game hhversion="4" id="5049092037" date="2013-09-23 14:27:55" unicodetablename="VAB1AHIAYgBvADoAIABNAGkAYwByAG8AIABOAEwASABFACAAMgAyACAALQAgAKwgMgAgAE0AYQB4AA==" tablename="Turbo: Micro NLHE 22 - €2 Max" stakes="0.01|0.02" betlimit="NL" tabletype="Cash Game" gametypeid="1" gametype="Hold&apos;em" realmoney="true" currencysymbol="rCA=" playerseat="0" betamount="0" istournament="0" totalplayers="6" tablesize="6" badbeat="false" rake="0">
   <Seats>
      <Seat num="1" alias="DuckGhoul" unicodealias="RAB1AGMAawBHAGgAbwB1AGwA" balance="2.00" endbalance="2.00" dealer="true"/>
      <Seat num="2" alias="Str16b8" unicodealias="UwB0AHIAMQA2AGIAOAA=" balance="2.49" endbalance="2.49" sittingout="true"/>
      <Seat num="3" alias="creys" unicodealias="YwByAGUAeQBzAA==" balance="0.38" endbalance="0.36"/>
      <Seat num="4" alias="cHuA" unicodealias="YwBIAHUAQQA=" balance="1.74" endbalance="2.00" sittingout="true"/>
      <Seat num="5" alias="_joker_" unicodealias="XwBqAG8AawBlAHIAXwA=" balance="2.00" endbalance="2.02"/>
      <Seat num="6" alias="Jeesuslaps" unicodealias="SgBlAGUAcwB1AHMAbABhAHAAcwA=" balance="2.00" endbalance="2.00"/>
   </Seats>
   <Gameplay>
      <Action seq="1" type="SmallBlind" seat="3" value="0.01"/>
      <Action seq="2" type="BigBlind" seat="5" value="0.02"/>
      <Action seq="3" type="Fold" seat="6"/>
      <Action seq="4" type="Fold" seat="1"/>
      <Action seq="5" type="Call" seat="3" value="0.01"/>
      <Action seq="6" type="Bet" seat="5" value="0.12"/>
      <Action seq="7" type="Fold" seat="3"/>
      <Action seq="8" type="MuckCards" seat="5"/>
      <Action type="Win">
         <Seat num="5" amount="0.16" pot="0" type="" lowhandwin="0"/>
      </Action>
   </Gameplay>
</Game>
```

### 4. Key grammar notes

- Header: one `<Game>` root element per hand; all metadata as attributes (`hhversion`,
  `id`, `date`, `tablename`, `stakes="sb|bb"`, `betlimit="NL"/"PL"/"FL"`, `gametype`).
- Currency: no literal symbol on amounts (plain decimals); the actual currency symbol is
  smuggled in `currencysymbol` as a **Base64-encoded string** (and `tablename` is echoed a
  second time, Base64-encoded, as `unicodetablename`).
- Streets: structural, not textual — `<Action type="DealFlop">`/`"DealTurn"`/`"DealRiver"`
  each contain one or more `<Card value="V" suit="s" id="N"/>` children (only the new
  card(s) for turn/river, matching the general pattern seen across these XML formats).
- Action verbs: `SmallBlind`, `BigBlind`, `Fold`, `Call`, `Bet`, `Raise`, `Check`, `AllIn`,
  `MoneyReturned` (uncalled-bet refund), `ShowCards`, `MuckCards`, `Disconnect`,
  `BadBeatContribution` (jackpot rake, not a decision).
- "SUMMARY": no literal summary block — a single trailing `<Action type="Win">` with one
  `<Seat num="N" amount="X" lowhandwin="0|1"/>` child per winner (two children for a
  hi/lo split pot).

### 5. Gotchas

- `currencysymbol`/`unicodetablename` are Base64 of a UTF-16LE string, not a currency code —
  must be decoded to recover the real symbol.
- `BadBeatContribution` is a pseudo-action (jackpot deduction), not a player decision.
- The upstream corpus's own `Seats/` folder is partly broken: `HeadsUp.txt` is actually an
  unrelated "Cassava"-branded plain-text hand, and `4 Max.txt`/`Full Ring (10 Handed).txt`
  are empty (3-byte, BOM-only) placeholders — excluded here, see `SOURCES.md`.
- `Raise`/`AllIn` values and `MoneyReturned` need to be reconciled together to get the true
  net-invested amount on all-in-for-less situations (see fixture 05).

### 6. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-nlhe.txt | Baseline 6-max NLHE hand, fold-to-win, no showdown |
| 02-fixed-limit-holdem.txt | `betlimit="FL"` |
| 03-pot-limit-omaha.txt | `gametype="Omaha"`, `betlimit="PL"` |
| 04-pot-limit-omaha-hilo.txt | Omaha H/L, split-pot `<Action type="Win">` with `lowhandwin="1"` |
| 05-allin-showdown.txt | `AllIn`, `MoneyReturned`, `ShowCards` |
| 06-3bet-hand.txt | Preflop raise/re-raise sequencing |
| 07-disconnected-badbeat-jackpot.txt | `Disconnect`, `BadBeatContribution`, 9-max, newer `currencyId` attribute (2015) |
| 08-full-ring-9handed.txt | 9-max seating |
| 09-omaha-hilo-showdown-split-pot.txt | Omaha H/L showdown, uneven hi/lo split |
| 10-sitting-out.txt | `<Seat sittingout="true"/>` |
| 11-multiple-hands-concatenated.txt | 10 hands concatenated — validates hand-splitting regex |
| 12-showdown-show-and-muck.txt | Mixed `ShowCards`/`MuckCards` at showdown |

---

## BossMedia

### 1. Overview & status

BossMedia (Boss Media AB) was a Swedish-built poker/casino platform, largely SEK-denominated
in this corpus, eventually absorbed into Microgaming's platform. **Confirmed from a real
sample corpus** (25 files, dated ~2014, SEK/USD tables). Format: XML, UTF-8 with BOM.

### 2. Detection signature

```regex
<HISTORY ID="\d+" SESSION="session\d+\.xml".*GAMEKIND="GAMEKIND_CASH"
```

Reference parser splits sessions on the literal string `"<HISTORY "`. Verified not to match
any MicroGaming/Entraction/OnGame/Merge sample in this repo's fixtures.

### 3. Full verbatim example hand

From `fixtures/samples/bossmedia/04-pot-limit-omaha.txt`:

```
<HISTORY ID="2076618714" SESSION="session352438961.xml" TABLE="Moa 5" GAME="GAME_OMA" GAMETYPE="GAMETYPE_REAL" GAMEKIND="GAMEKIND_CASH" TABLECURRENCY="SEK" LIMIT="PL" STAKES="100.00/200.00" DATE="1392661604" TABLETOURNEYID="" BET="200.00" POT="400.00" WIN="200.00" LOSS="0.00" ENDTIME="1392661619">
<PLAYER NAME="ToyBoy66" SEAT="1" AMOUNT="10000.00" STATE="STATE_PLAYING" DEALER="N"></PLAYER>
<PLAYER NAME="UNKNOWN" SEAT="2" AMOUNT="0.00" STATE="STATE_EMPTY" DEALER="N"></PLAYER>
<PLAYER NAME="UNKNOWN" SEAT="3" AMOUNT="0.00" STATE="STATE_EMPTY" DEALER="N"></PLAYER>
<PLAYER NAME="UNKNOWN" SEAT="4" AMOUNT="0.00" STATE="STATE_EMPTY" DEALER="N"></PLAYER>
<PLAYER NAME="ItalyToast" SEAT="5" AMOUNT="10000.00" STATE="STATE_PLAYING" DEALER="Y"></PLAYER>
<ACTION TYPE="HAND_BLINDS" PLAYER="ItalyToast" KIND="HAND_SB" VALUE="100.00"></ACTION>
<ACTION TYPE="HAND_BLINDS" PLAYER="ToyBoy66" KIND="HAND_BB" VALUE="200.00"></ACTION>
<ACTION TYPE="HAND_DEAL" PLAYER="ToyBoy66">
<CARD LINK="b"></CARD>
<CARD LINK="b"></CARD>
<CARD LINK="b"></CARD>
<CARD LINK="b"></CARD></ACTION>
<ACTION TYPE="HAND_DEAL" PLAYER="ItalyToast">
<CARD LINK="50"></CARD>
<CARD LINK="26"></CARD>
<CARD LINK="20"></CARD>
<CARD LINK="40"></CARD></ACTION>
<ACTION TYPE="ACTION_RAISE" PLAYER="ItalyToast" VALUE="400.00"></ACTION>
<ACTION TYPE="ACTION_FOLD" PLAYER="ToyBoy66"></ACTION>
<SHOWDOWN NAME="HAND_SHOWDOWN" POT="400.00" RAKE="0.00" MAINPOT="400.00" LEFTPOT="" RIGHTPOT="">
<RESULT PLAYER="ItalyToast" WIN="400.00" HAND="$(STR_BY_DEFAULT)" WINCARDS="">
<CARD LINK="50"></CARD>
<CARD LINK="26"></CARD>
<CARD LINK="20"></CARD>
<CARD LINK="40"></CARD></RESULT></SHOWDOWN></HISTORY>
```

### 4. Key grammar notes

- Header: `<HISTORY ID="..." TABLE="..." GAME="GAME_THM|GAME_OMA" GAMEKIND="GAMEKIND_CASH"
  TABLECURRENCY="SEK|USD|..." LIMIT="NL|PL|FL" STAKES="sb/bb" ...>` — all-caps attribute
  names distinguish this from MicroGaming's mixed-case `<Game>`.
- Currency: ISO code in `TABLECURRENCY`; amounts are plain decimals.
- Streets: `<ACTION TYPE="HAND_BOARD" VALUE="BOARD_FLOP|BOARD_TURN|BOARD_RIVER" POT="..."
  RAKE="...">` followed by `<CARD LINK="N">` children using an **opaque numeric card ID**
  (not rank+suit text).
- Action verbs: `HAND_BLINDS` (`KIND="HAND_SB"/"HAND_BB"`), `HAND_DEAL`, `ACTION_FOLD`,
  `ACTION_CALL`, `ACTION_CHECK`, `ACTION_BET`, `ACTION_RAISE`.
- "SUMMARY": `<SHOWDOWN NAME="HAND_SHOWDOWN" POT="..." RAKE="...">` with one `<RESULT
  PLAYER="..." WIN="..." HAND="$(STR_...)">` per remaining player (including folded ones,
  with `WIN="0.00"`).

### 5. Gotchas

- Multi-hand session files are wrapped `<?xml ...?><ROOT>...</ROOT>`, but the reference
  parser splits on the literal `<HISTORY `, discarding everything else — single-hand
  extracts (most of this corpus) therefore end with a **dangling, never-opened
  `</ROOT>`** closing tag. Do not treat the file as strict well-formed XML.
- `HAND` result text is an **untranslated localization key** (`$(STR_BY_DEFAULT)`,
  `$(STR_G_WIN_PAIR) $(STR_G_CARDS_NINES)`), not human-readable text.
- Board/hole cards use an opaque numeric `LINK` id (0-51-ish range) rather than rank+suit —
  a lookup table is required.
- `<RESULT>` is emitted for every remaining player at showdown, including players who
  folded earlier in the same hand — don't mistake that for "went to showdown".

### 6. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-omaha.txt | Baseline PL Omaha hand, full `<HISTORY>`/`<PLAYER>`/`<ACTION>` skeleton |
| 02-fixed-limit-holdem.txt | `LIMIT="FL"`, `GAME="GAME_THM"` |
| 03-no-limit-holdem-malformed-root.txt | `LIMIT="NL"`; trailing dangling `</HISTORY></ROOT>` |
| 04-pot-limit-omaha.txt | `GAME="GAME_OMA"`, `LIMIT="PL"` |
| 05-pot-limit-omaha-hilo.txt | Omaha Hi/Lo game type |
| 06-allin-showdown.txt | All-in, `<SHOWDOWN>`/`<RESULT>` with `WINCARDS` |
| 07-3bet-hand.txt | Preflop raise/re-raise via repeated `ACTION_RAISE` |
| 08-omaha-showdown.txt | Multi-way showdown, `<RESULT>` for folded players too |
| 09-multiple-hands-concatenated.txt | 10 `<HISTORY>` elements in one session file |
| 10-no-hole-cards-visible.txt | Opponent cards masked as `<CARD LINK="b"/>` |

---

## Entraction

### 1. Overview & status

Entraction was a Swedish-run poker/gaming platform (EUR-denominated in this corpus),
acquired by Unibet in 2011 and wound down as a standalone network by around 2014-2015.
**Confirmed from a real sample corpus** (40 files, dated 2012). Format: plain text,
UTF-8 with BOM, fixed-column player-name alignment.

### 2. Detection signature

```regex
^Game # \d+ - .+ - Table "
```

Reference parser's own hand-splitting/id regexes: `Game #.*?Game.*?\w\w\w(+|-)(\d+:\d+)`
(splits on the trailing `Game ended ... GMT±HH:MM` line) and `(?<=Game # )\d+` for the id.
Verified not to match any MicroGaming/BossMedia/OnGame/Merge sample in this repo's fixtures.

### 3. Full verbatim example hand

From `fixtures/samples/entraction/01-basic-hand-nlhe.txt`:

```
Game # 2646539198 - Texas Hold'em No Limit EUR 0.25/0.50 - Table "Burguillos"

Players(max 6):
Pinokio1                    (EUR 50.25 in seat 3)
pauli1                      (EUR 49.75 in seat 4)

Dealer:                     pauli1
Small Blind:                Pinokio1    (0.25)
Big Blind:                  pauli1      (0.50)

Pinokio1                    Call        (0.25)
pauli1                      Check

Flop                        Ah - 6c - Jd

Pinokio1                    Check
pauli1                      Bet         (0.50)
Pinokio1                    Call        (0.50)

Turn                        Ah - 6c - Jd - 3c

Pinokio1                    Check
pauli1                      Check

River                       Ah - 6c - Jd - 3c - 9s

Pinokio1                    Bet         (2.50)
pauli1                      Raise       (7.75)
Pinokio1                    Raise       (10.50)
pauli1                      Call        (5.25)

Pinokio1 shows:             As - Qs
pauli1 shows:               3h - 9c

pauli1 wins:                EUR 27.25
Rake:                       EUR 0.75

Game ended 2012-05-31 08:56:27 GMT+01:00
```

### 4. Key grammar notes

- Header: `Game # <id> - <GameType phrase> <LimitType phrase> <CCY> <sb>/<bb> - Table
  "<name>"`, e.g. `Texas Hold'em No Limit`, `Texas Hold'em Fixed Limit`, `Omaha High Pot
  Limit`, `5-Card Omaha High Pot Limit`, `Omaha Hi/Lo Fixed Limit`.
- Currency: literal 3-letter ISO code prefixing every amount (`EUR 50.25`), no symbol.
- Streets: bare literal header lines `Flop`/`Turn`/`River`, each followed by the **full
  cumulative board** (`Ah - 6c - Jd - 3c` on Turn), cards joined by ` - `.
- Action verbs: `Call`, `Check`, `Bet`, `Raise`, `Fold`, `Payback` (uncalled-bet return);
  player name is left-padded to a fixed column width before the verb.
- "SUMMARY": no literal header — ends directly with `<name> wins: <CCY amount>` (one line
  per winner, two for a split pot), `Rake: <CCY amount>`, blank line, then the
  `Game ended <date> GMT±HH:MM` trailer (which the hand-splitter keys off of).

### 5. Gotchas

- Player names and action verbs are column-aligned with padding spaces — must trim, not
  split naively on single spaces (a name containing multiple internal spaces would break
  a naive fixed-offset parser).
- `Payback` is the uncalled-bet-return pseudo-action, not a player decision.
- The hand boundary is anchored on the **trailing** `Game ended ... GMT±HH:MM` line, not
  the leading `Game #` line — a parser that splits eagerly on `Game #` alone will misalign
  multi-hand files.
- The upstream corpus itself contains mislabeled files masquerading as Entraction hands
  (`Seats/Full Ring (10 Handed).txt` and `PlayerTests/WithSittingOut.txt` are both verbatim
  PokerStars hands) — always validate a scraped corpus file-by-file, not by folder name.

### 6. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-nlhe.txt | Baseline heads-up NLHE, full street progression, showdown |
| 02-fixed-limit-holdem.txt | "Texas Hold'em Fixed Limit" header phrasing |
| 03-pot-limit-holdem.txt | "Texas Hold'em Pot Limit" header phrasing |
| 04-pot-limit-omaha.txt | "Omaha High Pot Limit" header phrasing |
| 05-five-card-pot-limit-omaha.txt | 5-card Omaha variant, 5 hole cards in `shows:` |
| 06-fixed-limit-omaha-hilo.txt | Omaha Hi/Lo, fixed limit |
| 07-allin-showdown.txt | All-in and showdown reveal phrasing |
| 08-euro-table.txt | EUR-denominated table |
| 09-heads-up.txt | 2-handed, `Players(max 2):` |
| 10-full-ring-9handed.txt | 9-max, `Players(max 9):` |
| 11-showdown-reveal.txt | Showdown with both `shows:` lines revealed |
| 12-omaha-hilo-showdown-split-pot.txt | Hi/Lo split pot, two `wins:` lines |
| 13-multiple-hands-concatenated.txt | 10 hands in one file |

---

## OnGame

### 1. Overview & status

OnGame Network was sold off by bwin.party and progressively shut down through the
mid-2010s. **Confirmed from a real sample corpus** (41 files, dated 2012 and 2014,
USD/EUR tables), plus one **OnGameIt** file (the Italian-localized `.it` skin, 2014).
Format: plain text, UTF-8 with BOM.

### 2. Detection signature

```regex
^\*{5} History for hand \S+ \*{5}
```

Verified not to match any MicroGaming/BossMedia/Entraction/Merge sample in this repo's
fixtures. Do not detect on `Real money)` or `Dealing pocket cards` alone — both also appear
inside malformed/mislabeled files from other networks that ended up in the same corpus
folder (see Gotchas).

### 3. Full verbatim example hand

From `fixtures/samples/ongame/09-heads-up.txt`:

```
***** History for hand R5-362053496-2 *****
Start hand: Mon Jan 06 23:28:00 CET 2014
Table: Bukarest [362053496] (NO_LIMIT TEXAS_HOLDEM $0.05/$0.10, Real money)
Button: seat 2
Players in round: 2
Seat 2: klista ($3.50) 
Seat 5: Robin_Hood5 ($10.00) 
klista posts small blind ($0.05)
Robin_Hood5 posts big blind ($0.10)
---
Dealing pocket cards
klista calls $0.05
Robin_Hood5 checks
--- Dealing flop [3h, Jd, 5c]
Robin_Hood5 checks
klista bets $0.10
Robin_Hood5 folds
---
Summary:
Main pot: $0.20 won by klista ($0.19)
Rake taken: $0.01
Seat 2: klista ($3.59), net: +$0.09
Seat 5: Robin_Hood5 ($9.90), net: -$0.10
***** End of hand R5-362053496-2 *****
```

### 4. Key grammar notes

- Header: `***** History for hand <id> *****` / `Start hand: <Java-style weekday date>` /
  `Table: <name> [<tableid>] (<LIMIT_TOKEN> <GAME_TOKEN> <sb>/<bb>, Real money)` /
  `Button: seat N` / `Players in round: N`.
- Currency: `$` or `€` prefixed directly on amounts (no ISO code).
- Streets: `--- Dealing flop [c1, c2, c3]` gives the full flop, but **`--- Dealing turn
  [c4]` and `--- Dealing river [c5]` give only the newly-dealt card**, not the cumulative
  board.
- Action verbs: `posts small blind (...)`, `posts big blind (...)`, `folds`, `calls $X`,
  `checks`, `bets $X`, `raises $X to $Y`.
- "SUMMARY": literal `Summary:` header, `Main pot: $X won by <name> ($Y)`, `Rake taken:
  $X`, then one `Seat N: <name> ($endstack), net: ±$X[, [cards]]` line per seat, trailer
  `***** End of hand <id> *****`.

### 5. Gotchas

- The upstream HHSmithy corpus mislabels several files as OnGame:
  `GameTypeTests/CapNoLimitHoldem.txt` and `GameTypeTests/PotLimitHoldem.txt` are verbatim
  **PokerStars** hands, and `PlayerTests/WithSittingOut.txt` is a verbatim (older-style)
  **PartyPoker** hand (`***** Hand History for Game ... *****` — note "Game" not "hand",
  and no `R5-...`-style id). All three were excluded here (see `SOURCES.md`) — a concrete
  reminder to validate every file's detection signature, not trust folder names.
- Turn/river board lines show only the new card — the flop must be remembered and
  prepended to reconstruct the full board.
- The **OnGameIt** localized skin emits byte-identical grammar to mainline OnGame, just
  with `€` amounts — currency alone cannot distinguish it from a EUR-configured mainline
  OnGame table; only out-of-band metadata (hand-id ranges, table naming) differs in this
  corpus.
- `Seats/Full Ring (10 Handed).txt` and `Seats/4 Max.txt` are empty (3-byte, BOM-only)
  placeholders in the upstream corpus.

### 6. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-nlhe.txt | Baseline 6-max NLHE hand |
| 02-fixed-limit-holdem.txt | `(LIMIT TEXAS_HOLDEM ...)` token |
| 03-omaha-showdown.txt | Multi-way Omaha showdown, cards in `net:` lines |
| 04-pot-limit-omaha.txt | `(POT_LIMIT OMAHA_HI ...)` token |
| 05-pot-limit-omaha-hilo.txt | `OMAHA_HILO` token |
| 06-allin-showdown.txt | All-in, showdown reveal |
| 07-name-with-dashes.txt | Nickname `---Cockatrice---` (dash-heavy name trap) |
| 08-euro-table.txt | EUR-denominated table (`€` prefix) |
| 09-heads-up.txt | 2-handed |
| 10-full-ring-9handed.txt | 9-max |
| 11-no-hole-cards-visible.txt | Hand ends with no cards revealed |
| 12-multiple-hands-concatenated.txt | 10 hands in one session file |
| 13-ongameit-localized.txt | OnGameIt (`.it` skin) localization, EUR |

---

## Merge

### 1. Overview & status

Merge Gaming Network was a US-facing skin network that shut down in 2017. **Confirmed
from a real sample corpus** (32 files, dated 2012, USD tables). Format: XML,
UTF-8 with BOM.

### 2. Detection signature

```regex
^<description type="(Holdem|Omaha)" stakes="
```

Reference parser's hand-splitting regex: `(<description.*?</game>)|(<game.*?</game>)`.
Verified not to match any MicroGaming/BossMedia/Entraction/OnGame sample in this repo's
fixtures — the leading `<description type=...>` self-closed element before `<game>` is
unique to Merge among these five.

### 3. Full verbatim example hand

From `fixtures/samples/merge/01-basic-hand-nlhe.txt`:

```
<description type="Omaha" stakes="Pot Limit ($5/$10)"/>
<game id="56176485-33" starttime="20120529182537" numholecards="4" gametype="9" seats="6" realmoney="true" data="20120529|Ming Tombs (56176485)|56176485|56176485-33|false">
	<players dealer="4">
		<player seat="0" nickname="nemi711" balance="$829.00" dealtin="true" />
		<player seat="2" nickname="gamblegambel" balance="$400.00" dealtin="false" />
		<player seat="5" nickname="yuseff415" balance="$1169.00" dealtin="true" />
	</players>
	<round id="BLINDS" sequence="1">
		<event sequence="1" type="SMALL_BLIND" timestamp="1338333911875" player="5" amount="5.00"/>
		<event sequence="2" type="BIG_BLIND" timestamp="1338333912031" player="0" amount="10.00"/>
	</round>
	<round id="PREFLOP" sequence="2">
		<event sequence="3" type="RAISE" timestamp="1338333915687" player="5" amount="30.00"/>
		<event sequence="4" type="CALL" timestamp="1338333917468" player="0" amount="20.00"/>
	</round>
	<round id="POSTFLOP" sequence="3">
		<event sequence="5" type="CHECK" timestamp="1338333923812" player="5"/>
		<event sequence="6" type="CHECK" timestamp="1338333925265" player="0"/>
		<cards type="COMMUNITY" cards="5c,8d,4d"/>
	</round>
	<round id="POSTTURN" sequence="4">
		<event sequence="7" type="CHECK" timestamp="1338333928484" player="5"/>
		<event sequence="8" type="CHECK" timestamp="1338333929781" player="0"/>
		<cards type="COMMUNITY" cards="5c,8d,4d,7s"/>
	</round>
	<round id="POSTRIVER" sequence="5">
		<event sequence="9" type="CHECK" timestamp="1338333932218" player="5"/>
		<event sequence="10" type="CHECK" timestamp="1338333933578" player="0"/>
		<cards type="COMMUNITY" cards="5c,8d,4d,7s,Ks"/>
	</round>
	<round id="SHOWDOWN" sequence="6">
		<event sequence="11" type="SHOW" timestamp="1338333933984" player="5"/>
		<event sequence="12" type="SHOW" timestamp="1338333934875" player="0"/>
		<cards type="SHOWN" cards="Jc,9c,Kd,Jd" player="5"/>
		<cards type="SHOWN" cards="Ad,As,9h,Kc" player="0"/>
	</round>
	<round id="END_OF_GAME" sequence="7">
		<winner amount="59.50" uncalled="false" potnumber="1" player="0" hand="Pair of Aces" pottype="n"/>
	</round>
</game>
```

### 4. Key grammar notes

- Header: `<description type="Holdem|Omaha" stakes="No Limit ($sb/$bb)|Limit $sb/$bb|Pot
  Limit ($sb/$bb)"/>` immediately followed by `<game id="<table>-<hand>" ...>`.
- Currency: `$` literal inside the `stakes` description text; individual `amount="..."`
  attributes elsewhere are plain decimals.
- Streets: `<round id="PREFLOP|POSTFLOP|POSTTURN|POSTRIVER">` with a `<cards
  type="COMMUNITY" cards="..."/>` element that is **cumulative** (turn's list repeats the
  flop plus the new card, etc.), unlike OnGame's incremental-only board lines.
- Action verbs: `SMALL_BLIND`, `BIG_BLIND`, `RAISE`, `CALL`, `CHECK`, `FOLD`, `BET`,
  `MUCK`, `SHOW`.
- "SUMMARY": no literal block — `<round id="END_OF_GAME">` (showdown reached) or
  `<round id="END_OF_FOLDED_GAME">` (uncontested pot) contains one `<winner amount="..."
  uncalled="true|false" potnumber="N" player="<seat>" hand="<desc>"/>` per pot/winner; a
  `<round id="GAME_CANCELLED">` marks voided hands instead.

### 5. Gotchas

- `GAME_CANCELLED` hands are dealt (players/seats present) but have **no blinds/preflop
  round at all** — a parser that assumes every hand has at least a `BLINDS` round will
  break on cancelled/voided hands (see fixture 06).
- `END_OF_FOLDED_GAME` and `END_OF_GAME` are distinct terminal shapes: the former has a
  bare `<winner>`, the latter is preceded by a `SHOWDOWN` round with `SHOW` events and
  `<cards type="SHOWN">`.
- `<cards type="COMMUNITY">` is cumulative per round, unlike networks (e.g. OnGame) that
  only emit the newly-dealt card(s).
- There is no masked-card placeholder for players who don't show — their hole cards are
  simply absent from the XML, rather than represented by a sentinel value (contrast with
  MicroGaming/BossMedia's explicit "back of card" placeholders).

### 6. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-nlhe.txt | Baseline PLO hand through `SHOWDOWN`/`END_OF_GAME` |
| 02-fixed-limit-holdem.txt | `Limit $3/$6`, `END_OF_FOLDED_GAME` with a `MUCK` event |
| 03-pot-limit-omaha.txt | `description type="Omaha"`, `numholecards="4"` |
| 04-allin-showdown.txt | All-in, `SHOWDOWN` round with `SHOW`/`SHOWN` |
| 05-3bet-hand.txt | Preflop raise/re-raise (increment semantics) |
| 06-cancelled-hand.txt | `GAME_CANCELLED` round, no blinds/action at all |
| 07-folded-preflop.txt | Everyone folds preflop, `END_OF_FOLDED_GAME` |
| 08-heads-up.txt | `seats="2"` |
| 09-full-ring-9handed.txt | `seats="9"` (largest in this corpus) |
| 10-sitting-out.txt | `<player dealtin="false"/>` |
| 11-omaha-showdown.txt | Multi-way Omaha showdown, several `SHOW` events |
| 12-multiple-hands-concatenated.txt | 10 hands in one file — validates hand-splitting regex |

# ACR / WPN (Winning Poker Network) fixture sources

No synthetic fixtures in this directory. Every file is REAL, byte-copied (`cp`) from real
parser-test corpora. **This is the single most important finding for this site: WPN hand
histories come in (at least) three structurally different grammars depending on era, and two
different text encodings that do not correlate cleanly with era — see
`docs/research/hh-formats/acr-wpn.md` §1 for the full breakdown.** Do not write one parser
assuming one grammar.

## Corpora used

- **HHSmithy** — `github.com/HHSmithy/PokerHandHistoryParser`, path
  `HandHistories.Parser.UnitTests/SampleHandHistories/WinningPoker/CashGame/**`. Cloned to
  `/tmp/hhsmithy`. 40 files, all cash games, dated 2014 (`Game started at: 2014/...` — the
  "old"/verbose grammar, era A). All UTF-8 with BOM. Copied to `hhsmithy-corpus/`.
- **fpdb-3** — `github.com/jejellyroll-fr/fpdb-3` (a maintained fork of the FPDB poker
  tracker/HUD), path `regression-test-files/{cash,tour,summaries}/Winning/**`. This is fpdb-3's
  own **golden-snapshot regression corpus** for its Winning Poker Network converter
  (`fpdb_3_legacy/WinningToFpdb.py`) — i.e. these are real files that a maintained, currently-used
  parser is tested against today, not abandoned test data. Cloned to `/tmp/fpdb-3`. 58 files on
  disk, 37 unique after removing byte-identical duplicates that existed both at a directory's
  top level and inside its `Flop/`/`Stud/` subdirectory (verified by SHA-256, not just filename).
  Spans 2015-05 through 2022-07 and includes both the old "Game started at:" grammar (era A/B,
  including one file that is **UTF-16LE-encoded**, unlike every other file in this whole fixture
  set) and the modern "Hand #.../Game Hand #..." grammar (era C). Copied to
  `fpdb3-regression-corpus/`. The parser source itself (`WinningToFpdb.py`, 1906 lines) was read
  in full and is the primary secondary-source evidence behind every regex-level claim in the doc
  that isn't directly visible in a fixture (it contains two full sets of compiled regexes, one
  per era, with header-line examples in code comments dated to specific hands).

## Era summary (see doc for full detail)

- **Era A (2013-2014, `Game started at: YYYY/M/D H:MM:SS` / `Game ID: <id> <sb>/<bb> ...`)** —
  the entire hhsmithy corpus. UTF-8 with BOM in every hhsmithy file.
- **Era A/B persisted (confirmed to at least 2019)** — several fpdb-3 fixtures dated 2016-2019
  still use the *exact same* `Game started at:` grammar as the 2014 corpus (e.g. the 2019-02
  Six Plus Hold'em cash file, and a 2018-01 tournament file using **anonymized numeric player
  IDs**, see below). Encoding for these ranges from plain ASCII to UTF-16LE unpredictably — we
  found both encodings within 2016-dated files from the same regression suite, so **encoding is
  not a reliable era signal** and must be sniffed per file.
  - One 2018-01 tournament file (`tour__NLHE-NA-0-0 HH00000000 T2-G0-201801.data.mined.format.txt`)
    uses this old grammar but with **every player name replaced by a numeric ID** (e.g.
    `Seat 5: 794927806 (1980).`) — labelled by the fpdb-3 maintainers themselves as
    "data mined format", presumably an aggregated/anonymized export distinct from a player's own
    hand history. Real, but a genuinely different anonymization mode worth flagging.
- **Era C (confirmed 2019 onward, `Hand #<id> - <Game>(<Limit>) - <stakes> - <date> UTC` for
  cash, `Game Hand #<id> - Tournament #<id> - <Game>(<Limit>) - Level N (<stakes>)- <date> UTC`
  for tournaments)** — a completely different, much more PokerStars-like grammar. Confirmed
  real and current as of the newest fixture in this set, a 2022-07 tournament file.

## Fixture index

### `hhsmithy-corpus/` (era A, 2014, all cash games, UTF-8 BOM)

| file | what it demonstrates |
|---|---|
| CashGame_HandActionTests_BasicHand.txt | Baseline hand, `Game started at:`/`Game ID:` header, `Player X received a card.` deal lines, `------ Summary ------`, per-player `Bets:/Collects:/Wins:`/`Loses:` lines |
| CashGame_HandActionTests_Straddle.txt | `Player X straddle (amt)` — voluntary straddle grammar |
| CashGame_HandActionTests_PostingDead.txt | `Player X posts (amt) as a dead bet` immediately followed by `Player X posts (amt)` (dead + live post as two consecutive lines) |
| CashGame_HandActionTests_StrangePlayerNames.txt | Player name `((((??????!!!!!!))))` — arbitrary punctuation in names |
| CashGame_HandActionTests_PlayerNameWithParanthesis.txt | Player name `Cellar door` and others containing spaces/parens, forcing the reference parser to locate the amount *after* the name rather than splitting on `(` |
| CashGame_HandActionTests_UncalledBet.txt / CashGame_PlayerTests_UncalledBet.txt | `Uncalled bet (amt) returned to X` grammar |
| CashGame_HandActionTests_WaitBB.txt / CashGame_PlayerTests_WaitingBB.txt | `Player X is timed out.` immediately followed by `Player X wait BB` — player waiting for the big blind before joining |
| CashGame_PlayerTests_NoNameSitoutLine.txt | A completely blank player name (`Player  is timed out.` / `Player  sitting out` with a literal double space) — the seat exists but the name field is empty |
| CashGame_PlayerTests_WithSittingOut.txt | `Player X sitting out` mid-hand |
| CashGame_ValidHandTests_CancelledHand.txt | A hand with only 2 seated players, one `sitting out`, no cards ever dealt, `Uncalled bet` immediately, pot 0 — the reference parser's own cancelled-hand heuristic is "no `has big blind (` line anywhere" |
| CashGame_Tables_Table1.txt … Table6.txt | Table-name variety: `Cristalite (JP)`, `Braunite ( Beast )`, `Barstowite   (Short, JP)` (irregular internal spacing, real not a copy artifact), `Wichita Falls` (play money) |
| CashGame_GameTypeTests_CapNoLimitHoldem.txt / NoLimitHoldem.txt / PotLimitOmaha.txt | Game-type token variety in `Game ID:` line: plain `(Hold'em)`, `(Omaha)`, and `- CAP -` table-type marker |
| CashGame_Limits_Limit1/2/3.txt | Different stakes for the same header grammar |
| CashGame_PlayerTests_OmahaShowdown.txt / WithShowdown.txt | Showdown grammar `*Player X shows: <hand desc> [<cards>]. Bets: .. Collects: .. Wins: ..` (leading `*` marks the shown/winning hand) |
| CashGame_StreetTests_Preflop/Flop/Turn/River.txt | Confirms street marker `*** FLOP ***: [..]` **with a colon after the stars** — era-A-specific, see doc §7 |
| CashGame_MultipleHandsTests_10MultipleHands.txt | Multi-hand file, hands separated by a single blank line |
| CashGame_ValidHandTests_ValidHand.txt | Reference parser's own well-formedness fixture (`IsValidHand` requires the last line to start with `Game ended at:`) |
| CashGame_ValidHandTests_InValidHand.txt | **REAL BYTES, SELF-DAMAGED — DO NOT MAKE A PARSER ACCEPT THIS.** Negative fixture, and damaged in a second way beyond the missing `Game ended at:` trailer: **the summary is truncated to 2 of the 6 declared seats.** The hand declares `Seat 1`–`Seat 6` and `bjv1105` bets through every street and takes back an uncalled 35, yet the `------ Summary ------` block lists only `Ra1syDa1sy` and `rexjellis` — `bjv1105`, the player who actually won the pot, has no summary line at all. Pot accounting cannot close. A parser should **refuse** the hand; do not reconstruct the missing seats. Keep as a robustness fixture for the refusal path. |
| CashGame_GeneralHands_GeneralHand.txt / HeroName.txt | Baseline + hero-name variant (no dedicated hero marker in era A — hero is just whichever real screen name is present) |
| CashGame_PlayerTests_NoHoleCards.txt | Hand where a player's cards are never shown (`received a card.` twice, no `received card: [..]` ever) |

### `fpdb3-regression-corpus/` (37 files, eras A/B and C mixed, 2015-2022)

| file(s) | era | what it demonstrates |
|---|---|---|
| `cash__NLHE-6max-USD-0.02-0.05-201608...txt` | A/B | **UTF-16LE encoded** (verified with `file`) — the only non-UTF-8 file in this entire project's fixture set. Same `Game started at:` grammar as 2014, dated 2016 |
| `cash__6+Holdem-6-max-USD-0.02-0.05-201902...txt` | A/B | 2019, plain ASCII (not UTF-16) — proves encoding does not correlate with date; Six Plus Hold'em (short-deck) game-type token `(Six Plus Hold'em)` |
| `cash__7-Stud-8max...txt` / `cash__7-Stud-HL-8max...txt` | A/B, UTF-16LE | 7-card stud street markers **mixed-case with colon**: `*** Third street ***`, `*** Fourth street ***`, `*** Fifth street ***`, `*** Sixth street ***` (contrast the all-caps `*** FLOP ***` used for flop games) plus `bring in (amt)` bring-in grammar and a `JP fee` (jackpot fee) line appended to the Pot/Rake summary line |
| `cash__LHE-2max-USD-2.00-4.00-201608...txt` | A/B | Fixed-limit heads-up |
| `tour__NLHE-NA-0-0 HH00000000 T2-G0-201801.data.mined.format.txt` | A/B | **Anonymized numeric player IDs** (`Seat 5: 794927806 (1980).`) in an otherwise era-A/B grammar tournament — a distinct "data mined" export mode, real but rare; also shows `doesn't show cards.` (contracted) vs the uncontracted `does not show cards.` used elsewhere for the identical situation |
| `cash__NLHE-9max-USD-0.02-0.05-202104.post.dead.txt` | C (modern) | Modern-era `posts dead $<amt>` grammar, `Main pot $X \| Rake $X` line repeated after every street header, lowercase full-reconstructed-hand showdown descriptions (`two pair, Eights and Threes [8d 8c 3s 3c Ac]`) |
| `cash__NLHE-9max-USD-0.02-0.05-202104.walk.txt` | C | A walked big blind (everyone folds preflop), `Total pot $0.07` with no `Board` line at all (hand never reached the flop) |
| `cash__NLHE-9max-USD-0.01-0.02-201911.CASHID-TN-Miramar (Cap) GAMETYPE.txt` | C | `caps $<amt>` action verb (cap-game-specific), `Total pot $X \| Rake $X \| JP Fee $X` three-part summary line (Title Case `JP Fee` — contrast lowercase `JP fee` in era A/B) |
| `cash__NLO8-6max-USD-3-6-202104.RIT.txt` / `.walk.txt` | C | Omaha Hi/Lo-8, run-it-twice (`RIT`) |
| `cash__PLO8-6max-USD-40-80-201610.disconnected.allin.HH00000000 G0.txt` | A/B | Disconnection during an all-in |
| `tour__NLHE-8max-NA-0-0-202207.GTD.txt` | C | Newest fixture in the whole set (2022-07); tournament header `Game Hand #<id> - $<amt> GTD Tournament #<id> - Holdem(No Limit) - Level N (<sb>/<bb>)- <date> UTC` (note: **no space** before the dash after the blinds parenthesis), ante posting, `Table '<n>' <N>-max Seat #<n> is the button` (quoted numeric table id — contrast the bare-name cash table line, see doc §5) |
| `tour__NLHE-2max-USD-2.20.../Turbo.txt`, `.../Hyper.txt` | A/B | Tournament speed variants in the table-name field: `$2.20 Turbo Heads-up, Table 1`, `$2.40 Hyper Turbo Heads-up, Table 1` |
| `tour__NLHE-9max-FREE-HH20160914.../ante.txt`, `tour__NLHE-9max-USD-.../ante.2.txt` | A/B | Tournament ante posting in era-A/B grammar: `Player X ante (amt)` |
| `tour__PLO8-9max-USD-15-201906.SITGOID-TN-...GAMETYPE.txt` | C | Omaha Hi/Lo-8 Sit & Go, `SITGOID`/`GAMETYPE` filename-embedded metadata tokens used by fpdb to recover buy-in info that isn't in the hand text itself |
| `tour__NLHE-NA-0-0 HH00000000 T1-G0-201601.unknown.player.acts.txt` | A/B | Regression case for a player acting who was never in the visible seat list (edge case worth a defensive test) |
| `tour__NLHE-NA-0-0 HH20190118 T9360380-G0-201901.txt` | C (transitional, Jan 2019) | One of the earliest confirmed instances of the modern `Hand #.../Game Hand #...` grammar in this corpus |
| `tour__NLHE-9max-NA-0-0-201907.SCHEDULEDID-TN-The Venom...GAMETYPE.txt` | C | Full modern-grammar MTT hand: ante + `posts the small/big blind`, `*** HOLE CARDS ***`, `Main pot` line placed immediately after `*** HOLE CARDS ***` (not just after flop/turn/river), `Uncalled bet (..) returned to`, `does not show`, summary `folded on the Pre-Flop and did not bet` phrasing |
| `summaries__PlayerTransactionHistory.html` | n/a | Not a hand history — an HTML bankroll/transaction export fpdb also knows how to parse. Kept for completeness of what "WPN account exports" can look like, but out of scope for hand-history parsing |
| (remaining PLO/PLO8/LO8/7Stud/NLHE files) | mixed A/B and C | Additional stakes/game-type/seat-count coverage; see filenames, which encode game-game-max-currency-stakes-date-note |


### Blank player names on money-moving lines (real, and hostile)

`fpdb3-regression-corpus/cash__NLHE-9max-USD-1.00-2.00-201612.Unknown.Player.Acts.HH20160621 G30997753.txt` contains a player whose **name is the empty string**, on lines that move real money. Verbatim:

```
Player  bets (5.22)
Player Hero calls (5.22)
*** RIVER ***: [5s Jc Kc 2s] [7s]
Player  bets (10.18)
Player Hero folds
Uncalled bet (10.18) returned to
Player  mucks cards
```

Note `Player  bets` carries a **double space** where the name would be, and `Uncalled bet (10.18) returned to` ends with **nothing at all** — no name, no trailing space guarantee. This is real site output, not corpus damage: upstream names the file `Unknown.Player.Acts`, and the hand is otherwise internally consistent (`Pot: 20.37. Rake 0.83. JP fee 0.24` reconciles). Consequences for a parser: a `returned to (\S+)` regex fails to match at all rather than matching empty, and any player-keyed map needs a non-empty-name guard or it silently merges this actor with another. Do **not** discard the hand — the money is real and the rest of it balances — but do not key identity on the name either. See also `acr-wpn.md` gotcha on `Unknown player` as a valid sentinel actor name.

## What we did NOT find

- No sample bearing an explicit "America's Cardroom" / "ACR" / "Black Chip Poker" / "True
  Poker" / "Ya Poker" brand string anywhere in the hand text itself — **WPN skins never print
  their brand name in the hand history at all**, in any era. This is confirmed across all 77
  files: the header always says `Game ID:`/`Game started at:` (era A/B) or bare `Hand #`/`Game
  Hand #` (era C), never a skin name. A parser cannot distinguish ACR from Black Chip Poker from
  the hand text; only the account/file source tells you which skin it came from.
- No confirmed sample of a straddle, ante, or dead-blind post in the **modern (era C)** grammar
  in our corpus for a cash game specifically that also reaches showdown with full descriptive
  text for uncommon hands (e.g. straight flush) — plausible but unconfirmed. Do not invent exact
  wording for these; the era-C action-verb list in the doc is only as complete as what's in the
  fixtures.

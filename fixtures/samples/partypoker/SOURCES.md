# partypoker — sample sources

All files below are byte-exact copies (`cp`, UTF-8 with BOM, LF line endings as checked out from the
source git repo — see Gotchas in the main doc re: original network exports likely using CRLF) from the
[HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser) unit-test corpus,
retrieved 2026-09-16. Era: ~2012–2015 (real-money cash games only; no tournament sample exists in this
corpus — see docs/research/hh-formats/partypoker.md for the tournament-format gap and what was found
via secondary sources instead). No file has been retyped, reformatted, or had its bytes altered.

Excluded from the kept set: `Seats/Full Ring (10 Handed).txt` is a broken/empty fixture in the upstream
corpus (BOM only, 0 hand content) and was not copied.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-basic-hand-nlhe.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/PartyPoker/CashGame/HandActionTests/BasicHand.txt | 2026-09-16 | REAL | Baseline 3-handed $0.05/$0.10 NLHE cash hand, full street progression, showdown with both hands shown/mucked |
| 02-allin-side-pot-showdown.txt | .../PartyPoker/CashGame/HandActionTests/AllInHandWithShowdown.txt | 2026-09-16 | REAL | 6-max hand with two `is all-In` players, a side pot AND a main pot each with their own `wins ... from the side pot 1` / `wins ... from the main pot` line |
| 03-threebet-no-showdown.txt | .../PartyPoker/CashGame/HandActionTests/3BetHand.txt | 2026-09-16 | REAL | Heads-up preflop 3-bet/4-bet, hand ends on a fold with `does not show cards.` |
| 04-dead-blind-and-timebank.txt | .../PartyPoker/CashGame/HandActionTests/Posting.txt | 2026-09-16 | REAL | `posts big blind + dead [$3]` (post-to-enter dead-blind notation) and repeated `will be using their time bank for this hand.` lines on 3 separate streets |
| 05-sitting-out-and-join-mid-hand.txt | .../PartyPoker/CashGame/HandActionTests/SittingOut.txt | 2026-09-16 | REAL | `is sitting out` before posting, `Dealt to <hero> [  6s 2d 5d 3c ]` hole-card line (4 cards — Omaha), `<name> has joined the table.` mid-hand |
| 06-timebank-warning.txt | .../PartyPoker/CashGame/HandActionTests/TimeBank.txt | 2026-09-16 | REAL | Distinct singular phrasing `Your time bank will be activated in 6 secs. If you do not want it to be used, please act now.` (different wording from file 04's plural "will be using their time bank") |
| 07-player-leaves-and-joins.txt | .../PartyPoker/CashGame/HandActionTests/PlayerLeavingTable.txt | 2026-09-16 | REAL | `<name> has left the table.` both mid-hand (a folded/inactive player) and after the hand result line |
| 08-omaha-hilo-split-pot.txt | .../PartyPoker/CashGame/HandActionTests/OmahaHiLo.txt | 2026-09-16 | REAL | PL Omaha Hi-Lo: `shows7,5,4,2,A  for low.` (no space/brackets, note the doubled internal space), separate `wins Lo ($28.75 USD) from the main pot with 7,5,4,2,A.` line, side pot + main pot split across hi/lo |
| 09-fixed-limit-holdem.txt | .../PartyPoker/CashGame/GameTypeTests/FixedLimitHoldem.txt | 2026-09-16 | REAL | `FL Texas Hold'em` game-type token, 10-max table (`Total number of players : 7/10`) |
| 10-pot-limit-omaha-thousands-separator.txt | .../PartyPoker/CashGame/GameTypeTests/PotLimitOmaha.txt | 2026-09-16 | REAL | `$1,000 USD PL Omaha` header — comma thousands separator in the stakes token |
| 11-heads-up.txt | .../PartyPoker/CashGame/Seats/HeadsUp.txt | 2026-09-16 | REAL | 2-max table, `Total number of players : 2/2` |
| 12-no-dp-table-name-variant.txt | .../PartyPoker/CashGame/PlayerTests/WithSittingOut.txt | 2026-09-16 | REAL | `Table Table  202250 (No DP) (Real Money)` — numeric-only table name with a double space AND a `(No DP)` qualifier; also `$5,000 USD NL Texas Hold'em` high-stakes thousands separator; 2012-dated (oldest sample in this set, useful for confirming header shape is stable back to at least 2012) |
| 13-hero-name-dealt-cards.txt | .../PartyPoker/CashGame/GeneralHands/HeroName.txt | 2026-09-16 | REAL | `Dealt to PP_Hero [  Jc Kd ]` — the only-see-your-own-cards convention, hero name pattern used by the test suite |
| 14-multiple-hands-concatenated.txt | .../PartyPoker/CashGame/MultipleHandsTests/5MultipleHands.txt | 2026-09-16 | REAL | 5 consecutive hands in one file; validates the hand-splitting markers: a leading `#Game No : <id>` line before each `***** Hand History for Game <id> *****` banner, and a trailing `Game #<id> starts.` + blank line before the next hand's `#Game No` line |
| 15-invalid-hand-truncated.txt | .../PartyPoker/CashGame/ValidHandTests/InValidHand.txt | 2026-09-16 | REAL | Hand truncated mid-action (ends right after a `folds`, no `wins` line, no shown/mucked cards) — upstream test fixture for "incomplete/corrupt hand" detection; useful as a negative-path fixture for a parser's "did this hand actually finish" check |

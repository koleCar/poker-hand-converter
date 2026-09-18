# BossMedia — sample sources

All files are byte-exact copies (`cp`, UTF-8 with BOM, LF line endings preserved) from the
[HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser) unit-test
corpus, retrieved 2026-09-16. No file has been retyped, reformatted, or had its bytes altered.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-basic-hand-omaha.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/HandActionTests/BasicHand.txt | 2026-09-16 | REAL | Baseline `GAME_OMA` (PL Omaha) hand, SEK currency, `<HISTORY>`/`<PLAYER>`/`<ACTION>` skeleton |
| 02-fixed-limit-holdem.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/GameTypeTests/FixedLimitHoldem.txt | 2026-09-16 | REAL | `LIMIT="FL"`, `GAME="GAME_THM"` (Texas Hold'em) |
| 03-no-limit-holdem-malformed-root.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/GameTypeTests/NoLimitHoldem.txt | 2026-09-16 | REAL | `LIMIT="NL"`; file's trailing bytes are the literal, unmatched `</HISTORY></ROOT>` plus a blank line — a real-world malformed-XML gotcha (no `<ROOT>` was ever opened) |
| 04-pot-limit-omaha.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/GameTypeTests/PotLimitOmaha.txt | 2026-09-16 | REAL | `GAME="GAME_OMA"`, `LIMIT="PL"` |
| 05-pot-limit-omaha-hilo.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/GameTypeTests/PotLimitOmahaHiLo.txt | 2026-09-16 | REAL | Omaha Hi/Lo game type variant |
| 06-allin-showdown.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/HandActionTests/AllInHandWithShowdown.txt | 2026-09-16 | REAL | All-in and showdown with `<SHOWDOWN>`/`<RESULT>` elements including `WINCARDS` |
| 07-3bet-hand.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/HandActionTests/3BetHand.txt | 2026-09-16 | REAL | Preflop raise/re-raise sequencing via repeated `ACTION_RAISE` |
| 08-omaha-showdown.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/PlayerTests/OmahaShowdown.txt | 2026-09-16 | REAL | Multi-way Omaha showdown, `<RESULT>` for every remaining player including folded ones (`HAND="$(STR_G_FOLD)"`) |
| 09-multiple-hands-concatenated.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/MultipleHandsTests/10MultipleHands.txt | 2026-09-16 | REAL | 10 consecutive `<HISTORY>` elements in one session file — validates split-on-literal-string `"<HISTORY "` (not proper XML parsing) |
| 10-no-hole-cards-visible.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/BossMedia/CashGame/PlayerTests/NoHoleCards.txt | 2026-09-16 | REAL | Hero-less log where dealt hole cards are masked as `<CARD LINK="b"/>` placeholders for opponents |

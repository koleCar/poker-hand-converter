# Entraction — sample sources

All files are byte-exact copies (`cp`, UTF-8 with BOM, LF line endings preserved) from the
[HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser) unit-test
corpus, retrieved 2026-09-16. No file has been retyped, reformatted, or had its bytes altered.

Note: several files in the upstream corpus's `Entraction/CashGame/` tree are mislabeled or broken and
were deliberately excluded here since they would misrepresent the Entraction format (see the Gotchas
section of the main doc): `Seats/Full Ring (10 Handed).txt` and `PlayerTests/WithSittingOut.txt` are
both verbatim **PokerStars**-format hands, not Entraction format, and `Seats/4 Max.txt` is an empty
(3-byte BOM-only) placeholder.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-basic-hand-nlhe.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/HandActionTests/BasicHand.txt | 2026-09-16 | REAL | Baseline heads-up NLHE hand, full street progression, showdown, EUR stakes |
| 02-fixed-limit-holdem.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/GameTypeTests/FixedLimitHoldem.txt | 2026-09-16 | REAL | "Texas Hold'em Fixed Limit EUR ..." header phrasing |
| 03-pot-limit-holdem.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/GameTypeTests/PotLimitHoldem.txt | 2026-09-16 | REAL | "Texas Hold'em Pot Limit EUR ..." header phrasing |
| 04-pot-limit-omaha.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/GameTypeTests/PotLimitOmaha.txt | 2026-09-16 | REAL | "Omaha High Pot Limit EUR ..." header phrasing |
| 05-five-card-pot-limit-omaha.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/GameTypeTests/FiveCardPotLimitOmaha.txt | 2026-09-16 | REAL | "5-Card Omaha High Pot Limit" — 5-card-Omaha variant, `shows:` lines carry 5 hole cards |
| 06-fixed-limit-omaha-hilo.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/GameTypeTests/FixedLimitOmahaHiLo.txt | 2026-09-16 | REAL | Omaha Hi/Lo, fixed limit |
| 07-allin-showdown.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/HandActionTests/AllInHandWithShowdown.txt | 2026-09-16 | REAL | All-in and showdown reveal phrasing (`shows:`) |
| 08-euro-table.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/Limits/EuroTable.txt | 2026-09-16 | REAL | EUR-denominated table, explicit `EUR` currency prefix on every amount |
| 09-heads-up.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/Seats/HeadsUp.txt | 2026-09-16 | REAL | 2-handed table, `Players(max 2):` header |
| 10-full-ring-9handed.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/Seats/Full%20Ring%20(9%20Handed).txt | 2026-09-16 | REAL | 9-max seating, `Players(max 9):` header — the largest legitimate seat-count sample in this network's corpus (see note above) |
| 11-showdown-reveal.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/PlayerTests/WithShowdown.txt | 2026-09-16 | REAL | Showdown with both players' `shows:` lines revealed |
| 12-omaha-hilo-showdown-split-pot.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/PlayerTests/OmahaHiLoShowdown.txt | 2026-09-16 | REAL | Hi/Lo split pot — two separate `wins:` lines |
| 13-multiple-hands-concatenated.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Entraction/CashGame/MultipleHandsTests/10MultipleHands.txt | 2026-09-16 | REAL | 10 consecutive hands in one file — validates the hand-splitting regex on `Game #.*?Game.*?\w\w\w(+\|-)(\d+:\d+)` (i.e. splits on the `Game ended ... GMT+HH:MM` trailer, not the header) |

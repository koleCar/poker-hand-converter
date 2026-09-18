# OnGame (+ OnGameIt) — sample sources

All files are byte-exact copies (`cp`, UTF-8 with BOM, LF line endings preserved) from the
[HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser) unit-test
corpus, retrieved 2026-09-16. No file has been retyped, reformatted, or had its bytes altered.

Note: the upstream corpus has several mislabeled/broken files under `OnGame/CashGame/` that were
deliberately excluded here since they would misrepresent the OnGame format (see the Gotchas
section of the main doc): `GameTypeTests/CapNoLimitHoldem.txt` and `GameTypeTests/PotLimitHoldem.txt`
are verbatim **PokerStars**-format hands; `PlayerTests/WithSittingOut.txt` is a verbatim (older-style)
**PartyPoker**-format hand (`***** Hand History for Game ... *****`); and `Seats/Full Ring (10 Handed).txt`
plus `Seats/4 Max.txt` are empty (3-byte BOM-only) placeholder files.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-basic-hand-nlhe.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/HandActionTests/BasicHand.txt | 2026-09-16 | REAL | Baseline 6-max NLHE hand, plain-text `***** History for hand ... *****` / `Table: ... (LIMIT GAME, Real money)` / `Summary:` skeleton |
| 02-fixed-limit-holdem.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/GameTypeTests/FixedLimitHoldem.txt | 2026-09-16 | REAL | `(LIMIT TEXAS_HOLDEM ...)` game-type token, heads-up, blinds posted out of position (SB > BB order quirk) |
| 03-omaha-showdown.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/PlayerTests/OmahaShowdown.txt | 2026-09-16 | REAL | Multi-way Omaha showdown with hole cards revealed in the `net:` summary lines |
| 04-pot-limit-omaha.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/GameTypeTests/PotLimitOmaha.txt | 2026-09-16 | REAL | `(POT_LIMIT OMAHA_HI ...)`, 4 hole cards shown in the `net:` summary line |
| 05-pot-limit-omaha-hilo.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/GameTypeTests/PotLimitOmahaHiLo.txt | 2026-09-16 | REAL | `OMAHA_HILO` game-type token |
| 06-allin-showdown.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/HandActionTests/AllInHandWithShowdown.txt | 2026-09-16 | REAL | All-in action, showdown with revealed hole cards in the summary `net:` lines |
| 07-name-with-dashes.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/HandActionTests/NameWithDashes.txt | 2026-09-16 | REAL | Nickname `---Cockatrice---` — a screen name consisting largely of literal `-` characters, a naive-parser trap since `-` is also used as a raw suit-less separator elsewhere in the format |
| 08-euro-table.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/Limits/EuroTable.txt | 2026-09-16 | REAL | EUR-denominated table (`€` symbol prefixing every amount instead of `$`) |
| 09-heads-up.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/Seats/HeadsUp.txt | 2026-09-16 | REAL | 2-handed table |
| 10-full-ring-9handed.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/Seats/Full%20Ring%20(9%20Handed).txt | 2026-09-16 | REAL | 9-max seating (non-contiguous seat numbers) — the largest legitimate seat-count sample in this network's corpus (see note above) |
| 11-no-hole-cards-visible.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/PlayerTests/NoHoleCards.txt | 2026-09-16 | REAL | Hand ends without any hole cards being revealed (no showdown) |
| 12-multiple-hands-concatenated.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGame/CashGame/MultipleHandsTests/10MultipleHands.txt | 2026-09-16 | REAL | 10 consecutive `***** History for hand ... *****` ... `***** End of hand ... *****` blocks in one session file |
| 13-ongameit-localized.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/OnGameIt/CashGame/Limits/EuroTable.txt | 2026-09-16 | REAL | The **OnGameIt** (`.it`-skin) variant of the same plain-text format — structurally identical to mainline OnGame but EUR-only in this corpus; confirms OnGameIt is a localized re-skin, not a distinct grammar |

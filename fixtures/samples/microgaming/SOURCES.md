# MicroGaming — sample sources

All files are byte-exact copies (`cp`, LF line endings preserved) from the
[HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser) unit-test
corpus, retrieved 2026-09-16. No file has been retyped, reformatted, or had its bytes altered.

## Encoding — not all files are UTF-8

Most files are UTF-8 with a BOM, but **three are not valid UTF-8 at all**. They carry the raw
byte `0x80` (Windows-1252 `€`) inside the XML `tablename` attribute:

| file | `0x80` count | context |
|---|---|---|
| `02-fixed-limit-holdem.txt` | 1 | `tablename="… €2 Max"` |
| `03-pot-limit-omaha.txt` | 1 | `tablename="… €2 Max"` |
| `04-pot-limit-omaha-hilo.txt` | 1 | `tablename="Micro HILO 7 - €2 Max"` |

Decoding these as UTF-8 raises `UnicodeDecodeError`; `iconv -f WINDOWS-1252` recovers them.
Note the byte sits inside an **XML attribute value**, so an XML parser handed a UTF-8-decoded
string will fail or mangle the table name before any hand-level logic runs.

This is not a MicroGaming quirk — the same Windows-1252 `0x80` appears in Winamax (4 files) and
Unibet (1 file), and ACR/WPN has 14 files in UTF-16LE. See `docs/research/FORMAT-MATRIX.md` §5
for the corpus-wide picture and why grepping for `0x80` is the wrong detection test.

Note: the upstream corpus's `MicroGaming/CashGame/Seats/` folder is partly unusable —
`HeadsUp.txt` actually contains an unrelated "Cassava Hand History" plain-text hand (not
MicroGaming XML at all), and both `4 Max.txt` and `Full Ring (10 Handed).txt` are empty
(3-byte BOM-only placeholder files). None of the three were used here; see the Gotchas
section of the main doc.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-basic-hand-nlhe.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/HandActionTests/BasicHand.txt | 2026-09-16 | REAL | Baseline 6-max NLHE hand, full XML skeleton (`<Game>`/`<Seats>`/`<Gameplay>`), fold-to-win with no showdown |
| 02-fixed-limit-holdem.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/GameTypeTests/FixedLimitHoldem.txt | 2026-09-16 | REAL | `betlimit="FL"` fixed-limit game type |
| 03-pot-limit-omaha.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/GameTypeTests/PotLimitOmaha.txt | 2026-09-16 | REAL | `gametype="Omaha"`, `betlimit="PL"`, 4-card deals |
| 04-pot-limit-omaha-hilo.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/GameTypeTests/PotLimitOmahaHiLo.txt | 2026-09-16 | REAL | `gametype="Omaha H/L"`, split-pot `<Action type="Win">` with two `<Seat>` winners and `lowhandwin="1"` |
| 05-allin-showdown.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/HandActionTests/AllInHandWithShowdown.txt | 2026-09-16 | REAL | `AllIn` action type, `MoneyReturned` (uncalled bet refund), `ShowCards` at showdown |
| 06-3bet-hand.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/HandActionTests/3BetHand.txt | 2026-09-16 | REAL | Preflop raise/re-raise sequencing (`Raise` actions carry the total-to amount, not the increment) |
| 07-disconnected-badbeat-jackpot.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/HandActionTests/Disconnected.txt | 2026-09-16 | REAL | `Disconnect` action seat event, `BadBeatContribution` action (jackpot rake taken as a pseudo-action, not real rake), 9-max table, `currencyId` attribute (newer hhversion variant, 2015-dated) |
| 08-full-ring-9handed.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/Seats/Full%20Ring%20(9%20Handed).txt | 2026-09-16 | REAL | 9-max seating (`totalplayers="4"`/`tablesize="9"` style attributes) — the only legitimate seat-count variant available in this network's corpus (see note above) |
| 09-omaha-hilo-showdown-split-pot.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/PlayerTests/OmahaHiLoShowdown.txt | 2026-09-16 | REAL | Omaha Hi/Lo showdown with an uneven hi/lo pot split between two players |
| 10-sitting-out.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/PlayerTests/WithSittingOut.txt | 2026-09-16 | REAL | `<Seat sittingout="true"/>` attribute on dealt-out players |
| 11-multiple-hands-concatenated.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/MultipleHandsTests/10MultipleHands.txt | 2026-09-16 | REAL | 10 consecutive `<Game>` elements concatenated back-to-back in one file/session log — validates the hand-splitting regex `(<Game hhversion)` |
| 12-showdown-show-and-muck.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/MicroGaming/CashGame/PlayerTests/WithShowdown.txt | 2026-09-16 | REAL | Mixed `ShowCards`/`MuckCards` at showdown among 3 players |

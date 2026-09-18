# Winamax fixture sources

No synthetic fixtures in this directory. Every file below is REAL, copied byte-for-byte
(`cp`, preserving BOM/no-BOM and line endings exactly) from a real parser-test corpus.

## Corpus used

- **HHSmithy** — `github.com/HHSmithy/PokerHandHistoryParser`, path
  `HandHistories.Parser.UnitTests/SampleHandHistories/Winamax/CashGame/**`. Cloned locally to
  `/tmp/hhsmithy`. All 28 files in that directory are cash-game hands; there is no tournament
  sample anywhere in this corpus (confirmed by reading the corresponding parser,
  `HandHistories.Parser/Parsers/FastParser/Winamax/WinamaxFastParserImpl.cs`: `ParsePokerFormat`
  is hardcoded to return `PokerFormat.CashGame`, and both `ParseTournamentId` and `ParseBuyin`
  `throw new NotImplementedException()` — the parser this corpus was built for never supported
  Winamax tournaments at all). Hands are dated 2013-10 through 2015-03 (era: Winamax's
  "New tables" client generation, `Winamax Poker - CashGame - HandId: #...` header style, which
  has not changed to date). **One file was excluded**: the corpus's
  `CashGame/HandActionTests/OmahaHiLo.txt` does not actually contain a Winamax hand — it is a
  mislabeled/miscommitted `<Game hhversion="4" ...>` iPoker-network XML hand history that ended
  up in the wrong folder upstream (verified with `file` + manual read; the XML shows
  `tablename="Micro HILO 7 - €2 Max"` and iPoker-style `<Action type="...">` elements, nothing
  Winamax-specific). It was copied out and then deleted from this fixture set so it doesn't
  poison a Winamax-format parser's test suite.

No tournament sample was found for Winamax anywhere in this research pass (see the "Status"
note at the top of `docs/research/hh-formats/winamax.md` — the tournament header grammar in
that doc is describing the same `HandId:` grammar as cash but is NOT confirmed against a real
tournament sample; treat it as inferred/lower-confidence).

## Encoding note (important, discovered directly from these bytes)

Two distinct real encodings are present in this one small corpus, both from the same era:
- Most files: **UTF-8 with a BOM** (`EF BB BF`), LF line endings only (no `\r`).
- `CashGame_ValidHandTests_ValidHand.txt` and `CashGame_ValidHandTests_InValidHand.txt`: **no
  BOM**, and the € sign is encoded as **Windows-1252** (`iconv -f WINDOWS-1252` recovers it
  correctly; read as UTF-8 it renders as U+FFFD `�`). `InValidHand.txt` is additionally a
  deliberately-corrupted negative fixture (see table).

## Fixture index

| file | provenance URL | date retrieved | status | what it demonstrates |
|---|---|---|---|---|
| CashGame_HandActionTests_BasicHand.txt | github.com/HHSmithy/PokerHandHistoryParser `.../CashGame/HandActionTests/BasicHand.txt` | 2026-09-16 | REAL | Baseline 5-max NLHE cash hand, `*** ANTE/BLINDS ***` → `*** PRE-FLOP ***` → `*** FLOP ***` → uncalled-street win, `*** SUMMARY ***` with `Rake` |
| CashGame_HandActionTests_3BetHand.txt | `.../CashGame/HandActionTests/3BetHand.txt` | 2026-09-16 | REAL | Preflop 3-bet/4-bet sizing grammar: `raises X to Y` |
| CashGame_HandActionTests_AllInHandWithShowdown.txt | `.../CashGame/HandActionTests/AllInHandWithShowdown.txt` | 2026-09-16 | REAL | `raises X to Y and is all-in`, full run to `*** SHOW DOWN ***`, `shows [..] (One pair : Queens)`, one player `mucked` |
| CashGame_HandActionTests_FoldedPreflop.txt | `.../CashGame/HandActionTests/FoldedPreflop.txt` | 2026-09-16 | REAL | Everyone folds preflop, `Total pot X | No rake` (no `Rake` token at all when rake is zero) |
| CashGame_GeneralHands_GeneralHand.txt | `.../CashGame/GeneralHands/GeneralHand.txt` | 2026-09-16 | REAL | Generic full hand to showdown, `Board: [..]` (colon before the bracket — unlike PokerStars' `Board [..]`) |
| CashGame_GeneralHands_HeroName.txt | `.../CashGame/GeneralHands/HeroName.txt` | 2026-09-16 | REAL | `Dealt to WM_Hero [4c 5s]` line — the only reliable way to identify which seat is "hero" in a Winamax file (there is no separate hero marker on the seat line itself) |
| CashGame_Limits_Limit1.txt / Limit2.txt / Limit3.txt | `.../CashGame/Limits/Limit{1,2,3}.txt` | 2026-09-16 | REAL | Three different stake levels (0.05€/0.10€, 0.50€/1€, 5€/10€) confirming the `(SB€/BB€)` header grammar scales with no thousands separator |
| CashGame_MultipleHandsTests_10MultipleHands.txt | `.../CashGame/MultipleHandsTests/10MultipleHands.txt` | 2026-09-16 | REAL | 10 consecutive hands in one file; hands are separated by **5 blank lines**, not 1 — a real multi-hand-file splitting gotcha |
| CashGame_PlayerTests_NoHoleCards.txt | `.../CashGame/PlayerTests/NoHoleCards.txt` | 2026-09-16 | REAL | Heads-up hand where nobody's hole cards are ever revealed (no `Dealt to` line, no showdown) |
| CashGame_PlayerTests_OmahaShowdown.txt | `.../CashGame/PlayerTests/OmahaShowdown.txt` | 2026-09-16 | REAL | PLO full showdown with 4-card hands shown, `Two pairs : Kings and Jacks` hand-description grammar |
| CashGame_PlayerTests_WithShowdown.txt | `.../CashGame/PlayerTests/WithShowdown.txt` | 2026-09-16 | REAL | NLHE showdown where the button `mucked` after another player already showed and won |
| CashGame_Seats_6-Max.txt | `.../CashGame/Seats/6 Max.txt` | 2026-09-16 | REAL | 5-max table populated with only 2 seats (table capacity in the header text is independent of how many seats are actually occupied) |
| CashGame_Seats_HeadsUp.txt | `.../CashGame/Seats/HeadsUp.txt` | 2026-09-16 | REAL | True 2-max heads-up table, dealer also posts small blind (heads-up blind convention) |
| CashGame_StreetTests_Preflop.txt / Flop.txt / Turn.txt / River.txt | `.../CashGame/StreetTests/*.txt` | 2026-09-16 | REAL | Hands ending at each successive street, confirming exact street-marker text `*** PRE-FLOP ***` / `*** FLOP *** [..]` / `*** TURN *** [..] [..]` / `*** RIVER *** [..] [..] [..]` (turn/river repeat the earlier board cards before the new one) |
| CashGame_Tables_Table1.txt … Table4.txt | `.../CashGame/Tables/Table{1..4}.txt` | 2026-09-16 | REAL | Different table names/sizes (9-max "Istanbul", 5-max "Dublin"/"Vienna 36"/"San Antonio") confirming the `Table: 'Name' N-max (real money) Seat #N is the button` grammar is stable across tables |
| CashGame_GameTypeTests_NoLimitHoldem.txt | `.../CashGame/GameTypeTests/NoLimitHoldem.txt` | 2026-09-16 | REAL | `Holdem no limit` header token; **non-BOM, Windows-1252-encoded €** (byte `0x80`, renders as `�` if misread as UTF-8) |
| CashGame_GameTypeTests_PotLimitOmaha.txt | `.../CashGame/GameTypeTests/PotLimitOmaha.txt` | 2026-09-16 | REAL | `Omaha pot limit` header token; same Windows-1252 encoding as above |
| CashGame_ValidHandTests_ValidHand.txt | `.../CashGame/ValidHandTests/ValidHand.txt` | 2026-09-16 | REAL | Minimal valid hand used by the reference parser's own "is this hand well-formed" test |
| CashGame_ValidHandTests_InValidHand.txt | `.../CashGame/ValidHandTests/InValidHand.txt` | 2026-09-16 | REAL (deliberately corrupted) | **Negative fixture.** Site name is misspelled `Winaax Poker`, the euro glyph is mangled to `�`, the blinds marker is missing its slash (`*** ANTEBLINDS ***` instead of `*** ANTE/BLINDS ***`), and the summary marker is truncated to bare `***`. Used by the upstream project to test that its parser's `IsValidHand()` correctly rejects a malformed file — keep it for that purpose, do not treat its grammar as representative |

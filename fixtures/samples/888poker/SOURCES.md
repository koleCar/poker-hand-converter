# 888poker (Pacific Poker) — sample sources

All files below are byte-exact copies (`cp`, UTF-8 with BOM as checked out) from the
[HHSmithy/PokerHandHistoryParser](https://github.com/HHSmithy/PokerHandHistoryParser) unit-test corpus,
under `HandHistories.Parser.UnitTests/SampleHandHistories/Pacific/CashGame/`, retrieved 2026-09-16.
Era: ~2012–2015 (real-money cash games only; no tournament sample exists in this corpus — see
docs/research/hh-formats/888poker.md for the tournament-format gap). No file has been retyped,
reformatted, or had its bytes altered.

**Upstream corpus contamination found and excluded** (do not re-add these, and treat any future corpus
pull from this source with the same suspicion): the `Pacific/` tree contains four files that are NOT
genuine 888/Pacific hand histories:
- `GameTypeTests/PotLimitHoldem.txt` — content is a verbatim **partypoker**-format hand (banner
  `***** Hand History for Game 11614201072 *****` with no site token, `$50 USD PL Texas Hold'em`,
  `Total number of players : 2/6`, `wins $2.30 USD from the main pot...`, trailing `Game #... starts.`).
  This is also the sole source of the stray uppercase `** Dealing Flop **` / `** Dealing Turn **` /
  `** Dealing River **` markers that a naive grep across the raw upstream tree turns up — every genuine
  888/Pacific file in this corpus uses lowercase `** Dealing flop/turn/river **` consistently. Excluding
  this file removes that false signal.
- `PlayerTests/WithSittingOut.txt` — identical partypoker-format contamination (same `Game 11617233792`,
  `Table Table  202250 (No DP)` hand that also appears correctly attributed under
  `fixtures/samples/partypoker/12-no-dp-table-name-variant.txt`).
- `Seats/4 Max.txt` and `Seats/Full Ring (10 Handed).txt` — both are empty (BOM-only, zero hand content)
  placeholder files in the upstream repo.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-basic-hand-nlhe.txt | https://github.com/HHSmithy/PokerHandHistoryParser/blob/master/HandHistories.Parser.UnitTests/SampleHandHistories/Pacific/CashGame/HandActionTests/BasicHand.txt | 2026-09-16 | REAL | Baseline heads-up NLHE: `#Game No :` prefix line, `***** 888poker Hand History for Game <id> *****` banner, no-currency-code stake amounts, lowercase `** Dealing flop **`, `** Summary **` + `<name> collected [ $X ]` ending (no PokerStars/partypoker-style "wins ... from the pot" phrasing) |
| 02-allin-summary-both-shows.txt | .../Pacific/CashGame/HandActionTests/AllInHandWithShowdown.txt | 2026-09-16 | REAL | All-in river action; `** Summary **` block lists BOTH players' `shows [ ... ]` lines before the single `collected` line — no separate "doesn't show" wording |
| 03-threebet-did-not-show-hand.txt | .../Pacific/CashGame/HandActionTests/3BetHand.txt | 2026-09-16 | REAL | Preflop 3-bet/4-bet; uncalled portion never explicitly returned as a line item; winner-without-showdown phrasing is `<name> did not show his hand` (gendered pronoun, always "his" regardless of player) |
| 04-dead-blind-notation.txt | .../Pacific/CashGame/HandActionTests/PostingDead.txt | 2026-09-16 | REAL | `<name> posts dead blind [$1 + $2]` — dead blind + live blind combined in one bracket with a `+`, distinct from partypoker's `posts big blind + dead [$3]` single total |
| 05-omaha-hilo-summary-hi-lo-split.txt | .../Pacific/CashGame/HandActionTests/OmahaHiLo.txt | 2026-09-16 | REAL | `Pot Limit OmahaHL` game-type token; `** Summary **` shows explicit `(Hi: ...)` / `(Lo: ...)` best-5-card breakdown lines, `mucks [ ... ]` verb, and TWO separate `collected` lines for the same player (hi share + lo share) |
| 06-folded-preflop-no-flop-summary.txt | .../Pacific/CashGame/HandActionTests/FoldedPreflop.txt | 2026-09-16 | REAL | Hand ends preflop; `** Summary **` block still present even with zero board cards dealt |
| 07-luckyacepoker-skin-dealt-cards.txt | .../Pacific/CashGame/GeneralHands/HeroName.txt | 2026-09-16 | REAL | **Skin-branding proof**: banner reads `***** LuckyAcePoker.com Hand History for Game 5512058461 *****` — a Pacific-network skin's own domain name in place of the literal string `888poker`. Also shows `Dealt to PAC_Hero [ 3d, Jc ]` (comma-separated hole cards, unlike partypoker's `[  6s 2d 5d 3c ]` space-separated double-space format) |
| 08-cassava-skin-thousands-separator.txt | .../Pacific/CashGame/GameTypeTests/NoLimitOmaha.txt | 2026-09-16 | REAL | **Second skin-branding proof**: banner reads `***** Cassava Hand History for Game 184089742 *****` (another Pacific/888 white-label skin, unrelated string to "888poker" or "LuckyAcePoker"). Also: `$25/$50 Blinds No Limit Omaha`, thousands separator `$2,141`, and the muck phrasing variant `azartists did not show his hand` |
| 09-fix-limit-holdem.txt | .../Pacific/CashGame/GameTypeTests/FixedLimitHoldem.txt | 2026-09-16 | REAL | Game-type token is literally `Fix Limit Holdem` (not "Fixed Limit") in the stakes line |
| 10-omaha-hilo-hi-only-summary.txt | .../Pacific/CashGame/GameTypeTests/PotLimitOmahaHiLo.txt | 2026-09-16 | REAL | Omaha Hi/Lo hand where the pot does NOT split (no qualifying low) — `** Summary **` shows only a `(Hi: ...)` line for the winner and a plain `shows [ ... ]` with no Hi/Lo annotation for the loser, single `collected` line |
| 11-heads-up.txt | .../Pacific/CashGame/Seats/HeadsUp.txt | 2026-09-16 | REAL | 2-max table; `Total number of players : 2` (plain count, no "X/Y" seats-filled notation, unlike partypoker) |
| 12-six-max-thousands-separator.txt | .../Pacific/CashGame/Seats/6 Max.txt | 2026-09-16 | REAL | `$5/$10` stakes with `( $1,000 )` thousands-separated starting stacks (no currency code anywhere in the file) |
| 13-invalid-hand-truncated-flop.txt | .../Pacific/CashGame/ValidHandTests/InValidHand.txt | 2026-09-16 | REAL | Deliberately truncated mid-flop (`** Dealing flop ** [ 5c, Jc ]` — only 2 of 3 flop cards, hand cuts off with no Summary block); negative-path fixture for "did this hand actually finish" validation. Compare byte-for-byte against `ValidHandTests/ValidHand.txt` (same Game ID 539304607, same players/hand up to the point of truncation) — not copied separately since it duplicates file content already covered |
| 14-fix-limit-no-holecards-shown.txt | .../Pacific/CashGame/PlayerTests/NoHoleCards.txt | 2026-09-16 | REAL | `Fix Limit Holdem`, hand ends preflop with a `** Summary **` block and no hole cards ever shown for either player |

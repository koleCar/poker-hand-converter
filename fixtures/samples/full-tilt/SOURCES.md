# Full Tilt Poker — fixture sources

All files copied byte-for-byte (`cp`, no reformatting) from the HHSmithy
`PokerHandHistoryParser` test corpus, cloned locally to
`/tmp/hhsmithy` (`git clone --depth 1 https://github.com/HHSmithy/PokerHandHistoryParser /tmp/hhsmithy`).
Original path prefix:
`HandHistories.Parser.UnitTests/SampleHandHistories/FullTilt/CashGame/`.

Full Tilt Poker closed in 2016 (merged into PokerStars/Amaya years earlier,
final shutdown of the standalone client 2016-ish). No live site exists to
pull fresh samples from, so this pre-existing test corpus is the primary
source of real bytes. The corpus is **cash-game only** — the upstream repo
contains zero Full Tilt tournament fixtures (see doc for what this means).

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-cash-nlhe-headsup-basic.txt | github.com/HHSmithy/PokerHandHistoryParser, `.../FullTilt/CashGame/HandActionTests/BasicHand.txt` | 2026-09-16 | REAL | Minimal heads-up NLHE hand, mucked-uncontested win, UTF-8 BOM |
| 02-cash-nlhe-cap-run-it-twice.txt | `.../RunItTwiceTests/RunItTwice1.txt` | 2026-09-16 | REAL | Cap NLHE, "Players agree to Run It Twice", RIVER 1/RIVER 2, SHOW DOWN 1/2, SUMMARY 1/2, split pot across two boards |
| 03-cash-plo-hilo-showdown-hi-lo-split.txt | `.../PlayerTests/OmahaHiLoShowdown.txt` | 2026-09-16 | REAL | PL Omaha H/L, hi/lo pot split, "wins the high pot"/"wins the low pot" |
| 04-cash-nlhe-disconnect-reconnect-timeout-standup.txt | `.../PlayerTests/WithSittingOut.txt` | 2026-09-16 | REAL | "has been disconnected", "has reconnected", "stands up", "adds $x" (late reload), sitting out |
| 05-cash-nlhe-multi-hand-file.txt | `.../MultipleHandsTests/10MultipleHands.txt` | 2026-09-16 | REAL (see note) | Multi-hand file, two-blank-line hand separator, "has timed out", "is sitting out". NOTE: the upstream fixture itself contains each of 5 distinct hands duplicated back-to-back (10 hand-blocks / 5 unique hands) — this looks like an artifact of how the HHSmithy authors assembled the "10 hands in one file" test file, not a Full Tilt export quirk. Preserved verbatim; do not treat the duplication as representative of real FT export behavior. |
| 06-cash-cap-nlhe-old-header-format-2011.txt | `.../GameTypeTests/CapNoLimitHoldem.txt` | 2026-09-16 | REAL | 2011-dated hand using the **old** header word order (`Table X (seats) - $sb/$bb - Cap No Limit Hold'em - time - date`), contrast with the 2014 header order used elsewhere |
| 07-cash-flhe-fixed-limit-holdem.txt | `.../GameTypeTests/FixedLimitHoldem.txt` | 2026-09-16 | REAL | FL Hold'em, only 2 of 6 seats occupied (sparse seat numbering) |
| 08-cash-flo8-fixed-limit-omaha-hilo.txt | `.../GameTypeTests/FixedLimitOmahaHiLo.txt` | 2026-09-16 | REAL | FL Omaha H/L, mid-hand "sits down" and "adds $" (top-up) by a player who never acts, hi/lo split |
| 09-cash-fragment-ante-posting.txt | `.../BlindActionTests/Ante.txt` | 2026-09-16 | REAL FRAGMENT | Not a full hand — a 6-line unit-test snippet isolating the `<player> antes $X` line syntax and blind posting order. Kept because it is the only ante example in the corpus. |
| 10-cash-nlhe-dealt-to-hero-dual-timezone-anonymized.txt | `.../GeneralHands/HeroName.txt` | 2026-09-16 | REAL, but names anonymized | Player names replaced with `FT_Hero`/`Opponent1..5` (HHSmithy test fixture, not raw export) — kept ONLY as evidence for two structural features not seen elsewhere in the corpus: (a) `Dealt to <Hero> [Qh 5c]` hole-card line, (b) dual-timezone header suffix `12:52:55 CET - 2013/01/01 [12:52:55 ET - 2013/01/01]`. Treat the header timezone-bracket format as secondary/uncertain — no other fixture in the corpus shows it. |
| 11-cash-plo-hi-showdown.txt | `.../PlayerTests/OmahaShowdown.txt` | 2026-09-16 | REAL | PL Omaha Hi (no lo), heads-up, straight showdown |
| 12-cash-nlhe-allin-showdown.txt | `.../HandActionTests/AllInHandWithShowdown.txt` | 2026-09-16 | REAL | "calls $138, and is all in" all-in annotation, uncalled bet before showdown, full house shown |
| 13-cash-edge-case-no-actions-summary-only.txt | `.../ValidHandTests/InValidHand.txt` | 2026-09-16 | REAL | Degenerate/incomplete hand record: header + `*** SUMMARY ***` only, no `Seat N: name ($stack)` lines and no action lines at all — the upstream parser's own `IsValidHand` check exists specifically to reject this shape. Useful negative-parsing test case. |
| 14-cash-plo-hilo-chatline-uncalled-bet.txt | `.../GameTypeTests/PotLimitOmahaHiLo.txt` | 2026-09-16 | REAL | In-hand chat line `pupsaa: idi0t lucker` interleaved with actions, uncalled-bet-then-muck-then-win sequence |

No tournament sample exists anywhere in the corpus, and a targeted web/GitHub
search (see doc `docs/research/hh-formats/full-tilt.md`, section "Gotchas")
turned up no redistributable real Full Tilt tournament hand-history text
either. This is flagged as a stated gap in the doc rather than papered over
with an invented tournament grammar.

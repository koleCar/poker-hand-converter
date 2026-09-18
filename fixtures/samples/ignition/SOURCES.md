# Ignition / Bodog / Bovada fixture sources

No synthetic fixtures in this directory. Every file is REAL. This was the hardest site to find
real samples for — see the project brief's own framing — but the search succeeded: a
maintained, currently-used open-source poker tracker (fpdb-3) ships an extensive golden-snapshot
regression corpus for exactly this network, spanning 2012 through 2022, plus a second
independent open-source converter project ships four more real hands from 2017-2018. Between
the two, every major structural variant we looked for was found with real bytes: cash and
tournament, Zone Poker (fast-fold), Bodog/Bodog.eu/Bovada/Ignition brand-name eras, the
positional-pseudonym anonymization scheme itself, `[ME]` hero tagging, stud, PLO/PLO8, ante,
all-in-from-blind, disconnect/timeout, bounty/knockout, and the newest (2021+) "MVS"
table-technology header variant with a stable-looking per-seat hashed player ID.

## Corpora used

- **fpdb-3** — `github.com/jejellyroll-fr/fpdb-3`, path
  `regression-test-files/{cash,tour}/Bovada/**`. Cloned to `/tmp/fpdb-3`. This is fpdb-3's own
  **golden-snapshot regression corpus** for its Bovada converter (`fpdb_3_legacy/BovadaToFpdb.py`,
  1749 lines, and per `PARSER_SUPPORT.md` explicitly "golden-covered" — i.e. actively validated,
  not legacy/abandoned code). 52 files after processing (see "Extraction method" below), dated
  2012-04 through 2022-10 (newest: a `$150,000 Gtd` MTT dated 2022-10). Copied to
  `fpdb3-regression-corpus/`.
- **matt57225/bovada-hand-history-converter** — `github.com/matt57225/bovada-hand-history-converter`,
  path `hh/*.txt`. A small, independent open-source "Bovada → PokerStars format" converter (the
  exact kind of tool the project brief predicted would exist and ship fixtures). 4 files, real,
  dated 2017-04 through 2018-10, covering Zone Poker cash, a Bovada tournament, and five
  concatenated Bodog.eu tournament hands in one file. Copied verbatim to
  `matt57225-converter-samples/`.
- The parser source `BovadaToFpdb.py` was read in full and is the primary secondary-source
  evidence behind every regex-level claim in the doc not directly visible in a fixture (full
  header regex covering every brand name and every field combination, in one place).

## Extraction method for large fpdb-3 files (byte-fidelity note)

15 of the 52 fpdb-3 files are large (up to ~395 KB) multi-hand concatenated logs. To keep this
fixture set reviewable while still preserving real bytes exactly, any source file over 8000
bytes was **cut at a hand-boundary line** (a line matching `^(Ignition|Bovada|Bodog...) Hand
#`) — specifically, truncated to keep only its first 3 hands, using a byte-exact line-based cut
(Python `bytes.split(b'\n')` + rejoin, no re-encoding, no whitespace touched). Every file
produced this way is marked "truncated (first N hands of a longer real file)" in the table
below. The untouched bytes that remain are still a byte-for-byte copy of the original file up to
the cut point — nothing inside the kept portion was reformatted, fixed, or normalized. The full
originals remain at `/tmp/fpdb-3/regression-test-files/...` if a future agent needs more hands
from the same file.

## Fixture index — `matt57225-converter-samples/`

| file | provenance | date retrieved | status | what it demonstrates |
|---|---|---|---|---|
| 1.txt | github.com/matt57225/bovada-hand-history-converter `hh/1.txt` | 2026-09-17 | REAL | Zone Poker cash hand, 2018-04. Full positional anonymization: `UTG+1`, `UTG+2 [ME]`, `Dealer`, `Small Blind`, `Big Blind`, `UTG`. `Leave(Auto)`/`Enter(Auto)` Zone-Poker table-shuffle noise lines |
| 2.txt | same, `hh/2.txt` | 2026-09-17 | REAL | Two concatenated Zone Poker hands (2017-04) plus one Bovada **tournament** hand (2017-12, `Bovada Hand #...: HOLDEM Tournament #... TBL#1, Turbo- Level 2 (20/40)`) — the only real tournament sample in this sub-corpus |
| 3.txt | same, `hh/3.txt` | 2026-09-17 | REAL | Six concatenated **Bodog.eu** tournament hands (2017-06, brand string `Bodog.eu Hand #...`), large arbitrary tournament seat numbers (`Seat 10`, `Seat 16`, `Seat 22`), all-in with `Return uncalled portion of bet`/`Does not show`/`Hand Result` sequence, a full showdown with `Ranking`/no explicit bounty |
| 4.txt | same, `hh/4.txt` | 2026-09-17 | REAL | Ignition Zone Poker cash hand, 2018-10, multiple streets, `Return uncalled portion of bet`/`Does not show`/`Hand result` sequence. **File is truncated mid-summary in the original repo** (ends at a bare `*** SUMMARY ***` with no body) — kept as-is, this is how the file exists upstream, not a copy error on our part |

## Fixture index — `fpdb3-regression-corpus/`

| file | date (era) | status | what it demonstrates |
|---|---|---|---|
| cash__NLHE-USD - $0.25-$0.50 - 201608.Ignition.txt | 2016-08 | REAL, full | Baseline non-Zone Ignition cash hand: `Ignition Hand #... TBL#... HOLDEM No Limit`, `Dealer : Set dealer [n]`, `Small Blind`/`Big Blind [ME]` grammar, `Does not show`/`Hand result` |
| cash__NLHE-6max-USD - $0.10-$0.25 - 202104.ZonePoker.txt | 2021-04 | REAL, truncated (first 3 hands) | Zone Poker still exists with the `Bovada Hand #<id>  Zone Poker ID#<id> HOLDEMZonePoker No Limit` header as late as 2021 (double space before "Zone", confirmed real) |
| cash__NLHE-6max-USD-ZONE - $0.02-$0.05 - 201803.board.fix.txt | 2018-03 | REAL, full | A regression case specifically about a board-parsing bug fpdb-3 had to fix — useful as a hint of a real historical board-line edge case |
| cash__NLHE-USD - $0.05-$0.10 - 201308.ZonePoker.txt | 2013-08 | REAL, full | Earliest confirmed Zone Poker sample (2013), `Bovada Hand #...` brand (pre-Ignition rename) |
| cash__NLHE-USD-ZONE - $0.02-$0.05 - 201411.Allin.blind.txt | 2014-11 | REAL, full | All-in occurring at the blind-posting stage, before `*** HOLE CARDS ***` |
| cash__NLHE-6max-USD - $0.25-$0.50 - 201804.bodog.eu.txt | 2018-04 | REAL, full | `Bodog.eu Hand #...` brand string in a **cash** (not tournament) hand |
| cash__NLHE-USD-$2-$4-201209.Bodog.UK.txt | 2012-09 | REAL, full | `Bodog UK Hand #...` — a fourth confirmed real brand string (with the earlier three: Bovada, Bodog.eu, Ignition) |
| cash__NLHE-USD-0.10-0.25-201208.raise.to.format.change.txt | 2012-08 | REAL, full | A regression case fpdb-3 maintainers named specifically for a historical change in how `Raises X to Y` was rendered — evidence the raise-amount grammar itself changed mid-2012 |
| cash__NLHE-USD-0.10-0.25-201209.RING - $0.10-$0.25 - .post.both.txt | 2012-09 | REAL, truncated (first 3 hands) | `Posts dead chip` (post-both-blinds-style dead money) grammar |
| cash__NLHE-USD-5-10-201511.concatenated.partial.txt | 2015-11 | REAL, full | Named by the maintainers for a real concatenation/partial-hand edge case in the raw export |
| cash__NLHE-USD - $0.25-$0.50 - 202103.MVS.version.txt | 2021-03 | REAL, full | **Newest header format**: `Bovada Hand #... TBL#... HOLDEM No Limit [MVS] - <date> UTC` plus a `Table Info: Version: 1, Type: MVS, Stakes: ..., Table: <guid>` line and a `Player Info: Seat1: P1-<32-hex-hash>, Seat2: P2-<hash>, ...` line — a **stable-looking per-seat hashed pseudo-identity**, distinct from and in addition to the positional display name. See doc §11 — we could not confirm from available fixtures whether this hash persists across separate hands for the same real player (no multi-hand MVS sample with overlapping seats was found), so treat that specific claim as unconfirmed |
| cash__NLHE-USD - $1.00-$2.00 - 202104.Bodog.com.MVS.txt | 2021-04 | REAL, full | Same MVS-era `Table Info:`/`Player Info:` grammar under the `Bodog.com` brand string — confirms the MVS format is shared across brands, not Bovada-specific |
| cash__PLO-USD-2.00-4.00-201205.multiway.allin.txt | 2012-05 | REAL, full | Multi-way all-in in Pot-Limit Omaha (4 hole cards) |
| cash__PLO-USD-5-10-201204.new.format.txt | 2012-04 | REAL, truncated (first 3 hands) | Named for a historical "new format" transition in 2012 — evidence of an early-era grammar change |
| cash__PLO8-9max-USD-0.02-0.05-201408.corrupted.lines.txt | 2014-08 | REAL, truncated (first 3 hands) | Omaha Hi/Lo-8, named for genuinely corrupted/malformed lines present in the real historical export — a real-world noise/robustness case, not a copy defect |
| cash__7-Stud-USD-2.00-4.00-201205.txt | 2012-05 | REAL, full | 7-card stud cash, `Seat+<n>` seat-line grammar (distinct from flop-game `Seat <n>:`), `Ante chip`, `Bring_in chip` |
| cash__7-StudHL-USD-0.25-0.50-201209.txt | 2012-09 | REAL, full | 7-card stud Hi/Lo cash |
| cash__7-StudHL-USD-RING-$5-$10,$1.25Ante-201404.txt | 2014-04 | REAL, full | Stud Hi/Lo with an explicit per-hand ante amount encoded in the (fpdb-3) filename |
| cash__FLHE-6max-USD - $30-$60 - 201512.new.blinds.txt | 2015-12 | REAL, full | Fixed-limit hold'em, named for a blind-posting-grammar change |
| cash__FLHE-9max-USD - $8-$16 - 201307.all.in.blind.txt | 2013-07 | REAL, full | Fixed-limit, all-in at the blind |
| cash__LHE-2max-USD - $30-$60 - 201301.HU.all.in.big.txt | 2013-01 | REAL, full | Heads-up fixed-limit, big all-in |
| cash__LHE-9max-USD - $20-$40 - 201204.limit.blinds.txt | 2012-04 | REAL, full | Fixed-limit blind-posting baseline |
| cash__LHE-USD-2-4-201205.Bodog.txt | 2012-05 | REAL, full | Bare `Bodog Hand #...` brand string (no `.com`/`.eu`/`UK` suffix) — a fifth confirmed real brand variant |
| cash__LHE-USD-8-16-201204.old.format.txt | 2012-04 | REAL, truncated (first 3 hands) | Named "old format" by the maintainers — the earliest/most primitive confirmed grammar shape in this whole corpus |
| tour__7-Stud-USD-MTT - $10-$1 - 201206.txt | 2012-06 | REAL, truncated (first 3 hands) | 7-card stud **tournament**, `Seat+<n>: <amt> in chips` (no parens, unlike cash stud), ante-only levels (`Level 1 (0/0)`) |
| tour__NLHE-6max-USD-STT - Holdem (Double-Up Turbo) - $10-$0.50 - 201502.txt | 2015-02 | REAL, truncated (first 3 hands) | Double-Up Turbo Sit & Go tournament format |
| tour__NLHE-6max-USD-STT - Hyper Turbo (500 Chips) - $25-$1.25 - 201706.txt | 2017-06 | REAL, truncated (first 3 hands) | Hyper Turbo STT |
| tour__NLHE-9max-Freeroll-201207.disconnect.timeout.txt | 2012-07 | REAL, full | Freeroll MTT with a disconnect/timeout sequence |
| tour__NLHE-9max-USD - $10-$0.60 - 201212.all.in.blind.antes.txt | 2012-12 | REAL, full | All-in at the blind, with antes in play |
| tour__NLHE-9max-USD-10-201211.ante.all.in.txt | 2012-11 | REAL, full | Ante + all-in combination; full `Ranking`/`Prize Cash`/`Stand` bust-out sequence (see doc §8) |
| tour__NLHE-9max-USD-15-201207.allin.raise.timeout.txt | 2012-07 | REAL, full | All-in raise combined with a timeout |
| tour__NLHE-9max-USD-3-201204.missing.limit.info.txt | 2012-04 | REAL, full | A header missing its limit-type field entirely — real historical malformed/incomplete header, a genuine parser-robustness case |
| tour__NLHE-9max-USD-3-201208.raises.timout.txt | 2012-08 | REAL, full | Raise immediately followed by a timeout |
| tour__NLHE-9max-USD-MTT (Rebuy) - $3-$0.30 - 201211.txt / tour__NLHE-9max-USD-MTT - $1.000 Guaranteed (Rebuy) - $3-$0.30 - 201211.txt | 2012-11 | REAL, truncated (first 3 hands) each | Rebuy tournament format (two differently-titled copies of extremely similar real data, both kept since fpdb-3 keeps both under different regression names) |
| tour__NLHE-9max-USD-MTT - $2.000 Guaranteed (10.000 Chips) - $3-$0.30 - 201606.MTT.max.seats.txt | 2016-06 | REAL, truncated (first 3 hands) | Named for a max-seat-count edge case in a large guaranteed MTT |
| tour__NLHE-9max-USD-MTT - $25-$2.50 - 202104.Ignititon.MVS.txt | 2021-04 | REAL, full | **Newest tournament header + MVS variant**: `Ignition Hand #... : HOLDEM Tournament #M-<timestamp-id> TBL#..., Turbo- Level 7 (75/150) [MVS] - <date> UTC` plus `Table Info: ..., Buyin: $25+$2.50, TableType: MTT` (buy-in embedded directly in the Table Info line) and large arbitrary seat numbers (65, 146, 17, 66, 64, 63, 61, 51) instead of small 1-9 seat numbers. (Filename has a real typo, "Ignititon", inherited from the fpdb-3 repo — not our error.) |
| tour__NLHE-9max-USD-MTT - $9.000 Guaranteed (DS) - $20-$2 - 201408.corrupted.lines.txt | 2014-08 | REAL, truncated (first 3 hands) | Deep-stack MTT, real corrupted-line robustness case |
| tour__NLHE-9max-USD-MTT - GSPO9 High Roller Tune-Up - $50.000 Gtd - $300-$25 - 202110.txt | 2021-10 | REAL, truncated (first 3 hands) | High-roller-series MTT naming convention |
| tour__NLHE-9max-USD-MTT - Monthly Milly - $1.000.000 Guaranteed - TT$500-$35 - 202106.txt | 2021-06 | REAL, truncated (first 3 hands) | Branded/named recurring tournament ("Monthly Milly"), `TT$` ticket-currency buy-in prefix |
| tour__NLHE-9max-USD-MTT - Monthly Milly Satellite 10 Seats Gtd (Turbo) - $55-$5 - 202105.txt | 2021-05 | REAL, truncated (first 3 hands) | Satellite tournament awarding seats rather than cash |
| tour__NLHE-9max-USD-MTT - No Limit Holdem (Rebuy) - $2-$0.25 - 201301.allin.ante.txt | 2013-01 | REAL, full | Rebuy MTT, ante + all-in |
| tour__NLHE-9max-USD-MTT-201301.all.in.blind.txt | 2013-01 | REAL, full | All-in at the blind in a standard MTT |
| tour__NLHE-9max-USD-STT - $3-$0.30 - 201601.out.of.order.seats.txt | 2016-01 | REAL, full | Seat lines printed out of numeric order — real robustness case, do not assume ascending seat order |
| tour__NLHE-9max-USD-STT - $3-$0.30 - 201601.repeat.actions.ok.txt | 2016-01 | REAL, full | A regression case confirming duplicate/repeated action lines are valid and must not be de-duplicated |
| tour__NLHE-HU-USD-STT - $20-$1 - 201509.partial.hand.txt | 2015-09 | REAL, full | Heads-up STT, a genuinely partial/truncated real hand — robustness case |
| tour__NLHE-USD-1.00-STT-201208. - $1-$0.10 - .txt | 2012-08 | REAL, full | Early STT format (note the odd filename with trailing/embedded periods — a real fpdb-3 filename artifact, not ours) |
| tour__NLHE-USD-MTT - ($5 Knockout) - $10-$1 - 201512.KO.txt | 2015-12 | REAL, full | Bounty/knockout tournament: `Dealer : BOUNTY PRIZE [$5]` and summary `... BOUNTY awarded:$5` |
| tour__PLO8-9max-USD-10-MTT-201207.txt | 2012-07 | REAL, full | Omaha Hi/Lo-8 tournament |
| tour__PLO8-USD-MTT - $1-0.10 - 201409.LOW.vs.LO.txt | 2014-09 | REAL, full | Named for a Hi/Lo split-pot "LOW vs LO" text-rendering edge case |
| tour__PLO8-USD-MTT - $10-$1 - 201207.allin.call.pf.txt | 2012-07 | REAL, full | Preflop all-in call in Omaha Hi/Lo-8 |

## What we did NOT find

- No sample with a brand string other than the six confirmed here (Bovada, Bodog, Bodog.com,
  Bodog.eu, Bodog UK, Ignition) — `Bodog Canada` and `Bodog88` are both listed as alternatives
  in the parser's own regex (`re_game_info`) but neither appears in any fixture obtained.
- No confirmed sample of run-it-twice on this network.
- Nothing newer than 2022-10 — cannot confirm the format is unchanged since then.

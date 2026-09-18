# WePlay Poker — sample provenance

**Every file in this directory is a REAL, unmodified export.** There are no
synthetic or transcribed hands here.

Provenance: these are byte-identical `cp` copies of files already committed to
this repository under `weplay-hh/`, which are genuine client exports from two
WePlay accounts (`kole1992` and `h.kolaric992@gmail.com`), captured Jan–Feb 2026.
They were not downloaded from the web, so there is no external URL.

Byte integrity: verified `cmp`-identical to the `weplay-hh/` originals. UTF-8
**with BOM**, **LF** line endings, trailing whitespace preserved. Do not
normalise these files — the BOM, the trailing spaces and the duplicated
`*** HOLE CARDS ***` blocks are all part of what the parser must survive.

The full corpus (104 files, 6402 hands) remains at `weplay-hh/`. The nine files
below are the curated variant set for parser fixtures.

| file | provenance | date retrieved | status | what it demonstrates |
|---|---|---|---|---|
| `01-cash-nlhe-8max-0.25-0.50.txt` | `weplay-hh/kole1992/HH20260103 Manchester #1 (#11555801) - $0.25-$0.50 - Money 3 No Limit Hold_em.txt` | 2026-01-03 (export) | REAL | 78 hands. Baseline cash format: uncalled bet return, `has timed out`, `doesn't show hand`, rake 0 and rake > 0 |
| `02-cash-nlhe-6max-straddle-1-2.txt` | `weplay-hh/kole1992/HH20260208 Lisbon #2 (#11475800) - $1-$2 - Money 3 No Limit Hold_em.txt` | 2026-02-08 (export) | REAL | 45 hands. `posts straddle $4`, `declines straddle`, and `Elgringo: raises $14 to $18` — the raise-semantics case off a straddle |
| `03-cash-bomb-pot-ante-only.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260109 Liverpool Bomb Pot (3BB-5BB) #2 (#11421800) - $0.25-$0.50 - Money 3 No Limit Hold_em.txt` | 2026-01-09 (export) | REAL | 22 hands. Bomb pot: equal randomised ante, **no blinds posted**, no preflop betting round, `sits out `, `has timed out` |
| `04-tournament-mtt-ante-9max.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260215 T11275334 (#1) No Limit Hold_em $100 + $9.txt` | 2026-02-15 (export) | REAL | 78 hands. Tournament header, Roman-numeral level, per-player ante, no currency symbols, **stale header blinds**, en dash (U+2013) in the tournament name |
| `05-tournament-pko-9max.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260210 T11275295 (#1) No Limit Hold_em $15 + $3.txt` | 2026-02-10 (export) | REAL | 44 hands. PKO / bounty tournament — negative evidence that **no bounty award lines are emitted** |
| `06-cash-run-it-twice-6max.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260109 Belgrade #1 (#11575800) - $0.50-$1 - Money 3 No Limit Hold_em.txt` | 2026-01-09 (export) | REAL | 32 hands. `*** FIRST/SECOND FLOP/TURN/RIVER ***`, `Hand was run two times`, `FIRST Board`/`SECOND Board`, both players' seat lines marked `won` |
| `07-cash-side-pot-empty-shows-bracket.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260201 Liverpool Bomb Pot (3BB-5BB) #1 (#11403800) - $0.25-$0.50 - Money 3 No Limit Hold_em.txt` | 2026-02-01 (export) | REAL | 53 hands. Main/side pot split, `collected … from main pot` / `from side pot`, the `Total pot … Main pot ….  Side pot ….  \| Rake …` line, and `shows []` with an **empty card bracket** |
| `08-cash-duplicated-hole-cards-block.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260106 Lisbon #2 (#11475800) - $1-$2 - Money 3 No Limit Hold_em.txt` | 2026-01-06 (export) | REAL | 19 hands. Contains the duplicated `*** HOLE CARDS ***` + `Dealt to` block emitted **after** `*** SHOW DOWN ***` (affects 6.5% of all hands) |
| `09-cash-nonascii-table-name.txt` | `weplay-hh/h.kolaric992@gmail.com/HH20260210 Niš Bomb Pot (3BB-5BB) #1 (#11506800) - $0.50-$1 - Money 3 No Limit Hold_em.txt` | 2026-02-10 (export) | REAL | 34 hands. Non-ASCII table name `Niš Bomb Pot (3BB-5BB) #1` in both the header line and the filename |

## Coverage NOT in this directory

Searched for across the full 6402-hand corpus and **not found** — treat as
unknown, not as proven absent from the format:

- Omaha / any non-Hold'em game (the repo converter explicitly skips Omaha, so
  WePlay probably serves it; no sample was available)
- any currency other than `$`, and play money
- bounty / knockout award lines
- rabbit hunting, cashout, all-in insurance
- run-it-twice *offer* lines (only the resulting boards appear)
- chat lines
- tournament finish / elimination / "wins the tournament" lines
- hand-cancelled lines
- three-way-or-more side pots (`side pot-2`)

See `docs/research/hh-formats/weplay.md` §8 for the full negative list.

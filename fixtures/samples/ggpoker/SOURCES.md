# GGPoker fixture sources

**Byte-exactness note (2026-09-17):** all 34 files in this directory were checked and are plain
ASCII with LF-only line endings (verified with `file` and `grep -c $'\r'` — zero CR bytes anywhere
in this directory). None of them are CRLF or UTF-16LE, so they were never at risk from the
`core.autocrlf` normalization issue that affected other sites' CRLF/UTF-16LE fixtures elsewhere in
this repo (now fixed repo-wide via `.gitattributes` marking `fixtures/**` as `-text`). Still, do
not "clean up" or re-save any file in this directory through an editor that might normalize line
endings — these are byte-exact copies of real exports and must stay that way even though, in this
particular directory's case, that byte-exactness happens to already coincide with plain LF ASCII.

## Files 01-10: in-repo verified export (primary ground truth)

Byte-identical copies (`cp`, verified with `cmp`) of files already present in this repository at
`gg-hh/*.txt`. That directory is documented (per task scope) as read-only ground truth; nothing
here has been re-encoded, whitespace-normalized, or otherwise altered. Each file contains many
hands (69 down to ~19), not just one — they were left un-split so the file-level structure
(blank-line-separated hands, one export file per session/table) is preserved exactly as GGPoker
produced it.

| file | provenance | date retrieved | status | what it demonstrates |
|---|---|---|---|---|
| `01-repo-cash-rushcash-GG20260217-0405 - NLHPurple70 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | 69 hands, NLHPurple (Rush & Cash) $0.25/$0.5, 6-max. Contains an all-in-and-runout-uncontested hand and multiple walk/uncontested-preflop hands (`collected` vs `won` split, see ggpoker.md). |
| `02-repo-cash-rushcash-GG20260217-0406 - NLHPurple6 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Full **run-it-twice** hand where only the board diverges from the turn onward (shared flop, no second-flop marker). |
| `03-repo-cash-rushcash-GG20260217-0412 - NLHPurple73 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Run-it-twice from an all-in on the flop (shared flop only, both turn+river run twice). |
| `04-repo-cash-rushcash-GG20260217-0518 - NLHPurple11 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Full **EV Cashout / Cashout Risk** hand — GG's current all-in equity buyout feature. |
| `05-repo-cash-rushcash-GG20260217-0519 - NLHPurple13 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Plain NLH cash hands, baseline/control sample. |
| `06-repo-cash-rushcash-GG20260217-0520 - NLHPurple12 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | `posts missed blind`; a second EV Cashout hand paid across two streets in one hand. |
| `07-repo-cash-rushcash-GG20260217-0520 - NLHPurple22 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Run-it-twice from an all-in preflop (both boards fully independent); mid-street `shows [..]` with no hand-strength parenthetical (preflop reveal). |
| `08-repo-cash-rushcash-GG20260217-0520 - NLHPurple42 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Short-handed table (5 unique opponent ids); plain hands. |
| `09-repo-cash-rushcash-GG20260217-0522 - NLHPurple73 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Same table (`NLHPurple73`) as file 03, ~30 min later; two identical anonymized hex ids recur — evidence hex ids are stable for a real player at a given table across export files. |
| `10-repo-cash-rushcash-GG20260219-1353 - NLHPurple32 - 0.25 - 0.5 - 6max.txt` | in-repo verified export, GGPoker, Feb 2026 | pre-existing in repo | REAL | Smallest file (~19 hands), two days later; quick smoke tests. |

## Files 11-32: fpdb-3 regression corpus (secondary, real)

Byte-identical copies (`cp`, verified with `cmp`) of files from the `regression-test-files/` tree of
`jejellyroll-fr/fpdb-3` (AGPL-3.0, `https://github.com/jejellyroll-fr/fpdb-3.git`, cloned to
`/tmp/fpdb3` and `/tmp/ggresearch/fpdb-3`), the actively maintained continuation of the FPDB (Free
Poker DataBase) tracker project. That project's own `PARSER_SUPPORT.md` lists GGPoker as
"golden-covered" — its GGPoker converter has file-by-file semantic regression snapshots built
against these exact files, i.e. the FPDB maintainers treat them as real, trustworthy GGPoker
exports gathered from real play, not hand-authored test data. Retrieved 2026-09-16/17.

Labelled **REAL (secondary)** rather than plain REAL because this agent did not capture them from a
live GGPoker client. One open, unresolved discrepancy: none of these 2020-2021-dated files have the
trailing space on `Dealt to <name> ` that the in-repo 2026 files (01-10) have — this could be a real
format change GG made over time, or normalization somewhere in fpdb's own history. Not resolved
either way; see `ggpoker.md` §13.

| file | source path (under `regression-test-files/`) | status | what it demonstrates |
|---|---|---|---|
| `11-fpdb3-cash-nl-shortdeck-5max-usd-0-2-202103.txt` | `cash/GGPoker/Flop/NL-ShortDeck-5max-USD-0.2-202103.txt` | REAL (secondary) | `#SD` prefix; `ShortDeck No Limit ($0.02)` single-stake header; `posts button blind`; ante + straddle combined; 5-max. |
| `12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt` | `cash/GGPoker/Flop/NL-ShortDeck-5max-USD-100-202104.internal.txt` | REAL (secondary) | Higher-stakes Short Deck. |
| `13-fpdb3-cash-plo-6max-usd-0-01-0-02-202104-stp.txt` | `cash/GGPoker/Flop/PLO-6max-USD-0.01-0.02-202104.STP.txt` | REAL (secondary) | `#RC` prefix on a PLO hand (`Omaha Pot Limit`), table name `RushAndCash328990`; a `Cash Drop to Pot : total $0.2` promotional line between seats and blinds. |
| `14-fpdb3-cash-plo-6max-usd-0-5-1-00-202006.txt` | `cash/GGPoker/Flop/PLO-6max-USD-0.5-1.00-202006.txt` | REAL (secondary) | Plain PLO cash, `#OM` prefix, `Omaha Pot Limit` wording. |
| `15-fpdb3-cash-plo-6max-usd-0-50-1-00-202004.txt` | `cash/GGPoker/Flop/PLO-6max-USD-0.50-1.00-202004.txt` | REAL (secondary) | **Real All-in Insurance hand**, verified by direct inspection: `23aca38f: get an all-in insurance (premium ($0/$4/$0) for ($0/$10.8/$0) - (Mandatory/Main/Sub))` followed one street later by `23aca38f: pay premium of all-in insurance ($4)`. Also contains hands with a bare `Total pot $N` summary line and no `Rake` field at all. |
| `16-fpdb3-cash-plo-6max-usd-2-5-202101-rit.txt` | `cash/GGPoker/Flop/PLO-6max-USD-2-5-202101.RIT.txt` | REAL (secondary) | Run-it-twice on PLO. |
| `17-fpdb3-cash-plo-6max-usd-2-5-202106-run-it-thrice.txt` | `cash/GGPoker/Flop/PLO-6max-USD-2-5-202106.run.it.thrice.txt` | REAL (secondary) | Full **run-it-three-times** hand: `FIRST/SECOND/THIRD TURN/RIVER/SHOWDOWN`, `Hand was run three times`, three `Board` lines. PLO hand-description casing (`Pair of Kings and Pair of Jacks`, `King High Flush`). |
| `18-fpdb3-cash-plo-6max-usd-5-10-202101-missed.txt` | `cash/GGPoker/Flop/PLO-6max-USD-5-10-202101.missed.txt` | REAL (secondary) | Missed blind on PLO. |
| `19-fpdb3-cash-plo5-6max-usd-0-1-0-25-202104-over-straddle.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-0.1-0.25-202104.over.straddle.txt` | REAL (secondary) | `Poker Hand #OM1410171: PLO-5 ($0.1/$0.25)` header shape (no "Hold'em/Omaha No Limit"-style text at all). Straddle then **over-straddle**: `straddle $0.5` then `straddle $15.35 and is all-in` — restates cumulative total, not an increment. |
| `21-fpdb3-cash-plo5-6max-usd-2-5-202104-jackpot.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-2-5-202104.Jackpot.txt` | REAL (secondary) | **Side pot**: two different `<name> collected $X from pot` lines under one `*** FIRST SHOWDOWN ***` marker, no separate "side pot" label anywhere. Combined with run-it-twice and a `Jackpot $5` fee. |
| `22-fpdb3-cash-plo5-6max-usd-2-5-202104-missed.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-2-5-202104.missed.txt` | REAL (secondary) | `posts missed blind $2` on PLO-5 — confirms this line is shared across game types. |
| `23-fpdb3-cash-plo5-6max-usd-25-50-202104-rit.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-25-50-202104.RIT.txt` | REAL (secondary) | Run-it-twice, higher-stakes PLO-5. |
| `24-fpdb3-cash-plo5-6max-usd-25-50-202104-straddle.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-25-50-202104.straddle.txt` | REAL (secondary) | Straddle, higher-stakes PLO-5. |
| `25-fpdb3-cash-plo5-6max-usd-25-50-20210411.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-25-50-20210411.txt` | REAL (secondary) | Baseline PLO-5, no special mechanic. |
| `26-fpdb3-cash-plo5-6max-usd-5-10-202104-straddle.txt` | `cash/GGPoker/Flop/PLO5-6max-USD-5-10-202104.straddle.txt` | REAL (secondary) | Straddle, mid-stakes PLO-5. |
| `27-fpdb3-tour-nlhe-8max-mtt-usd-1050-202104-extra-space.txt` | `tour/GGPoker/Flop/NLHE-8max-MTT-USD-1050-202104.extra.space.txt` | REAL (secondary) | Confirmed real **triple-space** anomaly in a tournament header before the `- Level14(...)` clause — named by the fpdb maintainers specifically for this quirk. |
| `28-fpdb3-tour-nlhe-8max-mtt-usd-250-202006.txt` | `tour/GGPoker/Flop/NLHE-8max-MTT-USD-250-202006.txt` | REAL (secondary) | All 59 hands in this file use a **bare `Total pot N` summary line with no `Rake` field at all** — confirms the rake line can omit `Rake` entirely, not just the Jackpot/Bingo/Fortune/Tax tail. Comma-thousands chip counts. |
| `29-fpdb3-tour-nlhe-8max-mtt-usd-52-50-202104-ko.txt` | `tour/GGPoker/Flop/NLHE-8max-MTT-USD-52.50-202104.KO.txt` | REAL (secondary) | `#TM` prefix; `Tournament #<id>, <name>` grammar; ante batch; 8-max; 4-field rake line (`Rake 0 \| Jackpot 0 \| Bingo 0`). No bounty-award line despite being a "Bounty Hunters" KO tournament. |
| `30-fpdb3-tour-nlhe-8max-mtt-usd-5k-202008.txt` | `tour/GGPoker/Flop/NLHE-8max-MTT-USD-5k-202008.txt` | REAL (secondary) | WSOP-branded tournament name containing a bracketed clause and multiple `$`/`,`: `Tournament #9364957, WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10 (1,000/2,000)`. Comma-thousands blind levels. |
| `31-fpdb3-tour-plo-6max-mtt-usd-1k-202006.txt` | `tour/GGPoker/Flop/PLO-6max-MTT-USD-1k-202006.txt` | REAL (secondary) | PLO tournament; also uses the bare no-`Rake`-field summary shape in most hands. |
| `32-fpdb3-tour-plo-nlo-6max-mtt-usd-8-40-202104-ko.txt` | `tour/GGPoker/Flop/PLO-NLO-6max-MTT-USD-8.40-202104.KO.txt` | REAL (secondary) | Mixed Omaha tournament: game-type text `Omaha (NL postflop)` inside the tournament name itself, distinct from the `Omaha Pot Limit`/`PLO` wording used elsewhere; `Level18(1,250/2,500)` — comma-thousands **with no space** before the parenthesis (contrast file 27/29's spaced forms). |

### Removed: `PLO5-6max-USD-0.1-0.25-202104.straddle.walk.txt` (would have been file 20)

An earlier version of this table listed a file 20 sourced from
`cash/GGPoker/Flop/PLO5-6max-USD-0.1-0.25-202104.straddle.walk.txt`, described as a "straddle +
walk" hand. On 2026-09-17 this was found to be a **zero-byte file in this repo's copy**. Re-fetched
directly from GitHub (`curl` against the raw URL, and independently confirmed via `gh api
repos/jejellyroll-fr/fpdb-3/contents/...` which reports `"size": 0` and blob sha
`e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` — git's canonical hash for an empty blob) — **the file
is genuinely empty upstream in the fpdb-3 repository itself.** This was not a copy/clone error on
this agent's part; there was never any content to copy. The file and its row have been removed
rather than kept as a zero-byte placeholder. If a non-empty version of this file ever surfaces
(e.g. an older commit in that repo's history), it can be re-added with its own provenance note.

## Files 33-35: fpdb-3 unit-test fixtures — lower confidence, flagged

These come from `jejellyroll-fr/fpdb-3`'s `tests/fixtures/hands/ggpoker/` directory, **not** its
`regression-test-files/` tree, and show concrete internal signs of being hand-authored rather than
raw captures. They are kept (byte-identical copies, `cp`+`cmp`-verified) because they are the only
source found anywhere for a couple of claimed mechanics, but every claim sourced only from these
three files is flagged as **unverified** in `ggpoker.md` rather than asserted as fact:

- `33-fpdb3-cash-aof-omaha.txt` (`tests/fixtures/hands/ggpoker/aof_omaha.txt`): claims an `#AF`
  ("All-in or Fold Omaha") hand-id prefix and contains a `*** PREFLOP ***` street marker that
  appears **nowhere else** in any of the other 34 files in this directory, in-repo or secondary.
  Both are treated as unverified rather than confirmed real GG grammar.
- `34-fpdb3-cash-nlh-cash-6max.txt` (`tests/fixtures/hands/ggpoker/nlh_cash_6max.txt`): uses the
  hand-id prefix `#TM` on a **plain cash hand with no `Tournament #...` clause at all** —
  `Poker Hand #TM2917912634: Hold'em No Limit ($0.01/$0.02) - 2026/06/19 09:12:31` — which directly
  contradicts the otherwise-universal pattern (confirmed across every `#TM` hand in files 01-32)
  that `#TM` always accompanies a `Tournament #<id>, ` clause. It also anonymizes players with
  transparently sequential fake hex ids (`1a2b3c4d`, `2b3c4d5e`, `3c4d5e6f`, `5e6f7a8b`,
  `6f7a8b9c`) that no real anonymization scheme would produce. Treated as synthetic test data, not
  evidence of real `#TM`-on-cash usage.
- `35-fpdb3-cash-plo-cash.txt` (`tests/fixtures/hands/ggpoker/plo_cash.txt`): a plain `#OM` PLO cash
  hand with more plausible-looking ids than file 34; less obviously synthetic, but from the same
  suspect directory, so still flagged rather than trusted at face value.

**Do not use `33`/`34` as evidence for a sixth hand-id prefix or a `*** PREFLOP ***` marker without
independent confirmation from a real capture.**

## What is still NOT covered by any of these 35 files

- **Any real Natural8, BestPoker, or ClubGG hand history file.** See `ggpoker.md` §1 and §13 for:
  (a) a real ClubGG header+table-name pair recovered from a PokerTracker forum bug report (quoted,
  not a file, and diverges from mainline GG in three ways), and (b) circumstantial evidence from an
  open-source Natural8-branded converter tool (`jokerlin/gg_converter_gui`) whose entire conversion
  logic is keyed on the `Poker Hand #RC` prefix, suggestive that Natural8 emits the same `#RC`
  grammar as mainline GG Rush & Cash — but this was never confirmed against an actual Natural8
  export, so `fixtures/samples/natural8/`, `fixtures/samples/bestpoker/`, and
  `fixtures/samples/clubgg/` were deliberately left uncreated rather than populated with a guess.
- Rabbit Hunt, Flip&Go, Spin & Gold, Battle Royale: not found anywhere, real or secondary.
- A bounty/knockout **award** line: two real KO tournaments are in the corpus (files 29, 32), but no
  hand anywhere states a bounty was collected.

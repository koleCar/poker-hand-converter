# CoinPoker fixture sources

**Byte-exactness note (2026-09-17):** all 16 files here are UTF-8 (the `₮` glyph in tournament/table
names forces this) with LF-only line endings — verified with `file` and `grep -c $'\r'`, zero CR
bytes in any file. None are CRLF or UTF-16LE, so they were not the source of the
`core.autocrlf`-driven corruption found and fixed elsewhere in this repo (a `.gitattributes` rule
now marks `fixtures/**` as `-text` repo-wide as a result). That said, these are still byte-exact
excerpts of a real export and must be treated that way regardless of which specific encoding they
happen to use — do not let an editor "fix" the `₮` character or re-normalize line endings.

**All 16 files are REAL. Zero synthetic, zero transcribed.**

Every file is a byte-for-byte excerpt of a real CoinPoker client export. Nothing
was retyped, reformatted or corrected. Excerpt boundaries fall on hand
boundaries (a `CoinPoker Hand #...` line through to the blank line ending that
hand's SUMMARY), so each fixture is one or more complete, unmodified hands
lifted verbatim out of a larger log.

**Byte integrity is machine-verified.** Every file in this directory has been
confirmed to appear as an exact byte substring of its source file; the check is
reproducible with the source repo cloned to `/tmp/cphud`:

```python
core = open(fixture,'rb').read().strip(b'\n')
assert core in open(source_file,'rb').read()
```

## Source

Repository: [`nlin1027/CoinPoker-HUD-WIP`](https://github.com/nlin1027/CoinPoker-HUD-WIP)
— a work-in-progress CoinPoker HUD/stats tool. It ships raw hand-history logs
recorded by the repo owner's own client while playing:

| source file | size | encoding |
|---|---|---|
| `coinpokerhud/hands/hand1test.txt` | 168 lines | UTF-8, no BOM, LF |
| `coinpokerhud/hands/hand_log_2025-12-31_061321.txt` | 116,213 lines | UTF-8, no BOM, LF |
| `coinpokerhud/hands/hand_log_2026-01-05_023920.txt` | 302,044 lines | ASCII, no BOM, LF |
| `coinpokerhud/hands/hand_log_2026-01-05_024136.txt` | 1,834,203 lines | ASCII, no BOM, LF |
| `coinpokerhud/hands/Hand history nlin.txt` | 1,929,030 lines | ASCII, no BOM, LF |

These are raw, un-curated exports rather than hand-picked test fixtures, which
is what makes them trustworthy. Note the logs **overlap** — the same hand often
appears in more than one file, so the "found in" column below names a file the
hand was verified present in, not necessarily the only one.

Retrieved: 2026-09-17. Hands themselves date from 2024-11 to 2026-01.

## Files

| file | found verbatim in | status | what it demonstrates |
|---|---|---|---|
| `01-cash-multi-hand-baseline.txt` | `hand1test.txt` (whole file) | REAL | Baseline multi-hand cash file. Establishes the record separator (**one** blank line, unlike PokerStars/WePlay's two), the `Table 'NL ₮2 IV' 7-max` name with the Tether glyph `₮` (U+20AE), and `Board [ Jd 6c 5h 5c ]` with **padded spaces inside the brackets** where the street markers use `[Jd 6c 5h]` with none. |
| `02-cash-plain-single-hand.txt` | `hand_log_2026-01-05_023920.txt` | REAL | Minimal cash hand. Header `CoinPoker Hand #191700538: Hold'em No Limit (0.01/0.02 ) 2025/01/12 02:32:52 GMT` — note the **trailing space before the closing paren**, the **absence of ` - ` before the timestamp** (PokerStars has one), and **no currency symbol on any amount**. Summary is bare `Total pot X \| Rake Y` with no Jackpot/Bingo/Fortune/Tax fields. |
| `03-cash-showdown-shows-desc.txt` | `hand_log_2026-01-05_024136.txt` | REAL | `*** SHOW DOWN ***` spelled **with** a space (PokerStars style, not GG's `SHOWDOWN`) and `X: shows [..] (<description>)`. |
| `04-cash-straddle.txt` | `hand_log_2026-01-05_023920.txt` | REAL | `donkme123: posts straddle 0.04` plus a `(straddle)` position tag in the SUMMARY seat line. Also shows that a showdown **loser's** summary line is bare (`showed [3h Ts]` with no `and lost with …` clause) — CoinPoker states only who won. |
| `05-cash-allin-raises-no-to.txt` | `hand_log_2026-01-05_024136.txt` | REAL | **`waqqas: raises 0.46 and is all-in` — a raise with only ONE amount and no `to`**, alongside a normal `raises 0.16 to 0.18` in the same hand. A `raises (\d+) to (\d+)` regex fails on the all-in form. |
| `06-cash-timebank-disconnect.txt` | `hand_log_2026-01-05_024136.txt` | REAL | `X activated time-bank (30 seconds)`, `X is disconnected`, `X has reconnected`, `X has timed out`. |
| `07-cash-didnt-post-big-blind.txt` | `hand_log_2026-01-05_024136.txt` | REAL | `X: didn't post big blind` — a non-action line in the blind-posting region. |
| `08-cash-three-of-kind-typo.txt` | `hand_log_2026-01-05_024136.txt` | REAL | **`three of kind, Aces`** — CoinPoker's own output omits the "a". Any hand-description lookup table built from PokerStars wording (`three of a kind`) misses every one of these. |
| `09-cash-fullhouse-over-wording.txt` | `hand_log_2026-01-05_024136.txt` | REAL | **`a full house, Aces over Fours`** — "over", where PokerStars and WePlay say "Aces full of Fours". |
| `10-cash-seat-out-of-hand-sittingout.txt` | `hand_log_2026-01-05_024136.txt` | REAL | Seat-line suffixes **after** the closing paren: `(2.00 in chips) out of hand` and `(2.00 in chips) is sitting out`. A regex anchored with `in chips\)$` fails on both. |
| `11-cash-mucks-hand.txt` | `hand_log_2026-01-05_024136.txt` | REAL | `X: mucks hand` alongside `X: doesn't show hand` — both forms exist. |
| `12-tour-mtt-ante-play-chips.txt` | `hand_log_2026-01-05_023920.txt` | REAL | Tournament header grammar: `Tournament #1355052, ₮1 Mini Prime Hold'em No Limit (120/240 ante 30 play)`. Note the `ante <n>` inside the blind group and the trailing `play` token. |
| `13-tour-pko-bounty.txt` | `hand_log_2026-01-05_023920.txt` | REAL | PKO/bounty tournament: `₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD`. Tournament names contain commas, `₮`, and the literal substring `Hold'em No Limit`, which makes naive splitting on either unsafe. |
| `14-tour-satellite-seats-gtd.txt` | `hand_log_2026-01-05_023920.txt` | REAL | Satellite with a `N Seats GTD` clause in the tournament name. |
| `15-tour-hand-cancelled.txt` | `hand_log_2026-01-05_023920.txt` | REAL | **`*** HAND CANCELLED ***`** followed by `All bets returned (1310)`, an **empty board `Board [ ]`**, and every seat's stake refunded via `collected (N)` lines. 30 such hands exist in the corpus. |
| `16-tour-freeroll-timebank-disconnect.txt` | `hand_log_2026-01-05_023920.txt` | REAL | 4 consecutive freeroll tournament hands: `posts the ante N`, an all-in to showdown, and the full disconnect/time-bank vocabulary in tournament context. |

## Negative findings

Grepped across the full multi-million-line corpus, **not** spot-checked:

- **No side pots.** Zero occurrences of `side pot` or `main pot`. The split-pot
  summary grammar is therefore unknown for CoinPoker.
- **No run-it-twice.** Zero `FIRST`/`SECOND` board markers, zero
  "run two times". Either CoinPoker does not offer it or this player never used it.
- **No anonymisation.** Real usernames throughout, including the hero (`nlin`).
  There is no `Hero` literal — the hero is identifiable only via the `Dealt to`
  line, as in WePlay.
- **No Omaha or non-Hold'em.** Every hand is `Hold'em No Limit`.
- **Only two cash stake levels** observed (`0.01/0.02`, `0.02/0.05`) and one
  table size (`7-max`). Larger stakes and other table sizes are unverified.
- **No rabbit hunt, no insurance, no cashout.**

Treat all of the above as *unknown*, not as *proven absent from the format*.

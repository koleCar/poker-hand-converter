# Chico network (BetOnline / TigerGaming / Sportsbetting.ag / etc.) fixture sources

No synthetic fixtures in this directory. Every file is REAL, byte-copied (`cp`) from a real,
currently-maintained parser's regression-test corpus.

## Corpus used

- **fpdb-3** — `github.com/jejellyroll-fr/fpdb-3`, path
  `regression-test-files/{cash,tour}/BetOnline/**`. Cloned to `/tmp/fpdb-3`. BetOnline is
  fpdb-3's converter name for the whole Chico/"Cake"-adjacent skin family (see
  `fpdb_3_legacy/BetOnlineToFpdb.py`, `sitename = "BetOnline"`, `PARSER_SUPPORT.md` lists it as
  "golden-covered" — i.e. a real, currently-validated parser, not abandoned legacy code). 16
  files, dated 2011-08 through 2016-05, cash and tournament. Copied verbatim to
  `fpdb3-regression-corpus/`.

**Important caveat on player names**: fpdb-3's own regression fixtures replace most real screen
names with sequential placeholders (`Player0`, `Player1`, …) while preserving `Hero` and, in a
few older files, some original real screen names survive untouched (e.g. `totti6720`-style
names were NOT found here, but original names like none are visible; spot-checking shows this
corpus is mostly `Player0..N` + `Hero`). This is almost certainly an upstream privacy
anonymization step by the fpdb-3 maintainers when committing fixtures to a public repo, not a
site behavior — do not confuse this with Ignition's *site-level* positional-name anonymization
(a completely different mechanism, see `ignition-bodog-bovada.md`). The structural grammar
(colons, verb spellings, position tags, chat lines, join/leave events) is untouched and fully
trustworthy; only the literal usernames are not original.

## Skins confirmed directly from real fixture text (all one underlying "Chico" grammar family,
confirmed identical in `BetOnlineToFpdb.py`'s own `skins` dict and `re_game_info` alternation)

| Skin brand string (verbatim, as it appears in the header) | confirmed in a real fixture here? |
|---|---|
| `BetOnline Poker` | Yes — most files |
| `PayNoRake` | Yes — `cash__NLHE-10max-USD-0.25-0.50-201206.PayNoRake.txt` |
| `ActionPoker.com` | Yes — `cash__NLHE-10max-USD-1.00-2.00-201204.ActionPoker.txt` |
| `Gear Poker` | Yes — `cash__NLHE-10max-play-10-20-201204.GearPoker.txt` |
| `SportsBetting.ag Poker` | **No** — not present in any fixture obtained. Confirmed only as a literal alternative in the parser's own regex source (`BetOnlineToFpdb.py` line ~134, ~181). Treat the grammar as almost certainly identical to the other four skins (same regex handles all of them with one alternation) but we have **zero real bytes** bearing this exact brand string. |
| `Tiger Gaming` | **No** — same situation as SportsBetting.ag: present only in the parser's regex alternation, not in any fixture we could obtain. **This directly affects the project's explicit "TigerGaming" requirement — flagged prominently, see "What we did NOT find" below.** |

## Fixture index

| file | provenance URL | date retrieved | status | what it demonstrates |
|---|---|---|---|---|
| cash__NLHE-10max-USD-0.25-0.05-201108.txt | github.com/jejellyroll-fr/fpdb-3 `regression-test-files/cash/BetOnline/Flop/` | 2026-09-17 | REAL | Earliest cash sample (2011-08), baseline `BetOnline Poker Game #` grammar |
| cash__NLHE-10max-0.25-0.50-201203.unknown.player.wins.txt | same | 2026-09-17 | REAL | The literal sentinel name `Unknown player` acting and winning — a real edge case where the site itself couldn't attribute an action to a named seat |
| cash__NLHE-10max-0.25-0.50-201204.post.dead.txt | same | 2026-09-17 | REAL | `Player0: post dead 0.50` — dead-blind posting grammar (no "as a dead bet" qualifier, unlike WPN) |
| cash__NLHE-10max-0.25-0.50-201204.post.now.txt | same | 2026-09-17 | REAL | `post now 0.50` — a joining/returning player catching up to the current bet, distinct verb from a normal blind post |
| cash__NLHE-10max-USD-1.00-2.00-201204.ActionPoker.com.txt (`ActionPoker.txt`) | same | 2026-09-17 | REAL | **Different per-skin styling within the same network**: Title-Case, period-terminated action verbs (`Posts small blind 1.00.`, `Checks.`, `Folds.`), `Dealt To Hero` (capital T), `in Chips` (capital C), no per-seat position suffix in the seat listing (position only appears later, in the summary, as `(Small Blind)`) |
| cash__NLHE-10max-play-10-20-201204.GearPoker.txt | same | 2026-09-17 | REAL | `Gear Poker` skin, **play-money** table (`(Play Money)`), bare numeric table name with no quotes (`Table 3875596-33 (Play Money) ...`), bare `Hold'em` game token with no limit-type suffix at all |
| cash__NLHE-10max-USD-0.25-0.50-201206.PayNoRake.txt | same | 2026-09-17 | REAL | `PayNoRake` skin; header time field has **no seconds** (`08:58`, not `08:58:xx`); timezone string `GMT Standard Time` (full name, not an abbreviation) |
| cash__NLHE-10max-0.01-0.02-201604.zero.ante.txt | same | 2026-09-17 | REAL | A zero-value ante line still printed explicitly rather than omitted |
| cash__NLHE-10max-USD-0.01-0.02-201605.3.way.allin.txt | same | 2026-09-17 | REAL | 3-way all-in, ` and is all in` all-in suffix (space, not hyphen — see doc) |
| cash__NLHE-10max-USD-0.01-0.02-201605.fold.blinds.antes.txt | same | 2026-09-17 | REAL | Players folding after posting antes/blinds without acting further |
| cash__NLHE-10max-USD-0.01-0.02-201605.winner.no.show.txt | same | 2026-09-17 | REAL | Winner who does not show cards at showdown |
| cash__NLHE-10max-USD-0.25-0.05-201108.txt | same | 2026-09-17 | REAL | (duplicate-purpose entry, see above; kept for its distinct 2011 date) |
| cash__PLO-10max-USD-0.05-0.10-201209.txt | same | 2026-09-17 | REAL | Pot-Limit Omaha (4-card hands); **inline `shows` action lines have no brackets and space-separated cards** (`Player2 shows Jc Jd`) while the later **SUMMARY line for the same event does have brackets** (`showed [Jc Jd]`) — a real, easy-to-miss inconsistency within one file; also demonstrates in-hand table chat (`Player7 said "raise pot , bet and collect ...so easy"`) and mid-hand seat join/leave events (`Player10 joins the table at seat #3`, `Player4 has left the table`) interleaved directly in the action stream with no special delimiter; also demonstrates **multiple `Total pot X \| Rake Y` lines inside one `*** SUMMARY ***` block** when there are side pots (only the last one before `Board` is the hand's grand total) |
| tour__NLHE-10max-USD-MTT-2011-08.nobuyinfee.txt | same | 2026-09-17 | REAL | File begins with the literal lobby text `Tournament will start in a moment.` before the first real hand — noise a splitter must skip; earliest tournament sample (2011-08) |
| tour__NLHE-10max-USD-MTT-201210.dead.stack.txt | same | 2026-09-17 | REAL | A player with a dead (zero-action) stack still seated |
| tour__NLHE-10max-USD-MTT-201603.post.ante.txt | same | 2026-09-17 | REAL | Tournament ante grammar `<name>: ante processed <amt>` |
| tour__NLHE-10max-USD-MTT-201603.two.players.one.seat.txt | same | 2026-09-17 | REAL | Two different seat-lines both claiming seat 5 in the same hand (`Seat 5: Player4 ...` then later `Seat 5: Player9 ...`) — a genuine data-quality defect in the site's own export that a parser must tolerate rather than crash on; tournament header variant `BetOnline Poker Game #<id>: Tournament #<tourno>: Hold'em <sb>/<bb> - <date> Eastern Daylight Time` (full timezone name, note the **second colon** after `Tournament #<n>`, and blinds with no currency symbol/parens for the tournament-level display) |

## What we did NOT find

- **No real fixture bearing the literal brand string `Tiger Gaming`** (nor `SportsBetting.ag
  Poker`), despite this project's brief specifically naming TigerGaming as one of the three
  target Chico skins. The grammar for these two skins is asserted to be byte-identical to
  BetOnline/PayNoRake/ActionPoker/GearPoker **only on the authority of the parser source code**
  (`BetOnlineToFpdb.py`'s single `re_game_info`/`re_identify`/`skins` regex family explicitly
  lists all six brand strings as interchangeable alternatives at the same position in the same
  pattern) — this is strong secondary evidence, not a real sample. If a TigerGaming-branded hand
  ever surfaces, verify it against this assumption rather than trusting it blindly; the brand
  string itself is the only unverified part, not the surrounding grammar.
- No PLO8 (Omaha Hi/Lo) or Stud sample was found for this network (the parser source declares
  support for Razz/7-Card-Stud/Badugi/Draw games too, but no regression fixture for any of them
  exists in the corpus we obtained — only Hold'em and PLO).
- No sample newer than 2016-05 — we cannot confirm this grammar is still what any live Chico
  skin emits today; treat as historically accurate, currency unconfirmed.

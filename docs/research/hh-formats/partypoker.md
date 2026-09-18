# partypoker hand history format

Status: parsers for this format have already shipped and are tested against the fixtures in
`fixtures/samples/partypoker/`. This document has been rewritten to prioritize what a happy-path
implementation would get wrong — the detection signature and the gotchas — over a basic format
walkthrough. See `fixtures/samples/partypoker/SOURCES.md` for exact fixture provenance.

## 1. Overview & status

- **Confirmed from real samples** (15 fixtures, `fixtures/samples/partypoker/`, era ~2012–2015,
  sourced from the HHSmithy/PokerHandHistoryParser unit-test corpus): real-money cash-game NLHE, FLHE,
  PLO and PLO Hi/Lo hands, 2-max through 10-max, USD stakes from $0.01/$0.02 up to $30/$60, one EUR/GBP
  claim could **not** be confirmed in this corpus — every real sample is USD.
- **Inferred / secondary source only, NOT verified against a real full hand file**: tournament format,
  FastForward (partypoker's fast-fold product) format, and whether the modern (2018+, post partypoker-US
  rebrand) client still emits this exact text format. See §4 and the gotchas below for exactly what is
  and isn't backed by evidence.
- **Negative findings, stated explicitly**: the local corpus contains zero tournament hands and zero
  FastForward hands (grepped for `tourn|buy-?in|Trny` — zero hits). A web search
  (Hand2Note community forum, `forum.hand2note.com/topic/2000`) surfaced one tournament header
  *fragment*, not a full hand: `NL Texas Hold'em $6 USD Buy-in Trny:71887062 Level:8
  Blinds-Antes(600/1.200 -50)`. This is copy-pasted prose from a forum post (already whitespace-mangled
  by the forum's own rendering), not a byte-exact capture, and is **not** included as a fixture. Treat
  the exact tournament header grammar (field order, delimiters, whether antes appear per-player or as a
  single pooled figure) as unconfirmed. No FastForward sample was found at all in the time available.
- Era: every real sample here is 2012–2015. No evidence either way on whether partypoker's plain-text
  `.txt` hand history format changed after the 2019 "partypoker US Network" split or later rebrands —
  this was not confirmed and should not be assumed stable.

## 2. Detection signature

The shipped parser layer scores candidate formats 0–1 rather than using one boolean regex, so give it a
ranked signal list, not a single pattern.

**Strong, high-confidence signal:**
```
^﻿?\*\*\*\*\* Hand History for Game (\d+) \*\*\*\*\*$
```
i.e. a line that is *exactly* five asterisks, ` Hand History for Game `, a numeric game ID, five
asterisks — with **no site-name token inside the banner**. This is the single most important
discriminator against 888/Pacific, whose otherwise near-identical banner is
`***** 888poker Hand History for Game <id> *****` (literal site or skin name always present between
the asterisks and "Hand History"). partypoker's banner never carries a site token in any real sample
seen. Caution: this signal is necessary but not sufficient in isolation — see the gotcha below about a
mislabeled file in the sibling 888/Pacific corpus that has exactly this bannerless shape.

**Corroborating signals** (use to raise confidence, and to positively rule out 888/Pacific and
PokerStars):
- No `#Game No : <id>` line preceding the banner (888/Pacific always has one; partypoker never does).
- No `** Summary **` section anywhere in the hand (888/Pacific always has one before the `collected`
  line; partypoker instead ends each hand directly on a `wins $X ... from the (main|side) pot` line with
  no separate summary heading — see §9).
- Stakes/currency line on line 2 always carries an explicit currency code suffix on every single dollar
  amount in the file (`[$0.05 USD]`, `( $10.15 USD )`), whereas 888/Pacific amounts never carry a
  currency code (`[$0.05]`, `( $10.98 )`). This is a strong secondary signal but do not rely on it alone
  since some other bannerless networks in this project's corpus (Merge, MicroGaming) may share the
  "currency code on every amount" convention — check the banner first.
- Street markers `** Dealing down cards **`, `** Dealing Flop **`, `** Dealing Turn **`,
  `** Dealing River **` — always Title Case in every real partypoker sample found. (Do not use casing
  alone as a cross-site discriminator — see the 888/Pacific doc's note that a corpus-contamination file
  briefly suggested otherwise; within partypoker's own real samples the casing is consistently Title
  Case, with no lowercase variant observed.)
- Multi-hand files are separated by a `#Game No : <id>` line immediately followed by the
  `***** Hand History for Game <id> *****` banner, with the *previous* hand ending in a
  `Game #<id> starts.` trailer line + blank line. (Confusingly, `#Game No :` also appears on 888/Pacific
  files — but there it appears together with the `888poker`/skin-name banner token, so check the banner
  content, not merely the presence of a `#Game No` line.)

**What this signature could be confused with:** 888/Pacific (near-identical `Hand History for Game <id>`
skeleton — discriminate on the site token in the banner and the `** Summary **` presence), and Merge /
MicroGaming (also plain-text, dollar-amount-with-currency-code style — discriminate on the exact banner
wording, which none of those share).

## 3. Full verbatim example hands

Cash (heads-up, PLO, thousands-separated stakes) — `fixtures/samples/partypoker/10-pot-limit-omaha-thousands-separator.txt`:
```
﻿***** Hand History for Game 13551973065 *****
$1,000 USD PL Omaha - Monday, January 06, 16:33:56 EST 2014
Table Zurich (Real Money)
Seat 1 is the button
Total number of players : 2/9
Seat 3: dimatlt633 ( $2.06 USD )
Seat 1: ragga22 ( $17.60 USD )
...
```
(full file — see the fixture for the complete hand)

Tournament: **no real or byte-exact sample available.** Do not fabricate one; see §1 and the gotchas.

## 4. Header grammar

Cash header, line 2, general shape:
```
<stakes> <CUR> <LIMIT> <game> - <Weekday>, <Month> <Day>, <HH:MM:SS> <TZ> <Year>
```
- `<stakes>`: `$0.05/$0.10` (blind-pair, cash) for NL/PL games, OR a single `$100` buy-in-style figure for
  some PLO/PLO-Hi/Lo tables (`$100 USD PL Omaha Hi-Lo`) — confirmed both shapes occur for the *same*
  currency in real samples, this is not currency-dependent.
- `<CUR>`: literal `USD` in every real sample. Parser source (`PartyPokerFastParserImpl.cs` line ~318)
  switches on the first character of the stakes token for `$`→USD, `€`→EURO, `£`→GBP — so EUR/GBP
  headers are expected to exist in the wild but **no real EUR or GBP file was found** to confirm the
  exact surrounding punctuation (does the currency-code word after the symbol change to `EUR`/`GBP`, or
  does the header keep saying a fixed word? Unconfirmed).
- `<LIMIT>`: one of `NL`, `PL`, `FL` (parser source also recognizes `FixedLimitOmaha`,
  `FixedLimitOmahaHiLo`, `NoLimitOmahaHiLo` game-type strings — only `NL Texas Hold'em`, `FL Texas
  Hold'em`, `PL Omaha`, `PL Omaha Hi-Lo` are backed by a real sample here).
- Thousands separator on stakes/stacks/pots is a plain comma: `$1,000`, `$1,752`, `$5,000`.
- Tournament header: **unconfirmed shape**, only the fragment `NL Texas Hold'em $6 USD Buy-in
  Trny:71887062 Level:8 Blinds-Antes(600/1.200 -50)` is documented anywhere findable, and it is
  secondary/forum-sourced, not verified byte-for-byte.
- FastForward variant: not found anywhere; assume unknown.

## 5. Table/seat lines, button, max seats

```
Table <name> (Real Money)
Seat <n> is the button
Total number of players : <seated>/<max>
Seat <n>: <name> ( $<stack> USD )
```
- `<max>` observed values: 2, 6, 9, 10 (all real). Seat lines are **not** printed in seat-number order —
  they follow deal/internal order (see `01-basic-hand-nlhe.txt`: seats 4, 5, 3 in that order). Do not
  assume ascending seat order.
- Table name can be a place name (`Table Zurich`) or a bare numeric ID (`Table  127365` — note the
  **double space** after "Table" for numeric-only table names, confirmed in two independent real
  samples). A `(No DP)` qualifier can appear appended to the table name before the `(Real Money)` suffix:
  `Table Table  202250 (No DP) (Real Money)` (yes, the literal word "Table" can appear twice — once as
  the field label, once as part of a numeric table's own name). Meaning of "No DP" was not confirmed by
  research (plausibly "no data purse"/anti-datamining flag — unverified); treat it as an opaque optional
  token, not something to parse semantically.

## 6. Blinds, antes, straddle, dead blinds, post-to-enter

- `<name> posts small blind [$0.05 USD].` / `posts big blind [$0.10 USD].` — note the **trailing
  period** on blind-post lines specifically; ordinary action lines (`calls`, `raises`, `bets`) do **not**
  have a trailing period. This asymmetry is a real gotcha for any line-ending-based tokenizer.
- Dead blind / post-to-enter: `<name> posts big blind + dead [$3].` — a single combined bracketed total,
  not itemized as two numbers. (Contrast with 888/Pacific's `posts dead blind [$1 + $2]`, which itemizes
  with a `+` inside the brackets — do not assume the two networks share notation here.)
- No explicit ante line observed in any real sample (none of the fixtures are ante games); antes are
  covered only for iPoker/888 in their own docs.
- No straddle example found in the corpus.

## 7. Street markers

Exact strings, confirmed from real samples, always Title Case, always with the two-space-padded card
list separated by `, `:
```
** Dealing down cards **
** Dealing Flop ** [ 2s, 9d, As ]
** Dealing Turn ** [ Qc ]
** Dealing River ** [ 5c ]
```
No preflop marker text beyond `** Dealing down cards **` — there's no separate "Preflop" heading. No
`** Summary **` marker exists anywhere in this format (see §9).

## 8. Action verbs

All confirmed from real samples:
- `<name> folds` / `<name> checks` / `<name> calls [$X USD]` / `<name> bets [$X USD]` /
  `<name> raises [$X USD]` — no trailing period on any of these (contrast with blind posts, §6).
- All-in: `<name> is all-In  [$X USD]` — note **double space** after "all-In" before the bracket, and
  the unusual internal capitalization "all-In" (capital I), confirmed in two independent real samples.
- Showdown reveal: `<name> shows [ Ah, Kd ]<hand description, no space after the closing bracket>.` —
  e.g. `jott1982 shows [ 5s, Js ]a pair of Fives.` — the hand-description text is concatenated directly
  onto the closing `]` with **no space**, which will break any regex written against a single spaced-out
  example. Card separator inside brackets is `, ` (comma-space), 2 cards for Hold'em, 4 for Omaha.
- Mucking without showing: `<name> doesn't show [ 7c, 8c ]<hand description>.` (still reveals the cards
  in this text even though the player "doesn't show" them for the pot-eligibility text — this is a
  known-corpus quirk: partypoker's actual client behavior for hands you never observe live may differ;
  this exact phrasing is confirmed from the real sample text as given) and `<name> does not show cards.`
  (no cards revealed at all — different phrasing from "doesn't show [...]").
- Hi/Lo split-pot low-hand announcement: `<name> shows7,5,4,2,A  for low.` — **no space** between "shows"
  and the card-rank list, cards are bare ranks (not full card notation) comma-separated with no spaces,
  and note the **double space** before "for low." This is a genuinely unusual, easy-to-miss format.
- Winning: `<name> wins $X USD from the main pot with <description>.` / `... from the side pot 1 with
  ...` / for Hi/Lo: `<name> wins Lo ($X USD) from the main pot with <ranks>.` (parenthesized amount only
  in the Lo-win phrasing, not in the Hi-win phrasing — asymmetric).
- Hole cards (only ever shown for the hero / requested player): `Dealt to <name> [  Jc Kd ]` — note the
  **two spaces** after the opening bracket before the first card, for both 2-card and 4-card variants.
- Sitting out: `<name> is sitting out` (no trailing period). Leaving/joining: `<name> has left the
  table.` / `<name> has joined the table.` — both can occur *mid-hand*, interleaved with action lines,
  not just between hands.
- Time bank: two genuinely different real phrasings exist for what looks like the same feature —
  `<name> will be using their time bank for this hand.` (repeated once per street the player acts on)
  and `Your time bank will be activated in 6 secs. If you do not want it to be used, please act now.`
  (singular, second-person, no player name at all — this line does not start with a player name, which
  will break naive "every action line starts with `<name> `" parsing).
- Invalid/incomplete hands exist as a real corpus category: a hand can simply stop mid-action with no
  `wins` line and no shown/mucked cards at all (see fixture 15) — a parser must treat "no winner line
  found" as a legitimate, occurring-in-the-wild truncation case, not just a bug in the parser.

## 9. SUMMARY / pot / rake line layout

**There is no `SUMMARY` section in this format at all** — confirmed absent from every one of the 15 real
samples. The hand simply ends on the last `wins ...` line(s) (one per pot, for split/side pots). No rake
line is ever shown. This is one of the biggest structural differences from PokerStars-family formats and
from 888/Pacific (which does have a `** Summary **` heading) — do not assume a summary block exists.

## 10. Date/time format and timezone convention

`Monday, January 06, 05:54:36 EST 2014` — `<Weekday>, <Month> <Day (no leading zero)>, <HH:MM:SS>
<TZ abbreviation> <Year>`. Timezone abbreviations observed: `EST`, `EDT`, `CET` (all real, so the club
uses the player's/table's local abbreviation, not a single canonical timezone) — a parser must maintain
an abbreviation→UTC-offset table and must handle DST abbreviations (EST vs EDT) switching within the
same small sample set.

## 11. Anonymized-player conventions

None observed. All real sample usernames look like genuine (if redacted-by-corpus-author) player
handles; the test-suite's own synthetic files use obviously fake names (`Player1`..`Player6`) but that is
a property of the test corpus, not evidence of a partypoker anonymization convention.

## 12. File naming, export directory, hands per file, encoding

- Encoding: UTF-8 **with BOM** in every real sample (confirmed via `file`/byte inspection).
- Line endings: every file in this corpus is LF-only as checked out from git — this is very likely a
  side effect of the source repository's own git checkout normalization, **not** confirmed evidence that
  the real partypoker client itself emits LF. Treat CRLF as the more likely real-world convention for a
  Windows desktop poker client and do not assume LF is authoritative.
- Multiple hands per file: confirmed real (fixture 14, 5 hands). Separator is the `#Game No : <id>` /
  `Game #<id> starts.` pair described in §2/§5. No evidence found on a default "hands per file" cap, nor
  on the default export directory or file naming convention on disk (not documented in any source found).

## 13. Gotchas

- **No `** Summary **` block at all** — the single biggest structural surprise for anyone assuming a
  PokerStars-like layout (§9).
- **Blind-post lines end in a period; ordinary action lines don't** (§6) — an easy silent bug for anyone
  splitting on trailing punctuation.
- **`all-In` capitalization and the double space before its bracket** (§8).
- **`shows [...]<description>.` has no space before the description text**, and the Hi/Lo low-hand line
  `shows7,5,4,2,A  for low.` has no space after "shows" at all — two different "shows" formats in the
  same format family depending on hi-hand vs lo-hand context.
- **Time-bank activation-warning line has no leading player name** — breaks "every line starts with a
  name" assumptions.
- **Seat lines are not printed in ascending seat-number order.**
- **Numeric-only table names get a doubled space and can carry a `(No DP)` qualifier**, and the word
  "Table" can legitimately appear twice in one line.
- **Thousands separator is a plain comma inside currency amounts** (`$1,000`, `$5,000`) — do not assume
  amounts are always sub-1000 just because most sample stakes are tiny.
- **A hand can end truncated with no winner line at all** — treat this as a real, occurring-in-the-wild
  case (fixture 15), not solely a parser bug to guard against defensively.
- **Tournament and FastForward formats are unverified.** Any parser code claiming to support partypoker
  tournaments should be treated as unvalidated against real data until a genuine sample surfaces — this
  research could not find one, and the one header fragment available is forum-transcribed, not a byte
  capture.
- **partypoker vs 888/Pacific banners look almost identical at a glance** — always check for the site
  token inside the banner and the presence/absence of `** Summary **`, never rely on the outer
  `***** ... Hand History for Game <id> *****` shape alone (see §2's note on a real, upstream, mislabeled
  file that has partypoker's exact bannerless shape sitting inside the 888/Pacific corpus).

## 14. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-nlhe.txt | Baseline 3-handed NLHE, full streets, showdown |
| 02-allin-side-pot-showdown.txt | Two all-ins, side pot + main pot, both winner lines |
| 03-threebet-no-showdown.txt | Heads-up preflop 3-bet/4-bet, `does not show cards.` |
| 04-dead-blind-and-timebank.txt | `posts big blind + dead [$3].`, 3x time-bank-usage lines |
| 05-sitting-out-and-join-mid-hand.txt | `is sitting out`, 4-card `Dealt to`, mid-hand `has joined` |
| 06-timebank-warning.txt | Nameless time-bank activation-warning line |
| 07-player-leaves-and-joins.txt | `has left the table.` both mid-hand and post-hand |
| 08-omaha-hilo-split-pot.txt | `shows7,5,4,2,A  for low.`, `wins Lo ($X USD) from...` |
| 09-fixed-limit-holdem.txt | `FL Texas Hold'em`, 10-max table |
| 10-pot-limit-omaha-thousands-separator.txt | `$1,000 USD PL Omaha`, comma thousands separator |
| 11-heads-up.txt | 2-max table |
| 12-no-dp-table-name-variant.txt | `Table Table  202250 (No DP) (Real Money)`, $5,000 stakes, 2012-dated |
| 13-hero-name-dealt-cards.txt | `Dealt to PP_Hero [  Jc Kd ]` |
| 14-multiple-hands-concatenated.txt | 5-hand file, `#Game No :` / `Game #... starts.` separators |
| 15-invalid-hand-truncated.txt | Hand truncated mid-action, no winner line — negative-path fixture |

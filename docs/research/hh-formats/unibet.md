# Unibet Poker hand history format

Status: **no parser has shipped for this network yet, and there is no local corpus at all** — unlike
partypoker/888/iPoker, this entire document is built from secondary sources (two independent open-source
`fpdb` parser forks and their test fixtures; see `fixtures/samples/unibet/SOURCES.md`). Every claim below
is marked REAL (fixture-backed), INFERRED (parser-source-only, no full sample), or UNKNOWN. Read
`SOURCES.md` first — it also documents what was searched for and not found.

## 1. Overview & status

- Unibet Poker's client software has changed platform at least once: the current client is built on
  **Relax Gaming** (confirmed, `Unibet Community` forum thread title "PT4 on Unibet new client" plus a
  general web search hit — but the underlying forum content itself could not be fetched, HTTP 403).
  Whether there was an earlier era on the **Microgaming/MPN network** (a common assumption for
  Nordic-market skins) was **not confirmed** by this research. What *was* found is different and more
  interesting: an open-source parser project (`fpdb-3`) carries a `UnibetIPoker(iPoker)` class
  (`site_id = 87`), i.e. real evidence Unibet has run an **iPoker/Playtech** skin at some point — see the
  gotcha in §13 about why this is probably a *different concurrent product*, not a predecessor of the
  format documented here.
- **REAL, fixture-backed**: two structurally distinct real hand-history header eras/formats for Unibet's
  own plain-text (non-iPoker) export:
  - **"Legacy 2021" format**: `Game #<id>: Table <CUR><n> <LIMIT> - <SB>/<BB> - <GAME> - <time> <date>`
    (fixture 01/02, dated April 2021, Banzai/fast-fold cash game).
  - **"2026" format**: `Unibet Hand #<id> - <SB>/<BB> - <GAME> - UTC <time> <date>` with a separate,
    quoted `Table "<id>" <N>-max` line (fixtures 03–05, dated June 2026 per the sample text — i.e. the
    current client as of this research). The tournament variant of this header additionally carries
    `, Tournament #<id>, <CUR><buyin> + <CUR><fee> - ... - Total prize <CUR><prize>`.
  Both eras' hand *bodies* (seats, blinds, streets, summary) are structurally very similar — only the
  header line(s) changed — per the upstream parser author's own comment.
- **REAL, fixture-backed**: a tournament cash-out hand format, a tournament-summary file format (separate
  from the hand-history file), Banzai fast-fold branding, bounty/knockout tournament payout phrasing, and
  progressive-bounty payout phrasing (the last three via parser-source regex + comments only for the exact
  wording — see §8 for which lines have a full fixture vs. regex-only evidence).
- **INFERRED ONLY (regex/comment evidence, no full real hand fixture)**: ante posting phrasing, straddle,
  button-blind, small+big-blind-combined posting, bring-in (stud), cash-out, and the exact bounty/
  progressive-KO full-line phrasing. All of these have a *regex* in the upstream parser (meaning its
  author encountered them in real hands at some point) but this research could not obtain a full example
  hand containing any of them.
- **UNKNOWN / not found at all**: whether the current client still offers local hand-history export to
  disk at all, vs. only an in-account online history view (a real, structural possibility for a
  UK-Gambling-Commission/MGA-regulated brand — several regulated European operators removed local export
  around 2018–2020). Nothing found confirms or refutes this either way for Unibet specifically.

## 2. Detection signature

No graded-confidence infrastructure exists for this network yet (no parser has shipped). Proposed,
fixture-backed signature, covering both known real eras:
```
^Game\s#\d+:\sTable\s[€$£]\d+\s(PL|NL|FL)\s-\s[\d.]+/[\d.]+\s-\s.+\s-\s.+$
```
```
^Unibet\sHand\s#\d+(,\sTournament\s#\d+,\s[€$£][\d.]+\s\+\s[€$£][\d.]+\s-\s)?\s?-?\s?[\d.]+/[\d.]+\s-\s.+
```
(the upstream parser's actual combined `re_identify` is simpler and looser:
`Game\s\#\d+:\sTable\s(€|$|£)[0-9]+\s(PL|NL|FL)` **or**
`Unibet\sHand\s\#\d+(\s-\s|,\sTournament\s\#)` — reproduced here as-is since it is real, tested,
production regex, not a guess). Either literal substring `Game #` immediately followed later on the same
line by `Table <currency><digits> (PL|NL|FL)`, or the literal substring `Unibet Hand #`, is a safe,
unambiguous signal — no other site in this project's scope produces either string. **What this could be
confused with:** nothing identified; both header shapes are distinctive enough that false-positive risk
is low, the real risk is a **false negative** on a third, not-yet-seen header era, since this network's
header has already changed once in the sample window (2021→2026) with no announcement found.

## 3. Full verbatim example hands

Legacy (2021) cash, Banzai fast-fold — `fixtures/samples/unibet/02-cash-nlhe-banzai-2021-utf8.txt`:
```
Game #1463192545: Table €1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04
*** Seated players ***
Seat 1: Player0 (€5.15)
...
*** Preflop ***
Player2 folds
Hero raises €0.95 to €0.95, and is all-in
...
Hero wins €1.10
*** Summary ***
Total pot €1.10 Rake €0
Seat 1: Player0: bet €0.05 and won €0, net result: €-0.05
...
```

Current (2026) tournament, full hand — `fixtures/samples/unibet/04-tournament-nlhe-2026-anonymised.txt`:
```
Unibet Hand #1558006464, Tournament #85614762, €0.93 + €0.07 - 25.00/50.00 - No Limit Hold'Em - Total prize €4 - UTC 21:59:56 2026/06/05
Table "86116111" 3-max
*** Seated players ***
Seat 1: evymm (415)
Seat 3: DrikC79 (315)
Seat 5: hero[Unibet_28204e083c0fb55a] (770)
*** Blinds and button ***
DrikC79 has the button
hero[Unibet_28204e083c0fb55a] posts small blind 25
evymm posts big blind 50
*** Hole cards ***
Dealt to hero[Unibet_28204e083c0fb55a] [8c Jc]
Dealt to evymm [Qc Kh]
Dealt in DrikC79
*** Preflop ***
DrikC79 folds
hero[Unibet_28204e083c0fb55a] calls 25
evymm checks
*** Flop *** [4s Tc 8d]
hero[Unibet_28204e083c0fb55a] bets 50
evymm calls 50
...
*** Showdown ***
evymm shows [Qc Kh], High card
hero[Unibet_28204e083c0fb55a] shows [8c Jc], A Pair of Eights
hero[Unibet_28204e083c0fb55a] wins 300
*** Summary ***
Total pot 300
Seat 1: evymm: bet 150 and won 0, net result: -150
Seat 5: hero[Unibet_28204e083c0fb55a]: bet 150 and won 300, net result: 150
```

## 4. Header grammar

Two real header shapes confirmed (see §1/§3). Field notes:
- Currency symbol appears directly against the amount, no space, no ISO code letters in cash headers
  (`€1`, `$1`, `£1`) — but tournament **chip counts and blind amounts inside the hand body carry no
  currency symbol at all**, even in a tournament whose buy-in is stated in a real currency in the header
  (fixture 04: header says `€0.93 + €0.07`, but every in-hand amount is a bare integer like `25`, `50`,
  `300`). Currency support beyond EUR/USD/GBP is INFERRED ONLY from the parser's own currency-symbol
  table, which additionally lists CAD, AUD, INR, CNY, SEK, NOK, DKK, PLN, HUF, and a play-money marker —
  no fixture confirms any of these beyond EUR.
- Game-type tokens REAL: `No Limit Hold'Em Banzai` (fast-fold cash), `Pot Limit Omaha` (cash),
  `No Limit Hold'Em` (tournament). `Banzai` is Unibet's fast-fold-table brand name (their equivalent of
  Zoom/SNAP/FastForward) — confirmed real, appearing only in the cash header, never the tournament one in
  the samples obtained.
- Tournament header field order (REAL, fixture 04):
  `Unibet Hand #<id>, Tournament #<tourneyid>, <CUR><buyin> + <CUR><fee> - <sb>/<bb> - <game> - Total
  prize <CUR><prize> - UTC <HH:MM:SS> <YYYY>/<MM>/<DD>`. Buy-in and fee are always two separate figures
  joined by ` + `, never a single combined total.
- 2026-era cash header: `Unibet Hand #<id> - <sb>/<bb> - <game> - UTC <HH:MM:SS> <YYYY>/<MM>/<DD>`,
  followed on the **next line** by `Table "<numeric-or-string id>" <N>-max` — the table/max-seat
  information is a structurally separate line from the game/stakes header, unlike every other network in
  this project where they're on the same or adjacent unlabelled lines.

## 5. Table/seat lines, button, max seats

```
Table "86113818" 6-max
*** Seated players ***
Seat 1: lembourou (€0) (sitting out)
Seat 4: hero[Unibet_28204e083c0fb55a] (€3.84)
...
*** Blinds and button ***
cla17 has the button
```
- Max seats is stated explicitly and reliably (`<N>-max`) in the 2026 header — REAL, and notably more
  convenient than partypoker/888's inference-only approach.
- A player dealt in but not active can be flagged directly in the seat line: `(sitting out)` — REAL,
  confirmed in fixture 03 for a `€0` stack.
- The button is announced as its own separate line/section (`*** Blinds and button ***` /
  `<name> has the button`), not embedded in the seat listing the way partypoker does — REAL, both eras.

## 6. Blinds, antes, straddle, dead blinds, post-to-enter

REAL (both fixtures): `<name> posts small blind <amt>` / `<name> posts big blind <amt>` — no currency
symbol in tournament chips, symbol present in cash. INFERRED ONLY (regex exists, no fixture):
- Ante: parser regex literally expects the misspelling `posts the ant <amt>` (not "ante") — reproduced
  here exactly as found in source (`re_Antes`, pattern text `posts\sthe\sant\s`). This is either a real,
  confirmed site typo or an error in the upstream parser's own regex; **no real fixture confirms which**,
  flag this specifically before relying on it.
- Straddle: `posts straddle <amt>`.
- Button blind (a dead-button-adjacent post): `posts button blind <amt>`.
- Combined small+big blind (returning from sit-out, entering mid-level): `posts small & big blinds <amt>`.
- Bring-in (stud-family games, if Unibet ever spreads them): `brings in [low ]fo/<amt>` (sic — literal
  `fo/` token in the regex, likely a truncated/garbled "for" in the original site text; not independently
  confirmed).

## 7. Street markers

REAL, confirmed in both eras' fixtures:
```
*** Seated players ***
*** Blinds and button ***
*** Hole cards ***
*** Preflop ***
*** Flop *** [2h 3s 6s]
*** Turn *** [2h 3s 6s] [Qs]
*** River *** [2h 3s 6s] [Qs] [4d]
*** Showdown ***
*** Summary ***
```
Note the **cumulative board notation**: Turn repeats the flop's 3 cards before its own new card in a
second bracket, and River repeats flop+turn before its own new card in a third bracket — i.e. each street
header shows the *entire* board-so-far as a sequence of separate bracketed groups, not just that street's
new card(s) alone. This is a real, confirmed, and easy-to-miss format if you assume "one bracket = that
street's cards" the way most other networks in this project work. `*** Showdown ***` is its own heading,
present only when at least one player's cards are shown (absent entirely in a fold-preflop hand — see
fixture 03's second hand, which has no Showdown section).

## 8. Action verbs

REAL, confirmed in fixtures:
- `<name> folds` / `<name> checks` / `<name> calls <amt>` / `<name> bets <amt>` /
  `<name> raises <amt> to <amt>` (both the raise-by amount and the resulting total are given, separated
  by ` to `) — no currency symbol on tournament chip amounts, symbol present on cash amounts.
- All-in: `, and is all-in` appended directly onto the action line, e.g.
  `Hero raises €0.95 to €0.95, and is all-in` — not a separate line or separate verb.
- Dealt-in-but-unseen: `Dealt in <name>` (no cards shown) vs. `Dealt to <name> [<cards>]` (cards known —
  either because it's the hero, or because of a showdown reveal captured retroactively into the same
  `Dealt to` line shape). REAL, both eras.
- Showdown reveal: `<name> shows [<cards>], <hand description>` — comma before the hand description
  (contrast with partypoker/888, which use no separating punctuation or a different one). REAL.
- Win: `<name> wins <amt>` with **no** "from the (main/side) pot" suffix on a single-winner pot, but
  `<name> wins <amt> from main pot` / `<name> wins side pot #1, <amt>` when the pot actually splits —
  REAL, confirmed via both a fixture and the parser's own regression-test comments, which explicitly
  document all three shapes and warn that the plain `wins <amt>` lines (not the Summary's `net result`
  figures) are what sums to the actual pot.
- Uncalled bet: `Uncalled bet returned to <name>: <amt>` — REAL. Note this is structurally different
  from PokerStars' `Uncalled bet (<amt>) returned to <name>` shape; a parser written against the
  PokerStars phrasing will not match Unibet's at all (confirmed via an upstream regression test that
  exists specifically to assert the PokerStars shape does *not* match).
- Timed-out / disconnected actions carry a parenthesized suffix directly on the action line: INFERRED
  from parser source + its own regression tests (no full hand fixture obtained), but the exact spacing is
  asserted precisely enough to trust: `<name> folds  (timed out)` (**two spaces** before the parenthesis)
  vs. `<name> folds (disconnect)` (one space) — confirmed via the upstream test suite's own literal
  strings, reproduced here verbatim.
- Cash-out (INFERRED, regex only, no fixture): `<name> cashed out the hand for <amt>`, with an optional
  separate `Cash Out Fee <amt>`.
- Bounty/knockout (INFERRED, regex + comment only): `<name> wins the <amt> bounty for eliminating
  <name>`, `<name>, <name> split the <amt> bounty for eliminating <name>`, progressive-KO phrasing
  `<name> wins <amt> for eliminating <name> and their own bounty increases by <amt> to <amt>`.
- Tournament elimination/finish (INFERRED, regex only): `<name> wins the tournament and receives <amt> -
  congratulations!`, `<name> finished the tournament in <N><ordinal> place and received <amt>.`.
- Hero name carries a persistent, literal `[Unibet_<hexsessiontoken>]` suffix on **every** occurrence of
  the hero's name in the 2026-era format (REAL, confirmed) — a downstream parser must strip this token to
  get a stable hero identity across hands/sessions; it is not present in the 2021-era format's `Hero`
  placeholder name.

## 9. SUMMARY / pot / rake line layout

REAL, both eras:
```
*** Summary ***
Total pot <amt>[ Rake <amt>]
Seat <n>: <name>: bet <amt> and won <amt>, net result: <amt>
```
Confirmed important trap (documented explicitly, with worked numbers, in the upstream parser's own
comments): the per-seat `bet X and won Y, net result: Z` figures are **not** the pot distribution — `Y`
("won") adds the player's own uncalled bet back into their own total, so summing every seat's `won` figure
can *exceed* the stated Total pot. The authoritative pot-share figures are the separate `<name> wins
<amt>` action lines (§8), not anything inside `*** Summary ***`. Tournament hands may omit the `Rake`
token entirely when the format doesn't apply one (fixture 04's summary reads `Total pot 300` with no rake
figure at all).

## 10. Date/time format and timezone convention

- Legacy (2021): `13:22:50 2021/04/04` — `HH:MM:SS YYYY/MM/DD`, no timezone token.
- Current (2026): `UTC 21:59:56 2026/06/05` — same `HH:MM:SS YYYY/MM/DD` shape, but now with an explicit
  literal `UTC` token immediately before the time. REAL, confirmed difference between the two eras: the
  earlier format's timestamps have no stated timezone at all (parser source comments note a "revised"
  regex with a generic timezone-abbreviation capture group exists but is "not currently used" — i.e. even
  the parser's own author wasn't fully sure what timezone the 2021-era timestamps were in).

## 11. Anonymized-player conventions

No general anonymization was found; usernames are ordinary handles in every real fixture. The only
identity-related quirk is the hero-specific session-token suffix described in §8, which is a real,
recurring per-hand token, not a display-anonymization feature. Tournament summary files (fixture 05) do,
however, show a bare `Unibet_<hexid>` token *without* a preceding username as the placeholder for the
account's own name in some contexts (the upstream parser maps this back to the configured hero screen
name) — worth flagging since it means the account owner isn't always trivially textually present in a
tournament summary file the way they are in a hand-history file.

## 12. File naming, export directory, hands per file, encoding

- Encoding: **confirmed real ambiguity** — the same underlying hand (fixture 01/02, identical game ID)
  was found published in two different byte encodings by two independent projects: one single-byte
  (Windows-1252/ISO-8859-1-family, € as raw byte `0x80`) and one UTF-8. The parser that ships with both
  projects explicitly declares it must try `("utf8", "cp1252", "ISO-8859-1")` in that order — real,
  confirmed evidence that Unibet's own real-world exports are not reliably one single encoding, and any
  converter for this network must sniff/fall back across encodings rather than assuming UTF-8.
- Multi-hand files: REAL, confirmed — the 2026-era sample file used for regression testing contains two
  hands back-to-back under one `=== HAND HISTORIES ===` banner line, separated by a blank-line gap before
  the next hand's `Unibet Hand #...` line. Whether this banner line is present in real on-disk exports or
  is an artifact the test-fixture author added is **not fully certain** (INFERRED that it's real, since
  the same banner also appears verbatim at the top of the separate tournament-summary sample under a
  different literal, `=== TOURNAMENT SUMMARIES ===`, which is at least internally consistent).
- No default export directory or file-naming convention was confirmed from any source for a real
  installed client (see the caveat in `SOURCES.md` about the regression-test file's own name not being
  evidence of a real client-side convention).
- Whether local hand-history export exists at all in the *current* client is genuinely unconfirmed — see
  §1's UNKNOWN item. The fixtures obtained prove the *format* exists and is actively being parsed as
  recently as this research's cutoff, but not the export mechanism (automatic client-side .txt file vs. a
  manual "export last N hands" action vs. some other route).

## 13. Gotchas

- **The header format changed at least once (2021 → 2026) with no deprecation announcement found** — any
  detector must handle both shapes (§2), and should be written expecting a third, not-yet-seen shape to
  appear, since nothing suggests this was the network's only format change.
- **Encoding is not reliably UTF-8** — confirmed real single-byte (cp1252/ISO-8859-1) exports exist
  alongside UTF-8 ones for what appears to be the same underlying hand data; sniff/fall back, don't
  hardcode UTF-8.
- **`UnibetIPoker(iPoker)` exists in a real parser project (`site_id = 87`) — do not assume this means the
  plain-text format documented here is "really" iPoker XML in disguise, or that Unibet's iPoker skin
  shares any format details with the `Game #.../Unibet Hand #...` text format.** These read as two
  separate products (most plausibly: an iPoker-network-hosted Unibet room for certain markets/eras,
  running alongside or before the in-house/Relax-Gaming-client room that produces the plain-text hands
  documented here) — this project could not determine the exact relationship, and no iPoker-XML-shaped
  Unibet sample was found to check against `docs/research/hh-formats/ipoker.md`. If a hand history
  purporting to be "Unibet" ever arrives as XML rather than the plain text documented here, treat it as
  the iPoker doc's format, not this one.
- **Board notation on Turn/River repeats all prior streets' cards in separate brackets** — `*** River ***
  [2h 3s 6s] [Qs] [4d]` is flop+turn+river each in their own bracket, not just the river's one new card.
- **Tournament chip amounts never carry a currency symbol, even when the header states a real-money
  buy-in** — a parser must not assume "no currency symbol present" means "this is a cash game."
- **The Summary block's per-seat `won`/`net result` figures double-count uncalled bets and do not sum to
  the pot** — use the separate `<name> wins <amt>` action line(s) instead, exactly as the upstream
  parser's own regression-test comments warn (§9).
- **The hero's name is not stable across hands as printed** — it carries a `[Unibet_<sessiontoken>]`
  suffix in the 2026-era format that must be stripped to get a consistent hero identity.
- **`Uncalled bet returned to <name>: <amt>` is NOT the PokerStars shape** (`Uncalled bet (<amt>) returned
  to <name>`) — a converter reusing a PokerStars-family regex here will silently fail to match at all,
  not partially match.
- **A significant fraction of this document (antes, straddle, button blind, combined-blind post, bring-in,
  cash-out, bounty/progressive-KO exact phrasing) is INFERRED from parser regex + comments only, with no
  full real hand fixture behind it** — treat these specifically as unvalidated until a real sample
  surfaces, even though the surrounding, fixture-backed parts of this document are solid.
- **No sample was obtainable directly from Unibet or a forum in this research pass** — everything here
  traces back to two third-party open-source projects. If higher-confidence, first-party evidence is
  ever needed, the next step is a real Unibet account's own hand-history export, not further web search
  (multiple forum sources that plausibly had real examples returned HTTP 403 to automated fetching).

## 14. Sample index

| file | demonstrates |
|---|---|
| 01-cash-nlhe-banzai-2021-cp1252.txt | Legacy 2021 header, Banzai fast-fold, raw single-byte-encoded € (`0x80`) |
| 02-cash-nlhe-banzai-2021-utf8.txt | Identical hand to file 01, UTF-8 encoded — proves the encoding ambiguity is real, not corruption |
| 03-cash-plo-2026-two-hands-anonymised.txt | Current-era header, quoted `Table "<id>" N-max` line, PLO, sitting-out seat, hero session-token suffix, Showdown section, 2-hand file |
| 04-tournament-nlhe-2026-anonymised.txt | Tournament header (buy-in+fee+prize), chip counts with no currency symbol, single-winner `wins <amt>` with no pot-type suffix |
| 05-tournament-summary-2026-anonymised.txt | Separate tournament-summary file format, distinct banner/fields from the hand-history file |

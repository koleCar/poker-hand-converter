# 888poker (Pacific Poker / 888 network) hand history format

Status: parsers for this format have already shipped and are tested against the fixtures in
`fixtures/samples/888poker/`. This document has been rewritten to prioritize what a happy-path
implementation would get wrong — the detection signature and the gotchas — over a basic format
walkthrough. See `fixtures/samples/888poker/SOURCES.md` for exact fixture provenance, including an
important corpus-contamination finding.

## 1. Overview & status

- **Confirmed from real samples** (14 fixtures, `fixtures/samples/888poker/`, era ~2012–2015): real-money
  cash-game No-Limit Hold'em, Fix(ed) Limit Hold'em, Pot-Limit Omaha and Pot-Limit Omaha Hi/Lo, 2-max
  through at least 9-max, unbadged-currency stakes from $0.05/$0.10 to $5/$10, plus two different
  **skin-branded** samples (see §2) proving this network is white-labeled.
- **Inferred / secondary source only, not verified against a real full hand file**: tournament format,
  SNAP (888's fast-fold product) format, and any post-~2015 header/layout changes. A web search for
  "888poker hand history format 2019 2020" returned no usable specifics — this is a **confirmed gap**,
  not an oversight; no modern sample was found anywhere in the time available.
- **Negative findings, stated explicitly**: zero tournament markers in the local corpus (grepped, zero
  hits). No SNAP/fast-fold sample found on the web either. Treat both as fully unconfirmed; do not invent
  a plausible-looking tournament or SNAP header for this network.
- Era: every real sample is 2012–2015 (mostly Jan 2014, a few 2012 and one Apr 2015). No evidence on
  whether the modern 888poker client still emits this exact `.txt` layout.

## 2. Detection signature

The shipped parser layer scores candidate formats 0–1, so give it a ranked signal list, not a single
regex.

**Strong, high-confidence signal:**
```
^#Game No : (\d+) ?\r?\n\*\*\*\*\* (.+) Hand History for Game \1 \*\*\*\*\*$
```
i.e. a `#Game No : <id>` line immediately followed by a `***** <SITE-OR-SKIN-NAME> Hand History for Game
<id> *****` banner with the **same numeric ID repeated in both lines**. `<SITE-OR-SKIN-NAME>` is usually
the literal string `888poker`, but two real samples in this corpus prove it can instead be a skin's own
brand name — `LuckyAcePoker.com` and `Cassava` were both observed. **Do not hardcode a match on the
literal string "888poker"** — match on the *shape* (`#Game No` line + banner with the same ID, any
site-token) instead, exactly as this project's own iPoker doc has to do for Playtech skins.

**Corroborating signals:**
- A `** Summary **` heading appears in every real sample immediately before the final result line(s),
  which read `<name> collected [ $X ]` (not "wins ... from the pot", which is partypoker's phrasing) —
  confirmed present even on hands that end preflop with no board cards at all.
- Currency amounts never carry a currency code suffix anywhere in the file — `[$0.05]`, `( $10.98 )`,
  `collected [ $0.19 ]` — contrast with partypoker, where every amount is suffixed `USD`/etc.
- `Total number of players : <n>` is a **bare count**, not partypoker's `<seated>/<max>` fraction.
- Game-type tokens seen in the stakes line are `No Limit Holdem`, `Fix Limit Holdem` (not "Fixed"),
  `Pot Limit Omaha`, `Pot Limit OmahaHL` — all lack the apostrophe partypoker uses in `Texas Hold'em`.

**Important correction to an earlier, wrong internal claim about street-marker casing:** street markers
in every *genuine* 888/Pacific sample in this corpus are consistently **lowercase**:
`** Dealing flop **`, `** Dealing turn **`, `** Dealing river **`. A raw grep across the *unfiltered*
upstream corpus directory also turns up one Title-Case instance
(`** Dealing Flop **`/`Turn`/`River`) — but that hit comes entirely from a single contaminated file,
`GameTypeTests/PotLimitHoldem.txt`, whose actual content is a byte-for-byte **partypoker**-format hand
(mislabeled in the upstream `Pacific/` directory; see `SOURCES.md`, excluded from this project's
fixtures). Once that contaminated file is excluded, casing is 100% consistent lowercase across every
genuine sample here. Still, do not rely on casing as a primary discriminator against partypoker in case
a currently-unseen 888 build title-cases it — treat casing as weak/unverified beyond "this corpus is
consistently lowercase," and lead with the `#Game No` + banner-ID-match + `** Summary **` signals instead.

**What this signature could be confused with:** partypoker (near-identical `Hand History for Game <id>`
skeleton — discriminate on the `#Game No` prefix line and `** Summary **` presence, both of which
partypoker never has). A second, real, upstream mislabeling
(`PlayerTests/WithSittingOut.txt` in the Pacific corpus, also excluded) is itself a verbatim partypoker
hand — so this confusion is not hypothetical, it already happened once in a widely-used open-source test
corpus.

## 3. Full verbatim example hands

Cash, skin-branded (`LuckyAcePoker.com`, proving white-labeling) —
`fixtures/samples/888poker/07-luckyacepoker-skin-dealt-cards.txt`:
```
﻿#Game No : 5512058461
***** LuckyAcePoker.com Hand History for Game 5512058461 *****
$2/$4 Blinds No Limit Holdem - *** 13 08 2013 17:22:18
Table Gent 6 Max (Real Money)
Seat 7 is the button
Total number of players : 5
Seat 1: Player1 ( $400 )
Seat 2: Player2 ( $412 )
Seat 4: Player3 ( $400 )
Seat 7: Player4 ( $400 )
Seat 9: PAC_Hero ( $400 )
PAC_Hero posts small blind [$2]
Player1 posts big blind [$4]
** Dealing down cards **
Dealt to PAC_Hero [ 3d, Jc ]
Player2 folds
Player3 folds
Player4 raises [$14]
PAC_Hero folds
Player1 folds
** Summary **
Player4 collected [ $10 ]
```

Tournament: **no real or byte-exact sample available.** Do not fabricate one; see §1.

## 4. Header grammar

```
<stakes> Blinds <GameType> - *** <DD> <MM> <YYYY> <HH:MM:SS>
```
- Note the header does **not** use a slash between date components and does **not** include a timezone
  abbreviation at all (contrast with partypoker's `EST 2014`/`CET 2013` suffix) — see §10.
- `<stakes>`: `$0.05/$0.10`, `$1/$2`, `$25/$50` — no currency code, ever, in any real sample.
- `<GameType>` tokens confirmed real: `No Limit Holdem`, `Fix Limit Holdem`, `Pot Limit Omaha`,
  `Pot Limit OmahaHL` (the "HL" suffix, not "Hi-Lo" or "Hi/Lo" — a distinct token from partypoker's own
  `Omaha Hi-Lo` wording).
- Thousands separator on stacks/stakes is a plain comma: `( $1,000 )`, `$2,141`.
- Tournament header: **unconfirmed**, no fragment even was found (worse than partypoker's situation,
  where at least a header fragment exists from a forum post).

## 5. Table/seat lines, button, max seats

```
Table <name> <N> Max (Real Money)
Seat <n> is the button
Total number of players : <n>
Seat <n>: <name> ( $<stack> )
```
- Table name always carries its own max-seat annotation baked in (`Table Abbotsford 6 Max`,
  `Table Fortaleza 9 Max`) — this is a real, confirmed convention, unlike partypoker where seat max is
  only inferable from the `<seated>/<max>` player-count fraction.
- `Total number of players` is a **bare integer**, the number of dealt-in players for this hand, not a
  "seats filled / table max" fraction. Get max-seat count from the table-name annotation instead.
- Seat lines, like partypoker, are **not** printed in ascending seat-number order.

## 6. Blinds, antes, straddle, dead blinds, post-to-enter

- `<name> posts small blind [$0.50]` / `posts big blind [$1]` — **no trailing period**, unlike
  partypoker's period-terminated blind-post lines. This is a real, confirmed difference between the two
  otherwise-similar networks.
- Dead blind: `<name> posts dead blind [$1 + $2]` — the live-blind and dead-blind portions are itemized
  together inside one bracket joined by ` + `. This is a different notation from partypoker's single
  combined total (`posts big blind + dead [$3]`) — do not assume the two share dead-blind grammar.
- No ante example found in the real corpus for this network. No straddle example found either.

## 7. Street markers

Exact strings from every real, uncontaminated sample:
```
** Dealing down cards **
** Dealing flop ** [ 4h, Kc, 3s ]
** Dealing turn ** [ Kh ]
** Dealing river ** [ 6c ]
```
Always lowercase (see the casing correction in §2). No separate "preflop" heading beyond "down cards".

## 8. Action verbs

- `<name> folds` / `<name> checks` / `<name> calls [$X]` / `<name> bets [$X]` / `<name> raises [$X]` —
  no currency code, no trailing period.
- No `all-In`-style explicit all-in annotation line was found in this corpus at all (contrast with
  partypoker's explicit `is all-In [$X USD]`) — 888/Pacific appears to just let the bet/call amount speak
  for itself even when it puts a player all-in; do not assume an explicit all-in marker exists for this
  network.
- Showdown reveal (inside `** Summary **`, not inline on the street where it happens):
  `<name> shows [ Ad, 4c ]` — comma-space card separator, **no hand-description text appended** (a real,
  confirmed difference from partypoker, whose `shows [...]` lines always append a hand description).
- Hi/Lo showdown detail, confirmed real and distinctly formatted:
  ```
  hank1967 shows [ 5c, 8h, 2h, Kd ]
  (Hi: 5c, 5d, Th, Kd, As)
  (Lo: 2h, 5d, 6d, 8h, As)
  ```
  the `(Hi: ...)`/`(Lo: ...)` lines are separate lines directly below the `shows` line, each listing the
  full best-5-card hand actually made — not just the annotation of which two/four hole cards counted.
  When there's no qualifying low, only a `(Hi: ...)` line appears with no `(Lo: ...)` counterpart at all
  (confirmed, `10-omaha-hilo-hi-only-summary.txt`).
- Winner without showdown: `<name> did not show his hand` — note the **fixed masculine pronoun "his"
  regardless of the actual player**, a genuinely odd, confirmed-real, and easy-to-mis-template phrasing.
  This is different from both partypoker's `does not show cards.` and its `doesn't show [...]`.
- Mucking with cards shown: `<name> mucks [ Kc, Qh, Js, 2d ]` — a distinct verb from "shows", used when a
  player's cards are revealed but they didn't win that share of the pot (confirmed in the Hi/Lo sample).
- Result: `<name> collected [ $X ]` — always inside/after `** Summary **`, never a "wins ... from the
  pot" sentence. A single hand can have **multiple** `collected` lines for the same player (once per side
  of a Hi/Lo split), confirmed real.
- Hole cards for the observed player: `Dealt to <name> [ 3d, Jc ]` — comma-space separated, **single**
  space after the opening bracket (contrast with partypoker's double space `[  Jc Kd ]` with no commas).

## 9. SUMMARY / pot / rake line layout

Every real sample has a `** Summary **` heading, confirmed present even on hands that end preflop with
zero board cards dealt. Below it: zero or more `shows`/`mucks` lines, then one or more `collected [ $X ]`
lines (§8). No rake figure is ever shown in any real sample.

## 10. Date/time format and timezone convention

`*** 06 01 2014 22:40:28` — `*** <DD> <MM> <YYYY> <HH:MM:SS>`, **no timezone abbreviation anywhere**,
day/month both always 2 digits. This is a materially different, and easy-to-parse-wrong-if-you-copy-the-
partypoker-regex, date shape: no weekday name, no month name (numeric only), no explicit locale marker at
all. Since there's no timezone token, a downstream converter must assume/configure the timezone rather
than reading it off the hand.

## 11. Anonymized-player conventions

None observed real; only the test-suite's own synthetic `Player1..Player6` names appear where the corpus
author redacted real handles, which is a property of the corpus, not the site.

## 12. File naming, export directory, hands per file, encoding

- Encoding: UTF-8 with BOM in every real sample checked.
- Line endings: LF-only as checked out in this corpus — as with partypoker, likely a git-checkout
  normalization artifact, not confirmed evidence about the real client's own export.
- No multi-hand-per-file sample exists in the kept fixture set for this network (unlike partypoker, whose
  corpus did include one) — not confirmed either way whether 888/Pacific concatenates multiple hands into
  one file, and if so what the separator looks like. Treat as unknown.
- No default export directory or file-naming convention was found in any source.

## 13. Gotchas

- **The banner's site token is not a fixed literal** — `888poker`, `LuckyAcePoker.com`, and `Cassava`
  were all observed in this corpus alone. Any parser hardcoding `888poker` in the banner regex will
  silently fail to recognize genuine skins of the same network. Match on structural shape
  (`#Game No` + ID-matching banner) instead.
- **The upstream open-source test corpus itself contains two mislabeled, purely-partypoker-format files**
  inside the `Pacific/` (888) directory tree (`GameTypeTests/PotLimitHoldem.txt`,
  `PlayerTests/WithSittingOut.txt`) — both excluded from this project's fixtures, but if anyone re-pulls
  from HHSmithy's repo directly for more samples, re-check for this same contamination pattern; it also
  produced a spurious "888 sometimes uses Title-Case street markers" signal that does not actually hold
  once the contamination is removed (see §2).
- **`<name> did not show his hand`** always uses "his", never "her"/"their" — a literal-template quirk,
  confirmed real, not a corpus artifact (it appears with clearly female-sounding usernames too).
- **No explicit all-in marker line exists** for this network in any real sample — do not require one when
  validating a parsed hand.
- **A single player can have two separate `collected [ $X ]` lines in one hand** (Hi/Lo split) — do not
  assume at most one result line per player.
- **No timezone in the timestamp at all** — don't try to extract one; it isn't there.
- **`Total number of players` is a bare count, not an `X/Y` fraction** — max-seat info must instead be
  read from the table-name annotation (`6 Max`, `9 Max`).
- **Tournament and SNAP formats are entirely unconfirmed** — no fragment, no forum post, nothing found.
  Flag any parser code claiming to support either as unvalidated against real data.

## 14. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-nlhe.txt | Baseline heads-up NLHE, `#Game No`/banner/Summary/collected shape |
| 02-allin-summary-both-shows.txt | All-in river, both players' `shows [...]` in Summary |
| 03-threebet-did-not-show-hand.txt | Preflop 3-bet/4-bet, `did not show his hand` |
| 04-dead-blind-notation.txt | `posts dead blind [$1 + $2]` |
| 05-omaha-hilo-summary-hi-lo-split.txt | `(Hi: ...)`/`(Lo: ...)`, `mucks`, two `collected` lines |
| 06-folded-preflop-no-flop-summary.txt | `** Summary **` present even with zero board cards |
| 07-luckyacepoker-skin-dealt-cards.txt | Skin-branding proof #1 (`LuckyAcePoker.com`) |
| 08-cassava-skin-thousands-separator.txt | Skin-branding proof #2 (`Cassava`), thousands separator |
| 09-fix-limit-holdem.txt | `Fix Limit Holdem` game-type token |
| 10-omaha-hilo-hi-only-summary.txt | Hi/Lo hand with no qualifying low, single `(Hi:)` line |
| 11-heads-up.txt | 2-max, bare player-count (no X/Y fraction) |
| 12-six-max-thousands-separator.txt | `( $1,000 )` thousands separator, no currency code anywhere |
| 13-invalid-hand-truncated-flop.txt | Truncated mid-flop, negative-path fixture |
| 14-fix-limit-no-holecards-shown.txt | Preflop-only hand, no hole cards ever shown |

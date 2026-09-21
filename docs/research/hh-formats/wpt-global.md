# WPT Global — hand history format

## 1. Overview & status

**Status: NO REAL SAMPLES. Nothing in this document is verified against an
export.** Everything below is secondary-source evidence, and it is written this
way deliberately rather than dressed up as a grammar.

The headline finding is not about the format at all:

> **WPT Global removed hand-history export in June 2026.**

Source: <https://deepfold.co/en/blog/wpt-global-hand-converter>, which carries an
explicit "⚠️ Update (June 2026): WPT Global has removed hand history export"
banner, has struck through its own previously-working export instructions, and
states that "hand history files can no longer be obtained".

There was never a local hand-history folder on disk. The only export route was
in-client — Settings → Game History → Hand History → Email to Self — which
mailed a `.zip` of `.txt` files. With that route gone, **current WPT Global
users cannot produce a hand-history file at all**, and only exports captured
before June 2026 can exist anywhere.

That matters more than the missing grammar. Public traffic trackers put WPT
Global at roughly 15% of observable cash-game seats in 2026, which on its face
makes it the third-largest room and a top-priority parser target. But traffic
share overstates the *addressable* user base here, because most of those players
have nothing to give us. See `COVERAGE-PLAN.md` §2, "Blocked, with the block precisely characterised".

### Search record

Searched without success, so that the next person does not repeat it:

- GitHub repo and code search: `wpt global hand history`, `wptglobal`,
  `WPT Global Hand`, `wpt global hand history converter` — zero repositories,
  zero code hits containing a real hand.
- Open-source converter and tracker projects (the usual source for rooms that
  trackers cannot read natively) — no WPT Global support found.
- Poker forums and tracker support forums.

The fpdb-3 regression corpus, which proved to be the richest source for GGPoker
and Ignition, contains no WPT Global directory.

One more detail from the same deepfold.co source worth recording, because it
independently reinforces the "do not guess" conclusion in §4: it states that
"PokerTracker 4 and Hold'em Manager 3 support imports natively, but WPTG tweaks
their .txt format every few months, which breaks niche converters." If true,
this means even a genuine pre-June-2026 export recovered later could reflect
any one of several format revisions, not a single stable grammar — one more
reason a parser built from a single recovered sample (real or not) should be
treated as covering *a* WPT Global format, not *the* WPT Global format, until
multiple samples from different dates can be cross-checked against each other.

---

## 2. Detection signature

**Inferred, not verified.** From the secondary source:

```regex
/^WPT Global Hand #\d+:/m
```

This follows the PokerStars-family convention of a brand token followed by
`Hand #<digits>:`, and is unambiguous if correct.

**Independent corroboration that the brand token appears in the text:** our own
GGPoker parser carries a `FOREIGN_BRANDING` guard
(`frontend/src/lib/parsers/ggpoker.ts`) that lists `WPT Global` among the brands
it explicitly refuses. That guard exists because GG-family text is otherwise
similar enough to be mistaken, which is evidence both that the literal string
`WPT Global` occurs in these files and that the body resembles the family.

---

## 3. Format — secondary evidence only

The published example is:

```
WPT Global Hand #123456789: Hold'em No Limit ($1/$2 USD) - 2026/04/15 14:32:11 ET
Table 'Dallas 6-max' 6-max Seat #3 is the button
Seat 1: Player_AB12 ($248.50 in chips)
Seat 2: Player_CD34 ($198.00 in chips)
...
Player_AB12: posts small blind $1
Player_CD34: posts big blind $2
*** HOLE CARDS ***
Dealt to Hero [As Kh]
Hero: raises $4 to $6
...
```

**This is NOT a sample and must never be saved as a fixture.** The player names
are obvious placeholders (`Player_AB12`, `Player_CD34`), the hand id is
`123456789`, and the body contains literal `...` elisions. It is a hand-written
illustration produced to explain a converter, not an export.

What it is reasonable to conclude from it, at low-to-moderate confidence:

| Claim | Confidence | Basis |
|---|---|---|
| Header is `WPT Global Hand #<id>: <game> (<sb>/<bb> <CUR>) - <timestamp> <TZ>` | moderate | The shape is consistent across the illustration and matches PokerStars convention exactly |
| It is a **PokerStars-family** dialect, not GG-derived | moderate | `Table '...' N-max Seat #N is the button`, `*** HOLE CARDS ***`, `Dealt to`, `posts small blind`, `raises X to Y` are all family markers |
| Hero is named literally `Hero` | low | Appears in the illustration; could be the author's substitution |
| No anonymisation of opponents | low | `Player_AB12` reads like a placeholder for a real name rather than a real anonymisation scheme |

Everything else — showdown marker spelling, rake line shape, summary layout,
tournament header, run-it-twice support, ante model, straddle, file naming,
encoding, line endings, hands per file — is **completely unknown**. Do not
guess at any of it.

One thing specifically worth *not* assuming: because WPT Global is frequently
grouped with GGPoker in casual discussion, it is tempting to assume
`*** SHOWDOWN ***` without a space, GG-style. There is no evidence for that.
The one piece of evidence we have points at the PokerStars family, which would
mean `*** SHOW DOWN ***` with a space. Both are guesses.

---

## 4. Recommendation

**Do not write a WPT Global parser.** Three reasons, in order:

1. There is no sample to test against. A parser written off the illustration
   above would be a guess, and a guessing parser is worse than none — it
   silently mangles hands, where the absence of a parser produces an honest
   failure record we can act on.
2. The addressable user base is collapsing by construction. Export was removed;
   new users cannot generate input.
3. The current behaviour is already correct. The GGPoker parser's
   `FOREIGN_BRANDING` rejection means WPT Global text fails as "unknown site"
   rather than being mis-parsed as GGPoker. **Leave that guard in place.** It is
   the right call, not a gap.

Revisit only if a genuine pre-June-2026 export turns up — most plausibly from a
player's archive or a tracker database, since the room itself will not produce
one again.

---

## 5. Sample index

None. `fixtures/samples/wpt-global/` is intentionally empty and carries a
`SOURCES.md` recording this negative finding, so that the empty directory reads
as a deliberate result rather than unfinished work.

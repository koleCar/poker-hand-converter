# Parser coverage plan

Which parsers to build next, in what order, and what each one costs.

Companion documents: `FORMAT-MATRIX.md` (what the formats look like and which
ones can share a parser) and `hh-formats/<site>.md` (per-site detail).

---

## 1. Where we are

Registered parsers today (`frontend/src/lib/parsers/index.ts`): **weplay,
pokerstars, ggpoker, 888poker, partypoker, ipoker**, plus `standard` for our own
canonical output. Six real sites.

**Correction worth flagging:** WPT Global is sometimes described as shipped. It
is not. There is no WPT Global parser, and the GGPoker parser explicitly
*rejects* it — `ggpoker.ts` carries a `FOREIGN_BRANDING` guard listing
`WPT Global` among the brands it refuses, so such a file falls through to no
parser and fails as "unknown site". That rejection turns out to be the right
behaviour, not a bug: see item 2 in §3.

Corpus status by site:

| Status | Sites (fixture counts) |
|---|---|
| Parser + real corpus | PokerStars (45), GGPoker (43), iPoker (15), partypoker (15), 888poker (14), WePlay (9) |
| Real corpus, **no parser** | ACR/WPN (77), Ignition/Bodog/Bovada (56), Winamax (28), CoinPoker (16), Chico (16), Full Tilt (14), and the legacy XML/text set — Entraction (13), OnGame (13), Merge (12), MicroGaming (12), BossMedia (10) |
| Thin corpus, no parser | Unibet (5), PHH interchange spec (4), Run It Once (4), Pokerbros (2) |
| **No corpus at all** | WPT Global — and this is now known to be permanent, see §3 |

The GG skin directories (`natural8/`, `bestpoker/`, `clubgg/`) have been removed
rather than left empty: the skin question is answered and needs no fixtures. See
item 7 below. `wpt-global/` is kept deliberately empty, carrying a `SOURCES.md`
that records why no sample can exist.

---

## 2. How I am prioritising

Three inputs, in this order:

**Real-world user base.** Public traffic trackers for 2026 put GGPoker at
roughly 36% of observable cash-game seats, PokerStars ~25% and WPT Global ~15%
— about three quarters of tracked seats between them. CoinPoker measures
around 2,016 concurrent cash players against PokerStars' 2,198, which puts it
in the same tier as PokerStars by that particular metric. iPoker holds a steady
1.5–2k. Winamax is among the fastest-growing. For US-facing traffic the
relevant names are WPN, Chico and Ignition.

*Confidence: moderate, and the direction matters more than the digits.* These
come from affiliate-adjacent traffic sites ([PrimeDope](https://www.primedope.com/largest-poker-sites/),
[VIP-Grinders](https://www.vip-grinders.com/research/online-poker-traffic-report/),
[HighStakesDB](https://highstakesdb.com/poker-room-ranking),
[WorldPokerDeals](https://worldpokerdeals.com/blog/ggnetwork-becomes-the-1-poker-site-in-the-world)),
which have an incentive to flatter rooms they are affiliated with. They also
count *concurrent cash seats*, which under-counts tournament-heavy rooms like
PokerStars and over-counts grinder-heavy ones. Treat them as a ranking, not a
measurement.

**Evidence available.** A site with a real corpus can be built correctly and
tested. A site without one cannot — a parser written against no sample is a
guess that will silently mangle hands, which is worse than no parser, because
no parser at least produces an honest failure record. This is why some
high-traffic sites appear *below* lower-traffic ones in the order: sourcing has
to happen first.

**Marginal cost.** Whether the site joins an existing family (cheap) or needs
its own tokeniser (expensive). See `FORMAT-MATRIX.md` §4.

---

## 3. Recommended build order

### Tier 1 — do these first

**1. CoinPoker** — *difficulty: low-medium. Unlocks a pool comparable to PokerStars by concurrent cash seats.*
**Sourcing resolved.** 16 real fixtures now in `fixtures/samples/coinpoker/`,
machine-verified byte-exact, covering cash and tournaments, extracted from ~4.2M
lines of raw client logs. Full documentation in `hh-formats/coinpoker.md`.
It is a PokerStars-family dialect, so the tokeniser is largely reusable, but it
needs its own header regex and several overrides that change *numbers*, not just
strings: the all-in raise form `raises N and is all-in` carries only one amount;
hand descriptions use `three of kind` and `Aces over Fours`; seat lines have
suffixes after the closing paren; and the hand separator is one blank line, not
two. This is now the highest value-per-hour item in the plan.

**2. WPT Global** — *difficulty: low if attempted. Unlocks ~15% of tracked cash seats — but see the caveat.*
Still zero samples, and the situation is worse than "not yet sourced":
**WPT Global removed hand-history export in June 2026**
([source](https://deepfold.co/en/blog/wpt-global-hand-converter), which carries
an explicit removal banner and has struck through its own export instructions).
There was never a local hand-history folder — the only route was
Settings → Game History → Hand History → Email to Self. So current users cannot
produce a file to upload at all, and only pre-June-2026 exports can exist.

That materially changes the calculus. The ~15% traffic share overstates the
addressable users, because most of them have nothing to give us. Secondary
sources put the header at `WPT Global Hand #<id>: Hold'em No Limit ($1/$2 USD) - <ts>`
followed by a PokerStars-style table line, which would make it a cheap Family A
dialect — but the only example found is a hand-written mock-up with placeholder
names, not an export, so it is not ground truth and no parser should be written
off it. Recommendation: leave the GG parser's `FOREIGN_BRANDING` rejection in
place so these fail honestly, and revisit only if a real pre-removal export turns
up.

**3. ACR / WPN** — *difficulty: medium-high. Unlocks the largest US-facing pool.*
77 real fixtures already on disk, including the awkward cases (straddle, posting
dead, waiting for BB, strange player names, names with parentheses, a sit-out
line with no name, a cancelled hand). Highest evidence quality of anything
unbuilt. The cost is that it shares nothing with existing parsers: `Game started
at:` / `Game ID:` header pair, every action prefixed `Player `, hole cards dealt
one line per card, `*** FLOP ***: [..]` with a colon after the stars, bare
parenthesised amounts with no currency symbol, and an `------ Summary ------`
block with per-player `Bets: / Collects: / Loses:` accounting. Budget a full
parser, not a dialect. Watch for run-together text with no separating space
(`does not show cards.Bets: 0.25.`).

**4. Ignition / Bodog / Bovada** — *difficulty: high. Unlocks a large US pool that no tracker handles natively.*
56 real fixtures on disk from the fpdb3 regression corpus and a converter
project — cash, MTT, STT, Zone Poker, PLO8, 7-Stud, and a Bodog.eu variant.
Genuinely good coverage. The difficulty is not the syntax, it is the semantics:
**there are no player names.** Seats are labelled `Small Blind`, `Big Blind`,
`UTG`, `UTG+1`, `UTG+2`, `Dealer`, and the hero is marked with a `[ME]` suffix
(`Seat 3: UTG [ME] ($4.37 in chips)`). Cards are dealt with
`UTG [ME] : Card dealt to a spot [Ks Jh]`, the button is set with
`Dealer : Set dealer [6]`, and players drop out with `Leave(Auto)`.

Two consequences worth deciding up front, because they leak into the data model
rather than the parser: identity is positional, so the same label refers to a
different human in every hand and player names cannot be used as a join key
across hands; and the labels are *positions*, so a naive parser that derives
position from the label will be circular and will silently agree with itself
even when the button parsing is wrong. Also note `Raises $0.15 to $0.15` — the
same "chips added, not increment" semantic as WePlay. Drive off the second
number. This is the parser most likely to produce plausible-looking wrong output,
so it deserves the most test scrutiny.

### Tier 2 — good value, clear path

**5. Winamax** — *difficulty: low-medium. Unlocks the dominant French-market room, and it is growing.*
28 real fixtures on disk. Skeleton is close enough to the PokerStars family to
feel familiar but diverges at every point that matters: `*** ANTE/BLINDS ***`
and `*** PRE-FLOP ***` markers the family lacks, currency **suffixed** to every
amount (`0.50€`), `Board: [...]` with a colon, and French-derived hand
descriptions (`(One pair : 3)`) that match no English hand-description table.
Build standalone rather than bolting conditionals onto PokerStars.

**6. Chico (TigerGaming / BetOnline)** — *difficulty: unknown-medium. Unlocks the third US-facing network.*
16 real fixtures on disk — enough to start, thin enough that edge cases will be
missing. Worth building after ACR since both serve the same US audience and
users often have accounts on both.

### Tier 3 — cheap completions

**7. GG skins: Natural8 / BestPoker / ClubGG** — *difficulty: zero. Already covered.*
**Question answered, no work needed.** A dedicated Natural8-to-Hand2Note
converter ([`jokerlin/gg_converter_gui`](https://github.com/jokerlin/gg_converter_gui))
performs exactly one header transformation — `"Poker Hand #RC"` →
`"PokerStars Hand #20"` — which means Natural8 emits the same
`Poker Hand #<PREFIX><id>:` header as GGPoker with **no skin branding anywhere**.
The two-letter prefix encodes *game type*, not skin: `HD`, `RC` (Rush & Cash),
`OM` (Omaha), `SD` (Short Deck), `TM` (tournament) and `AF` (All-in or Fold) are
all observed in real corpora.

So the GG parser needs no skin dimension; it needs its prefix matcher to accept
`#[A-Z]{2}\d+` generally rather than enumerating known prefixes. This rests on
converter source plus secondary reporting rather than on a Natural8 export in
hand, but it is consistent evidence from two independent directions. The empty
`natural8/`, `bestpoker/` and `clubgg/` fixture directories should be removed
rather than left as silent gaps.

**8. Unibet** — *difficulty: unknown. Small but real European pool.*
Now has a thin corpus (5 files) and a site doc. Platform moved to Relax Gaming
in 2019, so pre-2019 documentation describes a format that no longer ships —
check `hh-formats/unibet.md` for which era the samples belong to before
building.

### Tier 4 — only if a user actually asks

**9. Pokerbros — promote this if Family B gets built.** *Difficulty: near-zero once partypoker exists.*
The research answered the open question and the answer is better than expected.
Pokerbros Dialect A is
`***** Hand History for Game <id> ***** (PokerBros)` — the partypoker banner with
a brand token appended. Since partypoker already has a shipped parser, this is
close to free: capture the brand token to disambiguate from genuine partypoker,
and reuse the family tokeniser. A live club app for the cost of a dialect switch
is the best marginal return in this plan after CoinPoker. A second unrelated
dialect also exists; see `hh-formats/pokerbros.md`.

**10. PPPoker — do not build. Verified negative.**
The research confirms **no native text hand-history export**. The doc also
records a specific trap worth heeding: some third-party PPPoker converters emit
files with a `PokerStars Hand #` header, so such a file may be genuine
PokerStars *or* laundered PPPoker data, and there is no reliable string to tell
them apart. Do not add a PPPoker detection rule. The correct deliverable here is
a clear UI message, not a parser.

**11. Legacy networks: Full Tilt, OnGame, Entraction, Merge, MicroGaming,
BossMedia.** All have real corpora on disk, all are dead or near-dead sites. The
XML ones (Merge, MicroGaming, BossMedia) are individually the *easiest* parsers
in the entire set — XML removes the whole class of whitespace and
name-tokenising bugs that dominates the text formats — so they are tempting.
Resist: easy is not the same as valuable, and nobody is uploading 2013 Merge
hands. Build only if someone does.

**12. Run It Once.** Closed in 2022. Effectively zero users. Build only on
request.

**13. PokerTracker 4 / Holdem Manager 3 — no parser needed.**
The research verdict is that they have no distinct hand-history text format and
re-emit the original site text, so the shipped parsers already handle most
PT4/HM3 exports for free. See `hh-formats/pokertracker4.md` and
`holdem-manager3.md`. The one artefact that might still justify attention is
their *import-error log* format, since that is often what a confused user will
paste at us. There is also a real interchange standard worth knowing about —
see `hh-formats/interchange-formats.md` and `fixtures/samples/phh/`.

---

## 4. Sites where I could not find real samples

Recorded explicitly, because a missing sample is the condition under which a
future agent invents a format and ships something that silently mangles hands.

| Site | Status | Consequence |
|---|---|---|
| **WPT Global** | No samples, and **none can be obtained** — export removed June 2026 | Permanently unsourceable except from pre-removal archives. The only published "example" is a placeholder mock-up, not an export. `fixtures/samples/wpt-global/SOURCES.md` records the detail. |
| **Natural8 / BestPoker / ClubGG** | No samples — **but the question is answered without one** | Converter source shows Natural8 emits GGPoker's header verbatim. No skin dimension needed. Resolved, not a gap. |
| **PokerStars: Spin & Go** | No real sample found anywhere | A popular format with no verified grammar. Worth a targeted hunt. |
| **PokerStars: tournament run-it-twice, "wins the tournament and receives $X", full HORSE rotation, localized non-English client output, straddle** | Not found | Recorded by the PokerStars research pass rather than invented. |
| **CoinPoker: side pots, run-it-twice, non-Hold'em** | Absent from a ~4.2M-line corpus | Genuinely unknown, not proven absent. Split-pot summary grammar is the notable hole. |
| **Tournament formats generally** | Only WePlay, PokerStars and Ignition have verified tournament samples | Bounty awards, level changes, finishing positions, rebuys and add-ons are unverified for most sites. Tournament hands are where a cash-tested parser most often breaks. |
| **Modern partypoker / 888** | Corpus is ~2012–2015 vintage | Both platforms changed since. The shipped parsers are validated against an era, not against today. |

---

## 5. Traps that will bite regardless of order

Ranked by how much damage they do and how easily they pass tests anyway.

1. **Raise amounts are three different semantics across sites, and the wrong one
   still balances about half the time.** This is the most damaging and most
   easily-missed bug class in the whole project.

   | semantic | sites | shape |
   |---|---|---|
   | increment *over the current bet* | PokerStars, GGPoker, Winamax | `raises X to Y` |
   | **chips the player adds now** | WePlay, Ignition/Bodog/Bovada, **ACR/WPN era A/B** | `raises X to Y` / `raises (N)` |
   | one amount, no total at all | CoinPoker all-in form | `raises N and is all-in` |

   Where a total `Y` is printed, **drive off `Y`** — the post-action street total
   is unambiguous everywhere. Where it is not (ACR era A/B `raises (N)`,
   CoinPoker's all-in form), you must know which semantic the site uses, because
   the three readings only diverge when the raiser already has chips in front of
   them. On ACR, replaying the whole corpus against the independently-printed
   `Bets:` column scored chips-added 87 match / 8 explainable, absolute-total
   53/42, increment 2/93 — note that the *wrong* reading still matched 53 hands.
   That is exactly how this ships unnoticed. If a format prints an independent
   per-player total anywhere (ACR's `Bets:`, a rake line, a summary collected
   amount), reconcile against it per hand rather than trusting the verb.
2. **Run-it-twice double-counts pots.** PokerStars and GGPoker emit a *separate
   showdown block per run* (`*** FIRST SHOW DOWN ***` / `*** FIRST SHOWDOWN ***`)
   each containing its own `collected` lines, so a winner collects twice and a
   naive sum reports double the pot. WePlay emits both boards but only one
   showdown block. A pot-balance assertion will catch this — if you have one.
3. **Rake conventions differ.** PokerStars and GGPoker: `collected` sums to
   `Total pot − Rake`. WePlay: `collected` sums to `Total pot`, with rake
   reported but never deducted (verified across 3,915 raked hands). A balance
   check written for one convention fails every hand of the other.
4. **Positional pseudo-names break identity.** Ignition/Bodog/Bovada have no
   player names. Anything keyed on player name across hands is wrong there.
5. **Anonymised ids are not fixed-width.** GGPoker hex ids are 7 *or* 8
   characters; `[0-9a-f]{8}` silently drops some.
6. **`shows` lines appear mid-street.** GGPoker exposes cards at the moment of
   an all-in, before the board completes, and those lines carry no hand
   description. A parser that only looks inside the showdown block, or that
   requires the ` (description)` suffix, misses them.
7. **Header metadata lies.** WePlay tournament headers carry stale blind levels
   that never advance — `Level XIV (100/200)` on a hand where 1000/2000 is
   actually posted. Always derive blinds from the posting lines.
8. **Player names are hostile.** Spaces, dots, commas, hyphens, `@`, colons,
   brackets and slashes all appear in real names across the corpus. Anchor on
   delimiters and the seat roster, never on a name charset.
9. **Encoding and whitespace are part of the input.** UTF-8 BOMs, CRLF, CR-only
   line endings, trailing spaces on most lines, and run-together text with
   missing separators are all present in real exports. Fixtures preserve them
   deliberately; do not normalise them away in test setup, or the tests stop
   testing the thing that breaks.
10. **Casing is not stable within a single site.** 888poker emits both
    `** Dealing Flop **` and `** Dealing flop **` in its own corpus. Match
    case-insensitively.
11. **Rake lines have optional tails.** GGPoker emits four different shapes —
    `Total pot $N` with no rake field at all, `+ | Rake`, `+ | Jackpot | Bingo`,
    and `+ | Fortune | Tax`. Requiring the full six-field form fails on most of
    the GG corpus. CoinPoker emits two fields and no jackpot fields at all.
12. **Verbs are not consistent across the family.** GGPoker's straddle verb is a
    bare `straddle $20`, where PokerStars, WePlay and CoinPoker all use
    `posts straddle`. CoinPoker's all-in raise drops the `to` clause entirely.
    Never assume a verb learned on one site transfers.
13. **Hand-description wording is per-site and there are at least four
    dialects.** `high card Ace` (PokerStars, WePlay) vs `Ace high` (GGPoker,
    CoinPoker); `Aces full of Fours` (PokerStars, WePlay) vs `Aces over Fours`
    (CoinPoker); `three of a kind` vs CoinPoker's `three of kind`; and GGPoker
    Omaha uses `Pair of Kings and Pair of Sixes` where others say
    `two pair, Kings and Sixes`. If you normalise descriptions, do it per site.
14. **Blind levels can carry thousands separators.** GGPoker tournament headers
    include `Level18(1,250/2,500)`, and the spacing around `Level` is itself
    inconsistent (`Level1(100/200)` vs `Level4 (90/180)`), with one real header
    carrying three spaces before the ` - ` separator.

---

## 6. Suggested next three actions

1. **Build CoinPoker.** Sourcing is done — 16 verified fixtures and a full site
   doc. It is a PokerStars-family dialect serving a pool comparable to
   PokerStars, which makes it the best value-per-hour item available.
2. **Build ACR/WPN.** Best evidence-to-value ratio of anything else: 77 real
   fixtures including the hard cases, and the largest US-facing pool.
3. **Harden the GGPoker parser against the newly-sourced corpus.** 33 real
   fixtures were added covering tournaments (`#TM`), bounty/KO, PLO, PLO5, Short
   Deck, All-in-or-Fold, straddles, missed blinds, run-it-twice *and thrice*,
   and all-in insurance. The parser was previously validated against one skin,
   one game type and one stake level, so this is where the most latent breakage
   is. In particular the rake line has four possible shapes and the current
   six-field assumption fails on most of the corpus.

Ongoing, and worth more than any single parser: the failure-recording path
(`ConversionFailure` in `frontend/src/lib/phf/detect.ts`) turns real user
uploads into evidence about which format to build next. Once it has traffic, it
should outrank the traffic-tracker estimates in §2 — those measure the market,
whereas failure records measure *our* users.

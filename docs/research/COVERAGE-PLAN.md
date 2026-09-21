# Coverage plan — what is built, and what is left

**Status: the build-order question this document was created to answer is
largely settled.** Eighteen site parsers ship. What remains is a short, mostly
*blocked* list, so this document now leads with the gaps rather than a ranking.

Companion documents: `FORMAT-MATRIX.md` (what the formats look like and which
ones share a parser) and `hh-formats/<site>.md` (per-site detail).

---

## 1. Where we are

**19 registered parsers** in `frontend/src/lib/parsers/index.ts` — 18 real sites
plus `standard` for our own canonical output. **2595 tests pass** (23 files, 1
skipped) against the research corpus.

Shipping parsers, all with a real corpus behind them:

> 888poker · ACR/WPN · Chico · CoinPoker · Entraction · Full Tilt · GGPoker ·
> Ignition/Bodog/Bovada · iPoker · MicroGaming · OnGame · partypoker ·
> Pokerbros · PokerStars · Run It Once · Unibet · WePlay · Winamax

**The corpus: 413 fixture files across 22 site directories** — 21 with content,
plus `wpt-global/` deliberately empty and carrying a `SOURCES.md` that records
why. That total reconciles with `FORMAT-MATRIX.md` §5: 391 UTF-8 + 8
Windows-1252 + 14 UTF-16LE = 413. The in-repo source corpora `gg-hh/` (10 files)
and `weplay-hh/` (104) sit outside that count.

**Zero synthetic fixtures.** Every sample in the corpus is a real export or a
byte-exact excerpt of one. Where a hand could not be sourced, the gap is recorded
as a negative finding rather than filled with an invention — including one case
where a research pass found fabricated Spin & Go fixtures on GitHub and rejected
them rather than banking them.

Corpus directories with **no** parser: `bossmedia` (10 files), `merge` (12), and
`phh` (4 — an interchange spec, not a site). Everything else is covered.

---

## 2. What is actually left

Five items. Only one of them is ordinary work; the rest are blocked, and the
blocks are the interesting part.

### The one tractable pickup

**Merge — 12 real fixtures, no parser, nothing blocking it.** XML, so it skips
the entire class of whitespace and name-tokenising bugs that dominates the text
formats (`<round id="PREFLOP">` with `type="SMALL_BLIND"` event names; see
`FORMAT-MATRIX.md` §4, Family C). This is the cheapest remaining addition by a
wide margin. The honest caveat is that Merge is a dead network, so the work is
cheap but the user-facing payoff is near zero — worth doing for completeness or
when someone actually uploads one, not ahead of anything user-facing.

### Blocked, with the block precisely characterised

**BossMedia — blocked on suit labelling, and permanently so from this corpus.**
This one moved during the final research pass and the previous "the card
encoding is opaque" framing was too pessimistic. Cards are numeric IDs, and the
rank half is now **solved and verified**: `rank = id % 13` with `0 = Ace`,
`suit = id // 13`. Three `<RESULT>` elements state a hand strength in words
alongside the winning card IDs, giving six independent rank constraints that all
hold.

What cannot be solved is *which* suit index is clubs/diamonds/hearts/spades.
Suit only becomes observable when a hand's strength depends on it, and the whole
10-file corpus contains only pairs, two-pairs and straights — **no flush, no
flush draw, nothing suit-dependent**. All 24 permutations fit equally well. This
is a permanent property of the corpus, not an analysis gap.

Declining to convert is still correct: emitting `9c` for a card that may be `9h`
publishes data we cannot support. **To unblock, one real BossMedia hand
containing a flush is sufficient** — nothing else is missing. Payoff is two
Hold'em hands, so this is low priority, but the blocker is now cheap to state and
cheap to clear if a sample appears. Detail in
`hh-formats/legacy-networks.md` (BossMedia §4) and `fixtures/samples/bossmedia/SOURCES.md`.

**WPT Global — blocked permanently, by the site.** WPT Global removed
hand-history export in June 2026. There was never a local hand-history folder;
the only route was an in-client "email to self" that no longer exists. Current
users **cannot produce a file to upload**, so the ~15% cash-seat traffic share
badly overstates the addressable population. The only published "example" is a
hand-written mock-up with placeholder names, not an export, and no parser should
be written from it.

The current behaviour is already correct and is now **enforced in code**: the
GGPoker parser's `FOREIGN_BRANDING` guard lists `WPT Global` and refuses it, so
such a file fails honestly as "unknown site" rather than being silently
mis-parsed as GGPoker. **Leave that guard in place.** This is a research negative
finding that survived contact with implementation.

**PPPoker — blocked because the format does not exist.** No native text
hand-history export. The deliverable here is a clear UI message, not a parser.
One specific trap worth keeping: some third-party PPPoker converters emit files
with a `PokerStars Hand #` header, so such a file may be genuine PokerStars *or*
laundered PPPoker data, with no reliable string to tell them apart. **Do not add
a PPPoker detection rule.** See `hh-formats/pppoker.md`.

**GG skins Natural8 and BestPoker — no samples, but no work needed either.**
A dedicated Natural8-to-Hand2Note converter's entire transformation is
`"Poker Hand #RC"` → `"PokerStars Hand #20"`, which means Natural8 emits
GGPoker's header shape with no skin branding. The two-letter hand-id prefix
encodes *game type* (`HD`, `RC`, `OM`, `SD`, `TM`, `AF`), not skin. The shipping
GGPoker parser should therefore already cover them.

*Labelled unverified:* this rests on converter source plus secondary reporting,
not on a Natural8 or BestPoker export in hand. It is consistent evidence from two
independent directions, but a single real skin sample would convert it from
inference to fact. Low cost, low urgency.

---

## 3. What the traffic numbers say now

Kept because it is the sanity check on whether coverage matches demand, not
because anything here is still a build decision.

Public 2026 traffic trackers put GGPoker at roughly 36% of observable cash-game
seats, PokerStars ~25% and WPT Global ~15%. CoinPoker measures around 2,016
concurrent cash players against PokerStars' 2,198. iPoker holds a steady 1.5–2k.
Winamax is among the fastest-growing. US-facing traffic concentrates in WPN,
Chico and Ignition.

*Confidence: moderate; direction matters more than the digits.* These come from
affiliate-adjacent sites ([PrimeDope](https://www.primedope.com/largest-poker-sites/),
[VIP-Grinders](https://www.vip-grinders.com/research/online-poker-traffic-report/),
[HighStakesDB](https://highstakesdb.com/poker-room-ranking),
[WorldPokerDeals](https://worldpokerdeals.com/blog/ggnetwork-becomes-the-1-poker-site-in-the-world))
which have an incentive to flatter rooms they are affiliated with, and they count
*concurrent cash seats*, which under-counts tournament-heavy rooms and
over-counts grinder-heavy ones.

**Against that list, coverage is essentially complete.** Every named room ships a
parser except WPT Global, which is unobtainable by construction. The one
remaining lever on real-world coverage is therefore not another parser — it is
the failure-recording path (`ConversionFailure` in
`frontend/src/lib/phf/detect.ts`), which turns real user uploads into evidence.
Once it has traffic it should outrank every estimate above: those measure the
market, failure records measure *our* users.

---

## 4. Traps that bit, and will bite again

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

## 5. What the research actually bought

Recorded because it is the payoff, and because several of these were judgement
calls that could have gone the other way.

- **19 parsers built against this corpus, 2595 tests passing.** The corpus was
  assembled before most of those parsers existed, and it held.
- **Zero synthetic fixtures.** The discipline cost real coverage — Spin & Go has
  no fixture because the only ones findable were other people's fabrications —
  and it was worth it. A parser agent can trust any file in `fixtures/` as
  ground truth without checking.
- **Negative findings survived implementation.** WPT Global's "do not build,
  cannot be sourced" is now enforced in code by the GGPoker foreign-branding
  guard. PPPoker's "no text format exists" prevented a detection rule that would
  have mis-claimed genuine PokerStars files.
- **Three documented errors were caught and corrected by implementation**, each
  after being re-derived from the bytes rather than taken on report: ACR's
  `raises (N)` semantic, Chico's multiple-`Total pot`-line rule, and the Winamax
  Windows-1252 file count. Each correction carries its evidence and an explicit
  retraction of the earlier claim, so the retraction travels with the document.
  The ACR one is the cautionary tale: the wrong reading still matched 53 of 95
  hands, which is exactly how a bug like that ships unnoticed.

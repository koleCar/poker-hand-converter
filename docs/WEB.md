# Rail web — converter, library and database

> This was the repository README until 2026-10-12, when Rail's scope grew to a
> desktop tracker and HUD ([`RAIL_GUIDELINE.md`](RAIL_GUIDELINE.md)). It is kept
> whole as the reference for the web app as it stands today: the pipeline, the
> refusal principle, the corpus, the load-bearing rules and the deployment.
> Paths in it are relative to the repository root.

A browser-based converter and replayer for poker hand histories.

Drop an export from almost any poker room into it and you get back one
canonical representation of every hand — which you can then download as
tracker-importable text, step through in a visual replayer, keep in a
searchable library, or hand to someone else as a link.

The conversion runs entirely in the browser — hand histories never leave the
tab. The data store is Supabase (Postgres + PostgREST), and every query the app
makes runs **as the signed-in user**, policed by RLS; there is no service-role
key in the app and no privileged middle tier. Next.js renders on the server for
the two things that need it: the session cookie, and the Open Graph tags on a
shared hand.

Converting, previewing, downloading and replaying need no account at all. An
account is what gives you a *library*: hands you save belong to you and nobody
else can read them. The one deliberate exception is a share link — anyone you
send one to can replay that hand without signing in, with the players' names
hidden unless you turn them on for that link (R4.5).

Live: **https://poker-hand-converter.vercel.app**

---

## The pipeline

There is one idea underneath the whole project: **PHF**, the Poker Hand Format
(`phf/1`). It is a typed JSON document that describes a hand completely —
money as integer minor units, an authoritative action stream, run-it-twice as
an array rather than a special case, and mandatory provenance saying which
parser produced it from which bytes.

Everything else is a conversion into or out of that one shape:

```
raw text / XML
      │
      ├─ detectSite(text)             → ranked parser candidates, scored 0..1
      ├─ parser.splitHands(text)      → one chunk per hand
      ├─ parser.parseHand(chunk)      → PhfHand
      ├─ assignPositions(hand)        → BTN/SB/BB/… from the posted blinds
      ├─ validateHand(hand)           → errors (refuse) / warnings (keep, flag)
      │
      ├─ toStandardText(hand)         → GG-style text, for tracker import
      ├─ buildReplay(hand)            → frames, for the replayer
      ├─ handInsertFromPhf(hand)      → a `hands` row, for the library
      └─ ConversionFailure[]          → the corpus of what we could not read
```

The GG-style plain text this app produces is **one output of PHF, not the
source of truth**. It exists for exactly one reason: Holdem Manager and
PokerTracker import that shape, and their importers are byte-sensitive. So the
serializer preserves things no structured field should have to model —
decimal style, digit grouping, which fee columns the summary printed, an
incidental triple space in a GG tournament header — and a round-trip test
asserts `toStandardText(parseStandardText(t)) === t` over the whole corpus.

Full specification, including the type system and the invariants the validator
enforces: **[`docs/PHF-SPEC.md`](PHF-SPEC.md)**.

---

## The refusal principle

This is the design decision that shaped everything else, so it is worth
stating plainly rather than listing as a feature.

**A hand that cannot be converted faithfully is refused.** It is not
approximated, not guessed at, not silently dropped. It is recorded — with its
original text, the site we thought wrote it, how confident we were, which
pipeline stage gave up and why — in the `unparsed_hands` corpus, and the user
is told it was refused.

The reason is that the failure modes here are not symmetrical. A hand that
fails to convert is a visible, recoverable annoyance: the user sees it, and the
raw text is still on disk. A hand that converts *wrongly* — a raise sized off
the wrong number, a pot that balances because a rounding error cancelled
itself, a play-money table counted into a real-money win rate — gets imported
into a tracker and quietly poisons a player's statistics. They will not notice.
They will make decisions on it for months. There is no way back, because the
tracker's database no longer distinguishes the bad rows from the good ones.

So the bias runs one way: **refuse when unsure**. Concretely, that means

- every parser throws `ParseSkip(reason, message)` for a format it recognises
  but is not certain it can represent — unsupported variants, corrupt sources,
  ambiguous amounts, all-in-or-fold tables, cancelled hands;
- `parseAmountStrict` refuses `1 234,50 €` rather than guessing at the
  separators, because the wrong guess is off by 100x and still balances;
- any line a parser does not understand becomes a recorded warning, never a
  silent drop, and the corpus tests fail the build if a site a parser claims to
  understand produces warnings;
- `validateHand` treats a chip-conservation or payout mismatch as an *error*,
  which means the hand is never stored as a normal hand.

Several parsers deliberately refuse formats they could plausibly have handled.
The GGPoker parser carries a `FOREIGN_BRANDING` guard that rejects WPT Global
files even though they look close enough to try, because "close enough" is how
you get wrong bet sizing. That rejection is the correct behaviour, not a gap.

High-low split is the clearest case of all. An `Omaha Hi/Lo` hand read as plain
Omaha *balances perfectly* - the summary states who collected what, so chip
conservation, payout conservation and every other invariant in `validateHand`
pass. There is no downstream check that would ever catch it, and half of every
pot would be attributed to the wrong rule. So Hi/Lo is read only where a room's
own fixtures prove it, with every award labelled as the high or the low half
(worked out from the cards; see `docs/PHF-SPEC.md` §3.10), and refused by name,
`unsupported-hi-lo`, everywhere else rather than left to look like a hand we
understood.

The corpus is the other half of the deal. A refusal is not a dead end — it is
a work item with a reproduction attached. `unparsed_gaps` rolls the corpus up
by site, stage and reason, ordered by how often each one is hit, and the top
row is the answer to "which parser do we write next".

---

## Coverage

**19 registered parsers** (`web/src/lib/parsers/`), covering rather more
than 19 rooms — the Ignition parser also handles Bodog and Bovada, the Chico
parser handles its skins, and ACR/WPN covers the network:

| Shape | Parsers |
| --- | --- |
| PokerStars-family text | PokerStars, GGPoker, WePlay, CoinPoker |
| `***** Hand History for Game *****` text | partypoker, 888poker, PokerBros |
| XML | iPoker, MicroGaming |
| Its own dialect | Winamax, ACR/WPN, Ignition (also Bodog and Bovada), Chico (BetOnline, PayNoRake, ActionPoker, Gear Poker), Full Tilt, Ongame, Entraction, Unibet, Run It Once |
| Our own output | `standard` — the GG-style text this app emits, so its own exports round-trip |

"PokerStars-family in shape" is not the same as "safe to parse with a
PokerStars regex", which is why Full Tilt sits in the last row despite looking
like a member: `Uncalled bet **of** $20`, action lines with no colon, the
button declared after the blinds, and two incompatible header word orders.
Each of those is a way to produce a hand that balances against itself and is
still wrong.

### Variants

Each parser carries its own variant allowlist
(`web/src/lib/parsers/shared/variant-lock.ts`), and a variant goes on a
room's list only once that room's own fixtures convert it cleanly. Reading a
room's Hold'em says nothing about whether it reads that room's Omaha.

| Reads | Parsers |
| --- | --- |
| Hold'em, four- and five-card Omaha, four-card Omaha Hi/Lo | Entraction |
| Hold'em, four- and five-card Omaha, short deck | GGPoker |
| Hold'em, four-card Omaha, four-card Omaha Hi/Lo | PokerStars, partypoker, 888poker, MicroGaming, Ignition, Full Tilt |
| Hold'em, four-card Omaha, short deck | ACR/WPN |
| Hold'em and four-card Omaha | iPoker, Winamax, Chico, Ongame, Unibet |
| Hold'em only | WePlay, CoinPoker, PokerBros, Run It Once |

Hi/Lo has a list of its own (`SiteParser.hiLoVariants`), because reading a
room's Omaha says nothing about reading where its split pot went. Every other
room, and five-card or stud Hi/Lo everywhere, is refused as `unsupported-hi-lo`;
stud, razz and draw games are refused in every room. Several rows come with
caveats:

- **ACR/WPN** stays off the Hi/Lo list. Of its eight `O8` files the four that
  convert never pay a pot to more than one player, so not one split has been
  read from this room, and the other four fail for reasons of
  their own (a run-it-twice, a duplicated card, two legacy hands whose `Bets:`
  column disagrees with the actions). Its legacy summary also sums each
  player's winnings across pots and halves into one `Collects:` figure.
- **Ongame** stays off it too: its one Hi/Lo file never splits a pot, and no
  Ongame file in any game shows how the room prints a pot paid to two players.
- **Entraction** converts three of its four Hi/Lo files. The fourth pays the
  whole pot high while the other shown hand holds a qualifying low, and is
  refused as `hi-lo-payout-contradiction`; it shares its hand number with
  another fixture but not its cards.
- **Ignition**'s two 2012 tournament Hi/Lo hands carry the same
  `streets-inferred` note as its 2012 Omaha high files: that export prints no
  street markers.

Short deck (6+ Hold'em) is a different game rather than a longer deal: 36 cards,
a flush over a full house, `A-6-7-8-9` the low straight. It goes on a room's
list as its own entry, with a backstop like Hi/Lo's (`SiteParser.shortDeck`),
and only the two rooms with short-deck fixtures have it; every other room
refuses it as `unsupported-variant`. The validator refuses a deuce-to-five in a
short-deck hand (`card-not-in-deck`), and all-in EV deals the runout from the
36-card deck.

- **GGPoker** short deck is ante-only: every seat antes, the button alone posts
  a `button blind`, and the header carries that one stake
  (`ShortDeck No Limit ($0.02)`). The button blind is a big blind whose verb
  says the button posted it, so positions are named from the button with no
  `SB` or `BB`, and the steal family of stats is off for these hands. GG's
  straddle amount is the straddler's street total, which is what lets the
  button straddle its own blind - reading it that way also converts the two
  PLO-5 straddle hands that used to be refused.
- **ACR/WPN** deals Six Plus with an ordinary small and big blind, so only the
  deck and the ranking differ from its Hold'em. One legacy hand is the whole
  sample, so the modern dialect still refuses it; it is written out as Stars'
  `6+ Hold'em No Limit`.
- **Trips against a straight is ranked per room.** GGPoker ranks a straight
  over three of a kind: its own payout in fixture 12 gave `Qs Ks` (ace-high
  straight) the pot over `Td Ts` (three tens). Every other room keeps the
  classic rule, trips over a straight, until a fixture of its own says
  otherwise. A flush beats a full house under both. The room-to-rule map is
  `SHORT_DECK_RULE_BY_SITE` in `web/src/lib/equity/evaluator.ts`, and
  all-in EV reads it from the hand's room.

And two of the Omaha rows:

- **Chico** labels its four-card hands `Hold'em Pot Limit`, so the variant is
  taken from the number of cards dealt. Only 4 of the 17 hands in its one Omaha
  file convert. The other 13 are refused because the network's own pot
  accounting doesn't add up: a printed `Rake 0.00` on hands that were raked, or
  side pots missing from the summary. Their variant has nothing to do with it.
- **Run It Once** has one Omaha file, and it is refused. It is a
  splash-the-pot side-pot hand whose `collected` lines count the promotional
  money twice. Nothing in the file says which pot the money really went to.

Which formats can share a parser, and why the "everything is a PokerStars
clone" intuition is wrong, is worked through in
[`docs/research/FORMAT-MATRIX.md`](research/FORMAT-MATRIX.md). What to
build next and what each one costs is in
[`docs/research/COVERAGE-PLAN.md`](research/COVERAGE-PLAN.md). Per-room
detail lives in the 22 documents under `docs/research/hh-formats/`.

### The corpus

**Over 400 real hand-history files across 22 site directories**, in
`fixtures/samples/` (408 `.txt` and `.xml` files that the tests and goldens
read, plus four `.phh` examples of the PHH spec and one HTML summary, which
are not inputs). **There are no synthetic fixtures there.** Every file is a real
export or a real data-mined sample, and each site directory carries a
`SOURCES.md` recording where its files came from and what is verified about
them. Two directories are deliberately special: `wpt-global/` is empty and its
`SOURCES.md` explains that no sample can exist, because the room removed
hand-history export in June 2026; `phh/` holds the PHH interchange spec rather
than a room.

Alongside that sit the two original corpora the project started from —
`weplay-hh/` (104 real WePlay exports, across two account folders) and
`gg-hh/` (10 reference files in the GG format, used as the byte-exactness
target for what the serializer must produce) — plus
`tests/test/fixtures/`, whose `gg/` and `weplay/` hold regression cases that
each exist because a specific real hand broke something. 556 files in all.

**The one known, labelled exception** is `tests/test/fixtures/stats/`: 17
deliberately minimal hand-written hands in standard text, one per hard
statistics definition (a walk, a straddle open that is not a 3-bet, a
squeeze, a donk bet removing the c-bet spot, ...), pinned counter by counter
by `tests/test/statsSpots.test.ts`, so a failure points at the definition
rather than at a parser. They are golden inputs too. Cases that cannot be
written honestly by hand (a bomb pot, a GG EV cashout, run-it-twice, a WePlay
straddle) are pinned against real corpus files instead
([`tests/README.md`](../tests/README.md)).

A caveat worth knowing before trusting a row in the matrix: the corpus is
cash-heavy and era-skewed. Only a few rooms have verified tournament samples,
and the legacy-network files are roughly 2012–2015, so partypoker and 888 are
verified *for that era*.

### `.gitattributes` — do not "tidy" this

```
fixtures/** -text -diff
gg-hh/** -text -diff
weplay-hh/** -text -diff
tests/test/fixtures/** -text -diff
```

Real exports ship with CRLF, bare CR, UTF-16LE and Windows-1252 bytes, and the
parsers exist precisely to survive that. Git's autocrlf normalisation (at least
one machine here has `core.autocrlf=input`) rewrites CRLF to LF *on commit*,
which silently turns a CRLF test case into an LF one while the working tree
still looks correct. Marking the fixture trees binary means the stored blob is
the original bytes. Removing these lines will corrupt the evidence the
byte-exactness tests depend on, and it will not be obvious that it happened.

Encoding is handled as a corpus-wide property rather than a per-site quirk: 22
of the 556 corpus files are not UTF-8 (14 UTF-16 LE, 8 Windows-1252), and you
cannot tell which from the site, the era or a `0x80` sniff
(`FORMAT-MATRIX.md` §5). The converter's `decodeSource`
(`web/src/components/converter/inputs.ts`) and the Rust core's
`rail_core::decode`, which ports it step for step, decide in this order: a
byte-order mark (UTF-8, UTF-16 LE or BE); without one, UTF-16 when NULs sit at
every other byte of the first KiB; else strict UTF-8, and on invalid bytes
Windows-1252 (or UTF-8 with replacement characters when Windows-1252 reads as
implausible); then binary is refused.

---

## The app

**Next.js 15, App Router**, in `web/src/app/`. The hand-rolled matcher that
used to live in `web/src/routes/` is gone — Next's file-system router
matches and `next.config.ts` redirects, and keeping a second answer to "what
does this path mean" alongside the framework's is how the two drift apart.

Every route under `web/src/app/` (which files implement each:
[`web/README.md`](../web/README.md#routes)). **Access**: *Public* needs no
account; *Account* needs a signed-in user - signed out, the page explains
itself and offers sign-in (only `/library` sends you to the converter
instead); *Pro `<feature>`* is
locked for a Free account once plans are enforced (enforcement is off today,
[`web/README.md`](../web/README.md#plans-and-the-pro-lock)). The database
enforces all of it; the page only says it first.

| Route | Access | What it is |
| --- | --- | --- |
| **Community** | | |
| `/` | Public | **The forum**: every board's threads, server-rendered as `anon` (the same HTML for every visitor; your own votes are an island). RSS at `/feed.xml`. The first ten pages are indexable. |
| `/f` | Public | Redirects (308) to `/`. |
| `/f/[board]` | Public | One board's threads; RSS at `/f/[board]/feed.xml`. |
| `/f/[board]/[publicId]/[[...slug]]` | Public | A thread. The id is the key; a stale board or slug redirects (308) to the canonical address. |
| `/submit` | Account | A new post (posting gates apply); `?hand=<published id>` attaches one of your published hands, which `create_post` re-checks is yours. |
| `/p/[publicId]` | Public | **A published hand**: a scrubbed copy its owner chose to make public (no raw text, table or hand number, and by default no opponent names). Server-rendered and, unlike `/h/`, indexable. |
| `/embed/p/[publicId]` | Public | A published hand as a bare replayer for an `<iframe>`; `noindex`. |
| `/u/[username]` | Public | A public profile (`profiles_public`); an old name redirects to the current one. |
| `/search` | Public | Full-text search over the forum (`?q=`); `noindex`. |
| `/saved` | Account | Your bookmarked posts. |
| `/notifications` | Account | Your notifications. |
| `/mod` | Moderators | The moderation queue; every action is gated per caller by the RPCs. |
| `/takedown` | Public | How a room or a player asks for a hand to be taken down (the `hh-takedown` report reason and the mod queue). |
| **Converting and your hands** | | |
| `/convert` | Public | **Converter.** Drop files, a folder, a zip, or paste text — at desktop scale (R4.2: a folder of tens of thousands of files, a zip of hundreds of MB). Reading, unzipping, detection and conversion run in a Web Worker and start immediately — the intent of dropping a hand history on a hand-history converter is not ambiguous, and there is a cancel button. Converted hands are saved to the library while they convert (toggleable; chunked, retried, resumable), refused hands go to the corpus, the original files only on an explicit opt-in, and the output is downloadable per file or combined (up to 20 000 hands per drop). **This route makes zero server requests** unless you save; see below. |
| `/convert/manual` | Public | **Manual hand entry**: build a hand action by action; kept in this browser until finished, it leaves the tab only on an explicit save (which needs an account). |
| `/library` | Account | **Library and replayer** - the shared Hands screen (R4.5b, the desktop app's): your hands newest first (or by pot, result, oldest), a virtualised list that pages as you scroll, filters as chips with how many hands each would match (date, room, stakes, position, pot type, result, stack depth, all-in, game, variant, limit, table size), the searches (hero cards or a hand class, board cards, a player at the table, a part of the table's name, a minimum pot), showdown, showdown and winning positions, and what the room's names are; the hand you pick opens beside the list (above it on a phone). A hand the converter hands over opens above the screen, with a save button. Animated table: pot per street, bets in front of each seat, all-in state, dealer button, run-it-twice boards, final pot distribution. Play/pause, step, scrub, jump to a street, 0.5×–4× speed, reveal all known cards. Keyboard: `←`/`→` step, `space` play/pause, `Home`/`End`. With no library and no hand handed over, the address redirects to `/convert`. |
| `/stats` | Account; the situation breakdowns, sessions and opponents Pro `reports_full` | **Statistics.** The shared Reports screen (R4.5c, the desktop app's): the filter chips (date, room, stakes, position, game, variant, limit, table), the summary, the win-rate graph (total, showdown, non-showdown, all-in EV; big blinds or money), every statistic by group and the breakdowns (position, pot type, stack, starting hands' 13 x 13 grid, players, street, stakes, table size, room, game), with the web's own HUD tiles, sessions and opponents over the same filter. Read from the report summaries (`20270707090000`). Renders and explains itself when signed out rather than bouncing you somewhere else. |
| `/players` | Account; Pro `reports_full` | **Players** - the shared Players screen (R4.5c, the desktop app's), under the Statistics tab (a "Statistics / Players" switch on both pages, not a seventh tab in the bar): the opponents of your hands from rooms that show screen names, most hands together first, searched by the start of a name, by room, game and "with a note"; beside the list (above it on a phone) one opponent's profile - hands together, first and last seen, your result against them per kind, their statistics, their rows by position, stake, table size and game, your private note (`player_notes`; tags written in the opponents panel are kept), and "hands with this player", which opens `/library` filtered to their room and name (handed over in `sessionStorage`, never in the address). Opponents exist only while opponent statistics are on in this browser: off, the page says what they cost and turns them on. Colour tags and labels are the desktop app's and are not shown. Read from `players_list` / `player_profile` (`20270714090000`). |
| `/h/:slug` | Public (capability URL) | **A shared hand.** A capability URL to one hand, server-rendered, with real per-request Open Graph tags from `generateMetadata`. `noindex, follow` — a capability URL in a search index is a contradiction. **Names hidden by default** (R4.5): Hero, Villain1, Villain2… and no table, room hand number or time, unless the link's owner ticks "Show the players' names" (in the share dialog or on the page); `/embed/h/:slug` follows the same setting. See "Share links and names" below. |
| `/embed/h/:slug` | Public (capability URL) | The same share as a bare replayer for an `<iframe>`; never indexed; names follow the link's setting. |
| **Analysis** | | |
| `/analysis` | Account; Pro `analysis` | **Analysis** (`docs/ANALYSIS-PLAN.md`). Every hero decision in your library with its facts — board texture, hand class and draws, pot odds, MDF, SPR, blockers — the heuristic checks that hold whatever the strategy, and a grade where Rail has a reference: preflop against its charts, turn and river in heads-up pots against its own solver, multiway calls and folds facing a bet approximately, a tournament's push or fold by ICM (R5.5). The analysis runs in the browser. Under the grades, the **three biggest leaks** card (R5.2): the leak finder's (`/analysis/leaks`) three most important leaks - EV lost in total, the leaks the sample can vouch for first (20 decisions in the spot and 2 mistakes), a thinner one only to fill a place and marked tentative - each in words, with EV lost per 100 hands and its 95% range, EV lost in all, how often (mistakes in the spot, with the interval) and the confidence, the target (the reference's best move; your actions and the reference's for the hands you held), the last 30 days of play against the 30 before, up to five example hands opening at the decision (Back returns to the overview) and a link to its row in the leak report. The last 30 days of play (counted back from the last day played) or all time; the overview's format, seat and pot type apply. Reads `analysis_top_leaks` and `analysis_leak_examples` over leak sums kept by triggers on `decision_analysis` (`20270728090000`); no AI-written summary. |
| `/analysis/h/[handId]` | Account; Pro `analysis` | One hand in the replayer with the Analysis sheet (and the ICM panel for a tournament decision). |
| `/analysis/session` | Account; Pro `analysis` | **Session review** (R5.1). After a session, the hands worth a look: the worst graded decisions (Inaccurate or worse, worst first, with the EV they cost), the preflop decisions off the charts the analysis grades by, and the biggest pots in big blinds - each hand once, in the first list it is in, with badges for the others - under a summary (when, hands, length, tables, result in money and big blinds, bb/100, all-in EV). Opens on the latest session that has **ended** (a break longer than 30 minutes; a session that may still be going on is named, and reviewed only on request); a picker of the last 90 days and Previous / Next walk to others, and every row of Statistics -> Sessions links here. A hand opens in its analysis at the decision listed, with a way back. Reads `session_review` (`20270721090000`); the screen is the shared package's (`packages/ui/review/`). |
| `/analysis/leaks` | Account; Pro `analysis` | **Leaks**: the spots that cost the most EV, ranked. |
| `/analysis/reports` | Account; Pro `analysis` | Your frequencies against the reference. |
| `/analysis/progress` | Account; Pro `analysis` | Score and EV lost over time. |
| `/analysis/train` | Account; Pro `analysis` | **The trainer**: preflop and river spots, drills of your own mistakes. |
| `/analysis/plan` | Account; Pro `analysis` | **The study plan**: this week's focus from the leak finder, with a checklist. |
| `/analysis/my-charts` | Account; Pro `analysis` | **Your preflop charts** (R5.3). Chart sets of your own, private to your account: build one situation by situation (open, facing limpers, an open, an open and a call, a raise over your limp, a 3-bet, a 4-bet, a 5-bet - by seat and opponent, the shipped charts' vocabulary) on a 13 x 13 grid painted with a brush mix of raise / call / all-in percents (click, drag - a finger too - or the keyboard; under the grid the rank list's 44 px buttons are the phone's touch path), copy another situation, start from Rail's own chart at a depth, paste ranges as other tools write them (`AKs:0.5`, `[50]…[/50]`, `AhKh:0.25`, one hand per line) or copy them out, undo; import and download a whole set as Rail JSON. **Compare** it with your hands over 30 / 90 / 365 days or all time: how many preflop decisions it covers, the share played as the chart plays them (an action it takes at least 3.5 % of the time), the situations it leaves empty (with "Fill it in"), per situation your mix against the chart's for the hands you held and the deviations - hand, action, how often - each with its example hands opening at the decision (Back returns to the chart), and what they cost by Rail's charts' EVs. The session review can read its "off your preflop charts" list against one of these instead of Rail's. Data: `preflop_chart_sets` (direct, owner-only RLS) and `preflop_chart_played` / `preflop_chart_examples` (`20270811090000`, `20270811100000`); the screens are the shared package's (`packages/ui/charts/`). |
| `/analysis/charts` | Public, indexable | Rail's preflop chart browser ([`docs/CHARTS.md`](CHARTS.md)). |
| `/analysis/learn`, `/analysis/learn/[concept]` | Public, indexable | The concept library. |
| **Learn** ([`docs/LEARN-PLAN.md`](LEARN-PLAN.md)) | | |
| `/learn` | Public | The course map, how Rail teaches, and the reference pages. Progress is the account's when signed in (recording it is Pro `learn`), this browser's otherwise. |
| `/learn/[lesson]` | Public | One lesson: sections, checkpoints, practice graded by Rail's engine. |
| `/learn/placement` | Public | The placement test: a module passed marks its lessons "tested out"; `noindex`. |
| `/learn/review` | Public | The review queue of missed quiz items and the daily dose; `noindex`. |
| `/learn/reference/[page]` | Public | One reference page; `/learn/reference` itself redirects to `/learn`. |
| **Account, billing and legal** | | |
| `/settings` | Account | Language, username, posting, the plan (`#plan`), password, your data (export) and account deletion (R6.5). |
| `/billing/success`, `/billing/cancel` | Account | Where Stripe Checkout returns (R6.3). They grant nothing - the webhook does - and the success page waits for the plan to show it. |
| `/terms`, `/privacy` | Public | **The terms of use and the privacy policy** (R6.5): `docs/legal/*.md` in the reader's language, **drafts - not yet in force, pending the owner's and legal review** - and the page says so above the text; `noindex`. Linked from the footer of every page, with `/takedown`. |
| `/auth/callback` | Public (route handler) | The one address every sign-in returns to. Exchanges `?code=` for a cookie session; `?next=` is validated against a fixed allow-list of relative paths. |
| `/auth/desktop` | Sign-in on the page | The desktop app signs in through this browser (R1.7): sign in here if needed, confirm, and the page hands the app an encrypted one-time sign-in through a `rail://` link. |
| **Machine-facing** | | |
| `/api/oembed` | Public | oEmbed for this site's own `/p/` and `/h/` links only; never fetches the given URL. |
| `/api/stats/rebuild` | Account | Derives statistics for the caller's hands that have none at the current `stats_version`, as the user (security-invoker RPCs, RLS). |
| `/og/p/[publicId]`, `/og/post/[publicId]` | Public | Open Graph images for a published hand and a forum thread. |
| `/icons/[size]`, `/manifest.webmanifest`, `/sitemap.xml`, `/robots.txt`, `/apple-icon` | Public | The PWA's icons and manifest, the sitemap (public, stable pages only) and robots (`/h/` and the private screens disallowed). |
| `/sites.json`, `/sw.js` | Public (static) | The room list the desktop app keeps current from (R3.10; copied from `config/sites.json` at build) and the service worker that keeps the converter working offline. |

Permanent (308) redirects, in `next.config.ts`, for every address these screens
used to have: `/upload` and `/converter` → `/convert`; `/replay`, `/replayer`
and `/hands` → `/library`; `/statistics` and `/graph` → `/stats`. `/` is
deliberately not redirected — it is the forum now.

### The converter makes no server requests

A file dropped on `/convert` is read, decoded, detected, parsed and serialized
entirely in the tab, and handed back as a `Blob` download. **Hand histories
never leave the browser.** The only traffic the page can generate is the app's
own JavaScript, the conversion core's `.wasm` (a static file of the same
origin, below) and an explicit, opt-in save to your own library when you are
signed in.

That is a promise the code has to keep, so it is written down three times: as a
standing comment in `web/src/app/convert/page.tsx`, as a line of UI copy on
the page itself (so a change that breaks it also makes the app tell a visible
lie), and here. It is verified by driving the real page with a browser and
asserting that no request leaves the origin; `tests/test/wasmWeb.test.ts` also
checks that loading the core requests nothing but its own `.wasm`.

The save is the only exception, and only when you are signed in with "Save
to my library" on: converted hands go to your library, as PHF without the
original text. The original files themselves go only when you also tick
**"Also keep the original files"** — off by default, on each visit — and then
compressed, into your private folder of the `hand-uploads` bucket (A2).
While such a save runs, its progress (a state and counts, nothing of a hand
or a file name) is published to your account's private Realtime channel so
your other tabs can show it (R4.3, below).

### Bulk upload (R4.2)

A drop of any size converts and saves without holding the drop in the tab:

- **Streaming reads.** The worker gets the dropped `File` handles and reads
  one file at a time; a zip is read through `Blob.slice()` — its directory,
  then one entry at a time inflated by the browser's own
  `DecompressionStream` (`converter/zipStream.ts`, no library; zip64
  supported, encrypted entries and methods other than stored / deflate
  refused per entry). A single file or entry over 100 MB is refused; an
  archive has no limit. Folders and archives skip screenshots, OS debris and
  other obvious non-hand-histories silently (counted under the results).
- **Saving as it converts** (`converter/bulkSaver.ts`). Signed in with saving
  on, batches go to a bounded queue (1 500 hands) and are sent in calls of
  ≤ 250 hands / 3 MB to `ingest_hands` from the account's web source; the
  worker is held back while the queue is full, so a slow network slows the
  conversion instead of filling memory. Transient failures retry with
  exponential backoff (6 attempts, then the upload pauses with a "Try
  again"); a spent 10-minute budget waits; a spent daily budget or an ended
  session pauses. Re-uploading the same files inserts nothing: the server
  dedupes and the page says "already in your library".
- **Resume.** The page cannot reopen your files after a reload, so an
  interrupted upload (tab closed, network gone, daily budget) resumes when you
  **drop the same files or folder again**: a record in IndexedDB
  (`converter/uploadManifest.ts`; paths, sizes and CRCs, never hand text)
  says which files — and which batches of a half-saved file — are stored, and
  those are skipped without being read. The page offers it when it opens
  ("An upload from … did not finish …").
- **What the tab keeps.** The first 20 000 hands (and 2 000 refused ones) for
  the list, previews and downloads; past that the counts keep growing and the
  downloads are off for that drop. The file list shows its first 200 rows. A
  guest's drop that is too big to hold until sign-in says so: sign in, then
  drop it again.
- **The same rows as the app** (R4.4). A hand uploaded here and the same hand
  synced by the desktop app are stored identically (every column, the PHF but
  its conversion time, the statistics) and render identically; `npm run
  parity` in `tests/` (CI job `parity`) checks it over the whole corpus against
  a local stack.

### Live progress and arrival (R1.10, R4.3)

Signed in, the library's screens follow the account live, through Supabase
Realtime; signed out, or on `/convert` while not saving, no socket is opened.

- **Hands arriving** from the desktop app or another tab: the account's
  `hand_arrivals` row (one change per save call, whatever its size;
  `components/live/useHandArrivals.ts`), coalesced by `lib/live/arrivals.ts`
  - a refresh 1.5 s after a burst goes quiet, at most every 5 s backing off
  to 30 s while one never does, nothing while the tab is hidden, one resync
  after a reconnect. `/library` reads its first page again and puts the
  hands newer than its top row on top, so the rows in view do not move, and
  counts its chips again (R4.5b; until then: in place at the top, otherwise
  "N new hands - show"); `/stats`
  re-reads and derives statistics for the new hands; the analysis screens
  (`AppFrame live="notify"`) are left alone and offer "N new hands arrived -
  refresh".
- **An upload in another tab or device** (R4.3): the uploading tab publishes
  its state and counts - never a hand or a file name - as Presence on the
  account's private channel `activity:<uid>` (`components/live/
  activityChannel.ts`, `useUploadPresence`), at most every 2 s; every live
  screen shows "Saving 120 000 of ~1 000 000 hands from a web upload" with a
  bar, then "finished" for 20 s. The total is estimated from the bytes read
  until conversion ends. A closed tab's entry leaves with its socket; one
  that stops changing for 45 s is dropped. Only the account itself can join
  the channel (`realtime.messages` policies, `docs/DATABASE.md`).
- **The desktop app syncing**: "Desktop app syncing: 12 500 hands so far",
  counted from the arrivals of desktop origin, gone after two quiet minutes
  (on `/library`, the line under the heading names the device instead).
- **Accessibility**: the strip's counts are not a live region (they tick);
  a visually hidden polite region announces only beginnings and ends - an
  upload started elsewhere, finished, the desktop app syncing, new hands to
  show.

### Phones (R4.5d)

The library, `/stats` (with its opponents panel), a shared hand, its embed
and the replayer work at 375 px on a touch phone, in both languages: no
sideways page scroll (a wide table scrolls inside its own box), every
control at least 44 px, fields at 16 px so the page does not zoom. The touch
sizes are `@media (pointer: coarse)` rules (`packages/ui/styles/controls.css`
for `.btn`, `.chip-btn`, `.btn--icon` and fields; a few components' own), so
a mouse or a trackpad sees the old sizes. The one exception is the
starting-hand grid on `/stats` (169 cells, 22 px each on a phone; every
class is a row of the table under it). Since R4.5c the check also opens
every breakdown tab of `/stats` and each of its filter panels, and `/players`
(the opt-in, the list, a player open, each of the profile's tabs).
`packages/ui/screens/responsive.mjs`
checks it against a local stack (it signs in with a test account and
refuses any other host):

    cd packages/ui/screens && npm ci && npx playwright install chromium
    RAIL_CHECK_EMAIL=... RAIL_CHECK_PASSWORD=... RAIL_CHECK_SHARE=<slug> \
      node responsive.mjs http://localhost:<port>

### The conversion core is WebAssembly (R4.1)

Detection and parsing run in the Rust core (`core/rail-core`), built for the
browser as `rail-core-wasm` and committed at `web/src/lib/wasm/rail-core/`
(`.wasm`, wasm-bindgen's JS glue and declarations, `BUILD.json`). Vercel has no
Rust, so the web ships that copy.

**The committed copy is CI's Linux x86_64 build, never a local one.** The
linker lays the module out differently on macOS (same code and data, merged
and ordered another way), so a Mac build cannot match it. CI's `wasm` job
builds the package, uploads it as the artefact `rail-core-web` and fails when
the committed copy differs. After a change to the core: push, let that check
fail, then in `tests/` run `npm run wasm:web-from-ci` (it downloads this
commit's artefact with `gh` and installs it, BUILD.json included) and commit
`web/src/lib/wasm/rail-core/`. `npm run wasm:web` writes a local build
only on Linux x86_64 and refuses elsewhere; `npm run wasm:web-check` off Linux
only checks that the copy matches its BUILD.json.

The bundler emits the `.wasm` as
`/_next/static/media/rail_core_wasm_bg.<hash>.wasm`, served as
`application/wasm` with a one-year immutable cache. `lib/wasm/engine.ts` picks
the engine once per page or worker: the core, or - when it cannot be fetched or
instantiated - the TypeScript parsers in `lib/parsers/`, with one console
warning; the user still converts. The TypeScript parsers also remain the
oracle CI checks the core against, until the plan's R4.1 deletion step.

The table, cards and chips are generated as CSS and SVG inside the app. No
image assets, so nothing to license, nothing to load at runtime, and it stays
sharp at any resolution.

**Without a database** the app still converts, previews, downloads and replays
an uploaded hand. The library and sharing are disabled and the UI says so
explicitly rather than failing silently.

---

## Running it

```bash
cd web
npm install
cp .env.example .env.local   # then fill in the Supabase URL and anon key
npm run dev
```

Default: `http://localhost:3000`.

`npm run dev` uses Turbopack. It is verified — including that it handles the
`new Worker(new URL(…, import.meta.url))` in `conversionClient.ts`, which was
the one genuine unknown of the migration — and the full 7.9 MB corpus converts
to byte-identical output under it. `npm run dev:webpack` is the escape hatch if
that ever stops being true.

`.env.local` is optional — see the paragraph above for what you lose without
it.

## Tests

```bash
cd tests
npm test
```

**121 test files, over 4 700 tests** (CI, 2026-10-27). `tests/` is a test
harness with no runtime of its own — it exercises the web's libraries
directly against the real corpus ([`tests/README.md`](../tests/README.md)
maps the suite). Nothing is asserted against a hand somebody made up, except
the 17 labelled statistics spot hands described under "The corpus" above.

What they actually check, per hand, over every sample file:

- **Detection** — the right parser ranks first for every file in the corpus.
- **No unknown lines** — a hand a parser claims to understand parses with
  `meta.warnings === []`, so an unhandled line shape fails the build rather
  than reaching a user.
- **Validation** — every emitted hand satisfies the PHF invariants; every
  refused hand carries a machine-readable reason.
- **Round trip** — `parseStandardText(toStandardText(h))` is semantically equal
  to `h`.
- **Byte compatibility** — the re-serialized text is byte-identical to the
  source, which is what tracker import depends on.
- **Positions** — resolved positions are cross-checked against the rooms' own
  `(button)` / `(small blind)` summary labels, at every table size from
  heads-up to nine-handed.
- **Replay** — no stack goes negative at any point, and the whole pot is
  awarded in the final frame.

## Adding a poker room

1. Write `web/src/lib/parsers/<site>.ts` exporting a `SiteParser`.
2. Add one `registerParser` call in `web/src/lib/parsers/index.ts`.
3. Put real sample files in `fixtures/samples/<site>/` with a `SOURCES.md`, and
   add the site to `tests/test/support/corpus.ts` so the table-driven tests
   pick it up.

Nothing else changes: detection, validation, failure recording, the text
serializer, the replayer and the database layer all work off `PhfHand`.

The contract, an annotated skeleton, the two strategies for building a hand
(normalise-to-standard-text vs. build-the-object-directly), and the six tests a
new parser must come with are in
[`docs/PHF-SPEC.md` §8](PHF-SPEC.md). Read §1 and §2 first — the money
rules are where a new parser is most likely to go quietly wrong.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `web/src/lib/phf/` | The format: `types.ts` (re-exports the types generated from the Rust model), `validate.ts`, `serialize.ts`, `detect.ts` |
| `web/src/lib/parsers/` | One file per poker room, plus `shared/` helpers and the registry |
| `web/src/lib/db/` | Supabase client layer — save, search, corpus, shares, anonymization |
| `web/src/lib/replay.ts` | PHF → replay frames |
| `web/src/lib/solver/` | Postflop solver (DCFR, heads-up river and turn). Pure TS, also runs in a Web Worker; benchmark: `cd tests && npm run bench:solver` |
| `web/src/lib/supabase/` | `config`, `browser`, `server`, `middleware` — the only modules that construct a Supabase client |
| `web/src/lib/server/` | Server-only readers. `server-only` imported, never reachable from the browser bundle |
| `web/src/lib/i18n/` | `en.ts`. Every user-facing string on the App Router surfaces |
| `web/src/lib/routes.ts` | `paths` and `sharedHandUrl`. What survived the old route table |
| `web/src/app/` | The App Router: pages, layout, `sitemap.ts`, `robots.ts`, `auth/callback` |
| `web/src/components/` | `converter/`, `share/`, `shell/`, `stats/`, `auth/` and the other screens. The replayer, cards, overlay, icons and the stat tile moved to `packages/ui` (R2.6) |
| `web/src/styles/` | ~3800 lines of global CSS. The token layer, the replayer's and the cards' sheets and the base controls moved to `packages/ui` (R2.6). New components use CSS Modules |
| `packages/ui/` | The shared UI package `@rail/ui`, linked as `file:../packages/ui` — see "Shared UI package" below |
| `web/src/lib/wasm/` | The WebAssembly core: the committed build (`rail-core/`), its loader and the engine choice (R4.1) |
| `web/src/workers/` | Conversion off the main thread |
| `tests/` | Test harness only — no runtime backend |
| `supabase/migrations/` | Schema |
| `fixtures/samples/` | The real hand-history corpus, one directory per site |
| `gg-hh/`, `weplay-hh/` | The original reference and source corpora the project started from |
| `docs/` | `PHF-SPEC.md`, `DATABASE.md`, and `research/` |

---

## Rules that are load-bearing

Four conventions here are not style preferences. Each one has a lint rule
behind it, and each one was written down because breaking it is cheap, silent,
and expensive to undo.

### 1. The pure-TypeScript layer may not import the framework

**Nothing under `web/src/lib/{phf,parsers,replay,cards,format,stats}` may
import `next/*`, `server-only`, or read `process.env`.**

`tests/test/*.ts` imports those modules directly, by relative path —
`../../web/src/lib/phf/serialize.js` and a dozen more — under plain Node
with no bundler and no framework. **3114 tests across 435 fixtures hang off
that.** A single framework import anywhere in that subtree breaks all of them at
once, and the failure reads as an unrelated module-resolution error rather than
as "somebody put a Next import in the parser layer".

It is also why the web kept its own folder (`frontend/` until R0.14, `web/` since) and why
`web/src/lib/**` did not move when the App Router arrived. The App Router
lives at `web/src/app/`, which Next resolves natively, precisely so that
`lib/` could stay exactly where the test harness expects it.

Anything Next-shaped goes in `lib/supabase/`, `lib/server/` or `app/`.
`lib/routes.ts` and `lib/i18n/` are deliberately outside the rule: they are app
configuration, not corpus code, and nothing in `tests/test` imports them.

Enforced by `no-restricted-imports` and `no-restricted-properties` in
`web/eslint.config.js`, scoped to exactly those paths.

### 2. The CSS is an asset, not debt

~4400 lines of global CSS, imported in a **pinned order** from
`web/src/app/layout.tsx`. That order is load-bearing and is documented in
the file: `theme-light.css` overrides `:root` at the same specificity and only
wins by arriving later, and `styles/app.css` has to come last because its
`.btn` / `.card` families are the base the component sheets override. Sheets
that belong to one screen (`converter.css`, `stats.css`, `upload.css`, the
package's `overlay.css` and stat-tile sheet) stay imported from their
components so Next code-splits them.

Since R2.6 part of that CSS lives in the shared UI package, **in the same
cascade position**: `index.css` imports the four token files from
`@rail/ui/tokens/`, and `styles/app.css` imports, in this order, the package's
`cards/cards.css` and `replayer/replayer.css`, the web's `styles/layout.css`
(the block that used to open `app.css`) and the package's
`styles/controls.css` (`.muted`, `.btn`, `.icon`, `.chip-btn`, which used to
follow it), then its own rules. Same rules, same order: R2.6's comparison
found every captured page's cascade unchanged, apart from the stat tile's own
rules, which now load with the tile (`StatTile` imports them; nothing else
targets those elements). Moving a sheet between the web and the package is a
move of `@import` lines, never a reordering.

**New components use CSS Modules. Not Tailwind.** Rewriting every component
mid-migration is how the replayer's container-query layout — genuinely hard CSS,
tuned against real screenshots — gets quietly lost, and the rebrand arrives as
token changes, for which custom properties are the cheapest interface.

The design tokens each declare their own `@layer tokens` block. They used to be
put in that layer by the importer (`@import "..." layer(tokens)`), which does
**not** survive the Next build: css-loader emits the layer condition in the
media slot, producing `@media layer(tokens){…}`, which is not a valid media
query and which every browser therefore drops. The symptom is an app that
builds and lints cleanly and renders as unstyled HTML. Do not reintroduce that
form.

`stylelint.config.js` still enforces the two rules that matter: no primitive
tokens and no raw hex in `src/`. The token layer itself (where hex is the
point) and the deliberately unthemed felt, cards and chips are the package's
now (`packages/ui/tokens/`, `replayer.css`, `cards.css`), and
`packages/ui/stylelint.config.js` holds them to the same two rules.

### 3. User-facing strings go through `lib/i18n/en.ts`

(The shared UI package's components hold no copy: they read their words from
`UiStringsProvider`, which `lib/i18n/client.tsx` mounts with slices of these
same dictionaries — `lib/i18n/ui.ts`. The replayer's two dictionaries are
data in the package since R2.7a, `packages/ui/strings/replayer.{en,hr}.ts`,
which `ns/replayer.{en,hr}.ts` re-export into `en.ts` and `hr.ts` as before,
so the desktop app shows the same words. See "Shared UI package".)

The product is English-only and Croatian is coming. The difference between "add
a locale" and "refactor every component" is decided now, not then.

Enforced by a `no-restricted-syntax` rule on **`src/app/**`** — bare JSX text
and bare `alt` / `title` / `placeholder` / `aria-label` attributes are errors
there. The scope is a stated limit, not an oversight: the pre-existing
components under `src/components/**` still carry several hundred inline strings,
and hauling them through `en.ts` during a framework migration is how a sentence
that explains a refusal reason loses a comma. What the scoping buys is that the
pile **cannot grow** — new UI lands in `src/app/**`, and a new file there cannot
ship a bare literal.

### 4. The shared UI package stays shareable

`packages/ui` (`@rail/ui`) renders in this Next.js app and in the desktop app's
Tauri webview, so `packages/ui/eslint.config.js` forbids `next/*`,
`@supabase/*`, `@tauri-apps/*` and `server-only` there, forbids user-facing
literals in its components, and lets it reach outside itself only through
`packages/ui/model/` — which re-exports this app's framework-free library
(`lib/phf/types`, `lib/replay`, `lib/cards`, the `lib/stats` display types).
That last edge is why rule 1 matters twice now: a framework import in
`lib/{phf,replay,cards,stats}` would break the desktop app's bundle as well as
the test harness.

---

## Shared UI package

`packages/ui/` is the design system both surfaces render (guideline §6, "the
same design system and components in the app and on the web"; amendment A3:
CSS Modules and the existing token layer, no Tailwind). R2.6 moved it out of
this app with no visual change.

| Path | What it is | Styles |
| --- | --- | --- |
| `tokens/` | `primitives`, `semantic`, `theme-light`, `motion` — the one token layer; each file declares its own `@layer tokens`. `density` (R2.8): comfortable / compact sizes under `[data-density]`, imported by the desktop app only (shared components read them with their old value as the fallback); `semantic`'s `--felt-money` (R2.8) is the felt's unthemed money gold, which the app uses in its light theme and the web does not yet | — |
| `styles/controls.css` | `.muted`, the `.btn` family, `.icon`, `.chip-btn` | global (BEM) |
| `cards/PlayingCard.tsx` | `PlayingCard`, `CardRow`, the suit glyphs | `cards/cards.css`, global |
| `chips/` | `Chip` (one `.chip-btn`, toggle or action), `FilterChips` (a filter as one row of chips) | `.chip-btn`; `FilterChips.module.css` |
| `replayer/` | The replayer: `ReplayViewer`, table, seats, bets, pot, board, controls, sheets; `position.ts`, `potOdds.ts`, `seatLayout.ts` | `replayer/replayer.css`, global — the container-query layout, unchanged |
| `overlay/Overlay.tsx`, `icon/Icon.tsx` | The modal / non-modal `<dialog>` overlay the replayer's sheets use; the stroke icon set | `overlay/overlay.css`, global |
| `dialog/Dialog.tsx` | The desktop app's modal `<dialog>` | CSS Module |
| `review/` | The session review (R5.1; rendered by the web at `/analysis/session` and by the desktop app's Analysis screen since R5.4b): `SessionReviewScreen` (the picker, Previous / Next, the summary, the three lists; `hiddenDuringPlay` for A10) and the pure `SessionReviewView`, `select.ts` (each list ranked, a hand shown once in the first list it is in - worst decisions, then chart deviations, then pots - with badges for the others, each list filled to its cap), `model.ts` (`SessionReviewSource` - what a surface implements - and `DeviationSource`: where "off your preflop charts" comes from, the shipped charts, or the user's own since R5.3b) | CSS Module |
| `charts/` | The user's own preflop charts (R5.3; rendered by the web at `/analysis/my-charts` and by the desktop app's Analysis screen since R5.4b): `model.ts` (classes, the situation keys and which a table can have, the stored shape - whole percents as base64 of 169 bytes per action - and its checks), `nodeKey.ts` (a shipped chart line as a situation; the database's `preflop_chart_node_key` is held to it), `ranges.ts` (range text in and out: shorthand, weights, GTO+ brackets, combos, lists), `exchange.ts` (Rail JSON, a situation's text), `compare.ts` (the comparison, pure), `sessionSource.ts` (`ownChartDeviations`: the session review's second `DeviationSource`), `source.ts` (`PreflopChartsSource`: what a surface implements); `ChartsScreen` (the list, import, a set's Edit / Compare tabs, save / download / delete), `ChartEditor`, `ChartGrid` (the painted grid and the rank list), `ChartCompare` | CSS Module |
| `reports/` | The Reports screen (R4.5c, moved from the desktop app): `ReportsScreen` (title and count, the filter row with the groups a report sums by, the summary, the graph's card with its unit toggle, the statistics by group, the breakdowns; two slots for a surface's own panels), `Breakdown` (the tabs, the table, `GroupTable` - the app's player profile and HUD popup use it too), `HandMatrix` (the 13 x 13 grid), `useReport`, `definitions.ts` (`statRows`, `shownOf`), `model.ts` (`ReportSource` - what a surface implements - and the report, the breakdowns, `BREAKDOWN_COLUMNS`). Every value arrives as a `Shown`; it computes nothing | CSS Module |
| `hands/` | The Hands screen (R4.5b, moved from the desktop app): `HandsScreen` (title and count, the filter row, the list, the open hand's panel - the surface draws the panel), `HandList` (virtualised; a two-line card per row where the list is under 40rem wide), `FilterBar` / `Popover` / `SavedFilters` (the chip row; the desktop's Reports uses it with its own groups), `filter.ts` (the filter state, presets, saved form, `toQuery`), `format.ts`, `useHandList` (pages, counts, arrivals), `model.ts` (`HandsSource` - what a surface implements - and the rows and counts it returns) | CSS Modules |
| `stats/StatTile.tsx`, `stats/StatTable.tsx`, `stats/StatValue.tsx` | A statistic's tile (value, sample, interval band); a table of statistics; one value faded by its reliability with its sample and interval in the tooltip (R2.7b, the desktop's report cells). All show R2.4 definitions with their R2.5 reliability and compute nothing | `stats/stat-tile.css` (global); `StatTable.module.css` |
| `players/` | The Players screen (R4.5c, moved from the desktop app): `PlayersScreen` (title and count, the toolbar - search, game, room, colours and labels where the source keeps them, "with a note" - the notices, the list and the open player), `PlayerTable` (the virtualised grid), `PlayerProfile` (the facts, the result, the user's words - `PlayerWords`, which the app's HUD popup uses too -, the statistics, the breakdown), `model.ts` (`PlayersSource` with its `features`, and the list's and the profile's shapes). The open player, the notices, the empty text, the states and "hands with this player" are the surface's | CSS Module |
| `stats/WinrateGraph.tsx`, `stats/chartScale.ts` | The win-rate graph (R2.7b moved it from `components/stats/`): total, showdown, non-showdown and all-in EV over hands, hand-written SVG, its legend and table view; `unit="money"` (the desktop's) draws the same lines in the currency. `chartScale` is its axis arithmetic, which `TrendChart` shares | `stats/winrate-graph.css`, global (`.stats-chart*`, `.stats-legend*`, `.stats-key*`), imported by the component and by `TrendChart` |
| `palette/CommandPalette.tsx` | The command palette's shell: field, list in labelled groups, keys (↑/↓, Tab, Page Up/Down, Enter, Escape), matched letters marked, an item's shortcut and the footer's key hints, a live result count (R2.8). What it finds is the surface's | CSS Module |
| `palette/fuzzy.ts` | `fuzzyMatch` / `rankItems` (R2.8): the query's letters in order, case and diacritics ignored, word starts and prefixes first; for a surface to rank its own items | — |
| `i18n.tsx` | `UiStrings` (the words the components show) and `UiStringsProvider` | — |
| `strings/` | Data, not components (R2.7a): the replayer's dictionaries `replayer.en.ts` / `replayer.hr.ts` (`ReplayerStrings`) and the Croatian `plural` they use; this app's `lib/i18n/ns/replayer.{en,hr}.ts` and `lib/i18n/plural.ts` re-export them, so `en.ts` / `hr.ts` are unchanged; the desktop app hands them to its `UiStringsProvider`. `model/replayStrings.ts` brings the frames' English. Since R2.7b also `stats.en.ts` / `stats.hr.ts`: the stat tile's, the statistics table's and the win-rate graph's words (and `hands`, `handsHead`, `bb`, `sampleOnly`), which this app's `ns/stats.{en,hr}.ts` take block by block - the text unchanged. Since R4.5b `hands.en.ts` / `hands.hr.ts`, the Hands screen's words (the desktop's dictionary spreads them; this app hands them to the provider as they are); since R4.5c `reports.en.ts` / `reports.hr.ts`, the Reports screen's, and `players.en.ts` / `players.hr.ts`, the Players screen's, the same way; since R5.1 `review.en.ts` / `review.hr.ts`, the session review's (the app's `UiStrings` carries them too, unused until R5.4); since R5.3 `charts.en.ts` / `charts.hr.ts`, the user's charts' (likewise) | — |
| `data.tsx` | `DataSource` (where a component that fetches gets data), `DataSourceProvider`, `useHand` | — |
| `model/` | The one door out: re-exports of this app's pure library (PHF, replay frames, cards, statistics types) | — |

Global class names stay global where the web's markup and CSS already used
them (the replayer's ~1 800 tuned lines, the cards, the buttons): renaming them
to CSS Modules would be a rewrite, and a rewrite is how the pixel behaviour
gets lost. New components in the package use CSS Modules.

**How this app consumes it.** `package.json` has `"@rail/ui":
"file:../packages/ui"` (npm links it into `node_modules/@rail/ui`), imports
are by path — `@rail/ui/replayer/ReplayViewer`, `@rail/ui/tokens/semantic.css`
— and `next.config.ts` lists it in `transpilePackages`. React is this app's:
`tsconfig.json` maps `react` / `react-dom` types to `./node_modules` (the
package has none of its own at run time), and Next aliases React when it
bundles. `next dev --turbopack` serves files only under its root, so in
development the root is the repository (`next.config.ts`); `next build` keeps
its default root, this folder.

**Words.** `lib/i18n/ui.ts` cuts the package's `UiStrings` from this app's
dictionaries (`replayer`, `stats.tile`, `stats.table`, `stats.graph` with
three `stats.common` words, `chrome.closeNamed`), once per language, and
`I18nProvider` mounts them. A key the package needs and a dictionary lacks is
a type error there. The `replayer` and the statistics slices are the
package's own data (`packages/ui/strings/`, R2.7a and R2.7b), so the web and
the desktop app show one text; the test harness resolves `@rail/ui` to the
package by an alias in `tests/vitest.config.ts`, since the re-exports import
it by name.

**Styles that moved out of a sheet.** The graph's rules left
`styles/stats.css` for the package's `stats/winrate-graph.css` (R2.7b), as
the tile's left for `stat-tile.css` in R2.6: a sheet of their own, imported
by the component. `stats.css` stays one file. Splitting it into `@import`s
of its pieces was tried and rejected: each `@import`ed file becomes a CSS
module of its own, and `next build` placed them on either side of the
analysis pages' modules, so `.leaks_summary` came after `.stats-group` and
its gap won on `WhatChanged`'s card.

**Data.** `lib/db/dataSource.ts` implements `DataSource` over Supabase
(`hand(id)` = `getHand`), mounted by the library (R4.5b) for the open hand.
`lib/db/handsSource.ts` is the library's `HandsSource`: `library_page` (one
page, keyset after the last row, at most 500; newest first or by pot, result
or oldest) and `library_facets` (each filter group's values with the hands
each would match under the other groups, `total` and `library`), security
invoker under RLS (`20270630090000_library_list.sql`, pgTAP `library_list`),
reading the hands, the hero's `hand_stats` row and its `hand_stats_ev` row at
the client's `STATS_VERSION` / `EV_VERSION` (a hand whose statistics are not
derived yet lists, with no big blinds, pot type or stack). The filter groups
are the desktop store's, by the same rules (`rail_stats::segment` sizes and
stakes, `STACK_DEPTHS`); everything the old filter bar had is kept: the
searches (hero cards or class, board, a player), showdown, a part of the
table's name, the minimum pot (now in each hand's own unit: 25 is $25 at a
dollar table, 25 chips in a tournament), the showdown and winner positions
and the anonymity select ("Names", a counted group). The table, the pot and
the positions narrow the counts without counts of their own. The desktop
app's source declares none of these (`features.more`), so the shared screen
hides them there. The pager is gone (the list pages as it scrolls); it never
put a page or a filter in the address, so there are no old links to map.
Live arrivals reach the list through `notifyHandsChanged`. Both functions
plan every call (`plan_cache_mode = force_custom_plan`). At 200 000 hands on
the local stack a page takes 4-18 ms (a table name 0.22 s, a pot type
0.45 s) and the counts 0.9-1.15 s.

**Checks.** CI job "Shared UI package" runs the package's ESLint, stylelint
and `tsc`; this app's jobs typecheck and bundle it again under its settings,
and the desktop app's under its own (since R2.7a without
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, as here: the
package and the library behind `model/` were written without them).

**Changing it.** Edit `packages/ui` and both surfaces see it on their next
build or reload. After changing `packages/ui/package.json`, run `npm install`
in `web/` and `app/` so their lockfiles carry its manifest (npm ci does
not fail when they drift, which is why it has to be remembered).

---

## Database (Supabase)

Project `riybwcfnclphacnfawiq` (`poker converter`), Postgres 17. Baseline
migration: `supabase/migrations/20260916190000_phf_baseline.sql`. Client layer:
`web/src/lib/db/`. Nothing else in the app touches Supabase.

Every column, the RLS reasoning, which query each index serves, how to apply a
migration and how to triage the corpus are in
**[`docs/DATABASE.md`](DATABASE.md)**. The short version:

| Table | What it holds |
| --- | --- |
| `hands` | One successfully converted hand: the canonical `phf jsonb` document, the rendered `standard_text`, the original `source_text`, plus a denormalized column per searchable field (site, hero, position, cards, board, stakes, pot, profit, …). Unique on `hand_key`, so re-uploading a file is a no-op. |
| `unparsed_hands` | The **failure corpus**. Deduped by `fingerprint` with an occurrence counter and a triage `status`. |
| `unparsed_gaps` | View: the corpus rolled up by site / stage / reason, ordered by impact. |
| `shares` | Short-slug public links to one hand. Sealed from the client; reachable only through `create_share()` and the `read_share()` / `record_share_view()` pair. |

Money is stored as **integer minor units** everywhere, matching PHF.

### Anonymized rooms

Some rooms do not print persistent screen names, and the failure mode is
silent, so the schema models it explicitly. `hands.site_anonymization` says
what the names on a row are worth:

| Value | Meaning | Example |
| --- | --- | --- |
| `none` | Persistent screen names | PokerStars, WePlay |
| `positional` | Position labels that remap every hand | Ignition, Bodog, Bovada |
| `opaque-id` | Per-session tokens — hashes or numeric ids | GGPoker, data-mined ACR/WPN |

`positional` is the destructive one. Ignition writes `Dealer`, `Small Blind`,
`UTG+2` in place of names, and the button rotates, so "UTG+1" is a different
human every hand. Filtering `player_names = 'UTG+1'` over those rows would not
error — it would confidently return a different person from every row. So
those names are dropped before they reach the database, `player_names` and
`winners` are empty for such rows, and `hero_position` / `showdown_positions` /
`winner_positions` carry the identity instead. For those sites, position *is*
the identity.

Detection is per-hand and partly structural, not a hard-coded site list, so a
future anonymizing room gets labelled correctly the first time someone uploads
one. See `web/src/lib/db/anonymization.ts`.

### Accounts and RLS, briefly

The deployed bundle is public, so the anon key is public by construction —
anyone can read it out of the JavaScript and talk to PostgREST directly. Every
policy is therefore written for an untrusted caller, and the *only* thing that
separates two users' hands is the database, never the UI.

- Every row in `hands` has an `owner_id`. `select` and `insert` are policed by
  `owner_id = auth.uid()`, so there is no query a client can construct that
  returns somebody else's hand. `anon` has no grant on the table at all.
- `update` and `delete` are refused **everywhere**, for everyone, on every
  table. Counters that must move (share views, failure occurrences) do so
  inside `security definer` functions that can touch nothing else.
- `shares` has no grants and no policies. A slug is a capability URL, so
  `read_share()` is the only door and it is `security definer` — which is
  exactly why a share link works for a stranger with no account, and why
  `create_share()` has to check ownership explicitly rather than lean on RLS.
  `read_share` is `stable` and returns an explicit projection; the view counter
  lives in `record_share_view`, a separate `volatile` function, so a page can be
  rendered (and its unfurl tags generated) without counting a reader. The
  combined `resolve_share` is deprecated and removable on or after 2026-11-27.

### Share links and names (R4.5)

A share link hides the players' screen names unless its owner opted in, and
the database enforces it (`20270623090000_share_names.sql`):

- `shares.show_names` is `not null default false`, so every link made before
  R4.5 became anonymised - nothing earlier recorded a choice about names
  (`spoilers` is about the result).
- `read_share` (and the deprecated `resolve_share`) returns, for a hidden
  link, the hand through the forum's `scrub_phf(.., 'pseudonyms')` - Hero,
  Villain1..n in seat order; no raw lines, table name, tournament id, room
  hand number or exact time - **no** `standardText` (the room's dialect, with
  every name) and no `title`. If any original screen name still appears as a
  whole token anywhere in the scrubbed document, it returns no hand at all
  (`share_anonymised_phf`, the same last line of defence as `publish_hand`;
  positional rooms are not checked). Over the corpus's 8 367 hands it
  withholds none.
- The owner turns names on or off per link: `create_share(..., p_show_names)`,
  `share_names_state(slug)` / `set_share_names(slug, show)` (owner only; any
  other caller gets null / the "does not exist" error, anon nothing). The web
  shows the switch (`components/share/ShareNamesToggle.tsx`) in the share
  dialog once the link exists and on `/h/:slug` for its owner.
- The page, its metadata (`<title>`, `og:description` - which names the
  winner only with spoilers on, and then by pseudonym) and `/embed/h/:slug`
  render the payload's `phf` as it came (`lib/server/shares.ts` `shareHand`),
  like a published hand. A share's Open Graph image is the static
  `/og-default.png`; published hands (`/p/:id`, its OG image, the sitemap and
  the feed) were anonymised by `publish_hand` before R4.5.
- Tests: pgTAP `share_names` (40); `npm run share:names` (in `tests/`) checks
  the served pages end to end against a local stack and a local
  `next start`: six corpus hands (awkward names: slashes, a colon, mojibake),
  stored and never saved, page and embed, no name in the HTML, then names on
  and off.
- Dedupe is `(owner_id, hand_key)`, not `hand_key`. A global key would tell the
  second person to upload a hand "already stored" and then show them nothing,
  because the row they collided with is not theirs to read.
- `unparsed_hands` holds raw uploads, so a row is readable only by whoever
  submitted it. The corpus stays globally deduped — the occurrence counter is
  the whole point of the table — but reading across it is a service-role job.

Signing in uses Supabase Auth with **cookie sessions** (`@supabase/ssr`): email
+ password, or Google once the provider is configured in the dashboard. Every
sign-in returns to one address, `/auth/callback`, which exchanges the code
server-side; `?next=` there is validated against a fixed allow-list of relative
paths, because an open redirect on a page that has just minted a session is an
account-takeover vector rather than a phishing nuisance.

**The desktop app signs in through this site** (R1.7, `/auth/desktop`): the
app opens the page in the system browser with `?v=1&pub=..&state=..&t=..`
(a public key and a random state, not secrets); the page moves them into
`sessionStorage` and out of the address bar, has the user sign in as usual if
needed (so `/auth/desktop` is on the `?next=` allow-list, for a Google round
trip), asks "Sign in to the Rail app on this computer?", and on the click
calls the Edge Function `desktop-handoff` with the user's own access token.
What comes back is a one-time token encrypted to the app's key; the page
redirects to `rail://auth/callback` and marks the state used. Expired (the
app waits ten minutes; `t` is the same computer's clock), already used and
malformed requests each get their own message. Details and the threat model:
`docs/DATABASE.md`, "Desktop sign-in"; the page's code is
`app/auth/desktop/` and `lib/auth/desktop.ts`.

Server-side code resolves identity with **`getUser()`, never `getSession()`** —
`getSession()` decodes the cookie without verifying the JWT signature, which is
fine for a value this origin wrote into its own storage and wrong for input that
arrived over the wire. A **guest** is simply signed out: everything
client-side works, and nothing is stored, because there is no id to store it
under. The converter holds a finished run in memory and offers to save it after
sign-in, so the login never arrives before the value does (up to 20 000
hands; a bigger drop asks to be dropped again after signing in, R4.2).

### Applying migrations

**`supabase db push` does not work here** — the CLI cannot get a login role.
Use the Management API with the personal access token from the macOS keychain;
the exact commands and the verification queries (including how to confirm RLS
through the *anon* key rather than the PAT, which proves nothing) are in
[`docs/DATABASE.md`](DATABASE.md#applying-a-migration).

---

## Deployment (Vercel)

Production is **https://poker-hand-converter.vercel.app**. Every push to `main`
deploys.

- **Root directory**: `web` (`frontend` until R0.14). This is not cosmetic — see "The rule that
  keeps the test harness alive" below. Since R2.6 the build also needs one
  directory outside it, `packages/ui` (`file:../packages/ui` in
  `package.json`). Vercel clones the whole repository and, with the project
  setting **"Include files outside the root directory in the Build Step"**
  (Settings → Build and Deployment → Root Directory; on by default), gives the
  build all of it. If a deploy ever fails to find `@rail/ui` or
  `../packages/ui`, that setting is the first thing to check.
- **Framework preset**: Next.js (build `npm run build`, output `.next`).
  `web/vercel.json` pins `"framework": "nextjs"` so the project setting
  cannot silently disagree with the repository; it also keeps the
  `deploymentEnabled.staging: false` guard. Everything else that file used to
  carry — the SPA rewrite and the User-Agent fork for `/h/:slug` — is gone,
  because the framework renders on the server now.
- **Environment variables**, in all three environments:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_SITE_URL` (optional; defaults to the current `*.vercel.app` host)

Without those the deploy still works, as an offline converter.

> **These were renamed at the Next.js cutover** (`VITE_*` → `NEXT_PUBLIC_*`),
> because Vite inlined `import.meta.env.VITE_*` and Next inlines
> `process.env.NEXT_PUBLIC_*`. **Update the Vercel project settings before the
> first deploy**, or production ships as an offline converter — which it will
> say plainly in the UI, but which is still not what anyone wants.
>
> Two other one-time steps, both outside this repository:
>
> 1. Add `<NEXT_PUBLIC_SITE_URL>/auth/callback` to Supabase → Authentication →
>    URL Configuration → Redirect URLs, for every environment. The old list
>    covered `localhost:5173` / `:4173`, which were the Vite ports; `next dev`
>    serves on 3000, and the callback is now a single fixed address rather than
>    "whatever page you happened to be on".
> 2. Expect **every existing session to be signed out** on cutover: the token
>    moves from `localStorage["sb-<ref>-auth-token"]` to cookies.
>    `components/auth/SessionImport.tsx` carries one over on the user's next
>    visit and then deletes itself. That file has a deletion date in its header
>    — **2026-11-28** — and nothing else references it.

Manual deploy:

```bash
cd web
npx vercel deploy --prod
```

Vercel is the only way the frontend ships. An older path served the built
`dist/` out of a Supabase Storage bucket; it was deleted because SPA routes
404'd there and it was the one place in the repo that handled a service-role
key. The two migrations that created that bucket (`20260226123000`,
`20260308091000`) are still applied and are now inert — leave them alone rather
than writing a migration to undo history.

---

## Where to read next

| Question | Document |
| --- | --- |
| What is a hand, exactly? What are the invariants? | [`docs/PHF-SPEC.md`](PHF-SPEC.md) |
| How do I write a parser for a new room? | [`docs/PHF-SPEC.md` §8](PHF-SPEC.md) |
| What does column X mean? Why is the RLS like that? | [`docs/DATABASE.md`](DATABASE.md) |
| Where do the preflop reference charts come from? How do I regenerate them? | [`docs/CHARTS.md`](CHARTS.md) |
| What does room X's format look like? | `docs/research/hh-formats/<site>.md` |
| Which formats are alike? Which can share a parser? | [`docs/research/FORMAT-MATRIX.md`](research/FORMAT-MATRIX.md) |
| Which room should we support next, and what will it cost? | [`docs/research/COVERAGE-PLAN.md`](research/COVERAGE-PLAN.md) |
| Where did this sample file come from? | `fixtures/samples/<site>/SOURCES.md` |

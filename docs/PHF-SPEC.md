# PHF — Poker Hand Format, version `phf/1`

PHF is the canonical representation of a poker hand in this project. Every site
parser produces a `PhfHand`; every consumer — the replayer, the standard-text
serializer, the database row builder, the filters — reads a `PhfHand`.

The GG-style plain text this app produces is **one serialization of PHF**, not
the source of truth. It exists because Holdem Manager and PokerTracker import
it.

```
raw upload
   │
   ├─ detectSite(text)                  → ranked SiteParser candidates
   ├─ parser.splitHands(text)           → one chunk per hand
   ├─ parser.parseHand(chunk, ctx)      → PhfHand
   ├─ assignPositions(hand)             → BTN/SB/BB/... from the posted blinds
   ├─ validateHand(hand)                → errors / warnings
   │
   ├─ toStandardText(hand)              → GG-style text (tracker import, DB)
   ├─ buildReplay(hand)                 → replay frames (UI)
   └─ ConversionFailure[]               → stored for a future parser
```

> ### Read this before you use `position`
>
> **Heads-up, no seat is labelled `BTN`.** With two players the button *is* the
> small blind, so the ring is `["SB", "BB"]` and nothing carries `BTN`.
>
> `position === "BTN"` is **not** a button test and will silently miss every
> heads-up hand. To find the button, read `PhfTable.buttonSeat`:
>
> ```ts
> const isButton = player.seat === hand.table.buttonSeat;   // correct
> const isButton = player.position === "BTN";               // wrong heads-up
> ```
>
> `position` is also `null` for a seat that was not dealt in, and for every seat
> when the button is unknown. Treat it as optional. Full rules in §3.5.

Implementation:

| File | Contents |
| --- | --- |
| `frontend/src/lib/phf/types.ts` | the type system and the money / position helpers |
| `frontend/src/lib/phf/validate.ts` | the invariant checker |
| `frontend/src/lib/phf/serialize.ts` | `parseStandardText` / `toStandardText` |
| `frontend/src/lib/phf/detect.ts` | `SiteParser`, the registry, `convertAny` |
| `frontend/src/lib/parsers/*.ts` | one file per poker room |

---

## 1. Design rules

1. **No floats.** Every monetary value is an integer in *minor units* — cents
   for cash, whole chips for tournaments — paired with a `CurrencyUnit` that
   says how many minor units make one display unit. Hand histories are full of
   `$0.05` values; summing them as floats drifts, and the drift surfaces later
   as "the pot does not add up" in a hand nobody can reproduce.
2. **The action stream is authoritative.** `actions` is the timeline. Board
   cards, pot sizes and stack sizes are all derivable from it. The denormalized
   copies (`board`, `results`) exist because the source states them too, and
   disagreement between the two is exactly what the validator looks for.
3. **Run-it-twice is not a special case.** `board.runouts` is an array; a normal
   hand has one entry. Nothing downstream needs an `if (runTwice)` branch.
4. **Provenance is mandatory.** Every hand carries the raw text it came from,
   which parser produced it, that parser's version, and everything the parser
   was unsure about. A hand we cannot trace is worse than no hand.
5. **The type system leads the parsers.** The types were written to express
   PLO/5-card/6-card Omaha, short deck, stud, razz, draw, pot-limit and
   fixed-limit before any parser read them, so that adding a room is a new file
   rather than a schema migration. Nineteen parsers later that has held: the
   `SiteParser` contract has not had to widen, and the schema additions since
   have all been optional fields inside `phf/1`.

---

## 2. Money

```ts
type Amount = number;                    // integer, minor units

interface CurrencyUnit {
  code: string;        // "USD" | "EUR" | "GBP" | "CHIPS"
  symbol: string;      // "$" | "€" | "£" | ""
  minorUnits: number;  // 100 for cash, 1 for chips
  kind: "cash" | "chips";
}
```

The unit is **not** stored on each value — that would bloat every action. It
lives once on `hand.game.unit`, and separately on
`hand.tournament.buyInUnit`, because a tournament's stacks are chips while its
buy-in is real money.

Named units are exported from `types.ts` for the currencies poker rooms
actually use - `USD`, `EUR`, `GBP`, `CAD`, `AUD`, `NZD`, `CHF`, `SEK`, `NOK`,
`DKK`, `PLN`, `RUB`, `BRL`, `MXN`, `INR`, `CNY`, `JPY`, `USDT` - plus `CHIPS`
and `PLAY_CHIPS`. Parsers should not hand-roll a literal:

- `unitForSymbol("€")` when all the text gives you is a glyph. `$` resolves to
  USD deliberately: CAD, AUD, NZD and MXN share it, and a parser that can tell
  them apart has a code to hand.
- `unitForCode("CAD")` when the room prints a three-letter code, which several
  do next to the buy-in (`$4.50+$1 USD`). An unrecognised code becomes a
  two-decimal cash unit carrying that code rather than falling back to chips,
  because guessing "chips" would silently multiply every amount by 100.
- `unitForCode("USDT", "$")` when you want a known currency printed with a
  different glyph. **An explicit symbol always wins**, whether or not the code
  is one of the named units above. Whether a code happens to be in the table is
  an implementation detail and must never decide if your argument is honoured.
- `cashUnit("HUF", "Ft")` to mint one for a currency nobody has seen yet.

`JPY` is the one unit with `minorUnits: 1`, since the yen has no subunit in
practice.

**Symbols and the text format are coupled.** `toStandardText` writes
`unit.symbol` and `parseStandardText` resolves a unit back from that glyph, so
the two have to agree: emitting a symbol the parser cannot read means the
serializer produces text its own reader silently mis-scales — `₮0.02` coming
back as two *chips* rather than two cents. Anything added to `unitForSymbol`
must be added to the `MONEY` pattern in `serialize.ts` in the same change.

That coupling is also why a room can reasonably choose a display glyph other
than its own: CoinPoker prints no symbol at all and is denominated in USDT, so
it asks for `unitForCode("USDT", "$")` — the code keeps the information, and
`$` is a glyph this format round-trips (USDT is dollar-pegged 1:1).

Helpers in `types.ts`:

| Helper | Purpose |
| --- | --- |
| `parseAmount("0.50", USD)` → `50` | text to minor units |
| `toDisplayNumber(50, USD)` → `0.5` | minor units to a display number |
| `formatAmount(50, USD, "fixed2")` → `"$0.50"` | display string |
| `formatAmountDigits(50, USD, "minimal")` → `"0.5"` | digits without the symbol |
| `toBigBlinds(5000, 50)` → `100` | BB-normalized, one decimal |
| `parseAmountStrict("1 234,50 €", EUR)` → `{ok:true, amount:123450}` | boundary reader that refuses what it cannot hold |
| `chipsUnitFor(text)` → `CHIPS` or `FRACTIONAL_CHIPS` | picks chip precision from the hand's own text |

**Use `parseAmountStrict` at the boundary.** `parseAmount` strips every
non-digit and rounds, which is right once a parser knows a token's shape and a
100x landmine before it does: `1 234,50 €` becomes 123450 *minor units times a
hundred*, and the resulting hand balances perfectly against itself, so nothing
downstream can catch it. The strict reader judges the separators instead of
deleting them, and returns `{ok:false, problem}` for `too-precise`,
`ambiguous-separators` or `not-a-number` rather than guessing. Three site
parsers each grew a local version of this guard before it existed here, which
is why it is now in the core.

Chip precision is its own trap: `CHIPS.minorUnits === 1`, but some tournament
structures genuinely deal half chips (`2642.50`). `FRACTIONAL_CHIPS` holds
those, and `chipsUnitFor` picks between the two from the source text — rounding
a half chip away is silent, because the hand still balances afterwards.

`DecimalStyle` is `"minimal"` (GG writes `$0.5`) or `"fixed2"` (WePlay writes
`$0.50`). Both drop the decimals on round amounts: `$3`, never `$3.00`. The
style is a presentation choice, stored on `meta.textStyle.decimals`, and it has
to survive the round trip because tracker import is byte sensitive.

---

## 3. The hand

```ts
interface PhfHand {
  schema: "phf/1";
  meta: PhfMeta;
  game: PhfGame;
  table: PhfTable;
  tournament: PhfTournament | null;
  players: PhfPlayer[];
  actions: PhfAction[];
  chipMovements?: PhfChipMovement[];   // promo / jackpot chips; see 3.8
  board: PhfBoard;
  results: PhfResults;
  playedAt: string | null;   // ISO 8601, UTC
}
```

### 3.1 `meta` — provenance

| Field | Meaning |
| --- | --- |
| `siteId` / `siteName` | which room, e.g. `"weplay"` / `"WePlay"` |
| `handId` | the hand id exactly as the site wrote it |
| `handKey` | the site's own stable key for the hand, normally equal to `handId`. Re-uploading the same file must produce the same value, because that is what makes the import idempotent |
| `originalFilename` | the uploaded file name, or null for pasted text |
| `parserId` / `parserVersion` | which code produced this hand; lets us re-run old rows through a fixed parser |
| `warnings` | `{ code, message, line? }[]` — things the parser was unsure about |
| `rawText` | the hand's own slice of the upload, verbatim. Never lose the source |
| `parsedAt` | ISO timestamp of the parse, **not** of the hand |
| `textStyle` | presentation choices, below |

`handKey` is scoped by site, not global. The database composes its own key as
`"<meta.siteId>:<meta.handKey>"` (`handKeyOf` in `lib/db/mapping.ts`, stored on
`hands.hand_key`), so two rooms that happen to number a hand the same way do not
collide. A parser therefore only has to be unique *within* its own site.

### 3.2 `meta.textStyle` — presentation only

None of these change the meaning of a hand. They exist so that
`toStandardText(parseStandardText(t)) === t`, which tracker import depends on.

| Field | Meaning |
| --- | --- |
| `decimals` | `"minimal"` (`$0.5`) or `"fixed2"` (`$0.50`) |
| `dealtLinesForAllPlayers` | the source prints a `Dealt to` line for every seat, not just the hero |
| `showdownSection` | the source printed an explicit `*** SHOWDOWN ***` |
| `holeCardsSection` | the source printed `*** HOLE CARDS ***` |
| `showdownLabels` | prefixes of the showdown markers in order: `[""]`, or `["FIRST","SECOND"]` when each runout settled separately |
| `runItTwiceNote` | the SUMMARY carried a `Hand was run two times` line |
| `padHour` | the source zero-pads the header hour (`05:56:01` vs `8:34:11`) |

The fields below were added after the parser fleet was already written, so they
are **optional and tri-state**: `true`/`false` pin the choice, `undefined` means
"work it out from `meta.rawText`". Every parser spreads `DEFAULT_TEXT_STYLE`, so
a required field would silently take its default in twenty parsers at once and
be wrong for whichever rooms do not match it. Leaving them unset lets
`resolveTextStyle` recover the answer from the source the hand already carries.

| Field | Meaning |
| --- | --- |
| `groupThousands` | digit grouping in amounts: `21,929` (GG tournaments) versus `21929` |
| `dealtLineTrailingSpace` | an empty `Dealt to <player>` line ends with a space (GG cash) or does not (GG tournaments) |
| `summaryFeeColumns` | the fee columns on the `Total pot` line, in order. Rooms print none (`Total pot 588`), some (`Rake`, `Jackpot`, `Bingo`), or the full GG cash set |
| `headerPayload` | the header text after `Poker Hand #<id>: `, verbatim — see below |

**About `headerPayload`.** The header is one line of per-room prose. GG writes
`Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)`
— free text between the id and the game label, an arabic level glued to the
word, and an incidental *triple space* that no structured field should ever have
to model. Capturing it keeps imported text byte-exact without coupling the
serializer to every room, which is the point of the parser plugin architecture.

It is replayed only when it demonstrably belongs to the same hand: the source
header's id must equal `meta.handId`, and re-reading the captured text must
agree with the hand on format, blinds, timestamp, game label and tournament
identity. Anything else regenerates from the structured fields. A parser that
normalizes rather than preserves — WePlay rewrites `Weplay Hand #71764146` into
`Poker Hand #HD71764146` — fails that id check, which is also the signal that
*none* of the inferred fields above should be read off its source.

### 3.3 `game`

| Field | Meaning |
| --- | --- |
| `variant` | `holdem` \| `omaha` \| `omaha5` \| `omaha6` \| `shortdeck` \| `stud` \| `razz` \| `draw` \| `other` |
| `limit` | `nl` \| `pl` \| `fl` |
| `format` | `cash` \| `tournament` \| `sng` \| `spin` |
| `unit` | the `CurrencyUnit` for every `Amount` in the hand |
| `smallBlind` / `bigBlind` | the blinds **actually in force**. For tournaments these come from what was posted, because level headers go stale; the header's own numbers stay on `tournament.levelSmallBlind` / `levelBigBlind` |
| `anteModel` | `none` \| `posted-per-player` \| `big-blind-ante` \| `button-ante`. Not cosmetic: `big-blind-ante` means one player posts for the table, which changes both the chip-conservation check and the posting animation |
| `ante` | ante per player under `posted-per-player`, otherwise the single posted ante |
| `straddles` | `{ seat, player, amount, order }[]`; `order` 1 is the first straddle, 2 a re-straddle |
| `bombPot` | `{ ante, dealtToStreet, doubleBoard }` or null. In a bomb pot everyone antes, no blinds are posted and the flop is dealt immediately, so the normal preflop invariants do not apply |
| `label` | the game label verbatim, e.g. `"Hold'em No Limit"` |

### 3.4 `table` and `tournament`

`table` is `{ name, maxSeats, buttonSeat }`.

`table` also carries `fastFold?: string | null` — the pool brand, `"Zoom"`,
`"Rush & Cash"`, `"Banzai"`, `"FastForward"`. Every room buries it in the game
label where canonicalisation drops it, but it changes how the pool plays and is
an obvious filter dimension. The brand is kept rather than a boolean: the
presence answers "is this fast fold?" and the value answers "which one?".

`tournament` is null on cash hands. Otherwise:
`{ id, name, buyIn, bounty?, fee, buyInUnit, levelLabel, levelNumber,
levelSmallBlind, levelBigBlind, levelAnte, bounties, prizePool? }`.
`prizePool` is the stated total prize (Unibet prints `Total prize €4`), in
`buyInUnit`; absent when the room does not say, and never derived, because a
guess would look identical to a stated figure.

**`levelLabel` may be null.** Unibet and Chico state blinds but never a level,
and the standard-text grammar makes the whole `- Level X ` clause optional so
that round-trips as `- (25/50) -` rather than fabricating `Level I`. `levelLabel` keeps the
printed form (`"XI"`), `levelNumber` the parsed one (`11`). `bounties` is
`{ player, amount }[]` for progressive-knockout formats.

Buy-ins come in three printed shapes and `parseBuyInToken` splits all of them:

| Printed | `buyIn` | `bounty` | `fee` |
| --- | --- | --- | --- |
| `$10` | 1000 | 0 | 0 |
| `$15+$1.50` | 1500 | 0 | 150 |
| `$4.50+$4.50+$1` | 450 | 450 | 100 |

`buyIn` is the **prize-pool contribution only**. Folding a knockout's bounty
into it would overstate what the player paid for prize-pool equity, which is the
denominator ROI is computed against. `totalBuyIn(tournament)` gives what
actually left the account. `bounty` is optional so that parsers written before
it existed keep compiling; read it as `?? 0`.

### 3.5 `players`

| Field | Meaning |
| --- | --- |
| `seat`, `name`, `startingStack`, `isHero`, `sittingOut` | as stated by the source |
| `holeCards` | best-known hole cards: from the deal, a `shows` line, or the summary. Empty means unknown. Length is variant dependent (2 for Hold'em, 4–6 for Omaha) — never index blindly |
| `dealtAnnounced` | the source printed a `Dealt to <name>` line for this seat |
| `dealtCards` | what that deal line showed, which is **not** `holeCards`. GG writes `Dealt to villain ` with no cards and only reveals them in the summary, so `holeCards` fills in while the deal line must still be re-emitted empty. The split is also what tells the replayer which hands were face-up from the start |
| `bounty` | PKO bounty when reported |
| `position` | resolved `BTN`/`SB`/`BB`/`UTG`/`UTG+1`/`UTG+2`/`MP`/`LJ`/`HJ`/`CO`, or null when the button is unknown |

Positions are resolved by `assignPositions(hand)`, centrally, so every consumer
and every site parser agrees. It runs at the end of `parseStandardHand` and
again inside `convertAny`, which is the choke point every parser's output flows
through - a new room cannot get the ring wrong on its own.

Geometry alone is not enough, and `resolvePositions(seats, buttonSeat)` is only
the fallback:

- **Dead button.** `table.buttonSeat` can point at a seat whose occupant left
  between hands, so there is nobody to start counting from.
- **Seated but not dealt in.** A player sitting out still appears in the seat
  list. Counting them shifts every position by one; in the worst case a
  six-seat table is really a three-handed hand.
- **Heads-up.** The button posts the small blind, not the seat after it.

So the ring is anchored on the blinds, which the action stream always records:
the seat that posted the small blind is `ring[0]`, or failing that the big blind
is `ring[1]`. Only when no blind was posted at all - a bomb pot - does it fall
back to the button. Seats that were not dealt in get `position: null` rather
than a plausible-looking wrong answer.

The ring is named by the number of players **dealt in**:

| Players | Ring, from the small blind |
| --- | --- |
| 2 | SB (= the button), BB — **no seat is labelled `BTN`** |
| 3 | SB, BB, BTN |
| 4 | SB, BB, CO, BTN |
| 5 | SB, BB, UTG, CO, BTN |
| 6 | SB, BB, UTG, HJ, CO, BTN |
| 7 | SB, BB, UTG, LJ, HJ, CO, BTN |
| 8 | SB, BB, UTG, UTG+1, LJ, HJ, CO, BTN |
| 9 | SB, BB, UTG, UTG+1, UTG+2, LJ, HJ, CO, BTN |
| 10+ | the middle is padded with `MP` |

Heads-up deserves spelling out because it is the case that is easy to get
exactly backwards: with two players the button *is* the small blind, so the ring
is `["SB", "BB"]` and nothing is labelled `BTN`. Code that needs to know where
the button is must read `PhfTable.buttonSeat`; `position === "BTN"` is not a
button test. The rooms' own SUMMARY blocks agree - they print
`Seat 4: Hero (button) (small blind)` - and
`backend/test/phfPositions.test.ts` cross-checks `PhfPlayer.position` against
those words over every hand in `gg-hh/` and `weplay-hh/`, at every table size
from two- to nine-handed.

### 3.6 `actions`

```ts
interface PhfAction {
  index: number;          // position in the stream
  street: Street;         // where the line physically appeared
  runoutIndex: number;    // 0 unless a run-it-twice settled separately
  seat: number | null;
  player: string;
  type: ActionType;
  amount: Amount;         // chips moved into the pot; NEGATIVE for an uncalled return
  streetTotal: Amount;    // the actor's total commitment on this street, after the action
  allIn: boolean;
  cards?: string[];       // revealed by this action
  description?: string;   // "a pair of Aces"
  verb?: string;          // the literal verb when it is not the canonical one
  potName?: string;       // "pot" | "main pot" | "side pot"
  label: string;          // human readable; the replay log renders this verbatim
  sourceLine: number | null;
  rawLine: string;
}
```

`ActionType`:

`ante` · `small-blind` · `big-blind` · `straddle` · `post` · `missed-blind` ·
`bomb-ante` · `fold` · `check` · `call` · `bet` · `raise` · `uncalled` · `show` ·
`muck` · `collect` · `cashout-choose` · `cashout-pay`

Notes:

- `amount` for an `uncalled` return is negative. That is what keeps the
  chip-conservation sum honest without a special case.
- `raise` stores `streetTotal` (the "to" number). The "by" number sites print is
  *the amount over the current bet*, not the chips added, so it is derived at
  serialization time from the betting state of the street. Storing it would let
  the two disagree.
- `show` / `muck` carry the street they physically appeared on, which in an
  all-in run-out is the flop, not `showdown`. Consumers that want "did this hand
  reach a showdown" should read `results.wentToShowdown`.
- `cashout-choose` / `cashout-pay` are GG EV-cashout events. They settle
  *outside* the pot and must not change any pot math; both carry `amount: 0`.
- `isPostingAction(type)` groups everything that happens before the deal.

### 3.7 `board`

```ts
interface PhfBoard { runouts: PhfRunout[] }   // always at least one

interface PhfRunout {
  index: number;
  flop: string[] | null;     // null = identical to runout 0
  turn: string | null;
  river: string | null;
  markerLabels: { flop?: string; turn?: string; river?: string };
  summaryCards: string[] | null;
}
```

A `null` street on runout *n* > 0 means "the same card(s) as runout 0". That is
exactly how sites print it: `*** SECOND TURN ***` appears but `*** SECOND FLOP ***`
does not when the flop is shared.

`markerLabels` and `summaryCards` are faithful-output fields, in the same spirit
as `meta.textStyle`: they record the prefix the source used (`""`, `"FIRST"`,
`"SECOND"` — rooms disagree) and the exact cards its SUMMARY `Board` line listed
(GG lists only the cards that differ, WePlay repeats the whole board). Never
read them as data; use `resolveRunout(board, i)` and `runoutThroughStreet(...)`.

### 3.8 `chipMovements` — chips that are not bets

PHF's chip model has two flows: a seat puts chips in the pot, and the pot pays
out to seats less fees. Rooms run promotions that fit neither, and forcing them
into the model that exists breaks an invariant every time:

| Room | Line | Movement |
| --- | --- | --- |
| GG | `Cash Drop to Pot : total $0.2` | house → pot |
| Run It Once | `STP added: €0.50` | house → pot |
| MicroGaming | `BadBeatContribution` | seat → house, bypassing the pot |

The first two make the pot genuinely larger than the sum of what the players
put in. Attributing the drop to a seat corrupts that seat's `net`; dropping it
breaks chip conservation; calling it a negative fee makes the replayer pay out
more than the pot holds. The third is the same idea from the other end: money
leaves a stack and never becomes part of the pot, so it cannot be a `PhfFees`
entry — those are taken *from* the pot, and counting it there breaks the payout
check. Left unmodelled it silently leaves the contributor's replayed stack high.

One concept covers both:

```ts
interface PhfChipMovement {
  kind: string;                 // "splash-the-pot" | "cash-drop" | "bad-beat-drop"
  fromSeat: number | null;      // null when the house supplied the chips
  fromPlayer: string | null;
  toPot: boolean;               // false = leaves the table entirely
  amount: Amount;
  raw: string | null;           // verbatim line, so the text round-trips
  anchor: "before-postings" | "after-hole-cards";
}
```

Chip conservation becomes `Σ contributions + Σ (movements where toPot) ===
totalPot`; the replayer seeds the pot with house money and deducts
seat-to-house movements from the starting stack. `houseIntoPot(hand)` and
`seatOutOfPot(hand, seat)` are the helpers.

It is deliberately **not** a `PhfAction`: `ActionType` is a closed union that
consumers switch on, so extending it is a `phf/2` change, whereas an optional
field is additive. `anchor` exists because rooms print the line in different
places — GG after the seat block, Run It Once after `*** HOLE CARDS ***`.

### 3.9 `results`

| Field | Meaning |
| --- | --- |
| `totalPot` | the pot as the source reports it |
| `pots` | side-pot breakdown, `[{ name: "Main", amount }, { name: "Side", amount }]`, empty for a single pot |
| `fees` | `{ rake, jackpot, bingo, fortune, tax, other }`, broken out rather than lumped, because the GG summary reports them separately and win-rate math needs to add the promotional ones back |
| `players` | one `PhfPlayerResult` per seat |
| `winners` | one entry per collect, per runout: `{ player, seat, amount, runoutIndex }` |
| `heroNet` | hero's `won - contributed`, or null |
| `wentToShowdown` | a showdown section was printed and at least two players were still in |
| `streetReached` | furthest street the hand actually reached |

`PhfPlayerResult`:

`seat` · `player` · `won` · `contributed` (net of uncalled returns) · `net` ·
`wentToShowdown` · `shownCards` · `mucked` · `handDescription` ·
`positionLabels` (as printed: `["(button)"]`, or `["(button)","(small blind)"]`
heads-up) · `outcome` (`folded`/`collected`/`won`/`lost`/`mucked`/`showed`/`unknown`) ·
`foldedStreet` · `didntBet` · `cashoutRisk` · `raw`.

**About `raw`.** The SUMMARY block is site-authored prose — `showed [Ah Kd] and
won ($12) with two pair, Aces and Fours, and lost` — whose exact wording carries
no information the structured fields lack. Keeping the original string lets
`toStandardText` reproduce imported text byte for byte without forcing every
future parser to replicate one room's phrasing. Parsers that build a hand from
scratch leave it `null` and the serializer generates a canonical line.

---

## 4. Invariants

`validateHand(hand)` returns `{ ok, errors, warnings, problems }`. An **error**
means the hand is not trustworthy and must not be stored as a normal hand; a
**warning** means it is usable but odd. One minor unit of slack (one cent, one
chip) is tolerated on every sum, because sources round their own arithmetic.

### Errors

| Code | Invariant |
| --- | --- |
| `bad-schema` | `schema === "phf/1"` |
| `duplicate-player` / `duplicate-seat` | a name and a seat appear once each |
| `no-players` | the hand has seats |
| `unseated-actor` | every actor in `actions` is a seated player |
| `invalid-card` | every card code parses |
| `duplicate-card` | no card appears twice anywhere in the hand. Run-it-twice runouts share the streets they did not re-deal, so only re-dealt streets are counted |
| `board-size` | each runout has 0, 3, 4 or 5 cards |
| `turn-without-flop` / `river-without-turn` | streets are dealt in order |
| `negative-stack` | no stack goes below zero at any point in the stream |
| `chip-mismatch` | `Σ contributions + Σ house chips into the pot === results.totalPot` (§3.8) |
| `unseated-chip-movement` | a promo or jackpot movement charges a seat that is empty |
| `payout-mismatch` | `Σ collected` equals either `totalPot - fees` or `totalPot`. Rooms disagree on whether the reported pot is before or after the rake — GG deducts (pot 3, rake 0.15, collected 2.85), WePlay reports the rake alongside a pot the winner collects in full — and both are internally consistent. A third answer is an error |
| `uncalled-exceeds-commitment` | an uncalled return never exceeds what the player put in on that street |

### Warnings

`missing-button` · `button-not-seated` · `no-hero` · `hole-card-count` (count
does not match the variant) · `board-street-mismatch` · `no-winner` ·
`contribution-mismatch` / `winnings-mismatch` (the stream and the SUMMARY
disagree) · `missing-blinds` · plus every `meta.warnings` entry the parser
recorded, including `unknown-line`.

---

## 5. Versioning policy

The `schema` field is a literal string, `"phf/1"`.

**What may change inside `phf/1`** (no version bump):

- adding an **optional** field, or a field with a safe default
- adding a member to an *open* union that consumers already handle with a
  `default` branch: `Variant`, `GameFormat`, `AnteModel`, `SeatOutcome`,
  validation `code` values, `ConversionFailure.reason` values
- adding a new `SiteParser`
- tightening a parser so it produces *better* data for the same input

**What requires `phf/2`:**

- removing or renaming a field
- changing the meaning or the unit of an existing field
- changing the sign convention of `PhfAction.amount`
- adding a member to `ActionType` or `Street`, because consumers switch
  exhaustively on those

**How `phf/2` is introduced without breaking stored rows.**

1. `phf/2` ships alongside `phf/1`. `PHF_SCHEMA` becomes `"phf/2"`; the
   `PhfSchema` type becomes the union `"phf/1" | "phf/2"`.
2. A pure `migrateToV2(hand: PhfHandV1): PhfHandV2` is added next to the types
   and covered by a test over the whole sample corpus.
3. Readers run stored rows through `migrateToLatest` on load. Stored rows are
   never rewritten in place; a row keeps the schema tag it was written with, and
   `meta.parserId` / `meta.parserVersion` say what produced it.
4. `toStandardText` keeps emitting the same text for a migrated hand. The text
   format and the JSON schema version independently; a `phf/2` bump is not a
   licence to change the bytes trackers import.
5. Failed conversions are stored with their raw text, so anything a `phf/2`
   parser can newly handle is simply re-run from the original source.

---

## 6. Worked example: a cash hand

### Standard text

```
Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
Table 'NLHPurple70' 6-max Seat #1 is the button
Seat 1: 8c668f2d ($81.22 in chips)
Seat 2: da2a0a00 ($11.75 in chips)
Seat 3: 41ff0a42 ($50.99 in chips)
Seat 4: Hero ($82.8 in chips)
da2a0a00: posts small blind $0.25
41ff0a42: posts big blind $0.5
*** HOLE CARDS ***
Dealt to Hero [5s 8c]
Hero: folds
8c668f2d: raises $0.5 to $1
da2a0a00: folds
41ff0a42: calls $0.5
*** FLOP *** [Tc 4h Ad]
41ff0a42: checks
8c668f2d: bets $1.5
41ff0a42: folds
Uncalled bet ($1.5) returned to 8c668f2d
*** SHOWDOWN ***
8c668f2d collected $2.14 from pot
*** SUMMARY ***
Total pot $2.25 | Rake $0.11 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Tc 4h Ad]
Seat 1: 8c668f2d (button) collected ($2.14)
Seat 2: da2a0a00 (small blind) folded before Flop
Seat 3: 41ff0a42 (big blind) folded on the Flop
Seat 4: Hero folded before Flop (didn't bet)
```

### PHF

Abridged — the action list keeps three of its eleven entries and the player list
two of its four; everything else is verbatim output of `parseStandardHand`.

```json
{
  "schema": "phf/1",
  "meta": {
    "siteId": "standard",
    "siteName": "PokerConverter standard",
    "handId": "HD2735958902",
    "handKey": "HD2735958902",
    "originalFilename": "example.txt",
    "parserId": "standard",
    "parserVersion": "1.0.0",
    "warnings": [],
    "rawText": "<the hand's slice of the uploaded file>",
    "parsedAt": "2026-09-16T00:00:00.000Z",
    "textStyle": {
      "decimals": "minimal",
      "dealtLinesForAllPlayers": false,
      "showdownSection": true,
      "holeCardsSection": true,
      "showdownLabels": [""],
      "runItTwiceNote": false,
      "padHour": true
    }
  },
  "game": {
    "variant": "holdem",
    "limit": "nl",
    "format": "cash",
    "unit": { "code": "USD", "symbol": "$", "minorUnits": 100, "kind": "cash" },
    "smallBlind": 25,
    "bigBlind": 50,
    "anteModel": "none",
    "ante": 0,
    "straddles": [],
    "bombPot": null,
    "label": "Hold'em No Limit"
  },
  "table": { "name": "NLHPurple70", "maxSeats": 6, "buttonSeat": 1 },
  "tournament": null,
  "players": [
    {
      "seat": 1, "name": "8c668f2d", "startingStack": 8122, "isHero": false,
      "holeCards": [], "bounty": null, "sittingOut": false,
      "position": "BTN", "dealtAnnounced": false, "dealtCards": []
    },
    {
      "seat": 4, "name": "Hero", "startingStack": 8280, "isHero": true,
      "holeCards": ["5s", "8c"], "bounty": null, "sittingOut": false,
      "position": "CO", "dealtAnnounced": true, "dealtCards": ["5s", "8c"]
    }
  ],
  "actions": [
    {
      "index": 0, "street": "preflop", "runoutIndex": 0, "seat": 2,
      "player": "da2a0a00", "type": "small-blind",
      "amount": 25, "streetTotal": 25, "allIn": false,
      "label": "small blind $0.25", "sourceLine": 7,
      "rawLine": "da2a0a00: posts small blind $0.25"
    },
    {
      "index": 9, "street": "flop", "runoutIndex": 0, "seat": 1,
      "player": "8c668f2d", "type": "uncalled",
      "amount": -150, "streetTotal": 0, "allIn": false,
      "label": "uncalled $1.5 returned", "sourceLine": 19,
      "rawLine": "Uncalled bet ($1.5) returned to 8c668f2d"
    },
    {
      "index": 10, "street": "showdown", "runoutIndex": 0, "seat": 1,
      "player": "8c668f2d", "type": "collect",
      "amount": 214, "streetTotal": 0, "allIn": false, "potName": "pot",
      "label": "wins $2.14", "sourceLine": 21,
      "rawLine": "8c668f2d collected $2.14 from pot"
    }
  ],
  "board": {
    "runouts": [
      {
        "index": 0,
        "flop": ["Tc", "4h", "Ad"],
        "turn": null,
        "river": null,
        "markerLabels": { "flop": "" },
        "summaryCards": ["Tc", "4h", "Ad"]
      }
    ]
  },
  "results": {
    "totalPot": 225,
    "pots": [],
    "fees": { "rake": 11, "jackpot": 0, "bingo": 0, "fortune": 0, "tax": 0, "other": 0 },
    "players": [
      {
        "seat": 1, "player": "8c668f2d", "won": 214, "contributed": 100, "net": 114,
        "wentToShowdown": false, "shownCards": [], "mucked": false,
        "handDescription": null, "positionLabels": ["(button)"],
        "outcome": "collected", "foldedStreet": null, "didntBet": false,
        "cashoutRisk": null, "raw": "Seat 1: 8c668f2d (button) collected ($2.14)"
      }
    ],
    "winners": [{ "player": "8c668f2d", "seat": 1, "amount": 214, "runoutIndex": 0 }],
    "heroNet": 0,
    "wentToShowdown": false,
    "streetReached": "flop"
  },
  "playedAt": "2026-02-17T05:56:01.000Z"
}
```

Note `"totalPot": 225` with `"rake": 11` and a collect of `214`: GG deducts the
rake from the reported pot, so `214 + 11 === 225`. Note also that `Hero` has
`holeCards` but no other seat does, and that `8c668f2d`'s `raises $0.5 to $1`
stores only `streetTotal: 100` — the printed `$0.5` is the amount over the big
blind and is recomputed on the way out.

---

## 7. Worked example: a tournament hand

### Standard text

```
Poker Hand #HD75299070: Tournament (ILWP series - Chocolate Box Deepstack)#11275291, $15+$1.50 Hold'em No Limit - Level XI (50/100) - 2026/02/10 17:01:27
Table '11275291 2' 7-max Seat #4 is the button
Seat 1: Notarized (21932 in chips)
Seat 2: GRSTre (29740 in chips)
Seat 3: Gravedigger14 (6191 in chips)
Seat 4: Poroshok (10000 in chips)
Seat 5: kole1992 (21497 in chips)
Seat 7: gejzir81 (11408 in chips)
Notarized: posts the ante 85
GRSTre: posts the ante 85
Gravedigger14: posts the ante 85
Poroshok: posts the ante 85
kole1992: posts the ante 85
gejzir81: posts the ante 85
kole1992: posts small blind 350
gejzir81: posts big blind 700
*** HOLE CARDS ***
Dealt to kole1992 [5c Ks]
Notarized: raises 700 to 1400
GRSTre: folds
Gravedigger14: folds
Poroshok: folds
kole1992: folds
gejzir81: folds
Uncalled bet (700) returned to Notarized
*** SHOWDOWN ***
Notarized: doesn't show hand
Notarized collected 2260 from pot
*** SUMMARY ***
Total pot 2260 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0
Seat 1: Notarized collected (2260)
Seat 2: GRSTre folded before Flop
Seat 3: Gravedigger14 folded before Flop
Seat 4: Poroshok (button) folded before Flop
Seat 5: kole1992 (small blind) folded before Flop
Seat 7: gejzir81 (big blind) folded before Flop
```

### PHF (header blocks only)

```json
{
  "schema": "phf/1",
  "meta": {
    "siteId": "weplay",
    "siteName": "WePlay",
    "handId": "HD75299070",
    "handKey": "HD75299070",
    "parserId": "weplay",
    "parserVersion": "2.0.0",
    "warnings": [],
    "textStyle": {
      "decimals": "fixed2",
      "dealtLinesForAllPlayers": false,
      "showdownSection": true,
      "holeCardsSection": true,
      "showdownLabels": [""],
      "runItTwiceNote": false,
      "padHour": true
    }
  },
  "game": {
    "variant": "holdem",
    "limit": "nl",
    "format": "tournament",
    "unit": { "code": "CHIPS", "symbol": "", "minorUnits": 1, "kind": "chips" },
    "smallBlind": 350,
    "bigBlind": 700,
    "anteModel": "posted-per-player",
    "ante": 85,
    "straddles": [],
    "bombPot": null,
    "label": "Hold'em No Limit"
  },
  "table": { "name": "11275291 2", "maxSeats": 7, "buttonSeat": 4 },
  "tournament": {
    "id": "11275291",
    "name": "ILWP series - Chocolate Box Deepstack",
    "buyIn": 1500,
    "fee": 150,
    "buyInUnit": { "code": "USD", "symbol": "$", "minorUnits": 100, "kind": "cash" },
    "levelLabel": "XI",
    "levelNumber": 11,
    "levelSmallBlind": 50,
    "levelBigBlind": 100,
    "levelAnte": 0,
    "bounties": []
  },
  "playedAt": "2026-02-10T17:01:27.000Z"
}
```

Three things to notice:

- `unit.minorUnits` is `1`: the stacks are chips, and `21932` means twenty-one
  thousand nine hundred and thirty-two chips, not `$219.32`.
- `tournament.buyIn` is `1500` in a **different** unit — cents — because the
  buy-in is real money. `buyInUnit` says so.
- `game.bigBlind` is `700` (what was posted) while
  `tournament.levelBigBlind` is `100` (what the header claims). WePlay's level
  header is stale here. `toBigBlinds` uses `game.bigBlind`, so the replayer
  shows `Notarized` with a 31bb stack rather than 219bb. The header is
  re-serialized from `levelSmallBlind` / `levelBigBlind`, so the text still
  round-trips.

---

## 8. How to write a new site parser

### 8.1 The contract

Nineteen parsers are registered in `frontend/src/lib/parsers/index.ts`, covering
more rooms than that — Ignition also reads Bodog and Bovada, Chico four skins.
Read one close to your room's dialect before starting.

```ts
export interface SiteParser {
  readonly id: string;       // stable machine id; goes into the database
  readonly name: string;     // display name
  readonly version: string;  // bump on behaviour changes; recorded per hand

  /** Confidence in 0..1 that this text came from this site. Cheap and total. */
  detect(text: string): number;

  /** Splits a file into individual hand chunks. */
  splitHands(text: string): string[];

  /** Parses one chunk. Throw `ParseSkip` for a recognised hand we won't convert. */
  parseHand(raw: string, ctx: SiteParserContext): PhfHand;
}

export interface SiteParserContext {
  sourceFilename: string | null;
  options: ConvertOptions;   // cashOnly, skipBombPots, validate, ...
}
```

Rules:

- `detect` must never throw and must never be expensive — it runs against every
  registered parser for every upload, and again for every chunk. Return a
  *graded* score, not 0/1, so the registry can pick the best of several
  plausible matches. Scores below `DETECTION_THRESHOLD` (0.2) are ignored.
  Claim a format that is not uniquely yours weakly: our own `standard` parser
  returns `0.9` for `Poker Hand #` but only `0.25` for `PokerStars Hand #`, so a
  dedicated PokerStars parser at `0.95` always wins.
- `parseHand` throws `ParseSkip(reason, message)` for a hand it recognises but
  refuses — unsupported variant, corrupt source, a format we have not written
  yet. That becomes a stored `ConversionFailure` we can come back to. Any other
  exception is treated as a bug in our code and reported as `parser-error`.
- Set `meta.rawText` to the **site's** original text, not your intermediate
  form, so a later bug fix can re-convert from the source.

### 8.2 Two ways to build the `PhfHand`

**A. Normalize to standard text, then reuse the standard parser.** This is what
`parsers/weplay.ts` does. It is the fastest route when the site's format is
close to the GG shape: rewrite the lines that differ, hand the result to
`parseStandardHand`, then overwrite `meta`.

**B. Build the object directly.** Right for a format that is structurally
different (JSON exports, XML, PokerStars' summary block, stud's per-street
card deals). More code, but no lossy text intermediate.

### 8.3 Annotated skeleton

```ts
// frontend/src/lib/parsers/examplesite.ts
/**
 * Example Poker parser.
 *
 * Every non-obvious branch in here should say which real hand forced it.
 */

import {
  ParseSkip,
  type SiteParser,
  type SiteParserContext,
} from "../phf/detect";
import {
  PHF_SCHEMA,
  USD,
  parseAmount,
  parseBuyInToken,
  unitForCode,
  type PhfAction,
  type PhfHand,
  type PhfPlayer,
} from "../phf/types";

const VERSION = "1.0.0";

export const exampleParser: SiteParser = {
  id: "examplesite",
  name: "Example Poker",
  version: VERSION,

  detect(text) {
    // Anchor on something only this room writes. Grade the answer.
    if (/^Example Poker Hand #\d+/m.test(text)) return 0.95;
    if (/Example Poker/i.test(text)) return 0.3;
    return 0;
  },

  splitHands(text) {
    // Most rooms repeat a header; some use a separator line instead.
    return text
      .split(/(?=^Example Poker Hand #)/m)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => chunk.startsWith("Example Poker Hand #"));
  },

  parseHand(raw, ctx: SiteParserContext): PhfHand {
    const lines = raw.split(/\r?\n/);

    // 1. Refuse early and loudly. A ParseSkip is stored for a future parser;
    //    silently emitting a wrong hand is the failure mode to avoid.
    if (/\bOmaha\b/i.test(lines[0])) {
      throw new ParseSkip("unsupported-variant", "Omaha is not supported yet.");
    }
    if (ctx.options.cashOnly && /Tournament/i.test(lines[0])) {
      throw new ParseSkip("tournament-in-cash-mode", "Tournament hand skipped.");
    }

    // 2. Money first: pick the unit, then keep everything in minor units.
    //    `unitForCode("CAD")` / `unitForSymbol("€")` rather than a literal.
    const unit = USD;
    const players: PhfPlayer[] = [];
    const actions: PhfAction[] = [];
    const warnings: PhfHand["meta"]["warnings"] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;

      const seat = line.match(/^Seat (\d+): (.+) \(\$([\d.]+)\)$/);
      if (seat) {
        players.push({
          seat: Number(seat[1]),
          name: seat[2],
          startingStack: parseAmount(seat[3], unit),
          isHero: false,
          holeCards: [],
          bounty: null,
          sittingOut: false,
          position: null,          // filled in below, once the button is known
          dealtAnnounced: false,
          dealtCards: [],
        });
        continue;
      }

      // ... one branch per line shape ...

      // 3. Anything you do not understand becomes a warning, never a silent
      //    drop. `backend/test/` asserts the corpus parses with zero warnings,
      //    so an unhandled line shape fails the build instead of the user.
      warnings.push({ code: "unknown-line", message: line, line: i + 1 });
    }

    // 4. Positions: you do NOT have to resolve these. `convertAny` calls
    //    `assignPositions` on whatever you return, which reads the ring off the
    //    blinds you put in `actions` and handles dead buttons, sit-outs and
    //    heads-up for you. Leave `position: null` and let it do the work.

    return {
      schema: PHF_SCHEMA,
      meta: {
        siteId: "examplesite",
        siteName: "Example Poker",
        handId: "…",
        handKey: "…",            // must be stable across re-uploads
        originalFilename: ctx.sourceFilename,
        parserId: "examplesite",
        parserVersion: VERSION,
        warnings,
        rawText: raw.trim(),     // the SITE's text, not your rewrite of it
        parsedAt: new Date().toISOString(),
        textStyle: {
          decimals: "fixed2",
          dealtLinesForAllPlayers: false,
          showdownSection: true,
          holeCardsSection: true,
          showdownLabels: [""],
          runItTwiceNote: false,
          padHour: true,
        },
      },
      game: { /* … */ } as PhfHand["game"],
      table: { name: "…", maxSeats: 6, buttonSeat },
      tournament: null,
      players,
      actions,
      board: { runouts: [{ index: 0, flop: null, turn: null, river: null, markerLabels: {}, summaryCards: null }] },
      results: { /* … */ } as PhfHand["results"],
      playedAt: null,
    };
  },
};
```

Register it:

```ts
// frontend/src/lib/parsers/index.ts
import { exampleParser } from "./examplesite";
registerParser(exampleParser);
```

### 8.4 Fixtures

Real exports go in **`fixtures/samples/<site>/`**, one directory per room, each
with a **`SOURCES.md`** recording where every file came from. That is the
convention all nineteen parsers follow — 413 files across 22 directories — and
`SOURCES.md` is not optional paperwork: it is what lets the next person tell a
real export from something someone typed by hand.

Each row records the file, the provenance URL, the date retrieved, whether it is
**REAL / TRANSCRIBED / SYNTHETIC**, and what it demonstrates. Prefer REAL; a
synthetic fixture proves only that the parser agrees with whoever wrote it. Note
encoding and line endings when they matter — several of these corpora are
byte-exact excerpts where an editor "helpfully" normalizing a glyph or a CRLF
would destroy the thing under test. `fixtures/**` is marked `-text` in
`.gitattributes` for exactly that reason.

`backend/test/fixtures/` is *not* the place: it holds only the `gg/` and
`weplay/` regression cases that predate this layout.

Load a corpus through a helper in `backend/test/support/` — there are several
(`corpus.ts`, `p2Corpus.ts`, `p4Corpus.ts`, `p6Corpus.ts`, `psggCorpus.ts`),
each reading `fixtures/samples/<site>` and returning files for a table-driven
`it.each`. Reuse the closest one rather than adding a sixth.

### 8.5 Tests a new parser must come with

1. **Detection** — every sample file ranks your parser first, and your parser
   claims *no* file from any other room's corpus. The second half matters as
   much as the first: detection is a competition, and a parser that over-claims
   silently steals hands from a room that would have read them correctly.
2. **No unknown lines** — every hand parses with `meta.warnings === []`. This is
   the convention that turns an unhandled line shape into a build failure
   instead of a silent drop.
3. **Validation** — every hand you emit passes `validateHand`, and every hand
   you refuse carries a machine-readable `reason`.
4. **Round trip** — `parseStandardText(toStandardText(h))` is semantically equal
   to `h` for every sample hand (`phfRoundTrip.test.ts` shows the projection
   that is compared; `support/psggInvariants.ts` has a reusable version).
5. **Replay** — no stack goes negative and the whole pot is awarded in the final
   frame (`phfReplay.test.ts`).
6. **One test per bug** — when a real hand breaks the parser, add the hand as a
   fixture with a comment saying what it broke. That is why
   `backend/test/fixtures/weplay/` exists and why the WePlay normalizer still
   works.

### 8.6 Lessons from nineteen parsers

Each of these cost at least one author a debugging cycle, and most cost two.

**Leave `position` as `null`.** Positions are resolved centrally by
`assignPositions`, which runs at the end of `parseStandardHand` and again inside
`convertAny` — the choke point every parser's output passes through. It reads
the ring off the posted blinds and handles dead buttons, sit-outs and heads-up,
none of which geometry gets right on its own. At least one author wrote a local
position helper and then deleted it. Just fill in the blinds and let the core do
it.

**`toStandardText` re-groups the posting actions.** Antes, blinds, missed blinds
and preflop straddles are emitted *above* `*** HOLE CARDS ***`; a bare `post` is
left in the body with the rest of the preflop action. So a parser that emits a
pre-deal `posts` in source order will fail the round-trip invariant until it
splits the two the same way. Two authors hit this. The fix is in the parser: use
the specific action type (`ante` / `small-blind` / `big-blind` / `missed-blind`
/ `straddle`) for anything posted before the deal, and reserve `post` for dead
money inside the hand.

**Refusing beats guessing.** This is the single most important habit, and it is
counter-intuitive: a mis-scaled or mis-attributed hand *still balances against
itself*. It passes chip conservation, passes the payout check, passes the
replay, and corrupts a tracker silently months later. A refused hand is stored
with its raw text and can be converted the day someone writes the code. The
mechanisms are `parseAmountStrict` at the point a token first arrives,
`ParseSkip(reason, message)` for a hand you recognise but will not vouch for,
and the warnings-must-be-empty convention above. Guess nothing you can refuse.

**Cross-check against figures the room computed itself.** Chip conservation only
proves the hand is consistent with your own reading of it. The room also states
a rake, a total pot and often a per-seat net; comparing against those catches a
parse that is wrong in a self-consistent way, which is the only kind that gets
past everything else. One author's cross-check found a real bug where an entire
€1.60 had been swept into the rake on a hand that balanced perfectly.

---

## 9. Failure records

Everything we cannot convert is reported, never dropped. The shape is a contract
with the database layer:

```ts
export interface ConversionFailure {
  /** sha-256 hex of the whitespace-normalized raw text; dedupe key */
  fingerprint: string;
  rawText: string;
  detectedSite: string | null;
  detectionConfidence: number | null;
  stage: "split" | "detect" | "parse" | "validate" | "serialize";
  /** short machine code, e.g. "unknown-site", "unsupported-variant", "chip-mismatch" */
  reason: string;
  /** human readable, shown in the UI */
  message: string;
  parserVersion: string;
  sourceFilename: string | null;
}
```

`fingerprint` is sha-256 over the whitespace-normalized text via
`crypto.subtle`, so a file re-saved with different line endings dedupes against
the original. Where Web Crypto is unavailable, `fingerprintSync` returns a
128-bit FNV-1a mix prefixed with `fnv1a128-` so the difference is obvious in
stored rows.

Reason codes currently emitted: `unknown-site`, `no-hands`, `split-failed`,
`parser-error`, `unsupported-variant`, `tournament-unsupported`,
`tournament-in-cash-mode`, `bomb-pot`, `all-in-or-fold-table`, `bb-only-walk`,
`short-allin-small-blind`, `short-allin-big-blind`, `short-allin-call`,
`zero-stack-actor`, `ghost-ante`, `unseated-actor`, `no-seat-block`,
`uncalled-exceeds-commitment`, `turn-without-flop`, `river-without-turn`,
`splash-the-pot`, `unsupported-precision`, `cancelled-hand`,
`normalized-unparseable`, plus every validator error code from section 4.

> `splash-the-pot` should no longer be needed: promotional chips have a home
> now (§3.9), so a hand carrying them can be converted rather than refused.

Warning codes parsers emit alongside a converted hand: `unknown-line`,
`unknown-summary-line`, `board-from-summary`, `run-it-twice-summary`,
`button-seat-empty`, `hero-attribution`, `ambiguous-timestamp`,
`all-in-insurance`, `play-money-table`, `unrepresentable-amount`, plus every
validator warning code from section 4. A warning means the hand is usable and
something about it was odd; the UI surfaces them and the corpus tests assert
they are empty for hands a parser claims to fully understand.

### 9.1 Deliberate non-decisions

Recorded so they are not relitigated:

- **All-in insurance has no `ActionType` member.** GG writes
  `pay premium of all-in insurance ($4)`. Mapping it onto
  `cashout-choose`/`cashout-pay` would put one product's money under another's
  name downstream, so parsers record an `all-in-insurance` warning instead.
  A real member is a `phf/2` change (§5) and earns its place when a consumer
  needs to *compute* with hedged money — a true net including insurance — not
  merely to display that it happened. Until then the premium settles outside
  the pot and no invariant depends on it.
- **`PhfPlayerResult` has no per-runout outcome.** Full Tilt prints one SUMMARY
  block per runout and the per-seat prose contradicts itself for a player who
  won one board and lost the other. The *money* is already per-runout, on
  `results.winners[].runoutIndex`; what collapses is prose that nothing
  computes on. Doubling the most-read structure to carry it is not worth it
  yet. What would change this: a UI that shows "won the first board, lost the
  second", or a filter over per-runout results.
- **Standard text cannot express "hero with no known cards".** `isHero` only
  survives `toStandardText` → `parseStandardHand` when the seat is literally
  named `Hero`, so observed-table exports lose the flag on a text round trip.
  PHF's JSON carries it correctly and the database stores PHF, so the loss is
  confined to the text serialization. Inventing a marker in the seat line was
  rejected because Holdem Manager and PokerTracker parse those lines and the
  byte-compatibility guarantee is worth more than this.
- **Play money cannot round-trip.** `unitForSymbol("")` returns `CHIPS`, so
  `PLAY_CHIPS` is unreachable through standard text. Parsers carry a
  `play-money-table` warning, which is the important part: play money mixed
  into a real-money win rate is a silent lie. Distinguishing the two in the
  text needs a grammar affordance and is deferred with the hero flag above.

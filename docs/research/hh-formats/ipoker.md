# iPoker network (Playtech) hand history format

Status: a parser for this format has already shipped and is tested against the fixtures in
`fixtures/samples/ipoker/`. This document has been rewritten to prioritize what a happy-path
implementation would get wrong — the detection signature and the gotchas, especially the structural XML
variants — over a basic walkthrough. See `fixtures/samples/ipoker/SOURCES.md` for exact fixture
provenance. **iPoker hand histories are XML, not PokerStars-style plain text.**

## 1. Overview & status

- **Confirmed from real samples** (15 fixtures, `fixtures/samples/ipoker/`, era ~2012–2014): real-money
  cash-game No-Limit/Fixed-Limit Hold'em and Pot-Limit Omaha, 2 players up to at least 6, EUR/GBP/USD
  stakes, antes, and **three structurally distinct real XML dialects** coexisting in the same network
  (see §2/§13) — this is the single most important finding for this network.
  Skin identity (Betfair/Titan/bet365/Winner/etc.) is **not** encoded anywhere in the sample XML found —
  none of the `<general>` fields carry a brand name in any real sample; the corpus's own `<tablename>`
  values are generic city names (`Ashil'ta`, `Andora`, `Konark`...), not skin names. Whether individual
  skins brand the file differently was not confirmed either way.
- **Inferred / secondary source only, not verified against a real full hand file**: tournament XML
  structure, and the "Speed"/fast-fold table variant. A web search found only prose describing that
  tournament hand histories are typically saved to a separate `Tournament` subfolder
  (`hhdealer.com` blog) — no actual tournament XML content was retrievable.
- **Negative findings, stated explicitly**: no tournament or Speed/fast-fold sample exists anywhere in
  the local corpus or found on the web in the time available. Do not assume the cash `<game>` schema
  extends cleanly to tournaments (e.g. no evidence on how/whether tournament ID, buy-in, level, or
  finishing-position fields are represented).
- Era: every real sample is 2012–2014. Playtech is reported (per Wikipedia's iPoker article, checked via
  web search) to still operate the network as of 2025 with ~20 skins, but no modern-era XML sample was
  obtained, so no claim is made about whether the schema shown here is still current.

## 2. Detection signature

The shipped parser layer scores candidate formats 0–1, so give it a ranked signal list, not a single
regex — and for this network specifically, detecting "is this iPoker XML at all" is a separate question
from "which of the (at least) three real structural dialects is this file."

**Strong, high-confidence signal that a file is iPoker/Playtech XML at all:**
```
<session sessioncode="...">.*<general>.*<gametype>.*</gametype>.*<tablename>.*</tablename>.*<game gamecode="...">
```
i.e. the combination of a `<session sessioncode="...">` root, a `<general>` block containing
`<gametype>` and `<tablename>` elements, and at least one `<game gamecode="...">` child. No other XML
format in this project's corpus (partypoker/888/legacy networks are all plain text, not XML) will match
this shape, so element-name matching alone is a safe, unambiguous discriminator against every other site
in scope. The `<?xml version="1.0" encoding="utf-8"?>` declaration, if present, is a weak corroborating
signal only — one real dialect (§13, DataMiner) omits it entirely, so its **absence must not** be treated
as evidence the file isn't iPoker XML.

**Detecting which dialect you have** (all three confirmed real, see §13 for full detail):
1. **Normal/client dialect**: has `<?xml ?>` declaration, pretty-printed with indentation/newlines, has a
   `<tablecurrency>` element, non-hero pocket cards rendered as `X X`/`X X X X` placeholders,
   self-closing `<action .../>` tags always carry a `cards="..."` attribute (even if empty) with a space
   before `/>`.
2. **Unformatted dialect**: byte-identical schema to the normal dialect but emitted as a single line with
   no whitespace between tags at all — detect by the *absence* of newlines inside the document, not by
   any different element.
3. **DataMiner dialect**: no `<?xml ?>` declaration, no `<tablecurrency>` element, `<cards
   type="Pocket" ...></cards>` rendered as an explicit empty open/close pair instead of an `X X`
   placeholder, self-closing `<action .../>` tags have **no** `cards` attribute and **no space** before
   `/>`, and card tokens use lowercase suit-then-rank (`c10 hK s5`) instead of the normal dialect's
   uppercase (`C4 D7 CJ`). Detect via any one of: missing `<tablecurrency>`, or the no-space
   self-closing-tag shape, or lowercase card tokens.

A fourth, orthogonal variant — **multi-hand file layout** — is a separate axis from the three dialects
above and must be checked independently (§13): a multi-hand file can be either one `<session>` wrapping
several sibling `<game>` elements, **or** several complete, independent `<?xml ?><session>...</session>`
documents simply concatenated back-to-back with no shared wrapper at all. Do not assume "one `<session>`
tag" implies "one hand"; count `<game gamecode="...">` occurrences, and do not assume a file that fails to
parse as one well-formed XML document isn't iPoker data — try splitting on `<?xml` or `<session` boundaries
first.

**What this signature could be confused with:** nothing else in this project's scope, since no other site
uses XML — the risk here is entirely internal (misidentifying which of the 3 dialects, or the multi-doc
concatenation case, and failing closed instead of degrading gracefully).

## 3. Full verbatim example hands

Cash, normal dialect, pretty-printed — `fixtures/samples/ipoker/01-basic-hand-pl-omaha-eur.xml`:
```xml
﻿<?xml version="1.0" encoding="utf-8"?>
<session sessioncode="0">
  <general>
    <mode>real</mode>
    <gametype>Omaha PL €0.05/€0.10</gametype>
    <tablename>Ashil'ta, 817748311</tablename>
    <tablecurrency>EUR</tablecurrency>
    ...
    <currency></currency>
    <nickname>N/A</nickname>
    ...
  </general>
<game gamecode="5383392792">
    <general>
      <startdate>2014-01-06 11:49:59</startdate>
      <players>
        <player seat="5" name="Frozean" chips="€8.72" dealer="1" win="€0" bet="€0" rebuy="0" addon="0" reg_code="-" />
        ...
      </players>
    </general>
    <round no="0">
      <action no="1" player="joemags" type="1" sum="€0.05" cards="[cards]" />
      <action no="2" player="Dullaghan" type="2" sum="€0.10" cards="[cards]" />
    </round>
    <round no="1">
      <cards type="Pocket" player="Frozean">X X X X</cards>
      <action no="3" player="Frozean" type="0" sum="€0" cards="" />
      ...
    </round>
    <round no="2">
      <cards type="Flop" player="">D7 C4 CJ</cards>
      ...
    </round>
  </game>
</session>
```

DataMiner dialect, whole hand, for direct comparison —
`fixtures/samples/ipoker/05-dataminer-format-variant.xml`:
```xml
﻿<session sessioncode="123456">
<general>
<mode>real</mode>
<gametype>Holdem NL 5/10</gametype>
<tablename>Andreapol__No_DP_</tablename>
<duration>N/A</duration>
...
<currency>USD</currency>
...
</general>
<game gamecode="987654">
<general>
<startdate>2014-01-01 22:50:13</startdate>
<players>
<player seat="5" name="ch4atsftw" chips="$100000" dealer="0" win="$0" bet="$0" />
...
</players>
</general>
<round no="0">
<action no="1" player="Betraktaren" type="1" sum="$5"/>
<action no="2" player="Shostak0vich" type="2" sum="$10"/>
</round>
<round no="1">
<cards type="Pocket" player="a3uu"></cards>
<action no="3" player="Marlene79" type="0" sum="$0"/>
...
</round>
<round no="2">
<cards type="Flop" player="">c10 hK s5</cards>
...
</round>
</game>
</session>
```

Tournament: **no real sample available.** Do not fabricate one; see §1.

## 4. Header grammar (XML fields)

- `<gametype>`: `"<Game> <Limit> <Cur><SB>/<Cur><BB>"`, e.g. `Omaha PL €0.05/€0.10`,
  `Holdem NL £0.05/£0.10`, `Holdem L $5/$10`, `Holdem NL 5/10` (DataMiner dialect: no currency symbol at
  all, note). `<Limit>` tokens confirmed real: `NL`, `PL`, `L` (fixed limit — a bare `L`, not `FL`).
- `<tablecurrency>`: three-letter ISO code (`EUR`, `GBP`, `USD`) — **absent entirely** in the DataMiner
  dialect (§2/§13).
- `<currency>`: a second, separate currency field inside `<general>` that in real samples is sometimes
  **empty** (`<currency></currency>`), sometimes populated and **agreeing** with `<tablecurrency>`, and in
  two independently-real samples (`07-invalid-truncated-currency-mismatch.xml`,
  `12-gbp-table-currency-mismatch.xml`) populated but **disagreeing** with `<tablecurrency>` (table is GBP,
  `<currency>` says EUR). This is real, recurring, confirmed behavior — not a one-off corrupt file. Do not
  assume these two fields are redundant/always consistent.
- Ante: `<action type="15">` inside `<round no="0">`, one per player, posted before the blind actions
  (confirmed real, `03-ante-gbp-currency.xml`).
- Tournament header fields (buy-in, level, tournament ID, etc.): **entirely unconfirmed**, no sample.
- Speed/fast-fold: **entirely unconfirmed**, no sample.

## 5. Table/seat lines, button, max seats (XML representation)

```xml
<players>
  <player seat="5" name="Frozean" chips="€8.72" dealer="1" win="€0" bet="€0" rebuy="0" addon="0" reg_code="-" />
  ...
</players>
```
- `dealer="1"` on exactly one `<player>` marks the button (confirmed real). `seat` is a bare integer, not
  necessarily contiguous or starting at 1 (real samples show seats like 5, 6, 8 for a 3-handed hand — seat
  numbers reflect the physical table's seat slots, not "player index").
- No explicit max-seat field was found in `<general>`; max seats must be inferred (table layout / caller
  context), same open question as for the plain-text networks.
- `reg_code="-"` appears on every player in the normal dialect but is **absent entirely** as an attribute
  in the DataMiner dialect (its `<player>` tags have fewer attributes overall) — another dialect tell.

## 6. Blinds, antes, straddle, dead blinds, post-to-enter

All represented as `<action>` elements inside `<round no="0">` (the only round number used for
pre-cards posting):
- `type="1"` = small blind, `type="2"` = big blind, `type="15"` = ante (posted as its own action per
  player, before the blind actions in file order even though blinds get lower/earlier `no=` attribute
  numbers in some samples — **`no=` attribute order and document order are not always the same**, e.g.
  `03-ante-gbp-currency.xml` has ante actions numbered 1/2/3 appearing first in the document, followed by
  blind actions numbered 4/5 also appearing after them in the document — consistent there, but other
  samples show interleaved/out-of-order `no=` values within a round; **always sort by the `no=` attribute
  before replaying, never assume document order equals real chronological order**).
- No straddle example found. No distinct "dead blind" action type was identified in the parser source
  (`type="8"`/`type="9"` cover "sitting out at start of hand" / "blind not posted", which is the closest
  analogue — see §8).

## 7. Street markers (XML representation)

Each betting round is a `<round no="N">` element, **not** a special string marker:
- `no="0"` — pre-deal (blinds/antes only, no `<cards>` elements).
- `no="1"` — preflop action; individual `<cards type="Pocket" player="...">...</cards>` elements appear
  interleaved with `<action>` elements as each player's hole cards become relevant (dealt in seat order,
  immediately followed by that player's first preflop action).
- `no="2"` — flop; a `<cards type="Flop" player="">...</cards>` element (3 space-separated card tokens)
  appears first, then that street's `<action>` elements.
- `no="3"` — turn (`<cards type="Turn" ...>`, 1 card token).
- `no="4"` — river (`<cards type="River" ...>`, 1 card token).
No showdown-specific round number was identified separately — showdown reveals happen via unmasked
`<cards type="Pocket">` content on players who reached showdown (see §8), not a `round no="5"` or similar.

## 8. Action verbs (XML `type=` codes)

Confirmed from the shipped parser's own switch statement (`IPokerFastParserImpl.cs`) cross-checked
against real samples:
| `type=` | meaning | confirmed in a real sample |
|---|---|---|
| 0 | fold | yes |
| 1 | small blind | yes |
| 2 | big blind | yes |
| 3 | call | yes |
| 4 | check | yes |
| 5 | bet | yes |
| 6, 7 | all-in (both codes map to all-in; parser source comments that it doesn't know the distinction between them) | not directly observed, taken from parser source only |
| 8 | sitting out at the start of the hand | yes |
| 9 | blind not posted (treated as sitting out) | not observed, taken from parser source only |
| 15 | ante | yes |
| 23 | raise | yes |
Any other numeric value is unrecognized by the shipped parser and throws — treat unknown `type=` values
as a real possibility for future/other builds, not a case to silently ignore.

- Hole-card masking: a player's `<cards type="Pocket">` content is `X X` (Hold'em) or `X X X X` (Omaha)
  whenever that player's cards were never observed (folded before/at showdown, or the file's owner isn't
  that player) — including for the **file's own designated hero** (`<nickname>` in `<general>`) on hands
  where the hero folded before showdown (confirmed real, `02-hero-nickname-masked-preflop.xml`: nickname
  is `IPK_Hero` but the hand shows `X X` for that very player). Masking is therefore
  showdown/all-in-driven, not identity-driven — **do not assume the nicknamed hero's cards are always
  visible.**
- Unmasked reveal: real card tokens appear directly in `<cards type="Pocket" player="...">`, e.g.
  `DQ HQ`, `H10 S9`. Card notation is **suit-letter then rank**, e.g. `D7`=7 of diamonds, `CJ`=jack of
  clubs — the reverse of the far more common rank-then-suit convention (`7d`, `Jc`). **Ten is always the
  two-character token `10`, never `T`** (confirmed in multiple real samples, both normal and DataMiner
  dialect, e.g. `H10 S9`, `c10`). DataMiner dialect additionally lowercases the suit letter (`c10 hK s5`)
  where the normal dialect uppercases it (`D7 C4 CJ`) — a real, confirmed, dialect-specific difference.
- No `mucks`/`shows` textual verb exists at all — reveal-vs-muck is entirely inferred from whether
  `<cards type="Pocket">` content is masked (`X X...`) or real card text, there's no separate boolean flag
  for it.

## 9. SUMMARY / pot / rake

**No separate summary section or rake figure exists anywhere in the XML** in any real sample. The
player's net result for the hand is only available via the `win="€X"` attribute on that player's
`<player>` element inside `<game><general><players>` — a per-player total, not a line-item pot breakdown.
Side-pot/main-pot attribution is not separately represented; only the final `win=` total per player is
available. This is a materially different (much sparser) result representation than every plain-text
network in this project.

## 10. Date/time format and timezone convention

`<startdate>2014-01-06 11:49:59</startdate>` — `YYYY-MM-DD HH:MM:SS`, 24-hour, **no timezone information
anywhere in the document**. Two `<startdate>` elements exist per hand: one in the outer `<session><general>`
block (session/table creation time) and a second, later one inside `<game><general>` (this specific hand's
start time) — do not conflate the two.

## 11. Anonymized-player conventions

The **only** real anonymization mechanism found is the hole-card masking described in §8
(`X X`/`X X X X` in place of real cards) — this masks *cards*, not *player names*; usernames are always
real-looking handles in every sample, never replaced with placeholders, in both the normal and DataMiner
dialects. The DataMiner dialect's `sessioncode="123456"` placeholder value and heavily sanitized
`<tablename>Andreapol__No_DP_</tablename>` (underscores replacing spaces/parentheses) suggest the
data-mining/aggregation tool that emits this dialect does some table-identity scrubbing, but does not
scrub player names.

## 12. File naming, export directory, hands per file, encoding

- Encoding: UTF-8 with BOM confirmed in every real sample (`file` reports "XML 1.0 document text, Unicode
  text, UTF-8 (with BOM)"). The DataMiner dialect also carries the BOM despite omitting the `<?xml ?>`
  declaration — BOM and declaration presence are independent, confirmed real.
- Multi-hand files: **two structurally incompatible real conventions exist** — (a) one `<session>` root
  with N sibling `<game gamecode="...">` children (confirmed real, `10-ten-hands-single-session-multi-
  game.xml`, 10 games under one session), and (b) N complete, independent `<?xml ?><session>...</session>`
  documents concatenated with no shared wrapper at all (confirmed real,
  `06-minerformat-concatenated-documents.xml`, 4 full documents back-to-back). A parser must detect and
  handle both; treating (b) as a single XML document to parse with a standard XML library will throw a
  well-formedness error (multiple root elements / multiple XML declarations).
- No default export directory or file-naming convention was confirmed from any source; secondary sources
  (`hhdealer.com` blog, found via web search) mention hands are "usually saved as .txt or sometimes .xml"
  and tournament hands typically go to a separate `Tournament` subfolder, but this wasn't independently
  verified against a real installation.

## 13. Gotchas

- **Three real, structurally distinct XML dialects coexist** (normal/pretty-printed, unformatted-single-
  line, DataMiner) — see §2 for the exact distinguishing checks. A parser tuned only against
  pretty-printed samples will break on either of the other two.
- **Two incompatible multi-hand-per-file conventions exist** (single-session/multi-game vs. concatenated
  standalone documents) — see §12. Untangling this wrong is the single most likely way a naive
  "load file as one XML document" implementation fails outright rather than just mis-parsing a field.
- **`<tablecurrency>` and `<currency>` can legitimately disagree**, confirmed real in two independent
  samples — do not treat one as a redundant copy of the other, and do not assume either is always
  populated (the normal dialect leaves `<currency>` empty in most real samples).
- **The nicknamed "hero" player's own cards are masked exactly like anyone else's** when that hero folds
  before showdown — do not assume `<nickname>` implies visible cards.
- **Card notation is suit-then-rank, uppercase in the normal dialect, lowercase in DataMiner** — the
  reverse of the rank-then-suit convention most other sites in this project use — and **Ten is always
  `10`**, a two-character rank token, never `T`.
- **DataMiner-dialect self-closing `<action>` tags have no space before `/>` and omit the `cards`
  attribute entirely** — an XML-attribute-presence check (`cards="..."` exists) that works on the normal
  dialect will silently misbehave (attribute simply absent, not empty-string) on DataMiner files.
- **`no=` attribute values on `<action>` elements are not guaranteed to match document order** — sort by
  `no=` before treating actions as chronological, don't just take them in the order they appear in the
  file.
- **No rake or pot-breakdown data exists anywhere** — only a single net `win=` total per player per hand.
  Any downstream format that requires an explicit rake or side-pot figure cannot be losslessly derived
  from iPoker XML alone.
- **Unknown `type=` action codes exist by the shipped parser's own admission** (types 6 vs 7 for all-in
  are acknowledged in the parser source as indistinguishable) — don't assume the type table in §8 is
  exhaustive for builds/skins not represented in this corpus.
- **Tournament and Speed/fast-fold formats are entirely unconfirmed** — no real sample, no usable
  secondary-source content beyond a vague mention that tournament files live in a different folder. Flag
  any parser code claiming to support either as unvalidated against real data.

## 14. Sample index

| file | demonstrates |
|---|---|
| 01-basic-hand-pl-omaha-eur.xml | Baseline normal dialect, EUR, masked non-hero cards |
| 02-hero-nickname-masked-preflop.xml | Nicknamed hero still masked when folding preflop |
| 03-ante-gbp-currency.xml | `type="15"` ante actions, GBP |
| 04-unformatted-single-line-whitespace-variant.xml | Dialect #2: zero-whitespace single-line document |
| 05-dataminer-format-variant.xml | Dialect #3: DataMiner (no `<?xml?>`, no `tablecurrency`, lowercase cards) |
| 06-minerformat-concatenated-documents.xml | 4 standalone `<?xml?><session>` docs concatenated |
| 07-invalid-truncated-currency-mismatch.xml | Truncated mid-`<game>`; `tablecurrency`/`currency` disagree |
| 08-unmasked-showdown-cards-no-dp-table.xml | Unmasked showdown cards, `(No DP)` table-name qualifier |
| 09-omaha-no-dp-heads-up-table.xml | 4-card Omaha unmasked, confirms `10` (not `T`) for Ten |
| 10-ten-hands-single-session-multi-game.xml | 1 `<session>`, 10 sibling `<game>` elements |
| 11-euro-table.xml | EUR `<gametype>` token format |
| 12-gbp-table-currency-mismatch.xml | Second real instance of `tablecurrency`/`currency` disagreement |
| 13-fixed-limit-holdem.xml | Fixed-limit (`L`) game-type token |
| 14-pot-limit-omaha.xml | Pot-limit Omaha `<gametype>` token |
| 15-heads-up.xml | 2-player `<players>` block |

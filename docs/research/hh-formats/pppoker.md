# PPPoker — hand history format

## 1. Overview & status — READ THIS FIRST

**No text hand-history export format for PPPoker was found anywhere — on
the platform, in any open-source parser project, or in any converter
vendor's documentation — and the weight of evidence across independent
sources indicates none exists.** This is the headline finding for this
platform and it is a *negative* finding, stated loudly on purpose per this
research project's rules: it is better to say "not found, here is the
evidence" than to guess a grammar and let a parser silently mangle real
hands.

**No fixtures directory was created for PPPoker** (no
`fixtures/samples/pppoker/`) because no real bytes of any PPPoker hand
history — native or converter-produced — were located. Everything below is
either (a) what PPPoker itself exposes as **structured data** (JSON, not a
human-readable hand-history text grammar), reverse-engineered by a
third-party open-source tool, or (b) descriptions of how the HUD/converter
ecosystem works around the absence of a text format. Nothing here should be
read as "PPPoker's hand history format is X" — read it as "this is what
exists instead."

### Evidence trail

- **fpdb** (an actively maintained open-source poker database/parser
  project that has dedicated site parsers for `Run It Once Poker`,
  `PokerBros`, `SupremaPoker`, `PokerMaster`, `MPLPoker`, `BetOnline`, and
  more) has **zero** mention of PPPoker anywhere in its source
  (`fpdb_3_legacy/PokerStarsToFpdb.py`'s multi-site `SITE` regex alternation
  does not include PPPoker; a full-repo grep found nothing). If PPPoker
  hands were circulating in any parseable text form, this project — which
  actively chases exactly this kind of obscure club-app format — would very
  likely have it.
- GitHub code search for `PPPoker` combined with hand-history-shaped
  strings (`"Seat 1"`, `"Hand #"`) turns up **nothing** except one
  unrelated project (`botarbitrage/PPPokerHA`, see below) — no sample
  files, no regression fixtures, no parser source.
- **PPPoker officially banned third-party software (HUDs, converters) in
  2021.** The platform ships its **own built-in HUD** instead — which
  needs no portable file format at all, because the stats are computed
  and displayed server/client-side without ever exporting a
  human-readable log.
- Despite the ban, a commercial ecosystem still operates: "PPPoker HUD
  Catcher," DriveHUD's "Asian Hand Converter," and Hand2Note's "ASIA"
  add-on all advertise PPPoker support. None of their public marketing
  pages disclose their capture mechanism (screen scraping vs. memory
  reading vs. network interception) — this was explicitly checked and
  found undocumented in every public page fetched during this research.
  They universally require running the Android app inside a Windows
  emulator (LDPlayer, BlueStacks, Nox) rather than reading a file the app
  wrote to disk.
- **The one genuine technical exception found:** `botarbitrage/PPPokerHA`
  (GitHub, a live small SaaS "hand tracker" product, unrelated to this
  repository or its author) has reverse-engineered PPPoker's **raw JSON
  data model** — the platform does expose structured hand data as JSON,
  either via **"Data → JSON export" in the app itself**, or via
  **`/api/export/json/*` endpoints**, per that project's own internal
  documentation (`docs/pppoker-action-model.md`). This is real,
  substantive secondary evidence that PPPoker's actual native "hand
  history" is a JSON object model, not a text grammar at all — see §3 for
  the schema, reconstructed from that project's source
  (`hand_parser.py`, `hand_exporter.py`, `test_hand_exporter.py`), which
  that project's own docs describe as "battle-tested end-to-end... its
  output has been imported into PokerTracker 4 at scale (3,454 hands)."
  No actual JSON payload (real captured bytes) was published anywhere in
  that repo, however — only the code that consumes it. So even this
  evidence is "the shape of the data, inferred from a consumer," not a
  captured raw sample.

### What people actually use instead

1. **PPPoker's own built-in HUD** — no export needed, stats computed live.
2. **Club-admin backend exports** — PPPoker club owners/agents can pull
   session/results reports for their club from the agent backend; no
   evidence was found that this is a hand-by-hand history (more likely
   player win/loss and rake summaries) — unconfirmed either way, flagged
   rather than guessed at.
3. **Third-party "Asian Hand Converters"** (DriveHUD, Hand2Note ASIA,
   dedicated "PPPoker HUD Catcher" tools) running against an Android
   emulator, which capture hand data by an undisclosed mechanism and
   re-emit it in a **PokerStars-style, iPoker-style, or "Asian poker
   clubs"-style text dialect of their own invention**, purely so existing
   PT4/HM3/DriveHUD/fpdb-style parsers can ingest it. This is functionally
   identical in spirit to what was found for PokerBros (see
   `pokerbros.md`) — the difference is that for PokerBros, real converter
   *output* bytes were recoverable (via fpdb's regression tests); for
   PPPoker, none were.
4. **`botarbitrage/PPPokerHA`-style hand trackers**, which import a
   PPPoker **"replay link"** (a shareable hand-review URL the app itself
   generates) and hit PPPoker's own JSON API to pull structured data,
   which they then optionally re-render as a synthetic PokerStars-style
   text block purely as an interchange format for PT4/GTO Wizard, never as
   a claim about what PPPoker natively produces.

## 2. Detection signature

**N/A — no confirmed native text export.** If a converter's synthetic
output is ever encountered, be aware that at least one real tool
(`PPPokerHA`'s exporter, per its own source) **fabricates a
`PokerStars Hand #<id>: ...` header verbatim**, i.e. it deliberately
impersonates PokerStars' site name for parser compatibility. **Do not
use `PokerStars Hand #` as a PPPoker detection signature** — a file with
that header could genuinely be from PokerStars, or could be PPPoker data
laundered through this specific converter. There is no reliable string to
detect "this text file originated as PPPoker data" in general, because
every tool in this space is free to invent its own header.

## 3. Reverse-engineered JSON data model (illustrative — NOT a captured sample)

The following is reconstructed from reading `botarbitrage/PPPokerHA`'s
source code (`hand_parser.py`, `hand_exporter.py`,
`docs/pppoker-action-model.md`, `test_hand_exporter.py`), retrieved
2026-09-17. It describes the shape that project's authors say PPPoker's
`/api/export/json/*` / in-app "Data → JSON export" returns. **No real
payload was published in that repo** — this is inferred from a consumer,
not a captured sample, and is reproduced here only as a starting point for
whoever eventually gets real PPPoker JSON bytes to compare against. It is
deliberately NOT placed in `fixtures/samples/pppoker/` as a fixture,
synthetic or otherwise, because a schema sketch inferred from someone
else's parser code is a different (weaker) kind of evidence than even a
labeled-synthetic hand, and mislabeling it as a fixture would overstate its
reliability.

Top-level record shape (per hand):
```
{
  "summary": {
    "D": "<game-id>",           // e.g. "G-<tourney>-<n>" for MTT hands
    "C": <unix-timestamp>,
    "G": <small-blind-raw>,     // raw units, 100x display scale
    "A": <ante-raw>,
    "B": [<card-code>, ...],    // hero hole cards, raw encoding (fallback path)
    "H": <profit-raw>           // hero's net result for the hand
  },
  "share_key": "<replay-link-token>",
  "full_hand": {
    "info": {
      "room": {
        "small_blind": <raw>, "ante": <raw>,
        "dealer_seatid": <int>,
        "room_name": "<club/table name>",
        "mtt": {"table_num": "<n>"}   // present only for MTT hands
      },
      "players": [
        {"seatid": <int>, "user_name": "<str>", "hand_chips": <raw>,
         "uid": "<str>", "isSelf": <bool>}
      ],
      "cards": [<card-code>, ...]    // hero hole cards, primary path
    },
    "flow": {
      "pre_flop": {"actions": [{"seatid": <int>, "type": <int>, "chips": <raw>, "hand_chips": <raw>}, ...]},
      "flop":     {"cards": [<card-code>, ...], "actions": [...], "chips_back": [{"seatid": <int>, "chips": <raw>}]},
      "turn":     {"cards": [...], "actions": [...], "chips_back": [...]},
      "river":    {"cards": [...], "actions": [...], "chips_back": [...]},
      "show_hands":   [{"seatid": <int>, "code": [<card-code>, ...]}],
      "winning_info": [{"seatid": <int>, "chips": <raw>, "poolid": <int>}]
    }
  }
}
```

Card encoding (per that project's `hand_exporter.py`): `code = suit*256 +
rank`, rank `2..14` (`14 = Ace`, `T/J/Q/K/A` for `10..14`), suit map
`{1: diamonds, 2: clubs, 3: hearts, 4: spades}`. All chip amounts are
**raw integers at 100× the displayed currency amount** (divide by 100 to
get the real number).

Action `type` codes (per that project's own audited table,
`docs/pppoker-action-model.md`, itself the product of resolving a
disagreement between two internal modules by cross-checking against
successful PT4 imports — i.e. this table is the more battle-tested of two
candidate interpretations that project considered, not a vendor spec):

| type | meaning |
|-----:|---|
| 1 | fold |
| 2 | check |
| 3 | call (amount called; occasionally 0 = no-op; occasionally exceeds current bet = all-in re-raise in call's clothing) |
| 4 | raise (raise-**to** total; occasionally encoded incrementally instead — see caveat below) |
| 7 | bet |
| 8 | post small blind |
| 9 | post big blind |
| 10 | post ante |
| 12 | fold variant (fold-and-muck) |
| 13 | check variant (first-to-act check) |
| 100 | system event (no chip meaning) |

All-in is not its own code — it's inferred when `hand_chips == 0` (the
acting player's stack after the action) with `chips > 0` on that action.
The same source notes real-world messiness worth carrying into any future
parser: type-4 raises are "occasionally incremental (excludes the blind
already posted)" rather than cumulative, requiring an increment-vs-total
heuristic to disambiguate; type-3 calls occasionally exceed the current
bet size (encoding an all-in reraise); and chip amounts sometimes need
capping to the player's remaining stack to reconcile. These are described
as real, observed messiness in that project's data, not hypothetical edge
cases — take them as a warning that PPPoker's raw data is not clean even
by structured-JSON standards, let alone whatever a text serialization of
it would look like.

## 4-10. Grammar sections

**N/A for all of: header grammar, table/seat lines, blinds/antes,
street markers, action verbs, SUMMARY layout, date/time format.** No
confirmed native or even converter-output text sample exists to describe
these from (contrast with `pokerbros.md`, where real converter output
bytes were recovered and these sections are filled in from them).

## 11. Anonymized-player conventions

Unknown — no sample.

## 12. File naming + export directory + hands per file + encoding/line endings

Unknown for any native export. The in-app feature is a **"Data → JSON
export"** per third-party reverse-engineering (§1, §3); no filename
convention, directory, or hands-per-file behavior was documented anywhere
found.

## 13. Gotchas

- **Do not invent a PPPoker text grammar.** Every text-format PPPoker hand
  a parser will ever see in the wild is converter output, and every
  converter is free to invent its own dialect and even its own fake site
  name in the header (§2). A robust ingestion pipeline for "PPPoker data"
  should probably target the **JSON shape** (§3) if it can get access to
  it (e.g. via a club-admin JSON export or a replay-link API), rather than
  trying to reverse-engineer yet another converter's bespoke text dialect.
- If a `PokerStars Hand #...` file is ever suspected of actually being
  laundered PPPoker data, look for tells inconsistent with genuine
  PokerStars hands: chip amounts with no cents precision beyond what 100×
  scaling would produce, `Table 'X Y'` names matching PPPoker's `<tourney>
  <table_num>` convention, or rake always computed as `0` when a hand
  looks like a real-money cash game (some converters don't reconstruct
  rake at all).
- PPPoker's official 2021 anti-third-party-software policy means any
  converter-based pipeline built against it is working against the
  platform's terms of service — worth flagging to whoever consumes this
  research, independent of the technical format question.

## 14. Sample index

**None.** `fixtures/samples/pppoker/` was not created. This is the stated,
deliberate outcome of this research track for this platform — see §1.

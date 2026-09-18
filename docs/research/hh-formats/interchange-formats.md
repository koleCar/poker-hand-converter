# Community interchange formats (secondary research)

Scope note: this doc covers what the main brief calls "secondary, if time allows" — Hand2Note, DriveHUD, the de-facto "PokerStars format" convention, and open JSON/text hand-history schemas in circulation. It is not exhaustive; effort was concentrated on the PHH spec since it has a real, versioned specification and a public test corpus, which the brief flagged as the most valuable find in this category.

## 1. The de-facto "PokerStars format" as community interchange

There is no formal body governing this, but strong circumstantial evidence (multiple independent open-source projects, unrelated to each other) shows the community treats **PokerStars' own hand-history text grammar as the default target format** when converting from anything else:

- `global-poker-hand-history-converter` — converts Global Poker hands to PokerStars format, explicitly so they can be imported into PT4 (https://github.com/mr-feek/global-poker-hand-history-converter).
- `pn2ps` — "Convert PokerNow.club logs into PokerStars hand history format" (https://github.com/pj4533/pn2ps).
- `pokernow-handhistory-converter` — "Java program to convert pokernow.com logs into Pokerstars hand histories. Enables direct use with popular poker tracking and statistical analysis programs." (https://github.com/evolutionsoftswiss/pokernow-handhistory-converter).
- `handhistoryconverter` — "Converter from AI [America's Cardroom] hand histories to PokerStars Hand histories" (https://github.com/chrisalvino/handhistoryconverter).

Retrieved via GitHub/web search 2026-09-17. This corroborates the working assumption already implicit in this repo's design (a PokerStars-shaped canonical output is a reasonable default target) but is **not itself a spec** — it's an emergent convention with no authority behind it, and every converter above targets PokerStars' grammar informally/by imitation rather than against a published grammar document.

## 2. PHH — Poker Hand History File Format Specification (real spec, real corpus)

**Status: a genuine, versioned, human-authored specification with an open reference implementation and a real multi-thousand-hand dataset.** This is the strongest find in the secondary research track.

- Spec site: https://phh.readthedocs.io/en/stable/ (current version 0.0.2 as titled on the docs)
- Academic writeup: Kim, "Poker Hand History File Format Specification," https://arxiv.org/abs/2312.11753
- Spec source repo: https://github.com/uoftcprg/phh-std
- Reference parser/writer: `pokerkit` Python package — https://github.com/uoftcprg/pokerkit, https://pokerkit.readthedocs.io/en/0.5/notation.html — provides `load`/`dump` APIs analogous to Python's `json`/`pickle`.
- Dataset: https://github.com/uoftcprg/phh-dataset — "over 10,000 hands covering 11 different variants," organized under `data/` including curated single-file examples (Dwan/Ivey, Arieh/Yockey, Antonius/Blom, a Wikipedia Badugi illustration) plus large nested corpora for WSOP 2023, a Pluribus AI-vs-human dataset, and "handhq" — I did not fully enumerate the nested WSOP/Pluribus/handhq trees (they are deeply subfoldered, e.g. `data/wsop/2023/43/5/...`, likely hundreds-to-thousands of files) since 4 curated top-level examples were sufficient to demonstrate the grammar for this repo's purposes.

### Format shape

PHH is **TOML** (not JSON, not a bespoke line-oriented grammar like site hand histories). A file is a set of top-level key/values; the spec (`spec.rst` in phh-std) defines ~35 named fields split into required (`variant`, `antes`, `blinds_or_straddles`, `bring_in`, `small_bet`, `big_bet`, `min_bet`, `starting_stacks`, `actions`) and optional (everything describing venue/time/players/money context: `author`, `event`, `url`, `venue`, `address`, `city`, `region`, `postal_code`, `country`, `time`, `time_zone`, `time_zone_abbreviation`, `day`/`month`/`year`, `hand`, `level`, `seats`, `seat_count`, `table`, `players`, `finishing_stacks`, `winnings`, `currency`, `currency_symbol`, `ante_trimming_status`, `time_limit`, `time_banks`).

The `actions` field is an array of short tokenized strings, one action per line, e.g.:
```
"d dh p1 Ac2d"   # dealer deals hole cards to player 1
"p3 cbr 7000"    # player 3 bets/raises to 7000
"p2 f"           # player 2 folds
"p3 cc"          # player 3 calls/checks
"d db Jc3d5c"    # dealer deals board (flop)
"p1 sm Ac2d"     # showdown/show
```
Player references are positional (`p1`, `p2`, ...) ordered clockwise from the first player dealt a hole card, not by seat number — see `spec.rst` "Position" section. This is a materially different action-log style from any site's plain-English hand history text (PokerStars-style `Player1: raises $700 to $1400`) — PHH is a compact instruction stream, not free text, and would need a dedicated PHH reader/writer if this project ever wants to consume or emit it (real files retrieved as fixtures — see §4).

### Relevance to this project

PHH is a plausible **canonical intermediate representation** candidate if the project ever wants a structured (not site-text) internal format — it already handles multiple non-holdem variants (badugi, deuce-to-seven triple draw, stud-style games) that plain PokerStars-style text does not cleanly generalize to. It is not, however, anything any tracking software or poker site currently emits natively — it's an academic/hobbyist standard, not an interchange format any of PT4/HM3/poker sites actually produce. Treat it as a possible target design reference, not as an input format converters need to parse from real user-submitted files (unless a user is specifically a `pokerkit` user).

## 3. Open Hand History (OHH) — a second JSON schema in circulation

Found during research, not in the original brief's named list, but relevant to "any JSON schema in circulation":

- Spec site: https://hh-specs.handhistory.org/ (also references a companion "Standardized Tournament Summary" spec at https://handhistory-org.gitbook.io/standardized-tournament-summary/)
- Format: JSON object, versioned (`spec_version`, e.g. `"1.4.7"` seen in the wild — see below).
- Top-level fields (per the spec page, retrieved via automated fetch 2026-09-17, so treat exact field list as accurate-but-not-independently-verified against raw JSON): `spec_version`, `site_name`, `network_name`, `internal_version`, `tournament` (bool), `tournament_info`, `game_number`, `start_date_utc`, `table_name`, `table_handle`, `table_skin`, `game_type`, `bet_limit`, `table_size`, `currency`, `dealer_seat`, `small_blind_amount`, `big_blind_amount`, `ante_amount`, `hero_player_id`, `flags`, `players`, `rounds`, `pots`, `tournament_bounties`.
- Real-world implementation evidence: the `rs-poker` Rust crate (https://github.com/elliottneilclark/rs-poker) has a full `open_hand_history` module (`hand_history.rs`, `reader.rs`, `writer.rs`, `anonymize/`) hard-coding `spec_version: "1.4.7"`, confirming this is an actively-used schema, not just a paper spec. A TypeScript implementation also exists: https://github.com/homanp/ohh.
- **I could not obtain a real, byte-accurate sample OHH JSON hand file** within this research pass — no literal JSON fixture was found embedded in either the `rs-poker` or `homanp/ohh` repos (both only contained typed struct/interface code, not example data), and I did not locate a public sample-hands corpus for OHH analogous to `phh-dataset`. This is recorded as a gap, not filled with a constructed example — no OHH fixtures were added.
- OHH's origin is widely associated with Amaya/PokerStars-era HUD-interoperability efforts (multiple third-party mentions), but I did not find a primary source confirming authorship/ownership within the time budget for this secondary track — flagged as unconfirmed rather than stated as fact.

## 4. Hand2Note / DriveHUD

Minimal findings — these were the lowest-priority items in the brief and research time was concentrated on PHH per the stated priority. What was found:

- Both are trackers in the same category as PT4/HM3 (auto-import from site hand-history folders into a local database, HUD overlay, stats).
- Hand2Note documents importing directly from a **DriveHUD 2 database** (cross-tool DB import), implying at least DriveHUD's schema is known/reverse-engineered by Hand2Note's developers, but no schema details were surfaced in search results.
- No evidence was found of either product having a distinct hand-history *text* export grammar of its own — consistent with the PT4/HM3 pattern (site text in, site text or DB rows out), but this is **inference by category analogy only, not confirmed for either product** the way it was confirmed for PT4. Do not treat this as established; flagged explicitly as unresearched beyond this paragraph.
- DriveHUD has a documented "How do I export my hand histories?" KB page (https://drivehud.com/dh2-knowledge-base/how-do-i-export-my-hand-histories/) which was not deep-dived; noted as a lead for future research if these two products become higher priority.

## 5. Sample index

Real fixtures were added only for PHH (§2), under `fixtures/samples/phh/` — see `fixtures/samples/phh/SOURCES.md` for full provenance. No fixtures were added for OHH, Hand2Note, or DriveHUD (no real samples obtained; see gaps noted in §3 and §4 above).

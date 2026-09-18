# Unibet Poker — sample sources

Unibet has no presence at all in the local HHSmithy corpus, and this project's own web-forum fetches
(Unibet Community forum, PokerStrategy forum) returned HTTP 403 for every thread tried — those sites
block automated fetching. The samples below instead come from two actively-maintained open-source
**fpdb** (Free Poker DataBase) hand-history-importer forks, which both ship their own Unibet parser
(`UnibetToFpdb.py`) plus test fixtures. Both projects' authors state or clearly imply these fixtures were
derived from real captured hands (see per-row notes on anonymization), which is a materially stronger
provenance than a random forum transcription — but it is still second-hand (extracted from another
project's test suite, not fetched directly from a Unibet account by this project). Marked **REAL** below
because the originating projects assert real-world derivation and the two independent sources
(different authors, different repos, four years apart) agree with each other on every structural point
that overlaps (header shape family, street markers, summary layout, absence of a data-mining/anonymized
alternate dialect) — but treat this network's documentation as one tier below the direct-corpus sites in
this project.

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-cash-nlhe-banzai-2021-cp1252.txt | https://raw.githubusercontent.com/ChazDazzle/fpdb-chaz/c8a0f99da4e540ecfe63da87e6088bfe4c0a637c/pyfpdb/regression-test-files/cash/Unibet/Flop/NLHE-EUR-0.05-0.10-202104.Banzi.txt | 2026-09-17 | REAL | Byte-exact as stored in that repo: single-byte-encoded (Windows-1252/ISO-8859-1-family), € rendered as raw byte `0x80`, not UTF-8. "Legacy" 2021-era header shape: `Game #<id>: Table <CUR><n> <LIMIT> - <SB>/<BB> - <GAME> - <HH:MM:SS> <YYYY>/<MM>/<DD>`. Also the Banzai (Unibet's fast-fold product) game-type token |
| 02-cash-nlhe-banzai-2021-utf8.txt | https://raw.githubusercontent.com/jejellyroll-fr/fpdb-3/9a0f3091fd0cfb2fcef7a9c1428f9c7c81fd2158/tests/fixtures/hands/unibet/banzai.txt | 2026-09-17 | REAL | Same hand as file 01 (identical game ID `1463192545`, identical content), re-published by a second, independent fork with the € sign correctly UTF-8 encoded — confirms file 01's `0x80` bytes are a real single-byte-encoding artifact of that hand's original export, not corruption introduced by either GitHub repo; also confirms the parser's own declared `codepage = ("utf8", "cp1252", "ISO-8859-1")` tuple (i.e. this network's real-world exports are seen by that project's maintainer in more than one encoding) |
| 03-cash-plo-2026-two-hands-anonymised.txt | https://raw.githubusercontent.com/jejellyroll-fr/fpdb-3/9a0f3091fd0cfb2fcef7a9c1428f9c7c81fd2158/test/test_unibet_legacy_2026.py (the `SAMPLE` string literal) | 2026-09-17 | REAL (player names anonymised by the upstream author; the docstring states "real € sign, hero suffix kept" — structure, header grammar, and the hero session-token suffix are asserted as preserved from a real captured hand) | Current-era (2026) header shape: `Unibet Hand #<id> - <SB>/<BB> - <GAME> - UTC <HH:MM:SS> <YYYY>/<MM>/<DD>` with a quoted numeric table name and explicit `N-max`; 4-card PLO; a player sitting out in the seat list (`(sitting out)`); the hero username carrying a literal `[Unibet_<sessiontoken>]` suffix on every occurrence; `*** Showdown ***` as its own explicit street heading (contrast with cash hands that never reach showdown, which have no such heading); second hand in the file ends on a preflop fold with `Dealt in <name>` for players never shown a hand |
| 04-tournament-nlhe-2026-anonymised.txt | https://raw.githubusercontent.com/jejellyroll-fr/fpdb-3/9a0f3091fd0cfb2fcef7a9c1428f9c7c81fd2158/test/test_unibet_legacy_2026.py (the `TOUR_SAMPLE` string literal) | 2026-09-17 | REAL (anonymised, same basis as file 03) | **Tournament header**, the one format entirely unfound for partypoker/888/iPoker in this project: `Unibet Hand #<id>, Tournament #<tourneyid>, <CUR><buyin> + <CUR><fee> - <sb>/<bb> - <game> - Total prize <CUR><prize> - UTC <time> <date>`; chip-count stacks/bets/pots with NO currency symbol at all (contrast with the cash-game hand, which always has one); `wins <chips>` with no "from main/side pot" suffix on a single-winner hand |
| 05-tournament-summary-2026-anonymised.txt | https://raw.githubusercontent.com/jejellyroll-fr/fpdb-3/9a0f3091fd0cfb2fcef7a9c1428f9c7c81fd2158/test/test_unibet_legacy_2026.py (the `SUMMARY_SAMPLE` string literal) | 2026-09-17 | REAL (anonymised, same basis as file 03) | A **separate tournament-summary file format**, distinct from the hand-history file: `=== TOURNAMENT SUMMARIES ===` banner, `Unibet Tournament #<id>, <game>`, `Buy-In: <CUR><buyin> + <CUR><fee>`, `<n> players`, `Total Prize Pool: <CUR><amount>`, `Tournament started <date> <time> UTC`, then one `<rank>: <name> finished [<CUR><amount>]` line per entrant (blank amount for players who won nothing), and a final `You finished in <rank><ordinal> place.` line addressed to the account owner |

## What was not found (state explicitly, do not paper over)

- No sample was obtained by this project directly from a Unibet account, from a raw forum post, or from
  any hand-converter tool's published example — every Unibet forum thread searched returned HTTP 403 to
  automated fetching (Unibet Community, PokerStrategy).
- No pre-2019 (pre-Relax-Gaming) Unibet sample was found. A `UnibetIPoker(iPoker)` class exists in the
  `fpdb-3` codebase (`fpdb_3_legacy/iPoker/skins/unibet.py`, `site_id = 87`), which is real secondary
  evidence that Unibet has, at some point, run a skin on the iPoker/Playtech network (see
  `docs/research/hh-formats/unibet.md` for the important caveat that this is a *different* poker
  product/room from the plain-text "Game #.../Unibet Hand #..." format documented here, not an earlier
  version of the same file format).
- No sample of any Omaha Hi/Lo, Stud, or mixed-game Unibet hand was found (only NLHE and PLO).
- No confirmation of file-naming convention or default export directory on a real installed client —
  only the regression-test file's own name (`NLHE-EUR-0.05-0.10-202104.Banzi.txt`), which is a convention
  imposed by the fpdb-chaz project itself for organizing its own test corpus, not evidence of what Unibet
  itself names exported files.

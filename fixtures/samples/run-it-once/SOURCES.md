# Run It Once Poker — fixture sources

Run It Once Poker (Phil Galfond's site) closed permanently in 2022. No live
site exists to pull fresh samples. These 4 fixtures are real regression-test
files from the open-source **fpdb** ("Free Open Source Poker Database")
project, which shipped a dedicated `Run It Once Poker` site handler
(`site_id = 26`) inside its PokerStars-family parser
(`fpdb_3_legacy/PokerStarsToFpdb.py`, see the `SITE` regex alternation that
includes `Run\sIt\sOnce\sPoker` and the `elif mg["SITE"] == "Run It Once
Poker":` branch). Retrieved via `curl -s <raw-githubusercontent-url> -o file`
(byte-exact, no WebFetch/markdown conversion involved).

Repo: `https://github.com/jejellyroll-fr/fpdb-3` (also mirrored verbatim in
`ChazDazzle/fpdb-chaz` and `Mudr0x/fpdb-reloaded` — same bytes in all three,
cross-checked).

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-cash-nlhe-splash-the-pot-mucked-showdown.txt | `github.com/jejellyroll-fr/fpdb-3/raw/master/regression-test-files/cash/Stars/Flop/NLHE-6max-EUR-0.05-0.10-201906.RIO.STP.txt` | 2026-09-17 | REAL | Cash NLHE EUR, `STP added: €0.50` (PokerStars/RIO "Splash the Pot" promo money), mucked win at showdown, dual timezone header `UTC [... CET]` |
| 02-cash-plo-splash-the-pot-sidepot-showdown.txt | `.../cash/Stars/Flop/PLO-6max-EUR-0.25-0.50-201908.RIO.STP.side.pot.txt` | 2026-09-17 | REAL | Cash PLO EUR, multi-way all-ins, side pot, STP, `*** SHOWDOWN ***` (note: RIO spells this as one word, unlike PokerStars' `*** SHOW DOWN ***`), hand shown twice in source text (duplicate `Ricky N shows [...]` line — preserved verbatim, appears to be an RIO export quirk, not an artifact of collection) |
| 03-tournament-nlhe-3max-hand.txt | `.../tour/Stars/Flop/NLHE-3max-EUR-5-202104.RIO.txt` | 2026-09-17 | REAL | Tournament hand, header includes `Tournament #158168, €4.69+€0.31 Cub3d`, chip-only blinds (no currency symbol on in-tournament amounts), `[hero]` tag appended directly to the hero's `Seat N:` line (in addition to the usual `Dealt to <name> [...]`) |
| 04-tournament-summary-sng.txt | `.../summaries/Stars/NLHE-STT-EUR-5-202104.RIO.txt` | 2026-09-17 | REAL | Tournament **summary** file (not a hand file) — separate file format for SNG/STT results: buy-in, finishing order, payouts, "You finished in Nth place (eliminated at hand #N)" |

## Encoding note

All four files are valid UTF-8 with the € sign as the 3-byte sequence
`E2 82 AC` (verified with `xxd`/`file`) — no BOM, LF line endings on the ones
checked. If a terminal shows mangled bytes for these files, that is a
terminal/locale display artifact, not a problem with the files; do not
"fix" the euro sign.

## Secondary evidence (not copied as a fixture, cited for the doc)

`fpdb_3_legacy/PokerStarsToFpdb.py` in the same repo contains the full
Run-It-Once-aware parser: header regex, `site_id = 26`, `readSTP()` for the
Splash-the-Pot line, and shares nearly all machinery with the PokerStars
parser (RIO's hand-history grammar is a close PokerStars derivative — this
matches the site's own reputation at the time as "the PokerStars-format
clone room"). Also of note: the same `SITE` regex alternation additionally
recognizes `PokerMaster`, `SupremaPoker`, `PokerBros`, `BetOnline`,
`MPLPoker` as PokerStars-format dialects — evidence used in
`docs/research/hh-formats/club-apps-misc.md`.

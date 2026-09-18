# PokerBros — fixture sources

PokerBros is a live mobile club app with **no direct public download path** for
raw hand histories (see `docs/research/hh-formats/pokerbros.md` for the full
negative-finding writeup). These 2 fixtures are the only real bytes found —
both are regression-test files from the open-source **fpdb** project, and both
encode the **exact same underlying hand** (same cards, same bet sizes, same
board) in two different output dialects, which is itself the key finding:
third-party PokerBros converters can emit either dialect from one captured
hand.

Repo: `https://github.com/jejellyroll-fr/fpdb-3` (byte-identical copies also
found in `ChazDazzle/fpdb-chaz` and `Mudr0x/fpdb-reloaded`). Retrieved via
`curl -s <raw-githubusercontent-url> -o file` (byte-exact).

| file | provenance URL | date retrieved | REAL / TRANSCRIBED / SYNTHETIC | what it demonstrates |
|---|---|---|---|---|
| 01-cash-nlhe-party-dialect-with-hud-stats.txt | `github.com/jejellyroll-fr/fpdb-3/raw/master/regression-test-files/cash/PartyPoker/Flop/NLHE-USD-0.50-1.00-202103.PokerBros.txt` | 2026-09-17 | REAL | The **partypoker-classic dialect**: header literally `***** Hand History for Game 1111111111 ***** (PokerBros)`, CRLF line endings, seat lines carry an embedded HUD-stat tuple `(VPIP / PFR / 3B / hands)` after the stack, e.g. `Seat 1: Hero ( $122.40 USD ) - (21.60 / 16.35 / 5.71 / 18k)` — this stat tuple is NOT a partypoker feature, it's added by whatever PokerBros-side converter/HUD produced this file |
| 02-cash-nlhe-pokerstars-dialect-same-hand.txt | `.../cash/Stars/Flop/NLHE-6max-USD-0.50-1.00-202103.PokerBros.txt` | 2026-09-17 | REAL | The **same hand** rendered in the PokerStars-family dialect. Header honestly says `PokerBros Hand #1616183514566: ...` (does NOT impersonate "PokerStars Hand #") with UTC timestamp. Players appear by bare numeric ID (`1087383`, `1081005`, ...) rather than nicknames — matches PokerBros' default display-name-is-numeric-UID behavior. `*** SHOW DOWN ***` two words (Stars-style), `and is all-in` suffix, `Total pot $245.80 \| Rake $4.25` |

## What this does and doesn't prove

It proves a PokerBros-sourced hand history **can** exist in text form, close
kin to partypoker's and PokerStars' own grammars, and that at least one
real-world pipeline produces both dialects from the same captured hand
(consistent with the "Asian Hand Converter" family of tools advertising a
choice of "iPoker, PokerStars, or Asian poker clubs" output format — see doc).
It does **not** prove PokerBros' own in-app "Hand History" export (the
6-day-lookback feature confirmed by multiple support threads, see doc) uses
either of these grammars natively — no sample of that raw in-app export was
found anywhere. Names in file 01 (`Hero`, `Player3`..`Player6`) and the
placeholder game ID `1111111111` look like they may have been redacted by the
fpdb contributor who submitted the regression fixture; file 02's numeric
usernames appear unredacted (or PokerBros just displays numeric UIDs by
default). Flagged rather than papered over.

## Secondary evidence (not copied as a fixture, cited for the doc)

`fpdb_3_legacy/PartyPokerToFpdb.py` (site-detection regex includes the
`PokerBros` alternative in its `SITE` group) and
`fpdb_3_legacy/PokerStarsToFpdb.py` (`elif mg["SITE"] == "PokerBros":
self.sitename = "PokerBros"; self.site_id = 29`) in the same repo confirm
fpdb ships first-class parsing support for both PokerBros dialects above.
`fpdb_3_legacy/Configuration.py` and `HUD_config.xml` in the repo also list
`PokerBros` as a configured site (`hh_seats["PokerBros"] = 29`).

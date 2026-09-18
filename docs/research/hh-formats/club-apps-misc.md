# Club/app poker platforms — misc sweep (Suprema, X-Poker, Upoker, KKPoker)

This is a lighter-effort sweep (per task scope: "time permitting") across
four more app/club-based platforms beyond the two primary targets
(PPPoker, PokerBros). **ClubGG is intentionally excluded** — another
research track covers it under the GGPoker family. No fixtures directory
was created for any platform in this document — no real bytes were
recovered for any of them.

## Suprema Poker

**Status: text hand-history format very likely exists, but no real sample
recovered.** This is the strongest lead of the four. The open-source
**fpdb** project's PokerStars-family site-detection regex
(`fpdb_3_legacy/PokerStarsToFpdb.py`, `re_game_info` / `re_identify`)
explicitly includes `SupremaPoker` as a recognized `SITE` alternative
alongside `PokerStars`, `Full Tilt`, `PokerMaster`, `Run It Once Poker`,
`PokerBros`, `BetOnline`, and `MPLPoker` — all confirmed-real dialects in
this same PokerStars-derived family (see `pokerbros.md` and
`run-it-once.md` for two of them confirmed with real bytes). This means
Suprema Poker hands almost certainly appear somewhere as
`SupremaPoker Hand #<id>: ...` in a close PokerStars-style grammar,
produced either natively or by a converter targeting fpdb/PT4 compatibility.
However:
- No regression-test fixture for Suprema exists in the fpdb repos checked
  (`jejellyroll-fr/fpdb-3`, `ChazDazzle/fpdb-chaz`, `Mudr0x/fpdb-reloaded`)
  — only the regex entry, no sample file.
- GitHub code search and web search turned up no real captured Suprema
  hand text anywhere.
- DriveHUD/Ace Poker Solutions market a "Suprema Poker" setup guide for
  their Asian Hand Converter, confirming a converter pipeline exists (same
  emulator-based, undisclosed-capture-mechanism pattern as PPPoker/
  PokerBros), but no output sample was published.

**Conclusion:** treat `SupremaPoker Hand #<id>: <game> (<sb>/<bb>) - ...`
as a plausible, evidence-backed **guess** at the detection signature (by
analogy with the sibling PokerBros/RIO dialects sharing the same regex
family), explicitly **not confirmed** by any real byte. Do not build a
parser against this without first finding a real sample.

## X-Poker

**Status: confirmed no text export exists.** Multiple independent
secondary sources agree: "X-Poker has no .txt export at all" — instead,
players share a **replay link** and paste it directly into third-party
analysis tools (e.g. an "AI coach"/GTO tool), which presumably hit an API
behind that link the same way `PPPokerHA` does for PPPoker replay links
(see `pppoker.md` §1). No parser project (fpdb or otherwise) references
X-Poker at all. This is a clean, confirmed negative finding — no grammar
to guess at, because there is credible direct testimony that no file-based
export exists at all.

## KKPoker

**Status: nothing found — full negative finding.** Hand2Note's own
supported-platforms marketing copy lists KKPoker as an Asian/club app it
integrates with (grouped with PPPoker, PokerBros, Upoker, X-Poker, Red
Dragon, Wepoker, etc.), but no page, forum thread, or open-source project
found during this research says anything concrete about KKPoker's
export mechanism, file format, or even confirms whether a file-based
export exists at all (vs. Hand2Note capturing it live via emulator, as
with PPPoker/PokerBros). No fpdb support, no GitHub hits beyond generic
mentions in club-directory/aggregator repos unrelated to format. Treat as
completely unknown — do not guess.

## Upoker

**Status: nothing found beyond generic "Asian Hand Converter" support —
full negative finding.** Every source found says essentially the same
sentence: Upoker is one more platform the DriveHUD/Hand2Note-style Asian
Hand Converter ecosystem plugs into, with no technical detail about
Upoker's own native format, export mechanism, or whether a file is
produced at all. No fpdb support, no sample text anywhere.

## Cross-cutting pattern across this whole research group

Every platform in this document, plus PPPoker and PokerBros (documented
separately), plus ClubGG (documented elsewhere), sit behind the exact same
handful of third-party "Asian Hand Converter" products (DriveHUD's, Ace
Poker Solutions', Hand2Note's "ASIA" add-on). These products:
- Require an Android emulator (LDPlayer, BlueStacks, Nox) — meaning
  whatever capture technique they use needs the app running as if native
  on the same Windows machine, not just any log file the phone app leaves
  behind.
- Never publicly document their capture mechanism (checked directly by
  fetching every vendor page found; all are silent on this point).
- Re-emit captured data in one of a small number of established text
  dialects (PokerStars-family, iPoker-family, or "Asian poker clubs" per
  one tool's own menu wording) purely for compatibility with existing
  PT4/HM3/DriveHUD/fpdb parsers — **the dialect describes the converter,
  not the source platform.**

**Practical implication for a universal converter project:** for this
entire tier of platforms, the tractable integration point is very likely
"ingest whatever one of these converters already emits" (three or four
known dialects total, shared across a dozen source platforms) rather than
"write N platform-specific native parsers" — because in most cases there
is no native text format to parse in the first place. PokerBros and Run It
Once Poker (documented separately, with real byte samples) are the only
two platforms in this entire research batch where a native-ish text
grammar was actually recovered and verified.

## Sample index

None. No `fixtures/samples/{suprema,xpoker,kkpoker,upoker}/` directories
were created — no real bytes found for any of the four platforms in this
document.

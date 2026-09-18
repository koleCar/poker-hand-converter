# WPT Global — NO SAMPLES (negative finding)

**This directory is intentionally empty. There are no WPT Global fixtures, and
this is a finding rather than an oversight.**

## Why

**WPT Global removed hand-history export in June 2026.** Source:
<https://deepfold.co/en/blog/wpt-global-hand-converter>, which carries an
explicit "⚠️ Update (June 2026): WPT Global has removed hand history export"
banner and has struck through its own previously-working export instructions,
stating that "hand history files can no longer be obtained".

There was never a local hand-history folder on disk. The only export route was
in-client: Settings → Game History → Hand History → Email to Self, which mailed
a `.zip` of `.txt` files. With that route removed, current WPT Global users
cannot produce a hand-history file at all, and only exports captured before
June 2026 can exist anywhere.

Searched without success: GitHub code and repo search (`wpt global hand
history`, `wptglobal`, `WPT Global Hand`), open-source converter projects,
poker forums, and tracker support forums.

## What we know about the format anyway — secondary, NOT ground truth

The same page shows a header of the form:

```
WPT Global Hand #123456789: Hold'em No Limit ($1/$2 USD) - 2026/04/15 14:32:11 ET
Table 'Dallas 6-max' 6-max Seat #3 is the button
```

**Do not treat that as a sample and do not save it as a fixture.** The player
names are placeholders (`Player_AB12`, `Player_CD34`), the hand id is
`123456789`, and the body contains `...` elisions — it is a hand-written
illustration, not an export.

It is reasonable evidence that WPT Global is a **PokerStars-family** dialect
with its own brand token in the header, which is corroborated independently by
our own GGPoker parser carrying a `FOREIGN_BRANDING` guard that lists
`WPT Global` among the brands it refuses. But no parser should be written off
it.

## Recommendation

Leave the GGPoker parser's `FOREIGN_BRANDING` rejection in place so WPT Global
input fails honestly as "unknown site" rather than being silently mis-parsed as
GGPoker. Revisit only if a genuine pre-June-2026 export turns up.

See `docs/research/COVERAGE-PLAN.md` §3 and §4.

# Holdem Manager 3 — hand-history export/archive format

## 1. Overview & status — VERDICT: no distinct HM3 hand-history text format

**Holdem Manager 3 (HM3), like PT4, does not define its own hand-history text grammar.** HM3's workflow is:

1. Auto-import (or manual import) watches a site's hand-history folder and ingests the site's own native text (or, for `.zip`-delivered histories, the site's native text inside the zip).
2. Every file HM3 has successfully processed is **moved, unmodified, into an archive folder** (`C:\HM3Archive` by default) — this is explicitly a move of the original file, not a re-serialisation:

   > "All original hands that are auto-imported by Holdem Manager 3 get moved to an archive for performance reasons. That will be in C:\HM3Archive by default but you may have put it elsewhere."
   > — Flag_Hippo (PokerTracker forum, cross-posted context about HM3), thread "Converting Hands from Holdem Manager 3", https://www.pokertracker.com/forums/viewtopic.php?f=64&t=100500, retrieved 2026-09-17

3. When "Categorize Archived files by Site & Date" is enabled, the archive is organised as `C:\HM3Archive\<Site>\<Year>\<Month>` (example given for Ignition: `C:\HM3Archive\Ignition\2021\05`), and troubleshooting docs describe an even finer `PokerSite\Year\Month\DayOfMonth` layout for locating specific missed hands. Source: HM3 support search results for `HM3Archive`, https://kb.holdemmanager.com/knowledge-base/article/tools-menu-settings and https://support.holdemmanager.com/support/faqView/Holdem-Manager-3/269/How-Are-Missing-Hands-~-Inaccurate-Reports-Fixed, retrieved 2026-09-17.
4. HM3's own **"Export Hands"** feature (`Tools` menu) writes hands from the database back out to a folder the user picks, filterable by date range/hero-only/cash-or-tournament/stakes.

**Confidence: high** that the *archived* copies are original, unmodified site text (this is what "archive" explicitly means here and is the stated purpose — moving files out of the auto-import folder for performance, not converting them). **Confidence: medium-low** on whether "Export Hands" re-emits that same original text byte-for-byte or reconstructs it from the database — I found no HM3 support page or forum post that states this explicitly (unlike PT4, where a staff member said so in as many words; see the PT4 doc §1). Given the shared architecture (import → parse into DB → archive original file) and the total absence of any documented HM3-specific hand-history grammar anywhere in HM3's KB, forums, or third-party HUD projects, I treat "HM3 export also just re-emits site text" as the **most likely conclusion by strong analogy and absence of counter-evidence**, not as independently confirmed the way PT4's is. This distinction is called out explicitly rather than glossed over.

**Bottom line for parser agents: HM3 very likely needs no dedicated parser either**, on the same logic as PT4 — but treat this as slightly less certain than the PT4 verdict, and if a real HM3 "Export Hands" output ever surfaces that doesn't match its origin site's known grammar, that would be the actionable falsification of this verdict.

## 2. Detection signature

No HM3-specific header/footer/wrapper was found (see §5) — same situation as PT4. Signals available:

- **Archive folder path itself** is the strongest signal: if a user hands over files from a path containing `HM3Archive\<SiteName>\<Year>\<Month>[\<Day>]`, that's definitively HM3-archived (and, per §1, definitively original site text — no need to write a parser, just detect the site from content as usual).
- Multi-site interleaving in a single "Export Hands" output file is possible for the same reason as PT4 (HM3's DB spans every site a user tracks), and is a similarly weak-but-present signal.
- No distinguishing content-level signature inside the hand text itself was found — **N/A** for content-based detection, same as PT4.

## 3. Verbatim examples

None obtained. No downloadable, byte-accurate HM3 "Export Hands" output or archived file was found via web search. Since archived files are (per §1) the original site text, this repo's existing per-site fixtures already stand in for what a user's `HM3Archive` folder contents look like. No fixtures were added under `fixtures/samples/holdem-manager3/` for this reason (see §9).

## 4. Export mechanics

- **Menu path**: `Tools` → `Export Hands` (HM3) — pick a destination folder, then filter by date range (blank = all dates), Hero-only vs. all hands, cash vs. tournament, and specific stakes, then `Start Export`. Source: search summary of HM3 support/KB pages ("Tools Menu", "Export Hand History"), retrieved 2026-09-17.
- **Import (inbound) path**, relevant because it explains the archive's provenance: `File → Import Files` / `File → Import Folder`, or auto-import via configured per-site watch folders (`Tools → Site Settings`). HM3 also directly supports importing `.zip`-packaged hand histories (no need to unzip first).
- **Archive location/naming**: default `C:\HM3Archive`; with "Categorize Archived files by Site & Date" on, subfoldered as `<Site>\<Year>\<Month>` (possibly `\<Day>` as well per the missing-hands troubleshooting doc — the two HM3 docs found are not perfectly consistent on whether day-level folders exist by default or only in some flows; noted as an open discrepancy rather than resolved).
- **Encoding / line endings**: not documented; since archived content is unmodified original site text, it will match the source site's own encoding/line-ending conventions.
- I could not find documentation of a fixed file-naming pattern for individual archived/exported hand files (e.g. whether HM3 renames per-hand files or preserves the site's own filenames) — flagged as unconfirmed rather than guessed.

## 5. Wrapper / normalisation

No HM3-specific wrapper text, banner, or normalisation of timestamps/currency/player names was found in any KB article or forum thread describing export or archiving. Given that archiving is explicitly described as moving the original file, the strong expectation is "none" — but, as in §1, this is not backed by an explicit staff statement the way it is for PT4, only by absence of any contrary evidence plus the "move to archive" wording.

## 6. DB schema notes

This is the most concretely *distinct* thing about HM3 relative to PT4, and worth flagging clearly for anyone who gets handed a DB file instead of text:

> "Hand histories imported into HM3 and all related information is stored locally and contained in a single file database."
> — HM3 KB, "Where Does HM3 Store My Hand History Database?", https://kb.holdemmanager.com/knowledge-base/article/where-does-hm3-store-my-hand-history-database, retrieved 2026-09-17

- **HM3 uses a single-file local database, NOT the client/server PostgreSQL setup that both PT4 and the older HM2 use.** The KB article does not name the engine (SQLite is the obvious candidate for a "single file database" used by a Windows desktop app, but this is an inference, not confirmed — treat "SQLite" as a guess, not a fact, until a real `.db`/`.sqlite` file from an HM3 install is inspected).
- Default database location: `C:\Users\<user>\Documents\Holdem Manager 3\Databases`, or `C:\HM3files\Databases` when OneDrive is installed/enabled on the machine (HM3 explicitly warns against placing the DB in any cloud-synced folder — corruption risk).
- No table/column names were found publicly documented for HM3 (unlike PT3/PT4, where PokerTracker publishes schema docs — see the PT4 doc §6). A forum thread title "PostgreSQL base of Holdem Manager" (https://forums.holdemmanager.com/showthread.php?t=527514) suggests HM2's older Postgres-based schema might be a loose proxy for HM3's logical data model (hands/players/actions), but this is unverified and the underlying engine has changed, so table-name analogies are considerably weaker here than the PT3→PT4 analogy in the PT4 doc.
- **Practical implication**: if a user hands over an HM3 database file directly, expect a single `.db`-style file (not a `pg_dump`), most likely SQLite; there is currently no public schema reference to work from, so extracting hand text would likely require opening the file with a SQLite browser and looking for a text/blob column empirically, or asking the user to use HM3's own "Export Hands" instead.

## 7. Import-error / "unsupported hand" log format

- HM3 has a documented **"Unsupported Hand History Files"** concept, but it is described as an *operational* problem (files sites change format on, that fail to auto-import and therefore also fail to auto-archive, causing folder buildup/performance issues) rather than a distinct *file format* a user would paste at us. Source: https://kb.holdemmanager.com/knowledge-base/article/unsupported-hand-history-files, retrieved 2026-09-17. No example error text or log excerpt was published on that page.
- The documented remedy is manual: go to `Tools → Site Settings` to find each site's auto-import folder, move stuck files by hand into the archive, and confirm `Tools → Settings → Import → Archive directory` is configured — again, operational guidance, not a format spec.
- Forum evidence indicates import failures are typically caused by **the site itself changing its native hand-history format** (i.e. the failure mode is the *site's* format outrunning HM3's parser, not HM3 emitting anything unusual): "Sites change their hand history formats from time to time, and Holdem Manager will try and fail to import these hands when the new hand history format is not recognized yet by HM3." Users are told to update HM3 and re-import, or to use `Help → Send Feedback` to submit logs/config files directly to support (not a user-facing structured error format).
- **No verbatim error string could be found for HM3** (contrast with PT4 §7, where an actual Postgres error string was recoverable from a forum thread). This is recorded as a genuine gap, not glossed over: if a user pastes an HM3-originated error, expect it to be either (a) a plain description ("some hands failed to import"), (b) a screenshot, or (c) support-ticket-only log/config attachments not visible in public sources.

## 8. Gotchas

- Same core gotcha as PT4: do not write an "HM3 format" parser. Route any HM3-sourced text through the matching site's parser once the site is identified from content.
- The archive path (`HM3Archive\<Site>\<Year>\<Month>[\<Day>]`) is a much more reliable "this came from HM3" signal than anything in the hand text itself — if a user's folder structure matches this, trust it and proceed straight to per-site content detection.
- HM3's database engine changed between HM2 (PostgreSQL) and HM3 (single-file, likely SQLite) — don't assume HM2-era schema knowledge or tooling (e.g. Postgres dump/restore workflows, HM2 schema docs) transfers directly to an HM3 database handed over by a user.
- "Unsupported hand" issues in HM3 are usually the *site's* fault (format drift) rather than anything HM3-specific to parse around — if a user reports HM3 rejecting hands, the underlying site format itself may have changed recently and could also break this project's own site-specific parser; worth cross-checking against the newest fixtures for that site.

## 9. Sample index

No fixtures were added under `fixtures/samples/holdem-manager3/`. As with PT4 (§9), no downloadable byte-accurate HM3 export or archive sample was found, and per §1 the expected content of such a sample (original site text) is already represented by this repo's per-site fixtures. Recording this as a deliberate negative finding rather than a placeholder.

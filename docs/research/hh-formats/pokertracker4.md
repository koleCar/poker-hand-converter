# PokerTracker 4 — hand-history export format

## 1. Overview & status — VERDICT: no distinct PT4 hand-history text format

**PokerTracker 4 (PT4) does not have its own hand-history text grammar.** For every site whose native client already writes a plain-text hand history (PokerStars, partypoker, GGPoker, 888poker, iPoker, WPT Global, etc. — i.e. essentially all sites this repo already has parsers for), PT4:

1. Imports the site's own text file into a PostgreSQL database (parsing it into rows), and
2. On "Export Hands", **re-emits the original site text, byte-for-byte, unchanged.**

This is stated directly by PokerTracker's own support staff, not inferred:

> "For sites like PokerStars where the original hand history file is already in text format, PokerTracker 4 will export that in its original format."
> — Flag_Hippo (PokerTracker staff), forum thread "PT4 Hand History Export", https://www.pokertracker.com/forums/viewtopic.php?f=58&t=94022 (retrieved 2026-09-17)

The only case where PT4 does something non-trivial is for the small minority of sites that never had a text-based hand history to begin with:

> "RedKings (Microgaming) stores its data in an SQLite database file and when PokerTracker 4 imports from that file it makes a text version of the hand history which is stored in the PokerTracker 4 database. However, since this is not the original format, other applications may not understand it."
> — same thread/thread author, https://www.pokertracker.com/forums/viewtopic.php?f=58&t=94022

**Confidence: high for the "re-emits original text verbatim" claim** (it's an explicit, unambiguous statement from PokerTracker's own support staff, corroborated by a second thread — see §2). **Confidence: medium** on exactly what grammar PT4's from-scratch reconstruction (RedKings/Microgaming-style, DB-only sites) uses — I could not find a published grammar or a real byte-accurate sample of that reconstructed text; it is PT4-internal and not documented publicly. Practically this only matters for a handful of legacy Microgaming skins that store hands in SQLite rather than text, which is a small edge case relative to the sites already covered by this repo's parsers.

**Bottom line for parser agents: PT4 needs no dedicated parser.** A "PT4 export" of a PokerStars/partypoker/GGPoker/etc. hand *is* a PokerStars/partypoker/GGPoker/etc. hand, importable by the existing site parsers already in this repo. Detecting "this came out of PT4" (see §2) only matters so the converter doesn't get confused by wrapper artefacts (there mostly aren't any — see §5) or by the tiny number of DB-only sites where PT4's reconstruction may not perfectly match the live site's real grammar.

## 2. Detection signature

There is no PT4-specific header, footer, or magic line injected into exported files (see §5). A converter cannot reliably detect "this text came from a PT4 export" from the hand text alone — it will look exactly like a normal PokerStars/partypoker/etc. hand history file. The only external signals are:

- **File/session naming**: PT4-exported files tend to be named after the export batch (e.g. session or date range) rather than the site's own naming convention (which is often per-table or per-day). Not a reliable positive signal since users may rename files anyway.
- **Multi-site interleaving**: because PT4's database spans every site/network a user has played on, a single "Advanced" export can contain hands from multiple sites concatenated in one file, something the *native* site client itself would never produce (each site only ever exports its own hands). Seeing PokerStars-formatted hands and partypoker-formatted hands mixed in the same file is a decent (but not certain) signal of a PT4 (or HM3) export rather than a native site export.
- Corroborating forum evidence: a user reported an exported file being misidentified as an "internet explorer" file type when passed to another PT4 install — this points at generic `.txt`/browser MIME confusion, not a distinctive PT4 signature. Source: "Hand history file" thread, https://www.pokertracker.com/forums/viewtopic.php?t=98910&p=357154 (retrieved 2026-09-17).

**N/A (no distinguishing content-level signature) is the honest answer** — treat any PT4-sourced export as belonging to whichever site parser its content actually matches.

## 3. Verbatim examples

None obtained. I could not locate a downloadable, byte-accurate PT4-exported `.txt` file (forum threads describe the export but no attachments were recoverable via web search/fetch). Since the export is — per §1 — the original site text unchanged, the existing fixtures in `fixtures/samples/pokerstars/`, `fixtures/samples/partypoker/`, etc. in this repo are already representative of what a PT4 export of those sites' hands looks like. No new fixtures were created under `fixtures/samples/pokertracker4/` for this reason (see §9).

## 4. Export mechanics

- **Menu path (bulk)**: `Database` → `Export` → choose the `Sessions`, `Tournaments`, or `Advanced` tab → filter by date/site/stakes/table type/tourney type → `Export Hands`. Source: https://docs.pokertracker.com/pt4/tutorials/database-management/exporting-your-database/ (redirect target of https://www.pokertracker.com/guides/PT4/tutorials/exporting-your-database), retrieved 2026-09-17.
- **Menu path (selected hands)**: in any hand-report grid, select one or more hands (shift/ctrl-click, or Ctrl-A for "all in report"), then right-click → `Export Hand Histories`.
- **File format**: plain `.txt`.
- **Grouping / file naming**: "Separate files will be created for holdem and omaha hands, and also for cash and tournaments," with a user-configurable maximum hand count per file. Beyond that split, PT4 does not document a fixed naming scheme for the output files (user picks destination/name in the save dialog) — confirmed absence of documented naming convention, not just an omission on my part.
- **Compression**: as of PT4 4.16, PT4 supports importing (and therefore, in workflows, sharing) hands as `.zip` archives — useful if a user says "I zipped up my hands from PT4."
- **Original files location** (distinct from "Export"): PT4 auto-archives every hand history file it has processed, unmodified, under `File → Open User Data Folder`, default path `%LOCALAPPDATA%\PokerTracker 4\Processed` (i.e. `C:\Users\<user>\AppData\Local\PokerTracker 4\Processed` on Windows). This is arguably the more useful "get me my raw hands" path for a user, since it bypasses PT4's export UI/filtering entirely and hands back the untouched site files. Source: PokerTracker forum "PT4 Hand History Export" and "Hand history file" threads (URLs above).
- **Encoding / line endings**: not documented publicly; since exported content for text-based sites is the original file unchanged, encoding/line endings will match whatever the source site used (see this repo's site-specific fixtures, several of which already document CRLF vs bare-CR line endings, e.g. `fixtures/samples/pokerstars/11-cash-nlhe-gbp-currency-cr-only-lineendings.txt`).

## 5. Wrapper / normalisation

**None found, and the evidence points to none existing** for text-based sites — that is the entire content of the staff quote in §1 ("will export that in its original format"). No PT4-specific header/footer/banner line, no re-timestamping, no currency conversion, and no anonymisation on export were found in any support doc or forum thread. If a converter sees an otherwise-normal site hand history with an extra banner line claiming to be from "PokerTracker", that would be surprising given this evidence and should be treated with suspicion (possibly a different, non-PT4 tool, or a user-added comment).

## 6. DB schema notes

PT4 stores its parsed data in **PostgreSQL** (a background Postgres server that PT4 talks to), not SQLite, not a flat file. Source: https://www.pokertracker.com/guides/PT4/databases/what-is-postgresql (via search summary) and forum thread "PT4 - PostgreSQL relationship", retrieved 2026-09-17.

- PT4 installs a local `schema.postgres.sql` file (plain text, can be opened in Notepad) that documents the exact PT4 schema — this is machine-local, not published on the web, so I could not fetch its contents. If a user ever hands over a PT4 Postgres dump, `schema.postgres.sql` inside their PT4 install directory is the authoritative source to request.
- One concrete PT4-4 (not just PT3) column reference surfaced during research: `cash_hand_player_statistics.position` — i.e. cash-game per-player statistics live in a table named `cash_hand_player_statistics` (or similarly-prefixed `cash_hand_*` / `tourney_hand_*` tables, by analogy — **not independently confirmed beyond this one column reference**).
- **PT3's schema (predecessor, publicly documented) is the best proxy for PT4's likely shape and directly supports the §1 verdict at the storage layer**: PT3 has explicit tables `holdem_hand_histories` (columns: `id_hand`, `history`) and `tourney_holdem_hand_histories` (same shape), where `history` is documented as "the text from the hand history file copied by PokerTracker" — i.e. PT3 stored (and, by strong analogy, PT4 very likely still stores) the **original hand-history text verbatim in a text column**, alongside separately-parsed structured tables (`player`, `holdem_hand_player_detail`, `holdem_hand_player_statistics`, `holdem_hand_summary`, `holdem_hand_player_combinations`) for the derived stats. Source: https://www.pokertracker.com/guides/PT3/databases/pokertracker-3-database-schema-documentation, retrieved 2026-09-17. **Caveat: this is PT3, not PT4 — table names differ in PT4 (per the `cash_hand_player_statistics` example above) — but the architectural pattern (raw text column + derived stats tables) is a reasonable, though unconfirmed, inference for PT4.**
- Practical implication for a user handing over a raw DB dump instead of text: look for a `*_hand_histories`-style table (PT3 naming) or any text/varchar column that looks like it holds full hand text, dump that column per row, and treat each row's content exactly like the corresponding site's native `.txt` format — because per §1, that's what it is.

## 7. Import-error / "unsupported hand" log format

PT4 does **not** have a distinct standalone log *file* format for import errors that a user would typically paste at us. Instead:

- Failed imports surface inside the PT4 UI itself, under `View → Import Status`, in an "Errors" count/tab. A user asked to "show the error" will most likely paste a screenshot or copy text out of this grid, not a log file.
- When errors do get quoted (e.g. to PokerTracker support), they are raw **PostgreSQL error strings** surfaced by the app, not a PT4-specific error grammar. Real example transcribed from a support thread (user `bbstyle`, PT4 v4.15.20, PokerTime hands, thread https://www.pokertracker.com/forums/viewtopic.php?t=98516&p=355778, retrieved 2026-09-17 — paraphrase-quality via automated page fetch, so treat exact punctuation as approximate, not byte-certain):
  ```
  Error: invalid input syntax for integer: ""
  CONTEXT: PL/pgSQL function update_cash_custom_cache() line 9 at FOR over SELECT rows
  ```
  paired with references to specific failing hand IDs like `#1586947597914`.
- Common causes for import failure per forum troubleshooting: site hand-history format changed after a site software update (fixed by a PT4 update), a hand with a $0 starting stack, or missing `.txt` extension on the hand file (PT4 relies on the extension for site auto-detection in some workflows).
- **Practical guidance for this converter**: if a user pastes something that looks like a raw Postgres error (`invalid input syntax`, `PL/pgSQL function...`, `CONTEXT:`) alongside a hand ID, that is very likely a PT4 (or HM-family) import failure notice, not a hand history at all, and should be flagged back to the user as "this isn't a hand — this is your tracker's error message; please paste the actual hand text instead."

## 8. Gotchas

- Don't assume "PT4 export" implies a distinctive grammar to write a parser against — per §1, none exists for the sites that matter. Route PT4-exported text through the matching site's existing parser.
- A single PT4 export file can silently mix hands from **multiple different sites** (see §2) — a converter that assumes one file = one site format could misfire on a PT4 "Advanced" export. Detect and dispatch per-hand, not per-file, when a file's origin is unconfirmed.
- "Export a report" and "Export hand histories" are different PT4 features — exporting a *report* only exports the report's configuration (columns/filters), not any hand data at all. A user who says "I exported my report and got a weird XML/config-looking file" has hit this, not a hand-history format. Source: https://www.pokertracker.com/forums/viewtopic.php?t=98910&p=357154.
- For the rare DB-backed sites (Microgaming/RedKings-style), PT4's internally-reconstructed text is explicitly called out by PT4 staff as potentially **not understood by other applications** — i.e. PT4 itself warns this reconstruction is not guaranteed to match any real site grammar. Treat any hand claiming Microgaming/RedKings origin via a PT4 export with extra caution and prefer getting the user's original SQLite-sourced export if possible.

## 9. Sample index

No fixtures were added under `fixtures/samples/pokertracker4/` — I found no downloadable, byte-accurate PT4 export to preserve, and per §1/§3 a byte-accurate PT4 export of a supported site is indistinguishable from (and should be tested via) that site's own fixtures already in this repo (`fixtures/samples/pokerstars/`, `fixtures/samples/partypoker/`, etc.). This absence is itself the finding, not a gap I ran out of time to fill: creating a synthetic "PT4-flavored" fixture would misrepresent a format that doesn't exist.

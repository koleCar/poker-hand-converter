# rail-store schema

The local SQLite store of the desktop app (docs/RAIL-PLAN.md §3.4, R1.2).
One file, `rail.db` (plus SQLite's `-wal` and `-shm` beside it), in the
app's local data directory (`app_local_data_dir`): on macOS
`~/Library/Application Support/app.rail.desktop/`, on Windows
`%LOCALAPPDATA%\app.rail.desktop\` (not the roaming `%APPDATA%`).

## Conventions

- **Engine**: SQLite compiled into the binary (`rusqlite` `=0.40.2`,
  `bundled`, which pins `libsqlite3-sys` 0.38.2). WAL mode, `synchronous =
  NORMAL`, foreign keys on, a 5 s busy timeout, 16 KiB pages (a compressed
  PHF fits its leaf page; with 4 KiB pages the corpus took 35 % more space).
- **Version**: `PRAGMA user_version`. Migrations are SQL files in
  `migrations/`, compiled in (`src/migrate.rs`), forward-only, each in its
  own transaction with the version bump. A file with a version above the
  build's is refused untouched.
- **Types**: every table is `STRICT`. Times are `INTEGER` milliseconds since
  the Unix epoch (UTC); sizes and offsets are `INTEGER` bytes; booleans are
  `0` / `1`. `played_at` is the PHF's ISO text (sorts as time).
- **One writer**: every write goes through the writer thread; a batch (one
  read of one file) is one transaction - or, when several batches wait in
  the writer's queue together (a backfill), one savepoint each inside one
  shared transaction (R1.6): each batch is still stored whole or not at
  all, with its own offset.

## Migrations

| Version | File | What |
| --- | --- | --- |
| 1 | `0001_initial.sql` | `kv`, `sources`, `files`, `hands`, `quarantine`, `unsupported`, `outbox` |
| 2 | `0002_source_poll_only.sql` | `sources.poll_only` (R1.3) |
| 3 | `0003_source_site.sql` | `sources.site` (R1.4) |
| 4 | `0004_folder_rollups.sql` | `files.hands`, `files.quarantined`, `source_totals`, `source_days`, their triggers; `files_source_idx` on `(source_id, last_import_at)` (R1.6) |

Reserved for later steps, each as the next free number when it lands (the
numbers are not fixed in advance; the order is):

| Step | Tables |
| --- | --- |
| R2.1 / R2.3 (Phase 2) | `seat_stats` (one row per dealt-in seat at the current stats version, the local `hand_stats`), `player_rollups` (summed counters per site, player and segment), `players` (notes, colour tag, labels) |
| R3.6 / R3.9 (Phase 3) | `hud_layouts` (layouts, presets, seat positions per site and table size) |

## Tables

### `kv`

Small settings and cursors: sync cursors (R1.9), the answer to the
"share unsupported formats" question (R0.11), and the like. Not the schema
version (that is `user_version`) and not the window settings (those are
`settings.json`, R1.1).

| Column | Type | |
| --- | --- | --- |
| `key` | TEXT PK | |
| `value` | TEXT | |
| `updated_at` | INTEGER | ms |

### `sources`

Watched folders. Written through `WriterHandle::add_source`,
`remove_source`, `set_source_enabled`, `set_source_poll_only`,
`set_source_recursive`, `set_source_site`, `set_source_site_override`,
`set_source_path` and `set_source_status` (`src/sources.rs`): the watcher
(R1.3) keeps `status` and `last_error` current; Settings → Folders (R1.5)
edits the rest. Removing a folder keeps its files and hands
(`files.source_id` becomes NULL).

Two edits touch `files` in the same transaction (R1.5):

- **`set_source_path`** (a new path for the folder): the files the watcher
  found again under the new path (same relative path, at least as long as
  what was read) get the new path and keep their row and `read_offset` - a
  moved or copied folder continues where it stopped; a file the new folder
  had a row for already keeps that row, which joins the folder; every other
  file of the folder is detached (`source_id` NULL, hands kept), as on
  removal. No old file found = remove + add with the same id and settings.
  The path must not be another folder's (`PathTaken`).
- **`set_source_site_override`** (the room chosen by hand): when the choice
  changes, the folder's files the parser now in force reads differently go
  back to offset 0 (size 0, no mtime, encoding or site) with their
  `quarantine` rows, so the watcher reads them again; hands stay and dedupe.
  With an override: every file whose `site` is not that parser; without
  one: every file with no `site` or the old override's.

| Column | Type | |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `path` | TEXT UNIQUE | the folder |
| `site_override` | TEXT NULL | a forced parser id (`rail_core` parser) for every file under it: the room chosen by hand when detection fails (R1.5) |
| `enabled` | INTEGER | 0 / 1; a disabled folder keeps its hands |
| `recursive` | INTEGER | 0 / 1 |
| `status` | TEXT | the watcher's state: `idle` (never started), `watching`, `polling`, `unavailable` (not there: an unplugged drive), `error` (cannot be read or watched), `disabled` |
| `last_error` | TEXT NULL | why the folder cannot be watched |
| `added_at` | INTEGER | ms |
| `poll_only` | INTEGER | 0 / 1 (version 2): read by polling, without OS notifications - a network share, detected when the folder is added, or set by the user |
| `site` | TEXT NULL | (version 3) the `config/sites.json` id of the room whose default folder this is, as first-run discovery found it (R1.4); names the room and narrows the files read to the room's `files.glob`. Not a parser override. NULL for a folder added by hand |

### `files`

One row per hand-history file ever read.

| Column | Type | |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `path` | TEXT UNIQUE | the file, as text (`import::path_key`) |
| `source_id` | INTEGER NULL → `sources` | the folder it was found in |
| `size` | INTEGER | the file's size when last read |
| `mtime` | INTEGER NULL | its modification time then, ms |
| `read_offset` | INTEGER | how far it has been read: every byte before it is in `hands` / `quarantine` / `unsupported`. Moves **only** in the transaction that stores what was read up to it |
| `encoding` | TEXT NULL | the decoder's label (`UTF-8`, `UTF-16 LE`, `Windows-1252`, ...) |
| `site` | TEXT NULL | the parser that claimed the file: detection's top candidate, or the folder's `site_override` when one is set (R1.5) |
| `last_error` | TEXT NULL | `not readable as text: <kind>` or `the core threw: <message>`; cleared by a good read |
| `first_seen` | INTEGER | ms |
| `last_import_at` | INTEGER NULL | ms of the last batch |
| `hands` | INTEGER | (version 4) hands this file delivered first (`hands.file_id`); the writer adds a batch's new hands in the batch's transaction |
| `quarantined` | INTEGER | (version 4) its `quarantine` rows, kept by the triggers `quarantine_count_insert` / `_delete` |

Index: `files_source_idx` on `(source_id, last_import_at)` (version 4; was
`(source_id)`): a folder's files and its newest import are one seek.

### `source_totals` (version 4)

Per watched folder, the sums of its files' counters, so the folder list
(`Reader::sources`, `Watcher::status`) costs the same at a million hands
as at a hundred (R1.5's per-folder join took 40 ms at 90 000 hands and grew
with them; now ~0.05 ms). A row per `sources` row (trigger
`sources_totals_row`), kept by triggers on `files` (`files_totals_insert`,
`_delete`, `_update` on `source_id`, `hands`, `quarantined`): a file that
moves to another folder, is detached or adopted (R1.5's
`set_source_path`, removal) takes its counts along. Cascades with the
folder. Tests compare it with the rows after every change
(`tests/common::assert_integrity`, the crash test included).

| Column | Type | |
| --- | --- | --- |
| `source_id` | INTEGER PK → `sources` | cascades |
| `files` | INTEGER | files with this `source_id` |
| `hands` | INTEGER | sum of their `files.hands` |
| `quarantined` | INTEGER | sum of their `files.quarantined` |

### `source_days` (version 4)

Hands a folder stored per local day: "hands today" without counting the
day's hands (a backfill day has all of them). The writer adds a batch's new
hands to `(source_id, date(imported_at, 'localtime'))`; `set_source_path`
recounts today's row of the folders whose files moved. Cascades with the
folder. `WITHOUT ROWID`.

| Column | Type | |
| --- | --- | --- |
| `source_id` | INTEGER → `sources` | PK with `day` |
| `day` | TEXT | `YYYY-MM-DD`, local |
| `hands` | INTEGER | |

### `hands`

Converted hands, deduplicated by `hand_key`. The PHF is the source of
truth; the other columns are projections of it for lists, the HUD and sync.

| Column | Type | |
| --- | --- | --- |
| `hand_key` | TEXT PK | `<siteId>:<handKey>`, the web's `handKeyOf` (`frontend/src/lib/db/mapping.ts`): site id trimmed and lower-cased, `meta.handKey` or `meta.handId` when empty. The same key as `public.hands.hand_key` |
| `site` | TEXT | `meta.siteId` |
| `site_hand_id` | TEXT | `meta.handId`, as the room wrote it |
| `played_at` | TEXT NULL | `playedAt`, ISO |
| `game_format` | TEXT | `cash` / `tournament` / `sng` / `spin` |
| `variant` | TEXT | `holdem`, `omaha`, ... |
| `limit_type` | TEXT | `nl` / `pl` / `fl` |
| `currency` | TEXT | `game.unit.code` |
| `small_blind`, `big_blind`, `ante` | INTEGER | minor units (the stakes) |
| `table_name` | TEXT NULL | |
| `max_seats` | INTEGER | |
| `hero_seat`, `hero_name` | NULL | the hero's seat and name, when there is one |
| `schema_version` | TEXT | `phf/1` |
| `parser_id`, `parser_version` | TEXT | which parser made it |
| `phf` | BLOB | the canonical PHF JSON (`rail_core::canonical`), zstd level 3 |
| `phf_size` | INTEGER | the JSON's length before compression |
| `file_id` | INTEGER NULL → `files` | the file that delivered it first |
| `imported_at` | INTEGER | ms; "hands today" counts from local midnight |
| `synced_at` | INTEGER NULL | ms; when the server confirmed it (R1.9) |

Indexes: `file_id`, `imported_at`, `played_at`.

### `quarantine`

Chunks the core refused, with the raw text so a parser fix can re-run them.
One row per (file, fingerprint): a re-read of the file refreshes the row
instead of adding one. The file-level `unknown-site` refusal of a file no
parser claims is not here: that file goes to `unsupported`.

| Column | Type | |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `file_id` | INTEGER → `files` | cascades |
| `read_offset` | INTEGER | the offset the read that found it started at |
| `chunk_index` | INTEGER NULL | the chunk within that read (`ConversionFailure.index`); NULL for a file-level refusal |
| `fingerprint` | TEXT | sha-256 of the whitespace-normalised raw text (`unparsed_hands`' key) |
| `stage` | TEXT | `split` / `detect` / `parse` / `validate` / `serialize` |
| `reason` | TEXT | the machine code (`chip-mismatch`, ...) |
| `message` | TEXT | human readable |
| `detected_site` | TEXT NULL | the parser that refused it |
| `detection_permille` | INTEGER NULL | its score |
| `parser_version` | TEXT | `0` when no parser was involved. "Try again after an update" (R1.6, `WriterHandle::reset_stale_refusals`) resets the files of watched folders holding a row whose parser (`detected_site`) has another version in this build: offset 0, their quarantine rows deleted, as a room change does |
| `raw_text` | TEXT | the chunk |
| `first_seen`, `last_seen` | INTEGER | ms |

### `unsupported`

The unsupported-format registry (R0.11, *For R1.2*): files no parser
claims, one row per fingerprint; a repeat (another file, or the same file
changed) bumps `count`. Only anonymised data is kept (`header_sample`);
the upload reads the file again for `shareable_sample` after consent.

| Column | Type | |
| --- | --- | --- |
| `fingerprint` | TEXT PK | the refusal's fingerprint |
| `header_sample` | TEXT | `Unrecognized.header_sample` (anonymised) |
| `guessed_site` | TEXT NULL | |
| `confidence` | INTEGER | per-mille |
| `guess_basis` | TEXT NULL | `below-threshold` / `known-format` |
| `shape` | TEXT | `xml` / `json` / `text` |
| `file_path`, `encoding` | TEXT | the last file seen with it |
| `count` | INTEGER | times seen |
| `first_seen`, `last_seen` | INTEGER | ms |
| `consented_at` | INTEGER NULL | ms; the user agreed to share it |
| `sent_at` | INTEGER NULL | ms; sent to `unparsed_hands` |
| `anonymiser_version` | TEXT NULL | `ANONYMISER_VERSION` of the sent sample |

`CHECK`: `sent_at` needs `consented_at` and `anonymiser_version`.

### `outbox`

Hands not yet synced to Supabase. A hand enters in the transaction that
stores it and leaves when the server has it (`Store::outbox_mark_sent`).

| Column | Type | |
| --- | --- | --- |
| `hand_key` | TEXT PK → `hands` | cascades |
| `enqueued_at` | INTEGER | ms |
| `attempts` | INTEGER | failed sends so far |
| `last_error` | TEXT NULL | |
| `next_attempt_at` | INTEGER | ms; the backoff is the sync worker's (R1.9) |

Index: `(next_attempt_at, enqueued_at)`.

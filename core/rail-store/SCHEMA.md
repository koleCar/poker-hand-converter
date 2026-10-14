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
  PHF fits its leaf page; with 4 KiB pages the corpus took 35 % more space),
  `temp_store = MEMORY` on the write connection (R2.3: the statement
  journal of the import batches' savepoints stays in memory instead of
  temporary files), and on it a 16 MiB page cache (`cache_size`; SQLite's
  default 2 MB is 128 of these pages) and a WAL checkpoint every 4 096
  pages (`wal_autocheckpoint`, 64 MiB; default 1 000) - both measured on
  the import's writer (R2.7c, "Import writer, second pass").
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
  all, with its own offset. Batches whose producer does not wait for the
  commit (`WriterHandle::queue`: the watcher's import threads) may hold
  their group open for up to 5 ms (`GROUP_LINGER`) once a second one is
  waiting, so a backfill commits fewer, larger transactions.

## Migrations

| Version | File | What |
| --- | --- | --- |
| 1 | `0001_initial.sql` | `kv`, `sources`, `files`, `hands`, `quarantine`, `unsupported`, `outbox` |
| 2 | `0002_source_poll_only.sql` | `sources.poll_only` (R1.3) |
| 3 | `0003_source_site.sql` | `sources.site` (R1.4) |
| 4 | `0004_folder_rollups.sql` | `files.hands`, `files.quarantined`, `source_totals`, `source_days`, their triggers; `files_source_idx` on `(source_id, last_import_at)` (R1.6) |
| 5 | `0005_sync.sql` | `outbox.played_at` (filled from `hands`) and `outbox_recent_idx`, `outbox_retry_idx`; `hands.pulled_at` and `hands_pulled_idx`; `sync_rejected` (R1.9) |
| 6 | `0006_stats.sql` | `segments`, `hand_stats`, `seat_stats`, `player_rollups`, `hero_rollups`, `ev_rows`, `ev_pending` (R2.3) |
| 7 | `0007_hands_screen.sql` | `hand_list` and its delete trigger on `hand_stats`, `hand_notes`, `hand_tags`, `saved_filters`; forgets `stats.version`, so the next open rebuilds the statistics and with them the list rows (R2.7a) |
| 8 | `0008_reports.sql` | `hand_list.kind`, `hero_wtsd`, `currency`, `minor_units` (the reports' graph and sessions); forgets `stats.version`, so the next open rebuilds the list rows with them (R2.7b) |
| 9 | `0009_players.sql` | `players`, `player_labels` (the user's colour, labels and note per opponent), `player_summary`, `player_hidden` (the list's sums), `player_hands` and its delete trigger on `seat_stats`; forgets `stats.version`, so the next open rebuilds the statistics and with them the sums (R2.7c) |
| 10 | `0010_import_indexes.sql` | drops `hands_played_at_idx`: no query reads it (the list reads `hand_list`, date ranges `hand_stats`), and each imported hand wrote an entry at a random place (~7 % of the writer's time per hand) |

Reserved for later steps, each as the next free number when it lands (the
numbers are not fixed in advance; the order is):

| Step | Tables |
| --- | --- |
| R3.6 / R3.9 (Phase 3) | `hud_layouts` (layouts, presets, seat positions per site and table size) |

## Tables

### `kv`

Small settings and cursors: sync cursors (R1.9), the answer to the
"share unsupported formats" question (R0.11), and the like. Not the schema
version (that is `user_version`) and not the window settings (those are
`settings.json`, R1.1).

The sync worker's keys (R1.9, `rail_sync::worker`):

| Key | Value |
| --- | --- |
| `sync.owner` | `{"userId":..,"email":..}`: the account this store's hands sync to - the first one that signed in, or the one the user chose to upload to |
| `sync.device` | this installation's random UUID (v4), the `device_id` of its `hand_sources` rows |
| `sync.source.<user id>.<sources.id>` | the `hand_sources` id of a watched folder on that account (`unfiled` for hands whose file is in no folder) |
| `sync.pull.<user id>` | the pull's cursor, `{"createdAt":..,"id":..}` (the last row read, as the server wrote it); written in the transaction that stores the page |
| `sync.paused` | `1` while the user paused sync |
| `sync.cap` | the upload cap while a large backlog syncs, bytes a second, or `none` (default 1 MiB/s) |
| `sync.declined` | the user id whose account the user chose not to upload this computer's hands to |

The statistics' keys (R2.3, `rail_store::stats`):

| Key | Value |
| --- | --- |
| `stats.gen` | the generation the rollups count (`hand_stats.gen`); a rebuild starts the next |
| `stats.version` | the `STATS_VERSION` (`stats/2`) the current generation is derived under; another one on open starts a rebuild |
| `stats.rebuild.cursor` | while a rebuild runs: the last `hand_key` it went through (`''` before the first page); absent otherwise |
| `stats.rebuild.done`, `stats.rebuild.total` | its progress: hands gone through, of the hands stored when it began |
| `ev.version` | the `EV_VERSION` (`ev/1`) every hero hand was evaluated at or is queued for; another one on open queues every hero hand again |

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
| `pulled_at` | INTEGER NULL | (version 5) ms; the hand came from the server (the pull, R1.9), not from a file here: never queued for upload, `synced_at` set, `file_id` NULL. An account change uploads only hands without it |

Indexes: `file_id`, `imported_at`; `hands_pulled_idx` on `pulled_at` where
it is set (version 5). (`played_at` had one until version 10, which dropped
it: nothing read it.)

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
| `played_at` | TEXT NULL | (version 5) the hand's `played_at`, copied when it is queued: the send order reads the outbox only |

Indexes: `outbox_due_idx (next_attempt_at, enqueued_at)` - the backlog,
oldest due first; `outbox_recent_idx (enqueued_at, next_attempt_at,
played_at, hand_key)` (version 5) - the hands queued in the last minutes,
newest played first, from the index alone; `outbox_retry_idx
(next_attempt_at) WHERE attempts > 0` (version 5) - the hands waiting for a
retry, counted.

**Send order** (`Reader::outbox_next`, R1.9): first the hands queued in the
last 15 minutes, newest played first - a hand just played goes out before a
backfill queued at the same time (its hands were played earlier) - then the
rest, oldest due first. Measured with a million queued hands, half of them
in the window (`tests/sync.rs`, ignored test, release build on a loaded M2
Pro): the recent tier 0.3-0.7 s, the backlog tier and the status counts
0.25-0.5 s (cold pages); with an ordinary outbox both are a few ms.

### `sync_rejected` (version 5)

Hands the server refused (`ingest_hands`' `rejected`, with its reason) or
that cannot be sent at all (`unreadable`, `too-large`). They leave the
outbox - resending cannot help - and wait here, counted per reason in
Settings → Account, until the user chooses "Try again" (after an update:
`WriterHandle::rejected_requeue`). Cascades with the hand.

| Column | Type | |
| --- | --- | --- |
| `hand_key` | TEXT PK → `hands` | cascades |
| `reason` | TEXT | the server's code (`shape`, `schema`, `hand-key`, `raw-text`, `too-large`, `invalid`) or a local one (`unreadable`, `too-large`) |
| `field` | TEXT NULL | for `invalid`: the column whose rule the derived row broke |
| `rejected_at` | INTEGER | ms |

Index: `sync_rejected_reason_idx (reason)`.

## Statistics (version 6, R2.3)

The local statistics: per hand the rows `rail_stats::stored_rows` keeps,
the rollups the HUD and the reports read, and the hero's all-in EV. Written
by `rail_store::stats`, read by `rail_store::stats_read`, rebuilt and
completed by the background pass `rail_store::background` (`StatsWorker`).

**How they are written.** A hand's rows are derived on the producer's
thread (the import threads, the sync pull: `PreparedStats` beside the
compressed PHF) and written by the writer **in the transaction that stores
the hand**; the rollups get the sums of a transaction's new rows (a
backfill's group of up to 64 batches) with one upsert per key. A duplicate
hand writes nothing. A crash leaves a hand with all its rows and counts or
with none (the crash test checks the rows of every stored hand and the
rollups against the rows after every kill).

**Which rows.** The writer rules of the web's `lib/db/statsRows.ts`
(`handStatsRows`): the **hero's row always**, villains' rows always on the
desktop (the web writes them only behind a flag), **never a villain of a
positionally anonymised room** (Ignition: `UTG+1` is another human every
hand), and one row per seat (two players on one seat number give the engine
two identical rows; the first is kept, as `save_hand_stats`' `on conflict do
nothing`).

**Under which identity a row is summed** (`rail_stats::rollup_scope`,
docs/DATABASE.md "Player identity and anonymized rooms"): a screen name
(`site_anonymization = none`) is one person in every hand - scope `''`. An
**opaque token** (`opaque-id`: GGPoker's hashes, ACR/WPN's data-mined
numeric ids) is one person **within one session only**: the same human gets
another token in another session, and summing a token across sessions
would merge whoever wears it with whoever wore it before - a person nobody
played. Those villains are summed per session, which a hand names by its
table and its UTC day: scope `<table name>@<YYYY-MM-DD>`
(`rail_stats::session_scope`; the HUD computes the scope of the table it
draws on the same way). A session that runs past midnight UTC, or a
tournament player moved to another table, splits in two: it under-merges,
never over-merges. The hero is always one person (scope `''`).

**Generations and rebuilds.** The rollups count the rows of one generation
(`kv` `stats.gen`; `hand_stats.gen`). A rebuild - started on open when
`stats.version` is not this build's `STATS_VERSION` (a version bump, or a
store from before version 6), or by "rebuild statistics" after a definition
change - begins the next generation in one transaction: the rollups are
emptied and a cursor set. The background pass then goes through `hands` in
`hand_key` order, 500 a transaction, reads each PHF back, derives its rows
with this build's engine and replaces the older generation's rows with them,
moving the cursor in the same transaction (resumable after a quit or a
crash). Hands imported meanwhile are counted in the new generation at once
and skipped by the pass. **At every commit the rollups are the sums of the
current generation's rows**; during a rebuild they grow as the pass goes.
Measured on the corpus (7 496 hands, debug build): ~3 s.

**All-in EV.** `ev_row` (`handEvRow` of the web) needs the hero's row. A
hand whose all-in was completed **preflop** (1.7M boards enumerated, 25-46
ms; 20 000 sampled for Omaha) is not evaluated at import: it is queued in
`ev_pending` and the background pass evaluates it, newest first, 8 hands a
transaction, paused while a backfill imports or poker tables are open
(`StatsWorker::set_backfill`, `set_tables_open`). Every other hero hand is
evaluated at import (a flop or turn all-in: a few hundred boards; no all-in:
the analysis's first checks, `rail_equity::all_in_street`). Only rows that
differ from the result are stored (`applicable`: an all-in with cards to
come, ~6 % of hero hands in the corpus); every other hero hand's row is
`ev_net = net`, implied by its absence from both tables. An `ev.version`
other than this build's `EV_VERSION` queues every hero hand again; a rebuild
queues a hand again only when its hero's seat or result changed.

### `segments`

What statistics are summed over (docs/RAIL-PLAN.md §3.4,
`rail_stats::Segment`): (site, game format, variant, limit, table-size
class, stake). Rows are never deleted.

| Column | Type | |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `site` | TEXT | the site id trimmed and lower-cased: `hand_key`'s prefix |
| `game_format` | TEXT | `cash` / `tournament` / `sng` / `spin` |
| `variant` | TEXT | `holdem`, `omaha`, `omaha5`, `omaha6`, `shortdeck`, ... |
| `limit_type` | TEXT | `nl` / `pl` / `fl` |
| `size_class` | TEXT | by the table's seats (`maxSeats`; the hand's players when under 2): `hu` (2), `6max` (3-6), `full` (7 and more) |
| `stake` | TEXT | a cash game: `<currency>:<big blind in minor units>`, exactly (`USD:200` is $1/$2; `TCHIP:200` play money): every stake level is its own segment, and a coarser grouping is a sum at query time. A tournament format: `chips` (its blinds rise; the buy-in is a filter, not a segment) |

`UNIQUE (site, game_format, variant, limit_type, size_class, stake)`.

### `hand_stats`

One row per hand with kept rows: the hand-level columns of the web's
`hand_stats` that `hands` does not hold already (`played_at`, `variant`,
`limit_type`, `game_format`, `currency`, `small_blind`, `big_blind`,
`max_seats`, `table_name` and `site_hand_id` are `hands`'). Cascades with the
hand.

| Column | Type | |
| --- | --- | --- |
| `id` | INTEGER PK | what `seat_stats` refers to (an integer: 6 seat rows a hand would repeat a ~25-byte key) |
| `hand_key` | TEXT UNIQUE → `hands` | cascades |
| `gen` | INTEGER | the generation its rows are counted in |
| `played_at` | TEXT NULL | `hands.played_at`, repeated: a date range reads this narrow table, never `hands` (whose rows hold the PHF; reading them made a report's partial days take seconds at 500k) |
| `segment_id` | INTEGER | `segments.id` |
| `stats_version` | TEXT | `stats/2` |
| `site_anonymization` | TEXT | `none` / `positional` / `opaque-id` (`rail_stats::detect_anonymization`, the web's `detectAnonymization`) |
| `site_id` | TEXT | `meta.siteId` as the parser wrote it |
| `currency_minor_units`, `player_count`, `tournament_id`, `fast_fold` | | as in the engine's row |
| `has_straddle`, `is_bomb_pot`, `is_big_blind_ante`, `is_run_it_twice`, `has_cashout`, `is_walk` | INTEGER | 0 / 1 |
| `street_reached`, `pot_type` | TEXT | |
| `total_pot`, `house_into_pot`, `fees` | INTEGER | minor units |

Index: `hand_stats_played_idx (played_at)` - the hands of a date range (a
report's partial days, the EV of a range; R2.7's hand lists).

### `seat_stats`

One row per kept seat. With `hand_stats` and `hands` it gives back the
engine's `StatsRow` - all 133 columns - exactly (`tests/stats.rs` checks
every corpus row against `rail_stats` byte for byte in JSON). `WITHOUT
ROWID`; cascades with its `hand_stats` row.

| Column | Type | |
| --- | --- | --- |
| `hand_id` | INTEGER → `hand_stats` | PK with `seat` |
| `seat` | INTEGER | |
| `player` | TEXT | the name as the parser wrote it (`''` for none) |
| `scope` | TEXT | `''`, or for a villain of an `opaque-id` hand its session (`<table>@<day>`) |
| `is_hero` | INTEGER | 0 / 1 |
| `position` | TEXT NULL | `BTN`, `SB`, ... |
| `hole_cards` | TEXT | the cards separated by spaces, `''` when none were seen |
| `hand_class` | TEXT NULL | `AKs`, `77`, ... |
| `starting_stack`, `starting_stack_bb_tenths` | INTEGER | |
| `totals` | BLOB | the 90 counters and 7 money values (`rail_store::stats::encode_seat`): every value that is not 0 as two LEB128 varints, the column's index (counters `0..90` in `COUNTER_KEYS` order, then `MONEY_KEYS`) and the value zigzagged; ~15-40 bytes |

**Why a blob.** The first version mirrored the web's table column for
column (the hand's columns on every seat, a column per counter): 2 KB more a
hand (3 283 → 5 297 bytes, +61 %) and 21-29 % fewer hands imported a
second on the 100k benchmark, the writer's time going to six 133-column
records a hand. Nothing reads a seat's counters in SQL: the rollups hold
the sums, and the rows are read for a report's partial days, a rebuild's
comparison and (R2.7) reports by situation, all summed in Rust.

### `player_rollups`

Per (site, player, scope, segment) the sums of the current generation's
seat rows **with `aggregate`'s default exclusions**
(`frontend/src/lib/stats/rates.ts`): bomb pots left out of everything,
EV-cashout hands left out of the money (`money_hands` counts the hands
whose money is in). The HUD reads one row per player and segment; a
player's segments of a site are one range of the key. `WITHOUT ROWID`.

| Column | Type | |
| --- | --- | --- |
| `site` | TEXT | PK: (`site`, `player`, `scope`, `segment_id`) |
| `player` | TEXT | |
| `scope` | TEXT | see "Under which identity" above |
| `segment_id` | INTEGER | |
| `last_played_at` | TEXT NULL | the newest `played_at` counted |
| `hands`, ... `cashed_out` | INTEGER | the 90 counters, `rail_stats::COUNTER_KEYS` in order (the web's names) |
| `won`, ... `cashout_risk` | INTEGER | the 7 money columns, `MONEY_KEYS` |
| `money_hands` | INTEGER | the hands whose money is summed (`moneyHands`): bb/100 divides by it |

### `hero_rollups`

The hero's rows summed per (segment, position, UTC day, kind), **nothing
excluded**; `kind` keeps apart what `aggregate`'s options decide on (bomb
pot 1, straddled 2, EV cashout 4), so a report applies any of them. Reports
sum days instead of hands. Same sum columns as `player_rollups`
(`money_hands` = `hands` here). `WITHOUT ROWID`, PK (`segment_id`,
`position`, `day`, `kind`).

| Column | Type | |
| --- | --- | --- |
| `segment_id` | INTEGER | |
| `position` | TEXT | `''` when the engine assigned none |
| `day` | TEXT | `YYYY-MM-DD` of `played_at` (UTC), `''` for a hand without one |
| `kind` | INTEGER | bomb pot 1 \| straddled 2 \| EV cashout 4 |

### `ev_rows`

The hero's all-in EV where it differs from the result (`applicable` rows of
`rail_equity::ev_row`), at `ev_version`. Cascades with the hand.
`WITHOUT ROWID`.

| Column | Type | |
| --- | --- | --- |
| `hand_key` | TEXT PK → `hands` | |
| `seat` | INTEGER | the hero's |
| `ev_version` | TEXT | `ev/1` |
| `ev_net`, `ev_net_bb_milli` | INTEGER | |

### `ev_pending`

Hands whose EV the background pass has to compute, newest (highest `id`)
first. Cascades with the hand.

| Column | Type | |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `hand_key` | TEXT UNIQUE → `hands` | |

### Reading them (`rail_store::stats_read`)

| Call | For | How |
| --- | --- | --- |
| `Reader::hud_totals(site, &[(player, scope)], segments)` | the HUD (R3.7): a table's players, over its segment, a set, or all of the site's | one `player_rollups` key range per player |
| `Reader::player_rollup(site, player, scope, segment)` / `player_rollups(site, player, scope)` | a player's row in one segment / in every segment of a site | key lookups |
| `Reader::hero_totals(&HeroFilter)` | reports (R2.7): the hero by segment and position over a date range, with `aggregate`'s options, and the all-in EV adjustment | whole UTC days from `hero_rollups`; the partial days at the two ends from the hero's rows (`hand_stats_played_idx`), so any range of UTC instants is exact (a local-time range is passed as instants); EV from `ev_rows` (few) and the queue's count |
| `Reader::segments()`, `segment_id(&Segment)` | segment ids and back | |
| `Reader::stats_status()` | the status line | `kv` and `count(*)` of `ev_pending` |

## The Hands screen (version 7, R2.7a)

The desktop's hand list, the user's notes and tags on hands, and the
screen's saved filters. Read and written by `rail_store::hand_list`.

### `hand_list`

One narrow row per `hand_stats` row (a hand with statistics rows: every
hand with a hero, and every other hand but a positionally anonymised room's
without one): what the list shows and filters on, so a page never reads
`hands` (whose rows hold the PHF) except for its own rows. **Derived**, like
the statistics: written by `stats::Pending::add_rows` with the hand's
`hand_stats` row - at import, by a pull, by a rebuild - and deleted with it
by the trigger `hand_stats_list_delete` (which a cascade from `hands` fires
too). `WITHOUT ROWID`, clustered by the list's order: newest first is the
primary key read backwards, and a page after a cursor is a seek.

| Column | Type | |
| --- | --- | --- |
| `played_at` | TEXT | PK with `hand_key`: `hands.played_at`, `''` for a hand without one (it sorts last) |
| `hand_key` | TEXT | |
| `site_hand_id` | TEXT | `hands.site_hand_id`; `hand_list_site_hand_id_idx`: "go to hand" by the number the room printed (on the list, not on `hands`: an index on `hands` would read the whole PHF table inside the migration) |
| `segment_id` | INTEGER | `hand_stats.segment_id`: the site, format, variant, limit, table size and stake filters are a set of segment ids |
| `hero_position`, `hero_cards` | TEXT NULL | the hero's seat row (`seat_stats.position`, `hole_cards`); NULL without a hero |
| `hero_net`, `hero_net_bb_milli` | INTEGER NULL | the hero's net, minor units and thousandths of a big blind (`seat_stats.totals`) |
| `hero_stack_bb_tenths` | INTEGER NULL | the hero's starting stack, tenths of a big blind (the stack-depth filter) |
| `board` | TEXT | the primary runout (`primaryBoard`), cards separated by spaces, `''` before a flop |
| `all_in` | INTEGER | 0 / 1: the hero all in with cards to come - the hands with an `ev_rows` row. A preflop all-in is written 1 and set to what the background pass found when it evaluates it (`stats::apply_ev_rows`) |
| `showdown` | INTEGER | 0 / 1: `results.wentToShowdown` |
| `pot_type` | TEXT | `hand_stats.pot_type` |
| `currency_symbol` | TEXT | `game.unit.symbol` (`$`; `''` for chips) |
| `kind` | INTEGER | (version 8) the hand's `hero_rollups` kind: bomb pot 1, straddled 2, EV cashout 4 - the reports apply `aggregate`'s exclusions from it |
| `hero_wtsd` | INTEGER | (version 8) 0 / 1: the hero's `wtsd` counter, the graph's showdown / non-showdown split (`showdown` is the hand's) |
| `currency`, `minor_units` | TEXT, INTEGER | (version 8) `game.unit.code` and `currency_minor_units`: the reports' money refusals (chips with cash, two currencies) and their sums' unit |

`tests/common` checks, after every write in the store's tests and after every
kill in the crash test, that the list rows are exactly the `hand_stats` rows
and agree with them and with the hero's seat row.

A store from version 6 has statistics but no list rows: migration 7 deletes
`kv` `stats.version`, so opening it starts a rebuild (`stats::ensure_current`)
and the background pass writes the list rows as it goes (measured at 498k
generated hands: the open 0.25 s, the rebuild 114 s, during which the list
fills). Migration 8 adds four columns the same way: SQL cannot read the
hero's `wtsd` out of `seat_stats.totals`, so the rebuild writes them (498k
hands: the open 2.0 s, the rebuild 100 s).

### `hand_notes`, `hand_tags`

The user's words on a hand: one note (`hand_key` PK, `note`, `updated_at`;
an empty note is no row) and any number of tags (`(hand_key, tag)` PK,
`added_at`; a tag is trimmed, inner whitespace one space, 1-40 characters,
`hand_list::normalize_tag`). Keyed by `hand_key` with **no** foreign key:
they survive anything that happens to the derived rows (a rebuild, a hand
deleted and imported again). `hand_tags_tag_idx (tag, hand_key)`: the hands
of a tag and the tags in use. **Local only for now**: syncing them to the web
(a Supabase table, the outbox) is a later step.

### `saved_filters`

The screens' saved filters (guideline §6): `id`, `screen` (`hands`, or
`reports` since R2.7b), `name` (unique per screen; saving under a name
replaces it), `filter` (the window's filter as JSON, checked by the app to
parse as a filter), `created_at`.

### Reading them (`rail_store::hand_list`)

| Call | For | How |
| --- | --- | --- |
| `Reader::hand_page(&HandFilter, after, limit)` | a page of the list, newest first; `next` is the cursor of the page after (`(played_at, hand_key)` of its last row) | `hand_list` backwards from the cursor, the filter's clauses on its columns; `hands`, `hand_stats`, `ev_rows`, `ev_pending`, `hand_notes`, `hand_tags` joined for the page's rows only. With a note or tag filter the query starts from those (small) tables instead |
| `Reader::hand_facets(&HandFilter)` | the counts beside the filter chips: per group, the hands the filter would match with that group's own selection left out | one pass over the rows of the date range (notes and tags applied), counted in Rust by (segment, position, pot type, all-in, result, stack depth); cached per read connection until the next commit, so a chip clicked over the same range recounts from the groups |
| `Reader::hand_rows(keys)`, `find_hands(query, limit)` | rows of given hands; "go to hand" by the room's id or the hand key | `hand_list_site_hand_id_idx` (a prefix is a range of it) |
| `Reader::hand_annotations`, `hand_tags`, `noted_hands`, `saved_filters` | a hand's note and tags; the tags in use; hands with a note; a screen's saved filters | |
| `set_note`, `add_tag`, `remove_tag`, `save_filter`, `delete_saved_filter` | writes, on the writer (`WriterHandle::write`) | |

Measured on a generated 497 809-hand store (the R1.6 benchmark dataset;
`cargo run --release -p rail-store --example hand_list_queries`): see
docs/RAIL-PLAN.md, R2.7a *As built*.

## The Today and Reports screens (version 8, R2.7b)

No table of their own: `hand_list` (with version 8's columns) in its
primary key's order is the hero's hands in time order, which is what the
win-rate graph and the sessions need, and the statistics are
`hero_totals`' (`hero_rollups` and the partial days' seat rows).
`saved_filters` holds Reports' filters under `screen = 'reports'`.

### Reading them (`rail_store::report`)

| Call | For | How |
| --- | --- | --- |
| `Reader::report_hero_filter(&ReportFilter)` | the `HeroFilter` of a report's filter (segments, positions, dates) | the segments' dimensions to a set of ids |
| `Reader::report_graph(&ReportFilter, points)` | the win-rate graph: `ntile` buckets of the hero's hands in time order (dated first, then `hand_key`), cumulative big blinds and money, showdown / non-showdown by `hero_wtsd`, the all-in EV line, and the sample's money refusals (`Units`) | one range scan of `hand_list` (bomb pots out by `kind`, an EV cashout's money out); `ev_rows` / `ev_pending` looked up for the all-in rows only; cached per read connection until the next commit |
| `Reader::sessions(gap, limit, pots)`, `latest_session(gap, pots)` | sessions: runs with no gap longer than `gap` minutes, across tables (the web's `stats_sessions`); money refused per session; with `pots`, the tables and the biggest pots in big blinds | `hand_list` read newest first until `limit` sessions are closed; tables and pots join `hand_stats` and `hands` for the session's rows |
| `Reader::report_breakdowns(&ReportFilter)` | the hero's totals by pot type, stack band (the web's `stack_bb`), starting hand, players dealt in and street reached | one pass over `hand_stats` in table order (`NOT INDEXED`: `hand_stats_played_idx` is 10-20 times slower for a whole store) with the hero's `seat_stats` row; cached like the graph |

Measured on the generated 497 809-hand store
(`cargo run --release -p rail-store --example report_queries`): see
docs/RAIL-PLAN.md, R2.7b *As built*.

## The Players screen (version 9, R2.7c)

The opponents, the user's words on them, and an opponent's hands by name.
Read and written by `rail_store::players` (the list, a profile, the
words) and `hand_list` (a player filter); `player_summary` and
`player_hidden` are written by `rail_store::stats` with the rollups,
`player_hands` by the background pass.

**Who is a player** (docs/DATABASE.md "Player identity and anonymized
rooms"): an opponent's seat row at scope `''` with a name - a villain of a
room that prints real screen names. A positionally anonymised room has no
villain rows; an opaque-id room's villains have their session as scope
(R2.3) and are **counted, never listed**: a token is another person next
session, so a list, a profile or a note across sessions would describe
someone nobody played. The same rule as the web's `stats_opponents` (listed
by name, opaque rows counted) and `set_player_note` (refused for both). A
note is not scoped to a session either: a session's token is gone when the
session ends, so a note on it would never be read again, and on the next
session's holder of the same token it would be wrong.

### `players`, `player_labels`

The user's words: per (`site`, `player`) a colour (`red`, `orange`,
`yellow`, `green`, `blue`, `purple` - a `CHECK`; NULL for none), a note
(trimmed, at most 2 000 characters; `''` for none) and `updated_at`; a row
with neither is deleted. Labels in `player_labels` (`site`, `player`,
`label`) PK, `added_at`: trimmed, inner whitespace one space, lower case,
1-24 characters, no control character, at most 8 a player -
`players::normalize_label`, the web's `player_notes.tags` rules, so a later
sync carries them unchanged. `player_labels_label_idx (label, site,
player)`: the players with a label, the labels in use. Keyed by the natural
key with **no** foreign key, like `hand_notes`: they outlive any rebuild.
Written only for an opponent ([`players::is_opponent`]: an entry in
`player_hands` or a summary line), refused otherwise
(`Error::NotAnOpponent`); clearing is always allowed. **Local only for
now**: syncing them with the web's `player_notes` is R4.x (docs/RAIL-PLAN.md
R2.7c *As built*).

### `player_summary`

Per (`site`, `player`) of a named opponent, what the list shows and sorts
by, summed like a rollup with `aggregate`'s defaults (bomb pots out; an EV
cashout's result out of the money): `hands` (their seat rows counted),
`first_played_at` / `last_played_at`, and of those hands the ones the hero
played too, cash (`cash_hands`) and tournament chips (`chips_hands`) apart,
with the hero's result in them over the hands whose money counts
(`cash_money_hands`, `cash_net_bb_milli`, `chips_money_hands`,
`chips_net_bb_milli`): the web's `stats_opponents` joins the hero's row of
the same hand; here it is summed at import. Chips and cash are never added
(the web refuses a result for a scope with both). Emptied by a rebuild
(`begin_rebuild`) and summed again by its pass. `WITHOUT ROWID`.
`tests/common::assert_rollups` holds it to the seat rows after every store
test and every kill of the crash test.

### `player_hidden`

Per `site`: the opaque-id opponents' seat rows (`hands`, of which
`cash_hands`), bomb pots out - what the list says it left out. Summed and
emptied like `player_summary`.

### `player_hands`

(`player`, `hand_id`, `seat`) PK, `WITHOUT ROWID`: every named opponent's
seat row at scope `''`, by name - "hands with this player" and the profile
by position read an opponent's rows from it. **Written by the background
pass, not the import** (`stats::index_players`, `kv` `players.indexed`:
every `hand_stats.id` up to it is done; [`background::INDEX_PAGE`] hands a
transaction, sorted): written by each import transaction - as a partial
index on `seat_stats` or as this table at the flush - it cost the import 4-5 %
of its rate (measured: each transaction touches a page of a name-ordered
table per opponent). A rebuilt hand whose row reuses an id the pass has
passed (deleting the highest id and inserting again) is written inline. A
deleted seat row takes its entry with it (`seat_stats_player_delete`).
`StatsStatus::players_unindexed` counts the hands not done yet.
`tests/common::assert_rollups` holds it to the seat rows up to the mark.

A store from version 8: migration 9 creates the tables empty and forgets
`stats.version`, so the store rebuilds its statistics in the background
(the summary is summed from the seat blobs) and the pass then fills
`player_hands`.

### Reading them (`rail_store::players`, `hand_list`)

| Call | For | How |
| --- | --- | --- |
| `Reader::player_list(&PlayerQuery)` | the list: a prefix of the name in any case, a room, a kind (all / cash / chips), colours, labels, a note; most hands together first; the scope's money refusal and hidden count | `player_summary` read whole once per commit (`PRAGMA data_version`) and searched in memory; `players` / `player_labels` joined in memory; `player_hidden` |
| `Reader::player_profile(site, player)` | a profile: the summary line, the rollups (`player_rollups` at scope `''`, every segment of the site), the words | key lookups |
| `Reader::player_positions(site, player, segments)` | the profile by position; a hand per segment (a stake's label) | the player's `player_hands` entries, each seat row's blob summed in Rust (`aggregate`'s defaults) |
| `Reader::hand_page` / `hand_facets` with `HandFilter::player` | "hands with this player" | from `player_hands` through `hand_stats` (the room by segment) to the list rows, sorted after |
| `Reader::player_notes`, `player_labels` | the words; the labels in use | |
| `set_note`, `set_colour`, `add_label`, `remove_label` | writes, on the writer | refused for anyone but an opponent |

Measured on the generated 497 809-hand store with renamed players
(`cargo run --release -p rail-store --example players_queries`): see
docs/RAIL-PLAN.md, R2.7c *As built*.

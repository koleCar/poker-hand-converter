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
| 5 | `0005_sync.sql` | `outbox.played_at` (filled from `hands`) and `outbox_recent_idx`, `outbox_retry_idx`; `hands.pulled_at` and `hands_pulled_idx`; `sync_rejected` (R1.9) |
| 6 | `0006_stats.sql` | `segments`, `hand_stats`, `seat_stats`, `player_rollups`, `hero_rollups`, `ev_rows`, `ev_pending` (R2.3) |

Reserved for later steps, each as the next free number when it lands (the
numbers are not fixed in advance; the order is):

| Step | Tables |
| --- | --- |
| R2.7 (Phase 2) | `players` (notes, colour tag, labels) |
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

Indexes: `file_id`, `imported_at`, `played_at`; `hands_pulled_idx` on
`pulled_at` where it is set (version 5).

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

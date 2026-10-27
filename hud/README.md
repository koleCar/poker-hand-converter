# Rail HUD (`hud/`)

The heads-up display: statistics panels drawn over poker table windows, on
Windows and macOS. Three Rust crates, all members of the root Cargo
workspace:

| Crate | What it is |
| --- | --- |
| [`rail-hud`](rail-hud) | The HUD process: finds table windows, decides per room whether a HUD is allowed, reads the players' numbers from the local store (read-only), draws one overlay per table and follows it. Library `rail_hud` + binary `rail-hud` |
| [`rail-hud-ipc`](rail-hud-ipc) | The channel between the desktop app and the HUD process: messages, framing, authentication, transport, and the app's supervisor |
| [`rail-hud-sim`](rail-hud-sim) | The table simulator: windows titled like a room's tables, writing real corpus hands at play speed - the development and CI harness for the watcher and every HUD step |

The product view (what the HUD shows, per-OS mechanisms, the policy table)
is in the root [`README.md` §5 and §6](../README.md#5-components) and the
commands in [§8](../README.md#8-getting-started); the plan, budgets and
as-built notes are [`docs/RAIL-PLAN.md`](../docs/RAIL-PLAN.md) §3.2 - §3.3
and R3.0 - R3.14. This file is the map of the code.

**State today:** every step of Phase 3 runs on the simulator, gated in CI on
macOS and Windows. **No real poker client is attached yet**: every room's
`tables.title` in [`config/sites.json`](../config/sites.json) is `null`
until the owner captures the clients' window titles
([`CAPTURING-TABLES.md`](../docs/research/CAPTURING-TABLES.md)) and checks
the HUD on them ([`REAL-CLIENT-CHECK.md`](../docs/research/REAL-CLIENT-CHECK.md)).

---

## How it fits together

```
 room's client writes a hand ──► rail-watch (app) ──► rail-store (rail.db, WAL)
                                        │                    ▲          │
                                        │ hand_imported       │ writes   │ read-only
                                        ▼                    │          ▼
   app (rail-app)  ── rail-hud-ipc ──►  rail-hud engine ── data.rs: rollups over the
   supervisor           socket / pipe        │               table's segment
        ▲                                    │
        │ tables_open, attach_refused,       ├─ platform: find tables, follow them
        │ open_popup, seat_position_changed  ├─ compliance: room allowed? (no override)
        └────────────────────────────────────┤
                                             └─ panel + layout + scene ──► overlay per table
```

Three rules from the architecture hold here:

1. **The HUD is its own process.** A stalled or crashed app never freezes
   the overlays on live tables, and the other way round. The app starts it
   as a Tauri sidecar and restarts it when it dies or hangs; the HUD exits by
   itself when its standard input closes (the app is gone).
2. **The HUD reads only the local store**, opened read-only
   (`SQLITE_OPEN_READ_ONLY`, `query_only`). Supabase is never on its path.
   It writes nothing: a dragged panel or a note edited in the popup goes to
   the app, which writes it.
3. **Compliance mode lives in the HUD process itself.** It attaches only to
   windows of a room whose `hud.allowed` is `true`; unknown counts as no, and
   there is no override anywhere.

---

## `rail-hud`

### Modules (`rail-hud/src/`)

| Module | What it does |
| --- | --- |
| `lib.rs` | Command line (`Args`), exit codes, `run`: load the shipped `sites.json`, merge `--policy`, connect to the app, run the engine |
| `main.rs` | Exits with `rail_hud::main_with(args)`; forbids `unsafe` |
| `engine.rs` | The one loop: looks for tables every 500 ms (the safety net once hooks follow them), attaches or refuses each window once, matches each `hand_imported` to its window by exact table name, re-reads, redraws, reports health, latency and `tables_open` |
| `compliance.rs` | `hud.allowed` per room from the merged configuration; a remote copy can only make a room stricter; produces the `Permit` every frame carries |
| `data.rs` | The read path: `Reader::hud_totals` over the table's segment, `hud_own_totals` on rooms that allow statistics from your own hands only, the user's own statistics, `PRAGMA data_version` to notice commits without a message |
| `panel.rs` | What a seat's panel says: the definitions with `hud: panel` (VPIP, PFR, 3B, F3B, CB, AFq), colour band, reliability opacity, hand count; the player's colour, note mark and labels where allowed; `PanelDesign::enforce` applies a room's restrictions |
| `design.rs` | HUD designs, presets (`config/hud/presets.json`: cash, tournament, Spin, and tournament by stack depth for ACR only), assignments per room / format / table size, `check_for_room` |
| `layout.rs` | Where panels go: a room's layout per table size in thousandths of the client area, the table graphics a panel must not cover, dragged positions, panel sizes |
| `seats.rs` | Which slot a hand-history seat is drawn at: the room's numbering, the hero's "preferred seat" rotation, the table size |
| `scene.rs` | A frame turned into rectangles and text at physical pixels, under the permit; palette (near-black panels, light blue / off-white / light orange figures), the legend (`-` `=` `+`) |
| `latency.rs` | The HUD's half of the latency budget: message arrival to rollups re-read |
| `list.rs` | `--list-windows`: the read-only diagnostic that captures real table titles, redacted |
| `platform/mod.rs` | The `Platform` trait (find tables, follow, overlay, permission) and table identity |
| `platform/matcher.rs` | A room's processes and title regex; the table name read from a title; `table_key` equality (`Table 1` is not `Table 11`) |
| `platform/tracking.rs` | The platform-free half of following a window (moves, resizes, minimise, z-order, coalescing per window) |
| `platform/drag.rs` | The platform-free half of dragging a panel: a press that never moves is a click (the popup) |
| `platform/windows.rs` + `windows/` | `EnumWindows` discovery, layered no-activate overlay owned by the table window (Direct2D, DirectWrite), WinEvent hooks |
| `platform/macos.rs` + `macos/` | Window-server list for bounds, Accessibility API for titles, non-activating `NSPanel` overlays (Core Graphics, Core Text) on AppKit's main thread, `AXObserver` tracking |
| `platform/sim.rs` | A fake backend driven by the simulator's events, so the whole data path runs headless on every OS |
| `platform/none.rs` | Systems without a HUD (Linux, CI only): no tables, ever |

### One hand, from file to panel

1. The room appends a finished hand; the app's watcher stores it (seat rows
   and rollups in one transaction).
2. The app sends `hand_imported` (room, table name, players, the watcher's
   and the commit's timestamps).
3. The engine finds the attached window of that room whose table name
   equals the hand's. A hand of a table it is not attached to - a refused
   room above all - is not read (its players are remembered, up to 256
   tables, for a window found a moment later).
4. `data.rs` re-reads those players' rollups over **the table's segment**
   (site, format, variant, limit, table-size class, stake). On PokerStars,
   Winamax and ACR - rooms that allow statistics from your own hands only -
   the part from hands without you is subtracted.
5. `panel.rs` evaluates the design's statistics, `scene.rs` lays them out
   under the permit, the backend paints the overlay.
6. `table_updated` goes back to the app with the latency chain (watcher,
   import, message, re-read, frame). A debug build also writes it on the
   table; a release build never.

Nothing about the hand in play is ever shown: rooms write a hand when it
has ended, the watcher stores it only once its file is quiet, and the HUD
reads nothing but the store (`tests/in_play.rs`). A restarted HUD shows a
table's numbers at once from its newest stored hand when that hand is from
the last 15 minutes.

### Room restrictions

`sites.json` `hud.restrictions` are data. The editor in the app refuses a
design a room would refuse; the renderer enforces the same rules on
whatever reaches it (defence in depth): on PokerStars no card-split
statistic, no cell that switches with the stack, at most two colour
thresholds, no labels; on Winamax no switching by game state; on ACR no
labels and no panel over the room's own table graphics. The default panel
complies with every allowed room at once. The policies themselves, quoted
and dated: [`docs/research/HUD-POLICIES.md`](../docs/research/HUD-POLICIES.md).

### Command line

The app starts it as:

```
rail-hud --store <rail.db> --ipc <endpoint> [--policy <local data>/policy/sites.json]
```

with a token as the first line of standard input. For development:

| Flag | Meaning |
| --- | --- |
| `--standalone` | No app: messages printed to standard error |
| `--platform native` (default) / `sim` | This system's backend, or the simulator's events |
| `--sim-events <file>` | The simulator's standard output, as it is written (`--platform sim`) |
| `--sim-site <id>` | The `sites.json` room the simulator's tables pose as; compliance decides on it as on a real window (`pokerstars` attaches, `ggpoker` is refused) |
| `--sim-title <regex>` | With the native backend: the simulator's real windows as that room (tests only; never in `sites.json`); pairs repeat for several rooms |
| `--policy <file>` | A stricter `sites.json` merged over the shipped one |
| `--latency-report <file>` | Every hand's latency chain, one JSON object a line |
| `--perf-report <file>` | Paint and follow times, re-reads and looks for tables, written at shutdown |
| `--list-windows [--process <exe>] [--you <name>] [--try-title <regex>]` | List visible windows with redacted titles (see `--list-windows --help`) |

Exit codes: 0 shut down (or the app is gone), 2 bad arguments, 3 could not
join the app, 4 the connection broke, 5 the shipped configuration did not
load.

### Permissions

Windows asks for nothing. macOS needs **Accessibility** only, to read the
poker clients' window titles; never Screen Recording, never Input
Monitoring. The HUD reports `permission_needed` in its health answer and
asks for the permission only when the app forwards the user's click
(`request_permission`); the app asks only while a supported client is
running. The permission belongs to the bundle that started the HUD
(Rail.app), so until releases are Developer ID signed every new build has
to be granted again.

---

## `rail-hud-ipc`

| Module | What it does |
| --- | --- |
| `protocol.rs` | The messages, one JSON object each, `type` in snake_case, fields camelCase, `PROTOCOL_VERSION` 1. Unknown types read as `Unknown` and unknown fields are ignored, so additions are not protocol changes |
| `frame.rs` | 4-byte big-endian length, then the JSON; zero-length and oversized frames refused before allocating (`MAX_FRAME` 1 MiB, 1 KiB until the handshake is done) |
| `auth.rs` | A fresh 256-bit token per HUD process on its standard input; a mutual HMAC-SHA256 challenge-response (`client_hello`, `server_hello`, `client_proof`, `welcome`) with constant-time comparison |
| `transport.rs` | Unix: a socket `0600` in a fresh `0700` folder; Windows: a named pipe, first instance only, remote clients rejected, DACL for the owner and SYSTEM only |
| `link.rs` | A connection as a reader thread and a writer with a bounded queue: a send never blocks; a full queue drops and then sends `resync` |
| `supervisor.rs` | The app's side: start the sidecar, hand it its token, accept only the process just started, health every 2 s (10 s without an answer restarts it), backoff 0.5 s doubling to 30 s, reset after a 60 s run, never gives up; `shutdown` then kill after 1.5 s; a missing binary looked for again every 30 s |
| `client.rs` | The HUD's side: read the token, connect, authenticate |

Messages:

| App to HUD | HUD to app |
| --- | --- |
| `hand_imported` (site, table, players, timing) | `health` (with a report: attached, refused, waiting tables, store open, platform, re-read latency, remote policy in force, permission needed) |
| `stats_changed` (a recompute swapped) | `tables_open` (count; pauses the app's heavy work and slows sync) |
| `layout_changed`, `settings_changed` | `attach_refused` (reason: `prohibited`, `unknown`, `not-a-room`, `unknown-site`) |
| `policy` (the remote `sites.json`, or none) | `table_updated` (latency chain) |
| `resync`, `health`, `shutdown` | `seat_position_changed` (a dragged panel, for the app to store) |
| `request_permission` (after the user's click) | `open_popup`, `open_in_app` |

---

## `rail-hud-sim`

Not a poker client and never writes into one's folder: the output is a new
temporary folder, or an `--out` that is empty or was made by the simulator.
Every window says "RAIL TABLE SIMULATOR". Hands are real corpus hands
(`fixtures/samples/<room>/`) rewritten with a fresh id, the table's name,
the current time, rotated seats and one invented cast per table (`names.rs`:
made-up names, never real ones).

| Module | What it does |
| --- | --- |
| `room.rs` + [`rooms.json`](rail-hud-sim/rooms.json) | Per room (PokerStars, Winamax, ACR): title and file-name templates, encoding, separators, sizes, and which of it is sourced or invented (all window titles are invented); the test-only title regex |
| `corpus.rs` | The room's corpus hands the simulator can replay |
| `rewrite.rs` | One hand rewritten for a table and read back to prove it |
| `sim.rs`, `clock.rs` | Tables, the play-speed clock, commands, events; integer calendar maths and a seeded random source |
| `output.rs` | The simulator's own folder and appending a hand the way the room does |
| `draw.rs`, `gui.rs` | The drawn table (CPU, softbuffer, winit; no GPU), seat positions as fractions of the client area |
| `command.rs` | Commands on standard input or in `--script` (`pause`, `speed`, `open`, `close`, `hand`, `tablemove`, `move`, `resize`, `minimize`, `restore`, `focus`, `tile`, `status`, `quit`, `wait`) |
| `verify.rs` | `verify`: read a run's folder back through `rail_core::convert` |

Events are JSON lines on standard output (`started` with the title regex,
`table`, `window`, `hand`, `closed`, ...). [`scripts/tracking.txt`](rail-hud-sim/scripts/tracking.txt)
is the tracking tests' script. Options: `--room`, `--tables`, `--sizes`,
`--speed`, `--hands`, `--tournament`, `--preferred-seat`, `--headless`,
`--out`, `--script`, `--seed`, `--title-regex`, ... (`--help` lists them all).

---

## Build, run, test

```bash
cargo build -p rail-hud                 # beside the app's dev binary in target/debug/
cargo run -p rail-hud -- --help
cargo run -p rail-hud-sim               # 3 PokerStars tables, 2 hands/min each
cargo run -p rail-hud-sim -- --room acr --tables 12 --sizes 6 --speed 6
cargo run -p rail-hud-sim -- --headless --hands 20 --out /tmp/sim-hh
cargo run -p rail-hud-sim -- verify --room pokerstars --out /tmp/sim-hh --hands 20
```

The HUD standalone on the simulator, without the app:

```bash
cargo run -p rail-hud-sim > /tmp/sim-events.jsonl &
cargo run -p rail-hud -- --standalone --store <rail.db> --platform sim \
    --sim-events /tmp/sim-events.jsonl --sim-site pokerstars
```

Tests (`rail-hud/tests/`): `e2e` (simulator, watcher, store, real
supervisor, headless), `data_path` (segment, own hands only, restart,
recompute swap, the user's statistics), `in_play` (nothing from the hand in
play), `supervisor`, then per OS against the simulator's real windows -
`windows_tables`, `windows_overlay`, `windows_tracking`, `windows_seats`,
`windows_designs`, `windows_compliance`, `macos_tables`, `macos_overlay`,
`macos_tracking` - and `twelve_tables` (R3.14's budget: twelve tables posing
as PokerStars plus one posing as GGPoker, which must get no overlay).

```bash
cargo test -p rail-hud -p rail-hud-ipc -p rail-hud-sim
RAIL_HUD_E2E_TABLES=12 RAIL_HUD_E2E_HANDS=96 RAIL_HUD_E2E_SPEED=30 \
    cargo test -p rail-hud --test e2e -- --nocapture
cargo test --release -p rail-hud --test twelve_tables -- --run --real-hw --seconds 300
```

The Windows- and macOS-only tests and their exact flags are in the root
[`README.md` §8](../README.md#8-getting-started) ("HUD process", "Twelve
tables"). On macOS, tests that click or run the HUD process need the
terminal in Accessibility and print what they skipped without it.

**CI** (`core` job, `.github/workflows/ci.yml`): `cargo test --workspace`
on Linux, macOS and Windows (headless e2e on the `sim` backend); on Windows
the overlay, tracking, seats, designs and compliance tests against real
simulator windows plus the twelve-table overlay measurement; on macOS the
tables, overlay (steps and twelve tables) and tracking tests; on both the
twelve-table run with its report uploaded as `twelve-tables-<os>`, and a
windowed simulator smoke test. The `app` job checks that `rail-hud` is
inside the `.app` and the NSIS installer.

---

## Rules that bind this code

- **Unknown is no, and there is no override.** Only a room whose
  `hud.allowed` is `true` gets an overlay; the web's copy of `sites.json`
  can only switch a room off or add restrictions. The release checklist
  fails on an allowed room checked more than 90 days ago
  (`npm run hud:policy-check` in [`tests/`](../tests)).
- **No real-time assistance.** Past hands' statistics only; nothing about
  the hand in play; while a table is open the app hides what could help
  with play (A10).
- **Read-only store, no network.** The HUD never writes the store and never
  calls Supabase.
- **Integer maths.** Positions in physical pixels and thousandths, scales in
  thousandths; the workspace denies float arithmetic and lossy casts.
  `unsafe` is denied crate-wide and allowed one function at a time only in
  the Windows and macOS system wrappers.
- **No real data in the simulator.** It replays the corpus with invented
  names and never writes outside its own folder; `--list-windows` redacts
  the user's names before anything is shared.

## Further reading

| Topic | Document |
| --- | --- |
| Processes, IPC, latency budget | [`docs/RAIL-PLAN.md`](../docs/RAIL-PLAN.md) §3.2 - §3.3, R3.2 |
| Every Phase 3 step as built | [`docs/RAIL-PLAN.md`](../docs/RAIL-PLAN.md) R3.0 - R3.14 |
| Which rooms allow a HUD, quoted and dated | [`docs/research/HUD-POLICIES.md`](../docs/research/HUD-POLICIES.md) |
| Capturing a room's table titles | [`docs/research/CAPTURING-TABLES.md`](../docs/research/CAPTURING-TABLES.md) |
| Checking the HUD on the real clients | [`docs/research/REAL-CLIENT-CHECK.md`](../docs/research/REAL-CLIENT-CHECK.md) |
| The app side: supervisor wiring, editor, popup, compliance screen | [`app/README.md`](../app/README.md) |
| What the statistics mean | [`docs/STATS-SPEC.md`](../docs/STATS-SPEC.md) |

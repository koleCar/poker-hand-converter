# Rail desktop, HUD and shared core — implementation plan

How we get from today's web app to the product in
[`RAIL_GUIDELINE.md`](RAIL_GUIDELINE.md): a desktop tracker and HUD for macOS
and Windows, a web app on the same data, and one Rust core under both.

Status: **accepted**, 2026-10-12. All amendments A1–A11 accepted by the owner the same day and written into the guideline.

The guideline says *what* and *in what order*; this plan says *how*, breaks
every phase into pull-request-sized steps, and lists what is still undecided.
When the two disagree the guideline wins, and a change of plan goes into the
guideline first (guideline §14). Changes this plan would like to make to the
guideline are collected in §2 and take effect only once the owner accepts them.

Every step has an id (`R0.3`), a size, what it delivers, and an exit check.
Sizes: **S** ≈ a day of agent work, **M** ≈ a few days, **L** ≈ a week or more,
**XL** = split further when picked up.

---

## Contents

0. [Prerequisites outside the code](#0-prerequisites-outside-the-code)
1. [Where we start](#1-where-we-start)
2. [Proposed amendments to the guideline](#2-proposed-amendments-to-the-guideline)
3. [Target architecture](#3-target-architecture)
4. [Phase 0 — Foundations](#phase-0--foundations)
5. [Phase 1 — Import and sync](#phase-1--import-and-sync)
6. [Phase 2 — Statistics and interface](#phase-2--statistics-and-interface)
7. [Phase 3 — HUD](#phase-3--hud)
8. [Phase 4 — Web](#phase-4--web)
9. [Phase 5 — Analysis](#phase-5--analysis)
10. [Phase 6 — Subscription](#phase-6--subscription)
11. [Testing strategy](#11-testing-strategy)
12. [Release and distribution](#12-release-and-distribution)
13. [Risks](#13-risks)
14. [Open questions for the owner](#14-open-questions-for-the-owner)
15. [Log](#15-log)

---

## 0. Prerequisites outside the code

None of these is code, several have lead times, and the phases that need them
stall without them. Start the long ones now.

| Id | What | Needed by | Lead time / cost | Notes |
| --- | --- | --- | --- | --- |
| P1 | **Rust toolchain** on the development Mac (`rustup`, stable; targets `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `wasm32-unknown-unknown`) | R0.1 | minutes | **Done 2026-10-12** (rustup, Rust 1.99.0). |
| P2 | **A domain** for Rail | R1.7, §12 | days | Needed for the desktop sign-in page, the `rail://` handoff page, the update feed, Resend (email confirmations are still off because Resend has no verified domain), Sign in with Apple. |
| P3 | **Apple Developer Program** membership | first signed macOS build (R1.1 can run unsigned) | ~1–2 days, ~€99/year | Notarization, Developer ID certificate, Sign in with Apple. |
| P4 | **Windows code signing** (Azure Trusted/Artifact Signing, or an OV certificate) | first public Windows build | days to weeks; check eligibility for an individual in Croatia before choosing | Unsigned installers trigger SmartScreen warnings, which breaks "works immediately". |
| P5 | **A Windows test machine** | Phase 3 (Windows first) | — | A real PC, or Windows 11 on ARM in Parallels on the Mac if the poker clients run there under emulation. GitHub's Windows runners build and run tests but cannot host a poker client. |
| P6 | **Accounts on the target rooms**, with play-money tables where they exist | R1.4 (folder paths), R3.0, R3.3 | — | Play money writes hand histories on several rooms and is the safe way to test a HUD on a real client. |
| P7 | **Google OAuth** credentials (and later Apple) for Supabase Auth | R1.7 | hours | Google is still off in the dashboard; the web shows "not available yet". |
| P8 | **Licence decision** for the public repository | before Phase 6 | — | The repo is public; a paid product built on a public core needs a deliberate licence (or a private split). |

---

## 1. Where we start

The guideline describes a product from scratch. Much of it already exists on the
web, built carefully, with a test suite behind it. The plan builds on that
rather than beside it.

| Guideline chapter | Exists today | Gap |
| --- | --- | --- |
| §2 Parser / Rail core | 19 TypeScript parsers (~17k lines), PHF model, validator, serializer, detection (~5k lines); 413 real corpus files; 3188 tests incl. byte-exact round trips | Rust port; native + WASM builds |
| §2 Rail Hand Format | `phf/1`, with tournament level, bounty, prize pool, run-it-twice, provenance | Rust definition; TS types generated from it |
| §2 Quarantine / registry | `unparsed_hands` (deduped by fingerprint, occurrence counter, triage status), `unparsed_gaps` view | Desktop-side registry, consent, anonymisation, OS / client version fields |
| §3 File watcher | — (web takes drops, folders and zips) | Everything |
| §4 Supabase | Project in Central EU; `hands`, `hand_stats`, `hand_stats_ev`, `profiles`, `player_notes`, `shares`, analysis, Learn and forum tables; insert-only RLS; pgTAP suite | `hand_sources`, `players`, `hud_layouts`, desktop ingest RPC, pull for sync |
| §4 Auth | Email + password with Turnstile, cookie sessions; Google wired but off | Desktop sign-in flow; Apple |
| §5 Stats engine | `stats/2` in TS: ~90 counters per seat, PT4/HM3 disagreements documented, rebuild-on-version-bump path, breakdowns, opponents, sessions, all-in EV | Rust port; data-defined display stats; custom stats; local rollups |
| §6 Desktop app | — | Everything |
| §7 HUD | — | Everything |
| §8 Web | Live: converter, library, replayer, stats, sessions, notes, analysis, Learn, forum, share links with hidden names | WASM core, live desktop hands, Storage originals, shared components |
| §9 Analysis | Live on web: all-in EV, per-decision grading with our own solver, preflop charts, leaks, drills, study plan | Session review; leak finder framed as "top three"; desktop access |

Parts of the web the guideline does not mention — **Learn, the forum, sharing
and the hand analysis** — stay where they are, on the web. Nothing in this plan
removes them.

---

## 2. Proposed amendments to the guideline

Each one is a place where following the guideline literally would throw away
something that works, contradict a promise the web app makes, or hit a wall we
already know about. **All eleven were accepted on 2026-10-12** and are written
into `RAIL_GUIDELINE.md`, tagged with their id. New amendments get the next id
and wait here until accepted.

| Id | Guideline says | Proposal | Why |
| --- | --- | --- | --- |
| **A1** | A new "Rail Hand Format" with `schema_version` | **Rail Hand Format = PHF.** Keep the identifier `phf/1`; the next breaking change is `phf/2`. | Every stored `hands` row carries `schema_version = 'phf/1'`; the format already covers tournaments, bounties, run-it-twice and provenance; `PHF-SPEC.md` is its spec. Renaming the id buys nothing and forces a migration. |
| **A2** | Web upload: files to Storage, an Edge Function parses them with WASM | **Parse in the browser** (WASM core in a Web Worker, as today's TS does). Uploading the original file to Storage is an **opt-in** next to "save to library". No Edge Function on the parsing path. | The web promises — in code, in UI copy and in the README — that a dropped file never leaves the tab unless the user saves it. Edge Functions also have tight CPU-time and memory limits that a large ZIP would hit. The browser already does this work today at corpus scale. |
| **A3** | Tailwind CSS + shared UI package | **Shared UI package with CSS Modules and the existing token layer.** No Tailwind. | ~4,400 lines of tuned CSS (the replayer's container-query layout among them) and a lint-enforced token system exist; the web's rule is "CSS Modules, not Tailwind". A shared package does not need Tailwind; it needs shared tokens and components. |
| **A4** | Tables `profiles`, `hand_sources`, `hands`, `hand_players`, `players`, `player_stats`, `hud_layouts`, `unsupported_formats` | **Map onto the existing schema** (table in §3.5): keep `hands` and its key; `hand_stats` plays the role of `hand_players`; extend `unparsed_hands` instead of a new `unsupported_formats`; add `hand_sources`, `players`, `hud_layouts`; add `player_stats` only if the 1M-hand benchmark shows the server needs it. | Two tables for the same thing drift apart. `hand_stats` already has one row per dealt-in seat with position, stack class and every counter. |
| **A5** | Original files in Storage; hands in Postgres | **A storage budget per hand.** Today a hand costs ~7.3 KB in `hands` (PHF + `standard_text` + `source_text`) plus ~3.9 KB in `hand_stats` with opponents on — about **11 GB per million hands**. Proposal: desktop-synced hands do not send `standard_text` (it is derived), and original text goes to Storage compressed per file, not per row. Decide before R1.8. **Decided 2026-10-13 (Q4):** the desktop sends PHF + per-seat stats only - no `standard_text`, no `source_text`, `meta.rawText` empty; the originals stay on the user's disk and the standard text is derived on demand. Measured in R1.8: a desktop row is ~3.6 KB (PHF ~2.9 KB). | A HUD user with 1M hands is ordinary; at today's row size the database bill decides the subscription price. |
| **A6** | Sign-in in the app (email, Google, Apple) | **Desktop sign-in through the system browser**: the app opens the web sign-in page, the web completes it (Turnstile works there), and hands the session back with PKCE through a `rail://` deep link. | Email/password sign-in requires Turnstile, which is bound to the web domain and will not run inside the app's webview. Browser sign-in also gives password managers and existing Google sessions for free. |
| **A7** | Appendix A: every room "Planned", HUD rules "check" | **Update Appendix A** to the real state: 18 rooms already parse; WPT Global cannot (no export since June 2026); GGPoker and Ignition-family files are not written live and carry no persistent opponent names, so they are import-only whatever their policy says. | The table is what agents will read when choosing work. |
| **A8** | — | **A table simulator** (`rail-hud-sim`) as the development and CI harness for the watcher and the HUD: windows titled like real tables, writing real corpus hands to a folder at play speed. | The HUD cannot be tested in CI against real clients, the owner develops on a Mac while the HUD starts on Windows, and the 12-table target needs a repeatable load. |
| **A9** | Each phase starts only when the previous one is done | **Allow overlap where there is no dependency**: R1.1–R1.3 (app shell, store, watcher) may start once the PokerStars family is ported (R0.7), while the remaining parsers are still being ported. Phase 0 is still "done" only when all are. | The watcher and store do not depend on the Winamax parser. Serialising them adds weeks for nothing. |
| **A10** | Analysis "only outside play" | **Make it mechanical**: while the HUD process sees any open table, the app hides analysis, solver, equity and chart screens. | A promise that depends on the user remembering is not compliance. |
| **A11** | Statistics are records in `config/stats/` (name, opportunity, action, street, position) | **Two layers.** The ~90 counters of `stats/2` stay code (ported, golden-tested; every one of them encodes a judgement call from `STATS-SPEC.md`). Displayed and custom stats are data: formulas over counters plus filters, and, for new opportunities, a small predicate language over per-seat decision events (R2.10). | A declarative rewrite of VPIP would silently re-decide 40 documented PT4/HM3 disagreements. Proof the two layers agree: the predicate language re-expresses the standard set and matches the coded counters on the whole corpus. |

---

## 3. Target architecture

### 3.1 Cargo workspace

```
Cargo.toml                 workspace
rust-toolchain.toml        pinned stable
core/
  rail-core/               PHF model, decode, detect, parsers, positions, validate, serialize
  rail-core-wasm/          wasm-bindgen facade, JSON in/out, used by web/ and tests/
  rail-stats/              counters per seat (stats/2 → …), rollups, rates
  rail-equity/             all-in EV (exhaustive hold'em, seeded Monte Carlo for Omaha preflop)
  rail-store/              SQLite schema, migrations, queries (rusqlite, bundled)
  rail-watch/              folder discovery, notify + rescan, incremental tail reader
  rail-sync/               outbox, Supabase client, pull cursor
  rail-config/             sites.json + stats/ loading and schema validation
app/
  src-tauri/               Tauri 2 shell: commands, tray, deep link, updater, sidecar launch
  src/                     React + TypeScript UI (Vite)
hud/
  rail-hud/                overlay process (Windows + macOS backends behind one trait)
  rail-hud-sim/            table simulator (A8)
```

### 3.2 Processes

| Process | Owns | Talks to |
| --- | --- | --- |
| **App** (Tauri) | UI, watcher, import, SQLite writer, sync, auth tokens (OS keychain) | Supabase over HTTPS; HUD over local IPC |
| **HUD** (`rail-hud`, Tauri sidecar) | Table discovery, overlays, popups | SQLite read-only (WAL readers never block the writer); app over IPC |

IPC is a local socket (Unix domain socket on macOS, named pipe on Windows) with
length-prefixed JSON messages: `hand_imported {site, table, hand_key, players}`,
`layout_changed`, `settings_changed`, `open_in_app {player}`, `health`. The app
restarts the HUD if it dies; the HUD keeps drawing from SQLite if the app is
busy. *As built* (R3.2): `hud/rail-hud-ipc`, protocol 1 - also
`stats_changed {epoch}`, `policy {remote}`, `resync` and `shutdown` to the HUD,
`tables_open {count}`, `attach_refused`, `table_updated` from it; a token per
HUD process and a mutual handshake; see R3.2. Popups that need rich content
(stats by situation, notes) open as small Tauri webview windows and reuse
`packages/ui`; the always-visible panels are drawn natively for speed.

### 3.3 Latency budget (target < 1 s, aim < 250 ms)

| Stage | Budget | How |
| --- | --- | --- |
| Room writes the hand → OS event | 50–100 ms | FSEvents latency set low; ReadDirectoryChangesW |
| Read the new bytes, find complete hands | 5 ms | stored offset per file, complete-hand boundary check |
| Parse + validate + stats | < 5 ms per hand | Rust core |
| SQLite commit (hand, counters, rollups, outbox) | 10–20 ms | one transaction, WAL, `synchronous=NORMAL` |
| IPC to HUD + query 6–9 players' rollups | < 10 ms | rollups keyed by player, cached in the HUD |
| Redraw overlay | < 16 ms | native drawing, one window per table |

The HUD shows a player's numbers from the first hand written for that table; a
table that has not produced a hand yet shows "waiting for first hand".
*As built* (R3.7): the chain is measured per hand, end to end, in the
headless e2e (`hud/rail-hud/tests/e2e.rs`, debug build, M2 Pro, 12 tables,
96 hands): written -> the watcher's notice 12 ms, notice -> import 503 ms
(the 500 ms quiet period), import -> `hand_imported` sent 1.7 ms, IPC 0.14
ms, the re-read 0.8 ms, the frame 0.4 ms (p50s); **the whole chain p50 506
ms, p95 521 ms** - < 1 s holds (asserted on the p95), the aim of 250 ms
waits on the quiet period (R1.3).
*As built* (R3.14): the same chain through the HUD process on this system's
backend, twelve windowed tables and a refused thirteenth, gated in CI on
macOS and Windows (`tests/twelve_tables.rs`, written -> frame p95 < 1 s;
paint p95 < 16.7 ms gated with `--real-hw`, on CI recorded under a
three-frame ceiling); release on the M2 Pro (data path): p50 513 ms, p95
517 ms.

### 3.4 Local SQLite schema (first version)

| Table | Contents | Key |
| --- | --- | --- |
| `sources` | watched folders: path, site override, enabled, recursive, status | `id` |
| `files` | path, size, mtime, read offset, encoding, site, last error | `path` |
| `hands` | hand key, site, played_at, format, stakes, table, hero seat, PHF (zstd), parser version | `hand_key` |
| `quarantine` | refused hands: file, offset, stage, reason, message, raw text | `id` |
| `unsupported` | registry (R0.11): header sample, guessed site, OS, client version, count, first seen, consent state | fingerprint |
| `seat_stats` | one row per dealt-in seat at the current stats version — the local `hand_stats` (built: `hand_stats` per hand + `seat_stats` per seat, R2.3) | `(hand_key, seat)` (built: `(hand_id, seat)`) |
| `player_rollups` | summed counters per (player, segment) for the HUD and reports | `(site, player, segment)` (built: `(site, player, scope, segment)`; the hero's per day in `hero_rollups`) |
| `players` | notes, colour tag, labels | `(site, name)` |
| `hud_layouts` | layouts, presets, seat positions per (site, table size) (built in R3.6: `hud_seat_positions` per (site, size, slot) and `hud_room_settings` per site; R3.9: `hud_layouts` - the user's designs - and `hud_layout_assignments` per (site, size, format); the presets are `config/hud/presets.json`) | `id` |
| `outbox` | hands not yet synced, attempts, last error | `hand_key` |
| `kv` | schema version, sync cursors, settings | `key` |

A *segment* is (site, game format, variant, limit, table-size class, stake
bucket). Reports filter and sum over segments; the HUD reads one row per player
for the segment of the current table.

As built in R2.3 (`rail_stats::Segment`, `core/rail-store/SCHEMA.md`
"Statistics"): **site** is the site id trimmed and lower-cased (`hand_key`'s
prefix); **table-size class** is by the table's seats (`maxSeats`, the hand's
players when under 2): `hu` (2), `6max` (3-6), `full` (7+); **stake** is,
for a cash game, the unit's code and the big blind in its minor units,
exactly (`USD:200` = $1/$2, `TCHIP:200` play money): each stake level is its
own bucket, coarser groupings (micro, NL2-NL5) are sums at query time, which
a coarse key could not be split back from; for the tournament formats it is
`chips` (blinds rise; the buy-in is a filter, not a segment). The rollups
are `player_rollups` (site, player, scope, segment) and `hero_rollups`
(segment, position, UTC day, kind); the seat rows are `hand_stats` +
`seat_stats` (counters in a compact blob), and the hero's all-in EV is
`ev_rows` / `ev_pending` (R2.3 *As built*).

Built in R1.2 (`core/rail-store`, every table and column in
`core/rail-store/SCHEMA.md`): `kv`, `sources`, `files`, `hands`,
`quarantine`, `unsupported`, `outbox`; `files` and `quarantine` have an
integer `id` (`files.path` stays unique) so that `hands.file_id` and
`quarantine.file_id` are small. `seat_stats`, `player_rollups` and their
companions came with R2.3 (migration 6); the Hands screen's `hand_list`,
`hand_notes`, `hand_tags` and `saved_filters` with R2.7a (migration 7);
`players` with R2.7c (migration 9: the user's words, with the list's sums
and the opponents' rows by name beside it); the HUD's seat positions and
preferred seat with R3.6 (migration 13: `hud_seat_positions`,
`hud_room_settings`); the HUD editor's designs and assignments, and sync
marks on all four HUD tables, with R3.9 (migration 15: `hud_layouts`,
`hud_layout_assignments`).

### 3.5 Supabase mapping

| Guideline | Decision | Step |
| --- | --- | --- |
| `profiles` | existing; add `plan`, `plan_until` in Phase 6 | R6.2 |
| `hand_sources` | new: folder or web upload, owner, device, status counters (built: a watched folder per device; no paths) | R1.8 |
| `hand_arrivals` | new (not in the guideline): one row per account, bumped once per insert statement on `hands`; the web's Realtime signal, so `hands` stays out of the publication | R1.10 |
| `hands` | existing; key `(owner_id, hand_key)` with `hand_key = site:hand id` | — |
| `hand_players` | not added; `hand_stats` has one row per dealt-in seat | — |
| `players` | new: tags and colours; `player_notes` stays (or is folded in) | R2.7 |
| `player_stats` | only if R2.9 shows server-side reports need it - **it does** (R2.9 *As built*: the web's reports over 1M hands of one user take 5-44 s; a hero rollup, `player_stats` and a covering index recommended, not built) | R2.9 (measured), R4.x |
| `hud_layouts` | new; synced so layouts follow the user to a second machine (built: one table for designs, assignments, seat positions and room settings, keyed (owner, kind, key), last writer wins by the client's `updated_at`, written only by `put_hud_layouts`) | R3.9 |
| `unsupported_formats` | extend `unparsed_hands`: `origin` (web/desktop), `os`, `client_version`, `consented_at` | R0.11 |

Rules that do not change: RLS on every table, clients insert only, no
service-role key in any client, opponent data belongs to one user and is never
shared.

### 3.6 `config/sites.json` (shape)

```jsonc
{
  "version": 1,
  "sites": [{
    "id": "pokerstars",
    "name": "PokerStars",
    "parser": "pokerstars",
    "paths": {
      "windows": ["%LOCALAPPDATA%\\PokerStars*\\HandHistory\\*"],
      "macos":   ["~/Library/Application Support/PokerStars*/HandHistory/*"]
    },
    "files": { "glob": "*.txt", "encoding": "auto", "live": true },
    "tables": {
      "process": { "windows": ["PokerStars.exe"], "macos": ["PokerStars"] },
      "title":   "^(?<table>.+?) - .*(?<stakes>[$€]\\S+/[$€]\\S+)",
      // R3.6: per size, thousandths of the client area (measured, else null)
      "seatLayouts": { "6": { "seats": [[500, 840], …], "plate": [170, 80],
                              "center": [500, 540], "heroSlot": 0,
                              "graphics": [[285, 480, 430, 150]], "seatNumbers": null } },
      "preferredSeat": true
    },
    "hud": { "allowed": true, "source": "https://…", "checkedAt": "2026-…", "notes": "" }
  }]
}
```

Paths here are illustrative; R1.4 verified the first ones on real installs
(see *As built, R1.4*; how: `docs/research/VERIFYING-PATHS.md`). The app
ships a copy and fetches updates from the web origin over HTTPS; a downloaded
file is schema-validated and may only make HUD policy *stricter* than the
shipped copy, never looser, until a new signed release says otherwise. Since
R3.6 that covers the table data that bears on compliance too: a room's
table-graphics zones only grow and its process names only narrow.

Since R3.10 the app does exactly that: `<web origin>/sites.json` is the
repository's file published by the web build, fetched every few hours,
checked whole, merged stricter-only and cached (*As built, R3.10*).

Built in R0.12 (`config/sites.json`, `config/sites.schema.json`,
`core/rail-config`); the real shape adds `kind`, `network`, `operating`,
`skins`, `anonymisation`, `docs`, `notes`, and a verification status on every
path and on the `files` and `tables` blocks - see *As built, R0.12*.

---

## Phase 0 — Foundations

**Goal.** Rust core gives the same output as today's TypeScript for every file
the converter supports; the unsupported-format registry works; the repository
has its target shape; CI builds on macOS and Windows.

**Exit.** Golden diff 100 % for all 19 parsers on Linux, macOS and Windows and
under WASM; the registry records an unknown file end to end.

### R0.1 Workspace and CI skeleton — S
- Cargo workspace (§3.1) with empty crates, `rust-toolchain.toml`, `rustfmt`,
  `clippy -D warnings`.
- CI job `core` on `ubuntu-latest`, `macos-latest`, `windows-latest`: fmt,
  clippy, test. Existing jobs unchanged.
- **Done when** CI is green on all three with an empty core.

### R0.2 Documents — S
- This plan, the guideline copied to `docs/RAIL_GUIDELINE.md`, the new README,
  the old README kept as `docs/WEB.md`. Accepted amendments (§2) written into
  the guideline.
- **Done when** merged.

### R0.3 Golden oracle from TypeScript — M
- `tests/scripts/golden/emit.ts`: runs today's pipeline over every file in
  `fixtures/samples/`, `gg-hh/`, `weplay-hh/` and `tests/test/fixtures/`, and
  writes one file per input under `testdata/golden/`:
  `{ detected, hands: [canonical PHF], refusals: [{index, stage, reason}], standardText: sha256, warnings }`.
- Canonical JSON: sorted keys, integers only for money, no floats anywhere.
- CI check `golden-fresh`: the TS pipeline still produces exactly the committed
  goldens. A parser fix in TS therefore updates goldens in the same PR, and the
  Rust side sees the change as a failing diff, never as silent drift.
- **Done when** goldens are committed and `golden-fresh` is green.
- *As built* (§15): PHF bodies are committed as sha-256 of their canonical
  JSON (full JSON is 137 MB) and written out in full to the gitignored
  `testdata/golden-full/`; format and canonical form in
  [`testdata/golden/README.md`](../testdata/golden/README.md).

### R0.4 PHF model in Rust — M
- `rail-core::phf`: serde types mirroring `frontend/src/lib/phf/types.ts`
  field for field; `Amount = i64`; enums with the same string tags.
- TypeScript declarations generated from Rust (`ts-rs` or `tsify`) into
  `core/rail-core-wasm/pkg/phf.d.ts`; a CI check compares them structurally
  with `types.ts` until `types.ts` is replaced by the generated file (R4.1).
- **Done when** every golden hand deserialises and re-serialises to identical
  canonical JSON.
- *As built* (§15):
  - `rail_core::phf` (`core/rail-core/src/phf/mod.rs`): one Rust type per
    `types.ts` type; the inline object types got names (`PhfBounty`, `PhfPot`,
    `PhfWinner`, `PhfMarkerLabels`, `CurrencyKind`, `ChipMovementAnchor`).
    `Amount = i64` is the **only** `i64`; seats, indices, line numbers and
    counts are `u32` (largest in the corpus: a `buttonSeat` of 2 684 684).
    `PhfAction.type` is the field `kind`; `schema` is the one-variant enum
    `PhfSchema`. Constants that are data: `PHF_SCHEMA`, `STREET_ORDER`,
    `BUTTON_BLIND_VERB`, `PhfFees::ZERO`, `PhfTextStyle::default()`
    (= `DEFAULT_TEXT_STYLE`). The currency units and every function in
    `types.ts` are R0.5.
  - Field shapes are strict both ways (`phf/serde_util.rs`): `T | null` must
    be present, `x?: T` may not be `null`, `x?: T | null` is
    `Option<Option<T>>`; every struct has `deny_unknown_fields`.
  - `rail_core::canonical::to_canonical_json` writes the golden canonical form
    (sorts objects explicitly, so it does not depend on serde_json's
    `preserve_order` being off) and refuses floats and unsafe integers.
  - `core/rail-core/tests/golden_roundtrip.rs`: checks `testdata/golden-full/`
    against the committed goldens (same files; each document equal once its
    PHF bodies are replaced by their hashes), then deserialises every body and
    requires identical canonical bytes. 8 422 / 8 422 hands. Fails with the
    command to run when the full tree is missing. ~13 s in a debug build
    (1.3 s release).
  - Dependencies: `serde`, `serde_json`; dev-only `sha2` and `ts-rs` 12.
    **ts-rs** rather than tsify or specta: it renders declarations from a
    plain test (no wasm-bindgen output to extract, no RC API), it reads the
    serde attributes, and its "large int" setting lets every `i64` render as
    `Amount` without a per-field annotation. The `TS` derive is
    `cfg_attr(test)`, so nothing of it is in the library or the WASM build.
  - Declarations: `core/rail-core-wasm/types/phf.d.ts` (not `pkg/`, which
    wasm-pack owns and gitignores), LF by `.gitattributes`. `cargo test` fails
    when it is stale (`RAIL_UPDATE_DTS=1 cargo test -p rail-core --lib phf::dts`
    rewrites it). `npm run phf:dts-check` in `tests/` asserts TypeScript
    *identity* (stricter than mutual assignability: catches an extra optional
    field and `?:` vs `| undefined`) of every type with its `types.ts`
    counterpart, `PhfHand` deeply. Not checked: the functions and non-type
    constants of `types.ts`.
  - CI: the `core` job sets up Node 22, runs `npm ci` and
    `npm run golden:emit` in `tests/` before `cargo test` on all three OSes,
    and `phf:dts-check` on Linux.
  - For R0.5: deserialise with `serde_json::from_str::<PhfHand>`; produce
    hands with `meta.parsed_at` set by the caller (the goldens pin
    `1970-01-01T00:00:00.000Z`); compare with a golden via
    `sha256(to_canonical_json(&hand))`. Keep new integers `u32` unless they
    are money.

### R0.5 Shared infrastructure — L
- Port, each with its TS unit tests translated: decoding (strict UTF-8 → BOM →
  Windows-1252; UTF-16LE), `parseAmountStrict` and money helpers, detection and
  scoring, `splitHands` helpers, `assignPositions`, `validateHand`, the
  `ParseSkip` reason set, variant lock, Hi/Lo and short-deck evaluators needed
  by validation.
- **Done when** the ported unit tests pass and `assignPositions` +
  `validateHand` agree with the goldens on every golden hand.
- Split in two when picked up: **R0.5a** (everything below except positions
  and validation) and **R0.5b** (`assignPositions`, `validateHand`, the Hi/Lo
  and short-deck evaluators).
- *As built, R0.5a* (§15):
  - **Layout** (`core/rail-core/src/`): `js/` (JavaScript semantics, below);
    `phf/{money,game,hand}.rs` (every function and constant of `types.ts`
    except `assignPositions`, re-exported from `phf`); `decode.rs`
    (`decodeSource`); `detect/` (contract, registry, ranking, `ParseSkip`,
    reason codes, fingerprints, hi/lo and short-deck backstops); `convert.rs`
    (`convertAny` and the file driver); `parsers/` (built-in registry,
    `shared/{p5_encoding,variant_lock}.rs`); `positions.rs` and `validate.rs`
    (report types now, bodies in R0.5b). New dependencies: `regex`, and `sha2`
    moved from dev to normal (fingerprints).
  - **JavaScript semantics** (`rail_core::js`), because the TypeScript's
    behaviour lives partly in the built-ins it calls. `is_whitespace` / `trim`
    / `collapse_whitespace` are JS `\s` (U+FEFF yes, U+0085 no). `JsNumber` is
    an IEEE-754 double in integer arithmetic (`Number()`, `+ - * /`,
    `Math.round`, `toFixed`, `String(n)`), so `Math.round(Number("0.29") *
    100)` is 29 here as there without a float operation in the workspace;
    2 359 operations recorded from Node replay exactly
    (`tests/data/js-number-vectors.{mjs,json}`). `js::regex::js_regex(src,
    flags)` (and `js_regex_lazy!`) compiles a JavaScript pattern **verbatim**
    with JS semantics on the `regex` crate: ASCII `\d \w \b`, JS `\s` and `.`,
    ASCII-only `/i` (JS does not fold `ſ`/`K` to `s`/`k`; `regex` does),
    Annex B literal braces; it refuses lookaround, backreferences, the `u`/`y`
    flags and non-ASCII letters under `/i` instead of approximating them.
    Ported patterns are asserted to still appear character for character in
    the TypeScript source.
  - **Decoding**: `decode_source(bytes) -> Decoded { text, encoding, problem }`,
    `decodeSource`'s order and guards (BOM sniff, NUL-pattern UTF-16, strict
    UTF-8, WHATWG Windows-1252 behind the 2 % / 5 % plausibility guard, lossy
    UTF-8, binary at 5 %, one extra BOM strip, CR/CRLF → LF; each `TextDecoder`
    call drops one BOM of its own). **556 / 556** corpus files give the
    golden's `decode.encoding` and `decode.problem`, and every accepted hand's
    `meta.rawText` (8 396; iPoker's 26 are assembled by the parser) is found
    verbatim in the Rust-decoded text (`tests/golden_decode.rs`); 140 edge
    cases recorded from the TypeScript replay exactly
    (`tests/data/decode-vectors.{mjs,json}`).
  - **Trait** (`detect::SiteParser`): `id`, `name`, `version` (`&'static
    str`), `detect(&str) -> u32` (per-mille), `split_hands(&str) ->
    Result<Vec<String>, SplitError>`, `parse_hand(&str, &SiteParserContext)
    -> Result<PhfHand, ParseError>` where `ParseError` is `Skip(ParseSkip)` or
    `Bug(message)` (TS: `ParseSkip` vs any other exception → `parser-error`),
    and `hi_lo_variants()` / `short_deck()` defaulting to `&[]` / `false`.
    `ConvertOptions` gains `parsed_at` (Rust only: no clock on
    `wasm32-unknown-unknown`; default the golden pin), read by parsers through
    `ctx.parsed_at()`.
  - **Scores** are integer per-mille, `round(score × 1000)`: 0.99/0.95/0.9/
    0.86/0.25 → 990/950/900/860/250, threshold 0.2 → 200, a forced site 1000.
    `Registry` keeps registration order (re-registering an id replaces it in
    place, as `Map.set` does) and ranks with a stable sort, so ties go to the
    earlier parser. `parsers::REGISTRATION_ORDER` is `index.ts`'s order (a test
    reads `index.ts`); the built-in registry sorts whatever is ported by it.
  - **Reasons**: `SkipReason` is the complete set of 58 codes the TypeScript
    throws (a test scans `frontend/src/lib` for `new ParseSkip("…")`, WePlay's
    `Skip` records and `HI_LO_SKIP_REASON`, and fails on any difference);
    `PipelineReason` (`unknown-site`, `split-failed`, `no-hands`,
    `parser-error`, `invalid-hand`); `FailureReason` = either of those or
    `Validation(code)` (a string until R0.5b). `ConversionFailure` mirrors the
    TS record plus `index` (chunk, `None` for file-level). Fingerprints are
    sha-256 over JS-`\s`-collapsed text; `fingerprint_sync` (the FNV fallback)
    is ported for recognising old rows.
  - **Pipeline**: `convert(bytes, filename) -> FileConversion { encoding,
    problem, detected, result: Option<ConversionResult> }` and
    `convert_any(text, &ConvertOptions) -> ConversionResult { hands, failures,
    stats, chunks }`, `convertAny` step for step (forced site, whole-file
    detection, split, per-chunk detection with fallback to the primary,
    `ParseSkip`/bug, hi/lo then short-deck backstop, positions, validation,
    `bySite` in first-seen order). With no parser registered all **24
    unknown-site files match their goldens exactly**, fingerprints included.
  - **How R0.5b plugs in**: positions and validation are called through the
    `convert::HandChecks` trait (`assign_positions`, `validate_hand`); the real
    `CoreChecks` forwards to `positions::assign_positions` and
    `validate::validate_hand`, which `unimplemented!()` until R0.5b replaces
    their bodies (deliberately loud: no hand can pass unvalidated). The report
    types (`ValidationReport { problems }` with `ok()` / `errors()` /
    `warnings()`, `ValidationProblem`, `ContextValue`) are in place; the
    position geometry (`position_ring`, `resolve_positions`,
    `dealt_in_seats`, `has_dead_button`, `button_blind_ring`,
    `is_button_blind`) is ported.
  - **Golden harness for parser steps** (`core/rail-core/tests/golden/mod.rs`):
    `golden::check(Selection::Parsers(&["pokerstars", …]))` in
    `tests/golden_sites.rs`, one line per site. It runs `rail_core::convert`
    on every corpus file whose golden `detected.top` is in the set, checks the
    input bytes against the golden, rebuilds the emitter's document (decode,
    ranking, chunks, hands with PHF hash and warnings, refusals with stage,
    reason, message, site, per-mille, version, fingerprint, stats) and
    requires equality, reporting by JSON path and - with
    `testdata/golden-full/` present - the first differing line of a PHF. The
    standard-text hashes were **pending** until `golden::SERIALIZER` was set
    in R0.6 (left out of both sides and counted in the printed report, never
    silently); candidates of parsers not yet ported are left out of the
    expected ranking and counted. `Selection::Unrecognised` (24 files) and
    `Selection::All` exist too; `compare_file` is the single-file entry.
  - **Not ported**: `toDisplayNumber` and `toBigBlinds` (fractional display
    values for the replayer and share preview only; no floats in the core).
  - **TS oddities kept, and one not**: `allCards` counts a re-dealt river
    twice when a later runout has `flop: []` and `turn: ""` (truthiness);
    `parseAmountStrict("1,2.3,4")` is not-a-number because `Number("1,23")` is
    NaN; `parseAmount("1e5")` is 1500 (the `e` is stripped). Not reproducible:
    `parseAmountStrict("1.234,5.6")` returns `{ ok: true, amount: 183.45 }` in
    TypeScript (the decimal dot twice around a grouping comma); no PHF can hold
    that, so Rust returns the Rust-only problem `not-a-safe-integer`.
  - 38 TypeScript test cases translated (the parser-free ones of
    `phfMoney`, `phfCoreGaps`, `phfDetect`, `phfOmaha`, `phfPositions`,
    `shortDeck`), alongside 117 unit tests in all.
- *As built, R0.5b* (§15):
  - **Layout** (`core/rail-core/src/`): `positions.rs` (`assignPositions`),
    `validate.rs` (`validateHand`, `distinctCardUses`, `describeReport`),
    `phf/hilo.rs` (all of `hilo.ts`: pot keys and groups,
    `assignHiLoHalves`, `hiLoPayoutContradictions`, `NO_LOW_LINE`, the three
    `check*` functions, `orderHiLoAwards` behind a `HiLoAward` trait),
    `cards.rs` (`parseCard`, `extractCards`, `rankValue`), `eval/` (all of
    `equity/evaluator.ts` and `equity/omaha.ts`: card index and code, the nine
    categories, the `STANDARD`, `SHORT_DECK` and
    `SHORT_DECK_STRAIGHT_OVER_TRIPS` tables, `evaluate_masks`, `suit_masks`,
    `evaluate` for codes and `evaluate_indices`, `category_of`, the Omaha
    subset masks, `evaluate_omaha`, `evaluate_omaha_low`, `ShortDeckRule`,
    `SHORT_DECK_RULE_BY_SITE`, `short_deck_rule_for`, `short_deck_table`),
    `phf/tags.rs` (`as_str` of `Variant`, `Street`, `ActionType`, `PotHalf`,
    tested against the serde tags). `js`: `JsError` (a TypeScript `throw`)
    and `JsNumber::{strict_equals, less_than, greater_than, max_of, floor}`.
    Every sum and comparison in the validator and the hi/lo totals is
    `JsNumber` arithmetic, and every number in a message is `String(n)`.
  - **The evaluator lives in the core**, not in `rail-equity`, because
    validation needs it first. **R2.2 adds on top, and changes nothing
    here**: `enumerate.ts` (exhaustive enumeration, `mulberry32`, the Monte
    Carlo path), `multiway.ts`, `range.ts`, `allInEv.ts` and `equity()` /
    `EquityInputError`, calling `eval::{evaluate_masks, suit_masks,
    omaha::{hole_pair_masks, board_triple_masks, evaluate_omaha_masks}}`
    and `short_deck_table(short_deck_rule_for(site))`. `mulberry32` already
    exists in the evaluator tests, in integer arithmetic (`floor(random() *
    n)` is `(u * n) >> 32` exactly), dealing the same hands as the
    TypeScript tests. Not ported from `cards.ts`: the starting-hand classes
    (R2.1) and the filter-box helpers (UI).
  - **A throw in the pipeline.** `validateHand` throws `not a card: …` when
    the hi/lo payout check meets a card the evaluator cannot read (a shower
    or payee with a full hand, five board cards), and `convertAny` does not
    catch it: the whole call rejects. To reproduce that rather than invent a
    refusal, `HandChecks::validate_hand` returns `Result<ValidationReport,
    JsError>`, `convert_any` returns `Result<ConversionResult, JsError>` and
    `FileConversion::result` is `Option<Result<…>>`; the golden harness
    reports a throw as a mismatch. No corpus hand throws (parsers emit
    cards they have read). `assign_hi_lo_halves` and
    `hi_lo_payout_contradictions` return the same `Err`; a parser maps it to
    `ParseError::Bug(message)`, which is TypeScript's `parser-error`.
  - **Golden agreement** (`tests/golden_checks.rs`, needs
    `testdata/golden-full/`): positions cleared and reassigned equal the
    golden's on **8 422 / 8 422** hands; `validate_hand` finds no error and
    exactly the golden warnings (code, context, message, order) on **8 422 /
    8 422** - 532 warnings, 463 from the validator's own checks and 69 parser
    `meta.warnings` re-reported; halves cleared and reassigned give back the
    golden hand on **22 / 22** hi/lo hands (17 with a split); the SUMMARY
    `(small blind)` / `(big blind)` / `(button)` oracle holds on the 6 750 GG
    reference and WePlay hands, every table size 2-9 present; the six
    short-deck hands validate, and fixture 12's payout (straight over trips)
    is what GG's table ranks.
  - **Validate-stage refusals in the corpus: 3** - `negative-stack` 1
    (Chico, `cash__NLHE-10max-USD-0.25-0.05-201108.txt` chunk 10),
    `hi-lo-payout-contradiction` 1 (Entraction `07-allin-showdown.txt`),
    `chip-mismatch` 1 (WePlay `HH20260126 Manchester #3`). R0.7+ reproduces
    them through the real parsers; their pre-validation hands (from
    `convertAny(…, { validate: false })`) are already in the vectors, and
    the Rust report gives each one the golden's reason and message.
  - **Vectors** (`tests/data/check-vectors.{mjs,json}`, 1.8 MB; the
    generator bundles the TypeScript with esbuild from `tests/node_modules`
    and reads `testdata/golden-full/`): the hands the TypeScript unit tests
    start from (21), the 3 refusals, and 1 825 seeded mutations of 110
    golden hands, each with the TypeScript's positions, full report (all 18
    reachable error codes, 28 warning codes) and hi/lo outcome (352),
    including one throw. `tests/check_vectors.rs` replays all of them and the
    translated tests; it needs no `golden-full`.
  - 64 TypeScript test cases translated (`phfValidate`, the
    `assignPositions` and corpus-oracle tests of `phfPositions`, the
    validator tests of `phfCoreGaps`, all of `equityEvaluator`, the
    evaluator, validator and position tests of `shortDeck` and `phfHiLo`);
    the rest of those files is the parsers (R0.7+), the serializer (R0.6),
    the replayer, stats (R2.1) and equity (R2.2).
  - **TS oddities kept**: the duplicate-card check keys cards by their raw
    text, so `Ah` and `ah` are two cards while the evaluator reads both as
    the ace of hearts; the validator subtracts a jackpot drop from a stack it
    never reads again; `bad-schema` is unreachable (a `PhfHand` has one
    schema); a later runout's empty-string turn does not fall back to runout
    0's (`??` keeps `""`), so its river is `river-without-turn`; the odd chip
    of a non-positive big blind is 1; `assignHiLoHalves` with fewer than two
    contenders still clears every half and re-pairs the winners. The
    validator throwing (above) is the one with consequences.

### R0.6 Serializer — M
- `toStandardText` in Rust, including the style fields that make output
  byte-exact (decimal style, grouping, fee columns, header quirks).
- **Done when** for every golden hand the Rust text hashes to `standardText`,
  and `parse(serialize(h)) == h` holds for the `standard` parser.
- *As built* (§15):
  - **Layout**: `core/rail-core/src/phf/serialize/` is all of
    `frontend/src/lib/phf/serialize.ts` - `write.rs` (`to_standard_text`,
    `to_standard_text_with(SerializeOptions { regenerate_summary })`,
    `to_standard_text_file`, `resolveTextStyle`, header, action, pot, board
    and summary lines), `read.rs` (`parse_standard_hand`,
    `split_standard_hands`, `parse_standard_text`, `parseHeader` - which the
    writer also uses to decide whether a captured header may be replayed),
    `date.rs` (the slice of JavaScript's `Date` the text needs:
    `parsePlayedAt` and `format_played_at`, V8's ISO reading with its day
    rollover - `2021-02-31` is 3 March - and `24:00`, extended years, the
    ±8.64e15 ms range). The `standard` parser (`parsers/standard.rs`) wraps
    the reader and is the first parser in the built-in registry, so it moved
    here from R0.7. `StandardContext` carries `parsed_at` (no clock in the
    core).
  - **Patterns** are the TypeScript source verbatim through `js_regex` (a
    test asserts every one still appears in `serialize.ts`). The five that use
    lookahead are code: the hand splitter (a cut before every JavaScript line
    start - after `\n`, `\r`, U+2028, U+2029 - where a header begins, never
    at 0), the decimal-style and digit-grouping probes, `limitFromLabel`'s
    `\bLimit\b(?!\s*Hold)` and the blank-deal-line probe; each is tested
    against outcomes recorded from Node. Multiline (`m`) patterns over
    `meta.rawText` scan JavaScript lines, not `regex`'s `\n`-only lines.
  - **Golden agreement**: `golden::SERIALIZER` is on, so every golden
    comparison now includes `standardText` and `standardTextFile`.
    `tests/golden_serialize.rs` (needs `testdata/golden-full/`):
    `sha256(to_standard_text(h))` equals the golden on **8 422 / 8 422**
    hands and `toStandardTextFile` on **556 / 556** files (`null` for the 0-hand
    ones). `tests/golden_sites.rs::standard`: the **39** files `standard` wins
    (`gg-hh/`, their copies in `fixtures/samples/ggpoker/`, GG's AoF Omaha
    sample, the stats fixtures and `gg/cash-sample.gg.txt`) match their goldens fully - detection,
    chunks, 881 hands (PHF, text, warnings), 0 refusals, stats - with 38
    candidates of unported parsers (`ggpoker`, `pokerstars`) left out.
  - **Round trip**, every golden hand (`tests/data/serialize-vectors.{mjs,json}`,
    1.1 MB, generated by running the TypeScript; the round-trip test reads
    it): `parse_standard_hand(to_standard_text(h))` is the hand the TypeScript
    reads back (canonical JSON) on **8 422 / 8 422**; semantically equal
    (`semantics()` of `phfRoundTrip.test.ts`) on **8 097**, and unequal on
    exactly the TypeScript's 325 (below); byte-stable
    (`to_standard_text(parse(text)) == text`, `phfRoundTrip`/`byteCompat`)
    on **8 421**, the TypeScript's one exception included;
    `regenerateSummary` text equal on 8 422. Plus 2 460 seeded mutations of 205
    golden hands (pinned style fields, odd dates, levels, buy-ins, runouts,
    labels, units, fee columns) - text and re-read equal - and 25 fixture and
    edge texts read and written back, 16 split inputs.
  - **The TypeScript round trip is not lossless on 325 hands**, and Rust
    reproduces that rather than fixing it: WePlay's `dealtLinesForAllPlayers`
    (178), GG tournament fields (67), and for the rest CoinPoker's unit and
    results, Full Tilt, PokerStars, Unibet and Run It Once players, tables
    and action details. One
    hand is not even byte-stable: ACR `…ante.2.txt` hand 0 prints `152027`,
    its re-read prints `152,027` (the first text replays ACR summary lines
    whose grouped numbers then read as this dialect's grouping).
  - **TS oddities kept**: `RUN_PREFIXES[i]` past the fourth runout prints
    `undefined` in a SUMMARY board line but an empty line when the label has
    its own line (`Array.join`); a TURN/RIVER marker whose runout resolves to
    fewer cards prints `[undefined]`; a fee column named `toString` (or any
    `Object.prototype` member) prints `NaN`; the reader writes `-0` for an
    uncalled bet of 0 (Rust has 0; `JSON.stringify` writes 0 too, so the
    stored hand is the same).
  - **Not reproducible, reported**: a straddler without a seat line gets
    `seat: -1` in `game.straddles`, and a seat, table size, button or level
    beyond `u32` stays a JavaScript number; a PHF seat is `u32` (R0.4), so
    the Rust reader returns an error (the parser's `parser-error`). A
    date-time *without* a zone, or anything else V8's legacy `Date` parser
    reads, is local time in JavaScript; the core has no zone and prints
    `NaN/NaN/NaN NaN:NaN:NaN`. No corpus hand reaches either; every
    `playedAt` is `toISOString()` output.
  - 39 TypeScript test cases translated (all of `phfSerializeStyle`, the
    `gg-hh/` half of `phfRoundTrip`, the standard-text cases of
    `phfCoreGaps`, `phfMoney` and `phfOmaha`); the WePlay half of
    `phfRoundTrip` and `byteCompat` need the WePlay parser, and the property
    they check is the corpus-wide byte-stability check above.
  - **For R0.7**: every golden comparison now hashes the standard text, so a
    ported parser must produce `meta.rawText` and `meta.textStyle` exactly -
    the writer reads presentation (grouping, fee columns, the blank deal
    line, the header) off `rawText` when its first line carries the hand id.
    `ggpoker` and `parse_standard_hand` must give the same PHF for the same
    bytes (`ggpokerParser.test.ts`). `serialize-vectors.json` is the
    TypeScript's answers over the goldens: when a TypeScript change moves the
    goldens, regenerate it (`node core/rail-core/tests/data/serialize-vectors.mjs`)
    in the same PR; the test says so when it is stale.

### R0.7 Parsers, PokerStars family — L
- `pokerstars`, `ggpoker`, `weplay`, `coinpoker` (`standard` was done in
  R0.6).
- **Done when** golden diff is 100 % for these sites (hands, refusal reasons,
  warnings). From here, A9 lets R1.1–R1.3 start.
- Split in two when picked up: **R0.7a** (`pokerstars`, `ggpoker` and the
  shared PokerStars-family modules) and **R0.7b** (`weplay`, `coinpoker`).
- *As built, R0.7a* (§15):
  - **Layout** (`core/rail-core/src/parsers/`): `pokerstars.rs`,
    `ggpoker.rs`, and in `shared/` `ps_gg_hand.rs` (all of `ps-gg-hand.ts`:
    the text helpers, `parseSummarySeat` and `StarsHandDraft`), `p3_draft.rs`
    (the re-export `p3-draft.ts` is) and `p3_stars_dialect.rs`
    (`parseStarsFamilyBody`, for Run It Once and PokerBros, ported now and
    held to the TypeScript by vectors until those parsers arrive). Both
    parsers are registered in `index.ts` order.
  - **The shared API** (for CoinPoker, Full Tilt, Run It Once, PokerBros,
    ACR): the TypeScript's names in snake case - `to_lines`,
    `normalize_newlines`, `strip_bom`, `MONEY`, `symbol_in`,
    `has_unsupported_currency`, `unit_for_stakes`, `buy_in_unit_for`,
    `detect_decimals`, `detect_pad_hour`, `parse_played_at`,
    `limit_from_label`, `level_number_of` (`Err` beyond `u32`),
    `parse_summary_seat` (→ `SummarySeat`), `variant_from_label`,
    `is_hi_lo_label`; `DraftGame`, `DraftInit` (plus `parsed_at`: no clock in
    the core), `MarkerKind`, `StarsHandDraft` with every method (`post` takes
    `PostOptions { all_in, verb, line, raw_line }`, the others take those as
    arguments; `warnings` is public), `build() -> Result<PhfHand,
    BuildError>`. Rust-only helpers: `split_before_line_starts` (a
    lookahead `split(/(?=^…)/m)`), `template_regex` (`String.raw` with
    `${MONEY}`/`${SUFFIX}`), `number_u32`, `first_unseated_actor`, and the
    per-site line helpers every TS file copies (`runout_index_for_label`,
    `marker_kind`, `last_bracket_cards`, `unseated`). `parse_stars_family_body(
    lines, &mut draft, &unit) -> Result<DialectResult, ParseError>`.
  - **Golden agreement** (`tests/golden_sites.rs`): `pokerstars` **45 / 45**
    files, **108** hands, **5** refusals (`unsupported-variant` 3,
    `unsupported-hi-lo` 1, `hand-cancelled` 1); `ggpoker` **24 / 24** files,
    **215** hands, **2** refusals (`unseated-actor`) - each fully: ranking,
    chunks, PHF, standard text per hand and per file, warnings, refusal
    stage, reason, message and fingerprint, stats. The 39 `standard` files now
    match with their whole ranking (the 38 `ggpoker` 860 candidates R0.6 left
    out). Whole-file detection of the three ported parsers agrees with the
    goldens on **all 556** corpus files (no foreign file claimed).
  - **Beyond the corpus** (`tests/data/psgg-vectors.{mjs,json}`, 1.3 MB, run
    by `tests/psgg_vectors.rs`; the generator bundles the TypeScript): both
    parsers' splits of every corpus file and of edge texts; detection probes;
    every PokerStars and GG corpus chunk plus seeded line edits (deleted,
    swapped, duplicated, inserted lines from a catalogue of 110 shapes both
    grammars read, changed amounts, 54 other headers - currencies,
    tournaments, levels, variants, spin-offs -, cut summaries, `\r`/U+2028
    line ends, a BOM), each through both parsers: **3 420** cases (2 977
    hands, the rest refusals), all equal; and **164** Run It Once / PokerBros
    dialect cases. Two soak runs with other seeds (`PSGG_STRESS=<seed>`,
    17 054 cases and 1 604 dialect cases each) were equal too.
  - **ggpoker ≡ standard**: on every GG cash hand of the corpus (`gg-hh/`
    and the samples), the GG parser and `parse_standard_hand` agree on the
    projection `ggpokerParser.test.ts` checks (actions, players, pot, fees,
    board) - translated as a test, not shared code: the TypeScript keeps two
    readers too.
  - **Patterns** are the TypeScript source (tests check every one, by
    `/literal/flags` or `String.raw` body). Rewritten by hand and tested
    against Node: `detectDecimals`' two lookaheads, the lookahead splits,
    GG's `BUY_IN_TOKEN` `(?=\s|$)` (consumed instead: the same group 1),
    PokerStars' `.{0,40}` detection probe (JavaScript counts UTF-16 units),
    the multiline GG probes (run at every JavaScript line start).
  - **TS oddities kept**: an empty Home Game tag `{}` gives no `home-game`
    warning (falsy); GG refuses *every* hi/lo label (`unsupportedGameSkip`
    without its list); a GG tournament `()` keeps the empty name `""` (`??`,
    not `||`); `Dealt to` is matched on the untrimmed line, so an indented
    one is an `unknown-line`; a rebuilt uncalled return goes after the last
    action with the last wager's street key (after the folds on that
    street); `posts small & big blinds` with
    a big blind of 0 in the header books the whole post as the big blind;
    `levelNumberOf("ıv")` is 4 (`toUpperCase` turns the dotless ı into I); a SUMMARY outcome
    `showed` is tested for and never produced; insurance by an unseated
    player is an `unknown-line` warning, not a refusal.
  - **Not reproducible, reported**: a straddler with no seat line gets
    `seat: -1` in TypeScript; here `build` returns
    `BuildError::UnseatedStraddler` and the site parsers refuse the hand as
    `unseated-actor` naming the first unseated actor - exactly the refusal
    the TypeScript reaches one step later. A seat, table size, button or
    level beyond `u32` is a `parser-error` (R0.6's rule). Warnings pushed
    onto the draft after `build` do not reach the hand (the TypeScript shares
    the array); no caller does it.
  - One R0.6 test changed with the registry, not the code: a standard-text
    file with a GG tournament and an `RC` hand now routes those two chunks to
    `ggpoker` (0.95 over 0.9), as the TypeScript does with every parser
    registered (recorded from Node).
  - 117 TypeScript test cases translated (`tests/psgg_parsers.rs`): all of
    `pokerstarsParser.test.ts` and `ggpokerParser.test.ts` except the
    replayer checks, with `psggInvariants.ts` ported as test support; the
    PokerStars/GG parts of `phfDetect`, `phfOmaha`, `phfHiLo` and
    `shortDeck` (not their stats, equity and replayer checks, nor the ACR
    file). `phfPositions`, `phfRoundTrip`, `byteCompat` and `phfCoreGaps`
    have no PokerStars/GG part left: their parser-free halves are R0.5/R0.6,
    the rest is WePlay (R0.7b).
  - **For R0.7b**: WePlay wraps `parse_standard_hand` (R0.6); CoinPoker uses
    `StarsHandDraft`, `parse_played_at`, `parse_summary_seat` and
    `limit_from_label` from `parsers::shared::ps_gg_hand` and edits
    `results` after `build` (fine: the hand is owned). Add each to
    `parsers::ported()`, a line to `tests/golden_sites.rs`, and rerun
    `ported_parsers_rank_every_corpus_file_as_the_goldens_do`, which will
    then hold the new parser's scores on all 556 files.

- *As built, R0.7b* (§15) - **with it R0.7, the PokerStars family, is
  complete: amendment A9 lets R1.1-R1.3 start.**
  - **Layout** (`core/rail-core/src/parsers/`): `weplay.rs` (all of
    `weplay.ts`: the normalizer `normalize_weplay_chunk` - exported, as the
    TypeScript exports it for `byteCompat` - `is_bomb_pot_hand`,
    `is_omaha_hand`, and `WePlayParser`, which reads the normalized text with
    `parse_standard_hand` and puts the WePlay original back on
    `meta.rawText`) and `coinpoker.rs` (`CoinPokerParser` on
    `StarsHandDraft`, `looks_like_coinpoker`). Both registered in `index.ts`
    order (`weplay` first, `coinpoker` after `ipoker`). No new shared module:
    CoinPoker needed nothing `ps_gg_hand` did not already export.
  - **WePlay's arithmetic is JavaScript's**: the normalizer computes in
    doubles (`Math.round(Number(raw) * minorUnits)`, `to - raiseBy`,
    `Math.max`, `units % minorUnits === 0`, `(units / 100).toFixed(2)`,
    `String(units)`), so every unit value is a `JsNumber`; `x % m === 0` is
    `is_multiple_of` (finite and an exact multiple - `fmod` is exact). A
    thousandth, or a twenty-digit stack, rewrites to the TypeScript's bytes
    (`$NaN`, `Infinity` included).
  - **Patterns** are the TypeScript source (tests check every literal,
    template and refusal message). Written as code and tested against Node:
    WePlay's hand split (`(?=^Weplay Hand #\d+:)/gm`) and its zero-stack
    probe (a `RegExp` built from an escaped player name: a literal prefix plus
    the verb and an ASCII `\b`); `split(/\r?\n/)` (`split_lines`).
  - **Golden agreement** (`tests/golden_sites.rs`): `weplay` **128 / 128**
    files, **6 726** hands, **96** refusals (`bb-only-walk` 88,
    `uncalled-exceeds-commitment` 3, `ghost-ante`, `unsupported-variant`,
    `short-allin-small-blind`, `zero-stack-actor` 1 each, and the validator's
    `chip-mismatch` on `HH20260126 Manchester #3`); `coinpoker` **16 / 16**
    files, **21** hands, **1** refusal (`hand-cancelled`) - each fully:
    ranking, chunks, PHF, standard text per hand and per file (WePlay's
    `dealtLinesForAllPlayers`, bomb pots, run-it-twice, straddles included),
    warnings (143 `button-not-seated`; CoinPoker's 2 `buy-in-not-stated`),
    refusal stage, reason, message and fingerprint, stats. Whole-file
    detection of the five ported parsers equals the goldens on **all 556**
    files.
  - **Beyond the corpus** (`tests/data/wpcp-vectors.{mjs,json}`, 1.9 MB, run
    by `tests/wpcp_vectors.rs`; the generator bundles the TypeScript): both
    parsers' splits of every corpus file and of edge texts, 22 detection
    probes, and **3 291** seeded mutations (2 389 WePlay, 902 CoinPoker; line
    catalogues of each room's shapes, other headers - currencies, tournaments,
    Omaha, All-in or Fold, unparseable -, changed amounts - thousandths,
    twenty digits -, cut summaries, `\r` / `\r\n` / U+2028 line ends, a BOM),
    each through its parser with the default and the strict options
    (`cashOnly`, `skipBombPots`) and, for WePlay, through
    `normalize_weplay_chunk` alone: all equal, every WePlay and CoinPoker
    refusal reason reached. Two soak runs with other seeds
    (`WPCP_STRESS=<seed>`, 29 414 and 29 404 cases) were equal too. The file
    also records the frozen pre-PHF converter's output for `byteCompat`
    (5 983 hands: 5 783 identical, 148 / 40 / 11 in the three accepted
    classes, 1 dropped with a refusal), which the Rust test reproduces
    exactly.
  - **TS oddities kept**: a whitespace-only WePlay line survives
    normalization (only `""` is dropped); WePlay's header seat lines go
    through the SUMMARY scrubber too (a seat line containing `folded` loses
    any ` showed [..]` / ` and lost with ..`); a `€` or `£` anywhere in a
    chunk (a player name) sets the cash symbol; `posts straddle` and `posts
    the ante` do not move WePlay's tracked bet (`: posts ${AMOUNT}` needs the
    amount right after `posts`), so a raise after a straddle is rewritten
    against the big blind - the reader re-derives it, which is what makes
    the straddle test pass; WePlay's detector accepts a header only at the
    start or after `\n` while its split also cuts at `\r` and U+2028/9; the
    normalizer's per-street commitment map is written and never read (not
    ported - no effect); CoinPoker's `(straddle)` re-read replaces every
    position label (a `(button)` on the same line is lost) and keeps the
    first reading's hand description when the re-read has none; a nameless
    CoinPoker tournament warns `no buy-in for "null"`; CoinPoker's
    `[\r\n]` header probe misses a header after U+2028 (0.3, not 0.95).
  - **Not reproducible, reported**: a WePlay table size, button or seat
    beyond `u32` is the reader's `parser-error` (R0.6's rule); the
    TypeScript builds the hand and only its canonical JSON fails. An amount
    beyond 2^53 builds in both and is unrepresentable in both (the vector
    test checks the JSON path). Warnings added after `build` (R0.7a's note):
    neither parser adds any - CoinPoker edits `results` and may refuse
    `unseated-actor` after `build`, both on the owned hand.
  - 65 TypeScript test cases translated (`tests/wpcp_parsers.rs`): all of
    `weplayParserPhf.test.ts` (16) and `coinpokerParser.test.ts` (36),
    `byteCompat.test.ts`, the WePlay halves of `phfRoundTrip` (3),
    `phfPositions` (the SUMMARY-label oracle and every table size 2-9),
    `phfDetect` (5), `phfValidate` (1) and `handParser` (1), plus 12 unit
    tests. Skipped: the replayer checks (`buildReplay`), `toBigBlinds` (a
    display helper, not ported); `handParser`'s WePlay test drives
    `converter.ts`'s `convertCashWeplayFile` (the UI's legacy facade, not
    core), reproduced as test support. `phfCoreGaps` has no WePlay part
    (it is all parser-free and was R0.5/R0.6).
  - **For R0.8** (`partypoker`, `888poker`, `pokerbros`): `pokerbros` reads
    through `parse_stars_family_body` (R0.7a, already held to the TypeScript
    by vectors). A parser that normalizes text before reading it should keep
    its unit values as `JsNumber` (WePlay's pattern); `wpcp-vectors.mjs`
    shows how to record outcomes under several option sets and how to accept
    the two unrepresentable cases (`unrepresentable_alike` in
    `wpcp_vectors.rs`). `rail-convert` (README §8, "R0.7") is not built yet.

### R0.8 Parsers, `*****` family — M
- `partypoker`, `pokerstars888` (888poker), `pokerbros`.
- *As built* (§15):
  - **Layout** (`core/rail-core/src/parsers/`): `partypoker.rs`,
    `pokerstars888.rs` (`Poker888Parser`, id `888poker`), `pokerbros.rs`
    (both converter dialects), and in `shared/` `p2_partygaming.rs` (all of
    `p2-partygaming.ts`: the banner, 888 and partypoker stakes/date/game
    patterns, `banner_and_stakes`, `known_zone`, `iso_from_party_date`,
    `iso_from_888_date`, `unit_for`, `bracket_amount`,
    `split_bannered_hands`, `is_noise_line`, `is_chat_line`, plus the
    `boardOf` both rooms copy, as `dealing_board`) and `p2_handbuilder.rs`
    (all of `p2-handbuilder.ts`: `DraftStreet`, `DRAFT_STREETS`,
    `DraftSeat`, `DraftKind`, `DraftAction` (with `DraftAction::new`),
    `DraftCollect`, `HandDraft`, `draft_to_standard_text`,
    `format_header_date`, `build_hand`). The three parsers are registered in
    `index.ts` order (`888poker`, `partypoker` after `ggpoker`; `pokerbros`
    after `runitonce`).
  - **For the rooms still to come**: `p2_handbuilder` is the builder of
    iPoker and MicroGaming (R0.9) and of Ongame, Entraction and Unibet
    (R0.10, Unibet calls `draft_to_standard_text` and `format_header_date`
    directly); Ongame also uses `iso_from_party_date` and `known_zone`.
    `toTotal` (iPoker's raise-to) is implemented and exercised by
    PokerBros' party dialect.
  - **The draft is in JavaScript numbers.** The TypeScript builder replays
    the betting in doubles and *prints* the results (commitments, the
    derived uncalled return, pot, rake) into standard text that
    `parse_standard_hand` reads back. So every amount of a draft is a
    `JsNumber` (`money::parse_amount_js`, `format_amount_js`, new), and so are
    seat numbers, the table size and the button (`Seat 007:` prints as
    `Seat 7:`): a twenty-digit amount prints as `$1e+21` and reads back as
    121 cents in both. `JsNumber` gained `min_of` (`Math.min`),
    `is_multiple_of` (moved from WePlay) and `Default`; the shared
    `formatAmountDigits` now tests `% minorUnits === 0` exactly for every
    double (it was exact only within `i64`; no corpus hand changes). JS
    `Date.UTC` (`date_utc`: years 0-99 are 19xx, every field rolls over,
    TimeClip) joined `phf/serialize/date.rs`.
  - **A change in R0.7a's shared modules**: the clone dialect
    (`parse_stars_family_body`) no longer refuses a table size or button
    beyond `u32` on the spot. It passes the JavaScript numbers to
    `StarsHandDraft::set_table_numbers` (new), which holds them back and
    makes `build` return the parser error only if no later `set_table`
    replaced them - which is when the TypeScript's hand holds a number no
    PHF can. PokerBros needs that: it rewrites a button on an empty seat
    from the small blind, so a `Seat #99999999999999999999 is the button`
    becomes a valid hand in TypeScript (found by the soak run).
    `DialectResult` gained `button_seat_number` and `max_seats_number`.
  - **Golden agreement** (`tests/golden_sites.rs`): `partypoker` **15 / 15**
    files, **18** hands, **1** refusal (`no-winner`); `888poker` **14 / 14**
    files, **13** hands, **1** refusal (`truncated-hand`); `pokerbros`
    **2 / 2** files, **2** hands (warnings `button-seat-empty`,
    `unknown-timezone`, `ambiguous-timestamp`, `hero-attribution`) - each
    fully: ranking, chunks, PHF, standard text per hand and per file
    (including both hi/lo fixtures of 888 and partypoker's `wins Lo`),
    warnings, refusal stage, reason, message and fingerprint, stats.
    Whole-file detection of the eight ported parsers equals the goldens on
    **all 556** files.
  - **Beyond the corpus** (`tests/data/p2pb-vectors.{mjs,json}`, 1.8 MB, run
    by `tests/p2pb_vectors.rs`; the generator bundles the TypeScript): the
    three parsers' splits of every corpus file and of 16 edge texts, 24
    detection probes, **3 145** seeded mutations of every corpus chunk of
    the three rooms (catalogues of each dialect's lines; other banners and
    stakes lines - currencies, zones, hi/lo, stud, five-card Omaha, the
    European 888 locale, rolled-over dates -; changed amounts; cut hands;
    `\r` / `\r\n` / U+2028 line ends; a BOM), each through **all three**
    parsers - detection and outcome, 9 435 outcomes (1 851 hands), every
    refusal reason of the three reached - and the 31 corpus files
    re-encoded six ways (UTF-16 LE with and without BOM, UTF-16 BE,
    Windows-1252 with `€` and `£` amounts, CRLF) through `rail_core::convert`
    (186 files, 198 hands): all equal. Two soak runs with other seeds
    (`P2PB_STRESS=<seed>`, 31 135 cases each) were equal too, after the
    deferral above.
  - **TS oddities kept**: partypoker skips any line equal to the stakes line
    and takes the unit from the symbol alone (`$0.05/$0.10 EUR` is USD); an
    888 seat line after `** Summary **` is not a seat line and falls through
    to the other patterns; both rooms read the board off the raw text
    (`boardOf`: the first `** Dealing flop ** [..]` at a JavaScript line
    start, `\s*` may span lines), so a marker with an empty bracket is no
    board and the actions on a street without board cards never reach the
    hand (the builder writes a street's lines only under its marker); a turn
    or river bracket keeps its first card; PokerBros' party dialect keeps
    the last card of a turn/river bracket instead, falls back to the highest
    seat (not a table size) for `maxSeats`, keeps leading whitespace in
    `rawText` (`trimEnd` only) and books a blind posted by an unseated name;
    `big blind + dead` before any big blind is all live; the builder labels
    `(small blind)` / `(big blind)` by the first poster's name and looks the
    name up by seat number (a duplicated seat number labels the first);
    the last `shows` of a player wins the SUMMARY; a `NaN` rake is accepted
    (`NaN < 0` is false); `Date.UTC` reads a year `0014` as 1914 and rolls
    `February 31, 25:61:61` over; an unknown month leaves the header date
    empty; `knownZone` is TypeScript's `in` over upper-cased keys (no
    prototype member is upper case, so it is a plain lookup).
  - **Not reproducible, reported**: nothing new. A seat beyond `u32` is
    still R0.6's parser error (now deferred for the table line, above);
    `toISOString`'s `RangeError` is unreachable for four-digit years.
  - **`rail-convert`** (README §8; no step had owned it): a `[[bin]]` of
    `rail-core`, plain `std` and `serde_json` (already a dependency) - no new
    dependency, and the wasm32 build, which compiles every target of the
    package, still passes. `rail-convert [--json | --text] <file>...`:
    `rail_core::convert` per file; a summary (encoding, ranking, hands,
    refusals with chunk, stage, reason, message), or the canonical PHF array
    (`--json`) or the standard text file byte for byte (`--text`) on stdout
    with the summaries on stderr. Exit 1 only when a file cannot be read, 2
    for a usage error. `tests/rail_convert.rs` runs the binary on three
    corpus files against their goldens (PHF hashes, `standardTextFile`) and
    checks the exit codes.
  - 36 TypeScript test cases translated (`tests/p2pb_parsers.rs`): the
    888poker and partypoker parts of `p2Parsers.test.ts` (corpus, hand
    keys, the shared detection namespace), the PokerBros parts of
    `p3Parsers.test.ts` (corpus, all seven PokerBros tests, the namespace),
    the 888poker/partypoker parts of `phfHiLo` (halves, the converted hi/lo
    fixtures) and `phfOmaha` (partypoker 08), plus source and unit tests in
    the modules. Skipped: the replayer checks (`buildReplay`), the all-in EV
    check (R2.2), and the iPoker, Full Tilt and Run It Once parts.
    `legacyNetworks.test.ts` is Ongame, Entraction and MicroGaming only;
    `phfDetect` and `phfPositions` have no part about these rooms.
  - **For R0.9** (`ipoker`, `microgaming`): both build on `p2_handbuilder`
    (draft amounts are `JsNumber`; set `to_total` for iPoker's raise code).
    Both read XML with `shared/p2-xml.ts`, a hand-written reader (not a
    library) whose leniency and `malformed-xml` refusals are behaviour - port
    it rather than substituting `quick-xml`, or hold `quick-xml` to it with
    vectors. MicroGaming also needs `p4-textroom.ts`'s `decodeBase64Utf16`
    and `strictAmount`. iPoker assembles `meta.rawText` itself (R0.5a's
    decode note: 26 hands). `p2pb-vectors.mjs` is a template for mutation
    vectors that run every case through several parsers.

### R0.9 Parsers, XML — M
- `ipoker`, `microgaming`. Choose the XML reader once (`quick-xml`), share it.
- *As built* (§15):
  - **Layout** (`core/rail-core/src/`): `parsers/ipoker.rs` (`IPokerParser`),
    `parsers/microgaming.rs` (`MicroGamingParser`), and in `parsers/shared/`
    `p2_xml.rs` (all of `p2-xml.ts`: `XmlElement` with `attr`,
    `decode_entities`, `scan_xml`, `parse_xml`, `child`, `children`,
    `child_text`) and `p4_textroom.rs` (all of `p4-textroom.ts`:
    `strict_amount`, `leading_name`, `names_by_length`, `currency_symbol_of`,
    `decode_base64_utf16` (+ `_lossy`), `expand_month`, `refuse_lossy_text`).
    New in `js`: `js::sort::sort_by` (V8's `Array.prototype.sort`, below),
    `LoneSurrogate`, `from_utf16`; in `phf::money`: `parse_amount_strict_js`
    (the `ok` number of `parseAmountStrict`, fractional and beyond 2^53
    included; `parse_amount_strict` is it plus the safe-integer check). Both
    parsers registered in `index.ts` order.
  - **The XML reader is the TypeScript scanner, ported; no `quick-xml`.**
    `parseXml` has two paths - the browser's `DOMParser`, and in Node (the
    test suite and the golden emitter, so the reference) a hand-written
    scanner - and the scanner's leniency is behaviour no XML library has: a
    closing tag closes whatever is open, `<!...>` (CDATA, DOCTYPE) is skipped
    to its first `>`, text after the root and later top-level elements are
    read and dropped, unknown entities stay as written, and the entity table
    is an object literal (`&toString;` decodes to `function toString() {
    [native code] }`). Holding `quick-xml` to that would have meant
    re-implementing it on top; the port is ~300 lines, no new dependency.
    `DOMParser` (browser only) is not ported. Vectors pin the scanner.
  - **Shared code changed** (all earlier vectors and soaks still equal):
    `p2_handbuilder` gained `DraftStreet::Unlisted(&'static str)` and
    `DraftKind::Unmatched` with `object_prototype_member` - what the rooms'
    object-literal tables (`ROUND_STREETS[no]`, `ACTION_TYPES[code]`,
    `STREETS[type]`) return for a key naming an `Object.prototype` member: an
    inert action that only closes its street, and a street the replay has no
    lines for, on which any betting action throws `Cannot read properties of
    undefined (reading 'push')` (a `parser-error`; the replay, and so
    `draft_to_standard_text`, now return `ParseError`). Its two sorts (seats,
    the uncalled-bet entries) now use `js::sort::sort_by`: Rust's `sort_by`
    may panic on a comparator a `NaN` makes inconsistent.
  - **`Array.prototype.sort` as V8 does it** (`js/sort.rs`): iPoker sorts its
    actions by `Number(no)`, and a `NaN` (`no="abc"`) reads as "equal" to
    everything - the order is then the engine's. V8's TimSort (runs, binary
    insertion to `minrun`, merges with galloping, `min_gallop` 7) step for
    step; 1 120 arrays recorded from Node (`tests/data/js-sort-vectors.*`,
    sizes to 1 000, `NaN`, `±Infinity`) replay exactly, and a plain stable
    sort gets over a hundred of them wrong.
  - **Golden agreement** (`tests/golden_sites.rs`): `ipoker` **15 / 15**
    files, **26** hands, **1** refusal (`unseated-actor`); `microgaming`
    **12 / 12** files, **21** hands, no refusal - each fully: ranking, chunks,
    PHF, standard text per hand and per file (both `Omaha H/L` split pots,
    the bad-beat drop as a chip movement, the `MoneyReturned` all-in),
    warnings, stats. Whole-file detection of the ten ported parsers equals
    the goldens on **all 556** files. R0.5a's raw-text check now covers iPoker
    too: each of its 26 assembled `meta.rawText` equals the Rust split's
    chunk of the Rust-decoded file (`tests/golden_decode.rs`).
  - **Beyond the corpus** (`tests/data/xml-vectors.{mjs,json}`, 1.8 MB, run
    by `tests/xml_vectors.rs`): 55 `scanXml` documents and 44
    `decodeEntities` values (prototype entities, references beyond U+10FFFF
    and to surrogates, pairs, CDATA, comments, quotes, case), 29
    `decodeBase64Utf16` and 72 `strictAmount` probes, both parsers' splits of
    every corpus file and 19 edge texts, 21 detection probes, **3 888**
    seeded edits of every corpus chunk of both rooms (attribute values from
    per-attribute catalogues - amounts, codes, seats, names, currencies,
    dates, game types, `Object.prototype` names -, attributes and elements
    deleted, duplicated, moved or inserted from catalogues, element text,
    entity and character references, CDATA, comments, declarations, tag case
    and quotes, truncation, CRLF, one line, U+2028, a BOM), each through
    **both** parsers - detection and outcome (1 082 iPoker and 888
    MicroGaming hands, every refusal reason of both reached) - and the 27
    corpus files re-encoded six ways through `rail_core::convert` (162
    files): all equal. Two soak runs (`XML_STRESS=11`, `=29`, 38 448 cases
    each) were equal too.
  - **TS oddities kept**: the scanner's (above); `&#X41;` is not decoded (the
    pattern has a lower-case `x`) and `&#1f;` is U+0001 (`parseInt` reads the
    digit prefix); a reference beyond U+10FFFF throws, so the whole chunk is
    `malformed-xml`, even when it sits in an element after the root; an
    attribute named `__proto__` is dropped, a repeated one keeps its last
    value; iPoker `type="toString"` deals its player in and does nothing
    else, `<round no="constructor">` or MicroGaming `<Action
    type="valueOf">` (read as a deal: it sets the river) leave a street that
    throws on the next bet; a missing attribute prints as `undefined`
    (`<cards type="undefined">`, `names seat undefined`); iPoker's game label
    is one token, so `Omaha Hi-Lo PL` is an unreadable `<gametype>`
    (`no-header`), and its unit comes from the first `$`/`€`/`£` on any
    player's chips over `<tablecurrency>`; a duplicated player name keeps
    its last seat and stack; a zero-sum unknown action code is dropped
    without dealing the player in; MicroGaming's `strictAmount` keeps
    `parseAmountStrict`'s fractional answer (`1.234,5.6` is 183.45 in the
    draft), and a `currencysymbol` that decodes to half a surrogate pair is
    a symbol no unit has (chips); its cross-check warnings are added after
    the build.
  - **Not reproducible, reported**: (1) a lone surrogate - a reference to
    one (`&#xD800;`), or a Base64 name decoding to half a pair - which a
    Rust `String` cannot hold. The scanner and the Base64 decoder put U+FFFD
    in its place (one UTF-16 unit, not whitespace, no case), so every
    comparison goes as in JavaScript, and `p2_xml::unrepresentable_outcome`
    turns an outcome that shows the stand-in (or a source with a real U+FFFD
    it could be confused with) into a `parser-error`; elsewhere the outcome
    is exact (in the vectors 75 such cases, 22 outcomes answered
    `parser-error`, the rest equal). XML forbids the reference, and the
    browser's `DOMParser` refuses the document. (2) A seat, table size or
    button between 2^32 and 2^53: the TypeScript's hand is valid JSON, a PHF
    seat is `u32` here (R0.6's rule) - a `parser-error`; iPoker makes a
    `seat="99999999999"` the table size. (3) A bad-beat drop's seat beyond
    `u32` (the TypeScript's canonical JSON throws) is a `parser-error`.
  - 33 TypeScript test cases translated (`tests/xml_parsers.rs`, plus the
    reader cases of `p2Xml.test.ts` as unit tests of `p2_xml`): `p2Xml`
    (6), the iPoker parts of `p2Parsers` (8), the MicroGaming parts of
    `legacyNetworks` (15), `phfHiLo` (2) and the iPoker side of
    `unibetParser`'s Unibet / iPoker boundary (2). Skipped: the replayer
    checks (`buildReplay`), the all-in EV check (R2.2), the `DOMParser`
    parity test (skipped in Node too), and the Ongame, Entraction and Unibet
    parts (R0.10). `phfDetect`, `phfOmaha` and `phfPositions` have no iPoker
    or MicroGaming part beyond `isHiLoLabel("Omaha H/L")` (R0.5a).
  - **For R0.10**: the shared modules each parser imports, and what is
    ported - `ongame`: `variant-lock`, `p2-partygaming` (`isoFromPartyDate`,
    `knownZone`), `p2-handbuilder` (`buildHand`), `p4-textroom`
    (`currencySymbolOf`, `expandMonth`, `leadingName`, `namesByLength`,
    `strictAmount`) - all ported; `entraction`: `variant-lock`,
    `p2-handbuilder`, `p4-textroom` (`leadingName`, `namesByLength`,
    `refuseLossyText`, `strictAmount`) - ported; `unibet`: `p2-handbuilder`
    (`draftToStandardText`, `formatHeaderDate`), `p4-textroom`
    (`currencySymbolOf`, `leadingName`, `namesByLength`, `refuseLossyText`,
    `strictAmount`), `parseStandardHand`, `variant-lock` - ported;
    `fulltilt`: `p3-draft`, `variant-lock`, `hilo` - ported; `runitonce`:
    `p3-draft`, `p3-stars-dialect`, `variant-lock` - ported; `acrwpn`:
    `ps-gg-hand` (`limitFromLabel`), `variant-lock`, `p5-encoding`, and
    **`p5-handdraft.ts` (not ported)**; `ignition`: `hilo`
    (`checkStatedTotals`), `variant-lock` and **`p5-handdraft.ts`**;
    `winamax` and `chico`: `variant-lock` and **`p6-handbuilder.ts` (not
    ported)**. `leading_name`, `names_by_length`, `expand_month` and
    `refuse_lossy_text` are held to the TypeScript by unit tests only so far;
    `strict_amount` returns a `JsNumber`. Look for object-literal lookups
    keyed by source text (`object_prototype_member`, `Unlisted`/`Unmatched`)
    and numeric `.sort` comparators (`js::sort::sort_by`, never Rust's
    `sort_by`). `xml-vectors.mjs` shows splice-based mutation by UTF-16
    index and how to mark cases Rust cannot represent.

### R0.10 Parsers, own dialects — XL (one PR per parser)
- `winamax`, `acrwpn` first (HUD-relevant), then `ignition`, `chico`,
  `fulltilt`, `ongame`, `entraction`, `unibet`, `runitonce`.
- Picked up grouped by the shared module the parsers import (one PR each):
  **R0.10a** `winamax` + `chico` (`p6-handbuilder.ts`), **R0.10b** `acrwpn` +
  `ignition` (`p5-handdraft.ts`), **R0.10c** `fulltilt` + `runitonce`,
  **R0.10d** `ongame` + `entraction` + `unibet`.
- *As built, R0.10a* (§15):
  - **Layout** (`core/rail-core/src/parsers/`): `winamax.rs`
    (`WinamaxParser`; Winamax is a HUD-priority room), `chico.rs`
    (`ChicoParser`, `CHICO_PARSER_NAME`, `CONFIRMED_SKINS`,
    `INFERRED_SKINS`) and in `shared/` `p6_handbuilder.rs` (all of
    `p6-handbuilder.ts`). Both parsers registered in `index.ts` order
    (`winamax`, `chico` after `ignition`).
  - **The `p6_handbuilder` API**: `P6Street` (+ `P6_STREETS`), `P6Seat`,
    `P6Kind`, `P6Action` (`P6Action::new(street, player, kind)`, the
    optional fields `None`/`false`), `P6Collect`, `P6Tournament`,
    `P6PrintedUncalled`, `P6Draft` (field for field, snake case),
    `p6_header_date` (the same function as `format_header_date`, reused),
    `p6_to_standard_text(&P6Draft) -> Result<String, ParseSkip>` and
    `build_p6_hand(&P6Draft, &SiteParserContext) -> Result<PhfHand,
    ParseError>`. As in `p2_handbuilder`, every amount, seat, table size and
    button is a `JsNumber`: the TypeScript replays in doubles, prints the
    results into the text it re-reads, and prints them into its refusal
    messages (`Players put in 1e+21 but …`, `Seat 007` read as `Seat 7`).
    The drafted streets are the four real ones (no object-literal lookup),
    so the replay cannot throw; `flop: Some(vec![])` is the TypeScript's
    truthy `[]` (a `*** FLOP *** []` marker).
  - **No merged shared code changed.** Reused: `p2_partygaming::{split_lines,
    iso_from_888_date}` (both rooms' `isoFrom` is `Date.UTC(y, m - 1, d, h,
    mi, s)` then `toISOString`; Chico's missing seconds are `"0"`),
    `p2_handbuilder::format_header_date`, `ps_gg_hand::split_before_line_starts`,
    `serialize::matches_at_line_start`, `variant_lock`.
  - **Patterns** are the TypeScript source (tests check every literal and
    every refusal message). Written as code and tested against Node: the
    `m`-flag detection probes and both lookahead splits (run at every
    JavaScript line start, `\r` and U+2028/9 included), Chico's
    `BRAND`-built headers (`new RegExp` over the escaped skin names) and its
    split filter (`ANY_HEADER` with `m` over the first line, which may hold a
    bare `\r`), Winamax's `assertRepresentableAmounts` (`new RegExp` per
    known symbol), `names.sort((a, b) => b.length - a.length)` (UTF-16
    lengths, `js::sort`), the seat-number `Map`s (`SameValueZero`, insertion
    order).
  - **Golden agreement** (`tests/golden_sites.rs`): `winamax` **26 / 26**
    files, **34** hands, **1** refusal (`board-mismatch`: the street file
    whose markers deal another flop than its summary); the three
    Windows-1252 files convert, decoded by the app (the TypeScript suite
    reads them as UTF-8 and refuses them `unsupported-encoding`, and so does
    the translated suite); the corrupted negative fragment stays
    `unknown-site`. `chico` **16 / 16** files, **48** hands, **20** refusals
    (`rake-mismatch` 15 - 13 of the 17 Omaha hands, the 3-way all-in without
    its side pot, the tournament hand whose summary reports a fifth of the
    pot -, `unseated-actor`, `truncated-hand`, `unnamed-seat`,
    `duplicate-seat` and the validator's `negative-stack` 1 each); the four
    Omaha hands headed `Hold'em Pot Limit` are `omaha`. Each fully: ranking,
    chunks, PHF, standard text per hand and per file, warnings
    (`board-from-summary`, `assumed-currency`, `unreadable-shown-cards`,
    `play-money-table`, and the validator's), refusal stage, reason, message
    and fingerprint, stats. Whole-file detection of the twelve ported parsers
    equals the goldens on **all 556** files.
  - **Beyond the corpus** (`tests/data/p6-vectors.{mjs,json}`, 3.3 MB, run
    by `tests/p6_vectors.rs`; the generator bundles the TypeScript): both
    parsers' splits of every corpus file and of 18 edge texts, 29 detection
    probes, **3 003** seeded mutations of every corpus chunk of both rooms
    (catalogues of each dialect's lines, other headers and table lines -
    currencies, five-card Omaha, hi/lo, short deck, stud, tournaments,
    rolled-over dates, play money, the inferred skins, `Weeds (Hi/Lo)` -,
    comma decimals, grouped and twenty-digit amounts, a swapped currency
    glyph or U+FFFD, cut hands, `\r` / `\r\n` / U+2028 line ends, a BOM),
    each through **both** parsers - detection and outcome (955 hands, every
    refusal reason of both reached) -, **600** seeded `P6Draft`s through
    `p6_to_standard_text` and `build_p6_hand` (mostly balanced from a probe
    of the builder's own pot, one in five knocked out of true: every
    reconciliation refusal including `payout-mismatch`, which neither room
    reaches; 249 hands), and the 42 corpus files re-encoded seven ways
    (UTF-16 LE with and without BOM, UTF-16 BE, Windows-1252 as is and with
    `£`, CRLF, UTF-8 with U+FFFD for the glyphs) through `rail_core::convert`
    (294 files, 495 hands): all equal. Two soak runs (`P6_STRESS=11`, `=29`,
    29 067 cases and 6 000 drafts each; `P6_OUT=<path>` writes the soak file
    elsewhere and `P6_VECTORS=<path>` points the test at it) were equal too.
  - **TS oddities kept**: Winamax refuses every hi/lo label
    (`unsupportedGameSkip` without a list); a stakes amount in a bad locale
    is reported by the whole-text scan's message, not the line-1 one;
    Winamax has no board-size check (a two-card flop marker goes to the
    builder) and takes at most five summary cards; an action line by an
    unseated name is an `unknown-line` warning (its chips are dropped, so the
    pot usually refuses) - only `Dealt to` an unseated name refuses; a
    `posts big blind … <anything but out of position>` is an `unknown-line`;
    `Table: ''` has no table name. Chico reads every `Total pot` figure
    through `readStake` (so an unused pot figure can refuse
    `fractional-chips` / `unsupported-locale`) and keeps the last printed
    rake; reads the header stakes *last*, after every body check; sorts the
    disagreeing hole-card counts as strings (`10 and 4`); gives every `post
    dead` the first small blind's amount, whoever posted it; a zero `ante
    processed` un-deals a seat that acted before it; a late reveal inside
    the summary counts once per player, an inline one before it every time;
    summary seats are keyed `SameValueZero` (`Seat 007` and `Seat 7` merge)
    and a credit to a seat number nobody sits in refuses even when it is 0.
    The builder writes dead money as `posts missed blind` before the action
    of any kind that carries it (only blinds and posts count it in the pot),
    puts a post after the first non-post preflop line under `*** HOLE CARDS
    ***`, and prints `*** SHOWDOWN ***` (and mucks) only when somebody
    showed.
  - **Not reproducible, reported**: a seat, table size or button between
    2^32 and 2^53 (`Seat 99999999999:`, `99999999999-Max`) is R0.6's
    `parser-error` - the TypeScript's hand is valid JSON; a blind posted by
    an unseated name gets `seat: -1` in TypeScript (R0.7a's straddle rule,
    `parser-error` here) - reachable only through a hand-made draft, since
    both parsers book seated names only.
  - 33 TypeScript test cases translated (`tests/p6_parsers.rs`): all of
    `p6Parsers.test.ts` (both corpora, per-skin counts, the refusals, the
    Omaha file, the detection namespace) with `support/p6Corpus.ts` as the
    loader, plus 9 unit tests in the modules. Skipped: `assertReplays`
    (`buildReplay`, the replayer, not ported - the round-trip half is
    kept); "no other parser claims a Winamax or Chico sample" runs over the
    ported parsers. `p5Parsers`, `phfDetect`, `phfHiLo`, `phfOmaha` and
    `phfPositions` have no Winamax or Chico part; `phfCoreGaps`' Chico note
    is the parser-free `Level -` round trip (R0.6).
  - **For R0.10b** (`acrwpn`, `ignition`): `p5-handdraft.ts` is the third
    sibling of the two ported builders (the room states the settlement and
    the replay is checked against it) - port it the way `p6_handbuilder` is
    ported: `JsNumber` amounts, seats, size and button, `Option<Vec<_>>` for
    a truthy `[]`, `format_header_date` reused, `js::sort::sort_by` for
    every `.sort` (including name lists by length), `SameValueZero` for
    `Map`s keyed by numbers, string order for a bare `.sort()`. Everything
    else they import is ported: `p5_encoding::p5_recover_encoding`,
    `ps_gg_hand::limit_from_label`, `phf::hilo::check_stated_totals`,
    `variant_lock`. `p6-vectors.mjs` shows how to record a shared builder
    directly from random drafts (numbers as `String(n)`), and how a soak
    file can live outside the repository.
- *As built, R0.10b* (§15):
  - **Layout** (`core/rail-core/src/parsers/`): `acrwpn.rs` (`AcrWpnParser`,
    `WpnDialect`, `wpn_dialect`; ACR is a HUD-priority room), `ignition.rs`
    (`IgnitionParser`) and in `shared/` `p5_handdraft.rs` (all of
    `p5-handdraft.ts`). Both parsers registered in `index.ts` order
    (`ignition` after `pokerbros`, `acrwpn` last); `acrwpn` declares
    `short_deck()`, `ignition` `hi_lo_variants()` = `OMAHA_HI_LO`.
  - **The `p5_handdraft` API**: `P5Street` (+ `P5_STREETS`), `P5Seat`,
    `P5Kind` (with `allin` and `uncalled`), `P5Action`
    (`P5Action::new(street, player, kind)`, the optional fields
    `None`/`false`), `P5Collect`, `P5Tournament`, `P5Draft` (field for
    field, snake case; the TypeScript `Map`s `statedContributions` and
    `holeCards` are `Vec`s of pairs in insertion order), `p5_header_date`
    (= `format_header_date`), `p5_draft_to_standard_text(&P5Draft) ->
    Result<String, ParseSkip>` and `p5_build_hand(&P5Draft,
    &SiteParserContext, hand_key) -> Result<PhfHand, ParseError>`. Amounts,
    seats, the table size and the button are `JsNumber`, as in the two
    sibling builders; `flop: Some(vec![])` is the truthy `[]`.
  - **One shared change**: `phf::hilo::StatedTotals` holds `JsNumber`s
    instead of `Amount`s. Ignition, its only caller, reads the summary's `HI`
    / `LOW` with `parseAmount` - a double, compared (`room.lo > 0`, `!==`)
    and printed (`1e+22`) as such. The hilo unit test was adapted; every
    earlier vector and soak still passes. No other merged code changed;
    reused: `p2_partygaming::{split_lines, iso_from_888_date}` (`Date.UTC`
    then `toISOString`; `Invalid time value` is unreachable for these digit
    counts and would be a `parser-error`), `p2_handbuilder::format_header_date`,
    `p5_encoding::p5_recover_encoding`, `ps_gg_hand::{limit_from_label,
    split_before_line_starts}`, `serialize::matches_at_line_start`,
    `variant_lock`, `phf::hilo::check_stated_totals`.
  - **Patterns** are the TypeScript source (tests check every literal and
    every refusal message). Written as code and tested against Node: both
    lookahead splits (at every JavaScript line start), Ignition's
    `BRANDS`-built header patterns, the `m`-flag probes (WPN's `Game ID:`,
    running pot, `RUN IT TWICE`, numeric-seat and `Game started at:`
    probes; Ignition's brand header and `^.* : Card dealt to a spot \[`),
    and WPN's modern detection probe, whose `m`-flag `\s*$` is written
    `\s*(?:$|[\n\r\u2028\u2029])` - the regex crate's `$` breaks only at
    `\n`. Every `.sort` (names and pseudonyms by length, seats by number)
    goes through `js::sort::sort_by`.
  - **Golden agreement** (`tests/golden_sites.rs`): `acrwpn` **76 / 76**
    files, **144** hands, **25** refusals (`unsupported-hi-lo` 14,
    `unsupported-variant` 5, `unnamed-actor` 3, `cancelled-hand` 2,
    `payout-mismatch` 1) - all three dialects, the 14 UTF-16LE files, four-card
    Omaha, the one Six Plus hand; warnings `no-hero` 44 (the validator's),
    `unknown-summary-line` 11, `button-not-seated`, `numeric-player-ids`.
    `ignition` **56 / 56** files, **96** hands, **12** refusals
    (`unsupported-variant` 8, `corrupt-hand` 2, `unsupported-hi-lo` 2) -
    hold'em, Omaha, Omaha Hi/Lo with its halves; warnings `missing-button`
    7, `streets-inferred` 7, `derived-pot` 5, `dead-small-blind` 4,
    `stale-level-blinds` 4, `mvs-player-hashes` 3, `no-winner` 1,
    `lone-ante-posted-live` 1, `dead-button` 1. Each fully: ranking, chunks,
    PHF, standard text per hand and per file, warnings, refusal stage,
    reason, message and fingerprint, stats. Whole-file detection of the
    fourteen ported parsers equals the goldens on **all 556** files.
  - **Beyond the corpus** (`tests/data/p5-vectors.{mjs,json}`, 4.2 MB, run
    by `tests/p5_vectors.rs`; the generator bundles the TypeScript): both
    parsers' splits of every corpus file and of 15 edge texts, 37 detection
    probes, **3 935** seeded mutations of every corpus chunk of both rooms
    (catalogues of each grammar's lines - legacy, modern, Ignition -, other
    headers, `Game ID:` and table lines - variants, hi/lo, Six Plus, stud,
    tournaments, rolled-over dates, every brand, Zone Poker, `[MVS]` -,
    changed amounts - grouped, comma decimals, thousandths, `1.2.3`, twenty
    digits -, renamed seats, cut hands, `\r` / `\r\n` / U+2028 line ends, a
    BOM, and 146 whose whole text is UTF-16LE read back as UTF-8), each
    through **both** parsers - `wpn_dialect`, detection and outcome, and the
    outcome with `cashOnly` (recorded where it differs: 1 453) - (1 070 WPN
    and 929 Ignition hands, every refusal reason of both reached), **700**
    seeded `P5Draft`s through `p5_draft_to_standard_text` and
    `p5_build_hand` (mostly balanced from probes of the builder's own
    replay - its `chip-mismatch` and `contribution-mismatch` messages carry
    the figures -, one in five knocked out of true; 422 hands), and the 132
    corpus files re-encoded six ways (UTF-16 LE with and without BOM, UTF-16
    BE, Windows-1252, CRLF, UTF-8 with BOM) through `rail_core::convert`
    (792 files, 1 440 hands): all equal. Two soak runs (`P5_STRESS=11`,
    `=29`, 36 767 cases and 7 000 drafts each; `P5_OUT` / `P5_VECTORS` as in
    R0.10a) were equal too.
  - **TS oddities kept**: the builder banks an ante's `dead` nowhere, banks
    a small blind's without a missed-blind line, puts a post's or a
    straddle's missed blind above the deal whatever its street, replays a
    stated return with its raw `amount` (not `toTotal`), always prints `***
    SHOWDOWN ***`, labels `(small blind)` / `(big blind)` by the first
    poster's name, clamps the rake to the shortfall (`Math.min`) and prints
    `Math.max(0, rake)`, and fills summary hole cards only into players the
    text left without; `lastStreet` is computed and never read (not
    ported). WPN: the numeric-seat probe of `wpnDialect` reads the chunk as
    given, not recovered; `firstMatchingLine`'s `m`-flag `^Game started at:`
    matches after a bare `\r` or U+2028 inside a `\r?\n` line, and the
    trimmed line must then be an anchored legacy header; the legacy header
    is read twice (cents first) and its variant is `variantFromLabel` (not
    `variantOf`), Omaha pot-limit and everything else no-limit; a summary
    `Board:` fills the board only without a flop marker, and a flop of other
    than three cards is dropped while its turn and river stay; a summary line
    for an unseated name is skipped while its `Bets:` and `Collects:` are
    zero; an all-zero `Bets:` column (the mined export) is no column;
    `and is all-in` needs whitespace before it; the modern seat order is
    re-sorted per line (a seat line after an action changes the names); a
    `Dealt to` an unknown name is ignored. Ignition: `seatByName` and
    `nameOf` are plain `Map.set` - a repeated pseudonym, or a seat called
    `Hero` next to the `[ME]` seat, overwrites; a summary pseudonym is a
    bare `startsWith` (an empty one matches everything and counts as none);
    `Set dealer [n]` is used only without a `Dealer` seat; a lone `Ante
    chip` is a live post; `Posts chip` caps the live share at the big blind
    known at that line; an all-in before `*** HOLE CARDS ***` is a blind by
    pseudonym, else a post; `Showdown ()` has no description; `Does not
    show` mucks no cards; street closure counts reveals as money actions
    (they add a commitment entry) and blinds as no turn; `smallBlind ||
    level` falls back on 0; the `HI` / `LOW` check and the `[MVS]` hashes
    are added after the build, on the hand.
  - **Not reproducible, reported**: a seat, table size or button between
    2^32 and 2^53 (`Seat 99999999999:`) is R0.6's `parser-error`, and a
    draft action by an unseated name gets `seat: -1` in TypeScript - neither
    parser produces one (both book seated names only), only hand-made
    drafts. Amounts beyond 2^53 are unrepresentable in both (the vector test
    compares the JSON path). Nothing else: no lone surrogate can arise (the
    UTF-16 repair works on decoded text, and Node and Rust replace invalid
    UTF-8 alike, one U+FFFD per maximal subpart).
  - 30 TypeScript test cases translated (`tests/p5_parsers.rs`): all of
    `p5Parsers.test.ts` (both corpora, per dialect, the invariants, the
    detection boundaries) with `support/psggCorpus.ts` and
    `psggInvariants.ts` as the loaders, the four Ignition files of
    `phfHiLo`'s "every converted hi/lo fixture" and the ACR parts of
    `shortDeck` (the three files, the clean short-deck hand, its standard
    text round trip, Six Plus as Stars' `6+ Hold'em`), plus 11 unit tests in
    the modules. Skipped: `analyzeAllIn` (R2.2), `shortDeck`'s equity, stats
    and replayer checks (R2.1, R2.2, `buildReplay`), `shortDeckRuleFor`
    (parser-free, R0.5b). `phfOmaha`'s ACR and Ignition labels are
    parser-free (R0.5a); `phfDetect`, `phfPositions` and `phfCoreGaps` have
    no part about these rooms.
  - **For R0.10c** (`fulltilt`, `runitonce`): everything they import is
    ported - `p3-draft` / `p3-stars-dialect` (`parse_stars_family_body`,
    held by vectors since R0.7a), `variant_lock`, `phf::hilo`. The file
    tool turns `\uXXXX` escapes into literal characters in Rust raw strings
    *and* in the `.mjs` generators' JavaScript strings: grep new files for
    non-ASCII (`[^\x00-\x7f]`) and write `\u{...}` (Rust strings) or
    `\uXXXX` (JS, `js_regex` patterns) back. An `m`-flag pattern ending in
    `$` that runs at line starts needs `(?:$|[\n\r\u2028\u2029])` for its
    `$`. `p5-vectors.mjs` adds two generator tricks: an op that misreads the
    whole text from UTF-16LE, and a second option set recorded only where
    its outcome differs.
- *As built, R0.10c* (§15):
  - **Layout** (`core/rail-core/src/parsers/`): `fulltilt.rs`
    (`FullTiltParser`, `FULLTILT_PARSER_VERSION`, `OFF_BOARD`,
    `MAX_RUNOUT_INDEX`) and `runitonce.rs` (`RunItOnceParser`), each with
    its `tests` submodule. Both registered in `index.ts` order (`fulltilt`,
    `runitonce` after `microgaming`); `fulltilt` declares `hi_lo_variants()`
    = `OMAHA_HI_LO`, `runitonce` none (every hi/lo label refused, as
    `unsupportedGameSkip` without a list). Full Tilt reads its own line
    grammar into `StarsHandDraft`; Run It Once reads its body with
    `parse_stars_family_body` (R0.7a), so this is the first step that runs
    the clone dialect through a site parser it was written for.
  - **One shared change, additive**: `StarsHandDraft::showdown_marker_at
    (stand_in, label)` - the TypeScript's `marker("showdown", -1, ...)`
    (Full Tilt's `*** SHOW DOWN 0 ***` is `Number("0") - 1`): no runout is
    added, the actions that follow carry a stand-in index. Nothing else in
    merged code changed; every earlier vector file still passes (the full
    `cargo test --workspace`).
  - **Numbers no PHF holds, reported where the TypeScript returns.** Full
    Tilt keeps seats, the table size, the button and runout indices as
    JavaScript numbers. Where its hand would hold one beyond `u32` (`Seat
    99999999999:`, `(99999999999 max)`, `The button is in seat
    #99999999999`, `wins pot 99999999999`) or the `-1` of `SHOW DOWN 0`,
    the Rust parser carries a stand-in to the very end - seats through
    `SeatNumbers` (one stand-in per distinct double, counting down from
    `u32::MAX` past every seat number the hand prints, so the summary and
    the seat block find each other as the TypeScript's `Map` does), runout
    `-1` as `OFF_BOARD` - and returns R0.6's `parser-error` only after the
    `unseated-actor` check, so every refusal the TypeScript reaches first
    is reached here too, and a huge seat line dropped as a duplicate name
    still gives the hand. Run It Once does the same for the table size and
    button the dialect holds back (`set_table_numbers`): it takes them back
    with `set_table` and reports them after its own `unseated-actor` check.
  - **Golden agreement** (`tests/golden_sites.rs`): `fulltilt` **13 / 13**
    files, **21** hands, **1** refusal (`no-seat-block`, the summary-only
    fragment) - both header generations, the `of`-phrased uncalled return,
    `and is capped`, run-it-twice with numbered markers and per-runout
    SUMMARY blocks (`run-it-twice-summary`), fixed-limit blinds from the
    posts, chat, the ten-hand file, `PL Omaha Hi` and both `Omaha H/L`
    tables with their halves; warnings `no-hero` 19 (the validator's) and
    `run-it-twice-summary` 1. The headerless fragment (`09-`) stays
    `unknown-site`. `runitonce` **4 / 4** files, **2** hands, **2**
    refusals (`unsupported-variant` - the Omaha splash-the-pot file -, and
    `no-hands` - the tournament summary file, claimed at 0.95 and split to
    nothing); warning `uncalled-includes-promo` 1. Each fully: ranking,
    chunks, PHF, standard text per hand and per file, warnings, refusal
    stage, reason, message and fingerprint, stats. Whole-file detection of
    the sixteen ported parsers equals the goldens on **all 556** files.
  - **Beyond the corpus** (`tests/data/p3-vectors.{mjs,json}`, 2.1 MB, run
    by `tests/p3_vectors.rs`; the generator bundles the TypeScript): both
    parsers' splits of every corpus file and of 16 edge texts, 25 detection
    probes, **4 251** seeded mutations of every corpus chunk of both rooms
    (catalogues of each grammar's lines - numbered and `0` markers,
    `SUMMARY n`, `wins pot n`, `the high pot`, `and is capped`, chat, dead
    blinds, `adds`, Splash The Pot, `[hero]`, `Table ID` -, other headers -
    both Full Tilt word orders, variants, hi/lo, stud, short deck, Sit & Go
    and tournaments, every currency glyph, `(n max)`, rolled-over dates,
    RIO's tournament header -, changed amounts, renamed seats, cut hands,
    `\r` / `\r\n` / U+2028 line ends, a BOM, 168 whose whole text is
    UTF-16LE read back as UTF-8), each through **both** parsers - detection
    and outcome, and the outcome with `cashOnly` where it differs (539) -
    (1 895 Full Tilt and 981 Run It Once hands, every refusal reason of
    both reached), and the 17 corpus files re-encoded six ways (UTF-16 LE
    with and without BOM, UTF-16 BE, Windows-1252, CRLF, UTF-8 with BOM)
    through `rail_core::convert` (102 files, 138 hands): all equal. One
    generator guard: `StarsHandDraft.prototype.marker` is wrapped to throw
    `RUNOUT_CAP` past index 9 999 (a `*** RIVER 99999999999 ***` would
    exhaust Node's heap); the Rust parser refuses at the same line. Two
    soak runs (`P3_STRESS=11`, `=29`, 42 231 cases each; `P3_OUT` /
    `P3_VECTORS` as in R0.10a) were equal too.
  - **TS oddities kept** - Full Tilt: `*** FLOP|TURN|RIVER 0 ***` throws
    (`Cannot set properties of undefined (setting 'flop')`, a
    `parser-error`) while `*** SHOW DOWN 0 ***` / `00` tags what follows
    runout -1; `*** RIVER 5 ***` adds empty runouts up to index 4, and only
    1-4 get a standard-text word (`FIRST`...`FOURTH`); `*** SUMMARY 0 ***`
    is block 0 like the unnumbered one, `SUMMARY n` boards go to runout
    `max(n - 1, 0)`, and once any SUMMARY marker is seen every later line
    is a summary line (a seat line there is a summary seat); a block-1
    seat line of a collector is skipped, any seat line in a block above 1
    warns `run-it-twice-summary`; `wins pot n` is re-tagged to runout
    `max(n - 1, 0)` after `build` (`pot 0` too), the winners are rebuilt
    without `half` and the hi/lo halves derived again (build's
    `hi-lo-split-unresolved` dropped, the rest kept, then the new
    unresolved, then `hi-lo-half-mismatch`); wins, folds, checks, wagers,
    raises, mucks, shows and dead `posts $x` are read only for a seated
    name (an unseated one is an `unknown-line`, not a refusal), while
    blinds, antes, `posts a dead … blind` (always a missed blind, verb
    `posts dead blind`) and uncalled returns are booked for any name (and
    refuse `unseated-actor`); `X shows` with neither cards nor a
    description is no show; `Uncalled bet ($5)` (the PokerStars form) is an
    `unknown-line`; `X: …` is chat only for a seated `X`; `Hand #N has been
    canceled` refuses whatever `N`, before the header is read; a header
    that fails to parse is `tournament-unsupported` only if it says
    `Tournament`, `Sit & Go` or `Match #`; `()`, `(deep)` and no
    description are nine seats, `(0 max)` lets `build` take the size from
    the seats; a fixed-limit header's stakes are dropped (blinds from the
    posts); a stake with no `$`/`€`/`£` (`₹` included) is chips and refused
    `unsupported-currency`; `24:00:00` is the next day (V8). Run It Once: a
    tournament header whose stakes have no PHF unit falls back to the cash
    pattern on the same payload; the `button-seat-empty` check compares
    the JavaScript number; `padHour` is always on; the rest is R0.7a's
    dialect (hoisted uncalled return, splash cap, `[hero]`).
  - **Not reproducible, reported**: a Full Tilt marker numbered past 10 000
    is refused with a `parser-error` naming the cap - the TypeScript
    allocates a runout per index (and dies of heap long before `u32`); the
    vectors check the Rust refusal against the guard. A seat line beyond
    `u32` in Run It Once stops the shared clone dialect at that line
    (R0.7a's behaviour, PokerBros' too): where the TypeScript goes on to
    `unseated-actor` or drops the line as a duplicate name, Rust says
    `parser-error` (2 cases in a 42 231-case soak, counted by the vector
    test). Making the dialect defer seats the way Full Tilt does needs
    `DialectResult` to carry stand-ins and PokerBros to report them at its
    end - left for a step that touches PokerBros.
  - 42 TypeScript test cases translated (`tests/p3_parsers.rs`): the Full
    Tilt and Run It Once parts of `p3Parsers.test.ts` (both corpora - the
    six `it.each` per room as loops -, all 14 Full Tilt and 10 Run It Once
    tests, the four shared-namespace tests) and the Full Tilt part of
    `phfHiLo` (the room's own split, its three converted hi/lo fixtures),
    plus 13 unit tests in the modules (source checks of every pattern and
    message, the header generations, the `0` markers, numbers beyond `u32`,
    the runout cap, line-start detection - recorded from Node). Skipped:
    the replayer half of "pays the whole pot out and never goes below zero"
    (`buildReplay`), `phfHiLo`'s `analyzeAllIn` (R2.2); the PokerBros parts
    are R0.8's. `phfDetect`, `phfOmaha` and `phfPositions` have no Full
    Tilt or Run It Once part.
  - **For R0.10d** (`ongame`, `entraction`, `unibet`): everything they
    import is ported - `p2_handbuilder` (`JsNumber` drafts,
    `draft_to_standard_text`, `format_header_date`, `build_hand`),
    `p2_partygaming::{iso_from_party_date, known_zone}` (Ongame),
    `p4_textroom`, `variant_lock`, and `parse_standard_hand` (Unibet). The
    24 Entraction and Ongame samples start with a UTF-8 BOM, which
    `decode_source` strips and a raw `readFileSync` keeps (golden README):
    translate the TS tests with the loader they use. If a parser keeps a
    seat or size as a JavaScript number past a refusal it can still reach,
    carry a stand-in and report the `u32` error where the TypeScript
    returns (Full Tilt's `SeatNumbers`); a number that sizes an allocation
    in the TypeScript needs a cap and a generator guard (the `RUNOUT_CAP`
    wrapper). The file tool still turns `\u` escapes into literal
    characters in `.mjs` and Markdown (not in Rust `"\u{...}"` strings):
    escape non-ASCII afterwards.

- *As built, R0.10d* (§15) - **R0.10 complete: all 19 parsers are in Rust**:
  - **Layout** (`core/rail-core/src/parsers/`): `ongame.rs`
    (`OngameParser`), `entraction.rs` (`EntractionParser`), `unibet.rs`
    (`UnibetParser`), each with its source and unit tests. Registered in
    `index.ts` order (`unibet`, `ongame`, `entraction` after `coinpoker`);
    `entraction` declares `hi_lo_variants()` = `OMAHA_HI_LO`, the other two
    none (every hi/lo label refused). `parsers::ported()` now holds all 19,
    and a new test asserts that `builtin()` is exactly `REGISTRATION_ORDER`
    (which the existing test reads from `index.ts`).
  - **All three build on `p2_handbuilder`**: Ongame and Entraction through
    `build_hand`, Unibet through `draft_to_standard_text` with its own
    tournament first line, then `parse_standard_hand`. Draft amounts, seats,
    sizes and buttons are `JsNumber`; the cross-checks (`pot-mismatch`,
    `rake-mismatch`, `net-result-mismatch`, `payback-mismatch`,
    `uncalled-mismatch`, `negative-rake`) compare and print JavaScript
    numbers. A seat or size beyond `u32` reaches the standard-text reader,
    which gives R0.6's `parser-error` where the TypeScript returns its hand;
    no refusal can come after it, so no stand-ins were needed (unlike Full
    Tilt's `SeatNumbers`). Nothing these parsers read sizes an allocation,
    so the generator needs no guard.
  - **Shared code changed, additively** (all earlier vectors and soaks still
    equal): `phf::money::{format_amount_digits_js, parse_buy_in_token_js}`
    (Unibet prints its header blinds and the tournament buy-in again, from
    doubles). `p4_textroom` was not touched: `leading_name`,
    `names_by_length`, `expand_month`, `refuse_lossy_text` and
    `currency_symbol_of` are now held by recorded vectors too (78 probes).
    Not shared code but worth knowing: the workspace `dev` profile now
    optimises `regex`, `regex-automata`, `regex-syntax`, `aho-corasick`,
    `memchr` and `sha2` (opt-level 3; our crates stay unoptimised with
    overflow checks) - `golden_sites` at two threads went from 46 s to 31 s
    with the whole-corpus test included (23 s without it), so CI gets the
    exit check below for less than it paid before.
  - **Patterns** are the TypeScript source (tests check every literal and
    every message). Written as code and tested against Node: the `m`-flag
    detection probes and the three lookahead splits at every JavaScript line
    start (Ongame's `m`-flag `\s*$` as `\s*(?:$|[\n\r` plus U+2028 and
    U+2029 `])`), Unibet's `HERO_SEAT` (first match at a line start),
    Entraction's `isoFromEntractionDate` (`Date.UTC` then the stated
    offset), Unibet's `isoAt` (`new Date(...).toISOString()`:
    `parse_instant`, the `RangeError` as `Invalid time value`), and
    `String.prototype.replace`'s `GetSubstitution` for Unibet's tournament
    line (`$$`, `$&`, `` $` ``, `$'`, `$n` / `$nn`, `$<`).
  - **Golden agreement** (`tests/golden_sites.rs`): `ongame` **13 / 13**
    files, **21** hands, **1** refusal (`unsupported-hi-lo`, the
    `OMAHA_HI_LO` table); `entraction` **13 / 13**, **21** hands, **1**
    refusal (the validator's `hi-lo-payout-contradiction` on
    `07-allin-showdown.txt`, which shares its hand number with
    `08-euro-table.txt` - three of the four Hi/Lo files convert, halves
    from the cards); `unibet` **5 / 5**, **4** hands, **2** refusals
    (`no-winner`, `tournament-summary`; the Windows-1252 file converts as
    the app decodes it). Each fully: ranking, chunks, PHF, standard text per
    hand and per file, warnings (the validator's `no-hero` 42), refusal
    stage, reason, message and fingerprint, stats.
  - **The Phase 0 exit check, minus WASM**:
    `every_corpus_file_matches_its_golden` runs the whole Rust pipeline
    (`Selection::All`, the complete registry) over the corpus and matches
    every golden fully: **556 / 556** files, **8 422 / 8 422** hands,
    **196 / 196** refusals, no pending text hash, no unported candidate.
    About 23 s of a debug run on one thread.
  - **Beyond the corpus** (`tests/data/p4-vectors.{mjs,json}`, 3.4 MB, run
    by `tests/p4_vectors.rs`; the generator bundles the TypeScript):
    78 text-room probes; the three parsers' splits of every corpus file and
    of 19 edge texts (Unibet's split throwing on a date V8 rejects), 35
    detection probes, **6 026** cases - seeded edits of every corpus chunk of
    the three rooms (catalogues of each grammar's lines, Ongame `Table:`
    lines, Entraction and Unibet headers - variants, limits, hi/lo, stud,
    short deck, currencies and codes, chips, comma decimals, play money,
    tournaments with `$` patterns in id and buy-in, `Total prize`, dates
    V8 rolls over or rejects -, changed amounts, renamed seats, a glyph
    turned into U+FFFD, cut hands, `\r` / `\r\n` / U+2028 line ends, a BOM,
    UTF-16LE read as UTF-8) plus every catalogued header against every
    chunk, each through **all three** parsers - detection and outcome, and
    the outcome with `cashOnly` where it differs (265) - (1 276 Ongame,
    1 310 Entraction and 714 Unibet hands; every refusal reason of the
    three reached but `normalized-unparseable`), and the 31 corpus files
    re-encoded six ways (UTF-16 LE with and without BOM, UTF-16 BE,
    Windows-1252, CRLF, UTF-8 with BOM) through `rail_core::convert` (186
    files, 276 hands): all equal. Two soak runs (`P4_STRESS=11`, `=29`,
    47 786 cases each; `P4_OUT` / `P4_VECTORS` as in R0.10a) were equal too.
  - **TS oddities kept** - Ongame: the seat pass reads a seat line anywhere
    before `Summary:` and the action pass skips every seat-shaped line; the
    refusals read the normalised game name (`OMAHA_HI_LO` as `OMAHA HI
    LO`) while the label is `variantOf` of the raw token; summary reveals
    are tagged with the last street a marker dealt, and `net:` or shown
    cards count only for a seated name (otherwise `unknown-line`); `Players
    in round` becomes the table size when it is above the fallback
    (`Math.max`); an unknown month leaves `playedAt` null without a warning,
    an unknown zone warns and reads UTC; the stakes are read after
    `no-winner` and `board-size`; `statedPot` sums every pot line and is
    checked only when above 0; `doesn't show [..]` is a muck with cards,
    `shows` without cards a show with none. Entraction: `HEADER` over the
    whole text claims only a text that is one header line, files are
    claimed by the `m` probe; the last `Players(max N)` anywhere wins; a
    cumulative board takes the fourth card for the turn and the fifth for
    the river, so a short line leaves them null; a blind line by an
    unseated name falls through every other shape to `unknown-line`; a
    `Dealer` naming nobody warns and a later one resets the button; the
    last `Payback` is checked against the first derived return; `Game
    ended` rolls fields over and reads years 0-99 as 19xx; the label's
    hi/lo flag comes from the raw word. Unibet: `readHeader` throws
    `Invalid time value` for a date V8 rejects - in `splitHands` too, so one
    such header makes the whole file `split-failed`, in `parseHand` a
    `parser-error`; `24:00:00` is the next day and `02/30` rolls into
    March; the tournament line goes through `replace` with a template, so a
    `$1` buy-in (`formatAmount` drops `.00`) or `$&`, `` $` ``, `$'`, `$$`,
    `$nn` in a tournament id expand as JavaScript expands them; `sittingOut`
    is computed and never read; tournament stacks with a symbol warn
    `unexpected-currency` and stay chips, and a chips header tolerates
    `25.00`; `posts small & big blinds` is live `min(bigBlind || amount,
    amount)` with the largest big blind posted on an earlier line; a `Dealt
    to` a non-hero who neither showed nor mucked is a muck reveal at the end
    of the stream on the last street, and without a session token the one
    known hand's owner becomes the hero and loses the *first* muck by that
    name (possibly their own `mucks` line); only collectors and players with
    a `Dealt` line are dealt in; `collectedIncludesUncalled` is the absence
    of an `Uncalled bet returned` line; summary figures are strict (an
    `ambiguous-amount` can come from `Total pot`), the prize pool lenient
    (`parseAmount`); the fallback sizes include 3 and 4.
  - **Not reproducible, reported**: a seat, table size or button between
    2^32 and 2^53 (`Seat 99999999999:`, `Players in round: 99999999999`,
    `99999999999-max`) - the TypeScript's hand is valid JSON, Rust's reader
    gives R0.6's `parser-error` (42 of the 6 026 committed cases, 472 and
    457 in the soaks, counted by the vector test). Amounts beyond 2^53 are
    unrepresentable in both (the test compares the JSON path). No lone
    surrogate can arise.
  - 43 TypeScript test cases translated (`tests/p4_parsers.rs`): the Ongame
    and Entraction parts of `legacyNetworks.test.ts` (both corpora - five
    `it.each` per room as loops -, the five specifics each, and the shared
    namespace with all three rooms ported: no claim on another room's
    sample, attribution by the text, Entraction and Unibet kept apart),
    all of `unibetParser.test.ts` but its iPoker side (R0.9) - corpus,
    both header generations, Omaha and the summary export, `cashOnly`, the
    two encodings, the iPoker samples scoring 0, the shared namespace -
    with `support/p4Corpus.ts` as the loader (a `TextDecoder`: the BOM is
    dropped, the Windows-1252 file reads with U+FFFD and is refused
    `lossy-encoding` there), and the Entraction parts of `phfHiLo` (the
    contradicted payout, the three converted files), plus 10 unit tests (9
    in the parser modules, 1 for the registry). Skipped: "replays without a
    negative stack" of the three rooms (`buildReplay`) and `phfHiLo`'s
    `analyzeAllIn` (R2.2). `p2Parsers`, `p2Xml`, `phfDetect`, `phfOmaha`, `phfPositions` and
    `phfCoreGaps` have no part about these rooms beyond labels (R0.5a) and
    a Unibet-style header read by the standard reader (R0.6).
  - **What remains for the Phase 0 exit**: **R0.11** the unsupported-format
    registry (`Unrecognized { fingerprint, header_sample, guessed_site,
    confidence }`; the 24 files of `Selection::Unrecognised` are its corpus
    and `detect::fingerprint` is ported), **R0.12** `config/sites.json` v1
    (one entry per id of `REGISTRATION_ORDER`, and the CI rule both ways),
    **R0.13** the WASM build and shadow mode (the golden diff under WASM:
    `every_corpus_file_matches_its_golden` is the native half; the vector
    files are a ready second corpus for the shadow harness), **R0.14** the
    rename and repository layout.

### R0.11 Unsupported-format registry — M
- Core returns `Unrecognized { fingerprint, header_sample, guessed_site, confidence }`
  for files no parser claims.
- Desktop: kept locally (`unsupported` table, §3.4); with the user's consent an
  anonymised sample (player names replaced, amounts kept) is sent to
  `unparsed_hands` with `origin = 'desktop'`, `os`, `client_version`.
- Migration extending `unparsed_hands`; pgTAP tests for the new columns and the
  consent rule. Anonymiser has its own tests: no input name may survive.
- `docs/unsupported-formats.md` for formats known without a sample; GitHub label
  `new-format`; a weekly triage query over `unparsed_gaps`.
- **Done when** an unknown file dropped into a watched folder (or on the web)
  appears in the registry with its fields, once, with its count going up on
  repeats.
- *As built, R0.11* (§15) - the Phase 0 part: core, anonymiser, database,
  docs. The desktop-local `unsupported` table and the consent UI wait for
  R1.2 / R1.3 (there is no local store or watcher yet), so the "watched
  folder" half of *done when* is theirs; the web half holds today (the web
  already records `unknown-site` through `record_conversion_failures`, one
  row per fingerprint, `occurrences` going up).
  - **Core** (`core/rail-core/src/unrecognized.rs`): `Unrecognized {
    fingerprint, header_sample, guessed_site, confidence, guess_basis, shape
    }`, returned as `FileConversion::unrecognized` - a new field, set exactly
    when detection on the whole file is empty (no forced site), i.e. when the
    result is the one file-level `unknown-site` refusal. The golden document
    is built from the other fields, so every golden is byte-identical; the
    TypeScript has no equivalent record. `fingerprint` is the refusal's
    (asserted equal to the golden's for all 24 files). `header_sample`: the
    first 12 non-blank lines of the **anonymised** text, trailing whitespace
    off, 160 characters each, joined with `\n` - deterministic because the
    decoder has already removed the BOM and CRLF (a CRLF copy of a file gives
    an equal record, tested). `guessed_site` / `confidence` (per-mille): the
    best detector score in 1..199 (`below-threshold`; no detector produces
    one today - every score is a literal of 250 or more), else a known
    format's signature, at least half of its literal markers present
    (`known-format`; `KNOWN_FORMATS` holds the two formats with samples and
    no parser, `bossmedia` and `merge`, each guessed at 1000 on all its
    files; the Winamax and Full Tilt fragments get no guess). `shape`:
    `xml` / `json` / `text` from the first character. `rail-convert` prints
    an `unrecognized:` line for such a file.
  - **Anonymiser** (`core/rail-core/src/anonymise.rs`, `ANONYMISER_VERSION
    = "rail-anon/1"`): `anonymise(text)`, `shareable_sample(text)` (cut to
    64 KiB at a line end after collecting names from the whole text),
    `Anonymised::apply` (the same mapping over a file name);
    `rail-convert --anonymise <file>`. Names are collected wide - keyed
    values whose key names a person (XML attributes and elements, JSON
    members and string arrays, `key = value`), seat lines, colon and bare
    action lines, column layouts, `Dealt to`, `returned to`, `said`,
    `Dealer:` lines - and every occurrence of every one is replaced,
    token-bounded where the name's edge is a word character, longest first,
    by `Player<n>` in order of first appearance; the prefix falls back to
    `Anon` / `Villain` / `Nick` / `AnonX...` so that it never occurs in the
    input. One- or two-digit values under `player=` / `dealer=` stay (seat
    references). `Debug` never prints the mapping. **Guarantee, tested**
    (`tests/anonymise.rs`): over all 556 corpus files, every player name the
    pipeline reads from the file, and for the 24 unrecognised files every
    name a format-specific reading finds (`NAME=`, `PLAYER=`, `nickname=`,
    seat and post lines) - **3 454 (file, name) pairs, 1 471 distinct
    names** - is absent as a token from the anonymised text, the sample and
    the header sample, and no name of three or more characters is even a
    substring of the output. (49 pipeline names are not in their input as
    read - Ignition's `[ME]` seat becomes `Hero` - and are not counted.)
    Limits, documented in `docs/unsupported-formats.md`: a name only in free
    text no rule reads, an encoded name outside a name-like key, a
    placeholder-like name (`N/A`) under a name key.
  - **Database** (`supabase/migrations/20270414090000_unparsed_registry.sql`,
    not applied to production by this step): `unparsed_hands` gains `origin`
    (enum `unparsed_origin`, `web` by default - every existing row),
    `os`, `client_version`, `consented_at`, `anonymiser_version`,
    `guessed_site`, `guess_confidence`. The same RPC,
    `record_conversion_failures`, takes the new keys; a desktop record
    without a valid consent time (ISO 8601 with a zone, not in the future,
    parsed by the non-raising `unparsed_consent_instant`, which no client may
    execute), anonymiser version, OS and client version, or over 64 KiB, is
    skipped, and `CHECK` constraints refuse such a row from any writer.
    A repeat counts, refreshes the client and the guess, and never rewrites
    `origin`, `consented_at` or `anonymiser_version` (they describe
    `raw_text`). `unparsed_gaps` gains `desktop_hands` and `guessed_sites`.
    Grants, RLS, first-submitter reads, rate limit unchanged. pgTAP
    `unparsed_registry.test.sql` (41 tests); types regenerated.
  - **Docs**: `docs/unsupported-formats.md` (the record, the anonymiser and
    its limits, the weekly triage queries over `unparsed_gaps` /
    `unparsed_hands`, the formats with a sample and no parser, the formats
    known without a sample, seeded from `COVERAGE-PLAN.md` and
    `hh-formats/*`); `docs/DATABASE.md`; GitHub label `new-format`.
  - **For R1.2**: the local `unsupported` table (§3.4) keyed by
    `fingerprint`, holding the `Unrecognized` fields (`header_sample`,
    `guessed_site`, `confidence`, `guess_basis`, `shape`), the file's path
    and encoding, `count`, `first_seen`, `last_seen`, and the consent state
    (`consented_at`, `sent_at`, the `ANONYMISER_VERSION` used); a repeat
    bumps `count`. The upload (R1.x, with sign-in) sends
    `shareable_sample(text).text` as `rawText`, `apply(filename)` as
    `sourceFilename`, `origin: "desktop"`, `os`, `clientVersion`,
    `consentedAt`, `anonymiserVersion`, `guessedSite`, `guessConfidence`
    (per-mille / 1000) through `record_conversion_failures`, never the raw
    text, and only after the user's consent (a setting, asked once).

### R0.12 `config/sites.json` v1 — M
- JSON Schema, loader and validator in `rail-config`; every current parser has
  an entry; `hud.allowed` is `null` (unknown) for every room until R3.0.
- CI rule: a parser without a `sites.json` entry fails the build, and vice
  versa.
- *As built, R0.12* (§15):
  - **Granularity: one entry per client** - a room or a skin, the thing a
    player installs and the unit the watcher (folders), the HUD (processes,
    window titles, seat layouts) and HUD policy all act on - with a `parser`
    field, so several entries may share a parser. Where our sources name a
    network but not which clients write which files, a `kind: "network"`
    entry stands in until R1.4 / R3.0 split it into rooms; the validator
    and the schema forbid a network (or a `format`) any table data and
    `hud.allowed: true`, so a HUD can never attach on a network's say-so.
    `kind: "format"` is Rail's own `standard` text, which a parser reads but
    no client writes.
  - **22 entries.** 19 cover the 19 parsers, one each (`acrwpn` is the
    `acr` entry). 13 rooms: `pokerstars`, `ggpoker`, `winamax`, `888poker`,
    `partypoker`, `acr`, `coinpoker`, `unibet`, `weplay`, `pokerbros`,
    `fulltilt`, `runitonce`, and `wpt-global` without a parser (no export
    since June 2026). 8 networks: `ipoker`, `chico`, `ignition`,
    `microgaming`, `ongame`, `entraction`, and `bossmedia` and `merge`
    without a parser (the R0.11 registry's `KNOWN_FORMATS` ids: samples,
    no parser). 1 format: `standard`. WPN's other skins (Black Chip, True
    Poker, Ya Poker) and GG's (Natural8, BestPoker, ClubGG) are named in
    notes, not entries, until a client or a file confirms them.
  - **Unknown is `null`, never a guess.** Every `hud.allowed` is `null`
    (a test holds it until R3.0). Only PokerStars has paths - one per OS,
    `verified: false`, the research doc's *inferred* tracker-support folders;
    every other entry's are empty. `files.live` is the README §6 starting
    point (`true` PokerStars, Winamax, ACR; `false` GGPoker, Ignition, WPT
    Global, PokerBros and the closed rooms; `null` the rest), every `files`
    block `verified: false` with its source; `files.glob` is set only where
    real file names are known (`*.txt`: PokerStars, GGPoker, WePlay);
    `encoding` is `auto` everywhere (the core sniffs each file). Every
    `tables` field is `null`. `anonymisation` is
    `frontend/src/lib/db/anonymization.ts`'s site default (`positional`
    Ignition, `opaque-id` GGPoker, `none` the other parsers, `null` without
    a parser), held to that file by a test. `operating` is `false` for the
    closed rooms per their research docs, `true` for rooms that plainly run
    today (2026 samples or common knowledge, not a per-client check), and
    `null` where not established (Chico, Ignition, and the `standard`
    format).
  - **`rail-config`** (pure functions; builds for wasm32, now part of CI's
    WebAssembly build): `model::{Config, Site, ...}` mirror the schema with
    `deny_unknown_fields`; `parse`, `load(text, parsers)` (parse +
    `validate` + `check_coverage`), `load_shipped(parsers)` over the
    embedded `SHIPPED` copy, `load_remote(shipped, text, parsers) ->
    Merged`, `merge_remote(shipped, remote) -> Merged { config, notes }`,
    `Site::hud_permitted()` (a room with `allowed == true`; R3.10's
    question). Parser ids are passed in
    (`rail_core::parsers::REGISTRATION_ORDER`), so the crate does not
    depend on the core. `validate` checks what the schema cannot or what
    the app must check without a schema engine: unique ids, `parser` in the
    registry, a parsed entry has an `anonymisation`, title regexes compile
    and have a `table` group, seat layouts are sizes 2-10, Windows paths
    start at `%VAR%\` or `X:\`, macOS paths at `~/` or `/`, real
    `YYYY-MM-DD` dates, a verified path has a date, `hud.allowed: true` has
    an `https://` source and a date.
  - **Merge rule** (`merge.rs`, tested over all nine shipped/remote pairs):
    looseness `false` < `null` < `true`; a remote entry may only move down
    or stay (then its block wins, so a re-check can refresh the date); a
    looser one keeps the shipped `hud` block and is reported. **Unknown ids
    in the remote file are ignored** (reported): an id is a key the app
    stores, and identity comes with a release. A shipped id the remote
    lacks stays as shipped. A remote entry that changes `kind`, `parser` or
    `anonymisation` is ignored whole. Paths, files, tables, names and notes
    are taken from the remote file - the guideline's "a new path without a
    new version". A remote file that does not parse, has another
    `version`, or fails `validate` is refused whole.
  - **CI rules**: `core/rail-config/tests/sites.rs` (in `cargo test
    --workspace` on all three OSes) fails when a parser of
    `rail_core::parsers::builtin()` has no entry or an entry names a parser
    that does not exist - so the guideline's "a new room or format = parser
    + golden tests + an entry in `config/sites.json`" (§14) is now
    enforced - and checks the docs links, `KNOWN_FORMATS`, the
    anonymisation mirror, "nothing verified, no HUD policy", and the merge
    on the real file. `tests/test/sitesConfig.test.ts` validates the file
    against the JSON Schema with ajv (draft 2020-12, formats asserted;
    `ajv` and `ajv-formats` added to `tests/` dev-dependencies, since a Rust
    schema engine would have added ~44 crates) and checks that the schema
    refuses 14 kinds of mistake.
  - **For R4.x** (not changed now): the web still takes display names from
    each TypeScript parser's `name` (`HandList.tsx`, `siteLabel`) and the
    anonymisation sets from `anonymization.ts`; when the web moves to the
    WASM core (R4.1) or `packages/ui` (R4.5), both should come from
    `sites.json` (the anonymisation test then becomes redundant).

### R0.13 WASM build — M
- `rail-core-wasm` with `wasm-bindgen`: `convert(bytes, filename) -> JSON`,
  `detect(bytes)`, `serialize(phf)`.
- Size budget (target < 1.5 MB gzipped) checked in CI.
- Shadow mode in `tests/`: the Vitest harness runs the WASM core next to the TS
  pipeline over the whole corpus and asserts identical results. The web keeps
  using TS until R4.1.
- **Done when** shadow mode is green.
- *As built* (§15):
  - **API** (`core/rail-core-wasm`, wasm-bindgen **0.2.129**, pinned `=`):
    `convert(bytes: Uint8Array, filename: string, optionsJson: string)
    -> string`, `detect(bytes) -> string`, `serialize(phfJson) -> string`,
    `anonymise(bytes) -> string`, `formats() -> string`. Bytes and JSON
    text in, JSON text out: one string crosses the boundary per call,
    `JSON.parse` builds the objects (0.16 s for the corpus's 76 MB of
    result JSON), and every integer the canonical form allows parses back
    exactly; `serde-wasm-bindgen` would cross once per field and turn `i64`
    into `BigInt` or a lossy number. `convert`'s document is
    `rail-convert/1`: `decode`, `detected { top, candidates }` (the goldens'
    shape), `chunks`, `hands[] { index, handId, parser, phf, phfSha256,
    standardText, warnings }`, `refusals[] { index, stage, reason, message,
    site, permille, parserVersion, fingerprint, rawText, sourceFilename }`,
    `stats`, `standardTextFile`, the R0.11 `unrecognized` record and
    `thrown`. Options: **`parsedAt` is required** (the core has no clock;
    a call without it throws, so a forgotten timestamp cannot become
    1970), `siteId`, `cashOnly`, `skipBombPots`, `validate` (default true),
    `standardText` (default true), `digests` (default false: the sha-256 of
    each hand's canonical JSON **as Rust writes it**, for byte-identity
    checks). `serialize` takes one PHF hand or an array (a file's text);
    `anonymise` is R0.11's shareable sample. The core gained
    `convert::convert_file(bytes, &ConvertOptions)` (and `_with`), of which
    `convert` is now the special case; nothing else in `rail-core` changed.
    The logic is `src/api.rs`, plain Rust tested natively (5 tests);
    `src/lib.rs` is only the `#[wasm_bindgen]` shims, and the crate keeps
    `#![forbid(unsafe_code)]` (the lint does not look into the macro's
    expansion). The typed wrapper `js/index.ts` (`railCore(raw)` over the
    generated `types/phf.d.ts`) takes an already loaded module, so it
    serves both wasm-bindgen targets.
  - **Build**: `npm run wasm:build [-- nodejs web]` in `tests/`
    (`tests/scripts/wasm/build.mjs`): `cargo build -p rail-core-wasm
    --target wasm32-unknown-unknown --profile wasm-release --locked`, then
    `wasm-bindgen --target <t> --remove-name-section
    --remove-producers-section` into `core/rail-core-wasm/pkg/<t>/`
    (gitignored; rebuilt by CI, a pure function of sources and pinned
    tools). The script refuses a `wasm-bindgen-cli` other than Cargo.lock's
    version and prints `cargo install wasm-bindgen-cli --version 0.2.129
    --locked`. Profile `wasm-release`: `opt-level = "s"`, fat LTO, one
    codegen unit, `panic = "abort"` (measured: `"z"` is 0.80 MB gzipped but
    1.6x slower; `3` is 1.00 MB and 8 % faster). **No `wasm-opt`**: not
    needed for the budget, and an unpinned system binaryen would make the
    output machine-dependent.
  - **Size**: **2.28 MB raw, 0.77 MB gzipped** (0.55 MB brotli) against the
    1.5 MB gzipped budget, checked by `wasm:build` (fails above it) and
    written to `pkg/size.json`. By `twiggy` on the unstripped module: the
    name section 0.78 MB (removed), `rail_core`'s own code 0.77 MB, data
    segments 0.57 MB (mostly the regex engine's Unicode tables and the
    parsers' strings), `core`/`alloc` generics 0.40 MB, `regex-automata`
    0.22 MB, `serde_json` 0.17 MB, `aho-corasick` 0.08 MB, `sha2` 8 KB.
    Lever if it ever matters: the regex Unicode features (they define
    `\s`/`\w` semantics the ports rely on, so not without a golden run).
  - **Shadow mode**: `npm run wasm:shadow` (`tests/scripts/wasm/
    shadow.test.ts`; not in `npm test`, it needs the build). Per corpus file
    the TypeScript side is the golden emitter's `goldenFor` (the
    converter's path) and the WASM side one `convert`; the WASM result is
    rewritten into the `golden-full` document and the two canonical texts
    must be equal byte for byte (decode, ranking with per-mille, chunks,
    every PHF in full, warnings with context, refusals, standard-text
    hashes per hand and per file, stats). Also: each `phfSha256` (Rust's
    canonical bytes inside WASM) equals the golden hash; refusals'
    `rawText` / `sourceFilename` equal TypeScript's; the registry record is
    there exactly for the unclaimed files, with the refusal's fingerprint;
    `detect` agrees with `convert`; `serialize` of the **TypeScript**
    hands through the strict Rust model gives the file's standard text;
    `parsedAt` is the caller's. Result: **556 / 556 files, 8 422 hands,
    196 refusals** equal, the 24 unrecognised files with their record.
    `goldenFor` now also returns `convertAny`'s raw result (no output
    change; `golden-fresh` unaffected).
  - **Throughput** over the corpus (M-series Mac, Node 24, warm, one
    thread): TypeScript `decodeSource` + `convertAny` **~3 150 hands/s**;
    WASM `convert` + `JSON.parse` **~2 600-2 700 hands/s** (~2 300 with
    standard text). The WASM core is ~15 % slower than V8 running the
    TypeScript - most likely V8's irregexp JIT against the `regex` crate
    compiled to wasm32 without SIMD (not profiled further); whole-file
    detection alone is 0.65 s of the WASM pass's ~3 s. `JSON.parse` of the
    results is 0.16 s. Not a blocker for R4.1 (the web parses in a worker,
    a 10 000-hand file in ~3-4 s either way); the native core is the fast
    path for the desktop.
  - **CI**: job `wasm` (ubuntu, beside the `core` matrix): rust-cache (which
    keeps `~/.cargo/bin`), `wasm-bindgen-cli` installed at Cargo.lock's
    version only when the cached one differs, `npm run wasm:build` (size
    budget), `npm run wasm:shadow`. The `core` job's plain wasm32
    `cargo build` stays.
  - **For R4.1**: build with `npm run wasm:build -- web` (ES module; the
    worker awaits its default `init()` with the `.wasm` URL, then passes
    the module to `railCore`); serve `rail_core_wasm_bg.wasm` with
    `application/wasm` and a long cache lifetime; pass `parsedAt: new
    Date().toISOString()`; move the build into the web's build (Vercel
    needs Rust + the pinned wasm-bindgen-cli, or CI publishes `pkg/web` as
    an artifact the deploy consumes - decide then); swap `phf/types.ts`
    for `types/phf.d.ts`; keep the "zero server requests" check (the
    `.wasm` is a static asset of the same origin).

### R0.14 Repository layout and rename — M
- User-facing name "Rail" everywhere (app copy, metadata, package names). GitHub
  repo rename optional (GitHub redirects the old URL).
- npm workspaces at the root: `web`, `app`, `packages/ui`, `tests`.
- `frontend/` → `web/`, in one PR together with the Vercel root-directory change
  (the deploy breaks between the two otherwise).
- Fixture trees → `testdata/`, in one commit together with `.gitattributes`,
  with a SHA-256 manifest of every file before and after the move; CI compares
  it. The binary attribute must cover the new paths in the same commit or
  autocrlf rewrites the evidence.
- **Done when** all CI jobs and the Vercel production deploy are green from the
  new layout.

---

## Phase 1 — Import and sync

**Goal.** Install the app, sign in, confirm folders, play: hands land locally
and in Supabase with no manual step.

**Exit.** With the simulator (R3.1 can be pulled forward for this) or a real
client writing a new session, every hand appears in Supabase within a minute,
exactly once, and the same files imported twice change nothing.

### R1.1 Tauri app shell — M
- Tauri 2, Vite, React, TypeScript in `app/`; single instance; tray icon with
  status; optional start at login; log files; crash-safe settings.
- CI builds unsigned app bundles on macOS (universal) and Windows (MSI/NSIS)
  for every PR.
- *As built* (§15):
  - **Layout.** `app/src-tauri/` is the crate `rail-app` (lib `rail_app`,
    binary `rail`, bundle `Rail`), a workspace member with the workspace
    lints and no exceptions; `app/src/` is Vite 7 + React 19 + TypeScript
    5.9 with its own `app/package.json` and lockfile until R0.14's npm
    workspaces. Identifier `app.rail.desktop`, provisional until the domain
    (P2, Q2): it names the config and log directories and the login item,
    so changing it later means moving the user's settings.
  - **Pinned exactly**: `tauri` 2.11.5, `tauri-build` 2.6.3,
    `tauri-plugin-single-instance` 2.4.4, `-autostart` 2.5.1, `-log` 2.9.1,
    `-dialog` 2.7.3; `@tauri-apps/cli` 2.11.4, `@tauri-apps/api` 2.11.1,
    React 19.2.8, Vite 7.3.6. `tauri` 2.11.5 asks for its own sub-crates
    with caret requirements and a fresh resolve takes the 2.12 line, which
    does not compile against it; `tauri-runtime` 2.11.3,
    `tauri-runtime-wry` 2.11.4, `tauri-utils` 2.9.3, `tauri-macros` /
    `tauri-codegen` / `tauri-plugin` 2.6.3 are therefore listed in
    `Cargo.toml` with `=` only to hold them. Move all of them together.
  - **Shell** (`src-tauri/src/lib.rs`): single instance (a second launch
    focuses the first window); tray icon with a disabled status line ("No
    folders watched yet"), Open Rail, Pause import (disabled placeholder),
    Quit Rail - `tray::set_status` / `tray::set_pause_enabled` are the hooks
    for R1.3 / R1.6; closing the window hides it to the tray, Cmd+Q or Quit
    ends the app, the Dock icon reopens it on macOS. Start at login is off
    by default, a setting; the login item (LaunchAgent on macOS) passes
    `--minimized`, which keeps the window hidden, and is reconciled with the
    setting on every start. Logs: `rail.log` in the OS log directory, 5 MB
    per file, the five newest kept, panics logged too. Settings
    (`settings.rs`): `settings.json` in the OS config directory, `{ version:
    1, theme, startAtLogin }`, written to a temp file, fsynced and renamed
    over the old one; an unreadable file is moved to `.corrupt` and the
    defaults used, a file from a newer version is read but never written;
    8 tests, plus one that `core_info` reaches the core and loads the
    shipped config.
  - **Window**: sidebar and the six screens of guideline §6 as hash routes,
    five as placeholders; Settings has Appearance (theme: system / dark /
    light, `data-theme` as on the web), Startup (start at login) and About -
    the command `core_info` returns the workspace version, `phf/1`, the 19
    parser ids from `rail_core::parsers::builtin()` and the entry count of
    `rail_config::load_shipped` (22), and `app_info` the log and settings
    paths. Debug builds only: `dev_pick_file` + `convert_file(path)` run
    `rail_core::convert` on a picked file and show encoding, detection,
    hands, refusals and time (`cfg(debug_assertions)` on the Rust side,
    `import.meta.env.DEV` on the web side; neither is in a release build).
    Strings in `app/src/i18n/` (`en`, `hr` prepared and typed against the
    same `Dict`, not yet selectable), the web's lint rule against bare JSX
    literals; the tray's strings are mirrored in `strings.rs`. Styles: CSS
    Modules over a **copy** of `frontend/src/styles/tokens/` in
    `app/src/styles/tokens/` (A3), with the web's stylelint token rules;
    `packages/ui` (R2.6) makes it one copy. Capabilities: `core:default`
    only; no plugin API is reachable from the window.
  - **CI**, job `app`: Linux installs WebKitGTK and runs ESLint, stylelint,
    `tsc -b`, clippy and the crate's tests; macOS and Windows run clippy and
    tests, then `tauri build`: **macOS `.app` + `.dmg` for the runner's
    architecture (arm64), not universal** - a universal binary compiles the
    app twice, which the release workflow (§12) can afford and a PR run
    should not; **Windows NSIS** (per-user). Bundles are built with LTO off
    and 16 codegen units (job env over the workspace release profile) and
    uploaded for 7 days. The macOS bundle is ad-hoc signed
    (`signingIdentity: "-"`, no certificate, no secret) because Apple
    silicon does not launch an unsigned app; Developer ID and notarisation
    stay with P3 and the release workflow. The `core` job now runs clippy
    and tests with `--exclude rail-app` (Tauri would need WebKitGTK there
    and would be compiled twice per OS); `cargo fmt --all` still covers it.
  - **For R1.2**: open the store in `setup` (`lib.rs`) next to the
    settings, as managed state, under `app_data_dir` (not the config
    directory, which holds `settings.json` only); folders, rooms and the
    consent state belong in the store, not in `settings.json`. **For
    R1.3**: start the watcher after the store in `setup`, report through
    `tray::set_status`, and enable "Pause import" with
    `tray::set_pause_enabled`; the Today screen is where its status shows.
  - Not here, as planned: signing, updater, deep links, sign-in (R1.7,
    §12); Inter is not bundled, so the app uses the system UI font.

### R1.2 Local store — M
- `rail-store`: §3.4 schema, embedded migrations, WAL, a single writer thread,
  read connections for UI queries.
- The `unsupported` table from R0.11's `Unrecognized` record and the consent
  state (see *As built, R0.11*, "For R1.2").
- **Done when** a crash mid-import (killed process) leaves the database
  consistent and the import resumes where it stopped.
- *As built* (§15):
  - **Crate** `core/rail-store` (`#![forbid(unsafe_code)]`, workspace lints,
    native only - not in any wasm32 build): `rusqlite` **=0.40.2**
    (`bundled`, `cache`; SQLite from `libsqlite3-sys` 0.38.2, compiled in)
    and `zstd` **=0.14.2**. The dev profile optimises `libsqlite3-sys` and
    `zstd-sys` (test speed only).
  - **Connection**: WAL, `synchronous = NORMAL` (a commit survives a killed
    process; an OS crash or power cut may lose the last commits, never
    consistency), `foreign_keys = ON`, 5 s busy timeout, **16 KiB pages**
    (measured: with 4 KiB pages a compressed PHF of ~2.5 KB spills into a
    mostly empty overflow page and the corpus store is 35 % larger). A file
    whose `user_version` is above the build's is refused before anything
    touches it.
  - **Migrations** (`src/migrate.rs`): SQL files in `migrations/` compiled
    in, version = `PRAGMA user_version`, forward-only, each applied in one
    transaction with its version bump. `0001_initial.sql` is the §3.4
    schema without the Phase 2/3 tables (reserved, in order, in
    `SCHEMA.md`). Tested from an empty file and from every earlier version
    (same `sqlite_schema` as from empty, rows kept), idempotent, newer
    refused.
  - **Schema** (`SCHEMA.md`, `STRICT` tables, times in ms since the epoch):
    `kv`; `sources`; `files` (path, source, size, mtime, `read_offset`,
    encoding, site, last error); `hands` (`hand_key` = the web's
    `handKeyOf`, `<siteId>:<handKey>`; site, hand id, `played_at`, format,
    variant, limit, currency and blinds/ante (the stakes), table, max
    seats, hero seat and name, schema and parser version, **canonical PHF
    zstd level 3** + its size, first delivering file, `imported_at`,
    `synced_at`); `quarantine` (file, read offset, chunk index,
    fingerprint, stage, reason, message, parser, raw text; one row per
    file and fingerprint, refreshed on a re-read - the file-level
    `unknown-site` refusal is not quarantined, the file goes to the
    registry); `unsupported` (R0.11's *For R1.2*: keyed by fingerprint, the
    `Unrecognized` fields, last file path and encoding, `count`,
    `first_seen` / `last_seen`, `consented_at`, `sent_at`,
    `anonymiser_version`, with a `CHECK` that nothing is marked sent
    without consent and an anonymiser version); `outbox` (hand key,
    attempts, last error, `next_attempt_at`).
  - **Writer**: one thread owns the write connection, fed by a bounded
    channel (16 commands) of `Import(ImportBatch)` and generic `Write`
    jobs; `WriterHandle` is cloneable for other threads, every call blocks
    until its transaction commits. An `ImportBatch { file: FileState {
    path, source_id, from_offset, to_offset, size, mtime, encoding, site,
    last_error }, hands, refusals, unrecognized }` commits in **one
    transaction**: the offset check (the stored offset must equal
    `from_offset`, or `from_offset` is 0 - a re-read; else
    `OffsetMismatch` and nothing is written), the file row with the new
    offset, `INSERT ... ON CONFLICT (hand_key) DO NOTHING` per hand with an
    `outbox` row for each one actually inserted, quarantine upserts, the
    registry upsert (`count + 1`). Canonical JSON and zstd run on the
    producer's thread, not the writer's.
  - **Readers**: a pool of 4 read-only (`query_only`) connections; queries
    `status` (hands, today since local midnight by SQLite's `localtime`,
    files, files with errors, folders, quarantined, unsupported, outbox),
    `hands_imported_since`, `file_state`, `files`, `sources` (with
    per-folder counts for R1.5), `quarantine` + `quarantine_reasons` +
    `quarantine_raw_text`, `outbox_due`, `unsupported`, `hand_phf`, `kv`.
    Writes besides import: `add_source`, `set_kv`, `outbox_mark_sent`
    (deletes, sets `synced_at`), `outbox_mark_failed` (attempts + 1, error,
    next attempt), `unsupported_consent`, `unsupported_mark_sent`.
  - **Import helper** (`src/import.rs`): `import_file(store, path,
    options)` skips a file whose stored offset equals its size and whose
    mtime is unchanged, else reads it whole, runs
    `rail_core::convert::convert_file` (`parsedAt` = now, or pinned by
    the caller) and commits one batch from 0 to the bytes read;
    `whole_file_batch` and `convert_bytes(FileState, ...)` are the seams.
  - **Exit check** (`tests/crash.rs`, in `cargo test` on Linux, macOS and
    Windows): the test binary re-runs itself as a child that imports the
    556 corpus files; the parent kills it (`Child::kill`: SIGKILL /
    `TerminateProcess`) 12 times - at random moments (after a random number
    of commits plus 0-25 ms, or 0-60 ms after spawn, which can land in the
    migration), and **inside an open transaction** (the child applies a
    20+ hand batch with the store's own `apply_import` and waits there).
    After each kill: `integrity_check` ok, no dangling foreign key, every
    file row at its end, the stored hands **exactly** the union of the
    stored files' hands (no hand without its offset, no offset without its
    hands), all of them in the outbox, quarantine and registry counts
    exactly those files'; a held batch leaves nothing. The next child must
    skip exactly the stored files and continue with the next. The final
    store equals a clean single import (every hand's PHF, files, offsets,
    quarantine, registry, outbox; 7 496 distinct hands from 8 422
    converted - the corpus repeats hands across files). Seeded
    (`RAIL_STORE_CRASH_SEED`), ~45 s in a debug build; locally 12-kill and
    40-kill runs passed, 7 of the 40 inside a transaction. Plus 12 tests
    of migrations, pragmas, dedupe, the offset rule, the registry, the
    outbox, sources, an unreadable file, and readers beside the writer from
    several threads.
  - **App** (`app/src-tauri`): `setup` opens the store after the settings
    as managed state `StoreState` (an error is logged and reported, the
    shell still starts) at `app_local_data_dir()/rail.db` - the *local*
    data directory: on Windows `app_data_dir` is the roaming profile,
    no place for a large database; on macOS the two are the same. Command
    `store_status` (async), shown on the **Today** screen as count tiles
    and the file's path, refreshed every 5 s; strings in `app/src/i18n/`
    (`en`, `hr`). One test opens a store through `StoreState`.
  - **Performance** (`cargo run --release -p rail-store --example
    import_corpus -- [threads]`, M2 Pro, release without LTO): the whole
    corpus (556 files, 10.6 MB, 8 422 hands) into an empty store - **one
    thread 2.7 s, ~3 150 hands/s; 8 converting threads feeding the one
    writer 0.72 s, ~11 700 hands/s**. The writer's share is small: 142 ms
    of the single-threaded run (~59 000 hands/s committed); conversion and
    compression are the rest. Database **23.1 MB, ~3.2 KB per stored
    hand** (canonical PHF averages 12.8 KB - it carries the raw text -
    and zstd takes it to 2.5 KB).
  - **For R1.3**: the watcher reads from `reader().file_state(path)`'s
    `read_offset` to the last complete hand and sends `ImportBatch {
    file: FileState { from_offset: stored, to_offset, size, mtime, .. },
    .. }` via `ImportBatch::from_conversion` - the writer refuses a batch
    whose `from_offset` is not the stored offset, so a stale or reordered
    read cannot move the offset wrongly; a truncated or rotated file is
    re-read with `from_offset: 0` (always accepted; dedupe keeps hands
    once, quarantine rows are refreshed). Note that `unsupported.count`
    goes up on every read that ends in the registry, so the incremental
    reader should only send `unrecognized` for a file's first read (or a
    re-read from 0). Folders go in `sources` (`add_source`; batches carry
    `source_id`); start the watcher after the store in `setup` and use
    `store.writer()` from its thread. A UTF-16 file's offset is in bytes.
  - **For R1.6** (done, see R1.6): parallel conversion is already the shape (`examples/
    import_corpus.rs`); add rayon, progress and the CI benchmark. If the
    writer ever becomes the bottleneck, group several queued batches in
    one transaction (each still with its own offset). A zstd dictionary
    trained on PHF would shrink the store well below 3.2 KB per hand
    (A5).
  - **For R1.9**: `outbox_due(now, limit)` returns the PHF JSON with each
    key, oldest first; `outbox_mark_sent` / `outbox_mark_failed(keys,
    error, next_attempt_at)` - the backoff is the worker's; sync cursors in
    `kv`. Registry uploads: `unsupported` rows with `consented_at` and no
    `sent_at`, then `unsupported_mark_sent`.

### R1.3 Watcher and incremental reader — L
- `notify` for OS events, plus a rescan every 60 s; network drives poll only.
- Per file: offset, size, mtime; read only new bytes; a hand is complete when
  the next hand header starts or the file has been idle for a few seconds and
  the hand validates. UTF-16 files are read on code-unit boundaries.
- Handles rotation, rename, deletion, truncation (re-read from 0, dedupe saves
  us), unplugged drives.
- **Done when** a test that appends a corpus file to a watched file byte by byte
  in random chunks imports exactly the hands of that file, once.
- *As built* (§15):
  - **Crate** `core/rail-watch` (`#![forbid(unsafe_code)]`, workspace lints,
    native only - not in any wasm32 build): `notify` **=8.2.0** (FSEvents
    with latency 0 and `NoDefer` on macOS, ReadDirectoryChangesW on
    Windows, inotify on Linux), `rail-store`, `rail-core`, `log`. Modules:
    `codec` (piecewise decoding), `reader` (one file, offset to last
    complete hand), `scan` (which files, network volumes), `watcher` (the
    service). `rail-store` gained migration **0002** (`sources.poll_only`),
    the source writes on `WriterHandle` (`add_source` with `poll_only`,
    `remove_source`, `set_source_enabled`, `set_source_poll_only`,
    `set_source_status`) and `StoredFile.encoding`.
  - **Completeness rule** (`reader.rs` docs). A read decodes the bytes from
    the stored offset, takes the best parser for that text (or the folder's
    `site_override`) and its `split_hands`, and locates every chunk in the
    text in order. (1) **The next hand has started**: every chunk but the
    last converts (`convert_any` on the text up to the last chunk's start)
    and the offset moves to the **byte where the last chunk starts**, so the
    next read starts exactly at a header. Measured before building on it:
    for all 517 files with hands whose chunks are verbatim in the text, converting
    each chunk's own slice (from its start to the next one's) gives exactly
    the whole-file hands and refusals (canonical PHF, fingerprint, reason,
    message, site, per-mille). (2) **The file is quiet**: the last chunk is
    complete after `quiet_ms` (500 ms) without a change **and** it validates
    **and** the file does not end inside a code unit **and** the text ends
    with a line end (else after `settle_ms`, 5 s). (3) A last chunk that
    never validates (a refused game, a broken hand) is committed with its
    refusal after `give_up_ms` (30 s); then the file counts as finished, so
    a half code unit at its end is the core's U+FFFD, as in a whole-file
    read. Quiet counts from the mtime when it has milliseconds, else (whole
    seconds: FAT, HFS+, some shares) from when the reader saw the change.
    The assumption: a room writes a hand within the quiet period; a writer
    stopping mid-hand for longer, at a line end, with a valid-looking prefix
    would get that prefix stored (none in the corpus or in any room's
    behaviour seen).
  - **Pieces that cannot stand alone.** Chunks not found verbatim (iPoker
    assembles each hand from the session's `<general>` and one `<game>`: 14
    of its 15 corpus files), or a piece from a non-zero offset that no
    parser claims or that splits into nothing: the file is read **whole**
    every time it changes and has been quiet (from offset 0, which the store
    always accepts; dedupe keeps hands once). A file nothing claims is
    committed from 0 as the core's file-level refusal after the give-up
    time; its registry record only on the file's first read (or after a
    truncation), so `unsupported.count` does not climb.
  - **Encodings** (`codec.rs`). The decision is the core's
    (`decode_source`) on the bytes from offset 0, minus an unfinished tail
    (half a UTF-16 unit or pair, a cut UTF-8 sequence - which would make the
    core say Windows-1252, or binary for a short UTF-16 file); remembered in
    memory once something is stored and as `files.encoding` for the next
    start. Pieces decode to exactly the core's text: BOM bytes (and up to two
    U+FEFF after them, as `decode_source` strips) **only at offset 0** - a
    file with a UTF-8 BOM that the core reads as Windows-1252 loses those
    three bytes too; CR / CRLF to LF; UTF-16 on **code-unit boundaries**
    (an odd byte or a lone lead surrogate at the end is left for the next
    read); WHATWG replacement for lossy UTF-8. `byte_offset_of` maps a text
    position back to the file byte (through CRLF and BOMs). Strict UTF-8
    meeting an invalid byte is decided again on the whole file: Windows-1252
    after an all-ASCII stored prefix, or lossy UTF-8, keep the offset;
    anything else (non-ASCII UTF-8 already stored, then a 1252 byte) is read
    again from 0 - the stored hands keep their correct text, the keys are
    the core's. Checked on all 556 corpus files: the decision equals the
    golden's, the text from 0 equals `decode_source`'s, and two pieces split
    at hand starts (1 464 sampled) join to it.
  - **Truncation, rotation, rename, deletion.** A file smaller than its
    offset, or whose first 256 bytes differ from those seen at the last
    commit (replaced by another at least as long), gets its row reset to 0
    first (so a read that stores nothing still restarts next time), then is
    read from 0 (dedupe keeps hands once). A file gone while its folder is
    there is forgotten (row to offset 0, hands kept), so a new file at that
    path starts from its beginning; a rename is a gone file plus a new one
    (read from 0, duplicates only). A file gone with its folder (a drive
    pulled out) keeps its offset.
  - **Service** (`watcher.rs`): one coordinator thread owns the notifier,
    the folders (from `sources`) and what is known of each file; it turns
    notifications, walks and recheck times into dirty files and hands them
    to **2 workers** (`WatchConfig::workers`) - never one file to two. A
    worker runs `FileReader::poll` (read, convert, compress, commit through
    the store's writer). Back-pressure: the writer's bounded queue blocks
    the workers, the job queue (2 per worker) fills, the coordinator keeps
    the files marked. **Rescan** of every folder every 60 s (a file whose
    size or mtime changed since the last walk). A folder's OS watch is set
    before its walk, and the folder is walked again 1 s later: FSEvents
    starts delivering a moment after the watch is set, and a file written
    in that moment is in no notification (a test caught it). A new subfolder of a
    recursive folder is walked at once (its files may predate its OS
    watch); a notifier error or overflow walks everything. **Poll only**:
    `sources.poll_only`, set on `add_source` when the folder is on a network
    volume (UNC paths on Windows; `smbfs`, `nfs`, `afpfs`, `webdav`, `cifs`,
    ... in `mount` on macOS and `/proc/self/mounts` on Linux; a network
    share mapped to a drive letter is not detected - R1.5's checkbox), or by
    the user; such folders are walked every 3 s and never registered with
    the notifier. A folder that is not there is `unavailable`, one that
    cannot be read `error` (the reason in `sources.last_error`); both are
    retried only at the next rescan. Files: `.txt`, `.xml`, `.log`, not
    hidden, not in hidden folders, links to folders not followed. Events
    on macOS name `/private/var/...` for `/var/...`: paths are mapped back
    to the folder's own spelling. API: `Watcher::start(store_path, writer,
    config, on_event)`, `stop`, `pause` / `resume` / `is_paused` (paused:
    notifications are noted, nothing is read; resuming walks every folder),
    `add_source` / `remove_source` / `set_source_enabled` /
    `set_source_poll_only` (each writes `sources` and reloads), `rescan`,
    `status()` (per folder: state, error, files, hands, hands today,
    quarantined, last import from the store; files with read errors and
    files waiting for their last hand from the watcher), and events
    `Imported`, `Source`, `FileError`, `Paused`. **Stop the watcher before
    the store closes**: `Store` waits for every writer handle (a test that
    dropped the store first hung).
  - **Exit check** (`tests/random_append.rs`, in `cargo test` on Linux,
    macOS and Windows): per (parser, encoding) the corpus file with most
    hands and refusals under 40 KB, plus a no-hands file - **31 files, all
    19 parsers, UTF-8, UTF-8 with BOM, UTF-16 LE, Windows-1252** - each as
    it is and with the other line ends (CRLF <-> LF re-encoded, same decoded
    text, same golden): 62 runs. Each is appended to an empty watched file
    in random chunks (a third of the runs **one byte at a time**, the rest
    1 byte / 2-16 / 17-256 / 257-4096), the clock moving 0-249 ms between
    writes (less than the quiet period), the reader looking at random
    moments (about 250 looks per file) and, half the time, after a pause of
    quiet + 0-5 s at a hand's end; at the end the clock passes the give-up
    time. On the test's own clock (the file's mtime set to it): nothing
    sleeps, seeded per file (`RAIL_WATCH_SEED`). Then the store must hold
    exactly the golden's hands (sha-256 of each canonical PHF; a hand id
    that the file holds twice once, as its first copy), refusals and
    registry record, equal to a whole-file import of the same bytes, the
    file read to its last byte, every hand delivered once (inserted =
    stored; duplicate deliveries equal the whole file's own), and no commit
    of a UTF-16 file ending inside a code unit. **All pass**, ~10 s in a
    debug build. `RAIL_WATCH_FILES=all` runs **all 556 files x 2** (a soak:
    passed twice, seeds default and 7, ~6 min debug; no file needed a
    re-read from 0; 28 runs whole-file, the iPoker ones). Found on the way:
    UTF-16 files that end in a stray byte (5 ACR files) - the core puts a
    U+FFFD into their last hand, hence rule (2)'s "not inside a code unit".
  - **Other tests**: `reader_edges.rs` on the manual clock - the rule step
    by step, a hand without a line end (settle), a refused tail (give-up),
    truncation (to fewer bytes, to empty then other hands), a file replaced
    by a longer one, rename and deletion, ASCII then Windows-1252 (offset
    kept), UTF-8 then Windows-1252 (read again), a file nothing claims (one
    registry count); `watcher.rs` on the real clock and the OS's
    notifications - new file, appends, a second file in a new subfolder,
    pause / resume, a folder that is not there and comes back (and goes
    again: offsets kept), poll-only, disable / enable / remove (hands
    stay); `codec_corpus.rs` (above); unit tests of the codec, the walk and
    the mount tables.
  - **Latency** (`watcher.rs::latency_from_append_to_commit`, M2 Pro,
    debug build, default timing): append to committed batch, median of 5,
    over four runs - **15-24 ms** for a hand the next hand's header
    completes, **513-522 ms** for the last hand (the 500 ms quiet period +
    13-22 ms). §3.3's budget (< 1 s,
    aim < 250 ms) holds for the first; for the last hand of a table - the
    usual case while playing - the quiet period is the floor: it can go
    down once real rooms' write patterns are seen (P6, R1.4).
  - **App** (`app/src-tauri/src/watch.rs`): `setup` starts the watcher
    right after the store (`WatcherState`, managed; without a store it does
    not start and says why) and stops it first on `RunEvent::Exit`. The
    tray's status line follows it ("Watching 2 folders · 37 hands today",
    "Import paused", "1 folder cannot be read", "Import is not running"),
    redrawn at most once a second by a small thread when something changed;
    "Pause import" / "Resume import" toggles it, enabled when there is a
    folder. Commands `watcher_status`, `set_import_paused`; Today shows an
    **Import** section (state, pause / resume, a table of folders: status,
    hands today, hands, last import, refused / unreadable / waiting).
    Debug builds only: `dev_add_folder` and an "Add a folder to watch..."
    button there (recursive; poll-only when on a network volume). Strings
    in `app/src/i18n/` (`en`, `hr`) and `strings.rs`.
  - **For R1.4**: discovery should call `Watcher::add_source(path,
    recursive, None)` per confirmed folder (`None` = poll-only when on a
    network volume). "Only new hands" needs a way to mark a folder's
    existing files as read without importing them (a batch per file with
    `to_offset = size` and no hands is enough; worth a `Watcher` method).
    Narrow `scan::EXTENSIONS` per room with `sites.json`'s `files.glob`
    once verified, and use `site_override` where a room's files are
    ambiguous. Note the real write pattern of each client (whole hand at
    once? trailing blank lines?) - it decides how far `quiet_ms` can drop.
  - **For R1.5**: the folder list and its counts are `Watcher::status()`;
    edits are `add_source` / `remove_source` / `set_source_enabled` /
    `set_source_poll_only` (each reloads the watcher); editing a path or
    the room override needs two more `sources` writes (`UPDATE path`,
    `site_override`) and a reload. Quarantine with reasons per folder:
    `Reader::quarantine` joined through `files.source_id`.
  - **For R1.6**: the reader converts on the worker that read the file;
    the backfill of a large folder is one batch per file, 2 workers. Tune
    `WatchConfig::workers`, split a very large first read into several
    batches (each with its own offset), add progress events (bytes read of
    bytes to read) and rayon if per-file parallelism is not enough. The
    coordinator recomputes per-folder counters on every message (fine for
    thousands of files, revisit for a 100k-file backlog).

### R1.4 Folder discovery — M
- Fill `sites.json` paths per room and OS **from real installs** (P6), not from
  tracker forums; record how each was verified. Today the research docs confirm
  almost no default folders.
- From R0.12: every path is `verified: false` and only PokerStars has any
  (inferred). Per room, set `paths` (a verified entry needs `checkedAt` and
  a `source` saying how it was seen), `files.glob` and `files.live` with
  `files.verified`, and `operating` where it is `null`; relax the paths and
  files part of the R0.12 test `nothing_is_verified_yet`. Split the
  `network` entries that still operate (`ipoker`, `chico`, `ignition`) into
  one room per client found, and add the skins named only in notes (WPN:
  Black Chip, True Poker, Ya Poker; GG: Natural8, BestPoker, ClubGG) once a
  client is installed. No source covers PokerStars' regional clients yet.
- First-run screen: found folders with file count and date of the last hand;
  one click to confirm; "import everything" vs "only new hands".
- *As built* (§15):
  - **What was verified** (macOS, this development Mac, 2026-10-13; read
    only, structure only - no hand, name or account left the machine; how
    to repeat it for any room on macOS or Windows:
    [`docs/research/VERIFYING-PATHS.md`](research/VERIFYING-PATHS.md)).
    **GGPoker** (`GGPoker.app`, bundle `com.nsuslab.ncf.launcher.live.ggpcom`,
    launcher 1.0, game module 1.0.0.480): no hand-history file anywhere in
    its data folders (UI assets, caches, settings databases of a few KB),
    `~/Library` or `~/Documents`, no preference naming one - a **verified
    negative**: `files.live: false`, `verified: true`, no path (PokerCraft
    downloads go wherever the user saves them; the glob `*.txt` is their
    names). **CoinPoker** (`CoinPoker.app` 1.25.0, Electron lobby + Unity
    tables): tables had been played (per-table client logs), still no
    hand-history file locally (the logs are diagnostics without a hand
    header); the client fetches hand history from its server - a verified
    negative too (`live: false`, no glob, no path; whether a client setting
    enables a local export was not looked for). **WePlay** (`Weplay.app`
    2.0, revision 26.7.2; installed too, so checked as well): files
    `HH<date> ....txt` under `~/Documents/hands/<account>/`, the folder
    the client's `HandsHistoryDir` preference names; each file was born on
    the day its name says and written for 1-222 minutes after - **live**.
    Recorded as `paths.macos: ["~/Documents/hands/*"]` (verified, with the
    caveat that the folder may be the user's choice, not the default),
    `files.glob: "HH*.txt"`, `live: true`. Everything else stays
    `verified: false`; R0.12's `nothing_is_verified_yet` is now
    `only_what_was_seen_is_verified`, which lists exactly these three
    `files` blocks and the one path, requires an "Observed on" source and a
    date on them, no path for a client with `live: false`, and holds every
    other entry (and every `tables` block) unverified. No network entry was
    split and no skin added (no such client installed). The real write
    pattern for `quiet_ms` (whole hand at once? trailing blank lines?) was
    **not** observed: that needs a capture during play.
  - **Discovery** (`rail_watch::discover`, native only): `discover(config,
    env, watched, limits) -> Vec<Found>`; `Found { site, name, path,
    template, verified, glob, files, complete, newest_ms, sample, watched
    }`. Templates are cut at `/` (macOS: `~` from `Env::home`, or `/`) or
    `\` (Windows: `%VAR%` from `Env`'s variables, case-insensitive, or a
    drive); `*` / `?` levels match existing folders (ASCII case ignored,
    hidden ones only for a pattern starting with a dot, links to folders
    followed), sorted, at most `Limits::matches` (32) per level; `.` / `..`
    refused, an unset variable or no home expands to nothing; a folder two
    templates or rooms name is reported once. Each folder is walked to
    `Limits::depth` (3) levels and `Limits::entries` (20 000) entries,
    sorted (deterministic; `complete: false` and a lower-bound count past
    the bound); files are the room's `files.glob`, or the watcher's
    extensions when unknown - and then the **newest 3** are sampled: their
    first 64 KiB through `decode_source` and `detect_site`, `Sample {
    looked, claimed }` = how many the room's parser wins (the screen warns
    when none). The last hand's date is the newest counted file's mtime (no
    file is parsed). `Env::current()` (OS, `HOME` / `USERPROFILE`, the
    environment) or `Env::new(os, home).with_var(..)` for tests;
    `file_globs(config)` for the watcher. Tests (`tests/discover.rs`, fake
    home, all OSes): macOS account levels and globs, Windows variables and
    drives, sampling with corpus files, the bounds, watched folders, the
    shipped file (nothing on an empty home; WePlay's folder found).
  - **"Only new hands"**: `FileReader::mark_read(file)` commits one batch
    with no hands, `from_offset` 0 and `to_offset` the end of the complete
    bytes (a UTF-16 half unit or a cut UTF-8 sequence is left), the
    encoding the core decides on the whole file; a file with a row already,
    an empty or a missing file is left alone. The next read continues from
    there like after any commit. `Watcher::add_source_with(path,
    &NewSource { recursive, poll_only, site, only_new })` stores the folder
    (and `site`), marks its matching files **before** the watcher reloads
    (so none is read in between) and returns `AddedSource { id, marked }`;
    `add_source` is that with defaults. Caveats (documented on the method):
    a hand being written at that moment is cut, its file then cannot
    continue from the offset and is read whole (its old hands come in);
    iPoker-like files are read whole whenever they change. Tests: a marked
    file imports exactly the hands appended after it (`reader_edges.rs`),
    UTF-16 marked to a whole unit; the watcher with "only new" skips a
    folder's five existing hands, then imports the five appended and a new
    file's ten (`watcher.rs`).
  - **Files per room**: migration **0003** `sources.site` (the `sites.json`
    id discovery found the folder for; NULL for a folder added by hand -
    not a parser override), `WriterHandle::set_source_site`,
    `SourceSummary.site`, `SourceStatus.site`. `WatchConfig::file_globs`
    (id -> glob, the app fills it from the shipped file): a folder with a
    `site` whose room has a glob reads only matching files - walks,
    notifications and new subfolders alike (`scan::is_candidate_for`,
    `walk_matching`, `name_matches`: `*`, `?`, ASCII case ignored); other
    folders keep `.txt` / `.xml` / `.log`. Changing a folder's room drops
    its tracked files and walks again.
  - **App**: `folders.rs` - `discover_folders` (discovery over the shipped
    `sites.json` for this OS, watched folders from the watcher, plus the
    rooms looked for, for the empty state), `add_folders(folders, onlyNew)`
    (`add_source_with` per folder; recursive; poll-only on a network
    volume; an unknown room id is dropped), `pick_folder` (the system
    picker; `tauri-plugin-dialog` is now registered in release builds too,
    still called from Rust only - no plugin permission for the window);
    `set_first_run_done`; settings gain `firstRunDone` (absent = false, so
    an install from before R1.4 sees the screen once). **First-run
    screen** (`#/setup`, `screens/FirstRun.tsx`; outside the sidebar, which
    highlights Settings): opened at start while `firstRunDone` is false,
    reachable from Settings ("Hand-history folders", Find folders...) and
    from Today when no folder is watched. Three steps (guideline §6): 1
    sign in - a "coming soon" placeholder (R1.7); 2 the found folders as a
    table (room, folder, files - "N+" when the walk stopped - last-hand
    date), each with a checkbox, ticked unless already watched; a note on
    a folder whose template is unverified and a warning when sampling found
    none of the room's files; "Add a folder manually..." adds a picked
    folder to the list; "Import everything" (default) or "Only new hands";
    one button watches all ticked folders; an empty state names the rooms
    looked for and says their folders are being verified; "Skip for now";
    3 open a table, then "Go to Today" (sets `firstRunDone`). Strings in
    `en` and `hr`. R1.3's debug-only "Add a folder" button and
    `dev_add_folder` are gone. Checked in a browser against a mocked IPC
    (found, empty, manual add, only new, confirm, done); not in a `tauri
    dev` window on this Mac (no real data imported).
  - **For R1.5** (Settings → Folders): the list is `Watcher::status()`
    (now with `site` - show the room's name from `sites.json`); add = the
    picker plus `add_source_with` (offer "only new" there too);
    `remove_source` / `set_source_enabled` / `set_source_poll_only` exist;
    still missing: editing a folder's path (`UPDATE sources SET path` and a
    reload - the files' rows keep their old paths, so either move them in
    the same transaction or treat it as remove + add), the room override
    (`site_override`, a writer method), the room itself (`set_source_site`
    exists; reload notices a changed glob), and the recursive flag (a
    writer method). Per-folder quarantine: `Reader::quarantine` joined
    through `files.source_id`. Re-running discovery from there is
    `discover_folders` (watched folders are already flagged). Reading the
    folder from a client preference (WePlay's `HandsHistoryDir`) rather
    than the template would make discovery exact for a user who moved it -
    worth doing per room once more clients are seen. **macOS privacy
    prompts**: discovery reads `~/Documents/hands` (WePlay), and macOS asks
    the user once whether Rail may access the Documents folder (TCC; a
    denial means nothing is found there, silently) - expected, since the
    watcher needs the same access, but the first-run screen could say why
    before it asks; `~/Library/Application Support` asks nothing. Check this
    on the signed build (P3), where the prompt names the app.

### R1.5 Settings → Folders — M
- Add (picker, external and network drives), edit path, override room,
  enable/disable without deleting hands, recursive, status per folder (last
  import, hands today, errors, quarantined hands with reasons).
- *As built* (§15):
  - **Store** (`rail-store`, no schema change - version stays 3): new
    `WriterHandle` writes `set_source_recursive`, `set_source_site_override`
    and `set_source_path`, readers `Reader::source_files(id)`,
    `source_quarantine(id, limit)` and `source_quarantine_reasons(id)` (the
    quarantine joined through `files.source_id`), error `PathTaken`.
    Documented in `SCHEMA.md`.
  - **Edit path - design**: a folder keeps its id and settings; in **one
    transaction** (`set_source_path(id, path, moves)`) the row gets the new
    path (state back to `idle`), every file the caller found again under the
    new path gets its new `files.path` and **keeps its row and
    `read_offset`**, a file of the new folder that had a row already (read
    before, from another folder or none) keeps that row, which joins the
    folder ("adopted"), and every other file of the folder is **detached**
    (`source_id` NULL, hands kept) as on removal. So a new path with all the
    old files is a move (nothing is read again), one with none of them is
    remove + add with the same settings, and a mix is both. "Found again" is
    decided by `Watcher::set_source_path` on the disk: the same relative
    path, a file at least as long as what was read of it. A wrong match is
    harmless: the bytes at the offset then start no hand, and the reader
    reads that file whole from 0 (dedupe keeps hands once). "Only new hands"
    applies to the new folder's files without a row. A path another folder
    has is refused. Tested both ways in the store (`a_folder_path_changes`:
    moved, adopted, detached, path taken, missing folder, remove + add) and
    on the real watcher (`a_folder_path_changes_and_continues_where_it_stopped`:
    a copied folder continues from the offset - every committed read starts
    above 0 - and imports only the appended hands; a folder with other files
    and "only new" skips its old hands, imports the appended ones, and the
    old file is detached with its hands).
  - **Room override** (`sources.site_override`, a `rail_core` parser id;
    `Watcher::set_source_site_override` refuses an id the build does not
    have). When the choice changes, the folder's files that the parser now
    in force reads differently go back to offset 0 with their quarantine rows
    in the same transaction - with an override, every file whose
    `files.site` is not that parser; cleared, every file with no site or the
    old override's - and the watcher reload drops what it tracked of the
    folder, so they are read again with the new choice (hands stay and
    dedupe). For that, the reader now records **the forced parser as
    `files.site`** under an override (before, detection's top candidate even
    when a parser was forced; not a parsing change). Tested in the store and
    on the watcher (forced to a wrong room the file is read again under it;
    cleared, it is read as PokerStars again with nothing refused).
    `discover`'s room (`sources.site`, which narrows files to the room's
    glob) is unchanged and shown as "found by Rail".
  - **Watcher**: `set_source_recursive`, `set_source_site_override`,
    `set_source_path(id, path, only_new) -> SourceMoved { change, marked }`;
    `add_source_with`'s "only new" marking is shared (`mark_existing`).
    `SourceStatus` gains `enabled` and `site_override`. Reload now also
    notices a **changed path**, and drops the folder's tracked files when
    its path, recursive flag, override or glob changed (they are walked
    again and read from the store's offsets). Known gap, documented: a file
    a worker is reading at the very moment the room or path changes may be
    committed under the old one (it is read with the new one when it next
    changes). Tests: the two above plus `recursive_off_reads_the_top_level_only`.
    *Closed 2026-10-14* (§15): the gap was worse on a path change - a read
    of the old path that looked at the store after the move re-read the
    file from 0 under a new row of the folder - and both changes now
    **fence** the folder first (no new read of its files, the ones in flight
    answered with their commits) and let it go after the reload.
    *Extended 2026-10-15* (§15): removing a folder, disabling it,
    switching its subfolders off and giving a folder already there a room
    fence it too, a folder being added with a room or "only new" is held
    until it is set up, and a fence stops a large read of the folder after
    the group it is committing; poll-only, enabling and subfolders on need
    no fence (`watcher.rs`, "Changing a folder under its reads").
  - **App** (`src-tauri/src/folder_settings.rs`, thin): `add_folder(path,
    onlyNew, recursive, pollOnly)`, `set_folder_path(id, path, onlyNew)`,
    `set_folder_room(id, parser)`, `set_folder_enabled`,
    `set_folder_recursive`, `set_folder_poll_only`, `remove_folder`,
    `folder_rooms` (the 19 parsers named from `sites.json`, sorted),
    `folder_quarantine(id)` (counts per reason and the 200 newest refused
    hands, no raw text). Every path from the window goes through
    `checked_folder`: absolute, no `..` component, no NUL, an existing
    directory, rebuilt from its components (`a/./b/` is `a/b`); R1.4's
    `add_folders` uses it too. An unknown folder id is an error.
    `watcher_status` gains `enabled`, `siteName`, `siteOverride`.
  - **Window**: Settings opens with **Hand-history folders**
    (`screens/settings/Folders.tsx`, `FolderCard.tsx`, `RefusedHands.tsx`):
    a card per folder - path, room ("found by Rail" / "chosen by you" /
    detected per file), state, last import, hands today, hands, files,
    problems (unreadable folder, unreadable files, a hand waiting, refused
    hands), "Show the N refused hands" (reason codes with counts, then reason,
    message, file and time), and its controls: watch this folder, include
    subfolders, check for changes by polling, room (Detect per file + every
    parser), Change folder... (picker, then a dialog explaining move vs new
    folder, with the import choice), Remove... (a dialog saying the hands
    stay and nothing in the folder is deleted). Above the list: Add a
    folder... (picker, then a dialog: import choice, subfolders, polling)
    and Find folders again (discovery; the folders not watched yet, with
    the first-run table and import choice). Refreshed every 3 s; loading,
    empty, error and not-running states; a polite live region reports each
    change. The first-run screen's table and import choice are shared
    components now (`components/FoundFolderTable.tsx`,
    `components/ImportChoice.tsx`), plus a modal `components/Dialog.tsx` on
    `<dialog>` (focus inside, Escape closes). Strings `en` + `hr`
    (`settings.folders`, `foundFolders`, `importChoice`). Checked in a
    browser against a mocked IPC with made-up folders (list, refused hands,
    room change, add with "only new" and polling, change path refused as
    taken, remove, find again, enable, empty state, light and dark); not in
    a `tauri dev` window on this Mac (no real data imported).
  - **For R1.6**: the backfill a new path, a room change or "import
    everything" starts is still one batch per file on 2 workers; a room
    change on a large folder resets every file read by another parser, so
    progress events (bytes read of bytes to read per folder) belong on
    `SourceStatus` and the folder card next to "Problems". The quarantine
    UI exists per folder (`folder_quarantine`); R1.6's "quarantine with
    reasons, visible in the UI" can add the raw text
    (`Reader::quarantine_raw_text`) and a re-run after a parser update
    (reset the files whose quarantine rows carry an older
    `parser_version`, the same reset `set_source_site_override` does).
    `Watcher::status()` re-reads `Reader::sources()` (per-folder counts
    with subqueries) on every call; at 500k hands, measure it in the
    benchmark and add a `files (source_id)`-driven rollup if it shows.

### R1.6 Import pipeline — M
- Bounded queue → parallel parse (`rayon`) → batched transactions; progress for
  the backfill; quarantine with reasons, visible in the UI.
- Benchmark in CI on replicated corpus data (labelled as generated, outside the
  fixture trees): **≥ 5,000 hands/s** on the CI macOS runner.
- *As built* (§15):
  - **Import threads** (`rail-watch`, `rayon` =1.12.0, `num_cpus` =1.17.0):
    R1.3's two worker threads became a rayon pool of
    `WatchConfig::workers` threads, default **physical cores - 1, at least
    1, at most 8** (`default_workers()`; 8 on the M2 Pro). The coordinator
    keeps at most that many files in flight (back-pressure: the writer's
    16-command queue blocks the threads, files stay queued). Its queue is
    a deque: files the OS reported and recheck times go to the **front**,
    a walk's files (backfill, rescan) to the back, so a hand being played
    is read before the rest of a backfill. The 100k-file data structures
    are no longer scanned per message (rechecks in a `BTreeSet` by time,
    the queue popped, status published at most every 200 ms). **Hook for
    play time**: `Watcher::set_import_threads(Some(n))` lowers the number
    of files (and batches of a large read) in flight at once, now; a
    lower OS priority belongs in the pool's `start_handler` (not done:
    `forbid(unsafe_code)`, and nothing detects play yet - Phase 3 does).
    `WatcherStatus` reports `threads` and `threads_allowed`.
  - **A large read** (`reader.rs`): when a read has more than
    `ReadConfig::batch_hands` (500) complete hands - the hands the next
    hand's start proves complete, quiet or not - they are cut at hand
    starts into batches of 500, converted **in parallel on the same pool**
    (`par_iter` inside the pool thread: work stealing, no extra threads)
    and committed **in order**, each with its own `from_offset` /
    `to_offset` (batch *k* starts where *k - 1* ended): the store's offset
    rule holds per batch and a crash keeps a prefix. A group of batches
    (as many as threads) is queued back to back (`import_async`), so the
    writer commits it in one transaction. The last hand is read by the
    next look, at once (`recheck_at = now`). Pause and stop
    (`ImportLimits::interrupt`) stop it between groups, and so does a
    fence of its folder (`ImportLimits::stop_folder`, 2026-10-15). A batch that does
    not split as the whole did stops it and reads the file whole from
    then on (as R1.3's single-batch path does); none in the corpus.
    Batch boundaries map to bytes in one pass (`codec::byte_offsets_of`;
    one pass per boundary would be quadratic). Tested
    (`tests/large_read.rs`): batches of 2 hands over every (parser,
    encoding) pick with more than 3 hands - 15+ files, UTF-16 included -
    as they are and with the other line ends end exactly as a whole-file
    import; a pause between batches continues to the same end. The
    reader's whole-text detection is now handed to the conversion
    (`rail_core::convert::convert_any_detected`, an API addition: `run`
    took pre-detected candidates already; no behaviour change, tested
    equal to `convert_any`) - it was ~12 % of a read.
  - **Grouped commits** (`rail-store` writer): import batches waiting in
    the queue together commit in **one transaction**, up to 64 batches or
    ~2 000 hands, **each in its own savepoint** (a stale one is rolled
    back alone and answered with `OffsetMismatch`, the others commit; a
    failed commit answers all with `Error::Commit`). `apply_import` takes
    a `&Connection` (a transaction or savepoint). R1.2's crash test now
    sends six batches at a time (`import_async`), so kills land in grouped
    transactions too: green (12 kills, 5 inside a transaction);
    `tests/pipeline.rs` holds the writer, queues a good, a stale and a good
    batch and gets the same store as one by one.
  - **Folder rollups** (migration **0004**, schema version 4, tested from
    every earlier version plus a version-3 store with data): `files.hands`
    / `files.quarantined` (the writer adds a batch's new hands; quarantine
    rows by triggers), `source_totals` (per folder, kept by triggers on
    `files`, so moves, detaches and adoptions carry their counts),
    `source_days` (hands per folder per local day; `set_source_path`
    recounts today's row of the folders involved), `files_source_idx` now
    `(source_id, last_import_at)`. `Reader::sources` reads them;
    `Reader::sources_recounted` is the old join, and every store test's
    integrity check (the crash test's included) asserts the rollups equal
    the rows. **`Watcher::status()`**: 42.7 ms at 90 000 hands before
    (R1.5's per-folder join, linear in hands; ~0.5 s at a million), now
    **0.04-0.06 ms during a 500k-hand import, a few µs idle**.
    `Store::status()` (the Today tiles, every 5 s) still counts:
    0.8 ms at 100k, 9.5 ms at 500k - fine; R2.9 may roll it up too.
  - **Progress** (`rail-watch`): per folder a *run* lasts while any of its
    files is queued or being read; it counts the bytes to read (size minus
    the stored offset when a file is queued - the store's offsets are read
    once per walk, only when needed), bytes committed, files, hands and
    its start. A run of at least 1 MiB is reported (`BACKFILL_MIN_BYTES`;
    a hand being played never is): `SourceStatus::backfill: Option<Backfill
    { bytes_done, bytes_total, files_done, files_total, hands, started_at
    }>` and `WatchEvent::Progress` (at most every 200 ms; `None` when it
    ends). Tested on the real watcher (`tests/backfill.rs`): totals equal
    the files' sizes and count, monotonic, ends, every file read.
  - **Found on Linux CI, fixed** (the backfill test hung on
    `ubuntu-latest` only: 229 of 312 files read, then nothing): inotify
    reports every open and read-only close, the watcher's own reads among
    them, and R1.3's reader opened a **read-whole file (iPoker) on every
    look, even unchanged** (the "first bytes still the same?" check ran
    before the unchanged check). Each look's open woke the watcher for the
    same file, at the front of the new queue: two iPoker files took both
    import threads forever and the rest of the backfill starved.
    Reproduced on macOS by injecting an open event per read; fixed twice:
    an unchanged read-whole file is decided from the metadata without
    opening it (`reader_edges.rs::an_unchanged_file_is_not_opened`, which
    takes read permission away - it failed before), and the watcher
    ignores access events other than a close after writing (`notify`'s
    inotify mask includes `OPEN` / `CLOSE_NOWRITE`; FSEvents and
    ReadDirectoryChangesW report no opens). `WatcherStatus` now also says
    how many files are queued and being read, and the backfill test prints
    them if a backfill does not end.
  - **Found on Linux CI, fixed** (2026-10-13; the backfill test read
    `Some(309 of 312 files)` on the status right after the end event): not
    a second end of a live backfill - nothing can revive a run once it is
    `None` - but **the end reported before the status showed it**. The
    coordinator emitted `Progress { None }` from the read's answer and
    wrote the status (`publish`, at most every 200 ms) at the end of the
    loop turn, so a status read in between still showed the last
    published progress; the tray reads `status` on events and could keep
    "Importing 98%" until something else changed. Now an end is queued
    and reported by `publish` **after** the status is written (ends
    before new progress, and flushed on stop): a status read on any event
    shows what the event says, or later. Tested deterministically
    (`watcher::tests`: the coordinator driven by hand, each event recorded
    with the status at that moment - red before) and on the real watcher
    (`tests/backfill.rs`: the status checked at once on the end, which the
    test's sink holds for 100 ms - 10 / 10 red before, the CI values
    exactly; one end, nothing of that backfill after it, every file read;
    `RAIL_WATCH_THREADS` picks the import threads).
  - **App**: `watcher_status` carries each folder's backfill with the time
    left at the pace so far (`secondsLeft`, computed in Rust); the tray's
    line reads "Importing 37% · 12345 hands" (`strings.rs`, en + hr) while
    a backfill runs; the tray thread emits `watcher-changed` (at most once
    a second) and the window reloads on it (`useWatcherStatus`, with a
    5 s fallback; was a 3 s poll). Today's folder table and each folder
    card show a progress bar, MB and files of the totals, hands so far and
    the time left (`components/BackfillProgress.tsx`).
  - **Refused hands** (`quarantine.rs`, commands `quarantine_summary`,
    `quarantine_entries`, `quarantine_raw_text`, `retry_refused`):
    every refused hand opens its raw text in a dialog (monospace,
    selectable, "Copy the text"; `components/RawTextDialog.tsx`); Settings
    gains **Refused hands** (`RefusedAll.tsx`): app-wide count, reasons
    with counts as buttons, a reason's 200 most recent hands. **"Try again
    after an update"** (per folder and app-wide; shown with how many hands
    and files): `WriterHandle::reset_stale_refusals` resets, in one
    transaction, the files of watched folders holding a refusal whose
    parser (`detected_site`) has another version in this build (the
    versions go to SQLite as JSON, `json_each`) - offset 0, their
    quarantine rows deleted, as a room change does - and the watcher reads
    them again at once (`Command::Reread`). A refusal by no parser
    (version `0`) or by a parser this build lacks is not stale. Tested in
    the store and on the watcher (an "older" version read again and
    refused anew by today's). Strings `en` + `hr`. Checked in a browser
    against a mocked IPC with made-up data (Today with a backfill, folder
    card, refused hands, raw text dialog, the app-wide view, retry).
  - **Benchmark** (`core/rail-watch/examples/import_bench/`): builds a
    **generated** dataset in a temp directory (labelled `GENERATED.md`,
    Spotlight off, removed afterwards; never committed): every corpus
    file the core turns into hands whose hand-id digit runs (4+ digits)
    can be rewritten - copy *c* maps the digits 1-9 through a seeded
    permutation (0 fixed, lengths kept, a bijection, so ids stay distinct)
    and the first copy must convert into as many hands and refusals as the
    original with none of its keys - minus files whose hands another kept
    file holds (the corpus repeats some), so hands converted = hands
    stored: **431 of 556 files, all 19 parsers** (71 have no hands, 17 ids
    cannot be rewritten, 37 repeat). Copies are written with an mtime a
    day back (a backfill; no quiet period). Then an empty store, the real
    `Watcher`, "import everything" on the folder, timed until every file
    is committed to its end. Measured on the owner's **M2 Pro** (10 cores,
    release build, with the flop-library solver busy on 2 cores and
    Spotlight running): **100k hands (6 034 files, 126 MiB): 10 300
    hands/s with the default 8 threads, 6 650 with 3, ~3 900 with R1.3's 2
    workers before**; **500k (29 739 files, 621 MiB): 9 170 hands/s, 54 s;
    database 1.51 GB, ~3.18 KB per hand** (WAL 21 MB before the closing
    checkpoint). One thread converts ~2 250 hands/s: the core's parse and
    detection are ~65 % of it, canonical JSON + zstd ~19 %, waiting for
    the commit ~10 %. A 1M-hand run was not done on the laptop (owner at
    work); at ~3.2 KB per hand it is ~3.2 GB.
  - **The target and the CI gate.** The guideline's **>= 5 000 hands/s**
    is about a user's machine: met on the owner's M2 Pro, **10 300
    hands/s** (100k, default 8 threads). CI's `macos-latest` is an
    **Apple M1 (Virtual) with 3 cores and 7 GB**; with 3 import threads
    (every core: the writer, the coordinator and the threads share them)
    it measured **3 926 and 4 615 hands/s** (first PR run, which failed a
    5 000 gate) and **4 782 and 5 264** (second run) - 100k hands, release
    build, the first run of each pair with cold caches. Making 3 vCPUs
    clear 5 000 with margin would take ~+25 % per hand: the measurable
    cheap levers are small (zstd level 1: +2-3 %, +3 % store size - not
    taken); the rest is the core's detection and parsing (~65 % of a
    hand), out of scope for a no-behaviour-change step.
  - **The CI gate is a ratio** (since 2026-10-13, after R1.6). R1.6
    first gated `import-bench` on **best of three >= 3 500 hands
    stored/s**, calibrated on the two runs above. The runner's speed moves
    more than that from job to job: the best of three on code that did not
    touch the import path was **3 907, 4 317, 4 666** (passes) and
    **3 436** (3 244 / 3 276 / 3 436, R1.7's PR: a fail on runner noise),
    and single runs went from 2 954 to 4 666 within one job. The
    benchmark now measures a **reference on the same runner**: one thread
    converting the corpus templates (copy 0 of the dataset, 7 321 hands)
    from memory with `rail_core`, no store, no watcher, ~3 s, once before
    the first import and again after every import; a run's reference is
    the mean of the passes around it. The gate is the **pipeline
    efficiency** = hands stored/s / (reference x import threads), best of
    three runs, **>= 45 %**, plus an **absolute floor of 1 500 hands
    stored/s**. Measured on the runner (this PR's jobs, 3 threads): the
    reference itself swings **1 621 - 3 205 hands/s** within a job (a
    shared VM's speed moves within seconds; hence a pass on each side of
    an import); per-run efficiency **36 - 67 %**; **best of three 67 %
    (import 3 339), 59 % (4 071), 62 % (3 584)** - two of those jobs
    would have failed or barely passed the old gate; the ratio sits 14-22
    points above its gate. 45 % is ~24 % under the lowest
    best of three: a pipeline regression of that size (reading, the
    writer, the store, the watcher) fails it on any runner speed. What
    the ratio cannot see is a slower `rail_core` (it slows the reference
    too): the floor catches a catastrophic one, and the reference rate is
    printed in every run (`RUN ... reference=`) to compare across jobs.
    On the owner's M2 Pro, busy with the flop-library solver, the same
    measure gave a reference of **1 790 - 2 210 hands/s** and **31-34 %**
    with 8 threads (E-cores and the solver share them; the ratio is
    calibrated per runner, not comparable across machines).
  - **For R1.8 / R1.9**: a 500k backfill puts 500k rows in `outbox` in
    ~1 minute; `outbox_due` reads oldest first, so the sync worker drains
    backfill and live hands in arrival order - send live hands (recent
    `imported_at`, or a separate priority) first if the HUD's web view
    should not wait behind a backfill; batch by ~500 and gzip as planned;
    the rate limit must allow ~500k hands in reasonable time (R1.8's
    desktop limit). `Imported` events carry `inserted` per commit, and a
    large file now reports one event per group of batches, not per file.
  - **For R2.9** (1M-hand benchmark database): reuse
    `import_bench/dataset.rs` (generated, rewritten ids, labelled, never
    committed); also rewrite player names if per-player rollups need
    realistic cardinality (ids only today). Store size will be ~3.2 GB at
    1M; `Store::status()`'s `count(*)` grows linearly (9.5 ms at 500k) -
    roll it up if reports need it; a nightly job can run `--hands 1000000`
    (about 2 minutes on 8 threads).

### R1.7 Desktop sign-in — M
- Web page `/auth/desktop` (A6): signs in as usual, then redirects to
  `rail://auth/callback?code=…`; the app exchanges the code with PKCE.
- Tokens in the OS keychain (`keyring`); refresh in the background; sign-out.
- The app works offline after the first sign-in. Whether it may be used with no
  account at all is open question Q3.
- Supabase redirect allow-list gets the new page; Google enabled (P7).
- *As built* (§15):
  - **Design: an encrypted one-time token, not a code exchange.** The app
    makes a fresh **X25519 key pair and a 32-byte `state`** per sign-in, in
    memory only, for ten minutes, and opens
    `<web>/auth/desktop?v=1&pub=<public key>&state=<state>&t=<unix time>` in
    the default browser. The page (`frontend/src/app/auth/desktop/`, strings
    in `lib/i18n/ns/desktop.*.ts`) has the user sign in as on the web
    (Turnstile, password managers, Google), shows "Sign in to the Rail app
    on this computer with this account?" with the account's email, and on
    the click calls the Edge Function **`desktop-handoff`**
    (`supabase/functions/desktop-handoff/`, Deno, WebCrypto only, no
    third-party code) with the user's access token. The function verifies
    the token with GoTrue (`GET /auth/v1/user`), refuses anonymous,
    email-less and **unconfirmed** accounts (a magic link confirms its
    address), spends one unit of the per-account budget
    `claim_desktop_sign_in()` (migration `20270421090000`, 10 an hour, called
    **as the user**), mints a one-time magic-link token with the runtime's
    service role (`admin/generate_link`, nothing emailed), checks it is for
    the same user id, and returns it **sealed to `pub`** (ephemeral X25519,
    HKDF-SHA-256, AES-256-GCM, `state` as associated data;
    `rail-desktop-handoff/1`, `core/rail-sync/src/auth/handoff.rs` and
    `handoff.ts`, one shared test vector). The page redirects to
    `rail://auth/callback?state=..&payload=..`; the app checks `state`,
    decrypts, and redeems the token at `POST /auth/v1/verify`, which gives it
    **a session of its own** (its own refresh-token chain; the browser's
    refresh token never reaches the app - copying it would make GoTrue's
    reuse detection end both). A6's "PKCE" is realised by the key pair: the
    secret that proves the caller is the app that started the flow never
    leaves the app, as with a PKCE verifier, and nothing in the link is
    usable without it.
  - **Why not the alternatives.** Supabase's own PKCE flow exists only for
    OAuth providers and email links, not for "hand this browser's session to
    another client", and a `rail://` redirect from GoTrue would carry an
    authorisation code any program registered for `rail` could redeem
    (GoTrue's PKCE verifier would then sit in the browser, not the app). A
    code table plus a redeem RPC (code in the link, verifier at redemption)
    is equally safe but needs a table with cleanup and an **unauthenticated**
    redeem endpoint holding the service role, plus the same `generate_link`
    call; the sealed payload needs neither: one authenticated endpoint, no
    server state beyond the rate-limit counter.
  - **Threats.** *Interception* (another program registered for `rail`): it
    gets ciphertext it cannot open; a second app instance's own sign-in has
    a different key and state (checked end to end). *Replay*: the app takes
    its pending sign-in out at the first callback with the right `state`,
    whatever the outcome, so a link works once; GoTrue's token is
    single-use too (checked: a second `/verify` is refused); the page marks
    a state used, so a reload cannot send it again. *Lifetime*: the key pair
    lives ten minutes in the app's memory (Rail restarted = the link finds
    nothing); the page refuses a request older than ten minutes (same
    machine, same clock). *CSRF / silent approval*: the function needs the
    user's bearer token (no cookie, so another origin cannot call it as the
    user), and the page never approves on load - a program that opens the
    page with its own key still needs the user's click, and the page says
    which account and to continue only if they just chose Sign in in Rail.
    The page can only be framed by its own origin (`frame-ancestors 'self'`)
    and sends no referrer. *Login CSRF* (a program that reads the address
    bar's `pub` and `state` could seal a token for its own account to them):
    needs code running as the user on that machine already; Settings and
    Today show which account is signed in. *Token storage*: the refresh
    token, user id and email are one keychain entry (`keyring` =3.6.3; macOS
    Keychain, Windows Credential Manager; service `app.rail.desktop`,
    account `session@<Supabase host>`, so a debug build against a local
    stack never touches the real entry); the access token stays in memory;
    tokens are `Secret` values whose `Debug` prints nothing; the function
    logs outcome codes only; all Supabase calls are made from Rust, never
    from the webview. A keychain that refuses still signs in for the run
    (the notice says so). *Abuse*: 10 handoffs an hour per account.
  - **App** (`app/src-tauri/src/account.rs`): `tauri-plugin-deep-link`
    =2.4.10 (the last release for tauri 2.10/2.11; 2.5+ needs 2.12) registers
    `rail` (`plugins.deep-link` in `tauri.conf.json`: the macOS bundle's
    Info.plist, the Windows installer, and at run time on Windows/Linux);
    `tauri-plugin-single-instance` gains its `deep-link` feature, so a link
    that starts a second process (Windows) arrives in the running one; only
    `rail://auth/...` is acted on. `open` =5.3.3 opens the browser. Commands
    `account_status`, `account_sign_in`, `account_open_sign_in_page`,
    `account_cancel_sign_in`, `account_sign_out`; event `account-changed`;
    a second, disabled tray line ("Signed in as ...", "Not signed in",
    "Working offline"). Window: Settings → Account (sign in, waiting with a
    countdown, open the page again, cancel, signed in / offline, sign out,
    each notice), the first-run screen's step 1 (the same panel plus "Use
    offline"; Q3 stays open, so nothing requires an account), a line on
    Today. Strings `en` + `hr`.
  - **`rail-sync`** (`core/rail-sync/src/auth/`): `handoff` (key pair,
    state, URL, strict callback parsing, decryption; `ring` for HKDF / AES-GCM
    / randomness, `x25519-dalek` =2.0.1), `gotrue` (verify, refresh, logout
    with `scope=local`: reqwest =0.13.5 with rustls =0.23.45 on the *ring*
    provider - not aws-lc-rs - and the OS certificate verifier; no
    redirects followed), `account` (the manager: one sign-in at a time,
    refresh five minutes before expiry on the monotonic clock, backoff 30 s
    doubling to 10 min while offline, signed out with a notice when GoTrue
    refuses the refresh token, the refresh token rewritten to the keychain
    as soon as it rotates, refresh / sign-in / sign-out serialised so a
    refresh token is never sent twice). Configuration: `RAIL_SUPABASE_URL`
    and `RAIL_WEB_URL` (default production), `RAIL_SUPABASE_ANON_KEY` (no
    default: a build without it is "not configured" and works offline),
    compiled in with `option_env!`; a debug build also reads them at run
    time.
  - **Tests.** Rust: 32 in `rail-sync` (handoff: tampering, wrong key, wrong
    state, low-order point, content, strict callbacks, the Deno-made vector;
    the manager against a fake GoTrue: completion, wrong state, no sign-in
    in progress, cancel, verify refused / offline, another user's session,
    rotation, refused refresh, offline, sign-out with and without an access
    token, restore from the store, another project's entry ignored, broken
    keychain, ten-minute timeout and the refresh loop on paused time), plus
    the app's config and tray strings. Deno: 17 (`deno test
    supabase/functions/`: payload round trip, tampering, the vector byte for
    byte, request validation, the handler against a fake GoTrue - no JWT,
    bad JWT, malformed body, unconfirmed / anonymous / email-less, budget,
    a token for another account, CORS preflight, logs without secrets).
    pgTAP: `desktop_sign_in.test.sql`, 14. CI: new job `functions` (Deno
    fmt, lint, check, test; no secrets). **End to end, locally**
    (`supabase/functions/desktop-handoff/e2e.sh <workdir>`: an isolated
    stack with the function served, a fresh confirmed user, then
    `cargo run -p rail-sync --example desktop_sign_in_e2e`): no JWT and a
    forged JWT refused, the app signed in as the web user with its own
    session, the link useless to a second app instance and spent after one
    use, the one-time token refused the second time, refreshing the app and
    the browser in turn ends neither, signing the app out ends only its
    session, the eleventh handoff in an hour refused - all passed. The web
    page was driven in a browser against the same stack (sign in with the
    captcha test key, confirm, the `rail://` link's payload opened with the
    test key; reload = "already sent", old `t` = "expired", malformed =
    "incomplete", cancel), and the app's panels against a mocked IPC. Not
    done here: a bundled app receiving a real `rail://` link (macOS routes
    links to bundled apps only; no `tauri build` locally) - try it on the
    CI bundle once production has the function.
  - **Local-stack pitfall.** The repository's `supabase/.temp/gotrue-version`
    pins the linked project's GoTrue (v2.187.0); with CLI 2.75's local keys
    (an ES256 signing key beside the legacy HS256 service key) that GoTrue
    refuses the service-role key on every admin call ("signing method HS256
    is invalid"), so `generate_link` fails. Delete `.temp` in the stack's
    copy (the CLI's default GoTrue, v2.186.0, accepts both). The same keys
    are why the function runs with `verify_jwt = false`: the gateway's
    legacy check rejects ES256 user tokens.
  - **Needs the owner (production, not done here; all of it is in the Phase 1 production checklist under R1.10):**
    1. Apply migration `20270421090000_desktop_sign_in.sql` (Management API,
       `docs/DATABASE.md`); the client types in this PR already list
       `claim_desktop_sign_in`.
    2. Deploy the function: `supabase functions deploy desktop-handoff
       --project-ref riybwcfnclphacnfawiq --no-verify-jwt` (no secrets to
       set: it uses the runtime's `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
       `SUPABASE_SERVICE_ROLE_KEY`).
    3. Deploy the web (`/auth/desktop` reaches production with the next
       promotion of `staging` to `main`).
    4. Build the app with `RAIL_SUPABASE_ANON_KEY` = the public anon key
       (the same value as Vercel's `NEXT_PUBLIC_SUPABASE_ANON_KEY`): a
       repository **variable** (Settings, Secrets and variables, Actions,
       Variables; not a secret). The CI `app` job already passes
       `vars.RAIL_SUPABASE_ANON_KEY` to the build, so PR bundles sign in once
       it is set (empty until then: "not configured"); the release workflow
       (§12) must pass it too.
       When the domain (P2/Q2) is chosen, set `RAIL_WEB_URL` too.
    5. Redirect allow-list: **nothing new** - GoTrue never redirects to
       `rail://` (the page does), and `/auth/callback?next=/auth/desktop` is
       covered by the existing `https://poker-hand-converter.vercel.app/**`
       entry. Add the domain's `/auth/callback**` when P2 lands.
    6. Turnstile: nothing new (the page is on the web domain the widget
       already allows).
    7. Optional: Google (P7) - the page offers whatever the web's sign-in
       dialog offers.
    8. Before turning email confirmation on (Resend domain), note that the
       function refuses unconfirmed accounts: users signed in unconfirmed
       (`mailer_allow_unverified_email_sign_ins`) must confirm before the
       app can sign in.
  - **For R1.8 / R1.9**: take the bearer token from
    `Account::access_token()` (refreshes when under 30 s remain; `None` when
    signed out or offline - then keep the outbox and retry later); never
    cache it across calls. A `401` from PostgREST means the session was
    revoked: call `Account::refresh()`, which signs the app out (with a
    notice) when GoTrue refuses. The account's id is in `AccountStatus`
    (`userId`); the server takes the owner from `auth.uid()` anyway. Sync
    only while signed in; signing out should stop the worker, and signing
    in as another account must not send the previous account's outbox
    (tag outbox rows with the user id or clear them on account change).

### R1.8 Supabase for desktop ingest — M
- Migrations: `hand_sources`; `ingest_hands(rows jsonb)` (invoker; insert …
  on conflict do nothing; returns per-row status); a desktop-sized rate limit
  next to `ingest_rate_limit` (a 500k-hand backfill must not trip the web's
  limit); the storage decision from A5.
- `hand_stats` rows go through the existing `save_hand_stats`.
- pgTAP: another user's rows can be neither read nor collided with; replays are
  no-ops; the rate limit holds.
- *As built* (§15):
  - **Owner decisions applied.** Q4: a desktop hand is **PHF + per-seat stats
    only** - no `standard_text` (derived on demand), no `source_text`, and
    `meta.rawText` sent empty (the originals stay on the user's disk).
    Q3: the app works offline without an account; an account is needed only
    for sync. Both written into the guideline (§4, §6) and §14.
  - **Schema** (migration `20270428090000_desktop_ingest.sql`, additive):
    `hands.origin` (`web` / `desktop`, default `web`, metadata-only add);
    `standard_text` nullable, and a CHECK for every writer
    (`hands_text_by_origin`): a web row has its standard text, a desktop
    row has no standard text, no source text and an empty `meta.rawText`;
    `hands_desktop_phf_size` (256 KiB). The insert policy now also requires
    `origin = 'web'`, so the direct path (`save_hands`, PostgREST) cannot
    write a desktop row; the statement trigger's global `hands_insert`
    budget counts web rows only. New `hand_sources` (kind `folder` / `web`,
    owner, device id and name, the app's local id, a label - **no path**, a
    label with `/` or `\` is refused - site, received / inserted / duplicate
    / rejected counters, last rejection, last ingest), RLS select-own, no
    client write grant; `register_hand_source(device, local id, name,
    label, site)` (definer, idempotent per account+device+folder, 120 calls
    / 10 min, 200 sources per account).
  - **`ingest_hands(p_source uuid, p_rows jsonb)`** - `security definer`,
    not invoker as first planned: desktop rows may only be written here, and
    the source counters have no client UPDATE grant; inside, the owner is
    `auth.uid()` (explicit, and again by the trigger), the source must be the
    caller's (the same 23503 for "unknown" and "not yours"), the budget is
    spent first, every row is validated before one `insert ... on conflict
    (owner_id, hand_key) do nothing`. Rows are `{hand_key, phf}`; at most 500
    and 8 MiB per call (22023). Result: `{received, inserted, duplicates,
    rejected, rows[i]: {handKey, status, reason?, field?}}` in input order;
    statuses `inserted` / `duplicate` (also a repeat inside the batch, and a
    hand already uploaded on the web) / `rejected` with `shape`, `schema`
    (not `phf/1`), `hand-key` (not `site:id`, or not the PHF's own),
    `raw-text`, `too-large` (256 KiB), `invalid` + the column (`field`) whose
    `hands` rule the derived row breaks. A bad row is rejected alone; the
    good rows of the batch go in.
  - **The search columns are derived on the server.** `hand_row_from_phf`
    is the SQL twin of the web's `handInsertFromPhf` (with
    `detectAnonymization`, `handClass`, `formatAmount` for `stakes_label`,
    `primaryBoard`, `totalFees`); `hand_row_problem` mirrors the `hands`
    CHECKs so one bad hand cannot fail the batch's insert. Chosen over "the
    client sends the columns and the server checks them" because checking
    needs the same derivation anyway, it makes every desktop row's columns a
    function of its PHF whichever client sent it (as `fast_fold` already
    is), it keeps a third copy of the mapping out of Rust, and a later
    column is a migration + backfill from `phf`, not an app release. Held
    together by a **parity test**: `npm run desktop-ingest:parity` (tests/,
    against a local stack) saves every corpus hand through `save_hands` with
    the TypeScript row and through `ingest_hands` with only its PHF, in one
    rolled-back transaction, and compares every column - **7 496 distinct
    hands (8 422, 926 keys repeated across files): 0 differences, 0
    rejected**. `npm run desktop-ingest:fixture` writes 37 of them (each
    parser's smallest hand plus positional / opaque / short-deck ante-only /
    run-it-twice / tournament / Omaha / fixed2 / chips / no hero / fast fold
    / split pot / ...) into `supabase/tests/database/desktop_ingest_parity.test.sql`,
    which CI runs. Derivation costs ~0.28 ms a hand.
  - **Rate limits.** Desktop rows no longer spend the global `hands_insert`
    (25 000 / 10 min for everyone - a 500k backfill would hold it for three
    hours). Per account, charged for every row received (duplicates and
    rejections too): **`desktop_ingest:<uid>` 150 000 / 10 min** and
    **`desktop_ingest_day:<uid>` 2 000 000 / day**; 53400 (HTTP 500 from
    PostgREST) when over. Measured locally: 500 hands a call in ~0.86 s
    (median), ~410 hands/s from one client, so the 10-minute bucket is what
    binds a backfill: **500k hands >= 34 min, 1M >= 67 min**. The daily cap
    bounds one account at ~7 GB a day. No global desktop bucket: every call
    from every account would queue on one counter row.
  - **Every web reader of a desktop row** (checked): `getHand` →
    `toHandRecord` (owner; the replayer parses `standardText`), `read_share`
    → `lib/server/shares.ts` (`/h/[slug]`, `/embed/h/[slug]`, unfurls) and
    `lib/db/shares.ts` → `shareClient.ts`: all now go through
    `storedStandardText(stored, phf)` (`lib/db/mapping.ts`), which renders
    the PHF when the row has no text (a share's redacted PHF lacks
    `meta.rawText`; it is put back empty). `create_share` stores only the
    hand id for a stored hand - unchanged. Published hands (`publish_hand`,
    `scrub_phf`), analysis (`hands_needing_*`, `lib/analysis`), stats
    (`hands_needing_stats`, `/api/stats/rebuild`, `lib/stats`) and Learn read
    `phf` only; `search_hands` / `hands_facets` read the search columns;
    there is no export of stored hands' standard text on the web today (the
    converter's download serializes its own hands). Text fidelity: with
    `meta.rawText` empty, `toStandardText` cannot read GG's presentation off
    the source, so **220 of 8 422 corpus hands** (214 GG, 5 PokerStars, 1
    `standard`) render differently from the stored web text (trailing space
    on blank `Dealt to` lines, the replayed header, `SHOW DOWN`, fee
    columns); **all 8 422 read back** as the same hand (`parseHand`). The
    desktop keeps the full PHF locally for byte-exact export.
  - **Stats.** `save_hand_stats` (invoker, resolves `hand_key` under RLS)
    attaches to desktop rows; `hands_needing_stats` sees them (`hero_seat`
    is derived), so `/api/stats/rebuild` derives their stats from the PHF
    exactly as for web rows - nothing to change until R2.1 (pgTAP).
  - **Rust** (`rail_sync::ingest`): `IngestRow::from_outbox` (the store's
    canonical PHF → compact JSON with `meta.rawText` emptied; 256 KiB cap),
    `Batch` (500 hands / 4 MiB of JSON, `Batch::split`), `IngestClient`
    (`register_source`, `ingest`, and `*_as(&impl TokenSource)`: a fresh
    token from `Account::access_token()` per call, one `Account::refresh()`
    and retry after a 401, `SignedOut` when the refresh is refused),
    `IngestReport` (`stored_keys()`, `rejections()`), `IngestError`
    (`SignedOut`, `Unauthorized`, `RateLimited`, `UnknownSource`,
    `Refused{status, code}`, `Transient`). **gzip request bodies do not
    work**: PostgREST answers `PGRST102` (checked); bodies go uncompressed.
  - **Tests.** pgTAP `desktop_ingest.test.sql` (51: grants and definer
    settings, `hand_sources` sealed, anon / no-uid refusals, idempotent
    registration, no path labels, replays are duplicates and store nothing,
    counters, another account can neither read nor collide nor use the
    source, every rejection reason in one mixed batch, the text rule from
    every writer, budget per account and per day, a refused call writes
    nothing, the web's global budget untouched, stats) and the generated
    parity file (40); full suite 29 files / 980 tests green on a fresh
    reset. Rust: 14 new in `rail-sync` (46), including a scripted HTTP
    server for the 401 → refresh → retry path. Vitest `desktopRows.test.ts`
    (owner and share text over the GG and sample corpora). **End to end**
    (`cargo run -p rail-sync --example desktop_ingest_e2e`, an isolated
    local stack, two fresh users): 522 corpus files imported with
    `rail-store` (7 469 hands), the outbox drained through the real
    `Account` and `IngestClient` - 16 calls, 18 s, 0 rejected, outbox
    empty; a replay all duplicates; the second account's same hands all
    inserted, each account sees only its own; the second account refused on
    the first's source.
  - **Needs the owner (production, not done here; all of it is in the Phase 1 production checklist under R1.10):**
    1. Apply `20270428090000_desktop_ingest.sql` through the Management API
       (`docs/DATABASE.md`, "Applying a migration"); the client types in this
       PR already have `origin`, `hand_sources` and the two RPCs.
    2. Run the isolation checks (`docs/DATABASE.md`, "Verifying the
       isolation") plus: a direct `insert` of an `origin = 'desktop'` row with
       a user JWT is refused (42501); `ingest_hands` from the anon key is
       refused (401).
    3. Deploy the web with the next promotion of `staging` to `main`
       (`storedStandardText`) **before** any app syncs to production (R1.9);
       until then no desktop row exists and nothing changes for the web.
- **For R1.9**: drain `outbox_due` → `IngestRow::from_outbox` → `Batch::split`
  → `ingest_as(&account, &source, &batch)`; mark `stored_keys()` sent, keep
  `rejections()` out of the outbox with their reason (resending cannot help),
  treat `Transient` with backoff, `RateLimited` by waiting (windows of 10
  minutes and a day; the budget is charged for the whole call, so do not
  shrink batches to squeeze in), `UnknownSource` by registering the folder
  again (`register_source_as` is idempotent; keep the id per folder in
  `kv`), `SignedOut` by stopping until the next sign-in, `Refused` as a bug
  (log, do not loop). Register each watched folder with a random
  per-installation device id and the local `sources.id`; the label is the
  room plus the folder's last component, never a path. **Bandwidth**: a hand
  is ~7.5 KB of JSON on the wire (canonical PHF keeps every action's
  `rawLine`), so a 500k backfill uploads ~3.7 GB; with gzip refused by
  PostgREST, the play-time bandwidth cap matters, and if it is too much an
  Edge Function that accepts gzip and calls the RPC as the user is the next
  step. Pull: web rows are `origin = 'web'` (no `hand_sources` link per
  hand); key the cursor on `(created_at, id)`.

### R1.9 Sync worker — M
- Outbox → batches (e.g. 500 hands, gzip) → `ingest_hands`; exponential backoff;
  resumable; bandwidth cap during play; status in the UI.
- Pull: hands that arrived through the web (`hand_sources.kind = 'web'`) are
  fetched by keyset cursor and imported locally, so the app and the web show the
  same hands.
- **Done when** the Phase 1 exit check passes, including after a network cut
  mid-batch.
- *As built* (§15):
  - **Worker** (`rail_sync::worker`, `SyncWorker` + `SyncTask::run` on the
    app's async runtime). One pass: the account, the store's owner, push,
    pull. **Send order** (`Reader::outbox_next`, store migration 0005): the
    hands queued in the last 15 minutes first, **newest played first**
    (`outbox.played_at`, copied at enqueue; covering index
    `outbox_recent_idx`) - so a hand just played goes out before a backfill
    queued in the same minutes (its hands were played earlier) and is never
    behind a backlog; then the rest, oldest due first (`outbox_due_idx`).
    A round sends up to 500 hands of the first hand's folder (one
    `hand_sources` row per watched folder and account, registered on first
    use - device id a random v4 UUID in `kv` `sync.device`, device name from
    the OS (`scutil --get ComputerName`, `COMPUTERNAME`), label room plus the
    folder's last component, never a path; `unfiled` for hands whose file is
    in no folder - and remembered in `kv` `sync.source.<user>.<folder>`).
  - **Outcomes.** `inserted` / `duplicate`: out of the outbox, `synced_at`
    set. `rejected`: out of the outbox into the new table `sync_rejected`
    with reason and field (resending cannot help); counted per reason in
    Settings → Account, queued again only by "Try again" (after an update).
    A hand that cannot be sent at all (unreadable, over 256 KiB) the same,
    reason `unreadable` / `too-large`. **Transient** (no network, timeout,
    5xx, unreadable answer): the batch's hands count an attempt and wait
    (`outbox.attempts`, `next_attempt_at`), the worker waits too - 5 s
    doubling to 10 min with equal jitter; the phase is `offline`, not an
    error. **RateLimited**: `IngestError::RateLimited { window }` now says
    which budget from the server's message (`desktop_ingest:` 10 minutes,
    `desktop_ingest_day:` a day); no attempt counted (a refused call costs
    nothing, it rolls back); wait 1 min doubling to 10 min (an hour for the
    day), then one hand as a probe before full batches. **401**: one refresh
    and retry (R1.8's `with_token`); still 401 is `failed` with backoff.
    `UnknownSource`: forget the id, register again (twice, then backoff).
    `Refused` (a bug): the hands wait an hour, the rest goes on, logged -
    never a loop. **Resumable**: everything that matters is in the store;
    the worker can be killed anywhere. **Idempotent**: a resent batch is
    duplicates; a crash between the server's commit and ours costs one
    resend.
  - **Bandwidth.** While more than 2 000 hands wait (a backfill), uploads are
    paced (`Pacer`: after b bytes the next send waits b / cap) to the user's
    cap - Settings → Account "Upload speed while a large backlog syncs",
    256 KB/s, **1 MB/s (default)**, 4 MB/s or none, in `kv` `sync.cap`. The
    Phase 3 hook `SyncWorker::set_tables_open(true)` lowers it to at most
    256 KiB/s. Hands queued in the last minutes wait at most one pacing
    interval (~3.5 s for a full batch at 1 MB/s). **Measured** (end to end
    below, local stack, debug build of the client on a loaded M2 Pro, no
    cap): **~270 hands/s, ~2 MB/s, 7 541 B of JSON a hand on the wire**
    (the canonical PHF keeps every action's `rawLine`). The server's budget
    (150 000 / 10 min = 250 hands/s sustained) binds before the client; a
    500k backfill needs ~35 min at the budget and ~1 h at the default 1 MB/s
    cap (~3.7 GB). PostgREST refuses gzip (R1.8): if the volume is too much,
    the next step is an Edge Function that takes a gzip body and calls
    `ingest_hands` as the user (not built).
  - **Accounts.** The store's hands belong to one account, `kv`
    `sync.owner` (`{userId, email}`): the first that signs in (a store
    filled offline syncs to it, Q3). Every call takes its token from
    `Account::access_token_for(owner)` (new): `None` unless that account is
    the one signed in, checked under the session's lock, so an outbox can
    never reach another account - not even if the account changes between
    two calls. **Signed out: nothing is sent** (`signedOut`). **Signed in as
    another account**: nothing is sent *or pulled*; the phase is
    `accountMismatch {ownerEmail, email, localHands}` and Settings asks
    "Upload them to <new> too?" - *Upload*: the new account becomes the
    owner and every hand from this computer's files is queued again
    (`sync_set_owner(.., requeue)`: in import order, synced marks cleared,
    refused hands retried; pulled hands - the old account's library - are
    not uploaded); *Keep them apart*: `declined` (`kv` `sync.declined`),
    nothing syncs while that account is signed in, with "Upload them
    instead" to change the answer. Signing back in as the owner continues.
    Source ids and pull cursors are per account.
  - **Pull - decided: every row of the account the store lacks, not only
    `origin = 'web'`.** "The app and the web show the same hands" means the
    account's library: hands saved on the web *and* hands synced from the
    account's other computers (a HUD on the laptop should know the hands
    played on the desktop). Which device sent a row is not recorded per hand
    (R1.8 kept `hand_sources` to counters), so the pull reads the whole
    account, **keys first**: `hands_since(p_after_created, p_after_id,
    p_limit)` (migration `20270505090000_desktop_pull.sql`, invoker, the
    caller's rows by keyset `(created_at, id)`, `id, created_at, hand_key,
    origin` only, ~150 B a row, index `hands_owner_created_idx`), then
    `GET /rest/v1/hands?select=hand_key,phf&id=in.(..)` (plain RLS, 100 ids a
    call) for the keys the store lacks; each PHF is read into `PhfHand`,
    canonicalised and stored with `hands.pulled_at` (store migration 0005),
    `synced_at` set, no file, **no outbox entry**; the local `hand_key`
    dedupe applies. Page and cursor (`kv` `sync.pull.<user>`) commit in one
    transaction, so a crash re-reads at most a page. A device's own uploads
    cost it ~150 B each to recognise. Rows younger than **one minute** are
    not returned: `created_at` is the inserting transaction's start, a later
    starter can commit first, and every client write runs under PostgREST's
    8 s `statement_timeout`, so a settled cursor cannot skip a row. Every 5
    minutes and on "Sync now". A hand whose PHF this build cannot read is
    skipped and counted (`pullSkipped`).
  - **App.** `app/src-tauri/src/sync.rs`: the worker starts in `setup` after
    the store and the account (none without an account configuration:
    "sync off"); every import with new hands wakes it (the watcher's
    callback through a `OnceLock` slot), every account change wakes it
    (`account::changed`); on exit it stops first with the watcher and lets
    go of the store's writer. Commands `sync_status` (`null` when off),
    `sync_now`, `sync_set_paused` (in `kv` `sync.paused`, survives a
    restart), `sync_set_cap`, `sync_answer_account`, `sync_retry_rejected`;
    event `sync-changed` (at most once a second). Window: Settings → Account
    gets a Sync part (`SyncPanel`: signed out / syncing N of M with speed
    and the cap in force / up to date with the last sync / offline / paused
    / rate limited / failed; the account question; refused hands per
    reason with Try again; Sync now, Pause sync, the cap), Today a line
    under the account line, the tray a third line ("Syncing 120 of 4000
    hands", "Synced: up to date", "Offline · 12 hands wait to sync", ...).
    Strings `en` + `hr`.
  - **Tests.** `rail-store` (`tests/sync.rs`, 5 + 1 ignored measurement):
    send order across both tiers, retries, refused hands and Try again, an
    account change (requeue, pulled hands left out), pulled hands stored
    once with their cursor and never queued, migration 5 from a version-4
    store with queued hands; the migration test from every version covers
    5. Measured with 1 000 000 queued hands, half in the window (release, a
    loaded machine, cold pages): the recent tier 0.3-0.7 s, the backlog tier
    and the counts 0.25-0.5 s; an ordinary outbox takes milliseconds.
    `rail-sync` (63 tests): 13 new worker tests against a scripted PostgREST
    (batching under one registered source, newest played first, offline
    backoff and resume, a 503 and a lost answer - each hand once on the
    server, a spent budget then a one-hand probe, 401 then refresh, refused
    hands kept and not resent then Try again, account change (signed out,
    another account asked, keep apart, back to the owner, upload), pause
    across a restart, an unknown source registered again, the pull (missing
    PHF only, no outbox, cursor resumed)), plus the pacer, backoff, labels,
    device ids, the status JSON, `access_token_for`, the rate-limit windows.
    pgTAP `desktop_pull.test.sql` (17): invoker and grants, columns (no
    PHF), refusals, keyset pages visit every settled row once in order (a
    tie on `created_at` included), desktop and web rows, never another
    account's, a fresh row hidden then found after the cursor once it
    settles, the page size clamped; full suite 30 files / 997 tests on a
    fresh stack; `database.types.ts` regenerated. App: tray lines, device
    name.
  - **End to end** (`cargo run -p rail-sync --example sync_e2e`, an
    isolated local stack `rail-r19-sync` on ports 5592x, two fresh users;
    run 2026-10-13, all passed):
    1. *Kill and resume*: the corpus (522 files, 7 469 hands) imported; a
       child process running the real worker was **killed (SIGKILL) with
       1 500 hands on the server**; a new worker on the same store sent the
       other 5 969 in 22 s (269 hands/s, ~2 MB/s; ~500 resent as
       duplicates); **server = store, 7 469 hands, each once**.
    2. **The Phase 1 exit check**: a watched folder, `rail-watch` and the
       worker for B behind a TCP proxy; a session of 58 hands (file 28, hand
       ids rewritten - generated) written into a file one hand every 0.5 s;
       after hand 20 the network was **cut mid-batch** (requests forwarded,
       answers dropped: 4 answers lost after the server committed) and
       restored after hand 32. **Append to visible through PostgREST as B:
       min 541 ms, median 703 ms, max 5.9 s** (the hands written during the
       cut; the rest under a second - most of it the reader's 500 ms quiet
       period); **58 hands on the server, each once**; the same file copied
       again changed nothing, locally or on the server.
    3. *Pull*: a hand saved on the web as A (`save_hands`) reached an empty
       second store with all 7 470 of A's hands in 15 s, nothing queued; the
       first store fetched only that hand's PHF.
  - **Phase 1's exit criterion is met** on a local stack: hands from a new
    session reach Supabase with no manual step, each within a minute
    (seconds), exactly once, through a network cut mid-batch and a killed
    process, and the same file imported twice changes nothing. What
    remains of Phase 1: **R1.10** (the web refreshes live through Realtime;
    today a reload shows the hands), and the production steps below (no
    app has synced to production yet). Not done here: a bundled app synced
    against production; a 500k-hand backfill end to end (the store's send
    order is measured at 1M; the budget arithmetic is above).
  - **Needs the owner (production, not done here; all of it is in the Phase 1 production checklist under R1.10):**
    1. Everything still open under R1.7 and R1.8 *As built* (the R1.8
       migration, the `desktop-handoff` function, the web's
       `storedStandardText` promoted **before** any app syncs, the anon key
       in the build).
    2. Apply `20270505090000_desktop_pull.sql` through the Management API
       (`docs/DATABASE.md`, "Applying a migration"); it builds
       `hands_owner_created_idx` on `hands` (a few thousand rows today: a
       moment's write lock). The client types in this PR already have
       `hands_since`.
    3. Check (as two users): `hands_since()` returns only the caller's rows
       and nothing from the anon key (401 / 42501).
- **For R1.10**: the web's `/library` and `/stats` should subscribe to the
  user's own `hands` inserts (Realtime under RLS); desktop rows arrive in
  bursts of up to 500 per `ingest_hands` call, so debounce the refresh
  (say 1-2 s) rather than refetching per row, and remember a desktop row
  has no `standard_text` (`storedStandardText`). `hand_sources` (counters,
  `last_ingest_at`) is a cheap "a device is syncing" signal for the web.
  The pull's settle minute does not apply to Realtime.

### R1.10 Live arrival on the web — S
- `/library` and `/stats` subscribe through Realtime to the user's own new rows
  and refresh; RLS applies to Realtime as well.
- *As built* (§15):
  - **Decided: a signal table, not `hands` in the publication.** Postgres
    Changes on `hands` would send whole rows - the PHF (~2.9 KB, up to
    256 KiB) and a web row's texts - so a 500-hand batch is ~2 MB to every
    open tab, to say "refresh"; a column list on the publication does not
    help (Realtime reads the slot through wal2json's `add-tables`, which
    ignores column lists); and every insert, a 500 000-hand backfill
    included, would be decoded and checked against RLS per subscriber per
    row. Migration `20270512090000_hand_arrivals.sql`: **`hand_arrivals`**,
    one row per account (`id` a random uuid primary key, `owner_id` unique,
    `seq`, `hands`, `origin`, `arrived_at`), upserted by the statement-level
    trigger **`hands_signal_arrival`** (after insert on `hands`, after the
    rate-limit trigger, from the transition table; definer, empty
    `search_path`, not executable by clients; a failure is swallowed so a
    signal never fails a save). One `ingest_hands` call or one `save_hands`
    call = **one change of ~320 bytes**, whatever its size; a call of
    duplicates only = none. RLS select-own; in `supabase_realtime`;
    `hands` is not.
  - **Privacy (measured, not assumed).** Realtime re-reads every INSERT and
    UPDATE as the subscriber, so a forged filter (`owner_id=eq.<B>`) or no
    filter at all delivers only the subscriber's own row. Two findings on
    the way: (1) a role **without SELECT** on the table is not run through
    RLS but sent a content-free `"Error 401: Unauthorized"` notice for every
    change - an anonymous socket would learn *when* anybody stores hands -
    so `anon` has SELECT and no policy (reads zero rows; Realtime sends it
    nothing). `notifications` has the same exposure today (no anon grant);
    noted in `docs/DATABASE.md`, not changed here. (2) DELETE changes cannot
    be checked by RLS and go to every unfiltered DELETE listener with the
    primary key: the only delete is an account's removal (cascade), and the
    key is a random uuid, not the owner.
  - **Web.** `lib/live/arrivals.ts` (pure, no framework): signals become a
    refetch **1.5 s after the last one**; a burst that never goes quiet
    still refreshes after **5 s**, and each refresh forced that way doubles
    the next wait to at most **30 s** (a long backfill costs a refetch every
    30 s, never one per batch), reset by the first quiet flush; **nothing
    while the tab is hidden**, one refetch when shown; a reconnect after an
    error, a timeout or a close is a resync signal.
    `components/live/useHandArrivals.ts`: the user's token on the socket
    before the join (the bell's rule), INSERT + UPDATE on `hand_arrivals`
    filtered `owner_id=eq.<uid>`, channel removed on unmount, sign-out or
    another account. `AppFrame` takes `live` (true for `/library` and
    `/stats` only; never `/convert`) and passes the latest batch down; the
    hand count chip follows. **`/library`**: on the first page the list and
    its count re-read in place, quietly (no loading state; a failed quiet
    read keeps the rows); past the first page the rows stay and a "N new
    hands - show" button appears (to the first page when sorted newest
    first). "Hands arriving from <device>" under the heading from
    `hand_sources.last_ingest_at` (`latestDesktopSync`, select-own), for ten
    minutes after the last sync. **`/stats`**: a batch re-reads coverage and
    the numbers without "Loading..." and, when hands lack statistics, runs
    `/api/stats/rebuild` - no click; one catch-up at a time, batches landing
    during one fold into one more round. Strings `en` + `hr`, CSS module
    `live.module.css`.
  - **Tests.** pgTAP `hand_arrivals.test.sql` (29); full suite 31 files /
    1 026 on a fresh reset; `database.types.ts` regenerated. Vitest
    `liveArrivals.test.ts` (12: debounce, a burst folded, max wait, the
    5/10/20/30 s back-off and its reset, hidden then shown, resync, dispose,
    the payload reader). **Realtime end to end**, `npm run
    realtime:arrivals` (`tests/scripts/realtime-arrivals/check.mjs`, local
    stacks only): 15 / 15 on an isolated stack (`rail-r110-live`, ports
    5612x) - A's own subscription gets exactly one change per call (INSERT
    500 desktop, then UPDATE 1 web; none for a replay of duplicates), A
    with B's filter gets nothing, A unfiltered only A's, B only B's, anon
    nothing; the first change ~0.1-0.3 s after the call returns; payloads
    322 / 359 bytes; B's deletion shows an unfiltered listener only a random
    id. **Browser** (signed in as A against the same stack, `next dev`):
    `/stats` went from 500 to 2 000 hands with statistics derived and the
    chip from 501 to 2 001 while 3 x 500 hands came in for A and 2 x 300
    for B (B's never counted); `/library` page 1 updated in place (2 001 to
    3 001, B's 200 not counted) with "Hands arriving from Test MacBook"; on
    page 2, "500 new hands - show" took the reader to page 1 with 3 501;
    four batches over 10 s while the tab reported hidden cost no request,
    then exactly one refresh (search + count) when shown.
  - **Phase 1 is complete on `staging`** (R1.1-R1.10; the exit criterion
    met on a local stack in R1.9). Nothing of R1.7-R1.10 is in production
    yet.
- **Phase 1 production checklist (R1.7-R1.10; needs the owner, not done by
  any step).** It replaces the lists under R1.7, R1.8 and R1.9 *As built*.
  In this order:
  1. **Migrations**, through the Management API (`docs/DATABASE.md`,
     "Applying a migration"; first list what production already has and
     apply every missing one in filename order - at least these four):
     `20270421090000_desktop_sign_in.sql` (R1.7),
     `20270428090000_desktop_ingest.sql` (R1.8),
     `20270505090000_desktop_pull.sql` (R1.9; builds
     `hands_owner_created_idx` on `hands`, a moment's write lock at today's
     size), `20270512090000_hand_arrivals.sql` (R1.10; a statement trigger
     on `hands`, `hand_arrivals` added to `supabase_realtime`). The client
     types on `staging` already have all of them.
  2. **Edge Function**: `supabase functions deploy desktop-handoff
     --project-ref riybwcfnclphacnfawiq --no-verify-jwt` (no secrets to
     set; it uses the runtime's `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`).
  3. **Checks as two real users** (never the PAT): the isolation checks of
     `docs/DATABASE.md` ("Verifying the isolation"); a direct `insert` of an
     `origin = 'desktop'` row with a user JWT is refused (42501);
     `ingest_hands` and `hands_since` from the anon key are refused (401 /
     42501); `hands_since()` returns only the caller's rows;
     `select tablename from pg_publication_tables where pubname =
     'supabase_realtime'` lists `notifications` and `hand_arrivals` and
     **not `hands`**; as A on `/library` in one browser, B saving a hand in
     another changes nothing for A, and A saving one in a second tab
     updates the first within ~2 s. (`npm run realtime:arrivals` refuses
     non-local URLs on purpose: it creates and deletes users.)
  4. **Promote `staging` to `main`** (the web: `/auth/desktop`,
     `storedStandardText`, live arrival) - **after** step 1 and **before**
     any app syncs to production. Without the R1.10 migration the web still
     works (the subscription never fires, the sync line stays hidden).
  5. **Build variable**: the repository variable `RAIL_SUPABASE_ANON_KEY` =
     the public anon key (Settings, Secrets and variables, Actions,
     Variables; not a secret); the CI `app` job already passes it, the
     release workflow (§12) must too. `RAIL_WEB_URL` once the domain (P2/Q2)
     is chosen.
  6. **Auth settings**: nothing new for the redirect allow-list or
     Turnstile (R1.7); when the domain lands, add its `/auth/callback**`.
     Before turning email confirmation on (Resend domain): the handoff
     refuses unconfirmed accounts, so users signed in unconfirmed must
     confirm before the app can sign in. Optional: Google (P7).
  7. **Realtime**: nothing to configure (already on for `notifications`).
     Optional and separate: `grant select on public.notifications to anon`
     closes the 401-notice exposure found in R1.10 (`docs/DATABASE.md`,
     "Notifications and realtime") - as a migration on `staging` first.
  8. **First real sync**: a bundled app from CI against production, a small
     folder first - hands appear on `/library` live, statistics are derived
     on `/stats`, the account's budget (150 000 / 10 min) is not hit.

---

## Phase 2 — Statistics and interface

**Goal.** The app is a full tracker without the HUD.

**Exit.** The performance targets (guideline §1) hold on a 1M-hand benchmark
database, on the development Mac and on a mid-range Windows laptop.

### R2.1 Stats engine in Rust — L
- Port `lib/stats` (`handFacts`, preflop, postflop, showdown, money, mapping)
  to `rail-stats`; goldens of `StatsRow[]` per hand from the TS engine; the
  invariants in `tests/test/support/statsInvariants.ts` as Rust property tests.
- **Done when** the rows are identical to TS for every corpus hand.
- *As built* (§15): **done** - 8 422 of 8 422 corpus hands, 51 464 of 51 464
  rows (every dealt-in seat, hero and villains) equal to the TypeScript's,
  byte for byte in canonical JSON.
  - **Oracle.** `npm run golden:emit` also writes the stats goldens
    (`tests/scripts/golden/stats.ts`, format `rail-stats-golden/1`,
    [`testdata/golden/README.md`](../testdata/golden/README.md) "Stats
    goldens"): per corpus file, per hand the sha-256 of the canonical JSON of
    `statsRows(handFacts(phf))` and its seats, per file every counter and
    money column summed (zeros left out) so a change of meaning reads in
    review as "this counter moved here". Derived from the PHF as the golden
    stores it (canonical JSON parsed back), which is what the Rust test reads
    from `testdata/golden-full/`. Committed `testdata/golden-stats/` 3.3 MB;
    the rows in full, `testdata/golden-stats-full/` (gitignored), 206 MB - the
    R0.3 size decision again. `golden-fresh` checks both committed trees; the
    emitter run is still ~22 s (the canonical writer's key sort got an ASCII
    fast path: the same order without encoding UTF-8 for strings that hold no
    surrogate). **No float in any row**: the canonical writer refuses one and
    none was found; the engine divides in doubles in three places
    (`net_bb_milli`, `starting_stack_bb_tenths`, the largest-remainder fee
    split) and always lands on integers. `-0` (a loss under half a thousandth
    of a big blind; a fee share of a negative fee total) is written as 0:
    none in the corpus.
  - **`core/rail-stats`**, module for module (`counters`, `context`,
    `preflop`, `postflop`, `showdown`, `money`, `derive`, `mapping`):
    `rows_for(&PhfHand) -> Vec<StatsRow>`, `hand_facts(&PhfHand) ->
    HandFacts`, `stats_rows`, `StatsRow::to_json` (exactly the 133 columns of
    `STATS_COLUMNS`), `Counter` (the 90 counters as an enum, column order =
    `ZERO_COUNTERS`), `SeatCounters` (`[u32; 90]` indexed by `Counter`, what a
    rollup sums), `SeatMoney` (`i64` minor units), `OPPORTUNITY_PAIRS` /
    `LEG_SETS` / `STREET_CHAINS`, `STATS_VERSION` (`stats/2`), `hand_class`,
    `to_bb_milli`. Integer arithmetic; the three divisions in
    `rail_core::js::JsNumber`, the fee split's sort in `js::sort::sort_by`
    with the TypeScript's comparator. `BTreeMap`s only (no hasher; builds for
    `wasm32`, now in CI's WebAssembly build). Nothing is wired into the app.
  - **Tests**: the golden diff (`tests/corpus.rs`; names the differing
    columns when `testdata/golden-stats-full/` is present); the eight
    invariants of `statsInvariants.ts` over every corpus hand, the round trip
    through `to_standard_text` / `parse_standard_hand` included; the 17 spot
    fixtures with every expectation of `statsSpots.test.ts`, its four corpus
    spots (gross collects, run it twice, EV cashout, bomb pot), the short-deck
    spots of `shortDeck.test.ts` and `statsPotType.test.ts` (`tests/spots.rs`);
    4 000 seeded mutations of golden hands through both engines
    (`tests/data/stats-vectors.mjs` - dropped, swapped, duplicated and
    retyped actions, nulled positions so the engine runs `assignPositions`,
    re-seated and removed players, odd and zero blinds, other variants,
    unreconciled fees and pots, cut and doubled runouts, button-blind verbs,
    off-pot chips, cashouts; `tests/vectors.rs`), all equal, and a 50 000-case
    soak (`STATS_STRESS`) equal too; the column lists and `STATS_VERSION`
    read from `types.ts` / `mapping.ts` (`tests/columns.rs`).
  - **Oddities reproduced, not fixed** (`docs/STATS-SPEC.md` §12): the
    TypeScript's `assignPositions` mutates the caller's hand (the port works
    on a copy, same rows); two players on one seat number give two rows for
    that seat, both the last player's; `leg` counts a `bet` as the raise leg;
    `limp_opp` is any first unraised decision that is not a check (a fold or
    a raise included); `flop_seen` and the street chain read the board and
    every action's street, so a stray action on a street makes it "dealt";
    `dealtInSeats` falls back to every seated player when fewer than two
    acted; `hand_key` lower-cases and trims the site id while `site_id` keeps
    it as is; `cashed_out` is set by any non-zero cashout risk, negative
    included; the fee split ranks fractional parts as doubles, so two parts a
    double cannot tell apart tie to the lower index. `docs/STATS-SPEC.md` said
    `stats/1` in its title; now `stats/2`, with the version table.
  - **For R2.3 (rollups)**: sum `SeatCounters.0` and the `SeatMoney` columns
    per player and segment; `HandDimensions` carries every filter column
    (`is_bomb_pot`, `has_cashout` for `aggregate`'s default exclusions in
    `rates.ts`, `pot_type`, `position` on the seat). `rates.ts` (`aggregate`,
    `rates`, `addCounters`) is not ported yet. Which rows a writer keeps (the web
    writes hero rows only unless villain rows are on, never villains of a
    positionally anonymised room - `lib/db/statsRows.ts`) is the writer's
    decision, not the engine's. **For R2.4**: a display definition's formula
    names counters by column name - `Counter::from_name` and `COUNTER_KEYS`.
    **For R2.2**: `hand_stats` has no EV column; `handEvRow` falls back to
    `net` / `net_bb_milli` for a hand without an all-in and computes
    `ev_net_bb_milli` with `toBbMilli` - `rail_stats::to_bb_milli`, exact.

### R2.2 All-in EV in Rust — M
- Port `lib/equity`; same seeds, same results; the Monte Carlo path must match
  TS exactly or within a documented tolerance agreed in the PR.
- The evaluator (`evaluator.ts`, `omaha.ts`) is already `rail_core::eval`
  (R0.5b); this step adds enumeration, Monte Carlo, ranges and multiway pots
  on top of it.
- *As built* (§15): **done** - every corpus hand's stored row and full
  analysis equal to the TypeScript's: **8 121 / 8 121** `hand_stats_ev` rows
  (every hand with a hero; 498 applicable), **8 422 / 8 422** analyses (508
  all-ins: 226 preflop enumerations, 11 Omaha preflop Monte Carlo, 147 flop,
  124 turn; 1 short deck; 22 hi/lo declined), every equity bit for bit. No
  tolerance anywhere, Monte Carlo included.
  - **Exact representation.** The enumeration is integers: each board's pot
    is `UNIT = 27720` (lcm 1..12), a tie of `k` gives each `UNIT / k`, and a
    player's share of a pot is `units / (boards * UNIT)` exactly
    (`EquityResult::units`, `EvPot::equity_units`, `AllInEv::denominator`) -
    the same integers the TypeScript accumulates in doubles, where they are
    exact too (below 2^53 for any request under 3.2e11 boards). The
    TypeScript leaves the integers once, `acc / (boards * UNIT)`, and from
    then on computes in doubles: the pot split (`apportion`: the equities
    summed, `w * |amount| / sum`, `floor`, the fractional parts and the
    largest-remainder order), range weights (`0.5`, `per = weight /
    runouts`, the running sums), the sampler's `random() * sum`. The port
    performs each of those IEEE-754 operations in `rail_core::js::JsNumber`
    (correctly rounded, integer arithmetic), in the TypeScript's order, so
    the doubles - and every share derived from them - are the TypeScript's.
    Exact rationals instead would differ from the TypeScript wherever double
    rounding decides a largest-remainder tie; emulating the doubles cannot.
    `ev_net` is an integer (sums of shares); `ev_net_bb_milli` is
    `rail_stats::to_bb_milli` (R2.1, exact).
  - **Monte Carlo exactly.** `Mulberry32` is the TypeScript PRNG in 32-bit
    integer arithmetic, `Math.floor(random() * n)` is `(u * n) >> 32`
    (exact for `n < 2^21`), and the partial Fisher-Yates over the stub is the
    TypeScript's step for step, so a seeded run samples the same boards.
    Omaha preflop (the corpus's 11 cases, and 234 + 610 sampled vector
    cases) matches exactly.
  - **`core/rail-equity`**: `enumerate` (`equity`, `plan`, `EquityRequest`
    / `EquityOptions` / `EquityResult`, `EquityInputError` with the
    TypeScript's messages, `Mulberry32`, `hole_cards_for`, `table_for`),
    `range` (`parse_range`, `ClassWeights` in `Map` order, `class_combos`,
    `all_classes`, `range_combos`, `range_share`, `strongest_of_range`,
    `equity_vs_range`), `multiway` (`equity_vs_ranges`), `all_in`
    (`analyze_all_in`, `all_in_ev`, `ev_net_by_seat`, `apportion`,
    `AllInEvOutcome::to_json` - the golden's shape), `row` (`ev_row`,
    `ev_row_for`, `EvRow`). Builds on `rail_core::eval`; the only change
    there is `#[inline]` on `evaluate_masks`, `evaluate_omaha_masks` and
    three table accessors (no behaviour change, every rail-core vector
    green), so the hot path compiles at rail-equity's optimisation level -
    the workspace's dev profile now builds rail-equity at `opt-level = 3`
    (debug assertions and overflow checks stay on); unoptimised, its corpus
    test took 150 s, now ~20 s. Depends on rail-stats only for `ev_row`
    (the hero's `StatsRow`, `to_bb_milli`). Builds for `wasm32` (CI's
    WebAssembly build). Nothing wired into the app.
  - **Oracle.** `npm run golden:emit` also writes `testdata/golden-ev/`
    (`tests/scripts/golden/ev.ts`, format `rail-ev-golden/1`,
    [`testdata/golden/README.md`](../testdata/golden/README.md) "All-in EV
    goldens"): per hand the hero's row as the web writes it (`handEvRow` of
    the first hero row of `handStatsRows`, null without a hero) and
    `analyzeAllIn` with the default options, equities as `String(x)`, both
    hashed, plus the skip reason in clear and per-file outcome counts and row
    totals; 3.1 MB committed, 5.5 MB in full in the gitignored
    `testdata/golden-ev-full/`; `golden-fresh` checks it. The emitter now
    runs ~70 s instead of ~20 s: every all-in is computed twice (the
    analysis, then `handEvRow`), 226 of them preflop enumerations at ~50 ms
    in Node.
  - **Tests**: the golden diff and `equityCorpus.test.ts`'s identities on
    every applicable hand (Σ evNet = Σ net from rail-stats, one evNet per
    stats seat, every pot paid out exactly, equities summing to 1 - exactly,
    as rationals) and on the corpus outside `fixtures/samples/` with its
    sampled options (`tests/corpus.rs`); `equityEnumerate`,
    `equityAllInEv`, `equityRange` translated, with the `analyzeAllIn`
    checks R2.1 left in `shortDeck` (the 36-card turn all-in, GG's fixture
    12 flipping favourite under the other rule) and `phfHiLo` (every
    converted hi/lo hand declined) (`tests/enumerate.rs`, `all_in.rs`,
    `range.rs`); 4 500 seeded vectors through both engines
    (`tests/data/ev-vectors.mjs`, `tests/vectors.rs`): 1 500 mutated golden
    hands (analysis with random options, and the row with the defaults; 664
    applicable, 234 sampled), 1 500 `equity()`/`plan()` requests (every
    game, side pots, both short-deck rules, bad cards and indices; 610
    sampled, 311 refused) and 1 500 range cases (`parseRange` over token
    junk, `rangeShare`, `equityVsRange`, `equityVsRanges`,
    `strongestOfRange`), all equal; a 45 000-case soak (`EV_STRESS`) equal
    too. Not translated: `equityRange`'s "parses every placeholder range
    the analysis falls back to" (reads `lib/analysis`, not ported).
  - **Performance** (release, M2 Pro, per all-in, the corpus's): heads-up
    preflop enumeration (1.7M boards) 25 ms mean, 44 ms worst; 3-way
    preflop 46 ms; Omaha preflop Monte Carlo (20 000 boards) 15 ms
    heads-up, 21 ms 3-way; flop 0.2 ms; turn 0.03 ms; a hand without an
    all-in 0.03 ms. The TypeScript: ~50 ms heads-up preflop. Preflop
    all-ins are the whole cost: 2.7 % of the corpus's hands (more than a
    typical player's history, which is mostly hands without a shown
    all-in), and at that rate a 100 000-hand backfill would spend ~70 s of
    CPU on EV - ~8 s of wall time over the import threads, next to ~10 s
    for the import itself at 10 300 hands/s. Fine for live hands (one
    all-in is 25 ms); for the backfill R2.3 should either run EV as its own
    background pass after the hands are in (as the web's rebuild does) or
    cache: a preflop matchup's equity depends only on the hands up to suit
    relabelling, so a cache keyed by the suit-canonical hands (and the
    short-deck rule) serves every repeat exactly.
  - **TypeScript oddities reproduced, not fixed**: `choose` in `range.ts`
    and `multiway.ts` has no guard, so a negative deck count (45+ dead
    cards) gives the generalized binomial and can make `"auto"` enumerate;
    `parseRange` ignores a third `:` part (`AQs:0.5:3` is half of AQs), and
    reading past the end of a token (`A`, `+`, `:0.5`) is a JavaScript
    `TypeError` there, `RangeError::Type` here; `apportion`'s `sign * part`
    can be `-0`, which every caller adds into a sum (no `-0` reaches a row);
    an all-in hand's row is `applicable` for every seat in the stream, a hero
    who folded before it included (`ev_net = -contributed`, as in GG's
    fixture 12); with two players on one seat, the seat's hole cards and
    name come from the first (`find`) and its stack from the last (`new
    Map`). Not
    reproducible, and refused instead: a `WeightedCombo` card index past 51
    (the TypeScript reads `undefined` out of its arrays; Rust says `not a
    card: N`). The Rust API takes `trials`, `seed` and `exhaustive_limit` as
    integers (`u64`, `u32`, `u64`), where the TypeScript coerces any number.
  - **For R2.3**: `rail_equity::ev_row(&hand, &hero_stats_row) -> EvRow`
    (or `ev_row_for(&hand)`, which derives the stats rows itself and takes
    the first hero row, as the web's rebuild does), `EvRow { hand_key, seat,
    ev_version, applicable, ev_net, ev_net_bb_milli }`, `EV_VERSION` =
    `"ev/1"`; `analyze_all_in(&hand, &EquityOptions::default())` for the
    replayer's pots and equities. Rows always use the default options.

### R2.3 Rollups and segments — M
- `player_rollups` maintained in the import transaction; a rebuild command
  (after a stats version bump); the segment definition from §3.4.
- *As built* (§15): **done** - local statistics in the store, written with
  every hand, rebuilt and completed in the background; every table in
  [`core/rail-store/SCHEMA.md`](../core/rail-store/SCHEMA.md) "Statistics".
  - **Schema** (store migration 6, tested from every earlier version):
    `segments`; `hand_stats` (per hand: the statistics' hand-level columns
    `hands` does not hold, `played_at` (indexed), the segment, the
    generation `gen`); `seat_stats` (per kept seat: name, scope, hero,
    position, cards, stacks, and the 90 counters + 7 money values as one
    blob, `encode_seat`: the non-zero values as varint pairs, ~15-40
    bytes); `player_rollups` (site, player, scope, segment); `hero_rollups`
    (segment, position, UTC day, kind); `ev_rows` (the hero's applicable
    all-in EV), `ev_pending` (the EV queue). `hand_stats` + `seat_stats` +
    `hands` give back the engine's `StatsRow`, all 133 columns, byte for
    byte in JSON for every corpus row (`tests/stats.rs`). **The first
    version mirrored the web's `hand_stats` column for column** (hand
    columns on every seat, a column per counter): +2 KB a hand (3 283 →
    5 297 bytes, +61 %) and 21-29 % fewer hands imported a second; the
    blob layout costs +590 bytes a hand (3 872, +18 %), `hand_stats`'s
    `played_at` index included. That index came from measuring: reading
    `played_at` from `hands` (whose rows hold the PHF) made a report's
    partial days take 6 s at 500k; from `hand_stats` they take 0.08 s.
  - **Segment** (`rail_stats::Segment`, pure, tested; §3.4): site key, game
    format, variant, limit, table-size class by `maxSeats` (`hu` 2, `6max`
    3-6, `full` 7+; the players when `maxSeats` < 2), stake = a cash game's
    currency and exact big blind in minor units (`USD:200`; every stake
    level its own bucket, coarser groupings are sums at query time), or
    `chips` for the tournament formats. The corpus has 191 segments.
  - **Rows and identities** (`rail_stats::stored_rows`, `rollup_scope`,
    `detect_anonymization` - the web's `detectAnonymization` ported):
    `handStatsRows`' rule - hero always, villains always on the desktop,
    never a villain of a positionally anonymised room (Ignition) - and one
    row per seat (two players on one seat: the first, as `save_hand_stats`'
    `on conflict do nothing`). **Opaque-id rooms** (GGPoker hashes, ACR/WPN
    mined ids): a token is one person within one session only
    (docs/DATABASE.md), so summing it across sessions would invent a
    person; such villains are summed per session, scope `<table>@<UTC
    day>` (the HUD computes the same scope for its table), which
    under-merges (a session past midnight UTC, a tournament table change)
    and never over-merges. Screen names and the hero: scope `''`. Corpus:
    6 541 / 34 632 hero / villain rows of `none` hands, 636 / 3 048
    `opaque-id`, 92 / 0 `positional`.
  - **Rollups** apply `aggregate`'s defaults (`rates.ts`): bomb pots out of
    `player_rollups` entirely, EV-cashout hands out of their money,
    `money_hands` counted (bb/100 divides by it). `hero_rollups` exclude
    nothing and keep a `kind` (bomb pot 1 | straddled 2 | cashout 4) in the
    key, so a report applies any of `aggregate`'s options exactly.
  - **Import path**: `PreparedHand::from_phf` derives `PreparedStats` (the
    kept rows with their scopes, the segment, the EV plan) on the import
    threads; the writer writes `hand_stats` + `seat_stats` in the hand's
    transaction and sums the rollup increments in memory per **group**
    (`writer::commit_group`: each batch's sums taken once its savepoint
    commits, added with one upsert per key before the commit). Duplicates
    add nothing (`tests/stats.rs`, files again under other names and pulled
    hands). The sync pull (`import_pulled`) writes them the same way. The
    crash test (R1.2) now also checks, after every kill, that the seat rows,
    EV rows and EV queue are exactly those of the stored hands and that both
    rollup tables equal the sums of the rows (`common::assert_rollups`,
    every column), and the final store equals a clean import, statistics
    included.
  - **Throughput: the import's pipeline efficiency is back where it was.**
    The first push lost it: CI's import benchmark (3 threads on the 3-vCPU
    macOS runner) measured **44 / 41 / 39 %** against **59-67 %** before
    R2.3, a failed gate. Profiled (`sample`, the writer thread), a third of
    the writer's busy time went to **SQLite's statement journal**: every
    import batch runs in a savepoint (R1.6), every page a savepoint first
    changes is copied to that journal, and past 64 KiB it is a temporary
    file - opened, written and closed per group of batches; R2.3's rows
    touch several times more pages per batch. Fixes: **`PRAGMA temp_store =
    MEMORY`** on the write connection (the journal stays in memory; a
    group's is a few MB), **`hand_stats` inserted with `execute` and
    `last_insert_rowid`** (its `RETURNING id` through `query_row` spent a
    third of the insert in the statement's reset), and the seat blob, the
    cards' text and the values summed computed on the import threads
    (`PreparedSeat`), so the writer only binds and adds. The rollups were
    already summed in memory per group of batches (one upsert per key and
    transaction). Local, 100k, 3 threads, interleaved, the owner's M2 Pro
    under load 7-9: **before R2.3 48 / 46 % (4 628 / 4 428 hands/s); the
    first push 42 / 41 % (4 175 / 3 857); now 48 / 48 % (4 687 / 4 741)**.
    The reference is unchanged (`rail_core`'s conversion only); the
    statistics' own cost on the import threads, 17-22 µs a hand (+3-6 % of
    the conversion), is printed beside it and counted against the
    pipeline, not hidden in the reference. Earlier measurements of the first
    push under heavier load (11-15): 8 threads 6 621 / 7 168 → 5 908 /
    6 335 hands/s; 500k 5 308 hands/s, database 1.84 GB (3 866 bytes a
    hand).
  - **All-in EV**: `rail_equity::ev_row_unless_preflop` (new, with
    `all_in_street`: the analysis's first checks only; the rows equal
    `ev_row`'s for every corpus hand) computes the hero's EV row at import
    unless the all-in was completed preflop; those (195 of the 7 321
    template hands; 13 265 of 497 809 at 500k, 2.7 %) wait in `ev_pending`.
    Only applicable rows are stored (438 of 7 269 corpus hero hands);
    another hero hand's row is `ev_net = net`, implied. **Background pass**
    (`rail_store::background`, `StatsWorker`): one thread; the rebuild
    first, then the EV queue newest first, 8 hands a transaction; paused
    while a backfill imports (`set_backfill`; the app tracks the watcher's
    backfill events and reconciles from its status) and its EV part while
    tables are open (`set_tables_open`, the HUD's hook); woken by imports;
    progress in `stats_status`. Measured at 500k (release, same load):
    **26-27 ms of computing per preflop all-in, ~2 150-2 250 a minute** -
    the 500k store's 13 265 take ~6 minutes of one core after the backfill. The
    exact preflop-matchup cache was measured and **not built**: the
    corpus's 226 exhaustive preflop all-ins have 182 distinct suit-canonical
    matchups, and the repeats are mostly the corpus's repeated files; at a
    real player's volume (~3 % of hands) repeats of a 47k-class space are
    rare, and Monte Carlo (Omaha) is not invariant under suit relabelling
    with a fixed seed anyway.
  - **Rebuild**: `begin_rebuild` (on open when `stats.version` is not this
    build's `STATS_VERSION`, e.g. a store from before R2.3; or
    `StatsWorker::rebuild_stats`, a debug button in Settings until R2.7)
    starts generation n+1 and empties the rollups; the pass derives every
    hand again from its stored PHF in `hand_key` order, 500 a transaction,
    the cursor in `kv` (resumable), skipping hands imported meanwhile
    (already counted). An EV row is kept unless the hero's seat or result
    changed. **6 100-6 950 hands/s at 500k** (one thread, release): 72-82 s
    for 500k. Tested: a rebuild reproduces the import exactly; imports
    during a rebuild count once; an older store (version 5 with hands) gets
    the same statistics as an import; "compute EV again" (`requeue_ev`, what
    an `EV_VERSION` bump does on open) queues every hero hand and the pass
    gives the same rows.
  - **Queries** (`rail_store::stats_read`): `hud_totals`, `player_rollup`,
    `player_rollups`, `hero_totals` (`HeroFilter`: segments, positions, UTC
    instants, `aggregate`'s options; whole days from `hero_rollups`, partial
    days and EV from the rows), `segments`, `stats_status`. Measured on the
    500k store with 300 000 made-up players added to `player_rollups` (the
    dataset rewrites ids, not names; `examples/stats_queries.rs`), release:
    **HUD lookup for 9 players: median 73 µs, p99 0.22-0.24 ms** (first
    call 0.6 ms; the table's segment or all the site's alike); one rollup
    6 µs; a player's segments 18 µs; **hero totals**: everything (470k hero
    hands, 241 segment-position groups) 127 ms, a date range with partial
    days at both ends 78 ms, 3 segments x 3 positions over a range 76 ms -
    the benchmark's days are 69 copies of the corpus's, so its partial days
    hold ~50 times a real day's hands; most of the 127 ms is the EV
    adjustment's ~29k lookups (stored rows and the queue); status 7 µs.
  - **App**: `rail-app` starts the pass after the store (`stats.rs`), the
    watcher wakes it and pauses it during backfills, it stops on exit
    before the store closes; commands `stats_status`, `stats_rebuild`,
    `stats_recompute_ev`; Settings shows a debug-only panel (status, two
    buttons; `en` + `hr`).
  - **For R2.4**: a definition's formula reads `Totals::get(Counter)` and
    `money_hands` (bb/100 = `net_bb_milli / 10 / money_hands`);
    `Counter::from_name` resolves names. **For R2.7**: reports by position
    and date are `hero_totals`; by situation (pot type, street, stack
    depth) scan the hero's `seat_stats` through `hand_stats_played_idx`
    and sum in Rust (`decode_seat`); a villain's profile by position needs
    a `seat_stats (player)` index or a per-position rollup (not built;
    measure its import cost); `players` is the next migration. **For R2.9**:
    rewrite player names in the benchmark dataset for real rollup
    cardinality (`stats_queries --pad` stands in); gate the HUD lookup and
    `hero_totals` at 1M. **For R3.7**: on `hand_imported`, `hud_totals(site,
    players, segments)` from the HUD's own read-only `Reader`; an opaque-id
    villain's scope is `session_scope(table, played_at)`; the HUD should
    call `StatsWorker::set_tables_open` (through the app) while it draws.
    **For R2.11** (targeted recompute, guideline §5 "ciljani preračun"):
    today a definition change rebuilds everything (~75 s at 500k); the
    generation mechanism works per hand, so a targeted pass can rebuild
    only the hands a changed counter can touch, or rewrite only the
    affected counters of each blob and roll them up again.

### R2.4 `config/stats/` display definitions — M
- Schema: id, name, short label, formula over counters (`3bet / 3bet_opp`),
  format (percent, bb/100), colour thresholds, minimum sample for full
  opacity, description. The starting set of ~30 (guideline §5).
- Same files read by the app (Rust) and the web (TS) — one source.
- *As built* (§15): **done** - displayed statistics are data; every shipped
  definition prints the web's number, digit for digit, over the corpus.
  [`docs/STATS-SPEC.md`](STATS-SPEC.md) §13 is the reference.
  - **Files**: `config/stats/standard.json` (32 definitions) and
    `config/stats/stats.schema.json` (draft 2020-12). A definition: `id`,
    `group` (preflop / postflop / showdown / results), `players` (`any`, or
    `hero` for all-in EV), `label` (the HUD's short label), `name`,
    `description` (each `{ en, hr }`), `formula`, `format` (`unit`: percent,
    bb_per_100, bb, ratio, count, money; `decimals` 0-6), `sample` (`of`, a
    formula, defaulting to a `pct`'s opportunities; `min`, full opacity from
    there), `bands` (ascending `below` thresholds -> a tone: very-low, low,
    normal, high, very-high - a position on a scale the app, the web and
    the HUD map to their theme), `hud` (default membership: panel, popup,
    none).
  - **Formula language**: numbers, counter names, `+ - * /`, unary minus,
    parentheses, `pct(made, opportunities)` (= `made * 100 /
    opportunities`, no value unless `opportunities > 0`, as `rates.ts`'s
    `pct`) and `sum(a, ...)`. Nothing else - no comparisons, no other
    functions; at most 1 000 bytes and 32 levels. Names: the 90 counters,
    the 7 money columns, `money_hands` (what bb/100 divides by) and
    `ev_net_bb_milli` (the hero's all-in-EV result; a definition reading it
    must say `players: hero`). **Evaluated as JavaScript evaluates it**:
    every operator one IEEE-754 double operation in the formula's order
    (`rail_core::js::JsNumber` in Rust - the workspace's no-float rule holds),
    so `pct(three_bet, three_bet_opp)` is `rates.ts`'s `(made * 100) / opp`
    bit for bit. Exact rationals were considered and rejected: the web
    prints doubles, and the order matters (`(23 * 100) / 80` prints "28.8",
    `(23 / 80) * 100` "28.7"). **Text** is what the web's
    `Intl.NumberFormat` prints at that many fraction digits - the shortest
    round-trip decimal rounded half away from zero - not `toFixed` (which
    rounds the exact binary value: `(-0.15).toFixed(1)` is "-0.1", the web
    prints "-0.2"; over the vectors' 5 000 format cases `toFixed` would
    differ 467 times). No value (`None` / `null`): division by zero, `pct`
    over nothing, a missing input, a non-finite result.
  - **Rust**: `rail_config::stats` (model, `formula` - tokenizer and
    recursive-descent parser with byte offsets in its errors -,
    `load_stats(text, Vocabulary)`: version, unique ids, names against the
    caller's vocabulary, hero-only names, `sample.of` required unless `pct`,
    ascending bands, non-empty strings, a count has no decimals;
    `SHIPPED_STATS`). The crate still does not depend on the core - the
    vocabulary comes from `rail_stats::display::vocabulary()`.
    `rail_stats::display`: `Display::shipped()` / `load` / `compile`,
    `DisplayStat::{value, rate, sample, full, text, tone, show}`, `Sums`
    (counters, money, `money_hands`, `ev_net_bb_milli`), `aggregate`
    (`rates.ts`'s, ported), `Formula` (one formula compiled - the R2.10
    editor's preview), `format_fixed`. `rail_store`: `Totals::sums()`,
    `HeroTotal::sums()` (with the EV result: `net_bb_milli` plus the
    adjustment of the evaluated all-ins). rail-stats now depends on
    rail-config; both still build for `wasm32`.
  - **TypeScript**: `frontend/src/lib/stats/display.ts` (pure: the same
    grammar, `parseFormula` with the Rust parser's error messages and
    offsets, `evaluate`, `showStat`, `statRate`, `statFull`, `formatFixed`,
    `compileStats`), `definitions.ts` (`STANDARD_STATS`, compiled at load;
    `localized(text, locale)`), `definitions.json` - a byte-for-byte copy
    of `config/stats/standard.json`, because the web builds from
    `frontend/` alone (a test fails when they differ).
  - **i18n**: a definition carries its own strings, `{ en, hr }` for
    `label`, `name` and `description`, rather than keys into `lib/i18n`:
    the HUD reads them in Rust without a JavaScript dictionary, the app and
    the web read the same words, and a user's own statistic (R2.10) carries
    what its author typed. The schema requires exactly the locales of the
    web's `LOCALES` and the app's `Locale`, and a test compares the three.
    The web's existing tile labels in `lib/i18n` stay (the screen did not
    change); R4.5 moves them to the definitions.
  - **Parity - Rust vs TypeScript vs `rates.ts`**:
    `core/rail-stats/tests/data/display-vectors.mjs` (esbuild over the web's
    modules, as R2.1's vectors) sums the corpus as reports do - 558 groups:
    every golden file's seats, every directory's seats and its hero's, every
    position's and game format's, the whole corpus's, with `aggregate`'s
    defaults - plus 600 seeded synthetic totals (rounding ties, empty
    samples, values up to 2^43, negative money, all-in EV), 33 formulas
    (parse, error message, values) and 5 000 format cases. Before it writes
    a case it checks the definition against the web: **33 582 values equal
    to `rates()`'s (`Object.is`)** wherever `rates()` has the statistic (29
    of the 32), **26 405 texts equal to `Intl.NumberFormat`'s**, and every
    format case equal to `Intl`. `cargo test -p rail-stats --test display`
    re-derives the corpus groups from `rail_stats` rows (the same totals,
    all 99 columns), then every statistic's value (bit for bit), text, tone,
    sample and opacity over every case: all equal. `tests/test/statDisplay.test.ts`
    replays the file in TypeScript (the TypeScript today shows what it
    showed; `rates()` agrees). `rail-store`'s `hero_totals_are_the_rows_sums`
    shows every statistic over `hero_totals` (all-in EV included) as over
    the engine's rows: equal. The 3 statistics `rates()` does not have
    (all-in EV bb/100, rake per 100, raise flop cbet) have no web number to
    match; raise cbet is the web tile's `raise_cbet_flop /
    fold_to_cbet_flop_opp`.
  - **One web change to make the numbers one**: the `/stats` tiles printed
    the Wilson interval's `(made / n) * 100`, the breakdown `rates()`'s
    `(made * 100) / n`; they disagreed on, e.g., 23 of 80 ("28.7" vs
    "28.8"). The tile now prints `(made * 100) / n`, the definitions'
    order. `HudGrid` reads every number from `STANDARD_STATS` (each tile's
    `made / opportunities` from its definition's `pct`, AF and AFq, bb/100
    and its 10 000-hand floor = the definition's `sample.min`, which
    replaces `WIN_RATE_SAMPLE_FLOOR`); nothing on the screen changes but
    that digit.
  - **CI rules**: `cargo test` - the shipped file loads (every formula's
    names are counters, ids unique, bands ascending; `rail_config` unit
    tests cover each refusal and the grammar), and the vectors were written
    from it (sha-256 of `standard.json` in their `meta`; stale vectors fail
    with the command to run). `npm test` in `tests/` - the schema (ajv) and
    15 refusals, `compileStats`' refusals, the web's copy, the locales, the
    parity replay, and **guideline §14 ("a new statistic is a definition in
    `config/stats/`")**: a scan of `frontend/src`, `app/src`,
    `app/src-tauri/src` and `hud/` (not `lib/stats`, the engine and
    reference) for the shapes a hard-coded statistic takes - a counter and
    its `_opp` on one line, a division by an `_opp` counter, `pct` imported
    from `lib/stats`, `net_bb_milli / 1000`, a `Counter::x` / `Counter::x_opp`
    pair. Honest about its limits: a grep, not a type system; a formula over
    several lines or behind another name passes. The files that match today
    are listed with their count and the list may only shrink -
    `BreakdownPanel.tsx` 6, `OpponentsPanel.tsx` 1 (both R4.5),
    `lib/learn/pool.ts` 8 (population data for Learn), `lib/db/analysis.ts`
    1 (villain inputs to a heuristic). `HudGrid.tsx` had 19; it reads the
    definitions now.
  - **For R2.5**: `sample.min` and the sample (`sample.of`, or the `pct`'s
    opportunities) are in every definition; `DisplayStat::rate` /
    `statRate` give `(made, opportunities)` of a `pct` for Wilson; `full`
    is today's binary opacity rule - R2.5 adds the interval and the
    dimming curve. The web's `confidenceOf` bands (±2 / ±6 pp) are
    presentation in `components/stats/uncertainty.ts`, not data yet.
    **For R2.7**: `Display::shipped()` over `Totals::sums()` /
    `HeroTotal::sums()`; reports by group (`def.group`), `players: hero`
    statistics only on the hero's reports; money needs the segment's
    currency minor units (`text(value, Some(minor))`). **For R2.10**: a
    user's statistic is a `StatDef` the editor builds; `parse_formula` gives
    errors with byte offsets for the editor to underline, `Formula::compile`
    + `eval` previews it; new opportunities need the predicate language
    over decision events (the names a formula can read are only today's
    counters). **For R2.11**: `Expr::names()` is the dependency map from a
    definition to its counters. **For R3.8**: `hud` gives the default panel
    (VPIP, PFR, 3B, F3B, CB, AFq) and popup; `label` is the panel's text,
    `tone` its colour, `full` its opacity; the HUD evaluates over
    `hud_totals(...)`'s `Totals::sums()` and may not show `players: hero`
    statistics for villains. **For R3.9**: a user's colour bands or HUD
    membership are an override layer keyed by `id` (`hud_layouts`), not
    edits to the shipped file.

### R2.5 Sample reliability — S
- Confidence interval per value (Wilson for rates) and the dimming rule from
  the definition; shown in tooltips, used by the HUD.
- *As built* (§15): **done** - every displayed value carries its
  reliability, computed identically in Rust and on the web.
  [`docs/STATS-SPEC.md`](STATS-SPEC.md) §13 "Reliability" is the reference.
  - **Model.** *Interval*: a `pct(made, opportunities)` gets the 95% Wilson
    score interval in percentage points (`z = 1.959964`, the web's constant;
    `z2 = z*z`, `centre = made + z2/2`, `spread = z*sqrt(made*(n-made)/n +
    z2/4)`, `low/high = ((centre -/+ spread)*100)/(n + z2)`, exactly 0 at
    `made = 0` and 100 at `made = n`, clamped; none unless `n > 0` and
    `0 <= made <= n`). Bounds printed at the definition's decimals
    (`format_fixed`). *No interval for other statistics*: bb/100 would need
    the per-hand variance and the store keeps sums, not sums of squares (an
    assumed SD shown as a "±" would be fabricated); AF is not a proportion.
    *Level* from the sample (`sample.of` or the rate's opportunities)
    against `sample.min`: `ok` from `min` (= R2.4's `full`; always when
    `min` is 0), `low` from `min / 4` (interval at most twice the width at
    `min`), `insufficient` below or with no sample. *Opacity*: 1 from `min`,
    else `0.6 + 0.4 * sqrt(sample / min)` (0.6 with no sample) - continuous,
    proportional to the precision, 1 where the level turns `ok`; 0.6 is the
    floor at which the web's large figures keep their contrast.
  - **Data.** Nothing new per statistic: `sample.min` (and `sample.of`) was
    already the only thing that varies; confidence (95%) and the curve are
    one rule for every statistic, so they are code, not a field nobody
    would set differently. The schema documents the rule and caps `min` at
    10^9 (`rail_config::stats::MAX_SAMPLE_MIN`, `compileStats`; ajv and
    `rail_config` tests refuse more) so `min` is an exact double everywhere.
  - **Exactness.** The same IEEE-754 double operations in the same order on
    both sides: TypeScript's numbers, Rust's `JsNumber`. `JsNumber` gained
    `sqrt` (`Math.sqrt` is correctly rounded by the ECMAScript spec): the
    53-bit significand widened by 72/73 bits to an even exponent,
    `u128::isqrt`, the remainder as the sticky bit, one rounding.
  - **Rust**: `rail_stats::reliability` (`wilson`, `sample_reliability`,
    `Level`, `Interval`, `WILSON_Z`, `OPACITY_FLOOR`);
    `DisplayStat::reliability(&Sums) -> Reliability { level, opacity,
    interval, interval_text }`, also in `Shown::reliability`.
    **TypeScript**: `frontend/src/lib/stats/reliability.ts` (pure; `wilson`,
    `sampleReliability`, constants), `statReliability` and
    `Shown.reliability` in `display.ts`, exported from `lib/stats`.
  - **Parity**: `core/rail-stats/tests/data/reliability-vectors.mjs` (no
    goldens needed: it reads display-vectors.json's 558 corpus groups and
    600 synthetic totals, `meta.inputs` pins their sha-256) writes every
    shipped statistic's level, opacity, bounds and bound texts over those
    1 158 cases (37 056 values, 20 677 intervals; 17 722 insufficient,
    4 593 low, 14 741 ok), 3 041 Wilson cases (n = 0, made = 0, made = n,
    made outside 0..n, -0, NaN, Infinity, fractions, 2^53, 2^61, 1e300,
    1e308, 3 000 seeded), 2 168 level/opacity cases and 3 921 `Math.sqrt`
    cases (seeded random bit patterns over every exponent, subnormals,
    perfect squares +/- 1, specials). Before writing, every interval is
    checked within 1e-9 points of `lib/analysis/reports.ts`'s independent
    textbook Wilson and every level against `full`. `cargo test -p
    rail-stats --test reliability` and `tests/test/statReliability.test.ts`
    replay: **Rust = TypeScript bit for bit on every case**. (A 1e-12
    perturbation of `z2` in Rust fails 2 068 of the Wilson cases and
    19 234 statistic lines - the vectors see rounding-level drift.)
  - **Web (`/stats`)**: `components/stats/uncertainty.ts` is gone; the
    tiles read `statReliability`. Visible changes: (1) a tile's level - the
    band's colour and its tooltip - is the shared rule (`sample.min` per
    statistic) instead of the web's own ±2 / ±6 point thresholds, which no
    other surface used and which called a 25% VPIP "noise" until ~200
    opportunities and "firm" only past ~1 800, the same for a fold to 4-bet
    as for VPIP; (2) the figure's
    opacity is continuous (0.6-1) instead of three steps (0.6 / 0.88 / 1);
    (3) the value's tooltip reads "n = 80, 95% CI 20.0–39.5%" (hr: "95%
    interval pouzdanosti"); AF and AFq are dimmed by the same rule and have
    the same tooltip (AF: "n = ..."); the win-rate headline's title gives its
    sample. Unchanged: the ± margin and the band's width (the interval's
    half-width; its bounds now differ from before only in the last bits of a
    double), the win rate's 0.8 fade and note (now `level !== "ok"`, the
    same as `statFull`). i18n: `stats.tile.confidence.{firm,loose,noise}` ->
    `stats.tile.reliability.{ok,low,insufficient}`, new `stats.tile.sample`
    and `stats.hud.sample`.
  - **For R2.7**: show `Shown::reliability` with every report value - the
    level as the tone of the sample count, `opacity` on the figure,
    `interval_text` in tooltips ("n = …, 95% CI a–b"); the HUD's i18n needs
    the same two strings. The breakdown and opponents tables on the web
    (`BreakdownPanel.tsx`, `OpponentsPanel.tsx`'s `< 20` thin-sample mark)
    still have their own rule until R4.5. **For R3.8**: dim each panel value
    by `Reliability::opacity` (`JsNumber::to_f64` for the renderer) - it is
    1 from `sample.min`, so a seasoned regular's panel is untouched; the
    popup's tooltip is `interval_text`. A villain with no sample at all
    still shows "—" at 0.6. A per-user floor (R3.9) would be an override of
    the 0.6, not of the rule.

### R2.6 Shared UI package — L
- `packages/ui`: tokens, cards, chips, the replayer, stat tables, graphs,
  filter chips, command palette, dialogs. Web consumes it first with no visual
  change (screenshot comparison of key screens before and after).
- Components take data through props and a small `DataSource` interface:
  Supabase on the web, Tauri commands on the desktop.
- *As built* (§15): **done** - `packages/ui` is `@rail/ui`, the one design
  system of the web and the desktop app, and the web renders from it with no
  visual change. [`docs/WEB.md`](WEB.md) "Shared UI package" is the
  reference.
  - **Layout** (source, no build step; a directory per area, imported by
    path, `@rail/ui/replayer/ReplayViewer`): `tokens/` (the four token files,
    each with its own `@layer tokens`); `styles/controls.css` (`.muted`,
    `.btn`, `.icon`, `.chip-btn`); `cards/` (`PlayingCard`, `CardRow`,
    `cards.css`); `chips/` (`Chip`, `FilterChips`); `replayer/` (the web's
    replayer, 23 modules, and `replayer.css`); `overlay/`, `icon/`;
    `dialog/` (the app's `<dialog>`); `stats/` (`StatTile` and
    `stat-tile.css`, `StatTable`, `format.ts`); `palette/`
    (`CommandPalette`); `i18n.tsx`, `data.tsx`, `model/`; `screens/` (the
    comparison script below, its own `package.json`).
  - **What moved** (`git mv`, imports rewritten, nothing else): the token
    layer from `frontend/src/styles/tokens/` (the app's byte copy from R1.1
    is deleted); `frontend/src/components/replayer/*`, `components/ui/{Overlay,Icon}`,
    `components/stats/StatTile`; the sheets `replayer.css`, `cards.css`,
    `overlay.css`. Two blocks were cut out of larger sheets with their
    cascade position kept: `app.css` lines 13-197 became `styles/layout.css`
    (web) + `styles/controls.css` (package), `@import`ed by `app.css` in their
    old order after cards and replayer; the tile rules left `stats.css` for
    `stat-tile.css`, imported by `StatTile` (nothing else targets those
    elements, so their place does not matter - checked below). New:
    `Chip` (the web's filter bar uses it for its chips, same markup),
    `FilterChips` (guideline §6 "filters as chips in one row"), `StatTable`
    (rows of `Shown`: value at the reliability's opacity, "n = …, 95% CI
    a–b" tooltip, sample toned by level; locale decimal mark over the
    `formatFixed` text), the `CommandPalette` shell (search field + listbox on
    a modal `<dialog>`, arrows / Enter / Escape; finding and navigating are
    the surface's), `DataSource`.
  - **One door out: `model/`.** The replayer needs PHF, the replay frames and
    the cards, which are the web's framework-free library
    (`frontend/src/lib/{phf/types,replay,cards}`, the statistics display
    types) - the same files `tests/` and the Rust parity vectors build on.
    `model/*.ts` re-export them; the package's ESLint allows no other import
    from outside it (and no `next/*`, `@supabase/*`, `@tauri-apps/*`,
    `server-only`). At R0.14 these four files are what changes.
  - **Words.** The package holds no copy. `i18n.tsx` declares `UiStrings`
    (`intlLocale`, `closeNamed`, `replayer` - the full `ReplayerStrings`,
    `statTile`, `statTable`) and `UiStringsProvider`; components call
    `useUiStrings()` where they called the web's `useDict()`. The web builds
    the value once per language from its dictionaries
    (`lib/i18n/ui.ts`, same objects) and mounts it inside `I18nProvider`.
    New web strings: `stats.table.{statistic,value,sample}` (en, hr).
    The package's ESLint has the surfaces' no-bare-literal rule.
  - **`DataSource`** (`data.tsx`): `hand(id) -> PhfHand | null`, with
    `DataSourceProvider`, `useDataSource` and `useHand(id)` (loading / ready
    / missing / failed). The web's implementation is
    `frontend/src/lib/db/dataSource.ts` (`getHand`); not mounted yet, since no
    web screen renders a package component that fetches.
  - **Consumers.** Both depend on `"@rail/ui": "file:../packages/ui"` (npm
    links it; the lockfiles gain only the link and the package's manifest).
    Web: `transpilePackages: ["@rail/ui"]`; `tsconfig.json` maps
    `react`/`react-dom` types to its own `node_modules` (Next aliases React
    when bundling); `next dev --turbopack` gets the repository as its root in
    the development phase only, so `next build`'s output and file tracing are
    unchanged. App: the same `paths` in `tsconfig.app.json`, Vite
    `resolve.dedupe: ["react", "react-dom"]` and `server.fs.allow: [".."]`;
    `index.css` imports the tokens from the package, `Folders` and
    `RawTextDialog` use `@rail/ui/dialog/Dialog`. The package itself has
    only dev dependencies (ESLint, stylelint, TypeScript, React types) and no
    React at run time, so there is one React per bundle by construction.
  - **No visual change, measured.** `packages/ui/screens/screens.mjs`
    (Playwright 1.55.1, Chromium 140): the base (`origin/staging`) and the
    change built with `next build`, served offline by `next start`, each
    captured twice - 288 full-page and replayer element screenshots across 9
    pages (convert, stats signed out, library, feed, upload, manual entry, a
    shared-hand link offline, learn, analysis), the converter's output for a
    dropped corpus file, the inline replayer, and the library replayer for two
    corpus hands (NLHE 6-max; PLO run-it-twice with a side pot) at widths 1440
    / 1100 / 900 / 768 / 600 / 480 / 390 / 320 (two heights below 768, around
    the 30rem / 32rem / 22rem container breakpoints) at the start, six actions
    in and the end, plus the hand-info and shortcut sheets, in both themes.
    Result: **285 of 288 screenshots pixel-identical; the other 3 (two dark
    480x560 run-it-twice frames, one light 320x800 end) differ by 47-70 pixels
    at most 1, 1 and 11 levels of one channel, all inside the sticky header's
    backdrop blur at the pills' rounded corners - the kind of difference 7
    other screenshots showed between two runs of the same build - and their
    element captures of the replayer are identical**. With each screenshot the
    page's whole cascade (every rule, document order) and DOM were compared
    too: of 192 DOMs, all equal once class attributes are
    whitespace-normalised (the one change: `Chip` writes `class="chip-btn"`
    where the filter bar wrote `"chip-btn "`); of 192 cascades, 188 equal once
    the tile's rules are left out, and the other 4 (`/stats`) hold the same
    tile rules in a sheet of their own instead of inside `stats.css` (on
    `/analysis` they are simply not loaded any more: no tile there). The stat
    tiles (not reachable offline) were checked apart: the server markup of the
    stats grid in en and hr is byte-identical before and after, and that
    markup rendered inside each build's `/stats` page is pixel-identical in 72
    screenshots (3 widths x 2 themes x 12 samples, all three reliability
    levels). The desktop app's production bundle (`vite build`) is
    byte-identical to the base's: same JavaScript, same CSS, same file names.
  - **Vercel.** The root directory stays `frontend`; the build reads
    `../packages/ui` through the `file:` link, which Vercel provides with
    "Include files outside the root directory in the Build Step" (on by
    default; the PR's preview deployment is the check, `docs/WEB.md`
    Deployment). No project setting was changed.
  - **CI**: new job `ui` (Shared UI package) - `npm ci`, ESLint, stylelint
    (the token rules; `replayer.css` and `cards.css` keep their hex
    exemption), `tsc`. The `frontend` and `app` jobs typecheck and bundle the
    package again through their imports; `tests/test/statDisplay.test.ts`
    scans `packages/ui` for hand-computed statistics (none) and
    `potOdds.test.ts` imports the package's `replayer/potOdds`.
  - **For R2.7** (desktop screens): import `@rail/ui/tokens/*` (done),
    then, for the replayer, `cards/cards.css`, `replayer/replayer.css` and
    `styles/controls.css` in that order after the tokens (controls after
    replayer, as on the web); mount `UiStringsProvider` - the app needs
    `ReplayerStrings` in `en` and `hr`, which today live in the web's
    `lib/i18n/ns/replayer.{en,hr}.ts` (decide: copy into `app/src/i18n/`, or
    move both dictionaries into the package as data - the brief kept the
    package copy-free); implement `DataSource` over a new Tauri command
    (`get_hand` -> PHF JSON from `rail-store`) and mount
    `DataSourceProvider`; Hands: `FilterChips` for position / limit / date /
    stack depth, `ReplayViewer` with `useHand(id)`; Reports: `StatTable` with
    `Shown` rows from `rail_stats::display` (the R2.5 note above); the
    command palette: `CommandPalette` with the app's own search and a
    Cmd/Ctrl+K listener. Two things to settle first: (1) the app's
    `tsconfig.app.json` has `noUncheckedIndexedAccess` and
    `exactOptionalPropertyTypes`, and the app typechecks whatever it imports:
    under them the moved replayer has 36 errors and the web library behind
    `model/` 51 (`lib/replay` 18, `lib/phf/types` 15, `lib/stats/display` 12,
    `lib/cards` 6), so even `StatTable` (its types come from
    `lib/stats/display`) brings 12; the package's new code itself is clean.
    Either tighten that code (behaviour-neutral, but it is the web's library
    and the oracle) or relax the two flags in the app - before the first
    screen; (2) the web's Inter font files are not in the app, so text metrics in the
    replayer differ from the web's until they are. The web's
    `WinrateGraph` (the plan's "graphs") did not move: Reports moves it.

### R2.7 Desktop screens — XL (one PR per screen)
- Today, Hands (virtualised list, filter chips, saved filters, replayer, tags,
  notes), Reports (winnings + all-in EV graph, by position and situation),
  Players (profile, notes, colour tags — `players` migration), Settings.
- Split when picked up (orchestrator, 2026-10-14): **R2.7a** Hands, **R2.7b**
  Today + Reports, **R2.7c** Players + the `players` migration.
- *As built, R2.7a* (§15): **done** - the Hands screen.
  - **Store** (`rail-store` migration 7, `0007_hands_screen.sql`;
    `core/rail-store/SCHEMA.md` "The Hands screen"): `hand_list`, one narrow
    row per `hand_stats` row - the hero's position, cards, net (minor units
    and thousandths of a bb) and starting stack, the primary board, the
    all-in flag (an `ev_rows` row; a preflop all-in is on until the EV pass
    settles it), showdown, pot type, the unit's symbol, the room's hand
    number and the segment - `WITHOUT ROWID`, primary key (`played_at`,
    `hand_key`): the list's order, so a page is one range and a keyset
    cursor a seek, and `hands` (the PHF) is read only for the page's rows.
    Derived like the statistics: written by `stats::Pending::add_rows` with
    the hand's `hand_stats` row (import, pull, rebuild) and deleted with it
    by a trigger; `tests/common::assert_list` holds it to `hand_stats` and
    the hero's seat row after every store test and every kill of the crash
    test. `hand_notes` and `hand_tags` (the user's words, keyed by `hand_key`
    without a foreign key so they outlive any rebuild; **local only - syncing
    them to the web is a later step**), `saved_filters` (per screen, name,
    the window's JSON). Migration 7 forgets `stats.version`, so a version-6
    store rebuilds its statistics once and the pass writes the list rows
    (the screen says so while it runs). "Go to hand" uses an index on
    `hand_list.site_hand_id`, not on `hands`: that index made the migration
    read the whole PHF table (11 s at 500k before the window opened; 0.25 s
    now).
  - **Queries** (`rail_store::hand_list`): `Reader::hand_page(filter,
    after, limit)`; `HandFilter` = site, format, variant, limit, table size,
    stake (a set of `segments.id`s), hero position, pot type, hero result
    (won / lost / even), stack depth (0-40 / 40-80 / 80-120 / 120+ bb),
    all-in, has note, tags (any of), date range (UTC instants). With a note
    or tag filter the query starts from those small tables (probing them per
    row cost 180 / 350 ms at 500k). `hand_facets(filter)`: per chip group,
    the hands the filter would match with that group's own selection left
    out, from one pass over the date range counted in Rust (SQLite's
    `GROUP BY` over the expressions was 600 ms), cached per read connection
    until the next commit (`PRAGMA data_version`), so clicking chips over
    the same range recounts in ~1 ms. `hand_rows`, `find_hands` (the room's
    number, a prefix, or the hand key), notes, tags, saved filters.
  - **Measured** (`cargo run --release -p rail-store --example
    hand_list_queries`, a generated 497 809-hand store from the R1.6 bench
    dataset, never committed; M2 Pro with the flop-library run on 9 of 10
    cores, load ~12): first page of 100, median - no filter 0.9 ms; hero on
    the BTN 1.2; won 0.7; all in 0.8; a recent month 0.7; 3-bet pot and
    80-120 bb 1.3; a note 21; a tag 14; one stake (1 584 hands, 0.3 %) 33; a
    room and 6-max 34; a rare combination (69 hands) 34; nothing matching (a
    full scan) 35; the 200th page through the cursor 2.6. Chip counts: 205
    ms for the whole store (a commit since), then ~1 ms per chip clicked;
    a date range 1.8 ms. Go to hand 0.06 ms; a hand's PHF 0.01 ms. Upgrade
    from version 6: open 0.25 s, the rebuild 498k hands in 114 s in the
    background. Maxima are the first, cold runs (up to ~0.9 s for a page
    whose rows' `hands` pages are not cached yet).
  - **Commands** (`app/src-tauri/src/hands.rs`, thin, async):
    `hands_page`, `hands_facets` (+ tags in use, hands with a note, room
    names from `sites.json`), `hands_by_key`, `hands_find`, `hand_phf`
    (JSON text, parsed in the window), `hand_annotations`, `hand_set_note`,
    `hand_add_tag`, `hand_remove_tag`, `saved_filters`, `save_filter`
    (checks the JSON parses as a filter), `delete_saved_filter`.
  - **Screen** (`app/src/screens/Hands.tsx`, `screens/hands/`): the list is
    virtualised by hand (fixed 40 px rows in a spacer, ~30 rows in the DOM
    whatever is loaded; the next 300 fetched 60 rows before the end; hands
    arriving while it is open go on top without moving the rows in view):
    date, room and its hand number, stakes, position, cards, board, result in
    money and in bb, marks (all-in with its EV in bb or "being computed",
    showdown, a note, tags). Filters: one row of group chips (date presets or
    a custom range, room, stakes, position, pot, result, stack, all-in, game,
    variant, limit, table, tags, notes), each opening its values as the
    package's `FilterChips` with the count each would match (`FilterChips`
    gained an optional `detail`); saved filters first in the row (apply,
    delete, save under a name; a date preset stays relative). The chosen hand
    opens beside the list in the shared `ReplayViewer` through `useHand` over
    the app's `DataSource` (`lib/dataSource.ts`, the last 16 hands kept),
    with its tags (suggested from those in use) and a note (saved as you
    type) under it, and a disabled "Open on the web" placeholder. The open
    hand is the route, `#/hands/<hand key>`. Keyboard: the list is an ARIA
    grid with a roving row (Up / Down / Page Up / Page Down move the
    selection, Enter moves focus into the replayer, whose ←/→, space and
    Home/End then work as on the web); rows, chips and the replayer's
    controls are labelled.
  - **Command palette** (`components/Palette.tsx`): Cmd/Ctrl + K opens the
    package's `CommandPalette`; a number finds hands by the room's id (prefix,
    debounced), and the screens are listed; Enter opens the hand or the
    screen. Players and reports join it with their screens; the rest is R2.8.
  - **Strings.** App `en` + `hr` (`hands`, `palette`, `ui`). The replayer's
    two dictionaries moved into the package as data,
    `packages/ui/strings/replayer.{en,hr}.ts` (with the Croatian `plural`;
    `model/replayStrings.ts` brings the frames' English), so the app shows
    the web's words: `app/src/i18n/ui.ts` builds its `UiStrings` from them
    and the app's `ui` slice (close label, stat tile and table words - a copy
    of the web's text, for R2.7b's Reports). The web's
    `lib/i18n/ns/replayer.{en,hr}.ts` and `lib/i18n/plural.ts` re-export
    them, so its dictionaries are unchanged; `tests/vitest.config.ts`
    resolves `@rail/ui` for the harness.
  - **Web unchanged, measured** with R2.6's `packages/ui/screens/screens.mjs`
    (base `origin/staging` and the change, `next build`, two captures each):
    **288 of 288 screenshots
    pixel-identical** (any run against any run), **all 192 DOMs identical**;
    of 192 cascades 12 are identical and 180 hold the same rules with one
    block moved: the five rules of `app/convert/convert.module.css` sit
    earlier in one CSS chunk (`next build` orders a chunk's modules by the
    module graph, which the move changed; every rule is the same, and
    nothing else matches those classes). Keeping the web's
    `ns/replayer.*.ts` as re-exports and importing the frames' English
    through its own `model/replayStrings.ts` brought one of two changed CSS
    files back to the base's bytes; this one stayed.
  - **App settings.** `tsconfig.app.json` drops `noUncheckedIndexedAccess`
    and `exactOptionalPropertyTypes` (the web's strictness: the shared
    replayer and the web's library behind `model/` have 87 errors under
    them, and they are the oracle). Inter is bundled: the web's two woff2
    files and the licence (`OFL.txt`, SIL OFL 1.1, which allows bundling
    with the licence) in `app/public/fonts/`, the web's `@font-face` rules
    and fallbacks in `app/src/fonts.css`, the latin cut preloaded; the
    replayer's sheets imported after the tokens in the web's order; the
    app's stylelint accepts CSS Modules' `:global`.
  - **Tests.** `core/rail-store/tests/hand_list.rs` on the corpus: every
    hand with rows listed once, newest first, matching its PHF and the
    engine (board, hero, result, stakes, symbol, showdown); after the EV
    pass `all_in` is "has an EV row"; pages read before and after hands
    arrive make one list; 150 seeded random filters - every page (random
    page sizes) and every chip's count equal a scan of the hands; notes,
    tags (normalised, limits), saved filters (replace by name), the counts'
    cache following a write; go to hand by id, prefix, `#id` and key; a
    version-6 store gets the same list rows as an import. The migration
    test covers 0..7; the older-store tests drop the new tables. App: the
    filter model (`tests/test/appHandsFilter.test.ts`: date presets as
    local days, saved filters read back whatever they hold); the commands'
    DTOs (`hands::tests`). Checked in a browser against a mocked IPC with
    20 000 made-up hands (list, scrolling and paging, filters and counts,
    saved filters, the replayer and its keys, tags and a note, the palette);
    not in a `tauri dev` window, and no real hands anywhere.
  - **For R2.7b** (Today + Reports): `Reader::hero_totals` and `StatTable`
    with `Shown` rows from `rail_stats::display`; the app's `ui.statTile` /
    `ui.statTable` words are a copy of the web's (moving them into
    `packages/ui/strings/` like the replayer's would make one copy);
    `WinrateGraph` still lives in the web. The filter row is reusable:
    `FilterState` / `FilterBar` / `Popover` / `SavedFilters` are the Hands
    screen's, `saved_filters` has a `screen` column for Reports. Today can
    show the session's hands from `hand_page` with a date filter (0.7 ms).
    The palette lists screens; add reports there.
  - **For R2.7c** (Players): migration 9 (R2.7b took 8); notes and colour tags can follow
    `hand_notes` (keyed by the natural key, no foreign key, local until a
    sync step); the palette should search players (`player_rollups` is keyed
    by site and name); "hands with this player" needs a player -> hands
    path (`seat_stats` has no index on `player`) - measure it at 500k.
  - **Later** (not R2.7): syncing notes, tags and saved filters to the web;
    "Open on the web" (a web route by hand key, after sync); the web's
    `DataSource` is still not mounted.
- *As built, R2.7b* (§15): **done** - the Today and Reports screens.
  - **Store** (`rail-store` migration 8, `0008_reports.sql`, tested from
    every earlier version; `core/rail-store/SCHEMA.md` "The Today and
    Reports screens"): the win-rate graph and the sessions walk the hero's
    hands in time order, which is `hand_list`'s primary key - one narrow
    range scan (0.05 s warm for 500k rows) where `hand_stats` through
    `hand_stats_played_idx` and `seat_stats` took 3-7 s. The list gained
    what they need: `kind` (bomb pot / straddled / EV cashout, for
    `aggregate`'s exclusions), `hero_wtsd` (the graph's showdown split is
    the hero's `wtsd`, not the hand's `wentToShowdown`), `currency` and
    `minor_units` (the money refusals, exactly as the web counts
    currencies). SQL cannot read `wtsd` out of the seat blob, so the
    migration forgets `stats.version` as 7 did and the rebuild writes the
    columns (500k: open 2.0 s, rebuild 100 s in the background).
    `tests/common::assert_list` holds the new columns to `hand_stats`, the
    hands and the hero's seat row after every store test and kill.
  - **Queries** (`rail_store::report`): `ReportFilter` (the segment's
    dimensions, the hero's position, a date range - what `hero_totals`
    sums by; `report_hero_filter` turns it into a `HeroFilter`);
    `report_graph(filter, points)` - `ntile` over (`played_at`, nulls last,
    `hand_key`) as `stats_graph`, per bucket the cumulative result in big
    blinds and money, showdown and non-showdown, the all-in EV line from
    `ev_rows` (looked up for the all-in rows only; hands still queued count
    at their result and are counted), the sample's `Units` (chips with cash:
    no money and no graph; two currencies: big blinds only), capped at
    4 000 points; `sessions(gap, limit, pots)` / `latest_session` - the
    web's `stats_sessions` rule (no gap longer than 30 minutes, across
    tables; bomb pots and straddles in, an EV cashout's money out), read
    newest first so the latest costs its own hands; tables and the biggest
    pots in big blinds on request; money refused per session (the web
    refuses for the whole list of its scope; a cash session keeps its
    result whatever else the store holds); `report_breakdowns(filter)` -
    the hero's totals by pot type, stack band (the web's `stack_bb`),
    starting hand, players dealt in and street reached, one pass over
    `hand_stats` in table order with the hero's seat row. The graph and the
    breakdowns are cached per read connection until the next commit
    (`PRAGMA data_version`), as the Hands screen's counts. `HeroSum` (in
    `stats_read`) sums `hero_totals`' rows with their EV adjustment.
  - **Measured** (`cargo run --release -p rail-store --example
    report_queries`, the generated 497 809-hand store of the R1.6 bench,
    never committed; M2 Pro under load 7-8; two runs): **opening Reports**
    (`hero_totals` + the graph at 1 500 points), first call / again:
    everything (470 224 hero hands; chips with cash, so no graph) 488 / 161
    ms with the list's pages in the OS cache, **1.8 s** / 135 ms when they
    were not (the 2 GB store's pages evicted by other work); cash (439 846
    hands, 1 500 points) 374-403 / 114-144 ms; one stake (236 663) 213-277 /
    109-117 ms; the button (78 789) 207-236 / 118-141 ms; a month 48-54 ms.
    Of that, `hero_totals` 91-167 ms (its EV adjustment's lookups dominate,
    R2.3), the graph's pass 120-330 ms warm, then cached. **A breakdown tab
    by situation** (first click): 1.2-1.6 s for everything, 0.66-0.81 s
    cash, 0.39-0.53 s a stake or a position, then cached. **Today**: the
    latest session 15-86 ms first, 0.2-0.3 ms after. Every session of the
    store (192; the parity test's call, not a screen) 0.17-0.19 s without
    tables and pots (27 s with them: they read `hands` for every hand).
    **At 1M** (linear, honestly): opening Reports 0.25-0.3 s warm, 0.8-1.0 s
    with the list in the OS cache - at the guideline's limit, not under it
    with margin - and over it on a cold first read (~3.5 s); a situation
    tab's first pass 1.6-3.2 s - over it. The bench's days are 69 copies of
    the corpus's, so a day there holds ~50 times a real day's hands (the
    partial-day and session costs are pessimistic).
  - **Commands** (`app/src-tauri/src/reports.rs`, thin, async):
    `stat_definitions` (every shipped definition, file order),
    `report(filter, points)` (units, the summary - totals, net, net bb, EV
    result and every definition's `Shown` - the graph in the web's
    `StatsGraph` shape plus the money lines, and the rollups' breakdowns by
    position, stake, room, table size and format, each row with the
    breakdown columns hands, bb/100, VPIP, PFR, RFI, 3B, F3B, steal, CB,
    WTSD, W$SD), `report_breakdowns(filter)`, `today()` (the latest
    session with every definition over its hands, its biggest pots as Hands
    rows, whether it is still going). Values are `Shown` as the web's
    `showStat` returns them (doubles bit for bit, R2.4 / R2.5); a refused
    unit withholds a big-blind or money statistic's value (the sample
    stays). The saved-filter commands take a `screen` (`hands` default,
    `reports`).
  - **Screens.** *Today* (`screens/today/SessionPanel.tsx`): current or last
    session - when, result in money and big blinds (refusal notes), hands,
    hands per hour (from 10 minutes), tables, the key statistics in the
    shared `StatTable` with their reliability, the five biggest pots (time,
    room and stakes, cards, pot in bb, result) linking into Hands; then the
    import status and store counts as before; refreshed by the watcher's
    events and once a minute. *Reports* (`screens/Reports.tsx`,
    `screens/reports/`): the Hands filter row with the report groups (date,
    room, stakes, position, game, variant, limit, table) and Reports' own
    saved filters; on a store that mixes formats it opens on the format with
    the most hands and says so (the web's `defaultScope`); notices for the
    refusals, the EV queue and a rebuild; summary tiles (hands, result, big
    blinds, bb/100, all-in EV bb/100); the graph in big blinds or money;
    every statistic in four `StatTable`s by group; the breakdown tabs
    (ARIA tabs, arrow keys; the tab is the route `#/reports/<tab>`) -
    position, pot type, stack depth, starting hands (the web's 13 x 13 grid
    with a metric toggle, cells as buttons, the selected class's row under
    it, plus the full table), players, street, stakes, table size, room,
    game - each cell the definition's value faded by reliability with its
    sample and interval as tooltip. The palette lists the breakdowns.
    Hands per hour, the matrix's tint and the money view's scale are
    presentation; no statistic is computed in the window (the guideline §14
    scan passes).
  - **Shared UI package.** The web's `WinrateGraph` and `chartScale` moved to
    `packages/ui/stats/` (`git mv`): words from `UiStrings.winrateGraph`,
    data typed as `WinrateGraphData` (the web's `StatsGraph` fits), and an
    optional `unit="money"` / `money` the web never passes. Its rules moved
    to `stats/winrate-graph.css`, imported by the component (as `StatTile`
    imports its sheet) and by the web's analysis `TrendChart`, which reuses
    the classes and `chartScale`; `styles/stats.css` stays one file without
    them. Splitting `stats.css` into three `@import`s in the old order was
    tried first and rejected by the comparison below: each imported file
    becomes a CSS module of its own and `next build` placed them on either
    side of the analysis pages' `leaks.module.css`, so `.leaks_summary`'s gap
    would have won over `.stats-group`'s on the signed-in `WhatChanged` card.
    Keeping the web's old modules as re-exports to hold the import graph's
    shape moved `/convert`'s modules instead. The tile's, the table's and the graph's words are data in
    `packages/ui/strings/stats.{en,hr}.ts`, which the web's
    `ns/stats.{en,hr}.ts` reference block by block (text unchanged) and the
    app hands to its provider (its R2.7a copies are gone; its own words:
    the close label and the graph's "not enough hands"). New: `StatValue`
    (one value with reliability and tooltip; `StatTable` shares its
    helpers; a count gets the locale's grouping). App: `useLocale`, the
    web's `.notice` rules in `index.css` (the graph writes them).
  - **Parity with the web** (`core/rail-store/tests/report.rs`,
    `tests/data/report-vectors.{mjs,json}`): the vectors script restates
    the web's SQL (`hand_stats_filter_sql`, `stats_summary`, `stats_graph`,
    `stats_sessions`, `stats_breakdown`) in TypeScript over the TypeScript
    engine's rows (`golden-stats-full`, the hero's `handEvRow` in
    `golden-ev-full`), the store's hands (files in Rust's path order, first
    copy of each key: 7 269 hero hands, 926 duplicate copies skipped), over 9
    scopes (everything - chips with cash -, cash - two currencies -, one and
    two cash stakes, the tournament formats, button and big blind, the
    biggest room, two date ranges). The Rust test imports the corpus, runs
    the EV pass and compares: **288 statistic values and texts (bb/100,
    net, all-in EV bb/100 included), every scope's totals and units, 3 677
    graph buckets (60 and 997 points: every cumulative line in big blinds
    and money, dates), 1 967 breakdown rows (all 98 columns, the EV
    adjustment of the rollup groups) and 193 sessions - all equal**. Also:
    `ntile` sizes, the graph's end equals `hero_totals` (net, money, EV),
    the cache follows a commit, sessions partition the dated hero hands
    with gaps over 30 minutes between them (a gap of 0 splits at every
    instant), the biggest pots are ordered, and a version-7 store rebuilds
    to the import's list.
  - **Web unchanged, measured** with R2.6's `screens.mjs` (base
    `origin/staging` and the change, `next build`, offline, two captures
    each): **288 of 288 screenshots pixel-identical, all 192 DOMs identical**; of
    192 cascades 184 are identical and the other 8 (`/stats` and
    `/analysis`, both themes and widths) hold the same rules in the same
    order once the graph's are left out - on `/stats` those sit in their
    own sheet, on `/analysis` they arrive with `TrendChart`'s chunk (not
    loaded offline; nothing beside them sets their properties). The graph is not reachable offline, so it was
    checked apart: its server markup (7 made-up graphs - 60 buckets, no EV,
    no all-ins, two currencies, chips with cash, one bucket, flat - in en
    and hr) is **byte-identical** before and after, and that markup inside
    each build's `/stats` page with the build's own CSS is **pixel-identical
    in 84 of 84 screenshots** (2 themes x 3 widths x 14).
  - **Checked in a browser** against a mocked IPC with made-up data (a
    20 000-hand store in tournaments and cash, a session, all breakdowns):
    Today, Reports (default format, money toggle, tabs, the matrix, the
    palette's report items), light and dark; not in a `tauri dev` window, no
    real hands anywhere.
  - **For R2.7c** (Players): migration 9; a player's report can reuse
    `report_breakdowns`' pass shape over the villain's seat rows (needs a
    `seat_stats (player)` path), `StatValue` and the group table
    (`screens/reports/Breakdown.tsx`'s `GroupTable`); the palette's report
    items show how to add players.
  - **For R2.9**: gate at 1M (1) opening Reports cold (the graph's pass and
    `hero_totals`' EV lookups), (2) the breakdowns by situation - at 1M
    over a second on first click; candidates: hero rollups by pot type /
    stack band / starting hand (more `hero_rollups` keys, measured against
    the import), or a hero-only narrow table with the seat blob in time
    order that would also feed the graph - measure the import's cost first
    (R2.3's efficiency gate), (3) a real-volume dataset (the bench's
    duplicated days make sessions and partial days ~50 times too big), (4)
    the cold first read (1.8 s at 500k with the store's pages out of the OS
    cache): the reports' tables are a fraction of the 2 GB file, so warming
    `hand_list` and `hero_rollups` in the background after start, or keeping
    the PHF out of the pages the reports read, is worth measuring.
- *As built, R2.7c* (§15): **done** - the Players screen. **Phase 2 status
  after it**: the screens of R2.7 are built (Today, Hands, Reports,
  Players; Settings had its folders, account and debug panels since Phase
  1); left in Phase 2 are **R2.8** polish (palette features beyond hands,
  players, screens and reports; density; the language setting), **R2.9**
  the 1M benchmark database and the nightly performance gate, **R2.10**
  custom statistics and **R2.11** targeted recompute.
  - **Who is a player (decided).** An opponent's seat row at scope `''`
    with a name: a villain of a room that prints real screen names
    (docs/DATABASE.md "Player identity and anonymized rooms"). Positional
    rooms have no villain rows (R2.3). **Opaque-id opponents are counted,
    never listed** - the list says how many of their hands it left out, as
    the web's `stats_opponents` does - and **take no notes, colours or
    labels**, as the web's `set_player_note` refuses them. Scoping a note to
    the session (`<table>@<UTC day>`) was considered and not built: the
    token is gone when the session ends, so the note would never be read
    again, and the next session's holder of the same token would inherit
    it. The store refuses such a write (`Error::NotAnOpponent`), not only
    the screen. The listed players are those with hands **together** (the
    hero in the hand): an opponent seen only in hands without a hero (an
    observed table) has statistics but is not listed.
  - **Store** (`rail-store` migration 9, `0009_players.sql`, tested from
    every earlier version; `core/rail-store/SCHEMA.md` "The Players
    screen"): `players` (site, name -> colour from a fixed six, note) and
    `player_labels` - the user's words, keyed by the natural key without a
    foreign key, the web's `player_notes` limits (note 2 000 characters;
    up to 8 labels of 24, lower-cased) so a sync carries them as they are;
    `player_summary` (per named opponent: hands seen, first and last seen,
    hands together and the hero's result against them in big blinds, cash
    and tournament chips apart - summed at import with the rollups,
    `aggregate`'s defaults) and `player_hidden` (the opaque-id opponents'
    rows per site); `player_hands` (player, hand, seat) - an opponent's
    seat rows by name - **written by the background pass, not the import**
    (below), with a delete trigger on `seat_stats`. `tests/common`
    holds the summary, the hidden counts and `player_hands` to the seat rows
    after every store test and every kill of the crash test. A version-8
    store opens in 0.2 s and rebuilds once in the background (the summary
    comes from the seat blobs, which SQL cannot read).
  - **Import cost, measured** (`import_bench`, 100k generated hands, 3
    threads as CI's runner, interleaved runs against the version-8 build,
    M2 Pro with the owner's work on it, load 5-10). A partial index on
    `seat_stats (player)` cost 3-5 points of efficiency (v8 51/46/47 % vs
    45/41/45 %); `player_hands` written sorted at each group's flush instead
    still cost **5 %** of the rate (v8 5 872-5 942 hands/s, 49-50 %; it
    5 507-5 728, 46-47 %): every transaction touches a page of a
    name-ordered table per opponent. Split: the summary alone -0.4 %, the
    by-name entries -4.4 %. CI's best of three was 50-60 % in the last
    runs, a few points over its 45 % gate, so the by-name entries moved to
    the **background pass** (`stats::index_players`, `kv`
    `players.indexed`, 20 000 hands a transaction, sorted; a rebuilt hand
    whose id the pass has passed is written inline): **as shipped, -1.0 %**
    (v8 5 820-5 864, it 5 761-5 822 hands/s; 49-50 % vs 48-49 %), 4 063 ->
    4 066 bytes a hand. The villain-by-position view R2.3 asked about is
    therefore built (from `player_hands`), and the gate stays green.
  - **At 500k** (`cargo run --release -p rail-store --example
    players_queries`; a generated 497 809-hand store from `import_bench
    --rename-players`, never committed; load 6-9): **70 948 named
    opponents**, 2 287 548 of 2 979 446 seat rows by name. Upgrade from
    version 8: open 0.2 s, rebuild 64.5 s, then `player_hands` in 25 steps
    of 83-129 ms (3.4 s). **The list**: 200 rows of 38 483 (the rest only
    in hands without a hero) 30.6 ms on the first call after a commit (the
    summary read into memory), then **0.4 ms**; a search of one or three
    letters 0.3 ms; the palette's 8 0.4 ms. With 300 000 made-up opponents
    added (`--pad`; 370 948): 173 ms first, then 6.9 ms, a search 3 ms.
    **A profile** (rollups, summary, words) 0.0-0.2 ms; **by position**
    11-12 ms for the opponent with the most hands (8 122), 0.6-0.9 ms for
    the 250th (860). **Hands with this player**: first page of 100 68 ms
    cold / 17.5 ms (the most hands), 33 / 3.5 ms (the 250th); chip counts
    10.4 / 0.1 ms and 1.7 / 0.2 ms; every page of 8 326 rows 0.48 s (each
    page sorts the player's hands again).
  - **Dataset.** `import_bench --rename-players` (R2.9 asked for it): every
    copy of a template rewrites its villains' names through a per-copy
    letter permutation that keeps each letter's class (an opaque hex token
    stays one), same length, whole words only, never a hero's name; kept
    only where the renamed copy converts to the same hands, names, heroes
    and anonymisation (390 of 431 templates; the other 41 keep the corpus's
    names). Off by default: CI's benchmark is unchanged.
  - **Commands** (`app/src-tauri/src/players.rs`, thin, async):
    `players_list(query)`, `player_profile(site, player, kind)` (every
    definition's `Shown`, a `players: hero` or money one withheld; big
    blinds withheld when the profile mixes chips with cash; rows by
    position, stake, table size, game; a hand per cash stake for its
    label), `player_sites`, `player_labels`, `player_set_note`,
    `player_set_colour`, `player_add_label`, `player_remove_label`;
    `hands_page` / `hands_facets` take `filter.player`; `stats_status`
    reports `playersUnindexed` and the activity `indexing`.
  - **Screen** (`app/src/screens/Players.tsx`, `screens/players/`): a
    search box (prefix, any case, debounced), the game kind (all, cash,
    tournaments - on a store with both it opens on the kind with more
    hands, as Reports), room, colour, label and note filters; notices for
    the money refusal, the opaque-id hands left out, a rebuild and the
    pass's backlog; the table (colour, name, labels, a note mark, room,
    hands together, your result in bb, last seen; 200 rows, "show more" to
    500); the profile beside it (`#/players/<site>:<name>`): hands together
    by kind, first and last seen, your result per kind (never added), the
    button "Hands with this player" (opens Hands with a player chip that
    removes it), the colour (an ARIA radio group, arrow keys), labels and a
    note saved as you type, every `players: any` statistic in the shared
    `StatTable` with its reliability, and the breakdown tabs in Reports'
    `GroupTable`. The colour tags are app tokens over the token layer's
    semantic hues (`--player-tag-*` in `app/src/index.css`: danger, grade
    "mistake", warning, success, info, anonymity - both themes; every
    swatch named). Cmd/Ctrl + K finds players by the start of the name.
    Strings `en` + `hr`. Checked in a browser against a mocked IPC with
    made-up players (list, search, kinds, colours, labels, note, profile and
    tabs, hands with a player, the palette, light and dark); not in a
    `tauri dev` window, no real hands or names anywhere.
  - **Tests.** `core/rail-store/tests/players.rs` on the corpus: the list
    is exactly the named opponents, ordered, one kind's numbers and the
    hero's result as the web's join computes them; search by prefix in any
    case; opaque tokens counted, never listed, no profile; positions add up
    to the rollups; "hands with this player" equals their hands with other
    filters on top, counts included; notes, colours and labels refused for
    the hero, a token, a seat label, a stranger, within the limits, gone
    when cleared, surviving a rebuild; the background pass's entries; a
    version-8 store gets the summary. App: the profile over a fixture
    (`players::tests`), the filter's player and the route parameter
    (`tests/test/appHandsFilter.test.ts`).
  - **Sync later (R4.x, not built).** The web keeps `player_notes` (owner,
    site, player, note, tags) and §3.5 plans a `players` table for tags
    and colours. The plan: add `colour` to the web's notes (or fold them
    into `players`), push and pull the desktop's `players` / `player_labels`
    rows through the outbox like hands, last write wins per player by
    `updated_at`, and keep the identity rule on both sides (the web refuses
    a non-`none` room's name; the desktop never writes one). Labels are the
    web's tags already (same limits, lower-cased).
  - **For R2.8**: the palette has players; the table is not virtualised
    (500 rows at most) - a keyboard grid like the Hands list's would be
    the polish; the profile follows the list's kind (no kind of its own).
    **For R2.9**: `--rename-players` gives a realistic opponent count;
    gate the list's first call after a commit (it reads the whole summary:
    0.17 s with 371k opponents - an index on hands together or a narrower
    cache would bound it), the background pass's catch-up after a large
    backfill (3.4 s at 500k), and "every page" for a heavy regular. **For
    R2.10**: a user's statistic needs nothing here - the profile shows every
    `players: any` definition. **For R2.11**: a targeted recompute must keep
    the summary in step with the rollups (both are summed in
    `stats::Pending`). **For R3.8** (HUD popup): an opponent's colour,
    labels and note are `Reader::player_notes(site, name)` (a key lookup);
    never for an opaque or positional seat; the six colour names map to the
    HUD's own palette; the popup's "by position" is `player_positions`
    (milliseconds, from `player_hands`, which lags the import by one
    background step - a hand just played is in the rollups at once).
  - **Import writer, second pass** (on R2.7c's PR, whose CI import
    benchmark failed its gate: best of three **44 %**, runs 43 / 41 / 44 %,
    against 45 %). **Profiled** (`sample` and SQLite's per-statement
    profile, 100k generated hands, 3 import threads as on the runner, the
    owner's M2 Pro): the writer was busy ~35 % of the import's wall time
    and was not the bottleneck by itself - the **import threads waited for
    it**: each one called `WriterHandle::import` and blocked until its
    file's batch committed, **~15 % of its time**. With at most three
    batches queued the writer committed **5 522 transactions of ~18 hands**,
    and every transaction rewrites each page it touches (the indexes keyed
    by hand fill at random places, the rollups' pages): **44 pages of 16 KiB
    a commit, 3.8 GiB of WAL for a 396 MiB store**. Of the writer's busy
    time: commit (WAL frames, their checksums) 25 %, the auto-checkpoint 22 %
    (three quarters of it `fsync`), then by statement (ms per 100k hands)
    `seat_stats` 425 (611k rows), `hands` 396, `hand_stats` 227,
    `hand_list` 225, `outbox` 224, `player_rollups` 201 (37k upserts, one
    per key and group already), savepoint releases 126, `files` 73 + 49,
    `hero_rollups` 67, `player_summary` 44, `quarantine` 23, `kv` 19,
    `source_days` 14, `ev_rows` / `ev_pending` / `segments` / the offset
    check 5-7 each; the rest Rust (binding, the sums, freeing the batches,
    ~10 %). The import threads themselves: conversion 46 % and detection
    11 % (the reference's work), `PreparedHand` 21 % (canonical JSON ~11 %,
    zstd ~6 %, statistics ~3.5 %), reading 6 %.
  - **What changed.** (1) **The import threads no longer wait for their
    commits** (`rail-watch`): `FileReader::start` reads, converts and
    queues a one-batch read (`WriterHandle::queue`) and returns; a
    **committer** thread waits for the commits in order
    (`Committing::wait`) and answers the coordinator as the import thread
    did. A file stays in flight - never read twice at once - until its
    commit is answered; the dispatch cap counts only files being read. A
    batch whose stored offset moved goes on as the same look
    (`Finished::Again`), as `poll` retried inline (`poll` itself is start
    + wait, unchanged for its callers; new test). A large read still
    commits its pieces before it returns. (2) **The writer lingers for
    queued batches**: a group of `queue`d batches that found a second one
    waiting collects for up to 5 ms (`GROUP_LINGER`); a lone batch (a hand
    being played) and any batch someone waits for (`import`,
    `import_async`: a large read's pieces, the tests) commit at once:
    ~1 640 transactions per 100k instead of ~3 250. (3) A **16 MiB page
    cache** on the write connection (default 2 MB = 128 of our pages), (4)
    a **checkpoint every 4 096 WAL pages** (64 MiB; default 1 000) and (5)
    **migration 10** drops `hands_played_at_idx`, an index nothing reads
    (the list reads `hand_list`, date ranges `hand_stats`) that every hand
    wrote at a random place. No change to what is stored or derived, to the
    offset rule or to crash safety (the crash test and every store test
    unchanged and green).
  - **Measured** (interleaved A/B, M2 Pro with the owner's work on it). A
    new `import_bench --writer-only N` commits the dataset's batches,
    converted up front, N to a transaction from one thread - the writer's
    cost alone: **51.1 -> 43.6 us a hand** at 4 batches a transaction for
    (3)-(5) together (each -6-7 %; a 64 MiB cache no better than 16), and
    by group size (all of them in) 55.5 us at 1 batch, 48.3 at 2, 43.6 at
    4, 40.8 at 8, 38.8 at 16. The whole pipeline, 3 threads on P-cores
    (the writer has a core of its own there): efficiency **51 / 52 / 52 %
    before, 59 / 60 / 60 % with (1)-(2), 60 / 59 / 60 % with all**; with
    every thread held to the 4 E-cores (`taskpolicy -c background`, 4
    threads, CPU-bound like the runner; noisy) 42 / 44 / 44 % -> 47 / 48 /
    46 % -> 43 / 46 / 45 %. **CI** (3 threads on the 3-core M1 runner):
    with (1)-(2) **55 / 58 / 54 %, best 58 %** (import 5 747 hands/s,
    reference 3 484); with all of it **53 / 62 / 54 %, best 62 %** (import
    4 014 hands/s, reference 1 927 - 2 753: a slower runner, like the one
    that failed at 44 %).
  - **Measured and not taken**: foreign keys off on the write connection
    during imports (-4 %: the integrity checks are worth more); all eight
    secondary indexes of `hands`, `outbox`, `hand_stats` and `hand_list`
    dropped (-20-25 % of the writer, but every one but `played_at` has a
    reader); a 20 ms linger (more hands a transaction, slower overall:
    the queue fills); freeing the batches off the writer (5.8 % of its
    time, but it only moves the CPU, which is what the runner lacks).
  - **Is the ratio fair on 3 cores?** Not quite, and on purpose: with 3
    import threads on 3 cores the writer, the committer, the coordinator
    and the benchmark's own polling take their CPU from the threads, and
    the threads do more than the reference (canonical JSON, zstd, the
    statistics: ~a third on top of the conversion), so ~60-65 % is the
    ceiling there. The app's default is physical cores - 1 (2 on the
    runner), which would leave the writer a core and read higher; the job
    keeps 3 threads, the stricter measure its 45 % was calibrated on (said
    so in `ci.yml`). Changing it would mean calibrating the gate again.
  - **For R2.9**: at 1M the indexes keyed by hand are 10x larger, so a
    transaction touches more distinct pages - measure the writer there
    (`--writer-only`); the next levers are fewer pages per hand (a narrower
    `hand_list`, the `outbox` indexes) and the import threads' own
    canonical JSON (a direct serialiser instead of a `serde_json::Value`
    tree) and zstd level.

### R2.8 Polish — M
- Command palette, dark/light theme, density, i18n with `en` and `hr` prepared
  (same pattern as the web's `lib/i18n`).
- *As built* (§15): **done** - guideline §6's UX on the four screens of R2.7
  and Settings. No core crate changed; the web renders as before (below).
  - **Command palette.** The package's shell (`packages/ui/palette/`) is
    complete and still finds nothing itself: options in labelled ARIA groups
    under a combobox (`aria-activedescendant`, focus never leaves the field);
    ↑/↓ and Tab / Shift + Tab move (Tab never leaves the field), Page Up /
    Page Down by five, Enter chooses, Escape closes even with text typed (a
    search field would only clear it), the active option scrolls into view,
    the query's letters are marked, an item may show its own shortcut, the
    footer the palette's keys, a polite live region the result count; a
    native close the browser makes without a cancel event (a second Escape)
    is reported too. New `palette/fuzzy.ts` (`fuzzyMatch`, `rankItems`):
    the query's letters in order, case and diacritics ignored, word starts,
    runs and prefixes first, keywords a little behind the label. The app
    (`components/Palette.tsx`) supplies: hands by the room's number and
    players by name (the store, as R2.7a/c), the screens with Cmd/Ctrl + 1-6
    (also global), the reports' breakdowns, **saved filters** of Hands and
    Reports (handed to the screen even when it is open: `requestFilter(f,
    target)` + `onFilterRequested`), the **Settings sections**
    (`#/settings/<section>`, scrolled to and focused: account and sync,
    folders, refused hands, appearance and language, startup, about) and the
    **commands** - pause / resume import (when the watcher runs a folder),
    sync now (when sync exists), the three themes (the one in use marked),
    the other density, the other language, show refused hands - each with
    words it also answers to in both languages; with nothing typed, the last
    five places opened (`localStorage` `rail.palette.recent`, labels rebuilt
    in the current language) then the screens and commands. A sidebar
    button opens it for the mouse.
  - **Theme and density.** `settings.json` gains `density`
    (comfortable / compact) and `locale` (en / hr), both defaulted for an
    older file (version stays 1); commands `set_density`, `set_locale`.
    `lib/appearance.ts` (replaces `lib/theme.ts`) paints `data-theme`,
    `data-density` and `lang` on `<html>` and keeps a copy in `localStorage`
    (`rail.appearance`) that **`public/appearance.js`, a classic script in
    `<head>` (the CSP's `'self'`), applies before the first paint** - no dark
    frame before a light theme, no English frame before Croatian; the
    settings arrive over IPC and win. "System" follows
    `prefers-color-scheme` live. Density is tokens:
    `packages/ui/tokens/density.css` (`--density-row` 40 / 32 px, cell
    padding, a roomier cell, the tables' type 12 / 11 px, the page margins),
    imported by the app only; the shared `StatTable` reads them with its old
    values as fallbacks. The Hands list and the new Players grid position
    rows by `--density-row` read back in script (`useRowHeight`), keeping the
    row at the top in view when it changes. The felt, cards and chips stay
    unthemed; the contrast pass found the replayer painting stacks and the
    pot with the themed `--money-fg` (about 1.2:1 on the felt in light), so
    the token layer gained `--felt-money` (the dark gold, unused by the web)
    and the app points the felt's `--money-fg` at it in light.
  - **i18n.** English default, Croatian complete: `hr.ts` rewritten in the
    web's register (ti; no gendered second-person past tense), every count
    through the shared `plural` (1 ruka / 2 ruke / 5 ruku, verbs agreeing),
    "od N ruke/ruku" forms; English singulars fixed ("1 hand"). Counts are
    passed as numbers and formatted by the dictionary (`countIn`: 1,204 /
    1.204); every `Intl` formatter in the app is "live"
    (`i18n/format.ts`: `liveNumberFormat`, `liveDateFormat`), resolved with
    the chosen language's tag (en-GB, hr-HR) at each call; the screen
    remounts on a language change. Settings, Appearance: theme, density,
    language (each language named in itself, `lang` set). The tray follows
    (`strings::set_locale`, `tray::relabel`; "Nisi prijavljen" became "Nema
    prijave"). **Audit**: no bare string in a component; the app's ESLint
    rule now also rejects text as an expression child (`{"…"}`), chosen in
    place (`{a ? "…" : b}`, `{a && "…"}`), templated, and on the app's own
    text props (`label`, `caption`, `lead`, `heading`, `detail`,
    `emptyText`, `busyText`) - a probe file trips all nine selectors, the
    app has none. Croatian strings equal to English are names and poker's
    own words only (`tests/test/appI18n.test.ts` holds both to that, no
    empty strings, the plural forms, the number formats, the boot script's
    key). **Left in English**: messages the Rust side returns as errors
    (`errorText`, e.g. "Sync is not available in this build."); a
    `localizeServerMessage` like the web's is a later step.
  - **From R2.7.** The Players table is a **virtualised ARIA grid** like the
    Hands list (rows in a spacer, ~25 in the DOM; Up / Down, Page Up /
    Down, Home / End, Enter into the profile; beside an open profile the
    room and "last seen" give way through a container query - WKWebView
    before Safari 16 scrolls sideways instead). **The profile has its own
    game kind** (all / cash / tournaments), the list's until chosen there.
    **Consistency**: one `StateMessage` for the loading (three skeleton
    lines, still under reduced motion), empty and error states of Today's
    session, Hands, Reports, Players and the profile, with `status` /
    `alert` roles; the store errors were unannounced before. The chosen row
    of Hands and Players is a tint with the accent edge (`--surface-selected`
    is a plate for white text: on it the rows' own colours fell to 3.7:1 in
    dark and 1.4:1 in light); the hand's room number and the sidebar's brand
    (now large text) clear their ratios; the palette's field shows focus
    as an accent line; Settings sections focused from the palette take no
    ring of their own.
  - **Accessibility, measured** (Playwright against a mocked IPC with
    made-up data; the web's `frontend/scripts/contrast-sweep.js` on Today,
    Hands with a hand open, Reports, Players with a profile, Settings, in
    both themes): after the fixes above, 0 failures on Today and Settings;
    the rest are the sweep's known exemptions - a disabled replayer control,
    values faded by their reliability (R2.5's opacity, by design), text
    the sweep composites over the page instead of the felt, and a
    screen-reader-only label. Keyboard: Tab reaches every filter chip and
    the list's one roving row, the sidebar after the screen; every stop
    showed a ring. The palette's flows by keyboard alone: open, fuzzy
    ("gtrep" -> Reports), a command (theme, density, language), a hand by
    number, a saved filter applied to an open Hands, recent items, a
    Settings section focused, Ctrl + 3, the Players grid's End and Enter.
    Screenshots of the five screens in 2 themes x 2 densities x 2 languages
    (40) and of the palette looked through; not in a `tauri dev` window.
  - **Web unchanged, measured** with R2.6's `screens.mjs` (base
    `origin/staging` and the change, `next build`, offline, two captures
    each): **288 of 288 screenshots pixel-identical, all 192 DOMs
    identical, all 192 cascades identical once the one new declaration
    (`--felt-money` on `:root`, unused by the web) is left out**. The web
    imports none of the other changed package files (`palette/`,
    `StatTable`, `density.css`). The script's replayer-sheet captures had
    gone stale on the base too: the result sheet at the end is open but
    has no box Playwright counts as visible, and "?" pressed while the
    closed sheet hands focus back was lost; they now wait for an open
    dialog, pause before the key, and retry up to three times.
  - **For later**: a `localizeServerMessage` for the Rust side's errors;
    the web adopting the palette (its words through props, `rankItems`) and
    `density.css`; the web's replayer in its light theme has the same
    stacks-and-pot contrast (`--felt-money` is ready for it); the contrast
    sweep in CI needs a headless browser in the app job.

### R2.9 Benchmark database and performance gate — M
- A 1M-hand database built by replicating real corpus hands with fresh ids and
  names (generated, labelled, never under `testdata/`); nightly CI job measuring
  every target in guideline §1; fails on regression.
- Same measurement against Supabase decides whether `player_stats` is needed
  server-side (§3.5).
- *As built* (§15): **done** - the 1M benchmark store, the measurements,
  three fixes, the nightly gate, and the server's numbers (it needs
  rollups: recommended below, not built). No schema change, no migration,
  no statistic computed differently.
  - **Dataset** (`core/rail-watch/examples/import_bench/dataset.rs`, used by
    the new `perf_gate` example; GENERATED, written to a temporary
    directory with a `GENERATED.md`, deleted after the import, never under
    `testdata/` or a fixture tree). The corpus's 431 replicable files
    copied 137 times with fresh hand ids (R1.6) and fresh villain names
    (R2.7c's `--rename-players`: 390 templates; the other 41 keep their
    names in every copy and become the heavy regulars), and new
    **`--spread`**: copy *c* is played 7 x *c* days earlier - every date in
    the file moved in the room's own calendar (`2026/02/17`, `2026-02-17`,
    `2014/3/9`, and where a template needs it `3/9/2014` month or day
    first, Unix seconds), time of day and weekday kept, checked per
    template (its first shifted copy must convert to the same hands, each
    dealt exactly 7 days earlier, give or take a DST hour): 381 templates
    shift, 50 keep their dates (135 hands a copy). Without it a day held
    ~140 copies of a corpus day (R2.7b's "50 times a real day"). As
    stored: **982 408 hands** (59 047 files, 1.23 GB of text), **76 128
    named opponents** with hands together, the heaviest regular 16 361
    hands together; hero hands on the day of the median hand **978**, of
    the 90th-percentile hand 1 650, the busiest day 8 578 (a multi-tabler's
    day where copies overlap); 5 698 days with hero hands, 2001-2026 (the
    corpus's fixture files carry old dates); 19 374 sessions.
  - **`perf_gate`** (`core/rail-watch/examples/perf_gate/`): builds the
    dataset, measures a reference conversion rate before and after, imports
    through the real watcher (the backfill), runs the background pass
    (players' index, then the EV queue, timed; `--ev-budget` stops and
    extrapolates), the HUD delay (a hand appended to a live table file ->
    in the store + `hud_totals` of its players; 1 table x 15 hands, then 12
    tables finishing a hand at the same moment x 8), then every screen's
    store calls (warm: each first call after a commit with the OS cache
    warm, and again), then **cold**: the store's pages dropped from the OS
    cache without `sudo` (Linux `posix_fadvise(DONTNEED)`; macOS: the file
    rewritten through `F_NOCACHE` and renamed over itself - the flag is the
    vnode's, so it is cleared again after, or every later read bypasses the
    cache: the first A/B round was spoiled by exactly that and re-run) and
    the app's start (open, Today, Reports, a tab, Hands, Players), Reports
    as the very first screen, and the start as built (the warm-up, then the
    screens). Times are normalised to the M2 Pro by the reference rate
    (`--m2-reference 4200`), a smaller dataset scaled to 1M for the passes
    that read every hand; `--gate` fails on a budget x `--tolerance`
    (`BUDGETS`: the guideline's 1 s per screen, the plan's 10 ms for the
    HUD's lookup, regression budgets far under them; cold reads reported,
    not gated); `--json` / `--markdown` write the report; `--reuse` re-runs
    the queries on a kept store (how every A/B below was made).
  - **Results** (owner's M2 Pro, 10 cores / 16 GB; part of the evening
    another session's test run and Docker shared the machine - noted where
    it shows; before = `origin/staging`, after = this step; every query
    number is two interleaved runs or more):

    | Guideline §1 target | Measured on the 1M store | Before | After | |
    | --- | --- | ---: | ---: | --- |
    | Install to first HUD < 5 min | needs the HUD (Phase 3) | - | - | not yet measurable |
    | HUD delay after a hand < 1 s | appended -> in the store + the HUD's lookup, p95, 1 table / 12 at once | 0.52 / 0.56 s | 0.51 / 0.54 s | **met** (max 0.97 s / one hand of 15 at 1.64 s in the final run; 0.5 s of it is the reader's quiet period) |
    | | the HUD's lookup, 9 players (plan §3.3 < 10 ms) | 0.07 ms (p99 0.09) | 0.07 ms | met |
    | Local import >= 5 000 hands/s | 1M through the watcher, 8 threads | 12 158 hands/s | 10 061 hands/s* | **met** |
    | Report over 1M < 1 s | Reports opens (cash / everything), first call after a commit | 0.53-0.57 s | **0.29-0.33 s** | **met** |
    | | a breakdown tab by situation, first click (everything / cash) | **1.25-1.29 s** | **0.49-0.60 s** | **met** (was not) |
    | | the same, one stake / the button | 0.68-0.80 s | 0.27-0.37 s | met |
    | | Reports cold, after a cold Today (pages not cached) | 3.8-4.0 s | 2.5-2.6 s | not met |
    | | Reports cold as the very first screen | 4.8-5.1 s | 3.4-3.6 s | **not met** (inside the warm-up's first ~1.5 s) |
    | | after the start's warm-up (1.4-1.6 s in the background): Reports / a tab / Today / Players | - | 0.65 / 0.79-0.86 / 0.36-0.42 / 0.06-0.17 s | **met** |
    | | Today (latest session, its statistics and pots), first / cold | 0.07-0.38 / 1.39 s | 0.07-0.36 / 0.93-0.98 s | met |
    | | Hands: first page / the slowest filter / the chip counts | 12-18 / 60 / 250 ms | same | met |
    | | Players: list after a commit / profile / positions / hands with them, first page / slowest of 55 pages | 61-164 / 0.2 / 18 / 34-110 / 34-41 ms | same | met |
    | >= 12 tables with a HUD | needs the HUD; the pipeline part is the 12-table delay above | - | - | not yet measurable |
    | (store) | size; background after the 1M backfill: players' index / EV queue | 3.85 GB (4 108 B a hand); 8.5 s / 26 103 all-ins in 541 s | same | |

    \* the final run shared the machine with another session's tests (load
    4-7); the interleaved import A/B of the change (300k hands): 3
    threads 58-59 % -> 59 %, 8 threads 35-36 % -> 35-37 % efficiency
    (11 641-11 816 -> 11 698-12 140 hands/s) - no difference.
  - **Fix 1: the breakdowns' pass on four connections.** Profiled at 1M:
    SQLite's part of the pass (scan `hand_stats`, seek the hero's
    `seat_stats` row) is 0.52 s of the 1.25 s, Rust's decoding and five
    sums the rest; summing only a seat's non-zero values
    (`decode_seat_sparse` + `Totals::add_sparse`, ~7 of 97; unit-tested
    equal to `add_seat`) saved ~5-8 %. The pass is now split into four
    `id` ranges, each on a read connection of its own thread
    (`report::PASS_THREADS`; `Reader::with_many` takes the free
    connections but leaves one of the pool for other screens; the pool is
    `PASS_THREADS + 1` = 5, was 4), the sums added at the end.
  - **Fix 2: the bundled SQLite's global page-cache mutex**
    (`.cargo/config.toml`, `LIBSQLITE3_FLAGS`). The split pass first ran
    no faster - each of the four chunks took as long as the whole (~1.0 s):
    libsqlite3-sys compiles SQLite with `SQLITE_ENABLE_MEMORY_MANAGEMENT`,
    which puts every connection's page cache in one group behind one global
    mutex (`pcache1.separateCache = 0`), plus memory statistics (a global
    mutex per allocation), so a process's read connections take turns on
    every page. (Four `sqlite3` processes over the same ranges ran 3.3x
    faster than one.) Both off (`-USQLITE_ENABLE_MEMORY_MANAGEMENT
    -DSQLITE_DEFAULT_MEMSTATUS=0`; nothing calls `sqlite3_release_memory`
    or reads the memory statistics): **1.25-1.29 s -> 0.49-0.54 s**, cold
    1.8-2.6 s -> 0.9-1.0 s; one connection unchanged; the import unchanged
    (above). Applies to every build in the workspace (CI and `tauri build`
    included; an existing `LIBSQLITE3_FLAGS` in the environment wins).
  - **Fix 3: Reports opens with the two passes at once**
    (`Reader::report_open`: `hero_totals` and the graph on two
    connections; the app's `build_report` calls it): 0.53-0.57 s ->
    0.29-0.33 s warm, 3.8-4.0 s -> 2.5-2.6 s cold.
  - **Fix 4: a warm-up at start** (`Reader::warm_up`, run once by the
    statistics pass's thread before its first step, on its own
    `WARM_UP_CONNECTIONS` = 7): the counts, the latest session with its
    pots, the hero's totals (their EV adjustment reads the seat rows of
    every all-in hand at random: 2.4 s of a cold 1M store alone), the
    list in time order, the breakdowns, the opponents' summary - ~0.6 GB of
    the 3.85 GB file - all at once (a cold NVMe serves parallel reads far
    faster: 1.4-1.6 s in all, against 6-7 s one after the other). The
    results stay in the warm-up's own caches; what it buys is the OS cache.
  - **Not met, left**: a store opened cold and Reports clicked within the
    warm-up's first ~1.5 s waits 2.5-3.6 s. The rest is the EV
    adjustment's random reads (`ev_rows` -> `hand_stats` -> the hero's
    `seat_stats` row): it could come from `hand_list` (net, net in bb,
    position, segment, kind, date are there; the hero's seat is not - a
    column and a rebuild), measured first against the import. The R2.7c
    misses at a real opponent count: the list's first call after a commit
    58-178 ms (76k opponents; R2.7c's 0.17 s was 371k padded), the players'
    catch-up after a 1M backfill 8.5 s in the background, every page of a
    16k-hand regular 34-41 ms a page - no change needed. The HUD delay's
    one 1.6 s hand in 15 (FSEvents' coalescing or the machine's load) is
    for R3.x's 12-table test on the simulator.
  - **Nightly gate** (`.github/workflows/perf-nightly.yml`): `schedule`
    (01:23 UTC; runs on the default branch, `main`), `workflow_dispatch`
    (any branch, `hands` input) and on a pull request only when it is
    labelled `perf` - never on every PR. `ubuntu-latest` (4 vCPU, 16 GB),
    the full **1M** (disk freed first: ~1.3 GB of text, a ~4 GB store),
    `--workers $(nproc)`, `--ev-budget 240` (the rest of the EV queue
    extrapolated and left queued, as the app would show it), `--gate
    --tolerance 1.5 --min-efficiency 25` (a collapse guard until nightly
    runs calibrate it; the M2 Pro's 8 threads give 31-37 % at 1M), report
    as an artifact (JSON + markdown, 30 days) and in the job summary; the
    generated data is deleted at the end. Times are M2-equivalent (the
    runner's reference rate / 4 200); the CPU-bound budgets hold on any
    runner, the HUD delay is absolute, cold reads are reported only.
    Expected ~30-40 min with the build.
  - **Supabase** (`tests/scripts/supabase-perf/`, `npm run supabase:perf`;
    an isolated local stack - a copy of `supabase/` with its own project id
    and ports 5762x, `.temp/` deleted, stopped and its volumes removed
    after; Postgres in Docker on the M2 Pro, `shared_buffers` 128 MB). The
    corpus (7 496 hands) through `register_hand_source` + `ingest_hands`,
    its statistics rows with villains through `save_hand_stats` (15 hands
    left out: seats over 24, which `hand_stats_seat_ok` refuses) and
    `save_hand_ev`, as the user; then copied as `postgres` to **1 004 464
    hands** (6.0M `hand_stats` rows, 972k hero, 171k opponents; `hands`
    4.6 GB, `hand_stats` 4.0 GB). Each RPC as the user, first / again:

    | Report | everything | cash |
    | --- | ---: | ---: |
    | `stats_summary` | 7.8 / 6.7 s | 5.3 / 5.3 s |
    | `stats_graph` (60 buckets) | 5.2 / 4.8 s | 7.7 / 8.0 s |
    | `stats_breakdown` (each of 7 groups) | 7.8-10.4 s | 7.0-8.5 s |
    | `stats_opponents` (50) | 27.7 / 21.9 s | 43.6 / 41.2 s |
    | `stats_sessions` | 7.5 / 7.3 s | 8.5 / 5.4 s |

    **Not met, by 5-40x.** Even a bare four-column sum of the hero rows is
    1.6 s: `hand_stats_hero_idx` does not cover the counters, so it is a
    parallel scan of the whole 3.3 GB heap (villain rows interleaved).
    **Recommendation (not built; R4.x or before the web shows desktop
    libraries):** (1) a hero rollup maintained by `save_hand_stats` (as the
    desktop's `hero_rollups`: owner, version, the segment's dimensions,
    position, UTC day, kind, + the counters; for the breakdowns also pot
    type and players dealt in): a prototype built from these rows (311k
    rows, 306 MB here) answered the summary in **60 ms** and a month by pot
    type in 16 ms; (2) **`player_stats`** (owner, version, site, player +
    the counters) for `stats_opponents`: the top 50 in **0.2-0.6 ms**
    against 22-44 s - §3.5's "only if R2.9 shows it is needed": it is;
    (3) for the graph and sessions, which walk the hero's hands in time
    order, a covering partial index (`(owner_id, stats_version, played_at)
    include (net, net_bb_milli, wtsd, ...) where is_hero`, 72 MB): an
    index-only scan of the 972k rows in **110-180 ms** against 5-8 s.
    `save_hand_stats`' cost with (1)-(2) is to be measured when built.

### R2.10 Custom statistics — L
- Core exports per-seat decision events (street, position, facing — unopened,
  limped, raise level —, action, sizing class).
- A definition = opportunity filter + action filter over events (A11); editor
  in the app previews the value on the user's own hands as you type.
- Acceptance: the standard set re-expressed in the language matches the coded
  counters over the corpus (differences documented, as in `STATS-SPEC.md` §4).
- *As built* (§15): **done** - a user builds a statistic in Settings, sees
  its value on their own hands as they type, and finds it in Reports;
  the language re-expresses the standard set and matches the coded counters
  on every corpus row but twelve, which it cannot see by construction.
  [`docs/STATS-SPEC.md`](STATS-SPEC.md) §14 is the reference.
  - **Decision events** (`rail_stats::events`, `hand_events(&PhfHand)`):
    from the same `StatsContext` the counters walk (the same five decision
    types, raise levels with the straddle as a blind, preflop aggressor,
    called-cbet chain, steal attempt), one `SeatEvents` per dealt-in seat in
    `rows_for`'s order, one `DecisionEvent` per decision. Fields, 42 in all
    (§14.1): the hand (`bomb_pot`, `straddle`, `button_blind`, `walk`,
    `dealt`, `max_seats`, `preflop_raises`), the seat (`hero`, `position`,
    `posted_blind`, `big_blind`, `preflop_aggressor`, `stack_bb`,
    `effective_bb`, `saw_flop/turn/river`, `showdown`, `won`), the decision
    (`street`, `action`, `all_in`, `facing` none/limp/bet/raise,
    `raise_level`, `limpers`, `callers`, `first_on_street`,
    `first_at_level`, `checked_before`, `own_raise`, `facing_steal`,
    `facing_cbet`, `barrels`, `initiative`, `ahead_of_aggressor`,
    `in_position`, `players`, `multiway`, `pot_bb`, `size_bb`, `size_pot`,
    `facing_size_pot`). Sizes in thousandths, rounded down, no value when
    the hand cannot give one (no big blind, a check). `EVENTS_VERSION`
    (`events/1`) recounts every custom statistic when it changes. No
    counter changed: `rows_for` does not read events (R2.1's goldens and
    every parity test unchanged).
  - **Predicate language** (`rail_config::stats::predicate`, parsed like
    R2.4's formulas, evaluated by `rail_stats::custom::CustomCounter`):
    `mode opportunity => action`, modes `first` / `any` (once per hand, as
    the coded preflop counters) / `each`; `and`, `or`, `not`, parentheses;
    comparisons `= != < <= > >=` and `in (...)` against the field's kind
    (yes/no, number with up to three decimals, a choice of words). No
    arithmetic, no functions; 1 000 bytes, 32 levels, 32 values in a list.
    Errors carry a byte offset and length (an unknown field with its
    nearest name, a word that is not the field's, a comparison its kind
    has not, ...), which the editor underlines.
  - **A user's statistic** (`rail_stats::custom::CustomSet`): an R2.4
    `StatDef` plus an optional predicate; with one it has the counters
    `<id>` and `<id>_opp`, read by its formula (default `pct(<id>,
    <id>_opp)`) and by other custom formulas, through a new
    `display::Variable::Custom` and `Sums::custom` (empty for every shipped
    definition: their values are unchanged). Validated as the shipped file
    is (`rail_config::stats::check_definition`, new) plus: an id may not be
    a shipped id, a counter, another statistic or another statistic's
    counter; a statistic whose counters another formula reads can be
    neither renamed nor deleted; a formula reading the all-in EV is the
    hero's. Problems name the part (id, predicate, formula, sample, other)
    and carry spans.
  - **Acceptance** (`core/rail-stats/tests/custom_acceptance.rs`, in CI):
    57 predicates - VPIP, PFR, RFI, iso, limp, cold call, 3-bet, 4-bet,
    5-bet, squeeze, steal, fold to steal / 3-bet / 4-bet with their call and
    raise legs, cbet flop / turn / river, fold to cbet with its legs on
    every street, donk and check-raise on every street, the fifteen raw
    action counts, and the showdown family (saw flop, WTSD, WWSF, W$SD) -
    against the coded counters on **every dealt-in seat of the 8 422 corpus
    hands (51 464 rows)**: **every preflop and postflop counter equal on
    every row**, opportunities and made, legs included (every judgement call
    of STATS-SPEC §4 is expressible). **The showdown family differs on 12
    rows**: seats that never made a decision in the hand (all in by a blind
    or the antes, a bomb-pot player all in by the bomb ante) see the flop,
    so `flop_seen` counts them, but the language reaches a seat only through
    its decisions; the test checks every differing row is such a seat. Not
    closed (a synthetic "dealt in" event would): the coded WTSD / WWSF / W$SD
    stay what reports show. Table and reasons: STATS-SPEC §14.4.
  - **Storage** (store migration 11, tested from every earlier version -
    `migrates_from_empty_and_from_every_earlier_version`, plus a version-10
    store with hands, `an_older_store_gets_the_tables`): `custom_stats`
    (the definitions, in the user's store: `stat_key`, `rev`, the definition
    JSON, the predicate, order, `counted_to`; `AUTOINCREMENT` ids, never
    reused), `custom_hero_rows` (the hero's counts per hand),
    `custom_hero_rollups` (segment, position, UTC day, kind - as
    `hero_rollups`), `custom_player_rollups` (site, player, scope, segment,
    bomb pots out - as `player_rollups`); `kv` `custom.events_version`
    (`core/rail-store/SCHEMA.md` "Custom statistics"). The older-store
    tests' shared downgrade (`DOWN_FROM_9`) drops the new tables first.
  - **Compute: in the background pass, not at import.** Measured first
    (release, M2 Pro, the corpus): building a hand's events costs
    ~4.8 µs and the 57 acceptance predicates on every seat ~9 µs
    (~0.16 µs a predicate a hand), next to `rows_for`'s ~6.6 µs - cheap on
    the import threads. What is not cheap is the **writer**: a row per hand
    and rollup increments per statistic and kept seat, in the import's
    transaction, which is the pipeline's bottleneck (R1.6, R2.3, R2.7c's
    "second pass": every page the import touches costs). So imports only
    wake the pass; `custom_step` (after the rebuild and the players'
    index, before the EV queue) reads the next 1 000 `hand_stats` rows past
    the lowest `counted_to`, decompresses each PHF once, builds its events
    once and counts every statistic still below that hand, and one writer
    transaction writes the rows, adds the rollups and moves `counted_to`
    for each statistic whose `rev` and `counted_to` are unchanged (a page
    computed before an edit is dropped and read again). **~26 000 hands a
    second on one thread** for one statistic (~39 µs a hand), ~34 µs a hand for
    three more at once (`the_pass_counts_this_fast`, ignored test): a new statistic over
    1M hands is ~40 s of one core; a hand just imported is counted on the
    pass's next step. A rebuild of the coded statistics gives every hand a
    new `hand_stats` id, so `begin_rebuild` clears all custom counts and the
    pass counts them again after it; nothing custom runs during a rebuild.
    The pass pauses for backfills as before (not for open tables: it is
    cheap). **Import gate**: the import path is unchanged; `import_bench`
    locally (50k hands, 3 threads, M2 Pro under load ~3.5): **58 / 58 %**
    efficiency (gate 45 %), as R2.9 measured before (58-59 %).
  - **Tests**: the acceptance test; `tests/events.rs` (sizes, pot,
    position, barrels, steal and cbet facts on pinned hands, and counters on
    them); `custom.rs` unit tests (compile, cross-reads, every refusal with
    its span, renames refused while read); `rail_config` predicate tests
    (precedence, modes, every error with offset and length, the limits);
    `core/rail-store/tests/custom.rs` - the standard counters in the
    language summed by the store equal the coded ones over eight report
    filters (dates with partial days, one day, segments and positions,
    `aggregate`'s options) and in every `player_rollups` row; a rename keeps
    the counts, a new predicate recounts, a stale page is not written, a
    rebuild recounts to the same numbers, a delete leaves nothing; imports
    are counted as they come.
  - **App** (`app/src-tauri/src/custom_stats.rs`, thin): `custom_stats_list`
    (the statistics with their value over every hero hand counted so far
    and the pass's progress; the language's fields), `custom_stat_check`
    (problems with spans, and a **preview**: a predicate counted on the
    hero's last 5 000 hands - read from the store once and kept 60 s, so a
    keystroke costs microseconds; a formula over the coded counters shown
    over every hand at once), `custom_stat_save`, `custom_stat_delete`
    (refused while another formula reads it). `stat_definitions` now
    returns the shipped definitions then the user's (`custom: true`);
    Reports' summary appends the user's statistics over the same filter
    (`ids` beside `stats`, matched by id in the window).
  - **Editor** (Settings, "Your statistics"; the palette opens it):
    the list with each statistic's value over all hands (with its
    reliability), "Counting: x of y hands" while the pass works, edit,
    delete (a dialog); the editor - name, short label, id (derived from the
    name, editable), group, description, the counter and the formula as
    code fields with the problem's span underlined in place (byte offsets
    turned into the text's characters, so Croatian letters before an error
    do not shift it), unit, decimals, minimum sample, a sample formula,
    colour bands; a live preview ("On your last 5,000 hands: 37.1% · taken
    153 times of 412 chances"), checked as the user types (250 ms pause,
    with stand-ins until the name and label exist); examples (cbet in 3-bet
    pots, fold to a multiway cbet, small cbet, open above 3 bb, short-stack
    open shove, river call against a pot-size bet) and the field reference.
    Reports lists a user's statistic in its group, marked "(yours)". `en` +
    `hr` (the language's own error messages are English, as R2.4's formula
    errors). Checked in a browser against a mocked IPC with made-up data:
    1280 and 900 px, dark and light, English and Croatian, underlines,
    preview, save, delete, Reports.
  - **For R2.11** (targeted recompute): a custom statistic already
    recomputes only itself - a changed predicate clears and recounts that
    statistic alone (`rev`), a changed formula, label or format recounts
    nothing (the formula reads the counts); `CustomSet::reader_of` /
    `Expr::names()` are the dependency map between custom statistics. What
    R2.11 adds is the same for the coded layer (today a `STATS_VERSION`
    bump rebuilds everything and, with it, every custom count - the
    rebuild's new `hand_stats` ids force it; keeping ids stable across a
    rebuild would let custom counts survive a coded change they do not
    depend on). **For R3.9** (HUD editor): the definitions API already
    lists the user's statistics (`stat_definitions`, `custom: true`); the
    HUD's lookup is `Reader::custom_player_totals(site, player, scope,
    segments, ids)` (one key range per statistic) beside `hud_totals`, the
    values `CustomSet::sums` + `DisplayStat::show` as for the shipped ones;
    an opaque-id villain's scope is the session scope as for the coded
    rollups; a statistic's `hud` membership is the user's override layer
    (`hud_layouts`), as for shipped ones. A custom count lags an import by
    the pass's next step (milliseconds when idle; behind a backfill, which
    pauses the pass): if the HUD needs it within the same 1 s as the coded
    counters, R3.7 can wake the pass on `hand_imported` (it does already)
    or count the HUD's statistics for the new hand at import.
  - **Not done / web**: the web does not show users' statistics (the
    evaluator is Rust; R4.1's WASM core or a TypeScript port of
    `events.rs` + `custom.rs` would); custom statistics are local, not
    synced.

### R2.11 Targeted recompute — S
- Dependency map definition → counters; a definition change recomputes only
  what it touches, in the background.
- *As built* (§15): **done** - a definition change recomputes what it
  touches, beside the statistics the screens show, and swaps the result in
  with one commit; every hand keeps its `hand_stats.id`, so the user's own
  counts survive a recompute that moves no seat.
  [`core/rail-store/SCHEMA.md`](../core/rail-store/SCHEMA.md) "Targeted
  recompute" is the reference.
  - **Dependency map, as data** (`rail_store::recompute::DEPENDENCIES`, one
    line per change: the work and every table it writes, with how much):

    | Change | Work | Writes | Untouched |
    | --- | --- | --- | --- |
    | label, name, description, format, bands, sample, HUD membership | nothing | - | everything |
    | a formula over counters the store has (shipped or custom) | nothing (evaluated when read) | - | everything |
    | a custom predicate | the custom pass counts that statistic again | its custom rows and rollups | the rest |
    | `EVENTS_VERSION` | every custom statistic counted again | the custom tables | coded statistics, EV |
    | `STATS_VERSION` (a counter, money, a hand or seat column, the kept rows) | **rows job**: every hand derived from its PHF, compared | `hand_stats` / `seat_stats` / `hand_list` rows of the hands that differ (staged; `stats_version` stamped on the rest); rollups, `player_summary`, `player_hidden` summed again into twins and swapped; `player_hands` of rewritten seats; EV of hands whose hero seat or result changed; custom counts **only if** a seat moved between rollup keys | everything else |
    | `SEGMENT_VERSION` (new constant, `segment/1`) | **segments job**: each hand's segment from its PHF, the stored seat rows regrouped - no statistic derived | `segment_id` of the hands that move; the four summed tables (twins); custom counts if any moved | `seat_stats`, `player_hands`, EV |
    | `EV_VERSION` | **EV job**: every hero hand not queued, evaluated beside | `ev_rows` (swapped), `hand_list.all_in` where a row came or went | every statistic |

    `tests/recompute.rs` checks the map against the schema (every derived
    table named, every other one listed as not derived) and, per change,
    that every table the line does not name is identical after the job.
  - **How a job runs** (`rail_store::recompute`; store migration 12,
    `0012_recompute.sql`, tested from every earlier version): pages of 500
    hands in `hands` rowid order (a hand imported meanwhile has a higher
    rowid, so the job reaches it too); on the pass's thread, outside any
    write, each PHF read back, derived (`PreparedStats::from_phf`) and
    compared with its stored rows column by column (`hand_stats` but
    `stats_version`, the seat rows, the list row but `all_in`, which
    belongs to EV); in one writer transaction per page, the hands that
    differ staged by part (`recompute_hands` / `_seats` / `_list`), the
    others' `stats_version` stamped, every hand's new rows summed into the
    twins of the four summed tables (`stats::Pending` with
    `Target::Shadow`), a hand with no rows at all (a store from before
    migration 6) written at once as an import writes it, the cursor moved.
    The **swap**, one transaction once no hand is left: the staged parts
    written in place (the id stays; seat rows replaced with their
    `player_hands` entries; the list row's all-in flag carried over or set
    by the new EV plan; EV rows settled or queued for the hands whose hero
    changed), each summed table renamed with its twin (`ALTER TABLE ...
    RENAME`: the swap does not copy the rollups), the custom counts cleared
    only if a seat moved, the versions set, `kv` `stats.epoch` moved on.
    The EV job lists every hero hand not in `ev_pending` in `recompute_ev`,
    evaluates up to 256 a page until 250 ms have gone
    (`rail_equity::all_in_street` first: no all-in, no row, nothing
    derived), and its swap writes the rows whose existence or value changed.
  - **Stable ids, decided: kept.** R2.3's rebuild deleted each hand's
    `hand_stats` row and inserted a new one, so every custom count (keyed by
    that id) was cleared and counted again (~23 s per statistic at 500k).
    Now a hand's row is updated in place and keeps its id for good (hands
    are never deleted, so ids only grow); the custom counts are made from
    the decision events and the kept seats, which a coded change does not
    touch, so they survive unless a seat moves between rollup keys (its
    segment, kind or day, a seat's player, scope or position) - detected per
    hand by the comparison, not trusted to the map - and then the swap
    clears them and the pass counts again (it waits meanwhile).
  - **Targeted counters from stored PHF, decided: derive every hand,
    write only what differs.** A `STATS_VERSION` bump cannot know which
    hands a changed counter touches without deriving them, and deriving is
    the cheap part (~40-60 µs a hand); what R2.3 paid for was the writes -
    every `hand_stats`, `seat_stats` and `hand_list` row deleted and
    inserted, the players' index and the custom counts redone. Rewriting
    only the changed counters of each blob was considered and not built: a
    blob is a whole seat's values and the comparison finds the changed
    seats anyway; the staged seat rows are exactly those. A per-version
    list of changed counters (to skip the comparison) was not built either:
    the comparison is what makes a wrong declaration harmless.
  - **Consistent reads.** Every `Reader::with` is one read transaction now,
    so an answer is the store as of one commit; an answer spread over
    several connections (Reports opening: the totals and the graph at once;
    the breakdowns' four `id` ranges) reads `stats.epoch` before and after
    and runs again if a swap came between (`Reader::same_epoch`). The EV
    adjustment reads every stored row whatever its version (a hand is in
    `ev_rows`, in `ev_pending` or neither, never both - queueing drops the
    row; an open deletes R2.3's leftovers), so the old rows count until the
    EV swap. **Test** (`readers_never_see_a_half_done_recompute`): the
    screens' and the HUD's reads (hero totals, the HUD lookup, the Players
    list, the breakdowns, Reports opening cash and everything) in a loop on
    the store's pool and on a second `Reader` (the HUD's process) while a
    rows job (a counter and the money changed) and then an EV job run and
    swap: every answer equals the older store's or the clean import's
    (e.g. 1 110 old and 180 new answers in one run, 2 573 / 91 for EV).
  - **Background job.** One thread, a page at a time; after the players'
    index and the custom counts of new hands (cheap, they keep new hands
    complete), before the EV queue; paused while a backfill imports, and -
    the whole recompute, rows and EV - while tables are open
    (`set_tables_open`; R2.3 let its rebuild run then). Resumable: the state
    is in `kv` (`recompute.rows.*`, `recompute.ev.*`) and the work tables,
    written in each page's transaction; a build of other versions starts
    the job again; a stale page is dropped. Not given an OS priority (the
    crate has no `unsafe`; a page is a fraction of a second).
  - **Progress in the app**: `stats_status` gains the job (`rows` /
    `segments`), whether it fills a store that had no statistics, and the
    EV job's progress; activity `recomputing-ev`. Reports, Hands and Players
    show it in their notice line (`components/RecomputeNotice.tsx`: "You see
    the previous numbers until it is done", or the screen's "fills as it
    goes" while it fills), Settings under "Your statistics"; a swap emits
    `stats-changed` (a thread watching the pass's epoch) and Reports,
    Hands, Players and Today read again. `en` + `hr`. The debug panel shows
    the EV job. The tray shows nothing new (its lines are the watcher's,
    the account's and sync's).
  - **Crash safety** (`tests/crash.rs`,
    `crash_mid_recompute_is_consistent_and_resumes`): a clean corpus import
    made "older" (a counter, the money, the segments and the EV changed by
    hand, the rollups rewritten from the rows), opened by a child process
    that runs both jobs and is killed at random moments, between and inside
    pages, and inside each swap it holds open; after every kill integrity,
    the rollups equal the rows, the screens' tables are the old store's or
    the clean import's (never new EV over old rows), and each job's progress
    never goes back (the next child resumes); the last child's store equals
    the clean import. R1.2's import crash test unchanged and green.
  - **Measured at 500k** (`cargo run --release -p rail-store --example
    recompute_bench`, new; a 497 809-hand store from `import_bench --hands
    500000 --rename-players --spread`, generated, deleted after, never
    committed; the R2.3 column is staging's build on a copy of the same
    store with a scratch example that is not committed; one thread; the
    owner's M2 Pro with the flop library's solves on it, load 9-11):

    | Change | Before (R2.3) | After (R2.11) |
    | --- | --- | --- |
    | (a) a custom predicate | 21-24 s (that statistic counted again: R2.10 already targeted it) | 21.2 s; a label or formula edit 0 s |
    | (b) the segment definition | the full rebuild below: 84.3 s | **28.2 s** (segments job 28.0 s, swap 0.24 s): no statistic derived, nothing staged when no hand moves, custom counts kept |
    | (c) `EV_VERSION` | every hero hand (468 962) queued, 8 a transaction: 60 s for the hands without a preflop all-in (7 818 hands/s) + the 13 265 preflop all-ins at 25.4 ms ≈ 337 s: **~397 s**, the all-in EV "waiting" on every report meanwhile | EV job 30.1 s for the 468 962 (15 565 hands/s: no derivation without an all-in) + the same ~337 s of enumeration: **~367 s**, the old EV shown until the swap |
    | (d) `STATS_VERSION`, nothing changed ("rebuild statistics") | full rebuild 53.0 s, rollups empty and growing meanwhile; then the players' index again 4.3 s and the custom statistic counted again 27.0 s: **84.3 s** | **36.1 s**, 0 staged, swap 43 ms, nothing counted again |
    | (d) `STATS_VERSION`, a counter changed on 1 opponent seat in 10 (249 636 hands) | 84.3 s | **46.4 s** (42.2 s + swap 4.1 s), custom counts kept |
    | (d) every hero list row changed (482 227 hands: the swap's worst case) | 84.3 s | **45.8 s** (43.1 s + swap 2.6 s) |

    The swap holds the writer while it runs; it happens only with no table
    open and no backfill (both pause the job). The first version wrote every
    staged hand with a statement each: 6.5 s and 4.8 s for the two large
    cases; a seat-blob-only part (`parts` 16) and list rows written in one
    `UPDATE ... FROM` each brought them to 4.1 s and 2.6 s. Before R2.11 the
    pass had no swap; it had the rollups empty for 53 s instead.
  - **Tests**: `tests/recompute.rs` (the map against the schema; a rebuild
    that finds nothing stages nothing and changes nothing; a counter change
    stages exactly the changed hands, keeps every id and the custom counts,
    counts nothing again, leaves the unnamed tables identical; a money
    change fixes the list and the Players list's lines; a segment change
    regroups without touching seat rows, EV or `player_hands`, recounts the
    custom statistic to the same numbers; an EV change leaves the reports'
    EV as it was until the swap; a store an older build left mid-rebuild is
    finished; readers during both jobs), the crash test above, and the
    earlier tests adapted (a rebuild keeps the generation and the custom
    counts; tables open now pause the recompute). Every parity test is
    unchanged and green: no statistic is computed differently. The import
    path's only change is `Pending`'s refactor (a target, the count split
    out): `import_bench` locally, 50k hands, 3 threads, load ~10: **50-51 %**
    efficiency (gate 45 %); the random-append and import crash tests green.
  - **For R3.x (HUD)**: read through `Reader` (each lookup a snapshot);
    `StatsWorker::set_tables_open(true)` while drawing pauses recompute and
    EV; listen for the store's epoch (`StatsStatus::epoch`, the app's
    `stats-changed`) to re-read every table's players after a swap; a
    custom statistic's HUD value is `custom_player_totals`, cleared and
    counted again only when a recompute moved seats.

### Phase 2 summary (after R2.11)

R2.1-R2.11 are on `staging`: the statistics engine, all-in EV, rollups and
segments, displayed statistics as data, sample reliability, the shared UI
package, the four desktop screens and Settings, the polish, the 1M benchmark
and its nightly gate, custom statistics and targeted recompute.

**Exit criterion: "the performance targets (guideline §1) hold on a 1M-hand
benchmark database, on the development Mac and on a mid-range Windows
laptop."** From R2.9's measurements on the 1M store (982 408 hands, the
owner's M2 Pro), unchanged by R2.10-R2.11 (no change to the import, the
rollups' reads or the screens' queries; every read is now one transaction,
two statements more):

| Guideline §1 target | On the 1M store | Status |
| --- | --- | --- |
| Local import >= 5 000 hands/s | 10 061-12 158 hands/s through the watcher, 8 threads | **met** |
| HUD delay < 1 s (the pipeline's part) | p95 0.51-0.56 s, 1 table and 12 at once; the HUD's lookup 0.07 ms | **met** for the store's part; the HUD itself is Phase 3 |
| Report over 1M < 1 s | Reports opening 0.29-0.33 s, a breakdown tab 0.49-0.60 s, Today, Hands and Players well under, all warm or after the start's background warm-up (1.4-1.6 s) | **met** |
| | Reports opened on a cold store within the warm-up's first ~1.5 s: 2.5-3.6 s | **not met** |
| Install to first HUD < 5 min; >= 12 tables with a HUD | need the HUD | Phase 3 |
| On a mid-range Windows laptop | not measured (the nightly gate runs on Linux; normalised to the M2) | **open** |

**What remains of Phase 2.** (1) The cold-start Reports case: the EV
adjustment's random reads (`ev_rows` -> `hand_stats` -> the hero's
`seat_stats` row) - R2.9's candidate is the hero's seat in `hand_list`
(one column, filled by a rows job now, without a rebuild's cost) so the
adjustment reads only the list, measured against the import first. (2) The
same measurements on a mid-range Windows laptop (`perf_gate` runs there as
it is). (3) The nightly gate's thresholds, calibrated from its first runs.
The web side of R2.9 (server rollups, `player_stats`) and custom statistics
on the web are Phase 4.

**What Phase 3 needs from Phase 2** (all there): the read API for the HUD
(`Reader::hud_totals`, `custom_player_totals`, `player_notes`, the session
scope of opaque ids) in a process of its own; `StatsWorker::set_tables_open`
- now pausing the recompute and EV, the hook R3.x calls while tables are
open; `stats_status`'s epoch (`stats-changed`) to redraw after a recompute;
the display definitions' `label`, `tone`, `full` and `hud` membership; and
migration 13 for `hud_layouts`. The HUD delay's one 1.6 s outlier in 15
(R2.9) is for R3.14's 12-table test.

---

## Phase 3 — HUD

**Goal.** A HUD that reads at a glance, on rooms that allow it, Windows first.

**Exit.** HUD on 12 simultaneous tables on Windows and macOS within budget
(§3.3), only on rooms whose `hud.allowed` is `true`.

### R3.0 Compliance check — M
- Per room: HUD policy, the exact page it comes from, the date, and whether the
  client writes live files and persistent names. Into `sites.json` (`hud`
  block); the README table (§6) updated from it; owner signs off.
- From R0.12: every `hud.allowed` is `null` and a test
  (`every_hud_policy_is_unknown_until_r3_0`) holds it; R3.0 replaces that
  test with the owner-signed list. `allowed: true` needs an `https://`
  `source` and `checkedAt`, and is refused on a `network` entry, so split
  those first. The `tables` block (process names, a title regex with a
  `table` group, `seatLayouts`, `preferredSeat`) stays `null` until R3.3 /
  R3.6 / R3.11 read it from the clients, which also relax the tables part
  of `only_what_was_seen_is_verified` (R0.12's `nothing_is_verified_yet`,
  renamed in R1.4).
- Repeat before every release (checklist in §12).
- *As built, R3.0* (§15) - **signed by the owner on 2026-10-14, merged
  in #187**:
  - Every entry's `hud` block from the room's own page, read 2026-10-14
    without signing in; quotes, URLs, live files, names, confidence and the
    re-check checklist in `docs/research/HUD-POLICIES.md`.
  - **`true` (3)**: `pokerstars` (Third Party Tools and Services Policy on
    pokerstars.uk - pokerstars.com is blocked from Croatia - and its
    Reference Guide of 21 Sep 2026: own hands only, raw counts, colour by
    at most two raw thresholds, pop-ups yes; no card-split statistics, no
    display switching on position / stacks or on tendencies, no labels, no
    hand charts), `winamax` (poker rules 1.2: tracking / profiling software
    such as HoldemManager and PokerTracker is authorised; unlisted tools
    need integrity@winamax.com's approval - Rail is of the listed kind),
    `acr` (policy 4.1.3: HUDs with numeric stats from your own hands,
    nothing from the hand in play; 4.2.11: nothing may overlap ACR's own
    table graphics). These restrictions are requirements on R3.6 - R3.9:
    on PokerStars the HUD must not show R2.10 custom statistics with card
    predicates, switch statistics by position or stack, or colour by more
    than two thresholds.
  - **`false` (15)**: by policy GGPoker (SEP: "solvers, charts, or HUDs are
    prohibited"), partypoker (ten permitted table tools, no HUD), Unibet,
    CoinPoker (banned since June 2026; page read through a search
    engine's copy, it refuses scripted fetches), WPT Global (Annex A item
    24); Ignition (anonymous names); PokerBros (no desktop client); the
    seven closed rooms and networks; `standard` (not a room).
  - **`null` (4)**: `888poker` (888poker.com blocked from Croatia; the
    Ontario and Danish user agreements permit trackers of information "at
    that specific table", which may mean the session only), `ipoker` and
    `chico` (networks: no skin's own page could be read or says so),
    `weplay` (rules only in the app).
  - **No network split**: R0.12's rule stands; a skin gets a room entry
    once its own page allows a HUD (BetOnline is the first candidate).
  - Also changed: `ignition.operating` `true` (its pages are live);
    `partypoker.files.live` `false` (MyGame downloads, from its own page);
    every researched entry's `docs` lists `HUD-POLICIES.md`.
  - Tests: `every_hud_policy_is_unknown_until_r3_0` is now
    `hud_policies_are_the_signed_list` - the (id, allowed, source) list,
    every `checkedAt` 2026-10-14, a note on every entry, a repository
    source exists, and `hud_permitted()` exactly for `pokerstars`, `winamax`
    and `acr`; new `a_remote_file_can_switch_an_allowed_hud_off`; the
    validator and merge tests moved from `winamax` / `pokerstars` to
    `888poker` (still unknown); the ajv test pins the same list. The
    validator rules are unchanged.
  - **For the owner** (beyond the HUD): GGPoker's SEP 7.2 bars third-party
    tools that import or convert hand histories - Rail's GG import may fall
    under it.

### R3.1 Table simulator (`rail-hud-sim`) — M
- Opens N windows titled like a given room's tables, at that room's sizes, and
  writes real corpus hands into a hand-history folder at play speed.
- Runs on both systems and in CI; drives the watcher (Phase 1 exit check) and
  every HUD test below.
- *As built* (§15): **done** - `hud/rail-hud-sim`, a library (the
  simulator without its windows) and the binary `rail-hud-sim` (the
  windows, the command line). `#![forbid(unsafe_code)]`, workspace lints.
  How to run it: README §8 "Table simulator".
  - **Windowing: `winit` =0.30.13 + `softbuffer` =0.4.8 + `font8x8`
    =0.3.1**, all without default features. Each window is a plain
    top-level OS window (`NSWindow`, `HWND`, X11/Wayland surface) whose
    frame is drawn on the CPU (`rail_hud_sim::draw`, integer geometry, an
    8x8 bitmap font: no font file, no shaping) and handed to the OS by
    softbuffer. Chosen over `eframe`/`egui` because that needs a GPU API:
    `glow` wants OpenGL (a GitHub Windows runner has only GDI's OpenGL
    1.1) and `wgpu` is large; a simulator needs titles, rectangles and a
    few words, not widgets, and must run on CI runners and in virtual
    machines. Release binary 4.8 MB on macOS arm64, most of it the core.
    Linux compiles with no system packages (X11 and Wayland are loaded at
    run time); not run there with windows.
  - **Rooms** (`hud/rail-hud-sim/rooms.json`, compiled in; every choice
    tagged SOURCED / PARTLY SOURCED / INVENTED in its `sources`, a test
    holds that):

    | | PokerStars | Winamax | ACR |
    | --- | --- | --- | --- |
    | Hands used | `PokerStars Game/Hand #` (no Zoom, no Home Game): 104 | cash: 34 | era C (`Hand #`, `Game Hand #`) only: 6 |
    | Cash sizes | 6, 9, 2 (sourced) | 5, 2, 9 (sourced: no 6-max in the corpus) | 6, 9 (1 and 3 hands) |
    | Tournaments | yes (9 hands; 2-, 6-, 9-, 10-max) | none in the corpus: refused | yes (8-, 9-max) |
    | Window title | `{table} - {stakes} {currency} - {game} - Logged In as {hero}`; tournament `Tournament {tid} Table {tno} - {game} - ...` (invented) | `{table} - {game} - {stakes}` (invented) | `{table} - {stakes} {game} - {size}-max`; tournament `{tname} ({tid}) Table {tno} - {game}` (invented) |
    | File name | `HH{date} {table} - {stakes} - {currency} {game}.txt` (shape sourced, money form invented); tournament `HH{date} T{tid} {game}.txt` (invented) | `{date}_{table}_real_{game}.txt` (invented) | `HH{date} CASHID-G{gid}TN-{table} GAMETYPE-{game}.txt` (partly sourced from fpdb's file names); tournament `SCHEDULEDID-G{tid}TN-...` |
    | Encoding, line ends | UTF-8 BOM, LF (sourced) | UTF-8 BOM, LF (sourced) | UTF-8, LF (era C; `--encoding utf-16le` for the older files' form) |
    | After each hand | 3 line ends (two blank lines, sourced) | 6 (five blank lines, sourced) | 2 (one blank line, partly sourced) |
    | Hero's deal line | after `*** HOLE CARDS ***` | before `*** PRE-FLOP ***` | after `*** HOLE CARDS ***` |

    Table names are the corpus's own (`Hygiea IV 40-100 bb`, `Florence 03`,
    `Miramar (Cap)`), one per table, never two tables alike; a tournament
    table's name is what the room's hands carry (`{tid} {tno}` PokerStars,
    `{tno}` ACR). `{date}` is the hand's UTC date, so a table writes one
    file per day like PokerStars.
  - **A hand** is a corpus hand rewritten for its table
    (`rail_hud_sim::rewrite`): the hand id (globally increasing, from the
    clock in ms, so runs do not collide in a store; Winamax's
    `{table}-{n}-{unix}` form kept), the table name on the table line, the
    tournament id, every timestamp of the header moved by one shift to now
    (the core reads a stamp as written, so the hand is played "now" in
    whatever zone it is labelled; a dual-zone header keeps its offset), the
    seats rotated so the hero sits in the table's hero seat (positions
    unchanged), and every name replaced by the table's player of that seat
    (one cast per table, unique in the run; the hero `--hero`, default
    `SimHero`, at every table). Most corpus hands have no hero (fixtures
    seen from the rail): one dealt-in player becomes the hero and a
    `Dealt to` line is added where the room prints it, with the cards that
    player showed, or cards nobody holds and the board does not use. The
    result is converted with the room's parser and must read back as one
    hand with exactly the new id, table, tournament, names, seats, stacks,
    hero, positions, button and number of actions; otherwise another hand
    is taken. A test rewrites every usable hand for every hero seat.
  - **Tables and speed.** `--speed` hands per minute per table (default 2,
    hundredths allowed), `--jitter` +- percent (30); a new table's first
    hand within half an interval. A table's stakes come from one hand
    (title, file name); its later hands have the same blinds and currency
    when the corpus has three such, else the same currency (the corpus is
    small: stakes may vary within a table). Each hand is appended in one
    write (the whole hand and its separator) and flushed, the way a client
    writes a finished hand; a BOM only at a new file's start.
  - **Its own folder only.** Default output a new folder under the system
    temporary directory; `--out` must be empty or hold the marker
    `.rail-hud-sim` (hidden: the watcher skips it), and a path with a
    `HandHistory` / `hands` component is refused outright. Nothing is
    written under the repository.
  - **Controls.** Command line (`--help`); commands on standard input or in
    `--script` (with `wait <ms>`): `pause`, `resume`, `speed`, `faster`,
    `slower`, `open [size]`, `close`, `hand`, `tablemove` (new table name
    and title, new opponents, new hero seat), `move`, `resize`, `minimize`,
    `restore`, `focus`, `tile`, `status`, `quit`; keys in a window (space,
    +/-, H, T, N, W, M, arrows, Q). Events are JSON lines on standard
    output: `started` (with the title regex), `table`, `hand` (hand id and
    store key, table name, file, players, bytes, write time in ms), `window`
    (position and client size in physical pixels, minimised; sent once the
    first frame is shown and 400 ms after a window command or an OS move or
    resize, when the window has settled - a minimise animates on macOS),
    `closed`, `paused`, `speed`, `status`, `done`, `error`.
  - **Not a client.** The process is `rail-hud-sim`; every frame carries
    "RAIL TABLE SIMULATOR - not a poker client" across the top; windows
    open without taking focus.
  - **Test-only title regex** (`room::title_regex`): the room's title
    template with its text escaped, `{table}` / `{tid}` / `{tno}` as named
    groups and every other field a lazy wildcard, anchored; printed by
    `--title-regex` and in `started`. `room::table_from_title` reads the
    hands' table name back from a title (tournaments through
    `tableFromTitle`). Tests check it on every title the simulator makes,
    after a table move too. It claims nothing about real clients:
    `sites.json` `tables.title` stays theirs (R3.3, R3.11).
  - **Tests.** 20 unit tests (rooms file, dates, rewrite of every corpus
    hand for every hero seat, titles read back per room and kind, drawing at
    any size, encodings, the folder guard) and `tests/smoke.rs` (the binary,
    headless: 3 tables, 20 hands per room - PokerStars, Winamax, ACR, ACR in
    UTF-16LE with CRLF, PokerStars tournaments - each folder read back
    through `rail_core::convert` with the room detected first and no
    refusal; commands from standard input; a foreign folder refused) - in
    `cargo test` on Linux, macOS and Windows. **CI**: job `core` on macOS
    and Windows also runs it with windows (3 tables, 20 hands, every window
    must show a frame, then `rail-hud-sim verify`).
  - **End to end** (`examples/e2e.rs`, on the dev machine): the simulator
    binary writes, `rail_watch::Watcher` imports into a fresh store, and the
    latency is from the `hand` event until the store has the hand and every
    player of it has a rollup counting all their hands so far
    (`Reader::hud_totals`). M2 Pro, debug build: PokerStars 3 tables 15
    hands p50 516 / p95 523 / max 527 ms; Winamax 24 hands 512 / 517 / 528;
    ACR 24 hands 516 / 522 / 530; **12 tables with windows**, 48 hands,
    514 / 523 / 554 ms; none over 1 s. §3.3's < 1 s holds; the aim of
    250 ms does not, for the reason R1.3 measured: a table's newest hand
    is the last in its file, so the watcher's 500 ms quiet period is the
    floor (a hand the next hand's header completes takes 15-24 ms).
  - **Limits.** ACR's era-C corpus is thin (4 cash hands), so its tables
    repeat the same hands with new ids, names and seats; Winamax has no
    tournament hand; whole-hand writes only (R1.3's random-append test
    covers partial writes); every window title is invented.
  - **For R3.2** (HUD process): the HUD's tests start the simulator as a
    process (build it first: `cargo build -p rail-hud-sim`; a binary cannot
    be a dependency) and read its events; for the data path without
    windows (Linux CI) `--headless` with the same events.
  - **For R3.3** (Windows, find tables): the process is `rail-hud-sim.exe`;
    give the HUD a test-only room entry (process name and the regex from
    `--title-regex`), never in `sites.json`; the hands' table name equals
    the title's `table` group (or `tableFromTitle`), and every `hand`
    event says which table and file it went to, so "match the title to the
    newest hands' table name" can be asserted. Capture the real clients'
    titles into `sites.json` and `rooms.json` when verified.
  - **For R3.4** (Windows overlay): the table is drawn in fixed fractions of
    the client area - `rail_hud_sim::draw::seat_center(size, seat,
    hero_seat)` in thousandths, `TABLE_CENTER` - so a test can check where
    a seat panel lands at any window size and DPI.
  - **For R3.5 / R3.13** (tracking): `scripts/tracking.txt` moves, resizes,
    minimises, restores, moves the player to another table (title change),
    closes and opens; each step's `window` event is the ground truth to
    compare the overlay with. On macOS a requested position may be pulled
    onto the visible screen (below the menu bar): compare with the event,
    not the request.
  - **For R3.6** (seats): `--preferred-seat` draws the hero's seat at the
    bottom, as clients do; the hero's seat per table is in the `table`
    event (`heroSeat`) and stays fixed until a table move.
  - **For R3.7** (data path): a `hand` event's `atMs` is when its bytes were
    written - the start of the latency to measure to the redraw.
  - **For R3.11 / R3.12** (macOS): the windows are ordinary `NSWindow`s of
    an unbundled process; their titles are `AXTitle`s (the Accessibility
    permission is the HUD's, not the simulator's).
  - **For R3.14** (twelve tables): `--tables 12 --sizes 6 --speed 6` (or
    faster) on both systems; the simulator redraws a window only when its
    table changes. The end-to-end example measures the store side; the
    HUD's redraw is added to it there.

### R3.2 HUD process and IPC — M
- `rail-hud` as a Tauri sidecar; IPC from §3.2; health checks and restart;
  read-only SQLite; one platform trait (`find_tables`, `track`, `overlay`)
  with Windows and macOS backends.
- *As built* (§15): **done** - `hud/rail-hud` (a library and the binary
  `rail-hud`) and the new `hud/rail-hud-ipc` (the channel, used by both
  sides), both `#![forbid(unsafe_code)]` with the workspace lints; the app's
  side in `app/src-tauri/src/hud.rs`. How to run it: README §8 "HUD process".
  - **Processes.** The app starts the HUD as its **Tauri sidecar**: the
    binary beside the app's own executable (`Rail.app/Contents/MacOS/rail-hud`,
    beside `Rail.exe`; `target/<profile>/rail-hud` in development).
    Bundling is `bundle.externalBin` in a separate
    `app/src-tauri/tauri.hud.conf.json`, passed to `tauri build --config`
    after `npm run hud:sidecar` (release build, copied to
    `src-tauri/binaries/rail-hud-<target triple>`, gitignored): in
    `tauri.conf.json` it would make every `cargo build -p rail-app` (clippy,
    tests, dev) fail until the sidecar existed, since `tauri-build` checks the
    file. The process is started with `std::process::Command`, not
    `tauri-plugin-shell` (no plugin, no permission for the window; the
    sidecar lookup is the same "next to the executable"). Started in `setup`
    before the watcher (imports feed it), stopped first on exit.
    `RAIL_HUD=off` keeps it from starting; a missing binary is a status
    (`not-installed`), looked for again every 30 s.
  - **Supervision** (`rail_hud_ipc::supervisor`): a fresh token per process
    on its standard input, `--store <rail.db> --ipc <endpoint>` on the
    command line, standard output discarded, standard error forwarded line by
    line to the app's log (target `rail_hud`), on Windows `CREATE_NO_WINDOW`.
    The app waits up to 15 s for that process's authenticated connection
    (the pid it proved with the token); then `health {seq}` every 2 s, and no
    answer for 10 s (a hung HUD), the process exiting or the connection
    closing ends it: stdin closed, 1.5 s grace, killed, started again after
    a backoff of 0.5 s doubling to 30 s (a run of 60 s resets it); it never
    gives up. Shutdown: `shutdown`, stdin closed, 1.5 s, killed; the HUD
    also exits on its own when its standard input ends - which is what an
    app crash looks like to it. `hud_status` (command) shows phase, pid,
    starts, last exit, tables open, refused windows, the HUD's re-read
    latency and dropped messages; no screen shows it yet (R3.10).
  - **The app never blocks on the HUD.** Every send is a `try_send` into a
    1 024-message queue drained by the link's writer thread; a full queue
    drops the message and the next write is preceded by `resync`. The
    watcher's callback only queues the file that got hands (256 at most,
    dropped beyond: a backfill's flood); a feeder thread with its own
    read-only connection folds them per file and sends `hand_imported` for
    its newest hands (`Reader::newest_hands_of_file`, new: the hand's
    rollup site from `segments.site`, its table and every kept seat's
    `(player, scope)`; at most 10 per import, oldest first), and only while
    a HUD is connected. Callbacks from the HUD run on the link's reader
    thread and only flip atomics or emit window events.
  - **IPC** (`rail_hud_ipc`): Unix domain socket in a fresh `0700` folder
    `rail-hud-<random>` in the user's temporary directory (`/tmp` when that
    path would not fit a socket address), the socket `0600`, both removed
    with the listener; on Windows a named pipe
    `\\.\pipe\rail-hud-<pid>-<random>`, first instance only, remote clients
    rejected, DACL `D:P(A;;GA;;;OW)(A;;GA;;;SY)` (owner and SYSTEM only; the
    default would give Everyone read access) - through `interprocess`
    =2.4.5 (safe wrappers over `CreateNamedPipeW` and an SDDL security
    descriptor; std has no pipe server). Frames: 4-byte big-endian length +
    one JSON message, at most 1 MiB, and 1 KiB until the handshake is done
    (an unauthenticated peer cannot make either side allocate more); zero
    and oversized lengths refused before allocating.
  - **Authentication.** 256-bit random token per HUD process, written as the
    first line of its standard input (a command-line argument is visible to
    every user in the process list; the environment cannot be cleared
    without `unsafe` in Rust 2024). Handshake: `client_hello {protocol,
    nonce, pid}` -> `server_hello {nonce, proof}` -> `client_proof` ->
    `welcome`, each proof HMAC-SHA256(token, role, version, both nonces)
    compared in constant time (HMAC over the workspace's `sha2`, checked
    against RFC 4231's vectors; `getrandom` for the token and nonces - pure
    Rust, so the crate cross-checks for `x86_64-pc-windows-msvc` without a
    C toolchain). The HUD checks the app's proof before sending its own, so
    a process squatting on the endpoint learns nothing; the app takes only
    the process it just started, and only while it waits for it (a stranger
    gets the connection closed). Other users cannot reach the endpoint at
    all; the user's other processes fail the handshake. A version mismatch
    is `refused` with both versions named.
  - **Protocol 1** (`rail_hud_ipc::protocol`; `type` in snake case, fields in
    camel case; an unknown type reads as `Unknown`, unknown fields are
    ignored). To the HUD: `hand_imported {site, table, handKey, players:
    [{name, scope}]}`, `stats_changed {epoch}` (R2.11's swap; from
    `stats::spawn_refresher`), `layout_changed`, `settings_changed` (read by
    R3.6 / R3.9), `policy {remote}` (the app's remote `sites.json`; the app
    fetches none yet), `resync`, `health {seq}`, `shutdown`. From it:
    `health {seq, report}` (uptime, attached, refused, store open, platform,
    re-read p50 / p95 / max), `tables_open {count}`, `open_in_app {site,
    player}` (the app shows its window and emits `hud-open-player`; sent by
    R3.8's popup), `attach_refused {site, window, reason}`, `table_updated
    {window, site, table, handKey, players: [{name, hands}], rereadUs}`.
    Round-trip, wire-form and tolerance tests.
  - **`tables_open`** pauses the statistics pass's heavy parts
    (`StatsState::set_tables_open` -> `StatsWorker::set_tables_open`) and
    lowers sync's bandwidth (`SyncWorker::set_tables_open`) on the edges 0
    -> some -> 0; the HUD going away counts as 0. It counts tables the HUD
    is **attached** to: a refused room's windows do not count.
  - **Read path** (`rail_hud::data`): `rail_store::Reader` with one
    connection (`SQLITE_OPEN_READ_ONLY` + `query_only`; a test shows writes
    refused); a missing store is never created, looked for again every
    second. `hand_imported` sets the players of every attached window of
    that room - matched by the store's site (`sites.json`'s `parser`: `acr`
    is `acrwpn` in the store) and the title's table name - and re-reads
    their `Reader::hud_totals` (all the site's segments; R3.7 picks the
    table's). `stats_changed`, `resync` and the store's own `PRAGMA
    data_version` moving without a message (checked every 2 s; new
    `Reader::data_version`) re-read every attached table: the HUD keeps
    drawing when the app is busy. A hand of a table the HUD is not
    attached to is never read; its players are kept (the last hand of up
    to 256 tables), so a window found a moment after its hand - or a
    tournament move to a table with a known hand - starts from them.
  - **Platform trait** (`rail_hud::platform::Platform`): `find_tables(&[TableMatcher])`,
    `track`, `untrack`, `poll_events` (moved, minimised, retitled - a
    tournament table move forgets the players -, closed), `overlay(id,
    &OverlayFrame)`, `remove_overlay`; driven from the HUD's one loop thread
    (not `Send`: AppKit wants the main thread). `TableWindow`: window id
    (`HWND` / `CGWindowID` / the simulator's table number), the `sites.json`
    room whose matcher took it, process (pid, name), title, the title's
    `table` group, seats, client rect in physical pixels, scale in
    thousandths (no floating point), minimised. `TableMatcher` from
    `sites.json` `tables` (processes for this OS + title regex; all `null`
    today, so none). Backends: `windows` and `macos` stubs (find nothing;
    their module docs list the R3.3 - R3.5 and R3.11 - R3.13 calls), `none`
    on Linux, and **`sim`**: the simulator's standard output (JSON lines,
    tailed from a file every 10 ms) is the windows - `started` gives its
    own title regex, `table` / `window` / `closed` the rest; overlays are
    recorded in memory.
  - **Compliance mode in the HUD process** (`rail_hud::compliance`): a window
    is attached only when `Site::hud_permitted()` of its room - in the
    shipped `sites.json` merged with the app's remote copy by
    `rail_config::load_remote` (stricter only; a refused remote file changes
    nothing). Otherwise `attach_refused` once per window with `prohibited`,
    `unknown`, `not-a-room` or `unknown-site`; a `policy` that switches a
    room off detaches its tables at once. **Test-only room entries** are the
    sim backend's `--sim-site <id>`: the simulator's windows, matched by its
    own title regex, pose as that room, and compliance decides as for a real
    window; it cannot help a real client (the backend reports only the
    simulator's tables) and nothing of it is in `sites.json`.
  - **Tests** (all in `cargo test` on Linux, macOS, Windows): rail-hud-ipc 17
    (messages, frames and limits, handshake both ways, wrong token, squatter,
    wrong version, garbage first, the real socket / pipe duplex at 64 KiB
    each way, `0700` / `0600` and cleanup); rail-hud 15 unit (compliance with
    the signed list and remote merges, the sim backend, the loop: attach,
    refuse once, a stricter policy detaching, table moves, exits; the store
    read-only), `tests/supervisor.rs` (the real binary: connect, health,
    `kill -9` -> restart with a new pid and token, stop and cleanup, a
    failing HUD retried with backoff, a missing one reported, a stranger
    refused), `tests/e2e.rs` (below); rail-store
    `newest_hands_of_a_file_for_the_hud`; the app's `hud` module 3.
  - **Latency** (§3.3; `tests/e2e.rs`: `rail-hud-sim --headless` -> watcher
    -> store -> `newest_hands_of_file` -> `hand_imported` through the real
    supervisor -> `rail-hud --platform sim` -> `hud_totals` ->
    `table_updated`; M2 Pro, debug build). PokerStars, 3 tables, 12 hands:
    hand in file -> the app reads `table_updated` p50 515 / p95 521 / max
    524 ms; `hand_imported` sent -> `table_updated` read 0.58 / 0.79 / 1.7
    ms; inside the HUD, arrival -> rollups re-read 0.28 / 0.45 / 1.4 ms.
    **12 tables, 96 hands**: 513 / 520 / 529 ms; 0.47 / 1.2 / 4.7 ms; 0.24 /
    0.80 / 4.5 ms. ACR (`acrwpn` in the store), 2 tables: 514 / 517 / 532
    ms. The HUD's part is far inside its 10 ms; the total is the watcher's
    500 ms quiet period (R1.3, R3.1), so §3.3's < 1 s holds and the aim of
    250 ms still does not. The prohibited (`ggpoker`) and unknown
    (`888poker`) runs: every window refused with its reason, nothing
    attached, not one `table_updated`.
  - **CI**: the HUD crates are in the `core` job's workspace clippy and test
    on all three systems (the e2e uses the `rail-hud-sim` binary the same
    `cargo test` builds; run alone it builds it). The `app` job builds the
    sidecar (`npm run hud:sidecar`), bundles with
    `--config src-tauri/tauri.hud.conf.json`, and checks the HUD is in
    `Rail.app/Contents/MacOS/` (and runs `--help`) and in the NSIS
    installer's file list.
  - **Limits.** No real window is found or drawn on yet; the app fetches no
    remote `sites.json` yet (`policy` is ready for it); `layout_changed` /
    `settings_changed` are accepted and ignored; Windows' pipe reads have no
    timeout during the handshake (only the user's processes can connect
    there); a HUD restarted mid-session shows "waiting for first hand" until
    its table's next hand (no "latest hand of this table" lookup: `hands`
    has no table index). *Closed by R3.7*: a table's newest stored hand
    through `hands_imported_at_idx`, the last 15 minutes.
  - **For R3.3 / R3.11** (find tables): implement `find_tables` in
    `platform/windows.rs` / `macos.rs` against the matchers
    `Compliance::matchers()` builds from `sites.json` `tables` (processes
    for this OS, the title regex with its `table` group) - capture real
    titles first; return every match, allowed or not (compliance refuses and
    the app says why). Report the client rect in physical pixels and the
    scale in thousandths. The Win32 / AppKit calls need `unsafe`: lift
    `forbid` to `deny` in that module only, each block justified. Process
    names: compare without case.
  - **For R3.4 / R3.12** (overlays): `overlay(id, &OverlayFrame)` is called
    on attach ("waiting for first hand") and after each re-read; the
    backend owns the overlay window and keeps it on the table
    (`TableEvent::Moved` already reaches the loop). macOS: the loop must run
    on the main thread inside the AppKit run loop - `Hud::run` waits on a
    channel with a 50 ms tick, which then becomes a run-loop timer or
    source.
  - **For R3.5 / R3.13** (tracking): `poll_events` drains what the hooks /
    observers queued; `Retitled` with a new `table` is a tournament move (the
    loop forgets the players); `Closed` detaches. The sim backend's events
    and `rail-hud-sim/scripts/tracking.txt` are the ground truth to compare
    with.
  - **For R3.7** (data path): `table_updated` carries the re-read latency;
    the redraw time is the backend's to add. Pick the table's segment(s)
    for `hud_totals` instead of the whole site; a "latest hand of this
    table" query (an index on `hands (site, table_name, rowid)` or the hand
    list) would fill a table at attach instead of at its next hand.
  - **For R3.10**: the HUD-process half is done here (the decision, refusal
    reasons, a stricter remote policy detaching); the app keeps the last 32
    refusals in `hud_status` for the screen that says why.

### R3.3 Windows: find tables — M
- `EnumWindows` + `GetWindowText` + owning process; title regex from
  `sites.json` → table name and stakes; match to the table name in the newest
  hands (hand header `Table '…'`).
- *As built* (§15): **done** - `hud/rail-hud/src/platform/windows.rs`
  (`find_tables`), `platform/matcher.rs` (matchers, identity, redaction),
  `list.rs` (the `--list-windows` diagnostic), the engine's identity rules;
  `docs/research/CAPTURING-TABLES.md` for the owner. No real room has a
  `tables` block yet, so the HUD still attaches to no real client: every
  Windows test runs against the table simulator's real windows.
  - **`find_tables`** = `platform::windows::enumerate()` then
    `platform::table_of()` per window. `enumerate`: `EnumWindows` (handles
    collected first, then examined), `IsWindowVisible` (visible top-level
    only), `GetWindowTextW` (the caption Windows keeps: never waits on a
    hung client), `GetClassNameW`, `GetWindowThreadProcessId` ->
    `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` ->
    `QueryFullProcessImageNameW` (file name kept, one lookup per process per
    walk; a process that cannot be asked has an empty name and matches
    nothing), `IsIconic`, `DwmGetWindowAttribute(DWMWA_CLOAKED)`,
    `GetClientRect` + `ClientToScreen`, `GetDpiForWindow`,
    `MonitorFromWindow` + `GetDpiForMonitor(MDT_EFFECTIVE_DPI)`,
    `GetWindowDpiAwarenessContext`. **Physical pixels**: the walk switches
    its thread to per-monitor DPI awareness v2
    (`SetThreadDpiAwarenessContext`, restored after), and the HUD process
    sets it for itself at start (`SetProcessDpiAwarenessContext`, before any
    window; `init_process_dpi_awareness`) - an API call rather than a
    manifest, so no resource compiler joins the build. **Scale** =
    the monitor's effective dpi x 1000 / 96, not `GetDpiForWindow`: a client
    that is not per-monitor aware says 96 for itself while Windows stretches
    it, and the overlay (R3.4) must draw at the monitor's scale; the
    window's own dpi and awareness are kept in `RawWindow` and printed by
    the diagnostic. **Minimised** windows are found with `minimized: true`
    and an empty client rect; **cloaked** ones (another virtual desktop)
    are found as hidden too (`minimized: true`) rather than dropped, so a
    table on another desktop stays attached. A window without a title is
    never a table (helper windows can claim to be visible). Every match is
    returned,
    allowed or not; compliance in the engine refuses (unchanged from R3.2).
    `track` records the window (R3.5 hooks it), `poll_events` is empty,
    `overlay` unsupported (R3.4).
  - **`unsafe`**: the `windows` crate **=0.61.3** (the version Tauri already
    locks: no new crate in `Cargo.lock`), features `Win32_Foundation`,
    `Win32_Graphics_Dwm`, `Win32_Graphics_Gdi`, `Win32_System_Threading`,
    `Win32_UI_HiDpi`, `Win32_UI_WindowsAndMessaging`, a `cfg(windows)`
    dependency. The crate is now `deny(unsafe_code)` +
    `forbid(clippy::undocumented_unsafe_blocks)`; every module but
    `platform/mod.rs` (whose `forbid` would bind its child `windows`) says
    `forbid(unsafe_code)` itself; in `windows.rs` each Win32 call is in a
    small function of `mod ffi` (Windows only) with its own
    `#[allow(unsafe_code)]` and a `// SAFETY:` comment per block; the
    binary's `main.rs` stays `forbid`. On macOS and Linux the module
    compiles to a backend that finds nothing.
  - **Matchers** (`platform::matcher`): `TableMatcher { site, processes,
    title }` from `sites.json` `tables` (`Compliance::matchers`, unchanged:
    none yet) plus **test-only room entries**,
    `TableMatcher::simulator(site, regex)`: the process `rail-hud-sim` and
    nothing else, so it can never take a real client's window; compliance
    decides on the posed `site`. Process names compare without case and
    without `.exe` (`rail-hud-sim` = `rail-hud-sim.exe`). The title's
    `table` group gives the name, an optional `seats` group (2 - 10) the
    table size (`sites.schema.json` describes both). The HUD takes a test
    entry from `rail-hud --standalone --sim-site <id> --sim-title <regex>`
    with the native backend (`Hud::add_simulator_room`; standalone only,
    the app never passes it). Nothing is added to `sites.json`.
  - **Table identity** (`engine`): a window is (room, table name, seats).
    The name is `table_key` of the title's group (trimmed, runs of white
    space one space; case kept); a `hand_imported` goes to the attached
    window of the same store site whose key **equals** the hand's - never a
    prefix or substring (`Table 1` / `Table 11`, `Hygiea IV` / `Hygiea IV
    40-100 bb` are tested). **Two attached windows with one name** (a
    fast-fold pool, a room that reuses names) cannot be told apart: neither
    gets the hand, both show "2 tables named ...: cannot tell them apart",
    and when one closes the other takes the next hand. **Seats** from the
    title's `seats` group, else from the table's last hand (new
    `Reader::hand_seats`: `hands.max_seats` by key). **Tournaments**: a
    table move changes the title; R3.5's `Retitled` will say so at once,
    and meanwhile the engine's re-find (every 500 ms) compares each
    attached window with what it found - title (a new table: players
    forgotten, "waiting for first hand", the new table's last hand adopted
    if known), client rect and scale, minimise, seats - and a hand that no
    window takes makes the HUD look again at once ("re-find on demand": the
    first hand at the new table may come before the retitle is seen).
    **"Waiting for first hand" HUD-wide**: `health` gains `waiting`
    (attached tables without a hand yet, or ambiguous; `#[serde(default)]`,
    so an older HUD reads as 0), shown by the app's `hud_status` as
    `tablesWaiting`.
  - **The diagnostic** `rail-hud --list-windows [--process <exe>]...
    [--you <name>]... [--store <rail.db> | --no-store] [--try-title
    <regex>]`: every visible top-level window with a title - process,
    class, title, client size and position in physical pixels, minimised /
    cloaked, monitor and window dpi and DPI awareness, the title's
    non-ASCII and control characters with their offsets, the room whose
    matcher takes it (with compliance's answer), and what a candidate regex
    reads. **Redaction** (`matcher::Redactor`): everything after "logged in
    as" (any case and spacing) and every screen name of the user - `--you`,
    plus the store's hero names (new `Reader::hero_names`), from the app's
    store at `%LOCALAPPDATA%\app.rail.desktop\rail.db` by default -
    replaced by `<you>`, case-insensitively, anywhere; names under two
    characters are not used; the output says how many names were used and
    never prints them, and tells the reader to check before sharing.
    Windows only (exit 2 elsewhere).
  - **`sites.json`**: `tables` gains `checkedAt` (null everywhere); the
    validator and the schema refuse `tables.verified: true` without
    `checkedAt`, a source starting `Observed on ` and a title regex (three
    new cases in `validator_problems`, two in the ajv test). The owner's
    procedure (which clients, which table kinds - cash 6-max / 9-max / HU,
    fast-fold, tournament with a table move, Spin -, the hands' `Table '…'`
    name per table, what to paste back, and how it becomes a `tables` block
    with `verified`, `checkedAt` and an "Observed on a Windows install,
    <date>: <client version> ..." source) is
    `docs/research/CAPTURING-TABLES.md`, linked from `VERIFYING-PATHS.md`.
  - **Simulator**: its `window` event gains `clientX` / `clientY` (the
    client area's origin, winit's `inner_position`; `x` / `y` stay the
    frame's), which the sim backend now uses for the client rect and the
    Windows test compares with. Fixed: a cash table's `tablemove` released
    its name before drawing a new one and could draw the same name again
    (the Windows test's second run waited for a rename that never came);
    the old name now stays taken during the draw, and the simulator's
    unit test asserts a move changes the name.
  - **Tests**: `platform::matcher` (process and title, `.exe`, seats,
    the simulator entry, whole-name identity, redaction), `platform`
    (raw windows to tables, minimised / cloaked / DPI-unaware scale),
    `list` (arguments; the listing never contains a redacted name; a
    matched window names its room and policy), `engine` (similar names,
    one name on two windows, the re-find following a retitle / move /
    minimise / seats on a backend without events, the simulator room
    offered to the backend), `lib` (`--sim-title` rules), rail-store
    (`hand_seats`, `hero_names`), rail-config (verified tables), ajv,
    protocol (`waiting`, an older report). **Windows CI**
    (`hud/rail-hud/tests/windows_tables.rs`, `cfg(windows)`, in the `core`
    job's `cargo test` on `windows-latest`): `rail-hud-sim --tables 3
    --window 640x480`; `find_tables` with the simulator's entry finds
    exactly those three (the process's pid), with the hands' table names,
    client rects equal to the simulator's own `window` events and sizes
    640 x 480 times the monitor's scale; a catch-all title pattern on the
    simulator's process still finds three (visible, titled top-level
    windows only: the first CI run found a fourth, winit's untitled
    "Winit Thread Event Target", which Windows reports as visible -
    `table_of` now never offers an untitled window to a matcher); a
    minimised table is found and marked; `tablemove` retitles the same
    window; `--list-windows` lists the three with "Logged In as <you>" and
    no hero name; `rail-hud --standalone --sim-site pokerstars` attaches to
    the three and `--sim-site ggpoker` refuses them. A failure prints what
    was found, everything the simulator said and every window Windows
    reported. On macOS and Linux the file is empty. Cross-checked locally
    with `cargo clippy --target x86_64-pc-windows-msvc -p rail-hud` (a
    stand-in C compiler for SQLite / zstd, whose objects `check` never
    links).
  - **Limits.** No real client's title is known: until the owner's capture
    every room's matcher is absent and nothing real is found. A tournament
    title that does not carry the hands' table name gives a window with no
    table (attached, waiting); the capture will say whether a room needs
    more than the `table` group. Process names only, no window class (the
    capture records classes in case a room needs one). Not run on a real
    high-dpi or multi-monitor Windows machine (CI is one 96 dpi monitor):
    the scale is checked by construction and against the simulator only.
  - **For R3.4** (overlay): `WindowId` is the `HWND` value; the client rect
    is physical screen pixels and `scale_permille` the monitor's; the
    process is already per-monitor v2 aware (create the overlay windows
    after `init_process_dpi_awareness`); `RawWindow.awareness` /
    `window_dpi` say whether the client is stretched by Windows. Minimised
    and cloaked windows arrive with `minimized: true` - hide the overlay.
    `overlay()` is the one call still unsupported on Windows; the engine
    logs each refusal (with `--sim-site` that is one line per redraw).
  - **For R3.5** (tracking): `track` / `untrack` keep the set of followed
    `HWND`s; hook them (`SetWinEventHook`, out of context, on the owning
    pid from `TableWindow.process.pid`) and queue `TableEvent`s. The
    engine's re-find already turns a changed title, rect, scale or
    minimise into the same events every 500 ms, so the hooks only make it
    immediate; `Retitled.table` must be the matcher's `table_key` (use
    `TableMatcher::matches`). `scripts/tracking.txt` and the Windows test's
    `minimize` / `tablemove` steps are the ground truth to extend.

### R3.4 Windows: overlay — L
- One window per table: `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`,
  owned by the table window (stays above it, minimises with it, never steals
  focus); hit-testing transparent outside panels; Direct2D/DirectWrite drawing;
  per-monitor DPI v2.
- *As built* (§15): **done** - `hud/rail-hud/src/platform/windows.rs` (the
  backend), `platform/windows/overlay.rs` (the overlay thread, windows,
  surfaces, painter), `platform/windows/probe.rs` (read-only looks for tests
  and diagnostics), and three platform-free modules every OS tests:
  `layout.rs` (where panels go), `panel.rs` (what they say, the design and
  its restrictions), `scene.rs` (a frame laid out into rectangles and text
  at physical pixels). Still no real room has a `tables` block, so the HUD
  draws on no real client: every Windows test draws on the simulator's
  real windows posing as an allowed room.
  - **Windows, ownership, hit-testing.** One `WS_POPUP` per table with
    `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, created with the
    **table's `HWND` as its owner**: Windows keeps an owned window directly
    above its owner (not above other programs' windows), hides it while the
    owner is minimised and destroys it with the owner; the tool style keeps
    it off the taskbar and Alt+Tab; no-activate plus `MA_NOACTIVATE` for
    `WM_MOUSEACTIVATE` keep a click from taking focus from the table. It
    covers the table's **client rect exactly, in physical pixels** (the
    engine's `TableWindow.client`), from a thread that makes itself
    per-monitor DPI aware (v2) before it creates anything (`WM_DPICHANGED`
    is answered without resizing: the window follows the table, not
    Windows' suggestion). **Click-through**: the surface is alpha 0 outside
    the panels and Windows hit-tests a layered window by its alpha, so a
    click anywhere but on a panel reaches the table (the window procedure
    also answers `WM_NCHITTEST` with `HTTRANSPARENT` outside the panels -
    which only binds our own thread); panels take clicks for R3.8's popup.
    Not `WS_EX_TRANSPARENT`, which would make the panels click-through too.
    **Hidden** while the table is minimised or cloaked (`TableWindow.
    minimized`, R3.3), shown again (`SW_SHOWNOACTIVATE`) when it is back.
  - **The overlay thread.** The windows live on a thread of their own
    (`rail-hud-overlays`) that waits in `GetMessageW` and does nothing but
    create, paint, move, show and destroy them. A cross-process owner ties
    the table's input queue state to the thread that owns the overlay, and
    Windows sends that thread messages while the table moves or minimises,
    so it must never block: the engine (store reads, matching, IPC) stays on
    the loop thread and hands frames and geometry over a channel; a thread
    message wakes the overlay thread when the channel goes from empty to
    not, and it drains the channel whole. Queries (`overlay_info`,
    `overlay_pixel`, `render_times_us`) answer over a channel of their own
    after every command sent before them, which makes the tests exact.
  - **Rendering: Direct2D + DirectWrite into a DIB, `UpdateLayeredWindow`**
    (the `windows` crate =0.61.3 already locked; features
    `Win32_Graphics_Direct2D`, `_Direct2D_Common`, `_DirectWrite`,
    `_Dxgi_Common`, `Win32_System_LibraryLoader` - no new crate in
    `Cargo.lock`). A **software** DC render target (`B8G8R8A8_UNORM`,
    premultiplied, 96 dpi so one DIP is one physical pixel) paints into a
    32-bit top-down DIB section selected into a memory DC, which
    `UpdateLayeredWindow(ULW_ALPHA)` puts on screen at the table's client
    origin and size. Text is DirectWrite's (Segoe UI, semibold figures,
    centred in fixed cells, grayscale anti-aliasing: ClearType needs an
    opaque background). Chosen over a CPU rasteriser for correctness first -
    DirectWrite shapes and falls back across fonts as the rest of Windows
    does, hinted at the real pixel size, and Direct2D writes correct
    premultiplied alpha; GDI text writes no alpha (it would have to be
    rebuilt by hand), and tiny-skia would need a font file and a shaper,
    new crates both. Software rather than hardware: no GPU read-back per
    frame and the same path on a CI runner without a GPU; a paint is one
    clear of the surface, a few rounded rectangles and short text runs. A
    failed `EndDraw` makes the target again once. **Redraws only on
    change**: an equal frame at the same client size and scale is not
    painted again (the engine re-reads every attached table when the store
    moves - those frames are mostly equal), a move only moves the window
    (`SetWindowPos`, no repaint), a resize or a scale change repaints.
    Memory: one surface per table, 4 bytes per client pixel (a 1280 x 880
    table 4.3 MiB), plus Windows' copy for the layered window.
  - **The panel** (`panel.rs`, `scene.rs`): the shipped statistics whose
    `hud` is `panel` (R2.4: VPIP, PFR, 3B, F3B, CB, AFq - six), each as a
    whole number (`format_fixed(value, 0)`; `-` with no opportunity yet),
    coloured by its R2.4 band, its opacity R2.5's reliability (600 - 1000
    thousandths: a small sample dims, never hides), and the hand count
    (grey, at most five characters: `987`, `12345`, `123k`, `4.5M`) - two
    rows of three figures, the count at the end of the first. Near-black
    panels at 88 % opacity, light figures: neutral off-white, a light blue
    for the low band and a light orange for the high band (blue / orange
    rather than green / red, which a red-green colour-blind player cannot
    tell apart; each above 7:1 against the panel), so they read on any felt.
    No name, no label, no chart, nothing about the hand in play (the
    rollups count finished hands the room wrote to disk). **"Waiting for
    first hand"**: one pill near the top centre, clear of the seats and the
    board. Sizes: a row is 3.4 % of the client height, between 13 and 22
    logical pixels times the monitor's scale; the font 72 % of a row.
  - **Seats** (`layout.rs`, until R3.6): the simulator's own per-size slots
    in thousandths of the client area (`SEAT_SLOTS`, `TABLE_CENTER`; a test
    holds them equal to `rail_hud_sim::draw::seat_center` / `TABLE_CENTER`),
    seat `n` in slot `n - 1`, no hero rotation. A panel goes next to its
    seat's plate, on the first free side - above / below (away from the
    table's centre first), slid along that side as far as it still
    overlaps the plate, then beside it - where it covers **no seat plate,
    not the board and no other panel** ("table graphics", modelled on the
    simulator's plates and board). Seat order first, the reverse order if
    that leaves fewer without a place. Unit tests: every seat of every size
    (2 - 10) placed, inside the client area, covering nothing, next to its
    plate, at 640 x 440 to 1280 x 900 logical and 100 - 200 % scale
    (1920 x 1080 and 2560 x 1600 too). **Seat numbers** reach the HUD with
    the hand: `PlayerRef` gains `seat` and `hero` (optional and defaulted,
    no protocol bump; an older app's players have no seat and get no
    panel), from `seat_stats.seat` / `is_hero` (`Reader::
    newest_hands_of_file` now returns `HandSeat`s). The table size is the
    window's (title or hand), else the smallest of 6 / 9 / 10 holding every
    seat.
  - **Restrictions as data** (`sites.json` `hud.restrictions`, schema
    `$defs.hudRestrictions`, `rail_config::model::HudRestrictions`):
    `ownHandsOnly`, `rawCountsOnly`, `maxColourThresholds` (a count or
    `null`), `noCardSplitStats`, `noGameStateSwitching`,
    `noTendencySwitching`, `noPlayerLabels`, `noHandCharts`, `noGraphs`,
    `noHandInPlay`, `noOverlapTableGraphics` - each restricts when `true`
    (or a number). Required (an object) on every allowed room, `null`
    elsewhere: **PokerStars** - own hands, raw counts, two thresholds, no
    card-split statistics, no switching by game state or tendencies, no
    labels, charts or graphs; **ACR** - own hands, no labels, nothing from
    the hand in play, no overlap of ACR's table graphics; **Winamax** - own
    hands, no switching (its rules forbid "some dynamic features of
    Hand2Note", unspecified: read conservatively). The validator refuses
    `allowed: true` without them (a remote file from before R3.4 is then
    refused whole and the shipped policy stays); the merge keeps every
    restriction of both copies when both allow
    (`HudRestrictions::stricter`, `MergeNote::LooserRestrictionsIgnored`):
    a download can add a restriction, never drop or ease one. **The
    default design complies with the stricter of all three**
    (`HudRestrictions::STRICTEST`: two thresholds, fixed statistics, no
    labels, clear of the graphics), and the renderer enforces the room's
    restrictions on any design anyway (`PanelDesign::enforce`, before
    layout): card-split and switching statistics dropped, bands collapsed
    to the allowed number of thresholds (`collapse_tone`: two keep low |
    normal | high), labels dropped, panels that would cover table graphics
    dropped. **No frame for a disallowed room can exist**: an
    `OverlayFrame` carries compliance's `Permit` (private fields; only
    `Compliance::permit` makes one, for a room `hud_permitted()` allows,
    with its restrictions), the engine asks for it again before every draw
    (a room switched off loses its overlay), and the Windows backend refuses
    a frame whose permit names another room than the window's. Structural,
    noted here rather than enforced by the renderer: nothing from the hand
    in play (the data path reads finished hands only), no charts or graphs
    (the scene has no such item), raw counts (every shipped statistic is a
    raw rate).
  - **Engine.** `reread` builds a `SeatPanel` per player (seat, hand count,
    the design's cells over `Totals::sums()`); `draw` asks for the permit
    and adds the table size; `TableEvent::Moved` / `Minimized` (from the
    re-find every 500 ms until R3.5's hooks) call the new
    `Platform::follow(&TableWindow)` so the backend keeps the overlay on
    the table. The sim backend records frames and lays them out
    (`SimBackend::scene`) for tests on every OS.
  - **Tests.** All OSes: `layout` (the simulator's geometry, sizes,
    rectangles, metrics, every panel placed clear of the table at every
    usual size, next to its seat, a crowded table dropping panels only
    where it must), `panel` (the shipped panel, the default design
    complying with every room, a design cut down by PokerStars' / ACR's
    rules, tone collapse on every shipped band list, cells from rollups -
    value, band, 0.68 opacity at 4 of 100 -, hand counts), `scene` (panels
    at their seats, colours and dimming, the permit binding a looser
    design, ACR never covering the table, the waiting pill, players
    without seats, sizes from seats), `compliance::permits`, rail-config
    (`hud_restrictions_are_the_policies`, the validator, the merge's
    `restrictions_only_get_stricter`), the ajv schema test (shape,
    required, the pinned restrictions), rail-store (seats ascending, one
    hero at most), the protocol (seat and hero on the wire, an older app's
    player). **Windows CI** (`tests/windows_overlay.rs`, in the `core`
    job's `cargo test`): the simulator's three tables (6, 9, 2 seats) at
    640 x 480 with a panel per seat - per table the overlay exists, is
    **owned by the table window**, has layered / tool / no-activate and not
    app-window / topmost, its rect **is the client rect**, it shows; its
    panels are the layout's and each sits next to the simulator's own seat
    plate; the surface's pixel in a panel's margin is the panel colour
    premultiplied, the table's centre is alpha 0, a figure is drawn; a
    point at the table's centre hits the **table**, a panel point the
    overlay (checked where no other simulator window covers the point);
    the screen there (`BitBlt` with `CAPTUREBLT`) is the panel colour
    composed over what the table draws (read with the overlay hidden, then
    shown); minimised -> hidden, restored -> shown at the table, moved ->
    moved **without a repaint**; the same frame twice paints once; a frame
    permitted for another room and a window not tracked are refused;
    removed -> destroyed. Then the HUD process (`rail-hud --standalone
    --sim-site ...`): three shown overlay windows (class `RailHudOverlay`)
    owned by the simulator's windows for `pokerstars`, **no overlay window
    at all** for `ggpoker`. A failure prints what the overlay thread knew,
    the simulator's events and every window. Cross-checked locally with
    `cargo clippy --target x86_64-pc-windows-msvc -p rail-hud --all-targets`
    (stand-in C compiler and archiver for SQLite / zstd).
  - **Performance** (CI step "HUD overlays, twelve tables (measurement)",
    `twelve_tables_perf`, debug build, `windows-latest`): twelve simulator
    tables (9- and 6-max, 640 x 480), each overlay painted 20 times with
    new figures (PR #193's first run, one 96 dpi monitor): **a paint
    (layout, Direct2D, `UpdateLayeredWindow`) p50 2.1 ms, p95 4.0 ms, max
    42 ms** (the first paints, which make the factories' fonts and the
    surfaces; well inside the 16 ms budget); the 240 frames handed over and
    painted in 1.9 s; with the twelve overlays idle for 10 s the test
    process used **0 ms of CPU** (the overlay thread sleeps in
    `GetMessageW`); the `rail-hud` process attached to the twelve tables,
    idle for 10 s: **46 ms of CPU, 0.46 % of one core** - its loop's 50 ms
    tick and the re-find every 500 ms (`EnumWindows`), which R3.5's hooks
    can slow down. Surfaces: 14 MiB for twelve 640 x 480 tables.
  - **Limits.** Nothing real is drawn on until a room's titles are captured
    (R3.3's procedure). The table graphics are the simulator's, not any
    room's: ACR's real seat plates, buttons and cards must be measured
    before ACR's matcher is verified (R3.6). No panel interaction yet (R3.8:
    the panels already take clicks). Panels are fixed in two rows; the
    popup, legend and per-room layouts are R3.6 / R3.8 / R3.9. Not run on
    a real high-dpi or multi-monitor machine (CI is one 96 dpi monitor).
  - **For R3.5** (tracking): call `Platform::follow` with the window as
    the hooks see it - a move or resize, minimise / restore, cloak, a DPI
    or monitor change - and the overlay follows at once (a move costs a
    `SetWindowPos`, no repaint). `EVENT_OBJECT_LOCATIONCHANGE` fires
    during a drag: debounce the store side, never the follow. On a
    destroyed table the engine's `Closed` calls `remove_overlay`, which
    destroys the overlay if Windows has not already (owned windows go with
    their owner). Z-order needs nothing: an owned window stays above its
    owner.
  - **For R3.6** (seats and layouts): replace `layout::seat_center` (and
    `size_for`) with the room's seat map and the hero's rotation -
    `PlayerRef.hero` and the hero's seat are now in every `hand_imported`;
    measure each room's table graphics (`layout::table_graphics` is the
    simulator's) - ACR's above all (`noOverlapTableGraphics`: the renderer
    drops a panel that would cover them); dragged positions in client
    thousandths go where `place_panels` chooses a side today.
  - **For R3.8** (panel and popup): the panels already take clicks
    (`Scene::panels` is the hit region, `WM_NCHITTEST` answers
    `HTCLIENT` there) and never activate; a click arrives as a mouse
    message on the overlay thread - forward it to the loop thread rather
    than doing work there. Labels (notes, tags) have a place
    (`SeatPanel.label`, a third row) that rooms with `noPlayerLabels`
    never show; colour thresholds beyond two are cut on PokerStars by
    `collapse_tone`; a legend must show the thresholds actually used.

### R3.5 Windows: tracking — M
- `SetWinEventHook` for location change, foreground, minimise/restore, destroy,
  name change (tournament table moves); debounced; DPI changes between
  monitors.
- *As built* (§15): **done** - the hooks in
  `hud/rail-hud/src/platform/windows/overlay.rs` (on the overlay thread),
  the backend's side in `platform/windows.rs`, the platform-free half
  (which events, what an overlay does, what the engine is told) in the new
  `platform/tracking.rs`, tested on every OS. Still no real room has a
  `tables` block: every Windows test follows the simulator's windows.
  - **Hooks.** `SetWinEventHook`, **out of context**
    (`WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS`: no DLL in the
    client, events queued to our thread) and **scoped to the process id**
    of each tracked table's client: one set per poker process, made when
    its first table is tracked, undone when the periodic find sees that
    process with no tracked table and no visible window (it exited or went
    to the tray). Six hooks per process, one per range of
    `tracking::win_event::RANGES`, exactly the twelve events and nothing
    between them (a single `FOREGROUND ..= MINIMIZEEND` range would bring
    every menu, capture and scroll event): `EVENT_SYSTEM_FOREGROUND`,
    `MOVESIZESTART` / `END`, `MINIMIZESTART` / `END`,
    `EVENT_OBJECT_DESTROY`, `SHOW`, `HIDE`, `LOCATIONCHANGE`, `NAMECHANGE`,
    `CLOAKED`, `UNCLOAKED`; only the window object counts (`idObject ==
    OBJID_WINDOW`, `idChild == CHILDID_SELF`: never a caret, cursor or a
    child's part; `tracking::classify`). Feature `Win32_UI_Accessibility`
    of the locked `windows` =0.61.3 (no new crate). The numbers are the
    crate's (a Windows unit test).
  - **Thread: the overlay thread, justified.** An out-of-context hook
    calls back on the thread that set it, inside that thread's message
    wait, so the thread must pump messages and never block - which is
    what the overlay thread already is (R3.4) - and the one thing the
    callback is for, moving the overlay, can only be done directly by the
    thread that owns the overlay window: no hop to another thread, no lock,
    no wait between the table moving and its overlay moving. A thread of
    its own would have to hand every location to the overlay thread
    (`SetWindowPos` on another thread's window sends it a message and
    waits). The thread is now started by the first `track` (hooks before
    any frame). **The callback does almost nothing** (`win_event`): drops
    events about windows it does not follow (a thread-local set) - except
    a top-level window a followed process shows -, notes the rest
    (table, event, when) in a thread-local list, each (table, event) once,
    and posts the thread `HOOKED` once; the thread then reads each noted
    table's state **once**, however many events it had (`ffi::state_of`:
    `IsWindow`, `IsIconic`, the client rect with `GetClientRect` +
    `ClientToScreen` on a per-monitor-v2 thread, the monitor's scale,
    `DWMWA_CLOAKED`, `IsWindowVisible` - no call that sends the client a
    message), and acts. Never in the callback itself: it can run while
    the thread is inside a Win32 call of its own, and the overlays' state
    is not touched re-entrantly (the overlay window procedure's
    `WM_DPICHANGED` and `WM_DESTROY` are noted the same way).
  - **Follow immediately, debounce only the data side.** On every
    location the overlay is placed by `tracking::plan`: only the position
    changed -> `SetWindowPos` (no repaint; `OverlayInfo.moves` counts
    them), a new client size or **a new scale** -> repainted at that size
    and scale, minimised / cloaked / being minimised -> hidden, back ->
    shown. What the thread saw is kept for the backend **per table, the
    latest only** (`tracking::Observed`: geometry, title, gone, and
    "a window appeared"), so a drag's hundred locations become one
    `TableEvent::Moved` at the engine's next tick (`tracking::events`;
    the engine's data side - redraws, store reads - never sees the storm)
    while the overlay has followed every one.
  - **What the engine hears** (`poll_events`): `Moved` / `Minimized`
    (geometry against what the engine was last told), `Retitled` - the
    new title through **the window's own room's matcher**
    (`TableMatcher::matches`; the matchers of the last find), so `table`
    is the hands' `table_key` and a tournament table move is a new table
    identity at once (the engine logs `window N moved to table ...`); a
    title the room no longer takes is `Closed` (the find would drop it
    too) -, `Closed` for a destroyed table and for one its client hides
    (`SW_HIDE`: not a visible top-level window, which the find does not
    list either; the overlay goes at once, since Windows does not hide an
    owned window with a hidden owner), and the new
    **`TableEvent::Appeared`**: a followed process showed a top-level
    window (a new table, or a hidden one back), and the engine looks for
    tables at its next tick instead of at the next periodic find.
    `EVENT_SYSTEM_MINIMIZESTART` hides the overlay before `IsIconic` says
    so (for at most 2 s if `MINIMIZEEND` never comes).
  - **The periodic re-find (500 ms) stays, and cannot fight the hooks.**
    The overlay thread **never places an overlay from a description**: a
    new frame, a hook event, the engine's `follow` - each reads the table
    as it is at that moment. The re-find's snapshot can be older than
    what the hooks showed; the engine then calls `follow` with it, the
    backend sees a description it was not given by the hooks and asks the
    thread to look again (`Resync`), which puts the overlay where the
    table is now - never back. A `follow` that only repeats what the hooks
    reported does nothing. (R3.4's test that hid an overlay by telling the
    backend its table was minimised now hides it by hand,
    `drive::show_window`.)
  - **DPI.** The scale is the table's monitor's effective dpi (R3.3's
    rule, now `tracking::scale_of`), read on every location: a table
    dragged onto a monitor of another dpi - a per-monitor-aware client
    resizes itself, an unaware one is stretched by Windows - or a monitor
    whose scale setting changed under it repaints its overlay at the new
    scale (`plan`: a new scale at the same pixel size is still a repaint).
    The overlay window's own `WM_DPICHANGED` (it was moved onto that
    monitor) is answered without resizing and makes the thread read its
    table again. The CI runner has one 96 dpi monitor, so **no dpi change
    is tested on Windows**; `tracking`'s unit tests hold the logic
    (`what_an_overlay_does`, `locations_coalesce`, `scale_from_the_monitor`).
  - **Z-order sanity.** On `EVENT_SYSTEM_FOREGROUND` of a table, its
    overlay must be directly above it (walking the z-order down from the
    overlay to the table); if not, it is put right above it (after the
    window just above the table, `SWP_NOACTIVATE`) and counted in
    `OverlayInfo.restacked`. Windows keeps an owned window above its owner,
    so this is a check that should never act.
  - **A table's process exits**: Windows destroys the overlays it owns (the
    overlay thread sees its own `WM_DESTROY` for a window it did not
    destroy, finds the table gone, reports it) and the hooks report the
    tables' `EVENT_OBJECT_DESTROY`; either way the engine gets `Closed`,
    and the process is unhooked at the next find. An overlay destroyed
    under a living table is made again with its last frame.
  - **Tests.** All OSes: `platform::tracking` (only the window object's
    events, every hooked range exactly hooked events; scale from the
    monitor; what an overlay does - move, resize, a monitor of another dpi
    at the same and at a new size, hide, show; a storm of 100 locations is
    one `Moved`; minimise; a table move through the room's own matcher
    with seats; a title the room no longer takes, destroyed and hidden
    windows closed; `Appeared`), `engine::hook_events_between_finds` (a
    move and a retitle between finds, `Appeared` finding at once, `Closed`
    detaching), on Windows `ffi::tests::win_event_numbers`. **Windows CI**
    (`hud/rail-hud/tests/windows_tracking.rs`, in the `core` job's `cargo
    test`, and again with its output in the step "HUD tracking
    (measurement)"): `hooks_follow_every_change` - the backend, the
    simulator's three tables of one process hooked once; 40 scripted
    `SetWindowPos` moves of one table, each followed (the overlay's rect
    equals the table's client rect; lag table moved -> overlay moved, p50
    under one frame, p95 under three), never repainted, the other two
    overlays untouched, one `Moved` for the engine; the simulator's `move`
    (the overlay equals its `window` event); `resize` -> repainted at 800 x
    560; `minimize` -> hidden and `Minimized`, `restore` -> shown on the
    table; z-order after a raise and a focus; `tablemove` -> `Retitled`
    with the new table's hands' name; hidden by its client -> the overlay
    gone, `Closed`, shown -> `Appeared`, found and followed again; **100
    moves in 1 s** (lag p50 / p95, the overlay thread's CPU under 500 ms, no
    repaint, one `Moved`); `close` -> `Closed`, the overlay destroyed; the
    simulator killed -> `Closed` for its tables, their overlays gone, the
    process unhooked. `the_hud_follows_the_tracking_script` - `rail-hud
    --standalone` with the simulator running `scripts/tracking.txt`
    (extended: a drag of twelve moves 40 ms apart, a focus): after every
    `window` event the HUD's overlay of that table covers the reported
    client rect and is above the table (hidden while minimised), a table
    move is logged as one, a closed table has no overlay, an opened one
    gets one. `the_hud_follows_a_drag` - the HUD process during 100 moves
    in 1 s: lag per move, its CPU, the overlay **never back at an older
    position and never hidden** while the re-find runs twice meanwhile,
    still there 600 ms after; a hidden table's overlay gone and back after
    the show (`Appeared`); the simulator killed -> no overlay left.
  - **Measured** (PR #194's first CI run, `windows-latest`, debug build,
    one 96 dpi monitor; the "HUD tracking (measurement)" step's `R3.5 ...`
    lines). **Table moved -> overlay moved** (from `SetWindowPos` returning
    to the overlay's rect equal to the table's client rect): 40 scripted
    moves **p50 101 µs, p95 125 µs, max 136 µs** (inside the overlay
    thread, hook callback -> overlay moved, ~160 - 250 µs); 100 moves in
    1 s, backend p50 77 µs, p95 107 µs, max 3.4 ms, the overlay thread
    15 ms of CPU for the storm, and the engine told once; **through the
    `rail-hud` process** 100 moves in 1 s p50 58 µs, p95 120 µs, max 532
    µs, the process 15 ms of CPU, never back at an older position, never
    hidden - all far inside one 60 Hz frame (16.7 ms). Simulator's move
    command -> overlay moved 1.3 ms; resize -> one repaint at the new size
    4.7 ms; minimise -> hidden 2.2 ms, restore -> shown 10 ms; table move
    seen 2.3 ms after the command (the re-find: up to 500 ms); a hidden
    table's overlay gone in under 1 ms (HUD process 0.6 ms) and back 28 ms
    after the show (`Appeared`); `close` -> `Closed` 4.7 ms; the
    simulator killed -> every HUD overlay gone in 1.4 ms. Each hooked
    process got all six hooks; `restacked` stayed 0. The tracking script
    through the HUD: 14 `window` events, each matched by the overlay. The
    HUD idle with 12 tables is unchanged (R3.4 perf step: 0.46 % of one
    core).
  - **Limits.** No dpi or multi-monitor change on a real machine (CI has
    one monitor); no real client yet (R3.3's capture, R3.14). A client that
    hides a table rather than closing it detaches it until it is shown
    again (then found at once). The hooks see what Windows reports for the
    window object: a client that draws its tables inside one big window
    (no such room is known) would need child-window tracking.
  - **For R3.6** (seats and layouts): an overlay's size and scale change
    only through `tracking::plan`'s repaint, so a layout keyed by client
    size and scale is redrawn exactly when it must be; the overlay thread
    already gets clicks on panels (R3.4) - a drag of a panel (R3.6's
    "drag to move") must be handled there and handed to the loop thread
    like R3.8's clicks, never doing store work on the overlay thread (it
    runs the hooks). `Retitled` with a new table already forgets the seat
    map's players (engine); the hero's seat changes with a table move.
  - **For R3.13** (macOS tracking): `platform::tracking` is shared -
    `Observed` / `events` (coalescing, retitle through the room's matcher,
    `Appeared`) and `plan` apply to `AXObserver` notifications as they do
    to WinEvents; keep "place from the window as it is now" so the
    `CGWindowList` fallback poll cannot fight the observers.

**Windows HUD status (after R3.5).** On the simulator, in CI: tables are
found by process and title (R3.3), drawn over by an owned, layered,
click-through overlay at the seats with each room's restrictions enforced
(R3.4), and followed by hooks - drags, resizes, minimise, cloak, hide, table
moves, closes and process exits - without lag and without fighting the
periodic re-find (R3.5); twelve tables cost a paint p50 of 2 ms and idle
overlays no CPU (R3.4). **What needs the owner**: the real clients' window
titles and processes (R3.3's capture, `docs/research/CAPTURING-TABLES.md`),
which become `sites.json` `tables` blocks - until then the HUD attaches to
no real client; ACR's real table graphics measured (R3.6). **What needs a
real-client check** (R3.14, on each allowed room - PokerStars, Winamax, ACR -
with play money where it exists, P5 / P6): the hooks against the real
client's windows (a client may hide rather than close a table, or move its
tables between windows), a high-dpi and a two-monitor setup (drag across
monitors of different scale), the overlay over the client's real seats and
graphics, and CPU with twelve real tables.

### R3.6 Seats and layouts — M
- Map hand-history seats to on-screen seats from table size and the room's
  "preferred seat" rotation; layouts in normalised coordinates of the client
  area; drag to move a panel, remembered per (room, table size, seat).
- *As built* (§15): **done** - the platform-free `hud/rail-hud/src/seats.rs`
  (mapping, rotation, the rooms' layouts and the user's), `layout.rs`
  (`TableLayout`, the user's positions, `constrain`), `scene.rs`
  (`compose_with`), `platform/drag.rs` (what a press, move and release
  mean), the Windows overlay thread's mouse handling
  (`platform/windows/overlay.rs`), the engine's half, rail-store migration
  13 (`core/rail-store/src/hud.rs`), the protocol's `seat_position_changed`
  and the app's writer (`app/src-tauri/src/hud.rs`). Still no real room has
  a `tables` block: every Windows test uses the simulator's windows posing
  as an allowed room.
  - **Slots.** A table's layout lists where the client draws its seats,
    clockwise; **slot** `i` is the place where an unrotated client draws
    its `i`-th seat (`seatNumbers` says which hand-history seat that is
    when a room does not number a table `1..=size` - a 6-max table written
    with 9-max numbers). Panels, positions and the store are keyed by slot
    (the "visual seat"), never by a hand's seat number.
  - **Rotation model ("preferred seat").** A client that always draws the
    hero in one place turns the whole table: the hero goes to the layout's
    `heroSlot`, everyone keeps their order around the table, so seat `s`
    is at `(slot(s) - slot(hero) + heroSlot) mod size`
    (`seats::slot_of`). Whether a room's client does: the user's word
    (`hud_room_settings`, the app's `hud_set_preferred_seat`; PokerStars,
    Winamax and ACR let the player choose, so it is the user's setting
    first), else `sites.json` `tables.preferredSeat` (`null` for every room
    until a capture says), else no. The simulator's `--preferred-seat` is
    the test case (its `slot_of` is the same formula with `heroSlot` 0); a
    unit test holds every size 2 - 10 x every hero seat x rotation on / off
    to the simulator's drawing.
  - **The hero's seat** comes with each hand (`PlayerRef.hero`, R3.4):
    `seats::hero_after` keeps a seat the hand does not mention while nobody
    else sits in it (not dealt in, sitting out), drops it when someone else
    does (the hero left) - **an observer (no hero ever) gets no rotation**,
    as the client draws the table by its numbers then. A tournament table
    move (`Retitled` with a new table, R3.5) forgets it with the players;
    the next hand brings the new seat. **Table size**: the window's (title,
    else the hand's `max_seats`), unless a hand names a seat past it (a
    9-max table turned 6-max under a window that still says 9, or the other
    way) - then the smallest of 6 / 9 / 10 holding every seat
    (`seats::table_size`); positions are per size, so a size change shows
    that size's. **Heads-up** is a size like any other (two slots, the
    hero at the bottom when rotated).
  - **Layout data.** `sites.json` `tables.seatLayouts` is now, per size
    `"2"`..`"10"`, `{seats: [[x, y]...], plate: [w, h], center: [x, y],
    heroSlot, graphics: [[x, y, w, h]...], seatNumbers}` in **thousandths of
    the client rect** (integers, the workspace forbids floats; the schema
    `$defs.seatLayout` and the validator check a seat per seat, everything
    inside 0 - 1000, `heroSlot` a seat, distinct seat numbers). **Every
    room's stays `null`**: no client has been measured (R3.3's capture,
    R3.14 with the real clients; `docs/research/CAPTURING-TABLES.md` now
    says how). A size without one gets **`TableLayout::simulator`** - the
    simulator's slots, plates and board, R3.4's default -, which is what
    every test draws on. The engine's `seats::Rooms` holds the measured
    layouts and `preferredSeat` from the configuration in force (rebuilt
    on `policy`), and the user's part from the store.
  - **User positions and persistence.** A panel the user dragged is
    centred where they left it: `layout::Positions` (slot -> centre in
    thousandths), per (room, size). The scene places those first - inside
    the client area, and on a room with `noOverlapTableGraphics` moved to
    the nearest place clear of the layout's graphics (`layout::constrain`:
    rings around the drop; none clear -> the layout's own place) - then
    every other panel next to its plate as before, clear of the user's.
    **Store**: migration 13 (`0013_hud_layouts.sql`, tested from every
    earlier version by `migrates_from_empty_and_from_every_earlier_version`)
    adds `hud_seat_positions (site, size, slot, x, y, updated_at)` (the
    `sites.json` room id - `acr`, not the store's `acrwpn` -, checks on
    every range) and `hud_room_settings (site, preferred_seat, updated_at)`.
    The HUD's connection stays read-only (R3.2): `Reader::hud_seat_positions`
    / `hud_room_settings` when the store opens and on `layout_changed` /
    `settings_changed`; the app writes (`WriterHandle::set_hud_seat_position`,
    `clear_hud_seat_positions`, `set_hud_preferred_seat`). **Not synced yet**
    (`updated_at` is there for last writer wins): R3.9 / R4.x.
  - **Drag (Windows).** The panels already took clicks (R3.4). The overlay
    thread's pump hands its own `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` /
    `WM_LBUTTONUP` to `Overlays::mouse` before dispatching: a press on a
    seat's panel (the last painted scene's `seat_panels`) starts a drag and
    takes the capture (`SetCapture`; feature
    `Win32_UI_Input_KeyboardAndMouse` of the locked `windows` =0.61.3, no
    new crate); a move with the button down, past Windows' 4 px drag
    threshold at the monitor's scale, repaints the panel where the pointer
    takes it - laid out by the scene, so constrained during the drag too; a
    move without the button is ignored (not a release: the capture brings
    the release, and `WM_CAPTURECHANGED` - noted by the window procedure,
    handled on `HOOKED` like R3.5's events - ends the drag where the panel
    is). The release keeps the panel where the last scene shows it (on the
    overlay, until a frame's `Seating::drags_seen` says the engine has it),
    and notes `TableEvent::PanelMoved {id, size, slot, x, y, seq}` in
    `tracking::Observed` (in order, never coalesced) for `poll_events`. A
    press that never passed the threshold is a click (R3.8's). **No store
    work and no wait on the overlay thread** (it runs the hooks): the
    engine remembers the position at once, redraws every table of that
    room and size with it, and sends `seat_position_changed {site, size,
    slot, x, y}` (protocol 1, a new HUD message: older apps ignore it as
    `Unknown`); the app's callback queues it to a thread of its own
    (`LayoutWrites`, `rail-hud-layouts`) that writes the store.
  - **ACR's graphics.** `noOverlapTableGraphics` binds the user's
    positions too (`compose_with`: the restriction from the frame's permit,
    not the design): a panel dropped on the board or a plate lands at the
    nearest clear place, and that is what is stored. On rooms without the
    restriction the user may put a panel anywhere inside the client area
    (the default layout itself still keeps clear of every room's graphics).
    The zones are the layout's: the simulator's plates and board in tests;
    ACR's real ones must be measured before its matcher is verified.
  - **A remote `sites.json` never loosens compliance through table data**
    (R0.12's rule extended, `rail_config::merge_tables`): for every size
    the shipped file has a layout for, the merged `graphics` are the
    **union** of the shipped and the remote zones - a remote file that
    shrinks or removes a zone, drops the size or the whole `seatLayouts`
    keeps the shipped zones (`MergeNote::TableGraphicsKept`); the restriction
    itself was already stricter-only (R3.4). The process names decide
    whose windows a room's matcher may take, so they only narrow: a subset
    of the shipped names where the shipped file has some, and never a name
    the shipped file gives another entry (`MergeNote::LooserProcessesIgnored`;
    a title regex then only chooses among the room's own windows and stays
    a correction). Geometry that does not bear on compliance - seat
    anchors, plate size, hero slot, seat numbering, `preferredSeat`, the
    title, the verification notes - may come from the remote file, and a
    size only the remote file has is taken as it is (new measured data).
    Tests: `merge::table_graphics_only_grow`, `processes_only_narrow`, and
    on the real shipped file `a_remote_file_cannot_shrink_acrs_table_graphics`
    (ACR's zone shrunk or removed by the remote stays; an added zone joins
    them).
  - **What a position is about (PokerStars).** PokerStars forbids
    switching the HUD's **display** by position, stack or opponent ("no
    display switching on position / stacks or on tendencies", R3.0). The
    seat mapping decides **where** a seat's panel is drawn - next to the
    player it describes, wherever the client draws them -, never **what**
    it shows: every panel shows the same statistics, whatever seat,
    position or stack. No per-position or per-seat statistic sets were
    added, and R3.9 must not add them on rooms with
    `noGameStateSwitching`.
  - **Test-only room entry over IPC.** `--sim-site` / `--sim-title` are
    accepted with `--ipc` too (tests that play the app need the channel;
    the app never passes them, and the entry takes only `rail-hud-sim`'s
    process). The simulator's `hand` event gains `seated` (seat, name,
    hero per player) for such tests.
  - **Tests.** All OSes: `seats` (every size x every hero seat x rotation
    on / off equal to the simulator's drawing, heads-up, a measured layout
    with its own hero slot and seat numbers, the hero's seat from hand to
    hand - observing, not dealt in, seat taken -, table sizes and a 9 -> 6
    size change, `Rooms`: the user's word over `sites.json`'s), `layout`
    (measured layouts, user panels avoided, `constrain`), `scene` (rotation,
    user positions and overrides, ACR keeping a dropped panel off its
    graphics, a seat past the size, a seat the numbering lacks), `drag`
    (press / threshold / move / release, a click, ACR), `tracking` (drags
    in order), `engine::seats_rotation_and_drags` (a real store: positions
    read at start, rotation only once the user's setting is read on
    `settings_changed`, kept while not dealt in, dropped when the seat is
    taken, forgotten on a table move; a drag told to the app and applied
    to both 6-seat tables but not the 9-seat one; nonsense from a backend
    not passed on; `layout_changed` reads the store again), rail-store
    (`hud` module: round trip, ranges refused by the writer and by the
    table's checks, per-room settings), rail-config (`seat_layouts_are_accepted`,
    three new validator cases), the ajv test (layout shape, refused shapes),
    the protocol (round trip, wire form), the app (`a_dragged_panel_is_written`:
    the layout thread writes the store). **Windows CI**
    (`hud/rail-hud/tests/windows_seats.rs`, in the `core` job's `cargo test`
    and again with its output in the step "HUD seats and layouts (steps)"):
    `panels_sit_at_the_drawn_seats` - the simulator's 6-, 9- and 2-seat
    tables with `--preferred-seat` off and on: every panel next to the
    plate the simulator draws for that seat by its own rotation, and the
    simulator's gold hero frame read off the screen (`BitBlt`) at the
    plate the HUD gives the hero (slot 0 when rotated);
    `acr_keeps_a_dragged_panel_off_its_graphics` - posted mouse messages
    (`drive::drag`) drag a panel onto the board: posing as ACR it lands
    clear of every plate and the board, posing as PokerStars where it was
    dropped; one `PanelMoved` each, a frame carrying the position keeps it,
    a click moves nothing; `a_dragged_panel_is_remembered` - the HUD
    process under the real supervisor, the simulator with
    `--preferred-seat`, the user's "my client rotates" in the store: the
    hero's panel (slot 0) dragged, `seat_position_changed` received and
    written with the app's call, a click at the new place reaches the
    overlay and at the old one the table; the HUD stopped and started
    again puts the panel back there from the store. Cross-checked locally
    with `cargo clippy --target x86_64-pc-windows-msvc -p rail-hud
    --all-targets -- -D warnings` (stand-in C compiler and archiver).
  - **Limits.** No real room's layout or `preferredSeat` is known (every
    room `null`): the HUD lays out every real table with the simulator's
    geometry until the owner's capture / R3.14 measures it - wrong for any
    real client, so the measurement is required before a room's `tables`
    block is marked verified. The drag is Windows
    only (macOS R3.12 feeds `platform::drag` the same way). Not tested with
    a real mouse (`SendInput`) nor on a high-dpi monitor (CI: posted
    messages, one 96 dpi monitor). No screen calls `hud_set_preferred_seat`
    / `hud_reset_seat_positions` yet (R3.9 / R3.10).
  - **For R3.7** (data path): `hand_imported` already sets the hero's seat
    and redraws; the layout follows `size_of` (window size, else the
    hand's seats) - when R3.7 reads a table's segment, read its size from
    the same place.
  - **For R3.8** (panel and popup): a press that never moves is a click
    (`Drag::release` returns `None` with `at` unset): open the popup there
    (`end_drag` is the hook), forwarded to the loop thread like a drop. The
    panel's identity on screen is its slot (`Scene::seat_panels`).
  - **For R3.9** (editor and presets): user positions are per (room,
    size, slot) in `hud_seat_positions`; a reset is
    `hud_reset_seat_positions` (+ `layout_changed`). A frame without a
    dropped position does not clear the overlay's own copy until its
    `drags_seen` passes that drop's `seq` - a reset that removes positions
    the overlay still holds must come with a frame whose `drags_seen` is
    current (the engine's frames always are). Sync `hud_seat_positions` /
    `hud_room_settings` (last writer wins by `updated_at`). No per-position
    statistic sets on rooms with `noGameStateSwitching` (PokerStars).
  - **For R3.11 - R3.13** (macOS): `seats`, `layout`, `scene`,
    `platform::drag` and `tracking::Observed::dragged` are shared - feed
    `Drag` the overlay's `mouseDown` / `mouseDragged` / `mouseUp` in client
    pixels, keep the drop on the overlay until `drags_seen`, report
    `PanelMoved`; never do store work on the AppKit main thread's run loop
    path beyond that.
  - **For R3.14** (real clients): measure each allowed room's seat plates,
    centre, board / pot / dealer zones per table size and its preferred-seat
    behaviour (where the hero is drawn) on a real install
    (`CAPTURING-TABLES.md` "Seat layouts"), into `tables.seatLayouts` /
    `preferredSeat`; ACR's zones above all.

### R3.7 Data path — S
- On `hand_imported`, reload rollups of that table's players, redraw;
  instrument the latency from file event to redraw and show it in debug builds.
- *As built* (§15): **done** - the HUD reads the right numbers for the
  right players, on restricted rooms from the user's own hands only, never
  from the hand in play, at once after a restart, and every hand's latency
  is measured from the watcher to the frame. `hud/rail-hud/src/engine.rs`
  (the data path), `data.rs`, `panel.rs` (the user's statistics), rail-store
  migration 14 (`0014_observed_rollups.sql`, `stats::fill_observed`), new
  reads in `stats_read.rs`, the watcher's `noticed_ms`, the protocol's
  `HandTiming` / `LatencyChain`, the app's feeder.
  - **The table's segment.** A table's players are read over **the
    segment its hand is summed in** (`Reader::hud_hand`: `hand_stats.
    segment_id` - site, format, variant, limit, table-size class, stake as
    the hand has them; R2.3's definition, `SEGMENT_VERSION` included), kept
    per window and replaced with each hand (a table move forgets it).
    Decided against rebuilding the segment from R3.6's layout size: the
    rollups of this table's own hands are keyed by the hand's `maxSeats`
    class, so a title that disagreed with the hand would read a segment
    without the table's own hands. The two only differ when a room's title
    and history disagree on the size; R3.6 keeps laying the table out by
    `size_of`. A hand the store has no statistics row for (or a store error)
    falls back to every segment of the site, as R3.2 read. Opaque-id rooms'
    villains are read under the scope the store wrote with the hand
    (`PlayerRef.scope` = `seat_stats.scope`, `<table>@<UTC day>`), never
    across sessions - no allowed room has them today (GGPoker is
    prohibited; ACR's own client writes screen names), the path keeps them
    right anyway. The hero's panel is read like every seat's: the hero's
    rollups are by definition hands the user played.
  - **`ownHandsOnly`, decided: a separate rollup of the observed part,
    subtracted at read time.** PokerStars, Winamax and ACR allow statistics
    only from hands the user played (PokerStars' guide allows up to 30
    observed hands per session to seed a HUD; Rail takes none). A hand the
    user played = a hand **with a hero seat** (the parser's `Dealt to`; a
    hand sat out without cards counts as observed, the strict side). The
    store now keeps **`player_rollups_observed`**: per (site, player,
    scope, segment) the sums of the seat rows of hands without a hero seat,
    the same columns and rules as `player_rollups`, written by the same
    `stats::Pending` in the hand's transaction (one more map, filled only
    for a hand without a hero - a played hand writes nothing more), summed
    again by a recompute and swapped in with the others (a fifth summed
    table: `Summed::Observed`, twin `recompute_player_rollups_observed`);
    the custom pass keeps **`custom_player_rollups_observed`** the same way.
    The HUD reads `Reader::hud_own_totals` = `player_rollups` less the
    observed part (`Totals::subtract`; exact: every column is an integer sum
    of seat rows under the same exclusions), one more key range per player,
    one read transaction; `custom_player_totals(.., own_hands_only)` alike.
    Considered and not built: a rollup of the played part (it would double
    the writes of every played hand - nearly all of a user's); a column in
    `player_rollups`' key (every reader and the Players screen would have to
    filter it); filtering seat rows at read time (no index from a player to
    their hands without the background pass's lag, and a regular's
    thousands of rows would not be sub-millisecond). **Migration 14**
    (tested from every earlier version, and from a version-13 store with
    hands, a counted custom statistic and a rows job running:
    `tests/observed.rs`) creates the three tables and fills the observed
    part in its own transaction from the stored rows (`stats::fill_observed`:
    SQL cannot read the counter blob); when there are observed hands the
    user's statistics are counted again (their observed part needs the
    decision events); a rows job an older build left running is begun
    again (its twins had no observed part). R2.11's dependency map gains
    both tables (`Table::PlayerRollupsObserved`: resummed by the rows and
    segments jobs; `Table::CustomPlayerRollupsObserved`: with the custom
    counts) and its schema test passes; `tests/common::assert_rollups`
    holds the observed part to the rows after every write and every kill of
    both crash tests.
  - **Cost, measured** (M2 Pro, load 6-9). Import gate, 100k generated
    hands, 3 threads, interleaved with `staging`'s build: **staging 60 /
    60 %, this branch 59 / 60 %** (7 248-7 275 vs 7 253-7 321 hands/s) -
    the gate's dataset has 0.7 % hands without a hero. Worst case, the
    corpus with every `Dealt to` removed (89 % observed), one thread
    through `import_file`: 359-381 us a hand vs 367-382 us as it is - no
    measurable difference (the hero rows, EV and hero rollups such hands
    lose pay for the observed upserts). HUD lookup at 500k hands with
    300 000 padded players (`stats_queries --pad`, release): 9 players over
    the table's segment **88 us median / 109 us p99; own hands only 121 us /
    154 us**; `hud_hand` 2 us; a table's newest hand 7 us (found) and 2.5 ms
    median (not found: 5 000 newest hands looked at, on attach only).
  - **Nothing from the hand in play** (ACR's rule; every room by design).
    The HUD reads nothing but the store; the rooms write a hand's history
    once it has ended; the watcher stores a hand only once its file has
    been quiet for 500 ms with a hand that validates, or the next hand has
    begun (R1.3) - a hand still being written is never stored, so no
    re-read (`hand_imported`, `resync`, `stats_changed`, the store's own
    `data_version` check) can count it. `tests/in_play.rs` (the real
    watcher): a table shows one hand while the next is played (nothing in
    the file, 1.5 s of re-reads) and while it is written in four pieces
    100 ms apart (re-read after each), the store holding one hand
    throughout; written and quiet, it is imported, announced and counted.
    **Found while building it**: R1.3's stated assumption is load-bearing -
    a PokerStars hand cut at the flop *validates*, so a room that stopped
    writing mid-hand for longer than the quiet period, at a line end, would
    get the prefix stored (and the full hand then deduplicated away). No
    room seen writes that way; R3.14 must confirm it on the real clients
    before a room's `tables` block is verified (a per-room "hand finished"
    marker in the reader is the fix if one does). The HUD's re-reads are
    not tied to `hand_imported`: a committed hand can be counted by a
    re-read before its message arrives (R3.2's `data_version` check) - it is
    complete then, so that is not the hand in play.
  - **Attaching to a table with hands** (R3.2's limit: a restarted HUD
    waited for each table's next hand). A window with no hand announced
    since this process started is filled from **its table's newest stored
    hand** (`Reader::latest_hand_of_table`: `hands_imported_at_idx` newest
    first - no sort, checked by `EXPLAIN QUERY PLAN` -, the room by
    `hand_key`'s prefix, the table by `table_key`, at most 5 000 hands
    looked at), only when that hand was **played and imported in the last
    15 minutes** (`Settings::restart_window`): an older hand of a reused
    table name could seat players who have left; a hand without a
    `played_at` never counts. Players, seats, hero, segment and table size
    come from the store; then the usual re-read. No new index on `hands`
    (migration 10 dropped one there: ~7 % of the writer's time per hand).
    Tests: the
    engine against a store (the corpus hand from 2014 is too old by default
    - the table waits - and found with a long window: the table's numbers,
    seats and size at once) and **end to end** (`a_restarted_hud_shows_its_
    tables_at_once`: the HUD killed with `kill -9` / `taskkill`, the
    supervisor's new process shows every table with its newest hand and
    the same numbers before any new hand).
  - **The user's statistics (R2.10) in a design.** `PanelStats::with_custom`
    compiles a design's ids against the shipped definitions, else the
    user's own (`CustomSet` from the store, read when the store opens and
    again on `stats_changed` / `settings_changed` / `layout_changed`); a
    cell of a user's statistic is evaluated through its definition over
    `custom_sums` with the player's counts (`custom_player_totals`, own
    hands only where the room says so). The default design has none, so no
    extra read happens today; `Hud::set_design` is R3.9's hook. Their
    counts lag the hand by one step of the app's background pass (the
    import only wakes it): the HUD shows them at its next re-read (the
    store's `data_version` check, every 2 s).
  - **Latency, per hand** (§3.3). The watcher stamps the first change it
    noticed since a file's last commit (`WatchEvent::Imported.noticed_ms`:
    the OS notification or a walk); the app stamps the commit's report and
    the send (`hand_imported.timing`, `HandTiming`, optional: protocol 1
    unchanged); the HUD stamps the arrival, the re-read and the frame
    handed to the backend (`LatencyChain`, Unix microseconds - one clock on
    one machine) and returns it in `table_updated.chain`, appends it to
    `--latency-report <file>` (JSON lines) and, **in a debug build only**
    (`cfg!(debug_assertions)`), draws it on the table as one small line in
    a corner clear of the table's graphics (`OverlayFrame.debug`; `None` in
    every release frame, a test checks both). On Windows the frame is
    painted on the overlay thread right after (R3.4: p50 2.1 ms). The e2e
    prints every stage and asserts the whole chain's **p95 < 1 s** (and the
    slowest hand < 5 s on shared runners). M2 Pro, debug: PokerStars 3
    tables, 12 hands - chain p50 506 ms, p95 522 ms; **12 tables, 96
    hands - p50 506 ms, p95 521 ms, max 527 ms** (notice -> import 503 /
    516 ms, import -> sent 1.7 / 3.4 ms, IPC 0.14 / 0.24 ms, re-read 0.8 /
    2.3 ms, frame 0.4 / 1.0 ms; the file's write -> the watcher's notice 12
    ms before it); ACR 2 tables - p50 515 ms. The quiet period is the whole
    story; everything after it is ~3 ms.
  - **`stats_changed` and `tables_open`** (R2.11, R3.2), verified: a
    recompute (a rows job over rollups made "older" by hand) swaps the new
    statistics in and `stats_changed` makes the HUD read every table again
    with the new numbers (`tests/data_path.rs`); while the HUD reports
    tables open, the app's pass starts no recompute work and swaps nothing
    (activity `paused-tables`, the epoch unchanged), and runs it once they
    close (the app's `tables_open_is_passed_on_at_its_edges`).
  - **Tests.** rail-store `tests/observed.rs` (own hands only: every
    counter equal to a store of the played hand alone, custom counts too;
    the observed part through a recompute; migration 14 from version 13
    with data; a table's newest hand and its query plan); rail-hud
    `tests/data_path.rs` (a restricted room never counts the observed hand,
    whichever hand is announced; restart; swap; a user's statistic; the
    chain and the debug line), `tests/in_play.rs`, the e2e (chain stages,
    the report file, restart); protocol round trips and wire form with
    `timing` and `chain`; the app's feeder stamps and the pause. Parity
    unchanged (no statistic computed differently); the crash tests, the
    dependency-map test and the import gate green.
  - **Limits.** "Own hands" is "a hand with a hero seat": another player's
    histories imported into the user's folders (with their own `Dealt to`)
    count as played - the app imports the rooms' own folders; a list of the
    user's screen names per room would close it (`hands.hero_name`). The
    restart lookup gives up after 5 000 hands (a backfill just imported):
    the table then waits for its next hand. No real client is measured yet,
    so every number above is the simulator's.
  - **For R3.8** (panel and popup): the panel's numbers are already over
    the table's segment and, on the three allowed rooms, own hands only -
    the popup must read the same way (`Reader::hud_own_totals` with the
    window's `segment`, `custom_player_totals(.., own_hands_only)`), and
    "stats by situation" there must come from own hands too (the seat rows
    of hands with a hero seat). The legend shows the thresholds actually
    used (`collapse_tone`). A click arrives on the overlay thread (R3.4 /
    R3.6 notes); `open_in_app` carries the player's scope. The debug line
    sits in a corner the popup may cover; it is debug-only.
  - **For R3.9** (editor): `Hud::set_design` takes a design whose ids may be
    the user's statistics; the frame does not carry the design yet (the
    backends draw `PanelDesign::default`'s cells) - pass it with the frame
    or the backend when the editor lands, and flag a user's statistic with
    a card predicate `card_split` so PokerStars drops it.
  - **For R3.14**: confirm on each real client that a hand's history is
    written whole after the hand (the in-play guarantee above), and measure
    the chain there.

### R3.8 Panel and popup — M
- 4–6 stats, colours from thresholds with legend, dimming from R2.5, hand
  count; popup on click with stats by situation and notes (webview window,
  `packages/ui`).
- *As built* (§15): **done** - the panel has its legend and, where the
  room allows labels, the user's words; a click opens the app's popup
  beside it without taking the keyboard from the table; the app hides
  what could help with play while tables are open (A10). `hud/rail-hud`
  (`panel.rs`, `scene.rs`, `engine.rs`, `layout::place_legend`, the
  overlay's click), `rail-hud-ipc` (`open_popup`), `rail_config::stats`
  (`Tone::collapse`, `collapse_bands`), `rail_store::Reader::
  player_own_positions`, the app's `popup.rs`, `src/popup/HudPopup.tsx`,
  `src/lib/duringPlay.ts`.
  - **The panel.** The six `hud: panel` definitions (VPIP, PFR, 3B, F3B,
    CB, AFq) and the hand count, R2.4 bands, R2.5 opacity - unchanged
    from R3.4 / R3.7. New: **the legend**, one small pill in the first
    corner of the client area clear of the table's graphics, every panel
    and the debug line (`layout::place_legend`; none when no corner is
    free - the panels matter more), one sign per tone the panels can show
    after the room's collapse, in that tone's colour: `--` `-` `=` `+`
    `++` (signs, not words: the HUD draws no language; the popup says
    them in words). The default design colours by at most two thresholds
    everywhere, so every allowed room's legend is `-` `=` `+` today; a
    design with no limit (R3.9) shows five on ACR / Winamax and still
    three on PokerStars (`maxColourThresholds: 2`). The legend's tones are
    the panel definitions' bands (`PanelStats::legend_tones`) through
    `panel::legend_tones` (`Tone::collapse`, moved to `rail_config` so the
    app's popup collapses the same way). Like every drawn pixel it takes
    clicks (it is in `Scene::panels`), never a seat's (`seat_panel_at`),
    so a click there does nothing.
  - **The user's words on the panel** (R2.7c's colour, labels, note):
    read with each re-read by `Reader::player_notes` (a key lookup per
    seat) only when the design shows them and the permit's room does not
    forbid labelling players (`noPlayerLabels`), never for the hero or an
    opaque-id seat (scope not empty); drawn as a colour bar down the
    panel's left edge (`scene::tag_color`: six bright colours, each well
    apart from the panel's near-black, so the contrast holds on any felt),
    a small yellow corner mark when there is a note, and the labels as a
    third row. **Per room**: PokerStars none (Reference Guide: no "rating,
    labelling or categorising players"), ACR none (4.2.10 "Player
    labeling"), **Winamax all three** (no such restriction). The default
    design now asks for them (`player_labels: true`) and enforcement takes
    them away on the two rooms - `the_default_design_complies_with_every_
    room` pins exactly that (Winamax the only room with labels).
  - **The click.** A press that never left the drag threshold and whose
    button came up over the overlay (`end_drag(.., released: true)`; a lost
    capture or a release the thread never saw is nothing) is
    `TableEvent::PanelClicked {slot, panel on the screen, scale}`, noted on
    the overlay thread and handed to the loop with the drags (`Observed`,
    in order, dropped with a closed table). The engine finds the player at
    that slot as the panel was placed (layout, rotation) and sends
    **`open_popup {window, site, storeSite, table, player (scope, seat,
    hero), segment, slot, anchor, scalePermille}`** (protocol 1: a new
    message type is not a protocol change); a slot nobody sits in, or a
    room no longer permitted, sends nothing.
  - **The popup: architecture.** The app's supervisor callback hands the
    target to the main thread (`popup::request`), which opens **one Tauri
    webview window** (`hud-popup-<n>`, the app's own page on
    `#/hud-popup`; `main.tsx` renders `HudPopupWindow` there instead of the
    shell; the capability covers `hud-popup-*` with `core:default` only)
    beside the panel: right of it, else left, top-aligned, else below /
    above, inside the work area of the panel's monitor (`popup::place`),
    380 x 560 logical at the table's scale. Another panel's click moves
    the open one and tells it to read again (`hud-popup-changed`); the
    same panel again closes it; a room not permitted opens nothing. The
    window asks `hud_popup` for what it shows: the app reads the store
    (the HUD's connection stays read-only) over **the same rows as the
    panel** - the table's segment, `hud_own_totals` on own-hands-only
    rooms. Writes (colour, labels, note) go through the app's existing
    player commands; the panel's mark follows at the HUD's next re-read
    (the store's `data_version`, 2 s). "Open in Rail" shows the main window
    on the player's profile (`hud-open-player`, now listened to by the
    shell).
  - **The popup: focus.** Built hidden and unfocused (`focused(false)` on
    window and webview), frameless, always on top, off the taskbar, then
    shown: on Windows tao shows a window built unfocused with
    `SW_SHOWNOACTIVATE` and sets it topmost with `SWP_NOACTIVATE`, so the
    table keeps the keyboard (the user's bet keys keep working). A click
    into the popup gives it the keyboard (to type a note); then a click
    elsewhere closes it (`WindowEvent::Focused(false)`). It is destroyed,
    never hidden, on close. **Limits**: an unfocused popup cannot see a
    click on the table (it never had the keyboard and the click is not
    its), so it also closes when the pointer leaves it after having come in
    (350 ms, not while a field has the keyboard) - "click outside" is
    approximated by "leave"; Esc works once it has the keyboard; macOS is
    not wired (R3.11 - R3.13: a non-activating `NSPanel` is the equivalent;
    Tauri's window there activates the app). Not checked on a real
    Windows desktop with a real client (CI has no interactive desktop for
    a webview; the mock runtime covers the window's state).
  - **The popup: what it shows, per room** (`PopupRules` from the shipped
    `sites.json`'s restrictions). Statistics: every R2.4 definition with
    `players: any`, `hud` panel or popup and no money unit (an opponent's
    money is never shown; the hero's all-in EV is `players: hero`),
    grouped as the Players screen, coloured by at most two thresholds
    (fewer where a room says), R2.5 reliability and interval as everywhere;
    each statistic's thresholds in words under "Colours"; hands together
    and your result against them in big blinds, cash and tournaments
    apart, never added (R2.7c's rule). **By position**: `player_hands`
    seat rows - on own-hands-only rooms through the new
    `Reader::player_own_positions` (hands with a hero seat, R3.7's rule) -
    **only where `noGameStateSwitching` is off: ACR**. Decided: PokerStars'
    guide forbids "a display that changes with the game state other than
    the game format and the opponent's name"; a table of every position in
    a popup does not switch, but whether PokerStars reads a per-position
    split that way is not clear, so it is hidden on PokerStars (and on
    Winamax, whose `noGameStateSwitching` R3.0 set as conservatively), and
    the popup says why. **The user's words**: only where labels are allowed
    (Winamax), shown and editable; on PokerStars and ACR **none of them,
    not even the note** - a note typed into the HUD at the table is a
    label in all but name, and their bans are on the tool, not on where it
    is drawn; the popup says they stay in the Players screen (which is off
    the table and unaffected). The hero's own panel opens the hero's
    statistics only; an opaque-id seat its session's statistics, no words,
    no rows by name. Nothing about the hand in play, no advice, no ranges
    or equities (a line says so). i18n en + hr; keyboard: the close
    button and every control reachable by Tab, the colour tags an ARIA
    radio group (R2.7c's component).
  - **A10** (guideline §7). The app has **no** analysis, solver, equity or
    chart screen (analysis is the web's; R5.4 brings it in). The gate is
    in place: `lib/duringPlay.ts` classifies every route (`SCREEN_HELP`,
    all `null` today, a `Record` over the routes so a new screen must
    choose) and the shell shows a "hidden while a poker table is open"
    notice instead of a screen that helps with play while `tables_open >
    0` (`useTablesOpen`: `hud_status` at mount, then the app's
    `hud-tables-open` event on each edge, which the HUD's `tables_open`
    drives; the popup closes when the last table does). What the app does
    have that helps with play is hidden too: the replayer's **pot odds**
    (`ReplayViewer potOdds`, a new prop of `packages/ui`) and Reports'
    **13 x 13 starting-hand chart** (PokerStars also bans hand charts).
  - **Tests.** rail-config (tones and bands collapse); rail-hud: panel
    (label suppression per room, legend tones per room), scene (words
    drawn on Winamax only, legend's tones / place / clicks, tag contrast),
    layout (`place_legend`), drag (click vs drag), tracking (clicks in
    order with drags), engine (`open_popup` for the player at the slot,
    words read only on Winamax and never for the hero, nothing for an empty
    slot or an unknown window); rail-hud-ipc round trip and wire form;
    rail-store `positions_from_own_hands_only`; the app (`cargo test -p
    rail-app`, Tauri's mock runtime, on Linux, macOS and Windows): the
    rules per room, the popup over a store per room, one window opened /
    moved / closed / refused, and `open_popup` from the HUD's message
    through `on_event` to the window, the tables' edges and the popup
    closing with the last table; `tests/test/appDuringPlay.test.ts` (A10).
    **Windows CI** (`windows_seats.rs`): a click on a simulator panel is
    `PanelClicked` with the panel on the screen (a drag still is not); tags
    on real windows posing as Winamax (the screen pixel is the tag's
    colour), none as PokerStars or ACR, the legend clear of every panel;
    the HUD process under the real supervisor: a click on a villain's
    panel is `open_popup` for that player and slot, the anchor around the
    click, a drag is `seat_position_changed` and no popup. The popup page
    was checked in a browser with mocked Tauri calls and made-up data
    (Winamax, PokerStars, ACR rules; Esc closes).
  - **Found on Windows CI.** (1) R3.7's chain lost its `noticed` stamp
    for a hand written within the quiet period of the one before: the
    watcher commits the first hand when the next one starts and the second
    by a recheck once the file is quiet, and the first commit took the only
    stamp. A commit that leaves bytes behind now leaves them the latest
    change noticed before it (`FileRt::committed`; a unit test, and the
    e2e asserts the stamp on its own). (2) The app's library test binary
    did not start (0xc0000139, `STATUS_ENTRYPOINT_NOT_FOUND`): Tauri links
    its application manifest (Common Controls 6) into `bin` targets only,
    and the mock app's tray and menus reach `LoadIconMetric`. `build.rs`
    now hands the manifest to the linker for every target on MSVC
    (Tauri's own workaround); CI runs the app's tests one at a time with
    their output, and the window tests print their steps. (3) The
    popup's Windows test kept its store in `rail-hud-popup-<pid>`, the
    very folder the simulator helper made for a simulator named `popup`;
    Windows cannot remove an open database, so the simulator found a
    folder it had not made and refused it (exit 2, on its standard error)
    while the test waited 90 s. The helper's folders are now
    `rail-hud-sim-<name>-<pid>`, and it reads the simulator's standard
    error and the end of its output as events: a wait fails at once when
    the simulator is gone, with its stderr and exit status.
  - **For R3.9** (editor): `PanelDesign` gains `legend`; `player_labels`
    is on by default and enforcement removes it - an editor must not offer
    labels on PokerStars / ACR at all. A user's colour bands override
    the definitions' (the legend reads the bands the frame's statistics
    use - pass the design's bands with the frame). The popup's statistic
    list is the definitions' `hud` membership; a user popup layout would
    be an override of the same list.
  - **For R3.10** (compliance mode in the app): the popup reads the
    *shipped* `sites.json` (the app does not download the remote copy yet);
    when it does, `PopupRules::for_site` must ask the merged one, as the
    HUD does. The status's `attach_refused` list is still unshown. A10's
    gate is `duringPlay.ts`; R3.10's "analysis and solver screens hidden"
    is that gate once R5.4 adds a screen - the sidebar and the command
    palette should then leave the screen out too (today only the shell
    replaces it).

### R3.9 HUD editor and presets — L
- In the app's HUD screen: drag-and-drop stats, presets for cash, MTT and Spin,
  per room and table size; `hud_layouts` locally and in Supabase (migration).
- *As built* (§15): **done** - the HUD screen is an editor: the user
  builds a panel by dragging statistics (or with the keyboard), sets each
  one's colours, decimals and sample, lays out the popup, starts from a
  preset for cash, tournaments or Spin, chooses which design each room,
  table size and game gets, and sees it on a made-up table drawn by the
  HUD's own renderer; the HUD draws the assigned design on every table,
  each room's rules cutting it down; designs and layouts follow the
  account to another computer. `hud/rail-hud/src/design.rs` (the model,
  presets, room checks, assignments), `config/hud/presets.json`,
  `panel.rs` / `scene.rs` / `engine.rs` (the design in the frame),
  rail-store migration 15 (`core/rail-store/src/hud.rs`), Supabase
  `20270602090000_hud_layouts.sql`, `rail_sync::ingest::hud` and the
  worker's HUD step, the app's `hud_editor.rs` and `src/screens/hud/`,
  card fields in R2.10's language (`rail_stats::custom`, STATS-SPEC §14.1).
  - **The design** (`design::HudDesign`, JSON, `version` 1; a newer
    version is not read): `cells` in order - a statistic id each, a shipped
    R2.4 definition or the user's R2.10 statistic, optionally `when`
    (`StackWhen {belowBb, atLeastBb}`: shown only at those stack depths of
    the player's starting stack in the table's last finished hand) -,
    `columns` (1 - 6 to a row; rows as the cells take), `overrides` keyed by
    statistic id (`bands`, `decimals`, `minSample`: R2.4's note - a layer
    over the definitions, never an edit of `config/stats/`), `popup`
    sections (`group` or the user's `title`, statistic ids), `legend`,
    `playerLabels`, `maxColourThresholds`, `format` (what it is made for)
    and `preset` (what it was copied from: "reset to preset"). At most 12
    cells, 8 popup sections / 40 statistics; no statistic twice on the
    panel; no hero-only statistic (all-in EV) and no money anywhere (a panel
    describes opponents); override bands ascending, at most 5
    (`design::check`, problems by code for the editor's words).
  - **Presets** (`config/hud/presets.json`, compiled in; a test holds each
    valid): `cash` (R3.4's panel - VPIP, PFR, 3B, F3B, CB, AFq, three to a
    row, two thresholds, the player's words where allowed), `mtt`
    (VPIP, PFR, 3B, Steal, FvSt, CB - stealing and defending the blinds),
    `spin` (VPIP, PFR, Steal, FvSt, 3B, Limp - three-handed hypers), each
    with its popup sections and complying with every allowed room; and
    **`mtt-stack`** ("tournament by stack depth": from 20 bb F3B and CB,
    below 20 bb Steal and FvSt) - display switching by game state, so
    **only ACR** may take it; PokerStars and Winamax refuse it, and the
    editor says why. `defaults` gives each format's preset when nothing is
    assigned (cash -> `cash`, tournaments and sit-and-gos -> `mtt`,
    Spin -> `spin`).
  - **Assignments** (`hud_layout_assignments`: room or `*`, size 2 - 10 or
    0 for every size, `cash` / `mtt` / `spin` or `*`; a table's format is
    its last hand's segment, `GameFormat::of_hand`): the most specific wins
    - **room, then format, then size** (`Assignments::resolve`; an
    assignment of a design that is gone is passed over), else the format's
    preset. Decided: format before size, because a tournament design at a
    6-max table matters more than a 6-max design for cash.
  - **Restrictions, editor side** (`design::check_for_room`, per allowed
    room's `hud.restrictions`): `noCardSplitStats` refuses a card-split
    statistic (PokerStars); `noGameStateSwitching` refuses a `when` cell
    (PokerStars, Winamax); `maxColourThresholds` refuses a statistic
    coloured by more thresholds than allowed after the design's own limit
    and the user's bands (PokerStars: 2); `noPlayerLabels` is a **note**
    (PokerStars, ACR: the words are never drawn there - the toggle says
    "Winamax only"). The app refuses to assign a design a room would refuse
    (`hud_assign`; `*` = every allowed room) and to save a design that a
    room it is assigned to would then refuse (`hud_design_save`), naming
    the room and the problem; the screen lists, while editing, where the
    draft may be used and why not. ACR's "nothing from the hand in play",
    own hands only and raw counts are structural (R3.7's data path; a stack
    cell reads the last *finished* hand's stack; every formula reads the
    player's own counters) and not checked per design.
  - **Card-split statistics** (R3.7's note). R2.10's language had no card
    field, so a user could not write one: it gains three seat fields from
    the seat's known hole cards (`cards_known`, `pocket_pair`, `suited`;
    none without two known cards - `not pocket_pair` is true where the
    cards are unknown, the spec says to write `cards_known and not ...`).
    `Field::reads_cards`, `CustomCounter::reads_cards` and
    `CustomSet::card_split(id)` - its predicate names one, or its formula or
    sample reads the counters of a statistic that is, through any chain.
    No other field changed meaning, so `EVENTS_VERSION` stays `events/1`.
  - **Restrictions, renderer side (defence in depth).** The design becomes
    the renderer's `PanelDesign` (`design::panel_design`: each slot flagged
    `card_split` and `ByGameState` for a `when` cell) and
    `PanelDesign::enforce` drops what the frame's permit forbids, as since
    R3.4 - now including a slot with a `when` that claims to be fixed. So a
    design that changed after it was assigned (a user's statistic edited to
    read the cards), or synced from another computer, can never put a
    card-split or switching statistic on a PokerStars table; the Windows
    test below holds it on real windows.
  - **The design travels with the frame** (R3.4 / R3.7 / R3.8 notes).
    `OverlayFrame.design` carries the table's (enforced at layout); the
    Windows overlay and the sim backend lay out `frame.design` (the
    overlay thread no longer keeps a design of its own). The engine
    (`design::DesignSet`) reads the user's designs, assignments and - when
    a design names one - the user's statistics from the store at open and
    on `layout_changed` / `settings_changed` / `stats_changed`, resolves
    each window's design from its room, size and format, compiles each
    design once (`PanelStats::compile` with the overrides) and draws each
    table's cells and legend with it: **the legend reads the bands the
    frame's statistics use, the user's own included**. `Hud::set_design`
    stays as a test/tool override for every table. `open_popup` gains the
    design's id (`design`, optional: protocol 1 unchanged); the popup shows
    the design's sections (user's titles, else the group's), the user's
    bands and decimals, by no more thresholds than design and room allow;
    without one, every definition by group as before. A cell's text uses
    the override's decimals (whole numbers by default, as R3.4). Panel
    size: `columns` to a row and as many rows as the cells take
    (`Metrics::panel_rows`); R3.4's two-row rule stays for a design without
    `columns` (the old default). `Scene::seat_cells` records what each panel
    shows (tests, the preview).
  - **Stacks for the `when` cells**: `PlayerRef.stack_bb_tenths` (optional,
    protocol 1 unchanged) from `seat_stats.starting_stack_bb_tenths` of the
    hand the app announces (`Reader::newest_hands_of_file`) or the HUD finds
    on attach (`latest_hand_of_table`); 0 (no big blind) is unknown, and an
    unknown stack shows no `when` cell.
  - **The editor** (HUD screen; `hud_editor.rs`: `hud_editor_state`,
    `hud_design_check`, `hud_design_save`, `hud_design_delete`,
    `hud_assign`, `hud_preview`; the app now depends on `rail-hud`'s library
    for the model and the renderer). Designs: presets read-only ("make my
    copy"), "new design from" a preset, name, format, save, discard, reset to
    preset, delete (a dialog; its assignments go with it). Panel: the
    statistics list by group with search, the user's marked "yours" and
    card-split ones "reads the cards"; the cells as a grid of the design's
    columns; **drag and drop** (HTML5: a statistic onto a cell goes in
    before it, onto "drop here" at the end; a cell onto another moves
    there) with a **keyboard alternative** (each statistic's Add button; a
    focused cell moves with Alt+Left / Alt+Right and goes with Delete, focus
    kept; Move earlier / Move later / Remove in the cell's settings; every
    change announced in a live region); per cell: decimals, the sample for
    full colour, the user's own bands, "show only at some stack depths"
    (warned: not on PokerStars or Winamax); columns, colour thresholds,
    legend, the player's words ("Winamax only"). Popup: sections, titles,
    statistics added / moved / removed. Rooms: the draft checked as it is
    edited (200 ms pause), each room "may be used", "may be used; there -
    (what it leaves out)" or "may not be used - (why)". **Preview**: the
    room and table size picked, made-up players and numbers (stacks of 12
    and 60 bb, so `when` cells show on some panels; one villain with a tag,
    a label and a note; one seat dimmed), the user's dragged panels of that
    room and size, laid out by `scene::compose` under the room's permit and
    drawn as SVG over the simulator's table geometry - exactly what a
    table shows, the room's cuts included; R3.6's "put dragged panels back"
    (`hud_reset_seat_positions` for that room and size: the engine's
    repaint on `layout_changed` carries a current `drags_seen`, so the
    overlay drops its own copy) and "my client seats me at the bottom"
    (`hud_set_preferred_seat`) under it. **Assignments**: a matrix of every
    room and "every room" by every game, Cash, Tournament, Spin, at every
    size or one, each cell showing what it falls through to today (the
    HUD's own resolution, `resolved` in the state) or the design chosen
    there; a refused choice is not kept and the room's reasons are shown.
    en + hr. Every write tells the HUD (`layout_changed`) and wakes the sync
    worker; a pull that changed something emits `hud-layouts-changed` and
    the screen reads again.
  - **Store** (migration 15, tested from every earlier version by the
    migration test; the older-store tests' downgrades drop it first):
    `hud_layouts` (id, design JSON or NULL for a deleted one, `updated_at`,
    `dirty`), `hud_layout_assignments`; R3.6's tables gain `dirty` and
    (positions) `cleared` - a reset is now a tombstone, "as `sites.json`
    says" a NULL row - so deletes and resets sync. The HUD's connection
    reads only (`Reader::hud_layouts`, `hud_layout_assignments`; positions
    and settings filter tombstones out).
  - **Sync** (R1.9's worker, every pass): the dirty rows of all four HUD
    tables (`Reader::hud_sync_dirty`) go to `put_hud_layouts` (500 a call),
    then are marked clean unless they changed meanwhile; **every minute**
    (`SyncConfig::hud_pull_every`, its own schedule) and with each hands
    pull (every 5 minutes, and on "Sync now") the whole of the account's
    `hud_layouts` (pages of 1 000) is applied by **last writer wins on
    `updated_at`**, a tie keeping the local row, a row this build cannot
    read refused whole (`WriterHandle::hud_sync_apply`); when that changed
    something the worker's hook runs (`SyncWorker::on_hud_layouts`: the app
    tells the HUD and the screen). A failure backs the HUD part off on its
    own and never holds up the hands. Every HUD write here wakes the
    worker (the editor's saves and assignments, a drag through the HUD's
    layout thread, a reset of dragged panels, the preferred seat), so a
    change leaves at once and reaches another computer within its next HUD
    pull - never waiting for an unrelated event. **Found on CI**: the first
    version pulled the HUD rows only with the hands pull (every 5
    minutes), so an edit made on one computer just after the other's pull
    waited up to 5 minutes there; the sync test caught it as a race (its
    second computer had pulled before the first one's push landed) - hence
    the HUD's own pull schedule, and the test now waits for the push to
    land and then for the other computer's own scheduled pull, with no
    "Sync now". Supabase: one table `hud_layouts`
    (owner, kind, key, jsonb body or null, `updated_at` bigint), select-own
    RLS, writes only through `put_hud_layouts` (definer, `auth.uid()`,
    validated whole, 500 a call, 5 000 an account, rate limit
    `hud_layouts:`); `docs/DATABASE.md` "The HUD's layouts" has the threat
    model. **Not applied to production.**
  - **Tests.** rail-stats: card fields on a fixture (the hero's and a shown
    hand, unknown elsewhere), `card_split` through chains. rail-store
    (`hud` module): designs and assignments (a delete clears its
    assignments, the checks), tombstones, LWW apply (newer, older, tie, new,
    refused shapes), pushed-then-changed stays dirty. rail-hud: `design`
    (every preset valid and on which rooms - `mtt-stack` on ACR only; each
    check by code; each room's refusals; fallback order; stack ranges; the
    JSON round trip; ids), `panel` (overrides colour, print and dim the
    cells and drive the legend; a `when` cell per stack; a `when` slot
    claiming to be fixed still dropped), the engine
    (`designs_follow_the_assignments`: a real store, a user's design for
    every room - two columns, a card-split statistic, a stack cell - all of
    it on ACR with the stack cell beside the short stack only, no stack cell
    on Winamax, neither on PokerStars; cleared, the cash preset), the IPC's
    wire form. rail-sync: `hud_layouts_follow_the_account` (two stores, one
    scripted server: the laptop's rows reach the desktop and its hook runs,
    a later edit wins on both, a reset and a delete travel, each row sent
    once per change). pgTAP `hud_layouts.test.sql` (35); full suite 33
    files / 1 082 tests on an isolated stack (`rail-r39-hud`, ports 567xx);
    the wire form checked there with curl as a made-up user;
    `database.types.ts` regenerated. The app (`cargo test -p rail-app`):
    the state, save / assign refusals, the preview is the renderer's (the
    room's cuts, the stack cell beside short stacks), the popup's
    sections, bands and thresholds over a store. **Windows CI**
    (`hud/rail-hud/tests/windows_designs.rs`, also a step of its own): the
    engine over the real Windows backend and a real store with the
    simulator's table posing as Winamax - the cash preset drawn, then the
    user's design assigned and `layout_changed`: the same overlay draws the
    design's cells, four to a row, every panel wider; posing as PokerStars
    with the same assignment, the card-split statistic is dropped and the
    rest drawn. Cross-checked locally with `cargo clippy --target
    x86_64-pc-windows-msvc -p rail-hud --all-targets -- -D warnings`
    (stand-in C compiler). The screen was checked in a browser over the
    app's own Rust commands behind a mocked Tauri bridge (a scratch HTTP
    bridge to a made-up store, not committed): drag and drop and the
    keyboard moves, the stack cell and a card-split statistic refused on
    PokerStars and Winamax and allowed on ACR, the preview per room (6- and
    4-column panels, the user's dragged panel), save, assign (refused on
    PokerStars, kept on ACR), delete; English and Croatian, dark and light,
    1280 and 900 px.
  - **Limits.** A user's own statistic is shown on the panel, not in the
    popup (the popup reads shipped definitions only). A stack cell knows
    the stack of the table's last finished hand only (nothing about the
    hand in play, by design). Switching by tendencies (another set for a
    loose player) is not offered (`Switching::ByTendencies` stays enforced
    for designs from elsewhere). The preview draws the simulator's table
    geometry (no room's real layout is measured: R3.14). Last writer wins by
    each computer's clock. The editor's drag and drop was driven with
    synthetic drag events in the browser check (a real mouse drag in the
    Tauri webview is not automated). No preset ships a design with more
    than two thresholds.
  - **For R3.10** (compliance mode in the app): `rail_hud::design::check_for_room`
    and the editor's room lines already say what each room forbids; R3.10's
    HUD status ("refused: <room>, why") can reuse `RoomDto.restrictions` and
    the problem words. The app checks designs against the **shipped**
    `sites.json`; when it downloads the remote one, check against the merged
    restrictions (`HudRestrictions::stricter`), as the HUD does. A user's
    statistic edited to read the cards while assigned to PokerStars is not
    refused by `custom_stat_save` (the renderer drops it; the screen marks
    the assignment): R3.10 may warn there too.
  - **For R3.11 - R3.13** (macOS): the design is in the frame
    (`OverlayFrame.design`); the macOS overlay lays out `frame.design` with
    `scene::compose_with` exactly as Windows does - no design state on the
    overlay. The preview is platform-free.

### R3.10 Compliance mode — S
- The HUD refuses to attach to windows of rooms whose `hud.allowed` is not
  `true` — unknown counts as no — and says why in the app. No override.
  The question is `rail_config::Site::hud_permitted()` (R0.12), asked of the
  merged configuration (`load_remote`).
- A10: analysis and solver screens are hidden while any table is open.
- *As built* (§15): **done** - the app keeps the room list current from the
  web (stricter only), one merged copy for the HUD, the popup and the editor;
  the HUD screen, Today and the tray say which tables have the HUD and which
  were refused and why; A10 reaches the sidebar and the command palette; a
  release cannot ship on a stale policy check. `core/rail-sync/src/policy.rs`
  (fetch, check, cache, keeper), `app/src-tauri/src/policy.rs` (the app's
  single source and its commands), `hud.rs` (status lists, tray line,
  `--policy`), `rail-hud-ipc` (`HealthReport` lists), `rail-hud`
  (`--policy`, refusals with table and reason), `app/src/lib/hudCompliance.ts`
  (pure wording), `screens/hud/HudStatusPanel.tsx`, `lib/duringPlay.ts`,
  `frontend/scripts/sites-json.mjs`, `tests/scripts/hud-policy/check.mjs`,
  `.github/workflows/release-checklist.yml`.
  - **Where the remote `sites.json` lives: the web origin, as a static
    file** (`<web>/sites.json`; production
    `https://poker-hand-converter.vercel.app/sites.json`). The web build
    copies `config/sites.json` byte for byte to `frontend/public/sites.json`
    (gitignored) before `next dev` / `next build`
    (`frontend/scripts/sites-json.mjs`, which also refuses a file that is not
    JSON version 1, failing the deploy rather than the apps), served with
    `Cache-Control: no-cache` (revalidated every time; Vercel's ETag) and
    `nosniff`. Chosen over a Supabase Storage object because the repository
    file stays the one source (no second copy to keep in step, no upload
    credentials), every change is a reviewed pull request that the schema
    test and the Rust validator check, and the web deploy is not an app
    release. **How the owner updates it**: edit `config/sites.json` (switch a
    room's `hud.allowed` off, add a restriction, refresh `checkedAt`), merge,
    and it is live with the web deploy - which is `main` (staging does not
    deploy): it reaches users with the staging -> main promotion.
  - **Fetch** (`rail_sync::policy::PolicyFetcher`): the URL from
    `RAIL_WEB_URL` (the sign-in's web origin; a debug build reads it at run
    time), HTTPS only - plain HTTP only to a loopback address (tests, `next
    dev`) -, the OS certificate verifier (rustls-platform-verifier, as for
    sign-in), **no redirects**, `If-None-Match` / `If-Modified-Since` from
    the cached copy (only when the cache's record's SHA-256 matches its
    text), 10 s to connect, 20 s in all, at most 1 MiB (checked on the
    declared length and again while reading). First look 5 s after start,
    then every 6 h, 30 min after a failure, and "Look for an update now".
  - **Checked whole, no signature**: `rail_config::load_remote` - the strict
    schema (`deny_unknown_fields`, `version` 1) and every validator rule - or
    nothing of the file is used; merged by R0.12 / R3.6's rule (HUD only
    switched off, restrictions only added, table graphics only grown,
    processes only narrowed, unknown ids ignored, identity changes ignored).
    No signature: the strongest thing a forged file could do through a
    broken TLS chain is switch a HUD *off*, which TLS plus the merge rule
    already bound; a signing key would be one more secret for no gain in
    safety (and the hand-edited cache is bound the same way).
  - **Cache** (`PolicyCache`): `<app local data>/policy/sites.json` (the
    last good text) and `sites.meta.json` (URL, ETag, Last-Modified,
    downloaded at, SHA-256), each written to a temporary file and renamed.
    Only a copy that passed is written. At start the app (`PolicyKeeper::
    open`) and the HUD (`rail-hud --policy <that file>`, read before its first
    look for tables, so a room the remote copy switched off is never attached
    for a moment) merge it over the shipped copy; a cached file that does not
    pass is left alone and not used. It never expires: a stricter copy stays
    until a newer one replaces it. **Failure** (offline, 5xx, a redirect, too
    large, refused) keeps the last good merged copy, or the shipped one.
  - **One source in the app** (`crate::policy`): `policy::config()` (the
    merged `Config`) for the popup's rules (`PopupRules::for_site`) and the
    editor's rooms (`hud_editor::rooms`), `policy::compliance()` (the HUD's
    own `Compliance` over the same remote text) for the editor's preview.
    A new copy is applied at once: `policy {remote}` to the HUD (which
    detaches what it no longer allows; it is also sent on every
    connection), an open popup of a room no longer allowed closes, and the
    window hears `hud-policy-changed`.
  - **The HUD's lists**: `HealthReport` gains `tables` (attached: window,
    room, table name, waiting), `refusedTables` (still-open refused windows
    with room, table name and reason) and `remotePolicy` (all `serde(default)`,
    so no protocol bump); the engine keeps each refusal's table and reason.
    The app keeps them (`attach_refused` added at once, then replaced by
    each health answer, cleared when the HUD goes) and `hud_status` gives
    them with the phase; `hud-status-changed` tells the window.
  - **UI** (en + hr): the HUD screen opens with **"At the tables"**: the
    HUD's state, the tables it is on ("waiting for the table's first hand"),
    the tables **without the HUD** - room and table, why in plain words
    (`prohibited`; **withdrawn** when the room was allowed in this build and
    an update switched it off; `unknown` = rules not established, unknown is
    no; `not-a-room` = a network; `unknown-site`), the room's policy page
    (opened in the browser by `hud_open_policy_source`, only an `https`
    `hud.source` of the merged list) and the date it was read -, "There is no
    switch to turn the HUD on here, by design", the **"Why can't I enable the
    HUD here?"** explanation (open when a table was refused), where the HUD
    may be used (allowed rooms with page and date; the others folded), where
    the list came from ("this version's own" or "updated from the web on
    ..."), the last look and what an update tried to loosen. **Today** has a
    line ("HUD: on 2 tables · 1 table without it (GGPoker: not allowed)" ->
    HUD details). **Tray**: a fourth disabled line ("HUD off", "HUD
    starting…", "HUD: 2 tables · 1 not allowed"), looked at every 2 s and on
    each change, relabelled with the language. **No override** anywhere (a
    test holds the window's commands to the three read-only policy ones).
  - **A10 complete**: `duringPlay.ts` `screenOffered` / `offeredScreens`;
    the sidebar and the command palette leave out a screen classified as
    help while a table is open, and its Cmd/Ctrl + digit does nothing (the
    others keep their numbers). No screen is classified today (R5.4's
    analysis will be).
  - **Release checklist** (§12): `npm run hud:policy-check` in `tests/`
    (`scripts/hud-policy/check.mjs`, plain Node) lists every room with
    `hud.allowed = true`, its policy page and `checkedAt`, and exits 1 when a
    date is older than 90 days (`--max-age-days`), missing, in the future, or
    the source is not `https` (or the entry is not a room);
    `.github/workflows/release-checklist.yml` runs it by hand (and as a
    `workflow_call` for the release workflow), the table in the job summary.
    Not in CI: it depends on today's date.
  - **Tests**: rail-sync `policy::tests` against a local HTTP server - a
    stricter copy applies, is cached and is in force after a restart before
    any fetch; a looser one is taken for the rest with the room kept and a
    note; not JSON / an unknown field / version 2 / a validator rule broken
    are each refused whole with the last good copy and the cache untouched;
    503, too large, a redirect and nothing listening keep the last good
    copy; a failure before any copy is the shipped policy; ETag and
    Last-Modified sent, `304` current, a mismatched record not sent; a
    damaged cache unused; HTTPS-or-loopback only. rail-config (notes read as
    lines). rail-hud-ipc (the lists round-trip; an older HUD's health answer
    reads). rail-hud: compliance `--policy` file (missing, stricter,
    broken), engine (lists in health, a refusal's table and reason, cleared
    when the window closes, a stricter policy listing the detached table),
    arguments. App (`cargo test -p rail-app`, mock runtime): the policy DTO
    over a cached remote copy (withdrawn room flagged, looser note), without
    a keeper the signed list, only listed `https` pages open; the status
    lists from `attach_refused` / health / disconnect and the tray line;
    strings. `tests/`: `appHudCompliance.test.ts` (wording, ordering, links,
    dates, no override), `appDuringPlay.test.ts` (sidebar and palette ask the
    gate), `hudPolicyCheck.test.ts`. **Windows CI**
    (`windows_compliance.rs`, real windows, the real supervisor): posing as
    GGPoker the table is `attach_refused` `prohibited` and listed in the
    health answer's `refusedTables` with its table name and reason - the
    list the app shows as it is - with no overlay window of the HUD's and
    `tables_open` never above 0; posing as PokerStars with `--policy` (a
    copy switching it off) refused from the first look, attached when the
    app's `policy` goes back to the shipped copy (an overlay appears), and
    detached again - overlay gone, listed - when the copy comes back.
    Cross-checked locally with `cargo clippy --target x86_64-pc-windows-msvc
    -p rail-hud --all-targets` (stand-in C compiler and archiver). The HUD
    screen and Today were checked in a browser with mocked Tauri calls and
    made-up tables (running with tables attached and refused, off; English
    and Croatian; the policy link and "Look for an update now").
  - **Limits.** The first download needs the web deploy that carries
    `/sites.json` (the staging -> main promotion); until then every look
    fails quietly and the shipped copy stays. A remote copy only applies to
    the HUD's policy and table data; the watcher's folders and the hands'
    sites still read the shipped copy (`folders::sites()`). A custom
    statistic edited to read the cards while assigned to PokerStars is still
    not warned about at save (the renderer drops it; R3.9's note). The
    workflow can only be dispatched once it is on `main`.

### R3.11 macOS: find tables — M
- Accessibility API per poker process (`kAXWindowsAttribute`, `AXTitle`) for
  titles — needs only the Accessibility permission; `CGWindowListCopyWindowInfo`
  for bounds and order (window *names* there would need Screen Recording, so
  they are not used).
- Onboarding screen that explains and requests the permission, and detects when
  it is granted.
- *As built* (§15): **done** - `hud/rail-hud/src/platform/macos.rs` (the
  backend and everything that decides, plain Rust, unit-tested on every
  system), `platform/macos/ffi.rs` (the system calls, macOS only), the
  permission through the engine and the IPC, `--list-windows` on macOS, the
  app's onboarding on the HUD screen, `docs/research/CAPTURING-TABLES.md`
  "On macOS". No real room has a `tables` block, so nothing real is found
  yet: everything runs against the table simulator's real windows.
  - **Enumeration** (`macos::snapshot` -> `macos::assemble` ->
    `platform::table_of`, the R3.3 path): (1) `CGWindowListCopyWindowInfo
    (OptionAll | ExcludeDesktopElements)` - every window, on screen or not,
    front to back: number (`CGWindowID` = `WindowId`), owner pid and name,
    bounds (points), layer, on screen; **window names never read** (Screen
    Recording since 10.15). Ordinary windows only (layer 0). (2) The process
    name is the executable's file name (`proc_pidpath`; the owner name as a
    fallback), compared like Windows' (`same_process`, no case). (3) Only for
    processes a room's matcher takes: `AXUIElementCreateApplication(pid)`
    (messaging timeout 0.25 s per request, so a busy client cannot stall the
    loop for the default 6 s) -> `AXWindows` -> per window `AXTitle`,
    `AXPosition` + `AXSize`, `AXMinimized`, `AXFullScreen`, `AXSubrole`, the
    `AXCloseButton`'s frame, and the window number from
    `_AXUIElementGetWindow` - a private function, **looked up with `dlsym`
    at run time, never linked** (the macOS window managers and switchers use
    it for this; if a release drops it, pairing falls back to frames).
    **Pairing** (`macos::pair`): by that number; else the first unpaired
    window of the process whose bounds equal the AX frame within one point,
    front to back on both sides (two tables stacked at one place pair in
    z-order). **Client area** = bounds less the title bar, whose height is
    twice the close button's centre below the window's top (`title_bar`):
    measured on the simulator's winit window, 32 pt on macOS 26 (28 pt up to
    macOS 15); 0 in full screen or without a close button. **States**:
    `AXMinimized` -> `minimized` (empty client rect, as Windows); off screen
    and not minimised (another Space, full screen in its own Space, the app
    hidden) -> `cloaked` (so `TableWindow.minimized`, hidden, still
    attached). The AX API lists only the current Space's windows (and
    minimised ones), so the backend **remembers** each title it read by
    window number (pruned when the window is gone): a table moved to
    another Space keeps its title; one never seen on this Space is not found
    until it is. An off-screen window with neither partner nor memory is
    left out (AppKit keeps such helper windows for every app: the
    simulator has five). Every match is returned, allowed or not (compliance
    decides in the engine).
  - **Points vs pixels.** macOS window APIs speak points in one global
    space (main display's top-left, y down). The trait's "physical pixels"
    are points x the backing scale of the window's screen (the display its
    bounds overlap most: `CGGetActiveDisplayList`, `CGDisplayBounds`, the
    display mode's `pixel_width / width`, 2000 on Retina; the main display's
    for a window on none), rounded half away from zero - exactly winit's
    physical position (the simulator's `window` events, asserted by the
    test). Scales on macOS are whole (1x, 2x, 3x), so R3.12 gets points back
    exactly as rect x 1000 / `scale_permille`. A window straddling displays
    of different scale is reported at the scale of the one it overlaps most,
    as AppKit's `NSWindow.screen`. `RawWindow.monitor_dpi` / `window_dpi`
    carry the scale as 96 x scale (so `dpi_permille` gives it back);
    `RawWindow.class` is the AX subrole. Floats exist only in `macos::milli`
    (points -> thousandths of a point, the one `allow(float_arithmetic)`);
    everything after is integer.
  - **Bindings**: objc2's generated crates at the 0.3.2 line Tauri (tao,
    wry) already locks - `objc2-core-foundation`, `objc2-core-graphics`
    (`CGWindow`, `CGDirectDisplay`), and `objc2-application-services`
    (`AXUIElement`, `AXValue`, `AXError`; the **one new crate** in
    `Cargo.lock`, same release) - plus `libc` (locked already) for
    `proc_pidpath` and `dlsym`; all `=`-pinned, macOS-only dependencies.
    `unsafe` only in `platform/macos/ffi.rs`, one function per call with its
    own `#[allow(unsafe_code)]` and a `// SAFETY:` comment per block, as in
    `windows.rs`; `macos.rs` itself has no `unsafe`.
  - **Permission** (`platform::Permission::Accessibility`): the trait gains
    `permission_needed()` (macOS: `AXIsProcessTrusted()`, read for every
    health answer - reading prompts nobody) and `request_permission()`
    (macOS: `AXIsProcessTrustedWithOptions({prompt: true})`, the system's own
    alert, which also lists the app in the pane switched off). Without it
    `find_tables` fails with `PlatformError::PermissionNeeded` (no title, no
    table), logged once; with no matcher at all nothing is asked of the
    system. **IPC** (no protocol bump: optional field, new message type an
    older HUD reads as `Unknown`): `HealthReport.permission_needed`
    (`"accessibility"`) and `HealthReport.permission_deferred`, and
    `AppMessage::RequestPermission { permission }`. **Asked for only when
    it would make a difference** (the orchestrator's change before merge:
    a sensitive permission that cannot find anything is not asked for):
    at each look with the permission missing the engine reads the running
    processes - no permission needed: the window server's list and
    `proc_pidpath`, `Platform::running_processes` - and
    `platform::permission_matters` says whether one belongs to a room whose
    HUD is allowed *and* that has a matcher here (a macOS `tables` block:
    none today), or the simulator's test entry is on. Then the health
    answer says `permission_needed`; otherwise `permission_deferred` (never
    both) and the app asks for nothing. A `request_permission` is passed to
    the system only in the first case, then the engine looks for tables at
    once. **Behaviour change**: a Mac user with no supported client running
    - every Mac user today - sees no card, only a neutral "HUD on macOS: no
    supported poker client running" (HUD screen, Today, tray). **Never
    unattended**: the only sender is the app's
    `hud_request_permission`, the HUD screen's button. TCC attributes the
    sidecar to its **responsible process** - Rail.app, which starts it - so
    the grant is Rail's (in development, the terminal that ran `tauri dev`;
    for `--list-windows`, the terminal). The entry is keyed by the code
    signature: an ad-hoc signed build (CI's `.dmg`, a local build) is a new
    identity with every build and must be granted again (the screen says to
    remove and re-add Rail when it keeps asking); a **Developer ID** signed
    release (P3) keeps the grant across updates. Screen Recording: never
    needed (the diagnostic prints its state only to say so).
  - **The app** (`hud.rs`): `HudStatusDto.permissionNeeded` from the health
    answer (a change emits `hud-status-changed`), the tray line "HUD: needs
    the Accessibility permission", `hud_request_permission` (macOS
    `accessibility` only: sends the request and opens
    `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
    with `open`). **The HUD screen** (`HudStatusPanel`): while the running
    HUD needs it, a card - why (window titles and places only), what not (no
    screen recording, no input monitoring, no control of other apps), the
    steps, "Open System Settings"; then "waiting" and the stale-entry hint;
    the status poll (3 s) sees the grant and the card becomes "granted".
    Today's HUD line says so too. `HudStatusDto.permissionDeferred`: the
    screen, Today and the tray say "HUD on macOS: no supported poker client
    running" and offer nothing (`lib/hudCompliance.ts`
    `noSupportedClient`). `en` + `hr` (macOS's Croatian names:
    Pristupačnost, Privatnost i sigurnost, Postavke sustava). Checked in a
    browser with mocked Tauri calls (the card, the click, the grant).
  - **`--list-windows` on macOS**: the same arguments and redaction; the
    AX subrole as `subrole`, the client area in px and pt with the screen's
    scale, `off screen (another Space, or the app hidden)`; notes say
    whether Accessibility is granted (if not: how, and no title is shown)
    and that Screen Recording is not used. `--process` takes the
    executable's name.
  - **Tests**: unit (`platform::macos`: points <-> pixels and rounding,
    display scale and the screen of a straddling window, title bars -
    standard, toolbar, fractional, full screen, borderless, clamped -,
    pairing by number / frame / z-order / tolerance, the joined view with
    minimised, other-Space (remembered) and closed windows, tables through a
    matcher; `list` macOS listing; `platform::permission_matters` (no
    allowed matcher, a browser only, a prohibited room, the test entry);
    `engine` a missing permission *deferred* without a supported client
    (not offered, a request ignored) and *needed* with the simulator's
    entry (asked for only on request and only while missing, attaching once
    granted); protocol wire forms; the app's status, events and tray lines;
    `tests/` the helpers - the card hidden without a supported client, shown
    with the simulator's entry - and that the prompt is only the button's).
    **`tests/macos_tables.rs`** (`cfg(target_os = "macos")`, the `core`
    job's `cargo test` on `macos-latest` plus a step with its output): the
    simulator's three windows (640 x 480 pt) **always** checked through the
    window server alone - exactly three ordinary on-screen windows of its
    pid, bounds x scale equal to its own frames - and joined by
    `macos::assemble` with accessibility windows made from the simulator's
    events (titles for identity) into three tables with the hands' names
    and client rects equal to the simulator's. Then by what the test
    process may do: **with Accessibility**, the backend's own find (exact
    x / width / bottom, the measured title bar within a point), a catch-all
    pattern still three, another process's matcher none, a minimised table
    found and marked, a table move retitling the same window,
    `--list-windows` (three, redacted, "granted"), `rail-hud --standalone
    --sim-site pokerstars` attaching to three and `ggpoker` refusing three;
    **without it**, `find_tables` -> `PermissionNeeded`; the engine's
    health says `permission_deferred` without the test entry (the simulator
    runs, but no allowed room has a macOS matcher) and `permission_needed`
    with it; the simulator is among `running_processes()` (read without a
    permission);
    `--list-windows` says "NOT granted" and lists no title, the HUD process
    logs why it finds nothing - and the test prints the `R3.11:` line naming
    what it skipped. It never prompts and never changes a setting.
    **Locally** (the development Mac, macOS 26.6, from an agent's shell
    whose responsible app has no Accessibility): the window-server path and
    the permission path pass (title bar 32 pt, scale 1x on that display);
    the full AX path was **not run** here, and no setting was changed - the
    owner runs it after granting the terminal Accessibility: `cargo test -p
    rail-hud --test macos_tables -- --nocapture`. **CI**: whether the
    runner's test process has Accessibility is the macOS job's `R3.11:`
    line (the hosted images pre-grant some of their own processes; the
    first run says whether ours is one).
  - **Limits.** No real client's title, process name or title bar is known
    (`tables.process.macos` null everywhere). The title bar is measured from
    the close button: a client that draws its own title bar or uses a full
    size content view gets the whole window or a wrong offset (R3.14's
    check). A window on another Space never seen on this one is not found.
    The AX calls run on the HUD's loop thread every find (each process
    0.25 s at worst); R3.13's observers make most of them unnecessary.
    Not tested on a Retina display with the full AX path, nor with two
    displays of different scale (unit tests only).
  - **For R3.12** (overlay): `WindowId` is the `CGWindowID`; position the
    `NSPanel` in **points**: `client / scale_permille x 1000` (exact), then
    flip to AppKit's bottom-left origin against the *main* screen's height
    (`NSScreen.screens[0].frame.height`), as winit does. Order it above the
    table with `orderWindow(.above, relativeTo: windowNumber)` - the
    `CGWindowID` is that number. `TableWindow.minimized` covers minimised,
    other Space and hidden app: hide the panel. Do not give it
    `canJoinAllSpaces` (it would show on every Space): a panel shown while
    its table is on screen belongs to that Space; hide it whenever the table
    is reported off screen, and show it again where the table is. The panel
    lives in this
    process, which is unbundled (`rail-hud` inside Rail.app) - an
    `NSApplication` with the `.accessory` activation policy so it never
    shows in the Dock or takes focus. AppKit wants the main thread: the
    engine's loop must move into the AppKit run loop (a timer or a run-loop
    source in place of `recv_timeout`). Drag (R3.6): feed `platform::drag`
    the panel's mouse events in client pixels (points x scale).
  - **For R3.13** (tracking): an `AXObserver` per poker process
    (`kAXMovedNotification`, `kAXResizedNotification`,
    `kAXWindowMiniaturizedNotification` / `...Deminiaturized`,
    `kAXUIElementDestroyedNotification`, `kAXTitleChangedNotification`,
    `kAXWindowCreatedNotification` for `Appeared`) on the run loop of the
    AppKit thread; turn them into `platform::tracking::Observed` and let
    `tracking::events` / `plan` do the rest, placing overlays from the
    window as it is now (read with the same `ffi` calls) so the 500 ms
    re-find cannot fight them. Space changes have no AX notification:
    `NSWorkspace.activeSpaceDidChangeNotification` or the window server's
    `onscreen` on the re-find. The `memory` of titles stays the source for
    tables on another Space. A revoked permission makes `find_tables` fail:
    then detach rather than keep stale tables (today the engine keeps them
    until the next successful find).

### R3.12 macOS: overlay — L
- Borderless, transparent, non-activating `NSPanel` per table; ordered directly
  above the table window (`orderWindow(.above, relativeTo:)`); collection
  behaviour for Spaces and full screen; Retina scale; click-through outside
  panels. Through `objc2` bindings.
- *As built* (§15): **done** - `hud/rail-hud/src/platform/macos.rs` (the
  backend, and everything that decides as plain Rust, unit-tested on every
  system), `platform/macos/appkit.rs` (the AppKit thread, its windows, the
  painter, the panels' mouse; macOS only), `platform/macos/drive.rs` (test
  drivers), `lib.rs` (the process's two threads), the simulator's `clicked`
  event, `tests/macos_overlay.rs`. Still no real room has a `tables` block:
  every test draws on the simulator's real windows posing as an allowed room.
  - **Two threads, as on Windows** (`macos::with_appkit`). AppKit's windows
    and events belong to the main thread, and R3.6's rule - no store work
    on the AppKit path - plus R3.11's accessibility calls (0.25 s per poker
    process at worst) say the engine must not run there: so on macOS (the
    system's backend, not `--platform sim`) `main_with` gives the **main
    thread to AppKit** and runs the engine - unchanged, `Hud::run` with its
    channel and 50 ms tick - on a thread of its own (`rail-hud-engine`),
    rather than moving the loop into the run loop as R3.11 suggested. The
    main thread becomes an **accessory application**
    (`NSApplicationActivationPolicy::Accessory`: no Dock icon, no menu bar,
    never active, never the keyboard), finishes launching and **pumps
    AppKit's queue itself** (`nextEventMatchingMask:untilDate:inMode:dequeue:`
    in an autorelease pool), handing its panels' mouse events to the drag
    code before anything is dispatched - the Windows overlay thread's pump.
    The backend (on the engine thread) hands it commands over a channel
    (`macos::Link`: `Send`, `Clone`); when the channel goes from empty to
    not, a block on the **main dispatch queue** (`dispatch2`, drained by the
    run loop while it waits) posts an application-defined event, so a frame
    is taken at once, not at a tick. Queries (`overlay_info`,
    `overlay_pixel`, `render_times_us`, `window_at`, `inject_mouse`) answer
    after every command sent before them. When the engine returns (or
    panics) the AppKit thread closes every overlay and the process exits
    with the engine's code. Windows and Linux run exactly as before (one
    thread; `lib.rs` only split `main_with` into the argument part and
    `run`).
  - **The windows.** One `NSPanel` per table: **borderless,
    non-activating** (`Borderless | NonactivatingPanel`), not opaque, clear
    background, no shadow, `hidesOnDeactivate` off, `becomesKeyOnlyIfNeeded`,
    not movable, not floating (the normal level, the tables' own), no
    animation, never key or main (a borderless panel cannot become either).
    It covers the table's client area exactly: the engine's rect in
    physical pixels back in points (`macos::rect_points`: `client / scale x
    1000`, rounded half away from zero - exact for the whole scales macOS
    has), **flipped against the main display's height**
    (`macos::to_appkit`, `ffi::main_height` read at each use) - whichever
    display the table is on. It is **ordered directly above its table**
    (`orderWindow:NSWindowAbove relativeTo:` the table's number - the
    `CGWindowID` the engine's window id is; checked in the window server's
    order, it does land directly above another process's window) each time
    it is shown or moved. A cross-process window cannot own ours, so the
    order is **kept by looking**, every 100 ms while overlays show: per
    overlay one cheap question (`NSWindow.windowNumberAtPoint:
    belowWindowWithWindowNumber:` at the table's centre below the overlay
    must be the table, and the overlay on the active Space; ~20 µs), and
    only when one fails the active Space's whole order
    (`NSWindow.windowNumbersWithOptions(AllApplications)`, front to back,
    2 - 6 ms with twelve tables' ~150 windows) for `macos::stacking` to say
    `Restack` (the table was raised over it, a window got between - ordered
    above the table again, `restacked` counted), `Fine` or `Away` (the
    table is not on this Space; the engine hides the overlay). **Spaces and
    full screen**: collection behaviour `MoveToActiveSpace | Transient |
    IgnoresCycle | FullScreenAuxiliary` - **not** `CanJoinAllSpaces`: an
    overlay ordered in while its table is on the active Space joins that
    Space (a full-screen table's too, as an auxiliary window), stays out of
    Mission Control and the window cycle, and is **ordered out** whenever the
    engine reports its table off screen (`TableWindow.minimized`: minimised,
    another Space, the app hidden - R3.11) and in again over the table
    when it is back (`tracking::plan`, R3.5's, shared).
  - **Clicks through, except on the panels - no permission.** The overlay
    window **ignores the mouse** (`ignoresMouseEvents = YES`): every press on
    it goes to what is below, the table. Over each of the scene's panels
    (`Scene::panels`: the seats' panels and the legend - what takes clicks
    on Windows) sits a **click window**: a borderless non-activating panel
    of the panel's size that takes the mouse (`ignoresMouseEvents = NO`,
    background alpha 1/255 - invisible over the panel's near-black), ordered
    directly above the overlay, moved and shown with it, re-laid on every
    paint (a pool per overlay). A press there is routed by the window server
    to this process (a non-activating panel does not activate the app),
    and a drag's moves and release follow to the window the press went to,
    wherever the pointer goes - what Windows needs `SetCapture` for. No
    global monitor, no event tap, no Input Monitoring, no Accessibility. Not
    the window's own alpha as on Windows: measured with the window server's
    own hit test (`windowNumberAtPoint`), a layer-backed window that does not
    ignore the mouse takes presses on its fully transparent pixels too; and
    toggling `ignoresMouseEvents` by the pointer's position would need the
    position all the time (a poll that races the press).
  - **Drawing: Core Graphics into a bitmap, the bitmap a layer's
    contents.** The same scene as Windows (`scene::compose_with`, the frame's
    own design under its permit's restrictions, the overlay's dragged
    positions on top) painted on the CPU into a premultiplied BGRA
    `CGBitmapContext` (device RGB: the same bytes as Windows' DIB) of the
    client area's **physical pixels**, flipped once so the scene's y-down
    coordinates are its own: rounded rectangles as `CGPath`s (the radius
    clamped to half the rectangle), text as **Core Text** lines (`CTLine`,
    the system UI font - bold where the scene says - at the scene's pixel
    size, the context's fill colour, centred, clipped to its cell; font
    smoothing off, which on a transparent surface leaves fringes); then
    `CGBitmapContextCreateImage` becomes the `contents` of the root layer of
    a **layer-hosting** view (`setLayer` before `setWantsLayer`: AppKit never
    draws into it), `contentsScale` the table's backing scale, inside a
    transaction with implicit animations off. Chosen over `drawRect:` in an
    `NSView` subclass: no Objective-C class of our own (`define_class!`),
    AppKit never asks for a redraw of its own, the bitmap is exactly the
    pixels the scene laid out (Retina text rendered at the real pixel size,
    not scaled), and a test reads a pixel back as on Windows; Core Text
    shapes and falls back across fonts as the rest of macOS does; all of it
    already in Cargo.lock (below). **Redraws only on change** (R3.4's rule,
    `tracking::plan`): an equal frame at the same size and scale is not
    painted, a move only moves the windows, an off-screen table orders them
    out. Memory: one bitmap per table, 4 bytes per client pixel (twelve
    640 x 480 pt tables at 1x: 14 MiB; at 2x four times that).
  - **Panels: clicks and drags (R3.6, R3.8)** through the shared
    `platform::drag::Drag`: the click window's events in client pixels
    (`macos::client_pixel`: the event's location in its window plus that
    window's frame, back through the flip and the scale; a move outside our
    windows during a drag reads `NSEvent.mouseLocation`), the same press /
    threshold / move / release and the same `PanelMoved` (kept on the
    overlay until `drags_seen`) and `PanelClicked` (the panel on the screen,
    R3.8's anchor) as Windows, handed to the engine through
    `tracking::Observed` and `tracking::events` in `poll_events`. No store
    work on the AppKit thread.
  - **Compliance**: as on Windows - the engine asks for the permit before
    every draw, the backend refuses a frame whose permit names another room
    than the window's and a window it does not track; a refused room never
    gets a frame, so never a window (the HUD process posing as GGPoker makes
    no window at all - tested).
  - **Bindings and `unsafe`.** objc2's `objc2-app-kit`, `objc2-foundation`,
    `objc2-quartz-core`, `objc2-core-text`, `objc2` and `dispatch2`, at the
    versions Tauri (tao, wry) already locks, `=`-pinned, macOS only: **no new
    crate in Cargo.lock** (seven new dependency edges); new features of the
    already-used `objc2-core-graphics` / `objc2-core-foundation`. `unsafe`
    only in `platform/macos/{appkit,ffi,drive}.rs`, one function at a time
    with `#[allow(unsafe_code)]` and a `// SAFETY:` per block: AppKit's,
    Foundation's and Core Text's constant strings, the bitmap context and
    its bytes, the rounded path, a `CGImage` as a layer's contents, the
    release-when-closed flag (the windows are kept with `Retained` and
    closed by us). Floats (`CGFloat`) only in small conversion functions.
  - **Tests.** All systems (`platform::macos`): `pixels_back_to_points`
    (1x / 2x / 3x exact, half points on Retina, negative coordinates of a
    display left of or above the main one, scale 0), `appkit_frames_flip_
    against_the_main_display` (Retina main display, a 1x display to its
    right and taller - below AppKit's y = 0 -, one above it, the flip its
    own inverse), `mouse_points_become_client_pixels` (corners, half a point
    on Retina, a drag past the edge), `stacking_over_the_table` (fine in any
    hit order, raised, a window between, between a click window and the
    overlay, a click window or the overlay missing, the table away); `lib`:
    AppKit only for macOS's own backend. **macOS** `tests/macos_overlay.rs`
    (its own `main`: AppKit wants the main thread, libtest's tests run on
    others; in the `core` job's `cargo test` on `macos-latest` and again as
    a step with its output): the simulator's three tables (6, 9, 2 seats,
    640 x 480 pt) made **without any permission** from the window server's
    list and the simulator's events, the backend's overlays over them - per
    table the overlay window is ours, at layer 0, on screen, **exactly at
    the client area in points** (the window server's bounds), ignores the
    mouse, one click window per panel taking it, **directly above the table
    with its click windows directly above it** in the window server's
    order (`macos::onscreen_order`); the layout's panels; the bitmap's
    panel margin is the panel colour premultiplied, the centre transparent,
    a light figure drawn; **the same pixels on screen** (the window server's
    image of this process's own overlay window - no Screen Recording for
    one's own windows); **a press at the table's centre would reach the
    table** and on an uncovered panel a click window (the window server's
    hit test); the same frame twice painted once; another room's frame and
    an untracked window refused; a click and a drag put on the process's
    own event queue are `PanelClicked` (slot, panel on the screen, scale)
    and `PanelMoved`, the click windows following the dropped panel; the
    simulator's `move` -> moved, **no repaint**; its `focus` (the table
    raised over its overlay) -> put back; `minimize` -> overlay and click
    windows ordered out (the table off screen too), `restore` -> above the
    table again, no repaint; removed -> its windows gone; the backend
    dropped -> no window of ours left. **With the Accessibility
    permission** (CI's runner has it, R3.11): real clicks posted to the
    window server (`drive::click`, `CGEventPost`) - on a panel the overlay
    takes it, at the table's centre the **simulator gets it** (its new
    `clicked` event); the HUD process (`rail-hud --standalone --sim-site
    pokerstars`) puts a window exactly over each table directly above it,
    posing as `ggpoker` **no window at all**; under the real supervisor
    with a store, a real click on a villain's panel is `open_popup` for him,
    the anchor around the click. Without it the test says what it skipped
    (the `R3.12:` lines). **Locally** (M2 Pro, macOS 26.6, one 1920 x 1080
    display at 1x; an agent shell without Accessibility): everything but the
    Accessibility part passes; the HUD process's overlays, real clicks and
    the popup run in CI only. Cross-checked with `cargo clippy --target
    x86_64-pc-windows-msvc` and `--target x86_64-unknown-linux-gnu -p
    rail-hud -p rail-hud-sim --all-targets -- -D warnings` (stand-in C
    compiler and archiver); the Windows tests are untouched and run in CI.
  - **Performance** (`cargo test -p rail-hud --test macos_overlay -- --perf`,
    debug build, the M2 Pro above at 1x; CI's step "HUD overlays on macOS,
    twelve tables (measurement)" prints the `R3.12 perf:` line): twelve
    simulator tables (9- and 6-max, 640 x 480 pt), each overlay painted 20
    times with new figures: **a paint (layout, Core Graphics, Core Text, the
    layer, the window) p50 0.9 ms, p95 1.2 - 2.5 ms, max 7 - 8 ms** (the
    first, which makes the fonts); 240 frames handed over and painted in
    1.4 - 1.7 s; the twelve overlays shown, idle 10 s: **40 ms of CPU, 0.40 %
    of one core** for the whole test process (the stacking look ten times a
    second; 1.1 - 1.6 % before the cheap look replaced reading the whole
    order each time). The HUD process attached to twelve tables needs
    Accessibility to find them: CI's line has it.
  - **Limits.** The overlay follows the **engine's** view of its table -
    the re-find every 500 ms - until R3.13's observers: a dragged table's
    panels catch up within half a second, and a table raised over its
    overlay hides the panels for up to 100 ms. Tested on 1x displays only
    (local and CI); Retina and two displays of different scale by the unit
    tests. The popup itself is not wired on macOS (R3.8: a Tauri window
    activates the app); `open_popup` does arrive. No real client.
    `CGWindowListCopyWindowInfo(OptionAll)` - R3.11's `cg_windows` - turned
    out **not to be in z-order** (the test's first stacking check read it);
    `macos::onscreen_order` (`OptionOnScreenOnly`) is.
  - **For R3.13** (tracking): run the `AXObserver`s on a thread of their
    own with a `CFRunLoop` (not AppKit's: a callback reading a busy client's
    frame can wait 0.25 s) and, from the callback, read the window's frame
    there and hand the AppKit thread the new geometry at once
    (`Link::follow` - the overlay moves before the engine hears of it, as
    on Windows), noting the rest in `tracking::Observed` for `poll_events`;
    the re-find stays the safety net. Watch `kAXFocusedWindowChanged` /
    `kAXMainWindowChanged` / `kAXApplicationActivated` per poker process and
    make them a restack now (a `Command` for it), then slow the 100 ms poll;
    `NSWorkspace.activeSpaceDidChangeNotification` (or the re-find's
    `onscreen`) for Spaces - today an overlay hidden for another Space is
    back within the 500 ms re-find of its table being on screen. Replace
    R3.11's front-to-back assumptions on the `OptionAll` list (`pair`'s
    frame fallback, `assemble`'s order) with `onscreen_order`.

### R3.13 macOS: tracking — M
- `AXObserver` for moved, resized, miniaturised, destroyed, title changed;
  `CGWindowList` polling as a fallback for clients with poor accessibility.
- *As built* (§15): **done** - `hud/rail-hud/src/platform/macos/observe.rs`
  (the observers' thread; macOS only), the platform-free half in
  `platform/macos.rs` (`AxNote` and its `Effect`, `tracked_geometry`,
  `title_bar_between`, `z_ordered`, `restack_every`, `TrackerInfo`) and
  `platform/tracking.rs` (`Observed::absorb`), the AppKit thread's side in
  `platform/macos/appkit.rs`, the revoked permission in `engine.rs`, the
  popup in `app/src-tauri/src/popup.rs`, `tests/macos_tracking.rs`. Still no
  real room has a macOS `tables` block: everything follows the simulator's
  windows.
  - **The observers' thread** (`rail-hud-ax`), started with the first
    tracked table, runs **its own `CFRunLoop`** (`CFRunLoopRunInMode` in a
    loop; a version-0 source signalled + `CFRunLoopWakeUp` wakes it for a
    command; due rechecks set its timeout) - not AppKit's: a callback that
    asks a busy client something waits up to R3.11's 0.25 s, and neither the
    overlays nor the engine's loop (store reads) may wait with it. **One
    `AXObserver` per poker process** with a tracked table, its run-loop
    source on that loop, made with the process's first table and let go
    with its last (`track` / `untrack`). On the **application** element:
    `AXWindowCreated` (-> `TableEvent::Appeared`: the engine looks for
    tables at once), `AXFocusedWindowChanged`, `AXMainWindowChanged`,
    `AXApplicationActivated`, `AXApplicationHidden`, `AXApplicationShown`. On
    each tracked **window**'s element: `AXWindowMoved`, `AXWindowResized`
    (what AppKit posts for a window: the first CI run registered only the
    generic `AXMoved` / `AXResized` the step's notes named, and no move
    came; both pairs are registered now),
    `AXWindowMiniaturized`, `AXWindowDeminiaturized`,
    `AXUIElementDestroyed`, `AXTitleChanged`. The window's element is the
    one of `AXWindows` whose `_AXUIElementGetWindow` is the table's number
    (else the one at its frame, never one another table took); a window on
    another Space is not in that list, so it is looked for again on the
    application's focus, window and activation notifications and on a
    Space change. The callback's `refcon` is the pid (a number); a
    notification is handled in the callback itself (or right after, if
    the thread's state is busy), panics never unwind into the system. What
    each notification does is data (`AxNote::effect`, unit-tested): which
    tables to read (the window / every table of the app), title, title bar,
    minimised, app hidden, gone, appeared, restack, look for elements, read
    again later (`RECHECKS`: 150 and 500 ms, for animations the window server
    shows after the notification).
  - **The overlay moves before the engine hears of it.** On a notification
    the thread reads the table from the **window server** -
    `CGWindowListCopyWindowInfo(OptionIncludingWindow, number)`: bounds and
    the on-screen flag, no message to the client, no permission (measured:
    that option alone does not list an off-screen window, so a minimised /
    other-Space / hidden one is looked up in the whole list) - plus the
    title bar from the Accessibility API on a resize (full screen in or
    out) and the title on `AXTitleChanged`. **After a move or a resize it
    reads again at 2, 5, 10, 20, 40 and 100 ms** (`SETTLE`): CI found the
    client posts the notification before the window server's list shows the
    new place - every move of the simulator's window read there unchanged,
    its overlay left behind until the next notification. Reading the
    window's own frame from the client instead (`AXPosition`) was tried
    and dropped: a client busy with the drag answered after the 0.25 s
    timeout (p95 0.5 s on CI), and a reading of the client ahead of the
    window server could be followed by an older one - the window server's
    list only moves forward. Computes the client area exactly
    as the find does (`tracked_geometry`: bounds less the title bar, pixels
    at the scale of the display it overlaps most; minimised = the empty
    rect; off screen or the app hidden = hidden, the rect kept) and hands
    the AppKit thread the geometry at once (`Link::follow_at`, carrying the
    notification's time for the follow measurement). The engine's side is
    noted in a `tracking::Observed` of the thread's own, coalesced per table
    (a drag's hundred moves are one `Moved`); the backend's `poll_events`
    merges it with the AppKit thread's clicks and drops
    (`Observed::absorb`) and runs R3.5's `tracking::events` - `Moved`,
    `Minimized`, `Retitled` through **the room's own matcher** (a tournament
    table move is a new table at once), `Closed`, `Appeared`. Debouncing is
    on the data side only.
  - **No fight with the re-find** (R3.5's rule, carried over). The engine's
    find every 500 ms stays - the fallback for a client with poor
    accessibility, and the source of titles for tables on other Spaces -
    but an overlay is **never placed from a description**: the AppKit thread
    keeps the latest geometry the observers read and makes and moves an
    overlay from that, never from the (possibly older) one in a frame; the
    backend's `follow` with something the observers did not report sends
    `Resync` (the find's title bar and view with it) and the thread reads
    the table again and puts the overlay where it is now. Minimised from a
    description counts only while the window server does not show the
    window, so an older description cannot hide a table that is back.
  - **Restack on activation and focus.** `AXApplicationActivated`,
    `AXFocusedWindowChanged`, `AXMainWindowChanged` and `AXApplicationShown`
    make the AppKit thread check every shown overlay's stacking now (R3.12's
    cheap look, the whole order only for a suspect) and once more 50 ms
    later. The periodic look (R3.12's 100 ms) **slows to 250 ms** when every
    shown overlay's client is observed (`restack_every`; the observers tell
    the AppKit thread per table, `Command::Watched`) and stays at 100 ms for
    one that is not. What only the look catches: a click on the already
    focused table that raises it over its overlay without changing focus -
    measured on CI (`R3.13 click`).
  - **Spaces and full screen.** No accessibility notification exists: the
    AppKit thread observes `NSWorkspace.activeSpaceDidChangeNotification`
    (a block on the workspace's notification centre; it counts and wakes the
    pump), and the pump calls the observers' `SpaceChanged`: every table
    read again now and at the rechecks - off screen orders its overlay out,
    on screen orders it in over the table (it joins that Space, R3.12's
    `MoveToActiveSpace`) - and the stacking checked. Entering or leaving
    full screen is a resize (`AXResized`: the title bar re-read, 0 in full
    screen) plus a Space change. **Not testable on a runner** (one Space,
    no public API to switch): the test posts the notification in-process
    (the wiring), the hide / show on a switch is a unit test.
  - **A client's exit**: a `kqueue` (`EVFILT_PROC` / `NOTE_EXIT`) per
    observed process, waited on by `rail-hud-exits` (an `EVFILT_USER` event
    stops it): its tables are gone at once - overlays removed, `Closed` -
    rather than at the next find. A window closed (`AXUIElementDestroyed`)
    is gone unless the window server still shows it (its element was
    replaced - a full-screen transition can): then its element is looked
    for again, and it is gone once it leaves the screen without one. The
    AppKit thread refuses frames for a table the observers saw close until
    the engine untracks it (no flash of a new overlay over a dead window).
  - **The z-order fix** (R3.12's finding). Every use of
    `CGWindowListCopyWindowInfo(OptionAll)` as if it were front to back is
    gone: the snapshot reads `onscreen_order` too (`Snapshot.order`) and
    `assemble` pairs a process's windows (the frame fallback) and orders its
    result by it (`z_ordered`: on-screen windows in z-order, then the
    off-screen ones in the list's order). A unit test shows the old pairing
    the wrong way round for two tables stacked at one place.
  - **Revoked Accessibility** (R3.11's note). Switched off while tables are
    attached, every accessibility call fails and the backend's find returns
    `PermissionNeeded`: the engine now **detaches every table** (overlays
    removed, `tables_open` 0) instead of keeping stale ones, and the health
    answer says `permission_needed` - R3.11's onboarding rule holds (a
    client was attached, so it would matter); nothing prompts. Granted
    again, the next look attaches. The observers' notifications simply stop
    (no permission, no notification); their processes are let go with the
    untracked tables. The system's own revocation cannot be made in a test
    (that would change TCC): the engine test simulates it with a backend
    whose find starts failing (`a_revoked_permission_detaches_every_table`).
  - **The popup on macOS** (R3.8's app-side logic, reused). `open_popup`
    already arrived (R3.12); the app's popup window is now placed in
    **points**: the anchor (points x the table's screen's scale, R3.11)
    divided by the table's scale, the work area of the screen it is on in
    that screen's points (tao reports each monitor at its own scale), the
    popup at its logical size beside the panel (`popup::placement`,
    `to_points`; `LogicalSize` / `LogicalPosition`) - a physical position
    would be read at the scale of whichever screen the popup window is on.
    Windows keeps R3.8's physical placement exactly. Not activating as far
    as macOS allows a Tauri window: shown unfocused
    (`makeKeyAndOrderFront` on an inactive app does not activate it; the
    poker client keeps the keyboard), always on top; a click into it
    activates Rail (the system's rule for a window that is not an
    `NSPanel`, which a Tauri window cannot be), and a click back on the
    table closes it. Limit: over a full-screen table it opens on the
    desktop's Space (no `FullScreenAuxiliary` without native code in the
    app) - R3.14.
  - **Bindings**: no new crate; `block2` 0.6.2 (already locked) as a direct
    dependency for the Space notification's block, new features of the
    locked objc2 crates (`CFRunLoop`, `CFDate`, `NSWorkspace`,
    `NSNotification`, `NSOperation`, objc2-app-kit's `libc` for the test's
    `NSRunningApplication`); Cargo.lock gains two dependency edges.
    `unsafe` only in `platform/macos/{observe,appkit,ffi,drive}.rs`, one
    function at a time with a `// SAFETY:` per block (the observer's
    creation, registration and callback; the run loop's source and the
    `Waker` that is `Send` because only `CFRunLoopSourceSignal` /
    `CFRunLoopWakeUp` reach it from other threads; `kqueue` / `kevent`;
    `clock_gettime` for thread CPU; the notification centre). No setting is
    changed; nothing prompts.
  - **Tests.** All systems: `macos::tests` - `what_a_notification_does`
    (fourteen distinct names, each one's effect), `a_table_read_by_the_
    observers` (the same client rect as the find at 2x and 1x, minimised
    empty, other Space / hidden app hidden with the rect kept, full screen
    without a title bar, the title bar recovered), `a_space_change_hides_
    and_shows`, `z_order_is_the_onscreen_order`, `the_stacking_look_slows_
    when_observed`; `tracking::tests::two_observers_merge`; `engine::tests::
    a_revoked_permission_detaches_every_table`; the app's
    `on_macos_the_popup_is_placed_in_points`. **macOS**
    `tests/macos_tracking.rs` (own `main`; in the `core` job's `cargo test`
    and again as the step "HUD tracking on macOS (steps and measurement)"):
    **without any permission** - two simulator tables, the backend's
    overlays and observers' thread; a wrong description never places an
    overlay (the thread re-reads, the engine is told the truth); a table
    moved by the simulator then described is followed; a simulated Space
    change re-reads every table; the simulator killed -> both overlays gone
    and `Closed` without a find (kqueue). **With Accessibility** - the
    backend's own find; one observer for the simulator (its application
    notifications), the window notifications on each table's element; a move
    this process makes through `AXPosition` (recorded: whether its own
    observer follows it - the HUD never moves a table); a drag of 40 moves
    made by the simulator itself (`move`: its window moved by its own
    process, as a client's is under a user's drag), each followed by the
    observers alone (lag from the window server showing the table there to
    the overlay's window-server bounds equal to its client area; command ->
    overlay; inside, notification -> overlay moved), no repaint, one
    `Moved`; `resize` repainted at 800
    x 560 px; `minimize` ordered out + `Minimized`, `restore` back above the
    table; `focus` restacked at once; a real click on the focused table
    (restacks and samples printed); `tablemove` -> `Retitled` with the new
    table's name; the application hidden and shown (`NSRunningApplication`)
    -> every overlay out and back; **100 moves in 1 s** (lag, the observers'
    and AppKit threads' CPU, never back at an older place, never hidden, one
    `Moved`, no repaint); `close` -> `Closed`, overlay gone; then the HUD
    process with `scripts/tracking.txt` (every `window` event: the HUD's
    overlay over the table's client area directly above it, gone while
    minimised and once closed; the table move logged). Every skipped part
    is printed (`R3.13:` lines). R3.11's and R3.12's macOS tests pass
    unchanged (the latter's minimise found the `OptionIncludingWindow`
    limit). Cross-checked with `cargo clippy --target x86_64-pc-windows-msvc`
    and `--target x86_64-unknown-linux-gnu -p rail-hud -p rail-hud-sim
    --all-targets -- -D warnings` (stand-in C compiler); the Windows tests
    are untouched (the engine's change is on a find that fails with
    `PermissionNeeded`, which Windows never returns).
  - **Measured.** Locally (M2 Pro, macOS 26.6, 1x display, debug, an agent
    shell **without** Accessibility, nothing changed): the permission-free
    part - the simulator killed -> its overlays gone in 23 - 33 ms, no find.
    CI (`macos-latest`, which has Accessibility): the job runs the test twice (in `cargo test` and as its own step); PR
    #213's run 39314405037 (`macos-latest`, debug, 1x display), the two
    runs: a table moved by the simulator itself (40-move drag) -> its
    overlay over it (from the window server showing the table there)
    **p50 17 ms, p95 51 / 68 ms**, max 0.52 s; the `move` command ->
    overlay p50 40 / 50 ms (the simulator's own handling included);
    inside, notification -> overlay moved p50 29 / 34 ms; no repaint, one
    `Moved`. A move this process made through `AXPosition` was followed in
    18 - 21 ms (its own observer is notified too). Resize -> repainted at
    800 x 560 px 49 / 81 ms after the command; minimise -> ordered out
    0.64 / 0.73 s (`AXWindowMiniaturized` comes after the animation),
    restore -> back above the table 0.61 / 0.64 s; `focus` -> the raised
    table's overlay put back 81 / 589 ms after the command; **a real click
    on the focused table does raise it over its overlay** (restacked once,
    not directly above it for ~20 ms - the 250 ms look and the activation
    restack catch it); table move -> `Retitled` 70 / 88 ms; the application
    hidden (the runner refused `NSRunningApplication.hide`; the test sets
    `AXHidden`) -> every overlay out 65 / 589 ms, shown -> back 30 / 174
    ms; 100 moves (then still waited for one by one): table moved ->
    overlay p50 16 / 18 ms, p95 49 / 85 ms, max 0.52 / 0.58 s, the
    observers' thread 144 / 197 ms and the AppKit thread 180 / 265 ms of
    CPU, never back at an older place, never hidden, one `Moved`; close ->
    `Closed` and the overlay gone 0.22 s; the simulator killed -> overlays
    gone 13 / 38 ms. **The tail is the runner's window server**: the
    observers' slowest single reading of one window took 0.51 - 0.52 s
    (the median move is one frame). Earlier runs on this PR found what the
    design now does differently: `AXMoved` alone never came for a window
    (`AXWindowMoved` does), the window server's list lags the notification
    (settling reads), reading the client's own frame waits on a busy client
    (dropped), unregistering a quitting client's elements waited out the
    timeout (0.5 s exit; dropped), and polling the window server every
    0.2 ms from the test stalled it (2 ms now). The last commit also stops
    re-ordering an overlay and its click windows on a plain move and stops
    settling reads once the window server shows the move, and the storm
    now sends its 100 moves 10 ms apart without waiting (as a drag does);
    its CI line (`R3.13 storm`) is the record for that. **CI gates
    correctness, not the tail**: the overlay over the table's last place,
    never at an older one, never hidden, one `Moved`, no repaint, the
    observers' + AppKit CPU under 0.5 s for the storm, and the typical lag
    (p50 under two frames) are asserted everywhere; the storm's p95 is
    printed on CI (the same code measured 85 ms and 0.52 s on two runs -
    the virtual window server's stalls) and gated at three frames only with
    `RAIL_HUD_REAL_HW=1` (R3.14, the owner's Mac)
  - **Limits.** No real client (no macOS `tables` block). A client that
    does not post these notifications (poor accessibility) is followed by
    the 500 ms re-find, as before. A click on the already focused table that
    raises it over its overlay (it does, on CI) is put back within ~20 ms
    there - by the restack on its focus notifications or the 250 ms look. A window on
    another Space whose element is replaced is treated as closed (the next
    find attaches it again). Spaces: simulated only. Retina and two
    displays: unit tests only (both runners and this Mac are 1x).
  - **For R3.14** (twelve tables, real clients): run `RAIL_HUD_REAL_HW=1
    cargo test -p rail-hud --test macos_tracking -- --nocapture` on the
    owner's Mac (a terminal with Accessibility) - the storm's p95 is gated
    at three frames there; measure the observers'
    CPU with twelve real tables and the restack look's cost; confirm each
    allowed room's client posts `AXWindowMoved` / `AXWindowResized` /
    `AXTitleChanged` for its tables (else the re-find carries it) and does
    not replace its windows' elements; whether a click on a real table
    raises it over its overlay (it does for the simulator - CI's
    `R3.13 click`); the popup over a full-screen table; a real Space
    switch and a Retina / two-display drag; consider slowing the engine's
    re-find on macOS when every table's client is observed (its AX calls
    are most of the HUD's idle cost).

**macOS HUD status (after R3.13).** On the simulator, in CI: tables are
found by process and title through the Accessibility API with the window
server's places (R3.11; the one permission, asked for only when a supported
client runs), drawn over by a transparent non-activating panel per table
exactly over its client area, directly above it, clicks through but on the
panels, each room's restrictions enforced, no window at all for a
prohibited room (R3.12), and followed by accessibility observers - drags
move by move, resizes, minimise and restore, the application hidden and
shown, focus and activation restacking, tournament table moves, closes and
the client's exit - without fighting the periodic re-find, a revoked
permission detaching every table, the popup placed in points (R3.13).
Twelve tables cost a paint p50 under 1 ms and idle overlays 0.4 % of a core
(R3.12). **What needs the owner**: the real clients' processes and titles on
macOS (`rail-hud --list-windows` from a terminal with Accessibility,
`docs/research/CAPTURING-TABLES.md` "On macOS"), which become `sites.json`
macOS `tables` blocks - until then the HUD attaches to no real client on
macOS and asks no Mac user for anything; a Developer ID signature (P3) so
the Accessibility grant survives updates. **What needs a real-client check**
(R3.14, on each allowed room, play money where it exists): the title bar
and client area of each client (a custom title bar would offset the
panels), its accessibility notifications, the overlay over its real seats,
a real Space switch and full screen (and the popup there), a Retina and a
two-display setup, and CPU with twelve real tables.

### R3.14 Twelve tables — M
- Simulator with 12 tables on each system; CPU, memory and latency budgets
  recorded in CI and on real hardware; then a real-client check on each
  allowed room (P5, P6).
- *As built* (§15): **done on the simulator**; the real-client half is the
  owner's, with a written procedure. `hud/rail-hud/tests/twelve_tables.rs`
  (its own `main`), small changes to the HUD process for measuring, the
  macOS engine's slower search, and
  [`docs/research/REAL-CLIENT-CHECK.md`](research/REAL-CLIENT-CHECK.md).
  - **The scenario.** The test plays the app, as `e2e.rs` does: a fresh
    store, the watcher on both simulators' folders, the statistics pass,
    and the real supervisor starting the real `rail-hud`. The HUD runs
    with **this system's backend** (Windows: find, overlays, hooks; macOS:
    Accessibility find, AppKit overlays, observers). Two simulators:
    **12 PokerStars-titled tables** (6- and 9-max) posing as `pokerstars`,
    and **one ACR-titled table** posing as `ggpoker` (prohibited). Each is
    a test-only room entry, and `rail-hud` now takes one `--sim-site` /
    `--sim-title` pair per room. The two title regexes are disjoint;
    a test-only entry takes the simulator's process only. Five phases:
    1. **Attach**: the simulators are paused until all 12 tables are
       attached, the thirteenth refused and 12 overlays are on screen.
    2. **Play** for `--seconds` at `--speed` (6 hands per minute per
       table). A quarter of the way in, a recompute is queued: it must
       stay paused while tables are open, as the app's `tables_open`
       handling does.
    3. **Follow**: every table is moved out and back while hands go on
       (24 moves). On Windows the test calls `SetWindowPos`, as a user's
       drag does; on macOS the simulator moves its own window. The lag is
       from the table at its new place to the overlay over it, polled.
    4. **Idle**: the simulators are paused; the HUD's CPU is measured with
       12 tables showing numbers, then the overlays are counted again.
    5. **Shutdown**: the HUD writes its new `--perf-report`.

    Without `--run` the test only prints how to run it, so the
    workspace's `cargo test` does not pay for it.
  - **What it measures.**
    - Every hand's chain, from the bytes written (the simulator's `atMs`)
      through the watcher's notice, the import, `hand_imported`, its
      arrival and the re-read to the frame (the HUD's `--latency-report`),
      stage by stage.
    - The overlays' paints and follows inside the HUD: `--perf-report`, at
      shutdown, from the backend's own timings, through the new
      `Platform::paint_times_us` / `follow_times_us` (`latency::summarize`).
    - The follow seen from outside, as above.
    - The HUD's and the app's CPU: Windows `GetProcessTimes`; macOS `ps`,
      10 ms resolution.
    - The HUD's memory: Windows working set and its peak, through the new
      `probe::memory`, `K32GetProcessMemoryInfo`, the `windows` feature
      `Win32_System_ProcessStatus` (no new crate); macOS `ps` RSS,
      sampled every 5 s.
    - The overlays on screen: Windows, visible `RailHudOverlay` windows
      owned by each table; macOS, the HUD's windows over each table's
      client area.
    - The refusal (`attach_refused`, `prohibited`), the hands shown, and
      the statistics pass's state.
  - **Gates** (`Report::gate` / `exact`). The report is written **before**
    any gate is checked: JSON + markdown,
    `twelve-tables-<os>-<profile>-<time>`, in `--report-dir` (default
    `target/twelve-tables`). It holds only simulator data: no host name,
    user name or path.

    | Check | Limit | Gated |
    | --- | --- | --- |
    | Tables attached; overlays on screen (at attach and at the end) | exactly 12 | everywhere |
    | Overlays on the refused table; its hands shown | 0 | everywhere |
    | Refused as `prohibited` | exactly once | everywhere |
    | Allowed hands written during play and not shown | 0 | everywhere |
    | Moves not followed | 0 | everywhere |
    | Recompute progress while tables are open; the pass `PausedTables` | 0; yes | everywhere |
    | Hand written -> frame, p95 / max | 1 s (§3.3) / 5 s | everywhere |
    | Overlay paint, p95 | 16.7 ms | everywhere |
    | Table moved -> overlay over it, p50 | 2 frames (33 ms) | everywhere (R3.13's rule) |
    | Table moved -> overlay over it, p95 | 3 frames (50 ms) | Windows and real hardware; recorded on a CI Mac (virtual window server, R3.13) |
    | HUD CPU, 12 tables idle / playing | 5 % / 15 % of one core x runner factor | everywhere |
    | App CPU while 12 tables play | 20 % of one core x runner factor | everywhere |
    | HUD memory (RSS max sampled; Windows peak working set) | 256 MiB | everywhere |

    **Runner-relative CPU**: a fixed workload is timed on the machine
    (xorshift fill + sort, the fastest of five; `-- --calibrate` prints
    it). Its ratio to the M2 Pro reference for the build profile (debug
    240 ms, release 7.5 ms, measured on the owner's Mac under the flop
    library's load) scales the CPU budgets. The factor never goes below
    1: a faster machine is not held to more. `--real-hw` (or
    `RAIL_HUD_REAL_HW=1`) marks a real machine; it also gates the follow
    p95.
  - **Without the Accessibility permission** (macOS) the HUD can read no
    title. The test then runs the data path with the simulator's event
    stream as the windows (`--platform sim`, headless simulators, so a
    Mac in use gets no windows) and reports `INCOMPLETE`, listing what it
    skipped. It never prompts and changes no setting.
  - **CI**: in the `core` job on `macos-latest` and `windows-latest`, the
    step "HUD on twelve tables (R3.14 budget)" runs `-- --run --seconds 60
    --idle-seconds 10` in debug. The report is uploaded as the artefact
    `twelve-tables-<os>` (kept 30 days), even when the step fails. The
    macOS runner has Accessibility (R3.11 - R3.13), so it runs in full
    mode. The first numbers are this PR's run artefacts; copy them here
    once read.
  - **Measured locally** on the owner's M2 Pro, macOS 26.6.2, one
    1920 x 1080 display at 1x. The agent's shell has no Accessibility, so
    the run was data-only and nothing was changed. The machine was busy:
    the flop library at 6 solves (nice 10), a VM and a browser; load
    average ~12 on 10 cores.
    - **Release, 30 s of play (36 hands, all shown)**: hand written ->
      frame **p50 513 ms, p95 517 ms, max 524 ms**. Of that, the
      watcher's quiet period is 497 ms (p50), the re-read 0.20 ms (p95
      0.88) and read -> frame 0.08 ms.
    - HUD CPU (simulator backend) **0.20 % idle, 0.29 % playing**; the app
      **0.69 %**; HUD RSS **14 MiB**.
    - The ACR table posing as GGPoker: 4 hands, none shown.
    - The recompute (13 hands) queued during play: 0 done,
      `PausedTables`.
    - Calibration 7.4 ms (factor 1.0).
    - Debug, 20 s: p95 524 ms, HUD 0.40 % / 0.49 %, app 1.54 %, 15 MiB.
    - The in-process overlay measurement in release (`macos_overlay --
      --perf`, no Accessibility needed): 240 paints of 12 tables **p50
      0.76 ms, p95 1.09 ms**, max 9.4 ms (the first paint, which loads the
      fonts); idle 0.30 % of one core.
    - **Skipped locally** (they need the terminal's Accessibility): the
      HUD process's overlays on screen and their paints, the follow, the
      refused table's overlay, and R3.13's real-hardware storm gate.
  - **Real-hardware kit**, one command, the same on both systems, in a
    checkout:

    ```text
    cargo test --release -p rail-hud --test twelve_tables -- --run --real-hw --seconds 300
    ```

    It builds the HUD and the simulator in release and runs about 6
    minutes: 13 windows open, move and close by themselves. It writes the
    report to `target/twelve-tables/`. On macOS the terminal needs
    Accessibility; there, also run `RAIL_HUD_REAL_HW=1 cargo test -p
    rail-hud --test macos_tracking -- --nocapture` (R3.13's storm, gated at
    three frames).
  - **Fix: the macOS search slows when the observers follow every table**
    (R3.13's note: the Accessibility calls of the 500 ms search are most
    of the HUD's idle cost).
    - New `Platform::notified`. The macOS backend answers from an atomic
      that the observers' thread publishes after every step: every tracked
      table's element is found, its move or resize, miniaturise,
      deminiaturise, destroyed and title notifications are registered, its
      application's `AXWindowCreated` too, **and its client has posted at
      least one move or resize for one of its tables**
      (`macos::fully_observed`, `shows_moves`). The last condition matters
      because a client with poor accessibility registers and then never
      posts.
    - While that holds, the engine looks every `find_every_notified` =
      **2 s** instead of 500 ms. It asks at every look, so a new table or
      an unobserved one brings the pace back. A hand that no window takes,
      and `AXWindowCreated` (`Appeared`), still look at once.
    - A revoked permission is now seen within 2 s. Windows is unchanged:
      its search is cheap.
    - The perf report shows `finds`, `findEveryMs` and `notified`. Tests:
      `macos::tests::a_table_is_fully_observed` and
      `engine::tests::the_look_slows_while_notifications_follow_every_table`.
  - **The R3.x notes for R3.14**, and where each went:
    - Twelve tables' CPU, memory and latency on the simulator: this step.
    - Slowing the macOS search: done (above).
    - The remaining notes go to the real-client procedure, which turns
      each into a check with pass/fail boxes:
      - seat layouts and ACR's graphics (C2, C4; measured by the capture,
        `CAPTURING-TABLES.md`);
      - preferred seat (C3);
      - whether each client posts the accessibility notifications, and
        whether a click raises the table over its overlay (C5);
      - the mid-hand write pause against the 500 ms quiet period (C10,
        R3.7);
      - the macOS title bar (C14);
      - the popup over a full-screen table (C7);
      - Retina, two displays and Spaces (C12, C13);
      - CPU with 12 real tables (C11);
      - the latency on a real client (C9: a debug build's line and a
        60 fps recording).
    - R2.9's one 1.6 s outlier in 15 hands at 12 tables did not recur in
      the local runs here (max 524 ms over 36 and 24 hands); CI's report
      has more.
  - **Limits.**
    - The simulator is not a client: every real-room number waits for the
      real-client check.
    - **No room has a `tables` block, so the HUD attaches to no real
      client yet.**
    - Sync is not run in the test (no server), so its bandwidth limit
      while tables are open (`SyncWorker::set_tables_open`) is not
      exercised here.
    - The app is played by the test process, not the Tauri app.
    - The macOS follow is measured from the window server's list, polled
      every 2 ms.
    - CPU on macOS is read through `ps`, at 10 ms resolution.
    - The runner factor is a compute workload, a rough proxy for a HUD
      that mostly waits on the system.

### Phase 3 summary (after R3.14)

R3.0 - R3.14 are on `staging`. On the table simulator, the HUD:

- finds tables, draws on them, follows them and lays out seats on Windows
  and macOS;
- carries the data path, the panel and popup, the editor and presets;
- enforces compliance in the HUD process and in the app.

| Step | Windows | macOS |
| --- | --- | --- |
| R3.0 HUD policy per room, signed | both: PokerStars, Winamax, ACR allowed; 15 rooms prohibited, 4 unknown | |
| R3.1 Table simulator | in CI with windows | in CI with windows |
| R3.2 HUD process, IPC, supervision | both: sidecar, socket / pipe, handshake, read-only store | |
| R3.3 / R3.11 Find tables | `EnumWindows`, process + title, physical pixels | window server + Accessibility titles, one permission |
| R3.4 / R3.12 Overlays | layered owned window, Direct2D | non-activating `NSPanel`, Core Graphics; click windows |
| R3.5 / R3.13 Tracking | WinEvent hooks | `AXObserver`s, Spaces, `kqueue` exits |
| R3.6 Seats and layouts, drag | both | |
| R3.7 Data path (segment, own hands, restart, latency chain) | both | |
| R3.8 Panel and popup (A10) | both; the popup in points on macOS | |
| R3.9 Editor and presets; R3.10 compliance in the app | both | |
| R3.14 12 tables within budget, in CI | gated | gated (follow p95 recorded) |

**Exit criterion**: "HUD on 12 simultaneous tables on Windows and macOS
within budget (§3.3), only on rooms whose `hud.allowed` is `true`."

- **On the simulator: met in CI on both systems** (PR #215's run, both
  reports PASS, debug builds, 12 tables posing as PokerStars + 1 as
  GGPoker, 60 s of play at 6 hands/min/table, 10 s idle):

  | Measured | `windows-latest` (4 cores) | `macos-latest` (M1 virtual, 3 cores) |
  | --- | ---: | ---: |
  | tables attached / overlays (start, end) / on the refused table | 12 / 12, 12 / 0 | 12 / 12, 12 / 0 |
  | hands written but not shown / refused table's hands shown | 0 / 0 | 0 / 0 |
  | hand written -> frame, p95 / max | 526 / 590 ms | 619 / 667 ms |
  | overlay paint, p95 | 5.9 ms | 6.1 ms |
  | table moved -> overlay over it, p50 / p95 | 0.5 / 0.5 ms | 31 / 78 ms (p95 recorded, not gated on a CI Mac) |
  | moves not followed | 0 | 0 |
  | recompute while tables open | paused, 0 progress | paused, 0 progress |
  | HUD CPU idle / playing (of one core) | 0.46 % / 1.11 % | 1.70 % / 4.26 % |
  | app CPU while playing | 1.79 % | 3.33 % |
  | HUD memory | 36 MiB | 70 MiB |

  The macOS follow p50 (31 ms) is close to its 2-frame gate (33 ms) on the
  virtual runner; the real-hardware run (`--real-hw`) is the measure that
  counts. Full numbers are in the run's `twelve-tables-*` artefacts.
- **On real clients: pending.** No room's `tables` block is filled, so
  the HUD attaches to no real client yet. The real-client check follows
  the capture.

**What the owner must do**, in order:

1. **P5**: a Windows machine (a PC, or Windows 11 on ARM in Parallels if
   the clients run there).
2. **P6**: accounts on PokerStars, Winamax and ACR, with play money where
   offered.
3. **Capture** each room's tables on Windows and macOS
   (`CAPTURING-TABLES.md`): processes, titles, seat layouts per size,
   ACR's graphics and preferred seat. They become the `tables` blocks;
   until then the HUD attaches to nothing real.
4. **Run the twelve-table kit** on both machines and send the reports.
5. **The real-client check** (`REAL-CLIENT-CHECK.md`) per room and system,
   C1 - C15, results and notes back.
6. **Signing**: P3 (Developer ID, so the macOS Accessibility grant
   survives updates) and P4 (Windows code signing) before any public
   build.
7. Re-check the HUD policies before each release (R3.0's checklist).
   GGPoker's SEP 7.2 note on importing hand histories still stands.

**Known limits after Phase 3.**

- Every real-room fact is unverified until the capture and the check. The
  simulator's titles and geometry are invented.
- A room that pauses mid-hand while writing would get a hand prefix
  stored (R3.7); the check finds this out (C10).
- The macOS popup over a full-screen table opens on the desktop's Space.
- Spaces are only simulated in CI; Retina and two displays are covered by
  unit tests only.
- The 250 ms latency aim is not met: the watcher's 500 ms quiet period
  sets the floor (R1.3).
- Sync's pause while tables are open is not part of the twelve-table run.

---

## Phase 4 — Web

**Goal.** One core and one look on both surfaces.

**Exit.** A hand uploaded on the web and the same hand imported by the app
produce identical `hands` rows and render identically.

### R4.1 WASM core on the web — M
- The conversion worker calls `rail-core-wasm`; `phf/types.ts` replaced by the
  generated declarations; TS parsers deleted once shadow mode (R0.13) has been
  green in production for an agreed period. Analysis, replay and Learn code keep
  consuming PHF JSON and do not change.
- The "zero server requests" check on `/convert` still passes.
- *As built* (§15; on `staging`, not yet in production):
  - **Every web caller that turns text into PHF uses the core**: the
    converter's pipeline (`components/converter/pipeline.ts`, in the worker
    and in the main-thread fallback), the single-hand box
    (`upload/SingleHandPanel.tsx`) and a share of a hand never saved
    (`share/shareClient.ts`). They ask `lib/wasm/engine.ts`'s
    `conversionEngine()` for an engine with one face - `split(text)` and
    `convert(text, options)` returning `convertAny`'s `ConversionResult` - so
    nothing downstream changed: hands are the core's PHF (`JSON.parse`d),
    refusals become `ConversionFailure`s (the core's sha-256 fingerprint,
    per-mille / 1000 as the confidence), stats as before. `parsedAt` is
    `new Date().toISOString()` per call. `lib/trainer.ts` and
    `lib/converter.ts` convert no user text (the trainer deals its own drills;
    `converter.ts` is only the legacy tests' facade) and are unchanged.
  - **Batches as before.** The pipeline needs the top parser's split to
    convert 100 hands at a time (progress, cancel); the core gained one
    export, `split(bytes) -> { decode, detected, name, chunks }`
    (`api::split`, plumbing over `SiteParser::split_hands`; no parsing
    behaviour changed), and an empty `filename` given to `convert` now means
    none (`null`), as `convertAny` records pasted text. Both have native
    tests.
  - **Text in, as the converter decoded it.** The web already decodes every
    file (`decodeSource`) to show its encoding and refuse binary; the engine
    hands the core that text as UTF-8, which it reads back unchanged. Text
    the core would read differently - a CR, a leading BOM, an empty file
    name, or what its decoder calls empty / whitespace / binary (possible
    for pasted text) - goes to the TypeScript engine, so the two never
    disagree about the input.
  - **Fallback**: the module is loaded once per page or worker
    (`lib/wasm/core.ts`: the glue's `init()` with
    `new URL("./rail-core/rail_core_wasm_bg.wasm", import.meta.url)`, then a
    `formats()` check); if fetching or instantiating fails, one
    `console.warn` and the TypeScript parsers convert, imported on demand
    (the worker's chunk is 5.6 KB on the WASM path; the parsers are a lazy
    chunk). The worker's `done` message and `onDone` say which engine ran.
  - **Types**: `lib/phf/types.ts` re-exports the 36 generated types of
    `core/rail-core-wasm/types/phf.d.ts` under their old names (type-only
    imports, erased by the bundlers) instead of a straight swap - 192 files
    import `phf/types`, and the module also holds behaviour (units,
    `parseAmount`, `assignPositions`, readers), which stays. The 30
    hand-written declarations are gone; `PhfBounty`, `PhfPot`, `PhfWinner`,
    `PhfMarkerLabels`, `CurrencyKind` and `ChipMovementAnchor` are new
    names. `phf:dts-check` now holds `types.ts` to re-exporting them. Web,
    `packages/ui` and the app typecheck unchanged.
  - **Deploy decision: the built web package is committed - CI's Linux
    build.** Vercel builds `frontend/` and has no Rust, so the four
    wasm-bindgen files and a `BUILD.json` (host, toolchain and wasm-bindgen
    pins, every file's sha-256; a function of the bytes, written by
    `tests/scripts/wasm/web.mjs`) live at `frontend/src/lib/wasm/rail-core/`
    (`.gitattributes`: `-text`, the `.wasm` `-diff`; ESLint ignores it).
    **Why only Linux**: the first CI run showed the `.wasm` depends on the
    host that links it. Sources, toolchain, Cargo.lock and wasm-bindgen are
    pinned and paths are remapped (the module had 78 absolute cargo-registry
    paths in panic locations; `wasm:build` now passes `--remap-path-prefix`
    for the cargo home and the repository in `CARGO_ENCODED_RUSTFLAGS`, and
    a macOS build from another path and cargo home is byte-identical), yet
    rust-lld on macOS aarch64 merges and orders the data segments
    differently from rust-lld on Linux x86_64 (the same strings packed
    another way, e.g. `IgnitionParserWePlayParser` against `IgnitionParser`;
    2 276 142 against 2 276 125 bytes); the JS glue and declarations are
    identical. So the canonical build is the `wasm` job's (ubuntu, x86_64).
    **The job**: build both targets; `web.mjs --stage` writes the package
    with its BUILD.json and it is uploaded as the artefact `rail-core-web`
    (every run, 14 days); `npm run wasm:web-check` then fails when the
    committed copy is not byte for byte this build - since the committed
    copy comes from an earlier run on another runner, a pass is also the
    proof that the Linux build is deterministic run to run; then shadow
    mode. **Elsewhere**: `npm run wasm:web` refuses to write over the
    committed copy off Linux x86_64 (a write is what could get committed,
    so that is the step to stop; a check that merely warned would leave a
    wrong copy on disk one `git add` away), and `wasm:web-check` there checks
    only that the copy is whole and matches its BUILD.json, saying why it
    cannot compare, and exits 0. **After a core change**: push, let the
    `wasm` job fail its check, run `npm run wasm:web-from-ci` (finds this
    branch's CI run at the checked-out commit, downloads `rail-core-web`
    with `gh`, installs it through `web.mjs --from`, which checks BUILD.json)
    and commit the directory; the failure message also prints the exact
    `gh run download <run> -n rail-core-web -D
    frontend/src/lib/wasm/rail-core` line. (A pull request's run builds the
    merge with `staging`; if `staging` changed the core meanwhile, merge it
    first.) Rejected: Rust + wasm-bindgen-cli in Vercel's build (minutes per
    deploy, an unpinned toolchain install on someone else's image) and a
    CI-published artefact the deploy downloads (a deploy that depends on a
    workflow run and a token). Cost: ~0.8 MB of git objects per core
    change.
  - **Serving**: the bundler emits the `.wasm` as
    `/_next/static/media/rail_core_wasm_bg.<hash>.wasm` - same origin,
    content-hashed, `Content-Type: application/wasm`, `Cache-Control:
    public, max-age=31536000, immutable` (checked on `next start`; Vercel
    serves `_next/static` the same). Size unchanged: 2.28 MB raw, 0.77 MB
    gzipped (budget 1.5 MB).
  - **Zero server requests**: still true. The browser check: on `/convert`
    (production build, no database) a pasted hand and a 6 000-hand file
    picked through the converter's file input made only same-origin requests - the
    app's JavaScript, the font, Next's route prefetches and the `.wasm`
    once. Automated now too: `tests/test/wasmWeb.test.ts` loads the core
    through the real loader with a recording `fetch` and asserts the only
    request is the `.wasm` beside its own module.
  - **Tests**: `tests/test/wasmWeb.test.ts` (in `npm test`, 32 tests, on the
    committed package): pipeline WASM = TypeScript (starts, batches, hands,
    failures, exactly) on one file of every sample directory and a
    multi-batch WePlay file; the worker through its message protocol, with
    the core and with the fallback; `convert` without a file name (single
    hand, share); the TypeScript route for CRLF / BOM / whitespace text; the
    loader's one request, and its fallback on a failed fetch and on a
    response that is not WebAssembly. `tests/scripts/wasm/web.test.ts` (in
    `npm run wasm:shadow`): **556 / 556** corpus files equal through the
    web's pipeline and a whole-file convert - 578 batches, 8 422 hands, 196
    failures.
  - **Speed** (M-series Mac): in the browser (Chromium, production build,
    the converter's worker) 6 000 PokerStars hands, 8.9 MB: **2.7 s, ~2 200
    hands/s**, first batch after 0.6 s (worker start, instantiation and the
    whole file's detection and split); three runs within 1 %. Node, the
    web's pipeline over the corpus, first pass: TypeScript ~1 730 hands/s,
    WASM ~1 440 - about the R0.13 gap (the regex engine), plus the second
    detection each batch costs on both. Not measured: the TypeScript worker
    in the same browser.
  - **Left**:
    - **Deleting the TypeScript parsers waits for the production period**:
      `staging` is not promoted, so shadow mode has not been green *in
      production* at all. After the owner promotes to `main`, agree the
      period; then delete `lib/parsers/` and `convertAny`, move
      `golden-fresh`'s oracle to the core (the goldens become the core's
      own), and drop the fallback. Until then the parsers are the fallback
      and the CI oracle, and a parser fix still lands in both.
    - Display names still come from the TypeScript registry (`getParser`
      in `ConverterTab`, `SingleHandPanel`, `HandList`), which keeps the
      parsers in the main bundle; R0.12's note stands - take them from
      `sites.json` (the pipeline's `siteName` is the core's now).
    - Standard text (download, save) is still `lib/phf/serialize.ts`;
      shadow mode proves the core's `serialize` equal, so it can move with
      the deletion.
    - Each conversion job starts a new worker, which instantiates the module
      again (compiled from the HTTP cache); keeping one worker would save
      that.

### R4.2 Bulk upload — M
- Drag-and-drop files, folders and ZIPs (exists) at desktop scale: streaming
  unzip, chunked saves, resumable. Original files to Storage only when the user
  opts in (A2); bucket policy by owner folder; pgTAP/Storage policy tests.
- *As built* (§15; on `staging`, not yet in production; migrations not
  applied to the hosted project):
  - **The worker reads the drop.** The converter used to decode every file
    and every zip entry on the page and post all the text to the worker in
    one message (the whole drop held twice; zips also capped at 100 MB and
    folders at 500 files). Now the page posts the `File` handles (no bytes
    copied) with a new `bulk` request, and the worker reads, unzips and
    decodes **one file at a time** (`converter/bulkSource.ts`, an async
    generator), converting each before reading the next
    (`pipeline.ts`'s `runSourceStream`; same batches of 100 as R4.1's
    `runPipeline`, which is unchanged and still serves the `convert`
    request). The main-thread fallback runs the same code
    (`converter/bulkRun.ts`). Folder drops keep their relative paths and now
    take up to 100 000 files; screenshots, OS debris and other obvious
    non-hand-histories in a folder or zip are left out silently and counted
    (`skipReason`). A single file or entry over 100 MB is refused, as before;
    an archive has no limit.
  - **Streaming unzip, no library** (`converter/zipStream.ts`, 1.4 KB
    minified and gzipped). The archive is read through `Blob.slice()` - on a `File` a
    window onto the disk: its last 64 KiB for the end record, the central
    directory, then each entry's compressed range, inflated by the browser's
    own `DecompressionStream("deflate-raw")` into one buffer of the declared
    size (an entry that inflates past it - a zip bomb, a lying directory - is
    stopped). The most the tab holds for an archive is its directory plus one
    entry. Zip64 is now supported (an export of more than 65 535 files);
    encrypted entries and methods other than stored / deflate are refused per
    entry; a zip inside a zip is followed one level. Rejected: fflate (~8 KB
    gzipped) and zip.js (~25 KB, own workers) - both ship an inflate in
    JavaScript that every supported browser already has natively. The
    single-hand box's `readZip` uses the same reader.
  - **Saving while converting** (`converter/bulkSaver.ts`). Signed in with
    "Save to my library" on, each batch goes into a bounded queue (1 500
    hands) and out in calls of at most 250 hands / 3 MB, one at a time. The
    worker may run 4 batches ahead; past that it waits for the page's `ack`,
    which the saver gives only while the queue has room - so a slow network
    slows the conversion and the tab's memory stays flat. Retries: a
    transient failure (no answer, timeout, 5xx, 408/429, `57014`) backs off
    exponentially with jitter (1 s .. 30 s, 6 attempts) and then **pauses**
    with everything queued ("Try again"); the account's 10-minute budget
    waits a minute at a time (15 times, then pauses); its daily budget or an
    ended session pauses; a call the server refuses outright counts its rows
    as refused and the upload goes on. Progress: files, bytes of the drop
    read, hands converted / saved / already in the library / refused, kept
    originals; a retry countdown or the pause's reason. Refused hands go to
    the failure corpus as before, now streamed and capped at 2 000 per upload.
  - **Where the hands go: `ingest_hands`, not `save_hands`.** Through
    `register_web_hand_source()` - the account's one `hand_sources` row of
    kind `web`, which R1.8 reserved for this step - and `ingest_hands`, which
    now accepts it besides the app's folders. Why: `save_hands` spends the
    web's **global** budget (25 000 rows / 10 min for every account
    together), so a 1M-hand upload would take seven hours and lock everyone
    else out; `ingest_hands` spends the account's own (150 000 / 10 min, the
    same `desktop_ingest` buckets: one budget per account). And a
    `save_hands` row is ~7.3 KB with the original text twice in it, an
    ingested one the PHF alone (A5, Q4) with its columns derived on the
    server - the same row the app writes (R4.4). Rows from the web source are
    **`origin = 'upload'`** (a new `hand_origin` value, in a migration of its
    own because Postgres will not use an enum value in the transaction that
    adds it): the desktop row's PHF-only shape, written from the browser; the
    text CHECK now names both, the insert policy still admits only `web` on
    the direct path, and `hand_arrivals` reports an upload as `web`. The
    single-hand box and the replayer still save through `save_hands`.
    **Dedupe** is the server's (`on conflict (owner_id, hand_key) do
    nothing`): the same file twice inserts nothing and the page says "already
    in your library".
  - **Resume, defined.** A web page cannot reopen files after a reload, so an
    upload stopped by a closed tab, a reload, a network gone longer than the
    retries or the daily budget **resumes when the user drops the same files
    or folder again**. An IndexedDB record per upload
    (`converter/uploadManifest.ts`, database `rail-uploads`: the dropped
    inputs' paths and sizes, counts, and per file or zip entry its key - path,
    size and mtime; for an entry the archive's key plus name, CRC-32 and size
    - the batches stored and whether it is done) is advanced after every
    acknowledged call; a file is done when all its batches are stored and, if
    kept, its original. A later drop that shares any input (path and size)
    with the newest unfinished upload continues it: done files and entries
    are skipped without being read (an entry without being inflated), and a
    half-stored file skips its stored batches (the split is deterministic).
    The page offers it when it opens ("An upload from … did not finish: 412
    files (…) saved. Drop the same files or folder again …", with "Forget
    it"); a paused upload of the same visit resumes the same way. The record
    holds no hand text and is deleted when the upload finishes. Correctness
    does not depend on it - the server dedupes - it saves the time, the
    bandwidth and the budget.
  - **Originals: opt-in only (A2).** A second switch next to "Save to my
    library", **"Also keep the original files"**, off by default and not
    remembered between visits, shown only when saving is possible. When on,
    every file that decoded is gzipped in the worker (`CompressionStream`)
    and stored at `hand-uploads/<uid>/<upload id>/<path>.<hash>.gz` (path
    sanitised, the hash of the file's key keeps names unique and makes a
    resumed upload hit the same object; "already exists" counts as stored;
    a refused original - e.g. over the limit - is counted and does not hold
    the hands up). The bucket (`20270609091000_web_bulk_upload.sql`) is
    private, 50 MiB an object, `application/gzip` only; `storage.objects`
    policies for `authenticated` allow select, insert and delete only where
    the first path segment is `auth.uid()`; no update policy; nothing for
    `anon`. Not signed in, or not saving: nothing leaves the tab, and the
    page's privacy line and the `/convert` comment stand (the comment now
    names the opt-in).
  - **What the tab keeps.** The first 20 000 hands and 2 000 refused hands
    of a drop, for the list, previews and downloads; past that only counts
    grow, the downloads are off for that drop ("Too many hands to keep in this
    tab …"), and the file list renders its first 200 rows. Results are kept
    in a map published to React every 200 ms, not re-mapped per message. A
    guest's drop over the cap cannot be held for after sign-in; the page says
    to sign in and drop it again. Closing the tab mid-upload asks first.
  - **Measured** (M2 Pro, Node 24, `npm run bulk-upload:measure`: a zip of
    corpus files built in a temp dir, read through a file-backed `Blob` and
    converted with the committed WASM core, batches dropped as counted):
    **1 000 023 hands** in a 138 MB zip (20 618 entries, 1.39 GB
    uncompressed): **545 s, ~1 830 hands/s**, first batch after 84 ms; peak
    heap 68 MB (+45 MB over the baseline), peak RSS +71 MB, ArrayBuffers no
    higher than before reading - flat for an archive ten times the heap
    (7 496 refusals, the corpus's own). At the account's ingest budget (250
    hands/s) saving, not converting, decides a desktop-sized upload: ~67
    minutes for a million hands. The browser was not timed at that size; the
    worker runs the same code.
  - **Tests**: `tests/test/bulkUploadInputs.test.ts` (16: nested folders,
    stored / deflate / zip64, refusals per entry, a zip bomb stopped, not a
    zip, non-hand-history entries skipped, keys stable, every byte counted
    once, **one entry at a time** - 40 entries of a ~2 MB archive, every
    read recorded: none reaches past the entry being yielded except the
    end-record scan and the directory, and no read is larger than one entry
    -, stored entries skipped unread, originals gzipped under a safe path, the
    pipeline's batch index and skipping stored batches);
    `tests/test/bulkUploadSave.test.ts` (20, a fake server and a fake
    Supabase client: bounded calls by count and bytes, no original text,
    re-upload all duplicates, the worker held back while the queue is full,
    backoff, pause and resume, budgets and lost session, refused calls and
    rows, re-registering a lost source, the corpus sample, the manifest
    after an interruption, a resumed run, originals under `<uid>/<upload>/`,
    a source done only after its original, "exists" and refused originals,
    error classification, the Storage call); `tests/test/bulkUploadWorker.test.ts`
    (3: the worker's `bulk` request batch for batch equal to the R4.1
    pipeline on the WASM core within its window, resume skipping, cancel
    while waiting for an ack); `supabase/tests/database/web_bulk_upload.test.sql`
    (37: the web source, upload rows, budgets, the text rule, the bucket and
    its policies - own folder allowed, another's and anon's refused).
    Local runs: the whole pgTAP suite on a fresh database with every
    migration (`supabase db start` with CLI 2.75.0 as in CI: 34 files, 1 119
    tests, pass) and the generated types identical to the committed file;
    `npm test`; frontend lint, typecheck, stylelint, build. **End to end**
    against a local stack (GoTrue, PostgREST, Storage; never the hosted
    project): two test accounts, the real saver and Storage client - rows
    `upload`, PHF only, a repeat all duplicates, the original stored then
    "exists"; another account's download, list, upload into and delete of
    the folder refused, `text/plain` refused by the bucket, `anon` refused.
    This found one bug the fakes could not: storage-js sends a `Blob` with
    the Blob's own type, so an untyped gzip arrived as
    `application/octet-stream` and the bucket refused it (fixed: the gzip is
    typed, and `storeOriginal` re-types it). In the browser (Chromium,
    production build, no database): a zip with nested folders and a PNG
    dropped on `/convert` converted in the worker, the PNG left out, and
    every request same-origin. With a local stack: signed in, "Also keep the
    original files" on, the drop saved (`upload` rows, two gzip objects under
    the uid); a manifest left unfinished showed the resume notice after a
    reload, and dropping the zip again converted only the file not yet
    stored.
  - **Left / for the owner**:
    - **Converter saves are PHF-only now.** A drop saved from `/convert` no
      longer stores `source_text` / `meta.rawText` / `standard_text` (the
      standard text is derived on read, as for desktop rows; 220 corpus hands,
      almost all GG, render with small presentational differences). Re-
      converting after a parser fix then needs the kept original (opt-in) or
      the user's file. Switching back is one line (`save_hands` instead of
      `ingest_hands`) but brings back the global budget.
    - The web's uploads share the account's `desktop_ingest` budget with the
      app (by design: one ingest budget per account); the bucket names stay.
    - Account deletion (not built yet) must also remove `hand-uploads/<uid>/`:
      Storage objects do not cascade from `auth.users`. No UI lists or deletes
      kept originals yet (the policies allow it).
    - The bucket's 50 MiB matches the hosted project's current upload limit;
      a larger single file (> ~500 MB of text) would need resumable (TUS)
      uploads.
    - R4.3 (live progress) can now read the saver's progress; the upload
      already signals `hand_arrivals` once per call.

### R4.3 Live progress and arrival — S
- Progress of a large upload and hands synced from the desktop appear live
  (Realtime).
- *As built* (§15; on `staging`, not yet in production; the migration not
  applied to the hosted project):
  - **Arrival was R1.10's; R4.3 widens it.** `hand_arrivals` (one change per
    save call, debounced 1.5 s / max 5 s backing off to 30 s, nothing while
    hidden, resync on reconnect) already refreshed `/library` and `/stats`.
    Now: **the analysis screens** (overview, reports, progress, leaks, plan)
    subscribe too, as `AppFrame live="notify"`: their re-read is a visible
    reload, so the screen is left alone and the shell offers "N new hands
    arrived - refresh" (bumps `refreshToken`; a resync alone offers nothing).
    **`/library` stops moving rows under a reader**: its first page updates
    in place only while the window is scrolled less than 160 px, otherwise
    the batch becomes "N new hands - show" (now inside a polite live
    region). Token refresh needed no code: supabase-js 2.116 gives Realtime a
    token callback, re-read on every heartbeat and pushed on
    `TOKEN_REFRESHED`; the new channel also calls `setAuth()` (the callback)
    before its join and again after a refused or failed one.
    `ArrivalBatch` gained `desktopHands`.
  - **Progress elsewhere: Presence on a private channel per account.** The
    tab running an R4.2 upload publishes `{v, kind: "upload", id, state,
    sent, inserted, duplicates, received, total, estimated, at}` - the
    manifest's random id, the saver's state and counts, ~200 bytes; no hand,
    no file name - as its presence on `activity:<uid>`
    (`components/live/activityChannel.ts`: one channel per tab and account,
    shared and reference-counted, presence key random per page load, what
    the tab tracks re-tracked on every `SUBSCRIBED`; `useUploadPresence` in
    `ConverterTab`). `lib/live/activity.ts`'s publisher sends a new state at
    once, counts at most every 2 s, a heartbeat every 15 s while nothing
    moves, and keeps "done" up 20 s before withdrawing; its board (the
    viewer) shows the newest entry per upload, never its own tab's, drops an
    entry whose tab left (unless finished: 20 s) or that has not changed for
    45 s on the viewer's own clock. The total: a file's hands are known when
    it is split, so the estimate is the opened files' hands scaled by the
    bytes not opened yet ("~"), exact when conversion ends (first browser
    run, which scaled by bytes *read*, showed "~800" growing with the save -
    a file's bytes count only once it is finished - and was changed).
    **Why Presence**: no database write per batch (Presence lives in
    Realtime's memory; a progress row would be an UPDATE, a WAL decode and an
    RLS check per subscriber for each of a 1M-hand upload's ~4 000 calls, the
    cost `hand_arrivals` exists to avoid); stale progress expires with the
    socket (measured ~0.6 s after a close; a killed process ~1 s); a tab
    opened mid-upload gets the state on join. Broadcast would need a TTL for
    everything and shows nothing until the next message; a table needs a
    janitor. 4 000 calls at R4.2's rate cost ≤ ~2 000 presence messages
    (unit-tested).
  - **The desktop app syncing** (it does not announce a sync; Rust
    untouched): "Desktop app syncing: 12 500 hands so far" from the arrivals
    of desktop origin, gone after two quiet minutes (`noteDesktopBatch`). On
    `/library` the R1.10 line naming the device stays instead.
  - **UI** (`components/live/LiveStrip.tsx`, in `AppFrame` on every live
    screen, signed in only): one line per upload elsewhere with a bar when
    the total is known, the desktop line, the notify button; strings in
    `chrome.live` (`en`, `hr`); wraps at 375 px. The counts are not a live
    region (they tick every 2 s); a visually hidden `role="status"` region
    announces only beginnings and ends (an upload started elsewhere,
    finished with its counts, the desktop app syncing, new hands to show).
  - **Authorisation** (`20270616090000_live_activity.sql`, the first
    `realtime.messages` policies; RLS on that table had no policy, so every
    private join was refused): `to authenticated`, topic
    `activity:<auth.uid()>` and the row's topic equal to it; receive
    presence + broadcast, send presence only. **Broadcast must be in the
    receive policy**: with presence alone Realtime 2.73 refused the owner's
    own join ("You do not have permissions to read from this Channel
    topic"); with no broadcast send policy nothing can be broadcast there (a
    control run with one delivered a probe). Not admitted: another account
    (either way), `anon`, other topics, a topic that only starts with the
    uid. A **public** channel named `activity:<A>` is a different channel
    (nothing crosses either way). The bell's and the arrivals' channels are
    public, guarded by table RLS, unaffected. Nothing to configure on the
    hosted project; Realtime's "allow public access" must stay on for those
    two.
  - **The converter's privacy promise** gains one line (page comment,
    `docs/WEB.md`): while a signed-in save runs, its counts go to the
    account's own private channel. A guest, or a drop with saving off, still
    makes no request.
  - **Tests**: `tests/test/liveActivity.test.ts` (27: the payload read
    defensively, the estimate, the mapping; the publisher's throttle,
    immediate state changes, heartbeat, done-then-withdraw, dispose, a
    million-hand upload's message count; the board's own-tab exclusion,
    45 s staleness on its own clock, leave vs finished, newest entry wins,
    junk skipped; the desktop line; the channel with a fake client: token
    before join, private config with the tab key, one shared channel and
    the last release removes it, per-account channels, empty state while
    down and a token refresh after a failed join, re-track after a
    reconnect, a viewer's release never untracks the uploader, released
    before the join opens nothing); `liveArrivals.test.ts` (12, updated for
    `desktopHands`). pgTAP `live_activity.test.sql` (27). **End to end**,
    `npm run realtime:activity` (`tests/scripts/realtime-activity/check.mjs`,
    local stacks only): 16 / 16 on an isolated stack (`rail-r43`, ports
    5642x, CLI 2.75 / Realtime 2.73.2) - A's other device sees the upload at
    once (194-byte entry), its update, and its leave 0.56 s after the tab
    closes; B, anon and A-on-B refused; public same-name channels kept
    apart; no broadcast delivered. `npm run realtime:arrivals` 15 / 15 on
    the same stack. Whole pgTAP suite on it: 35 files, 1 146 tests, pass.
    **Browser** (`next dev` against that stack, signed in as a test user):
    `/stats` showed a simulated device's upload ("Saving 240,000 of
    ~1,000,000 …", bar), then "finished", gone 20 s later; a killed
    uploader's entry gone within ~1 s; on `/analysis/reports` three desktop
    batches made one "Desktop app syncing: 1,500 hands so far" and one
    "1,500 new hands arrived - refresh", which reloaded the tab; `/library`
    scrolled down showed "500 new hands - show" with rows unmoved, at the
    top re-read in place (2,500). A real 20 000-hand drop on `/convert` in
    one tab showed in a second tab as "Saving 0 of ~20,000" climbing every
    2 s to "Web učitavanje gotovo: 20.000 novih ruku spremljeno" (Croatian,
    375 px wide), with the hidden status region announcing start and end.
  - **Left / for the owner**:
    - Apply `20270616090000_live_activity.sql` (after R4.2's migrations) -
      until then private joins are refused, the strip shows no uploads and
      the uploader's track fails silently; arrivals work regardless. Check
      as two users on the hosted Realtime (newer than 2.73) that the join
      still needs the broadcast read and nothing more (`npm run
      realtime:activity` refuses non-local URLs; the same steps by hand).
    - The desktop app could publish its own sync progress on the same
      channel (presence from Rust, with the session's JWT) for a real
      "N of M" and an end; today the web infers it from arrivals.
    - A resumed upload's estimate counts the bytes of files skipped as
      already stored (the "~" covers it; the counts are exact).

### R4.4 Parity test — S
- Automated: the same corpus file through the app path and the web path gives
  byte-identical `phf` and `hand_stats` rows.
- *As built* (§15; on `staging`; nothing to apply to production):
  - **Phase 4's exit holds for the whole corpus on a local stack**: 556
    files, 7 496 distinct hands - every `hands` column, every `hand_stats`
    and `hand_stats_ev` row byte for byte, and what the web renders from each,
    equal between a hand the app synced and the same hand uploaded on the web.
    **No difference was found between the paths, so nothing was fixed**; two
    findings outside parity (F1, F2 below) are the owner's.
  - **The test**: `npm run parity` in `tests/`
    (`tests/scripts/parity/parity.test.ts`, its own vitest config; needs a
    local stack, `frontend/node_modules` and cargo), two fresh accounts on
    the stack - one each, because one account would dedupe the second path
    into nothing. Users are created with the stack's service key and signed
    in with a magic-link token redeemed at `/verify` (no password, no
    captcha, no request leaves the machine); deleted at the end
    (`RAIL_PARITY_KEEP=1` keeps them). It refuses a non-local URL.
    - **App path** (A): `core/rail-sync/examples/parity_app.rs` - the
      files copied into a folder, a fresh `rail-store`, the `rail-watch`
      watcher on it as the app adds a folder ("Import everything",
      subfolders; the incremental reader, native `rail-core`), the sync
      worker with the real `Account` (the session's refresh token, as the
      keychain holds it) and `IngestClient`, woken by every import:
      `ingest_hands` from the folder's `hand_sources` row, `origin =
      'desktop'`. Done when every file is read to its end and the outbox is
      empty. Only the upload cap is lifted (it paces bytes, never content).
    - **Web path** (B): the converter's bulk run (`startBulkRun`, the code
      the conversion worker runs) over the same files as one multi-file drop,
      with the committed WASM package (asserted: engine `wasm`), its messages
      structured-cloned into `createBulkSaver` over `createUploadApi` and a
      supabase-js client signed in as B, wired as `ConverterTab` wires them
      (window 4): `ingest_hands` from the account's web source, `origin =
      'upload'`.
    - **Statistics: how each origin gets `hand_stats`.** Neither path writes
      them itself. The app sends the PHF only (R1.8 built Q4's "per-seat
      stats" as derivation on the server: the app's own `rail-stats` rows,
      equal to the TypeScript's by R2.1's oracle, stay local); the upload
      stores the PHF and the converter then starts `rebuildStats()`. Both
      get their rows from `/api/stats/rebuild` (`hands_needing_stats` ->
      TypeScript `handStatsRows` / `handEvRow` -> `save_hand_stats` /
      `save_hand_ev`), so there is no gap in *what* is written. The test runs
      the route's own handler as each user (its one server dependency,
      `getWritableServerSupabase`, handed the user's client), with villain
      rows on so every seat is compared. A gap in *when*, noted and not
      changed: an upload's statistics are written right after the save, a
      synced hand's when the account next opens `/stats`, which starts the
      rebuild itself when coverage is missing - and `/stats` (with its
      opponents panel) is the only reader of `hand_stats`, so nothing shows
      the difference.
  - **Compared** (`psql` as `postgres`; each row turned into the jsonb it
    is compared as once, whole rows first, a differing pair then column by
    column; `::text` equality, so byte for byte):
    - `hands`: every column but `id` (the row's own uuid), `owner_id` (two
      accounts by design), `origin` (`desktop` against `upload` is what it
      records - checked per side, with `standard_text` and `source_text`
      null on both) and `created_at` (the insert's time). There is no source
      column on `hands` (R1.8 keeps `hand_sources` to counters). `phf` whole,
      with only `meta.parsedAt` masked: the moment of conversion, stamped by
      each path (`time::iso_now`, `new Date().toISOString()`); its form is
      checked on both sides (ISO instant, milliseconds, `Z`).
    - `hand_stats` and `hand_stats_ev`: every column but `hand_id` (the
      hand's row id), `owner_id` and `created_at`, keyed by (hand key,
      version, seat).
    - **Hands the corpus holds in more than one file** (869 keys): each path
      stores the copy it reads first, and the watcher's order (parallel
      import threads) is not the drop's; some copies are not the same text
      (`ipoker:IPN-5383708755` is in `13-fixed-limit-holdem.xml` and, with
      the hero's name masked, in `02-hero-nickname-masked-preflop.xml`).
      Where the two stored rows come from different files (3-15 keys a run),
      the app's PHF is compared byte for byte with the web's conversion of
      the *same* file instead, and the pair is left out of the row,
      statistics and rendering comparisons (`split` in the report).
  - **Rendered** (deterministic data, no screenshots), every hand as each
    user through the web's readers: `get_hand` -> `toHandRecord` (the record
    but `id` / `createdAt`), its standard text (`storedStandardText`: both
    rows have none and derive it from the PHF) exactly, and the replayer's
    frames - from `parseHand(standardText)` as `ReplayerTab` builds them, and
    from the PHF as the analysis views and the shared `DataSource` do.
  - **A difference fails readably**: the repository file(s), the hand key
    (with version and seat for statistics), the column, the first differing
    character with 40 either side, and for `phf` the first differing JSON
    path. The last step proves the comparison sees: inside a rolled-back
    transaction it changes a hand's `meta.parserVersion`, a `hand_stats`
    player name and an EV value and deletes one `hand_stats` row, and checks
    exactly those three columns and one missing row are reported.
  - **Results** (whole corpus, M2 Pro, CLI 2.75 stack `rail-r44-parity`,
    four runs): app 7 496 hands stored (172 refusals quarantined, the
    corpus's own), 0 rejected by the server; web 8 422 converted, 7 496
    inserted, 926 duplicates, 0 refused; `hands` 7 496 = 7 496 with 0
    differences; 7 481-7 493 rendered identically (all but the split keys,
    each of which matched its file's web conversion); 43 923 `hand_stats`
    and 7 249 `hand_stats_ev` rows, 0 differences (both rebuilds processed
    7 255 hands, 0 failed). `RAIL_PARITY_CORPUS=sample` (the first two files
    of every corpus folder - 56 files, every room and format, 454 hands)
    and a list of paths are there for quick runs.
  - **Time**: the test 3.2-3.4 min locally - app 30 s (of it ~30 s is the
    reader's give-up wait for a refused trailing chunk, R1.3), web 15 s,
    `hands` comparison 11 s, rendering 12 s, both rebuilds 82 s, statistics
    comparison 13 s, the control 23 s; the sample 45 s. **CI**: job `parity`
    ("Web/app parity") runs the whole corpus: `supabase start` with db,
    auth, PostgREST and Kong only (CLI 2.75; `supabase/.temp` removed in the
    job, because its pinned GoTrue refuses the stack's HS256 service key on
    the admin API), a release build of the example, then `npm run parity`.
  - **Findings for the owner** (not parity; neither changed in R4.4 itself;
    **both fixed on `staging` by #235**, see below):
    - **F1, the statistics rebuild stops for good on an Ignition tournament
      hand.** Ignition's tournament seat numbers run past 24 (25-1 227 in
      the corpus: 15 hands in 5 MTT files), and `hand_stats_seat_ok` allows
      0-24. `save_hand_stats` refuses the whole page, the route answers 500,
      and every later run fails on the same page: no hand after it (by id)
      ever gets statistics. Same on both paths, and on `main` today (the
      TypeScript parsers give the same seats). The test takes those hands
      out of both accounts before the rebuild and lists them. A fix is one
      migration (widen the CHECK, e.g. to `smallint`'s range; `rail-store`
      has no such limit) - or skip / refuse such a hand in the route
      instead of failing the page.
    - **F2, statistics spend one budget for every account.** `hand_stats`
      and `hand_stats_ev` inserts charge the global `hand_stats_insert`
      (200 000 rows / 10 min, everyone together). A synced or uploaded
      library is desktop-sized: 1M hands is ~2M rows (hero + EV; ~7M with
      villain rows), ~100 minutes of the whole site's budget, during which
      no other account's statistics can be written - R4.2's `hands_insert`
      problem again. A per-account bucket, as `desktop_ingest`, would fix
      it. (The test resets the bucket on its local stack before the
      rebuild; a whole-corpus run writes ~88 000 rows.)
    - ***Fixed* (#235, `20270623093000_stats_seats_and_budget.sql`; not
      applied to production).** **F1**: PHF has no seat bound (a `u32` in
      `rail-core`, a number in TypeScript; `hands.hero_seat` is a bare
      `smallint`, `hand_row_problem` checks no seat), so `hand_stats.seat`,
      `hand_stats_ev.seat` and `hand_analysis.hero_seat` now take any
      `smallint` from 0 and `comments.anchor_seat` any from 1 - the same
      assumption sat in the analysis (a tournament hand's "not-analysed" row
      carries its hero seat) and in the forum's seat anchor. Counts
      (`max_seats` 2-24, `player_count` 1-24) unchanged. The desktop side has
      no such limit (`rail-store` seats are plain `INTEGER`, `rail-stats`
      keeps the PHF's `u32`). The rebuild route no longer lets one hand stop
      an account: a call `save_hand_stats` / `save_hand_ev` refuses for its
      data (SQLSTATE 22xxx / 23xxx) is retried hand by hand
      (`frontend/src/lib/db/statsSave.ts`, calls now hold whole hands), and
      the hands still refused are skipped and counted in `failed` (the
      coverage line's "could not be read"), to be tried again by the next
      run; the budget or the session still fails the slice. **F2**: the
      statistics buckets are per account - `hand_stats_insert:<uid>`
      1 000 000 rows / 10 min, `hand_stats_insert_day:<uid>` 10 000 000 / day
      - with the global `hand_stats_insert` kept as a ceiling at 3 000 000 /
      10 min (was the only bucket, 200 000). The route writes ~1 250 rows/s
      from one tab, below the account's budget, so a 1M-hand library rebuilds
      at the route's pace (~30 min hero-only, ~1.5 h with villain rows)
      without touching other accounts; the day budget bounds an account whose
      rows are not bounded by its hands (`stats_version` is free text); the
      ceiling is ~three accounts at full budget. The parity test no longer
      deletes the Ignition hands nor resets the bucket, and checks those
      hands get statistics on both sides: whole corpus, 7 270 hands rebuilt
      a side, 0 failed; 43 942 `hand_stats` and 7 268 `hand_stats_ev` rows,
      0 differences; 15 hands with seats past 24 on each side. pgTAP
      `stats_seats_budget.test.sql` (24); the suite 36 files, 1 170 tests.

### R4.5 Screens from `packages/ui` — L
- Hands, Reports, Players and the replayer on the web from the shared package;
  responsive down to phones; public share links hide player names by default
  (today's `/h/:slug` page does not obviously do this — check and change).

---

## Phase 5 — Analysis

Most of guideline §9 exists on the web (`ANALYSIS-PLAN.md`). What is left:

| Step | What | Size |
| --- | --- | --- |
| R5.1 | **Session review**: after a session, the hands worth a look — biggest pots, deviations from the user's preflop charts, the worst graded decisions | M |
| R5.2 | **Leak finder, top three**: the existing leak report framed as "the three most important leaks, each with example hands"; an AI-written summary is optional and was declined for now (analysis plan) | M |
| R5.3 | **Own preflop charts**: import or build charts, compare against played hands | M |
| R5.4 | **Analysis in the app** (off-table only, A10): open the web analysis inside the app's webview with the same account, or move the analysis library into `packages/` | M |
| R5.5 | **ICM** for MTT and SNG decisions | L |
| R5.6 | GTO tool integration (later) | — |

---

## Phase 6 — Subscription

| Step | What |
| --- | --- |
| R6.1 | Plans and prices (owner decision), what the free tier keeps, the early-user benefit |
| R6.2 | `profiles.plan`, entitlements checked in the database (RLS / definer functions), not only in the UI |
| R6.3 | Stripe Billing with EU VAT (Stripe Tax), webhooks in a Supabase Edge Function |
| R6.4 | App and web read entitlements; an offline grace period in the app |
| R6.5 | Terms of use and a GDPR privacy policy; data export and account deletion (deletion already cascades) |

---

## 11. Testing strategy

| Layer | Test | Where |
| --- | --- | --- |
| Parsers | Golden diff against the TS oracle for every corpus file; ported unit tests; property tests (no stack below zero, the whole pot awarded) | `cargo test`, three OSes + WASM |
| Format | Round trip and byte-exact `standard_text` | `cargo test` |
| Stats | Golden rows from TS; invariants as properties; spot hands from `tests/test/fixtures/stats/` | `cargo test` |
| Watcher | Random-chunk append, rotation, truncation, crash recovery | `cargo test` with temp dirs |
| Database | pgTAP for every new table, RPC and policy; RLS checked through the anon key, never the PAT | `supabase/tests` |
| Sync | Network cut mid-batch, duplicates, other user's keys | integration test against the local Supabase stack |
| HUD | Simulator-driven: attach, follow, seat mapping, compliance refusal, latency | CI on both OSes (headless where possible) + manual real-client checklist |
| Performance | 1M-hand benchmark, nightly, thresholds from guideline §1 | CI nightly |
| Web | Existing Vitest harness, lint, typecheck, build; shadow mode, and since R4.1 the web's conversion path WASM against TypeScript, until the TS parsers are deleted | CI |
| Web/app parity | The whole corpus through the app's path (watcher, store, sync worker) and the web's bulk upload (WASM core, saver) into a local stack as two users; `hands`, `hand_stats`, `hand_stats_ev` byte for byte and the web's rendering inputs (R4.4) | `npm run parity`, CI job `parity` |

The TS harness (`tests/`) stays the oracle until the TS parsers are deleted
(after R4.1's production period). A parser fix lands in TS and Rust in the same
PR, with the goldens regenerated by `emit.ts`, never edited by hand, and the
web's package taken from CI (`npm run wasm:web-from-ci`).

---

## 12. Release and distribution

- **Builds**: GitHub Actions, macOS universal (`.dmg`) and Windows (`.msi` or
  NSIS). Public repository, so hosted runners cost nothing.
- **Signing**: Apple Developer ID + notarization (P3); Windows signing (P4).
  Secrets only in GitHub environment secrets for the release workflow, never in
  PR builds.
- **Updates**: Tauri updater with its own signing key; feed on GitHub Releases
  (or the Rail domain); channels `beta` and `stable`.
- **Crash reports**: Sentry, opt-in only, no hand data in reports.
- **Release checklist**: compliance re-check (R3.0) for every room with
  `hud.allowed = true`; golden diff green; performance gate green; migrations
  applied to production and recorded; release notes.
  - **The compliance item is enforced (R3.10)**: run the workflow **Release
    checklist** (Actions -> Release checklist -> Run workflow, on the commit
    to release; `max_age_days`, default 90) or `npm run hud:policy-check` in
    `tests/`. It lists every room with `hud.allowed = true`, its policy page
    (`hud.source`) and `hud.checkedAt`, and **fails** when any date is older
    than the limit (or missing, or the source is not an `https` page). To
    pass: re-read each room's page (`docs/research/HUD-POLICIES.md` has the
    checklist), update `source` / `checkedAt` / `notes` - or switch the room
    off - in `config/sites.json`, merge. The release workflow, once built,
    calls it (`workflow_call`) before building.
  - Between releases a stricter room list reaches the apps from the web
    (`<web>/sites.json`, R3.10) with the next web deploy; a looser one
    (a room switched on) needs a release.

---

## 13. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Port size**: ~22k lines of TS parsers and format, ~2.6k stats, ~2.5k equity, written with many deliberate quirks | Phase 0 is the longest phase; a subtle mismatch corrupts statistics | The golden oracle makes every mismatch a failing test; port by family; TS stays live until shadow mode proves parity |
| **Rooms ban HUDs or stop writing files** (already true for GGPoker-style downloads, WPT Global, anonymous rooms) | Fewer rooms where the HUD has value | Compliance mode, honest room table, import-only support everywhere else |
| **Poker clients detect overlay processes** | Users' accounts at risk | Only rooms that allow HUDs; no injection, no reading of client memory or pixels — overlays use public window APIs only |
| **macOS permission friction**; poker clients with weak accessibility trees | "Works immediately" fails on Mac | Onboarding screen; `CGWindowList` fallback; test each allowed room's client |
| **No Windows hardware** while the HUD starts on Windows | Phase 3 blocked | P5 now; simulator lets most work happen on the Mac |
| **Database cost** at ~11 GB per million hands | Subscription price | A5 decided (Q4): a desktop row is ~3.6 KB, not ~7.3 |
| **Turnstile / auth inside the app** | Sign-in fails | A6; built in R1.7 (sign-in through the system browser) |
| **Working-hours constraint** on the development machine | Long builds and agents slow down | CI does the heavy builds; local compute stays out of working hours |
| **Public repository + future paid product** | Licensing surprise later | P8 |

---

## 14. Open questions for the owner

| Id | Question | Needed by |
| --- | --- | --- |
| Q1 | ~~Accept or reject each amendment A1–A11 (§2).~~ All accepted 2026-10-12. | R0.2 |
| Q2 | Which domain? | R1.7 |
| Q3 | May the app be used with no account (local only), or is sign-in required? The guideline's three steps start with sign-in; local-first suggests it could be optional. R1.7 built it optional ("Use offline" on the first-run screen); requiring it is a small change. **Answered 2026-10-13:** the app works offline without an account; an account is needed only for sync (guideline §6). | R1.7 |
| Q4 | Storage policy per hand (A5): drop `standard_text` for synced hands? originals to Storage always, opt-in, or never? **Answered 2026-10-13:** PHF + per-seat stats only; no `standard_text` (derived on demand), no `source_text`, originals never leave the user's disk (guideline §4; built in R1.8). | R1.8 |
| Q5 | Windows test machine: a PC, or Parallels on the Mac? | Phase 3 |
| Q6 | Which rooms first for the HUD after the compliance check? Suggested: PokerStars, Winamax, ACR. R3.0 proposes exactly these three as allowed (`docs/research/HUD-POLICIES.md`); awaiting the owner's sign-off. | R3.0 |
| Q7 | Licence for the core and the app (P8). | Phase 6 |
| Q8 | Rename the GitHub repository and the Vercel project to `rail`? | R0.14 |

---

## 15. Log

| Date | Change |
| --- | --- |
| 2026-10-12 | First draft from `RAIL_GUIDELINE.md` (12 Oct 2026) and the state of the repository at `aa504d1`. |
| 2026-10-12 | Owner accepted A1–A11; guideline updated (§2, §4, §5, §6, §7, §8, §10, §11, §12, Appendix A). |
| 2026-10-12 | **R0.1 done**: Cargo workspace with the ten crates of §3.1, toolchain pinned to Rust 1.99.0, CI job `core` on Linux, macOS and Windows plus the WASM build. P1 (Rust on the development Mac) done. |
| 2026-10-12 | **R0.3 done**: `npm run golden:emit` (`tests/scripts/golden/`) runs the converter's own path (`decodeSource` → `convertAny(text, { sourceFilename, validate: true })`) over all 556 `.txt`/`.xml` corpus files: 8 422 hands, 196 refusals, ~10–15 s. No float anywhere in PHF; output identical across runs and identical to the converter's 100-chunk batching. Full goldens are 137 MB, so **only hashes of PHF bodies are committed**: `testdata/golden/` (2.9 MB, canonical JSON, LF via `.gitattributes`) holds decode, detection (scores as integer per-mille), refusals, warnings and sha-256 of each hand's canonical PHF and standard text; `testdata/golden-full/` (gitignored) has the bodies. Canonical form = `serde_json::to_string_pretty` of a `Value` without `preserve_order`, keys in UTF-8 byte order (`testdata/golden/README.md`). CI job `golden-fresh` regenerates and fails on any difference. R0.4 adds the emitter run before `cargo test` to get the bodies. |
| 2026-10-12 | **R0.4 done**: `rail_core::phf` mirrors `types.ts` field for field (`Amount = i64`, everything else `u32`; strict `T \| null` / `x?: T` / `x?: T \| null`; `deny_unknown_fields`), `rail_core::canonical::to_canonical_json` writes the golden form. `cargo test` round-trips **all 8 422 golden hands byte for byte** after checking `testdata/golden-full/` against the committed hashes, and fails (does not skip) without it; CI's `core` job now runs `npm run golden:emit` first on Linux, macOS and Windows. TypeScript declarations generated with ts-rs (dev-only) into `core/rail-core-wasm/types/phf.d.ts`, freshness checked by `cargo test`, identity with `types.ts` checked type by type by `npm run phf:dts-check` (`tests/scripts/phf-dts/`). No TS-side inconsistency found: every field in the corpus is declared in `types.ts`. |
| 2026-10-12 | **R0.5a done** (R0.5 split into R0.5a and R0.5b): `rail_core` gains the functions of `types.ts` except `assignPositions` (`phf::{money,game,hand}`), `decode_source`, the `SiteParser` trait, registry and per-mille ranking, the complete `ParseSkip` reason set (58 codes, checked against the TS source), fingerprints with JS `\s`, `variant-lock.ts`, `p5-encoding.ts`, and the `convert` / `convert_any` pipeline with positions and validation behind a trait for R0.5b. `rail_core::js` reproduces the JavaScript built-ins the reference relies on (whitespace, regular expressions translated verbatim, IEEE-754 doubles in integer arithmetic). Decoding agrees with the goldens on **556 / 556** files; the **24 unknown-site files match their goldens exactly**, fingerprints included. Golden harness for parser steps: `golden::check(Selection::Parsers(&[…]))` in `core/rail-core/tests/golden_sites.rs` (standard-text hashes pending until R0.6). 38 TS test cases translated. One TS oddity is not reproducible and is reported: `parseAmountStrict("1.234,5.6")` returns a fractional amount (183.45); Rust refuses it as `not-a-safe-integer`. |
| 2026-10-12 | **R0.5b done**: `assignPositions`, `validateHand` (every code, message, context and order) and all of `hilo.ts` in Rust, with the evaluator they need - `cards.ts`'s `parseCard`/`extractCards` and all of `equity/evaluator.ts` and `omaha.ts` (full deck, both short-deck tables, `SHORT_DECK_RULE_BY_SITE`, Omaha high and the eight-or-better low) as `rail_core::eval`, which R2.2 builds on. Against every golden hand: positions **8 422 / 8 422**, validation **8 422 / 8 422** (no errors; all 532 warnings, 463 validator + 69 parser), hi/lo halves **22 / 22**. The corpus has 3 validate-stage refusals (`negative-stack`, `hi-lo-payout-contradiction`, `chip-mismatch`, one each); their pre-validation hands and 1 825 seeded mutations of golden hands replay the TypeScript's positions, reports and halves exactly (`tests/data/check-vectors.*`). 64 TS test cases translated. `validateHand` can throw (an unreadable card in a hi/lo showdown) and `convertAny` does not catch it, so `convert_any` now returns `Result`. |
| 2026-10-12 | **R0.6 done**: `serialize.ts` in Rust (`rail_core::phf::serialize`): `toStandardText` with every presentation rule of `resolveTextStyle`, `toStandardTextFile`, the reader (`parseStandardHand`, `splitStandardHands`, `parseStandardText`) and the `standard` parser, registered (moved from R0.7). `golden::SERIALIZER` is on: the text hash agrees on **8 422 / 8 422** hands and the per-file hash on **556 / 556** files; the 39 files `standard` wins match their goldens fully (881 hands). Round trip over every golden hand, held to the TypeScript's answers (`tests/data/serialize-vectors.*`): the re-read hand equals the TypeScript's on 8 422 / 8 422, semantically equal on 8 097 (the TypeScript's own round trip loses something on the same 325), byte-stable on 8 421 (the same one exception); 2 460 mutations and 25 texts agree. Lookahead patterns written as code, tested against Node; V8's `Date` reading reproduced (day rollover, `24:00`). 39 TS test cases translated. Not reproducible, reported: `seat: -1` for a straddler without a seat and seat-like numbers beyond `u32` (an error here), zone-less dates (local time in JS). |
| 2026-10-12 | **R0.7a done** (R0.7 split into R0.7a and R0.7b): `pokerstars` and `ggpoker` in Rust, with all of `ps-gg-hand.ts` (`StarsHandDraft`), `p3-draft.ts` and `p3-stars-dialect.ts` as reusable modules in `parsers::shared`; both registered. Goldens: `pokerstars` **45 / 45** files (108 hands, 5 refusals), `ggpoker` **24 / 24** (215 hands, 2 refusals), fully; the 39 `standard` files now with their whole ranking; whole-file detection of the ported parsers equal to the goldens on all 556 files. Beyond the corpus, held to the TypeScript (`tests/data/psgg-vectors.*`): 3 420 mutated chunks through both parsers and 164 clone-dialect cases equal (two 17 054-case soak runs too). The GG parser and `parse_standard_hand` agree on every GG cash hand. 117 TS test cases translated, `psggInvariants.ts` included. Not reproducible, reported: a straddler with no seat line (`seat: -1`) - the same `unseated-actor` refusal, reached by `BuildError::UnseatedStraddler`. |
| 2026-10-12 | **R0.7b done, R0.7 complete** (A9: R1.1-R1.3 may start): `weplay` and `coinpoker` in Rust, registered in `index.ts` order. WePlay's normalizer computes in `JsNumber` (doubles, `%`, `toFixed`) and hands its text to `parse_standard_hand`; CoinPoker builds on `StarsHandDraft` and edits `results` after `build`. Goldens: `weplay` **128 / 128** files (6 726 hands, 96 refusals incl. one validator `chip-mismatch`), `coinpoker` **16 / 16** (21 hands, 1 refusal), fully; whole-file detection of the five ported parsers equal to the goldens on all 556 files. Beyond the corpus (`tests/data/wpcp-vectors.*`): 3 291 mutated chunks under default and strict options, WePlay's normalizer alone too, all equal (two soak runs of ~29 400 cases too); `byteCompat` reproduced against the frozen pre-PHF converter (5 983 hands: 5 783 identical, 199 in the three accepted classes, 1 dropped). 65 TS test cases translated. Not reproducible, reported: a WePlay table size, button or seat beyond `u32` (R0.6's rule). |
| 2026-10-12 | **R0.8 done**: `partypoker`, `888poker` and `pokerbros` in Rust, registered in `index.ts` order, with all of `p2-partygaming.ts` and `p2-handbuilder.ts` as reusable modules in `parsers::shared` (the builder of iPoker, MicroGaming, Ongame, Entraction and Unibet too). The draft builder computes in `JsNumber` - amounts, seats, size and button are printed into the standard text it re-reads. Goldens: `partypoker` **15 / 15** files (18 hands, 1 refusal), `888poker` **14 / 14** (13 hands, 1 refusal), `pokerbros` **2 / 2** (2 hands), fully; whole-file detection of the eight ported parsers equal to the goldens on all 556 files. Beyond the corpus (`tests/data/p2pb-vectors.*`): 3 145 mutated chunks through all three parsers and the 31 files re-encoded six ways (UTF-16 LE/BE, Windows-1252, CRLF) through `convert`, all equal (two 31 135-case soak runs too). R0.7a's clone dialect now defers a table size or button beyond `u32` to `build` (`set_table_numbers`), so PokerBros' button correction reproduces the TypeScript. `rail-convert` built (README §8): a std-only `[[bin]]` of `rail-core`, summary / `--json` / `--text`, smoke-tested against the goldens. 36 TS test cases translated. |
| 2026-10-12 | **R0.9 done**: `ipoker` and `microgaming` in Rust, registered in `index.ts` order, with all of `p2-xml.ts` and `p4-textroom.ts` as reusable modules in `parsers::shared`. The XML reader is the TypeScript's own scanner (the path Node runs), ported - not `quick-xml`: its leniency (a closing tag closes whatever is open, CDATA skipped to the first `>`, `Object.prototype` names as entities) is behaviour. iPoker's action order is `Array.prototype.sort` as V8 does it (`js::sort`, TimSort; 1 120 Node-recorded arrays with `NaN` replay exactly). The draft builder gained the street and the kind that the rooms' object-literal tables return for an `Object.prototype` key (`type="toString"`), and V8 sorting. Goldens: `ipoker` **15 / 15** files (26 hands, 1 refusal), `microgaming` **12 / 12** (21 hands), fully; whole-file detection of the ten ported parsers equal on all 556 files; iPoker's assembled `rawText` now checked against the Rust split. Beyond the corpus (`tests/data/xml-vectors.*`): reader, Base64 and strict-amount probes, splits, detection, **3 888** seeded XML mutations through both parsers and the 27 files re-encoded six ways, all equal (two 38 448-case soak runs too). 33 TS test cases translated. Not reproducible, reported: lone surrogates (`&#xD800;`; U+FFFD stands in, `parser-error` where it would show), seats/table sizes between 2^32 and 2^53 (`u32` in a PHF). |
| 2026-10-13 | **R0.10a done** (R0.10 picked up as R0.10a-d, grouped by shared module): `winamax` and `chico` in Rust, registered in `index.ts` order, with all of `p6-handbuilder.ts` as a reusable module in `parsers::shared` (`P6Draft`, `p6_to_standard_text`, `build_p6_hand`; amounts, seats, size and button in `JsNumber`; no merged shared code changed). Goldens: `winamax` **26 / 26** files (34 hands, 1 refusal; the three Windows-1252 files convert as the app decodes them, the negative fragment stays `unknown-site`), `chico` **16 / 16** (48 hands, 20 refusals - 13 of the 17 Omaha hands headed `Hold'em Pot Limit` refused `rake-mismatch`, the 4 others read as `omaha`), fully; whole-file detection of the twelve ported parsers equal on all 556 files. Beyond the corpus (`tests/data/p6-vectors.*`): splits, 29 detection probes, **3 003** seeded mutations through both parsers, **600** random drafts through the builder, the 42 files re-encoded seven ways (U+FFFD included), all equal (two soak runs, 29 067 cases and 6 000 drafts each, too). 33 TS test cases translated (`p6Parsers.test.ts` but the replayer). Not reproducible, reported: seats/table sizes between 2^32 and 2^53 and a draft's unseated blind (`u32` in a PHF). |
| 2026-10-13 | **R0.10b done**: `acrwpn` (all three WPN dialects - legacy, modern, data-mined) and `ignition` in Rust, registered in `index.ts` order, with all of `p5-handdraft.ts` as a reusable module in `parsers::shared` (`P5Draft`, `p5_draft_to_standard_text`, `p5_build_hand`; amounts, seats, size and button in `JsNumber`). One shared change: `phf::hilo::StatedTotals` holds `JsNumber`s (Ignition's `HI` / `LOW` are doubles in TypeScript); all earlier vectors still equal. Goldens: `acrwpn` **76 / 76** files (144 hands, 25 refusals; the 14 UTF-16LE files, Omaha, Six Plus), `ignition` **56 / 56** (96 hands, 12 refusals; Omaha Hi/Lo with its halves, streets recovered from betting closure), fully; whole-file detection of the fourteen ported parsers equal on all 556 files. Beyond the corpus (`tests/data/p5-vectors.*`): splits, 37 detection probes, **3 935** seeded mutations through both parsers (146 misread from UTF-16LE; `cashOnly` outcomes where they differ), **700** random drafts through the builder, the 132 files re-encoded six ways, all equal (two soak runs, 36 767 cases and 7 000 drafts each, too). 30 TS test cases translated (`p5Parsers.test.ts`, the Ignition files of `phfHiLo`, the ACR parts of `shortDeck`; not the replayer, stats or equity). Not reproducible, reported: seats/table sizes between 2^32 and 2^53 and a draft's unseated actor (`u32` in a PHF; neither parser produces one). |
| 2026-10-13 | **R0.10c done**: `fulltilt` and `runitonce` in Rust, registered in `index.ts` order; Full Tilt reads its own grammar into `StarsHandDraft`, Run It Once its body through R0.7a's clone dialect. One additive shared change: `StarsHandDraft::showdown_marker_at` (the TypeScript's runout `-1` of `*** SHOW DOWN 0 ***`); all earlier vectors still equal. Goldens: `fulltilt` **13 / 13** files (21 hands, 1 refusal `no-seat-block`; both header generations, run-it-twice, Omaha H/L halves), `runitonce` **4 / 4** (2 hands, 2 refusals: the Omaha splash file `unsupported-variant`, the tournament summary `no-hands`), fully; whole-file detection of the sixteen ported parsers equal on all 556 files. Beyond the corpus (`tests/data/p3-vectors.*`): splits, 25 detection probes, **4 251** seeded mutations through both parsers (168 misread from UTF-16LE; `cashOnly` outcomes where they differ), the 17 files re-encoded six ways, all equal (two soak runs of 42 231 cases too). Numbers beyond `u32` (seats, size, button, runout index, and runout `-1`) are carried as stand-ins and reported as R0.6's `parser-error` only where the TypeScript returns its hand. 42 TS test cases translated (`p3Parsers.test.ts` Full Tilt / Run It Once parts, Full Tilt's `phfHiLo`; not the replayer or `analyzeAllIn`). Not reproducible, reported: a Full Tilt marker numbered past 10 000 (the TypeScript allocates a runout per index), and a Run It Once seat line beyond `u32`, which stops the shared dialect at that line (R0.7a) where the TypeScript may refuse later or drop a duplicate. |
| 2026-10-13 | **R0.10d done, R0.10 complete - all 19 parsers in Rust**: `ongame`, `entraction` and `unibet`, registered in `index.ts` order; `parsers::ported()` is the whole registry and a test asserts `builtin()` equals `REGISTRATION_ORDER`. All three build on `p2_handbuilder` (Unibet through `draft_to_standard_text` with its own tournament first line, `$` patterns expanded as `String.prototype.replace` does). Additive shared change: `phf::money::{format_amount_digits_js, parse_buy_in_token_js}`; the `dev` profile optimises the regex and sha-256 dependencies (test speed only). Goldens: `ongame` **13 / 13** files (21 hands, 1 refusal), `entraction` **13 / 13** (21 hands, 1 refusal - the validator's `hi-lo-payout-contradiction`; three of four Hi/Lo files convert), `unibet` **5 / 5** (4 hands, 2 refusals), fully; and the Phase 0 exit check minus WASM: the whole Rust pipeline over the corpus equals every golden - **556 / 556** files, **8 422 / 8 422** hands, **196 / 196** refusals. Beyond the corpus (`tests/data/p4-vectors.*`): 78 text-room probes, splits, 35 detection probes, **6 026** seeded cases through all three parsers, the 31 files re-encoded six ways, all equal (two soak runs of 47 786 cases too). 43 TS test cases translated (`legacyNetworks` Ongame / Entraction, `unibetParser`, `phfHiLo` Entraction; not the replayer or `analyzeAllIn`). Not reproducible, reported: seats, sizes and buttons between 2^32 and 2^53. Phase 0 left: R0.11 registry, R0.12 `sites.json`, R0.13 WASM + shadow mode, R0.14 layout. |
| 2026-10-13 | **R0.11 done** (Phase 0 part; the desktop-local `unsupported` table waits for R1.2): the core returns `FileConversion::unrecognized` - `Unrecognized { fingerprint, header_sample, guessed_site, confidence, guess_basis, shape }` - beside the unchanged `unknown-site` refusal for a file no parser claims; every golden byte-identical, the 24 unrecognised files carry a record with the golden's fingerprint, Boss Media and Merge guessed by signature at 1000. The anonymiser (`rail-anon/1`, `rail-convert --anonymise`) replaces every name its wide rules find, consistently, amounts and layout kept, 64 KiB samples: over all **556** corpus files **3 454** (file, name) pairs / **1 471** distinct names checked, none survives (no name of 3+ characters even as a substring). Migration `20270414090000_unparsed_registry.sql` (not applied to production): `unparsed_hands.origin` (`web` default) / `os` / `client_version` / `consented_at` / `anonymiser_version` / `guessed_site` / `guess_confidence`, the consent rule in the RPC and in `CHECK` constraints, `unparsed_gaps.desktop_hands` / `guessed_sites`; pgTAP 41 tests; types regenerated. `docs/unsupported-formats.md` with the weekly triage query; label `new-format`. Phase 0 left: R0.12 `sites.json`, R0.13 WASM + shadow mode, R0.14 layout. |
| 2026-10-13 | **R0.12 done**: `config/sites.json` v1 and `config/sites.schema.json` (draft 2020-12). One entry per client (room or skin) with a `parser` field; `network` entries stand in where the clients are not yet told apart (iPoker, Chico, Ignition and the closed networks) and can never carry table data or allow a HUD; `standard` is a `format`. **22 entries**: the 19 parsers, plus WPT Global, Boss Media and Merge without one. Unknown is `null`: every `hud.allowed` `null`; 2 paths in all (PokerStars, inferred, `verified: false`); `files.live` from the README §6 starting point, unverified; every `tables` field `null`. `rail-config`: typed loader (`load`, `load_shipped`, `load_remote`), `validate` / `check_coverage`, `merge_remote` (a remote file may only make HUD policy stricter, `false` < `null` < `true`; unknown remote ids ignored; identity changes ignored), `Site::hud_permitted`; builds for wasm32 (added to CI's WebAssembly build). CI: a parser without an entry, or an entry naming a missing parser, fails `cargo test` - the guideline §14 rule is now enforced; the file is validated against its schema by ajv in `tests/`. Phase 0 left: R0.13 WASM + shadow mode, R0.14 layout. |
| 2026-10-13 | **R0.13 done**: `rail-core-wasm` with wasm-bindgen 0.2.129 - `convert(bytes, filename, optionsJson)` (`rail-convert/1`: decode, detection, hands as PHF with optional Rust-side canonical sha-256, refusals with raw text, warnings, standard text per hand and per file, stats, the R0.11 `unrecognized` record; `parsedAt` required from the caller), `detect`, `serialize` (one hand or a file), `anonymise`, `formats`; JSON text both ways; typed wrapper `core/rail-core-wasm/js/index.ts` over `types/phf.d.ts`; `forbid(unsafe_code)` kept. `npm run wasm:build` (cargo profile `wasm-release`: `opt-level = "s"`, fat LTO, 1 CGU, abort; pinned wasm-bindgen-cli, name section removed, no wasm-opt; output gitignored): **2.28 MB raw, 0.77 MB gzipped** (budget 1.5 MB, enforced). **Shadow mode** (`npm run wasm:shadow`): the WASM core equals the TypeScript pipeline on **556 / 556** corpus files - **8 422** hands byte-identical in canonical PHF (Rust's own canonical hash = the golden's), **196** refusals with stage, reason, message and fingerprint, warnings, standard text per hand and per file; registry record on all 24 unclaimed files. Throughput: TypeScript ~3 150 hands/s, WASM ~2 600 (with `JSON.parse`). CI job `wasm` (build, budget, shadow). **Phase 0 exit, all but R0.14**: the golden diff is 100 % natively on Linux, macOS and Windows (`core` job, `every_corpus_file_matches_its_golden`) and under WASM (`wasm` job); the registry's record comes out of the core on the web path (WASM) for every unclaimed file - its write to `unparsed_hands` from the web stays the TypeScript one until R4.1, and from the desktop arrives with R1.2. Phase 0 left: R0.14 layout and rename. |
| 2026-10-13 | **R1.1 done**: Tauri 2 app shell in `app/` (crate `rail-app` in the workspace; Vite + React + TypeScript with its own lockfile). Single instance, tray with a status menu (Open Rail, Pause import as a disabled placeholder, Quit Rail; closing the window hides it to the tray), start at login (off by default, a setting, `--minimized` at login), log files in the OS log directory (5 MB x 5), crash-safe versioned `settings.json` (temp file, fsync, rename; 8 tests). Six screens as hash routes with a sidebar, English strings through `app/src/i18n/` (`hr` prepared), CSS Modules over a copy of the web's token layer (A3), dark/light/system theme. Settings, About calls `core_info`: 19 parsers, `phf/1`, 22 `sites.json` entries via `rail_config::load_shipped`; a debug-only `convert_file` runs `rail_core::convert` on a picked file. Pinned: tauri 2.11.5 (its sub-crates held on the 2.11 line, see *As built*), CLI 2.11.4, api 2.11.1, React 19.2.8, Vite 7.3.6. CI job `app`: TS/CSS lint and typecheck plus clippy and tests on Linux (WebKitGTK installed); clippy, tests and an unsigned bundle on macOS (`.dmg`, arm64, ad-hoc signed; not universal, see *As built*) and Windows (NSIS), artifacts kept 7 days; the `core` job excludes `rail-app`. |
| 2026-10-13 | **R1.2 done**: `core/rail-store` - SQLite bundled (`rusqlite` =0.40.2) in WAL with `synchronous=NORMAL`, foreign keys, busy timeout, 16 KiB pages; embedded forward-only migrations on `user_version` (tested from empty and from every earlier version); `STRICT` schema `kv`, `sources`, `files`, `hands` (PHF canonical JSON, zstd =0.14.2), `quarantine`, `unsupported` (R0.11's registry with count and consent state), `outbox`, documented in `core/rail-store/SCHEMA.md` (Phase 2/3 tables reserved). One writer thread on a bounded channel commits each `ImportBatch` - a file's hands, refusals, registry record **and its new read offset** - in one transaction, dedupes by `hand_key` and queues every new hand in `outbox`; a read pool serves the queries (counts, today, files, folders, quarantine, outbox batches, registry). `import_file` converts a whole file with `rail_core` (R1.3's reader sends the same batches). **Exit check** (`tests/crash.rs`, Linux/macOS/Windows CI): a child importing the corpus is killed 12 times at random moments and inside an open transaction; after each kill `integrity_check` is ok and the stored hands are exactly those of the files whose offset moved; the import resumes at the next file and ends equal to a clean single import (7 496 distinct hands from 8 422). Corpus import into an empty store (M2 Pro): 2.7 s on one thread (~3 150 hands/s), 0.72 s with 8 converting threads (~11 700 hands/s; the writer itself ~59 000 hands/s); 23.1 MB, ~3.2 KB per hand. The app opens the store in `setup` under the local data directory; `store_status` feeds the Today screen. |
| 2026-10-13 | **R1.3 done**: `core/rail-watch` - `notify` =8.2.0 (FSEvents, ReadDirectoryChangesW, inotify) plus a rescan of every folder every 60 s, network folders polled only (`sources.poll_only`, migration 0002, detected from the mount table / UNC paths), one coordinator and 2 workers committing through the store's writer (bounded queue as back-pressure); start / stop / pause / resume, folders in `sources`, status per folder and events. The incremental reader stores the offset at the **first byte of the last chunk** once the next hand has started (each chunk's own slice converts exactly as the whole file: 517 / 517 files with hands whose chunks are verbatim), or at the end after 500 ms of quiet when the last hand validates, ends with a line end and the file does not end inside a code unit (5 s without the line end, 30 s for a refused tail); iPoker-like files (chunks not verbatim) are read whole. Decoding piece by piece equals `decode_source` (BOM only at 0, UTF-16 on code units, strict UTF-8 that meets a 1252 byte re-decided; 556 / 556 files). Truncation, a replaced file (first 256 bytes), rename, deletion, unplugged folders handled. **Exit check**: 31 corpus files (all 19 parsers, UTF-8 / BOM / UTF-16 LE / Windows-1252) x LF and CRLF appended in random chunks (a third byte by byte) on a test clock import exactly their golden hands, refusals and registry record, once; all 556 x 2 in a soak. Latency append to commit: 15-24 ms when the next hand completes it, 513-522 ms for a table's last hand (the quiet period). The app starts it after the store, stops it first on exit, shows it in the tray ("Pause import" works) and on Today; a debug-only "Add a folder" button. |
| 2026-10-13 | **R1.4 done**: folder discovery and the first-run screen. `rail_watch::discover` expands each room's `sites.json` templates for this OS (`~`, `/`, `%VAR%`, drives; `*` / `?` levels such as account folders), bounded and sorted, and reports per folder the room, file count (the room's `files.glob`, else the watcher's extensions plus a 3-file detection sample), newest file date and whether it is watched; tested on a fake home. Verified on this Mac, read-only and structure only: **WePlay** writes live `HH*.txt` files under `~/Documents/hands/<account>/` (its `HandsHistoryDir` preference; default-ness not established); **GGPoker** and **CoinPoker** write no local hand histories (verified negatives, no path). Everything else stays unverified; R0.12's test is now `only_what_was_seen_is_verified`; how to verify a room on macOS or Windows: `docs/research/VERIFYING-PATHS.md`. "Only new hands": `FileReader::mark_read` (an empty batch to the file's complete end) and `Watcher::add_source_with(.., NewSource { site, only_new, .. })`, which marks before the watcher reads. Migration 0003 `sources.site`; a folder found for a room reads only the room's `files.glob`. The app opens on the first-run screen until it is finished or skipped (`firstRunDone`): sign in (placeholder), the found folders with checkboxes, "Add a folder manually..." (the system picker, now in release builds), "Import everything" / "Only new hands", open a table; reachable from Settings and Today; `en` / `hr`. The debug-only "Add a folder" button is gone. |
| 2026-10-13 | **R1.5 done**: Settings → Folders. Each watched folder with its room, state, last import, hands today, hands, files, problems and refused hands (reason codes with counts, then messages; `Reader::source_quarantine` through `files.source_id`), and its controls: on / off (hands kept), include subfolders, poll only, the room chosen by hand when detection fails, change folder, remove (a dialog says the hands stay); add a folder by hand (picker; "import everything" / "only new hands", subfolders, polling) and find the rooms' folders again. **Edit path**: one `rail-store` transaction keeps the folder's id and settings, moves the rows of the files found again under the new path **with their offsets** (a moved or copied folder continues where it stopped) and detaches the others with their hands (none found = remove + add); tested both ways in the store and on the watcher. **Room override**: `set_source_site_override` resets the files the new choice reads differently (with their quarantine) in the same transaction and the watcher reads them again; the reader records the forced parser as `files.site`. New writer methods `set_source_recursive`, `set_source_site_override`, `set_source_path`; no migration (schema stays 3). Thin Tauri commands with path checks (absolute, no `..`, an existing directory). The first-run table and import choice are shared components; `<dialog>` modals; `en` / `hr`; checked in a browser against a mocked IPC. |
| 2026-10-13 | **R1.6 done**: the import pipeline. A rayon pool of import threads (physical cores - 1, at most 8; `Watcher::set_import_threads` as the play-time hook), live files ahead of a backfill, a large read cut into batches of 500 hands converted in parallel and committed in order with their own offsets, batches waiting together committed in one transaction with a savepoint each (crash and random-append tests green; the crash test now commits in groups). Backfill progress per folder (bytes of bytes, files, hands, time left) on `SourceStatus`, as events, in the tray ("Importing 37% · …"), on Today and the folder cards; the window reloads on `watcher-changed`. Refused hands: raw text dialog, an app-wide view by reason, "Try again after an update" (files with refusals by another parser version reset and read again). Migration 0004 rollups (`files.hands`/`quarantined`, `source_totals`, `source_days`): `Watcher::status()` 42.7 ms at 90k hands before, ~0.05 ms at 500k now. Benchmark `rail-watch --example import_bench` on a generated dataset (the corpus with permuted hand-id digits, 431 files, 19 parsers, never committed): M2 Pro 10 300 hands/s at 100k (8 threads), 9 170 at 500k (1.51 GB store, 3.18 KB/hand); the guideline's 5 000 is met there; CI's macos-latest (Apple M1 Virtual, 3 cores) measured 3 926 / 4 615 and 4 782 / 5 264 hands/s, so job `import-bench` is a regression guard calibrated to that runner: best of three runs >= 3 500 hands/s. Found on Linux CI and fixed: inotify's open events from the watcher's own reads, plus a reader that opened unchanged read-whole (iPoker) files on every look, kept two files cycling at the front of the queue (`an_unchanged_file_is_not_opened`). |
| 2026-10-13 | **R1.7 done**: desktop sign-in through the system browser (A6). The app makes an X25519 key pair and a state per sign-in (memory only, ten minutes) and opens `/auth/desktop`; after the user signs in and confirms there, the Edge Function `desktop-handoff` (Deno, WebCrypto) verifies the caller's JWT with GoTrue, refuses unconfirmed / anonymous accounts, spends the per-account budget `claim_desktop_sign_in()` (migration `20270421090000`, 10 an hour, as the user), mints a one-time magic-link token with the service role and returns it encrypted to the app's key; the page redirects to `rail://auth/callback`, the app decrypts and redeems it at `/verify` for a session of its own. Refresh token in the OS keychain (`keyring` =3.6.3), access token in memory, background refresh with backoff, sign-out ends only the app's session. `tauri-plugin-deep-link` =2.4.10, single-instance with `deep-link`. `rail-sync::auth` (handoff, GoTrue client on reqwest + rustls/*ring*, the manager). Settings → Account, first-run step 1 with "Use offline" (Q3 open), Today and tray lines; `en` + `hr`. Tests: Rust 32 + app, Deno 17 (new CI job `functions`), pgTAP 14; end to end against a local stack (interception, replay, independence of the two sessions, sign-out, budget) and the page in a browser. Production untouched: the owner's checklist is under R1.7 *As built*. |
| 2026-10-13 | Owner decisions: **Q3** - the app works offline without an account, an account is needed only for sync (guideline §6); **Q4** - a desktop hand is PHF + per-seat stats only, no `standard_text`, no `source_text`, originals stay on the user's disk (guideline §4; A5 decided). |
| 2026-10-13 | **R1.8 done**: Supabase for desktop ingest (migration `20270428090000_desktop_ingest.sql`). `hands.origin` (`web` / `desktop`); `standard_text` nullable for desktop rows only, with a CHECK for every writer (no standard text, no source text, empty `meta.rawText`, PHF <= 256 KiB); the direct insert path writes web rows only. `hand_sources` (watched folder per device, counters, no paths; RLS select-own) and `register_hand_source`. `ingest_hands(p_source, p_rows)` (definer): `{hand_key, phf}` rows, every search column derived on the server by `hand_row_from_phf` (the SQL twin of `handInsertFromPhf`; parity over the corpus, 7 496 distinct hands, 0 differences), per-row `inserted` / `duplicate` / `rejected` + reason, at most 500 hands / 8 MiB a call. Budget per account: 150 000 rows / 10 min and 2 000 000 / day; desktop rows no longer spend the web's global `hands_insert`. Web readers derive the text from the PHF (`storedStandardText`: `getHand`, both share readers); stats rebuild and `save_hand_stats` work on desktop rows unchanged. `rail_sync::ingest`: rows from the outbox (rawText emptied), batches (500 / 4 MiB), `IngestClient` with a fresh token per call and one refresh on 401. Tests: pgTAP 51 + 40 (generated parity), Rust 14, vitest, end to end on a local stack (7 469 hands, 16 calls, 18 s). PostgREST refuses gzip bodies (~7.5 KB JSON a hand on the wire; noted for R1.9). Production untouched: the owner's checklist is under R1.8 *As built*. |
| 2026-10-13 | **R1.6 fix, backfill end before the status** (Linux CI: `a_backfill_reports_its_progress_and_ends` read `Some(309 of 312 files)` on the status right after `Progress { None }`): the coordinator reported a backfill's end from the read's answer and wrote the status at the end of the loop turn, so a status read in between showed the last published progress (no backfill ran on; a run cannot come back once over). An end is now reported by `publish` after the status is written (ends before new progress; flushed on stop). New deterministic `watcher::tests` (the coordinator driven by hand, red before); the backfill test checks the status at once on the end (its sink holds the watcher 100 ms there: old code 10 / 10 red with the CI values), waits for "over and every file read", and fails on a second end or progress of the same `started_at` after it; `RAIL_WATCH_THREADS` picks its import threads. Stress on macOS: 60 / 60 runs (30 each at 1 and 2 threads) plus 40 / 40 with four copies at once. |
| 2026-10-13 | **Import benchmark gate: a ratio, not hands/s** (R1.6 "As built"). The absolute gate (best of three >= 3 500 hands/s on the 3-core M1 runner) failed R1.7's PR, which does not touch the import path, at 3 436 hands/s: the runner's speed moves between jobs (best of three 3 436 - 5 264 on the same code) and within one (2 954 - 4 666). `import_bench` now measures a reference on the same runner - one thread converting the corpus (7 321 hands) from memory with `rail_core`, before the first import and after each one - and gates on the pipeline efficiency, hands stored/s / (reference x threads), best of three, **>= 45 %** (`--min-efficiency`); measured 59 / 62 / 67 % on jobs whose absolute rate was 3 339 - 4 071; plus a floor of **1 500 hands/s** (`--min-rate`) for a catastrophic slowdown, `rail_core`'s own included, which the ratio cannot see. Job renamed; the guideline's >= 5 000 stays measured on the owner's M2 Pro (10 300). No change to importing or parsing. |
| 2026-10-13 | **R1.9 done, Phase 1's exit criterion met on a local stack**: the sync worker (`rail_sync::worker`). Outbox in send order - hands queued in the last 15 min newest played first, then the backlog oldest due first (store migration 0005: `outbox.played_at` + covering index) - in batches of 500 per watched folder (`hand_sources` registered once, device id random in `kv`) to `ingest_hands`; inserted / duplicate leave the outbox, rejected go to `sync_rejected` with the reason (UI counts per reason, Try again); offline = backoff 5 s to 10 min with jitter and per-hand attempts; the rate limit waited out by window then probed with one hand; 401 refresh once; resumable and idempotent. Upload cap while > 2 000 hands wait (default 1 MB/s, user setting; tables-open hook). Account safety: the store's owner in `kv`, every token from `Account::access_token_for(owner)`, signed out = nothing sent, another account = nothing sent or pulled until the user uploads this computer's hands to it or keeps them apart. Pull of every row of the account the store lacks (web and other computers): `hands_since` keyset (migration `20270505090000_desktop_pull.sql`, invoker, keys only, rows a minute old) then PHF for missing keys; pulled hands never queued. App: Settings → Account Sync panel, Today line, tray line, Sync now / Pause / cap, `en` + `hr`. Tests: store 5, sync 13 worker tests on a scripted server, pgTAP 17 (suite 997). End to end: killed mid-sync and resumed, server = store (7 469, once each; ~270 hands/s, 7.5 KB a hand); 58 live hands through the watcher visible as the user in 0.5-5.9 s through a network cut mid-batch, once each; a web hand pulled into a second store. Remaining for Phase 1: R1.10; production checklist under R1.9 *As built*. |
| 2026-10-13 | **R1.10 done, Phase 1 complete on `staging`**: live arrival on the web. Migration `20270512090000_hand_arrivals.sql`: `hand_arrivals`, one row per account bumped once per insert statement on `hands` by the statement trigger `hands_signal_arrival` (count, origin, time; no hand content; ~320 bytes a change), select-own RLS, in `supabase_realtime`; `hands` deliberately not published (whole-row payloads with the PHF, per-row RLS on every backfill). Measured: a role without SELECT gets a content-free 401 notice per change, so `anon` has SELECT and no policy (`notifications` has the same exposure, noted, not changed); DELETE (account removal only) shows a random id. Web: `lib/live/arrivals.ts` (debounce 1.5 s, max wait 5 s backing off to 30 s, nothing while hidden, resync on reconnect), `useHandArrivals` (token before join, INSERT + UPDATE filtered to the owner, removed on unmount / sign-out), `AppFrame live` on `/library` and `/stats` only; the library re-reads page 1 in place or offers "N new hands - show", "Hands arriving from <device>" from `hand_sources`; stats re-read quietly and rebuild for new hands without a click. Tests: pgTAP 29 (suite 31 files / 1 026), vitest 12, `npm run realtime:arrivals` 15 / 15 on an isolated stack (A sees its own; a forged or missing filter and anon see nothing of others), browser end to end. The consolidated production checklist for R1.7-R1.10 is under R1.10. |
| 2026-10-13 | **R2.1 done**: the stats engine in Rust (`core/rail-stats`), `lib/stats` ported module for module (90 counters, money, the rulebook; every STATS-SPEC call as the TypeScript has it). Oracle: `npm run golden:emit` also writes `testdata/golden-stats/` (per hand the sha-256 of the canonical `statsRows(handFacts(phf))` and its seats, per file the column totals; 3.3 MB committed, 206 MB in full in the gitignored `testdata/golden-stats-full/`), checked by `golden-fresh`; no float in any row, `-0` written as 0 (none in the corpus). **8 422 / 8 422 hands, 51 464 / 51 464 rows equal to the TypeScript's**; the eight invariants of `statsInvariants.ts` on every corpus hand; the 17 spot fixtures and the corpus, short-deck and pot-type spots; 4 000 seeded mutations through both engines (50 000 in a soak) equal. Three divisions in doubles reproduced with `JsNumber`. `rows_for(&PhfHand)` is the API for R2.3; nothing wired into the app. rail-stats joins CI's wasm32 build. STATS-SPEC §12 (the port, oddities); its title now says `stats/2`. |
| 2026-10-13 | **R2.2 done**: all-in EV in Rust (`core/rail-equity`), `lib/equity` ported - `enumerate.ts` (exhaustive enumeration, the seeded Monte Carlo, `plan`, `EquityInputError`), `range.ts`, `multiway.ts`, `allInEv.ts` - and `handEvRow` (`ev_row`, `EV_VERSION` `ev/1`). Exact representation: shares of a pot as integers in units of 1/27720 of a board (`units / (boards * 27720)`), and the TypeScript's double arithmetic after that (the equity division, `apportion`, range weights) replayed operation for operation in `JsNumber`. Oracle: `npm run golden:emit` also writes `testdata/golden-ev/` (hero row as the web stores it and the full `analyzeAllIn`, equities as `String(x)`, hashed; 3.1 MB, 5.5 MB in full gitignored), checked by `golden-fresh`. **8 121 / 8 121 rows and 8 422 / 8 422 analyses equal** (508 all-ins: 226 preflop enumerations, 11 Omaha preflop Monte Carlo, 1 short deck; 22 hi/lo declined), every equity bit for bit, Monte Carlo exact (same `mulberry32`, same Fisher-Yates); 4 500 seeded vectors (mutated hands, `equity()` requests, ranges) and a 45 000-case soak equal. `equityEnumerate`, `equityAllInEv`, `equityRange`, `equityCorpus` translated, plus the `analyzeAllIn` checks of `shortDeck` and `phfHiLo`. Release, M2 Pro: 25 ms per heads-up preflop all-in, 15 ms Omaha preflop, under 1 ms flop/turn; R2.3 should run the backfill's EV as a background pass or cache preflop matchups. `rail_core::eval` gains `#[inline]` on its hot path only; the dev profile builds rail-equity optimised. rail-equity joins CI's wasm32 build. |
| 2026-10-13 | **R2.3 done**: local statistics in `rail-store` (migration 6). With every hand, on the import threads, `PreparedStats` (`rail_stats::stored_rows` - `handStatsRows`' rule: hero always, villains unless the room is positionally anonymised, one row per seat - the segment, the rollup scope, the EV plan); in the hand's transaction `hand_stats` + `seat_stats` (counters and money as a varint blob: the first, column-per-counter layout cost +61 % size and 21-29 % of the import's speed) and the rollup increments, summed per writer group and upserted once per key: `player_rollups` (site, player, scope, segment; `aggregate`'s default exclusions) and `hero_rollups` (segment, position, UTC day, kind). Segment = (site key, format, variant, limit, `hu`/`6max`/`full` by `maxSeats`, a cash game's currency and exact big blind or `chips`). Opaque-id villains (GGPoker, ACR/WPN mined) summed per session (`<table>@<UTC day>`), never across sessions. The hero's EV at import unless the all-in was preflop (`rail_equity::ev_row_unless_preflop`); those, and rebuilds after a `STATS_VERSION` bump or on request (new generation, cursor in `kv`, resumable), by a background `StatsWorker` paused during backfills and (EV) while tables are open. Rows equal the engine's for every corpus seat; crash test checks rows and rollups after every kill. import pipeline efficiency unchanged after the fix (local 3 threads 48 / 46 % before, 48 / 48 % after; the first push's 41-44 % on CI came from SQLite's statement journal in temp files - now `temp_store = MEMORY` - and a `RETURNING` insert), stats 17-22 µs a hand on the import threads, +18 % size; preflop all-in 26 ms in the background; rebuild ~6 500 hands/s; at 500k the HUD lookup for 9 players takes 73 µs (p99 0.24 ms), hero totals 76-127 ms. App: the pass started with the store, Settings debug panel. Preflop-matchup cache measured, not built. |
| 2026-10-14 | **R2.4 done**: displayed statistics are data. `config/stats/standard.json` (32 definitions: the guideline §5 set plus hands, net bb, RFI, iso, cold call, squeeze, fold to 4-bet, cbet river, fold to turn cbet, raise flop cbet, saw flop, AF) and `stats.schema.json`; a definition is labels and descriptions in `en` + `hr`, a formula over the `stats/2` counters (`pct`, `sum`, `+ - * /`; evaluated in JavaScript's doubles, `JsNumber` in Rust), a format, colour bands to five tones, the sample and its full-opacity minimum, default HUD membership. `rail_config::stats` parses and validates (names against the caller's vocabulary), `rail_stats::display` evaluates (and ports `aggregate`), `rail_store` gives `Totals::sums()` / `HeroTotal::sums()` (all-in EV). The web: `lib/stats/display.ts` + `definitions.ts` (a checked copy of the file); text is `Intl.NumberFormat`'s rounding (shortest decimal, half away from zero), not `toFixed`. Parity over 558 corpus groups, 600 synthetic totals, 33 formulas and 5 000 format cases: Rust = TypeScript bit for bit, and 33 582 values = `rates()`, 26 405 texts = `Intl`. `/stats` tiles now print `(made * 100) / n` like the breakdown (they printed `(made / n) * 100`: "28.7" vs "28.8" at 23 of 80); `HudGrid` reads `STANDARD_STATS`. Guideline §14 enforced by a source scan with a shrinking allow-list. R2.4 "As built". |
| 2026-10-14 | **R2.5 done**: sample reliability. A rate's 95% Wilson interval (z = 1.959964, exact 0 / 100 at the edges, bounds at the definition's decimals), a level for every value (`ok` from `sample.min` = R2.4's `full`, `low` from a quarter, `insufficient` below) and a continuous opacity (`0.6 + 0.4 * sqrt(sample / min)`, 1 from `min`); no interval for bb/100 (no per-hand variance is stored) or AF. One rule, code: `rail_stats::reliability` + `DisplayStat::reliability`, `lib/stats/reliability.ts` + `statReliability`; `JsNumber::sqrt` (correctly rounded). Schema caps `sample.min` at 10^9 (Rust, TS and ajv refuse more). Parity over display-vectors' 1 158 cases x 32 statistics (20 677 intervals), 3 041 Wilson edge/random cases, 2 168 level cases, 3 921 `Math.sqrt` cases: Rust = TypeScript bit for bit; intervals within 1e-9 of `reports.ts`'s textbook Wilson. `/stats`: `uncertainty.ts` removed; tiles take the shared level (band colour, tooltip) instead of ±2 / ±6 points and a continuous opacity instead of three steps; tooltips "n = …, 95% CI a–b". R2.5 "As built". |
| 2026-10-14 | **R2.6 done**: the shared UI package `packages/ui` (`@rail/ui`), source consumed by both surfaces through `file:../packages/ui` (no build step; R0.14's root workspaces still deferred). Moved with `git mv`, imports rewritten only: the token layer (the app's R1.1 copy deleted, both surfaces import `@rail/ui/tokens/*`), the web's replayer (23 modules + `replayer.css`), `PlayingCard` + `cards.css`, `Overlay` + `overlay.css`, `Icon`, `StatTile` (its rules out of `stats.css` into `stat-tile.css`), the base controls (`.muted`, `.btn`, `.icon`, `.chip-btn`: `app.css` split into the web's `layout.css` + the package's `styles/controls.css`, `@import`ed in their old order) and the app's `Dialog`. New: `Chip` (the web's filter bar uses it), `FilterChips`, `StatTable` (rows of R2.4 `Shown` with R2.5 reliability), the `CommandPalette` shell, `DataSource` (`hand(id)`, `useHand`; the web's implementation over `getHand`, not mounted yet), `UiStrings` (the package holds no copy; the web mounts slices of its dictionaries in `I18nProvider`; new `stats.table` strings). The package reaches outside itself only through `model/` (re-exports of the web's framework-free `lib/{phf/types,replay,cards}` and the stats display types); its ESLint forbids Next, Supabase, Tauri and bare literals. Web: `transpilePackages`, React types pinned by `paths`, the repository as Turbopack's root in `next dev` only (production build and tracing root unchanged), Vercel root directory still `frontend` (needs "Include files outside the root directory", on by default). App: same `paths`, Vite `dedupe` + `fs.allow`. **No visual change**: 285 of 288 screenshots pixel-identical across two runs of each build, the other 3 within the sticky header's backdrop blur (at most 70 px, channel deltas 1-11, the same noise seen within one build); every DOM equal up to class whitespace; every cascade equal apart from the tile rules now loading with `StatTile`; stat tiles 72 / 72 identical; the app's bundle byte-identical. New CI job `ui` (ESLint, stylelint, tsc). For R2.7: see *As built* (strings, `get_hand` command, the app's stricter TS flags vs the moved code). |
| 2026-10-14 | **R2.7a done** (R2.7 split by the orchestrator: a = Hands, b = Today + Reports, c = Players + `players`): the desktop Hands screen. `rail-store` migration 7: `hand_list` (one narrow row per `hand_stats` row - hero position, cards, net, stack, board, all-in, showdown, pot type, symbol, the room's hand number, segment; `WITHOUT ROWID` keyed by (`played_at`, `hand_key`), the list's order; written with the statistics rows, deleted with them by a trigger, checked against them after every store test and every crash-test kill), `hand_notes` / `hand_tags` (local only, no foreign key; sync later), `saved_filters`; a version-6 store rebuilds its statistics once to fill the list (0.25 s open, 498k hands in 114 s in the background). `rail_store::hand_list`: keyset pages with every filter (room, format, variant, limit, table size, stake as segment ids; position, pot, result, stack, all-in; notes and tags driven from their tables; date range), chip counts with each group's own selection left out (one pass, counted in Rust, cached until the next commit), go to hand, notes, tags, saved filters. At 497 809 generated hands under load: first page 0.7-1.3 ms for most filters, 14-35 ms for rare ones and a full scan, chip counts 205 ms then ~1 ms per click. Thin async Tauri commands (`hands.rs`). Screen: virtualised list (fixed rows, ~30 in the DOM), filter chips in one row with counts and saved filters, the shared replayer beside the list via `useHand` over a Tauri `DataSource`, tags and a note per hand, "Open on the web" placeholder, `#/hands/<key>`; ARIA grid with a roving row (Up/Down, Enter into the replayer's keys); Cmd/Ctrl + K: a hand by number, the screens. The replayer's `en` / `hr` dictionaries moved into `packages/ui/strings/` (the web's namespace files re-export them), `FilterChips` got a `detail`; the web unchanged - 288 / 288 screenshots and every DOM identical, one CSS module block in another place in its chunk. App: `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` off (the shared code's 87 errors), Inter bundled with its OFL licence. Checked in a browser against a mocked IPC with made-up hands. |
| 2026-10-14 | **R2.7b done**: the desktop Today and Reports screens. `rail-store` migration 8: `hand_list` gains `kind`, `hero_wtsd`, `currency`, `minor_units` (written by the rebuild the migration starts: 500k in 100 s); `rail_store::report` - the win-rate graph from one scan of the list (`ntile` as `stats_graph`, total / showdown / non-showdown / all-in EV in big blinds and money, the web's money refusals), sessions by `stats_sessions`' 30-minute rule (refused per session), breakdowns by pot type, stack band, starting hand, players and street from one pass over the hero's seat rows, both cached until a commit; `HeroSum`. Commands `stat_definitions`, `report`, `report_breakdowns`, `today` (R2.4 `Shown` with R2.5 reliability), saved filters per screen. Today: the current session's result (money and bb), hands, hands per hour, tables, key statistics, biggest pots into Hands, then the import status. Reports: the filter row with its own saved filters (opens on the biggest format of a mixed store, as the web), summary, the graph in bb or money, every statistic by group, ten breakdown tabs with the 13 x 13 grid; palette entries. The web's `WinrateGraph` and `chartScale` moved to `packages/ui` with their sheet, the tile / table / graph words to `packages/ui/strings/stats.*`; web unchanged - 288 / 288 screenshots and every DOM identical, the graph's markup byte-identical and 84 / 84 pixel-identical inside each build's `/stats`, cascades equal but for the graph's own sheet. Parity with the web over the corpus (the web's SQL restated in TypeScript over the TypeScript rows): 288 statistics, 3 677 graph buckets, 1 967 breakdown rows and 193 sessions equal. At 500k: Reports opens in 0.11-0.5 s (1.8 s cold), a situation tab 0.4-1.6 s first; at 1M a situation tab and a cold open exceed the 1 s target (notes for R2.9). Checked in a browser against a mocked IPC with made-up data. |
| 2026-10-14 | **R2.7c done**: the desktop Players screen. `rail-store` migration 9: `players` + `player_labels` (colour from six, note, labels - the web's `player_notes` limits; local only, sync with the web is R4.x), `player_summary` (per named opponent: hands, first/last seen, hands together and the hero's result in bb, cash and chips apart; summed at import with the rollups), `player_hidden` (opaque-id rows counted, not listed), `player_hands` (an opponent's seat rows by name, written by the background pass after the import - written by the import it cost 5 % of the import's rate, as shipped -1.0 %, gate green); a version-8 store opens in 0.2 s and rebuilds in the background. Opaque-id names are never listed and take no notes (the web's rule; session-scoped notes considered and rejected), the store refuses the write. `rail_store::players`: the list (prefix search in any case, kind, room, colour, label, note; most hands together first; the web's money refusal), a profile (rollups, summary, words), positions from the seat rows; `HandFilter::player` for "hands with this player". At 500k with renamed players (70 948 opponents): the list 0.3-0.4 ms (30 ms first after a commit; 371k padded: 173 ms first, 7 ms), a profile <1 ms, by position 1-12 ms, hands with a player first page 3.5-17.5 ms. `import_bench --rename-players` (per-copy villain names). Commands in `players.rs`; screen with list, filters, profile (statistics with reliability, breakdown by position/stake/table/game, colour radio group, labels, note), Hands' player chip, palette search; `--player-tag-*` tokens over semantic hues; `en` + `hr`. Checked in a browser against a mocked IPC with made-up players. |
| 2026-10-14 | **Import writer, second pass** (R2.7c "As built"; on R2.7c's PR, whose CI import benchmark failed at 44 % against its 45 % gate). Profiled: the import threads spent ~15 % of their time blocked waiting for their own commits, so at most three batches were ever queued and the writer committed ~5 500 transactions of ~18 hands per 100k (44 pages of 16 KiB each; 3.8 GiB of WAL for a 396 MiB store; commit + auto-checkpoint ~47 % of its busy time). Now: `FileReader::start` queues a one-batch read with the writer (`WriterHandle::queue`) and a committer thread waits for the commits in order and answers the coordinator (a file stays in flight until then; a moved offset still retries as the same look); the writer holds a group of queued batches open for up to 5 ms once a second one is waiting (`GROUP_LINGER`; waited-for batches commit at once); the write connection gets a 16 MiB page cache and a checkpoint every 4 096 pages; migration 10 drops `hands_played_at_idx`, which nothing read. Writer alone (`import_bench --writer-only 4`, new): 51.1 -> 43.6 us a hand. Pipeline, 3 threads, M2 Pro: efficiency 51-52 % -> 59-60 %; CI 55 / 58 / 54 % (best 58 %) with the pipelining alone, 53 / 62 / 54 % (best 62 %) with all of it (was 43 / 41 / 44 %). Not taken (measured): foreign keys off, dropping indexes that have readers, a 20 ms linger. The gate stays at 45 % with 3 threads on the 3-core runner (stricter than the app's cores - 1; documented). No change to what is stored or derived, nor to crash safety. |
| 2026-10-14 | **R2.8 done**: polish of the desktop screens. **Command palette** complete in `packages/ui` (labelled groups, ↑/↓, Tab and Page keys inside the field, Escape with text typed, matched letters marked, item shortcuts, key hints, live count) with a new fuzzy ranker (`palette/fuzzy.ts`); the app lists screens (Cmd/Ctrl + 1-6), hands, players, reports, saved filters of Hands and Reports (applied to an open screen too), Settings sections (the refused hands among them) and commands (pause/resume import, sync now, theme, density, language), with five recent choices. **Theme and density**: `settings.json` gains `density` and `locale` (`set_density`, `set_locale`); `lib/appearance.ts` paints `data-theme` / `data-density` / `lang` and keeps a copy that `public/appearance.js` applies before the first paint; `packages/ui/tokens/density.css` (app only; `StatTable` falls back to its old values); the Hands list and the Players grid read the row height back from CSS. **i18n**: Croatian complete in the web's register with the shared `plural`, counts passed as numbers, every `Intl` formatter live in the chosen language (en-GB / hr-HR), the tray follows; the app's ESLint rule extended to expression children, conditionals, templates and the app's text props (9 / 9 probes caught, 0 in the app); `tests/test/appI18n.test.ts`. **From R2.7**: the Players table virtualised as a keyboard grid, the profile's own game kind; one loading / empty / error component; selected rows as a tint (the solid plate fell to 1.4:1 in light). **Contrast** (the web's sweep, both themes, five screens): 0 failures beyond the sweep's known exemptions after the fixes, among them the felt's money in light (`--felt-money`, app only). **Web unchanged**: 288 / 288 screenshots, 192 / 192 DOMs, cascades equal but for `--felt-money`; `screens.mjs`'s sheet captures repaired. Checked in a browser against a mocked IPC with made-up data, 2 themes x 2 densities x 2 languages. No core crate changed. |
| 2026-10-14 | **R2.9 done**: the 1M benchmark store and the performance gate. Dataset: `import_bench/dataset.rs` gains `--spread` (copy *c* played 7 x *c* days earlier, every date moved in the room's calendar, checked per template: 381 of 431 shift) on top of fresh ids and villain names - 982 408 hands stored, 76 128 named opponents, 978 hero hands on the median hand's day (was ~50 real days' worth); generated, deleted, never committed. New `core/rail-watch/examples/perf_gate` (import through the watcher, the background pass, the HUD delay on 1 and 12 live tables, every screen's store calls warm and cold without `sudo`, the start's warm-up; M2-normalised budgets, `--gate`, JSON/markdown). On the M2 Pro at 1M: import 10-12k hands/s, HUD delay p95 0.51-0.56 s, the HUD's lookup 0.07 ms - met; a breakdown tab's first click 1.25-1.29 s -> 0.49-0.60 s and Reports 0.53-0.57 -> 0.29-0.33 s (four-connection breakdowns pass, sparse sums, Reports' two passes at once, and `.cargo/config.toml` turning off the bundled SQLite's global page-cache and memory-statistics mutexes, which made a process's read connections take turns - the import unchanged in an interleaved A/B), the screens after the start's background warm-up (1.4-1.6 s on a cold store) 0.06-0.86 s - met; Reports on a cold store within the warm-up's first ~1.5 s still 2.5-3.6 s (not met; the EV adjustment's random reads, a later `hand_list` column). No schema or statistics change. Nightly workflow `perf-nightly.yml` (cron + dispatch + the `perf` label; full 1M on ubuntu-latest; artifact). Supabase, measured on an isolated local stack: the web's reports over 1M hands of one user take 5-10 s, `stats_opponents` 22-44 s - `player_stats`, a hero rollup and a covering index recommended (prototypes: 0.2-60 ms), not built. |
| 2026-10-14 | **R2.10 done**: custom statistics. `rail_stats::events` exports per-seat decision events from the counters' own context (42 fields: the hand, the seat, the decision - street, position, facing none/limp/bet/raise, raise level, action, all-in, sizes in thousandths of a bb and of the pot, stacks, position in the hand, multiway, initiative, the cbet chain, the steal; `EVENTS_VERSION` `events/1`); `rail_config::stats::predicate` parses a counter as `first`/`any`/`each` opportunity `=>` action, errors with byte spans, bounded like R2.4's formulas; `rail_stats::custom` evaluates it and validates and compiles a user's definitions (R2.4 `StatDef` + predicate; counters `<id>` / `<id>_opp` readable by formulas through `Variable::Custom`; shipped values unchanged). **Acceptance**: 57 predicates re-express the standard set and equal the coded counters on every one of the corpus's 51 464 rows (8 422 hands), legs included; the showdown family differs on 12 rows, seats with no decision at all (all in by a blind or the antes), which the language cannot see - documented in STATS-SPEC §14.4. Store migration 11 (`custom_stats` in the user's store, `custom_hero_rows`, `custom_hero_rollups`, `custom_player_rollups`; tested from every earlier version): counted by the background pass from the stored PHF (~26k hands/s on one thread), not at import - events + 57 predicates cost ~14 µs a hand on the import threads but the writes would land in the writer, the pipeline's bottleneck; import gate unchanged (58 %, gate 45 %). A rebuild of the coded statistics recounts them; a changed predicate recounts only its statistic. App: `custom_stats_list` / `_check` / `_save` / `_delete`, the definitions API and Reports' summary include them. Editor in Settings ("Your statistics"): code fields with errors underlined in place, a live preview on the last 5 000 hero hands, labels, format, bands, minimum sample, examples and the field reference; Reports lists them in their group; `en` + `hr`; checked in a browser against a mocked IPC with made-up data. |
| 2026-10-14 | **R2.11 done, Phase 2's steps complete**: targeted recompute. `rail_store::recompute`: the dependency map as data (`DEPENDENCIES`: a definition's display fields and formulas recompute nothing, a custom predicate that statistic, `EVENTS_VERSION` the custom counts, `STATS_VERSION` the rows job, the new `rail_stats::SEGMENT_VERSION` the segments job, `EV_VERSION` the EV job - each with every table it writes; a test holds it to the schema and checks every unnamed table is untouched). The rows job derives every hand from its PHF and compares, stages only the hands that differ and sums every hand into twins of the rollups and the Players list's lines; the segments job regroups the stored seat rows without deriving; the EV job evaluates every hero hand beside the stored rows; each ends with one swap (staged rows written in place, twins renamed into place, `stats.epoch` moved on). Readers never see half of it: every `Reader::with` is one read transaction, multi-connection answers check the epoch (`Reader::same_epoch`), the reports read EV rows of any version until the swap - a test runs the screens' and the HUD's reads during both jobs. Hands keep their `hand_stats.id`: custom counts survive unless a seat moves between rollup keys. Store migration 12 (work tables), tested from every earlier version; resumable, paused for backfills and open tables; progress on Reports, Hands, Players and Settings, `stats-changed` to re-read after a swap. New crash test: killed between and inside pages and inside both swaps, always the old statistics or the new, resumes. At 500k (vs staging's full rebuild, 84.3 s with the players' index and one custom statistic): segments 28.2 s, "rebuild statistics" 36.1 s, a counter on 250k hands 46.4 s (swap 4.1 s), an EV bump ~367 s vs ~397 s (preflop enumeration dominates). Phase 2 summary in the R2.11 section: the 1M targets hold warm on the M2 Pro; the cold-start Reports case and a Windows laptop's numbers remain. |
| 2026-10-14 | **R3.0 done (signed by the owner on 2026-10-14, merged in #187)**: the HUD compliance check. Every `sites.json` entry's `hud` block from the room's own page, read 2026-10-14, with quotes, URLs, live files, names and confidence in `docs/research/HUD-POLICIES.md`, plus the per-release re-check checklist. **Allowed (3)**: PokerStars (with its Reference Guide's HUD restrictions), Winamax, ACR (own hands, nothing from the hand in play, no overlap of ACR's graphics). **Prohibited or unusable (15)**: GGPoker, partypoker, Unibet, CoinPoker, WPT Global by policy; Ignition (anonymous), PokerBros (no desktop client), the closed rooms, `standard`. **Unknown (4)**: 888poker, iPoker, Chico, WePlay. No network split (no skin's own page allows a HUD). `ignition.operating` true, `partypoker.files.live` false. Test `hud_policies_are_the_signed_list` pins (id, allowed, source) and `hud_permitted()` = PokerStars, Winamax, ACR; the ajv test pins the same list. README §6 and guideline Appendix A from it. Flagged: GG SEP 7.2 on third-party import. |
| 2026-10-14 | **R3.1 done**: the table simulator `hud/rail-hud-sim` (A8). Windows titled like PokerStars, Winamax or ACR tables (winit =0.30.13 + softbuffer =0.4.8, CPU-drawn: felt, seats with names and stacks, button, board, "RAIL TABLE SIMULATOR - not a poker client"; no GPU, so it runs on CI runners; 4.8 MB release on macOS) at the room's sizes, writing real corpus hands (104 PokerStars, 34 Winamax, 6 ACR era-C) into its own folder at play speed: fresh ids, the table's name, the current time, seats rotated so the hero keeps one seat, one cast of players per table, a hero added to hero-less fixtures with a `Dealt to` line; every hand read back with the room's parser before it is written. Per-room title, file-name, encoding and separator formats in `rooms.json`, each tagged sourced / partly sourced / invented (all titles invented); a test-only title regex generated from the title template. Controls: flags, stdin / `--script` commands (move, resize, minimise, restore, table move, open, close, speed, pause, status), keys; JSON-line events. Tests: 20 unit + headless smoke (3 tables, 20 hands per room, read back through `rail_core::convert`) on three OSes; CI's `core` job runs it with windows on macOS and Windows. End to end (`examples/e2e.rs`, watcher + store + `hud_totals`, M2 Pro, debug): p50 512-516 ms, p95 <= 523 ms, max 554 ms with 12 windowed tables; < 1 s holds, the 500 ms quiet period is the floor (R1.3). R3.1 "As built" has notes for R3.2-R3.7 and R3.11-R3.14. |
| 2026-10-14 | **Fix: a folder's path change raced its reads** (R1.5 "Edit path", R1.6 / "Import writer, second pass"). `a_folder_path_changes_and_continues_where_it_stopped` failed on macOS CI (PR #188) with `(moved, detached, marked) = (0, 2, 1)`, expected `(0, 1, 1)`: at the second change the folder had **two** file rows - the new path's at 13 037 bytes and `old/table.txt` again at 6 601, the whole file. Cause, a product bug (the "known gap" R1.5 documented, worse than described): `Watcher::set_source_path` moved the rows in the store while the coordinator still had the old path until its reload, so a read of the old path dispatched around the move (the 1 s re-walk after the watch is set, a late FSEvents notification or a recheck) looked the file up after its row had moved, found none, read it whole from 0 and committed a new row under the folder; its answer came after the reload had dropped the old files, so no `Imported` event showed it. Hands deduped, but the folder counted a file too many, the file was read twice, and the next change detached it. Fix (`rail-watch`, no store or parsing change): `set_source_path` and `set_source_site_override` first **fence** the folder - a `Fence` command makes the coordinator dispatch none of its files (they stay queued) and answer once none is in flight (`in_flight` now keeps each read's folder; a read is in flight until its commit is answered, so nothing of it is left with the writer) - then change the store, mark, reload, and the dropped guard sends `Unfence` after the `Reload`. The offsets the move compares are final, and the override's reset can no longer meet a batch read with the old room. A deterministic unit test drives the coordinator by hand (`a_fenced_folder_starts_no_read_and_is_answered_after_its_reads`: nothing of the folder dispatched while fenced, the fence answered only after the read in flight answers, other folders read on, two fences need two `Unfence`); the watcher tests take `RAIL_WATCH_THREADS`. Stress, the path-change test 100 times each with 20 copies running at once on a 10-core Mac: before 5 / 7 / 1 failures with 1 / 2 / 8 import threads (all `(0, 2, 1)`), after 0 / 0 / 0; 50 runs one at a time and the room-override test 60 times under the same load: 0 failures. |
| 2026-10-15 | **R3.2 done**: the HUD process and IPC. `hud/rail-hud` is its own process, the app's Tauri sidecar (`bundle.externalBin` in `app/src-tauri/tauri.hud.conf.json`, `npm run hud:sidecar`; CI's `app` job bundles it and checks it is in the `.app` and the NSIS installer), started with `std::process::Command` from beside the app's executable and supervised by `rail_hud_ipc::supervisor`: a fresh 256-bit token per process on its standard input, `health` every 2 s, no answer for 10 s / exit / disconnect -> killed and restarted with a backoff 0.5 s -> 30 s, `shutdown` + stdin closed on exit (it also exits when the app is gone). New crate `hud/rail-hud-ipc`: protocol 1 (the plan's messages plus `stats_changed`, `policy`, `resync`, `shutdown`, `tables_open`, `attach_refused`, `table_updated`; unknown types and fields tolerated), 4-byte length + JSON frames (1 MiB, 1 KiB before authentication), a Unix socket in a `0700` folder (`0600`) or a named pipe with an owner-and-SYSTEM DACL (`interprocess` =2.4.5), a mutual HMAC-SHA256 handshake, links whose sends never block. The app: imports feed `hand_imported` from a thread of its own (new `Reader::newest_hands_of_file`), recompute swaps `stats_changed`, `tables_open` pauses the stats pass and slows sync. The HUD: the store read-only (new `Reader::data_version` keeps it current without messages), compliance mode in the process (shipped + remote merge, `hud_permitted()`, refusals reported once, a stricter policy detaching), the platform trait (`find_tables`, `track`, `poll_events`, `overlay`) with Windows / macOS stubs and a fake backend driven by `rail-hud-sim`'s events. Headless end to end in CI: hand in file -> HUD re-read p50 515 ms (12 tables 513; the watcher's quiet period), inside the HUD 0.24-0.28 ms; a prohibited and an unknown room refused with nothing read. |
| 2026-10-15 | **Fix: the other folder settings raced their reads too** (follow-up to the 2026-10-14 path-change fix; R1.5, R1.6). Each method that changes a folder was checked for a read in flight going wrong across it. **Fenced now** (`Watcher::change_fenced`: fence, store change, reload, unfence): `remove_source` - a batch after the delete named the gone folder (`FOREIGN KEY constraint failed`, a `FileError`, the read lost) or, since SQLite gives the next folder the removed one's id when it was the highest, joined a folder added right after with the old folder's file and hands; `set_source_enabled(false)` - the folder's reads committed after it showed disabled (a large read to the end of its file); `set_source_recursive(false)` - a subfolder file being read was read on; `add_source_with` with a room for a folder already there - files outside the room's glob were read on. **Held**: a folder being added with a room or "only new" is in the store before its room and marks, and a reload already on its way (the one `start` sends, another folder's) could load and read it in between - seen once in the stress below as 9 old hands in `only_new_hands_and_a_rooms_files`; `HoldNew` / `ReleaseNew` fence every folder a reload loads for the first time until the reload after the setup. **Not fenced** (comments in the code): `set_source_poll_only` (only how changes are noticed; tracked files and backfill kept), enabling and subfolders on (every read in flight is of a file still covered, read as before), `retry_refused` (a batch from the old offset is refused and read again from 0; `FileRt::reset`). A fence also stops a large read of its folder after the group it is committing (`ImportLimits::stop_folder`, checked between groups like the pause), so a click waits for one group, not a whole file - path and room changes included. Tests: deterministic coordinator tests per change (`a_removed_folder_is_fenced_until_its_reads_answer`, `a_disabled_folder_is_fenced_until_its_reads_answer`, `subfolders_switched_off_are_fenced_until_their_reads_answer`, `a_room_given_to_a_folder_is_fenced_until_its_reads_answer`, `a_folder_being_added_is_held_until_it_is_set_up`; the old fence test checks the stop), `large_read.rs::a_stopped_folder_stops_its_large_read_between_batches`, and four watcher tests that change a folder in the middle of a 4 MB backfill and assert nothing more is stored once the call returns (`fill` moved to `tests/common`). Stress on the 10-core Mac with the flop library running (6 solves), 100 runs, 20 at once, of those four plus the four existing affected tests (disable/remove, recursive, poll-only, only-new): before, 100 / 100 / 100 runs failed with 1 / 2 / 8 import threads (disable 89 / 94 / 96, remove 73 / 77 / 87, subfolders 91 / 92 / 97, room 93 / 91 / 94; the existing tests 0 / 1 / 0); after, 0 / 0 / 0; the path-change and room-override tests 100 runs each at 1 / 2 / 8 threads: 0 / 0 / 0. No store or parsing change. |
| 2026-10-15 | **R3.3 done**: Windows finds tables. `platform::windows::find_tables`: `EnumWindows` over visible top-level windows, `GetWindowTextW`, class, the owning process (`GetWindowThreadProcessId` -> `QueryFullProcessImageNameW`), minimised and cloaked (`DWMWA_CLOAKED`) kept and marked hidden, the client rect in physical pixels (`GetClientRect` + `ClientToScreen` on a per-monitor-v2 thread; the HUD process sets per-monitor v2 at start), the scale from the monitor's effective dpi (a DPI-unaware client's own `GetDpiForWindow` is 96; both kept for the diagnostic). `windows` =0.61.3 (already locked by Tauri), six API features; the crate is `deny(unsafe_code)` with `forbid` in every other module and each Win32 call wrapped with its own `allow` and `// SAFETY:` comment. Matchers from `sites.json` `tables` (none yet) plus test-only simulator entries (process `rail-hud-sim` only; `rail-hud --standalone --sim-site <id> --sim-title <regex>`); every match returned, compliance refuses. Identity: (room, table name, seats) - the title's `table` group equal to the hand's `Table '...'` name after white-space normalisation, never a prefix; two windows with one name get no hand and say why; seats from a `seats` group or the last hand (`Reader::hand_seats`); the re-find every 500 ms follows retitles (tournament moves), moves, minimise until R3.5's hooks, and an unmatched hand triggers one at once; `health.waiting` counts tables waiting for their first hand. `rail-hud --list-windows` prints each visible window's process, class, redacted title ("Logged in as ..." and the user's names - `--you`, the store's hero names - become `<you>`), client size, dpi and awareness, non-ASCII characters, the room that takes it, and what `--try-title` reads; the owner's capture procedure is `docs/research/CAPTURING-TABLES.md`. `sites.json` `tables` gains `checkedAt`; `verified: true` needs it, an "Observed on" source and a regex. The simulator's `window` event gains `clientX` / `clientY`. Windows CI test (`hud/rail-hud/tests/windows_tables.rs`): three simulator windows found exactly, names, rects and scale checked against the simulator, minimise and table move followed, `--list-windows` redacted, the HUD attaching (PokerStars) and refusing (GGPoker). No real room has a `tables` block yet: nothing real is attached. |
| 2026-10-15 | **R3.4 done**: Windows overlays. One `WS_POPUP` per table with `WS_EX_LAYERED \| WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE`, **owned by the table window** (above it, hidden while it is minimised, gone with it), exactly over its client rect in physical pixels, from a per-monitor-v2 thread of its own that never blocks (a cross-process owner ties input state to it); Direct2D (software DC render target) and DirectWrite paint a premultiplied DIB shown with `UpdateLayeredWindow`, alpha 0 outside the panels so clicks reach the table (`HTTRANSPARENT` too, `MA_NOACTIVATE`); hidden while minimised or cloaked; repainted only when the frame, size or scale changes, moved without a repaint. Panels: the six shipped `hud: panel` statistics with R2.4 bands (blue / white / orange on near-black) and R2.5 dimming, and the hand count, at the seats of a default layout - the simulator's geometry (`layout.rs`), next to each seat's plate, clear of plates, board and each other at every usual size and scale - "waiting for first hand" as a pill. `hand_imported` players carry `seat` and `hero` (from `seat_stats`). **Restrictions as data**: `sites.json` `hud.restrictions` (11 fields; schema, validator - required when allowed -, merge that only adds), PokerStars / ACR / Winamax from R3.0's pages; every frame carries compliance's `Permit` (asked again before each draw, checked against the window's room by the backend) and the renderer enforces the room's restrictions on any design (two thresholds, no card-split or switching statistics, no labels, nothing over table graphics); the default design complies with all of them at once. Windows CI test (`tests/windows_overlay.rs`): ownership, styles, rect, panels at the seats (surface and screen pixels), click-through, minimise / restore / move, dedupe, refusals, and the HUD process drawing on an allowed room and making no overlay window on a prohibited one; `twelve_tables_perf` on 12 tables in CI: a paint p50 2.1 ms, p95 4.0 ms (budget 16 ms), idle overlays 0 ms CPU over 10 s, the HUD process attached to 12 tables 0.46 % of one core. |
| 2026-10-15 | **R3.5 done**: Windows tracking. `SetWinEventHook` **out of context** (`WINEVENT_OUTOFCONTEXT \| WINEVENT_SKIPOWNPROCESS`), **scoped to each tracked table's process** (one set per poker process, undone when the find sees it with no tracked table and no visible window), six hooks for exactly twelve events - foreground, move/size start and end, minimise start and end, destroy, show, hide, location change, name change, cloaked, uncloaked - for the window object only (`OBJID_WINDOW`, `CHILDID_SELF`); feature `Win32_UI_Accessibility`, no new crate. **On the overlay thread** (an out-of-context hook calls back on the thread that set it, which must pump and never block; only the overlay window's own thread moves it without a hop): the callback only filters and notes, the thread reads each noted table once and moves its overlay at once (no repaint), repaints at a new size or **monitor scale**, hides it while minimised / cloaked; the engine gets the latest per table (`platform::tracking`: a drag's hundred locations are one `Moved`), a new title through the room's own matcher (`Retitled` with the hands' table name: a tournament move at once), `Closed` for destroyed or hidden tables, and the new `TableEvent::Appeared` (a followed process showed a window: find now). **No fight with the 500 ms re-find**: an overlay is always placed from the table as it is at that moment, never from a description; the engine's `follow` with something the hooks did not report makes the thread look again. Z-order checked on foreground (`restacked`); overlays destroyed with their tables' process are noticed through their own `WM_DESTROY`. DPI: the overlay's `WM_DPICHANGED` and every location re-read the monitor's scale; no dpi change is possible on the CI runner, the scale logic is unit-tested. Tests: `platform::tracking` (6, every OS), `engine::hook_events_between_finds`, Windows CI `tests/windows_tracking.rs` - scripted `SetWindowPos` moves, the simulator's move / resize / minimise / restore / table move / close, a hidden and shown table, 100 moves in 1 s, the process killed, in the backend; the extended `scripts/tracking.txt` and a 100-move drag through the `rail-hud` process. Measured on the CI runner: table moved -> overlay moved p50 101 µs / p95 125 µs (40 moves), through the `rail-hud` process 100 moves in 1 s p50 58 µs / p95 120 µs with 15 ms of CPU and no backward move; table move seen in 2.3 ms; a killed client's overlays gone in 1.4 ms. |
| 2026-10-15 | **R3.6 done**: seats and layouts. A hand's seat becomes a **slot** (the place on the screen) of the room's layout for the table size: `sites.json` `tables.seatLayouts` is now per size `{seats, plate, center, heroSlot, graphics, seatNumbers}` in thousandths of the client rect (schema `$defs.seatLayout`, validator checks), `null` for every room until measured (`CAPTURING-TABLES.md` "Seat layouts"; R3.14) - meanwhile `TableLayout::simulator`, the simulator's geometry. **Preferred seat**: a rotating client's seat `s` is at `(slot(s) - slot(hero) + heroSlot) mod size` (`seats::slot_of`), on when the user says so (`hud_room_settings`, the app's `hud_set_preferred_seat`), else `tables.preferredSeat` (`null` everywhere), else off; the hero's seat from each hand, kept while not dealt in, none for an observer, forgotten on a table move; a seat past the window's size lays out on the size that has it (9-max -> 6-max), heads-up two slots. **Drag**: the Windows overlay thread takes its own mouse messages (press on a panel -> `SetCapture`, moves past 4 px repaint the panel where the scene allows it, release or lost capture drops it), keeps the drop until the engine's frame has it (`Seating::drags_seen`) and reports `TableEvent::PanelMoved`; the engine redraws every table of that room and size and sends the new `seat_position_changed {site, size, slot, x, y}`; the app's thread writes **migration 13** (`hud_seat_positions` per (room, size, slot), `hud_room_settings`), which the read-only HUD reads at start and on `layout_changed` / `settings_changed`; not synced yet (R3.9 / R4.x). On `noOverlapTableGraphics` (ACR) a dragged panel goes to the nearest place clear of the layout's graphics (`layout::constrain`); a remote `sites.json` can only add graphics zones (union per size; a shrunk or dropped zone keeps the shipped one) and only narrow a room's process names (never another entry's), so table data cannot loosen compliance. Where a panel is never changes what it shows (PokerStars: no display switching by position, stack or opponent; no per-position stat sets). Tests on all OSes (every size x hero seat x rotation equal to the simulator's drawing, observer, size change, measured layouts, constrain, drag, the engine with a real store) and Windows CI `windows_seats.rs` (panels at the simulator's drawn seats with `--preferred-seat` off and on, its hero frame read off the screen; a posted-message drag kept off the graphics posing as ACR, where dropped posing as PokerStars; the HUD process: drag -> `seat_position_changed` -> store -> restart restores it). |
| 2026-10-15 | **R3.7 done**: the HUD data path. A table's players are read over **the table's segment** (its hand's: `Reader::hud_hand`), opaque-id villains under the session scope the store wrote. **`ownHandsOnly`** (PokerStars, Winamax, ACR): store migration 14 adds `player_rollups_observed` - the part of `player_rollups` from hands without a hero seat, written by the same `Pending` in the hand's transaction (nothing more for a played hand), a fifth summed table with its recompute twin - and `custom_player_rollups_observed`; the HUD reads rollups less that part (`Reader::hud_own_totals`, `custom_player_totals(.., own_hands_only)`), exact to the counter (a store with an observed and a played hand equals a store of the played hand alone). Migration 14 fills the part from the stored rows in its transaction (`stats::fill_observed`), recounts the user's statistics when observed hands exist, restarts a rows job left running; tested from every version and from a version-13 store with data; R2.11's map gains both tables. Cost: import gate 59-60 % vs staging's 60 % (interleaved, 100k, 3 threads), an all-observed corpus imports at the same rate; HUD lookup at 500k + 300k padded players 88 -> 121 us median (p99 109 -> 154 us). **Nothing from the hand in play**: documented and tested with the real watcher (`tests/in_play.rs`); found that R1.3's assumption is load-bearing (a PokerStars prefix cut at the flop validates: a room stalling mid-hand > 500 ms would get it stored) - R3.14 checks the real clients. **Restart**: a window with no announced hand starts from its table's newest stored hand played and imported in the last 15 min (`Reader::latest_hand_of_table`, `hands_imported_at_idx`, no sort); e2e kills the HUD and the new process shows every table at once. The user's statistics in a design (`PanelStats::with_custom`, `Hud::set_design`). **Latency chain** per hand - watcher notice (`WatchEvent::Imported.noticed_ms`) -> import -> sent (`hand_imported.timing`) -> arrived -> re-read -> frame (`table_updated.chain`, `--latency-report` JSON lines, a debug build's line on the table, never in release): 12 tables, 96 hands, debug, M2 Pro: **p50 506 ms, p95 521 ms** (503 ms of it the quiet period; re-read 0.8 ms, frame 0.4 ms); the e2e asserts p95 < 1 s. `stats_changed` re-read after a swap and the recompute pause while tables are open verified by tests. |
| 2026-10-19 | **R3.8 done**: panel and popup. **Panel**: the six definitions and the hand count as before, plus a **legend** pill in a free corner (clear of the table's graphics, the panels and the debug line) with one sign per colour in use after the room's collapse (`-` `=` `+` on every allowed room with the default design; PokerStars at most two thresholds whatever the design), and - **only where the room allows labelling players (Winamax; never PokerStars or ACR, `noPlayerLabels`)** - the user's colour tag (a bright bar, contrast on any felt), a note mark and labels, read by `Reader::player_notes`, never for the hero or an opaque-id seat. **Click**: a press that never passed the drag threshold and was released over the overlay is `PanelClicked`; the engine sends `open_popup {site, storeSite, table, player, segment, slot, anchor, scale}`. **Popup**: one Tauri webview window of the app's (`hud-popup-<n>`, `#/hud-popup`, `packages/ui` tables), placed beside the panel in the monitor's work area, reused for another panel, closed by the same panel, Esc, its button, losing the keyboard, the pointer leaving or the last table closing; built hidden and unfocused so the table keeps the keyboard (`SW_SHOWNOACTIVATE` on Windows; macOS not wired). It reads what the panel reads (the table's segment, own hands only) through the app: grouped statistics of `players: any` definitions (no money), thresholds in words, hands together and your result (bb, cash and tournaments apart), **by position only on ACR** (hidden on PokerStars - unclear under "no display changing with game state" - and on Winamax, read as conservatively; `Reader::player_own_positions`), **your words only on Winamax** (on PokerStars and ACR not even the note: a note at the table is a label). **A10**: the app has no analysis/solver/equity/chart screen; `lib/duringPlay.ts` is the gate (every route classified, the shell replaces a helping screen while `tables_open > 0`), and the replayer's pot odds and the 13 x 13 starting-hand chart hide during play. Tests: rail-config, rail-hud (panel, scene, layout, drag, tracking, engine), IPC wire form, rail-store own positions, the app with Tauri's mock runtime (rules per room, popup over a store, the window opened / moved / closed, `open_popup` -> window -> tables' edges), `appDuringPlay.test.ts`; Windows CI `windows_seats.rs` (click vs drag on real windows, tags only posing as Winamax, the HUD process's `open_popup`); the popup page checked in a browser with mocked Tauri calls and made-up data. Found on Windows CI: a hand committed by a recheck after the one before it had no `noticed` stamp (rail-watch now leaves the rest of a commit the latest change noticed), and the app's test binary needs the application manifest (`build.rs` links it into every target on MSVC); the popup test's store folder had the simulator's folder name (the helper's are now `rail-hud-sim-*`, and a wait reports the simulator's stderr and exit status). |
| 2026-10-19 | **R3.9 done**: the HUD editor and presets. **Model** (`rail_hud::design`): a design is ordered panel cells (shipped or the user's statistics; a cell may show only at some stack depths), columns, per-statistic overrides keyed by id (bands, decimals, sample - a layer, never an edit of the definitions), popup sections, legend, the player's words, colour thresholds. **Presets** (`config/hud/presets.json`): cash (R3.4's panel), tournament, Spin - each complying with every allowed room - and "tournament by stack depth", which switches with the stack and so is ACR's only. **Assignments** per (room or every room, size or every size, format or every format): room, then format, then size, else the format's preset. **Restrictions** enforced twice: the editor refuses to save or assign what a room forbids and says why (PokerStars: a card-split statistic, a stack cell, more than two thresholds; Winamax: a stack cell; labels a note on PokerStars and ACR), and the renderer drops it anyway (defence in depth). R2.10's language gains card fields (`cards_known`, `pocket_pair`, `suited`) and `CustomSet::card_split`. **The design travels with the frame** (`OverlayFrame.design`; the Windows overlay keeps none of its own); the engine resolves each table's design from its room, size and format, the legend reads the user's bands, `open_popup` names the design and the popup shows its sections. **Editor** (HUD screen): drag and drop with a keyboard alternative, per-cell settings, popup sections, live room checks, a preview drawn by the HUD's own renderer under the room's rules, reset of dragged panels, the preferred seat, the assignment matrix; en + hr. **Store** migration 15 (designs, assignments, tombstones and dirty marks); **Supabase** `hud_layouts` + `put_hud_layouts` (select-own RLS, definer writer, pgTAP 35; not applied to production); **sync** of all four HUD tables in R1.9's worker (every write wakes it; the HUD rows are pulled every minute, on their own schedule), last writer wins by `updated_at`. Tests: rail-stats, rail-store, rail-hud (design, panel, engine), rail-sync, pgTAP, the app; Windows CI `windows_designs.rs` (an assigned design changes what the overlay draws posing as Winamax; a card-split statistic dropped posing as PokerStars); the screen checked in a browser over the app's own commands behind a mocked Tauri bridge with made-up data. |
| 2026-10-19 | **R3.10 done**: compliance mode in the app. **Remote `sites.json`**: the web build publishes `config/sites.json` at `<web>/sites.json` (`frontend/scripts/sites-json.mjs`, `no-cache`), so the repository file is the only source and the owner updates it with a pull request (live with the web deploy = the staging -> main promotion); `rail_sync::policy` fetches it over HTTPS (OS verifier, no redirects, ETag / If-Modified-Since, 10 / 20 s timeouts, 1 MiB cap; HTTP only to loopback), checks it whole with `rail_config::load_remote` (strict schema + validator; no signature - a forged file could only switch a HUD off), merges stricter-only, caches the last good copy atomically, keeps it (or the shipped one) on any failure; first look 5 s after start, then every 6 h (30 min after a failure) and on "Look for an update now". The app's single source (`crate::policy`) feeds the HUD (`rail-hud --policy <cache>` read before the first look for tables; `policy {remote}` on each connection and change), the popup and the editor; a room switched off closes its popup. **Status**: `HealthReport` lists the attached tables and the still-open refused windows with room, table and reason (`serde(default)`, no protocol bump); `hud_status` gives them; the HUD screen's "At the tables" shows the tables with the HUD, the tables without it and why in plain words (prohibited, withdrawn by an update, unknown = no, a network, an unknown site) with the room's policy page and date, "Why can't I enable the HUD here?", the rooms where it may be used and where the list came from; Today has a line, the tray a fourth line; no override anywhere. **A10**: the sidebar and the palette leave out a helping screen while a table is open (`duringPlay.ts` `screenOffered`). **Release checklist**: `npm run hud:policy-check` / the manual workflow `release-checklist.yml` fails on any allowed room checked more than 90 days ago (§12). Tests: rail-sync policy against a local server (stricter applies and is cached, looser ignored with a note, invalid refused whole, failures keep the last good copy, 304, restart), rail-hud (`--policy`, lists), rail-hud-ipc, the app (policy DTO, status lists, tray line), `tests/` (wording, no override, A10 gate, the checklist); Windows CI `windows_compliance.rs`: a table posing as GGPoker refused and listed with its reason, no overlay; posing as PokerStars with a remote copy switching it off refused from the first look, attached under the shipped policy, detached again. The screens checked in a browser with mocked Tauri calls and made-up tables. |
| 2026-10-19 | **R3.11 done**: finding tables on macOS. `platform::macos`: the window server's list (`CGWindowListCopyWindowInfo`, on and off screen, front to back: number, pid, bounds, layer; its window names - Screen Recording - never read) joined with the Accessibility API's windows of the processes a room's matcher takes (executable name from `proc_pidpath`; `AXWindows` -> `AXTitle`, frame, minimised, full screen, subrole, close button; 0.25 s messaging timeout), paired by the window number (`_AXUIElementGetWindow`, looked up with `dlsym`, never linked) else by frame within a point in z-order; client area = bounds less the title bar measured from the close button (32 pt on macOS 26's winit windows); pixels = points x the backing scale of the screen the window overlaps most, exactly winit's physical position; minimised marked, off screen (another Space, full screen, hidden app) = cloaked with the title remembered. objc2 0.3.2 bindings (the line Tauri locks; `objc2-application-services` the one new crate) + `libc`, `unsafe` only in `platform/macos/ffi.rs` with `// SAFETY:` per block. **Permission**: the trait's `permission_needed` / `request_permission`; without Accessibility `find_tables` fails `PermissionNeeded`, the health answer says `permissionNeeded: "accessibility"` (optional field, no protocol bump), and the system's prompt comes only from `request_permission` - the app's "Open System Settings" (`hud_request_permission`, which also opens the Accessibility pane). It is offered only when it would make a difference - a running client of an allowed room with a macOS `tables` block (none today) or the simulator's test entry; otherwise the health answer says `permissionDeferred` and the HUD screen, Today and the tray show "HUD on macOS: no supported poker client running" and ask for nothing (so no Mac user sees the card today). The grant is Rail.app's (the sidecar's responsible process), keyed by its signature: ad-hoc builds need it again after every build, Developer ID releases (P3) keep it. **App**: the HUD screen's card (why - titles and window places only -, what not - no screen recording, input monitoring or control -, the button, waiting, the stale-entry hint, granted), Today's and the tray's line, `en` + `hr`; checked in a browser with mocked calls. **`--list-windows` on macOS** (subrole, px and pt, the scale, Spaces; whether Accessibility is granted, Screen Recording not used), `CAPTURING-TABLES.md` "On macOS". Tests: unit (pixels and points, screens, title bars, pairing, the joined view, the engine's permission path, protocol, app, `tests/`), `tests/macos_tables.rs` on the macOS runner: the simulator's three windows through the window server alone (frames x scale equal to the simulator's, joined into its tables) always, then the backend's own find, minimise, table move, listing and the HUD process with Accessibility, or the permission-needed path without it (the `R3.11:` line says which). Locally only the window-server and permission paths ran (no Accessibility for the agent's shell; nothing changed); the full path is the owner's command `cargo test -p rail-hud --test macos_tables -- --nocapture` with the terminal granted. |
| 2026-10-19 | **R3.12 done**: overlays on macOS. **Threads**: on macOS the HUD process gives the main thread to AppKit - an **accessory** application (no Dock icon, never active, never the keyboard) that pumps its own event queue - and runs the engine unchanged on `rail-hud-engine` beside it (`macos::with_appkit`), as Windows' overlay thread and loop thread; commands over a channel, the main thread woken by a main-queue block (`dispatch2`) posting an application-defined event; Windows and Linux unchanged. **Windows**: one borderless, non-activating, transparent `NSPanel` per table at the normal level, exactly over the client area (pixels back to points, flipped against the main display's height), **ordered directly above the table** (`orderWindow:relativeTo:` its `CGWindowID`) and kept there by looking every 100 ms (a ~20 µs `windowNumberAtPoint` below the overlay per table; the whole order only on suspicion), `MoveToActiveSpace \| Transient \| IgnoresCycle \| FullScreenAuxiliary` (never `CanJoinAllSpaces`), ordered out while the table is minimised, on another Space or hidden. **Click-through with no permission**: the overlay ignores the mouse; a small click window over each panel takes it (press, drag and release routed to it by the window server) - fed to the shared drag code: `PanelMoved`, `PanelClicked` -> `open_popup`. Measured: a layer-backed window that does not ignore the mouse takes presses on its transparent pixels too, so the Windows way (alpha) does not carry over. **Drawing**: the shared scene painted by Core Graphics + Core Text into a premultiplied bitmap at the table's physical pixels, shown as a layer-hosting view's contents at the backing scale; only on change; permit checked before every draw, other rooms' frames refused. No new crate in Cargo.lock (objc2's AppKit, Foundation, Quartz Core, Core Text, `dispatch2` - all locked by Tauri); `unsafe` only in `platform/macos/{appkit,ffi,drive}.rs`. **Tests**: unit (points / pixels at 1x-3x and negative coordinates, the flip on main / right / above displays, mouse points to client pixels, stacking); `tests/macos_overlay.rs` (own `main`): over the simulator's real windows without any permission - exact place in points, directly above the table in the window server's order, click windows, pixels in the bitmap **and on screen**, the window server's hit test (centre -> table, panel -> click window), moves without repaint, raised -> restacked, minimised -> ordered out, restored, removed; synthetic click / drag -> `PanelClicked` / `PanelMoved`; with Accessibility (CI): real clicks (panel -> overlay, centre -> the simulator's new `clicked` event), the HUD process drawing posing as PokerStars and making no window posing as GGPoker, `open_popup` through the supervisor. **Perf** (M2 Pro, 1x, debug): 12 tables, paint p50 0.9 ms / p95 1.2-2.5 ms / max ~8 ms, overlays idle 0.40 % of one core. `CGWindowListCopyWindowInfo(OptionAll)` is not in z-order (R3.11 assumed it); `onscreen_order` is. Limits: geometry from the engine's 500 ms re-find until R3.13; 1x displays only in practice; popup window not wired on macOS. |
| 2026-10-19 | **R3.13 done**: tracking on macOS. **Observers**: an `AXObserver` per poker process with a tracked table on a thread of its own with its own `CFRunLoop` (`rail-hud-ax`; not AppKit's: a busy client's 0.25 s must not stall the overlays) - on the application `AXWindowCreated` (`Appeared`), focused / main window changed, activated, hidden, shown; on each table's window `AXWindowMoved`, `AXWindowResized` (and the generic `AXMoved` / `AXResized`), miniaturised / deminiaturised, destroyed, title changed (`AxNote::effect`, data, unit-tested); made with a process's first table, let go with its last. **Follow first, tell the engine after**: each notification reads the table from the window server (one window, no message to the client; the whole list for an off-screen one - `OptionIncludingWindow` alone omits it, measured; after a move or resize again at 2 - 100 ms until the list shows it - CI found it lagging the notification), the client area exactly as the find computes it (`tracked_geometry`), and hands the AppKit thread the geometry at once (`Link::follow_at`); the engine gets R3.5's coalesced events (`tracking::events`, `Retitled` through the room's matcher) from the merged `Observed`. **No fight**: the AppKit thread places overlays only from the observers' latest reading, never a frame's description; the backend's `follow` with anything else makes the thread re-read (`Resync`); the 500 ms re-find stays as the fallback. **Restack** at once on activation, focus, main window and shown; R3.12's 100 ms stacking look slows to 250 ms when every shown overlay's client is observed. **Spaces**: `NSWorkspace.activeSpaceDidChangeNotification` on the AppKit thread makes the observers re-read every table (hide / show at once; simulated in CI - a runner cannot switch Spaces). **Exits**: a `kqueue` (`NOTE_EXIT`) per observed process removes its overlays at once. **Z-order fix**: R3.11's pairing fallback and ordering read `onscreen_order` (`z_ordered`), never the `OptionAll` list. **Revoked Accessibility**: the engine detaches every table on `PermissionNeeded` (overlays gone, `permission_needed` reported by R3.11's rule). **Popup on macOS**: the app places it in points (anchor / the table's scale, the screen's work area in its points, logical size), shown unfocused (the client keeps the keyboard). No new crate (`block2` 0.6.2 already locked; two lock edges); `unsafe` only in `platform/macos/{observe,appkit,ffi,drive}.rs`. Tests: unit (notifications, geometry, Spaces, z-order, restack interval, merge, revoked permission, popup in points) on every OS; `tests/macos_tracking.rs` on the macOS runner - without permission a wrong description, a simulated Space change, a killed simulator; with Accessibility a 40-move drag (the simulator's own moves), move, resize, minimise / restore, focus, a real click, table move, app hidden / shown, 100 moves in 1 s, close, and the HUD process with `scripts/tracking.txt`; measurements in the step's `R3.13` lines (R3.13 as built). macOS HUD status summary under R3.13. |
| 2026-10-20 | **R3.14 done on the simulator; Phase 3's steps complete**: twelve tables. `hud/rail-hud/tests/twelve_tables.rs` (own `main`, `-- --run`) plays the app (store, watcher, statistics pass, real supervisor) with the HUD process on this system's backend over 12 simulator tables posing as PokerStars plus one ACR-titled table posing as GGPoker (`--sim-site` / `--sim-title` now once per room): attach, a minute of hands at 6/min/table with a recompute queued (must stay paused), every table moved twice, idle; JSON + markdown report written before the gates (`target/twelve-tables`, CI artefact `twelve-tables-<os>`). Gates: 12 attached and 12 overlays, none and no hand on the refused table, every hand shown, hand written -> frame p95 < 1 s (§3.3), paint p95 < 16.7 ms, follow p50 < 2 frames (p95 < 3 frames on Windows and `--real-hw`, recorded on a CI Mac), HUD idle / playing CPU 5 % / 15 % and the app's 20 % of one core scaled by a workload timed on the runner (never below the M2 Pro's), HUD memory 256 MiB. New in the HUD: `--perf-report` (paints, follows, re-reads, looks for tables at shutdown; `Platform::paint_times_us` / `follow_times_us`, `latency::summarize`), Windows `probe::memory` (`Win32_System_ProcessStatus`); **the macOS search slows to 2 s** while the observers follow every table and the client has posted a move (`Platform::notified`, `macos::fully_observed`; tested). CI step "HUD on twelve tables (R3.14 budget)" on macOS and Windows. Local (M2 Pro, release, no Accessibility so data-only, machine loaded): written -> frame p50 513 / p95 517 / max 524 ms, HUD 0.20 % idle / 0.29 % playing, app 0.69 %, HUD 14 MiB; overlay paint in-process p50 0.76 / p95 1.09 ms. Real-hardware kit: `cargo test --release -p rail-hud --test twelve_tables -- --run --real-hw --seconds 300`. Owner's procedure for the real clients: `docs/research/REAL-CLIENT-CHECK.md` (C1 - C15). Phase 3 summary in the R3.14 section: met on the simulator in CI; real clients pending the capture (no `tables` block yet), P5, P6 and the check. |
| 2026-10-20 | **Phase 3 closed on staging** (#218, #221, #223, #224, #217): CI runs after R3.14 turned up two HUD fixes and the gates' noise. **macOS, a table seen before keeps its remembered title through a look without its Accessibility partner** (mid-move, or a client too busy to answer): it no longer drops out of the find and comes back as a new table (a tournament move was attached afresh). **macOS, a new window's title and title bar**: the window server lists a new window before the Accessibility API gives its title and close button; a window untitled or with an unmeasured bar (`Remembered::bar_known`) keeps the re-find at 500 ms for up to 3 s, and the engine picks the find's pace after the look - a new table's overlay covered its title bar until the next 2 s find before. **Gates**: paint p95 < 16.7 ms is gated on real hardware (the same debug build read 2.8 - 28 ms on Windows runners), recorded on CI under a three-frame ceiling; follow p50 recorded on a CI Mac. Tests made robust to slow runners: `in_play` checks the count only before the watcher's quiet period, Windows restack waits up to 3 s, the storm compares with the table's frame now, a table opened over another is checked against its own overlay, river solver tests 120 s; a failed `macos_tracking` window step prints every window and a timeline, HUD log lines carry their time. |
| 2026-10-22 | **R4.1 done on staging**: the web converts with the WASM core. The converter's pipeline (worker and main-thread fallback), the single-hand box and shares of unsaved hands go through `lib/wasm/engine.ts`: the core (`rail-core-wasm --target web`), or - when it cannot load - the TypeScript parsers, loaded on demand, with one warning; output unchanged (`ConversionResult`, `parsedAt` from the caller). Core: new export `split` (the top parser's chunks, so batches of 100 stay) and an empty file name means none. `lib/phf/types.ts` re-exports the 36 generated types (192 importers unchanged; 30 hand-written declarations gone). **Deploy**: the web package committed at `frontend/src/lib/wasm/rail-core/` is CI's Linux x86_64 build (rust-lld on macOS lays the module out differently, so a Mac build can never be committed; `wasm:web` refuses there, `wasm:web-check` only checks the copy against its BUILD.json); the `wasm` job uploads its build as `rail-core-web` and fails on any byte difference, `npm run wasm:web-from-ci` installs the artefact; `wasm:build` remaps the cargo home and repository paths out of the module (78 absolute paths before). Served as `/_next/static/media/*.wasm`, `application/wasm`, immutable; 2.28 MB / 0.77 MB gzipped. Zero server requests holds (browser check; and a test that the loader fetches only its `.wasm`). Tests: `wasmWeb.test.ts` (32, `npm test`), `scripts/wasm/web.test.ts` - **556 / 556** files, 8 422 hands, 196 failures equal on the web's path. Browser worker: 6 000 hands in 2.7 s (~2 200 hands/s). **TS parsers kept** (fallback, oracle); deleting them waits for an agreed period of shadow mode green in production, after the owner promotes `staging`. |
| 2026-10-22 | **R4.2 done on staging**: bulk upload at desktop scale. The converter's worker reads the drop itself, one file at a time (`bulkSource.ts`; folders up to 100 000 files, non-hand-history files skipped), zips through a streaming reader of its own (`zipStream.ts`: `Blob.slice` + the browser's `DecompressionStream`, zip64, no library, 1.4 KB gzipped), and a signed-in drop is saved while it converts (`bulkSaver.ts`: a 1 500-hand queue that holds the worker back, calls of 250 hands / 3 MB, backoff and pause, budgets) through `ingest_hands` from the account's web source - rows `origin = 'upload'`, PHF only, the account's budget instead of the web's global one (migrations `20270609090000_hand_origin_upload.sql`, `20270609091000_web_bulk_upload.sql`: `register_web_hand_source`, `ingest_hands` for web sources, the text CHECK). Resume = drop the same files again: an IndexedDB manifest skips stored files, entries and batches. Originals to Storage only on the new opt-in "Also keep the original files" (off by default, per visit): private bucket `hand-uploads`, gzip, 50 MiB, owner-folder policies (select / insert / delete under `auth.uid()`, no update, nothing for anon). The tab keeps the first 20 000 hands. Measured: 1 000 023 hands, 138 MB zip, 545 s (~1 830 hands/s) in Node with the WASM core, heap +45 MB. Tests: 39 Vitest (inputs, save, worker), pgTAP `web_bulk_upload` (37); end to end against a local stack (found and fixed an untyped gzip the bucket refused). Not applied to production. |
| 2026-10-22 | **R4.3 done on staging**: live progress and arrival. An upload's progress shows in the account's other tabs and devices through **Realtime Presence on the private channel `activity:<uid>`** (state and counts, ~200 bytes, no hand or file name; at most every 2 s, heartbeat 15 s, "done" kept 20 s; no database write per batch; an entry leaves with its socket, ~0.6 s after a close, or after 45 s unchanged): "Saving 120 000 of ~1 000 000 hands from a web upload" with a bar, then "finished"; the total from the opened files' splits scaled by the unopened bytes. Migration `20270616090000_live_activity.sql`: the first `realtime.messages` policies - `authenticated`, own topic only, receive presence + broadcast (Realtime's join is a broadcast read; presence alone was refused), send presence only; B, anon, other topics and broadcasts refused; a public channel of the same name kept apart. Arrivals (R1.10's `hand_arrivals`) now also reach the analysis screens as "N new hands arrived - refresh" (`AppFrame live="notify"`), `/library` updates in place only while the reader is at the top, and "Desktop app syncing: N hands so far" comes from desktop-origin arrivals (two quiet minutes end it). Strip in `AppFrame` (`LiveStrip`, `en` + `hr`, a hidden status region announcing only starts and ends). Tests: Vitest `liveActivity` 27 (publisher, board, estimate, channel lifecycle with a fake client), `liveArrivals` 12; pgTAP `live_activity` 27 (suite 35 files / 1 146); `npm run realtime:activity` 16 / 16 and `realtime:arrivals` 15 / 15 on an isolated local stack; browser end to end (two tabs, a 20 000-hand drop, desktop batches, Croatian at 375 px). Not applied to production. |
| 2026-10-22 | **R4.4 done on staging; Phase 4's exit met for the corpus on a local stack**: the parity test. `npm run parity` (`tests/scripts/parity/`, CI job `parity`) puts every corpus file through the **app's path** - `core/rail-sync/examples/parity_app.rs`: `rail-watch` on a folder, a fresh `rail-store`, the sync worker with the real `Account` and `IngestClient` into `ingest_hands` (`desktop`) - and the **web's** - the converter's bulk run with the committed WASM core into the bulk saver and `ingest_hands` from the web source (`upload`) - as two users of a throwaway stack, runs the web's statistics rebuild route as each, and compares as `postgres`: every `hands` column but `id` / `owner_id` / `origin` / `created_at` byte for byte (`phf` with only `meta.parsedAt` masked), every `hand_stats` / `hand_stats_ev` column but `hand_id` / `owner_id` / `created_at`, and the web's rendering inputs (`get_hand` -> `toHandRecord`, the derived standard text, the replayer's frames from the text and from the PHF). Hands kept in several corpus files and stored from different copies are checked against the web's conversion of the app's file instead. A rolled-back control proves each kind of difference is reported. Result: **556 files, 7 496 hands, 43 923 statistics rows, 7 249 EV rows: 0 differences**; nothing fixed. Neither path writes `hand_stats` itself: both get them from the web's rebuild (an upload at once, a synced hand when `/stats` opens). Findings for the owner: **F1** - Ignition tournament seats past 24 (15 corpus hands) break `hand_stats_seat_ok`, and the rebuild then fails on that page forever, for the whole account, on both paths and on `main`; **F2** - statistics inserts spend the global `hand_stats_insert` (200 000 rows / 10 min for everyone), which a desktop-sized library would hold for ~100 min. Locally 3.3 min for the whole corpus (45 s for `RAIL_PARITY_CORPUS=sample`). |
| 2026-10-22 | **R4.4's findings F1 and F2 fixed on staging** (#235, `20270623093000_stats_seats_and_budget.sql`, not applied to production): seat numbers past 24 (Ignition tournaments, to 1 227 in the corpus) are accepted by `hand_stats`, `hand_stats_ev`, `hand_analysis.hero_seat` (any `smallint` from 0) and the forum's `anchor_seat` (from 1) - PHF has no seat bound and `hands.hero_seat` never had one; the rebuild route retries a page the database refuses for its data hand by hand and skips and counts the hands still refused (`lib/db/statsSave.ts`), so one hand can no longer stop an account's statistics; statistics inserts are charged per account (`hand_stats_insert:<uid>` 1 000 000 / 10 min, 10 000 000 / day) with the global bucket a 3 000 000 / 10 min ceiling. The desktop store and `rail-stats` have no seat limit. Parity without its workarounds: whole corpus, 0 differences, the 15 wide-seat hands rebuilt on both sides; pgTAP 36 files / 1 170 tests. |

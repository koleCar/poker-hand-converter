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
| **A5** | Original files in Storage; hands in Postgres | **A storage budget per hand.** Today a hand costs ~7.3 KB in `hands` (PHF + `standard_text` + `source_text`) plus ~3.9 KB in `hand_stats` with opponents on — about **11 GB per million hands**. Proposal: desktop-synced hands do not send `standard_text` (it is derived), and original text goes to Storage compressed per file, not per row. Decide before R1.8. | A HUD user with 1M hands is ordinary; at today's row size the database bill decides the subscription price. |
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
busy. Popups that need rich content (stats by situation, notes) open as small
Tauri webview windows and reuse `packages/ui`; the always-visible panels are
drawn natively for speed.

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

### 3.4 Local SQLite schema (first version)

| Table | Contents | Key |
| --- | --- | --- |
| `sources` | watched folders: path, site override, enabled, recursive, status | `id` |
| `files` | path, size, mtime, read offset, encoding, site, last error | `path` |
| `hands` | hand key, site, played_at, format, stakes, table, hero seat, PHF (zstd), parser version | `hand_key` |
| `quarantine` | refused hands: file, offset, stage, reason, message, raw text | `id` |
| `unsupported` | registry (R0.11): header sample, guessed site, OS, client version, count, first seen, consent state | fingerprint |
| `seat_stats` | one row per dealt-in seat at the current stats version — the local `hand_stats` | `(hand_key, seat)` |
| `player_rollups` | summed counters per (player, segment) for the HUD and reports | `(site, player, segment)` |
| `players` | notes, colour tag, labels | `(site, name)` |
| `hud_layouts` | layouts, presets, seat positions per (site, table size) | `id` |
| `outbox` | hands not yet synced, attempts, last error | `hand_key` |
| `kv` | schema version, sync cursors, settings | `key` |

A *segment* is (site, game format, variant, limit, table-size class, stake
bucket). Reports filter and sum over segments; the HUD reads one row per player
for the segment of the current table.

### 3.5 Supabase mapping

| Guideline | Decision | Step |
| --- | --- | --- |
| `profiles` | existing; add `plan`, `plan_until` in Phase 6 | R6.2 |
| `hand_sources` | new: folder or web upload, owner, device, status counters | R1.8 |
| `hands` | existing; key `(owner_id, hand_key)` with `hand_key = site:hand id` | — |
| `hand_players` | not added; `hand_stats` has one row per dealt-in seat | — |
| `players` | new: tags and colours; `player_notes` stays (or is folded in) | R2.7 |
| `player_stats` | only if R2.9 shows server-side reports need it | R2.9 |
| `hud_layouts` | new; synced so layouts follow the user to a second machine | R3.9 |
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
      "seatLayouts": { "6": "stars-6max", "9": "stars-9max" },
      "preferredSeat": true
    },
    "hud": { "allowed": true, "source": "https://…", "checkedAt": "2026-…", "notes": "" }
  }]
}
```

Paths here are illustrative until R1.4 verifies them on real installs. The app
ships a copy and fetches updates from the web origin over HTTPS; a downloaded
file is schema-validated and may only make HUD policy *stricter* than the
shipped copy, never looser, until a new signed release says otherwise.

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

### R0.5 Shared infrastructure — L
- Port, each with its TS unit tests translated: decoding (strict UTF-8 → BOM →
  Windows-1252; UTF-16LE), `parseAmountStrict` and money helpers, detection and
  scoring, `splitHands` helpers, `assignPositions`, `validateHand`, the
  `ParseSkip` reason set, variant lock, Hi/Lo and short-deck evaluators needed
  by validation.
- **Done when** the ported unit tests pass and `assignPositions` +
  `validateHand` agree with the goldens on every golden hand.

### R0.6 Serializer — M
- `toStandardText` in Rust, including the style fields that make output
  byte-exact (decimal style, grouping, fee columns, header quirks).
- **Done when** for every golden hand the Rust text hashes to `standardText`,
  and `parse(serialize(h)) == h` holds for the `standard` parser.

### R0.7 Parsers, PokerStars family — L
- `pokerstars`, `ggpoker`, `weplay`, `coinpoker`, `standard`.
- **Done when** golden diff is 100 % for these sites (hands, refusal reasons,
  warnings). From here, A9 lets R1.1–R1.3 start.

### R0.8 Parsers, `*****` family — M
- `partypoker`, `pokerstars888` (888poker), `pokerbros`.

### R0.9 Parsers, XML — M
- `ipoker`, `microgaming`. Choose the XML reader once (`quick-xml`), share it.

### R0.10 Parsers, own dialects — XL (one PR per parser)
- `winamax`, `acrwpn` first (HUD-relevant), then `ignition`, `chico`,
  `fulltilt`, `ongame`, `entraction`, `unibet`, `runitonce`.

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

### R0.12 `config/sites.json` v1 — M
- JSON Schema, loader and validator in `rail-config`; every current parser has
  an entry; `hud.allowed` is `null` (unknown) for every room until R3.0.
- CI rule: a parser without a `sites.json` entry fails the build, and vice
  versa.

### R0.13 WASM build — M
- `rail-core-wasm` with `wasm-bindgen`: `convert(bytes, filename) -> JSON`,
  `detect(bytes)`, `serialize(phf)`.
- Size budget (target < 1.5 MB gzipped) checked in CI.
- Shadow mode in `tests/`: the Vitest harness runs the WASM core next to the TS
  pipeline over the whole corpus and asserts identical results. The web keeps
  using TS until R4.1.
- **Done when** shadow mode is green.

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

### R1.2 Local store — M
- `rail-store`: §3.4 schema, embedded migrations, WAL, a single writer thread,
  read connections for UI queries.
- **Done when** a crash mid-import (killed process) leaves the database
  consistent and the import resumes where it stopped.

### R1.3 Watcher and incremental reader — L
- `notify` for OS events, plus a rescan every 60 s; network drives poll only.
- Per file: offset, size, mtime; read only new bytes; a hand is complete when
  the next hand header starts or the file has been idle for a few seconds and
  the hand validates. UTF-16 files are read on code-unit boundaries.
- Handles rotation, rename, deletion, truncation (re-read from 0, dedupe saves
  us), unplugged drives.
- **Done when** a test that appends a corpus file to a watched file byte by byte
  in random chunks imports exactly the hands of that file, once.

### R1.4 Folder discovery — M
- Fill `sites.json` paths per room and OS **from real installs** (P6), not from
  tracker forums; record how each was verified. Today the research docs confirm
  almost no default folders.
- First-run screen: found folders with file count and date of the last hand;
  one click to confirm; "import everything" vs "only new hands".

### R1.5 Settings → Folders — M
- Add (picker, external and network drives), edit path, override room,
  enable/disable without deleting hands, recursive, status per folder (last
  import, hands today, errors, quarantined hands with reasons).

### R1.6 Import pipeline — M
- Bounded queue → parallel parse (`rayon`) → batched transactions; progress for
  the backfill; quarantine with reasons, visible in the UI.
- Benchmark in CI on replicated corpus data (labelled as generated, outside the
  fixture trees): **≥ 5,000 hands/s** on the CI macOS runner.

### R1.7 Desktop sign-in — M
- Web page `/auth/desktop` (A6): signs in as usual, then redirects to
  `rail://auth/callback?code=…`; the app exchanges the code with PKCE.
- Tokens in the OS keychain (`keyring`); refresh in the background; sign-out.
- The app works offline after the first sign-in. Whether it may be used with no
  account at all is open question Q3.
- Supabase redirect allow-list gets the new page; Google enabled (P7).

### R1.8 Supabase for desktop ingest — M
- Migrations: `hand_sources`; `ingest_hands(rows jsonb)` (invoker; insert …
  on conflict do nothing; returns per-row status); a desktop-sized rate limit
  next to `ingest_rate_limit` (a 500k-hand backfill must not trip the web's
  limit); the storage decision from A5.
- `hand_stats` rows go through the existing `save_hand_stats`.
- pgTAP: another user's rows can be neither read nor collided with; replays are
  no-ops; the rate limit holds.

### R1.9 Sync worker — M
- Outbox → batches (e.g. 500 hands, gzip) → `ingest_hands`; exponential backoff;
  resumable; bandwidth cap during play; status in the UI.
- Pull: hands that arrived through the web (`hand_sources.kind = 'web'`) are
  fetched by keyset cursor and imported locally, so the app and the web show the
  same hands.
- **Done when** the Phase 1 exit check passes, including after a network cut
  mid-batch.

### R1.10 Live arrival on the web — S
- `/library` and `/stats` subscribe through Realtime to the user's own new rows
  and refresh; RLS applies to Realtime as well.

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

### R2.2 All-in EV in Rust — M
- Port `lib/equity`; same seeds, same results; the Monte Carlo path must match
  TS exactly or within a documented tolerance agreed in the PR.

### R2.3 Rollups and segments — M
- `player_rollups` maintained in the import transaction; a rebuild command
  (after a stats version bump); the segment definition from §3.4.

### R2.4 `config/stats/` display definitions — M
- Schema: id, name, short label, formula over counters (`3bet / 3bet_opp`),
  format (percent, bb/100), colour thresholds, minimum sample for full
  opacity, description. The starting set of ~30 (guideline §5).
- Same files read by the app (Rust) and the web (TS) — one source.

### R2.5 Sample reliability — S
- Confidence interval per value (Wilson for rates) and the dimming rule from
  the definition; shown in tooltips, used by the HUD.

### R2.6 Shared UI package — L
- `packages/ui`: tokens, cards, chips, the replayer, stat tables, graphs,
  filter chips, command palette, dialogs. Web consumes it first with no visual
  change (screenshot comparison of key screens before and after).
- Components take data through props and a small `DataSource` interface:
  Supabase on the web, Tauri commands on the desktop.

### R2.7 Desktop screens — XL (one PR per screen)
- Today, Hands (virtualised list, filter chips, saved filters, replayer, tags,
  notes), Reports (winnings + all-in EV graph, by position and situation),
  Players (profile, notes, colour tags — `players` migration), Settings.

### R2.8 Polish — M
- Command palette, dark/light theme, density, i18n with `en` and `hr` prepared
  (same pattern as the web's `lib/i18n`).

### R2.9 Benchmark database and performance gate — M
- A 1M-hand database built by replicating real corpus hands with fresh ids and
  names (generated, labelled, never under `testdata/`); nightly CI job measuring
  every target in guideline §1; fails on regression.
- Same measurement against Supabase decides whether `player_stats` is needed
  server-side (§3.5).

### R2.10 Custom statistics — L
- Core exports per-seat decision events (street, position, facing — unopened,
  limped, raise level —, action, sizing class).
- A definition = opportunity filter + action filter over events (A11); editor
  in the app previews the value on the user's own hands as you type.
- Acceptance: the standard set re-expressed in the language matches the coded
  counters over the corpus (differences documented, as in `STATS-SPEC.md` §4).

### R2.11 Targeted recompute — S
- Dependency map definition → counters; a definition change recomputes only
  what it touches, in the background.

---

## Phase 3 — HUD

**Goal.** A HUD that reads at a glance, on rooms that allow it, Windows first.

**Exit.** HUD on 12 simultaneous tables on Windows and macOS within budget
(§3.3), only on rooms whose `hud.allowed` is `true`.

### R3.0 Compliance check — M
- Per room: HUD policy, the exact page it comes from, the date, and whether the
  client writes live files and persistent names. Into `sites.json` (`hud`
  block); the README table (§6) updated from it; owner signs off.
- Repeat before every release (checklist in §12).

### R3.1 Table simulator (`rail-hud-sim`) — M
- Opens N windows titled like a given room's tables, at that room's sizes, and
  writes real corpus hands into a hand-history folder at play speed.
- Runs on both systems and in CI; drives the watcher (Phase 1 exit check) and
  every HUD test below.

### R3.2 HUD process and IPC — M
- `rail-hud` as a Tauri sidecar; IPC from §3.2; health checks and restart;
  read-only SQLite; one platform trait (`find_tables`, `track`, `overlay`)
  with Windows and macOS backends.

### R3.3 Windows: find tables — M
- `EnumWindows` + `GetWindowText` + owning process; title regex from
  `sites.json` → table name and stakes; match to the table name in the newest
  hands (hand header `Table '…'`).

### R3.4 Windows: overlay — L
- One window per table: `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`,
  owned by the table window (stays above it, minimises with it, never steals
  focus); hit-testing transparent outside panels; Direct2D/DirectWrite drawing;
  per-monitor DPI v2.

### R3.5 Windows: tracking — M
- `SetWinEventHook` for location change, foreground, minimise/restore, destroy,
  name change (tournament table moves); debounced; DPI changes between
  monitors.

### R3.6 Seats and layouts — M
- Map hand-history seats to on-screen seats from table size and the room's
  "preferred seat" rotation; layouts in normalised coordinates of the client
  area; drag to move a panel, remembered per (room, table size, seat).

### R3.7 Data path — S
- On `hand_imported`, reload rollups of that table's players, redraw;
  instrument the latency from file event to redraw and show it in debug builds.

### R3.8 Panel and popup — M
- 4–6 stats, colours from thresholds with legend, dimming from R2.5, hand
  count; popup on click with stats by situation and notes (webview window,
  `packages/ui`).

### R3.9 HUD editor and presets — L
- In the app's HUD screen: drag-and-drop stats, presets for cash, MTT and Spin,
  per room and table size; `hud_layouts` locally and in Supabase (migration).

### R3.10 Compliance mode — S
- The HUD refuses to attach to windows of rooms whose `hud.allowed` is not
  `true` — unknown counts as no — and says why in the app. No override.
- A10: analysis and solver screens are hidden while any table is open.

### R3.11 macOS: find tables — M
- Accessibility API per poker process (`kAXWindowsAttribute`, `AXTitle`) for
  titles — needs only the Accessibility permission; `CGWindowListCopyWindowInfo`
  for bounds and order (window *names* there would need Screen Recording, so
  they are not used).
- Onboarding screen that explains and requests the permission, and detects when
  it is granted.

### R3.12 macOS: overlay — L
- Borderless, transparent, non-activating `NSPanel` per table; ordered directly
  above the table window (`orderWindow(.above, relativeTo:)`); collection
  behaviour for Spaces and full screen; Retina scale; click-through outside
  panels. Through `objc2` bindings.

### R3.13 macOS: tracking — M
- `AXObserver` for moved, resized, miniaturised, destroyed, title changed;
  `CGWindowList` polling as a fallback for clients with poor accessibility.

### R3.14 Twelve tables — M
- Simulator with 12 tables on each system; CPU, memory and latency budgets
  recorded in CI and on real hardware; then a real-client check on each
  allowed room (P5, P6).

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

### R4.2 Bulk upload — M
- Drag-and-drop files, folders and ZIPs (exists) at desktop scale: streaming
  unzip, chunked saves, resumable. Original files to Storage only when the user
  opts in (A2); bucket policy by owner folder; pgTAP/Storage policy tests.

### R4.3 Live progress and arrival — S
- Progress of a large upload and hands synced from the desktop appear live
  (Realtime).

### R4.4 Parity test — S
- Automated: the same corpus file through the app path and the web path gives
  byte-identical `phf` and `hand_stats` rows.

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
| Web | Existing Vitest harness, lint, typecheck, build; shadow mode until R4.1 | CI |

The TS harness (`tests/`) stays the oracle until R4.1. A parser fix lands in TS
and Rust in the same PR during the port, with the goldens regenerated by
`emit.ts`, never edited by hand.

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

---

## 13. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Port size**: ~22k lines of TS parsers and format, ~2.6k stats, ~2.5k equity, written with many deliberate quirks | Phase 0 is the longest phase; a subtle mismatch corrupts statistics | The golden oracle makes every mismatch a failing test; port by family; TS stays live until shadow mode proves parity |
| **Rooms ban HUDs or stop writing files** (already true for GGPoker-style downloads, WPT Global, anonymous rooms) | Fewer rooms where the HUD has value | Compliance mode, honest room table, import-only support everywhere else |
| **Poker clients detect overlay processes** | Users' accounts at risk | Only rooms that allow HUDs; no injection, no reading of client memory or pixels — overlays use public window APIs only |
| **macOS permission friction**; poker clients with weak accessibility trees | "Works immediately" fails on Mac | Onboarding screen; `CGWindowList` fallback; test each allowed room's client |
| **No Windows hardware** while the HUD starts on Windows | Phase 3 blocked | P5 now; simulator lets most work happen on the Mac |
| **Database cost** at ~11 GB per million hands | Subscription price | A5 before R1.8 |
| **Turnstile / auth inside the app** | Sign-in fails | A6 |
| **Working-hours constraint** on the development machine | Long builds and agents slow down | CI does the heavy builds; local compute stays out of working hours |
| **Public repository + future paid product** | Licensing surprise later | P8 |

---

## 14. Open questions for the owner

| Id | Question | Needed by |
| --- | --- | --- |
| Q1 | ~~Accept or reject each amendment A1–A11 (§2).~~ All accepted 2026-10-12. | R0.2 |
| Q2 | Which domain? | R1.7 |
| Q3 | May the app be used with no account (local only), or is sign-in required? The guideline's three steps start with sign-in; local-first suggests it could be optional. | R1.7 |
| Q4 | Storage policy per hand (A5): drop `standard_text` for synced hands? originals to Storage always, opt-in, or never? | R1.8 |
| Q5 | Windows test machine: a PC, or Parallels on the Mac? | Phase 3 |
| Q6 | Which rooms first for the HUD after the compliance check? Suggested: PokerStars, Winamax, ACR. | R3.0 |
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

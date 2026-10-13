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
- The `unsupported` table from R0.11's `Unrecognized` record and the consent
  state (see *As built, R0.11*, "For R1.2").
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
- The evaluator (`evaluator.ts`, `omaha.ts`) is already `rail_core::eval`
  (R0.5b); this step adds enumeration, Monte Carlo, ranges and multiway pots
  on top of it.

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

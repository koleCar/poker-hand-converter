# Golden oracle

What today's TypeScript pipeline concludes about every file in the corpus,
written down so the Rust core can be held to it (docs/RAIL-PLAN.md, R0.3). The
Rust port is correct for a file when it reproduces that file's golden **byte
for byte**.

```bash
cd tests
npm ci
npm run golden:emit      # ~10-15 s; rewrites testdata/golden and testdata/golden-full
```

**Never edit a golden by hand.** A parser fix lands in TypeScript, the goldens
are regenerated in the same PR, and the Rust side then sees the change as a
failing diff. CI's `golden-fresh` job regenerates them on every pull request
and fails if the result differs from what is committed (or if a golden is
missing, or left over for an input that is gone).

## Two trees

| Tree | In git | Size (2026-10-12) | Holds |
| --- | --- | --- | --- |
| `testdata/golden/` | yes | 2.9 MB, 556 files | everything, with each hand's PHF reduced to the sha-256 of its canonical JSON |
| `testdata/golden-full/` | no (`.gitignore`) | 137 MB, 556 files | the same documents with every PHF written out |

**Size decision.** Written out in full the goldens are 137 MB of pretty JSON
(76 MB compact; 7.3 MB gzipped per file). A PHF hand is ~8.8 KB of JSON, and
the corpus has 8 422 of them. That is over the ~25 MB budget for committed
goldens, and gzipped blobs would be unreviewable, would churn with the zlib
version, and would add a full copy to the history on every parser fix. So the
committed tree pins every hand by hash - which is exactly as strict, because
the hash is over the canonical bytes - and keeps everything small and
reviewable in plain JSON: detection, refusals with their reasons and messages,
warnings, and the text hashes. A diff in a PR shows which hands of which file
changed and how their refusals and warnings moved; `testdata/golden-full/`,
regenerated locally in seconds, shows what changed inside a PHF.

The Rust tests that need the PHF bodies (R0.4 onwards) are meant to read
`testdata/golden-full/` - R0.4 adds `npm ci && npm run golden:emit` in
`tests/` before `cargo test` in the `core` job (Node is on every runner) - and
to check every body against the committed hash before using it. That check is
what proves the full tree on disk is the committed oracle and not the output
of some other checkout. Tests that only compare (R0.7 onwards: "does Rust's
PHF hash to the golden's?") need nothing but the committed tree.

## Inputs

Every `.txt` and `.xml` file (case-insensitive extension) under
`fixtures/samples/`, `gg-hh/`, `weplay-hh/` and `tests/test/fixtures/` - the
same rule the test loaders use (`tests/test/support/*Corpus.ts`). 556 files
today. Not inputs, and so without a golden:

- `SOURCES.md` in every sample directory (documentation);
- `fixtures/samples/phh/*.phh` - the PHH interchange spec's examples; no parser
  reads PHH;
- `fixtures/samples/acr-wpn/fpdb3-regression-corpus/summaries__PlayerTransactionHistory.html` -
  a cashier page harvested with the ACR samples, not a hand history.

A golden sits at `testdata/golden/<input path>.json`, so
`gg-hh/foo.txt` → `testdata/golden/gg-hh/foo.txt.json`. Paths contain spaces,
`#`, `$` and `@`; nothing may assume otherwise.

## The pipeline

Exactly what the converter tab does with a dropped file
(`ConverterTab` → `runPipeline`):

```
bytes ─ decodeSource ─ convertAny(text, { sourceFilename: <file name>, validate: true })
```

- `decodeSource` (`frontend/src/components/converter/inputs.ts`): BOM sniff,
  UTF-16 without a BOM by NUL pattern, strict UTF-8, then the WHATWG
  `windows-1252` decoder (what `encoding_rs` implements) with its own
  plausibility guard; strips a BOM; turns CRLF and lone CR into LF. Note that
  this is **not** what most of the Vitest suites do - they read files with
  `readFileSync(path, "utf8")` and decode UTF-16 / cp1252 themselves where it
  matters. On 28 files the two readings give different outcomes - the 24
  Entraction and Ongame samples start with a UTF-8 BOM, which a raw read keeps
  and detection then does not match, and three Winamax files and one Unibet
  file are Windows-1252 - and the goldens follow the app.
- `convertAny` (`frontend/src/lib/phf/detect.ts`): detect on the whole text,
  split with the best parser, detect again per chunk, parse, the hi/lo and
  short-deck backstops, `assignPositions`, `validateHand`.
- The converter feeds `convertAny` 100 chunks at a time (`BATCH_SIZE`) to keep
  the tab responsive. The emitter calls it once per file. Both give identical
  hands and refusals on all 556 files (checked when this was written); the
  Rust core should do the whole-file call.

## The document

Keys are listed here in their canonical order. `sha256` values are lowercase
hex. The full tree is identical except where noted.

```jsonc
{
  "chunks": 1,                       // chunks the primary parser's split returned; 0 for a file-level refusal
  "decode": {
    "encoding": "UTF-8 (BOM)",       // decodeSource's label: "UTF-8", "UTF-8 (BOM)", "UTF-16 LE", "UTF-16 LE (no BOM)",
                                     //   "UTF-16 BE", "UTF-16 BE (no BOM)", "Windows-1252"
    "problem": null                  // or "empty" | "no-text" | "binary"; then detected is null, every list empty,
                                     //   stats null - the converter does not call convertAny for such a file
  },
  "detected": {                      // detectSite(decoded text), before any split
    "candidates": [ { "parser": "weplay", "permille": 990 } ],   // every score >= 0.2, best first, ties in registration order
    "top": "weplay"                  // candidates[0].parser, or null
  },
  "format": "rail-golden/1",
  "hands": [                         // accepted hands, in chunk order
    {
      "handId": "HD76346675",        // meta.handId, for readable diffs
      "index": 0,                    // 0-based chunk index within the split
      "parser": "weplay",            // meta.parserId (per-chunk detection may differ from detected.top)
      "phf": "dc2e…",                // committed tree: sha256 of canonicalJson(phf); full tree: the PHF object
      "standardText": "6127…",       // sha256 of toStandardText(hand), UTF-8
      "warnings": [                  // validateHand(hand).warnings, in order; includes the parser's meta.warnings
        { "code": "no-hero", "context": { "line": 3 }, "message": "…" }   // context only when set
      ]
    }
  ],
  "input": { "bytes": 1125, "path": "tests/test/fixtures/weplay/cash-sample.txt", "sha256": "35db…" },
  "refusals": [                      // ConversionFailure records, in chunk order
    {
      "fingerprint": "4875…",        // sha256 of rawText with /\s+/g → " " and trimmed (JS \s, see below)
      "index": 0,                    // chunk index, or null for a file-level refusal (stage detect, or split)
      "message": "…",                // human-readable; for stage validate, every error message joined with "; "
      "parserVersion": "2.0.0",      // "0" when no parser was involved
      "permille": 990,               // detection confidence of the parser that refused it, or null
      "reason": "bb-only-walk",
      "site": "weplay",              // parser id, or null
      "stage": "parse"               // "detect" | "split" | "parse" | "validate"
    }
  ],
  "standardTextFile": "6127…",       // sha256 of toStandardTextFile(hands) (the converter's per-file download), or null with no hands
  "stats": { "bySite": { "weplay": 1 }, "converted": 1, "failed": 0, "total": 1 }   // convertAny's stats, verbatim
}
```

Choices worth knowing:

- **Detection scores** are floats in TypeScript. They are stored as integer
  per-mille, `Math.round(score * 1000)`; Rust gets the same integer from
  `(score * 1000.0).round() as i64` when it computes the score with the same
  operations. Today only five values occur (990, 950, 900, 860, 250).
- **`meta.parsedAt`** is the wall clock at parse time, the only part of a hand
  that does not follow from the input bytes. The golden pins it to
  `1970-01-01T00:00:00.000Z`. The Rust side sets it to the same value before
  hashing (or takes "now" as a parameter).
- **`meta.originalFilename`** is the file name alone (no directory), as the
  browser reports a dropped file.
- **Chunk index** is recovered by walking the primary parser's split: each
  chunk ends as exactly one hand or one refusal, in order, and a refused
  chunk's `rawText` is the chunk. The emitter fails if the two do not line up.
- Refusals keep the **message** too. The R0.7 exit is about reasons; whether a
  Rust comparison also requires identical messages is for that step to decide,
  but they are here, because they are what users read and what
  `unparsed_hands` stores.

## Canonical JSON

What `tests/scripts/golden/canonical.ts` writes, and what Rust must write
byte for byte. It is the output of `serde_json::to_string_pretty` on a
`serde_json::Value` (with the `preserve_order` feature **off**, so objects are
`BTreeMap<String, Value>`) followed by one `\n`:

1. **Objects**: keys sorted by their **UTF-8 bytes** (Rust `String` order).
   Not by UTF-16 code units, which is what JavaScript's default sort does and
   which differs once a key holds a character above U+FFFF. Today every key in
   every golden is ASCII, but some objects are keyed by data (`stats.bySite`,
   a warning's `context`), so the order is pinned rather than left to luck.
2. **Layout**: two spaces per level; `"key": value` with one space after the
   colon; one element per line; `,` at the end of a line; empty containers as
   `[]` and `{}`; no trailing whitespace; LF line ends; the document ends with
   exactly one `\n`.
3. **Strings**: `"` and `\` escaped; `\b \f \n \r \t`; every other character
   below U+0020 as `\u00xx` with lowercase hex; everything else literal UTF-8,
   including `/`, DEL, non-ASCII and U+2028/U+2029. (This is what
   `JSON.stringify` and serde_json both do.) A lone UTF-16 surrogate is an
   error - it cannot exist in a Rust `String`.
4. **Numbers**: integers only, within ±(2^53 − 1), no `-0`, no exponent.
   **There are no floats anywhere**: money is integer minor units (PHF-SPEC
   §1–2), and detection scores are per-mille. The emitter throws on any
   non-integer, so a float in PHF fails the run rather than reaching a golden.
5. **Absent vs null**: an object property whose value is `undefined` is
   omitted; `null` is written. `undefined` inside an array is an error.

**The PHF hash** in the committed tree is `sha256(canonicalJson(phf))`: the
PHF object serialized on its own as a top-level document by the rules above
(indentation starting at zero, trailing `\n`), not the indented slice of the
full-tree file it appears in.

## Notes for the Rust port

- **R0.4, `T | null` vs `T?`.** PHF distinguishes a field that is always
  present and may be `null` (write `null`) from an optional field that may be
  absent (write nothing). serde: `Option<T>` for the first;
  `#[serde(skip_serializing_if = "Option::is_none")]` for the second; and
  `Option<Option<T>>` (with `serde_with::rust::double_option`) where TypeScript
  says `?: T | null`. Serialize through `serde_json::Value` (or sort keys
  yourself) - a derived `Serialize` writes struct fields in declaration order,
  not sorted. *As built:* `rail_core::phf` (strict helpers in
  `phf/serde_util.rs`, no `serde_with`) and
  `rail_core::canonical::to_canonical_json`;
  `core/rail-core/tests/golden_roundtrip.rs` is the test that reads
  `testdata/golden-full/`.
- **R0.5, detection scores.** Over the whole corpus only five scores occur
  (0.99, 0.95, 0.9, 0.86, 0.25), and the detectors' source is mostly literal
  constants. If that holds when they are ported, the Rust detectors can return
  integer per-mille directly and stay inside the workspace's no-float lints
  (the threshold 0.2 becomes 200). Wherever a detector computes a score, the
  per-mille rule above pins what Rust must produce.
- **R0.14, moving the corpus.** A golden's path and its `input.path` are the
  input's repository path. Moving the fixture trees into `testdata/` renames
  every golden and changes every `input.path`; regenerate in the same commit
  and update `CORPUS_TREES` in `tests/scripts/golden/emit.ts`.
- **Fingerprints** normalize whitespace with JavaScript's `\s`, which is not
  Rust's `char::is_whitespace`: JS includes U+FEFF and excludes U+0085. Port
  the JS class literally.
- **Decoding** is part of the oracle (`decode.encoding`); port
  `decodeSource`'s order and guards, not a library default.
- **Warnings** carry `context` values that are strings or integers.
- 8 422 accepted hands and 196 refusals across 556 files as of the commit that
  added this file; 24 files are refused whole as `unknown-site` (the Boss Media
  and Merge samples, which have no parser, plus one Winamax and one Full Tilt
  fragment).

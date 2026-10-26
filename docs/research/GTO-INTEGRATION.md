# R5.6 — GTO tool integration: proposal

Status: **proposal for the owner** (2026-10-26). Nothing here is built.
`docs/RAIL-PLAN.md` lists R5.6 as "GTO tool integration (later)".

## What Rail already has

Rail grades decisions with **its own** computation (`docs/ANALYSIS-PLAN.md`):
the preflop chart sets (charts/N, own CFR), the flop library (own solves,
< 1 % exploitability), turn and river solves on demand, the ICM push/fold
game (R5.5), and the user's own charts (R5.3). The standing rule is that
Rail never copies another tool's charts or solutions.

So "integration" can only mean working **alongside** a solver the user owns,
not importing a vendor's library.

## Options

| # | What | User value | Effort | Risk |
| --- | --- | --- | --- | --- |
| A | **Export a spot to a solver.** From any decision in a hand: write a ready-to-run tree for PioSolver (`.txt` script / tree config) and GTO+ (`.gto` / range text): board, pot, stacks, positions, ranges (Rail's chart ranges, the population ranges or the user's own chart), bet sizes from the hand and Rail's menu. The user solves it in their own licensed tool. | High for serious students: "solve this exact spot" in one click. | M | Low: we write the user's own inputs in public formats. Formats must be checked against each tool's documentation. |
| B | **Import the user's own solutions.** The user exports a solved spot (PioSolver strategy CSV / GTO+ export) and attaches it to a hand or a spot; Rail stores it **privately** (owner-only, never shared or published) and shows it next to Rail's own grade, and can grade that decision against it. | Medium–high: their trusted solver's answer inside Rail's review. | M–L | Medium: parsing third-party exports; the solutions stay the user's data, not redistributed (same rule as R5.3's charts). |
| C | **Batch export** of many spots (e.g. a leak's example hands) as a solver script for overnight runs, then a batch import of the results (B). | High for coaches / heavy users. | L | As A + B. |
| D | **Deep links / API to a commercial web solver** (e.g. GTO Wizard). | — | — | **Not recommended**: no public API for this; scraping or copying their solutions breaks their terms and Rail's own rule. |
| E | **More of Rail's own solving** (multiway, 6-max 150bb …) — already the analysis program's work. | — | — | Not "integration"; continues separately. |

## Recommendation

1. **A first** (M): "Export to PioSolver / GTO+" on the analysis sheet of any
   postflop decision and on own charts. No server, no storage, works in the
   app offline. Pro feature.
2. **B next** (M–L), if users ask for it after A: private import of the
   user's own solutions, shown next to Rail's grade.
3. C only with demand; D never.

## Open questions for the owner

- Which solvers to support first (PioSolver, GTO+, both; others?).
- Is A a Pro feature (recommended) or Free?
- For B: grade against the imported solution, or only show it next to Rail's grade?

# Mass data analysis (MDA) — plan

MDA shows what the **pool** — every opponent in the user's own hands — does at each decision point, next to a reference, and turns the significant gaps into exploits. It is the opponents' side of what `ANALYSIS-PLAN.md` A3 (reports vs reference) and A6 (leaks) do for the hero.

Status: **plan, nothing built.** The owner asked for it on 2026-11-12. The 2026-11-12 study is the prototype: §1 lists what it found, and its scripts and results are in `~/Projects/rail-learn-research/mda/`, outside the repo.

## 1. What the study showed

The study ran over the owner's 2,920 GG NL100 6-max hands and 70,989 WePlay hands. That is about 408,000 opponent decisions, about 5.5 per hand. The pools were kept separate: GG 6-max, WePlay 6-max and WePlay 8-max.

The pool's biggest gap is folding on the river and the turn. Against a river bet of 40–80 % of the pot it folds 65–66 %; a pure bluff of that size breaks even at a 37.5 % fold. After calling two barrels it still folds 69 % on GG (n 39) and 56–58 % on WePlay. The same holds a street earlier: 57–62 % folds against medium turn bets.

Other gaps:

- **River raises** in WePlay are 73–87 % two pair or better.
- **Small river bets** are bluffed about as often as theory asks (17–22 % air, against 20 %).
- **Early-position openers** call 3-bets far more often than the charts. On GG, UTG folds 39 % to a 3-bet, against 51 % in the owner's own GTO Wizard chart (a personal check, not data Rail keeps).
- **The big blind** folds too much to the small blind's open.
- **The small blind** flats the button's open 9–23 % of the time, against 1.6 %.
- **In-position c-bets** against the big blind run at 60–67 %, against the solver's 73 %, and the gap is widest on Q–9-high and paired boards.

What the study settled about method:

1. **It is cheap.** Walking 71,000 PHF hands into node rows takes about a minute in Python. A version bump can re-count everything; nothing needs to be incremental for correctness.
2. **Each reference needs a defined source, or the numbers mislead.**
   - Preflop: the range reference of A3 (`lib/analysis/reports.ts`), reach-weighted over the actor's own earlier actions.
   - Flop: the flop library's own strategies, averaged over the 100 representatives, each weighted by the real flops (of 22,100) that map to it.
   - Turn and river: theory only. α = bet / (pot + bet) is the fold at which a pure bluff breaks even. The bluff share at which a call breaks even is bet / (pot + 2·bet). There is no turn or river library yet.
3. **River bettor showdowns can be trusted.** A river bettor who is called shows their cards (mucks: about 0 % in both rooms), so the composition of called river bets is a fair sample of the betting range at that size.
4. **Samples are thin past the flop at small volume.** GG has 80–190 chances per turn or river node and 18–43 river showdowns per size. Every number needs its interval, and the screen must say when a node is too thin.

## 2. Decisions to keep

- **Data: the user's own hands only.** A pool is every non-hero seat in the user's hands, split by room and table size, and filterable by stakes and date. There is no cross-user pooling: that would need opt-in consent and a privacy-policy change, and is not planned. There is no bought or scraped data, which GG's terms forbid. The HandHQ public set is from 2009 and of no use for today's pools.
- **References are Rail's own** (§8 decision 1 of the analysis plan): the shipped charts, the flop library, and theory.
  - The user may choose **one of their own chart sets** (R5.3, *My charts*) as the preflop reference. That is how someone compares a pool with GTO Wizard's charts: they import their own copy privately, as the R5.6 proposal describes.
  - Rail never ships GTO Wizard data. The `-gtow` sets in the `ante-charts` worktree stay Solver-only and personal.
- **Off-table only.** MDA is a study screen. It never feeds the HUD: GG and others forbid HUDs (R3.0), and showdown composition is card-split (R3.9).
- **One engine, two platforms.** The counting is pure TypeScript in `web/src/lib/mda/`, which the app reaches through its one door (`app/src/analysis/library.ts`, R5.4a) and the web's worker imports directly. It follows the analysis library's rule: no Supabase, no Next. Desktop comes first, because the owner's data is there; the web follows in MDA6.

## 3. The model

### 3.1 Node key

A node is where one decision is made. Its key is a tuple, encoded as a string:

| Part | Values | Source |
| --- | --- | --- |
| `street` | `pre` `flop` `turn` `river` | |
| preflop situation | the R5.3 vocabulary: `rfi:<pos>`, `vs-open:<pos>:<opener>`, `squeeze:…`, `vs-3bet:<pos>:<raiser>`, `vs-4bet:…` | `packages/ui/charts/nodeKey.ts` over the chart line (`chartLineOf`) |
| postflop: pot | `srp` `3bp` `4bp` `limped` | preflop raises |
| postflop: line | the library line id where one exists (`btn-bb`, `co-btn-3bet`), else `<opener>-<caller>` | positions |
| postflop: role and position | `pfr` / `caller` × `ip` / `oop`; heads-up only in v1 (multiway: `mw`, counted but not compared) | |
| postflop: history | per earlier street: `bc` (bet, called), `xx` (checked through), `xbc`, `bxc`, … | the walk |
| postflop: situation | `first` (first to act), `after-x` (checked to), `vs-bet`, `vs-raise` | |
| facing size | `s` ≤ 40 %, `m` ≤ 80 %, `l` ≤ 125 %, `o` overbet (`facing_size_pot`'s meaning, STATS-SPEC §14.1) | |
| flop texture | `AK-high`, `Q-9-high`, `low`, `paired` × `mono` / `two-tone` / `rainbow` | the flop |

For each node, a count is kept per **action** (`f` `x` `c` `b` `r`, with `l` for an open limp) and per **own size bucket** (bets and raises). On the river, a called bet or raise whose cards are shown also gets a **showdown class**: `strong` (two pair or better using a hole card), `tp` (top pair or an overpair), `mid` (a weaker pair) or `air` (no pair, or only the board's pair).

### 3.2 Who

Every node row carries `who`: `pool` (a non-hero seat) or `hero`. The screen can then show **you, the pool and the reference** side by side. It can also measure whether the hero exploits a gap: for example, the hero's own river bluff frequency where the pool overfolds.

### 3.3 Storage

Rows per decision are not stored: at 1M hands that would be about 5.5M rows, and nothing needs them. Instead:

- **`mda_rollups`**: (`room`, `max_seats`, stakes as the big blind, month, `who`, node key, action, size bucket, showdown class) → count. Each hand contributes its decisions once. A version bump (`MDA_VERSION`, `mda/1`) clears and re-counts.
- **`mda_examples`**: up to 30 hand keys per (room, max seats, `who`, node key, action), kept by reservoir sampling, so a node opens real hands in the replayer.
- **`mda_counted`**: a cursor of hands already counted (`hand_key` and version), so new imports are counted incrementally.

The desktop puts these in a store migration (`rail_store`, beside `analysis_*`). The web puts them in a Supabase migration with owner-first readers (DATABASE.md "Owner first").

## 4. References

| Street | Reference | How |
| --- | --- | --- |
| Preflop | the shipped chart set for the table, or a set of the user's own (R5.3) | `reports.ts`' range reference at the node's chart line, card removal on, weighted by the pool's own decisions per node when nodes are summed (A3's rule) |
| Flop | the flop library of the line's chart set | precomputed: per line and texture, the bet share first-in and after a check, and fold, call and raise against each solved size, weighted over the representatives by mapped real flops. Generated by `tests/scripts/mda/references.test.ts` into `web/src/lib/mda/data/<set>.json`, keyed by the chart hash, so a chart change forces a regeneration (CI check) |
| Turn, river | theory | α against the facing size (bucket midpoint, or the exact size where shown), the break-even bluff share per own size; labelled "theory" in the UI |
| River showdowns | theory | as above |

Two caveats the UI must carry. The flop reference inherits the chart ranges: Rail's BB defends wider than common GTO charts, so its folds to a c-bet run higher. And a turn or river "theory" line is a bound, not a solver strategy: a capped range may correctly fold more than α.

## 5. Significance and exploits

- **Interval**: a Wilson 95 % interval on every frequency (`lib/stats/reliability.ts`).
- **Deviation**: a node deviates when its interval excludes the reference and the gap is at least 5 points. Under 50 chances a node is shown as "thin" and never deviates.
- **Exploit rules** (`web/src/lib/mda/exploits.ts`): a catalogue of about 30 rules. Each one maps a deviation in a node family to a sentence, an action and the hero's matching node. Examples:
  - fold above α against a size → bluff that size there;
  - bluff share below the break-even → fold bluff-catchers there;
  - an opener calling 3-bets too much → 3-bet for value and larger, with fewer pure bluffs;
  - the BB folding too much against an open → open wider from that seat.

  Rules are ranked by an EV proxy: the gap, times the chances per 100 hands, times the pot size at the node. The proxy is labelled as one.
- **The hero's side**: each exploit shows the hero's own frequency in the matching node. For example: "the pool folds 66 % to medium river bets; you bluff 9 % of your river bets there." It links to the hero's hands in that node, so it doubles as a study task (A8b) and a Learn link (L4 exploits).

## 6. What the user sees

The screen lives under **Analysis → Pool** (app first). It follows the clean-UI rules: no title, small figures, signed and coloured gaps, rows that look clickable.

- **Pool picker**: room × table size, stakes, date range, and a toggle to leave out spots against the hero.
- **Exploits**: the top five cards (§5), each with its numbers, interval, hero frequency and example hands.
- **Node explorer**: Preflop / Flop / Turn / River. Each row shows the pool %, the reference % with its source, the gap, n and the interval. A row expands into the action and size mix, the hero's line, and (on the river) the showdown composition by size.
- **A node's hands**: the reservoir opens in the replayer.

Per the owner's rule, the design is drawn on the map canvas (Ideas page) first, in two or three variants for the owner to pick from, and built only after that.

## 7. Phases

Each phase is one PR into `staging`, merged when green. Desktop-first; MDA6 brings the web.

| Phase | Delivers | Size | Depends on |
| --- | --- | --- | --- |
| **MDA1 — counting engine** | `web/src/lib/mda/`: the walk (study's `mda_walk.py` ported: pot, sizes, positions, line, texture, showdown class), node keys (§3.1) over `nodeKey.ts` and `chartLineOf`, `MDA_VERSION`. Tests: pinned hands per node family; **parity with the study** on the owner's corpus export (counts per node equal to the Python walker's, held as a fixture of counts, never hands); the corpus run never throws. | M | — |
| **MDA2 — desktop storage and pass** | Store migration (`mda_rollups`, `mda_examples`, `mda_counted`) tested from every earlier version; a background step in the app's analysis runner (the same gate: not while a table is open, not during backfill; pages of 500, its own cursor, not tied to `analysis/N`); readers by pool filter; re-count on version bump. Bench: 1M hands counted in under 10 min on the M2 Pro, import throughput unchanged. | M | MDA1 |
| **MDA3 — references** | `tests/scripts/mda/references.test.ts` (flop library aggregates per line and texture; preflop through `reports.ts`); JSON per shipped set; a CI freshness check against chart hashes; the theory functions; the user's own chart sets as the preflop reference at runtime. | M | MDA1 |
| **MDA4a — design** | Canvas variants of the screen (§6) for the owner. | S | — |
| **MDA4b — screen** | `packages/ui/mda/` + the app route: picker, explorer, intervals, thin nodes, the node's hands in the replayer. | L | MDA2, MDA3, MDA4a |
| **MDA5 — exploits** | The rule catalogue, ranking, hero-side frequencies, study-plan tasks (A8b) and Learn links; the five-card summary. Validated on the owner's pools: every rule that fires is checked by hand against the study's tables. | M | MDA4b |
| **MDA6 — web** | Supabase migration (owner-first readers, pgTAP), the web worker's pass over `hands` (the analysis worker's pattern), the same screen from `packages/ui`. Also fixes the gap found on 2026-11-12: desktop-synced hands lack `hand_stats` on the web, tracked separately. | L | MDA4b |
| **MDA7 — player types** | Pools split by type (regular, recreational, unknown) from `player_rollups` thresholds (VPIP–PFR gap, hands ≥ 100), so each exploit can say which type it is about. | M | MDA5 |
| **Later** | Multiway nodes compared (needs a multiway reference); user-defined nodes as R2.10 predicates over decision events (Rust), once the events carry opener position, line and texture; turn references once a turn library exists. | — | — |

## 8. Open questions for the owner

1. **Desktop first, web in MDA6** — agreed? The owner's hands live in the desktop store.
2. **Preflop reference**: the shipped charts by default, plus the user's own chart sets (the private route for GTO Wizard charts). Rail never ships GTO Wizard data — agreed?
3. **Spots against the hero**: counted in the pool by default, as Hand2Note does, with a toggle to leave them out?
4. **Stakes**: one pool per room and table size, stakes as a filter (WePlay mixes NL50–NL200)? Or a pool per stake?
5. **Player-type thresholds** for MDA7: a proposal comes with MDA5's data.

## 9. Change log

- 2026-11-12 — Plan written after the study (§1). Scripts and results live outside the repo (`~/Projects/rail-learn-research/mda/`): the walker, the aggregation, flop-library references, and the report page published as a private artifact.

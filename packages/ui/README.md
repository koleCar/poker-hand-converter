# `packages/ui/` — `@rail/ui`, the shared UI package

The design system and the screens that the web app ([`web/`](../../web/)) and
the desktop app ([`app/`](../../app/)) both render: design tokens, base
controls, cards, chips, the replayer, statistic tiles and tables, the
win-rate graph, dialogs and overlays, the command palette, and whole screens
— Hands, Reports, Players, the session review and the user's own preflop
charts. One component renders in a Next.js page and in a Tauri webview, so a
hand, a report or a player looks the same on both surfaces.

It holds no data access, no framework code and no words of its own. A
surface supplies three things: the data (a `*Source` object), the words (a
`UiStringsProvider`) and the page around the screen.

The package's history and the per-folder reference table are in
[`docs/WEB.md`, "Shared UI package"](../../docs/WEB.md#shared-ui-package);
this README is the working summary.

---

## How it is consumed: source, not a build

```
             packages/ui  (TypeScript + CSS source, no build step)
              │                                    │
   "@rail/ui": "file:../packages/ui"     "@rail/ui": "file:../packages/ui"
              │                                    │
   web/  (Next.js: transpilePackages)     app/  (Vite alias + tsconfig paths)
   web/src/lib/db/*Source.ts              app/src/lib/*Source.ts
   Supabase under RLS                     Tauri IPC → the local SQLite store
              │                                    │
              └──────────── model/ ◀───────────────┘
                 re-exports web/src/lib/{phf,replay,cards,stats} types
```

- Both consumers list `"@rail/ui": "file:../packages/ui"`, so `npm install`
  links the folder into their `node_modules/@rail/ui` and their bundlers
  compile it. There is no `dist/`.
- Imports are by path: `@rail/ui/replayer/ReplayViewer`,
  `@rail/ui/hands/HandsScreen`, `@rail/ui/tokens/semantic.css`.
- The web lists it in `transpilePackages` (`web/next.config.ts`); in
  development Turbopack's root is the repository so it can serve files from
  here. The desktop app resolves it with an alias in `app/vite.config.ts` and
  `paths` in `app/tsconfig.app.json`. The test harness aliases it in
  `tests/vitest.config.ts`.
- React comes from the consumer. The package's own `node_modules` holds only
  dev tools and React's types.
- **After changing `package.json` here**, run `npm install` in `web/` and
  `app/` so their lockfiles carry the new manifest (`npm ci` does not fail
  when they drift).

---

## What is in it

| Folder / file | What it is |
| --- | --- |
| `tokens/` | The one token layer: `primitives.css`, `semantic.css`, `theme-light.css`, `motion.css`, and `density.css` (comfortable / compact, imported by the desktop app only). Each file declares its own `@layer tokens`. |
| `styles/controls.css` | Global base controls: `.muted`, the `.btn` family, `.icon`, `.chip-btn`; touch sizes under `@media (pointer: coarse)`. |
| `cards/` | `PlayingCard`, `CardRow`, the suit glyphs (`cards.css`). |
| `chips/` | `Chip` and `FilterChips` (a filter as one row of chips). |
| `replayer/` | The replayer: `ReplayViewer`, table, seats, bets, pot, board, controls, sheets (hand info, action log, shortcuts), pot odds, settings; the container-query layout in `replayer.css`. |
| `overlay/`, `icon/`, `dialog/` | The `<dialog>` overlay the replayer's sheets use; the stroke icon set; the desktop app's modal dialog. |
| `stats/` | `StatTile`, `StatTable`, `StatValue` (a value dimmed by its reliability, sample and interval in the tooltip), `WinrateGraph` (total, showdown, non-showdown, all-in EV; big blinds or money) and its axis maths. |
| `hands/` | The Hands screen: `HandsScreen`, the virtualised `HandList`, `FilterBar` / `Popover` / `SavedFilters`, `filter.ts` (filter state, presets, saved form), `useHandList`, `model.ts` (`HandsSource`). |
| `reports/` | The Reports screen: `ReportsScreen`, `Breakdown` (also used by the app's player profile and HUD popup), `HandMatrix` (13 × 13 grid), `useReport`, `model.ts` (`ReportSource`). |
| `players/` | The Players screen: `PlayersScreen`, `PlayerTable`, `PlayerProfile`, `PlayerWords` (colour, labels, note), `model.ts` (`PlayersSource`). |
| `review/` | The session review: `SessionReviewScreen`, `select.ts` (each list ranked, a hand shown once), `model.ts` (`SessionReviewSource`, `DeviationSource`). |
| `charts/` | The user's own preflop charts: `ChartsScreen`, `ChartEditor`, `ChartGrid`, `ChartCompare`; pure modules for the stored shape (`model.ts`), situation keys (`nodeKey.ts`), range text in and out (`ranges.ts`), Rail JSON (`exchange.ts`), the comparison (`compare.ts`); `source.ts` (`PreflopChartsSource`) and `sessionSource.ts` (`SessionChartsSource`, "off your own charts" in the review). |
| `palette/` | `CommandPalette` (the shell: field, grouped list, keys, hints) and `fuzzy.ts` (`fuzzyMatch`, `rankItems`). What it finds is the surface's. |
| `data.tsx` | `DataSource` (`hand(id)`), `DataSourceProvider`, `useHand`. |
| `i18n.tsx` | `UiStrings` (every word the components show), `UiStringsProvider`, `useUiStrings`. |
| `strings/` | Data, not components: the English and Croatian dictionaries for the replayer, stats, hands, reports, players, review and charts, and the Croatian `plural`. Both surfaces spread these into their own dictionaries, so the text is identical. |
| `model/` | The one door out: re-exports of the web's framework-free library (`phf.ts`, `replay.ts`, `cards.ts`, `stats.ts` types, `replayStrings.ts`). |
| `screens/` | Two Playwright scripts, not part of the package: `screens.mjs` (before/after screenshot and cascade comparison of the web, R2.6) and `responsive.mjs` (the phone check at 375 × 812 against a local stack). |

---

## How a surface plugs in

Every screen that needs data takes a source object; the screen computes
nothing a source can answer and never knows where the data lives.

| Interface | Screen | Web implementation | Desktop implementation |
| --- | --- | --- | --- |
| `DataSource` (`data.tsx`) | anything that loads a hand by id | `web/src/lib/db/dataSource.ts` | `app/src/lib/dataSource.ts` |
| `HandsSource` (`hands/model.ts`) | `HandsScreen` | `web/src/lib/db/handsSource.ts` | `app/src/lib/handsSource.ts` |
| `ReportSource` (`reports/model.ts`) | `ReportsScreen` | `web/src/lib/db/reportSource.ts` | `app/src/lib/reportSource.ts` |
| `PlayersSource` (`players/model.ts`) | `PlayersScreen` | `web/src/lib/db/playersSource.ts` | `app/src/lib/playersSource.ts` |
| `SessionReviewSource` (`review/model.ts`) | `SessionReviewScreen` | `web/src/lib/db/sessionReview.ts` | `app/src/lib/reviewSource.ts` |
| `PreflopChartsSource` (`charts/source.ts`) | `ChartsScreen` | `web/src/lib/db/preflopCharts.ts` | `app/src/lib/chartsSource.ts` |

What a source cannot do it declares instead of faking:

- `HandsSource.features` says whether it has tags and notes
  (`annotations`), the searches (`search`), which sorts and which extra
  filters (`more`); the screen hides the rest. The web has the searches and
  no tags; the desktop has tags, notes and saved filters but not the web's
  extra searches.
- `PlayersSource.features` says whether colours and labels exist; the web
  keeps neither (they are the desktop app's, not synced), so the screen
  leaves them out.
- `onChanged` (optional) lets a source tell the screen that hands arrived —
  an import or sync on the desktop, a Realtime signal on the web.
- `ReportSource.graphPoints`: the local store draws about one point a pixel,
  the server cuts fewer.

Statistics arrive as `Shown` values (the definitions in `config/stats/`
evaluated with their reliability): the web computes them with `showStat` in
TypeScript, the desktop gets the same shape from `rail_stats` over IPC. The
package only displays them.

Words: a surface mounts one `UiStringsProvider` with the slices of its
dictionaries (`web/src/lib/i18n/ui.ts` on the web; the app's own dictionary
on the desktop). A missing key is a type error in the surface.

During play (amendment A10) a surface can hide what could help at the table:
for example `SessionReviewScreen`'s `hiddenDuringPlay` renders and reads
nothing of the review while the desktop app has a poker table open.

---

## Rules

Enforced by `eslint.config.js`, `stylelint.config.js` and `tsc`; reasons in
[`docs/WEB.md`, "The shared UI package stays shareable"](../../docs/WEB.md#4-the-shared-ui-package-stays-shareable).

1. **No backend, no framework.** No imports of `next`, `next/*`,
   `server-only`, `client-only`, `@supabase/*` or `@tauri-apps/*`. A
   component that fetches goes through a source or the `DataSource`.
2. **One door out.** The package reaches outside itself only through
   `model/`; imports of `web/**`, `app/src/**` or `@/*` elsewhere are errors.
   `model/` re-exports `web/src/lib/{phf,replay,cards,stats}`, which is why
   that layer of the web must stay framework-free: a framework import there
   would break the desktop app's bundle and the test harness.
3. **No user-facing literals** in `.tsx`: bare JSX text and literal `alt`,
   `title`, `placeholder`, `aria-label`, `aria-description`,
   `aria-placeholder` are errors. Add the word to `UiStrings` and both
   languages in `strings/`, or take it as a prop.
4. **Tokens, not shades.** No primitive tokens (`--n-800`) and no raw hex
   outside `tokens/` (the unthemed felt, cards and chips are the stated
   exceptions). New components use **CSS Modules**; the global sheets that
   moved here (controls, cards, replayer, overlay, stat tile, graph) keep
   their BEM class names, because renaming them would be a rewrite of tuned
   layout.
5. **It shows, it never computes statistics.** No formula over counters in a
   component; `tests/test/statDisplay.test.ts` scans this package too.
6. **Cascade position is load-bearing.** The web imports the tokens from
   `index.css` and `controls.css`, `cards.css` and `replayer.css` from
   `styles/app.css` in a fixed order. Moving a sheet between the web and the
   package is a move of `@import` lines, never a reordering. Never use
   `@import "…" layer(tokens)`: the Next build turns it into an invalid media
   query and the page renders unstyled.

---

## Checks

```bash
cd packages/ui
npm install
npm run lint        # ESLint: the rules above
npm run lint:css    # stylelint: token rules
npm run typecheck   # tsc -p tsconfig.json (strict)
```

CI job **"Shared UI package"** runs those three. The consumers check it
again under their own settings: the web job typechecks and builds the pages
that import it, and the desktop app's job typechecks it under the app's
`tsconfig.app.json` (which, like the web, leaves `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes` off since R2.7a). The
shared screens' behaviour is tested in `tests/` (for example
`tests/test/sharedHandsScreen.test.ts`, rendered with the web's React).

Visual checks, by hand, against a running web (see each script's header):

```bash
cd packages/ui/screens && npm ci && npx playwright install chromium
node screens.mjs capture http://localhost:3100 out/base-1     # then compare runs
node responsive.mjs http://localhost:<port>                   # phone layout; needs a local test account
```

`responsive.mjs` signs in with a test account given in environment variables
and refuses any host but a local one.

## Changing it

Edit here and both surfaces pick it up on their next build or reload. A
change that touches what a screen asks for changes its `*Source` interface:
update both implementations (`web/src/lib/db/`, `app/src/lib/`) in the same
pull request. New words go into both `strings/*.en.ts` and `*.hr.ts`.

## Further reading

- [`docs/WEB.md`, "Shared UI package"](../../docs/WEB.md#shared-ui-package) — the per-folder reference and how the web consumes it.
- [`docs/RAIL-PLAN.md`](../../docs/RAIL-PLAN.md) — R2.6 (the move), R4.5 (shared screens on the web), R5.x (review and charts).
- [`docs/STATS-SPEC.md`](../../docs/STATS-SPEC.md) — what a displayed statistic and its reliability mean.

# Rail tutorial videos

One short video per feature, made from real screenshots of the real app,
animated with [Remotion](https://www.remotion.dev): the camera pans and zooms
to what a step is about, a pointer moves and clicks, highlights and callouts
point at controls, and a caption at the bottom says what the UI does. English
captions, no voice; 1920 × 1080 at 30 fps, roughly 45–120 s each.

The compositions use the same slugs as the user guide ([`docs/GUIDE.md`](../docs/GUIDE.md)):

| Composition | What it shows | Captured from |
| --- | --- | --- |
| `getting-started` | signing in or continuing without an account, the tabs and the menu | web |
| `convert` | dropping files, the results, a preview, a pasted hand, manual entry | web |
| `library` | the hand history, filter chips, searches, order, a hand beside the list | web |
| `replayer` | stepping through a hand, pot odds, the result, settings, sharing | web |
| `stats` | summary, win-rate graph, statistics, breakdowns, starting hands, sessions | web |
| `players` | opponent statistics, the list, a profile, a note, hands together | web |
| `analysis` | grades, coverage, flags, leaks, the hands list, one hand's sheet | web |
| `analysis-session` | the session review (a part of Analysis, split for length) | web |
| `analysis-leaks` | leaks, the weekly plan, progress (a part of Analysis) | web |
| `analysis-charts` | Rail's charts, your own charts, the trainer (a part of Analysis) | web |
| `learn` | the course, a lesson, a checkpoint, practice, placement, review | web |
| `community` | the forum, a hand thread, publishing a hand, a post, notifications | web |
| `account` | settings, the plan, downloading your data, deleting the account | web |
| `desktop-setup` | the desktop app's first launch: sign-in, folders, import, sync | desktop app |
| `desktop-app` | the desktop screens day to day: Today, Hands, Reports, Players, Analysis, palette, preferences | desktop app |
| `hud` | the HUD on a table, each room's rules, the HUD screen, the popup | HUD renderer + desktop app |
| `hud-editor` | presets, your own panel, the preview, which design each table gets (a part of HUD) | desktop app |

## How it works

```
npm run stack       a local Supabase stack of its own (rail-tutorials, ports 5542x)
npm run demo-data   demo hands with made-up names, demo accounts, hands loaded, stats + analysis run
npm run capture     Playwright drives the real UI: a PNG per step + the boxes it points at
npm run studio      Remotion Studio: watch and tweak every composition
npm run render      out/<slug>.mp4
```

- **`capture/`** - Playwright scripts, one per tutorial (`capture/web/<slug>.ts`,
  `capture/desktop/capture.ts`, `capture/hud.ts`). Each step's screenshot
  and the bounding boxes of the elements the video points at go to
  `public/captures/<slug>/` with a `manifest.json`. Screenshots are taken at
  device scale 2, so the video can zoom in and stay sharp.
- **`src/`** - the Remotion project. `src/scripts/<slug>.ts` is a tutorial's
  script: chapters of steps, each naming a shot, the target to frame, where
  the pointer goes, what to highlight, the caption and how long it stays.
  The shared components (`TitleCard`, `Shot`, `Stage` with the camera,
  `Cursor` and `ClickRipple`, `Highlight` with callouts, `Caption`,
  `StepBadge`, `Outro`) paint with Rail's own design tokens - the sheets of
  `packages/ui/tokens/` are imported, not copied - and Rail's Inter.
- **The web app** runs as `next dev` on port 3100 against the tutorials'
  stack, with every variable passed explicitly (the stack's URL and anon
  key, Cloudflare's test Turnstile key, Google sign-in off). A `web/.env`
  or `.env.local` would be read by Next.js, so the scripts refuse to start
  when one exists.
- **The desktop app** runs as its own Vite dev server (port 1520) in a plain
  browser; `capture/desktop/tauri-mock.ts` makes `@tauri-apps/api` believe it
  runs in Tauri and answers every IPC command those screens call with
  made-up data shaped by `app/src/lib/ipc.ts`. Nothing under `app/` changes.
- **The HUD** is drawn natively over a poker client and is never
  screen-recorded. `cargo run -p rail-hud --example scene_svg` composes the
  real renderer's frames (`rail_hud::scene`: the same layout, colours, room
  restrictions and compliance as the overlays) for a few demo tables and
  writes them as SVG - a drawn table and the overlay - which the capture
  turns into PNGs and the video fades the overlay in on.

## Demo data, and why it matters

The repository is public and so will the videos be: **no real person's data
may appear in any frame.**

- The hands come from the corpus already in the repository (`weplay-hh/`:
  one account's real sessions, so the statistics and the analysis are
  real). `scripts/demo/generate.ts` reads every file with the Rust core,
  gives every player a made-up name from the table simulator's word lists
  (the same name in every file, so a regular stays one player), names the
  hero `RailDemo`, drops chat lines and anything that looks like an e-mail
  address, moves the hands in time so the newest is two days old, and
  writes neutral file names. Each rewritten file is read again and must
  give exactly the same hands (seats, stacks, cards, actions, amounts,
  board, winners) with only the names changed; a file that does not, or
  that still contains an original name, is left out.
- Everything generated is gitignored (`tutorials/.gitignore`): `.stack/`,
  `.demo/` (hand files, the demo name set, the list of original names,
  sessions), `public/captures/`, `public/fonts/` and `out/`. Never commit
  screenshots, demo hand files or videos.
- Every shot goes through a **name guard** (`capture/lib/guard.ts`) before it
  is written: the capture fails if the page's text contains any original
  name from the corpus, or if a place that shows players' names holds a
  name outside the demo set.
- The demo accounts (`demo@rail.test` as RailDemo, `friend@rail.test` for
  the forum, `new@rail.test` for the first-visit videos) exist on the
  tutorials' own stack only.

## Running it end to end

Needs Docker, the Supabase CLI, Node 22.18+ and Rust (for the converter and
the HUD example). `web/` and `app/` need their own `npm ci` once.

```bash
cd tutorials
npm ci                         # uses the Chromium Playwright already cached; set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 to be sure
npm run stack                  # copies supabase/ to .stack/, project rail-tutorials, ports 5542x
npm run demo-data              # ~30-40 min the first time (the analysis runs in the browser)
npm run capture                # all tutorials; or: npm run capture -- stats replayer
npm run studio                 # http://localhost:3000
npm run still -- stats 300     # one frame to out/stats-300.png
npm run render -- stats        # one video to out/stats.mp4
npm run render                 # every video (weekdays 08-16 Zagreb time: one at a time, unless --force)
npm run stack -- stop          # stops this stack only; its Docker volumes stay
```

`npm run demo-data` is safe to run again: the converter skips hands already
saved and the forum is seeded once. `npm run demo-data -- --no-load` only
writes the demo files. A capture that fails says which shot and which
target; `node capture/lib/web.ts` keeps the web dev server up between runs.

Renders use the Chrome headless shell Playwright keeps in
`~/Library/Caches/ms-playwright`, so Remotion downloads no browser; set
`REMOTION_BROWSER` to use another.

## What is approximated

- The desktop app's data is made up by the IPC mock (no real store behind
  it); the HUD editor's live preview, which the real app gets from the HUD's
  renderer, is drawn by the mock at the same geometry.
- The HUD frames are the real renderer's, over a drawn demo table rather than
  a poker client; no room's real client layout is measured yet, so the
  simulator's table geometry is used - as the HUD itself does today.
- The local stack has no flop library, so the analysis grades the flop by its
  heuristics only (as any deployment without the library does).
- Two cosmetic changes are made to captured web pages: the dev server's
  indicator is hidden, and Cloudflare's test Turnstile widget is cut to
  its production height (the test widget prints "for testing only" under
  itself).

## Licence

**Remotion is not open-source software in the usual sense.** It is free
for individuals and for companies of up to three people; a larger company
needs a company licence (https://www.remotion.dev/license). The owner must
check which applies before these videos are published. The fonts are
Inter (SIL Open Font License 1.1, copied from `web/public/fonts/` with its
licence).

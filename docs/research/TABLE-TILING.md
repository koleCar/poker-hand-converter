# Table tiling and the RNG overlay

The owner's request (2026-11-11): arrange every open poker table, from every
room the user plays, into a grid on Windows and macOS. Tables sit exactly
side by side, all of them visible, or in a layout the user designs. Also add
an RNG in the corner of each table, like Jurojin's.

This file covers three things: what Jurojin does, how Rail would do it on top
of the HUD process that already exists, and the steps to build it. Nothing
here is built yet.

---

## 1. What Jurojin does (read 2026-11-11)

Sources: <https://jurojinpoker.com/solution/table-manager>,
`/solution/stack-and-tile-feature`, `/solution/action-required-tiling`,
`/solution/how-to-switch-layout`, `/solution/precise-slot-size`,
`/solution/random-number-generator`, `/solution/overlays-quick-tour`,
`/pricing`.

**Platform:** Windows 10 and 11 only. There is no macOS build, so on macOS
Rail would have no direct competitor here.

### Layouts and slots

A **layout** is a saved profile made of **slots**: rectangles with a position
and size on one monitor. Any slot can hold one table or a stack of them.

| Slot | Kind | What it holds |
| --- | --- | --- |
| Playing | static | the primary tables |
| Observer | static | a second area, e.g. the tables of a second room |
| Lobby | static | the room's lobby window |
| Action Required | dynamic | a table moves here while it is hero's turn, and back afterwards |
| In-Hand | dynamic | a table moves here while hero is in the hand, and back on fold or after showdown |

The In-Hand trigger is chosen per room: VPIP, a new hand with hero dealt in,
or the flop.

### Other tiling features

- **Stacking.** When an Action Required slot holds a stack, the most urgent
  table is on top. Without stacking, one table at a time and the rest wait in
  their slots.
- **Layout switching.** A hotkey per layout, plus automatic rules by the
  number of open tables (e.g. 2 big slots, 3 medium from the 3rd table, 4 slots
  from the 4th).
- **Exact slot size.** Some rooms lock the aspect ratio or only accept certain
  widths (Winamax and Chico are named). The client then overrides the size it
  is given. Jurojin's fix is to place one table by hand and save a slot from
  that window.
- **Per room:**
  - tiling can be switched off;
  - "do nothing" with newly opened tables;
  - a set of rooms where tiling is not supported at all (Unibet, Run It Once,
    PPPoker and others).

### RNG overlay

- A number from 0 to 100 on every table.
- The user defines ranges with colours, e.g. 0–30 fold, 31–60 call, 61–100
  3-bet.
- The user also picks when a new number rolls. "Roll on my turn" is a paid
  feature.
- It lives in the same overlay module as pot odds, SPR and the action line.
  Each overlay can be moved, and its position is copied to the other tables.

### Business model, for reference

- Free at micro stakes (NL10, MTT $5, Spins $3).
- Above that, tiling is $12.5 a month on the annual plan.
- In free mode: one layout, no automatic switching and no dynamic slots.

---

## 2. What Rail already has

The HUD process (`hud/rail-hud`) already does most of the hard platform work
that tiling needs:

| Needed for tiling | Already in Rail |
| --- | --- |
| Find the table windows of every room | `Platform::find_tables` + `platform/matcher.rs` (process + title regex per room), every 500 ms plus hooks |
| Follow moves, resizes, minimise, z-order | `platform/tracking.rs`, WinEvent hooks, `AXObserver` |
| Move and resize another process's window | Proven in the test drivers: `platform/windows/drive.rs` (`SetWindowPos`), `platform/macos/drive.rs` (Accessibility) |
| macOS permission | Accessibility is already the HUD's one permission. Moving windows needs nothing more |
| DPI and coordinates | `DpiAwareness`, `dpi_permille`, physical-pixel rectangles |
| Overlays that follow a table | Already follow every move, so tiled tables keep their HUD |
| Per-room policy as data | `config/sites.json` `hud.allowed` + restrictions; unknown means no |
| A layout table that syncs | `hud_layouts` (kind, key) in the local store and Supabase |
| Simulator windows for CI | `rail-hud-sim` opens real windows titled like a room's tables, on both OSes |

**The blocker it shares with the HUD:** no real client is attached yet. Every
room's `tables.title` and `tables.process` in `config/sites.json` is `null`
until the owner captures them ([`CAPTURING-TABLES.md`](CAPTURING-TABLES.md)).
Tiling can be built and tested on the simulator, but it cannot touch a real
table until those titles exist.

---

## 3. Policy: tiling and RNG are separate permissions

Tiling and the RNG are not a HUD, so `hud.allowed` must not decide them.
Example: GGPoker refuses HUDs (`hud.allowed: false`), but tiling its tables
may still be allowed. Each room needs its own entries next to `hud`, as data,
with a source and a date, and unknown means no, as for the HUD:

```json
"tiling": { "allowed": null, "source": null, "checkedAt": null, "notes": null },
"rng":    { "allowed": null, "source": null, "checkedAt": null, "notes": null }
```

What is already known:

- **partypoker** permits only a whitelist of ten table and caption tools
  (Jurojin, StackAndTile, Table Tamer and others). Any other tool is prohibited
  while the client runs ([`HUD-POLICIES.md`](HUD-POLICIES.md)). So Rail's
  tiling there is `false` unless Rail gets onto that list.
- **Unibet** says "No 3rd party software is allowed", which gives `false` for
  both.
- **The rest** need reading:
  - PokerStars, GGPoker, Winamax, ACR, iPoker, 888, Chico, WePlay, CoinPoker.
  - The RNG in particular: some rooms treat any real-time decision aid as
    prohibited.

Mechanically, the engine already finds the windows of refused rooms (it
answers `attach_refused`). Tiling would act on a window when
`tiling.allowed` is true, whatever `hud.allowed` says. The RNG would draw an
overlay that carries only the RNG, under its own permit.

---

## 4. Design

### 4.1 Where it runs

Tiling runs in the HUD process. It already owns the table windows, their
tracking and the platform code, and it is the process that keeps running
while the user plays. The app stores layouts and settings and sends them
over the existing IPC.

```
app (rail-app)                         rail-hud
  Tables screen: layouts, RNG  ──IPC──► engine ─► tiling.rs (pure: slots, assignment, fit)
  store: hud_layouts kind 'tiling'          │        │
                                            │        ▼
                                            │   Platform::place(window, rect)
                                            │   Platform::monitors()
                                            └─► scene.rs: RNG widget in the overlay
```

### 4.2 Platform additions (`platform/mod.rs`)

```rust
fn monitors(&mut self) -> Vec<Monitor>;          // id, work area (no taskbar / menu bar / Dock), dpi
fn place(&mut self, id: WindowId, want: Rect) -> Result<Rect, PlatformError>; // returns the rect the client accepted
```

- **Windows:**
  - Monitors: `EnumDisplayMonitors` + `GetMonitorInfo` (`rcWork`).
  - Placing: `SetWindowPos` with `SWP_NOACTIVATE | SWP_NOZORDER |
    SWP_ASYNCWINDOWPOS`, so a hung client never blocks the HUD (the overlay
    code already guards against that wait).
  - Minimised tables are restored first.
  - Per-monitor DPI v2 is already handled.
- **macOS:**
  - Monitors: `NSScreen.visibleFrame`, flipped to the window-server's
    top-left coordinates.
  - Placing: `AXUIElementSetAttributeValue` with `kAXPositionAttribute`, then
    `kAXSizeAttribute`, then read both back.
  - Full-screen tables (their own Space) are left alone.
- **Sim:** records the placements, so the whole engine runs headless in CI.

### 4.3 The tiling engine (`tiling.rs`, platform-free)

**Layout** = `{ id, name, slots[], autoSwitch? }`.

**Slot** = `{ id, monitor, rect in thousandths of the work area, kind, rooms?, stack: bool }`.

- `kind`: `play | lobby` in the first version. `action | in_hand` come later
  (§4.6).
- `rooms`: an optional filter, which does the job of Jurojin's Observer slot
  ("this area is for Winamax").

**Layout sources:**

1. **Auto grid** (the default, and the request's main case).
   - Input: N tables and the chosen monitors.
   - The engine picks the rows × columns that give the largest table size,
     keeping each room's aspect ratio. It spreads across monitors, filling
     the largest first.
   - It recomputes when a table opens or closes, so "all tables visible,
     perfectly side by side" needs no setup.
2. **User layouts**, drawn in the app's editor.
3. **Captured from the open tables.** The user arranges tables by hand and
   presses "Save as layout": one slot per window.

**Assignment:**

- A new table takes the first free slot that accepts its room. When all slots
  are full, it stacks on the slot holding the fewest tables.
- A closed table frees its slot.
- Optional "close gaps": move the last table into the hole.
- **Stable by default.** A table that has a slot never moves just because
  another table opened. Exception: the auto grid when its row or column count
  changes.

**Fit:**

- Each room has an aspect ratio and a minimum size. These are new data in
  `sites.json` `tables.geometry`, measured during capture.
- The table gets the largest rect with that aspect ratio that fits the slot,
  centred in it.
- After `place`, the engine reads the real rect back. When the client refused
  the size (Winamax, Chico), it keeps the client's size and centres it. It
  never fights the client in a loop: at most one retry per placement.

**Safety rules (misclicks cost money):**

- Never move a table while a mouse button is down, or within 600 ms of the
  user's last click on any table.
- Re-tiling waits for those quiet moments; a placement queued meanwhile is
  coalesced.
- A table the user dragged by hand is pinned where it is, until the next
  "Re-tile" (hotkey or tray).
- Tiling is off until the user turns it on. Turning it off leaves windows
  where they are.

**Layout switching:**

- Automatic rules by table count (`autoSwitch: [{ minTables: 3, layout }]`).
- A global hotkey per layout through Tauri's global-shortcut plugin. This
  comes later, together with the other hotkeys.

### 4.4 RNG overlay

- **Look:**
  - A small, borderless widget. The default spot is the table's top-right
    corner.
  - It can be dragged, and the position is stored per room and table size,
    like seat panels (`layout.rs`).
  - It shows one number, large, coloured by the user's bands.
- **Number:** 1–100 by default; 0–99 is an option.
- **Randomness:**
  - Comes from the OS CSPRNG (`getrandom`), mapped to 1–100 by rejection
    sampling, so there is no modulo bias.
  - Each table rolls independently.
  - Never the deterministic `Mulberry32` the analysis uses.
- **Bands:**
  - A list of `{ upTo, colour, label? }`.
  - Default: three bands with no labels, in neutral colours. The user names
    them.
- **When it rolls:**
  1. **On every new hand at that table.** Rail only learns a hand ended when
     the room writes it, so the roll comes when `hand_imported` for that table
     arrives. That is close to the start of the next hand: seconds, not the
     instant the cards are dealt.
  2. **On a click** on the widget.
  3. **On a timer** every N seconds.
  4. **On a global hotkey** for all tables (later).
- **Not in the first version:** "roll on my turn" needs live turn detection
  (§4.6).
- **Where it draws:** a new element in `scene.rs` / `OverlayFrame`. On a room
  where the HUD is refused but `rng.allowed` is true, the overlay is attached
  with an RNG-only permit, and the seat panels are never drawn.

### 4.5 App: Tables screen

The design comes first on the map canvas (Ideas page), as for every screen.

- **Monitors.** A miniature of each monitor with its slots. The user drags to
  draw or resize slots, and live tables show as labelled boxes.
- **Layout picker.** Auto grid, the user's layouts, or "Save current
  arrangement".
- **Per room:** tiling on or off, and the RNG on or off. Both are greyed out
  with the reason when the room's policy forbids them.
- **RNG settings:** range, bands, when it rolls, size and opacity.
- **Re-tile:** a button, plus a tray entry.

**As built (T5, design A):** a sidebar item "Tables" between HUD and Import
(`app/src/screens/Tables.tsx`), free like the rest of tiling.

- The HUD's `tiling_status` carries the monitors (in layout order, sent
  on or off once the app has sent its settings) and each tiled table's
  **outer rect** (frame included), name, monitor, stacked and pinned;
  places-only changes go at most 4 times a second.
- The rooms' tiling and RNG verdicts come from `hud_policy`
  (`tiling` / `rng`: `permitted`, `needsApproval` - a refusal whose notes
  begin "Not permitted without approval"), so the window repeats no rule.
- "+ Layout" saves the current arrangement: `capture_layout` →
  `layout_captured`, one slot per place in thousandths of the monitor's
  work area, stackable; the layout goes in force at once. Rename and
  delete are in the layout's ⋯.
- **Slot editor (T5 follow-up):** "+ Layout" → "Draw slots", or a
  layout's ⋯ → "Edit slots" / "Duplicate". The editor takes the
  displays' place: one display's work area to its shape (a 1920×1080
  stand-in until the HUD reports monitors), drag to draw, move, resize
  with handles, snap to a 1/24 grid and the other slots' edges, the fill
  order shown as numbers (‹ › to reorder), "Stack" and a room filter per
  slot, arrows / Shift + arrows / Delete on the keyboard. Slots are
  stored as `SlotRect` thousandths; overlaps are allowed, as
  `settings.rs` allows them. "Save" overwrites, "Save as new" adds a
  layout and puts it in force. `app/src/screens/tables/slots.ts` mirrors
  `Layout::validate` / `TilingSettings::validate`.
- **Switch by table count:** "N or more tables → layout", written to
  `TilingSettings.autoSwitch`; the rule the open tables reach is marked.
  The engine reads the layout in force's own `Layout.autoSwitch` first
  when it has any; the app never writes those, and a layout that comes
  with its own shows a line offering to drop them.
- **Not yet:** the RNG's range (0 - 99), size and opacity, a per-room RNG
  switch.

**Storage:**

- Layouts go into the existing `hud_layouts` table under a new kind
  `tiling`, so they sync to a second machine.
- RNG settings use kind `rng`.
- Monitor ids differ between machines. A layout whose monitor is missing falls
  back to the primary monitor and scales.

### 4.6 Later: dynamic slots (Action Required, In-Hand)

These need to know, live, that it is hero's turn or that hero is in the
hand. Rail deliberately reads nothing about the hand in play today (the HUD
reads only the store). There are two possible signals:

- **The room's own window signals (preferred).**
  - Many Windows clients flash the taskbar button or bring the table forward
    when it is your turn. A shell hook (`RegisterShellHookWindow`,
    `HSHELL_FLASH`) and `EVENT_SYSTEM_FOREGROUND` see that without reading
    the table.
  - It must be verified room by room on real clients.
  - On macOS the equivalent signals are weak (Dock bounce, window order).
- **Reading pixels of the action buttons.**
  - Needs Screen Recording on macOS.
  - It is exactly the kind of real-time reading some room policies forbid.
  - Not recommended.

Recommendation: ship static tiling and the RNG first. Decide on dynamic slots
only after static tiling runs on real clients and the per-room signals have
been checked.

---

## 5. Steps

Plan-style, one PR each into `staging`. They run on the simulator in CI on
macOS and Windows.

| Step | What | Size | Depends on |
| --- | --- | --- | --- |
| **T0** | Policy: `tiling` and `rng` entries in `sites.json` for every room, quoted and dated in `HUD-POLICIES.md` (or a sibling `TILING-POLICIES.md`); schema + loader; compliance gives a `TilingPermit` and an `RngPermit` | S | — (owner reviews the verdicts) |
| **T1** | `Platform::monitors` + `Platform::place` on Windows, macOS and sim; tests that move simulator windows on both OSes; read-back of the accepted rect | M | — |
| **T2** | `tiling.rs`: auto grid, slots, assignment, fit with aspect ratio, stability, safety rules (mouse quiet), auto-switch by count; unit tests + sim scenario with 12 tables over 2 monitors | M | T1 |
| **T3** | IPC `tiling_changed`, `retile`, `rng_changed`; store kinds `tiling` / `rng` in `hud_layouts` + sync; tray "Re-tile" | S | T2 |
| **T4** | RNG widget in `scene.rs` + both overlay backends; CSPRNG; triggers: new hand, click, timer; drag + stored position; RNG-only permit | M | T0, T3 |
| **T5** | Tables screen in the app: monitor preview, slot editor, layout picker, per-room switches, RNG settings. Canvas design first, owner approves | M | T3 |
| **T6** | Real clients: capture titles, processes and table geometry (`CAPTURING-TABLES.md`); check tiling + RNG on each room ([`REAL-CLIENT-CHECK.md`](REAL-CLIENT-CHECK.md)) | — | owner's machines (Windows test machine) |
| **T7** | Later, after T6: global hotkeys; dynamic slots from the rooms' own window signals | L | T6 |

## 6. Open questions for the owner

1. **Policy verdicts.** Tiling and the RNG on partypoker are `false` unless
   Rail applies to their whitelist. Should Rail apply?
2. **Pricing.** Jurojin gives tiling away at micro stakes and charges $12.5 a
   month above that. Is Rail's tiling free, or part of a paid entitlement
   (`entitlements.rs`)?
3. **RNG default.** 1–100 with three unnamed bands, or 0–99?
4. **Real clients.** T6 needs the window captures on Windows and macOS that
   the HUD is already waiting for.

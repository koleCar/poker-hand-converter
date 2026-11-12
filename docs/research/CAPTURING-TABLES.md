# Capturing a room's table windows on Windows and macOS

The HUD finds a table by its window: the program that owns it and its title
(docs/RAIL-PLAN.md R3.3, R3.11). For each room, `config/sites.json` says how
in its `tables` block - the process names (per system) and a title regex
whose `table` group is exactly the table name the room's hand histories
carry. Every `tables` block is `null` today: nobody has looked at a real
client's windows yet, and the HUD attaches to nothing until someone does.
This is how to look, on a Windows PC with the real clients, and how the
result becomes `sites.json`; the Mac's differences are in
[On macOS](#on-macos-r311).

Two policies make a room worth capturing, and a room needs its `tables`
block for either:

| Room | HUD (`hud.allowed`) | Tiling (`tiling.allowed`) | Capture for |
| --- | --- | --- | --- |
| PokerStars | true | true | HUD + tiling |
| ACR | true | true | HUD + tiling |
| Winamax | true | false | HUD only (never tiled) |
| WPT Global | false | true | tiling only |
| CoinPoker | false | true | tiling only |

(R3.0, [`HUD-POLICIES.md`](HUD-POLICIES.md); T0,
[`TILING-POLICIES.md`](TILING-POLICIES.md).) The RNG is allowed on no room
yet, so it adds none. A room whose HUD is refused but whose tiling is
allowed (WPT Global, CoinPoker) still needs its process names and a title
regex - the tiler finds tables through the same matcher - but no seat
layouts (no panel is ever drawn there). Every other room (GGPoker,
partypoker, Unibet, 888poker, ...) is neither captured nor tiled.

Capturing a title is not attaching to it: `--list-windows` only reads
window titles and rects, as Task Manager does; it draws nothing and touches
no client. `--tile-check` (below) does move windows, once, and only those
of a room whose tiling policy is `true`.

**Privacy.** A title can name you: PokerStars-style titles end "Logged in
as <your name>", and a client may show your name in a tab or a seat. The
diagnostic redacts what it can (below), but **read every line before you
paste it anywhere**, and replace by hand anything that is yours and was
missed. Never paste a hand history, an opponent's name, an account id or an
e-mail address; from a hand history only the table name (`Table '...'`).

## The diagnostic

`rail-hud --list-windows` prints every visible top-level window that has a
title: its program, window class, title, client area (the part the table is
drawn in) in physical pixels, the monitor's and the window's dpi and its DPI
awareness, whether it is minimised or cloaked (on another virtual desktop),
the title's non-ASCII characters (an en dash looks like a hyphen), and -
once a room has a `tables` block - which room takes it and whether the HUD
may attach there.

For table tiling (T6) each window also shows:

- `frame:` its **outer rect** - on Windows the visible frame (DWM's
  extended frame bounds, without the invisible resize borders), on a Mac
  the whole window - and the **insets** around the client area on each
  side: exactly what the tiler lays edge to edge;
- `size:` whether it is **resizable** (Windows: the `WS_THICKFRAME` style;
  Mac: whether the client lets its size be set) and movable, and its
  minimum and maximum size where the system says so without asking the
  client - on Windows only the client knows them (`WM_GETMINMAXINFO`), and
  the Accessibility API has no such attribute, so `--tile-check` measures a
  refused size instead;
- `permits:` for a window a room's `tables` block takes, the room's three
  answers: HUD, tiling (`TilingPermit`) and RNG (`RngPermit`). Before the
  room has a block, `--try-title <regex> --room <id>` shows the same
  answers for each window the candidate regex takes.

```text
frame:   outer 1216x869 at (0, 0); insets left 8, top 31, right 8, bottom 8 (physical px; the visible frame)
size:    resizable yes, movable yes; min/max: not readable without a message to the client
         as wpt-global: HUD refused (the room prohibits it); tiling permitted; RNG refused (the room prohibits it)
```

Where to get it:

- **From the app**: `rail-hud.exe` is installed beside `Rail.exe` (a pull
  request's CI run has an unsigned installer to download; guideline §14).
- **From the source**: `cargo build --release -p rail-hud`, then
  `target\release\rail-hud.exe`.

Run it in a terminal (PowerShell or `cmd`):

```text
rail-hud --list-windows                                  every window with a title
rail-hud --list-windows --process PokerStars.exe         one program's windows
rail-hud --list-windows --process PokerStars.exe --you MyScreenName --you MyOtherName
rail-hud --list-windows --process PokerStars.exe --try-title "^(?P<table>.+?) - "
rail-hud --list-windows --process PokerStars.exe --try-title "^(?P<table>.+?) - " --room pokerstars
rail-hud --list-windows --help
```

**Redaction.** Anything after "Logged in as" (any case) becomes `<you>`, and
so does every screen name you give with `--you` (any case, anywhere in the
title) and every hero name in the app's store when the app has one on this
PC (`%LOCALAPPDATA%\app.rail.desktop\rail.db`, read-only; `--store <file>`
for another, `--no-store` for none). Names shorter than two characters are
not used. The output says how many names it redacted; it never prints them.

**`--try-title <regex>`** shows what a candidate title regex reads from each
window (`table` and `seats` groups), so a regex can be checked against the
real titles before it goes into `sites.json`.

If the program name shows as `? (could not be asked)`, the client runs with
higher rights than the terminal (run as administrator); run the terminal the
same way, or note it - the HUD will need the same.

## What to capture

For each room (PokerStars, ACR, Winamax, WPT Global, CoinPoker), with the
client's current version, logged in (play money where the room has it is
enough and the safest, P6):

1. **The client**: its version (the client's About box, or the `.exe`'s
   Properties, Details, File version) and the program name in the listing.
2. **The lobby and other non-table windows** of the client, once: the regex
   must not take them.
3. **One table of each kind the room has**, sitting or watching:
   - cash 6-max, cash 9-max (or full ring), cash heads-up;
   - fast-fold (Zoom on PokerStars; whatever the room calls it, if it has
     one) - note whether the title changes with every new table;
   - a tournament table (MTT or Sit & Go), and **its title after a table
     move** (or two tournament tables at once, which also shows how two
     tables of one tournament differ);
   - a Spin / jackpot Sit & Go if the room has one;
   - two tables of the same kind at once, if the room names them alike.
4. For each table: the matching line of the room's hand history for that
   table, **only the table name** - what follows `Table '` up to the closing
   `'` - so the title can be compared with what the hands carry (for a
   tournament that is often `<tournament id> <table number>`, not what the
   title shows).
5. **Window states**: one table minimised, and one on a second monitor or at
   another Windows scale (Settings, Display, Scale) if you have one: the
   dpi lines show whether the client is per-monitor aware (`window` dpi
   equal to the monitor's) or stretched by Windows.
6. **Table geometry, for tiling** (PokerStars, ACR, WPT Global, CoinPoker;
   not Winamax, which is never tiled): the `frame:` and `size:` lines of
   one table of each kind, and the result of `--tile-check` (next section)
   with four tables open - whether the client kept the aspect ratio it was
   given, and the smallest size it accepted. This becomes the room's table
   geometry (aspect ratio, minimum client size, its frame) for the tiler.

## The placement check (tiling rooms only)

`rail-hud --tile-check` tiles one program's table windows **once** with
Rail's own tiling engine, reads them back and prints, per window, the rect
asked for and the one the client accepted, the aspect ratio before and
after, how long the move took, and any size the client refused (it then
gets one retry, centred in its slot, exactly as the HUD's tiler does). Then
it exits. It finds the tables by the room's `tables` block, or - before the
room has one - by a candidate `--try-title` regex for the room named with
`--room`:

```text
rail-hud --tile-check --process PokerStars.exe --room pokerstars --try-title "^(?P<table>.+?) - "
rail-hud --tile-check --process PokerStars.exe --room pokerstars --try-title "..." --layout my-layout.json
rail-hud --tile-check --restore            puts the windows back where they were
rail-hud --tile-check --help
```

- **It refuses** a `--room` whose tiling policy is not `true` (GGPoker,
  partypoker, Unibet, Winamax, 888poker, ...: exit code 6, nothing looked
  at), lists without moving any window its matcher takes for such a room,
  and never moves a window whose program's name looks like such a room's
  (`GGnet.exe`, `Winamax.exe`), whatever `--room` says.
- **The mouse rule holds**: nothing moves while a mouse button is down, or
  within 0.6 s of a click; after 15 s of a busy mouse it stops.
- `--layout <file>` tiles into a saved layout (the app's JSON: `id`,
  `name`, `slots` in thousandths of the work area) instead of the auto
  grid.
- The windows' places before the check go to a small file in the temp
  folder (`rail-hud-tile-check.json`: window ids and rects, no titles);
  `--restore` reads it. A table that was minimised is left restored.
- Titles in the output are redacted as for `--list-windows` (`--you`, the
  store's hero names).

On a Mac it needs the terminal's Accessibility permission, as the listing
does.

## What to paste back

For each room, in a pull request comment or a file under
`docs/research/` (after reading it through):

```text
Room: PokerStars    Client version: 7.xx (build ...)    Windows 11, 150 %
--list-windows --process PokerStars.exe output (redacted)
Hand-history table names, one per table above:
  cash 6-max:        <table name from Table '...'>
  tournament:        <tournament id> <table number>
  after table move:  ...
Tiling rooms only: --tile-check output with 4 tables (redacted), and
  whether --tile-check --restore put them back
Notes: what was not captured and why.
```

[`REAL-CLIENT-CHECK.md`](REAL-CLIENT-CHECK.md#5-tiling-and-the-rng-per-room-t6)
has the full tiling and RNG check per room and the list of what to send
back; when you run that check, its "what to send back" covers this too.

## From the capture to `sites.json`

Whoever turns it into configuration (an R3.3 follow-up, per room):

1. Write the title regex (Rust `regex` syntax, anchored) with a named
   group `table` that reads **exactly** the hand histories' table name from
   every captured title, and optionally `seats` (2 - 10) when the title
   says the table size (`6-max`); check it with `--try-title` on the
   capture and in a unit test with the captured titles (redacted). It must
   not take the lobby. If a kind of table cannot give the hands' name (a
   tournament title without it), say so in the source: the HUD then
   attaches and waits, and a later step adds what is needed.
2. Fill the room's `tables` block:

   ```json
   "tables": {
     "process": { "windows": ["PokerStars.exe"], "macos": null },
     "title": "^(?P<table>.+?) - ...$",
     "seatLayouts": null,
     "preferredSeat": null,
     "verified": true,
     "source": "Observed on a Windows install, 2026-10-20: PokerStars 7.xx (build ...); cash 6-max, 9-max, HU, Zoom, MTT incl. a table move; titles compared with the hands' table names",
     "checkedAt": "2026-10-20"
   }
   ```

   The validator (`rail_config::validate`, and `sites.schema.json`) refuses
   `verified: true` without `checkedAt`, a source starting `Observed on `,
   or a title regex. `macos` stays `null` until the macOS client is
   captured the same way ([On macOS](#on-macos-r311)) - one regex must read
   both systems' titles, or the room needs a note that they differ;
   `seatLayouts` / `preferredSeat` come from the measurement below ("Seat
   layouts") - and stay `null` for a room whose HUD is refused (WPT
   Global, CoinPoker: tiling only). The table geometry the tiler needs
   (aspect ratio, minimum client size) comes from `--tile-check`; until
   `sites.json` has a field for it, the tiler takes each window's own
   aspect ratio as first seen (`crate::tiling::RoomGeometry`), so it goes
   into the source text and the PR.
3. Relax `only_what_was_seen_is_verified` in
   `core/rail-config/tests/sites.rs` for exactly that room's tables, and
   `only_allowed_rooms_are_attached` in `hud/rail-hud/src/compliance.rs`
   (it holds that no room has a matcher yet).
4. Replace the simulator's invented title for the room in
   `hud/rail-hud-sim/rooms.json` with the real format, tagged SOURCED, so
   the simulator's tables look like the real ones.

## Seat layouts (R3.6)

The HUD puts a seat's panel next to where the client draws that seat, and
on ACR it must never cover the client's own table graphics (policy 4.2.11).
Until a room is measured, every table is laid out with the table
simulator's geometry, which matches no real client. Per room and per table
size the room has (2, 6, 9 or whatever it offers), with the client at its
default table theme:

1. **A screenshot of the table's client area** (the window without its
   frame) at a known size - the `--list-windows` line gives the client size
   in pixels - with every seat taken if possible.
2. **Each seat's plate**: its centre, clockwise, starting from the seat the
   hand history calls seat 1 **with preferred seat off** (sit at seat 1, or
   compare names with a hand). And one plate's width and height.
3. **The table's other graphics** a panel must not cover: the board and pot,
   the dealer tray, chip stacks if drawn apart from the plate, the action
   buttons' area, time bank, chat. Each as a rectangle.
4. **Preferred seat**: whether the client offers it, its default, and where
   it draws you with it on (which of the plates, usually bottom centre).
5. **Seat numbering**: whether the hand history numbers a smaller table's
   seats `1..size` or from a bigger table's numbers (a 6-max table written
   as seats 1, 2, 4, 5, 7, 9), and what a final table or a short-handed
   table does.

Turn each point into thousandths of the client width and height (x / width
x 1000, rounded) and fill `tables.seatLayouts` and `tables.preferredSeat`:

```json
"seatLayouts": {
  "6": {
    "seats": [[500, 840], [145, 690], [145, 390], [500, 240], [855, 390], [855, 690]],
    "plate": [170, 80],
    "center": [500, 540],
    "heroSlot": 0,
    "graphics": [[285, 480, 430, 150], [0, 920, 1000, 80]],
    "seatNumbers": null
  }
},
"preferredSeat": false
```

`seats` lists the plates in hand-history seat order with preferred seat
off; `heroSlot` is the index into `seats` where the client draws you with
it on. The validator checks one seat per seat of the size, every value
within 0 - 1000, `heroSlot` a seat and distinct `seatNumbers`. A user's
own answer to "does your client rotate the table?" (the app's setting)
wins over `preferredSeat`, which is only the default.

## On macOS (R3.11)

The same diagnostic, the same redaction, the same things to capture - on a
Mac with the room's macOS client (PokerStars, Winamax and ACR each have
one; check whether WPT Global and CoinPoker ship one, and that a room's
macOS client is the one it still ships). `--tile-check` works the same on
a Mac. What differs:

**The Accessibility permission, for the terminal.** On a Mac a window's
title is readable by another program only through the Accessibility API
(the window server's own list hides titles from programs without Screen
Recording, which Rail never uses). macOS grants Accessibility to the *app
that started* the program, so for `rail-hud --list-windows` that is your
terminal: System Settings, Privacy & Security, **Accessibility**, switch on
Terminal (or iTerm, ...), then quit and reopen the terminal. Nothing else:
not Screen Recording, not Input Monitoring. Without it the listing says
`Accessibility: NOT granted` and shows no title. It never asks by itself.
Switch it off again afterwards if you like; Rail.app has its own entry for
the HUD.

Where to get it:

- **From the app**: `Rail.app/Contents/MacOS/rail-hud` (a pull request's CI
  run has an unsigned `.dmg`; guideline §14). Running the app's copy from a
  terminal still needs the *terminal's* permission.
- **From the source**: `cargo build --release -p rail-hud`, then
  `target/release/rail-hud`.

```text
rail-hud --list-windows                                   every window with a title
rail-hud --list-windows --process PokerStars              one program's windows
rail-hud --list-windows --process PokerStars --you MyScreenName
rail-hud --list-windows --process PokerStars --try-title "^(?P<table>.+?) - "
```

**The program name** is the executable's file name - what is inside
`<App>.app/Contents/MacOS/` (`PokerStars` rather than `PokerStars.app`), the
same name `ps -axco command` prints. Run the listing without `--process`
once to see it; it goes into `tables.process.macos`.

**What the lines say on a Mac**: `frame:` is the whole window and its
only inset is the title bar (`top`); `size:` says whether the client lets
its size and position be set. `subrole` instead of `class` (the
accessibility kind: `AXStandardWindow` for an ordinary window, `AXDialog`,
`AXFloatingWindow`, ... - a lobby and a table may differ here); the client
area in pixels **and** points (`1280x960 px ... = 640x480 pt`) with the
screen's scale (200% on Retina) instead of dpi; `off screen (another Space,
or the app hidden)` instead of cloaked. The client area is the window less
its title bar, which the HUD measures from the window's close button: if a
client draws its own title bar (no close button where macOS puts it), say
so - the HUD then takes the whole window.

**Also capture on a Mac**: one table in full screen (its own Space) and one
on another Space or desktop, then switch back to the Space with the
listing's terminal: the listing shows a table it cannot see as `off screen`
only if the HUD read its title before, so note what it showed.

**The permission for Rail itself** (the HUD, for players): Rail.app asks on
the HUD screen. The grant is tied to the app's signature, so an unsigned
or ad-hoc signed build (a CI artifact, a local build) is a new app to macOS
with every build: if the HUD screen keeps asking although Rail is switched
on in the list, remove Rail from the list (the minus button) and switch it
on again. Developer ID signed releases (P3) keep it across updates.

## Seen so far

Nothing yet: no `tables` block is filled.

Once a room's `tables` block is merged, check the HUD on its real client:
[`REAL-CLIENT-CHECK.md`](REAL-CLIENT-CHECK.md) (R3.14).

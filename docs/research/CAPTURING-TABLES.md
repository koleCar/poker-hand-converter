# Capturing a room's table windows on Windows

The HUD finds a table by its window: the program that owns it and its title
(docs/RAIL-PLAN.md R3.3). For each room, `config/sites.json` says how in its
`tables` block - the process names and a title regex whose `table` group is
exactly the table name the room's hand histories carry. Every `tables` block
is `null` today: nobody has looked at a real client's windows yet, and the
HUD attaches to nothing until someone does. This is how to look, on a
Windows PC with the real clients, and how the result becomes `sites.json`.

Only rooms whose HUD policy is allowed matter: **PokerStars, Winamax, ACR**
(R3.0, `docs/research/HUD-POLICIES.md`). Capturing a title is not attaching
to it: the diagnostic below only reads window titles, as Task Manager does;
it draws nothing and touches no client.

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

For each room (PokerStars, Winamax, ACR), with the client's current version,
logged in (play money where the room has it is enough and the safest, P6):

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
Notes: what was not captured and why.
```

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
   or a title regex. `macos` stays `null` until R3.11 captures the macOS
   client the same way; `seatLayouts` / `preferredSeat` come from the
   measurement below ("Seat layouts").
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

## Seen so far

Nothing yet: no `tables` block is filled.

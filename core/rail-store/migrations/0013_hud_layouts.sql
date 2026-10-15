-- rail-store schema, version 13 (docs/RAIL-PLAN.md R3.6): where the user
-- put the HUD's panels, and whether their client rotates the table.
--
-- - `hud_seat_positions`: a panel the user dragged, remembered per room
--   (`sites.json` id: `acr`, not the store's `acrwpn` - a layout belongs to
--   the client that draws the table), table size and **visual seat**
--   (`slot`: the place on the screen, an index into the room's seat
--   layout, not the hand history's seat number - with a rotating client
--   the hero's panel stays where the hero is drawn whatever seat they
--   took). `x`, `y`: the panel's centre in thousandths of the table
--   window's client area, so it holds at any window size and DPI. Written
--   by the app when the HUD says `seat_position_changed` (the HUD's own
--   connection is read-only, R3.2); read by the HUD at start and on
--   `layout_changed`. `updated_at` is for sync (R3.9 / R4.x: the layouts
--   follow the user to a second machine, last writer wins).
-- - `hud_room_settings`: the user's answer per room to "does your client
--   rotate the table so you always sit at the bottom?" (PokerStars,
--   Winamax and ACR offer a preferred seat): `preferred_seat` 1 yes, 0 no;
--   no row (or NULL) - the room's `sites.json` `tables.preferredSeat`,
--   and no when that is unknown.
--
-- Empty on creation: nothing to rebuild.

CREATE TABLE hud_seat_positions (
  site       TEXT    NOT NULL,
  size       INTEGER NOT NULL CHECK (size BETWEEN 2 AND 10),
  slot       INTEGER NOT NULL CHECK (slot >= 0 AND slot < size),
  x          INTEGER NOT NULL CHECK (x BETWEEN 0 AND 1000),
  y          INTEGER NOT NULL CHECK (y BETWEEN 0 AND 1000),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site, size, slot)
) STRICT, WITHOUT ROWID;

CREATE TABLE hud_room_settings (
  site           TEXT    NOT NULL PRIMARY KEY,
  preferred_seat INTEGER CHECK (preferred_seat IN (0, 1)),
  updated_at     INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

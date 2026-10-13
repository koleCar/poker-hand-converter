# Verifying a room's hand-history folder on a real install

`config/sites.json` says, per client and OS, where its hand histories are
(`paths`), what the files are called (`files.glob`) and whether they are
written while you play (`files.live`). First-run discovery (R1.4,
`core/rail-watch/src/discover.rs`) looks only where `paths` says. Most of
these are still research guesses (`verified: false`); this is how to turn
one into an observation, or into a verified "there is nothing local".

**Privacy.** Everything below is read-only and stays on your machine. Never
copy a hand history, a player or account name, an account id or an e-mail
address into the repository, a pull request, a test fixture or a log -
describe the structure only (folder names with the account part replaced by
`*`, file names with the table and ids replaced, counts, dates). Do not run
the client's own export or upload features for this.

## What to record

For the folder (`paths.macos[]` / `paths.windows[]`):

- `path`: the template - `~/...` or `/...` on macOS, `%LOCALAPPDATA%\...`,
  `%APPDATA%\...`, `%USERPROFILE%\...` or `C:\...` on Windows; `*` for one
  folder level that differs per user (the account name), `?` for one
  character. No `**`, no `..`.
- `verified: true`, `checkedAt: "YYYY-MM-DD"`.
- `source`: starts with `Observed on a <macOS|Windows> install, <date>:`,
  then the client and its version (macOS: `CFBundleShortVersionString` and
  `CFBundleIdentifier` of the app's `Info.plist`; Windows: the `.exe`'s file
  version), and how the folder was seen - "after playing N tables", "the
  folder its `X` preference names", "the default after a fresh install".
  Say what was **not** established (for example whether the folder is the
  default or one the user chose).

For the files (`files`): `glob` (a file-name pattern such as `HH*.txt`),
`live` (`true`: files appear and grow while a table is open; `false`:
nothing local, or only after a manual export), `verified: true`, and a
`source` in the same form. A client that writes nothing locally gets
`live: false` and **no path** - a verified negative, which discovery then
never looks for.

Then relax the lists in `core/rail-config/tests/sites.rs`
(`VERIFIED_FILES`, `VERIFIED_PATHS`) for exactly what you saw; everything
else stays unverified, and the test holds it there.

## macOS

1. The client: `defaults read /Applications/<Client>.app/Contents/Info.plist CFBundleIdentifier`
   and `... CFBundleShortVersionString`.
2. Where it keeps data - list, do not open:
   - `~/Library/Application Support/` (folders named after the client or its
     bundle id),
   - `~/Library/Containers/<bundle id>/Data/` (sandboxed apps),
   - `~/Library/Group Containers/`, `~/Library/Preferences/<bundle id>.plist`,
     `~/Library/Logs/`, `~/Documents/`.
3. The preferences: `defaults read <domain>` **key names only** (pipe through
   `grep -o '^ *"\?[A-Za-z0-9_. -]*"\? ='`); a key like `HandsHistoryDir` or
   `HandHistoryPath` names the folder - read that one value.
4. Play (or sit at) a table for a few hands, then look again: a new or
   grown file under one of those folders, with the client's `mtime`, is the
   evidence. `stat -f '%SB %Sm' <file>` gives birth and modification time;
   a file born when the table opened and modified until it closed is
   written live.
5. File names: describe their shape (`HH<YYYYMMDD> <table> (#<id>) ...txt`),
   not the real ones.

## Windows

1. The client: the shortcut's target, and the `.exe`'s Properties, Details,
   File version.
2. Where it keeps data: `%LOCALAPPDATA%\<Client>\`, `%APPDATA%\<Client>\`,
   `%USERPROFILE%\Documents\<Client>\`, `%PROGRAMDATA%\<Client>\`, the
   install folder (`%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`); `dir /s /b
   *.txt *.xml` in each, counts only.
3. Settings: the client's own settings screen often shows the hand-history
   folder ("Save hand histories to..."); also the registry under
   `HKEY_CURRENT_USER\Software\<Vendor>` (names only).
4. Play a few hands and look again, as on macOS (`dir /t:c` creation time,
   `dir /t:w` last write).
5. Record the folder with an environment variable, never with the user's
   name: `%LOCALAPPDATA%\PokerStars\HandHistory\*`, not
   `C:\Users\<name>\AppData\Local\...`.

## Checking discovery against it

`cargo test -p rail-watch --test discover` runs discovery on a fake home
folder; add a case with the new template if it has an unusual shape. On the
machine itself, the app's first-run screen (Settings, Find folders...) lists
what it finds, with file counts and the newest file's date.

## Seen so far (R1.4, macOS, 2026-10-13)

| Client | What was seen |
| --- | --- |
| WePlay 2.0 (revision 26.7.2) | Files under the folder of the `HandsHistoryDir` preference, `~/Documents/hands/<account>/HH<date> ....txt`, one per table per day, written while playing. Whether that folder is the default is not established. |
| GGPoker (launcher 1.0, game 1.0.0.480) | No hand-history file anywhere local; hands are PokerCraft downloads saved wherever the user puts them. |
| CoinPoker 1.25.0 | No hand-history file anywhere local after play; the client shows hand history fetched from its server. Whether a client setting enables a local export was not checked. |

Still unverified on every OS: PokerStars (its paths are tracker-forum
inferences), Winamax, 888poker, partypoker, ACR / WPN skins, Unibet, the
iPoker and Chico skins, and every Windows client.

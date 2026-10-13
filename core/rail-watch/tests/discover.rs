//! Folder discovery (R1.4) on a fake home folder: the macOS and Windows
//! templates, account levels, the room's file names, sampling when they
//! are unknown, the bounds, folders already watched, and the shipped
//! `config/sites.json`.

mod common;

use std::fs;
use std::path::Path;

use common::*;
use rail_config::model::{PathEntry, Site};
use rail_config::{Config, load_shipped};
use rail_core::parsers::REGISTRATION_ORDER;
use rail_watch::discover::{Env, Found, Limits, Os, Sample, Watched, discover, expand, file_globs};

const STARS: &str = "fixtures/samples/pokerstars/27-cash-multi-hand-file-blank-line-separator.txt";
const WINAMAX: &str =
    "fixtures/samples/winamax/hhsmithy-corpus/CashGame_MultipleHandsTests_10MultipleHands.txt";

fn shipped() -> Config {
    load_shipped(&REGISTRATION_ORDER).expect("the shipped sites.json")
}

fn entry(path: &str) -> PathEntry {
    PathEntry {
        path: path.to_owned(),
        verified: false,
        source: "test".to_owned(),
        checked_at: None,
    }
}

/// A config of one room: `base`'s entry with these templates and glob.
fn room(base: &str, macos: &[&str], windows: &[&str], glob: Option<&str>) -> Config {
    let mut config = shipped();
    let mut site: Site = config.site(base).expect("site").clone();
    site.paths.macos = macos.iter().map(|path| entry(path)).collect();
    site.paths.windows = windows.iter().map(|path| entry(path)).collect();
    site.files.glob = glob.map(str::to_owned);
    config.sites = vec![site];
    config
}

fn touch(path: &Path, bytes: &[u8], mtime_ms: i64) {
    fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    fs::write(path, bytes).expect("write");
    set_mtime(path, mtime_ms);
}

fn paths(found: &[Found], home: &Path) -> Vec<String> {
    found
        .iter()
        .map(|folder| {
            folder
                .path
                .strip_prefix(home)
                .expect("under the fake home")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

#[test]
fn macos_templates_find_every_account_folder() {
    let home = scratch_dir("discover-mac");
    let base = home.join("Library/Application Support");
    touch(&base.join("PokerStars/HandHistory/alice/HH1.txt"), b"x", T0);
    touch(
        &base.join("PokerStars/HandHistory/alice/HH2.txt"),
        b"x",
        T0 + 5_000,
    );
    touch(
        &base.join("PokerStars/HandHistory/alice/notes.log"),
        b"x",
        T0 + 9_000,
    );
    touch(
        &base.join("PokerStars/HandHistory/alice/2026/HH3.txt"),
        b"x",
        T0 + 1_000,
    );
    fs::create_dir_all(base.join("PokerStars/HandHistory/bob")).expect("dirs");
    fs::create_dir_all(base.join("PokerStars/HandHistory/.hidden")).expect("dirs");
    touch(&base.join("PokerStars/HandHistory/file.txt"), b"x", T0);
    touch(
        &base.join("PokerStarsEU/HandHistory/carol/HH1.txt"),
        b"x",
        T0,
    );
    fs::create_dir_all(base.join("Other/HandHistory/dave")).expect("dirs");

    let config = room(
        "pokerstars",
        &["~/Library/Application Support/PokerStars*/HandHistory/*"],
        &[],
        Some("HH*.txt"),
    );
    let env = Env::new(Os::Macos, Some(home.clone()));
    let found = discover(&config, &env, &[], &Limits::default());
    assert_eq!(
        paths(&found, &home),
        [
            "Library/Application Support/PokerStars/HandHistory/alice",
            "Library/Application Support/PokerStars/HandHistory/bob",
            "Library/Application Support/PokerStarsEU/HandHistory/carol",
        ]
    );
    let alice = &found[0];
    assert_eq!(alice.site, "pokerstars");
    assert_eq!(alice.name, "PokerStars");
    assert_eq!((alice.files, alice.complete), (3, true));
    assert_eq!(
        alice.newest_ms,
        Some(T0 + 5_000),
        "notes.log is not counted"
    );
    assert_eq!(alice.glob.as_deref(), Some("HH*.txt"));
    assert_eq!(alice.sample, None, "the glob is known: nothing sampled");
    assert!(!alice.verified && !alice.watched);
    let bob = &found[1];
    assert_eq!((bob.files, bob.newest_ms), (0, None));

    // No home, no `~` templates.
    assert!(discover(&config, &Env::new(Os::Macos, None), &[], &Limits::default()).is_empty());
    // The Windows templates of the same room are empty.
    let windows = Env::new(Os::Windows, Some(home.clone()))
        .with_var("LOCALAPPDATA", home.display().to_string());
    assert!(discover(&config, &windows, &[], &Limits::default()).is_empty());
}

#[test]
fn windows_templates_use_variables_and_drives() {
    let home = scratch_dir("discover-win");
    let local = home.join("AppData").join("Local");
    touch(
        &local.join("Room").join("HH").join("acct").join("a.txt"),
        b"x",
        T0,
    );
    let config = room(
        "pokerstars",
        &[],
        &[
            r"%LOCALAPPDATA%\Room\HH\*",
            r"%UNSET%\Room\HH\*",
            r"%localappdata%\Room\..\Room\HH\*",
        ],
        Some("*.txt"),
    );
    // Variable names ignore case, as on Windows.
    let env = Env::new(Os::Windows, None).with_var("LocalAppData", local.display().to_string());
    let found = discover(&config, &env, &[], &Limits::default());
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].path, local.join("Room").join("HH").join("acct"));
    assert_eq!(found[0].template, r"%LOCALAPPDATA%\Room\HH\*");
    assert_eq!(found[0].files, 1);

    // A drive root splits too (nothing there on the test machine).
    assert!(expand(r"Q:\Surely\Not\Here\*", &env, 8).is_empty());
    // An empty variable is unset.
    let empty = Env::new(Os::Windows, None).with_var("LOCALAPPDATA", "");
    assert!(expand(r"%LOCALAPPDATA%\Room\HH\*", &empty, 8).is_empty());
}

#[test]
fn unknown_file_names_are_sampled_with_the_core() {
    let home = scratch_dir("discover-sample");
    let folder = home.join("Rooms/Stars/acct");
    touch(&folder.join("one.txt"), &corpus(STARS), T0 + 3_000);
    touch(&folder.join("two.txt"), &corpus(WINAMAX), T0 + 2_000);
    touch(&folder.join("three.txt"), b"not a hand history", T0 + 1_000);
    touch(&folder.join("four.txt"), &corpus(STARS), T0);
    let config = room("pokerstars", &["~/Rooms/Stars/*"], &[], None);
    let env = Env::new(Os::Macos, Some(home.clone()));
    let found = discover(&config, &env, &[], &Limits::default());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].files, 4);
    // The three newest: one is PokerStars, two is Winamax, three nothing.
    assert_eq!(
        found[0].sample,
        Some(Sample {
            looked: 3,
            claimed: 1
        })
    );
}

#[test]
fn the_walk_is_bounded() {
    let home = scratch_dir("discover-bounds");
    let folder = home.join("hh/acct");
    for n in 0..30 {
        touch(&folder.join(format!("HH{n:02}.txt")), b"x", T0 + n);
    }
    touch(&folder.join("a/b/c/d/HH-deep.txt"), b"x", T0);
    let config = room("pokerstars", &["~/hh/*"], &[], Some("HH*.txt"));
    let env = Env::new(Os::Macos, Some(home.clone()));
    let all = discover(&config, &env, &[], &Limits::default());
    assert_eq!(
        (all[0].files, all[0].complete),
        (30, true),
        "depth 3 stops before d"
    );
    let limits = Limits {
        entries: 10,
        ..Limits::default()
    };
    let bounded = discover(&config, &env, &[], &limits);
    assert!(!bounded[0].complete);
    assert!(bounded[0].files <= 10);
    // The same disk gives the same answer.
    assert_eq!(bounded, discover(&config, &env, &[], &limits));

    for n in 0..5 {
        fs::create_dir_all(home.join(format!("many/acct{n}"))).expect("dirs");
    }
    let config = room("pokerstars", &["~/many/*"], &[], Some("HH*.txt"));
    let limits = Limits {
        matches: 2,
        ..Limits::default()
    };
    assert_eq!(
        paths(&discover(&config, &env, &[], &limits), &home),
        ["many/acct0", "many/acct1"]
    );
}

#[test]
fn watched_folders_are_marked() {
    let home = scratch_dir("discover-watched");
    for account in ["a", "b", "c"] {
        fs::create_dir_all(home.join("hh").join(account)).expect("dirs");
    }
    fs::create_dir_all(home.join("other/c")).expect("dirs");
    let config = room("pokerstars", &["~/hh/*", "~/hh/a"], &[], Some("HH*.txt"));
    let env = Env::new(Os::Macos, Some(home.clone()));
    let watched = [
        Watched {
            path: home.join("hh/a"),
            recursive: false,
        },
        Watched {
            path: home.join("hh"),
            recursive: false,
        },
        Watched {
            path: home.join("other"),
            recursive: true,
        },
    ];
    let found = discover(&config, &env, &watched, &Limits::default());
    // `~/hh/a` twice (two templates): once.
    assert_eq!(paths(&found, &home), ["hh/a", "hh/b", "hh/c"]);
    let flags: Vec<bool> = found.iter().map(|folder| folder.watched).collect();
    // hh/a itself; hh is watched but not recursively.
    assert_eq!(flags, [true, false, false]);
    let recursive = [Watched {
        path: home.join("hh"),
        recursive: true,
    }];
    assert!(
        discover(&config, &env, &recursive, &Limits::default())
            .iter()
            .all(|folder| folder.watched)
    );
}

/// The shipped file on an empty home finds nothing; with WePlay's observed
/// folder (R1.4, macOS) it finds each account folder and counts only its
/// `HH*.txt` files.
#[test]
fn the_shipped_config_finds_weplays_folder() {
    let config = shipped();
    let home = scratch_dir("discover-shipped");
    let mac = Env::new(Os::Macos, Some(home.clone()));
    let windows = Env::new(Os::Windows, Some(home.clone()))
        .with_var("LOCALAPPDATA", home.display().to_string())
        .with_var("APPDATA", home.display().to_string())
        .with_var("USERPROFILE", home.display().to_string());
    assert!(discover(&config, &mac, &[], &Limits::default()).is_empty());
    assert!(discover(&config, &windows, &[], &Limits::default()).is_empty());

    let account = home.join("Documents/hands/player-one");
    touch(
        &account.join("HH20260101 Table #1 (#1) - $1-$2 - Money 3 No Limit Hold_em.txt"),
        b"x",
        T0,
    );
    touch(
        &account.join("HH20260102 Table #1 (#1) - $1-$2 - Money 3 No Limit Hold_em.txt"),
        b"x",
        T0 + 7,
    );
    touch(&account.join("readme.txt"), b"x", T0 + 99);
    fs::create_dir_all(home.join("Documents/hands/player-two")).expect("dirs");
    let found = discover(&config, &mac, &[], &Limits::default());
    assert_eq!(
        paths(&found, &home),
        ["Documents/hands/player-one", "Documents/hands/player-two"]
    );
    assert_eq!(found[0].site, "weplay");
    assert!(found[0].verified);
    assert_eq!((found[0].files, found[0].newest_ms), (2, Some(T0 + 7)));
    assert_eq!(found[1].files, 0);
}

#[test]
fn file_globs_come_from_the_config() {
    let globs = file_globs(&shipped());
    assert_eq!(globs.get("weplay").map(String::as_str), Some("HH*.txt"));
    assert_eq!(globs.get("pokerstars").map(String::as_str), Some("*.txt"));
    assert_eq!(globs.get("coinpoker"), None);
}

fn corpus(relative: &str) -> Vec<u8> {
    fs::read(repo_root().join(relative)).expect("corpus file")
}

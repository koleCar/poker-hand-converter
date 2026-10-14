//! The simulator binary end to end, headless (every OS in CI): three
//! tables, twenty hands into a temporary folder, exit; the folder must read
//! back through `rail_core::convert` as the room's hands
//! (docs/RAIL-PLAN.md R3.1). The windowed run is a CI step on macOS and
//! Windows (`.github/workflows/ci.yml`).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

fn out_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("rail-hud-sim-tests")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn events(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("{line}: {e}")))
        .collect()
}

fn run(args: &[&str], out: &Path, stdin: &str) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rail-hud-sim"))
        .args(args)
        .arg("--headless")
        .arg("--out")
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("runs");
    if let Some(mut input) = child.stdin.take() {
        input.write_all(stdin.as_bytes()).expect("stdin");
    }
    let output = child.wait_with_output().expect("exits");
    assert!(output.status.success(), "{args:?}: {:?}", output.status);
    events(&output.stdout)
}

fn of<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["event"] == kind).collect()
}

#[test]
fn three_tables_twenty_hands_per_room() {
    for (room, extra) in [
        ("pokerstars", &[][..]),
        ("winamax", &[][..]),
        ("acr", &[][..]),
        ("acr", &["--encoding", "utf-16le", "--crlf"][..]),
        ("pokerstars", &["--tournament"][..]),
    ] {
        let out = out_dir(room);
        let mut args = vec![
            "--room", room, "--tables", "3", "--hands", "20", "--speed", "3000", "--seed", "11",
        ];
        args.extend_from_slice(extra);
        let events = run(&args, &out, "");
        assert!(of(&events, "error").is_empty(), "{room}: {events:?}");
        let hands = of(&events, "hand");
        assert_eq!(hands.len(), 20, "{room} {extra:?}");
        assert_eq!(of(&events, "done").len(), 1);
        let tables = of(&events, "table");
        assert_eq!(tables.len(), 3);
        // Each hand carries its table's name, which the title gives back.
        let naming = {
            let room = rail_hud_sim::room::room(room).expect("room");
            if extra.contains(&"--tournament") {
                room.tournament.expect("tournament naming")
            } else {
                room.cash
            }
        };
        for table in &tables {
            let title = table["title"].as_str().unwrap_or("");
            let name = table["tableName"].as_str().unwrap_or("");
            assert_eq!(
                rail_hud_sim::room::table_from_title(&naming, title).as_deref(),
                Some(name),
                "{title}"
            );
            for hand in hands.iter().filter(|h| h["table"] == table["table"]) {
                assert_eq!(hand["tableName"], table["tableName"]);
                assert!(
                    hand["players"]
                        .as_array()
                        .is_some_and(|p| p.iter().any(|n| n == "SimHero"))
                );
            }
        }
        // The folder through the converter's own path.
        let room_config = rail_hud_sim::room::room(room).expect("room");
        let report = rail_hud_sim::verify::verify(&out, &room_config)
            .unwrap_or_else(|e| panic!("{room} {extra:?}: {e}"));
        assert_eq!(report.hands, 20, "{room}");
        assert!(out.join(rail_hud_sim::output::MARKER).is_file());
        // And the binary's own check agrees.
        let status = Command::new(env!("CARGO_BIN_EXE_rail-hud-sim"))
            .args(["verify", "--room", room, "--hands", "20", "--out"])
            .arg(&out)
            .stdout(Stdio::null())
            .status()
            .expect("verify runs");
        assert!(status.success());
        let _ = std::fs::remove_dir_all(&out);
    }
}

#[test]
fn commands_from_standard_input() {
    let out = out_dir("commands");
    // Slow enough that only the commands write hands.
    let events = run(
        &[
            "--tables", "2", "--sizes", "6", "--speed", "0.01", "--jitter", "0",
        ],
        &out,
        "hand 1\nhand 2\ntablemove 1\nhand 1\nclose 2\nopen 9\nmove 1 10 10\nstatus\nquit\n",
    );
    assert!(of(&events, "error").is_empty(), "{events:?}");
    let tables = of(&events, "table");
    assert_eq!(tables.len(), 4, "two opened, one moved, one more opened");
    let moved = tables.iter().find(|t| t["moved"] == true).expect("a move");
    assert_eq!(moved["table"], 1);
    assert_ne!(moved["tableName"], tables[0]["tableName"]);
    let hands = of(&events, "hand");
    assert_eq!(hands.len(), 3);
    assert_eq!(hands[2]["tableName"], moved["tableName"]);
    assert_eq!(of(&events, "closed").len(), 1);
    let status = of(&events, "status");
    let listed: Vec<_> = status[0]["tables"]
        .as_array()
        .expect("tables")
        .iter()
        .map(|t| t["size"].as_u64())
        .collect();
    assert_eq!(listed, [Some(6), Some(9)]);
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn refuses_a_folder_that_is_not_its_own() {
    let out = out_dir("theirs");
    std::fs::create_dir_all(&out).expect("dir");
    std::fs::write(out.join("HH20260101 Real Table.txt"), "x").expect("file");
    let status = Command::new(env!("CARGO_BIN_EXE_rail-hud-sim"))
        .args(["--headless", "--hands", "1", "--out"])
        .arg(&out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("runs");
    assert!(!status.success());
    assert_eq!(std::fs::read_dir(&out).expect("dir").count(), 1);
    let _ = std::fs::remove_dir_all(&out);
}

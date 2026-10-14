//! Table simulator (docs/RAIL-PLAN.md A8, R3.1): windows titled like a
//! room's tables, writing real corpus hands to a hand-history folder at
//! play speed.
//!
//! ```text
//! rail-hud-sim [options]            run tables (windows, or --headless)
//! rail-hud-sim verify --room R --out DIR [--hands N]
//!                                   read a run's folder back through rail_core
//! ```
//!
//! Every event is a JSON line on standard output; commands are lines on
//! standard input or in `--script` (see `command.rs`); messages go to
//! standard error. `--help` lists the options.

#![forbid(unsafe_code)]

mod gui;

use std::io::{BufRead as _, Write as _};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rail_hud_sim::command::{Command, parse_speed};
use rail_hud_sim::room::{self, FileEncoding, LineEnd};
use rail_hud_sim::sim::{Config, Event, Sim};

const HELP: &str = "\
rail-hud-sim - Rail's table simulator (not a poker client)

USAGE
  rail-hud-sim [options]
  rail-hud-sim verify --room <room> --out <dir> [--hands <n>]

OPTIONS
  --room <id>          pokerstars (default), winamax, acr
  --tables <n>         tables to open (default 3)
  --sizes <a,b,..>     table sizes, cycled over the tables (default: the room's)
  --tournament         tournament tables (PokerStars, ACR)
  --game <key>         variant-limit, e.g. holdem-nl (default: the most common)
  --speed <h>          hands per minute per table (default 2)
  --jitter <pct>       +- percent of the interval between hands (default 30)
  --hands <n>          stop after n hands in all, then exit
  --linger <ms>        with --hands: keep the windows this long after (default 1000)
  --out <dir>          hand-history folder (default: a new temporary folder);
                       must be empty or the simulator's own
  --corpus <dir>       fixtures/samples (default: the repository's)
  --hero <name>        the hero's name (default SimHero)
  --seed <n>           random seed (default: from the clock)
  --encoding <e>       utf-8, utf-8-bom, utf-16le (default: the room's)
  --crlf               CRLF line ends (default: the room's)
  --headless           no windows
  --preferred-seat     draw the hero's seat at the bottom
  --window <WxH>       window client size in logical pixels
  --script <file>      commands, one per line, `wait <ms>` between
  --no-stdin           do not read commands from standard input
  --list               the room's usable hands by group, then exit
  --title-regex        the test-only title regex, then exit

COMMANDS (standard input, --script)
  pause resume toggle speed <h> faster slower open [size] close <t> hand <t>
  tablemove <t> move <t> <x> <y> resize <t> <w> <h> minimize <t> restore <t>
  focus <t> tile status quit; scripts also: wait <ms>

KEYS (in a table window)
  space pause, +/- speed, H hand now, T table move, N new table, W close,
  M minimize, arrows move the window, Q quit
";

/// Options of the windowed front end.
#[derive(Debug, Clone)]
pub struct GuiOptions {
    pub preferred_seat: bool,
    pub window: Option<(u32, u32)>,
    pub linger: Duration,
}

#[derive(Debug)]
struct Args {
    config: Config,
    headless: bool,
    gui: GuiOptions,
    script: Option<PathBuf>,
    stdin: bool,
    list: bool,
    title_regex: bool,
}

fn fail(message: &str) -> ! {
    eprintln!("rail-hud-sim: {message}");
    std::process::exit(2);
}

fn value(args: &[String], i: &mut usize) -> String {
    *i += 1;
    args.get(*i)
        .cloned()
        .unwrap_or_else(|| fail(&format!("{} needs a value", args[*i - 1])))
}

fn number<T: std::str::FromStr>(text: &str, what: &str) -> T {
    text.parse()
        .unwrap_or_else(|_| fail(&format!("{what}: {text:?} is not a number")))
}

fn parse_args(args: &[String]) -> Args {
    let mut room_id = "pokerstars".to_owned();
    let mut tables = 3;
    let mut sizes = Vec::new();
    let mut tournament = false;
    let mut game = None;
    let mut speed = 200;
    let mut jitter = 30;
    let mut hands = None;
    let mut linger = 1000;
    let mut out = None;
    let mut corpus = rail_hud_sim::corpus::default_root();
    let mut hero = "SimHero".to_owned();
    let mut seed = u64::try_from(rail_hud_sim::clock::unix_ms()).unwrap_or(1);
    let mut encoding = None;
    let mut crlf = false;
    let mut headless = false;
    let mut preferred_seat = false;
    let mut window = None;
    let mut script = None;
    let mut stdin = true;
    let mut list = false;
    let mut title_regex = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            "--room" => room_id = value(args, &mut i),
            "--tables" => tables = number(&value(args, &mut i), "--tables"),
            "--sizes" => {
                sizes = value(args, &mut i)
                    .split(',')
                    .map(|s| number(s.trim(), "--sizes"))
                    .collect();
            }
            "--tournament" => tournament = true,
            "--game" => game = Some(value(args, &mut i)),
            "--speed" => speed = parse_speed(&value(args, &mut i)).unwrap_or_else(|e| fail(&e)),
            "--jitter" => jitter = number(&value(args, &mut i), "--jitter"),
            "--hands" => hands = Some(number(&value(args, &mut i), "--hands")),
            "--linger" => linger = number(&value(args, &mut i), "--linger"),
            "--out" => out = Some(PathBuf::from(value(args, &mut i))),
            "--corpus" => corpus = PathBuf::from(value(args, &mut i)),
            "--hero" => hero = value(args, &mut i),
            "--seed" => seed = number(&value(args, &mut i), "--seed"),
            "--encoding" => {
                let text = value(args, &mut i);
                encoding = Some(
                    FileEncoding::parse(&text)
                        .unwrap_or_else(|| fail(&format!("unknown encoding {text:?}"))),
                );
            }
            "--crlf" => crlf = true,
            "--headless" => headless = true,
            "--preferred-seat" => preferred_seat = true,
            "--window" => {
                let text = value(args, &mut i);
                let (w, h) = text
                    .split_once('x')
                    .unwrap_or_else(|| fail("--window takes WIDTHxHEIGHT"));
                window = Some((number(w, "--window"), number(h, "--window")));
            }
            "--script" => script = Some(PathBuf::from(value(args, &mut i))),
            "--no-stdin" => stdin = false,
            "--list" => list = true,
            "--title-regex" => title_regex = true,
            other => fail(&format!("unknown option {other:?} (see --help)")),
        }
        i += 1;
    }
    let room = room::room(&room_id).unwrap_or_else(|| {
        let ids: Vec<String> = room::rooms().into_iter().map(|r| r.id).collect();
        fail(&format!(
            "unknown room {room_id:?} (rooms: {})",
            ids.join(", ")
        ))
    });
    if hero.trim().is_empty() || hero.contains(char::is_whitespace) {
        fail("--hero must be one word");
    }
    Args {
        config: Config {
            encoding: encoding.unwrap_or(room.encoding),
            line_end: if crlf { LineEnd::Crlf } else { room.line_end },
            room,
            corpus,
            out: out.unwrap_or_else(rail_hud_sim::output::temp_out),
            tables,
            sizes,
            tournament,
            game,
            speed,
            jitter,
            hands,
            hero,
            seed,
        },
        headless,
        gui: GuiOptions {
            preferred_seat,
            window,
            linger: Duration::from_millis(linger),
        },
        script,
        stdin,
        list,
        title_regex,
    }
}

/// Print events as JSON lines.
pub fn emit(events: Vec<Event>) {
    let mut out = std::io::stdout().lock();
    for event in events {
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(out, "{line}");
        }
    }
    let _ = out.flush();
}

/// Feed commands from standard input and the script to `send`.
fn command_sources(args: &Args, send: impl Fn(Command) + Send + Clone + 'static) {
    if args.stdin {
        let send = send.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                match Command::parse(&line) {
                    Ok(Some(Command::Wait(_)) | None) => {}
                    Ok(Some(cmd)) => send(cmd),
                    Err(e) => eprintln!("rail-hud-sim: {e}"),
                }
            }
        });
    }
    if let Some(path) = args.script.clone() {
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| fail(&format!("{}: {e}", path.display())));
        let mut commands = Vec::new();
        for (n, line) in text.lines().enumerate() {
            match Command::parse(line) {
                Ok(Some(cmd)) => commands.push(cmd),
                Ok(None) => {}
                Err(e) => fail(&format!("{}:{}: {e}", path.display(), n + 1)),
            }
        }
        std::thread::spawn(move || {
            for cmd in commands {
                match cmd {
                    Command::Wait(ms) => std::thread::sleep(Duration::from_millis(ms)),
                    cmd => send(cmd),
                }
            }
        });
    }
}

fn run_headless(args: &Args, mut sim: Sim) -> i32 {
    let (tx, rx) = mpsc::channel::<Command>();
    command_sources(args, move |cmd| {
        let _ = tx.send(cmd);
    });
    loop {
        let now = Instant::now();
        sim.tick(now);
        emit(sim.take_events());
        if sim.should_quit() {
            return 0;
        }
        if sim.done() {
            // Headless: nothing to look at, so no linger.
            return 0;
        }
        let wait = sim
            .next_due()
            .map(|due| due.saturating_duration_since(now))
            .unwrap_or(Duration::from_millis(500))
            .min(Duration::from_millis(500));
        match rx.recv_timeout(wait) {
            Ok(cmd) if cmd.is_window() => {
                eprintln!("rail-hud-sim: {cmd:?} needs windows (running headless)");
            }
            Ok(cmd) => {
                if let Err(message) = sim.apply(&cmd) {
                    sim.push_event(Event::Error { message });
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(wait),
        }
    }
}

fn verify_main(args: &[String]) -> i32 {
    let mut room_id = None;
    let mut out = None;
    let mut hands: Option<usize> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--room" => room_id = Some(value(args, &mut i)),
            "--out" => out = Some(PathBuf::from(value(args, &mut i))),
            "--hands" => hands = Some(number(&value(args, &mut i), "--hands")),
            other => fail(&format!("verify: unknown option {other:?}")),
        }
        i += 1;
    }
    let room_id = room_id.unwrap_or_else(|| fail("verify needs --room"));
    let room = room::room(&room_id).unwrap_or_else(|| fail(&format!("unknown room {room_id:?}")));
    let out = out.unwrap_or_else(|| fail("verify needs --out"));
    match rail_hud_sim::verify::verify(&out, &room) {
        Ok(report) => {
            println!(
                "{} files, {} hands, {} tables, all read as {}",
                report.files,
                report.hands,
                report.tables.len(),
                room.parser
            );
            if hands.is_some_and(|n| n != report.hands) {
                eprintln!(
                    "rail-hud-sim verify: {} hands, expected {}",
                    report.hands,
                    hands.unwrap_or(0)
                );
                return 1;
            }
            0
        }
        Err(e) => {
            eprintln!("rail-hud-sim verify: {e}");
            1
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("verify") {
        std::process::exit(verify_main(&args[1..]));
    }
    let args = parse_args(&args);
    if args.title_regex {
        let naming = if args.config.tournament {
            args.config
                .room
                .tournament
                .clone()
                .unwrap_or_else(|| fail("no tournament tables"))
        } else {
            args.config.room.cash.clone()
        };
        println!("{}", room::title_regex(&naming));
        return;
    }
    if args.list {
        match rail_hud_sim::corpus::load(&args.config.room, &args.config.corpus) {
            Ok(pool) => {
                println!(
                    "{}: {} files, {} usable hands",
                    args.config.room.name,
                    pool.files,
                    pool.templates()
                );
                for (group, list) in &pool.groups {
                    println!(
                        "  {} {} {}-max: {} hands",
                        if group.tournament {
                            "tournament"
                        } else {
                            "cash"
                        },
                        group.game,
                        group.size,
                        list.len()
                    );
                }
                for (path, why) in &pool.left_out {
                    println!("  left out {}: {why}", path.display());
                }
            }
            Err(e) => fail(&e),
        }
        return;
    }
    let sim = Sim::new(args.config.clone()).unwrap_or_else(|e| fail(&e));
    eprintln!(
        "rail-hud-sim: {} tables of {}, writing to {}",
        args.config.tables,
        args.config.room.name,
        args.config.out.display()
    );
    let code = if args.headless {
        run_headless(&args, sim)
    } else {
        gui::run(sim, args.gui.clone(), |proxy| {
            command_sources(&args, move |cmd| {
                let _ = proxy.send_event(cmd);
            });
        })
    };
    std::process::exit(code);
}

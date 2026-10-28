//! Dev-only: the HUD's real [`Scene`]s as SVG, for the tutorial videos in
//! `tutorials/` (which must never screen-capture the native overlay). Not
//! shipped: an example is built by `cargo run --example`, never by the app.
//!
//! ```text
//! cargo run -p rail-hud --example scene_svg -- <out-dir>
//! ```
//!
//! For each demo state it writes `<state>.table.svg` (a drawn table in the
//! spirit of the table simulator's, `rail_hud_sim::draw`: felt, rail, seat
//! plates with made-up names and stacks, the hero's seat framed, the board)
//! and `<state>.overlay.svg` (only the scene's items, on a transparent
//! background), both [`WIDTH`] x [`HEIGHT`] client-area pixels with the
//! origin top left; and `scenes.json`, the rectangles a video points at.
//!
//! Everything the overlay shows is the library's own work: compliance's
//! permit from the shipped `sites.json` (a refused room gets no frame at
//! all, as in the engine), [`PanelDesign::default`], the room's seating as
//! the engine builds it (`seats::Rooms` over the shipped configuration),
//! the panel cells from [`PanelStats::cells`] over made-up summed counters,
//! and [`scene::compose`]. Player names are made up from the simulator's
//! word lists ([`NameSource`], a fixed seed); the hero is `RailDemo`.

#![forbid(unsafe_code)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use rail_config::stats::Tone;
use rail_hud::compliance::Compliance;
use rail_hud::engine::WAITING;
use rail_hud::layout::{self, Graphics, TableLayout};
use rail_hud::panel::{PanelDesign, PanelStats, collapse_tone};
use rail_hud::platform::{OverlayFrame, PanelWords, Rect, SeatPanel, Seating, TagColour};
use rail_hud::scene::{self, Item, NOTE, Rgba, Scene};
use rail_hud::seats::{self, Rooms};
use rail_hud_sim::clock::Rng;
use rail_hud_sim::names::NameSource;
use rail_stats::Counter;
use rail_stats::display::Sums;
use serde_json::{Value, json};

/// The client area: an 800 x 580 table on a Retina screen.
const WIDTH: u32 = 1600;
const HEIGHT: u32 = 1160;
const SCALE_PERMILLE: u32 = 2000;

const HERO_NAME: &str = "RailDemo";
/// The names' seed: the same names on every run.
const NAME_SEED: u64 = 20_261_027;
/// Word-list names that read like a judgement of the player (poker slang):
/// passed over, so no name looks like a label.
const SLANG: [&str; 4] = ["Fish", "Donk", "Whale", "Shark"];

const FONT: &str = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

// The table simulator's palette (`rail_hud_sim::draw`), as SVG colours.
const BACKGROUND: &str = "#1b1f24";
const RAIL: &str = "#5a3a22";
const RAIL_EDGE: &str = "#3f2817";
const FELT: &str = "#1f6b3a";
const FELT_LIGHT: &str = "#2a8049";
const SEAT: &str = "#2b2f36";
const TEXT: &str = "#e8e8e8";
const DIM: &str = "#808890";
const HERO: &str = "#d4a017";
const CARD: &str = "#f4f4f4";
const BLACK: &str = "#101010";
const CARD_EDGE: &str = "#c8c8c8";
const BUTTON: &str = "#ffffff";
const BUTTON_EDGE: &str = "#b0b0b0";

fn main() -> Result<(), String> {
    let out = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: cargo run -p rail-hud --example scene_svg -- <out-dir>")?;
    std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;

    let compliance = Compliance::shipped()?;
    let mut rooms = Rooms::default();
    rooms.set_config(compliance.config());
    let mut names = NameSource::default();
    names.reserve(HERO_NAME);
    let mut rng = Rng::new(NAME_SEED);

    let mut states = Vec::new();
    for demo in demos(&mut names, &mut rng) {
        states.push(render(&demo, &compliance, &rooms, &out)?);
    }
    let doc = json!({
        "generator": "hud/rail-hud/examples/scene_svg.rs",
        "width": WIDTH,
        "height": HEIGHT,
        "scalePermille": SCALE_PERMILLE,
        "coordinates": "client-area pixels, origin top left, y down; \
                        every SVG has viewBox 0 0 width height",
        "states": states,
    });
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write(&out.join("scenes.json"), &text)?;
    println!(
        "wrote {} states to {}",
        doc["states"].as_array().map_or(0, Vec::len),
        out.display()
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The demo states.

/// A player's made-up history: rates in thousandths over `hands` hands.
#[derive(Debug, Clone, Copy)]
struct Profile {
    hands: i64,
    vpip: i64,
    pfr: i64,
    three_bet: i64,
    fold_to_three_bet: i64,
    cbet: i64,
    aggression: i64,
}

const HERO_PROFILE: Profile = Profile {
    hands: 24_180,
    vpip: 245,
    pfr: 205,
    three_bet: 82,
    fold_to_three_bet: 540,
    cbet: 630,
    aggression: 430,
};
const TIGHT_REG: Profile = Profile {
    hands: 6_412,
    vpip: 210,
    pfr: 180,
    three_bet: 75,
    fold_to_three_bet: 520,
    cbet: 640,
    aggression: 410,
};
const LOOSE_PASSIVE: Profile = Profile {
    hands: 1_873,
    vpip: 470,
    pfr: 60,
    three_bet: 20,
    fold_to_three_bet: 300,
    cbet: 360,
    aggression: 210,
};
const MANIAC: Profile = Profile {
    hands: 942,
    vpip: 580,
    pfr: 440,
    three_bet: 190,
    fold_to_three_bet: 280,
    cbet: 880,
    aggression: 680,
};
const NIT: Profile = Profile {
    hands: 3_305,
    vpip: 120,
    pfr: 90,
    three_bet: 25,
    fold_to_three_bet: 780,
    cbet: 720,
    aggression: 300,
};
/// A player first met a few hands ago: every figure dimmed by R2.5's
/// reliability, and no figure where nothing was counted yet.
const NEWCOMER: Profile = Profile {
    hands: 11,
    vpip: 450,
    pfr: 180,
    three_bet: 0,
    fold_to_three_bet: 0,
    cbet: 0,
    aggression: 500,
};
const SOLID_REG: Profile = Profile {
    hands: 12_960,
    vpip: 240,
    pfr: 200,
    three_bet: 95,
    fold_to_three_bet: 580,
    cbet: 600,
    aggression: 460,
};
const CALLING_STATION: Profile = Profile {
    hands: 517,
    vpip: 380,
    pfr: 110,
    three_bet: 40,
    fold_to_three_bet: 450,
    cbet: 500,
    aggression: 250,
};

impl Profile {
    /// The summed counters such a history leaves (what `Totals::sums`
    /// gives the engine).
    fn sums(&self) -> Result<Sums, String> {
        let h = self.hands;
        let rate = |opp: i64, permille: i64| opp * permille / 1000;
        let vpip_chances = h * 96 / 100;
        let three_bet_chances = h * 14 / 100;
        let f3b_chances = h * 4 / 100;
        let cbet_chances = h * 9 / 100;
        let actions = h * 60 / 100;
        let aggressive = rate(actions, self.aggression);
        let mut sums = Sums::default();
        for (name, value) in [
            ("hands", h),
            ("vpip_opp", vpip_chances),
            ("vpip", rate(vpip_chances, self.vpip)),
            ("pfr_opp", vpip_chances),
            ("pfr", rate(vpip_chances, self.pfr)),
            ("three_bet_opp", three_bet_chances),
            ("three_bet", rate(three_bet_chances, self.three_bet)),
            ("fold_to_three_bet_opp", f3b_chances),
            (
                "fold_to_three_bet",
                rate(f3b_chances, self.fold_to_three_bet),
            ),
            ("cbet_flop_opp", cbet_chances),
            ("cbet_flop", rate(cbet_chances, self.cbet)),
            ("bet_flop", aggressive),
            ("call_flop", actions - aggressive),
        ] {
            let counter = Counter::from_name(name).ok_or(format!("no counter {name}"))?;
            sums.counters[counter.index()] = value;
        }
        Ok(sums)
    }
}

/// One seated player.
#[derive(Debug, Clone)]
struct Player {
    seat: u32,
    name: String,
    hero: bool,
    archetype: &'static str,
    profile: Profile,
    stack: String,
    /// The user's words (drawn only where the room allows labels; the
    /// engine never reads them for the hero).
    words: PanelWords,
    /// The hero's hole cards, drawn on the plate as the simulator does.
    cards: Option<[&'static str; 2]>,
}

/// One state of the video.
#[derive(Debug, Clone)]
struct Demo {
    id: &'static str,
    site: &'static str,
    size: u32,
    players: Vec<Player>,
    /// Before the table's first hand: the engine's status line, no panels.
    waiting: bool,
    board: Vec<&'static str>,
    button: Option<u32>,
    stakes: &'static str,
    pot: &'static str,
    note: &'static str,
}

/// The players of a table: the hero in seat 1 (bottom centre: no room
/// rotates the table in the shipped `sites.json`), then one per profile.
fn table(
    names: &mut NameSource,
    rng: &mut Rng,
    currency: &str,
    others: &[(&'static str, Profile, PanelWords)],
) -> Vec<Player> {
    let stacks = [
        "10.00", "12.35", "8.60", "21.40", "4.85", "10.00", "15.20", "9.75", "6.10", "11.90",
    ];
    let mut players = vec![Player {
        seat: 1,
        name: HERO_NAME.to_owned(),
        hero: true,
        archetype: "hero",
        profile: HERO_PROFILE,
        stack: format!("{currency}{}", stacks[0]),
        words: PanelWords::default(),
        cards: Some(["Ah", "Qs"]),
    }];
    for ((seat, (archetype, profile, words)), stack) in (2..).zip(others).zip(&stacks[1..]) {
        players.push(Player {
            seat,
            name: loop {
                let name = names.fresh(rng);
                if !SLANG.iter().any(|word| name.contains(word)) {
                    break name;
                }
            },
            hero: false,
            archetype,
            profile: *profile,
            stack: format!("{currency}{stack}"),
            words: words.clone(),
            cards: None,
        });
    }
    players
}

fn words(colour: Option<TagColour>, label: Option<&str>, noted: bool) -> PanelWords {
    PanelWords {
        colour,
        label: label.map(str::to_owned),
        noted,
    }
}

fn demos(names: &mut NameSource, rng: &mut Rng) -> Vec<Demo> {
    let none = PanelWords::default;
    let six = |names: &mut NameSource, rng: &mut Rng, currency: &str| {
        table(
            names,
            rng,
            currency,
            &[
                ("tight regular", TIGHT_REG, none()),
                ("loose-passive", LOOSE_PASSIVE, none()),
                ("maniac", MANIAC, none()),
                ("nit", NIT, none()),
                ("tiny sample", NEWCOMER, none()),
            ],
        )
    };
    let stars = six(names, rng, "$");
    let mut waiting = stars.clone();
    for p in &mut waiting {
        p.cards = None;
    }
    let winamax = table(
        names,
        rng,
        "\u{20ac}",
        &[
            ("tight regular", TIGHT_REG, none()),
            (
                "loose-passive",
                LOOSE_PASSIVE,
                words(Some(TagColour::Yellow), Some("calls too wide"), true),
            ),
            (
                "maniac",
                MANIAC,
                words(Some(TagColour::Red), Some("barrels a lot"), false),
            ),
            (
                "nit",
                NIT,
                words(Some(TagColour::Blue), Some("folds to 3-bets"), true),
            ),
            ("tiny sample", NEWCOMER, none()),
        ],
    );
    let acr = table(
        names,
        rng,
        "$",
        &[
            ("tight regular", TIGHT_REG, none()),
            ("loose-passive", LOOSE_PASSIVE, none()),
            ("solid regular", SOLID_REG, none()),
            ("maniac", MANIAC, none()),
            ("calling station", CALLING_STATION, none()),
            ("nit", NIT, none()),
            ("tight regular", TIGHT_REG, none()),
            ("tiny sample", NEWCOMER, none()),
        ],
    );
    let gg = six(names, rng, "$");
    vec![
        Demo {
            id: "stars-6max",
            site: "pokerstars",
            size: 6,
            players: stars,
            waiting: false,
            board: vec!["Kh", "7c", "2d", "Ts"],
            button: Some(4),
            stakes: "$0.05/$0.10",
            pot: "Pot $1.85",
            note: "PokerStars: two colour thresholds, no player labels; the hero's own panel at the bottom",
        },
        Demo {
            id: "stars-waiting",
            site: "pokerstars",
            size: 6,
            players: waiting,
            waiting: true,
            board: Vec::new(),
            button: None,
            stakes: "$0.05/$0.10",
            pot: "",
            note: "PokerStars before the table's first hand: the engine's status pill, no panels",
        },
        Demo {
            id: "winamax-labels",
            site: "winamax",
            size: 6,
            players: winamax,
            waiting: false,
            board: vec!["9s", "9d", "4c"],
            button: Some(2),
            stakes: "\u{20ac}0.05/\u{20ac}0.10",
            pot: "Pot \u{20ac}0.95",
            note: "Winamax allows labelling players: colour tags, note marks and labels",
        },
        Demo {
            id: "acr-9max",
            site: "acr",
            size: 9,
            players: acr,
            waiting: false,
            board: vec!["Jc", "8h", "3s", "Qd", "5h"],
            button: Some(6),
            stakes: "$0.10/$0.25",
            pot: "Pot $6.40",
            note: "ACR forbids covering its table graphics: every panel clear of the plates and the board",
        },
        Demo {
            id: "ggpoker-refused",
            site: "ggpoker",
            size: 6,
            players: gg,
            waiting: false,
            board: vec!["As", "6h", "6c"],
            button: Some(3),
            stakes: "$0.05/$0.10",
            pot: "Pot $1.20",
            note: "GGPoker prohibits HUDs: compliance refuses the window, nothing is drawn",
        },
    ]
}

// ---------------------------------------------------------------------------
// One state: compose, write, describe.

fn render(
    demo: &Demo,
    compliance: &Compliance,
    rooms: &Rooms,
    out: &Path,
) -> Result<Value, String> {
    let room = compliance
        .config()
        .site(demo.site)
        .map_or(demo.site, |site| site.name.as_str());
    let layout = rooms
        .layout(demo.site, demo.size)
        .unwrap_or_else(|| TableLayout::simulator(demo.size));
    let hero_seat = demo.players.iter().find(|p| p.hero).map(|p| p.seat);
    let rotate_to = if rooms.rotates(demo.site) {
        hero_seat
    } else {
        None
    };
    let slot_of = |seat: u32| seats::slot_of(&layout, seat, rotate_to);

    let table_svg = table_svg(demo, room, &layout, &slot_of);
    let table_file = format!("{}.table.svg", demo.id);
    let overlay_file = format!("{}.overlay.svg", demo.id);
    write(&out.join(&table_file), &table_svg)?;

    let mut state = json!({
        "id": demo.id,
        "site": demo.site,
        "room": room,
        "note": demo.note,
        "width": WIDTH,
        "height": HEIGHT,
        "scalePermille": SCALE_PERMILLE,
        "tableSize": demo.size,
        "rotateTo": rotate_to,
        "files": { "table": table_file, "overlay": overlay_file },
        "board": rect_json(&layout::board_area(WIDTH, HEIGHT)),
        "tableGraphics": layout.graphics(WIDTH, HEIGHT).iter().map(rect_json).collect::<Vec<_>>(),
    });

    let permit = match compliance.permit(demo.site) {
        Ok(permit) => permit,
        Err(reason) => {
            // No frame of a refused room can exist: an empty overlay.
            write(&out.join(&overlay_file), &refused_svg())?;
            state["permitted"] = json!(false);
            state["refusal"] = json!({
                // The wire form the HUD sends the app (`attach_refused`).
                "reason": serde_json::to_value(reason).map_err(|e| e.to_string())?,
                "reasonDebug": format!("{reason:?}"),
                // What the app says for it (app/src/i18n/en.ts, `prohibited`).
                "appMessageEn": format!("{room}'s rules do not allow a HUD."),
                "policyNotes": compliance.config().site(demo.site).map(|s| s.hud.notes.clone()),
            });
            state["seats"] = Value::Array(
                demo.players
                    .iter()
                    .map(|p| seat_json(p, &layout, slot_of(p.seat), None, &[]))
                    .collect(),
            );
            state["legend"] = Value::Null;
            state["status"] = Value::Null;
            return Ok(state);
        }
    };

    let design = PanelDesign::default();
    let stats = PanelStats::new(&design);
    let mut panels = Vec::new();
    if !demo.waiting {
        for p in &demo.players {
            panels.push(SeatPanel {
                player: p.name.clone(),
                seat: Some(p.seat),
                hands: p.profile.hands,
                stats: stats.cells(&p.profile.sums()?),
                words: if p.hero {
                    PanelWords::default()
                } else {
                    p.words.clone()
                },
            });
        }
    }
    let frame = OverlayFrame {
        permit: permit.clone(),
        status: demo.waiting.then(|| WAITING.to_owned()),
        debug: None,
        size: Some(demo.size),
        seating: Seating {
            layout: rooms.layout(demo.site, demo.size),
            rotate_to,
            positions: rooms.positions(demo.site, demo.size),
            drags_seen: 0,
        },
        panels,
        legend: stats.legend_tones(),
        design: design.clone(),
    };
    let scene = scene::compose(&frame, WIDTH, HEIGHT, SCALE_PERMILLE, &design);
    if !scene.dropped.is_empty() {
        return Err(format!("{}: dropped {:?}", demo.id, scene.dropped));
    }
    write(&out.join(&overlay_file), &overlay_svg(&scene))?;

    let enforced = design.enforce(permit.restrictions());
    let seats_json: Vec<Value> = demo
        .players
        .iter()
        .map(|p| {
            let slot = slot_of(p.seat);
            let panel = frame.panels.iter().find(|panel| panel.seat == Some(p.seat));
            let cells: Vec<Value> = panel
                .map(|panel| {
                    panel
                        .stats
                        .iter()
                        .filter(|c| enforced.shows(&c.id))
                        .map(|c| {
                            let tone = c
                                .tone
                                .map(|t| collapse_tone(t, enforced.max_colour_thresholds));
                            json!({
                                "id": c.id,
                                "text": c.text,
                                "tone": tone.map(tone_name),
                                "opacityPermille": c.opacity_permille,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            seat_json(p, &layout, slot, Some(&scene), &cells)
        })
        .collect();
    state["permitted"] = json!(true);
    state["refusal"] = Value::Null;
    state["design"] = json!({
        "maxColourThresholds": enforced.max_colour_thresholds,
        "playerLabels": enforced.player_labels,
        "avoidTableGraphics": enforced.avoid_table_graphics,
        "legend": enforced.legend,
        "stats": enforced.stats.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
    });
    state["seats"] = Value::Array(seats_json);
    state["legend"] = scene.legend.as_ref().map_or(Value::Null, |(rect, tones)| {
        json!({
            "rect": rect_json(rect),
            "tones": tones.iter().map(|t| tone_name(*t)).collect::<Vec<_>>(),
        })
    });
    state["status"] = frame.status.as_ref().map_or(Value::Null, |status| {
        scene
            .items
            .iter()
            .find_map(|item| match item {
                Item::Text { rect, text, .. } if text == status => {
                    Some(json!({ "rect": rect_json(rect), "text": status }))
                }
                _ => None,
            })
            .unwrap_or(Value::Null)
    });
    Ok(state)
}

fn seat_json(
    p: &Player,
    layout: &TableLayout,
    slot: Option<u32>,
    scene: Option<&Scene>,
    cells: &[Value],
) -> Value {
    let plate = slot.and_then(|s| layout.plate(WIDTH, HEIGHT, s));
    let panel = scene.and_then(|scene| {
        let slot = slot?;
        scene
            .seat_panels
            .iter()
            .find(|(s, _)| *s == slot)
            .map(|(_, r)| *r)
    });
    let tag = scene.and_then(|scene| {
        let slot = slot?;
        scene.tags.iter().find(|(s, _)| *s == slot).map(|(_, r)| *r)
    });
    let note = scene.and_then(|scene| {
        let panel = panel?;
        scene.items.iter().find_map(|item| match item {
            Item::Fill { rect, color, .. } if *color == NOTE && within(rect, &panel) => Some(*rect),
            _ => None,
        })
    });
    let label = scene.and_then(|scene| {
        let panel = panel?;
        let wanted = p.words.label.as_deref()?;
        scene.items.iter().find_map(|item| match item {
            Item::Text { rect, text, .. } if text == wanted && within(rect, &panel) => {
                Some(json!({ "rect": rect_json(rect), "text": text }))
            }
            _ => None,
        })
    });
    let drawn_tag = tag.and(p.words.colour);
    json!({
        "seat": p.seat,
        "slot": slot,
        "name": p.name,
        "hero": p.hero,
        "archetype": p.archetype,
        "stack": p.stack,
        "hands": p.profile.hands,
        "plate": plate.as_ref().map(rect_json),
        "panel": panel.as_ref().map(rect_json),
        "cells": cells,
        "tag": tag.as_ref().map(|r| json!({
            "rect": rect_json(r),
            "colour": drawn_tag.map(colour_name),
        })),
        "noteMark": note.as_ref().map(rect_json),
        "label": label,
    })
}

// ---------------------------------------------------------------------------
// SVG.

/// A refused room's overlay: nothing (no frame exists for it).
fn refused_svg() -> String {
    let mut out = String::new();
    svg_open(&mut out);
    out.push_str("<!-- compliance refused this room: no frame, nothing drawn -->\n</svg>\n");
    out
}

fn svg_open(out: &mut String) {
    let _ = writeln!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">"#
    );
}

/// The scene's items, back to front, grouped by what they belong to (a
/// seat's panel, the legend, the status pill) so a video can animate each.
fn overlay_svg(scene: &Scene) -> String {
    let mut out = String::new();
    svg_open(&mut out);
    let _ = writeln!(
        out,
        "<!-- rail-hud scene::compose output; transparent background -->"
    );
    let group_of = |rect: &Rect| -> String {
        if let Some((slot, _)) = scene.seat_panels.iter().find(|(_, p)| within(rect, p)) {
            return format!(r#"id="panel-slot-{slot}" data-kind="seat-panel" data-slot="{slot}""#);
        }
        if let Some((legend, _)) = &scene.legend
            && within(rect, legend)
        {
            return r#"id="legend" data-kind="legend""#.to_owned();
        }
        r#"id="status" data-kind="status""#.to_owned()
    };
    let mut open: Option<String> = None;
    for item in &scene.items {
        let rect = match item {
            Item::Fill { rect, .. } | Item::Text { rect, .. } => rect,
        };
        let group = group_of(rect);
        if open.as_ref() != Some(&group) {
            if open.is_some() {
                out.push_str("</g>\n");
            }
            let _ = writeln!(out, "<g {group}>");
            open = Some(group);
        }
        match item {
            Item::Fill {
                rect,
                radius,
                color,
            } => {
                let _ = writeln!(
                    out,
                    r#"  <rect x="{}" y="{}" width="{}" height="{}" rx="{radius}" {}/>"#,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    paint(*color)
                );
            }
            Item::Text {
                rect,
                text,
                px,
                color,
                bold,
                align: scene::Align::Center,
            } => {
                let _ = writeln!(
                    out,
                    r#"  <text x="{}" y="{}" font-family="{FONT}" font-size="{px}" font-weight="{}" text-anchor="middle" dominant-baseline="central" {}>{}</text>"#,
                    half(2 * i64::from(rect.x) + i64::from(rect.width)),
                    half(2 * i64::from(rect.y) + i64::from(rect.height)),
                    if *bold { 700 } else { 400 },
                    paint(*color),
                    escape(text)
                );
            }
        }
    }
    if open.is_some() {
        out.push_str("</g>\n");
    }
    out.push_str("</svg>\n");
    out
}

/// The drawn table under the overlay, from the layout the scene uses.
fn table_svg(
    demo: &Demo,
    room: &str,
    layout: &TableLayout,
    slot_of: &dyn Fn(u32) -> Option<u32>,
) -> String {
    let (w, h) = (i64::from(WIDTH), i64::from(HEIGHT));
    let center = layout.center;
    let (cx, cy) = (
        w * i64::from(center.0) / 1000,
        h * i64::from(center.1) / 1000,
    );
    let mut out = String::new();
    svg_open(&mut out);
    let _ = writeln!(
        out,
        r#"<defs><radialGradient id="felt" cx="50%" cy="45%" r="60%"><stop offset="0%" stop-color="{FELT_LIGHT}"/><stop offset="100%" stop-color="{FELT}"/></radialGradient></defs>"#
    );
    let _ = writeln!(
        out,
        r#"<rect width="{WIDTH}" height="{HEIGHT}" fill="{BACKGROUND}"/>"#
    );
    // Rail and felt (the simulator's ellipses).
    let _ = writeln!(
        out,
        r#"<ellipse id="rail" cx="{cx}" cy="{cy}" rx="{}" ry="{}" fill="{RAIL}" stroke="{RAIL_EDGE}" stroke-width="6"/>"#,
        w * 370 / 1000,
        h * 270 / 1000
    );
    let _ = writeln!(
        out,
        r#"<ellipse id="felt" cx="{cx}" cy="{cy}" rx="{}" ry="{}" fill="url(#felt)"/>"#,
        w * 345 / 1000,
        h * 240 / 1000
    );
    // A measured layout's own zones (none is measured yet).
    if let Graphics::Measured { .. } = layout.graphics {
        for zone in layout
            .graphics(WIDTH, HEIGHT)
            .iter()
            .skip(layout.slots.len())
        {
            let _ = writeln!(
                out,
                r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{SEAT}" opacity="0.6"/>"#,
                zone.x, zone.y, zone.width, zone.height
            );
        }
    }

    // The board and the pot.
    let card_h = (h / 9).max(24);
    let card_w = card_h * 7 / 10;
    let gap = card_w / 6;
    let count = i64::try_from(demo.board.len()).unwrap_or(0);
    let total = count * card_w + (count - 1).max(0) * gap;
    let mut x = cx - total / 2;
    out.push_str("<g id=\"board\">\n");
    for card in &demo.board {
        let (rank, suit, colour) = card_face(card);
        let _ = writeln!(
            out,
            r#"  <rect x="{x}" y="{}" width="{card_w}" height="{card_h}" rx="{}" fill="{CARD}" stroke="{CARD_EDGE}" stroke-width="2"/>"#,
            cy - card_h / 2,
            card_h / 12
        );
        let _ = writeln!(
            out,
            r#"  <text x="{}" y="{cy}" font-family="{FONT}" font-size="{}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="{colour}">{rank}{suit}</text>"#,
            x + card_w / 2,
            if rank.chars().count() > 1 {
                card_h * 30 / 100
            } else {
                card_h * 38 / 100
            }
        );
        x += card_w + gap;
    }
    if !demo.pot.is_empty() {
        let _ = writeln!(
            out,
            r#"  <text x="{cx}" y="{}" font-family="{FONT}" font-size="26" text-anchor="middle" dominant-baseline="central" fill="{TEXT}">{}</text>"#,
            cy + card_h / 2 + 30,
            escape(demo.pot)
        );
    }
    out.push_str("</g>\n");

    // The seats.
    let line = 10 * (h / 330).clamp(1, 3);
    for p in &demo.players {
        let Some(slot) = slot_of(p.seat) else {
            continue;
        };
        let (Some(plate), Some(seat_center)) =
            (layout.plate(WIDTH, HEIGHT, slot), layout.slot_center(slot))
        else {
            continue;
        };
        let (px, py) = (i64::from(plate.x), i64::from(plate.y));
        let (pw, ph) = (i64::from(plate.width), i64::from(plate.height));
        let sx = px + pw / 2;
        let _ = writeln!(
            out,
            r#"<g id="plate-seat-{}" data-seat="{}" data-slot="{slot}">"#,
            p.seat, p.seat
        );
        let _ = writeln!(
            out,
            r#"  <rect x="{px}" y="{py}" width="{pw}" height="{ph}" rx="8" fill="{SEAT}"{}/>"#,
            if p.hero {
                format!(r#" stroke="{HERO}" stroke-width="4""#)
            } else {
                String::new()
            }
        );
        let max_chars = usize::try_from((pw - 12) * 100 / (line * 80 * 56 / 100)).unwrap_or(8);
        let rows = [
            (fit(&p.name, max_chars), TEXT, 700, line * 80 / 100),
            (p.stack.clone(), DIM, 400, line * 74 / 100),
            match (p.hero, p.cards) {
                (true, Some([a, b])) => {
                    let (ra, sa, _) = card_face(a);
                    let (rb, sb, _) = card_face(b);
                    (format!("{ra}{sa} {rb}{sb}"), HERO, 700, line * 80 / 100)
                }
                (true, None) => (format!("seat {}", p.seat), HERO, 400, line * 66 / 100),
                (false, _) => (format!("seat {}", p.seat), DIM, 400, line * 66 / 100),
            },
        ];
        for ((text, colour, weight, size), k) in rows.into_iter().zip(0_i64..) {
            let _ = writeln!(
                out,
                r#"  <text x="{sx}" y="{}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" text-anchor="middle" dominant-baseline="central" fill="{colour}">{}</text>"#,
                py + ph * (1 + 2 * k) / 6,
                escape(&text)
            );
        }
        out.push_str("</g>\n");
        if demo.button == Some(p.seat) {
            let (bx, by) = (
                w * i64::from(seat_center.0) / 1000,
                h * i64::from(seat_center.1) / 1000,
            );
            let bx = cx + (bx - cx) * 62 / 100;
            let by = cy + (by - cy) * 62 / 100;
            let r = (h / 40).max(7);
            let _ = writeln!(
                out,
                r#"<g id="dealer-button"><circle cx="{bx}" cy="{by}" r="{r}" fill="{BUTTON}" stroke="{BUTTON_EDGE}" stroke-width="2"/><text x="{bx}" y="{by}" font-family="{FONT}" font-size="{}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="{BLACK}">D</text></g>"#,
                r * 11 / 10
            );
        }
    }

    // What this is, top centre: clear of every panel, the status pill and
    // the legend (a corner).
    let _ = writeln!(
        out,
        r#"<text x="{}" y="28" font-family="{FONT}" font-size="22" text-anchor="middle" dominant-baseline="central" fill="{DIM}">Rail demo table - not a poker client - {} rules - {}-max {}</text>"#,
        w / 2,
        escape(room),
        demo.size,
        escape(demo.stakes)
    );
    out.push_str("</svg>\n");
    out
}

/// A card's rank, suit sign and colour (the simulator's four colours).
fn card_face(card: &str) -> (String, &'static str, &'static str) {
    let rank: String = card
        .chars()
        .take(card.chars().count().saturating_sub(1))
        .map(|c| {
            if c == 'T' {
                "10".to_owned()
            } else {
                c.to_string()
            }
        })
        .collect();
    match card.chars().last() {
        Some('h') => (rank, "\u{2665}", "#c01a1a"),
        Some('d') => (rank, "\u{2666}", "#1a4fc0"),
        Some('c') => (rank, "\u{2663}", "#108030"),
        _ => (rank, "\u{2660}", BLACK),
    }
}

fn fit(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        text.chars()
            .take(max.saturating_sub(1))
            .chain(['\u{2026}'])
            .collect()
    }
}

/// `fill` and, below full opacity, `fill-opacity` (thousandths, rounded).
fn paint(color: Rgba) -> String {
    let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
    if color.a == u8::MAX {
        format!(r#"fill="{hex}""#)
    } else {
        let permille = (u32::from(color.a) * 2000 + 255) / 510;
        format!(
            r#"fill="{hex}" fill-opacity="{}.{:03}""#,
            permille / 1000,
            permille % 1000
        )
    }
}

/// Twice a coordinate, written as the coordinate (`.5` when odd).
fn half(twice: i64) -> String {
    if twice % 2 == 0 {
        (twice / 2).to_string()
    } else {
        format!("{}.5", twice.div_euclid(2))
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Whether `inner` lies within `outer`.
fn within(inner: &Rect, outer: &Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && i64::from(inner.x) + i64::from(inner.width)
            <= i64::from(outer.x) + i64::from(outer.width)
        && i64::from(inner.y) + i64::from(inner.height)
            <= i64::from(outer.y) + i64::from(outer.height)
}

fn rect_json(rect: &Rect) -> Value {
    json!({ "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height })
}

fn tone_name(tone: Tone) -> Value {
    serde_json::to_value(tone).unwrap_or(Value::Null)
}

fn colour_name(colour: TagColour) -> &'static str {
    match colour {
        TagColour::Red => "red",
        TagColour::Orange => "orange",
        TagColour::Yellow => "yellow",
        TagColour::Green => "green",
        TagColour::Blue => "blue",
        TagColour::Purple => "purple",
    }
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

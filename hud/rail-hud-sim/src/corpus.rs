//! The real hands a room's tables replay: every hand of
//! `fixtures/samples/<room>/` that the room's parser reads, whose first
//! line is the live client's header (`rooms.json` `header`), and that
//! survives a trial rewrite ([`crate::rewrite`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rail_core::detect::ConvertOptions;
use rail_core::phf::{GameFormat, LimitType, PhfHand, Variant};
use regex::Regex;

use crate::rewrite::{Target, rewrite, text_hand_id};
use crate::room::Room;

/// The corpus folder this crate was built next to.
pub fn default_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures")
        .join("samples")
}

/// Hands that can share a table: cash or tournament, the game, the size.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Group {
    pub tournament: bool,
    /// `variant-limit`, e.g. `holdem-nl`.
    pub game: String,
    pub size: u32,
}

/// One corpus hand.
#[derive(Debug, Clone)]
pub struct Template {
    /// The corpus file, relative to the corpus root.
    pub source: PathBuf,
    /// The hand's text as the core split it (decoded, LF line ends).
    pub text: String,
    pub hand: PhfHand,
}

/// A room's templates by group, and what was left out.
#[derive(Debug, Default)]
pub struct Pool {
    pub groups: BTreeMap<Group, Vec<Template>>,
    /// Table names seen in the room's cash hands, per size.
    pub table_names: BTreeMap<u32, Vec<String>>,
    pub files: usize,
    /// Hands the parser reads that the simulator does not use, with why.
    pub left_out: Vec<(PathBuf, String)>,
}

impl Pool {
    pub fn templates(&self) -> usize {
        self.groups.values().map(Vec::len).sum()
    }

    /// The groups for a kind and size, the largest first.
    pub fn groups_for(&self, tournament: bool, size: u32) -> Vec<(&Group, &Vec<Template>)> {
        let mut out: Vec<_> = self
            .groups
            .iter()
            .filter(|(g, _)| g.tournament == tournament && g.size == size)
            .collect();
        out.sort_by_key(|(g, list)| (std::cmp::Reverse(list.len()), (*g).clone()));
        out
    }

    /// Sizes that have templates, per kind.
    pub fn sizes(&self, tournament: bool) -> Vec<u32> {
        let mut sizes: Vec<u32> = self
            .groups
            .keys()
            .filter(|g| g.tournament == tournament)
            .map(|g| g.size)
            .collect();
        sizes.dedup();
        sizes
    }
}

/// `variant-limit` of a hand.
pub fn game_key(hand: &PhfHand) -> String {
    let variant = match hand.game.variant {
        Variant::Holdem => "holdem",
        Variant::Omaha => "omaha",
        Variant::Omaha5 => "omaha5",
        Variant::Omaha6 => "omaha6",
        Variant::Shortdeck => "shortdeck",
        Variant::Stud => "stud",
        Variant::Razz => "razz",
        Variant::Draw => "draw",
        Variant::Other => "other",
    };
    let limit = match hand.game.limit {
        LimitType::Nl => "nl",
        LimitType::Pl => "pl",
        LimitType::Fl => "fl",
    };
    let hilo = if hand.game.hi_lo { "8" } else { "" };
    format!("{variant}{hilo}-{limit}")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            walk(&path, out);
        } else if path.extension().is_some_and(|e| e == "txt") {
            out.push(path);
        }
    }
}

/// Load a room's templates from `root/<room.corpus>`.
pub fn load(room: &Room, root: &Path) -> Result<Pool, String> {
    let dir = root.join(&room.corpus);
    if !dir.is_dir() {
        return Err(format!(
            "no corpus folder {} (pass --corpus <fixtures/samples>)",
            dir.display()
        ));
    }
    let header = Regex::new(&room.header).map_err(|e| e.to_string())?;
    let registry = rail_core::parsers::builtin();
    let parser = registry
        .get(&room.parser)
        .ok_or_else(|| format!("no parser {}", room.parser))?;
    let options = ConvertOptions {
        site_id: Some(room.parser.clone()),
        ..ConvertOptions::default()
    };
    let mut files = Vec::new();
    walk(&dir, &mut files);
    let mut pool = Pool {
        files: files.len(),
        ..Pool::default()
    };
    let probe: Vec<String> = (1..=10).map(|i| format!("Probe_{i}x")).collect();
    for path in files {
        let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let decoded = rail_core::decode::decode_source(&bytes);
        if decoded.problem.is_some() {
            continue;
        }
        let Ok(chunks) = parser.split_hands(&decoded.text) else {
            continue;
        };
        for chunk in chunks {
            let first = chunk.trim_start().lines().next().unwrap_or("");
            if !header.is_match(first) {
                continue;
            }
            let Ok(result) = rail_core::convert_any(&chunk, &options) else {
                continue;
            };
            if !result.failures.is_empty() || result.hands.len() != 1 {
                continue;
            }
            let Some(converted) = result.hands.into_iter().next() else {
                continue;
            };
            let hand = converted.hand;
            let text = chunk.trim().to_owned();
            let tournament = hand.game.format != GameFormat::Cash;
            let size = hand.table.max_seats;
            // A trial rewrite: a table of the probe names, the hero in seat
            // 1, a tournament id of the same length.
            let tid = hand
                .tournament
                .as_ref()
                .map(|t| "7".repeat(t.id.len().max(1)));
            let hand_id = if text_hand_id(&hand, &text).is_some_and(|id| id.contains('-')) {
                "1234567-89-1700000000".to_owned()
            } else {
                "123456789012".to_owned()
            };
            let target = Target {
                hand_id: &hand_id,
                table_name: "Probe Table 1",
                played_at: 1_700_000_000,
                tournament_id: tid.as_deref(),
                hero_seat: 1,
                roster: &probe,
                hero_name: "Probe_Hero",
                hero_pick: 0,
            };
            if let Err(why) = rewrite(&text, &hand, &room.parser, Some(&room.dealt), &target) {
                pool.left_out.push((relative.clone(), why));
                continue;
            }
            if let (false, Some(name)) = (tournament, &hand.table.name) {
                let names = pool.table_names.entry(size).or_default();
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
            let group = Group {
                tournament,
                game: game_key(&hand),
                size,
            };
            pool.groups.entry(group).or_default().push(Template {
                source: relative.clone(),
                text,
                hand,
            });
        }
    }
    if pool.groups.is_empty() {
        return Err(format!(
            "no usable {} hand under {}{}",
            room.name,
            dir.display(),
            pool.left_out
                .first()
                .map(|(path, why)| format!(" (e.g. {}: {why})", path.display()))
                .unwrap_or_default()
        ));
    }
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room::rooms;

    #[test]
    fn every_room_has_cash_tables_of_its_sizes() {
        for room in rooms() {
            let pool = load(&room, &default_root()).expect("loads");
            for size in &room.sizes {
                assert!(
                    !pool.groups_for(false, *size).is_empty(),
                    "{}: no {size}-max cash hand",
                    room.id
                );
            }
            assert_eq!(
                pool.sizes(true).is_empty(),
                room.tournament.is_none(),
                "{}: tournament templates exactly when rooms.json names tournaments",
                room.id
            );
        }
    }

    /// Every usable hand rewrites for any hero seat and any hero pick,
    /// not only for the trial target: what a run will ask of it.
    #[test]
    fn every_template_rewrites_for_any_seat() {
        let roster: Vec<String> = (1..=10).map(|i| format!("Roster_{i}z")).collect();
        for room in rooms() {
            let pool = load(&room, &default_root()).expect("loads");
            for (group, templates) in &pool.groups {
                for template in templates {
                    for hero_seat in 1..=group.size {
                        let id = text_hand_id(&template.hand, &template.text).unwrap_or("");
                        let hand_id = if id.contains('-') {
                            "42-7-1800000000"
                        } else {
                            "987654321"
                        };
                        let tid = template
                            .hand
                            .tournament
                            .as_ref()
                            .map(|_| "31337".to_owned());
                        let target = Target {
                            hand_id,
                            table_name: "Sim Table 9",
                            played_at: 1_800_000_000,
                            tournament_id: tid.as_deref(),
                            hero_seat,
                            roster: &roster,
                            hero_name: "Sim_Hero",
                            hero_pick: hero_seat * 7,
                        };
                        let rewritten = rewrite(
                            &template.text,
                            &template.hand,
                            &room.parser,
                            Some(&room.dealt),
                            &target,
                        )
                        .unwrap_or_else(|e| panic!("{}: {e}", template.source.display()));
                        let hero = rewritten
                            .hand
                            .players
                            .iter()
                            .find(|p| p.is_hero)
                            .expect("a hero");
                        assert_eq!((hero.seat, hero.name.as_str()), (hero_seat, "Sim_Hero"));
                    }
                }
            }
        }
    }
}

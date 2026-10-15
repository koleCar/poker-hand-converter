//! The simulator without its windows: tables, the play-speed clock, the
//! writing of hands, the commands and the events.
//!
//! The window front end (`gui.rs` in the binary) and the headless loop
//! both drive this: [`Sim::tick`] when [`Sim::next_due`] comes,
//! [`Sim::apply`] for a command, [`Sim::take_events`] for what happened.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use rail_core::phf::{CurrencyUnit, PhfHand};
use serde::Serialize;

use crate::clock::{Civil, Rng, unix_ms};
use crate::command::Command;
use crate::corpus::{Group, Pool, Template, game_key};
use crate::names::NameSource;
use crate::output;
use crate::rewrite::{Target, rewrite, text_hand_id};
use crate::room::{Fields, FileEncoding, LineEnd, Naming, Room, file_safe, fill};

/// How a run is set up (the command line).
#[derive(Debug, Clone)]
pub struct Config {
    pub room: Room,
    /// `fixtures/samples`.
    pub corpus: PathBuf,
    pub out: PathBuf,
    pub tables: u32,
    /// Table sizes, cycled over the tables; empty = the room's.
    pub sizes: Vec<u32>,
    pub tournament: bool,
    /// `variant-limit` (`holdem-nl`); `None` = the largest group per size.
    pub game: Option<String>,
    /// Hands per minute per table, in hundredths.
    pub speed: u32,
    /// +- percent of the interval.
    pub jitter: u32,
    /// Stop writing after this many hands in all.
    pub hands: Option<u64>,
    pub hero: String,
    pub seed: u64,
    pub encoding: FileEncoding,
    pub line_end: LineEnd,
}

/// One seat as the window draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatView {
    pub seat: u32,
    pub name: String,
    pub stack: String,
    pub hero: bool,
    pub cards: Vec<String>,
    pub sitting_out: bool,
}

/// The last hand written for a table, as the window draws it.
#[derive(Debug, Clone)]
pub struct Shown {
    pub hand_id: String,
    pub stakes: String,
    pub seats: Vec<SeatView>,
    pub button: Option<u32>,
    pub board: Vec<String>,
}

/// One open table.
#[derive(Debug, Clone)]
pub struct Table {
    pub id: u32,
    pub size: u32,
    pub group: Group,
    /// The table name the hands carry.
    pub name: String,
    pub title: String,
    pub tournament_id: Option<String>,
    pub table_number: u32,
    pub tournament_name: String,
    /// Per-table game id (file names, Winamax hand ids).
    pub game_id: String,
    pub hero_seat: u32,
    /// Player per seat (index = seat - 1); the hero's entry is unused.
    pub roster: Vec<String>,
    pub hands: u64,
    pub due: Instant,
    pub shown: Option<Shown>,
    pub file: Option<PathBuf>,
    /// Bumped on every change a window shows.
    pub version: u64,
    /// The template the title's and the file's stakes come from; later
    /// hands are of the same stakes when the corpus has three or more such,
    /// else of the same currency.
    stakes: usize,
    /// Written first (the stakes template).
    first: Option<usize>,
}

/// What happened, one JSON object per line on standard output.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Started {
        room: String,
        out: String,
        tables: u32,
        seed: u64,
        templates: usize,
        title_regex: String,
    },
    #[serde(rename_all = "camelCase")]
    Table {
        table: u32,
        title: String,
        table_name: String,
        size: u32,
        game: String,
        hero_seat: u32,
        moved: bool,
    },
    #[serde(rename_all = "camelCase")]
    Hand {
        table: u32,
        hand_id: String,
        hand_key: String,
        site: String,
        table_name: String,
        file: String,
        players: Vec<String>,
        bytes: usize,
        at_ms: i64,
        template: String,
    },
    #[serde(rename_all = "camelCase")]
    Closed { table: u32 },
    /// `x`, `y`: the frame's top-left; `clientX`, `clientY`: the client
    /// area's (what the table is drawn in, `width` x `height`); all screen
    /// coordinates in physical pixels.
    #[serde(rename_all = "camelCase")]
    Window {
        table: u32,
        title: String,
        x: i32,
        y: i32,
        client_x: i32,
        client_y: i32,
        width: u32,
        height: u32,
        minimized: bool,
    },
    #[serde(rename_all = "camelCase")]
    Paused { paused: bool },
    #[serde(rename_all = "camelCase")]
    Speed { hands_per_minute: String },
    #[serde(rename_all = "camelCase")]
    Status {
        paused: bool,
        hands: u64,
        tables: Vec<TableStatus>,
    },
    #[serde(rename_all = "camelCase")]
    Done { hands: u64 },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStatus {
    pub table: u32,
    pub title: String,
    pub table_name: String,
    pub size: u32,
    pub hands: u64,
    pub file: Option<String>,
}

/// The store's key of a hand (`rail_store::batch::hand_key_of`).
pub fn hand_key(hand: &PhfHand) -> String {
    let site = hand.meta.site_id.trim().to_lowercase();
    let key = if hand.meta.hand_key.is_empty() {
        &hand.meta.hand_id
    } else {
        &hand.meta.hand_key
    };
    format!("{site}:{key}")
}

/// An amount as a title or a seat shows it: `$0.05`, `$2`, `1500`.
pub fn money(amount: i64, unit: &CurrencyUnit) -> String {
    let minor = i64::from(unit.minor_units.max(1));
    let sign = if amount < 0 { "-" } else { "" };
    let amount = amount.abs();
    if minor == 1 {
        return format!("{sign}{}{amount}", unit.symbol);
    }
    let (whole, frac) = (amount / minor, amount % minor);
    if frac == 0 {
        format!("{sign}{}{whole}", unit.symbol)
    } else {
        format!("{sign}{}{whole}.{frac:02}", unit.symbol)
    }
}

/// `Hold'em No Limit`-style name of a `variant-limit` key, for rooms that
/// do not name the game themselves.
fn default_game_name(key: &str) -> String {
    let (variant, limit) = key.split_once('-').unwrap_or((key, ""));
    let limit = match limit {
        "nl" => "No Limit",
        "pl" => "Pot Limit",
        "fl" => "Limit",
        other => other,
    };
    let variant = match variant {
        "holdem" => "Hold'em",
        "omaha" => "Omaha",
        "omaha8" => "Omaha Hi/Lo",
        "omaha5" => "5 Card Omaha",
        "shortdeck" => "6+ Hold'em",
        other => other,
    };
    format!("{limit} {variant}")
}

/// Hands per minute from hundredths, as typed (`2.5`).
pub fn speed_text(centi: u32) -> String {
    if centi.is_multiple_of(100) {
        format!("{}", centi / 100)
    } else {
        format!("{}.{:02}", centi / 100, centi % 100)
            .trim_end_matches('0')
            .to_owned()
    }
}

/// The simulator.
#[derive(Debug)]
pub struct Sim {
    pub config: Config,
    pool: Pool,
    rng: Rng,
    names: NameSource,
    tables: Vec<Table>,
    next_table: u32,
    next_hand: u64,
    paused_at: Option<Instant>,
    written: u64,
    events: Vec<Event>,
    used_table_names: HashSet<String>,
    quit: bool,
    done_reported: bool,
}

impl Sim {
    /// Load the room's hands, prepare the folder and open the tables.
    pub fn new(mut config: Config) -> Result<Self, String> {
        let pool = crate::corpus::load(&config.room, &config.corpus)?;
        if config.tournament && config.room.tournament.is_none() {
            return Err(format!(
                "{} has no tournament tables in the simulator (no tournament hand in the corpus)",
                config.room.name
            ));
        }
        let available = pool.sizes(config.tournament);
        if config.sizes.is_empty() {
            config.sizes = if config.tournament {
                available.clone()
            } else {
                config.room.sizes.clone()
            };
        }
        for size in &config.sizes {
            if !available.contains(size) {
                return Err(format!(
                    "no {size}-max {} {} hand in the corpus (sizes: {available:?})",
                    config.room.name,
                    if config.tournament {
                        "tournament"
                    } else {
                        "cash"
                    }
                ));
            }
        }
        output::prepare(&config.out)?;
        let naming = Self::naming_of(&config);
        let start_hand = 100_000_000_000 + u64::try_from(unix_ms()).unwrap_or(0) % 800_000_000_000;
        let mut sim = Self {
            rng: Rng::new(config.seed),
            pool,
            names: NameSource::default(),
            tables: Vec::new(),
            next_table: 1,
            next_hand: start_hand,
            paused_at: None,
            written: 0,
            events: Vec::new(),
            used_table_names: HashSet::new(),
            quit: false,
            done_reported: false,
            config,
        };
        sim.names.reserve(&sim.config.hero);
        sim.events.push(Event::Started {
            room: sim.config.room.id.clone(),
            out: sim.config.out.display().to_string(),
            tables: sim.config.tables,
            seed: sim.config.seed,
            templates: sim.pool.templates(),
            title_regex: crate::room::title_regex(&naming),
        });
        for _ in 0..sim.config.tables {
            sim.open_table(None)?;
        }
        Ok(sim)
    }

    fn naming_of(config: &Config) -> Naming {
        if config.tournament {
            config
                .room
                .tournament
                .clone()
                .unwrap_or_else(|| config.room.cash.clone())
        } else {
            config.room.cash.clone()
        }
    }

    /// How this run's tables are titled and filed.
    pub fn naming(&self) -> Naming {
        Self::naming_of(&self.config)
    }

    pub fn tables(&self) -> &[Table] {
        &self.tables
    }

    pub fn table(&self, id: u32) -> Option<&Table> {
        self.tables.iter().find(|t| t.id == id)
    }

    pub fn paused(&self) -> bool {
        self.paused_at.is_some()
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    /// Every hand asked for (`--hands`) is written.
    pub fn done(&self) -> bool {
        self.config.hands.is_some_and(|n| self.written >= n)
    }

    /// `quit` was asked for, or every table is closed.
    pub fn should_quit(&self) -> bool {
        self.quit || self.tables.is_empty()
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    pub fn push_event(&mut self, event: Event) {
        self.events.push(event);
    }

    /// When the next hand is due; `None` while paused or done.
    pub fn next_due(&self) -> Option<Instant> {
        if self.paused() || self.done() {
            return None;
        }
        self.tables.iter().map(|t| t.due).min()
    }

    fn interval(&mut self) -> Duration {
        let base = 6_000_000 / u64::from(self.config.speed.max(1));
        let spread = base * u64::from(self.config.jitter.min(95)) / 100;
        let low = i64::try_from(base - spread).unwrap_or(0);
        let high = i64::try_from(base + spread).unwrap_or(low);
        Duration::from_millis(
            u64::try_from(self.rng.between(low, high))
                .unwrap_or(base)
                .max(1),
        )
    }

    fn pick_table_name(&mut self, size: u32) -> String {
        let mut candidates: Vec<String> = self
            .pool
            .table_names
            .get(&size)
            .cloned()
            .unwrap_or_default();
        for (other, names) in &self.pool.table_names {
            if *other != size {
                candidates.extend(names.iter().cloned());
            }
        }
        candidates.retain(|n| !self.used_table_names.contains(n));
        let name = if candidates.is_empty() {
            let base = self
                .pool
                .table_names
                .values()
                .flatten()
                .next()
                .cloned()
                .unwrap_or_else(|| "Table".to_owned());
            let mut k = 2;
            while self.used_table_names.contains(&format!("{base} {k}")) {
                k += 1;
            }
            format!("{base} {k}")
        } else {
            candidates[self.rng.index(candidates.len())].clone()
        };
        self.used_table_names.insert(name.clone());
        name
    }

    fn group_for(&self, size: u32) -> Option<Group> {
        let groups = self.pool.groups_for(self.config.tournament, size);
        if let Some((g, _)) = self
            .config
            .game
            .as_ref()
            .and_then(|game| groups.iter().find(|(g, _)| &g.game == game))
        {
            return Some((*g).clone());
        }
        groups
            .iter()
            .find(|(g, _)| g.game == "holdem-nl")
            .or_else(|| groups.first())
            .map(|(g, _)| (*g).clone())
    }

    fn templates_of(&self, group: &Group) -> &[Template] {
        self.pool
            .groups
            .get(group)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn fields(&self, table: &Table, template: &Template) -> Fields {
        let hand = &template.hand;
        let unit = &hand.game.unit;
        let key = game_key(hand);
        let mut fields = Fields::default();
        let (sb, bb) = (
            money(hand.game.small_blind, unit),
            money(hand.game.big_blind, unit),
        );
        fields
            .set("table", table.name.clone())
            .set("stakes", format!("{sb}/{bb}"))
            .set("stakesDash", format!("{sb}-{bb}"))
            .set("currency", unit.code.clone())
            .set(
                "game",
                self.config
                    .room
                    .games
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| default_game_name(&key)),
            )
            .set(
                "gameFile",
                self.config
                    .room
                    .game_files
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| key.clone()),
            )
            .set("hero", self.config.hero.clone())
            .set("size", table.size.to_string())
            .set("tid", table.tournament_id.clone().unwrap_or_default())
            .set("tno", table.table_number.to_string())
            .set("tname", table.tournament_name.clone())
            .set("gid", table.game_id.clone());
        fields
    }

    /// Seat a new table: name, hero seat, opponents, title.
    fn seat_table(&mut self, table: &mut Table) {
        let naming = self.naming();
        table.hero_seat = u32::try_from(self.rng.between(1, i64::from(table.size))).unwrap_or(1);
        table.roster = (0..table.size)
            .map(|_| self.names.fresh(&mut self.rng))
            .collect();
        if self.config.tournament {
            let mut fields = Fields::default();
            fields
                .set("tid", table.tournament_id.clone().unwrap_or_default())
                .set("tno", table.table_number.to_string());
            table.name = fill(
                naming.table_from_title.as_deref().unwrap_or("{tid} {tno}"),
                &fields,
            );
        } else {
            table.name = self.pick_table_name(table.size);
        }
        let template = self.templates_of(&table.group).get(table.stakes).cloned();
        if let Some(template) = template {
            if let (true, Some(name)) = (
                table.tournament_name.is_empty(),
                template
                    .hand
                    .tournament
                    .as_ref()
                    .and_then(|t| t.name.as_ref()),
            ) {
                table.tournament_name = name.clone();
            }
            if table.tournament_name.is_empty() {
                table.tournament_name = "Tournament".to_owned();
            }
            table.title = fill(&naming.title, &self.fields(table, &template));
        }
        table.version += 1;
    }

    fn table_event(table: &Table, moved: bool) -> Event {
        Event::Table {
            table: table.id,
            title: table.title.clone(),
            table_name: table.name.clone(),
            size: table.size,
            game: table.group.game.clone(),
            hero_seat: table.hero_seat,
            moved,
        }
    }

    /// Open a table of `size` (or the next of `--sizes`); its id.
    pub fn open_table(&mut self, size: Option<u32>) -> Result<u32, String> {
        let size = match size {
            Some(size) => size,
            None => {
                let count = self.config.sizes.len().max(1);
                let index = usize::try_from(self.next_table - 1).unwrap_or(0) % count;
                self.config.sizes.get(index).copied().unwrap_or(6)
            }
        };
        let group = self
            .group_for(size)
            .ok_or_else(|| format!("no {size}-max hands for this room"))?;
        let count = self.templates_of(&group).len();
        let first = self.rng.index(count);
        let tournament_id = self.config.tournament.then(|| {
            let id = self.rng.between(10_000_000, 99_999_999);
            id.to_string()
        });
        let id = self.next_table;
        self.next_table += 1;
        let interval = self.interval();
        let mut table = Table {
            id,
            size,
            group,
            name: String::new(),
            title: String::new(),
            tournament_id,
            table_number: u32::try_from(self.rng.between(1, 40)).unwrap_or(1),
            tournament_name: String::new(),
            game_id: self.rng.between(1_000_000, 9_999_999).to_string(),
            hero_seat: 1,
            roster: Vec::new(),
            hands: 0,
            due: Instant::now() + interval / 2,
            shown: None,
            file: None,
            version: 0,
            stakes: first,
            first: Some(first),
        };
        self.seat_table(&mut table);
        self.events.push(Self::table_event(&table, false));
        self.tables.push(table);
        Ok(id)
    }

    fn index_of(&self, id: u32) -> Result<usize, String> {
        self.tables
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| format!("no table {id}"))
    }

    /// Write every hand that is due.
    pub fn tick(&mut self, now: Instant) {
        if self.paused() {
            return;
        }
        for index in 0..self.tables.len() {
            if self.done() {
                break;
            }
            if self.tables[index].due <= now {
                if let Err(message) = self.write_hand(index) {
                    self.events.push(Event::Error { message });
                }
                let interval = self.interval();
                self.tables[index].due = now + interval;
            }
        }
        if self.done() && !self.done_reported {
            self.done_reported = true;
            self.events.push(Event::Done {
                hands: self.written,
            });
        }
    }

    /// Indices of the templates a table of `stakes` plays: the same blinds
    /// and currency when there are three or more, else the same currency.
    fn like_stakes(templates: &[Template], stakes: usize) -> Vec<usize> {
        let Some(base) = templates.get(stakes).map(|t| &t.hand.game) else {
            return (0..templates.len()).collect();
        };
        let same = |strict: bool| -> Vec<usize> {
            templates
                .iter()
                .enumerate()
                .filter(|(_, t)| {
                    let g = &t.hand.game;
                    g.unit.code == base.unit.code
                        && (!strict
                            || (g.small_blind == base.small_blind && g.big_blind == base.big_blind))
                })
                .map(|(i, _)| i)
                .collect()
        };
        let strict = same(true);
        if strict.len() >= 3 {
            strict
        } else {
            same(false)
        }
    }

    fn write_hand(&mut self, index: usize) -> Result<(), String> {
        let mut table = self.tables[index].clone();
        let templates = self.templates_of(&table.group).to_vec();
        if templates.is_empty() {
            return Err(format!("table {}: no hands", table.id));
        }
        let mut last_error = String::new();
        for _ in 0..8 {
            let pick = match table.first.take() {
                Some(first) => first,
                None => {
                    let candidates = Self::like_stakes(&templates, table.stakes);
                    candidates[self.rng.index(candidates.len())]
                }
            };
            let template = &templates[pick];
            let stakes_template = templates.get(table.stakes).unwrap_or(template);
            let played_at = unix_ms() / 1000;
            let text_id = text_hand_id(&template.hand, &template.text).unwrap_or("");
            let hand_id = if text_id.contains('-') {
                format!("{}-{}-{played_at}", table.game_id, table.hands + 1)
            } else {
                let id = self.next_hand;
                self.next_hand += 1;
                id.to_string()
            };
            let target = Target {
                hand_id: &hand_id,
                table_name: &table.name,
                played_at,
                tournament_id: table.tournament_id.as_deref(),
                hero_seat: table.hero_seat,
                roster: &table.roster,
                hero_name: &self.config.hero,
                hero_pick: u32::try_from(self.rng.below(1 << 16)).unwrap_or(0),
            };
            let rewritten = match rewrite(
                &template.text,
                &template.hand,
                &self.config.room.parser,
                Some(&self.config.room.dealt),
                &target,
            ) {
                Ok(r) => r,
                Err(e) => {
                    last_error = format!("{}: {e}", template.source.display());
                    continue;
                }
            };
            let mut fields = self.fields(&table, stakes_template);
            fields.set("date", Civil::from_unix(played_at).compact_date());
            let naming = self.naming();
            let file_name = file_safe(&fill(&naming.file, &fields));
            let path = self.config.out.join(file_name);
            let bytes = output::append(
                &path,
                &rewritten.text,
                self.config.room.separator,
                self.config.line_end,
                self.config.encoding,
            )?;
            let hand = &rewritten.hand;
            let unit = &hand.game.unit;
            let board = hand
                .board
                .runouts
                .first()
                .map(|r| {
                    let mut cards = r.flop.clone().unwrap_or_default();
                    cards.extend(r.turn.clone());
                    cards.extend(r.river.clone());
                    cards
                })
                .unwrap_or_default();
            table.shown = Some(Shown {
                hand_id: hand.meta.hand_id.clone(),
                stakes: format!(
                    "{}/{}",
                    money(hand.game.small_blind, unit),
                    money(hand.game.big_blind, unit)
                ),
                seats: hand
                    .players
                    .iter()
                    .map(|p| SeatView {
                        seat: p.seat,
                        name: p.name.clone(),
                        stack: money(p.starting_stack, unit),
                        hero: p.is_hero,
                        cards: p.hole_cards.clone(),
                        sitting_out: p.sitting_out,
                    })
                    .collect(),
                button: hand.table.button_seat,
                board,
            });
            table.hands += 1;
            table.version += 1;
            table.file = Some(path.clone());
            self.written += 1;
            self.events.push(Event::Hand {
                table: table.id,
                hand_id: hand.meta.hand_id.clone(),
                hand_key: hand_key(hand),
                site: hand.meta.site_id.clone(),
                table_name: table.name.clone(),
                file: path.display().to_string(),
                players: hand.players.iter().map(|p| p.name.clone()).collect(),
                bytes,
                at_ms: unix_ms(),
                template: template.source.display().to_string(),
            });
            self.tables[index] = table;
            return Ok(());
        }
        self.tables[index] = table;
        Err(format!(
            "table {}: no hand could be written ({last_error})",
            self.tables[index].id
        ))
    }

    /// Carry out a command (window commands are the front end's; here they
    /// do nothing).
    pub fn apply(&mut self, command: &Command) -> Result<(), String> {
        let now = Instant::now();
        match command {
            Command::Pause => {
                if self.paused_at.is_none() {
                    self.paused_at = Some(now);
                    self.events.push(Event::Paused { paused: true });
                }
            }
            Command::Resume => {
                if let Some(at) = self.paused_at.take() {
                    let paused = now.saturating_duration_since(at);
                    for table in &mut self.tables {
                        table.due += paused;
                        table.version += 1;
                    }
                    self.events.push(Event::Paused { paused: false });
                }
            }
            Command::TogglePause => {
                let next = if self.paused() {
                    Command::Resume
                } else {
                    Command::Pause
                };
                return self.apply(&next);
            }
            Command::Speed(centi) => {
                self.config.speed = (*centi).max(1);
                for index in 0..self.tables.len() {
                    let interval = self.interval();
                    self.tables[index].due = now + interval;
                    self.tables[index].version += 1;
                }
                self.events.push(Event::Speed {
                    hands_per_minute: speed_text(self.config.speed),
                });
            }
            Command::Faster => {
                return self.apply(&Command::Speed(self.config.speed.saturating_mul(2)));
            }
            Command::Slower => {
                return self.apply(&Command::Speed((self.config.speed / 2).max(1)));
            }
            Command::Open(size) => {
                self.open_table(*size)?;
            }
            Command::Close(id) => {
                let index = self.index_of(*id)?;
                self.tables.remove(index);
                self.events.push(Event::Closed { table: *id });
            }
            Command::Hand(id) => {
                let index = self.index_of(*id)?;
                self.tables[index].due = now;
            }
            Command::TableMove(id) => {
                let index = self.index_of(*id)?;
                let mut table = self.tables[index].clone();
                let old = table.table_number;
                while table.table_number == old {
                    table.table_number = u32::try_from(self.rng.between(1, 60)).unwrap_or(1);
                }
                // The old name stays taken while the new one is picked: a
                // move is to another table (a cash table could otherwise
                // draw its own name again).
                let old_name = table.name.clone();
                let count = self.templates_of(&table.group).len();
                table.stakes = self.rng.index(count);
                table.first = Some(table.stakes);
                self.seat_table(&mut table);
                if table.name != old_name {
                    self.used_table_names.remove(&old_name);
                }
                table.shown = None;
                self.events.push(Self::table_event(&table, true));
                self.tables[index] = table;
            }
            Command::Status => {
                let tables = self
                    .tables
                    .iter()
                    .map(|t| TableStatus {
                        table: t.id,
                        title: t.title.clone(),
                        table_name: t.name.clone(),
                        size: t.size,
                        hands: t.hands,
                        file: t.file.as_ref().map(|f| f.display().to_string()),
                    })
                    .collect();
                self.events.push(Event::Status {
                    paused: self.paused(),
                    hands: self.written,
                    tables,
                });
            }
            Command::Quit => self.quit = true,
            Command::Wait(_)
            | Command::Move(..)
            | Command::Resize(..)
            | Command::Minimize(_)
            | Command::Restore(_)
            | Command::Focus(_)
            | Command::Tile => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(room: &str, out: PathBuf) -> Config {
        let room = crate::room::room(room).expect("room");
        Config {
            encoding: room.encoding,
            line_end: room.line_end,
            room,
            corpus: crate::corpus::default_root(),
            out,
            tables: 2,
            sizes: Vec::new(),
            tournament: false,
            game: None,
            speed: 6000,
            jitter: 30,
            hands: Some(6),
            hero: "SimHero".into(),
            seed: 3,
        }
    }

    #[test]
    fn money_forms() {
        let usd = CurrencyUnit {
            code: "USD".into(),
            symbol: "$".into(),
            minor_units: 100,
            kind: rail_core::phf::CurrencyKind::Cash,
        };
        assert_eq!(money(5, &usd), "$0.05");
        assert_eq!(money(200, &usd), "$2");
        assert_eq!(money(250, &usd), "$2.50");
        assert_eq!(speed_text(250), "2.5");
        assert_eq!(speed_text(75), "0.75");
        assert_eq!(speed_text(300), "3");
        assert_eq!(default_game_name("omaha8-pl"), "Pot Limit Omaha Hi/Lo");
    }

    #[test]
    fn titles_read_back_to_the_hands_table() {
        for room in ["pokerstars", "winamax", "acr"] {
            for tournament in [false, true] {
                let out = output::temp_out();
                let mut cfg = config(room, out.clone());
                cfg.tournament = tournament;
                let mut sim = match Sim::new(cfg) {
                    Ok(sim) => sim,
                    Err(e) => {
                        assert!(tournament && room == "winamax", "{room}: {e}");
                        continue;
                    }
                };
                let naming = sim.naming();
                let ids: Vec<u32> = sim.tables().iter().map(|t| t.id).collect();
                for id in &ids {
                    sim.apply(&Command::Hand(*id)).expect("hand");
                }
                sim.tick(Instant::now());
                let before = sim.table(ids[0]).expect("table").name.clone();
                sim.apply(&Command::TableMove(ids[0])).expect("move");
                assert_ne!(
                    sim.table(ids[0]).expect("table").name,
                    before,
                    "{room}: a move is to another table"
                );
                sim.apply(&Command::Hand(ids[0])).expect("hand");
                sim.tick(Instant::now());
                for table in sim.tables() {
                    let from_title = crate::room::table_from_title(&naming, &table.title);
                    assert_eq!(from_title.as_deref(), Some(table.name.as_str()), "{room}");
                }
                let hands: Vec<_> = sim
                    .take_events()
                    .into_iter()
                    .filter_map(|e| match e {
                        Event::Hand {
                            table_name, table, ..
                        } => Some((table, table_name)),
                        Event::Error { message } => panic!("{room}: {message}"),
                        _ => None,
                    })
                    .collect();
                assert_eq!(hands.len(), ids.len() + 1, "{room}");
                let moved = sim.table(ids[0]).expect("table");
                assert_eq!(hands.last(), Some(&(ids[0], moved.name.clone())));
                let _ = std::fs::remove_dir_all(out);
            }
        }
    }
}

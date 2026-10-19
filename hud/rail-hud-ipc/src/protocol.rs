//! The messages (docs/RAIL-PLAN.md §3.2), one JSON object each with its kind
//! in `type` (`snake_case`). Fields are camelCase.
//!
//! Compatibility: a field a reader does not know is ignored, a message type
//! it does not know reads as `Unknown` (and is dropped), so adding either is
//! not a protocol change. Removing or retyping a field is: bump
//! [`crate::PROTOCOL_VERSION`].

use serde::{Deserialize, Serialize};

/// A player as the store keys their rollups (`player_rollups`): the name as
/// the room wrote it and the scope - `""`, or for an opaque-id room's
/// villain the session (`<table>@<day>`, rail-store SCHEMA.md "Under which
/// identity a row is summed").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRef {
    pub name: String,
    #[serde(default)]
    pub scope: String,
    /// The hand's seat number (R3.4): where the HUD draws the player's
    /// panel. Absent from an older app (the panel is then not placed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat: Option<u32>,
    /// The user's own seat (R3.6 rotates the layout around it).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hero: bool,
    /// (R3.9) The player's starting stack in this (finished) hand, tenths
    /// of a big blind: a design's cell shown at some stack depths only
    /// reads it. Absent from an older app, or when the hand has no big
    /// blind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_bb_tenths: Option<i64>,
}

impl PlayerRef {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            scope: String::new(),
            seat: None,
            hero: false,
            stack_bb_tenths: None,
        }
    }

    /// A player at a seat.
    #[must_use]
    pub fn at(mut self, seat: u32) -> Self {
        self.seat = Some(seat);
        self
    }
}

/// App -> HUD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppMessage {
    /// A hand was stored, with its seat rows and rollups (one transaction):
    /// the HUD re-reads the rollups of `players` for the table it was played
    /// at. `site` is the rollups' site (`segments.site`), `table` the hand's
    /// table name (`None` when the room writes none).
    #[serde(rename_all = "camelCase")]
    HandImported {
        site: String,
        table: Option<String>,
        hand_key: String,
        players: Vec<PlayerRef>,
        /// (R3.7) When the hand went through the app: the start of the
        /// latency chain the HUD completes. Absent from an older app.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timing: Option<HandTiming>,
    },
    /// A recompute swapped new statistics in (R2.11, `kv` `stats.epoch`):
    /// every number shown is re-read.
    #[serde(rename_all = "camelCase")]
    StatsChanged { epoch: i64 },
    /// The user changed a HUD layout in the app (R3.6, R3.9): read it again.
    LayoutChanged,
    /// The user changed a HUD setting in the app (R3.9): read them again.
    SettingsChanged,
    /// The remote `sites.json` the app downloaded (R0.12), or `None` for
    /// the shipped copy only. The HUD merges it over its own shipped copy
    /// with `rail_config::load_remote`: it can only make a room's HUD policy
    /// stricter, never looser.
    #[serde(rename_all = "camelCase")]
    Policy { remote: Option<String> },
    /// Messages were dropped on the way (the app's queue to the HUD was
    /// full): re-read everything shown.
    Resync,
    /// Are you alive? Answered with [`HudMessage::Health`] and the same
    /// `seq`.
    #[serde(rename_all = "camelCase")]
    Health { seq: u64 },
    /// The app is quitting: remove the overlays and exit.
    Shutdown,
    /// A message type this build does not know (a newer app).
    #[serde(other)]
    Unknown,
}

/// HUD -> app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HudMessage {
    /// The answer to [`AppMessage::Health`].
    #[serde(rename_all = "camelCase")]
    Health { seq: u64, report: HealthReport },
    /// How many poker tables the HUD is attached to, sent whenever it
    /// changes: while any is open the app pauses its heavy background work
    /// (`StatsWorker::set_tables_open`, R2.3) and lowers sync's bandwidth
    /// (`SyncWorker::set_tables_open`, R1.9).
    #[serde(rename_all = "camelCase")]
    TablesOpen { count: u32 },
    /// The user asked to see a player in the app (a click in a popup, R3.8).
    #[serde(rename_all = "camelCase")]
    OpenInApp { site: String, player: PlayerRef },
    /// Compliance mode (guideline §7, R3.10): a window looked like a table,
    /// but its room's HUD policy is not `allowed: true`, so the HUD did not
    /// attach. Sent once per window; the app says why.
    #[serde(rename_all = "camelCase")]
    AttachRefused {
        /// The `sites.json` id the window matched.
        site: String,
        window: u64,
        reason: RefusalReason,
    },
    /// A table's numbers were re-read and its overlay redrawn: the latency
    /// instrument (§3.3) and, in debug builds, what the app shows (R3.7).
    #[serde(rename_all = "camelCase")]
    TableUpdated {
        window: u64,
        site: String,
        table: Option<String>,
        /// The hand that caused it; `None` for a re-read after
        /// `stats_changed`, `resync` or the HUD's own store check.
        hand_key: Option<String>,
        /// Each seat's player and the hands their rollups count.
        players: Vec<PlayerHands>,
        /// From the message's arrival to the rollups re-read, microseconds.
        reread_us: u64,
        /// (R3.7) The whole chain for the hand, from the watcher noticing
        /// its file to the frame handed to the overlay; absent for a re-read
        /// no hand caused, or from an older HUD.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chain: Option<LatencyChain>,
    },
    /// The user dragged a seat's panel (R3.6): the app remembers it in the
    /// store (`hud_seat_positions`; the HUD's own connection is read-only)
    /// for the room, the table size and the visual seat, and the HUD reads
    /// it back at its next start. The HUD already shows it there.
    #[serde(rename_all = "camelCase")]
    SeatPositionChanged {
        /// The `sites.json` room (`acr`, not the store's `acrwpn`).
        site: String,
        /// The table size, 2 - 10.
        size: u32,
        /// The visual seat: an index into the room's seat layout for the
        /// size (with a rotating client, where the hero is drawn is one
        /// slot whatever seat they took) - not a hand history's seat.
        slot: u32,
        /// The panel's centre, thousandths of the table's client area.
        x: u32,
        y: u32,
    },
    /// (R3.8) The user clicked a seat's panel (a press and release that
    /// never became a drag): the app opens its popup for that player next
    /// to the panel - one popup window, reused while it is open; the same
    /// panel clicked again closes it. The app reads what the popup shows
    /// itself (the HUD's connection is read-only and the popup edits the
    /// player's note), over the same rows the panel shows: the table's
    /// `segment`, the user's own hands only where the room says so.
    #[serde(rename_all = "camelCase")]
    OpenPopup {
        /// The table window (`HWND`, the simulator's table number).
        window: u64,
        /// The `sites.json` room (`acr`): its HUD rules decide what the
        /// popup may show.
        site: String,
        /// The rollups' site (`acrwpn`): where the player's rows are.
        store_site: String,
        /// The table name from the window's title.
        table: Option<String>,
        /// The player as the table's last hand had them (scope, seat, hero).
        player: PlayerRef,
        /// The table's segment (R3.7); `None`: every segment of the site.
        segment: Option<i64>,
        /// The panel's visual seat (R3.6): its identity on the screen.
        slot: u32,
        /// The panel on the screen, physical pixels: the popup goes beside
        /// it.
        anchor: ScreenRect,
        /// The table's monitor scale, thousandths (1000 = 96 dpi).
        scale_permille: u32,
        /// (R3.9) The design the table is drawn with (a preset's id or a
        /// user's): the popup shows its sections. Absent from an older HUD.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        design: Option<String>,
    },
    /// A message type this build does not know (a newer HUD).
    #[serde(other)]
    Unknown,
}

/// (R3.8) A rectangle on the screen, physical pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Why compliance mode refused a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefusalReason {
    /// The room's policy says no (`hud.allowed: false`).
    Prohibited,
    /// The room's policy is not known (`hud.allowed: null`): unknown is no.
    Unknown,
    /// The entry is a network or a format, not a room.
    NotARoom,
    /// No `sites.json` entry has this id.
    UnknownSite,
}

/// (R3.7) A hand's way through the app, Unix microseconds (one clock: both
/// processes run on the user's machine).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandTiming {
    /// The watcher noticed the file change whose commit stored the hand
    /// (`rail_watch::WatchEvent::Imported`'s `noticed_ms`); `None` when it
    /// does not know (a later batch of one read).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noticed_us: Option<i64>,
    /// The watcher reported the commit (the hand is in the store).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_us: Option<i64>,
    /// The app queued `hand_imported` for the HUD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_us: Option<i64>,
}

/// (R3.7) A hand's latency chain, from the file to the overlay, Unix
/// microseconds: the app's [`HandTiming`] and the HUD's own stamps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyChain {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noticed_us: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_us: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_us: Option<i64>,
    /// The HUD read `hand_imported` off the channel.
    pub arrived_us: i64,
    /// The table's players' rollups were re-read.
    pub read_us: i64,
    /// The frame was handed to the platform backend: drawn on the
    /// simulator's backend; on Windows queued to the overlay thread, whose
    /// paint follows (R3.4: p50 2.1 ms).
    pub painted_us: i64,
}

impl LatencyChain {
    /// From the watcher noticing the file to the frame, microseconds
    /// (`None` without the watcher's stamp).
    pub fn total_us(&self) -> Option<i64> {
        self.noticed_us.map(|noticed| self.painted_us - noticed)
    }
}

/// A player's hand count as the HUD read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerHands {
    pub name: String,
    pub hands: i64,
}

/// The HUD's state, in each health answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub uptime_ms: u64,
    /// Tables the HUD is attached to.
    pub attached: u32,
    /// Windows compliance mode refused.
    pub refused: u32,
    /// The store is open (read-only).
    pub store_open: bool,
    /// The platform backend in use (`windows`, `macos`, `sim`, `none`).
    pub platform: String,
    /// `hand_imported` -> rollups re-read, over the last re-reads.
    pub reread: LatencySummary,
    /// Attached tables still "waiting for first hand" (R3.3): no hand of
    /// their table yet, or their name shared with another window. Absent
    /// from an older HUD: 0.
    #[serde(default)]
    pub waiting: u32,
}

/// Latencies in microseconds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySummary {
    pub count: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub max_us: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let text = serde_json::to_string(value).expect("serialise");
        serde_json::from_str(&text).expect("deserialise")
    }

    /// Every message of both directions reads back as itself.
    #[test]
    fn every_message_round_trips() {
        let app = [
            AppMessage::HandImported {
                site: "pokerstars".into(),
                table: Some("Hygiea IV 40-100 bb".into()),
                hand_key: "pokerstars:123".into(),
                players: vec![
                    PlayerRef {
                        hero: true,
                        ..PlayerRef::named("SimHero").at(1)
                    },
                    PlayerRef {
                        name: "a1b2".into(),
                        scope: "Table 9@2026-10-15".into(),
                        seat: Some(9),
                        hero: false,
                        stack_bb_tenths: Some(425),
                    },
                ],
                timing: Some(HandTiming {
                    noticed_us: Some(1_000),
                    imported_us: Some(501_000),
                    sent_us: Some(502_000),
                }),
            },
            AppMessage::HandImported {
                site: "winamax".into(),
                table: None,
                hand_key: "winamax:1-2-3".into(),
                players: vec![],
                timing: None,
            },
            AppMessage::StatsChanged { epoch: 7 },
            AppMessage::LayoutChanged,
            AppMessage::SettingsChanged,
            AppMessage::Policy {
                remote: Some("{}".into()),
            },
            AppMessage::Policy { remote: None },
            AppMessage::Resync,
            AppMessage::Health { seq: u64::MAX },
            AppMessage::Shutdown,
        ];
        for message in &app {
            assert_eq!(&round_trip(message), message);
        }
        let hud = [
            HudMessage::Health {
                seq: 3,
                report: HealthReport {
                    uptime_ms: 10,
                    attached: 2,
                    refused: 1,
                    store_open: true,
                    platform: "sim".into(),
                    reread: LatencySummary {
                        count: 4,
                        p50_us: 300,
                        p95_us: 900,
                        max_us: 1000,
                    },
                    waiting: 1,
                },
            },
            HudMessage::TablesOpen { count: 12 },
            HudMessage::OpenInApp {
                site: "acr".into(),
                player: PlayerRef::named("Villain"),
            },
            HudMessage::AttachRefused {
                site: "ggpoker".into(),
                window: 4,
                reason: RefusalReason::Prohibited,
            },
            HudMessage::TableUpdated {
                window: 1,
                site: "pokerstars".into(),
                table: Some("T".into()),
                hand_key: None,
                players: vec![PlayerHands {
                    name: "SimHero".into(),
                    hands: 20,
                }],
                reread_us: 250,
                chain: None,
            },
            HudMessage::TableUpdated {
                window: 1,
                site: "pokerstars".into(),
                table: Some("T".into()),
                hand_key: Some("pokerstars:1".into()),
                players: vec![],
                reread_us: 250,
                chain: Some(LatencyChain {
                    noticed_us: Some(1_000),
                    imported_us: Some(501_000),
                    sent_us: None,
                    arrived_us: 502_500,
                    read_us: 502_800,
                    painted_us: 502_900,
                }),
            },
            HudMessage::SeatPositionChanged {
                site: "acr".into(),
                size: 6,
                slot: 5,
                x: 1000,
                y: 0,
            },
            HudMessage::OpenPopup {
                window: 0x1234,
                site: "acr".into(),
                store_site: "acrwpn".into(),
                table: Some("Miramar".into()),
                player: PlayerRef::named("Villain").at(4),
                segment: Some(7),
                slot: 3,
                anchor: ScreenRect {
                    x: -1200,
                    y: 40,
                    width: 96,
                    height: 44,
                },
                scale_permille: 1500,
                design: Some("d-0123".into()),
            },
            HudMessage::OpenPopup {
                window: 1,
                site: "pokerstars".into(),
                store_site: "pokerstars".into(),
                table: None,
                player: PlayerRef {
                    hero: true,
                    ..PlayerRef::named("SimHero").at(1)
                },
                segment: None,
                slot: 0,
                anchor: ScreenRect::default(),
                scale_permille: 1000,
                design: None,
            },
        ];
        for message in &hud {
            assert_eq!(&round_trip(message), message);
        }
    }

    /// The wire form is the plan's: `type` in snake case, fields in camel
    /// case.
    #[test]
    fn wire_form() {
        let text = serde_json::to_string(&AppMessage::HandImported {
            site: "acr".into(),
            table: Some("Miramar (Cap)".into()),
            hand_key: "acr:9".into(),
            players: vec![
                PlayerRef::named("P"),
                PlayerRef {
                    hero: true,
                    ..PlayerRef::named("H").at(3)
                },
            ],
            timing: None,
        })
        .expect("json");
        assert_eq!(
            text,
            r#"{"type":"hand_imported","site":"acr","table":"Miramar (Cap)","handKey":"acr:9","players":[{"name":"P","scope":""},{"name":"H","scope":"","seat":3,"hero":true}]}"#
        );
        // (R3.7) The timing, when the app has it; an older HUD ignores it.
        let text = serde_json::to_string(&AppMessage::HandImported {
            site: "acr".into(),
            table: None,
            hand_key: "acr:9".into(),
            players: vec![],
            timing: Some(HandTiming {
                noticed_us: Some(1),
                imported_us: Some(2),
                sent_us: Some(3),
            }),
        })
        .expect("json");
        assert_eq!(
            text,
            r#"{"type":"hand_imported","site":"acr","table":null,"handKey":"acr:9","players":[],"timing":{"noticedUs":1,"importedUs":2,"sentUs":3}}"#
        );
        let chain = LatencyChain {
            noticed_us: Some(100),
            imported_us: None,
            sent_us: None,
            arrived_us: 500,
            read_us: 600,
            painted_us: 700,
        };
        assert_eq!(chain.total_us(), Some(600));
        assert_eq!(
            LatencyChain {
                noticed_us: None,
                ..chain
            }
            .total_us(),
            None
        );
        assert_eq!(
            serde_json::to_string(&HudMessage::TablesOpen { count: 2 }).expect("json"),
            r#"{"type":"tables_open","count":2}"#
        );
        assert_eq!(
            serde_json::to_string(&AppMessage::Resync).expect("json"),
            r#"{"type":"resync"}"#
        );
        assert_eq!(
            serde_json::to_string(&HudMessage::SeatPositionChanged {
                site: "pokerstars".into(),
                size: 9,
                slot: 0,
                x: 512,
                y: 873,
            })
            .expect("json"),
            r#"{"type":"seat_position_changed","site":"pokerstars","size":9,"slot":0,"x":512,"y":873}"#
        );
        // (R3.8) A click on a panel.
        assert_eq!(
            serde_json::to_string(&HudMessage::OpenPopup {
                window: 9,
                site: "acr".into(),
                store_site: "acrwpn".into(),
                table: Some("T".into()),
                player: PlayerRef::named("V").at(2),
                segment: Some(3),
                slot: 1,
                anchor: ScreenRect {
                    x: 10,
                    y: -5,
                    width: 80,
                    height: 40,
                },
                scale_permille: 1250,
                design: Some("cash".into()),
            })
            .expect("json"),
            r#"{"type":"open_popup","window":9,"site":"acr","storeSite":"acrwpn","table":"T","player":{"name":"V","scope":"","seat":2},"segment":3,"slot":1,"anchor":{"x":10,"y":-5,"width":80,"height":40},"scalePermille":1250,"design":"cash"}"#
        );
    }

    /// A newer peer's message type, or a newer field, does not break this
    /// build.
    #[test]
    fn newer_peers_are_tolerated() {
        let unknown: AppMessage =
            serde_json::from_str(r#"{"type":"something_new","x":1}"#).expect("unknown type");
        assert_eq!(unknown, AppMessage::Unknown);
        let unknown: HudMessage =
            serde_json::from_str(r#"{"type":"something_new"}"#).expect("unknown type");
        assert_eq!(unknown, HudMessage::Unknown);
        let extra: AppMessage =
            serde_json::from_str(r#"{"type":"stats_changed","epoch":2,"since":"x"}"#)
                .expect("extra field");
        assert_eq!(extra, AppMessage::StatsChanged { epoch: 2 });
        let extra: AppMessage =
            serde_json::from_str(r#"{"type":"layout_changed","layout":"6max"}"#)
                .expect("extra field on a unit message");
        assert_eq!(extra, AppMessage::LayoutChanged);
        let no_scope: PlayerRef = serde_json::from_str(r#"{"name":"P"}"#).expect("no scope");
        assert_eq!(no_scope, PlayerRef::named("P"));
        // An app from before R3.4 sends no seat: the panel is not placed.
        let no_seat: PlayerRef =
            serde_json::from_str(r#"{"name":"P","scope":"s"}"#).expect("no seat");
        assert_eq!((no_seat.seat, no_seat.hero), (None, false));
        // A HUD from before R3.3 sends no `waiting`.
        let older: HealthReport = serde_json::from_str(
            r#"{"uptimeMs":1,"attached":2,"refused":0,"storeOpen":true,"platform":"sim",
                "reread":{"count":0,"p50Us":0,"p95Us":0,"maxUs":0}}"#,
        )
        .expect("an older report");
        assert_eq!((older.attached, older.waiting), (2, 0));
    }
}

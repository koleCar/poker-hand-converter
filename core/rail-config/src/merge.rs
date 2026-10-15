//! The policy merge rule (docs/RAIL-PLAN.md §3.6): the app ships a copy of
//! `sites.json` and fetches updates; a downloaded file may correct paths,
//! files and table data, but may only make HUD policy **stricter** than the
//! shipped copy, never looser, until a new signed release says otherwise.
//!
//! Decisions, each tested below:
//!
//! - Order of looseness: `false` (prohibited) < `null` (unknown) < `true`
//!   (allowed). A remote entry may move down or stay; a move up is ignored
//!   and the shipped `hud` block kept. At equal level the remote block wins
//!   (a re-check may refresh the source, date and notes) - except that two
//!   allowed blocks keep **both** blocks' restrictions (R3.4,
//!   `HudRestrictions::stricter`): a download can add a restriction, never
//!   drop one ([`MergeNote::LooserRestrictionsIgnored`]).
//! - **Unknown ids are ignored**, not added: an entry id is a key the app
//!   stores (a folder's site, a layout's room), identity and parser come with
//!   a release, and a remote-only entry would vanish again with the next
//!   download. Reported as [`MergeNote::UnknownSiteIgnored`].
//! - An entry the remote file lacks keeps its shipped form: a download cannot
//!   delete a site.
//! - Identity is release-bound: when a remote entry's `kind`, `parser` or
//!   `anonymisation` differs from the shipped one, the whole remote entry is
//!   ignored (mixing would pair e.g. a room's table data with a network).
//!   `anonymisation` decides which names the database keeps
//!   (docs/DATABASE.md), so a download must not loosen it either.
//! - **Table data that bears on compliance is stricter-only too** (R3.6,
//!   [`merge_tables`]); the rest of `tables` (title regex, seat anchors,
//!   plate size, hero slot, seat numbering, preferred seat, verification
//!   notes) is a correction the remote file may make:
//!   - **Table graphics only grow.** For every table size the shipped file
//!     has a `seatLayouts` entry for, the merged layout keeps every shipped
//!     `graphics` zone and adds the remote's (their union, shipped first);
//!     a remote file that drops a size, or the whole `seatLayouts`, keeps
//!     the shipped layout of that size. A zone is what a panel must not
//!     cover where the room forbids covering its graphics (ACR,
//!     `noOverlapTableGraphics`): shrinking or dropping one would let the
//!     HUD draw where the room's policy says it may not
//!     ([`MergeNote::TableGraphicsKept`]). A size only the remote file
//!     has is taken as it is (new measured data; the HUD's default for an
//!     unmeasured size is not a room's own graphics).
//!   - **Processes never reach another room's windows.** The process names
//!     decide whose windows a room's matcher may take, and compliance mode
//!     decides on the room the matcher belongs to. Where the shipped file
//!     names a room's processes (per OS), the remote's may only be a subset
//!     of them; where it names none, the remote's may not name a process
//!     the shipped file gives to another entry
//!     ([`MergeNote::LooserProcessesIgnored`]). A title regex can then only
//!     choose among that room's own windows, so it may be corrected.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::model::{Config, Hud, Processes, Site, Tables};

/// How much a HUD policy permits, least first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HudLevel {
    Prohibited,
    Unknown,
    Allowed,
}

impl HudLevel {
    pub fn of(hud: &Hud) -> Self {
        match hud.allowed {
            Some(false) => Self::Prohibited,
            None => Self::Unknown,
            Some(true) => Self::Allowed,
        }
    }
}

/// The merged configuration and what was not taken from the remote file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub config: Config,
    pub notes: Vec<MergeNote>,
}

/// Something in the remote file the merge did not take, or did not find.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeNote {
    /// The remote file has an id the shipped one does not.
    UnknownSiteIgnored { id: String },
    /// The remote entry would loosen the HUD policy; the shipped one stays.
    LooserHudIgnored {
        id: String,
        shipped: Option<bool>,
        remote: Option<bool>,
    },
    /// The remote entry changes `kind`, `parser` or `anonymisation`; the
    /// shipped entry stays whole.
    IdentityChangeIgnored { id: String, field: &'static str },
    /// The remote file has no entry for this shipped id; it stays as shipped.
    MissingFromRemote { id: String },
    /// The remote entry drops or eases a HUD restriction of the shipped
    /// one; the merged entry keeps every restriction of both.
    LooserRestrictionsIgnored { id: String },
    /// The remote entry drops or shrinks a shipped table-graphics zone (or
    /// the whole layout of a size): the shipped zones stay (R3.6).
    TableGraphicsKept { id: String, size: String },
    /// The remote entry's table processes reach past the shipped ones (or
    /// name another entry's): those names are left out (R3.6).
    LooserProcessesIgnored { id: String },
}

/// `shipped` with `remote`'s corrections applied under the rule above. Both
/// are expected to have passed [`crate::validate`]; the result then does too.
/// Order, `version` and `$schema` are the shipped file's.
pub fn merge_remote(shipped: &Config, remote: &Config) -> Merged {
    let mut notes = Vec::new();
    let sites = shipped
        .sites
        .iter()
        .map(|ours| match remote.site(&ours.id) {
            None => {
                notes.push(MergeNote::MissingFromRemote {
                    id: ours.id.clone(),
                });
                ours.clone()
            }
            Some(theirs) => merge_site(shipped, ours, theirs, &mut notes),
        })
        .collect();
    for theirs in &remote.sites {
        if shipped.site(&theirs.id).is_none() {
            notes.push(MergeNote::UnknownSiteIgnored {
                id: theirs.id.clone(),
            });
        }
    }
    Merged {
        config: Config {
            schema: shipped.schema.clone(),
            version: shipped.version,
            sites,
        },
        notes,
    }
}

fn merge_site(shipped: &Config, ours: &Site, theirs: &Site, notes: &mut Vec<MergeNote>) -> Site {
    let identity = [
        ("kind", ours.kind == theirs.kind),
        ("parser", ours.parser == theirs.parser),
        ("anonymisation", ours.anonymisation == theirs.anonymisation),
    ];
    if let Some(&(field, _)) = identity.iter().find(|(_, same)| !same) {
        notes.push(MergeNote::IdentityChangeIgnored {
            id: ours.id.clone(),
            field,
        });
        return ours.clone();
    }
    let mut merged = theirs.clone();
    match HudLevel::of(&theirs.hud).cmp(&HudLevel::of(&ours.hud)) {
        Ordering::Greater => {
            notes.push(MergeNote::LooserHudIgnored {
                id: ours.id.clone(),
                shipped: ours.hud.allowed,
                remote: theirs.hud.allowed,
            });
            merged.hud = ours.hud.clone();
        }
        Ordering::Equal => {
            if let (Some(shipped), Some(remote)) =
                (&ours.hud.restrictions, &theirs.hud.restrictions)
                && !remote.at_least_as_strict_as(shipped)
            {
                notes.push(MergeNote::LooserRestrictionsIgnored {
                    id: ours.id.clone(),
                });
                merged.hud.restrictions = Some(remote.stricter(shipped));
            }
        }
        Ordering::Less => {}
    }
    merged.tables = merge_tables(shipped, ours, theirs, notes);
    merged
}

/// A room's `tables` block under the stricter-only rule for what bears on
/// compliance (see the module's header): table graphics only grow, and the
/// process names never reach past the shipped ones or into another entry's.
/// Everything else is the remote's.
pub fn merge_tables(
    shipped: &Config,
    ours: &Site,
    theirs: &Site,
    notes: &mut Vec<MergeNote>,
) -> Tables {
    let mut merged = theirs.tables.clone();

    // Graphics: every shipped zone stays, per shipped size.
    if let Some(shipped_layouts) = &ours.tables.seat_layouts {
        let layouts = merged.seat_layouts.get_or_insert_with(BTreeMap::new);
        for (size, kept) in shipped_layouts {
            match layouts.get_mut(size) {
                None => {
                    layouts.insert(size.clone(), kept.clone());
                    notes.push(MergeNote::TableGraphicsKept {
                        id: ours.id.clone(),
                        size: size.clone(),
                    });
                }
                Some(layout) => {
                    let mut zones = kept.graphics.clone();
                    for zone in &layout.graphics {
                        if !zones.contains(zone) {
                            zones.push(*zone);
                        }
                    }
                    if !kept.graphics.iter().all(|z| layout.graphics.contains(z)) {
                        notes.push(MergeNote::TableGraphicsKept {
                            id: ours.id.clone(),
                            size: size.clone(),
                        });
                    }
                    layout.graphics = zones;
                }
            }
        }
    }

    // Processes: a subset of the shipped names, or (none shipped) no name
    // another entry has.
    let mut looser = false;
    let others = |os: fn(&Processes) -> &Option<Vec<String>>| -> Vec<String> {
        shipped
            .sites
            .iter()
            .filter(|site| site.id != ours.id)
            .filter_map(|site| os(&site.tables.process).clone())
            .flatten()
            .collect()
    };
    let windows = merge_processes(
        ours.tables.process.windows.as_deref(),
        theirs.tables.process.windows.as_deref(),
        &others(|p| &p.windows),
        &mut looser,
    );
    let macos = merge_processes(
        ours.tables.process.macos.as_deref(),
        theirs.tables.process.macos.as_deref(),
        &others(|p| &p.macos),
        &mut looser,
    );
    merged.process = Processes { windows, macos };
    if looser {
        notes.push(MergeNote::LooserProcessesIgnored {
            id: ours.id.clone(),
        });
    }
    merged
}

/// One OS's process names: the remote's that the shipped list has (when it
/// has one) and that no other entry claims. `None` when none are left.
fn merge_processes(
    shipped: Option<&[String]>,
    remote: Option<&[String]>,
    others: &[String],
    looser: &mut bool,
) -> Option<Vec<String>> {
    let remote = remote?;
    let kept: Vec<String> = remote
        .iter()
        .filter(|name| {
            let allowed = shipped.is_none_or(|list| list.iter().any(|s| same_process(s, name)))
                && !others.iter().any(|other| same_process(other, name));
            *looser |= !allowed;
            allowed
        })
        .cloned()
        .collect();
    (!kept.is_empty()).then_some(kept)
}

/// The same executable: without case, without a trailing `.exe` (the HUD's
/// matcher compares them so).
fn same_process(a: &str, b: &str) -> bool {
    fn stem(name: &str) -> &str {
        let name = name.trim();
        let n = name.len();
        if n > 4 && name.is_char_boundary(n - 4) && name[n - 4..].eq_ignore_ascii_case(".exe") {
            &name[..n - 4]
        } else {
            name
        }
    }
    stem(a).eq_ignore_ascii_case(stem(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Anonymisation, Encoding, Files, HudRestrictions, PathEntry, Paths, Processes, SiteKind,
        Tables,
    };
    use crate::validate;

    const PARSERS: &[&str] = &["pokerstars", "ggpoker"];

    fn hud(allowed: Option<bool>) -> Hud {
        match allowed {
            Some(true) => Hud {
                allowed,
                source: Some("https://example.org/terms".to_owned()),
                checked_at: Some("2026-10-13".to_owned()),
                restrictions: Some(HudRestrictions::NONE),
                notes: String::new(),
            },
            _ => Hud {
                allowed,
                source: None,
                checked_at: None,
                restrictions: None,
                notes: String::new(),
            },
        }
    }

    fn site(id: &str, parser: &str, allowed: Option<bool>) -> Site {
        Site {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: SiteKind::Room,
            parser: Some(parser.to_owned()),
            network: None,
            operating: Some(true),
            skins: Vec::new(),
            paths: Paths {
                windows: Vec::new(),
                macos: Vec::new(),
            },
            files: Files {
                glob: None,
                encoding: Encoding::Auto,
                live: None,
                verified: false,
                source: "test".to_owned(),
                notes: String::new(),
            },
            tables: Tables {
                process: Processes {
                    windows: None,
                    macos: None,
                },
                title: None,
                seat_layouts: None,
                preferred_seat: None,
                verified: false,
                source: None,
                checked_at: None,
            },
            hud: hud(allowed),
            anonymisation: Some(Anonymisation::None),
            docs: Vec::new(),
            notes: String::new(),
        }
    }

    fn config(sites: Vec<Site>) -> Config {
        let config = Config {
            schema: None,
            version: 1,
            sites,
        };
        assert_eq!(validate(&config, PARSERS), Vec::new());
        config
    }

    fn merged_hud(shipped: Option<bool>, remote: Option<bool>) -> (Option<bool>, Vec<MergeNote>) {
        let merged = merge_remote(
            &config(vec![site("pokerstars", "pokerstars", shipped)]),
            &config(vec![site("pokerstars", "pokerstars", remote)]),
        );
        assert_eq!(validate(&merged.config, PARSERS), Vec::new());
        (merged.config.sites[0].hud.allowed, merged.notes)
    }

    const LEVELS: [Option<bool>; 3] = [Some(false), None, Some(true)];

    /// The whole table: the result is the stricter of the two, and a note
    /// says so exactly when the remote file was looser.
    #[test]
    fn hud_policy_only_gets_stricter() {
        for shipped in LEVELS {
            for remote in LEVELS {
                let (result, notes) = merged_hud(shipped, remote);
                let looser = HudLevel::of(&hud(remote)) > HudLevel::of(&hud(shipped));
                let expected = if looser { shipped } else { remote };
                assert_eq!(result, expected, "shipped {shipped:?}, remote {remote:?}");
                assert_eq!(
                    notes,
                    if looser {
                        vec![MergeNote::LooserHudIgnored {
                            id: "pokerstars".to_owned(),
                            shipped,
                            remote,
                        }]
                    } else {
                        Vec::new()
                    },
                );
            }
        }
    }

    #[test]
    fn remote_cannot_allow_what_is_unknown_or_prohibited() {
        assert_eq!(merged_hud(None, Some(true)).0, None);
        assert_eq!(merged_hud(Some(false), Some(true)).0, Some(false));
        assert_eq!(merged_hud(Some(false), None).0, Some(false));
    }

    #[test]
    fn remote_can_withdraw_an_allowance() {
        assert_eq!(merged_hud(Some(true), Some(false)).0, Some(false));
        assert_eq!(merged_hud(Some(true), None).0, None);
        assert_eq!(merged_hud(None, Some(false)).0, Some(false));
    }

    #[test]
    fn a_stricter_remote_brings_its_own_hud_block() {
        let mut remote = site("pokerstars", "pokerstars", Some(false));
        remote.hud.notes = "withdrawn".to_owned();
        let merged = merge_remote(
            &config(vec![site("pokerstars", "pokerstars", Some(true))]),
            &config(vec![remote]),
        );
        assert_eq!(merged.config.sites[0].hud.notes, "withdrawn");
        assert_eq!(merged.config.sites[0].hud.source, None);
    }

    /// R3.4: between two allowed blocks a download may add restrictions,
    /// never drop or ease one; the merged block has every restriction of
    /// both and the remote file's source, date and notes.
    #[test]
    fn restrictions_only_get_stricter() {
        let with = |restrictions: HudRestrictions, notes: &str| {
            let mut site = site("pokerstars", "pokerstars", Some(true));
            site.hud.restrictions = Some(restrictions);
            site.hud.notes = notes.to_owned();
            site
        };
        let shipped_rules = HudRestrictions {
            max_colour_thresholds: Some(2),
            no_player_labels: true,
            ..HudRestrictions::NONE
        };
        let shipped = config(vec![with(shipped_rules, "shipped")]);

        // Stricter: taken as it is.
        let stricter = HudRestrictions {
            max_colour_thresholds: Some(1),
            no_hand_in_play: true,
            ..shipped_rules
        };
        let merged = merge_remote(&shipped, &config(vec![with(stricter, "re-check")]));
        assert_eq!(merged.config.sites[0].hud.restrictions, Some(stricter));
        assert_eq!(merged.config.sites[0].hud.notes, "re-check");
        assert_eq!(merged.notes, Vec::new());

        // Looser in two ways and stricter in one: both kept.
        let mixed = HudRestrictions {
            max_colour_thresholds: None,
            no_graphs: true,
            ..HudRestrictions::NONE
        };
        let merged = merge_remote(&shipped, &config(vec![with(mixed, "eased")]));
        assert_eq!(
            merged.config.sites[0].hud.restrictions,
            Some(HudRestrictions {
                max_colour_thresholds: Some(2),
                no_player_labels: true,
                no_graphs: true,
                ..HudRestrictions::NONE
            })
        );
        assert_eq!(
            merged.notes,
            vec![MergeNote::LooserRestrictionsIgnored {
                id: "pokerstars".to_owned()
            }]
        );
        assert_eq!(validate(&merged.config, PARSERS), Vec::new());
    }

    #[test]
    fn stricter_is_a_union() {
        let all = HudRestrictions::STRICTEST;
        let none = HudRestrictions::NONE;
        assert_eq!(all.stricter(&none), all);
        assert_eq!(none.stricter(&all), all);
        assert!(all.at_least_as_strict_as(&none));
        assert!(!none.at_least_as_strict_as(&all));
        let three = HudRestrictions {
            max_colour_thresholds: Some(3),
            ..none
        };
        assert_eq!(three.stricter(&all).max_colour_thresholds, Some(2));
        assert_eq!(three.stricter(&none).max_colour_thresholds, Some(3));
        assert!(three.at_least_as_strict_as(&none));
        assert!(!none.at_least_as_strict_as(&three));
    }

    #[test]
    fn remote_corrects_paths_and_files() {
        let mut remote = site("pokerstars", "pokerstars", None);
        remote.paths.windows.push(PathEntry {
            path: r"%LOCALAPPDATA%\PokerStars\HandHistory\*".to_owned(),
            verified: true,
            source: "seen on an install".to_owned(),
            checked_at: Some("2026-11-01".to_owned()),
        });
        remote.files.live = Some(true);
        remote.name = "PokerStars".to_owned();
        let merged = merge_remote(
            &config(vec![site("pokerstars", "pokerstars", None)]),
            &config(vec![remote.clone()]),
        );
        assert_eq!(merged.config.sites, vec![remote]);
        assert_eq!(merged.notes, Vec::new());
    }

    #[test]
    fn unknown_ids_in_the_remote_file_are_ignored() {
        let merged = merge_remote(
            &config(vec![site("pokerstars", "pokerstars", None)]),
            &config(vec![
                site("pokerstars", "pokerstars", None),
                site("pokerstars-eu", "pokerstars", Some(true)),
            ]),
        );
        assert_eq!(merged.config.sites.len(), 1);
        assert!(merged.config.site("pokerstars-eu").is_none());
        assert_eq!(
            merged.notes,
            vec![MergeNote::UnknownSiteIgnored {
                id: "pokerstars-eu".to_owned()
            }]
        );
    }

    #[test]
    fn a_site_missing_from_the_remote_file_stays() {
        let shipped = config(vec![
            site("pokerstars", "pokerstars", Some(true)),
            site("ggpoker", "ggpoker", None),
        ]);
        let merged = merge_remote(
            &shipped,
            &config(vec![site("ggpoker", "ggpoker", Some(false))]),
        );
        assert_eq!(merged.config.sites[0], shipped.sites[0]);
        assert_eq!(merged.config.sites[1].hud.allowed, Some(false));
        assert_eq!(
            merged.notes,
            vec![MergeNote::MissingFromRemote {
                id: "pokerstars".to_owned()
            }]
        );
    }

    #[test]
    fn identity_changes_are_ignored_whole() {
        let shipped = config(vec![site("pokerstars", "pokerstars", Some(true))]);
        let mut parser = site("pokerstars", "ggpoker", Some(false));
        parser.files.live = Some(false);
        let mut kind = site("pokerstars", "pokerstars", Some(false));
        kind.kind = SiteKind::Network;
        let mut names = site("pokerstars", "pokerstars", Some(false));
        names.anonymisation = Some(Anonymisation::OpaqueId);
        for (remote, field) in [(parser, "parser"), (kind, "kind"), (names, "anonymisation")] {
            let merged = merge_remote(&shipped, &config(vec![remote]));
            assert_eq!(merged.config, shipped, "{field}");
            assert_eq!(
                merged.notes,
                vec![MergeNote::IdentityChangeIgnored {
                    id: "pokerstars".to_owned(),
                    field
                }]
            );
        }
    }

    #[test]
    fn version_order_and_schema_are_the_shipped_files() {
        let mut shipped = config(vec![
            site("pokerstars", "pokerstars", None),
            site("ggpoker", "ggpoker", None),
        ]);
        shipped.schema = Some("./sites.schema.json".to_owned());
        let remote = config(vec![
            site("ggpoker", "ggpoker", None),
            site("pokerstars", "pokerstars", None),
        ]);
        let merged = merge_remote(&shipped, &remote);
        assert_eq!(merged.config, shipped);
    }

    fn six_seats(graphics: Vec<[u32; 4]>, x: u32) -> crate::model::SeatLayout {
        crate::model::SeatLayout {
            seats: (0..6).map(|i| [x + i * 100, 800]).collect(),
            plate: [150, 80],
            center: [500, 500],
            hero_slot: 0,
            graphics,
            seat_numbers: None,
        }
    }

    fn with_layouts(mut site: Site, layouts: &[(&str, crate::model::SeatLayout)]) -> Site {
        site.tables.seat_layouts = Some(
            layouts
                .iter()
                .map(|(size, layout)| ((*size).to_owned(), layout.clone()))
                .collect(),
        );
        site
    }

    const BOARD: [u32; 4] = [300, 400, 400, 150];
    const TRAY: [u32; 4] = [450, 600, 100, 50];

    /// R3.6: a remote file that shrinks or drops a shipped table-graphics
    /// zone keeps the shipped one (and may still move the seats); one that
    /// adds a zone gets the union; one that drops a size or the whole
    /// layout keeps the shipped layout; a size only the remote has is
    /// taken.
    #[test]
    fn table_graphics_only_grow() {
        let shipped = config(vec![with_layouts(
            site("pokerstars", "pokerstars", Some(true)),
            &[("6", six_seats(vec![BOARD, TRAY], 100))],
        )]);
        let layout = |merged: &Merged, size: &str| {
            merged.config.sites[0]
                .tables
                .seat_layouts
                .as_ref()
                .and_then(|l| l.get(size))
                .cloned()
                .expect("a layout")
        };
        let kept = || MergeNote::TableGraphicsKept {
            id: "pokerstars".into(),
            size: "6".into(),
        };

        // Shrunk board, tray dropped, seats moved.
        let smaller = [320, 420, 360, 100];
        let remote = config(vec![with_layouts(
            site("pokerstars", "pokerstars", Some(true)),
            &[("6", six_seats(vec![smaller], 120))],
        )]);
        let merged = merge_remote(&shipped, &remote);
        let six = layout(&merged, "6");
        assert_eq!(six.graphics, vec![BOARD, TRAY, smaller]);
        assert_eq!(six.seats[0], [120, 800], "anchors are a correction");
        assert_eq!(merged.notes, vec![kept()]);
        assert_eq!(validate(&merged.config, PARSERS), Vec::new());

        // A zone added: the union, no note.
        let buttons = [700, 900, 300, 100];
        let remote = config(vec![with_layouts(
            site("pokerstars", "pokerstars", Some(true)),
            &[("6", six_seats(vec![TRAY, BOARD, buttons], 100))],
        )]);
        let merged = merge_remote(&shipped, &remote);
        assert_eq!(layout(&merged, "6").graphics, vec![BOARD, TRAY, buttons]);
        assert_eq!(merged.notes, Vec::new());

        // The size dropped (another size added), or no layouts at all.
        let remote = config(vec![with_layouts(
            site("pokerstars", "pokerstars", Some(true)),
            &[("2", {
                let mut two = six_seats(vec![], 100);
                two.seats.truncate(2);
                two
            })],
        )]);
        let merged = merge_remote(&shipped, &remote);
        assert_eq!(layout(&merged, "6"), six_seats(vec![BOARD, TRAY], 100));
        assert!(layout(&merged, "2").graphics.is_empty(), "taken as it is");
        assert_eq!(merged.notes, vec![kept()]);
        let merged = merge_remote(
            &shipped,
            &config(vec![site("pokerstars", "pokerstars", Some(true))]),
        );
        assert_eq!(layout(&merged, "6"), six_seats(vec![BOARD, TRAY], 100));
        assert_eq!(merged.notes, vec![kept()]);
    }

    fn with_processes(mut site: Site, windows: &[&str]) -> Site {
        site.tables.process.windows = Some(windows.iter().map(|s| (*s).to_owned()).collect());
        site
    }

    /// R3.6: a room's process names never reach past the shipped ones, nor
    /// into another entry's (its windows would then pose as this room).
    #[test]
    fn processes_only_narrow() {
        let shipped = config(vec![
            with_processes(
                site("pokerstars", "pokerstars", Some(true)),
                &["PokerStars.exe"],
            ),
            with_processes(site("ggpoker", "ggpoker", Some(false)), &["GGnet.exe"]),
        ]);
        let processes = |merged: &Merged| merged.config.sites[0].tables.process.windows.clone();
        let looser = MergeNote::LooserProcessesIgnored {
            id: "pokerstars".into(),
        };
        // Another room's process added: left out.
        let remote = config(vec![
            with_processes(
                site("pokerstars", "pokerstars", Some(true)),
                &["PokerStars.exe", "ggnet"],
            ),
            with_processes(site("ggpoker", "ggpoker", Some(false)), &["GGnet.exe"]),
        ]);
        let merged = merge_remote(&shipped, &remote);
        assert_eq!(processes(&merged), Some(vec!["PokerStars.exe".to_owned()]));
        assert_eq!(merged.notes, vec![looser.clone()]);
        // A new name past the shipped list: left out; a subset is fine.
        let remote = config(vec![
            with_processes(
                site("pokerstars", "pokerstars", Some(true)),
                &["Stars2.exe"],
            ),
            with_processes(site("ggpoker", "ggpoker", Some(false)), &["GGnet.exe"]),
        ]);
        let merged = merge_remote(&shipped, &remote);
        assert_eq!(processes(&merged), None, "nothing left: no matcher");
        assert_eq!(merged.notes, vec![looser.clone()]);
        let merged = merge_remote(&shipped, &shipped);
        assert_eq!(merged.config, shipped);
        assert_eq!(merged.notes, Vec::new());

        // None shipped: the remote's names, unless another entry has them.
        let unknown = config(vec![
            site("pokerstars", "pokerstars", Some(true)),
            with_processes(site("ggpoker", "ggpoker", Some(false)), &["GGnet.exe"]),
        ]);
        let remote = config(vec![
            with_processes(
                site("pokerstars", "pokerstars", Some(true)),
                &["PokerStars.exe", "GGNET.EXE"],
            ),
            with_processes(site("ggpoker", "ggpoker", Some(false)), &["GGnet.exe"]),
        ]);
        let merged = merge_remote(&unknown, &remote);
        assert_eq!(processes(&merged), Some(vec!["PokerStars.exe".to_owned()]));
        assert_eq!(merged.notes, vec![looser]);
        assert_eq!(validate(&merged.config, PARSERS), Vec::new());
    }
}

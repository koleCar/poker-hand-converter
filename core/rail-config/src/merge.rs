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
//!   (a re-check may refresh the source, date and notes).
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

use std::cmp::Ordering;

use crate::model::{Config, Hud, Site};

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
            Some(theirs) => merge_site(ours, theirs, &mut notes),
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

fn merge_site(ours: &Site, theirs: &Site, notes: &mut Vec<MergeNote>) -> Site {
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
        Ordering::Equal | Ordering::Less => {}
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Anonymisation, Encoding, Files, PathEntry, Paths, Processes, SiteKind, Tables,
    };
    use crate::validate;

    const PARSERS: &[&str] = &["pokerstars", "ggpoker"];

    fn hud(allowed: Option<bool>) -> Hud {
        match allowed {
            Some(true) => Hud {
                allowed,
                source: Some("https://example.org/terms".to_owned()),
                checked_at: Some("2026-10-13".to_owned()),
                notes: String::new(),
            },
            _ => Hud {
                allowed,
                source: None,
                checked_at: None,
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
}

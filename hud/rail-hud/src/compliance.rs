//! Compliance mode inside the HUD process (guideline §7, R3.2; R3.10
//! finishes it in the app's UI): the HUD attaches to a window only when its
//! room's `hud.allowed` is `true` - `rail_config::Site::hud_permitted()`,
//! a room and nothing else, unknown counting as no - asked of the merged
//! configuration: the shipped `sites.json` with the app's remote copy over
//! it by R0.12's rules (`rail_config::load_remote`: a remote file can make
//! a room's policy stricter, never looser; one that does not validate is
//! refused whole and the shipped copy stays). There is no override.

#![forbid(unsafe_code)]

use rail_config::model::HudRestrictions;
use rail_config::{Config, MergeNote, Site};
use rail_hud_ipc::protocol::RefusalReason;
use regex::Regex;

use crate::platform::TableMatcher;

/// Compliance mode's yes for one room (R3.4): the only way to make an
/// [`crate::platform::OverlayFrame`], so nothing can be drawn over a window
/// of a room whose HUD policy is not `allowed: true` - the engine asks again
/// before every draw, and the Windows backend checks the permit's room
/// against the window's. It carries the room's restrictions, which the
/// renderer enforces (`crate::scene::compose`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permit {
    site: String,
    restrictions: HudRestrictions,
}

impl Permit {
    /// The `sites.json` room.
    pub fn site(&self) -> &str {
        &self.site
    }

    /// What the room's policy forbids.
    pub fn restrictions(&self) -> &HudRestrictions {
        &self.restrictions
    }
}

/// The policy in force.
#[derive(Debug, Clone)]
pub struct Compliance {
    shipped: Config,
    config: Config,
    /// (R3.10) A remote copy is merged in.
    remote: bool,
}

fn parsers() -> Vec<&'static str> {
    rail_core::parsers::REGISTRATION_ORDER.to_vec()
}

impl Compliance {
    /// The shipped `sites.json` (compiled in).
    pub fn shipped() -> Result<Self, String> {
        let shipped = rail_config::load_shipped(&parsers()).map_err(|e| e.to_string())?;
        Ok(Self {
            config: shipped.clone(),
            shipped,
            remote: false,
        })
    }

    /// The app's remote copy over the shipped one (`None`: the shipped one
    /// alone). A remote file that is refused changes nothing - the policy
    /// in force stays (never looser than the shipped one) - and says why.
    pub fn apply_remote(&mut self, remote: Option<&str>) -> Result<Vec<MergeNote>, String> {
        let Some(text) = remote else {
            self.config = self.shipped.clone();
            self.remote = false;
            return Ok(Vec::new());
        };
        match rail_config::load_remote(&self.shipped, text, &parsers()) {
            Ok(merged) => {
                self.config = merged.config;
                self.remote = true;
                Ok(merged.notes)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    /// (R3.10) The app's remote copy at start (`--policy <file>`, the app's
    /// cache of the last good download): read before the first look for
    /// tables, so a window the remote copy refuses is never attached for a
    /// moment. No file: the shipped policy. A file that cannot be read or is
    /// refused: the shipped policy, and why.
    pub fn apply_remote_file(&mut self, path: &std::path::Path) -> Result<Vec<MergeNote>, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => self.apply_remote(Some(&text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
    }

    /// (R3.10) Whether a remote copy is merged in.
    pub fn has_remote(&self) -> bool {
        self.remote
    }

    /// The configuration in force (shipped, merged with the remote copy):
    /// the rooms' table data - layouts and preferred seat (R3.6) - as well
    /// as their policies.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// May the HUD attach to a window of the room `site`?
    pub fn decide(&self, site: &str) -> Result<(), RefusalReason> {
        let Some(entry) = self.config.site(site) else {
            return Err(RefusalReason::UnknownSite);
        };
        if entry.hud_permitted() {
            return Ok(());
        }
        Err(match (entry.kind, entry.hud.allowed) {
            (rail_config::model::SiteKind::Room, Some(false)) => RefusalReason::Prohibited,
            (rail_config::model::SiteKind::Room, _) => RefusalReason::Unknown,
            _ => RefusalReason::NotARoom,
        })
    }

    /// [`Self::decide`], and with a yes the room's [`Permit`]: its
    /// restrictions from `sites.json` (a permitted room always has them -
    /// the validator refuses one without; should one ever be missing, every
    /// restriction applies).
    pub fn permit(&self, site: &str) -> Result<Permit, RefusalReason> {
        self.decide(site)?;
        let restrictions = self
            .config
            .site(site)
            .and_then(|entry| entry.hud.restrictions)
            .unwrap_or(HudRestrictions::STRICTEST);
        Ok(Permit {
            site: site.to_owned(),
            restrictions,
        })
    }

    /// The store's name for a room's hands (`segments.site`): its parser's
    /// site id - `acr`'s hands are `acrwpn`'s - else its own id.
    pub fn store_site(&self, site: &str) -> String {
        self.config
            .site(site)
            .and_then(|entry| entry.parser.clone())
            .unwrap_or_else(|| site.to_owned())
    }

    /// The rooms' table matchers on this system (`sites.json` `tables`:
    /// processes and a title regex; all `null` until R3.3 / R3.11 read them
    /// from the clients). Rooms the HUD may not attach to are included:
    /// their windows are found and refused, and the app says why.
    pub fn matchers(&self) -> Vec<TableMatcher> {
        self.config.sites.iter().filter_map(matcher_of).collect()
    }
}

fn matcher_of(site: &Site) -> Option<TableMatcher> {
    let processes = if cfg!(windows) {
        site.tables.process.windows.clone()
    } else {
        site.tables.process.macos.clone()
    }?;
    let title = Regex::new(site.tables.title.as_deref()?).ok()?;
    Some(TableMatcher {
        site: site.id.clone(),
        processes,
        title,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The signed list (R3.0): PokerStars, Winamax and ACR yes; a prohibited
    /// room, an unknown one, a network, a format and an id nobody knows no.
    #[test]
    fn only_allowed_rooms_are_attached() {
        let compliance = Compliance::shipped().expect("shipped");
        for site in ["pokerstars", "winamax", "acr"] {
            assert_eq!(compliance.decide(site), Ok(()), "{site}");
        }
        assert_eq!(compliance.decide("ggpoker"), Err(RefusalReason::Prohibited));
        assert_eq!(compliance.decide("888poker"), Err(RefusalReason::Unknown));
        assert_eq!(compliance.decide("weplay"), Err(RefusalReason::Unknown));
        assert_eq!(compliance.decide("ipoker"), Err(RefusalReason::NotARoom));
        assert_eq!(compliance.decide("standard"), Err(RefusalReason::NotARoom));
        assert_eq!(
            compliance.decide("rail-hud-sim"),
            Err(RefusalReason::UnknownSite)
        );
        assert_eq!(compliance.store_site("acr"), "acrwpn");
        assert_eq!(compliance.store_site("pokerstars"), "pokerstars");
        assert_eq!(compliance.store_site("wpt-global"), "wpt-global");
        // No room's tables are known yet (R3.3 / R3.11).
        assert!(compliance.matchers().is_empty());
    }

    fn remote_with(edit: impl Fn(&mut serde_json::Value)) -> String {
        let mut value: serde_json::Value =
            serde_json::from_str(rail_config::SHIPPED).expect("shipped json");
        edit(&mut value);
        value.to_string()
    }

    fn site_mut<'a>(value: &'a mut serde_json::Value, id: &str) -> &'a mut serde_json::Value {
        value["sites"]
            .as_array_mut()
            .expect("sites")
            .iter_mut()
            .find(|s| s["id"] == id)
            .expect("site")
    }

    /// A remote file may switch a room's HUD off; it can never switch one
    /// on; a broken one changes nothing; `None` goes back to the shipped
    /// policy.
    #[test]
    fn a_remote_policy_only_gets_stricter() {
        let mut compliance = Compliance::shipped().expect("shipped");
        let off = remote_with(|v| {
            let hud = &mut site_mut(v, "pokerstars")["hud"];
            hud["allowed"] = serde_json::Value::Bool(false);
        });
        compliance.apply_remote(Some(&off)).expect("merged");
        assert_eq!(
            compliance.decide("pokerstars"),
            Err(RefusalReason::Prohibited)
        );
        assert_eq!(compliance.decide("winamax"), Ok(()));

        let on = remote_with(|v| {
            let hud = &mut site_mut(v, "888poker")["hud"];
            hud["allowed"] = serde_json::Value::Bool(true);
            hud["source"] = "https://example.invalid/policy".into();
            hud["checkedAt"] = "2026-10-15".into();
            hud["restrictions"] = serde_json::to_value(HudRestrictions::NONE).expect("json");
        });
        let notes = compliance.apply_remote(Some(&on)).expect("merged");
        assert!(
            notes
                .iter()
                .any(|n| matches!(n, MergeNote::LooserHudIgnored { id, .. } if id == "888poker")),
            "{notes:?}"
        );
        assert_eq!(compliance.decide("888poker"), Err(RefusalReason::Unknown));
        assert_eq!(
            compliance.decide("pokerstars"),
            Ok(()),
            "the earlier remote is gone"
        );

        compliance.apply_remote(Some(&off)).expect("merged");
        assert!(compliance.apply_remote(Some("{not json")).is_err());
        assert_eq!(
            compliance.decide("pokerstars"),
            Err(RefusalReason::Prohibited),
            "a refused remote changes nothing"
        );
        compliance.apply_remote(None).expect("shipped");
        assert_eq!(compliance.decide("pokerstars"), Ok(()));
        assert!(!compliance.has_remote());
    }

    /// (R3.10) `--policy <file>`: the app's cached remote copy, read at
    /// start. A missing file is the shipped policy; a broken one is refused
    /// and the shipped policy stays.
    #[test]
    fn the_remote_copy_from_a_file() {
        let dir = std::env::temp_dir().join(format!("rail-hud-policy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("sites.json");
        let mut compliance = Compliance::shipped().expect("shipped");
        assert!(
            compliance
                .apply_remote_file(&path)
                .expect("no file")
                .is_empty()
        );
        assert!(!compliance.has_remote());
        assert_eq!(compliance.decide("acr"), Ok(()));

        std::fs::write(
            &path,
            remote_with(|v| {
                site_mut(v, "acr")["hud"]["allowed"] = serde_json::Value::Bool(false);
            }),
        )
        .expect("write");
        compliance.apply_remote_file(&path).expect("merged");
        assert!(compliance.has_remote());
        assert_eq!(compliance.decide("acr"), Err(RefusalReason::Prohibited));

        let mut fresh = Compliance::shipped().expect("shipped");
        std::fs::write(&path, "{\"version\": 1, \"sites\": 3}").expect("write");
        assert!(fresh.apply_remote_file(&path).is_err());
        assert!(!fresh.has_remote());
        assert_eq!(fresh.decide("acr"), Ok(()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A permit only for a permitted room, with its restrictions; a remote
    /// file can add a restriction, not drop one.
    #[test]
    fn permits() {
        let mut compliance = Compliance::shipped().expect("shipped");
        for (site, reason) in [
            ("ggpoker", RefusalReason::Prohibited),
            ("888poker", RefusalReason::Unknown),
            ("ipoker", RefusalReason::NotARoom),
            ("nowhere", RefusalReason::UnknownSite),
        ] {
            assert_eq!(compliance.permit(site), Err(reason), "{site}");
        }
        let stars = compliance.permit("pokerstars").expect("pokerstars");
        assert_eq!(stars.site(), "pokerstars");
        assert_eq!(stars.restrictions().max_colour_thresholds, Some(2));
        let acr = compliance.permit("acr").expect("acr");
        assert!(acr.restrictions().no_overlap_table_graphics);
        assert!(!acr.restrictions().no_card_split_stats);

        let eased = remote_with(|v| {
            let rules = &mut site_mut(v, "acr")["hud"]["restrictions"];
            rules["noOverlapTableGraphics"] = serde_json::Value::Bool(false);
            rules["noCardSplitStats"] = serde_json::Value::Bool(true);
        });
        let notes = compliance.apply_remote(Some(&eased)).expect("merged");
        assert!(
            notes
                .iter()
                .any(|n| matches!(n, MergeNote::LooserRestrictionsIgnored { id } if id == "acr"))
        );
        let acr = compliance.permit("acr").expect("acr");
        assert!(acr.restrictions().no_overlap_table_graphics, "kept");
        assert!(acr.restrictions().no_card_split_stats, "added");
    }
}

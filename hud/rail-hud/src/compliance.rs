//! Compliance mode inside the HUD process (guideline §7, R3.2; R3.10
//! finishes it in the app's UI): the HUD attaches to a window only when its
//! room's `hud.allowed` is `true` - `rail_config::Site::hud_permitted()`,
//! a room and nothing else, unknown counting as no - asked of the merged
//! configuration: the shipped `sites.json` with the app's remote copy over
//! it by R0.12's rules (`rail_config::load_remote`: a remote file can make
//! a room's policy stricter, never looser; one that does not validate is
//! refused whole and the shipped copy stays). There is no override.

#![forbid(unsafe_code)]

use rail_config::{Config, MergeNote, Site};
use rail_hud_ipc::protocol::RefusalReason;
use regex::Regex;

use crate::platform::TableMatcher;

/// The policy in force.
#[derive(Debug, Clone)]
pub struct Compliance {
    shipped: Config,
    config: Config,
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
        })
    }

    /// The app's remote copy over the shipped one (`None`: the shipped one
    /// alone). A remote file that is refused changes nothing - the policy
    /// in force stays (never looser than the shipped one) - and says why.
    pub fn apply_remote(&mut self, remote: Option<&str>) -> Result<Vec<MergeNote>, String> {
        let Some(text) = remote else {
            self.config = self.shipped.clone();
            return Ok(Vec::new());
        };
        match rail_config::load_remote(&self.shipped, text, &parsers()) {
            Ok(merged) => {
                self.config = merged.config;
                Ok(merged.notes)
            }
            Err(error) => Err(error.to_string()),
        }
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
    }
}

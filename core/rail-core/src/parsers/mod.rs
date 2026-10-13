//! The site parsers and the built-in registry (`frontend/src/lib/parsers/`).
//!
//! Parsers arrive one step at a time (R0.7-R0.10). Each one is added to
//! `ported()`; [`builtin`] orders them by [`REGISTRATION_ORDER`] - the order
//! of the `registerParser` calls in `frontend/src/lib/parsers/index.ts` -
//! because detection ties keep registration order, so the Rust registry has to
//! rank the same way whichever subset is ported. A parser id that is not in
//! the list panics on first use, and a test fails when the list stops
//! matching `index.ts`. Every parser id also needs an entry in
//! `config/sites.json` (R0.12): `rail-config`'s tests fail on a parser
//! without one, and on an entry naming a parser that is not here.

pub mod acrwpn;
pub mod chico;
pub mod coinpoker;
pub mod entraction;
pub mod fulltilt;
pub mod ggpoker;
pub mod ignition;
pub mod ipoker;
pub mod microgaming;
pub mod ongame;
pub mod partypoker;
pub mod pokerbros;
pub mod pokerstars;
pub mod pokerstars888;
pub mod runitonce;
pub mod shared;
pub mod standard;
pub mod unibet;
pub mod weplay;
pub mod winamax;

use std::sync::LazyLock;

use crate::detect::{Registry, SiteParser};

/// Parser ids in the order `frontend/src/lib/parsers/index.ts` registers them.
pub const REGISTRATION_ORDER: [&str; 19] = [
    "weplay",
    "standard",
    "pokerstars",
    "ggpoker",
    "888poker",
    "partypoker",
    "ipoker",
    "coinpoker",
    "unibet",
    "ongame",
    "entraction",
    "microgaming",
    "fulltilt",
    "runitonce",
    "pokerbros",
    "ignition",
    "winamax",
    "chico",
    "acrwpn",
];

/// Every parser ported so far. A parser step adds one line here.
fn ported() -> Vec<Box<dyn SiteParser>> {
    vec![
        Box::new(standard::StandardParser),
        Box::new(pokerstars::PokerStarsParser),
        Box::new(ggpoker::GgPokerParser),
        Box::new(weplay::WePlayParser),
        Box::new(coinpoker::CoinPokerParser),
        Box::new(partypoker::PartyPokerParser),
        Box::new(pokerstars888::Poker888Parser),
        Box::new(pokerbros::PokerBrosParser),
        Box::new(ipoker::IPokerParser),
        Box::new(microgaming::MicroGamingParser),
        Box::new(winamax::WinamaxParser),
        Box::new(chico::ChicoParser),
        Box::new(ignition::IgnitionParser),
        Box::new(acrwpn::AcrWpnParser),
        Box::new(fulltilt::FullTiltParser),
        Box::new(runitonce::RunItOnceParser),
        Box::new(ongame::OngameParser),
        Box::new(entraction::EntractionParser),
        Box::new(unibet::UnibetParser),
    ]
}

/// A registry of `parsers` in [`REGISTRATION_ORDER`].
///
/// # Panics
///
/// When a parser's id is not in [`REGISTRATION_ORDER`].
pub fn in_registration_order(mut parsers: Vec<Box<dyn SiteParser>>) -> Registry {
    let rank = |parser: &dyn SiteParser| {
        REGISTRATION_ORDER
            .iter()
            .position(|id| *id == parser.id())
            .unwrap_or_else(|| panic!("parser {:?} is not in REGISTRATION_ORDER", parser.id()))
    };
    parsers.sort_by_key(|parser| rank(parser.as_ref()));
    let mut registry = Registry::new();
    for parser in parsers {
        registry.register(parser);
    }
    registry
}

static BUILTIN: LazyLock<Registry> = LazyLock::new(|| in_registration_order(ported()));

/// The registry `convert` uses: every ported parser, in TypeScript
/// registration order.
pub fn builtin() -> &'static Registry {
    &BUILTIN
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::js::regex::js_regex;

    /// `REGISTRATION_ORDER` is `index.ts`'s order, by parser id.
    #[test]
    fn registration_order_is_the_typescript_order() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/src/lib/parsers");
        let declaration = js_regex(r#"export const (\w+): SiteParser = \{\s*id: "([^"]+)""#, "");
        let mut ids = std::collections::HashMap::new();
        for entry in std::fs::read_dir(&dir).expect("read parsers/") {
            let path = entry.expect("entry").path();
            if path.extension().is_some_and(|ext| ext == "ts") {
                let source = std::fs::read_to_string(&path).expect("read parser");
                for captures in declaration.captures_iter(&source) {
                    ids.insert(captures[1].to_owned(), captures[2].to_owned());
                }
            }
        }
        let index = std::fs::read_to_string(dir.join("index.ts")).expect("read index.ts");
        // `\r?`: a Windows checkout has CRLF sources.
        let registered: Vec<String> = js_regex(r"^registerParser\((\w+)\);\r?$", "m")
            .captures_iter(&index)
            .map(|captures| {
                ids.get(&captures[1])
                    .cloned()
                    .unwrap_or_else(|| panic!("no id found for {}", &captures[1]))
            })
            .collect();
        assert_eq!(registered, REGISTRATION_ORDER);
    }

    #[test]
    fn the_builtin_registry_holds_the_ported_parsers_in_order() {
        let ids: Vec<&str> = builtin().parsers().map(SiteParser::id).collect();
        let mut expected: Vec<&str> = ported().iter().map(|parser| parser.id()).collect();
        expected.sort_by_key(|id| REGISTRATION_ORDER.iter().position(|o| o == id));
        assert_eq!(ids, expected);
    }

    /// Since R0.10d every TypeScript parser is ported: the built-in registry
    /// is the whole `index.ts` registry, in its order (which
    /// `registration_order_is_the_typescript_order` reads from `index.ts`).
    #[test]
    fn the_builtin_registry_is_the_whole_typescript_registry() {
        let ids: Vec<&str> = builtin().parsers().map(SiteParser::id).collect();
        assert_eq!(ids, REGISTRATION_ORDER);
        assert_eq!(ported().len(), REGISTRATION_ORDER.len());
    }
}

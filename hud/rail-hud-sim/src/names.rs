//! Player names for the simulated tables.
//!
//! A table keeps one name per seat, so a seat's player collects hands (and
//! HUD numbers) the way a regular does. Names are made up from two word
//! lists and a number - ASCII, no spaces, a digit or `_` in each - so that
//! none is an ordinary word of a hand history, and they are unique for the
//! whole run.

use std::collections::HashSet;

use crate::clock::Rng;

const FIRST: [&str; 32] = [
    "Silent", "Lucky", "River", "Turbo", "Quiet", "Grumpy", "Shady", "Mighty", "Lazy", "Brave",
    "Crafty", "Dizzy", "Frosty", "Golden", "Hasty", "Jolly", "Keen", "Lofty", "Moody", "Nifty",
    "Plucky", "Rusty", "Salty", "Tipsy", "Witty", "Zesty", "Bluff", "Snappy", "Gritty", "Sneaky",
    "Wobbly", "Cosmic",
];

const SECOND: [&str; 32] = [
    "Shark", "Donk", "Fish", "Rat", "Owl", "Tiger", "Mole", "Crab", "Whale", "Fox", "Bear", "Hawk",
    "Badger", "Otter", "Panda", "Moose", "Gecko", "Llama", "Raven", "Bison", "Cobra", "Lynx",
    "Mantis", "Newt", "Pike", "Quail", "Squid", "Toad", "Viper", "Wasp", "Yak", "Zebu",
];

/// Hands out names, never the same one twice in a run.
#[derive(Debug, Default)]
pub struct NameSource {
    used: HashSet<String>,
}

impl NameSource {
    /// A name nobody in this run has.
    pub fn fresh(&mut self, rng: &mut Rng) -> String {
        loop {
            let first = FIRST[rng.index(FIRST.len())];
            let second = SECOND[rng.index(SECOND.len())];
            let name = match rng.below(3) {
                0 => format!("{first}{second}{}", rng.between(1, 99)),
                1 => format!("{}_{}{}", first.to_lowercase(), second, rng.between(1, 9)),
                _ => format!("{second}_{first}{}", rng.between(10, 999)),
            };
            if self.used.insert(name.clone()) {
                return name;
            }
        }
    }

    /// Reserve a name (the hero's) so no generated one equals it.
    pub fn reserve(&mut self, name: &str) {
        self.used.insert(name.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_plain() {
        let mut rng = Rng::new(1);
        let mut source = NameSource::default();
        source.reserve("Hero");
        let mut seen = HashSet::new();
        for _ in 0..2000 {
            let name = source.fresh(&mut rng);
            assert!(name.is_ascii() && !name.contains(' '));
            assert!(name.chars().any(|c| c.is_ascii_digit() || c == '_'));
            assert!(seen.insert(name));
        }
    }
}

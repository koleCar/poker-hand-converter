//! (T4, docs/research/TABLE-TILING.md §4.4) The RNG overlay's number: one
//! roll per table, from the operating system's CSPRNG (`getrandom`: the
//! system's own generator - `getrandom(2)`, `arc4random_buf`,
//! `ProcessPrng`), mapped onto the user's range (1 - 100 by default, both
//! ends included) by **rejection sampling**: a 32-bit word is taken only
//! below the largest multiple of the range's size that fits in 2^32, so
//! every number has exactly as many words as any other and there is no
//! modulo bias. Never the analysis's seeded `Mulberry32`: nothing here is
//! reproducible, and each table rolls independently (one draw per roll).
//!
//! The rejection logic is [`pick`], generic over the word's width so the
//! tests can prove it unbiased exhaustively on 8- and 12-bit words; the
//! engine calls [`roll`].

#![forbid(unsafe_code)]

/// Words drawn at most for one roll before giving up. A word is refused
/// with a chance below `size / 2^32` (under 3 in a million for a range of
/// 10 001, the largest the settings allow), so this is never reached
/// unless the source is broken.
pub const MAX_DRAWS: u32 = 64;

/// Why a roll failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RollError {
    /// `max` is below `min`.
    EmptyRange,
    /// The system's generator failed (or kept giving refused words).
    Source(String),
}

impl std::fmt::Display for RollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyRange => write!(f, "the RNG's range is empty"),
            Self::Source(error) => write!(f, "the system's random source: {error}"),
        }
    }
}

impl std::error::Error for RollError {}

/// The offset (`0..size`) a `bits`-bit `word` stands for, or `None` when
/// the word lies in the top part that does not divide evenly by `size` and
/// must be drawn again. `size` is `1..=2^bits`; `bits` is `1..=32`.
pub fn pick(word: u64, size: u64, bits: u32) -> Option<u64> {
    let words = 1_u64 << bits;
    debug_assert!(size >= 1 && size <= words && word < words);
    // The largest multiple of `size` not above 2^bits: words below it map
    // `size`-to-one evenly; the rest are refused.
    let limit = words - words % size;
    (word < limit).then_some(word % size)
}

/// A number from `min` to `max` (both included), uniformly, from `draw`
/// (one 32-bit word per call, from the system's CSPRNG in [`roll`]).
pub fn roll_with(
    min: u32,
    max: u32,
    draw: &mut dyn FnMut() -> Result<u32, String>,
) -> Result<u32, RollError> {
    if max < min {
        return Err(RollError::EmptyRange);
    }
    let size = u64::from(max - min) + 1;
    for _ in 0..MAX_DRAWS {
        let word = draw().map_err(RollError::Source)?;
        if let Some(offset) = pick(u64::from(word), size, 32) {
            // `offset < size <= 2^32` and `min + offset <= max`.
            return u32::try_from(u64::from(min) + offset)
                .map_err(|_| RollError::Source("out of range".to_owned()));
        }
    }
    Err(RollError::Source(format!(
        "{MAX_DRAWS} words in a row refused"
    )))
}

/// One 32-bit word from the operating system's CSPRNG.
pub fn os_word() -> Result<u32, String> {
    let mut bytes = [0_u8; 4];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(u32::from_le_bytes(bytes))
}

/// A number from `min` to `max` (both included) from the system's CSPRNG.
pub fn roll(min: u32, max: u32) -> Result<u32, RollError> {
    roll_with(min, max, &mut os_word)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exhaustively, on 8- and 12-bit words: every size's accepted words
    /// give every offset exactly equally often (no modulo bias), and only
    /// the top `2^bits mod size` words are refused.
    #[test]
    fn rejection_is_exactly_uniform() {
        for bits in [8_u32, 12] {
            let words = 1_u64 << bits;
            for size in [1_u64, 2, 3, 7, 10, 100, 101, 255, words - 1, words] {
                if size > words {
                    continue;
                }
                let mut counts = vec![0_u64; usize::try_from(size).expect("size")];
                let mut refused = 0_u64;
                for word in 0..words {
                    match pick(word, size, bits) {
                        Some(offset) => {
                            counts[usize::try_from(offset).expect("offset")] += 1;
                        }
                        None => refused += 1,
                    }
                }
                assert_eq!(refused, words % size, "bits {bits}, size {size}");
                let first = counts[0];
                assert!(
                    counts.iter().all(|&c| c == first),
                    "bits {bits}, size {size}"
                );
                assert_eq!(first, words / size);
            }
        }
    }

    /// The real 32-bit cut: 1 - 100 refuses exactly the top 2^32 mod 100
    /// words, takes the one below them, and maps the ends onto `min` and
    /// `max`.
    #[test]
    fn the_32_bit_cut() {
        let words = 1_u64 << 32;
        let limit = words - words % 100;
        assert_eq!(words % 100, 96);
        assert_eq!(pick(limit - 1, 100, 32), Some(99));
        assert_eq!(pick(limit, 100, 32), None);
        assert_eq!(pick(words - 1, 100, 32), None);
        assert_eq!(pick(0, 100, 32), Some(0));
        // A whole 32-bit range is never refused.
        assert_eq!(pick(words - 1, words, 32), Some(words - 1));
    }

    /// A source that gives refused words first: they are drawn again, the
    /// first good one decides; a broken source is an error, not a number.
    #[test]
    fn refused_words_are_drawn_again() {
        let mut queue = vec![u32::MAX, u32::MAX - 3, 205].into_iter();
        let mut draws = 0;
        let mut draw = || {
            draws += 1;
            queue.next().ok_or_else(|| "empty".to_owned())
        };
        // 205 % 100 = 5: the number 6 of 1 - 100.
        assert_eq!(roll_with(1, 100, &mut draw), Ok(6));
        assert_eq!(draws, 3);
        assert_eq!(
            roll_with(1, 100, &mut || Ok(u32::MAX)),
            Err(RollError::Source(format!(
                "{MAX_DRAWS} words in a row refused"
            )))
        );
        assert_eq!(
            roll_with(1, 100, &mut || Err("gone".to_owned())),
            Err(RollError::Source("gone".to_owned()))
        );
        assert_eq!(roll_with(5, 4, &mut || Ok(0)), Err(RollError::EmptyRange));
        assert_eq!(roll_with(7, 7, &mut || Ok(123_456)), Ok(7));
        assert_eq!(roll_with(0, 99, &mut || Ok(199)), Ok(99));
        assert_eq!(roll_with(0, u32::MAX, &mut || Ok(42)), Ok(42));
    }

    /// The system's generator, 200 000 rolls of 1 - 100: always in range,
    /// both ends reached, and the counts' chi-square (99 degrees of
    /// freedom) under 250 - a bound a fair source exceeds with a chance
    /// far below one in a trillion, so this cannot flake; a biased or
    /// stuck source fails it at once.
    #[test]
    fn the_system_source_is_uniform_enough() {
        const ROLLS: u64 = 200_000;
        let mut counts = [0_u64; 100];
        for _ in 0..ROLLS {
            let n = roll(1, 100).expect("a roll");
            assert!((1..=100).contains(&n), "{n}");
            counts[usize::try_from(n - 1).expect("index")] += 1;
        }
        assert!(counts.iter().all(|&c| c > 0));
        let expected = ROLLS / 100;
        let squares: u64 = counts
            .iter()
            .map(|&c| {
                let d = c.abs_diff(expected);
                d * d
            })
            .sum();
        // chi-square = squares / expected < 250.
        assert!(
            squares < 250 * expected,
            "chi-square {} over 99 degrees of freedom",
            squares / expected
        );
        // Tables roll independently: two rolls in a row are not tied.
        let pairs = (0..1000)
            .filter(|_| roll(1, 100).expect("a") == roll(1, 100).expect("b"))
            .count();
        assert!(pairs < 60, "{pairs} equal pairs of 1000 (10 expected)");
    }
}

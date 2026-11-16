//! Cards and two-card combos (`combos.ts`): card `rank * 4 + suit` with suits
//! `s h d c`, combo index `hi * (hi - 1) / 2 + lo`, 1,326 of them.

use crate::{SolverInputError, input_error};

pub const NUM_COMBOS: usize = 1326;

const RANK_CHARS: &[u8; 13] = b"23456789TJQKA";
const SUIT_CHARS: &[u8; 4] = b"shdc";

/// Combo index of two distinct cards, in either order.
#[must_use]
pub fn combo_index(a: u8, b: u8) -> usize {
    let (hi, lo) = if a > b {
        (usize::from(a), usize::from(b))
    } else {
        (usize::from(b), usize::from(a))
    };
    hi * (hi - 1) / 2 + lo
}

/// The two cards of a combo, higher first.
#[must_use]
pub fn combo_cards(index: usize) -> (u8, u8) {
    COMBO_TABLE[index]
}

static COMBO_TABLE: [(u8, u8); NUM_COMBOS] = {
    let mut out = [(0_u8, 0_u8); NUM_COMBOS];
    let mut hi = 1_u8;
    while hi < 52 {
        let mut lo = 0_u8;
        while lo < hi {
            out[(hi as usize) * (hi as usize - 1) / 2 + lo as usize] = (hi, lo);
            lo += 1;
        }
        hi += 1;
    }
    out
};

#[must_use]
pub fn combo_hi(index: usize) -> u8 {
    combo_cards(index).0
}

#[must_use]
pub fn combo_lo(index: usize) -> u8 {
    combo_cards(index).1
}

/// `"Ah"`-style code of a card index.
#[must_use]
pub fn card_code(card: u8) -> String {
    let mut s = String::with_capacity(2);
    s.push(char::from(RANK_CHARS[usize::from(card >> 2)]));
    s.push(char::from(SUIT_CHARS[usize::from(card & 3)]));
    s
}

/// Card index of a code like `"Ah"` (rank case-insensitive), or None.
#[must_use]
pub fn card_index(code: &str) -> Option<u8> {
    rail_core::eval::card_index(code.trim())
}

/// A card as the spot inputs give it: a code or an index.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum CardInput {
    Index(i64),
    Code(String),
}

/// Card indices of a list of codes; rejects junk and duplicates (`parseCards`).
///
/// # Errors
/// A code that is not a card, or a duplicate.
pub fn parse_cards(codes: &[CardInput]) -> Result<Vec<u8>, SolverInputError> {
    let mut out = Vec::with_capacity(codes.len());
    for code in codes {
        let index = match code {
            CardInput::Index(i) if (0..52).contains(i) => *i as u8,
            CardInput::Code(s) => match card_index(s) {
                Some(i) => i,
                None => return input_error(format!("not a card: {s}")),
            },
            CardInput::Index(i) => return input_error(format!("not a card: {i}")),
        };
        if out.contains(&index) {
            return input_error(format!("duplicate card: {}", card_code(index)));
        }
        out.push(index);
    }
    Ok(out)
}

/// A flop key like `Ks5h3s` as card codes.
#[must_use]
pub fn split_cards(text: &str) -> Vec<CardInput> {
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    chars
        .chunks(2)
        .map(|pair| CardInput::Code(pair.iter().collect()))
        .collect()
}

/// A range input: 1,326 weights, or the same as little-endian `f64` bytes in
/// base64 (exact: JSON numbers do not always parse back to the same bits).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum RangeInput {
    Weights(Vec<f64>),
    Base64(String),
}

/// 1,326 weights from a range input (`toRange`), checked to lie in [0, 1].
///
/// # Errors
/// The wrong length, a weight outside [0, 1], or bad base64.
pub fn to_range(input: &RangeInput) -> Result<Vec<f64>, SolverInputError> {
    let out = match input {
        RangeInput::Weights(w) => w.clone(),
        RangeInput::Base64(text) => {
            let bytes =
                base64_decode(text).ok_or_else(|| SolverInputError("bad base64 range".into()))?;
            if bytes.len() % 8 != 0 {
                return input_error("a base64 range is whole f64s");
            }
            bytes
                .as_chunks::<8>()
                .0
                .iter()
                .map(|b| f64::from_le_bytes(*b))
                .collect()
        }
    };
    if out.len() != NUM_COMBOS {
        return input_error(format!(
            "a range vector has {NUM_COMBOS} weights, got {}",
            out.len()
        ));
    }
    if out.iter().any(|w| !(*w >= 0.0 && *w <= 1.0)) {
        return input_error("range weights must be within [0, 1]");
    }
    Ok(out)
}

/// Standard base64 (with or without padding).
#[must_use]
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(u32::from(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        }))
    };
    let clean: Vec<u8> = text
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut acc = 0_u32;
        for (k, c) in chunk.iter().enumerate() {
            acc |= value(*c)? << (18 - 6 * k);
        }
        let bytes = acc.to_be_bytes();
        match chunk.len() {
            4 => out.extend_from_slice(&bytes[1..4]),
            3 => out.extend_from_slice(&bytes[1..3]),
            2 => out.push(bytes[1]),
            _ => return None,
        }
    }
    Some(out)
}

/// Standard base64 with padding.
#[must_use]
pub fn base64_encode(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(char::from(ABC[((n >> (18 - 6 * k)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combo_index_is_a_bijection() {
        let mut seen = vec![false; NUM_COMBOS];
        for hi in 1..52_u8 {
            for lo in 0..hi {
                let c = combo_index(lo, hi);
                assert!(!seen[c]);
                seen[c] = true;
                assert_eq!(combo_cards(c), (hi, lo));
            }
        }
        assert_eq!(card_code(51), "Ac");
        assert_eq!(card_index("Ks"), Some(44));
    }

    #[test]
    fn base64_round_trips() {
        for len in 0..20 {
            let bytes: Vec<u8> = (0..len).map(|k| (k * 37 + 11) as u8).collect();
            assert_eq!(
                base64_decode(&base64_encode(&bytes)).as_deref(),
                Some(&bytes[..])
            );
        }
    }
}

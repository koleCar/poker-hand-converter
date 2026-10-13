//! A string that must never reach a log: tokens and token hashes.

use std::fmt;

use zeroize::Zeroize;

/// A secret string. `Debug` prints `Secret(..)`, there is no `Display`,
/// and the bytes are wiped when it is dropped. The only way to the value is
/// [`Secret::expose`], which makes every use greppable.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value, for the one place that has to send it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_value() {
        let secret = Secret::new("refresh-token-value");
        let printed = format!("{secret:?} {:?}", Some(&secret));
        assert!(!printed.contains("refresh"), "{printed}");
        assert_eq!(secret.expose(), "refresh-token-value");
    }
}

//! Stack depth buckets, the one definition (docs/ANALYTICS.md Step 11):
//! `config/stats/stack-buckets.json`. The Hands filter's chips (Stack, the
//! hero's starting stack; Effective stack, [`crate::events::effective_first_action_bb`])
//! and the Analytics Breakdown tab's Stack split read their edges here; the
//! web reads the same file (`packages/ui/hands/stackBuckets.ts`) and SQL a
//! function generated from it (`rail_stack_bucket`).
//!
//! A bucket runs from its `min` (tenths of a big blind, inclusive) to the
//! next one's (exclusive); the last has no end.

use std::sync::LazyLock;

use serde::Deserialize;

/// The shipped buckets.
pub const SHIPPED_STACK_BUCKETS: &str = include_str!("../../../config/stats/stack-buckets.json");

/// Which list of buckets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    /// The Hands filter's chips: `0-40`, `40-80`, `80-120`, `120+`.
    Filter,
    /// The Breakdown tab's Stack split: `0-20` ... `250+`.
    Breakdown,
}

/// One bucket: its id and its edges in tenths of a big blind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackBucket {
    pub id: String,
    /// Inclusive.
    pub min: i64,
    /// Exclusive; `None`: no end.
    pub below: Option<i64>,
}

#[derive(Deserialize)]
struct Raw {
    id: String,
    min: i64,
}

#[derive(Deserialize)]
struct File {
    filter: Vec<Raw>,
    breakdown: Vec<Raw>,
}

fn buckets_of(raw: Vec<Raw>) -> Vec<StackBucket> {
    let mins: Vec<i64> = raw.iter().map(|bucket| bucket.min).collect();
    raw.into_iter()
        .enumerate()
        .map(|(index, bucket)| StackBucket {
            id: bucket.id,
            min: bucket.min,
            below: mins.get(index + 1).copied(),
        })
        .collect()
}

/// Parse a buckets file: both lists non-empty, ids unique, edges rising.
pub fn load(json: &str) -> Result<(Vec<StackBucket>, Vec<StackBucket>), String> {
    let file: File = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let check = |name: &str, list: &[Raw]| -> Result<(), String> {
        if list.is_empty() {
            return Err(format!("{name}: no buckets"));
        }
        for pair in list.windows(2) {
            if pair[1].min <= pair[0].min {
                return Err(format!(
                    "{name}: {} does not start above {}",
                    pair[1].id, pair[0].id
                ));
            }
        }
        for (index, bucket) in list.iter().enumerate() {
            if bucket.id.is_empty() || list[..index].iter().any(|other| other.id == bucket.id) {
                return Err(format!("{name}: bucket id {:?} empty or twice", bucket.id));
            }
        }
        Ok(())
    };
    check("filter", &file.filter)?;
    check("breakdown", &file.breakdown)?;
    Ok((buckets_of(file.filter), buckets_of(file.breakdown)))
}

static SHIPPED: LazyLock<(Vec<StackBucket>, Vec<StackBucket>)> = LazyLock::new(|| {
    load(SHIPPED_STACK_BUCKETS).unwrap_or_else(|error| panic!("stack-buckets.json: {error}"))
});

/// The shipped buckets of `scheme`, lowest first.
pub fn buckets(scheme: Scheme) -> &'static [StackBucket] {
    match scheme {
        Scheme::Filter => &SHIPPED.0,
        Scheme::Breakdown => &SHIPPED.1,
    }
}

/// The bucket of a stack in tenths of a big blind; `None` below the first
/// bucket (a negative stack).
pub fn bucket_of(scheme: Scheme, tenths: i64) -> Option<&'static str> {
    buckets(scheme)
        .iter()
        .find(|bucket| tenths >= bucket.min && bucket.below.is_none_or(|below| tenths < below))
        .map(|bucket| bucket.id.as_str())
}

/// The SQL condition "`column` is in bucket `id`" (`None`: no such bucket):
/// `(column >= min AND column < below)`.
pub fn sql_range(scheme: Scheme, id: &str, column: &str) -> Option<String> {
    let bucket = buckets(scheme).iter().find(|bucket| bucket.id == id)?;
    Some(match bucket.below {
        Some(below) => format!("({column} >= {} AND {column} < {below})", bucket.min),
        None => format!("{column} >= {}", bucket.min),
    })
}

#[cfg(test)]
mod tests {
    use super::{Scheme, bucket_of, buckets, load};

    #[test]
    fn the_shipped_buckets_load() {
        let filter: Vec<&str> = buckets(Scheme::Filter)
            .iter()
            .map(|b| b.id.as_str())
            .collect();
        assert_eq!(filter, ["0-40", "40-80", "80-120", "120+"]);
        assert_eq!(buckets(Scheme::Breakdown).len(), 7);
        assert_eq!(bucket_of(Scheme::Filter, 0), Some("0-40"));
        assert_eq!(bucket_of(Scheme::Filter, 399), Some("0-40"));
        assert_eq!(bucket_of(Scheme::Filter, 400), Some("40-80"));
        assert_eq!(bucket_of(Scheme::Filter, 1199), Some("80-120"));
        assert_eq!(bucket_of(Scheme::Filter, 50_000), Some("120+"));
        assert_eq!(bucket_of(Scheme::Filter, -1), None);
        assert_eq!(bucket_of(Scheme::Breakdown, 1000), Some("100-150"));
    }

    #[test]
    fn a_bad_file_is_refused() {
        assert!(load(r#"{"filter":[],"breakdown":[{"id":"a","min":0}]}"#).is_err());
        assert!(
            load(r#"{"filter":[{"id":"a","min":5},{"id":"b","min":5}],"breakdown":[{"id":"a","min":0}]}"#)
                .is_err()
        );
        assert!(
            load(r#"{"filter":[{"id":"a","min":0},{"id":"a","min":5}],"breakdown":[{"id":"a","min":0}]}"#)
                .is_err()
        );
    }
}
